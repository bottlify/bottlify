/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImmFunctions } from './functions.js';

function machine(){
    const memory = new Uint8Array(0x100).fill(0xcd);
    const host = {
        writeMemory: (/** @type {number} */ a, /** @type {Uint8Array} */ b)=>
            memory.set(b, a),
    };
    return { memory, imm: /** @type {any} */ (createImmFunctions(host)) };
}

test('the two associate calls report different kinds of answer', ()=>{
    // One answers with the previous context and one with a boolean. A caller
    // that tests the first as a boolean concludes it failed.
    const m = machine();
    assert.equal(m.imm.ImmAssociateContext.handler([0x40, 0]), 0,
        'a handle, and there was never a previous one');
    assert.equal(m.imm.ImmAssociateContextEx.handler([0x40, 0, 0]), 1,
        'a boolean, and turning the input method off succeeds');
});

test('there is no context to get, and releasing one succeeds anyway', ()=>{
    const m = machine();
    assert.equal(m.imm.ImmGetContext.handler([0x40]), 0);
    assert.equal(m.imm.ImmReleaseContext.handler([0x40, 0]), 1);
});

test('the conversion status is written, not left holding the caller\'s stack', ()=>{
    const m = machine();
    assert.equal(m.imm.ImmGetConversionStatus.handler([0, 0x10, 0x20]), 1);
    assert.deepEqual([...m.memory.slice(0x10, 0x14)], [0, 0, 0, 0]);
    assert.deepEqual([...m.memory.slice(0x20, 0x24)], [0, 0, 0, 0]);

    // A null pointer is legal for either, and must not be written through.
    assert.equal(m.imm.ImmGetConversionStatus.handler([0, 0, 0]), 1);
});

test('the input method is never open, which is the state a game is asking for', ()=>{
    const m = machine();
    // An open input method is what makes a program stop treating keystrokes as
    // its own, so FALSE here is the answer it wants rather than a refusal.
    assert.equal(m.imm.ImmGetOpenStatus.handler([0]), 0);
    assert.equal(m.imm.ImmGetOpenStatus.argBytes, 4);
});

test('turning the input method off succeeds, for a thread or the whole process', ()=>{
    const m = machine();
    assert.equal(m.imm.ImmDisableIME.argBytes, 4);
    assert.equal(m.imm.ImmDisableIME.handler([0xffffffff]), 1);
    assert.equal(m.imm.ImmDisableIME.handler([0]), 1);
});
