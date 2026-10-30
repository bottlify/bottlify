/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate between a critical section's two paths: the 32-bit guest code a
 * 32-bit process runs (`critical.js`) and the traps a 64-bit process takes
 * (`sync.js`), over the 24-byte and the 40-byte structure. Seeded sequences
 * of entries, leaves, tries and another thread taking and letting go of the
 * section run down each; after every step the fields, the try's answer and
 * the counters must agree. A sequence never waits or wakes: those go to the
 * same host queues from both paths.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import { runToHalt } from '../../cpu/internal/halt.fixture.js';
import * as cork from '../../../../../cork/src/index.js';
import { COUNTERS, CS, createCriticalSections, criticalLayout, enterCode, leaveCode,
    tryEnterCode } from './critical.js';
import { createSyncFunctions } from './sync.js';

const PROGRAM = 0x10000;
const ENTER = 0x8100;
const LEAVE = 0x8200;
const TRY = 0x8300;
const TRAP = 0x8400;
const COUNTERS_AT = 0x8500;
const SECTION = 0x9000;
const ANSWER = 0x9100;
const THREAD_ID_AT = 0x24;
const ME = 7;
const STRANGER = 99;
const SEEDS = 40;
const STEPS = 60;

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {number} seed */
function random(seed){
    let state = seed >>> 0 || 1;
    return (/** @type {number} */ below)=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) % below;
    };
}

/**
 * A sequence that never waits: the caller enters only a section it holds or
 * nobody does, leaves only one it holds, and another thread takes the
 * section only while it is free and lets go only of its own.
 *
 * @param {number} seed
 * @returns {string[]}
 */
function sequence(seed){
    const pick = random(seed);
    let mine = 0;
    let theirs = false;
    /** @type {string[]} */
    const steps = [];
    while (steps.length < STEPS)
    {
        const choice = pick(5);
        if (choice === 0 && !theirs)
        {
            steps.push('enter');
            mine++;
        }
        else if (choice === 1 && mine > 0)
        {
            steps.push('leave');
            mine--;
        }
        else if (choice === 2)
        {
            steps.push('try');
            mine += theirs ? 0 : 1;
        }
        else if (choice === 3 && mine === 0 && !theirs)
        {
            steps.push('taken');
            theirs = true;
        }
        else if (choice === 4 && theirs)
        {
            steps.push('released');
            theirs = false;
        }
    }
    return steps;
}

/**
 * What another thread taking or letting go of the section leaves in it.
 *
 * @param {string} step
 * @returns {[number, number, number]}  LockCount, RecursionCount, OwningThread
 */
const strangerFields = step=>(step === 'taken' ? [0, 1, STRANGER] : [-1, 0, 0]);

/**
 * @typedef {{ lock: number, recursion: number, owner: number, answer: number,
 *     entered: number, left: number }} Seen
 */

/**
 * The sequence down the guest code, on the processor: each step a call (or
 * the other thread's stores) and a halt, the structure read at each halt.
 *
 * @param {string[]} steps
 * @returns {Seen[]}
 */
function throughGuest(steps){
    const host = createCorkHost({
        engine: cork, memorySize: 64 * 1024 * 1024, trapPort: 0xb077,
        entryVector: 0x7000, initialStack: 0x300000, cork: { sliceMs: Infinity },
    });
    try
    {
        host.writePhysical(ENTER, enterCode(ENTER, TRAP, COUNTERS_AT));
        host.writePhysical(LEAVE, leaveCode(LEAVE, TRAP, COUNTERS_AT));
        host.writePhysical(TRY, tryEnterCode(COUNTERS_AT));
        host.writePhysical(TRAP, new Uint8Array([0xf4]));
        host.writePhysical(THREAD_ID_AT, new Uint8Array(u32(ME)));
        host.writePhysical(SECTION + CS.LOCK_COUNT, new Uint8Array(u32(-1)));
        /** @type {number[]} */
        const code = [];
        for (const step of steps)
        {
            if (step === 'taken' || step === 'released')
            {
                const [lock, recursion, owner] = strangerFields(step);
                code.push(0xc7, 0x05, ...u32(SECTION + CS.LOCK_COUNT), ...u32(lock));
                code.push(0xc7, 0x05, ...u32(SECTION + CS.RECURSION_COUNT), ...u32(recursion));
                code.push(0xc7, 0x05, ...u32(SECTION + CS.OWNING_THREAD), ...u32(owner));
            }
            else
            {
                const target = { enter: ENTER, leave: LEAVE, try: TRY }[step] ?? 0;
                const at = PROGRAM + code.length;
                code.push(0xb8, ...u32(0x5a5a5a5a));                      // mov eax, marker
                code.push(0x68, ...u32(SECTION));                         // push SECTION
                code.push(0xe8, ...u32((target - (at + 10 + 5)) | 0));    // call
                code.push(0xa3, ...u32(ANSWER));                          // mov [ANSWER], eax
            }
            code.push(0xf4);
        }
        host.writePhysical(PROGRAM, new Uint8Array(code));
        host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
        /** @param {number} at */
        const read = at=>{
            const bytes = host.readPhysical(at, 4);
            return bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24;
        };
        /** @type {Seen[]} */
        const seen = [];
        runToHalt(host, 1000);
        for (let index = 0; index < steps.length; index++)
        {
            if (index > 0)
            {
                host.wake();
                runToHalt(host, 1000);
            }
            seen.push({
                lock: read(SECTION + CS.LOCK_COUNT),
                recursion: read(SECTION + CS.RECURSION_COUNT),
                owner: read(SECTION + CS.OWNING_THREAD),
                answer: steps[index] === 'try' ? read(ANSWER) : 0,
                entered: read(COUNTERS_AT + COUNTERS.ENTERED),
                left: read(COUNTERS_AT + COUNTERS.LEFT),
            });
        }
        return seen;
    }
    finally
    {
        host.stop();
    }
}

/**
 * The sequence down the traps, over the structure of a pointer of `size`.
 *
 * @param {string[]} steps @param {4 | 8} size
 * @returns {Seen[]}
 */
function throughTraps(steps, size){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    let free = 0x8000;
    const thread = { id: ME };
    const memory = {
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} length */
        allocate: length=>{
            const at = free;
            free += length;
            return at;
        },
    };
    const critical = createCriticalSections({
        ...memory, pointerSize: size, currentThread: ()=>thread,
        block: ()=>assert.fail('a sequence never waits'),
        wake: ()=>assert.fail('a sequence never wakes'),
        park: ()=>assert.fail('a sequence never parks'),
    });
    /** @type {Record<string, any>} */
    const fns = createSyncFunctions(/** @type {any} */ ({
        ...memory, kernel: {}, critical, pointerSize: size, currentThread: ()=>thread,
        park: ()=>assert.fail('a sequence never parks'),
    }));
    const layout = criticalLayout(size);
    fns.InitializeCriticalSection.handler([SECTION]);
    const counters = critical.counters();
    return steps.map(step=>{
        let answer = 0;
        if (step === 'taken' || step === 'released')
        {
            const [lock, recursion, owner] = strangerFields(step);
            view.setInt32(SECTION + layout.LOCK_COUNT, lock, true);
            view.setInt32(SECTION + layout.RECURSION_COUNT, recursion, true);
            view.setInt32(SECTION + layout.OWNING_THREAD, owner, true);
        }
        else
        {
            const name = { enter: 'EnterCriticalSection', leave: 'LeaveCriticalSection',
                try: 'TryEnterCriticalSection' }[step] ?? '';
            answer = fns[name].handler([SECTION]);
        }
        return {
            lock: view.getInt32(SECTION + layout.LOCK_COUNT, true),
            recursion: view.getInt32(SECTION + layout.RECURSION_COUNT, true),
            owner: view.getInt32(SECTION + layout.OWNING_THREAD, true),
            answer: step === 'try' ? answer : 0,
            entered: view.getInt32(counters + COUNTERS.ENTERED, true),
            left: view.getInt32(counters + COUNTERS.LEFT, true),
        };
    });
}

test('a section entered, left and tried by trap answers as its guest code does', ()=>{
    let entries = 0;
    for (let seed = 1; seed <= SEEDS; seed++)
    {
        const steps = sequence(seed);
        entries += steps.filter(step=>step === 'enter' || step === 'try').length;
        const guest = throughGuest(steps);
        for (const size of /** @type {const} */ ([4, 8]))
        {
            const traps = throughTraps(steps, size);
            for (let index = 0; index < steps.length; index++)
            {
                assert.deepEqual(traps[index], guest[index],
                    `seed ${seed}, ${size}-byte pointers, step ${index} (${steps[index]})`);
            }
        }
    }
    assert.ok(entries > SEEDS * 10, 'the sequences take the section, not only look at it');
});
