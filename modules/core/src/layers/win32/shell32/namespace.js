/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shell namespace: the desktop, the computer under it, the drives under
 * that and the directories of the volume under those, walked through
 * IShellFolder and IEnumIDList the way a folder browser a program builds for
 * itself walks the real one.
 *
 * An item id list is the currency here, and its encoding is the whole design:
 * every item carries the full text of what it names -- `C:\Program Files` for
 * a directory, `::{clsid}` for the computer -- so a list turns back into a
 * path without a table, and a list the program has combined from a parent and
 * a child by its own ILCombine (which walks `cb` fields and copies bytes) still
 * ends in an item that says where it is. A program only ever compares, copies
 * and hands these back, which is what lets the content be ours to choose.
 */

import { readGuid } from '../ole32/guid.js';
import { IUNKNOWN_METHODS } from '../ole32/objects.js';
import { createAdapter } from '../oleaut32/objects.js';

export const IID_ISHELLFOLDER = '{000214E6-0000-0000-C000-000000000046}';
export const IID_IENUMIDLIST = '{000214F2-0000-0000-C000-000000000046}';
const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';

/**
 * The computer, as the shell names it for parsing: a program that sees the
 * `::` prefix knows the item is no path and asks for the display name instead.
 */
export const MY_COMPUTER = '::{20D04FE0-3AEA-1069-A2D8-08002B30309D}';
const MY_COMPUTER_NAME = 'My Computer';

const S_OK = 0;
const S_FALSE = 1;
const E_NOINTERFACE = 0x80004002 | 0;
const E_NOTIMPL = 0x80004001 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;

const SHCONTF_FOLDERS = 0x20;
const SHCONTF_NONFOLDERS = 0x40;

const SFGAO_FILESYSANCESTOR = 0x10000000;
const SFGAO_FOLDER = 0x20000000;
const SFGAO_FILESYSTEM = 0x40000000;
const SFGAO_HASSUBFOLDER = 0x80000000;

const SHGDN_FORPARSING = 0x8000;

/** STRRET: the type word, then the text in place. */
const STRRET_CSTR = 2;
const STRRET_TEXT = 4;
const STRRET_CAPACITY = 260;

const MAX_PATH = 260;

/** @param {string} text @returns {Uint8Array} eight-bit text with its terminator */
const sz = text=>{
    const bytes = new Uint8Array(text.length + 1);
    for (let at = 0; at < text.length; at++)
    {
        bytes[at] = text.charCodeAt(at) & 0xff;
    }
    return bytes;
};

/** @param {number} value */
const dword = value=>new Uint8Array([
    value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
]);

/**
 * The bytes of a list of one item whose data is the text, then the empty item
 * that ends every list: `cb` is a WORD counting itself.
 *
 * @param {string} text
 * @returns {Uint8Array}
 */
export function listBytes(text){
    const data = sz(text);
    const item = 2 + data.length;
    const bytes = new Uint8Array(item + 2);
    bytes[0] = item & 0xff;
    bytes[1] = item >>> 8;
    bytes.set(data, 2);
    return bytes;
}

/**
 * @typedef {Object} NamespaceMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * The texts of a list's items, first to last: a list the program combined
 * from several of ours reads as the texts of each.
 *
 * @param {NamespaceMemory} memory
 * @param {number} list
 * @returns {string[]}
 */
export function itemsOf(memory, list){
    const texts = [];
    let at = list >>> 0;
    // A list is short, but a pointer to something else is not, and walking it
    // by its own `cb` fields would run until a zero word turned up.
    for (let n = 0; at !== 0 && n < 64; n++)
    {
        const header = memory.readMemory(at, 2);
        const item = header[0] | header[1] << 8;
        if (item < 3)
        {
            break;
        }
        const data = memory.readMemory(at + 2, item - 2);
        const end = data.indexOf(0);
        texts.push(String.fromCharCode(...data.subarray(0, end < 0 ? data.length : end)));
        at += item;
    }
    return texts;
}

/**
 * The path a list names, or null for one that names no place on a volume:
 * the computer itself, or a list this build did not make.
 *
 * @param {NamespaceMemory} memory
 * @param {number} list
 * @returns {string | null}
 */
export function pathOfList(memory, list){
    const last = itemsOf(memory, list).at(-1) ?? null;
    return last === null || last.startsWith('::') ? null : last;
}

/**
 * @typedef {Object} NamespaceVolume
 * @property {() => string[]} drives
 * @property {(path: string) => { isDirectory: boolean } | null} stat
 * @property {(path: string) => { name: string, isDirectory: boolean }[]} list
 */

/**
 * A method of a namespace object, as the bridge publishes it: `invoke` sees
 * the object and the arguments with `this` removed.
 *
 * @template S
 * @typedef {Object} NamespaceMethod
 * @property {string} name
 * @property {number} argBytes
 * @property {'queryInterface' | 'addRef' | 'release'} [builtin]
 * @property {(object: { state: S }, args: number[]) => number} [invoke]
 */

/**
 * @typedef {Object} NamespaceDeps
 * @property {(object: import('../oleaut32/objects.js').ComAdapter, interfaceId: string) => number} publish
 *           Puts an interface into guest memory and answers with its pointer.
 * @property {(bytes: number) => number} allocate
 *           The task allocator's heap: a list handed out is freed with IMalloc.
 * @property {NamespaceMemory} memory
 * @property {NamespaceVolume} volume
 */

/**
 * @typedef {Object} NamespaceItem
 * @property {string} text   What its item id carries.
 * @property {string} name   What a browser shows for it.
 * @property {number} attributes
 */

/**
 * @param {NamespaceDeps} deps
 */
export function createShellNamespace({ publish, allocate, memory, volume }){
    /** @param {string} path @param {string} name */
    const join = (path, name)=>(path.endsWith('\\') ? path + name : `${path}\\${name}`);

    /** @param {string} path */
    const hasSubfolder = path=>volume.list(path).some(entry=>entry.isDirectory);

    /** @param {string} path */
    const directoryItem = path=>({
        text: path,
        name: /^[A-Za-z]:\\$/.test(path) ? `Local Disk (${path.slice(0, 2)})` : path.split('\\').pop() ?? path,
        attributes: (SFGAO_FOLDER | SFGAO_FILESYSTEM | SFGAO_FILESYSANCESTOR
            | (hasSubfolder(path) ? SFGAO_HASSUBFOLDER : 0)) >>> 0,
    });

    /** The one item the desktop has. */
    const computerItem = {
        text: MY_COMPUTER, name: MY_COMPUTER_NAME,
        attributes: (SFGAO_FOLDER | SFGAO_FILESYSANCESTOR | SFGAO_HASSUBFOLDER) >>> 0,
    };

    /**
     * What a list's last item names, wherever it is in the namespace: a
     * program hands back the lists it was given, and what they carry is
     * enough to know them again.
     *
     * @param {string} text
     * @returns {NamespaceItem | null}
     */
    const itemFor = text=>{
        if (text === MY_COMPUTER)
        {
            return computerItem;
        }
        const entry = volume.stat(text);
        if (!entry)
        {
            return null;
        }
        return entry.isDirectory
            ? directoryItem(text)
            : { text, name: text.split('\\').pop() ?? text, attributes: SFGAO_FILESYSTEM };
    };

    /**
     * The children of a folder, folders first as the shell lists them.
     *
     * @param {string | null} folder  Null is the desktop.
     * @param {number} flags
     * @returns {NamespaceItem[]}
     */
    const childrenOf = (folder, flags)=>{
        if (folder === null)
        {
            return (flags & SHCONTF_FOLDERS) !== 0 ? [computerItem] : [];
        }
        if (folder === MY_COMPUTER)
        {
            return (flags & SHCONTF_FOLDERS) === 0
                ? [] : volume.drives().map(letter=>directoryItem(`${letter[0].toUpperCase()}:\\`));
        }
        const listed = volume.list(folder);
        const folders = (flags & SHCONTF_FOLDERS) === 0
            ? [] : listed.filter(entry=>entry.isDirectory)
                .map(entry=>directoryItem(join(folder, entry.name)));
        const files = (flags & SHCONTF_NONFOLDERS) === 0
            ? [] : listed.filter(entry=>!entry.isDirectory).map(entry=>({
                text: join(folder, entry.name), name: entry.name, attributes: SFGAO_FILESYSTEM,
            }));
        return [...folders, ...files];
    };

    /** @param {string} text @returns {number} where the list was put, or zero */
    const listFor = text=>{
        const bytes = listBytes(text);
        const at = allocate(bytes.length);
        if (at !== 0)
        {
            memory.writeMemory(at, bytes);
        }
        return at;
    };

    /**
     * Puts an object's interface into guest memory and writes the pointer
     * where the caller asked; the creation reference is the one it holds.
     *
     * @param {import('../oleaut32/objects.js').ComAdapter} object
     * @param {string} iid @param {number} out
     */
    const handOut = (object, iid, out)=>{
        const pointer = publish(object, iid) >>> 0;
        memory.writeMemory(out, dword(pointer));
        return pointer === 0 ? E_OUTOFMEMORY : S_OK;
    };

    /**
     * @typedef {Object} FolderState
     * @property {string | null} folder  Null is the desktop.
     */
    /**
     * @typedef {Object} EnumeratorState
     * @property {NamespaceItem[]} items
     * @property {number} at
     */

    // One method table per interface, built once: the bridge shares a vtable
    // among every object published with the same table, and a table made per
    // object would be a vtable per object.
    /** @type {Readonly<Record<string, readonly NamespaceMethod<FolderState>[]>>} */
    let folderInterfaces = {};
    /** @type {Readonly<Record<string, readonly NamespaceMethod<EnumeratorState>[]>>} */
    let enumeratorInterfaces = {};

    /** @param {string | null} folder */
    const folderObject = folder=>createAdapter(
        /** @type {FolderState} */ ({ folder }), folderInterfaces);
    /** @param {NamespaceItem[]} items @param {number} at */
    const enumeratorObject = (items, at)=>createAdapter(
        /** @type {EnumeratorState} */ ({ items, at }), enumeratorInterfaces);

    /** @param {number} at */
    const readWide = at=>{
        let text = '';
        for (let n = 0; n < MAX_PATH; n++)
        {
            const pair = memory.readMemory(at + n * 2, 2);
            const code = pair[0] | pair[1] << 8;
            if (code === 0)
            {
                break;
            }
            text += String.fromCharCode(code);
        }
        return text;
    };

    /** @type {readonly NamespaceMethod<FolderState>[]} */
    const folderMethods = Object.freeze([
        ...IUNKNOWN_METHODS,
        /*
                 * HRESULT ParseDisplayName(HWND, LPBC, LPOLESTR name, ULONG *eaten,
                 *   LPITEMIDLIST *ppidl, ULONG *attributes)
                 *
                 * A path the volume has becomes its item; the whole of it is
                 * eaten. Attributes go back through the same mask as
                 * GetAttributesOf.
                 */
        { name: 'ParseDisplayName', argBytes: 28,
            invoke: (object, [, , name, eaten, out, attributes])=>{
                const item = itemFor(readWide(name >>> 0));
                memory.writeMemory(out >>> 0, dword(0));
                if (!item)
                {
                    return E_INVALIDARG;
                }
                const list = listFor(item.text);
                memory.writeMemory(out >>> 0, dword(list));
                if ((eaten >>> 0) !== 0)
                {
                    memory.writeMemory(eaten >>> 0, dword(item.text.length));
                }
                if ((attributes >>> 0) !== 0)
                {
                    const asked = memory.readMemory(attributes >>> 0, 4);
                    const mask = (asked[0] | asked[1] << 8 | asked[2] << 16
                                | asked[3] << 24) >>> 0;
                    memory.writeMemory(attributes >>> 0,
                        dword((item.attributes & mask) >>> 0));
                }
                return list === 0 ? E_OUTOFMEMORY : S_OK;
            } },
        /* HRESULT EnumObjects(HWND, SHCONTF flags, IEnumIDList **ppenum) */
        { name: 'EnumObjects', argBytes: 16,
            invoke: (object, [, flags, out])=>handOut(
                enumeratorObject(childrenOf(object.state.folder, flags >>> 0), 0),
                IID_IENUMIDLIST, out >>> 0) },
        /*
                 * HRESULT BindToObject(PCUIDLIST_RELATIVE pidl, LPBC, REFIID, void **ppv)
                 *
                 * The folder a child is: only a folder binds, and only as
                 * IShellFolder.
                 */
        { name: 'BindToObject', argBytes: 20,
            invoke: (object, [pidl, , riid, out])=>{
                const iid = readGuid(memory, riid >>> 0);
                const item = itemFor(itemsOf(memory, pidl >>> 0).at(-1) ?? '');
                if (!item || (item.attributes & SFGAO_FOLDER) === 0)
                {
                    memory.writeMemory(out >>> 0, dword(0));
                    return E_INVALIDARG;
                }
                if (iid !== IID_ISHELLFOLDER && iid !== IID_IUNKNOWN)
                {
                    memory.writeMemory(out >>> 0, dword(0));
                    return E_NOINTERFACE;
                }
                return handOut(folderObject(item.text), IID_ISHELLFOLDER, out >>> 0);
            } },
        { name: 'BindToStorage', argBytes: 20, invoke: ()=>E_NOTIMPL },
        /*
                 * HRESULT CompareIDs(LPARAM, PCUIDLIST_RELATIVE, PCUIDLIST_RELATIVE)
                 *
                 * The order of a folder listing, as a signed short in the
                 * code of a successful HRESULT: the computer before any path,
                 * then by name without regard to case.
                 */
        { name: 'CompareIDs', argBytes: 16,
            invoke: (object, [, first, second])=>{
                const a = itemsOf(memory, first >>> 0).at(-1) ?? '';
                const b = itemsOf(memory, second >>> 0).at(-1) ?? '';
                const rank = (/** @type {string} */ text)=>
                    (text.startsWith('::') ? '\0' : '') + text.toLowerCase();
                const order = rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0;
                return order & 0xffff;
            } },
        { name: 'CreateViewObject', argBytes: 16, invoke: ()=>E_NOTIMPL },
        /*
                 * HRESULT GetAttributesOf(UINT cidl, PCUITEMID_CHILD_ARRAY apidl,
                 *   SFGAOF *rgfInOut)
                 *
                 * The attributes every named item has, within the mask the
                 * caller passed in.
                 */
        { name: 'GetAttributesOf', argBytes: 16,
            invoke: (object, [count, lists, inOut])=>{
                const asked = memory.readMemory(inOut >>> 0, 4);
                let mask = (asked[0] | asked[1] << 8 | asked[2] << 16 | asked[3] << 24) >>> 0;
                let shared = 0xffffffff;
                for (let n = 0; n < (count >>> 0); n++)
                {
                    const slot = memory.readMemory((lists >>> 0) + n * 4, 4);
                    const list = (slot[0] | slot[1] << 8 | slot[2] << 16 | slot[3] << 24) >>> 0;
                    const item = itemFor(itemsOf(memory, list).at(-1) ?? '');
                    if (!item)
                    {
                        memory.writeMemory(inOut >>> 0, dword(0));
                        return E_INVALIDARG;
                    }
                    shared = (shared & item.attributes) >>> 0;
                }
                mask = (mask & shared) >>> 0;
                memory.writeMemory(inOut >>> 0, dword(mask));
                return S_OK;
            } },
        { name: 'GetUIObjectOf', argBytes: 28, invoke: ()=>E_NOTIMPL },
        /*
                 * HRESULT GetDisplayNameOf(PCUITEMID_CHILD pidl, SHGDNF flags,
                 *   STRRET *name)
                 *
                 * For parsing, what the item carries; otherwise what a browser
                 * shows. Answered in place as STRRET_CSTR, which needs no
                 * allocation and no freeing.
                 */
        { name: 'GetDisplayNameOf', argBytes: 16,
            invoke: (object, [pidl, flags, out])=>{
                const item = itemFor(itemsOf(memory, pidl >>> 0).at(-1) ?? '');
                if (!item)
                {
                    return E_INVALIDARG;
                }
                const text = ((flags >>> 0) & SHGDN_FORPARSING) !== 0 ? item.text : item.name;
                memory.writeMemory(out >>> 0, dword(STRRET_CSTR));
                memory.writeMemory((out >>> 0) + STRRET_TEXT,
                    sz(text.slice(0, STRRET_CAPACITY - 1)));
                return S_OK;
            } },
        { name: 'SetNameOf', argBytes: 24, invoke: ()=>E_NOTIMPL },
    ]);
    folderInterfaces = Object.freeze({ [IID_ISHELLFOLDER]: folderMethods });

    /** @type {readonly NamespaceMethod<EnumeratorState>[]} */
    const enumeratorMethods = Object.freeze([
        ...IUNKNOWN_METHODS,
        /*
                     * HRESULT Next(ULONG celt, LPITEMIDLIST *rgelt, ULONG *fetched)
                     *
                     * S_FALSE once fewer than asked remain, which is what ends a
                     * caller's loop; each list is the caller's to free.
                     */
        { name: 'Next', argBytes: 16,
            invoke: (object, [count, out, fetched])=>{
                let n = 0;
                while (n < (count >>> 0) && object.state.at < object.state.items.length)
                {
                    const list = listFor(object.state.items[object.state.at].text);
                    if (list === 0)
                    {
                        return E_OUTOFMEMORY;
                    }
                    memory.writeMemory((out >>> 0) + n * 4, dword(list));
                    object.state.at++;
                    n++;
                }
                if ((fetched >>> 0) !== 0)
                {
                    memory.writeMemory(fetched >>> 0, dword(n));
                }
                return n === (count >>> 0) ? S_OK : S_FALSE;
            } },
        { name: 'Skip', argBytes: 8,
            invoke: (object, [count])=>{
                object.state.at = Math.min(object.state.items.length,
                    object.state.at + (count >>> 0));
                return object.state.at < object.state.items.length ? S_OK : S_FALSE;
            } },
        { name: 'Reset', argBytes: 4,
            invoke: object=>{
                object.state.at = 0;
                return S_OK;
            } },
        { name: 'Clone', argBytes: 8,
            invoke: (object, [out])=>handOut(
                enumeratorObject(object.state.items, object.state.at),
                IID_IENUMIDLIST, out >>> 0) },
    ]);
    enumeratorInterfaces = Object.freeze({ [IID_IENUMIDLIST]: enumeratorMethods });

    return {
        /**
         * The desktop folder, into guest memory: what SHGetDesktopFolder
         * answers with, a fresh object carrying one reference each time.
         *
         * @param {number} out
         */
        desktop: out=>handOut(folderObject(null), IID_ISHELLFOLDER, out),
        /** @param {string} text @returns {number} */
        listFor,
        /** @param {number} list */
        pathOf: list=>pathOfList(memory, list),
    };
}
