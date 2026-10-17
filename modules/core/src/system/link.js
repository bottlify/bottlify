/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Calls between two threads, through a pair of rings: how a process in a
 * worker of its own asks the system half of Win32 something and how the
 * system asks the process back.
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

/**
 * The records on a link: a call, an answer, and a part of one of them too
 * long for a ring's record, the rest following it in order.
 */
const CALL = 0;
const ANSWER = 1;
const PART = 2;

/**
 * A failure as a value: its message and whatever it says of itself -- a code
 * the caller tells failures apart by, the blocks a bundle read was missing --
 * so the side that called throws what the other side threw, not only its text.
 *
 * @param {unknown} e
 */
const failureOf = e=>{
    if (!(e instanceof Error))
    {
        return { message: String(e) };
    }
    /** @type {Record<string, unknown>} */
    const told = { message: e.message };
    for (const [name, value] of Object.entries(e))
    {
        try
        {
            encodeValue(value);
            told[name] = value;
        }
        catch {
            // What cannot cross is left behind: the message still does.
        }
    }
    return told;
};

/** @param {any} failure */
const errorOf = failure=>(typeof failure === 'string' ? new Error(failure)
    : Object.assign(new Error(failure?.message ?? 'link: the call failed'),
        { ...failure, message: undefined }, { message: failure?.message }));

/** A link's rings, each way: what a call and its arguments fit in, many times over. */
export const LINK_BYTES = 1 << 20;

/**
 * How long a side looks at its doorbell before it sleeps on it, in ms: past
 * the round trip of a call answered at once, short of anything a person or
 * a frame would notice.
 */
export const SPIN_MS = 0.05;

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

    /**
     * A record the ring can hold whole goes as it is; a longer one -- a file
     * read, a picture -- goes as parts, one after another, and is decoded
     * once the last is in. Nothing comes between them: a record is sent at
     * once or queued behind the ones before it, in order.
     *
     * @param {Uint8Array} record
     */
    const send = record=>{
        if (record.length <= outbound.maxRecord)
        {
            sendRecord(record);
            return;
        }
        // Room for the part's own framing.
        const step = outbound.maxRecord - 64;
        for (let at = 0; at < record.length; at += step)
        {
            sendRecord(encodeValue([PART, at + step >= record.length,
                record.subarray(at, at + step)]));
        }
    };
    /** @param {Uint8Array} record */
    const sendRecord = record=>{
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

    /**
     * An answer that cannot cross -- a handler that returned what the codec
     * does not carry -- goes as the failure it is: the caller is told, and the
     * side answering, which serves every call, goes on.
     *
     * @param {number} id @param {boolean} ok @param {any} value
     */
    const answer = (id, ok, value)=>{
        let record;
        try
        {
            record = encodeValue([ANSWER, id, ok, value]);
        }
        catch (e){
            record = encodeValue([ANSWER, id, false, failureOf(e)]);
        }
        send(record);
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
            answer(id, false, failureOf(e));
            return;
        }
        if (typeof result?.then === 'function')
        {
            result.then((/** @type {any} */ value)=>answer(id, true, value),
                (/** @type {any} */ e)=>answer(id, false, failureOf(e)));
            return;
        }
        answer(id, true, result);
    };

    /** The parts of a record still coming. @type {Uint8Array[]} */
    const parts = [];
    /**
     * Records taken off the ring and not handled yet, in the order they came.
     * A handler that makes a call of its own and waits for it pumps again
     * from inside its record, and goes on from here: the ring's head would
     * hand it that record a second time.
     *
     * @type {Uint8Array[]}
     */
    const taken = [];
    /** @param {Uint8Array} bytes */
    const handle = bytes=>{
        let record = decodeValue(bytes);
        if (record[0] === PART)
        {
            parts.push(record[2].slice());
            if (!record[1])
            {
                return;
            }
            const whole = new Uint8Array(parts.reduce((sum, part)=>sum + part.length, 0));
            let at = 0;
            for (const part of parts.splice(0))
            {
                whole.set(part, at);
                at += part.length;
            }
            record = decodeValue(whole);
        }
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
                waiting.reject(errorOf(value));
            }
            return;
        }
        arrived.set(id, { ok, value });
    };
    /**
     * Handles everything the other side wrote: its calls, and the answers
     * to this side's. Returns how many records there were.
     */
    const pump = ()=>{
        flush();
        const count = inbound.drain(bytes=>void taken.push(bytes.slice()));
        while (taken.length > 0)
        {
            handle(/** @type {Uint8Array} */ (taken.shift()));
        }
        return count;
    };

    /** Whether this thread may block: never the page's own. */
    const canBlock = typeof Atomics.wait === 'function'
        && (typeof globalThis.window === 'undefined');

    /**
     * Whether the doorbell rang within `SPIN_MS`, looked at without sleeping.
     * A thread put to sleep on a word is woken tens of microseconds after
     * the word is raised -- on both sides of a call, so a call across that
     * sleeps costs several times the work of answering it; the other side
     * mostly answers within a few.
     *
     * @param {number} seen
     */
    const rang = seen=>{
        const until = performance.now() + SPIN_MS;
        for (;;)
        {
            if (doorbellOf(bell) !== seen)
            {
                return true;
            }
            if (performance.now() >= until)
            {
                return false;
            }
        }
    };

    /**
     * What this side asked of the other, by target and method: how often,
     * and how long it was blocked for an answer. What a process spends
     * waiting on the system is read here, not guessed.
     *
     * @type {Map<string, { count: number, waitedMs: number }>}
     */
    const asked = new Map();
    /** @param {string} target @param {string} method @param {number} waitedMs */
    const note = (target, method, waitedMs)=>{
        const key = `${target}.${method}`;
        const entry = asked.get(key) ?? { count: 0, waitedMs: 0 };
        entry.count++;
        entry.waitedMs += waitedMs;
        asked.set(key, entry);
    };

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
            note(target, method, 0);
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
            const started = performance.now();
            send(encodeValue([CALL, id, target, method, args]));
            const until = Date.now() + timeoutMs;
            for (;;)
            {
                const seen = doorbellOf(bell);
                pump();
                const got = arrived.get(id);
                if (got)
                {
                    note(target, method, performance.now() - started);
                    arrived.delete(id);
                    if (!got.ok)
                    {
                        throw errorOf(got.value);
                    }
                    return got.value;
                }
                const left = until - Date.now();
                if (left <= 0)
                {
                    throw new Error(
                        `link: ${target}.${method} was not answered in ${timeoutMs} ms`);
                }
                if (!rang(seen))
                {
                    waitDoorbell(bell, seen, left);
                }
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
                const handled = pump();
                if (!state.serving)
                {
                    break;
                }
                // A process that asked one thing asks the next straight
                // after; the page's own thread does not spin for it.
                if (handled > 0 && canBlock && rang(seen))
                {
                    continue;
                }
                const waited = /** @type {any} */ (Atomics).waitAsync(words, bell.index, seen);
                if (waited.async)
                {
                    await waited.value;
                }
            }
            // What the other side wrote before it was closed is still its
            // word: the last things a process tells the run as it ends.
            pump();
        },

        /**
         * What this side asked, the most waited on first.
         *
         * @returns {{ calls: number, waitedMs: number,
         *     asked: { name: string, count: number, waitedMs: number }[] }}
         */
        diagnostics(){
            const rows = [...asked].map(([name, entry])=>({ name, ...entry }))
                .sort((a, b)=>b.waitedMs - a.waitedMs || b.count - a.count);
            return {
                calls: rows.reduce((sum, row)=>sum + row.count, 0),
                waitedMs: rows.reduce((sum, row)=>sum + row.waitedMs, 0),
                asked: rows.slice(0, 16),
            };
        },

        /** Stops `serve`. */
        close(){
            state.serving = false;
            Atomics.add(new Int32Array(bell.buffer), bell.index, 1);
            Atomics.notify(new Int32Array(bell.buffer), bell.index);
        },
    };
}
