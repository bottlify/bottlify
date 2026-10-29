/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Shell items: IShellItem, the object Vista's shell and its file dialogs
 * hand round in place of a bare item id list. An item here is its absolute
 * id list and nothing else -- what it names, its name and its attributes are
 * read from the namespace each time they are asked for, so an item outlives
 * nothing it describes. The same object answers IPersistIDList, which gives
 * the list back, and IShellItemImageFactory, which has no picture to give.
 */

import { createAdapter } from '../oleaut32/objects.js';
import { IUNKNOWN_METHODS } from '../ole32/objects.js';
import { parseGuid, readGuid } from '../ole32/guid.js';
import { itemsOf, listBytes, parentOf } from './namespace.js';

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
/** HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) */
const E_FILE_NOT_FOUND = 0x80070002 | 0;
/** MK_E_NOOBJECT: what BindToHandler answers for a handler the item has not. */
const MK_E_NOOBJECT = 0x800401e5 | 0;

const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
export const IID_ISHELLITEM = '{43826D1E-E718-42EE-BC55-A1E261C37BFE}';
const IID_IPERSIST = '{0000010C-0000-0000-C000-000000000046}';
const IID_IPERSISTIDLIST = '{1079ACFC-29BD-11D3-8E0D-00C04F6837D5}';
const IID_ISHELLITEMIMAGEFACTORY = '{BCC18B79-BA16-442F-80C4-8A59C30C463B}';
/** CLSID_ShellItem, which IPersist names the object's class as. */
const CLSID_SHELLITEM = '{9AC9FBE1-E0A2-4AD6-B4EE-E212013EA917}';
/** BHID_SFObject: the item bound as the IShellFolder it is. */
const BHID_SFOBJECT = '{3981E224-F559-11D3-8E3A-00C04F6837D5}';

/** SHGDN_INFOLDER and SHGDN_FORPARSING, which a SIGDN carries in its low word. */
const SHGDN_INFOLDER = 0x0001;
const SHGDN_FORPARSING = 0x8000;
const SIGDN_FILESYSPATH = 0x80058000;
const SIGDN_URL = 0x80068000;

/** What the desktop is called, as a browser shows it. */
const DESKTOP_NAME = 'Desktop';

/** @param {number} value */
const dword = value=>Uint8Array.of(value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff,
    value >>> 24 & 0xff);

/** @param {string} text */
const utf16z = text=>{
    const bytes = new Uint8Array((text.length + 1) * 2);
    for (let at = 0; at < text.length; at++)
    {
        bytes[at * 2] = text.charCodeAt(at) & 0xff;
        bytes[at * 2 + 1] = text.charCodeAt(at) >>> 8;
    }
    return bytes;
};

/** The longest list read out of guest memory: past it a list is no list. */
const MAX_LIST = 0x10000;

/**
 * @typedef {Object} ShellItemHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} [readWideString]
 * @property {(bytes: number) => number} allocate  The heap ILFree frees.
 * @property {(address: number) => void} [free]
 * @property {(object: import('../oleaut32/objects.js').ComAdapter, iid: string) => number} publish
 * @property {(library: string) => Record<string, { handler: (args: number[]) => any }>
 *     | undefined} [library]
 */

/**
 * @typedef {Object} ShellItemNamespace
 * @property {(text: string) => import('./namespace.js').NamespaceItem | null} describe
 * @property {(pointer: number) => string | null | undefined} folderAt
 * @property {(name: string) => { text: string } | null} parse
 * @property {(list: number, riid: number, out: number) => number} bind
 */

/**
 * @typedef {Object} ItemState
 * @property {Uint8Array} list  Its absolute id list, the terminator included.
 */

/**
 * @param {ShellItemHost} host @param {ShellItemNamespace} namespace
 */
export function createShellItems(host, namespace){
    /** @param {number} at */
    const readU32 = at=>new DataView(host.readMemory(at >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} at @param {number} value */
    const writeU32 = (at, value)=>{
        if ((at >>> 0) !== 0)
        {
            host.writeMemory(at >>> 0, dword(value));
        }
    };
    const memory = { readMemory: host.readMemory, writeMemory: host.writeMemory };

    /**
     * A list's bytes as guest memory has them, its terminator included, or
     * null for a list that does not end.
     *
     * @param {number} at
     * @returns {Uint8Array | null}
     */
    const listAt = at=>{
        let length = 0;
        for (let cb = readU32(at) & 0xffff; cb !== 0; cb = readU32(at + length) & 0xffff)
        {
            length += cb;
            if (length > MAX_LIST)
            {
                return null;
            }
        }
        return host.readMemory(at >>> 0, length + 2).slice();
    };

    /** @param {Uint8Array} first @param {Uint8Array} second  Two lists as one. */
    const joined = (first, second)=>{
        const bytes = new Uint8Array(first.length - 2 + second.length);
        bytes.set(first.subarray(0, first.length - 2));
        bytes.set(second, first.length - 2);
        return bytes;
    };

    const DESKTOP = Uint8Array.of(0, 0);

    /**
     * A list put where the program can free it with ILFree; 0 when there is
     * no memory.
     *
     * @param {Uint8Array} bytes
     */
    const placed = bytes=>{
        const at = host.allocate(bytes.length) >>> 0;
        if (at)
        {
            host.writeMemory(at, bytes);
        }
        return at;
    };

    /**
     * What `body` makes of a list put in guest memory for the length of it.
     *
     * @template T @param {Uint8Array} bytes @param {(at: number) => T} body @param {T} failed
     */
    const withList = (bytes, body, failed)=>{
        const at = placed(bytes);
        if (!at)
        {
            return failed;
        }
        try
        {
            return body(at);
        }
        finally
        {
            host.free?.(at);
        }
    };

    /** @param {Uint8Array} list  Its last item's text; undefined for the desktop. */
    const textOf = list=>withList(list, at=>itemsOf(memory, at).at(-1), undefined);

    /** @param {string} text */
    const taskString = async text=>{
        const alloc = host.library?.('ole32.dll')?.CoTaskMemAlloc;
        const bytes = utf16z(text);
        const at = alloc ? /** @type {number} */ (await alloc.handler([bytes.length])) >>> 0 : 0;
        if (at)
        {
            host.writeMemory(at, bytes);
        }
        return at;
    };

    /**
     * The items handed out, by pointer, so one handed back -- to Compare, to
     * SHGetIDListFromObject -- is known for what it is.
     *
     * @type {Map<number, import('../oleaut32/objects.js').ComAdapter>}
     */
    const handedOut = new Map();

    /** @param {number} pointer @returns {ItemState | null} */
    const itemAt = pointer=>{
        const object = handedOut.get(pointer >>> 0);
        return object && !object.destroyed ? object.state : null;
    };

    /**
     * An item for a list, as the interface asked for, into `out`.
     *
     * @param {Uint8Array} list @param {string | null} iid @param {number} out
     */
    const handOut = (list, iid, out)=>{
        writeU32(out, 0);
        if (iid === null || !INTERFACES[iid])
        {
            return E_NOINTERFACE;
        }
        const object = createAdapter(/** @type {ItemState} */ ({ list }), INTERFACES);
        const pointer = host.publish(object, iid === IID_IUNKNOWN ? IID_ISHELLITEM : iid) >>> 0;
        if (!pointer)
        {
            return E_OUTOFMEMORY;
        }
        handedOut.set(pointer, object);
        writeU32(out, pointer);
        return S_OK;
    };

    /** @param {number} riid */
    const iidAt = riid=>((riid >>> 0) === 0 ? null : readGuid(host, riid >>> 0));

    /**
     * The name a SIGDN asks for: for parsing, the item's path (or, in its
     * folder, its own name); otherwise what a browser shows; as a URL, the
     * file: URL of its path. Null for a name the item has not.
     *
     * @param {Uint8Array} list @param {number} sigdn
     * @returns {string | null}
     */
    const nameOf = (list, sigdn)=>{
        const text = textOf(list);
        const item = text === undefined ? null : namespace.describe(text);
        if (text !== undefined && !item)
        {
            return null;
        }
        const path = item && !item.text.startsWith('::') ? item.text : null;
        if (sigdn === SIGDN_FILESYSPATH || sigdn === SIGDN_URL)
        {
            if (path === null)
            {
                return null;
            }
            return sigdn === SIGDN_URL ? `file:///${path.replace(/\\/g, '/')}` : path;
        }
        if ((sigdn & SHGDN_FORPARSING) !== 0 && (sigdn & SHGDN_INFOLDER) === 0)
        {
            return item ? item.text : DESKTOP_NAME;
        }
        return item ? item.name : DESKTOP_NAME;
    };

    /**
     * The list of the folder an item is in: its list less its last item, or
     * for a list of one, the folder that item's text is in. Null for the
     * desktop, which is in nothing.
     *
     * @param {Uint8Array} list
     * @returns {Uint8Array | null}
     */
    const parentList = list=>{
        const texts = withList(list, at=>itemsOf(memory, at), /** @type {string[]} */ ([]));
        if (texts.length === 0)
        {
            return null;
        }
        if (texts.length > 1)
        {
            let end = 0;
            for (let n = 0; n < texts.length - 1; n++)
            {
                end += list[end] | list[end + 1] << 8;
            }
            const parent = new Uint8Array(end + 2);
            parent.set(list.subarray(0, end));
            return parent;
        }
        const folder = parentOf(texts[0]);
        return folder === undefined ? null : folder === null ? DESKTOP : listBytes(folder);
    };

    /** @type {any[]} */
    const itemMethods = [
        ...IUNKNOWN_METHODS,
        /**
         * HRESULT BindToHandler(IBindCtx *pbc, REFGUID bhid, REFIID riid, void **ppv)
         *
         * BHID_SFObject binds a folder as its IShellFolder; no other handler
         * is had here: MK_E_NOOBJECT.
         */
        { name: 'BindToHandler', argBytes: 20,
            /** @param {any} object @param {number[]} args */
            invoke: (object, [, bhid, riid, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                if (iidAt(bhid) !== BHID_SFOBJECT)
                {
                    return MK_E_NOOBJECT;
                }
                return withList(object.state.list, at=>namespace.bind(at, riid, out),
                    E_OUTOFMEMORY);
            } },
        /** HRESULT GetParent(IShellItem **ppsi): the desktop has none. */
        { name: 'GetParent', argBytes: 8,
            /** @param {any} object @param {number[]} args */
            invoke: (object, [out])=>{
                writeU32(out, 0);
                const parent = parentList(object.state.list);
                return parent === null ? E_FAIL : handOut(parent, IID_ISHELLITEM, out);
            } },
        /** HRESULT GetDisplayName(SIGDN sigdnName, LPWSTR *ppszName): in task memory. */
        { name: 'GetDisplayName', argBytes: 12,
            /** @param {any} object @param {number[]} args */
            invoke: async(object, [sigdn, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                const name = nameOf(object.state.list, sigdn >>> 0);
                if (name === null)
                {
                    return E_INVALIDARG;
                }
                const at = await taskString(name);
                writeU32(out, at);
                return at ? S_OK : E_OUTOFMEMORY;
            } },
        /**
         * HRESULT GetAttributes(SFGAOF sfgaoMask, SFGAOF *psfgaoAttribs)
         *
         * The item's attributes within the mask; S_FALSE when not every one
         * asked for is set.
         */
        { name: 'GetAttributes', argBytes: 12,
            /** @param {any} object @param {number[]} args */
            invoke: (object, [mask, out])=>{
                const text = textOf(object.state.list);
                const item = text === undefined ? null : namespace.describe(text);
                if (text !== undefined && !item)
                {
                    writeU32(out, 0);
                    return E_FAIL;
                }
                const attributes = ((item?.attributes ?? 0) & mask) >>> 0;
                writeU32(out, attributes);
                return attributes === (mask >>> 0) ? S_OK : S_FALSE;
            } },
        /**
         * HRESULT Compare(IShellItem *psi, SICHINTF hint, int *piOrder)
         *
         * By what the two name, without regard to case: S_OK and 0 for the
         * same item, S_FALSE and the order otherwise.
         */
        { name: 'Compare', argBytes: 16,
            /** @param {any} object @param {number[]} args */
            invoke: (object, [other, , out])=>{
                const theirs = itemAt(other);
                if (!theirs || (out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const rank = (/** @type {Uint8Array} */ list)=>(textOf(list) ?? '').toLowerCase();
                const [a, b] = [rank(object.state.list), rank(theirs.list)];
                const order = a < b ? -1 : a > b ? 1 : 0;
                writeU32(out, order);
                return order === 0 ? S_OK : S_FALSE;
            } },
    ];

    /** @type {any[]} */
    const persistMethods = [
        ...IUNKNOWN_METHODS,
        /** HRESULT GetClassID(CLSID *pClassID) */
        { name: 'GetClassID', argBytes: 8,
            /** @param {any} object @param {number[]} args */
            invoke: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(out >>> 0, /** @type {Uint8Array} */ (parseGuid(CLSID_SHELLITEM)));
                return S_OK;
            } },
        /** HRESULT SetIDList(PCIDLIST_ABSOLUTE pidl): the item becomes the list's. */
        { name: 'SetIDList', argBytes: 8,
            /** @param {any} object @param {number[]} args */
            invoke: (object, [pidl])=>{
                const list = (pidl >>> 0) === 0 ? null : listAt(pidl);
                if (list === null)
                {
                    return E_INVALIDARG;
                }
                object.state.list = list;
                return S_OK;
            } },
        /** HRESULT GetIDList(PIDLIST_ABSOLUTE *ppidl): a copy, the caller's to ILFree. */
        { name: 'GetIDList', argBytes: 8,
            /** @param {any} object @param {number[]} args */
            invoke: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const at = placed(object.state.list);
                writeU32(out, at);
                return at ? S_OK : E_OUTOFMEMORY;
            } },
    ];

    /** @type {any[]} */
    const imageMethods = [
        ...IUNKNOWN_METHODS,
        /**
         * HRESULT GetImage(SIZE size, SIIGBF flags, HBITMAP *phbm)
         *
         * The size travels by value, two words. There is no picture of any
         * item to scale: E_NOTIMPL and no bitmap.
         */
        { name: 'GetImage', argBytes: 20,
            /** @param {any} object @param {number[]} args */
            invoke: (object, [, , , out])=>{
                writeU32(out, 0);
                return E_NOTIMPL;
            } },
    ];

    /** @type {Record<string, any[]>} */
    const INTERFACES = {
        [IID_ISHELLITEM]: itemMethods,
        [IID_IUNKNOWN]: itemMethods,
        [IID_IPERSIST]: persistMethods,
        [IID_IPERSISTIDLIST]: persistMethods,
        [IID_ISHELLITEMIMAGEFACTORY]: imageMethods,
    };

    /**
     * The list a parsing name finds: a full path the namespace has, or one of
     * its `::` names. A relative name is no parsing name.
     *
     * @param {string} name
     * @returns {Uint8Array | null}
     */
    const parsed = name=>{
        if (!/^([A-Za-z]:\\|\\\\|::)/.test(name))
        {
            return null;
        }
        const found = namespace.parse(name);
        return found ? listBytes(found.text) : null;
    };

    return {
        /**
         * HRESULT SHCreateShellItem(PCIDLIST_ABSOLUTE pidlParent, IShellFolder *psfParent,
         *                           PCUITEMID_CHILD pidl, IShellItem **ppsi)
         *
         * The child's list under its parent: the parent's list when one is
         * given, else the folder's own, else the child's list is absolute.
         */
        SHCreateShellItem: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([parent, folder, child, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                const own = (child >>> 0) === 0 ? null : listAt(child);
                if (own === null)
                {
                    return E_INVALIDARG;
                }
                if ((parent >>> 0) !== 0)
                {
                    const above = listAt(parent);
                    return above === null ? E_INVALIDARG
                        : handOut(joined(above, own), IID_ISHELLITEM, out);
                }
                if ((folder >>> 0) !== 0)
                {
                    const text = namespace.folderAt(folder);
                    if (text === undefined)
                    {
                        return E_INVALIDARG;
                    }
                    return handOut(joined(text === null ? DESKTOP : listBytes(text), own),
                        IID_ISHELLITEM, out);
                }
                return handOut(own, IID_ISHELLITEM, out);
            },
        },

        /** HRESULT SHCreateItemFromIDList(PCIDLIST_ABSOLUTE pidl, REFIID riid, void **ppv) */
        SHCreateItemFromIDList: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([pidl, riid, out])=>{
                writeU32(out, 0);
                const list = (pidl >>> 0) === 0 ? null : listAt(pidl);
                return list === null || (out >>> 0) === 0 ? E_INVALIDARG
                    : handOut(list, iidAt(riid), out);
            },
        },

        /**
         * HRESULT SHCreateItemFromParsingName(PCWSTR pszPath, IBindCtx *pbc, REFIID riid,
         *                                     void **ppv)
         *
         * A full path the volume has, or a `::` name; anything else is not
         * found (Wine's test_SHCreateShellItem).
         */
        SHCreateItemFromParsingName: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([name, , riid, out])=>{
                writeU32(out, 0);
                const text = (name >>> 0) === 0 ? null
                    : host.readWideString?.(name >>> 0, 0x8000) ?? null;
                if (text === null || (out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const list = parsed(text);
                return list === null ? E_FILE_NOT_FOUND : handOut(list, iidAt(riid), out);
            },
        },

        /**
         * HRESULT SHCreateItemFromRelativeName(IShellItem *psiParent, PCWSTR pszName,
         *                                      IBindCtx *pbc, REFIID riid, void **ppv)
         *
         * The item a name is in the parent's folder: the parent must be a
         * folder on the volume, and the name there.
         */
        SHCreateItemFromRelativeName: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([parent, name, , riid, out])=>{
                writeU32(out, 0);
                const above = itemAt(parent);
                const text = (name >>> 0) === 0 ? null
                    : host.readWideString?.(name >>> 0, 0x8000) ?? null;
                if (!above || text === null || (out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const folder = nameOf(above.list, SIGDN_FILESYSPATH);
                const list = folder === null ? null
                    : parsed(`${folder.replace(/\\$/, '')}\\${text}`);
                return list === null ? E_FILE_NOT_FOUND : handOut(list, iidAt(riid), out);
            },
        },

        /**
         * HRESULT SHGetIDListFromObject(IUnknown *punk, PIDLIST_ABSOLUTE *ppidl)
         *
         * The list of an item or a folder this shell handed out; another
         * object's is not known here: E_NOINTERFACE.
         */
        SHGetIDListFromObject: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([object, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                if ((object >>> 0) === 0)
                {
                    return E_NOINTERFACE;
                }
                const item = itemAt(object);
                const folder = item ? undefined : namespace.folderAt(object);
                const list = item ? item.list
                    : folder === undefined ? null : folder === null ? DESKTOP : listBytes(folder);
                if (list === null)
                {
                    return E_NOINTERFACE;
                }
                const at = placed(list);
                writeU32(out, at);
                return at ? S_OK : E_OUTOFMEMORY;
            },
        },

        /** HRESULT SHGetItemFromObject(IUnknown *punk, REFIID riid, void **ppv) */
        SHGetItemFromObject: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([object, riid, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                const item = itemAt(object);
                const folder = item ? undefined : namespace.folderAt(object);
                const list = item ? item.list
                    : folder === undefined ? null : folder === null ? DESKTOP : listBytes(folder);
                return list === null ? E_NOINTERFACE : handOut(list, iidAt(riid), out);
            },
        },
    };
}
