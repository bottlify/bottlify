/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A call made in another process: what a parent's VirtualAllocEx,
 * ReadProcessMemory or SuspendThread on its child becomes. The parent sends
 * the call by name with its arguments as values; the child makes it with its
 * own kernel32 handlers, over memory of its own, and answers the result, the
 * last error and the bytes the call wrote. So the answer is the one that
 * process would give itself, and only bytes cross, never a pointer: the child
 * may be on this thread or in a worker of its own.
 */

/**
 * An argument: a number as it is, or a buffer the child provides --
 * `{ in }` bytes the call reads, `{ out }` that many bytes it writes,
 * `{ inout }` both -- or `{ thread }`, a handle the child opens to its thread
 * of that id for the call.
 *
 * @typedef {number | { in: Uint8Array } | { out: number } | { inout: Uint8Array }
 *     | { thread: number }} CrossArg
 */

/** @typedef {{ call: string, args: CrossArg[] }} CrossCall */

/**
 * What came back: the call's result, the last error it set -- null where it
 * set none, as a call that succeeds mostly does, and the caller's stays -- and
 * for each argument the bytes it wrote there (null for one that is no buffer).
 *
 * @typedef {{ result: number, error: number | null, outs: (Uint8Array | null)[] }} CrossAnswer
 */

/** What a call that cannot be made in the child answers. */
const ERROR_NOT_SUPPORTED = 50;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOT_ENOUGH_MEMORY = 8;
/** THREAD_ALL_ACCESS, for the handle a `{ thread }` argument is opened with. */
const THREAD_ALL_ACCESS = 0x1fffff;
/**
 * The last error a served call starts with: still there after it, the call
 * set none. Not a code Windows defines, so no call sets it.
 */
const UNTOUCHED = 0x7fffbeef;

/**
 * The calls a parent may make in its child. Anything else is refused: the
 * list is what the cross-process forms of kernel32 and ntdll are made of.
 */
export const CROSS_CALLS = new Set([
    'VirtualAlloc', 'VirtualFree', 'VirtualProtect', 'VirtualQuery',
    'ReadProcessMemory', 'WriteProcessMemory',
    'SuspendThread', 'ResumeThread', 'GetThreadContext', 'SetThreadContext',
    'CreateThread', 'GetExitCodeThread', 'NtQueryInformationProcess',
]);

/**
 * @typedef {Object} ServeHost
 * @property {Record<string, { handler?: Function }>} table  The child's kernel32, and
 *           the ntdll calls of CROSS_CALLS.
 * @property {(bytes: number) => number} allocate  Scratch in the child's memory; 0 for none.
 * @property {(address: number) => void} free
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * Makes a parent's call in this process, between its threads' turns: the
 * buffers in scratch of its own, a handle to a thread named by id opened for
 * the call and closed after, and the last error of whichever thread ran last
 * left as it was.
 *
 * @param {CrossCall} request
 * @param {ServeHost} host
 * @returns {CrossAnswer}
 */
export function serveCall(request, host){
    const entry = CROSS_CALLS.has(request.call) ? host.table[request.call] : undefined;
    /** @type {(Uint8Array | null)[]} */
    const outs = request.args.map(()=>null);
    if (!entry?.handler)
    {
        return { result: 0, error: ERROR_NOT_SUPPORTED, outs };
    }
    /** @param {CrossArg} arg @returns {number} */
    const size = arg=>(typeof arg === 'number' || 'thread' in arg ? 0
        : 'out' in arg ? arg.out >>> 0 : ('in' in arg ? arg.in : arg.inout).length);
    const total = request.args.reduce(
        (/** @type {number} */ sum, arg)=>sum + ((size(arg) + 3) & ~3), 0);
    const scratch = total === 0 ? 0 : host.allocate(total);
    if (total !== 0 && scratch === 0)
    {
        return { result: 0, error: ERROR_NOT_ENOUGH_MEMORY, outs };
    }
    const table = host.table;
    // Every name called here is kernel32's own, which the child always has.
    const call = (/** @type {string} */ name, /** @type {number[]} */ args)=>
        /** @type {Function} */ (table[name].handler)(args);
    const saved = call('GetLastError', []) >>> 0;
    /** @type {number[]} */
    const opened = [];
    try
    {
        let at = scratch;
        /** @type {number[]} */
        const values = [];
        /** @type {(number | null)[]} */
        const places = [];
        for (const arg of request.args)
        {
            if (typeof arg === 'number')
            {
                values.push(arg >>> 0);
                places.push(null);
                continue;
            }
            if ('thread' in arg)
            {
                const handle = call('OpenThread', [THREAD_ALL_ACCESS, 0, arg.thread >>> 0]) >>> 0;
                if (handle === 0)
                {
                    return { result: 0, error: ERROR_INVALID_PARAMETER, outs };
                }
                opened.push(handle);
                values.push(handle);
                places.push(null);
                continue;
            }
            const bytes = 'out' in arg ? new Uint8Array(arg.out >>> 0)
                : 'in' in arg ? arg.in : arg.inout;
            host.writeMemory(at, bytes);
            values.push(at);
            places.push('in' in arg ? null : at);
            at += (bytes.length + 3) & ~3;
        }
        call('SetLastError', [UNTOUCHED]);
        const result = call(request.call, values);
        if (typeof result !== 'number')
        {
            // A call that would block or answer later: not one made here.
            return { result: 0, error: ERROR_NOT_SUPPORTED, outs };
        }
        const left = call('GetLastError', []) >>> 0;
        const error = left === UNTOUCHED ? null : left;
        request.args.forEach((arg, index)=>{
            const place = places[index];
            if (place !== null)
            {
                outs[index] = host.readMemory(place, size(arg)).slice();
            }
        });
        return { result: result >>> 0, error, outs };
    }
    finally
    {
        for (const handle of opened)
        {
            call('CloseHandle', [handle]);
        }
        call('SetLastError', [saved]);
        if (scratch !== 0)
        {
            host.free(scratch);
        }
    }
}

/**
 * The parent's half: an answer written back into the parent's own buffers,
 * the arguments that were buffers given in the order the call named them,
 * and the last error set; the result answered.
 *
 * @param {CrossAnswer} answer
 * @param {(number | null)[]} into  The parent's address for each argument's
 *        bytes, null where none goes back.
 * @param {{ writeMemory: (address: number, bytes: Uint8Array) => void,
 *     setLastError: (code: number) => void }} host
 */
export function takeAnswer(answer, into, host){
    answer.outs.forEach((bytes, index)=>{
        const address = into[index];
        if (bytes && address !== null && address !== undefined && address !== 0)
        {
            host.writeMemory(address >>> 0, bytes);
        }
    });
    if (answer.error !== null)
    {
        host.setLastError(answer.error >>> 0);
    }
    return answer.result >>> 0;
}

/** What a call answers when the child it names is not one the run has. */
const ERROR_ACCESS_DENIED = 5;

/**
 * @typedef {Object} AskHost
 * @property {(record: any, call: CrossCall) => Promise<CrossAnswer | null> | null} [askChild]
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => any} currentThread
 * @property {(thread: any, code: number) => void} setLastErrorFor
 */

/**
 * Makes a call in a child and answers it to the calling thread when the
 * child has: its buffers written where `into` says, the last error set on
 * that thread -- which may not be the one running by then -- and the result
 * the promise's. Null where the child cannot be asked: no run to ask, or a
 * child the run does not have.
 *
 * @param {AskHost} host @param {any} record  The child's process record.
 * @param {CrossCall} call @param {(number | null)[]} into
 * @param {(answer: CrossAnswer, result: number) => number} [adopt]  What the
 *        call answers in this process, made of the child's answer: a handle of
 *        its own for one the child made.
 * @returns {Promise<number> | null}
 */
export function askChild(host, record, call, into, adopt){
    const asked = host.askChild?.(record, call) ?? null;
    if (asked === null)
    {
        return null;
    }
    const thread = host.currentThread();
    return asked.then(given=>{
        const answer = given ?? { result: 0, error: ERROR_ACCESS_DENIED, outs: [] };
        const result = takeAnswer(answer, into, {
            writeMemory: host.writeMemory,
            setLastError: code=>host.setLastErrorFor(thread, code),
        });
        return adopt ? adopt(answer, result) >>> 0 : result;
    });
}

/** What GetExitCodeThread answers for a thread still running. */
const STILL_ACTIVE = 259;
/** How long a parent waiting on a thread of its child leaves between its questions. */
const THREAD_LOOK_MS = 2;

/**
 * A thread of a child, as its parent's handles name it: one object per
 * thread, whichever handle names it, so every wait on it and every exit code
 * read of it share its end.
 *
 * @typedef {{ process: any, threadId: number, handle: number, exitCode: number | null,
 *     exited: any }} ChildThread
 */

/**
 * The child's thread of that id. `handle` is the child's own handle to it,
 * kept open where the parent made the thread (CreateRemoteThread), so the
 * thread's exit code outlives it as it does on Windows while a handle stands;
 * zero where the child is asked for it by id.
 *
 * @param {any} record  The child's process record.
 * @param {number} threadId @param {number} [handle]
 * @returns {ChildThread}
 */
export function childThread(record, threadId, handle = 0){
    /** @type {Map<number, ChildThread>} */
    const threads = record.threads ??= new Map();
    let thread = threads.get(threadId >>> 0);
    if (!thread)
    {
        thread = { process: record, threadId: threadId >>> 0, handle: handle >>> 0,
            exitCode: null, exited: null };
        threads.set(thread.threadId, thread);
    }
    return thread;
}

/**
 * How a call names a child's thread: by the child's own handle to it, or by
 * its id, opened for the call.
 *
 * @param {ChildThread} thread @returns {CrossArg}
 */
export const threadArg = thread=>(thread.handle !== 0 ? thread.handle
    : { thread: thread.threadId });

/**
 * @typedef {Object} ThreadEndHost
 * @property {{ createEvent: (options: any) => any, setEvent: (event: any) => void }} kernel
 * @property {AskHost['askChild']} [askChild]
 * @property {(look: () => void, ms: number) => void} [later]
 */

/**
 * The event a child's thread ends: what a wait on it waits on. Nothing of
 * the child's reaches this process as its thread ends, so the parent asks
 * the child, between its turns, until the thread has an exit code; a child
 * gone, or one the run cannot ask, has ended all its threads, its first with
 * the process's code.
 *
 * @param {ThreadEndHost} host @param {ChildThread} thread
 */
export function threadEnd(host, thread){
    if (thread.exited)
    {
        return thread.exited;
    }
    const event = host.kernel.createEvent({ manualReset: true, signalled: false });
    thread.exited = event;
    /** @param {number} code */
    const end = code=>{
        thread.exitCode = code >>> 0;
        host.kernel.setEvent(event);
    };
    const record = thread.process;
    const gone = ()=>end(record.exitCode === STILL_ACTIVE ? 0 : record.exitCode ?? 0);
    const look = ()=>{
        if (record.completed)
        {
            gone();
            return;
        }
        const asked = host.askChild?.(record, { call: 'GetExitCodeThread',
            args: [threadArg(thread), { out: 4 }] }) ?? null;
        if (asked === null)
        {
            gone();
            return;
        }
        asked.then(answer=>{
            const bytes = answer?.outs[1];
            const code = answer?.result && bytes
                ? new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) : null;
            if (!answer || !answer.result)
            {
                // Refused: the child has no such thread now, which is a thread
                // that has gone.
                gone();
            }
            else if (code !== STILL_ACTIVE)
            {
                end(code ?? 0);
            }
            else
            {
                (host.later ?? setTimeout)(look, THREAD_LOOK_MS);
            }
        }, gone);
    };
    look();
    return event;
}

/**
 * A result now or later, and what is made of it then.
 *
 * @template T
 * @param {number | Promise<number>} result @param {(value: number) => T} then
 * @returns {T | Promise<T>}
 */
export const after = (result, then)=>(typeof result === 'number' ? then(result)
    : result.then(then));
