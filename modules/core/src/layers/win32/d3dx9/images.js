/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { FMT, decodeTexels, isCompressed, isSupported, layoutOf } from './pixels.js';
import { PngError, isPng, readPng } from './png.js';
import { decodeJpeg } from '../../media/internal/jpeg.js';

/**
 * The image files D3DX's texture loaders read, from the files' own
 * specifications: DDS (the DDS_HEADER and DDS_PIXELFORMAT of the DirectX
 * documentation), Truevision TGA 2.0, and the Windows bitmap
 * (BITMAPFILEHEADER and BITMAPINFOHEADER, BITMAPCOREHEADER, with BI_BITFIELDS),
 * PNG (`png.js`) and JPEG (the media layer's decoder).
 */

/** D3DXIMAGE_FILEFORMAT. */
export const IFF = Object.freeze({ BMP: 0, JPG: 1, TGA: 2, PNG: 3, DDS: 4 });

/**
 * @typedef {Object} Level
 * @property {number} width
 * @property {number} height
 * @property {number} format   The D3DFORMAT `data` is in.
 * @property {Uint8Array} data  Rows packed, as layoutOf gives them.
 */

/**
 * @typedef {Object} Image
 * @property {number} fileFormat   IFF.
 * @property {number} width
 * @property {number} height
 * @property {number} format       The D3DFORMAT the file holds its texels in (D3DXIMAGE_INFO's).
 * @property {number} mipLevels    Levels the file holds.
 * @property {Level[]} levels      Largest first; uncompressed ones already in the working form.
 * @property {Level[][]} [faces]   A cube map's six faces, +X, -X, +Y, -Y, +Z, -Z, each its
 *                                 levels as `levels` holds them; `levels` is the first face's.
 * @property {number} [depth]      A volume's slices: the volume is described, not read, and
 *                                 `levels` is empty.
 */

/** An image this module cannot read: D3DXERR_INVALIDDATA, with the reason. */
export class ImageError extends Error {}

/**
 * Reads an image file.
 *
 * @param {Uint8Array} bytes
 * @returns {Image}
 */
export function readImage(bytes){
    const text = String.fromCharCode(...bytes.subarray(0, 4));
    if (text === 'DDS ')
    {
        return readDds(bytes);
    }
    if (text.startsWith('BM'))
    {
        return readBmp(bytes);
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8)
    {
        return readJpeg(bytes);
    }
    if (isPng(bytes))
    {
        try
        {
            const { width, height, format, bgra } = readPng(bytes);
            return { fileFormat: IFF.PNG, width, height, format, mipLevels: 1,
                levels: [{ width, height, format: FMT.A8R8G8B8, data: bgra }] };
        }
        catch (e){
            if (e instanceof PngError)
            {
                throw new ImageError(e.message);
            }
            throw e;
        }
    }
    // TGA has no signature; its header is the test.
    return readTga(bytes);
}

/**
 * A JPEG, through the media layer's decoder (baseline and progressive), its
 * components made colour the way the JFIF and Adobe conventions say: three
 * are YCbCr unless an Adobe marker says they were not transformed, four are
 * Adobe's inverted CMYK, or YCCK when its transform flag is 2. The format
 * D3DXIMAGE_INFO names is what Windows' imaging component decodes into: L8
 * for grey, R8G8B8 for the rest.
 *
 * @param {Uint8Array} bytes
 * @returns {Image}
 */
function readJpeg(bytes){
    let image;
    try
    {
        image = decodeJpeg(bytes);
    }
    catch (e){
        throw new ImageError(`a JPEG this decoder cannot read: ${/** @type {Error} */ (e).message}`);
    }
    const { width, height, components: n, samples } = image;
    const clamp = (/** @type {number} */ v)=>Math.max(0, Math.min(255, Math.round(v)));
    const ycc = n === 3 ? !image.adobe || image.transform === 1 : n === 4 && image.transform === 2;
    const bgra = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++)
    {
        const at = i * n;
        let r;
        let g;
        let b;
        if (n === 1 || n === 2)
        {
            r = g = b = samples[at];
        }
        else if (ycc)
        {
            const y = samples[at];
            const cb = samples[at + 1] - 128;
            const cr = samples[at + 2] - 128;
            r = clamp(y + 1.402 * cr);
            g = clamp(y - 0.344136 * cb - 0.714136 * cr);
            b = clamp(y + 1.772 * cb);
        }
        else
        {
            r = samples[at];
            g = samples[at + 1];
            b = samples[at + 2];
        }
        if (n === 4)
        {
            // Adobe writes CMYK inverted: each byte is 255 less the ink, so the
            // colour is the ink's complement scaled by K's.
            const k = samples[at + 3];
            if (ycc)
            {
                r = 255 - r;
                g = 255 - g;
                b = 255 - b;
            }
            r = clamp(r * k / 255);
            g = clamp(g * k / 255);
            b = clamp(b * k / 255);
        }
        bgra[i * 4] = b;
        bgra[i * 4 + 1] = g;
        bgra[i * 4 + 2] = r;
        bgra[i * 4 + 3] = 255;
    }
    return { fileFormat: IFF.JPG, width, height, format: n === 1 ? FMT.L8 : FMT.R8G8B8,
        mipLevels: 1, levels: [{ width, height, format: FMT.A8R8G8B8, data: bgra }] };
}

/**
 * A bitmap as an RT_BITMAP resource holds it -- its BITMAPINFOHEADER or
 * BITMAPCOREHEADER, colour table and bits, with no file header -- made the
 * file it would be on disk, whose header says where the bits start: after the
 * info header, the three masks a 40-byte header with BI_BITFIELDS has, and the
 * colour table (biClrUsed entries, or all 2^bits of a palette that names none).
 *
 * @param {Uint8Array} dib
 * @returns {Uint8Array}
 */
export function bitmapFile(dib){
    const view = viewOf(dib);
    const headerSize = dib.length >= 4 ? view.getUint32(0, true) : 0;
    const core = headerSize === 12;
    if ((!core && headerSize < 40) || dib.length < headerSize)
    {
        throw new ImageError('a bitmap resource shorter than its header');
    }
    const bits = view.getUint16(core ? 10 : 14, true);
    const compression = core ? 0 : view.getUint32(16, true);
    const used = core ? 0 : view.getUint32(32, true);
    const colours = bits <= 8 ? used || 1 << bits : used;
    const offset = 14 + headerSize + (compression === 3 && headerSize === 40 ? 12 : 0)
        + colours * (core ? 3 : 4);
    const file = new Uint8Array(14 + dib.length);
    const header = new DataView(file.buffer);
    file.set([0x42, 0x4d]);
    header.setUint32(2, file.length, true);
    header.setUint32(10, offset, true);
    file.set(dib, 14);
    return file;
}

/** @param {Uint8Array} bytes */
const viewOf = bytes=>new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** DDS_HEADER's dwCaps2: a cube map, and the bits of its six faces. */
const DDSCAPS2_CUBEMAP = 0x200;
const DDSCAPS2_ALL_FACES = 0xfc00;

/** DDS_PIXELFORMAT flags. */
const DDPF = { ALPHAPIXELS: 0x1, ALPHA: 0x2, FOURCC: 0x4, PALETTEINDEXED8: 0x20, RGB: 0x40,
    LUMINANCE: 0x20000 };
/** A palette-indexed DDS: 256 PALETTEENTRY (r, g, b, alpha in peFlags) after the header. */
const DDS_PALETTE_BYTES = 256 * 4;

/**
 * @param {DataView} view  At the pixel format.
 * @returns {number} the D3DFORMAT, or 0
 */
function ddsFormat(view){
    const flags = view.getUint32(4, true);
    const fourCC = view.getUint32(8, true);
    const bits = view.getUint32(12, true);
    const [r, g, b, a] = [16, 20, 24, 28].map(at=>view.getUint32(at, true));
    if (flags & DDPF.FOURCC)
    {
        // A FourCC field also carries a D3DFORMAT number for the formats FourCC has no name for.
        return fourCC;
    }
    const masks = (/** @type {number[]} */ m)=>r === m[0] && g === m[1] && b === m[2]
        && (a === (m[3] ?? 0));
    if (flags & DDPF.RGB)
    {
        if (bits === 32)
        {
            if (masks([0xff0000, 0xff00, 0xff, 0xff000000]))
            {
                return (flags & DDPF.ALPHAPIXELS) ? FMT.A8R8G8B8 : FMT.X8R8G8B8;
            }
            if (masks([0xff0000, 0xff00, 0xff]))
            {
                return FMT.X8R8G8B8;
            }
            if (masks([0xff, 0xff00, 0xff0000, 0xff000000]))
            {
                return (flags & DDPF.ALPHAPIXELS) ? FMT.A8B8G8R8 : FMT.X8B8G8R8;
            }
            if (masks([0xff, 0xff00, 0xff0000]))
            {
                return FMT.X8B8G8R8;
            }
        }
        if (bits === 24 && masks([0xff0000, 0xff00, 0xff]))
        {
            return FMT.R8G8B8;
        }
        if (bits === 16)
        {
            if (masks([0xf800, 0x7e0, 0x1f]))
            {
                return FMT.R5G6B5;
            }
            if (masks([0x7c00, 0x3e0, 0x1f, 0x8000]))
            {
                return (flags & DDPF.ALPHAPIXELS) ? FMT.A1R5G5B5 : FMT.X1R5G5B5;
            }
            if (masks([0x7c00, 0x3e0, 0x1f]))
            {
                return FMT.X1R5G5B5;
            }
            if (masks([0xf00, 0xf0, 0xf, 0xf000]))
            {
                return (flags & DDPF.ALPHAPIXELS) ? FMT.A4R4G4B4 : FMT.X4R4G4B4;
            }
            if (masks([0xf00, 0xf0, 0xf]))
            {
                return FMT.X4R4G4B4;
            }
        }
    }
    if ((flags & DDPF.LUMINANCE) && bits === 8)
    {
        return FMT.L8;
    }
    if ((flags & DDPF.LUMINANCE) && bits === 16 && (flags & DDPF.ALPHAPIXELS))
    {
        return FMT.A8L8;
    }
    if ((flags & DDPF.ALPHA) && bits === 8)
    {
        return FMT.A8;
    }
    if ((flags & DDPF.PALETTEINDEXED8) && bits === 8)
    {
        return FMT.P8;
    }
    return 0;
}

/** @param {Uint8Array} bytes @returns {Image} */
function readDds(bytes){
    if (bytes.length < 128)
    {
        throw new ImageError('a DDS file shorter than its header');
    }
    const view = viewOf(bytes);
    const height = view.getUint32(12, true);
    const width = view.getUint32(16, true);
    const flags = view.getUint32(8, true);
    const mipCount = (flags & 0x20000) ? Math.max(1, view.getUint32(28, true)) : 1;
    const caps2 = view.getUint32(112, true);
    const cube = (caps2 & DDSCAPS2_CUBEMAP) !== 0;
    if (cube && (caps2 & DDSCAPS2_ALL_FACES) !== DDSCAPS2_ALL_FACES)
    {
        // A face left out would be a face of nothing; D3DX's cube textures have six.
        throw new ImageError('a cube map without all six faces');
    }
    const depth = (caps2 & 0x200000) ? view.getUint32(24, true) : 0;
    const format = ddsFormat(new DataView(bytes.buffer, bytes.byteOffset + 76, 32));
    if (format === 0 || format === 0x30315844 /* DX10 */)
    {
        throw new ImageError('a DDS pixel format this loader does not know');
    }
    if (depth > 1)
    {
        // What D3DXGetImageInfo answers of one -- its depth and that it is a
        // volume -- is in the header; no loader here makes a volume texture.
        return { fileFormat: IFF.DDS, width, height, depth, format, mipLevels: mipCount,
            levels: [] };
    }
    const indexed = format === FMT.P8;
    if (!indexed && !isSupported(format))
    {
        throw new ImageError(`a DDS of format ${format}: not read yet`);
    }
    if (indexed && bytes.length < 128 + DDS_PALETTE_BYTES)
    {
        throw new ImageError('a palette-indexed DDS file cut short of its palette');
    }
    const palette = indexed ? bytes.subarray(128, 128 + DDS_PALETTE_BYTES) : null;
    /**
     * A level of indices through the palette, whose fourth byte Direct3D reads as the
     * entry's alpha (IDirect3DDevice9::SetPaletteEntries).
     *
     * @param {Uint8Array} data @returns {Uint8Array}
     */
    const throughPalette = data=>{
        const out = new Uint8Array(data.length * 4);
        const entries = /** @type {Uint8Array} */ (palette);
        data.forEach((index, i)=>{
            out[i * 4] = entries[index * 4 + 2];
            out[i * 4 + 1] = entries[index * 4 + 1];
            out[i * 4 + 2] = entries[index * 4];
            out[i * 4 + 3] = entries[index * 4 + 3];
        });
        return out;
    };
    /** @type {Level[][]} */
    const faces = [];
    let at = indexed ? 128 + DDS_PALETTE_BYTES : 128;
    for (let face = 0; face < (cube ? 6 : 1); face++)
    {
        /** @type {Level[]} */
        const levels = [];
        for (let level = 0; level < mipCount; level++)
        {
            const w = Math.max(1, width >> level);
            const h = Math.max(1, height >> level);
            const layout = indexed ? { rowBytes: w, rows: h } : layoutOf(format, w, h);
            const size = layout.rowBytes * layout.rows;
            if (at + size > bytes.length)
            {
                // A face's levels follow the one before's whole chain, so a cube
                // map cut anywhere has its later faces at unknown places.
                if (level === 0 || cube)
                {
                    throw new ImageError('a DDS file cut short');
                }
                break;
            }
            const data = bytes.subarray(at, at + size);
            levels.push(isCompressed(format)
                ? { width: w, height: h, format, data }
                : { width: w, height: h, format: FMT.A8R8G8B8,
                    data: indexed ? throughPalette(data) : decodeTexels(format, data, w, h) });
            at += size;
        }
        faces.push(levels);
    }
    return { fileFormat: IFF.DDS, width, height, format, mipLevels: mipCount,
        levels: faces[0], ...(cube ? { faces } : {}) };
}

/** @param {Uint8Array} bytes @returns {Image} */
function readTga(bytes){
    if (bytes.length < 18)
    {
        throw new ImageError('not an image file D3DX reads');
    }
    const view = viewOf(bytes);
    const idLength = bytes[0];
    const mapType = bytes[1];
    const type = bytes[2];
    const mapFirst = view.getUint16(3, true);
    const mapLength = view.getUint16(5, true);
    const mapBits = bytes[7];
    const width = view.getUint16(12, true);
    const height = view.getUint16(14, true);
    const depth = bytes[16];
    const descriptor = bytes[17];
    const base = type & ~8;
    if (![1, 2, 3].includes(base) || mapType > 1 || width === 0 || height === 0
        || (base === 1 && (mapType !== 1 || depth !== 8))
        || (base === 2 && ![15, 16, 24, 32].includes(depth))
        || (base === 3 && depth !== 8))
    {
        throw new ImageError('not an image file D3DX reads');
    }
    let at = 18 + idLength;
    const mapEntry = Math.ceil(mapBits / 8);
    const map = bytes.subarray(at, at + mapLength * mapEntry);
    at += mapType ? mapLength * mapEntry : 0;
    const pixelBytes = Math.ceil(depth / 8);
    // The file's texels in order, the run-length packets undone.
    const count = width * height;
    let raw;
    if (type & 8)
    {
        raw = new Uint8Array(count * pixelBytes);
        let written = 0;
        while (written < count && at < bytes.length)
        {
            const packet = bytes[at++];
            const run = (packet & 0x7f) + 1;
            if (packet & 0x80)
            {
                const texel = bytes.subarray(at, at + pixelBytes);
                at += pixelBytes;
                for (let k = 0; k < run && written < count; k++)
                {
                    raw.set(texel, written++ * pixelBytes);
                }
            }
            else
            {
                const n = Math.min(run, count - written);
                raw.set(bytes.subarray(at, at + n * pixelBytes), written * pixelBytes);
                at += run * pixelBytes;
                written += n;
            }
        }
    }
    else
    {
        if (at + count * pixelBytes > bytes.length)
        {
            throw new ImageError('a TGA file cut short');
        }
        raw = bytes.subarray(at, at + count * pixelBytes);
    }
    /** @param {Uint8Array} entry @param {number} bits @returns {number[]} b, g, r, a */
    const colour = (entry, bits)=>{
        if (bits === 15 || bits === 16)
        {
            const v = entry[0] | entry[1] << 8;
            return [(v & 31) * 255 / 31, (v >> 5 & 31) * 255 / 31, (v >> 10 & 31) * 255 / 31,
                bits === 16 && !(v & 0x8000) && (descriptor & 15) ? 0 : 255].map(Math.round);
        }
        return [entry[0], entry[1], entry[2], bits === 32 ? entry[3] : 255];
    };
    const bgra = new Uint8Array(count * 4);
    const topDown = (descriptor & 0x20) !== 0;
    const rightToLeft = (descriptor & 0x10) !== 0;
    for (let i = 0; i < count; i++)
    {
        const fx = i % width;
        const fy = Math.floor(i / width);
        const x = rightToLeft ? width - 1 - fx : fx;
        const y = topDown ? fy : height - 1 - fy;
        let texel;
        if (base === 3)
        {
            texel = [raw[i], raw[i], raw[i], 255];
        }
        else if (base === 1)
        {
            const index = raw[i] - mapFirst;
            texel = colour(map.subarray(index * mapEntry, index * mapEntry + mapEntry), mapBits);
        }
        else
        {
            texel = colour(raw.subarray(i * pixelBytes, i * pixelBytes + pixelBytes), depth);
        }
        bgra.set(texel, (y * width + x) * 4);
    }
    const alpha = (descriptor & 15) > 0;
    const format = base === 3 ? FMT.L8 : base === 1 ? FMT.P8
        : depth === 32 ? (alpha ? FMT.A8R8G8B8 : FMT.X8R8G8B8)
            : depth === 24 ? FMT.R8G8B8 : alpha && depth === 16 ? FMT.A1R5G5B5 : FMT.X1R5G5B5;
    return { fileFormat: IFF.TGA, width, height, format, mipLevels: 1,
        levels: [{ width, height, format: FMT.A8R8G8B8, data: bgra }] };
}

/** @param {Uint8Array} bytes @returns {Image} */
function readBmp(bytes){
    const view = viewOf(bytes);
    const dataAt = view.getUint32(10, true);
    const headerSize = view.getUint32(14, true);
    const core = headerSize === 12;
    const width = core ? view.getUint16(18, true) : view.getInt32(18, true);
    const signedHeight = core ? view.getInt16(20, true) : view.getInt32(22, true);
    const bits = view.getUint16(core ? 24 : 28, true);
    const compression = core ? 0 : view.getUint32(30, true);
    const height = Math.abs(signedHeight);
    if (width <= 0 || height === 0 || ![1, 4, 8, 16, 24, 32].includes(bits)
        || ![0, 3].includes(compression))
    {
        throw new ImageError(`a bitmap D3DX's loader here does not read (${bits} bits, `
            + `compression ${compression})`);
    }
    const paletteAt = 14 + headerSize + (compression === 3 && headerSize === 40 ? 12 : 0);
    const entry = core ? 3 : 4;
    const colours = core ? 1 << bits : (view.getUint32(46, true) || 1 << bits);
    let masks = bits === 16 ? [0x7c00, 0x3e0, 0x1f, 0] : [0xff0000, 0xff00, 0xff, 0];
    if (compression === 3)
    {
        // After a 40-byte header, or inside a V4 or V5 one at the same place.
        const at = 14 + 40;
        masks = [view.getUint32(at, true), view.getUint32(at + 4, true),
            view.getUint32(at + 8, true), headerSize >= 56 ? view.getUint32(at + 12, true) : 0];
    }
    /** @param {number} value @param {number} mask */
    const channel = (value, mask)=>{
        if (mask === 0)
        {
            return 255;
        }
        const shift = Math.clz32(0) - Math.clz32(mask & -mask) - 1;
        const top = mask >>> shift;
        return Math.round(((value & mask) >>> shift) * 255 / top);
    };
    const stride = Math.ceil(width * bits / 32) * 4;
    const bgra = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++)
    {
        const y = signedHeight > 0 ? height - 1 - row : row;
        const line = dataAt + row * stride;
        if (line + Math.ceil(width * bits / 8) > bytes.length)
        {
            throw new ImageError('a bitmap cut short');
        }
        for (let x = 0; x < width; x++)
        {
            let texel;
            if (bits <= 8)
            {
                const byte = bytes[line + Math.floor(x * bits / 8)];
                const index = byte >> (8 - bits - (x * bits) % 8) & ((1 << bits) - 1);
                const p = paletteAt + Math.min(index, colours - 1) * entry;
                texel = [bytes[p], bytes[p + 1], bytes[p + 2], 255];
            }
            else if (bits === 24)
            {
                const p = line + x * 3;
                texel = [bytes[p], bytes[p + 1], bytes[p + 2], 255];
            }
            else
            {
                const value = bits === 16 ? view.getUint16(line + x * 2, true)
                    : view.getUint32(line + x * 4, true);
                texel = [channel(value, masks[2]), channel(value, masks[1]),
                    channel(value, masks[0]), channel(value, masks[3])];
            }
            bgra.set(texel, (y * width + x) * 4);
        }
    }
    const format = bits <= 8 ? FMT.P8 : bits === 24 ? FMT.R8G8B8
        : bits === 16 ? (masks[1] === 0x7e0 ? FMT.R5G6B5 : FMT.X1R5G5B5)
            : masks[3] ? FMT.A8R8G8B8 : FMT.X8R8G8B8;
    return { fileFormat: IFF.BMP, width, height, format, mipLevels: 1,
        levels: [{ width, height, format: FMT.A8R8G8B8, data: bgra }] };
}
