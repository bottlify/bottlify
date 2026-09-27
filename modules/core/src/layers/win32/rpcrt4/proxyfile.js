/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a MIDL proxy/stub DLL says about itself: the ProxyFileInfo list its
 * dlldata.c hands to every rpcrt4 entry point, and the registry keys that
 * list becomes.
 *
 * The list is data in the DLL, NULL-terminated, one ProxyFileInfo per IDL
 * file:
 *
 *     +0   pProxyVtblList   one CInterfaceProxyVtbl per interface
 *     +4   pStubVtblList    one CInterfaceStubVtbl per interface
 *     +8   pNamesArray      the interfaces' names
 *     +12  pDelegatedIIDs   base interfaces a stub forwards to, or NULL
 *     +16  pIIDLookupRtn
 *     +20  TableSize        (WORD) how many interfaces
 *     +22  TableVersion     (WORD) 2 and up: stubless proxy headers
 *
 * A CInterfaceStubVtbl is its header -- the IID, the server info, the
 * dispatch table's length and the dispatch table -- and then the DLL's
 * IRpcStubBuffer vtable. A CInterfaceProxyVtbl is its header -- the IID,
 * after the stubless proxy info from TableVersion 2 on -- and then the vtable
 * a proxy of the interface points at, which is the DLL's own code.
 */

import { formatGuid } from '../ole32/guid.js';
import { HKEY_CLASSES_ROOT } from '../advapi32/registry.js';
import { encodeAnsi } from '../kernel32/locale.js';

/** CInterfaceStubVtbl: its header, then the IRpcStubBuffer vtable. */
export const STUB_VTBL = Object.freeze({
    IID: 0,
    SERVER_INFO: 4,
    DISPATCH_TABLE_COUNT: 8,
    DISPATCH_TABLE: 12,
    VTABLE: 16,
});

/** The most files and interfaces a list is read to, so damage cannot loop. */
const MOST_FILES = 256;
const MOST_INTERFACES = 4096;

/** The registry's string type. */
const REG_SZ = 1;

/**
 * @typedef {Object} ProxiedInterface
 * @property {string} iid       Canonical.
 * @property {number} iidAt     Where the DLL keeps it.
 * @property {string} name
 * @property {number} methods   Every method of the vtable, IUnknown's three included.
 * @property {number} proxyVtbl The vtable a proxy of it points at.
 * @property {number} stubVtbl  Its CInterfaceStubVtbl.
 * @property {number} tableVersion
 * @property {number} delegated Where the IID of the base it delegates to is, or 0.
 */

/**
 * @typedef {Object} ProxyFileMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 */

/**
 * Every interface a ProxyFileInfo list describes, in its order.
 *
 * @param {ProxyFileMemory} memory
 * @param {number} list  The ProxyFileInfo ** a dlldata.c passes.
 * @returns {ProxiedInterface[]}
 */
export function readProxyFiles(memory, list){
    /** @param {number} at */
    const u32 = at=>{
        const bytes = memory.readMemory(at >>> 0, 4);
        return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    };
    /** @param {number} at */
    const u16 = at=>{
        const bytes = memory.readMemory(at >>> 0, 2);
        return bytes[0] | (bytes[1] << 8);
    };
    /** @param {number} at */
    const cString = at=>{
        let text = '';
        for (let cursor = at; cursor !== 0 && text.length < 256; cursor++)
        {
            const byte = memory.readMemory(cursor, 1)[0];
            if (byte === 0)
            {
                break;
            }
            text += String.fromCharCode(byte);
        }
        return text;
    };

    /** @type {ProxiedInterface[]} */
    const found = [];
    for (let index = 0; index < MOST_FILES; index++)
    {
        const file = list === 0 ? 0 : u32(list + index * 4);
        if (file === 0)
        {
            break;
        }
        const proxies = u32(file);
        const stubs = u32(file + 4);
        const names = u32(file + 8);
        const delegated = u32(file + 12);
        const size = u16(file + 20);
        const tableVersion = u16(file + 22);
        for (let entry = 0; entry < size && found.length < MOST_INTERFACES; entry++)
        {
            const stubVtbl = u32(stubs + entry * 4);
            const iidAt = u32(stubVtbl + STUB_VTBL.IID);
            found.push({
                iid: formatGuid(memory.readMemory(iidAt, 16)),
                iidAt,
                name: names === 0 ? '' : cString(u32(names + entry * 4)),
                methods: u32(stubVtbl + STUB_VTBL.DISPATCH_TABLE_COUNT),
                // The stubless proxy info, then the IID, then the vtable.
                proxyVtbl: u32(proxies + entry * 4) + (tableVersion > 1 ? 8 : 4),
                stubVtbl,
                tableVersion,
                delegated: delegated === 0 ? 0 : u32(delegated + entry * 4),
            });
        }
    }
    return found;
}

/**
 * The class a proxy DLL's factory answers to: the one it names, or else its
 * first interface's IID, which is what MIDL's dlldata.c registers when it is
 * built without a PROXY_CLSID.
 *
 * @param {ProxyFileMemory} memory @param {ProxiedInterface[]} interfaces
 * @param {number} pclsid
 */
export function factoryClass(memory, interfaces, pclsid){
    if (pclsid !== 0)
    {
        return formatGuid(memory.readMemory(pclsid, 16));
    }
    return interfaces[0]?.iid ?? null;
}

/**
 * @typedef {Object} ProxyHive
 * @property {(id: number) => any} root
 * @property {(key: any, path: string) => { key: any }} create
 * @property {(key: any, name: string, type: number, data: Uint8Array) => void} setValue
 * @property {(key: any, path: string) => any} open
 * @property {(key: any, path: string) => string} remove
 * @property {(key: any) => string[]} [subkeys]
 */

/** @param {string} text */
const ansi = text=>encodeAnsi(`${text}\0`);

/**
 * NdrDllRegisterProxy's keys: every interface under Interface, sent to the
 * factory's class, and the class under CLSID, served in process by the DLL.
 *
 * @param {ProxyHive} hive @param {ProxiedInterface[]} interfaces
 * @param {string} clsid @param {string} path  The DLL's own file.
 */
export function registerProxyFiles(hive, interfaces, clsid, path){
    const root = hive.root(HKEY_CLASSES_ROOT);
    for (const entry of interfaces)
    {
        const key = hive.create(root, `Interface\\${entry.iid}`).key;
        hive.setValue(key, '', REG_SZ, ansi(entry.name));
        hive.setValue(hive.create(key, 'NumMethods').key, '', REG_SZ, ansi(String(entry.methods)));
        hive.setValue(hive.create(key, 'ProxyStubClsid32').key, '', REG_SZ, ansi(clsid));
    }
    const key = hive.create(root, `CLSID\\${clsid}`).key;
    hive.setValue(key, '', REG_SZ, ansi('PSFactoryBuffer'));
    const server = hive.create(key, 'InprocServer32').key;
    hive.setValue(server, '', REG_SZ, ansi(path));
    hive.setValue(server, 'ThreadingModel', REG_SZ, ansi('Both'));
}

/**
 * NdrDllUnregisterProxy's: the same keys, gone. A key is removed only once it
 * has no subkeys, so each goes after what it holds.
 *
 * @param {ProxyHive} hive @param {ProxiedInterface[]} interfaces @param {string} clsid
 */
export function unregisterProxyFiles(hive, interfaces, clsid){
    const root = hive.root(HKEY_CLASSES_ROOT);
    /** @param {string} path */
    const removeTree = path=>{
        const key = hive.open(root, path);
        if (!key)
        {
            return;
        }
        for (const child of hive.subkeys?.(key) ?? [])
        {
            removeTree(`${path}\\${child}`);
        }
        hive.remove(root, path);
    };
    for (const entry of interfaces)
    {
        removeTree(`Interface\\${entry.iid}`);
    }
    removeTree(`CLSID\\${clsid}`);
}
