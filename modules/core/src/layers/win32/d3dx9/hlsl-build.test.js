/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBuilder } from './hlsl-build.js';
import { assemble } from './hlsl-backend.js';
import { USAGE, profileOf } from './hlsl-ir.js';
import { execute, disassemble } from './d3d9-machine.fixture.js';

const PROFILES = ['vs_1_1', 'vs_2_0', 'vs_3_0', 'ps_2_0', 'ps_2_a', 'ps_3_0'];

const f32 = Math.fround;

/**
 * A seeded generator of numbers in [-4, 4), quarters, so that ties happen.
 *
 * @param {number} seed
 */
function generator(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return f32(Math.round(((state >>> 8) / (1 << 24) * 8 - 4) * 4) / 4);
    };
}

const bits = new DataView(new ArrayBuffer(4));
/** Distance in units in the last place. @param {number} a @param {number} b */
function ulps(a, b){
    if (Number.isNaN(a) || Number.isNaN(b))
    {
        return Number.isNaN(a) && Number.isNaN(b) ? 0 : Infinity;
    }
    if (a === b)
    {
        return 0;
    }
    const order = (/** @type {number} */ x)=>{
        bits.setFloat32(0, x);
        const word = bits.getInt32(0);
        return word < 0 ? -(word & 0x7fffffff) : word;
    };
    return Math.abs(order(a) - order(b));
}

/**
 * Builds one expression for a profile, assembles it, runs it on the machine.
 *
 * @param {string} name
 * @param {(b: ReturnType<typeof createBuilder>, a: import('./hlsl-build.js').Vec,
 *     c: import('./hlsl-build.js').Vec) => import('./hlsl-build.js').Vec} body
 * @param {number[]} inputA @param {number[]} inputB
 */
function run(name, body, inputA, inputB){
    const profile = /** @type {import('./hlsl-ir.js').Profile} */ (profileOf(name));
    const b = createBuilder(profile);
    const ia = b.input(USAGE.TEXCOORD, 0, 4);
    const ib = b.input(USAGE.TEXCOORD, 1, 4);
    const a = b.vec({ kind: 'input', input: ia, swz: [0, 1, 2, 3] });
    const c = b.vec({ kind: 'input', input: ib, swz: [0, 1, 2, 3] });
    const result = body(b, a, c);
    const out = b.output(USAGE.COLOR, 0, 4);
    b.write(out, result);
    const assembled = assemble({ profile, instrs: b.instrs, inputs: b.inputs,
        outputs: b.outputs, constants: b.constants, vregCount: b.vregCount });
    assert.deepEqual(assembled.diagnostics, [], name);
    const tokens = /** @type {Uint32Array} */ (assembled.tokens);
    /** @type {Record<string, number[][]>} */
    const inputs = { v: [], t: [] };
    for (const [input, value] of [[ia, inputA], [ib, inputB]])
    {
        const one = /** @type {import('./hlsl-ir.js').Input} */ (input);
        inputs[one.file ?? 'v'][one.reg ?? 0] = /** @type {number[]} */ (value);
    }
    const key = profile.kind === 'ps' ? 'oC0' : profile.major >= 3 ? 'o0' : 'oD0';
    try
    {
        const answer = execute(tokens, { constants: { f: [] }, inputs }).outputs[key];
        return answer.slice(0, result.w);
    }
    catch (e){
        throw new Error(`${name}: ${/** @type {Error} */ (e).message}\n${disassemble(tokens)}`,
            { cause: e });
    }
}

/**
 * Every profile, a few inputs: the machine's answer against a model computed
 * in JavaScript.
 *
 * @param {string} what
 * @param {(b: any, a: any, c: any) => any} body
 * @param {(a: number[], c: number[]) => number[]} model
 * @param {{ ulp?: number, absolute?: number, positive?: boolean, profiles?: string[] }} [options]
 */
function check(what, body, model, options = {}){
    test(what, ()=>{
        const next = generator(what.length * 7919);
        for (const name of options.profiles ?? PROFILES)
        {
            for (let round = 0; round < 6; round++)
            {
                const a = [next(), next(), next(), next()];
                const c = [next(), next(), next(), next()];
                // Some lanes equal, for the comparisons that tie.
                c[round % 4] = a[round % 4];
                if (options.positive)
                {
                    a.forEach((v, i)=>{
                        a[i] = f32(Math.abs(v) + 0.25);
                    });
                    c.forEach((v, i)=>{
                        c[i] = f32(Math.abs(v) + 0.25);
                    });
                }
                const got = run(name, body, a, c);
                const want = model(a, c).map(f32);
                got.forEach((value, i)=>{
                    const close = Math.abs(value - want[i]) <= (options.absolute ?? 0)
                        || ulps(value, want[i]) <= (options.ulp ?? 0);
                    assert.ok(close, `${name} ${what} lane ${i}: ${value} != ${want[i]} for `
                        + `${a} ${c}`);
                });
            }
        }
    });
}

/**
 * @param {number[]} a @param {number[]} c
 * @param {(x: number, y: number, i: number) => number} f
 */
const each = (a, c, f)=>a.map((x, i)=>f(x, c[i], i));

check('add, sub, mul', (b, a, c)=>b.mul(b.sub(b.add(a, c), c), c),
    (a, c)=>each(a, c, (/** @type {number} */ x, /** @type {number} */ y)=>
        f32(f32(f32(x + y) - y) * y)));
check('mad', (b, a, c)=>b.mad(a, c, b.neg(a)), (a, c)=>each(a, c, (x, y)=>f32(f32(x * y) - x)));
check('min and max with swizzles', (b, a, c)=>b.max(b.min(a, b.swizzle(c, [3, 2, 1, 0])), c),
    (a, c)=>each(a, c, (x, y, i)=>Math.max(Math.min(x, c[3 - i]), y)));
check('absolute value and negation of an operand', (b, a, c)=>b.mul(b.abs(a), b.neg(b.abs(c))),
    (a, c)=>each(a, c, (x, y)=>f32(Math.abs(x) * -Math.abs(y))));
check('a scalar splat against a vector', (b, a, c)=>b.add(b.lane(a, 2), c),
    (a, c)=>c.map(y=>f32(a[2] + y)));
check('dot products of two, three and four lanes', (b, a, c)=>b.cat([
    b.dot(b.swizzle(a, [0, 1]), b.swizzle(c, [0, 1])), b.dot(b.swizzle(a, [0, 1, 2]),
        b.swizzle(c, [0, 1, 2])), b.dot(a, c)]),
(a, c)=>[a[0] * c[0] + a[1] * c[1], a[0] * c[0] + a[1] * c[1] + a[2] * c[2],
    a[0] * c[0] + a[1] * c[1] + a[2] * c[2] + a[3] * c[3]]);
check('reciprocal, square root, division', (b, a, c)=>b.cat([b.rcp(b.lane(a, 0)),
    b.sqrt(b.abs(b.lane(a, 1))), b.div(b.lane(c, 1), b.lane(a, 1))]),
(a, c)=>[1 / a[0], Math.sqrt(Math.abs(a[1])), c[1] / a[1]], { ulp: 2, positive: true });
check('exp2 and log2', (b, a)=>b.cat([b.exp2(b.lane(a, 0)), b.log2(b.abs(b.lane(a, 1)))]),
    a=>[2 ** a[0], Math.log2(Math.abs(a[1]))], { ulp: 2 });
check('lt, le, gt, ge', (b, a, c)=>b.lt(a, c), (a, c)=>each(a, c, (x, y)=>(x < y ? 1 : 0)));
check('less or equal', (b, a, c)=>b.le(a, c), (a, c)=>each(a, c, (x, y)=>(x <= y ? 1 : 0)));
check('greater', (b, a, c)=>b.gt(a, c), (a, c)=>each(a, c, (x, y)=>(x > y ? 1 : 0)));
check('greater or equal', (b, a, c)=>b.ge(a, c), (a, c)=>each(a, c, (x, y)=>(x >= y ? 1 : 0)));
check('equal', (b, a, c)=>b.eq(a, c), (a, c)=>each(a, c, (x, y)=>(x === y ? 1 : 0)));
check('not equal', (b, a, c)=>b.ne(a, c), (a, c)=>each(a, c, (x, y)=>(x !== y ? 1 : 0)));
check('select between two vectors', (b, a, c)=>b.select(b.lt(a, c), a, b.neg(c)),
    (a, c)=>each(a, c, (x, y)=>(x < y ? x : -y)));
check('select on a scalar condition', (b, a, c)=>b.select(b.lt(b.lane(a, 0), b.lane(c, 0)),
    a, c), (a, c)=>(a[0] < c[0] ? a : c));
check('and, or, not on truths', (b, a, c)=>b.and(b.not(b.lt(a, c)), b.or(b.gt(a, c),
    b.eq(a, c))), (a, c)=>each(a, c, (x, y)=>(x >= y ? 1 : 0)));
check('floor, ceil, trunc', (b, a)=>b.cat([b.floor(b.lane(a, 0)), b.ceil(b.lane(a, 1)),
    b.trunc(b.lane(a, 2)), b.trunc(b.lane(a, 3))]),
a=>[Math.floor(a[0]), Math.ceil(a[1]), Math.trunc(a[2]), Math.trunc(a[3])]);
check('saturate', (b, a)=>b.sat(a), a=>a.map(x=>Math.min(1, Math.max(0, x))));
check('a vector built from lanes of two inputs and a literal', (b, a, c)=>b.cat([
    b.lane(a, 3), b.lane(c, 0), b.imm([0.5]), b.lane(a, 1)]), (a, c)=>[a[3], c[0], 0.5, a[1]]);
check('literal operations are done at build time', (b, a)=>b.add(b.mul(b.imm([2, 3]),
    b.imm([4, 5])), b.lane(a, 0)), a=>[8 + a[0], 15 + a[0]]);
check('sine and cosine', (b, a)=>{
    const { cos, sin } = b.sincos(b.swizzle(a, [0, 1]));
    return b.cat([cos, sin]);
}, a=>[Math.cos(a[0]), Math.cos(a[1]), Math.sin(a[0]), Math.sin(a[1])],
{ absolute: 2e-5 });
