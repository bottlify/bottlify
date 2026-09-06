/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The gdi32 structures, laid out the way the guest compiled them.
 *
 * Unlike the user32 ones, these are not uniform runs of DWORDs: a LOGFONTA ends
 * in eight bytes and a fixed character array, a BITMAPINFOHEADER has two WORDs
 * in the middle, and a TEXTMETRIC is eleven LONGs followed by nine bytes and
 * three bytes of tail padding. So the offsets below are the real ones, not a
 * field index times four, and they are written out because an offset is part of
 * the ABI: a field read from the wrong place is a plausible-looking value rather
 * than an error.
 *
 * Reading and writing them lives here too, so that the offsets and the code that
 * uses them cannot drift apart.
 */

/** LOGPEN. Its width is a POINT, of which only the x is ever meaningful. */
export const LOGPEN = Object.freeze({
    lopnStyle: 0,
    lopnWidthX: 4,
    lopnWidthY: 8,
    lopnColor: 12,
    SIZE: 16,
});

/** LOGBRUSH. lbHatch is a hatch index for BS_HATCHED and a bitmap for BS_PATTERN. */
export const LOGBRUSH = Object.freeze({
    lbStyle: 0,
    lbColor: 4,
    lbHatch: 8,
    SIZE: 12,
});

/** The face name field of a LOGFONT is this many bytes, terminator included. */
export const LF_FACESIZE = 32;

/**
 * LOGFONTA. The five LONGs are followed by eight single bytes -- no padding
 * between them, since a byte needs none -- and then the face name.
 */
export const LOGFONTA = Object.freeze({
    lfHeight: 0,
    lfWidth: 4,
    lfEscapement: 8,
    lfOrientation: 12,
    lfWeight: 16,
    lfItalic: 20,
    lfUnderline: 21,
    lfStrikeOut: 22,
    lfCharSet: 23,
    lfOutPrecision: 24,
    lfClipPrecision: 25,
    lfQuality: 26,
    lfPitchAndFamily: 27,
    lfFaceName: 28,
    SIZE: 60,
});

/** BITMAPINFOHEADER. biPlanes and biBitCount are WORDs; everything else is 32 bits. */
export const BITMAPINFOHEADER = Object.freeze({
    biSize: 0,
    biWidth: 4,
    biHeight: 8,
    biPlanes: 12,
    biBitCount: 14,
    biCompression: 16,
    biSizeImage: 20,
    biXPelsPerMeter: 24,
    biYPelsPerMeter: 28,
    biClrUsed: 32,
    biClrImportant: 36,
    SIZE: 40,
});

/**
 * TEXTMETRICA. Nine bytes sit past the eleven LONGs, and the structure is
 * padded from 53 to 56 so that an array of them stays LONG-aligned.
 */
export const TEXTMETRICA = Object.freeze({
    tmHeight: 0,
    tmAscent: 4,
    tmDescent: 8,
    tmInternalLeading: 12,
    tmExternalLeading: 16,
    tmAveCharWidth: 20,
    tmMaxCharWidth: 24,
    tmWeight: 28,
    tmOverhang: 32,
    tmDigitizedAspectX: 36,
    tmDigitizedAspectY: 40,
    tmFirstChar: 44,
    tmLastChar: 45,
    tmDefaultChar: 46,
    tmBreakChar: 47,
    tmItalic: 48,
    tmUnderlined: 49,
    tmStruckOut: 50,
    tmPitchAndFamily: 51,
    tmCharSet: 52,
    SIZE: 56,
});

/** POINT, which every *Ex function hands the previous value back through. */
export const POINT = Object.freeze({ x: 0, y: 4, SIZE: 8 });

/** SIZE, the same shape under different field names. */
export const SIZE = Object.freeze({ cx: 0, cy: 4, SIZE: 8 });

/** LOGPALETTE. Two WORDs, then as many PALETTEENTRYs as the second one says. */
export const LOGPALETTE = Object.freeze({
    palVersion: 0,
    palNumEntries: 2,
    palPalEntry: 4,
});

/** PALETTEENTRY: red, green, blue and a flags byte. */
export const PALETTEENTRY_SIZE = 4;

/**
 * @typedef {Object} StructMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @returns {number} the WORD at that address, unsigned
 */
export function readU16(memory, address){
    const bytes = memory.readMemory(address, 2);
    return (bytes[0] | (bytes[1] << 8)) & 0xffff;
}

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @returns {number} the DWORD at that address, unsigned
 */
export function readU32(memory, address){
    const bytes = memory.readMemory(address, 4);
    return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
}

/**
 * The same DWORD read as a LONG. Half the fields here are signed -- a negative
 * lfHeight and a negative biHeight both mean something specific -- and reading
 * one unsigned turns it into four billion.
 *
 * @param {StructMemory} memory
 * @param {number} address
 */
export function readI32(memory, address){
    return readU32(memory, address) | 0;
}

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @param {number[]} values
 */
export function writeU32s(memory, address, values){
    const bytes = new Uint8Array(values.length * 4);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < values.length; index++)
    {
        view.setUint32(index * 4, values[index] >>> 0, true);
    }
    memory.writeMemory(address, bytes);
}

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
        style: readU32(memory, address + LOGPEN.lopnStyle),
        width: readI32(memory, address + LOGPEN.lopnWidthX),
        color: readU32(memory, address + LOGPEN.lopnColor),
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
        style: readU32(memory, address + LOGBRUSH.lbStyle),
        color: readU32(memory, address + LOGBRUSH.lbColor),
        hatch: readU32(memory, address + LOGBRUSH.lbHatch),
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
 */

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @returns {LogFontFields}
 */
export function readLogFont(memory, address){
    const bytes = memory.readMemory(address + LOGFONTA.lfItalic, 8);
    // The face name is a fixed-width array, not a pointer: it is NUL-padded
    // rather than NUL-terminated, and a name that fills it has no terminator
    // at all.
    const name = memory.readMemory(address + LOGFONTA.lfFaceName, LF_FACESIZE);
    let end = 0;
    while (end < LF_FACESIZE && name[end] !== 0)
    {
        end++;
    }
    return {
        height: readI32(memory, address + LOGFONTA.lfHeight),
        width: readI32(memory, address + LOGFONTA.lfWidth),
        escapement: readI32(memory, address + LOGFONTA.lfEscapement),
        orientation: readI32(memory, address + LOGFONTA.lfOrientation),
        weight: readI32(memory, address + LOGFONTA.lfWeight),
        italic: bytes[0],
        underline: bytes[1],
        strikeOut: bytes[2],
        charSet: bytes[3],
        outPrecision: bytes[4],
        clipPrecision: bytes[5],
        quality: bytes[6],
        pitchAndFamily: bytes[7],
        faceName: new TextDecoder('latin1').decode(name.subarray(0, end)),
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
 */

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @returns {BitmapInfoHeaderFields}
 */
export function readBitmapInfoHeader(memory, address){
    return {
        size: readU32(memory, address + BITMAPINFOHEADER.biSize),
        width: readI32(memory, address + BITMAPINFOHEADER.biWidth),
        height: readI32(memory, address + BITMAPINFOHEADER.biHeight),
        planes: readU16(memory, address + BITMAPINFOHEADER.biPlanes),
        bitCount: readU16(memory, address + BITMAPINFOHEADER.biBitCount),
        compression: readU32(memory, address + BITMAPINFOHEADER.biCompression),
        sizeImage: readU32(memory, address + BITMAPINFOHEADER.biSizeImage),
        clrUsed: readU32(memory, address + BITMAPINFOHEADER.biClrUsed),
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
    const count = readU16(memory, address + LOGPALETTE.palNumEntries);
    /** @type {number[]} */
    const entries = [];
    for (let index = 0; index < count; index++)
    {
        entries.push(readU32(memory, address + LOGPALETTE.palPalEntry
            + (index * PALETTEENTRY_SIZE)));
    }
    return { version: readU16(memory, address + LOGPALETTE.palVersion), entries };
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
    const bytes = new Uint8Array(TEXTMETRICA.SIZE);
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
    bytes[TEXTMETRICA.tmFirstChar] = metrics.firstChar & 0xff;
    bytes[TEXTMETRICA.tmLastChar] = metrics.lastChar & 0xff;
    bytes[TEXTMETRICA.tmDefaultChar] = metrics.defaultChar & 0xff;
    bytes[TEXTMETRICA.tmBreakChar] = metrics.breakChar & 0xff;
    bytes[TEXTMETRICA.tmItalic] = metrics.italic & 0xff;
    bytes[TEXTMETRICA.tmUnderlined] = metrics.underlined & 0xff;
    bytes[TEXTMETRICA.tmStruckOut] = metrics.struckOut & 0xff;
    bytes[TEXTMETRICA.tmPitchAndFamily] = metrics.pitchAndFamily & 0xff;
    bytes[TEXTMETRICA.tmCharSet] = metrics.charSet & 0xff;
    memory.writeMemory(address, bytes);
}

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @param {{ x: number, y: number }} point
 */
export function writePoint(memory, address, point){
    writeU32s(memory, address, [point.x, point.y]);
}

/**
 * @param {StructMemory} memory
 * @param {number} address
 * @param {{ cx: number, cy: number }} size
 */
export function writeSize(memory, address, size){
    writeU32s(memory, address, [size.cx, size.cy]);
}
