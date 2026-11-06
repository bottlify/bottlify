/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The fixed-function tessellator as a WebGPU compute shader: `tessellator.js`
 * (Microsoft's reference, THIRD-PARTY-NOTICES.md) in WGSL, function for
 * function, one invocation a patch. A pass that counts (`write` 0) leaves each
 * patch's point and index counts; one that writes (`write` 1) puts its points
 * and indices at the offsets it is given, the counts' running sums.
 *
 * WGSL lets an implementation assume no NaN and no infinity reaches a float
 * operation, so every test the reference makes of a factor that could be one
 * (culling, clamping, the picture frame's) is made on the float's bits; the
 * factors past them are finite, and every float operation left is exact (a
 * ceil, a conversion of an integer below 2^24, a product by 2^-16), so the
 * points are the reference's bit for bit. `tools/cdp_test/tess-gate.mjs`
 * holds it to the reference's own output on a real device.
 */

/** The bindings, group 0: what each pass reads and writes. */
export const TESSELLATOR_BINDINGS = Object.freeze({
    patches: 0, counts: 1, offsets: 2, points: 3, indices: 4, params: 5,
});

/**
 * A patch as `patches` holds it, 48 bytes: domain (0 isoline, 1 tri, 2 quad),
 * partitioning and output as Direct3D numbers them, then the six factors in
 * the order `tessellate` takes them.
 */
export const PATCH_BYTES = 48;

export const TESSELLATOR_WGSL = /* wgsl */ `
struct Patch {
    kind: vec4u,
    f0: vec4f,
    f1: vec4f,
}
struct Params {
    patchCount: u32,
    write: u32,
}
struct Ctx {
    invFloor: u32,
    invCeil: u32,
    fraction: u32,
    halfPoints: i32,
    splitPoint: i32,
}

@group(0) @binding(0) var<storage, read> patches: array<Patch>;
@group(0) @binding(1) var<storage, read_write> counts: array<vec2u>;
@group(0) @binding(2) var<storage, read> offsets: array<vec2u>;
@group(0) @binding(3) var<storage, read_write> points: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> indices: array<u32>;
@group(0) @binding(5) var<uniform> params: Params;

const EVEN = 0u;
const ODD = 1u;
const P_INTEGER = 0u;
const P_POW2 = 1u;
const P_ODD = 2u;
const P_EVEN = 3u;
const O_POINT = 0u;
const O_LINE = 1u;
const O_CW = 2u;
const ONE = 0x10000u;
const ONE_HALF = 0x8000u;
const ONE_THIRD = 0x5555u;
const TWO_THIRDS = 0xaaaau;
const FRACTION_MASK = 0xffffu;
const INTEGER_MASK = 0x7fff0000u;
const DIAG_IN_TO_OUT = 0u;
const DIAG_IN_TO_OUT_EXCEPT_MIDDLE = 1u;
const DIAG_MIRRORED = 2u;

var<private> RECIPROCAL: array<u32, 65> = array<u32, 65>(
    0xffffffffu,
    0x10000u, 0x8000u, 0x5555u, 0x4000u, 0x3333u, 0x2aabu, 0x2492u, 0x2000u,
    0x1c72u, 0x199au, 0x1746u, 0x1555u, 0x13b1u, 0x1249u, 0x1111u, 0x1000u,
    0xf0fu, 0xe39u, 0xd79u, 0xccdu, 0xc31u, 0xba3u, 0xb21u, 0xaabu,
    0xa3du, 0x9d9u, 0x97bu, 0x925u, 0x8d4u, 0x889u, 0x842u, 0x800u,
    0x7c2u, 0x788u, 0x750u, 0x71cu, 0x6ebu, 0x6bdu, 0x690u, 0x666u,
    0x63eu, 0x618u, 0x5f4u, 0x5d1u, 0x5b0u, 0x591u, 0x572u, 0x555u,
    0x539u, 0x51fu, 0x505u, 0x4ecu, 0x4d5u, 0x4beu, 0x4a8u, 0x492u,
    0x47eu, 0x46au, 0x457u, 0x444u, 0x432u, 0x421u, 0x410u, 0x400u);
var<private> FINAL_POSITION: array<i32, 33> = array<i32, 33>(0, 32, 16, 8, 17, 4, 18, 9, 19,
    2, 20, 10, 21, 5, 22, 11, 23, 1, 24, 12, 25, 6, 26, 13, 27, 3, 28, 14, 29, 7, 30, 15, 31);
var<private> LOOP_START: array<i32, 33> = array<i32, 33>(1, 1, 17, 9, 9, 5, 5, 5, 5, 3, 3, 3,
    3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2);
var<private> LOOP_END: array<i32, 33> = array<i32, 33>(0, 0, 17, 17, 25, 25, 25, 25, 29, 29,
    29, 29, 29, 29, 29, 29, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 32);

// The patch being tessellated.
var<private> partitioning: u32;
var<private> originalPartitioning: u32;
var<private> parity: u32;
var<private> originalParity: u32;
var<private> outputKind: u32;
var<private> numPoints: i32;
var<private> numIndices: i32;
var<private> writing: bool;
var<private> pointBase: u32;
var<private> indexBase: u32;
var<private> patched: bool;
var<private> patched2: bool;
var<private> insideDelta: i32;
var<private> insideBad: i32;
var<private> insideReplacement: i32;
var<private> outsidePatchBase: i32;
var<private> outsideDelta: i32;
var<private> outsideBad: i32;
var<private> outsideReplacement: i32;
var<private> baseToInvert: i32;
var<private> cornerBad: i32;
var<private> cornerReplacement: i32;
var<private> inversionEnd: i32;

// The processed factors: a tri's in the first three edges and first axis.
var<private> outsideParity: array<u32, 4>;
var<private> insideParity: array<u32, 2>;
var<private> outsideFxp: array<u32, 4>;
var<private> insideFxp: array<u32, 2>;
var<private> outsideCtx: array<Ctx, 4>;
var<private> insideCtx: array<Ctx, 2>;
var<private> outsidePoints: array<i32, 4>;
var<private> insidePoints: array<i32, 2>;
var<private> insideBase: i32;

fn isNan(a: f32) -> bool {
    let b = bitcast<u32>(a);
    return (b & 0x7f800000u) == 0x7f800000u && (b & 0x007fffffu) != 0u;
}
// a > 0, false for NaN.
fn positive(a: f32) -> bool {
    let b = bitcast<i32>(a);
    return b > 0 && !isNan(a);
}
// a > c for a finite positive c, false for NaN.
fn above(a: f32, c: f32) -> bool {
    return !isNan(a) && bitcast<i32>(a) > bitcast<i32>(c);
}
// The reference's fmin(upper, fmax(lower, a)), its NaN going to lower.
fn clampFactor(a: f32, lower: f32, upper: f32) -> f32 {
    let b = bitcast<u32>(a);
    if (isNan(a)) { return lower; }
    if (b == 0x7f800000u) { return upper; }
    if (b == 0xff800000u) { return lower; }
    return min(max(a, lower), upper);
}

fn floatToFixed(input: f32) -> u32 {
    var output = bitcast<i32>(input);
    let exponent = ((output & 0x7f800000) >> 23u) - 127;
    let negative = (output & i32(0x80000000u)) != 0;
    // 2^15 and above: a shift of -7 bits, so nothing is taken off it.
    let maxPositive = (127 + 15) << 23u;
    if (exponent == 128 && (output & 0x007fffff) != 0) {
        output = 0;
    } else if (!negative && output >= maxPositive) {
        output = -1;
    } else if (negative) {
        output = 0;
    } else if (exponent < -17) {
        output = 0;
    } else {
        output = (output & 0x007fffff) | 0x00800000;
        let extra = 23 - 16 - exponent;
        if (extra >= 0) {
            let lsb = 1 << u32(extra);
            let half = lsb >> 1u;
            if ((output & lsb) != 0 || (output & (lsb - 1)) > half) {
                output += half;
            }
            output = output >> u32(extra);
        } else {
            output = output << u32(-extra);
        }
    }
    return bitcast<u32>(output);
}

fn fixedToFloat(input: u32) -> f32 {
    return f32(input >> 16u) + f32(input & FRACTION_MASK) * (1.0 / 65536.0);
}

fn isEvenF(value: f32) -> bool {
    return (i32(value) & 1) == 0;
}

fn fxpCeil(input: u32) -> u32 {
    if ((input & FRACTION_MASK) != 0u) {
        return (input & INTEGER_MASK) + ONE;
    }
    return input;
}

fn fxpFloor(input: u32) -> u32 {
    return input & INTEGER_MASK;
}

fn removeMsb(value: i32) -> i32 {
    let v = u32(value);
    var check: u32;
    if (v <= 0xffffu) {
        check = select(0x8000u, 0x80u, v <= 0xffu);
    } else {
        check = select(0x80000000u, 0x800000u, v <= 0xffffffu);
    }
    for (var i = 0; i < 8; i++) {
        if ((v & check) != 0u) {
            return i32(v & ~check);
        }
        check = check >> 1u;
    }
    return 0;
}

fn odd() -> bool {
    return parity == ODD;
}

fn integerPartitioning() -> bool {
    return partitioning == P_INTEGER || partitioning == P_POW2;
}

fn lowerBound() -> f32 {
    if (originalPartitioning == P_EVEN) { return 2.0; }
    return 1.0;
}

fn upperBound() -> f32 {
    if (originalPartitioning == P_ODD) { return 63.0; }
    return 64.0;
}

fn definePoint(u: u32, v: u32, at: i32) {
    if (writing) {
        points[pointBase + u32(at)] = vec2f(fixedToFloat(u), fixedToFloat(v));
    }
}

fn patchIndex(index: i32) -> i32 {
    if (patched) {
        if (index >= outsidePatchBase) {
            if (index == outsideBad) { return outsideReplacement; }
            return index + outsideDelta;
        }
        if (index == insideBad) { return insideReplacement; }
        return index + insideDelta;
    }
    if (patched2) {
        if (index >= baseToInvert) {
            if (index == cornerBad) { return cornerReplacement; }
            return inversionEnd - index;
        }
        if (index == cornerBad) { return cornerReplacement; }
    }
    return index;
}

fn defineIndex(index: i32, at: i32) {
    if (writing) {
        indices[indexBase + u32(at)] = u32(patchIndex(index));
    }
}

fn defineClockwise(a: i32, b: i32, c: i32, at: i32) {
    defineIndex(a, at);
    if (outputKind == O_CW) {
        defineIndex(b, at + 1);
        defineIndex(c, at + 2);
    } else {
        defineIndex(c, at + 1);
        defineIndex(b, at + 2);
    }
}

fn dumpAllPoints() {
    for (var p = 0; p < numPoints; p++) {
        defineIndex(p, numIndices);
        numIndices++;
    }
}

fn dumpAllPointsAsLines() {
    for (var p = 1; p < numPoints; p++) {
        defineIndex(p - 1, numIndices);
        numIndices++;
        defineIndex(p, numIndices);
        numIndices++;
    }
}

fn numPointsFor(factor: u32) -> i32 {
    let half = (factor + 1u) / 2u;
    if (odd()) {
        return i32((fxpCeil(ONE_HALF + half) * 2u) >> 16u);
    }
    return i32((fxpCeil(half) * 2u) >> 16u) + 1;
}

fn context(factor: u32) -> Ctx {
    var half = (factor + 1u) / 2u;
    if (odd() || half == ONE_HALF) {
        half += ONE_HALF;
    }
    let lo = fxpFloor(half);
    let hi = fxpCeil(half);
    var ctx: Ctx;
    ctx.fraction = half - lo;
    ctx.halfPoints = i32(hi >> 16u);
    if (hi == lo) {
        ctx.splitPoint = ctx.halfPoints + 1;
    } else if (odd()) {
        if (lo == ONE) {
            ctx.splitPoint = 0;
        } else {
            ctx.splitPoint = (removeMsb(i32(lo >> 16u) - 1) << 1u) + 1;
        }
    } else {
        ctx.splitPoint = (removeMsb(i32(lo >> 16u)) << 1u) + 1;
    }
    var floorSegments = i32((lo * 2u) >> 16u);
    var ceilSegments = i32((hi * 2u) >> 16u);
    if (odd()) {
        floorSegments -= 1;
        ceilSegments -= 1;
    }
    ctx.invFloor = RECIPROCAL[floorSegments];
    ctx.invCeil = RECIPROCAL[ceilSegments];
    return ctx;
}

fn place(ctx: Ctx, at: i32) -> u32 {
    var point = at;
    var flip = false;
    if (point >= ctx.halfPoints) {
        point = (ctx.halfPoints << 1u) - point;
        if (odd()) {
            point -= 1;
        }
        flip = true;
    }
    if (point == ctx.halfPoints) {
        return ONE_HALF;
    }
    let onCeil = u32(point);
    var onFloor = onCeil;
    if (point > ctx.splitPoint) {
        onFloor -= 1u;
    }
    let locationFloor = onFloor * ctx.invFloor;
    let locationCeil = onCeil * ctx.invCeil;
    var location = locationFloor * (ONE - ctx.fraction) + locationCeil * ctx.fraction;
    location = (location + ONE_HALF) >> 16u;
    if (flip) {
        location = ONE - location;
    }
    return location;
}

fn stitchRegular(trapezoid: bool, diagonals: u32, base: i32, numInside: i32, insideAt: i32,
    outsideAt: i32) {
    var at = base;
    var inside = insideAt;
    var outside = outsideAt;
    if (trapezoid) {
        defineClockwise(outside, outside + 1, inside, at);
        at += 3;
        outside++;
    }
    var p = 0;
    if (diagonals == DIAG_IN_TO_OUT) {
        for (p = 0; p < numInside - 1; p++) {
            defineClockwise(inside, outside, outside + 1, at);
            at += 3;
            defineClockwise(inside, outside + 1, inside + 1, at);
            at += 3;
            inside++;
            outside++;
        }
    } else if (diagonals == DIAG_IN_TO_OUT_EXCEPT_MIDDLE) {
        for (p = 0; p < numInside / 2 - 1; p++) {
            defineClockwise(outside, outside + 1, inside, at);
            at += 3;
            defineClockwise(inside, outside + 1, inside + 1, at);
            at += 3;
            inside++;
            outside++;
        }
        defineClockwise(outside, inside + 1, inside, at);
        at += 3;
        defineClockwise(outside, outside + 1, inside + 1, at);
        at += 3;
        inside++;
        outside++;
        p += 2;
        for (; p < numInside; p++) {
            defineClockwise(outside, outside + 1, inside, at);
            at += 3;
            defineClockwise(inside, outside + 1, inside + 1, at);
            at += 3;
            inside++;
            outside++;
        }
    } else {
        for (p = 0; p < numInside / 2; p++) {
            defineClockwise(outside, inside + 1, inside, at);
            at += 3;
            defineClockwise(outside, outside + 1, inside + 1, at);
            at += 3;
            inside++;
            outside++;
        }
        for (; p < numInside - 1; p++) {
            defineClockwise(inside, outside, outside + 1, at);
            at += 3;
            defineClockwise(inside, outside + 1, inside + 1, at);
            at += 3;
            inside++;
            outside++;
        }
    }
    if (trapezoid) {
        defineClockwise(outside, outside + 1, inside, at);
    }
}

fn stitchTransition(base: i32, insideAt: i32, insideHalfIn: i32, insideParityIn: u32,
    outsideAt: i32, outsideHalfIn: i32, outsideParityIn: u32) {
    var at = base;
    var inside = insideAt;
    var outside = outsideAt;
    var insideHalf = insideHalfIn;
    var outsideHalf = outsideHalfIn;
    if (insideParityIn == ODD) { insideHalf -= 1; }
    if (outsideParityIn == ODD) { outsideHalf -= 1; }
    let start = min(LOOP_START[insideHalf], LOOP_START[outsideHalf]);
    let end = max(LOOP_END[insideHalf], LOOP_END[outsideHalf]);
    if (FINAL_POSITION[0] < outsideHalf) {
        defineClockwise(outside, outside + 1, inside, at);
        at += 3;
        outside++;
    }
    for (var i = start; i <= end; i++) {
        if (FINAL_POSITION[i] < insideHalf) {
            defineClockwise(inside, outside, inside + 1, at);
            at += 3;
            inside++;
        }
        if (FINAL_POSITION[i] < outsideHalf) {
            defineClockwise(outside, outside + 1, inside, at);
            at += 3;
            outside++;
        }
    }
    if (insideParityIn != outsideParityIn || insideParityIn == ODD) {
        if (insideParityIn == outsideParityIn) {
            defineClockwise(inside, outside, inside + 1, at);
            at += 3;
            defineClockwise(inside + 1, outside, outside + 1, at);
            at += 3;
            inside++;
            outside++;
        } else if (insideParityIn == EVEN) {
            defineClockwise(inside, outside, outside + 1, at);
            at += 3;
            outside++;
        } else {
            defineClockwise(inside, outside, inside + 1, at);
            at += 3;
            inside++;
        }
    }
    for (var i = end; i >= start; i--) {
        if (FINAL_POSITION[i] < outsideHalf) {
            defineClockwise(outside, outside + 1, inside, at);
            at += 3;
            outside++;
        }
        if (FINAL_POSITION[i] < insideHalf) {
            defineClockwise(inside, outside, inside + 1, at);
            at += 3;
            inside++;
        }
    }
    if (FINAL_POSITION[0] < outsideHalf) {
        defineClockwise(outside, outside + 1, inside, at);
    }
}

fn setPatch(iBase: i32, iPoints: i32, edge0Inside: i32, oBase: i32, oPoints: i32,
    edge0Outside: i32) {
    insideDelta = iBase;
    insideBad = iPoints - 1;
    insideReplacement = edge0Inside;
    outsidePatchBase = insideBad + 1;
    outsideDelta = oBase - outsidePatchBase;
    outsideBad = outsidePatchBase + oPoints - 1;
    outsideReplacement = edge0Outside;
    patched = true;
}

fn minimumPrimitives(quad: bool) {
    if (outputKind == O_POINT) {
        dumpAllPoints();
    } else if (outputKind == O_LINE) {
        dumpAllPointsAsLines();
    } else if (quad) {
        defineClockwise(0, 1, 3, 0);
        defineClockwise(1, 2, 3, 3);
        numIndices = 6;
    } else {
        defineClockwise(0, 1, 2, 0);
        numIndices = 3;
    }
}

// After the points: whether triangles follow, the points or lines dumped otherwise.
fn connectivityAfterPoints() -> bool {
    if (outputKind == O_POINT) {
        dumpAllPoints();
        return false;
    }
    if (outputKind == O_LINE) {
        dumpAllPointsAsLines();
        return false;
    }
    return true;
}

fn roundFactor(value: f32) -> f32 {
    if (integerPartitioning()) {
        return ceil(value);
    }
    return value;
}

fn integerParity(value: f32, inside: bool) -> u32 {
    if (!integerPartitioning()) {
        return originalParity;
    }
    if (isEvenF(value) || (inside && value == 1.0)) {
        return EVEN;
    }
    return ODD;
}

// 0 culled, 1 all factors one, 2 tessellated.
fn quadFactors(f0: vec4f, f1: vec4f) -> u32 {
    if (!positive(f0.x) || !positive(f0.y) || !positive(f0.z) || !positive(f0.w)) {
        return 0u;
    }
    var lower = lowerBound();
    let upper = upperBound();
    var outsideF = array<f32, 4>(roundFactor(clampFactor(f0.x, lower, upper)),
        roundFactor(clampFactor(f0.y, lower, upper)), roundFactor(clampFactor(f0.z, lower, upper)),
        roundFactor(clampFactor(f0.w, lower, upper)));
    if (originalPartitioning == P_ODD) {
        let edge = 1.0 + 0.0000152587890625 / 2.0;
        if (above(outsideF[0], edge) || above(outsideF[1], edge) || above(outsideF[2], edge)
            || above(outsideF[3], edge) || above(f1.x, edge) || above(f1.y, edge)) {
            lower = 1.0 + 0.0000152587890625;
        }
    }
    var insideF = array<f32, 2>(roundFactor(clampFactor(f1.x, lower, upper)),
        roundFactor(clampFactor(f1.y, lower, upper)));
    numPoints = 0;
    numIndices = 0;
    for (var edge = 0; edge < 4; edge++) {
        outsideParity[edge] = integerParity(outsideF[edge], false);
        outsideFxp[edge] = floatToFixed(outsideF[edge]);
    }
    for (var axis = 0; axis < 2; axis++) {
        insideParity[axis] = integerParity(insideF[axis], true);
        insideFxp[axis] = floatToFixed(insideF[axis]);
    }
    if ((integerPartitioning() || odd()) && insideFxp[0] == ONE && insideFxp[1] == ONE
        && outsideFxp[0] == ONE && outsideFxp[1] == ONE && outsideFxp[2] == ONE
        && outsideFxp[3] == ONE) {
        return 1u;
    }
    for (var edge = 0; edge < 4; edge++) {
        parity = outsideParity[edge];
        outsideCtx[edge] = context(outsideFxp[edge]);
    }
    for (var axis = 0; axis < 2; axis++) {
        parity = insideParity[axis];
        insideCtx[axis] = context(insideFxp[axis]);
    }
    for (var edge = 0; edge < 4; edge++) {
        parity = outsideParity[edge];
        outsidePoints[edge] = numPointsFor(outsideFxp[edge]);
        numPoints += outsidePoints[edge];
    }
    numPoints -= 4;
    for (var axis = 0; axis < 2; axis++) {
        parity = insideParity[axis];
        let least = select(3, 4, insideParity[axis] == ODD);
        insidePoints[axis] = max(least, numPointsFor(insideFxp[axis]));
    }
    insideBase = numPoints;
    numPoints += (insidePoints[0] - 2) * (insidePoints[1] - 2);
    return 2u;
}

fn quadPoints() {
    var offset = 0;
    for (var edge = 0; edge < 4; edge++) {
        let side = edge & 1;
        let end = outsidePoints[edge] - 1;
        for (var point = 0; point < end; point++) {
            var q = end - point;
            if (edge == 1 || edge == 2) { q = point; }
            parity = outsideParity[edge];
            let param = place(outsideCtx[edge], q);
            if (side != 0) {
                definePoint(param, select(0u, ONE, edge == 3), offset);
            } else {
                definePoint(select(0u, ONE, edge == 2), param, offset);
            }
            offset++;
        }
    }
    let rings = min(insidePoints[0], insidePoints[1]) >> 1u;
    for (var ring = 1; ring < rings; ring++) {
        let start = ring;
        var end = array<i32, 2>(insidePoints[0] - 1 - start, insidePoints[1] - 1 - start);
        for (var edge = 0; edge < 4; edge++) {
            let p0 = edge & 1;
            let p1 = (edge + 1) & 1;
            var perpendicular = end[p0];
            if (edge < 2) { perpendicular = start; }
            parity = insideParity[p0];
            let perpParam = place(insideCtx[p0], perpendicular);
            parity = insideParity[p1];
            for (var point = start; point < end[p1]; point++) {
                var q = end[p1] - (point - start);
                if (edge == 1 || edge == 2) { q = point; }
                let param = place(insideCtx[p1], q);
                if (p1 != 0) {
                    definePoint(perpParam, param, offset);
                } else {
                    definePoint(param, perpParam, offset);
                }
                offset++;
            }
        }
    }
    if (insidePoints[0] > insidePoints[1] && insideParity[1] == EVEN) {
        let end = insidePoints[0] - 1 - rings;
        parity = insideParity[0];
        for (var point = rings; point <= end; point++) {
            definePoint(place(insideCtx[0], point), ONE_HALF, offset);
            offset++;
        }
    } else if (insidePoints[1] >= insidePoints[0] && insideParity[0] == EVEN) {
        let end = insidePoints[1] - 1 - rings;
        parity = insideParity[1];
        for (var point = end; point >= rings; point--) {
            definePoint(ONE_HALF, place(insideCtx[1], point), offset);
            offset++;
        }
    }
}

fn quadConnectivity() {
    let rowsToCenter = array<i32, 2>((insidePoints[0] + 1) >> 1u, (insidePoints[1] + 1) >> 1u);
    let rings = min(rowsToCenter[0], rowsToCenter[1]);
    var degenerate = array<i32, 2>(select(-1, rowsToCenter[1] - 1, insideParity[1] == EVEN),
        select(-1, rowsToCenter[0] - 1, insideParity[0] == EVEN));
    var ctxs = outsideCtx;
    var parities = outsideParity;
    var outsideCount = outsidePoints;
    var iBase = insideBase;
    var oBase = 0;
    for (var ring = 1; ring < rings; ring++) {
        var inCount = array<i32, 2>(insidePoints[0] - 2 * ring, insidePoints[1] - 2 * ring);
        let edge0Inside = iBase;
        let edge0Outside = oBase;
        for (var edge = 0; edge < 4; edge++) {
            let side = (edge + 1) & 1;
            let triangles = inCount[side] + outsideCount[edge] - 2;
            var insideAt = iBase;
            var outsideAt = oBase;
            if (edge == 3) {
                if (ring == degenerate[side]) {
                    baseToInvert = iBase + 1;
                    cornerBad = oBase + outsideCount[edge] - 1;
                    cornerReplacement = edge0Outside;
                    inversionEnd = (baseToInvert << 1u) - 1;
                    insideAt = baseToInvert;
                    outsideAt = oBase;
                    patched2 = true;
                } else {
                    setPatch(iBase, inCount[side], edge0Inside, oBase, outsideCount[edge],
                        edge0Outside);
                    insideAt = 0;
                    outsideAt = outsidePatchBase;
                }
            } else if (edge == 2 && ring == degenerate[side]) {
                baseToInvert = iBase;
                cornerBad = -1;
                cornerReplacement = -1;
                inversionEnd = baseToInvert << 1u;
                insideAt = baseToInvert;
                outsideAt = oBase;
                patched2 = true;
            }
            if (ring == 1) {
                stitchTransition(numIndices, insideAt, insideCtx[side].halfPoints,
                    insideParity[side], outsideAt, ctxs[edge].halfPoints, parities[edge]);
            } else {
                stitchRegular(true, DIAG_MIRRORED, numIndices, inCount[side], insideAt,
                    outsideAt);
            }
            patched = false;
            patched2 = false;
            numIndices += triangles * 3;
            oBase += outsideCount[edge] - 1;
            if (edge == 2 && ring == degenerate[side]) {
                iBase -= inCount[side] - 1;
            } else {
                iBase += inCount[side] - 1;
            }
            outsideCount[edge] = inCount[side];
        }
        if (ring == 1) {
            for (var edge = 0; edge < 4; edge++) {
                ctxs[edge] = insideCtx[edge & 1];
                parities[edge] = insideParity[edge & 1];
            }
        }
    }
    if (insidePoints[0] > insidePoints[1] && insideParity[1] == ODD) {
        patched2 = true;
        let quads = (((insidePoints[0] >> 1u) - (insidePoints[1] >> 1u)) << 1u)
            + select(1, 2, insideParity[0] == EVEN);
        baseToInvert = oBase + quads + 2;
        cornerBad = baseToInvert;
        cornerReplacement = oBase;
        inversionEnd = baseToInvert + baseToInvert + quads;
        stitchRegular(false, DIAG_IN_TO_OUT, numIndices, quads + 1, baseToInvert, oBase + 1);
        patched2 = false;
        numIndices += quads * 6;
    } else if (insidePoints[1] >= insidePoints[0] && insideParity[0] == ODD) {
        patched2 = true;
        let quads = (((insidePoints[1] >> 1u) - (insidePoints[0] >> 1u)) << 1u)
            + select(1, 2, insideParity[1] == EVEN);
        baseToInvert = oBase + quads + 1;
        cornerBad = -1;
        inversionEnd = baseToInvert + baseToInvert + quads;
        let diagonals = select(DIAG_IN_TO_OUT_EXCEPT_MIDDLE, DIAG_IN_TO_OUT,
            insideParity[1] == EVEN);
        stitchRegular(false, diagonals, numIndices, quads + 1, baseToInvert, oBase);
        patched2 = false;
        numIndices += quads * 6;
    }
}

fn quad(f0: vec4f, f1: vec4f) {
    let processed = quadFactors(f0, f1);
    if (processed == 0u) {
        numPoints = 0;
        numIndices = 0;
        return;
    }
    if (processed == 1u) {
        definePoint(0u, 0u, 0);
        definePoint(ONE, 0u, 1);
        definePoint(ONE, ONE, 2);
        definePoint(0u, ONE, 3);
        numPoints = 4;
        minimumPrimitives(true);
        return;
    }
    quadPoints();
    if (connectivityAfterPoints()) {
        quadConnectivity();
    }
}

fn triFactors(f0: vec4f) -> u32 {
    if (!positive(f0.x) || !positive(f0.y) || !positive(f0.z)) {
        return 0u;
    }
    var lower = lowerBound();
    let upper = upperBound();
    var outsideF = array<f32, 3>(roundFactor(clampFactor(f0.x, lower, upper)),
        roundFactor(clampFactor(f0.y, lower, upper)), roundFactor(clampFactor(f0.z, lower, upper)));
    if (originalPartitioning == P_ODD) {
        let edge = 1.0 + 0.0000152587890625 / 2.0;
        if (above(outsideF[0], edge) || above(outsideF[1], edge) || above(outsideF[2], edge)) {
            lower = 1.0 + 0.0000152587890625;
        }
    }
    let insideF = roundFactor(clampFactor(f0.w, lower, upper));
    numPoints = 0;
    numIndices = 0;
    for (var edge = 0; edge < 3; edge++) {
        outsideParity[edge] = integerParity(outsideF[edge], false);
        outsideFxp[edge] = floatToFixed(outsideF[edge]);
    }
    insideParity[0] = integerParity(insideF, true);
    insideFxp[0] = floatToFixed(insideF);
    if ((integerPartitioning() || odd()) && insideFxp[0] == ONE && outsideFxp[0] == ONE
        && outsideFxp[1] == ONE && outsideFxp[2] == ONE) {
        return 1u;
    }
    for (var edge = 0; edge < 3; edge++) {
        parity = outsideParity[edge];
        outsideCtx[edge] = context(outsideFxp[edge]);
    }
    parity = insideParity[0];
    insideCtx[0] = context(insideFxp[0]);
    for (var edge = 0; edge < 3; edge++) {
        parity = outsideParity[edge];
        outsidePoints[edge] = numPointsFor(outsideFxp[edge]);
        numPoints += outsidePoints[edge];
    }
    numPoints -= 3;
    parity = insideParity[0];
    insidePoints[0] = max(select(3, 4, odd()), numPointsFor(insideFxp[0]));
    insideBase = numPoints;
    let rings = (insidePoints[0] >> 1u) - 1;
    if (odd()) {
        numPoints += 3 * (rings * (rings + 1) - rings);
    } else {
        numPoints += 3 * (rings * (rings + 1)) + 1;
    }
    return 2u;
}

fn triPoints() {
    var offset = 0;
    for (var edge = 0; edge < 3; edge++) {
        let side = edge & 1;
        let end = outsidePoints[edge] - 1;
        for (var point = 0; point < end; point++) {
            var q = end - point;
            if (side != 0) { q = point; }
            parity = outsideParity[edge];
            let param = place(outsideCtx[edge], q);
            if (edge == 0) {
                definePoint(0u, param, offset);
            } else {
                definePoint(param, select(0u, ONE - param, edge == 2), offset);
            }
            offset++;
        }
    }
    parity = insideParity[0];
    let rings = insidePoints[0] >> 1u;
    for (var ring = 1; ring < rings; ring++) {
        let start = ring;
        let end = insidePoints[0] - 1 - start;
        for (var edge = 0; edge < 3; edge++) {
            let side = edge & 1;
            var perp = place(insideCtx[0], start);
            perp = perp * TWO_THIRDS;
            perp = (perp + ONE_HALF) >> 16u;
            let shift = (perp + 1u) / 2u;
            for (var point = start; point < end; point++) {
                var q = end - (point - start);
                if (side != 0) { q = point; }
                let param = place(insideCtx[0], q);
                if (edge == 0) {
                    definePoint(perp, param - shift, offset);
                } else if (edge == 1) {
                    definePoint(param - shift, perp, offset);
                } else {
                    definePoint(param - shift, ONE - (param - shift) - perp, offset);
                }
                offset++;
            }
        }
    }
    if (!odd()) {
        definePoint(ONE_THIRD, ONE_THIRD, offset);
    }
}

fn triConnectivity() {
    let rings = (insidePoints[0] + 1) >> 1u;
    var ctxs = outsideCtx;
    var parities = outsideParity;
    var outsideCount = outsidePoints;
    var iBase = insideBase;
    var oBase = 0;
    for (var ring = 1; ring < rings; ring++) {
        let inCount = insidePoints[0] - 2 * ring;
        let edge0Inside = iBase;
        let edge0Outside = oBase;
        for (var edge = 0; edge < 3; edge++) {
            let triangles = inCount + outsideCount[edge] - 2;
            var insideAt = iBase;
            var outsideAt = oBase;
            if (edge == 2) {
                setPatch(iBase, inCount, edge0Inside, oBase, outsideCount[edge], edge0Outside);
                insideAt = 0;
                outsideAt = outsidePatchBase;
            }
            if (ring == 1) {
                stitchTransition(numIndices, insideAt, insideCtx[0].halfPoints, insideParity[0],
                    outsideAt, ctxs[edge].halfPoints, parities[edge]);
            } else {
                stitchRegular(true, DIAG_MIRRORED, numIndices, inCount, insideAt, outsideAt);
            }
            if (edge == 2) {
                patched = false;
            }
            numIndices += triangles * 3;
            oBase += outsideCount[edge] - 1;
            iBase += inCount - 1;
            outsideCount[edge] = inCount;
        }
        if (ring == 1) {
            for (var edge = 0; edge < 3; edge++) {
                ctxs[edge] = insideCtx[0];
                parities[edge] = insideParity[0];
            }
        }
    }
    if (odd()) {
        defineClockwise(oBase, oBase + 1, oBase + 2, numIndices);
        numIndices += 3;
    }
}

fn tri(f0: vec4f) {
    let processed = triFactors(f0);
    if (processed == 0u) {
        numPoints = 0;
        numIndices = 0;
        return;
    }
    if (processed == 1u) {
        definePoint(0u, ONE, 0);
        definePoint(0u, 0u, 1);
        definePoint(ONE, 0u, 2);
        numPoints = 3;
        minimumPrimitives(false);
        return;
    }
    triPoints();
    if (connectivityAfterPoints()) {
        triConnectivity();
    }
}

fn isoline(density: f32, detail: f32) {
    if (!positive(density) || !positive(detail)) {
        numPoints = 0;
        numIndices = 0;
        return;
    }
    var lineDensity = clampFactor(density, 1.0, 64.0);
    var lineDetail = clampFactor(detail, lowerBound(), upperBound());
    numPoints = 0;
    numIndices = 0;
    var detailParity = originalParity;
    if (integerPartitioning()) {
        lineDetail = ceil(lineDetail);
        detailParity = select(ODD, EVEN, isEvenF(lineDetail));
    }
    let fxpDetail = floatToFixed(lineDetail);
    parity = detailParity;
    let detailCtx = context(fxpDetail);
    let pointsPerLine = numPointsFor(fxpDetail);
    partitioning = P_INTEGER;
    lineDensity = ceil(lineDensity);
    let densityParity = select(ODD, EVEN, isEvenF(lineDensity));
    parity = densityParity;
    let fxpDensity = floatToFixed(lineDensity);
    let densityCtx = context(fxpDensity);
    let lines = numPointsFor(fxpDensity) - 1;
    partitioning = originalPartitioning;
    numPoints = pointsPerLine * lines;
    var offset = 0;
    for (var line = 0; line < lines; line++) {
        for (var point = 0; point < pointsPerLine; point++) {
            parity = densityParity;
            let v = place(densityCtx, line);
            parity = detailParity;
            let u = place(detailCtx, point);
            definePoint(u, v, offset);
            offset++;
        }
    }
    var at = 0;
    offset = 0;
    for (var line = 0; line < lines; line++) {
        for (var point = 0; point < pointsPerLine; point++) {
            if (outputKind == O_POINT) {
                defineIndex(offset, at);
                at++;
            } else if (point > 0) {
                defineIndex(offset - 1, at);
                at++;
                defineIndex(offset, at);
                at++;
            }
            offset++;
        }
    }
    numIndices = at;
}

@compute @workgroup_size(64)
fn tessellatePatches(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= params.patchCount) {
        return;
    }
    let one = patches[id.x];
    originalPartitioning = one.kind.y;
    partitioning = originalPartitioning;
    parity = select(EVEN, ODD, originalPartitioning == P_ODD);
    originalParity = parity;
    outputKind = one.kind.z;
    numPoints = 0;
    numIndices = 0;
    patched = false;
    patched2 = false;
    writing = params.write != 0u;
    if (writing) {
        pointBase = offsets[id.x].x;
        indexBase = offsets[id.x].y;
    }
    if (one.kind.x == 0u) {
        isoline(one.f0.x, one.f0.y);
    } else if (one.kind.x == 1u) {
        tri(one.f0);
    } else {
        quad(one.f0, one.f1);
    }
    if (!writing) {
        counts[id.x] = vec2u(u32(numPoints), u32(numIndices));
    }
}
`;

/** The bindings of `TESS_SCAN_WGSL`, group 0. */
export const TESS_SCAN_BINDINGS = Object.freeze({
    counts: 0, offsets: 1, patches: 2, args: 3, params: 4,
});

/**
 * Words of `args` past the draw's four: the points and the indices every
 * patch together asked for, kept or not, for the renderer to read back and
 * size its buffers by.
 */
export const TESS_ARGS_WORDS = 8;

/**
 * Between the counting pass and the writing pass: each patch's offsets, the
 * running sums of the counts (one workgroup, each invocation a run of
 * patches), and the arguments of the draw over what is written. A patch past
 * the room the buffers have (`params` z points, w indices; x the patches) is culled where
 * the writing pass reads it (its first factor made 0), so the patches kept
 * are a prefix and the draw covers exactly their indices; `args` 4 and 5 say
 * how much room every patch would have needed.
 */
export const TESS_SCAN_WGSL = /* wgsl */ `
struct Patch {
    kind: vec4u,
    f0: vec4f,
    f1: vec4f,
}

@group(0) @binding(0) var<storage, read> counts: array<vec2u>;
@group(0) @binding(1) var<storage, read_write> offsets: array<vec2u>;
@group(0) @binding(2) var<storage, read_write> patches: array<Patch>;
@group(0) @binding(3) var<storage, read_write> args: array<u32>;
@group(0) @binding(4) var<uniform> params: vec4u;

var<workgroup> sums: array<vec2u, 256>;
var<workgroup> kept: array<u32, 256>;

@compute @workgroup_size(256)
fn scanPatches(@builtin(local_invocation_index) t: u32) {
    let n = params.x;
    let per = (n + 255u) / 256u;
    let first = min(t * per, n);
    let last = min(first + per, n);
    var sum = vec2u(0u);
    for (var i = first; i < last; i++) {
        sum += counts[i];
    }
    sums[t] = sum;
    workgroupBarrier();
    for (var d = 1u; d < 256u; d <<= 1u) {
        var add = vec2u(0u);
        if (t >= d) {
            add = sums[t - d];
        }
        workgroupBarrier();
        sums[t] += add;
        workgroupBarrier();
    }
    var run = vec2u(0u);
    if (t > 0u) {
        run = sums[t - 1u];
    }
    var end = 0u;
    for (var i = first; i < last; i++) {
        let next = run + counts[i];
        offsets[i] = run;
        if (next.x > params.z || next.y > params.w) {
            patches[i].f0 = vec4f(0.0);
        } else {
            end = next.y;
        }
        run = next;
    }
    kept[t] = end;
    workgroupBarrier();
    if (t == 0u) {
        var drawn = 0u;
        for (var i = 0u; i < 256u; i++) {
            drawn = max(drawn, kept[i]);
        }
        args[0] = drawn;
        args[1] = 1u;
        args[2] = 0u;
        args[3] = 0u;
        args[4] = sums[255].x;
        args[5] = sums[255].y;
    }
}
`;

/** The bindings of the pass before an indirect draw through the tessellator. */
export const TESS_INDIRECT_BINDINGS = Object.freeze({ io: 0, given: 1 });

/**
 * Words of an indirect draw's block (`TESS_INDIRECT_WGSL`): the uniforms of
 * the passes after it where the host's direct draw has them (sixty-four
 * words a slot), then what the pass writes besides and reads.
 */
export const TESS_INDIRECT_AT = Object.freeze({
    /** The vertex program's three dispatch counts, then the patch passes'. */
    vertexGrid: 320, patchGrid: 324,
    /** The program's arguments, copied in before the pass. */
    args: 328,
    /** The patches the arguments asked for, kept or not. */
    asked: 336,
    words: 384,
});

/**
 * Before an indirect draw through the tessellator: its arguments, which only
 * the GPU has, made into what the passes after it read - the vertex program's
 * counts and starts, the patches and room the hull, tessellator and domain
 * passes take, and the passes' dispatch counts - with the patches cut to the
 * room the host gave its buffers (`given`'s fourth slot: points a patch,
 * whether indexed, the room in patches, a patch's most points and indices,
 * the room in points and indices) and how many were asked kept for the host
 * to read back. The vertex program's stream words are the host's, copied.
 */
export const TESS_INDIRECT_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> io: array<u32>;
@group(0) @binding(1) var<uniform> given: array<vec4u, 80>;

fn givenWord(i: u32) -> u32 {
    return given[i / 4u][i % 4u];
}

@compute @workgroup_size(1)
fn indirectPatches() {
    for (var i = 8u; i < 128u; i++) {
        io[i] = givenWord(i);
    }
    let points = givenWord(192u);
    let indexed = givenWord(193u);
    let room = givenWord(194u);
    let count = io[${TESS_INDIRECT_AT.args}u];
    let instances = io[${TESS_INDIRECT_AT.args + 1}u];
    let start = io[${TESS_INDIRECT_AT.args + 2}u];
    var base = 0u;
    var first = io[${TESS_INDIRECT_AT.args + 3}u];
    if (indexed != 0u) {
        base = io[${TESS_INDIRECT_AT.args + 3}u];
        first = io[${TESS_INDIRECT_AT.args + 4}u];
    }
    let perInstance = count / points;
    var asked = 0u;
    if (perInstance != 0u && instances != 0u) {
        asked = select(perInstance * instances, 0xffffffffu,
            instances > 0xffffffffu / perInstance);
    }
    let patches = min(asked, room);
    io[0] = patches * points;
    io[1] = perInstance * points;
    io[2] = givenWord(2u);
    io[3] = givenWord(3u);
    io[4] = start;
    io[5] = base;
    io[6] = first;
    io[7] = 0u;
    io[128] = patches;
    io[129] = perInstance;
    io[130] = min(givenWord(197u), patches * givenWord(195u));
    io[131] = min(givenWord(198u), patches * givenWord(196u));
    io[192] = patches;
    io[193] = 0u;
    io[256] = patches;
    io[257] = 1u;
    io[${TESS_INDIRECT_AT.vertexGrid}u] = (patches * points + 63u) / 64u;
    io[${TESS_INDIRECT_AT.vertexGrid + 1}u] = 1u;
    io[${TESS_INDIRECT_AT.vertexGrid + 2}u] = 1u;
    io[${TESS_INDIRECT_AT.patchGrid}u] = (patches + 63u) / 64u;
    io[${TESS_INDIRECT_AT.patchGrid + 1}u] = 1u;
    io[${TESS_INDIRECT_AT.patchGrid + 2}u] = 1u;
    io[${TESS_INDIRECT_AT.asked}u] = asked;
}
`;
