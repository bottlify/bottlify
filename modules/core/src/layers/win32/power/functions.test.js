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

test('the XP-era scheme calls find no policy, and only Balanced can be made active', ()=>{
    const m = machine();
    const memory = new Uint8Array(0x100);
    const power = createPowrprofFunctions({ ...m.host,
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            memory.slice(at, at + length) });
    for (const [name, args] of /** @type {[string, number[]][]} */ ([['ReadPwrScheme', [0, 0x20]],
        ['WritePwrScheme', [0x10, 0, 0, 0x20]], ['DeletePwrScheme', [1]],
        ['EnumPwrSchemes', [0x400000, 0]]]))
    {
        assert.equal(/** @type {any} */ (power)[name].handler(args), 0, name);
    }
    assert.equal(m.lastError(), 50, 'not supported');
    assert.equal(power.CanUserWritePwrScheme.handler(), 0);
    memory.set(Uint8Array.of(0x22, 0x42, 0x1b, 0x38, 0x94, 0xf6, 0xf0, 0x41,
        0x96, 0x85, 0xff, 0x5b, 0xb2, 0x60, 0xdf, 0x2e), 0x40);
    assert.equal(power.PowerSetActiveScheme.handler([0, 0x40]), 0, 'Balanced');
    // High performance, {8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c}: not a scheme here.
    memory.set(Uint8Array.of(0xda, 0x7f, 0x5e, 0x8c, 0xbf, 0xe8, 0x96, 0x4a,
        0x9a, 0x85, 0xa6, 0xe2, 0x3a, 0x8c, 0x63, 0x5c), 0x60);
    assert.equal(power.PowerSetActiveScheme.handler([0, 0x60]), 2);
    assert.equal(power.PowerSetActiveScheme.handler([0, 0]), 87);
});

test('PowerEnumerate lists Balanced alone; PowerReadFriendlyName names it', ()=>{
    const m = machine();
    const memory = new Uint8Array(0x200);
    const view = new DataView(memory.buffer);
    const power = createPowrprofFunctions({ ...m.host,
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, at),
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            memory.slice(at, at + length) });
    const SIZE = 0x10;
    const BUFFER = 0x40;
    assert.equal(power.PowerEnumerate.handler([0, 0, 0, 16, 0, 0, SIZE]), 0);
    assert.equal(view.getUint32(SIZE, true), 16, 'the size a GUID takes');
    view.setUint32(SIZE, 8, true);
    assert.equal(power.PowerEnumerate.handler([0, 0, 0, 16, 0, BUFFER, SIZE]), 234);
    view.setUint32(SIZE, 16, true);
    assert.equal(power.PowerEnumerate.handler([0, 0, 0, 16, 0, BUFFER, SIZE]), 0);
    assert.equal(view.getUint32(BUFFER, true), 0x381b4222);
    assert.equal(power.PowerEnumerate.handler([0, 0, 0, 16, 1, BUFFER, SIZE]), 259, 'one scheme');
    assert.equal(power.PowerEnumerate.handler([0, BUFFER, 0, 17, 0, BUFFER, SIZE]), 259,
        'no subgroups');
    assert.equal(power.PowerEnumerate.handler([0, 0, 0, 3, 0, BUFFER, SIZE]), 87);
    view.setUint32(SIZE, 64, true);
    assert.equal(power.PowerReadFriendlyName.handler([0, BUFFER, 0, 0, 0x80, SIZE]), 0);
    assert.equal(view.getUint32(SIZE, true), 18);
    assert.equal(String.fromCharCode(...new Uint16Array(memory.slice(0x80, 0x80 + 16).buffer)),
        'Balanced');
    memory[BUFFER] ^= 1;
    assert.equal(power.PowerReadFriendlyName.handler([0, BUFFER, 0, 0, 0x80, SIZE]), 2);
});
