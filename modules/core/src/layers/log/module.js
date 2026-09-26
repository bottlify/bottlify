/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { Level, createJournal, toLevel } from './internal/journal.js';
import {
    FRAME_COLUMNS, FRAME_MIRROR, PHASE_COLUMNS, PHASE_ROWS, PhaseKind, createProfiler,
} from './internal/profiler.js';
import { createMetrics } from './internal/metrics.js';

/**
 * log -- what the engine says about itself while it runs, and where its time
 * went.
 *
 * Two instruments over one kind of storage. The journal answers "what
 * happened", the profiler answers "how long did it take and whose time was it",
 * and both write into a ring of slots made once at startup, so that either can
 * be left on in a build that ships.
 *
 * This layer requires nothing and reaches for nothing. The clock is injected
 * because the engine has its own notion of time and a test needs a clock it can
 * step by hand; the sinks are injected because where a line ends up -- a
 * console, a collector, a transport out of the worker -- is the decision of
 * whoever assembles the engine, not of the thing being logged.
 *
 * Nothing the engine writes here is read back through the engine. The journal,
 * the frames, the phase rows and every layer's counters live in memory that
 * `memory()` hands out once, and a reader built over it -- on the page, in a
 * worker of its own -- reads and formats there. The calls that still answer
 * from this side (`recent`, `drain`, `frames`, `profile`) exist for the
 * thread that owns the engine and for the transition; each is a read of the
 * same memory, not a walk of anything else.
 */

/**
 * How many phases a diagnostics snapshot names.
 *
 * Enough that the run loop's own phases and the busiest host calls appear in
 * the same table: the question this instrument answers is which of the two the
 * time went to, and a list too short to hold both cannot answer it.
 */
const TOP_PHASES = 16;

/** The layer's own counters, in the order they are published. */
const REJECTED = 0;
const UNBALANCED = 1;

/** The log layer's module for one graph; see `defaultModules`. */
export function createLogModule(){
    /**
     * The instance this module object made last, for `diagnostics()` and
     * `dispose()`. Every graph is given module objects of its own
     * (`defaultModules`), so a child's graph built beside its parent's has
     * its own and neither one's going reaches the other's.
     *
     * The module contract puts both on the module rather than on the api, so
     * something outside a `create()` call has to be able to see in. That is
     * the only reason this exists, and it holds a reference rather than the
     * state itself -- the journal belongs to the closure `create()` returns,
     * so a second instance in one realm cannot take the first one's ring.
     * Disposing marks the instance closed, so a call still in flight when the
     * machine went away answers nothing instead of dereferencing what is
     * gone.
     *
     * @type {any}
     */
    let current = null;

    return {
        name: 'log',
        version: '0.1.0',
        requires: /** @type {readonly string[]} */ ([]),

        /**
         * @param {any} config
         * @returns {Promise<any>}
         */
        async create(config){
            /**
             * Everything this instance owns, and whether it is still open.
             *
             * The calls an api hands out close over this object rather than over
             * module-level bindings, because `create()` may run more than once in
             * one realm -- a process replacement does, and the plan for more than
             * one machine in a worker needs two at once -- so each run keeps its
             * own ring.
             *
             * @type {{ journal: any, profiler: any, issues: string[], disposed: boolean }}
             */
            const state = {
                journal: null,
                profiler: null,
                issues: [],
                disposed: false,
            };
            let now = config?.now;
            if (typeof now !== 'function')
            {
                // Rather than reaching for a clock this layer is not allowed to
                // know about. Every duration then reads as zero, which is visible
                // and reported, instead of plausible and wrong.
                now = ()=>0;
                state.issues.push(
                    'No clock was configured: timestamps and durations are all zero.');
            }

            /** @type {Record<string, number>} */
            const categories = {};
            for (const [name, level] of Object.entries(config?.categories ?? {}))
            {
                categories[name] = toLevel(level);
            }

            const journal = createJournal({
                now,
                capacity: config?.capacity,
                bytes: config?.bytes,
                dictionary: config?.dictionary,
                shared: config?.shared,
                level: config?.level === undefined ? undefined : toLevel(config.level),
                categories,
                sequenceBase: config?.sequenceBase,
            });
            state.journal = journal;
            const registry = createMetrics({ shared: config?.shared });
            const own = registry.counters('log', ['rejected', 'unbalancedPhases']);
            const tables = {
                frames: registry.table('log', 'frames',
                    { rows: config?.frames ?? 240, columns: FRAME_COLUMNS }),
                phases: registry.table('log', 'phases',
                    { rows: PHASE_ROWS, columns: PHASE_COLUMNS }),
            };
            // The profiler is given the *host's* clock, not the guest's.
            //
            // A journal entry is stamped with guest time, because that is the time
            // the program itself would quote. A phase is measured to answer how
            // long something took us, and the guest's clock is credited in lumps
            // from wall time as the scheduler runs -- so measuring against it says
            // a slice took whatever the guest was credited, not what it cost. Read
            // that way, a run of ten minutes reports sixty-eight milliseconds.
            // `performance.now` where there is one, because `Date.now` moves in
            // whole milliseconds: a phase entered tens of thousands of times reads
            // as a column of zeroes and ones, which is a distribution rather than a
            // measurement, and the short phases are exactly the ones it ruins.
            const profiler = createProfiler({
                now: config?.wallClock ?? (typeof performance === 'undefined'
                    ? ()=>Date.now()
                    : ()=>performance.now()),
                frames: config?.frames,
                tables,
                intern: journal.intern,
            });
            state.profiler = profiler;
            registry.onFrame(()=>{
                own[REJECTED] = journal.rejected();
                own[UNBALANCED] = profiler.unbalanced();
            });

            /**
             * Where each of a frame's mirrored columns is read from. Resolved at
             * the first frame rather than here: the layers whose counters a frame
             * carries are created after this one, so there is nothing to find yet.
             * A column no layer answers is reported and reads as zero, rather
             * than changing the row's layout under the reader.
             */
            let mirrored = false;
            const resolveMirror = ()=>{
                mirrored = true;
                /** @type {(Float64Array | null)[]} */
                const rows = [];
                /** @type {number[]} */
                const indices = [];
                for (const entry of FRAME_MIRROR)
                {
                    const table = registry.find(entry.layer, 'counters');
                    const index = table ? table.describe().columns.indexOf(entry.counter) : -1;
                    rows.push(index >= 0 && table ? table.values : null);
                    indices.push(index >= 0 ? index : 0);
                    if (index < 0)
                    {
                        state.issues.push(`No ${entry.layer} counter named "${entry.counter}":`
                            + ` every frame reports ${entry.column} as zero.`);
                    }
                }
                profiler.mirror(rows, indices);
            };

            for (const sink of config?.sinks ?? [])
            {
                journal.addSink(sink);
            }

            /**
             * Whether this instance is still open. A call that was in flight when
             * the machine was disposed must not find the journal gone: the contract
             * of a writer that never waits and never throws holds after disposal
             * too, so every call answers empty rather than dereferencing what is
             * gone.
             */
            const live = ()=>!state.disposed;

            /**
             * @param {number} level
             * @returns {(category: string, message: string,
             *            a?: any, b?: any, c?: any, d?: any) => void}
             */
            const at = level=>(category, message, a, b, c, d)=>{
                if (!live())
                {
                    return;
                }
                journal.write(level, category, message, a, b, c, d);
            };

            current = state;
            return {
                Level,
                PhaseKind,

                error: at(Level.ERROR),
                warn: at(Level.WARN),
                info: at(Level.INFO),
                debug: at(Level.DEBUG),
                trace: at(Level.TRACE),

                /**
                 * @param {number} level @param {string} category @param {string} message
                 * @param {any} [a] @param {any} [b] @param {any} [c] @param {any} [d]
                 */
                write: (level, category, message, a, b, c, d)=>{
                    if (!live())
                    {
                        return;
                    }
                    journal.write(level, category, message, a, b, c, d);
                },

                /** @param {string} category @param {number} level */
                enabled: (category, level)=>live() && journal.enabled(category, level),
                /** Moves with every level change: an `enabled` answer holds until it does. */
                revision: ()=>(live() ? journal.revision() : -1),
                /** @param {string} category @param {unknown} level */
                setLevel: (category, level)=>{
                    if (live())
                    {
                        journal.setLevel(category, toLevel(level));
                    }
                },
                /** @param {unknown} level */
                setDefaultLevel: level=>{
                    if (live())
                    {
                        journal.setDefaultLevel(toLevel(level));
                    }
                },
                /** @param {string} category */
                levelOf: category=>live() ? journal.levelOf(category) : Level.OFF,

                /** @param {(records: any[]) => void} sink @returns {() => void} removes it */
                addSink: sink=>live() ? journal.addSink(sink) : (()=>{}),
                flush: ()=>live() ? journal.flush() : 0,
                /** @param {number} [count] */
                recent: count=>live() ? journal.recent(count) : [],
                /** @param {string} text @returns {number} its id in the journal's dictionary */
                intern: text=>live() ? journal.intern(text) : -1,

                /**
                 * Where the layers publish their figures, and what a reader
                 * elsewhere needs to find them. A layer registers at create and
                 * writes in place from then on.
                 */
                metrics: registry,

                /**
                 * Everything a reader elsewhere is built over: the journal's block
                 * and every layer's tables. Made once, after every layer has
                 * registered, and handed across a thread boundary as it is.
                 *
                 * @returns {import('./internal/reader.js').LogMemory}
                 */
                memory: ()=>({ journal: journal.memory(), tables: registry.describe() }),
                /**
                 * @param {number} [since] @param {number} [limit]
                 * @returns {any}
                 */
                drain: (since, limit)=>live()
                    ? journal.drain(since, limit)
                    : { records: [], from: 0, next: 0, lost: 0 },
                templates: ()=>live() ? journal.templates() : [],

                /** @param {string} name @param {string} [kind] */
                begin: (name, kind)=>{
                    if (live())
                    {
                        profiler.begin(name, kind);
                    }
                },
                /**
                 * @param {string} [name] @param {{ instructions?: number }} [detail]
                 * @returns {number} the phase's duration
                 */
                end: (name, detail)=>live() ? profiler.end(name, detail) : 0,
                /** @param {number} [count] */
                compiled: count=>{
                    if (live())
                    {
                        profiler.compiled(count);
                    }
                },
                /** @param {string} name @param {number} amount */
                note: (name, amount)=>{
                    if (live())
                    {
                        profiler.note(name, amount);
                    }
                },
                beginFrame: ()=>{
                    if (live())
                    {
                        profiler.beginFrame();
                    }
                },
                // The one moment on the engine thread when figures nobody keeps
                // as they run are copied into their tables -- before the frame's
                // own row is written, so that the row carries the counters as they
                // stand at its close rather than as they stood at the one before.
                endFrame: ()=>{
                    if (!live())
                    {
                        return null;
                    }
                    registry.sample();
                    if (!mirrored)
                    {
                        resolveMirror();
                    }
                    return profiler.endFrame();
                },
                /** @param {number} [count] */
                frames: count=>live() ? profiler.frames(count) : [],
                /** @param {number} [worst] */
                profile: worst=>live() ? profiler.snapshot(worst) : {
                    frames: 0,
                    unbalanced: 0,
                    imbalances: [],
                    openPhases: 0,
                    hostShare: 0,
                    averageFrameMs: 0,
                    averageGuestMs: 0,
                    averageHostMs: 0,
                    phases: [],
                    worstFrames: [],
                    slowestFrames: [],
                    recentFrames: [],
                },
            };
        },

        /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
        diagnostics(){
            const instance = current;
            if (!instance || instance.disposed)
            {
                return { name: 'log', version: '0.1.0', status: 'created', metrics: {} };
            }
            const profile = instance.profiler.snapshot(3);
            return {
                name: 'log',
                version: '0.1.0',
                status: 'ready',
                metrics: {
                    journal: instance.journal.diagnostics(),
                    // The share the thresholds watch, kept where a snapshot will
                    // find it without anyone having to ask for a profile.
                    hostShare: profile.hostShare,
                    frames: profile.frames,
                    averageFrameMs: profile.averageFrameMs,
                    averageGuestMs: profile.averageGuestMs,
                    averageHostMs: profile.averageHostMs,
                    unbalancedPhases: profile.unbalanced,
                    // Which ones, for the first few: a count says the accounting is
                    // wrong somewhere, a name says where.
                    imbalances: profile.imbalances,
                    // The run's slowest frames, each with what held it longest: what
                    // a freeze was made of, long after the ring of recent frames
                    // has moved past it.
                    slowFrames: profile.slowestFrames.map((/** @type {any} */ frame)=>
                        `#${frame.index} ${frame.ms.toFixed(0)}ms`
                        + ` host=${frame.byKind.host.toFixed(0)}`
                        + ` guest=${frame.byKind.guest.toFixed(0)}`
                        + ` longest=${frame.longest.name}:${frame.longest.ms.toFixed(0)}`
                        + ` slice=${frame.longestGuest.ms.toFixed(0)}ms`
                        + `/${frame.longestGuest.instructions}`),
                    topPhases: profile.phases.slice(0, TOP_PHASES).map((/** @type {any} */ row)=>
                        `${row.name} ${row.kind} x${row.count} self=${row.selfMs.toFixed(3)}`
                        + ` worst=${row.worstMs.toFixed(3)}`),
                },
                issues: [...instance.issues],
            };
        },

        async dispose(){
            if (current)
            {
                current.disposed = true;
            }
            current = null;
        },
    };
}

/** One graph's worth, for the boundary check and for a test that builds this layer alone. */
export const logModule = createLogModule();
