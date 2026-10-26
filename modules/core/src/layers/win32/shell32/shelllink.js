/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, Version 2.0
 * See LICENSE for details
 */

/**
 * CLSID_ShellLink: IShellLinkA, IShellLinkW and IPersistFile over one link.
 *
 * An installer makes a Start Menu shortcut by asking COM for this class,
 * setting a target through IShellLink and saving it through IPersistFile; a
 * launcher or an uninstaller later loads one and asks where it points. Save
 * writes a real `.lnk` through the shared [MS-SHLLINK] encoder and Load reads
 * one back through its decoder, so a link this object saved, one the installer
 * engine's CreateShortcuts wrote, and one some other writer of the format left
 * on a disc all answer the getters the same way.
 *
 * The id lists a program hands in and gets back are the shell namespace's
 * own (see namespace.js); the file holds the shapes the shell writes for a
 * path, made from the target, so the guest only ever sees one kind and the
 * file only the other. The strings a program sets are kept and handed back
 * verbatim, because a program that reads back what it wrote is the one thing
 * here that must not be surprised.
 */

import { writeGuid } from '../ole32/guid.js';
import { encodeAnsi } from '../kernel32/locale.js';
import { fileAttributes, msToFileTime } from '../kernel32/filetime.js';
import { WIN32_FIND_DATAA } from '../kernel32/files.js';
import {
    CLSID_SHELL_LINK, SW_SHOWNORMAL, decodeShellLink, writeShellLink,
} from '../common/shell-link.js';
import { listBytes, pathOfList } from './namespace.js';

/** CLSID_ShellLink, and the interfaces the object answers to. */
export { CLSID_SHELL_LINK };
export const IID_ISHELL_LINK_A = '{000214EE-0000-0000-C000-000000000046}';
export const IID_ISHELL_LINK_W = '{000214F9-0000-0000-C000-000000000046}';
export const IID_IPERSIST_FILE = '{0000010B-0000-0000-C000-000000000046}';

const S_OK = 0x00000000;
const S_FALSE = 0x00000001;
const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const STG_E_FILENOTFOUND = 0x80030002 | 0;
/** HRESULT_FROM_WIN32(ERROR_PATH_NOT_FOUND): a save into a directory that is not there. */
const E_PATH_NOT_FOUND = 0x80070003 | 0;

/**
 * How far a link string is scanned. Paths top out at MAX_PATH, but arguments
 * and a description are not paths and can be longer; this bounds a runaway
 * scan without truncating anything an installer plausibly writes.
 */
const MAX_LINK_STRING = 2048;

/** WIN32_FIND_DATAW: the A layout up to cFileName, whose 260 characters are wide. */
const FIND_DATA_W_SIZE = 592;

/** How many items an id list from the guest is walked for, against a stray pointer. */
const MAX_LIST_ITEMS = 64;

/**
 * IShellLink's slots after IUnknown's three, as `[name, dwords]`, in the
 * published order the binaries were compiled against -- which is not the
 * Get/Set pairing a reader expects: SetPath is the *last* slot, at vtable
 * offset 0x50, and the pair of a relative path is a setter with no getter.
 * A slot in the wrong place does not fail the call it belongs to; it answers
 * a different method's call with a different argument width, and the guest's
 * stack is wrong from there on.
 *
 * @type {[string, number][]}
 */
const ISHELL_LINK_SLOTS = [
    ['GetPath', 4],
    ['GetIDList', 1],
    ['SetIDList', 1],
    ['GetDescription', 2],
    ['SetDescription', 1],
    ['GetWorkingDirectory', 2],
    ['SetWorkingDirectory', 1],
    ['GetArguments', 2],
    ['SetArguments', 1],
    ['GetHotkey', 1],
    ['SetHotkey', 1],
    ['GetShowCmd', 1],
    ['SetShowCmd', 1],
    ['GetIconLocation', 3],
    ['SetIconLocation', 2],
    ['SetRelativePath', 2],
    ['Resolve', 2],
    ['SetPath', 1],
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
 * @property {string} relativePath
 * @property {string} arguments
 * @property {string} description
 * @property {string} workingDirectory
 * @property {string} iconLocation
 * @property {number} iconIndex
 * @property {number} showCmd
 * @property {number} hotkey
 * @property {Uint8Array | null} idList  The list SetIDList or Load gave, in the
 *           namespace's encoding; null when the target is a path or nothing.
 * @property {{ signature: number, bytes: Uint8Array }[]} blocks
 *           Extra data a loaded link carried, saved back with it.
 * @property {string | null} curFile  The path Save or Load last named.
 * @property {boolean} dirty          Whether a Set* ran since the last save.
 */

/** @returns {ShellLinkState} */
function newLinkState(){
    return {
        path: '', relativePath: '', arguments: '', description: '', workingDirectory: '',
        iconLocation: '', iconIndex: 0, showCmd: SW_SHOWNORMAL, hotkey: 0,
        idList: null, blocks: [], curFile: null, dirty: false,
    };
}

/** The string-valued fields a Set/Get pair keeps and returns.
 * @typedef {'path' | 'relativePath' | 'arguments' | 'description'
 *          | 'workingDirectory' | 'iconLocation'} StringKey
 */

/**
 * A shell link method as the bridge calls it: the object's state, and the
 * guest arguments with the interface pointer already removed.
 *
 * @typedef {(state: ShellLinkState, args: number[]) => number | Promise<number>} LinkMethod
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
 * @property {import('../common/shell-link.js').LinkVolume & {
 *     read: (node: any, offset: number, length: number)
 *         => Uint8Array | Promise<Uint8Array> }} [files]
 *           The volume a link is saved on and loaded from. Absent, Save cannot
 *           leave a file and says so rather than answering success.
 * @property {(text: string) => string} [expand]
 *           Expands %VARIABLES%, so a target given with them is saved with the
 *           path it names as well as the form it was given in.
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
const wideReader = host=>({ read: address=>host.readWideString(address, MAX_LINK_STRING * 2) });

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
    host.writeMemory(buffer, encodeAnsi(`${kept}\0`));
}

/**
 * Fills a WIN32_FIND_DATA the caller passed to GetPath: the target's name --
 * the last component, as a directory listing gives it -- and what the volume
 * knows of it. A target that is not there, or no target, leaves the rest
 * zero, as Windows leaves it.
 *
 * @param {ShellLinkHost} host
 * @param {number} findData
 * @param {string} path
 * @param {boolean} wide
 */
function writeFindData(host, findData, path, wide){
    const bytes = new Uint8Array(wide ? FIND_DATA_W_SIZE : WIN32_FIND_DATAA.SIZE);
    const view = new DataView(bytes.buffer);
    const entry = path === '' ? null : host.files?.stat(path) ?? null;
    if (entry && entry.exists !== false)
    {
        view.setUint32(WIN32_FIND_DATAA.dwFileAttributes, fileAttributes(entry), true);
        // One time for all three, as the file calls report them: the volume
        // records when a name was last written and nothing else.
        const time = entry.modified === undefined ? 0n : msToFileTime(entry.modified);
        view.setBigUint64(WIN32_FIND_DATAA.ftCreationTime, time, true);
        view.setBigUint64(WIN32_FIND_DATAA.ftLastAccessTime, time, true);
        view.setBigUint64(WIN32_FIND_DATAA.ftLastWriteTime, time, true);
        const size = entry.isDirectory ? 0 : entry.size ?? 0;
        view.setUint32(WIN32_FIND_DATAA.nFileSizeHigh, Math.floor(size / 0x100000000), true);
        view.setUint32(WIN32_FIND_DATAA.nFileSizeLow, size >>> 0, true);
    }
    const name = (path.replace(/\\+$/, '').split('\\').pop() ?? '').slice(0, 259);
    if (wide)
    {
        for (let at = 0; at < name.length; at++)
        {
            view.setUint16(WIN32_FIND_DATAA.cFileName + at * 2, name.charCodeAt(at), true);
        }
    }
    else
    {
        bytes.set(encodeAnsi(name), WIN32_FIND_DATAA.cFileName);
    }
    host.writeMemory(findData, bytes);
}

/**
 * The bytes of an id list in guest memory, its terminating zero word
 * included, walked by its own `cb` fields.
 *
 * @param {ShellLinkHost} host
 * @param {number} list
 * @returns {Uint8Array}
 */
function readList(host, list){
    let length = 0;
    for (let n = 0; n < MAX_LIST_ITEMS; n++)
    {
        const head = host.readMemory(list + length, 2);
        const item = head[0] | (head[1] << 8);
        if (item < 3)
        {
            break;
        }
        length += item;
    }
    return host.readMemory(list, length + 2).slice();
}

/**
 * A path a program set, as the shell keeps it: a quoted path without its
 * quotes, and no trailing separator but a drive root's.
 *
 * @param {string} text
 */
function cleanPath(text){
    const unquoted = /^"[^"]*"$/.test(text) ? text.slice(1, -1) : text;
    return /^[A-Za-z]:\\?$/.test(unquoted)
        ? `${unquoted.slice(0, 2)}\\` : unquoted.replace(/\\+$/, '');
}

/** @param {string} path */
const isDrivePath = path=>/^[A-Za-z]:\\/.test(path);

/** @param {number} value */
const dword = value=>new Uint8Array([
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
]);

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
        /**
         * A null string clears the field, as Windows answers a null
         * description with an empty one.
         *
         * @param {StringKey} key @returns {LinkMethod}
         */
        const setter = key=>(state, args)=>{
            state[key] = (args[0] >>> 0) === 0 ? '' : reader.read(args[0] >>> 0);
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
            SetArguments: setter('arguments'),
            SetDescription: setter('description'),
            SetWorkingDirectory: setter('workingDirectory'),
            GetArguments: getter('arguments'),
            GetDescription: getter('description'),
            GetWorkingDirectory: getter('workingDirectory'),

            /**
             * HRESULT SetPath(LPCSTR pszFile)
             *
             * The target as the shell keeps it -- unquoted, with no trailing
             * separator -- and the id list given before it dropped: the last
             * of the two to be set is the target.
             */
            SetPath: (state, [address])=>{
                if ((address >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                state.path = cleanPath(reader.read(address >>> 0));
                state.idList = null;
                state.dirty = true;
                return S_OK;
            },

            /**
             * HRESULT GetPath(LPSTR pszFile, int cch, WIN32_FIND_DATA *pfd, DWORD fFlags)
             *
             * The target string back, and the find data filled from the
             * volume. S_FALSE with an empty string for a link with no target,
             * or one whose id list names no path. A link that was only given
             * a relative path answers with it as it was set: nothing here
             * resolves one against the link's own directory.
             */
            GetPath: (state, [buffer, cch, findData])=>{
                const path = state.path !== '' ? state.path : state.relativePath;
                writeStringBuffer(host, buffer >>> 0, cch | 0, path, wide);
                if ((findData >>> 0) !== 0)
                {
                    writeFindData(host, findData >>> 0, path, wide);
                }
                return path === '' ? S_FALSE : S_OK;
            },

            /**
             * HRESULT SetRelativePath(LPCSTR pszPathRel, DWORD dwFlags)
             *
             * Kept like any other string the object is given, and said to be
             * kept as it is: Windows resolves the relative form against the
             * link's directory when the path is read back, and here it comes
             * back verbatim.
             */
            SetRelativePath: (state, [address])=>{
                state.relativePath = reader.read(address >>> 0);
                state.dirty = true;
                diverge('IShellLink::SetRelativePath',
                    'the relative path is kept unresolved against the link\'s directory');
                return S_OK;
            },

            /** HRESULT GetIconLocation(LPSTR pszPath, int cch, int *piIcon) */
            GetIconLocation: (state, [buffer, cch, iconIndex])=>{
                writeStringBuffer(host, buffer >>> 0, cch | 0, state.iconLocation, wide);
                if ((iconIndex >>> 0) !== 0)
                {
                    host.writeMemory(iconIndex >>> 0, dword(state.iconIndex));
                }
                return S_OK;
            },

            /** HRESULT SetIconLocation(LPCSTR pszPath, int iIcon) */
            SetIconLocation: (state, [address, iconIndex])=>{
                state.iconLocation = (address >>> 0) === 0 ? '' : reader.read(address >>> 0);
                state.iconIndex = iconIndex | 0;
                state.dirty = true;
                return S_OK;
            },
        };
        return methods;
    };

    /**
     * The methods whose arguments carry no string, the same in both spellings.
     *
     * @type {Record<string, LinkMethod>}
     */
    const common = {
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
                host.writeMemory(out >>> 0, dword(state.showCmd));
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
         * HRESULT SetIDList(PCIDLIST_ABSOLUTE pidl)
         *
         * The list is kept as given, so GetIDList hands back an equal one,
         * and the path it names becomes the target -- or no target, for a
         * list that names no place on a drive.
         */
        SetIDList: (state, [list])=>{
            if ((list >>> 0) === 0)
            {
                state.idList = null;
                state.path = '';
            }
            else
            {
                state.idList = readList(host, list >>> 0);
                state.path = pathOfList(host, list >>> 0) ?? '';
            }
            state.dirty = true;
            return S_OK;
        },

        /**
         * HRESULT GetIDList(PIDLIST_ABSOLUTE *ppidl)
         *
         * A fresh copy in task memory, the caller's to free: the list that
         * was set, or the namespace's list for a target path. S_FALSE with a
         * null for a link with neither.
         */
        GetIDList: (state, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const bytes = state.idList
                ?? (isDrivePath(state.path) ? listBytes(state.path) : null);
            const block = bytes ? host.allocate(bytes.length) : 0;
            if (!bytes || block === 0)
            {
                host.writeMemory(out >>> 0, dword(0));
                return bytes ? E_FAIL : S_FALSE;
            }
            host.writeMemory(block, bytes);
            host.writeMemory(out >>> 0, dword(block));
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

    /**
     * What the link file is written from. An id list that names a path is
     * written as the shell's shapes for that path, made from the target; one
     * that names no path goes in as the program gave it.
     *
     * @param {ShellLinkState} state
     * @returns {import('../common/shell-link.js').ShellLinkFields}
     */
    const fieldsOf = state=>({
        target: state.path,
        idList: state.idList && state.path === '' ? state.idList : null,
        description: state.description,
        relativePath: state.relativePath,
        workingDirectory: state.workingDirectory,
        arguments: state.arguments,
        iconLocation: state.iconLocation,
        iconIndex: state.iconIndex,
        showCommand: state.showCmd,
        hotkey: state.hotkey,
        expand: host.expand,
        blocks: state.blocks,
    });

    /**
     * The state a loaded link answers from.
     *
     * @param {ShellLinkState} state
     * @param {import('../common/shell-link.js').ShellLink} link
     */
    const adopt = (state, link)=>{
        state.path = link.target;
        state.relativePath = link.relativePath;
        state.description = link.description;
        state.workingDirectory = link.workingDirectory;
        state.arguments = link.arguments;
        state.iconLocation = link.environmentIcon ?? link.iconLocation;
        state.iconIndex = link.iconIndex;
        state.showCmd = link.showCommand;
        state.hotkey = link.hotkey;
        state.idList = link.idListPath !== null ? listBytes(link.idListPath)
            : link.idList?.slice() ?? null;
        state.blocks = link.blocks;
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
         * Reads the link and answers every getter from it. A file that is
         * there but is no link fails, and leaves the state as it was.
         */
        Load: (state, [name])=>{
            const path = host.readWideString(name >>> 0, MAX_LINK_STRING * 2);
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
                const link = decodeShellLink(bytes);
                if (!link)
                {
                    return E_FAIL;
                }
                adopt(state, link);
                state.curFile = path;
                state.dirty = false;
                return S_OK;
            };
            /** @type {Uint8Array | Promise<Uint8Array>} */
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
         * Writes the link at the path, or at the current file for a null
         * one. Remembering makes the path current and the link clean; a copy
         * saved elsewhere changes neither.
         */
        Save: (state, [name, remember])=>{
            const given = (name >>> 0) === 0
                ? null : host.readWideString(name >>> 0, MAX_LINK_STRING * 2);
            const path = given ?? state.curFile;
            if (path === null)
            {
                return E_INVALIDARG;
            }
            if (!host.files)
            {
                diverge('IPersistFile::Save',
                    `no volume to save ${path} on; the link is not written`);
                return E_FAIL;
            }
            if (!writeShellLink(host.files, path, fieldsOf(state)))
            {
                const parent = path.slice(0, path.lastIndexOf('\\'));
                return host.files.stat(parent)?.isDirectory ? E_FAIL : E_PATH_NOT_FOUND;
            }
            if (given === null || (remember | 0) !== 0)
            {
                state.curFile = path;
                state.dirty = false;
            }
            return S_OK;
        },

        /** HRESULT SaveCompleted(LPCOLESTR pszFileName) */
        SaveCompleted: (state, [name])=>{
            state.curFile = (name >>> 0) === 0
                ? null : host.readWideString(name >>> 0, MAX_LINK_STRING * 2);
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
                host.writeMemory(slot, dword(0));
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
                host.writeMemory(slot, dword(0));
                return E_FAIL;
            }
            host.writeMemory(block, bytes);
            host.writeMemory(slot, dword(block));
            return S_OK;
        },
    };

    const ansi = { ...common, ...stringMethods(ansiReader(host), false) };
    const wide = { ...common, ...stringMethods(wideReader(host), true) };

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
