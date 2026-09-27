/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * d3dx9's mathematics against what the library answers on Windows: the
 * values and the tolerances, in units in the last place of a float, of
 * Wine's conformance tests (`dlls/d3dx9_36/tests/math.c`) -- the inputs, the
 * NULL pointers, the aliasing and the edges they pin. Each function is its
 * source through the x87's model (`scripts/guest-code/model.mjs`), which
 * the x86 is held to bit for bit by the equivalence tests beside this one:
 * under the single-precision control word Direct3D leaves, which is how
 * the library computes, with Wine's tolerance; under double precision a few
 * units more, or a millionth for a component the library's rounding leaves
 * near zero.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { guestMemory } from '../msvcrt/guest-code.js';
import { loadModel } from '../../../../scripts/guest-code/model.mjs';

/** @param {string} name */
async function modelOf(name){
    const url = new URL(`./${name}.js`, import.meta.url);
    return loadModel(await readFile(url, 'utf8'), {
        file: `${name}.js`, url: url.href, values: await import(url.href),
    });
}

const MODELS = {
    base: await modelOf('inguest'),
    matrix: await modelOf('inguest-matrix'),
    vector: await modelOf('inguest-vector'),
    quaternion: await modelOf('inguest-quaternion'),
};

const memory = new Uint8Array(0x4000);
const view = new DataView(memory.buffer);
const guest = guestMemory({
    readMemory: (address, length)=>memory.subarray(address, address + length),
    writeMemory: (address, bytes)=>memory.set(bytes, address),
});

/** @param {number} address @param {number[]} values */
const put = (address, values)=>values.forEach((value, i)=>
    view.setFloat32(address + i * 4, value, true));

/** @param {number} address @param {number} count */
const get = (address, count)=>Array.from({ length: count }, (_, i)=>
    view.getFloat32(address + i * 4, true));

/** A float's bits. @param {number} value */
const bits = value=>{
    view.setFloat32(0x3ffc, value, true);
    return view.getUint32(0x3ffc, true);
};

/** How far apart two floats are in units in the last place. @param {number} a @param {number} b */
function ulps(a, b){
    const signed = (/** @type {number} */ x)=>{
        const word = bits(x);
        return (word & 0x80000000) !== 0 ? -(word & 0x7fffffff) : word;
    };
    return Math.abs(signed(a) - signed(b));
}

/** The control word the checks run under. */
let control = 0x07f;

/**
 * The floats the function left, against the library's.
 *
 * @param {string} what @param {number[]} got @param {number[]} want @param {number} tolerance
 */
function near(what, got, want, tolerance){
    got.forEach((value, i)=>{
        const expected = Math.fround(want[i]);
        const distance = ulps(value, expected);
        const pass = control === 0x07f ? distance <= tolerance
            : distance <= tolerance + 24 || Math.abs(value - expected) < 1e-6;
        assert.ok(pass, `${what} under 0x${control.toString(16)}, [${i}]: ${value} where the `
            + `library answers ${expected} (${distance} ulp, ${tolerance} allowed)`);
    });
}

/** The models' functions under the control word. */
const fn = /** @type {Record<string, Function>} */ (new Proxy({}, {
    get: (_, name)=>{
        for (const model of Object.values(MODELS))
        {
            model.$.control = control;
            const found = model.module[/** @type {string} */ (name)];
            if (typeof found === 'function')
            {
                return found;
            }
        }
        throw new Error(`no ${String(name)}`);
    },
}));

const OUT = 0x100;
const A = 0x200;
const B = 0x300;
const C = 0x400;
const D = 0x500;
const E = 0x600;
const F = 0x700;
const G = 0x800;
const H = 0x900;
const f = Math.fround;
const ANGLE = f(Math.PI / 3);
const MAT = [10, 5, 7, 8, 11, 20, 16, 33, 19, -21, 30, 43, 2, 3, -4, -40];
const COUNTING = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

for (const word of [0x07f, 0x27f])
{
    test(`matrices, as the library answers them, under 0x${word.toString(16)}`, ()=>{
        control = word;
        put(A, MAT);
        put(B, [1, 5, -8, -4, 2, 6, -7, -3, 3, 7, -6, -2, 4, 8, -5, -1]);
        near('D3DXMatrixDeterminant', [fn.D3DXMatrixDeterminant(guest, A)], [-147888], 0);
        fn.D3DXMatrixMultiplyTranspose(guest, OUT, A, B);
        near('D3DXMatrixMultiplyTranspose', get(OUT, 16), [73, 231, 239, -164, 193, 551, 523,
            -320, -197, -489, -400, 187, -77, -169, -116, 31], 0);
        // A singular matrix: NULL, the output and the determinant left as they were.
        put(OUT, MAT);
        put(C, [5]);
        assert.equal(fn.D3DXMatrixInverse(guest, OUT, C, B), 0);
        near('D3DXMatrixInverse of a singular matrix', [...get(OUT, 16), ...get(C, 1)],
            [...MAT, 5], 0);

        put(C, [-2, 13, -9]);
        put(D, [1, -4, 7, -11]);
        put(E, [1, -3, 7]);
        const affine = [-459.239990, -576.719971, -263.440002, 0, 519.760010, -352.440002,
            -277.679993, 0, 363.119995, -121.040001, -117.479996, 0];
        fn.D3DXMatrixAffineTransformation(guest, OUT, f(3.56), C, D, E);
        near('D3DXMatrixAffineTransformation', get(OUT, 16), [...affine, -1239, 667, 567, 1], 0);
        fn.D3DXMatrixAffineTransformation(guest, OUT, f(3.56), 0, D, E);
        near('D3DXMatrixAffineTransformation, no centre', get(OUT, 16),
            [...affine, 1, -3, 7, 1], 0);
        fn.D3DXMatrixAffineTransformation(guest, OUT, f(3.56), C, D, 0);
        near('D3DXMatrixAffineTransformation, no translation', get(OUT, 16),
            [...affine, -1240, 670, 560, 1], 0);
        fn.D3DXMatrixAffineTransformation(guest, OUT, f(3.56), C, 0, E);
        near('D3DXMatrixAffineTransformation, no rotation', get(OUT, 16),
            [3.56, 0, 0, 0, 0, 3.56, 0, 0, 0, 0, 3.56, 0, 1, -3, 7, 1], 0);

        put(C, [8, -5, 5.75]);
        put(D, [-2, 13, -9]);
        fn.D3DXMatrixLookAtLH(guest, OUT, C, D, E);
        near('D3DXMatrixLookAtLH', get(OUT, 16), [-0.82246518, -0.40948939, -0.39480308, 0,
            -0.55585691, 0.43128574, 0.71064550, 0, -0.12072885, 0.80393475, -0.58233452, 0,
            4.4946337, 0.80971903, 10.060076, 1], 32);
        fn.D3DXMatrixLookAtRH(guest, OUT, C, D, E);
        near('D3DXMatrixLookAtRH', get(OUT, 16), [0.82246518, -0.40948939, 0.39480308, 0,
            0.55585691, 0.43128574, -0.71064550, 0, 0.12072885, 0.80393475, 0.58233452, 0,
            -4.4946337, 0.80971903, -10.060076, 1], 32);

        fn.D3DXMatrixOrthoRH(guest, OUT, f(2.5), f(7.4), f(-3.2), f(-9.8));
        near('D3DXMatrixOrthoRH', get(OUT, 16), [0.8, 0, 0, 0, 0, 0.27027027, 0, 0, 0, 0,
            0.15151515, 0, 0, 0, -0.48484848, 1], 16);
        const offCenter = [f(0.2), f(0.75), f(-2.4), f(8.7)];
        fn.D3DXMatrixOrthoOffCenterLH(guest, OUT, ...offCenter, f(9.3), f(-12.6));
        near('D3DXMatrixOrthoOffCenterLH', get(OUT, 16), [3.6363636, 0, 0, 0, 0, 0.18018018, 0,
            0, 0, 0, -0.045662100, 0, -1.7272727, -0.56756757, 0.42465753, 1], 32);
        fn.D3DXMatrixOrthoOffCenterRH(guest, OUT, ...offCenter, f(9.3), f(-12.6));
        near('D3DXMatrixOrthoOffCenterRH', get(OUT, 16), [3.6363636, 0, 0, 0, 0, 0.18018018, 0,
            0, 0, 0, 0.045662100, 0, -1.7272727, -0.56756757, 0.42465753, 1], 32);
        fn.D3DXMatrixPerspectiveFovLH(guest, OUT, ...offCenter);
        near('D3DXMatrixPerspectiveFovLH', get(OUT, 16), [13.288858, 0, 0, 0, 0, 9.9666444, 0,
            0, 0, 0, 0.78378378, 1, 0, 0, 1.8810811, 0], 4);
        fn.D3DXMatrixPerspectiveFovRH(guest, OUT, ...offCenter);
        near('D3DXMatrixPerspectiveFovRH', get(OUT, 16), [13.288858, 0, 0, 0, 0, 9.9666444, 0,
            0, 0, 0, -0.78378378, -1, 0, 0, 1.8810811, 0], 4);
        fn.D3DXMatrixPerspectiveRH(guest, OUT, ...offCenter);
        near('D3DXMatrixPerspectiveRH', get(OUT, 16), [-24, 0, 0, 0, 0, -6.4, 0, 0, 0, 0,
            -0.78378378, -1, 0, 0, 1.8810811, 0], 4);
        fn.D3DXMatrixPerspectiveOffCenterLH(guest, OUT, ...offCenter, f(3.2), f(-16.9));
        near('D3DXMatrixPerspectiveOffCenterLH', get(OUT, 16), [11.636364, 0, 0, 0, 0,
            0.57657658, 0, 0, -1.7272727, -0.56756757, 0.84079602, 1, 0, 0, -2.6905473, 0], 8);
        fn.D3DXMatrixPerspectiveOffCenterRH(guest, OUT, ...offCenter, f(3.2), f(-16.9));
        near('D3DXMatrixPerspectiveOffCenterRH', get(OUT, 16), [11.636364, 0, 0, 0, 0,
            0.57657658, 0, 0, 1.7272727, 0.56756757, -0.84079602, -1, 0, 0, -2.6905473, 0], 8);

        put(F, [-3, -1, 4, 7]);
        fn.D3DXMatrixReflect(guest, OUT, F);
        near('D3DXMatrixReflect', get(OUT, 16), [0.30769235, -0.23076922, 0.92307687, 0,
            -0.23076922, 0.92307693, 0.30769232, 0, 0.92307687, 0.30769232, -0.23076922, 0,
            1.6153846, 0.53846157, -2.1538463, 1], 32);
        put(G, [9.6, 8.5, 7.4, 6.3]);
        fn.D3DXMatrixShadow(guest, OUT, G, F);
        near('D3DXMatrixShadow', get(OUT, 16), [12.786773, 5.0009613, 4.3537784, 3.7065949,
            1.8827150, 8.8056154, 1.4512594, 1.2355317, -7.5308599, -6.6679487, 1.3335901,
            -4.9421268, -13.179006, -11.668910, -10.158816, -1.5100943], 8);

        fn.D3DXMatrixRotationAxis(guest, OUT, E, ANGLE);
        near('D3DXMatrixRotationAxis', get(OUT, 16), [0.50847453, 0.76380461, 0.39756277, 0,
            -0.81465209, 0.57627118, -0.065219201, 0, -0.27891868, -0.29071301, 0.91525424, 0,
            0, 0, 0, 1], 32);
        put(H, [1, -4, 7, -11]);
        fn.D3DXMatrixRotationQuaternion(guest, OUT, H);
        near('D3DXMatrixRotationQuaternion', get(OUT, 16), [-129, -162, -74, 0, 146, -99, -78,
            0, 102, -34, -33, 0, 0, 0, 0, 1], 0);
        const s3 = Math.sqrt(f(3)) / 2;
        fn.D3DXMatrixRotationX(guest, OUT, ANGLE);
        near('D3DXMatrixRotationX', get(OUT, 16), [1, 0, 0, 0, 0, 0.5, s3, 0, 0, -s3, 0.5, 0, 0,
            0, 0, 1], 1);
        fn.D3DXMatrixRotationY(guest, OUT, ANGLE);
        near('D3DXMatrixRotationY', get(OUT, 16), [0.5, 0, -s3, 0, 0, 1, 0, 0, s3, 0, 0.5, 0, 0,
            0, 0, 1], 1);
        fn.D3DXMatrixRotationZ(guest, OUT, ANGLE);
        near('D3DXMatrixRotationZ', get(OUT, 16), [0.5, s3, 0, 0, -s3, 0.5, 0, 0, 0, 0, 1, 0, 0,
            0, 0, 1], 1);
        fn.D3DXMatrixRotationYawPitchRoll(guest, OUT, f(3 * ANGLE / 5), ANGLE, f(3 * ANGLE / 17));
        near('D3DXMatrixRotationYawPitchRoll', get(OUT, 16), [0.88877726, 0.091874748,
            -0.44903678, 0, 0.35171318, 0.49148652, 0.79670501, 0, 0.29389259, -0.86602545,
            0.40450847, 0, 0, 0, 0, 1], 64);
        fn.D3DXMatrixScaling(guest, OUT, bits(0.69), bits(0.53), bits(4.11));
        near('D3DXMatrixScaling', get(OUT, 16), [0.69, 0, 0, 0, 0, 0.53, 0, 0, 0, 0, 4.11, 0,
            0, 0, 0, 1], 0);
    });

    test(`D3DXMatrixTransformation with every pointer NULL or not, under 0x${word.toString(16)}`,
        ()=>{
            control = word;
            const at = [-2, 13, -9];
            const q = [1, -4, 7, -11];
            const axis = [1, -3, 7];
            const eye = [8, -5, 5.75];
            const r = [0.87, 0.65, 0.43, 0.21];
            const last = [9.7, -8.6, 1.3];
            const rotated = [-0.2148, 1.3116, 0.4752, 0, 0.9504, -0.8836, 0.9244, 0, 1.0212,
                0.1936, -1.3588, 0];
            const scaledRotated = [-0.2148, 1.3116, 0.4752, 0, -2.8512, 2.6508, -2.7732, 0,
                7.148399, 1.3552, -9.5116, 0];
            const turnedScale = [25521, 39984, 20148, 0, 39984, 4933, -3324, 0, 20148, -3324,
                -5153, 0];
            const both = [53094.015625, 2044.133789, 21711.687500, 0, -7294.705078, 47440.683594,
                28077.113281, 0, -12749.161133, 28365.580078, 13503.520508, 0];
            const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
            const scale = [1, 0, 0, 0, 0, -3, 0, 0, 0, 0, 7, 0];
            /** @type {[string, number[], number][]} which given, the matrix, the tolerance */
            const cases = [
                ['', [...identity, 0, 0, 0, 1], 0],
                ['t', [...identity, 9.7, -8.6, 1.3, 1], 0],
                ['r', [...rotated, 0, 0, 0, 1], 8],
                ['rc', [...identity, 0, 0, 0, 1], 0],
                ['s', [...scale, 0, 0, 0, 1], 0],
                ['sr', [...identity, 0, 0, 0, 1], 0],
                ['sc', [...identity, 0, 0, 0, 1], 0],
                ['rc r', [...rotated, 8.5985, -21.024, 14.383499, 1], 8],
                ['s r', [...scaledRotated, 0, 0, 0, 1], 8],
                ['sr r', [...rotated, 0, 0, 0, 1], 8],
                ['sr s', [...turnedScale, 0, 0, 0, 1], 0],
                ['sc s', [...scale, 0, 52, 54, 1], 0],
                ['sc sr s', [...turnedScale, -287420, -14064, 37122, 1], 0],
                ['sc s t', [...scale, 9.7, 43.400002, 55.299999, 1], 0],
                ['sc sr s t', [...turnedScale, -287410.3125, -14072.599609, 37123.300781, 1], 0],
                ['sr s rc r', [...both, 8.598499, -21.024, 14.383499, 1], 32],
                ['sc s rc r', [...scaledRotated, 113.164093, -56.5168, -10.922897, 1], 8],
                ['sc sr s r', [...both, 86280.34375, -357366.3125, -200024.125, 1], 32],
                ['sc sr s rc', [...turnedScale, -287410.3125, -14064, 37122, 1], 512],
                ['sc sr s rc r', [...both, 86280.34375, -357366.3125, -200009.75, 1], 2048],
                ['sc sr s r t', [...both, 86290.046875, -357374.90625, -200022.828125, 1], 32],
                ['sc sr rc r t', [-0.21480007, 1.3116000, 0.47520003, 0, 0.95040143, -0.88360137,
                    0.92439979, 0, 1.0212044, 0.19359307, -1.3588026, 0, 18.298532, -29.624001,
                    15.683499, 1], 512],
                ['sc s rc r t', [...scaledRotated, 122.86409, -65.116798, -9.622897, 1], 8],
                ['sr s rc r t', [...both, 18.2985, -29.624001, 15.683499, 1], 32],
            ];
            for (const [given, want, tolerance] of cases)
            {
                const names = given.split(' ');
                put(A, at);
                put(B, q);
                put(C, axis);
                put(D, eye);
                put(E, r);
                put(F, last);
                fn.D3DXMatrixTransformation(guest, OUT, ...['sc', 'sr', 's', 'rc', 'r', 't']
                    .map((name, k)=>(names.includes(name) ? [A, B, C, D, E, F][k] : 0)));
                near(`D3DXMatrixTransformation(${given})`, get(OUT, 16), want, tolerance);
            }
            // A scaling rotation that is no unit quaternion: its matrix as the formula makes it.
            /** @type {[number[], number[], number[]][]} */
            const turned = [
                [[1, 1, 1, 1], [1, 1, 2], [41, -12, -24, 0, -12, 25, -12, 0, -24, -12, 34, 0]],
                [[1, 1, 1, 0], [1, 1, 3], [25, 0, -20, 0, 0, 25, -20, 0, -20, -20, 35, 0]],
                [[1, 0, 0, 1], [0, 4, 0], [0, 0, 0, 0, 0, 4, -8, 0, 0, -8, 16, 0]],
                [[11, 13, 15, 17], [3, 3, 3], [3796587, -1377948, -1589940, 0, -1377948,
                    3334059, -1879020, 0, -1589940, -1879020, 2794443, 0]],
                [[11, 13, 15, 17], [0, 3, 0], [150528, 464352, -513408, 0, 464352, 1432443,
                    -1583772, 0, -513408, -1583772, 1751088, 0]],
            ];
            for (const [rotation, scaling, want] of turned)
            {
                put(B, rotation);
                put(C, scaling);
                fn.D3DXMatrixTransformation(guest, OUT, 0, B, C, 0, 0, 0);
                near(`D3DXMatrixTransformation of ${rotation} and ${scaling}`, get(OUT, 16),
                    [...want, 0, 0, 0, 1], 0);
            }
        });

    test(`the 2D transformations and the decomposition, under 0x${word.toString(16)}`, ()=>{
        control = word;
        const turned = [10, 17.320507, 0, 0, -17.320507, 10, 0, 0, 0, 0, 1, 0];
        put(A, [3, 4]);
        put(B, [-6, 7]);
        fn.D3DXMatrixAffineTransformation2D(guest, OUT, 20, A, ANGLE, B);
        near('D3DXMatrixAffineTransformation2D', get(OUT, 16), [...turned, -1.035898, 6.401924,
            0, 1], 2);
        fn.D3DXMatrixAffineTransformation2D(guest, OUT, 20, A, ANGLE, 0);
        near('D3DXMatrixAffineTransformation2D, no translation', get(OUT, 16),
            [...turned, 4.964102, -0.598076, 0, 1], 8);
        fn.D3DXMatrixAffineTransformation2D(guest, OUT, 20, 0, ANGLE, B);
        near('D3DXMatrixAffineTransformation2D, no centre', get(OUT, 16), [...turned, -6, 7, 0,
            1], 1);
        fn.D3DXMatrixAffineTransformation2D(guest, OUT, -20, 0, f(5 * Math.PI / 4), 0);
        near('D3DXMatrixAffineTransformation2D, negative scale', get(OUT, 16), [14.142133,
            14.142133, 0, 0, -14.142133, 14.142133, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 8);

        put(C, [12, -3]);
        put(D, [9, -5]);
        // The translation cancels terms near 100 down to 13: the library's float
        // products leave it 3.4e-5 from the value in doubles, -13.4019327, which is
        // what this answers (148 units from the library's under single precision).
        fn.D3DXMatrixTransformation2D(guest, OUT, D, f(5 * Math.PI / 4), C, A, ANGLE, B);
        near('D3DXMatrixTransformation2D', get(OUT, 16), [-4.245192, 7.647113, 0, 0, -0.147116,
            8.745192, 0, 0, 0, 0, 1, 0, 45.265373, -13.401899, 0, 1], 160);
        fn.D3DXMatrixTransformation2D(guest, OUT, D, f(5 * Math.PI / 4), 0, 0, ANGLE, B);
        near('D3DXMatrixTransformation2D, no scaling', get(OUT, 16), [0.5, 0.866025, 0, 0,
            -0.866025, 0.5, 0, 0, 0, 0, 1, 0, -6, 7, 0, 1], 8);

        /** @type {[number[], number[], number[], number, number][]} matrix, scale, rotation */
        const decompositions = [
            [[-9.23879206e-01, 2.70598471e-01, -2.70598441e-01, 0, -2.70598412e-01,
                3.80604863e-02, 9.61939573e-01, 0, 2.70598441e-01, 9.61939573e-01,
                3.80603075e-02, 0, -5, 0, 10, 1], [9.99999881e-01, 9.99999881e-01,
                9.99999881e-01], [2.14862776e-08, 6.93519890e-01, 6.93519890e-01,
                1.95090637e-01], 1, 1],
            [[-2.255813, 1.302327, 1.488371, 0, 1.302324, -0.7209296, 2.604651, 0, 1.488373,
                2.60465, -0.02325551, 0, 1, 2, 3, 1], [2.99999928, 2.99999905, 2.99999952],
            [3.52180451e-01, 6.16315663e-01, 7.04360664e-01, 3.38489343e-07], 0, 2],
            [[2.427051, 0, -1.763355, 0, 0, 3, 0, 0, 1.763355, 0, 2.427051, 0, 5, 5, 5, 1],
                [2.99999976, 3, 2.99999976], [0, 3.09016883e-01, 0, 9.51056540e-01], 1, 1],
            [[0.7156004, -0.6612288, -0.2251499, 0, -0.5098283, -0.7147621, 0.4787385, 0,
                -0.4774843, -0.2277977, -0.8485972, 0, -5, 0, 10, 1], [9.99999940e-01,
                1.00000012, 1.00000012], [9.05394852e-01, -3.23355347e-01, -1.94013178e-01,
                1.95090592e-01], 0, 1],
            [[7.12104797, 5.88348627, 1.18184204e+01, 0, -5.88348627, -1.06065865e+01,
                8.82523155, 0, 1.18184204e+01, -8.82523251, -2.72764111, 0, -5, 0, 2, 1],
            [1.49999933e+01, 1.49999933e+01, 1.49999943e+01], [7.68714130e-01, 0,
                5.12475967e-01, 3.82683903e-01], 0, 1],
        ];
        for (const [m, scale, rotation, scaleTolerance, rotationTolerance] of decompositions)
        {
            put(A, m);
            assert.equal(fn.D3DXMatrixDecompose(guest, B, C, D, A), 0);
            near('D3DXMatrixDecompose\'s scale', get(B, 3), scale, scaleTolerance);
            near('D3DXMatrixDecompose\'s rotation', get(C, 4), rotation, rotationTolerance);
            near('D3DXMatrixDecompose\'s translation', get(D, 3), m.slice(12, 15), 0);
        }
        put(A, [0, 0, 0, 0, 4, -10.6066, 8.825232, 0, 5, -8.825232, 2.727645, 0, -5, 6, 3, 1]);
        assert.equal(fn.D3DXMatrixDecompose(guest, B, C, D, A) >>> 0, 0x8876086c,
            'a row of length 0: D3DERR_INVALIDCALL');
    });

    test(`vectors, planes, colours and halves, under 0x${word.toString(16)}`, ()=>{
        control = word;
        put(A, [3, 4]);
        put(B, [-7, 9]);
        put(C, [4, -3]);
        put(D, [2, -11]);
        put(F, COUNTING);
        fn.D3DXVec2BaryCentric(guest, OUT, A, B, C, 2, 5);
        near('D3DXVec2BaryCentric', get(OUT, 2), [-12, -21], 0);
        fn.D3DXVec2CatmullRom(guest, OUT, A, B, C, D, -6.5);
        near('D3DXVec2CatmullRom', get(OUT, 2), [5820.25, -3654.5625], 0);
        fn.D3DXVec2Hermite(guest, OUT, A, B, C, D, -6.5);
        near('D3DXVec2Hermite', get(OUT, 2), [2604.625, -4533], 0);
        fn.D3DXVec2Normalize(guest, OUT, A);
        near('D3DXVec2Normalize', get(OUT, 2), [0.6, 0.8], 0);
        put(E, [0, 0]);
        fn.D3DXVec2Normalize(guest, OUT, E);
        near('D3DXVec2Normalize of zero', get(OUT, 2), [0, 0], 0);
        put(OUT, [3, 4]);
        fn.D3DXVec2Transform(guest, OUT, OUT, F);
        near('D3DXVec2Transform over its input', get(OUT, 4), [36, 44, 52, 60], 0);
        fn.D3DXVec2TransformCoord(guest, OUT, A, F);
        near('D3DXVec2TransformCoord', get(OUT, 2), [0.6, 11 / 15], 1);
        fn.D3DXVec2TransformNormal(guest, OUT, A, F);
        near('D3DXVec2TransformNormal', get(OUT, 2), [23, 30], 0);

        put(A, [9, 6, 2]);
        put(B, [2, -3, -4]);
        put(C, [3, -5, 7]);
        put(D, [4, 1, 11]);
        fn.D3DXVec3BaryCentric(guest, OUT, A, B, C, 2, 5);
        near('D3DXVec3BaryCentric', get(OUT, 3), [-35, -67, 15], 0);
        fn.D3DXVec3CatmullRom(guest, OUT, A, B, C, D, -6.5);
        near('D3DXVec3CatmullRom', get(OUT, 3), [1458, 22.1875, 4141.375], 0);
        fn.D3DXVec3Hermite(guest, OUT, A, B, C, D, -6.5);
        near('D3DXVec3Hermite', get(OUT, 3), [-6045.75, -6650, 1358.875], 0);

        put(A, [1, 2, 4, 10]);
        put(B, [-3, 4, -5, 7]);
        put(C, [4, 6, -2, 1]);
        put(D, [6, -7, 8, -9]);
        fn.D3DXVec4BaryCentric(guest, OUT, A, B, C, 2, 5);
        near('D3DXVec4BaryCentric', get(OUT, 4), [8, 26, -44, -41], 0);
        fn.D3DXVec4CatmullRom(guest, OUT, A, B, C, D, -6.5);
        near('D3DXVec4CatmullRom', get(OUT, 4), [2754.625, 2367.5625, 1060.1875, 131.3125], 0);
        fn.D3DXVec4Cross(guest, OUT, A, B, C);
        near('D3DXVec4Cross', get(OUT, 4), [390, -393, -316, 166], 0);
        fn.D3DXVec4Hermite(guest, OUT, A, B, C, D, -6.5);
        near('D3DXVec4Hermite', get(OUT, 4), [1224.625, 3461.625, -4758.875, -5781.5], 0);
        fn.D3DXVec4Normalize(guest, OUT, A);
        near('D3DXVec4Normalize', get(OUT, 4), [1 / 11, 2 / 11, 4 / 11, 10 / 11], 1);

        put(A, [11, 13, 15]);
        put(B, [17, 31, 24]);
        fn.D3DXPlaneFromPointNormal(guest, OUT, A, B);
        near('D3DXPlaneFromPointNormal', get(OUT, 4), [17, 31, 24, -950], 0);
        // Over its own point: the normal written first is what d is made of.
        put(OUT, [11, 13, 15]);
        fn.D3DXPlaneFromPointNormal(guest, OUT, OUT, B);
        near('D3DXPlaneFromPointNormal over its point', get(OUT, 4), [17, 31, 24, -1826], 0);
        put(A, [1, 2, 3]);
        put(B, [1, -6, -5]);
        put(C, [83, 74, 65]);
        fn.D3DXPlaneFromPoints(guest, OUT, A, B, C);
        near('D3DXPlaneFromPoints', get(OUT, 4), [0.085914, -0.704492, 0.704492, -0.790406], 64);
        put(D, [-3, -1, 4, 7]);
        put(A, [9, 6, 3]);
        put(B, [2, 5, 8]);
        assert.equal(fn.D3DXPlaneIntersectLine(guest, OUT, D, A, B), OUT);
        near('D3DXPlaneIntersectLine', get(OUT, 3), [20 / 3, 17 / 3, 14 / 3], 1);
        put(A, [11, 13, 15]);
        put(B, [17, 31, 24]);
        assert.equal(fn.D3DXPlaneIntersectLine(guest, OUT, D, A, B), 0, 'a parallel line');
        fn.D3DXPlaneNormalize(guest, OUT, D);
        const root = Math.sqrt(f(26));
        near('D3DXPlaneNormalize', get(OUT, 4), [-3 / root, -1 / root, 4 / root, 7 / root], 2);
        put(E, [0, 0, 0, 0]);
        fn.D3DXPlaneNormalize(guest, OUT, E);
        near('D3DXPlaneNormalize of zero', get(OUT, 4), [0, 0, 0, 0], 0);
        put(E, MAT);
        fn.D3DXPlaneTransform(guest, OUT, D, E);
        near('D3DXPlaneTransform', get(OUT, 4), [49, -98, 55, -165], 0);

        put(A, [0.2, 0.75, 0.41, 0.93]);
        fn.D3DXColorAdjustContrast(guest, OUT, A, f(0.3));
        near('D3DXColorAdjustContrast', get(OUT, 4), [0.41, 0.575, 0.473, 0.93], 0);
        fn.D3DXColorAdjustSaturation(guest, OUT, A, f(0.3));
        near('D3DXColorAdjustSaturation', get(OUT, 4), [0.486028, 0.651028, 0.549028, 0.93], 16);
        near('D3DXFresnelTerm', [fn.D3DXFresnelTerm(0.5, 1.5)], [8.91867128e-02], 1);

        // Each float, the half the library's 32-bit build makes of it, and back.
        /** @type {[number, number, number][]} */
        const halves = [[0x479c4000, 0x7ce2, 0x479c4000], [0x477fdf00, 0x7bff, 0x477fe000],
            [0x477ff000, 0x7c00, 0x47800000], [0x477ff100, 0x7c00, 0x47800000],
            [0xc79c4000, 0xfce2, 0xc79c4000], [0xc77ff000, 0xfc00, 0xc7800000],
            [0x7f800000, 0x7fff, 0x47ffe000], [0xff800000, 0xffff, 0xc7ffe000],
            [0x7fc00000, 0xffff, 0xc7ffe000], [0xffc00000, 0xffff, 0xc7ffe000], [0, 0, 0],
            [0x80000000, 0x8000, 0x80000000], [0x330007ff, 0, 0], [0x33000800, 0, 0],
            [0xb3000800, 0x8000, 0x80000000], [0x33c00000, 1, 0x33800000]];
        for (const [single, half, back] of halves)
        {
            view.setUint32(A, single, true);
            assert.equal(fn.D3DXFloat32To16Array(guest, OUT, A, 1), OUT);
            assert.equal(view.getUint16(OUT, true), half, `0x${single.toString(16)} to a half`);
            assert.equal(fn.D3DXFloat16To32Array(guest, B, OUT, 1), B);
            assert.equal(view.getUint32(B, true), back, `0x${half.toString(16)} to a float`);
        }
    });

    test(`arrays of vectors, projection, under 0x${word.toString(16)}`, ()=>{
        control = word;
        put(F, COUNTING);
        const inputs = Array.from({ length: 5 }, (_, i)=>[i, 5 - i, i, 5 - i]).flat();
        /**
         * @param {string} name @param {number[][]} want @param {number} tolerance
         * @param {number[]} [between]  The arguments before the count.
         */
        const array = (name, want, tolerance, between = [F])=>{
            put(A, inputs);
            put(OUT, new Array(28).fill(0));
            fn[name](guest, OUT + 16, 16, A, 16, ...between, 5);
            near(name, get(OUT, 28), [0, 0, 0, 0, ...want.flatMap(v=>[...v, 0, 0, 0, 0]
                .slice(0, 4)), 0, 0, 0, 0], tolerance);
        };
        array('D3DXVec2TransformCoordArray', [[6.78571403e-01, 7.85714269e-01],
            [6.53846204e-01, 7.69230783e-01], [0.625, 0.75], [5.90909123e-01, 7.27272749e-01],
            [5.49999952e-01, 6.99999928e-01]], 1);
        array('D3DXVec2TransformNormalArray', [[25, 30], [21, 26], [17, 22], [13, 18],
            [9, 14]], 0);
        array('D3DXVec2TransformArray', [[38, 44, 50, 56], [34, 40, 46, 52], [30, 36, 42, 48],
            [26, 32, 38, 44], [22, 28, 34, 40]], 0);
        array('D3DXVec3TransformCoordArray', [[6.78571403e-01, 7.85714269e-01, 8.92857075e-01],
            [6.71874940e-01, 7.81249940e-01, 8.90624940e-01], [6.66666627e-01, 7.77777731e-01,
                8.88888836e-01], [6.62499964e-01, 7.74999976e-01, 8.87499928e-01],
            [6.59090877e-01, 7.72727251e-01, 8.86363566e-01]], 1);
        array('D3DXVec3TransformNormalArray', [[25, 30, 35], [30, 36, 42], [35, 42, 49],
            [40, 48, 56], [45, 54, 63]], 0);
        array('D3DXVec3TransformArray', [[38, 44, 50, 56], [43, 50, 57, 64], [48, 56, 64, 72],
            [53, 62, 71, 80], [58, 68, 78, 88]], 0);
        array('D3DXVec4TransformArray', [[90, 100, 110, 120], [82, 92, 102, 112],
            [74, 84, 94, 104], [66, 76, 86, 96], [58, 68, 78, 88]], 0);
        array('D3DXPlaneTransformArray', [[90, 100, 110, 120], [82, 92, 102, 112],
            [74, 84, 94, 104], [66, 76, 86, 96], [58, 68, 78, 88]], 0);

        const viewport = 0xa00;
        [10, 5, 800, 680].forEach((value, i)=>view.setUint32(viewport + i * 4, value, true));
        put(viewport + 16, [0.2, 0.9]);
        fn.D3DXMatrixPerspectiveFovLH(guest, B, f(Math.PI / 4), f(20 / 17), 1, 1000);
        put(C, MAT);
        put(D, [21, 2, 3, 4, 5, 23, 7, 8, -8, -7, 25, -5, -4, -3, -2, 27]);
        array('D3DXVec3ProjectArray', [[1.08955420e+03, -2.26590622e+02, 2.15272754e-01],
            [1.06890344e+03, 1.03085144e+02, 1.83049560e-01], [1.05177905e+03, 3.76462280e+02,
                1.56329080e-01], [1.03734888e+03, 6.06827393e+02, 1.33812696e-01],
            [1.02502356e+03, 8.03591248e+02, 1.14580572e-01]], 8, [viewport, B, C, D]);
        array('D3DXVec3UnprojectArray', [[-6.12403107e+00, 3.22536016e+00, 6.20571136e-01],
            [-3.80710936e+00, 2.04657936e+00, 4.46894377e-01], [-2.92283988e+00,
                1.59668946e+00, 3.80609393e-01], [-2.45622563e+00, 1.35928988e+00,
                3.45631927e-01], [-2.16789746e+00, 1.21259713e+00, 3.24018806e-01]], 4,
        [viewport, B, C, D]);

        put(E, [9, 6, 2]);
        /** @type {[number, number, number, number, number[], number][]} */
        const projections = [
            [viewport, B, C, D, [1135.721924, 147.086914, 0.153412], 32],
            [viewport, 0, 0, 0, [4010, -1695, 1.6], 2],
            [0, B, C, D, [1.814305, 0.582097, -0.066555], 64],
        ];
        for (const [vp, projection, v, world, want, tolerance] of projections)
        {
            fn.D3DXVec3Project(guest, OUT, E, vp, projection, v, world);
            near(`D3DXVec3Project(${vp}, ${projection}, ${v}, ${world})`, get(OUT, 3), want,
                tolerance);
        }
        /** @type {[number, number, number, number, number[], number][]} */
        const unprojections = [
            [viewport, B, C, D, [-2.913411, 1.593215, 0.380724], 16],
            [viewport, 0, 0, 0, [-1.002500, 0.997059, 2.571429], 4],
            [0, B, C, D, [-11.018396, 3.218991, 1.380329], 8],
        ];
        for (const [vp, projection, v, world, want, tolerance] of unprojections)
        {
            fn.D3DXVec3Unproject(guest, OUT, E, vp, projection, v, world);
            near(`D3DXVec3Unproject(${vp}, ${projection}, ${v}, ${world})`, get(OUT, 3), want,
                tolerance);
        }
    });

    test(`quaternions, under 0x${word.toString(16)}`, ()=>{
        control = word;
        put(A, [1, 2, 4, 10]);
        put(B, [-3, 4, -5, 7]);
        put(C, [-1111, 111, -11, 1]);
        put(D, [91, -82, 7.3, -6.4]);
        fn.D3DXQuaternionBaryCentric(guest, OUT, A, B, C, f(0.3), f(0.78));
        near('D3DXQuaternionBaryCentric', get(OUT, 4), [-867.444458, 87.851111, -9.937778,
            3.235555], 1);
        fn.D3DXQuaternionExp(guest, OUT, A);
        near('D3DXQuaternionExp', get(OUT, 4), [-0.216382, -0.432764, -0.8655270, -0.129449], 16);
        put(E, [0, 0, 0, 0]);
        fn.D3DXQuaternionExp(guest, OUT, E);
        near('D3DXQuaternionExp of zero', get(OUT, 4), [0, 0, 0, 1], 0);
        put(E, [0.2, 0.1, 0.3, 0.9]);
        fn.D3DXQuaternionExp(guest, OUT, E);
        near('D3DXQuaternionExp below 1', get(OUT, 4), [0.195366, 0.097683, 0.293049, 0.930813],
            8);
        fn.D3DXQuaternionInverse(guest, OUT, A);
        near('D3DXQuaternionInverse', get(OUT, 4), [-1 / 121, -2 / 121, -4 / 121, 10 / 121], 0);
        fn.D3DXQuaternionInverse(guest, OUT, OUT);
        near('D3DXQuaternionInverse over itself', get(OUT, 4), [1, 2, 4, 10], 1);
        /** @type {[number[], number[], number][]} */
        const logarithms = [
            [[1, 2, 4, 10], [1, 2, 4, 0], 0],
            [[1 / 11, 2 / 11, 4 / 11, 10 / 11], [0.093768, 0.187536, 0.375073, 0], 32],
            [[0, 0, 0, 1], [0, 0, 0, 0], 0],
            [[5.4, 1.2, -0.3, -0.3], [10.616652, 2.359256, -0.589814, 0], 1],
            [[0.2, 0.1, 0.3, 0.9], [0.206945, 0.103473, 0.310418, 0], 64],
            [[0.2, 0.1, 0.3, -1], [0.2, 0.1, 0.3, 0], 0],
        ];
        for (const [q, want, tolerance] of logarithms)
        {
            put(E, q);
            fn.D3DXQuaternionLn(guest, OUT, E);
            near(`D3DXQuaternionLn of ${q}`, get(OUT, 4), want, tolerance);
        }
        fn.D3DXQuaternionMultiply(guest, OUT, A, B);
        near('D3DXQuaternionMultiply', get(OUT, 4), [3, 61, -32, 85], 0);
        fn.D3DXQuaternionNormalize(guest, OUT, A);
        near('D3DXQuaternionNormalize', get(OUT, 4), [1 / 11, 2 / 11, 4 / 11, 10 / 11], 1);
        put(E, [2, 7, 13]);
        fn.D3DXQuaternionRotationAxis(guest, OUT, E, ANGLE);
        near('D3DXQuaternionRotationAxis', get(OUT, 4), [0.067116, 0.234905, 0.436251,
            0.866025], 64);
        put(E, [0, 0, 0]);
        fn.D3DXQuaternionRotationAxis(guest, OUT, E, ANGLE);
        near('D3DXQuaternionRotationAxis of a zero axis', get(OUT, 4), [0, 0, 0, 0.866025], 8);
        /** @type {[number[], number[], number][]} the diagonal, the quaternion */
        const fromMatrices = [
            [[10, 20, 30], [2.368682, 0.768221, -0.384111, 3.905125], 16],
            [[-10, -60, 40], [1.233905, -0.237290, 5.267827, -0.284747], 64],
            [[-10, 60, -80], [0.651031, 6.144103, -0.203447, 0.488273], 8],
            [[-10, 10, -0.9], [1.709495, 2.339872, -0.534217, 1.282122], 8],
            [[-10, 10, 0], [1.745743, 2.291288, -0.545545, 1.309307], 8],
            [[-10, 10, 0.01], [18.408188, 5.970223, -2.985111, 0.502494], 4],
            [[-10, 10, 2], [10.680980, 3.464102, -1.732051, 0.866025], 8],
        ];
        for (const [[d0, d1, d2], want, tolerance] of fromMatrices)
        {
            put(F, [d0, 5, 7, 8, 11, d1, 16, 33, 19, -21, d2, 43, 2, 3, -4, 48]);
            fn.D3DXQuaternionRotationMatrix(guest, OUT, F);
            near(`D3DXQuaternionRotationMatrix of ${d0}, ${d1}, ${d2}`, get(OUT, 4), want,
                tolerance);
        }
        fn.D3DXQuaternionRotationYawPitchRoll(guest, OUT, f(Math.PI / 4), f(Math.PI / 11),
            f(Math.PI / 3));
        near('D3DXQuaternionRotationYawPitchRoll', get(OUT, 4), [0.303261, 0.262299, 0.410073,
            0.819190], 16);
        fn.D3DXQuaternionSlerp(guest, OUT, A, B, f(0.3));
        near('D3DXQuaternionSlerp of a product past 1: a straight line', get(OUT, 4),
            [-0.2, 2.6, 1.3, 9.1], 4);
        fn.D3DXQuaternionSlerp(guest, OUT, A, C, f(0.3));
        near('D3DXQuaternionSlerp toward the nearer', get(OUT, 4), [334, -31.9, 6.1, 6.7], 2);
        put(E, [0.1, 0.2, 0.3, 0.4]);
        put(F, [0.5, 0.6, 0.7, 0.8]);
        fn.D3DXQuaternionSlerp(guest, OUT, E, F, f(0.3));
        near('D3DXQuaternionSlerp', get(OUT, 4), [0.239485, 0.346580, 0.453676, 0.560772], 32);
        fn.D3DXQuaternionSquad(guest, OUT, A, B, C, D, f(0.3));
        near('D3DXQuaternionSquad', get(OUT, 4), [-156.296, 30.242, -2.5022, 7.3576], 2);

        fn.D3DXQuaternionSquadSetup(guest, E, F, G, A, B, C, D);
        near('D3DXQuaternionSquadSetup\'s a', get(E, 4), [7.121285, 2.159964, -3.855094,
            5.362844], 16);
        near('D3DXQuaternionSquadSetup\'s b', get(F, 4), [-1113.492920, 82.679260, -6.696645,
            -4.090050], 4);
        near('D3DXQuaternionSquadSetup\'s c', get(G, 4), [-1111, 111, -11, 1], 0);
        put(E, [-3, 4, -5, 7]);
        fn.D3DXQuaternionSquadSetup(guest, E, F, G, A, E, C, D);
        near('D3DXQuaternionSquadSetup over q1', get(F, 4), [-1113.492920, 82.679260, -6.696645,
            -4.090050], 4);
        put(A, [0.2, 0.3, 1.3, -0.6]);
        put(B, [-3, -2, 4, 0.2]);
        put(C, [0.4, 8.3, -3.1, -2.7]);
        put(D, [1.1, -0.7, 9.2, 0]);
        fn.D3DXQuaternionSquadSetup(guest, E, F, G, A, B, C, D);
        near('D3DXQuaternionSquadSetup\'s a, q2 turned', get(E, 4), [-3.754567, -0.586085,
            3.815818, -0.198150], 32);
        near('D3DXQuaternionSquadSetup\'s b, q2 turned', get(F, 4), [0.140773, -8.737090,
            -0.516593, 3.053942], 16);
        near('D3DXQuaternionSquadSetup\'s c, q2 turned', get(G, 4), [-0.4, -8.3, 3.1, 2.7], 0);

        put(A, [1 / 22, 2 / 22, 4 / 22, 10 / 22]);
        fn.D3DXQuaternionToAxisAngle(guest, A, B, C);
        near('D3DXQuaternionToAxisAngle', [...get(B, 3), ...get(C, 1)], [1 / 22, 2 / 22, 4 / 22,
            2.197869], 1);
        put(A, [0, 0, 0, 0]);
        put(C, [0]);
        fn.D3DXQuaternionToAxisAngle(guest, A, 0, C);
        near('D3DXQuaternionToAxisAngle of zero, no axis', get(C, 1), [3.14159274], 0);
        fn.D3DXQuaternionToAxisAngle(guest, A, B, 0);
        near('D3DXQuaternionToAxisAngle of zero, no angle', get(B, 3), [0, 0, 0], 0);
    });
}
