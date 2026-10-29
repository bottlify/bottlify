/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { longFloatResults, readSingle, returningSingle, setSingle } from './float.js';
import { guestExport } from './guest-code.js';
import { COMPILED as FLOAT_CODE } from './inguest-float.x86.js';
import { COMPILED as MATH_CODE } from './inguest-math.x86.js';

test('a 64-bit process\'s results are left in XMM0: a double whole, a float its low lane', ()=>{
    /** @type {[number, number[]][]} */
    const written = [];
    const results = longFloatResults((index, words)=>written.push([index, [...words]]));
    results.setResult(1.5);
    results.setSingleResult?.(0.1);
    assert.deepEqual(written, [
        [0, [0, 0x3ff80000, 0, 0]],
        [0, [0x3dcccccd, 0, 0, 0]],
    ]);
});

test('a float result goes to ST(0) unrounded where nothing else takes it', ()=>{
    /** @type {number[]} */
    const st0 = [];
    const fpu = { setResult: (/** @type {number} */ value)=>st0.push(value),
        get: ()=>0, pop: ()=>{} };
    setSingle(fpu, 0.1);
    const entry = returningSingle(fpu, 4, args=>readSingle(args, 0) * 2, { 0: 'f32' });
    assert.deepEqual(entry.floats, { 0: 'f32' });
    entry.handler([0x3f800000]);
    assert.deepEqual(st0, [0.1, 2]);
});

test('the runtime\'s code says where a 64-bit caller passes its floating-point arguments', ()=>{
    // From the types the build recorded: a double is two dwords of the 32-bit
    // signature, an x87 argument none, anything else one.
    const fallback = { argBytes: 0, handler: ()=>0 };
    assert.deepEqual(guestExport(FLOAT_CODE._nextafter, fallback).floats,
        { 0: 'f64', 2: 'f64' });
    assert.deepEqual(guestExport(FLOAT_CODE._logb, fallback).floats, { 0: 'f64' });
    assert.deepEqual(guestExport(FLOAT_CODE._copysign, fallback).floats, { 0: 'f64' },
        'a double the code reads as two integers is not one by its types');
    assert.equal(guestExport(FLOAT_CODE._statusfp, fallback).floats, undefined);
    const onStack = Object.values(MATH_CODE).filter(entry=>
        /** @type {readonly string[]} */ (entry.params).includes('x87'));
    assert.ok(onStack.length > 0);
    for (const compiled of onStack)
    {
        assert.equal(guestExport(/** @type {any} */ (compiled), fallback).floats, undefined,
            'an x87 argument is on the floating-point stack, in no slot');
    }
});
