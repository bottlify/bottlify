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
import { flushWrites, kernelModule } from './module.js';
import { createMetrics } from '../log/internal/metrics.js';
import { openTable } from '@bottlify/cellar';

const PARK = 0xf000dead;
const STACK_BASE = 0x00300000;
const STACK_SIZE = 0x10000;

/** @param {number} [esp]  What the stack pointer reads while a call is in flight. */
function fakeCpu(esp = 0){
    return {
        parkAddress: ()=>PARK,
        /** @param {any} state */
        newContext: state=>({ ...state, reg32: new Int32Array(8) }),
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
        register: region=>{
            const clash = regions.find(other=>
                region.base < other.base + other.size && other.base < region.base + region.size);
            if (clash)
            {
                throw new Error(`${region.name} overlaps ${clash.name}`);
            }
            regions.push(region);
        },
        /** @param {string} name */
        unregister: name=>regions.splice(regions.findIndex(region=>region.name === name), 1),
        /** @param {number} address @param {number} value */
        writeU32: (address, value)=>words.set(address >>> 0, value >>> 0),
        /** @param {number} address */
        readU32: address=>words.get(address >>> 0) ?? 0,
    };
}

/**
 * Whether what `ref` points at is let go of: collected after the tasks a
 * disposed machine had already queued have run. A timer or a turn queued
 * before `dispose` may hold it for a moment and lets go when it runs; under
 * a loaded machine that moment outlasts a few turns of the event loop. Held
 * still after a second of timers and collections is held for good - a leak.
 *
 * @param {WeakRef<object>} ref @param {() => void} gc
 */
async function letGo(ref, gc){
    for (const until = Date.now() + 1000; Date.now() < until;)
    {
        await new Promise(done=>setTimeout(done, 10));
        gc();
        if (ref.deref() === undefined)
        {
            return true;
        }
    }
    return false;
}

/** @param {number} [esp]  What the stack pointer reads while a call is in flight. */
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

test('a thread begun in a routine of the loader finds its start routine above it', async()=>{
    const { kernel, memory } = await makeKernel();

    const thread = kernel.createThread({
        entry: 0x00403000, parameter: 7, returnTo: 0x00401234, start: 0x00402000,
    });

    assert.equal(memory.words.get(thread.stackTop), 0x00401234);
    assert.equal(memory.words.get(thread.stackTop + 4), 7);
    assert.equal(memory.words.get(thread.stackTop + 8), 0x00402000);
    assert.equal(thread.entry, 0x00402000, 'named by its own routine');
    assert.equal(memory.words.get(kernel.createThread({ entry: 0x00402000 }).stackTop + 8),
        undefined, 'nothing written there for a thread without one');
});

test('a new thread\'s context names its start routine and parameter, a first thread its entry'
    + ' point and process block', async()=>{
    // What GetThreadContext reads of a thread not yet run, as on Windows'
    // i386: EAX the start routine, EBX its parameter. A debugger or a
    // launcher that hollows its suspended child reads the entry point there.
    const { kernel } = await makeKernel();
    const loaderStarted = kernel.createThread({ entry: 0x00403000, parameter: 7,
        start: 0x00402000 });
    assert.equal(loaderStarted.context.reg32[0], 0x00402000, 'the start routine, not the loader');
    assert.equal(loaderStarted.context.reg32[3], 7);
    const plain = kernel.createThread({ entry: 0x00402000, parameter: 9 });
    assert.deepEqual([plain.context.reg32[0], plain.context.reg32[3]], [0x00402000, 9]);
    const first = kernel.createThread({ entry: 0x00405000, first: { entry: 0x00401000,
        block: 0x7ffdf000 } });
    assert.equal(first.context.reg32[0], 0x00401000, 'the image\'s entry point');
    assert.equal(first.context.reg32[3] >>> 0, 0x7ffdf000, 'the process block');
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
    // The thread block's StackBase is the stack's top, a page boundary, as
    // a program finding its stack from the address of a local reads it.
    assert.equal(thread.stackBase, top, 'its base is the region\'s top, not the first frame');
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
    assert.equal(thread.stackBase, 0x00280000);
});

/**
 * A kernel whose threads can be given the CPU, over a pool with room for
 * `slots` stacks of the default size.
 *
 * @param {number} slots @param {number} [size]
 */
async function makeRunningKernel(slots, size = STACK_SIZE){
    const memory = fakeMemory();
    /** @type {[number, number][]} */
    const noted = [];
    const cpu = {
        ...fakeCpu(),
        /** @param {number} base @param {number} bytes */
        noteStack: (base, bytes)=>noted.push([base, bytes]),
        captureContext: ()=>({}),
        restoreContext: ()=>{},
        resumeContextAt: ()=>{},
        runSlice: ()=>0,
        eip: ()=>0,
    };
    const kernel = await kernelModule.create(
        { stacks: { base: STACK_BASE, size, limit: STACK_BASE + slots * size } },
        /** @type {any} */ ({
            /** @param {string} name */
            requireApi: name=>(name === 'cpu' ? cpu : name === 'log' ? {} : memory),
            provide: ()=>{},
        }),
    );
    return { kernel, memory, noted };
}

test('a fiber stack comes from the thread stack pool, is known to the translator, and goes back'
    + ' to the pool once given back', async()=>{
    const { kernel, memory, noted } = await makeRunningKernel(2);
    const stack = kernel.allocateStack({});
    assert.ok(stack);
    assert.equal(stack.top - stack.base, STACK_SIZE);
    assert.deepEqual(noted, [[stack.base, STACK_SIZE]], 'noted as a thread stack is');
    assert.ok(kernel.createThread({ entry: 0x00402000, name: 'beside it' }));
    assert.equal(kernel.allocateStack({}), null, 'a full pool has no room for another');

    kernel.releaseStack(stack);
    const again = kernel.allocateStack({});
    assert.equal(again?.base, stack.base, 'the one given back is given out again');
    assert.equal(memory.regions.length, 2);
});

test('a thread that exits gives its stack back, and the next thread is given it', async()=>{
    // Otherwise a program that makes a worker per task and lets each one end
    // runs out of room after as many threads as the pool holds stacks, having
    // never had more than two alive.
    const { kernel, memory } = await makeRunningKernel(2);
    const first = kernel.createThread({ entry: 0x00402000, name: 'first' });
    const second = kernel.createThread({ entry: 0x00402000, name: 'second' });
    assert.equal(kernel.createThread({ entry: 0x00402000, name: 'third' }), null,
        'a full pool refuses a thread rather than throwing out of the machine');

    kernel.runOnce();
    assert.equal(kernel.currentThread(), first);
    kernel.exitThread(first, 0);
    kernel.runOnce();
    assert.equal(kernel.currentThread(), second);

    const third = kernel.createThread({ entry: 0x00402000, name: 'third' });
    assert.notEqual(third, null);
    assert.equal(third.stackLimit, first.stackLimit, 'on the stack the first one left');
    assert.equal(memory.regions.length, 2, 'the first one\'s region went with it');

    for (let round = 0; round < 64; round++)
    {
        const worker = kernel.createThread({ entry: 0x00402000, name: `worker-${round}` });
        assert.equal(worker, null, 'the pool is full again: second and third are alive');
    }
});

test('a thread ended by another keeps its stack', async()=>{
    // Microsoft's "Thread Stack Size": a stack is freed when its thread exits,
    // and not when the thread is terminated by another thread.
    const { kernel } = await makeRunningKernel(2);
    const first = kernel.createThread({ entry: 0x00402000, name: 'first' });
    kernel.createThread({ entry: 0x00402000, name: 'second' });

    kernel.runOnce();
    kernel.runOnce();
    assert.notEqual(kernel.currentThread(), first);
    kernel.exitThread(first, 1);

    assert.equal(kernel.createThread({ entry: 0x00402000, name: 'third' }), null);
});

test('a thread is gone once it has ended and runs nowhere, a handle to it open or not', async()=>{
    // What it was given -- its stack, its environment block -- goes to the
    // next thread then; a handle kept open to read its exit code needs none.
    const { kernel } = await makeRunningKernel(4);
    const first = kernel.createThread({ entry: 0x00402000, name: 'first' });
    const second = kernel.createThread({ entry: 0x00402000, name: 'second' });
    assert.equal(kernel.threadGone(first), false, 'not before it has run');
    kernel.runOnce();
    assert.equal(kernel.currentThread(), first);
    assert.equal(kernel.threadGone(first), false, 'nor while it runs');

    kernel.exitThread(first, 0);
    assert.equal(kernel.threadGone(first), true);
    assert.equal(kernel.handles.resolve(first.handle, 'thread'), first, 'its handle still open');
    kernel.exitThread(second, 1);
    assert.equal(kernel.threadGone(second), true, 'ended by another before it ran');
});

test('a thread said to have ended itself gives its stack back whoever is running', async()=>{
    // FreeLibraryAndExitThread ends its caller once the library's detach has
    // run, and by then another thread may be on the processor. The caller
    // still ended itself, and its stack is the next thread's.
    const { kernel } = await makeRunningKernel(2);
    const first = kernel.createThread({ entry: 0x00402000, name: 'first' });
    kernel.createThread({ entry: 0x00402000, name: 'second' });

    kernel.runOnce();
    kernel.runOnce();
    assert.notEqual(kernel.currentThread(), first);
    kernel.exitThread(first, 1, true);

    const third = kernel.createThread({ entry: 0x00402000, name: 'third' });
    assert.notEqual(third, null);
    assert.equal(third.stackLimit, first.stackLimit, 'on the stack the first one left');
});

test('a stack size asked for is honoured the way CreateThread honours it', async()=>{
    const MEGABYTE = 0x100000;
    const { kernel } = await makeRunningKernel(64, MEGABYTE);
    /** @param {any} options */
    const reserve = options=>{
        const thread = kernel.createThread({ entry: 0x00402000, ...options });
        return thread.stackTop + 16 - thread.stackLimit;
    };

    assert.equal(reserve({}), MEGABYTE, 'nothing asked is the default reserve');
    assert.equal(reserve({ stackSize: 0x8000 }), MEGABYTE,
        'a commit below the default reserve leaves the reserve alone');
    assert.equal(reserve({ stackSize: 0x180000 }), 2 * MEGABYTE,
        'a commit at or above it raises the reserve to it, to a whole megabyte');
    assert.equal(reserve({ stackSize: 8 * MEGABYTE }), 8 * MEGABYTE);
    assert.equal(reserve({ stackReserve: 0x18000 }), 0x20000,
        'a reserve is itself, to the allocation granularity');
});

/** A log layer that publishes into tables the test can read back. */
function fakeLog(){
    /** @type {string[]} */
    const words = [];
    return {
        words,
        metrics: createMetrics(),
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

    const threads = openTable(tables.threads).all();
    assert.equal(threads.length, 1);
    assert.equal(log.words[threads[0].name], 'main');
    assert.equal(openTable(tables.pages).values[0], 100, 'the slice at 0x1000 is on page 0');
    assert.equal(openTable(tables.counters).row(0).turns, 1);

    const metrics = /** @type {any} */ (kernelModule.diagnostics().metrics);
    assert.deepEqual(metrics.sync,
        { objects: 2, event: 1, mutex: 1, semaphore: 0, timer: 0, sets: 0, setsOfSet: 0,
            resets: 0, resetsOfClear: 0, semaphoreReleases: 0, semaphoreWakes: 0, waits: '{}' },
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
        { objects: 3, event: 2, mutex: 1, semaphore: 0, timer: 0, sets: 0, setsOfSet: 0,
            resets: 0, resetsOfClear: 0, semaphoreReleases: 0, semaphoreWakes: 0, waits: '{}' },
        'diagnostics reports the second (most recent) instance');

    await kernelModule.dispose();
});

test('parking a thread keeps where its stub leaves the stack, for the resume', async()=>{
    // Whether the stub's `ret` runs before or after the thread is switched
    // away is the engine's business; the resume must not depend on it.
    const { kernel, memory } = await makeKernel(0x2ffed0);
    const thread = kernel.createThread({ entry: 0x00402000, name: 'main' });
    memory.words.set(0x2ffed0, 0x007e8166);
    kernel.parkThread(thread, 0x2ffedc);
    assert.equal(thread.parkedReturn, 0x007e8166);
    assert.equal(thread.resumeStack, 0x2ffedc);
    assert.equal(memory.words.get(0x2ffed0), PARK);
});
test('a thread parked or held in its call ends its turn there', async()=>{
    // Run on, it took its stub's `ret` into the park loop and the loop's `hlt`;
    // ended there by something else, the resume took the `ret` and neither
    // ran -- so what the thread retired depended on what else happened.
    const memory = fakeMemory();
    let stops = 0;
    const cpu = { ...fakeCpu(0x2ffed0), stop: ()=>{
        stops++;
    } };
    const kernel = await kernelModule.create(
        { stacks: { base: STACK_BASE, size: STACK_SIZE } },
        /** @type {any} */ ({
            /** @param {string} name */
            requireApi: name=>(name === 'cpu' ? cpu : memory),
            provide: ()=>{},
        }),
    );
    const thread = kernel.createThread({ entry: 0x00402000, name: 'main' });
    memory.words.set(0x2ffed0, 0x007e8166);
    kernel.parkThread(thread, 0x2ffedc);
    assert.equal(stops, 1, 'parked');
    memory.words.set(0x2ffed0, 0x007e8166);
    assert.equal(kernel.holdThread(), 0x007e8166);
    assert.equal(stops, 2, 'held');
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

test('a suspended waiter is passed over by what it waits on, and a resume does not end the wait',
    async()=>{
        // Suspended, a thread runs nothing, so a signal handed to it is a
        // signal nobody can act on: the other waiter starves for as long as
        // the suspension lasts. And resumed, it goes back to its wait, which
        // only its object can end.
        const { kernel } = await makeKernel();
        const first = kernel.createThread({ entry: 0x00402000, name: 'first' });
        const second = kernel.createThread({ entry: 0x00402000, name: 'second' });
        const event = kernel.createEvent({});

        assert.equal(kernel.wait(event, first), null);
        assert.equal(kernel.suspendThread(first), 0);
        assert.equal(kernel.wait(event, second), null);
        kernel.setEvent(event);
        assert.equal(second.state, 'ready', 'the signal goes to the waiter that can run');
        assert.equal(first.state, 'blocked', 'the suspended one is still waiting');
        assert.equal(event.signalled, false);

        assert.equal(kernel.resumeThread(first), 1);
        assert.equal(first.state, 'blocked', 'nothing signalled it, so it is still waiting');
        kernel.setEvent(event);
        assert.equal(first.state, 'ready', 'and the next signal is its own');
        assert.equal(first.waitResult, kernel.WaitResult.OBJECT_0);
    });

test('a wait satisfied while its thread was suspended ends when the thread is resumed', async()=>{
    const { kernel } = await makeKernel();
    const thread = kernel.createThread({ entry: 0x00402000, name: 'worker' });
    const quiet = kernel.createEvent({});
    const open = kernel.createEvent({ manualReset: true });

    assert.equal(kernel.waitAny([quiet, open], thread), null);
    kernel.suspendThread(thread);
    kernel.suspendThread(thread);
    kernel.setEvent(open);
    assert.equal(thread.state, 'blocked');

    assert.equal(kernel.resumeThread(thread), 2);
    assert.equal(thread.state, 'blocked', 'still suspended once');
    assert.equal(kernel.resumeThread(thread), 1);
    assert.equal(thread.state, 'ready');
    assert.equal(thread.waitResult, 1, 'with the index of the object that came');
    assert.deepEqual(quiet.waiters, [], 'and out of the queue of the one that did not');
});

test('a resumed thread whose last wait was answered is not handed its old objects', async()=>{
    const { kernel } = await makeKernel();
    const thread = kernel.createThread({ entry: 0x00402000, name: 'worker' });
    const event = kernel.createEvent({ manualReset: true });

    assert.equal(kernel.wait(event, thread), null);
    kernel.setEvent(event);
    kernel.block(thread, 'something of its own');
    kernel.suspendThread(thread);
    kernel.resumeThread(thread);
    assert.equal(thread.state, 'blocked', 'the block it is in now is not the old wait');
});

test('a thread carries at most MAXIMUM_SUSPEND_COUNT suspensions', async()=>{
    const { kernel } = await makeKernel();
    const thread = kernel.createThread({ entry: 0x00402000, name: 'worker' });

    for (let count = 0; count < 127; count++)
    {
        assert.equal(kernel.suspendThread(thread), count);
    }
    assert.equal(kernel.suspendThread(thread), null, 'the next one is refused');
    assert.equal(kernel.resumeThread(thread), 127, 'and did not add to the count');
});

test('the clock is not moved to a deadline while another process of the run may answer the wait'
    + ' first', async()=>{
    // A parent that starts a child and waits for it with a timeout - ngen
    // giving its compile worker thirty seconds to say it is up - has a clock
    // behind the host's by every slow turn it ran. Moved to the deadline as
    // soon as nothing of its own was ready, it timed out within the lag, in a
    // fraction of the wall time the child had to start in, and killed it.
    // While another process runs, the wait is sat through in real time.
    const memory = fakeMemory();
    const cpu = { ...fakeCpu(), captureContext: ()=>({}), restoreContext: ()=>{},
        runSlice: (/** @type {number} */ max)=>max };
    const kernel = await kernelModule.create(
        { stacks: { base: STACK_BASE, size: STACK_SIZE } },
        /** @type {any} */ ({
            /** @param {string} name */
            requireApi: name=>(name === 'cpu' ? cpu : memory),
            provide: ()=>{},
        }),
    );
    const thread = kernel.createThread({ entry: 0x00402000, name: 'parent' });
    const child = kernel.createEvent({});
    assert.equal(kernel.wait(child, thread, { deadline: kernel.clock.virtualTime() + 20,
        result: 0x102 }), null, 'the wait blocks');
    // The host runs ahead of the guest's clock, as a slow machine's does.
    await new Promise(done=>setTimeout(done, 60));

    let others = true;
    kernel.othersRunningWith(()=>others);
    kernel.runOnce();
    assert.equal(kernel.clock.virtualTime(), 0, 'the clock stays where it was');
    assert.equal(thread.state, 'blocked', 'and the wait goes on');

    others = false;
    kernel.runOnce();
    assert.equal(kernel.clock.virtualTime(), 20, 'alone, the machine moves it to the deadline');
    assert.equal(thread.waitResult, 0x102, 'and the wait times out');
    await kernelModule.dispose();
});

test('the cpu layer is given the guest\'s clock, for the time-stamp counter', async()=>{
    /** @type {(() => number) | null} */
    let given = null;
    const cpu = { ...fakeCpu(), useGuestClock: (/** @type {() => number} */ readMs)=>{
        given = readMs;
    } };
    const kernel = await kernelModule.create(
        { stacks: { base: STACK_BASE, size: STACK_SIZE } },
        /** @type {any} */ ({
            /** @param {string} name */
            requireApi: name=>(name === 'cpu' ? cpu : fakeMemory()),
            provide: ()=>{},
        }),
    );
    assert.ok(given !== null, 'the kernel hands its clock over');
    kernel.clock.advance(250);
    assert.equal(/** @type {() => number} */ (given)(), kernel.clock.virtualTime());
    assert.equal(kernel.clock.virtualTime(), 250);
    await kernelModule.dispose();
});

test('a thread ended while it waits leaves the queue, and a live waiter gets the signal', async()=>{
    const { kernel } = await makeKernel();
    const dying = kernel.createThread({ entry: 0x00402000, name: 'dying' });
    const living = kernel.createThread({ entry: 0x00402000, name: 'living' });
    const event = kernel.createEvent({});

    assert.equal(kernel.wait(event, dying), null);
    assert.equal(kernel.wait(event, living), null);
    kernel.exitThread(dying, 0);
    assert.deepEqual(event.waiters, [living], 'the ended thread is no longer queued');
    kernel.setEvent(event);
    assert.equal(living.state, 'ready', 'an auto-reset signal reaches the live one');
});

test('a process is found by id in the run\'s directory, whichever process started it', async()=>{
    const directory = new Map();
    /** @param {any} config */
    const kernelWith = async config=>/** @type {any} */ (await kernelModule.create(
        { stacks: { base: STACK_BASE, size: STACK_SIZE }, ...config },
        /** @type {any} */ ({
            /** @param {string} name */
            requireApi: name=>(name === 'cpu' ? fakeCpu() : fakeMemory()),
            provide: ()=>{},
        })));
    const ids = { thread: 1, process: 0x2000 };
    const parent = await kernelWith({ processDirectory: directory, ids });
    const other = await kernelWith({ processDirectory: directory, ids });
    const child = parent.processes.create({ imagePath: 'C:\\a.exe', commandLine: 'a' });
    assert.equal(parent.processes.find(child.id), child, 'its parent finds it');
    assert.equal(other.processes.find(child.id), child, 'and so does a process beside it');
    assert.equal(other.processes.find(0x9998), null);
});

test('a child that outlives the process that made it sets its exit when it ends, and the run lists'
    + ' it', async()=>{
    // A launcher starts a child suspended and exits; another process of the
    // run finds the child, resumes it and waits for it to end.
    const { createKernelModule } = await import('./module.js');
    const directory = new Map();
    const ids = { thread: 1, process: 0x5000 };
    /** @param {any} module */
    const machine = async module=>/** @type {any} */ (await module.create(
        { stacks: { base: STACK_BASE, size: STACK_SIZE }, processDirectory: directory, ids },
        /** @type {any} */ ({
            /** @param {string} name */
            requireApi: name=>(name === 'cpu' ? fakeCpu() : fakeMemory()),
            provide: ()=>{},
        })));
    const launcherModule = createKernelModule();
    const launcher = await machine(launcherModule);
    const root = await machine(createKernelModule());
    const child = launcher.processes.create({ imagePath: 'C:\\a.exe', commandLine: 'a' });
    assert.deepEqual(root.processes.run(), [child], 'the run lists it, whoever made it');
    await launcherModule.dispose();
    assert.equal(root.processes.find(child.id).exited.signalled, false);
    launcher.processes.finish(child, 0);
    assert.equal(child.exitCode, 0);
    assert.equal(root.processes.find(child.id).exited.signalled, true,
        'its exit is set though its maker is gone');
});

test('a thread of another process that waits on a child\'s exit before its maker ends is woken'
    + ' when the child ends', async()=>{
    // The root waits on the child the launcher made, then the launcher exits
    // before the child does: the root's wait is in the exit event's queue, and
    // the event the gone launcher leaves must still be the one it waits on.
    const { createKernelModule } = await import('./module.js');
    const directory = new Map();
    const ids = { thread: 1, process: 0x6000 };
    /** @param {any} module */
    const machine = async module=>/** @type {any} */ (await module.create(
        { stacks: { base: STACK_BASE, size: STACK_SIZE }, processDirectory: directory, ids },
        /** @type {any} */ ({
            /** @param {string} name */
            requireApi: name=>(name === 'cpu' ? fakeCpu() : fakeMemory()),
            provide: ()=>{},
        })));
    const launcherModule = createKernelModule();
    const launcher = await machine(launcherModule);
    const root = await machine(createKernelModule());
    const child = launcher.processes.create({ imagePath: 'C:\\a.exe', commandLine: 'a' });
    const waiter = root.createThread({ entry: 0x00402000, name: 'waiter' });
    assert.equal(root.wait(root.processes.find(child.id).exited, waiter), null, 'it waits');
    await launcherModule.dispose();
    launcher.processes.finish(child, 3);
    assert.equal(waiter.state, 'ready', 'the child\'s end wakes the wait made before');
});

test('a gone process\'s record in the run\'s directory keeps its exit, not its memory', async()=>{
    const { setFlagsFromString } = await import('node:v8');
    const { runInNewContext } = await import('node:vm');
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc');
    const { createKernelModule } = await import('./module.js');
    const directory = new Map();
    const ids = { thread: 1, process: 0x3000 };
    /** @type {WeakRef<object>} */
    let memoryOfGone = new WeakRef({});
    await (async()=>{
        const module = createKernelModule();
        const memory = fakeMemory();
        memoryOfGone = new WeakRef(memory);
        const kernel = /** @type {any} */ (await module.create(
            { stacks: { base: STACK_BASE, size: STACK_SIZE }, processDirectory: directory, ids },
            /** @type {any} */ ({
                /** @param {string} name */
                requireApi: name=>(name === 'cpu' ? fakeCpu() : memory),
                provide: ()=>{},
            })));
        // As a COM server enters itself: its own record, its own exit event.
        const self = { kind: 'process', id: 0x3004, completed: false,
            exited: kernel.createEvent({ manualReset: true, signalled: false,
                name: 'process 0x3004' }) };
        directory.set(self.id, self);
        kernel.setEvent(self.exited);
        self.completed = true;
        await module.dispose();
    })();
    await new Promise(done=>setImmediate(done));
    gc();
    const record = directory.get(0x3004);
    assert.equal(record.exited.signalled, true, 'a wait on its exit still returns at once');
    assert.equal(record.exited.manualReset, true);
    assert.ok(await letGo(memoryOfGone, gc), 'and its memory is nobody\'s');
});

test('a gone process on this thread gives its names back, and a name another process still holds'
    + ' keeps its object\'s state, not the gone machine', async()=>{
    const { setFlagsFromString } = await import('node:v8');
    const { runInNewContext } = await import('node:vm');
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc');
    const { createKernelModule } = await import('./module.js');
    const { createNamedObjects } = await import('../win32/kernel32/named-objects.js');
    // The run's one namespace, and the process that stays.
    const table = new Map();
    const ids = { thread: 1, process: 0x3000 };
    /** @param {any} memory */
    const machine = async memory=>{
        const module = createKernelModule();
        const kernel = /** @type {any} */ (await module.create(
            { stacks: { base: STACK_BASE, size: STACK_SIZE }, ids },
            /** @type {any} */ ({
                /** @param {string} name */
                requireApi: name=>(name === 'cpu' ? fakeCpu() : memory),
                provide: ()=>{},
            })));
        const named = createNamedObjects({ table });
        return { module, kernel, named,
            ended: ()=>named.ended(object=>kernel.forsake(object)) };
    };
    const staying = await machine(fakeMemory());
    const waiter = staying.kernel.createThread({ entry: 0x00402000, name: 'waiter' });
    /** @type {WeakRef<object>} */
    let memoryOfGone = new WeakRef({});
    /** @type {any} */
    let ready = null;
    await (async()=>{
        const memory = fakeMemory();
        memoryOfGone = new WeakRef(memory);
        const gone = await machine(memory);
        const owner = gone.kernel.createThread({ entry: 0x00402000, name: 'owner' });
        ready = gone.kernel.createEvent({ manualReset: true, name: 'Local\\Ready' });
        gone.named.remember('Local\\Ready', 'event', ready, false, ()=>{});
        const lock = gone.kernel.createMutex({ name: 'Local\\Lock' });
        gone.named.remember('Local\\Lock', 'mutex', lock, false, ()=>{});
        const alone = gone.kernel.createEvent({ name: 'Local\\Alone' });
        gone.named.remember('Local\\Alone', 'event', alone, false, ()=>{});
        assert.equal(gone.kernel.poll(lock, owner), 0, 'its thread holds the lock');
        // The process that stays opens two of the names, and waits on the lock.
        staying.named.reference(staying.named.existing('Local\\Ready', 'event'));
        staying.named.reference(staying.named.existing('Local\\Lock', 'mutex'));
        assert.equal(staying.kernel.wait(lock, waiter), null);
        gone.kernel.setEvent(ready);
        gone.ended();
        await gone.module.dispose();
    })();
    // The object namespace's own directories and links are the run's, not a process's.
    const names = ()=>[...table]
        .filter(([, held])=>held.kind !== 'objdir' && held.kind !== 'symlink')
        .map(([name])=>name);
    // Local\X is kept under the key X, as a native call names it.
    assert.deepEqual(names().sort(), ['Lock', 'Ready'],
        'a name only the gone process held is free again');
    assert.equal(waiter.waitResult, 0x80, 'the lock went to the waiter, abandoned');
    assert.ok(await letGo(memoryOfGone, gc), 'the gone machine\'s memory is nobody\'s');
    assert.equal(staying.kernel.poll(ready, waiter), 0, 'the event it set stays set');
    staying.kernel.resetEvent(ready);
    assert.equal(staying.kernel.poll(ready, waiter), null, 'and works on as an object of the run');
    staying.ended();
    assert.deepEqual(names(), [], 'the last process gone, every name is free');
});

test('a process in a worker of its own finds a process of the run by id across the link: its'
    + ' exit is a stand-in for the run\'s event, and its code is asked there', async()=>{
    const { objectHandlers } = await import('../../system-objects.js');
    const { createSyncObjects } = await import('./internal/sync.js');
    const run = createSyncObjects({ scheduler: { block(){}, wake(){}, onTimeout(){} } });
    const record = { kind: 'process', id: 0x1fb8, threadId: 0x1fb9, imagePath: 'C:\\ngen.exe',
        completed: false, exitCode: 259,
        exited: run.createEvent({ manualReset: true, signalled: false, name: 'process 8120' }) };
    const { objects } = objectHandlers({ table: new Map(),
        processes: new Map([[record.id, record]]), wake: ()=>Promise.resolve() });
    const kernel = /** @type {any} */ (await kernelModule.create(
        { stacks: { base: STACK_BASE, size: STACK_SIZE },
            remoteObjects: { ...objects, onWake(){} } },
        /** @type {any} */ ({
            /** @param {string} name */
            requireApi: name=>(name === 'cpu' ? fakeCpu() : fakeMemory()),
            provide: ()=>{},
        })));
    const found = kernel.processes.find(0x1fb8);
    assert.equal(found.kind, 'process');
    assert.equal(found.imagePath, 'C:\\ngen.exe');
    assert.equal(typeof found.exited.remote, 'number', 'its exit is the run\'s object');
    assert.equal(found.exitCode, 259, 'still active');
    assert.equal(found.completed, false);
    assert.equal(kernel.processes.find(0x1fb8), found, 'one record however often it is opened');
    record.completed = true;
    record.exitCode = 5;
    run.setEvent(record.exited);
    assert.equal(found.exitCode, 5, 'its code once it has exited');
    assert.equal(found.completed, true);
    assert.equal(kernel.processes.find(0x2222), null, 'an id no process of the run has');
});

test('a flush of write buffers waits until each executor running guest code has passed a barrier',
    async()=>{
        // Executor 1 runs guest code (odd), 2 waits between slices (even).
        const epochs = [7, 4];
        const cpu = { executorEpochs: ()=>epochs.slice() };
        /** @type {(() => void)[]} */
        const looks = [];
        let time = 0;
        const flushed = flushWrites(cpu, { now: ()=>(time += 5), later: look=>looks.push(look) });
        assert.ok(flushed instanceof Promise, 'a run still on is waited for');
        let done = false;
        flushed.then(()=>{ done = true; });
        looks.shift()?.();
        await Promise.resolve();
        assert.equal(done, false, 'not done while executor 1 is still in that run');
        epochs[0] = 8;
        epochs[1] = 5;
        looks.shift()?.();
        await flushed;
        assert.equal(done, true,
            'done once it ended the run; a run begun after the call is not waited for');
        assert.equal(flushWrites({ executorEpochs: ()=>[2, 6] }), true,
            'no executor in guest code: done at once');
        assert.equal(flushWrites({}), true, 'one executor: nothing to wait for');
    });

test('a 64-bit thread parked or held keeps a return past 4 GiB whole, and the park loop\'s',
    async()=>{
        // A 64-bit program's image at its own base past 4 GiB: the return address
        // its stub would pop is that whole quadword, and the park loop written over
        // it leaves no high dword of the caller's beside it.
        const memory = fakeMemory();
        const kernel = await kernelModule.create(
            { stacks: { base: STACK_BASE, size: STACK_SIZE } },
            /** @type {any} */ ({
                /** @param {string} name */
                requireApi: name=>(name === 'cpu'
                    ? { ...fakeCpu(0x2ffed0), bits: ()=>64 } : memory),
                provide: ()=>{},
            }),
        );
        /** @type {any} */
        const thread = { name: 'main' };
        memory.words.set(0x2ffed0, 0x40001202);
        memory.words.set(0x2ffed4, 1);
        kernel.parkThread(thread, 0x2ffed8);
        assert.equal(thread.parkedReturn, 0x140001202);
        assert.equal(memory.words.get(0x2ffed0), PARK);
        assert.equal(memory.words.get(0x2ffed4), 0, 'the park loop whole');
        memory.words.set(0x2ffed0, 0x40001202);
        memory.words.set(0x2ffed4, 1);
        assert.equal(kernel.holdThread(), 0x140001202);
        assert.equal(memory.words.get(0x2ffed4), 0);
    });

test('a 64-bit thread starts with a parameter and a routine past 4 GiB whole', async()=>{
    // RCX and RDX of the new thread: the dword view of its context carries
    // their low halves, so the whole values are set through the context's own
    // quadwords - and only where there is a high half to set.
    const memory = { ...fakeMemory(), writeBytes: ()=>{} };
    /** @type {{ gpr: bigint[] }[]} */
    const set = [];
    const kernel = await kernelModule.create(
        { stacks: { base: STACK_BASE, size: STACK_SIZE } },
        /** @type {any} */ ({
            /** @param {string} name */
            requireApi: name=>(name === 'cpu' ? {
                ...fakeCpu(), bits: ()=>64,
                /** @param {any} state */
                newContext: state=>({ ...state, reg32: new Array(8).fill(0) }),
                /** @param {any} context @param {{ gpr: bigint[] }} long */
                setContextLong: (context, long)=>set.push(long),
            } : memory),
            provide: ()=>{},
        }),
    );
    const high = kernel.createThread({ entry: 0x402000, start: 0x140001740,
        parameter: 0x140003010 });
    assert.deepEqual([high.context.reg32[1], high.context.reg32[2]], [0x40003010, 0x40001740]);
    assert.equal(set.length, 1);
    assert.deepEqual([set[0].gpr[1], set[0].gpr[2]], [0x140003010n, 0x140001740n]);
    assert.equal(0 in set[0].gpr, false, 'no other register is touched');
    kernel.createThread({ entry: 0x402000, start: 0x401000, parameter: 0x90000000 });
    assert.equal(set.length, 1, 'a thread below 4 GiB starts as it always did');
});
