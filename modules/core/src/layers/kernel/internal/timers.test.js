/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The clock-driven timer contract, with the real scheduler and the real
 * synchronisation objects.
 *
 * A waitable timer's signal is a property of the object and the guest's
 * clock, not of the wait that happens to observe it. The tests below pin the
 * orderings the old event-plus-side-table model could not express: a waiter
 * that parks *before* the timer is armed is released when the due time
 * arrives, a periodic timer re-signals with no thread present between the
 * periods, and the reset discipline follows the object's manual/auto kind.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScheduler } from './threads.js';
import { createSwitcher } from './switch.js';
import { createSyncObjects } from './sync.js';

/**
 * A scheduler on a clock the test moves, with a cpu that runs no
 * instructions, so only the clock and the object state are under test.
 */
function harness(){
    let clock = 0;
    const cpu = {
        captureContext: ()=>({}),
        restoreContext: ()=>{},
        resumeContextAt: ()=>{},
        newContext: ()=>({}),
        runSlice: ()=>0,
        readReg32: ()=>0,
        eip: ()=>0,
    };
    const switcher = createSwitcher({ cpu });
    const sched = createScheduler({
        cpu,
        switcher,
        quantum: 1000,
        now: ()=>clock,
        /** @param {number} deadline */
        skipTo: deadline=>{
            const jump = Math.max(0, deadline - clock);
            clock = deadline;
            return jump;
        },
    });
    const sync = createSyncObjects({ scheduler: sched });
    return {
        sync,
        sched,
        now: ()=>clock,
        /** @param {string} name */
        thread: name=>sched.create({ entry: 1, stackTop: 2, tebAddress: 0, name }),
    };
}

test('a waiter that parked before the arm is released when the due time arrives', ()=>{
    const h = harness();
    const a = h.thread('a');
    const b = h.thread('b');
    const timer = h.sync.createTimer({ manualReset: true, name: 'tick' });

    // The deadlock's ordering: both waits run before the timer is armed.
    assert.equal(h.sync.wait(timer, a), null, 'a parks on the object');
    assert.equal(h.sync.wait(timer, b), null, 'and so does b');

    h.sync.armTimer(timer, 1016, 0);
    const turn = h.sched.runOnce();

    assert.equal(h.now(), 1016, 'the clock moved to the due time');
    assert.equal(a.waitResult, 0, 'a was released with WAIT_OBJECT_0');
    assert.equal(b.waitResult, 0, 'and so was b: a manual-reset timer releases everyone');
    assert.equal(timer.signalled, true, 'and stays signalled');
    assert.equal(turn.ran, a, 'a found something to run afterwards');
});

test('a synchronisation timer releases one waiter and resets', ()=>{
    const h = harness();
    const a = h.thread('a');
    const b = h.thread('b');
    const timer = h.sync.createTimer({ manualReset: false, name: 'tick' });

    h.sync.wait(timer, a);
    h.sync.wait(timer, b);
    h.sync.armTimer(timer, 1016, 0);
    h.sched.runOnce();

    assert.equal(a.waitResult, 0, 'the first waiter took the signal');
    assert.equal(b.state, 'blocked', 'the second is still waiting');
    assert.equal(timer.signalled, false, 'and the wait that took it reset the timer');
    assert.equal(timer.waiters.length, 1);
});

test('a periodic timer re-signals a period on, with nothing waiting in between', ()=>{
    const h = harness();
    const a = h.thread('a');
    const timer = h.sync.createTimer({ manualReset: false, name: 'tick' });
    h.sync.armTimer(timer, 1010, 20);

    h.sync.wait(timer, a);
    h.sched.runOnce();
    assert.equal(a.waitResult, 0, 'the first period');
    assert.equal(h.now(), 1010);

    h.sync.wait(timer, a);
    h.sched.runOnce();
    assert.equal(a.waitResult, 0, 'the next period, with no wait in between');
    assert.equal(h.now(), 1030, 'exactly one period later');
    assert.equal(timer.due, 1050, 'and it is armed again');
});

test('a timed wait shorter than the due time times out and leaves the timer queue', ()=>{
    const h = harness();
    const a = h.thread('a');
    const timer = h.sync.createTimer({ manualReset: false, name: 'tick' });
    h.sync.armTimer(timer, 1016, 0);

    assert.equal(h.sync.wait(timer, a, { deadline: 1005, result: 0x102 }), null);
    h.sched.runOnce();

    assert.equal(a.waitResult, 0x102, 'the wait ended on its own deadline');
    assert.equal(timer.waiters.length, 0, 'and it is not left in the timer queue');
    assert.equal(h.sched.nextDeadline(), 1016, 'the timer is still armed for its due time');
});

test('a cancelled timer leaves its waiters parked and the clock idle', ()=>{
    const h = harness();
    const a = h.thread('a');
    const timer = h.sync.createTimer({ manualReset: false, name: 'tick' });
    h.sync.armTimer(timer, 1016, 20);

    h.sync.wait(timer, a);
    h.sync.cancelTimer(timer);

    assert.equal(h.sched.nextDeadline(), null, 'nothing is waiting on time any more');
    assert.deepEqual(h.sched.runOnce(), { ran: null, instructions: 0, switched: false });
    assert.equal(a.state, 'blocked', 'the waiter is still parked');
    assert.equal(timer.signalled, false, 'and cancelling did not signal it');
});

test('a timer among a set releases the wait with the index of the object that came', ()=>{
    const h = harness();
    const a = h.thread('a');
    const timer = h.sync.createTimer({ manualReset: false, name: 'tick' });
    const event = h.sync.createEvent({ name: 'other' });
    h.sync.armTimer(timer, 1000, 0);

    assert.equal(h.sync.waitAny([timer, event], a), null, 'the set is not ready yet');
    h.sched.runOnce();

    // The answer names the object: index 0, the timer. A wait on a set that
    // reported the first member every time takes the wrong branch in the
    // program that built the set.
    assert.equal(a.waitResult, 0, 'WAIT_OBJECT_0 + 0');
});
