/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * D3DX 10 and 11's texel work: a level of a DXGI format read into red, green,
 * blue and alpha as numbers (0 to 1 for a normalised channel, -1 to 1 for a
 * signed one, the float a float channel holds), made another size by one of
 * D3DX's filters, and written in another format.
 *
 * The filters are as Wine's d3dx11 tests measured them on Windows: POINT
 * takes the texel a 16.16 fixed-point step lands on; LINEAR samples between
 * the four (eight) nearest texels around each texel's centre, wrapping at the
 * edges unless a MIRROR flag says mirror; BOX averages two by two (by two)
 * where the size halves exactly and is a power of two, and is LINEAR where it
 * halves otherwise and TRIANGLE elsewhere; NONE copies what overlaps and
 * leaves the rest transparent black. TRIANGLE here is a tent as wide as the
 * scale: Windows' own differs from it in the last bits (decision A236).
 * SRGB_IN reads the source as sRGB and SRGB_OUT writes the result as sRGB, a
 * format of the _SRGB kind asking the same; both together change nothing.
 * The curve is the power 2.2 that D3DX uses (the tests' numbers), not the
 * piecewise sRGB one.
 */

import { FMT, decodeAlphaBlock, decodeTexels, encodeAlphaBlock, encodeTexels }
    from '../d3dx9/pixels.js';

/** D3DX10_FILTER_FLAG (D3DX11's are the same numbers). */
export const FILTER = Object.freeze({ NONE: 1, POINT: 2, LINEAR: 3, TRIANGLE: 4, BOX: 5,
    MIRROR_U: 0x10000, MIRROR_V: 0x20000, MIRROR_W: 0x40000, DITHER: 0x80000,
    DITHER_DIFFUSION: 0x100000, SRGB_IN: 0x200000, SRGB_OUT: 0x400000 });

/** Whether a filter is one D3DX takes: a kind from NONE to BOX, and only its flags. @param {number} filter */
export const validFilter = filter=>(filter & ~0x7f0007) === 0 && (filter & 7) >= FILTER.NONE
    && (filter & 7) <= FILTER.BOX;

/**
 * A channel of a texel: which of red, green, blue, alpha it is (-1 for one
 * kept but not read, written as 1), how it is held, its bits, and where.
 *
 * @typedef {{ to: number, kind: 'u' | 's' | 'f', bits: number, at: number }} Channel
 *   `at`: the byte of the texel it starts at, or for a packed format the bit
 *   of the texel's word
 */

/**
 * @typedef {Object} Layout
 * @property {number} bytes   a texel's
 * @property {boolean} packed whether the channels are bit fields of one word
 * @property {Channel[]} channels
 * @property {boolean} [srgb]
 */

/** @param {'u' | 's' | 'f'} kind @param {number} bits @param {number[]} order @returns {Layout} */
const components = (kind, bits, order)=>({ bytes: order.length * bits / 8, packed: false,
    channels: order.map((to, i)=>({ to, kind, bits, at: i * bits / 8 })) });

/** @param {[number, number][]} fields  [channel, bits] from bit 0 up @param {number} bytes @returns {Layout} */
const packed = (fields, bytes)=>{
    let at = 0;
    return { bytes, packed: true, channels: fields.map(([to, bits])=>{
        const channel = { to, kind: /** @type {'u'} */ ('u'), bits, at };
        at += bits;
        return channel;
    }) };
};

/** @param {Layout} layout @returns {Layout} */
const srgb = layout=>({ ...layout, srgb: true });

const RGBA = [0, 1, 2, 3];

/** @type {Map<number, Layout>} */
const LAYOUTS = new Map([
    [1, components('f', 32, RGBA)], [2, components('f', 32, RGBA)],
    [5, components('f', 32, [0, 1, 2])], [6, components('f', 32, [0, 1, 2])],
    [9, components('f', 16, RGBA)], [10, components('f', 16, RGBA)],
    [11, components('u', 16, RGBA)], [13, components('s', 16, RGBA)],
    [15, components('f', 32, [0, 1])], [16, components('f', 32, [0, 1])],
    [23, packed([[0, 10], [1, 10], [2, 10], [3, 2]], 4)],
    [24, packed([[0, 10], [1, 10], [2, 10], [3, 2]], 4)],
    [27, components('u', 8, RGBA)], [28, components('u', 8, RGBA)],
    [29, srgb(components('u', 8, RGBA))], [31, components('s', 8, RGBA)],
    [33, components('f', 16, [0, 1])], [34, components('f', 16, [0, 1])],
    [35, components('u', 16, [0, 1])], [37, components('s', 16, [0, 1])],
    [39, components('f', 32, [0])], [41, components('f', 32, [0])],
    [48, components('u', 8, [0, 1])], [49, components('u', 8, [0, 1])],
    [51, components('s', 8, [0, 1])], [54, components('f', 16, [0])],
    [53, components('u', 16, [0])], [56, components('u', 16, [0])],
    [58, components('s', 16, [0])], [60, components('u', 8, [0])], [61, components('u', 8, [0])],
    [63, components('s', 8, [0])], [65, components('u', 8, [3])],
    [85, packed([[2, 5], [1, 6], [0, 5]], 2)], [86, packed([[2, 5], [1, 5], [0, 5], [3, 1]], 2)],
    [87, components('u', 8, [2, 1, 0, 3])], [88, components('u', 8, [2, 1, 0, -1])],
    [90, components('u', 8, [2, 1, 0, 3])], [91, srgb(components('u', 8, [2, 1, 0, 3]))],
    [92, components('u', 8, [2, 1, 0, -1])], [93, srgb(components('u', 8, [2, 1, 0, -1]))],
    [115, packed([[2, 4], [1, 4], [0, 4], [3, 4]], 2)],
]);

/** BC1 to BC3 (typeless, UNORM, sRGB) as the DXTn blocks they are laid out as. */
const BLOCKS = new Map([[70, FMT.DXT1], [71, FMT.DXT1], [72, FMT.DXT1], [73, FMT.DXT3],
    [74, FMT.DXT3], [75, FMT.DXT3], [76, FMT.DXT5], [77, FMT.DXT5], [78, FMT.DXT5]]);
const SRGB_BLOCKS = new Set([72, 75, 78]);
/** BC4 and BC5 (typeless and UNORM): channels a block, each eight bytes of DXT5's alpha. */
const CHANNEL_BLOCKS = new Map([[79, 1], [80, 1], [82, 2], [83, 2]]);

/** Whether a format is laid out in 4x4 blocks. @param {number} format */
export const isBlockFormat = format=>(format >= 70 && format <= 84)
    || (format >= 94 && format <= 99);

/** Whether a format's texels are read and written here. @param {number} format */
export const hasCodec = format=>LAYOUTS.has(format) || BLOCKS.has(format)
    || CHANNEL_BLOCKS.has(format);

/** Whether a format holds sRGB colours. @param {number} format */
export const isSrgb = format=>Boolean(LAYOUTS.get(format)?.srgb) || SRGB_BLOCKS.has(format);

/**
 * BC4 or BC5 blocks as texels of a byte a channel, or texels as blocks.
 *
 * @param {Uint8Array} data @param {number} width @param {number} height
 * @param {number} channels @param {boolean} encode  texels into blocks
 * @returns {Uint8Array}
 */
export function channelBlocks(data, width, height, channels, encode){
    const across = Math.max(1, Math.ceil(width / 4));
    const down = Math.max(1, Math.ceil(height / 4));
    const out = new Uint8Array(encode ? across * down * channels * 8 : width * height * channels);
    for (let by = 0; by < down; by++)
    {
        for (let bx = 0; bx < across; bx++)
        {
            const at = (by * across + bx) * channels * 8;
            for (let c = 0; c < channels; c++)
            {
                /** Where texel k of the block is, the edges repeated past the level. */
                const texel = (/** @type {number} */ k, /** @type {boolean} */ clamp)=>{
                    const x = bx * 4 + (k & 3);
                    const y = by * 4 + (k >> 2);
                    return clamp ? (Math.min(height - 1, y) * width + Math.min(width - 1, x))
                        * channels + c : x < width && y < height ? (y * width + x) * channels + c
                        : -1;
                };
                if (encode)
                {
                    encodeAlphaBlock(Array.from({ length: 16 }, (_, k)=>data[texel(k, true)]), out,
                        at + c * 8);
                    continue;
                }
                decodeAlphaBlock(data, at + c * 8).forEach((value, k)=>{
                    const to = texel(k, false);
                    if (to >= 0)
                    {
                        out[to] = value;
                    }
                });
            }
        }
    }
    return out;
}

/** A half float's bits as a number. @param {number} bits */
function fromHalf(bits){
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = bits >> 10 & 0x1f;
    const fraction = bits & 0x3ff;
    if (exponent === 0)
    {
        return sign * fraction * 2 ** -24;
    }
    if (exponent === 0x1f)
    {
        return fraction ? NaN : sign * Infinity;
    }
    return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);

/** A number as a half float's bits, rounded to nearest even. @param {number} value */
function toHalf(value){
    F32[0] = value;
    const bits = U32[0];
    const sign = bits >>> 16 & 0x8000;
    const exponent = (bits >>> 23 & 0xff) - 127 + 15;
    const fraction = bits & 0x7fffff;
    if ((bits & 0x7fffffff) > 0x7f800000)
    {
        return sign | 0x7e00;
    }
    if (exponent >= 0x1f)
    {
        return sign | 0x7c00;
    }
    if (exponent <= 0)
    {
        if (exponent < -10)
        {
            return sign;
        }
        const mantissa = (fraction | 0x800000) >> (1 - exponent);
        return sign | (mantissa + 0xfff + (mantissa >> 13 & 1) >> 13);
    }
    return sign | ((exponent << 10 | fraction >> 13) + ((fraction & 0x1fff) > 0x1000
        || (fraction & 0x3fff) === 0x3000 ? 1 : 0));
}

/**
 * A normalised value as the integer of `bits` that holds it: rounded to the
 * nearest, a hair above half rounding up as the sums of whole texels do.
 *
 * @param {number} value @param {number} max
 */
const quantise = (value, max)=>Math.floor(Math.min(1, Math.max(0, Number.isNaN(value) ? 0
    : value)) * max + 0.5 + 1e-6);

/**
 * A level read into red, green, blue, alpha a texel.
 *
 * @param {number} format @param {Uint8Array} data
 * @param {number} width @param {number} height @param {number} [depth]
 * @returns {Float32Array}
 */
export function decodeLevel(format, data, width, height, depth = 1){
    const texels = width * height * depth;
    const out = new Float32Array(texels * 4);
    const blocks = BLOCKS.get(format);
    const channels = CHANNEL_BLOCKS.get(format);
    if (blocks !== undefined || channels !== undefined)
    {
        const slice = data.length / depth;
        for (let z = 0; z < depth; z++)
        {
            const part = data.subarray(z * slice, (z + 1) * slice);
            const plane = width * height;
            if (blocks !== undefined)
            {
                const bgra = decodeTexels(blocks, part, width, height);
                for (let t = 0; t < plane; t++)
                {
                    const o = (z * plane + t) * 4;
                    out[o] = bgra[t * 4 + 2] / 255;
                    out[o + 1] = bgra[t * 4 + 1] / 255;
                    out[o + 2] = bgra[t * 4] / 255;
                    out[o + 3] = bgra[t * 4 + 3] / 255;
                }
                continue;
            }
            const n = /** @type {number} */ (channels);
            const values = channelBlocks(part, width, height, n, false);
            for (let t = 0; t < plane; t++)
            {
                const o = (z * plane + t) * 4;
                out[o] = values[t * n] / 255;
                out[o + 1] = n > 1 ? values[t * n + 1] / 255 : 0;
                out[o + 3] = 1;
            }
        }
        return out;
    }
    const layout = /** @type {Layout} */ (LAYOUTS.get(format));
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let t = 0; t < texels; t++)
    {
        const o = t * 4;
        out[o + 3] = 1;
        const base = t * layout.bytes;
        const word = layout.packed ? (layout.bytes === 2 ? view.getUint16(base, true)
            : view.getUint32(base, true)) : 0;
        for (const { to, kind, bits, at } of layout.channels)
        {
            if (to < 0)
            {
                continue;
            }
            const max = 2 ** bits - 1;
            if (layout.packed)
            {
                out[o + to] = (Math.floor(word / 2 ** at) % 2 ** bits) / max;
                continue;
            }
            const p = base + at;
            out[o + to] = kind === 'f' ? (bits === 32 ? view.getFloat32(p, true)
                : fromHalf(view.getUint16(p, true)))
                : kind === 's' ? Math.max(-1, (bits === 8 ? view.getInt8(p)
                    : view.getInt16(p, true)) / (2 ** (bits - 1) - 1))
                    : (bits === 8 ? data[p] : view.getUint16(p, true)) / max;
        }
    }
    return out;
}

/**
 * Red, green, blue, alpha a texel written as a level of a format.
 *
 * @param {number} format @param {Float32Array} rgba
 * @param {number} width @param {number} height @param {number} [depth]
 * @returns {Uint8Array}
 */
export function encodeLevel(format, rgba, width, height, depth = 1){
    const texels = width * height * depth;
    const blocks = BLOCKS.get(format);
    const channels = CHANNEL_BLOCKS.get(format);
    if (blocks !== undefined || channels !== undefined)
    {
        const plane = width * height;
        /** @type {Uint8Array[]} */
        const parts = [];
        for (let z = 0; z < depth; z++)
        {
            if (blocks !== undefined)
            {
                const bgra = new Uint8Array(plane * 4);
                for (let t = 0; t < plane; t++)
                {
                    const o = (z * plane + t) * 4;
                    bgra[t * 4] = quantise(rgba[o + 2], 255);
                    bgra[t * 4 + 1] = quantise(rgba[o + 1], 255);
                    bgra[t * 4 + 2] = quantise(rgba[o], 255);
                    bgra[t * 4 + 3] = quantise(rgba[o + 3], 255);
                }
                parts.push(encodeTexels(blocks, bgra, width, height));
                continue;
            }
            const n = /** @type {number} */ (channels);
            const values = new Uint8Array(plane * n);
            for (let t = 0; t < plane; t++)
            {
                for (let c = 0; c < n; c++)
                {
                    values[t * n + c] = quantise(rgba[(z * plane + t) * 4 + c], 255);
                }
            }
            parts.push(channelBlocks(values, width, height, n, true));
        }
        const out = new Uint8Array(parts.reduce((sum, part)=>sum + part.length, 0));
        let at = 0;
        for (const part of parts)
        {
            out.set(part, at);
            at += part.length;
        }
        return out;
    }
    const layout = /** @type {Layout} */ (LAYOUTS.get(format));
    const out = new Uint8Array(texels * layout.bytes);
    const view = new DataView(out.buffer);
    for (let t = 0; t < texels; t++)
    {
        const o = t * 4;
        const base = t * layout.bytes;
        let word = 0;
        for (const { to, kind, bits, at } of layout.channels)
        {
            const value = to < 0 ? 1 : rgba[o + to];
            const max = 2 ** bits - 1;
            if (layout.packed)
            {
                word += quantise(value, max) * 2 ** at;
                continue;
            }
            const p = base + at;
            if (kind === 'f')
            {
                if (bits === 32)
                {
                    view.setFloat32(p, value, true);
                }
                else
                {
                    view.setUint16(p, toHalf(value), true);
                }
            }
            else if (kind === 's')
            {
                const half = 2 ** (bits - 1) - 1;
                const v = Math.round(Math.min(1, Math.max(-1, Number.isNaN(value) ? 0 : value))
                    * half);
                if (bits === 8)
                {
                    view.setInt8(p, v);
                }
                else
                {
                    view.setInt16(p, v, true);
                }
            }
            else if (bits === 8)
            {
                out[p] = quantise(value, max);
            }
            else
            {
                view.setUint16(p, quantise(value, max), true);
            }
        }
        if (layout.packed)
        {
            if (layout.bytes === 2)
            {
                view.setUint16(base, word, true);
            }
            else
            {
                view.setUint32(base, word >>> 0, true);
            }
        }
    }
    return out;
}

/**
 * Colours between linear and sRGB as D3DX converts them: red, green and blue
 * to the power 2.2 (or 1/2.2), alpha as it is, a value outside 0 to 1 held to
 * it.
 *
 * @param {Float32Array} rgba @param {boolean} toLinear
 */
export function convertGamma(rgba, toLinear){
    const power = toLinear ? 2.2 : 1 / 2.2;
    for (let i = 0; i < rgba.length; i++)
    {
        if ((i & 3) !== 3)
        {
            rgba[i] = Math.min(1, Math.max(0, rgba[i])) ** power;
        }
    }
}

/**
 * Where an axis's index falls past an edge: wrapped, or mirrored.
 *
 * @param {number} i @param {number} size @param {boolean} mirror
 */
const edge = (i, size, mirror)=>{
    if (!mirror)
    {
        return ((i % size) + size) % size;
    }
    const period = ((i % (2 * size)) + 2 * size) % (2 * size);
    return period < size ? period : 2 * size - 1 - period;
};

/**
 * The taps of each destination texel along one axis: [source index, weight].
 *
 * @typedef {[number, number][][]} Taps
 */

/** POINT: a 16.16 fixed-point step, truncated. @param {number} from @param {number} to @returns {Taps} */
const pointTaps = (from, to)=>{
    const step = Math.floor(from * 65536 / to);
    return Array.from({ length: to }, (_, x)=>[[Math.min(from - 1, Math.floor(x * step / 65536)),
        1]]);
};

/** LINEAR: the two texels around the centre. @param {number} from @param {number} to @param {boolean} mirror @returns {Taps} */
const linearTaps = (from, to, mirror)=>Array.from({ length: to }, (_, x)=>{
    const p = (x + 0.5) * from / to - 0.5;
    const i = Math.floor(p);
    const w = p - i;
    return w === 0 ? [[edge(i, from, mirror), 1]]
        : [[edge(i, from, mirror), 1 - w], [edge(i + 1, from, mirror), w]];
});

/** TRIANGLE: a tent as wide as the scale. @param {number} from @param {number} to @param {boolean} mirror @returns {Taps} */
const triangleTaps = (from, to, mirror)=>Array.from({ length: to }, (_, x)=>{
    const scale = from / to;
    const radius = Math.max(1, scale);
    const centre = (x + 0.5) * scale;
    /** @type {[number, number][]} */
    const taps = [];
    let total = 0;
    for (let i = Math.floor(centre - radius); i <= Math.ceil(centre + radius); i++)
    {
        const w = 1 - Math.abs(i + 0.5 - centre) / radius;
        if (w > 0)
        {
            taps.push([edge(i, from, mirror), w]);
            total += w;
        }
    }
    return taps.map(([i, w])=>[i, w / total]);
});

/** BOX where a size halves exactly: the two texels it covers. @param {number} from @param {number} to @returns {Taps} */
const boxTaps = (from, to)=>Array.from({ length: to }, (_, x)=>(from === to ? [[x, 1]]
    : [[2 * x, 0.5], [2 * x + 1, 0.5]]));

/** @param {number} n */
const powerOfTwo = n=>n > 0 && (n & (n - 1)) === 0;

/**
 * A level made another size by a filter (its kind and MIRROR flags).
 *
 * @param {Float32Array} rgba
 * @param {number} width @param {number} height @param {number} depth
 * @param {number} toWidth @param {number} toHeight @param {number} toDepth
 * @param {number} filter
 * @returns {Float32Array}
 */
export function resize(rgba, width, height, depth, toWidth, toHeight, toDepth, filter){
    const out = new Float32Array(toWidth * toHeight * toDepth * 4);
    let kind = filter & 7;
    if (kind === FILTER.NONE)
    {
        for (let z = 0; z < Math.min(depth, toDepth); z++)
        {
            for (let y = 0; y < Math.min(height, toHeight); y++)
            {
                const from = ((z * height + y) * width) * 4;
                out.set(rgba.subarray(from, from + Math.min(width, toWidth) * 4),
                    ((z * toHeight + y) * toWidth) * 4);
            }
        }
        return out;
    }
    if (kind === FILTER.BOX)
    {
        const halves = [[width, toWidth], [height, toHeight], [depth, toDepth]]
            .every(([from, to])=>from === to ? to === 1 || from === 1 : from === to * 2);
        const sides = [[width, toWidth], [height, toHeight], [depth, toDepth]]
            .filter(([from, to])=>from !== to);
        kind = !halves ? FILTER.TRIANGLE
            : sides.every(([from])=>powerOfTwo(from)) ? FILTER.BOX : FILTER.LINEAR;
    }
    /** @param {number} from @param {number} to @param {number} mirrorFlag */
    const taps = (from, to, mirrorFlag)=>{
        const mirror = (filter & mirrorFlag) !== 0;
        return kind === FILTER.POINT ? pointTaps(from, to)
            : kind === FILTER.BOX ? boxTaps(from, to)
                : kind === FILTER.LINEAR ? linearTaps(from, to, mirror)
                    : triangleTaps(from, to, mirror);
    };
    const xs = taps(width, toWidth, FILTER.MIRROR_U);
    const ys = taps(height, toHeight, FILTER.MIRROR_V);
    const zs = taps(depth, toDepth, FILTER.MIRROR_W);
    for (let z = 0; z < toDepth; z++)
    {
        for (let y = 0; y < toHeight; y++)
        {
            for (let x = 0; x < toWidth; x++)
            {
                const o = ((z * toHeight + y) * toWidth + x) * 4;
                for (const [zi, zw] of zs[z])
                {
                    for (const [yi, yw] of ys[y])
                    {
                        for (const [xi, xw] of xs[x])
                        {
                            const w = zw * yw * xw;
                            const s = ((zi * height + yi) * width + xi) * 4;
                            out[o] += rgba[s] * w;
                            out[o + 1] += rgba[s + 1] * w;
                            out[o + 2] += rgba[s + 2] * w;
                            out[o + 3] += rgba[s + 3] * w;
                        }
                    }
                }
            }
        }
    }
    return out;
}
