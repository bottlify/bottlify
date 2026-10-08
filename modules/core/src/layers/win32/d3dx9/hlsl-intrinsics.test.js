/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    INTRINSIC_NAMES, evaluateIntrinsic, isIntrinsic, isPureIntrinsic, resolveIntrinsic,
} from './hlsl-intrinsics.js';
import {
    BOOL, FLOAT, INT, VOID, convertValue, matrixOf, samplerOf, typeToString, vectorOf,
} from './hlsl-types.js';

const f32 = Math.fround;
const v = (/** @type {number} */ n)=>vectorOf('float', n);
const iv = (/** @type {number} */ n)=>vectorOf('int', n);
const m = (/** @type {number} */ r, /** @type {number} */ c)=>matrixOf('float', r, c);

/**
 * Numbers equal within a tolerance, arrays elementwise, NaN equal to NaN.
 *
 * @param {any} actual @param {any} expected @param {number} [eps]
 * @param {string} [what]
 */
function close(actual, expected, eps = 1e-6, what = ''){
    if (Array.isArray(expected))
    {
        assert.ok(Array.isArray(actual), `${what}: array expected, got ${actual}`);
        assert.equal(actual.length, expected.length, `${what}: length`);
        expected.forEach((x, i)=>close(actual[i], x, eps, `${what}[${i}]`));
        return;
    }
    if (Number.isNaN(expected))
    {
        assert.ok(Number.isNaN(actual), `${what}: NaN expected, got ${actual}`);
        return;
    }
    assert.ok(actual === expected || Math.abs(actual - expected) <= eps * Math.max(1,
        Math.abs(expected)), `${what}: expected ${expected}, got ${actual}`);
}

/** @param {string} name @param {import('./hlsl-types.js').Type[]} types */
function sigText(name, ...types){
    const s = resolveIntrinsic(name, types);
    return s ? `${s.paramTypes.map(typeToString).join(',')}->${typeToString(s.resultType)}`
        : null;
}

/**
 * Types the call, converts the arguments to the parameter types as the checker does, runs it.
 *
 * @param {string} name
 * @param {[import('./hlsl-types.js').Type, any][]} args
 * @param {any} [hooks]
 */
function run(name, args, hooks){
    const sig = resolveIntrinsic(name, args.map(a=>a[0]));
    assert.ok(sig, `${name} does not accept ${args.map(a=>typeToString(a[0]))}`);
    const values = args.map(([t, value], i)=>sig.outParams?.includes(i) ? 0
        : convertValue(value, t, sig.paramTypes[i]));
    const outs = new Map();
    const result = evaluateIntrinsic(name, values, sig.paramTypes, sig.resultType, hooks, outs);
    return { result, outs };
}

/**
 * The result of a call whose arguments are written as values of one family: the first element
 * names the type, and a bare number, an array, or an array of rows takes the shape it has.
 *
 * @param {string} name @param {any[]} args
 */
function val(name, [family, ...values]){
    const base = family.base ?? 'float';
    const typed = values.map(x=>{
        if (typeof x === 'number')
        {
            return [base === 'int' ? INT : FLOAT, x];
        }
        if (Array.isArray(x[0]))
        {
            return [matrixOf(base, x.length, x[0].length), x];
        }
        return [vectorOf(base, x.length), x];
    });
    return run(name, /** @type {any} */ (typed)).result;
}

test('every intrinsic of the language resolves', ()=>{
    const f2 = v(2);
    const f3 = v(3);
    const f4 = v(4);
    const s2 = samplerOf('2d');
    /** @type {Record<string, import('./hlsl-types.js').Type[]>} */
    const samples = {
        abs: [f3], acos: [f3], all: [f3], any: [f3], asin: [f3], atan: [f3], atan2: [f3, f3],
        ceil: [f3], clamp: [f3, f3, f3], clip: [f3], cos: [f3], cosh: [f3], cross: [f3, f3],
        D3DCOLORtoUBYTE4: [f4], ddx: [f3], ddy: [f3], degrees: [f3], determinant: [m(3, 3)],
        distance: [f3, f3], dot: [f3, f3], dst: [f4, f4], exp: [f3], exp2: [f3],
        faceforward: [f3, f3, f3],
        floor: [f3], fmod: [f3, f3], frac: [f3], frexp: [f3, f3], fwidth: [f3], isfinite: [f3],
        isinf: [f3], isnan: [f3], ldexp: [f3, f3], length: [f3], lerp: [f3, f3, f3], lit: [FLOAT,
            FLOAT, FLOAT], log: [f3], log10: [f3], log2: [f3], max: [f3, f3], min: [f3, f3],
        modf: [f3, f3], mul: [m(4, 4), f4], noise: [f3], normalize: [f3], pow: [f3, f3],
        radians: [f3], reflect: [f3, f3], refract: [f3, f3, FLOAT], round: [f3], rsqrt: [f3],
        saturate: [f3], sign: [f3], sin: [f3], sincos: [f3, f3, f3], sinh: [f3],
        smoothstep: [f3, f3, f3], sqrt: [f3], step: [f3, f3], tan: [f3], tanh: [f3],
        transpose: [m(2, 3)], trunc: [f3],
    };
    for (const [suffix, dim, n] of [['1D', '1d', 1], ['2D', '2d', 2], ['3D', '3d', 3],
        ['CUBE', 'cube', 3]])
    {
        const s = samplerOf(/** @type {any} */ (dim));
        samples[`tex${suffix}`] = [s, v(/** @type {number} */ (n))];
        for (const variant of ['bias', 'lod', 'proj'])
        {
            samples[`tex${suffix}${variant}`] = [s, f4];
        }
        samples[`tex${suffix}grad`] = [s, v(/** @type {number} */ (n)),
            v(/** @type {number} */ (n)), v(/** @type {number} */ (n))];
    }
    assert.equal(s2.kind, 'sampler');
    for (const [name, args] of Object.entries(samples))
    {
        assert.ok(isIntrinsic(name), `${name} is an intrinsic`);
        assert.ok(resolveIntrinsic(name, args), `${name} resolves`);
    }
    assert.deepEqual(new Set(INTRINSIC_NAMES), new Set(Object.keys(samples)));
    assert.equal(f2.kind, 'vector');
});

test('unknown names and wrong arity do not resolve', ()=>{
    assert.equal(resolveIntrinsic('frobnicate', [FLOAT]), null);
    assert.equal(isIntrinsic('frobnicate'), false);
    assert.equal(resolveIntrinsic('abs', []), null);
    assert.equal(resolveIntrinsic('abs', [FLOAT, FLOAT]), null);
    assert.equal(resolveIntrinsic('pow', [FLOAT]), null);
    assert.equal(resolveIntrinsic('lerp', [FLOAT, FLOAT]), null);
    assert.equal(resolveIntrinsic('mul', [FLOAT]), null);
    assert.equal(resolveIntrinsic('tex2D', [samplerOf('2d')]), null);
});

test('componentwise functions: scalars, vectors, matrices; ints become float', ()=>{
    assert.equal(sigText('sin', FLOAT), 'float->float');
    assert.equal(sigText('sin', v(3)), 'float3->float3');
    assert.equal(sigText('sin', m(2, 3)), 'float2x3->float2x3');
    assert.equal(sigText('sin', INT), 'float->float');
    assert.equal(sigText('sin', iv(2)), 'float2->float2');
    assert.equal(sigText('sin', BOOL), 'float->float');
    assert.equal(sigText('sin', v(1)), 'float1->float1');
    assert.equal(sigText('sin', samplerOf('2d')), null);
    assert.equal(sigText('saturate', INT), 'float->float');
});

test('abs, sign, min, max, clamp keep ints when every argument is an int', ()=>{
    assert.equal(sigText('abs', INT), 'int->int');
    assert.equal(sigText('abs', iv(3)), 'int3->int3');
    assert.equal(sigText('sign', INT), 'int->int');
    assert.equal(sigText('min', INT, INT), 'int,int->int');
    assert.equal(sigText('max', iv(2), iv(2)), 'int2,int2->int2');
    assert.equal(sigText('clamp', INT, INT, INT), 'int,int,int->int');
    assert.equal(sigText('min', INT, FLOAT), 'float,float->float');
    assert.equal(sigText('max', iv(2), FLOAT), 'float2,float2->float2');
    assert.equal(sigText('clamp', INT, INT, FLOAT), 'float,float,float->float');
});

test('a scalar beside a vector is promoted; longer vectors are cut to the shorter', ()=>{
    assert.equal(sigText('pow', v(3), FLOAT), 'float3,float3->float3');
    assert.equal(sigText('pow', FLOAT, v(3)), 'float3,float3->float3');
    assert.equal(sigText('lerp', v(3), v(3), FLOAT), 'float3,float3,float3->float3');
    assert.equal(sigText('max', v(4), v(2)), 'float2,float2->float2');
    assert.equal(sigText('max', v(2), v(4)), 'float2,float2->float2');
    assert.equal(sigText('atan2', FLOAT, FLOAT), 'float,float->float');
    assert.equal(sigText('step', v(1), v(3)), 'float3,float3->float3');
    assert.equal(sigText('step', v(1), FLOAT), 'float1,float1->float1');
    assert.equal(sigText('max', m(3, 3), FLOAT), 'float3x3,float3x3->float3x3');
    assert.equal(sigText('max', m(3, 3), m(2, 4)), 'float2x3,float2x3->float2x3');
    assert.equal(sigText('max', m(3, 3), v(3)), null);
});

test('isnan, isinf, isfinite give bools of the same shape', ()=>{
    for (const name of ['isnan', 'isinf', 'isfinite'])
    {
        assert.equal(sigText(name, FLOAT), 'float->bool');
        assert.equal(sigText(name, v(3)), 'float3->bool3');
        assert.equal(sigText(name, m(2, 2)), 'float2x2->bool2x2');
    }
});

test('all and any: any numeric, bool result', ()=>{
    assert.equal(sigText('all', v(3)), 'float3->bool');
    assert.equal(sigText('any', iv(2)), 'int2->bool');
    assert.equal(sigText('any', BOOL), 'bool->bool');
    assert.equal(sigText('all', m(2, 2)), 'float2x2->bool');
    assert.equal(sigText('all', samplerOf('2d')), null);
});

test('dot, length, distance, normalize, reflect, refract', ()=>{
    assert.equal(sigText('dot', v(3), v(3)), 'float3,float3->float');
    assert.equal(sigText('dot', v(3), v(4)), 'float3,float3->float');
    assert.equal(sigText('dot', FLOAT, FLOAT), 'float,float->float');
    assert.equal(sigText('dot', v(1), v(1)), 'float1,float1->float');
    assert.equal(sigText('dot', iv(3), iv(3)), 'float3,float3->float');
    assert.equal(sigText('dot', m(2, 2), m(2, 2)), null);
    assert.equal(sigText('length', v(3)), 'float3->float');
    assert.equal(sigText('distance', v(2), v(2)), 'float2,float2->float');
    assert.equal(sigText('normalize', v(3)), 'float3->float3');
    assert.equal(sigText('normalize', FLOAT), 'float->float');
    assert.equal(sigText('reflect', v(3), v(3)), 'float3,float3->float3');
    assert.equal(sigText('refract', v(3), v(3), FLOAT), 'float3,float3,float->float3');
    assert.equal(sigText('refract', v(3), v(3), v(3)), 'float3,float3,float->float3');
    assert.equal(sigText('faceforward', v(3), v(3), v(3)), 'float3,float3,float3->float3');
    assert.equal(sigText('length', m(2, 2)), null);
});

test('cross takes 3-vectors and cuts longer ones', ()=>{
    assert.equal(sigText('cross', v(3), v(3)), 'float3,float3->float3');
    assert.equal(sigText('cross', v(4), v(3)), 'float3,float3->float3');
    assert.equal(sigText('cross', v(2), v(3)), null);
    assert.equal(sigText('cross', FLOAT, FLOAT), null);
});

test('lit, D3DCOLORtoUBYTE4, determinant, transpose', ()=>{
    assert.equal(sigText('lit', FLOAT, FLOAT, FLOAT), 'float,float,float->float4');
    assert.equal(sigText('lit', INT, FLOAT, FLOAT), 'float,float,float->float4');
    assert.equal(sigText('lit', v(3), FLOAT, FLOAT), null);
    assert.equal(sigText('D3DCOLORtoUBYTE4', v(4)), 'float4->int4');
    assert.equal(sigText('D3DCOLORtoUBYTE4', v(3)), null);
    assert.equal(sigText('determinant', m(3, 3)), 'float3x3->float');
    assert.equal(sigText('determinant', m(2, 3)), null);
    assert.equal(sigText('determinant', v(3)), null);
    assert.equal(sigText('transpose', m(2, 3)), 'float2x3->float3x2');
    assert.equal(sigText('transpose', matrixOf('int', 1, 4)), 'float1x4->float4x1');
    assert.equal(sigText('transpose', v(3)), null);
});

test('mul covers every combination of scalar, vector and matrix', ()=>{
    assert.equal(sigText('mul', FLOAT, FLOAT), 'float,float->float');
    assert.equal(sigText('mul', FLOAT, v(3)), 'float,float3->float3');
    assert.equal(sigText('mul', v(3), FLOAT), 'float3,float->float3');
    assert.equal(sigText('mul', FLOAT, m(2, 2)), 'float,float2x2->float2x2');
    assert.equal(sigText('mul', m(2, 3), FLOAT), 'float2x3,float->float2x3');
    assert.equal(sigText('mul', v(3), v(3)), 'float3,float3->float');
    assert.equal(sigText('mul', v(4), v(3)), 'float3,float3->float');
    assert.equal(sigText('mul', v(3), m(3, 4)), 'float3,float3x4->float4');
    assert.equal(sigText('mul', v(4), m(3, 2)), 'float3,float3x2->float2');
    assert.equal(sigText('mul', v(2), m(3, 3)), 'float2,float2x3->float3');
    assert.equal(sigText('mul', m(3, 4), v(4)), 'float3x4,float4->float3');
    assert.equal(sigText('mul', m(3, 3), v(4)), 'float3x3,float3->float3');
    assert.equal(sigText('mul', m(3, 4), v(3)), 'float3x3,float3->float3');
    assert.equal(sigText('mul', m(2, 3), m(3, 4)), 'float2x3,float3x4->float2x4');
    assert.equal(sigText('mul', m(2, 3), m(2, 3)), 'float2x2,float2x3->float2x3');
    assert.equal(sigText('mul', iv(3), m(3, 3)), 'float3,float3x3->float3');
    assert.equal(sigText('mul', INT, INT), 'float,float->float');
    assert.equal(sigText('mul', samplerOf('2d'), FLOAT), null);
});

test('out parameters: modf, frexp, sincos', ()=>{
    const modf = /** @type {any} */ (resolveIntrinsic('modf', [v(3), v(3)]));
    assert.deepEqual(modf.outParams, [1]);
    assert.equal(typeToString(modf.resultType), 'float3');
    assert.equal(sigText('frexp', FLOAT, FLOAT), 'float,float->float');
    const sincos = /** @type {any} */ (resolveIntrinsic('sincos', [v(2), v(2), v(2)]));
    assert.deepEqual(sincos.outParams, [1, 2]);
    assert.equal(sincos.resultType, VOID);
    assert.equal(resolveIntrinsic('sincos', [FLOAT, FLOAT]), null);
    assert.equal(resolveIntrinsic('modf', [FLOAT]), null);
});

test('clip and noise', ()=>{
    assert.equal(sigText('clip', v(4)), 'float4->void');
    assert.equal(sigText('clip', INT), 'float->void');
    assert.equal(/** @type {any} */ (resolveIntrinsic('noise', [v(3)])).unsupported, true);
    assert.throws(()=>evaluateIntrinsic('noise', [[1, 2, 3]], [v(3)], FLOAT), /not supported/);
    assert.equal(isPureIntrinsic('noise'), false);
});

test('texture sampling: coordinates per variant, sampler dimension must agree', ()=>{
    const s1 = samplerOf('1d');
    const s2 = samplerOf('2d');
    const s3 = samplerOf('3d');
    const sc = samplerOf('cube');
    const sa = samplerOf('any');
    assert.equal(sigText('tex1D', s1, FLOAT), 'sampler1D,float1->float4');
    assert.equal(sigText('tex2D', s2, v(2)), 'sampler2D,float2->float4');
    assert.equal(sigText('tex2D', sa, v(2)), 'sampler,float2->float4');
    assert.equal(sigText('tex3D', s3, v(3)), 'sampler3D,float3->float4');
    assert.equal(sigText('texCUBE', sc, v(3)), 'samplerCUBE,float3->float4');
    assert.equal(sigText('tex2Dproj', s2, v(4)), 'sampler2D,float4->float4');
    assert.equal(sigText('tex2Dbias', s2, v(4)), 'sampler2D,float4->float4');
    assert.equal(sigText('tex2Dlod', s2, v(4)), 'sampler2D,float4->float4');
    assert.equal(sigText('tex2Dgrad', s2, v(2), v(2), v(2)),
        'sampler2D,float2,float2,float2->float4');
    assert.equal(sigText('tex3Dgrad', s3, v(3), v(3), v(3)),
        'sampler3D,float3,float3,float3->float4');
    assert.equal(sigText('texCUBEgrad', sc, v(3), v(3), v(3)),
        'samplerCUBE,float3,float3,float3->float4');
    assert.equal(sigText('tex1Dlod', s1, v(4)), 'sampler1D,float4->float4');
    assert.equal(sigText('tex2D', s2, v(3)), 'sampler2D,float2->float4');
    assert.equal(sigText('tex2D', s3, v(2)), null);
    assert.equal(sigText('texCUBE', s2, v(3)), null);
    assert.equal(sigText('tex2D', v(2), v(2)), null);
    assert.equal(sigText('tex2Dproj', s2, v(2)), null);
    assert.equal(sigText('tex2Dlod', s2, v(3)), null);
    assert.equal(sigText('tex2D', samplerOf('2d'), samplerOf('2d')), null);
    assert.equal(sigText('tex2Dgrad', s2, v(2), v(2)), null);
});

test('only the arithmetic functions are pure', ()=>{
    for (const name of ['sin', 'mul', 'lerp', 'determinant', 'sincos', 'modf'])
    {
        assert.ok(isPureIntrinsic(name), name);
    }
    for (const name of ['tex2D', 'texCUBEproj', 'ddx', 'ddy', 'fwidth', 'clip', 'noise'])
    {
        assert.ok(!isPureIntrinsic(name), name);
    }
});

test('abs, sign, floor, ceil, trunc, round, frac', ()=>{
    assert.equal(val('abs', [FLOAT, -2.5]), 2.5);
    assert.equal(val('abs', [INT, -3]), 3);
    assert.deepEqual(val('abs', [v(3), [-1, 2, -0.5]]), [1, 2, 0.5]);
    assert.equal(val('abs', [INT, -2147483648]), -2147483648);
    assert.equal(val('sign', [FLOAT, -0.5]), -1);
    assert.equal(val('sign', [FLOAT, 7]), 1);
    assert.equal(val('sign', [FLOAT, 0]), 0);
    assert.equal(val('sign', [FLOAT, NaN]), 0);
    assert.equal(val('sign', [INT, -9]), -1);
    assert.deepEqual(val('sign', [iv(3), [-3, 0, 4]]), [-1, 0, 1]);
    assert.equal(val('floor', [FLOAT, -1.5]), -2);
    assert.equal(val('ceil', [FLOAT, -1.5]), -1);
    assert.equal(val('trunc', [FLOAT, -1.5]), -1);
    assert.equal(val('trunc', [FLOAT, 1.9]), 1);
    assert.equal(val('floor', [FLOAT, 1.5]), 1);
    assert.equal(val('ceil', [FLOAT, 1.2]), 2);
    assert.deepEqual(val('round', [v(6), [0.4, 0.5, 1.5, 2.5, -0.6, -2.5]]),
        [0, 1, 2, 3, -1, -2]);
    assert.equal(val('round', [FLOAT, 3.5]), 4);
    assert.equal(val('frac', [FLOAT, 1.75]), 0.75);
    assert.equal(val('frac', [FLOAT, -0.25]), 0.75);
    assert.equal(val('frac', [FLOAT, 3]), 0);
    assert.ok(Number.isNaN(/** @type {number} */ (val('frac', [FLOAT, Infinity]))));
});

test('saturate, clamp, min, max, step, with NaN', ()=>{
    assert.deepEqual(val('saturate', [v(4), [-1, 0.25, 1, 7]]), [0, 0.25, 1, 1]);
    assert.equal(val('saturate', [FLOAT, NaN]), 0);
    assert.equal(val('clamp', [FLOAT, 5, 0, 3]), 3);
    assert.equal(val('clamp', [FLOAT, -5, 0, 3]), 0);
    assert.equal(val('clamp', [INT, 7, -2, 4]), 4);
    assert.deepEqual(val('clamp', [iv(2), [-9, 9], 0, 5]), [0, 5]);
    assert.equal(val('min', [FLOAT, 1, 2]), 1);
    assert.equal(val('max', [FLOAT, 1, 2]), 2);
    assert.equal(val('max', [INT, -3, -4]), -3);
    assert.equal(val('min', [INT, -3, -4]), -4);
    assert.equal(val('max', [FLOAT, NaN, 1]), 1);
    assert.equal(val('min', [FLOAT, 1, NaN]), 1);
    assert.deepEqual(val('max', [v(3), [1, 5, 3], 2]), [2, 5, 3]);
    assert.deepEqual(val('min', [v(2), [1, 5], [2, 2, 2]]), [1, 2]);
    assert.equal(val('step', [FLOAT, 0.5, 0.5]), 1);
    assert.equal(val('step', [FLOAT, 0.5, 0.4]), 0);
    assert.deepEqual(val('step', [v(3), 1, [0, 1, 2]]), [0, 1, 1]);
});

test('lerp is a + t * (b - a); smoothstep; fmod', ()=>{
    assert.equal(val('lerp', [FLOAT, 0, 10, 0.25]), 2.5);
    assert.equal(val('lerp', [FLOAT, 1, 3, 0]), 1);
    assert.equal(val('lerp', [FLOAT, 1, 3, 1]), 3);
    assert.equal(val('lerp', [FLOAT, 1, 3, 2]), 5);
    assert.deepEqual(val('lerp', [v(2), [0, 10], [10, 20], 0.5]), [5, 15]);
    assert.equal(val('smoothstep', [FLOAT, 0, 1, 0.5]), 0.5);
    assert.equal(val('smoothstep', [FLOAT, 0, 1, 0.25]), 0.15625);
    assert.equal(val('smoothstep', [FLOAT, 0, 2, 3]), 1);
    assert.equal(val('smoothstep', [FLOAT, 0, 2, -1]), 0);
    assert.equal(val('smoothstep', [FLOAT, 2, 0, 1]), 0.5);
    assert.equal(val('fmod', [FLOAT, 5.5, 2]), 1.5);
    assert.equal(val('fmod', [FLOAT, -5.5, 2]), -1.5);
    assert.equal(val('fmod', [FLOAT, 5.5, -2]), 1.5);
    assert.ok(Number.isNaN(/** @type {number} */ (val('fmod', [FLOAT, 5, 0]))));
    assert.deepEqual(val('fmod', [v(2), [7, 9], 4]), [3, 1]);
});

test('exponentials, logarithms and roots', ()=>{
    assert.equal(val('pow', [FLOAT, 2, 10]), 1024);
    assert.equal(val('pow', [FLOAT, 2, 0.5]), f32(Math.SQRT2));
    assert.equal(val('pow', [FLOAT, 9, 0]), 1);
    assert.ok(Number.isNaN(/** @type {number} */ (val('pow', [FLOAT, -2, 0.5]))));
    assert.equal(val('exp2', [FLOAT, 3]), 8);
    assert.equal(val('exp', [FLOAT, 0]), 1);
    close(val('exp', [FLOAT, 1]), Math.E, 1e-7);
    assert.equal(val('log2', [FLOAT, 8]), 3);
    assert.equal(val('log10', [FLOAT, 1000]), 3);
    assert.equal(val('log', [FLOAT, 1]), 0);
    assert.equal(val('log2', [FLOAT, 0]), -Infinity);
    assert.ok(Number.isNaN(/** @type {number} */ (val('log', [FLOAT, -1]))));
    assert.equal(val('sqrt', [FLOAT, 16]), 4);
    assert.ok(Number.isNaN(/** @type {number} */ (val('sqrt', [FLOAT, -1]))));
    assert.equal(val('rsqrt', [FLOAT, 4]), 0.5);
    assert.equal(val('rsqrt', [FLOAT, 0]), Infinity);
    assert.equal(val('ldexp', [FLOAT, 0.75, 3]), 6);
    assert.equal(val('ldexp', [FLOAT, 1, -2]), 0.25);
});

test('trigonometry', ()=>{
    assert.equal(val('sin', [FLOAT, 0]), 0);
    assert.equal(val('cos', [FLOAT, 0]), 1);
    assert.equal(val('tan', [FLOAT, 0]), 0);
    close(val('sin', [FLOAT, f32(Math.PI / 2)]), 1, 1e-7);
    close(val('asin', [FLOAT, 1]), Math.PI / 2, 1e-7);
    close(val('acos', [FLOAT, 1]), 0);
    close(val('atan', [FLOAT, 1]), Math.PI / 4, 1e-7);
    close(val('atan2', [FLOAT, 1, 1]), Math.PI / 4, 1e-7);
    close(val('atan2', [FLOAT, 1, -1]), 3 * Math.PI / 4, 1e-7);
    close(val('atan2', [FLOAT, -1, 0]), -Math.PI / 2, 1e-7);
    assert.equal(val('sinh', [FLOAT, 0]), 0);
    assert.equal(val('cosh', [FLOAT, 0]), 1);
    assert.equal(val('tanh', [FLOAT, 0]), 0);
    close(val('tanh', [FLOAT, 100]), 1);
    close(val('degrees', [FLOAT, f32(Math.PI)]), 180, 1e-6);
    close(val('radians', [FLOAT, 180]), Math.PI, 1e-7);
    assert.ok(Number.isNaN(/** @type {number} */ (val('asin', [FLOAT, 2]))));
});

test('every float result is rounded to float32', ()=>{
    const r = /** @type {number} */ (val('sin', [FLOAT, 1]));
    assert.equal(r, f32(r));
    assert.notEqual(r, Math.sin(1));
    const a = /** @type {number} */ (val('lerp', [FLOAT, 0.1, 0.7, 0.3]));
    assert.equal(a, f32(a));
    const arr = /** @type {number[]} */ (val('exp', [v(3), [0.1, 0.2, 0.3]]));
    assert.ok(arr.every(x=>x === f32(x)));
});

test('isnan, isinf, isfinite, all, any', ()=>{
    assert.deepEqual(val('isnan', [v(3), [NaN, 1, Infinity]]), [1, 0, 0]);
    assert.deepEqual(val('isinf', [v(3), [NaN, 1, -Infinity]]), [0, 0, 1]);
    assert.deepEqual(val('isfinite', [v(3), [NaN, 1, Infinity]]), [0, 1, 0]);
    assert.equal(val('all', [v(3), [1, 2, 3]]), 1);
    assert.equal(val('all', [v(3), [1, 0, 3]]), 0);
    assert.equal(val('any', [v(3), [0, 0, 0.5]]), 1);
    assert.equal(val('any', [v(3), [0, 0, 0]]), 0);
    assert.equal(val('any', [iv(2), [0, 0]]), 0);
    assert.equal(val('all', [FLOAT, 2]), 1);
    assert.equal(val('all', [m(2, 2), [[1, 1], [1, 0]]]), 0);
});

test('vector geometry', ()=>{
    assert.equal(val('dot', [v(3), [1, 2, 3], [4, 5, 6]]), 32);
    assert.equal(val('dot', [FLOAT, 3, 4]), 12);
    assert.equal(val('dot', [v(3), [1, 2, 3], [1, 1, 1, 9]]), 6);
    assert.equal(val('length', [v(2), [3, 4]]), 5);
    assert.equal(val('length', [FLOAT, -3]), 3);
    assert.equal(val('distance', [v(2), [1, 1], [4, 5]]), 5);
    close(val('normalize', [v(3), [0, 3, 4]]), [0, 0.6, 0.8], 1e-7);
    close(val('normalize', [v(2), [5, 0]]), [1, 0]);
    assert.ok(Number.isNaN(/** @type {number[]} */ (val('normalize', [v(2), [0, 0]]))[0]));
    assert.deepEqual(val('cross', [v(3), [1, 0, 0], [0, 1, 0]]), [0, 0, 1]);
    assert.deepEqual(val('cross', [v(3), [0, 1, 0], [1, 0, 0]]), [0, 0, -1]);
    assert.deepEqual(val('cross', [v(3), [1, 2, 3], [4, 5, 6]]), [-3, 6, -3]);
    assert.deepEqual(val('reflect', [v(3), [1, -1, 0], [0, 1, 0]]), [1, 1, 0]);
    assert.deepEqual(val('refract', [v(3), [0, -1, 0], [0, 1, 0], 1]), [0, -1, 0]);
    close(val('refract', [v(3), [0, -1, 0], [0, 1, 0], 1.5]), [0, -1, 0], 1e-7);
    assert.deepEqual(val('refract', [v(3), [0.8, -0.6, 0], [0, 1, 0], 2]), [0, 0, 0]);
    close(val('refract', [v(3), [0.6, -0.8, 0], [0, 1, 0], 0.5]),
        [0.3, -Math.sqrt(1 - 0.25 * 0.36), 0], 1e-6);
});

test('faceforward is n for a negative dot(i, ng) and -n otherwise, zero included', ()=>{
    close(val('faceforward', [v(3), [0, 1, 0], [0, 1, 0], [0, 1, 0]]), [0, -1, 0]);
    close(val('faceforward', [v(3), [0, 1, 0], [0, -1, 0], [0, 1, 0]]), [0, 1, 0]);
    close(val('faceforward', [v(3), [0, 1, 0], [1, 0, 0], [0, 1, 0]]), [0, -1, 0]);
});

test('lit and D3DCOLORtoUBYTE4', ()=>{
    assert.deepEqual(val('lit', [FLOAT, 0.5, 0.5, 2]), [1, 0.5, 0.25, 1]);
    assert.deepEqual(val('lit', [FLOAT, -1, 0.5, 2]), [1, 0, 0, 1]);
    assert.deepEqual(val('lit', [FLOAT, 1, -0.5, 2]), [1, 1, 0, 1]);
    assert.deepEqual(val('lit', [FLOAT, 1, 0.5, 0]), [1, 1, 1, 1]);
    assert.deepEqual(val('D3DCOLORtoUBYTE4', [v(4), [1, 0.5, 0, 0.2]]), [0, 127, 255, 51]);
    assert.deepEqual(val('D3DCOLORtoUBYTE4', [v(4), [0, 0, 0, 0]]), [0, 0, 0, 0]);
    assert.deepEqual(val('D3DCOLORtoUBYTE4', [v(4), [0.1, 0.2, 0.3, 1]]), [76, 51, 25, 255]);
});

test('determinant and transpose', ()=>{
    assert.equal(val('determinant', [m(1, 1), [[5]]]), 5);
    assert.equal(val('determinant', [m(2, 2), [[1, 2], [3, 4]]]), -2);
    assert.equal(val('determinant', [m(3, 3), [[2, 0, 0], [0, 3, 0], [0, 0, 4]]]), 24);
    assert.equal(val('determinant', [m(3, 3), [[1, 2, 3], [4, 5, 6], [7, 8, 9]]]), 0);
    assert.equal(val('determinant', [m(3, 3), [[2, -3, 1], [2, 0, -1], [1, 4, 5]]]), 49);
    assert.equal(val('determinant', [m(4, 4), [[1, 2, 3, 4], [5, 6, 7, 8], [2, 6, 4, 8],
        [3, 1, 1, 2]]]), 72);
    assert.equal(val('determinant', [m(4, 4), [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0],
        [0, 0, 0, 1]]]), 1);
    assert.deepEqual(val('transpose', [m(2, 3), [[1, 2, 3], [4, 5, 6]]]),
        [[1, 4], [2, 5], [3, 6]]);
    assert.deepEqual(val('transpose', [m(1, 3), [[1, 2, 3]]]), [[1], [2], [3]]);
});

test('mul: scalar, dot, row vector times matrix, matrix times vector, matrix product', ()=>{
    assert.equal(val('mul', [FLOAT, 3, 4]), 12);
    assert.deepEqual(val('mul', [FLOAT, 2, [1, 2, 3]]), [2, 4, 6]);
    assert.deepEqual(val('mul', [v(3), [1, 2, 3], 2]), [2, 4, 6]);
    assert.equal(val('mul', [v(3), [1, 2, 3], [4, 5, 6]]), 32);
    assert.equal(val('mul', [v(4), [1, 2, 3, 4], [1, 1, 1]]), 6);
    assert.equal(val('mul', [INT, 3, 4]), 12);
});

test('mul with matrices', ()=>{
    const a = [[1, 2, 3], [4, 5, 6]];
    assert.deepEqual(run('mul', [[v(2), [1, 2]], [m(2, 3), a]]).result, [9, 12, 15]);
    assert.deepEqual(run('mul', [[m(2, 3), a], [v(3), [1, 1, 1]]]).result, [6, 15]);
    assert.deepEqual(run('mul', [[v(4), [1, 2, 9, 9]], [m(2, 3), a]]).result, [9, 12, 15]);
    assert.deepEqual(run('mul', [[m(2, 3), a], [v(4), [1, 1, 1, 7]]]).result, [6, 15]);
    const b = [[1, 0], [0, 1], [2, 2]];
    assert.deepEqual(run('mul', [[m(2, 3), a], [m(3, 2), b]]).result, [[7, 8], [16, 17]]);
    assert.deepEqual(run('mul', [[FLOAT, 2], [m(2, 3), a]]).result, [[2, 4, 6], [8, 10, 12]]);
    assert.deepEqual(run('mul', [[m(2, 3), a], [FLOAT, 0.5]]).result,
        [[0.5, 1, 1.5], [2, 2.5, 3]]);
    const rot = [[0, 1, 0, 0], [-1, 0, 0, 0], [0, 0, 1, 0], [5, 6, 7, 1]];
    assert.deepEqual(run('mul', [[v(4), [1, 0, 0, 1]], [m(4, 4), rot]]).result, [5, 7, 7, 1]);
    assert.deepEqual(run('mul', [[m(4, 4), rot], [v(4), [1, 0, 0, 1]]]).result, [0, -1, 0, 6]);
});

test('modf, frexp, sincos give their results through the out arguments', ()=>{
    let r = run('modf', [[FLOAT, -1.5], [FLOAT, 0]]);
    assert.equal(r.result, -0.5);
    assert.equal(r.outs.get(1), -1);
    r = run('modf', [[v(2), [2.25, 7]], [v(2), 0]]);
    assert.deepEqual(r.result, [0.25, 0]);
    assert.deepEqual(r.outs.get(1), [2, 7]);
    // fxc's models 1 to 3 take the ceiling of log2|x|: a power of two is itself times 2^0,
    // 8 is 1 * 2^3 (frexp(true) is 1 and 0 there, where model 4 says 0.5 and 1).
    r = run('frexp', [[FLOAT, 8], [FLOAT, 0]]);
    assert.equal(r.result, 1);
    assert.equal(r.outs.get(1), 3);
    r = run('frexp', [[FLOAT, 0.375], [FLOAT, 0]]);
    assert.equal(r.result, 0.75);
    assert.equal(r.outs.get(1), -1);
    r = run('frexp', [[FLOAT, -6], [FLOAT, 0]]);
    assert.equal(r.result, -0.75);
    assert.equal(r.outs.get(1), 3);
    r = run('frexp', [[FLOAT, 0], [FLOAT, 0]]);
    assert.equal(r.result, 0);
    assert.equal(r.outs.get(1), 0);
    r = run('sincos', [[v(2), [0, Math.PI]], [v(2), 0], [v(2), 0]]);
    assert.equal(r.result, 0);
    close(r.outs.get(1), [0, 0], 1e-6);
    close(r.outs.get(2), [1, -1], 1e-6);
});

test('clip kills only below zero; derivatives go through the host', ()=>{
    let killed = 0;
    const hooks = { discard: ()=>{
        killed++;
    },
    derivative: (/** @type {string} */ axis, /** @type {any} */ x)=>
        Array.isArray(x) ? x.map(c=>axis === 'x' ? c * 2 : -c) : (axis === 'x' ? x * 2 : -x) };
    run('clip', [[v(3), [1, 0, 0.5]]], hooks);
    assert.equal(killed, 0);
    run('clip', [[v(3), [1, -0.001, 0.5]]], hooks);
    assert.equal(killed, 1);
    run('clip', [[FLOAT, -1]], hooks);
    assert.equal(killed, 2);
    run('clip', [[FLOAT, NaN]], hooks);
    assert.equal(killed, 2);
    assert.equal(run('ddx', [[FLOAT, 3]], hooks).result, 6);
    assert.equal(run('ddy', [[FLOAT, 3]], hooks).result, -3);
    assert.deepEqual(run('ddx', [[v(2), [1, 2]]], hooks).result, [2, 4]);
    assert.equal(run('fwidth', [[FLOAT, -3]], hooks).result, 9);
    assert.deepEqual(run('fwidth', [[v(2), [1, -2]]], hooks).result, [3, 6]);
    assert.throws(()=>run('ddx', [[FLOAT, 1]], {}), /no derivatives/);
});

test('texture sampling goes through the host with the mode and the coordinates', ()=>{
    /** @type {any[]} */
    const calls = [];
    const hooks = { sample: (/** @type {any[]} */ ...a)=>{
        calls.push(a);
        return [0.1, 0.2, 0.3, 0.4];
    } };
    const s = { name: 'tex' };
    const t1 = samplerOf('1d');
    const t2 = samplerOf('2d');
    const t3 = samplerOf('3d');
    const tc = samplerOf('cube');
    const answer = [f32(0.1), f32(0.2), f32(0.3), f32(0.4)];
    assert.deepEqual(run('tex2D', [[t2, s], [v(2), [0.25, 0.5]]], hooks).result, answer);
    assert.deepEqual(calls.pop(), [s, 'tex2D', 'plain', [0.25, 0.5], {}]);
    run('tex1D', [[t1, s], [FLOAT, 0.75]], hooks);
    assert.deepEqual(calls.pop(), [s, 'tex1D', 'plain', [0.75], {}]);
    run('tex3D', [[t3, s], [v(3), [1, 2, 3]]], hooks);
    assert.deepEqual(calls.pop(), [s, 'tex3D', 'plain', [1, 2, 3], {}]);
    run('texCUBE', [[tc, s], [v(3), [0, 1, 0]]], hooks);
    assert.deepEqual(calls.pop(), [s, 'texCUBE', 'plain', [0, 1, 0], {}]);
    run('tex2Dproj', [[t2, s], [v(4), [2, 4, 0, 2]]], hooks);
    assert.deepEqual(calls.pop(), [s, 'tex2D', 'plain', [1, 2], {}]);
    run('tex3Dproj', [[t3, s], [v(4), [2, 4, 6, 2]]], hooks);
    assert.deepEqual(calls.pop(), [s, 'tex3D', 'plain', [1, 2, 3], {}]);
    run('tex1Dproj', [[t1, s], [v(4), [3, 0, 0, 2]]], hooks);
    assert.deepEqual(calls.pop(), [s, 'tex1D', 'plain', [1.5], {}]);
    run('tex2Dbias', [[t2, s], [v(4), [0.5, 0.5, 0, 1.5]]], hooks);
    assert.deepEqual(calls.pop(), [s, 'tex2D', 'bias', [0.5, 0.5], { value: 1.5 }]);
    run('tex2Dlod', [[t2, s], [v(4), [0.5, 0.5, 0, 3]]], hooks);
    assert.deepEqual(calls.pop(), [s, 'tex2D', 'lod', [0.5, 0.5], { value: 3 }]);
    run('texCUBElod', [[tc, s], [v(4), [0, 1, 0, 2]]], hooks);
    assert.deepEqual(calls.pop(), [s, 'texCUBE', 'lod', [0, 1, 0], { value: 2 }]);
    run('tex2Dgrad', [[t2, s], [v(2), [0.5, 0.5]], [v(2), [1, 0]], [v(2), [0, 1]]], hooks);
    assert.deepEqual(calls.pop(), [s, 'tex2D', 'grad', [0.5, 0.5],
        { ddx: [1, 0], ddy: [0, 1] }]);
    run('tex1Dgrad', [[t1, s], [FLOAT, 0.5], [FLOAT, 1], [FLOAT, 2]], hooks);
    assert.deepEqual(calls.pop(), [s, 'tex1D', 'grad', [0.5], { ddx: [1], ddy: [2] }]);
    assert.throws(()=>run('tex2D', [[t2, s], [v(2), [0, 0]]], {}), /no texture sampling/);
});

test('ints are int32 in the integer overloads', ()=>{
    assert.equal(val('min', [INT, 2147483647, -5]), -5);
    assert.equal(val('abs', [INT, 5]), 5);
    assert.equal(val('max', [INT, 2, 3]), 3);
    assert.equal(val('max', [FLOAT, 2, 3.5]), 3.5);
    assert.equal(val('clamp', [INT, 10, 1, 5]), 5);
    assert.equal(val('sign', [INT, 0]), 0);
});
