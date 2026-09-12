/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createJournalCursor, openJournalMemory, INLINE_TEMPLATE } from './shared-journal.js';
import { readTable } from './table.js';
import { Level, formatText, levelName } from './journal.js';
import { NOTES_PER_FRAME, PhaseKind } from './profiler.js';

/** A frame's kinds, in the order the frame table stores them. */
const KINDS = [PhaseKind.HOST, PhaseKind.GUEST, PhaseKind.GPU, PhaseKind.PRESENT];
/** The page size the kernel credits instructions by. */
const PAGE = 0x10000;

/**
 * The other side of the log: whoever reads it, on whatever thread they have.
 *
 * Built over the memory the engine writes into, not over messages from it.
 * The engine is never asked for a record, a frame or a counter again; it
 * publishes, and this drains, formats, and hands records to as many
 * subscribers as care to register, each for the topics and the level it
 * wants. A subscriber is a function; a topic is a category name; the history
 * is the ring itself, read by sequence, so `recent` and `drain` answer
 * exactly what the engine-side calls used to, without the engine.
 *
 * `poll()` is the one thing the owner of the thread has to call, as often as
 * it likes: nothing here schedules itself, because a page and a worker wait
 * differently and the reader should not know which it is on.
 */

/**
 * @typedef {Object} Subscriber
 * @property {Set<string> | null} topics   Null for every topic.
 * @property {number} level
 * @property {(records: import('./journal.js').FormattedRecord[]) => void} sink
 */

/**
 * @typedef {Object} LogMemory
 * @property {ArrayBufferLike} journal
 * @property {Record<string, Record<string, import('./table.js').TableDescriptor>>} [tables]
 */

/**
 * @param {Object} options
 * @param {LogMemory} options.memory
 */
export function createLogReader({ memory }){
    const cursor = createJournalCursor(openJournalMemory(memory.journal));
    const tables = memory.tables ?? {};
    /** @type {Subscriber[]} */
    const subscribers = [];
    let next = 0;
    let lost = 0;

    /**
     * @param {import('./shared-journal.js').DecodedRecord} record
     * @returns {import('./journal.js').FormattedRecord}
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
     * The records from `from` up to but not including `to`, formatted, with
     * how many of them were gone by the time they were reached.
     *
     * @param {number} from @param {number} to
     */
    const collect = (from, to)=>{
        /** @type {import('./journal.js').FormattedRecord[]} */
        const records = [];
        let gone = 0;
        for (let sequence = from; sequence < to; sequence++)
        {
            const record = cursor.read(sequence);
            if (record)
            {
                records.push(detach(record));
            }
            else
            {
                gone++;
            }
        }
        return { records, gone };
    };

    return {
        Level,

        /**
         * @param {string | string[]} topics   Category names, or `'*'` for all.
         * @param {(records: import('./journal.js').FormattedRecord[]) => void} sink
         * @param {{ level?: number }} [options]  The least severe level delivered.
         * @returns {() => void} unsubscribes
         */
        subscribe(topics, sink, options = {}){
            const wanted = topics === '*' ? null
                : new Set(Array.isArray(topics) ? topics : [topics]);
            /** @type {Subscriber} */
            const subscriber = { topics: wanted, level: options.level ?? Level.TRACE, sink };
            subscribers.push(subscriber);
            return ()=>{
                const at = subscribers.indexOf(subscriber);
                if (at >= 0)
                {
                    subscribers.splice(at, 1);
                }
            };
        },

        /**
         * Reads what has been written since the last poll and hands it out.
         *
         * @param {number} [limit]  At most this many records in one poll.
         * @returns {{ delivered: number, lost: number }}
         */
        poll(limit = 4096){
            const oldest = cursor.oldest();
            if (next < oldest)
            {
                lost += oldest - next;
                next = oldest;
            }
            const to = Math.min(cursor.written(), next + limit);
            const { records, gone } = collect(next, to);
            lost += gone;
            next = to;
            if (records.length > 0)
            {
                for (const subscriber of subscribers)
                {
                    const batch = subscriber.topics === null && subscriber.level >= Level.TRACE
                        ? records
                        : records.filter(record=>record.level <= subscriber.level
                            && (subscriber.topics === null
                                || subscriber.topics.has(record.category)));
                    if (batch.length > 0)
                    {
                        subscriber.sink(batch);
                    }
                }
            }
            return { delivered: records.length, lost: lost };
        },

        /** Records the poll cursor was lapped past, in total. */
        lost: ()=>lost,

        /** @param {number} [count] */
        recent(count = 100){
            const written = cursor.written();
            const from = Math.max(cursor.oldest(), written - Math.max(0, count));
            return collect(from, written).records;
        },

        /**
         * Everything since a sequence, with where to resume -- the same
         * answer the engine used to give, read here instead.
         *
         * @param {number} [since] @param {number} [limit]
         */
        drain(since = 0, limit = 1000){
            const start = Math.max(since, cursor.oldest());
            const end = Math.min(cursor.written(), start + Math.max(0, limit));
            const { records, gone } = collect(start, end);
            return { records, from: start, next: end, lost: start - since + gone };
        },

        /** @param {number} id A dictionary id, as a table stores a name. */
        word: id=>cursor.word(id),

        /**
         * A layer's table by name, or null if the layer publishes no such thing.
         *
         * @param {string} layer @param {string} name
         */
        table(layer, name){
            const descriptor = tables[layer]?.[name];
            return descriptor ? readTable(descriptor) : null;
        },

        /**
         * A layer's counters as a record, the shape a diagnostics table used
         * to carry them in.
         *
         * @param {string} layer
         * @returns {Record<string, number>}
         */
        counters(layer){
            const descriptor = tables[layer]?.counters;
            return descriptor ? readTable(descriptor).row(0) : {};
        },

        /**
         * The profiler's frames, oldest first, in the shape `log.frames`
         * answered them -- read from the frame table, names looked up here.
         *
         * @param {number} [count]
         */
        frames(count = 240){
            const table = tables.log?.frames;
            if (!table)
            {
                return [];
            }
            const rows = readTable(table).all();
            return rows.slice(Math.max(0, rows.length - count)).map(row=>{
                /** @type {Record<string, number>} */
                const notes = {};
                for (let i = 0; i < NOTES_PER_FRAME; i++)
                {
                    if (row[`note${i}`] >= 0)
                    {
                        notes[cursor.word(row[`note${i}`])] = row[`amount${i}`];
                    }
                }
                return {
                    index: row.index,
                    startedAt: row.startedAt,
                    ms: row.ms,
                    byKind: Object.fromEntries(KINDS.map(kind=>[kind, row[kind]])),
                    sampled: Object.fromEntries(KINDS.map(kind=>[kind,
                        row[`sampled${kind[0].toUpperCase()}${kind.slice(1)}`]])),
                    hostShare: row.hostShare,
                    longest: { name: cursor.word(row.longest), ms: row.longestMs },
                    longestGuest: { ms: row.longestGuestMs,
                        instructions: row.longestGuestInstructions },
                    waits: row.waits,
                    compiles: row.compiles,
                    notes,
                };
            });
        },

        /**
         * The profile `log.profile` answered: every phase by self time, the
         * worst frames, and the share the thresholds watch.
         *
         * @param {number} [worst]
         */
        profile(worst = 5){
            const recent = this.frames();
            let totalMs = 0;
            let hostMs = 0;
            for (const frame of recent)
            {
                totalMs += frame.ms;
                hostMs += frame.byKind.host + frame.sampled.host;
            }
            const phases = tables.log?.phases ? readTable(tables.log.phases).all() : [];
            return {
                frames: tables.log?.frames ? readTable(tables.log.frames).written() : 0,
                hostShare: totalMs > 0 ? hostMs / totalMs : 0,
                averageFrameMs: recent.length > 0 ? totalMs / recent.length : 0,
                phases: phases
                    .map(row=>({ name: cursor.word(row.name), kind: KINDS[row.kind] ?? 'host',
                        count: row.count, totalMs: row.totalMs, selfMs: row.selfMs,
                        worstMs: row.worstMs }))
                    .sort((one, two)=>two.selfMs - one.selfMs),
                worstFrames: [...recent].sort((one, two)=>two.ms - one.ms).slice(0, worst),
                recentFrames: recent,
            };
        },

        /**
         * Which of the program's own code the machine is spent on: the
         * kernel's instructions by page, summed by the region each page is
         * in. The walk and the sort happen here, on this thread, over the
         * arrays the engine only ever adds to.
         *
         * @returns {Record<string, number>} region name to instructions, heaviest first
         */
        guestByModule(){
            const pages = tables.kernel?.pages ? readTable(tables.kernel.pages).values : null;
            if (!pages)
            {
                return {};
            }
            const regions = tables.memory?.regions ? readTable(tables.memory.regions).all() : [];
            /** @type {Map<string, number>} */
            const byName = new Map();
            let region = 0;
            for (let page = 0; page < pages.length; page++)
            {
                const instructions = pages[page];
                if (instructions === 0)
                {
                    continue;
                }
                const address = page * PAGE;
                // Regions are published lowest first and pages are walked
                // upwards, so the region cursor only ever moves forward.
                while (region < regions.length
                    && address >= regions[region].base + regions[region].size)
                {
                    region++;
                }
                const hit = region < regions.length && address >= regions[region].base
                    ? regions[region] : null;
                // The last row is where the kernel puts an address outside
                // guest memory altogether, which no region can name.
                const name = page === pages.length - 1 ? 'elsewhere'
                    : hit ? cursor.word(hit.name) : 'unmapped';
                byName.set(name, (byName.get(name) ?? 0) + instructions);
            }
            return Object.fromEntries([...byName].sort((one, two)=>two[1] - one[1]));
        },

        /**
         * The kernel's threads as the table holds them, names and states as
         * words.
         */
        threads(){
            const table = tables.kernel?.threads;
            if (!table)
            {
                return [];
            }
            return readTable(table).all().map(row=>({
                ...row,
                name: cursor.word(row.name),
                state: ['ready', 'running', 'blocked', 'terminated'][row.state] ?? '?',
                boosted: row.boosted === 1,
                waitingOn: row.waitingOn >= 0 ? cursor.word(row.waitingOn) : null,
            }));
        },
    };
}
