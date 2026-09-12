/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createRing } from './ring.js';

/**
 * The phase profiler: where a frame went, and how much of it was ours.
 *
 * This instrument exists because reading code does not find this class of
 * defect. A ninefold performance loss once survived months of review and was
 * located by a single profiling run -- so the profiler is built before the
 * layers it will measure, not after one of them disappoints.
 *
 * Its subject is the whole engine rather than any one backend. A phase is
 * named, nestable and tagged with whose time it is, and the number it exists to
 * produce is the one the thresholds name: the share of a frame spent in our own
 * code rather than executing guest instructions. Nesting is accounted by self
 * time -- a phase of ours that wraps a guest call is credited only with its own
 * overhead, which is the only way that share means anything.
 *
 * Alongside the totals, each phase keeps its worst single occurrence, measured
 * whole rather than by self time. For a phase entered from a guest call that is
 * the longest the calling guest thread was held -- including whatever we waited
 * on inside it, which the thread waited on too -- and that hold is the cost
 * that matters more here than throughput: the average stays fine while one of
 * them stutters.
 */

/** Whose time a phase is. Attribution is by these, and nothing else. */
export const PhaseKind = Object.freeze({
    HOST: 'host',
    GUEST: 'guest',
    GPU: 'gpu',
    PRESENT: 'present',
});

/** @type {string[]} */
const KINDS = [PhaseKind.HOST, PhaseKind.GUEST, PhaseKind.GPU, PhaseKind.PRESENT];

/**
 * @typedef {Object} FrameRecord
 * @property {number} index
 * @property {number} startedAt
 * @property {number} ms                        Wall time of the whole frame.
 * @property {Record<string, number>} byKind    Self time per PhaseKind.
 * @property {number} hostShare                 `byKind.host / ms`, the watched metric.
 * @property {{ name: string, ms: number }} longest
 *     The single longest phase that ended inside the frame, whole: the one
 *     thing a freeze is made of, when it is made of one thing.
 * @property {{ ms: number, instructions: number }} longestGuest
 *     The longest guest slice in the frame, and how much it retired.
 * @property {number} waits      Turns the machine spent waiting for a fetch.
 * @property {number} compiles   Modules the emulator compiled during the frame.
 * @property {Record<string, number>} notes
 *     Whatever else the frame's owner counted into it -- instructions
 *     retired, instructions interpreted -- summed by name.
 */

/**
 * @typedef {Object} PhaseRow
 * @property {string} name
 * @property {string} kind
 * @property {number} count
 * @property {number} totalMs    Including everything nested inside it.
 * @property {number} selfMs     Excluding it: this is what attribution uses.
 * @property {number} worstMs    The worst single occurrence, measured whole.
 */

/** How many imbalances are described by name; the rest are only counted. */
const IMBALANCES_KEPT = 8;

/** @returns {FrameRecord} */
const blankFrame = ()=>({
    index: 0,
    startedAt: 0,
    ms: 0,
    byKind: { host: 0, guest: 0, gpu: 0, present: 0 },
    hostShare: 0,
    longest: { name: '', ms: 0 },
    longestGuest: { ms: 0, instructions: 0 },
    waits: 0,
    compiles: 0,
    notes: {},
});

/** A turn the machine spent waiting for something to arrive from outside. */
const isWait = (/** @type {string} */ name)=>name.startsWith('idle-') && name.endsWith('-wait');

/** @param {FrameRecord} frame */
const copyFrame = frame=>({
    ...frame,
    byKind: { ...frame.byKind },
    longest: { ...frame.longest },
    longestGuest: { ...frame.longestGuest },
    notes: { ...frame.notes },
});

/**
 * @param {Object} options
 * @param {() => number} options.now
 * @param {number} [options.frames]  Frames of history kept.
 * @returns {any}
 */
export function createProfiler(options){
    const now = options.now;
    const history = createRing(options.frames ?? 240, blankFrame);

    /**
     * The open phases, innermost last. Entries are reused by depth: a profiler
     * that allocates per phase cannot be left on in the build being measured.
     *
     * @type {{ name: string, kind: string, startedAt: number, children: number }[]}
     */
    const stack = [];
    let depth = 0;
    /** @type {Map<string, PhaseRow>} */
    const rows = new Map();
    /** @type {FrameRecord | null} */
    let open = null;
    let frameIndex = 0;
    let unbalanced = 0;
    /**
     * What each imbalance was, for the first few. A count alone says the
     * accounting is wrong somewhere; the name says where to look. Capped so a
     * loop that ends the wrong phase every turn cannot grow this without
     * bound, and empty in a healthy run, which is the only allocation-free
     * path that matters.
     *
     * @type {string[]}
     */
    const imbalances = [];
    /** @param {string} what */
    const noteImbalance = what=>{
        unbalanced++;
        if (imbalances.length < IMBALANCES_KEPT)
        {
            imbalances.push(what);
        }
    };

    /**
     * @param {number} [count]
     * @returns {FrameRecord[]} oldest first, copies.
     */
    const frames = (count = 240)=>{
        /** @type {FrameRecord[]} */
        const out = [];
        const from = Math.max(history.oldest(), history.written() - Math.max(0, count));
        history.each(from, frame=>{
            // The frame still being measured has no total yet; a partial row
            // would read as a suspiciously fast one.
            if (frame !== open)
            {
                out.push(copyFrame(frame));
            }
        });
        return out;
    };

    return {
        PhaseKind,

        /**
         * Opens a phase. `kind` says whose time it is; anything unrecognised is
         * ours, since a phase this layer cannot place is one of our own callers.
         *
         * @param {string} name
         * @param {string} [kind]
         */
        begin(name, kind = PhaseKind.HOST){
            let entry = stack[depth];
            if (!entry)
            {
                entry = { name: '', kind: '', startedAt: 0, children: 0 };
                stack[depth] = entry;
            }
            depth++;
            entry.name = name;
            entry.kind = KINDS.includes(kind) ? kind : PhaseKind.HOST;
            entry.children = 0;
            entry.startedAt = now();
        },

        /**
         * Closes the innermost open phase. Passing the name asks for the pairing
         * to be checked: a mismatch is counted rather than thrown, because a
         * profiler that takes the process down when the thing it measures is
         * already misbehaving has destroyed the evidence.
         *
         * @param {string} [name]
         * @param {{ instructions?: number, weight?: number }} [detail]
         *     What a guest slice retired; and how many phases this one stands
         *     for, when a caller times one in every few rather than each.
         * @returns {number} the phase's total duration
         */
        end(name, detail){
            if (depth === 0)
            {
                noteImbalance(`end(${name ?? ''}) at depth 0`);
                return 0;
            }
            depth--;
            const entry = stack[depth];
            if (name !== undefined && name !== entry.name)
            {
                noteImbalance(`end(${name}) while ${entry.name} open at depth ${depth + 1}`);
            }
            const weight = detail?.weight ?? 1;
            const elapsed = (now() - entry.startedAt) * weight;
            const self = elapsed - entry.children;
            if (depth > 0)
            {
                stack[depth - 1].children += elapsed;
            }

            let row = rows.get(entry.name);
            if (!row)
            {
                row = { name: entry.name, kind: entry.kind, count: 0, totalMs: 0, selfMs: 0,
                    worstMs: 0 };
                rows.set(entry.name, row);
            }
            row.count += weight;
            row.totalMs += elapsed;
            row.selfMs += self;
            if (elapsed > row.worstMs)
            {
                row.worstMs = elapsed;
            }
            if (open)
            {
                open.byKind[entry.kind] += self;
                if (elapsed > open.longest.ms)
                {
                    open.longest.name = entry.name;
                    open.longest.ms = elapsed;
                }
                if (entry.kind === PhaseKind.GUEST && elapsed > open.longestGuest.ms)
                {
                    open.longestGuest.ms = elapsed;
                    open.longestGuest.instructions = detail?.instructions ?? 0;
                }
                if (isWait(entry.name))
                {
                    open.waits++;
                }
            }
            return elapsed;
        },

        /**
         * Something the frame paid for that is not a phase of its own: a
         * module the emulator compiled inside a guest slice.
         *
         * @param {number} [count]
         */
        compiled(count = 1){
            if (open)
            {
                open.compiles += count;
            }
        },

        /**
         * A number the frame's owner counts into it, summed by name.
         *
         * @param {string} name @param {number} amount
         */
        note(name, amount){
            if (open)
            {
                open.notes[name] = (open.notes[name] ?? 0) + amount;
            }
        },

        beginFrame(){
            const slot = history.next();
            slot.index = frameIndex++;
            slot.startedAt = now();
            slot.ms = 0;
            slot.hostShare = 0;
            for (const kind of KINDS)
            {
                slot.byKind[kind] = 0;
            }
            slot.longest.name = '';
            slot.longest.ms = 0;
            slot.longestGuest.ms = 0;
            slot.longestGuest.instructions = 0;
            slot.waits = 0;
            slot.compiles = 0;
            slot.notes = {};
            open = slot;
        },

        /** @returns {FrameRecord | null} a copy; the slot itself gets reused. */
        endFrame(){
            if (!open)
            {
                noteImbalance('endFrame() with no frame open');
                return null;
            }
            const slot = open;
            open = null;
            slot.ms = now() - slot.startedAt;
            slot.hostShare = slot.ms > 0 ? slot.byKind.host / slot.ms : 0;
            return copyFrame(slot);
        },

        frames,

        /**
         * The table a reader actually looks at: every phase by self time, the
         * frames worth explaining, and the share the thresholds watch.
         *
         * @param {number} [worst] how many of the slowest frames to name
         * @returns {any}
         */
        snapshot(worst = 5){
            const recent = frames();
            let totalMs = 0;
            let hostMs = 0;
            for (const frame of recent)
            {
                totalMs += frame.ms;
                hostMs += frame.byKind.host;
            }
            return {
                frames: frameIndex,
                unbalanced,
                imbalances: imbalances.slice(),
                openPhases: depth,
                // Over the whole ring rather than the last frame: the threshold
                // is about sustained cost, and one frame is noise.
                hostShare: totalMs > 0 ? hostMs / totalMs : 0,
                averageFrameMs: recent.length > 0 ? totalMs / recent.length : 0,
                phases: [...rows.values()].sort((one, two)=>two.selfMs - one.selfMs),
                worstFrames: [...recent].sort((one, two)=>two.ms - one.ms).slice(0, worst),
                recentFrames: recent,
            };
        },
    };
}
