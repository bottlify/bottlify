/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPdhFunctions, createPowrprofFunctions } from './functions.js';

function machine(){
    const memory = new Uint8Array(0x1000);
    const view = new DataView(memory.buffer);
    let lastError = 0;
    const host = {
        writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, address),
        setLastError: (/** @type {number} */ code)=>{ lastError = code; },
        processors: 2,
        mhz: 1000,
    };
    return { view, host, lastError: ()=>lastError,
        power: createPowrprofFunctions(host), pdh: createPdhFunctions(host) };
}

test('the power scheme is 0, active, and holds no processor policy', ()=>{
    const m = machine();
    m.view.setUint32(0x10, 7, true);
    assert.equal(m.power.GetActivePwrScheme.handler([0x10]), 1);
    assert.equal(m.view.getUint32(0x10, true), 0);
    assert.equal(m.power.SetActivePwrScheme.handler([0, 0, 0]), 1);
    assert.equal(m.power.SetActivePwrScheme.handler([3, 0, 0]), 0);
    assert.equal(m.power.ReadProcessorPwrScheme.handler([0, 0x20]), 0);
    assert.equal(m.lastError(), 50);
    assert.equal(m.power.WriteProcessorPwrScheme.handler([0, 0x20]), 0);
});

test('CallNtPowerInformation describes each processor and wants room for all', ()=>{
    const m = machine();
    assert.equal(m.power.CallNtPowerInformation.handler([11, 0, 0, 0x100, 24]), 0xc0000023);
    assert.equal(m.power.CallNtPowerInformation.handler([11, 0, 0, 0x100, 48]), 0);
    assert.deepEqual([0, 1, 2, 3, 4, 5].map(i=>m.view.getUint32(0x118 + i * 4, true)),
        [1, 1000, 1000, 1000, 0, 0]);
    assert.equal(m.power.CallNtPowerInformation.handler([4, 0, 0, 0x100, 48]), 0xc0000002);
});

test('a pdh query opens and closes, and finds no counter to add or collect', ()=>{
    const m = machine();
    assert.equal(m.pdh.PdhOpenQueryA.handler([0, 0, 0]), 0xc0000bbd);
    assert.equal(m.pdh.PdhOpenQueryA.handler([0, 0, 0x40]), 0);
    const query = m.view.getUint32(0x40, true);
    assert.equal(m.pdh.PdhAddCounterA.handler([query, 0, 0, 0x44]), 0xc0000bb8);
    assert.equal(m.pdh.PdhCollectQueryData.handler([query]), 0x800007d5);
    assert.equal(m.pdh.PdhCloseQuery.handler([query]), 0);
    assert.equal(m.pdh.PdhCloseQuery.handler([query]), 0xc0000bbc);
    assert.equal(m.pdh.PdhCollectQueryData.handler([query]), 0xc0000bbc);
});

test('the platform is a desktop on the Balanced scheme, which keeps no settings to read', ()=>{
    const memory = new Uint8Array(0x1000);
    const fns = createPowrprofFunctions({
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        setLastError: ()=>{},
        processors: 1,
        mhz: 2000,
        localAlloc: ()=>0x800,
    });
    assert.equal(fns.PowerDeterminePlatformRoleEx.handler(), 1);
    assert.equal(fns.PowerGetActiveScheme.handler([0, 0x100]), 0);
    assert.equal(new DataView(memory.buffer).getUint32(0x100, true), 0x800);
    assert.equal(new DataView(memory.buffer).getUint32(0x800, true), 0x381b4222);
    assert.equal(fns.PowerReadACValue.handler(), 2);
});
