/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SEGMENT_FS, captureContext, diffContexts, restoreContext, setThreadBase,
} from './context.js';

/**
 * A stand-in for the emulator's CPU object: the same field names, types and
 * lengths, so the record under test is the real shape rather than a convenient
 * one. The emulator itself is exercised separately, in the integration tests.
 */
function fakeCpu(){
    return {
        reg32: new Int32Array(8),
        instruction_pointer: new Int32Array(1),
        previous_ip: new Int32Array(1),
        sreg: new Uint16Array(8),
        segment_offsets: new Int32Array(8),
        segment_is_null: new Uint8Array(8),
        segment_limits: new Uint32Array(8),
        segment_access_bytes: new Uint8Array(8),
        flags: new Int32Array(1),
        flags_changed: new Int32Array(1),
        last_op1: new Int32Array(1),
        last_result: new Int32Array(1),
        last_op_size: new Int32Array(1),
        fpu_st: new Int32Array(32),
        fpu_stack_ptr: new Uint8Array(1),
        fpu_stack_empty: new Uint8Array(1),
        fpu_control_word: new Uint16Array(1),
        fpu_status_word: new Uint16Array(1),
        fpu_opcode: new Int32Array(1),
        fpu_ip: new Int32Array(1),
        fpu_ip_selector: new Int32Array(1),
        fpu_dp: new Int32Array(1),
        fpu_dp_selector: new Int32Array(1),
        reg_xmm32s: new Int32Array(32),
        mxcsr: new Int32Array(1),
        in_hlt: new Uint8Array(1),
    };
}

/**
 * Fills every field with a distinct value, so a dropped one cannot hide.
 *
 * @param {Record<string, any>} cpu
 * @param {number} seed
 */
function fillDistinctly(cpu, seed){
    let n = seed;
    const next = ()=>(n += 7);
    for (const [name, view] of Object.entries(cpu))
    {
        for (let i = 0; i < view.length; i++)
        {
            // Uint8 fields must stay in range, and fpu_stack_empty is a bit mask.
            view[i] = view instanceof Uint8Array ? next() & 0xff : next();
        }
        void name;
    }
    return cpu;
}

test('a full context survives a round trip exactly', ()=>{
    const cpu = fillDistinctly(fakeCpu(), 1);
    const saved = captureContext(cpu);

    fillDistinctly(cpu, 5000); // another thread runs and clobbers everything
    restoreContext(cpu, saved);

    assert.deepEqual(diffContexts(saved, captureContext(cpu)), []);
});

test('the lazy-flag fields all travel together', ()=>{
    const cpu = fakeCpu();
    // The state after an operation whose flags have not been materialised yet.
    cpu.flags[0] = 0x2;
    cpu.flags_changed[0] = 0x8d5;
    cpu.last_op1[0] = 0x7fffffff;
    cpu.last_result[0] = -0x80000000;
    cpu.last_op_size[0] = 32;

    const saved = captureContext(cpu);
    assert.equal(saved.flags, 0x2);
    assert.equal(saved.flagsChanged, 0x8d5);

    // Saving only the raw word is the trap: it is missing OF, SF, AF and PF
    // while flags_changed is non-zero, so the record has to carry the operands
    // the flags will be computed from.
    for (const field of ['flags', 'flagsChanged', 'lastOp1', 'lastResult', 'lastOpSize'])
    {
        assert.ok(field in saved, `${field} is part of the context`);
    }
});

test('dropping the x87 stack pointer or tag word is detected', ()=>{
    const cpu = fillDistinctly(fakeCpu(), 11);
    const saved = captureContext(cpu);

    // Exactly the shape of the MMX/x87 bug: the eight registers come back, but
    // the two bytes that say what they mean do not.
    const incomplete = { ...saved, fpuStackPtr: 0, fpuStackEmpty: 0 };
    restoreContext(cpu, incomplete);

    assert.deepEqual(diffContexts(saved, captureContext(cpu)), ['fpuStackPtr', 'fpuStackEmpty']);
});

test('every field is compared, so a silently dropped one fails', ()=>{
    const cpu = fillDistinctly(fakeCpu(), 3);
    const saved = captureContext(cpu);

    for (const field of Object.keys(saved))
    {
        const damaged = { ...saved };
        damaged[field] = Array.isArray(saved[field])
            ? saved[field].map(()=>0)
            : (saved[field] ^ 0xff) >>> 0;
        assert.deepEqual(diffContexts(saved, damaged), [field], `${field} is covered`);
    }
});

test('the thread base is part of the context, not the caller of the switch', ()=>{
    const cpu = fillDistinctly(fakeCpu(), 17);
    const context = captureContext(cpu);

    setThreadBase(context, 0x7ffdf000);
    restoreContext(cpu, context);

    assert.equal(cpu.segment_offsets[SEGMENT_FS], 0x7ffdf000,
        'FS follows the thread; forgetting it is how a thread reads another thread TEB');
});
