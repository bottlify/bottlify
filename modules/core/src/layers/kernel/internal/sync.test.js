/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WaitResult, createSyncObjects } from './sync.js';

/** A scheduler stand-in that just records who was blocked and woken. */
function fakeScheduler(){
    /** @type {string[]} */
    const log = [];
    return {
        log,
        /** @param {any} thread @param {string} reason */
        block: (thread, reason)=>log.push(`block ${thread.name}: ${reason}`),
        /** @param {any} thread */
        wake: thread=>{
            log.push(`wake ${thread.name}`);
            return true;
        },
    };
}

/**
 * @param {string} name
 * @returns {{ name: string, waitResult: number | null }}
 */
const thread = name=>({ name, waitResult: null });

function setup(){
    const scheduler = fakeScheduler();
    return { scheduler, sync: createSyncObjects({ scheduler }) };
}

test('an auto-reset event releases one waiter and closes again', ()=>{
    const { scheduler, sync } = setup();
    const event = sync.createEvent({ name: 'work-ready' });
    const [a, b] = [thread('a'), thread('b')];

    assert.equal(sync.wait(event, a), null, 'nothing signalled yet, so a blocks');
    assert.equal(sync.wait(event, b), null);

    const woken = sync.setEvent(event);
    assert.deepEqual(woken.map(t=>t.name), ['a'], 'exactly one waiter is released');
    assert.equal(sync.diagnostics()[0].state, 'unsignalled', 'and the event closes behind it');
    assert.ok(scheduler.log.includes('wake a'));
});

test('a manual-reset event releases everyone and stays open', ()=>{
    const { sync } = setup();
    const event = sync.createEvent({ manualReset: true, name: 'go' });
    const [a, b, c] = [thread('a'), thread('b'), thread('c')];

    sync.wait(event, a);
    sync.wait(event, b);
    const woken = sync.setEvent(event);

    assert.deepEqual(woken.map(t=>t.name), ['a', 'b'], 'everyone waiting is released');
    assert.equal(sync.wait(event, c), WaitResult.OBJECT_0, 'and it stays open for latecomers');

    sync.resetEvent(event);
    assert.equal(sync.wait(event, c), null, 'until it is reset');
});

test('a mutex admits one thread and queues the rest', ()=>{
    const { sync } = setup();
    const mutex = sync.createMutex({ name: 'table' });
    const [a, b] = [thread('a'), thread('b')];

    assert.equal(sync.wait(mutex, a), WaitResult.OBJECT_0);
    assert.equal(sync.wait(mutex, b), null, 'b waits while a holds it');
    assert.equal(sync.diagnostics()[0].state, 'held by a');

    assert.equal(sync.releaseMutex(mutex, a), true);
    assert.equal(sync.diagnostics()[0].state, 'held by b',
        'release hands it straight to the waiter');
});

test('a mutex is recursive, and only the outermost release frees it', ()=>{
    const { sync } = setup();
    const mutex = sync.createMutex();
    const a = thread('a');

    sync.wait(mutex, a);
    assert.equal(sync.wait(mutex, a), WaitResult.OBJECT_0,
        'taking it again is a counter, not a deadlock');

    sync.releaseMutex(mutex, a);
    assert.equal(sync.diagnostics()[0].state, 'held by a', 'still held after the inner release');
    sync.releaseMutex(mutex, a);
    assert.equal(sync.diagnostics()[0].state, 'free');
});

test('only the owner can release a mutex', ()=>{
    const { sync } = setup();
    const mutex = sync.createMutex();
    const [a, b] = [thread('a'), thread('b')];

    sync.wait(mutex, a);
    assert.equal(sync.releaseMutex(mutex, b), false, 'b never held it');
    assert.equal(sync.diagnostics()[0].state, 'held by a');
});

test('a mutex whose owner died is handed over, and says so', ()=>{
    const { sync } = setup();
    const mutex = sync.createMutex({ name: 'shared-state' });
    const [a, b] = [thread('a'), thread('b')];

    sync.wait(mutex, a);
    sync.wait(mutex, b);
    sync.abandonMutexesOwnedBy(a);

    assert.equal(sync.diagnostics()[0].state, 'held by b', 'b gets it');

    // And b is told. Handing over ownership silently would turn "the state you
    // are about to read was left half-written" into "you got the mutex, carry
    // on" -- which is the whole point of the abandoned result existing.
    assert.equal(b.waitResult, WaitResult.ABANDONED);

    // The abandonment is reported once. A thread taking the mutex afterwards
    // gets an ordinary acquisition.
    sync.releaseMutex(mutex, b);
    const c = thread('c');
    assert.equal(sync.wait(mutex, c), WaitResult.OBJECT_0);
});

test('a woken waiter is told what it got', ()=>{
    const { sync } = setup();
    const event = sync.createEvent({ name: 'ready' });
    const semaphore = sync.createSemaphore({ initial: 0, maximum: 1, name: 'slot' });
    const [a, b] = [thread('a'), thread('b')];

    sync.wait(event, a);
    sync.setEvent(event);
    assert.equal(a.waitResult, WaitResult.OBJECT_0, 'the result survives the block and the wake');

    sync.wait(semaphore, b);
    sync.releaseSemaphore(semaphore);
    assert.equal(b.waitResult, WaitResult.OBJECT_0);
});

test('a semaphore admits up to its count and refuses beyond it', ()=>{
    const { sync } = setup();
    const semaphore = sync.createSemaphore({ initial: 2, maximum: 2, name: 'slots' });
    const [a, b, c] = [thread('a'), thread('b'), thread('c')];

    assert.equal(sync.wait(semaphore, a), WaitResult.OBJECT_0);
    assert.equal(sync.wait(semaphore, b), WaitResult.OBJECT_0);
    assert.equal(sync.wait(semaphore, c), null, 'both slots taken');
    assert.equal(sync.diagnostics()[0].state, '0/2');

    assert.equal(sync.releaseSemaphore(semaphore), 0, 'reports the previous count');
    assert.equal(sync.diagnostics()[0].state, '0/2', 'the released slot went straight to c');
});

test('a semaphore cannot be released past its maximum', ()=>{
    const { sync } = setup();
    const semaphore = sync.createSemaphore({ initial: 1, maximum: 2 });
    assert.throws(()=>sync.releaseSemaphore(semaphore, 2), /past its maximum/);
    assert.throws(()=>sync.createSemaphore({ initial: 3, maximum: 2 }), /within \[0, maximum\]/);
});

test('waiting for all takes nothing until everything is ready', ()=>{
    const { sync } = setup();
    const first = sync.createEvent({ manualReset: true, signalled: true, name: 'first' });
    const second = sync.createEvent({ manualReset: true, name: 'second' });
    const a = thread('a');

    assert.equal(sync.waitAll([first, second], a), null, 'second is not ready');

    // The point of the rule: `first` must not have been consumed while waiting
    // for `second`. Taking what is available and blocking for the rest is how
    // two threads acquiring the same pair in opposite orders deadlock.
    assert.equal(sync.diagnostics()[0].state, 'signalled', 'first was left alone');
});

test('waiting for any reports which one came through', ()=>{
    const { sync } = setup();
    const quiet = sync.createEvent({ name: 'quiet' });
    const ready = sync.createEvent({ signalled: true, name: 'ready' });
    const a = thread('a');

    assert.deepEqual(sync.waitAny([quiet, ready], a), { index: 1, result: WaitResult.OBJECT_0 });
    assert.equal(sync.waitAny([quiet], a), null);
});

// --- a thread is a waitable object ---

/**
 * A thread record as the kernel keeps one, reduced to what waiting on it needs.
 * `exitCode` is null while it runs, which is what "not signalled" means here.
 *
 * @param {string} name
 */
const joinable = name=>({
    name, kind: 'thread', exitCode: /** @type {number | null} */ (null),
    waiters: /** @type {any[]} */ ([]), waitResult: /** @type {number | null} */ (null),
});

test('waiting on a running thread blocks, and its end releases the waiter', ()=>{
    const { scheduler, sync } = setup();
    const worker = joinable('worker');
    const joiner = thread('joiner');

    assert.equal(sync.wait(worker, joiner), null, 'a thread that has not ended is not signalled');

    worker.exitCode = 0;
    sync.releaseAll(worker);

    assert.deepEqual(scheduler.log, ['block joiner: thread "worker"', 'wake joiner']);
    assert.equal(joiner.waitResult, WaitResult.OBJECT_0);
});

test('an ended thread stays ended, so a second join does not wait for ever', ()=>{
    // Nothing is taken from a thread: every waiter is entitled to see that it
    // ended, however many of them ask and however late.
    const { sync } = setup();
    const worker = joinable('worker');
    worker.exitCode = 3;

    assert.equal(sync.wait(worker, thread('first')), WaitResult.OBJECT_0);
    assert.equal(sync.wait(worker, thread('second')), WaitResult.OBJECT_0);
});

test('every thread waiting on one that ends is released at once', ()=>{
    const { scheduler, sync } = setup();
    const worker = joinable('worker');
    const waiters = [thread('a'), thread('b'), thread('c')];

    for (const waiter of waiters)
    {
        sync.wait(worker, waiter);
    }
    worker.exitCode = 0;
    sync.releaseAll(worker);

    assert.deepEqual(scheduler.log.filter(line=>line.startsWith('wake')),
        ['wake a', 'wake b', 'wake c'], 'unlike a set event there is nothing to take');
    assert.equal(worker.waiters.length, 0, 'and nobody is left on the list');
});

test('releasing an object nothing waits on is not an error', ()=>{
    // The common case: a thread ends and no one ever joined it.
    const { scheduler, sync } = setup();
    const worker = joinable('worker');
    worker.exitCode = 0;

    sync.releaseAll(worker);

    assert.deepEqual(scheduler.log, []);
});
