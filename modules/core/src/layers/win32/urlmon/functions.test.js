/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USER_AGENTS, createUrlmonFunctions } from './functions.js';

/** @param {string} windows */
function harness(windows){
    const ram = new Uint8Array(256);
    const view = new DataView(ram.buffer);
    const { ObtainUserAgentString } = createUrlmonFunctions({ windows,
        readU32: address=>view.getUint32(address, true),
        writeU32: (address, value)=>view.setUint32(address, value, true),
        writeMemory: (address, bytes)=>ram.set(bytes, address) });
    return { ram, view, call: ObtainUserAgentString };
}

test('ObtainUserAgentString writes the Windows\' Internet Explorer string and its terminator',
    ()=>{
        const h = harness('win7');
        assert.equal(h.call.argBytes, 12);
        h.view.setUint32(4, 200, true);
        assert.equal(h.call.handler([0, 16, 4]), 0);
        const agent = USER_AGENTS.win7;
        assert.equal(new TextDecoder().decode(h.ram.subarray(16, 16 + agent.length)), agent);
        assert.equal(h.ram[16 + agent.length], 0);
        assert.equal(h.view.getUint32(4, true), agent.length + 1, 'the size it took');
    });

test('a buffer too small is E_OUTOFMEMORY with the size needed; no buffer is E_INVALIDARG', ()=>{
    const h = harness('winxp');
    h.view.setUint32(4, 4, true);
    assert.equal(h.call.handler([0, 16, 4]), 0x8007000e);
    assert.equal(h.view.getUint32(4, true), USER_AGENTS.winxp.length + 1);
    assert.equal(h.ram[16], 0, 'and nothing written');
    assert.equal(h.call.handler([0, 0, 4]), 0x80070057);
    assert.equal(h.call.handler([0, 16, 0]), 0x80070057);
});
