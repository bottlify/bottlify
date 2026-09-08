/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How a new thread's stack is primed, which is the one thing about thread
 * creation that a caller cannot see and cannot recover from. A return address
 * pointing at the wrong place turns a thread that finishes into a thread that
 * never does, and a stack pointer a few bytes too high turns the first pop into
 * a read outside the memory the thread was given.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kernelModule } from './module.js';

const PARK = 0xf000dead;
const STACK_BASE = 0x00300000;
const STACK_SIZE = 0x10000;

function fakeCpu(){
    return {
        parkAddress: ()=>PARK,
        /** @param {any} state */
        newContext: state=>({ ...state }),
    };
}

function fakeMemory(){
    /** @type {Map<number, number>} */
    const words = new Map();
    /** @type {any[]} */
    const regions = [];
    return {
        words,
        regions,
        RegionKind: { STACK: 'stack' },
        Access: { READ_WRITE: 'rw' },
        /** @param {any} region */
        register: region=>regions.push(region),
        /** @param {number} address @param {number} value */
        writeU32: (address, value)=>words.set(address >>> 0, value >>> 0),
    };
}

async function makeKernel(){
    const memory = fakeMemory();
    const kernel = await kernelModule.create(
        { stacks: { base: STACK_BASE, size: STACK_SIZE } },
        /** @type {any} */ ({
            /** @param {string} name */
            requireApi: name=>(name === 'cpu' ? fakeCpu() : memory),
            provide: ()=>{},
        }),
    );
    return { kernel, memory };
}

test('a new thread returns to where the caller said, not into nothing', async()=>{
    const { kernel, memory } = await makeKernel();
    const returnTo = 0x00401234;

    const thread = kernel.createThread({ entry: 0x00402000, parameter: 7, returnTo });

    assert.equal(memory.words.get(thread.stackTop), returnTo);
    assert.equal(memory.words.get(thread.stackTop + 4), 7,
        'the parameter sits above the return address, as a call would leave it');
});

test('a caller with nowhere better sends the thread to the park loop', async()=>{
    // The default is a thread that stops rather than one that returns into
    // whatever the stack happened to hold.
    const { kernel, memory } = await makeKernel();

    const thread = kernel.createThread({ entry: 0x00402000 });

    assert.equal(memory.words.get(thread.stackTop), PARK);
});

test('the stack pointer leaves room for the pops a returning thread makes', async()=>{
    // A thread that returns pops its return address, and the stub it returns
    // into pops again. A stack pointer landing exactly on the top of the region
    // puts the second pop outside the memory the thread was given, which shows
    // up as an unmapped read a long way from anything that explains it.
    const { kernel, memory } = await makeKernel();

    const thread = kernel.createThread({ entry: 0x00402000 });

    const [region] = memory.regions;
    const top = region.base + region.size;
    assert.ok(thread.stackTop <= top - 16, 'at least two frames of headroom');
    assert.ok(thread.stackTop > region.base, 'and still inside the stack');
});

test('each thread gets a stack of its own, registered like any other memory', async()=>{
    // A stack that runs into its neighbour is caught by the region map rather
    // than by the corruption it causes.
    const { kernel, memory } = await makeKernel();

    const first = kernel.createThread({ entry: 0x00402000 });
    const second = kernel.createThread({ entry: 0x00402000 });

    assert.equal(memory.regions.length, 2);
    assert.notEqual(first.stackTop, second.stackTop);
    assert.ok(Math.abs(first.stackTop - second.stackTop) >= STACK_SIZE);
});

test('the first thread may bring its own stack', async()=>{
    // The process starts on the stack it was given, not one from the pool.
    const { kernel, memory } = await makeKernel();

    const thread = kernel.createThread({ entry: 0x00402000, stackTop: 0x00280000 });

    assert.equal(memory.regions.length, 0, 'nothing was allocated for it');
    assert.equal(thread.stackTop, 0x00280000 - 16);
});
