/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Calls between two threads, through a pair of rings: how a process in a
 * worker of its own asks the system half of Win32 something and how the
 * system asks the process back (roadmap/v2, the Win32 split).
 *
 * Each side calls the other by a target and a method, with values for
 * arguments (`codec.js`), and answers the other's calls from the handlers it
 * was opened with. A call is made two ways. The side that runs a program
 * calls and waits, blocking its thread on the doorbell -- it has nothing to
 * do until the answer comes, and giving the thread back to its event loop is
 * what it is in a worker to avoid. The system's side calls and is handed a
 * promise, because it serves every process and must never stop for one.
 *
 * A wait for an answer is not a plain wait: the side waiting still answers
 * what it is asked meanwhile. The system often cannot answer a process
 * without asking another process something -- or the same one -- and a
 * waiting process that answered nothing would hold every other up behind it.
 * So both rings feed one doorbell per side, and a waiting side handles the
 * calls that arrive before the answer it waits for, at any depth.
 */

import { decodeValue, encodeValue } from './codec.js';
import { createRingMemory, doorbellOf, openRing, waitDoorbell } from './ring.js';

/** The two records on a link. */
const CALL = 0;
const ANSWER = 1;

/** A link's rings, each way: what a call and its arguments fit in, many times over. */
export const LINK_BYTES = 1 << 20;

/**
 * @typedef {Object} LinkEnd
 * @property {import('./ring.js').RingMemory} out  what this side writes
 * @property {import('./ring.js').RingMemory} in   what this side reads; its doorbell this side's
 */

/**
 * The memory of a link, as each of its two sides opens it. A side's doorbell
 * is the word it sleeps on; one handed in can be shared with the other rings
 * the same thread reads, so one wait serves them all.
 *
 * @param {Object} [options]
 * @param {number} [options.capacity]
 * @param {{ buffer: SharedArrayBuffer, index: number } | null} [options.bellA]
 * @param {{ buffer: SharedArrayBuffer, index: number } | null} [options.bellB]
 * @returns {{ a: LinkEnd, b: LinkEnd }}
 */
export function createLinkMemory({ capacity = LINK_BYTES, bellA = null, bellB = null } = {}){
    const toA = createRingMemory(capacity, bellA);
    const toB = createRingMemory(capacity, bellB);
    return { a: { out: toB, in: toA }, b: { out: toA, in: toB } };
}

/**
 * One side of a link.
 *
 * @param {LinkEnd} end
 * @param {Record<string, Record<string, (...args: any[]) => any>>} handlers
 *     What this side answers: a handler per target and method. One may
 *     return a promise, and its answer goes when it settles.
 */
export function openLink(end, handlers){
    const outbound = openRing(end.out);
    const inbound = openRing(end.in);
    const bell = inbound.bell;
    let nextId = 1;
    /** Answers to calls this side waits on, by id. @type {Map<number, { ok: boolean, value: any }>} */
    const arrived = new Map();
    /** Calls this side was handed a promise for. @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
    const promised = new Map();
    /** Calls answered whose answer did not fit the ring yet. @type {Uint8Array[]} */
    const unsent = [];

    /** @param {Uint8Array} record */
    const send = record=>{
        if (unsent.length > 0 || !outbound.write(record))
        {
            // The other side frees room as it reads, and it reads while it
            // waits; a thread that may block waits for that, one that may not
            // keeps the record for its next pump.
            if (unsent.length === 0 && canBlock && outbound.writeWaiting(record))
            {
                return;
            }
            unsent.push(record);
        }
    };
    const flush = ()=>{
        while (unsent.length > 0 && outbound.write(unsent[0]))
        {
            unsent.shift();
        }
    };

    /** @param {number} id @param {boolean} ok @param {any} value */
    const answer = (id, ok, value)=>{
        send(encodeValue([ANSWER, id, ok, value]));
    };

    /** @param {number} id @param {string} target @param {string} method @param {any[]} args */
    const dispatch = (id, target, method, args)=>{
        const handler = handlers[target]?.[method];
        if (!handler)
        {
            answer(id, false, `link: nothing answers ${target}.${method}`);
            return;
        }
        let result;
        try
        {
            result = handler(...args);
        }
        catch (e){
            answer(id, false, e instanceof Error ? e.message : String(e));
            return;
        }
        if (typeof result?.then === 'function')
        {
            result.then((/** @type {any} */ value)=>answer(id, true, value),
                (/** @type {any} */ e)=>answer(id, false, e instanceof Error ? e.message : String(e)));
            return;
        }
        answer(id, true, result);
    };

    /**
     * Handles everything the other side wrote: its calls, and the answers
     * to this side's. Returns how many records there were.
     */
    const pump = ()=>{
        flush();
        return inbound.drain(bytes=>{
            const record = decodeValue(bytes);
            if (record[0] === CALL)
            {
                dispatch(record[1], record[2], record[3], record[4]);
                return;
            }
            const [, id, ok, value] = record;
            const waiting = promised.get(id);
            if (waiting)
            {
                promised.delete(id);
                if (ok)
                {
                    waiting.resolve(value);
                }
                else
                {
                    waiting.reject(new Error(value));
                }
                return;
            }
            arrived.set(id, { ok, value });
        });
    };

    /** Whether this thread may block: never the page's own. */
    const canBlock = typeof Atomics.wait === 'function'
        && (typeof globalThis.window === 'undefined');

    /** Whether `serve` goes on: an object, so the loop reads what `close` wrote. */
    const state = { serving: false };

    return {
        bell,
        pump,

        /**
         * Calls the other side and hands back a promise of its answer, which
         * `pump` -- or `serve` -- settles.
         *
         * @param {string} target @param {string} method @param {any[]} [args]
         * @returns {Promise<any>}
         */
        call(target, method, args = []){
            const id = nextId++;
            return new Promise((resolve, reject)=>{
                promised.set(id, { resolve, reject });
                send(encodeValue([CALL, id, target, method, args]));
            });
        },

        /**
         * Calls the other side and blocks this thread until it answers,
         * handling every call it is sent meanwhile. Only where the thread
         * may block.
         *
         * @param {string} target @param {string} method @param {any[]} [args]
         * @param {number} [timeoutMs]  in all; past it the call throws
         * @returns {any}
         */
        callWaiting(target, method, args = [], timeoutMs = Infinity){
            const id = nextId++;
            send(encodeValue([CALL, id, target, method, args]));
            const until = Date.now() + timeoutMs;
            for (;;)
            {
                const seen = doorbellOf(bell);
                pump();
                const got = arrived.get(id);
                if (got)
                {
                    arrived.delete(id);
                    if (!got.ok)
                    {
                        throw new Error(got.value);
                    }
                    return got.value;
                }
                const left = until - Date.now();
                if (left <= 0)
                {
                    throw new Error(
                        `link: ${target}.${method} was not answered in ${timeoutMs} ms`);
                }
                waitDoorbell(bell, seen, left);
            }
        },

        /**
         * Answers the other side for as long as the link is open, on the
         * event loop: the side that must never block. Resolves once `close`
         * is called.
         */
        async serve(){
            state.serving = true;
            const words = new Int32Array(bell.buffer);
            while (state.serving)
            {
                const seen = doorbellOf(bell);
                pump();
                if (!state.serving)
                {
                    break;
                }
                const waited = /** @type {any} */ (Atomics).waitAsync(words, bell.index, seen);
                if (waited.async)
                {
                    await waited.value;
                }
            }
        },

        /** Stops `serve`. */
        close(){
            state.serving = false;
            Atomics.add(new Int32Array(bell.buffer), bell.index, 1);
            Atomics.notify(new Int32Array(bell.buffer), bell.index);
        },
    };
}
