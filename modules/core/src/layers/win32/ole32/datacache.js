/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * CreateDataCache's object: the presentations an embedded object is drawn
 * from while its server is not running, kept in its storage.
 *
 * The cache holds one entry per format it is asked to keep -- a clipboard
 * format, an aspect, a medium -- each with the data it was last given, by
 * SetData, by the running object's notifications, or read from the
 * storage's "\2OlePres000"-numbered streams (or the CONTENTS stream of a
 * static picture class). It answers IOleCache2, IOleCacheControl,
 * IDataObject, IViewObject2 and IPersistStorage, aggregated or not, in the
 * shapes ole2.c's data cache tests record of Windows.
 *
 * Data is kept as the bytes a presentation stream holds -- metafile bits
 * and the picture's extent, an enhanced metafile's bits, a packed DIB, an
 * HGLOBAL's bytes -- and made a handle again each time one is handed out
 * or drawn, through gdi32.
 */

import { GUID_NULL, formatGuid, parseGuid } from './guid.js';
import { FORMATETC_SIZE, STGMEDIUM_SIZE, TYMED, DVASPECT_CONTENT } from './oleutil.js';
import { publishEnumerator } from './enumerator.js';

const S_OK = 0;
const S_FALSE = 1;
const E_INVALIDARG = 0x80070057 | 0;
const E_POINTER = 0x80004003 | 0;
const E_NOTIMPL = 0x80004001 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const E_ABORT = 0x80004004 | 0;
const E_UNEXPECTED = 0x8000ffff | 0;
const E_FAIL = 0x80004005 | 0;
const OLE_E_BLANK = 0x80040007 | 0;
const OLE_E_NOCONNECTION = 0x80040004 | 0;
const OLE_E_ADVISENOTSUPPORTED = 0x80040003 | 0;
const DV_E_FORMATETC = 0x80040064 | 0;
const DV_E_TYMED = 0x80040069 | 0;
const DV_E_LINDEX = 0x80040068 | 0;
const DV_E_DVASPECT = 0x8004006b | 0;
const CACHE_S_FORMATETC_NOTSUPPORTED = 0x00040170;
const CACHE_S_SAMECACHE = 0x00040171;
const CACHE_E_NOCACHE_UPDATED = 0x80040170 | 0;
const STG_E_FILENOTFOUND = 0x80030002 | 0;

export const IID_IOLECACHE = '{0000011E-0000-0000-C000-000000000046}';
export const IID_IOLECACHE2 = '{00000128-0000-0000-C000-000000000046}';
export const IID_IOLECACHECONTROL = '{00000129-0000-0000-C000-000000000046}';
export const IID_IDATAOBJECT = '{0000010E-0000-0000-C000-000000000046}';
export const IID_IVIEWOBJECT = '{0000010D-0000-0000-C000-000000000046}';
export const IID_IVIEWOBJECT2 = '{00000127-0000-0000-C000-000000000046}';
export const IID_IPERSISTSTORAGE = '{0000010A-0000-0000-C000-000000000046}';
const IID_IADVISESINK = '{0000010F-0000-0000-C000-000000000046}';
const IID_IENUMSTATDATA = '{00000105-0000-0000-C000-000000000046}';
const IID_IUNKNOWN = '{00000000-0000-0000-C000-000000000046}';
/** What a cache that is not aggregated answers with one pointer. */
const SHARED = new Set([IID_IUNKNOWN, IID_IOLECACHE, IID_IOLECACHE2]);

export const CLSID_DATA_CACHE = '{7b5b0b8e-1f8c-4b36-9d1c-2a6d4e4b003e}';
const CLSID_CACHE_SINK = '{7b5b0b8e-1f8c-4b36-9d1c-2a6d4e4b003f}';
const CLSID_CACHE_ENUMERATOR = '{7b5b0b8e-1f8c-4b36-9d1c-2a6d4e4b0040}';

/** The static picture classes, whose presentation is their CONTENTS stream. */
export const CLSID_PICTURE_METAFILE = '{00000315-0000-0000-C000-000000000046}';
export const CLSID_PICTURE_DIB = '{00000316-0000-0000-C000-000000000046}';
export const CLSID_PICTURE_ENHMETAFILE = '{00000319-0000-0000-C000-000000000046}';

const CF_BITMAP = 2;
const CF_METAFILEPICT = 3;
const CF_DIB = 8;
const CF_ENHMETAFILE = 14;
const DVASPECT_ICON = 4;
const ADVF_PRIMEFIRST = 2;
const ADVF_NODATA = 1;
const DISCARDCACHE_SAVEIFDIRTY = 0;
const UPDFCACHE_ONLYIFBLANK = 0x80000000;
const UPDFCACHE_IFBLANK = 0x10;
const UPDFCACHE_NODATACACHE = 0x1;
const UPDFCACHE_ONSAVECACHE = 0x2;
const UPDFCACHE_ONSTOPCACHE = 0x4;
const UPDFCACHE_NORMALCACHE = 0x8;
const STGM_READ_EXCLUSIVE = 0x10;
const STGM_CREATE_READWRITE_EXCLUSIVE = 0x1012;
const MM_ANISOTROPIC = 8;
const DIB_RGB_COLORS = 0;
const SRCCOPY = 0x00cc0020;
const HIMETRIC_PER_INCH = 2540;
/** The screen's resolution, which a DIB that names none is taken to have. */
const SCREEN_DPI = 96;
/** That resolution in pels per metre, as MulDiv(96, 10000, 254) rounds it. */
const SCREEN_PELS_PER_METRE = 3780;
const CBM_INIT = 4;
const BITMAP_BYTES = 24;
const BITMAPINFOHEADER_BYTES = 40;
/** A placeable metafile's header, which a static metafile's CONTENTS starts with. */
const PLACEABLE_HEADER = 22;
const PLACEABLE_KEY = 0x9ac6cdd7;
const BITMAP_FILE_HEADER = 14;
const METAFILEPICT_SIZE = 16;
/** The streams a cache's presentations are saved in, numbered from zero. */
const PRESENTATION_PREFIX = '\x02OlePres';
const MAX_PRESENTATIONS = 1000;
const CONTENTS = 'CONTENTS';

/** IAdviseSink's slots, IDataObject's and IOleObject's called here. */
const SLOT = Object.freeze({
    ADD_REF: 1, RELEASE: 2, ON_DATA_CHANGE: 3, ON_VIEW_CHANGE: 4,
    GET_DATA: 3, DADVISE: 9, DUNADVISE: 10,
});

/**
 * One presentation the cache keeps.
 *
 * @typedef {Object} CacheEntry
 * @property {number} id         Its connection.
 * @property {number} format     cfFormat; 0 is any, which only the icon aspect takes.
 * @property {number} aspect
 * @property {number} lindex
 * @property {number} tymed
 * @property {number} advf
 * @property {Uint8Array | null} data  The presentation's bytes, or none yet.
 * @property {{ x: number, y: number }} extent  In HIMETRIC; a metafile picture's own.
 * @property {number} stream     The presentation stream it was read from, or -1.
 * @property {number} sink       The running object's connection for it, or 0.
 * @property {boolean} dirty
 */

/**
 * @typedef {Object} DataCacheEnv
 * @property {import('./oleutil.js').OleEnv} ole
 * @property {ReturnType<typeof import('./oleutil.js').createOleUtil>} util
 * @property {(entry: number, args: number[], thread: unknown) => Promise<number>} [callFunction]
 *     A program's function of its own, called: IViewObject::Draw's continue callback.
 */

/**
 * Whether the cache keeps a presentation of `format` in `tymed` for
 * `aspect`, and as what, as ole2.c's test_data_cache_cache has Windows
 * answer: the icon aspect only as a metafile picture, whatever medium was
 * named; format 0 as the whole aspect in the medium named; the pictures in
 * their own media, a bitmap kept as its DIB; anything else in an HGLOBAL,
 * kept but said not to be supported. A static picture class's cache keeps
 * its own format alone, and the icon.
 *
 * @param {number} format @param {number} aspect @param {number} tymed
 * @param {number | null} only  A static class's one format, or null.
 * @returns {{ hr: number, format: number, tymed: number }}
 */
const acceptance = (format, aspect, tymed, only)=>{
    if (aspect === DVASPECT_ICON)
    {
        return format === 0 || format === CF_METAFILEPICT
            ? { hr: S_OK, format: CF_METAFILEPICT, tymed: TYMED.MFPICT }
            : { hr: DV_E_FORMATETC, format, tymed };
    }
    if (tymed === 0)
    {
        return { hr: DV_E_TYMED, format, tymed };
    }
    if (only !== null)
    {
        return aspect !== DVASPECT_CONTENT ? { hr: DV_E_DVASPECT, format, tymed }
            : format !== only ? { hr: DV_E_FORMATETC, format, tymed }
                : { hr: S_OK, format, tymed };
    }
    if (format === 0)
    {
        return { hr: S_OK, format, tymed };
    }
    const own = { [CF_METAFILEPICT]: TYMED.MFPICT, [CF_BITMAP]: TYMED.GDI, [CF_DIB]: TYMED.HGLOBAL,
        [CF_ENHMETAFILE]: TYMED.ENHMF }[format];
    if (own === tymed)
    {
        return format === CF_BITMAP ? { hr: S_OK, format: CF_DIB, tymed: TYMED.HGLOBAL }
            : { hr: S_OK, format, tymed };
    }
    return tymed === TYMED.HGLOBAL ? { hr: CACHE_S_FORMATETC_NOTSUPPORTED, format, tymed }
        : { hr: DV_E_TYMED, format, tymed };
};

/** A static picture class's one format, or null for any other class. @param {string} clsid */
const staticFormat = clsid=>({ [CLSID_PICTURE_DIB]: CF_DIB,
    [CLSID_PICTURE_METAFILE]: CF_METAFILEPICT,
    [CLSID_PICTURE_ENHMETAFILE]: CF_ENHMETAFILE }[clsid.toUpperCase()] ?? null);

/** @param {DataCacheEnv} context */
export function createDataCaches(context){
    const { ole: env, util } = context;
    const { readU32, writeU32, writeWords, release, system, sayOnce } = util;
    /** @param {number} address */
    const readI32 = address=>readU32(address) | 0;
    /** @param {unknown} thread @param {string} library @param {string} name @param {number[]} args */
    const gdi = async(thread, library, name, args)=>
        (await system(library, name, args, thread)) ?? 0;

    /**
     * A presentation's bytes made a handle of its medium again.
     *
     * @param {CacheEntry} entry @param {unknown} thread
     * @returns {Promise<number>} the handle, or 0
     */
    const handleOf = async(entry, thread)=>{
        const data = entry.data;
        if (!data)
        {
            return 0;
        }
        if (entry.tymed === TYMED.MFPICT)
        {
            const metafile = await gdi(thread, 'GDI32.dll', 'SetMetaFileBitsEx',
                [data.length, await lent(data)]);
            if (!metafile)
            {
                return 0;
            }
            const picture = env.heap.allocate(METAFILEPICT_SIZE);
            if (picture === 0)
            {
                return 0;
            }
            writeWords(picture, [MM_ANISOTROPIC, entry.extent.x, entry.extent.y, metafile]);
            return picture;
        }
        if (entry.tymed === TYMED.ENHMF)
        {
            const at = await lent(data);
            let metafile = await gdi(thread, 'GDI32.dll', 'SetEnhMetaFileBits', [data.length, at]);
            if (!metafile)
            {
                // A presentation of an enhanced metafile may carry a
                // Windows metafile's records, as ole2.c's test writes one.
                metafile = await gdi(thread, 'GDI32.dll', 'SetWinMetaFileBits',
                    [data.length, at, 0, 0]);
            }
            return metafile >>> 0;
        }
        if (entry.tymed === TYMED.GDI)
        {
            sayOnce('IDataObject::GetData', 'a cached bitmap is not handed out as a GDI object');
            return 0;
        }
        const block = env.heap.allocate(Math.max(data.length, 1));
        if (block !== 0)
        {
            env.writeMemory(block, entry.format === CF_DIB ? withResolution(data) : data);
        }
        return block;
    };

    /**
     * A DIB handed out with a resolution: the screen's in both directions
     * when it names none in either.
     *
     * @param {Uint8Array} data
     */
    const withResolution = data=>{
        if (data.length < BITMAPINFOHEADER_BYTES)
        {
            return data;
        }
        const copy = data.slice();
        const view = new DataView(copy.buffer);
        if (view.getInt32(24, true) === 0 || view.getInt32(28, true) === 0)
        {
            view.setInt32(24, SCREEN_PELS_PER_METRE, true);
            view.setInt32(28, SCREEN_PELS_PER_METRE, true);
        }
        return copy;
    };

    /**
     * A packed DIB made a device-dependent bitmap of the screen's.
     *
     * @param {Uint8Array} data @param {unknown} thread
     */
    const bitmapOf = async(data, thread)=>{
        if (data.length < BITMAPINFOHEADER_BYTES)
        {
            return 0;
        }
        const view = new DataView(data.buffer, data.byteOffset);
        const headerSize = view.getUint32(0, true);
        const bits = view.getUint16(14, true);
        const used = view.getUint32(32, true);
        const colours = used || (bits <= 8 ? 1 << bits : 0);
        const info = await lent(data);
        const dc = await gdi(thread, 'USER32.dll', 'GetDC', [0]);
        const bitmap = await gdi(thread, 'GDI32.dll', 'CreateDIBitmap', [dc, info, CBM_INIT,
            info + headerSize + colours * 4, info, DIB_RGB_COLORS]);
        await gdi(thread, 'USER32.dll', 'ReleaseDC', [0, dc]);
        freeScratch();
        return bitmap >>> 0;
    };

    /**
     * A bitmap's bits as a 32-bit packed DIB.
     *
     * @param {number} bitmap @param {unknown} thread
     * @returns {Promise<Uint8Array | null>}
     */
    const dibOf = async(bitmap, thread)=>{
        const about = await lent(new Uint8Array(BITMAP_BYTES));
        if (!await gdi(thread, 'GDI32.dll', 'GetObjectW', [bitmap, BITMAP_BYTES, about]))
        {
            freeScratch();
            return null;
        }
        const width = readI32(about + 4);
        const height = readI32(about + 8);
        const size = width * height * 4;
        const header = new Uint8Array(BITMAPINFOHEADER_BYTES);
        const view = new DataView(header.buffer);
        view.setUint32(0, BITMAPINFOHEADER_BYTES, true);
        view.setInt32(4, width, true);
        view.setInt32(8, height, true);
        view.setUint16(12, 1, true);
        view.setUint16(14, 32, true);
        view.setUint32(20, size, true);
        const info = await lent(header);
        const buffer = await lent(new Uint8Array(size));
        const dc = await gdi(thread, 'USER32.dll', 'GetDC', [0]);
        await gdi(thread, 'GDI32.dll', 'GetDIBits', [dc, bitmap, 0, height, buffer, info,
            DIB_RGB_COLORS]);
        await gdi(thread, 'USER32.dll', 'ReleaseDC', [0, dc]);
        const dib = new Uint8Array(BITMAPINFOHEADER_BYTES + size);
        dib.set(env.readMemory(info, BITMAPINFOHEADER_BYTES), 0);
        dib.set(env.readMemory(buffer, size), BITMAPINFOHEADER_BYTES);
        freeScratch();
        return dib;
    };

    /** Scratch copies, freed when the call that made them is done. @type {number[]} */
    const scratch = [];
    /** @param {Uint8Array} bytes */
    const lent = async bytes=>{
        const block = env.heap.allocate(Math.max(bytes.length, 4));
        if (block !== 0)
        {
            env.writeMemory(block, bytes);
            scratch.push(block);
        }
        return block;
    };
    const freeScratch = ()=>{
        for (const block of scratch.splice(0))
        {
            env.heap.free(block);
        }
    };

    /**
     * A medium of the program's read as a presentation's bytes; null when
     * the medium does not hold what the entry keeps.
     *
     * @param {CacheEntry} entry @param {number} medium @param {unknown} thread
     * @returns {Promise<{ data: Uint8Array, extent: { x: number, y: number } } | null>}
     */
    const bytesOf = async(entry, medium, thread)=>{
        const tymed = readU32(medium);
        const handle = readU32(medium + 4);
        if (entry.format === CF_DIB && tymed === TYMED.GDI && handle !== 0)
        {
            const dib = await dibOf(handle, thread);
            return dib ? { data: dib, extent: dibExtent(dib, 0) } : null;
        }
        if (tymed !== entry.tymed || handle === 0)
        {
            return null;
        }
        if (tymed === TYMED.MFPICT)
        {
            const metafile = readU32(handle + 12);
            const extent = { x: readI32(handle + 4), y: readI32(handle + 8) };
            const size = await gdi(thread, 'GDI32.dll', 'GetMetaFileBitsEx', [metafile, 0, 0]);
            const block = size > 0 ? env.heap.allocate(size) : 0;
            if (block === 0)
            {
                return { data: new Uint8Array(0), extent };
            }
            await gdi(thread, 'GDI32.dll', 'GetMetaFileBitsEx', [metafile, size, block]);
            const data = env.readMemory(block, size).slice();
            env.heap.free(block);
            return { data, extent };
        }
        if (tymed === TYMED.ENHMF)
        {
            const size = await gdi(thread, 'GDI32.dll', 'GetEnhMetaFileBits', [handle, 0, 0]);
            const block = size > 0 ? env.heap.allocate(size) : 0;
            if (block === 0)
            {
                return { data: new Uint8Array(0), extent: { x: 0, y: 0 } };
            }
            await gdi(thread, 'GDI32.dll', 'GetEnhMetaFileBits', [handle, size, block]);
            const data = env.readMemory(block, size).slice();
            env.heap.free(block);
            // The frame, in HIMETRIC hundredths of a millimetre already.
            const view = new DataView(data.buffer);
            const extent = data.length >= 40
                ? { x: view.getInt32(32, true) - view.getInt32(24, true),
                    y: view.getInt32(36, true) - view.getInt32(28, true) }
                : { x: 0, y: 0 };
            return { data, extent };
        }
        if (tymed === TYMED.GDI)
        {
            sayOnce('IOleCache::SetData', 'a bitmap is kept without its bits');
            return { data: new Uint8Array(0), extent: { x: 0, y: 0 } };
        }
        const block = env.heap.block(handle);
        const data = block ? env.readMemory(handle, block.size).slice() : new Uint8Array(0);
        return { data, extent: dibExtent(data, 0) };
    };

    /**
     * A packed DIB's size in HIMETRIC: from its resolution, or the screen's
     * 96 DPI when it names none.
     *
     * @param {Uint8Array} data @param {number} at  Where the BITMAPINFOHEADER starts.
     */
    const dibExtent = (data, at)=>{
        if (data.length < at + 40)
        {
            return { x: 0, y: 0 };
        }
        const view = new DataView(data.buffer, data.byteOffset);
        const width = view.getInt32(at + 4, true);
        const height = Math.abs(view.getInt32(at + 8, true));
        const xpm = view.getInt32(at + 24, true);
        const ypm = view.getInt32(at + 28, true);
        // Without both resolutions the screen's is taken for both, as an
        // integer division of its DPI (ole2.c test_data_cache_dib_contents_stream).
        if (xpm <= 0 || ypm <= 0)
        {
            return { x: Math.trunc(width * HIMETRIC_PER_INCH / SCREEN_DPI),
                y: Math.trunc(height * HIMETRIC_PER_INCH / SCREEN_DPI) };
        }
        // Pels per metre to HIMETRIC: 100 000 hundredths of a millimetre a metre.
        return { x: Math.round(width * 100000 / xpm), y: Math.round(height * 100000 / ypm) };
    };

    /**
     * A presentation stream's bytes, as ole2.c writes one: the format (-1
     * and a predefined one, a length and a registered one's name, or 0),
     * the target device's size, then aspect, lindex, advf, a reserved word,
     * the extent, the data's size and the data.
     *
     * @param {CacheEntry} entry @param {unknown} thread
     */
    const presentationBytes = async(entry, thread)=>{
        /** @type {number[]} */
        const head = [];
        if (entry.format === 0)
        {
            head.push(0);
        }
        else if (entry.format < 0xc000)
        {
            head.push(0xffffffff, entry.format);
        }
        const name = entry.format >= 0xc000 ? await util.formatName(entry.format, thread) : null;
        const nameBytes = name === null ? new Uint8Array(0)
            : Uint8Array.from([...name, '\0'].map(character=>character.charCodeAt(0) & 0xff));
        const data = entry.data ?? new Uint8Array(0);
        const words = [4, entry.aspect, entry.lindex, entry.advf, 0, entry.extent.x,
            entry.extent.y, data.length];
        const bytes = new Uint8Array(head.length * 4 + (name === null ? 0 : 4 + nameBytes.length)
            + words.length * 4 + data.length);
        const view = new DataView(bytes.buffer);
        let at = 0;
        for (const word of head)
        {
            view.setUint32(at, word >>> 0, true);
            at += 4;
        }
        if (name !== null)
        {
            view.setUint32(at, nameBytes.length, true);
            bytes.set(nameBytes, at + 4);
            at += 4 + nameBytes.length;
        }
        for (const word of words)
        {
            view.setUint32(at, word >>> 0, true);
            at += 4;
        }
        bytes.set(data, at);
        return bytes;
    };

    /**
     * A presentation stream read back; null when it is not one.
     *
     * @param {Uint8Array} bytes @param {unknown} thread
     */
    const readPresentation = async(bytes, thread)=>{
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
        let at = 0;
        /** @param {number} need */
        const has = need=>at + need <= bytes.length;
        if (!has(4))
        {
            return null;
        }
        const marker = view.getUint32(0, true);
        at = 4;
        let format = 0;
        if (marker === 0xffffffff || marker === 0xfffffffe)
        {
            if (!has(4))
            {
                return null;
            }
            format = view.getUint32(at, true) & 0xffff;
            at += 4;
        }
        else if (marker !== 0)
        {
            if (!has(marker))
            {
                return null;
            }
            const end = bytes.indexOf(0, at);
            const name = String.fromCharCode(...bytes.subarray(at, end < 0 || end > at + marker
                ? at + marker : end));
            format = await util.registerFormat(name, thread);
            at += marker;
        }
        if (!has(4))
        {
            return null;
        }
        const device = view.getUint32(at, true);
        at += Math.max(device, 4);
        if (!has(28))
        {
            return null;
        }
        const words = [0, 1, 2, 3, 4, 5, 6].map(index=>view.getUint32(at + index * 4, true));
        at += 28;
        const [aspect, lindex, advf, , x, y, size] = words;
        return { format, aspect, lindex: lindex | 0, advf, extent: { x: x | 0, y: y | 0 },
            data: bytes.slice(at, Math.min(at + size, bytes.length)) };
    };

    /**
     * The medium a presentation of `format` is kept in, for a stream that
     * names a format and no medium.
     *
     * @param {number} format @param {number} aspect
     */
    const tymedFor = (format, aspect)=>{
        if (aspect === DVASPECT_ICON)
        {
            return TYMED.MFPICT;
        }
        return { [CF_METAFILEPICT]: TYMED.MFPICT, [CF_BITMAP]: TYMED.HGLOBAL,
            [CF_DIB]: TYMED.HGLOBAL, [CF_ENHMETAFILE]: TYMED.ENHMF }[format] ?? TYMED.HGLOBAL;
    };

    /**
     * @typedef {Object} CacheState
     * @property {number} outer     The aggregating unknown, or 0.
     * @property {any} object       This cache's own.
     * @property {string} clsid
     * @property {CacheEntry[]} entries
     * @property {number} next      The next connection.
     * @property {number} storage   Held after InitNew or Load, until HandsOffStorage.
     * @property {boolean} dirty
     * @property {{ aspects: number, advf: number, sink: number }} view
     * @property {number} running   The running object's IDataObject, held, or 0.
     * @property {number} sinkPointer  The cache's IAdviseSink, made when it runs.
     * @property {boolean} loadedFromStorage
     */

    /**
     * Tells the view sink the aspect changed, if it watches it.
     *
     * @param {CacheState} state @param {number} aspect @param {unknown} thread
     */
    const viewChanged = async(state, aspect, thread)=>{
        if (state.view.sink !== 0 && (state.view.aspects & aspect) !== 0)
        {
            await env.callMethod(state.view.sink, SLOT.ON_VIEW_CHANGE, [aspect, -1], thread);
        }
    };

    /**
     * The entry a FORMATETC names: its format (any format for the icon),
     * its aspect and its lindex.
     *
     * @param {CacheState} state @param {number} format @param {number} aspect
     * @param {number} lindex
     */
    const findEntry = (state, format, aspect, lindex)=>{
        const wanted = format === CF_BITMAP ? CF_DIB
            : aspect === DVASPECT_ICON && format === 0 ? CF_METAFILEPICT : format;
        return state.entries.find(entry=>entry.aspect === aspect && entry.lindex === lindex
            && entry.format === wanted);
    };

    /**
     * An entry's data, read again from the storage if it was dropped and
     * the storage is still held.
     *
     * @param {CacheState} state @param {CacheEntry} entry @param {unknown} thread
     */
    const ensureData = async(state, entry, thread)=>{
        if (entry.data || entry.stream < 0 || state.storage === 0)
        {
            return entry.data;
        }
        const name = entry.stream === Number.MAX_SAFE_INTEGER ? CONTENTS
            : presentationName(entry.stream);
        const opened = await util.openStream(state.storage, name, STGM_READ_EXCLUSIVE, false,
            thread);
        if (opened.hr < 0)
        {
            return null;
        }
        const read = await util.readStream(opened.stream, thread);
        await release(opened.stream, thread);
        if (entry.stream === Number.MAX_SAFE_INTEGER)
        {
            fromContents(state, entry, read.bytes);
            return entry.data;
        }
        const presentation = await readPresentation(read.bytes, thread);
        if (presentation)
        {
            entry.data = presentation.data;
            entry.extent = presentation.extent;
        }
        return entry.data;
    };

    /** @param {number} index */
    const presentationName = index=>`${PRESENTATION_PREFIX}${String(index).padStart(3, '0')}`;

    /**
     * A static picture's CONTENTS: a packed DIB behind its file header, or
     * a metafile's or enhanced metafile's bits.
     *
     * @param {CacheState} state @param {CacheEntry} entry @param {Uint8Array} bytes
     */
    const fromContents = (state, entry, bytes)=>{
        if (state.clsid === CLSID_PICTURE_DIB)
        {
            const data = bytes.length > BITMAP_FILE_HEADER && bytes[0] === 0x42 && bytes[1] === 0x4d
                ? bytes.slice(BITMAP_FILE_HEADER) : bytes.slice();
            entry.data = data;
            entry.extent = dibExtent(data, 0);
            return;
        }
        if (state.clsid === CLSID_PICTURE_ENHMETAFILE && bytes.length >= 4)
        {
            // The size of its header, a copy of the header, then the metafile.
            const headerSize = new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true);
            entry.data = bytes.slice(Math.min(4 + headerSize, bytes.length));
            return;
        }
        if (state.clsid === CLSID_PICTURE_METAFILE && bytes.length >= PLACEABLE_HEADER
            && new DataView(bytes.buffer, bytes.byteOffset).getUint32(0, true) === PLACEABLE_KEY)
        {
            const view = new DataView(bytes.buffer, bytes.byteOffset);
            const units = view.getUint16(14, true) || 1;
            entry.extent = { x: Math.round((view.getInt16(10, true) - view.getInt16(6, true))
                * HIMETRIC_PER_INCH / units), y: Math.round((view.getInt16(12, true)
                - view.getInt16(8, true)) * HIMETRIC_PER_INCH / units) };
            entry.data = bytes.slice(PLACEABLE_HEADER);
            return;
        }
        entry.data = bytes.slice();
    };

    /**
     * Gives the running object an advise for an entry, as the cache keeps
     * every entry current while it runs.
     *
     * @param {CacheState} state @param {CacheEntry} entry @param {unknown} thread
     */
    const adviseRunning = async(state, entry, thread)=>{
        if (state.running === 0)
        {
            return;
        }
        const sink = sinkFor(state);
        await util.withScratch(FORMATETC_SIZE + 4, async block=>{
            writeWords(block, [entry.format, 0, entry.aspect, entry.lindex, entry.tymed, 0]);
            const hr = (await env.callMethod(state.running, SLOT.DADVISE,
                [block, entry.advf, sink, block + FORMATETC_SIZE], thread)) | 0;
            entry.sink = hr < 0 ? 0 : readU32(block + FORMATETC_SIZE) || -1;
            return hr;
        });
    };

    /**
     * Takes back the running object's advise for an entry.
     *
     * @param {CacheState} state @param {CacheEntry} entry @param {unknown} thread
     */
    const unadviseRunning = async(state, entry, thread)=>{
        if (state.running !== 0 && entry.sink !== 0)
        {
            await env.callMethod(state.running, SLOT.DUNADVISE, [entry.sink >>> 0], thread);
        }
        entry.sink = 0;
    };

    /**
     * The cache's own IAdviseSink, which the running object tells of new
     * data: what it is given becomes the entry's.
     *
     * @param {CacheState} state
     */
    const sinkFor = state=>{
        if (state.sinkPointer !== 0)
        {
            return state.sinkPointer;
        }
        const unsupported = (/** @type {string} */ name, /** @type {number} */ argBytes)=>
            ({ name, argBytes, invoke: ()=>S_OK });
        const object = env.makeObject(CLSID_CACHE_SINK, {
            owned: true,
            interfaces: [{ id: IID_IADVISESINK, methods: [
                { name: 'OnDataChange', argBytes: 12, invoke: async(_self, [format, medium])=>{
                    const thread = env.callerThread();
                    const entry = (format >>> 0) === 0 ? undefined : findEntry(state,
                        readU32(format) & 0xffff, readU32(format + 8), readI32(format + 12));
                    if (entry && (medium >>> 0) !== 0)
                    {
                        const read = await bytesOf(entry, medium >>> 0, thread);
                        if (read)
                        {
                            entry.data = read.data;
                            entry.extent = read.extent;
                            entry.dirty = true;
                            state.dirty = true;
                            await viewChanged(state, entry.aspect, thread);
                        }
                    }
                    return S_OK;
                } },
                unsupported('OnViewChange', 12),
                unsupported('OnRename', 8),
                unsupported('OnSave', 4),
                unsupported('OnClose', 4),
            ] }],
        });
        state.sinkPointer = object ? env.publish(object, IID_IADVISESINK) >>> 0 : 0;
        return state.sinkPointer;
    };

    /**
     * The running object let go of, with every advise it was given.
     *
     * @param {CacheState} state @param {unknown} thread
     */
    const stopRunning = async(state, thread)=>{
        if (state.running === 0)
        {
            return;
        }
        for (const entry of state.entries)
        {
            await unadviseRunning(state, entry, thread);
        }
        const running = state.running;
        state.running = 0;
        await release(running, thread);
    };

    /**
     * Writes a medium for an entry into the program's STGMEDIUM.
     *
     * @param {CacheEntry} entry @param {number} medium @param {unknown} thread
     */
    const answerMedium = async(entry, medium, thread)=>{
        const handle = await handleOf(entry, thread);
        freeScratch();
        if (handle === 0)
        {
            return entry.tymed === TYMED.GDI ? OLE_E_BLANK : E_OUTOFMEMORY;
        }
        writeWords(medium, [entry.tymed, handle, 0]);
        return S_OK;
    };

    /**
     * Adds an entry, or finds the one there is.
     *
     * @param {CacheState} state @param {number} format @param {number} aspect
     * @param {number} lindex @param {number} tymed @param {number} advf
     */
    const addEntry = (state, format, aspect, lindex, tymed, advf)=>{
        /** @type {CacheEntry} */
        const entry = { id: state.next++,
            format: aspect === DVASPECT_ICON ? CF_METAFILEPICT : format,
            aspect, lindex, tymed, advf, data: null, extent: { x: 0, y: 0 }, stream: -1, sink: 0,
            dirty: false };
        state.entries.push(entry);
        return entry;
    };

    /** @param {any} object @returns {CacheState} */
    const stateOf = object=>object.state;

    /** @type {import('./objects.js').ComMethod[]} */
    const OLE_CACHE_METHODS = [
        { name: 'Cache', argBytes: 16, invoke: async(object, [format, advf, out])=>{
            const state = stateOf(object);
            if ((format >>> 0) === 0 || (out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            writeU32(out, 0);
            const cf = readU32(format) & 0xffff;
            const aspect = readU32(format + 8);
            const lindex = readI32(format + 12);
            const tymed = readU32(format + 16);
            if (lindex !== -1)
            {
                return DV_E_LINDEX;
            }
            const accepted = acceptance(cf, aspect, tymed, staticFormat(state.clsid));
            if (accepted.hr < 0)
            {
                return accepted.hr;
            }
            const existing = findEntry(state, accepted.format, aspect, lindex);
            if (existing)
            {
                writeU32(out, existing.id);
                return CACHE_S_SAMECACHE;
            }
            const entry = addEntry(state, accepted.format, aspect, lindex, accepted.tymed,
                advf >>> 0);
            writeU32(out, entry.id);
            await adviseRunning(state, entry, env.callerThread());
            return accepted.hr;
        } },
        { name: 'Uncache', argBytes: 8, invoke: async(object, [connection])=>{
            const state = stateOf(object);
            const at = state.entries.findIndex(entry=>entry.id === (connection >>> 0));
            if (at < 0)
            {
                return OLE_E_NOCONNECTION;
            }
            const [entry] = state.entries.splice(at, 1);
            await unadviseRunning(state, entry, env.callerThread());
            state.dirty = true;
            return S_OK;
        } },
        { name: 'EnumCache', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            // A DIB is offered as a bitmap too, under the same connection.
            const items = stateOf(object).entries.flatMap(entry=>(entry.format === CF_DIB
                ? [entry, { ...entry, format: CF_BITMAP, tymed: TYMED.GDI }] : [entry]));
            return publishEnumerator(env, { clsid: CLSID_CACHE_ENUMERATOR, iid: IID_IENUMSTATDATA,
                size: FORMATETC_SIZE + 12 }, {
                items,
                write: (at, entry)=>{
                    writeWords(at, [entry.format, 0, entry.aspect, entry.lindex, entry.tymed,
                        entry.advf, 0, entry.id]);
                    return true;
                },
            }, out >>> 0);
        } },
        { name: 'InitCache', argBytes: 8, invoke: async(object, [data])=>{
            const state = stateOf(object);
            if ((data >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            return updateFrom(state, data >>> 0, UPDFCACHE_NORMALCACHE | UPDFCACHE_IFBLANK,
                env.callerThread());
        } },
        { name: 'SetData', argBytes: 16, invoke: async(object, [format, medium, takeIt])=>{
            const state = stateOf(object);
            if ((format >>> 0) === 0 || (medium >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const thread = env.callerThread();
            const entry = findEntry(state, readU32(format) & 0xffff, readU32(format + 8),
                readI32(format + 12));
            if (!entry)
            {
                return OLE_E_BLANK;
            }
            const read = await bytesOf(entry, medium >>> 0, thread);
            if (!read)
            {
                return DV_E_TYMED;
            }
            entry.data = read.data;
            entry.extent = read.extent;
            entry.dirty = true;
            state.dirty = true;
            if (takeIt)
            {
                await env.releaseMedium(medium >>> 0);
            }
            await viewChanged(state, entry.aspect, thread);
            return S_OK;
        } },
        // IOleCache2
        { name: 'UpdateCache', argBytes: 16, invoke: async(object, [data, flags])=>{
            const state = stateOf(object);
            if ((data >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            return updateFrom(state, data >>> 0, flags >>> 0, env.callerThread());
        } },
        { name: 'DiscardCache', argBytes: 8, invoke: async(object, [options])=>{
            const state = stateOf(object);
            const thread = env.callerThread();
            if ((options >>> 0) === DISCARDCACHE_SAVEIFDIRTY && state.dirty && state.storage !== 0)
            {
                const hr = await save(state, state.storage, thread);
                if (hr < 0)
                {
                    return hr;
                }
            }
            for (const entry of state.entries)
            {
                // What the storage holds can be read again while it is held.
                entry.data = null;
            }
            return S_OK;
        } },
    ];

    /**
     * IOleCache2::UpdateCache's work, which InitCache shares: each entry the
     * flags name taken from the data object, CACHE_E_NOCACHE_UPDATED when
     * none was.
     *
     * @param {CacheState} state @param {number} data @param {number} flags @param {unknown} thread
     */
    const updateFrom = async(state, data, flags, thread)=>{
        let updated = 0;
        let tried = 0;
        for (const entry of state.entries)
        {
            if ((flags & (UPDFCACHE_ONLYIFBLANK | UPDFCACHE_IFBLANK)) !== 0 && entry.data)
            {
                if ((flags & UPDFCACHE_ONLYIFBLANK) !== 0)
                {
                    continue;
                }
            }
            const wants = (entry.advf & ADVF_NODATA) !== 0 ? (flags & UPDFCACHE_NODATACACHE) !== 0
                : (flags & (UPDFCACHE_NORMALCACHE | UPDFCACHE_ONSAVECACHE | UPDFCACHE_ONSTOPCACHE
                    | UPDFCACHE_IFBLANK)) !== 0 || flags === 0;
            if (!wants)
            {
                continue;
            }
            tried++;
            const hr = await util.withScratch(FORMATETC_SIZE + STGMEDIUM_SIZE, async block=>{
                writeWords(block, [entry.format, 0, entry.aspect, entry.lindex, entry.tymed]);
                env.writeMemory(block + FORMATETC_SIZE, new Uint8Array(STGMEDIUM_SIZE));
                const got = (await env.callMethod(data, SLOT.GET_DATA,
                    [block, block + FORMATETC_SIZE], thread)) | 0;
                if (got !== S_OK)
                {
                    return got;
                }
                const read = await bytesOf(entry, block + FORMATETC_SIZE, thread);
                await env.releaseMedium(block + FORMATETC_SIZE);
                if (!read)
                {
                    return DV_E_FORMATETC;
                }
                entry.data = read.data;
                entry.extent = read.extent;
                entry.dirty = true;
                return S_OK;
            }) ?? E_OUTOFMEMORY;
            if (hr === S_OK)
            {
                updated++;
                state.dirty = true;
            }
        }
        return updated > 0 || tried === 0 && state.entries.length === 0 ? (updated > 0 ? S_OK
            : CACHE_E_NOCACHE_UPDATED) : CACHE_E_NOCACHE_UPDATED;
    };

    /** @type {import('./objects.js').ComMethod[]} */
    const CACHE_CONTROL_METHODS = [
        { name: 'OnRun', argBytes: 8, invoke: async(object, [data])=>{
            const state = stateOf(object);
            if ((data >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            if (state.running !== 0)
            {
                return S_OK;
            }
            const thread = env.callerThread();
            await env.callMethod(data >>> 0, SLOT.ADD_REF, [], thread);
            state.running = data >>> 0;
            for (const entry of state.entries)
            {
                await adviseRunning(state, entry, thread);
            }
            return S_OK;
        } },
        { name: 'OnStop', argBytes: 4, invoke: async object=>{
            await stopRunning(stateOf(object), env.callerThread());
            return S_OK;
        } },
    ];

    /** @type {import('./objects.js').ComMethod[]} */
    const DATA_OBJECT_METHODS = [
        { name: 'GetData', argBytes: 12, invoke: async(object, [format, medium])=>{
            const state = stateOf(object);
            if ((format >>> 0) === 0 || (medium >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const thread = env.callerThread();
            const entry = findEntry(state, readU32(format) & 0xffff, readU32(format + 8),
                readI32(format + 12));
            if (!entry || !(await ensureData(state, entry, thread)))
            {
                return OLE_E_BLANK;
            }
            if (entry.format === CF_DIB && (readU32(format) & 0xffff) === CF_BITMAP)
            {
                const bitmap = await bitmapOf(/** @type {Uint8Array} */ (entry.data), thread);
                if (bitmap === 0)
                {
                    return E_OUTOFMEMORY;
                }
                writeWords(medium >>> 0, [TYMED.GDI, bitmap, 0]);
                return S_OK;
            }
            return answerMedium(entry, medium >>> 0, thread);
        } },
        { name: 'GetDataHere', argBytes: 12, invoke: ()=>E_NOTIMPL },
        { name: 'QueryGetData', argBytes: 8, invoke: async(object, [format])=>{
            const state = stateOf(object);
            if ((format >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const entry = findEntry(state, readU32(format) & 0xffff, readU32(format + 8),
                readI32(format + 12));
            return entry && await ensureData(state, entry, env.callerThread()) ? S_OK : S_FALSE;
        } },
        { name: 'GetCanonicalFormatEtc', argBytes: 12, invoke: ()=>E_NOTIMPL },
        { name: 'SetData', argBytes: 16, invoke: (object, args)=>
            OLE_CACHE_METHODS[4].invoke?.(object, args) ?? E_NOTIMPL },
        { name: 'EnumFormatEtc', argBytes: 12, invoke: ()=>E_NOTIMPL },
        { name: 'DAdvise', argBytes: 20, invoke: ()=>OLE_E_ADVISENOTSUPPORTED },
        { name: 'DUnadvise', argBytes: 8, invoke: ()=>OLE_E_NOCONNECTION },
        { name: 'EnumDAdvise', argBytes: 8, invoke: ()=>OLE_E_ADVISENOTSUPPORTED },
    ];

    /**
     * IViewObject::Draw: the entry of the aspect drawn into the bounds, the
     * program's continue callback asked first.
     *
     * @param {any} object @param {number[]} args
     */
    const draw = async(object, [aspect, lindex, , , , dc, bounds, , proceed, argument])=>{
        const state = stateOf(object);
        const thread = env.callerThread();
        const entry = state.entries.find(candidate=>candidate.aspect === (aspect >>> 0)
            && (candidate.lindex === (lindex | 0) || (lindex | 0) === -1)
            && candidate.tymed !== TYMED.HGLOBAL || candidate.aspect === (aspect >>> 0)
            && candidate.format === CF_DIB);
        if (!entry || !(await ensureData(state, entry, thread)))
        {
            return OLE_E_BLANK;
        }
        if ((bounds >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        if ((proceed >>> 0) !== 0 && context.callFunction)
        {
            const goOn = await context.callFunction(proceed >>> 0, [argument >>> 0], thread);
            if (goOn === 0)
            {
                return E_ABORT;
            }
        }
        const [left, top, right, bottom] = [0, 4, 8, 12]
            .map(offset=>readI32((bounds >>> 0) + offset));
        const data = /** @type {Uint8Array} */ (entry.data);
        try
        {
            if (entry.tymed === TYMED.MFPICT)
            {
                const metafile = await gdi(thread, 'GDI32.dll', 'SetMetaFileBitsEx',
                    [data.length, await lent(data)]);
                if (!metafile)
                {
                    return OLE_E_BLANK;
                }
                const saved = await gdi(thread, 'GDI32.dll', 'SaveDC', [dc]);
                await gdi(thread, 'GDI32.dll', 'SetMapMode', [dc, MM_ANISOTROPIC]);
                await gdi(thread, 'GDI32.dll', 'SetWindowOrgEx', [dc, 0, 0, 0]);
                await gdi(thread, 'GDI32.dll', 'SetWindowExtEx',
                    [dc, entry.extent.x || 1, entry.extent.y || 1, 0]);
                await gdi(thread, 'GDI32.dll', 'SetViewportOrgEx', [dc, left, top, 0]);
                await gdi(thread, 'GDI32.dll', 'SetViewportExtEx',
                    [dc, right - left, bottom - top, 0]);
                const played = await gdi(thread, 'GDI32.dll', 'PlayMetaFile', [dc, metafile]);
                await gdi(thread, 'GDI32.dll', 'RestoreDC', [dc, saved]);
                await gdi(thread, 'GDI32.dll', 'DeleteMetaFile', [metafile]);
                return played ? S_OK : E_UNEXPECTED;
            }
            if (entry.tymed === TYMED.ENHMF)
            {
                const metafile = await handleOf(entry, thread);
                if (!metafile)
                {
                    return OLE_E_BLANK;
                }
                const played = await gdi(thread, 'GDI32.dll', 'PlayEnhMetaFile',
                    [dc, metafile, bounds >>> 0]);
                await gdi(thread, 'GDI32.dll', 'DeleteEnhMetaFile', [metafile]);
                return played ? S_OK : E_UNEXPECTED;
            }
            if (entry.format === CF_DIB || entry.format === CF_BITMAP)
            {
                const view = new DataView(data.buffer, data.byteOffset);
                const headerSize = data.length < BITMAPINFOHEADER_BYTES ? 0
                    : view.getUint32(0, true);
                // What is no BITMAPINFOHEADER is no picture to draw.
                if (![12, BITMAPINFOHEADER_BYTES, 108, 124].includes(headerSize))
                {
                    return E_FAIL;
                }
                const bits = view.getUint16(14, true);
                const used = view.getUint32(32, true);
                const colours = used || (bits <= 8 ? 1 << bits : 0);
                const info = await lent(data);
                const width = view.getInt32(4, true);
                const height = Math.abs(view.getInt32(8, true));
                await gdi(thread, 'GDI32.dll', 'StretchDIBits', [dc, left, top, right - left,
                    bottom - top, 0, 0, width, height, info + headerSize + colours * 4, info,
                    DIB_RGB_COLORS, SRCCOPY]);
                return S_OK;
            }
            return OLE_E_BLANK;
        }
        finally
        {
            freeScratch();
        }
    };

    /** @type {import('./objects.js').ComMethod[]} */
    const VIEW_OBJECT_METHODS = [
        { name: 'Draw', argBytes: 44, invoke: draw },
        { name: 'GetColorSet', argBytes: 28, invoke: ()=>E_NOTIMPL },
        { name: 'Freeze', argBytes: 20, invoke: (object, [aspect, , , out])=>{
            const state = stateOf(object);
            if ((out >>> 0) !== 0)
            {
                writeU32(out, 0);
            }
            return state.entries.some(entry=>entry.aspect === (aspect >>> 0)) ? S_OK : OLE_E_BLANK;
        } },
        { name: 'Unfreeze', argBytes: 8, invoke: ()=>S_OK },
        { name: 'SetAdvise', argBytes: 16, invoke: async(object, [aspects, advf, sink])=>{
            const state = stateOf(object);
            const thread = env.callerThread();
            const previous = state.view.sink;
            if ((sink >>> 0) !== 0)
            {
                await env.callMethod(sink >>> 0, SLOT.ADD_REF, [], thread);
            }
            state.view = { aspects: aspects >>> 0, advf: advf >>> 0, sink: sink >>> 0 };
            if (previous !== 0)
            {
                await release(previous, thread);
            }
            if ((sink >>> 0) !== 0 && (advf & ADVF_PRIMEFIRST) !== 0)
            {
                await env.callMethod(sink >>> 0, SLOT.ON_VIEW_CHANGE, [aspects >>> 0, -1], thread);
            }
            return S_OK;
        } },
        { name: 'GetAdvise', argBytes: 16, invoke: async(object, [aspects, advf, sink])=>{
            const state = stateOf(object);
            if ((aspects >>> 0) !== 0)
            {
                writeU32(aspects, state.view.aspects);
            }
            if ((advf >>> 0) !== 0)
            {
                writeU32(advf, state.view.advf);
            }
            if ((sink >>> 0) !== 0)
            {
                writeU32(sink, state.view.sink);
                if (state.view.sink !== 0)
                {
                    await env.callMethod(state.view.sink, SLOT.ADD_REF, [], env.callerThread());
                }
            }
            return S_OK;
        } },
        // IViewObject2
        { name: 'GetExtent', argBytes: 20, invoke: async(object, [aspect, lindex, , out])=>{
            const state = stateOf(object);
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const entry = state.entries.find(candidate=>candidate.aspect === (aspect >>> 0)
                && ((lindex | 0) === -1 || candidate.lindex === (lindex | 0)));
            if (!entry || !(await ensureData(state, entry, env.callerThread())))
            {
                return OLE_E_BLANK;
            }
            writeWords(out, [entry.extent.x, entry.extent.y]);
            return S_OK;
        } },
    ];

    /**
     * Writes every entry with data to the storage, numbered in order; a
     * static picture's one entry goes to CONTENTS instead.
     *
     * @param {CacheState} state @param {number} storage @param {unknown} thread
     */
    const save = async(state, storage, thread)=>{
        let index = 0;
        for (const entry of state.entries)
        {
            await ensureData(state, entry, thread);
        }
        for (const entry of state.entries)
        {
            const bytes = await presentationBytes(entry, thread);
            const name = presentationName(index);
            const opened = await util.openStream(storage, name, STGM_CREATE_READWRITE_EXCLUSIVE,
                true, thread);
            if (opened.hr < 0)
            {
                return opened.hr;
            }
            const hr = await util.writeStream(opened.stream, bytes, thread);
            await release(opened.stream, thread);
            if (hr < 0)
            {
                return hr;
            }
            entry.stream = index;
            entry.dirty = false;
            index++;
        }
        return S_OK;
    };

    /**
     * Reads the storage's presentations: its CONTENTS for a static picture,
     * then every numbered stream until one is missing.
     *
     * @param {CacheState} state @param {number} storage @param {unknown} thread
     */
    const load = async(state, storage, thread)=>{
        const stat = await util.storageClass(storage, thread);
        state.clsid = stat.hr < 0 ? GUID_NULL : formatGuid(stat.clsid);
        const picture = { [CLSID_PICTURE_DIB]: [CF_DIB, TYMED.HGLOBAL],
            [CLSID_PICTURE_METAFILE]: [CF_METAFILEPICT, TYMED.MFPICT],
            [CLSID_PICTURE_ENHMETAFILE]: [CF_ENHMETAFILE, TYMED.ENHMF] }[state.clsid];
        if (picture)
        {
            const opened = await util.openStream(storage, CONTENTS, STGM_READ_EXCLUSIVE, false,
                thread);
            if (opened.hr >= 0)
            {
                const read = await util.readStream(opened.stream, thread);
                await release(opened.stream, thread);
                // The class's own entry is connection 1, whatever the cache
                // was made for.
                state.entries = state.entries.filter(entry=>entry.id !== 1);
                /** @type {CacheEntry} */
                const entry = { id: 1, format: picture[0], aspect: DVASPECT_CONTENT, lindex: -1,
                    tymed: picture[1], advf: 0, data: null, extent: { x: 0, y: 0 },
                    stream: Number.MAX_SAFE_INTEGER, sink: 0, dirty: false };
                state.entries.unshift(entry);
                fromContents(state, entry, read.bytes);
            }
        }
        for (let index = 0; index < MAX_PRESENTATIONS; index++)
        {
            const opened = await util.openStream(storage, presentationName(index),
                STGM_READ_EXCLUSIVE, false, thread);
            if (opened.hr < 0)
            {
                if (opened.hr !== STG_E_FILENOTFOUND)
                {
                    return opened.hr;
                }
                break;
            }
            const read = await util.readStream(opened.stream, thread);
            await release(opened.stream, thread);
            const presentation = await readPresentation(read.bytes, thread);
            if (!presentation)
            {
                continue;
            }
            const entry = addEntry(state, presentation.format, presentation.aspect,
                presentation.lindex, tymedFor(presentation.format, presentation.aspect),
                presentation.advf);
            entry.data = presentation.data;
            entry.extent = presentation.extent;
            entry.stream = index;
        }
        return S_OK;
    };

    /**
     * Holds a storage in place of the one held.
     *
     * @param {CacheState} state @param {number} storage @param {unknown} thread
     */
    const holdStorage = async(state, storage, thread)=>{
        if (storage !== 0)
        {
            await env.callMethod(storage, SLOT.ADD_REF, [], thread);
        }
        const previous = state.storage;
        state.storage = storage;
        if (previous !== 0)
        {
            await release(previous, thread);
        }
    };

    /** @type {import('./objects.js').ComMethod[]} */
    const PERSIST_STORAGE_METHODS = [
        { name: 'GetClassID', argBytes: 8, invoke: (object, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_POINTER;
            }
            env.writeMemory(out >>> 0, /** @type {Uint8Array} */ (parseGuid(stateOf(object).clsid)));
            return S_OK;
        } },
        { name: 'IsDirty', argBytes: 4, invoke: object=>(stateOf(object).dirty ? S_OK : S_FALSE) },
        { name: 'InitNew', argBytes: 8, invoke: async(object, [storage])=>{
            const state = stateOf(object);
            if ((storage >>> 0) === 0)
            {
                return E_POINTER;
            }
            await holdStorage(state, storage >>> 0, env.callerThread());
            state.dirty = true;
            return S_OK;
        } },
        { name: 'Load', argBytes: 8, invoke: async(object, [storage])=>{
            const state = stateOf(object);
            if ((storage >>> 0) === 0)
            {
                return E_POINTER;
            }
            const thread = env.callerThread();
            const hr = await load(state, storage >>> 0, thread);
            if (hr < 0)
            {
                return hr;
            }
            await holdStorage(state, storage >>> 0, thread);
            state.dirty = false;
            return S_OK;
        } },
        { name: 'Save', argBytes: 12, invoke: async(object, [storage])=>{
            const state = stateOf(object);
            if ((storage >>> 0) === 0)
            {
                return E_POINTER;
            }
            return save(state, storage >>> 0, env.callerThread());
        } },
        { name: 'SaveCompleted', argBytes: 8, invoke: async(object, [storage])=>{
            const state = stateOf(object);
            if ((storage >>> 0) !== 0)
            {
                await holdStorage(state, storage >>> 0, env.callerThread());
            }
            state.dirty = false;
            return S_OK;
        } },
        { name: 'HandsOffStorage', argBytes: 4, invoke: async object=>{
            const state = stateOf(object);
            // What was read stays; nothing more is read.
            for (const entry of state.entries)
            {
                if (!entry.data)
                {
                    await ensureData(state, entry, env.callerThread());
                }
                entry.stream = -1;
            }
            await holdStorage(state, 0, env.callerThread());
            return S_OK;
        } },
    ];

    return {
        /**
         * A data cache, its one count the caller's: the inner IUnknown when
         * aggregated, which the outer object holds.
         *
         * @param {number} outer @param {string} clsid
         */
        create(outer, clsid){
            /** @type {CacheState} */
            // Connection 1 is a static picture class's own entry, made
            // with the cache; what is cached after starts at 2.
            const state = { outer, object: null, clsid, entries: [], next: 2, storage: 0,
                dirty: false, view: { aspects: 0, advf: 0, sink: 0 }, running: 0, sinkPointer: 0,
                loadedFromStorage: false };
            const interfaces = [
                { id: IID_IOLECACHE2, methods: OLE_CACHE_METHODS },
                { id: IID_IOLECACHECONTROL, methods: CACHE_CONTROL_METHODS },
                { id: IID_IDATAOBJECT, methods: DATA_OBJECT_METHODS },
                { id: IID_IVIEWOBJECT2, methods: VIEW_OBJECT_METHODS },
                { id: IID_IPERSISTSTORAGE, methods: PERSIST_STORAGE_METHODS },
            ];
            const object = env.makeObject(CLSID_DATA_CACHE, {
                state,
                interfaces: [
                    { id: IID_IOLECACHE, methods: OLE_CACHE_METHODS.slice(0, 5) },
                    { id: IID_IVIEWOBJECT, methods: VIEW_OBJECT_METHODS.slice(0, 6) },
                    ...interfaces,
                ],
                lastRelease: async()=>{
                    const thread = env.callerThread();
                    await stopRunning(state, thread);
                    await holdStorage(state, 0, thread);
                    if (state.view.sink !== 0)
                    {
                        const sink = state.view.sink;
                        state.view.sink = 0;
                        await release(sink, thread);
                    }
                },
            });
            state.object = object;
            const only = staticFormat(clsid);
            if (only !== null)
            {
                state.entries.push({ id: 1, format: only, aspect: DVASPECT_CONTENT, lindex: -1,
                    tymed: { [CF_DIB]: TYMED.HGLOBAL, [CF_METAFILEPICT]: TYMED.MFPICT,
                        [CF_ENHMETAFILE]: TYMED.ENHMF }[only] ?? TYMED.HGLOBAL, advf: 0, data: null,
                    extent: { x: 0, y: 0 }, stream: -1, sink: 0, dirty: false });
            }
            if (object && outer === 0)
            {
                // Not aggregated, the cache is one pointer for IUnknown,
                // IOleCache and IOleCache2 (ole2.c test_data_cache).
                const own = object.interfaceFor.bind(object);
                /** @type {any} */
                let shared = null;
                object.interfaceFor = (/** @type {string} */ id)=>{
                    if (!SHARED.has(id.toUpperCase()))
                    {
                        return own(id);
                    }
                    const found = own(IID_IOLECACHE2);
                    // One record, so one pointer, whichever of the three is asked.
                    shared ??= found ? Object.freeze({ ...found, sharedWith: IID_IOLECACHE2 })
                        : null;
                    return found ? shared : null;
                };
            }
            return object;
        },

        /**
         * A medium of the program's read as the bytes a cache keeps of a
         * picture of `format`, and its extent; null when it holds none.
         *
         * @param {number} format @param {number} medium @param {unknown} thread
         */
        pictureIn: (format, medium, thread)=>{
            const kept = format === CF_BITMAP ? CF_DIB : format;
            /** @type {CacheEntry} */
            const entry = { id: 0, format: kept, aspect: DVASPECT_CONTENT, lindex: -1,
                tymed: { [CF_DIB]: TYMED.HGLOBAL, [CF_METAFILEPICT]: TYMED.MFPICT,
                    [CF_ENHMETAFILE]: TYMED.ENHMF }[kept] ?? TYMED.HGLOBAL, advf: 0, data: null,
                extent: { x: 0, y: 0 }, stream: -1, sink: 0, dirty: false };
            return bytesOf(entry, medium, thread);
        },

        /** The interface a cache is handed out as, for `iid`: one of the three is the second. */
        /** @param {any} object @param {string} iid */
        primary: (object, iid)=>(object.state.outer === 0 && SHARED.has(iid.toUpperCase())
            ? IID_IOLECACHE2 : iid),
        IID_IUNKNOWN,
    };
}
