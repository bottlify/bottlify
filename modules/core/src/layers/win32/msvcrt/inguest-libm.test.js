/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The float functions inguest.js computes by series rather than by one x87
 * instruction, held to the exact result rounded to a float: within one step
 * of a float over the range the guest code answers itself.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expf, logf } from './inguest.js';

const view = new DataView(new ArrayBuffer(4));
/** @param {number} x */
const floatBits = x=>{
    view.setFloat32(0, x, true);
    return view.getUint32(0, true);
};
/** @param {number} bits */
const floatOfBits = bits=>{
    view.setUint32(0, bits >>> 0, true);
    return view.getFloat32(0, true);
};
const HOST = Symbol('host');
const guest = /** @type {any} */ ({ floatBits, floatOfBits, host: ()=>HOST });

/**
 * @param {(guest: any, x: number) => any} fn @param {(x: number) => number} exact
 * @param {number} from @param {number} to  the float bit patterns walked
 */
function within(fn, exact, from, to){
    let worst = 0;
    let answered = 0;
    const step = Math.max(1, Math.floor((to - from) / 400000));
    for (let bits = from; bits <= to; bits += step)
    {
        const x = floatOfBits(bits);
        const got = fn(guest, x);
        if (got === HOST)
        {
            continue;
        }
        answered++;
        const ulps = Math.abs(floatBits(got) - floatBits(Math.fround(exact(x))));
        worst = Math.max(worst, ulps);
    }
    return { worst, answered };
}

test('logf is within a float\'s step of the logarithm over the positive normal floats', ()=>{
    const { worst, answered } = within(logf, Math.log, 0x00800000, 0x7f7fffff);
    assert.ok(answered > 300000, 'the guest code answers the normal floats itself');
    assert.ok(worst <= 1, `worst ${worst} steps`);
});

test('expf is within a float\'s step of the exponential up to |x| = 87', ()=>{
    for (const [from, to] of [[0, 0x42ae0000], [0x80000000, 0xc2ae0000]])
    {
        const { worst, answered } = within(expf, Math.exp, from, to);
        assert.ok(answered > 300000);
        assert.ok(worst <= 1, `worst ${worst} steps from 0x${from.toString(16)}`);
    }
    assert.equal(expf(guest, 88), HOST, 'past 87 the host answers, with errno where it overflows');
    assert.equal(expf(guest, NaN), HOST);
});
