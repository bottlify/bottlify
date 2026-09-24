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
import { createMetrics } from '../log/internal/metrics.js';
import { readTable } from '../log/internal/table.js';

const PARK = 0xf000dead;
const STACK_BASE = 0x00300000;
const STACK_SIZE = 0x10000;

/** @param {number} [esp]  What the stack pointer reads while a call is in flight. */
function fakeCpu(esp = 0){
    return {
        parkAddress: ()=>PARK,
        /** @param {any} state */
        newContext: state=>({ ...state }),
        /** @param {string} name */
        readReg32: name=>(name === 'esp' ? esp : 0),
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
        /** @param {number} address */
        readU32: address=>words.get(address >>> 0) ?? 0,
    };
}

/** @param {number} [esp] */
async function makeKernel(esp){
    const memory = fakeMemory();
    const kernel = await kernelModule.create(
        { stacks: { base: STACK_BASE, size: STACK_SIZE } },
        /** @type {any} */ ({
            /** @param {string} name */
            requireApi: name=>(name === 'cpu' ? fakeCpu(esp) : memory),
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

/** A log layer that publishes into tables the test can read back. */
function fakeLog(){
    /** @type {string[]} */
    const words = [];
    return {
        words,
        metrics: createMetrics({ shared: false }),
        /** @param {string} text */
        intern: text=>{
            const at = words.indexOf(text);
            return at >= 0 ? at : words.push(text) - 1;
        },
    };
}

test('the kernel publishes its figures as tables and keeps the object tables cold', async()=>{
    const log = fakeLog();
    const memory = fakeMemory();
    const kernel = await kernelModule.create(
        { stacks: { base: STACK_BASE, size: STACK_SIZE } },
        /** @type {any} */ ({
            /** @param {string} name */
            requireApi: name=>(name === 'cpu' ? { ...fakeCpu(), layout: { memorySize: 0x100000 },
                captureContext: ()=>({}), restoreContext: ()=>{}, runSlice: ()=>100,
                eip: ()=>0x1000, readReg32: ()=>STACK_BASE + 0x8000 }
                : name === 'log' ? log : memory),
            provide: ()=>{},
        }));
    const tables = log.metrics.describe().kernel;
    assert.deepEqual(Object.keys(tables).sort(), ['counters', 'pages', 'slowSlices', 'threads']);
    assert.equal(tables.pages.rows, 0x100000 / 0x10000 + 1, 'one row per page of guest memory');

    kernel.createThread({ entry: 0x1000, name: 'main' });
    kernel.runOnce();
    kernel.createEvent({ name: 'ready' });
    kernel.createMutex({});
    log.metrics.sample();

    const threads = readTable(tables.threads).all();
    assert.equal(threads.length, 1);
    assert.equal(log.words[threads[0].name], 'main');
    assert.equal(readTable(tables.pages).values[0], 100, 'the slice at 0x1000 is on page 0');
    assert.equal(readTable(tables.counters).row(0).turns, 1);

    const metrics = /** @type {any} */ (kernelModule.diagnostics().metrics);
    assert.deepEqual(metrics.sync,
        { objects: 2, event: 1, mutex: 1, semaphore: 0, timer: 0 },
        'counts in the snapshot; the rows only by name');
    assert.equal(kernel.syncObjects().length, 2);
    await kernelModule.dispose();
});

test('a second instance in one realm does not take the first one\'s state', async()=>{
    const { kernel: first } = await makeKernel();
    first.createThread({ entry: 0x00402000, name: 'first-thread' });
    first.createMutex({ name: 'first-mutex' });

    const { kernel: second } = await makeKernel();
    second.createThread({ entry: 0x00402000, name: 'second-thread' });
    second.createEvent({ name: 'second-event' });
    second.createEvent({ name: 'second-event-2' });

    assert.equal(first.threads().length, 1, 'the first instance keeps only its own thread');
    assert.equal(first.threads()[0].name, 'first-thread');
    assert.equal(first.syncObjects().length, 1, 'and only its own sync object');
    assert.equal(first.syncObjects()[0].kind, 'mutex');

    await kernelModule.dispose();
});

test('a disposed kernel answers harmlessly rather than throwing', async()=>{
    const { kernel } = await makeKernel();
    const thread = kernel.createThread({ entry: 0x00402000, name: 'thread' });
    const event = kernel.createEvent({ name: 'e' });

    await kernelModule.dispose();

    assert.equal(kernel.createThread({ entry: 0x00402000 }), null);
    assert.equal(kernel.currentThread(), null);
    assert.deepEqual(kernel.threads(), []);
    assert.deepEqual(kernel.runOnce(), { ran: null, instructions: 0, switched: false });
    assert.deepEqual(kernel.diagnosticsSnapshot(), {});
    assert.deepEqual(kernel.pages(), {});
    assert.deepEqual(kernel.syncObjects(), []);
    assert.equal(kernel.nextDeadline(), null);
    kernel.exitThread(thread, 0);
    kernel.block(thread, 'x');
    assert.equal(kernel.wake(thread), false);
    kernel.onTimeout(()=>{});
    assert.equal(kernel.createEvent({}), null);
    assert.equal(kernel.createMutex({}), null);
    assert.equal(kernel.createSemaphore({ initial: 0, maximum: 1 }), null);
    assert.equal(kernel.createTimer({}), null);
    assert.equal(kernel.armTimer(event, 0, 0), false);
    kernel.cancelTimer(event);
    assert.equal(kernel.wait(event, thread), kernel.WaitResult.FAILED);
    assert.equal(kernel.poll(event, thread), kernel.WaitResult.FAILED);
    kernel.sleep(thread, 10);
    assert.equal(kernel.waitAll([event], thread), kernel.WaitResult.FAILED);
    assert.deepEqual(kernel.waitAny([event], thread),
        { index: -1, result: kernel.WaitResult.FAILED });
    assert.deepEqual(kernel.setEvent(event), []);
    kernel.resetEvent(event);
    assert.equal(kernel.releaseMutex(event, thread), false);
    assert.equal(kernel.releaseSemaphore(event, 1), 0);
    assert.equal(kernel.handles.open('thread', thread), 0);
    assert.equal(kernel.handles.resolve(thread.handle), null);
    assert.equal(kernel.handles.close(thread.handle), null);
    assert.equal(kernel.handles.typeOf(thread.handle), null);
    assert.equal(kernel.handles.holds(thread), false);
    assert.equal(kernel.processes.create({ imagePath: 'x', commandLine: 'x' }), null);
    assert.equal(kernel.processes.pending(), null);
    assert.deepEqual(kernel.processes.all(), []);
    assert.equal(kernel.processes.finished({ exitCode: 0 }), false);
});

test('diagnostics answers for the live instance', async()=>{
    await makeKernel();
    const { kernel: second } = await makeKernel();
    second.createEvent({ name: 'e' });
    second.createEvent({ name: 'e2' });
    second.createMutex({ name: 'm' });

    const diag = /** @type {any} */ (kernelModule.diagnostics());
    assert.equal(diag.status, 'ready');
    assert.deepEqual(diag.metrics.sync,
        { objects: 3, event: 2, mutex: 1, semaphore: 0, timer: 0 },
        'diagnostics reports the second (most recent) instance');

    await kernelModule.dispose();
});

test('parking a thread keeps where its stub leaves the stack, for the resume', async()=>{
    // Whether the stub's `ret` runs before or after the thread is switched
    // away is the emulator's business; the resume must not depend on it.
    const { kernel, memory } = await makeKernel(0x2ffed0);
    const thread = kernel.createThread({ entry: 0x00402000, name: 'main' });
    memory.words.set(0x2ffed0, 0x007e8166);
    kernel.parkThread(thread, 0x2ffedc);
    assert.equal(thread.parkedReturn, 0x007e8166);
    assert.equal(thread.resumeStack, 0x2ffedc);
    assert.equal(memory.words.get(0x2ffed0), PARK);
});
test('a parked thread resumes on the stack it was told, however far the stub got', async()=>{
    // The slice can end on the trap itself, before the stub's `ret` has popped
    // the return slot and the arguments. The context saved then has ESP on the
    // slot, which now holds the park address; a resume that keeps that ESP
    // returns through it into the park loop, as a ready thread nobody will
    // ever wake. So the resume names the resting stack it was given at the
    // park, and ESP no longer depends on how far the stub got.
    const memory = fakeMemory();
    const TRAP_ESP = 0x002ff090;
    const RETURN = 0x050e6e9c;
    /** @type {Map<number, number>} */
    const words = memory.words;
    words.set(TRAP_ESP, RETURN);
    /** @type {any[]} */
    const resumed = [];
    const cpu = {
        ...fakeCpu(),
        /** @param {string} name */
        readReg32: name=>(name === 'esp' ? TRAP_ESP : 0),
        captureContext: ()=>({ esp: TRAP_ESP }),
        /** @param {any} context @param {any} resume */
        resumeContextAt: (context, resume)=>resumed.push({ ...resume }),
        restoreContext: ()=>{},
        runSlice: ()=>0,
        eip: ()=>0,
    };
    const kernel = await kernelModule.create(
        { stacks: { base: STACK_BASE, size: STACK_SIZE } },
        /** @type {any} */ ({
            /** @param {string} name */
            requireApi: name=>(name === 'cpu' ? cpu
                : name === 'log' ? { debug: ()=>{} }
                    : { ...memory, readU32: (/** @type {number} */ at)=>words.get(at >>> 0) ?? 0 }),
            provide: ()=>{},
        }),
    );
    const thread = kernel.createThread({ entry: 0x00402000, name: 'main' });
    kernel.runOnce();

    kernel.parkThread(thread, TRAP_ESP + 12);
    assert.equal(words.get(TRAP_ESP), PARK, 'the return slot now holds the park address');
    kernel.block(thread, 'event "#4734"');
    kernel.wake(thread, 0);
    kernel.runOnce();

    assert.deepEqual(resumed, [{ eip: RETURN, esp: TRAP_ESP + 12, returnValue: 0 }],
        'the thread comes back at its return address with the stack at rest');
});

test('alert ends an alertable wait with the answer given, and leaves any other alone', async()=>{
    const { kernel } = await makeKernel();
    const thread = kernel.createThread({ entry: 0x00402000, name: 'worker' });
    const event = kernel.createEvent({});

    kernel.block(thread, 'something of its own');
    assert.equal(kernel.alert(thread, 0xc0), false, 'a plain wait is not ended');
    kernel.wake(thread);

    assert.equal(kernel.alertably(thread, ()=>kernel.wait(event, thread)), null);
    assert.equal(kernel.alert(thread, 0xc0), true);
    assert.equal(thread.state, 'ready');
    assert.equal(thread.waitResult, 0xc0, 'what the wait answers');
    assert.deepEqual(event.waiters, [], 'and it is no longer queued on the event');
    assert.equal(kernel.alert(thread, 0xc0), false, 'a thread not waiting is left alone');
});
