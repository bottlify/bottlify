/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WIC's decoders: a container's bytes as the frames its decoder hands out,
 * each in the pixel format Windows' decoder gives it, through the readers
 * D3DX and the media layer already have.
 *
 * - BMP: 1, 2, 4 and 8 bits as indexed with the colour table, 16 bits as
 *   555 or 565, 24 as BGR, 32 as BGR or (with an alpha mask) BGRA, RLE as
 *   32bppBGR, other bit fields as BGRA. The resolution is the header's
 *   pixels a metre, 96 dpi when either is zero (Wine's bmpformat test).
 * - PNG: grey and indexed at their own depth, colour as 24bppBGR or
 *   48bppRGB, alpha as 32bppBGRA or 64bppRGBA, a tRNS chunk on grey or
 *   colour as 32bppBGRA; pHYs in metres gives the resolution.
 * - ICO: every image as 32bppBGRA, its AND mask made alpha unless its own
 *   32-bit image carries one.
 * - GIF: every image as 8bppIndexed at its own size, its colour table (the
 *   transparent index alpha 0); the screen's pixel aspect in the resolution.
 * - JPEG: grey as 8bppGray, four components as 32bppCMYK, the rest as 24bppBGR.
 * - TIFF: the first image as 32bppBGRA (the media layer's reader), which is
 *   not the native format Windows gives most TIFFs; a limit in the docs.
 */

import { bitmapPixels, readJpeg } from '../d3dx9/images.js';
import { FMT } from '../d3dx9/pixels.js';
import { readPng, readPngPixels } from '../d3dx9/png.js';
import { decodeGifFrames, isGif } from '../../media/internal/gif.js';
import { decodeTiff, isTiff } from '../../media/internal/tiff.js';
import { decodeJpeg, readJpegHeader } from '../../media/internal/jpeg.js';
import { GUID } from './layout.js';
import { convertRow, formatOf, rowBytes } from './formats.js';

/** WINCODEC_ERR_* and the HRESULTs the decoders answer with. */
export const WINCODEC = Object.freeze({
    WRONGSTATE: 0x88982f04 | 0,
    VALUEOUTOFRANGE: 0x88982f05 | 0,
    UNKNOWNIMAGEFORMAT: 0x88982f07 | 0,
    NOTINITIALIZED: 0x88982f0c | 0,
    ALREADYLOCKED: 0x88982f0d | 0,
    CODECNOTHUMBNAIL: 0x88982f44 | 0,
    PALETTEUNAVAILABLE: 0x88982f45 | 0,
    COMPONENTNOTFOUND: 0x88982f50 | 0,
    BADIMAGE: 0x88982f60 | 0,
    BADHEADER: 0x88982f61 | 0,
    FRAMEMISSING: 0x88982f62 | 0,
    STREAMREAD: 0x88982f72 | 0,
    UNSUPPORTEDPIXELFORMAT: 0x88982f80 | 0,
    UNSUPPORTEDOPERATION: 0x88982f81 | 0,
    INSUFFICIENTBUFFER: 0x88982f8c | 0,
});

/** A container a decoder here cannot read, with the HRESULT it answers. */
export class CodecError extends Error {
    /** @param {number} hr @param {string} message */
    constructor(hr, message){
        super(message);
        this.hr = hr;
    }
}

/**
 * @typedef {Object} DecodedFrame
 * @property {number} width
 * @property {number} height
 * @property {import('./formats.js').PixelFormat} format
 * @property {Uint8Array} pixels  top-down rows, each rowBytes(format, width), packed
 * @property {number[] | null} palette  0xAARRGGBB
 * @property {number} dpiX
 * @property {number} dpiY
 */

/**
 * @typedef {Object} DecodedImage
 * @property {DecodedFrame[]} frames
 * @property {number[] | null} palette  the container's own (a GIF's global table)
 */

/**
 * A container a decoder is made for: its name in wincodec.h, its decoder's
 * CLSID, the file's first bytes that pick it (WICBitmapPattern: pattern and
 * mask) and what its decoder info reports.
 *
 * @typedef {Object} Container
 * @property {string} name
 * @property {string} guid
 * @property {string} decoder
 * @property {string} encoder
 * @property {string} friendly
 * @property {string} mime
 * @property {string} extensions
 * @property {number[][]} patterns
 * @property {boolean} multiframe
 * @property {boolean} animation
 * @property {boolean} lossless
 * @property {((bytes: Uint8Array) => DecodedImage) | null} decode  null: refused
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Whether a PNG has a chunk of a type, walking the chunks from the header on.
 *
 * @param {Uint8Array} bytes @param {string} type
 */
function hasChunk(bytes, type){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 8; at + 8 <= bytes.length;)
    {
        if (String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === type)
        {
            return true;
        }
        at += 12 + view.getUint32(at, false);
    }
    return false;
}

/** The bit depths PNG allows each colour type. */
const PNG_DEPTHS = new Map([[0, [1, 2, 4, 8, 16]], [2, [8, 16]], [3, [1, 2, 4, 8]],
    [4, [8, 16]], [6, [8, 16]]]);

/** @param {string} name */
const pixelFormat = name=>/** @type {import('./formats.js').PixelFormat} */ (formatOf(
    /** @type {Record<string, string>} */ (GUID)[`PixelFormat${name}`]));

/** @param {number} ppm  pixels a metre */
const dpiOf = ppm=>ppm * 0.0254;

/**
 * A frame of BGRA texels in 32bppBGRA.
 *
 * @param {number} width @param {number} height @param {Uint8Array} bgra
 * @returns {DecodedFrame}
 */
const bgraFrame = (width, height, bgra)=>({ width, height, format: pixelFormat('32bppBGRA'),
    pixels: bgra, palette: null, dpiX: 96, dpiY: 96 });

/**
 * A bit-field pixel's channel, scaled to 8 bits.
 *
 * @param {number} value @param {number} mask
 */
function field(value, mask){
    if (mask === 0)
    {
        return -1;
    }
    let shift = 0;
    while (((mask >>> shift) & 1) === 0)
    {
        shift++;
    }
    const max = mask >>> shift;
    return Math.round(((value & mask) >>> shift) * 255 / max);
}

/**
 * A DIB's pixels as BGRA, alpha 255 unless its own 32-bit masks or
 * `keepAlpha` give one.
 *
 * @param {import('../d3dx9/images.js').BitmapPixels} dib @param {boolean} keepAlpha
 * @returns {Uint8Array}
 */
function dibBgra(dib, keepAlpha){
    const { width, height, bits, rowBytes: stride, pixels, palette, masks } = dib;
    const out = new Uint8Array(width * height * 4);
    if (bits <= 8)
    {
        const from = pixelFormat(`${bits}bppIndexed`);
        const to = pixelFormat('32bppBGRA');
        for (let y = 0; y < height; y++)
        {
            out.set(convertRow(from, to, pixels.subarray(y * stride, (y + 1) * stride), width,
                palette, null), y * width * 4);
        }
        return out;
    }
    const size = bits / 8;
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const at = y * stride + x * size;
            let value = 0;
            for (let i = 0; i < size; i++)
            {
                value |= pixels[at + i] << (8 * i);
            }
            value >>>= 0;
            const to = (y * width + x) * 4;
            if (bits === 24)
            {
                out.set([pixels[at], pixels[at + 1], pixels[at + 2], 255], to);
                continue;
            }
            const alpha = field(value, masks[3]);
            out[to] = field(value, masks[2]);
            out[to + 1] = field(value, masks[1]);
            out[to + 2] = field(value, masks[0]);
            out[to + 3] = keepAlpha && alpha >= 0 ? alpha : 255;
        }
    }
    return out;
}

/** @param {number[]} masks @param {number[]} want */
const masksAre = (masks, want)=>masks.every((m, i)=>(m >>> 0) === (want[i] ?? 0) >>> 0);

/** @param {Uint8Array} bytes @returns {DecodedImage} */
function decodeBmp(bytes){
    let dib;
    try
    {
        dib = bitmapPixels(bytes);
    }
    catch (e){
        throw new CodecError(WINCODEC.BADIMAGE, /** @type {Error} */ (e).message);
    }
    const [xppm, yppm] = dib.pixelsPerMetre;
    const dpiX = xppm > 0 && yppm > 0 ? dpiOf(xppm) : 96;
    const dpiY = xppm > 0 && yppm > 0 ? dpiOf(yppm) : 96;
    const { width, height, bits, compression, masks } = dib;
    /** @param {string} name @param {Uint8Array} pixels @param {number[] | null} palette */
    const frame = (name, pixels, palette)=>({ frames: [{ width, height, format: pixelFormat(name),
        pixels, palette, dpiX, dpiY }], palette: null });
    if (compression === 1 || compression === 2)
    {
        // An RLE bitmap comes out as 32bppBGR, its indices looked up, and
        // keeps its colour table for CopyPalette (Wine's bmpformat test).
        return frame('32bppBGR', unused(dibBgra(dib, false)), dib.palette);
    }
    if (bits <= 8)
    {
        return frame(`${bits}bppIndexed`, dib.pixels, dib.palette);
    }
    if (bits === 24)
    {
        return frame('24bppBGR', dib.pixels, null);
    }
    if (bits === 16 && masksAre(masks, [0x7c00, 0x3e0, 0x1f]))
    {
        return frame('16bppBGR555', dib.pixels, null);
    }
    if (bits === 16 && masksAre(masks, [0xf800, 0x7e0, 0x1f]))
    {
        return frame('16bppBGR565', dib.pixels, null);
    }
    if (bits === 32 && masksAre(masks, [0xff0000, 0xff00, 0xff]))
    {
        return frame('32bppBGR', dib.pixels, null);
    }
    if (bits === 32 && masksAre(masks, [0xff0000, 0xff00, 0xff, 0xff000000]))
    {
        return frame('32bppBGRA', dib.pixels, null);
    }
    // Any other bit fields, an alpha mask among them, come out as 32bppBGR.
    return frame('32bppBGR', unused(dibBgra(dib, false)), null);
}

/** BGRA texels as 32bppBGR's, the fourth byte 0. @param {Uint8Array} bgra */
function unused(bgra){
    for (let i = 3; i < bgra.length; i += 4)
    {
        bgra[i] = 0;
    }
    return bgra;
}

/** @param {Uint8Array} bytes @returns {DecodedImage} */
function decodePng(bytes){
    if (bytes.length >= 26 && !PNG_DEPTHS.get(bytes[25])?.includes(bytes[24]))
    {
        throw new CodecError(WINCODEC.UNKNOWNIMAGEFORMAT,
            `a PNG of colour type ${bytes[25]} at ${bytes[24]} bits`);
    }
    if (bytes[25] === 3 && !hasChunk(bytes, 'PLTE'))
    {
        throw new CodecError(WINCODEC.UNKNOWNIMAGEFORMAT, 'an indexed PNG with no palette');
    }
    let png;
    try
    {
        png = readPngPixels(bytes);
    }
    catch (e){
        throw new CodecError(WINCODEC.BADIMAGE, /** @type {Error} */ (e).message);
    }
    const { width, height, depth, colour, pixels, transparency } = png;
    const dpi = png.pixelsPerMetre
        ? [dpiOf(png.pixelsPerMetre[0]), dpiOf(png.pixelsPerMetre[1])] : [96, 96];
    /** @param {string} name @param {Uint8Array} data @param {number[] | null} palette */
    const frame = (name, data, palette)=>({ frames: [{ width, height, format: pixelFormat(name),
        pixels: data, palette, dpiX: dpi[0], dpiY: dpi[1] }], palette: null });
    /** Big-endian 16-bit samples as WIC's little-endian ones. */
    const swapped = ()=>{
        const out = pixels.slice();
        for (let i = 0; i + 1 < out.length; i += 2)
        {
            out[i] = pixels[i + 1];
            out[i + 1] = pixels[i];
        }
        return out;
    };
    if (colour === 3)
    {
        const table = /** @type {Uint8Array} */ (png.palette);
        const palette = Array.from({ length: table.length / 3 }, (_, i)=>
            (((transparency?.[i] ?? 255) << 24) | table[i * 3] << 16 | table[i * 3 + 1] << 8
                | table[i * 3 + 2]) >>> 0);
        return frame(`${depth}bppIndexed`, pixels, palette);
    }
    if (colour === 0 && transparency && transparency.length >= 2)
    {
        // Grey with a transparent level: indexed by its own depth, a grey
        // palette whose transparent entry has alpha 0; at 16 bits, RGBA.
        const level = transparency[0] << 8 | transparency[1];
        if (depth === 16)
        {
            const words = swapped();
            const out = new Uint8Array(width * height * 8);
            for (let i = 0; i < width * height; i++)
            {
                const value = pixels[i * 2] << 8 | pixels[i * 2 + 1];
                for (let c = 0; c < 3; c++)
                {
                    out.set(words.subarray(i * 2, i * 2 + 2), i * 8 + c * 2);
                }
                const alpha = value === level ? 0 : 0xff;
                out[i * 8 + 6] = alpha;
                out[i * 8 + 7] = alpha;
            }
            return frame('64bppRGBA', out, null);
        }
        const levels = 1 << depth;
        const palette = Array.from({ length: levels }, (_, i)=>{
            const v = Math.round(i * 255 / (levels - 1));
            return ((i === level ? 0 : 0xff000000) | v * 0x010101) >>> 0;
        });
        return frame(`${depth}bppIndexed`, pixels, palette);
    }
    if (colour === 0)
    {
        if (depth === 16)
        {
            return frame('16bppGray', swapped(), null);
        }
        return frame(depth === 1 ? 'BlackWhite' : `${depth}bppGray`, pixels, null);
    }
    if (depth === 16)
    {
        if (colour === 2)
        {
            return frame('48bppRGB', swapped(), null);
        }
        // Grey and alpha at 16 bits: four channels of it.
        const words = swapped();
        if (colour === 6)
        {
            return frame('64bppRGBA', words, null);
        }
        const out = new Uint8Array(width * height * 8);
        for (let i = 0; i < width * height; i++)
        {
            for (let c = 0; c < 3; c++)
            {
                out.set(words.subarray(i * 4, i * 4 + 2), i * 8 + c * 2);
            }
            out.set(words.subarray(i * 4 + 2, i * 4 + 4), i * 8 + 6);
        }
        return frame('64bppRGBA', out, null);
    }
    if (colour === 2)
    {
        const out = new Uint8Array(width * height * 3);
        for (let i = 0; i < width * height; i++)
        {
            out[i * 3] = pixels[i * 3 + 2];
            out[i * 3 + 1] = pixels[i * 3 + 1];
            out[i * 3 + 2] = pixels[i * 3];
        }
        return frame('24bppBGR', out, null);
    }
    const decoded = readPng(bytes);
    return frame('32bppBGRA', decoded.bgra, null);
}

/** @param {Uint8Array} bytes @returns {DecodedImage} */
function decodeIco(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // The header's reserved word and type are not looked at (Wine's icoformat
    // test); a header cut short is a stream that ran out.
    if (bytes.length < 6)
    {
        throw new CodecError(WINCODEC.STREAMREAD, 'an icon cut short of its header');
    }
    const count = view.getUint16(4, true);
    /** @type {DecodedFrame[]} */
    const frames = [];
    for (let i = 0; i < count; i++)
    {
        const entry = 6 + i * 16;
        if (entry + 16 > bytes.length)
        {
            throw new CodecError(WINCODEC.BADIMAGE, 'an icon cut short of its directory');
        }
        const size = view.getUint32(entry + 8, true);
        const offset = view.getUint32(entry + 12, true);
        if (offset + size > bytes.length)
        {
            throw new CodecError(WINCODEC.BADIMAGE, 'an icon image past the end of its file');
        }
        const image = bytes.subarray(offset, offset + size);
        frames.push(iconImage(image, bytes[entry + 1] || 256));
    }
    return { frames, palette: null };
}

/**
 * One image of an icon: a PNG, or a DIB whose header counts its AND mask's
 * rows too.
 *
 * @param {Uint8Array} image @param {number} height  the directory's, for a header with none
 * @returns {DecodedFrame}
 */
function iconImage(image, height){
    if (PNG_SIGNATURE.every((b, i)=>image[i] === b))
    {
        const decoded = readPng(image);
        return bgraFrame(decoded.width, decoded.height, decoded.bgra);
    }
    if (image.length < 40)
    {
        throw new CodecError(WINCODEC.BADIMAGE, 'an icon image cut short');
    }
    const declared = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const rows = Math.abs(declared.getInt32(8, true)) >> 1 || height;
    let dib;
    try
    {
        dib = bitmapPixels(image, { dib: true, height: rows });
    }
    catch (e){
        throw new CodecError(WINCODEC.BADIMAGE, /** @type {Error} */ (e).message);
    }
    const bits = dib.bits;
    const bgra = dibBgra(bits === 32 ? { ...dib, masks: [0xff0000, 0xff00, 0xff, 0xff000000] }
        : dib, true);
    const ownAlpha = bits === 32 && bgra.some((v, i)=>(i & 3) === 3 && v !== 0);
    if (!ownAlpha)
    {
        // The AND mask follows, one bit a pixel, bottom-up, rows of whole dwords.
        const stride = Math.ceil(dib.width / 32) * 4;
        for (let row = 0; row < dib.height; row++)
        {
            const y = dib.height - 1 - row;
            for (let x = 0; x < dib.width; x++)
            {
                const byte = image[dib.end + row * stride + (x >> 3)] ?? 0;
                bgra[(y * dib.width + x) * 4 + 3] = (byte >> (7 - (x & 7))) & 1 ? 0 : 255;
            }
        }
    }
    return bgraFrame(dib.width, dib.height, bgra);
}

/** @param {Uint8Array} bytes @returns {DecodedImage} */
function decodeGif(bytes){
    let gif;
    try
    {
        gif = decodeGifFrames(bytes);
    }
    catch (e){
        throw new CodecError(WINCODEC.BADIMAGE, /** @type {Error} */ (e).message);
    }
    /** @param {Uint8Array} table @param {number} transparent */
    const coloursOf = (table, transparent)=>Array.from({ length: table.length / 3 }, (_, i)=>
        ((i === transparent ? 0 : 0xff000000) | table[i * 3] << 16 | table[i * 3 + 1] << 8
            | table[i * 3 + 2]) >>> 0);
    // A pixel (aspect + 15) / 64 as wide as it is high is fewer of them an inch.
    const dpiX = gif.aspect ? 96 * 64 / (gif.aspect + 15) : 96;
    const frames = gif.frames.map(f=>({ width: f.width, height: f.height,
        format: pixelFormat('8bppIndexed'), pixels: f.indices,
        palette: coloursOf(f.table, f.transparent), dpiX, dpiY: 96 }));
    // The decoder's palette is the file's table, or the default one where it
    // has none, with the first image's transparent index (Wine's gifformat test).
    return { frames, palette: coloursOf(gif.global ?? gif.fallback,
        gif.frames[0].transparent) };
}

/** @param {Uint8Array} bytes @returns {DecodedImage} */
function decodeJpegContainer(bytes){
    let image;
    try
    {
        if (readJpegHeader(bytes).components === 4)
        {
            return jpegCmyk(bytes);
        }
        image = readJpeg(bytes);
    }
    catch (e){
        throw new CodecError(WINCODEC.BADIMAGE, /** @type {Error} */ (e).message);
    }
    const { width, height } = image;
    const bgra = image.levels[0].data;
    const grey = image.format === FMT.L8;
    const out = new Uint8Array(width * height * (grey ? 1 : 3));
    for (let i = 0; i < width * height; i++)
    {
        if (grey)
        {
            out[i] = bgra[i * 4];
        }
        else
        {
            out.set(bgra.subarray(i * 4, i * 4 + 3), i * 3);
        }
    }
    return { frames: [{ width, height, format: pixelFormat(grey ? '8bppGray' : '24bppBGR'),
        pixels: out, palette: null, dpiX: 96, dpiY: 96 }], palette: null };
}

/**
 * A four-component JPEG as 32bppCMYK, as Windows' decoder gives it: Adobe
 * writes the inks inverted, and YCCK (transform 2) is the inverted inks'
 * YCbCr with black beside.
 *
 * @param {Uint8Array} bytes @returns {DecodedImage}
 */
function jpegCmyk(bytes){
    const { width, height, samples, transform } = decodeJpeg(bytes);
    const out = new Uint8Array(width * height * 4);
    const clamp = (/** @type {number} */ v)=>Math.max(0, Math.min(255, Math.round(v)));
    for (let i = 0; i < width * height; i++)
    {
        let [c, m, y] = [samples[i * 4], samples[i * 4 + 1], samples[i * 4 + 2]];
        if (transform === 2)
        {
            const luma = c;
            const cb = m - 128;
            const cr = y - 128;
            [c, m, y] = [clamp(luma + 1.402 * cr), clamp(luma - 0.344136 * cb - 0.714136 * cr),
                clamp(luma + 1.772 * cb)];
        }
        out[i * 4] = 255 - c;
        out[i * 4 + 1] = 255 - m;
        out[i * 4 + 2] = 255 - y;
        out[i * 4 + 3] = 255 - samples[i * 4 + 3];
    }
    return { frames: [{ width, height, format: pixelFormat('32bppCMYK'), pixels: out,
        palette: null, dpiX: 96, dpiY: 96 }], palette: null };
}

/** @param {Uint8Array} bytes @returns {DecodedImage} */
function decodeTiffContainer(bytes){
    let image;
    try
    {
        image = decodeTiff(bytes);
    }
    catch (e){
        throw new CodecError(WINCODEC.BADIMAGE, /** @type {Error} */ (e).message);
    }
    const bgra = new Uint8Array(image.rgba.length);
    for (let i = 0; i < bgra.length; i += 4)
    {
        bgra[i] = image.rgba[i + 2];
        bgra[i + 1] = image.rgba[i + 1];
        bgra[i + 2] = image.rgba[i];
        bgra[i + 3] = image.rgba[i + 3];
    }
    return { frames: [bgraFrame(image.width, image.height, bgra)], palette: null };
}

/** @param {string} text */
const ascii = text=>Array.from(text, c=>c.charCodeAt(0));

/** @type {Container[]} */
export const CONTAINERS = [
    { name: 'Bmp', friendly: 'BMP Decoder', mime: 'image/bmp', extensions: '.bmp,.dib,.rle',
        patterns: [ascii('BM')], multiframe: false, animation: false, lossless: true,
        decode: decodeBmp },
    { name: 'Png', friendly: 'PNG Decoder', mime: 'image/png', extensions: '.png',
        patterns: [PNG_SIGNATURE], multiframe: false, animation: false, lossless: true,
        decode: decodePng },
    { name: 'Ico', friendly: 'ICO Decoder', mime: 'image/ico,image/x-icon',
        extensions: '.ico,.icon', patterns: [[0, 0, 1, 0]], multiframe: true, animation: false,
        lossless: true, decode: decodeIco },
    { name: 'Jpeg', friendly: 'JPEG Decoder', mime: 'image/jpeg,image/jpe,image/jpg',
        extensions: '.jpeg,.jpe,.jpg,.jfif,.exif', patterns: [[0xff, 0xd8, 0xff]],
        multiframe: false, animation: false, lossless: false, decode: decodeJpegContainer },
    { name: 'Gif', friendly: 'GIF Decoder', mime: 'image/gif', extensions: '.gif',
        patterns: [ascii('GIF87a'), ascii('GIF89a')], multiframe: true, animation: true,
        lossless: false, decode: decodeGif },
    { name: 'Tiff', friendly: 'TIFF Decoder', mime: 'image/tiff,image/tif',
        extensions: '.tiff,.tif', patterns: [[0x49, 0x49, 0x2a, 0], [0x4d, 0x4d, 0, 0x2a]],
        multiframe: true, animation: false, lossless: true, decode: decodeTiffContainer },
    { name: 'Dds', friendly: 'DDS Decoder', mime: 'image/vnd.ms-dds', extensions: '.dds',
        patterns: [ascii('DDS ')], multiframe: true, animation: false, lossless: false,
        decode: null },
    { name: 'Wmp', friendly: 'WMPhoto Decoder', mime: 'image/vnd.ms-photo',
        extensions: '.wdp,.jxr', patterns: [[0x49, 0x49, 0xbc, 0x01]], multiframe: false,
        animation: false, lossless: true, decode: null },
].map(c=>Object.freeze({ ...c,
    guid: /** @type {Record<string, string>} */ (GUID)[`ContainerFormat${c.name}`],
    decoder: /** @type {Record<string, string>} */ (GUID)[`CLSID_${c.name}Decoder`],
    encoder: /** @type {Record<string, string>} */ (GUID)[`CLSID_${c.name}Encoder`] }));

/**
 * The container whose patterns a file's first bytes match, or null.
 *
 * @param {Uint8Array} bytes
 * @returns {Container | null}
 */
export function sniff(bytes){
    if (isGif(bytes))
    {
        return /** @type {Container} */ (CONTAINERS.find(c=>c.name === 'Gif'));
    }
    if (isTiff(bytes))
    {
        return /** @type {Container} */ (CONTAINERS.find(c=>c.name === 'Tiff'));
    }
    return CONTAINERS.find(c=>c.patterns.some(p=>p.every((b, i)=>bytes[i] === b))) ?? null;
}

/**
 * A rectangle of a frame's rows, packed: each row of `width` pixels from
 * column `x`, shifted where a pixel is less than a byte.
 *
 * @param {Uint8Array} pixels @param {number} stride @param {number} bpp
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @returns {Uint8Array}
 */
export function cropRows(pixels, stride, bpp, rect){
    const out = new Uint8Array(Math.ceil(rect.width * bpp / 8) * rect.height);
    const length = Math.ceil(rect.width * bpp / 8);
    for (let row = 0; row < rect.height; row++)
    {
        const from = (rect.y + row) * stride;
        const bit = rect.x * bpp;
        if ((bit & 7) === 0)
        {
            out.set(pixels.subarray(from + (bit >> 3), from + (bit >> 3) + length), row * length);
            continue;
        }
        for (let x = 0; x < rect.width * bpp; x++)
        {
            const source = bit + x;
            const value = (pixels[from + (source >> 3)] >> (7 - (source & 7))) & 1;
            out[row * length + (x >> 3)] |= value << (7 - (x & 7));
        }
    }
    return out;
}

export { rowBytes };
