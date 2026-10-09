/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ICINFO_SIZE, createMsvfwFunctions } from './functions.js';

const make = ()=>{
    const memory = new Uint8Array(ICINFO_SIZE + 16).fill(0xcc);
    const fns = createMsvfwFunctions({ writeMemory: (at, bytes)=>memory.set(bytes, at) });
    return { fns, memory };
};

test('no compressor is installed: enumeration and a named lookup both find nothing', ()=>{
    const { fns, memory } = make();
    const vidc = 0x63646976;
    assert.equal(fns.ICInfo.handler([vidc, 0, 8]), 0);
    assert.equal(new DataView(memory.buffer).getUint32(8, true), ICINFO_SIZE);
    assert.ok(memory.subarray(12, 8 + ICINFO_SIZE).every(b=>b === 0), 'the rest is cleared');
    assert.equal(memory[8 + ICINFO_SIZE], 0xcc, 'nothing past the structure is written');
    assert.equal(fns.ICInfo.handler([vidc, 0x30355643, 0]), 0, 'a null out pointer is not written');
});

test('an MCIWnd is never made, and its class is not offered', ()=>{
    const { fns } = make();
    assert.equal(fns.MCIWndCreateA.handler(), 0);
    assert.equal(fns.MCIWndCreateW.handler(), 0);
    assert.equal(fns.MCIWndRegisterClass.handler(), 0);
    assert.equal(fns.MCIWndCreateA.argBytes, 16);
    assert.equal(fns.MCIWndRegisterClass.argBytes, 0);
});
