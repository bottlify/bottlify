/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Raster operations, decoded rather than enumerated.
 *
 * A ternary raster operation names a boolean function of three inputs --
 * pattern, source and destination -- and the index a program passes carries
 * that function in its high byte as a truth table: bit `(P << 2) | (S << 1) | D`
 * of the byte is the result for that combination of inputs. So the fifteen
 * codes with names in wingdi.h are not fifteen cases, they are fifteen of the
 * 256 tables, and a decoder gets the other 241 right for free.
 *
 * A binary raster operation is the same idea one input smaller: R2_BLACK is 1
 * and R2_WHITE is 16, and `code - 1` is a four-bit table over (P, D). That is
 * not a coincidence in the numbering, it is the numbering.
 *
 * Both operate bitwise across the whole 32-bit pixel. Windows does the same on
 * a 32bpp DIB, which is why an inverting operation sets the byte no format uses.
 */

/** The named ternary operations, as the constants a program compiled against. */
export const SRCCOPY = 0x00cc0020;
export const SRCPAINT = 0x00ee0086;
export const SRCAND = 0x008800c6;
export const SRCINVERT = 0x00660046;
export const SRCERASE = 0x00440328;
export const NOTSRCCOPY = 0x00330008;
export const NOTSRCERASE = 0x001100a6;
export const MERGECOPY = 0x00c000ca;
export const MERGEPAINT = 0x00bb0226;
export const PATCOPY = 0x00f00021;
export const PATPAINT = 0x00fb0a09;
export const PATINVERT = 0x005a0049;
export const DSTINVERT = 0x00550009;
export const BLACKNESS = 0x00000042;
export const WHITENESS = 0x00ff0062;

/** Binary raster operations, R2_BLACK through R2_WHITE. */
export const R2_BLACK = 1;
export const R2_NOT = 6;
export const R2_XORPEN = 7;
export const R2_NOP = 11;
export const R2_COPYPEN = 13;
export const R2_WHITE = 16;

/**
 * @param {number} rop
 * @returns {number} the eight-bit truth table the operation is
 */
export function ropTable(rop){
    return (rop >>> 16) & 0xff;
}

/**
 * Whether the table's result can change when one operand does. Two minterms
 * that differ only in that operand disagreeing is exactly what "depends on"
 * means, and it is what lets PatBlt accept an operation with no source and lets
 * a blit skip evaluating a brush no operation is going to read.
 *
 * @param {number} table
 * @param {number} operand   4 for pattern, 2 for source, 1 for destination.
 * @returns {boolean}
 */
function ropDependsOn(table, operand){
    for (let index = 0; index < 8; index++)
    {
        if (((table >>> index) & 1) !== ((table >>> (index ^ operand)) & 1))
        {
            return true;
        }
    }
    return false;
}

/** @param {number} table @returns {boolean} */
export function ropUsesPattern(table){
    return ropDependsOn(table, 4);
}

/** @param {number} table @returns {boolean} */
export function ropUsesSource(table){
    return ropDependsOn(table, 2);
}

/**
 * @param {number} table    From `ropTable`.
 * @param {number} pattern
 * @param {number} source
 * @param {number} destination
 * @returns {number}
 */
export function applyRop(table, pattern, source, destination){
    const p = pattern >>> 0;
    const s = source >>> 0;
    const d = destination >>> 0;
    let out = 0;
    // Sum of the minterms the table selects. Each term is the AND of the three
    // operands or their complements, so the whole word is evaluated at once and
    // every bit plane gets the same function independently.
    for (let index = 0; index < 8; index++)
    {
        if (((table >>> index) & 1) === 0)
        {
            continue;
        }
        out |= ((index & 4) !== 0 ? p : ~p)
            & ((index & 2) !== 0 ? s : ~s)
            & ((index & 1) !== 0 ? d : ~d);
    }
    return out >>> 0;
}

/**
 * @param {number} rop2   R2_BLACK through R2_WHITE.
 * @returns {number} the four-bit truth table over (pen, destination)
 */
export function rop2Table(rop2){
    return (rop2 - 1) & 0xf;
}

/**
 * @param {number} table   From `rop2Table`.
 * @param {number} pen
 * @param {number} destination
 * @returns {number}
 */
export function applyRop2(table, pen, destination){
    const p = pen >>> 0;
    const d = destination >>> 0;
    let out = 0;
    for (let index = 0; index < 4; index++)
    {
        if (((table >>> index) & 1) === 0)
        {
            continue;
        }
        out |= ((index & 2) !== 0 ? p : ~p) & ((index & 1) !== 0 ? d : ~d);
    }
    return out >>> 0;
}
