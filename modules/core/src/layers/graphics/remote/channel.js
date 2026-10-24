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
 * Receiver to sender:  { type: 'answer', serial, answer, outs, counts? }
 *                      { type: 'presented', count }
 *                      { type: 'counts', counts }      occlusion counts the GPU has just
 *                                                      given, sent unasked
 *                      { type: 'diagnostics', diagnostics, phases?, latency? }
 *                                                      what a device said of itself when asked,
 *                                                      where the receiving thread's time
 *                                                      went (`WorkerPhases`), and how far the
 *                                                      GPU ran behind its presents
 *                                                      (`FrameLatencyState`)
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
/** The milliseconds an occlusion count's wait is sorted under, the last catching the rest. */
export const OCCLUSION_BOUNDS = Object.freeze([1, 2, 4, 8, 16, 32, 64, 128, Infinity]);
/** How many occlusion measurements' events are kept, the latest. */
const OCCLUSION_TRACED = 64;

/** The least time between batches sent early for what they lend. */
const LENT_GAP_MS = 0.25;

/**
 * Where the played side's thread spent its time, cumulative since it started:
 * every batch read and played (`batch-read`, whose `selfMs` leaves out the
 * look below), and the look at the objects at a count of zero a batch makes
 * once a frame (`batch-sweep`). The worker has no phase profiler of its own;
 * these are timed per batch, a few hundred a second, at two clock readings
 * each, and are absent from a production bundle.
 *
 * @typedef {{ 'batch-read': { count: number, ms: number, selfMs: number },
 *     'batch-sweep': { count: number, ms: number } }} WorkerPhases
 */

/**
 * The bound on the frames the played side's GPU may still be drawing
 * (`latency.js`), as it stood: a present that queued one past it waited for
 * the GPU (`held`, `heldMs`), which is the only account of a GPU too slow for
 * the frames it is handed -- the played side's thread is idle meanwhile, and
 * the program's waits on its presents look the same whichever of the two
 * held them.
 *
 * @typedef {ReturnType<ReturnType<typeof import('../webgpu/internal/latency.js')
 *     .createFrameLatency>['diagnostics']>} FrameLatencyState
 */

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
 *     base?: number, least?: number } | null} [options.lending]
 *     where the played side reads guest memory in place, the parts of a
 *     lending (`lending.js`) it was sent, and the smallest allocation it lends
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
     * @type {Map<string, { count: number, ms: number, maxMs: number, queuedMs: number,
     *     heldMs: number, backMs: number }>}
     */
    const waits = new Map();
    /** @param {string} name @param {number} since */
    /**
     * @param {string} name @param {number} since
     * @param {{ queued?: number, held?: number, back?: number }} [parts]  where an
     *     answer's time went: its batch on the way there, the played side holding
     *     it, and on the way back
     */
    const waited = (name, since, parts)=>{
        const ms = now() - since;
        const held = waits.get(name) ?? { count: 0, ms: 0, maxMs: 0, queuedMs: 0, heldMs: 0,
            backMs: 0 };
        held.count++;
        held.ms += ms;
        held.maxMs = Math.max(held.maxMs, ms);
        held.queuedMs += parts?.queued ?? 0;
        held.heldMs += parts?.held ?? 0;
        held.backMs += parts?.back ?? 0;
        waits.set(name, held);
    };
    let pending = false;
    let serial = 0;
    /** @type {Map<number, (reply: any, parts?: { queued?: number, held?: number, back?: number }) => void>} */
    const waiting = new Map();
    let presents = 0;
    let presented = 0;
    /** @type {{ count: number, release: () => void }[]} */
    const held = [];
    /** What the played side's diagnostics said last. @type {any} */
    let diagnostics = null;
    /** Where the played side's time went, as it said last. @type {WorkerPhases | null} */
    let phases = null;
    /** How far its GPU ran behind, as it said last. @type {FrameLatencyState | null} */
    let latency = null;
    let failure = /** @type {string | null} */ (null);
    /** The diagnostics asked for, and those the played side has answered. */
    let asked = 0;
    let told = 0;
    /** Who waits for an answer to every ask made before they came. */
    /** @type {{ until: number, resolve: () => void }[]} */
    const listening = [];
    const hear = ()=>{
        for (let at = listening.length - 1; at >= 0; at--)
        {
            if (failure || told >= listening[at].until)
            {
                listening[at].resolve();
                listening.splice(at, 1);
            }
        }
    };

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
    /** The batches posted, and their bytes. */
    const sent = { batches: 0, bytes: 0, ms: 0 };
    /**
     * Of those bytes, the guest memory copied into them, by what copied it --
     * what a lend of buffers, or of anything else, would have left in place --
     * and `compared`, the bytes of dynamic buffers draws compared to find what
     * to copy, which cost this thread a read of each whether or not it sent any.
     */
    const shipped = { buffers: 0, surfaces: 0, reads: 0, writes: 0, dynamic: 0, compared: 0 };
    /** The draw checks of the recordings over this channel (`checkDraws`). @type {(() => import('./draw-check.js').DrawCheckFigures)[]} */
    const drawChecks = [];
    /**
     * The occlusion counts the program was told, with how long after its END
     * each took, the polls and asks it made meanwhile, those that came beside
     * another's answer, and how many fell under each bound of OCCLUSION_BOUNDS.
     */
    const occlusion = { counted: 0, ms: 0, maxMs: 0, polls: 0, asks: 0, beside: 0,
        sentAfterMs: 0, tripMs: 0, under: OCCLUSION_BOUNDS.map(()=>0) };
    /** @type {((counts: import('./replay.js').OcclusionCount[]) => void)[]} */
    const countListeners = [];
    /** The last OCCLUSION_TRACED measurements' events, oldest first. */
    /** @type {import('./replay.js').OcclusionEvent[][]} */
    const occlusionTrace = [];
    /** The calls the batches are made of, by method: how many, and their bytes. */
    /** @type {Map<string, { count: number, bytes: number }>} */
    const byMethod = new Map();
    const flush = ()=>{
        pending = false;
        if (writer.empty())
        {
            return;
        }
        sentAt = now();
        const buffer = writer.take();
        sent.batches++;
        sent.bytes += buffer.byteLength;
        post({ type: 'calls', buffer, at: shared() }, [buffer]);
        lender?.sent();
        // What taking and posting the batch cost the program's thread.
        sent.ms += now() - sentAt;
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
                asked++;
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
                return new Promise(resolve=>waiting.set(number, (reply, parts)=>{
                    waited(name, since, parts);
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

        /** @param {(counts: import('./replay.js').OcclusionCount[]) => void} listener */
        hearCounts(listener){
            countListeners.push(listener);
        },

        /**
         * Settles once the played side has answered every diagnostics ask
         * made so far, or has stopped: a reader that asked once and waits
         * for this reads what the device said of that moment rather than
         * of the ask before -- the first of which has nothing to say.
         *
         * @returns {Promise<void>}
         */
        answered(){
            if (failure || told >= asked)
            {
                return Promise.resolve();
            }
            flush();
            return new Promise(resolve=>listening.push({ until: asked, resolve }));
        },

        /** @param {any} message  what the receiver posted */
        receive(message){
            switch (message?.type)
            {
                case 'answer':
                {
                    const resolve = waiting.get(message.serial);
                    waiting.delete(message.serial);
                    resolve?.({ answer: message.answer, outs: message.outs ?? [],
                        counts: message.counts }, {
                        queued: message.queued, held: message.held,
                        back: typeof message.at === 'number' ? shared() - message.at : undefined });
                    break;
                }
                case 'diagnostics':
                    diagnostics = message.diagnostics;
                    phases = message.phases ?? null;
                    latency = message.latency ?? null;
                    told++;
                    hear();
                    break;
                case 'counts':
                    for (const listener of countListeners)
                    {
                        listener(message.counts);
                    }
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
                    hear();
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

        /** The batches posted so far, and their bytes. */
        sent: ()=>({ ...sent }),

        /**
         * A recording copied guest bytes into the batch.
         *
         * @param {import('./replay.js').ShippedKind} kind @param {number} bytes
         */
        shipped(kind, bytes){
            shipped[kind] += bytes;
        },

        /** The guest bytes copied into the batches so far, by what copied them. */
        shippedBytes: ()=>({ ...shipped }),

        /**
         * A recording's draw check (`checkDraws`), read for a report.
         *
         * @param {() => import('./draw-check.js').DrawCheckFigures} figures
         */
        checking(figures){
            drawChecks.push(figures);
        },

        /** What the draw checks of the recordings over this channel found. */
        drawChecks: ()=>drawChecks.map(figures=>figures()),

        /**
         * The program was told an occlusion count.
         *
         * @param {number} ms @param {number} polls @param {number} asks @param {boolean} beside
         * @param {number} sentAfter @param {number} trip
         * @param {import('./replay.js').OcclusionEvent[]} [events]
         */
        counted(ms, polls, asks, beside, sentAfter, trip, events){
            if (events)
            {
                occlusionTrace.push(events);
                if (occlusionTrace.length > OCCLUSION_TRACED)
                {
                    occlusionTrace.shift();
                }
            }
            occlusion.sentAfterMs += sentAfter;
            occlusion.tripMs += trip;
            occlusion.counted++;
            occlusion.ms += ms;
            occlusion.maxMs = Math.max(occlusion.maxMs, ms);
            occlusion.polls += polls;
            occlusion.asks += asks;
            occlusion.beside += beside ? 1 : 0;
            const bound = OCCLUSION_BOUNDS.findIndex(limit=>ms < limit);
            occlusion.under[bound < 0 ? OCCLUSION_BOUNDS.length - 1 : bound]++;
        },

        /** The occlusion counts told so far; see `occlusion` above. */
        occlusion: ()=>({ ...occlusion, ms: Math.round(occlusion.ms),
            maxMs: Math.round(occlusion.maxMs), sentAfterMs: Math.round(occlusion.sentAfterMs),
            tripMs: Math.round(occlusion.tripMs), under: occlusion.under.slice(),
            trace: occlusionTrace.slice() }),

        /** @param {string} name @param {number} bytes */
        recordedCall(name, bytes){
            const entry = byMethod.get(name);
            if (entry)
            {
                entry.count++;
                entry.bytes += bytes;
            }
            else
            {
                byMethod.set(name, { count: 1, bytes });
            }
        },

        /** The calls recorded so far by method, the most bytes first. */
        methodBytes: ()=>[...byMethod].map(([name, { count, bytes }])=>({ name, count, bytes }))
            .sort((a, b)=>b.bytes - a.bytes),

        /**
         * The diagnostics asked of the played side and those it answered, as
         * "told/asked": a device table that stops changing while frames go on
         * is told here whether its answers stopped coming back.
         */
        answers: ()=>`${told}/${asked}`,

        /** Where the played side's time went, as it said with its last diagnostics; null before. */
        phases: ()=>phases,

        /**
         * How far the played side's GPU ran behind its presents, as it said
         * with its last diagnostics; null before, and where nothing bounds it.
         */
        latency: ()=>latency,

        /** The calls waited on, by name, with the milliseconds they took. */
        waits: ()=>Object.fromEntries([...waits].map(([name, sum])=>[name, {
            count: sum.count, ms: Math.round(sum.ms), maxMs: Math.round(sum.maxMs),
            queuedMs: Math.round(sum.queuedMs), heldMs: Math.round(sum.heldMs),
            backMs: Math.round(sum.backMs),
        }])),
    };
}

/**
 * Milliseconds on a clock both threads read alike: each thread's own clock
 * starts when that thread did.
 */
const shared = ()=>(typeof performance === 'undefined' ? Date.now()
    : performance.timeOrigin + performance.now());

/**
 * The played side.
 *
 * @param {Object} options
 * @param {ReturnType<typeof import('./direct3d.js').playedDirect3D>} options.played
 * @param {(message: any, transfer?: Transferable[]) => void} options.post
 * @param {() => FrameLatencyState} [options.latency]  the bound the played device's
 *     presents wait on, where it has one
 */
export function createReceiver({ played, post, latency }){
    let presented = 0;
    /** @type {WorkerPhases} */
    const phases = { 'batch-read': { count: 0, ms: 0, selfMs: 0 },
        'batch-sweep': { count: 0, ms: 0 } };
    /** @returns {WorkerPhases | undefined} */
    const phasesNow = ()=>(import.meta.BOTTLIFY_DIAGNOSTICS !== false
        ? { 'batch-read': { ...phases['batch-read'] }, 'batch-sweep': { ...phases['batch-sweep'] } }
        : undefined);
    /** Presents finish in their order, whatever order their answers settle in. */
    let presents = Promise.resolve();
    let failed = false;

    /** @param {unknown} error */
    const fail = error=>{
        failed = true;
        // The stack goes with it: the played side's own frames are the only
        // account of where a call it could not play stopped.
        post({ type: 'failed', message: error instanceof Error
            ? `${error.message}\n${error.stack ?? ''}` : String(error) });
    };

    /** @param {any} call @param {any} answered @param {number} queued @param {number} began */
    const reply = (call, answered, queued, began)=>{
        /** @param {import('./replay.js').PlayedAnswer} settled */
        const send = settled=>post({ type: 'answer', serial: call.serial,
            answer: crossable(settled.answer), outs: crossable(settled.outs),
            counts: settled.counts, queued, held: shared() - began, at: shared() });
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

    let countsDue = false;
    return {
        /**
         * The GPU has given an occlusion count: what the played device now
         * holds goes to the sender, once for every count in the turn.
         */
        counted(){
            if (countsDue || failed || !played.counts)
            {
                return;
            }
            countsDue = true;
            queueMicrotask(()=>{
                countsDue = false;
                const counts = played.counts?.() ?? [];
                if (counts.length > 0)
                {
                    post({ type: 'counts', counts });
                }
            });
        },

        /** @param {any} message  what the sender posted */
        receive(message){
            if (message?.type !== 'calls' || failed)
            {
                return;
            }
            const arrived = shared();
            const queued = typeof message.at === 'number' ? arrived - message.at : 0;
            try
            {
                const swept = played.read(message.buffer, call=>{
                    const began = shared();
                    const answer = played.play(call);
                    if (call.m === 'diagnostics')
                    {
                        post({ type: 'diagnostics', diagnostics: crossable(answer),
                            phases: phasesNow(), latency: latency?.() });
                    }
                    else if (call.wait === WAIT.ANSWER)
                    {
                        reply(call, answer, queued, began);
                    }
                    else if (call.wait === WAIT.PACED)
                    {
                        present(answer);
                    }
                });
                if (import.meta.BOTTLIFY_DIAGNOSTICS !== false)
                {
                    const ms = shared() - arrived;
                    const read = phases['batch-read'];
                    read.count++;
                    read.ms += ms;
                    read.selfMs += ms - (swept ?? 0);
                    if (swept !== undefined)
                    {
                        phases['batch-sweep'].count++;
                        phases['batch-sweep'].ms += swept;
                    }
                }
            }
            catch (e){
                fail(e);
            }
        },
    };
}
