/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { Level, createJournal, toLevel } from './internal/journal.js';
import { PhaseKind, createProfiler } from './internal/profiler.js';

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
 */

/**
 * How many phases a diagnostics snapshot names.
 *
 * Enough that the run loop's own phases and the busiest host calls appear in
 * the same table: the question this instrument answers is which of the two the
 * time went to, and a list too short to hold both cannot answer it.
 */
const TOP_PHASES = 16;

/** @type {any} */
let journal = null;
/** @type {any} */
let profiler = null;
/** @type {string[]} */
let issues = [];

export const logModule = {
    name: 'log',
    version: '0.1.0',
    requires: /** @type {readonly string[]} */ ([]),

    /**
     * @param {any} config
     * @returns {Promise<any>}
     */
    async create(config){
        issues = [];
        let now = config?.now;
        if (typeof now !== 'function')
        {
            // Rather than reaching for a clock this layer is not allowed to
            // know about. Every duration then reads as zero, which is visible
            // and reported, instead of plausible and wrong.
            now = ()=>0;
            issues.push('No clock was configured: timestamps and durations are all zero.');
        }

        /** @type {Record<string, number>} */
        const categories = {};
        for (const [name, level] of Object.entries(config?.categories ?? {}))
        {
            categories[name] = toLevel(level);
        }

        journal = createJournal({
            now,
            capacity: config?.capacity,
            level: config?.level === undefined ? undefined : toLevel(config.level),
            categories,
        });
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
        profiler = createProfiler({
            now: config?.wallClock ?? (typeof performance === 'undefined'
                ? ()=>Date.now()
                : ()=>performance.now()),
            frames: config?.frames,
        });

        for (const sink of config?.sinks ?? [])
        {
            journal.addSink(sink);
        }

        /**
         * @param {number} level
         * @returns {(category: string, message: string,
         *            a?: any, b?: any, c?: any, d?: any) => void}
         */
        const at = level=>(category, message, a, b, c, d)=>
            journal.write(level, category, message, a, b, c, d);

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
            write: (level, category, message, a, b, c, d)=>
                journal.write(level, category, message, a, b, c, d),

            /** @param {string} category @param {number} level */
            enabled: (category, level)=>journal.enabled(category, level),
            /** @param {string} category @param {unknown} level */
            setLevel: (category, level)=>journal.setLevel(category, toLevel(level)),
            /** @param {unknown} level */
            setDefaultLevel: level=>journal.setDefaultLevel(toLevel(level)),
            /** @param {string} category */
            levelOf: category=>journal.levelOf(category),

            /** @param {(records: any[]) => void} sink @returns {() => void} removes it */
            addSink: sink=>journal.addSink(sink),
            flush: ()=>journal.flush(),
            /** @param {number} [count] */
            recent: count=>journal.recent(count),
            /**
             * @param {number} [since] @param {number} [limit]
             * @returns {any}
             */
            drain: (since, limit)=>journal.drain(since, limit),
            templates: ()=>journal.templates(),

            /** @param {string} name @param {string} [kind] */
            begin: (name, kind)=>profiler.begin(name, kind),
            /** @param {string} [name] @returns {number} the phase's duration */
            end: name=>profiler.end(name),
            beginFrame: ()=>profiler.beginFrame(),
            endFrame: ()=>profiler.endFrame(),
            /** @param {number} [count] */
            frames: count=>profiler.frames(count),
            /** @param {number} [worst] */
            profile: worst=>profiler.snapshot(worst),
        };
    },

    /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
    diagnostics(){
        if (!journal)
        {
            return { name: 'log', version: '0.1.0', status: 'created', metrics: {} };
        }
        const profile = profiler.snapshot(3);
        return {
            name: 'log',
            version: '0.1.0',
            status: 'ready',
            metrics: {
                journal: journal.diagnostics(),
                // The share the thresholds watch, kept where a snapshot will
                // find it without anyone having to ask for a profile.
                hostShare: profile.hostShare,
                frames: profile.frames,
                averageFrameMs: profile.averageFrameMs,
                unbalancedPhases: profile.unbalanced,
                // Which ones, for the first few: a count says the accounting is
                // wrong somewhere, a name says where.
                imbalances: profile.imbalances,
                topPhases: profile.phases.slice(0, TOP_PHASES).map((/** @type {any} */ row)=>
                    `${row.name} ${row.kind} x${row.count} self=${row.selfMs.toFixed(3)}`
                    + ` worst=${row.worstMs.toFixed(3)}`),
            },
            issues: [...issues],
        };
    },

    async dispose(){
        journal = null;
        profiler = null;
        issues = [];
    },
};
