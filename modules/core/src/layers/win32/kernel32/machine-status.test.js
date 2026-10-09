/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CR0, storeMachineStatus } from './machine-status.js';
import { createSeh } from './seh.js';

/** @param {number[]} code */
const at = code=>(/** @type {number} */ address, /** @type {number} */ length)=>
    Uint8Array.from({ length }, (_, index)=>code[address - 0x401000 + index] ?? 0);

const registers = { eax: 0x12345678, ecx: 0xaaaabbbb, edx: 0, ebx: 0, esp: 0x60000,
    ebp: 0, esi: 0, edi: 0, eip: 0x401000, eflags: 0x202 };

test('SMSW r32 takes CR0 and moves past its three bytes', ()=>{
    const after = storeMachineStatus(at([0x0f, 0x01, 0xe0]), registers);
    assert.equal(after?.eax, CR0 >>> 0);
    assert.equal(after?.eip, 0x401003);
    assert.equal(after?.ecx, registers.ecx, 'nothing else changes');
});

test('SMSW r16 keeps the register\'s upper half', ()=>{
    const after = storeMachineStatus(at([0x66, 0x0f, 0x01, 0xe1]), registers);
    assert.equal(after?.ecx, 0xaaaa0033);
    assert.equal(after?.eip, 0x401004);
});

test('the floating-point unit is there and this thread\'s: EM and TS clear, PE and MP set', ()=>{
    assert.equal(CR0 & 0b1111, 0b0011);
});

test('anything else in the 0F 01 group, and SMSW to memory, is left to fault', ()=>{
    assert.equal(storeMachineStatus(at([0x0f, 0x01, 0xc8]), registers), null, 'monitor');
    assert.equal(storeMachineStatus(at([0x0f, 0x01, 0x20]), registers), null, 'smsw [eax]');
    assert.equal(storeMachineStatus(at([0x0f, 0x0b]), registers), null, 'ud2');
});

test('an invalid-opcode fault on SMSW goes on after it without a handler', async()=>{
    const code = [0x0f, 0x01, 0xe0];
    const seh = createSeh(/** @type {any} */ ({
        readMemory: at(code), writeMemory: ()=>{}, isMapped: ()=>true, teb: ()=>0,
        registers: ()=>({ ...registers }), answerWith: (/** @type {number} */ value)=>value,
        callGuest: async()=>assert.fail('no handler runs'),
    }));
    const result = await seh.onFault({ vector: 6, eip: 0x401000, errorCode: null }, registers);
    assert.equal(result.handled, true);
    assert.equal(result.registers?.eax, CR0 >>> 0);
    assert.equal(result.registers?.eip, 0x401003);
});
