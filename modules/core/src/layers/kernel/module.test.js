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

/**
 * A kernel whose threads can be given the CPU, over a pool with room for
 * `slots` stacks of the default size.
 *
 * @param {number} slots @param {number} [size]
 */
async function makeRunningKernel(slots, size = STACK_SIZE){
    const memory = fakeMemory();
    const cpu = {
        ...fakeCpu(),
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
    return { kernel, memory };
}

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
        { objects: 2, event: 1, mutex: 1, semaphore: 0, timer: 0, sets: 0, setsOfSet: 0,
            resets: 0, resetsOfClear: 0 },
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
            resets: 0, resetsOfClear: 0 },
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
