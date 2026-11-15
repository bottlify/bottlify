/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The runtimes' invalid-parameter handler: what a function of the 2005
 * runtime or of the universal one does with an argument it refuses
 * (decisions.md A255).
 *
 * Those runtimes validate an argument, set errno to EINVAL and call the
 * invalid-parameter handler; a program that installed one (often empty) goes
 * on to read the function's documented failure, and with none installed the
 * runtime ends the process through `_invoke_watson` with
 * STATUS_INVALID_CRUNTIME_PARAMETER. msvcrt.dll keeps no handler and only
 * answers EINVAL.
 *
 * The functions themselves are msvcrt.dll's, shared by every runtime the
 * engine serves, and each refuses an argument the one way it can: errno is
 * EINVAL. So the handler is reached where every one of them goes - the errno
 * the runtime sets (`note`) - while a call that came through a runtime with
 * a handler is under way (`within`, which each such runtime wraps its exports
 * in). A call into msvcrt.dll's own export is not watched, and answers EINVAL
 * alone, as there.
 *
 * Ending the process is loud: an error in the journal with the function and
 * its arguments. A parameter Windows lets through and ours refuses is a
 * defect of the check, and must show at once rather than end a game quietly.
 */

import { EINVAL } from './globals.js';

/** STATUS_INVALID_CRUNTIME_PARAMETER: how `_invoke_watson` ends the process. */
export const INVALID_CRUNTIME_PARAMETER = 0xc0000417;

/**
 * Where errno is set and which runtime's call is under way: one per process,
 * in msvcrt.dll's table under `INVALID_PARAMETERS`.
 *
 * @typedef {Object} InvalidParameterWatch
 * @property {(code: number) => void} note  An errno the runtime set.
 * @property {(runtime: InvalidParameterRuntime, name: string, run: Function)
 *     => (args: number[]) => any} within
 *     `run` as a call through `runtime`'s export `name`: an EINVAL it sets
 *     reaches that runtime's handler before the answer is returned.
 */

/**
 * One runtime's handler, as `_set_invalid_parameter_handler` keeps it.
 *
 * @typedef {Object} InvalidParameterRuntime
 * @property {string} library
 * @property {(handler: number) => number} set  The one before.
 * @property {() => number} get
 * @property {((handler: number) => number) | undefined} setThread
 *     The calling thread's own, the universal runtime's alone.
 * @property {(() => number) | undefined} getThread
 * @property {(name: string, args: number[], answer: any, details?: number[]) => any} raise
 *     The handler with the details (zeros as a release runtime gives them),
 *     then `answer`; with none, the process ends.
 */

/** The symbol msvcrt.dll's table carries the watch under. */
export const INVALID_PARAMETERS = Symbol('invalid parameters');

/** @returns {InvalidParameterWatch} */
export function createInvalidParameterWatch(){
    /** @type {{ pending: boolean } | null} */
    let current = null;
    return {
        note: code=>{
            if (code === EINVAL && current)
            {
                current.pending = true;
            }
        },
        within: (runtime, name, run)=>args=>{
            // A runtime's function calling another export inside it is still
            // the call the program made: the outermost export answers for it.
            if (current)
            {
                return run(args);
            }
            const outer = current;
            const call = { pending: false };
            current = call;
            let answer;
            try
            {
                answer = run(args);
            }
            finally
            {
                current = outer;
            }
            return call.pending ? runtime.raise(name, args, answer) : answer;
        },
    };
}

/**
 * @typedef {Object} RuntimeHost
 * @property {string} library
 * @property {boolean} [threadLocal]  `_set_thread_local_invalid_parameter_handler`
 *     is there: the universal runtime's.
 * @property {((entry: number, args: number[], thread?: unknown) => any) | undefined} callGuest
 * @property {() => unknown} [currentThread]
 * @property {((code: number) => any) | undefined} exitProcess
 * @property {((api: string, detail: string, kind?: 'loss') => void) | undefined} report
 */

/**
 * @param {RuntimeHost} host
 * @returns {InvalidParameterRuntime}
 */
export function createInvalidParameterRuntime(host){
    let global = 0;
    /** @type {WeakMap<object, number>} */
    const perThread = new WeakMap();
    /** Who is calling where there is no thread to ask: the one thread there is. */
    const alone = {};
    /** The calling thread, as a key. @returns {object} */
    const thread = ()=>{
        const one = host.currentThread?.();
        return one !== null && typeof one === 'object' ? one : alone;
    };
    const own = ()=>perThread.get(thread()) ?? 0;
    /** @param {number[]} args */
    const shown = args=>args.map(value=>`0x${(value >>> 0).toString(16)}`).join(', ');
    return {
        library: host.library,
        set: handler=>{
            const before = global;
            global = handler >>> 0;
            return before;
        },
        get: ()=>global,
        setThread: host.threadLocal ? handler=>{
            const before = own();
            perThread.set(thread(), handler >>> 0);
            return before;
        } : undefined,
        getThread: host.threadLocal ? own : undefined,
        raise: (name, args, answer, details = [0, 0, 0, 0, 0])=>{
            // The thread's own handler is asked before the process's, as the
            // universal runtime asks them.
            const handler = own() || global;
            // The thread that refused calls the handler, even when the
            // function's answer came after an await.
            const caller = host.currentThread?.();
            if (handler !== 0 && host.callGuest)
            {
                return Promise.resolve(answer)
                    .then(value=>Promise.resolve(host.callGuest?.(handler, details, caller))
                        .then(()=>value));
            }
            host.report?.(host.library, `${name}(${shown(args)}): an invalid parameter and no `
                + 'handler set - the process ends as _invoke_watson ends it (0xC0000417)', 'loss');
            if (!host.exitProcess)
            {
                return answer;
            }
            const end = ()=>host.exitProcess?.(INVALID_CRUNTIME_PARAMETER);
            return typeof answer?.then === 'function' ? answer.then(end) : end();
        },
    };
}

/**
 * What a wrapped export was made from: a runtime over another wraps the
 * original, and a sweep over every library meets the same function once.
 */
export const ORIGINAL_EXPORT = Symbol('original export');
const ORIGINAL = ORIGINAL_EXPORT;

/**
 * A runtime's exports, each run `within` it: its own handler hears what its
 * functions refuse. An export that is guest code wraps the handler its code
 * hands calls over to as it is placed.
 *
 * @param {Record<string | symbol, any>} table
 * @param {InvalidParameterWatch} watch
 * @param {InvalidParameterRuntime} runtime
 * @returns {Record<string | symbol, any>}
 */
export function watchedExports(table, watch, runtime){
    /** @type {Map<object, object>} */
    const made = new Map();
    /** @param {any} entry @param {string} name */
    const wrap = (entry, name)=>{
        const original = entry?.[ORIGINAL] ?? entry;
        if (!original || typeof original !== 'object'
            || (typeof original.handler !== 'function' && typeof original.code !== 'function'))
        {
            return entry;
        }
        const known = made.get(original);
        if (known)
        {
            return known;
        }
        /** @param {any} builder */
        const placing = builder=>{
            if (!builder || typeof builder.register !== 'function')
            {
                return builder;
            }
            const through = Object.create(builder);
            through.register = (/** @type {any} */ definition)=>builder.register(
                typeof definition?.handler === 'function'
                    ? { ...definition, handler: watch.within(runtime, name, definition.handler) }
                    : definition);
            return through;
        };
        const wrapped = {
            ...original,
            [ORIGINAL]: original,
            ...typeof original.handler === 'function'
                ? { handler: watch.within(runtime, name, original.handler) } : {},
            ...typeof original.code === 'function'
                ? { code: (/** @type {any} */ builder)=>original.code(placing(builder)) } : {},
            ...typeof original.long === 'function'
                ? { long: (/** @type {any} */ builder)=>original.long(placing(builder)) } : {},
        };
        made.set(original, wrapped);
        return wrapped;
    };
    /** @type {Record<string | symbol, any>} */
    const watched = {};
    for (const key of Reflect.ownKeys(table))
    {
        watched[key] = typeof key === 'string' ? wrap(table[key], key) : table[key];
    }
    return watched;
}
