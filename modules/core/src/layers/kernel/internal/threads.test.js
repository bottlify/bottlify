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
