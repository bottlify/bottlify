/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The user-marshal routines a MIDL-generated proxy/stub calls for the types
 * NDR cannot lay out by itself: handles, clipboard formats, storage mediums,
 * name blocks and interface pointers. Each type has four -- the bytes it
 * takes in an NDR buffer, writing it there, reading it back into the
 * caller's variable, and freeing what reading made -- and all of them are
 * stdcall.
 *
 * The first argument points at a USER_MARSHAL_CB, whose first word is the
 * flags: the low half the MSHCTX the data is going to, the high half the data
 * representation. Every wire form starts at a four-byte boundary with a tag:
 * WDT_INPROC_CALL for a value that only means something inside the process,
 * WDT_REMOTE_CALL for one sent with its contents. Which a type uses depends
 * on the context:
 *
 * - window, menu, accelerator, icon, brush, DC and palette handles go as the
 *   handle anywhere but to another machine, which is refused;
 * - an HGLOBAL, a bitmap and the metafiles go by value whenever they leave
 *   the process, since none of those handles means anything outside it;
 * - a clipboard format goes by name only to another machine, and only a
 *   registered one, whose number is this machine's alone;
 * - an interface pointer goes as an OBJREF with two copies of its length
 *   ahead of it, and nothing at all for NULL.
 *
 * The layouts are the ones Windows writes, as Wine's conformance tests
 * (dlls/ole32/tests/usrmarshal.c) check them byte for byte.
 */

import { GUID_NULL, formatGuid, readGuid } from './guid.js';
import { OBJREF_BYTES, decodeObjref } from './objref.js';
import { IID_ISTORAGE, IID_ISTREAM } from './storage.js';

const WDT_INPROC_CALL = 0x48746457;
const WDT_REMOTE_CALL = 0x52746457;
/** 'User': NDR's mark ahead of an embedded pointer to a user-marshaled type. */
const USER_MARSHAL_PTR_PREFIX = 0x72657355;
/** 'USRC', USER_MARSHAL_CB.Signature: the flags word is the head of a real one. */
const USER_MARSHAL_CB_SIGNATURE = 0x55535243;

/** USER_MARSHAL_CB: Flags, pStubMsg, pReserve, Signature. */
const UMCB_STUB_MESSAGE = 4;
const UMCB_SIGNATURE = 12;
/** MIDL_STUB_MESSAGE's pfnAllocate and pfnFree, on x86. */
const STUB_ALLOCATE = 0x48;
const STUB_FREE = 0x4c;

const MSHCTX_DIFFERENTMACHINE = 2;
const MSHCTX_INPROC = 3;

const RPC_X_NO_MEMORY = 1711;
const RPC_S_INVALID_TAG = 1733;
const RPC_S_INVALID_BOUND = 1734;
const RPC_X_BAD_STUB_DATA = 1783;
const E_FAIL = 0x80004005 | 0;
const DV_E_TYMED = 0x80040069 | 0;
const DV_E_CLIPFORMAT = 0x8004006a | 0;
const RPC_E_INVALID_OBJREF = 0x8001011d | 0;

const TYMED_NULL = 0;
const TYMED_HGLOBAL = 1;
const TYMED_FILE = 2;
const TYMED_ISTREAM = 4;
const TYMED_ISTORAGE = 8;
const TYMED_GDI = 16;
const TYMED_MFPICT = 32;
const TYMED_ENHMF = 64;

/** The first registered clipboard format; the ones below are predefined. */
const FIRST_REGISTERED_FORMAT = 0xc000;

const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
const SLOT_QUERY_INTERFACE = 0;
const SLOT_RELEASE = 2;

/** STGMEDIUM: tymed, the union, pUnkForRelease. */
const MEDIUM_VALUE = 4;
const MEDIUM_RELEASE = 8;
/** METAFILEPICT: mm, xExt, yExt, hMF. */
const METAFILEPICT_BYTES = 16;
const METAFILEPICT_HANDLE = 12;
/** A BITMAP up to bmBits, which is what the wire carries ahead of the bits. */
const BITMAP_HEADER_BYTES = 20;

/**
 * What gdi32 lends a handle that leaves the process by value: its contents,
 * an object made from them on the other side, and its deletion there. A
 * member absent means that object cannot be copied, and the handle goes as it
 * is, reported as the difference it is.
 *
 * @typedef {Object} GdiCopies
 * @property {(bitmap: number) => { header: Uint8Array, bits: Uint8Array } | null} [bitmap]
 *           GetObject's BITMAP up to bmBits (20 bytes), and GetBitmapBits.
 * @property {(header: Uint8Array, bits: Uint8Array) => number} [createBitmap]
 *           CreateBitmapIndirect from that header with those bits.
 * @property {(object: number) => unknown} [deleteObject]
 * @property {(metafile: number) => Uint8Array | null} [enhMetaFileBits]
 *           GetEnhMetaFileBits.
 * @property {(bits: Uint8Array) => number} [createEnhMetaFile]  SetEnhMetaFileBits.
 * @property {(metafile: number) => unknown} [deleteEnhMetaFile]
 * @property {(metafile: number) => Uint8Array | null} [metaFileBits]  GetMetaFileBitsEx.
 * @property {(bits: Uint8Array) => number} [createMetaFile]  SetMetaFileBitsEx.
 * @property {(metafile: number) => unknown} [deleteMetaFile]
 */

/**
 * @typedef {Object} UserMarshalHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => unknown,
 *              block: (address: number) => { size: number } | null }} heap
 *           The process heap kernel32's Global* and CoTaskMemAlloc both stand
 *           on, where an HGLOBAL is its block's address: what an HGLOBAL, a
 *           METAFILEPICT and a file name are unmarshaled into.
 * @property {(code: number) => any} raise
 *           RpcRaiseException from a handler that has not waited on anything.
 * @property {(code: number, thread: unknown) => Promise<any>} raiseLater
 *           The same from one that has.
 * @property {(entry: number, args: number[], thread?: unknown) => Promise<number>} [call]
 *           A stdcall into guest code: Release and QueryInterface on the
 *           interfaces a medium holds, and the stub message's allocator.
 *           Absent, references are not given back and memory comes from the heap.
 * @property {() => unknown} [callerThread]  Whose call is being handled.
 * @property {() => import('../rpcrt4/runtime.js').ObjrefMarshaler | null} [marshaler]
 *           ole32's maker and reader of OBJREFs, read at call time. Absent,
 *           no interface pointer can be marshaled.
 * @property {{ name: (format: number) => string | null,
 *              register: (name: string) => number }} [clipboardFormats]
 *           user32's GetClipboardFormatNameW and RegisterClipboardFormatW.
 *           Absent, no registered format can go to another machine.
 * @property {GdiCopies} [gdi]
 * @property {(name: number) => unknown} [deleteFile]
 *           DeleteFileW, for a TYMED_FILE medium freed with nobody to release it.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * The four routines of one type, over its variable's address (`slot`).
 *
 * @typedef {Object} Wire
 * @property {(flags: number, start: number, slot: number) => number} size
 * @property {(flags: number, buffer: number, slot: number, thread: unknown)
 *     => number | Promise<number>} marshal
 * @property {(flags: number, buffer: number, slot: number, thread: unknown)
 *     => number | Promise<number>} unmarshal
 * @property {(flags: number, slot: number, thread: unknown) => unknown} free
 */

/**
 * Thrown where the routine raises: the export it runs under turns it into
 * RpcRaiseException on the calling thread.
 */
class WireFault {
    /** @param {number} code */
    constructor(code){
        this.code = code >>> 0;
    }
}

/** @type {(code: number) => never} */
const fault = code=>{
    throw new WireFault(code);
};

/** @param {number} value */
const align = value=>((value + 3) & ~3) >>> 0;

/**
 * `then` of a value, or of what a promise of one settles to.
 *
 * @template T, U
 * @param {T | Promise<T>} value @param {(value: T) => U | Promise<U>} then
 * @returns {U | Promise<U>}
 */
const after = (value, then)=>(value instanceof Promise ? value.then(then) : then(value));

/**
 * @param {UserMarshalHost} host
 * @returns {Record<string, { argBytes: number, handler: (args: number[]) => any }>}
 */
export function createUserMarshalFunctions(host){
    /** @param {number} address */
    const readU32 = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address */
    const readU16 = address=>{
        const bytes = host.readMemory(address >>> 0, 2);
        return bytes[0] | bytes[1] << 8;
    };
    /** @param {number} address @param {number} value */
    const writeU16 = (address, value)=>host.writeMemory(address >>> 0,
        Uint8Array.of(value & 0xff, (value >>> 8) & 0xff));
    /**
     * Consecutive words from `address`, written at once.
     *
     * @param {number} address @param {number[]} words
     * @returns {number} where they end
     */
    const putWords = (address, words)=>{
        const bytes = new Uint8Array(words.length * 4);
        const view = new DataView(bytes.buffer);
        words.forEach((word, index)=>view.setUint32(index * 4, word >>> 0, true));
        host.writeMemory(address >>> 0, bytes);
        return (address + bytes.length) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        putWords(address, [value]);
    };
    /** @param {number} flags */
    const context = flags=>readU32(flags) & 0xffff;
    /** @param {number} flags */
    const inProcess = flags=>context(flags) === MSHCTX_INPROC;

    /**
     * The UTF-16 units of a terminated wide string, its terminator excluded.
     *
     * @param {number} address
     */
    const wideUnits = address=>{
        for (let at = address; ; at += 256)
        {
            const piece = host.readMemory(at, 256);
            for (let index = 0; index + 1 < piece.length; index += 2)
            {
                if (piece[index] === 0 && piece[index + 1] === 0)
                {
                    return (at - address + index) / 2;
                }
            }
            if (piece.length < 256)
            {
                return (at - address + piece.length) >> 1;
            }
        }
    };
    /** @param {Uint8Array} bytes */
    const wideText = bytes=>{
        let text = '';
        for (let index = 0; index + 1 < bytes.length; index += 2)
        {
            text += String.fromCharCode(bytes[index] | bytes[index + 1] << 8);
        }
        return text;
    };
    /** @param {string} text  Written with its terminator. */
    const wideBytes = text=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let index = 0; index < text.length; index++)
        {
            bytes[index * 2] = text.charCodeAt(index) & 0xff;
            bytes[index * 2 + 1] = text.charCodeAt(index) >>> 8;
        }
        return bytes;
    };

    /**
     * A method of a guest object, through its vtable.
     *
     * @param {number} object @param {number} slot @param {number[]} args @param {unknown} thread
     * @returns {Promise<number>}
     */
    const callMethod = (object, slot, args, thread)=>{
        const call = host.call;
        if (!call)
        {
            host.divergence?.('ole32 user marshal',
                'no call into the program: a reference it is owed is not taken or given back');
            return Promise.resolve(0);
        }
        return call(readU32(readU32(object) + slot * 4), [object >>> 0, ...args], thread)
            .then(answer=>answer | 0);
    };
    /** @param {number} object @param {unknown} thread */
    const release = (object, thread)=>callMethod(object, SLOT_RELEASE, [], thread);

    /**
     * The routine the stub message names at `offset`, when the flags word is
     * the head of a USER_MARSHAL_CB and its stub message has one. A caller
     * that hands a bare flags word gets the task allocator instead, which is
     * what MIDL's stubs install there anyway.
     *
     * @param {number} flags @param {number} offset
     */
    const stubRoutine = (flags, offset)=>{
        if (!host.call || readU32(flags + UMCB_SIGNATURE) !== USER_MARSHAL_CB_SIGNATURE)
        {
            return 0;
        }
        const message = readU32(flags + UMCB_STUB_MESSAGE);
        return message === 0 ? 0 : readU32(message + offset);
    };
    /**
     * @param {number} flags @param {number} bytes @param {unknown} thread
     * @returns {number | Promise<number>}
     */
    const stubAllocate = (flags, bytes, thread)=>{
        const routine = stubRoutine(flags, STUB_ALLOCATE);
        if (routine !== 0 && host.call)
        {
            return host.call(routine, [bytes], thread).then(address=>address >>> 0);
        }
        return host.heap.allocate(bytes) >>> 0;
    };
    /**
     * @param {number} flags @param {number} address @param {unknown} thread
     * @returns {unknown}
     */
    const stubFree = (flags, address, thread)=>{
        const routine = stubRoutine(flags, STUB_FREE);
        if (routine !== 0 && host.call)
        {
            return host.call(routine, [address], thread);
        }
        return host.heap.free(address);
    };

    /**
     * A handle that is only good inside this machine: the value itself, which
     * another machine cannot use, so going there is refused. The palette is
     * one of these here, where Windows would send its entries.
     *
     * @param {string} type @param {boolean} copiesOnWindows
     * @returns {Wire}
     */
    const handleWire = (type, copiesOnWindows)=>{
        /** @param {number} flags @param {string} routine */
        const reachable = (flags, routine)=>{
            if (context(flags) !== MSHCTX_DIFFERENTMACHINE)
            {
                return;
            }
            if (copiesOnWindows)
            {
                host.divergence?.(`${type}_${routine}`,
                    'its entries are not sent to another machine; refused as a local handle');
            }
            fault(RPC_S_INVALID_TAG);
        };
        return {
            size: (flags, start)=>{
                reachable(flags, 'UserSize');
                return align(start) + 8;
            },
            marshal: (flags, buffer, slot)=>{
                reachable(flags, 'UserMarshal');
                return putWords(align(buffer), [WDT_INPROC_CALL, readU32(slot)]);
            },
            unmarshal: (flags, buffer, slot)=>{
                const at = align(buffer);
                if (readU32(at) !== WDT_INPROC_CALL)
                {
                    fault(RPC_X_BAD_STUB_DATA);
                }
                writeU32(slot, readU32(at + 4));
                return at + 8;
            },
            free: ()=>0,
        };
    };

    /** @param {number} handle */
    const globalSize = handle=>host.heap.block(handle)?.size ?? 0;

    /**
     * An HGLOBAL: the handle in-process, else the block's bytes after the
     * handle and the size, both of them twice.
     *
     * @type {Wire}
     */
    const hglobalWire = {
        size: (flags, start, slot)=>{
            const handle = readU32(slot);
            if (inProcess(flags) || handle === 0)
            {
                return align(start) + 8;
            }
            return align(start) + 20 + globalSize(handle);
        },
        marshal: (flags, buffer, slot)=>{
            const at = align(buffer);
            const handle = readU32(slot);
            if (inProcess(flags))
            {
                return putWords(at, [WDT_INPROC_CALL, handle]);
            }
            if (handle === 0)
            {
                return putWords(at, [WDT_REMOTE_CALL, 0]);
            }
            const bytes = globalSize(handle);
            const end = putWords(at, [WDT_REMOTE_CALL, handle, bytes, handle, bytes]);
            if (bytes > 0)
            {
                host.writeMemory(end, host.readMemory(handle, bytes).slice());
            }
            return end + bytes;
        },
        unmarshal: (flags, buffer, slot)=>{
            const at = align(buffer);
            const tag = readU32(at);
            const handle = readU32(at + 4);
            if (tag === WDT_INPROC_CALL)
            {
                writeU32(slot, handle);
                return at + 8;
            }
            if (tag !== WDT_REMOTE_CALL)
            {
                fault(RPC_S_INVALID_TAG);
            }
            if (handle === 0)
            {
                writeU32(slot, 0);
                return at + 8;
            }
            const bytes = readU32(at + 8);
            if (readU32(at + 12) !== handle || readU32(at + 16) !== bytes)
            {
                fault(RPC_X_BAD_STUB_DATA);
            }
            const block = host.heap.allocate(Math.max(bytes, 1)) >>> 0;
            if (block === 0)
            {
                fault(RPC_X_NO_MEMORY);
            }
            if (bytes > 0)
            {
                host.writeMemory(block, host.readMemory(at + 20, bytes).slice());
            }
            writeU32(slot, block);
            return at + 20 + bytes;
        },
        free: (flags, slot)=>{
            const handle = readU32(slot);
            if (!inProcess(flags) && handle !== 0)
            {
                host.heap.free(handle);
            }
        },
    };

    /**
     * The routine gdi32 lends for a copy, or nothing -- and, when a handle
     * leaving the process needs it, the difference reported.
     *
     * @template T
     * @param {T | undefined} routine @param {string} api
     * @returns {T | undefined}
     */
    const lent = (routine, api)=>{
        if (!routine)
        {
            host.divergence?.(api, 'gdi32 cannot copy it here, so it goes as the handle,'
                + ' which means nothing to another process');
        }
        return routine;
    };

    /**
     * A metafile: the handle in-process, else its bits after the handle and
     * their length twice.
     *
     * @param {string} type
     * @param {(gdi: GdiCopies) => ((handle: number) => Uint8Array | null) | undefined} reader
     * @param {(gdi: GdiCopies) => ((bits: Uint8Array) => number) | undefined} maker
     * @param {(gdi: GdiCopies) => ((handle: number) => unknown) | undefined} deleter
     * @returns {Wire}
     */
    const metafileWire = (type, reader, maker, deleter)=>{
        const read = ()=>(host.gdi ? reader(host.gdi) : undefined);
        /** @param {number} flags */
        const byValue = flags=>!inProcess(flags) && read() !== undefined;
        return {
            size: (flags, start, slot)=>{
                const handle = readU32(slot);
                const bits = read();
                if (!byValue(flags) || handle === 0 || !bits)
                {
                    return align(start) + 8;
                }
                return align(start) + 16 + (bits(handle)?.length ?? 0);
            },
            marshal: (flags, buffer, slot)=>{
                const at = align(buffer);
                const handle = readU32(slot);
                const bits = inProcess(flags) ? undefined : lent(read(), `${type}_UserMarshal`);
                if (!bits)
                {
                    return putWords(at, [WDT_INPROC_CALL, handle]);
                }
                if (handle === 0)
                {
                    return putWords(at, [WDT_REMOTE_CALL, 0]);
                }
                const data = bits(handle) ?? new Uint8Array(0);
                const end = putWords(at, [WDT_REMOTE_CALL, handle, data.length, data.length]);
                if (data.length > 0)
                {
                    host.writeMemory(end, data);
                }
                return end + data.length;
            },
            unmarshal: (flags, buffer, slot)=>{
                const at = align(buffer);
                const tag = readU32(at);
                const handle = readU32(at + 4);
                if (tag === WDT_INPROC_CALL)
                {
                    writeU32(slot, handle);
                    return at + 8;
                }
                if (tag !== WDT_REMOTE_CALL)
                {
                    fault(RPC_S_INVALID_TAG);
                }
                if (handle === 0)
                {
                    writeU32(slot, 0);
                    return at + 8;
                }
                const length = readU32(at + 8);
                if (readU32(at + 12) !== length)
                {
                    fault(RPC_X_BAD_STUB_DATA);
                }
                const make = lent(host.gdi ? maker(host.gdi) : undefined, `${type}_UserUnmarshal`);
                writeU32(slot, make ? make(host.readMemory(at + 16, length).slice()) >>> 0 : 0);
                return at + 16 + length;
            },
            free: (flags, slot)=>{
                const handle = readU32(slot);
                if (!inProcess(flags) && handle !== 0 && host.gdi)
                {
                    deleter(host.gdi)?.(handle);
                }
            },
        };
    };

    const hmetafileWire = metafileWire('HMETAFILE', gdi=>gdi.metaFileBits,
        gdi=>gdi.createMetaFile, gdi=>gdi.deleteMetaFile);
    const henhmetafileWire = metafileWire('HENHMETAFILE', gdi=>gdi.enhMetaFileBits,
        gdi=>gdi.createEnhMetaFile, gdi=>gdi.deleteEnhMetaFile);

    /**
     * A bitmap: the handle in-process, else the length of its bits, the
     * BITMAP that describes them up to bmBits, and the bits.
     *
     * @type {Wire}
     */
    const hbitmapWire = {
        size: (flags, start, slot)=>{
            const handle = readU32(slot);
            const bitmap = host.gdi?.bitmap;
            if (inProcess(flags) || handle === 0 || !bitmap)
            {
                return align(start) + 8;
            }
            return align(start) + 12 + BITMAP_HEADER_BYTES + (bitmap(handle)?.bits.length ?? 0);
        },
        marshal: (flags, buffer, slot)=>{
            const at = align(buffer);
            const handle = readU32(slot);
            const bitmap = inProcess(flags) ? undefined
                : lent(host.gdi?.bitmap, 'HBITMAP_UserMarshal');
            if (!bitmap)
            {
                return putWords(at, [WDT_INPROC_CALL, handle]);
            }
            if (handle === 0)
            {
                return putWords(at, [WDT_REMOTE_CALL, 0]);
            }
            const contents = bitmap(handle);
            const bits = contents?.bits ?? new Uint8Array(0);
            const header = new Uint8Array(BITMAP_HEADER_BYTES);
            header.set((contents?.header ?? header).subarray(0, BITMAP_HEADER_BYTES));
            const end = putWords(at, [WDT_REMOTE_CALL, handle, bits.length]);
            host.writeMemory(end, header);
            if (bits.length > 0)
            {
                host.writeMemory(end + BITMAP_HEADER_BYTES, bits);
            }
            return end + BITMAP_HEADER_BYTES + bits.length;
        },
        unmarshal: (flags, buffer, slot)=>{
            const at = align(buffer);
            const tag = readU32(at);
            const handle = readU32(at + 4);
            if (tag === WDT_INPROC_CALL)
            {
                writeU32(slot, handle);
                return at + 8;
            }
            if (tag !== WDT_REMOTE_CALL)
            {
                fault(RPC_S_INVALID_TAG);
            }
            if (handle === 0)
            {
                writeU32(slot, 0);
                return at + 8;
            }
            const length = readU32(at + 8);
            const header = host.readMemory(at + 12, BITMAP_HEADER_BYTES).slice();
            const bits = host.readMemory(at + 12 + BITMAP_HEADER_BYTES, length).slice();
            const make = lent(host.gdi?.createBitmap, 'HBITMAP_UserUnmarshal');
            writeU32(slot, make ? make(header, bits) >>> 0 : 0);
            return at + 12 + BITMAP_HEADER_BYTES + length;
        },
        free: (flags, slot)=>{
            const handle = readU32(slot);
            if (!inProcess(flags) && handle !== 0)
            {
                host.gdi?.deleteObject?.(handle);
            }
        },
    };

    /**
     * A METAFILEPICT in an HGLOBAL: the handle in-process, else the mapping
     * mode and extents, NDR's mark for the pointer that follows, and the
     * metafile in its own wire form.
     *
     * @type {Wire}
     */
    const hmetafilepictWire = {
        size: (flags, start, slot)=>{
            const handle = readU32(slot);
            if (inProcess(flags) || handle === 0)
            {
                return align(start) + 8;
            }
            return hmetafileWire.size(flags, align(start) + 24, handle + METAFILEPICT_HANDLE);
        },
        marshal: (flags, buffer, slot, thread)=>{
            const at = align(buffer);
            const handle = readU32(slot);
            if (inProcess(flags))
            {
                return putWords(at, [WDT_INPROC_CALL, handle]);
            }
            if (handle === 0)
            {
                return putWords(at, [WDT_REMOTE_CALL, 0]);
            }
            const end = putWords(at, [WDT_REMOTE_CALL, handle, readU32(handle), readU32(handle + 4),
                readU32(handle + 8), USER_MARSHAL_PTR_PREFIX]);
            return hmetafileWire.marshal(flags, end, handle + METAFILEPICT_HANDLE, thread);
        },
        unmarshal: (flags, buffer, slot, thread)=>{
            const at = align(buffer);
            const tag = readU32(at);
            const handle = readU32(at + 4);
            if (tag === WDT_INPROC_CALL)
            {
                writeU32(slot, handle);
                return at + 8;
            }
            if (tag !== WDT_REMOTE_CALL)
            {
                fault(RPC_S_INVALID_TAG);
            }
            if (handle === 0)
            {
                writeU32(slot, 0);
                return at + 8;
            }
            const block = host.heap.allocate(METAFILEPICT_BYTES) >>> 0;
            if (block === 0)
            {
                fault(RPC_X_NO_MEMORY);
            }
            putWords(block, [readU32(at + 8), readU32(at + 12), readU32(at + 16), 0]);
            writeU32(slot, block);
            return hmetafileWire.unmarshal(flags, at + 24, block + METAFILEPICT_HANDLE, thread);
        },
        free: (flags, slot, thread)=>{
            const handle = readU32(slot);
            if (!inProcess(flags) && handle !== 0)
            {
                hmetafileWire.free(flags, handle + METAFILEPICT_HANDLE, thread);
                host.heap.free(handle);
            }
        },
    };

    /**
     * A clipboard format: the number, and for a registered one going to
     * another machine its name as well, as a conformant string.
     *
     * @type {Wire}
     */
    const clipformatWire = (()=>{
        /** @param {number} flags @param {number} format */
        const named = (flags, format)=>{
            if (format < FIRST_REGISTERED_FORMAT || context(flags) !== MSHCTX_DIFFERENTMACHINE)
            {
                return null;
            }
            const name = host.clipboardFormats?.name(format) ?? null;
            return name ? name : fault(DV_E_CLIPFORMAT);
        };
        return {
            size: (flags, start, slot)=>{
                const name = named(flags, readU16(slot));
                return align(start) + 8 + (name === null ? 0 : 12 + (name.length + 1) * 2);
            },
            marshal: (flags, buffer, slot)=>{
                const at = align(buffer);
                const format = readU16(slot);
                const name = named(flags, format);
                if (name === null)
                {
                    return putWords(at, [WDT_INPROC_CALL, format]);
                }
                const units = name.length + 1;
                const end = putWords(at, [WDT_REMOTE_CALL, format, units, 0, units]);
                host.writeMemory(end, wideBytes(name));
                return end + units * 2;
            },
            unmarshal: (flags, buffer, slot)=>{
                const at = align(buffer);
                const tag = readU32(at);
                if (tag === WDT_INPROC_CALL)
                {
                    writeU16(slot, readU32(at + 4));
                    return at + 8;
                }
                if (tag !== WDT_REMOTE_CALL)
                {
                    fault(RPC_S_INVALID_TAG);
                }
                const units = readU32(at + 8);
                if (readU32(at + 4) === 0 || units === 0 || readU32(at + 12) !== 0
                    || readU32(at + 16) !== units || readU16(at + 20 + (units - 1) * 2) !== 0)
                {
                    fault(RPC_S_INVALID_BOUND);
                }
                const name = wideText(host.readMemory(at + 20, (units - 1) * 2));
                const format = host.clipboardFormats?.register(name) ?? 0;
                if (format === 0)
                {
                    fault(DV_E_CLIPFORMAT);
                }
                writeU16(slot, format);
                return at + 20 + units * 2;
            },
            free: ()=>0,
        };
    })();

    /**
     * An interface pointer: nothing for NULL, else an OBJREF with its length
     * twice ahead of it.
     *
     * @param {number} start @param {number} pointer
     */
    const pointerSize = (start, pointer)=>(pointer === 0 ? start : align(start) + 8 + OBJREF_BYTES);
    /**
     * @param {number} buffer @param {number} pointer @param {string} iid @param {unknown} thread
     * @returns {number | Promise<number>}
     */
    const pointerMarshal = (buffer, pointer, iid, thread)=>{
        if (pointer === 0)
        {
            return buffer;
        }
        const marshaler = host.marshaler?.();
        if (!marshaler)
        {
            return fault(E_FAIL);
        }
        return marshaler.marshal(pointer, iid, thread).then(made=>{
            if (made.hr < 0 || !made.objref)
            {
                return fault(made.hr < 0 ? made.hr : E_FAIL);
            }
            const at = align(buffer);
            const end = putWords(at, [made.objref.length, made.objref.length]);
            host.writeMemory(end, made.objref);
            return end + made.objref.length;
        });
    };
    /**
     * Reads an interface pointer into `slot`, giving back the reference the
     * pointer it held there had: an [in, out] argument is replaced, not added
     * to. The object is asked for `riid` when the OBJREF carries another
     * interface; with no `riid`, it is taken as it is carried.
     *
     * @param {number} buffer @param {number} slot @param {number} riid @param {unknown} thread
     * @returns {Promise<number>}
     */
    const pointerUnmarshal = async(buffer, slot, riid, thread)=>{
        const at = align(buffer);
        const length = readU32(at);
        if (readU32(at + 4) !== length)
        {
            fault(RPC_X_BAD_STUB_DATA);
        }
        const objref = host.readMemory(at + 8, length).slice();
        const decoded = decodeObjref(objref);
        const marshaler = host.marshaler?.();
        if (!decoded || !marshaler)
        {
            return fault(RPC_E_INVALID_OBJREF);
        }
        const carried = formatGuid(decoded.iid);
        const made = await marshaler.unmarshal(objref, carried, thread);
        if (made.hr < 0)
        {
            fault(made.hr);
        }
        const previous = readU32(slot);
        const wanted = riid === 0 ? GUID_NULL : readGuid(host, riid);
        if (wanted === GUID_NULL || wanted === carried)
        {
            writeU32(slot, made.pointer);
        }
        else
        {
            const hr = await callMethod(made.pointer, SLOT_QUERY_INTERFACE, [riid, slot], thread);
            await release(made.pointer, thread);
            if (hr < 0)
            {
                fault(hr);
            }
        }
        if (previous !== 0)
        {
            await release(previous, thread);
        }
        return at + 8 + length;
    };

    /**
     * The union arm of a medium holding an interface, which crosses as one
     * whatever the IID it is read back as.
     *
     * @param {string} iid
     * @returns {Wire}
     */
    const interfaceArm = iid=>({
        size: (flags, start, slot)=>pointerSize(start, readU32(slot)),
        marshal: (flags, buffer, slot, thread)=>pointerMarshal(buffer, readU32(slot), iid, thread),
        unmarshal: (flags, buffer, slot, thread)=>pointerUnmarshal(buffer, slot, 0, thread),
        free: ()=>0,
    });

    /**
     * A file name: a conformant varying string -- the count, the offset
     * (always 0), the count again, then the characters with their terminator.
     *
     * @type {Wire}
     */
    const fileArm = {
        size: (flags, start, slot)=>align(start) + 12 + (wideUnits(readU32(slot)) + 1) * 2,
        marshal: (flags, buffer, slot)=>{
            const name = readU32(slot);
            const units = wideUnits(name) + 1;
            const end = putWords(align(buffer), [units, 0, units]);
            host.writeMemory(end, host.readMemory(name, units * 2).slice());
            return end + units * 2;
        },
        unmarshal: (flags, buffer, slot)=>{
            const at = align(buffer);
            const units = readU32(at);
            if (units === 0 || readU32(at + 4) !== 0 || readU32(at + 8) !== units
                || readU16(at + 12 + (units - 1) * 2) !== 0)
            {
                fault(RPC_S_INVALID_BOUND);
            }
            const block = host.heap.allocate(units * 2) >>> 0;
            if (block === 0)
            {
                fault(RPC_X_NO_MEMORY);
            }
            host.writeMemory(block, host.readMemory(at + 12, units * 2).slice());
            writeU32(slot, block);
            return at + 12 + units * 2;
        },
        free: ()=>0,
    };

    /**
     * Each medium's arm, and what ReleaseStgMedium does with its value: an
     * interface is always released, anything else is freed only when nobody
     * was named to release it (`owned`).
     *
     * @type {Map<number, { wire: Wire,
     *     dispose: (value: number, owned: boolean, thread: unknown) => unknown }>}
     */
    const arms = new Map([
        [TYMED_HGLOBAL, { wire: hglobalWire, dispose: (value, owned)=>{
            if (owned)
            {
                host.heap.free(value);
            }
        } }],
        [TYMED_FILE, { wire: fileArm, dispose: (value, owned)=>{
            if (owned)
            {
                if (host.deleteFile)
                {
                    host.deleteFile(value);
                }
                else
                {
                    host.divergence?.('STGMEDIUM_UserFree',
                        'the file a medium names is not deleted');
                }
            }
            host.heap.free(value);
        } }],
        [TYMED_ISTREAM, { wire: interfaceArm(IID_ISTREAM),
            dispose: (value, owned, thread)=>release(value, thread) }],
        [TYMED_ISTORAGE, { wire: interfaceArm(IID_ISTORAGE),
            dispose: (value, owned, thread)=>release(value, thread) }],
        [TYMED_MFPICT, { wire: hmetafilepictWire, dispose: (value, owned)=>{
            if (owned)
            {
                host.gdi?.deleteMetaFile?.(readU32(value + METAFILEPICT_HANDLE));
                host.heap.free(value);
            }
        } }],
        [TYMED_ENHMF, { wire: henhmetafileWire, dispose: (value, owned)=>{
            if (owned)
            {
                host.gdi?.deleteEnhMetaFile?.(value);
            }
        } }],
    ]);
    /**
     * A GDI object a medium holds, which has no wire form but is freed like
     * the rest: deleted when nobody was named to release it.
     *
     * @param {number} value @param {boolean} owned
     */
    const disposeGdi = (value, owned)=>{
        if (!owned)
        {
            return;
        }
        if (host.gdi?.deleteObject)
        {
            host.gdi.deleteObject(value);
        }
        else
        {
            host.divergence?.('ReleaseStgMedium', 'the GDI object a medium holds is not deleted');
        }
    };

    /**
     * What ReleaseStgMedium does with a STGMEDIUM: its value disposed of as
     * its tymed says, then pUnkForRelease released.
     *
     * @param {number} medium @param {unknown} thread
     * @returns {number | Promise<number>}
     */
    const releaseMedium = (medium, thread)=>{
        const tymed = readU32(medium);
        const value = readU32(medium + MEDIUM_VALUE);
        const unknown = readU32(medium + MEDIUM_RELEASE);
        const disposed = tymed === TYMED_NULL || value === 0 ? 0
            : tymed === TYMED_GDI ? disposeGdi(value, unknown === 0)
                : arms.get(tymed)?.dispose(value, unknown === 0, thread);
        return after(disposed, ()=>(unknown === 0 ? 0 : release(unknown, thread)));
    };

    /** @param {number} tymed */
    const holdsInterface = tymed=>tymed === TYMED_ISTREAM || tymed === TYMED_ISTORAGE;
    /** @param {number} tymed */
    const armOf = tymed=>{
        const arm = arms.get(tymed);
        if (arm)
        {
            return arm;
        }
        if (tymed === TYMED_GDI)
        {
            host.divergence?.('STGMEDIUM', 'a TYMED_GDI medium does not cross; refused as one'
                + ' with no wire form');
        }
        return fault(DV_E_TYMED);
    };

    /**
     * A STGMEDIUM: the tymed, a mark for the union's value (none for
     * TYMED_NULL) and one for pUnkForRelease, each mark the value itself
     * and 0 for none; then what the marks stand for, the value first.
     *
     * @type {Wire}
     */
    const stgmediumWire = {
        size: (flags, start, medium)=>{
            const tymed = readU32(medium);
            let size = align(start) + 8;
            if (tymed !== TYMED_NULL)
            {
                size += 4;
                if (readU32(medium + MEDIUM_VALUE) !== 0)
                {
                    size = armOf(tymed).wire.size(flags, size, medium + MEDIUM_VALUE);
                }
            }
            return pointerSize(size, readU32(medium + MEDIUM_RELEASE));
        },
        marshal: (flags, buffer, medium, thread)=>{
            const tymed = readU32(medium);
            const value = readU32(medium + MEDIUM_VALUE);
            const unknown = readU32(medium + MEDIUM_RELEASE);
            const wire = tymed === TYMED_NULL ? null : armOf(tymed).wire;
            const marks = wire ? [tymed, value, unknown] : [tymed, unknown];
            const at = putWords(align(buffer), marks);
            const end = wire && value !== 0 ? wire.marshal(flags, at, medium + MEDIUM_VALUE, thread)
                : at;
            return after(end, next=>pointerMarshal(next, unknown, IID_IUNKNOWN, thread));
        },
        unmarshal: (flags, buffer, medium, thread)=>{
            const at = align(buffer);
            const tymed = readU32(at);
            const wire = tymed === TYMED_NULL ? null : armOf(tymed).wire;
            const content = wire ? readU32(at + 4) : 0;
            const unknown = readU32(at + (wire ? 8 : 4));
            const slot = medium + MEDIUM_VALUE;
            const previousTymed = readU32(medium);
            const previous = readU32(slot);
            const held = holdsInterface(previousTymed) && previous !== 0;
            // An interface read over the same arm gives the old one back
            // itself, once the new one is in hand.
            const inPlace = held && content !== 0 && tymed === previousTymed;
            if (!inPlace)
            {
                writeU32(slot, 0);
            }
            writeU32(medium, tymed);
            const start = at + (wire ? 12 : 8);
            const end = wire && content !== 0 ? wire.unmarshal(flags, start, slot, thread) : start;
            const released = held && !inPlace
                ? after(end, next=>release(previous, thread).then(()=>next))
                : end;
            return after(released, next=>(unknown === 0 ? next
                : pointerUnmarshal(next, medium + MEDIUM_RELEASE, 0, thread)));
        },
        free: (flags, medium, thread)=>releaseMedium(medium, thread),
    };

    /**
     * The strings of an SNB: a NULL-terminated array of pointers to them.
     *
     * @param {number} snb
     * @returns {{ address: number, units: number }[]}  units with the terminator
     */
    const snbNames = snb=>{
        const names = [];
        for (let at = snb, address = snb && readU32(at); address !== 0; address = readU32(at))
        {
            names.push({ address, units: wideUnits(address) + 1 });
            at += 4;
        }
        return names;
    };

    /**
     * An SNB: the characters all its strings take, terminators included, how
     * many strings there are, the character count again as the conformance,
     * then the strings one after another. It is read back into one block
     * from the stub message's allocator: the pointers, NULL, the strings.
     *
     * @type {Wire}
     */
    const snbWire = {
        size: (flags, start, slot)=>align(start) + 12
            + snbNames(readU32(slot)).reduce((sum, name)=>sum + name.units, 0) * 2,
        marshal: (flags, buffer, slot)=>{
            const names = snbNames(readU32(slot));
            const units = names.reduce((sum, name)=>sum + name.units, 0);
            let at = putWords(align(buffer), [units, names.length, units]);
            for (const name of names)
            {
                host.writeMemory(at, host.readMemory(name.address, name.units * 2).slice());
                at += name.units * 2;
            }
            return at;
        },
        unmarshal: (flags, buffer, slot, thread)=>{
            const at = align(buffer);
            const units = readU32(at);
            const count = readU32(at + 4);
            if (readU32(at + 8) !== units)
            {
                fault(RPC_X_BAD_STUB_DATA);
            }
            if (units === 0)
            {
                writeU32(slot, 0);
                return at + 12;
            }
            const characters = host.readMemory(at + 12, units * 2).slice();
            /** @type {number[]} */
            const starts = [];
            for (let index = 0, from = 0; index < units && starts.length < count; index++)
            {
                if (characters[index * 2] === 0 && characters[index * 2 + 1] === 0)
                {
                    starts.push(from);
                    from = index + 1;
                }
            }
            const table = (starts.length + 1) * 4;
            return after(stubAllocate(flags, table + units * 2, thread), block=>{
                if (block === 0)
                {
                    fault(RPC_X_NO_MEMORY);
                }
                putWords(block, [...starts.map(from=>block + table + from * 2), 0]);
                host.writeMemory(block + table, characters);
                writeU32(slot, block);
                return at + 12 + units * 2;
            });
        },
        free: (flags, slot, thread)=>{
            const snb = readU32(slot);
            return snb === 0 ? 0 : stubFree(flags, snb, thread);
        },
    };

    /**
     * An export over a routine that may raise: before it has waited on
     * anything the raise is made at once, after it on the thread it resumes.
     *
     * @param {number} argBytes
     * @param {(args: number[], thread: unknown) => number | Promise<number>} body
     */
    const entry = (argBytes, body)=>({
        argBytes,
        /** @param {number[]} args @returns {number | Promise<any>} */
        handler: args=>{
            const thread = host.callerThread?.();
            try
            {
                const answer = body(args.map(arg=>arg >>> 0), thread);
                if (typeof answer === 'number')
                {
                    return answer >>> 0;
                }
                return answer.then(value=>value >>> 0, e=>{
                    if (e instanceof WireFault)
                    {
                        return host.raiseLater(e.code, thread);
                    }
                    throw e;
                });
            }
            catch (e){
                if (e instanceof WireFault)
                {
                    return host.raise(e.code);
                }
                throw e;
            }
        },
    });

    /**
     * The four exports of a type.
     *
     * @param {string} type @param {Wire} wire
     */
    const exportsOf = (type, wire)=>({
        /** ULONG X_UserSize(ULONG *pFlags, ULONG StartingSize, X *pX) */
        [`${type}_UserSize`]: entry(12, ([flags, start, slot])=>wire.size(flags, start, slot)),
        /** unsigned char *X_UserMarshal(ULONG *pFlags, unsigned char *pBuffer, X *pX) */
        [`${type}_UserMarshal`]: entry(12, ([flags, buffer, slot], thread)=>
            wire.marshal(flags, buffer, slot, thread)),
        /** unsigned char *X_UserUnmarshal(ULONG *pFlags, unsigned char *pBuffer, X *pX) */
        [`${type}_UserUnmarshal`]: entry(12, ([flags, buffer, slot], thread)=>
            wire.unmarshal(flags, buffer, slot, thread)),
        /** void X_UserFree(ULONG *pFlags, X *pX) */
        [`${type}_UserFree`]: entry(8, ([flags, slot], thread)=>
            after(wire.free(flags, slot, thread), ()=>0)),
    });

    return {
        ...exportsOf('CLIPFORMAT', clipformatWire),
        ...exportsOf('HWND', handleWire('HWND', false)),
        ...exportsOf('HMENU', handleWire('HMENU', false)),
        ...exportsOf('HACCEL', handleWire('HACCEL', false)),
        ...exportsOf('HICON', handleWire('HICON', false)),
        ...exportsOf('HBRUSH', handleWire('HBRUSH', false)),
        ...exportsOf('HDC', handleWire('HDC', false)),
        ...exportsOf('HPALETTE', handleWire('HPALETTE', true)),
        ...exportsOf('HGLOBAL', hglobalWire),
        ...exportsOf('HBITMAP', hbitmapWire),
        ...exportsOf('HENHMETAFILE', henhmetafileWire),
        ...exportsOf('HMETAFILE', hmetafileWire),
        ...exportsOf('HMETAFILEPICT', hmetafilepictWire),
        ...exportsOf('SNB', snbWire),
        ...exportsOf('STGMEDIUM', stgmediumWire),

        /**
         * ULONG WdtpInterfacePointer_UserSize(ULONG *pFlags, ULONG RealFlags,
         *     ULONG StartingSize, IUnknown *punk, REFIID riid)
         *
         * NULL takes nothing, not even alignment: the code around these says
         * whether a pointer follows.
         */
        WdtpInterfacePointer_UserSize: entry(20, ([, , start, unknown])=>
            pointerSize(start, unknown)),

        /**
         * unsigned char *WdtpInterfacePointer_UserMarshal(ULONG *pFlags,
         *     ULONG RealFlags, unsigned char *pBuffer, IUnknown *punk, REFIID riid)
         */
        WdtpInterfacePointer_UserMarshal: entry(20, ([, , buffer, unknown, riid], thread)=>
            (unknown === 0 ? buffer
                : pointerMarshal(buffer, unknown, readGuid(host, riid), thread))),

        /**
         * unsigned char *WdtpInterfacePointer_UserUnmarshal(ULONG *pFlags,
         *     unsigned char *pBuffer, IUnknown **ppunk, REFIID riid)
         */
        WdtpInterfacePointer_UserUnmarshal: entry(16, ([, buffer, slot, riid], thread)=>
            pointerUnmarshal(buffer, slot, riid, thread)),

        /** void WdtpInterfacePointer_UserFree(IUnknown *punk) */
        WdtpInterfacePointer_UserFree: entry(4, ([unknown], thread)=>
            (unknown === 0 ? 0 : release(unknown, thread).then(()=>0))),

        /**
         * void ReleaseStgMedium(STGMEDIUM *pmedium)
         *
         * The same release STGMEDIUM_UserFree makes, from the one table: an
         * interface is always released; an HGLOBAL, a GDI object, a metafile
         * picture and an enhanced metafile are freed, and a file deleted,
         * only when pUnkForRelease is NULL, since otherwise its release is
         * what frees them; a file's name is task memory and always goes.
         * The medium is TYMED_NULL afterwards, so a second release of it
         * frees nothing twice. NULL is nothing to release.
         */
        ReleaseStgMedium: entry(4, ([medium], thread)=>(medium === 0 ? 0
            : after(releaseMedium(medium, thread), ()=>{
                putWords(medium, [TYMED_NULL, 0, 0]);
                return 0;
            }))),
    };
}
