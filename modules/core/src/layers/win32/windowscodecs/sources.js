/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What every IWICBitmapSource is to the rest of WIC: a size, a pixel format,
 * a resolution, perhaps a palette, and the packed rows of any rectangle of
 * it. Decoded frames, bitmaps and the transforms over them (converter,
 * scaler, clipper, flip-rotator) are sources here; a source the program
 * wrote itself is reached through its vtable, as Windows reaches it, so a
 * transform over it pulls only the rectangles it is asked for.
 *
 * Errors are CodecErrors carrying the HRESULT the caller is answered with.
 */

import { readGuid } from '../ole32/guid.js';
import { CodecError, WINCODEC, cropRows } from './frames.js';
import { convertRow, converts, formatOf, rowBytes } from './formats.js';
import { GUID } from './layout.js';

const E_INVALIDARG = 0x80070057 | 0;

/** @typedef {import('./formats.js').PixelFormat} PixelFormat */
/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */

/**
 * @typedef {Object} Description
 * @property {number} width
 * @property {number} height
 * @property {string} format  the pixel format's GUID, braced
 * @property {number} dpiX
 * @property {number} dpiY
 */

/**
 * @typedef {Object} Source
 * @property {(thread: unknown) => Promise<Description>} describe
 * @property {(thread: unknown) => Promise<number[] | null>} palette  null: none to give
 * @property {(thread: unknown, rect: Rect) => Promise<Uint8Array>} copy
 *     the rectangle's rows, each rowBytes(format, rect.width), packed
 */

/**
 * What a source over guest objects needs: guest memory, a heap block to hand
 * a guest method, and the call.
 *
 * @typedef {Object} GuestAccess
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => void }} heap
 * @property {(thread: unknown, pointer: number, slot: number, args: number[]) => Promise<number>}
 *     method  a vtable slot of a guest object, its HRESULT
 */

/** @param {GuestAccess} access @param {number} at */
const u32 = (access, at)=>new DataView(access.readMemory(at >>> 0, 4).buffer).getUint32(0, true);

/**
 * Runs `use` with a zeroed heap block of `bytes`, freed after.
 *
 * @template T
 * @param {GuestAccess} access @param {number} bytes @param {(at: number) => Promise<T>} use
 * @returns {Promise<T>}
 */
export async function withBlock(access, bytes, use){
    const at = access.heap.allocate(Math.max(4, bytes)) >>> 0;
    if (at === 0)
    {
        throw new CodecError(0x8007000e | 0, 'no memory for a block a guest method fills');
    }
    access.writeMemory(at, new Uint8Array(Math.max(4, bytes)));
    try
    {
        return await use(at);
    }
    finally
    {
        access.heap.free(at);
    }
}

/** @param {number} hr @param {string} what */
const check = (hr, what)=>{
    if ((hr | 0) < 0)
    {
        throw new CodecError(hr | 0, `${what} answered ${(hr >>> 0).toString(16)}`);
    }
};

/**
 * A source the program implemented: IWICBitmapSource's GetSize (3),
 * GetPixelFormat (4), GetResolution (5), CopyPalette (6), CopyPixels (7).
 * Its palette comes through an IWICPalette `makePalette` publishes.
 *
 * @param {GuestAccess} access @param {number} pointer
 * @param {(thread: unknown) => Promise<{ pointer: number, colours: () => number[],
 *     done: () => void }>} makePalette
 * @returns {Source}
 */
export function guestSource(access, pointer, makePalette){
    /** @type {Source} */
    const self = {
        describe: thread=>withBlock(access, 32, async at=>{
            check(await access.method(thread, pointer, 3, [at, at + 4]), 'GetSize');
            check(await access.method(thread, pointer, 4, [at + 8]), 'GetPixelFormat');
            const width = u32(access, at);
            const height = u32(access, at + 4);
            const format = readGuid(access, at + 8);
            check(await access.method(thread, pointer, 5, [at + 8, at + 16]), 'GetResolution');
            const view = new DataView(access.readMemory(at + 8, 16).slice().buffer);
            return { width, height, format, dpiX: view.getFloat64(0, true),
                dpiY: view.getFloat64(8, true) };
        }),
        palette: async thread=>{
            const palette = await makePalette(thread);
            try
            {
                const hr = await access.method(thread, pointer, 6, [palette.pointer]);
                return hr < 0 ? null : palette.colours();
            }
            finally
            {
                palette.done();
            }
        },
        copy: async(thread, rect)=>{
            const { format } = await self.describe(thread);
            const f = formatOf(format);
            if (!f)
            {
                throw new CodecError(WINCODEC.UNSUPPORTEDPIXELFORMAT,
                    `a source of format ${format}`);
            }
            const stride = rowBytes(f, rect.width);
            const size = stride * rect.height;
            return withBlock(access, 16 + size, async at=>{
                const header = new DataView(new ArrayBuffer(16));
                [rect.x, rect.y, rect.width, rect.height].forEach((v, i)=>
                    header.setInt32(i * 4, v, true));
                access.writeMemory(at, new Uint8Array(header.buffer));
                check(await access.method(thread, pointer, 7, [at, stride, size, at + 16]),
                    'CopyPixels');
                return access.readMemory(at + 16, size).slice();
            });
        },
    };
    return self;
}

/**
 * A source over decoded or held pixels: a frame, or a bitmap whose bytes
 * `pixels` reads when asked (a bitmap's live in guest memory).
 *
 * @param {Description} description
 * @param {() => number[] | null} palette
 * @param {() => { bytes: Uint8Array, stride: number }} pixels
 * @returns {Source}
 */
export function heldSource(description, palette, pixels){
    return {
        describe: async()=>description,
        palette: async()=>palette(),
        copy: async(_, rect)=>{
            const f = /** @type {PixelFormat} */ (formatOf(description.format));
            const { bytes, stride } = pixels();
            return cropRows(bytes, stride, f.bpp, rect);
        },
    };
}

/** @param {Description} d @param {Rect | null} rect */
export function checkedRect(d, rect){
    const r = rect ?? { x: 0, y: 0, width: d.width, height: d.height };
    if (r.x < 0 || r.y < 0 || r.width < 0 || r.height < 0 || r.x + r.width > d.width
        || r.y + r.height > d.height)
    {
        throw new CodecError(E_INVALIDARG, 'a rectangle outside the source');
    }
    return r;
}

/**
 * A source's pixels in another format; to an indexed one through `palette`.
 *
 * @param {Source} source @param {PixelFormat} to @param {number[] | null} palette
 * @returns {Source}
 */
export function convertedSource(source, to, palette){
    return {
        describe: async thread=>({ ...await source.describe(thread), format: to.guid }),
        palette: async()=>(to.indexed ? palette : null),
        copy: async(thread, rect)=>{
            const d = await source.describe(thread);
            const from = /** @type {PixelFormat} */ (formatOf(d.format));
            const rows = await source.copy(thread, rect);
            if (from === to)
            {
                return rows;
            }
            const fromPalette = from.indexed ? await source.palette(thread) : null;
            const inStride = rowBytes(from, rect.width);
            const outStride = rowBytes(to, rect.width);
            const out = new Uint8Array(outStride * rect.height);
            for (let y = 0; y < rect.height; y++)
            {
                out.set(convertRow(from, to, rows.subarray(y * inStride, (y + 1) * inStride),
                    rect.width, fromPalette, palette).subarray(0, outStride), y * outStride);
            }
            return out;
        },
    };
}

/**
 * Whether a source's format is converted into `to` here, and why not.
 *
 * @param {string} fromGuid @param {string} toGuid
 * @returns {number} S_OK, or the HRESULT Initialize answers
 */
export function conversionOf(fromGuid, toGuid){
    const from = formatOf(fromGuid);
    const to = formatOf(toGuid);
    if (!to)
    {
        return WINCODEC.COMPONENTNOTFOUND;
    }
    if (!from || !converts(from, to))
    {
        return WINCODEC.UNSUPPORTEDOPERATION;
    }
    return 0;
}

/**
 * A rectangle of a source.
 *
 * @param {Source} source @param {Rect} clip
 * @returns {Source}
 */
export function clippedSource(source, clip){
    return {
        describe: async thread=>({ ...await source.describe(thread), width: clip.width,
            height: clip.height }),
        palette: thread=>source.palette(thread),
        copy: (thread, rect)=>source.copy(thread, { x: clip.x + rect.x, y: clip.y + rect.y,
            width: rect.width, height: rect.height }),
    };
}

/**
 * One pixel's bits at an index of a packed row.
 *
 * @param {Uint8Array} row @param {number} bpp @param {number} index
 */
const pixelAt = (row, bpp, index)=>{
    if (bpp >= 8)
    {
        const size = bpp >> 3;
        return row.subarray(index * size, (index + 1) * size);
    }
    const bit = index * bpp;
    return Uint8Array.of((row[bit >> 3] >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1));
};

/** @param {Uint8Array} row @param {number} bpp @param {number} index @param {Uint8Array} value */
const putPixel = (row, bpp, index, value)=>{
    if (bpp >= 8)
    {
        row.set(value, index * (bpp >> 3));
        return;
    }
    const bit = index * bpp;
    row[bit >> 3] |= value[0] << (8 - bpp - (bit & 7));
};

/**
 * A source rotated by 0, 90, 180 or 270 degrees clockwise and then flipped,
 * as WICBitmapTransformOptions says (Rotate90 1, Rotate180 2, Rotate270 3,
 * FlipHorizontal 8, FlipVertical 16).
 *
 * @param {Source} source @param {number} options
 * @returns {Source}
 */
export function flippedSource(source, options){
    const turns = options & 3;
    const swap = (turns & 1) === 1;
    return {
        describe: async thread=>{
            const d = await source.describe(thread);
            return swap ? { ...d, width: d.height, height: d.width, dpiX: d.dpiY, dpiY: d.dpiX }
                : d;
        },
        palette: thread=>source.palette(thread),
        copy: async(thread, rect)=>{
            const d = await source.describe(thread);
            const f = /** @type {PixelFormat} */ (formatOf(d.format));
            const all = await source.copy(thread, { x: 0, y: 0, width: d.width, height: d.height });
            const inStride = rowBytes(f, d.width);
            const outStride = rowBytes(f, rect.width);
            const out = new Uint8Array(outStride * rect.height);
            const width = swap ? d.height : d.width;
            const height = swap ? d.width : d.height;
            for (let y = 0; y < rect.height; y++)
            {
                for (let x = 0; x < rect.width; x++)
                {
                    let u = rect.x + x;
                    let v = rect.y + y;
                    if (options & 8)
                    {
                        u = width - 1 - u;
                    }
                    if (options & 16)
                    {
                        v = height - 1 - v;
                    }
                    // Undo the rotation: the turned image's (u, v) in the source.
                    const [sx, sy] = turns === 0 ? [u, v] : turns === 1 ? [v, d.height - 1 - u]
                        : turns === 2 ? [d.width - 1 - u, d.height - 1 - v] : [d.width - 1 - v, u];
                    putPixel(out.subarray(y * outStride, (y + 1) * outStride), f.bpp, x,
                        pixelAt(all.subarray(sy * inStride, (sy + 1) * inStride), f.bpp, sx));
                }
            }
            return out;
        },
    };
}

/**
 * A source scaled to a size. Nearest neighbour (the pixel under each target
 * pixel's centre) for WICBitmapInterpolationModeNearestNeighbor, for indexed
 * formats and for formats read here not; every other mode averages the
 * source area under each target pixel, weighting the edge pixels by how much
 * of them it covers (the Fant scaler's way, used for linear and cubic too).
 *
 * @param {Source} source @param {number} width @param {number} height @param {number} mode
 * @returns {Source}
 */
export function scaledSource(source, width, height, mode){
    return {
        describe: async thread=>({ ...await source.describe(thread), width, height }),
        palette: thread=>source.palette(thread),
        copy: async(thread, rect)=>{
            const d = await source.describe(thread);
            const f = /** @type {PixelFormat} */ (formatOf(d.format));
            const all = await source.copy(thread, { x: 0, y: 0, width: d.width, height: d.height });
            const inStride = rowBytes(f, d.width);
            const outStride = rowBytes(f, rect.width);
            const out = new Uint8Array(outStride * rect.height);
            const sx = d.width / width;
            const sy = d.height / height;
            if (mode === 0 || f.indexed || !f.read || !f.write)
            {
                for (let y = 0; y < rect.height; y++)
                {
                    const from = Math.min(d.height - 1, Math.floor((rect.y + y + 0.5) * sy));
                    const row = all.subarray(from * inStride, (from + 1) * inStride);
                    for (let x = 0; x < rect.width; x++)
                    {
                        const col = Math.min(d.width - 1, Math.floor((rect.x + x + 0.5) * sx));
                        putPixel(out.subarray(y * outStride, (y + 1) * outStride), f.bpp, x,
                            pixelAt(row, f.bpp, col));
                    }
                }
                return out;
            }
            /** @type {Float64Array[]} */
            const rows = [];
            for (let y = 0; y < d.height; y++)
            {
                rows.push(f.read(all.subarray(y * inStride, (y + 1) * inStride), d.width, null));
            }
            for (let y = 0; y < rect.height; y++)
            {
                const top = (rect.y + y) * sy;
                const bottom = top + sy;
                const line = new Float64Array(rect.width * 4);
                for (let x = 0; x < rect.width; x++)
                {
                    const left = (rect.x + x) * sx;
                    const right = left + sx;
                    const sum = [0, 0, 0, 0];
                    let total = 0;
                    for (let v = Math.floor(top); v < Math.min(d.height, Math.ceil(bottom)); v++)
                    {
                        const wy = Math.min(bottom, v + 1) - Math.max(top, v);
                        for (let u = Math.floor(left); u < Math.min(d.width, Math.ceil(right)); u++)
                        {
                            const w = wy * (Math.min(right, u + 1) - Math.max(left, u));
                            const alpha = rows[v][u * 4 + 3];
                            // Colours weighed by their alpha, so a transparent
                            // pixel's colour does not bleed into its neighbours.
                            for (let c = 0; c < 3; c++)
                            {
                                sum[c] += rows[v][u * 4 + c] * w * alpha;
                            }
                            sum[3] += alpha * w;
                            total += w;
                        }
                    }
                    for (let c = 0; c < 3; c++)
                    {
                        line[x * 4 + c] = sum[3] > 0 ? sum[c] / sum[3] : 0;
                    }
                    line[x * 4 + 3] = total > 0 ? sum[3] / total : 0;
                }
                out.set(f.write(line, rect.width, f.linear, null).subarray(0, outStride),
                    y * outStride);
            }
            return out;
        },
    };
}

/**
 * The colours of every pixel of a source as BGRA bytes, for a palette made of
 * them.
 *
 * @param {Source} source @param {unknown} thread
 * @returns {Promise<Uint8Array>}
 */
export async function bgraOf(source, thread){
    const d = await source.describe(thread);
    const target = /** @type {PixelFormat} */ (formatOf(GUID.PixelFormat32bppBGRA));
    if (conversionOf(d.format, target.guid) !== 0)
    {
        throw new CodecError(WINCODEC.UNSUPPORTEDPIXELFORMAT, `a source of format ${d.format}`);
    }
    return convertedSource(source, target, null).copy(thread,
        { x: 0, y: 0, width: d.width, height: d.height });
}

export { u32 };
