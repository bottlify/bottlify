/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * d3dx9's matrix builders as code in the guest's own d3dx9, written once:
 * each `@guestCode` function here is compiled by the build
 * (`scripts/guest-code/compile.mjs`) into `inguest-matrix.x86.js`, and is
 * itself the export's handler and the reference its x86 is held to.
 *
 * As in `inguest.js`: floats are read, computed on the x87 under the
 * precision control the program set, and stored rounded to nearest; every
 * input is read before the output is written, so an output over an input
 * answers what it would into a place of its own. Matrices are row-major,
 * a vector a row on the matrix's left.
 *
 * A quaternion a builder takes is used as it is, not normalised: the
 * rotation matrix of (x, y, z, w) is the library's formula of the four,
 * which is a rotation only for a unit quaternion (Wine's conformance tests
 * pin the matrices D3DX makes of (1, -4, 7, -11)). A vector or a plane
 * normalised on the way in -- an axis, a look-at direction, the plane of a
 * reflection -- is left zero when its length is zero.
 *
 * An angle reaches `fsin` and `fcos` below 2^63 in magnitude, where the
 * instructions reduce it; past that it is first reduced by 2π with `fprem`.
 */

/** @typedef {import('../msvcrt/guest-code.js').Guest} Guest */
/** @typedef {import('../msvcrt/guest-code.js').u32} u32 */
/** @typedef {import('../msvcrt/guest-code.js').f32} f32 */
/** @typedef {import('../msvcrt/guest-code.js').f64} f64 */

/** 1.0f's bits. */
const ONE = 0x3f800000;

/** -1.0f's bits. */
const MINUS_ONE = 0xbf800000;

/** D3DERR_INVALIDCALL: D3DXMatrixDecompose's answer for a matrix with a zero row. */
const D3DERR_INVALIDCALL = 0x8876086c;

/** Where `fsin` and `fcos` stop reducing their argument. */
const REDUCED = 2 ** 63;

/** 2π, the double nearest it. */
const TWO_PI = 6.283185307179586;

/** An angle the x87's sine and cosine take: itself below 2^63, its remainder by 2π past it. */
const turn = (/** @type {number} */ a)=>(Math.abs(a) < REDUCED ? a : a % TWO_PI);

/** The reciprocal of a length, or 0 for a length of 0: what normalising multiplies by. */
const inverseOf = (/** @type {number} */ length)=>(length === 0 ? 0 : 1 / length);

/**
 * The cofactor expansion's determinant, the same products D3DXMatrixInverse
 * forms, along the first row.
 *
 * @param {number} e0 @param {number} e1 @param {number} e2 @param {number} e3
 * @param {number} e4 @param {number} e5 @param {number} e6 @param {number} e7
 * @param {number} e8 @param {number} e9 @param {number} e10 @param {number} e11
 * @param {number} e12 @param {number} e13 @param {number} e14 @param {number} e15
 */
const determinantOf = (e0, e1, e2, e3, e4, e5, e6, e7, e8, e9, e10, e11, e12, e13, e14, e15)=>
    e0 * (e5 * e10 * e15 - e5 * e11 * e14 - e9 * e6 * e15
        + e9 * e7 * e14 + e13 * e6 * e11 - e13 * e7 * e10)
    + e1 * (-e4 * e10 * e15 + e4 * e11 * e14 + e8 * e6 * e15
        - e8 * e7 * e14 - e12 * e6 * e11 + e12 * e7 * e10)
    + e2 * (e4 * e9 * e15 - e4 * e11 * e13 - e8 * e5 * e15
        + e8 * e7 * e13 + e12 * e5 * e11 - e12 * e7 * e9)
    + e3 * (-e4 * e9 * e14 + e4 * e10 * e13 + e8 * e5 * e14
        - e8 * e6 * e13 - e12 * e5 * e10 + e12 * e6 * e9);

/**
 * FLOAT D3DXMatrixDeterminant(const D3DXMATRIX *m) -- the determinant
 * D3DXMatrixInverse writes, in ST0.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} m
 * @returns {f32}
 */
export function D3DXMatrixDeterminant({ f32 }, m){
    return Math.fround(determinantOf(f32(m), f32(m + 4), f32(m + 8), f32(m + 12),
        f32(m + 16), f32(m + 20), f32(m + 24), f32(m + 28),
        f32(m + 32), f32(m + 36), f32(m + 40), f32(m + 44),
        f32(m + 48), f32(m + 52), f32(m + 56), f32(m + 60)));
}

/**
 * D3DXMATRIX *D3DXMatrixMultiplyTranspose(D3DXMATRIX *out, const D3DXMATRIX *a,
 *     const D3DXMATRIX *b) -- the product D3DXMatrixMultiply forms, stored transposed.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} a @param {u32} b
 * @returns {u32}
 */
export function D3DXMatrixMultiplyTranspose({ f32, setF32 }, out, a, b){
    const m00 = f32(a) * f32(b) + f32(a + 4) * f32(b + 16)
        + f32(a + 8) * f32(b + 32) + f32(a + 12) * f32(b + 48);
    const m01 = f32(a) * f32(b + 4) + f32(a + 4) * f32(b + 20)
        + f32(a + 8) * f32(b + 36) + f32(a + 12) * f32(b + 52);
    const m02 = f32(a) * f32(b + 8) + f32(a + 4) * f32(b + 24)
        + f32(a + 8) * f32(b + 40) + f32(a + 12) * f32(b + 56);
    const m03 = f32(a) * f32(b + 12) + f32(a + 4) * f32(b + 28)
        + f32(a + 8) * f32(b + 44) + f32(a + 12) * f32(b + 60);
    const m10 = f32(a + 16) * f32(b) + f32(a + 20) * f32(b + 16)
        + f32(a + 24) * f32(b + 32) + f32(a + 28) * f32(b + 48);
    const m11 = f32(a + 16) * f32(b + 4) + f32(a + 20) * f32(b + 20)
        + f32(a + 24) * f32(b + 36) + f32(a + 28) * f32(b + 52);
    const m12 = f32(a + 16) * f32(b + 8) + f32(a + 20) * f32(b + 24)
        + f32(a + 24) * f32(b + 40) + f32(a + 28) * f32(b + 56);
    const m13 = f32(a + 16) * f32(b + 12) + f32(a + 20) * f32(b + 28)
        + f32(a + 24) * f32(b + 44) + f32(a + 28) * f32(b + 60);
    const m20 = f32(a + 32) * f32(b) + f32(a + 36) * f32(b + 16)
        + f32(a + 40) * f32(b + 32) + f32(a + 44) * f32(b + 48);
    const m21 = f32(a + 32) * f32(b + 4) + f32(a + 36) * f32(b + 20)
        + f32(a + 40) * f32(b + 36) + f32(a + 44) * f32(b + 52);
    const m22 = f32(a + 32) * f32(b + 8) + f32(a + 36) * f32(b + 24)
        + f32(a + 40) * f32(b + 40) + f32(a + 44) * f32(b + 56);
    const m23 = f32(a + 32) * f32(b + 12) + f32(a + 36) * f32(b + 28)
        + f32(a + 40) * f32(b + 44) + f32(a + 44) * f32(b + 60);
    const m30 = f32(a + 48) * f32(b) + f32(a + 52) * f32(b + 16)
        + f32(a + 56) * f32(b + 32) + f32(a + 60) * f32(b + 48);
    const m31 = f32(a + 48) * f32(b + 4) + f32(a + 52) * f32(b + 20)
        + f32(a + 56) * f32(b + 36) + f32(a + 60) * f32(b + 52);
    const m32 = f32(a + 48) * f32(b + 8) + f32(a + 52) * f32(b + 24)
        + f32(a + 56) * f32(b + 40) + f32(a + 60) * f32(b + 56);
    const m33 = f32(a + 48) * f32(b + 12) + f32(a + 52) * f32(b + 28)
        + f32(a + 56) * f32(b + 44) + f32(a + 60) * f32(b + 60);
    setF32(out, m00);
    setF32(out + 4, m10);
    setF32(out + 8, m20);
    setF32(out + 12, m30);
    setF32(out + 16, m01);
    setF32(out + 20, m11);
    setF32(out + 24, m21);
    setF32(out + 28, m31);
    setF32(out + 32, m02);
    setF32(out + 36, m12);
    setF32(out + 40, m22);
    setF32(out + 44, m32);
    setF32(out + 48, m03);
    setF32(out + 52, m13);
    setF32(out + 56, m23);
    setF32(out + 60, m33);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixScaling(D3DXMATRIX *out, FLOAT x, FLOAT y, FLOAT z) --
 * the three on the diagonal, their bits as they came.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} x @param {u32} y @param {u32} z
 * @returns {u32}
 */
export function D3DXMatrixScaling({ setU32 }, out, x, y, z){
    setU32(out, x);
    setU32(out + 4, 0);
    setU32(out + 8, 0);
    setU32(out + 12, 0);
    setU32(out + 16, 0);
    setU32(out + 20, y);
    setU32(out + 24, 0);
    setU32(out + 28, 0);
    setU32(out + 32, 0);
    setU32(out + 36, 0);
    setU32(out + 40, z);
    setU32(out + 44, 0);
    setU32(out + 48, 0);
    setU32(out + 52, 0);
    setU32(out + 56, 0);
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixRotationX(D3DXMATRIX *out, FLOAT angle)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f32} angle
 * @returns {u32}
 */
export function D3DXMatrixRotationX({ setU32, setF32 }, out, angle){
    const a = turn(angle);
    const s = Math.sin(a);
    const c = Math.cos(a);
    setU32(out, ONE);
    setU32(out + 4, 0);
    setU32(out + 8, 0);
    setU32(out + 12, 0);
    setU32(out + 16, 0);
    setF32(out + 20, c);
    setF32(out + 24, s);
    setU32(out + 28, 0);
    setU32(out + 32, 0);
    setF32(out + 36, -s);
    setF32(out + 40, c);
    setU32(out + 44, 0);
    setU32(out + 48, 0);
    setU32(out + 52, 0);
    setU32(out + 56, 0);
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixRotationY(D3DXMATRIX *out, FLOAT angle)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f32} angle
 * @returns {u32}
 */
export function D3DXMatrixRotationY({ setU32, setF32 }, out, angle){
    const a = turn(angle);
    const s = Math.sin(a);
    const c = Math.cos(a);
    setF32(out, c);
    setU32(out + 4, 0);
    setF32(out + 8, -s);
    setU32(out + 12, 0);
    setU32(out + 16, 0);
    setU32(out + 20, ONE);
    setU32(out + 24, 0);
    setU32(out + 28, 0);
    setF32(out + 32, s);
    setU32(out + 36, 0);
    setF32(out + 40, c);
    setU32(out + 44, 0);
    setU32(out + 48, 0);
    setU32(out + 52, 0);
    setU32(out + 56, 0);
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixRotationZ(D3DXMATRIX *out, FLOAT angle)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f32} angle
 * @returns {u32}
 */
export function D3DXMatrixRotationZ({ setU32, setF32 }, out, angle){
    const a = turn(angle);
    const s = Math.sin(a);
    const c = Math.cos(a);
    setF32(out, c);
    setF32(out + 4, s);
    setU32(out + 8, 0);
    setU32(out + 12, 0);
    setF32(out + 16, -s);
    setF32(out + 20, c);
    setU32(out + 24, 0);
    setU32(out + 28, 0);
    setU32(out + 32, 0);
    setU32(out + 36, 0);
    setU32(out + 40, ONE);
    setU32(out + 44, 0);
    setU32(out + 48, 0);
    setU32(out + 52, 0);
    setU32(out + 56, 0);
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixRotationAxis(D3DXMATRIX *out, const D3DXVECTOR3 *v, FLOAT angle)
 * -- about the axis normalised.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v @param {f32} angle
 * @returns {u32}
 */
export function D3DXMatrixRotationAxis({ f32, setU32, setF32 }, out, v, angle){
    const vx = f32(v);
    const vy = f32(v + 4);
    const vz = f32(v + 8);
    const scale = inverseOf(Math.sqrt(vx * vx + vy * vy + vz * vz));
    const x = vx * scale;
    const y = vy * scale;
    const z = vz * scale;
    const a = turn(angle);
    const s = Math.sin(a);
    const c = Math.cos(a);
    const t = 1 - c;
    setF32(out, t * x * x + c);
    setF32(out + 4, t * x * y + s * z);
    setF32(out + 8, t * x * z - s * y);
    setU32(out + 12, 0);
    setF32(out + 16, t * x * y - s * z);
    setF32(out + 20, t * y * y + c);
    setF32(out + 24, t * y * z + s * x);
    setU32(out + 28, 0);
    setF32(out + 32, t * x * z + s * y);
    setF32(out + 36, t * y * z - s * x);
    setF32(out + 40, t * z * z + c);
    setU32(out + 44, 0);
    setU32(out + 48, 0);
    setU32(out + 52, 0);
    setU32(out + 56, 0);
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixRotationYawPitchRoll(D3DXMATRIX *out, FLOAT yaw,
 *     FLOAT pitch, FLOAT roll) -- roll about z, then pitch about x, then yaw
 * about y: Rz(roll) Rx(pitch) Ry(yaw).
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f32} yaw @param {f32} pitch @param {f32} roll
 * @returns {u32}
 */
export function D3DXMatrixRotationYawPitchRoll({ setU32, setF32 }, out, yaw, pitch, roll){
    const y = turn(yaw);
    const p = turn(pitch);
    const r = turn(roll);
    const sy = Math.sin(y);
    const cy = Math.cos(y);
    const sp = Math.sin(p);
    const cp = Math.cos(p);
    const sr = Math.sin(r);
    const cr = Math.cos(r);
    setF32(out, cr * cy + sr * sp * sy);
    setF32(out + 4, sr * cp);
    setF32(out + 8, sr * sp * cy - cr * sy);
    setU32(out + 12, 0);
    setF32(out + 16, cr * sp * sy - sr * cy);
    setF32(out + 20, cr * cp);
    setF32(out + 24, sr * sy + cr * sp * cy);
    setU32(out + 28, 0);
    setF32(out + 32, cp * sy);
    setF32(out + 36, -sp);
    setF32(out + 40, cp * cy);
    setU32(out + 44, 0);
    setU32(out + 48, 0);
    setU32(out + 52, 0);
    setU32(out + 56, 0);
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixRotationQuaternion(D3DXMATRIX *out, const D3DXQUATERNION *q)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} q
 * @returns {u32}
 */
export function D3DXMatrixRotationQuaternion({ f32, setU32, setF32 }, out, q){
    const x = f32(q);
    const y = f32(q + 4);
    const z = f32(q + 8);
    const w = f32(q + 12);
    setF32(out, 1 - 2 * (y * y + z * z));
    setF32(out + 4, 2 * (x * y + z * w));
    setF32(out + 8, 2 * (x * z - y * w));
    setU32(out + 12, 0);
    setF32(out + 16, 2 * (x * y - z * w));
    setF32(out + 20, 1 - 2 * (x * x + z * z));
    setF32(out + 24, 2 * (y * z + x * w));
    setU32(out + 28, 0);
    setF32(out + 32, 2 * (x * z + y * w));
    setF32(out + 36, 2 * (y * z - x * w));
    setF32(out + 40, 1 - 2 * (x * x + y * y));
    setU32(out + 44, 0);
    setU32(out + 48, 0);
    setU32(out + 52, 0);
    setU32(out + 56, 0);
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixLookAtLH(D3DXMATRIX *out, const D3DXVECTOR3 *eye,
 *     const D3DXVECTOR3 *at, const D3DXVECTOR3 *up) -- z toward the point
 * looked at, x the up vector's cross product with it, y z's with x.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} eye @param {u32} at @param {u32} up
 * @returns {u32}
 */
export function D3DXMatrixLookAtLH({ f32, setU32, setF32 }, out, eye, at, up){
    const ex = f32(eye);
    const ey = f32(eye + 4);
    const ez = f32(eye + 8);
    const ux = f32(up);
    const uy = f32(up + 4);
    const uz = f32(up + 8);
    const dx = f32(at) - ex;
    const dy = f32(at + 4) - ey;
    const dz = f32(at + 8) - ez;
    const zScale = inverseOf(Math.sqrt(dx * dx + dy * dy + dz * dz));
    const zx = dx * zScale;
    const zy = dy * zScale;
    const zz = dz * zScale;
    const cx = uy * zz - uz * zy;
    const cy = uz * zx - ux * zz;
    const cz = ux * zy - uy * zx;
    const xScale = inverseOf(Math.sqrt(cx * cx + cy * cy + cz * cz));
    const xx = cx * xScale;
    const xy = cy * xScale;
    const xz = cz * xScale;
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    setF32(out, xx);
    setF32(out + 4, yx);
    setF32(out + 8, zx);
    setU32(out + 12, 0);
    setF32(out + 16, xy);
    setF32(out + 20, yy);
    setF32(out + 24, zy);
    setU32(out + 28, 0);
    setF32(out + 32, xz);
    setF32(out + 36, yz);
    setF32(out + 40, zz);
    setU32(out + 44, 0);
    setF32(out + 48, -(xx * ex + xy * ey + xz * ez));
    setF32(out + 52, -(yx * ex + yy * ey + yz * ez));
    setF32(out + 56, -(zx * ex + zy * ey + zz * ez));
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixLookAtRH(D3DXMATRIX *out, const D3DXVECTOR3 *eye,
 *     const D3DXVECTOR3 *at, const D3DXVECTOR3 *up) -- as the left-handed
 * one, z from the point looked at toward the eye.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} eye @param {u32} at @param {u32} up
 * @returns {u32}
 */
export function D3DXMatrixLookAtRH({ f32, setU32, setF32 }, out, eye, at, up){
    const ex = f32(eye);
    const ey = f32(eye + 4);
    const ez = f32(eye + 8);
    const ux = f32(up);
    const uy = f32(up + 4);
    const uz = f32(up + 8);
    const dx = ex - f32(at);
    const dy = ey - f32(at + 4);
    const dz = ez - f32(at + 8);
    const zScale = inverseOf(Math.sqrt(dx * dx + dy * dy + dz * dz));
    const zx = dx * zScale;
    const zy = dy * zScale;
    const zz = dz * zScale;
    const cx = uy * zz - uz * zy;
    const cy = uz * zx - ux * zz;
    const cz = ux * zy - uy * zx;
    const xScale = inverseOf(Math.sqrt(cx * cx + cy * cy + cz * cz));
    const xx = cx * xScale;
    const xy = cy * xScale;
    const xz = cz * xScale;
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    setF32(out, xx);
    setF32(out + 4, yx);
    setF32(out + 8, zx);
    setU32(out + 12, 0);
    setF32(out + 16, xy);
    setF32(out + 20, yy);
    setF32(out + 24, zy);
    setU32(out + 28, 0);
    setF32(out + 32, xz);
    setF32(out + 36, yz);
    setF32(out + 40, zz);
    setU32(out + 44, 0);
    setF32(out + 48, -(xx * ex + xy * ey + xz * ez));
    setF32(out + 52, -(yx * ex + yy * ey + yz * ez));
    setF32(out + 56, -(zx * ex + zy * ey + zz * ez));
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixPerspectiveFovLH(D3DXMATRIX *out, FLOAT fovy,
 *     FLOAT aspect, FLOAT zn, FLOAT zf) -- y scaled by the cotangent of half
 * the field of view, x by that over the aspect.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f32} fovy @param {f32} aspect @param {f32} zn
 * @param {f32} zf
 * @returns {u32}
 */
export function D3DXMatrixPerspectiveFovLH({ setU32, setF32 }, out, fovy, aspect, zn, zf){
    const yScale = 1 / Math.tan(turn(fovy / 2));
    setF32(out, yScale / aspect);
    setU32(out + 4, 0);
    setU32(out + 8, 0);
    setU32(out + 12, 0);
    setU32(out + 16, 0);
    setF32(out + 20, yScale);
    setU32(out + 24, 0);
    setU32(out + 28, 0);
    setU32(out + 32, 0);
    setU32(out + 36, 0);
    setF32(out + 40, zf / (zf - zn));
    setU32(out + 44, ONE);
    setU32(out + 48, 0);
    setU32(out + 52, 0);
    setF32(out + 56, zn * zf / (zn - zf));
    setU32(out + 60, 0);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixPerspectiveFovRH(D3DXMATRIX *out, FLOAT fovy,
 *     FLOAT aspect, FLOAT zn, FLOAT zf)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f32} fovy @param {f32} aspect @param {f32} zn
 * @param {f32} zf
 * @returns {u32}
 */
export function D3DXMatrixPerspectiveFovRH({ setU32, setF32 }, out, fovy, aspect, zn, zf){
    const yScale = 1 / Math.tan(turn(fovy / 2));
    setF32(out, yScale / aspect);
    setU32(out + 4, 0);
    setU32(out + 8, 0);
    setU32(out + 12, 0);
    setU32(out + 16, 0);
    setF32(out + 20, yScale);
    setU32(out + 24, 0);
    setU32(out + 28, 0);
    setU32(out + 32, 0);
    setU32(out + 36, 0);
    setF32(out + 40, zf / (zn - zf));
    setU32(out + 44, MINUS_ONE);
    setU32(out + 48, 0);
    setU32(out + 52, 0);
    setF32(out + 56, zn * zf / (zn - zf));
    setU32(out + 60, 0);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixPerspectiveRH(D3DXMATRIX *out, FLOAT w, FLOAT h, FLOAT zn, FLOAT zf)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f32} w @param {f32} h @param {f32} zn
 * @param {f32} zf
 * @returns {u32}
 */
export function D3DXMatrixPerspectiveRH({ setU32, setF32 }, out, w, h, zn, zf){
    setF32(out, 2 * zn / w);
    setU32(out + 4, 0);
    setU32(out + 8, 0);
    setU32(out + 12, 0);
    setU32(out + 16, 0);
    setF32(out + 20, 2 * zn / h);
    setU32(out + 24, 0);
    setU32(out + 28, 0);
    setU32(out + 32, 0);
    setU32(out + 36, 0);
    setF32(out + 40, zf / (zn - zf));
    setU32(out + 44, MINUS_ONE);
    setU32(out + 48, 0);
    setU32(out + 52, 0);
    setF32(out + 56, zn * zf / (zn - zf));
    setU32(out + 60, 0);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixPerspectiveOffCenterLH(D3DXMATRIX *out, FLOAT l,
 *     FLOAT r, FLOAT b, FLOAT t, FLOAT zn, FLOAT zf)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f32} l @param {f32} r @param {f32} b
 * @param {f32} t @param {f32} zn @param {f32} zf
 * @returns {u32}
 */
export function D3DXMatrixPerspectiveOffCenterLH({ setU32, setF32 }, out, l, r, b, t, zn, zf){
    setF32(out, 2 * zn / (r - l));
    setU32(out + 4, 0);
    setU32(out + 8, 0);
    setU32(out + 12, 0);
    setU32(out + 16, 0);
    setF32(out + 20, 2 * zn / (t - b));
    setU32(out + 24, 0);
    setU32(out + 28, 0);
    setF32(out + 32, (l + r) / (l - r));
    setF32(out + 36, (t + b) / (b - t));
    setF32(out + 40, zf / (zf - zn));
    setU32(out + 44, ONE);
    setU32(out + 48, 0);
    setU32(out + 52, 0);
    setF32(out + 56, zn * zf / (zn - zf));
    setU32(out + 60, 0);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixPerspectiveOffCenterRH(D3DXMATRIX *out, FLOAT l,
 *     FLOAT r, FLOAT b, FLOAT t, FLOAT zn, FLOAT zf)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f32} l @param {f32} r @param {f32} b
 * @param {f32} t @param {f32} zn @param {f32} zf
 * @returns {u32}
 */
export function D3DXMatrixPerspectiveOffCenterRH({ setU32, setF32 }, out, l, r, b, t, zn, zf){
    setF32(out, 2 * zn / (r - l));
    setU32(out + 4, 0);
    setU32(out + 8, 0);
    setU32(out + 12, 0);
    setU32(out + 16, 0);
    setF32(out + 20, 2 * zn / (t - b));
    setU32(out + 24, 0);
    setU32(out + 28, 0);
    setF32(out + 32, (l + r) / (r - l));
    setF32(out + 36, (t + b) / (t - b));
    setF32(out + 40, zf / (zn - zf));
    setU32(out + 44, MINUS_ONE);
    setU32(out + 48, 0);
    setU32(out + 52, 0);
    setF32(out + 56, zn * zf / (zn - zf));
    setU32(out + 60, 0);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixOrthoRH(D3DXMATRIX *out, FLOAT w, FLOAT h, FLOAT zn, FLOAT zf)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f32} w @param {f32} h @param {f32} zn
 * @param {f32} zf
 * @returns {u32}
 */
export function D3DXMatrixOrthoRH({ setU32, setF32 }, out, w, h, zn, zf){
    setF32(out, 2 / w);
    setU32(out + 4, 0);
    setU32(out + 8, 0);
    setU32(out + 12, 0);
    setU32(out + 16, 0);
    setF32(out + 20, 2 / h);
    setU32(out + 24, 0);
    setU32(out + 28, 0);
    setU32(out + 32, 0);
    setU32(out + 36, 0);
    setF32(out + 40, 1 / (zn - zf));
    setU32(out + 44, 0);
    setU32(out + 48, 0);
    setU32(out + 52, 0);
    setF32(out + 56, zn / (zn - zf));
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixOrthoOffCenterLH(D3DXMATRIX *out, FLOAT l, FLOAT r,
 *     FLOAT b, FLOAT t, FLOAT zn, FLOAT zf)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f32} l @param {f32} r @param {f32} b
 * @param {f32} t @param {f32} zn @param {f32} zf
 * @returns {u32}
 */
export function D3DXMatrixOrthoOffCenterLH({ setU32, setF32 }, out, l, r, b, t, zn, zf){
    setF32(out, 2 / (r - l));
    setU32(out + 4, 0);
    setU32(out + 8, 0);
    setU32(out + 12, 0);
    setU32(out + 16, 0);
    setF32(out + 20, 2 / (t - b));
    setU32(out + 24, 0);
    setU32(out + 28, 0);
    setU32(out + 32, 0);
    setU32(out + 36, 0);
    setF32(out + 40, 1 / (zf - zn));
    setU32(out + 44, 0);
    setF32(out + 48, (l + r) / (l - r));
    setF32(out + 52, (t + b) / (b - t));
    setF32(out + 56, zn / (zn - zf));
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixOrthoOffCenterRH(D3DXMATRIX *out, FLOAT l, FLOAT r,
 *     FLOAT b, FLOAT t, FLOAT zn, FLOAT zf)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f32} l @param {f32} r @param {f32} b
 * @param {f32} t @param {f32} zn @param {f32} zf
 * @returns {u32}
 */
export function D3DXMatrixOrthoOffCenterRH({ setU32, setF32 }, out, l, r, b, t, zn, zf){
    setF32(out, 2 / (r - l));
    setU32(out + 4, 0);
    setU32(out + 8, 0);
    setU32(out + 12, 0);
    setU32(out + 16, 0);
    setF32(out + 20, 2 / (t - b));
    setU32(out + 24, 0);
    setU32(out + 28, 0);
    setU32(out + 32, 0);
    setU32(out + 36, 0);
    setF32(out + 40, 1 / (zn - zf));
    setU32(out + 44, 0);
    setF32(out + 48, (l + r) / (l - r));
    setF32(out + 52, (t + b) / (b - t));
    setF32(out + 56, zn / (zn - zf));
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixReflect(D3DXMATRIX *out, const D3DXPLANE *plane) --
 * the reflection in the plane normalised.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} plane
 * @returns {u32}
 */
export function D3DXMatrixReflect({ f32, setU32, setF32 }, out, plane){
    const pa = f32(plane);
    const pb = f32(plane + 4);
    const pc = f32(plane + 8);
    const pd = f32(plane + 12);
    const scale = inverseOf(Math.sqrt(pa * pa + pb * pb + pc * pc));
    const a = pa * scale;
    const b = pb * scale;
    const c = pc * scale;
    const d = pd * scale;
    setF32(out, 1 - 2 * a * a);
    setF32(out + 4, -2 * b * a);
    setF32(out + 8, -2 * c * a);
    setU32(out + 12, 0);
    setF32(out + 16, -2 * a * b);
    setF32(out + 20, 1 - 2 * b * b);
    setF32(out + 24, -2 * c * b);
    setU32(out + 28, 0);
    setF32(out + 32, -2 * a * c);
    setF32(out + 36, -2 * b * c);
    setF32(out + 40, 1 - 2 * c * c);
    setU32(out + 44, 0);
    setF32(out + 48, -2 * a * d);
    setF32(out + 52, -2 * b * d);
    setF32(out + 56, -2 * c * d);
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixShadow(D3DXMATRIX *out, const D3DXVECTOR4 *light,
 *     const D3DXPLANE *plane) -- the plane normalised, P; its product with
 * the light, d: each element d on the diagonal less P's row times L's column.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} light @param {u32} plane
 * @returns {u32}
 */
export function D3DXMatrixShadow({ f32, setF32 }, out, light, plane){
    const lx = f32(light);
    const ly = f32(light + 4);
    const lz = f32(light + 8);
    const lw = f32(light + 12);
    const pa = f32(plane);
    const pb = f32(plane + 4);
    const pc = f32(plane + 8);
    const pd = f32(plane + 12);
    const scale = inverseOf(Math.sqrt(pa * pa + pb * pb + pc * pc));
    const a = pa * scale;
    const b = pb * scale;
    const c = pc * scale;
    const d = pd * scale;
    const dot = a * lx + b * ly + c * lz + d * lw;
    setF32(out, dot - a * lx);
    setF32(out + 4, -a * ly);
    setF32(out + 8, -a * lz);
    setF32(out + 12, -a * lw);
    setF32(out + 16, -b * lx);
    setF32(out + 20, dot - b * ly);
    setF32(out + 24, -b * lz);
    setF32(out + 28, -b * lw);
    setF32(out + 32, -c * lx);
    setF32(out + 36, -c * ly);
    setF32(out + 40, dot - c * lz);
    setF32(out + 44, -c * lw);
    setF32(out + 48, -d * lx);
    setF32(out + 52, -d * ly);
    setF32(out + 56, -d * lz);
    setF32(out + 60, dot - d * lw);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixAffineTransformation(D3DXMATRIX *out, FLOAT scaling,
 *     const D3DXVECTOR3 *center, const D3DXQUATERNION *rotation,
 *     const D3DXVECTOR3 *translation) -- Ms Mc^-1 Mr Mc Mt: the rotation's
 * matrix scaled, its centre's displacement -c R + c where there is a
 * rotation and a centre, and the translation added; each pointer may be NULL.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f32} scaling @param {u32} center
 * @param {u32} rotation @param {u32} translation
 * @returns {u32}
 */
export function D3DXMatrixAffineTransformation({ f32, setU32, setF32 }, out, scaling, center,
    rotation, translation)
{
    /** @type {f64} */
    let r00 = 1;
    /** @type {f64} */
    let r01 = 0;
    /** @type {f64} */
    let r02 = 0;
    /** @type {f64} */
    let r10 = 0;
    /** @type {f64} */
    let r11 = 1;
    /** @type {f64} */
    let r12 = 0;
    /** @type {f64} */
    let r20 = 0;
    /** @type {f64} */
    let r21 = 0;
    /** @type {f64} */
    let r22 = 1;
    /** @type {f64} */
    let tx = 0;
    /** @type {f64} */
    let ty = 0;
    /** @type {f64} */
    let tz = 0;
    if (rotation !== 0)
    {
        const x = f32(rotation);
        const y = f32(rotation + 4);
        const z = f32(rotation + 8);
        const w = f32(rotation + 12);
        r00 = 1 - 2 * (y * y + z * z);
        r01 = 2 * (x * y + z * w);
        r02 = 2 * (x * z - y * w);
        r10 = 2 * (x * y - z * w);
        r11 = 1 - 2 * (x * x + z * z);
        r12 = 2 * (y * z + x * w);
        r20 = 2 * (x * z + y * w);
        r21 = 2 * (y * z - x * w);
        r22 = 1 - 2 * (x * x + y * y);
        if (center !== 0)
        {
            const cx = f32(center);
            const cy = f32(center + 4);
            const cz = f32(center + 8);
            tx = cx - (cx * r00 + cy * r10 + cz * r20);
            ty = cy - (cx * r01 + cy * r11 + cz * r21);
            tz = cz - (cx * r02 + cy * r12 + cz * r22);
        }
    }
    if (translation !== 0)
    {
        tx = tx + f32(translation);
        ty = ty + f32(translation + 4);
        tz = tz + f32(translation + 8);
    }
    setF32(out, scaling * r00);
    setF32(out + 4, scaling * r01);
    setF32(out + 8, scaling * r02);
    setU32(out + 12, 0);
    setF32(out + 16, scaling * r10);
    setF32(out + 20, scaling * r11);
    setF32(out + 24, scaling * r12);
    setU32(out + 28, 0);
    setF32(out + 32, scaling * r20);
    setF32(out + 36, scaling * r21);
    setF32(out + 40, scaling * r22);
    setU32(out + 44, 0);
    setF32(out + 48, tx);
    setF32(out + 52, ty);
    setF32(out + 56, tz);
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixTransformation(D3DXMATRIX *out,
 *     const D3DXVECTOR3 *scalingCenter, const D3DXQUATERNION *scalingRotation,
 *     const D3DXVECTOR3 *scaling, const D3DXVECTOR3 *rotationCenter,
 *     const D3DXQUATERNION *rotation, const D3DXVECTOR3 *translation)
 *
 * Msc^-1 Msr^-1 Ms Msr Msc Mrc^-1 Mr Mrc Mt, each pointer NULL for its
 * identity: the scaling S (none without a scaling, its rotation and centre
 * then unused) in the frame the scaling rotation turns it to, R1' S R1 --
 * the inverse rotation the transposed matrix, as the conjugate quaternion's
 * is -- displaced by -sc A + sc about its centre; then the rotation B about
 * its centre, -rc B + rc; then the translation. The 3x3 is A B, the last
 * row the scaling's displacement through B, the rotation's and the
 * translation added.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} scalingCenter @param {u32} scalingRotation
 * @param {u32} scaling @param {u32} rotationCenter @param {u32} rotation @param {u32} translation
 * @returns {u32}
 */
export function D3DXMatrixTransformation({ f32, setU32, setF32 }, out, scalingCenter,
    scalingRotation, scaling, rotationCenter, rotation, translation)
{
    /** @type {f64} */
    let a00 = 1;
    /** @type {f64} */
    let a01 = 0;
    /** @type {f64} */
    let a02 = 0;
    /** @type {f64} */
    let a10 = 0;
    /** @type {f64} */
    let a11 = 1;
    /** @type {f64} */
    let a12 = 0;
    /** @type {f64} */
    let a20 = 0;
    /** @type {f64} */
    let a21 = 0;
    /** @type {f64} */
    let a22 = 1;
    /** @type {f64} */
    let sx = 0;
    /** @type {f64} */
    let sy = 0;
    /** @type {f64} */
    let sz = 0;
    if (scaling !== 0)
    {
        const kx = f32(scaling);
        const ky = f32(scaling + 4);
        const kz = f32(scaling + 8);
        a00 = kx;
        a11 = ky;
        a22 = kz;
        if (scalingRotation !== 0)
        {
            const x = f32(scalingRotation);
            const y = f32(scalingRotation + 4);
            const z = f32(scalingRotation + 8);
            const w = f32(scalingRotation + 12);
            const q00 = 1 - 2 * (y * y + z * z);
            const q01 = 2 * (x * y + z * w);
            const q02 = 2 * (x * z - y * w);
            const q10 = 2 * (x * y - z * w);
            const q11 = 1 - 2 * (x * x + z * z);
            const q12 = 2 * (y * z + x * w);
            const q20 = 2 * (x * z + y * w);
            const q21 = 2 * (y * z - x * w);
            const q22 = 1 - 2 * (x * x + y * y);
            // R1' S R1: element (i, j) the sum over k of R1[k][i] S[k] R1[k][j].
            a00 = q00 * kx * q00 + q10 * ky * q10 + q20 * kz * q20;
            a01 = q00 * kx * q01 + q10 * ky * q11 + q20 * kz * q21;
            a02 = q00 * kx * q02 + q10 * ky * q12 + q20 * kz * q22;
            a10 = q01 * kx * q00 + q11 * ky * q10 + q21 * kz * q20;
            a11 = q01 * kx * q01 + q11 * ky * q11 + q21 * kz * q21;
            a12 = q01 * kx * q02 + q11 * ky * q12 + q21 * kz * q22;
            a20 = q02 * kx * q00 + q12 * ky * q10 + q22 * kz * q20;
            a21 = q02 * kx * q01 + q12 * ky * q11 + q22 * kz * q21;
            a22 = q02 * kx * q02 + q12 * ky * q12 + q22 * kz * q22;
        }
        if (scalingCenter !== 0)
        {
            const cx = f32(scalingCenter);
            const cy = f32(scalingCenter + 4);
            const cz = f32(scalingCenter + 8);
            sx = cx - (cx * a00 + cy * a10 + cz * a20);
            sy = cy - (cx * a01 + cy * a11 + cz * a21);
            sz = cz - (cx * a02 + cy * a12 + cz * a22);
        }
    }
    /** @type {f64} */
    let b00 = 1;
    /** @type {f64} */
    let b01 = 0;
    /** @type {f64} */
    let b02 = 0;
    /** @type {f64} */
    let b10 = 0;
    /** @type {f64} */
    let b11 = 1;
    /** @type {f64} */
    let b12 = 0;
    /** @type {f64} */
    let b20 = 0;
    /** @type {f64} */
    let b21 = 0;
    /** @type {f64} */
    let b22 = 1;
    /** @type {f64} */
    let tx = sx;
    /** @type {f64} */
    let ty = sy;
    /** @type {f64} */
    let tz = sz;
    if (rotation !== 0)
    {
        const x = f32(rotation);
        const y = f32(rotation + 4);
        const z = f32(rotation + 8);
        const w = f32(rotation + 12);
        b00 = 1 - 2 * (y * y + z * z);
        b01 = 2 * (x * y + z * w);
        b02 = 2 * (x * z - y * w);
        b10 = 2 * (x * y - z * w);
        b11 = 1 - 2 * (x * x + z * z);
        b12 = 2 * (y * z + x * w);
        b20 = 2 * (x * z + y * w);
        b21 = 2 * (y * z - x * w);
        b22 = 1 - 2 * (x * x + y * y);
        tx = sx * b00 + sy * b10 + sz * b20;
        ty = sx * b01 + sy * b11 + sz * b21;
        tz = sx * b02 + sy * b12 + sz * b22;
        if (rotationCenter !== 0)
        {
            const cx = f32(rotationCenter);
            const cy = f32(rotationCenter + 4);
            const cz = f32(rotationCenter + 8);
            tx = tx + (cx - (cx * b00 + cy * b10 + cz * b20));
            ty = ty + (cy - (cx * b01 + cy * b11 + cz * b21));
            tz = tz + (cz - (cx * b02 + cy * b12 + cz * b22));
        }
    }
    if (translation !== 0)
    {
        tx = tx + f32(translation);
        ty = ty + f32(translation + 4);
        tz = tz + f32(translation + 8);
    }
    setF32(out, a00 * b00 + a01 * b10 + a02 * b20);
    setF32(out + 4, a00 * b01 + a01 * b11 + a02 * b21);
    setF32(out + 8, a00 * b02 + a01 * b12 + a02 * b22);
    setU32(out + 12, 0);
    setF32(out + 16, a10 * b00 + a11 * b10 + a12 * b20);
    setF32(out + 20, a10 * b01 + a11 * b11 + a12 * b21);
    setF32(out + 24, a10 * b02 + a11 * b12 + a12 * b22);
    setU32(out + 28, 0);
    setF32(out + 32, a20 * b00 + a21 * b10 + a22 * b20);
    setF32(out + 36, a20 * b01 + a21 * b11 + a22 * b21);
    setF32(out + 40, a20 * b02 + a21 * b12 + a22 * b22);
    setU32(out + 44, 0);
    setF32(out + 48, tx);
    setF32(out + 52, ty);
    setF32(out + 56, tz);
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixAffineTransformation2D(D3DXMATRIX *out, FLOAT scaling,
 *     const D3DXVECTOR2 *center, FLOAT angle, const D3DXVECTOR2 *translation)
 * -- in the xy plane, as the 3D form: the rotation about z scaled, the
 * centre's displacement unscaled.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f32} scaling @param {u32} center
 * @param {f32} angle @param {u32} translation
 * @returns {u32}
 */
export function D3DXMatrixAffineTransformation2D({ f32, setU32, setF32 }, out, scaling, center,
    angle, translation)
{
    const a = turn(angle);
    const s = Math.sin(a);
    const c = Math.cos(a);
    /** @type {f64} */
    let tx = 0;
    /** @type {f64} */
    let ty = 0;
    if (center !== 0)
    {
        const cx = f32(center);
        const cy = f32(center + 4);
        tx = cx - (cx * c - cy * s);
        ty = cy - (cx * s + cy * c);
    }
    if (translation !== 0)
    {
        tx = tx + f32(translation);
        ty = ty + f32(translation + 4);
    }
    setF32(out, scaling * c);
    setF32(out + 4, scaling * s);
    setU32(out + 8, 0);
    setU32(out + 12, 0);
    setF32(out + 16, -(scaling * s));
    setF32(out + 20, scaling * c);
    setU32(out + 24, 0);
    setU32(out + 28, 0);
    setU32(out + 32, 0);
    setU32(out + 36, 0);
    setU32(out + 40, ONE);
    setU32(out + 44, 0);
    setF32(out + 48, tx);
    setF32(out + 52, ty);
    setU32(out + 56, 0);
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixTransformation2D(D3DXMATRIX *out,
 *     const D3DXVECTOR2 *scalingCenter, FLOAT scalingRotation,
 *     const D3DXVECTOR2 *scaling, const D3DXVECTOR2 *rotationCenter,
 *     FLOAT rotation, const D3DXVECTOR2 *translation) -- D3DXMatrixTransformation
 * in the xy plane, its rotations about z by the angles.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} scalingCenter @param {f32} scalingRotation
 * @param {u32} scaling @param {u32} rotationCenter @param {f32} rotation @param {u32} translation
 * @returns {u32}
 */
export function D3DXMatrixTransformation2D({ f32, setU32, setF32 }, out, scalingCenter,
    scalingRotation, scaling, rotationCenter, rotation, translation)
{
    /** @type {f64} */
    let a00 = 1;
    /** @type {f64} */
    let a01 = 0;
    /** @type {f64} */
    let a10 = 0;
    /** @type {f64} */
    let a11 = 1;
    /** @type {f64} */
    let sx = 0;
    /** @type {f64} */
    let sy = 0;
    if (scaling !== 0)
    {
        const kx = f32(scaling);
        const ky = f32(scaling + 4);
        const turned = turn(scalingRotation);
        const qs = Math.sin(turned);
        const qc = Math.cos(turned);
        // R1' S R1 of R1 = [c s; -s c].
        a00 = qc * kx * qc + qs * ky * qs;
        a01 = qc * kx * qs - qs * ky * qc;
        a10 = qs * kx * qc - qc * ky * qs;
        a11 = qs * kx * qs + qc * ky * qc;
        if (scalingCenter !== 0)
        {
            const cx = f32(scalingCenter);
            const cy = f32(scalingCenter + 4);
            sx = cx - (cx * a00 + cy * a10);
            sy = cy - (cx * a01 + cy * a11);
        }
    }
    const r = turn(rotation);
    const s = Math.sin(r);
    const c = Math.cos(r);
    let tx = sx * c - sy * s;
    let ty = sx * s + sy * c;
    if (rotationCenter !== 0)
    {
        const cx = f32(rotationCenter);
        const cy = f32(rotationCenter + 4);
        tx = tx + (cx - (cx * c - cy * s));
        ty = ty + (cy - (cx * s + cy * c));
    }
    if (translation !== 0)
    {
        tx = tx + f32(translation);
        ty = ty + f32(translation + 4);
    }
    setF32(out, a00 * c - a01 * s);
    setF32(out + 4, a00 * s + a01 * c);
    setU32(out + 8, 0);
    setU32(out + 12, 0);
    setF32(out + 16, a10 * c - a11 * s);
    setF32(out + 20, a10 * s + a11 * c);
    setU32(out + 24, 0);
    setU32(out + 28, 0);
    setU32(out + 32, 0);
    setU32(out + 36, 0);
    setU32(out + 40, ONE);
    setU32(out + 44, 0);
    setF32(out + 48, tx);
    setF32(out + 52, ty);
    setU32(out + 56, 0);
    setU32(out + 60, ONE);
    return out;
}

/**
 * HRESULT D3DXMatrixDecompose(D3DXVECTOR3 *scale, D3DXQUATERNION *rotation,
 *     D3DXVECTOR3 *translation, const D3DXMATRIX *m) -- the translation the
 * last row, each scale its row's length, the rotation the quaternion of the
 * rows divided by their scales (as D3DXQuaternionRotationMatrix forms it);
 * a row of length 0 answers D3DERR_INVALIDCALL, the scale and the
 * translation written and the rotation not.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} scale @param {u32} rotation @param {u32} translation
 * @param {u32} m
 * @returns {u32}
 */
export function D3DXMatrixDecompose({ f32, u32, setU32, setF32 }, scale, rotation, translation, m){
    const e0 = f32(m);
    const e1 = f32(m + 4);
    const e2 = f32(m + 8);
    const e4 = f32(m + 16);
    const e5 = f32(m + 20);
    const e6 = f32(m + 24);
    const e8 = f32(m + 32);
    const e9 = f32(m + 36);
    const e10 = f32(m + 40);
    const px = u32(m + 48);
    const py = u32(m + 52);
    const pz = u32(m + 56);
    const sx = Math.sqrt(e0 * e0 + e1 * e1 + e2 * e2);
    const sy = Math.sqrt(e4 * e4 + e5 * e5 + e6 * e6);
    const sz = Math.sqrt(e8 * e8 + e9 * e9 + e10 * e10);
    setF32(scale, sx);
    setF32(scale + 4, sy);
    setF32(scale + 8, sz);
    setU32(translation, px);
    setU32(translation + 4, py);
    setU32(translation + 8, pz);
    if (sx === 0 || sy === 0 || sz === 0)
    {
        return D3DERR_INVALIDCALL;
    }
    const m00 = e0 / sx;
    const m01 = e1 / sx;
    const m02 = e2 / sx;
    const m10 = e4 / sy;
    const m11 = e5 / sy;
    const m12 = e6 / sy;
    const m20 = e8 / sz;
    const m21 = e9 / sz;
    const m22 = e10 / sz;
    if (m00 + m11 + m22 > 0)
    {
        const t = 2 * Math.sqrt(m00 + m11 + m22 + 1);
        setF32(rotation, (m12 - m21) / t);
        setF32(rotation + 4, (m20 - m02) / t);
        setF32(rotation + 8, (m01 - m10) / t);
        setF32(rotation + 12, t / 4);
    }
    else if (m00 >= m11 && m00 >= m22)
    {
        const t = 2 * Math.sqrt(1 + m00 - m11 - m22);
        setF32(rotation, t / 4);
        setF32(rotation + 4, (m01 + m10) / t);
        setF32(rotation + 8, (m02 + m20) / t);
        setF32(rotation + 12, (m12 - m21) / t);
    }
    else if (m11 >= m22)
    {
        const t = 2 * Math.sqrt(1 + m11 - m00 - m22);
        setF32(rotation, (m01 + m10) / t);
        setF32(rotation + 4, t / 4);
        setF32(rotation + 8, (m12 + m21) / t);
        setF32(rotation + 12, (m20 - m02) / t);
    }
    else
    {
        const t = 2 * Math.sqrt(1 + m22 - m00 - m11);
        setF32(rotation, (m02 + m20) / t);
        setF32(rotation + 4, (m12 + m21) / t);
        setF32(rotation + 8, t / 4);
        setF32(rotation + 12, (m01 - m10) / t);
    }
    return 0;
}
