/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNoticeThread, loopCode, LOOP_BYTES } from './thread.js';

const PARKED = Object.freeze({ parked: true });

/** A machine with one thread and a memory the loop and the host share. */
function machine(){
    const memory = new Uint8Array(0x1000);
    let free = 0x100;
    /** @type {Record<string, { argBytes: number, handler: () => any }>} */
    const traps = {};
    /** @type {any[]} */
    const created = [];
    /** @type {{ thread: any, result: number }[]} */
    const woken = [];
    /** @type {{ thread: any, reason: string }[]} */
    const blocked = [];
    /** @type {any} */
    let current = null;

    const notices = createNoticeThread({
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
            const thread = { name: options.name, entry: options.entry, state: 'ready' };
            created.push(thread);
            return thread;
        },
        currentThread: ()=>current,
        block: (thread, reason)=>{
            thread.state = 'blocked';
            blocked.push({ thread, reason });
        },
        wake: (thread, result)=>{
            thread.state = 'ready';
            woken.push({ thread, result });
            return true;
        },
        park: ()=>PARKED,
    });

    /** @param {number} at */
    const get32 = at=>(memory[at] | memory[at + 1] << 8
        | memory[at + 2] << 16 | memory[at + 3] << 24) >>> 0;
    /** What the loop reads out of a record. @param {number} at */
    const record = at=>({
        entry: get32(at),
        args: [4, 8, 12, 16, 20].map(offset=>get32(at + offset)),
    });
    /** The loop asking for its next notice, as the trap sees it. */
    const ask = ()=>{
        current = created[0];
        return traps['<wave-notices>'].handler();
    };

    return { memory, notices, created, woken, blocked, record, ask, get32 };
}

test('the loop is the bytes it says it is, with the call made relative', ()=>{
    const code = loopCode(0x900, 0x200);
    assert.equal(code.length, LOOP_BYTES);
    // call rel32: 0x900 - (0x200 + 5)
    assert.deepEqual([...code.slice(0, 5)], [0xe8, 0xfb, 0x06, 0x00, 0x00]);
    // mov esi, esp; five pushes of [eax+20] down to [eax+4]; call [eax];
    // mov esp, esi; jmp back to the start
    assert.deepEqual([...code.slice(5)], [
        0x89, 0xe6,
        0xff, 0x70, 0x14, 0xff, 0x70, 0x10, 0xff, 0x70, 0x0c,
        0xff, 0x70, 0x08, 0xff, 0x70, 0x04, 0xff, 0x10,
        0x89, 0xf4, 0xeb, 0xe4,
    ]);
});

test('the first notice makes the thread, whose entry is the loop', ()=>{
    const m = machine();
    assert.equal(m.notices.diagnostics().started, false, 'nothing until something is owed');

    m.notices.deliver(0x38230b0, [0x1000, 0x3bd, 7, 0x300, 0]);

    assert.equal(m.created.length, 1);
    assert.equal(m.created[0].name, 'winmm');
    const entry = m.created[0].entry;
    assert.deepEqual([...m.memory.slice(entry, entry + LOOP_BYTES)], [...loopCode(0x900, entry)],
        'the loop was written where the thread starts');
    assert.equal(m.notices.diagnostics().queued, 1, 'the notice waits for the loop to ask');
});

test('asking with a notice owed answers its record, and the loop is not stopped', ()=>{
    const m = machine();
    m.notices.deliver(0x38230b0, [0x1000, 0x3bd, 7, 0x300, 0]);

    const answer = m.ask();

    assert.equal(typeof answer, 'number');
    assert.deepEqual(m.record(answer), { entry: 0x38230b0, args: [0x1000, 0x3bd, 7, 0x300, 0] });
    assert.equal(m.blocked.length, 0);
    assert.equal(m.notices.diagnostics().delivered, 1);
});

test('asking with nothing owed blocks and parks the thread, and the next notice wakes it', ()=>{
    const m = machine();
    m.notices.deliver(0x38230b0, [1, 2, 3, 4, 5]);
    m.ask();

    const parked = m.ask();

    assert.equal(parked, PARKED);
    assert.equal(m.blocked.length, 1);
    assert.equal(m.blocked[0].thread, m.created[0]);
    assert.equal(m.notices.diagnostics().waiting, true);

    m.notices.deliver(0x38230b0, [6, 7, 8, 9, 10]);

    assert.equal(m.woken.length, 1);
    assert.equal(m.woken[0].thread, m.created[0]);
    assert.deepEqual(m.record(m.woken[0].result), { entry: 0x38230b0, args: [6, 7, 8, 9, 10] },
        'woken with the record in EAX, already filled in');
    assert.equal(m.notices.diagnostics().waiting, false);
});

test('notices queued while the routine runs go out one at a time, in order', ()=>{
    const m = machine();
    m.notices.deliver(0xa0, [1, 0, 0, 0, 0]);
    m.ask();
    // The routine is running; two more buffers come back meanwhile.
    m.notices.deliver(0xa0, [2, 0, 0, 0, 0]);
    m.notices.deliver(0xa0, [3, 0, 0, 0, 0]);
    assert.equal(m.woken.length, 0, 'a running thread is not woken');
    assert.equal(m.notices.diagnostics().queued, 2);

    assert.deepEqual(m.record(m.ask()).args[0], 2);
    assert.deepEqual(m.record(m.ask()).args[0], 3);
    assert.equal(m.ask(), PARKED, 'and then it waits');
    assert.equal(m.notices.diagnostics().delivered, 3);
});

test('a routine takes five arguments and is given exactly five', ()=>{
    const m = machine();
    m.notices.deliver(0xa0, [1, 2, 3, 4, 5, 6, 7]);
    const at = m.ask();
    assert.deepEqual(m.record(at).args, [1, 2, 3, 4, 5]);
    // The loop is allocated right after the record: extra arguments would have
    // overwritten its first instruction.
    const entry = m.created[0].entry;
    assert.deepEqual([...m.memory.slice(entry, entry + LOOP_BYTES)], [...loopCode(0x900, entry)]);
});

test('a routine of fewer arguments gets zeros for the rest, and is told of its return', ()=>{
    const m = machine();
    /** @type {string[]} */
    const returned = [];
    m.notices.deliver(0xa0, [0x50, 0x60], ()=>returned.push('first'));
    m.notices.deliver(0xb0, [7], ()=>returned.push('second'));
    assert.deepEqual(m.record(m.ask()).args, [0x50, 0x60, 0, 0, 0]);
    assert.deepEqual(returned, [], 'not until the loop asks again');
    assert.equal(m.notices.diagnostics().running, true);
    assert.deepEqual(m.record(m.ask()).args, [7, 0, 0, 0, 0]);
    assert.deepEqual(returned, ['first']);
    assert.equal(m.ask(), PARKED);
    assert.deepEqual(returned, ['first', 'second']);
    assert.equal(m.notices.diagnostics().running, false);
});

test('notices taken back by their tag never reach the loop', ()=>{
    const m = machine();
    const going = {};
    m.notices.deliver(0xa0, [1]);
    m.notices.deliver(0xa0, [2], undefined, going);
    m.notices.deliver(0xa0, [3]);
    m.notices.deliver(0xa0, [4], undefined, going);
    assert.deepEqual(m.notices.drop(going).map(notice=>notice.args[0]), [2, 4]);
    assert.equal(m.record(m.ask()).args[0], 1);
    assert.equal(m.record(m.ask()).args[0], 3);
    assert.equal(m.ask(), PARKED);
});
