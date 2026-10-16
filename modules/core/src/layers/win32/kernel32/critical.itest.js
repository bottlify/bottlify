/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The critical-section fast paths, run by the real processor.
 *
 * The bytes are hand-assembled, and a byte-exact unit test pins them against
 * what was intended; this is the check that what was intended is x86 that
 * does the job. The guest here runs with FS at base zero, so the thread id the
 * code reads through FS:[0x24] is whatever this test puts at linear 0x24.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import { runToHalt } from '../../cpu/internal/halt.fixture.js';
import * as cork from '../../../../../cork/src/index.js';
import { COUNTERS, CS, enterCode, leaveCode, tryEnterCode } from './critical.js';

const PROGRAM = 0x8000;
const ENTER = 0x8100;
const LEAVE = 0x8200;
const TRY = 0x8300;
/** Where the fast paths would jump to wait or wake; this guest never should. */
const TRAP = 0x8400;
const COUNTERS_AT = 0x8500;
const SECTION = 0x9000;
const RESULTS = 0x9100;
const THREAD_ID_AT = 0x24;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {number} target @returns {number[]} `push SECTION; call target` from the program. */
const call = (/** @type {number} */ at, target)=>[
    0x68, ...u32(SECTION),                       // push SECTION
    0xe8, ...u32((target - (at + 5 + 5)) | 0),   // call rel32
];

/**
 * A program that enters twice, leaves twice, tries once while free and once
 * while held by somebody else, recording what the try answered.
 */
function program(){
    /** @type {number[]} */
    const code = [];
    const at = ()=>PROGRAM + code.length;
    code.push(...call(at(), ENTER), 0xf4);
    code.push(...call(at(), ENTER), 0xf4);
    code.push(...call(at(), LEAVE), 0xf4);
    code.push(...call(at(), LEAVE), 0xf4);
    // Try while free: answers 1, and now owned.
    code.push(...call(at(), TRY));
    code.push(0xa3, ...u32(RESULTS));           // mov [RESULTS], eax
    code.push(...call(at(), LEAVE));
    // Somebody else holds it: LockCount 0, owner 99, recursion 1.
    code.push(0xc7, 0x05, ...u32(SECTION + CS.LOCK_COUNT), ...u32(0));
    code.push(0xc7, 0x05, ...u32(SECTION + CS.OWNING_THREAD), ...u32(99));
    code.push(0xc7, 0x05, ...u32(SECTION + CS.RECURSION_COUNT), ...u32(1));
    code.push(...call(at(), TRY));
    code.push(0xa3, ...u32(RESULTS + 4));       // mov [RESULTS+4], eax
    code.push(0xf4);                             // hlt
    return new Uint8Array(code);
}

test('enter, leave and try run on the processor and keep the structure Windows keeps', async()=>{
    const host = createCorkHost({
        engine: cork,
        memorySize: 64 * 1024 * 1024,
        trapPort: 0xb077,
        entryVector: 0x7000,
        initialStack: 0x300000,
        cork: {},
    });

    host.writePhysical(ENTER, enterCode(ENTER, TRAP, COUNTERS_AT));
    host.writePhysical(LEAVE, leaveCode(LEAVE, TRAP, COUNTERS_AT));
    host.writePhysical(TRY, tryEnterCode(COUNTERS_AT));
    host.writePhysical(TRAP, new Uint8Array([0xf4]));               // hlt: never reached
    host.writePhysical(THREAD_ID_AT, new Uint8Array(u32(7)));
    host.writePhysical(SECTION + CS.LOCK_COUNT, new Uint8Array(u32(-1)));

    // The program halts after each call, so the section can be checked between.
    const code = program();
    host.writePhysical(PROGRAM, code);
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    runToHalt(host, 1000);

    /** @param {number} at */
    const read = at=>{
        const bytes = host.readPhysical(at, 4);
        return bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24;
    };
    /** Runs one phase: from the halt that ended the last one to the next halt. */
    const run = ()=>{
        host.wake();
        return runToHalt(host, 1000);
    };

    // The first slice ran the first phase, up to its halt.
    // First enter: free -> owned by 7, entered once, LockCount 0.
    assert.equal(read(SECTION + CS.LOCK_COUNT), 0);
    assert.equal(read(SECTION + CS.OWNING_THREAD), 7);
    assert.equal(read(SECTION + CS.RECURSION_COUNT), 1);
    // Second enter: recursion, LockCount counts it.
    run();
    assert.equal(read(SECTION + CS.LOCK_COUNT), 1);
    assert.equal(read(SECTION + CS.RECURSION_COUNT), 2);
    // First leave: still owned.
    run();
    assert.equal(read(SECTION + CS.LOCK_COUNT), 0);
    assert.equal(read(SECTION + CS.RECURSION_COUNT), 1);
    assert.equal(read(SECTION + CS.OWNING_THREAD), 7);
    // Second leave: free again, nobody to wake.
    run();
    assert.equal(read(SECTION + CS.LOCK_COUNT), -1);
    assert.equal(read(SECTION + CS.OWNING_THREAD), 0);
    assert.equal(read(COUNTERS_AT + COUNTERS.ENTERED), 2);
    assert.equal(read(COUNTERS_AT + COUNTERS.LEFT), 2);

    // The rest to the halt: a try while free, a leave, a try while held.
    run();
    assert.equal(read(RESULTS), 1, 'a try on a free section takes it');
    assert.equal(read(RESULTS + 4), 0, 'a try on somebody else\'s section is refused');
    assert.equal(read(COUNTERS_AT + COUNTERS.ENTERED), 3, 'the try that took it is an entry');
    assert.equal(read(SECTION + CS.OWNING_THREAD), 99, 'and leaves it theirs');
    assert.equal(read(SECTION + CS.LOCK_COUNT), 0);
    assert.equal(read(COUNTERS_AT + COUNTERS.LEFT), 3);

    host.stop();
});
