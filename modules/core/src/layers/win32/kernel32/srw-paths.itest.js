/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate between an SRW lock's two paths: the 32-bit guest code a 32-bit
 * process runs (`srwCode`) and the traps a 64-bit process takes, which are
 * also where the guest code goes for what it cannot do itself. Seeded
 * sequences of takes, releases, tries and another thread's readers coming and
 * going run down each; after every step the word and the try's answer must
 * agree. A sequence never waits: a word somebody waits for sends every routine
 * but the tries to the trap, which the last test holds them to.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import { runToHalt } from '../../cpu/internal/halt.fixture.js';
import * as cork from '../../../../../cork/src/index.js';
import { createSlimSync, SRW, srwCode } from './slimsync.js';

const PROGRAM = 0x10000;
const CODE = 0x8100;
const TRAP = 0x8400;
const LOCK = 0x9000;
const ANSWER = 0x9100;
const MARKER = 0x5a5a5a5a;
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

/** The exports a step calls, by step. */
const EXPORTS = /** @type {const} */ ({
    ax: ['acquireExclusive', 'AcquireSRWLockExclusive'],
    rx: ['releaseExclusive', 'ReleaseSRWLockExclusive'],
    as: ['acquireShared', 'AcquireSRWLockShared'],
    rs: ['releaseShared', 'ReleaseSRWLockShared'],
    tx: ['tryExclusive', 'TryAcquireSRWLockExclusive'],
    ts: ['tryShared', 'TryAcquireSRWLockShared'],
});

/**
 * A sequence that never waits: this thread takes the lock only as it can be
 * taken and lets go only of what it holds; another thread's readers come in
 * while no writer holds it and leave, each a store of the word the step
 * carries.
 *
 * @param {number} seed
 * @returns {{ step: string, word?: number }[]}
 */
function sequence(seed){
    const pick = random(seed);
    let exclusive = false;
    let mine = 0;
    let theirs = 0;
    const word = ()=>(exclusive ? SRW.HELD
        : mine + theirs > 0 ? SRW.HELD | (mine + theirs) * SRW.SHARED : 0);
    /** @type {{ step: string, word?: number }[]} */
    const steps = [];
    while (steps.length < STEPS)
    {
        const choice = pick(8);
        /** @type {boolean} */
        const unheld = !exclusive && mine + theirs === 0;
        if (choice === 0 && unheld)
        {
            steps.push({ step: 'ax' });
            exclusive = true;
        }
        else if (choice === 1 && exclusive)
        {
            steps.push({ step: 'rx' });
            exclusive = false;
        }
        else if (choice === 2 && !exclusive)
        {
            steps.push({ step: 'as' });
            mine++;
        }
        else if (choice === 3 && mine > 0)
        {
            steps.push({ step: 'rs' });
            mine--;
        }
        else if (choice === 4)
        {
            steps.push({ step: 'tx' });
            exclusive ||= unheld;
        }
        else if (choice === 5)
        {
            steps.push({ step: 'ts' });
            mine += exclusive ? 0 : 1;
        }
        else if (choice === 6 && !exclusive)
        {
            theirs++;
            steps.push({ step: 'theirs', word: word() });
        }
        else if (choice === 7 && theirs > 0)
        {
            theirs--;
            steps.push({ step: 'theirs', word: word() });
        }
    }
    return steps;
}

/**
 * One call of each step down the guest code, on the processor: each a call
 * (or the other thread's store) and a halt, the word read at each halt.
 *
 * @param {{ step: string, word?: number }[]} steps
 * @param {number} [initial]
 * @returns {{ word: number, answer: number, eip: number }[]}
 */
function throughGuest(steps, initial = 0){
    const host = createCorkHost({
        engine: cork, memorySize: 64 * 1024 * 1024, trapPort: 0xb077,
        entryVector: 0x7000, initialStack: 0x300000, cork: { sliceMs: Infinity },
    });
    try
    {
        const { code, entries } = srwCode(CODE, { acquireExclusive: TRAP,
            releaseExclusive: TRAP, acquireShared: TRAP, releaseShared: TRAP });
        host.writePhysical(CODE, code);
        host.writePhysical(TRAP, new Uint8Array([0xf4]));
        host.writePhysical(LOCK, new Uint8Array(u32(initial)));
        /** @type {number[]} */
        const program = [];
        for (const { step, word } of steps)
        {
            if (step === 'theirs')
            {
                program.push(0xc7, 0x05, ...u32(LOCK), ...u32(word ?? 0));
            }
            else
            {
                const target = entries[EXPORTS[/** @type {keyof EXPORTS} */ (step)][0]];
                const at = PROGRAM + program.length;
                program.push(0xb8, ...u32(MARKER));                          // mov eax, marker
                program.push(0x68, ...u32(LOCK));                            // push LOCK
                program.push(0xe8, ...u32((target - (at + 10 + 5)) | 0));    // call
                program.push(0xa3, ...u32(ANSWER));                          // mov [ANSWER], eax
            }
            program.push(0xf4);
        }
        host.writePhysical(PROGRAM, new Uint8Array(program));
        host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
        /** @param {number} at */
        const read = at=>{
            const bytes = host.readPhysical(at, 4);
            return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
        };
        /** @type {{ word: number, answer: number, eip: number }[]} */
        const seen = [];
        runToHalt(host, 1000);
        for (let index = 0; index < steps.length; index++)
        {
            if (index > 0)
            {
                host.wake();
                runToHalt(host, 1000);
            }
            const step = steps[index].step;
            seen.push({ word: read(LOCK),
                answer: step === 'tx' || step === 'ts' ? read(ANSWER) & 0xff : 0,
                eip: host.eip() >>> 0 });
        }
        return seen;
    }
    finally
    {
        host.stop();
    }
}

/**
 * The sequence down the traps.
 *
 * @param {{ step: string, word?: number }[]} steps
 * @returns {{ word: number, answer: number }[]}
 */
function throughTraps(steps){
    const bytes = new Uint8Array(0x10000);
    const view = new DataView(bytes.buffer);
    const thread = { id: 7 };
    /** @type {Record<string, any>} */
    const fns = createSlimSync(/** @type {any} */ ({
        kernel: { onTimeout: ()=>{}, block: ()=>assert.fail('a sequence never waits'),
            wake: ()=>assert.fail('a sequence never wakes') },
        readMemory: (/** @type {number} */ address, /** @type {number} */ length)=>
            bytes.slice(address, address + length),
        writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ data)=>
            bytes.set(data, address),
        compareExchangeU32: (/** @type {number} */ address, /** @type {number} */ expected,
            /** @type {number} */ value)=>
        {
            const held = view.getUint32(address, true);
            if (held === expected)
            {
                view.setUint32(address, value, true);
            }
            return held;
        },
        currentThread: ()=>thread,
        park: ()=>assert.fail('a sequence never parks'),
        allocate: ()=>0x8000,
    }), ()=>0);
    return steps.map(({ step, word })=>{
        let answer = 0;
        if (step === 'theirs')
        {
            view.setUint32(LOCK, word ?? 0, true);
        }
        else
        {
            answer = fns[EXPORTS[/** @type {keyof EXPORTS} */ (step)][1]].handler([LOCK]);
        }
        return { word: view.getUint32(LOCK, true),
            answer: step === 'tx' || step === 'ts' ? answer : 0 };
    });
}

test('an SRW lock taken, released and tried by trap answers as its guest code does', ()=>{
    let calls = 0;
    for (let seed = 1; seed <= SEEDS; seed++)
    {
        const steps = sequence(seed);
        calls += steps.filter(({ step })=>step !== 'theirs').length;
        const guest = throughGuest(steps).map(({ word, answer })=>({ word, answer }));
        const traps = throughTraps(steps);
        for (let index = 0; index < steps.length; index++)
        {
            assert.deepEqual(guest[index], traps[index],
                `seed ${seed}, step ${index} (${steps[index].step}) of `
                + steps.slice(0, index + 1).map(({ step })=>step).join(' '));
        }
    }
    assert.ok(calls > SEEDS * STEPS / 2, `only ${calls} calls`);
});

test('a word somebody waits for sends each routine to its trap untouched, and fails a try', ()=>{
    // Exclusive and shared, each with a waiter: no guest instruction may change
    // the word the host hands on.
    for (const initial of [SRW.HELD | SRW.WAITING, SRW.HELD | SRW.SHARED | SRW.WAITING,
        SRW.HELD | 3 * SRW.SHARED | SRW.WAITING])
    {
        for (const step of ['ax', 'rx', 'as', 'rs'])
        {
            const [{ word, eip }] = throughGuest([{ step }], initial);
            assert.equal(word, initial, `${step} over 0x${initial.toString(16)}`);
            assert.equal(eip, TRAP + 1, `${step} over 0x${initial.toString(16)} reached the trap`);
        }
        for (const step of ['tx', 'ts'])
        {
            const [{ word, answer }] = throughGuest([{ step }], initial);
            assert.equal(word, initial);
            assert.equal(answer, 0, `${step} over 0x${initial.toString(16)} fails`);
        }
    }
});
