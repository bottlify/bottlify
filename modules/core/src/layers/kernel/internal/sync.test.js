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

test('a poll takes what is ready and never leaves the thread queued', ()=>{
    // A program's service thread checked a completion event with a zero
    // timeout on every pass of its loop and then waited on its own pair of
    // events. The check queued it on the completion event, so when that was
    // signalled the stale entry woke the thread out of the pair with index 0
    // -- its quit event -- and it exited, taking the program's sound with it.
    const { scheduler, sync } = setup();
    const done = sync.createEvent({ name: 'done', manualReset: true });
    const quit = sync.createEvent({ name: 'quit' });
    const work = sync.createEvent({ name: 'work' });
    const a = thread('a');

    assert.equal(sync.poll(done, a), null, 'not ready');
    assert.deepEqual(done.waiters, [], 'and not queued for it');
    assert.equal(sync.waitAny([quit, work], a), null);
    sync.setEvent(done);
    assert.deepEqual(scheduler.log, ['block a: any of event "quit", event "work"'],
        'the signal woke nobody');
    assert.equal(a.waitResult, null);

    sync.setEvent(done);
    assert.equal(sync.poll(done, thread('b')), WaitResult.OBJECT_0, 'ready: taken');
    const held = sync.createMutex({ name: 'held' });
    const b = thread('b');
    assert.equal(sync.poll(held, b), WaitResult.OBJECT_0);
    assert.equal(sync.poll(held, b), WaitResult.OBJECT_0, 'a mutex recurses for its owner');
    assert.equal(held.recursion, 2);
    assert.equal(sync.poll(held, thread('c')), null, 'and is not free for anyone else');
});

test('waiting for any reports which one came through', ()=>{
    const { sync } = setup();
    const quiet = sync.createEvent({ name: 'quiet' });
    const ready = sync.createEvent({ signalled: true, name: 'ready' });
    const a = thread('a');

    assert.deepEqual(sync.waitAny([quiet, ready], a), { index: 1, result: WaitResult.OBJECT_0 });
    assert.equal(sync.waitAny([quiet], a), null);
});

test('a blocked wait for any reports the index of the object that came', ()=>{
    // The defect this pins: a set was only ever indexed on the path where
    // something was already signalled. A thread that had to block was woken
    // with a bare WAIT_OBJECT_0 however far down the set the object sat, so a
    // program watching a shutdown handle first read every other object in its
    // set as the shutdown and stopped.
    const { sync } = setup();
    const quit = sync.createEvent({ name: 'quit' });
    const work = sync.createEvent({ name: 'work' });
    const a = thread('a');

    assert.equal(sync.waitAny([quit, work], a), null, 'neither is ready, so a blocks');
    sync.setEvent(work);

    assert.equal(a.waitResult, WaitResult.OBJECT_0 + 1, 'the second object is index one');
});

test('a blocked wait for any adds its index to whichever base applies', ()=>{
    const { sync } = setup();
    const quit = sync.createEvent({ name: 'quit' });
    const guard = sync.createMutex({ name: 'guard' });
    const owner = thread('owner');
    const a = thread('a');

    sync.wait(guard, owner);
    assert.equal(sync.waitAny([quit, guard], a), null);
    sync.abandonMutexesOwnedBy(owner);

    assert.equal(a.waitResult, WaitResult.ABANDONED + 1,
        'an abandoned mutex is reported as abandoned AND as which one it was');
});

test('a thread released from a set leaves the queues of the rest of it', ()=>{
    // A queue that still holds a thread which has stopped waiting hands the
    // object to it later: the signal is spent on nobody and whoever is still
    // waiting never gets it.
    const { sync } = setup();
    const first = sync.createEvent({ name: 'first' });
    const second = sync.createEvent({ name: 'second' });
    const a = thread('a');
    const b = thread('b');

    sync.waitAny([first, second], a);
    sync.wait(first, b);

    sync.setEvent(second);
    const woken = sync.setEvent(first);

    assert.deepEqual(woken.map(t=>t.name), ['b'],
        'a is no longer waiting on first, so first goes to b');
    assert.equal(b.waitResult, WaitResult.OBJECT_0);
});

test('one object of a set does not release a thread waiting for all of them', ()=>{
    const { scheduler, sync } = setup();
    const first = sync.createEvent({ manualReset: true, name: 'first' });
    const second = sync.createEvent({ manualReset: true, name: 'second' });
    const a = thread('a');

    assert.equal(sync.waitAll([first, second], a), null);
    assert.deepEqual(sync.setEvent(first), [], 'one of two is not the set');
    assert.equal(a.waitResult, null, 'and nothing was reported to it');

    assert.deepEqual(sync.setEvent(second).map(t=>t.name), ['a'], 'both, and it goes');
    assert.equal(a.waitResult, WaitResult.OBJECT_0);
    assert.ok(scheduler.log.includes('block a: all of event "first", event "second"'),
        'a stalled thread names the objects it is waiting on, not how many');
});

test('a thread waiting for all of a set is passed over rather than starving the queue', ()=>{
    const { sync } = setup();
    const first = sync.createEvent({ name: 'first' });
    const second = sync.createEvent({ name: 'second' });
    const greedy = thread('greedy');
    const single = thread('single');

    sync.waitAll([first, second], greedy);
    sync.wait(first, single);

    assert.deepEqual(sync.setEvent(first).map(t=>t.name), ['single'],
        'the one that can take it does, rather than the signal being spent on nobody');
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

test('a wait that ran out of time leaves only the queues it stood in', ()=>{
    // Told by the scheduler that a thread timed out, the objects have to drop
    // it from their queues -- and only those it stood in: a scan of every
    // object for every expiry was paid tens of thousands of times a second
    // by a program that polls with a timeout.
    const scheduler = fakeScheduler();
    /** @type {((thread: any) => void)[]} */
    const timeouts = [];
    /** @type {any} */ (scheduler).onTimeout =
        (/** @type {(thread: any) => void} */ handler)=>timeouts.push(handler);
    const sync = createSyncObjects({ scheduler });
    const one = sync.createEvent({ name: 'one' });
    const two = sync.createEvent({ name: 'two' });
    const other = sync.createEvent({ name: 'other' });
    const a = thread('a');
    const b = thread('b');
    const c = thread('c');
    sync.wait(one, a, { deadline: 10 });
    sync.waitAny([one, two], b, { deadline: 10 });
    sync.wait(other, c);
    assert.deepEqual(one.waiters.map((/** @type {any} */ t)=>t.name), ['a', 'b']);

    timeouts[0](a);
    assert.deepEqual(one.waiters.map((/** @type {any} */ t)=>t.name), ['b'], 'a left the one queue it stood in');
    timeouts[0](b);
    assert.deepEqual(one.waiters, []);
    assert.deepEqual(two.waiters, [], 'b left both of its queues');
    assert.deepEqual(other.waiters.map((/** @type {any} */ t)=>t.name), ['c'],
        'a queue nobody timed out of is untouched');
});

test('a named object another process made wakes a waiter through the waiter\'s own scheduler',
    ()=>{
        // Two processes of a run share a named event: the parent made it, the
        // child waits on it through its own kernel, and the parent sets it.
        const parent = setup();
        const child = setup();
        const event = parent.sync.createEvent({ name: 'Global\\ready' });
        const waiter = { ...thread('child-main'), scheduler: child.scheduler };
        assert.equal(child.sync.wait(event, waiter), null,
            'the child blocks on the parent\'s event');
        parent.sync.setEvent(event);
        assert.ok(child.scheduler.log.includes('wake child-main'),
            'its own scheduler wakes it');
        assert.ok(!parent.scheduler.log.includes('wake child-main'),
            'and the parent\'s, which does not hold it, is not asked to');
        assert.equal(waiter.waitResult, WaitResult.OBJECT_0);
    });

test('a wait on another process\'s object that ends while it is being asked for is not lost',
    ()=>{
        // The link answers what it is asked while it waits for an answer of
        // its own, so the word that the wait ended can come in before the
        // wait's own answer -- that it was queued -- has been taken.
        const scheduler = fakeScheduler();
        /** @type {ReturnType<typeof createSyncObjects>} */
        let sync;
        /** @param {number} _id @param {number} _thread @param {number} token */
        const wait = (_id, _thread, token)=>{
            sync.wakeRemote(token, WaitResult.OBJECT_0);
            return null;
        };
        const remote = /** @type {any} */ ({
            wait,
            cancel: ()=>null,
        });
        sync = createSyncObjects({ scheduler, remote });
        const event = sync.createEvent({ manualReset: false, signalled: false, name: 'Go' });
        /** @type {any} */ (event).remote = 1;
        const waiter = /** @type {any} */ ({ ...thread('child'), id: 2 });
        assert.equal(sync.wait(event, waiter), WaitResult.OBJECT_0,
            'answered at once: the object is the thread\'s');
        assert.deepEqual(scheduler.log, [], 'never blocked, so nothing to wake');
    });

test('a poll of a set holding another process\'s object asks that object there, in order, and'
    + ' takes the first that is ready', ()=>{
    const scheduler = fakeScheduler();
    /** @type {number[]} */
    const asked = [];
    let ready = false;
    const remote = /** @type {any} */ ({
        /** @param {number} id */
        poll: id=>{
            asked.push(id);
            return ready ? WaitResult.OBJECT_0 : null;
        },
    });
    const sync = createSyncObjects({ scheduler, remote });
    const local = sync.createEvent({ manualReset: false, signalled: false, name: 'here' });
    const theirs = sync.createEvent({ manualReset: false, signalled: false, name: 'there' });
    /** @type {any} */ (theirs).remote = 7;
    const poller = /** @type {any} */ ({ ...thread('poller'), id: 3 });
    assert.equal(sync.pollAny([local, theirs], poller), null, 'neither is ready');
    assert.deepEqual(asked, [7], 'the other process was asked');
    ready = true;
    assert.deepEqual(sync.pollAny([local, theirs], poller),
        { index: 1, result: WaitResult.OBJECT_0 });
    sync.setEvent(local);
    assert.deepEqual(sync.pollAny([local, theirs], poller),
        { index: 0, result: WaitResult.OBJECT_0 },
        'the first ready one is taken, and the other is not asked');
    assert.deepEqual(asked, [7, 7]);
    assert.deepEqual(scheduler.log, [], 'a poll never blocks');
});
