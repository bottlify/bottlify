/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * advpack — the Advanced INF installer's helper library.
 *
 * An installer loads it at run time and asks it questions before it installs
 * anything, the first of them whether the account may write where it is about
 * to: a library that is missing is taken for an account without the right.
 *
 * A library registers itself through it too: RegInstall reads the INF the
 * library carries as its REGINST resource and carries out a section of it --
 * the keys a COM server's DllRegisterServer would otherwise write by hand.
 */

import { infText, parseInf } from '../setupapi/inf.js';
import { standardDirids } from '../setupapi/dirids.js';
import { installRegistry } from '../setupapi/registry.js';

const S_OK = 0;
const E_FAIL = 0x80004005;

/** The directives of an Advanced INF section that only describe it. */
const DESCRIPTIVE = new Set(['componentname', 'componentversion', 'advoptions']);
/** The ones carried out here. */
const CARRIED_OUT = new Set(['addreg', 'delreg']);

/**
 * @typedef {Object} AdvpackHost
 * @property {() => boolean} isAdministrator
 *           Whether the account's token holds BUILTIN\Administrators: the
 *           answer the token calls give, so the two cannot disagree.
 * @property {ReturnType<typeof import('../advapi32/registry.js').createHive>} [hive]
 * @property {Readonly<Record<string, string>>} [folders]  The shell's folders, for DIRIDs.
 * @property {(instance: number, type: string | number, name: string | number)
 *     => { rva: number, size: number } | null} [findResource]
 * @property {(instance: number) => number} [moduleBase]
 * @property {(module: number) => string | null} [modulePath]  As GetModuleFileName answers.
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(address: number, maxLength: number) => string} [readCString]
 * @property {(address: number, maxLength: number) => string} [readWideString]
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** The longest text a string table entry is read to. */
const MAX_ENTRY = 0x1000;

/**
 * @param {AdvpackHost} host
 */
export function createAdvpackFunctions(host){
    /**
     * The strings RegInstall defines before the library's own: the module's
     * path, the same with the Windows directory written as %SystemRoot% --
     * what a REG_EXPAND_SZ server path is made of -- and SystemRoot itself.
     *
     * @param {string} path @param {string} systemRoot
     * @returns {[string, string][]}
     */
    const predefined = (path, systemRoot)=>{
        const under = systemRoot !== ''
            && path.toLowerCase().startsWith(`${systemRoot.toLowerCase()}\\`);
        return [
            ['_MOD_PATH', path],
            ['_SYS_MOD_PATH', under ? `%SystemRoot%${path.slice(systemRoot.length)}` : path],
            ['SystemRoot', systemRoot],
        ];
    };

    /**
     * STRTABLE's entries, in the caller's width: a count, then the address of
     * that many name and value pointer pairs.
     *
     * @param {number} table @param {boolean} wide
     * @returns {[string, string][]}
     */
    const tableEntries = (table, wide)=>{
        if ((table >>> 0) === 0 || !host.readMemory)
        {
            return [];
        }
        const head = new DataView(host.readMemory(table >>> 0, 8).slice().buffer);
        const count = head.getUint32(0, true);
        const entries = head.getUint32(4, true);
        const read = (/** @type {number} */ pointer)=>((pointer >>> 0) === 0 ? ''
            : wide ? host.readWideString?.(pointer >>> 0, MAX_ENTRY * 2) ?? ''
                : host.readCString?.(pointer >>> 0, MAX_ENTRY) ?? '');
        /** @type {[string, string][]} */
        const found = [];
        if (entries === 0)
        {
            return found;
        }
        for (let index = 0; index < Math.min(count, 0x10000); index++)
        {
            const pair = new DataView(host.readMemory(entries + index * 8, 8).slice().buffer);
            found.push([read(pair.getUint32(0, true)), read(pair.getUint32(4, true))]);
        }
        return found;
    };

    /**
     * HRESULT RegInstall(HMODULE hm, LPCSTR pszSection, const STRTABLE *pstTable),
     * in either width.
     *
     * @param {number} module @param {string} sectionName @param {[string, string][]} table
     */
    const regInstall = (module, sectionName, table)=>{
        const say = (/** @type {string} */ detail)=>host.divergence?.('RegInstall', detail);
        const found = host.findResource?.(module >>> 0, 'REGINST', 'REGINST') ?? null;
        const base = host.moduleBase?.(module >>> 0) ?? 0;
        if (!found || base === 0 || !host.readMemory || !host.hive)
        {
            say('the module carries no REGINST resource');
            return E_FAIL;
        }
        const path = host.modulePath?.(module >>> 0) ?? '';
        const systemRoot = host.folders?.Windows ?? '';
        const parsed = parseInf(infText(host.readMemory(base + found.rva, found.size).slice()), {
            dirid: host.folders ? standardDirids(host.folders) : undefined,
            // The library's own entries are written last, over the predefined.
            strings: new Map([...predefined(path, systemRoot), ...table]),
        });
        if (!('inf' in parsed))
        {
            say(`the module's REGINST INF does not read: error 0x${
                (parsed.error >>> 0).toString(16)} at line ${parsed.line}`);
            return E_FAIL;
        }
        const section = parsed.inf.section(sectionName);
        if (!section)
        {
            say(`the module's INF has no section [${sectionName}]`);
            return E_FAIL;
        }
        for (const line of section.lines)
        {
            const directive = line.key?.toLowerCase() ?? '';
            if (directive !== '' && !CARRIED_OUT.has(directive) && !DESCRIPTIVE.has(directive))
            {
                say(`the ${line.key} directive of [${sectionName}] is not carried out`);
            }
        }
        installRegistry(host.hive, parsed.inf, section, {
            divergence: detail=>say(`[${sectionName}] ${detail}`),
        });
        return S_OK;
    };

    /** @param {number} pointer @param {boolean} wide */
    const sectionAt = (pointer, wide)=>((pointer >>> 0) === 0 ? ''
        : wide ? host.readWideString?.(pointer >>> 0, MAX_ENTRY * 2) ?? ''
            : host.readCString?.(pointer >>> 0, MAX_ENTRY) ?? '');

    /** @type {{ argBytes: number, handler: (args: number[]) => number }} */
    const regInstallA = {
        argBytes: 12,
        handler: ([module, section, table])=>
            regInstall(module, sectionAt(section, false), tableEntries(table, false)),
    };

    return {
        /** BOOL IsNTAdmin(DWORD dwReserved, LPDWORD lpdwReserved) */
        IsNTAdmin: {
            argBytes: 8,
            handler: ()=>(host.isAdministrator() ? 1 : 0),
        },

        /**
         * HRESULT RegInstall(HMODULE hm, LPCSTR pszSection, const STRTABLEA *pstTable)
         *
         * The section of the module's REGINST INF carried out, its DelReg and
         * then its AddReg sections, with the strings the table gives over the
         * INF's own and _MOD_PATH, _SYS_MOD_PATH and SystemRoot defined. The
         * export's older name is the ANSI one.
         */
        RegInstall: regInstallA,
        RegInstallA: regInstallA,

        /** HRESULT RegInstallW(HMODULE hm, LPCWSTR pszSection, const STRTABLEW *pstTable) */
        RegInstallW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([module, section, table])=>
                regInstall(module, sectionAt(section, true), tableEntries(table, true)),
        },
    };
}
