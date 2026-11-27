/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 11's fixed-function tessellator: the domain points and the
 * primitives joining them that a patch's tess factors make, between the hull
 * shader and the domain shader.
 *
 * The D3D11.3 functional specification (11.7) describes the stage in words
 * and names Microsoft's reference tessellator (tessellator.cpp, May 2012, MIT;
 * THIRD-PARTY-NOTICES.md) as its exact description: what hardware is expected
 * to produce. This is that reference's hardware part (`CHWTessellator`) in
 * JavaScript, step for step, its fixed point (16 fractional bits) and its
 * single-precision float conversions kept, so the points it places are the
 * reference's bit for bit (`tessellator.test.js` holds it to the reference's
 * own output). The order of the points and primitives within a patch is the
 * reference's too; the specification (11.7.9) prescribes none.
 */

/** Partitioning, as D3D11_TESSELLATOR_PARTITIONING numbers it. */
export const PARTITIONING = Object.freeze({ INTEGER: 0, POW2: 1, FRACTIONAL_ODD: 2,
    FRACTIONAL_EVEN: 3 });
/** Output primitive, as D3D11_TESSELLATOR_OUTPUT_PRIMITIVE numbers it. */
export const OUTPUT = Object.freeze({ POINT: 0, LINE: 1, TRIANGLE_CW: 2, TRIANGLE_CCW: 3 });

const EVEN = 0;
const ODD = 1;

const MIN_ODD = 1;
const MAX_ODD = 63;
const MIN_EVEN = 2;
const MAX_EVEN = 64;
const MIN_ISOLINE_DENSITY = 1;
const MAX_ISOLINE_DENSITY = 64;
const MAX_FACTOR = 64;

const FRACTION_BITS = 16;
const FRACTION_MASK = 0x0000ffff;
const INTEGER_MASK = 0x7fff0000;
const ONE = 1 << FRACTION_BITS;
const ONE_THIRD = 0x00005555;
const TWO_THIRDS = 0x0000aaaa;
const ONE_HALF = 0x00008000;
/** 2^-16, the smallest positive fixed point fraction. */
const EPSILON = 0.0000152587890625;
const MIN_ODD_PLUS_HALF_EPSILON = MIN_ODD + EPSILON / 2;

/** 1/n in 16.16 for n segments, 0 to 64. */
const RECIPROCAL = Object.freeze([
    0xffffffff,
    0x10000, 0x8000, 0x5555, 0x4000, 0x3333, 0x2aab, 0x2492, 0x2000,
    0x1c72, 0x199a, 0x1746, 0x1555, 0x13b1, 0x1249, 0x1111, 0x1000,
    0xf0f, 0xe39, 0xd79, 0xccd, 0xc31, 0xba3, 0xb21, 0xaab,
    0xa3d, 0x9d9, 0x97b, 0x925, 0x8d4, 0x889, 0x842, 0x800,
    0x7c2, 0x788, 0x750, 0x71c, 0x6eb, 0x6bd, 0x690, 0x666,
    0x63e, 0x618, 0x5f4, 0x5d1, 0x5b0, 0x591, 0x572, 0x555,
    0x539, 0x51f, 0x505, 0x4ec, 0x4d5, 0x4be, 0x4a8, 0x492,
    0x47e, 0x46a, 0x457, 0x444, 0x432, 0x421, 0x410, 0x400,
]);

/**
 * Where vertex i of a half-edge ends up at the largest tess factor, in the
 * ruler-function order points are added in, and the loops' bounds for a
 * given number of half-edge points (StitchTransition).
 */
const FINAL_POSITION = Object.freeze([0, 32, 16, 8, 17, 4, 18, 9, 19, 2, 20, 10, 21, 5, 22, 11, 23,
    1, 24, 12, 25, 6, 26, 13, 27, 3, 28, 14, 29, 7, 30, 15, 31]);
const LOOP_START = Object.freeze([1, 1, 17, 9, 9, 5, 5, 5, 5, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2,
    2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
const LOOP_END = Object.freeze([0, 0, 17, 17, 25, 25, 25, 25, 29, 29, 29, 29, 29, 29, 29, 29, 31,
    31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 32]);

const DIAGONALS_INSIDE_TO_OUTSIDE = 0;
const DIAGONALS_INSIDE_TO_OUTSIDE_EXCEPT_MIDDLE = 1;
const DIAGONALS_MIRRORED = 2;

const floatBits = new Float32Array(1);
const intBits = new Int32Array(floatBits.buffer);
/** @param {number} value @returns {number} the float's bits, as a signed integer */
const bitsOf = value=>{
    floatBits[0] = value;
    return intBits[0];
};
/** @param {number} bits @returns {number} */
const floatOf = bits=>{
    intBits[0] = bits;
    return floatBits[0];
};

/** @param {number} a */
const isNaNFloat = a=>((bitsOf(a) & 0x7f800000) === 0x7f800000) && (bitsOf(a) & 0x007fffff) !== 0;

/** A denormal as a zero of its sign. @param {number} a */
const flush = a=>((bitsOf(a) & 0x7fffffff) < 0x00800000 ? floatOf(bitsOf(a) & 0x80000000) : a);

/** IEEE 754-2008 min, as the reference has it: a NaN second operand gives the first. */
function fmin(/** @type {number} */ a, /** @type {number} */ b){
    const x = flush(a);
    const y = flush(b);
    if (isNaNFloat(y))
    {
        return a;
    }
    if (x === 0 && y === 0)
    {
        return (bitsOf(x) & 0x80000000) !== 0 ? a : b;
    }
    return x < y ? a : b;
}

/** IEEE 754-2008 max, as the reference has it. */
function fmax(/** @type {number} */ a, /** @type {number} */ b){
    const x = flush(a);
    const y = flush(b);
    if (isNaNFloat(y))
    {
        return a;
    }
    if (x === 0 && y === 0)
    {
        return (bitsOf(y) & 0x80000000) !== 0 ? a : b;
    }
    return x >= y ? a : b;
}

/**
 * A float as unsigned 15.16 fixed point, rounded to nearest even, clamped:
 * NaN to 0, past the largest value to it, below the smallest fraction to 0
 * (the specification's float to fixed conversion, 3.2.4.1).
 *
 * @param {number} input
 * @returns {number}
 */
function floatToFixed(input){
    const INTEGER_BITS = 15;
    const MANTISSA = 23;
    const BIAS = 127;
    const HIDDEN = 1 << MANTISSA;
    const MANTISSA_MASK = HIDDEN - 1;
    const EXPONENT_MASK = 0xff << MANTISSA;
    const SIGN = 0x80000000 | 0;
    const maxResult = ~0;
    let maxPositive = (BIAS + INTEGER_BITS) << MANTISSA;
    const shift = MANTISSA + 1 - INTEGER_BITS - FRACTION_BITS;
    if (shift >= 0)
    {
        maxPositive -= 1 << shift;
    }
    let output = bitsOf(input);
    const exponent = ((output & EXPONENT_MASK) >> MANTISSA) - BIAS;
    const negative = output & SIGN;
    if (exponent === BIAS + 1 && (output & MANTISSA_MASK) !== 0)
    {
        output = 0;
    }
    else if (negative === 0 && output >= maxPositive)
    {
        output = maxResult;
    }
    else if (negative !== 0 && (output & ~SIGN) >= 0)
    {
        output = 0;
    }
    else if (exponent < -FRACTION_BITS - 1)
    {
        output = 0;
    }
    else
    {
        output = (output & MANTISSA_MASK) | HIDDEN;
        const extra = MANTISSA - FRACTION_BITS - exponent;
        if (extra >= 0)
        {
            const lsb = 1 << extra;
            const half = lsb >> 1;
            if ((output & lsb) !== 0 || (output & (lsb - 1)) > half)
            {
                output += half;
            }
            output >>= extra;
        }
        else
        {
            output <<= -extra;
        }
    }
    return output >>> 0;
}

/** 16.16 to float, as single precision adds the two halves. @param {number} input */
const fixedToFloat = input=>Math.fround(Math.fround(input >>> FRACTION_BITS)
    + Math.fround((input & FRACTION_MASK) / ONE));

/** Whether the float's integer part is even, as a C cast truncates it. @param {number} value */
const isEven = value=>(Math.trunc(value) & 1) === 0;

/** @param {number} input */
const fxpCeil = input=>((input & FRACTION_MASK) !== 0 ? ((input & INTEGER_MASK) + ONE) >>> 0
    : input);
/** @param {number} input */
const fxpFloor = input=>(input & INTEGER_MASK) >>> 0;

/** The value with its highest set bit of the low byte group cleared. @param {number} value */
function removeMsb(value){
    let check;
    if (value <= 0x0000ffff)
    {
        check = value <= 0x000000ff ? 0x00000080 : 0x00008000;
    }
    else
    {
        check = value <= 0x00ffffff ? 0x00800000 : 0x80000000;
    }
    for (let i = 0; i < 8; i++, check >>>= 1)
    {
        if ((value & check) !== 0)
        {
            return value & ~check;
        }
    }
    return 0;
}

/**
 * @typedef {Object} FactorContext
 * @property {number} invFloor   1/segments at the half factor's floor
 * @property {number} invCeil    and at its ceiling
 * @property {number} fraction   the half factor's fraction
 * @property {number} halfPoints
 * @property {number} splitPoint
 */

/**
 * @typedef {Object} Tessellation
 * @property {Float32Array} points   u, v pairs (a triangle's w is 1 - u - v)
 * @property {Int32Array} indices    by output primitive: points, line pairs or triangles
 */

/**
 * Tessellates one patch.
 *
 * @param {'isoline' | 'tri' | 'quad'} domain
 * @param {number} partitioning  `PARTITIONING`
 * @param {number} output        `OUTPUT`
 * @param {number[]} factors     isoline: density, detail; tri: the edges U=0, V=0,
 *     W=0, inside; quad: the edges U=0, V=0, U=1, V=1, inside U, inside V
 * @returns {Tessellation}
 */
export function tessellate(domain, partitioning, output, factors){
    const tessellator = new Tessellator(partitioning, output);
    const f = factors.map(value=>Math.fround(value));
    if (domain === 'isoline')
    {
        tessellator.isoline(f[0], f[1]);
    }
    else if (domain === 'tri')
    {
        tessellator.tri(f[0], f[1], f[2], f[3]);
    }
    else
    {
        tessellator.quad(f[0], f[1], f[2], f[3], f[4], f[5]);
    }
    return {
        points: tessellator.points.slice(0, tessellator.numPoints * 2),
        indices: tessellator.indices.slice(0, tessellator.numIndices),
    };
}

/** The reference's CHWTessellator. */
class Tessellator {
    /** @param {number} partitioning @param {number} output */
    constructor(partitioning, output){
        this.points = new Float32Array((MAX_FACTOR + 1) * (MAX_FACTOR + 1) * 2);
        this.indices = new Int32Array(MAX_FACTOR * MAX_FACTOR * 2 * 3);
        this.numPoints = 0;
        this.numIndices = 0;
        this.partitioning = partitioning;
        this.originalPartitioning = partitioning;
        this.parity = partitioning === PARTITIONING.FRACTIONAL_ODD ? ODD : EVEN;
        this.originalParity = this.parity;
        this.output = output;
        this.patched = false;
        this.patched2 = false;
        this.patch = { insideDelta: 0, insideBad: 0, insideReplacement: 0, outsideBase: 0,
            outsideDelta: 0, outsideBad: 0, outsideReplacement: 0 };
        this.patch2 = { baseToInvert: 0, cornerBad: 0, cornerReplacement: 0, inversionEnd: 0 };
    }

    odd(){
        return this.parity === ODD;
    }

    integerPartitioning(){
        return this.partitioning === PARTITIONING.INTEGER
            || this.partitioning === PARTITIONING.POW2;
    }

    /** The clamp bounds of the partitioning the program chose. */
    bounds(){
        switch (this.originalPartitioning)
        {
            case PARTITIONING.FRACTIONAL_EVEN: return [MIN_EVEN, MAX_EVEN];
            case PARTITIONING.FRACTIONAL_ODD: return [MIN_ODD, MAX_ODD];
            default: return [MIN_ODD, MAX_EVEN];
        }
    }

    /** @param {number} u @param {number} v @param {number} at */
    definePoint(u, v, at){
        this.points[at * 2] = fixedToFloat(u >>> 0);
        this.points[at * 2 + 1] = fixedToFloat(v >>> 0);
    }

    /** @param {number} index @param {number} at */
    defineIndex(index, at){
        this.indices[at] = this.patchIndex(index);
    }

    /**
     * A triangle given clockwise, stored in the output's winding.
     *
     * @param {number} a @param {number} b @param {number} c @param {number} at
     */
    defineClockwise(a, b, c, at){
        this.defineIndex(a, at);
        if (this.output === OUTPUT.TRIANGLE_CW)
        {
            this.defineIndex(b, at + 1);
            this.defineIndex(c, at + 2);
        }
        else
        {
            this.defineIndex(c, at + 1);
            this.defineIndex(b, at + 2);
        }
    }

    dumpAllPoints(){
        for (let p = 0; p < this.numPoints; p++)
        {
            this.defineIndex(p, this.numIndices++);
        }
    }

    dumpAllPointsAsLines(){
        for (let p = 1; p < this.numPoints; p++)
        {
            this.defineIndex(p - 1, this.numIndices++);
            this.defineIndex(p, this.numIndices++);
        }
    }

    /** @param {number} factor 16.16 */
    numPointsFor(factor){
        const half = Math.floor((factor + 1) / 2);
        if (this.odd())
        {
            return Math.floor(fxpCeil(ONE_HALF + half) * 2 / ONE);
        }
        return Math.floor(fxpCeil(half) * 2 / ONE) + 1;
    }

    /** @param {number} factor 16.16 @returns {FactorContext} */
    context(factor){
        let half = Math.floor((factor + 1) / 2);
        if (this.odd() || half === ONE_HALF)
        {
            half += ONE_HALF;
        }
        const floor = fxpFloor(half);
        const ceil = fxpCeil(half);
        const halfPoints = ceil >>> FRACTION_BITS;
        let splitPoint;
        if (ceil === floor)
        {
            splitPoint = halfPoints + 1;
        }
        else if (this.odd())
        {
            splitPoint = floor === ONE ? 0 : (removeMsb((floor >>> FRACTION_BITS) - 1) << 1) + 1;
        }
        else
        {
            splitPoint = (removeMsb(floor >>> FRACTION_BITS) << 1) + 1;
        }
        let floorSegments = Math.floor(floor * 2 / ONE);
        let ceilSegments = Math.floor(ceil * 2 / ONE);
        if (this.odd())
        {
            floorSegments -= 1;
            ceilSegments -= 1;
        }
        return { invFloor: RECIPROCAL[floorSegments], invCeil: RECIPROCAL[ceilSegments],
            fraction: half - floor, halfPoints, splitPoint };
    }

    /** Where point `point` of a factor's points lies, 16.16. @param {FactorContext} ctx */
    place(ctx, /** @type {number} */ point){
        let flip = false;
        if (point >= ctx.halfPoints)
        {
            point = (ctx.halfPoints << 1) - point;
            if (this.odd())
            {
                point -= 1;
            }
            flip = true;
        }
        if (point === ctx.halfPoints)
        {
            return ONE_HALF;
        }
        const onCeil = point >>> 0;
        let onFloor = onCeil;
        if (point > ctx.splitPoint)
        {
            onFloor -= 1;
        }
        const locationFloor = Math.imul(onFloor, ctx.invFloor) >>> 0;
        const locationCeil = Math.imul(onCeil, ctx.invCeil) >>> 0;
        let location = (Math.imul(locationFloor, ONE - ctx.fraction)
            + Math.imul(locationCeil, ctx.fraction)) >>> 0;
        location = ((location + ONE_HALF) >>> 0) >>> FRACTION_BITS;
        return flip ? (ONE - location) >>> 0 : location;
    }

    /** @param {number} index */
    patchIndex(index){
        if (this.patched)
        {
            const patch = this.patch;
            if (index >= patch.outsideBase)
            {
                return index === patch.outsideBad ? patch.outsideReplacement
                    : index + patch.outsideDelta;
            }
            return index === patch.insideBad ? patch.insideReplacement : index + patch.insideDelta;
        }
        if (this.patched2)
        {
            const patch = this.patch2;
            if (index >= patch.baseToInvert)
            {
                return index === patch.cornerBad ? patch.cornerReplacement
                    : patch.inversionEnd - index;
            }
            if (index === patch.cornerBad)
            {
                return patch.cornerReplacement;
            }
        }
        return index;
    }

    /**
     * @param {boolean} trapezoid @param {number} diagonals @param {number} at
     * @param {number} numInside @param {number} inside @param {number} outside
     */
    stitchRegular(trapezoid, diagonals, at, numInside, inside, outside){
        if (trapezoid)
        {
            this.defineClockwise(outside, outside + 1, inside, at);
            at += 3;
            outside++;
        }
        let p;
        switch (diagonals)
        {
            case DIAGONALS_INSIDE_TO_OUTSIDE:
                for (p = 0; p < numInside - 1; p++)
                {
                    this.defineClockwise(inside, outside, outside + 1, at);
                    at += 3;
                    this.defineClockwise(inside, outside + 1, inside + 1, at);
                    at += 3;
                    inside++;
                    outside++;
                }
                break;
            case DIAGONALS_INSIDE_TO_OUTSIDE_EXCEPT_MIDDLE:
                for (p = 0; p < Math.trunc(numInside / 2) - 1; p++)
                {
                    this.defineClockwise(outside, outside + 1, inside, at);
                    at += 3;
                    this.defineClockwise(inside, outside + 1, inside + 1, at);
                    at += 3;
                    inside++;
                    outside++;
                }
                this.defineClockwise(outside, inside + 1, inside, at);
                at += 3;
                this.defineClockwise(outside, outside + 1, inside + 1, at);
                at += 3;
                inside++;
                outside++;
                p += 2;
                for (; p < numInside; p++)
                {
                    this.defineClockwise(outside, outside + 1, inside, at);
                    at += 3;
                    this.defineClockwise(inside, outside + 1, inside + 1, at);
                    at += 3;
                    inside++;
                    outside++;
                }
                break;
            case DIAGONALS_MIRRORED:
                for (p = 0; p < Math.trunc(numInside / 2); p++)
                {
                    this.defineClockwise(outside, inside + 1, inside, at);
                    at += 3;
                    this.defineClockwise(outside, outside + 1, inside + 1, at);
                    at += 3;
                    inside++;
                    outside++;
                }
                for (; p < numInside - 1; p++)
                {
                    this.defineClockwise(inside, outside, outside + 1, at);
                    at += 3;
                    this.defineClockwise(inside, outside + 1, inside + 1, at);
                    at += 3;
                    inside++;
                    outside++;
                }
                break;
            default:
                break;
        }
        if (trapezoid)
        {
            this.defineClockwise(outside, outside + 1, inside, at);
        }
    }

    /**
     * Joins a row of inside points to a row of outside points of another
     * count, in the ruler-function order points are split in.
     *
     * @param {number} at @param {number} inside @param {number} insideHalf
     * @param {number} insideParity @param {number} outside @param {number} outsideHalf
     * @param {number} outsideParity
     */
    stitchTransition(at, inside, insideHalf, insideParity, outside, outsideHalf, outsideParity){
        if (insideParity === ODD)
        {
            insideHalf -= 1;
        }
        if (outsideParity === ODD)
        {
            outsideHalf -= 1;
        }
        const start = Math.min(LOOP_START[insideHalf], LOOP_START[outsideHalf]);
        const end = Math.max(LOOP_END[insideHalf], LOOP_END[outsideHalf]);
        if (FINAL_POSITION[0] < outsideHalf)
        {
            this.defineClockwise(outside, outside + 1, inside, at);
            at += 3;
            outside++;
        }
        for (let i = start; i <= end; i++)
        {
            if (FINAL_POSITION[i] < insideHalf)
            {
                this.defineClockwise(inside, outside, inside + 1, at);
                at += 3;
                inside++;
            }
            if (FINAL_POSITION[i] < outsideHalf)
            {
                this.defineClockwise(outside, outside + 1, inside, at);
                at += 3;
                outside++;
            }
        }
        if (insideParity !== outsideParity || insideParity === ODD)
        {
            if (insideParity === outsideParity)
            {
                this.defineClockwise(inside, outside, inside + 1, at);
                at += 3;
                this.defineClockwise(inside + 1, outside, outside + 1, at);
                at += 3;
                inside++;
                outside++;
            }
            else if (insideParity === EVEN)
            {
                this.defineClockwise(inside, outside, outside + 1, at);
                at += 3;
                outside++;
            }
            else
            {
                this.defineClockwise(inside, outside, inside + 1, at);
                at += 3;
                inside++;
            }
        }
        for (let i = end; i >= start; i--)
        {
            if (FINAL_POSITION[i] < outsideHalf)
            {
                this.defineClockwise(outside, outside + 1, inside, at);
                at += 3;
                outside++;
            }
            if (FINAL_POSITION[i] < insideHalf)
            {
                this.defineClockwise(inside, outside, inside + 1, at);
                at += 3;
                inside++;
            }
        }
        if (FINAL_POSITION[0] < outsideHalf)
        {
            this.defineClockwise(outside, outside + 1, inside, at);
        }
    }

    // ---- quad ----

    /**
     * @param {number} ueq0 @param {number} veq0 @param {number} ueq1 @param {number} veq1
     * @param {number} insideU @param {number} insideV
     */
    quad(ueq0, veq0, ueq1, veq1, insideU, insideV){
        const processed = this.quadFactors(ueq0, veq0, ueq1, veq1, insideU, insideV);
        if (processed === null)
        {
            this.numPoints = 0;
            this.numIndices = 0;
            return;
        }
        if (processed === 'minimum')
        {
            this.definePoint(0, 0, 0);
            this.definePoint(ONE, 0, 1);
            this.definePoint(ONE, ONE, 2);
            this.definePoint(0, ONE, 3);
            this.numPoints = 4;
            this.minimumPrimitives([[0, 1, 3], [1, 2, 3]]);
            return;
        }
        this.quadPoints(processed);
        if (!this.connectivityAfterPoints())
        {
            return;
        }
        this.quadConnectivity(processed);
    }

    /**
     * The primitives of a patch whose factors are all 1, by output.
     *
     * @param {number[][]} triangles  clockwise
     */
    minimumPrimitives(triangles){
        switch (this.output)
        {
            case OUTPUT.TRIANGLE_CW:
            case OUTPUT.TRIANGLE_CCW:
                triangles.forEach((triangle, k)=>this.defineClockwise(triangle[0], triangle[1],
                    triangle[2], k * 3));
                this.numIndices = triangles.length * 3;
                break;
            case OUTPUT.POINT:
                this.dumpAllPoints();
                break;
            case OUTPUT.LINE:
                this.dumpAllPointsAsLines();
                break;
            default:
                break;
        }
    }

    /** After the points: whether triangles follow, the points or lines dumped otherwise. */
    connectivityAfterPoints(){
        if (this.output === OUTPUT.POINT)
        {
            this.dumpAllPoints();
            return false;
        }
        if (this.output === OUTPUT.LINE)
        {
            this.dumpAllPointsAsLines();
            return false;
        }
        return true;
    }

    /**
     * @param {number} ueq0 @param {number} veq0 @param {number} ueq1 @param {number} veq1
     * @param {number} insideU @param {number} insideV
     * @returns {any} the processed factors; null for a culled patch; 'minimum'
     */
    quadFactors(ueq0, veq0, ueq1, veq1, insideU, insideV){
        if (!(ueq0 > 0) || !(veq0 > 0) || !(ueq1 > 0) || !(veq1 > 0))
        {
            return null;
        }
        let [lower, upper] = this.bounds();
        /** @param {number} value */
        const clamp = value=>fmin(upper, fmax(lower, value));
        const outsideF = [ueq0, veq0, ueq1, veq1].map(clamp)
            .map(value=>(this.integerPartitioning() ? Math.ceil(value) : value));
        if (this.originalPartitioning === PARTITIONING.FRACTIONAL_ODD
            && [...outsideF, insideU, insideV].some(value=>value > MIN_ODD_PLUS_HALF_EPSILON))
        {
            lower = Math.fround(MIN_ODD + EPSILON);
        }
        const insideF = [insideU, insideV].map(clamp)
            .map(value=>(this.integerPartitioning() ? Math.ceil(value) : value));
        this.numPoints = 0;
        this.numIndices = 0;
        const p = {
            outsideParity: outsideF.map(value=>(this.integerPartitioning()
                ? (isEven(value) ? EVEN : ODD) : this.originalParity)),
            insideParity: insideF.map(value=>(this.integerPartitioning()
                ? (isEven(value) || value === 1 ? EVEN : ODD) : this.originalParity)),
            outside: outsideF.map(floatToFixed),
            inside: insideF.map(floatToFixed),
            /** @type {FactorContext[]} */ outsideCtx: [],
            /** @type {FactorContext[]} */ insideCtx: [],
            /** @type {number[]} */ outsidePoints: [],
            /** @type {number[]} */ insidePoints: [],
            insideBase: 0,
        };
        if ((this.integerPartitioning() || this.odd())
            && p.inside.every(value=>value === ONE) && p.outside.every(value=>value === ONE))
        {
            return 'minimum';
        }
        for (let edge = 0; edge < 4; edge++)
        {
            this.parity = p.outsideParity[edge];
            p.outsideCtx[edge] = this.context(p.outside[edge]);
        }
        for (let axis = 0; axis < 2; axis++)
        {
            this.parity = p.insideParity[axis];
            p.insideCtx[axis] = this.context(p.inside[axis]);
        }
        for (let edge = 0; edge < 4; edge++)
        {
            this.parity = p.outsideParity[edge];
            p.outsidePoints[edge] = this.numPointsFor(p.outside[edge]);
            this.numPoints += p.outsidePoints[edge];
        }
        this.numPoints -= 4;
        for (let axis = 0; axis < 2; axis++)
        {
            this.parity = p.insideParity[axis];
            const least = p.insideParity[axis] === ODD ? 4 : 3;
            p.insidePoints[axis] = Math.max(least, this.numPointsFor(p.inside[axis]));
        }
        p.insideBase = this.numPoints;
        this.numPoints += (p.insidePoints[0] - 2) * (p.insidePoints[1] - 2);
        return p;
    }

    /** @param {any} p */
    quadPoints(p){
        let offset = 0;
        for (let edge = 0; edge < 4; edge++)
        {
            const parity = edge & 1;
            const end = p.outsidePoints[edge] - 1;
            for (let point = 0; point < end; point++, offset++)
            {
                const q = edge === 1 || edge === 2 ? point : end - point;
                this.parity = p.outsideParity[edge];
                const param = this.place(p.outsideCtx[edge], q);
                if (parity)
                {
                    this.definePoint(param, edge === 3 ? ONE : 0, offset);
                }
                else
                {
                    this.definePoint(edge === 2 ? ONE : 0, param, offset);
                }
            }
        }
        const rings = Math.min(p.insidePoints[0], p.insidePoints[1]) >> 1;
        for (let ring = 1; ring < rings; ring++)
        {
            const start = ring;
            const end = [p.insidePoints[0] - 1 - start, p.insidePoints[1] - 1 - start];
            for (let edge = 0; edge < 4; edge++)
            {
                const parity = [edge & 1, (edge + 1) & 1];
                const perpendicular = edge < 2 ? start : end[parity[0]];
                this.parity = p.insideParity[parity[0]];
                const perpParam = this.place(p.insideCtx[parity[0]], perpendicular);
                this.parity = p.insideParity[parity[1]];
                for (let point = start; point < end[parity[1]]; point++, offset++)
                {
                    const q = edge === 1 || edge === 2 ? point : end[parity[1]] - (point - start);
                    const param = this.place(p.insideCtx[parity[1]], q);
                    if (parity[1])
                    {
                        this.definePoint(perpParam, param, offset);
                    }
                    else
                    {
                        this.definePoint(param, perpParam, offset);
                    }
                }
            }
        }
        if (p.insidePoints[0] > p.insidePoints[1] && p.insideParity[1] === EVEN)
        {
            const end = p.insidePoints[0] - 1 - rings;
            this.parity = p.insideParity[0];
            for (let point = rings; point <= end; point++, offset++)
            {
                this.definePoint(this.place(p.insideCtx[0], point), ONE_HALF, offset);
            }
        }
        else if (p.insidePoints[1] >= p.insidePoints[0] && p.insideParity[0] === EVEN)
        {
            const end = p.insidePoints[1] - 1 - rings;
            this.parity = p.insideParity[1];
            for (let point = end; point >= rings; point--, offset++)
            {
                this.definePoint(ONE_HALF, this.place(p.insideCtx[1], point), offset);
            }
        }
    }

    /** @param {any} p */
    quadConnectivity(p){
        const rowsToCenter = [(p.insidePoints[0] + 1) >> 1, (p.insidePoints[1] + 1) >> 1];
        const rings = Math.min(rowsToCenter[0], rowsToCenter[1]);
        const degenerate = [p.insideParity[1] === EVEN ? rowsToCenter[1] - 1 : -1,
            p.insideParity[0] === EVEN ? rowsToCenter[0] - 1 : -1];
        const outsideCtx = [...p.outsideCtx];
        const outsideParity = [...p.outsideParity];
        const outsidePoints = [...p.outsidePoints];
        let insideBase = p.insideBase;
        let outsideBase = 0;
        for (let ring = 1; ring < rings; ring++)
        {
            const insidePoints = [p.insidePoints[0] - 2 * ring, p.insidePoints[1] - 2 * ring];
            const edge0Inside = insideBase;
            const edge0Outside = outsideBase;
            for (let edge = 0; edge < 4; edge++)
            {
                const parity = (edge + 1) & 1;
                const triangles = insidePoints[parity] + outsidePoints[edge] - 2;
                let insideAt;
                let outsideAt;
                if (edge === 3)
                {
                    if (ring === degenerate[parity])
                    {
                        this.patch2.baseToInvert = insideBase + 1;
                        this.patch2.cornerBad = outsideBase + outsidePoints[edge] - 1;
                        this.patch2.cornerReplacement = edge0Outside;
                        this.patch2.inversionEnd = (this.patch2.baseToInvert << 1) - 1;
                        insideAt = this.patch2.baseToInvert;
                        outsideAt = outsideBase;
                        this.patched2 = true;
                    }
                    else
                    {
                        this.setPatch(insideBase, insidePoints[parity], edge0Inside, outsideBase,
                            outsidePoints[edge], edge0Outside);
                        insideAt = 0;
                        outsideAt = this.patch.outsideBase;
                    }
                }
                else if (edge === 2 && ring === degenerate[parity])
                {
                    this.patch2.baseToInvert = insideBase;
                    this.patch2.cornerBad = -1;
                    this.patch2.cornerReplacement = -1;
                    this.patch2.inversionEnd = this.patch2.baseToInvert << 1;
                    insideAt = this.patch2.baseToInvert;
                    outsideAt = outsideBase;
                    this.patched2 = true;
                }
                else
                {
                    insideAt = insideBase;
                    outsideAt = outsideBase;
                }
                if (ring === 1)
                {
                    this.stitchTransition(this.numIndices, insideAt,
                        p.insideCtx[parity].halfPoints, p.insideParity[parity], outsideAt,
                        outsideCtx[edge].halfPoints, outsideParity[edge]);
                }
                else
                {
                    this.stitchRegular(true, DIAGONALS_MIRRORED, this.numIndices,
                        insidePoints[parity], insideAt, outsideAt);
                }
                this.patched = false;
                this.patched2 = false;
                this.numIndices += triangles * 3;
                outsideBase += outsidePoints[edge] - 1;
                if (edge === 2 && ring === degenerate[parity])
                {
                    insideBase -= insidePoints[parity] - 1;
                }
                else
                {
                    insideBase += insidePoints[parity] - 1;
                }
                outsidePoints[edge] = insidePoints[parity];
            }
            if (ring === 1)
            {
                for (let edge = 0; edge < 4; edge++)
                {
                    outsideCtx[edge] = p.insideCtx[edge & 1];
                    outsideParity[edge] = p.insideParity[edge & 1];
                }
            }
        }
        if (p.insidePoints[0] > p.insidePoints[1] && p.insideParity[1] === ODD)
        {
            this.patched2 = true;
            const quads = (((p.insidePoints[0] >> 1) - (p.insidePoints[1] >> 1)) << 1)
                + (p.insideParity[0] === EVEN ? 2 : 1);
            this.patch2.baseToInvert = outsideBase + quads + 2;
            this.patch2.cornerBad = this.patch2.baseToInvert;
            this.patch2.cornerReplacement = outsideBase;
            this.patch2.inversionEnd = this.patch2.baseToInvert + this.patch2.baseToInvert + quads;
            this.stitchRegular(false, DIAGONALS_INSIDE_TO_OUTSIDE, this.numIndices, quads + 1,
                this.patch2.baseToInvert, outsideBase + 1);
            this.patched2 = false;
            this.numIndices += quads * 6;
        }
        else if (p.insidePoints[1] >= p.insidePoints[0] && p.insideParity[0] === ODD)
        {
            this.patched2 = true;
            const quads = (((p.insidePoints[1] >> 1) - (p.insidePoints[0] >> 1)) << 1)
                + (p.insideParity[1] === EVEN ? 2 : 1);
            this.patch2.baseToInvert = outsideBase + quads + 1;
            this.patch2.cornerBad = -1;
            this.patch2.inversionEnd = this.patch2.baseToInvert + this.patch2.baseToInvert + quads;
            const diagonals = p.insideParity[1] === EVEN ? DIAGONALS_INSIDE_TO_OUTSIDE
                : DIAGONALS_INSIDE_TO_OUTSIDE_EXCEPT_MIDDLE;
            this.stitchRegular(false, diagonals, this.numIndices, quads + 1,
                this.patch2.baseToInvert, outsideBase);
            this.patched2 = false;
            this.numIndices += quads * 6;
        }
    }

    /**
     * The index patch of the last edge of a ring, which wraps to the ring's
     * first points: Stitch sees two rows of increasing indices.
     *
     * @param {number} insideBase @param {number} insidePoints @param {number} edge0Inside
     * @param {number} outsideBase @param {number} outsidePoints @param {number} edge0Outside
     */
    setPatch(insideBase, insidePoints, edge0Inside, outsideBase, outsidePoints, edge0Outside){
        const patch = this.patch;
        patch.insideDelta = insideBase;
        patch.insideBad = insidePoints - 1;
        patch.insideReplacement = edge0Inside;
        patch.outsideBase = patch.insideBad + 1;
        patch.outsideDelta = outsideBase - patch.outsideBase;
        patch.outsideBad = patch.outsideBase + outsidePoints - 1;
        patch.outsideReplacement = edge0Outside;
        this.patched = true;
    }

    // ---- tri ----

    /**
     * @param {number} ueq0 @param {number} veq0 @param {number} weq0 @param {number} inside
     */
    tri(ueq0, veq0, weq0, inside){
        const processed = this.triFactors(ueq0, veq0, weq0, inside);
        if (processed === null)
        {
            this.numPoints = 0;
            this.numIndices = 0;
            return;
        }
        if (processed === 'minimum')
        {
            this.definePoint(0, ONE, 0);
            this.definePoint(0, 0, 1);
            this.definePoint(ONE, 0, 2);
            this.numPoints = 3;
            this.minimumPrimitives([[0, 1, 2]]);
            return;
        }
        this.triPoints(processed);
        if (!this.connectivityAfterPoints())
        {
            return;
        }
        this.triConnectivity(processed);
    }

    /**
     * @param {number} ueq0 @param {number} veq0 @param {number} weq0 @param {number} inside
     * @returns {any}
     */
    triFactors(ueq0, veq0, weq0, inside){
        if (!(ueq0 > 0) || !(veq0 > 0) || !(weq0 > 0))
        {
            return null;
        }
        let [lower, upper] = this.bounds();
        /** @param {number} value */
        const clamp = value=>fmin(upper, fmax(lower, value));
        const outsideF = [ueq0, veq0, weq0].map(clamp)
            .map(value=>(this.integerPartitioning() ? Math.ceil(value) : value));
        if (this.originalPartitioning === PARTITIONING.FRACTIONAL_ODD
            && outsideF.some(value=>value > MIN_ODD_PLUS_HALF_EPSILON))
        {
            lower = Math.fround(MIN_ODD + EPSILON);
        }
        let insideF = clamp(inside);
        if (this.integerPartitioning())
        {
            insideF = Math.ceil(insideF);
        }
        this.numPoints = 0;
        this.numIndices = 0;
        const p = {
            outsideParity: outsideF.map(value=>(this.integerPartitioning()
                ? (isEven(value) ? EVEN : ODD) : this.originalParity)),
            insideParity: this.integerPartitioning()
                ? (isEven(insideF) || insideF === 1 ? EVEN : ODD) : this.originalParity,
            outside: outsideF.map(floatToFixed),
            inside: floatToFixed(insideF),
            /** @type {FactorContext[]} */ outsideCtx: [],
            /** @type {FactorContext | null} */ insideCtx: null,
            /** @type {number[]} */ outsidePoints: [],
            insidePoints: 0,
            insideBase: 0,
        };
        if ((this.integerPartitioning() || this.odd())
            && p.inside === ONE && p.outside.every(value=>value === ONE))
        {
            return 'minimum';
        }
        for (let edge = 0; edge < 3; edge++)
        {
            this.parity = p.outsideParity[edge];
            p.outsideCtx[edge] = this.context(p.outside[edge]);
        }
        this.parity = p.insideParity;
        p.insideCtx = this.context(p.inside);
        for (let edge = 0; edge < 3; edge++)
        {
            this.parity = p.outsideParity[edge];
            p.outsidePoints[edge] = this.numPointsFor(p.outside[edge]);
            this.numPoints += p.outsidePoints[edge];
        }
        this.numPoints -= 3;
        this.parity = p.insideParity;
        p.insidePoints = Math.max(this.odd() ? 4 : 3, this.numPointsFor(p.inside));
        p.insideBase = this.numPoints;
        const rings = (p.insidePoints >> 1) - 1;
        this.numPoints += this.odd() ? 3 * (rings * (rings + 1) - rings)
            : 3 * (rings * (rings + 1)) + 1;
        return p;
    }

    /** @param {any} p */
    triPoints(p){
        let offset = 0;
        for (let edge = 0; edge < 3; edge++)
        {
            const parity = edge & 1;
            const end = p.outsidePoints[edge] - 1;
            for (let point = 0; point < end; point++, offset++)
            {
                const q = parity ? point : end - point;
                this.parity = p.outsideParity[edge];
                const param = this.place(p.outsideCtx[edge], q);
                if (edge === 0)
                {
                    this.definePoint(0, param, offset);
                }
                else
                {
                    this.definePoint(param, edge === 2 ? ONE - param : 0, offset);
                }
            }
        }
        this.parity = p.insideParity;
        const rings = p.insidePoints >> 1;
        for (let ring = 1; ring < rings; ring++)
        {
            const start = ring;
            const end = p.insidePoints - 1 - start;
            for (let edge = 0; edge < 3; edge++)
            {
                const parity = edge & 1;
                let perp = this.place(p.insideCtx, start);
                perp = Math.imul(perp, TWO_THIRDS) >>> 0;
                perp = ((perp + ONE_HALF) >>> 0) >>> FRACTION_BITS;
                const shift = Math.floor((perp + 1) / 2);
                for (let point = start; point < end; point++, offset++)
                {
                    const q = parity ? point : end - (point - start);
                    const param = this.place(p.insideCtx, q);
                    if (edge === 0)
                    {
                        this.definePoint(perp, param - shift, offset);
                    }
                    else if (edge === 1)
                    {
                        this.definePoint(param - shift, perp, offset);
                    }
                    else
                    {
                        this.definePoint(param - shift, ONE - (param - shift) - perp, offset);
                    }
                }
            }
        }
        if (!this.odd())
        {
            this.definePoint(ONE_THIRD, ONE_THIRD, offset);
        }
    }

    /** @param {any} p */
    triConnectivity(p){
        const rings = (p.insidePoints + 1) >> 1;
        const outsideCtx = [...p.outsideCtx];
        const outsideParity = [...p.outsideParity];
        const outsidePoints = [...p.outsidePoints];
        let insideBase = p.insideBase;
        let outsideBase = 0;
        for (let ring = 1; ring < rings; ring++)
        {
            const insidePoints = p.insidePoints - 2 * ring;
            const edge0Inside = insideBase;
            const edge0Outside = outsideBase;
            for (let edge = 0; edge < 3; edge++)
            {
                const triangles = insidePoints + outsidePoints[edge] - 2;
                let insideAt;
                let outsideAt;
                if (edge === 2)
                {
                    this.setPatch(insideBase, insidePoints, edge0Inside, outsideBase,
                        outsidePoints[edge], edge0Outside);
                    insideAt = 0;
                    outsideAt = this.patch.outsideBase;
                }
                else
                {
                    insideAt = insideBase;
                    outsideAt = outsideBase;
                }
                if (ring === 1)
                {
                    this.stitchTransition(this.numIndices, insideAt, p.insideCtx.halfPoints,
                        p.insideParity, outsideAt, outsideCtx[edge].halfPoints,
                        outsideParity[edge]);
                }
                else
                {
                    this.stitchRegular(true, DIAGONALS_MIRRORED, this.numIndices, insidePoints,
                        insideAt, outsideAt);
                }
                if (edge === 2)
                {
                    this.patched = false;
                }
                this.numIndices += triangles * 3;
                outsideBase += outsidePoints[edge] - 1;
                insideBase += insidePoints - 1;
                outsidePoints[edge] = insidePoints;
            }
            if (ring === 1)
            {
                for (let edge = 0; edge < 3; edge++)
                {
                    outsideCtx[edge] = p.insideCtx;
                    outsideParity[edge] = p.insideParity;
                }
            }
        }
        if (this.odd())
        {
            this.defineClockwise(outsideBase, outsideBase + 1, outsideBase + 2, this.numIndices);
            this.numIndices += 3;
        }
    }

    // ---- isoline ----

    /** @param {number} density @param {number} detail */
    isoline(density, detail){
        if (!(density > 0) || !(detail > 0))
        {
            this.numPoints = 0;
            this.numIndices = 0;
            return;
        }
        const [lower, upper] = this.bounds();
        let lineDensity = fmin(MAX_ISOLINE_DENSITY, fmax(MIN_ISOLINE_DENSITY, density));
        let lineDetail = fmin(upper, fmax(lower, detail));
        this.numPoints = 0;
        this.numIndices = 0;
        let detailParity;
        if (this.integerPartitioning())
        {
            lineDetail = Math.ceil(lineDetail);
            detailParity = isEven(lineDetail) ? EVEN : ODD;
        }
        else
        {
            detailParity = this.originalParity;
        }
        const fxpDetail = floatToFixed(lineDetail);
        this.parity = detailParity;
        const detailCtx = this.context(fxpDetail);
        const pointsPerLine = this.numPointsFor(fxpDetail);
        this.partitioning = PARTITIONING.INTEGER;
        lineDensity = Math.ceil(lineDensity);
        const densityParity = isEven(lineDensity) ? EVEN : ODD;
        this.parity = densityParity;
        const fxpDensity = floatToFixed(lineDensity);
        const densityCtx = this.context(fxpDensity);
        const lines = this.numPointsFor(fxpDensity) - 1;
        this.partitioning = this.originalPartitioning;
        this.numPoints = pointsPerLine * lines;
        let offset = 0;
        for (let line = 0; line < lines; line++)
        {
            for (let point = 0; point < pointsPerLine; point++)
            {
                this.parity = densityParity;
                const v = this.place(densityCtx, line);
                this.parity = detailParity;
                const u = this.place(detailCtx, point);
                this.definePoint(u, v, offset++);
            }
        }
        let at = 0;
        offset = 0;
        for (let line = 0; line < lines; line++)
        {
            for (let point = 0; point < pointsPerLine; point++)
            {
                if (this.output === OUTPUT.POINT)
                {
                    this.defineIndex(offset, at++);
                }
                else if (point > 0)
                {
                    this.defineIndex(offset - 1, at++);
                    this.defineIndex(offset, at++);
                }
                offset++;
            }
        }
        this.numIndices = at;
    }
}
