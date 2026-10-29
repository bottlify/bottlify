/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Monikers and the bind context: the names COM gives objects, and the
 * scratch a bind is made in.
 *
 * Six system monikers are built here -- item, file, class, pointer, anti and
 * the generic composite -- each an IMoniker with IPersistStream and, all but
 * the pointer moniker, IROTData. Their observable answers (display names,
 * hashes, the bytes they persist and compare as, which HRESULT each refuses
 * with) follow ole32's conformance tests byte for byte where those tests
 * check bytes.
 *
 * Every call one moniker makes on another goes through its vtable, ours
 * included: a composite can hold a program's own moniker beside ours, and
 * one path for both is what keeps them answering alike. What is looked up
 * directly is only identity -- whether a pointer is one of ours and of
 * which kind -- which is what Windows asks before an IsEqual answers S_OK.
 *
 * A composite is held flat: its components in order, none of them one of
 * our composites. Its observable shape -- the count it persists, the order
 * Enum gives, the XOR it hashes to, the display name it concatenates -- is
 * the same whether the tree it was built from leaned left or right.
 */

import { GUID_NULL, GUID_SIZE, canonicalGuid, formatGuid, parseGuid } from './guid.js';
import { HKEY_CLASSES_ROOT } from '../advapi32/registry.js';
import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { charactersOf, readToTerminator } from '../common/scan-windows.js';

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const E_POINTER = 0x80004003 | 0;
const E_FAIL = 0x80004005 | 0;
const E_UNEXPECTED = 0x8000ffff | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const STG_E_READFAULT = 0x8003001e | 0;
const CO_S_NOTALLINTERFACES = 0x00080012;

const MK_E_NEEDGENERIC = 0x800401e2 | 0;
const MK_E_UNAVAILABLE = 0x800401e3 | 0;
const MK_E_SYNTAX = 0x800401e4 | 0;
const MK_E_NOOBJECT = 0x800401e5 | 0;
const MK_E_INVALIDEXTENSION = 0x800401e6 | 0;
const MK_E_INTERMEDIATEINTERFACENOTSUPPORTED = 0x800401e7 | 0;
const MK_E_NOTBINDABLE = 0x800401e8 | 0;
const MK_E_NOTBOUND = 0x800401e9 | 0;
const MK_E_CANTOPENFILE = 0x800401ea | 0;
const MK_E_NOINVERSE = 0x800401ec | 0;
const MK_E_NOPREFIX = 0x800401ee | 0;
const MK_S_REDUCED_TO_SELF = 0x000401e2;
const MK_S_ME = 0x000401e4;
const MK_S_HIM = 0x000401e5;
const MK_S_US = 0x000401e6;

/** MKSYS_*, what IsSystemMoniker answers. */
export const MKSYS = Object.freeze({
    NONE: 0, GENERICCOMPOSITE: 1, FILEMONIKER: 2, ANTIMONIKER: 3, ITEMMONIKER: 4,
    POINTERMONIKER: 5, CLASSMONIKER: 7, OBJREFMONIKER: 8,
});

const BINDSPEED_INDEFINITE = 1;
const BINDSPEED_MODERATE = 2;
const BINDSPEED_IMMEDIATE = 3;
/** A deadline closer than this is a bind that must not wait at all. */
const IMMEDIATE_DEADLINE = 2500;

const STGM_READ = 0;
const STGM_READWRITE = 2;
const CLSCTX_INPROC_SERVER = 1;
const CLSCTX_SERVER = 0x15;
const LOCALE_US = 0x409;

export const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
export const IID_IMONIKER = '{0000000F-0000-0000-C000-000000000046}';
export const IID_IBINDCTX = '{0000000E-0000-0000-C000-000000000046}';
export const IID_IENUMMONIKER = '{00000102-0000-0000-C000-000000000046}';
export const IID_IROTDATA = '{F29F6BC0-5021-11CE-AA15-00006901293F}';
const IID_IPERSIST = '{0000010C-0000-0000-C000-000000000046}';
const IID_IPERSISTSTREAM = '{00000109-0000-0000-C000-000000000046}';
const IID_IPERSISTFILE = '{0000010B-0000-0000-C000-000000000046}';
const IID_IOLEITEMCONTAINER = '{0000011C-0000-0000-C000-000000000046}';
const IID_IPARSEDISPLAYNAME = '{0000011A-0000-0000-C000-000000000046}';
const IID_ICLASSACTIVATOR = '{00000140-0000-0000-C000-000000000046}';
const IID_ICLASSFACTORY = '{00000001-0000-0000-C000-000000000046}';
const IID_ISTORAGE = '{0000000B-0000-0000-C000-000000000046}';
const IID_ISTREAM = '{0000000C-0000-0000-C000-000000000046}';
const IID_ILOCKBYTES = '{0000000A-0000-0000-C000-000000000046}';

/** The system monikers' classes, which are also what each persists itself as. */
export const CLSID_FILE_MONIKER = '{00000303-0000-0000-C000-000000000046}';
export const CLSID_ITEM_MONIKER = '{00000304-0000-0000-C000-000000000046}';
export const CLSID_ANTI_MONIKER = '{00000305-0000-0000-C000-000000000046}';
export const CLSID_POINTER_MONIKER = '{00000306-0000-0000-C000-000000000046}';
export const CLSID_COMPOSITE_MONIKER = '{00000309-0000-0000-C000-000000000046}';
export const CLSID_CLASS_MONIKER = '{0000031A-0000-0000-C000-000000000046}';
export const CLSID_OBJREF_MONIKER = '{00000327-0000-0000-C000-000000000046}';
const IID_IMARSHAL = '{00000003-0000-0000-C000-000000000046}';
/** An OBJREF_CUSTOM's bytes before its data: signature, flags, IID, CLSID, two counts. */
const OBJREF_CUSTOM_HEADER = 48;

/** Private classes of the objects that are no moniker. */
const CLSID_BIND_CONTEXT = '{7B5B0B8E-1F8C-4B36-9D1C-2A6D4E4B0020}';
const CLSID_MONIKER_ENUM = '{7B5B0B8E-1F8C-4B36-9D1C-2A6D4E4B0021}';
const CLSID_CONTAINER_LOCK = '{7B5B0B8E-1F8C-4B36-9D1C-2A6D4E4B0022}';

/** IUnknown's slots, and the slots of each interface called through its vtable. */
const SLOT = Object.freeze({
    QUERY_INTERFACE: 0, ADD_REF: 1, RELEASE: 2,
    // IPersist, IPersistStream, IMoniker
    GET_CLASS_ID: 3, LOAD: 5, SAVE: 6, GET_SIZE_MAX: 7, BIND_TO_OBJECT: 8,
    BIND_TO_STORAGE: 9, REDUCE: 10, COMPOSE_WITH: 11, IS_EQUAL: 13, HASH: 14,
    IS_RUNNING: 15, GET_TIME_OF_LAST_CHANGE: 16, INVERSE: 17, COMMON_PREFIX_WITH: 18,
    RELATIVE_PATH_TO: 19, GET_DISPLAY_NAME: 20, PARSE_DISPLAY_NAME: 21, IS_SYSTEM_MONIKER: 22,
    // IStream
    STREAM_READ: 3, STREAM_WRITE: 4,
    // IBindCtx
    REGISTER_OBJECT_BOUND: 3, GET_BIND_OPTIONS: 7, GET_RUNNING_OBJECT_TABLE: 8,
    // IRunningObjectTable
    ROT_IS_RUNNING: 5, ROT_GET_OBJECT: 6, ROT_GET_TIME_OF_LAST_CHANGE: 8,
    // IOleItemContainer, after IParseDisplayName and IOleContainer
    LOCK_CONTAINER: 5, GET_OBJECT: 6, GET_OBJECT_STORAGE: 7, CONTAINER_IS_RUNNING: 8,
    // IParseDisplayName, IClassFactory, IClassActivator, IPersistFile, IROTData
    PARSE: 3, CREATE_INSTANCE: 3, GET_CLASS_OBJECT: 3, PERSIST_FILE_LOAD: 5,
    GET_COMPARISON_DATA: 3,
});

/**
 * BIND_OPTS3 as a 32-bit program lays it out: BIND_OPTS is the first sixteen
 * bytes, BIND_OPTS2 the first thirty-two.
 */
const BIND_OPTS = Object.freeze({
    CB_STRUCT: 0, FLAGS: 4, MODE: 8, DEADLINE: 12, TRACK_FLAGS: 16, CLASS_CONTEXT: 20,
    LOCALE: 24, SERVER_INFO: 28, HWND: 32, SIZE_OF: 36, SIZE_OF_V1: 16, SIZE_OF_V2: 32,
});

/** MULTI_QI: the IID asked for, the interface answered, and its HRESULT. */
const MULTI_QI = Object.freeze({ IID: 0, ITF: 4, HR: 8, SIZE_OF: 12 });

/** The largest count an anti moniker loads; one more is refused. */
const MAX_ANTI_COUNT = 0xfffff;
/** How far a string a program hands in is read. */
const MAX_STRING = 0x8000;
/** The unknown word after a file moniker's ANSI path, and the marker after it. */
const FILE_MONIKER_UNKNOWN = 0xffff;
const FILE_MONIKER_MARKER = 0xdead;
const FILE_MONIKER_WIDE_TAG = 3;

/**
 * @typedef {Object} MonikerHive
 * @property {(id: number) => any} root
 * @property {(key: any, path: string) => any} open
 * @property {(key: any, name: string) => { data: Uint8Array } | null} getValue
 */

/**
 * What the moniker functions need of the rest of ole32.
 *
 * @typedef {Object} MonikerEnv
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => unknown }} heap
 *           Scratch: out-parameters, and the strings and GUIDs lent to a call
 *           for its duration. An address of 0 means nothing fits.
 * @property {(bytes: number) => number} taskAlloc
 *           CoTaskMemAlloc, for a display name handed to the caller; 0 when
 *           nothing fits.
 * @property {(address: number) => unknown} taskFree
 *           CoTaskMemFree, for a display name another moniker handed here.
 * @property {(pointer: number, slot: number, args: number[], thread?: unknown) => Promise<number>}
 *           callMethod
 *           A method of any interface pointer -- a program's object or one
 *           published here -- by vtable slot, `this` added by the callee, the
 *           arguments after it as given. Answers the method's return value.
 * @property {() => unknown} callerThread
 *           Whose call is being answered, for the calls made while answering it.
 * @property {import('./objects.js').ComRegistry} registry
 *           The system monikers' classes are registered in it, so that
 *           CoCreateInstance makes one, as OleLoadFromStream needs.
 * @property {{ publish: (object: import('./objects.js').ComObject,
 *              interfaceId: string) => number }} vtables
 * @property {(clsid: string, outer: number, context: number, iid: string, out: number,
 *             thread: unknown) => Promise<number>} createInstance
 *           CoCreateInstance.
 * @property {(clsid: string, context: number, iid: string, out: number,
 *             thread: unknown) => Promise<number>} getClassObject
 *           CoGetClassObject.
 * @property {(out: number, thread: unknown) => Promise<number>} runningObjectTable
 * @property {{ sizeMax: (out: number, iid: string, unknown: number, context: number,
 *         destination: number, flags: number) => Promise<number>,
 *     marshal: (stream: number, iid: string, unknown: number, context: number,
 *         destination: number, flags: number) => Promise<number>,
 *     unmarshal: (stream: number, iid: string, out: number) => Promise<number>,
 *     releaseData: (stream: number) => Promise<number> }} [marshaling]
 *     CoGetMarshalSizeMax, CoMarshalInterface, CoUnmarshalInterface and
 *     CoReleaseMarshalData, the interface named by its IID. Absent, an
 *     objref moniker cannot be marshaled.
 *           GetRunningObjectTable: writes an IRunningObjectTable* the caller
 *           releases to `out`.
 * @property {(path: string) => Promise<string | null>} storageClassOf
 *           The CLSID a structured storage file says it is, or null when the
 *           file is no structured storage.
 * @property {(path: string) => { lastWrite: bigint } | null
 *             | Promise<{ lastWrite: bigint } | null>} fileInfo
 *           A file or directory by its path as a program wrote it, relative
 *           paths resolved as GetFullPathName would: null when there is none,
 *           else its last write as a FILETIME.
 * @property {(path: string, mode: number, out: number, thread: unknown)
 *             => number | Promise<number>} openStorage
 *           StgOpenStorage(path, NULL, mode, NULL, 0, out).
 * @property {MonikerHive} [hive]
 *           HKEY_CLASSES_ROOT, for a ProgID's class and an extension's ProgID.
 *           Absent, no ProgID resolves.
 * @property {() => number} [locale]  The thread's locale, for BIND_OPTS2.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * The state of one moniker of ours. Every field is present whatever the
 * kind; the kind says which carry meaning.
 *
 * @typedef {Object} MonikerState
 * @property {'item' | 'file' | 'class' | 'pointer' | 'anti' | 'composite'} kind
 * @property {number} self  Its IMoniker pointer, once published.
 * @property {string | null} delimiter  An item's, null when it has none.
 * @property {string} name   An item's name.
 * @property {string} path   A file's path.
 * @property {string} clsid  A class moniker's class.
 * @property {Uint8Array} extra
 *           What follows a class moniker's CLSID in its display name, as it
 *           persists it: UTF-16 with its terminator, or nothing.
 * @property {number} target  A pointer moniker's object, held counted.
 * @property {boolean} objref
 *           A pointer moniker that crosses to another apartment as a
 *           reference to its object (CreateObjrefMoniker), not by its pointer.
 * @property {number} count   How many components an anti moniker cancels.
 * @property {number[]} parts A composite's components, each held counted.
 */

const CLASS_OF = Object.freeze({
    item: CLSID_ITEM_MONIKER, file: CLSID_FILE_MONIKER, class: CLSID_CLASS_MONIKER,
    pointer: CLSID_POINTER_MONIKER, anti: CLSID_ANTI_MONIKER,
    composite: CLSID_COMPOSITE_MONIKER,
});

const MKSYS_OF = Object.freeze({
    item: MKSYS.ITEMMONIKER, file: MKSYS.FILEMONIKER, class: MKSYS.CLASSMONIKER,
    pointer: MKSYS.POINTERMONIKER, anti: MKSYS.ANTIMONIKER,
    composite: MKSYS.GENERICCOMPOSITE,
});

/**
 * @param {MonikerState['kind']} kind
 * @param {Partial<MonikerState>} [fields]
 * @returns {MonikerState}
 */
const newState = (kind, fields = {})=>({
    kind, self: 0, delimiter: null, name: '', path: '', clsid: GUID_NULL,
    extra: new Uint8Array(0), target: 0, count: 0, parts: [], objref: false, ...fields,
});

/**
 * A moniker's class, as GetClassID and its class factory know it.
 *
 * @param {MonikerState} state
 */
const classOf = state=>(state.objref ? CLSID_OBJREF_MONIKER : CLASS_OF[state.kind]);

/**
 * The moniker CoCreateInstance makes of each class: what Windows' class
 * factories answer before Load is called.
 *
 * @param {MonikerState['kind']} kind
 */
const defaultState = kind=>newState(kind, kind === 'item' ? { delimiter: '' }
    : kind === 'anti' ? { count: 1 } : {});

/**
 * One UTF-16 unit uppercased, or itself when its uppercase is not one unit:
 * the comparison data keeps one unit per character, as towupper does.
 *
 * @param {number} unit
 */
const upperUnit = unit=>{
    const upper = String.fromCharCode(unit).toUpperCase();
    return upper.length === 1 ? upper.charCodeAt(0) : unit;
};

/** @param {string} text */
const upperText = text=>String.fromCharCode(...Array.from(text, c=>upperUnit(c.charCodeAt(0))));

/** @param {string} a @param {string} b */
const sameIgnoringCase = (a, b)=>a.length === b.length && upperText(a) === upperText(b);

/**
 * @param {string} text
 * @param {boolean} [terminate]
 * @returns {Uint8Array} UTF-16LE
 */
const encodeWide = (text, terminate = true)=>{
    const bytes = new Uint8Array((text.length + (terminate ? 1 : 0)) * 2);
    for (let index = 0; index < text.length; index++)
    {
        const unit = text.charCodeAt(index);
        bytes[index * 2] = unit & 0xff;
        bytes[index * 2 + 1] = unit >>> 8;
    }
    return bytes;
};

/**
 * @param {Uint8Array} bytes  UTF-16LE; reading stops at a terminator.
 * @returns {string}
 */
const decodeWide = bytes=>{
    let text = '';
    for (let index = 0; index + 1 < bytes.length; index += 2)
    {
        const unit = bytes[index] | (bytes[index + 1] << 8);
        if (unit === 0)
        {
            break;
        }
        text += String.fromCharCode(unit);
    }
    return text;
};

/** @param {...Uint8Array} chunks */
const concat = (...chunks)=>{
    const out = new Uint8Array(chunks.reduce((sum, chunk)=>sum + chunk.length, 0));
    let at = 0;
    for (const chunk of chunks)
    {
        out.set(chunk, at);
        at += chunk.length;
    }
    return out;
};

/** @param {number} value */
const u32 = value=>{
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return bytes;
};

/** @param {number} value */
const u16 = value=>new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);

/** @param {Uint8Array} bytes @param {number} at */
const readU32Of = (bytes, at)=>(bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
    | (bytes[at + 3] << 24)) >>> 0;

/** @param {string} guid */
const guidBytes = guid=>/** @type {Uint8Array} */ (parseGuid(guid));

/**
 * A path in the pieces file monikers compose and compare by: each
 * backslash a piece of its own, each run between them another.
 *
 * @param {string} path
 * @returns {string[]}
 */
const pathPieces = path=>path.split(/(\\)/).filter(piece=>piece.length > 0);

/**
 * A file moniker's path as CreateFileMoniker keeps it: a path of nothing but
 * parent references names a directory, so it gains the trailing backslash
 * Windows gives it.
 *
 * @param {string} path
 */
const normalisePath = path=>{
    const pieces = pathPieces(path);
    const onlyParents = pieces.length > 0 && pieces[0] === '..'
        && pieces.every(piece=>piece === '..' || piece === '\\');
    return onlyParents && pieces[pieces.length - 1] !== '\\' ? `${path}\\` : path;
};

/**
 * The hash Windows gives a file moniker: every character of a short path,
 * every eighth of a long one.
 *
 * @param {string} path
 */
const fileHash = path=>{
    let hash = 0;
    if (path.length < 16)
    {
        for (let index = 0; index < path.length; index++)
        {
            hash = (Math.imul(hash, 37) + path.charCodeAt(index)) | 0;
        }
        return hash >>> 0;
    }
    const skip = Math.floor(path.length / 8);
    for (let left = path.length, at = 0; left > 0; left -= skip, at += skip)
    {
        hash = (Math.imul(hash, 39) + path.charCodeAt(at)) | 0;
    }
    return hash >>> 0;
};

/** @param {string} name */
const itemHash = name=>{
    let hash = 0;
    for (let index = 0; index < name.length; index++)
    {
        hash = (Math.imul(hash, 3) ^ upperUnit(name.charCodeAt(index))) >>> 0;
    }
    return hash;
};

/**
 * A class moniker's display name: the class without braces, whatever the
 * moniker carries after it, and the colon that ends it.
 *
 * @param {MonikerState} state
 */
const classDisplayName = state=>`clsid:${state.clsid.slice(1, -1)}${decodeWide(state.extra)}:`;

/**
 * The comparison data of a moniker that is not a composite: its class, then
 * what identifies it, case folded where the name is not case sensitive.
 *
 * @param {MonikerState} state
 * @returns {Uint8Array | null} null for one that has none
 */
const comparisonDataOf = state=>{
    const clsid = guidBytes(CLASS_OF[state.kind]);
    switch (state.kind)
    {
        case 'item':
            return concat(clsid, encodeWide(upperText(`${state.delimiter ?? ''}${state.name}`)));
        case 'file':
            return concat(clsid, encodeWide(upperText(state.path)));
        case 'class':
            return concat(clsid, guidBytes(state.clsid));
        case 'anti':
            return concat(clsid, u32(state.count));
        default:
            return null;
    }
};

/**
 * Builds the moniker half of ole32: the six system monikers, the bind
 * context, and the entry points that make, parse and bind them.
 *
 * @param {MonikerEnv} env
 */
export function createMonikerFunctions(env){
    /** @param {number} address */
    const readU32 = address=>readU32Of(env.readMemory(address >>> 0, 4), 0);
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>env.writeMemory(address >>> 0, u32(value));
    /** @param {number} address @param {bigint} value */
    const writeU64 = (address, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, value), true);
        env.writeMemory(address >>> 0, bytes);
    };
    /** @param {number} address */
    const readGuidAt = address=>formatGuid(env.readMemory(address >>> 0, GUID_SIZE).slice());

    /**
     * An OLESTR a program hands in, read a window at a time so a short one at
     * the end of its block is not read past.
     *
     * @param {number} address
     * @returns {string | null} null for a NULL pointer
     */
    const readWide = address=>((address >>> 0) === 0 ? null
        : charactersOf(readToTerminator(env, address, 2, MAX_STRING).bytes, 2));

    /** @param {string} api @param {string} detail */
    const diverge = (api, detail)=>env.divergence?.(api, detail);

    /**
     * @param {number} pointer @param {number} slot @param {number[]} args
     * @param {unknown} thread
     * @returns {Promise<number>}
     */
    const call = (pointer, slot, args, thread)=>Promise.resolve(env.callMethod(pointer >>> 0,
        slot, args.map(value=>value >>> 0), thread)).then(hr=>hr | 0);
    /** @param {number} pointer @param {unknown} thread */
    const addRef = (pointer, thread)=>call(pointer, SLOT.ADD_REF, [], thread);
    /** @param {number} pointer @param {unknown} thread */
    const release = (pointer, thread)=>call(pointer, SLOT.RELEASE, [], thread);
    /** @param {number[]} pointers @param {unknown} thread */
    const releaseAll = async(pointers, thread)=>{
        for (const pointer of pointers)
        {
            if (pointer !== 0)
            {
                await release(pointer, thread);
            }
        }
    };

    /**
     * Bytes lent to a call for its duration.
     *
     * @template T
     * @param {Uint8Array} bytes
     * @param {(address: number) => Promise<T>} use
     * @param {T} failed  What answers when nothing fits.
     * @returns {Promise<T>}
     */
    const lend = async(bytes, use, failed)=>{
        const block = env.heap.allocate(Math.max(bytes.length, 4));
        if (block === 0)
        {
            return failed;
        }
        env.writeMemory(block, bytes);
        try
        {
            return await use(block);
        }
        finally
        {
            env.heap.free(block);
        }
    };

    /**
     * A call whose answer is one pointer-sized out-parameter, handed to it
     * zeroed. The value is what the callee left there, whatever it answered.
     *
     * @param {(slot: number) => Promise<number>} make
     * @returns {Promise<{ hr: number, value: number }>}
     */
    const outCall = make=>lend(new Uint8Array(4), async slot=>{
        const hr = await make(slot);
        return { hr: hr | 0, value: readU32(slot) };
    }, { hr: E_OUTOFMEMORY, value: 0 });

    /**
     * QueryInterface on any object: the pointer it answered, which the
     * caller releases.
     *
     * @param {number} pointer @param {string} iid @param {unknown} thread
     */
    const query = (pointer, iid, thread)=>lend(guidBytes(iid), guid=>outCall(
        slot=>call(pointer, SLOT.QUERY_INTERFACE, [guid, slot], thread)),
    { hr: E_OUTOFMEMORY, value: 0 });

    /**
     * IMoniker::BindToObject on any moniker, the IID lent for the call.
     *
     * @param {number} moniker @param {number} context @param {number} left
     * @param {string} iid @param {unknown} thread
     */
    const bindTo = (moniker, context, left, iid, thread)=>lend(guidBytes(iid), guid=>outCall(
        slot=>call(moniker, SLOT.BIND_TO_OBJECT, [context, left, guid, slot], thread)),
    { hr: E_OUTOFMEMORY, value: 0 });

    /**
     * A string answered into a block the caller frees with CoTaskMemFree.
     *
     * @param {string} text @param {number} out
     */
    const answerString = (text, out)=>{
        const bytes = encodeWide(text);
        const block = env.taskAlloc(bytes.length) >>> 0;
        if (block === 0)
        {
            return E_OUTOFMEMORY;
        }
        env.writeMemory(block, bytes);
        writeU32(out, block);
        return S_OK;
    };

    /**
     * A string another object answered in task memory, read and freed.
     *
     * @param {number} block
     */
    const takeString = block=>{
        const text = readWide(block) ?? '';
        if (block !== 0)
        {
            env.taskFree(block);
        }
        return text;
    };

    /**
     * Reads from an IStream: what it gave, which may be less than asked.
     *
     * @param {number} stream @param {number} length @param {unknown} thread
     * @returns {Promise<{ hr: number, bytes: Uint8Array }>}
     */
    const readStream = (stream, length, thread)=>lend(new Uint8Array(length + 4), async block=>{
        const hr = await call(stream, SLOT.STREAM_READ, [block, length, block + length], thread);
        const read = Math.min(readU32(block + length), length);
        return { hr, bytes: env.readMemory(block, read).slice() };
    }, { hr: E_OUTOFMEMORY, bytes: new Uint8Array(0) });

    /**
     * Reads exactly `length` bytes, or answers why not: the stream's failure,
     * or `short` when it simply had fewer.
     *
     * @param {number} stream @param {number} length @param {number} short
     * @param {unknown} thread
     * @returns {Promise<{ hr: number, bytes: Uint8Array }>}
     */
    const readExactly = async(stream, length, short, thread)=>{
        const read = await readStream(stream, length, thread);
        if (read.hr < 0)
        {
            return read;
        }
        return read.bytes.length === length ? { hr: S_OK, bytes: read.bytes }
            : { hr: short, bytes: read.bytes };
    };

    /** @param {number} stream @param {Uint8Array} bytes @param {unknown} thread */
    const writeStream = (stream, bytes, thread)=>lend(bytes,
        block=>call(stream, SLOT.STREAM_WRITE, [block, bytes.length, 0], thread), E_OUTOFMEMORY);

    /**
     * A string value under HKEY_CLASSES_ROOT, read as ProgIDFromCLSID reads
     * one; null when there is none.
     *
     * @param {string} path
     */
    const classesValue = path=>{
        const hive = env.hive;
        const root = hive?.root(HKEY_CLASSES_ROOT);
        const key = root && hive ? hive.open(root, path) : null;
        const value = key && hive ? hive.getValue(key, '') : null;
        if (!value)
        {
            return null;
        }
        const end = value.data.indexOf(0);
        const text = decodeAnsi(end < 0 ? value.data : value.data.subarray(0, end));
        return text.length > 0 ? text : null;
    };

    /**
     * CLSIDFromProgID, as far as monikers need it.
     *
     * @param {string} progId
     * @returns {string | null}
     */
    const classOfProgId = progId=>{
        if (progId.length === 0 || progId.includes('\\'))
        {
            return null;
        }
        const text = classesValue(`${progId}\\CLSID`);
        return text === null ? null : canonicalGuid(text);
    };

    /**
     * GetClassFile: the class a storage file names itself, else the one its
     * extension is registered to. A file that is not there is
     * MK_E_CANTOPENFILE, which is what Windows answers before it looks at
     * the name, and CoGetInstanceFromFile passes that on.
     *
     * @param {string} path
     * @returns {Promise<{ hr: number, clsid: string }>}
     */
    const classOfFile = async path=>{
        if (!(await env.fileInfo(path)))
        {
            return { hr: MK_E_CANTOPENFILE, clsid: GUID_NULL };
        }
        const stored = await env.storageClassOf(path);
        if (stored !== null)
        {
            return { hr: S_OK, clsid: stored };
        }
        const name = path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1);
        const dot = name.lastIndexOf('.');
        const extension = dot < 0 ? '' : name.slice(dot);
        const progId = extension.length > 1 ? classesValue(extension) : null;
        const clsid = progId === null ? null : classOfProgId(progId);
        return clsid === null ? { hr: MK_E_INVALIDEXTENSION, clsid: GUID_NULL }
            : { hr: S_OK, clsid };
    };

    /**
     * The bind options a bind context holds, as BIND_OPTS2: whatever the
     * context answers, or Windows' defaults when there is no context.
     *
     * @param {number} context @param {unknown} thread
     * @returns {Promise<{ mode: number, deadline: number, classContext: number,
     *                     locale: number }>}
     */
    const bindOptions = async(context, thread)=>{
        const defaults = {
            mode: STGM_READWRITE, deadline: 0, classContext: CLSCTX_SERVER,
            locale: env.locale?.() ?? LOCALE_US,
        };
        if (context === 0)
        {
            return defaults;
        }
        const options = new Uint8Array(BIND_OPTS.SIZE_OF_V2);
        options.set(u32(BIND_OPTS.SIZE_OF_V2), BIND_OPTS.CB_STRUCT);
        return lend(options, async block=>{
            const hr = await call(context, SLOT.GET_BIND_OPTIONS, [block], thread);
            if (hr < 0)
            {
                return defaults;
            }
            const bytes = env.readMemory(block, BIND_OPTS.SIZE_OF_V2).slice();
            const size = readU32Of(bytes, BIND_OPTS.CB_STRUCT);
            return {
                mode: readU32Of(bytes, BIND_OPTS.MODE),
                deadline: readU32Of(bytes, BIND_OPTS.DEADLINE),
                classContext: size >= BIND_OPTS.SIZE_OF_V2
                    ? readU32Of(bytes, BIND_OPTS.CLASS_CONTEXT) : defaults.classContext,
                locale: size >= BIND_OPTS.SIZE_OF_V2
                    ? readU32Of(bytes, BIND_OPTS.LOCALE) : defaults.locale,
            };
        }, defaults);
    };

    /**
     * The speed an item's container is asked to bind at: the bind's
     * deadline, if it has one, says how long it may take.
     *
     * @param {number} context @param {unknown} thread
     */
    const bindSpeed = async(context, thread)=>{
        const { deadline } = await bindOptions(context, thread);
        if (deadline === 0)
        {
            return BINDSPEED_INDEFINITE;
        }
        return deadline < IMMEDIATE_DEADLINE ? BINDSPEED_IMMEDIATE : BINDSPEED_MODERATE;
    };

    /**
     * The running object table, through the bind context when there is
     * one -- a program's own context may answer with its own table.
     *
     * @param {number} context @param {unknown} thread
     */
    const runningTable = (context, thread)=>outCall(slot=>(context !== 0
        ? call(context, SLOT.GET_RUNNING_OBJECT_TABLE, [slot], thread)
        : env.runningObjectTable(slot, thread)));

    /**
     * Asks the running object table one question about a moniker.
     *
     * @param {number} context @param {number} slot  The table's method.
     * @param {(table: number) => number[]} args
     * @param {unknown} thread
     */
    const askTable = async(context, slot, args, thread)=>{
        const table = await runningTable(context, thread);
        if (table.hr < 0 || table.value === 0)
        {
            return table.hr < 0 ? table.hr : E_UNEXPECTED;
        }
        const hr = await call(table.value, slot, args(table.value), thread);
        await release(table.value, thread);
        return hr;
    };

    /**
     * IRunningObjectTable::GetObject: the object registered under a moniker.
     *
     * @param {number} context @param {number} moniker @param {unknown} thread
     */
    const runningObject = (context, moniker, thread)=>outCall(
        slot=>askTable(context, SLOT.ROT_GET_OBJECT, ()=>[moniker, slot], thread));

    /** Every moniker of ours by its IMoniker pointer. @type {Map<number, MonikerState>} */
    const monikers = new Map();
    /**
     * Monikers CoCreateInstance made whose pointer is not known yet: the
     * parent published it, and the first call on it says what it is.
     */
    let unseen = 0;

    /** @param {import('./objects.js').ComObject} object */
    const adopt = object=>{
        /** @type {MonikerState} */
        const state = object.state;
        if (state.self === 0)
        {
            state.self = env.vtables.publish(object, IID_IMONIKER) >>> 0;
            monikers.set(state.self, state);
            unseen = Math.max(0, unseen - 1);
        }
        return state;
    };

    /**
     * Whether a pointer is one of our monikers, and its state if so. A
     * moniker made by CoCreateInstance and never called is not known by its
     * pointer yet; asking it what it is makes it known.
     *
     * @param {number} pointer @param {unknown} thread
     * @returns {Promise<MonikerState | null>}
     */
    const ours = async(pointer, thread)=>{
        if (pointer === 0)
        {
            return null;
        }
        const known = monikers.get(pointer >>> 0);
        if (known || unseen === 0)
        {
            return known ?? null;
        }
        await outCall(slot=>call(pointer, SLOT.IS_SYSTEM_MONIKER, [slot], thread));
        return monikers.get(pointer >>> 0) ?? null;
    };

    /**
     * IsSystemMoniker of any moniker.
     *
     * @param {number} pointer @param {unknown} thread
     */
    const systemKind = async(pointer, thread)=>{
        const answer = await outCall(slot=>call(pointer, SLOT.IS_SYSTEM_MONIKER, [slot], thread));
        return answer.hr < 0 ? MKSYS.NONE : answer.value;
    };

    /** @type {import('./objects.js').ComClassDefinition | null} */
    let pending = null;

    /**
     * @param {MonikerState} state
     * @returns {import('./objects.js').ComClassDefinition}
     */
    const definitionOf = state=>{
        /** @type {import('./objects.js').ComInterfaceDescriptor[]} */
        const interfaces = [
            { id: IID_IMONIKER, methods: MONIKER_METHODS },
            { id: IID_IPERSISTSTREAM, methods: MONIKER_METHODS.slice(0, 5) },
            // Windows answers a QueryInterface for the moniker's own class,
            // which is how it tells its monikers from a program's.
            { id: classOf(state), methods: MONIKER_METHODS },
        ];
        if (state.objref)
        {
            // Asked for the pointer moniker's class, it answers as one.
            interfaces.push({ id: CLSID_POINTER_MONIKER, methods: MONIKER_METHODS });
        }
        interfaces.push({ id: IID_IMARSHAL, methods: state.kind === 'pointer'
            ? OBJREF_MARSHAL_METHODS
            : state.kind === 'composite' ? COMPOSITE_MARSHAL_METHODS : BY_VALUE_MARSHAL_METHODS });
        if (state.kind === 'class')
        {
            interfaces.push({ id: IID_IPERSIST, methods: MONIKER_METHODS.slice(0, 1) });
        }
        if (state.kind !== 'pointer')
        {
            interfaces.push({ id: IID_IROTDATA, methods: ROT_DATA_METHODS });
        }
        /** What the moniker holds of the program's, let go of once. */
        const takeHeld = ()=>{
            const held = [...state.parts, state.target].filter(pointer=>pointer !== 0);
            state.parts = [];
            state.target = 0;
            return held;
        };
        return {
            state,
            interfaces,
            // Inside the program's last Release, and waited for: a Release
            // made after it, with nobody waiting, would run on a thread that
            // has gone on to something else.
            lastRelease: ()=>releaseAll(takeHeld(), env.callerThread()),
            destroy(){
                if (state.self !== 0)
                {
                    monikers.delete(state.self);
                }
                else
                {
                    unseen = Math.max(0, unseen - 1);
                }
                const held = takeHeld();
                if (held.length > 0)
                {
                    void releaseAll(held, env.callerThread());
                }
            },
        };
    };

    for (const [kind, clsid] of Object.entries(CLASS_OF))
    {
        env.registry.registerClass(clsid, ()=>{
            if (pending)
            {
                return pending;
            }
            unseen++;
            return definitionOf(defaultState(/** @type {MonikerState['kind']} */ (kind)));
        });
    }
    // What CoUnmarshalInterface makes to read an objref moniker back.
    env.registry.registerClass(CLSID_OBJREF_MONIKER, ()=>{
        if (pending)
        {
            return pending;
        }
        unseen++;
        return definitionOf(newState('pointer', { objref: true }));
    });

    /**
     * Makes one of our monikers, taking over the references the state holds.
     *
     * @param {MonikerState} state
     * @param {unknown} thread
     * @returns {Promise<number>} its IMoniker pointer, holding one reference, or 0
     */
    const makeMoniker = async(state, thread)=>{
        pending = definitionOf(state);
        const object = env.registry.create(classOf(state));
        pending = null;
        if (!object)
        {
            await releaseAll([...state.parts, state.target], thread);
            return 0;
        }
        const pointer = env.vtables.publish(object, IID_IMONIKER) >>> 0;
        if (pointer === 0)
        {
            object.release();
            return 0;
        }
        state.self = pointer;
        monikers.set(pointer, state);
        return pointer;
    };

    /**
     * A moniker answered through an out-parameter.
     *
     * @param {MonikerState} state @param {number} out @param {unknown} thread
     */
    const answerMoniker = async(state, out, thread)=>{
        const pointer = await makeMoniker(state, thread);
        writeU32(out, pointer);
        return pointer === 0 ? E_OUTOFMEMORY : S_OK;
    };

    /** @param {number} count @param {unknown} thread */
    const makeAnti = (count, thread)=>makeMoniker(newState('anti', { count }), thread);

    /**
     * The components of a moniker: a composite's own, or the moniker alone.
     * No reference is taken.
     *
     * @param {number} pointer @param {unknown} thread
     */
    const componentsOf = async(pointer, thread)=>{
        const state = await ours(pointer, thread);
        return state && state.kind === 'composite' && state.parts.length > 0
            ? [...state.parts] : [pointer];
    };

    /**
     * One moniker of components it holds a reference on each of, which it
     * takes over: none for an empty list, the component itself for one.
     *
     * @param {number[]} parts @param {unknown} thread
     */
    const fromParts = async(parts, thread)=>{
        if (parts.length === 0)
        {
            return 0;
        }
        if (parts.length === 1)
        {
            return parts[0];
        }
        return makeMoniker(newState('composite', { parts }), thread);
    };

    /**
     * Joins two runs of components the way CreateGenericComposite does:
     * the last of the left composed with the first of the right through
     * ComposeWith -- an anti moniker cancelling what is before it, a file
     * path joining another -- for as long as each seam composes, then
     * anything a cancellation exposed composed again from the left.
     * Borrows the inputs; answers components it holds a reference on each of.
     *
     * @param {number[]} leftParts @param {number[]} rightParts @param {unknown} thread
     * @returns {Promise<number[]>}
     */
    const simplify = async(leftParts, rightParts, thread)=>{
        const left = [...leftParts];
        const right = [...rightParts];
        for (const part of [...left, ...right])
        {
            await addRef(part, thread);
        }
        let changed = false;
        while (left.length > 0 && right.length > 0)
        {
            const last = left[left.length - 1];
            const first = right[0];
            const composed = await outCall(slot=>call(last, SLOT.COMPOSE_WITH, [first, 1, slot],
                thread));
            if (composed.hr < 0)
            {
                if (composed.value !== 0)
                {
                    await release(composed.value, thread);
                }
                break;
            }
            changed = true;
            left.pop();
            right.shift();
            await releaseAll([last, first], thread);
            if (composed.value !== 0)
            {
                const pieces = await componentsOf(composed.value, thread);
                for (const piece of pieces)
                {
                    await addRef(piece, thread);
                }
                await release(composed.value, thread);
                left.push(...pieces);
            }
        }
        if (!changed)
        {
            return [...left, ...right];
        }
        return [...await settle(left, thread), ...await settle(right, thread)];
    };

    /**
     * Rebuilds a run of components from the left, composing each seam again.
     * Takes over the references it is given.
     *
     * @param {number[]} parts @param {unknown} thread
     * @returns {Promise<number[]>}
     */
    const settle = async(parts, thread)=>{
        /** @type {number[]} */
        let built = [];
        for (const part of parts)
        {
            const next = await simplify(built, [part], thread);
            await releaseAll([...built, part], thread);
            built = next;
        }
        return built;
    };

    /**
     * CreateGenericComposite.
     *
     * @param {number} left @param {number} right @param {unknown} thread
     * @returns {Promise<{ hr: number, value: number }>} the moniker, holding a reference
     */
    const compose = async(left, right, thread)=>{
        if (left === 0 || right === 0)
        {
            const only = left || right;
            if (only !== 0)
            {
                await addRef(only, thread);
            }
            return { hr: S_OK, value: only };
        }
        const parts = await simplify(await componentsOf(left, thread),
            await componentsOf(right, thread), thread);
        const value = await fromParts(parts, thread);
        return { hr: parts.length > 1 && value === 0 ? E_OUTOFMEMORY : S_OK, value };
    };

    /**
     * A moniker composed onto another where a composite binds: the
     * non-generic composition if the left one has one, the generic one
     * otherwise.
     *
     * @param {number} left @param {number} right @param {unknown} thread
     */
    const composeOnto = async(left, right, thread)=>{
        const own = await outCall(slot=>call(left, SLOT.COMPOSE_WITH, [right, 1, slot], thread));
        if (own.hr >= 0)
        {
            return own;
        }
        return own.hr === MK_E_NEEDGENERIC ? compose(left, right, thread) : own;
    };

    /**
     * A composite split as it binds: everything to the left of its last
     * component, as one moniker holding a reference, and the last.
     *
     * @param {MonikerState} state @param {unknown} thread
     */
    const splitLast = async(state, thread)=>{
        const parts = state.parts;
        const rightmost = parts[parts.length - 1];
        const rest = parts.slice(0, -1);
        for (const part of rest)
        {
            await addRef(part, thread);
        }
        return { rest: await fromParts(rest, thread), rightmost };
    };

    /**
     * IOleItemContainer::LockContainer(TRUE), held by the bind context for
     * as long as it holds its bound objects: the container stays running
     * while the item bound inside it is in use.
     *
     * @param {number} container @param {number} context @param {unknown} thread
     */
    const lockContainer = async(container, context, thread)=>{
        const hr = await call(container, SLOT.LOCK_CONTAINER, [1], thread);
        if (hr < 0)
        {
            return hr;
        }
        await addRef(container, thread);
        const object = env.registry.create(CLSID_CONTAINER_LOCK);
        const lock = object ? env.vtables.publish(object, IID_IUNKNOWN) >>> 0 : 0;
        if (!object || lock === 0)
        {
            object?.release();
            await call(container, SLOT.LOCK_CONTAINER, [0], thread);
            await release(container, thread);
            return E_OUTOFMEMORY;
        }
        object.state.container = container;
        const registered = await call(context, SLOT.REGISTER_OBJECT_BOUND, [lock], thread);
        await release(lock, thread);
        return registered;
    };
    env.registry.registerClass(CLSID_CONTAINER_LOCK, ()=>{
        const state = { container: 0 };
        /** @param {unknown} thread */
        const unlock = thread=>{
            const container = state.container;
            state.container = 0;
            return container === 0 ? Promise.resolve()
                : call(container, SLOT.LOCK_CONTAINER, [0], thread)
                    .then(()=>release(container, thread)).then(()=>undefined);
        };
        return {
            state,
            interfaces: [],
            lastRelease: ()=>unlock(env.callerThread()),
            destroy(){
                void unlock(env.callerThread());
            },
        };
    });

    /**
     * The item container to an item moniker's left, bound and locked.
     *
     * @param {number} context @param {number} left @param {unknown} thread
     * @param {boolean} lockMustHold  Whether a lock that fails fails the bind.
     */
    const itemContainer = async(context, left, thread, lockMustHold)=>{
        const container = await bindTo(left, context, 0, IID_IOLEITEMCONTAINER, thread);
        if (container.hr < 0)
        {
            return container;
        }
        const locked = await lockContainer(container.value, context, thread);
        if (locked < 0)
        {
            diverge('IOleItemContainer::LockContainer', `an item container did not lock: 0x${
                (locked >>> 0).toString(16)}`);
            if (lockMustHold)
            {
                await release(container.value, thread);
                return { hr: locked, value: 0 };
            }
        }
        return container;
    };

    /**
     * A class object, as a class moniker binds to one: CoGetClassObject with
     * the bind's class context, or the IClassActivator to its left.
     *
     * @param {string} clsid @param {number} context @param {number} left
     * @param {string} iid @param {number} out @param {unknown} thread
     */
    const bindClass = async(clsid, context, left, iid, out, thread)=>{
        const options = await bindOptions(context, thread);
        if (left === 0)
        {
            return env.getClassObject(clsid, options.classContext, iid, out, thread);
        }
        const activator = await bindTo(left, context, 0, IID_ICLASSACTIVATOR, thread);
        if (activator.hr < 0)
        {
            return activator.hr;
        }
        const hr = await lend(concat(guidBytes(clsid), guidBytes(iid)), guids=>call(
            activator.value, SLOT.GET_CLASS_OBJECT,
            [guids, options.classContext, options.locale, guids + GUID_SIZE, out], thread),
        E_OUTOFMEMORY);
        await release(activator.value, thread);
        return hr;
    };

    /**
     * IPersistFile::Load on an object made for a file, which the caller
     * releases. `path` is lent unless the program's own string is at hand.
     *
     * @param {number} file @param {string} path @param {number} mode @param {unknown} thread
     */
    const loadFile = (file, path, mode, thread)=>lend(encodeWide(path),
        name=>call(file, SLOT.PERSIST_FILE_LOAD, [name, mode], thread), E_OUTOFMEMORY);

    /**
     * An object of a class, loaded from a file through IPersistFile, as a
     * file moniker binds: the IPersistFile, holding a reference.
     *
     * @param {number} factory  IClassFactory to make it with.
     * @param {string} path @param {unknown} thread
     */
    const fileObjectFrom = async(factory, path, thread)=>{
        const made = await lend(guidBytes(IID_IPERSISTFILE), guid=>outCall(
            slot=>call(factory, SLOT.CREATE_INSTANCE, [0, guid, slot], thread)),
        { hr: E_OUTOFMEMORY, value: 0 });
        if (made.hr < 0 || made.value === 0)
        {
            return made.hr < 0 ? made : { hr: E_NOINTERFACE, value: 0 };
        }
        const hr = await loadFile(made.value, path, STGM_READ, thread);
        if (hr < 0)
        {
            await release(made.value, thread);
            return { hr, value: 0 };
        }
        return made;
    };

    /**
     * The object a file moniker names: the one running under it, else one
     * made of the file's class and loaded from it -- or, with a moniker to
     * its left, made by the class factory or class activator that names.
     *
     * @param {MonikerState} state @param {number} context @param {number} left
     * @param {unknown} thread
     * @returns {Promise<{ hr: number, value: number }>}
     */
    const fileObject = async(state, context, left, thread)=>{
        if (left === 0)
        {
            const running = await runningObject(context, state.self, thread);
            if (running.hr === S_OK && running.value !== 0)
            {
                return running;
            }
            const { hr, clsid } = await classOfFile(state.path);
            if (hr < 0)
            {
                return { hr, value: 0 };
            }
            const made = await lend(new Uint8Array(4), async slot=>{
                const created = await env.createInstance(clsid, 0, CLSCTX_SERVER,
                    IID_IPERSISTFILE, slot, thread);
                return { hr: created | 0, value: readU32(slot) };
            }, { hr: E_OUTOFMEMORY, value: 0 });
            if (made.hr < 0 || made.value === 0)
            {
                return made.hr < 0 ? made : { hr: E_NOINTERFACE, value: 0 };
            }
            const loaded = await loadFile(made.value, state.path, STGM_READ, thread);
            if (loaded < 0)
            {
                await release(made.value, thread);
                return { hr: loaded, value: 0 };
            }
            return made;
        }
        const factory = await bindTo(left, context, 0, IID_ICLASSFACTORY, thread);
        if (factory.hr >= 0)
        {
            const made = await fileObjectFrom(factory.value, state.path, thread);
            await release(factory.value, thread);
            return made;
        }
        if (factory.hr !== E_NOINTERFACE)
        {
            return factory;
        }
        const activator = await bindTo(left, context, 0, IID_ICLASSACTIVATOR, thread);
        if (activator.hr === E_NOINTERFACE)
        {
            return { hr: MK_E_INTERMEDIATEINTERFACENOTSUPPORTED, value: 0 };
        }
        if (activator.hr < 0)
        {
            return activator;
        }
        const { hr, clsid } = await classOfFile(state.path);
        const options = await bindOptions(context, thread);
        const classFactory = hr < 0 ? { hr, value: 0 } : await lend(
            concat(guidBytes(clsid), guidBytes(IID_ICLASSFACTORY)), guids=>outCall(
                slot=>call(activator.value, SLOT.GET_CLASS_OBJECT,
                    [guids, options.classContext, options.locale, guids + GUID_SIZE, slot],
                    thread)),
            { hr: E_OUTOFMEMORY, value: 0 });
        await release(activator.value, thread);
        if (classFactory.hr < 0)
        {
            return classFactory;
        }
        const made = await fileObjectFrom(classFactory.value, state.path, thread);
        await release(classFactory.value, thread);
        return made;
    };

    /**
     * The display name of any moniker, read and its block freed.
     *
     * @param {number} moniker @param {number} context @param {unknown} thread
     * @returns {Promise<{ hr: number, text: string }>}
     */
    const displayNameOf = async(moniker, context, thread)=>{
        const named = await outCall(slot=>call(moniker, SLOT.GET_DISPLAY_NAME, [context, 0, slot],
            thread));
        const text = takeString(named.value);
        return { hr: named.hr, text };
    };

    /**
     * The path of a file moniker of any implementation, or null for a
     * moniker that is none.
     *
     * @param {number} moniker @param {unknown} thread
     */
    const filePathOf = async(moniker, thread)=>{
        const state = await ours(moniker, thread);
        if (state)
        {
            return state.kind === 'file' ? state.path : null;
        }
        if (await systemKind(moniker, thread) !== MKSYS.FILEMONIKER)
        {
            return null;
        }
        const context = await makeBindContext();
        if (context === 0)
        {
            return null;
        }
        const named = await displayNameOf(moniker, context, thread);
        await release(context, thread);
        return named.hr < 0 ? null : named.text;
    };

    /**
     * Two file paths joined as a file moniker composes them: each parent
     * reference leading the right one takes a component off the end of the
     * left.
     *
     * @param {string} leftPath @param {string} rightPath
     * @returns {string | null} null where Windows answers MK_E_SYNTAX
     */
    const joinPaths = (leftPath, rightPath)=>{
        const left = pathPieces(leftPath);
        const right = pathPieces(rightPath);
        if ((left.length === 0 && right.length > 0)
            || (left.length === 2 && left[0] === '..'))
        {
            return null;
        }
        if (left[left.length - 1] === '\\')
        {
            left.pop();
        }
        let at = 0;
        while (left.length > 0 && right[at] === '..')
        {
            left.splice(Math.max(0, left.length - 2));
            at += right[at + 1] === '\\' ? 2 : 1;
        }
        const tail = right.slice(at);
        const joint = left.length > 0 && tail.length > 0 && tail[0] !== '\\' ? '\\' : '';
        return `${left.join('')}${joint}${tail.join('')}`;
    };

    /**
     * The common prefix of two file paths, whole components only.
     *
     * @param {string} mine @param {string} theirs
     * @returns {string | null} null when they share none
     */
    const commonPath = (mine, theirs)=>{
        const a = pathPieces(mine);
        const b = pathPieces(theirs);
        let same = 0;
        while (same < a.length && same < b.length && sameIgnoringCase(a[same], b[same]))
        {
            same++;
        }
        // A UNC path shares nothing below its server and share.
        const unc = a[0] === '\\' && a[1] === '\\';
        if (same === 0 || (unc && same <= 4 && (a.length > 4 || b.length > 4)))
        {
            return null;
        }
        return a.slice(0, same).join('');
    };

    /**
     * MonikerCommonPrefixWith: the prefix of two monikers of which at least
     * one is a composite, component by component. Two monikers neither of
     * which is a composite have none here; their own CommonPrefixWith is
     * what compares them.
     *
     * @param {number} mine @param {number} theirs @param {unknown} thread
     * @returns {Promise<{ hr: number, value: number }>}
     */
    const commonPrefix = async(mine, theirs, thread)=>{
        if (mine === 0 || theirs === 0)
        {
            return { hr: MK_E_NOPREFIX, value: 0 };
        }
        const a = await componentsOf(mine, thread);
        const b = await componentsOf(theirs, thread);
        const aComposite = a.length > 1 || a[0] !== mine;
        const bComposite = b.length > 1 || b[0] !== theirs;
        if (!aComposite && !bComposite)
        {
            return { hr: MK_E_NOPREFIX, value: 0 };
        }
        if (!aComposite || !bComposite)
        {
            const single = aComposite ? theirs : mine;
            const first = aComposite ? a[0] : b[0];
            if (await call(single, SLOT.IS_EQUAL, [first], thread) === S_OK)
            {
                await addRef(single, thread);
                return { hr: aComposite ? MK_S_HIM : MK_S_ME, value: single };
            }
            const prefix = await outCall(slot=>call(aComposite ? first : single,
                SLOT.COMMON_PREFIX_WITH, [aComposite ? single : first, slot], thread));
            if (prefix.hr < 0)
            {
                return prefix;
            }
            // The composite's first component is never all of the composite:
            // a prefix that is all of it is a part of the composite, and one
            // that is all of the single moniker is all of that one.
            const partOfComposite = aComposite ? MK_S_ME : MK_S_HIM;
            const allOfSingle = aComposite ? MK_S_HIM : MK_S_ME;
            const hr = prefix.hr === partOfComposite ? S_OK
                : prefix.hr === MK_S_US ? allOfSingle : prefix.hr;
            return { hr, value: prefix.value };
        }
        let same = 0;
        while (same < a.length && same < b.length
            && await call(a[same], SLOT.IS_EQUAL, [b[same]], thread) === S_OK)
        {
            same++;
        }
        if (same === 0)
        {
            return { hr: S_OK, value: 0 };
        }
        const parts = a.slice(0, same);
        for (const part of parts)
        {
            await addRef(part, thread);
        }
        const value = same === 1 ? parts[0]
            : await makeMoniker(newState('composite', { parts }), thread);
        const hr = same === a.length && same === b.length ? MK_S_US
            : same === a.length ? MK_S_ME : same === b.length ? MK_S_HIM : S_OK;
        return { hr: value === 0 ? E_OUTOFMEMORY : hr, value };
    };

    /**
     * The inverse of a run of components: each one's inverse, right to
     * left, composed.
     *
     * @param {number[]} parts @param {unknown} thread
     * @returns {Promise<{ hr: number, value: number }>}
     */
    const inverseOf = async(parts, thread)=>{
        let result = { hr: S_OK, value: 0 };
        for (let index = parts.length - 1; index >= 0; index--)
        {
            const inverse = await outCall(slot=>call(parts[index], SLOT.INVERSE, [slot], thread));
            if (inverse.hr < 0)
            {
                await releaseAll([result.value, inverse.value], thread);
                return { hr: inverse.hr, value: 0 };
            }
            if (index === parts.length - 1)
            {
                result = inverse;
                continue;
            }
            const next = await compose(result.value, inverse.value, thread);
            await releaseAll([result.value, inverse.value], thread);
            result = next;
        }
        return result;
    };

    /**
     * MonikerRelativePathTo, and a composite's RelativePathTo: past the
     * components the two share, the inverse of what is left of the first
     * composed with what is left of the second.
     *
     * @param {number} from @param {number} to @param {unknown} thread
     * @param {boolean} composite  Whether a first component with no match
     *        is asked for its own relative path, as a composite does.
     * @returns {Promise<{ hr: number, value: number }>}
     */
    const relativePath = async(from, to, thread, composite)=>{
        const a = await componentsOf(from, thread);
        const b = await componentsOf(to, thread);
        let same = 0;
        while (same < a.length && same < b.length
            && await call(a[same], SLOT.IS_EQUAL, [b[same]], thread) === S_OK)
        {
            same++;
        }
        /** @type {number[]} */
        let theirs = b.slice(same);
        /** @type {number[]} */
        const held = [];
        if (same === 0)
        {
            if (!composite)
            {
                await addRef(to, thread);
                return { hr: MK_S_HIM, value: to };
            }
            const relative = await outCall(slot=>call(a[0], SLOT.RELATIVE_PATH_TO, [b[0], slot],
                thread));
            if (relative.hr < 0)
            {
                return { hr: relative.hr, value: 0 };
            }
            held.push(relative.value);
            theirs = [relative.value, ...b.slice(1)];
            same = 1;
        }
        const mine = a.slice(same);
        let tail = { hr: S_OK, value: 0 };
        if (mine.length > 0)
        {
            tail = await inverseOf(mine, thread);
            if (tail.hr < 0)
            {
                await releaseAll(held, thread);
                return tail;
            }
        }
        theirs = theirs.filter(part=>part !== 0);
        for (const part of theirs)
        {
            await addRef(part, thread);
        }
        const rest = await fromParts(theirs, thread);
        await releaseAll(held, thread);
        if (tail.value === 0 && rest === 0)
        {
            await addRef(to, thread);
            return { hr: MK_S_HIM, value: to };
        }
        const result = await compose(tail.value, rest, thread);
        await releaseAll([tail.value, rest], thread);
        return result;
    };

    /**
     * The comparison data of any moniker, through its IROTData.
     *
     * @param {number} moniker @param {unknown} thread
     * @returns {Promise<{ hr: number, bytes: Uint8Array }>}
     */
    const comparisonOf = async(moniker, thread)=>{
        const data = await query(moniker, IID_IROTDATA, thread);
        if (data.hr < 0 || data.value === 0)
        {
            return { hr: E_NOTIMPL, bytes: new Uint8Array(0) };
        }
        const sized = await outCall(slot=>call(data.value, SLOT.GET_COMPARISON_DATA,
            [0, 0, slot], thread));
        let answer = { hr: sized.hr, bytes: new Uint8Array(0) };
        if (sized.hr >= 0 || sized.hr === E_OUTOFMEMORY)
        {
            const length = sized.value;
            answer = await lend(new Uint8Array(length + 4), async block=>{
                const hr = await call(data.value, SLOT.GET_COMPARISON_DATA,
                    [block, length, block + length], thread);
                const size = Math.min(readU32(block + length), length);
                return { hr, bytes: env.readMemory(block, size).slice() };
            }, { hr: E_OUTOFMEMORY, bytes: new Uint8Array(0) });
        }
        await release(data.value, thread);
        return answer;
    };

    /**
     * OleSaveToStream: the class, then what the object saves.
     *
     * @param {number} object @param {number} stream @param {unknown} thread
     */
    const saveToStream = async(object, stream, thread)=>{
        const classed = await lend(new Uint8Array(GUID_SIZE), async block=>{
            const hr = await call(object, SLOT.GET_CLASS_ID, [block], thread);
            return { hr, bytes: env.readMemory(block, GUID_SIZE).slice() };
        }, { hr: E_OUTOFMEMORY, bytes: new Uint8Array(0) });
        if (classed.hr < 0)
        {
            return classed.hr;
        }
        const written = await writeStream(stream, classed.bytes, thread);
        if (written < 0)
        {
            return written;
        }
        return call(object, SLOT.SAVE, [stream, 1], thread);
    };

    /**
     * OleLoadFromStream for a moniker: its class, an instance of it, and
     * what it loads.
     *
     * @param {number} stream @param {unknown} thread
     * @returns {Promise<{ hr: number, value: number }>}
     */
    const loadFromStream = async(stream, thread)=>{
        const header = await readExactly(stream, GUID_SIZE, STG_E_READFAULT, thread);
        if (header.hr < 0)
        {
            return { hr: header.hr, value: 0 };
        }
        const clsid = formatGuid(header.bytes);
        const kind = /** @type {MonikerState['kind'] | undefined} */ (Object.keys(CLASS_OF)
            .find(name=>CLASS_OF[/** @type {MonikerState['kind']} */ (name)] === clsid));
        let made;
        if (kind)
        {
            const pointer = await makeMoniker(defaultState(kind), thread);
            made = { hr: pointer === 0 ? E_OUTOFMEMORY : S_OK, value: pointer };
        }
        else
        {
            made = await lend(new Uint8Array(4), async slot=>{
                const hr = await env.createInstance(clsid, 0, CLSCTX_INPROC_SERVER, IID_IMONIKER,
                    slot, thread);
                return { hr: hr | 0, value: readU32(slot) };
            }, { hr: E_OUTOFMEMORY, value: 0 });
        }
        if (made.hr < 0 || made.value === 0)
        {
            return made.hr < 0 ? made : { hr: E_NOINTERFACE, value: 0 };
        }
        const hr = await call(made.value, SLOT.LOAD, [stream], thread);
        if (hr < 0)
        {
            await release(made.value, thread);
            return { hr, value: 0 };
        }
        return made;
    };

    /**
     * One string record of a persisted item moniker: a length, the ANSI
     * string with its terminator and, when the length runs past that, the
     * same string in UTF-16, which is the one that counts.
     *
     * @param {number} stream @param {unknown} thread
     * @returns {Promise<{ hr: number, text: string | null }>} null for an empty record
     */
    const loadItemString = async(stream, thread)=>{
        const length = await readExactly(stream, 4, E_FAIL, thread);
        if (length.hr < 0)
        {
            return { hr: E_FAIL, text: null };
        }
        const size = readU32Of(length.bytes, 0);
        if (size === 0)
        {
            return { hr: S_OK, text: null };
        }
        if (size > MAX_STRING * 4)
        {
            return { hr: E_FAIL, text: null };
        }
        const body = await readExactly(stream, size, E_FAIL, thread);
        if (body.hr < 0)
        {
            return { hr: E_FAIL, text: null };
        }
        const end = body.bytes.indexOf(0);
        if (end < 0)
        {
            return { hr: E_FAIL, text: null };
        }
        const wide = body.bytes.subarray(end + 1);
        if (wide.length === 0)
        {
            return { hr: S_OK, text: decodeAnsi(body.bytes.subarray(0, end)) };
        }
        if (wide.length % 2 !== 0)
        {
            return { hr: E_FAIL, text: null };
        }
        let text = '';
        for (let index = 0; index < wide.length; index += 2)
        {
            text += String.fromCharCode(wide[index] | (wide[index + 1] << 8));
        }
        return { hr: S_OK, text };
    };

    /** @param {string} text */
    const itemRecord = text=>{
        const ansi = concat(encodeAnsi(text), new Uint8Array(1));
        return concat(u32(ansi.length), ansi);
    };

    /**
     * What a file moniker persists: a word, the ANSI path with its length,
     * a word Windows writes as 0xFFFF and a marker word, five zero words,
     * then the length of a UTF-16 copy of the path -- written when the ANSI
     * one is not the path, when the path names a directory, or when it has a
     * character past Latin-1 -- or a zero length.
     *
     * @param {string} path
     */
    const fileRecord = path=>{
        const ansi = encodeAnsi(path);
        const lossy = decodeAnsi(ansi) !== path;
        const head = concat(u16(0), u32(ansi.length + 1), ansi, new Uint8Array(1),
            u16(FILE_MONIKER_UNKNOWN), u16(FILE_MONIKER_MARKER), new Uint8Array(20));
        const wide = lossy || path.endsWith('\\')
            || Array.from(path).some(c=>c.charCodeAt(0) > 0xff);
        if (!wide)
        {
            return concat(head, u32(0));
        }
        const units = encodeWide(path, false);
        return concat(head, u32(units.length + 6), u32(units.length), u16(FILE_MONIKER_WIDE_TAG),
            units);
    };

    /**
     * Reads a file moniker's record back. The constants are not checked,
     * as Windows does not check them; the lengths are.
     *
     * @param {number} stream @param {unknown} thread
     * @returns {Promise<{ hr: number, path: string }>}
     */
    const loadFileRecord = async(stream, thread)=>{
        /** @param {number} length */
        const take = length=>readExactly(stream, length, E_FAIL, thread);
        const failed = { hr: E_FAIL, path: '' };
        const lead = await take(6);
        if (lead.hr < 0)
        {
            return { hr: lead.hr, path: '' };
        }
        const ansiLength = readU32Of(lead.bytes, 2);
        if (ansiLength === 0 || ansiLength > MAX_STRING * 2)
        {
            return failed;
        }
        const ansi = await take(ansiLength);
        const constants = ansi.hr < 0 ? ansi : await take(4 + 20);
        const wideSize = constants.hr < 0 ? constants : await take(4);
        if (wideSize.hr < 0)
        {
            return { hr: wideSize.hr, path: '' };
        }
        const size = readU32Of(wideSize.bytes, 0);
        if (size === 0)
        {
            return { hr: S_OK, path: decodeAnsi(ansi.bytes.subarray(0, ansiLength - 1)) };
        }
        if (size < 6 || size > MAX_STRING * 2 + 6)
        {
            return failed;
        }
        const header = await take(6);
        if (header.hr < 0 || readU32Of(header.bytes, 0) !== size - 6
            || (header.bytes[4] | (header.bytes[5] << 8)) !== FILE_MONIKER_WIDE_TAG)
        {
            return failed;
        }
        const units = await take(size - 6);
        if (units.hr < 0)
        {
            return failed;
        }
        return { hr: S_OK, path: decodeWide(concat(units.bytes, new Uint8Array(2))) };
    };

    /**
     * IMoniker::Load.
     *
     * @param {MonikerState} state @param {number} stream @param {unknown} thread
     */
    const load = async(state, stream, thread)=>{
        switch (state.kind)
        {
            case 'item': {
                const delimiter = await loadItemString(stream, thread);
                if (delimiter.hr < 0)
                {
                    return delimiter.hr;
                }
                const name = await loadItemString(stream, thread);
                if (name.hr < 0)
                {
                    return name.hr;
                }
                state.delimiter = delimiter.text;
                state.name = name.text ?? '';
                return S_OK;
            }
            case 'file': {
                const record = await loadFileRecord(stream, thread);
                if (record.hr >= 0)
                {
                    state.path = record.path;
                }
                return record.hr;
            }
            case 'class': {
                const header = await readExactly(stream, GUID_SIZE + 4, STG_E_READFAULT, thread);
                if (header.hr < 0)
                {
                    return STG_E_READFAULT;
                }
                const length = readU32Of(header.bytes, GUID_SIZE);
                const extra = length === 0 ? { hr: S_OK, bytes: new Uint8Array(0) }
                    : length > MAX_STRING * 2 ? { hr: E_OUTOFMEMORY, bytes: new Uint8Array(0) }
                        : await readExactly(stream, length, STG_E_READFAULT, thread);
                if (extra.hr < 0)
                {
                    return extra.hr === E_OUTOFMEMORY ? E_OUTOFMEMORY : STG_E_READFAULT;
                }
                state.clsid = formatGuid(header.bytes);
                state.extra = extra.bytes;
                return S_OK;
            }
            case 'anti': {
                const read = await readStream(stream, 4, thread);
                if (read.hr < 0)
                {
                    return read.hr;
                }
                const count = read.bytes.length === 4 ? readU32Of(read.bytes, 0) : 0;
                if (count > MAX_ANTI_COUNT)
                {
                    return E_INVALIDARG;
                }
                state.count = count;
                return S_OK;
            }
            case 'composite': {
                if (state.parts.length > 0)
                {
                    return E_UNEXPECTED;
                }
                const counted = await readStream(stream, 4, thread);
                if (counted.hr !== S_OK || counted.bytes.length !== 4)
                {
                    return counted.hr < 0 ? counted.hr : STG_E_READFAULT;
                }
                const count = readU32Of(counted.bytes, 0);
                if (count < 2)
                {
                    return E_UNEXPECTED;
                }
                let built = { hr: S_OK, value: 0 };
                for (let index = 0; index < count; index++)
                {
                    const next = await loadFromStream(stream, thread);
                    if (next.hr < 0)
                    {
                        await release(built.value, thread);
                        return next.hr;
                    }
                    const joined = await compose(built.value, next.value, thread);
                    await releaseAll([built.value, next.value], thread);
                    built = joined;
                }
                const parts = built.value === 0 ? [] : await componentsOf(built.value, thread);
                for (const part of parts)
                {
                    await addRef(part, thread);
                }
                await releaseAll([built.value], thread);
                state.parts = parts;
                return S_OK;
            }
            default:
                return E_NOTIMPL;
        }
    };

    /**
     * IMoniker::Save.
     *
     * @param {MonikerState} state @param {number} stream @param {unknown} thread
     */
    const save = async(state, stream, thread)=>{
        switch (state.kind)
        {
            case 'item':
                return writeStream(stream, concat(
                    state.delimiter === null ? u32(0) : itemRecord(state.delimiter),
                    itemRecord(state.name)), thread);
            case 'file':
                return stream === 0 ? E_POINTER : writeStream(stream, fileRecord(state.path),
                    thread);
            case 'class':
                return writeStream(stream, concat(guidBytes(state.clsid), u32(state.extra.length),
                    state.extra), thread);
            case 'anti':
                return writeStream(stream, u32(state.count), thread);
            case 'composite': {
                if (state.parts.length === 0)
                {
                    return E_UNEXPECTED;
                }
                const written = await writeStream(stream, u32(state.parts.length), thread);
                if (written < 0)
                {
                    return written;
                }
                for (const part of state.parts)
                {
                    const hr = await saveToStream(part, stream, thread);
                    if (hr < 0)
                    {
                        return hr;
                    }
                }
                return S_OK;
            }
            default:
                return E_NOTIMPL;
        }
    };

    /**
     * IMoniker::GetSizeMax: Windows' over-estimates, which are what a
     * program sizes its buffer by.
     *
     * @param {MonikerState} state @param {number} out @param {unknown} thread
     */
    const sizeMax = async(state, out, thread)=>{
        if (out === 0)
        {
            return E_POINTER;
        }
        /** @type {number} */
        let size;
        switch (state.kind)
        {
            case 'item':
                size = 4 + 4 + (state.name.length + 1) * 4 + 18
                    + (state.delimiter === null ? 0 : (state.delimiter.length + 1) * 4);
                break;
            case 'file':
                size = 0x38 + 4 * state.path.length;
                break;
            case 'class':
                size = GUID_SIZE + 4 + state.extra.length;
                break;
            case 'anti':
                size = 4 + 16;
                break;
            case 'composite':
                // Fitted to the one composite whose estimate Windows' answer is
                // known for -- two item monikers, 160: sixteen past each
                // part's own, and twenty more.
                size = 20;
                for (const part of state.parts)
                {
                    const answer = await lend(new Uint8Array(8), async block=>{
                        const hr = await call(part, SLOT.GET_SIZE_MAX, [block], thread);
                        return { hr, size: readU32(block) };
                    }, { hr: E_OUTOFMEMORY, size: 0 });
                    if (answer.hr < 0)
                    {
                        return answer.hr;
                    }
                    size += answer.size + 16;
                }
                break;
            default:
                writeU64(out, 0n);
                return E_NOTIMPL;
        }
        writeU64(out, BigInt(size));
        return S_OK;
    };

    /**
     * IMoniker::BindToObject.
     *
     * @param {MonikerState} state @param {number[]} args @param {unknown} thread
     */
    const bindToObject = async(state, [context, left, iidAt, out], thread)=>{
        if (out === 0 && state.kind !== 'pointer' && state.kind !== 'class')
        {
            return E_POINTER;
        }
        const iid = iidAt === 0 ? IID_IUNKNOWN : readGuidAt(iidAt);
        switch (state.kind)
        {
            case 'item': {
                if (left === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                const container = await itemContainer(context, left, thread, false);
                if (container.hr < 0)
                {
                    return container.hr;
                }
                const speed = await bindSpeed(context, thread);
                const hr = await lend(encodeWide(state.name), name=>call(container.value,
                    SLOT.GET_OBJECT, [name, speed, context, iidAt, out], thread), E_OUTOFMEMORY);
                await release(container.value, thread);
                return hr;
            }
            case 'file': {
                writeU32(out, 0);
                const object = await fileObject(state, context, left, thread);
                if (object.hr < 0 || object.value === 0)
                {
                    return object.hr < 0 ? object.hr : E_FAIL;
                }
                const hr = await call(object.value, SLOT.QUERY_INTERFACE, [iidAt, out], thread);
                if (hr >= 0 && context !== 0)
                {
                    await call(context, SLOT.REGISTER_OBJECT_BOUND, [readU32(out)], thread);
                }
                await release(object.value, thread);
                return hr;
            }
            case 'class':
                return bindClass(state.clsid, context, left, iid, out, thread);
            case 'pointer':
                if (state.target === 0)
                {
                    return E_UNEXPECTED;
                }
                return call(state.target, SLOT.QUERY_INTERFACE, [iidAt, out], thread);
            case 'composite': {
                writeU32(out, 0);
                if (state.parts.length === 0)
                {
                    return E_UNEXPECTED;
                }
                if (left === 0)
                {
                    const running = await runningObject(context, state.self, thread);
                    if (running.hr < 0 || running.value === 0)
                    {
                        return E_INVALIDARG;
                    }
                    const hr = await call(running.value, SLOT.QUERY_INTERFACE, [iidAt, out],
                        thread);
                    await release(running.value, thread);
                    return hr;
                }
                const { rest, rightmost } = await splitLast(state, thread);
                const composed = await composeOnto(left, rest, thread);
                await release(rest, thread);
                if (composed.hr < 0)
                {
                    return composed.hr;
                }
                const hr = await call(rightmost, SLOT.BIND_TO_OBJECT,
                    [context, composed.value, iidAt, out], thread);
                await release(composed.value, thread);
                return hr;
            }
            default:
                return E_NOTIMPL;
        }
    };

    /**
     * IMoniker::BindToStorage.
     *
     * @param {MonikerState} state @param {number[]} args @param {unknown} thread
     */
    const bindToStorage = async(state, [context, left, iidAt, out], thread)=>{
        switch (state.kind)
        {
            case 'item': {
                writeU32(out, 0);
                if (left === 0)
                {
                    return E_INVALIDARG;
                }
                const container = await itemContainer(context, left, thread, false);
                if (container.hr < 0)
                {
                    return container.hr;
                }
                const hr = await lend(encodeWide(state.name), name=>call(container.value,
                    SLOT.GET_OBJECT_STORAGE, [name, context, iidAt, out], thread), E_OUTOFMEMORY);
                await release(container.value, thread);
                return hr;
            }
            case 'file': {
                if (context === 0)
                {
                    return E_INVALIDARG;
                }
                const options = await bindOptions(context, thread);
                if (left !== 0)
                {
                    diverge('IMoniker::BindToStorage', 'a file moniker with a moniker to its left');
                    return E_NOTIMPL;
                }
                const iid = readGuidAt(iidAt);
                if (iid === IID_ISTORAGE)
                {
                    return env.openStorage(state.path, options.mode, out, thread);
                }
                return iid === IID_ISTREAM || iid === IID_ILOCKBYTES ? E_FAIL : E_NOINTERFACE;
            }
            case 'class':
            case 'pointer':
                return bindToObject(state, [context, left, iidAt, out], thread);
            case 'composite': {
                writeU32(out, 0);
                if (state.parts.length === 0)
                {
                    return E_UNEXPECTED;
                }
                const { rest, rightmost } = await splitLast(state, thread);
                let composed = { hr: S_OK, value: rest };
                if (left !== 0)
                {
                    composed = await composeOnto(left, rest, thread);
                    await release(rest, thread);
                    if (composed.hr < 0)
                    {
                        return composed.hr;
                    }
                }
                const hr = await call(rightmost, SLOT.BIND_TO_STORAGE,
                    [context, composed.value, iidAt, out], thread);
                await release(composed.value, thread);
                return hr;
            }
            default:
                return E_NOTIMPL;
        }
    };

    /**
     * IMoniker::Reduce. None of the system monikers reduces to anything but
     * itself; a composite reduces when one of its components does.
     *
     * @param {MonikerState} state @param {number[]} args @param {unknown} thread
     */
    const reduce = async(state, [context, howFar, , out], thread)=>{
        const strict = state.kind === 'file' || state.kind === 'composite';
        if (out === 0 || (strict && context === 0))
        {
            return strict ? E_INVALIDARG : E_POINTER;
        }
        if (state.kind === 'composite' && state.parts.length > 0)
        {
            /** @type {number[]} */
            const reduced = [];
            let changed = false;
            for (let index = 0; index < state.parts.length; index++)
            {
                const part = state.parts[index];
                const prefix = state.parts.slice(0, index);
                for (const piece of prefix)
                {
                    await addRef(piece, thread);
                }
                const leftOf = await fromParts(prefix, thread);
                const answer = await lend(concat(u32(leftOf), new Uint8Array(4)), async block=>{
                    const hr = await call(part, SLOT.REDUCE, [context, howFar,
                        leftOf === 0 ? 0 : block, block + 4], thread);
                    return { hr, value: readU32(block + 4), left: readU32(block) };
                }, { hr: E_OUTOFMEMORY, value: 0, left: leftOf });
                // A component that replaced what is to its left has let go of
                // the one it was given.
                await releaseAll([answer.left !== leftOf ? answer.left : leftOf], thread);
                if (answer.hr < 0)
                {
                    await releaseAll(reduced, thread);
                    return answer.hr;
                }
                changed = changed || answer.value !== part;
                reduced.push(answer.value);
            }
            if (changed)
            {
                let built = { hr: S_OK, value: 0 };
                for (const part of reduced)
                {
                    const next = await compose(built.value, part, thread);
                    await releaseAll([built.value, part], thread);
                    built = next;
                }
                writeU32(out, built.value);
                return built.hr;
            }
            await releaseAll(reduced, thread);
        }
        await addRef(state.self, thread);
        writeU32(out, state.self);
        return MK_S_REDUCED_TO_SELF;
    };

    /**
     * IMoniker::ComposeWith.
     *
     * @param {MonikerState} state @param {number[]} args @param {unknown} thread
     */
    const composeWith = async(state, [right, onlyIfNotGeneric, out], thread)=>{
        if (out === 0)
        {
            return E_POINTER;
        }
        if (right === 0 && state.kind !== 'composite')
        {
            return state.kind === 'file' ? E_INVALIDARG : E_POINTER;
        }
        writeU32(out, 0);
        /** @param {{ hr: number, value: number }} made */
        const answer = made=>{
            writeU32(out, made.value);
            return made.hr;
        };
        const generic = async()=>(onlyIfNotGeneric !== 0 ? MK_E_NEEDGENERIC
            : answer(await compose(state.self, right, thread)));
        if (state.kind === 'anti' || state.kind === 'composite')
        {
            return generic();
        }
        const other = await ours(right, thread);
        if (other && other.kind === 'anti')
        {
            // Each anti moniker cancels one component to its left; a class
            // moniker is cancelled whatever the count.
            if (other.count <= 1 || state.kind === 'class')
            {
                return S_OK;
            }
            const rest = await makeAnti(other.count - 1, thread);
            writeU32(out, rest);
            return rest === 0 ? E_OUTOFMEMORY : S_OK;
        }
        if (state.kind === 'file')
        {
            const path = await filePathOf(right, thread);
            if (path !== null)
            {
                const joined = joinPaths(state.path, path);
                return joined === null ? MK_E_SYNTAX
                    : answerMoniker(newState('file', { path: normalisePath(joined) }), out,
                        thread);
            }
        }
        return generic();
    };

    /**
     * IMoniker::Enum: a composite's components, either way round; nothing
     * for any other moniker, which has none.
     *
     * @param {MonikerState} state @param {number[]} args @param {unknown} thread
     */
    const enumerate = async(state, [forward, out], thread)=>{
        if (state.kind === 'pointer')
        {
            if (out === 0)
            {
                return E_INVALIDARG;
            }
            writeU32(out, 0);
            return E_NOTIMPL;
        }
        if (out === 0)
        {
            return E_INVALIDARG;
        }
        writeU32(out, 0);
        if (state.kind !== 'composite')
        {
            return S_OK;
        }
        const items = forward !== 0 ? [...state.parts] : [...state.parts].reverse();
        for (const item of items)
        {
            await addRef(item, thread);
        }
        pendingEnum = { items, position: 0 };
        const object = env.registry.create(CLSID_MONIKER_ENUM);
        pendingEnum = null;
        const pointer = object ? env.vtables.publish(object, IID_IENUMMONIKER) >>> 0 : 0;
        if (pointer === 0)
        {
            object?.release();
            await releaseAll(items, thread);
            return E_OUTOFMEMORY;
        }
        writeU32(out, pointer);
        return S_OK;
    };

    /**
     * IMoniker::IsEqual: the same kind of system moniker naming the same
     * thing. An item's delimiter does not count, nor a class moniker's
     * extra data.
     *
     * @param {MonikerState} state @param {number} other @param {unknown} thread
     */
    const isEqual = async(state, other, thread)=>{
        if (other === 0)
        {
            return E_INVALIDARG;
        }
        const theirs = await ours(other, thread);
        if (!theirs || theirs.kind !== state.kind)
        {
            return S_FALSE;
        }
        switch (state.kind)
        {
            case 'item':
                return sameIgnoringCase(state.name, theirs.name) ? S_OK : S_FALSE;
            case 'file':
                return sameIgnoringCase(state.path, theirs.path) ? S_OK : S_FALSE;
            case 'class':
                return state.clsid === theirs.clsid ? S_OK : S_FALSE;
            case 'pointer':
                return state.target === theirs.target ? S_OK : S_FALSE;
            case 'anti':
                return state.count === theirs.count ? S_OK : S_FALSE;
            default: {
                if (state.parts.length !== theirs.parts.length)
                {
                    return S_FALSE;
                }
                for (let index = 0; index < state.parts.length; index++)
                {
                    const hr = await call(state.parts[index], SLOT.IS_EQUAL,
                        [theirs.parts[index]], thread);
                    if (hr !== S_OK)
                    {
                        return hr;
                    }
                }
                return S_OK;
            }
        }
    };

    /**
     * IMoniker::Hash.
     *
     * @param {MonikerState} state @param {number} out @param {unknown} thread
     */
    const hash = async(state, out, thread)=>{
        if (out === 0)
        {
            return E_POINTER;
        }
        let value = 0;
        switch (state.kind)
        {
            case 'item':
                value = itemHash(state.name);
                break;
            case 'file':
                value = fileHash(state.path);
                break;
            case 'class':
                value = readU32Of(guidBytes(state.clsid), 0);
                break;
            case 'pointer':
                value = state.target;
                break;
            case 'anti':
                value = 0x80000000 | state.count;
                break;
            default: {
                if (state.parts.length === 0)
                {
                    return E_UNEXPECTED;
                }
                for (const part of state.parts)
                {
                    const answer = await outCall(slot=>call(part, SLOT.HASH, [slot], thread));
                    if (answer.hr < 0)
                    {
                        return answer.hr;
                    }
                    value ^= answer.value;
                }
            }
        }
        writeU32(out, value);
        return S_OK;
    };

    /**
     * IMoniker::IsRunning.
     *
     * @param {MonikerState} state @param {number[]} args @param {unknown} thread
     */
    const isRunning = async(state, [context, left, newlyRunning], thread)=>{
        /** Whether the running object table has this moniker. */
        const inTable = ()=>askTable(context, SLOT.ROT_IS_RUNNING, ()=>[state.self], thread);
        switch (state.kind)
        {
            case 'class':
                return E_NOTIMPL;
            case 'pointer':
                return S_OK;
            case 'file':
                if (newlyRunning !== 0
                    && await call(newlyRunning, SLOT.IS_EQUAL, [state.self], thread) === S_OK)
                {
                    return S_OK;
                }
                return context === 0 ? E_POINTER : inTable();
            case 'anti':
                return context === 0 ? E_INVALIDARG : inTable();
            case 'item': {
                if (context === 0)
                {
                    return E_INVALIDARG;
                }
                if (left === 0)
                {
                    return newlyRunning !== 0 ? isEqual(state, newlyRunning, thread) : inTable();
                }
                // The container has to be running before an item in it can be.
                const running = await call(left, SLOT.IS_RUNNING, [context, 0, 0], thread);
                if (running !== S_OK)
                {
                    return running;
                }
                const container = await bindTo(left, context, 0, IID_IOLEITEMCONTAINER, thread);
                if (container.hr < 0)
                {
                    return container.hr;
                }
                const hr = await lend(encodeWide(state.name), name=>call(container.value,
                    SLOT.CONTAINER_IS_RUNNING, [name], thread), E_OUTOFMEMORY);
                await release(container.value, thread);
                return hr;
            }
            default: {
                if (context === 0)
                {
                    return E_INVALIDARG;
                }
                if (left !== 0)
                {
                    const whole = await compose(left, state.self, thread);
                    if (whole.hr < 0 || whole.value === 0)
                    {
                        return whole.hr < 0 ? whole.hr : S_FALSE;
                    }
                    const hr = await call(whole.value, SLOT.IS_RUNNING, [context, 0, newlyRunning],
                        thread);
                    await release(whole.value, thread);
                    return hr;
                }
                if (newlyRunning !== 0)
                {
                    return isEqual(state, newlyRunning, thread);
                }
                if (await inTable() === S_OK)
                {
                    return S_OK;
                }
                if (state.parts.length === 0)
                {
                    return E_UNEXPECTED;
                }
                const { rest, rightmost } = await splitLast(state, thread);
                const hr = await call(rightmost, SLOT.IS_RUNNING, [context, rest, 0], thread);
                await release(rest, thread);
                return hr;
            }
        }
    };

    /**
     * IMoniker::GetTimeOfLastChange.
     *
     * @param {MonikerState} state @param {number[]} args @param {unknown} thread
     */
    const timeOfLastChange = async(state, [context, left, out], thread)=>{
        /** @param {number} moniker */
        const fromTable = moniker=>askTable(context, SLOT.ROT_GET_TIME_OF_LAST_CHANGE,
            ()=>[moniker, out], thread);
        switch (state.kind)
        {
            case 'class':
                return MK_E_UNAVAILABLE;
            case 'pointer':
            case 'anti':
                return E_NOTIMPL;
            case 'file': {
                if (out === 0)
                {
                    return E_POINTER;
                }
                if (left !== 0)
                {
                    return E_INVALIDARG;
                }
                if (await fromTable(state.self) >= 0)
                {
                    return S_OK;
                }
                const info = await env.fileInfo(state.path);
                if (!info)
                {
                    return MK_E_NOOBJECT;
                }
                writeU64(out, info.lastWrite);
                return S_OK;
            }
            case 'item': {
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                if (left === 0)
                {
                    return MK_E_NOTBINDABLE;
                }
                const whole = await compose(left, state.self, thread);
                if (whole.hr < 0)
                {
                    return whole.hr;
                }
                const known = whole.value === 0 ? S_FALSE : await fromTable(whole.value);
                await release(whole.value, thread);
                return known === S_OK ? S_OK
                    : call(left, SLOT.GET_TIME_OF_LAST_CHANGE, [context, 0, out], thread);
            }
            default: {
                if (out === 0 || context === 0)
                {
                    return E_INVALIDARG;
                }
                if (state.parts.length === 0)
                {
                    return E_UNEXPECTED;
                }
                const { rest, rightmost } = await splitLast(state, thread);
                let leftOf = rest;
                let whole = state.self;
                if (left !== 0)
                {
                    const composed = await composeOnto(left, rest, thread);
                    await release(rest, thread);
                    if (composed.hr < 0)
                    {
                        return composed.hr;
                    }
                    leftOf = composed.value;
                    const all = leftOf === 0 ? { hr: S_OK, value: 0 }
                        : await composeOnto(leftOf, rightmost, thread);
                    if (all.hr < 0)
                    {
                        await release(leftOf, thread);
                        return all.hr;
                    }
                    whole = all.value;
                }
                else
                {
                    await addRef(whole, thread);
                }
                const known = whole === 0 ? S_FALSE : await fromTable(whole);
                const hr = known === S_OK ? S_OK : await call(rightmost,
                    SLOT.GET_TIME_OF_LAST_CHANGE, [context, leftOf, out], thread);
                await releaseAll([whole, leftOf], thread);
                return hr;
            }
        }
    };

    /**
     * IMoniker::Inverse: an anti moniker for one that is not a composite,
     * the components' inverses in reverse for a composite, and none for an
     * anti moniker itself.
     *
     * @param {MonikerState} state @param {number} out @param {unknown} thread
     */
    const inverse = async(state, out, thread)=>{
        if (out === 0)
        {
            return state.kind === 'composite' ? E_INVALIDARG : E_POINTER;
        }
        writeU32(out, 0);
        if (state.kind === 'anti')
        {
            return MK_E_NOINVERSE;
        }
        if (state.kind !== 'composite')
        {
            const anti = await makeAnti(1, thread);
            writeU32(out, anti);
            return anti === 0 ? E_OUTOFMEMORY : S_OK;
        }
        if (state.parts.length === 0)
        {
            return E_UNEXPECTED;
        }
        const result = await inverseOf(state.parts, thread);
        writeU32(out, result.value);
        return result.hr;
    };

    /**
     * IMoniker::CommonPrefixWith.
     *
     * @param {MonikerState} state @param {number[]} args @param {unknown} thread
     */
    const commonPrefixWith = async(state, [other, out], thread)=>{
        /** @param {number} moniker @param {number} hr */
        const answer = async(moniker, hr)=>{
            await addRef(moniker, thread);
            writeU32(out, moniker);
            return hr;
        };
        /** @param {{ hr: number, value: number }} made */
        const answerMade = made=>{
            writeU32(out, made.value);
            return made.hr;
        };
        if (state.kind === 'file' && out === 0)
        {
            return E_POINTER;
        }
        if (out === 0 || other === 0)
        {
            if (out !== 0)
            {
                writeU32(out, 0);
            }
            return E_INVALIDARG;
        }
        writeU32(out, 0);
        const theirs = await ours(other, thread);
        switch (state.kind)
        {
            case 'pointer':
                return await isEqual(state, other, thread) === S_OK ? answer(state.self, MK_S_US)
                    : MK_E_NOPREFIX;
            case 'item':
                if (await isEqual(state, other, thread) === S_OK)
                {
                    return answer(state.self, MK_S_US);
                }
                if (theirs && theirs.kind === 'composite')
                {
                    // Asked the other way round, the composite answers with
                    // its own first component.
                    const reverse = await outCall(slot=>call(other, SLOT.COMMON_PREFIX_WITH,
                        [state.self, slot], thread));
                    return answerMade({ hr: reverse.hr === MK_S_HIM ? MK_S_ME : reverse.hr,
                        value: reverse.value });
                }
                return answerMade(await commonPrefix(state.self, other, thread));
            case 'class':
                if (theirs && theirs.kind === 'class')
                {
                    return theirs.clsid === state.clsid ? answer(state.self, MK_S_US)
                        : MK_E_NOPREFIX;
                }
                return answerMade(await commonPrefix(state.self, other, thread));
            case 'anti':
                if (theirs && theirs.kind === 'anti')
                {
                    if (state.count <= theirs.count)
                    {
                        return answer(state.self, state.count === theirs.count ? MK_S_US : MK_S_ME);
                    }
                    return answer(other, MK_S_HIM);
                }
                return answerMade(await commonPrefix(state.self, other, thread));
            case 'file': {
                const path = await filePathOf(other, thread);
                if (path === null)
                {
                    return answerMade(await commonPrefix(state.self, other, thread));
                }
                if (sameIgnoringCase(path, state.path))
                {
                    return answer(state.self, MK_S_US);
                }
                const common = commonPath(state.path, path);
                if (common === null)
                {
                    return MK_E_NOPREFIX;
                }
                if (sameIgnoringCase(common, state.path))
                {
                    return answer(state.self, MK_S_ME);
                }
                if (sameIgnoringCase(common, path))
                {
                    return answer(other, MK_S_HIM);
                }
                return answerMoniker(newState('file', { path: common }), out, thread);
            }
            default: {
                if (state.parts.length === 0)
                {
                    return E_UNEXPECTED;
                }
                if (!theirs || theirs.kind !== 'composite')
                {
                    return await call(state.parts[0], SLOT.IS_EQUAL, [other], thread) === S_OK
                        ? answer(state.parts[0], MK_S_HIM) : MK_E_NOPREFIX;
                }
                /** @type {number[]} */
                const prefix = [];
                let whole = true;
                const shortest = Math.min(state.parts.length, theirs.parts.length);
                for (let index = 0; index < shortest; index++)
                {
                    const common = await outCall(slot=>call(state.parts[index],
                        SLOT.COMMON_PREFIX_WITH, [theirs.parts[index], slot], thread));
                    if (common.hr < 0)
                    {
                        break;
                    }
                    prefix.push(common.value);
                    if (common.hr !== MK_S_US)
                    {
                        whole = false;
                        break;
                    }
                }
                if (prefix.length === 0)
                {
                    return MK_E_NOPREFIX;
                }
                const value = await fromParts(prefix, thread);
                writeU32(out, value);
                if (value === 0)
                {
                    return E_OUTOFMEMORY;
                }
                const mineAll = whole && prefix.length === state.parts.length;
                const theirsAll = whole && prefix.length === theirs.parts.length;
                return mineAll && theirsAll ? MK_S_US : mineAll ? MK_S_ME
                    : theirsAll ? MK_S_HIM : S_OK;
            }
        }
    };

    /**
     * IMoniker::RelativePathTo.
     *
     * @param {MonikerState} state @param {number[]} args @param {unknown} thread
     */
    const relativePathTo = async(state, [other, out], thread)=>{
        switch (state.kind)
        {
            case 'class':
                if (out === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, 0);
                return MK_E_NOTBINDABLE;
            case 'pointer':
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                return other === 0 ? E_INVALIDARG : E_NOTIMPL;
            case 'item':
                if (out === 0 || other === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                return MK_E_NOTBINDABLE;
            case 'anti':
                if (out === 0 || other === 0)
                {
                    return E_INVALIDARG;
                }
                await addRef(other, thread);
                writeU32(out, other);
                return MK_S_HIM;
            case 'file': {
                if (out === 0)
                {
                    return E_POINTER;
                }
                if (other === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                const path = await filePathOf(other, thread);
                const a = pathPieces(state.path);
                const b = path === null ? [] : pathPieces(path);
                let same = 0;
                while (same < a.length && same < b.length && sameIgnoringCase(a[same], b[same]))
                {
                    same++;
                }
                if (path === null || same === 0)
                {
                    await addRef(other, thread);
                    writeU32(out, other);
                    return MK_S_HIM;
                }
                const up = a.slice(same).filter(piece=>piece !== '\\').map(()=>'..\\').join('');
                return answerMoniker(newState('file', { path: `${up}${b.slice(same).join('')}` }),
                    out, thread);
            }
            default: {
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                if (other === 0)
                {
                    return E_INVALIDARG;
                }
                const result = await relativePath(state.self, other, thread, true);
                writeU32(out, result.value);
                return result.hr;
            }
        }
    };

    /**
     * IMoniker::GetDisplayName.
     *
     * @param {MonikerState} state @param {number[]} args @param {unknown} thread
     */
    const getDisplayName = async(state, [context, left, out], thread)=>{
        if (state.kind === 'pointer' || state.kind === 'composite')
        {
            if (out === 0 || context === 0)
            {
                if (out !== 0)
                {
                    writeU32(out, 0);
                }
                return E_INVALIDARG;
            }
            if (state.kind === 'pointer')
            {
                return E_NOTIMPL;
            }
            if (state.parts.length === 0)
            {
                return E_INVALIDARG;
            }
            let text = '';
            for (const part of state.parts)
            {
                const named = await displayNameOf(part, context, thread);
                if (named.hr < 0)
                {
                    return named.hr;
                }
                text += named.text;
            }
            return answerString(text, out);
        }
        if (out === 0)
        {
            return E_POINTER;
        }
        if (left !== 0)
        {
            return state.kind === 'anti' ? E_NOTIMPL : E_INVALIDARG;
        }
        switch (state.kind)
        {
            case 'item':
                return answerString(`${state.delimiter ?? ''}${state.name}`, out);
            case 'file':
                return answerString(state.path, out);
            case 'class':
                return answerString(classDisplayName(state), out);
            default:
                return answerString('\\..'.repeat(state.count), out);
        }
    };

    /**
     * The IParseDisplayName an object answers, which the caller releases.
     *
     * @param {(iid: string) => Promise<{ hr: number, value: number }>} bind
     *        Binds to the object for an interface.
     * @param {unknown} thread
     */
    const parserOf = async(bind, thread)=>{
        const parser = await bind(IID_IPARSEDISPLAYNAME);
        if (parser.hr >= 0)
        {
            return parser;
        }
        // A class object that cannot parse may still make something that can.
        const factory = await bind(IID_ICLASSFACTORY);
        if (factory.hr < 0)
        {
            return factory;
        }
        const made = await lend(guidBytes(IID_IPARSEDISPLAYNAME), guid=>outCall(
            slot=>call(factory.value, SLOT.CREATE_INSTANCE, [0, guid, slot], thread)),
        { hr: E_OUTOFMEMORY, value: 0 });
        await release(factory.value, thread);
        return made;
    };

    /**
     * Has an IParseDisplayName parse a name, then lets it go.
     *
     * @param {{ hr: number, value: number }} parser @param {number[]} args
     *        The bind context, the name, and where the count and moniker go.
     * @param {unknown} thread
     */
    const parseWith = async(parser, args, thread)=>{
        if (parser.hr < 0)
        {
            return parser.hr;
        }
        const hr = await call(parser.value, SLOT.PARSE, args, thread);
        await release(parser.value, thread);
        return hr;
    };

    /**
     * IMoniker::ParseDisplayName: the object the moniker names parses what
     * is left of a display name, and answers the moniker for that part.
     *
     * @param {MonikerState} state @param {number[]} args @param {unknown} thread
     */
    const parseDisplayName = async(state, [context, left, name, eaten, out], thread)=>{
        const parseArgs = [context, name, eaten, out];
        switch (state.kind)
        {
            case 'item': {
                if (left === 0)
                {
                    return MK_E_SYNTAX;
                }
                const container = await itemContainer(context, left, thread, true);
                if (container.hr < 0)
                {
                    return container.hr;
                }
                const speed = await bindSpeed(context, thread);
                const iidAt = (state.name.length + 1) * 2;
                const parser = await lend(concat(encodeWide(state.name),
                    guidBytes(IID_IPARSEDISPLAYNAME)), block=>outCall(
                    slot=>call(container.value, SLOT.GET_OBJECT,
                        [block, speed, context, block + iidAt, slot], thread)),
                { hr: E_OUTOFMEMORY, value: 0 });
                await release(container.value, thread);
                return parseWith(parser, parseArgs, thread);
            }
            case 'class':
                return parseWith(await parserOf(iid=>lend(new Uint8Array(4), async slot=>{
                    const hr = await bindClass(state.clsid, context, left, iid, slot, thread);
                    return { hr: hr | 0, value: readU32(slot) };
                }, { hr: E_OUTOFMEMORY, value: 0 }), thread), parseArgs, thread);
            case 'pointer':
                if (left !== 0)
                {
                    return MK_E_SYNTAX;
                }
                if (state.target === 0)
                {
                    return E_UNEXPECTED;
                }
                return parseWith(await query(state.target, IID_IPARSEDISPLAYNAME, thread),
                    parseArgs, thread);
            case 'file': {
                // The file's class parses it if its class object can; the
                // object bound from the file does otherwise.
                const { hr, clsid } = await classOfFile(state.path);
                const options = await bindOptions(context, thread);
                const fromClass = hr < 0 ? { hr, value: 0 } : await lend(new Uint8Array(4),
                    async slot=>({ hr: (await env.getClassObject(clsid, options.classContext,
                        IID_IPARSEDISPLAYNAME, slot, thread)) | 0, value: readU32(slot) }),
                    { hr: E_OUTOFMEMORY, value: 0 });
                const parser = fromClass.hr >= 0 ? fromClass
                    : await bindTo(state.self, context, left, IID_IPARSEDISPLAYNAME, thread);
                return parseWith(parser, parseArgs, thread);
            }
            case 'composite': {
                if (context === 0)
                {
                    return E_INVALIDARG;
                }
                if (state.parts.length === 0)
                {
                    return E_UNEXPECTED;
                }
                const { rest, rightmost } = await splitLast(state, thread);
                const hr = await call(rightmost, SLOT.PARSE_DISPLAY_NAME,
                    [context, rest, name, eaten, out], thread);
                await release(rest, thread);
                return hr;
            }
            default:
                return E_NOTIMPL;
        }
    };

    /**
     * IROTData::GetComparisonData.
     *
     * @param {MonikerState} state @param {number[]} args @param {unknown} thread
     */
    const getComparisonData = async(state, [buffer, max, sizeOut], thread)=>{
        if (sizeOut === 0)
        {
            return E_INVALIDARG;
        }
        let data = comparisonDataOf(state);
        if (state.kind === 'composite')
        {
            if (state.parts.length === 0)
            {
                return E_UNEXPECTED;
            }
            const pieces = [guidBytes(CLSID_COMPOSITE_MONIKER)];
            for (const part of state.parts)
            {
                const piece = await comparisonOf(part, thread);
                if (piece.hr < 0)
                {
                    writeU32(sizeOut, 0);
                    return piece.hr;
                }
                pieces.push(piece.bytes);
            }
            data = concat(...pieces);
        }
        if (!data)
        {
            return E_NOTIMPL;
        }
        writeU32(sizeOut, data.length);
        if (max < data.length || buffer === 0)
        {
            return E_OUTOFMEMORY;
        }
        env.writeMemory(buffer, data);
        return S_OK;
    };

    /**
     * One IMoniker method: the arguments unsigned, the moniker known by its
     * pointer, and the caller's thread for whatever it calls.
     *
     * @param {string} name @param {number} argBytes
     * @param {(state: MonikerState, args: number[], thread: unknown) => Promise<number>
     *          | number} body
     * @returns {import('./objects.js').ComMethod}
     */
    const monikerMethod = (name, argBytes, body)=>({
        name,
        argBytes,
        invoke: (object, args)=>Promise.resolve(body(adopt(object),
            args.map(value=>value >>> 0), env.callerThread())).then(hr=>hr | 0),
    });

    /** IMoniker after IUnknown: IPersist's, IPersistStream's, then its own. */
    const MONIKER_METHODS = [
        monikerMethod('GetClassID', 8, (state, [out])=>{
            if (out === 0)
            {
                return E_POINTER;
            }
            env.writeMemory(out, guidBytes(classOf(state)));
            return S_OK;
        }),
        // Windows' monikers never change once made, so none is ever dirty.
        monikerMethod('IsDirty', 4, ()=>S_FALSE),
        monikerMethod('Load', 8, (state, [stream], thread)=>load(state, stream, thread)),
        monikerMethod('Save', 12, (state, [stream], thread)=>save(state, stream, thread)),
        monikerMethod('GetSizeMax', 8, (state, [out], thread)=>sizeMax(state, out, thread)),
        monikerMethod('BindToObject', 20, bindToObject),
        monikerMethod('BindToStorage', 20, bindToStorage),
        monikerMethod('Reduce', 20, reduce),
        monikerMethod('ComposeWith', 16, composeWith),
        monikerMethod('Enum', 12, enumerate),
        monikerMethod('IsEqual', 8, (state, [other], thread)=>isEqual(state, other, thread)),
        monikerMethod('Hash', 8, (state, [out], thread)=>hash(state, out, thread)),
        monikerMethod('IsRunning', 16, isRunning),
        monikerMethod('GetTimeOfLastChange', 16, timeOfLastChange),
        monikerMethod('Inverse', 8, (state, [out], thread)=>inverse(state, out, thread)),
        monikerMethod('CommonPrefixWith', 12, commonPrefixWith),
        monikerMethod('RelativePathTo', 12, relativePathTo),
        monikerMethod('GetDisplayName', 16, getDisplayName),
        monikerMethod('ParseDisplayName', 24, parseDisplayName),
        monikerMethod('IsSystemMoniker', 8, (state, [out])=>{
            if (out === 0)
            {
                return E_POINTER;
            }
            writeU32(out, state.objref ? MKSYS.OBJREFMONIKER : MKSYS_OF[state.kind]);
            return S_OK;
        }),
    ];

    const ROT_DATA_METHODS = [monikerMethod('GetComparisonData', 16, getComparisonData)];

    /**
     * A composite's halves as it marshals them: its first component, and the
     * rest -- one moniker, or a composite of them made for the purpose. The
     * second is the caller's to release when it was made.
     *
     * @param {MonikerState} state @param {unknown} thread
     */
    const halves = async(state, thread)=>{
        const [left, ...rest] = state.parts;
        if (rest.length === 1)
        {
            return { left, right: rest[0], made: false };
        }
        for (const part of rest)
        {
            await addRef(part, thread);
        }
        return { left, right: await fromParts(rest, thread), made: true };
    };

    /**
     * A generic composite's IMarshal: its two halves, each marshaled as its
     * own OBJREF one after the other. The size it answers is each half's
     * CoGetMarshalSizeMax and one more OBJREF header for each, which is what
     * Windows answers for two item monikers (moniker.c: 300 for two of 102).
     */
    const COMPOSITE_MARSHAL_METHODS = [
        monikerMethod('GetUnmarshalClass', 28, (state, [, , , , , out])=>{
            if (out === 0)
            {
                return E_POINTER;
            }
            env.writeMemory(out, guidBytes(classOf(state)));
            return S_OK;
        }),
        monikerMethod('GetMarshalSizeMax', 28, async(state, args, thread)=>{
            const [, , context, destination, flags, out] = args;
            if (out === 0)
            {
                return E_POINTER;
            }
            if (state.parts.length < 2 || !env.marshaling)
            {
                return E_UNEXPECTED;
            }
            const marshaling = env.marshaling;
            const { left, right, made } = await halves(state, thread);
            let total = 0;
            let hr = S_OK;
            for (const half of [left, right])
            {
                hr = await lend(new Uint8Array(4), async slot=>{
                    const answer = (await marshaling.sizeMax(slot, IID_IMONIKER, half, context,
                        destination, flags)) | 0;
                    total += readU32(slot) + OBJREF_CUSTOM_HEADER;
                    return answer;
                }, E_OUTOFMEMORY);
                if (hr < 0)
                {
                    break;
                }
            }
            if (made)
            {
                await release(right, thread);
            }
            if (hr >= 0)
            {
                writeU32(out, total);
            }
            return hr;
        }),
        monikerMethod('MarshalInterface', 28, async(state, args, thread)=>{
            const [stream, , , context, destination, flags] = args;
            if (state.parts.length < 2 || !env.marshaling)
            {
                return E_UNEXPECTED;
            }
            const { left, right, made } = await halves(state, thread);
            let hr = (await env.marshaling.marshal(stream, IID_IMONIKER, left, context,
                destination, flags)) | 0;
            if (hr >= 0)
            {
                hr = (await env.marshaling.marshal(stream, IID_IMONIKER, right, context,
                    destination, flags)) | 0;
            }
            if (made)
            {
                await release(right, thread);
            }
            return hr;
        }),
        monikerMethod('UnmarshalInterface', 16, (state, [stream, iid, out], thread)=>lend(
            new Uint8Array(8), async slot=>{
                const marshaling = env.marshaling;
                if (!marshaling)
                {
                    return E_UNEXPECTED;
                }
                let hr = (await marshaling.unmarshal(stream, IID_IMONIKER, slot)) | 0;
                if (hr >= 0)
                {
                    hr = (await marshaling.unmarshal(stream, IID_IMONIKER, slot + 4)) | 0;
                    if (hr < 0)
                    {
                        await release(readU32(slot), thread);
                    }
                }
                if (hr < 0)
                {
                    return hr;
                }
                const left = readU32(slot);
                const right = readU32(slot + 4);
                const parts = [...await componentsOf(left, thread),
                    ...await componentsOf(right, thread)];
                for (const part of parts)
                {
                    await addRef(part, thread);
                }
                await releaseAll([...state.parts, left, right], thread);
                state.parts = parts;
                return env.callMethod(state.self, SLOT.QUERY_INTERFACE, [iid, out], thread);
            }, E_OUTOFMEMORY)),
        monikerMethod('ReleaseMarshalData', 8, async(_state, [stream])=>{
            const first = (await env.marshaling?.releaseData(stream)) ?? E_UNEXPECTED;
            return first < 0 ? first : (await env.marshaling?.releaseData(stream)) ?? E_UNEXPECTED;
        }),
        monikerMethod('DisconnectObject', 8, ()=>S_OK),
    ];

    /**
     * The IMarshal of a moniker that crosses by value: its class unmarshals
     * it, and what crosses is what IPersistStream::Save writes, sized as
     * GetSizeMax says (moniker.c test_moniker's marshal data).
     */
    const BY_VALUE_MARSHAL_METHODS = [
        monikerMethod('GetUnmarshalClass', 28, (state, [, , , , , out])=>{
            if (out === 0)
            {
                return E_POINTER;
            }
            env.writeMemory(out, guidBytes(classOf(state)));
            return S_OK;
        }),
        monikerMethod('GetMarshalSizeMax', 28, (state, [, , , , , out], thread)=>{
            if (out === 0)
            {
                return E_POINTER;
            }
            return lend(new Uint8Array(8), async slot=>{
                const hr = (await sizeMax(state, slot, thread)) | 0;
                if (hr >= 0)
                {
                    writeU32(out, readU32(slot));
                }
                return hr;
            }, E_OUTOFMEMORY);
        }),
        monikerMethod('MarshalInterface', 28, (state, [stream], thread)=>
            save(state, stream, thread)),
        monikerMethod('UnmarshalInterface', 16, async(state, [stream, iid, out], thread)=>{
            const hr = (await load(state, stream, thread)) | 0;
            return hr < 0 ? hr
                : env.callMethod(state.self, SLOT.QUERY_INTERFACE, [iid, out], thread);
        }),
        monikerMethod('ReleaseMarshalData', 8, ()=>S_OK),
        monikerMethod('DisconnectObject', 8, ()=>S_OK),
    ];

    /**
     * A pointer or objref moniker's IMarshal: what crosses is its object, marshaled as
     * any interface pointer is, and the side that unmarshals it makes an
     * objref moniker of its own over what it got.
     */
    const OBJREF_MARSHAL_METHODS = [
        monikerMethod('GetUnmarshalClass', 28, (state, [, , , , , out])=>{
            if (out === 0)
            {
                return E_POINTER;
            }
            env.writeMemory(out, guidBytes(classOf(state)));
            return S_OK;
        }),
        monikerMethod('GetMarshalSizeMax', 28, (state, [, , context, destination, flags, out])=>
            (state.target === 0 || !env.marshaling ? E_UNEXPECTED
                : env.marshaling.sizeMax(out, IID_IUNKNOWN, state.target, context, destination,
                    flags))),
        monikerMethod('MarshalInterface', 28, (state, [stream, , , context, destination, flags])=>
            (state.target === 0 || !env.marshaling ? E_UNEXPECTED
                : env.marshaling.marshal(stream, IID_IUNKNOWN, state.target, context, destination,
                    flags))),
        monikerMethod('UnmarshalInterface', 16, (state, [stream, iid, out])=>lend(new Uint8Array(4),
            async slot=>{
                const hr = env.marshaling
                    ? (await env.marshaling.unmarshal(stream, IID_IUNKNOWN, slot)) | 0
                    : E_UNEXPECTED;
                if (hr < 0)
                {
                    return hr;
                }
                const previous = state.target;
                state.target = readU32(slot);
                if (previous !== 0)
                {
                    await release(previous, env.callerThread());
                }
                return env.callMethod(state.self, SLOT.QUERY_INTERFACE, [iid, out],
                    env.callerThread());
            }, E_OUTOFMEMORY)),
        monikerMethod('ReleaseMarshalData', 8, (_state, [stream])=>
            env.marshaling?.releaseData(stream) ?? E_UNEXPECTED),
        monikerMethod('DisconnectObject', 8, ()=>S_OK),
    ];

    /** @type {{ items: number[], position: number } | null} */
    let pendingEnum = null;
    env.registry.registerClass(CLSID_MONIKER_ENUM, ()=>{
        const state = pendingEnum ?? { items: [], position: 0 };
        return {
            state,
            interfaces: [{ id: IID_IENUMMONIKER, methods: [
                { name: 'Next', argBytes: 16, invoke: async(_object, [count, array, fetched])=>{
                    if ((array >>> 0) === 0)
                    {
                        return E_INVALIDARG;
                    }
                    const thread = env.callerThread();
                    writeU32(array, 0);
                    let given = 0;
                    while (given < (count >>> 0) && state.position < state.items.length)
                    {
                        const item = state.items[state.position++];
                        await addRef(item, thread);
                        writeU32((array >>> 0) + given * 4, item);
                        given++;
                    }
                    if ((fetched >>> 0) !== 0)
                    {
                        writeU32(fetched, given);
                    }
                    return given === (count >>> 0) ? S_OK : S_FALSE;
                } },
                { name: 'Skip', argBytes: 8, invoke: (_object, [count])=>{
                    if ((count >>> 0) === 0)
                    {
                        return S_OK;
                    }
                    if (state.position + (count >>> 0) >= state.items.length)
                    {
                        return S_FALSE;
                    }
                    state.position += count >>> 0;
                    return S_OK;
                } },
                { name: 'Reset', argBytes: 4, invoke: ()=>{
                    state.position = 0;
                    return S_OK;
                } },
                // Windows' composite enumerator does not clone.
                { name: 'Clone', argBytes: 8, invoke: (_object, [out])=>{
                    if ((out >>> 0) === 0)
                    {
                        return E_INVALIDARG;
                    }
                    writeU32(out, 0);
                    return E_NOTIMPL;
                } },
            ] }],
            lastRelease(){
                const items = state.items;
                state.items = [];
                return releaseAll(items, env.callerThread());
            },
            destroy(){
                const items = state.items;
                state.items = [];
                void releaseAll(items, env.callerThread());
            },
        };
    });

    /**
     * @typedef {Object} BindContextState
     * @property {Uint8Array} options  BIND_OPTS3, whole.
     * @property {number[]} bound       Objects RegisterObjectBound holds.
     * @property {{ key: string | null, object: number }[]} params
     */

    /**
     * The objects a bind context holds, released when it is.
     *
     * @param {BindContextState} state @param {boolean} includeParams @param {unknown} thread
     */
    const releaseHeld = (state, includeParams, thread)=>{
        const held = [...state.bound, ...(includeParams ? state.params.map(p=>p.object) : [])];
        state.bound = [];
        if (includeParams)
        {
            state.params = [];
        }
        return releaseAll(held, thread);
    };

    /**
     * @param {BindContextState} state @param {string | null} key
     */
    const paramIndex = (state, key)=>state.params.findIndex(param=>param.key === key);

    /** @type {import('./objects.js').ComMethod[]} */
    const BIND_CONTEXT_METHODS = [
        { name: 'RegisterObjectBound', argBytes: 8, invoke: async(object, [unknown])=>{
            if ((unknown >>> 0) === 0)
            {
                return S_OK;
            }
            await addRef(unknown >>> 0, env.callerThread());
            object.state.bound.push(unknown >>> 0);
            return S_OK;
        } },
        { name: 'RevokeObjectBound', argBytes: 8, invoke: async(object, [unknown])=>{
            if ((unknown >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            /** @type {BindContextState} */
            const state = object.state;
            const index = state.bound.indexOf(unknown >>> 0);
            if (index < 0)
            {
                return MK_E_NOTBOUND;
            }
            state.bound.splice(index, 1);
            await release(unknown >>> 0, env.callerThread());
            return S_OK;
        } },
        { name: 'ReleaseBoundObjects', argBytes: 4, invoke: async object=>{
            await releaseHeld(object.state, false, env.callerThread());
            return S_OK;
        } },
        { name: 'SetBindOptions', argBytes: 8, invoke: (object, [options])=>{
            if ((options >>> 0) === 0)
            {
                return E_POINTER;
            }
            const size = readU32(options);
            if (size > BIND_OPTS.SIZE_OF)
            {
                return E_INVALIDARG;
            }
            if (size > BIND_OPTS.FLAGS)
            {
                object.state.options.set(env.readMemory((options >>> 0) + BIND_OPTS.FLAGS,
                    size - BIND_OPTS.FLAGS), BIND_OPTS.FLAGS);
            }
            return S_OK;
        } },
        { name: 'GetBindOptions', argBytes: 8, invoke: (object, [options])=>{
            if ((options >>> 0) === 0)
            {
                return E_POINTER;
            }
            const size = Math.min(readU32(options), BIND_OPTS.SIZE_OF);
            if (size > BIND_OPTS.FLAGS)
            {
                env.writeMemory((options >>> 0) + BIND_OPTS.FLAGS,
                    object.state.options.subarray(BIND_OPTS.FLAGS, size));
            }
            writeU32(options, size);
            return S_OK;
        } },
        { name: 'GetRunningObjectTable', argBytes: 8, invoke: (_object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            return env.runningObjectTable(out >>> 0, env.callerThread());
        } },
        { name: 'RegisterObjectParam', argBytes: 12, invoke: async(object, [keyAt, unknown])=>{
            if ((unknown >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            /** @type {BindContextState} */
            const state = object.state;
            const thread = env.callerThread();
            const key = readWide(keyAt);
            await addRef(unknown >>> 0, thread);
            const index = paramIndex(state, key);
            if (index >= 0)
            {
                const previous = state.params[index].object;
                state.params[index].object = unknown >>> 0;
                await release(previous, thread);
                return S_OK;
            }
            state.params.push({ key, object: unknown >>> 0 });
            return S_OK;
        } },
        { name: 'GetObjectParam', argBytes: 12, invoke: async(object, [keyAt, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            writeU32(out, 0);
            /** @type {BindContextState} */
            const state = object.state;
            const index = paramIndex(state, readWide(keyAt));
            if (index < 0)
            {
                return E_FAIL;
            }
            const found = state.params[index].object;
            await addRef(found, env.callerThread());
            writeU32(out, found);
            return S_OK;
        } },
        // Not implemented on Windows either, where the conformance tests
        // pin E_NOTIMPL.
        { name: 'EnumObjectParam', argBytes: 8, invoke: (_object, [out])=>{
            if ((out >>> 0) !== 0)
            {
                writeU32(out, 0);
            }
            return E_NOTIMPL;
        } },
        { name: 'RevokeObjectParam', argBytes: 8, invoke: async(object, [keyAt])=>{
            /** @type {BindContextState} */
            const state = object.state;
            const index = paramIndex(state, readWide(keyAt));
            if (index < 0)
            {
                return E_FAIL;
            }
            const [{ object: held }] = state.params.splice(index, 1);
            await release(held, env.callerThread());
            return S_OK;
        } },
    ];

    env.registry.registerClass(CLSID_BIND_CONTEXT, ()=>{
        const options = new Uint8Array(BIND_OPTS.SIZE_OF);
        const view = new DataView(options.buffer);
        view.setUint32(BIND_OPTS.CB_STRUCT, BIND_OPTS.SIZE_OF, true);
        view.setUint32(BIND_OPTS.MODE, STGM_READWRITE, true);
        view.setUint32(BIND_OPTS.CLASS_CONTEXT, CLSCTX_SERVER, true);
        view.setUint32(BIND_OPTS.LOCALE, env.locale?.() ?? LOCALE_US, true);
        /** @type {BindContextState} */
        const state = { options, bound: [], params: [] };
        return {
            state,
            interfaces: [{ id: IID_IBINDCTX, methods: BIND_CONTEXT_METHODS }],
            lastRelease: ()=>releaseHeld(state, true, env.callerThread()),
            destroy(){
                void releaseHeld(state, true, env.callerThread());
            },
        };
    });

    /**
     * A new bind context, holding one reference.
     *
     * @returns {Promise<number>} its IBindCtx pointer, or 0
     */
    const makeBindContext = async()=>{
        const object = env.registry.create(CLSID_BIND_CONTEXT);
        const pointer = object ? env.vtables.publish(object, IID_IBINDCTX) >>> 0 : 0;
        if (object && pointer === 0)
        {
            object.release();
        }
        return pointer;
    };

    /**
     * The class moniker a "clsid:" display name names, and how much of the
     * name it took: the class, with or without braces; anything after it up
     * to a colon, which the moniker keeps; and the colon.
     *
     * @param {string} text
     * @returns {{ hr: number, state: MonikerState | null, eaten: number }}
     */
    const classFromDisplayName = text=>{
        const failed = { hr: MK_E_SYNTAX, state: null, eaten: 0 };
        const prefix = 'clsid:'.length;
        const colon = text.indexOf(':', prefix);
        const end = colon < 0 ? text.length : colon;
        if (end - prefix < 36)
        {
            return failed;
        }
        const braced = text[prefix] === '{';
        let at = braced ? prefix + 1 : prefix;
        const clsid = canonicalGuid(`{${text.slice(at, at + 36)}}`);
        if (clsid === null)
        {
            return failed;
        }
        at += 36;
        if (braced)
        {
            if (text[at] !== '}')
            {
                return failed;
            }
            at++;
        }
        if (at > end)
        {
            return failed;
        }
        const extra = text.slice(at, end);
        return {
            hr: S_OK,
            state: newState('class', { clsid, extra: extra.length > 0 ? encodeWide(extra)
                : new Uint8Array(0) }),
            eaten: colon < 0 ? end : end + 1,
        };
    };

    /**
     * A display name that starts with a ProgID and a colon, or "@" and a
     * ProgID: the class's IParseDisplayName parses all of it, as the
     * program's own string.
     *
     * @param {number} context @param {number} nameAt @param {string} text
     * @param {unknown} thread
     * @returns {Promise<{ hr: number, value: number, eaten: number }>}
     */
    const progIdMoniker = async(context, nameAt, text, thread)=>{
        const failed = { hr: MK_E_SYNTAX, value: 0, eaten: 0 };
        const start = text.startsWith('@') ? 1 : 0;
        const colon = text.indexOf(':', start);
        const end = colon < 0 ? text.length : colon;
        // One character before a colon is a drive letter, not a ProgID.
        if ((start === 0 && colon < 0) || end - start <= 1)
        {
            return failed;
        }
        const clsid = classOfProgId(text.slice(start, end));
        if (clsid === null)
        {
            return failed;
        }
        const parser = await parserOf(iid=>lend(new Uint8Array(4), async slot=>{
            const hr = await bindClass(clsid, context, 0, iid, slot, thread);
            return { hr: hr | 0, value: readU32(slot) };
        }, { hr: E_OUTOFMEMORY, value: 0 }), thread);
        return lend(new Uint8Array(8), async block=>{
            const hr = await parseWith(parser, [context, nameAt, block, block + 4], thread);
            return { hr, value: readU32(block + 4), eaten: readU32(block) };
        }, { hr: E_OUTOFMEMORY, value: 0, eaten: 0 });
    };

    /**
     * The file moniker a display name starts with: the longest prefix
     * ending before a separator that names a running object or a file that
     * exists.
     *
     * @param {number} context @param {string} text @param {unknown} thread
     * @returns {Promise<{ hr: number, value: number, eaten: number }>}
     */
    const fileFromDisplayName = async(context, text, thread)=>{
        let end = text.length;
        while (end > 0)
        {
            const prefix = text.slice(0, end);
            const moniker = await makeMoniker(newState('file', { path: normalisePath(prefix) }),
                thread);
            if (moniker === 0)
            {
                return { hr: E_OUTOFMEMORY, value: 0, eaten: 0 };
            }
            const running = await askTable(context, SLOT.ROT_IS_RUNNING, ()=>[moniker], thread);
            if (running < 0)
            {
                await release(moniker, thread);
                return { hr: running, value: 0, eaten: 0 };
            }
            if (running === S_OK || await env.fileInfo(prefix))
            {
                return { hr: S_OK, value: moniker, eaten: end };
            }
            await release(moniker, thread);
            let next = end - 1;
            while (next >= 0 && !':\\/!'.includes(text[next]))
            {
                next--;
            }
            end = next;
        }
        return { hr: MK_E_SYNTAX, value: 0, eaten: 0 };
    };

    /**
     * MkParseDisplayName: the first moniker from the name -- a class
     * moniker, a ProgID's, or a file -- then each moniker so far asked to
     * parse what is left, its answer composed onto it.
     *
     * @param {number} context @param {number} nameAt @param {number} eatenAt
     * @param {number} out @param {unknown} thread
     */
    const parseName = async(context, nameAt, eatenAt, out, thread)=>{
        const text = readWide(nameAt);
        if (context === 0 || text === null || text.length === 0 || eatenAt === 0 || out === 0)
        {
            return E_INVALIDARG;
        }
        writeU32(eatenAt, 0);
        writeU32(out, 0);
        /** @type {{ hr: number, value: number, eaten: number }} */
        let first = { hr: MK_E_SYNTAX, value: 0, eaten: 0 };
        if (text.slice(0, 6).toLowerCase() === 'clsid:')
        {
            const parsed = classFromDisplayName(text);
            if (parsed.state)
            {
                const moniker = await makeMoniker(parsed.state, thread);
                first = { hr: moniker === 0 ? E_OUTOFMEMORY : S_OK, value: moniker,
                    eaten: parsed.eaten };
            }
        }
        else
        {
            first = await progIdMoniker(context, nameAt, text, thread);
        }
        if (first.hr < 0 && first.hr !== MK_E_SYNTAX)
        {
            return first.hr;
        }
        if (first.hr < 0)
        {
            first = await fileFromDisplayName(context, text, thread);
            if (first.hr < 0)
            {
                return first.hr;
            }
        }
        let moniker = first.value;
        let eaten = first.eaten;
        while (eaten < text.length)
        {
            const step = await lend(new Uint8Array(8), async block=>{
                const hr = await call(moniker, SLOT.PARSE_DISPLAY_NAME,
                    [context, 0, nameAt + eaten * 2, block, block + 4], thread);
                return { hr, value: readU32(block + 4), eaten: readU32(block) };
            }, { hr: E_OUTOFMEMORY, value: 0, eaten: 0 });
            if (step.hr < 0 || step.eaten === 0 || step.value === 0)
            {
                await releaseAll([moniker, step.value], thread);
                return step.hr < 0 ? step.hr : MK_E_SYNTAX;
            }
            const joined = await compose(moniker, step.value, thread);
            await releaseAll([moniker, step.value], thread);
            if (joined.hr < 0)
            {
                return joined.hr;
            }
            moniker = joined.value;
            eaten += Math.min(step.eaten, text.length - eaten);
        }
        writeU32(eatenAt, eaten);
        writeU32(out, moniker);
        return S_OK;
    };

    /**
     * CoGetInstanceFromFile: an object of the file's class -- or the one
     * named -- loaded from the file, and the interfaces asked of it.
     *
     * @param {number[]} args @param {unknown} thread
     */
    const instanceFromFile = async(args, thread)=>{
        const [serverInfo, clsidAt, outer, classContext, mode, nameAt, count, results] = args;
        if (count === 0 || results === 0)
        {
            return E_INVALIDARG;
        }
        /** @param {number} index */
        const resultAt = index=>results + index * MULTI_QI.SIZE_OF;
        // A result already holding an interface is refused before anything
        // is touched, as Windows does.
        for (let index = 0; index < count; index++)
        {
            if (readU32(resultAt(index) + MULTI_QI.ITF) !== 0)
            {
                return E_INVALIDARG;
            }
        }
        /** @param {number} hr */
        const failAll = hr=>{
            for (let index = 0; index < count; index++)
            {
                writeU32(resultAt(index) + MULTI_QI.ITF, 0);
                writeU32(resultAt(index) + MULTI_QI.HR, hr);
            }
            return hr;
        };
        failAll(E_NOINTERFACE);
        if (serverInfo !== 0)
        {
            diverge('CoGetInstanceFromFile', 'a server was named, and the object is made here');
        }
        const path = readWide(nameAt) ?? '';
        let clsid = clsidAt === 0 ? null : readGuidAt(clsidAt);
        if (clsid === null)
        {
            const found = await classOfFile(path);
            if (found.hr < 0)
            {
                return found.hr;
            }
            clsid = found.clsid;
        }
        const made = await lend(new Uint8Array(4), async slot=>{
            const hr = await env.createInstance(/** @type {string} */ (clsid), outer, classContext,
                IID_IUNKNOWN, slot, thread);
            return { hr: hr | 0, value: readU32(slot) };
        }, { hr: E_OUTOFMEMORY, value: 0 });
        if (made.hr !== S_OK || made.value === 0)
        {
            return failAll(made.hr < 0 ? made.hr : E_NOINTERFACE);
        }
        const file = await query(made.value, IID_IPERSISTFILE, thread);
        if (file.hr < 0 || file.value === 0)
        {
            await release(made.value, thread);
            return failAll(file.hr < 0 ? file.hr : E_NOINTERFACE);
        }
        const loaded = await call(file.value, SLOT.PERSIST_FILE_LOAD, [nameAt, mode], thread);
        await release(file.value, thread);
        if (loaded < 0)
        {
            await release(made.value, thread);
            return failAll(loaded);
        }
        let answered = 0;
        for (let index = 0; index < count; index++)
        {
            const iidAt = readU32(resultAt(index) + MULTI_QI.IID);
            const hr = await call(made.value, SLOT.QUERY_INTERFACE, [iidAt,
                resultAt(index) + MULTI_QI.ITF], thread);
            writeU32(resultAt(index) + MULTI_QI.HR, hr);
            if (hr >= 0)
            {
                answered++;
            }
        }
        await release(made.value, thread);
        return answered === count ? S_OK : answered > 0 ? CO_S_NOTALLINTERFACES : E_NOINTERFACE;
    };

    /**
     * An entry point's handler, its arguments unsigned and the caller's
     * thread at hand.
     *
     * @param {number} argBytes
     * @param {(args: number[], thread: unknown) => Promise<number> | number} body
     */
    const entry = (argBytes, body)=>({
        argBytes,
        /** @param {number[]} args */
        handler: args=>Promise.resolve(body(args.map(value=>value >>> 0), env.callerThread()))
            .then(hr=>hr | 0),
    });

    return {
        /** HRESULT CreateBindCtx(DWORD reserved, LPBC *ppbc) */
        CreateBindCtx: entry(8, async([reserved, out])=>{
            if (out === 0)
            {
                return E_INVALIDARG;
            }
            writeU32(out, 0);
            if (reserved !== 0)
            {
                return E_INVALIDARG;
            }
            const context = await makeBindContext();
            writeU32(out, context);
            return context === 0 ? E_OUTOFMEMORY : S_OK;
        }),

        /** HRESULT CreateItemMoniker(LPCOLESTR lpszDelim, LPCOLESTR lpszItem, LPMONIKER *ppmk) */
        CreateItemMoniker: entry(12, ([delimiter, item, out], thread)=>{
            if (out === 0)
            {
                return E_INVALIDARG;
            }
            return answerMoniker(newState('item', { delimiter: readWide(delimiter),
                name: readWide(item) ?? '' }), out, thread);
        }),

        /** HRESULT CreateFileMoniker(LPCOLESTR lpszPathName, LPMONIKER *ppmk) */
        CreateFileMoniker: entry(8, ([pathAt, out], thread)=>{
            if (out === 0)
            {
                return E_POINTER;
            }
            const path = readWide(pathAt);
            if (path === null)
            {
                return MK_E_SYNTAX;
            }
            writeU32(out, 0);
            return answerMoniker(newState('file', { path: normalisePath(path) }), out, thread);
        }),

        /** HRESULT CreateClassMoniker(REFCLSID rclsid, LPMONIKER *ppmk) */
        CreateClassMoniker: entry(8, ([clsidAt, out], thread)=>{
            if (out === 0)
            {
                return E_POINTER;
            }
            writeU32(out, 0);
            if (clsidAt === 0)
            {
                return E_INVALIDARG;
            }
            return answerMoniker(newState('class', { clsid: readGuidAt(clsidAt) }), out, thread);
        }),

        /** HRESULT CreatePointerMoniker(LPUNKNOWN punk, LPMONIKER *ppmk) */
        CreatePointerMoniker: entry(8, async([unknown, out], thread)=>{
            if (out === 0)
            {
                return E_INVALIDARG;
            }
            writeU32(out, 0);
            if (unknown !== 0)
            {
                await addRef(unknown, thread);
            }
            return answerMoniker(newState('pointer', { target: unknown }), out, thread);
        }),

        /**
         * HRESULT CreateObjrefMoniker(LPUNKNOWN punk, LPMONIKER *ppmk)
         *
         * A pointer moniker that marshals its object rather than itself.
         */
        CreateObjrefMoniker: entry(8, async([unknown, out], thread)=>{
            if (out === 0)
            {
                return E_INVALIDARG;
            }
            writeU32(out, 0);
            if (unknown !== 0)
            {
                await addRef(unknown, thread);
            }
            return answerMoniker(newState('pointer', { target: unknown, objref: true }), out,
                thread);
        }),

        /** HRESULT CreateAntiMoniker(LPMONIKER *ppmk) */
        CreateAntiMoniker: entry(4, ([out], thread)=>{
            if (out === 0)
            {
                return E_POINTER;
            }
            return answerMoniker(newState('anti', { count: 1 }), out, thread);
        }),

        /**
         * HRESULT CreateGenericComposite(LPMONIKER pmkFirst, LPMONIKER pmkRest,
         *                                LPMONIKER *ppmkComposite)
         */
        CreateGenericComposite: entry(12, async([left, right, out], thread)=>{
            if (out === 0)
            {
                return E_POINTER;
            }
            writeU32(out, 0);
            const made = await compose(left, right, thread);
            writeU32(out, made.value);
            return made.hr;
        }),

        /**
         * HRESULT MkParseDisplayName(LPBC pbc, LPCOLESTR szUserName, ULONG *pchEaten,
         *                            LPMONIKER *ppmk)
         */
        MkParseDisplayName: entry(16, ([context, name, eaten, out], thread)=>
            parseName(context, name, eaten, out, thread)),

        /** HRESULT BindMoniker(LPMONIKER pmk, DWORD grfOpt, REFIID iidResult, LPVOID *ppvResult) */
        BindMoniker: entry(16, async([moniker, options, iid, out], thread)=>{
            if (moniker === 0 || out === 0)
            {
                return E_INVALIDARG;
            }
            writeU32(out, 0);
            if (options !== 0)
            {
                return E_INVALIDARG;
            }
            const context = await makeBindContext();
            if (context === 0)
            {
                return E_OUTOFMEMORY;
            }
            const hr = await call(moniker, SLOT.BIND_TO_OBJECT, [context, 0, iid, out], thread);
            await release(context, thread);
            return hr;
        }),

        /**
         * HRESULT MonikerCommonPrefixWith(LPMONIKER pmkThis, LPMONIKER pmkOther,
         *                                 LPMONIKER *ppmkCommon)
         */
        MonikerCommonPrefixWith: entry(12, async([mine, theirs, out], thread)=>{
            if (out === 0)
            {
                return E_INVALIDARG;
            }
            writeU32(out, 0);
            const prefix = await commonPrefix(mine, theirs, thread);
            writeU32(out, prefix.value);
            return prefix.hr;
        }),

        /**
         * HRESULT MonikerRelativePathTo(LPMONIKER pmkSrc, LPMONIKER pmkDest,
         *                               LPMONIKER *ppmkRelPath, BOOL dwReserved)
         */
        MonikerRelativePathTo: entry(16, async([from, to, out], thread)=>{
            if (out === 0)
            {
                return E_INVALIDARG;
            }
            writeU32(out, 0);
            if (from === 0 || to === 0)
            {
                return E_INVALIDARG;
            }
            const relative = await relativePath(from, to, thread, false);
            writeU32(out, relative.value);
            return relative.hr;
        }),

        /** HRESULT GetClassFile(LPCOLESTR szFilename, CLSID *pclsid) */
        GetClassFile: entry(8, async([pathAt, out])=>{
            const path = readWide(pathAt);
            if (path === null || out === 0)
            {
                return E_INVALIDARG;
            }
            const { hr, clsid } = await classOfFile(path);
            if (hr >= 0)
            {
                env.writeMemory(out, guidBytes(clsid));
            }
            return hr;
        }),

        /**
         * HRESULT CoGetInstanceFromFile(COSERVERINFO *pServerInfo, CLSID *pClsid,
         *     IUnknown *punkOuter, DWORD dwClsCtx, DWORD grfMode, OLECHAR *pwszName,
         *     DWORD dwCount, MULTI_QI *pResults)
         */
        CoGetInstanceFromFile: entry(32, instanceFromFile),
    };
}
