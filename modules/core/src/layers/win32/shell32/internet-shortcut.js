/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, Version 2.0
 * See LICENSE for details
 */

/**
 * CLSID_InternetShortcut: IUniformResourceLocatorA, IUniformResourceLocatorW
 * and IPersistFile over one address.
 *
 * A setup that puts a link to its publisher's site in the Start Menu asks COM
 * for this class, sets the address and saves it through IPersistFile, the way
 * it saves a shell link. The file is the `.url` the shell reads: an INI file
 * whose `[InternetShortcut]` section holds the address as `URL=`. Load reads
 * the same key back, so a shortcut saved here, one a setup wrote as text and
 * one on a disc all answer GetURL alike.
 *
 * The interfaces are the ones intshcut.h declares, in its slot order: SetURL,
 * GetURL, InvokeCommand after IUnknown's three.
 */

import { writeGuid } from '../ole32/guid.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';

export const CLSID_INTERNET_SHORTCUT = '{FBF23B40-E3F0-101B-8488-00AA003E56F8}';
export const IID_IURL_A = '{FBF23B80-E3F0-101B-8488-00AA003E56F8}';
export const IID_IURL_W = '{CABB0DA0-DA57-11CF-9974-0020AFD79762}';
export const IID_IPERSIST_FILE = '{0000010B-0000-0000-C000-000000000046}';

const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const STG_E_FILENOTFOUND = 0x80030002 | 0;
/** HRESULT_FROM_WIN32(ERROR_PATH_NOT_FOUND): a save into a directory that is not there. */
const E_PATH_NOT_FOUND = 0x80070003 | 0;
/** intshcut.h: an address that names no protocol, with no leave to guess one. */
export const URL_E_INVALID_SYNTAX = 0x80041001 | 0;

/** SetURL's flags: guess a protocol, or take the default one, for an address with none. */
const IURL_SETURL_FL_GUESS_PROTOCOL = 0x1;
const IURL_SETURL_FL_USE_DEFAULT_PROTOCOL = 0x2;

/** How far an address or a path is scanned. */
const MAX_STRING = 2048;

/** A scheme as RFC 3986 spells one, then its colon. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** IUniformResourceLocator's slots after IUnknown's three. @type {[string, number][]} */
const IURL_SLOTS = [['SetURL', 2], ['GetURL', 1], ['InvokeCommand', 1]];

/** IPersistFile's slots after IUnknown's three; GetClassID is IPersist's. @type {[string, number][]} */
const IPERSIST_FILE_SLOTS = [
    ['GetClassID', 1], ['IsDirty', 0], ['Load', 2], ['Save', 2], ['SaveCompleted', 1],
    ['GetCurFile', 1],
];

/**
 * @typedef {Object} ShortcutState
 * @property {string | null} url    Null until one is set or loaded.
 * @property {string | null} curFile  The path Save or Load last named.
 * @property {boolean} dirty
 */

/**
 * @typedef {Object} InternetShortcutHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 * @property {(bytes: number) => number} allocate
 *           Task memory: a string GetURL and GetCurFile hand back is the
 *           caller's to free with CoTaskMemFree.
 * @property {{ stat: (path: string) => any,
 *     open: (path: string, mode: object) => any,
 *     read: (node: any, offset: number, length: number) => Uint8Array | Promise<Uint8Array>,
 *     write: (node: any, offset: number, bytes: Uint8Array) => unknown,
 *     close: (node: any) => void }} [files]
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** @typedef {(state: ShortcutState, args: number[]) => number | Promise<number>} Method */

/** @param {number} value */
const dword = value=>new Uint8Array([
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
]);

/** @param {string} text */
const utf16 = text=>{
    const bytes = new Uint8Array((text.length + 1) * 2);
    for (let at = 0; at < text.length; at++)
    {
        bytes[at * 2] = text.charCodeAt(at) & 0xff;
        bytes[at * 2 + 1] = text.charCodeAt(at) >>> 8;
    }
    return bytes;
};

/**
 * The address a `.url` file holds: `URL=` in its `[InternetShortcut]`
 * section, names and keys without regard to case, as the profile calls read
 * them. Null when the file holds none.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function urlOfShortcut(text){
    let inSection = false;
    for (const raw of text.split(/\r\n|\r|\n/))
    {
        const line = raw.trim();
        const heading = /^\[(.*)\]$/.exec(line);
        if (heading)
        {
            inSection = heading[1].trim().toLowerCase() === 'internetshortcut';
            continue;
        }
        const pair = /^([^=]*)=(.*)$/.exec(line);
        if (inSection && pair && pair[1].trim().toLowerCase() === 'url')
        {
            return pair[2].trim();
        }
    }
    return null;
}

/**
 * The text of a `.url` file for an address.
 *
 * @param {string} url
 */
export const shortcutText = url=>`[InternetShortcut]\r\nURL=${url}\r\n`;

/**
 * The internet shortcut class, ready to be registered.
 *
 * @param {InternetShortcutHost} host
 * @returns {() => import('../ole32/objects.js').ComClassDefinition}
 */
export function createInternetShortcut(host){
    /**
     * A string in task memory, its pointer written to `slot`; S_FALSE and a
     * null for none.
     *
     * @param {number} slot @param {string | null} text @param {boolean} wide
     */
    const handBack = (slot, text, wide)=>{
        if (slot === 0)
        {
            return E_INVALIDARG;
        }
        if (text === null)
        {
            host.writeMemory(slot, dword(0));
            return S_FALSE;
        }
        const bytes = wide ? utf16(text) : encodeAnsi(`${text}\0`);
        const block = host.allocate(bytes.length);
        if (block === 0)
        {
            host.writeMemory(slot, dword(0));
            return E_OUTOFMEMORY;
        }
        host.writeMemory(block, bytes);
        host.writeMemory(slot, dword(block));
        return S_OK;
    };

    /** @param {boolean} wide @returns {Record<string, Method>} */
    const locator = wide=>({
        /**
         * HRESULT SetURL(LPCTSTR pcszURL, DWORD dwInFlags)
         *
         * An address with no protocol is refused unless the caller lets one be
         * supplied; the default, and the guess for a bare host name, is http.
         */
        SetURL: (state, [address, flags])=>{
            if ((address >>> 0) === 0)
            {
                state.url = null;
                state.dirty = true;
                return S_OK;
            }
            const given = (wide ? host.readWideString : host.readCString)(address >>> 0,
                MAX_STRING).trim();
            if (!SCHEME.test(given))
            {
                if (((flags >>> 0) & (IURL_SETURL_FL_GUESS_PROTOCOL
                    | IURL_SETURL_FL_USE_DEFAULT_PROTOCOL)) === 0)
                {
                    return URL_E_INVALID_SYNTAX;
                }
                state.url = `http://${given}`;
            }
            else
            {
                state.url = given;
            }
            state.dirty = true;
            return S_OK;
        },
        /** HRESULT GetURL(LPTSTR *ppszURL) */
        GetURL: (state, [out])=>handBack(out >>> 0, state.url, wide),
        /**
         * HRESULT InvokeCommand(PURLINVOKECOMMANDINFO purlici)
         *
         * Opening the address is the browser's, which this machine does not
         * have to hand it to.
         */
        InvokeCommand: state=>{
            host.divergence?.('IUniformResourceLocator::InvokeCommand',
                `${state.url ?? '(no address)'} is not opened: there is no browser to open it in`);
            return E_FAIL;
        },
    });

    /** @type {Record<string, Method>} */
    const persistFile = {
        GetClassID: (state, [out])=>{
            void state;
            return writeGuid(host, out >>> 0, CLSID_INTERNET_SHORTCUT) ? S_OK : E_FAIL;
        },
        IsDirty: state=>(state.dirty ? S_OK : S_FALSE),
        /** HRESULT Load(LPCOLESTR pszFileName, DWORD dwMode) */
        Load: (state, [name])=>{
            const path = host.readWideString(name >>> 0, MAX_STRING);
            const files = host.files;
            const entry = files?.stat(path);
            if (!files || !entry || entry.exists === false || entry.isDirectory)
            {
                return STG_E_FILENOTFOUND;
            }
            const node = files.open(path, { read: true });
            if (!node)
            {
                return STG_E_FILENOTFOUND;
            }
            /** @param {Uint8Array} bytes */
            const finish = bytes=>{
                state.url = urlOfShortcut(decodeAnsi(bytes));
                state.curFile = path;
                state.dirty = false;
                return S_OK;
            };
            let read;
            try
            {
                read = files.read(node, 0, entry.size ?? 0);
            }
            catch (e){
                files.close(node);
                throw e;
            }
            if (read instanceof Uint8Array)
            {
                files.close(node);
                return finish(read);
            }
            return read.then(finish).finally(()=>files.close(node));
        },
        /**
         * HRESULT Save(LPCOLESTR pszFileName, BOOL fRemember)
         *
         * Writes the file at the path, or at the current file for a null one.
         */
        Save: (state, [name, remember])=>{
            const given = (name >>> 0) === 0 ? null : host.readWideString(name >>> 0, MAX_STRING);
            const path = given ?? state.curFile;
            if (path === null)
            {
                return E_INVALIDARG;
            }
            const files = host.files;
            if (!files)
            {
                host.divergence?.('IPersistFile::Save',
                    `no volume to save ${path} on; the shortcut is not written`);
                return E_FAIL;
            }
            const parent = path.slice(0, path.lastIndexOf('\\'));
            if (parent !== '' && !files.stat(parent)?.isDirectory)
            {
                return E_PATH_NOT_FOUND;
            }
            const node = files.open(path, { write: true, create: true, truncate: true });
            if (!node)
            {
                return E_FAIL;
            }
            try
            {
                files.write(node, 0, encodeAnsi(shortcutText(state.url ?? '')));
            }
            finally
            {
                files.close(node);
            }
            if (given === null || (remember | 0) !== 0)
            {
                state.curFile = path;
                state.dirty = false;
            }
            return S_OK;
        },
        SaveCompleted: (state, [name])=>{
            state.curFile = (name >>> 0) === 0 ? null : host.readWideString(name >>> 0, MAX_STRING);
            state.dirty = false;
            return S_OK;
        },
        GetCurFile: (state, [out])=>handBack(out >>> 0, state.curFile, true),
    };

    /**
     * @param {string} id @param {[string, number][]} slots @param {Record<string, Method>} methods
     * @returns {import('../ole32/objects.js').ComInterfaceDescriptor}
     */
    const describe = (id, slots, methods)=>({
        id,
        methods: slots.map(([name, dwords])=>({
            name,
            argBytes: 4 + dwords * 4,
            invoke: (/** @type {any} */ object, /** @type {number[]} */ args)=>
                methods[name](object.state, args),
        })),
    });

    return ()=>({
        state: /** @type {ShortcutState} */ ({ url: null, curFile: null, dirty: false }),
        interfaces: [
            describe(IID_IURL_A, IURL_SLOTS, locator(false)),
            describe(IID_IURL_W, IURL_SLOTS, locator(true)),
            describe(IID_IPERSIST_FILE, IPERSIST_FILE_SLOTS, persistFile),
        ],
    });
}

/**
 * Puts the internet shortcut class where CoCreateInstance will find it.
 *
 * @param {import('../ole32/objects.js').ComRegistry} registry
 * @param {InternetShortcutHost} host
 */
export function registerInternetShortcutClass(registry, host){
    registry.registerClass(CLSID_INTERNET_SHORTCUT, createInternetShortcut(host));
}
