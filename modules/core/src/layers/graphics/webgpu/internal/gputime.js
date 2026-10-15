/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The GPU's own time for each render pass of a frame, from timestamp queries.
 *
 * Every other instrument here measures a processor: the engine thread, the
 * graphics worker, the replay. A draw that is slow on the GPU leaves them all
 * idle and shows only as a wait somewhere else -- a fixed-function stage that
 * cost twenty milliseconds a frame was found by cutting frames apart by hand.
 * With this, a frame's passes come with their milliseconds, named by the
 * surface each drew into.
 *
 * Only where the device has `timestamp-query`, and only in a diagnostics build:
 * a pass's two writes and a frame's resolve and map are not free.
 */

/** Passes timed in one frame; a frame with more times its first ones. */
export const TIMED_PASSES = 64;
/** Frames whose times are still being read back; past this a frame goes untimed. */
const IN_FLIGHT = 4;
/** Frames whose passes are kept as they were, newest last. */
const RECENT_FRAMES = 8;
/** A pass longer than this is two stamps that do not belong together. */
const LONGEST_NS = 1e9;
/** Labels kept in the totals; the rest are summed as one. */
const LABELS_KEPT = 64;

/**
 * @typedef {{ label: string, ms: number }} TimedPass
 * @typedef {{ frames: number, untimed: number, unpaired: number, lastUnpaired: string[],
 *     gpuMs: number,
 *     byLabel: { label: string, passes: number, ms: number }[],
 *     recent: TimedPass[][] }} GpuTimes
 */

/**
 * @param {Object} options
 * @param {any} options.device  a GPUDevice, or the test double
 * @param {boolean} [options.enabled]  off in a production bundle
 */
export function createGpuTimer({ device, enabled = true }){
    const available = enabled && typeof device?.createQuerySet === 'function'
        && device.features?.has?.('timestamp-query') === true;
    let frames = 0;
    let untimed = 0;
    let gpuMs = 0;
    let inFlight = 0;
    /** Passes whose stamps could not be a length: one left unwritten, or out of order. */
    let unpaired = 0;
    /** The last unpaired stamps as they came, for a reader to see why. @type {string[]} */
    let lastUnpaired = [];
    /** @type {Map<string, { passes: number, ms: number }>} */
    const byLabel = new Map();
    /** @type {TimedPass[][]} */
    const recent = [];

    /** @param {TimedPass[]} passes */
    const take = passes=>{
        frames++;
        let total = 0;
        for (const { label, ms } of passes)
        {
            total += ms;
            const key = byLabel.has(label) || byLabel.size < LABELS_KEPT ? label : '(other)';
            const entry = byLabel.get(key) ?? { passes: 0, ms: 0 };
            entry.passes++;
            entry.ms += ms;
            byLabel.set(key, entry);
        }
        gpuMs += total;
        recent.push(passes);
        if (recent.length > RECENT_FRAMES)
        {
            recent.shift();
        }
    };

    return {
        available,

        /**
         * One frame's timing: where each pass writes its two stamps, the
         * resolve the frame ends with, and the reading once it is submitted.
         * Null where nothing is timed.
         */
        frame(){
            if (!available)
            {
                return null;
            }
            if (inFlight >= IN_FLIGHT)
            {
                untimed++;
                return null;
            }
            /** @type {any} */
            let set = null;
            /** @type {string[]} */
            const labels = [];
            /** @type {any} */
            let readback = null;
            return {
                /**
                 * The pass's `timestampWrites`, or undefined once the frame's
                 * slots are spent.
                 *
                 * @param {string} label
                 */
                pass(label){
                    if (labels.length >= TIMED_PASSES)
                    {
                        return undefined;
                    }
                    set ??= device.createQuerySet({ label: 'pass-times', type: 'timestamp',
                        count: TIMED_PASSES * 2 });
                    const at = labels.length * 2;
                    labels.push(label);
                    return { querySet: set, beginningOfPassWriteIndex: at,
                        endOfPassWriteIndex: at + 1 };
                },

                /**
                 * The stamps into a buffer the processor can read, as the
                 * frame's last commands.
                 *
                 * @param {any} encoder
                 */
                resolve(encoder){
                    if (labels.length === 0)
                    {
                        return;
                    }
                    const size = labels.length * 16;
                    const resolved = device.createBuffer({ label: 'pass-times-resolve', size,
                        // QUERY_RESOLVE | COPY_SRC
                        usage: 0x0200 | 0x0004 });
                    readback = { resolved, buffer: device.createBuffer({ label: 'pass-times',
                        size,
                        // MAP_READ | COPY_DST
                        usage: 0x0001 | 0x0008 }) };
                    encoder.resolveQuerySet(set, 0, labels.length * 2, resolved, 0);
                    encoder.copyBufferToBuffer(resolved, 0, readback.buffer, 0, size);
                },

                /** Read once the frame is submitted; the frame's objects are destroyed. */
                settle(){
                    if (!readback)
                    {
                        set?.destroy?.();
                        return;
                    }
                    inFlight++;
                    const { resolved, buffer } = readback;
                    buffer.mapAsync(1).then(()=>{
                        const stamps = new BigInt64Array(buffer.getMappedRange()
                            .slice(0, labels.length * 16));
                        buffer.unmap();
                        // A frame's passes run on the GPU one after another, so
                        // a pass's time is from the end of the one before to its
                        // own end. The beginning stamps are not relied on: some
                        // drivers leave them unwritten (a small number where a
                        // time should be), and the first pass's is used only
                        // where it is one. A stamp that is no time -- unwritten,
                        // out of order, a second apart -- is counted, not summed.
                        /** @type {TimedPass[]} */
                        const timed = [];
                        labels.forEach((label, index)=>{
                            const end = stamps[index * 2 + 1];
                            const from = index > 0 ? stamps[index * 2 - 1] : stamps[0];
                            const ns = Number(end - from);
                            if (from <= 0n || end <= 0n || ns < 0 || ns > LONGEST_NS)
                            {
                                unpaired++;
                                lastUnpaired = [label, String(from), String(end)];
                                return;
                            }
                            timed.push({ label, ms: ns / 1e6 });
                        });
                        take(timed);
                    }, ()=>{
                        untimed++;
                    }).finally(()=>{
                        inFlight--;
                        buffer.destroy?.();
                        resolved.destroy?.();
                        set?.destroy?.();
                    });
                },
            };
        },

        /**
         * What was timed so far: the GPU's milliseconds in all, by the
         * surface each pass drew into (the most first), and the last frames
         * as they were. `available` false says this device cannot answer --
         * not that the GPU took no time.
         *
         * @returns {{ available: false } | ({ available: true } & GpuTimes)}
         */
        stats(){
            if (!available)
            {
                return { available: false };
            }
            return {
                available: true,
                frames,
                untimed,
                unpaired,
                lastUnpaired,
                gpuMs: Math.round(gpuMs * 1000) / 1000,
                byLabel: [...byLabel].map(([label, entry])=>({ label, passes: entry.passes,
                    ms: Math.round(entry.ms * 1000) / 1000 }))
                    .sort((a, b)=>b.ms - a.ms),
                recent: recent.map(passes=>passes.slice()),
            };
        },
    };
}
