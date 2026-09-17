/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createParking, isParkedCall } from './parking.js';

/** @param {string} name */
const thread = name=>({ name });

/** @param {any} running */
function parking(running){
    const held = { on: running };
    /** @type {any[]} */
    const parked = [];
    const made = createParking({
        kernel: {
            currentThread: ()=>held.on,
            /** @param {any} which */
            parkThread: which=>parked.push(which),
        },
    });
    return { made, held, parked };
}

/** @param {string} name @param {number} esp */
const frame = (name, esp)=>({
    name, freeStack: esp, restingStack: esp + 8, hostReturn: 0x401000,
});

test('a thread in a call of its own is told where its stack is free', ()=>{
    const main = thread('main');
    const { made } = parking(main);
    made.beginCall(frame('USER32.dll!DispatchMessageA', 0x2ff000));

    assert.equal(made.freeStackFor(main), 0x2ff000);
});

test('a thread is never given another thread\'s stack to build a frame on', ()=>{
    // The defect this pins crashed a real program well away from its cause. A
    // handler that awaits has had its call ended by the dispatcher, so by the
    // time it calls the guest back the frame in flight belongs to whichever
    // thread trapped next. Handing that thread's ESP back writes the callback's
    // arguments and return address over its live locals; the callback itself
    // runs and returns perfectly, and the trampled thread fails much later at
    // an address that holds no code.
    const main = thread('main');
    const worker = thread('thread-3');
    const { made, held } = parking(main);

    made.beginCall(frame('WINMM.dll!waveOutWrite', 0x2ff000));
    made.endCall();
    // The loop turned while the handler awaited, and someone else trapped.
    held.on = worker;
    made.beginCall(frame('KERNEL32.dll!ReadFile', 0x1ff000));

    assert.equal(made.freeStackFor(main), undefined,
        'the awaited handler falls back to its own thread\'s resting stack');
    assert.equal(made.freeStackFor(worker), 0x1ff000);
});

test('with nothing in flight there is no stack to offer', ()=>{
    const main = thread('main');
    const { made } = parking(main);
    assert.equal(made.freeStackFor(main), undefined);
});

test('parking a caller answers with the token that says so, and only in a call', ()=>{
    const main = thread('main');
    const { made, parked } = parking(main);
    assert.throws(()=>made.park(), /guest call is in flight/);

    made.beginCall(frame('USER32.dll!GetMessageA', 0x2ff000));
    assert.ok(isParkedCall(made.park()));
    assert.deepEqual(parked, [main]);
});

test('parking a caller tells the kernel where the stub leaves the stack', ()=>{
    // The stub's `ret` may not have run by the time the thread is switched
    // away: a slice can end on the instruction after the trap. A resume that
    // trusts the saved ESP then returns through the park address the kernel
    // wrote there, and the thread lands in code that is not its own.
    const main = thread('main');
    /** @type {any[]} */
    const parked = [];
    const made = createParking({
        kernel: {
            currentThread: ()=>main,
            /** @param {any} which @param {number} [resting] */
            parkThread: (which, resting)=>parked.push([which, resting]),
        },
    });
    made.beginCall(frame('KERNEL32.dll!SleepEx', 0x2ffed0));
    made.park();
    assert.deepEqual(parked, [[main, 0x2ffed8]]);
});

test('parking a thread other than the one whose call is in flight is refused', ()=>{
    const main = thread('main');
    const worker = thread('thread-3');
    const made = createParking({
        kernel: {
            currentThread: ()=>worker,
            parkThread: ()=>assert.fail('nothing may be parked'),
        },
    });
    made.beginCall(frame('KERNEL32.dll!ReadFile', 0x1ff000));
    assert.throws(()=>made.park(main), /parks the thread whose call is in flight/);
});
