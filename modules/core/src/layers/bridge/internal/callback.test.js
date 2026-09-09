/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCallbacks } from './callback.js';

/**
 * Enough of the machine for the bookkeeping a suspended call does. Nothing
 * here runs guest code: what is under test is what the report can say about a
 * call that has stopped and not come back.
 *
 * @param {any[]} threads
 */
function callbacks(threads){
    /** @type {any[]} */
    const resumed = [];
    /** @type {Map<number, number>} */
    const written = new Map();
    const made = createCallbacks({
        cpu: { readReg32: ()=>0 },
        kernel: {
            threads: ()=>threads,
            /** @param {any} thread @param {any} where */
            scheduleResume: (thread, where)=>resumed.push([thread.name, where]),
        },
        memory: {
            /** @param {number} address @param {number} value */
            writeU32: (address, value)=>written.set(address >>> 0, value >>> 0),
        },
        reserveTrap: ()=>({ id: 1, address: SENTINEL }),
    });
    return { made, resumed, written };
}

/** The address a callback returns to, which is the whole point of the frame. */
const SENTINEL = 0x1000;

/** @param {string} name */
const thread = name=>({ name });

test('a report names the call that is holding the machine, not just a count', ()=>{
    // A count above zero says only that the run loop has to keep handing the
    // thread back to the host. Which call is not coming back is the question
    // anyone actually asks, and it was the one thing not answered.
    const worker = thread('thread-9');
    const { made } = callbacks([thread('main'), worker]);

    made.suspended(worker, {
        name: 'KERNEL32.dll!GetQueuedCompletionStatus', restingStack: 0x2000, hostReturn: 0x3000,
    });

    const report = made.diagnostics();
    assert.equal(report.suspended, 1);
    assert.deepEqual(report.suspendedCalls.map((/** @type {any} */ call)=>
        [call.thread, call.name]),
    [['thread-9', 'KERNEL32.dll!GetQueuedCompletionStatus']]);
    assert.ok(report.suspendedCalls[0].forMs >= 0, 'and how long it has been waiting');
});

test('a call that answered is no longer named as holding anything', ()=>{
    const worker = thread('thread-2');
    const { made, resumed } = callbacks([worker]);
    made.suspended(worker, { name: 'KERNEL32.dll!ReadFile', restingStack: 0x40, hostReturn: 0x50 });
    made.finish(worker, 7);

    const report = made.diagnostics();
    assert.equal(report.suspended, 0);
    assert.deepEqual(report.suspendedCalls, []);
    assert.deepEqual(resumed, [['thread-2', { eip: 0x50, esp: 0x40, returnValue: 7 }]],
        'and the thread went back to its own code where the call left it');
});

test('a callback made from inside a callback goes below the stack in use', async()=>{
    // The defect this pins stopped a real program dead with nothing to show for
    // it. A window procedure that subclasses another calls back into the guest
    // from inside a callback; taking the outer callback's frame base as the
    // resting stack builds the inner frame on top of the outer procedure's live
    // locals and its return address. The inner call returns perfectly, the
    // outer one returns to the wreckage, the sentinel never fires, and the host
    // call waiting on it is never answered.
    const worker = thread('main');
    const { made, resumed, written } = callbacks([worker]);
    made.reserve();

    // The outer procedure is entered with the stack the host call left free.
    made.call({ thread: worker, entry: 0x400000, args: [1, 2, 3, 4], stackAtRest: 0x2ff000 });
    const outerBase = resumed[0][1].esp;
    assert.equal(outerBase, 0x2ff000 - 4 * 5);
    assert.equal(written.get(outerBase), SENTINEL);

    // It runs, pushing locals of its own, and then makes a host call that calls
    // the guest back. That call's own free stack is where it is standing now --
    // which is far below where its frame began.
    made.call({ thread: worker, entry: 0x401000, args: [1, 2, 3, 4], stackAtRest: 0x2fe800 });
    const innerBase = resumed[1][1].esp;

    assert.equal(innerBase, 0x2fe800 - 4 * 5,
        'the inner frame is built below the stack actually in use');
    assert.ok(innerBase < outerBase,
        'and not on top of the outer procedure, which is still standing');
    assert.equal(written.get(outerBase), SENTINEL,
        'so the outer return address still points at the sentinel');
});

test('a callback with no call in flight still finds a stack', ()=>{
    // Nothing is running that could say where the stack is, so the frames
    // themselves are the only answer there is.
    const worker = thread('main');
    const { made, resumed } = callbacks([worker]);
    made.reserve();
    made.call({ thread: worker, entry: 0x400000, args: [], stackAtRest: 0x2ff000 });
    made.call({ thread: worker, entry: 0x401000, args: [] });
    assert.equal(resumed[1][1].esp, resumed[0][1].esp - 4);
});

test('every thread is looked at, not only the one on the processor', ()=>{
    // The thread holding the machine is rarely the one running: it is stopped
    // precisely because its call has not answered.
    const first = thread('thread-3');
    const second = thread('thread-4');
    const { made } = callbacks([first, second]);
    made.suspended(first, { name: 'WINMM.dll!waveOutWrite', restingStack: 1, hostReturn: 2 });
    made.suspended(second, { name: 'KERNEL32.dll!ReadFile', restingStack: 3, hostReturn: 4 });

    assert.deepEqual(made.diagnostics().suspendedCalls.map((/** @type {any} */ c)=>c.name),
        ['WINMM.dll!waveOutWrite', 'KERNEL32.dll!ReadFile']);
});

test('a callback runs on the thread whose call it answers, not whoever is current', ()=>{
    // A host call that awaits anything -- a file, a range request -- lets go of
    // the processor, and the loop gives every other thread its turns while it
    // waits. By the time it resumes, the thread on the processor is somebody
    // else, and building the callback's frame there puts it on a stranger's
    // stack. The caller has to say whose call it is answering.
    const asked = thread('main');
    const other = thread('thread-3');
    const { made, resumed } = callbacks([asked, other]);
    made.reserve();

    made.call({ thread: asked, entry: 0x400000, args: [1], stackAtRest: 0x2ff000 });

    assert.deepEqual(resumed.map(([name])=>name), ['main'],
        'the frame was built for the thread that asked, whoever is running now');
});
