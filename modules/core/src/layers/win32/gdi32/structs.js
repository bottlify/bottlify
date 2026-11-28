/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gdi32 structures, each declared once as wingdi.h declares it and laid
 * out by `system/layout.js` at the width the guest was compiled for.
 *
 * Unlike the user32 ones, these are not uniform runs of DWORDs: a LOGFONTA ends
 * in eight bytes and a fixed character array, a BITMAPINFOHEADER has two WORDs
 * in the middle, and a TEXTMETRIC is eleven LONGs followed by nine bytes and
 * three bytes of tail padding. An offset is part of the ABI: a field read from
 * the wrong place is a plausible-looking value rather than an error.
 *
 * Reading and writing them lives here too, so that the offsets and the code that
 * uses them cannot drift apart.
 */

import { decodeAnsi, encodeAnsi } from '../kernel32/locale.js';
import { wholeAddress } from '../common/pointers.js';
import { POINT as POINT_LAYOUT, struct } from '../../../system/layout.js';

/** @typedef {import('../../../system/layout.js').Declared} Declared */

/** @param {readonly string[]} names @param {'u32' | 'i32'} kind @returns {Declared[]} */
const all = (names, kind)=>names.map(name=>[name, kind]);

/** LOGPEN. Its width is a POINT, of which only the x is ever meaningful. */
export const LOGPEN = struct([['lopnStyle', 'u32'], ['lopnWidth', POINT_LAYOUT],
    ['lopnColor', 'u32']]).at(4);

/**
 * LOGBRUSH. lbHatch is a hatch index for BS_HATCHED and a bitmap for
 * BS_PATTERN: a ULONG_PTR, eight bytes in a 64-bit process.
 */
const LOGBRUSH_LAYOUT = struct([['lbStyle', 'u32'], ['lbColor', 'u32'], ['lbHatch', 'ptr']]);
export const LOGBRUSH = LOGBRUSH_LAYOUT.at(4);
export const LOGBRUSH64 = LOGBRUSH_LAYOUT.at(8);

/** The face name field of a LOGFONT is this many characters, terminator included. */
export const LF_FACESIZE = 32;

/** LOGFONT's fields before the face name: five LONGs, then eight bytes, unpadded. */
const LOGFONT_HEAD = /** @type {Declared[]} */ ([
    ...all(['lfHeight', 'lfWidth', 'lfEscapement', 'lfOrientation', 'lfWeight'], 'i32'),
    ...['lfItalic', 'lfUnderline', 'lfStrikeOut', 'lfCharSet', 'lfOutPrecision',
        'lfClipPrecision', 'lfQuality', 'lfPitchAndFamily'].map(name=>[name, 'u8']),
]);

/** LOGFONTA: the face name in bytes. */
export const LOGFONTA = struct([...LOGFONT_HEAD, ['lfFaceName', 'u8', LF_FACESIZE]]).at(4);

/** LOGFONTW: LOGFONTA with the face name as 32 WCHARs. */
export const LOGFONTW_SIZE = struct([...LOGFONT_HEAD, ['lfFaceName', 'u16', LF_FACESIZE]])
    .sizeOf(4);

/** BITMAPINFOHEADER. biPlanes and biBitCount are WORDs; everything else is 32 bits. */
const BITMAPINFOHEADER_LAYOUT = struct([['biSize', 'u32'], ['biWidth', 'i32'],
    ['biHeight', 'i32'], ['biPlanes', 'u16'], ['biBitCount', 'u16'], ['biCompression', 'u32'],
    ['biSizeImage', 'u32'], ['biXPelsPerMeter', 'i32'], ['biYPelsPerMeter', 'i32'],
    ['biClrUsed', 'u32'], ['biClrImportant', 'u32']]);
export const BITMAPINFOHEADER = BITMAPINFOHEADER_LAYOUT.at(4);

/** BITMAPCOREHEADER, the OS/2 header: bcSize, then four WORDs. */
export const BITMAPCOREHEADER = struct([['bcSize', 'u32'], ['bcWidth', 'u16'],
    ['bcHeight', 'u16'], ['bcPlanes', 'u16'], ['bcBitCount', 'u16']]).at(4);

/**
 * BITMAP, as GetObject writes it. bmPlanes and bmBitsPixel are WORDs; bmBits
 * is the DIB section's pointer and NULL for a device-dependent bitmap, whose
 * bits the program has no address for. In a 64-bit process the pointer is
 * eight bytes on an eight-byte boundary and the whole padded to eight.
 */
const BITMAP_LAYOUT = struct([['bmType', 'i32'], ['bmWidth', 'i32'], ['bmHeight', 'i32'],
    ['bmWidthBytes', 'i32'], ['bmPlanes', 'u16'], ['bmBitsPixel', 'u16'], ['bmBits', 'ptr']]);
export const BITMAP = BITMAP_LAYOUT.at(4);
export const BITMAP64 = BITMAP_LAYOUT.at(8);

/**
 * DIBSECTION: a BITMAP, the header the section was made from, its masks,
 * then the section's HANDLE and the offset into it.
 */
const DIBSECTION_LAYOUT = struct([['dsBm', BITMAP_LAYOUT], ['dsBmih', BITMAPINFOHEADER_LAYOUT],
    ['dsBitfields', 'u32', 3], ['dshSection', 'handle'], ['dsOffset', 'u32']]);
export const DIBSECTION = DIBSECTION_LAYOUT.at(4);
export const DIBSECTION64 = DIBSECTION_LAYOUT.at(8);

/**
 * EXTLOGPEN at 64 bits: the hatch (ULONG_PTR) a quadword, the dash table
 * after the count; GetObject writes it up to the last dash.
 */
export const EXTLOGPEN64 = struct([['elpPenStyle', 'u32'], ['elpWidth', 'u32'],
    ['elpBrushStyle', 'u32'], ['elpColor', 'u32'], ['elpHatch', 'ptr'], ['elpNumEntries', 'u32'],
    ['elpStyleEntry', 'u32', 1]]).at(8);

/**
 * Bytes per row of a device-dependent bitmap, which pads to a WORD -- the
 * layout CreateBitmap's lpBits and GetBitmapBits' buffer are in.
 *
 * @param {number} width @param {number} bitCount
 */
export const ddbStride = (width, bitCount)=>(((width * bitCount + 15) >>> 4) * 2);

/**
 * Bytes per row of a DIB, which pads to a DWORD.
 *
 * @param {number} width @param {number} bitCount
 */
export const dibStride = (width, bitCount)=>(((width * bitCount + 31) >>> 5) * 4);

/** TEXTMETRIC's eleven LONGs, the same in both character sets. */
const TEXTMETRIC_LONGS = all(['tmHeight', 'tmAscent', 'tmDescent', 'tmInternalLeading',
    'tmExternalLeading', 'tmAveCharWidth', 'tmMaxCharWidth', 'tmWeight', 'tmOverhang',
    'tmDigitizedAspectX', 'tmDigitizedAspectY'], 'i32');
/** Its five BYTEs after the four characters. */
const TEXTMETRIC_BYTES = /** @type {Declared[]} */ (['tmItalic', 'tmUnderlined', 'tmStruckOut',
    'tmPitchAndFamily', 'tmCharSet'].map(name=>[name, 'u8']));
/** @param {'u8' | 'u16'} character @returns {Declared[]} */
const textMetricCharacters = character=>['tmFirstChar', 'tmLastChar', 'tmDefaultChar',
    'tmBreakChar'].map(name=>[name, character]);

/**
 * TEXTMETRICA. Nine bytes sit past the eleven LONGs, and the structure is
 * padded from 53 to 56 so that an array of them stays LONG-aligned.
 */
export const TEXTMETRICA = struct([...TEXTMETRIC_LONGS, ...textMetricCharacters('u8'),
    ...TEXTMETRIC_BYTES]).at(4);

/**
 * TEXTMETRICW: TEXTMETRICA's LONGs, then the four characters as WCHARs, so
 * everything after them sits four bytes further on and the whole is 60.
 */
const TEXTMETRICW = struct([...TEXTMETRIC_LONGS, ...textMetricCharacters('u16'),
    ...TEXTMETRIC_BYTES]).at(4);

/** POINT, which every *Ex function hands the previous value back through. */
export const POINT = POINT_LAYOUT.at(4);

/** SIZE, the same shape under different field names. */
export const SIZE = struct(all(['cx', 'cy'], 'i32')).at(4);

/** PALETTEENTRY: red, green, blue and a flags byte. */
const PALETTEENTRY = struct(/** @type {Declared[]} */ (['peRed', 'peGreen', 'peBlue',
    'peFlags'].map(name=>[name, 'u8'])));
export const PALETTEENTRY_SIZE = PALETTEENTRY.sizeOf(4);

/** LOGPALETTE. Two WORDs, then as many PALETTEENTRYs as the second one says. */
export const LOGPALETTE = struct([['palVersion', 'u16'], ['palNumEntries', 'u16'],
    ['palPalEntry', PALETTEENTRY, 1]]).at(4);

/**
 * A PALETTEENTRY read as a little-endian DWORD, as the drawing layer indexes it.
 *
 * The entry is red first in memory, so the DWORD is flags-blue-green-red; the
 * surface wants red on top, so the two ends swap. The flags byte is dropped:
 * PC_RESERVED entries still have a colour, and nothing here draws through the
 * dither or reserved flags.
 *
 * @param {number} entry  The PALETTEENTRY as one u32.
 * @returns {number} 0x00RRGGBB
 */
export function paletteEntryToPixel(entry){
    const value = wholeAddress(entry);
    return ((value & 0xff) << 16 | value & 0xff00 | (value >>> 16) & 0xff) >>> 0;
}

/** @typedef {import('../../../system/port.js').Port} StructMemory */

/**
 * @typedef {Object} LogPenFields
 * @property {number} style
 * @property {number} width
 * @property {number} color
 */

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @returns {LogPenFields}
 */
export function readLogPen(memory, address){
    return {
        style: memory.u32(address + LOGPEN.lopnStyle),
        width: memory.i32(address + LOGPEN.lopnWidth),
        color: memory.u32(address + LOGPEN.lopnColor),
    };
}

/**
 * @typedef {Object} LogBrushFields
 * @property {number} style
 * @property {number} color
 * @property {number} hatch
 */

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @returns {LogBrushFields}
 */
export function readLogBrush(memory, address){
    return {
        style: memory.u32(address + LOGBRUSH.lbStyle),
        color: memory.u32(address + LOGBRUSH.lbColor),
        hatch: memory.u32(address + LOGBRUSH.lbHatch),
    };
}

/**
 * @typedef {Object} LogFontFields
 * @property {number} height        Signed: see `cellHeightOf` for what the sign means.
 * @property {number} width
 * @property {number} escapement
 * @property {number} orientation
 * @property {number} weight
 * @property {number} italic
 * @property {number} underline
 * @property {number} strikeOut
 * @property {number} charSet
 * @property {number} outPrecision
 * @property {number} clipPrecision
 * @property {number} quality
 * @property {number} pitchAndFamily
 * @property {string} faceName
 * @property {import('./faces.js').RasterRealization} [raster]  How a bitmap face is
 *           realised, carried by a font as a DC draws with it.
 */

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @returns {LogFontFields}
 */
export function readLogFont(memory, address){
    // The face name is a fixed-width array, not a pointer: it is NUL-padded
    // rather than NUL-terminated, and a name that fills it has no terminator
    // at all.
    const fields = readLogFontFields(memory, address);
    const name = memory.view(address + LOGFONTA.lfFaceName, LF_FACESIZE);
    const end = name.indexOf(0);
    return { ...fields, faceName: decodeAnsi(name.subarray(0, end < 0 ? LF_FACESIZE : end)) };
}

/**
 * A LOGFONTW: the same fields, the face name in UTF-16.
 *
 * @param {StructMemory} memory
 * @param {number} address
 * @returns {LogFontFields}
 */
export function readLogFontW(memory, address){
    let faceName = '';
    for (let at = 0; at < LF_FACESIZE; at++)
    {
        const unit = memory.u16(address + LOGFONTA.lfFaceName + at * 2);
        if (unit === 0)
        {
            break;
        }
        faceName += String.fromCharCode(unit);
    }
    return { ...readLogFontFields(memory, address), faceName };
}

/**
 * A LOGFONT as the program's own structure holds it: LOGFONTA's face name in
 * bytes, LOGFONTW's in UTF-16, NUL-padded to the end of the field either way.
 *
 * @param {LogFontFields} font
 * @param {boolean} wide
 * @returns {Uint8Array}
 */
export function logFontBytes(font, wide){
    const bytes = new Uint8Array(wide ? LOGFONTW_SIZE : LOGFONTA.SIZE);
    const view = new DataView(bytes.buffer);
    [font.height, font.width, font.escapement, font.orientation, font.weight]
        .forEach((value, index)=>view.setInt32(LOGFONTA.lfHeight + index * 4, value | 0, true));
    [font.italic, font.underline, font.strikeOut, font.charSet, font.outPrecision,
        font.clipPrecision, font.quality, font.pitchAndFamily]
        .forEach((value, index)=>{
            bytes[LOGFONTA.lfItalic + index] = value & 0xff;
        });
    // The last unit of the field stays the terminator whatever the name's length.
    const name = font.faceName.slice(0, LF_FACESIZE - 1);
    if (!wide)
    {
        bytes.set(encodeAnsi(name), LOGFONTA.lfFaceName);
        return bytes;
    }
    for (let at = 0; at < name.length; at++)
    {
        view.setUint16(LOGFONTA.lfFaceName + at * 2, name.charCodeAt(at), true);
    }
    return bytes;
}

/**
 * Everything of a LOGFONT but its face name, which is where the A and W
 * layouts part.
 *
 * @param {StructMemory} memory
 * @param {number} address
 */
function readLogFontFields(memory, address){
    /** @param {number} at */
    const byte = at=>memory.u8(address + LOGFONTA.lfItalic + at);
    return {
        height: memory.i32(address + LOGFONTA.lfHeight),
        width: memory.i32(address + LOGFONTA.lfWidth),
        escapement: memory.i32(address + LOGFONTA.lfEscapement),
        orientation: memory.i32(address + LOGFONTA.lfOrientation),
        weight: memory.i32(address + LOGFONTA.lfWeight),
        italic: byte(0),
        underline: byte(1),
        strikeOut: byte(2),
        charSet: byte(3),
        outPrecision: byte(4),
        clipPrecision: byte(5),
        quality: byte(6),
        pitchAndFamily: byte(7),
    };
}

/**
 * @typedef {Object} BitmapInfoHeaderFields
 * @property {number} size
 * @property {number} width
 * @property {number} height      Negative for a top-down DIB.
 * @property {number} planes
 * @property {number} bitCount
 * @property {number} compression
 * @property {number} sizeImage
 * @property {number} clrUsed
 * @property {number} [xPelsPerMeter]
 * @property {number} [yPelsPerMeter]
 */

/**
 * Whether a DIB header's first DWORD names a header there is: a
 * BITMAPCOREHEADER's exact twelve, or forty or more, which is a
 * BITMAPINFOHEADER and whatever a later version appends (Wine's
 * test_bitmapinfoheadersize).
 *
 * @param {number} size
 */
export const isDibHeaderSize = size=>size === BITMAPCOREHEADER.SIZE
    || size >= BITMAPINFOHEADER.SIZE;

/**
 * The bytes of one colour table entry behind a header: a BITMAPCOREINFO's
 * are RGBTRIPLEs, every other's RGBQUADs.
 *
 * @param {BitmapInfoHeaderFields} header
 */
export const colorEntryBytes = header=>(header.size === BITMAPCOREHEADER.SIZE ? 3 : 4);

/**
 * A DIB's header, read as the BITMAPINFOHEADER fields whichever header it
 * is. A BITMAPCOREHEADER's sides are unsigned WORDs, so it is bottom-up; it
 * is always BI_RGB, and its table always full; `size` says it is one.
 *
 * @param {StructMemory} memory
 * @param {number} address
 * @returns {BitmapInfoHeaderFields}
 */
export function readBitmapInfoHeader(memory, address){
    if (memory.u32(address) === BITMAPCOREHEADER.SIZE)
    {
        return {
            size: BITMAPCOREHEADER.SIZE,
            width: memory.u16(address + BITMAPCOREHEADER.bcWidth),
            height: memory.u16(address + BITMAPCOREHEADER.bcHeight),
            planes: memory.u16(address + BITMAPCOREHEADER.bcPlanes),
            bitCount: memory.u16(address + BITMAPCOREHEADER.bcBitCount),
            compression: 0,
            sizeImage: 0,
            xPelsPerMeter: 0,
            yPelsPerMeter: 0,
            clrUsed: 0,
        };
    }
    return {
        size: memory.u32(address + BITMAPINFOHEADER.biSize),
        width: memory.i32(address + BITMAPINFOHEADER.biWidth),
        height: memory.i32(address + BITMAPINFOHEADER.biHeight),
        planes: memory.u16(address + BITMAPINFOHEADER.biPlanes),
        bitCount: memory.u16(address + BITMAPINFOHEADER.biBitCount),
        compression: memory.u32(address + BITMAPINFOHEADER.biCompression),
        sizeImage: memory.u32(address + BITMAPINFOHEADER.biSizeImage),
        xPelsPerMeter: memory.i32(address + BITMAPINFOHEADER.biXPelsPerMeter),
        yPelsPerMeter: memory.i32(address + BITMAPINFOHEADER.biYPelsPerMeter),
        clrUsed: memory.u32(address + BITMAPINFOHEADER.biClrUsed),
    };
}

/**
 * Reads a LOGPALETTE and the entries that follow it inline.
 *
 * @param {StructMemory} memory
 * @param {number} address
 * @returns {{ version: number, entries: number[] }}
 */
export function readLogPalette(memory, address){
    const count = memory.u16(address + LOGPALETTE.palNumEntries);
    /** @type {number[]} */
    const entries = [];
    for (let index = 0; index < count; index++)
    {
        entries.push(memory.u32(address + LOGPALETTE.palPalEntry
            + (index * PALETTEENTRY_SIZE)));
    }
    return { version: memory.u16(address + LOGPALETTE.palVersion), entries };
}

/**
 * @typedef {Object} TextMetricFields
 * @property {number} height
 * @property {number} ascent
 * @property {number} descent
 * @property {number} internalLeading
 * @property {number} externalLeading
 * @property {number} aveCharWidth
 * @property {number} maxCharWidth
 * @property {number} weight
 * @property {number} digitizedAspectX
 * @property {number} digitizedAspectY
 * @property {number} firstChar
 * @property {number} lastChar
 * @property {number} defaultChar
 * @property {number} breakChar
 * @property {number} italic
 * @property {number} underlined
 * @property {number} struckOut
 * @property {number} pitchAndFamily
 * @property {number} charSet
 */

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @param {TextMetricFields} metrics
 */
export function writeTextMetrics(memory, address, metrics){
    writeTextMetricsAs(memory, address, metrics, false);
}

/**
 * A TEXTMETRICW: the same measures, the four characters as WCHARs.
 *
 * @param {StructMemory} memory
 * @param {number} address
 * @param {TextMetricFields} metrics
 */
export function writeTextMetricsW(memory, address, metrics){
    writeTextMetricsAs(memory, address, metrics, true);
}

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @param {TextMetricFields} metrics
 * @param {boolean} wide
 */
function writeTextMetricsAs(memory, address, metrics, wide){
    const bytes = new Uint8Array(wide ? TEXTMETRICW.SIZE : TEXTMETRICA.SIZE);
    const view = new DataView(bytes.buffer);
    /** @param {number} offset @param {number} value */
    const long = (offset, value)=>view.setInt32(offset, value | 0, true);
    long(TEXTMETRICA.tmHeight, metrics.height);
    long(TEXTMETRICA.tmAscent, metrics.ascent);
    long(TEXTMETRICA.tmDescent, metrics.descent);
    long(TEXTMETRICA.tmInternalLeading, metrics.internalLeading);
    long(TEXTMETRICA.tmExternalLeading, metrics.externalLeading);
    long(TEXTMETRICA.tmAveCharWidth, metrics.aveCharWidth);
    long(TEXTMETRICA.tmMaxCharWidth, metrics.maxCharWidth);
    long(TEXTMETRICA.tmWeight, metrics.weight);
    long(TEXTMETRICA.tmOverhang, 0);
    long(TEXTMETRICA.tmDigitizedAspectX, metrics.digitizedAspectX);
    long(TEXTMETRICA.tmDigitizedAspectY, metrics.digitizedAspectY);
    const layout = wide ? TEXTMETRICW : TEXTMETRICA;
    /** @param {number} offset @param {number} value */
    const character = (offset, value)=>(wide
        ? view.setUint16(offset, value & 0xffff, true)
        : view.setUint8(offset, value & 0xff));
    character(layout.tmFirstChar, metrics.firstChar);
    character(layout.tmLastChar, metrics.lastChar);
    character(layout.tmDefaultChar, metrics.defaultChar);
    character(layout.tmBreakChar, metrics.breakChar);
    bytes[layout.tmItalic] = metrics.italic & 0xff;
    bytes[layout.tmUnderlined] = metrics.underlined & 0xff;
    bytes[layout.tmStruckOut] = metrics.struckOut & 0xff;
    bytes[layout.tmPitchAndFamily] = metrics.pitchAndFamily & 0xff;
    bytes[layout.tmCharSet] = metrics.charSet & 0xff;
    memory.setBytes(address, bytes);
}

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @param {{ x: number, y: number }} point
 */
export function writePoint(memory, address, point){
    memory.set32s(address, [point.x, point.y]);
}

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @param {{ cx: number, cy: number }} size
 */
export function writeSize(memory, address, size){
    memory.set32s(address, [size.cx, size.cy]);
}
