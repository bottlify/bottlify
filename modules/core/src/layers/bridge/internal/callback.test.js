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

test('a driver waiting for an answer is woken by the next call that finishes', async()=>{
    // A machine whose every thread is parked on the host can only move when a
    // host call answers. A driver that slept on a timer instead woke fifty
    // thousand times a second to find nothing changed -- and that spin starved
    // the decoder the parked call was waiting on. So the wake is the answer
    // itself, and it is one wake per answer: a promise taken before the call
    // finishes settles then, and one taken afterwards waits for the next.
    const worker = thread('thread-2');
    const { made } = callbacks([worker]);
    made.suspended(worker, { name: 'KERNEL32.dll!ReadFile', restingStack: 0x40, hostReturn: 0x50 });

    let woken = false;
    const wake = made.answered().then(()=>{
        woken = true;
    });
    assert.equal(made.answered(), made.answered(), 'one promise for everyone waiting');
    await Promise.resolve();
    assert.equal(woken, false, 'nothing has answered yet');

    made.finish(worker, 7);
    await wake;
    assert.equal(woken, true);

    let again = false;
    made.answered().then(()=>{
        again = true;
    });
    await Promise.resolve();
    assert.equal(again, false, 'an answer already given does not wake a later waiter');
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
    assert.equal(outerBase, 0x2ff000 - 4 * 6);
    assert.equal(written.get(outerBase), SENTINEL);

    // It runs, pushing locals of its own, and then makes a host call that calls
    // the guest back. That call's own free stack is where it is standing now --
    // which is far below where its frame began.
    made.call({ thread: worker, entry: 0x401000, args: [1, 2, 3, 4], stackAtRest: 0x2fe800 });
    const innerBase = resumed[1][1].esp;

    assert.equal(innerBase, 0x2fe800 - 4 * 6,
        'the inner frame is built below the stack actually in use');
    assert.ok(innerBase < outerBase,
        'and not on top of the outer procedure, which is still standing');
    assert.equal(written.get(outerBase), SENTINEL,
        'so the outer return address still points at the sentinel');
});

test('a callback made after a nested host call answered goes below that call, not the frame', ()=>{
    // A dialog procedure, entered as a callback, opens a modal dialog of its
    // own: that host call suspends below the procedure's locals, runs its
    // callbacks, and answers. The outer modal loop then dispatches the next
    // message with nothing in flight -- and the outer callback frame is
    // still open, far above where the procedure is actually standing.
    const worker = thread('main');
    const { made, resumed, written } = callbacks([worker]);
    made.reserve();

    made.call({ thread: worker, entry: 0x400000, args: [1, 2, 3, 4], stackAtRest: 0x2ff000 });
    const outerBase = resumed[0][1].esp;
    // The procedure ran on, and its own host call suspended well below.
    made.suspended(worker,
        { name: 'DialogBoxParamA', restingStack: 0x2fe800, hostReturn: 0x401234 });
    made.call({ thread: worker, entry: 0x401000, args: [1, 2, 3, 4] });
    assert.equal(resumed[1][1].esp, 0x2fe800 - 4 * 6, 'below the suspended call');
    made.returned(worker);

    // The nested call is still suspended while its loop drains what is left.
    made.call({ thread: worker, entry: 0x401000, args: [1, 2, 3, 4] });
    assert.equal(resumed[2][1].esp, 0x2fe800 - 4 * 6, 'still below it, not at the outer frame');
    assert.equal(written.get(outerBase), SENTINEL, 'the outer return address is untouched');
    made.returned(worker);
    made.finish(worker, 1);

    // Answered: the procedure is running again on its own stack, and the next
    // callback it can receive comes through a host call it makes -- whose
    // free stack is what decides then. Nothing else is suspended, so the
    // outer frame is the only record, and is right: a stopped thread with
    // nothing below its frame is standing at it.
    made.call({ thread: worker, entry: 0x401000, args: [], stackAtRest: 0x2fe700 });
    assert.equal(resumed[4][1].esp, 0x2fe700 - 8);
});

test('a callback with no call in flight still finds a stack', ()=>{
    // Nothing is running that could say where the stack is, so the frames
    // themselves are the only answer there is.
    const worker = thread('main');
    const { made, resumed } = callbacks([worker]);
    made.reserve();
    made.call({ thread: worker, entry: 0x400000, args: [], stackAtRest: 0x2ff000 });
    made.call({ thread: worker, entry: 0x401000, args: [] });
    assert.equal(resumed[1][1].esp, resumed[0][1].esp - 8);
});

test('a stdcall callback leaves the sentinel a dword that belongs to nobody', ()=>{
    // The defect this pins: a dialog procedure delivered a message by the
    // modal loop is built at the resting stack of the suspended DialogBoxParamA,
    // and pops its four arguments on the way out, so ESP is back at that
    // resting position when the sentinel traps. The sentinel parks the thread
    // by writing the park address at ESP and returning through it -- onto the
    // return address of the procedure that called DialogBoxParamA, which then
    // returned into the park loop once the dialog ended. A real program was
    // stopped dead by its own "Yes" button.
    const worker = thread('main');
    const { made, resumed, written } = callbacks([worker]);
    made.reserve();
    const resting = 0x2fbc10;
    made.suspended(worker,
        { name: 'DialogBoxParamA', restingStack: resting, hostReturn: 0x414e5f });
    made.call({ thread: worker, entry: 0x414e70, args: [0xf8, 0x111, 6, 0xfc] });
    const frameBase = resumed[0][1].esp;
    assert.equal(written.get(frameBase), SENTINEL);
    const afterRet16 = frameBase + 4 + 4 * 4;
    assert.ok(afterRet16 < resting,
        'after `ret 16` the sentinel stands below the first live dword of the caller');
    assert.equal(afterRet16 + 4, resting,
        'and its own `ret` pops exactly the spare, landing at the resting position');
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

test('being sent to address zero is refused, and says which call sent it', ()=>{
    // A fault at 0x00000000 reads as the program calling a null pointer, and
    // when the address was ours that reading sends a reader off to disassemble
    // the program. The one fact that separates the two -- which host call chose
    // the entry -- exists only here, and only until the frame unwinds.
    const worker = thread('main');
    const { made, resumed } = callbacks([worker]);
    made.reserve();

    assert.throws(
        ()=>made.call({
            thread: worker, entry: 0, args: [1], stackAtRest: 0x2ff000,
            by: 'USER32.dll!DispatchMessageA',
        }),
        /USER32.dll!DispatchMessageA asked to run guest code at address zero/);
    assert.deepEqual(resumed, [], 'and the thread was not sent anywhere');
});

test('what the guest was last sent to run is kept for a failure report', ()=>{
    const worker = thread('main');
    const { made } = callbacks([worker]);
    made.reserve();
    made.call({
        thread: worker, entry: 0x401000, args: [], stackAtRest: 0x2ff000,
        by: 'USER32.dll!DispatchMessageA',
    });

    assert.deepEqual(made.recentlyStarted(),
        [{ entry: 0x401000, by: 'USER32.dll!DispatchMessageA', thread: 'main' }]);
});

test('a callback can be sent in with the registers its code reads before setting them', ()=>{
    // A funclet of an exception handler addresses its parent's locals through
    // EBP from its first instruction.
    const worker = thread('main');
    const { made, resumed } = callbacks([worker]);
    made.reserve();

    made.call({
        thread: worker, entry: 0x401000, args: [], stackAtRest: 0x2ff000,
        registers: { ebp: 0x2ffe0c },
    });

    assert.deepEqual(resumed[0][1].registers, { ebp: 0x2ffe0c });
});

test('a transfer abandons every call below the line and keeps every one above it', ()=>{
    // The catch is in a window procedure: the dispatch that called the
    // procedure is above the line and still waiting, the throw and the frame
    // handler it reached are below it and never come back.
    const worker = thread('main');
    const { made, resumed } = callbacks([worker]);
    made.reserve();
    made.suspended(worker, {
        name: 'USER32.dll!DispatchMessageA', restingStack: 0x2ff800, hostReturn: 0x401000,
    });
    made.call({ thread: worker, entry: 0x402000, args: [1, 2, 3, 4], stackAtRest: 0x2ff7f0 });
    made.suspended(worker, {
        name: 'msvcrt.dll!_CxxThrowException', restingStack: 0x2ff400, hostReturn: 0x402100,
    });
    made.call({ thread: worker, entry: 0x403000, args: [1, 2, 3, 4], stackAtRest: 0x2ff100 });
    made.suspended(worker, {
        name: 'msvcrt.dll!__CxxFrameHandler3', restingStack: 0x2ff0c0, hostReturn: 0x403010,
    });

    made.transfer(worker, { eip: 0x402200, esp: 0x2ff500, ebp: 0x2ff5a0 }, 0x2ff500);

    assert.deepEqual(made.diagnostics().suspendedCalls.map((/** @type {any} */ call)=>call.name),
        ['USER32.dll!DispatchMessageA'], 'the dispatch the procedure runs under is still waiting');
    assert.deepEqual(resumed.at(-1), ['main', {
        eip: 0x402200, esp: 0x2ff500, registers: { ebp: 0x2ff5a0 },
    }]);

    // The procedure returns to its sentinel normally afterwards: the frame it
    // pops is its own, not one of the abandoned ones.
    assert.equal(made.returned(worker), true);
    assert.equal(made.returned(worker), false, 'and there was only the one left');
});

test('a transfer with no line given draws it at the new stack pointer', ()=>{
    const worker = thread('main');
    const { made } = callbacks([worker]);
    made.suspended(worker, { name: 'outer', restingStack: 0x2ff800, hostReturn: 0x401000 });
    made.suspended(worker, { name: 'inner', restingStack: 0x2ff300, hostReturn: 0x401100 });

    made.transfer(worker, { eip: 0x401200, esp: 0x2ff300 });

    assert.deepEqual(made.diagnostics().suspendedCalls.map((/** @type {any} */ call)=>call.name),
        ['outer'], 'a call resting exactly on the line returned into it, and is gone');
    assert.equal(made.pendingCalls(), 1);
});

test('a callback whose handler jumped to its catch is passed over by the one that returns',
    async()=>{
        // A guest exception handler that finds its catch unwinds and jumps
        // there: the dispatch's call to it never returns, and its frame is
        // left below everything. The next return belongs to the routine the
        // host started first, and must answer that one.
        const registers = { esp: 0, ecx: 0 };
        const main = thread('main');
        const made = createCallbacks({
            cpu: { readReg32: (/** @type {'esp' | 'ecx'} */ name)=>registers[name] },
            kernel: { threads: ()=>[main], scheduleResume: ()=>{} },
            memory: { writeU32: ()=>{} },
            reserveTrap: ()=>({ id: 1, address: SENTINEL }),
        });
        made.reserve();
        const method = made.call({ thread: main, entry: 0x401000, args: [1, 2, 3],
            stackAtRest: 0x9000 });
        made.suspended(main, { name: 'KERNEL32.dll!RaiseException', restingStack: 0x8f00,
            hostReturn: 0x402000 });
        const handler = made.call({ thread: main, entry: 0x403000, args: [4, 5, 6, 7] });
        let handlerAnswered = false;
        handler.then(()=>{
            handlerAnswered = true;
        });

        // The method comes back with `ret 12`, its frame at 0x9000 - 20.
        registers.esp = 0x9000 - 20 + 16;
        registers.ecx = 0x80004005;
        assert.equal(made.returned(main), true);
        assert.equal(await method, 0x80004005 | 0, 'the method\'s answer reaches its caller');
        await Promise.resolve();
        assert.equal(handlerAnswered, false, 'the abandoned handler call is never answered');
        assert.equal(made.pendingCalls(), 0, 'nor is the throw it was dispatched from');
    });

test('a catch the guest jumped to itself is seen at the thread\'s next wait', ()=>{
    // The runtime's frame handler is guest code: it runs the catch and jumps
    // to the continuation, and neither the throw nor the handler's callback
    // returns. The thread's next host call stands above both, and a wait
    // there is a wait for the host -- not a callback the scheduler runs.
    const main = /** @type {any} */ ({ name: 'main', stackLimit: 0x200000, stackTop: 0x300000 });
    const { made } = callbacks([main]);
    made.reserve();
    // Each handler builds its callback's frame, then suspends.
    made.call({ thread: main, entry: 0x402000, args: [1, 2, 3, 4], stackAtRest: 0x2ff7f0 });
    made.suspended(main, { name: 'USER32.dll!DispatchMessageA', restingStack: 0x2ff800,
        hostReturn: 0x401000 });
    made.call({ thread: main, entry: 0x403000, args: [1, 2, 3, 4], stackAtRest: 0x2ff100 });
    made.suspended(main, { name: 'KERNEL32.dll!RaiseException', restingStack: 0x2ff400,
        hostReturn: 0x402100 });

    made.suspended(main, { name: 'USER32.dll!GetMessageA', restingStack: 0x2ff600,
        hostReturn: 0x402200 });

    assert.deepEqual(made.diagnostics().suspendedCalls.map((/** @type {any} */ call)=>call.name),
        ['USER32.dll!DispatchMessageA', 'USER32.dll!GetMessageA'],
        'the throw is gone, the dispatch the procedure runs under is not');
    assert.equal(made.pendingCalls(), 2);
    assert.equal(main.awaitingHost, true,
        'a wait inside the procedure the dispatch called is a wait, not a callback to run');

    made.finish(main, 1);
    assert.equal(made.returned(main), true, 'whose frame is the one left');
    assert.equal(made.returned(main), false);
});

test('a wait made with nothing open but abandoned frames is a wait for the host', ()=>{
    const main = /** @type {any} */ ({ name: 'main', stackLimit: 0x200000, stackTop: 0x300000 });
    const { made } = callbacks([main]);
    made.reserve();
    made.call({ thread: main, entry: 0x403000, args: [1, 2], stackAtRest: 0x2ff100 });
    made.suspended(main, { name: 'KERNEL32.dll!RaiseException', restingStack: 0x2ff120,
        hostReturn: 0x402100 });
    made.suspended(main, { name: 'USER32.dll!GetMessageA', restingStack: 0x2ff800,
        hostReturn: 0x401000 });
    assert.equal(main.awaitingHost, true, 'the thread is parked, not sent to run');
    assert.equal(made.pendingCalls(), 1, 'on the one call it is in');
});

test('a call made on a fiber\'s stack leaves the thread\'s own frames alone', ()=>{
    const main = /** @type {any} */ ({ name: 'main', stackLimit: 0x200000, stackTop: 0x300000 });
    const { made } = callbacks([main]);
    made.reserve();
    made.call({ thread: main, entry: 0x403000, args: [1], stackAtRest: 0x2ff100 });
    made.suspended(main, { name: 'outer', restingStack: 0x2ff120, hostReturn: 0x401000 });
    made.suspended(main, { name: 'on the fiber', restingStack: 0x5ff000, hostReturn: 0x404000 });
    assert.deepEqual(made.diagnostics().suspendedCalls.map((/** @type {any} */ call)=>call.name),
        ['outer', 'on the fiber']);
    made.finish(main, 0);
    assert.equal(made.returned(main), true, 'the frame below is still there to return to');
});

test('a call that builds its callback before it suspends keeps it', ()=>{
    // An enumeration calls the guest back from its handler, and only then
    // is it suspended: the frame stands below the call's own stack, and it
    // is the callback the thread is about to run, not one it jumped out of.
    const main = /** @type {any} */ ({ name: 'main', stackLimit: 0x200000, stackTop: 0x300000 });
    const { made } = callbacks([main]);
    made.reserve();
    made.call({ thread: main, entry: 0x403000, args: [1, 2, 3, 4], stackAtRest: 0x2ff7e0 });
    made.suspended(main, { name: 'GDI32.dll!EnumFontFamiliesExA', restingStack: 0x2ff800,
        hostReturn: 0x401000 });

    assert.equal(main.awaitingHost, false, 'the thread is sent to run the callback');
    assert.equal(made.returned(main), true, 'whose frame is still there to return to');
});
