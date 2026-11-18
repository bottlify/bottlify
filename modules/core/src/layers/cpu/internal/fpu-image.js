/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A 32-bit CONTEXT's floating-point groups, read from and written into the
 * state block a stopped thread's context keeps (the translator's layout):
 * CONTEXT_FLOATING_POINT's FLOATING_SAVE_AREA, as FNSAVE leaves it, and
 * CONTEXT_EXTENDED_REGISTERS' 512 bytes, as FXSAVE leaves them - the x87
 * registers as ten-byte extended values in stack order, the abridged tag,
 * MXCSR and XMM0 to XMM7.
 *
 * A runtime that suspends a thread to collect its garbage takes its context
 * whole, sends it to a stub, and once the collection is over puts the context
 * back, the floating-point state among it (a .NET runtime restores it itself,
 * FXRSTOR from the record it was given). Read as nothing, it put back
 * whatever the record held, and the thread went on mid-copy with XMM
 * registers that were never its own.
 *
 * The block keeps each x87 register as a double, and as the exact quadword
 * beside it when a `fild` left one (`x87Exact`); a register's extended value
 * is that, exactly, and one read back keeps the quadword when a double cannot
 * hold it. The instruction and operand pointers are zero, as the translator
 * keeps none.
 */

/** Where the groups are in the 32-bit CONTEXT (winnt.h). */
export const FLOAT_SAVE_AT = 0x1c;
export const EXTENDED_AT = 0xcc;
const FLOAT_SAVE_BYTES = 112;
const EXTENDED_BYTES = 512;
/** MXCSR_MASK: DAZ (bit 6) left out, as the translator's SSE model has none. */
const MXCSR_MASK = 0xffbf;

/**
 * @typedef {{ block: Uint8Array, layout: { x87: number, x87Top: number,
 *     x87Empty: number, x87Control: number, x87Status: number, x87Exact?: number,
 *     xmm: number, mxcsr: number } }} FpuContext
 */

const scratch = new DataView(new ArrayBuffer(8));

/**
 * A double as a ten-byte extended value: a denormal's fraction shifted up
 * until the integer bit is set, an infinity or NaN with the top exponent.
 *
 * @param {number} value @returns {[number, number, number]} mantissa low, high, sign and exponent
 */
export function doubleToExtended(value){
    scratch.setFloat64(0, value, true);
    const lo = scratch.getUint32(0, true);
    const hi = scratch.getUint32(4, true);
    const rawExponent = hi >>> 20 & 0x7ff;
    const fraction = hi & 0xfffff;
    let signExponent = (hi >>> 31) << 15;
    if (rawExponent !== 0)
    {
        signExponent |= rawExponent === 0x7ff ? 0x7fff : rawExponent + 15360;
        return [(lo << 11) >>> 0, (0x80000000 | fraction << 11 | lo >>> 21) >>> 0, signExponent];
    }
    if (fraction === 0 && lo === 0)
    {
        return [0, 0, signExponent];
    }
    const length = fraction !== 0 ? 64 - Math.clz32(fraction) : 32 - Math.clz32(lo);
    const count = 64 - length;
    signExponent |= 15372 - count;
    return count >= 32
        ? [0, (lo << (count - 32)) >>> 0, signExponent]
        : [(lo << count) >>> 0, (fraction << count | lo >>> (32 - count)) >>> 0, signExponent];
}

/**
 * A quadword integer as a ten-byte extended value, exactly.
 *
 * @param {bigint} integer @returns {[number, number, number]}
 */
export function quadwordToExtended(integer){
    if (integer === 0n)
    {
        return [0, 0, 0];
    }
    const sign = integer < 0n ? 0x8000 : 0;
    let magnitude = integer < 0n ? -integer : integer;
    let exponent = 16383 + 63;
    while ((magnitude & 1n << 63n) === 0n)
    {
        magnitude <<= 1n;
        exponent--;
    }
    return [Number(magnitude & 0xffffffffn), Number(magnitude >> 32n), sign | exponent];
}

/**
 * A ten-byte extended value as a double, rounded once; and the quadword it is
 * when it is an integer a double cannot hold.
 *
 * @param {number} low @param {number} high @param {number} signExponent
 * @returns {{ value: number, exact: bigint | null }}
 */
export function extendedToDouble(low, high, signExponent){
    const negative = (signExponent & 0x8000) !== 0;
    const exponent = signExponent & 0x7fff;
    const mantissa = BigInt(high >>> 0) << 32n | BigInt(low >>> 0);
    if (exponent === 0x7fff)
    {
        const fraction = mantissa & 0x7fffffffffffffffn;
        if (fraction === 0n)
        {
            return { value: negative ? -Infinity : Infinity, exact: null };
        }
        // A NaN keeps the top 52 bits of its payload, the quiet bit among
        // them; one whose payload lies all below them stays a NaN by its lowest.
        const kept = fraction >> 11n || 1n;
        scratch.setUint32(4, ((negative ? 0x80000000 : 0) | 0x7ff00000
            | Number(kept >> 32n) & 0xfffff) >>> 0, true);
        scratch.setUint32(0, Number(kept & 0xffffffffn), true);
        return { value: scratch.getFloat64(0, true), exact: null };
    }
    if (mantissa === 0n)
    {
        return { value: negative ? -0 : 0, exact: null };
    }
    const shift = exponent - 16383 - 63;
    let value = Number(mantissa);
    for (let left = shift, pass = 0; pass < 3 && left !== 0; pass++)
    {
        const step = Math.max(-1022, Math.min(1023, left));
        value *= 2 ** step;
        left -= step;
    }
    value = negative ? -value : value;
    // An integer past a double's 53 bits that a quadword holds: what `fild` left.
    if (shift <= 0 && shift > -64)
    {
        const integer = mantissa >> BigInt(-shift);
        const whole = (integer << BigInt(-shift)) === mantissa;
        const signed = negative ? -integer : integer;
        if (whole && signed >= -(2n ** 63n) && signed < 2n ** 63n && BigInt(value) !== signed)
        {
            return { value, exact: signed };
        }
    }
    return { value, exact: null };
}

/**
 * Physical register `k`'s extended value.
 *
 * @param {FpuContext} context @param {DataView} view @param {number} k
 */
const registerOf = (context, view, k)=>{
    const { layout } = context;
    const exact = (layout.x87Exact ?? -1) >= 0
        && (context.block[/** @type {number} */ (layout.x87Exact)] >>> k & 1) !== 0;
    return exact ? quadwordToExtended(view.getBigInt64(layout.x87 + k * 16 + 8, true))
        : doubleToExtended(view.getFloat64(layout.x87 + k * 16, true));
};

/**
 * The status word with the stack's top in bits 11 to 13.
 *
 * @param {FpuContext} context @param {DataView} view
 */
const statusWordOf = (context, view)=>(view.getUint16(context.layout.x87Status, true) & ~0x3800
    | (context.block[context.layout.x87Top] & 7) << 11) & 0xffff;

/**
 * FXSAVE's image of the context.
 *
 * @param {FpuContext} context @returns {Uint8Array}
 */
export function extendedImage(context){
    const { block, layout } = context;
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const image = new Uint8Array(EXTENDED_BYTES);
    const out = new DataView(image.buffer);
    out.setUint16(0, view.getUint16(layout.x87Control, true), true);
    out.setUint16(2, statusWordOf(context, view), true);
    out.setUint8(4, ~block[layout.x87Empty] & 0xff);
    out.setUint32(24, view.getUint32(layout.mxcsr, true), true);
    out.setUint32(28, MXCSR_MASK, true);
    const top = block[layout.x87Top] & 7;
    for (let i = 0; i < 8; i++)
    {
        const [low, high, signExponent] = registerOf(context, view, (top + i) & 7);
        out.setUint32(32 + 16 * i, low, true);
        out.setUint32(36 + 16 * i, high, true);
        out.setUint16(40 + 16 * i, signExponent, true);
    }
    image.set(block.subarray(layout.xmm, layout.xmm + 128), 160);
    return image;
}

/**
 * FNSAVE's FLOATING_SAVE_AREA of the context: the control, status and full
 * tag words as dwords, the registers packed in stack order.
 *
 * @param {FpuContext} context @returns {Uint8Array}
 */
export function floatSaveArea(context){
    const { block, layout } = context;
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const area = new Uint8Array(FLOAT_SAVE_BYTES);
    const out = new DataView(area.buffer);
    const empty = block[layout.x87Empty];
    let tag = 0;
    const top = block[layout.x87Top] & 7;
    for (let k = 0; k < 8; k++)
    {
        const [low, high, signExponent] = registerOf(context, view, k);
        const exponent = signExponent & 0x7fff;
        // Empty, then special (an infinity, a NaN, a denormal), zero, valid.
        tag |= ((empty >>> k & 1) !== 0 ? 3
            : exponent === 0x7fff || (exponent === 0 && (low | high) !== 0) ? 2
                : (low | high) === 0 ? 1 : 0) << 2 * k;
        const i = (k - top) & 7;
        out.setUint32(28 + 10 * i, low, true);
        out.setUint32(32 + 10 * i, high, true);
        out.setUint16(36 + 10 * i, signExponent, true);
    }
    out.setUint32(0, view.getUint16(layout.x87Control, true) | 0xffff0000, true);
    out.setUint32(4, statusWordOf(context, view) | 0xffff0000, true);
    out.setUint32(8, tag | 0xffff0000, true);
    return area;
}

/**
 * Physical register `k` from its extended value at `at` in `from`.
 *
 * @param {FpuContext} context @param {DataView} view @param {number} k
 * @param {DataView} from @param {number} at @returns {number} the exact mark
 */
const restoreRegister = (context, view, k, from, at)=>{
    const { value, exact } = extendedToDouble(from.getUint32(at, true),
        from.getUint32(at + 4, true), from.getUint16(at + 8, true));
    view.setFloat64(context.layout.x87 + k * 16, value, true);
    if (exact === null)
    {
        return 0;
    }
    view.setBigInt64(context.layout.x87 + k * 16 + 8, exact, true);
    return 1 << k;
};

/**
 * The control and status words and the stack's top, as both groups carry them.
 *
 * @param {FpuContext} context @param {DataView} view @param {number} control @param {number} status
 */
const restoreWords = (context, view, control, status)=>{
    view.setUint16(context.layout.x87Control, control & 0xffff, true);
    view.setUint16(context.layout.x87Status, status & ~0x3800 & 0xffff, true);
    context.block[context.layout.x87Top] = status >>> 11 & 7;
};

/** @param {FpuContext} context @param {number} marks */
const restoreExact = (context, marks)=>{
    if ((context.layout.x87Exact ?? -1) >= 0)
    {
        context.block[/** @type {number} */ (context.layout.x87Exact)] = marks;
    }
};

/**
 * FXRSTOR of `image` into the context.
 *
 * @param {FpuContext} context @param {Uint8Array} image
 */
export function restoreExtended(context, image){
    const { block, layout } = context;
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const from = new DataView(image.buffer, image.byteOffset, image.byteLength);
    const status = from.getUint16(2, true);
    restoreWords(context, view, from.getUint16(0, true), status);
    block[layout.x87Empty] = ~from.getUint8(4) & 0xff;
    view.setUint32(layout.mxcsr, from.getUint32(24, true), true);
    const top = status >>> 11 & 7;
    let marks = 0;
    for (let i = 0; i < 8; i++)
    {
        marks |= restoreRegister(context, view, (top + i) & 7, from, 32 + 16 * i);
    }
    restoreExact(context, marks);
    block.set(image.subarray(160, 160 + 128), layout.xmm);
}

/**
 * FRSTOR of a FLOATING_SAVE_AREA into the context: the x87 state alone.
 *
 * @param {FpuContext} context @param {Uint8Array} area
 */
export function restoreFloatSave(context, area){
    const { block, layout } = context;
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const from = new DataView(area.buffer, area.byteOffset, area.byteLength);
    const status = from.getUint32(4, true);
    restoreWords(context, view, from.getUint32(0, true), status);
    const tag = from.getUint32(8, true);
    let empty = 0;
    for (let k = 0; k < 8; k++)
    {
        empty |= (tag >>> 2 * k & 3) === 3 ? 1 << k : 0;
    }
    block[layout.x87Empty] = empty;
    const top = status >>> 11 & 7;
    let marks = 0;
    for (let i = 0; i < 8; i++)
    {
        marks |= restoreRegister(context, view, (top + i) & 7, from, 28 + 10 * i);
    }
    restoreExact(context, marks);
}

/**
 * Whether a context keeps its registers in a state block these can read.
 *
 * @param {any} context @returns {context is FpuContext}
 */
export const hasFpuBlock = context=>context?.block instanceof Uint8Array
    && typeof context.layout?.x87 === 'number' && typeof context.layout?.xmm === 'number';
