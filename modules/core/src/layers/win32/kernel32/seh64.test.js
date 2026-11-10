/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSeh64 } from './seh64.js';

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
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.slice(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>bytes.set(data, at),
        longState: ()=>({ gpr, eflags: 0x202, xmm: new Uint8Array(256), mxcsr: 0x1f80 }),
        currentThread: ()=>null,
        unwinder: {
            lookup: ()=>null,
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
    ()=>{
        const { seh, view } = machine([0x401000, 0x402000, 0x403000, 0]);
        const capture = seh.table.RtlCaptureStackBackTrace;
        assert.equal(capture.handler([0, 8, 0x9000, 0x9100]), 3, 'up to the frame that ends it');
        assert.deepEqual([0, 8, 16].map(at=>Number(view.getBigUint64(0x9000 + at, true))),
            [0x401000, 0x402000, 0x403000], 'the return addresses as quadwords');
        assert.equal(view.getUint32(0x9100, true), 0x401000 + 0x402000 + 0x403000, 'the hash');
        assert.equal(capture.handler([1, 1, 0x9000, 0]), 1, 'one frame skipped, one captured');
        assert.equal(Number(view.getBigUint64(0x9000, true)), 0x402000);
        assert.equal(capture.handler([0, 8, 0, 0]), 0, 'no array to fill');
    });

test('a walk stops at an address no image holds', ()=>{
    const { seh } = machine([0x401000, 0x12345678, 0x403000]);
    assert.equal(seh.table.RtlCaptureStackBackTrace.handler([0, 8, 0x9000, 0]), 2);
});
