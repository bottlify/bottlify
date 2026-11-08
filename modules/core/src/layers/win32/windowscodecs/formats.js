/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WIC's pixel formats: how many bits a pixel takes, and how a row of them is
 * read into red, green, blue and alpha and written back.
 *
 * A row is read into values of 0 to 1 (a float format's values as they are),
 * straight alpha, and told whether its colours are linear: the integer
 * formats hold sRGB colours, the float, half and fixed-point formats linear
 * (scRGB) ones, and a conversion between the two goes through the sRGB curve,
 * as Wine's converter test records Windows converting (125 of 255 is
 * 0.205079 in 128bppRGBAFloat). Grey is made of the linear colour's
 * luminance and written in the target's own curve. Between
 * two integer formats nothing passes through the curve, so 8-bit channels
 * move unchanged.
 */

import { GUID } from './layout.js';

/**
 * @typedef {Object} PixelFormat
 * @property {string} guid
 * @property {string} name   wincodec.h's, without GUID_WICPixelFormat
 * @property {number} bpp
 * @property {number} channels
 * @property {boolean} indexed
 * @property {boolean} alpha
 * @property {boolean} linear  its colours are linear, not sRGB
 * @property {((data: Uint8Array, width: number, palette: number[] | null)
 *     => Float64Array) | null} read
 *     a row into RGBA values; null where this file reads no such row
 * @property {((rgba: Float64Array, width: number, linear: boolean, palette: number[] | null)
 *     => Uint8Array) | null} write
 *     RGBA values (linear or sRGB as `linear` says) into a row
 */

/** sRGB to linear, and back, on values of 0 to 1. @param {number} v */
export const toLinear = v=>(v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
/** @param {number} v */
export const toSrgb = v=>(v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/** @param {number} v */
const clamp = v=>(Number.isNaN(v) ? 0 : Math.min(1, Math.max(0, v)));
/** A value of 0 to 1 as an integer of `max`, rounded. @param {number} v @param {number} max */
const quantise = (v, max)=>Math.floor(clamp(v) * max + 0.5);

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
 * The luminance of linear red, green and blue, by the weights Windows' grey
 * conversions answer with (SMPTE 240M's, not BT.709's 0.2126, 0.7152, 0.0722:
 * those give 229 where Wine's converter test records 230 for cyan).
 *
 * @param {number} r @param {number} g @param {number} b
 */
const luminance = (r, g, b)=>0.2125 * r + 0.7154 * g + 0.0721 * b;

/**
 * A grey of each texel in the target's own curve.
 *
 * @param {Float64Array} rgba @param {number} i  the texel's first value
 * @param {boolean} linear  whether `rgba` is linear @param {boolean} wantLinear
 */
const greyOf = (rgba, i, linear, wantLinear)=>{
    const [r, g, b] = linear ? [rgba[i], rgba[i + 1], rgba[i + 2]]
        : [toLinear(clamp(rgba[i])), toLinear(clamp(rgba[i + 1])), toLinear(clamp(rgba[i + 2]))];
    const y = luminance(r, g, b);
    return wantLinear ? y : toSrgb(clamp(y));
};

/**
 * The value of channel `c` in the curve `want`, from values in the curve
 * `have` (alpha is never curved).
 *
 * @param {Float64Array} rgba @param {number} i @param {number} c
 * @param {boolean} have @param {boolean} want
 */
const curved = (rgba, i, c, have, want)=>{
    const v = rgba[i + c];
    if (c === 3 || have === want)
    {
        return v;
    }
    return want ? toLinear(clamp(v)) : toSrgb(clamp(v));
};

/**
 * A palette colour (0xAARRGGBB) nearest a texel, by squared distance.
 *
 * @param {number[]} palette @param {number} r @param {number} g @param {number} b @param {number} a
 *     each 0 to 255
 */
function nearest(palette, r, g, b, a){
    let best = 0;
    let bestDistance = Infinity;
    palette.forEach((colour, index)=>{
        const dr = (colour >>> 16 & 0xff) - r;
        const dg = (colour >>> 8 & 0xff) - g;
        const db = (colour & 0xff) - b;
        const da = (colour >>> 24) - a;
        const distance = dr * dr + dg * dg + db * db + da * da;
        if (distance < bestDistance)
        {
            bestDistance = distance;
            best = index;
        }
    });
    return best;
}

/**
 * An indexed format of `bits` a texel: indices through the palette.
 *
 * @param {number} bits
 * @returns {Pick<PixelFormat, 'read' | 'write'>}
 */
const indexedCodec = bits=>({
    read: (data, width, palette)=>{
        const out = new Float64Array(width * 4);
        const colours = palette ?? [];
        for (let x = 0; x < width; x++)
        {
            const bit = x * bits;
            const index = data[bit >> 3] >> (8 - bits - (bit & 7)) & ((1 << bits) - 1);
            const colour = colours[index] ?? 0xff000000;
            out[x * 4] = (colour >>> 16 & 0xff) / 255;
            out[x * 4 + 1] = (colour >>> 8 & 0xff) / 255;
            out[x * 4 + 2] = (colour & 0xff) / 255;
            out[x * 4 + 3] = (colour >>> 24) / 255;
        }
        return out;
    },
    write: (rgba, width, linear, palette)=>{
        const out = new Uint8Array(Math.ceil(width * bits / 8));
        const colours = palette ?? [];
        for (let x = 0; x < width; x++)
        {
            const i = x * 4;
            const index = colours.length === 0 ? 0 : nearest(colours,
                quantise(curved(rgba, i, 0, linear, false), 255),
                quantise(curved(rgba, i, 1, linear, false), 255),
                quantise(curved(rgba, i, 2, linear, false), 255), quantise(rgba[i + 3], 255));
            const bit = x * bits;
            out[bit >> 3] |= index << (8 - bits - (bit & 7));
        }
        return out;
    },
});

/**
 * A grey format of `bits` integer bits a texel (black and white is 1).
 *
 * @param {number} bits
 * @returns {Pick<PixelFormat, 'read' | 'write'>}
 */
const greyCodec = bits=>({
    read: (data, width)=>{
        const out = new Float64Array(width * 4);
        const max = 2 ** bits - 1;
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let x = 0; x < width; x++)
        {
            let value;
            if (bits === 16)
            {
                value = view.getUint16(x * 2, true);
            }
            else
            {
                const bit = x * bits;
                value = data[bit >> 3] >> (8 - bits - (bit & 7)) & max;
            }
            out.fill(value / max, x * 4, x * 4 + 3);
            out[x * 4 + 3] = 1;
        }
        return out;
    },
    write: (rgba, width, linear)=>{
        const out = new Uint8Array(Math.ceil(width * bits / 8));
        const view = new DataView(out.buffer);
        const max = 2 ** bits - 1;
        for (let x = 0; x < width; x++)
        {
            const value = quantise(greyOf(rgba, x * 4, linear, false), max);
            if (bits === 16)
            {
                view.setUint16(x * 2, value, true);
            }
            else
            {
                const bit = x * bits;
                out[bit >> 3] |= value << (8 - bits - (bit & 7));
            }
        }
        return out;
    },
});

/**
 * A format of whole channels: each `kind` ('u' unsigned normalised, 'f'
 * float, 'h' half), `size` bytes, in `order` (0 to 3 red to alpha, -1 a byte
 * kept and not read, written 255 or 1), premultiplied or not.
 *
 * @param {'u' | 'f' | 'h'} kind @param {number} size @param {number[]} order
 * @param {boolean} [premultiplied]
 * @returns {Pick<PixelFormat, 'read' | 'write'>}
 */
const channelCodec = (kind, size, order, premultiplied = false)=>{
    const max = 2 ** (size * 8) - 1;
    const hasAlpha = order.includes(3);
    const linear = kind !== 'u';
    return {
        read: (data, width)=>{
            const out = new Float64Array(width * 4);
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            for (let x = 0; x < width; x++)
            {
                const o = x * 4;
                out[o + 3] = 1;
                order.forEach((c, k)=>{
                    if (c < 0)
                    {
                        return;
                    }
                    const at = (x * order.length + k) * size;
                    out[o + c] = kind === 'f' ? view.getFloat32(at, true)
                        : kind === 'h' ? fromHalf(view.getUint16(at, true))
                            : (size === 1 ? data[at] : view.getUint16(at, true)) / max;
                });
                if (premultiplied && out[o + 3] > 0)
                {
                    for (let c = 0; c < 3; c++)
                    {
                        out[o + c] /= out[o + 3];
                    }
                }
            }
            return out;
        },
        write: (rgba, width, from)=>{
            const out = new Uint8Array(width * order.length * size);
            const view = new DataView(out.buffer);
            for (let x = 0; x < width; x++)
            {
                const i = x * 4;
                const alpha = hasAlpha ? rgba[i + 3] : 1;
                order.forEach((c, k)=>{
                    const at = (x * order.length + k) * size;
                    let value = c < 0 ? 1 : curved(rgba, i, c, from, linear);
                    if (premultiplied && c >= 0 && c < 3)
                    {
                        value *= alpha;
                    }
                    if (kind === 'f')
                    {
                        view.setFloat32(at, value, true);
                    }
                    else if (kind === 'h')
                    {
                        view.setUint16(at, toHalf(value), true);
                    }
                    else if (size === 1)
                    {
                        out[at] = quantise(value, max);
                    }
                    else
                    {
                        view.setUint16(at, quantise(value, max), true);
                    }
                });
            }
            return out;
        },
    };
};

/**
 * A format packed in a 16- or 32-bit word: fields [channel, bits] from bit 0
 * up, the word as wide as the fields.
 *
 * @param {[number, number][]} fields
 * @returns {Pick<PixelFormat, 'read' | 'write'>}
 */
const packedCodec = fields=>{
    const size = fields.reduce((sum, [, bits])=>sum + bits, 0) > 16 ? 4 : 2;
    return {
        read: (data, width)=>{
            const out = new Float64Array(width * 4);
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            for (let x = 0; x < width; x++)
            {
                const word = size === 2 ? view.getUint16(x * 2, true) : view.getUint32(x * 4, true);
                out[x * 4 + 3] = 1;
                let at = 0;
                for (const [c, bits] of fields)
                {
                    out[x * 4 + c] = (word >>> at & ((1 << bits) - 1)) / ((1 << bits) - 1);
                    at += bits;
                }
            }
            return out;
        },
        write: (rgba, width, linear)=>{
            const out = new Uint8Array(width * size);
            const view = new DataView(out.buffer);
            for (let x = 0; x < width; x++)
            {
                let word = 0;
                let at = 0;
                for (const [c, bits] of fields)
                {
                    const value = curved(rgba, x * 4, c, linear, false);
                    // A field of 8 bits or fewer takes the 8-bit value's top
                    // bits, as WIC packs a colour; a wider one is quantised.
                    const field = bits <= 8 ? quantise(value, 255) >> (8 - bits)
                        : quantise(value, (1 << bits) - 1);
                    word = (word | field << at) >>> 0;
                    at += bits;
                }
                if (size === 2)
                {
                    view.setUint16(x * 2, word, true);
                }
                else
                {
                    view.setUint32(x * 4, word, true);
                }
            }
            return out;
        },
    };
};

/**
 * 32bppCMYK: cyan, magenta, yellow and black ink, a byte each, the colour
 * the inks leave of white (no colour management).
 *
 * @type {Pick<PixelFormat, 'read' | 'write'>}
 */
const CMYK_CODEC = {
    read: (data, width)=>{
        const out = new Float64Array(width * 4);
        for (let x = 0; x < width; x++)
        {
            const k = 1 - data[x * 4 + 3] / 255;
            for (let c = 0; c < 3; c++)
            {
                out[x * 4 + c] = (1 - data[x * 4 + c] / 255) * k;
            }
            out[x * 4 + 3] = 1;
        }
        return out;
    },
    write: (rgba, width, linear)=>{
        const out = new Uint8Array(width * 4);
        for (let x = 0; x < width; x++)
        {
            const rgb = [0, 1, 2].map(c=>clamp(curved(rgba, x * 4, c, linear, false)));
            const k = 1 - Math.max(...rgb);
            for (let c = 0; c < 3; c++)
            {
                out[x * 4 + c] = k >= 1 ? 0 : quantise((1 - rgb[c] - k) / (1 - k), 255);
            }
            out[x * 4 + 3] = quantise(k, 255);
        }
        return out;
    },
};

/**
 * A float grey format: one linear value.
 *
 * @param {'f' | 'h'} kind
 * @returns {Pick<PixelFormat, 'read' | 'write'>}
 */
const floatGreyCodec = kind=>({
    read: (data, width)=>{
        const out = new Float64Array(width * 4);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        for (let x = 0; x < width; x++)
        {
            const value = kind === 'f' ? view.getFloat32(x * 4, true)
                : fromHalf(view.getUint16(x * 2, true));
            out.fill(value, x * 4, x * 4 + 3);
            out[x * 4 + 3] = 1;
        }
        return out;
    },
    write: (rgba, width, linear)=>{
        const out = new Uint8Array(width * (kind === 'f' ? 4 : 2));
        const view = new DataView(out.buffer);
        for (let x = 0; x < width; x++)
        {
            const value = greyOf(rgba, x * 4, linear, true);
            if (kind === 'f')
            {
                view.setFloat32(x * 4, value, true);
            }
            else
            {
                view.setUint16(x * 2, toHalf(value), true);
            }
        }
        return out;
    },
});

/** @type {Pick<PixelFormat, 'read' | 'write'>} */
const NO_CODEC = { read: null, write: null };

/**
 * @param {string} name @param {number} bpp @param {number} channels
 * @param {Pick<PixelFormat, 'read' | 'write'>} codec
 * @param {{ indexed?: boolean, alpha?: boolean, linear?: boolean }} [flags]
 * @returns {PixelFormat}
 */
const format = (name, bpp, channels, codec, flags = {})=>Object.freeze({
    guid: /** @type {Record<string, string>} */ (GUID)[`PixelFormat${name}`], name, bpp, channels,
    indexed: Boolean(flags.indexed), alpha: Boolean(flags.alpha), linear: Boolean(flags.linear),
    read: codec.read, write: codec.write,
});

const BGRA = [2, 1, 0, 3];
const RGBA = [0, 1, 2, 3];

/** Every pixel format WIC names, those this file converts with their codecs. */
export const FORMATS = [
    format('1bppIndexed', 1, 1, indexedCodec(1), { indexed: true }),
    format('2bppIndexed', 2, 1, indexedCodec(2), { indexed: true }),
    format('4bppIndexed', 4, 1, indexedCodec(4), { indexed: true }),
    format('8bppIndexed', 8, 1, indexedCodec(8), { indexed: true }),
    format('BlackWhite', 1, 1, greyCodec(1)),
    format('2bppGray', 2, 1, greyCodec(2)),
    format('4bppGray', 4, 1, greyCodec(4)),
    format('8bppGray', 8, 1, greyCodec(8)),
    format('16bppGray', 16, 1, greyCodec(16)),
    format('8bppAlpha', 8, 1, channelCodec('u', 1, [3]), { alpha: true }),
    format('16bppBGR555', 16, 3, packedCodec([[2, 5], [1, 5], [0, 5]])),
    format('16bppBGR565', 16, 3, packedCodec([[2, 5], [1, 6], [0, 5]])),
    format('16bppBGRA5551', 16, 4, packedCodec([[2, 5], [1, 5], [0, 5], [3, 1]]), { alpha: true }),
    format('24bppBGR', 24, 3, channelCodec('u', 1, [2, 1, 0])),
    format('24bppRGB', 24, 3, channelCodec('u', 1, [0, 1, 2])),
    format('32bppBGR', 32, 3, channelCodec('u', 1, [2, 1, 0, -1])),
    format('32bppBGRA', 32, 4, channelCodec('u', 1, BGRA), { alpha: true }),
    format('32bppPBGRA', 32, 4, channelCodec('u', 1, BGRA, true), { alpha: true }),
    format('32bppRGB', 32, 3, channelCodec('u', 1, [0, 1, 2, -1])),
    format('32bppRGBA', 32, 4, channelCodec('u', 1, RGBA), { alpha: true }),
    format('32bppPRGBA', 32, 4, channelCodec('u', 1, RGBA, true), { alpha: true }),
    format('48bppRGB', 48, 3, channelCodec('u', 2, [0, 1, 2])),
    format('48bppBGR', 48, 3, channelCodec('u', 2, [2, 1, 0])),
    format('64bppRGB', 64, 3, channelCodec('u', 2, [0, 1, 2, -1])),
    format('64bppRGBA', 64, 4, channelCodec('u', 2, RGBA), { alpha: true }),
    format('64bppBGRA', 64, 4, channelCodec('u', 2, BGRA), { alpha: true }),
    format('64bppPRGBA', 64, 4, channelCodec('u', 2, RGBA, true), { alpha: true }),
    format('64bppPBGRA', 64, 4, channelCodec('u', 2, BGRA, true), { alpha: true }),
    format('32bppGrayFloat', 32, 1, floatGreyCodec('f'), { linear: true }),
    format('16bppGrayHalf', 16, 1, floatGreyCodec('h'), { linear: true }),
    format('96bppRGBFloat', 96, 3, channelCodec('f', 4, [0, 1, 2]), { linear: true }),
    format('128bppRGBFloat', 128, 4, channelCodec('f', 4, [0, 1, 2, -1]), { linear: true }),
    format('128bppRGBAFloat', 128, 4, channelCodec('f', 4, RGBA), { alpha: true, linear: true }),
    format('128bppPRGBAFloat', 128, 4, channelCodec('f', 4, RGBA, true),
        { alpha: true, linear: true }),
    format('48bppRGBHalf', 48, 3, channelCodec('h', 2, [0, 1, 2]), { linear: true }),
    format('64bppRGBHalf', 64, 4, channelCodec('h', 2, [0, 1, 2, -1]), { linear: true }),
    format('64bppRGBAHalf', 64, 4, channelCodec('h', 2, RGBA), { alpha: true, linear: true }),
    format('64bppPRGBAHalf', 64, 4, channelCodec('h', 2, RGBA, true),
        { alpha: true, linear: true }),
    format('32bppCMYK', 32, 4, CMYK_CODEC),
    format('64bppCMYK', 64, 4, NO_CODEC),
    format('40bppCMYKAlpha', 40, 5, NO_CODEC, { alpha: true }),
    format('80bppCMYKAlpha', 80, 5, NO_CODEC, { alpha: true }),
    format('32bppBGR101010', 32, 3, packedCodec([[2, 10], [1, 10], [0, 10]])),
    format('32bppRGBE', 32, 4, NO_CODEC, { linear: true }),
    format('48bppRGBFixedPoint', 48, 3, NO_CODEC, { linear: true }),
    format('64bppRGBAFixedPoint', 64, 4, NO_CODEC, { alpha: true, linear: true }),
    format('128bppRGBAFixedPoint', 128, 4, NO_CODEC, { alpha: true, linear: true }),
    format('16bppGrayFixedPoint', 16, 1, NO_CODEC, { linear: true }),
    format('32bppGrayFixedPoint', 32, 1, NO_CODEC, { linear: true }),
].filter(f=>f.guid !== undefined);

/** @type {Map<string, PixelFormat>} */
const BY_GUID = new Map(FORMATS.map(f=>[f.guid, f]));

/** A format by its GUID (braced, either case), or null. @param {string} guid */
export const formatOf = guid=>BY_GUID.get(guid.toUpperCase()) ?? null;

/** A row's bytes, packed. @param {PixelFormat} f @param {number} width */
export const rowBytes = (f, width)=>Math.ceil(width * f.bpp / 8);

/** Whether one format is converted into another here. @param {PixelFormat} from @param {PixelFormat} to */
export const converts = (from, to)=>from === to || (from.read !== null && to.write !== null);

/**
 * The formats the default format converter names, both ways, when asked
 * CanConvert - Wine's converter test records Windows answering yes for every
 * pair of these and no for the rest (the half, fixed-point, CMYK and
 * n-channel formats), whatever another path could convert.
 */
const DEFAULT_CONVERTER = new Set(['1bppIndexed', '2bppIndexed', '4bppIndexed', '8bppIndexed',
    'BlackWhite', '2bppGray', '4bppGray', '8bppGray', '16bppGray', '8bppAlpha', '16bppBGR555',
    '16bppBGR565', '16bppBGRA5551', '24bppBGR', '24bppRGB', '32bppBGR', '32bppBGRA',
    '32bppPBGRA', '32bppRGB', '32bppRGBA', '32bppPRGBA', '32bppGrayFloat', '48bppRGB',
    '48bppBGR', '64bppRGB', '64bppRGBA', '64bppBGRA', '64bppPRGBA', '64bppPBGRA',
    '32bppBGR101010', '96bppRGBFloat', '128bppRGBAFloat', '128bppPRGBAFloat', '128bppRGBFloat']);

/**
 * CanConvert's answer: both formats the default converter's, and converted here.
 *
 * @param {PixelFormat | null} from @param {PixelFormat | null} to
 */
export const defaultConverts = (from, to)=>from !== null && to !== null
    && DEFAULT_CONVERTER.has(from.name) && DEFAULT_CONVERTER.has(to.name) && converts(from, to);

/**
 * A row of one format in another.
 *
 * @param {PixelFormat} from @param {PixelFormat} to @param {Uint8Array} row
 * @param {number} width @param {number[] | null} fromPalette @param {number[] | null} toPalette
 * @returns {Uint8Array}
 */
export function convertRow(from, to, row, width, fromPalette, toPalette){
    if (from === to)
    {
        return row.slice(0, rowBytes(to, width));
    }
    const rgba = /** @type {NonNullable<PixelFormat['read']>} */ (from.read)(row, width, fromPalette);
    return /** @type {NonNullable<PixelFormat['write']>} */ (to.write)(rgba, width, from.linear,
        toPalette);
}
