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
]);

/**
 * @typedef {Object} ServeHost
 * @property {Record<string, { handler?: Function }>} table  The child's kernel32.
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
 * @returns {Promise<number> | null}
 */
export function askChild(host, record, call, into){
    const asked = host.askChild?.(record, call) ?? null;
    if (asked === null)
    {
        return null;
    }
    const thread = host.currentThread();
    return asked.then(answer=>takeAnswer(answer ?? { result: 0, error: ERROR_ACCESS_DENIED,
        outs: [] }, into, {
        writeMemory: host.writeMemory,
        setLastError: code=>host.setLastErrorFor(thread, code),
    }));
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
