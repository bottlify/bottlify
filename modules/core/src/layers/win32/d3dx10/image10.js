/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * An image file as D3DX 10 and 11 see it: always in a DXGI format. A DDS file
 * with the DX10 header keeps the format it names; a classic DDS file's pixel
 * format is mapped to the DXGI format D3DX makes of it, and its texels
 * converted where the two are laid out differently (A8R8G8B8, the 16-bit
 * colours, luminance and palettes all become R8G8B8A8, L16 becomes
 * R16G16B16A16, A2R10G10B10 becomes R10G10B10A2). Every other file -- BMP,
 * PNG, JPEG, GIF, TIFF -- is R8G8B8A8.
 *
 * The contract is Wine's d3dx10 and d3dx11 tests (what Windows answers): of a
 * DDS file only the header's size is checked when its information is asked
 * for; only the DDS_DEPTH flag makes a classic file a volume; a cube map must
 * have all six faces; a DX10 header with misc_flags2 set is refused; the
 * bump-map, YUV and CxV8U8 formats, ATI1, and the 16-bit DXGI formats B5G6R5,
 * B5G5R5A1 and B4G4R4A4 are not read; BC6H and BC7 only by D3DX 11.
 */

import { IFF, ImageError, readImage } from '../d3dx9/images.js';
import { FMT } from '../d3dx9/pixels.js';
import { GifError, decodeGif, isGif } from '../../media/internal/gif.js';
import { TiffError, decodeTiff, isTiff } from '../../media/internal/tiff.js';
import { DIMENSION, dxgiLayout } from './dds10.js';

/** D3DX10_IMAGE_FILE_FORMAT (D3DX11's numbers are the same). */
export const IFF10 = Object.freeze({ BMP: 0, JPG: 1, PNG: 3, DDS: 4, TIFF: 10, GIF: 11,
    WMP: 12 });

/**
 * A file D3DX reads that this loader does not: refused like a bad file, and
 * said, being a departure.
 */
export class NotRead extends ImageError {}

const DDS_MAGIC = 0x20534444;
const FOURCC_DX10 = 0x30315844;
const HEADER_BYTES = 128;
const DX10_BYTES = 148;
/** DDS_HEADER flags: the depth field is meant (a volume). */
const DDS_DEPTH = 0x800000;
const DDSCAPS2_CUBEMAP = 0x200;
const DDSCAPS2_ALL_FACES = 0xfc00;
const MISC_TEXTURECUBE = 0x4;
const PALETTE_BYTES = 1024;

/** DDS_PIXELFORMAT flags. */
const PF = Object.freeze({ ALPHA: 0x1, ALPHA_ONLY: 0x2, FOURCC: 0x4, INDEXED: 0x20, RGB: 0x40,
    LUMINANCE: 0x20000, BUMP_LUMINANCE: 0x40000, BUMP_DUDV: 0x80000 });

/** DXGI formats named here. */
const DXGI = Object.freeze({ R32G32B32A32_FLOAT: 2, R16G16B16A16_FLOAT: 10,
    R16G16B16A16_UNORM: 11, R16G16B16A16_SNORM: 13, R32G32_FLOAT: 16, R10G10B10A2_UNORM: 24,
    R8G8B8A8_UNORM: 28, R16G16_FLOAT: 34, R16G16_UNORM: 35, R32_FLOAT: 41, R16_FLOAT: 54,
    A8_UNORM: 65, R8G8_B8G8_UNORM: 68, G8R8_G8B8_UNORM: 69, BC1_UNORM: 71, BC2_UNORM: 74,
    BC3_UNORM: 77, BC4_UNORM: 80, BC4_SNORM: 81, BC5_UNORM: 83, BC5_SNORM: 84,
    B5G6R5_UNORM: 85, B5G5R5A1_UNORM: 86, B4G4R4A4_UNORM: 115 });

/** BC6H (typeless, UF16, SF16) and BC7 (typeless, UNORM, sRGB): D3DX 11's, not 10's. */
const BC6_7 = new Set([94, 95, 96, 97, 98, 99]);
/** DXGI formats a DX10 header may not name. */
/** @type {Set<number>} */
const REFUSED_DXGI = new Set([DXGI.B5G6R5_UNORM, DXGI.B5G5R5A1_UNORM, DXGI.B4G4R4A4_UNORM]);

/** A FourCC as a little-endian word. @param {string} text */
const fourCC = text=>[...text].reduce((word, c, i)=>word | c.charCodeAt(0) << i * 8, 0) >>> 0;

/**
 * Classic FourCCs and the DXGI format of each, held byte for byte as the file
 * has them (the D3DFORMAT numbers of the deep and float formats among them).
 */
const FOURCC_FORMATS = new Map([[fourCC('DXT1'), DXGI.BC1_UNORM],
    [fourCC('DXT2'), DXGI.BC2_UNORM], [fourCC('DXT3'), DXGI.BC2_UNORM],
    [fourCC('DXT4'), DXGI.BC3_UNORM], [fourCC('DXT5'), DXGI.BC3_UNORM],
    [fourCC('RGBG'), DXGI.R8G8_B8G8_UNORM], [fourCC('GRGB'), DXGI.G8R8_G8B8_UNORM],
    [fourCC('BC4U'), DXGI.BC4_UNORM], [fourCC('BC4S'), DXGI.BC4_SNORM],
    [fourCC('BC5U'), DXGI.BC5_UNORM], [fourCC('BC5S'), DXGI.BC5_SNORM],
    [fourCC('ATI2'), DXGI.BC5_UNORM],
    [FMT.A16B16G16R16, DXGI.R16G16B16A16_UNORM], [110, DXGI.R16G16B16A16_SNORM],
    [111, DXGI.R16_FLOAT], [112, DXGI.R16G16_FLOAT], [113, DXGI.R16G16B16A16_FLOAT],
    [114, DXGI.R32_FLOAT], [115, DXGI.R32G32_FLOAT], [116, DXGI.R32G32B32A32_FLOAT]]);

/**
 * How a classic file's texels are read: the DXGI format they become, the
 * bytes each takes in the file (0 for one laid out in blocks or pairs, read
 * by the DXGI format's own layout), and how they become that format.
 *
 * @typedef {Object} Source
 * @property {number} dxgi
 * @property {number} bytes  a texel's bytes in the file, or 0
 * @property {((data: Uint8Array, texels: number, palette: Uint8Array | null)
 *     => Uint8Array) | null} convert  null when the file's bytes are the format's
 * @property {boolean} [palette]  whose texels index the 256 colours after the header
 */

/** A channel of a texel read through its mask, made 8 bits, rounded. @param {number} value @param {number} mask */
const channel8 = (value, mask)=>{
    if (!mask)
    {
        return 0;
    }
    const shift = 31 - Math.clz32(mask & -mask);
    const max = mask >>> shift;
    return Math.round(((value & mask) >>> shift) * 255 / max);
};

/**
 * Texels of `bytes` each, read through four masks (red, green, blue, alpha;
 * alpha 0 for none, read as opaque) into R8G8B8A8.
 *
 * @param {number} bytes @param {number[]} masks
 * @returns {(data: Uint8Array, texels: number) => Uint8Array}
 */
function masked(bytes, [r, g, b, a]){
    return (data, texels)=>{
        const out = new Uint8Array(texels * 4);
        for (let t = 0; t < texels; t++)
        {
            let value = 0;
            for (let i = bytes - 1; i >= 0; i--)
            {
                value = value * 256 + data[t * bytes + i];
            }
            value >>>= 0;
            out[t * 4] = channel8(value, r);
            out[t * 4 + 1] = channel8(value, g);
            out[t * 4 + 2] = channel8(value, b);
            out[t * 4 + 3] = a ? channel8(value, a) : 255;
        }
        return out;
    };
}

/**
 * Palette indices (and alpha) into R8G8B8A8 through the file's 256
 * PALETTEENTRYs: red, green, blue and, as Direct3D reads a palette, alpha in
 * peFlags where the texels hold none of their own.
 *
 * @param {boolean} withAlpha  a texel's second byte is its alpha (A8P8)
 * @returns {(data: Uint8Array, texels: number, palette: Uint8Array | null) => Uint8Array}
 */
function indexed(withAlpha){
    return (data, texels, palette)=>{
        const out = new Uint8Array(texels * 4);
        const colours = /** @type {Uint8Array} */ (palette);
        for (let t = 0; t < texels; t++)
        {
            const index = data[t * (withAlpha ? 2 : 1)];
            out.set(colours.subarray(index * 4, index * 4 + 4), t * 4);
            if (withAlpha)
            {
                out[t * 4 + 3] = data[t * 2 + 1];
            }
        }
        return out;
    };
}

/** L16 into R16G16B16A16: the grey in red, green and blue, alpha opaque. */
const luminance16 = (/** @type {Uint8Array} */ data, /** @type {number} */ texels)=>{
    const out = new Uint8Array(texels * 8);
    for (let t = 0; t < texels; t++)
    {
        for (let c = 0; c < 3; c++)
        {
            out[t * 8 + c * 2] = data[t * 2];
            out[t * 8 + c * 2 + 1] = data[t * 2 + 1];
        }
        out[t * 8 + 6] = 0xff;
        out[t * 8 + 7] = 0xff;
    }
    return out;
};

/** A2R10G10B10 into R10G10B10A2: red and blue change places. */
const swap1010 = (/** @type {Uint8Array} */ data, /** @type {number} */ texels)=>{
    const out = new Uint8Array(texels * 4);
    const from = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const to = new DataView(out.buffer);
    for (let t = 0; t < texels; t++)
    {
        const v = from.getUint32(t * 4, true);
        to.setUint32(t * 4, ((v & 0xc00ffc00) | (v >>> 20 & 0x3ff) | (v & 0x3ff) << 20) >>> 0,
            true);
    }
    return out;
};

/** @param {number[]} a @param {number[]} b */
const same = (a, b)=>a.every((v, i)=>(v >>> 0) === (b[i] >>> 0));

/**
 * The classic pixel formats D3DX 10 reads by their masks: flags (RGB or
 * luminance, with or without alpha), bits, the masks that matter, and how.
 *
 * @type {{ flags: number, bits: number, masks: number[], source: Source }[]}
 */
const MASKED_FORMATS = [
    // 32 bits: A8R8G8B8, X8R8G8B8, A8B8G8R8, X8B8G8R8, A2R10G10B10, A2B10G10R10, G16R16.
    { flags: PF.RGB | PF.ALPHA, bits: 32, masks: [0xff0000, 0xff00, 0xff, 0xff000000],
        source: { dxgi: DXGI.R8G8B8A8_UNORM, bytes: 4,
            convert: masked(4, [0xff0000, 0xff00, 0xff, 0xff000000]) } },
    { flags: PF.RGB, bits: 32, masks: [0xff0000, 0xff00, 0xff],
        source: { dxgi: DXGI.R8G8B8A8_UNORM, bytes: 4,
            convert: masked(4, [0xff0000, 0xff00, 0xff, 0]) } },
    { flags: PF.RGB | PF.ALPHA, bits: 32, masks: [0xff, 0xff00, 0xff0000, 0xff000000],
        source: { dxgi: DXGI.R8G8B8A8_UNORM, bytes: 4, convert: null } },
    { flags: PF.RGB, bits: 32, masks: [0xff, 0xff00, 0xff0000],
        source: { dxgi: DXGI.R8G8B8A8_UNORM, bytes: 4,
            convert: masked(4, [0xff, 0xff00, 0xff0000, 0]) } },
    { flags: PF.RGB | PF.ALPHA, bits: 32, masks: [0x3ff00000, 0xffc00, 0x3ff, 0xc0000000],
        source: { dxgi: DXGI.R10G10B10A2_UNORM, bytes: 4, convert: swap1010 } },
    { flags: PF.RGB | PF.ALPHA, bits: 32, masks: [0x3ff, 0xffc00, 0x3ff00000, 0xc0000000],
        source: { dxgi: DXGI.R10G10B10A2_UNORM, bytes: 4, convert: null } },
    { flags: PF.RGB, bits: 32, masks: [0xffff, 0xffff0000, 0],
        source: { dxgi: DXGI.R16G16_UNORM, bytes: 4, convert: null } },
    // 24 bits: R8G8B8.
    { flags: PF.RGB, bits: 24, masks: [0xff0000, 0xff00, 0xff],
        source: { dxgi: DXGI.R8G8B8A8_UNORM, bytes: 3,
            convert: masked(3, [0xff0000, 0xff00, 0xff, 0]) } },
    // 16 bits: R5G6B5, A1R5G5B5, X1R5G5B5, A4R4G4B4, X4R4G4B4, A8R3G3B2.
    ...[[0xf800, 0x7e0, 0x1f, 0], [0x7c00, 0x3e0, 0x1f, 0x8000], [0x7c00, 0x3e0, 0x1f, 0],
        [0xf00, 0xf0, 0xf, 0xf000], [0xf00, 0xf0, 0xf, 0], [0xe0, 0x1c, 0x3, 0xff00]]
        .map(([r, g, b, a])=>({ flags: PF.RGB | (a ? PF.ALPHA : 0), bits: 16,
            masks: a ? [r, g, b, a] : [r, g, b],
            source: { dxgi: DXGI.R8G8B8A8_UNORM, bytes: 2, convert: masked(2, [r, g, b, a]) } })),
    // 8 bits: R3G3B2.
    { flags: PF.RGB, bits: 8, masks: [0xe0, 0x1c, 0x3],
        source: { dxgi: DXGI.R8G8B8A8_UNORM, bytes: 1,
            convert: masked(1, [0xe0, 0x1c, 0x3, 0]) } },
    // Luminance: L8, L16, A8L8, A4L4.
    { flags: PF.LUMINANCE, bits: 8, masks: [0xff],
        source: { dxgi: DXGI.R8G8B8A8_UNORM, bytes: 1,
            convert: masked(1, [0xff, 0xff, 0xff, 0]) } },
    { flags: PF.LUMINANCE, bits: 16, masks: [0xffff],
        source: { dxgi: DXGI.R16G16B16A16_UNORM, bytes: 2, convert: luminance16 } },
    { flags: PF.LUMINANCE | PF.ALPHA, bits: 16, masks: [0xff, 0, 0, 0xff00],
        source: { dxgi: DXGI.R8G8B8A8_UNORM, bytes: 2,
            convert: masked(2, [0xff, 0xff, 0xff, 0xff00]) } },
    { flags: PF.LUMINANCE | PF.ALPHA, bits: 8, masks: [0xf, 0, 0, 0xf0],
        source: { dxgi: DXGI.R8G8B8A8_UNORM, bytes: 1,
            convert: masked(1, [0xf, 0xf, 0xf, 0xf0]) } },
];

/**
 * A classic DDS pixel format's source, or why it is not read: the fields a
 * flag does not make meaningful are not looked at.
 *
 * @param {DataView} pf  the 32-byte DDS_PIXELFORMAT
 * @returns {Source}
 */
function classicSource(pf){
    const flags = pf.getUint32(4, true);
    const code = pf.getUint32(8, true);
    const bits = pf.getUint32(12, true);
    const masks = [16, 20, 24, 28].map(at=>pf.getUint32(at, true));
    const hex = (/** @type {number} */ v)=>`0x${(v >>> 0).toString(16)}`;
    if (flags & PF.FOURCC)
    {
        const dxgi = FOURCC_FORMATS.get(code);
        if (dxgi === undefined)
        {
            throw new ImageError(`a DDS FourCC ${hex(code)} D3DX 10 does not read`);
        }
        return { dxgi, bytes: 0, convert: null };
    }
    if (flags & (PF.BUMP_DUDV | PF.BUMP_LUMINANCE))
    {
        throw new ImageError('a bump-map DDS pixel format, which D3DX 10 does not read');
    }
    if (flags & PF.INDEXED)
    {
        if (bits === 8 && !(flags & PF.ALPHA))
        {
            return { dxgi: DXGI.R8G8B8A8_UNORM, bytes: 1, convert: indexed(false), palette: true };
        }
        if (bits === 16 && (flags & PF.ALPHA) && masks[3] === 0xff00)
        {
            return { dxgi: DXGI.R8G8B8A8_UNORM, bytes: 2, convert: indexed(true), palette: true };
        }
    }
    if ((flags & PF.ALPHA_ONLY) && bits === 8 && masks[3] === 0xff)
    {
        return { dxgi: DXGI.A8_UNORM, bytes: 1, convert: null };
    }
    const kind = flags & (PF.RGB | PF.LUMINANCE | PF.ALPHA);
    for (const known of MASKED_FORMATS)
    {
        const used = (known.flags & PF.LUMINANCE)
            ? [masks[0], ...(known.flags & PF.ALPHA ? [0, 0, masks[3]] : [])]
            : [masks[0], masks[1], masks[2], ...(known.flags & PF.ALPHA ? [masks[3]] : [])];
        if (known.flags === kind && known.bits === bits && same(known.masks, used))
        {
            return known.source;
        }
    }
    throw new ImageError(`a DDS pixel format D3DX 10 does not read (flags ${hex(flags)}, ${bits}`
        + ` bits, masks ${masks.map(hex).join(' ')})`);
}

/**
 * @typedef {import('./dds10.js').DxgiImage} DxgiImage
 * @typedef {import('./dds10.js').DxgiLevel} DxgiLevel
 */

/**
 * Whether D3DX 11 reads it (BC6H and BC7 in a DX10 header).
 *
 * @typedef {{ bc6and7?: boolean, headerOnly?: boolean }} ReadOptions
 *   `headerOnly`: only what the header says, the texels not read (and their
 *   size not checked), for an image's information.
 */

/**
 * A DDS file's image.
 *
 * @param {Uint8Array} bytes @param {ReadOptions} options
 * @returns {DxgiImage}
 */
function readDds(bytes, options){
    if (bytes.length < HEADER_BYTES)
    {
        throw new ImageError('a DDS file shorter than its header');
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const flags = view.getUint32(8, true);
    const extended = (view.getUint32(80, true) & PF.FOURCC) !== 0
        && view.getUint32(84, true) === FOURCC_DX10;
    const width = Math.max(1, view.getUint32(16, true));
    const fileHeight = Math.max(1, view.getUint32(12, true));
    const mipLevels = Math.max(1, view.getUint32(28, true));
    const depth = (flags & DDS_DEPTH) ? Math.max(1, view.getUint32(24, true)) : 1;
    /** @type {Source} */
    let source;
    let dimension;
    let cube = false;
    let arraySize = 1;
    let at = HEADER_BYTES;
    if (extended)
    {
        if (bytes.length < DX10_BYTES)
        {
            throw new ImageError('a DDS file shorter than its DX10 header');
        }
        const [dxgi, resource, misc, slices, misc2] = [0, 4, 8, 12, 16].map(offset=>
            view.getUint32(HEADER_BYTES + offset, true));
        if (misc2 !== 0)
        {
            throw new ImageError(`a DX10 DDS header with misc_flags2 ${misc2}`);
        }
        if (REFUSED_DXGI.has(dxgi) || (BC6_7.has(dxgi) && !options.bc6and7)
            || !dxgiLayout(dxgi, 1, 1))
        {
            throw new ImageError(`a DX10 DDS of DXGI format ${dxgi}, which D3DX does not read`);
        }
        source = { dxgi, bytes: 0, convert: null };
        dimension = resource;
        cube = (misc & MISC_TEXTURECUBE) !== 0;
        arraySize = Math.max(1, slices) * (cube ? 6 : 1);
        at = DX10_BYTES;
    }
    else
    {
        source = classicSource(new DataView(bytes.buffer, bytes.byteOffset + 76, 32));
        const caps2 = view.getUint32(112, true);
        dimension = (flags & DDS_DEPTH) ? DIMENSION.TEXTURE3D : DIMENSION.TEXTURE2D;
        if (dimension === DIMENSION.TEXTURE2D && (caps2 & DDSCAPS2_CUBEMAP))
        {
            if ((caps2 & DDSCAPS2_ALL_FACES) !== DDSCAPS2_ALL_FACES)
            {
                throw new ImageError('a cube map without all six faces');
            }
            cube = true;
            arraySize = 6;
        }
    }
    const height = dimension === DIMENSION.TEXTURE1D ? 1 : fileHeight;
    const image = { fileFormat: IFF10.DDS, width, height, depth, format: 0, mipLevels,
        dxgi: source.dxgi, dimension, cube, arraySize, converted: source.convert !== null };
    /** A level's bytes in the file. @param {number} w @param {number} h */
    const levelBytes = (w, h)=>{
        if (source.bytes)
        {
            return w * h * source.bytes;
        }
        const layout = /** @type {{ rowBytes: number, rows: number }} */ (
            dxgiLayout(source.dxgi, w, h));
        return layout.rowBytes * layout.rows;
    };
    if (options.headerOnly)
    {
        // Where the file's texels end: what a reader of it reads, whatever size
        // it is said to be.
        let extent = at + (source.palette ? PALETTE_BYTES : 0);
        for (let level = 0; level < mipLevels; level++)
        {
            extent += levelBytes(Math.max(1, width >> level), Math.max(1, height >> level))
                * (dimension === DIMENSION.TEXTURE3D ? Math.max(1, depth >> level) : arraySize);
        }
        return { ...image, levels: [], extent };
    }
    /** @type {Uint8Array | null} */
    let palette = null;
    if (source.palette)
    {
        if (at + PALETTE_BYTES > bytes.length)
        {
            throw new ImageError('a palette-indexed DDS file cut short of its palette');
        }
        palette = bytes.subarray(at, at + PALETTE_BYTES);
        at += PALETTE_BYTES;
    }
    /** One level of `w` by `h` texels from the file. @param {number} w @param {number} h */
    const take = (w, h)=>{
        const size = levelBytes(w, h);
        if (at + size > bytes.length)
        {
            throw new ImageError('a DDS file cut short of its texels');
        }
        const data = bytes.subarray(at, at + size);
        at += size;
        return { width: w, height: h, format: 0, dxgi: source.dxgi,
            data: source.convert ? source.convert(data, w * h, palette) : data };
    };
    if (dimension === DIMENSION.TEXTURE3D)
    {
        /** @type {DxgiLevel[][]} */
        const volume = [];
        for (let level = 0; level < mipLevels; level++)
        {
            const w = Math.max(1, width >> level);
            const h = Math.max(1, height >> level);
            volume.push(Array.from({ length: Math.max(1, depth >> level) }, ()=>take(w, h)));
        }
        return { ...image, levels: [], volume };
    }
    /** @type {DxgiLevel[][]} */
    const slices = [];
    for (let slice = 0; slice < arraySize; slice++)
    {
        slices.push(Array.from({ length: mipLevels }, (_, level)=>take(
            Math.max(1, width >> level), Math.max(1, height >> level))));
    }
    return { ...image, levels: slices[0], ...(arraySize > 1 ? { faces: slices } : {}) };
}

/**
 * A picture of `width` by `height` R8G8B8A8 texels as a one-level image.
 *
 * @param {number} fileFormat @param {number} width @param {number} height
 * @param {Uint8Array} rgba
 * @returns {DxgiImage}
 */
const picture = (fileFormat, width, height, rgba)=>({ fileFormat, width, height, depth: 1,
    format: 0, mipLevels: 1, dxgi: DXGI.R8G8B8A8_UNORM, dimension: DIMENSION.TEXTURE2D,
    cube: false, arraySize: 1, converted: true,
    levels: [{ width, height, format: 0, dxgi: DXGI.R8G8B8A8_UNORM, data: rgba }] });

/** BGRA texels as RGBA. @param {Uint8Array} bgra */
const rgbaOf = bgra=>{
    const out = new Uint8Array(bgra.length);
    for (let i = 0; i < bgra.length; i += 4)
    {
        out[i] = bgra[i + 2];
        out[i + 1] = bgra[i + 1];
        out[i + 2] = bgra[i];
        out[i + 3] = bgra[i + 3];
    }
    return out;
};

/** @param {Uint8Array} bytes */
const isWmp = bytes=>bytes.length >= 4 && bytes[0] === 0x49 && bytes[1] === 0x49
    && bytes[2] === 0xbc;

/**
 * An image file as D3DX 10 and 11 read it.
 *
 * @param {Uint8Array} bytes @param {ReadOptions} [options]
 * @returns {DxgiImage}
 */
export function readImage10(bytes, options = {}){
    if (bytes.length >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4)
        .getUint32(0, true) === DDS_MAGIC)
    {
        return readDds(bytes, options);
    }
    if (isGif(bytes))
    {
        try
        {
            const { width, height, rgba } = decodeGif(bytes);
            return picture(IFF10.GIF, width, height, rgba);
        }
        catch (e){
            throw e instanceof GifError ? new ImageError(e.message) : e;
        }
    }
    if (isWmp(bytes))
    {
        throw new NotRead('a JPEG XR (HD Photo) file, which this loader does not decode');
    }
    if (isTiff(bytes))
    {
        try
        {
            const { width, height, rgba } = decodeTiff(bytes);
            return picture(IFF10.TIFF, width, height, rgba);
        }
        catch (e){
            throw e instanceof TiffError ? new NotRead(e.message) : e;
        }
    }
    if (bytes.length >= 6 && bytes[0] === 0x42 && bytes[1] === 0x4d)
    {
        const size = new DataView(bytes.buffer, bytes.byteOffset, 6).getUint32(2, true);
        if (size > bytes.length)
        {
            throw new ImageError(`a bitmap of ${size} bytes in ${bytes.length}`);
        }
    }
    const image = readImage(bytes);
    if (image.fileFormat === IFF.TGA || image.fileFormat === IFF.DDS)
    {
        throw new ImageError('not an image file D3DX 10 reads');
    }
    const [top] = image.levels;
    return picture(image.fileFormat, image.width, image.height, rgbaOf(top.data));
}
