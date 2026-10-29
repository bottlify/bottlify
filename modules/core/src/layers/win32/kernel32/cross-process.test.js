/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveCall, takeAnswer, askChild, after, childThread, isChildThread, threadArg,
    threadEnd }
    from './cross-process.js';

/**
 * A child's kernel32 over a small memory: calls recorded, a last error kept,
 * and whatever each test puts in `calls` answering.
 *
 * @param {Record<string, (args: number[], self: any) => any>} calls
 */
function childOf(calls){
    const memory = new Uint8Array(0x1000);
    let next = 0x800;
    const child = {
        memory,
        error: 0,
        /** @type {{ name: string, args: number[] }[]} */
        made: [],
        /** @type {number[]} */
        freed: [],
        /** @type {number[]} */
        closed: [],
    };
    /** @type {Record<string, { handler: Function }>} */
    const table = {
        GetLastError: { handler: ()=>child.error },
        SetLastError: { handler: (/** @type {number[]} */ [code])=>{
            child.error = code;
        } },
        OpenThread: { handler: (/** @type {number[]} */ [, , id])=>(id === 0x2c ? 0x80 : 0) },
        CloseHandle: { handler: (/** @type {number[]} */ [handle])=>child.closed.push(handle) },
    };
    for (const [name, answer] of Object.entries(calls))
    {
        table[name] = { handler: (/** @type {number[]} */ args)=>{
            child.made.push({ name, args });
            return answer(args, child);
        } };
    }
    const host = {
        table,
        allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += bytes;
            return at;
        },
        free: (/** @type {number} */ at)=>child.freed.push(at),
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            memory.slice(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
            memory.set(bytes, at),
    };
    return { child, host };
}

test('a call is made in the child over its own buffers, and its writes come back', ()=>{
    // WriteProcessMemory's source and ReadProcessMemory's destination are the
    // parent's: the child sees copies of its own, and only bytes go back.
    const { child, host } = childOf({
        ReadProcessMemory: ([, base, into, count, read], self)=>{
            self.memory.set([1, 2, 3].slice(0, count), into);
            new DataView(self.memory.buffer).setUint32(read, count, true);
            void base;
            return 1;
        },
    });
    const answer = serveCall({ call: 'ReadProcessMemory',
        args: [0xffffffff, 0x4000, { out: 3 }, 3, { out: 4 }] }, host);
    assert.equal(answer.result, 1);
    assert.equal(answer.error, null, 'a call that set no error says so');
    assert.deepEqual([...answer.outs[2] ?? []], [1, 2, 3]);
    assert.deepEqual([...answer.outs[4] ?? []], [3, 0, 0, 0]);
    assert.deepEqual([answer.outs[0], answer.outs[1], answer.outs[3]], [null, null, null]);
    assert.deepEqual(child.freed, [0x800], 'the scratch is given back');
});

test('a served call leaves the child\'s own last error as it was, and reports its own', ()=>{
    // It runs between the child's turns: the thread that ran last keeps the
    // error its program set.
    const { child, host } = childOf({
        VirtualFree: (_args, self)=>{
            self.error = 487;
            return 0;
        },
    });
    child.error = 5;
    const answer = serveCall({ call: 'VirtualFree', args: [0x10, 0, 0x8000] }, host);
    assert.deepEqual([answer.result, answer.error], [0, 487]);
    assert.equal(child.error, 5);
});

test('a thread named by id is opened for the call and closed after', ()=>{
    const { child, host } = childOf({ ResumeThread: ()=>1 });
    assert.equal(serveCall({ call: 'ResumeThread', args: [{ thread: 0x2c }] }, host).result, 1);
    assert.deepEqual(child.made, [{ name: 'ResumeThread', args: [0x80] }]);
    assert.deepEqual(child.closed, [0x80]);

    const none = serveCall({ call: 'ResumeThread', args: [{ thread: 0x30 }] }, host);
    assert.deepEqual([none.result, none.error], [0, 87], 'a thread it has not');
});

test('only the cross-process calls are made, and none that would block', ()=>{
    const { host } = childOf({ ExitProcess: ()=>0, SuspendThread: ()=>({ parked: true }) });
    assert.equal(serveCall({ call: 'ExitProcess', args: [0] }, host).error, 50);
    assert.equal(serveCall({ call: 'SuspendThread', args: [{ thread: 0x2c }] }, host).error, 50);
});

test('the parent writes the answer where its call asked, and sets the error it carried', ()=>{
    const memory = new Uint8Array(0x100);
    /** @type {number[]} */
    const errors = [];
    const parent = { writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
        memory.set(bytes, at), setLastError: (/** @type {number} */ code)=>errors.push(code) };
    assert.equal(takeAnswer({ result: 1, error: null, outs: [null, new Uint8Array([9, 8])] },
        [null, 0x10], parent), 1);
    assert.deepEqual([...memory.slice(0x10, 0x12)], [9, 8]);
    assert.deepEqual(errors, [], 'no error set where the child set none');
    takeAnswer({ result: 0, error: 299, outs: [new Uint8Array([7])] }, [0], parent);
    assert.deepEqual(errors, [299]);
    assert.equal(memory[0], 0, 'and nothing written to a NULL the call was handed');
});

test('an answer later sets the error of the thread that asked, whichever runs then', async()=>{
    const caller = { id: 1 };
    let running = /** @type {any} */ (caller);
    /** @type {any[]} */
    const set = [];
    const host = {
        askChild: ()=>Promise.resolve().then(()=>{
            running = { id: 2 };
            return { result: 0, error: 6, outs: [] };
        }),
        writeMemory: ()=>{},
        currentThread: ()=>running,
        setLastErrorFor: (/** @type {any} */ thread, /** @type {number} */ code)=>
            set.push([thread, code]),
    };
    assert.equal(await askChild(host, {}, { call: 'VirtualFree', args: [] }, []), 0);
    assert.deepEqual(set, [[caller, 6]]);

    // A child the run cannot ask is no promise at all, and one gone meanwhile
    // answers ERROR_ACCESS_DENIED.
    assert.equal(askChild({ ...host, askChild: ()=>null }, {}, { call: 'x', args: [] }, []), null);
    set.length = 0;
    assert.equal(await askChild({ ...host, askChild: ()=>Promise.resolve(null) }, {},
        { call: 'VirtualFree', args: [] }, []), 0);
    assert.deepEqual(set.map(([, code])=>code), [5]);
});

test('after makes the same of a result now and one later', async()=>{
    assert.equal(after(2, value=>value + 1), 3);
    assert.equal(await after(Promise.resolve(2), value=>value + 1), 3);
});

test('a child\'s thread is one object whichever handle names it, asked for by handle or id', ()=>{
    const record = { exitCode: 259 };
    const first = childThread(record, 0x2c);
    assert.equal(childThread(record, 0x2c), first);
    assert.deepEqual(threadArg(first), { thread: 0x2c }, 'the first thread, by its id');
    assert.equal(threadArg(childThread(record, 0x30, 0x84)), 0x84,
        'one the parent made, by the child\'s own handle to it');
});

test('a wait on a child\'s thread ends once the child says it has, with its code', async()=>{
    /** @type {any[]} */
    const set = [];
    const kernel = {
        createEvent: (/** @type {any} */ options)=>({ ...options }),
        setEvent: (/** @type {any} */ event)=>set.push(event),
    };
    let asks = 0;
    /** @type {(() => void)[]} */
    const later = [];
    const host = {
        kernel,
        later: (/** @type {() => void} */ look)=>later.push(look),
        askChild: ()=>{
            asks++;
            const code = asks < 3 ? 259 : 42;
            return Promise.resolve({ result: 1, error: null,
                outs: [null, new Uint8Array([code, code >> 8, 0, 0])] });
        },
    };
    const thread = childThread({ exitCode: 259 }, 0x30, 0x84);
    const event = threadEnd(host, thread);
    assert.equal(threadEnd(host, thread), event, 'one event, however many wait');
    for (let round = 0; round < 3; round++)
    {
        await new Promise(resolve=>setImmediate(resolve));
        later.shift()?.();
    }
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(asks, 3, 'asked again while it still ran');
    assert.deepEqual(set, [event]);
    assert.equal(thread.exitCode, 42);

    // A child gone, or one that has the thread no more, has ended it.
    const gone = childThread({ exitCode: 7, completed: true }, 0x2c);
    threadEnd({ kernel, askChild: ()=>null }, gone);
    assert.equal(gone.exitCode, 7);
    const refused = childThread({ exitCode: 259 }, 0x2c);
    threadEnd({ kernel, askChild: ()=>Promise.resolve({ result: 0, error: 87, outs: [] }) },
        refused);
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(refused.exitCode, 0);
});

test('a child\'s thread is told from what any other handle names without a throw', ()=>{
    assert.equal(isChildThread(childThread({}, 0x2c)), true);
    assert.equal(isChildThread({ process: {}, threadId: 0x2c, handle: 0, exitCode: null,
        exited: null }), false, 'the shape alone is not a child\'s thread');
    assert.equal(isChildThread(null), false);
    assert.equal(isChildThread(undefined), false);
});
