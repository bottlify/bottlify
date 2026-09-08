/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createRing } from './ring.js';

/**
 * The journal: levels, categories, a ring of recent entries, and sinks.
 *
 * Written so that leaving it on in a shipping build costs nothing worth
 * measuring. A call that its category's level rejects is one map lookup and a
 * comparison. A call that is kept writes into a slot that already exists and
 * stores its arguments as they were passed -- no array, no interpolated string,
 * no object. The message stays a template until something asks to read it, and
 * only a reader pays for formatting.
 *
 * Sinks come from whoever assembles the engine. This layer never picks one, and
 * never writes anywhere by itself: with no sink at all the ring still holds the
 * recent past, which is what a crash snapshot wants.
 */

/** Severity, most severe first. A category's level is the least severe it keeps. */
export const Level = Object.freeze({
    OFF: 0,
    ERROR: 1,
    WARN: 2,
    INFO: 3,
    DEBUG: 4,
    TRACE: 5,
});

/** @type {Record<number, string>} */
const LEVEL_NAMES = {
    1: 'error',
    2: 'warn',
    3: 'info',
    4: 'debug',
    5: 'trace',
};

/**
 * A level as configuration writes it. Data has to survive being serialized, so
 * `"debug"` is as valid as `Level.DEBUG`, and an unrecognised value is a
 * configuration error rather than a silently quiet category.
 *
 * @param {unknown} value
 * @returns {number}
 */
export function toLevel(value){
    if (typeof value === 'number' && value >= Level.OFF && value <= Level.TRACE)
    {
        return value;
    }
    if (typeof value === 'string')
    {
        const found = Object.entries(Level).find(([name])=>name === value.toUpperCase());
        if (found)
        {
            return found[1];
        }
    }
    throw new Error(`"${String(value)}" is not a log level`);
}

/**
 * How many arguments a record carries. Fixed, and passed as separate
 * parameters rather than as a rest list, because a rest list allocates an array
 * on every call -- including the calls that turn out to be worth keeping.
 */
const ARGS = 4;

/** `{0}` names an argument, `{0:x}` asks for it as hex. */
const FIELD = /\{(\d+)(:x)?\}/g;

/**
 * @typedef {Object} LogRecord
 * @property {number} sequence   Monotonic; ordering never depends on the clock.
 * @property {number} time       Whatever the injected clock returned.
 * @property {number} level
 * @property {string} category
 * @property {string} message    The template, uninterpolated.
 * @property {number} argc
 * @property {any[]} args        Opaque to this layer: exactly what was passed.
 */

/**
 * @typedef {Object} FormattedRecord
 * @property {number} sequence
 * @property {number} time
 * @property {number} level
 * @property {string} levelName
 * @property {string} category
 * @property {string} message
 * @property {any[]} args
 * @property {string} text
 */

/**
 * @param {any} value
 * @param {boolean} hex
 * @returns {string}
 */
function render(value, hex){
    if (hex && typeof value === 'number')
    {
        return `0x${(value >>> 0).toString(16)}`;
    }
    return String(value);
}

/**
 * Interpolates a record's template. Arguments the template does not name are
 * appended, so a message that outgrew its placeholders still shows its values
 * instead of dropping them.
 *
 * @param {LogRecord} record
 * @returns {string}
 */
export function format(record){
    const used = [false, false, false, false];
    let text = record.message.replace(FIELD, (whole, index, spec)=>{
        const at = Number(index);
        if (at >= record.argc)
        {
            return whole;
        }
        used[at] = true;
        return render(record.args[at], spec === ':x');
    });
    for (let at = 0; at < record.argc; at++)
    {
        if (!used[at])
        {
            text += ` ${render(record.args[at], false)}`;
        }
    }
    return text;
}

/** @returns {LogRecord} */
const blankRecord = ()=>({
    sequence: 0,
    time: 0,
    level: 0,
    category: '',
    message: '',
    argc: 0,
    args: new Array(ARGS).fill(null),
});

/**
 * @param {LogRecord} record
 * @returns {FormattedRecord}
 */
function detach(record){
    return {
        sequence: record.sequence,
        time: record.time,
        level: record.level,
        levelName: LEVEL_NAMES[record.level] ?? String(record.level),
        category: record.category,
        message: record.message,
        args: record.args.slice(0, record.argc),
        text: format(record),
    };
}

/**
 * @param {Object} options
 * @param {() => number} options.now
 * @param {number} [options.capacity]   Records held before the oldest is lapped.
 * @param {number} [options.level]      The level of a category nobody set.
 * @param {Record<string, number>} [options.categories]  Per-category levels.
 * @returns {any}
 */
export function createJournal(options){
    const now = options.now;
    const ring = createRing(options.capacity ?? 4096, blankRecord);

    /** @type {Map<string, number>} */
    const levels = new Map(Object.entries(options.categories ?? {}));
    let fallback = options.level ?? Level.INFO;
    /** @type {Map<string, { message: string, category: string, level: number, count: number }>} */
    const templates = new Map();
    /** @type {((records: FormattedRecord[]) => void)[]} */
    const sinks = [];
    let delivered = 0;
    let lost = 0;
    let rejected = 0;

    const levelOf = (/** @type {string} */ category)=>levels.get(category) ?? fallback;

    return {
        Level,

        /** @param {string} category @param {number} level */
        setLevel(category, level){
            levels.set(category, level);
        },

        /** @param {number} level The level of every category nobody set explicitly. */
        setDefaultLevel(level){
            fallback = level;
        },

        levelOf,

        /**
         * Whether a call would be kept. Worth asking only around work done
         * solely to produce the arguments; the write itself checks anyway.
         *
         * @param {string} category @param {number} level
         */
        enabled: (category, level)=>level !== Level.OFF && level <= levelOf(category),

        /**
         * @param {number} level
         * @param {string} category
         * @param {string} message  A template. Constant, not built at the call site.
         * @param {any} [a] @param {any} [b] @param {any} [c] @param {any} [d]
         */
        write(level, category, message, a, b, c, d){
            if (level === Level.OFF || level > (levels.get(category) ?? fallback))
            {
                rejected++;
                return;
            }
            const record = ring.next();
            record.sequence = ring.written() - 1;
            record.time = now();
            record.level = level;
            record.category = category;
            record.message = message;
            record.args[0] = a;
            record.args[1] = b;
            record.args[2] = c;
            record.args[3] = d;
            record.argc = d !== undefined ? 4
                : c !== undefined ? 3
                    : b !== undefined ? 2
                        : a !== undefined ? 1 : 0;

            // A summary by template, because a megabyte of lines does not grep:
            // the count of a template is usually the answer, and the first sight
            // of one is the only call here that allocates.
            const summary = templates.get(message);
            if (summary)
            {
                summary.count++;
            }
            else
            {
                templates.set(message, { message, category, level, count: 1 });
            }
        },

        /** @param {(records: FormattedRecord[]) => void} sink @returns {() => void} */
        addSink(sink){
            sinks.push(sink);
            return ()=>{
                const at = sinks.indexOf(sink);
                if (at >= 0)
                {
                    sinks.splice(at, 1);
                }
            };
        },

        /**
         * Hands everything written since the last flush to the sinks, as
         * detached copies -- a sink that keeps what it is given must not be
         * holding a slot the next write laps.
         *
         * Explicit rather than immediate: a sink is I/O, and doing I/O inside a
         * guest call is how a log turns into the thing being measured.
         *
         * @returns {number} how many records were delivered
         */
        flush(){
            lost += Math.max(0, ring.oldest() - delivered);
            const from = delivered;
            delivered = ring.written();
            if (sinks.length === 0)
            {
                return 0;
            }
            /** @type {FormattedRecord[]} */
            const batch = [];
            ring.each(from, record=>batch.push(detach(record)));
            if (batch.length > 0)
            {
                for (const sink of sinks)
                {
                    sink(batch);
                }
            }
            return batch.length;
        },

        /**
         * The tail of the ring, formatted. This is what goes into a snapshot of
         * an abnormal situation, and it does not disturb the flush position.
         *
         * @param {number} [count]
         * @returns {FormattedRecord[]}
         */
        recent(count = 100){
            const from = Math.max(ring.oldest(), ring.written() - Math.max(0, count));
            /** @type {FormattedRecord[]} */
            const out = [];
            ring.each(from, record=>out.push(detach(record)));
            return out;
        },

        /**
         * Everything written since `from`, with where to resume.
         *
         * The read a live view wants, as against `recent`: a terminal showing a
         * running process asks again and again, and asking for "the last two
         * hundred" each time either repeats what it already drew or misses what
         * happened in between. The sequence is monotonic and does not depend on
         * the clock, so resuming from the number this returns is exact.
         *
         * A caller that has fallen further behind than the ring is deep gets
         * what survives, and `from` in the answer says where that actually
         * starts -- a gap is reported rather than papered over.
         *
         * @param {number} [since]  The `next` of the previous read; 0 to start.
         * @param {number} [limit]  At most this many records.
         * @returns {{ records: FormattedRecord[], from: number, next: number,
         *             lost: number }}
         */
        drain(since = 0, limit = 1000){
            const start = Math.max(since, ring.oldest());
            const end = Math.min(ring.written(), start + Math.max(0, limit));
            /** @type {FormattedRecord[]} */
            const records = [];
            ring.each(start, (record, sequence)=>{
                if (sequence < end)
                {
                    records.push(detach(record));
                }
            });
            return { records, from: start, next: end, lost };
        },

        /** @returns {{ message: string, category: string, level: number, count: number }[]} */
        templates: ()=>[...templates.values()].sort((one, two)=>two.count - one.count),

        diagnostics(){
            return {
                capacity: ring.capacity,
                written: ring.written(),
                // Records lapped before a sink saw them: the honest answer to
                // "why is there a gap", rather than a silently shorter log.
                lost,
                rejected,
                sinks: sinks.length,
                defaultLevel: fallback,
                categories: Object.fromEntries(levels),
                templates: templates.size,
            };
        },
    };
}
