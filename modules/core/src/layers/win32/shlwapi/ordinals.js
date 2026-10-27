/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The shlwapi exports a program reaches by number: the shell's own helpers
 * that shlwapi.h never declared -- shared memory handed between processes, a
 * small growable array, a DISPPARAMS packed from varargs, a window's style
 * bits, a date and time as Explorer prints them, the shell's registry keys and
 * a worker window. Each is built on the libraries beside it (kernel32,
 * user32, advapi32), called with guest memory as a program would call them,
 * so a handle, a window or a key here is the same object the program sees
 * through those libraries.
 */

import { encodeAnsi } from '../kernel32/locale.js';
import { GUID_NULL, parseGuid } from '../ole32/guid.js';
import { dword, u32 } from './text.js';

/**
 * Each is [ordinal, name]: the number a program imports the function by.
 *
 * @type {readonly (readonly [number, string])[]}
 */
export const SHLWAPI_NAMED_ORDINALS = Object.freeze([
    [1, 'ParseURLA'], [2, 'ParseURLW'], [7, 'SHAllocShared'], [8, 'SHLockShared'],
    [9, 'SHUnlockShared'], [10, 'SHFreeShared'],
    [11, 'SHMapHandle'], [12, 'SHCreateMemStream'], [14, 'GetAcceptLanguagesA'],
    [15, 'GetAcceptLanguagesW'],
    [165, 'SHSetWindowBits'], [167, 'SHSetParentHwnd'], [198, 'SHSearchMapInt'],
    [208, 'FDSA_Initialize'], [209, 'FDSA_Destroy'], [210, 'FDSA_InsertItem'],
    [211, 'FDSA_DeleteItem'], [257, 'SHCreateWorkerWindowA'], [269, 'GUIDFromStringA'],
    [282, 'SHPackDispParams'], [294, 'SHGetIniStringW'], [295, 'SHSetIniStringW'],
    [353, 'SHFormatDateTimeA'], [354, 'SHFormatDateTimeW'], [476, 'SHGetObjectCompatFlags'],
    [168, 'ConnectToConnectionPoint'], [175, 'IUnknown_GetClassID'],
    [283, 'IConnectionPoint_InvokeWithCancel'], [284, 'IConnectionPoint_SimpleInvoke'],
    [484, 'IUnknown_QueryServiceExec'], [496, 'SHPropertyBag_ReadLONG'],
    [514, 'IUnknown_ProfferService'], [491, 'SHGetShellKey'], [516, 'SKGetValueW'],
    [517, 'SKSetValueW'], [518, 'SKDeleteValueW'],
    [519, 'SKAllocValueW'],
]);

const S_OK = 0;
const E_FAIL = 0x80004005 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
/** HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER). */
const E_NOT_SUFFICIENT_BUFFER = 0x8007007a | 0;

const ERROR_SUCCESS = 0;

const INVALID_HANDLE_VALUE = 0xffffffff;
const PAGE_READWRITE = 0x04;
const FILE_MAP_ALL_ACCESS = 0x000f001f;
const PROCESS_DUP_HANDLE = 0x0040;
const DUPLICATE_CLOSE_SOURCE = 0x1;
const DUPLICATE_SAME_ACCESS = 0x2;
const LMEM_ZEROINIT = 0x40;

const HKEY_CURRENT_USER = 0x80000001;
const HKEY_LOCAL_MACHINE = 0x80000002;
const KEY_READ = 0x20019;
const KEY_ALL_ACCESS = 0xf003f;

const GWL_STYLE = -16;
const WS_POPUP = 0x80000000;
const WS_CHILD = 0x40000000;
const WS_EX_WINDOWEDGE = 0x00000100;
const GWLP_WNDPROC = -4;
const IDC_ARROW = 32512;

const LOCALE_USER_DEFAULT = 0x0400;
const LOCALE_SISO639LANGNAME = 0x59;
const LOCALE_SISO3166CTRYNAME = 0x5a;
const DATE_SHORTDATE = 0x1;
const DATE_LONGDATE = 0x2;
const TIME_NOSECONDS = 0x2;

/** SHFormatDateTime's flags (shlwapi.h FDTF_*). */
const FDTF_SHORTTIME = 0x1;
const FDTF_SHORTDATE = 0x2;
const FDTF_LONGDATE = 0x4;
const FDTF_LONGTIME = 0x8;
const FDTF_DEFAULT = FDTF_SHORTDATE | FDTF_SHORTTIME;

/** VARIANT's types whose value is two words on the stack and in the variant. */
const VT_EMPTY = 0;
const VT_I4 = 3;
const WIDE_VARIANTS = new Set([5, 6, 7, 20, 21]);
const VARIANT_SIZE = 16;
/** The most varargs SHPackDispParams reads: pairs of type and value, each two words wide. */
const PACK_MOST = 16;

/** FDSA_info: the items in it, the array, its room, the growth step, an item's size, flags. */
const FDSA = Object.freeze({ count: 0, mem: 4, room: 8, inc: 12, size: 13, flags: 14 });
/** FDSA_info.flags: the array is one shlwapi allocated, not the caller's. */
const FDSA_FLAG_OWN = 0x1;

/** SHGetShellKey's flags: the root in the low nibble, the key above it. */
const SHKEY_Root_HKCU = 0x1;
const SHKEY_Root_HKLM = 0x2;
const SHELL_KEYS = Object.freeze({
    0x00: 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer',
    0x10: 'Software\\Microsoft\\Windows\\Shell',
    0x20: 'Software\\Microsoft\\Windows\\ShellNoRoam',
    0x30: 'Software\\Classes',
});

const COMPAT_OBJECTS = 'Software\\Microsoft\\Windows\\CurrentVersion\\ShellCompatibility\\Objects';
/** The value names SHGetObjectCompatFlags reads under an object's key, and the bit each sets. */
const COMPAT_FLAGS = Object.freeze({
    OTNEEDSSFCACHE: 0x1, NO_WEBVIEW: 0x2, UNBINDABLE: 0x4, PINDLL: 0x8,
    NEEDSFILESYSANCESTOR: 0x10, NOTAFILESYSTEM: 0x20, CTXMENU_NOVERBS: 0x40,
    CTXMENU_LIMITEDQI: 0x80, COCREATESHELLFOLDERONLY: 0x100, NEEDSSTORAGEANCESTOR: 0x200,
    NOLEGACYWEBVIEW: 0x400, CTXMENU_XPQCMFLAGS: 0x1000, NOIPROPERTYSTORE: 0x2000,
});

const E_NOTIMPL = 0x80004001 | 0;
const DISP_E_BADVARTYPE = 0x80020008 | 0;
const DISPATCH_METHOD = 0x1;
const VT_BYREF = 0x4000;

/** The interfaces the COM helpers ask an object for, in the order they are laid out in scratch. */
const IIDS = Object.freeze({
    null: GUID_NULL,
    serviceProvider: '{6D5140C1-7436-11CE-8034-00AA006009FA}',
    commandTarget: '{B722BCCB-4E68-101B-A2BC-00AA00404770}',
    profferService: '{CB728B20-F786-11CE-92AD-00AA00A74CD0}',
    persist: '{0000010C-0000-0000-C000-000000000046}',
    persistFolder: '{000214EA-0000-0000-C000-000000000046}',
    container: '{B196B284-BAB4-101A-B69C-00AA00341D07}',
    dispatch: '{00020400-0000-0000-C000-000000000046}',
});
const IID_ORDER = /** @type {(keyof typeof IIDS)[]} */ (Object.keys(IIDS));

/** Each method's place in its interface's vtable, IUnknown's three first. */
const SLOT = Object.freeze({
    QueryInterface: 0, Release: 2,
    QueryService: 3, Exec: 4, ProfferService: 3, RevokeService: 4, GetClassID: 3,
    FindConnectionPoint: 4, Advise: 5, Unadvise: 6, EnumConnections: 7, Next: 3,
    Invoke: 6, Read: 3,
});

const ACCEPT_LANGUAGE_KEY = 'Software\\Microsoft\\Internet Explorer\\International';

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

/** @param {number} value */
const word = value=>Uint8Array.of(value & 0xff, (value >>> 8) & 0xff);

/**
 * @typedef {Record<string, { handler: (args: number[]) => any }>} Exports
 *
 * @typedef {Object} OrdinalHost
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} [readWideString]
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [free]
 * @property {(code: number) => void} [setLastError]
 * @property {(library: string) => Exports | undefined} [library]
 * @property {(steps: Generator<{ entry: number, args: number[] }, number, number>) => any} [drive]
 *           Runs a handler's calls into the guest one after another: the COM
 *           helpers call methods of the program's own objects.
 */

/**
 * @param {OrdinalHost} host
 * @returns {Record<string, { argBytes: number, convention?: 'cdecl',
 *     handler: (args: number[]) => any }>}
 */
export function createOrdinalFunctions(host){
    /**
     * Another library's function, called with the arguments a program would
     * pass; what it answers, which an asynchronous one answers later.
     *
     * @param {string} library @param {string} name @param {number[]} args
     */
    const call = async(library, name, args)=>{
        const target = host.library?.(library)?.[name];
        if (!target)
        {
            throw new Error(`shlwapi: ${library}!${name} is not there to build on`);
        }
        return /** @type {number} */ (await target.handler(args)) | 0;
    };
    /** @param {string} name @param {number[]} args */
    const kernel32 = (name, args)=>call('KERNEL32.dll', name, args);
    /** @param {string} name @param {number[]} args */
    const user32 = (name, args)=>call('USER32.dll', name, args);
    /** @param {string} name @param {number[]} args */
    const advapi32 = async(name, args)=>(await call('ADVAPI32.dll', name, args)) >>> 0;

    /**
     * A block of guest memory for the length of `body`, holding `bytes`
     * first when they are given.
     *
     * @template T
     * @param {number | Uint8Array} what  Its size, or what it starts with.
     * @param {(address: number) => Promise<T>} body
     * @returns {Promise<T>}
     */
    const scratch = async(what, body)=>{
        const size = typeof what === 'number' ? what : what.length;
        const address = host.allocate?.(Math.max(size, 4)) ?? 0;
        if (!address)
        {
            throw new Error('shlwapi: no memory for a call\'s scratch');
        }
        try
        {
            host.writeMemory(address, typeof what === 'number' ? new Uint8Array(size) : what);
            return await body(address);
        }
        finally
        {
            host.free?.(address);
        }
    };
    /**
     * Guest bytes; zeros in a build that cannot read them, where every
     * caller of these has failed long before.
     *
     * @param {number} address @param {number} length
     */
    const readBytes = (address, length)=>(host.readMemory
        ? host.readMemory(address, length) : new Uint8Array(length));
    /** @param {number} address */
    const readU32 = address=>u32(readBytes(address >>> 0, 4));
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>host.writeMemory(address >>> 0, dword(value));
    /** @param {number} address */
    const wideAt = address=>((address >>> 0) === 0 || !host.readWideString ? null
        : host.readWideString(address >>> 0, 0x10000));

    /**
     * A handle of another process brought into this one, or this one's own
     * handle when the process is this one.
     *
     * @param {number} handle @param {number} from @param {number} to @param {number} access
     * @param {number} options
     */
    const duplicate = async(handle, from, to, access, options)=>{
        const self = (await kernel32('GetCurrentProcessId', [])) >>> 0;
        /** @param {number} id */
        const open = async id=>((id >>> 0) === self ? kernel32('GetCurrentProcess', [])
            : kernel32('OpenProcess', [PROCESS_DUP_HANDLE, 0, id]));
        const source = await open(from);
        const target = await open(to);
        try
        {
            if (!source || !target)
            {
                return 0;
            }
            return await scratch(4, async out=>((await kernel32('DuplicateHandle', [source, handle,
                target, out, access, 0, options | (access === 0 ? DUPLICATE_SAME_ACCESS : 0)]))
                ? readU32(out) : 0));
        }
        finally
        {
            for (const [id, handleOf] of [[from, source], [to, target]])
            {
                if ((id >>> 0) !== self && handleOf)
                {
                    await kernel32('CloseHandle', [handleOf]);
                }
            }
        }
    };
    /** @param {number} process */
    const isSelf = async process=>
        (process >>> 0) === (await kernel32('GetCurrentProcessId', [])) >>> 0;

    /**
     * An item's place in an FDSA, and its bytes there.
     *
     * @param {number} info
     */
    const fdsa = info=>{
        const bytes = readBytes(info >>> 0, 16);
        return {
            count: u32(bytes, FDSA.count), mem: u32(bytes, FDSA.mem), room: u32(bytes, FDSA.room),
            inc: bytes[FDSA.inc], size: bytes[FDSA.size], flags: bytes[FDSA.flags],
        };
    };

    /**
     * A shell key: the root the flags name, the key under it, and the subkey
     * the caller names under that; null for no root or no such key.
     *
     * @param {number} flags @param {number} subKey  A wide string, or null.
     * @param {boolean} create
     */
    const shellKey = async(flags, subKey, create)=>{
        const root = (flags & 0xf) === SHKEY_Root_HKCU ? HKEY_CURRENT_USER
            : (flags & 0xf) === SHKEY_Root_HKLM ? HKEY_LOCAL_MACHINE : 0;
        const base = SHELL_KEYS[/** @type {0 | 16 | 32 | 48} */ (flags & 0xf0)];
        if (!root || base === undefined)
        {
            return 0;
        }
        const name = wideAt(subKey);
        const path = name ? `${base}\\${name}` : base;
        return scratch(utf16z(path).length + 4, async at=>{
            host.writeMemory(at + 4, utf16z(path));
            const status = create
                ? await advapi32('RegCreateKeyExW',
                    [root, at + 4, 0, 0, 0, KEY_ALL_ACCESS, 0, at, 0])
                : await advapi32('RegOpenKeyExW', [root, at + 4, 0, KEY_ALL_ACCESS, at]);
            if (status !== ERROR_SUCCESS)
            {
                host.setLastError?.(status);
                return 0;
            }
            return readU32(at);
        });
    };
    /** @param {number} status */
    const fromWin32 = status=>(status === 0 ? S_OK : ((status & 0xffff) | 0x80070000) | 0);

    /**
     * A date and time as Explorer prints them: the local date the flags ask
     * for, then the time, a space between (Wine's test_SHFormatDateTimeA).
     *
     * @param {number} fileTime @param {number} flagsAt
     */
    const formatDateTime = async(fileTime, flagsAt)=>{
        const flags = (flagsAt >>> 0) === 0 ? FDTF_DEFAULT : readU32(flagsAt);
        return scratch(8 + 16 + 2 * 128, async at=>{
            if (!await kernel32('FileTimeToLocalFileTime', [fileTime, at])
                || !await kernel32('FileTimeToSystemTime', [at, at + 8]))
            {
                return null;
            }
            const text = at + 24;
            const parts = [];
            const dateFlags = (flags & FDTF_LONGDATE) !== 0 ? DATE_LONGDATE
                : (flags & FDTF_SHORTDATE) !== 0 ? DATE_SHORTDATE : 0;
            if (dateFlags !== 0 && await kernel32('GetDateFormatW',
                [LOCALE_USER_DEFAULT, dateFlags, at + 8, 0, text, 128]))
            {
                parts.push(wideAt(text) ?? '');
            }
            if ((flags & (FDTF_LONGTIME | FDTF_SHORTTIME)) !== 0 && await kernel32('GetTimeFormatW',
                [LOCALE_USER_DEFAULT, (flags & FDTF_LONGTIME) !== 0 ? 0 : TIME_NOSECONDS, at + 8, 0,
                    text, 128]))
            {
                parts.push(wideAt(text) ?? '');
            }
            return parts.join(' ');
        });
    };
    /** @param {boolean} wide */
    const shFormatDateTime = wide=>({
        argBytes: 16,
        /** @param {number[]} args */
        handler: async([fileTime, flags, buffer, room])=>{
            if ((buffer >>> 0) === 0 || (room | 0) <= 0 || (fileTime >>> 0) === 0)
            {
                return 0;
            }
            const text = await formatDateTime(fileTime, flags);
            if (text === null)
            {
                return 0;
            }
            const cut = text.slice(0, (room | 0) - 1);
            host.writeMemory(buffer >>> 0, wide ? utf16z(cut) : encodeAnsi(`${cut}\0`));
            return cut.length + 1;
        },
    });

    /** The language the user's locale names, as an Accept-Language entry: "en-US". */
    const defaultLanguage = ()=>scratch(32, async at=>{
        const language = await kernel32('GetLocaleInfoA',
            [LOCALE_USER_DEFAULT, LOCALE_SISO639LANGNAME, at, 16]);
        const country = await kernel32('GetLocaleInfoA',
            [LOCALE_USER_DEFAULT, LOCALE_SISO3166CTRYNAME, at + 16, 16]);
        return language ? host.readCString(at, 16) + (country ? `-${host.readCString(at + 16, 16)}`
            : '') : 'en';
    });

    /**
     * GetAcceptLanguages for either width: the user's AcceptLanguage value
     * under Internet Explorer's International key, or the locale's language
     * when there is none. A buffer too small is E_NOT_SUFFICIENT_BUFFER with
     * nothing counted, as Windows 7 answers; a null buffer is the length the
     * text needs (Wine's test_GetAcceptLanguagesA).
     *
     * @param {boolean} wide
     */
    const getAcceptLanguages = wide=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: async([buffer, countAt])=>{
            if ((countAt >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const room = readU32(countAt);
            if ((buffer >>> 0) !== 0 && room === 0)
            {
                return E_INVALIDARG;
            }
            const stored = await scratch(2 * ACCEPT_LANGUAGE_KEY.length + 8 + 0x400, async at=>{
                const key = encodeAnsi(`${ACCEPT_LANGUAGE_KEY}\0`);
                host.writeMemory(at + 8, key);
                if (await advapi32('RegOpenKeyExA', [HKEY_CURRENT_USER, at + 8, 0, KEY_READ, at])
                    !== ERROR_SUCCESS)
                {
                    return null;
                }
                const handle = readU32(at);
                const name = at + 8 + key.length;
                host.writeMemory(name, encodeAnsi('AcceptLanguage\0'));
                const data = name + 16;
                writeU32(at + 4, 0x3f0);
                const status = await advapi32('RegQueryValueExA',
                    [handle, name, 0, 0, data, at + 4]);
                await advapi32('RegCloseKey', [handle]);
                return status === ERROR_SUCCESS ? host.readCString(data, 0x3f0) : null;
            });
            const text = stored ?? await defaultLanguage();
            if ((buffer >>> 0) === 0)
            {
                writeU32(countAt, text.length);
                return S_OK;
            }
            if (text.length >= room)
            {
                writeU32(countAt, 0);
                return E_NOT_SUFFICIENT_BUFFER;
            }
            host.writeMemory(buffer >>> 0, wide ? utf16z(text) : encodeAnsi(`${text}\0`));
            writeU32(countAt, text.length);
            return S_OK;
        },
    });

    /**
     * A COM method of a guest object, called from a handler's steps; what it
     * answered.
     *
     * @param {number} object @param {number} slot @param {number[]} args
     * @returns {Generator<{ entry: number, args: number[] }, number, number>}
     */
    function* method(object, slot, ...args){
        const entry = readU32(readU32(object) + slot * 4);
        return yield { entry, args: [object >>> 0, ...args] };
    }
    /** @param {number} object @param {number} iid @param {number} out */
    const queryInterface = (object, iid, out)=>method(object, SLOT.QueryInterface, iid, out);
    /** @param {number} object */
    const release = object=>method(object, SLOT.Release);

    /**
     * Steps over scratch that holds the interfaces' IIDs and room for the
     * pointers the calls hand back, freed when the steps end. Without a way
     * to call the guest, nothing of the program's is called: E_NOTIMPL, as
     * Windows 8 answers the helpers that are not there.
     *
     * @param {(iid: (name: keyof typeof IIDS) => number, out: number) =>
     *     Generator<{ entry: number, args: number[] }, number, number>} body
     */
    const withObjects = body=>{
        if (!host.drive || !host.allocate)
        {
            return E_NOTIMPL;
        }
        const room = IID_ORDER.length * 16 + 64;
        const block = host.allocate(room);
        if (!block)
        {
            return E_OUTOFMEMORY;
        }
        const bytes = new Uint8Array(room);
        IID_ORDER.forEach((name, index)=>bytes.set(/** @type {Uint8Array} */ (
            parseGuid(IIDS[name])), index * 16));
        host.writeMemory(block, bytes);
        const iid = (/** @type {keyof typeof IIDS} */ name)=>block + IID_ORDER.indexOf(name) * 16;
        const out = block + IID_ORDER.length * 16;
        function* steps(){
            try
            {
                return yield* body(iid, out);
            }
            finally
            {
                host.free?.(block);
            }
        }
        return host.drive(steps());
    };

    /**
     * Calls IDispatch::Invoke on every sink a connection point lists, each
     * with the same arguments; S_OK when it has called them all.
     *
     * @param {number} point @param {number} dispId @param {number} params
     */
    const invokeSinks = (point, dispId, params)=>withObjects(function* (iid, out){
        if ((point >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        // An empty DISPPARAMS for none: Invoke is never handed NULL.
        const args = (params >>> 0) === 0 ? out + 32 : params >>> 0;
        if ((params >>> 0) === 0)
        {
            host.writeMemory(args, new Uint8Array(16));
        }
        if ((yield* method(point, SLOT.EnumConnections, out)) < 0)
        {
            return S_OK;
        }
        const enumerator = readU32(out);
        try
        {
            for (;;)
            {
                host.writeMemory(out + 8, new Uint8Array(12));
                if ((yield* method(enumerator, SLOT.Next, 1, out + 8, out + 16)) !== S_OK)
                {
                    break;
                }
                const sink = readU32(out + 8);
                if (sink === 0)
                {
                    continue;
                }
                host.writeMemory(out + 4, dword(0));
                if ((yield* queryInterface(sink, iid('dispatch'), out + 4)) >= 0
                    && readU32(out + 4))
                {
                    const dispatch = readU32(out + 4);
                    yield* method(dispatch, SLOT.Invoke, dispId, iid('null'), 0, DISPATCH_METHOD,
                        args, 0, 0, 0);
                    yield* release(dispatch);
                }
                yield* release(sink);
            }
        }
        finally
        {
            yield* release(enumerator);
        }
        return S_OK;
    });

    return {
        /**
         * HRESULT ConnectToConnectionPoint(IUnknown *lpUnkSink, REFIID riid, BOOL fConnect,
         *     IUnknown *lpUnknown, LPDWORD lpCookie, IConnectionPoint **lppCP)
         *
         * The sink advised on, or unadvised from, the container's point for
         * the interface; the point handed back when asked for, else released.
         */
        ConnectToConnectionPoint: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([sink, riid, connect, unknown, cookie, pointOut])=>{
                if ((pointOut >>> 0) !== 0)
                {
                    writeU32(pointOut, 0);
                }
                if ((unknown >>> 0) === 0)
                {
                    return E_FAIL;
                }
                return withObjects(function* (iid, out){
                    let status = yield* queryInterface(unknown, iid('container'), out);
                    if (status < 0)
                    {
                        return status;
                    }
                    const container = readU32(out);
                    status = yield* method(container, SLOT.FindConnectionPoint, riid, out + 4);
                    yield* release(container);
                    if (status < 0)
                    {
                        return status;
                    }
                    const point = readU32(out + 4);
                    status = (connect | 0) !== 0
                        ? yield* method(point, SLOT.Advise, sink, cookie)
                        : yield* method(point, SLOT.Unadvise,
                            (cookie >>> 0) === 0 ? 0 : readU32(cookie));
                    if (status < 0 || (pointOut >>> 0) === 0)
                    {
                        yield* release(point);
                    }
                    else
                    {
                        writeU32(pointOut, point);
                    }
                    return status;
                });
            },
        },

        /**
         * HRESULT IConnectionPoint_SimpleInvoke(IConnectionPoint *iCP, DISPID dispId,
         *                                       DISPPARAMS *dispParams)
         */
        IConnectionPoint_SimpleInvoke: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([point, dispId, params])=>invokeSinks(point, dispId, params),
        },

        /**
         * HRESULT IConnectionPoint_InvokeWithCancel(IConnectionPoint *iCP, DISPID dispId,
         *     DISPPARAMS *dispParams, DWORD unknown1, DWORD unknown2)
         */
        IConnectionPoint_InvokeWithCancel: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([point, dispId, params])=>invokeSinks(point, dispId, params),
        },

        /**
         * HRESULT IUnknown_QueryServiceExec(IUnknown *lpUnknown, REFIID service,
         *     const GUID *group, DWORD cmdId, DWORD cmdOpt, VARIANT *pIn, VARIANT *pOut)
         *
         * The object's service provider asked for the service's command
         * target, and its Exec called with the rest.
         */
        IUnknown_QueryServiceExec: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([unknown, service, group, command, options, input, output])=>{
                if ((unknown >>> 0) === 0)
                {
                    return E_FAIL;
                }
                return withObjects(function* (iid, out){
                    let status = yield* queryInterface(unknown, iid('serviceProvider'), out);
                    if (status < 0)
                    {
                        return status;
                    }
                    const provider = readU32(out);
                    status = yield* method(provider, SLOT.QueryService, service,
                        iid('commandTarget'), out + 4);
                    yield* release(provider);
                    if (status < 0)
                    {
                        return status;
                    }
                    const target = readU32(out + 4);
                    status = yield* method(target, SLOT.Exec, group, command, options, input,
                        output);
                    yield* release(target);
                    return status;
                });
            },
        },

        /**
         * HRESULT IUnknown_ProfferService(IUnknown *lpUnknown, REFGUID service,
         *                                 IServiceProvider *pService, DWORD *pCookie)
         *
         * The service offered through the object's IProfferService, or, for
         * no service, the one the cookie names revoked and the cookie cleared.
         */
        IUnknown_ProfferService: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([unknown, service, provided, cookie])=>{
                if ((unknown >>> 0) === 0)
                {
                    return E_FAIL;
                }
                return withObjects(function* (iid, out){
                    let status = yield* queryInterface(unknown, iid('serviceProvider'), out);
                    if (status < 0)
                    {
                        return status;
                    }
                    const provider = readU32(out);
                    status = yield* method(provider, SLOT.QueryService, iid('profferService'),
                        iid('profferService'), out + 4);
                    yield* release(provider);
                    if (status < 0)
                    {
                        return status;
                    }
                    const proffer = readU32(out + 4);
                    if ((provided >>> 0) !== 0)
                    {
                        status = yield* method(proffer, SLOT.ProfferService, service, provided,
                            cookie);
                    }
                    else
                    {
                        status = yield* method(proffer, SLOT.RevokeService,
                            (cookie >>> 0) === 0 ? 0 : readU32(cookie));
                        if ((cookie >>> 0) !== 0)
                        {
                            writeU32(cookie, 0);
                        }
                    }
                    yield* release(proffer);
                    return status;
                });
            },
        },

        /**
         * HRESULT IUnknown_GetClassID(IUnknown *lpUnknown, CLSID *clsid)
         *
         * IPersist's GetClassID, or IPersistFolder's; a null object is
         * E_FAIL with CLSID_NULL written.
         */
        IUnknown_GetClassID: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([unknown, clsid])=>{
                if ((unknown >>> 0) === 0)
                {
                    if ((clsid >>> 0) !== 0)
                    {
                        host.writeMemory(clsid >>> 0, new Uint8Array(16));
                    }
                    return E_FAIL;
                }
                return withObjects(function* (iid, out){
                    for (const name of /** @type {const} */ (['persist', 'persistFolder']))
                    {
                        if ((yield* queryInterface(unknown, iid(name), out)) >= 0)
                        {
                            const persist = readU32(out);
                            const status = yield* method(persist, SLOT.GetClassID, clsid);
                            yield* release(persist);
                            return status;
                        }
                    }
                    return E_FAIL;
                });
            },
        },

        /**
         * HRESULT SHPropertyBag_ReadLONG(IPropertyBag *ppb, LPCWSTR pszPropName, LPLONG pValue)
         *
         * The bag's value asked for as VT_I4 and taken only when it is one:
         * anything else is DISP_E_BADVARTYPE, the value left alone.
         */
        SHPropertyBag_ReadLONG: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([bag, name, value])=>{
                if ((bag >>> 0) === 0 || (name >>> 0) === 0 || (value >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                return withObjects(function* (iid, out){
                    const variant = new Uint8Array(VARIANT_SIZE);
                    variant.set(word(VT_I4), 0);
                    host.writeMemory(out, variant);
                    const status = yield* method(bag, SLOT.Read, name, out, 0);
                    if (status < 0)
                    {
                        return status;
                    }
                    const type = readBytes(out, 2)[0] | readBytes(out, 2)[1] << 8;
                    if (type !== VT_I4 || (type & VT_BYREF) !== 0)
                    {
                        return DISP_E_BADVARTYPE;
                    }
                    writeU32(value, readU32(out + 8));
                    return S_OK;
                });
            },
        },

        /**
         * HANDLE SHAllocShared(LPCVOID lpvData, DWORD dwSize, DWORD dwProcId)
         *
         * A mapping of the size, holding the data when there is some, as a
         * handle the process named owns.
         */
        SHAllocShared: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: async([data, size, process])=>{
                const mapping = await kernel32('CreateFileMappingA',
                    [INVALID_HANDLE_VALUE, 0, PAGE_READWRITE, 0, Math.max(size >>> 0, 1), 0]);
                if (!mapping)
                {
                    return 0;
                }
                if ((data >>> 0) !== 0 && (size >>> 0) !== 0)
                {
                    const view = (await kernel32('MapViewOfFile',
                        [mapping, FILE_MAP_ALL_ACCESS, 0, 0, 0])) >>> 0;
                    if (view)
                    {
                        host.writeMemory(view, readBytes(data >>> 0, size >>> 0).slice());
                        await kernel32('UnmapViewOfFile', [view]);
                    }
                }
                if (await isSelf(process))
                {
                    return mapping >>> 0;
                }
                const self = await kernel32('GetCurrentProcessId', []);
                return (await duplicate(mapping, self, process, 0, DUPLICATE_CLOSE_SOURCE)) >>> 0;
            },
        },

        /** PVOID SHLockShared(HANDLE hShared, DWORD dwProcId): a view of it here. */
        SHLockShared: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: async([shared, process])=>{
                if ((shared >>> 0) === 0)
                {
                    return 0;
                }
                if (await isSelf(process))
                {
                    return (await kernel32('MapViewOfFile', [shared, FILE_MAP_ALL_ACCESS, 0, 0, 0]))
                        >>> 0;
                }
                const self = await kernel32('GetCurrentProcessId', []);
                const local = await duplicate(shared, process, self, 0, 0);
                if (!local)
                {
                    return 0;
                }
                const view = await kernel32('MapViewOfFile', [local, FILE_MAP_ALL_ACCESS, 0, 0, 0]);
                await kernel32('CloseHandle', [local]);
                return view >>> 0;
            },
        },

        /** BOOL SHUnlockShared(LPVOID lpView) */
        SHUnlockShared: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: async([view])=>((await kernel32('UnmapViewOfFile', [view])) ? 1 : 0),
        },

        /**
         * BOOL SHFreeShared(HANDLE hShared, DWORD dwProcId)
         *
         * A null handle is TRUE with the last error left alone (Wine's
         * test_alloc_shared).
         */
        SHFreeShared: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: async([shared, process])=>{
                if ((shared >>> 0) === 0)
                {
                    return 1;
                }
                if (await isSelf(process))
                {
                    return (await kernel32('CloseHandle', [shared])) ? 1 : 0;
                }
                const self = await kernel32('GetCurrentProcessId', []);
                const local = await duplicate(shared, process, self, 0, DUPLICATE_CLOSE_SOURCE);
                return local && await kernel32('CloseHandle', [local]) ? 1 : 0;
            },
        },

        /**
         * HANDLE SHMapHandle(HANDLE hShared, DWORD dwSrcProcId, DWORD dwDstProcId,
         *                    DWORD dwAccess, DWORD dwOptions)
         */
        SHMapHandle: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: async([shared, from, to, access, options])=>((shared >>> 0) === 0 ? 0
                : (await duplicate(shared, from, to, access >>> 0, options >>> 0)) >>> 0),
        },

        /** HRESULT GetAcceptLanguagesA(LPSTR pszLanguages, DWORD *pcchLanguages) */
        GetAcceptLanguagesA: getAcceptLanguages(false),
        GetAcceptLanguagesW: getAcceptLanguages(true),

        /**
         * LONG SHSetWindowBits(HWND hwnd, INT offset, UINT mask, UINT flags)
         *
         * The bits of the mask set to the flags' and the rest kept; the long
         * as it was, and 0 with GetWindowLong's error for no window.
         */
        SHSetWindowBits: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: async([hwnd, offset, mask, flags])=>{
                const old = (await user32('GetWindowLongA', [hwnd, offset])) >>> 0;
                const next = ((old & ~mask) | (flags & mask)) >>> 0;
                if (next !== old)
                {
                    await user32('SetWindowLongA', [hwnd, offset, next]);
                }
                return old;
            },
        },

        /**
         * HWND SHSetParentHwnd(HWND hWnd, HWND hWndParent)
         *
         * The window made the parent's child, or a popup of its own for no
         * parent, its style following; a window already a child of its
         * parent is answered with the parent SetParent leaves it with, the
         * other changes with NULL (Wine's test_SHSetParentHwnd).
         */
        SHSetParentHwnd: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: async([hwnd, parent])=>{
                if ((hwnd >>> 0) === 0)
                {
                    return 0;
                }
                const style = (await user32('GetWindowLongA', [hwnd, GWL_STYLE])) >>> 0;
                const kind = style & (WS_CHILD | WS_POPUP);
                if ((parent >>> 0) === 0)
                {
                    if ((style & WS_CHILD) !== 0)
                    {
                        await user32('SetWindowLongA', [hwnd, GWL_STYLE,
                            ((style & ~(WS_CHILD | WS_POPUP)) | WS_POPUP) >>> 0]);
                    }
                    await user32('SetParent', [hwnd, 0]);
                    return 0;
                }
                if (kind !== WS_CHILD)
                {
                    await user32('SetWindowLongA', [hwnd, GWL_STYLE,
                        ((style & ~(WS_CHILD | WS_POPUP)) | WS_CHILD) >>> 0]);
                    await user32('SetParent', [hwnd, parent]);
                    return 0;
                }
                return (await user32('SetParent', [hwnd, parent])) >>> 0;
            },
        },

        /**
         * int SHSearchMapInt(const int *lpKeys, const int *lpValues, int iLen, int iKey)
         *
         * The value beside the first key that matches, or -1.
         */
        SHSearchMapInt: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([keys, values, length, key])=>{
                if ((keys >>> 0) === 0 || (values >>> 0) === 0)
                {
                    return -1;
                }
                // Read as the arrays they are: one past what is mapped faults
                // at once, as Windows' walk would when it got there.
                const count = Math.max(0, length | 0);
                const list = new DataView(readBytes(keys >>> 0, count * 4).slice().buffer);
                for (let at = 0; at < count; at++)
                {
                    if (list.getInt32(at * 4, true) === (key | 0))
                    {
                        return readU32(values + at * 4) | 0;
                    }
                }
                return -1;
            },
        },

        /**
         * BOOL FDSA_Initialize(DWORD block_size, DWORD inc, FDSA_info *info,
         *                      void *mem, DWORD init_blocks)
         *
         * An array over the caller's block; a growth step of 0 is 1.
         */
        FDSA_Initialize: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([size, inc, info, mem, blocks])=>{
                if ((info >>> 0) === 0)
                {
                    return 0;
                }
                const bytes = new Uint8Array(16);
                bytes.set(dword(mem), FDSA.mem);
                bytes.set(dword(blocks), FDSA.room);
                bytes[FDSA.inc] = (inc & 0xff) || 1;
                bytes[FDSA.size] = size & 0xff;
                host.writeMemory(info >>> 0, bytes.subarray(0, 15));
                return 1;
            },
        },

        /**
         * BOOL FDSA_Destroy(FDSA_info *info)
         *
         * FALSE when the array was one shlwapi grew into, which it frees;
         * TRUE when it is still the caller's (Wine's test_fdsa).
         */
        FDSA_Destroy: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: async([info])=>{
                const state = fdsa(info);
                if ((state.flags & FDSA_FLAG_OWN) !== 0)
                {
                    await kernel32('LocalFree', [state.mem]);
                    return 0;
                }
                return 1;
            },
        },

        /**
         * DWORD FDSA_InsertItem(FDSA_info *info, DWORD where, const void *block)
         *
         * The item put at `where`, the end for anything past it, the array
         * grown by the step into a block of shlwapi's own when it is full;
         * the place it went.
         */
        FDSA_InsertItem: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: async([info, where, block])=>{
                const state = fdsa(info);
                const at = Math.min(where >>> 0, state.count);
                let mem = state.mem;
                if (state.count >= state.room)
                {
                    const room = state.room + state.inc;
                    const grown = (await kernel32('LocalAlloc', [LMEM_ZEROINIT, room * state.size]))
                        >>> 0;
                    if (!grown)
                    {
                        return -1;
                    }
                    host.writeMemory(grown, readBytes(mem, state.count * state.size).slice());
                    if ((state.flags & FDSA_FLAG_OWN) !== 0)
                    {
                        await kernel32('LocalFree', [mem]);
                    }
                    mem = grown;
                    writeU32(info + FDSA.mem, mem);
                    writeU32(info + FDSA.room, room);
                    host.writeMemory(info + FDSA.flags, Uint8Array.of(state.flags | FDSA_FLAG_OWN));
                }
                const tail = readBytes(mem + at * state.size,
                    (state.count - at) * state.size).slice();
                host.writeMemory(mem + (at + 1) * state.size, tail);
                host.writeMemory(mem + at * state.size,
                    readBytes(block >>> 0, state.size).slice());
                writeU32(info + FDSA.count, state.count + 1);
                return at;
            },
        },

        /** BOOL FDSA_DeleteItem(FDSA_info *info, DWORD where): FALSE past the last item. */
        FDSA_DeleteItem: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([info, where])=>{
                const state = fdsa(info);
                if ((where >>> 0) >= state.count)
                {
                    return 0;
                }
                const at = where >>> 0;
                const tail = readBytes(state.mem + (at + 1) * state.size,
                    (state.count - at - 1) * state.size).slice();
                host.writeMemory(state.mem + at * state.size, tail);
                writeU32(info + FDSA.count, state.count - 1);
                return 1;
            },
        },

        /**
         * HWND SHCreateWorkerWindowA(WNDPROC wndProc, HWND hWndParent, DWORD dwExStyle,
         *                            DWORD dwStyle, HMENU hMenu, LONG_PTR wnd_extra)
         *
         * A window of the "WorkerA" class shlwapi registers once, one pointer
         * of extra bytes holding `wnd_extra`, and the window procedure the
         * caller gives in place of DefWindowProc's.
         */
        SHCreateWorkerWindowA: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([procedure, parent, exStyle, style, menu, extra])=>
                scratch(64, async at=>{
                    host.writeMemory(at + 40, encodeAnsi('WorkerA\0'));
                    host.writeMemory(at + 48, encodeAnsi('shlwapi.dll\0'));
                    const instance = await kernel32('GetModuleHandleA', [at + 48]);
                    if (!await user32('GetClassInfoA', [instance, at + 40, at]))
                    {
                        // The class's procedure is user32's own export, as the
                        // program's GetProcAddress finds it.
                        host.writeMemory(at, encodeAnsi('user32.dll\0'));
                        host.writeMemory(at + 16, encodeAnsi('DefWindowProcA\0'));
                        const procedureAddress = await kernel32('GetProcAddress',
                            [await kernel32('GetModuleHandleA', [at]), at + 16]);
                        const fields = new Uint8Array(40);
                        const view = new DataView(fields.buffer);
                        view.setUint32(4, procedureAddress >>> 0, true);
                        view.setUint32(12, 4, true);
                        view.setUint32(16, instance >>> 0, true);
                        const cursor = await user32('LoadCursorA', [0, IDC_ARROW]);
                        view.setUint32(24, cursor >>> 0, true);
                        view.setUint32(36, at + 40, true);
                        host.writeMemory(at, fields);
                        if (!procedureAddress)
                        {
                            return 0;
                        }
                        await user32('RegisterClassA', [at]);
                    }
                    const hwnd = (await user32('CreateWindowExA', [exStyle | WS_EX_WINDOWEDGE,
                        at + 40, 0, style, 0, 0, 0, 0, parent, menu, instance, 0])) >>> 0;
                    if (hwnd)
                    {
                        await user32('SetWindowLongA', [hwnd, 0, extra]);
                        if ((procedure >>> 0) !== 0)
                        {
                            await user32('SetWindowLongA', [hwnd, GWLP_WNDPROC, procedure]);
                        }
                    }
                    return hwnd;
                }),
        },

        /** BOOL GUIDFromStringA(LPCSTR idstr, CLSID *id) */
        GUIDFromStringA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([text, guid])=>{
                const bytes = (text >>> 0) === 0 ? null
                    : parseGuid(host.readCString(text >>> 0, 64));
                if (bytes === null || (guid >>> 0) === 0)
                {
                    return 0;
                }
                host.writeMemory(guid >>> 0, bytes);
                return 1;
            },
        },

        /**
         * HRESULT WINAPIV SHPackDispParams(DISPPARAMS *params, VARIANTARG *args,
         *                                  UINT cnt, ...)
         *
         * The variadic pairs of type and value put in the variants last
         * first, as IDispatch::Invoke takes them; an empty type is a 4-byte
         * integer, which is how Windows packs one (Wine's
         * test_SHPackDispParams).
         */
        SHPackDispParams: {
            convention: 'cdecl',
            argBytes: 12 + PACK_MOST * 12,
            /** @param {number[]} args */
            handler: ([params, variants, count, ...rest])=>{
                if ((params >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const total = Math.min(count >>> 0, PACK_MOST);
                let next = 0;
                for (let at = 0; at < total; at++)
                {
                    const type = rest[next++] & 0xffff;
                    const variant = new Uint8Array(VARIANT_SIZE);
                    variant.set(word(type === VT_EMPTY ? VT_I4 : type), 0);
                    variant.set(dword(rest[next++] ?? 0), 8);
                    if (WIDE_VARIANTS.has(type))
                    {
                        variant.set(dword(rest[next++] ?? 0), 12);
                    }
                    host.writeMemory((variants >>> 0) + (total - 1 - at) * VARIANT_SIZE,
                        variant.subarray(0, WIDE_VARIANTS.has(type) ? 16 : 12));
                }
                const head = new Uint8Array(16);
                head.set(dword(total ? variants : 0), 0);
                head.set(dword(total), 8);
                host.writeMemory(params >>> 0, head);
                return S_OK;
            },
        },

        /**
         * DWORD SHGetIniStringW(LPCWSTR appName, LPCWSTR keyName, LPWSTR out,
         *                       DWORD outLen, LPCWSTR filename)
         *
         * GetPrivateProfileString with an empty default; the length of the
         * first string it gave (Wine's test_SHGetIniString: the key list of
         * a section is counted to its first key).
         */
        SHGetIniStringW: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([app, key, out, room, file])=>{
                if ((room >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return 0;
                }
                return scratch(2, async empty=>{
                    await kernel32('GetPrivateProfileStringW', [app, key, empty, out, room, file]);
                    return (wideAt(out) ?? '').length;
                });
            },
        },

        /**
         * BOOL SHSetIniStringW(LPCWSTR appName, LPCWSTR keyName, LPCWSTR str,
         *                      LPCWSTR filename)
         */
        SHSetIniStringW: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: async([app, key, value, file])=>
                ((await kernel32('WritePrivateProfileStringW', [app, key, value, file])) ? 1 : 0),
        },

        /** INT SHFormatDateTimeA(const FILETIME *, DWORD *flags, LPSTR buf, UINT size) */
        SHFormatDateTimeA: shFormatDateTime(false),
        SHFormatDateTimeW: shFormatDateTime(true),

        /**
         * DWORD SHGetObjectCompatFlags(IUnknown *pUnk, const CLSID *clsid)
         *
         * The bits named by the values under the object's key in the shell's
         * compatibility list; 0 for an object with none, and for no CLSID.
         */
        SHGetObjectCompatFlags: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: async([, clsid])=>{
                if ((clsid >>> 0) === 0)
                {
                    return 0;
                }
                const guid = readBytes(clsid >>> 0, 16);
                const hex = (/** @type {number} */ value, /** @type {number} */ digits)=>
                    value.toString(16).toUpperCase().padStart(digits, '0');
                const view = new DataView(guid.slice().buffer);
                const tail = Array.from(guid.subarray(8), b=>hex(b, 2)).join('');
                const name = `{${hex(view.getUint32(0, true), 8)}`
                    + `-${hex(view.getUint16(4, true), 4)}`
                    + `-${hex(view.getUint16(6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}}`;
                const path = encodeAnsi(`${COMPAT_OBJECTS}\\${name}\0`);
                return scratch(path.length + 80, async at=>{
                    host.writeMemory(at + 80, path);
                    if (await advapi32('RegOpenKeyExA',
                        [HKEY_LOCAL_MACHINE, at + 80, 0, KEY_READ, at])
                        !== ERROR_SUCCESS)
                    {
                        return 0;
                    }
                    const key = readU32(at);
                    let flags = 0;
                    for (let index = 0; ; index++)
                    {
                        writeU32(at + 4, 64);
                        if (await advapi32('RegEnumValueA',
                            [key, index, at + 8, at + 4, 0, 0, 0, 0])
                            !== ERROR_SUCCESS)
                        {
                            break;
                        }
                        flags |= COMPAT_FLAGS[/** @type {keyof typeof COMPAT_FLAGS} */ (
                            host.readCString(at + 8, 64))] ?? 0;
                    }
                    await advapi32('RegCloseKey', [key]);
                    return flags >>> 0;
                });
            },
        },

        /**
         * HKEY SHGetShellKey(DWORD flags, LPCWSTR sub_key, BOOL create)
         *
         * The key the flags name under HKCU or HKLM, a subkey of it when one
         * is named, created when asked; NULL for no root (Vista on).
         */
        SHGetShellKey: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: async([flags, subKey, create])=>(await shellKey(flags, subKey, create !== 0))
                >>> 0,
        },

        /**
         * HRESULT SKGetValueW(DWORD flags, LPCWSTR subkey, LPCWSTR value, DWORD *type,
         *                     void *data, DWORD *count)
         */
        SKGetValueW: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: async([flags, subKey, value, type, data, count])=>{
                const key = await shellKey(flags, subKey, false);
                if (!key)
                {
                    return fromWin32(2);
                }
                const status = await advapi32('RegQueryValueExW',
                    [key, value, 0, type, data, count]);
                await advapi32('RegCloseKey', [key]);
                return fromWin32(status);
            },
        },

        /**
         * HRESULT SKSetValueW(DWORD flags, LPCWSTR subkey, LPCWSTR value, DWORD type,
         *                     void *data, DWORD count)
         */
        SKSetValueW: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: async([flags, subKey, value, type, data, count])=>{
                const key = await shellKey(flags, subKey, true);
                if (!key)
                {
                    return E_FAIL;
                }
                const status = await advapi32('RegSetValueExW', [key, value, 0, type, data, count]);
                await advapi32('RegCloseKey', [key]);
                return fromWin32(status);
            },
        },

        /** HRESULT SKDeleteValueW(DWORD flags, LPCWSTR subkey, LPCWSTR value) */
        SKDeleteValueW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: async([flags, subKey, value])=>{
                const key = await shellKey(flags, subKey, false);
                if (!key)
                {
                    return fromWin32(2);
                }
                const status = await advapi32('RegDeleteValueW', [key, value]);
                await advapi32('RegCloseKey', [key]);
                return fromWin32(status);
            },
        },

        /**
         * HRESULT SKAllocValueW(DWORD flags, LPCWSTR subkey, LPCWSTR value, DWORD *type,
         *                       void **data, DWORD *count)
         *
         * The value in a block of LocalAlloc's the caller frees.
         */
        SKAllocValueW: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: async([flags, subKey, value, type, dataOut, count])=>{
                if ((dataOut >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const key = await shellKey(flags, subKey, false);
                if (!key)
                {
                    return fromWin32(2);
                }
                try
                {
                    return await scratch(4, async size=>{
                        let status = await advapi32('RegQueryValueExW',
                            [key, value, 0, type, 0, size]);
                        if (status !== ERROR_SUCCESS)
                        {
                            return fromWin32(status);
                        }
                        const length = readU32(size);
                        const block = (await kernel32('LocalAlloc',
                            [LMEM_ZEROINIT, length + 2])) >>> 0;
                        if (!block)
                        {
                            return E_OUTOFMEMORY;
                        }
                        status = await advapi32('RegQueryValueExW',
                            [key, value, 0, type, block, size]);
                        if (status !== ERROR_SUCCESS)
                        {
                            await kernel32('LocalFree', [block]);
                            return fromWin32(status);
                        }
                        writeU32(dataOut, block);
                        if ((count >>> 0) !== 0)
                        {
                            writeU32(count, readU32(size));
                        }
                        return S_OK;
                    });
                }
                finally
                {
                    await advapi32('RegCloseKey', [key]);
                }
            },
        },
    };
}

