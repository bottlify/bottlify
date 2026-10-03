/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDpnhpastFunctions } from './functions.js';

test('dpnhpast is a COM server that makes no class, says so, and leaves *ppv NULL', ()=>{
    const memory = new Uint8Array(0x100).fill(0xcc);
    /** @type {string[]} */
    const said = [];
    const fns = createDpnhpastFunctions({
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
    });
    assert.deepEqual(Object.keys(fns).sort(), ['DllCanUnloadNow', 'DllGetClassObject',
        'DllRegisterServer', 'DllUnregisterServer']);
    assert.equal(fns.DllGetClassObject.argBytes, 12);
    assert.equal(fns.DllGetClassObject.handler([0x10, 0x20, 0x40]), 0x80040111,
        'CLASS_E_CLASSNOTAVAILABLE');
    assert.deepEqual([...memory.subarray(0x40, 0x44)], [0, 0, 0, 0]);
    assert.equal(fns.DllGetClassObject.handler([0x10, 0x20, 0]), 0x80040111, 'no out pointer');
    assert.match(said[0], /no NAT helper/);
    assert.equal(fns.DllCanUnloadNow.handler(), 0);
    assert.equal(fns.DllRegisterServer.handler(), 0);
    assert.equal(fns.DllUnregisterServer.handler(), 0);
});
