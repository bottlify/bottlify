/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadState, createScheduler } from './threads.js';
import { createSwitcher } from './switch.js';

/**
 * A cpu whose slices retire a fixed number of instructions, so scheduling can
 * be tested without an emulator. The switch primitive is the real one.
 *
 * @param {number} [perSlice]
 */
function fakeCpu(perSlice = 1000){
    /** @type {number[]} */
    const restored = [];
    return {
        restored,
        captureContext: ()=>({ saved: true }),
        /** @param {any} context @param {number} threadBase */
        restoreContext: (context, threadBase)=>restored.push(threadBase),
        /** @param {{ entry: number, stackTop: number }} options */
        newContext: ({ entry, stackTop })=>({ eip: entry, esp: stackTop }),
        /** @param {number} max */
        runSlice: max=>Math.min(max, perSlice),
    };
}

/** @param {number} [perSlice] */
function scheduler(perSlice){
    const cpu = fakeCpu(perSlice);
    const switcher = createSwitcher({ cpu });
    return { cpu, sched: createScheduler({ cpu, switcher, quantum: 5000 }) };
}

test('a created thread is ready but does not take the CPU', ()=>{
    const { cpu, sched } = scheduler();
    const thread = sched.create({ entry: 0x1000, stackTop: 0x2000, tebAddress: 0x7000 });

    assert.equal(thread.state, ThreadState.READY);
    assert.equal(sched.current(), null, 'creating a thread does not switch to it');
    assert.deepEqual(cpu.restored, [], 'nothing was restored, so the CPU never moved');
});

test('threads take turns in order', ()=>{
    const { sched } = scheduler();
    const a = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'a' });
    const b = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xb000, name: 'b' });
    const c = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xc000, name: 'c' });

    const order = [
        sched.runOnce().ran, sched.runOnce().ran, sched.runOnce().ran, sched.runOnce().ran,
    ];
    assert.deepEqual(order.map(t=>t.name), ['a', 'b', 'c', 'a'],
        'each turn goes to the thread that has waited longest');
    assert.equal(a.instructions, 2000, 'and each turn is charged to the thread that ran');
    assert.equal(b.instructions, 1000);
    assert.equal(c.instructions, 1000);
});

test('every turn restores the incoming thread onto its own TEB', ()=>{
    const { cpu, sched } = scheduler();
    sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'a' });
    sched.create({ entry: 1, stackTop: 2, tebAddress: 0xb000, name: 'b' });

    sched.runOnce();
    sched.runOnce();
    sched.runOnce();

    assert.deepEqual(cpu.restored, [0xa000, 0xb000, 0xa000]);
});

test('a blocked thread does not get a turn until it is woken', ()=>{
    const { sched } = scheduler();
    const a = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'a' });
    sched.create({ entry: 1, stackTop: 2, tebAddress: 0xb000, name: 'b' });

    sched.block(a, 'event 0x24');
    assert.equal(sched.runOnce().ran.name, 'b');
    assert.equal(sched.runOnce().ran.name, 'b', 'b keeps the CPU while a is blocked');

    assert.equal(sched.wake(a), true);
    assert.equal(sched.runOnce().ran.name, 'a');
    assert.equal(a.state, ThreadState.READY);
});

test('waking a thread that is not blocked changes nothing', ()=>{
    const { sched } = scheduler();
    const a = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000 });
    assert.equal(sched.wake(a), false);
});

test('an idle system is distinguishable from a busy one', ()=>{
    const { sched } = scheduler();
    const only = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000 });

    sched.block(only, 'a mutex nobody releases');
    const result = sched.runOnce();

    assert.equal(result.ran, null, 'no thread ran');
    assert.equal(result.instructions, 0);
    assert.deepEqual(sched.diagnostics().waiting, ['thread-1: a mutex nobody releases'],
        'and the snapshot says what everyone is waiting on, which is the shape of a deadlock');
});

test('a terminated thread stops being scheduled', ()=>{
    const { sched } = scheduler();
    const a = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'a' });
    sched.create({ entry: 1, stackTop: 2, tebAddress: 0xb000, name: 'b' });

    sched.runOnce();
    sched.terminate(a, 0);

    assert.equal(sched.runOnce().ran.name, 'b');
    assert.equal(sched.runOnce().ran.name, 'b');
    assert.equal(a.exitCode, 0);
    assert.equal(sched.diagnostics().byState[ThreadState.TERMINATED], 1);
});

test('the quantum bounds a turn', ()=>{
    // A cpu that would happily run forever; the scheduler must ask for no more
    // than the quantum, since that is the only thing making turns fair.
    const { sched } = scheduler(1_000_000);
    sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000 });

    assert.equal(sched.runOnce().instructions, 5000, 'the slice is capped by the quantum');
});

test('a thread parked on a host call is not a candidate for a turn', ()=>{
    // It is stopped on `hlt` with nothing of its own to run. Counted as ready it
    // gave the scheduler someone to hand a turn to for ever, so the branch below
    // -- the one that moves the clock to the next deadline -- was unreachable,
    // and every timed wait in the guest expired in host time instead.
    const cpu = fakeCpu();
    let clock = 0;
    const sched = createScheduler({
        cpu,
        switcher: createSwitcher({ cpu }),
        now: ()=>clock,
        /** @param {number} deadline */
        skipTo: deadline=>{
            const jump = Math.max(0, deadline - clock);
            clock = deadline;
            return jump;
        },
    });

    const waiter = sched.create({ entry: 0x1000, stackTop: 0x2000, tebAddress: 0, name: 'waiter' });
    const parked = sched.create({ entry: 0x3000, stackTop: 0x4000, tebAddress: 0, name: 'parked' });
    sched.block(waiter, 'a timed wait', { deadline: 50 });
    parked.awaitingHost = true;

    const turn = sched.runOnce();
    assert.equal(turn.ran?.name, 'waiter', 'the clock moved and the waiter woke');
    assert.equal(clock, 50, 'to exactly the deadline it was waiting for');
});

test('a slice the emulator ran past is counted, not assumed away', ()=>{
    // The quantum is how long one thread may hold the machine before anything
    // else -- another thread, a message, a frame -- gets a look, and nothing
    // checked that it was honoured. An emulator that runs four times the
    // instructions asked for holds the machine four times as long and says
    // nothing about it, and the only symptom is a frame rate with no
    // explanation. So this cpu ignores the slice, the way one really can.
    let ran = 1000;
    let eip = 0x4242;
    const cpu = {
        ...fakeCpu(),
        // The slice moves the thread: it ends somewhere else than it began.
        runSlice: ()=>{
            eip = ran === 4200 ? 0x5000 : 0x4242;
            return ran;
        },
        eip: ()=>eip,
    };
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 1000 });
    sched.create({ entry: 0x1000, stackTop: 0x2000, tebAddress: 0, name: 'main' });

    sched.runOnce();
    assert.equal(sched.diagnostics().overruns, 0, 'a slice that fits is not an overrun');

    ran = 4200;
    sched.runOnce();
    ran = 2500;
    sched.runOnce();

    const report = sched.diagnostics();
    assert.equal(report.overruns, 2);
    assert.equal(report.worstSlice, 4200, 'and the worst is what a frame actually paid for');
    assert.equal(report.worstSliceAt, 0x5000, 'and where it ended is named');
    assert.equal(report.worstSliceFrom, 0x4242, 'and where it began');
    assert.equal(report.worstSliceOn, 'main', 'on which thread');
});

test('the report says which thread the machine was spent on', ()=>{
    const cpu = { ...fakeCpu(), runSlice: ()=>100 };
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 1000 });
    sched.create({ entry: 0x1000, stackTop: 0x2000, tebAddress: 0, name: 'main' });
    sched.create({ entry: 0x3000, stackTop: 0x4000, tebAddress: 0, name: 'worker' });

    // Round robin, so three turns give the first thread two of them. Totals
    // alone would say the machine ran 300 instructions and nothing about who.
    sched.runOnce();
    sched.runOnce();
    sched.runOnce();

    const byThread = sched.diagnostics().byThread;
    assert.match(byThread, /main 200/, 'the thread that ran twice is credited twice');
    assert.match(byThread, /worker 100/, 'and the one that ran once, once');
});

test('the report says where the guest ran, by page and weighted by the slice', ()=>{
    let at = 0x00401000;
    const cpu = { ...fakeCpu(), eip: ()=>at, runSlice: ()=>100 };
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 1000 });
    sched.create({ entry: 0x1000, stackTop: 0x2000, tebAddress: 0, name: 'main' });

    sched.runOnce();
    sched.runOnce();
    // A different 64 KiB page, so the two are counted apart rather than summed.
    at = 0x00810000;
    sched.runOnce();

    assert.deepEqual(sched.pages(), { '0x400000': 200, '0x810000': 100 });
});
