/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEntryPointCaller } from './dllentry.js';

const TEB = 0x7000;
const ESP = 0x2ff000;
const OUTER = 0x2ffe00;

function setup(){
    const words = new Map([[TEB, OUTER]]);
    /** @type {Record<string, any>} */
    const registered = {};
    /** @type {any[]} */
    const log = [];
    /** @type {(answer: number) => void} */
    let answer = ()=>{};
    const call = createEntryPointCaller({
        register: (name, fn)=>{
            registered[name] = fn;
            return name === '<guarded-call>' ? 0x100 : 0x200;
        },
        callGuest: request=>{
            log.push({ call: request });
            return new Promise(resolve=>{
                answer = resolve;
            });
        },
        continueAt: (registers, options)=>{
            log.push({ continueAt: registers, options });
            return 'continued';
        },
        unwind: (frame, address, options)=>{
            log.push({ unwind: frame, record: options?.record });
            return Promise.resolve();
        },
        readU32: address=>words.get(address) ?? 0,
        writeU32: (address, value)=>words.set(address, value),
        stackPointer: ()=>ESP,
        teb: ()=>TEB,
    });
    return { call, words, registered, log, answer: (/** @type {number} */ value)=>answer(value) };
}

/** Lets every promise already settled run its callbacks. */
const settle = ()=>new Promise(resolve=>setImmediate(resolve));

test('an image\'s routines run in turn, each inside a loader frame at fs:[0], taken off when it'
    + ' returns', async()=>{
    const { call, words, log, answer } = setup();
    const done = call({ routines: [0x5000, 0x6000], base: 0x4000000, reason: 0, reserved: 1,
        thread: 'main' });
    assert.equal(log.length, 0, 'not before the call that asked has suspended');

    await settle();
    const record = words.get(TEB) ?? 0;
    assert.ok(record < ESP && record >= ESP - 128,
        'the record is just below the caller\'s stack');
    assert.equal(words.get(record), OUTER, 'linked to the frame that was the head');
    assert.equal(words.get(record + 4), 0x100, 'with the loader\'s handler');
    assert.deepEqual(log.map(each=>[each.call.entry, each.call.args]),
        [[0x5000, [0x4000000, 0, 1]]], 'the TLS callback first, alone');
    assert.equal(log[0].call.stackAtRest, record, 'its frame goes below it');

    answer(1);
    await settle();
    assert.deepEqual(log.map(each=>each.call.entry), [0x5000, 0x6000],
        'then the entry point, once the callback has returned');
    assert.equal(words.get(TEB), record, 'in a frame of its own');
    answer(1);
    assert.equal(await done, 1);
    assert.equal(words.get(TEB), OUTER, 'and fs:[0] is what it was');
});

test('an exception out of the entry point is taken, unwound, and answered with 0', async()=>{
    const { call, words, registered, log } = setup();
    void call({ routines: [0x5000], base: 0x4000000, reason: 0, reserved: 0, thread: 'main' });
    await settle();
    const record = words.get(TEB) ?? 0;
    const exception = 0x2fe000;
    words.set(exception, 0xc0000005);
    words.set(exception + 4, 0);

    const guard = registered['<guarded-call>'];
    assert.equal(guard.convention, 'cdecl');
    assert.equal(await guard.handler([exception, record, 0, 0]), 'continued');
    assert.deepEqual(log[1], { unwind: record, record: exception },
        'the frames the entry point pushed are unwound first');
    const frameBase = record - 20;
    assert.deepEqual(log[2], { continueAt: { eip: 0x200, esp: frameBase },
        options: { below: frameBase } }, 'then the call ends where its own return would land');
    assert.equal(registered['<guarded-abandoned-3:0>'].argBytes, 12,
        'popping the three arguments');
    assert.equal(registered['<guarded-abandoned-3:0>'].handler([]), 0);

    words.set(exception + 4, 2);
    assert.equal(guard.handler([exception, record, 0, 0]), 1,
        'an unwind passing through is not an exception to take');
    assert.equal(guard.handler([exception, 0x1234, 0, 0]), 1, 'nor is a frame it does not know');
});
