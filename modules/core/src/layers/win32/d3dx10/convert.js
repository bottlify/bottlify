/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Texels from one DXGI format into another, as D3DX 10 converts a file to the
 * format its load info asks: each texel read into red, green, blue and alpha
 * as numbers from 0 to 1 (or the float it holds), then written in the other
 * format. A channel the source lacks reads 0, alpha 1, as Direct3D samples it.
 */

/**
 * The formats converted: how each channel is held ('u8', 'u16' normalised,
 * 'f16', 'f32') and which of red, green, blue, alpha (0 to 3) each is, in
 * memory order; -1 is a channel kept but unread (X), written as 1.
 *
 * @type {Map<number, { kind: 'u8' | 'u16' | 'f16' | 'f32', order: number[] }>}
 */
const LAYOUTS = new Map([
    [2, { kind: 'f32', order: [0, 1, 2, 3] }], [6, { kind: 'f32', order: [0, 1, 2] }],
    [10, { kind: 'f16', order: [0, 1, 2, 3] }], [11, { kind: 'u16', order: [0, 1, 2, 3] }],
    [16, { kind: 'f32', order: [0, 1] }], [28, { kind: 'u8', order: [0, 1, 2, 3] }],
    [34, { kind: 'f16', order: [0, 1] }], [35, { kind: 'u16', order: [0, 1] }],
    [41, { kind: 'f32', order: [0] }], [49, { kind: 'u8', order: [0, 1] }],
    [54, { kind: 'f16', order: [0] }], [56, { kind: 'u16', order: [0] }],
    [61, { kind: 'u8', order: [0] }], [65, { kind: 'u8', order: [3] }],
    [87, { kind: 'u8', order: [2, 1, 0, 3] }], [88, { kind: 'u8', order: [2, 1, 0, -1] }],
]);

const BYTES = { u8: 1, u16: 2, f16: 2, f32: 4 };

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

/** A number as a half float's bits, rounded to nearest even. @param {number} value */
function toHalf(value){
    const f32 = new Float32Array([value]);
    const bits = new Uint32Array(f32.buffer)[0];
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
        const rounded = mantissa + 0xfff + (mantissa >> 13 & 1) >> 13;
        return sign | rounded;
    }
    const rounded = (exponent << 10 | fraction >> 13) + ((fraction & 0x1fff) > 0x1000
        || (fraction & 0x3fff) === 0x3000 ? 1 : 0);
    return sign | rounded;
}

/**
 * Whether texels of one DXGI format can be converted into another.
 *
 * @param {number} from @param {number} to
 */
export const converts = (from, to)=>LAYOUTS.has(from) && LAYOUTS.has(to);

/**
 * A level's texels in another format.
 *
 * @param {number} from @param {number} to @param {Uint8Array} data @param {number} texels
 * @returns {Uint8Array}
 */
export function convertTexels(from, to, data, texels){
    const source = /** @type {{ kind: 'u8' | 'u16' | 'f16' | 'f32', order: number[] }} */ (
        LAYOUTS.get(from));
    const target = /** @type {{ kind: 'u8' | 'u16' | 'f16' | 'f32', order: number[] }} */ (
        LAYOUTS.get(to));
    const inBytes = BYTES[source.kind];
    const outBytes = BYTES[target.kind];
    const out = new Uint8Array(texels * target.order.length * outBytes);
    const input = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const output = new DataView(out.buffer);
    const rgba = [0, 0, 0, 1];
    for (let t = 0; t < texels; t++)
    {
        rgba[0] = 0;
        rgba[1] = 0;
        rgba[2] = 0;
        rgba[3] = 1;
        source.order.forEach((channel, i)=>{
            if (channel < 0)
            {
                return;
            }
            const at = (t * source.order.length + i) * inBytes;
            rgba[channel] = source.kind === 'u8' ? input.getUint8(at) / 255
                : source.kind === 'u16' ? input.getUint16(at, true) / 65535
                    : source.kind === 'f16' ? fromHalf(input.getUint16(at, true))
                        : input.getFloat32(at, true);
        });
        target.order.forEach((channel, i)=>{
            const value = channel < 0 ? 1 : rgba[channel];
            const at = (t * target.order.length + i) * outBytes;
            const unit = Math.min(1, Math.max(0, Number.isNaN(value) ? 0 : value));
            if (target.kind === 'u8')
            {
                output.setUint8(at, Math.round(unit * 255));
            }
            else if (target.kind === 'u16')
            {
                output.setUint16(at, Math.round(unit * 65535), true);
            }
            else if (target.kind === 'f16')
            {
                output.setUint16(at, toHalf(value), true);
            }
            else
            {
                output.setFloat32(at, value, true);
            }
        });
    }
    return out;
}
