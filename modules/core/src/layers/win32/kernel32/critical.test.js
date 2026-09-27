/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    COUNTERS, CS, createCriticalSections, enterCode, leaveCode, tryEnterCode,
} from './critical.js';

const PARKED = Object.freeze({ parked: true });

/** @param {Uint8Array} bytes @param {number} at */
const i32 = (bytes, at)=>bytes[at] | bytes[at + 1] << 8
    | bytes[at + 2] << 16 | bytes[at + 3] << 24;

test('the fast paths are the bytes they say they are, with the traps reached relatively', ()=>{
    const enter = enterCode(0x20000, 0x105000, 0x30000);
    // Ends in a jump to the wait trap from where the jump stands.
    assert.equal(enter[enter.length - 5], 0xe9);
    assert.equal(i32(enter, enter.length - 4), 0x105000 - (0x20000 + enter.length));
    // Reads the thread id through FS, and counts itself.
    assert.deepEqual([...enter.slice(4, 10)], [0x64, 0xa1, 0x24, 0x00, 0x00, 0x00]);
    assert.deepEqual([...enter.slice(10, 17)], [0xf0, 0xff, 0x05, 0x00, 0x00, 0x03, 0x00],
        'lock inc of the entered counter');
    // The branch over the owned path lands on `cmp [ecx+12], eax`.
    const taken = 17 + 4 + 2 + enter[22];
    assert.deepEqual([...enter.slice(taken, taken + 3)], [0x39, 0x41, CS.OWNING_THREAD]);

    const leave = leaveCode(0x20100, 0x105010, 0x30000);
    assert.equal(leave[leave.length - 5], 0xe9);
    assert.equal(i32(leave, leave.length - 4), 0x105010 - (0x20100 + leave.length));
    assert.deepEqual([...leave.slice(4, 11)], [0xf0, 0xff, 0x05, 0x04, 0x00, 0x03, 0x00],
        'lock inc of the left counter');
    // `jnz nested` lands on the nested `lock dec [ecx+4]`.
    const nested = 11 + 3 + 2 + leave[15];
    assert.deepEqual([...leave.slice(nested, nested + 4)], [0xf0, 0xff, 0x49, CS.LOCK_COUNT]);

    const attempt = tryEnterCode(0x30000);
    assert.deepEqual([...attempt.slice(0, 4)], [0x8b, 0x4c, 0x24, 0x04]);
    // EBX is callee-saved: it is pushed before it is used and popped before
    // the branch, and the pop does not touch the flags the branch reads.
    assert.equal(attempt[11], 0x53, 'push ebx');
    assert.equal(attempt[24], 0x5b, 'pop ebx');
    assert.equal(attempt[25], 0x75, 'then jnz');
    // Both ways of taking it -- free, and already its owner's -- count the
    // entry, each for itself, with no jump back to a shared tail.
    const counted = [0xf0, 0xff, 0x05, 0x00, 0x00, 0x03, 0x00];
    const free = 27 + 3 + 7;
    assert.deepEqual([...attempt.slice(free, free + 7)], counted, 'the free section');
    const held = 27 + attempt[26];
    assert.deepEqual([...attempt.slice(held, held + 3)], [0x39, 0x51, CS.OWNING_THREAD]);
    const recursion = held + 3 + 2 + 4 + 3;
    assert.deepEqual([...attempt.slice(recursion, recursion + 7)], counted, 'the owner\'s own');
    assert.equal(attempt.includes(0xeb), false, 'no short jump anywhere');
    const refused = held + 5 + attempt[held + 4];
    assert.deepEqual([...attempt.slice(refused)], [0x31, 0xc0, 0xc2, 0x04, 0x00],
        'the refused path answers zero');
});

test('the counters block is two dwords the fast paths increment', ()=>{
    assert.equal(COUNTERS.SIZE, 8);
    assert.equal(COUNTERS.LEFT - COUNTERS.ENTERED, 4);
});

/** The host's half, with a memory and threads the test drives by hand. */
function machine(){
    const memory = new Uint8Array(0x10000);
    let free = 0x100;
    /** @type {{ thread: any, reason: string }[]} */
    const blocked = [];
    /** @type {{ thread: any, result: number | undefined }[]} */
    const woken = [];
    /** @type {any} */
    let current = { id: 7, name: 'main' };
    const sections = createCriticalSections({
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        currentThread: ()=>current,
        block: (thread, reason)=>{
            blocked.push({ thread, reason });
        },
        wake: (thread, result)=>{
            woken.push({ thread, result });
            return true;
        },
        park: ()=>PARKED,
        allocate: bytes=>{
            const at = free;
            free += bytes;
            return at;
        },
    });
    /** @param {number} at */
    const get32 = at=>i32(memory, at);
    return {
        sections, blocked, woken, get32, memory,
        /** @param {any} thread */
        run: thread=>{
            current = thread;
        },
    };
}

test('a contended entry queues the caller, and a release hands it the section', ()=>{
    const m = machine();
    const section = 0x9000;
    const waiter = { id: 9, name: 'thread-2' };
    m.run(waiter);

    assert.equal(m.sections.wait(section), PARKED);
    assert.equal(m.blocked.length, 1);
    assert.equal(m.blocked[0].thread, waiter);
    assert.match(m.blocked[0].reason, /critical section 0x9000/);
    assert.deepEqual(m.sections.waiting(), ['thread-2: critical section 0x9000']);

    m.run({ id: 7, name: 'main' });
    m.sections.wake(section);

    assert.equal(m.woken.length, 1);
    assert.equal(m.woken[0].thread, waiter);
    assert.equal(m.get32(section + CS.OWNING_THREAD), 9, 'the structure names the new owner');
    assert.equal(m.get32(section + CS.RECURSION_COUNT), 1, 'entered once');
    assert.deepEqual(m.sections.waiting(), []);
    assert.equal(m.sections.diagnostics().handoffs, 1);
});

test('a wake that arrives before its waiter is kept, not lost', ()=>{
    // The waiter incremented LockCount, was preempted, and the owner left in
    // between: the release found nobody queued. When the waiter reaches the
    // trap the section is already its own.
    const m = machine();
    const section = 0x9000;

    m.sections.wake(section);
    assert.equal(m.woken.length, 0);
    assert.equal(m.sections.diagnostics().owed, 1);

    const late = { id: 11, name: 'thread-3' };
    m.run(late);
    assert.equal(m.sections.wait(section), 0, 'answered at once');
    assert.equal(m.blocked.length, 0, 'never blocked');
    assert.equal(m.get32(section + CS.OWNING_THREAD), 11);
    assert.equal(m.get32(section + CS.RECURSION_COUNT), 1);
    assert.equal(m.sections.diagnostics().owed, 0);
});

test('waiters are handed the section in the order they queued', ()=>{
    const m = machine();
    const first = { id: 2, name: 'a' };
    const second = { id: 3, name: 'b' };
    m.run(first);
    m.sections.wait(0x9000);
    m.run(second);
    m.sections.wait(0x9000);

    m.sections.wake(0x9000);
    m.sections.wake(0x9000);

    assert.deepEqual(m.woken.map(one=>one.thread), [first, second]);
    assert.equal(m.get32(0x9000 + CS.OWNING_THREAD), 3, 'the last hand-off stands');
});

test('a release passes over a suspended waiter to one that can run', ()=>{
    // A suspended thread is not waiting on the section while it is suspended:
    // the release goes to the next waiter, as the semaphore behind a section
    // would satisfy the next thread waiting on it.
    const m = machine();
    const suspended = { id: 2, name: 'a' };
    const running = { id: 3, name: 'b' };
    m.run(suspended);
    m.sections.wait(0x9000);
    m.run(running);
    m.sections.wait(0x9000);
    Object.assign(suspended, { suspendCount: 1 });

    m.sections.wake(0x9000);

    assert.deepEqual(m.woken.map(one=>one.thread), [running]);
    assert.equal(m.get32(0x9000 + CS.OWNING_THREAD), 3);
    assert.deepEqual(m.sections.waiting(), ['a: critical section 0x9000'],
        'and the suspended one is still queued');
});

test('a release with only suspended waiters is kept for whoever can take it', ()=>{
    // Nobody can run to take the section: the release is owed, a newcomer
    // takes it as it would a wake that came early, and a waiter resumed while
    // one is owed takes it on resuming.
    const m = machine();
    const suspended = { id: 2, name: 'a', suspendCount: 1 };
    m.run(suspended);
    m.sections.wait(0x9000);

    m.sections.wake(0x9000);
    assert.equal(m.woken.length, 0, 'nobody is handed it');
    assert.equal(m.sections.diagnostics().owed, 1);

    suspended.suspendCount = 0;
    m.sections.resumed(suspended);
    assert.deepEqual(m.woken.map(one=>one.thread), [suspended]);
    assert.equal(m.get32(0x9000 + CS.OWNING_THREAD), 2);
    assert.equal(m.sections.diagnostics().owed, 0);
    assert.deepEqual(m.sections.waiting(), []);

    m.sections.resumed({ id: 5, name: 'c' });
    assert.equal(m.woken.length, 1, 'a thread queued nowhere is nothing to hand to');
});

test('the counters block is read by the host and written by the fast paths', ()=>{
    const m = machine();
    assert.deepEqual(m.sections.diagnostics().entered, 0, 'nothing placed yet reads as nothing');
    assert.equal(m.sections.counters(), 0x100, 'made on first use, zeroed');
    assert.equal(m.sections.counters(), 0x100, 'and only once');
    // The fast path incremented it in the guest; nothing else can.
    m.memory.set([5, 0, 0, 0, 3, 0, 0, 0], 0x100);
    assert.equal(m.sections.diagnostics().entered, 5);
    assert.equal(m.sections.diagnostics().left, 3);
});

test('a deleted section takes its queue with it', ()=>{
    const m = machine();
    m.run({ id: 2, name: 'a' });
    m.sections.wait(0x9000);
    m.sections.forget(0x9000);
    assert.deepEqual(m.sections.waiting(), []);
    assert.equal(m.sections.diagnostics().queued, 0);
});
