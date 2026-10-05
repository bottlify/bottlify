/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from './hlsl-parser.js';
import { check } from './hlsl-check.js';
import { createEvaluator } from './hlsl-eval.js';

const f32 = Math.fround;

/** @param {string} source @param {string} [entry] */
function load(source, entry = 'main'){
    const program = parse(source);
    const { module, diagnostics } = check(program, { entry });
    const errs = diagnostics.filter(d=>d.severity === 'error');
    assert.deepEqual(errs.map(d=>`${d.code} ${d.message} ${d.pos.line}:${d.pos.col}`), [],
        source);
    return module;
}

/**
 * @param {string} source
 * @param {any[] | Record<string, any>} [args]
 * @param {Partial<import('./hlsl-eval.js').Environment>} [env]
 * @param {string} [entry]
 */
function exec(source, args = [], env = {}, entry = 'main'){
    const module = load(source, entry);
    const evaluator = createEvaluator(module, {
        uniform: sym=>{
            throw new Error(`no value for ${sym.name}`);
        }, ...env });
    return evaluator.call(/** @type {any} */ (module.findFunction(entry)), args);
}

/** -0 is 0 here. @param {any} x @returns {any} */
function norm(x){
    if (Array.isArray(x))
    {
        return x.map(norm);
    }
    if (typeof x === 'number')
    {
        return x + 0;
    }
    if (x && typeof x === 'object')
    {
        return Object.fromEntries(Object.entries(x).map(([k, v])=>[k, norm(v)]));
    }
    return x;
}

/** @param {string} source @param {any[] | Record<string, any>} [args] */
const ret = (source, args = [], env = {})=>norm(exec(source, args, env).result);

/** The value of an expression of the given type. */
const val = (/** @type {string} */ type, /** @type {string} */ text, decls = '')=>
    ret(`${decls}\n${type} main(){ return ${text}; }`);

/** @param {any} actual @param {any} expected @param {number} [eps] */
function close(actual, expected, eps = 1e-6){
    if (Array.isArray(expected))
    {
        assert.ok(Array.isArray(actual), `array expected, got ${JSON.stringify(actual)}`);
        assert.equal(actual.length, expected.length);
        expected.forEach((x, i)=>close(actual[i], x, eps));
        return;
    }
    if (Number.isNaN(expected))
    {
        assert.ok(Number.isNaN(actual));
        return;
    }
    assert.ok(Math.abs(actual - expected) <= eps * Math.max(1, Math.abs(expected)),
        `expected ${expected}, got ${actual}`);
}

test('scalar arithmetic: ints are int32, division truncates, % takes the dividend sign', ()=>{
    /** @type {[string, string, number][]} */
    const cases = [
        ['int', '7 / 2', 3], ['int', '-7 / 2', -3], ['int', '7 / -2', -3], ['int', '7 % 3', 1],
        ['int', '-7 % 3', -1], ['int', '7 % -3', 1], ['int', '5 / 0', 0], ['int', '5 % 0', 0],
        ['int', '2147483647 + 1', -2147483648], ['int', '-2147483647 - 2', 2147483647],
        ['int', '65536 * 65536', 0], ['int', '100000 * 100000', 1410065408],
        ['int', '5 / 2 * 2', 4], ['int', '2 + 3 * 4', 14], ['int', '(2 + 3) * 4', 20],
        ['int', '10 - 3 - 2', 5], ['int', '-(-5)', 5], ['int', '+5', 5],
        ['int', '1 << 4', 16], ['int', '-16 >> 2', -4], ['int', '1 << 33', 2],
        ['int', '0xF0 & 0x3C', 0x30], ['int', '0xF0 | 0x0F', 255], ['int', '5 ^ 3', 6],
        ['int', '~0', -1], ['int', '~5', -6], ['int', '1 << 31', -2147483648],
        ['int', '3 > 2 ? 10 : 20', 10], ['int', '3 < 2 ? 10 : 20', 20],
        ['float', '7.0 / 2', 3.5], ['float', '5.5 % 2', 1.5], ['float', '-5.5 % 2', -1.5],
        ['float', '3 / 2', 1], ['float', '3 / 2.0', 1.5], ['float', '(float)3 / 2', 1.5],
        ['float', '0.1 + 0.2', f32(f32(0.1) + f32(0.2))], ['float', '16777216.0 + 1.0', 16777216],
        ['float', '1.0 / 0.0', Infinity], ['float', '-1.0 / 0.0', -Infinity],
        ['float', '0.1 * 3', f32(f32(0.1) * 3)], ['float', '1 / 3.0', f32(1 / 3)],
        ['float', '0.1', f32(0.1)], ['float', '1e-3', f32(0.001)],
        ['int', '(int)3.9', 3], ['int', '(int)-3.9', -3], ['int', 'int(2.5)', 2],
        ['int', '(int)true', 1], ['int', 'true + true', 2], ['int', '(int)1e20', 2147483647],
        ['float', '(float)7', 7], ['bool', '(bool)0.5', 1], ['bool', '(bool)0', 0],
        ['bool', '3 > 2', 1], ['bool', '2 >= 3', 0], ['bool', '1.5 == 1.5', 1],
        ['bool', '1 != 1', 0], ['bool', '3 <= 3', 1], ['bool', '-1 < 0', 1],
        ['bool', 'true && false', 0], ['bool', 'true || false', 1], ['bool', '!5', 0],
        ['bool', '!0', 1], ['bool', '2 && 3', 1], ['bool', '0 || 0.5', 1],
        ['bool', '(0.0 / 0.0) == (0.0 / 0.0)', 0], ['bool', '(0.0 / 0.0) != (0.0 / 0.0)', 1],
        ['bool', '(0.0 / 0.0) < 1', 0], ['bool', 'true == true', 1], ['bool', 'true != false', 1],
    ];
    for (const [type, text, expected] of cases)
    {
        assert.equal(val(type, text), expected, `${type} ${text}`);
    }
    assert.ok(Number.isNaN(val('float', '0.0 / 0.0')));
    assert.ok(Number.isNaN(val('float', '5.0 % 0')));
});

test('compound assignment and increments follow the type of the operation', ()=>{
    /** @type {[string, number][]} */
    const cases = [
        ['int i = 5; i += 2.7; return i;', 7], ['int i = 7; i *= 1.5; return i;', 10],
        ['int i = 7; i /= 2; return i;', 3], ['int i = 7; i %= 4; return i;', 3],
        ['int i = 1; i <<= 3; return i;', 8], ['int i = 12; i >>= 2; return i;', 3],
        ['int i = 12; i &= 10; return i;', 8], ['int i = 12; i |= 3; return i;', 15],
        ['int i = 12; i ^= 5; return i;', 9], ['float f = 1.5; f++; return f;', 2.5],
        ['float f = 1.5; f--; return f;', 0.5], ['int i = 5; int j = i++; return j * 10 + i;', 56],
        ['int i = 5; int j = ++i; return j * 10 + i;', 66],
        ['int i = 5; int j = i--; return j * 10 + i;', 54],
        ['int i = 5; int j = --i; return j * 10 + i;', 44],
        ['float a = 0; float b = 0; a = b = 3; return a + b;', 6],
        ['float b = 0; float a = (b = 2) + 1; return a * 10 + b;', 32],
        ['int a = (1, 2, 3); return a;', 3],
        ['float f = 10; f -= 2.5; f *= 2; f /= 5; return f;', 3],
        ['float f = 7; f %= 4; return f;', 3],
        ['int x = true + true; return x;', 2],
        ['float f = 2; f += 1; f += 1; return f;', 4],
    ];
    for (const [body, expected] of cases)
    {
        const type = body.includes('float f') || body.includes('float a') ? 'float' : 'int';
        assert.equal(ret(`${type} main(){ ${body} }`), expected, body);
    }
});


test('vectors: swizzles read and write, scalars replicate, longer values truncate', ()=>{
    /** @type {[string, string, any][]} */
    const cases = [
        ['float4', 'float4 a = float4(1,2,3,4); return a.wzyx;', [4, 3, 2, 1]],
        ['float2', 'float4 a = float4(1,2,3,4); return a.xy + a.zw;', [4, 6]],
        ['float3', 'float4 a = float4(1,2,3,4); return a.rgb * 2;', [2, 4, 6]],
        ['float4', 'float4 a = float4(1,2,3,4); return a.yyxx;', [2, 2, 1, 1]],
        ['float4', 'float4 v = 0; v.zy = float2(5,6); v.w = 9; v.x += 1; return v;',
            [1, 6, 5, 9]],
        ['float4', 'float4 v = 0; v.xyzw = float4(1,2,3,4); v.xz *= 2; return v;', [2, 2, 6, 4]],
        ['float4', 'float4 v = float4(1,2,3,4); v.xy = v.yx; return v;', [2, 1, 3, 4]],
        ['float4', 'float4 v = float4(1,2,3,4); v.yz = v.zy; return v;', [1, 3, 2, 4]],
        ['float4', 'float4 v = 0; v.xy = 7; return v;', [7, 7, 0, 0]],
        ['float4', 'float4 v = 0; v.xy = float3(1,2,3); return v;', [1, 2, 0, 0]],
        ['float4', 'float4 v = 0; v.xy = int2(1,2); return v;', [1, 2, 0, 0]],
        ['float4', 'float4 v = 0; v.x++; v.y--; return v;', [1, -1, 0, 0]],
        ['float3', 'float3 v = 2; return v * float3(1,2,3) + 1;', [3, 5, 7]],
        ['float4', 'return float4(float2(1,2), 3, 4);', [1, 2, 3, 4]],
        ['float4', 'return float4(1, float3(2,3,4));', [1, 2, 3, 4]],
        ['float4', 'return float4(float2(1,2), float2(3,4)).wzyx;', [4, 3, 2, 1]],
        ['float4', 'return float4(5, 5, 5, 5) / float4(1, 2, 4, 5);', [5, 2.5, 1.25, 1]],
        ['float4', 'return float4(9);', [9, 9, 9, 9]],
        ['float2', 'float2 v = float4(1,2,3,4); return v;', [1, 2]],
        ['float', 'float s = float3(7,8,9); return s;', 7],
        ['float3', 'float3 a = float3(1,2,3); float4 b = float4(5,6,7,8); return a + b;',
            [6, 8, 10]],
        ['int3', 'return int3(7, -7, 9) / 2;', [3, -3, 4]],
        ['int3', 'return int3(7, -7, 9) % 4;', [3, -3, 1]],
        ['float3', 'return int3(1, 2, 3) * 2.5;', [2.5, 5, 7.5]],
        ['int3', 'return (int3)float3(1.9, -1.9, 2.5);', [1, -1, 2]],
        ['bool3', 'return float3(1,2,3) > 2;', [0, 0, 1]],
        ['bool3', 'return float3(1,2,3) == float3(1,0,3);', [1, 0, 1]],
        ['bool2', 'return bool2(true, false) || bool2(false, false);', [1, 0]],
        ['bool2', 'return bool2(true, true) && bool2(true, false);', [1, 0]],
        ['bool3', 'return !float3(0, 1, 2);', [1, 0, 0]],
        ['float3', 'return -float3(1, -2, 0);', [-1, 2, 0]],
        ['float3', 'float3 v = float3(1,2,3); return v.x ? v : -v;', [1, 2, 3]],
        ['float3', 'float s = 2; return s.xxx;', [2, 2, 2]],
        ['float', 'float s = 1; s.x = 5; return s;', 5],
        ['float', 'float s = 3; return s.r;', 3],
        ['int2', 'int4 q = int4(1,2,3,4); return q.zw;', [3, 4]],
        ['float', 'float4 v = float4(1,2,3,4); return v[2];', 3],
        ['float4', 'float4 v = float4(1,2,3,4); int i = 3; v[i] = 9; v[0] += 1; return v;',
            [2, 2, 3, 9]],
        ['float1', 'float1 v = 4; return v + 1;', [5]],
        ['float', 'float f = float1(3); return f;', 3],
        ['float3', 'half3 h = half3(1, 2, 3); return h * 2;', [2, 4, 6]],
        ['float3', 'return (float3)1;', [1, 1, 1]],
        ['float4', 'float4 v = float4(1,2,3,4); return float4(v.xyz * 2, v.w);', [2, 4, 6, 4]],
        ['float3', 'int3 a = int3(1, 2, 3); float3 b = a; return b / 2;', [0.5, 1, 1.5]],
        ['int3', 'int3 a = int3(1, 2, 3); int3 b = a / 2; return b;', [0, 1, 1]],
        ['float3', 'float3 a = 0; a += float3(1, 2, 3) * 0.1; return a;',
            [f32(0.1), f32(f32(0.1) * 2), f32(f32(0.1) * 3)]],
    ];
    for (const [type, body, expected] of cases)
    {
        assert.deepEqual(ret(`${type} main(){ ${body} }`), expected, body);
    }
});

test('matrices: rows, swizzles, writes, componentwise operators, mul', ()=>{
    const M = 'float3x3 m = float3x3(1,2,3,4,5,6,7,8,9);';
    /** @type {[string, string, any][]} */
    const cases = [
        ['float3', `${M} return m[1];`, [4, 5, 6]],
        ['float', `${M} return m[2][0];`, 7],
        ['float', `${M} return m._m21;`, 8],
        ['float', `${M} return m._32;`, 8],
        ['float3', `${M} return m._11_22_33;`, [1, 5, 9]],
        ['float3', `${M} return m._m02_m12_m22;`, [3, 6, 9]],
        ['float3x3', `${M} m._m01 = 20; m[2] = float3(0,0,1); m[1][2] = 66; return m;`,
            [[1, 20, 3], [4, 5, 66], [0, 0, 1]]],
        ['float3x3', `${M} m._11_22 = float2(-1, -2); return m;`,
            [[-1, 2, 3], [4, -2, 6], [7, 8, 9]]],
        ['float3x3', `${M} return m * 2;`, [[2, 4, 6], [8, 10, 12], [14, 16, 18]]],
        ['float3x3', `${M} return m * m;`, [[1, 4, 9], [16, 25, 36], [49, 64, 81]]],
        ['float3x3', `${M} return m + 1 - m;`, [[1, 1, 1], [1, 1, 1], [1, 1, 1]]],
        ['float3x3', `${M} return -m;`, [[-1, -2, -3], [-4, -5, -6], [-7, -8, -9]]],
        ['float3x3', `${M} return m / float3x3(1,1,1,2,2,2,3,3,3);`,
            [[1, 2, 3], [2, 2.5, 3], [7 / 3, 8 / 3, 3]].map(r=>r.map(f32))],
        ['float3', `${M} return mul(m, float3(1,0,0));`, [1, 4, 7]],
        ['float3', `${M} return mul(float3(1,0,0), m);`, [1, 2, 3]],
        ['float3', `${M} return mul(float3(1,1,1), m);`, [12, 15, 18]],
        ['float3x3', `${M} return mul(m, m);`, [[30, 36, 42], [66, 81, 96], [102, 126, 150]]],
        ['float3x3', `${M} return transpose(m);`, [[1, 4, 7], [2, 5, 8], [3, 6, 9]]],
        ['float2x2', `${M} return (float2x2)m;`, [[1, 2], [4, 5]]],
        ['float2x2', 'return float2x2(float4(1,2,3,4));', [[1, 2], [3, 4]]],
        ['float2x2', 'return float2x2(float2(1,2), float2(3,4));', [[1, 2], [3, 4]]],
        ['float2x2', 'float2x2 m = float2x2(1,2,3,4); m._m10 = 7; return m;', [[1, 2], [7, 4]]],
        ['float2x3', 'float2x3 m = { 1, 2, 3, 4, 5, 6 }; return m;', [[1, 2, 3], [4, 5, 6]]],
        ['float4', 'float2x2 m = float2x2(1,2,3,4); return m;', [1, 2, 3, 4]],
        ['float2x2', 'return float2x2(1,2,3,4) + 1;', [[2, 3], [4, 5]]],
        ['bool2x2', 'return float2x2(1,2,3,4) > 2;', [[0, 0], [1, 1]]],
        ['float', 'return determinant(float2x2(1,2,3,4));', -2],
        ['float2x3', 'return mul(float2x2(1,2,3,4), float2x3(1,0,1,0,1,1));',
            [[1, 2, 3], [3, 4, 7]]],
        ['float4', 'return mul(float4(1,2,3,1), float4x4(1,0,0,0, 0,1,0,0, 0,0,1,0, 5,6,7,1));',
            [6, 8, 10, 1]],
        ['float3', 'float3x3 m = 0; m[1] = float3(1,2,3); m[1].yz *= 2; return m[1];',
            [1, 4, 6]],
        ['float', 'float2x2 m = float2x2(1,2,3,4); int i = 1; return m[i][i];', 4],
        ['int2x2', 'return (int2x2)float2x2(1.5, 2.5, -1.5, 3.5);', [[1, 2], [-1, 3]]],
    ];
    for (const [type, body, expected] of cases)
    {
        assert.deepEqual(ret(`${type} main(){ ${body} }`), expected, body);
    }
});

test('structs and arrays have value semantics', ()=>{
    const S = 'struct S { float x; float3 v; };';
    /** @type {[string, string, any][]} */
    const cases = [
        ['float', `${S} float main(){ S a; a.x = 1; S b = a; b.x = 2; return a.x * 10 + b.x; }`,
            12],
        ['float', `${S} float main(){ S a; a.x = 1; S b; b = a; a.x = 5; return b.x; }`, 1],
        ['float3', `${S} float3 main(){ S a; a.v = float3(1,2,3); a.v.yz = 0; return a.v; }`,
            [1, 0, 0]],
        ['float', `${S} float main(){ S a[2]; a[1].x = 7; a[0] = a[1]; a[1].x = 9;`
            + ' return a[0].x; }', 7],
        ['float', 'float main(){ float a[3] = {1,2,3}; float b[3] = a; b[0] = 9; return a[0]; }',
            1],
        ['float', 'float main(){ float a[3] = {1,2,3}; float b[3]; b = a; a[1] = 9; return b[1]; }',
            2],
        ['float', 'float main(){ float a[4] = {1,2,3,4}; float s = 0; '
            + 'for (int i = 0; i < 4; i++) { s += a[i] * (i + 1); } return s; }', 30],
        ['float', 'float main(){ float m[2][3]; m[1][2] = 5; m[0][1] = 2; return m[1][2] + m[0][1]'
            + ' + m[0][0]; }', 7],
        ['float2', 'float2 main(){ float2 a[2] = { {1,2}, {3,4} }; a[1].x = 9; return a[1]; }',
            [9, 4]],
        ['float', 'float main(){ float a[] = {5, 6, 7}; return a[2]; }', 7],
        ['float2', 'float2 main(){ float2 k[] = {1, 2, 3, 4}; return k[1]; }', [3, 4]],
        ['float', `${S} float main(){ S s = { 1, 2, 3, 4 }; return s.x + s.v.z; }`, 5],
        ['float', 'float main(){ float a[3] = {1, 2, 3}; a[1]++; a[2] *= 2; return a[1] + a[2]; }',
            9],
        ['float', 'float main(){ int i = 0; float a[3] = {1,2,3}; a[i++] = 10; a[i++] = 20; '
            + 'return a[0] * 100 + a[1] * 10 + i; }', 1202],
    ];
    for (const [, source, expected] of cases)
    {
        assert.deepEqual(ret(source), expected, source);
    }
});

test('an array index outside the array throws', ()=>{
    assert.throws(()=>ret('float main(){ float a[2] = {1,2}; int i = 2; return a[i]; }'),
        RangeError);
    assert.throws(()=>ret('float main(){ float a[2] = {1,2}; int i = -1; return a[i]; }'),
        RangeError);
    assert.throws(()=>ret('float main(){ float4 v = 1; int i = 4; return v[i]; }'),
        /outside/);
});

test('control flow: loops, break, continue, early return, switch', ()=>{
    /** @type {[string, number][]} */
    const cases = [
        ['int s = 0; for (int i = 0; i < 10; i++) { s += i; } return s;', 45],
        ['int s = 0; for (int i = 0; i < 4; i++) { for (int j = 0; j < i; j++) { s += j; } }'
            + ' return s;', 4],
        ['int s = 0; for (int i = 0; i < 10; i++) { if (i == 5) break; s += i; } return s;', 10],
        ['int s = 0; for (int i = 0; i < 10; i++) { if (i % 2 == 0) continue; s += i; } return s;',
            25],
        ['int s = 0; int k = 0; while (k < 5) { k++; s += k; } return s;', 15],
        ['int k = 10; do { k++; } while (k < 5); return k;', 11],
        ['int k = 0; do { k++; if (k == 3) continue; } while (k < 6); return k;', 6],
        ['int s = 0; [unroll] for (int i = 0; i < 3; i++) { s += 2; } return s;', 6],
        ['int s = 0; for (int i = 0; i < 3; i++) { for (int j = 0; j < 3; j++) { '
            + 'if (j == 1) break; s++; } } return s;', 3],
        ['for (int i = 0; i < 10; i++) { if (i == 4) return i * 100; } return -1;', 400],
        ['int i = 0; for (;;) { i++; if (i > 6) break; } return i;', 7],
        ['int s = 0; int i = 3; while (i-- > 0) { s += 10; } return s * 10 + i;', 299],
        ['int r = 0; switch (2) { case 1: r = 10; break; case 2: r = 20; break; '
            + 'default: r = 30; } return r;', 20],
        ['int r = 0; switch (7) { case 1: r = 10; break; default: r = 30; break; } return r;', 30],
        ['int r = 5; switch (7) { case 1: r = 10; break; } return r;', 5],
        ['int x = 3; int r = 0; for (int i = 0; i < 4; i++) { switch (i) { case 2: r += 100; '
            + 'break; default: r += 1; } } return r;', 103],
        ['int r = 0; if (1 > 2) r = 1; else if (2 > 3) r = 2; else r = 3; return r;', 3],
        ['int r = 0; if (true) { r = 1; } else { r = 2; } return r;', 1],
        ['int i = 0; int r = 0; while (true) { i++; if (i > 3) break; r += i; } return r;', 6],
        ['int s = 0; for (int i = 0; i < 3; i++) { int sq = i * i; s += sq; } return s;', 5],
    ];
    for (const [body, expected] of cases)
    {
        assert.equal(ret(`int main(){ ${body} }`), expected, body);
    }
});

test('the loop guard throws after the iteration limit', ()=>{
    assert.throws(()=>exec('void main(){ while (true) { } }', [], { maxIterations: 50 }),
        /iteration limit/);
    assert.throws(()=>exec('void main(){ for (int i = 0; i < 100; i++) { } }', [],
        { maxIterations: 50 }), /iteration limit/);
    assert.throws(()=>exec('void main(){ do { } while (true); }', [], { maxIterations: 10 }),
        /iteration limit/);
    assert.doesNotThrow(()=>exec('void main(){ for (int i = 0; i < 50; i++) { } }', [],
        { maxIterations: 50 }));
    assert.throws(()=>exec('void main(){ while (true) { } }'), /iteration limit/);
});

test('functions: results, out and inout, copy-in copy-out', ()=>{
    const LIB = `
float sq(float x){ return x * x; }
void two(out float a, out float b){ a = 1; b = 2; }
void inc(inout int x){ x++; }
void setv(out float2 v){ v = float2(1, 2); }
void getf(out float x){ x = 2.7; }
void swap(inout float a, inout float b){ float t = a; a = b; b = t; }
float len2(float3 v){ return dot(v, v); }
float4 f(float x){ return float4(x, 0, 0, 0); }
float4 f(float2 x){ return float4(x, 1, 1); }
float scale(float v, float k){ return v * k; }
int order(int x, int y){ return x * 10 + y; }
float sum(float a[3]){ a[0] = 100; return a[0] + a[1] + a[2]; }
struct S { float a; float3 v; };
S make(float a){ S s; s.a = a; s.v = float3(a, a + 1, a + 2); return s; }
float use(S s){ s.a = 99; return s.a; }
float deep(float x){ return sq(sq(x) + 1) - sq(x); }
`;
    /** @type {[string, any, any][]} */
    const cases = [
        ['float', 'sq(3)', 9], ['float', 'sq(sq(2))', 16], ['float', 'deep(2)', 21],
        ['float', 'sq(2.5) + sq(1)', 7.25], ['float', 'len2(float3(1,2,2))', 9],
        ['float4', 'f(5)', [5, 0, 0, 0]], ['float4', 'f(float2(7, 8))', [7, 8, 1, 1]],
        ['float4', 'f(3.5)', [3.5, 0, 0, 0]],
        ['float', 'scale(2, 3)', 6], ['float', 'scale(int(2), true)', 2],
        ['float', 'make(2).a', 2], ['float3', 'make(2).v', [2, 3, 4]],
        ['float', 'make(1).v.z + make(10).a', 13],
    ];
    for (const [type, expression, expected] of cases)
    {
        assert.deepEqual(val(type, expression, LIB), expected, expression);
    }
    /** @type {[string, string, any][]} */
    const bodies = [
        ['float', 'float a = 0; float b = 0; two(a, b); return a * 10 + b;', 12],
        ['int', 'int a = 1; inc(a); inc(a); return a;', 3],
        ['float4', 'float4 r = 0; setv(r.zw); return r;', [0, 0, 1, 2]],
        ['float2', 'float2 a[2] = { {0,0}, {0,0} }; setv(a[1]); return a[1];', [1, 2]],
        ['int', 'int i = 0; getf(i); return i;', 2],
        ['float', 'float x = 0; getf(x); return x;', f32(2.7)],
        ['float2', 'float a = 1; float b = 2; swap(a, b); return float2(a, b);', [2, 1]],
        ['float', 'float v[2] = {1, 2}; swap(v[0], v[1]); return v[0] * 10 + v[1];', 21],
        ['int', 'int i = 1; return order(i++, i++);', 12],
        ['float', 'float a[3] = {1, 2, 3}; float r = sum(a); return r + a[0];', 106],
        ['float', 'S s = make(1); float r = use(s); return r + s.a;', 100],
        ['float', 'float x = 0; two(x, x); return x;', 2],
    ];
    for (const [type, body, expected] of bodies)
    {
        assert.deepEqual(ret(`${LIB}\n${type} main(){ ${body} }`), expected, body);
    }
});

test('the out parameters and the result of the entry point', ()=>{
    const r = exec(`
void main(float4 p : POSITION, out float4 c : COLOR0, inout float2 uv : TEXCOORD0,
    out float k : TEXCOORD1){
    c = p * 2;
    uv = uv.yx;
    k = 3;
}`, { p: [1, 2, 3, 4], uv: [5, 6] });
    assert.equal(r.result, undefined);
    assert.deepEqual([...r.outs.keys()], [1, 2, 3]);
    assert.deepEqual(r.outs.get(1), [2, 4, 6, 8]);
    assert.deepEqual(r.outs.get(2), [6, 5]);
    assert.equal(r.outs.get(3), 3);
    assert.equal(r.killed, false);
    const byPosition = exec(`float3 main(float3 a, float3 b){ return a + b; }`,
        [[1, 2, 3], [10, 20, 30]]);
    assert.deepEqual(byPosition.result, [11, 22, 33]);
    assert.equal(byPosition.outs.size, 0);
});

test('missing inputs: a value is required, an out parameter starts at zero', ()=>{
    assert.throws(()=>exec('float main(float a : A, float b : B){ return a + b; }', { a: 1 }),
        /no value for parameter b/);
    const r = exec('float main(out float a){ return a; }', []);
    assert.equal(r.result, 0);
});

test('inputs are normalised: structs fill missing members, floats round to 32 bits', ()=>{
    const src = `
struct IN { float4 p : POSITION; float2 uv : TEXCOORD0; int k : BLENDINDICES; };
float4 main(IN i){ return float4(i.p.x, i.uv.y, i.k, 1); }`;
    assert.deepEqual(ret(src, [{ p: [0.1, 0, 0, 0], k: 2.7 }]), [f32(0.1), 0, 2, 1]);
});

test('SM3 evaluates both sides of && || and ?:', ()=>{
    assert.equal(ret('int main(){ int i = 0; bool r = (i++ > 5) && (i++ > 5); return i; }'), 2);
    assert.equal(ret('int main(){ int i = 0; bool r = (i++ >= 0) || (i++ > 5); return i; }'), 2);
    assert.equal(ret('int main(){ int x = 0; int y = 0; bool b = true; '
        + 'b ? (x = 1) : (y = 2); return x * 10 + y; }'), 12);
    assert.equal(ret('int main(){ int x = 0; int y = 0; bool b = false; '
        + 'int r = b ? (x = 1) : (y = 2); return r * 100 + x * 10 + y; }'), 212);
    assert.equal(ret('int main(){ int a = 3; int b = 0; int c = (b != 0) ? a / b : a; return c; }'),
        3);
});

test('static globals and locals', ()=>{
    const src = `
static float counter = 5;
static float2 pair = float2(1, 2);
static const int N = 3;
static float table[N] = { 1, 2, 3 };
float next(){ static float n = 0; n += 1; return n; }
float main(){
    counter += 1;
    pair.y += counter;
    next(); next();
    return counter * 1000 + pair.y * 100 + next() * 10 + table[2];
}`;
    const module = load(src);
    const evaluator = createEvaluator(module, { uniform: ()=>0 });
    const main = /** @type {any} */ (module.findFunction('main'));
    const expected = 6 * 1000 + 8 * 100 + 3 * 10 + 3;
    assert.equal(evaluator.call(main, []).result, expected);
    assert.equal(evaluator.call(main, []).result, expected);
});

test('static const values fold through other constants', ()=>{
    assert.equal(ret(`static const float2 k = float2(0.5, 4);
        static const int N = 1;
        static const float d = k.y * 2 + N;
        float main(){ return d; }`), 9);
    const module = load(`static const int N = 3; static const int M = N * N + 1;
        float t[M]; float main(){ return 0; }`);
    const by = Object.fromEntries(module.globals.map(g=>[g.name, g]));
    assert.equal(by.M.constValue, 10);
    assert.equal(by.t.type.kind === 'array' && by.t.type.length, 10);
});

test('uniforms are read lazily, once, and converted to their types', ()=>{
    /** @type {string[]} */
    const asked = [];
    const env = { uniform: (/** @type {any} */ sym)=>{
        asked.push(sym.name);
        const table = /** @type {Record<string, any>} */ ({ c0: [0.1, 0.2, 0.3, 0.4], k: 0.1,
            arr: [1, 2, 3], m: [[1, 2], [3, 4]], i: 2.9 });
        if (!(sym.name in table))
        {
            throw new Error(`no value for ${sym.name}`);
        }
        return table[sym.name];
    } };
    const src = `
float4 c0; float4 c1; float k; float arr[3]; float2x2 m; int i;
float4 main(){ return c0 + c0 * k + arr[1] + m[1][0] + i; }`;
    const r = exec(src, [], env);
    assert.deepEqual(asked, ['c0', 'k', 'arr', 'm', 'i']);
    const base = [0.1, 0.2, 0.3, 0.4].map(f32);
    const expected = base.map(x=>f32(f32(f32(f32(x + f32(x * f32(0.1))) + 2) + 3) + 2));
    assert.deepEqual(r.result, expected);
    assert.throws(()=>exec('float4 c1; float4 main(){ return c1; }', [], env), /no value for c1/);
    assert.throws(()=>exec('float4 c1; float4 main(){ return c1; }'), /no value for c1/);
});

test('uniform parameters of the entry point come from the environment', ()=>{
    const src = `float4 main(float4 p : POSITION, uniform float4 k, float s) : COLOR
        { return p * k * s; }`;
    const env = { uniform: (/** @type {any} */ sym)=>sym.name === 'k' ? [1, 2, 3, 4] : 0.5 };
    assert.deepEqual(ret(src, { p: [1, 1, 1, 1] }, env), [0.5, 1, 1.5, 2]);
    assert.deepEqual(ret(src, { p: [1, 1, 1, 1], k: [2, 2, 2, 2], s: 1 }, env), [2, 2, 2, 2]);
});

test('discard and clip record the kill and execution goes on', ()=>{
    const src = `float4 main(float x : TEXCOORD0) : COLOR {
        if (x < 0) discard;
        float4 c = x * 2;
        return c;
    }`;
    const live = exec(src, [1]);
    assert.equal(live.killed, false);
    assert.deepEqual(live.result, [2, 2, 2, 2]);
    const dead = exec(src, [-1]);
    assert.equal(dead.killed, true);
    assert.deepEqual(dead.result, [-2, -2, -2, -2]);
    const clipped = exec(`float4 main(float x : TEXCOORD0) : COLOR { clip(x); return x + 1; }`,
        [-0.5]);
    assert.equal(clipped.killed, true);
    assert.deepEqual(clipped.result, [0.5, 0.5, 0.5, 0.5]);
    assert.equal(exec(`float4 main(float3 x : TEXCOORD0) : COLOR { clip(x); return 1; }`,
        [[1, 0, 2]]).killed, false);
    assert.equal(exec(`float4 main(float3 x : TEXCOORD0) : COLOR { clip(x); return 1; }`,
        [[1, 0, -2]]).killed, true);
});

test('killed does not stick between runs', ()=>{
    const module = load('float4 main(float x : TEXCOORD0) : COLOR { clip(x); return 1; }');
    const evaluator = createEvaluator(module, {});
    const main = /** @type {any} */ (module.findFunction('main'));
    assert.equal(evaluator.call(main, [-1]).killed, true);
    assert.equal(evaluator.call(main, [1]).killed, false);
});

test('texture sampling and derivatives go through the environment', ()=>{
    /** @type {any[]} */
    const calls = [];
    /** @type {(sym: any, op: string, mode: any, coords: number[], extra: any) => number[]} */
    const sample = (sym, op, mode, coords, extra)=>{
        calls.push([sym.name, op, mode, coords, extra]);
        return [1, 2, 3, 4];
    };
    const env = {
        sample,
        derivative: (/** @type {string} */ axis, /** @type {any} */ value)=>
            Array.isArray(value) ? value.map(x=>axis === 'x' ? x * 2 : x * 3)
                : value * (axis === 'x' ? 2 : 3),
    };
    const r = exec(`
sampler2D s0; samplerCUBE sc;
float4 fetch(sampler2D s, float2 uv){ return tex2D(s, uv); }
float4 main(float2 uv : TEXCOORD0, float3 d : TEXCOORD1) : COLOR {
    float4 a = tex2D(s0, uv) * 2;
    float4 b = fetch(s0, uv + 1);
    float4 c = texCUBE(sc, d);
    float4 e = tex2Dlod(s0, float4(uv, 0, 2));
    float4 g = tex2Dproj(s0, float4(uv * 2, 0, 2));
    float2 dx = ddx(uv);
    float w = fwidth(uv.x);
    return a + b + c + e + g + float4(dx, w, 0);
}`, [[0.25, 0.5], [0, 1, 0]], env);
    assert.deepEqual(r.result, [6.5, 13, 19.25, 24]);
    assert.deepEqual(calls.map(c=>c.slice(0, 3)), [['s0', 'tex2D', 'plain'],
        ['s0', 'tex2D', 'plain'], ['sc', 'texCUBE', 'plain'], ['s0', 'tex2D', 'lod'],
        ['s0', 'tex2D', 'plain']]);
    assert.deepEqual(calls[0][3], [0.25, 0.5]);
    assert.deepEqual(calls[1][3], [1.25, 1.5]);
    assert.deepEqual(calls[2][3], [0, 1, 0]);
    assert.deepEqual(calls[3][3], [0.25, 0.5]);
    assert.deepEqual(calls[3][4], { value: 2 });
    assert.deepEqual(calls[4][3], [0.25, 0.5]);
});

const SKIN = `
float4x4 bones[4];
float4x4 viewproj;
struct VS_IN {
    float4 pos : POSITION; float4 weights : BLENDWEIGHT; int4 idx : BLENDINDICES;
    float3 n : NORMAL; float2 uv : TEXCOORD0;
};
struct VS_OUT { float4 pos : POSITION; float3 n : TEXCOORD1; float2 uv : TEXCOORD0; };
VS_OUT main(VS_IN i)
{
    float4 p = 0;
    float3 n = 0;
    for (int k = 0; k < 2; k++)
    {
        float4x4 b = bones[i.idx[k]];
        p += mul(i.pos, b) * i.weights[k];
        n += mul(i.n, (float3x3)b) * i.weights[k];
    }
    VS_OUT o;
    o.pos = mul(p, viewproj);
    o.n = normalize(n);
    o.uv = i.uv;
    return o;
}`;

/** A translation in the row-vector convention. @param {number[]} t */
const translate = t=>[[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [t[0], t[1], t[2], 1]];
const IDENTITY = translate([0, 0, 0]);

test('a skinning vertex shader', ()=>{
    const uniforms = /** @type {Record<string, any>} */ ({
        bones: [translate([1, 0, 0]), translate([0, 2, 0]), IDENTITY, IDENTITY],
        viewproj: IDENTITY,
    });
    const r = exec(SKIN, [{ pos: [1, 1, 1, 1], weights: [0.75, 0.25, 0, 0], idx: [0, 1, 0, 0],
        n: [0, 0, 1], uv: [0.5, 0.25] }], { uniform: sym=>uniforms[sym.name] });
    assert.deepEqual(r.result, { pos: [1.75, 1.5, 1, 1], n: [0, 0, 1], uv: [0.5, 0.25] });
    // A view-projection that scales and moves: the transformed position goes through it.
    uniforms.viewproj = [[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]];
    const scaled = exec(SKIN, [{ pos: [1, 1, 1, 1], weights: [1, 0, 0, 0], idx: [0, 0, 0, 0],
        n: [0, 3, 4], uv: [0, 0] }], { uniform: sym=>uniforms[sym.name] });
    assert.deepEqual(/** @type {any} */ (scaled.result).pos, [4, 2, 2, 1]);
    close(/** @type {any} */ (scaled.result).n, [0, 0.6, 0.8]);
});

test('a lit, textured pixel shader', ()=>{
    const src = `
sampler2D diffuse;
float3 lightDir; float3 lightCol; float3 ambient;
float4 main(float2 uv : TEXCOORD0, float3 n : TEXCOORD1) : COLOR
{
    float4 albedo = tex2D(diffuse, uv);
    float ndl = saturate(dot(normalize(n), -lightDir));
    float3 c = albedo.rgb * (ambient + lightCol * ndl);
    return float4(c, albedo.a);
}`;
    const table = /** @type {Record<string, any>} */ ({ lightDir: [0, -1, 0],
        lightCol: [0.5, 0.25, 0.5], ambient: [0.1, 0.1, 0.1] });
    /** @type {any[]} */
    const taps = [];
    /** @type {(sym: any, op: string, mode: any, coords: number[]) => number[]} */
    const sample = (sym, op, mode, coords)=>{
        taps.push([sym.name, op, mode, coords]);
        return [0.5, 0.25, 1, 0.5];
    };
    const env = { uniform: (/** @type {any} */ sym)=>table[sym.name], sample };
    const lit = exec(src, [[0.25, 0.75], [0, 2, 0]], env);
    close(lit.result, [0.5 * 0.6, 0.25 * 0.35, 0.6, 0.5], 1e-6);
    assert.deepEqual(taps, [['diffuse', 'tex2D', 'plain', [0.25, 0.75]]]);
    const back = exec(src, [[0, 0], [0, -2, 0]], env);
    close(back.result, [0.05, 0.025, 0.1, 0.5], 1e-6);
});

test('lighting with out parameters and nested calls', ()=>{
    const src = `
void lighting(float3 n, float3 l, float3 v, float shininess, out float diff, out float spec)
{
    diff = saturate(dot(n, l));
    float3 h = normalize(l + v);
    spec = diff > 0 ? pow(saturate(dot(n, h)), shininess) : 0;
}
float4 main(float3 n : TEXCOORD0, float3 l : TEXCOORD1, float3 v : TEXCOORD2) : COLOR
{
    float d, s;
    lighting(normalize(n), normalize(l), normalize(v), 8, d, s);
    return float4(d, s, d * s, lit(d, s, 2).z);
}`;
    const straight = exec(src, [[0, 0, 1], [0, 0, 2], [0, 0, 3]]);
    close(straight.result, [1, 1, 1, 1]);
    const away = exec(src, [[0, 0, 1], [0, 0, -1], [0, 0, 1]]);
    close(away.result, [0, 0, 0, 0]);
    const slanted = /** @type {number[]} */ (exec(src, [[0, 0, 1], [1, 0, 1], [0, 0, 1]]).result);
    const d = Math.SQRT1_2;
    const h = [Math.SQRT1_2 + 0, 0, Math.SQRT1_2 + 1];
    const hl = Math.hypot(h[0], h[1], h[2]);
    const s = Math.pow(h[2] / hl, 8);
    close(slanted, [d, s, d * s, Math.pow(s, 2)], 1e-5);
});

test('intrinsics through the language', ()=>{
    /** @type {[string, string, any][]} */
    const cases = [
        ['float', 'saturate(1.5) + saturate(-1) + saturate(0.25)', 1.25],
        ['int', 'max(3, 4) + min(3, 4) + abs(-2) + clamp(9, 0, 5) + sign(-7)', 13],
        ['float3', 'lerp(float3(0, 0, 0), float3(10, 20, 30), 0.5)', [5, 10, 15]],
        ['float', 'dot(float3(1, 2, 3), float3(4, 5, 6))', 32],
        ['float3', 'cross(float3(1, 0, 0), float3(0, 1, 0))', [0, 0, 1]],
        ['float', 'length(float2(3, 4))', 5],
        ['float4', 'float4(frac(1.75), floor(-1.5), ceil(-1.5), round(2.5))', [0.75, -2, -1, 3]],
        ['float4', 'step(float4(0, 1, 2, 3), 2)', [1, 1, 1, 0]],
        ['float2', 'smoothstep(0, 1, float2(0.25, 2))', [0.15625, 1]],
        ['float', 'pow(2, 10) + exp2(3) + log2(8) + sqrt(16) + rsqrt(4)', 1024 + 8 + 3 + 4 + 0.5],
        ['bool', 'all(float3(1, 2, 3)) && any(float3(0, 0, 1)) && !all(float2(1, 0))', 1],
        ['float2', 'mul(float2x2(0, 1, -1, 0), float2(1, 0))', [0, -1]],
        ['float4', 'D3DCOLORtoUBYTE4(float4(1, 0.5, 0, 0.2))', [0, 127, 255, 51]],
        ['float', 'determinant(float3x3(2, 0, 0, 0, 3, 0, 0, 0, 4))', 24],
        ['float4', 'lit(0.5, 0.5, 2)', [1, 0.5, 0.25, 1]],
        ['float3', 'reflect(float3(1, -1, 0), float3(0, 1, 0))', [1, 1, 0]],
        ['float', 'fmod(5.5, 2)', 1.5],
        ['float2', 'float2(isnan(0.0 / 0.0), isinf(1.0 / 0.0))', [1, 1]],
        ['float3', 'abs(int3(-1, 2, -3))', [1, 2, 3]],
    ];
    for (const [type, text, expected] of cases)
    {
        const got = val(type, text);
        if (type === 'float4' && text.startsWith('D3D'))
        {
            assert.deepEqual(got.map((/** @type {number} */ x)=>x), expected, text);
        }
        else
        {
            close(got, expected, 1e-6);
        }
    }
});

test('intrinsic out parameters in the language', ()=>{
    assert.deepEqual(ret(`float2 main(){ float ip; float fr = modf(-3.75, ip);
        return float2(ip, fr); }`), [-3, -0.75]);
    assert.deepEqual(ret(`float3 main(){ float e; float m = frexp(10.0, e);
        return float3(m, e, 0); }`), [0.625, 4, 0]);
    assert.deepEqual(ret(`float2 main(){ float s, c; sincos(0.0, s, c);
        return float2(s, c); }`), [0, 1]);
    assert.deepEqual(ret(`float4 main(){ float4 v = 0; float2 s, c; sincos(float2(0, 0), s, c);
        v.xy = c; v.zw = s; return v; }`), [1, 1, 0, 0]);
    assert.deepEqual(ret(`int main(){ int i; float f = modf(2.5, i);
        return i * 10 + (int)(f * 10); }`), 25);
});

test('evaluateConstant', ()=>{
    const module = load(`
static const int N = 3;
float u;
float g(){ return 1; }
void main(){ N * 2; u; g(); sin(0); N > 2 ? 1 : 2; float3(1, 2, 3).zy; }`);
    const evaluator = createEvaluator(module, {});
    const stmts = /** @type {any} */ (module.findFunction('main')).decl.body.stmts;
    const values = stmts.map((/** @type {any} */ s)=>evaluator.evaluateConstant(s.expr));
    assert.deepEqual(values, [6, undefined, undefined, 0, 1, [3, 2]]);
    assert.equal(evaluator.evaluateConstant({ kind: 'num', value: 1 }), undefined);
});

test('a local that is declared without a value is zero', ()=>{
    assert.deepEqual(ret('float4 main(){ float4 v; return v; }'), [0, 0, 0, 0]);
    assert.equal(ret('int main(){ int a; return a; }'), 0);
    assert.deepEqual(ret('float2 main(){ float a[2]; return float2(a[0], a[1]); }'), [0, 0]);
});

test('returning a struct copies it', ()=>{
    const r = exec(`
struct S { float a; float3 b[2]; };
static S g;
S main(){ g.a = 1; g.b[1] = float3(1, 2, 3); S l = g; g.a = 2; g.b[1].x = 5; return l; }`);
    assert.deepEqual(r.result, { a: 1, b: [[0, 0, 0], [1, 2, 3]] });
});

test('a number cast to a structure or an array fills it', ()=>{
    const src = `struct S { float a; int b; float2 c; };
        S main(){ S s = (S)1.5; return s; }`;
    assert.deepEqual(ret(src), { a: 1.5, b: 1, c: [1.5, 1.5] });
    assert.deepEqual(ret('struct S { float a; float3 v; }; S main(){ return (S)0; }'),
        { a: 0, v: [0, 0, 0] });
    assert.deepEqual(ret('struct S { float a; float3 v; };'
        + ' S main(){ return (S)float4(1, 2, 3, 4); }'), { a: 1, v: [2, 3, 4] });
});
