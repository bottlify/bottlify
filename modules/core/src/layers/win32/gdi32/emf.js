/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The two metafile formats as bytes: the enhanced metafile (EMF), a header
 * and then records of 32-bit fields, each saying its type and its length;
 * and the Windows metafile (WMF), a header and then records of 16-bit words.
 * The layouts are MS-EMF's and MS-WMF's.
 *
 * Nothing here draws or holds a handle. This is the reading and writing of
 * the formats, the check SetEnhMetaFileBits makes before it takes a buffer,
 * the page mapping a metafile's own records set up, and the one conversion
 * done on bytes alone: an EMF written out as a WMF, as GetWinMetaFileBits
 * writes one -- the EMF itself carried whole in comment records at the front,
 * so that SetWinMetaFileBits gives back exactly what went in, and after them
 * the records a reader of WMF alone draws from.
 */

/** EMF record types. */
export const EMR = Object.freeze({
    HEADER: 1, POLYBEZIER: 2, POLYGON: 3, POLYLINE: 4, POLYBEZIERTO: 5, POLYLINETO: 6,
    POLYPOLYLINE: 7, POLYPOLYGON: 8, SETWINDOWEXTEX: 9, SETWINDOWORGEX: 10,
    SETVIEWPORTEXTEX: 11, SETVIEWPORTORGEX: 12, SETBRUSHORGEX: 13, EOF: 14, SETPIXELV: 15,
    SETMAPPERFLAGS: 16, SETMAPMODE: 17, SETBKMODE: 18, SETPOLYFILLMODE: 19, SETROP2: 20,
    SETSTRETCHBLTMODE: 21, SETTEXTALIGN: 22, SETTEXTCOLOR: 24, SETBKCOLOR: 25,
    OFFSETCLIPRGN: 26, MOVETOEX: 27, EXCLUDECLIPRECT: 29, INTERSECTCLIPRECT: 30,
    SCALEVIEWPORTEXTEX: 31, SCALEWINDOWEXTEX: 32, SAVEDC: 33, RESTOREDC: 34,
    SETWORLDTRANSFORM: 35, MODIFYWORLDTRANSFORM: 36, SELECTOBJECT: 37, CREATEPEN: 38,
    CREATEBRUSHINDIRECT: 39, DELETEOBJECT: 40, ANGLEARC: 41, ELLIPSE: 42, RECTANGLE: 43,
    ROUNDRECT: 44, ARC: 45, CHORD: 46, PIE: 47, SELECTPALETTE: 48, CREATEPALETTE: 49,
    REALIZEPALETTE: 52, EXTFLOODFILL: 53, LINETO: 54, ARCTO: 55, POLYDRAW: 56,
    SETARCDIRECTION: 57, SETMITERLIMIT: 58, BEGINPATH: 59, ENDPATH: 60, CLOSEFIGURE: 61,
    FILLPATH: 62, STROKEANDFILLPATH: 63, STROKEPATH: 64, FLATTENPATH: 65, WIDENPATH: 66,
    SELECTCLIPPATH: 67, ABORTPATH: 68, GDICOMMENT: 70, FILLRGN: 71, FRAMERGN: 72,
    INVERTRGN: 73, PAINTRGN: 74, EXTSELECTCLIPRGN: 75, BITBLT: 76, STRETCHBLT: 77,
    SETDIBITSTODEVICE: 80, STRETCHDIBITS: 81, EXTCREATEFONTINDIRECTW: 82, EXTTEXTOUTA: 83,
    EXTTEXTOUTW: 84, POLYBEZIER16: 85, POLYGON16: 86, POLYLINE16: 87, POLYBEZIERTO16: 88,
    POLYLINETO16: 89, POLYPOLYLINE16: 90, POLYPOLYGON16: 91, POLYDRAW16: 92,
    CREATEMONOBRUSH: 93, CREATEDIBPATTERNBRUSHPT: 94, EXTCREATEPEN: 95, SETLAYOUT: 115,
});

/** WMF record functions: the low byte names the call, the high one its parameter count. */
export const META = Object.freeze({
    EOF: 0x0000, SAVEDC: 0x001e, REALIZEPALETTE: 0x0035, SETBKMODE: 0x0102,
    SETMAPMODE: 0x0103, SETROP2: 0x0104, SETPOLYFILLMODE: 0x0106, SETSTRETCHBLTMODE: 0x0107,
    RESTOREDC: 0x0127, SELECTOBJECT: 0x012d, SETTEXTALIGN: 0x012e, DELETEOBJECT: 0x01f0,
    SETBKCOLOR: 0x0201, SETTEXTCOLOR: 0x0209, SETWINDOWORG: 0x020b, SETWINDOWEXT: 0x020c,
    SETVIEWPORTORG: 0x020d, SETVIEWPORTEXT: 0x020e, OFFSETCLIPRGN: 0x0220, LINETO: 0x0213,
    MOVETO: 0x0214, CREATEPENINDIRECT: 0x02fa, CREATEFONTINDIRECT: 0x02fb,
    CREATEBRUSHINDIRECT: 0x02fc, POLYGON: 0x0324, POLYLINE: 0x0325, EXCLUDECLIPRECT: 0x0415,
    INTERSECTCLIPRECT: 0x0416, ELLIPSE: 0x0418, RECTANGLE: 0x041b, SETPIXEL: 0x041f,
    TEXTOUT: 0x0521, POLYPOLYGON: 0x0538, ROUNDRECT: 0x061c, PATBLT: 0x061d, ESCAPE: 0x0626,
    ARC: 0x0817, PIE: 0x081a, CHORD: 0x0830, DIBBITBLT: 0x0940, EXTTEXTOUT: 0x0a32,
    DIBSTRETCHBLT: 0x0b41, STRETCHDIB: 0x0f43, DIBCREATEPATTERNBRUSH: 0x0142,
    SELECTPALETTE: 0x0234, CREATEPALETTE: 0x00f7,
});

/** ' EMF', the header's signature. */
export const ENHMETA_SIGNATURE = 0x464d4520;
/** The header Windows XP writes: ENHMETAHEADER through szlMicrometers. */
export const EMF_HEADER_SIZE = 108;
/** The least a header can be: through szlMillimeters. */
const EMF_HEADER_LEAST = 88;
/** A METAHEADER, in bytes and in the words its own field counts. */
export const WMF_HEADER_SIZE = 18;
const WMF_HEADER_WORDS = 9;
/** The escape that carries a comment, and the 'WMFC' an EMF inside one starts with. */
const MFCOMMENT = 15;
const WMFC = 0x43464d57;
/** How much of an EMF each comment record carries. */
const EMF_CHUNK = 0x2000;

/** ExtTextOut's flags that make its rectangle matter. */
export const ETO_OPAQUE = 0x0002;
export const ETO_CLIPPED = 0x0004;

/** The mapping modes. */
export const MM_TEXT = 1;
export const MM_LOMETRIC = 2;
export const MM_ISOTROPIC = 7;
export const MM_ANISOTROPIC = 8;

/** Logical units to the inch in each fixed mapping mode. */
const UNITS_PER_INCH = new Map([[2, 254], [3, 2540], [4, 100], [5, 1000], [6, 1440]]);

/** ModifyWorldTransform's ways. */
const MWT_IDENTITY = 1;
const MWT_LEFTMULTIPLY = 2;
const MWT_RIGHTMULTIPLY = 3;

/** @typedef {{ left: number, top: number, right: number, bottom: number }} Rect */
/** @typedef {{ cx: number, cy: number }} Size */
/** An XFORM's six numbers: eM11, eM12, eM21, eM22, eDx, eDy. @typedef {number[]} Xform */
export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

/** @param {Uint8Array} bytes */
export const viewOf = bytes=>new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * a then b: a point goes through a first.
 *
 * @param {readonly number[]} a @param {readonly number[]} b
 * @returns {Xform}
 */
export const compose = (a, b)=>[
    a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];

/**
 * @param {readonly number[]} xform @param {{ x: number, y: number }} point
 * @returns {{ x: number, y: number }}
 */
export const apply = (xform, point)=>({
    x: xform[0] * point.x + xform[2] * point.y + xform[4],
    y: xform[1] * point.x + xform[3] * point.y + xform[5],
});

/**
 * A record of an EMF, its header filled in and a view on the rest.
 *
 * @param {number} type @param {number} size  In bytes; rounded up to a DWORD.
 */
export function emfRecord(type, size){
    const length = (size + 3) & ~3;
    const bytes = new Uint8Array(length);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, type, true);
    view.setUint32(4, length, true);
    return { bytes, view };
}

/**
 * The fields of an ENHMETAHEADER.
 *
 * @typedef {Object} EmfHeader
 * @property {number} size
 * @property {Rect} bounds  Inclusive, in the reference device's pixels.
 * @property {Rect} frame  Inclusive, in hundredths of a millimetre.
 * @property {number} bytes @property {number} records @property {number} handles
 * @property {number} descriptionLength @property {number} descriptionOffset
 * @property {number} palEntries
 * @property {Size} device @property {Size} millimeters
 */

/** @param {DataView} view @param {number} at @returns {Rect} */
const readRectL = (view, at)=>({ left: view.getInt32(at, true), top: view.getInt32(at + 4, true),
    right: view.getInt32(at + 8, true), bottom: view.getInt32(at + 12, true) });

/** @param {DataView} view @param {number} at @param {Rect} rect */
const writeRectL = (view, at, rect)=>{
    view.setInt32(at, rect.left, true);
    view.setInt32(at + 4, rect.top, true);
    view.setInt32(at + 8, rect.right, true);
    view.setInt32(at + 12, rect.bottom, true);
};

/**
 * Why SetEnhMetaFileBits refuses a buffer, or null when it takes it. XP
 * says nothing more for most refusals than that it refused: data that is
 * not an EMF header at all is ERROR_INVALID_DATA, and a header with the
 * wrong signature, no handles, a length that is no whole number of DWORDs or
 * longer than the buffer fails with no error (Wine's test_SetEnhMetaFileBits).
 *
 * @param {Uint8Array} bytes
 * @returns {'invalid-data' | 'refused' | null}
 */
export function emfRefusal(bytes){
    if (bytes.length < EMF_HEADER_LEAST)
    {
        return 'invalid-data';
    }
    const view = viewOf(bytes);
    if (view.getUint32(0, true) !== EMR.HEADER)
    {
        return 'invalid-data';
    }
    const length = view.getUint32(48, true);
    if (view.getUint32(40, true) !== ENHMETA_SIGNATURE || view.getUint16(56, true) === 0
        || length % 4 !== 0 || length > bytes.length || length < EMF_HEADER_LEAST
        || view.getUint32(4, true) < EMF_HEADER_LEAST)
    {
        return 'refused';
    }
    return null;
}

/**
 * @param {Uint8Array} bytes  An EMF that `emfRefusal` took.
 * @returns {EmfHeader}
 */
export function readEmfHeader(bytes){
    const view = viewOf(bytes);
    return {
        size: view.getUint32(4, true),
        bounds: readRectL(view, 8),
        frame: readRectL(view, 24),
        bytes: view.getUint32(48, true),
        records: view.getUint32(52, true),
        handles: view.getUint16(56, true),
        descriptionLength: view.getUint32(60, true),
        descriptionOffset: view.getUint32(64, true),
        palEntries: view.getUint32(68, true),
        device: { cx: view.getInt32(72, true), cy: view.getInt32(76, true) },
        millimeters: { cx: view.getInt32(80, true), cy: view.getInt32(84, true) },
    };
}

/**
 * The records of an EMF in order, the header first and nothing after the
 * end-of-file record; a record that says it is shorter than its own header,
 * or runs past the end, ends the list where it stands.
 *
 * @param {Uint8Array} bytes
 * @returns {{ type: number, offset: number, size: number }[]}
 */
export function emfRecords(bytes){
    const view = viewOf(bytes);
    const end = Math.min(bytes.length, view.getUint32(48, true));
    /** @type {{ type: number, offset: number, size: number }[]} */
    const records = [];
    for (let offset = 0; offset + 8 <= end;)
    {
        const type = view.getUint32(offset, true);
        const size = view.getUint32(offset + 4, true);
        if (size < 8 || size % 4 !== 0 || offset + size > end)
        {
            break;
        }
        records.push({ type, offset, size });
        offset += size;
        if (type === EMR.EOF)
        {
            break;
        }
    }
    return records;
}

/**
 * The palette an EMF's end-of-file record carries, as PALETTEENTRY DWORDs.
 *
 * @param {Uint8Array} bytes
 * @returns {number[]}
 */
export function emfPalette(bytes){
    const view = viewOf(bytes);
    const end = emfRecords(bytes).find(record=>record.type === EMR.EOF);
    if (!end || end.size < 16)
    {
        return [];
    }
    const count = view.getUint32(end.offset + 8, true);
    const at = end.offset + view.getUint32(end.offset + 12, true);
    if (count === 0 || at + count * 4 > end.offset + end.size)
    {
        return [];
    }
    return Array.from({ length: count }, (_, index)=>view.getUint32(at + index * 4, true));
}

/**
 * @typedef {Object} EmfPicture
 * @property {Rect | null} bounds  Inclusive device pixels; null for none drawn.
 * @property {Rect | null} frame  Inclusive hundredths of a millimetre; null to
 *     work it out from the bounds.
 * @property {Size} device @property {Size} millimeters
 * @property {number} handles  Including the metafile's own, index zero.
 * @property {string} [description]  The "application\0picture\0" text.
 */

/**
 * An EMF of the records given, between a header that describes them and the
 * end-of-file record.
 *
 * @param {Uint8Array[]} records @param {EmfPicture} picture
 * @returns {Uint8Array}
 */
export function buildEmf(records, picture){
    const description = picture.description ?? '';
    const descriptionBytes = (description.length * 2 + 3) & ~3;
    const header = emfRecord(EMR.HEADER, EMF_HEADER_SIZE + descriptionBytes);
    const eof = emfRecord(EMR.EOF, 20);
    eof.view.setUint32(8, 0, true);
    eof.view.setUint32(12, 16, true);
    eof.view.setUint32(16, 20, true);
    const all = [header.bytes, ...records, eof.bytes];
    const total = all.reduce((sum, record)=>sum + record.length, 0);
    const { device, millimeters } = picture;
    const bounds = picture.bounds ?? { left: 0, top: 0, right: -1, bottom: -1 };
    /** @param {number} value @param {number} mm @param {number} px */
    const toFrame = (value, mm, px)=>Math.floor(value * mm * 100 / Math.max(1, px));
    const frame = picture.frame ?? (picture.bounds ? {
        left: toFrame(bounds.left, millimeters.cx, device.cx),
        top: toFrame(bounds.top, millimeters.cy, device.cy),
        right: toFrame(bounds.right + 1, millimeters.cx, device.cx) - 1,
        bottom: toFrame(bounds.bottom + 1, millimeters.cy, device.cy) - 1,
    } : { left: 0, top: 0, right: -1, bottom: -1 });
    const view = header.view;
    writeRectL(view, 8, bounds);
    writeRectL(view, 24, frame);
    view.setUint32(40, ENHMETA_SIGNATURE, true);
    view.setUint32(44, 0x10000, true);
    view.setUint32(48, total, true);
    view.setUint32(52, all.length, true);
    view.setUint16(56, Math.max(1, picture.handles), true);
    view.setUint32(60, description.length, true);
    view.setUint32(64, description.length > 0 ? EMF_HEADER_SIZE : 0, true);
    view.setUint32(68, 0, true);
    view.setInt32(72, device.cx, true);
    view.setInt32(76, device.cy, true);
    view.setInt32(80, millimeters.cx, true);
    view.setInt32(84, millimeters.cy, true);
    view.setInt32(100, millimeters.cx * 1000, true);
    view.setInt32(104, millimeters.cy * 1000, true);
    for (let index = 0; index < description.length; index++)
    {
        view.setUint16(EMF_HEADER_SIZE + index * 2, description.charCodeAt(index), true);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const record of all)
    {
        bytes.set(record, at);
        at += record.length;
    }
    return bytes;
}

/**
 * The page a metafile's own records set up -- mapping mode, window and
 * viewport -- and its world transform, tracked as the records go by, so a
 * logical point can be taken to the metafile's device: the reference device's
 * pixels. The fixed modes are measured against the reference device's own
 * size in millimetres, as they are when the metafile is drawn.
 *
 * @param {Size} device @param {Size} millimeters
 */
export function createPage(device, millimeters){
    let state = {
        mapMode: MM_TEXT,
        windowOrg: { x: 0, y: 0 }, windowExt: { cx: 1, cy: 1 },
        viewportOrg: { x: 0, y: 0 }, viewportExt: { cx: 1, cy: 1 },
        /** @type {Xform} */
        world: [...IDENTITY],
    };
    /** @type {typeof state[]} */
    const saved = [];
    const scalable = ()=>state.mapMode === MM_ISOTROPIC || state.mapMode === MM_ANISOTROPIC;
    const page = {
        /** The mapping from logical units to the device's pixels. @returns {Xform} */
        transform(){
            const units = UNITS_PER_INCH.get(state.mapMode);
            let sx = 1;
            let sy = 1;
            if (units !== undefined)
            {
                sx = device.cx / (millimeters.cx || 1) * 25.4 / units;
                sy = -device.cy / (millimeters.cy || 1) * 25.4 / units;
            }
            else if (scalable())
            {
                sx = state.viewportExt.cx / (state.windowExt.cx || 1);
                sy = state.viewportExt.cy / (state.windowExt.cy || 1);
                if (state.mapMode === MM_ISOTROPIC)
                {
                    const least = Math.min(Math.abs(sx), Math.abs(sy));
                    sx = Math.sign(sx) * least;
                    sy = Math.sign(sy) * least;
                }
            }
            const pageXform = [sx, 0, 0, sy, state.viewportOrg.x - state.windowOrg.x * sx,
                state.viewportOrg.y - state.windowOrg.y * sy];
            return compose(state.world, pageXform);
        },
        /**
         * Takes in a record that moves the page; false for any other.
         *
         * @param {number} type @param {DataView} view @param {number} at  The record's offset.
         */
        take(type, view, at){
            const a = view.getInt32(at + 8, true);
            const b = view.getInt32(at + 12, true);
            switch (type){
                case EMR.SETMAPMODE:
                    state.mapMode = a;
                    if (!scalable())
                    {
                        state.windowExt = { cx: 1, cy: 1 };
                        state.viewportExt = { cx: 1, cy: 1 };
                    }
                    return true;
                case EMR.SETWINDOWEXTEX:
                    if (scalable() && a !== 0 && b !== 0)
                    {
                        state.windowExt = { cx: a, cy: b };
                    }
                    return true;
                case EMR.SETVIEWPORTEXTEX:
                    if (scalable() && a !== 0 && b !== 0)
                    {
                        state.viewportExt = { cx: a, cy: b };
                    }
                    return true;
                case EMR.SETWINDOWORGEX:
                    state.windowOrg = { x: a, y: b };
                    return true;
                case EMR.SETVIEWPORTORGEX:
                    state.viewportOrg = { x: a, y: b };
                    return true;
                case EMR.SCALEVIEWPORTEXTEX:
                case EMR.SCALEWINDOWEXTEX:
                {
                    const c = view.getInt32(at + 16, true);
                    const d = view.getInt32(at + 20, true);
                    const key = type === EMR.SCALEWINDOWEXTEX ? 'windowExt' : 'viewportExt';
                    if (scalable() && b !== 0 && d !== 0)
                    {
                        const ext = state[key];
                        state[key] = { cx: Math.trunc(ext.cx * a / b) || ext.cx,
                            cy: Math.trunc(ext.cy * c / d) || ext.cy };
                    }
                    return true;
                }
                case EMR.SETWORLDTRANSFORM:
                    state.world = xformAt(view, at + 8);
                    return true;
                case EMR.MODIFYWORLDTRANSFORM:
                {
                    const given = xformAt(view, at + 8);
                    const mode = view.getUint32(at + 32, true);
                    state.world = mode === MWT_IDENTITY ? [...IDENTITY]
                        : mode === MWT_LEFTMULTIPLY ? compose(given, state.world)
                            : mode === MWT_RIGHTMULTIPLY ? compose(state.world, given)
                                : state.world;
                    return true;
                }
                case EMR.SAVEDC:
                    saved.push({ ...state, world: [...state.world] });
                    return true;
                case EMR.RESTOREDC:
                {
                    const level = a < 0 ? saved.length + a : a - 1;
                    if (level >= 0 && level < saved.length)
                    {
                        state = saved[level];
                        saved.length = level;
                    }
                    return true;
                }
                default:
                    return false;
            }
        },
    };
    return page;
}

/** @param {DataView} view @param {number} at @returns {Xform} */
export const xformAt = (view, at)=>Array.from({ length: 6 }, (_, index)=>
    view.getFloat32(at + index * 4, true));

/**
 * The points a record carries: POINTL or POINTS, from `at`.
 *
 * @param {DataView} view @param {number} at @param {number} count @param {boolean} short
 * @returns {{ x: number, y: number }[]}
 */
export const pointsIn = (view, at, count, short)=>Array.from({ length: count }, (_, index)=>(short
    ? { x: view.getInt16(at + index * 4, true), y: view.getInt16(at + index * 4 + 2, true) }
    : { x: view.getInt32(at + index * 8, true), y: view.getInt32(at + index * 8 + 4, true) }));

/**
 * A WMF header for records of the length given, and the end-of-file record
 * after them.
 *
 * @param {Uint8Array[]} records @param {number} objects  The most object slots in use.
 * @returns {Uint8Array}
 */
export function buildWmf(records, objects){
    const eof = Uint8Array.of(3, 0, 0, 0, 0, 0);
    const all = [...records, eof];
    const total = WMF_HEADER_SIZE + all.reduce((sum, record)=>sum + record.length, 0);
    const bytes = new Uint8Array(total);
    const view = viewOf(bytes);
    view.setUint16(0, 1, true);
    view.setUint16(2, WMF_HEADER_WORDS, true);
    view.setUint16(4, 0x300, true);
    view.setUint32(6, total / 2, true);
    view.setUint16(10, objects, true);
    view.setUint32(12, Math.max(...all.map(record=>record.length / 2)), true);
    view.setUint16(16, 0, true);
    let at = WMF_HEADER_SIZE;
    for (const record of all)
    {
        bytes.set(record, at);
        at += record.length;
    }
    return bytes;
}

/** An empty Windows metafile: the header and the end. */
export const blankWmf = ()=>buildWmf([], 0);

/**
 * A WMF record of the function given, its parameter words after it.
 *
 * @param {number} func @param {number[]} words  Each taken as 16 bits.
 * @param {Uint8Array} [tail]  Bytes after the words, padded to a word.
 */
export function wmfRecord(func, words, tail){
    const tailBytes = tail ? (tail.length + 1) & ~1 : 0;
    const bytes = new Uint8Array(6 + words.length * 2 + tailBytes);
    const view = viewOf(bytes);
    view.setUint32(0, bytes.length / 2, true);
    view.setUint16(4, func, true);
    words.forEach((word, index)=>view.setUint16(6 + index * 2, word & 0xffff, true));
    if (tail)
    {
        bytes.set(tail, 6 + words.length * 2);
    }
    return bytes;
}

/**
 * Whether a buffer is a Windows metafile SetWinMetaFileBits can read: a
 * memory or disk metafile's nine-word header, version 1 or 3, and records
 * that fit.
 *
 * @param {Uint8Array} bytes
 */
export function isWmf(bytes){
    if (bytes.length < WMF_HEADER_SIZE + 6 || bytes.length % 2 !== 0)
    {
        return false;
    }
    const view = viewOf(bytes);
    const type = view.getUint16(0, true);
    const version = view.getUint16(4, true);
    return (type === 1 || type === 2) && view.getUint16(2, true) === WMF_HEADER_WORDS
        && (version === 0x100 || version === 0x300);
}

/**
 * The records of a WMF in order, without the end; a record too short or too
 * long for the buffer ends the list.
 *
 * @param {Uint8Array} bytes
 * @returns {{ func: number, offset: number, size: number }[]}
 */
export function wmfRecords(bytes){
    const view = viewOf(bytes);
    /** @type {{ func: number, offset: number, size: number }[]} */
    const records = [];
    for (let offset = WMF_HEADER_SIZE; offset + 6 <= bytes.length;)
    {
        const size = view.getUint32(offset, true) * 2;
        const func = view.getUint16(offset + 4, true);
        if (func === META.EOF || size < 6 || offset + size > bytes.length)
        {
            break;
        }
        records.push({ func, offset, size });
        offset += size;
    }
    return records;
}

/**
 * The EMF a WMF carries in its comment records when GetWinMetaFileBits made
 * it, put back together; null when it carries none, or not all of one.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array | null}
 */
export function embeddedEmf(bytes){
    const view = viewOf(bytes);
    /** @type {Uint8Array | null} */
    let emf = null;
    let filled = 0;
    for (const record of wmfRecords(bytes))
    {
        const at = record.offset + 6;
        if (record.func !== META.ESCAPE || record.size < 44
            || view.getUint16(at, true) !== MFCOMMENT || view.getUint32(at + 4, true) !== WMFC
            || view.getUint32(at + 8, true) !== 1)
        {
            continue;
        }
        const chunk = view.getUint32(at + 26, true);
        const size = view.getUint32(at + 34, true);
        const remaining = view.getUint32(at + 30, true);
        if (chunk > record.size - 44 || size === 0 || size > 0x10000000)
        {
            return null;
        }
        emf ??= new Uint8Array(size);
        const offset = size - remaining - chunk;
        if (emf.length !== size || offset !== filled)
        {
            return null;
        }
        emf.set(bytes.subarray(at + 38, at + 38 + chunk), offset);
        filled += chunk;
    }
    return emf && filled === emf.length ? emf : null;
}

/**
 * The comment records that carry an EMF inside a WMF, as GetWinMetaFileBits
 * writes them: 'WMFC', comment type 1, version 1.0, a checksum on the first
 * (zero here, for the caller to fill), the number of chunks, this chunk's
 * size, what is left after it, the whole EMF's size, and the chunk.
 *
 * @param {Uint8Array} emf
 * @returns {Uint8Array[]}
 */
function emfComments(emf){
    const chunks = Math.max(1, Math.ceil(emf.length / EMF_CHUNK));
    return Array.from({ length: chunks }, (_, index)=>{
        const piece = emf.subarray(index * EMF_CHUNK,
            Math.min(emf.length, (index + 1) * EMF_CHUNK));
        const data = new Uint8Array(34 + piece.length);
        const view = viewOf(data);
        view.setUint32(0, WMFC, true);
        view.setUint32(4, 1, true);
        view.setUint32(8, 0x10000, true);
        view.setUint16(12, 0, true);
        view.setUint32(14, 0, true);
        view.setUint32(18, chunks, true);
        view.setUint32(22, piece.length, true);
        view.setUint32(26, emf.length - index * EMF_CHUNK - piece.length, true);
        view.setUint32(30, emf.length, true);
        data.set(piece, 34);
        return wmfRecord(META.ESCAPE, [MFCOMMENT, data.length], data);
    });
}

/**
 * An EMF as a WMF: GetWinMetaFileBits. The EMF goes in whole first, in
 * comment records, and then the WMF's mapping mode, its window -- the
 * picture frame, in pixels for the modes a program scales and in the fixed
 * mode's units otherwise, y growing upwards -- and the EMF's records over
 * again in WMF's terms, each point taken through the EMF's own page to the
 * reference device and then into the window. The records a WMF has no
 * record for, or that the conversion does not know, are left out. The word
 * sum of the whole is zero, by the first comment's checksum.
 *
 * @param {Uint8Array} emf  One `emfRefusal` took.
 * @param {number} mapMode
 * @param {(text: string) => Uint8Array} encode  Text to the ANSI page.
 * @returns {Uint8Array}
 */
export function emfToWmf(emf, mapMode, encode){
    const header = readEmfHeader(emf);
    const view = viewOf(emf);
    const { device, millimeters, frame } = header;
    const units = UNITS_PER_INCH.get(mapMode);
    // Hundredths of a millimetre to the WMF's logical units, and the
    // reference device's pixels likewise.
    const perHundredth = units === undefined
        ? [device.cx / (millimeters.cx * 100 || 1), device.cy / (millimeters.cy * 100 || 1)]
        : [units / 2540, -units / 2540];
    const perPixel = [perHundredth[0] * (millimeters.cx * 100) / (device.cx || 1),
        perHundredth[1] * (millimeters.cy * 100) / (device.cy || 1)];
    /** @type {Uint8Array[]} */
    const records = [
        ...emfComments(emf),
        wmfRecord(META.SETMAPMODE, [mapMode]),
        wmfRecord(META.SETWINDOWORG, [Math.round(frame.top * perHundredth[1]),
            Math.round(frame.left * perHundredth[0])]),
        wmfRecord(META.SETWINDOWEXT, [Math.round((frame.bottom - frame.top) * perHundredth[1]),
            Math.round((frame.right - frame.left) * perHundredth[0])]),
    ];
    const page = createPage(device, millimeters);
    /** @param {{ x: number, y: number }} point */
    const to = point=>{
        const pixel = apply(page.transform(), point);
        return { x: clamp16(Math.round(pixel.x * perPixel[0])),
            y: clamp16(Math.round(pixel.y * perPixel[1])) };
    };
    /** @param {number} at */
    const pointAt = at=>to({ x: view.getInt32(at, true), y: view.getInt32(at + 4, true) });
    /** @param {number} at  A RECTL, as four words in WMF's order: bottom, right, top, left. */
    const boxAt = at=>{
        const a = pointAt(at);
        const b = pointAt(at + 8);
        return [b.y, b.x, a.y, a.x];
    };
    /** @param {number} length  A logical length across, in the WMF's units. */
    const across = length=>{
        const xform = page.transform();
        return clamp16(Math.round(Math.abs(length * xform[0] * perPixel[0])));
    };
    // Each EMF handle's WMF slot: a WMF fills the lowest slot free.
    /** @type {Map<number, number>} */
    const slots = new Map();
    /** @type {Set<number>} */
    const used = new Set();
    let most = 0;
    /** @param {number} handle */
    const claim = handle=>{
        let slot = 0;
        while (used.has(slot))
        {
            slot++;
        }
        used.add(slot);
        slots.set(handle, slot);
        most = Math.max(most, slot + 1);
    };
    for (const { type, offset: at } of emfRecords(emf))
    {
        if (page.take(type, view, at) && type !== EMR.SAVEDC && type !== EMR.RESTOREDC)
        {
            continue;
        }
        const word = (/** @type {number} */ delta)=>view.getUint32(at + delta, true);
        switch (type){
            case EMR.SETBKMODE: records.push(wmfRecord(META.SETBKMODE, [word(8)])); break;
            case EMR.SETROP2: records.push(wmfRecord(META.SETROP2, [word(8)])); break;
            case EMR.SETPOLYFILLMODE:
                records.push(wmfRecord(META.SETPOLYFILLMODE, [word(8)]));
                break;
            case EMR.SETSTRETCHBLTMODE:
                records.push(wmfRecord(META.SETSTRETCHBLTMODE, [word(8)]));
                break;
            case EMR.SETTEXTALIGN:
                records.push(wmfRecord(META.SETTEXTALIGN, [word(8), word(8) >>> 16]));
                break;
            case EMR.SETTEXTCOLOR:
            case EMR.SETBKCOLOR:
                records.push(wmfRecord(type === EMR.SETTEXTCOLOR ? META.SETTEXTCOLOR
                    : META.SETBKCOLOR, [word(8), word(8) >>> 16]));
                break;
            case EMR.SAVEDC: records.push(wmfRecord(META.SAVEDC, [])); break;
            case EMR.RESTOREDC: records.push(wmfRecord(META.RESTOREDC, [word(8)])); break;
            case EMR.MOVETOEX:
            case EMR.LINETO:
            {
                const point = pointAt(at + 8);
                records.push(wmfRecord(type === EMR.MOVETOEX ? META.MOVETO : META.LINETO,
                    [point.y, point.x]));
                break;
            }
            case EMR.RECTANGLE: records.push(wmfRecord(META.RECTANGLE, boxAt(at + 8))); break;
            case EMR.ELLIPSE: records.push(wmfRecord(META.ELLIPSE, boxAt(at + 8))); break;
            case EMR.INTERSECTCLIPRECT:
            case EMR.EXCLUDECLIPRECT:
                records.push(wmfRecord(type === EMR.INTERSECTCLIPRECT ? META.INTERSECTCLIPRECT
                    : META.EXCLUDECLIPRECT, boxAt(at + 8)));
                break;
            case EMR.ROUNDRECT:
            {
                const corner = to({ x: view.getInt32(at + 24, true),
                    y: view.getInt32(at + 28, true) });
                const origin = to({ x: 0, y: 0 });
                records.push(wmfRecord(META.ROUNDRECT, [Math.abs(corner.y - origin.y),
                    Math.abs(corner.x - origin.x), ...boxAt(at + 8)]));
                break;
            }
            case EMR.ARC:
            case EMR.CHORD:
            case EMR.PIE:
            {
                const start = pointAt(at + 24);
                const end = pointAt(at + 32);
                records.push(wmfRecord(type === EMR.ARC ? META.ARC : type === EMR.CHORD ? META.CHORD
                    : META.PIE, [end.y, end.x, start.y, start.x, ...boxAt(at + 8)]));
                break;
            }
            case EMR.SETPIXELV:
            {
                const point = pointAt(at + 8);
                records.push(wmfRecord(META.SETPIXEL, [word(16), word(16) >>> 16, point.y,
                    point.x]));
                break;
            }
            case EMR.POLYGON: case EMR.POLYLINE: case EMR.POLYGON16: case EMR.POLYLINE16:
            {
                const short = type === EMR.POLYGON16 || type === EMR.POLYLINE16;
                const points = pointsIn(view, at + 28, word(24), short).map(to);
                records.push(wmfRecord(type === EMR.POLYGON || type === EMR.POLYGON16
                    ? META.POLYGON : META.POLYLINE,
                [points.length, ...points.flatMap(point=>[point.x, point.y])]));
                break;
            }
            case EMR.POLYPOLYGON: case EMR.POLYPOLYGON16:
            {
                const count = word(24);
                const counts = Array.from({ length: count }, (_, index)=>word(32 + index * 4));
                const points = pointsIn(view, at + 32 + count * 4,
                    counts.reduce((sum, value)=>sum + value, 0), type === EMR.POLYPOLYGON16)
                    .map(to);
                records.push(wmfRecord(META.POLYPOLYGON,
                    [count, ...counts, ...points.flatMap(point=>[point.x, point.y])]));
                break;
            }
            case EMR.CREATEPEN:
                claim(word(8));
                records.push(wmfRecord(META.CREATEPENINDIRECT, [word(12), across(word(16)), 0,
                    word(24), word(24) >>> 16]));
                break;
            case EMR.CREATEBRUSHINDIRECT:
                claim(word(8));
                records.push(wmfRecord(META.CREATEBRUSHINDIRECT, [word(12), word(16),
                    word(16) >>> 16, word(20)]));
                break;
            case EMR.EXTCREATEFONTINDIRECTW:
            {
                claim(word(8));
                const font = new Uint8Array(50);
                const fontView = viewOf(font);
                const height = view.getInt32(at + 12, true);
                const scaled = Math.round(height * Math.abs(page.transform()[3] * perPixel[1]));
                fontView.setInt16(0, clamp16(scaled), true);
                fontView.setInt16(2, clamp16(across(view.getInt32(at + 16, true))), true);
                for (let index = 2; index < 5; index++)
                {
                    fontView.setInt16(index * 2, clamp16(view.getInt32(at + 12 + index * 4, true)),
                        true);
                }
                font.set(emf.subarray(at + 32, at + 40), 10);
                let face = '';
                for (let index = 0; index < 31; index++)
                {
                    const unit = view.getUint16(at + 40 + index * 2, true);
                    if (unit === 0)
                    {
                        break;
                    }
                    face += String.fromCharCode(unit);
                }
                font.set(encode(face).subarray(0, 31), 18);
                records.push(wmfRecord(META.CREATEFONTINDIRECT, [], font));
                break;
            }
            case EMR.SELECTOBJECT:
            {
                const slot = slots.get(word(8));
                if (slot !== undefined)
                {
                    records.push(wmfRecord(META.SELECTOBJECT, [slot]));
                }
                break;
            }
            case EMR.DELETEOBJECT:
            {
                const slot = slots.get(word(8));
                if (slot !== undefined)
                {
                    records.push(wmfRecord(META.DELETEOBJECT, [slot]));
                    used.delete(slot);
                    slots.delete(word(8));
                }
                break;
            }
            case EMR.EXTTEXTOUTW:
            case EMR.EXTTEXTOUTA:
            {
                const count = word(44);
                const stringAt = at + word(48);
                let text = '';
                for (let index = 0; index < count; index++)
                {
                    text += String.fromCharCode(type === EMR.EXTTEXTOUTW
                        ? view.getUint16(stringAt + index * 2, true) : emf[stringAt + index]);
                }
                const options = word(52) & (ETO_OPAQUE | ETO_CLIPPED);
                const point = pointAt(at + 36);
                const bytes = encode(text);
                const rect = options ? (()=>{
                    const [bottom, right, top, left] = boxAt(at + 56);
                    return [left, top, right, bottom];
                })() : [];
                records.push(wmfRecord(META.EXTTEXTOUT, [point.y, point.x, bytes.length, options,
                    ...rect], bytes));
                break;
            }
            case EMR.STRETCHDIBITS:
            {
                const dib = concat(emf.subarray(at + word(48), at + word(48) + word(52)),
                    emf.subarray(at + word(56), at + word(56) + word(60)));
                const corner = pointAt(at + 24);
                const far = to({ x: view.getInt32(at + 24, true) + view.getInt32(at + 72, true),
                    y: view.getInt32(at + 28, true) + view.getInt32(at + 76, true) });
                records.push(wmfRecord(META.STRETCHDIB, [word(68), word(68) >>> 16, word(64),
                    word(44), word(40), word(36), word(32), far.y - corner.y, far.x - corner.x,
                    corner.y, corner.x], dib));
                break;
            }
            default:
                break;
        }
    }
    const wmf = buildWmf(records, most);
    // The checksum makes the words of the whole add up to nothing.
    const words = viewOf(wmf);
    let sum = 0;
    for (let at = 0; at + 1 < wmf.length; at += 2)
    {
        sum = (sum + words.getUint16(at, true)) & 0xffff;
    }
    const checksumAt = WMF_HEADER_SIZE + 6 + 4 + 12;
    words.setUint16(checksumAt, (0x10000 - sum) & 0xffff, true);
    return wmf;
}

/** @param {number} value */
const clamp16 = value=>Math.max(-0x8000, Math.min(0x7fff, value));

/** @param {Uint8Array} a @param {Uint8Array} b */
const concat = (a, b)=>{
    const bytes = new Uint8Array(a.length + b.length);
    bytes.set(a);
    bytes.set(b, a.length);
    return bytes;
};
