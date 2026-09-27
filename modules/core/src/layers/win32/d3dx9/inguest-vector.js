/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * d3dx9's vectors, planes and colours as code in the guest's own d3dx9,
 * written once: each `@guestCode` function here is compiled by the build
 * (`scripts/guest-code/compile.mjs`) into `inguest-vector.x86.js`, and is
 * itself the export's handler and the reference its x86 is held to.
 *
 * As in `inguest.js`: floats are read, computed on the x87 under the
 * precision control the program set, and stored rounded to nearest; every
 * input is read before the output is written, and an array's element before
 * its output -- but for D3DXPlaneFromPointNormal, which the library writes
 * as it reads. A vector is a row on a row-major matrix's left, a plane
 * (a, b, c, d) a four-vector too. Normalising a vector or a plane of length 0
 * leaves it zero. A point transformed to a w of 0 is divided by 1, as
 * D3DXVec3TransformCoord's is.
 */

/** @typedef {import('../msvcrt/guest-code.js').Guest} Guest */
/** @typedef {import('../msvcrt/guest-code.js').u32} u32 */
/** @typedef {import('../msvcrt/guest-code.js').f32} f32 */
/** @typedef {import('../msvcrt/guest-code.js').f64} f64 */

/** The luminance weights D3DXColorAdjustSaturation greys a colour by, as floats. */
const GREY_R = 0.21250000596046448;
const GREY_G = 0.715399980545044;
const GREY_B = 0.07209999859333038;

/** The reciprocal of a length, or 0 for a length of 0: what normalising multiplies by. */
const inverseOf = (/** @type {number} */ length)=>(length === 0 ? 0 : 1 / length);

/** A w a point is divided by: itself, or 1 for 0. */
const divisorOf = (/** @type {number} */ w)=>(w === 0 ? 1 : w);

/** Hermite's weights at s, of the first point, its tangent, the second point, its tangent. */
const hermite1 = (/** @type {number} */ s)=>2 * s * s * s - 3 * s * s + 1;
const hermite2 = (/** @type {number} */ s)=>s * s * s - 2 * s * s + s;
const hermite3 = (/** @type {number} */ s)=>-2 * s * s * s + 3 * s * s;
const hermite4 = (/** @type {number} */ s)=>s * s * s - s * s;

/**
 * Catmull-Rom's spline through p1 and p2 at s, p0 and p3 before and after:
 * (2 p1 + (p2 - p0) s + (2 p0 - 5 p1 + 4 p2 - p3) s^2 + (3 p1 - p0 - 3 p2 + p3) s^3) / 2.
 *
 * @param {number} p0 @param {number} p1 @param {number} p2 @param {number} p3 @param {number} s
 */
const catmullRom = (p0, p1, p2, p3, s)=>0.5 * (2 * p1 + (p2 - p0) * s
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * s * s + (3 * p1 - p0 - 3 * p2 + p3) * s * s * s);

/**
 * D3DXVECTOR2 *D3DXVec2Normalize(D3DXVECTOR2 *out, const D3DXVECTOR2 *v)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v
 * @returns {u32}
 */
export function D3DXVec2Normalize({ f32, setF32 }, out, v){
    const x = f32(v);
    const y = f32(v + 4);
    const scale = inverseOf(Math.sqrt(x * x + y * y));
    setF32(out, x * scale);
    setF32(out + 4, y * scale);
    return out;
}

/**
 * D3DXVECTOR4 *D3DXVec4Normalize(D3DXVECTOR4 *out, const D3DXVECTOR4 *v)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v
 * @returns {u32}
 */
export function D3DXVec4Normalize({ f32, setF32 }, out, v){
    const x = f32(v);
    const y = f32(v + 4);
    const z = f32(v + 8);
    const w = f32(v + 12);
    const scale = inverseOf(Math.sqrt(x * x + y * y + z * z + w * w));
    setF32(out, x * scale);
    setF32(out + 4, y * scale);
    setF32(out + 8, z * scale);
    setF32(out + 12, w * scale);
    return out;
}

/**
 * D3DXVECTOR2 *D3DXVec2Hermite(D3DXVECTOR2 *out, const D3DXVECTOR2 *v1, const D3DXVECTOR2 *t1,
 *     const D3DXVECTOR2 *v2, const D3DXVECTOR2 *t2, FLOAT s) -- the cubic from v1 to v2
 * with the tangents t1 and t2.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v1 @param {u32} t1 @param {u32} v2
 * @param {u32} t2 @param {f32} s
 * @returns {u32}
 */
export function D3DXVec2Hermite({ f32, setF32 }, out, v1, t1, v2, t2, s){
    const h1 = hermite1(s);
    const h2 = hermite2(s);
    const h3 = hermite3(s);
    const h4 = hermite4(s);
    const x = h1 * f32(v1) + h2 * f32(t1)
        + h3 * f32(v2) + h4 * f32(t2);
    const y = h1 * f32(v1 + 4) + h2 * f32(t1 + 4)
        + h3 * f32(v2 + 4) + h4 * f32(t2 + 4);
    setF32(out, x);
    setF32(out + 4, y);
    return out;
}

/**
 * D3DXVECTOR2 *D3DXVec2CatmullRom(D3DXVECTOR2 *out, const D3DXVECTOR2 *v0, const D3DXVECTOR2 *v1,
 *     const D3DXVECTOR2 *v2, const D3DXVECTOR2 *v3, FLOAT s)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v0 @param {u32} v1 @param {u32} v2
 * @param {u32} v3 @param {f32} s
 * @returns {u32}
 */
export function D3DXVec2CatmullRom({ f32, setF32 }, out, v0, v1, v2, v3, s){
    const x = catmullRom(f32(v0), f32(v1), f32(v2),
        f32(v3), s);
    const y = catmullRom(f32(v0 + 4), f32(v1 + 4), f32(v2 + 4),
        f32(v3 + 4), s);
    setF32(out, x);
    setF32(out + 4, y);
    return out;
}

/**
 * D3DXVECTOR2 *D3DXVec2BaryCentric(D3DXVECTOR2 *out, const D3DXVECTOR2 *v1, const D3DXVECTOR2 *v2,
 *     const D3DXVECTOR2 *v3, FLOAT f, FLOAT g) -- v1 + f (v2 - v1) + g (v3 - v1).
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v1 @param {u32} v2 @param {u32} v3
 * @param {f32} f @param {f32} g
 * @returns {u32}
 */
export function D3DXVec2BaryCentric({ f32, setF32 }, out, v1, v2, v3, f, g){
    const x1 = f32(v1);
    const y1 = f32(v1 + 4);
    const x = x1 + f * (f32(v2) - x1)
        + g * (f32(v3) - x1);
    const y = y1 + f * (f32(v2 + 4) - y1)
        + g * (f32(v3 + 4) - y1);
    setF32(out, x);
    setF32(out + 4, y);
    return out;
}

/**
 * D3DXVECTOR3 *D3DXVec3Hermite(D3DXVECTOR3 *out, const D3DXVECTOR3 *v1, const D3DXVECTOR3 *t1,
 *     const D3DXVECTOR3 *v2, const D3DXVECTOR3 *t2, FLOAT s) -- the cubic from v1 to v2
 * with the tangents t1 and t2.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v1 @param {u32} t1 @param {u32} v2
 * @param {u32} t2 @param {f32} s
 * @returns {u32}
 */
export function D3DXVec3Hermite({ f32, setF32 }, out, v1, t1, v2, t2, s){
    const h1 = hermite1(s);
    const h2 = hermite2(s);
    const h3 = hermite3(s);
    const h4 = hermite4(s);
    const x = h1 * f32(v1) + h2 * f32(t1)
        + h3 * f32(v2) + h4 * f32(t2);
    const y = h1 * f32(v1 + 4) + h2 * f32(t1 + 4)
        + h3 * f32(v2 + 4) + h4 * f32(t2 + 4);
    const z = h1 * f32(v1 + 8) + h2 * f32(t1 + 8)
        + h3 * f32(v2 + 8) + h4 * f32(t2 + 8);
    setF32(out, x);
    setF32(out + 4, y);
    setF32(out + 8, z);
    return out;
}

/**
 * D3DXVECTOR3 *D3DXVec3CatmullRom(D3DXVECTOR3 *out, const D3DXVECTOR3 *v0, const D3DXVECTOR3 *v1,
 *     const D3DXVECTOR3 *v2, const D3DXVECTOR3 *v3, FLOAT s)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v0 @param {u32} v1 @param {u32} v2
 * @param {u32} v3 @param {f32} s
 * @returns {u32}
 */
export function D3DXVec3CatmullRom({ f32, setF32 }, out, v0, v1, v2, v3, s){
    const x = catmullRom(f32(v0), f32(v1), f32(v2),
        f32(v3), s);
    const y = catmullRom(f32(v0 + 4), f32(v1 + 4), f32(v2 + 4),
        f32(v3 + 4), s);
    const z = catmullRom(f32(v0 + 8), f32(v1 + 8), f32(v2 + 8),
        f32(v3 + 8), s);
    setF32(out, x);
    setF32(out + 4, y);
    setF32(out + 8, z);
    return out;
}

/**
 * D3DXVECTOR3 *D3DXVec3BaryCentric(D3DXVECTOR3 *out, const D3DXVECTOR3 *v1, const D3DXVECTOR3 *v2,
 *     const D3DXVECTOR3 *v3, FLOAT f, FLOAT g) -- v1 + f (v2 - v1) + g (v3 - v1).
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v1 @param {u32} v2 @param {u32} v3
 * @param {f32} f @param {f32} g
 * @returns {u32}
 */
export function D3DXVec3BaryCentric({ f32, setF32 }, out, v1, v2, v3, f, g){
    const x1 = f32(v1);
    const y1 = f32(v1 + 4);
    const z1 = f32(v1 + 8);
    const x = x1 + f * (f32(v2) - x1)
        + g * (f32(v3) - x1);
    const y = y1 + f * (f32(v2 + 4) - y1)
        + g * (f32(v3 + 4) - y1);
    const z = z1 + f * (f32(v2 + 8) - z1)
        + g * (f32(v3 + 8) - z1);
    setF32(out, x);
    setF32(out + 4, y);
    setF32(out + 8, z);
    return out;
}

/**
 * D3DXVECTOR4 *D3DXVec4Hermite(D3DXVECTOR4 *out, const D3DXVECTOR4 *v1, const D3DXVECTOR4 *t1,
 *     const D3DXVECTOR4 *v2, const D3DXVECTOR4 *t2, FLOAT s) -- the cubic from v1 to v2
 * with the tangents t1 and t2.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v1 @param {u32} t1 @param {u32} v2
 * @param {u32} t2 @param {f32} s
 * @returns {u32}
 */
export function D3DXVec4Hermite({ f32, setF32 }, out, v1, t1, v2, t2, s){
    const h1 = hermite1(s);
    const h2 = hermite2(s);
    const h3 = hermite3(s);
    const h4 = hermite4(s);
    const x = h1 * f32(v1) + h2 * f32(t1)
        + h3 * f32(v2) + h4 * f32(t2);
    const y = h1 * f32(v1 + 4) + h2 * f32(t1 + 4)
        + h3 * f32(v2 + 4) + h4 * f32(t2 + 4);
    const z = h1 * f32(v1 + 8) + h2 * f32(t1 + 8)
        + h3 * f32(v2 + 8) + h4 * f32(t2 + 8);
    const w = h1 * f32(v1 + 12) + h2 * f32(t1 + 12)
        + h3 * f32(v2 + 12) + h4 * f32(t2 + 12);
    setF32(out, x);
    setF32(out + 4, y);
    setF32(out + 8, z);
    setF32(out + 12, w);
    return out;
}

/**
 * D3DXVECTOR4 *D3DXVec4CatmullRom(D3DXVECTOR4 *out, const D3DXVECTOR4 *v0, const D3DXVECTOR4 *v1,
 *     const D3DXVECTOR4 *v2, const D3DXVECTOR4 *v3, FLOAT s)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v0 @param {u32} v1 @param {u32} v2
 * @param {u32} v3 @param {f32} s
 * @returns {u32}
 */
export function D3DXVec4CatmullRom({ f32, setF32 }, out, v0, v1, v2, v3, s){
    const x = catmullRom(f32(v0), f32(v1), f32(v2),
        f32(v3), s);
    const y = catmullRom(f32(v0 + 4), f32(v1 + 4), f32(v2 + 4),
        f32(v3 + 4), s);
    const z = catmullRom(f32(v0 + 8), f32(v1 + 8), f32(v2 + 8),
        f32(v3 + 8), s);
    const w = catmullRom(f32(v0 + 12), f32(v1 + 12), f32(v2 + 12),
        f32(v3 + 12), s);
    setF32(out, x);
    setF32(out + 4, y);
    setF32(out + 8, z);
    setF32(out + 12, w);
    return out;
}

/**
 * D3DXVECTOR4 *D3DXVec4BaryCentric(D3DXVECTOR4 *out, const D3DXVECTOR4 *v1, const D3DXVECTOR4 *v2,
 *     const D3DXVECTOR4 *v3, FLOAT f, FLOAT g) -- v1 + f (v2 - v1) + g (v3 - v1).
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v1 @param {u32} v2 @param {u32} v3
 * @param {f32} f @param {f32} g
 * @returns {u32}
 */
export function D3DXVec4BaryCentric({ f32, setF32 }, out, v1, v2, v3, f, g){
    const x1 = f32(v1);
    const y1 = f32(v1 + 4);
    const z1 = f32(v1 + 8);
    const w1 = f32(v1 + 12);
    const x = x1 + f * (f32(v2) - x1)
        + g * (f32(v3) - x1);
    const y = y1 + f * (f32(v2 + 4) - y1)
        + g * (f32(v3 + 4) - y1);
    const z = z1 + f * (f32(v2 + 8) - z1)
        + g * (f32(v3 + 8) - z1);
    const w = w1 + f * (f32(v2 + 12) - w1)
        + g * (f32(v3 + 12) - w1);
    setF32(out, x);
    setF32(out + 4, y);
    setF32(out + 8, z);
    setF32(out + 12, w);
    return out;
}

/**
 * D3DXVECTOR4 *D3DXVec2Transform(D3DXVECTOR4 *out, const D3DXVECTOR2 *v, const D3DXMATRIX *m)
 * -- the point (x, y, 0, 1).
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v @param {u32} m
 * @returns {u32}
 */
export function D3DXVec2Transform({ f32, setF32 }, out, v, m){
    const vx = f32(v);
    const vy = f32(v + 4);
    const x = vx * f32(m) + vy * f32(m + 16) + f32(m + 48);
    const y = vx * f32(m + 4) + vy * f32(m + 20) + f32(m + 52);
    const z = vx * f32(m + 8) + vy * f32(m + 24) + f32(m + 56);
    const w = vx * f32(m + 12) + vy * f32(m + 28) + f32(m + 60);
    setF32(out, x);
    setF32(out + 4, y);
    setF32(out + 8, z);
    setF32(out + 12, w);
    return out;
}

/**
 * D3DXVECTOR2 *D3DXVec2TransformCoord(D3DXVECTOR2 *out, const D3DXVECTOR2 *v,
 *     const D3DXMATRIX *m) -- the point (x, y, 0, 1) divided by the w it comes
 * to, each rounded to a float first, as D3DXVec3TransformCoord's.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v @param {u32} m
 * @returns {u32}
 */
export function D3DXVec2TransformCoord({ f32, setF32 }, out, v, m){
    const vx = f32(v);
    const vy = f32(v + 4);
    const divisor = divisorOf(Math.fround(vx * f32(m + 12) + vy * f32(m + 28) + f32(m + 60)));
    const x = Math.fround(vx * f32(m) + vy * f32(m + 16) + f32(m + 48));
    const y = Math.fround(vx * f32(m + 4) + vy * f32(m + 20) + f32(m + 52));
    setF32(out, x / divisor);
    setF32(out + 4, y / divisor);
    return out;
}

/**
 * D3DXVECTOR2 *D3DXVec2TransformNormal(D3DXVECTOR2 *out, const D3DXVECTOR2 *v,
 *     const D3DXMATRIX *m) -- the direction (x, y, 0, 0).
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v @param {u32} m
 * @returns {u32}
 */
export function D3DXVec2TransformNormal({ f32, setF32 }, out, v, m){
    const vx = f32(v);
    const vy = f32(v + 4);
    const x = vx * f32(m) + vy * f32(m + 16);
    const y = vx * f32(m + 4) + vy * f32(m + 20);
    setF32(out, x);
    setF32(out + 4, y);
    return out;
}

/**
 * D3DXVECTOR4 *D3DXVec2TransformArray(D3DXVECTOR4 *out, UINT outStride,
 *     const D3DXVECTOR2 *v, UINT vStride, const D3DXMATRIX *m, UINT n) -- each
 * vector as D3DXVec2Transform transforms it, the strides in bytes, the matrix
 * read once, before the first.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} outStride @param {u32} v
 * @param {u32} vStride @param {u32} m @param {u32} n
 * @returns {u32}
 */
export function D3DXVec2TransformArray({ f32, setF32 }, out, outStride, v, vStride, m, n){
    const e0 = f32(m);
    const e1 = f32(m + 4);
    const e2 = f32(m + 8);
    const e3 = f32(m + 12);
    const e4 = f32(m + 16);
    const e5 = f32(m + 20);
    const e6 = f32(m + 24);
    const e7 = f32(m + 28);
    const e12 = f32(m + 48);
    const e13 = f32(m + 52);
    const e14 = f32(m + 56);
    const e15 = f32(m + 60);
    /** @type {u32} */
    let to = out;
    /** @type {u32} */
    let from = v;
    for (/** @type {u32} */ let i = 0; i < n; i++)
    {
        const vx = f32(from);
        const vy = f32(from + 4);
        const x = vx * e0 + vy * e4 + e12;
        const y = vx * e1 + vy * e5 + e13;
        const z = vx * e2 + vy * e6 + e14;
        const w = vx * e3 + vy * e7 + e15;
        setF32(to, x);
        setF32(to + 4, y);
        setF32(to + 8, z);
        setF32(to + 12, w);
        to = (to + outStride) >>> 0;
        from = (from + vStride) >>> 0;
    }
    return out;
}

/**
 * D3DXVECTOR2 *D3DXVec2TransformCoordArray(D3DXVECTOR2 *out, UINT outStride,
 *     const D3DXVECTOR2 *v, UINT vStride, const D3DXMATRIX *m, UINT n) -- each
 * vector as D3DXVec2TransformCoord transforms it, the strides in bytes, the matrix
 * read once, before the first.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} outStride @param {u32} v
 * @param {u32} vStride @param {u32} m @param {u32} n
 * @returns {u32}
 */
export function D3DXVec2TransformCoordArray({ f32, setF32 }, out, outStride, v, vStride, m, n){
    const e0 = f32(m);
    const e1 = f32(m + 4);
    const e3 = f32(m + 12);
    const e4 = f32(m + 16);
    const e5 = f32(m + 20);
    const e7 = f32(m + 28);
    const e12 = f32(m + 48);
    const e13 = f32(m + 52);
    const e15 = f32(m + 60);
    /** @type {u32} */
    let to = out;
    /** @type {u32} */
    let from = v;
    for (/** @type {u32} */ let i = 0; i < n; i++)
    {
        const vx = f32(from);
        const vy = f32(from + 4);
        const divisor = divisorOf(Math.fround(vx * e3 + vy * e7 + e15));
        const x = Math.fround(vx * e0 + vy * e4 + e12);
        const y = Math.fround(vx * e1 + vy * e5 + e13);
        setF32(to, x / divisor);
        setF32(to + 4, y / divisor);
        to = (to + outStride) >>> 0;
        from = (from + vStride) >>> 0;
    }
    return out;
}

/**
 * D3DXVECTOR2 *D3DXVec2TransformNormalArray(D3DXVECTOR2 *out, UINT outStride,
 *     const D3DXVECTOR2 *v, UINT vStride, const D3DXMATRIX *m, UINT n) -- each
 * vector as D3DXVec2TransformNormal transforms it, the strides in bytes, the matrix
 * read once, before the first.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} outStride @param {u32} v
 * @param {u32} vStride @param {u32} m @param {u32} n
 * @returns {u32}
 */
export function D3DXVec2TransformNormalArray({ f32, setF32 }, out, outStride, v, vStride, m, n){
    const e0 = f32(m);
    const e1 = f32(m + 4);
    const e4 = f32(m + 16);
    const e5 = f32(m + 20);
    /** @type {u32} */
    let to = out;
    /** @type {u32} */
    let from = v;
    for (/** @type {u32} */ let i = 0; i < n; i++)
    {
        const vx = f32(from);
        const vy = f32(from + 4);
        const x = vx * e0 + vy * e4;
        const y = vx * e1 + vy * e5;
        setF32(to, x);
        setF32(to + 4, y);
        to = (to + outStride) >>> 0;
        from = (from + vStride) >>> 0;
    }
    return out;
}

/**
 * D3DXVECTOR4 *D3DXVec3TransformArray(D3DXVECTOR4 *out, UINT outStride,
 *     const D3DXVECTOR3 *v, UINT vStride, const D3DXMATRIX *m, UINT n) -- each
 * vector as D3DXVec3Transform transforms it, the strides in bytes, the matrix
 * read once, before the first.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} outStride @param {u32} v
 * @param {u32} vStride @param {u32} m @param {u32} n
 * @returns {u32}
 */
export function D3DXVec3TransformArray({ f32, setF32 }, out, outStride, v, vStride, m, n){
    const e0 = f32(m);
    const e1 = f32(m + 4);
    const e2 = f32(m + 8);
    const e3 = f32(m + 12);
    const e4 = f32(m + 16);
    const e5 = f32(m + 20);
    const e6 = f32(m + 24);
    const e7 = f32(m + 28);
    const e8 = f32(m + 32);
    const e9 = f32(m + 36);
    const e10 = f32(m + 40);
    const e11 = f32(m + 44);
    const e12 = f32(m + 48);
    const e13 = f32(m + 52);
    const e14 = f32(m + 56);
    const e15 = f32(m + 60);
    /** @type {u32} */
    let to = out;
    /** @type {u32} */
    let from = v;
    for (/** @type {u32} */ let i = 0; i < n; i++)
    {
        const vx = f32(from);
        const vy = f32(from + 4);
        const vz = f32(from + 8);
        const x = vx * e0 + vy * e4 + vz * e8 + e12;
        const y = vx * e1 + vy * e5 + vz * e9 + e13;
        const z = vx * e2 + vy * e6 + vz * e10 + e14;
        const w = vx * e3 + vy * e7 + vz * e11 + e15;
        setF32(to, x);
        setF32(to + 4, y);
        setF32(to + 8, z);
        setF32(to + 12, w);
        to = (to + outStride) >>> 0;
        from = (from + vStride) >>> 0;
    }
    return out;
}

/**
 * D3DXVECTOR3 *D3DXVec3TransformNormalArray(D3DXVECTOR3 *out, UINT outStride,
 *     const D3DXVECTOR3 *v, UINT vStride, const D3DXMATRIX *m, UINT n) -- each
 * vector as D3DXVec3TransformNormal transforms it, the strides in bytes, the matrix
 * read once, before the first.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} outStride @param {u32} v
 * @param {u32} vStride @param {u32} m @param {u32} n
 * @returns {u32}
 */
export function D3DXVec3TransformNormalArray({ f32, setF32 }, out, outStride, v, vStride, m, n){
    const e0 = f32(m);
    const e1 = f32(m + 4);
    const e2 = f32(m + 8);
    const e4 = f32(m + 16);
    const e5 = f32(m + 20);
    const e6 = f32(m + 24);
    const e8 = f32(m + 32);
    const e9 = f32(m + 36);
    const e10 = f32(m + 40);
    /** @type {u32} */
    let to = out;
    /** @type {u32} */
    let from = v;
    for (/** @type {u32} */ let i = 0; i < n; i++)
    {
        const vx = f32(from);
        const vy = f32(from + 4);
        const vz = f32(from + 8);
        const x = vx * e0 + vy * e4 + vz * e8;
        const y = vx * e1 + vy * e5 + vz * e9;
        const z = vx * e2 + vy * e6 + vz * e10;
        setF32(to, x);
        setF32(to + 4, y);
        setF32(to + 8, z);
        to = (to + outStride) >>> 0;
        from = (from + vStride) >>> 0;
    }
    return out;
}

/**
 * D3DXVECTOR4 *D3DXVec4TransformArray(D3DXVECTOR4 *out, UINT outStride,
 *     const D3DXVECTOR4 *v, UINT vStride, const D3DXMATRIX *m, UINT n) -- each
 * vector as D3DXVec4Transform transforms it, the strides in bytes, the matrix
 * read once, before the first.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} outStride @param {u32} v
 * @param {u32} vStride @param {u32} m @param {u32} n
 * @returns {u32}
 */
export function D3DXVec4TransformArray({ f32, setF32 }, out, outStride, v, vStride, m, n){
    const e0 = f32(m);
    const e1 = f32(m + 4);
    const e2 = f32(m + 8);
    const e3 = f32(m + 12);
    const e4 = f32(m + 16);
    const e5 = f32(m + 20);
    const e6 = f32(m + 24);
    const e7 = f32(m + 28);
    const e8 = f32(m + 32);
    const e9 = f32(m + 36);
    const e10 = f32(m + 40);
    const e11 = f32(m + 44);
    const e12 = f32(m + 48);
    const e13 = f32(m + 52);
    const e14 = f32(m + 56);
    const e15 = f32(m + 60);
    /** @type {u32} */
    let to = out;
    /** @type {u32} */
    let from = v;
    for (/** @type {u32} */ let i = 0; i < n; i++)
    {
        const vx = f32(from);
        const vy = f32(from + 4);
        const vz = f32(from + 8);
        const vw = f32(from + 12);
        const x = vx * e0 + vy * e4 + vz * e8 + vw * e12;
        const y = vx * e1 + vy * e5 + vz * e9 + vw * e13;
        const z = vx * e2 + vy * e6 + vz * e10 + vw * e14;
        const w = vx * e3 + vy * e7 + vz * e11 + vw * e15;
        setF32(to, x);
        setF32(to + 4, y);
        setF32(to + 8, z);
        setF32(to + 12, w);
        to = (to + outStride) >>> 0;
        from = (from + vStride) >>> 0;
    }
    return out;
}

/**
 * D3DXPLANE *D3DXPlaneTransformArray(D3DXPLANE *out, UINT outStride,
 *     const D3DXPLANE *v, UINT vStride, const D3DXMATRIX *m, UINT n) -- each
 * plane as D3DXPlaneTransform transforms it, the strides in bytes, the matrix
 * read once, before the first.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} outStride @param {u32} v
 * @param {u32} vStride @param {u32} m @param {u32} n
 * @returns {u32}
 */
export function D3DXPlaneTransformArray({ f32, setF32 }, out, outStride, v, vStride, m, n){
    const e0 = f32(m);
    const e1 = f32(m + 4);
    const e2 = f32(m + 8);
    const e3 = f32(m + 12);
    const e4 = f32(m + 16);
    const e5 = f32(m + 20);
    const e6 = f32(m + 24);
    const e7 = f32(m + 28);
    const e8 = f32(m + 32);
    const e9 = f32(m + 36);
    const e10 = f32(m + 40);
    const e11 = f32(m + 44);
    const e12 = f32(m + 48);
    const e13 = f32(m + 52);
    const e14 = f32(m + 56);
    const e15 = f32(m + 60);
    /** @type {u32} */
    let to = out;
    /** @type {u32} */
    let from = v;
    for (/** @type {u32} */ let i = 0; i < n; i++)
    {
        const vx = f32(from);
        const vy = f32(from + 4);
        const vz = f32(from + 8);
        const vw = f32(from + 12);
        const x = vx * e0 + vy * e4 + vz * e8 + vw * e12;
        const y = vx * e1 + vy * e5 + vz * e9 + vw * e13;
        const z = vx * e2 + vy * e6 + vz * e10 + vw * e14;
        const w = vx * e3 + vy * e7 + vz * e11 + vw * e15;
        setF32(to, x);
        setF32(to + 4, y);
        setF32(to + 8, z);
        setF32(to + 12, w);
        to = (to + outStride) >>> 0;
        from = (from + vStride) >>> 0;
    }
    return out;
}

/**
 * D3DXVECTOR3 *D3DXVec3Project(D3DXVECTOR3 *out, const D3DXVECTOR3 *v,
 *     const D3DVIEWPORT9 *viewport, const D3DXMATRIX *projection,
 *     const D3DXMATRIX *view, const D3DXMATRIX *world)
 *
 * The point through world, view and projection -- each NULL the identity --
 * as D3DXVec3TransformCoord transforms it, then onto the viewport: x from
 * X across Width, y from Y down Height, z from MinZ to MaxZ; with no
 * viewport the transformed point itself.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v @param {u32} viewport
 * @param {u32} projection @param {u32} view @param {u32} world
 * @returns {u32}
 */
export function D3DXVec3Project({ f32, u32, setF32 }, out, v, viewport, projection, view, world){
    /** @type {f64} */
    let w00 = 1;
    /** @type {f64} */
    let w01 = 0;
    /** @type {f64} */
    let w02 = 0;
    /** @type {f64} */
    let w03 = 0;
    /** @type {f64} */
    let w10 = 0;
    /** @type {f64} */
    let w11 = 1;
    /** @type {f64} */
    let w12 = 0;
    /** @type {f64} */
    let w13 = 0;
    /** @type {f64} */
    let w20 = 0;
    /** @type {f64} */
    let w21 = 0;
    /** @type {f64} */
    let w22 = 1;
    /** @type {f64} */
    let w23 = 0;
    /** @type {f64} */
    let w30 = 0;
    /** @type {f64} */
    let w31 = 0;
    /** @type {f64} */
    let w32 = 0;
    /** @type {f64} */
    let w33 = 1;
    if (world !== 0)
    {
        w00 = f32(world);
        w01 = f32(world + 4);
        w02 = f32(world + 8);
        w03 = f32(world + 12);
        w10 = f32(world + 16);
        w11 = f32(world + 20);
        w12 = f32(world + 24);
        w13 = f32(world + 28);
        w20 = f32(world + 32);
        w21 = f32(world + 36);
        w22 = f32(world + 40);
        w23 = f32(world + 44);
        w30 = f32(world + 48);
        w31 = f32(world + 52);
        w32 = f32(world + 56);
        w33 = f32(world + 60);
    }
    /** @type {f64} */
    let v00 = 1;
    /** @type {f64} */
    let v01 = 0;
    /** @type {f64} */
    let v02 = 0;
    /** @type {f64} */
    let v03 = 0;
    /** @type {f64} */
    let v10 = 0;
    /** @type {f64} */
    let v11 = 1;
    /** @type {f64} */
    let v12 = 0;
    /** @type {f64} */
    let v13 = 0;
    /** @type {f64} */
    let v20 = 0;
    /** @type {f64} */
    let v21 = 0;
    /** @type {f64} */
    let v22 = 1;
    /** @type {f64} */
    let v23 = 0;
    /** @type {f64} */
    let v30 = 0;
    /** @type {f64} */
    let v31 = 0;
    /** @type {f64} */
    let v32 = 0;
    /** @type {f64} */
    let v33 = 1;
    if (view !== 0)
    {
        v00 = f32(view);
        v01 = f32(view + 4);
        v02 = f32(view + 8);
        v03 = f32(view + 12);
        v10 = f32(view + 16);
        v11 = f32(view + 20);
        v12 = f32(view + 24);
        v13 = f32(view + 28);
        v20 = f32(view + 32);
        v21 = f32(view + 36);
        v22 = f32(view + 40);
        v23 = f32(view + 44);
        v30 = f32(view + 48);
        v31 = f32(view + 52);
        v32 = f32(view + 56);
        v33 = f32(view + 60);
    }
    const p00 = w00 * v00 + w01 * v10
        + w02 * v20 + w03 * v30;
    const p01 = w00 * v01 + w01 * v11
        + w02 * v21 + w03 * v31;
    const p02 = w00 * v02 + w01 * v12
        + w02 * v22 + w03 * v32;
    const p03 = w00 * v03 + w01 * v13
        + w02 * v23 + w03 * v33;
    const p10 = w10 * v00 + w11 * v10
        + w12 * v20 + w13 * v30;
    const p11 = w10 * v01 + w11 * v11
        + w12 * v21 + w13 * v31;
    const p12 = w10 * v02 + w11 * v12
        + w12 * v22 + w13 * v32;
    const p13 = w10 * v03 + w11 * v13
        + w12 * v23 + w13 * v33;
    const p20 = w20 * v00 + w21 * v10
        + w22 * v20 + w23 * v30;
    const p21 = w20 * v01 + w21 * v11
        + w22 * v21 + w23 * v31;
    const p22 = w20 * v02 + w21 * v12
        + w22 * v22 + w23 * v32;
    const p23 = w20 * v03 + w21 * v13
        + w22 * v23 + w23 * v33;
    const p30 = w30 * v00 + w31 * v10
        + w32 * v20 + w33 * v30;
    const p31 = w30 * v01 + w31 * v11
        + w32 * v21 + w33 * v31;
    const p32 = w30 * v02 + w31 * v12
        + w32 * v22 + w33 * v32;
    const p33 = w30 * v03 + w31 * v13
        + w32 * v23 + w33 * v33;
    /** @type {f64} */
    let j00 = 1;
    /** @type {f64} */
    let j01 = 0;
    /** @type {f64} */
    let j02 = 0;
    /** @type {f64} */
    let j03 = 0;
    /** @type {f64} */
    let j10 = 0;
    /** @type {f64} */
    let j11 = 1;
    /** @type {f64} */
    let j12 = 0;
    /** @type {f64} */
    let j13 = 0;
    /** @type {f64} */
    let j20 = 0;
    /** @type {f64} */
    let j21 = 0;
    /** @type {f64} */
    let j22 = 1;
    /** @type {f64} */
    let j23 = 0;
    /** @type {f64} */
    let j30 = 0;
    /** @type {f64} */
    let j31 = 0;
    /** @type {f64} */
    let j32 = 0;
    /** @type {f64} */
    let j33 = 1;
    if (projection !== 0)
    {
        j00 = f32(projection);
        j01 = f32(projection + 4);
        j02 = f32(projection + 8);
        j03 = f32(projection + 12);
        j10 = f32(projection + 16);
        j11 = f32(projection + 20);
        j12 = f32(projection + 24);
        j13 = f32(projection + 28);
        j20 = f32(projection + 32);
        j21 = f32(projection + 36);
        j22 = f32(projection + 40);
        j23 = f32(projection + 44);
        j30 = f32(projection + 48);
        j31 = f32(projection + 52);
        j32 = f32(projection + 56);
        j33 = f32(projection + 60);
    }
    const m00 = p00 * j00 + p01 * j10
        + p02 * j20 + p03 * j30;
    const m01 = p00 * j01 + p01 * j11
        + p02 * j21 + p03 * j31;
    const m02 = p00 * j02 + p01 * j12
        + p02 * j22 + p03 * j32;
    const m03 = p00 * j03 + p01 * j13
        + p02 * j23 + p03 * j33;
    const m10 = p10 * j00 + p11 * j10
        + p12 * j20 + p13 * j30;
    const m11 = p10 * j01 + p11 * j11
        + p12 * j21 + p13 * j31;
    const m12 = p10 * j02 + p11 * j12
        + p12 * j22 + p13 * j32;
    const m13 = p10 * j03 + p11 * j13
        + p12 * j23 + p13 * j33;
    const m20 = p20 * j00 + p21 * j10
        + p22 * j20 + p23 * j30;
    const m21 = p20 * j01 + p21 * j11
        + p22 * j21 + p23 * j31;
    const m22 = p20 * j02 + p21 * j12
        + p22 * j22 + p23 * j32;
    const m23 = p20 * j03 + p21 * j13
        + p22 * j23 + p23 * j33;
    const m30 = p30 * j00 + p31 * j10
        + p32 * j20 + p33 * j30;
    const m31 = p30 * j01 + p31 * j11
        + p32 * j21 + p33 * j31;
    const m32 = p30 * j02 + p31 * j12
        + p32 * j22 + p33 * j32;
    const m33 = p30 * j03 + p31 * j13
        + p32 * j23 + p33 * j33;
    const px = f32(v);
    const py = f32(v + 4);
    const pz = f32(v + 8);
    const divisor = divisorOf(Math.fround(px * m03 + py * m13 + pz * m23 + m33));
    const x = Math.fround(Math.fround(px * m00 + py * m10 + pz * m20 + m30) / divisor);
    const y = Math.fround(Math.fround(px * m01 + py * m11 + pz * m21 + m31) / divisor);
    const z = Math.fround(Math.fround(px * m02 + py * m12 + pz * m22 + m32) / divisor);
    if (viewport === 0)
    {
        setF32(out, x);
        setF32(out + 4, y);
        setF32(out + 8, z);
        return out;
    }
    const minZ = f32(viewport + 16);
    setF32(out, u32(viewport) + (1 + x) * u32(viewport + 8) / 2);
    setF32(out + 4, u32(viewport + 4) + (1 - y) * u32(viewport + 12) / 2);
    setF32(out + 8, minZ + z * (f32(viewport + 20) - minZ));
    return out;
}

/**
 * D3DXVECTOR3 *D3DXVec3ProjectArray(D3DXVECTOR3 *out, UINT outStride,
 *     const D3DXVECTOR3 *v, UINT vStride, const D3DVIEWPORT9 *viewport,
 *     const D3DXMATRIX *projection, const D3DXMATRIX *view,
 *     const D3DXMATRIX *world, UINT n) -- each point as D3DXVec3Project
 * projects it, the matrices and the viewport read once, before the first.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} outStride @param {u32} v
 * @param {u32} vStride @param {u32} viewport @param {u32} projection @param {u32} view
 * @param {u32} world @param {u32} n
 * @returns {u32}
 */
export function D3DXVec3ProjectArray({ f32, u32, setF32 }, out, outStride, v, vStride, viewport,
    projection, view, world, n)
{
    /** @type {f64} */
    let w00 = 1;
    /** @type {f64} */
    let w01 = 0;
    /** @type {f64} */
    let w02 = 0;
    /** @type {f64} */
    let w03 = 0;
    /** @type {f64} */
    let w10 = 0;
    /** @type {f64} */
    let w11 = 1;
    /** @type {f64} */
    let w12 = 0;
    /** @type {f64} */
    let w13 = 0;
    /** @type {f64} */
    let w20 = 0;
    /** @type {f64} */
    let w21 = 0;
    /** @type {f64} */
    let w22 = 1;
    /** @type {f64} */
    let w23 = 0;
    /** @type {f64} */
    let w30 = 0;
    /** @type {f64} */
    let w31 = 0;
    /** @type {f64} */
    let w32 = 0;
    /** @type {f64} */
    let w33 = 1;
    if (world !== 0)
    {
        w00 = f32(world);
        w01 = f32(world + 4);
        w02 = f32(world + 8);
        w03 = f32(world + 12);
        w10 = f32(world + 16);
        w11 = f32(world + 20);
        w12 = f32(world + 24);
        w13 = f32(world + 28);
        w20 = f32(world + 32);
        w21 = f32(world + 36);
        w22 = f32(world + 40);
        w23 = f32(world + 44);
        w30 = f32(world + 48);
        w31 = f32(world + 52);
        w32 = f32(world + 56);
        w33 = f32(world + 60);
    }
    /** @type {f64} */
    let v00 = 1;
    /** @type {f64} */
    let v01 = 0;
    /** @type {f64} */
    let v02 = 0;
    /** @type {f64} */
    let v03 = 0;
    /** @type {f64} */
    let v10 = 0;
    /** @type {f64} */
    let v11 = 1;
    /** @type {f64} */
    let v12 = 0;
    /** @type {f64} */
    let v13 = 0;
    /** @type {f64} */
    let v20 = 0;
    /** @type {f64} */
    let v21 = 0;
    /** @type {f64} */
    let v22 = 1;
    /** @type {f64} */
    let v23 = 0;
    /** @type {f64} */
    let v30 = 0;
    /** @type {f64} */
    let v31 = 0;
    /** @type {f64} */
    let v32 = 0;
    /** @type {f64} */
    let v33 = 1;
    if (view !== 0)
    {
        v00 = f32(view);
        v01 = f32(view + 4);
        v02 = f32(view + 8);
        v03 = f32(view + 12);
        v10 = f32(view + 16);
        v11 = f32(view + 20);
        v12 = f32(view + 24);
        v13 = f32(view + 28);
        v20 = f32(view + 32);
        v21 = f32(view + 36);
        v22 = f32(view + 40);
        v23 = f32(view + 44);
        v30 = f32(view + 48);
        v31 = f32(view + 52);
        v32 = f32(view + 56);
        v33 = f32(view + 60);
    }
    const p00 = w00 * v00 + w01 * v10
        + w02 * v20 + w03 * v30;
    const p01 = w00 * v01 + w01 * v11
        + w02 * v21 + w03 * v31;
    const p02 = w00 * v02 + w01 * v12
        + w02 * v22 + w03 * v32;
    const p03 = w00 * v03 + w01 * v13
        + w02 * v23 + w03 * v33;
    const p10 = w10 * v00 + w11 * v10
        + w12 * v20 + w13 * v30;
    const p11 = w10 * v01 + w11 * v11
        + w12 * v21 + w13 * v31;
    const p12 = w10 * v02 + w11 * v12
        + w12 * v22 + w13 * v32;
    const p13 = w10 * v03 + w11 * v13
        + w12 * v23 + w13 * v33;
    const p20 = w20 * v00 + w21 * v10
        + w22 * v20 + w23 * v30;
    const p21 = w20 * v01 + w21 * v11
        + w22 * v21 + w23 * v31;
    const p22 = w20 * v02 + w21 * v12
        + w22 * v22 + w23 * v32;
    const p23 = w20 * v03 + w21 * v13
        + w22 * v23 + w23 * v33;
    const p30 = w30 * v00 + w31 * v10
        + w32 * v20 + w33 * v30;
    const p31 = w30 * v01 + w31 * v11
        + w32 * v21 + w33 * v31;
    const p32 = w30 * v02 + w31 * v12
        + w32 * v22 + w33 * v32;
    const p33 = w30 * v03 + w31 * v13
        + w32 * v23 + w33 * v33;
    /** @type {f64} */
    let j00 = 1;
    /** @type {f64} */
    let j01 = 0;
    /** @type {f64} */
    let j02 = 0;
    /** @type {f64} */
    let j03 = 0;
    /** @type {f64} */
    let j10 = 0;
    /** @type {f64} */
    let j11 = 1;
    /** @type {f64} */
    let j12 = 0;
    /** @type {f64} */
    let j13 = 0;
    /** @type {f64} */
    let j20 = 0;
    /** @type {f64} */
    let j21 = 0;
    /** @type {f64} */
    let j22 = 1;
    /** @type {f64} */
    let j23 = 0;
    /** @type {f64} */
    let j30 = 0;
    /** @type {f64} */
    let j31 = 0;
    /** @type {f64} */
    let j32 = 0;
    /** @type {f64} */
    let j33 = 1;
    if (projection !== 0)
    {
        j00 = f32(projection);
        j01 = f32(projection + 4);
        j02 = f32(projection + 8);
        j03 = f32(projection + 12);
        j10 = f32(projection + 16);
        j11 = f32(projection + 20);
        j12 = f32(projection + 24);
        j13 = f32(projection + 28);
        j20 = f32(projection + 32);
        j21 = f32(projection + 36);
        j22 = f32(projection + 40);
        j23 = f32(projection + 44);
        j30 = f32(projection + 48);
        j31 = f32(projection + 52);
        j32 = f32(projection + 56);
        j33 = f32(projection + 60);
    }
    const m00 = p00 * j00 + p01 * j10
        + p02 * j20 + p03 * j30;
    const m01 = p00 * j01 + p01 * j11
        + p02 * j21 + p03 * j31;
    const m02 = p00 * j02 + p01 * j12
        + p02 * j22 + p03 * j32;
    const m03 = p00 * j03 + p01 * j13
        + p02 * j23 + p03 * j33;
    const m10 = p10 * j00 + p11 * j10
        + p12 * j20 + p13 * j30;
    const m11 = p10 * j01 + p11 * j11
        + p12 * j21 + p13 * j31;
    const m12 = p10 * j02 + p11 * j12
        + p12 * j22 + p13 * j32;
    const m13 = p10 * j03 + p11 * j13
        + p12 * j23 + p13 * j33;
    const m20 = p20 * j00 + p21 * j10
        + p22 * j20 + p23 * j30;
    const m21 = p20 * j01 + p21 * j11
        + p22 * j21 + p23 * j31;
    const m22 = p20 * j02 + p21 * j12
        + p22 * j22 + p23 * j32;
    const m23 = p20 * j03 + p21 * j13
        + p22 * j23 + p23 * j33;
    const m30 = p30 * j00 + p31 * j10
        + p32 * j20 + p33 * j30;
    const m31 = p30 * j01 + p31 * j11
        + p32 * j21 + p33 * j31;
    const m32 = p30 * j02 + p31 * j12
        + p32 * j22 + p33 * j32;
    const m33 = p30 * j03 + p31 * j13
        + p32 * j23 + p33 * j33;
    /** @type {f64} */
    let left = 0;
    /** @type {f64} */
    let top = 0;
    /** @type {f64} */
    let width = 0;
    /** @type {f64} */
    let height = 0;
    /** @type {f64} */
    let minZ = 0;
    /** @type {f64} */
    let depth = 0;
    if (viewport !== 0)
    {
        left = u32(viewport);
        top = u32(viewport + 4);
        width = u32(viewport + 8);
        height = u32(viewport + 12);
        minZ = f32(viewport + 16);
        depth = f32(viewport + 20) - minZ;
    }
    /** @type {u32} */
    let to = out;
    /** @type {u32} */
    let from = v;
    for (/** @type {u32} */ let i = 0; i < n; i++)
    {
        const px = f32(from);
        const py = f32(from + 4);
        const pz = f32(from + 8);
        const divisor = divisorOf(Math.fround(px * m03 + py * m13 + pz * m23 + m33));
        const x = Math.fround(Math.fround(px * m00 + py * m10 + pz * m20 + m30) / divisor);
        const y = Math.fround(Math.fround(px * m01 + py * m11 + pz * m21 + m31) / divisor);
        const z = Math.fround(Math.fround(px * m02 + py * m12 + pz * m22 + m32) / divisor);
        if (viewport === 0)
        {
            setF32(to, x);
            setF32(to + 4, y);
            setF32(to + 8, z);
        }
        else
        {
            setF32(to, left + (1 + x) * width / 2);
            setF32(to + 4, top + (1 - y) * height / 2);
            setF32(to + 8, minZ + z * depth);
        }
        to = (to + outStride) >>> 0;
        from = (from + vStride) >>> 0;
    }
    return out;
}

/**
 * D3DXVECTOR3 *D3DXVec3Unproject(D3DXVECTOR3 *out, const D3DXVECTOR3 *v,
 *     const D3DVIEWPORT9 *viewport, const D3DXMATRIX *projection,
 *     const D3DXMATRIX *view, const D3DXMATRIX *world)
 *
 * D3DXVec3Project undone: the point off the viewport (itself with none)
 * and through the inverse of world, view and projection, as
 * D3DXVec3TransformCoord transforms it. A product that has no inverse
 * answers NULL and writes nothing.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v @param {u32} viewport
 * @param {u32} projection @param {u32} view @param {u32} world
 * @returns {u32}
 */
export function D3DXVec3Unproject({ f32, u32, setF32 }, out, v, viewport, projection, view, world){
    /** @type {f64} */
    let w00 = 1;
    /** @type {f64} */
    let w01 = 0;
    /** @type {f64} */
    let w02 = 0;
    /** @type {f64} */
    let w03 = 0;
    /** @type {f64} */
    let w10 = 0;
    /** @type {f64} */
    let w11 = 1;
    /** @type {f64} */
    let w12 = 0;
    /** @type {f64} */
    let w13 = 0;
    /** @type {f64} */
    let w20 = 0;
    /** @type {f64} */
    let w21 = 0;
    /** @type {f64} */
    let w22 = 1;
    /** @type {f64} */
    let w23 = 0;
    /** @type {f64} */
    let w30 = 0;
    /** @type {f64} */
    let w31 = 0;
    /** @type {f64} */
    let w32 = 0;
    /** @type {f64} */
    let w33 = 1;
    if (world !== 0)
    {
        w00 = f32(world);
        w01 = f32(world + 4);
        w02 = f32(world + 8);
        w03 = f32(world + 12);
        w10 = f32(world + 16);
        w11 = f32(world + 20);
        w12 = f32(world + 24);
        w13 = f32(world + 28);
        w20 = f32(world + 32);
        w21 = f32(world + 36);
        w22 = f32(world + 40);
        w23 = f32(world + 44);
        w30 = f32(world + 48);
        w31 = f32(world + 52);
        w32 = f32(world + 56);
        w33 = f32(world + 60);
    }
    /** @type {f64} */
    let v00 = 1;
    /** @type {f64} */
    let v01 = 0;
    /** @type {f64} */
    let v02 = 0;
    /** @type {f64} */
    let v03 = 0;
    /** @type {f64} */
    let v10 = 0;
    /** @type {f64} */
    let v11 = 1;
    /** @type {f64} */
    let v12 = 0;
    /** @type {f64} */
    let v13 = 0;
    /** @type {f64} */
    let v20 = 0;
    /** @type {f64} */
    let v21 = 0;
    /** @type {f64} */
    let v22 = 1;
    /** @type {f64} */
    let v23 = 0;
    /** @type {f64} */
    let v30 = 0;
    /** @type {f64} */
    let v31 = 0;
    /** @type {f64} */
    let v32 = 0;
    /** @type {f64} */
    let v33 = 1;
    if (view !== 0)
    {
        v00 = f32(view);
        v01 = f32(view + 4);
        v02 = f32(view + 8);
        v03 = f32(view + 12);
        v10 = f32(view + 16);
        v11 = f32(view + 20);
        v12 = f32(view + 24);
        v13 = f32(view + 28);
        v20 = f32(view + 32);
        v21 = f32(view + 36);
        v22 = f32(view + 40);
        v23 = f32(view + 44);
        v30 = f32(view + 48);
        v31 = f32(view + 52);
        v32 = f32(view + 56);
        v33 = f32(view + 60);
    }
    const p00 = w00 * v00 + w01 * v10
        + w02 * v20 + w03 * v30;
    const p01 = w00 * v01 + w01 * v11
        + w02 * v21 + w03 * v31;
    const p02 = w00 * v02 + w01 * v12
        + w02 * v22 + w03 * v32;
    const p03 = w00 * v03 + w01 * v13
        + w02 * v23 + w03 * v33;
    const p10 = w10 * v00 + w11 * v10
        + w12 * v20 + w13 * v30;
    const p11 = w10 * v01 + w11 * v11
        + w12 * v21 + w13 * v31;
    const p12 = w10 * v02 + w11 * v12
        + w12 * v22 + w13 * v32;
    const p13 = w10 * v03 + w11 * v13
        + w12 * v23 + w13 * v33;
    const p20 = w20 * v00 + w21 * v10
        + w22 * v20 + w23 * v30;
    const p21 = w20 * v01 + w21 * v11
        + w22 * v21 + w23 * v31;
    const p22 = w20 * v02 + w21 * v12
        + w22 * v22 + w23 * v32;
    const p23 = w20 * v03 + w21 * v13
        + w22 * v23 + w23 * v33;
    const p30 = w30 * v00 + w31 * v10
        + w32 * v20 + w33 * v30;
    const p31 = w30 * v01 + w31 * v11
        + w32 * v21 + w33 * v31;
    const p32 = w30 * v02 + w31 * v12
        + w32 * v22 + w33 * v32;
    const p33 = w30 * v03 + w31 * v13
        + w32 * v23 + w33 * v33;
    /** @type {f64} */
    let j00 = 1;
    /** @type {f64} */
    let j01 = 0;
    /** @type {f64} */
    let j02 = 0;
    /** @type {f64} */
    let j03 = 0;
    /** @type {f64} */
    let j10 = 0;
    /** @type {f64} */
    let j11 = 1;
    /** @type {f64} */
    let j12 = 0;
    /** @type {f64} */
    let j13 = 0;
    /** @type {f64} */
    let j20 = 0;
    /** @type {f64} */
    let j21 = 0;
    /** @type {f64} */
    let j22 = 1;
    /** @type {f64} */
    let j23 = 0;
    /** @type {f64} */
    let j30 = 0;
    /** @type {f64} */
    let j31 = 0;
    /** @type {f64} */
    let j32 = 0;
    /** @type {f64} */
    let j33 = 1;
    if (projection !== 0)
    {
        j00 = f32(projection);
        j01 = f32(projection + 4);
        j02 = f32(projection + 8);
        j03 = f32(projection + 12);
        j10 = f32(projection + 16);
        j11 = f32(projection + 20);
        j12 = f32(projection + 24);
        j13 = f32(projection + 28);
        j20 = f32(projection + 32);
        j21 = f32(projection + 36);
        j22 = f32(projection + 40);
        j23 = f32(projection + 44);
        j30 = f32(projection + 48);
        j31 = f32(projection + 52);
        j32 = f32(projection + 56);
        j33 = f32(projection + 60);
    }
    const m00 = p00 * j00 + p01 * j10
        + p02 * j20 + p03 * j30;
    const m01 = p00 * j01 + p01 * j11
        + p02 * j21 + p03 * j31;
    const m02 = p00 * j02 + p01 * j12
        + p02 * j22 + p03 * j32;
    const m03 = p00 * j03 + p01 * j13
        + p02 * j23 + p03 * j33;
    const m10 = p10 * j00 + p11 * j10
        + p12 * j20 + p13 * j30;
    const m11 = p10 * j01 + p11 * j11
        + p12 * j21 + p13 * j31;
    const m12 = p10 * j02 + p11 * j12
        + p12 * j22 + p13 * j32;
    const m13 = p10 * j03 + p11 * j13
        + p12 * j23 + p13 * j33;
    const m20 = p20 * j00 + p21 * j10
        + p22 * j20 + p23 * j30;
    const m21 = p20 * j01 + p21 * j11
        + p22 * j21 + p23 * j31;
    const m22 = p20 * j02 + p21 * j12
        + p22 * j22 + p23 * j32;
    const m23 = p20 * j03 + p21 * j13
        + p22 * j23 + p23 * j33;
    const m30 = p30 * j00 + p31 * j10
        + p32 * j20 + p33 * j30;
    const m31 = p30 * j01 + p31 * j11
        + p32 * j21 + p33 * j31;
    const m32 = p30 * j02 + p31 * j12
        + p32 * j22 + p33 * j32;
    const m33 = p30 * j03 + p31 * j13
        + p32 * j23 + p33 * j33;
    const c0 = m11 * m22 * m33 - m11 * m23 * m32 - m21 * m12 * m33
        + m21 * m13 * m32 + m31 * m12 * m23 - m31 * m13 * m22;
    const c1 = -m01 * m22 * m33 + m01 * m23 * m32 + m21 * m02 * m33
        - m21 * m03 * m32 - m31 * m02 * m23 + m31 * m03 * m22;
    const c2 = m01 * m12 * m33 - m01 * m13 * m32 - m11 * m02 * m33
        + m11 * m03 * m32 + m31 * m02 * m13 - m31 * m03 * m12;
    const c3 = -m01 * m12 * m23 + m01 * m13 * m22 + m11 * m02 * m23
        - m11 * m03 * m22 - m21 * m02 * m13 + m21 * m03 * m12;
    const c4 = -m10 * m22 * m33 + m10 * m23 * m32 + m20 * m12 * m33
        - m20 * m13 * m32 - m30 * m12 * m23 + m30 * m13 * m22;
    const c5 = m00 * m22 * m33 - m00 * m23 * m32 - m20 * m02 * m33
        + m20 * m03 * m32 + m30 * m02 * m23 - m30 * m03 * m22;
    const c6 = -m00 * m12 * m33 + m00 * m13 * m32 + m10 * m02 * m33
        - m10 * m03 * m32 - m30 * m02 * m13 + m30 * m03 * m12;
    const c7 = m00 * m12 * m23 - m00 * m13 * m22 - m10 * m02 * m23
        + m10 * m03 * m22 + m20 * m02 * m13 - m20 * m03 * m12;
    const c8 = m10 * m21 * m33 - m10 * m23 * m31 - m20 * m11 * m33
        + m20 * m13 * m31 + m30 * m11 * m23 - m30 * m13 * m21;
    const c9 = -m00 * m21 * m33 + m00 * m23 * m31 + m20 * m01 * m33
        - m20 * m03 * m31 - m30 * m01 * m23 + m30 * m03 * m21;
    const c10 = m00 * m11 * m33 - m00 * m13 * m31 - m10 * m01 * m33
        + m10 * m03 * m31 + m30 * m01 * m13 - m30 * m03 * m11;
    const c11 = -m00 * m11 * m23 + m00 * m13 * m21 + m10 * m01 * m23
        - m10 * m03 * m21 - m20 * m01 * m13 + m20 * m03 * m11;
    const c12 = -m10 * m21 * m32 + m10 * m22 * m31 + m20 * m11 * m32
        - m20 * m12 * m31 - m30 * m11 * m22 + m30 * m12 * m21;
    const c13 = m00 * m21 * m32 - m00 * m22 * m31 - m20 * m01 * m32
        + m20 * m02 * m31 + m30 * m01 * m22 - m30 * m02 * m21;
    const c14 = -m00 * m11 * m32 + m00 * m12 * m31 + m10 * m01 * m32
        - m10 * m02 * m31 - m30 * m01 * m12 + m30 * m02 * m11;
    const c15 = m00 * m11 * m22 - m00 * m12 * m21 - m10 * m01 * m22
        + m10 * m02 * m21 + m20 * m01 * m12 - m20 * m02 * m11;
    const det = m00 * c0 + m01 * c4 + m02 * c8 + m03 * c12;
    if (det === 0)
    {
        return 0;
    }
    const scale = 1 / det;
    const i00 = c0 * scale;
    const i01 = c1 * scale;
    const i02 = c2 * scale;
    const i03 = c3 * scale;
    const i10 = c4 * scale;
    const i11 = c5 * scale;
    const i12 = c6 * scale;
    const i13 = c7 * scale;
    const i20 = c8 * scale;
    const i21 = c9 * scale;
    const i22 = c10 * scale;
    const i23 = c11 * scale;
    const i30 = c12 * scale;
    const i31 = c13 * scale;
    const i32 = c14 * scale;
    const i33 = c15 * scale;
    /** @type {f64} */
    let px = f32(v);
    /** @type {f64} */
    let py = f32(v + 4);
    /** @type {f64} */
    let pz = f32(v + 8);
    if (viewport !== 0)
    {
        const minZ = f32(viewport + 16);
        px = Math.fround((px - u32(viewport)) * 2 / u32(viewport + 8) - 1);
        py = Math.fround(1 - (py - u32(viewport + 4)) * 2 / u32(viewport + 12));
        pz = Math.fround((pz - minZ) / (f32(viewport + 20) - minZ));
    }
    const divisor = divisorOf(Math.fround(px * i03 + py * i13 + pz * i23 + i33));
    const x = Math.fround(px * i00 + py * i10 + pz * i20 + i30);
    const y = Math.fround(px * i01 + py * i11 + pz * i21 + i31);
    const z = Math.fround(px * i02 + py * i12 + pz * i22 + i32);
    setF32(out, x / divisor);
    setF32(out + 4, y / divisor);
    setF32(out + 8, z / divisor);
    return out;
}

/**
 * D3DXVECTOR3 *D3DXVec3UnprojectArray(D3DXVECTOR3 *out, UINT outStride,
 *     const D3DXVECTOR3 *v, UINT vStride, const D3DVIEWPORT9 *viewport,
 *     const D3DXMATRIX *projection, const D3DXMATRIX *view,
 *     const D3DXMATRIX *world, UINT n) -- each point as D3DXVec3Unproject
 * unprojects it, the inverse and the viewport found once, before the
 * first; NULL, and nothing written, for a product with no inverse.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} outStride @param {u32} v
 * @param {u32} vStride @param {u32} viewport @param {u32} projection @param {u32} view
 * @param {u32} world @param {u32} n
 * @returns {u32}
 */
export function D3DXVec3UnprojectArray({ f32, u32, setF32 }, out, outStride, v, vStride, viewport,
    projection, view, world, n)
{
    /** @type {f64} */
    let w00 = 1;
    /** @type {f64} */
    let w01 = 0;
    /** @type {f64} */
    let w02 = 0;
    /** @type {f64} */
    let w03 = 0;
    /** @type {f64} */
    let w10 = 0;
    /** @type {f64} */
    let w11 = 1;
    /** @type {f64} */
    let w12 = 0;
    /** @type {f64} */
    let w13 = 0;
    /** @type {f64} */
    let w20 = 0;
    /** @type {f64} */
    let w21 = 0;
    /** @type {f64} */
    let w22 = 1;
    /** @type {f64} */
    let w23 = 0;
    /** @type {f64} */
    let w30 = 0;
    /** @type {f64} */
    let w31 = 0;
    /** @type {f64} */
    let w32 = 0;
    /** @type {f64} */
    let w33 = 1;
    if (world !== 0)
    {
        w00 = f32(world);
        w01 = f32(world + 4);
        w02 = f32(world + 8);
        w03 = f32(world + 12);
        w10 = f32(world + 16);
        w11 = f32(world + 20);
        w12 = f32(world + 24);
        w13 = f32(world + 28);
        w20 = f32(world + 32);
        w21 = f32(world + 36);
        w22 = f32(world + 40);
        w23 = f32(world + 44);
        w30 = f32(world + 48);
        w31 = f32(world + 52);
        w32 = f32(world + 56);
        w33 = f32(world + 60);
    }
    /** @type {f64} */
    let v00 = 1;
    /** @type {f64} */
    let v01 = 0;
    /** @type {f64} */
    let v02 = 0;
    /** @type {f64} */
    let v03 = 0;
    /** @type {f64} */
    let v10 = 0;
    /** @type {f64} */
    let v11 = 1;
    /** @type {f64} */
    let v12 = 0;
    /** @type {f64} */
    let v13 = 0;
    /** @type {f64} */
    let v20 = 0;
    /** @type {f64} */
    let v21 = 0;
    /** @type {f64} */
    let v22 = 1;
    /** @type {f64} */
    let v23 = 0;
    /** @type {f64} */
    let v30 = 0;
    /** @type {f64} */
    let v31 = 0;
    /** @type {f64} */
    let v32 = 0;
    /** @type {f64} */
    let v33 = 1;
    if (view !== 0)
    {
        v00 = f32(view);
        v01 = f32(view + 4);
        v02 = f32(view + 8);
        v03 = f32(view + 12);
        v10 = f32(view + 16);
        v11 = f32(view + 20);
        v12 = f32(view + 24);
        v13 = f32(view + 28);
        v20 = f32(view + 32);
        v21 = f32(view + 36);
        v22 = f32(view + 40);
        v23 = f32(view + 44);
        v30 = f32(view + 48);
        v31 = f32(view + 52);
        v32 = f32(view + 56);
        v33 = f32(view + 60);
    }
    const p00 = w00 * v00 + w01 * v10
        + w02 * v20 + w03 * v30;
    const p01 = w00 * v01 + w01 * v11
        + w02 * v21 + w03 * v31;
    const p02 = w00 * v02 + w01 * v12
        + w02 * v22 + w03 * v32;
    const p03 = w00 * v03 + w01 * v13
        + w02 * v23 + w03 * v33;
    const p10 = w10 * v00 + w11 * v10
        + w12 * v20 + w13 * v30;
    const p11 = w10 * v01 + w11 * v11
        + w12 * v21 + w13 * v31;
    const p12 = w10 * v02 + w11 * v12
        + w12 * v22 + w13 * v32;
    const p13 = w10 * v03 + w11 * v13
        + w12 * v23 + w13 * v33;
    const p20 = w20 * v00 + w21 * v10
        + w22 * v20 + w23 * v30;
    const p21 = w20 * v01 + w21 * v11
        + w22 * v21 + w23 * v31;
    const p22 = w20 * v02 + w21 * v12
        + w22 * v22 + w23 * v32;
    const p23 = w20 * v03 + w21 * v13
        + w22 * v23 + w23 * v33;
    const p30 = w30 * v00 + w31 * v10
        + w32 * v20 + w33 * v30;
    const p31 = w30 * v01 + w31 * v11
        + w32 * v21 + w33 * v31;
    const p32 = w30 * v02 + w31 * v12
        + w32 * v22 + w33 * v32;
    const p33 = w30 * v03 + w31 * v13
        + w32 * v23 + w33 * v33;
    /** @type {f64} */
    let j00 = 1;
    /** @type {f64} */
    let j01 = 0;
    /** @type {f64} */
    let j02 = 0;
    /** @type {f64} */
    let j03 = 0;
    /** @type {f64} */
    let j10 = 0;
    /** @type {f64} */
    let j11 = 1;
    /** @type {f64} */
    let j12 = 0;
    /** @type {f64} */
    let j13 = 0;
    /** @type {f64} */
    let j20 = 0;
    /** @type {f64} */
    let j21 = 0;
    /** @type {f64} */
    let j22 = 1;
    /** @type {f64} */
    let j23 = 0;
    /** @type {f64} */
    let j30 = 0;
    /** @type {f64} */
    let j31 = 0;
    /** @type {f64} */
    let j32 = 0;
    /** @type {f64} */
    let j33 = 1;
    if (projection !== 0)
    {
        j00 = f32(projection);
        j01 = f32(projection + 4);
        j02 = f32(projection + 8);
        j03 = f32(projection + 12);
        j10 = f32(projection + 16);
        j11 = f32(projection + 20);
        j12 = f32(projection + 24);
        j13 = f32(projection + 28);
        j20 = f32(projection + 32);
        j21 = f32(projection + 36);
        j22 = f32(projection + 40);
        j23 = f32(projection + 44);
        j30 = f32(projection + 48);
        j31 = f32(projection + 52);
        j32 = f32(projection + 56);
        j33 = f32(projection + 60);
    }
    const m00 = p00 * j00 + p01 * j10
        + p02 * j20 + p03 * j30;
    const m01 = p00 * j01 + p01 * j11
        + p02 * j21 + p03 * j31;
    const m02 = p00 * j02 + p01 * j12
        + p02 * j22 + p03 * j32;
    const m03 = p00 * j03 + p01 * j13
        + p02 * j23 + p03 * j33;
    const m10 = p10 * j00 + p11 * j10
        + p12 * j20 + p13 * j30;
    const m11 = p10 * j01 + p11 * j11
        + p12 * j21 + p13 * j31;
    const m12 = p10 * j02 + p11 * j12
        + p12 * j22 + p13 * j32;
    const m13 = p10 * j03 + p11 * j13
        + p12 * j23 + p13 * j33;
    const m20 = p20 * j00 + p21 * j10
        + p22 * j20 + p23 * j30;
    const m21 = p20 * j01 + p21 * j11
        + p22 * j21 + p23 * j31;
    const m22 = p20 * j02 + p21 * j12
        + p22 * j22 + p23 * j32;
    const m23 = p20 * j03 + p21 * j13
        + p22 * j23 + p23 * j33;
    const m30 = p30 * j00 + p31 * j10
        + p32 * j20 + p33 * j30;
    const m31 = p30 * j01 + p31 * j11
        + p32 * j21 + p33 * j31;
    const m32 = p30 * j02 + p31 * j12
        + p32 * j22 + p33 * j32;
    const m33 = p30 * j03 + p31 * j13
        + p32 * j23 + p33 * j33;
    const c0 = m11 * m22 * m33 - m11 * m23 * m32 - m21 * m12 * m33
        + m21 * m13 * m32 + m31 * m12 * m23 - m31 * m13 * m22;
    const c1 = -m01 * m22 * m33 + m01 * m23 * m32 + m21 * m02 * m33
        - m21 * m03 * m32 - m31 * m02 * m23 + m31 * m03 * m22;
    const c2 = m01 * m12 * m33 - m01 * m13 * m32 - m11 * m02 * m33
        + m11 * m03 * m32 + m31 * m02 * m13 - m31 * m03 * m12;
    const c3 = -m01 * m12 * m23 + m01 * m13 * m22 + m11 * m02 * m23
        - m11 * m03 * m22 - m21 * m02 * m13 + m21 * m03 * m12;
    const c4 = -m10 * m22 * m33 + m10 * m23 * m32 + m20 * m12 * m33
        - m20 * m13 * m32 - m30 * m12 * m23 + m30 * m13 * m22;
    const c5 = m00 * m22 * m33 - m00 * m23 * m32 - m20 * m02 * m33
        + m20 * m03 * m32 + m30 * m02 * m23 - m30 * m03 * m22;
    const c6 = -m00 * m12 * m33 + m00 * m13 * m32 + m10 * m02 * m33
        - m10 * m03 * m32 - m30 * m02 * m13 + m30 * m03 * m12;
    const c7 = m00 * m12 * m23 - m00 * m13 * m22 - m10 * m02 * m23
        + m10 * m03 * m22 + m20 * m02 * m13 - m20 * m03 * m12;
    const c8 = m10 * m21 * m33 - m10 * m23 * m31 - m20 * m11 * m33
        + m20 * m13 * m31 + m30 * m11 * m23 - m30 * m13 * m21;
    const c9 = -m00 * m21 * m33 + m00 * m23 * m31 + m20 * m01 * m33
        - m20 * m03 * m31 - m30 * m01 * m23 + m30 * m03 * m21;
    const c10 = m00 * m11 * m33 - m00 * m13 * m31 - m10 * m01 * m33
        + m10 * m03 * m31 + m30 * m01 * m13 - m30 * m03 * m11;
    const c11 = -m00 * m11 * m23 + m00 * m13 * m21 + m10 * m01 * m23
        - m10 * m03 * m21 - m20 * m01 * m13 + m20 * m03 * m11;
    const c12 = -m10 * m21 * m32 + m10 * m22 * m31 + m20 * m11 * m32
        - m20 * m12 * m31 - m30 * m11 * m22 + m30 * m12 * m21;
    const c13 = m00 * m21 * m32 - m00 * m22 * m31 - m20 * m01 * m32
        + m20 * m02 * m31 + m30 * m01 * m22 - m30 * m02 * m21;
    const c14 = -m00 * m11 * m32 + m00 * m12 * m31 + m10 * m01 * m32
        - m10 * m02 * m31 - m30 * m01 * m12 + m30 * m02 * m11;
    const c15 = m00 * m11 * m22 - m00 * m12 * m21 - m10 * m01 * m22
        + m10 * m02 * m21 + m20 * m01 * m12 - m20 * m02 * m11;
    const det = m00 * c0 + m01 * c4 + m02 * c8 + m03 * c12;
    if (det === 0)
    {
        return 0;
    }
    const scale = 1 / det;
    const i00 = c0 * scale;
    const i01 = c1 * scale;
    const i02 = c2 * scale;
    const i03 = c3 * scale;
    const i10 = c4 * scale;
    const i11 = c5 * scale;
    const i12 = c6 * scale;
    const i13 = c7 * scale;
    const i20 = c8 * scale;
    const i21 = c9 * scale;
    const i22 = c10 * scale;
    const i23 = c11 * scale;
    const i30 = c12 * scale;
    const i31 = c13 * scale;
    const i32 = c14 * scale;
    const i33 = c15 * scale;
    /** @type {f64} */
    let left = 0;
    /** @type {f64} */
    let top = 0;
    /** @type {f64} */
    let width = 0;
    /** @type {f64} */
    let height = 0;
    /** @type {f64} */
    let minZ = 0;
    /** @type {f64} */
    let depth = 0;
    if (viewport !== 0)
    {
        left = u32(viewport);
        top = u32(viewport + 4);
        width = u32(viewport + 8);
        height = u32(viewport + 12);
        minZ = f32(viewport + 16);
        depth = f32(viewport + 20) - minZ;
    }
    /** @type {u32} */
    let to = out;
    /** @type {u32} */
    let from = v;
    for (/** @type {u32} */ let i = 0; i < n; i++)
    {
        /** @type {f64} */
        let px = f32(from);
        /** @type {f64} */
        let py = f32(from + 4);
        /** @type {f64} */
        let pz = f32(from + 8);
        if (viewport !== 0)
        {
            px = Math.fround((px - left) * 2 / width - 1);
            py = Math.fround(1 - (py - top) * 2 / height);
            pz = Math.fround((pz - minZ) / depth);
        }
        const divisor = divisorOf(Math.fround(px * i03 + py * i13 + pz * i23 + i33));
        const x = Math.fround(px * i00 + py * i10 + pz * i20 + i30);
        const y = Math.fround(px * i01 + py * i11 + pz * i21 + i31);
        const z = Math.fround(px * i02 + py * i12 + pz * i22 + i32);
        setF32(to, x / divisor);
        setF32(to + 4, y / divisor);
        setF32(to + 8, z / divisor);
        to = (to + outStride) >>> 0;
        from = (from + vStride) >>> 0;
    }
    return out;
}

/**
 * D3DXVECTOR4 *D3DXVec4Cross(D3DXVECTOR4 *out, const D3DXVECTOR4 *u,
 *     const D3DXVECTOR4 *v, const D3DXVECTOR4 *w) -- the four-dimensional
 * cross product, the vector orthogonal to the three: the determinants of
 * the 2x2 minors of v and w, weighed by u's elements.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} u @param {u32} v @param {u32} w
 * @returns {u32}
 */
export function D3DXVec4Cross({ f32, setF32 }, out, u, v, w){
    const ux = f32(u);
    const uy = f32(u + 4);
    const uz = f32(u + 8);
    const uw = f32(u + 12);
    const vx = f32(v);
    const vy = f32(v + 4);
    const vz = f32(v + 8);
    const vw = f32(v + 12);
    const wx = f32(w);
    const wy = f32(w + 4);
    const wz = f32(w + 8);
    const ww = f32(w + 12);
    const a = vx * wy - vy * wx;
    const b = vx * wz - vz * wx;
    const c = vx * ww - vw * wx;
    const d = vy * wz - vz * wy;
    const e = vy * ww - vw * wy;
    const f = vz * ww - vw * wz;
    setF32(out, uy * f - uz * e + uw * d);
    setF32(out + 4, -(ux * f) + uz * c - uw * b);
    setF32(out + 8, ux * e - uy * c + uw * a);
    setF32(out + 12, -(ux * d) + uy * b - uz * a);
    return out;
}

/**
 * D3DXPLANE *D3DXPlaneFromPointNormal(D3DXPLANE *out, const D3DXVECTOR3 *point,
 *     const D3DXVECTOR3 *normal) -- the normal's bits as (a, b, c), then d
 * the point's product with the normal negated, both read after (a, b, c)
 * are written: a plane made over its own point takes the normal for it, as
 * the library's does (d is -1826, not -950, for the point (11, 13, 15) under
 * the normal (17, 31, 24) in Wine's conformance test).
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} point @param {u32} normal
 * @returns {u32}
 */
export function D3DXPlaneFromPointNormal({ f32, u32, setU32, setF32 }, out, point, normal){
    setU32(out, u32(normal));
    setU32(out + 4, u32(normal + 4));
    setU32(out + 8, u32(normal + 8));
    setF32(out + 12, -(f32(point) * f32(normal) + f32(point + 4) * f32(normal + 4)
        + f32(point + 8) * f32(normal + 8)));
    return out;
}

/**
 * D3DXPLANE *D3DXPlaneFromPoints(D3DXPLANE *out, const D3DXVECTOR3 *v1,
 *     const D3DXVECTOR3 *v2, const D3DXVECTOR3 *v3) -- the normal the
 * normalised cross product of v2 - v1 and v3 - v1, through v1.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v1 @param {u32} v2 @param {u32} v3
 * @returns {u32}
 */
export function D3DXPlaneFromPoints({ f32, setF32 }, out, v1, v2, v3){
    const x1 = f32(v1);
    const y1 = f32(v1 + 4);
    const z1 = f32(v1 + 8);
    const ex = f32(v2) - x1;
    const ey = f32(v2 + 4) - y1;
    const ez = f32(v2 + 8) - z1;
    const fx = f32(v3) - x1;
    const fy = f32(v3 + 4) - y1;
    const fz = f32(v3 + 8) - z1;
    const nx = ey * fz - ez * fy;
    const ny = ez * fx - ex * fz;
    const nz = ex * fy - ey * fx;
    const scale = inverseOf(Math.sqrt(nx * nx + ny * ny + nz * nz));
    const a = nx * scale;
    const b = ny * scale;
    const c = nz * scale;
    setF32(out, a);
    setF32(out + 4, b);
    setF32(out + 8, c);
    setF32(out + 12, -(a * x1 + b * y1 + c * z1));
    return out;
}

/**
 * D3DXVECTOR3 *D3DXPlaneIntersectLine(D3DXVECTOR3 *out, const D3DXPLANE *plane,
 *     const D3DXVECTOR3 *v1, const D3DXVECTOR3 *v2) -- where the line
 * through v1 and v2 meets the plane; NULL, and nothing written, for a line
 * parallel to it.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} plane @param {u32} v1 @param {u32} v2
 * @returns {u32}
 */
export function D3DXPlaneIntersectLine({ f32, setF32 }, out, plane, v1, v2){
    const a = f32(plane);
    const b = f32(plane + 4);
    const c = f32(plane + 8);
    const x = f32(v1);
    const y = f32(v1 + 4);
    const z = f32(v1 + 8);
    const dx = f32(v2) - x;
    const dy = f32(v2 + 4) - y;
    const dz = f32(v2 + 8) - z;
    const dot = a * dx + b * dy + c * dz;
    if (dot === 0)
    {
        return 0;
    }
    const t = -(a * x + b * y + c * z + f32(plane + 12)) / dot;
    setF32(out, x + t * dx);
    setF32(out + 4, y + t * dy);
    setF32(out + 8, z + t * dz);
    return out;
}

/**
 * D3DXPLANE *D3DXPlaneNormalize(D3DXPLANE *out, const D3DXPLANE *plane) --
 * the four divided by the normal's length.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} plane
 * @returns {u32}
 */
export function D3DXPlaneNormalize({ f32, setF32 }, out, plane){
    const a = f32(plane);
    const b = f32(plane + 4);
    const c = f32(plane + 8);
    const d = f32(plane + 12);
    const scale = inverseOf(Math.sqrt(a * a + b * b + c * c));
    setF32(out, a * scale);
    setF32(out + 4, b * scale);
    setF32(out + 8, c * scale);
    setF32(out + 12, d * scale);
    return out;
}

/**
 * D3DXPLANE *D3DXPlaneTransform(D3DXPLANE *out, const D3DXPLANE *plane,
 *     const D3DXMATRIX *m) -- (a, b, c, d) as a row on m's left; the matrix
 * to pass is the inverse transpose of the one that moves the points.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} plane @param {u32} m
 * @returns {u32}
 */
export function D3DXPlaneTransform({ f32, setF32 }, out, plane, m){
    const a = f32(plane);
    const b = f32(plane + 4);
    const c = f32(plane + 8);
    const d = f32(plane + 12);
    const x = a * f32(m) + b * f32(m + 16) + c * f32(m + 32) + d * f32(m + 48);
    const y = a * f32(m + 4) + b * f32(m + 20) + c * f32(m + 36) + d * f32(m + 52);
    const z = a * f32(m + 8) + b * f32(m + 24) + c * f32(m + 40) + d * f32(m + 56);
    const w = a * f32(m + 12) + b * f32(m + 28) + c * f32(m + 44) + d * f32(m + 60);
    setF32(out, x);
    setF32(out + 4, y);
    setF32(out + 8, z);
    setF32(out + 12, w);
    return out;
}

/**
 * D3DXCOLOR *D3DXColorAdjustContrast(D3DXCOLOR *out, const D3DXCOLOR *color,
 *     FLOAT s) -- each of r, g, b moved from 0.5 by s; alpha as it came.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} color @param {f32} s
 * @returns {u32}
 */
export function D3DXColorAdjustContrast({ f32, u32, setU32, setF32 }, out, color, s){
    const r = 0.5 + s * (f32(color) - 0.5);
    const g = 0.5 + s * (f32(color + 4) - 0.5);
    const b = 0.5 + s * (f32(color + 8) - 0.5);
    const a = u32(color + 12);
    setF32(out, r);
    setF32(out + 4, g);
    setF32(out + 8, b);
    setU32(out + 12, a);
    return out;
}

/**
 * D3DXCOLOR *D3DXColorAdjustSaturation(D3DXCOLOR *out, const D3DXCOLOR *color,
 *     FLOAT s) -- each of r, g, b moved from the colour's grey (0.2125 r +
 * 0.7154 g + 0.0721 b) by s; alpha as it came.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} color @param {f32} s
 * @returns {u32}
 */
export function D3DXColorAdjustSaturation({ f32, u32, setU32, setF32 }, out, color, s){
    const r = f32(color);
    const g = f32(color + 4);
    const b = f32(color + 8);
    const a = u32(color + 12);
    const grey = r * GREY_R + g * GREY_G + b * GREY_B;
    setF32(out, grey + s * (r - grey));
    setF32(out + 4, grey + s * (g - grey));
    setF32(out + 8, grey + s * (b - grey));
    setU32(out + 12, a);
    return out;
}

/**
 * FLOAT D3DXFresnelTerm(FLOAT costheta, FLOAT refractionindex) -- the
 * reflectance of unpolarised light: g = sqrt(n^2 + c^2 - 1),
 * ((g - c) / (g + c))^2 (1 + ((c (g + c) - 1) / (c (g - c) + 1))^2) / 2.
 *
 * @guestCode stdcall
 * @param {f32} costheta @param {f32} refractionindex
 * @returns {f32}
 */
export function D3DXFresnelTerm(costheta, refractionindex){
    const g = Math.sqrt(refractionindex * refractionindex + costheta * costheta - 1);
    const sum = g + costheta;
    const difference = g - costheta;
    const outer = costheta * sum - 1;
    const inner = costheta * difference + 1;
    const ratio = difference * difference / (sum * sum);
    return Math.fround(ratio * (1 + outer * outer / (inner * inner)) / 2);
}

/**
 * D3DXFLOAT16 *D3DXFloat32To16Array(D3DXFLOAT16 *out, const FLOAT *in, UINT n)
 *
 * Each float to a half as the library's 32-bit (x87) build converts it,
 * which Wine's conformance tests pin: exponent 31 an exponent like the
 * others, not infinity -- 80000 is 0x7ce2 and every magnitude from 131008
 * up, infinity among them, 0x7fff with its sign -- a NaN 0xffff, a normal
 * half rounded to nearest even, a subnormal one truncated.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} values @param {u32} n
 * @returns {u32}
 */
export function D3DXFloat32To16Array({ u32, setU16 }, out, values, n){
    for (/** @type {u32} */ let i = 0; i < n; i++)
    {
        const bits = u32((values + i * 4) >>> 0);
        const sign = bits >>> 16 & 0x8000;
        const magnitude = bits & 0x7fffffff;
        const exponent = magnitude >>> 23;
        let half = sign;
        if (magnitude > 0x7f800000)
        {
            half = 0xffff;
        }
        else if (exponent >= 144)
        {
            half = sign | 0x7fff;
        }
        else if (exponent >= 113)
        {
            const rest = magnitude & 0x1fff;
            /** @type {u32} */
            let rounded = (exponent - 112 << 10 | magnitude >>> 13 & 0x3ff) >>> 0;
            if (rest > 0x1000 || rest === 0x1000 && (rounded & 1) !== 0)
            {
                rounded = (rounded + 1) >>> 0;
            }
            half = sign | (rounded > 0x7fff ? 0x7fff : rounded);
        }
        else if (exponent >= 103)
        {
            half = sign | (magnitude & 0x7fffff | 0x800000) >>> 126 - exponent;
        }
        setU16((out + i * 2) >>> 0, half);
    }
    return out;
}

/**
 * FLOAT *D3DXFloat16To32Array(FLOAT *out, const D3DXFLOAT16 *in, UINT n) --
 * each half as a float, exponent 31 as an exponent like the others: 0x7c00
 * is 65536 and 0x7fff 131008, as the library converts them.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} values @param {u32} n
 * @returns {u32}
 */
export function D3DXFloat16To32Array({ u16, setU32 }, out, values, n){
    for (/** @type {u32} */ let i = 0; i < n; i++)
    {
        const half = u16((values + i * 2) >>> 0);
        const sign = (half & 0x8000) << 16;
        let exponent = half >>> 10 & 0x1f;
        let mantissa = half & 0x3ff;
        /** @type {u32} */
        let bits = sign >>> 0;
        if (exponent !== 0)
        {
            bits = (sign | exponent + 112 << 23 | mantissa << 13) >>> 0;
        }
        else if (mantissa !== 0)
        {
            // A subnormal: shifted up until its leading bit is the implicit one.
            exponent = 113;
            while ((mantissa & 0x400) === 0)
            {
                mantissa = mantissa << 1;
                exponent = (exponent - 1) | 0;
            }
            bits = (sign | exponent << 23 | (mantissa & 0x3ff) << 13) >>> 0;
        }
        setU32((out + i * 4) >>> 0, bits);
    }
    return out;
}
