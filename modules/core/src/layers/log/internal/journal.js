/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import {
    createJournalCursor, createJournalMemory, createJournalWriter, INLINE_TEMPLATE,
} from './shared-journal.js';

/**
 * The journal: levels, categories, a ring of recent entries in memory any
 * thread can read, and sinks for the thread that owns this one.
 *
 * Written so that leaving it on in a shipping build costs nothing worth
 * measuring. A call that its category's level rejects is one map lookup and a
 * comparison. A call that is kept encodes its arguments into a ring that
 * already exists -- a number as a number, a string as its code units, the
 * template and the category as the id each was given the first time it was
 * seen -- and nothing here waits for a reader. The message stays a template
 * until something asks to read it, and only a reader pays for formatting,
 * wherever that reader is.
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

/** @param {number} level */
export const levelName = level=>LEVEL_NAMES[level] ?? String(level);

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

/** How often a drain reader's lap is written into the log, at most. */
const WARN_EVERY_MS = 1000;

/** `{0}` names an argument, `{0:x}` asks for it as hex. */
const FIELD = /\{(\d+)(:x)?\}/g;

/**
 * A category the dictionary had no room to name. Its records still travel;
 * a reader sees the id and knows it was never given a word.
 */
const UNNAMED_TOPIC = 0xffff;

/**
 * @typedef {Object} FormattedRecord
 * @property {number} sequence
 * @property {number} time
 * @property {number} level
 * @property {string} levelName
 * @property {string} category
 * @property {string} message    The template, uninterpolated.
 * @property {(number | string)[]} args
 * @property {string} text
 */

/**
 * @param {number | string} value
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
 * Interpolates a template. Arguments the template does not name are appended,
 * so a message that outgrew its placeholders still shows its values instead
 * of dropping them.
 *
 * @param {string} message
 * @param {(number | string)[]} args
 * @returns {string}
 */
export function formatText(message, args){
    const used = [false, false, false, false];
    let text = message.replace(FIELD, (whole, index, spec)=>{
        const at = Number(index);
        if (at >= args.length)
        {
            return whole;
        }
        used[at] = true;
        return render(args[at], spec === ':x');
    });
    for (let at = 0; at < args.length; at++)
    {
        if (!used[at])
        {
            text += ` ${render(args[at], false)}`;
        }
    }
    return text;
}

/**
 * @param {Object} options
 * @param {() => number} options.now
 * @param {number} [options.capacity]   Records held before the oldest is lapped.
 * @param {number} [options.bytes]      Bytes of record storage behind them.
 * @param {number} [options.dictionary] Bytes for the words records refer to.
 * @param {boolean} [options.shared]    Shared memory when the platform has it.
 * @param {number} [options.level]      The level of a category nobody set.
 * @param {Record<string, number>} [options.categories]  Per-category levels.
 * @param {number} [options.sequenceBase]  The sequence the first record gets.
 * @returns {any}
 */
export function createJournal(options){
    const now = options.now;
    const memory = createJournalMemory({
        records: options.capacity ?? 4096,
        bytes: options.bytes,
        dictionary: options.dictionary,
        shared: options.shared,
        sequenceBase: options.sequenceBase,
    });
    const writer = createJournalWriter(memory);
    // This thread's own reader, for the sinks and the calls that still ask
    // the engine directly. It costs nothing until one of them is made.
    const cursor = createJournalCursor(memory);

    /** @type {Map<string, number>} */
    const levels = new Map(Object.entries(options.categories ?? {}));
    let fallback = options.level ?? Level.INFO;
    let revision = 0;
    /** @type {Map<string, number>} */
    const topics = new Map();
    /** @type {Map<string, { message: string, category: string, level: number, count: number }>} */
    const templates = new Map();
    /** @type {((records: FormattedRecord[]) => void)[]} */
    const sinks = [];
    // The first flush delivers from where this block begins, which is not zero
    // when it continued a journal whose reader is still holding a cursor.
    let delivered = memory.sequenceBase ?? 0;
    let lost = 0;
    let rejected = 0;
    /**
     * Records a drain reader was lapped past and has not yet been told about
     * in the log itself, and when it was last told. The figure in each
     * answer is exact; the line is for whoever reads the log without one.
     */
    let unreported = 0;
    let warnedAt = -Infinity;

    const levelOf = (/** @type {string} */ category)=>levels.get(category) ?? fallback;

    /** @param {string} category */
    const topicOf = category=>{
        let id = topics.get(category);
        if (id === undefined)
        {
            const given = writer.intern(category);
            id = given < 0 || given > UNNAMED_TOPIC ? UNNAMED_TOPIC : given;
            topics.set(category, id);
        }
        return id;
    };

    /**
     * @param {import('./shared-journal.js').DecodedRecord} record
     * @returns {FormattedRecord}
     */
    const detach = record=>{
        const message = record.template === INLINE_TEMPLATE
            ? record.inline
            : cursor.word(record.template);
        return {
            sequence: record.sequence,
            time: record.time,
            level: record.level,
            levelName: levelName(record.level),
            category: cursor.word(record.topic),
            message,
            args: record.args,
            text: formatText(message, record.args),
        };
    };

    /**
     * @param {number} from @param {number} to
     * @returns {FormattedRecord[]}
     */
    const collect = (from, to)=>{
        /** @type {FormattedRecord[]} */
        const out = [];
        for (let sequence = from; sequence < to; sequence++)
        {
            const record = cursor.read(sequence);
            if (record)
            {
                out.push(detach(record));
            }
        }
        return out;
    };

    /** The category with the most records in the ring: whose flood this is. */
    const floodingCategory = ()=>{
        /** @type {Map<string, number>} */
        const counts = new Map();
        for (const record of collect(cursor.oldest(), cursor.written()))
        {
            counts.set(record.category, (counts.get(record.category) ?? 0) + 1);
        }
        let most = '';
        let mostCount = 0;
        for (const [category, count] of counts)
        {
            if (count > mostCount)
            {
                most = category;
                mostCount = count;
            }
        }
        return most;
    };

    const journal = {
        Level,

        /** The block the records live in, for whoever reads them elsewhere. */
        memory: ()=>memory.buffer,

        /**
         * The id a word is known by in the block, for a table that wants to
         * name something -- a thread, a region, a phase -- by number.
         *
         * @param {string} text
         * @returns {number} -1 when there is no room left
         */
        intern: text=>writer.intern(text),

        /** @param {string} category @param {number} level */
        setLevel(category, level){
            levels.set(category, level);
            revision++;
        },

        /** @param {number} level The level of every category nobody set explicitly. */
        setDefaultLevel(level){
            fallback = level;
            revision++;
        },

        /**
         * Bumped by every level change, so a caller asking `enabled` for the
         * same category on every host call can keep the answer until it moves.
         */
        revision: ()=>revision,

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
            const argc = d !== undefined ? 4
                : c !== undefined ? 3
                    : b !== undefined ? 2
                        : a !== undefined ? 1 : 0;
            writer.write(now(), level, topicOf(category), message, argc, a, b, c, d);

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
            lost += Math.max(0, cursor.oldest() - delivered);
            const from = Math.max(delivered, cursor.oldest());
            delivered = cursor.written();
            if (sinks.length === 0)
            {
                return 0;
            }
            const batch = collect(from, delivered);
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
            const written = cursor.written();
            return collect(Math.max(cursor.oldest(), written - Math.max(0, count)), written);
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
         * what survives, `from` in the answer says where that actually
         * starts, and `lost` is how many records between `since` and there
         * were written over before this read -- a gap is reported rather
         * than papered over. A reader at 0 on a ring that has already lapped
         * is told how much it missed by arriving late, which is the truth.
         *
         * The lap is also written into the log, as a warning naming the
         * count and the category writing most of what the ring holds: the
         * flood is what a person reading the log needs explained, and the
         * ring's contents are the flood. Once per burst, at most one a
         * second of the journal's clock, with the count since the last.
         *
         * @param {number} [since]  The `next` of the previous read; 0 to start.
         * @param {number} [limit]  At most this many records.
         * @returns {{ records: FormattedRecord[], from: number, next: number,
         *             lost: number }}
         */
        drain(since = 0, limit = 1000){
            const start = Math.max(since, cursor.oldest());
            const end = Math.min(cursor.written(), start + Math.max(0, limit));
            const records = collect(start, end);
            const lapped = start - since;
            if (lapped > 0)
            {
                unreported += lapped;
                const at = now();
                if (at - warnedAt >= WARN_EVERY_MS)
                {
                    warnedAt = at;
                    const count = unreported;
                    unreported = 0;
                    journal.write(Level.WARN, 'log',
                        '{0} records were written over before they were read; '
                        + 'most of the ring is {1}', count, floodingCategory());
                }
            }
            return { records, from: start, next: end, lost: lapped };
        },

        /** @returns {{ message: string, category: string, level: number, count: number }[]} */
        templates: ()=>[...templates.values()].sort((one, two)=>two.count - one.count),

        /** Calls a category's level turned away, for the layer's counters. */
        rejected: ()=>rejected,

        diagnostics(){
            return {
                capacity: memory.records,
                written: writer.written(),
                // Records lapped before a sink saw them: the honest answer to
                // "why is there a gap", rather than a silently shorter log.
                lost,
                rejected,
                sinks: sinks.length,
                defaultLevel: fallback,
                categories: Object.fromEntries(levels),
                templates: templates.size,
                // Words the dictionary had no room for, and records too big
                // for the ring: both zero unless something is badly wrong.
                unnamed: writer.refused(),
                oversized: writer.oversized(),
            };
        },
    };
    return journal;
}
