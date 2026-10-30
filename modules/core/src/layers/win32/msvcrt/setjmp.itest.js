/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * `_setjmp` and `_setjmp3` as the guest runs them (`SETJMP_CODE`), as a gate:
 * the code on the processor against the handlers that are its reference, over
 * seeded registers, chain heads, counts -- none, past the buffer's room, and
 * the edges of 32 bits -- and words after the count: the buffer each leaves,
 * what each answers, and the stack and the registers a caller keeps.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import { runToHalt } from '../../cpu/internal/halt.fixture.js';
import * as cork from '../../../../../cork/src/index.js';
import { SETJMP_CODE, createCrtSeh } from './seh.js';

const PROGRAM = 0x8000;
const SETJMP = 0x9000;
const SETJMP3 = 0x9200;
const BUFFER = 0xa000;
const TEB = 0xb000;
const STACK = 0x300000;
const BUFFER_BYTES = 64;
const KEPT = /** @type {const} */ (['ebx', 'esi', 'edi', 'ebp']);
const COUNTS = [0, 1, 2, 3, 5, 8, 9, 12, 0x7fffffff, 0x80000000, 0xffffffff];

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {number} seed */
function random(seed){
    let state = seed >>> 0 || 1;
    const next = ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
    /** @param {number} n */
    const int = n=>next() % n;
    return { u32: next, int };
}

test('setjmp and _setjmp3 in the guest leave the buffer their handlers leave', ()=>{
    const host = createCorkHost({
        memorySize: 16 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: { sliceMs: Infinity },
    });
    host.writePhysical(SETJMP, SETJMP_CODE.setjmp);
    host.writePhysical(SETJMP3, SETJMP_CODE.setjmp3);
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    const layout = host.blockLayout();
    const block = host.block();
    new DataView(block.buffer, block.byteOffset, block.byteLength)
        .setUint32(layout.fsBase, TEB, true);

    /** The handlers, over the same memory, with the registers the call was made with. */
    let registers = /** @type {Record<string, number>} */ ({});
    const crt = createCrtSeh(/** @type {any} */ ({
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            host.readPhysical(at, length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            host.writePhysical(at, bytes),
        isMapped: ()=>true,
        registers: ()=>registers,
        setRegisters: ()=>{},
        teb: ()=>TEB,
    }));

    let checked = 0;
    for (let program = 1; program <= 60; program++)
    {
        const rng = random(program);
        for (let step = 0; step < 20; step++)
        {
            const three = rng.int(4) !== 0;
            const count = three ? COUNTS[rng.int(COUNTS.length)] : 0;
            const after = Array.from({ length: 10 }, ()=>rng.u32());
            const args = three ? [BUFFER, count, ...after] : [BUFFER];
            const kept = Object.fromEntries(KEPT.map(name=>[name, rng.u32()]));
            host.writePhysical(TEB, new Uint8Array(u32(rng.u32())));

            // The code: called as a program calls it, the caller popping.
            const garbage = Uint8Array.from({ length: BUFFER_BYTES }, ()=>rng.int(256));
            host.writePhysical(BUFFER, garbage);
            /** @type {number[]} */
            const code = [];
            for (const value of [...args].reverse())
            {
                code.push(0x68, ...u32(value));
            }
            const site = PROGRAM + code.length;
            const target = three ? SETJMP3 : SETJMP;
            code.push(0xe8, ...u32((target - (site + 5)) | 0));
            code.push(0x81, 0xc4, ...u32(args.length * 4), 0xf4);
            host.writePhysical(PROGRAM, new Uint8Array(code));
            for (const [name, value] of Object.entries(kept))
            {
                host.writeReg32(name, value);
            }
            host.writeReg32('eip', PROGRAM);
            host.writeReg32('esp', STACK);
            runToHalt(host, 1000);
            const label = `program ${program}, step ${step}, count ${count}`;
            assert.equal(host.readReg32('eip'), PROGRAM + code.length, `${label}: returned`);
            assert.equal(host.readReg32('esp'), STACK, `${label}: the stack as the caller left it`);
            assert.equal(host.readReg32('eax'), 0, `${label}: zero, the call that set the mark`);
            for (const [name, value] of Object.entries(kept))
            {
                assert.equal(host.readReg32(name) >>> 0, value, `${label}: ${name} kept`);
            }
            const fromCode = host.readPhysical(BUFFER, BUFFER_BYTES).slice();

            // The handler, from the same call: its stack and return address.
            host.writePhysical(BUFFER, garbage);
            registers = kept;
            const callerStack = STACK - args.length * 4 - 4;
            const frame = { callerStack, hostReturn: site + 5 };
            const answer = three
                ? crt.table._setjmp3.handler([BUFFER, count], frame)
                : crt.table._setjmp.handler([BUFFER], frame);
            assert.equal(answer, 0);
            assert.deepEqual(fromCode, host.readPhysical(BUFFER, BUFFER_BYTES).slice(), label);
            checked++;
        }
    }
    assert.equal(checked, 1200);
});
