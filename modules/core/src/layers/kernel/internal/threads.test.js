/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    SCHEDULER_COUNTERS, SLOW_SLICE_COLUMNS, THREAD_COLUMNS, THREAD_STATES, ThreadState,
    absolutePriority, createScheduler,
} from './threads.js';
import { createSwitcher } from './switch.js';
import { createSyncObjects } from './sync.js';

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

test('a slice that runs out inside an unbroken routine runs on to its end, on the same turn', ()=>{
    // The processor's EIP after each slice: the first ends inside the routine,
    // the next two still in it, the fourth past it; the next thread's slice
    // ends inside nothing.
    const cpu = fakeCpu(1000);
    const eips = [0x5010, 0x5020, 0x5030, 0x6000, 0x7000];
    /** @type {number[]} */
    const asked = [];
    const run = {
        ...cpu,
        eip: ()=>eips[Math.min(asked.length - 1, eips.length - 1)],
        /** @param {number} max */
        runSlice: max=>{
            asked.push(max);
            return Math.min(max, 1000);
        },
    };
    const sched = createScheduler({ cpu: run, switcher: createSwitcher({ cpu: run }),
        quantum: 5000 });
    sched.atomicCode(0x9000, 0x10);
    sched.atomicCode(0x5000, 0x40);
    const a = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'a' });
    sched.create({ entry: 1, stackTop: 2, tebAddress: 0xb000, name: 'b' });

    assert.equal(sched.runOnce().ran?.name, 'a');
    assert.equal(asked.length, 4, 'the quantum, then three steps until EIP left the routine');
    assert.equal(asked[0], 5000);
    assert.ok(asked.slice(1).every(max=>max < 5000), 'each step a short one');
    assert.equal(a.instructions, 1000 + 3 * 512, 'and every step charged to the thread');
    assert.equal(sched.runOnce().ran?.name, 'b', 'then the next thread has its turn');
    assert.equal(asked.length, 5, 'whose slice ended outside any routine');
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

test('a resumed thread reports what it waited for and what it was answered', ()=>{
    // The call was logged as parked when it began, and its answer goes
    // straight into a register when the thread comes back; this is the one
    // place both are known.
    const cpu = { ...fakeCpu(), resumeContextAt: ()=>{} };
    /** @type {any[]} */
    const resumed = [];
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 5000,
        onResume: (thread, reason, value)=>resumed.push([thread.name, reason, value]) });
    const a = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'a' });
    sched.block(a, 'any of event "#403c", event "#4040"');
    sched.wake(a);
    a.parkedReturn = 0x401000;
    a.waitResult = 1;
    sched.runOnce();
    assert.deepEqual(resumed, [['a', 'any of event "#403c", event "#4040"', 1]]);
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

test('the slices that held the machine longest are named, with where they ran', ()=>{
    // A slice within its instruction bound can still be a freeze: the count
    // says nothing about how long each instruction took. The host's clock does.
    let tick = 0;
    let cost = 1;
    let eip = 0x4000;
    const cpu = { ...fakeCpu(), runSlice: ()=>{
        tick += cost;
        eip += 0x10;
        return 500;
    }, eip: ()=>eip };
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 1000,
        wall: ()=>tick });
    sched.create({ entry: 0x1000, stackTop: 0x2000, tebAddress: 0, name: 'main' });
    sched.runOnce();
    assert.equal(sched.diagnostics().worstSliceMs, 0, 'a quick slice is not recorded');
    assert.equal(sched.diagnostics().slowSlices, '');
    cost = 120;
    sched.runOnce();
    cost = 300;
    sched.runOnce();
    cost = 1;
    sched.runOnce();
    const report = sched.diagnostics();
    assert.equal(report.worstSliceMs, 300);
    assert.equal(report.slowSlices, '300ms 500 main 0x4020->0x4030; 120ms 500 main 0x4010->0x4020',
        'longest first, with the instructions, the thread and where it began and ended');
    assert.equal(report.overruns, 0, 'none of them ran past its instruction bound');
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

test('the report says how much of the last seconds each thread held the machine, and the most'
    + ' an executor of its own each would buy', ()=>{
    let tick = 0;
    /** Host ms the next slice takes, by thread in turn. */
    const costs = [30, 10];
    let turn = 0;
    const cpu = { ...fakeCpu(), runSlice: ()=>{
        tick += costs[turn++ % 2];
        return 100;
    } };
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 1000,
        wall: ()=>tick });
    sched.create({ entry: 0x1000, stackTop: 0x2000, tebAddress: 0, name: 'main' });
    sched.create({ entry: 0x3000, stackTop: 0x4000, tebAddress: 0, name: 'worker' });
    // Long before the window: a loading screen the window must not count.
    for (let slice = 0; slice < 10; slice++)
    {
        sched.runOnce();
    }
    // Then nothing until a second's start: the nine seconds of the window
    // before it are the loop waiting.
    tick = 60_000;
    for (let slice = 0; slice < 20; slice++)
    {
        sched.runOnce();
        tick += 2;
    }
    const report = sched.diagnostics();
    assert.equal(report.busyByThread, 'main 300ms 75% | worker 100ms 25%');
    assert.equal(report.busyInSlicesMs, 400);
    assert.equal(report.parallelBound, 1.33, 'the slices over the busiest thread\'s share');
    assert.equal(report.busyBetweenSlicesMs, 9000 + 19 * 2,
        'the wait inside the window and the loop\'s two ms between slices');
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

test('a deadline set later but sooner is the first to expire, and none expires early', ()=>{
    // The scan for expired waits runs only once the clock reaches the
    // soonest deadline known, so a deadline that arrives later but ends
    // sooner has to move that mark, and a wait that ends early must not
    // leave it pointing past a deadline that is still pending.
    let clock = 0;
    const cpu = fakeCpu();
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 1000,
        now: ()=>clock });
    sched.create({ entry: 0x1000, stackTop: 0x2000, tebAddress: 0, name: 'main' });
    const late = sched.create({ entry: 0x3000, stackTop: 0x4000, tebAddress: 0, name: 'late' });
    const soon = sched.create({ entry: 0x5000, stackTop: 0x6000, tebAddress: 0, name: 'soon' });
    sched.block(late, 'a long wait', { deadline: 100 });
    sched.block(soon, 'a short wait', { deadline: 40 });

    clock = 39;
    sched.runOnce();
    assert.equal(soon.state, ThreadState.BLOCKED, 'not before its time');
    clock = 40;
    sched.runOnce();
    assert.notEqual(soon.state, ThreadState.BLOCKED, 'expired at its deadline');
    assert.equal(late.state, ThreadState.BLOCKED, 'the later one still waits');

    // The pending deadline ends early; a new, sooner one is set after it.
    sched.wake(late);
    const again = sched.create({ entry: 0x7000, stackTop: 0x8000, tebAddress: 0, name: 'again' });
    sched.block(again, 'another short wait', { deadline: 60 });
    clock = 60;
    sched.runOnce();
    assert.notEqual(again.state, ThreadState.BLOCKED, 'expired at its own deadline');
    assert.equal(sched.diagnostics().expiries, 2);
});

test('a higher-priority thread whose wait comes due mid-slice preempts at the next host call',
    ()=>{
        // A sound mixer at TIME_CRITICAL wakes every 10 ms; the thread on the
        // processor ran a slice of 40-120 ms of host calls, and the mixer
        // waited for the slice to end -- past the 65 ms it keeps written,
        // heard as a crackle. Windows preempts at once.
        let clock = 0;
        /** @type {boolean[]} */
        const asked = [];
        const cpu = fakeCpu();
        const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 1000,
            now: ()=>clock });
        let host = 0;
        cpu.runSlice = max=>{
            asked.push(sched.preemptionDue(()=>{
                clock = host;
            }));
            host = 10;
            asked.push(sched.preemptionDue(()=>{
                clock = host;
            }));
            return max;
        };
        const main = sched.create({ entry: 0x1000, stackTop: 0x2000, tebAddress: 0, name: 'main' });
        const mixer = sched.create({ entry: 0x3000, stackTop: 0x4000, tebAddress: 0,
            name: 'mixer' });
        mixer.priority = 15;
        sched.block(mixer, 'its period', { deadline: 10 });

        assert.equal(sched.runOnce().ran, main);
        assert.deepEqual(asked, [false, true], 'due once its wait came due during the slice');
        assert.equal(sched.runOnce().ran, mixer, 'and it has the next turn');

        assert.equal(clock, 10, 'the guest clock was brought up to the host to see it');

        asked.length = 0;
        mixer.priority = -15;
        sched.block(mixer, 'its period', { deadline: 20 });
        host = 30;
        sched.runOnce();
        assert.deepEqual(asked, [false, false], 'a lower one waits for the slice to end');
        assert.equal(clock, 10, 'and the clock is left to the turn');
    });

test('a higher-priority thread ready from the start of a slice does not preempt it', ()=>{
    // Always ready and always higher, it would take the processor back at
    // every host call; the slice it let run is the starvation rule's to end.
    const cpu = fakeCpu();
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 1000 });
    /** @type {boolean[]} */
    const asked = [];
    cpu.runSlice = max=>{
        asked.push(sched.preemptionDue());
        return max;
    };
    const busy = sched.create({ entry: 0x1000, stackTop: 0x2000, tebAddress: 0, name: 'busy' });
    busy.priority = 2;
    const other = sched.create({ entry: 0x3000, stackTop: 0x4000, tebAddress: 0, name: 'other' });
    other.priority = 2;
    sched.runOnce();
    sched.runOnce();
    assert.deepEqual(asked, [false, false]);
});

test('priority is composed as Windows composes it for a normal-class process', ()=>{
    assert.equal(absolutePriority(0), 8, 'THREAD_PRIORITY_NORMAL');
    assert.equal(absolutePriority(-2), 6, 'LOWEST');
    assert.equal(absolutePriority(-1), 7, 'BELOW_NORMAL');
    assert.equal(absolutePriority(1), 9, 'ABOVE_NORMAL');
    assert.equal(absolutePriority(2), 10, 'HIGHEST');
    assert.equal(absolutePriority(-15), 1, 'IDLE is pinned, not composed');
    assert.equal(absolutePriority(15), 15, 'TIME_CRITICAL likewise');
});

test('the highest-priority ready thread runs first, and equals keep their turns', ()=>{
    const { sched } = scheduler();
    const a = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'a' });
    const b = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xb000, name: 'b' });
    const feeder = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xc000, name: 'feeder' });
    feeder.priority = 2;

    const order = [];
    for (let i = 0; i < 4; i++)
    {
        order.push(sched.runOnce().ran.name);
    }
    assert.deepEqual(order, ['feeder', 'feeder', 'feeder', 'feeder'],
        'a ready thread above the others is the only one that runs');
    assert.equal(a.instructions + b.instructions, 0);

    sched.block(feeder, 'the device has enough');
    order.length = 0;
    for (let i = 0; i < 3; i++)
    {
        order.push(sched.runOnce().ran.name);
    }
    assert.deepEqual(order, ['a', 'b', 'a'], 'the equals round-robin once it is out of the way');

    sched.wake(feeder);
    assert.equal(sched.runOnce().ran, feeder, 'and it is back in front the turn it wakes');
});

test('a thread starved by a busier, higher one gets a turn within the bound', ()=>{
    let clock = 0;
    const cpu = fakeCpu();
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 1000,
        now: ()=>clock, starvation: 50 });
    const main = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'main' });
    const busy = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xb000, name: 'busy' });
    busy.priority = 15;

    const order = [];
    for (let i = 0; i < 12; i++)
    {
        clock += 10;
        order.push(sched.runOnce().ran.name);
    }
    // Ready at 0, passed over until the clock reaches 50, run on that turn,
    // then the bound is measured again from when its turn ended.
    assert.deepEqual(order, ['busy', 'busy', 'busy', 'busy', 'main',
        'busy', 'busy', 'busy', 'busy', 'main', 'busy', 'busy']);
    assert.equal(main.boosts, 2, 'each of its turns was a boost');
    assert.equal(busy.boosts, 0);
    assert.equal(sched.diagnostics().boosts, 2);
    assert.equal(main.boosted, false, 'the boost lasts the one turn');
});

test('a thread that raises its priority mid-run is scheduled by it from the next turn', ()=>{
    const { sched } = scheduler();
    const a = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'a' });
    const b = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xb000, name: 'b' });

    assert.equal(sched.runOnce().ran, a);
    // What SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST) does.
    a.priority = 2;
    assert.equal(sched.runOnce().ran, a, 'not b, whose turn it would have been');
    assert.equal(sched.runOnce().ran, a);
    a.priority = -2;
    assert.equal(sched.runOnce().ran, b, 'and lowering it hands the machine over');
    assert.equal(sched.runOnce().ran, b);
});

test('the report says what priority each thread runs at and how often it was boosted', ()=>{
    let clock = 0;
    const cpu = fakeCpu();
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 1000,
        now: ()=>clock, starvation: 10 });
    sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'main' });
    const feeder = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xb000, name: 'feeder' });
    feeder.priority = 2;

    assert.match(sched.diagnostics().byThread, /main 0 ready p8 b0 \| feeder 0 ready p10 b0/);
    clock = 10;
    sched.runOnce();
    assert.match(sched.diagnostics().byThread, /main 1000 ready p8 b1/,
        'the starved one ran, boosted, and the count says so');
    assert.match(sched.diagnostics().byThread, /feeder 0 ready p10 b0/);
});

test('instructions are credited into a flat page array, and nothing is walked to do it', ()=>{
    // One add per turn into an array a reader elsewhere sorts for itself:
    // there is no bound on how many pages count and nothing here to sort.
    let at = 0x00401000;
    const cpu = { ...fakeCpu(), eip: ()=>at, runSlice: ()=>100 };
    const pages = new Float64Array(0x1000 + 1);
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 1000, pages });
    sched.create({ entry: 0x1000, stackTop: 0x2000, tebAddress: 0, name: 'main' });

    sched.runOnce();
    at = 0x00810000;
    sched.runOnce();
    // Past the array: credited to the last entry rather than lost or thrown.
    at = 0xfffe0000;
    sched.runOnce();

    assert.equal(pages[0x40], 100);
    assert.equal(pages[0x81], 100);
    assert.equal(pages[0x1000], 100, 'an address outside guest memory goes to the last entry');
    assert.deepEqual(sched.pages(), { '0x400000': 100, '0x810000': 100, '0x10000000': 100 });
});

test('the counters and the thread table are published once a frame, not built on request', ()=>{
    const cpu = { ...fakeCpu(), runSlice: ()=>100 };
    /** @type {string[]} */
    const words = [];
    const intern = (/** @type {string} */ text)=>{
        const known = words.indexOf(text);
        return known >= 0 ? known : words.push(text) - 1;
    };
    const counters = new Float64Array(SCHEDULER_COUNTERS.length);
    /** @type {number[][]} */
    const rows = Array.from({ length: 4 }, ()=>new Array(THREAD_COLUMNS.length).fill(0));
    let used = 0;
    const threadTable = {
        rows: 4,
        /** @param {number} row @param {number} column @param {number} value */
        set: (row, column, value)=>{ rows[row][column] = value; },
        /** @param {number} count */
        used: count=>{ used = count; },
    };
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 1000,
        counters, threadTable, intern });
    const main = sched.create({ entry: 0x1000, stackTop: 0x2000, tebAddress: 0, name: 'main' });
    sched.create({ entry: 0x3000, stackTop: 0x4000, tebAddress: 0, name: 'worker' });
    sched.runOnce();
    sched.runOnce();
    sched.block(main, 'an event');

    assert.equal(used, 0, 'nothing is published until a frame asks');
    assert.equal(counters[SCHEDULER_COUNTERS.indexOf('turns')], 2,
        'except the turn count, which is one store where the turn happens');

    sched.publish();
    assert.equal(used, 2);
    assert.equal(counters[SCHEDULER_COUNTERS.indexOf('threads')], 2);
    assert.equal(counters[SCHEDULER_COUNTERS.indexOf('quantum')], 1000);
    const [first, second] = rows;
    assert.equal(words[first[THREAD_COLUMNS.indexOf('name')]], 'main');
    assert.equal(first[THREAD_COLUMNS.indexOf('instructions')], 100);
    assert.equal(THREAD_STATES[first[THREAD_COLUMNS.indexOf('state')]], 'blocked');
    assert.equal(words[first[THREAD_COLUMNS.indexOf('waitingOn')]], 'an event');
    assert.equal(words[second[THREAD_COLUMNS.indexOf('name')]], 'worker');
    assert.equal(second[THREAD_COLUMNS.indexOf('waitingOn')], -1);
    assert.equal(THREAD_STATES[second[THREAD_COLUMNS.indexOf('state')]], sched.all()[1].state,
        'the table says what the scheduler says');
});

test('a slow slice is written into its table when it is recorded', ()=>{
    let cost = 0;
    let tick = 0;
    const cpu = { ...fakeCpu(), runSlice: ()=>{ tick += cost; return 500; }, eip: ()=>0x4000 };
    /** @type {number[][]} */
    const rows = Array.from({ length: 8 }, ()=>new Array(SLOW_SLICE_COLUMNS.length).fill(0));
    let used = 0;
    const slowSliceTable = {
        rows: 8,
        /** @param {number} row @param {number} column @param {number} value */
        set: (row, column, value)=>{ rows[row][column] = value; },
        /** @param {number} count */
        used: count=>{ used = count; },
    };
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 1000,
        wall: ()=>tick, slowSliceTable, intern: ()=>7 });
    sched.create({ entry: 0x1000, stackTop: 0x2000, tebAddress: 0, name: 'main' });
    sched.runOnce();
    assert.equal(used, 0, 'a quick slice is not a slow one');
    cost = 120;
    sched.runOnce();
    cost = 300;
    sched.runOnce();
    assert.equal(used, 2);
    assert.deepEqual(rows[0], [300, 500, 0x4000, 0x4000, 7], 'longest first');
    assert.equal(rows[1][0], 120);
});

test('each publish names the thread the machine was spent on and where its heaviest slice ran',
    ()=>{
        let retire = 100;
        let at = 0x400000;
        const cpu = { ...fakeCpu(), runSlice: ()=>retire, eip: ()=>at };
        /** @type {string[]} */
        const words = [];
        const intern = (/** @type {string} */ text)=>{
            const known = words.indexOf(text);
            return known >= 0 ? known : words.push(text) - 1;
        };
        const counters = new Float64Array(SCHEDULER_COUNTERS.length);
        const column = (/** @type {string} */ name)=>
            counters[SCHEDULER_COUNTERS.indexOf(name)];
        const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 100_000,
            counters, intern });
        sched.create({ entry: 0x1000, stackTop: 0x2000, tebAddress: 0, name: 'main' });
        sched.create({ entry: 0x3000, stackTop: 0x4000, tebAddress: 0, name: 'worker' });

        // main takes one small turn, the worker one large one from another module.
        sched.runOnce();
        retire = 90_000;
        at = 0x6f0000;
        sched.runOnce();
        sched.publish();

        assert.equal(words[column('frameThread')], 'worker', 'the busiest of the interval');
        assert.equal(column('frameThreadInstructions'), 90_000);
        assert.equal(column('frameAt'), 0x6f0000, 'where the heaviest slice began');

        // The next interval is the next interval: nothing of this one carries over.
        retire = 200;
        at = 0x400000;
        sched.runOnce();
        sched.publish();
        assert.equal(words[column('frameThread')], 'main');
        assert.equal(column('frameThreadInstructions'), 200,
            'what it retired since the last publish, not since it started');
        assert.equal(column('frameAt'), 0x400000);
    });

test('a thread sent on with registers of its own gets them at the switch, once', ()=>{
    // What an exception handler's continuation carries: the frame pointer
    // its block expects. A plain wait carries none, and its resume says so.
    /** @type {any[]} */
    const resumes = [];
    const cpu = { ...fakeCpu(),
        /** @param {any} context @param {any} where */
        resumeContextAt: (context, where)=>resumes.push(where) };
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 5000 });
    const a = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'a' });
    sched.block(a, 'catching');
    sched.wake(a);
    a.parkedReturn = 0x401200;
    a.resumeStack = 0x2ff500;
    a.waitResult = 0;
    a.resumeRegisters = { ebp: 0x2ff5a0 };
    sched.runOnce();

    assert.deepEqual(resumes, [{
        eip: 0x401200, esp: 0x2ff500, returnValue: 0, registers: { ebp: 0x2ff5a0 },
    }]);
    assert.equal(a.resumeRegisters, null, 'and they are not applied a second time');
});

test('a parked thread resumes on the resting stack it was parked with', ()=>{
    // The switch may catch a parking thread before its stub's `ret` has run,
    // with ESP still on the return address the kernel overwrote. The resume
    // has to put ESP where the `ret` would have left it, not trust the save.
    /** @type {any[]} */
    const resumes = [];
    const cpu = { ...fakeCpu(),
        /** @param {any} context @param {any} where */
        resumeContextAt: (context, where)=>resumes.push(where) };
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 5000 });
    const a = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'a' });
    sched.block(a, 'sleep');
    sched.wake(a);
    a.parkedReturn = 0x7e8166;
    a.resumeStack = 0x2ffedc;
    a.waitResult = 0;
    sched.runOnce();
    assert.deepEqual(resumes, [{ eip: 0x7e8166, esp: 0x2ffedc, returnValue: 0 }]);
});

test('a suspended thread keeps its state and gets no turn until resumed as often', ()=>{
    const { sched } = scheduler();
    const a = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'a' });
    sched.create({ entry: 1, stackTop: 2, tebAddress: 0xb000, name: 'b' });

    assert.equal(sched.suspend(a), 0);
    assert.equal(sched.suspend(a), 1);
    assert.equal(a.state, ThreadState.READY, 'suspension is not a state of its own');
    assert.equal(sched.runOnce().ran.name, 'b');
    assert.equal(sched.runOnce().ran.name, 'b');
    assert.deepEqual(sched.diagnostics().waiting, ['a: suspended 2']);

    assert.equal(sched.resume(a), 2);
    assert.equal(sched.runOnce().ran.name, 'b', 'once is not enough');
    assert.equal(sched.resume(a), 1);
    assert.equal(sched.runOnce().ran.name, 'a');
    assert.equal(sched.resume(a), 0, 'resuming a thread nobody suspended changes nothing');
});

test('the report says how long a short-period thread went without the processor', ()=>{
    // A mixer feeding a sound device from a wait of a few milliseconds is
    // heard the moment it goes without the processor longer than it wrote
    // ahead; the gap, on the host clock, is what says a crackle was the
    // machine's and not the mixer's.
    let clock = 0;
    const cpu = fakeCpu();
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 1000,
        now: ()=>clock, wall: ()=>clock });
    sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'main' });
    const mixer = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xb000, name: 'mixer' });
    mixer.priority = 15;
    sched.block(mixer, 'its period', { deadline: 5 });
    clock = 6;
    assert.equal(sched.runOnce().ran, mixer);
    sched.block(mixer, 'its period', { deadline: 11 });
    clock = 60;
    assert.equal(sched.runOnce().ran, mixer);
    assert.equal(mixer.lateGaps, 1, 'the 54 ms since it last ran is a late gap');
    assert.equal(mixer.worstGap, 54);
    assert.ok(sched.diagnostics().byThread.includes('p15 b0 g54/1'), 'and the report says so');
    assert.ok(sched.diagnostics().lateGaps.startsWith('mixer@60+54 '));
});

test('a thread queued on an object that is ready now says so', ()=>{
    // A worker asleep on its "work" event while that event is set: the set
    // reached nobody, and the report is where that has to show.
    const { sched } = scheduler();
    const sync = createSyncObjects({ scheduler: sched });
    const worker = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'worker' });
    const work = sync.createEvent({ manualReset: true, name: '#20' });
    const quit = sync.createEvent({ manualReset: true, name: '#24' });

    assert.equal(sync.waitAny([work, quit], worker), null);
    assert.deepEqual(sched.diagnostics().waiting, ['worker: any of event "#20", event "#24"'],
        'waiting as it should');
    work.signalled = true;
    assert.deepEqual(sched.diagnostics().waiting,
        ['worker: any of event "#20", event "#24", yet event "#20" is ready']);
});

/**
 * A cpu whose slice runs `during` once, as a host call made inside the slice
 * would, and stops short when asked to.
 *
 * @param {() => void} during
 */
function wakingCpu(during){
    let stopped = false;
    let pending = /** @type {(() => void) | null} */ (during);
    const cpu = {
        stops: 0,
        captureContext: ()=>({ saved: true }),
        restoreContext: ()=>{},
        /** @param {{ entry: number, stackTop: number }} options */
        newContext: ({ entry, stackTop })=>({ eip: entry, esp: stackTop }),
        stop(){
            cpu.stops++;
            stopped = true;
        },
        /** @param {number} max */
        runSlice: max=>{
            stopped = false;
            const call = pending;
            pending = null;
            call?.();
            return stopped ? 10 : max;
        },
    };
    return cpu;
}

test('a thread of higher priority woken by the running one takes the processor at once', ()=>{
    /** @type {any} */
    let worker = null;
    /** @type {any} */
    let sched = null;
    const cpu = wakingCpu(()=>sched.wake(worker));
    sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 5000 });
    const main = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'main' });
    worker = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xb000, name: 'worker' });
    worker.priority = 2;
    sched.block(worker, 'its work event');

    const first = sched.runOnce();
    assert.equal(first.ran, main);
    assert.equal(first.instructions, 10, 'the slice ended at the call that woke it');
    assert.equal(cpu.stops, 1);
    assert.equal(sched.runOnce().ran, worker, 'and the worker has the next turn');
    assert.equal(sched.diagnostics().preemptions, 1);
});

test('a thread woken at the same priority or lower waits for the slice to end', ()=>{
    for (const priority of [0, -1])
    {
        /** @type {any} */
        let other = null;
        /** @type {any} */
        let sched = null;
        const cpu = wakingCpu(()=>sched.wake(other));
        sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 5000 });
        const main = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'main' });
        other = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xb000, name: 'other' });
        other.priority = priority;
        sched.block(other, 'an event');

        const first = sched.runOnce();
        assert.equal(first.ran, main);
        assert.equal(first.instructions, 5000, `priority ${priority}: the whole quantum`);
        assert.equal(cpu.stops, 0);
    }
});

test('a thread woken between slices ends no slice', ()=>{
    const cpu = wakingCpu(()=>{});
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), quantum: 5000 });
    sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'main' });
    const worker = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xb000, name: 'worker' });
    worker.priority = 2;
    sched.block(worker, 'a timer');
    sched.runOnce();

    // A wait that came due, a completion the page delivered: nothing is
    // running, so there is no slice to end.
    sched.wake(worker);
    assert.equal(cpu.stops, 0);
});

test('a thread whose slice ended on a host call goes on once it is answered', ()=>{
    // A host call that runs guest code -- D3DX applying a pass through the
    // device's methods -- parks the thread until the frame is built; it went
    // behind every other ready thread for a whole slice each, per call.
    const cpu = fakeCpu();
    let clock = 0;
    const sched = createScheduler({ cpu, switcher: createSwitcher({ cpu }), now: ()=>clock,
        quantum: 5000 });
    const main = sched.create({ entry: 1, stackTop: 2, tebAddress: 0xa000, name: 'main' });
    sched.create({ entry: 1, stackTop: 2, tebAddress: 0xb000, name: 'audio' });
    // Main's slice ends parked on the host...
    cpu.runSlice = ()=>{
        main.awaitingHost = true;
        return 65;
    };
    assert.equal(sched.runOnce().ran.name, 'main');
    cpu.runSlice = max=>Math.min(max, 1000);
    // ...whose answer arrives before the next pick.
    main.awaitingHost = false;
    assert.equal(sched.runOnce().ran.name, 'main', 'the answered call goes on');
    assert.equal(sched.runOnce().ran.name, 'audio', 'and the turn after is the queue\'s again');

    // A thread passed over past the starvation bound still comes first.
    cpu.runSlice = ()=>{
        main.awaitingHost = true;
        return 65;
    };
    sched.runOnce();
    main.awaitingHost = false;
    cpu.runSlice = max=>Math.min(max, 1000);
    clock += 10_000;
    assert.equal(sched.runOnce().ran.name, 'audio', 'starved, it is not passed over again');
});
