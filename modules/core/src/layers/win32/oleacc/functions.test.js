/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOleaccFunctions } from './functions.js';

test('the calls MFC links are there, and fail the documented way when reached', ()=>{
    // An installer's MFC helper library would not load without them.
    const bytes = new Uint8Array(0x100).fill(0xcc);
    /** @type {string[]} */
    const said = [];
    const fns = createOleaccFunctions({
        writeMemory: (address, data)=>bytes.set(data, address),
        divergence: api=>said.push(api),
    });
    assert.equal(fns.CreateStdAccessibleObject.handler([0x10042, -4, 0x40, 0x80]) >>> 0,
        0x80004001);
    assert.deepEqual([...bytes.subarray(0x80, 0x84)], [0, 0, 0, 0], 'no interface handed out');
    assert.equal(fns.CreateStdAccessibleObject.handler([0x10042, -4, 0x40, 0]) >>> 0, 0x80070057);
    assert.ok(fns.LresultFromObject.handler([0x40, 0, 0x90]) < 0);
    assert.deepEqual(said, ['CreateStdAccessibleObject', 'LresultFromObject'], 'and says so');
    assert.equal(fns.CreateStdAccessibleObject.argBytes, 16);
    assert.equal(fns.LresultFromObject.argBytes, 12);
});
