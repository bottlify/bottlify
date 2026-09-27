/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How far a program may run ahead of the device it draws on.
 *
 * Nothing a present does waits for the GPU to draw what it was handed: the
 * frame is recorded, replayed onto the queue once its pipelines exist, and the
 * call answers. A device slower than the program then falls further behind
 * for as long as the program runs -- a queue that grows, a picture that shows
 * a key press later and later, and a read of the last frame that waits for all
 * of it. A Windows driver holds the presenting call instead once a few frames
 * are queued (Direct3D's maximum frame latency is three unless the program
 * sets another), and so does this: each frame a presenting call queues is
 * counted from the call until the device has finished the work submitted with
 * it, and a call that queues one past the bound waits for the oldest to
 * finish. The wait is the bridge's: the call answers with a promise, its
 * thread parks on it, and the scheduler runs the others meanwhile.
 */

/** The frames the device may still be working on when a presenting call answers. */
export const DEFAULT_MAX_FRAME_LATENCY = 3;

/**
 * @typedef {(submitted?: PromiseLike<unknown> | null) => Promise<void> | null} FrameQueued
 *     A presenting call has queued a frame. `submitted` settles once the
 *     frame's work is on the queue -- a replay waits for its pipelines first --
 *     and is absent when it already is. Answers null when the call may answer
 *     at once, or what it waits on first.
 */

/**
 * @param {{ queue?: any, limit?: number, lost?: PromiseLike<unknown> | null,
 *     now?: () => number }} [options]
 *     `queue` is the device's; one without `onSubmittedWorkDone` -- no GPU,
 *     a recording double -- counts and bounds nothing. A `limit` of zero
 *     bounds nothing and still counts, so how far behind the device falls is
 *     there to read. Once `lost` settles nothing is counted or held any more:
 *     a lost device may never say it finished, and a program waiting on it
 *     would wait for ever.
 */
export function createFrameLatency(options = {}){
    const { queue = null, lost = null, now = ()=>performance.now() } = options;
    const wanted = options.limit ?? DEFAULT_MAX_FRAME_LATENCY;
    const limit = Number.isFinite(wanted) && wanted > 0 ? Math.floor(wanted) : 0;
    let open = typeof queue?.onSubmittedWorkDone === 'function';
    /** Frames counted, and how many of them the device has finished. */
    let queued = 0;
    let finished = 0;
    let peak = 0;
    let held = 0;
    let heldMs = 0;
    /**
     * Calls waiting, oldest first, each until the frames ahead of its own
     * are down to the bound.
     *
     * @type {{ ticket: number, since: number, release: () => void }[]}
     */
    const waiting = [];

    /** Whether the oldest call waiting may go. */
    const oldestDue = ()=>!open || finished >= waiting[0].ticket - limit;
    const releaseDue = ()=>{
        while (waiting.length > 0 && oldestDue())
        {
            const due = /** @type {typeof waiting[number]} */ (waiting.shift());
            heldMs += now() - due.since;
            due.release();
        }
    };
    const done = ()=>{
        finished++;
        releaseDue();
    };
    const close = ()=>{
        open = false;
        releaseDue();
    };
    if (lost)
    {
        Promise.resolve(lost).then(close, close);
    }

    return {
        /** @type {FrameQueued} */
        queued(submitted){
            if (!open)
            {
                return null;
            }
            // The most the device was ever behind, this frame among them:
            // with a bound, one more than the bound at most.
            const ticket = ++queued;
            peak = Math.max(peak, queued - finished);
            // Asked once the frame is on the queue and not before, since
            // `onSubmittedWorkDone` speaks for the work submitted before the
            // call: now, for a frame already there. A frame that never gets
            // there -- its replay threw -- is finished as soon as that is known.
            const whenFinished = ()=>queue.onSubmittedWorkDone();
            const work = submitted
                ? Promise.resolve(submitted).then(whenFinished)
                : new Promise(resolve=>resolve(whenFinished()));
            work.then(done, done);
            if (limit === 0 || finished >= ticket - limit)
            {
                return null;
            }
            held++;
            return new Promise(release=>{
                waiting.push({ ticket, since: now(), release });
            });
        },

        /** Counts and holds nothing from here on, and lets whoever waits go. */
        close,

        diagnostics(){
            return {
                limit,
                counting: open,
                inFlight: queued - finished,
                peak,
                frames: queued,
                held,
                heldMs: Math.round(heldMs),
                waiting: waiting.length,
            };
        },
    };
}
