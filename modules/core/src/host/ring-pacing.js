/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run loop's pacing in the `workers` mode, the engine's side of
 * `inbound.js`: kept apart from it because the page loads that one, and this
 * one reaches into the engine.
 */

import { doorbellOf, waitDoorbell } from '../system/ring.js';
import { pacedYield } from '../app.js';

/**
 * How long an idle engine sleeps on the doorbell before it gives its event
 * loop a turn anyway. Nothing the guest waits on needs the event loop while
 * it sleeps -- the wait is taken only when no host answer is outstanding --
 * but a frame to compose or a session to save does, and this bounds how long
 * they wait behind an idle machine.
 */
export const IDLE_SLEEP_MS = 50;

/**
 * The pacing of an engine fed through a ring: what the page says is read at
 * every turn boundary without giving the thread away, the thread is given to
 * the event loop only for what arrives there -- host answers, fetches, a turn
 * that ran nothing, and the interval bound for the rest -- and a machine with
 * nothing to run and nothing outstanding sleeps on the doorbell.
 *
 * @param {Object} deps
 * @param {{ bell: { buffer: SharedArrayBuffer, index: number }, drain: () => number }} deps.inbound
 * @param {() => Promise<void>} deps.macrotask
 * @param {() => number} deps.now
 * @param {number} deps.intervalMs
 * @param {(bell: { buffer: SharedArrayBuffer, index: number }, seen: number,
 *     timeoutMs: number) => any} [deps.sleep]   a blocking wait; `waitDoorbell` unless a test says
 * @param {{ buffer: SharedArrayBuffer, index: number } | null} [deps.posted]
 *     A count the threads that post to this one -- the translation worker --
 *     raise after each message, ringing the inbound doorbell with it: a
 *     message is waiting on the event loop, and the next yield is now rather
 *     than when the interval is up.
 * @returns {import('../app.js').RunPacing & { counts: () => Record<string, number> }}
 */
export function ringPacing({ inbound, macrotask, now, intervalMs, sleep = waitDoorbell,
    posted = null })
{
    const counts = { drained: 0, yields: 0, slept: 0, sleptMs: 0, woken: 0, heard: 0 };
    const postedWords = posted ? new Int32Array(posted.buffer) : null;
    let postedSeen = postedWords ? Atomics.load(postedWords, /** @type {any} */ (posted).index) : 0;
    /** Whether something was posted to this thread since the last look. */
    const signalled = ()=>{
        if (!postedWords || !posted)
        {
            return false;
        }
        const count = Atomics.load(postedWords, posted.index);
        if (count === postedSeen)
        {
            return false;
        }
        postedSeen = count;
        counts.heard++;
        return true;
    };
    /** Machines taking turns on this thread: one of several may not block it. */
    let machines = 1;
    const yieldNow = pacedYield({ macrotask: ()=>{
        counts.yields++;
        return macrotask();
    }, now, intervalMs, signalled });
    const drain = ()=>{
        const taken = inbound.drain();
        counts.drained += taken;
        return taken;
    };
    return {
        counts: ()=>({ ...counts }),
        /** @param {number} count */
        machines(count){
            machines = count;
        },
        yield(pending){
            drain();
            return yieldNow(pending);
        },
        wait({ sleep: idle, deadlineMs, wakes }){
            // The count first: a message written after it and before the
            // sleep makes the sleep return at once.
            const seen = doorbellOf(inbound.bell);
            if (drain() > 0)
            {
                return Promise.resolve();
            }
            if (!idle || signalled())
            {
                counts.yields++;
                return macrotask();
            }
            // With another machine on the thread, or an answer due on the
            // event loop, the wait is the event loop's: blocking would stop
            // the other machine, or the answer, with it.
            if (wakes.length > 0 || machines > 1)
            {
                // An answer is due on the event loop: wait there, for it, the
                // deadline or the doorbell.
                /** @type {Promise<unknown>[]} */
                const waits = [...wakes];
                const bell = /** @type {any} */ (Atomics).waitAsync?.(
                    new Int32Array(inbound.bell.buffer), inbound.bell.index, seen);
                if (bell?.async)
                {
                    waits.push(bell.value);
                }
                /** @type {ReturnType<typeof setTimeout> | null} */
                let timer = null;
                waits.push(new Promise(resolve=>{
                    timer = setTimeout(resolve, Math.min(deadlineMs ?? IDLE_SLEEP_MS,
                        bell?.async ? IDLE_SLEEP_MS : intervalMs));
                }));
                counts.yields++;
                return Promise.race(waits).then(()=>{
                    if (timer !== null)
                    {
                        clearTimeout(timer);
                    }
                });
            }
            const limit = Math.max(0, Math.min(deadlineMs ?? IDLE_SLEEP_MS, IDLE_SLEEP_MS));
            const started = now();
            counts.slept++;
            if (sleep(inbound.bell, seen, limit) !== 'timed-out')
            {
                counts.woken++;
            }
            counts.sleptMs += now() - started;
            return Promise.resolve();
        },
    };
}
