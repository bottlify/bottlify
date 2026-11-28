/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestOver } from '../common/guest.fixture.js';
import { JUMP_BUFFER64, SETJMP64_CODE, createSeh64 } from './seh64.js';

/**
 * A 64-bit thread stopped in a host call: RSP at `stack`, and frames that are
 * leaves, each the return address on top of its stack and nothing more.
 *
 * @param {number[]} returns  the return addresses up the stack, a zero to end
 */
function machine(returns){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    const stack = 0x8000;
    returns.forEach((address, index)=>view.setBigUint64(stack + index * 8, BigInt(address), true));
    const gpr = Array.from({ length: 16 }, ()=>0n);
    gpr[4] = BigInt(stack);
    const seh = createSeh64(/** @type {any} */ ({
        guest: guestOver(bytes, 8),
        longState: ()=>({ gpr, eflags: 0x202, xmm: new Uint8Array(256), mxcsr: 0x1f80 }),
        currentThread: ()=>null,
        unwinder: {
            lookup: ()=>null,
            resolve: async()=>null,
            known: (/** @type {number} */ rip)=>rip >= 0x400000 && rip < 0x500000,
            /** A leaf: the return address off the top of its stack. @param {any} context */
            unwindLeaf: context=>{
                const rsp = Number(context.gpr[4]);
                context.rip = Number(view.getBigUint64(rsp, true));
                context.gpr[4] = BigInt(rsp + 8);
            },
        },
    }));
    return { seh, view };
}

test('a 64-bit RtlCaptureStackBackTrace walks the frames up, skipping and capturing as asked',
    async()=>{
        const { seh, view } = machine([0x401000, 0x402000, 0x403000, 0]);
        const capture = seh.table.RtlCaptureStackBackTrace;
        assert.equal(await capture.handler([0, 8, 0x9000, 0x9100]), 3,
            'up to the frame that ends it');
        assert.deepEqual([0, 8, 16].map(at=>Number(view.getBigUint64(0x9000 + at, true))),
            [0x401000, 0x402000, 0x403000], 'the return addresses as quadwords');
        assert.equal(view.getUint32(0x9100, true), 0x401000 + 0x402000 + 0x403000, 'the hash');
        assert.equal(await capture.handler([1, 1, 0x9000, 0]), 1,
            'one frame skipped, one captured');
        assert.equal(Number(view.getBigUint64(0x9000, true)), 0x402000);
        assert.equal(await capture.handler([0, 8, 0, 0]), 0, 'no array to fill');
    });

test('a walk stops at an address no image holds', async()=>{
    const { seh } = machine([0x401000, 0x12345678, 0x403000]);
    assert.equal(await seh.table.RtlCaptureStackBackTrace.handler([0, 8, 0x9000, 0]), 2);
});

test('_setjmp\'s x86-64 writes the buffer its handler writes, from the same registers', async()=>{
    const { longMachine, QUADS, STACK_64, CODE_64 } = await import(
        '../../../../scripts/guest-code/long.mjs');
    const buffer = 0x200000;
    const back = 0x180000;
    let seed = 0x2545f491;
    const next = ()=>{
        seed = Math.imul(seed ^ seed >>> 15, 0x2c1b3c6d) + 0x9e3779b9 | 0;
        return BigInt(seed >>> 0);
    };
    for (let round = 0; round < 20; round++)
    {
        /** @type {Record<string, bigint>} */
        const registers = Object.fromEntries(QUADS.map(name=>[name, next() << 32n | next()]));
        registers.rsp = BigInt(STACK_64);
        registers.rcx = BigInt(buffer);
        const lanes = Array.from({ length: 16 }, ()=>
            Uint8Array.from({ length: 16 }, ()=>Number(next() & 0xffn)));

        const m = longMachine();
        m.write(CODE_64, SETJMP64_CODE);
        m.write(back, [0xf4]);
        m.setQuad(STACK_64, BigInt(back));
        lanes.forEach((lane, index)=>m.setXmm(index, lane));
        m.call(CODE_64, registers);
        assert.equal(m.rip() - 1, back, 'returned');
        assert.equal(m.reg('rax') & 0xffffffffn, 0n, 'answering zero');
        assert.equal(m.reg('rsp'), BigInt(STACK_64 + 8));

        const bytes = new Uint8Array(0x400000);
        new DataView(bytes.buffer).setBigUint64(STACK_64, BigInt(back), true);
        const xmm = new Uint8Array(256);
        lanes.forEach((lane, index)=>xmm.set(lane, index * 16));
        const seh = createSeh64(/** @type {any} */ ({
            guest: guestOver(bytes, 8),
            // As the stub leaves them at the trap: RDX and RAX its own.
            longState: ()=>({ gpr: QUADS.map(name=>(name === 'rdx' || name === 'rax'
                ? 0x1234n : registers[name])), eflags: 0x202, xmm, mxcsr: 0x1f80 }),
            controlWord: ()=>0x27f,
            currentThread: ()=>null,
            unwinder: {},
        }));
        assert.equal(seh.crt._setjmp.handler([buffer, Number(registers.rdx & 0xffffffffn)]), 0);
        const written = m.read(buffer, JUMP_BUFFER64.SIZE);
        // The frame is an address: the handler is handed it as the bridge reads one.
        new DataView(written.buffer).setUint32(JUMP_BUFFER64.FRAME + 4, 0, true);
        assert.deepEqual([...written], [...bytes.subarray(buffer, buffer + JUMP_BUFFER64.SIZE)],
            `round ${round}`);
    }
});
