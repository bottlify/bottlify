/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The matrix stacks.
 *
 * **Storage is column-major**, which is the specification and also the single
 * most common place to be wrong: `m[12]`, `m[13]`, `m[14]` are the translation,
 * not the bottom row. Every function here is written against that indexing, and
 * the tests check a multiplication result numerically rather than checking that
 * a multiply was called -- a transposed implementation passes every structural
 * test ever written and produces a scene that is subtly, unfixably wrong.
 *
 * The stacks are per mode and are **not the same size**. A program that pushes
 * the projection matrix twice is relying on a depth the specification does not
 * guarantee, and the overflow it gets is the contract, not a bug in it.
 *
 * A push copies the current matrix onto the stack and leaves the current one
 * where it was; a pop replaces the current one with the top of the stack. So
 * the reported stack depth is one on a fresh context -- it counts the current
 * matrix, not the saved ones.
 */

/**
 * The minimum depths the specification requires. They are minima in the
 * specification and exact here: reporting more would let a program push past
 * what a conforming implementation supports and never find out.
 */
export const STACK_LIMITS = Object.freeze({
    modelview: 32,
    projection: 2,
    texture: 2,
});

/** @returns {Float64Array} */
export function identity(){
    const m = new Float64Array(16);
    m[0] = 1;
    m[5] = 1;
    m[10] = 1;
    m[15] = 1;
    return m;
}

/**
 * Column-major product `a * b`, in the order the fixed-function pipeline reads
 * it: a column vector is transformed by `a * b * v`, so `b` applies first.
 *
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {Float64Array}
 */
export function multiply(a, b){
    const out = new Float64Array(16);
    for (let column = 0; column < 4; column++)
    {
        for (let row = 0; row < 4; row++)
        {
            let sum = 0;
            for (let k = 0; k < 4; k++)
            {
                sum += a[k * 4 + row] * b[column * 4 + k];
            }
            out[column * 4 + row] = sum;
        }
    }
    return out;
}

/**
 * A column vector through a column-major matrix: `m * v`.
 *
 * @param {ArrayLike<number>} m
 * @param {readonly number[]} v  four components
 * @returns {number[]} four components
 */
export function transform(m, v){
    const out = [0, 0, 0, 0];
    for (let row = 0; row < 4; row++)
    {
        let sum = 0;
        for (let k = 0; k < 4; k++)
        {
            sum += m[k * 4 + row] * v[k];
        }
        out[row] = sum;
    }
    return out;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {Float64Array}
 */
export function translation(x, y, z){
    const m = identity();
    m[12] = x;
    m[13] = y;
    m[14] = z;
    return m;
}

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {Float64Array}
 */
export function scaling(x, y, z){
    const m = identity();
    m[0] = x;
    m[5] = y;
    m[10] = z;
    return m;
}

/**
 * Rotation by `angle` degrees about an arbitrary axis. The axis is normalised
 * first; a zero-length axis has no rotation to describe and yields the
 * identity rather than a matrix full of NaN.
 *
 * @param {number} angle  degrees, as the entry point takes them
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @returns {Float64Array}
 */
export function rotation(angle, x, y, z){
    const length = Math.hypot(x, y, z);
    if (length === 0)
    {
        return identity();
    }
    const nx = x / length;
    const ny = y / length;
    const nz = z / length;
    const radians = angle * Math.PI / 180;
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    const t = 1 - c;
    const m = identity();
    m[0] = t * nx * nx + c;
    m[1] = t * nx * ny + s * nz;
    m[2] = t * nx * nz - s * ny;
    m[4] = t * nx * ny - s * nz;
    m[5] = t * ny * ny + c;
    m[6] = t * ny * nz + s * nx;
    m[8] = t * nx * nz + s * ny;
    m[9] = t * ny * nz - s * nx;
    m[10] = t * nz * nz + c;
    return m;
}

/**
 * @param {number} left
 * @param {number} right
 * @param {number} bottom
 * @param {number} top
 * @param {number} near
 * @param {number} far
 * @returns {Float64Array | null} null when an extent is degenerate
 */
export function ortho(left, right, bottom, top, near, far){
    if (left === right || bottom === top || near === far)
    {
        return null;
    }
    const m = identity();
    m[0] = 2 / (right - left);
    m[5] = 2 / (top - bottom);
    m[10] = -2 / (far - near);
    m[12] = -(right + left) / (right - left);
    m[13] = -(top + bottom) / (top - bottom);
    m[14] = -(far + near) / (far - near);
    return m;
}

/**
 * @param {number} left
 * @param {number} right
 * @param {number} bottom
 * @param {number} top
 * @param {number} near
 * @param {number} far
 * @returns {Float64Array | null} null when the arguments do not describe a frustum
 */
export function frustum(left, right, bottom, top, near, far){
    if (near <= 0 || far <= 0 || left === right || bottom === top || near === far)
    {
        return null;
    }
    const m = new Float64Array(16);
    m[0] = 2 * near / (right - left);
    m[5] = 2 * near / (top - bottom);
    m[8] = (right + left) / (right - left);
    m[9] = (top + bottom) / (top - bottom);
    m[10] = -(far + near) / (far - near);
    m[11] = -1;
    m[14] = -2 * far * near / (far - near);
    return m;
}

/**
 * @typedef {Object} MatrixStack
 * @property {Float64Array} current
 * @property {Float64Array[]} saved
 * @property {number} limit
 */

/**
 * @returns {Record<string, MatrixStack>} one stack per matrix mode
 */
export function createMatrixStacks(){
    /** @type {Record<string, MatrixStack>} */
    const stacks = {};
    for (const [mode, limit] of Object.entries(STACK_LIMITS))
    {
        stacks[mode] = { current: identity(), saved: [], limit };
    }
    return stacks;
}
