/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The video codecs Windows installs with itself, as installable compressors
 * the manager (`icm.js`) opens: msrle32 (FOURCC mrle: BI_RLE8 and BI_RLE4 in,
 * BI_RLE8 out), msvidc32 (msvc: Microsoft Video 1) and iccvid (cvid: Cinepak).
 * A game's 1990s cut-scene is one of these three, played by its own code
 * through ICDecompress or DrawDibDraw, or by the system's AVI player.
 *
 * Each answers the ICM messages a codec documents (vfw.h): the queries say
 * which formats it takes and gives, GET_FORMAT fills the output header,
 * DECOMPRESS and COMPRESS do the frame. A message one does not know is
 * ICERR_UNSUPPORTED, as a driver's default answer is.
 */

import { decodeRle, encodeRle8 } from './rle.js';
import { decodeVideo1 } from './video1.js';
import { decodeCinepak, newCinepakState } from './cinepak.js';
import { wholeAddress } from '../common/pointers.js';

export const ICERR_OK = 0;
export const ICERR_UNSUPPORTED = -1;
export const ICERR_BADFORMAT = -2;
export const ICERR_BADPARAM = -6;
export const ICERR_BADHANDLE = -8;

export const ICM_GETINFO = 0x5002;
export const ICM_COMPRESS_GET_FORMAT = 0x4004;
export const ICM_COMPRESS_GET_SIZE = 0x4005;
export const ICM_COMPRESS_QUERY = 0x4006;
export const ICM_COMPRESS_BEGIN = 0x4007;
export const ICM_COMPRESS = 0x4008;
export const ICM_COMPRESS_END = 0x4009;
export const ICM_DECOMPRESS_GET_FORMAT = 0x400a;
export const ICM_DECOMPRESS_QUERY = 0x400b;
export const ICM_DECOMPRESS_BEGIN = 0x400c;
export const ICM_DECOMPRESS = 0x400d;
export const ICM_DECOMPRESS_END = 0x400e;
export const ICM_DECOMPRESS_GET_PALETTE = 0x401e;
export const ICM_DECOMPRESSEX_BEGIN = 0x403c;
export const ICM_DECOMPRESSEX_QUERY = 0x403d;
export const ICM_DECOMPRESSEX = 0x403e;
export const ICM_DECOMPRESSEX_END = 0x403f;
export const ICM_GETDEFAULTQUALITY = 0x501e;
export const ICM_GETDEFAULTKEYFRAMERATE = 0x402a;

export const BI_RGB = 0;
export const BI_RLE8 = 1;
export const BI_RLE4 = 2;
export const BI_BITFIELDS = 3;

/** ICCOMPRESS_KEYFRAME: the frame is to be a key frame. */
const ICCOMPRESS_KEYFRAME = 1;
/** AVIIF_KEYFRAME: what a compressor says of a key frame it wrote. */
const AVIIF_KEYFRAME = 0x10;
/** ICVERSION, the manager's version an ICINFO carries. */
export const ICVERSION = 0x0104;
/** sizeof(BITMAPINFOHEADER). */
export const HEADER_SIZE = 40;
/** sizeof(ICINFO). */
export const ICINFO_SIZE = 568;
/** What a codec's ICINFO.dwFlags says it does (vfw.h VIDCF_*). */
const VIDCF_QUALITY = 0x01;
const VIDCF_CRUNCH = 0x02;
const VIDCF_TEMPORAL = 0x04;
const VIDCF_COMPRESSFRAMES = 0x08;
const VIDCF_FASTTEMPORALC = 0x20;

/** @param {string} text */
export const fourcc = text=>(text.charCodeAt(0) | text.charCodeAt(1) << 8
    | text.charCodeAt(2) << 16 | text.charCodeAt(3) << 24) >>> 0;

/**
 * @typedef {Object} Header  a BITMAPINFOHEADER as read
 * @property {number} at  where it is
 * @property {number} size @property {number} width @property {number} height
 * @property {number} planes @property {number} bitCount @property {number} compression
 * @property {number} sizeImage @property {number} clrUsed
 */

/**
 * @typedef {Object} CodecMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/** The bytes a row of `width` pixels takes at `depth`, a whole number of DWORDs. */
export const strideOf = (/** @type {number} */ width, /** @type {number} */ depth)=>
    ((width * depth + 31) >>> 5) * 4;

/**
 * @param {CodecMemory} memory @param {number} at
 * @returns {Header | null}
 */
export function readHeader(memory, at){
    if ((at >>> 0) === 0)
    {
        return null;
    }
    const view = new DataView(memory.readMemory(wholeAddress(at), HEADER_SIZE).slice().buffer);
    return {
        at: at >>> 0,
        size: view.getUint32(0, true),
        width: view.getInt32(4, true),
        height: view.getInt32(8, true),
        planes: view.getUint16(12, true),
        bitCount: view.getUint16(14, true),
        compression: view.getUint32(16, true),
        sizeImage: view.getUint32(20, true),
        clrUsed: view.getUint32(32, true),
    };
}

/** The colours a header's table holds: biClrUsed, or all a depth of eight or less has. */
export const coloursOf = (/** @type {Header} */ header)=>(header.bitCount <= 8
    ? header.clrUsed || 1 << header.bitCount : header.clrUsed);

/**
 * The colour table after a header, as RGBQUADs.
 *
 * @param {CodecMemory} memory @param {Header} header
 */
function paletteOf(memory, header){
    const count = Math.min(coloursOf(header), 256);
    return memory.readMemory(header.at + (header.size || HEADER_SIZE), count * 4).slice();
}

/**
 * Writes `out` as `header` with what differs replaced: the codec's output
 * format, its colour table after it.
 *
 * @param {CodecMemory} memory @param {number} at @param {Header} like
 * @param {{ width?: number, height?: number, bitCount?: number, compression?: number,
 *     sizeImage?: number }} change
 * @param {Uint8Array} [palette]
 */
function writeHeader(memory, at, like, change, palette){
    const bytes = new Uint8Array(HEADER_SIZE);
    const view = new DataView(bytes.buffer);
    const width = change.width ?? like.width;
    const height = change.height ?? like.height;
    const bitCount = change.bitCount ?? like.bitCount;
    view.setUint32(0, HEADER_SIZE, true);
    view.setInt32(4, width, true);
    view.setInt32(8, height, true);
    view.setUint16(12, 1, true);
    view.setUint16(14, bitCount, true);
    view.setUint32(16, change.compression ?? BI_RGB, true);
    view.setUint32(20, change.sizeImage ?? strideOf(width, bitCount) * Math.abs(height), true);
    view.setUint32(32, palette ? palette.length / 4 : 0, true);
    memory.writeMemory(wholeAddress(at), bytes);
    if (palette)
    {
        memory.writeMemory(wholeAddress(at) + HEADER_SIZE, palette);
    }
}

/**
 * Writes decoded pixels into a BI_RGB (or 5-6-5 BI_BITFIELDS) output at its
 * depth: `colour(i)` gives pixel i (bottom row first) as 0xRRGGBB, `index(i)`
 * its palette index for an 8-bit output. A negative output height is a
 * top-down picture. `left` and `bottom` place the frame inside a larger
 * output, as ICDecompressEx does; only the frame's own rectangle is written.
 *
 * @param {CodecMemory} memory @param {Header} out @param {number} bits
 * @param {number} width @param {number} height
 * @param {(i: number) => number} colour @param {(i: number) => number} index
 * @param {number} [left] @param {number} [bottom]
 */
function writePixels(memory, out, bits, width, height, colour, index, left = 0, bottom = 0){
    const depth = out.bitCount;
    const bytes = depth >> 3;
    const stride = strideOf(Math.abs(out.width), depth);
    const rows = Math.min(height, Math.abs(out.height) - bottom);
    const columns = Math.min(width, Math.abs(out.width) - left);
    const fiveSix = out.compression === BI_BITFIELDS;
    const row = new Uint8Array(columns * bytes);
    for (let y = 0; y < rows; y++)
    {
        const line = bottom + y;
        const at = (out.height < 0 ? Math.abs(out.height) - 1 - line : line) * stride +
            left * bytes;
        for (let x = 0; x < columns; x++)
        {
            const i = y * width + x;
            if (depth === 8)
            {
                row[x] = index(i);
                continue;
            }
            const rgb = colour(i);
            if (depth === 16)
            {
                const word = fiveSix
                    ? (rgb >> 19 & 31) << 11 | (rgb >> 10 & 63) << 5 | (rgb >> 3 & 31)
                    : (rgb >> 19 & 31) << 10 | (rgb >> 11 & 31) << 5 | (rgb >> 3 & 31);
                row[x * 2] = word & 255;
                row[x * 2 + 1] = word >> 8;
                continue;
            }
            row[x * bytes] = rgb & 255;
            row[x * bytes + 1] = rgb >> 8 & 255;
            row[x * bytes + 2] = rgb >> 16 & 255;
        }
        memory.writeMemory(wholeAddress(bits) + at, row);
    }
}

/** RGB555 as 0xRRGGBB, each channel's bits repeated into the low ones. */
const fromRgb555 = (/** @type {number} */ word)=>{
    const r = word >> 10 & 31;
    const g = word >> 5 & 31;
    const b = word & 31;
    return (r << 3 | r >> 2) << 16 | (g << 3 | g >> 2) << 8 | (b << 3 | b >> 2);
};

/** An RGBQUAD table's entry i as 0xRRGGBB. */
const fromPalette = (/** @type {Uint8Array} */ palette, /** @type {number} */ i)=>
    (palette[i * 4 + 2] ?? 0) << 16 | (palette[i * 4 + 1] ?? 0) << 8 | (palette[i * 4] ?? 0);

/**
 * @typedef {Object} Codec
 * @property {number} handler  its FOURCC, as a stream names it
 * @property {string} driver  the file Windows has it in
 * @property {string} name @property {string} description
 * @property {number} flags  ICINFO.dwFlags
 * @property {number} [version]  ICINFO.dwVersion
 * @property {(memory: CodecMemory) => (message: number, first: number, second: number) => number}
 *     open
 *     a codec instance answering messages
 */

/**
 * The ICINFO a built-in codec gives for ICM_GETINFO.
 *
 * @param {Codec} codec
 */
export function infoOf(codec){
    const bytes = new Uint8Array(ICINFO_SIZE);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, ICINFO_SIZE, true);
    view.setUint32(4, fourcc('vidc'), true);
    view.setUint32(8, codec.handler, true);
    view.setUint32(12, codec.flags, true);
    view.setUint32(16, codec.version ?? 0, true);
    view.setUint32(20, ICVERSION, true);
    /** @param {string} text @param {number} at @param {number} room */
    const put = (text, at, room)=>{
        for (let i = 0; i < Math.min(text.length, room - 1); i++)
        {
            view.setUint16(at + i * 2, text.charCodeAt(i), true);
        }
    };
    put(codec.name, 24, 16);
    put(codec.description, 56, 128);
    put(codec.driver, 312, 128);
    return bytes;
}

/** ICDECOMPRESS: dwFlags, lpbiInput, lpInput, lpbiOutput, lpOutput, ckid. */
const readDecompress = (/** @type {CodecMemory} */ memory, /** @type {number} */ at)=>{
    const view = new DataView(memory.readMemory(wholeAddress(at), 20).slice().buffer);
    return { flags: view.getUint32(0, true), inHeader: view.getUint32(4, true),
        input: view.getUint32(8, true), outHeader: view.getUint32(12, true),
        output: view.getUint32(16, true) };
};

/**
 * ICDECOMPRESSEX: dwFlags, lpbiSrc, lpSrc, lpbiDst, lpDst, then the destination
 * rectangle and the source's, each x, y, dx, dy.
 */
const readDecompressEx = (/** @type {CodecMemory} */ memory, /** @type {number} */ at)=>{
    const view = new DataView(memory.readMemory(wholeAddress(at), 52).slice().buffer);
    const int = (/** @type {number} */ i)=>view.getInt32(i, true);
    return { flags: view.getUint32(0, true), inHeader: view.getUint32(4, true),
        input: view.getUint32(8, true), outHeader: view.getUint32(12, true),
        output: view.getUint32(16, true),
        xDst: int(20), yDst: int(24), dxDst: int(28), dyDst: int(32),
        xSrc: int(36), ySrc: int(40), dxSrc: int(44), dySrc: int(48) };
};

/**
 * The decompressing half every codec here shares: a query and GET_FORMAT
 * decided by `accepts` and `formatOf`, DECOMPRESS by `decode`.
 *
 * @param {CodecMemory} memory
 * @param {{ accepts: (input: Header) => boolean, formatPalette?: boolean,
 *     outputs: (input: Header, output: Header) => boolean,
 *     formatOf: (input: Header) => { width: number, height: number, bitCount: number } | null,
 *     decode: (input: Header, data: Uint8Array, palette: Uint8Array, output: Header,
 *         bits: number, left: number, bottom: number) => void }} codec
 * @param {(message: number, first: number, second: number) => number} [rest]  other messages
 */
function decompressor(memory, codec, rest = ()=>ICERR_UNSUPPORTED){
    /** @param {number} message @param {number} first @param {number} second */
    return (message, first, second)=>{
        const input = [ICM_DECOMPRESS, ICM_DECOMPRESSEX_QUERY, ICM_DECOMPRESSEX_BEGIN,
            ICM_DECOMPRESSEX,
            ICM_DECOMPRESSEX_END].includes(message) ? null : readHeader(memory, first);
        switch (message)
        {
            case ICM_DECOMPRESS_QUERY:
            case ICM_DECOMPRESS_BEGIN:
            {
                if (!input || !codec.accepts(input))
                {
                    return ICERR_BADFORMAT;
                }
                const output = readHeader(memory, second);
                return !output || codec.outputs(input, output) ? ICERR_OK : ICERR_BADFORMAT;
            }
            case ICM_DECOMPRESS_GET_FORMAT:
            {
                if (!input || !codec.accepts(input))
                {
                    return ICERR_BADFORMAT;
                }
                const format = codec.formatOf(input);
                if (!format)
                {
                    return ICERR_BADFORMAT;
                }
                // A colour table only where the codec gives one with its format: a
                // program may hand a header alone, as for Video 1's 8-bit output.
                const palette = codec.formatPalette && format.bitCount <= 8
                    ? paletteOf(memory, input) : undefined;
                if ((second >>> 0) === 0)
                {
                    return HEADER_SIZE + (palette?.length ?? 0);
                }
                writeHeader(memory, second, input, format, palette);
                return ICERR_OK;
            }
            case ICM_DECOMPRESS_GET_PALETTE:
            {
                if (!input || !codec.accepts(input))
                {
                    return ICERR_BADFORMAT;
                }
                const palette = paletteOf(memory, input);
                if ((second >>> 0) === 0)
                {
                    return HEADER_SIZE + palette.length;
                }
                memory.writeMemory(wholeAddress(second) + HEADER_SIZE, palette);
                return ICERR_OK;
            }
            case ICM_DECOMPRESS:
            {
                const call = readDecompress(memory, first);
                const from = readHeader(memory, call.inHeader);
                const to = readHeader(memory, call.outHeader);
                if (!from || !to || !codec.accepts(from) || !codec.outputs(from, to))
                {
                    return ICERR_BADFORMAT;
                }
                const length = from.sizeImage || strideOf(from.width,
                    from.bitCount) * Math.abs(from.height);
                codec.decode(from, memory.readMemory(wholeAddress(call.input), length).slice(),
                    paletteOf(memory, from), to, call.output, 0, 0);
                return ICERR_OK;
            }
            case ICM_DECOMPRESSEX_QUERY:
            case ICM_DECOMPRESSEX_BEGIN:
            case ICM_DECOMPRESSEX:
            {
                const call = readDecompressEx(memory, first);
                const from = readHeader(memory, call.inHeader);
                if (!from || !codec.accepts(from))
                {
                    return ICERR_BADFORMAT;
                }
                // The whole source frame, or nothing: a codec decodes frames, not parts.
                if (call.xSrc !== 0 || call.ySrc !== 0 || call.dxSrc !== from.width
                    || call.dySrc !== Math.abs(from.height))
                {
                    return ICERR_BADPARAM;
                }
                const to = readHeader(memory, call.outHeader);
                if (!to)
                {
                    return message === ICM_DECOMPRESSEX ? ICERR_BADFORMAT : ICERR_OK;
                }
                // The output's format as the codec takes it, the frame placed
                // unstretched inside it.
                const asFrame = { ...to, width: from.width, height: Math.sign(to.height
                    || 1) * Math.abs(from.height) };
                if (!codec.outputs(from, asFrame) || call.dxDst !== call.dxSrc
                    || call.dyDst !== call.dySrc
                    || call.xDst < 0 || call.yDst < 0 || call.xDst + call.dxDst > Math.abs(to.width)
                    || call.yDst + call.dyDst > Math.abs(to.height))
                {
                    return ICERR_BADFORMAT;
                }
                if (message === ICM_DECOMPRESSEX)
                {
                    const length = from.sizeImage || strideOf(from.width,
                        from.bitCount) * Math.abs(from.height);
                    // The rectangle's top-left corner, in rows from the picture's bottom.
                    codec.decode(from, memory.readMemory(wholeAddress(call.input), length).slice(),
                        paletteOf(memory, from), to, call.output, call.xDst,
                        Math.abs(to.height) - call.yDst - call.dyDst);
                }
                return ICERR_OK;
            }
            case ICM_DECOMPRESSEX_END:
                return ICERR_OK;
            case ICM_DECOMPRESS_END:
                return ICERR_OK;
            default:
                return rest(message, first, second);
        }
    };
}

/** An output BI_RGB of the input's size; heights must agree in size, as the codecs require. */
const sameSize = (/** @type {Header} */ input, /** @type {Header} */ output, negative = true)=>
    output.compression === BI_RGB && output.width === input.width
        && (output.height === input.height || (negative && output.height === -input.height));

/** msrle32: run-length pictures in, BI_RGB out; 8-bit BI_RGB in, BI_RLE8 out. */
const msrle = /** @type {Codec} */ ({
    handler: fourcc('mrle'),
    driver: 'msrle32.dll',
    name: 'MS-RLE',
    description: 'Microsoft RLE',
    flags: VIDCF_TEMPORAL | VIDCF_QUALITY,
    open: memory=>{
        /** @type {Uint8Array | null} */
        let indices = null;
        /** @type {Uint8Array | null} */
        let previous = null;
        /** @param {Header} header */
        const rgbIn = header=>header.compression === BI_RGB
            && (header.bitCount === 4 || header.bitCount === 8);
        const decompress = decompressor(memory, {
            formatPalette: true,
            accepts: input=>(input.compression === BI_RLE8 && input.bitCount === 8)
                || (input.compression === BI_RLE4 && input.bitCount === 4) || rgbIn(input),
            // A bottom-up picture only: the run-length rows are bottom first.
            outputs: (input, output)=>sameSize(input, output, false)
                && [input.bitCount, 8, 16, 24, 32].includes(output.bitCount),
            formatOf: input=>({ width: input.width, height: input.height,
                bitCount: input.bitCount }),
            decode: (input, data, palette, output, bits, left, bottom)=>{
                const { width, height } = input;
                if (rgbIn(input))
                {
                    const stride = strideOf(width, input.bitCount);
                    indices = new Uint8Array(width * height);
                    for (let y = 0; y < height; y++)
                    {
                        for (let x = 0; x < width; x++)
                        {
                            const byte = data[y * stride + (input.bitCount === 8 ? x
                                : x >> 1)] ?? 0;
                            indices[y * width + x] = input.bitCount === 8 ? byte
                                : (x & 1) === 0 ? byte >> 4 : byte & 15;
                        }
                    }
                }
                else
                {
                    if (!indices || indices.length !== width * height)
                    {
                        indices = new Uint8Array(width * height);
                    }
                    decodeRle(data, width, height, input.compression === BI_RLE8 ? 8 : 4, indices);
                }
                const frame = indices;
                if (output.bitCount === 4)
                {
                    const stride = strideOf(width, 4);
                    const image = new Uint8Array(stride * height);
                    frame.forEach((index, i)=>{
                        const at = Math.floor(i / width) * stride + ((i % width) >> 1);
                        image[at] |= (i % width) % 2 === 0 ? index << 4 : index;
                    });
                    memory.writeMemory(wholeAddress(bits), image);
                    return;
                }
                writePixels(memory, output, bits, width, height,
                    i=>fromPalette(palette, frame[i]), i=>frame[i], left, bottom);
            },
        });
        return (message, first, second)=>{
            switch (message)
            {
                case ICM_COMPRESS_QUERY:
                {
                    const input = readHeader(memory, first);
                    if (!input || input.compression !== BI_RGB || input.bitCount !== 8)
                    {
                        return ICERR_BADFORMAT;
                    }
                    const output = readHeader(memory, second);
                    return !output || (output.compression === BI_RLE8 && output.bitCount === 8
                        && output.width === input.width && output.height === input.height)
                        ? ICERR_OK : ICERR_BADFORMAT;
                }
                case ICM_COMPRESS_GET_FORMAT:
                {
                    const input = readHeader(memory, first);
                    if (!input || input.compression !== BI_RGB || input.bitCount !== 8)
                    {
                        return ICERR_BADFORMAT;
                    }
                    const palette = paletteOf(memory, input);
                    if ((second >>> 0) === 0)
                    {
                        return HEADER_SIZE + palette.length;
                    }
                    writeHeader(memory, second, input, { compression: BI_RLE8,
                        sizeImage: worstRle8(input.width, input.height) }, palette);
                    return ICERR_OK;
                }
                case ICM_COMPRESS_GET_SIZE:
                {
                    const input = readHeader(memory, first);
                    return input ? worstRle8(input.width, Math.abs(input.height)) : ICERR_BADFORMAT;
                }
                case ICM_COMPRESS_BEGIN:
                    previous = null;
                    return msrleCompressQuery(memory, first, second);
                case ICM_COMPRESS_END:
                    previous = null;
                    return ICERR_OK;
                case ICM_COMPRESS:
                {
                    const view = new DataView(memory.readMemory(wholeAddress(first),
                        48).slice().buffer);
                    const flags = view.getUint32(0, true);
                    const outHeader = view.getUint32(4, true);
                    const output = view.getUint32(8, true);
                    const input = readHeader(memory, view.getUint32(12, true));
                    const flagsOut = view.getUint32(24, true);
                    if (!input || input.compression !== BI_RGB || input.bitCount !== 8)
                    {
                        return ICERR_BADFORMAT;
                    }
                    const stride = strideOf(input.width, 8);
                    const bits = memory.readMemory(view.getUint32(16, true),
                        stride * Math.abs(input.height)).slice();
                    const key = (flags & ICCOMPRESS_KEYFRAME) !== 0 || previous === null;
                    const encoded = encodeRle8(bits, input.width, Math.abs(input.height), stride,
                        key ? null : previous);
                    previous = bits;
                    memory.writeMemory(output, encoded);
                    const size = new Uint8Array(4);
                    new DataView(size.buffer).setUint32(0, encoded.length, true);
                    memory.writeMemory(wholeAddress(outHeader) + 20, size);
                    if (flagsOut !== 0)
                    {
                        new DataView(size.buffer).setUint32(0, key ? AVIIF_KEYFRAME : 0, true);
                        memory.writeMemory(flagsOut, size);
                    }
                    return ICERR_OK;
                }
                default:
                    return decompress(message, first, second);
            }
        };
    },
});

/** The most an 8-bit run-length frame can take: every pixel a run of one, and the escapes. */
const worstRle8 = (/** @type {number} */ width, /** @type {number} */ height)=>
    (width * 2 + 2) * height + 2;

/** @param {CodecMemory} memory @param {number} first @param {number} second */
function msrleCompressQuery(memory, first, second){
    const input = readHeader(memory, first);
    if (!input || input.compression !== BI_RGB || input.bitCount !== 8)
    {
        return ICERR_BADFORMAT;
    }
    const output = readHeader(memory, second);
    return !output || output.compression === BI_RLE8 ? ICERR_OK : ICERR_BADFORMAT;
}

/** msvidc32: Microsoft Video 1, 8-bit (palette) or 16-bit (RGB555) frames. */
const msvidc = /** @type {Codec} */ ({
    handler: fourcc('msvc'),
    driver: 'msvidc32.dll',
    name: 'MS-CRAM',
    description: 'Microsoft Video 1',
    flags: VIDCF_TEMPORAL | VIDCF_QUALITY,
    open: memory=>{
        /** @type {Uint8Array | Uint16Array | null} */
        let pixels = null;
        // The FOURCC exactly as a stream writes it: msvc in lower case is not this codec's.
        const names = [fourcc('MSVC'), fourcc('CRAM')];
        return decompressor(memory, {
            accepts: input=>names.includes(input.compression)
                && (input.bitCount === 8 || input.bitCount === 16),
            outputs: (input, output)=>output.compression === BI_RGB
                && [input.width, input.width & ~3].includes(output.width)
                && [input.height, input.height & ~3].includes(Math.abs(output.height))
                && (input.bitCount === 8 ? output.bitCount === 8 : [16, 24,
                    32].includes(output.bitCount)),
            formatOf: input=>({ width: input.width & ~3, height: input.height & ~3,
                bitCount: input.bitCount }),
            decode: (input, data, palette, output, bits, left, bottom)=>{
                const width = input.width & ~3;
                const height = Math.abs(input.height) & ~3;
                if (!pixels || pixels.length !== width * height
                    || (input.bitCount === 16) !== (pixels instanceof Uint16Array))
                {
                    pixels = input.bitCount === 16 ? new Uint16Array(width * height)
                        : new Uint8Array(width * height);
                }
                decodeVideo1(data, width, height, input.bitCount === 16 ? 16 : 8, pixels);
                const frame = pixels;
                writePixels(memory, output, bits, width, height,
                    i=>(input.bitCount === 16 ? fromRgb555(frame[i]) : fromPalette(palette,
                        frame[i])),
                    i=>frame[i], left, bottom);
            },
        });
    },
});

/** iccvid: Cinepak, decoded to 24-bit colour whatever its stream says. */
const iccvid = /** @type {Codec} */ ({
    handler: fourcc('cvid'),
    driver: 'iccvid.dll',
    name: 'cvid',
    description: 'Cinepak Codec by Radius',
    flags: VIDCF_QUALITY | VIDCF_CRUNCH | VIDCF_TEMPORAL | VIDCF_COMPRESSFRAMES
        | VIDCF_FASTTEMPORALC,
    version: 0x10000,
    open: memory=>{
        /** @type {Uint8Array | null} */
        let rgb = null;
        const state = newCinepakState();
        return decompressor(memory, {
            accepts: input=>input.compression === fourcc('cvid'),
            outputs: (input, output)=>output.planes === 1
                && output.width === input.width
                    && Math.abs(output.height) === Math.abs(input.height)
                && ((output.compression === BI_RGB && [8, 16, 24, 32].includes(output.bitCount))
                    || (output.compression === BI_BITFIELDS && output.bitCount === 16
                        && isFiveSixFive(memory, output))),
            formatOf: input=>({ width: input.width, height: input.height, bitCount: 24 }),
            decode: (input, data, palette, output, bits, left, bottom)=>{
                const width = input.width;
                const height = Math.abs(input.height);
                if (!rgb || rgb.length !== width * height * 3)
                {
                    rgb = new Uint8Array(width * height * 3);
                }
                decodeCinepak(data, width, height, rgb, state);
                const frame = rgb;
                // Cinepak's rows run top down; the DIB's from the bottom.
                const at = (/** @type {number} */ i)=>
                    ((height - 1 - Math.floor(i / width)) * width + i % width) * 3;
                writePixels(memory, output, bits, width, height,
                    i=>frame[at(i)] << 16 | frame[at(i) + 1] << 8 | frame[at(i) + 2],
                    i=>nearest(palette, frame[at(i)], frame[at(i) + 1], frame[at(i) + 2]),
                    left, bottom);
            },
        });
    },
});

/** Whether a 16-bit BI_BITFIELDS header's masks are 5-6-5, the one layout written. */
function isFiveSixFive(/** @type {CodecMemory} */ memory, /** @type {Header} */ header){
    const view = new DataView(memory.readMemory(header.at + (header.size || HEADER_SIZE),
        12).slice().buffer);
    return view.getUint32(0, true) === 0xf800 && view.getUint32(4, true) === 0x07e0
        && view.getUint32(8, true) === 0x001f;
}

/** The palette entry nearest a colour, for a decoder that gives colour to an 8-bit output. */
/** @param {Uint8Array} palette @param {number} r @param {number} g @param {number} b */
function nearest(palette, r, g, b){
    let best = 0;
    let distance = Infinity;
    for (let i = 0; i < palette.length / 4; i++)
    {
        const d = (palette[i * 4 + 2] - r) ** 2 + (palette[i * 4 + 1] - g) ** 2 +
            (palette[i * 4] - b) ** 2;
        if (d < distance)
        {
            distance = d;
            best = i;
        }
    }
    return best;
}

/** The codecs, in the order the system lists them. */
export const SYSTEM_CODECS = [iccvid, msrle, msvidc];
