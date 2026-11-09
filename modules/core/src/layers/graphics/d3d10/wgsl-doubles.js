/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Shader Model 5's double precision, in WGSL, which has none.
 *
 * A double is the two dwords a register keeps it in, `vec2<u32>(low, high)`,
 * and every operation is IEEE 754 binary64 worked out on them in integers:
 * the significands as 64- and 128-bit numbers in u32 limbs, rounded to
 * nearest, ties to even, once, with denormals kept as they are. What Direct3D
 * answers for a double therefore does not depend on the GPU's float units at
 * all, and a test can run these very functions on the CPU (`wgsl-run.js`) and
 * hold them against JavaScript's own doubles.
 *
 * The functions keep to a small part of WGSL on purpose - scalars, two- and
 * four-component u32 vectors, `if`, `for`, `select` - so that the runner can
 * read them.
 */

/** @param {string} text @returns {string[]} */
const lines = text=>text.trim().split('\n');

/**
 * Functions a translation calls, written into the module after the ones they
 * call (`needs`), as the translator's own HELPERS are.
 *
 * @type {Readonly<Record<string, { needs: string[], text: string[] }>>}
 */
export const DOUBLE_HELPERS = Object.freeze({
    // 64-bit unsigned integers, vec2<u32>(low, high). A shift by 64 or more
    // is zero; WGSL itself would take the count modulo 32. The shifts are
    // straight-line, selects and no branches: the helpers are inlined at
    // every call, and a GPU's compiler takes far longer over branches.
    u64: {
        needs: [],
        text: lines(`
fn u64Add(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
    let low: u32 = a.x + b.x;
    return vec2<u32>(low, a.y + b.y + select(0u, 1u, low < a.x));
}
fn u64Sub(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
    return vec2<u32>(a.x - b.x, a.y - b.y - select(0u, 1u, a.x < b.x));
}
fn u64Less(a: vec2<u32>, b: vec2<u32>) -> bool {
    return a.y < b.y || (a.y == b.y && a.x < b.x);
}
fn u64Zero(a: vec2<u32>) -> bool {
    return a.x == 0u && a.y == 0u;
}
fn u64Shr(a: vec2<u32>, s: u32) -> vec2<u32> {
    let k: u32 = s & 31u;
    let high: u32 = a.y >> k;
    let low: u32 = (a.x >> k) | ((a.y << 1u) << (31u - k));
    return select(select(vec2<u32>(low, high), vec2<u32>(high, 0u), s >= 32u),
        vec2<u32>(0u, 0u), s >= 64u);
}
fn u64Shl(a: vec2<u32>, s: u32) -> vec2<u32> {
    let k: u32 = s & 31u;
    let low: u32 = a.x << k;
    let high: u32 = (a.y << k) | ((a.x >> 1u) >> (31u - k));
    return select(select(vec2<u32>(low, high), vec2<u32>(0u, low), s >= 32u),
        vec2<u32>(0u, 0u), s >= 64u);
}
fn u64Clz(a: vec2<u32>) -> u32 {
    return select(32u + countLeadingZeros(a.x), countLeadingZeros(a.y), a.y != 0u);
}
fn u64ShrJam(a: vec2<u32>, s: u32) -> vec2<u32> {
    let kept: vec2<u32> = u64Shr(a, s);
    let back: vec2<u32> = u64Shl(kept, s);
    let lost: bool = back.x != a.x || back.y != a.y;
    return vec2<u32>(kept.x | select(0u, 1u, lost), kept.y);
}
fn u64RoundShr(m: vec2<u32>, s: u32) -> vec2<u32> {
    let q: vec2<u32> = u64Shr(m, s);
    let rest: vec2<u32> = u64Sub(m, u64Shl(q, s));
    let half: vec2<u32> = u64Shl(vec2<u32>(1u, 0u), s - 1u);
    let tie: bool = rest.x == half.x && rest.y == half.y;
    let up: bool = s <= 64u && (u64Less(half, rest) || (tie && (q.x & 1u) == 1u));
    return select(q, u64Add(q, vec2<u32>(1u, 0u)), up);
}
fn u32Wide(a: u32, b: u32) -> vec2<u32> {
    let a0: u32 = a & 0xffffu;
    let a1: u32 = a >> 16u;
    let b0: u32 = b & 0xffffu;
    let b1: u32 = b >> 16u;
    let p00: u32 = a0 * b0;
    let p01: u32 = a0 * b1;
    let p10: u32 = a1 * b0;
    let mid: u32 = (p00 >> 16u) + (p01 & 0xffffu) + (p10 & 0xffffu);
    return vec2<u32>((p00 & 0xffffu) | (mid << 16u),
        a1 * b1 + (p01 >> 16u) + (p10 >> 16u) + (mid >> 16u));
}
fn u64Wide(a: vec2<u32>, b: vec2<u32>) -> vec4<u32> {
    let p00: vec2<u32> = u32Wide(a.x, b.x);
    let p01: vec2<u32> = u32Wide(a.x, b.y);
    let p10: vec2<u32> = u32Wide(a.y, b.x);
    let p11: vec2<u32> = u32Wide(a.y, b.y);
    let t: vec2<u32> = u64Add(u64Add(vec2<u32>(p00.y, 0u), vec2<u32>(p01.x, 0u)),
        vec2<u32>(p10.x, 0u));
    let u: vec2<u32> = u64Add(u64Add(u64Add(vec2<u32>(t.y, 0u), vec2<u32>(p01.y, 0u)),
        vec2<u32>(p10.y, 0u)), vec2<u32>(p11.x, 0u));
    return vec4<u32>(p00.x, t.x, u.x, p11.y + u.y);
}
`),
    },
    // 128-bit unsigned integers, vec4<u32> from the low limb up: what a
    // fused multiply-add holds its exact product in.
    u128: {
        needs: ['u64'],
        text: lines(`
fn u128Add(a: vec4<u32>, b: vec4<u32>) -> vec4<u32> {
    let low: vec2<u32> = u64Add(a.xy, b.xy);
    let high: vec2<u32> = u64Add(u64Add(a.zw, b.zw),
        vec2<u32>(select(0u, 1u, u64Less(low, a.xy)), 0u));
    return vec4<u32>(low.x, low.y, high.x, high.y);
}
fn u128Sub(a: vec4<u32>, b: vec4<u32>) -> vec4<u32> {
    let low: vec2<u32> = u64Sub(a.xy, b.xy);
    let high: vec2<u32> = u64Sub(u64Sub(a.zw, b.zw),
        vec2<u32>(select(0u, 1u, u64Less(a.xy, b.xy)), 0u));
    return vec4<u32>(low.x, low.y, high.x, high.y);
}
fn u128Less(a: vec4<u32>, b: vec4<u32>) -> bool {
    return u64Less(a.zw, b.zw) || (a.z == b.z && a.w == b.w && u64Less(a.xy, b.xy));
}
fn u128Zero(a: vec4<u32>) -> bool {
    return u64Zero(a.xy) && u64Zero(a.zw);
}
fn u128Clz(a: vec4<u32>) -> u32 {
    return select(64u + u64Clz(a.xy), u64Clz(a.zw), !u64Zero(a.zw));
}
fn u128Shl(a: vec4<u32>, s: u32) -> vec4<u32> {
    let whole: bool = s >= 64u;
    let r: u32 = select(s, s - 64u, whole);
    let low: vec2<u32> = select(a.xy, vec2<u32>(0u, 0u), whole);
    let high: vec2<u32> = select(a.zw, a.xy, whole);
    let shiftedLow: vec2<u32> = u64Shl(low, r);
    let shiftedHigh: vec2<u32> = u64Shl(high, r);
    let carried: vec2<u32> = u64Shr(low, 64u - r);
    return vec4<u32>(shiftedLow.x, shiftedLow.y, shiftedHigh.x | carried.x,
        shiftedHigh.y | carried.y);
}
fn u128ShrJam(a: vec4<u32>, s: u32) -> vec4<u32> {
    let t: u32 = min(s, 128u);
    let whole: bool = t >= 64u;
    let r: u32 = select(t, t - 64u, whole);
    let low: vec2<u32> = select(a.xy, a.zw, whole);
    let high: vec2<u32> = select(a.zw, vec2<u32>(0u, 0u), whole);
    let dropped: bool = whole && !u64Zero(a.xy);
    let shiftedLow: vec2<u32> = u64ShrJam(low, r);
    let carried: vec2<u32> = u64Shl(high, 64u - r);
    let shiftedHigh: vec2<u32> = u64Shr(high, r);
    return vec4<u32>(shiftedLow.x | carried.x | select(0u, 1u, dropped),
        shiftedLow.y | carried.y, shiftedHigh.x, shiftedHigh.y);
}
`),
    },
    // The shapes of a double, and the double nearest a sign, a significand
    // m with bit 63 set and an exponent e: sign * m * 2^(e - 1086), so that
    // e is the biased exponent of a normal result and one at or below zero a
    // denormal. A finite non-zero double unpacks to the same: its m, its e
    // as i32 bits, its sign, a denormal's significand shifted up to bit 63.
    dblCore: {
        needs: ['u64'],
        text: lines(`
fn dblNan(d: vec2<u32>) -> bool {
    return (d.y & 0x7ff00000u) == 0x7ff00000u && ((d.y & 0xfffffu) != 0u || d.x != 0u);
}
fn dblInf(d: vec2<u32>) -> bool {
    return (d.y & 0x7fffffffu) == 0x7ff00000u && d.x == 0u;
}
fn dblZero(d: vec2<u32>) -> bool {
    return (d.y & 0x7fffffffu) == 0u && d.x == 0u;
}
fn dblRound(sign: u32, e: i32, m: vec2<u32>) -> vec2<u32> {
    let denormal: bool = e <= 0i;
    let shift: u32 = select(11u, 11u + u32(min(1i - e, 64i)), denormal);
    let biased: i32 = select(e, 1i, denormal);
    let r: vec2<u32> = u64RoundShr(m, shift);
    return select(vec2<u32>(r.x, sign | ((u32(biased - 1i) << 20u) + r.y)),
        vec2<u32>(0u, sign | 0x7ff00000u), e >= 2047i);
}
fn dblUnpack(d: vec2<u32>) -> vec4<u32> {
    let sign: u32 = d.y & 0x80000000u;
    let field: u32 = (d.y >> 20u) & 0x7ffu;
    let fraction: vec2<u32> = vec2<u32>(d.x, d.y & 0xfffffu);
    let normal: bool = field != 0u;
    let lead: u32 = select(u64Clz(fraction), 11u, normal);
    let m: vec2<u32> = u64Shl(vec2<u32>(fraction.x, fraction.y | select(0u, 0x100000u, normal)),
        lead);
    return vec4<u32>(m.x, m.y, select(bitcast<u32>(12i - i32(lead)), field, normal), sign);
}
`),
    },
    dblAdd: {
        needs: ['dblCore'],
        text: lines(`
fn dblAdd(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
    if (dblNan(a) || dblNan(b)) {
        return vec2<u32>(0u, 0x7ff80000u);
    }
    if (dblInf(a)) {
        if (dblInf(b) && (a.y ^ b.y) >= 0x80000000u) {
            return vec2<u32>(0u, 0x7ff80000u);
        }
        return a;
    }
    if (dblInf(b)) {
        return b;
    }
    if (dblZero(a)) {
        if (dblZero(b)) {
            return vec2<u32>(0u, a.y & b.y);
        }
        return b;
    }
    if (dblZero(b)) {
        return a;
    }
    var x: vec4<u32> = dblUnpack(a);
    var y: vec4<u32> = dblUnpack(b);
    if (bitcast<i32>(y.z) > bitcast<i32>(x.z)
        || (y.z == x.z && u64Less(x.xy, y.xy))) {
        let t: vec4<u32> = x;
        x = y;
        y = t;
    }
    var e: i32 = bitcast<i32>(x.z);
    let small: vec2<u32> = u64ShrJam(y.xy, u32(e - bitcast<i32>(y.z)));
    var m: vec2<u32> = vec2<u32>(0u, 0u);
    if (x.w == y.w) {
        m = u64Add(x.xy, small);
        if (u64Less(m, x.xy)) {
            m = u64ShrJam(m, 1u);
            m = vec2<u32>(m.x, m.y | 0x80000000u);
            e = e + 1i;
        }
    } else {
        m = u64Sub(x.xy, small);
        if (u64Zero(m)) {
            return vec2<u32>(0u, 0u);
        }
        let lead: u32 = u64Clz(m);
        m = u64Shl(m, lead);
        e = e - i32(lead);
    }
    return dblRound(x.w, e, m);
}
`),
    },
    dblMul: {
        needs: ['dblCore'],
        text: lines(`
fn dblMul(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
    let sign: u32 = (a.y ^ b.y) & 0x80000000u;
    if (dblNan(a) || dblNan(b)) {
        return vec2<u32>(0u, 0x7ff80000u);
    }
    if (dblInf(a) || dblInf(b)) {
        if (dblZero(a) || dblZero(b)) {
            return vec2<u32>(0u, 0x7ff80000u);
        }
        return vec2<u32>(0u, sign | 0x7ff00000u);
    }
    if (dblZero(a) || dblZero(b)) {
        return vec2<u32>(0u, sign);
    }
    let x: vec4<u32> = dblUnpack(a);
    let y: vec4<u32> = dblUnpack(b);
    let p: vec4<u32> = u64Wide(x.xy, y.xy);
    var e: i32 = bitcast<i32>(x.z) + bitcast<i32>(y.z) - 1022i;
    var top: vec2<u32> = p.zw;
    var sticky: bool = !u64Zero(p.xy);
    if ((p.w & 0x80000000u) == 0u) {
        top = vec2<u32>((p.z << 1u) | (p.y >> 31u), (p.w << 1u) | (p.z >> 31u));
        sticky = (p.y & 0x7fffffffu) != 0u || p.x != 0u;
        e = e - 1i;
    }
    return dblRound(sign, e, vec2<u32>(top.x | select(0u, 1u, sticky), top.y));
}
`),
    },
    // The quotient a bit at a time, 64 of them, the remainder its sticky bit.
    dblDiv: {
        needs: ['dblCore'],
        text: lines(`
fn dblDiv(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
    let sign: u32 = (a.y ^ b.y) & 0x80000000u;
    if (dblNan(a) || dblNan(b) || (dblInf(a) && dblInf(b)) || (dblZero(a) && dblZero(b))) {
        return vec2<u32>(0u, 0x7ff80000u);
    }
    if (dblInf(a) || dblZero(b)) {
        return vec2<u32>(0u, sign | 0x7ff00000u);
    }
    if (dblInf(b) || dblZero(a)) {
        return vec2<u32>(0u, sign);
    }
    let x: vec4<u32> = dblUnpack(a);
    let y: vec4<u32> = dblUnpack(b);
    var n: vec2<u32> = u64Shr(x.xy, 2u);
    let d: vec2<u32> = u64Shr(y.xy, 2u);
    var e: i32 = bitcast<i32>(x.z) - bitcast<i32>(y.z) + 1023i;
    if (u64Less(n, d)) {
        n = u64Shl(n, 1u);
        e = e - 1i;
    }
    var q: vec2<u32> = vec2<u32>(0u, 0u);
    for (var i: u32 = 0u; i < 64u; i = i + 1u) {
        q = u64Shl(q, 1u);
        if (!u64Less(n, d)) {
            n = u64Sub(n, d);
            q = vec2<u32>(q.x | 1u, q.y);
        }
        n = u64Shl(n, 1u);
    }
    return dblRound(sign, e, vec2<u32>(q.x | select(0u, 1u, !u64Zero(n)), q.y));
}
`),
    },
    // a * b + c rounded once: the product exact in 128 bits, c added at its
    // place, the sum's top 64 bits rounded with the rest as the sticky bit.
    dblFma: {
        needs: ['dblCore', 'u128'],
        text: lines(`
fn dblFma(a: vec2<u32>, b: vec2<u32>, c: vec2<u32>) -> vec2<u32> {
    let productSign: u32 = (a.y ^ b.y) & 0x80000000u;
    if (dblNan(a) || dblNan(b) || dblNan(c)) {
        return vec2<u32>(0u, 0x7ff80000u);
    }
    if (dblInf(a) || dblInf(b)) {
        if (dblZero(a) || dblZero(b)
            || (dblInf(c) && (c.y & 0x80000000u) != productSign)) {
            return vec2<u32>(0u, 0x7ff80000u);
        }
        return vec2<u32>(0u, productSign | 0x7ff00000u);
    }
    if (dblInf(c)) {
        return c;
    }
    if (dblZero(a) || dblZero(b)) {
        if (dblZero(c)) {
            return vec2<u32>(0u, productSign & c.y);
        }
        return c;
    }
    let x: vec4<u32> = dblUnpack(a);
    let y: vec4<u32> = dblUnpack(b);
    // A zero addend is placed far below the product, where it adds nothing.
    var z: vec4<u32> = vec4<u32>(0u, 0u, bitcast<u32>(-2000i), 0u);
    if (!dblZero(c)) {
        z = dblUnpack(c);
    }
    var big: vec4<u32> = u64Wide(x.xy, y.xy);
    var bigE: i32 = bitcast<i32>(x.z) + bitcast<i32>(y.z) - 1022i;
    var bigSign: u32 = productSign;
    if ((big.w & 0x80000000u) == 0u) {
        big = u128Shl(big, 1u);
        bigE = bigE - 1i;
    }
    var small: vec4<u32> = vec4<u32>(0u, 0u, z.x, z.y);
    var smallE: i32 = bitcast<i32>(z.z);
    var smallSign: u32 = z.w;
    if (smallE > bigE || (smallE == bigE && u128Less(big, small))) {
        let t: vec4<u32> = big;
        big = small;
        small = t;
        let te: i32 = bigE;
        bigE = smallE;
        smallE = te;
        let ts: u32 = bigSign;
        bigSign = smallSign;
        smallSign = ts;
    }
    let aligned: vec4<u32> = u128ShrJam(small, u32(bigE - smallE));
    var sum: vec4<u32> = vec4<u32>(0u, 0u, 0u, 0u);
    var e: i32 = bigE;
    if (bigSign == smallSign) {
        sum = u128Add(big, aligned);
        if (u128Less(sum, big)) {
            sum = u128ShrJam(sum, 1u);
            sum = vec4<u32>(sum.x, sum.y, sum.z, sum.w | 0x80000000u);
            e = e + 1i;
        }
    } else {
        sum = u128Sub(big, aligned);
        if (u128Zero(sum)) {
            return vec2<u32>(0u, 0u);
        }
        let lead: u32 = u128Clz(sum);
        sum = u128Shl(sum, lead);
        e = e - i32(lead);
    }
    return dblRound(bigSign, e, vec2<u32>(sum.z | select(0u, 1u, !u64Zero(sum.xy)), sum.w));
}
`),
    },
    // Ordered comparisons: a NaN is equal to nothing and neither below nor
    // above anything; the two zeros are equal.
    dblCompare: {
        needs: ['dblCore'],
        text: lines(`
fn dblEqual(a: vec2<u32>, b: vec2<u32>) -> bool {
    if (dblNan(a) || dblNan(b)) {
        return false;
    }
    return (dblZero(a) && dblZero(b)) || (a.x == b.x && a.y == b.y);
}
fn dblLess(a: vec2<u32>, b: vec2<u32>) -> bool {
    if (dblNan(a) || dblNan(b) || (dblZero(a) && dblZero(b))) {
        return false;
    }
    let negativeA: bool = (a.y & 0x80000000u) != 0u;
    let negativeB: bool = (b.y & 0x80000000u) != 0u;
    if (negativeA != negativeB) {
        return negativeA;
    }
    let ma: vec2<u32> = vec2<u32>(a.x, a.y & 0x7fffffffu);
    let mb: vec2<u32> = vec2<u32>(b.x, b.y & 0x7fffffffu);
    if (negativeA) {
        return u64Less(mb, ma);
    }
    return u64Less(ma, mb);
}
fn dblMin(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
    if (dblNan(a)) {
        return b;
    }
    if (dblNan(b)) {
        return a;
    }
    return select(b, a, dblLess(a, b));
}
fn dblMax(a: vec2<u32>, b: vec2<u32>) -> vec2<u32> {
    if (dblNan(a)) {
        return b;
    }
    if (dblNan(b)) {
        return a;
    }
    return select(b, a, dblLess(b, a));
}
fn dblSaturate(d: vec2<u32>) -> vec2<u32> {
    if (dblNan(d) || dblLess(d, vec2<u32>(0u, 0u)) || dblZero(d)) {
        return vec2<u32>(0u, 0u);
    }
    if (dblLess(vec2<u32>(0u, 0x3ff00000u), d)) {
        return vec2<u32>(0u, 0x3ff00000u);
    }
    return d;
}
`),
    },
    // Conversions. To a float: rounded to nearest, ties to even, denormals
    // kept. To an integer: toward zero, a NaN 0, out of range held to the
    // nearest end (a negative to 0 for an unsigned one). From a float or an
    // integer: exact.
    dblConvert: {
        needs: ['dblCore'],
        text: lines(`
fn dblToFloat(d: vec2<u32>) -> u32 {
    let sign: u32 = d.y & 0x80000000u;
    if (dblNan(d)) {
        return 0x7fc00000u;
    }
    if (dblInf(d)) {
        return sign | 0x7f800000u;
    }
    if (dblZero(d)) {
        return sign;
    }
    let x: vec4<u32> = dblUnpack(d);
    let e: i32 = bitcast<i32>(x.z) - 896i;
    if (e >= 255i) {
        return sign | 0x7f800000u;
    }
    var shift: u32 = 40u;
    var biased: i32 = e;
    if (e <= 0i) {
        shift = 40u + u32(min(1i - e, 64i));
        biased = 1i;
    }
    let r: vec2<u32> = u64RoundShr(x.xy, shift);
    return sign | ((u32(biased - 1i) << 23u) + r.x);
}
fn dblToInt(d: vec2<u32>) -> u32 {
    let negative: bool = (d.y & 0x80000000u) != 0u;
    if (dblNan(d) || dblZero(d)) {
        return 0u;
    }
    let limit: u32 = select(0x7fffffffu, 0x80000000u, negative);
    if (dblInf(d)) {
        return limit;
    }
    let x: vec4<u32> = dblUnpack(d);
    let e: i32 = bitcast<i32>(x.z);
    if (e < 1023i) {
        return 0u;
    }
    if (e >= 1054i) {
        return limit;
    }
    let whole: u32 = u64Shr(x.xy, u32(1086i - e)).x;
    return select(whole, 0u - whole, negative);
}
fn dblToUint(d: vec2<u32>) -> u32 {
    if (dblNan(d) || dblZero(d) || (d.y & 0x80000000u) != 0u) {
        return 0u;
    }
    if (dblInf(d)) {
        return 0xffffffffu;
    }
    let x: vec4<u32> = dblUnpack(d);
    let e: i32 = bitcast<i32>(x.z);
    if (e < 1023i) {
        return 0u;
    }
    if (e >= 1055i) {
        return 0xffffffffu;
    }
    return u64Shr(x.xy, u32(1086i - e)).x;
}
fn dblFromMagnitude(sign: u32, magnitude: u32) -> vec2<u32> {
    if (magnitude == 0u) {
        return vec2<u32>(0u, sign);
    }
    let lead: u32 = countLeadingZeros(magnitude);
    return dblRound(sign, 1054i - i32(lead), vec2<u32>(0u, magnitude << lead));
}
fn dblFromInt(i: u32) -> vec2<u32> {
    let sign: u32 = i & 0x80000000u;
    return dblFromMagnitude(sign, select(i, 0u - i, sign != 0u));
}
fn dblFromUint(u: u32) -> vec2<u32> {
    return dblFromMagnitude(0u, u);
}
fn dblFromFloat(f: u32) -> vec2<u32> {
    let sign: u32 = f & 0x80000000u;
    let field: u32 = (f >> 23u) & 0xffu;
    let fraction: u32 = f & 0x7fffffu;
    if (field == 0xffu) {
        if (fraction != 0u) {
            return vec2<u32>(0u, 0x7ff80000u);
        }
        return vec2<u32>(0u, sign | 0x7ff00000u);
    }
    if (field == 0u) {
        if (fraction == 0u) {
            return vec2<u32>(0u, sign);
        }
        let lead: u32 = countLeadingZeros(fraction);
        return dblRound(sign, 905i - i32(lead), vec2<u32>(0u, fraction << lead));
    }
    return vec2<u32>(fraction << 29u, sign | ((field + 896u) << 20u) | (fraction >> 3u));
}
`),
    },
});
