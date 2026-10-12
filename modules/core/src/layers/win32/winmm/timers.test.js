/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTimerService, timerLoopCode } from './timers.js';

const PARKED = Object.freeze({ parked: true });

/** A machine with one timer thread, a clock the test moves, and a shared memory. */
function machine(){
    const memory = new Uint8Array(0x2000);
    let free = 0x1100;
    /** @type {Record<string, { argBytes: number, handler: () => any }>} */
    const traps = {};
    /** @type {any[]} */
    const created = [];
    /** @type {{ thread: any, result: number }[]} */
    const woken = [];
    /** @type {{ thread: any, reason: string, timed?: { deadline: number, result: number } }[]} */
    const blocked = [];
    /** @type {number[]} */
    const signalled = [];
    /** @type {number[]} */
    const pulsed = [];
    let now = 1000;
    /** @type {any} */
    let current = null;

    const timers = createTimerService({
        allocate: bytes=>{
            const at = free;
            free += bytes;
            return at;
        },
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        register: (name, fn)=>{
            traps[name] = fn;
            return 0x900;
        },
        createThread: options=>{
            const thread = { name: options.name, entry: options.entry };
            created.push(thread);
            return thread;
        },
        currentThread: ()=>current,
        block: (thread, reason, timed)=>blocked.push({ thread, reason, timed }),
        wake: (thread, result)=>{
            woken.push({ thread, result });
            return true;
        },
        park: ()=>PARKED,
        now: ()=>now,
        setEvent: handle=>signalled.push(handle),
        pulseEvent: handle=>pulsed.push(handle),
    });

    /** @param {number} at */
    const get32 = at=>(memory[at] | memory[at + 1] << 8
        | memory[at + 2] << 16 | memory[at + 3] << 24) >>> 0;
    /** @param {number} at */
    const record = at=>({
        entry: get32(at),
        args: [4, 8, 12, 16, 20].map(offset=>get32(at + offset)),
    });
    const ask = ()=>{
        current = created[0];
        return traps['<mm-timers>'].handler();
    };
    /** @param {number} ms */
    const tick = ms=>{ now += ms; };

    return { memory, timers, created, woken, blocked, signalled, pulsed, record, ask, tick };
}

test('the loop is the bytes it says it is, and a wake below a record address asks again', ()=>{
    const code = timerLoopCode(0x900, 0x200);
    assert.equal(code.length, 31);
    assert.deepEqual([...code.slice(0, 5)], [0xe8, 0xfb, 0x06, 0x00, 0x00], 'call rel32');
    assert.deepEqual([...code.slice(5, 12)], [0x3d, 0x00, 0x10, 0x00, 0x00, 0x72, 0xf4],
        'cmp eax, 0x1000; jb loop');
    assert.deepEqual([...code.slice(29)], [0xeb, 0xe1], 'jmp loop');
});

test('a periodic timer makes the thread, fires on its period, re-armed from its due time', ()=>{
    const m = machine();
    const id = m.timers.set(10, 0x401000, 0xbeef, 0x0001);
    assert.equal(id, 1);
    assert.equal(m.created.length, 1);
    assert.equal(m.created[0].name, 'winmm-timer');
    assert.equal(/** @type {any} */ (m.created[0]).priority, 15, 'time-critical, as Windows runs it');

    // Not due: the thread parks with the deadline the clock will honour.
    assert.equal(m.ask(), PARKED);
    assert.deepEqual(m.blocked[0].timed, { deadline: 1010, result: 0 });

    // Woken at the deadline: the record names the routine and its arguments.
    m.tick(10);
    const answer = m.ask();
    assert.deepEqual(m.record(answer), { entry: 0x401000, args: [1, 0, 0xbeef, 0, 0] });
    assert.equal(m.timers.diagnostics().fired, 1);

    // Late by five: the next due time is the period from the last, not from now.
    m.tick(15);
    assert.equal(typeof m.ask(), 'number', 'due at 1020, and it is 1025');
    assert.equal(m.ask(), PARKED);
    assert.equal(m.blocked[1].timed?.deadline, 1030);
});

test('a periodic timer behind by more than its period fires once, not once per tick missed', ()=>{
    // A callback slower than its period owed more ticks with every one, and the
    // time-critical thread then took every turn: Delta Force's 33 ms timer was
    // measured 2.3 s behind.
    const m = machine();
    m.timers.set(10, 0x401000, 0, 0x0001);
    m.ask();
    m.tick(10);
    m.ask();
    m.tick(45);
    assert.equal(typeof m.ask(), 'number', 'due at 1020, it is 1055: one call');
    assert.equal(m.ask(), PARKED, 'and not the ones at 1030, 1040 and 1050');
    assert.equal(m.blocked.at(-1)?.timed?.deadline, 1060, 'the next on the same grid');
    assert.equal(m.timers.diagnostics().skipped, 3);
});

test('a one-shot timer fires once, and killing a timer takes it out of the table', ()=>{
    const m = machine();
    const once = m.timers.set(5, 0x402000, 1, 0);
    const later = m.timers.set(50, 0x403000, 2, 0x0001);
    m.tick(5);
    assert.equal(m.record(m.ask()).entry, 0x402000);
    assert.equal(m.timers.diagnostics().armed, 2, 'the one shot stays while its routine runs');
    assert.equal(m.timers.kill(later), 0);
    assert.equal(m.ask(), PARKED, 'the routine returned, and the one shot does not fire again');
    assert.equal(m.timers.diagnostics().armed, 0, 'the one shot is gone');
    assert.equal(m.timers.kill(once), 97, 'TIMERR_NOCANDO: made, and already gone');
    assert.equal(m.timers.kill(1000), 11, 'MMSYSERR_INVALPARAM: never made');
    assert.equal(m.blocked.at(-1)?.timed, undefined, 'nothing armed: parked with no deadline');
});

test('a one-shot routine may kill its own timer', ()=>{
    // winmm's timer tests call timeKillEvent from the callback, one shot and
    // TIME_KILL_SYNCHRONOUS, and expect TIMERR_NOERROR.
    const m = machine();
    const once = m.timers.set(5, 0x402000, 1, 0);
    m.tick(5);
    assert.equal(m.record(m.ask()).entry, 0x402000);
    assert.equal(m.timers.kill(once), 0, 'still its timer while the routine runs');
    assert.equal(m.ask(), PARKED);
});

test('sixteen timers may be armed at once, and the seventeenth is refused', ()=>{
    const m = machine();
    const made = Array.from({ length: 20 }, ()=>m.timers.set(10000, 0x2040, 0, 0x0010));
    assert.ok(made.slice(0, 16).every(id=>id !== 0));
    assert.deepEqual(made.slice(16), [0, 0, 0, 0]);
    assert.equal(m.timers.kill(made[0]), 0);
    assert.notEqual(m.timers.set(10000, 0x2040, 0, 0x0010), 0, 'room again once one is killed');
});

test('a new timer wakes a parked thread so it looks at the table again', ()=>{
    const m = machine();
    m.timers.set(100, 0x401000, 0, 0x0001);
    m.ask();
    assert.equal(m.woken.length, 0);
    m.timers.set(5, 0x404000, 0, 0);
    assert.equal(m.woken.length, 1, 'parked for 100 ms, and something is due in 5');
    assert.equal(m.woken[0].result, 0, 'below any record address: the loop asks again');
});

test('the event forms signal or pulse the event and never call into the guest', ()=>{
    const m = machine();
    m.timers.set(1, 0x2040, 0, 0x0010);
    m.timers.set(1, 0x2044, 0, 0x0020);
    m.tick(1);
    assert.equal(m.ask(), PARKED, 'both settled on the host; nothing left to call');
    assert.deepEqual(m.signalled, [0x2040]);
    assert.deepEqual(m.pulsed, [0x2044]);
});

test('a bad delay or a null routine is refused with no timer made', ()=>{
    const m = machine();
    assert.equal(m.timers.set(0, 0x401000, 0, 0), 0);
    assert.equal(m.timers.set(10, 0, 0, 0), 0);
    assert.equal(m.created.length, 0);
});
