/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as math from './hlsl-math.js';

/**
 * A seeded generator, so a failure names inputs that come back.
 *
 * @param {number} seed
 */
function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Fifty-three random bits: a value of 32 sits on a float's rounding midpoint
 * one time in 256, and log(exp(y)) gives y back.
 *
 * @param {() => number} bits32
 */
function fine(bits32){
    return ()=>bits32() + bits32() / 4294967296;
}

/** @type {[string, (...args: number[]) => number, (...args: number[]) => number, () => number[]][]} */
const CASES = [];
const next = fine(random(1));
/** @param {number} low @param {number} high */
const between = (low, high)=>()=>[low + (high - low) * next()];
CASES.push(['sin', math.sin, Math.sin, between(-1000, 1000)]);
CASES.push(['cos', math.cos, Math.cos, between(-1000, 1000)]);
CASES.push(['tan', math.tan, Math.tan, between(-1.5, 1.5)]);
CASES.push(['asin', math.asin, Math.asin, between(-1, 1)]);
CASES.push(['acos', math.acos, Math.acos, between(-1, 1)]);
CASES.push(['atan', math.atan, Math.atan, between(-100, 100)]);
CASES.push(['atan2', math.atan2, Math.atan2, ()=>[next() * 20 - 10, next() * 20 - 10]]);
CASES.push(['exp', math.exp, Math.exp, between(-80, 80)]);
CASES.push(['exp2', math.exp2, x=>Math.pow(2, x), between(-120, 120)]);
CASES.push(['log', math.log, Math.log, ()=>[Math.exp(next() * 160 - 80)]]);
CASES.push(['log2', math.log2, Math.log2, ()=>[Math.exp(next() * 160 - 80)]]);
CASES.push(['log10', math.log10, Math.log10, ()=>[Math.exp(next() * 160 - 80)]]);
CASES.push(['pow', math.pow, Math.pow, ()=>[next() * 50, next() * 16 - 8]]);
CASES.push(['sinh', math.sinh, Math.sinh, between(-20, 20)]);
CASES.push(['cosh', math.cosh, Math.cosh, between(-20, 20)]);
CASES.push(['tanh', math.tanh, Math.tanh, between(-10, 10)]);

test('each function agrees with Math to a few units in a double\'s last place', ()=>{
    for (const [name, ours, reference, input] of CASES)
    {
        let worst = 0;
        let floatsApart = 0;
        for (let i = 0; i < 20000; i++)
        {
            const args = input();
            const a = ours(...args);
            const b = reference(...args);
            const error = Math.abs(a - b) / Math.max(Math.abs(b), 1e-300);
            // Near a zero of sin, cos or tan the relative error is the
            // reduction's absolute one over a tiny answer.
            if (Math.abs(b) > 1e-6)
            {
                worst = Math.max(worst, error);
            }
            floatsApart += Math.fround(a) !== Math.fround(b) ? 1 : 0;
        }
        assert.ok(worst < 2e-15, `${name}: worst relative error ${worst}`);
        assert.ok(floatsApart <= 4, `${name}: ${floatsApart} of 20000 round to another float`);
    }
});

test('the special values are Math\'s', ()=>{
    const values = [NaN, Infinity, -Infinity, 0, -0, 1, -1, 0.5, -0.5, 2, -2, 1e-310, -1e-310,
        1e308];
    const one = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'exp', 'log', 'log2', 'log10',
        'sinh', 'cosh', 'tanh'];
    for (const name of one)
    {
        const ours = /** @type {(x: number) => number} */ (/** @type {any} */ (math)[name]);
        const reference = /** @type {(x: number) => number} */ (/** @type {any} */ (Math)[name]);
        for (const x of values)
        {
            const a = ours(x);
            const b = reference(x);
            if (Number.isNaN(b) || !Number.isFinite(b) || b === 0)
            {
                assert.ok(Object.is(a, b), `${name}(${x}) is ${a}, Math says ${b}`);
            }
        }
    }
    for (const x of values)
    {
        for (const y of values)
        {
            for (const [name, ours, reference] of /** @type {const} */ ([
                ['pow', math.pow, Math.pow], ['atan2', math.atan2, Math.atan2]]))
            {
                const a = ours(x, y);
                const b = reference(x, y);
                if (Number.isNaN(b) || !Number.isFinite(b) || b === 0)
                {
                    assert.ok(Object.is(a, b), `${name}(${x}, ${y}) is ${a}, Math says ${b}`);
                }
                else
                {
                    // pow's error grows with |y log2 x|: at 1e-310 squared
                    // it is still nine digits inside a float.
                    assert.ok(Math.abs(a - b) <= Math.abs(b) * 1e-14, `${name}(${x}, ${y})`);
                }
            }
        }
    }
});

test('powers of two and whole exponents come out exact', ()=>{
    for (let k = -1074; k <= 1023; k++)
    {
        assert.equal(math.exp2(k), 2 ** k, `exp2(${k})`);
    }
    for (let k = -1022; k <= 1023; k++)
    {
        assert.equal(math.log2(2 ** k), k, `log2(2^${k})`);
    }
    assert.equal(math.pow(3, 4), 81);
    assert.equal(math.pow(-2, 3), -8);
    assert.equal(math.pow(10, -2), 1 / 100);
    assert.equal(math.exp(0), 1);
    assert.equal(math.log(1), 0);
});

test('the answers are fixed bits, the same on every engine and processor', ()=>{
    // Made of correctly rounded operations, the results cannot move between
    // machines; these pin them, so a change to an algorithm is seen as one.
    const bits = (/** @type {number} */ x)=>{
        const view = new DataView(new ArrayBuffer(8));
        view.setFloat64(0, x);
        return view.getBigUint64(0).toString(16);
    };
    assert.deepEqual([
        math.sin(1), math.cos(1), math.tan(1), math.atan(0.5), math.asin(0.3), math.acos(0.3),
        math.exp(1), math.log(10), math.log2(10), math.log10(2), math.pow(1.5, 2.5),
        math.sinh(0.25), math.cosh(3), math.tanh(0.75), math.atan2(-1, -3), math.exp2(0.5),
    ].map(bits), GOLDEN);
});

const GOLDEN = [
    '3feaed548f090cee', '3fe14a280fb5068c', '3ff8eb245cbee3a5', '3fddac670561bb4f',
    '3fd380159e14f6fe', '3ff441f5ecbeef59', '4005bf0a8b14576a', '40026bb1bbb55515',
    '400a934f0979a371', '3fd34413509f79ff', '40060b9fd68a4555', '3fd02accd9d08102',
    '402422a497d6185e', '3fe45323e552f228', 'c0068f095fdf593c', '3ff6a09e667f3bcc',
];
