/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * d3dx9's matrix and vector arithmetic as code in the guest's own d3dx9,
 * written once: each `@guestCode` function here is compiled by the build
 * (`scripts/guest-code/compile.mjs`) into `inguest.x86.js`, and is itself
 * the export's handler and the reference its x86 is held to.
 *
 * Every function reads floats, computes on the x87 under the precision
 * control the program set -- a program under Direct3D computes to 24 bits,
 * as any x87 code in its process does -- and stores floats, rounded to
 * nearest. Each reads its inputs whole before it writes its
 * output, as if through a temporary: `D3DXMatrixMultiply(m, m, n)` and a
 * vector transformed onto itself answer what they would into a place of
 * their own.
 *
 * Matrices are row-major, sixteen floats, `m[row * 4 + col]`; a vector is a
 * row on the matrix's left.
 */

/** @typedef {import('../msvcrt/guest-code.js').Guest} Guest */
/** @typedef {import('../msvcrt/guest-code.js').u32} u32 */
/** @typedef {import('../msvcrt/guest-code.js').f32} f32 */

/** 1.0f's bits. */
const ONE = 0x3f800000;

/**
 * D3DXMATRIX *D3DXMatrixMultiply(D3DXMATRIX *out, const D3DXMATRIX *a, const D3DXMATRIX *b)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} a @param {u32} b
 * @returns {u32}
 */
export function D3DXMatrixMultiply({ f32, setF32 }, out, a, b){
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
    setF32(out + 4, m01);
    setF32(out + 8, m02);
    setF32(out + 12, m03);
    setF32(out + 16, m10);
    setF32(out + 20, m11);
    setF32(out + 24, m12);
    setF32(out + 28, m13);
    setF32(out + 32, m20);
    setF32(out + 36, m21);
    setF32(out + 40, m22);
    setF32(out + 44, m23);
    setF32(out + 48, m30);
    setF32(out + 52, m31);
    setF32(out + 56, m32);
    setF32(out + 60, m33);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixTranspose(D3DXMATRIX *out, const D3DXMATRIX *m) -- the
 * floats' bits moved as they are.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} m
 * @returns {u32}
 */
export function D3DXMatrixTranspose({ u32, setU32 }, out, m){
    const t0 = u32(m);
    const t1 = u32(m + 4);
    const t2 = u32(m + 8);
    const t3 = u32(m + 12);
    const t4 = u32(m + 16);
    const t5 = u32(m + 20);
    const t6 = u32(m + 24);
    const t7 = u32(m + 28);
    const t8 = u32(m + 32);
    const t9 = u32(m + 36);
    const t10 = u32(m + 40);
    const t11 = u32(m + 44);
    const t12 = u32(m + 48);
    const t13 = u32(m + 52);
    const t14 = u32(m + 56);
    const t15 = u32(m + 60);
    setU32(out, t0);
    setU32(out + 4, t4);
    setU32(out + 8, t8);
    setU32(out + 12, t12);
    setU32(out + 16, t1);
    setU32(out + 20, t5);
    setU32(out + 24, t9);
    setU32(out + 28, t13);
    setU32(out + 32, t2);
    setU32(out + 36, t6);
    setU32(out + 40, t10);
    setU32(out + 44, t14);
    setU32(out + 48, t3);
    setU32(out + 52, t7);
    setU32(out + 56, t11);
    setU32(out + 60, t15);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixInverse(D3DXMATRIX *out, FLOAT *determinant, const D3DXMATRIX *m)
 *
 * By cofactors: the determinant written where a pointer for it is given,
 * and NULL answered for a singular matrix, out and the determinant
 * untouched -- Wine's conformance test finds the library leaves a
 * determinant of 5 as it was.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} determinant @param {u32} m
 * @returns {u32}
 */
export function D3DXMatrixInverse({ f32, setF32 }, out, determinant, m){
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
    const c0 = e5 * e10 * e15 - e5 * e11 * e14 - e9 * e6 * e15
        + e9 * e7 * e14 + e13 * e6 * e11 - e13 * e7 * e10;
    const c1 = -e1 * e10 * e15 + e1 * e11 * e14 + e9 * e2 * e15
        - e9 * e3 * e14 - e13 * e2 * e11 + e13 * e3 * e10;
    const c2 = e1 * e6 * e15 - e1 * e7 * e14 - e5 * e2 * e15
        + e5 * e3 * e14 + e13 * e2 * e7 - e13 * e3 * e6;
    const c3 = -e1 * e6 * e11 + e1 * e7 * e10 + e5 * e2 * e11
        - e5 * e3 * e10 - e9 * e2 * e7 + e9 * e3 * e6;
    const c4 = -e4 * e10 * e15 + e4 * e11 * e14 + e8 * e6 * e15
        - e8 * e7 * e14 - e12 * e6 * e11 + e12 * e7 * e10;
    const c5 = e0 * e10 * e15 - e0 * e11 * e14 - e8 * e2 * e15
        + e8 * e3 * e14 + e12 * e2 * e11 - e12 * e3 * e10;
    const c6 = -e0 * e6 * e15 + e0 * e7 * e14 + e4 * e2 * e15
        - e4 * e3 * e14 - e12 * e2 * e7 + e12 * e3 * e6;
    const c7 = e0 * e6 * e11 - e0 * e7 * e10 - e4 * e2 * e11
        + e4 * e3 * e10 + e8 * e2 * e7 - e8 * e3 * e6;
    const c8 = e4 * e9 * e15 - e4 * e11 * e13 - e8 * e5 * e15
        + e8 * e7 * e13 + e12 * e5 * e11 - e12 * e7 * e9;
    const c9 = -e0 * e9 * e15 + e0 * e11 * e13 + e8 * e1 * e15
        - e8 * e3 * e13 - e12 * e1 * e11 + e12 * e3 * e9;
    const c10 = e0 * e5 * e15 - e0 * e7 * e13 - e4 * e1 * e15
        + e4 * e3 * e13 + e12 * e1 * e7 - e12 * e3 * e5;
    const c11 = -e0 * e5 * e11 + e0 * e7 * e9 + e4 * e1 * e11
        - e4 * e3 * e9 - e8 * e1 * e7 + e8 * e3 * e5;
    const c12 = -e4 * e9 * e14 + e4 * e10 * e13 + e8 * e5 * e14
        - e8 * e6 * e13 - e12 * e5 * e10 + e12 * e6 * e9;
    const c13 = e0 * e9 * e14 - e0 * e10 * e13 - e8 * e1 * e14
        + e8 * e2 * e13 + e12 * e1 * e10 - e12 * e2 * e9;
    const c14 = -e0 * e5 * e14 + e0 * e6 * e13 + e4 * e1 * e14
        - e4 * e2 * e13 - e12 * e1 * e6 + e12 * e2 * e5;
    const c15 = e0 * e5 * e10 - e0 * e6 * e9 - e4 * e1 * e10
        + e4 * e2 * e9 + e8 * e1 * e6 - e8 * e2 * e5;
    const det = e0 * c0 + e1 * c4 + e2 * c8 + e3 * c12;
    if (det === 0)
    {
        return 0;
    }
    if (determinant !== 0)
    {
        setF32(determinant, det);
    }
    const scale = 1 / det;
    setF32(out, c0 * scale);
    setF32(out + 4, c1 * scale);
    setF32(out + 8, c2 * scale);
    setF32(out + 12, c3 * scale);
    setF32(out + 16, c4 * scale);
    setF32(out + 20, c5 * scale);
    setF32(out + 24, c6 * scale);
    setF32(out + 28, c7 * scale);
    setF32(out + 32, c8 * scale);
    setF32(out + 36, c9 * scale);
    setF32(out + 40, c10 * scale);
    setF32(out + 44, c11 * scale);
    setF32(out + 48, c12 * scale);
    setF32(out + 52, c13 * scale);
    setF32(out + 56, c14 * scale);
    setF32(out + 60, c15 * scale);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixTranslation(D3DXMATRIX *out, FLOAT x, FLOAT y, FLOAT z) --
 * the identity with the three in its last row, their bits as they came.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} x @param {u32} y @param {u32} z
 * @returns {u32}
 */
export function D3DXMatrixTranslation({ setU32 }, out, x, y, z){
    setU32(out, ONE);
    setU32(out + 4, 0);
    setU32(out + 8, 0);
    setU32(out + 12, 0);
    setU32(out + 16, 0);
    setU32(out + 20, ONE);
    setU32(out + 24, 0);
    setU32(out + 28, 0);
    setU32(out + 32, 0);
    setU32(out + 36, 0);
    setU32(out + 40, ONE);
    setU32(out + 44, 0);
    setU32(out + 48, x);
    setU32(out + 52, y);
    setU32(out + 56, z);
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixOrthoLH(D3DXMATRIX *out, FLOAT w, FLOAT h, FLOAT zn, FLOAT zf)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f32} w @param {f32} h @param {f32} zn
 * @param {f32} zf
 * @returns {u32}
 */
export function D3DXMatrixOrthoLH({ setU32, setF32 }, out, w, h, zn, zf){
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
    setF32(out + 40, 1 / (zf - zn));
    setU32(out + 44, 0);
    setU32(out + 48, 0);
    setU32(out + 52, 0);
    setF32(out + 56, zn / (zn - zf));
    setU32(out + 60, ONE);
    return out;
}

/**
 * D3DXMATRIX *D3DXMatrixPerspectiveLH(D3DXMATRIX *out, FLOAT w, FLOAT h, FLOAT zn, FLOAT zf)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {f32} w @param {f32} h @param {f32} zn
 * @param {f32} zf
 * @returns {u32}
 */
export function D3DXMatrixPerspectiveLH({ setU32, setF32 }, out, w, h, zn, zf){
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
    setF32(out + 40, zf / (zf - zn));
    setU32(out + 44, ONE);
    setU32(out + 48, 0);
    setU32(out + 52, 0);
    setF32(out + 56, zn * zf / (zn - zf));
    setU32(out + 60, 0);
    return out;
}

/**
 * D3DXVECTOR4 *D3DXVec4Transform(D3DXVECTOR4 *out, const D3DXVECTOR4 *v, const D3DXMATRIX *m)
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v @param {u32} m
 * @returns {u32}
 */
export function D3DXVec4Transform({ f32, setF32 }, out, v, m){
    const vx = f32(v);
    const vy = f32(v + 4);
    const vz = f32(v + 8);
    const vw = f32(v + 12);
    const x = vx * f32(m) + vy * f32(m + 16)
        + vz * f32(m + 32) + vw * f32(m + 48);
    const y = vx * f32(m + 4) + vy * f32(m + 20)
        + vz * f32(m + 36) + vw * f32(m + 52);
    const z = vx * f32(m + 8) + vy * f32(m + 24)
        + vz * f32(m + 40) + vw * f32(m + 56);
    const w = vx * f32(m + 12) + vy * f32(m + 28)
        + vz * f32(m + 44) + vw * f32(m + 60);
    setF32(out, x);
    setF32(out + 4, y);
    setF32(out + 8, z);
    setF32(out + 12, w);
    return out;
}

/**
 * D3DXVECTOR4 *D3DXVec3Transform(D3DXVECTOR4 *out, const D3DXVECTOR3 *v, const D3DXMATRIX *m)
 * -- the point with a w of 1: the matrix's last row added whole.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v @param {u32} m
 * @returns {u32}
 */
export function D3DXVec3Transform({ f32, setF32 }, out, v, m){
    const vx = f32(v);
    const vy = f32(v + 4);
    const vz = f32(v + 8);
    const x = vx * f32(m) + vy * f32(m + 16)
        + vz * f32(m + 32) + f32(m + 48);
    const y = vx * f32(m + 4) + vy * f32(m + 20)
        + vz * f32(m + 36) + f32(m + 52);
    const z = vx * f32(m + 8) + vy * f32(m + 24)
        + vz * f32(m + 40) + f32(m + 56);
    const w = vx * f32(m + 12) + vy * f32(m + 28)
        + vz * f32(m + 44) + f32(m + 60);
    setF32(out, x);
    setF32(out + 4, y);
    setF32(out + 8, z);
    setF32(out + 12, w);
    return out;
}

/**
 * D3DXVECTOR3 *D3DXVec3TransformNormal(D3DXVECTOR3 *out, const D3DXVECTOR3 *v,
 *     const D3DXMATRIX *m) -- a direction: the last row, the translation, not taken.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v @param {u32} m
 * @returns {u32}
 */
export function D3DXVec3TransformNormal({ f32, setF32 }, out, v, m){
    const vx = f32(v);
    const vy = f32(v + 4);
    const vz = f32(v + 8);
    const x = vx * f32(m) + vy * f32(m + 16)
        + vz * f32(m + 32);
    const y = vx * f32(m + 4) + vy * f32(m + 20)
        + vz * f32(m + 36);
    const z = vx * f32(m + 8) + vy * f32(m + 24)
        + vz * f32(m + 40);
    setF32(out, x);
    setF32(out + 4, y);
    setF32(out + 8, z);
    return out;
}

/**
 * D3DXVECTOR3 *D3DXVec3TransformCoord(D3DXVECTOR3 *out, const D3DXVECTOR3 *v,
 *     const D3DXMATRIX *m) -- the point transformed with a w of 1 and divided
 * by the w it comes to, each rounded to a float first; a w of 0 divides by 1.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v @param {u32} m
 * @returns {u32}
 */
export function D3DXVec3TransformCoord({ f32, setF32 }, out, v, m){
    const vx = f32(v);
    const vy = f32(v + 4);
    const vz = f32(v + 8);
    const w = Math.fround(vx * f32(m + 12) + vy * f32(m + 28) + vz * f32(m + 44) + f32(m + 60));
    const divisor = w === 0 ? 1 : w;
    const x = Math.fround(vx * f32(m) + vy * f32(m + 16)
        + vz * f32(m + 32) + f32(m + 48));
    const y = Math.fround(vx * f32(m + 4) + vy * f32(m + 20)
        + vz * f32(m + 36) + f32(m + 52));
    const z = Math.fround(vx * f32(m + 8) + vy * f32(m + 24)
        + vz * f32(m + 40) + f32(m + 56));
    setF32(out, x / divisor);
    setF32(out + 4, y / divisor);
    setF32(out + 8, z / divisor);
    return out;
}

/**
 * D3DXVECTOR3 *D3DXVec3TransformCoordArray(D3DXVECTOR3 *out, UINT outStride,
 *     const D3DXVECTOR3 *v, UINT vStride, const D3DXMATRIX *m, UINT n) -- each
 * point as D3DXVec3TransformCoord transforms it, the strides in bytes, the
 * matrix read once, before the first.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} outStride @param {u32} v
 * @param {u32} vStride @param {u32} m @param {u32} n
 * @returns {u32}
 */
export function D3DXVec3TransformCoordArray({ f32, setF32 }, out, outStride, v, vStride, m, n){
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
        const w = Math.fround(vx * e3 + vy * e7 + vz * e11 + e15);
        const divisor = w === 0 ? 1 : w;
        const x = Math.fround(vx * e0 + vy * e4 + vz * e8 + e12);
        const y = Math.fround(vx * e1 + vy * e5 + vz * e9 + e13);
        const z = Math.fround(vx * e2 + vy * e6 + vz * e10 + e14);
        setF32(to, x / divisor);
        setF32(to + 4, y / divisor);
        setF32(to + 8, z / divisor);
        to = (to + outStride) >>> 0;
        from = (from + vStride) >>> 0;
    }
    return out;
}

/**
 * D3DXVECTOR3 *D3DXVec3Normalize(D3DXVECTOR3 *out, const D3DXVECTOR3 *v) -- a
 * zero vector left zero rather than divided by its length.
 *
 * @guestCode stdcall
 * @param {Guest} guest @param {u32} out @param {u32} v
 * @returns {u32}
 */
export function D3DXVec3Normalize({ f32, setF32 }, out, v){
    const x = f32(v);
    const y = f32(v + 4);
    const z = f32(v + 8);
    const length = Math.sqrt(x * x + y * y + z * z);
    const scale = length === 0 ? 0 : 1 / length;
    setF32(out, x * scale);
    setF32(out + 4, y * scale);
    setF32(out + 8, z * scale);
    return out;
}

/** The bytes of a texture coordinate set by its two bits: TEXTUREFORMAT2, 3, 4, then 1. */
export const TEXCOORD_BYTES = Uint8Array.of(8, 12, 16, 4);

/**
 * UINT D3DXGetFVFVertexSize(DWORD FVF) -- the bytes a vertex of that flexible
 * format takes: its position -- three floats, four for XYZRHW and XYZW, and
 * one more for each blend weight XYZB1 to XYZB5 add -- a normal, a point size,
 * the two colours, and each texture coordinate set at the size its two bits
 * give, at most the eight a format holds. A position the mask does not name
 * takes nothing.
 *
 * @guestCode stdcall
 * @param {u32} fvf
 * @returns {u32}
 */
export function D3DXGetFVFVertexSize(fvf){
    const position = fvf & 0x400e;
    let size = 0;
    if (position === 2)
    {
        size = 12;
    }
    else if (position === 4 || position === 0x4002)
    {
        size = 16;
    }
    else if (position >= 6 && position <= 14)
    {
        size = (position * 2 + 4) | 0;
    }
    if ((fvf & 0x10) !== 0)
    {
        size += 12;
    }
    if ((fvf & 0x20) !== 0)
    {
        size += 4;
    }
    if ((fvf & 0x40) !== 0)
    {
        size += 4;
    }
    if ((fvf & 0x80) !== 0)
    {
        size += 4;
    }
    const sets = (fvf >>> 8) & 15;
    for (let set = 0; set < sets && set < 8; set++)
    {
        size += TEXCOORD_BYTES[(fvf >>> (set * 2 + 16)) & 3];
    }
    return size >>> 0;
}
