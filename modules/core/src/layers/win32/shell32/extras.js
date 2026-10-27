/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shell32 exports built on its others and on kernel32's: environment
 * strings expanded in place, a folder's path with a subdirectory under it,
 * an item id list for a path, the known folders' lists, the cabinet
 * settings, the system image lists, the change notifications and the
 * helpers of a shell view this build has none of.
 */

import { createAdapter } from '../oleaut32/objects.js';
import { IUNKNOWN_METHODS } from '../ole32/objects.js';
import { readGuid } from '../ole32/guid.js';

const S_OK = 0;
const E_NOTIMPL = 0x80004001 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const E_NOINTERFACE = 0x80004002 | 0;

const MAX_PATH = 260;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_FILENAME_EXCED_RANGE = 206;
const CSIDL_FLAG_DONT_VERIFY = 0x4000;
const CSIDL_FLAG_CREATE = 0x8000;

/** SHGetNewLinkInfo's flags. */
const SHGNLI_PIDL = 0x1;
const SHGNLI_PREFIXNAME = 0x2;
const SHGNLI_NOUNIQUE = 0x4;
const SHGNLI_NOLNK = 0x8;

/** @param {number} code */
const fromWin32 = code=>((code & 0xffff) | 0x80070000) | 0;

/** CABINETSTATE: its size, then the flags and the defaults ReadCabinetState fills. */
const CABINETSTATE_SIZE = 12;
const CABINETSTATE_VERSION = 2;

/**
 * SHIL_*: the system image lists by index -- large, small, extra large,
 * the system's small, jumbo -- and the icon size of each.
 */
const IMAGE_SIZES = Object.freeze([32, 16, 48, 16, 256]);

/** The known folders this build has, as the CSIDL each is. */
const KNOWN_FOLDERS = Object.freeze({
    '{B4BFCC3A-DB2C-424C-B029-7FE99A87C641}': 0x0000, // FOLDERID_Desktop
    '{FDD39AD0-238F-46AF-ADB4-6C85480369C7}': 0x0005, // FOLDERID_Documents
    '{3EB685DB-65F9-4CF6-A03A-E3EF65729F3D}': 0x001a, // FOLDERID_RoamingAppData
    '{F1B32785-6FBA-4FCF-9D55-7B8E7F157091}': 0x001c, // FOLDERID_LocalAppData
    '{905E63B6-C1BF-494E-B29C-65B732D3D21A}': 0x0026, // FOLDERID_ProgramFiles
    '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}': 0x0025, // FOLDERID_System
    '{F38BF404-1D43-42F2-9305-67DE0B28FC23}': 0x0024, // FOLDERID_Windows
    '{0AC0837C-BBF8-452A-850D-79D08E667CA7}': 0x0011, // FOLDERID_ComputerFolder
    '{625B53C3-AB48-4EC1-BA1F-A1EF4146FC19}': 0x000b, // FOLDERID_StartMenu
    '{A77F5D77-2E2B-44C3-A6A2-ABA601054A51}': 0x0002, // FOLDERID_Programs
    '{B97D20BB-F46A-4C97-BA10-5E3608430854}': 0x0007, // FOLDERID_Startup
    '{1777F761-68AD-4D8A-87BD-30B759FA33DD}': 0x0006, // FOLDERID_Favorites
    '{4BD8D571-6D19-48D3-BE97-422220080E43}': 0x000d, // FOLDERID_Music
    '{33E28130-4E1E-4676-835A-98395C3BC3BB}': 0x0027, // FOLDERID_Pictures
    '{18989B1D-99B5-455B-841C-AB7C74E4DDFC}': 0x000e, // FOLDERID_Videos
    '{FD228CB7-AE11-4AE3-864C-16F3910AB8FE}': 0x0014, // FOLDERID_Fonts
    '{352481E8-33BE-4251-BA85-6007CAEDCF9D}': 0x0020, // FOLDERID_InternetCache
    '{D65231B0-B2F1-4857-A4CE-A8E7C6EA7D27}': 0x0029, // FOLDERID_SystemX86
});

const IID_IIMAGELIST = '{46EB5926-582E-4017-9FDF-E8998DAA0950}';

const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
const IID_IPROPERTYSTORE = '{886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99}';
const E_FAIL = 0x80004005 | 0;
/** PROPVARIANT types a store copies as they are: none of them points anywhere. */
const SCALAR_TYPES = Object.freeze(new Set([0, 1, 2, 3, 4, 5, 11, 16, 17, 18, 19, 20, 21, 22,
    23, 64]));
const VT_LPWSTR = 31;

/** SHSTOCKICONINFO: cbSize, hIcon, iSysImageIndex, iIcon, then szPath[MAX_PATH]. */
const SHSTOCKICONINFO_SIZE = 16 + MAX_PATH * 2;
/** SIID_MAX_ICONS: the stock icons are numbered from 0 to one below it. */
const SIID_MAX_ICONS = 181;
const SHGSI_ICON = 0x100;
const IID_IIMAGELIST2 = '{192B9D83-50FC-457B-90A0-2B82A8B5DAE1}';

/**
 * @typedef {Object} ExtrasHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} [readWideString]
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [free]
 * @property {(library: string) => Record<string, { handler: (args: number[]) => any }>
 *     | undefined} [library]
 * @property {(object: any, iid: string) => number} [publish]
 * @property {(api: string, detail: string) => void} [divergence]
 *
 * @typedef {Object} ExtrasParts
 * @property {Record<string, { handler: (args: number[]) => any }>} table
 *           shell32's own exports, which these call as a program would: read
 *           when a call is made, the table being built when these are.
 * @property {(path: string) => number} listFor  An item id list for a path; 0 for no memory.
 * @property {(path: string) => boolean} exists  Whether the volume has the path.
 * @property {(name: string) => { text: string, attributes: number } | null} parse
 *           What the desktop folder's ParseDisplayName finds for a name.
 */

/** @param {number} value */
const dword = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

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

/**
 * @param {ExtrasHost} host @param {ExtrasParts} parts
 */
export function createShellExtras(host, parts){
    const { listFor, exists, parse } = parts;
    /** @param {string} name @param {number[]} args */
    const kernel32 = async(name, args)=>{
        const target = host.library?.('KERNEL32.dll')?.[name];
        if (!target)
        {
            throw new Error(`shell32: KERNEL32.dll!${name} is not there to build on`);
        }
        return /** @type {number} */ (await target.handler(args)) >>> 0;
    };
    /** @param {number} address */
    const readU32 = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        if ((address >>> 0) !== 0)
        {
            host.writeMemory(address >>> 0, dword(value));
        }
    };
    /** @param {number} address */
    const wide = address=>((address >>> 0) === 0 || !host.readWideString ? null
        : host.readWideString(address >>> 0, 0x8000));
    /** @param {number} address */
    const narrow = address=>((address >>> 0) === 0 ? null
        : host.readCString(address >>> 0, 0x8000));

    /**
     * A block of guest memory for the length of `body`; `failed` when there
     * is none to be had, which is the call's own out-of-memory answer.
     *
     * @template T
     * @param {number} size @param {(address: number) => Promise<T>} body @param {T} failed
     */
    const scratch = async(size, body, failed)=>{
        const at = host.allocate?.(size) ?? 0;
        if (!at)
        {
            return failed;
        }
        try
        {
            return await body(at);
        }
        finally
        {
            host.free?.(at);
        }
    };

    /**
     * DoEnvironmentSubst for either width: the string expanded into its own
     * buffer when the answer fits -- with a character to spare in the ANSI
     * spelling, as Windows documents -- and the length with TRUE; otherwise
     * the buffer as it was and its size with FALSE (Wine's
     * test_DoEnvironmentSubst).
     *
     * @param {boolean} isWide
     */
    const doEnvironmentSubst = isWide=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: async([buffer, size])=>{
            const room = size >>> 0;
            const unit = isWide ? 2 : 1;
            if ((buffer >>> 0) === 0)
            {
                return room & 0xffff;
            }
            return scratch(0x8000 * unit, async at=>{
                const needed = await kernel32(isWide ? 'ExpandEnvironmentStringsW'
                    : 'ExpandEnvironmentStringsA', [buffer, at, 0x8000]);
                const fits = needed !== 0 && (isWide ? needed <= room : needed < room);
                if (!fits)
                {
                    return room & 0xffff;
                }
                host.writeMemory(buffer >>> 0, host.readMemory(at, needed * unit).slice());
                return ((1 << 16) | (needed & 0xffff)) >>> 0;
            }, room & 0xffff);
        },
    });

    /**
     * SHGetFolderPathAndSubDir for either width: the folder's path, the
     * subdirectory under it, verified or made as the CSIDL's flags say.
     *
     * @param {boolean} isWide
     */
    const folderPathAndSubDir = isWide=>({
        argBytes: 24,
        /** @param {number[]} args */
        handler: async([window, csidl, token, flags, subDir, path])=>{
            if ((path >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const folder = parts.table[isWide ? 'SHGetFolderPathW' : 'SHGetFolderPathA'];
            const status = /** @type {number} */ (await folder.handler([window,
                (csidl & ~CSIDL_FLAG_CREATE) | CSIDL_FLAG_DONT_VERIFY, token, flags, path])) | 0;
            if (status < 0)
            {
                return status;
            }
            const base = (isWide ? wide(path) : narrow(path)) ?? '';
            const sub = (isWide ? wide(subDir) : narrow(subDir)) ?? '';
            const full = sub === '' || sub === '\\' ? base : `${base}\\${sub.replace(/^\\+/, '')}`;
            if (full.length >= MAX_PATH)
            {
                return fromWin32(ERROR_FILENAME_EXCED_RANGE);
            }
            if ((csidl & CSIDL_FLAG_CREATE) !== 0 && !exists(full))
            {
                await scratch(utf16z(full).length, async at=>{
                    host.writeMemory(at, utf16z(full));
                    await parts.table.SHCreateDirectoryExW.handler([0, at, 0]);
                }, undefined);
            }
            else if ((csidl & CSIDL_FLAG_DONT_VERIFY) === 0 && !exists(full))
            {
                return fromWin32(ERROR_PATH_NOT_FOUND);
            }
            host.writeMemory(path >>> 0, isWide ? utf16z(full)
                : Uint8Array.from(`${full}\0`, c=>c.charCodeAt(0) & 0xff));
            return S_OK;
        },
    });

    /**
     * An item id list for a path the volume has, or 0: ILCreateFromPath and
     * SHSimpleIDListFromPath alike.
     *
     * @param {string | null} path
     */
    const listForPath = path=>{
        if (path === null || path === '')
        {
            return 0;
        }
        const found = parse(path);
        return found === null ? 0 : listFor(found.text);
    };

    /** An image list's methods: only its size answers, nothing is drawn into it. */
    const imageListMethods = Object.freeze([
        ...IUNKNOWN_METHODS,
        ...['Add', 'ReplaceIcon', 'SetOverlayImage', 'Replace', 'AddMasked', 'Draw', 'Remove',
            'GetIcon', 'GetImageInfo', 'Copy', 'Merge', 'Clone', 'GetImageRect']
            .map(name=>({ name, argBytes: 4, invoke: ()=>E_NOTIMPL })),
        /** HRESULT GetIconSize(int *cx, int *cy) */
        { name: 'GetIconSize', argBytes: 12,
            invoke: (/** @type {any} */ object, /** @type {number[]} */ [cx, cy])=>{
                writeU32(cx, object.state.size);
                writeU32(cy, object.state.size);
                return S_OK;
            } },
        ...['SetIconSize', 'GetImageCount', 'SetImageCount', 'SetBkColor', 'GetBkColor',
            'BeginDrag', 'EndDrag', 'DragEnter', 'DragLeave', 'DragMove', 'SetDragCursorImage',
            'DragShowNolock', 'GetDragImage', 'GetItemFlags', 'GetOverlayImage']
            .map(name=>({ name, argBytes: 4, invoke: ()=>E_NOTIMPL })),
    ]);
    /**
     * @type {{ pointer: number, adapter: { addRef: () => number } }[]}
     * The system image lists, made the first time one is asked for.
     */
    const imageLists = [];
    /**
     * A system image list, and a reference for the caller when it is to own
     * one: SHGetImageList hands one out, Shell_GetImageLists does not.
     *
     * @param {number} index @param {boolean} [owned]
     */
    const imageList = (index, owned = false)=>{
        if (imageLists[index] === undefined && host.publish)
        {
            const adapter = createAdapter({ size: IMAGE_SIZES[index] },
                { [IID_IIMAGELIST]: imageListMethods, [IID_IIMAGELIST2]: imageListMethods });
            // The lists are the process's: one reference kept for as long as it runs.
            imageLists[index] = { pointer: host.publish(adapter, IID_IIMAGELIST) >>> 0, adapter };
        }
        const list = imageLists[index];
        if (list && owned)
        {
            list.adapter.addRef();
        }
        return list?.pointer ?? 0;
    };
    let toldImageLists = false;

    /** @type {string | null} What SetCurrentProcessExplicitAppUserModelID named. */
    let appUserModelId = null;

    /**
     * A string in task memory, which the caller frees with CoTaskMemFree; 0
     * when there is none to be had.
     *
     * @param {string} text
     */
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
     * A property store's methods over the values it was given, by key: a
     * scalar as it was, a string copied, any other type refused.
     */
    const propertyStoreMethods = Object.freeze([
        ...IUNKNOWN_METHODS,
        /** HRESULT GetCount(DWORD *cProps) */
        { name: 'GetCount', argBytes: 8,
            /** @param {any} object @param {number[]} args */
            invoke: (object, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, object.state.values.size);
                return S_OK;
            } },
        /** HRESULT GetAt(DWORD iProp, PROPERTYKEY *pkey) */
        { name: 'GetAt', argBytes: 12,
            /** @param {any} object @param {number[]} args */
            invoke: (object, [index, key])=>{
                const found = [...object.state.values.values()][index >>> 0];
                if (!found || (key >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                host.writeMemory(key >>> 0, found.key);
                return S_OK;
            } },
        /** HRESULT GetValue(REFPROPERTYKEY key, PROPVARIANT *pv) */
        { name: 'GetValue', argBytes: 12,
            /** @param {any} object @param {number[]} args */
            invoke: async(object, [key, value])=>{
                if ((key >>> 0) === 0 || (value >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const found = object.state.values.get(keyOf(key));
                const bytes = new Uint8Array(16);
                if (found?.text !== undefined)
                {
                    bytes.set(dword(VT_LPWSTR), 0);
                    bytes.set(dword(await taskString(found.text)), 8);
                }
                else if (found)
                {
                    bytes.set(found.bytes);
                }
                host.writeMemory(value >>> 0, bytes);
                return S_OK;
            } },
        /** HRESULT SetValue(REFPROPERTYKEY key, REFPROPVARIANT propvar) */
        { name: 'SetValue', argBytes: 12,
            /** @param {any} object @param {number[]} args */
            invoke: (object, [key, value])=>{
                if ((key >>> 0) === 0 || (value >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const bytes = host.readMemory(value >>> 0, 16).slice();
                const type = bytes[0] | bytes[1] << 8;
                const stored = { key: host.readMemory(key >>> 0, 20).slice(), bytes };
                if (type === VT_LPWSTR)
                {
                    object.state.values.set(keyOf(key),
                        { ...stored, text: wide(readU32(value + 8)) ?? '' });
                    return S_OK;
                }
                if (!SCALAR_TYPES.has(type))
                {
                    return E_NOTIMPL;
                }
                object.state.values.set(keyOf(key), stored);
                return S_OK;
            } },
        /** HRESULT Commit(void): the values are kept as they are set. */
        { name: 'Commit', argBytes: 4, invoke: ()=>S_OK },
    ]);
    /** @param {number} key  A PROPERTYKEY: its GUID and property id, as the store's own key. */
    const keyOf = key=>`${readGuid(host, key >>> 0)}/${readU32(key + 16)}`;


    /**
     * SHGetNewLinkInfo for either width: the name a shortcut to the target
     * would take in the directory -- its name with " - Shortcut", or
     * "Shortcut to " before it with SHGNLI_PREFIXNAME, then `.lnk` unless
     * SHGNLI_NOLNK, numbered past one that is there unless SHGNLI_NOUNIQUE.
     * A target that is not there has no shortcut (Wine's
     * test_sh_new_link_info); a shortcut's target is copied, not linked to.
     *
     * @param {boolean} isWide
     */
    const newLinkInfo = isWide=>({
        argBytes: 20,
        /** @param {number[]} args */
        handler: ([target, directory, out, mustCopy, flags])=>{
            writeU32(mustCopy, 0);
            const from = (flags & SHGNLI_PIDL) !== 0 ? null
                : isWide ? wide(target) : narrow(target);
            const into = isWide ? wide(directory) : narrow(directory);
            if (from === null || into === null || (out >>> 0) === 0 || !exists(from))
            {
                return 0;
            }
            const leaf = from.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? from;
            if (/\.lnk$/i.test(leaf))
            {
                writeU32(mustCopy, 1);
            }
            const stem = (flags & SHGNLI_PREFIXNAME) !== 0 ? `Shortcut to ${leaf}`
                : `${leaf} - Shortcut`;
            const extension = (flags & SHGNLI_NOLNK) !== 0 ? '' : '.lnk';
            const base = `${into.replace(/\\+$/, '')}\\${stem}`;
            const unique = (flags & SHGNLI_NOUNIQUE) === 0;
            let name = `${base}${extension}`;
            for (let n = 2; n < 0x10000; n++)
            {
                if (!unique || !exists(name))
                {
                    break;
                }
                name = `${base} (${n})${extension}`;
            }
            host.writeMemory(out >>> 0, isWide ? utf16z(name)
                : Uint8Array.from(`${name}\0`, c=>c.charCodeAt(0) & 0xff));
            return 1;
        },
    });

    /** The notifications registered, by the number SHChangeNotifyRegister answered. */
    const notifications = new Set();
    let nextNotification = 1;

    return {
        DoEnvironmentSubstA: doEnvironmentSubst(false),
        DoEnvironmentSubstW: doEnvironmentSubst(true),

        /**
         * HRESULT SHGetFolderPathAndSubDirA(HWND hwnd, int csidl, HANDLE hToken,
         *     DWORD dwFlags, LPCSTR pszSubDir, LPSTR pszPath)
         */
        SHGetFolderPathAndSubDirA: folderPathAndSubDir(false),
        SHGetFolderPathAndSubDirW: folderPathAndSubDir(true),

        /** PIDLIST_ABSOLUTE ILCreateFromPathA(PCSTR pszPath): NULL for a path not there. */
        ILCreateFromPathA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([path])=>listForPath(narrow(path)),
        },
        ILCreateFromPathW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([path])=>listForPath(wide(path)),
        },

        /**
         * PIDLIST_ABSOLUTE SHSimpleIDListFromPath(PCWSTR pszPath)
         *
         * The wide spelling, as on every NT: the list of the path, NULL for
         * one not there.
         */
        SHSimpleIDListFromPath: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([path])=>listForPath(wide(path)),
        },

        /**
         * HRESULT SHILCreateFromPath(PCWSTR pszPath, PIDLIST_ABSOLUTE *ppidl, DWORD *rgfInOut)
         */
        SHILCreateFromPath: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([path, out, attributes])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const found = parse(wide(path) ?? '');
                writeU32(out, 0);
                if (found === null)
                {
                    return fromWin32(2);
                }
                const list = listFor(found.text);
                writeU32(out, list);
                if ((attributes >>> 0) !== 0)
                {
                    writeU32(attributes, readU32(attributes) & found.attributes);
                }
                return list === 0 ? E_OUTOFMEMORY : S_OK;
            },
        },

        /**
         * HRESULT SHParseDisplayName(PCWSTR pszName, IBindCtx *pbc,
         *     PIDLIST_ABSOLUTE *ppidl, SFGAOF sfgaoIn, SFGAOF *psfgaoOut)
         *
         * The desktop folder's ParseDisplayName, the list in ppidl and the
         * attributes asked for in psfgaoOut.
         */
        SHParseDisplayName: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([name, , out, wanted, attributesOut])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                writeU32(attributesOut, 0);
                const text = wide(name);
                if (text === null)
                {
                    return E_INVALIDARG;
                }
                const found = parse(text);
                if (found === null)
                {
                    return fromWin32(2);
                }
                const list = listFor(found.text);
                writeU32(out, list);
                writeU32(attributesOut, (found.attributes & wanted) >>> 0);
                return list === 0 ? E_OUTOFMEMORY : S_OK;
            },
        },

        /**
         * HRESULT SHGetKnownFolderIDList(REFKNOWNFOLDERID rfid, DWORD dwFlags,
         *                                HANDLE hToken, PIDLIST_ABSOLUTE *ppidl)
         *
         * The CSIDL's list for a known folder this build has; E_INVALIDARG
         * for one it has not.
         */
        SHGetKnownFolderIDList: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([id, , token, out])=>{
                if ((out >>> 0) === 0 || (id >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const csidl = KNOWN_FOLDERS[/** @type {keyof typeof KNOWN_FOLDERS} */ (
                    readGuid(host, id >>> 0))];
                if (csidl === undefined)
                {
                    writeU32(out, 0);
                    return E_INVALIDARG;
                }
                return parts.table.SHGetFolderLocation.handler([0, csidl, token, 0, out]);
            },
        },

        /**
         * BOOL ReadCabinetState(CABINETSTATE *pcs, int cLength)
         *
         * The defaults Explorer starts with, no setting having been saved:
         * FALSE, which says so, with the structure filled.
         */
        ReadCabinetState: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([state, length])=>{
                if ((state >>> 0) === 0 || (length | 0) < CABINETSTATE_SIZE)
                {
                    return 0;
                }
                const bytes = new Uint8Array(CABINETSTATE_SIZE);
                const view = new DataView(bytes.buffer);
                view.setUint16(0, CABINETSTATE_SIZE, true);
                view.setUint16(2, CABINETSTATE_VERSION, true);
                // fNewWindowMode off, fDontPrettyNames off, fShowCompColor and
                // fShowAllObjects as a fresh install: the menu's full paths
                // off, file names shown with their case.
                view.setUint16(4, 0x0002 | 0x0004, true);
                view.setUint32(8, 0, true);
                host.writeMemory(state >>> 0, bytes);
                return 0;
            },
        },

        /**
         * HRESULT SHGetImageList(int iImageList, REFIID riid, void **ppvObj)
         *
         * The process's system image list of that size, the same object
         * each time. It answers its size; holding no icons, it draws
         * nothing, and a HIMAGELIST call on it is not comctl32's list.
         */
        /**
         * HRESULT SetCurrentProcessExplicitAppUserModelID(PCWSTR AppID)
         *
         * The name the taskbar would group the process's windows under, kept
         * for the getter.
         */
        SetCurrentProcessExplicitAppUserModelID: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([id])=>{
                const text = wide(id);
                if (text === null)
                {
                    return E_INVALIDARG;
                }
                appUserModelId = text;
                return S_OK;
            },
        },

        /**
         * HRESULT GetCurrentProcessExplicitAppUserModelID(PWSTR *AppID)
         *
         * The name the setter gave, in task memory; E_FAIL with a null until
         * one was (Wine's test_GetCurrentProcessExplicitAppUserModelID).
         */
        GetCurrentProcessExplicitAppUserModelID: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: async([out])=>{
                writeU32(out, 0);
                if (appUserModelId === null)
                {
                    return E_FAIL;
                }
                const at = await taskString(appUserModelId);
                writeU32(out, at);
                return at ? S_OK : E_OUTOFMEMORY;
            },
        },

        /**
         * HRESULT SHGetPropertyStoreForWindow(HWND hwnd, REFIID riid, void **ppv)
         *
         * A property store for the window, through IUnknown or
         * IPropertyStore; any other interface is E_NOINTERFACE with a null
         * (Wine's test_SHGetPropertyStoreForWindow). Nothing reads what is
         * set in it: there is no taskbar to group or label the window by it.
         */
        SHGetPropertyStoreForWindow: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([, riid, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                const iid = (riid >>> 0) === 0 ? null : readGuid(host, riid >>> 0);
                if (iid !== IID_IUNKNOWN && iid !== IID_IPROPERTYSTORE)
                {
                    return E_NOINTERFACE;
                }
                if (!host.publish)
                {
                    return E_OUTOFMEMORY;
                }
                const adapter = createAdapter({ values: new Map() },
                    { [IID_IPROPERTYSTORE]: propertyStoreMethods });
                const pointer = host.publish(adapter, IID_IPROPERTYSTORE) >>> 0;
                writeU32(out, pointer);
                return pointer ? S_OK : E_OUTOFMEMORY;
            },
        },

        /**
         * HRESULT SHGetStockIconInfo(SHSTOCKICONID siid, UINT uFlags, SHSTOCKICONINFO *psii)
         *
         * Where a stock icon is: in the shell's library, at the id's own
         * number, that library holding no icons here to number otherwise. No
         * handle and no system image index -- -1 -- for there is no picture;
         * an id out of range is E_INVALIDARG with both indexes -1, as is a
         * structure of any other size (Wine's test_SHGetStockIconInfo).
         */
        SHGetStockIconInfo: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: async([id, flags, info])=>{
                if ((info >>> 0) === 0 || readU32(info) !== SHSTOCKICONINFO_SIZE)
                {
                    return E_INVALIDARG;
                }
                writeU32(info + 4, 0);
                writeU32(info + 8, -1);
                writeU32(info + 12, -1);
                if ((id | 0) < 0 || (id | 0) >= SIID_MAX_ICONS)
                {
                    return E_INVALIDARG;
                }
                if (((flags >>> 0) & SHGSI_ICON) !== 0)
                {
                    host.divergence?.('SHGetStockIconInfo',
                        'the shell\'s library holds no icons: no handle');
                }
                const system = await scratch(MAX_PATH * 2, async at=>{
                    const length = await kernel32('GetSystemDirectoryW', [at, MAX_PATH]);
                    return length > 0 && length < MAX_PATH ? wide(at) : null;
                }, null);
                const path = system === null ? 'shell32.dll' : `${system}\\shell32.dll`;
                host.writeMemory(info + 16, utf16z(path.slice(0, MAX_PATH - 1)));
                writeU32(info + 12, id | 0);
                return S_OK;
            },
        },

        SHGetImageList: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([index, riid, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                const iid = (riid >>> 0) === 0 ? null : readGuid(host, riid >>> 0);
                if ((index >>> 0) >= IMAGE_SIZES.length)
                {
                    return E_INVALIDARG;
                }
                if (iid !== IID_IIMAGELIST && iid !== IID_IIMAGELIST2)
                {
                    return E_NOINTERFACE;
                }
                const list = imageList(index >>> 0, true);
                if (!list)
                {
                    return E_OUTOFMEMORY;
                }
                if (!toldImageLists)
                {
                    toldImageLists = true;
                    host.divergence?.('SHGetImageList', 'the system image lists hold no icons');
                }
                writeU32(out, list);
                return S_OK;
            },
        },

        /** BOOL Shell_GetImageLists(HIMAGELIST *phiml, HIMAGELIST *phimlSmall) */
        Shell_GetImageLists: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([large, small])=>{
                writeU32(large, imageList(0));
                writeU32(small, imageList(1));
                return imageList(0) && imageList(1) ? 1 : 0;
            },
        },

        /**
         * ULONG SHChangeNotifyRegister(HWND hwnd, int fSources, LONG fEvents, UINT wMsg,
         *                              int cEntries, const SHChangeNotifyEntry *pshcne)
         *
         * A registration, numbered; nothing on this machine changes the shell
         * behind a program's back, so no message ever comes of it.
         */
        SHChangeNotifyRegister: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([window, , , , count, entries])=>{
                if ((count | 0) <= 0 || (entries >>> 0) === 0 || (window >>> 0) === 0)
                {
                    return 0;
                }
                const id = nextNotification++;
                notifications.add(id);
                return id;
            },
        },

        /** BOOL SHChangeNotifyDeregister(ULONG ulID) */
        SHChangeNotifyDeregister: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([id])=>(notifications.delete(id >>> 0) ? 1 : 0),
        },

        /**
         * HANDLE SHChangeNotification_Lock(HANDLE hChange, DWORD dwProcId,
         *                                  PIDLIST_ABSOLUTE **pppidl, LONG *plEvent)
         *
         * There being no notification, there is nothing to lock: NULL.
         */
        SHChangeNotification_Lock: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, , lists, event])=>{
                writeU32(lists, 0);
                writeU32(event, 0);
                return 0;
            },
        },

        /** BOOL SHChangeNotification_Unlock(HANDLE hLock) */
        SHChangeNotification_Unlock: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([lock])=>((lock >>> 0) === 0 ? 0 : 1),
        },

        /**
         * HRESULT SHOpenFolderAndSelectItems(PCIDLIST_ABSOLUTE pidlFolder, UINT cidl,
         *                                    PCUITEMID_CHILD_ARRAY apidl, DWORD dwFlags)
         *
         * There is no Explorer window to open; a folder is required, as it is
         * on Windows, and the call is taken as done.
         */
        SHOpenFolderAndSelectItems: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([folder])=>((folder >>> 0) === 0 ? E_INVALIDARG : S_OK),
        },

        /**
         * HRESULT SHLimitInputEdit(HWND hwndEdit, IShellFolder *psf)
         *
         * Limits an edit control to the characters a name in the folder may
         * have. The edit control keeps whatever is typed in it here: E_NOTIMPL.
         */
        SHLimitInputEdit: {
            argBytes: 8,
            handler: ()=>E_NOTIMPL,
        },

        /**
         * HRESULT SHCreateShellFolderView(const SFV_CREATE *pcsfv, IShellView **ppsv)
         *
         * There is no shell view to make: E_NOTIMPL, a null where it would go.
         */
        SHCreateShellFolderView: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([create, out])=>{
                writeU32(out, 0);
                return (create >>> 0) === 0 || (out >>> 0) === 0 ? E_INVALIDARG : E_NOTIMPL;
            },
        },

        /**
         * HRESULT SHCreateItemFromParsingName(PCWSTR pszPath, IBindCtx *pbc, REFIID riid,
         *                                     void **ppv)
         *
         * There is no IShellItem here: E_NOTIMPL, a null where it would go.
         */
        SHCreateItemFromParsingName: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([, , , out])=>{
                writeU32(out, 0);
                return E_NOTIMPL;
            },
        },

        /**
         * BOOL SHGetNewLinkInfoA(LPCSTR pszLinkTo, LPCSTR pszDir, LPSTR pszName,
         *                        BOOL *pfMustCopy, UINT uFlags)
         */
        SHGetNewLinkInfoA: newLinkInfo(false),
        SHGetNewLinkInfoW: newLinkInfo(true),

        /**
         * UINT Shell_MergeMenus(HMENU hmDst, HMENU hmSrc, UINT uInsert, UINT uIDAdjust,
         *                       UINT uIDAdjustMax, ULONG uFlags)
         *
         * Nothing merged: the highest id is the adjustment, as for an empty
         * source menu.
         */
        Shell_MergeMenus: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([, , , adjust])=>adjust >>> 0,
        },
    };
}

