/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSwitcher } from './switch.js';

/** A cpu API that records what the switch primitive asked it to do. */
function recordingCpu(){
    /** @type {{ op: string, context: any, threadBase?: number }[]} */
    const calls = [];
    let nextContext = 0;
    return {
        calls,
        captureContext(){
            const context = { id: `saved-${nextContext++}` };
            calls.push({ op: 'capture', context });
            return context;
        },
        /** @param {any} context @param {number} threadBase */
        restoreContext(context, threadBase){
            calls.push({ op: 'restore', context, threadBase });
        },
    };
}

/** @param {string} name @param {number} tebAddress */
const thread = (name, tebAddress)=>({ name, tebAddress, context: { id: `${name}-initial` } });

test('switching saves the outgoing thread and restores the incoming one', ()=>{
    const cpu = recordingCpu();
    const switcher = createSwitcher({ cpu });
    const a = thread('a', 0x7ffd0000);
    const b = thread('b', 0x7ffe0000);

    assert.equal(switcher.switchTo(a, b), true);

    assert.deepEqual(cpu.calls.map(c=>c.op), ['capture', 'restore'],
        'the outgoing thread is saved before the incoming one is restored');
    assert.equal(a.context.id, 'saved-0', "the saved state replaces the outgoing thread's context");
    assert.equal(cpu.calls[1].context.id, 'b-initial');
});

test('the TEB travels with the restore, so FS cannot be left behind', ()=>{
    const cpu = recordingCpu();
    const switcher = createSwitcher({ cpu });
    const a = thread('a', 0x7ffd0000);
    const b = thread('b', 0x7ffe0000);

    switcher.switchTo(a, b);
    assert.equal(cpu.calls[1].threadBase, 0x7ffe0000, 'restoring b sets FS to b TEB');

    switcher.switchTo(b, a);
    assert.equal(cpu.calls[3].threadBase, 0x7ffd0000, 'and back again for a');
});

test('the first switch has no outgoing thread to save', ()=>{
    const cpu = recordingCpu();
    const switcher = createSwitcher({ cpu });
    const first = thread('first', 0x7ffd0000);

    assert.equal(switcher.switchTo(null, first), true);
    assert.deepEqual(cpu.calls.map(c=>c.op), ['restore'],
        'nothing was running, so nothing is saved');
});

test('switching to the running thread does nothing at all', ()=>{
    const cpu = recordingCpu();
    const switcher = createSwitcher({ cpu });
    const a = thread('a', 0x7ffd0000);

    assert.equal(switcher.switchTo(a, a), false);
    assert.deepEqual(cpu.calls, [],
        'a round trip through save and restore would hide a bug in that round trip');
    assert.equal(a.context.id, 'a-initial', 'the context is untouched');
    assert.equal(switcher.diagnostics().selfSwitches, 1);
});

test('a switch with nothing to run is a programming error', ()=>{
    const switcher = createSwitcher({ cpu: recordingCpu() });
    assert.throws(()=>switcher.switchTo(thread('a', 0), null), /requires a thread to run/);
});

test('diagnostics count real switches separately from self-switches', ()=>{
    const switcher = createSwitcher({ cpu: recordingCpu() });
    const a = thread('a', 0x1000);
    const b = thread('b', 0x2000);

    switcher.switchTo(null, a);
    switcher.switchTo(a, b);
    switcher.switchTo(b, b);

    assert.deepEqual(switcher.diagnostics(), { switches: 2, selfSwitches: 1, recentResumes: [] });
});

test('a call parked before its stub\'s ret returns through that ret, and one past it goes on', ()=>{
    // A wait that blocks retires what one answered at once does: the stub's
    // ret, not a jump past it, whichever the executors' timing made it.
    const PARK = 0x1000;
    const STUB = 0x2000;
    const ESP = 0x8000;
    /** @type {Map<number, number>} */
    const bytes = new Map([[STUB, 0xc2], [STUB + 1, 12], [STUB + 2, 0]]);
    /** @type {Map<number, number>} */
    const words = new Map([[ESP, PARK]]);
    const memory = {
        readU8: (/** @type {number} */ at)=>bytes.get(at) ?? 0,
        readU16: (/** @type {number} */ at)=>(bytes.get(at) ?? 0) | (bytes.get(at + 1) ?? 0) << 8,
        readU32: (/** @type {number} */ at)=>words.get(at) ?? 0,
        writeU32: (/** @type {number} */ at, /** @type {number} */ value)=>{ words.set(at, value); },
    };
    /** @type {any[]} */
    const resumed = [];
    const cpu = { ...recordingCpu(), parkAddress: ()=>PARK,
        resumeContextAt: (/** @type {any} */ _context, /** @type {any} */ where)=>{ resumed.push(where); } };
    const switcher = createSwitcher({ cpu, memory });
    const parked = { name: 'p', tebAddress: 0, context: { eip: STUB, reg32: [0, 0, 0, 0, ESP] } };
    const resume = { eip: 0x401051, esp: ESP + 16, returnValue: 0, inStub: true };

    switcher.switchTo(null, parked, resume);
    assert.deepEqual(resumed[0], { eip: STUB, esp: ESP, returnValue: 0 },
        'at the ret, its stack as it was');
    assert.equal(words.get(ESP), 0x401051, 'the return address back where the park loop\'s stood');

    // Its ret already run: the thread sits in the park loop and goes where it says.
    switcher.switchTo(null, { ...parked, context: { eip: PARK, reg32: [0, 0, 0, 0, ESP + 16] } },
        resume);
    assert.deepEqual(resumed[1], { eip: 0x401051, esp: ESP + 16, returnValue: 0 });
    // Sent elsewhere rather than back from its call.
    switcher.switchTo(null, parked, { ...resume, inStub: false });
    assert.equal(resumed[2].eip, 0x401051);
});
