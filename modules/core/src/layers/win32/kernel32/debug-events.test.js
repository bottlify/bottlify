/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DBG_CONTINUE, DBG_EXCEPTION_NOT_HANDLED, DEBUG_EVENT, createDebuggerFunctions,
    debuggeeFor, mergeContextGroups } from './debug-events.js';

const PARKED = 'parked';
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_SEM_TIMEOUT = 121;

/**
 * A debugger with its children: guest memory, a handle table that hands out
 * numbers, and the waits it parks and wakes.
 *
 * @param {any[]} children
 * @param {any} [extra]
 */
function debuggerOf(children, extra = {}){
    const bytes = new Uint8Array(0x1000);
    const view = new DataView(bytes.buffer);
    /** @type {number[]} */
    const errors = [];
    /** @type {any[]} */
    const opened = [];
    /** @type {any[]} */
    const blocked = [];
    /** @type {any[]} */
    const woken = [];
    /** @type {((thread: any) => void)[]} */
    const expiries = [];
    /** @type {[any, number][]} */
    const errorsFor = [];
    const thread = { id: 0x10 };
    const kernel = {
        processes: { all: ()=>children },
        handles: { open: (/** @type {string} */ type, /** @type {any} */ object)=>{
            opened.push({ type, object });
            return 0x100 + opened.length * 4;
        } },
        block: (/** @type {any} */ who, /** @type {string} */ why, /** @type {any} */ timed)=>
            blocked.push({ who, timed }),
        wake: (/** @type {any} */ who, /** @type {number} */ value)=>woken.push([who, value]),
        clock: { virtualTime: ()=>1000 },
        onTimeout: (/** @type {(thread: any) => void} */ handler)=>expiries.push(handler),
    };
    const side = createDebuggerFunctions({
        kernel,
        writeMemory: (address, written)=>bytes.set(written, address),
        setLastError: code=>errors.push(code),
        setLastErrorFor: (who, code)=>errorsFor.push([who, code]),
        currentThread: ()=>thread,
        park: ()=>/** @type {any} */ (PARKED),
        ...extra,
    });
    const fns = /** @type {any} */ (side.functions);
    /** @param {number} at */
    const u32 = at=>view.getUint32(at, true);
    return { side, fns, errors, opened, blocked, woken, expiries, errorsFor, thread, u32, view };
}

/** @param {number} [flags] */
const child = (flags = 1)=>({ id: 0x300, threadId: 0x304, exitCode: 259,
    debugged: debuggeeFor(flags) });

test('a child is a debuggee when started with DEBUG_PROCESS or DEBUG_ONLY_THIS_PROCESS', ()=>{
    assert.equal(debuggeeFor(0), null);
    assert.equal(debuggeeFor(4), null, 'CREATE_SUSPENDED alone');
    assert.equal(debuggeeFor(1)?.onlyThis, false, 'DEBUG_PROCESS: its own children too');
    assert.equal(debuggeeFor(2)?.onlyThis, true);
    assert.equal(debuggeeFor(3)?.onlyThis, false, 'both: DEBUG_PROCESS wins');
});

test('an event stops the debuggee until ContinueDebugEvent answers it with its status', async()=>{
    const debuggee = child();
    const { side, fns, u32, opened } = debuggerOf([debuggee]);
    const answered = side.deliver(debuggee, { code: DEBUG_EVENT.CREATE_PROCESS,
        threadId: 0x304, base: 0x400000, start: 0x401000 });
    let settled = null;
    answered.then(value=>{
        settled = value;
    });
    assert.equal(fns.WaitForDebugEvent.handler([0x200, 0]), 1);
    assert.deepEqual([u32(0x200), u32(0x204), u32(0x208)], [3, 0x300, 0x304]);
    assert.deepEqual([u32(0x20c), u32(0x210), u32(0x214), u32(0x218), u32(0x228)],
        [0, 0x104, 0x108, 0x400000, 0x401000], 'no file; the process and thread opened here');
    assert.deepEqual(opened.map(each=>each.type), ['process', 'process-thread']);
    await Promise.resolve();
    assert.equal(settled, null, 'stopped until continued');
    assert.equal(fns.ContinueDebugEvent.handler([0x300, 0x304, DBG_CONTINUE]), 1);
    assert.equal(await answered, DBG_CONTINUE);
});

test('one event of a debuggee at a time: the next waits until the outstanding one is continued',
    ()=>{
        const debuggee = child();
        const { side, fns, u32, errors } = debuggerOf([debuggee]);
        side.deliver(debuggee, { code: DEBUG_EVENT.LOAD_DLL, threadId: 0x304, base: 0x10000000 });
        side.deliver(debuggee, { code: DEBUG_EVENT.UNLOAD_DLL, threadId: 0x304,
            base: 0x10000000 });
        assert.equal(fns.WaitForDebugEvent.handler([0x200, 0]), 1);
        assert.deepEqual([u32(0x200), u32(0x210)], [6, 0x10000000], 'LOAD_DLL: lpBaseOfDll');
        assert.equal(fns.WaitForDebugEvent.handler([0x200, 0]), 0, 'not before the continue');
        assert.equal(errors.at(-1), ERROR_SEM_TIMEOUT);
        assert.equal(fns.ContinueDebugEvent.handler([0x300, 0x999, DBG_CONTINUE]), 0,
            'another thread has nothing outstanding');
        assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
        assert.equal(fns.ContinueDebugEvent.handler([0x300, 0x304, DBG_CONTINUE]), 1);
        assert.equal(fns.WaitForDebugEvent.handler([0x200, 0]), 1);
        assert.deepEqual([u32(0x200), u32(0x20c)], [7, 0x10000000], 'UNLOAD_DLL');
    });

test('an exception is reported with its record and whether it is the first chance', async()=>{
    const debuggee = child();
    const { side, fns, u32 } = debuggerOf([debuggee]);
    const answered = side.deliver(debuggee, { code: DEBUG_EVENT.EXCEPTION, threadId: 0x304,
        exception: { code: 0xc0000005, flags: 0, address: 0x401234, parameters: [1, 0x10],
            firstChance: true } });
    assert.equal(fns.WaitForDebugEvent.handler([0x200, 0]), 1);
    assert.deepEqual([u32(0x200), u32(0x20c), u32(0x210), u32(0x214), u32(0x218), u32(0x21c),
        u32(0x220), u32(0x224), u32(0x25c)],
    [1, 0xc0000005, 0, 0, 0x401234, 2, 1, 0x10, 1]);
    assert.equal(fns.ContinueDebugEvent.handler([0x300, 0x304, DBG_EXCEPTION_NOT_HANDLED]), 1);
    assert.equal(await answered, DBG_EXCEPTION_NOT_HANDLED, 'the handlers are asked next');
});

test('a debuggee\'s words and its threads are reported as Windows lays them out', ()=>{
    const debuggee = child();
    const { side, fns, u32, view } = debuggerOf([debuggee]);
    side.deliver(debuggee, { code: DEBUG_EVENT.OUTPUT_DEBUG_STRING, threadId: 0x304,
        string: { address: 0x500, length: 5, unicode: true } });
    assert.equal(fns.WaitForDebugEvent.handler([0x200, 0]), 1);
    assert.deepEqual([u32(0x200), u32(0x20c), view.getUint16(0x210, true),
        view.getUint16(0x212, true)], [8, 0x500, 1, 5]);
    fns.ContinueDebugEvent.handler([0x300, 0x304, DBG_CONTINUE]);
    side.deliver(debuggee, { code: DEBUG_EVENT.CREATE_THREAD, threadId: 0x308, start: 0x402000 });
    assert.equal(fns.WaitForDebugEvent.handler([0x200, 0]), 1);
    assert.deepEqual([u32(0x200), u32(0x208), u32(0x214)], [2, 0x308, 0x402000]);
    assert.notEqual(u32(0x20c), 0, 'the thread handed over as a handle');
    fns.ContinueDebugEvent.handler([0x300, 0x308, DBG_CONTINUE]);
    side.deliver(debuggee, { code: DEBUG_EVENT.EXIT_THREAD, threadId: 0x308, exitCode: 4 });
    assert.equal(fns.WaitForDebugEvent.handler([0x200, 0]), 1);
    assert.deepEqual([u32(0x200), u32(0x20c)], [4, 4]);
});

test('a waiting debugger is woken with the event, and its time-out says ERROR_SEM_TIMEOUT', ()=>{
    const debuggee = child();
    const { side, fns, u32, blocked, woken, expiries, errorsFor, thread } =
        debuggerOf([debuggee]);
    assert.equal(fns.WaitForDebugEvent.handler([0x200, 0xffffffff]), PARKED);
    assert.equal(blocked[0].timed, undefined, 'INFINITE');
    side.deliver(debuggee, { code: DEBUG_EVENT.LOAD_DLL, threadId: 0x304, base: 0x20000000 });
    assert.deepEqual(woken, [[thread, 1]]);
    assert.equal(u32(0x210), 0x20000000, 'written where it waited');
    fns.ContinueDebugEvent.handler([0x300, 0x304, DBG_CONTINUE]);

    assert.equal(fns.WaitForDebugEvent.handler([0x200, 20000]), PARKED);
    assert.deepEqual(blocked[1].timed, { deadline: 21000, result: 0 });
    expiries.forEach(handler=>handler(thread));
    assert.deepEqual(errorsFor, [[thread, ERROR_SEM_TIMEOUT]]);
    side.deliver(debuggee, { code: DEBUG_EVENT.LOAD_DLL, threadId: 0x304, base: 0x30000000 });
    assert.equal(woken.length, 1, 'a wait that ran out is not answered');
});

test('the exit is the debuggee\'s last event; then it is debugged no more', ()=>{
    const debuggee = child();
    const { side, fns, u32, errors } = debuggerOf([debuggee]);
    debuggee.exitCode = 7;
    side.exited(debuggee);
    assert.equal(fns.WaitForDebugEvent.handler([0x200, 0]), 1);
    assert.deepEqual([u32(0x200), u32(0x204), u32(0x208), u32(0x20c)], [5, 0x300, 0x304, 7]);
    assert.equal(fns.ContinueDebugEvent.handler([0x300, 0x304, DBG_CONTINUE]), 1);
    assert.equal(debuggee.debugged, null);
    assert.equal(fns.WaitForDebugEvent.handler([0x200, 0xffffffff]), 0,
        'nobody left to hear from');
    assert.equal(errors.at(-1), ERROR_SEM_TIMEOUT);
    side.exited({ id: 0x400, debugged: null });
});

test('ContinueDebugEvent takes the statuses Windows takes, DBG_REPLY_LATER from 1709 on', ()=>{
    const seven = debuggerOf([child()], { windows: { major: 6, build: 7601 } });
    assert.equal(seven.fns.ContinueDebugEvent.handler([0x300, 0x304, 0x40010001]), 0);
    assert.equal(seven.errors.at(-1), ERROR_INVALID_PARAMETER, 'DBG_REPLY_LATER before 10');
    assert.equal(seven.fns.ContinueDebugEvent.handler([0x300, 0x304, 0x1234]), 0);
    /** @type {string[]} */
    const said = [];
    const debuggee = child();
    const ten = debuggerOf([debuggee], { windows: { major: 10, build: 19045 },
        divergence: (/** @type {string} */ api)=>said.push(api) });
    const answered = ten.side.deliver(debuggee, { code: DEBUG_EVENT.LOAD_DLL, threadId: 0x304 });
    ten.fns.WaitForDebugEvent.handler([0x200, 0]);
    assert.equal(ten.fns.ContinueDebugEvent.handler([0x300, 0x304, 0x40010001]), 1);
    assert.deepEqual(said, ['ContinueDebugEvent'], 'not reported again, and said');
    return answered.then(value=>assert.equal(value, DBG_CONTINUE));
});

test('DebugActiveProcessStop lets the debuggee go; DebugSetProcessKillOnExit needs one', async()=>{
    const debuggee = child();
    const plain = { id: 0x310, debugged: null };
    const { side, fns, errors } = debuggerOf([debuggee, plain]);
    assert.deepEqual([fns.WaitForDebugEvent.argBytes, fns.ContinueDebugEvent.argBytes,
        fns.DebugActiveProcessStop.argBytes, fns.DebugSetProcessKillOnExit.argBytes],
    [8, 12, 4, 4]);
    assert.equal(fns.DebugSetProcessKillOnExit.handler([0]), 1);
    assert.equal(debuggee.debugged?.killOnExit, false);
    const pending = side.deliver(debuggee, { code: DEBUG_EVENT.LOAD_DLL, threadId: 0x304 });
    assert.equal(fns.DebugActiveProcessStop.handler([0x310]), 0, 'not debugged here');
    assert.equal(errors.at(-1), ERROR_INVALID_HANDLE);
    assert.equal(fns.DebugActiveProcessStop.handler([0x999]), 0, 'no such process');
    assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
    assert.equal(fns.DebugActiveProcessStop.handler([0x300]), 1);
    assert.equal(await pending, DBG_CONTINUE, 'what it reported is continued');
    assert.equal(debuggee.debugged, null);
    assert.equal(fns.DebugSetProcessKillOnExit.handler([1]), 0, 'no debug object any more');
    assert.equal(errors.at(-1), ERROR_INVALID_HANDLE);
});

test('a debugger\'s SetThreadContext replaces only the groups the record names', ()=>{
    const into = new Uint8Array(0x2cc).fill(0x11);
    const given = new Uint8Array(0x2cc).fill(0x22);
    new DataView(given.buffer).setUint32(0, 0x10001, true); // CONTEXT_CONTROL
    mergeContextGroups(into, given);
    assert.equal(into[0xb8], 0x22, 'Eip');
    assert.equal(into[0xc4], 0x22, 'Esp');
    assert.equal(into[0xb0], 0x11, 'Eax kept');
    assert.equal(into[0x04], 0x11, 'Dr0 kept');
    assert.equal(into[0], 0x11, 'the flags word is not a group');
    new DataView(given.buffer).setUint32(0, 0x10017, true); // INTEGER|CONTROL|SEGMENTS|DEBUG
    mergeContextGroups(into, given);
    assert.deepEqual([into[0xb0], into[0x04], into[0x8c], into[0x1c]], [0x22, 0x22, 0x22, 0x11]);
});
