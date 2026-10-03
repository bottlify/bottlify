/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The clock routines, run by the real processor.
 *
 * The bytes are hand-assembled and a byte-exact unit test pins them against
 * what was intended; this is the check that what was intended is x86 that
 * copies the block into the caller's LARGE_INTEGER, pops exactly its one
 * argument, and leaves the null pointer to the host.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import * as cork from '../../../../../cork/src/index.js';
import {
    CLOCK, queryPerformanceCounterCode, queryPerformanceFrequencyCode, tickCountCode,
} from './process.js';

const PROGRAM = 0x8000;
const COUNTER = 0x8100;
const FREQUENCY = 0x8200;
const TICKS = 0x8300;
/** Where a routine leaves for the host: a halt, so the test can see it got there. */
const TRAP = 0x8400;
/** The block, on a page of its own as the engine takes it. */
const BLOCK = 0xa000;
const OUT = 0x9000;
const STACK = 0x300000;

/** One and a half seconds of guest time, in counter ticks and milliseconds. */
const UPTIME_MS = 1500;
const UPTIME_TICKS = 1_500_000n;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * `push args... ; call target ; hlt`, stdcall order.
 *
 * @param {number} at @param {number} target @param {number[]} [args]
 */
const call = (at, target, args = [])=>{
    /** @type {number[]} */
    const code = [];
    for (const value of [...args].reverse())
    {
        code.push(0x68, ...u32(value));
    }
    code.push(0xe8, ...u32((target - (at + code.length + 5)) | 0));
    code.push(0xf4);
    return code;
};

/** The steps, each halting so the test can read what it wrote. */
const STEPS = [
    { target: COUNTER, args: [OUT] },
    { target: FREQUENCY, args: [OUT + 16] },
    { target: TICKS, args: [] },
    { target: COUNTER, args: [0] },
    { target: FREQUENCY, args: [0] },
];

function program(){
    /** @type {number[]} */
    const code = [0xf4];
    /** @type {number[]} */
    const starts = [];
    for (const step of STEPS)
    {
        starts.push(PROGRAM + code.length);
        code.push(...call(PROGRAM + code.length, step.target, step.args));
    }
    return { bytes: new Uint8Array(code), starts, end: PROGRAM + code.length };
}

test('the clock routines answer out of the block and leave a null pointer alone', async()=>{
    const host = createCorkHost({
        engine: cork,
        memorySize: 64 * 1024 * 1024,
        trapPort: 0xb077,
        entryVector: 0x7000,
        initialStack: STACK,
        cork: {},
    });

    host.writePhysical(COUNTER, queryPerformanceCounterCode(COUNTER, TRAP, BLOCK));
    host.writePhysical(FREQUENCY, queryPerformanceFrequencyCode(FREQUENCY, TRAP));
    host.writePhysical(TICKS, tickCountCode(BLOCK));
    host.writePhysical(TRAP, new Uint8Array([0xf4]));
    const block = new Uint8Array(CLOCK.SIZE);
    const view = new DataView(block.buffer);
    view.setBigUint64(CLOCK.COUNTER, UPTIME_TICKS, true);
    view.setUint32(CLOCK.TICKS, UPTIME_MS, true);
    host.writePhysical(BLOCK, block);

    const { bytes: image, starts, end } = program();
    host.writePhysical(PROGRAM, image);
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    host.runSlice(1000);

    /** @param {number} at */
    const read = at=>{
        const bytes = host.readPhysical(at, 8);
        return new DataView(bytes.slice().buffer).getBigUint64(0, true);
    };
    const eip = ()=>host.readReg32('eip');
    /**
     * Runs one step from a fresh stack, and says whether it answered to the
     * program or left for the host. An answer must have left the stack where
     * it was: a routine popping too few arguments leaves its caller to return
     * into one.
     *
     * @param {number} index
     */
    const run = index=>{
        host.writeReg32('eip', starts[index]);
        host.writeReg32('esp', STACK);
        host.wake();
        host.runSlice(1000);
        if (eip() === TRAP + 1)
        {
            return 'trap';
        }
        const after = index + 1 < starts.length ? starts[index + 1] : end;
        assert.equal(eip(), after, `step ${index} halted after its call`);
        assert.equal(host.readReg32('esp'), STACK, `step ${index} left the stack as it was`);
        return host.readReg32('eax');
    };

    assert.equal(run(0), 1, 'the counter answered TRUE');
    assert.equal(read(OUT), UPTIME_TICKS, 'and wrote both words of the block');

    assert.equal(run(1), 1);
    assert.equal(read(OUT + 16), 1_000_000n, 'the frequency, as an immediate');

    assert.equal(run(2), UPTIME_MS, 'the tick count is the answer itself');

    assert.equal(run(3), 'trap', 'a null pointer is the host to answer for');
    assert.equal(run(4), 'trap');

    host.stop();
});
