/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, Version 2.0
 * See LICENSE for details
 */

/**
 * CLSID_ShellLink: the smallest object that lets an installer finish.
 *
 * An installer makes a Start Menu shortcut by asking COM for this class,
 * setting a target through IShellLink, and saving it through IPersistFile. A
 * build that refuses the class turns every shortcut into "Access is denied"
 * and ends the install in a warning dialog, so the class has to exist and the
 * save has to leave something a later "is the link there" check finds.
 *
 * What it does not do is write a real `.lnk`. A shortcut nobody can see -- the
 * guest's Start Menu is never drawn, and the launcher starts the game's
 * executable directly -- has no contents to get right. So `Save` creates an
 * empty file at the path, which is enough for the existence check to pass, and
 * every method whose answer stands in for work this build does not do says so
 * through the divergence reporter rather than pretending silently. The strings
 * a program sets are kept and handed back verbatim, because a program that
 * reads back what it wrote is the one thing here that must not be surprised.
 */

import { writeGuid } from '../ole32/guid.js';

/** CLSID_ShellLink, and the interfaces the object answers to. */
export const CLSID_SHELL_LINK = '{00021401-0000-0000-C000-000000000046}';
export const IID_ISHELL_LINK_A = '{000214EE-0000-0000-C000-000000000046}';
export const IID_ISHELL_LINK_W = '{000214F9-0000-0000-C000-000000000046}';
export const IID_IPERSIST_FILE = '{0000010B-0000-0000-C000-000000000046}';

const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const E_FAIL = 0x80004005 | 0;
const STG_E_FILENOTFOUND = 0x80030002 | 0;

/** SW_SHOWNORMAL: what a link nobody set a show command answers with. */
const SW_SHOWNORMAL = 1;

/**
 * How far a link string is scanned. Paths top out at MAX_PATH, but arguments
 * and a description are not paths and can be longer; this bounds a runaway
 * scan without truncating anything an installer plausibly writes.
 */
const MAX_LINK_STRING = 2048;

/** WIN32_FIND_DATA: cFileName sits at this offset in both the A and W forms. */
const FIND_DATA_NAME = 44;
const FIND_DATA_A_SIZE = 318;
const FIND_DATA_W_SIZE = 592;

/** IShellLink's slots after IUnknown's three, as `[name, dwords]`. @type {[string, number][]} */
const ISHELL_LINK_SLOTS = [
    ['GetPath', 4],
    ['SetPath', 1],
    ['GetArguments', 2],
    ['SetArguments', 1],
    ['GetDescription', 2],
    ['SetDescription', 1],
    ['GetWorkingDirectory', 2],
    ['SetWorkingDirectory', 1],
    ['GetRelativePath', 3],
    ['GetIconLocation', 3],
    ['SetIconLocation', 2],
    ['SetShowCmd', 1],
    ['GetShowCmd', 1],
    ['SetHotkey', 1],
    ['GetHotkey', 1],
    ['SetIDList', 1],
    ['GetIDList', 1],
    ['Resolve', 2],
];

/** IPersistFile's slots after IUnknown's three; GetClassID is IPersist's. @type {[string, number][]} */
const IPERSIST_FILE_SLOTS = [
    ['GetClassID', 1],
    ['IsDirty', 0],
    ['Load', 2],
    ['Save', 2],
    ['SaveCompleted', 1],
    ['GetCurFile', 1],
];

/**
 * @typedef {Object} ShellLinkState
 * @property {string} path
 * @property {string} arguments
 * @property {string} description
 * @property {string} workingDirectory
 * @property {string} iconLocation
 * @property {number} iconIndex
 * @property {number} showCmd
 * @property {number} hotkey
 * @property {string | null} curFile  The path Save or Load last named.
 * @property {boolean} dirty          Whether a Set* ran since the last save.
 */

/** @returns {ShellLinkState} */
function newLinkState(){
    return {
        path: '', arguments: '', description: '', workingDirectory: '',
        iconLocation: '', iconIndex: 0, showCmd: SW_SHOWNORMAL, hotkey: 0,
        curFile: null, dirty: false,
    };
}

/** The string-valued fields a Set/Get pair keeps and returns.
 * @typedef {'path' | 'arguments' | 'description' | 'workingDirectory'
 *          | 'iconLocation'} StringKey
 */

/**
 * A shell link method as the bridge calls it: the object's state, and the
 * guest arguments with the interface pointer already removed.
 *
 * @typedef {(state: ShellLinkState, args: number[]) => number} LinkMethod
 */

/**
 * @typedef {Object} ShellLinkHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 *           The ANSI half: how an IShellLinkA string arrives.
 * @property {(address: number, maxLength: number) => string} readWideString
 *           The wide half: how an IShellLinkW string and every IPersistFile
 *           path arrive.
 * @property {(bytes: number) => number} allocate
 *           Task memory, the heap CoTaskMemAlloc uses: a string GetCurFile
 *           hands back is the caller's to free with CoTaskMemFree, so it comes
 *           from here rather than from storage this file keeps.
 * @property {{ stat: (path: string) => { exists: boolean, isDirectory: boolean } | null,
 *              open: (path: string, mode: { write?: boolean, create?: boolean,
 *                     truncate?: boolean }) => unknown,
 *              close: (node: unknown) => void }} [files]
 *           The volume a link is saved on. Absent, Save cannot leave a file and
 *           says so rather than answering success.
 * @property {(api: string, detail: string) => void} [divergence]
 *           Where a method that stands in for work this build does not do says
 *           so, once per distinct difference.
 */

/**
 * @param {ShellLinkHost} host
 * @returns {{ read: (address: number) => string }} the ANSI reader
 */
const ansiReader = host=>({ read: address=>host.readCString(address, MAX_LINK_STRING) });
/**
 * @param {ShellLinkHost} host
 * @returns {{ read: (address: number) => string }} the wide reader
 */
const wideReader = host=>({ read: address=>host.readWideString(address, MAX_LINK_STRING) });

/**
 * Writes `text` into a guest buffer as ANSI or wide, truncated to `cch`
 * characters including the terminator, the way the shell's own getters fill a
 * caller's buffer.
 *
 * @param {ShellLinkHost} host
 * @param {number} buffer
 * @param {number} cch
 * @param {string} text
 * @param {boolean} wide
 */
function writeStringBuffer(host, buffer, cch, text, wide){
    if (buffer === 0 || cch <= 0)
    {
        return;
    }
    const kept = text.slice(0, cch - 1);
    if (wide)
    {
        const bytes = new Uint8Array((kept.length + 1) * 2);
        for (let at = 0; at < kept.length; at++)
        {
            const unit = kept.charCodeAt(at);
            bytes[at * 2] = unit & 0xff;
            bytes[at * 2 + 1] = (unit >>> 8) & 0xff;
        }
        host.writeMemory(buffer, bytes);
        return;
    }
    const bytes = new Uint8Array(kept.length + 1);
    for (let at = 0; at < kept.length; at++)
    {
        bytes[at] = kept.charCodeAt(at) & 0xff;
    }
    host.writeMemory(buffer, bytes);
}

/**
 * Fills a WIN32_FIND_DATA the caller passed to GetPath. Only the name is set;
 * the sizes and times a real shell would stat the target for are left zero,
 * which is the divergence GetPath reports.
 *
 * @param {ShellLinkHost} host
 * @param {number} findData
 * @param {string} path
 * @param {boolean} wide
 */
function writeFindData(host, findData, path, wide){
    const bytes = new Uint8Array(wide ? FIND_DATA_W_SIZE : FIND_DATA_A_SIZE);
    const name = path.slice(0, 259);
    if (wide)
    {
        for (let at = 0; at < name.length; at++)
        {
            const unit = name.charCodeAt(at);
            bytes[FIND_DATA_NAME + at * 2] = unit & 0xff;
            bytes[FIND_DATA_NAME + at * 2 + 1] = (unit >>> 8) & 0xff;
        }
    }
    else
    {
        for (let at = 0; at < name.length; at++)
        {
            bytes[FIND_DATA_NAME + at] = name.charCodeAt(at) & 0xff;
        }
    }
    host.writeMemory(findData, bytes);
}

/**
 * Builds an interface descriptor from `[name, dwords]` slots. The count is the
 * arguments after the interface pointer, as a header reads; `argBytes` adds the
 * pointer back, as the bridge counts. A slot with no handler keeps its place
 * and answers E_NOTIMPL.
 *
 * @param {string} id
 * @param {[string, number][]} slots
 * @param {Record<string, LinkMethod>} [implemented]
 * @returns {import('../ole32/objects.js').ComInterfaceDescriptor}
 */
function describe(id, slots, implemented = {}){
    /** @type {import('../ole32/objects.js').ComMethod[]} */
    const methods = slots.map(([name, dwords])=>{
        const method = implemented[name];
        return {
            name,
            argBytes: 4 + dwords * 4,
            invoke: method ? (object, args)=>method(object.state, args) : undefined,
        };
    });
    return { id, methods };
}

/**
 * The shell link class, ready to be registered. One factory answers for both
 * IShellLink spellings and IPersistFile, over one state, so a program that
 * sets a target through the ANSI interface and saves through IPersistFile is
 * the single object Windows would give it.
 *
 * @param {ShellLinkHost} host
 * @returns {() => import('../ole32/objects.js').ComClassDefinition}
 */
export function createShellLink(host){
    /** @param {string} api @param {string} detail */
    const diverge = (api, detail)=>host.divergence?.(api, detail);

    /**
     * The string setters and getters, built once per spelling. `read` decodes
     * the guest buffer; `wide` says how to write one back.
     *
     * @param {{ read: (address: number) => string }} reader
     * @param {boolean} wide
     */
    const stringMethods = (reader, wide)=>{
        /** @param {StringKey} key @returns {LinkMethod} */
        const setter = key=>(state, args)=>{
            state[key] = reader.read(args[0] >>> 0);
            state.dirty = true;
            return S_OK;
        };
        /** @param {StringKey} key @returns {LinkMethod} */
        const getter = key=>(state, args)=>{
            writeStringBuffer(host, args[0] >>> 0, args[1] | 0, state[key], wide);
            return S_OK;
        };
        /** @type {Record<string, LinkMethod>} */
        const methods = {
            SetPath: setter('path'),
            SetArguments: setter('arguments'),
            SetDescription: setter('description'),
            SetWorkingDirectory: setter('workingDirectory'),
            GetArguments: getter('arguments'),
            GetDescription: getter('description'),
            GetWorkingDirectory: getter('workingDirectory'),

            /**
             * HRESULT GetPath(LPSTR pszFile, int cch, WIN32_FIND_DATA *pfd, DWORD fFlags)
             *
             * The target string back, and the find data filled as far as this
             * build can -- the name, with no sizes or times, which is the
             * divergence named here.
             */
            GetPath: (state, [buffer, cch, findData])=>{
                writeStringBuffer(host, buffer >>> 0, cch | 0, state.path, wide);
                if ((findData >>> 0) !== 0)
                {
                    writeFindData(host, findData >>> 0, state.path, wide);
                    diverge('IShellLink::GetPath',
                        'the find data carries the name only, not the target\'s sizes or times');
                }
                return S_OK;
            },

            /**
             * HRESULT GetRelativePath(LPSTR pszPath, int cch, DWORD dwFlags)
             *
             * Answered with the full path: this object keeps no separate
             * relative form, and a caller that asked for one still gets a path
             * it can use rather than a failure it has to handle.
             */
            GetRelativePath: (state, [buffer, cch])=>{
                writeStringBuffer(host, buffer >>> 0, cch | 0, state.path, wide);
                diverge('IShellLink::GetRelativePath',
                    'the full path answers for the relative one');
                return S_OK;
            },

            /** HRESULT GetIconLocation(LPSTR pszPath, int cch, int *piIcon) */
            GetIconLocation: (state, [buffer, cch, iconIndex])=>{
                writeStringBuffer(host, buffer >>> 0, cch | 0, state.iconLocation, wide);
                if ((iconIndex >>> 0) !== 0)
                {
                    host.writeMemory(iconIndex >>> 0, new Uint8Array([
                        state.iconIndex & 0xff, (state.iconIndex >>> 8) & 0xff,
                        (state.iconIndex >>> 16) & 0xff, (state.iconIndex >>> 24) & 0xff,
                    ]));
                }
                return S_OK;
            },

            /** HRESULT SetIconLocation(LPCSTR pszPath, int iIcon) */
            SetIconLocation: (state, [address, iconIndex])=>{
                state.iconLocation = reader.read(address >>> 0);
                state.iconIndex = iconIndex | 0;
                state.dirty = true;
                return S_OK;
            },

            /** HRESULT SetShowCmd(int iShowCmd) */
            SetShowCmd: (state, [showCmd])=>{
                state.showCmd = showCmd | 0;
                state.dirty = true;
                return S_OK;
            },
            /** HRESULT GetShowCmd(int *piShowCmd) */
            GetShowCmd: (state, [out])=>{
                if ((out >>> 0) !== 0)
                {
                    host.writeMemory(out >>> 0, new Uint8Array([
                        state.showCmd & 0xff, (state.showCmd >>> 8) & 0xff,
                        (state.showCmd >>> 16) & 0xff, (state.showCmd >>> 24) & 0xff,
                    ]));
                }
                return S_OK;
            },
            /** HRESULT SetHotkey(WORD wHotkey) */
            SetHotkey: (state, [hotkey])=>{
                state.hotkey = hotkey & 0xffff;
                state.dirty = true;
                return S_OK;
            },
            /** HRESULT GetHotkey(WORD *pwHotkey) */
            GetHotkey: (state, [out])=>{
                if ((out >>> 0) !== 0)
                {
                    host.writeMemory(out >>> 0,
                        new Uint8Array([state.hotkey & 0xff, (state.hotkey >>> 8) & 0xff]));
                }
                return S_OK;
            },

            /**
             * HRESULT Resolve(HWND hwnd, DWORD fFlags)
             *
             * Answered S_OK without searching: the target is whatever the
             * program set, and there is no shell here to re-find a moved one.
             * An installer calls this before Save and proceeds on success.
             */
            Resolve: ()=>{
                diverge('IShellLink::Resolve',
                    'no search runs; the link answers as already resolved');
                return S_OK;
            },
        };
        return methods;
    };

    /** The IPersistFile half, which is wide like every OLE path.
     * @type {Record<string, LinkMethod>} */
    const persistFile = {
        /** HRESULT GetClassID(CLSID *pclsid) */
        GetClassID: (state, [out])=>{
            void state;
            return writeGuid(host, out >>> 0, CLSID_SHELL_LINK) ? S_OK : E_FAIL;
        },
        /** HRESULT IsDirty() */
        IsDirty: state=>(state.dirty ? S_OK : S_FALSE),

        /**
         * HRESULT Load(LPCOLESTR pszFileName, DWORD dwMode)
         *
         * S_OK when the file is there, which is all an installer's "does my
         * shortcut still exist" check needs; the bytes are not parsed as a
         * shell link, and the state keeps whatever it already held.
         */
        Load: (state, [name])=>{
            const path = host.readWideString(name >>> 0, MAX_LINK_STRING);
            const entry = host.files?.stat(path);
            if (!entry || !entry.exists || entry.isDirectory)
            {
                return STG_E_FILENOTFOUND;
            }
            state.curFile = path;
            state.dirty = false;
            diverge('IPersistFile::Load', 'the file is checked for, not read as a shell link');
            return S_OK;
        },

        /**
         * HRESULT Save(LPCOLESTR pszFileName, BOOL fRemember)
         *
         * Leaves an empty file at the path, so the shortcut exists for whoever
         * looks next, and remembers the path when asked. A real `.lnk` is not
         * written -- there is no Start Menu to read it -- and that is said.
         */
        Save: (state, [name, remember])=>{
            const path = host.readWideString(name >>> 0, MAX_LINK_STRING);
            const node = host.files?.open(path, { write: true, create: true, truncate: true });
            if (!node)
            {
                diverge('IPersistFile::Save',
                    `no volume to save ${path} on; the link is not written`);
                return E_FAIL;
            }
            host.files?.close(node);
            if ((remember | 0) !== 0)
            {
                state.curFile = path;
            }
            state.dirty = false;
            diverge('IPersistFile::Save',
                'an empty file stands in for the shell link; no .lnk is written');
            return S_OK;
        },

        /** HRESULT SaveCompleted(LPCOLESTR pszFileName) */
        SaveCompleted: (state, [name])=>{
            state.curFile = (name >>> 0) === 0
                ? null : host.readWideString(name >>> 0, MAX_LINK_STRING);
            state.dirty = false;
            return S_OK;
        },

        /**
         * HRESULT GetCurFile(LPOLESTR *ppszFileName)
         *
         * The path the last Save or Load named, in task memory the caller frees
         * with CoTaskMemFree. S_FALSE with a null when nothing has been saved.
         */
        GetCurFile: (state, [out])=>{
            const slot = out >>> 0;
            if (slot === 0)
            {
                return E_FAIL;
            }
            if (state.curFile === null)
            {
                host.writeMemory(slot, new Uint8Array(4));
                return S_FALSE;
            }
            const bytes = new Uint8Array((state.curFile.length + 1) * 2);
            for (let at = 0; at < state.curFile.length; at++)
            {
                const unit = state.curFile.charCodeAt(at);
                bytes[at * 2] = unit & 0xff;
                bytes[at * 2 + 1] = (unit >>> 8) & 0xff;
            }
            const block = host.allocate(bytes.length);
            if (block === 0)
            {
                host.writeMemory(slot, new Uint8Array(4));
                return E_FAIL;
            }
            host.writeMemory(block, bytes);
            host.writeMemory(slot, new Uint8Array([
                block & 0xff, (block >>> 8) & 0xff, (block >>> 16) & 0xff, (block >>> 24) & 0xff,
            ]));
            return S_OK;
        },
    };

    const ansi = stringMethods(ansiReader(host), false);
    const wide = stringMethods(wideReader(host), true);

    return ()=>({
        state: newLinkState(),
        interfaces: [
            describe(IID_ISHELL_LINK_A, ISHELL_LINK_SLOTS, ansi),
            describe(IID_ISHELL_LINK_W, ISHELL_LINK_SLOTS, wide),
            describe(IID_IPERSIST_FILE, IPERSIST_FILE_SLOTS, persistFile),
        ],
    });
}

/**
 * Puts the shell link class where CoCreateInstance will find it.
 *
 * @param {import('../ole32/objects.js').ComRegistry} registry
 * @param {ShellLinkHost} host
 */
export function registerShellLinkClasses(registry, host){
    registry.registerClass(CLSID_SHELL_LINK, createShellLink(host));
}
