/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createRing } from './ring.js';

/** What a mirrored column reads from when no layer publishes its counter. */
const ABSENT = /* @__PURE__ */ new Float64Array(1);

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
 *
 * A caller may time one phase in every few and pass the few as a weight, and
 * the weight means one thing: an estimate of what all of them cost together.
 * It scales what is summed over a window -- a row's count, total and self
 * time, and the frame's `sampled` -- and nothing that describes one
 * occurrence: a row's worst, a frame's longest, and the frame's split by
 * kind are what the clock measured. A single crossing weighed as eight would
 * otherwise show as a freeze eight times longer than it was, and a frame
 * whose one sample outweighed it would report the guest at less than nothing.
 *
 * A phase timed only inside a timed occurrence of its parent -- work inside
 * a sampled crossing, timed when the crossing is -- stands for as many as its
 * parent does and passes `withParent`: its parent gives up the time it
 * measured once, since the parent's own weight already scales what is left.
 * Weighed again, the parent would give up the child's time twice over.
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
 * How a frame is laid out in the shared frame table, one row per frame: the
 * split by kind as measured and as estimated, the longest phase by name id,
 * and up to eight notes as (name id, amount) pairs. Names are dictionary
 * ids, which is what `intern` answers.
 */
export const NOTES_PER_FRAME = 8;

/**
 * @typedef {Object} MirroredCounter
 * @property {string} column   Its column in the frame table.
 * @property {string} layer    Whose counter row it is read from.
 * @property {string} counter  Its name in that row.
 */

/**
 * Counters of other layers that every frame's row keeps a copy of, so that a
 * frame can say why it was slow without a second run.
 *
 * These are the ones a stall is told apart by: whether the program did more
 * work, or whether we ran its instructions more slowly. They are cumulative
 * where they are written, and copied here as they stand when the frame
 * closes -- so the frame's own figure is the difference between its row and
 * the row before it, which is the reader's subtraction, not the engine's.
 * Nothing is computed on the engine's thread but a copy per column.
 *
 * @type {readonly MirroredCounter[]}
 */
export const FRAME_DELTAS = /* @__PURE__ */ Object.freeze([
    { column: 'retired', layer: 'cpu', counter: 'instructions' },
    { column: 'hostWrittenBytes', layer: 'cpu', counter: 'hostWrittenBytes' },
    { column: 'trapCrossings', layer: 'cpu', counter: 'trapCrossings' },
]);

/**
 * The same mirroring for figures that are already per frame where they are
 * written, and so are read as they stand rather than subtracted: which of the
 * program's threads the machine was spent on, how much it retired, and the
 * address the frame's heaviest slice began at, which names the module.
 *
 * @type {readonly MirroredCounter[]}
 */
export const FRAME_VALUES = /* @__PURE__ */ Object.freeze([
    { column: 'thread', layer: 'kernel', counter: 'frameThread' },
    { column: 'threadInstructions', layer: 'kernel', counter: 'frameThreadInstructions' },
    { column: 'threadAt', layer: 'kernel', counter: 'frameAt' },
    // The heaviest interpreted stretch of the frame and where it began, and
    // the host call that wrote most into guest memory during it. Both name
    // what a count on its own cannot: which code fell out of compiled code,
    // and which of our own calls is behind the bytes.
    { column: 'interpretedWorst', layer: 'cpu', counter: 'frameInterpreted' },
    { column: 'interpretedAt', layer: 'cpu', counter: 'frameInterpretedAt' },
    { column: 'writer', layer: 'memory', counter: 'frameWriter' },
    { column: 'writerBytes', layer: 'memory', counter: 'frameWriterBytes' },
]);

/** Every mirrored column, in the order a frame's row stores them. */
export const FRAME_MIRROR = /* @__PURE__ */ Object.freeze([...FRAME_DELTAS, ...FRAME_VALUES]);

// Built by one call the bundler is told is pure, so a production bundle, which
// makes no profiler, drops the table's layout with it.
export const FRAME_COLUMNS = /* @__PURE__ */ [
    'index', 'startedAt', 'ms',
    'host', 'guest', 'gpu', 'present',
    'sampledHost', 'sampledGuest', 'sampledGpu', 'sampledPresent',
    'hostShare', 'longest', 'longestMs', 'longestGuestMs', 'longestGuestInstructions',
    'waits', 'compiles', 'idleMs',
].concat(
    /* @__PURE__ */ FRAME_MIRROR.map(entry=>entry.column),
    /* @__PURE__ */ (/* @__PURE__ */ Array.from({ length: NOTES_PER_FRAME },
        (_, i)=>[`note${i}`, `amount${i}`])).flat(),
);
/** One row per phase name, kept up to date as phases close. */
export const PHASE_COLUMNS = ['name', 'kind', 'count', 'totalMs', 'selfMs', 'worstMs'];
export const PHASE_ROWS = 512;

/**
 * @typedef {Object} FrameRecord
 * @property {number} index
 * @property {number} startedAt
 * @property {number} ms                        Wall time of the whole frame.
 * @property {Record<string, number>} byKind
 *     Self time per PhaseKind, as measured: a weighted phase counts once here.
 * @property {Record<string, number>} sampled
 *     Per PhaseKind, what the phases that were not timed are estimated to
 *     have cost, from the ones that were: `(weight - 1)` times each weighted
 *     phase's self time. A window's share by kind is `byKind` plus this;
 *     one frame's is `byKind` alone, since an estimate can exceed a frame.
 * @property {number} hostShare                 `byKind.host / ms`, the watched metric.
 * @property {{ name: string, ms: number }} longest
 *     The single longest phase that ended inside the frame, whole: the one
 *     thing a freeze is made of, when it is made of one thing.
 * @property {{ ms: number, instructions: number }} longestGuest
 *     The longest guest slice in the frame, and how much it retired.
 * @property {number} waits      Turns the machine spent waiting for a fetch.
 * @property {number} compiles   Modules the translator instantiated during the frame.
 * @property {number} idleMs
 *     Of the frame, how long the machine had nothing of the program's to run
 *     and was parked on us -- a host call that had not answered, a fetch, an
 *     empty message queue. A frame long for this reason is not a frame the
 *     program or the engine was slow in, and nothing else told them apart.
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
 * @property {number} slot       Its row in the shared phase table, or -1.
 */

/** How many imbalances are described by name; the rest are only counted. */
const IMBALANCES_KEPT = 8;

/** @returns {FrameRecord} */
const blankFrame = ()=>({
    index: 0,
    startedAt: 0,
    ms: 0,
    byKind: { host: 0, guest: 0, gpu: 0, present: 0 },
    sampled: { host: 0, guest: 0, gpu: 0, present: 0 },
    hostShare: 0,
    longest: { name: '', ms: 0 },
    longestGuest: { ms: 0, instructions: 0 },
    waits: 0,
    compiles: 0,
    idleMs: 0,
    notes: {},
});

/** A turn the machine spent waiting for something to arrive from outside. */
const isWait = (/** @type {string} */ name)=>name.startsWith('idle-') && name.endsWith('-wait');

/** A turn the machine had nothing of the program's to run at all. */
const isIdle = (/** @type {string} */ name)=>name.startsWith('idle-');

/** @param {FrameRecord} frame */
const copyFrame = frame=>({
    ...frame,
    byKind: { ...frame.byKind },
    sampled: { ...frame.sampled },
    longest: { ...frame.longest },
    longestGuest: { ...frame.longestGuest },
    notes: { ...frame.notes },
});

/**
 * @param {Object} options
 * @param {() => number} options.now
 * @param {number} [options.frames]  Frames of history kept.
 * @param {{ frames: import('./table.js').TableWriter, phases: import('./table.js').TableWriter }}
 *     [options.tables]  Where each frame and each phase row is mirrored for a reader elsewhere.
 * @param {(text: string) => number} [options.intern]  Names as ids, for those tables.
 * @returns {any}
 */
export function createProfiler(options){
    const now = options.now;
    const history = createRing(options.frames ?? 240, blankFrame);
    const tables = options.tables ?? null;
    const intern = options.intern ?? (()=>-1);

    /**
     * Where each mirrored column is read from when a frame closes: one counter
     * row per column and the index in it. Resolved once by whoever assembles
     * the engine, because the layers that own those rows are created after
     * this one -- and a column nobody answers reads from a row of zeroes, so
     * the frame's layout never depends on which layers a build has.
     *
     * @type {Float64Array[]}
     */
    const mirrorRows = new Array(FRAME_MIRROR.length).fill(ABSENT);
    const mirrorAt = new Int32Array(FRAME_MIRROR.length);

    /**
     * The open phases, innermost last. Entries are reused by depth: a profiler
     * that allocates per phase cannot be left on in the build being measured.
     * `children` is what the nested phases measured; `weighed` is that with
     * their weights, which is what the parent's row gives up.
     *
     * @type {{ name: string, kind: string, startedAt: number, children: number,
     *          weighed: number }[]}
     */
    const stack = [];
    let depth = 0;
    /** @type {Map<string, PhaseRow>} */
    const rows = new Map();
    /** @type {FrameRecord | null} */
    let open = null;
    let frameIndex = 0;
    /**
     * The slowest frames of the whole run, slowest first: a freeze a minute ago
     * is gone from the ring of recent frames, and it is the one to explain.
     * @type {FrameRecord[]}
     */
    const slowest = [];
    const SLOWEST = 8;
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

    /**
     * One row of the shared frame table, stored once per frame: a few dozen
     * numbers, which is the whole cost of a reader elsewhere seeing frames.
     *
     * @param {FrameRecord} frame
     * @param {import('./table.js').TableWriter} table
     */
    const publishFrame = (frame, table)=>{
        const row = table.advance();
        let column = 0;
        const put = (/** @type {number} */ value)=>{ table.set(row, column++, value); };
        put(frame.index);
        put(frame.startedAt);
        put(frame.ms);
        for (const kind of KINDS)
        {
            put(frame.byKind[kind]);
        }
        for (const kind of KINDS)
        {
            put(frame.sampled[kind]);
        }
        put(frame.hostShare);
        put(intern(frame.longest.name));
        put(frame.longest.ms);
        put(frame.longestGuest.ms);
        put(frame.longestGuest.instructions);
        put(frame.waits);
        put(frame.compiles);
        put(frame.idleMs);
        // The counters other layers keep, as they stand now. A copy per
        // column and no more: the subtraction that turns them into this
        // frame's own figures is the reader's, on the reader's thread.
        for (let at = 0; at < mirrorRows.length; at++)
        {
            put(mirrorRows[at][mirrorAt[at]]);
        }
        let noted = 0;
        for (const name in frame.notes)
        {
            if (noted === NOTES_PER_FRAME)
            {
                break;
            }
            put(intern(name));
            put(frame.notes[name]);
            noted++;
        }
        for (; noted < NOTES_PER_FRAME; noted++)
        {
            put(-1);
            put(0);
        }
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
                entry = { name: '', kind: '', startedAt: 0, children: 0, weighed: 0 };
                stack[depth] = entry;
            }
            depth++;
            entry.name = name;
            entry.kind = KINDS.includes(kind) ? kind : PhaseKind.HOST;
            entry.children = 0;
            entry.weighed = 0;
            entry.startedAt = now();
        },

        /**
         * Closes the innermost open phase. Passing the name asks for the pairing
         * to be checked: a mismatch is counted rather than thrown, because a
         * profiler that takes the process down when the thing it measures is
         * already misbehaving has destroyed the evidence.
         *
         * @param {string} [name]
         * @param {{ instructions?: number, weight?: number, withParent?: boolean }} [detail]
         *     What a guest slice retired; and how many phases this one stands
         *     for, when a caller times one in every few rather than each --
         *     and whether it is timed exactly when its parent is, the parent
         *     carrying the same weight.
         * @returns {number} the phase's measured duration, unweighted
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
            const elapsed = now() - entry.startedAt;
            const self = elapsed - entry.children;
            const weighedSelf = (elapsed - entry.weighed) * weight;
            if (depth > 0)
            {
                stack[depth - 1].children += elapsed;
                stack[depth - 1].weighed += detail?.withParent === true
                    ? elapsed : elapsed * weight;
            }

            let row = rows.get(entry.name);
            if (!row)
            {
                const slot = tables && rows.size < tables.phases.rows ? rows.size : -1;
                row = { name: entry.name, kind: entry.kind, count: 0, totalMs: 0, selfMs: 0,
                    worstMs: 0, slot };
                rows.set(entry.name, row);
                if (tables && slot >= 0)
                {
                    tables.phases.set(slot, 0, intern(entry.name));
                    tables.phases.set(slot, 1, KINDS.indexOf(entry.kind));
                    tables.phases.used(rows.size);
                }
            }
            row.count += weight;
            row.totalMs += elapsed * weight;
            row.selfMs += weighedSelf;
            if (elapsed > row.worstMs)
            {
                row.worstMs = elapsed;
            }
            if (tables && row.slot >= 0)
            {
                tables.phases.set(row.slot, 2, row.count);
                tables.phases.set(row.slot, 3, row.totalMs);
                tables.phases.set(row.slot, 4, row.selfMs);
                tables.phases.set(row.slot, 5, row.worstMs);
            }
            if (open)
            {
                open.byKind[entry.kind] += self;
                open.sampled[entry.kind] += weighedSelf - self;
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
                if (isIdle(entry.name))
                {
                    open.idleMs += elapsed;
                    if (isWait(entry.name))
                    {
                        open.waits++;
                    }
                }
            }
            return elapsed;
        },

        /**
         * Something the frame paid for that is not a phase of its own: a
         * module the translator instantiated inside a guest slice.
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
         * Where a mirrored column is read from: the counter row that holds it
         * and the index in that row, in the order of `FRAME_MIRROR`. A null
         * source leaves the column reading zero.
         *
         * @param {(Float64Array | null)[]} sources
         * @param {number[]} indices
         */
        mirror(sources, indices){
            for (let at = 0; at < FRAME_MIRROR.length; at++)
            {
                const row = sources[at] ?? null;
                mirrorRows[at] = row ?? ABSENT;
                mirrorAt[at] = row ? indices[at] : 0;
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
                slot.sampled[kind] = 0;
            }
            slot.longest.name = '';
            slot.longest.ms = 0;
            slot.longestGuest.ms = 0;
            slot.longestGuest.instructions = 0;
            slot.waits = 0;
            slot.compiles = 0;
            slot.idleMs = 0;
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
            if (tables)
            {
                publishFrame(slot, tables.frames);
            }
            if (slowest.length < SLOWEST || slot.ms > slowest[slowest.length - 1].ms)
            {
                slowest.push(copyFrame(slot));
                slowest.sort((one, two)=>two.ms - one.ms);
                slowest.length = Math.min(slowest.length, SLOWEST);
            }
            return copyFrame(slot);
        },

        frames,

        /** Phases ended out of order or with none open, in total. */
        unbalanced: ()=>unbalanced,

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
            let guestMs = 0;
            for (const frame of recent)
            {
                totalMs += frame.ms;
                hostMs += frame.byKind.host + frame.sampled.host;
                // The untimed crossings ran inside the guest's slices and the
                // clock gave their time to the guest; `sampled` takes back
                // what the timed ones stand for, as it adds it to the host.
                guestMs += frame.byKind.guest + frame.sampled.guest;
            }
            return {
                frames: frameIndex,
                unbalanced,
                imbalances: imbalances.slice(),
                openPhases: depth,
                // Over the whole ring rather than the last frame: the threshold
                // is about sustained cost, and one frame is noise -- which is
                // also why the sampled estimate belongs here and not in a frame.
                hostShare: totalMs > 0 ? hostMs / totalMs : 0,
                averageFrameMs: recent.length > 0 ? totalMs / recent.length : 0,
                // The program's own code a frame, over the same frames: the
                // figure a translator is judged by, apart from a load's frames.
                averageGuestMs: recent.length > 0 ? guestMs / recent.length : 0,
                averageHostMs: recent.length > 0 ? hostMs / recent.length : 0,
                phases: [...rows.values()].sort((one, two)=>two.selfMs - one.selfMs),
                worstFrames: [...recent].sort((one, two)=>two.ms - one.ms).slice(0, worst),
                slowestFrames: slowest.map(copyFrame),
                recentFrames: recent,
            };
        },
    };
}
