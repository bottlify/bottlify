/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * dsetup — the DirectX setup library, as the runtime's own setup leaves it in
 * the system directory.
 *
 * A game's autorun asks it which DirectX the machine has before it decides
 * whether to install one: it loads `dsetup.dll` by name, looks up
 * `DirectXSetupGetVersion` and `DirectXSetupA`, and a library that does not
 * load reads as no DirectX at all -- the installer then refuses, or starts a
 * runtime install, whatever the registry says. The version answered is the
 * one the registry and every DirectX file on this machine carry, 9.0c, and
 * setup has nothing to put down: every interface a runtime installs is one
 * the drawing layer already answers for.
 */

import { DIRECTX_VERSION } from '../advapi32/registry.js';
import { decodeAnsi } from '../kernel32/locale.js';
import { parsePe, rvaToFileOffset } from '../../loader/internal/pe.js';
import { findResource } from '../../loader/internal/resources.js';

/** DirectXSetup's answer when everything is in place and no restart is needed. */
export const DSETUPERR_SUCCESS = 0;

const ERROR_INVALID_PARAMETER = 87;
const ERROR_RESOURCE_NAME_NOT_FOUND = 1814;

/**
 * The languages a DirectX 9 redistributable's licence is in, by the language
 * id it is asked for -- dsetup32's own table, the two Chinese by their full
 * id and the rest by their primary language -- each its resource's suffix.
 */
const LICENCE_LANGUAGES = new Map([
    [0x804, 'CHS'], [0x404, 'CHT'], [0x05, 'CZE'], [0x13, 'DUT'], [0x09, 'ENG'],
    [0x0c, 'FRN'], [0x07, 'GER'], [0x10, 'ITN'], [0x11, 'JPN'], [0x12, 'KOR'],
    [0x15, 'POL'], [0x16, 'BRZ'], [0x19, 'RUS'], [0x0a, 'SPA'], [0x1d, 'SWE'],
]);

/**
 * The licence text a redistributable's dsetup32.dll carries, as its bytes
 * (`DATA`, `SETUP_AGREEMENT_<language>`), or null when it has none for the
 * language. Language 0 is the system's, English.
 *
 * @param {Uint8Array} library @param {number} language
 * @returns {Uint8Array | null}
 */
export function licenceIn(library, language){
    const suffix = language === 0 ? 'ENG'
        : LICENCE_LANGUAGES.get(language) ?? LICENCE_LANGUAGES.get(language & 0x3ff);
    if (!suffix)
    {
        return null;
    }
    try
    {
        const image = parsePe(library);
        const found = findResource(library, image, 'DATA', `SETUP_AGREEMENT_${suffix}`);
        const at = found ? rvaToFileOffset(image, found.rva) : -1;
        return found && at >= 0 ? library.subarray(at, at + found.size) : null;
    }
    catch {
        return null;
    }
}

/**
 * The version as DirectXSetupGetVersion hands it out: the major and minor
 * numbers in one DWORD, high word first, and the release and build in the
 * other, each the decimal number the dotted form spells, as a file version's
 * words are -- `4.09.00.0904` is 0x00040009 and 0x00000388.
 */
export const versionWords = (version = DIRECTX_VERSION)=>{
    const [major, minor, release, build] = version.split('.').map(Number);
    return { version: (major << 16 | minor) >>> 0, revision: (release << 16 | build) >>> 0 };
};

/** The default release's words. */
export const DIRECTX_VERSION_WORDS = versionWords();

/**
 * @typedef {Object} DsetupHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {string} [directx]  The version the bottle reports; absent, 9.0c.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(code: number) => void} [setLastError]
 * @property {() => string | null} [brought]
 *     Where the program found the dsetup.dll this table is loaded in place of:
 *     its redistributable's dsetup32.dll, beside it, holds the licence.
 * @property {(path: string) => Promise<Uint8Array | null>} [readFile]
 */

/** @param {number} value */
const dword = value=>Uint8Array.of(value & 0xff, value >>> 8 & 0xff,
    value >>> 16 & 0xff, value >>> 24 & 0xff);

/**
 * @param {DsetupHost} host
 */
export function createDsetupFunctions(host){
    const words = versionWords(host.directx);
    const unlisted = ()=>{
        host.divergence?.('DirectXRegisterApplication',
            'there is no DirectPlay lobby list to change');
        return 1;
    };
    /**
     * INT DirectXSetupA(HWND hWnd, LPSTR lpszRootPath, DWORD dwFlags)
     * INT DirectXSetupW(HWND hWnd, LPWSTR lpszRootPath, DWORD dwFlags)
     *
     * Installs the runtime from the redistributable at the path. What it would
     * copy is no newer than what is here, so it copies nothing and says the
     * install succeeded without a restart, which is what a caller that
     * installs whenever it is unsure goes on from.
     */
    const setup = {
        argBytes: 12,
        handler: ()=>DSETUPERR_SUCCESS,
    };

    /** @param {number} code */
    const fail = code=>{
        host.setLastError?.(code);
        return 0;
    };

    /**
     * UINT DirectXSetupGetEULAA(LPSTR lpszEULA, UINT cchEULA, WORD LangID)
     * UINT DirectXSetupGetEULAW(LPWSTR lpszEULA, UINT cchEULA, WORD LangID)
     *
     * The licence of the redistributable the program brought, which a game's
     * autorun shows in a window of its own before it installs. Asked with no
     * room, the characters it needs, its terminator counted; with room, the
     * text and that count; with too little, 0 and ERROR_INVALID_PARAMETER --
     * dsetup32's own answers. The text is the copy's: this table only stands
     * in for the library that would have read it.
     *
     * @param {boolean} wide
     */
    const licence = wide=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: async([buffer, room, language])=>{
            const to = buffer >>> 0;
            const capacity = room >>> 0;
            if (to !== 0 && capacity !== 0)
            {
                host.writeMemory(to, new Uint8Array(wide ? 2 : 1));
            }
            const copy = host.brought?.() ?? null;
            const library = copy === null ? null
                : await host.readFile?.(copy.replace(/[^\\/]*$/, 'dsetup32.dll')) ?? null;
            const bytes = library && licenceIn(library, language & 0xffff);
            if (!bytes)
            {
                return fail(ERROR_RESOURCE_NAME_NOT_FOUND);
            }
            const text = wide ? decodeAnsi(bytes) : '';
            const needed = (wide ? text.length : bytes.length) + 1;
            if (capacity === 0)
            {
                return needed;
            }
            if (capacity < needed || to === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const out = new Uint8Array(wide ? needed * 2 : needed);
            if (wide)
            {
                const view = new DataView(out.buffer);
                for (let at = 0; at < text.length; at++)
                {
                    view.setUint16(at * 2, text.charCodeAt(at), true);
                }
            }
            else
            {
                out.set(bytes);
            }
            host.writeMemory(to, out);
            return needed;
        },
    });

    return {
        /**
         * INT DirectXSetupGetVersion(DWORD *pdwVersion, DWORD *pdwMinorVersion)
         *
         * TRUE, with the installed version in whichever of the two the caller
         * passed; either may be NULL when that half is not wanted.
         */
        DirectXSetupGetVersion: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([version, revision])=>{
                if ((version >>> 0) !== 0)
                {
                    host.writeMemory(version >>> 0, dword(words.version));
                }
                if ((revision >>> 0) !== 0)
                {
                    host.writeMemory(revision >>> 0, dword(words.revision));
                }
                return 1;
            },
        },

        DirectXSetupA: setup,
        DirectXSetupW: setup,
        DirectXSetupGetEULAA: licence(false),
        DirectXSetupGetEULAW: licence(true),

        // The rest of what a program that brought its own copy may look up:
        // this one is loaded in its place, and an export it lacks would be a
        // failure the copy never had.

        /** INT DirectXSetupSetCallback(DSETUP_CALLBACK Callback): nothing installs, so nothing reports. */
        DirectXSetupSetCallback: { argBytes: 4, handler: ()=>0 },
        /** BOOL DirectXSetupIsJapan(void) */
        DirectXSetupIsJapan: { argBytes: 0, handler: ()=>0 },
        /** BOOL DirectXSetupIsJapanNec(void) */
        DirectXSetupIsJapanNec: { argBytes: 0, handler: ()=>0 },
        /**
         * INT DirectXDeviceDriverSetupA(HWND, LPSTR driverClass, LPSTR driverPath, LPDWORD version)
         *
         * A display or sound driver from the redistributable: the devices here
         * are the engine's, so there is none to put down.
         */
        DirectXDeviceDriverSetupA: { argBytes: 16, handler: ()=>DSETUPERR_SUCCESS },
        DirectXDeviceDriverSetupW: { argBytes: 16, handler: ()=>DSETUPERR_SUCCESS },
        /**
         * BOOL DirectXRegisterApplicationA(HWND, LPDIRECTXREGISTERAPPA)
         * BOOL DirectXUnRegisterApplication(HWND, LPGUID)
         *
         * A game's entry in the DirectPlay lobby's list, which nothing here
         * reads: answered as done, and said.
         */
        DirectXRegisterApplicationA: { argBytes: 8, handler: ()=>unlisted() },
        DirectXRegisterApplicationW: { argBytes: 8, handler: ()=>unlisted() },
        DirectXUnRegisterApplication: { argBytes: 8, handler: ()=>unlisted() },
    };
}
