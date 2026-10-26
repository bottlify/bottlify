/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    WINEVENT_INCONTEXT, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WINEVENT_SKIPOWNTHREAD,
    createWinEventHooks,
} from './hooks.js';

const EVENT_MIN = 0x00000001;
const EVENT_MAX = 0x7fffffff;
const EVENT_OBJECT_CREATE = 0x8000;
const EVENT_OBJECT_SHOW = 0x8002;
const EVENT_OBJECT_LOCATIONCHANGE = 0x800b;
const EVENT_OBJECT_NAMECHANGE = 0x800c;
const EVENT_OBJECT_VALUECHANGE = 0x800e;
const OBJID_CLIENT = -4;
const OBJID_CARET = -8;
const CHILDID_SELF = 0;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_HOOK_FILTER = 1426;
const ERROR_INVALID_FILTER_PROC = 1427;
const ERROR_HOOK_NEEDS_HMOD = 1428;
const ERROR_INVALID_THREAD_ID = 1444;

const MODULE = 0x400000;
const PROC = 0x401000;
const OTHER_PROC = 0x402000;
const PROCESS = 0x1000;
const HWND = 0x10010;
const MAIN = { id: 0x20 };
const WORKER = { id: 0x24 };

/**
 * A host whose guest calls are recorded, on a caller the test moves, with
 * windows owned by the main thread.
 *
 * @param {{ reply?: (entry: number, args: number[]) => any }} [options]
 */
function setup({ reply } = {}){
    /** @type {Map<number, any>} */
    const handles = new Map();
    let next = 0x100;
    /** @type {{ entry: number, args: number[], thread: unknown }[]} */
    const called = [];
    /** @type {number[]} */
    const errors = [];
    /** Work waiting for a thread's next look at its messages. @type {{ thread: number, run: (thread: unknown) => any }[]} */
    const waiting = [];
    const caller = { current: /** @type {unknown} */ (MAIN) };
    const { table, notify } = createWinEventHooks({
        handles: {
            open: (_type, object)=>{
                handles.set(next, object);
                return (next += 4) - 4;
            },
            close: handle=>handles.delete(handle),
        },
        call: (entry, args, thread)=>{
            called.push({ entry, args, thread });
            return reply ? reply(entry, args) : 0;
        },
        callerThread: ()=>caller.current,
        setLastError: code=>{
            errors.push(code);
        },
        threadExists: id=>id === MAIN.id || id === WORKER.id,
        processId: PROCESS,
        now: ()=>1234.75,
    }, {
        windowThread: hwnd=>(hwnd === HWND ? MAIN.id : null),
        later: (thread, run)=>{
            waiting.push({ thread, run });
        },
    });
    return { table, notify, called, errors, waiting, caller, handles };
}

test('SetWinEventHook refuses what Windows refuses, each with its reason', ()=>{
    const { table, errors } = setup();
    assert.equal(table.SetWinEventHook.argBytes, 28);
    const hook = (/** @type {number[]} */ ...args)=>table.SetWinEventHook.handler(args);

    assert.equal(hook(EVENT_MIN, EVENT_MAX, 0, PROC, PROCESS, 0, WINEVENT_INCONTEXT), 0,
        'an in-context hook names its module, even one for this process');
    assert.equal(hook(EVENT_MIN, EVENT_MAX, 0, PROC, PROCESS, MAIN.id, WINEVENT_INCONTEXT), 0,
        'and even one for this thread');
    assert.equal(hook(1, 0, 0, PROC, PROCESS, 0, WINEVENT_OUTOFCONTEXT), 0);
    assert.equal(hook(-1, 1, 0, PROC, PROCESS, 0, WINEVENT_OUTOFCONTEXT), 0,
        'the range is unsigned: 0xffffffff is above 1');
    assert.equal(hook(EVENT_MIN, EVENT_MAX, 0, 0, PROCESS, 0, WINEVENT_OUTOFCONTEXT), 0);
    assert.equal(hook(EVENT_MIN, EVENT_MAX, 0, PROC, 0, 0xdeadbeef, WINEVENT_OUTOFCONTEXT), 0);
    assert.deepEqual(errors, [ERROR_HOOK_NEEDS_HMOD, ERROR_HOOK_NEEDS_HMOD,
        ERROR_INVALID_HOOK_FILTER, ERROR_INVALID_HOOK_FILTER, ERROR_INVALID_FILTER_PROC,
        ERROR_INVALID_THREAD_ID]);
});

test('SetWinEventHook takes an empty range and a process that does not exist, error untouched',
    ()=>{
        const { table, errors } = setup();
        const zero = table.SetWinEventHook.handler([0, 0, 0, PROC, PROCESS, 0, 0]);
        assert.notEqual(zero, 0);
        assert.equal(table.UnhookWinEvent.handler([zero]), 1);
        const stranger = table.SetWinEventHook.handler([EVENT_MIN, EVENT_MAX, 0, PROC,
            0xdeadbeef, 0, 0]);
        assert.notEqual(stranger, 0);
        assert.equal(table.UnhookWinEvent.handler([stranger]), 1);
        assert.deepEqual(errors, []);
    });

test('UnhookWinEvent takes a hook off once; a handle that is no hook is ERROR_INVALID_HANDLE', ()=>{
    const { table, errors, handles } = setup();
    assert.equal(table.UnhookWinEvent.argBytes, 4);
    const hook = table.SetWinEventHook.handler([EVENT_MIN, EVENT_MAX, MODULE, PROC, 0,
        MAIN.id, WINEVENT_INCONTEXT]);
    assert.equal(handles.size, 1);
    assert.equal(table.IsWinEventHookInstalled.handler([EVENT_OBJECT_CREATE]), 1);
    assert.equal(table.UnhookWinEvent.handler([hook]), 1);
    assert.equal(handles.size, 0, 'its handle is closed');
    assert.equal(table.IsWinEventHookInstalled.handler([EVENT_OBJECT_CREATE]), 0);
    assert.equal(table.UnhookWinEvent.handler([hook]), 0);
    assert.equal(table.UnhookWinEvent.handler([0xdeadbeef]), 0);
    assert.deepEqual(errors, [ERROR_INVALID_HANDLE, ERROR_INVALID_HANDLE]);
});

test('an in-context hook is called before NotifyWinEvent returns, with the seven arguments', ()=>{
    // comctl32's tests record an updown's EVENT_OBJECT_VALUECHANGE from a
    // hook like this one and compare it with the messages around it, so it
    // must arrive in order, synchronously.
    const { table, called } = setup();
    assert.equal(table.NotifyWinEvent.argBytes, 16);
    const hook = table.SetWinEventHook.handler([EVENT_MIN, EVENT_MAX, MODULE, PROC, 0,
        MAIN.id, WINEVENT_INCONTEXT]);
    assert.equal(table.NotifyWinEvent.handler([EVENT_OBJECT_VALUECHANGE, HWND, OBJID_CLIENT,
        CHILDID_SELF]), 0);
    assert.deepEqual(called, [{ entry: PROC, thread: MAIN,
        args: [hook, EVENT_OBJECT_VALUECHANGE, HWND, OBJID_CLIENT >>> 0, CHILDID_SELF, MAIN.id,
            1234] }]);
});

test('a hook hears only the events in its range', ()=>{
    // Wine's event filtering test: SHOW..LOCATIONCHANGE hears SHOW, not
    // CREATE below it nor NAMECHANGE above.
    const { table, called } = setup();
    table.SetWinEventHook.handler([EVENT_OBJECT_SHOW, EVENT_OBJECT_LOCATIONCHANGE, MODULE, PROC,
        PROCESS, 0, WINEVENT_INCONTEXT]);
    for (const event of [EVENT_OBJECT_CREATE, EVENT_OBJECT_SHOW, EVENT_OBJECT_NAMECHANGE])
    {
        table.NotifyWinEvent.handler([event, HWND, OBJID_CARET, 0]);
    }
    assert.deepEqual(called.map(c=>c.args[1]), [EVENT_OBJECT_SHOW]);
    assert.equal(table.IsWinEventHookInstalled.handler([EVENT_OBJECT_CREATE]), 0);
    assert.equal(table.IsWinEventHookInstalled.handler([EVENT_OBJECT_LOCATIONCHANGE]), 1);
});

test('the thread an event comes from is the window\'s, and a thread filter is held to it', ()=>{
    // Windows reports an event about a window from the thread that owns the
    // window, whoever raises it; the hook still runs on the raising thread.
    const { table, called, caller } = setup();
    table.SetWinEventHook.handler([EVENT_MIN, EVENT_MAX, MODULE, PROC, 0, MAIN.id,
        WINEVENT_INCONTEXT]);
    table.SetWinEventHook.handler([EVENT_MIN, EVENT_MAX, MODULE, OTHER_PROC, 0, WORKER.id,
        WINEVENT_INCONTEXT]);
    caller.current = WORKER;
    table.NotifyWinEvent.handler([EVENT_MIN, HWND, 1, 1]);
    assert.deepEqual(called.map(c=>[c.entry, c.args[5], c.thread]), [[PROC, MAIN.id, WORKER]]);
    called.length = 0;
    table.NotifyWinEvent.handler([EVENT_MIN, 0, 1, 1]);
    assert.deepEqual(called.map(c=>[c.entry, c.args[5]]), [[OTHER_PROC, WORKER.id]],
        'about no window, it comes from the thread that raised it');
});

test('hooks are called oldest first, one after the other, and one taken off midway is not called',
    async()=>{
        /** @type {(() => void)[]} */
        const waiting = [];
        let unhook = 0;
        const { table, called } = setup({
            reply: entry=>(entry === PROC ? new Promise(resolve=>{
                waiting.push(()=>{
                    table.UnhookWinEvent.handler([unhook]);
                    resolve(0);
                });
            }) : 0),
        });
        table.SetWinEventHook.handler([EVENT_MIN, EVENT_MAX, MODULE, PROC, 0, 0,
            WINEVENT_INCONTEXT]);
        unhook = table.SetWinEventHook.handler([EVENT_MIN, EVENT_MAX, MODULE, OTHER_PROC, 0, 0,
            WINEVENT_INCONTEXT]);
        const done = table.NotifyWinEvent.handler([EVENT_OBJECT_CREATE, HWND, OBJID_CLIENT, 0]);
        assert.equal(called.length, 1, 'the second waits for the first to return');
        waiting[0]();
        assert.equal(await done, 0);
        assert.deepEqual(called.map(c=>c.entry), [PROC]);
    });

test('an out-of-context hook hears an event at its thread\'s next look at its queue, even its own',
    ()=>{
        // Wine's out-of-context test: after the main thread's own three
        // NotifyWinEvent calls the in-context hook has heard them and the
        // out-of-context one has not; a PeekMessage later, it has.
        const { table, called, caller, waiting } = setup();
        const outside = table.SetWinEventHook.handler([EVENT_MIN, EVENT_MAX, 0, OTHER_PROC,
            PROCESS, 0, WINEVENT_OUTOFCONTEXT]);
        table.SetWinEventHook.handler([EVENT_MIN, EVENT_MAX, MODULE, PROC, PROCESS, 0,
            WINEVENT_INCONTEXT]);
        for (const event of [EVENT_OBJECT_CREATE, EVENT_OBJECT_SHOW, EVENT_OBJECT_NAMECHANGE])
        {
            table.NotifyWinEvent.handler([event, HWND, OBJID_CARET, 0]);
        }
        assert.deepEqual(called.map(c=>[c.entry, c.args[1]]), [[PROC, EVENT_OBJECT_CREATE],
            [PROC, EVENT_OBJECT_SHOW], [PROC, EVENT_OBJECT_NAMECHANGE]]);
        assert.deepEqual(waiting.map(w=>w.thread), [MAIN.id, MAIN.id, MAIN.id]);
        called.length = 0;
        for (const { run } of waiting.splice(0, 1))
        {
            run(MAIN);
        }
        assert.deepEqual(called, [{ entry: OTHER_PROC, thread: MAIN, args: [outside,
            EVENT_OBJECT_CREATE, HWND, OBJID_CARET >>> 0, 0, MAIN.id, 1234] }]);

        // Raised on another thread, it is still the installer's thread that runs it.
        caller.current = WORKER;
        table.NotifyWinEvent.handler([EVENT_OBJECT_SHOW, 0, OBJID_CARET, 0]);
        assert.equal(waiting.at(-1)?.thread, MAIN.id);
        assert.equal(called.at(-1)?.thread, WORKER, 'the in-context one ran on the raiser');
        assert.equal(called.at(-1)?.args[5], WORKER.id);

        // Taken off before its thread looked, it hears nothing more.
        assert.equal(table.UnhookWinEvent.handler([outside]), 1);
        called.length = 0;
        for (const { run } of waiting.splice(0))
        {
            assert.equal(run(MAIN), 0);
        }
        assert.equal(called.length, 0);
    });

test('WINEVENT_SKIPOWNTHREAD skips the installer\'s thread, SKIPOWNPROCESS its process', ()=>{
    const { table, called, caller } = setup();
    table.SetWinEventHook.handler([EVENT_MIN, EVENT_MAX, MODULE, PROC, 0, 0,
        WINEVENT_INCONTEXT | WINEVENT_SKIPOWNTHREAD]);
    table.SetWinEventHook.handler([EVENT_MIN, EVENT_MAX, MODULE, OTHER_PROC, 0, 0,
        WINEVENT_INCONTEXT | WINEVENT_SKIPOWNPROCESS]);
    table.NotifyWinEvent.handler([EVENT_OBJECT_SHOW, 0, OBJID_CLIENT, 0]);
    assert.equal(called.length, 0);
    caller.current = WORKER;
    table.NotifyWinEvent.handler([EVENT_OBJECT_SHOW, 0, OBJID_CLIENT, 0]);
    assert.deepEqual(called.map(c=>c.entry), [PROC]);
});

test('a hook for another process hears nothing of this one', ()=>{
    const { table, called } = setup();
    table.SetWinEventHook.handler([EVENT_MIN, EVENT_MAX, 0, PROC, PROCESS + 4, 0, 0]);
    table.NotifyWinEvent.handler([EVENT_OBJECT_SHOW, HWND, OBJID_CLIENT, 0]);
    assert.equal(called.length, 0);
});
