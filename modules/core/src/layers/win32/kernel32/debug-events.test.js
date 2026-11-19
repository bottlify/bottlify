/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DBG_CONTINUE, DBG_EXCEPTION_NOT_HANDLED, DEBUG_EVENT, attachEvents,
    createDebuggerFunctions, debuggeeFor, mergeContextGroups } from './debug-events.js';
import { DEBUG_ATTACH, DEBUG_BREAK } from './cross-process.js';

const PARKED = 'parked';
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_SEM_TIMEOUT = 121;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
const STATUS_INVALID_HANDLE = 0xc0000008;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_PORT_NOT_SET = 0xc0000353;
const STATUS_DEBUGGER_INACTIVE = 0xc0000354;

/**
 * A debugger with its children: guest memory, a handle table that hands out
 * numbers, and the waits it parks and wakes.
 *
 * @param {any[]} children
 * @param {any} [extra]
 */
function debuggerOf(children, extra = {}, table = new Map()){
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
            const handle = 0x100 + opened.length * 4;
            table.set(handle, [type, object]);
            return handle;
        },
        holds: (/** @type {any} */ object)=>[...table.values()].some(([, held])=>held === object),
        typeOf: (/** @type {number} */ handle)=>table.get(handle)?.[0] ?? null,
        resolve: (/** @type {number} */ handle)=>table.get(handle)?.[1] ?? null },
        block: (/** @type {any} */ who, /** @type {string} */ why, /** @type {any} */ timed)=>
            blocked.push({ who, timed }),
        wake: (/** @type {any} */ who, /** @type {number} */ value)=>woken.push([who, value]),
        clock: { virtualTime: ()=>1000 },
        onTimeout: (/** @type {(thread: any) => void} */ handler)=>expiries.push(handler),
    };
    let slot = 0;
    const side = createDebuggerFunctions({
        kernel,
        writeMemory: (address, written)=>bytes.set(written, address),
        readMemory: (address, length)=>bytes.slice(address, address + length),
        threadDebugObject: { get: ()=>slot, set: handle=>{
            slot = handle;
        } },
        setLastError: code=>errors.push(code),
        setLastErrorFor: (who, code)=>errorsFor.push([who, code]),
        currentThread: ()=>thread,
        park: ()=>/** @type {any} */ (PARKED),
        ...extra,
    });
    const fns = /** @type {any} */ (side.functions);
    // The children the helper made debug to this thread's debug object, as
    // CreateProcess with DEBUG_PROCESS attaches them.
    for (const each of children)
    {
        if (each.debugged?.object === UNBOUND)
        {
            each.debugged.object = side.connect();
        }
    }
    /** @param {number} at */
    const u32 = at=>view.getUint32(at, true);
    return { side, fns, errors, opened, blocked, woken, expiries, errorsFor, thread, u32, view,
        table, slot: ()=>slot };
}

/** The debug object a helper child reports to until `debuggerOf` binds it. */
const UNBOUND = { killOnClose: true };

/** @param {number} [flags] */
const child = (flags = 1)=>({ id: 0x300, threadId: 0x304, exitCode: 259,
    debugged: debuggeeFor(flags, ()=>UNBOUND) });

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
        [0, 0x108, 0x10c, 0x400000, 0x401000], 'no file; the process and thread opened here');
    assert.deepEqual(opened.map(each=>each.type), ['debug-object', 'process', 'process-thread']);
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
    assert.equal(fns.WaitForDebugEvent.handler([0x200, 0]), 0, 'nothing left to hear');
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

test('DebugActiveProcessStop lets the debuggee go; DebugSetProcessKillOnExit needs a debug object',
    async()=>{
        const debuggee = child();
        const plain = { id: 0x310, debugged: null };
        const none = debuggerOf([]);
        assert.equal(none.fns.DebugSetProcessKillOnExit.handler([0]), 0, 'the thread has none');
        assert.equal(none.errors.at(-1), ERROR_INVALID_HANDLE);
        const { side, fns, errors } = debuggerOf([debuggee, plain]);
        assert.deepEqual([fns.WaitForDebugEvent.argBytes, fns.ContinueDebugEvent.argBytes,
            fns.DebugActiveProcessStop.argBytes, fns.DebugSetProcessKillOnExit.argBytes],
        [8, 12, 4, 4]);
        const object = side.connect();
        assert.equal(fns.DebugSetProcessKillOnExit.handler([0]), 1);
        assert.equal(object.killOnClose, false, 'set on the thread\'s debug object');
        const pending = side.deliver(debuggee, { code: DEBUG_EVENT.LOAD_DLL, threadId: 0x304 });
        assert.equal(fns.DebugActiveProcessStop.handler([0x310]), 0, 'not debugged here');
        assert.equal(errors.at(-1), ERROR_INVALID_HANDLE);
        assert.equal(fns.DebugActiveProcessStop.handler([0x999]), 0, 'no such process');
        assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
        assert.equal(fns.DebugActiveProcessStop.handler([0x300]), 1);
        assert.equal(await pending, DBG_CONTINUE, 'what it reported is continued');
        assert.equal(debuggee.debugged, null);
    });

test('a debugger that ends takes its debuggees with it, and lets go those told not to', async()=>{
    const taken = child();
    const kept = { ...child(), id: 0x320 };
    /** @type {any} */ (kept.debugged).object = { killOnClose: false };
    /** @type {[number, number][]} */
    const ended = [];
    const { side } = debuggerOf([taken, kept], {
        terminateChild: (/** @type {any} */ who, /** @type {number} */ code)=>
            ended.push([who.id, code]) > 0,
    });
    const waiting = side.deliver(kept, { code: DEBUG_EVENT.LOAD_DLL, threadId: 0x324 });
    side.debuggerEnded();
    assert.deepEqual(ended, [[0x300, STATUS_DEBUGGER_INACTIVE]]);
    assert.equal(await waiting, DBG_CONTINUE, 'what the one let go reported is continued');
    assert.deepEqual([taken.debugged, kept.debugged], [null, null]);
});

test('the native debug object: made, set, connected to, attached through and closed', async()=>{
    const debuggee = { id: 0x330, threadId: 0x334, debugged: null };
    /** @type {[number, number][]} */
    const ended = [];
    const { side, fns, view, u32, table, slot } = debuggerOf([debuggee], {
        terminateChild: (/** @type {any} */ who, /** @type {number} */ code)=>
            ended.push([who.id, code]) > 0,
        askChild: ()=>Promise.resolve({ result: 1, error: 0, outs: [] }),
    });
    const natives = fns.DebugSetProcessKillOnExit.natives;
    assert.equal(natives.NtCreateDebugObject.handler([0x200, 0x1f000f, 0, 0xfffe]),
        STATUS_INVALID_PARAMETER, 'a flag that is not DEBUG_KILL_ON_CLOSE');
    assert.equal(natives.NtCreateDebugObject.handler([0x200, 0x1f000f, 0, 0]), 0);
    const debug = u32(0x200);
    assert.deepEqual(table.get(debug)?.[1], { killOnClose: false });
    view.setUint32(0x210, 1, true);
    assert.equal(natives.NtSetInformationDebugObject.handler([debug, 1, 0x210, 4, 0]), 0);
    assert.equal(table.get(debug)?.[1].killOnClose, true);
    assert.equal(natives.NtSetInformationDebugObject.handler([debug, 1, 0x210, 2, 0x214]),
        STATUS_INFO_LENGTH_MISMATCH);
    assert.equal(u32(0x214), 4);
    assert.equal(natives.NtSetInformationDebugObject.handler([debug, 2, 0x210, 4, 0]),
        STATUS_INVALID_PARAMETER);
    assert.equal(natives.NtSetInformationDebugObject.handler([0x999, 1, 0x210, 4, 0]),
        STATUS_INVALID_HANDLE);

    assert.equal(slot(), 0);
    assert.equal(natives.DbgUiConnectToDbg.handler([]), 0);
    const connected = slot();
    assert.equal(table.get(connected)?.[0], 'debug-object', 'the thread\'s, in its block');
    assert.deepEqual(table.get(connected)?.[1], { killOnClose: true });
    natives.DbgUiConnectToDbg.handler([]);
    assert.equal(slot(), connected, 'one per thread');

    table.set(0x400, ['process', debuggee]);
    assert.equal(await natives.NtDebugActiveProcess.handler([0x400, debug]), 0);
    assert.equal(/** @type {any} */ (debuggee.debugged).object, table.get(debug)?.[1]);
    assert.equal(natives.NtRemoveProcessDebug.handler([0x400, connected]), STATUS_PORT_NOT_SET,
        'not through another debug object');
    assert.equal(natives.NtRemoveProcessDebug.handler([0x400, debug]), 0);
    assert.equal(debuggee.debugged, null);
    assert.deepEqual(ended, [], 'removed, not ended');

    // Attached again, then its last handle closed: DEBUG_KILL_ON_CLOSE ends it.
    await natives.NtDebugActiveProcess.handler([0x400, debug]);
    const object = table.get(debug)?.[1];
    table.delete(debug);
    side.closed(object);
    assert.deepEqual(ended, [[0x330, STATUS_DEBUGGER_INACTIVE]]);
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

test('a process attached to tells what it already is: itself, ntdll, its threads, its libraries',
    ()=>{
        assert.deepEqual(attachEvents({ mainThreadId: 8, image: { base: 0x400000, start: 0x401000 },
            ntdll: 0x7c900000, libraries: [0x400000, 0x7c900000, 0x7c800000, 0x10000000],
            threads: [8, 12, 16] }), [
            { code: DEBUG_EVENT.CREATE_PROCESS, threadId: 8, base: 0x400000, start: 0x401000 },
            { code: DEBUG_EVENT.LOAD_DLL, threadId: 8, base: 0x7c900000 },
            { code: DEBUG_EVENT.CREATE_THREAD, threadId: 12 },
            { code: DEBUG_EVENT.CREATE_THREAD, threadId: 16 },
            { code: DEBUG_EVENT.LOAD_DLL, threadId: 8, base: 0x7c800000 },
            { code: DEBUG_EVENT.LOAD_DLL, threadId: 8, base: 0x10000000 },
        ], 'ntdll before the threads, as Vista and later report it; the image is no library');
    });

test('DebugActiveProcess attaches to a child it can reach, and refuses itself and no process',
    async()=>{
        const running = /** @type {{ id: number, threadId: number, debugged: any }} */ (
            { id: 0x300, threadId: 0x304, debugged: null });
        /** @type {[any, any][]} */
        const asked = [];
        const answers = [{ result: 1, error: null }, { result: 0, error: 50 }];
        const { fns, errors, errorsFor } = debuggerOf([running], {
            processId: 0x200,
            askChild: (/** @type {any} */ record, /** @type {any} */ call)=>{
                asked.push([record, call.call]);
                return Promise.resolve({ ...answers.shift(), outs: [] });
            },
        });
        assert.equal(fns.DebugActiveProcess.handler([0]), 0);
        assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER);
        assert.equal(fns.DebugActiveProcess.handler([0x200]), 0, 'not the caller itself');
        assert.equal(errors.at(-1), ERROR_ACCESS_DENIED);
        assert.equal(fns.DebugActiveProcess.handler([0x999]), 0);
        assert.equal(errors.at(-1), ERROR_INVALID_PARAMETER, 'no process of that id');

        assert.equal(await fns.DebugActiveProcess.handler([0x300]), 1);
        assert.deepEqual(asked, [[running, DEBUG_ATTACH]], 'the child is told it is attached to');
        assert.equal(running.debugged?.onlyThis, true, 'it alone, not its children');
        assert.equal(fns.DebugActiveProcess.handler([0x300]), 0, 'one debugger at a time');
        assert.equal(errors.at(-1), ERROR_ACCESS_DENIED);

        // A child that cannot be heard (in a worker of its own) refuses it.
        running.debugged = null;
        assert.equal(await fns.DebugActiveProcess.handler([0x300]), 0);
        assert.equal(running.debugged, null, 'and is not debugged');
        assert.deepEqual(errorsFor.at(-1)?.[1], 50);
    });

test('DebugBreakProcess breaks into a debugged process and does nothing to another', async()=>{
    const debugged = { id: 0x300, debugged: debuggeeFor(1) };
    const plain = { id: 0x310, debugged: null };
    const own = { id: 0x200, current: true };
    /** @type {string[]} */
    const asked = [];
    let broke = 0;
    let debuggedHere = false;
    const { fns, errors } = debuggerOf([debugged, plain], {
        askChild: (/** @type {any} */ _record, /** @type {any} */ call)=>{
            asked.push(call.call);
            return Promise.resolve({ result: 1, error: null, outs: [] });
        },
        debugged: ()=>debuggedHere,
        breakIn: ()=>++broke,
    }, new Map([[0x50, ['process', debugged]], [0x54, ['process', plain]],
        [0x58, ['event', {}]], [0x5c, ['process', own]]]));
    assert.equal(fns.DebugBreakProcess.handler([0xffffffff]), 1, 'no debugger: nothing happens');
    assert.equal(fns.DebugBreakProcess.handler([0x5c]), 1);
    assert.equal(broke, 0);
    debuggedHere = true;
    assert.equal(fns.DebugBreakProcess.handler([0xffffffff]), 1);
    assert.equal(broke, 1, 'a debuggee breaks into its own debugger');
    assert.equal(fns.DebugBreakProcess.handler([0x54]), 1);
    assert.equal(await fns.DebugBreakProcess.handler([0x50]), 1);
    assert.deepEqual(asked, [DEBUG_BREAK], 'only the debugged child is asked');
    assert.equal(fns.DebugBreakProcess.handler([0x58]), 0, 'an event is no process');
    assert.equal(errors.at(-1), ERROR_INVALID_HANDLE);
});

test('a wait hears only the debuggees of its own debug object', ()=>{
    const ours = child();
    const theirs = { ...child(), id: 0x320 };
    /** @type {any} */ (theirs.debugged).object = { killOnClose: true };
    const { side, fns, u32, errors } = debuggerOf([theirs, ours]);
    side.deliver(theirs, { code: DEBUG_EVENT.LOAD_DLL, threadId: 0x324, base: 0x50000000 });
    assert.equal(fns.WaitForDebugEvent.handler([0x200, 0]), 0, 'another object\'s event');
    assert.equal(errors.at(-1), ERROR_SEM_TIMEOUT);
    assert.equal(fns.ContinueDebugEvent.handler([0x320, 0x324, DBG_CONTINUE]), 0);
    side.deliver(ours, { code: DEBUG_EVENT.LOAD_DLL, threadId: 0x304, base: 0x60000000 });
    assert.equal(fns.WaitForDebugEvent.handler([0x200, 0]), 1);
    assert.deepEqual([u32(0x204), u32(0x210)], [0x300, 0x60000000]);

    const none = debuggerOf([]);
    assert.equal(none.fns.WaitForDebugEvent.handler([0x200, 0]), 0, 'a thread with no object');
    assert.equal(none.errors.at(-1), ERROR_INVALID_HANDLE);
    assert.equal(none.fns.ContinueDebugEvent.handler([0x300, 0x304, DBG_CONTINUE]), 0);
    assert.equal(none.errors.at(-1), ERROR_INVALID_HANDLE);
});

test('the native wait hands out the state change DbgUi converts to the event', async()=>{
    const STATUS_TIMEOUT = 0x102;
    const debuggee = child();
    const { side, fns, u32, view, slot, blocked, woken, expiries, errorsFor, thread } =
        debuggerOf([debuggee]);
    const natives = fns.DebugSetProcessKillOnExit.natives;
    const answered = side.deliver(debuggee, { code: DEBUG_EVENT.EXCEPTION, threadId: 0x304,
        exception: { code: 0x80000003, flags: 0, address: 0x401000, parameters: [0],
            firstChance: true } });
    assert.equal(natives.NtWaitForDebugEvent.handler([slot(), 0, 0, 0x300]), 0);
    assert.deepEqual([u32(0x300), u32(0x304), u32(0x308), u32(0x30c), u32(0x318), u32(0x35c)],
        [7, 0x300, 0x304, 0x80000003, 0x401000, 1], 'DbgBreakpointStateChange');
    assert.equal(natives.DbgUiConvertStateChangeStructure.handler([0x300, 0x400]), 0);
    assert.deepEqual([u32(0x400), u32(0x404), u32(0x40c), u32(0x418), u32(0x45c)],
        [1, 0x300, 0x80000003, 0x401000, 1], 'EXCEPTION_DEBUG_EVENT');
    view.setUint32(0x500, 0x300, true);
    view.setUint32(0x504, 0x304, true);
    assert.equal(natives.NtDebugContinue.handler([slot(), 0x500, 0x1234]),
        STATUS_INVALID_PARAMETER, 'no DBG_* status');
    assert.equal(natives.DbgUiContinue.handler([0x500, DBG_EXCEPTION_NOT_HANDLED]), 0);
    assert.equal(await answered, DBG_EXCEPTION_NOT_HANDLED);
    assert.equal(natives.NtDebugContinue.handler([slot(), 0x500, DBG_CONTINUE]),
        STATUS_INVALID_PARAMETER, 'nothing outstanding');
    assert.equal(natives.NtWaitForDebugEvent.handler([0x999, 0, 0, 0x300]), STATUS_INVALID_HANDLE);

    // OutputDebugString's exception converts to OUTPUT_DEBUG_STRING_EVENT.
    side.deliver(debuggee, { code: DEBUG_EVENT.OUTPUT_DEBUG_STRING, threadId: 0x304,
        string: { address: 0x700, length: 6, unicode: false } });
    view.setBigInt64(0x600, -10_000n * 50n, true);
    assert.equal(natives.DbgUiWaitStateChange.handler([0x300, 0x600]), 0);
    assert.deepEqual([u32(0x300), u32(0x30c), u32(0x31c), u32(0x320), u32(0x324)],
        [6, 0x40010006, 2, 6, 0x700]);
    natives.DbgUiConvertStateChangeStructure.handler([0x300, 0x400]);
    assert.deepEqual([u32(0x400), u32(0x40c), view.getUint16(0x410, true),
        view.getUint16(0x412, true)], [8, 0x700, 0, 6]);
    natives.DbgUiContinue.handler([0x500, DBG_CONTINUE]);
    view.setUint32(0x300, 0, true);
    assert.equal(natives.DbgUiConvertStateChangeStructure.handler([0x300, 0x400]), 0xc0000001,
        'DbgIdle is no event');

    // A wait with nothing to hand out parks; its time-out is STATUS_TIMEOUT, no last error.
    assert.equal(natives.NtWaitForDebugEvent.handler([slot(), 0, 0x600, 0x300]), PARKED);
    assert.deepEqual(blocked.at(-1).timed, { deadline: 1050, result: STATUS_TIMEOUT });
    expiries.forEach(handler=>handler(thread));
    assert.deepEqual(errorsFor, []);
    assert.equal(natives.NtWaitForDebugEvent.handler([slot(), 0, 0, 0x300]), PARKED,
        'NULL: for ever');
    side.deliver(debuggee, { code: DEBUG_EVENT.UNLOAD_DLL, threadId: 0x304, base: 0x10000000 });
    assert.deepEqual(woken.at(-1), [thread, 0], 'STATUS_SUCCESS');
    assert.deepEqual([u32(0x300), u32(0x30c)], [10, 0x10000000], 'DbgUnloadDllStateChange');
});
