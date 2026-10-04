/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The recorded calls carried across a port: the sender on the side the
 * program runs on, the receiver where the played device draws.
 *
 * Calls go in batches, one message for every call made in a turn of the
 * sender's thread, written as they are made into one buffer that is
 * transferred rather than copied. A
 * call the caller waits for goes at once, and its answer comes back as a
 * promise; so does a present, which is answered at once unless the played
 * side has more than `framesAhead` presents still to finish, and then when it
 * has caught up -- the bound on how far behind the program the pictures are.
 *
 * Sender to receiver:  { type: 'calls', buffer }       a batch, as `wire.js` writes it
 * Receiver to sender:  { type: 'answer', serial, answer, outs }
 *                      { type: 'presented', count }
 *                      { type: 'diagnostics', diagnostics }
 *                                                      what a device said of itself when asked
 *                      { type: 'wrote', writes }       guest memory the played side wrote later:
 *                                                      the bytes, or where it wrote shared memory
 *                      { type: 'divergence', api, detail }
 *                      { type: 'lost' }                its GPU went away
 *                      { type: 'failed', message }     a call could not be played
 */

import { WAIT, createWriter } from './wire.js';
import { createLender } from './lending.js';

/** How many calls go between two readings of the clock for a batch the turn has kept too long. */
const CHECKED_EVERY = 64;

/** The least time between batches sent early for what they lend. */
const LENT_GAP_MS = 0.25;

/**
 * A value as it can cross: the device's objects and functions left out, its
 * bytes copied.
 *
 * @param {any} value @param {number} [depth]
 * @returns {any}
 */
export function crossable(value, depth = 0){
    if (value === null || value === undefined || typeof value !== 'object')
    {
        return typeof value === 'function' ? undefined : value;
    }
    if (ArrayBuffer.isView(value))
    {
        return /** @type {any} */ (value).slice();
    }
    if (value instanceof Promise || depth > 8)
    {
        return undefined;
    }
    if (Array.isArray(value))
    {
        return value.map(one=>crossable(one, depth + 1));
    }
    if (value instanceof Map)
    {
        return new Map([...value].map(([key, one])=>[key, crossable(one, depth + 1)]));
    }
    if (value instanceof Set)
    {
        return new Set([...value].map(one=>crossable(one, depth + 1)));
    }
    if (Object.values(value).some(one=>typeof one === 'function'))
    {
        return undefined;
    }
    /** @type {Record<string, any>} */
    const out = {};
    for (const key of Object.keys(value))
    {
        out[key] = crossable(value[key], depth + 1);
    }
    return out;
}

/**
 * @typedef {Object} SenderEvents
 * @property {(address: number, bytes: Uint8Array) => void} [wrote]
 *     guest memory the played side wrote outside a call: a read-back's pixels
 * @property {(address: number, length: number) => void} [adopted]
 *     the same, written by the played side into shared guest memory itself
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {() => void} [lost]
 * @property {(message: string) => void} [failed]
 */

/**
 * The program's side: the transport a recording writes to.
 *
 * @param {Object} options
 * @param {(message: any, transfer: Transferable[]) => void} options.post
 * @param {number} [options.framesAhead]  presents the played side may still owe before one waits
 * @param {(flush: () => void) => void} [options.later]  how a batch waits for the end of the turn
 * @param {SenderEvents} [options.on]
 * @param {() => number} [options.now]  the clock the waits are timed by
 * @param {number} [options.gapMs]  at least this long between batches no call waits for,
 *     with a timer sending one the turns leave behind; zero sends one every turn
 * @param {(send: () => void, ms: number) => unknown} [options.timer]
 * @param {{ slots: SharedArrayBuffer, stash: SharedArrayBuffer, memory: Uint8Array,
 *     base?: number } | null} [options.lending]
 *     where the played side reads guest memory in place, the parts of a
 *     lending (`lending.js`) it was sent
 */
export function createSender({ post, framesAhead = 2, later = queueMicrotask, on = {},
    now = ()=>performance.now(), gapMs = 0, timer = (send, ms)=>setTimeout(send, ms),
    lending = null })
{
    const writer = createWriter();
    const lender = lending && createLender({ ...lending, now });
    /**
     * The calls the program's thread waited on the played side for, by name:
     * how many, and the milliseconds from the call to its answer -- what turns
     * two threads drawing side by side into one waiting on the other.
     *
     * @type {Map<string, { count: number, ms: number, maxMs: number }>}
     */
    const waits = new Map();
    /** @param {string} name @param {number} since */
    const waited = (name, since)=>{
        const ms = now() - since;
        const held = waits.get(name) ?? { count: 0, ms: 0, maxMs: 0 };
        held.count++;
        held.ms += ms;
        held.maxMs = Math.max(held.maxMs, ms);
        waits.set(name, held);
    };
    let pending = false;
    let serial = 0;
    /** @type {Map<number, (reply: any) => void>} */
    const waiting = new Map();
    let presents = 0;
    let presented = 0;
    /** @type {{ count: number, release: () => void }[]} */
    const held = [];
    /** What the played side's diagnostics said last. @type {any} */
    let diagnostics = null;
    let failure = /** @type {string | null} */ (null);

    // A turn of the engine's loop ends in a microtask checkpoint, and a
    // program whose threads hand a lock back and forth takes thousands of
    // turns a second: a batch a turn was a message a turn, each a copy and a
    // post on this thread and a task on the other. The played side needs the
    // calls before it is asked for an answer or a frame -- those send at once
    // -- and otherwise only soon enough to stay busy.
    let sentAt = -Infinity;
    let timed = false;
    /** Calls since the clock was last read. */
    let unchecked = 0;
    const flush = ()=>{
        pending = false;
        if (writer.empty())
        {
            return;
        }
        sentAt = now();
        const buffer = writer.take();
        post({ type: 'calls', buffer }, [buffer]);
        lender?.sent();
    };
    const due = ()=>{
        if (!pending)
        {
            return;
        }
        if (gapMs <= 0 || now() - sentAt >= gapMs)
        {
            flush();
            return;
        }
        if (!timed)
        {
            timed = true;
            timer(()=>{
                timed = false;
                if (pending)
                {
                    flush();
                }
            }, gapMs);
        }
    };
    const soon = ()=>{
        if (!pending)
        {
            pending = true;
            later(due);
        }
    };

    return {
        writer,
        lender,

        /**
         * @param {number} wait @param {string} name
         * @returns {any}
         */
        called(wait, name){
            if (failure)
            {
                throw new Error(`remote: the played device stopped: ${failure}`);
            }
            // What the played side says of itself comes back when it has
            // played the asking; the caller -- a diagnostic, which may not
            // wait -- is answered with what it said the time before.
            if (wait === WAIT.ANSWER && name === 'diagnostics')
            {
                writer.u8(WAIT.NONE);
                soon();
                return { answer: diagnostics, outs: [] };
            }
            writer.u8(wait);
            if (wait === WAIT.ANSWER)
            {
                const number = ++serial;
                writer.u32(number);
                flush();
                const since = now();
                return new Promise(resolve=>waiting.set(number, reply=>{
                    waited(name, since);
                    resolve(reply);
                }));
            }
            if (wait === WAIT.PACED)
            {
                presents++;
                flush();
                const owed = presents - framesAhead;
                if (presented >= owed)
                {
                    return undefined;
                }
                const since = now();
                return new Promise(resolve=>held.push({ count: owed,
                    release: ()=>{
                        waited(`${name} (held)`, since);
                        resolve(0);
                    } }));
            }
            // Lent bytes are claimed when the program locks them again, often
            // the next frame: the batch goes at once, so the played side has
            // read them by then rather than the claim copying them.
            if (lender?.unsent() && now() - sentAt >= LENT_GAP_MS)
            {
                flush();
                return undefined;
            }
            // A turn may be long -- a program drawing a frame without giving
            // the thread back -- and the played side idle until it ends: a
            // call that finds the gap past sends the batch itself, at the end
            // of a record. The clock is read only every so many calls.
            if (gapMs > 0 && ++unchecked >= CHECKED_EVERY)
            {
                unchecked = 0;
                if (now() - sentAt >= gapMs)
                {
                    flush();
                    return undefined;
                }
            }
            soon();
            return undefined;
        },

        recorded: soon,

        /** @param {any} message  what the receiver posted */
        receive(message){
            switch (message?.type)
            {
                case 'answer':
                {
                    const resolve = waiting.get(message.serial);
                    waiting.delete(message.serial);
                    resolve?.({ answer: message.answer, outs: message.outs ?? [] });
                    break;
                }
                case 'diagnostics':
                    diagnostics = message.diagnostics;
                    break;
                case 'presented':
                    presented = message.count;
                    while (held.length > 0 && held[0].count <= presented)
                    {
                        /** @type {{ release: () => void }} */ (held.shift()).release();
                    }
                    break;
                case 'wrote':
                    for (const { address, bytes, length } of message.writes)
                    {
                        if (bytes)
                        {
                            on.wrote?.(address, bytes);
                        }
                        else
                        {
                            on.adopted?.(address, length);
                        }
                    }
                    break;
                case 'divergence':
                    on.divergence?.(message.api, message.detail);
                    break;
                case 'lost':
                    on.lost?.();
                    break;
                case 'failed':
                    failure = String(message.message);
                    on.failed?.(failure);
                    break;
                default:
                    break;
            }
        },

        /** Sends what the turn has made so far. */
        flush,

        /** How many presents the played side still owes. */
        behind: ()=>presents - presented,

        /** The calls waited on, by name, with the milliseconds they took. */
        waits: ()=>Object.fromEntries([...waits].map(([name, sum])=>[name, {
            count: sum.count, ms: Math.round(sum.ms), maxMs: Math.round(sum.maxMs),
        }])),
    };
}

/**
 * The played side.
 *
 * @param {Object} options
 * @param {ReturnType<typeof import('./direct3d.js').playedDirect3D>} options.played
 * @param {(message: any, transfer?: Transferable[]) => void} options.post
 */
export function createReceiver({ played, post }){
    let presented = 0;
    /** Presents finish in their order, whatever order their answers settle in. */
    let presents = Promise.resolve();
    let failed = false;

    /** @param {unknown} error */
    const fail = error=>{
        failed = true;
        post({ type: 'failed', message: error instanceof Error ? error.message : String(error) });
    };

    /** @param {any} call @param {any} answered */
    const reply = (call, answered)=>{
        /** @param {{ answer: any, outs: any[] }} settled */
        const send = settled=>post({ type: 'answer', serial: call.serial,
            answer: crossable(settled.answer), outs: crossable(settled.outs) });
        if (answered instanceof Promise)
        {
            answered.then(send, fail);
        }
        else
        {
            send(answered);
        }
    };

    /** @param {any} held  what the played present holds its caller on, if anything */
    const present = held=>{
        const done = held instanceof Promise ? held : Promise.resolve();
        presents = presents.then(()=>done).then(()=>{
            presented++;
            post({ type: 'presented', count: presented });
        }, fail);
    };

    return {
        /** @param {any} message  what the sender posted */
        receive(message){
            if (message?.type !== 'calls' || failed)
            {
                return;
            }
            try
            {
                played.read(message.buffer, call=>{
                    const answer = played.play(call);
                    if (call.m === 'diagnostics')
                    {
                        post({ type: 'diagnostics', diagnostics: crossable(answer) });
                    }
                    else if (call.wait === WAIT.ANSWER)
                    {
                        reply(call, answer);
                    }
                    else if (call.wait === WAIT.PACED)
                    {
                        present(answer);
                    }
                });
            }
            catch (e){
                fail(e);
            }
        },
    };
}
