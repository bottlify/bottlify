/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the OLE half of ole32 -- the container helpers, the clipboard, the
 * advise holders -- shares: guest memory in the shapes OLE passes it, a
 * stream or a storage driven through its own vtable, the formats a data
 * object offers, a copy of a clipboard handle, and the exports of other
 * libraries ole32 imports.
 *
 * A storage or stream is always called through its vtable here, never
 * reached into, so the program's own implementation and this layer's answer
 * the same calls in the same order -- the order Windows makes them in.
 */

import { GUID_SIZE, parseGuid } from './guid.js';

const S_OK = 0;

/** IUnknown's Release, and the slots of IStream and IStorage called here. */
export const SLOT = Object.freeze({
    QUERY_INTERFACE: 0, ADD_REF: 1, RELEASE: 2,
    STREAM_READ: 3, STREAM_WRITE: 4, STREAM_SEEK: 5,
    STORAGE_CREATE_STREAM: 3, STORAGE_OPEN_STREAM: 4, STORAGE_COMMIT: 9,
    STORAGE_SET_CLASS: 15, STORAGE_STAT: 17,
    DATA_GET: 3, DATA_GET_HERE: 4, DATA_QUERY: 5, DATA_ENUM_FORMATS: 8,
    ENUM_NEXT: 3,
});

/** FORMATETC: cfFormat (a WORD, padded), ptd, dwAspect, lindex, tymed. */
export const FORMATETC_SIZE = 20;
/** STGMEDIUM: tymed, the handle or pointer, pUnkForRelease. */
export const STGMEDIUM_SIZE = 12;
/** STATSTG, and where its CLSID lies. */
export const STATSTG_SIZE = 72;
export const STATSTG_CLSID = 48;

export const TYMED = Object.freeze({
    NULL: 0, HGLOBAL: 1, FILE: 2, ISTREAM: 4, ISTORAGE: 8, GDI: 16, MFPICT: 32, ENHMF: 64,
});
export const DVASPECT_CONTENT = 1;
export const DATADIR_GET = 1;

/** The predefined clipboard formats whose handle is not an HGLOBAL of bytes. */
export const CF = Object.freeze({
    TEXT: 1, BITMAP: 2, METAFILEPICT: 3, DIB: 8, PALETTE: 9, UNICODETEXT: 13, ENHMETAFILE: 14,
    DSPBITMAP: 0x82, DSPMETAFILEPICT: 0x83, DSPENHMETAFILE: 0x8e,
});

/** METAFILEPICT: mm, xExt, yExt, hMF. */
const METAFILEPICT_SIZE = 16;
const METAFILEPICT_HANDLE = 12;

/** How many formats a data object's enumerator is read for, at most. */
const MAX_FORMATS = 256;
/** A read through IStream::Read, piece by piece, up to this whole. */
const READ_PIECE = 4096;
const READ_MAX = 1 << 20;

/**
 * @typedef {Object} FormatEtc
 * @property {number} format  cfFormat
 * @property {number} aspect
 * @property {number} lindex
 * @property {number} tymed
 */

/**
 * What the OLE functions are handed by the rest of ole32.
 *
 * @typedef {Object} OleEnv
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => unknown,
 *              block: (address: number) => { size: number } | null }} heap
 *           Task memory and, being the same heap, HGLOBALs.
 * @property {(object: number, slot: number, args: number[], thread?: unknown)
 *     => Promise<number>} callMethod
 * @property {(object: number, iid: string, thread: unknown) => Promise<number>} queryPointer
 *           QueryInterface: the pointer, which the caller releases, or 0.
 * @property {() => unknown} callerThread
 * @property {() => any} currentThread
 * @property {(clsid: string, definition: import('./objects.js').ComClassDefinition)
 *     => import('./objects.js').ComObject | null} makeObject
 * @property {(object: import('./objects.js').ComObject, iid: string) => number} publish
 * @property {(clsid: string, outer: number, context: number, iid: string, out: number)
 *     => Promise<number>} createInstance  CoCreateInstance, the GUIDs lent.
 * @property {(medium: number) => number | Promise<number>} releaseMedium  ReleaseStgMedium.
 * @property {(thread: any) => boolean} oleInitialized
 *           Whether the thread is inside OleInitialize, not only CoInitialize.
 * @property {{ root: (id: number) => any, open: (key: any, path: string) => any,
 *              getValue: (key: any, name: string) => { data: Uint8Array } | null,
 *              subkeys?: (key: any) => string[] } | undefined} [hive]
 * @property {((library: string, name: string, args: number[], thread?: unknown)
 *     => number | Promise<number> | null) | undefined} [system]
 *           Another library's export, as ole32's import of it calls it.
 * @property {((api: string, detail: string) => void) | undefined} [divergence]
 */

/** @param {OleEnv} env */
export function createOleUtil(env){
    /** @param {number} address */
    const readU32 = address=>{
        const bytes = env.readMemory(address >>> 0, 4);
        return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    };
    /** @param {number} address */
    const readU16 = address=>{
        const bytes = env.readMemory(address >>> 0, 2);
        return bytes[0] | (bytes[1] << 8);
    };
    /** @param {number} address @param {number[]} words */
    const writeWords = (address, words)=>{
        const bytes = new Uint8Array(words.length * 4);
        const view = new DataView(bytes.buffer);
        words.forEach((word, index)=>view.setUint32(index * 4, word >>> 0, true));
        env.writeMemory(address >>> 0, bytes);
    };
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>writeWords(address, [value]);
    /** @param {number} address @param {number} value */
    const writeU16 = (address, value)=>env.writeMemory(address >>> 0,
        Uint8Array.of(value & 0xff, (value >>> 8) & 0xff));

    /** @param {string} text  With its terminator. */
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
     * A terminated UTF-16 string, read no further than `max` units.
     *
     * @param {number} address @param {number} [max]
     */
    const readWide = (address, max = 1024)=>{
        let text = '';
        for (let at = address >>> 0; text.length < max; at += 2)
        {
            const unit = readU16(at);
            if (unit === 0)
            {
                break;
            }
            text += String.fromCharCode(unit);
        }
        return text;
    };

    /**
     * Bytes in a block of the heap: a string a callee reads, or a string the
     * caller frees with CoTaskMemFree. 0 when nothing fits.
     *
     * @param {Uint8Array} bytes
     */
    const lend = bytes=>{
        const block = env.heap.allocate(Math.max(bytes.length, 4)) >>> 0;
        if (block !== 0)
        {
            env.writeMemory(block, bytes);
        }
        return block;
    };
    /** @param {string} text */
    const lendWide = text=>lend(wideBytes(text));
    /** @param {string} guid */
    const lendGuid = guid=>lend(/** @type {Uint8Array} */ (parseGuid(guid)));

    /**
     * An export of another library, as ole32's import of it calls it; null
     * when it is not there, or no library is reachable.
     *
     * @param {string} library @param {string} name @param {number[]} args
     * @param {unknown} [thread]
     * @returns {Promise<number | null>}
     */
    const system = async(library, name, args, thread)=>{
        const answer = env.system?.(library, name, args, thread);
        return answer === null || answer === undefined ? null : (await answer) | 0;
    };

    /** The formats said once to be beyond copying. @type {Set<string>} */
    const said = new Set();
    /** @param {string} api @param {string} detail */
    const sayOnce = (api, detail)=>{
        if (!said.has(`${api}\n${detail}`))
        {
            said.add(`${api}\n${detail}`);
            env.divergence?.(api, detail);
        }
    };

    /**
     * A registered clipboard format's number, RegisterClipboardFormatW's;
     * 0 with no user32 to ask.
     *
     * @param {string} name @param {unknown} thread
     */
    const registerFormat = async(name, thread)=>{
        const block = lendWide(name);
        if (block === 0)
        {
            return 0;
        }
        const format = await system('USER32.dll', 'RegisterClipboardFormatW', [block], thread);
        env.heap.free(block);
        return (format ?? 0) & 0xffff;
    };

    /**
     * A registered format's name, GetClipboardFormatNameW's; null for a
     * predefined one or one user32 does not know.
     *
     * @param {number} format @param {unknown} thread
     */
    const formatName = async(format, thread)=>{
        if (format < 0xc000)
        {
            return null;
        }
        const room = 256;
        const block = env.heap.allocate(room * 2) >>> 0;
        if (block === 0)
        {
            return null;
        }
        const length = await system('USER32.dll', 'GetClipboardFormatNameW',
            [format, block, room], thread);
        const name = length ? readWide(block, length) : null;
        env.heap.free(block);
        return name;
    };

    /**
     * Calls a method with a scratch block for what it writes out, which is
     * zeroed first and freed after: `use` reads what it needs from it.
     *
     * @template T
     * @param {number} bytes @param {(block: number) => Promise<T>} use
     * @returns {Promise<T | null>} null when there was no memory for it
     */
    const withScratch = async(bytes, use)=>{
        const block = env.heap.allocate(bytes) >>> 0;
        if (block === 0)
        {
            return null;
        }
        env.writeMemory(block, new Uint8Array(bytes));
        try
        {
            return await use(block);
        }
        finally
        {
            env.heap.free(block);
        }
    };

    /** @param {number} object @param {unknown} thread */
    const release = (object, thread)=>env.callMethod(object, SLOT.RELEASE, [], thread);

    /**
     * IStorage::Stat with STATFLAG_NONAME: the storage's CLSID, or the
     * failure.
     *
     * @param {number} storage @param {unknown} thread
     * @returns {Promise<{ hr: number, clsid: Uint8Array }>}
     */
    const storageClass = async(storage, thread)=>(await withScratch(STATSTG_SIZE, async block=>{
        const hr = (await env.callMethod(storage, SLOT.STORAGE_STAT, [block, 1], thread)) | 0;
        return { hr, clsid: env.readMemory(block + STATSTG_CLSID, GUID_SIZE).slice() };
    })) ?? { hr: 0x8007000e | 0, clsid: new Uint8Array(GUID_SIZE) };

    /**
     * Opens (or, with `create`, creates) a stream of a storage by name.
     *
     * @param {number} storage @param {string} name @param {number} mode
     * @param {boolean} create @param {unknown} thread
     * @returns {Promise<{ hr: number, stream: number }>}
     */
    const openStream = async(storage, name, mode, create, thread)=>{
        const text = lendWide(name);
        const out = env.heap.allocate(4) >>> 0;
        if (text === 0 || out === 0)
        {
            for (const block of [text, out].filter(address=>address !== 0))
            {
                env.heap.free(block);
            }
            return { hr: 0x8007000e | 0, stream: 0 };
        }
        writeU32(out, 0);
        const hr = (await env.callMethod(storage,
            create ? SLOT.STORAGE_CREATE_STREAM : SLOT.STORAGE_OPEN_STREAM,
            create ? [text, mode, 0, 0, out] : [text, 0, mode, 0, out], thread)) | 0;
        const stream = hr < 0 ? 0 : readU32(out);
        env.heap.free(text);
        env.heap.free(out);
        return { hr, stream };
    };

    /**
     * Everything a stream has from its position on, read through its Read.
     *
     * @param {number} stream @param {unknown} thread
     * @returns {Promise<{ hr: number, bytes: Uint8Array }>}
     */
    const readStream = async(stream, thread)=>{
        const block = env.heap.allocate(READ_PIECE + 4) >>> 0;
        if (block === 0)
        {
            return { hr: 0x8007000e | 0, bytes: new Uint8Array(0) };
        }
        /** @type {Uint8Array[]} */
        const pieces = [];
        let total = 0;
        let hr = S_OK;
        while (total < READ_MAX)
        {
            writeU32(block + READ_PIECE, 0);
            hr = (await env.callMethod(stream, SLOT.STREAM_READ,
                [block, READ_PIECE, block + READ_PIECE], thread)) | 0;
            const count = hr < 0 ? 0 : Math.min(readU32(block + READ_PIECE), READ_PIECE);
            pieces.push(env.readMemory(block, count).slice());
            total += count;
            if (hr < 0 || count < READ_PIECE)
            {
                break;
            }
        }
        env.heap.free(block);
        const bytes = new Uint8Array(total);
        let at = 0;
        for (const piece of pieces)
        {
            bytes.set(piece, at);
            at += piece.length;
        }
        return { hr: hr < 0 ? hr : S_OK, bytes };
    };

    /**
     * Writes bytes at a stream's position through its Write.
     *
     * @param {number} stream @param {Uint8Array} bytes @param {unknown} thread
     * @returns {Promise<number>} the HRESULT
     */
    const writeStream = async(stream, bytes, thread)=>{
        const block = lend(bytes);
        if (block === 0)
        {
            return 0x8007000e | 0;
        }
        const hr = (await env.callMethod(stream, SLOT.STREAM_WRITE, [block, bytes.length, 0],
            thread)) | 0;
        env.heap.free(block);
        return hr;
    };

    /** @param {number} at @returns {FormatEtc} */
    const readFormat = at=>({
        format: readU16(at), aspect: readU32(at + 8), lindex: readU32(at + 12) | 0,
        tymed: readU32(at + 16),
    });
    /** @param {number} at @param {FormatEtc} format  Without a target device. */
    const writeFormat = (at, format)=>{
        writeWords(at, [format.format & 0xffff, 0, format.aspect, format.lindex, format.tymed]);
    };

    /**
     * What a data object offers through EnumFormatEtc(DATADIR_GET), as far
     * as its enumerator answers; none when it has no enumerator.
     *
     * @param {number} data @param {unknown} thread
     * @returns {Promise<FormatEtc[]>}
     */
    const formatsOf = async(data, thread)=>(await withScratch(4 + 4 + FORMATETC_SIZE,
        async block=>{
            const hr = (await env.callMethod(data, SLOT.DATA_ENUM_FORMATS, [DATADIR_GET, block],
                thread)) | 0;
            const enumerator = readU32(block);
            if (hr < 0 || enumerator === 0)
            {
                return [];
            }
            /** @type {FormatEtc[]} */
            const formats = [];
            while (formats.length < MAX_FORMATS)
            {
                writeU32(block + 4, 0);
                const next = (await env.callMethod(enumerator, SLOT.ENUM_NEXT,
                    [1, block + 8, block + 4], thread)) | 0;
                if (next !== S_OK || readU32(block + 4) !== 1)
                {
                    break;
                }
                formats.push(readFormat(block + 8));
                // A target device is the callee's to have allocated and
                // the caller's to free.
                const device = readU32(block + 12);
                if (device !== 0)
                {
                    env.heap.free(device);
                }
            }
            await release(enumerator, thread);
            return formats;
        })) ?? [];

    /**
     * The medium a clipboard format comes in: the GDI and metafile handles
     * as themselves, everything else as an HGLOBAL of bytes.
     *
     * @param {number} format
     */
    const tymedOf = format=>{
        switch (format)
        {
            case CF.BITMAP: case CF.DSPBITMAP: case CF.PALETTE:
                return TYMED.GDI;
            case CF.METAFILEPICT: case CF.DSPMETAFILEPICT:
                return TYMED.MFPICT;
            case CF.ENHMETAFILE: case CF.DSPENHMETAFILE:
                return TYMED.ENHMF;
            default:
                return TYMED.HGLOBAL;
        }
    };

    /**
     * A copy of an HGLOBAL's bytes in a block of its own; 0 for a handle
     * that is no block, or no memory.
     *
     * @param {number} handle
     */
    const copyGlobal = handle=>{
        const block = env.heap.block(handle >>> 0);
        if (!block)
        {
            return 0;
        }
        const copy = env.heap.allocate(Math.max(block.size, 1)) >>> 0;
        if (copy !== 0)
        {
            env.writeMemory(copy, env.readMemory(handle >>> 0, block.size).slice());
        }
        return copy;
    };

    /**
     * OleDuplicateData's copy of a clipboard handle: the bytes of an HGLOBAL,
     * a metafile picture with its metafile copied, an enhanced metafile;
     * 0 for what cannot be copied, which a bitmap and a palette cannot here.
     *
     * @param {number} handle @param {number} format @param {unknown} thread
     * @returns {Promise<number>}
     */
    const duplicate = async(handle, format, thread)=>{
        if ((handle >>> 0) === 0)
        {
            return 0;
        }
        switch (tymedOf(format))
        {
            case TYMED.GDI:
                sayOnce('OleDuplicateData', `format ${format}: a GDI object is not copied`);
                return 0;
            case TYMED.ENHMF:
            {
                const copy = await system('GDI32.dll', 'CopyEnhMetaFileW', [handle, 0], thread);
                if (copy === null)
                {
                    sayOnce('OleDuplicateData', 'an enhanced metafile is not copied');
                }
                return (copy ?? 0) >>> 0;
            }
            case TYMED.MFPICT:
            {
                const picture = env.heap.block(handle >>> 0);
                if (!picture || picture.size < METAFILEPICT_SIZE)
                {
                    return 0;
                }
                const metafile = await system('GDI32.dll', 'CopyMetaFileW',
                    [readU32(handle + METAFILEPICT_HANDLE), 0], thread);
                if (!metafile)
                {
                    if (metafile === null)
                    {
                        sayOnce('OleDuplicateData', 'a metafile picture is not copied');
                    }
                    return 0;
                }
                const copy = copyGlobal(handle);
                if (copy !== 0)
                {
                    writeU32(copy + METAFILEPICT_HANDLE, metafile);
                }
                return copy;
            }
            default:
                return copyGlobal(handle);
        }
    };

    return {
        readU32, readU16, writeU32, writeU16, writeWords, wideBytes, readWide, lend, lendWide,
        lendGuid, system, sayOnce, registerFormat, formatName, withScratch, release,
        storageClass, openStream, readStream, writeStream, readFormat, writeFormat, formatsOf,
        tymedOf, copyGlobal, duplicate,
    };
}
