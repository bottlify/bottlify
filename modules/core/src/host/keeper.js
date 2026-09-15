/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The log keeper: a worker that owns the log on behalf of the page.
 *
 * The engine publishes its journal, counters and tables into shared memory and
 * never answers a reader. Something has to drain that ring before it laps,
 * keep the history a live view reads back, work out the derived views -- the
 * frames, the profile, the attribution by module -- and hand records to
 * whoever subscribed. All of that used to sit on the page's main thread, next
 * to the code that composes the picture, and on an origin without shared
 * memory on the engine's own thread. This is that reader moved to a worker of
 * its own, so neither of those threads pays for logging at all.
 *
 * The keeper is handed a block (`attach`), polls it on its own clock, and
 * answers requests from what it kept; when the machine is rebuilt on a child's
 * image it is simply handed the next block and goes on. Its history is its
 * own ring, so a `drain` cursor taken before a replacement resolves in the
 * records the keeper already holds.
 *
 * It is deliberately not a transport for the writer: a record never crosses as
 * a message on the way in. `attach` hands over memory, and the keeper reads it
 * where the engine wrote it. The `feed` message exists only for an origin
 * without shared memory, where the block cannot cross and the page relays what
 * the engine answered; there the records arrive as one batch per poll, never
 * one message per record.
 */

import { createLogReader } from '../layers/log/reader.js';

/** How often the keeper reads what the engine has written since its last look. */
export const MIRROR_MS = 200;
/** How many records one look may carry. */
export const MIRROR_LIMIT = 4000;
/** How many records the keeper holds when nobody named a capacity. */
export const MIRROR_CAPACITY = 4096;
/** Most rounds one poll may take before it yields to the timer again. */
const POLL_ROUNDS = 16;

/**
 * @typedef {Object} KeeperPort
 * @property {(message: any, transfer?: any[]) => void} postMessage
 * @property {((event: { data: any }) => void) | null} onmessage
 */

/**
 * @typedef {Object} KeeperOptions
 * @property {number} [capacity]   Records of history kept.
 * @property {number} [intervalMs] The poll clock; `MIRROR_MS` by default.
 * @property {number} [limit]      Records one round may carry.
 */

/**
 * Serves the keeper over a port: a worker's global scope, a `MessagePort`, or
 * anything shaped like either.
 *
 * @param {KeeperPort} port
 * @param {KeeperOptions} [options]
 * @returns {{ close: () => void, poll: () => void }}
 */
export function serveKeeper(port, options = {}){
    const capacity = Math.max(1, Math.floor(options.capacity ?? MIRROR_CAPACITY));
    const intervalMs = options.intervalMs ?? MIRROR_MS;
    const limit = options.limit ?? MIRROR_LIMIT;

    /** The reader over the current block, or null before one is attached. */
    /** @type {ReturnType<typeof createLogReader> | null} */
    let reader = null;
    /** The next sequence the poll cursor reads from. */
    let cursor = 0;
    /** Records the engine lapped before a poll reached them, in total. */
    let lost = 0;
    /**
     * The keeper's own history, oldest first. A plain array rather than a ring:
     * it is written once per poll off the engine's thread, and a `drain` needs
     * to walk it from an arbitrary sequence.
     *
     * @type {import('../layers/log/internal/journal.js').FormattedRecord[]}
     */
    let history = [];

    /**
     * A subscriber: the topics and level it wants, and where its batches go.
     * The sink is the port; a batch is posted, never a record.
     *
     * @type {Map<number, { topics: Set<string> | null, level: number }>}
     */
    const subscribers = new Map();

    /** @param {import('../layers/log/internal/journal.js').FormattedRecord[]} records */
    const append = records=>{
        history = history.concat(records);
        if (history.length > capacity)
        {
            history = history.slice(history.length - capacity);
        }
    };

    /**
     * Hands every subscriber the records this batch that it asked for, as one
     * message each. A topic set of null means every category.
     *
     * @param {import('../layers/log/internal/journal.js').FormattedRecord[]} records
     */
    const deliver = records=>{
        for (const [id, subscriber] of subscribers)
        {
            const batch = subscriber.level >= 5 && subscriber.topics === null
                ? records
                : records.filter(record=>record.level <= subscriber.level
                    && (subscriber.topics === null
                        || subscriber.topics.has(record.category)));
            if (batch.length > 0)
            {
                port.postMessage({ type: 'records', id, records: batch });
            }
        }
    };

    /**
     * Reads the current block forward as far as it can go in one look, keeping
     * the records and telling the subscribers. This is the only place the
     * block is read; requests read what a poll left behind.
     */
    const poll = ()=>{
        if (!reader)
        {
            return;
        }
        for (let round = 0; round < POLL_ROUNDS; round++)
        {
            const answer = reader.drain(cursor, limit);
            cursor = answer.next;
            if (answer.lost > 0)
            {
                lost += answer.lost;
                port.postMessage({ type: 'lost', count: answer.lost });
            }
            if (answer.records.length === 0)
            {
                break;
            }
            append(answer.records);
            deliver(answer.records);
            if (answer.records.length < limit)
            {
                break;
            }
        }
    };

    /**
     * A read the page asked for, answered from the keeper's history for the
     * journal and from the current block for the derived views.
     *
     * @param {string} name
     * @param {unknown[]} args
     * @returns {unknown}
     */
    const answer = (name, args)=>{
        switch (name)
        {
            case 'recent':
            {
                const count = Math.max(0, Number(args[0] ?? 100));
                return history.slice(Math.max(0, history.length - count));
            }
            case 'drain':
                return drain(Number(args[0] ?? 0), Number(args[1] ?? 1000));
            case 'lost':
                return lost;
            case 'frames':
                return reader ? reader.frames(Number(args[0] ?? 240)) : [];
            case 'profile':
                return reader ? reader.profile(Number(args[0] ?? 5)) : {
                    frames: 0, hostShare: 0, averageFrameMs: 0,
                    phases: [], worstFrames: [], recentFrames: [],
                };
            case 'counters':
                return reader ? reader.counters(/** @type {string} */ (args[0])) : {};
            case 'table':
            {
                const table = reader?.table(/** @type {string} */ (args[0]),
                    /** @type {string} */ (args[1]));
                return table
                    ? { columns: table.columns, rows: table.all(),
                        written: table.written(), used: table.used() }
                    : null;
            }
            case 'word':
                return reader ? reader.word(Number(args[0])) : `#${args[0]}`;
            case 'threads':
                return reader ? reader.threads() : [];
            case 'guestByModule':
                return reader ? reader.guestByModule() : {};
            default:
                throw new Error(`no such read: ${name}`);
        }
    };

    /**
     * The same answer the engine-side drain gave, from the keeper's history:
     * everything from `since`, where to resume, and how much between the two
     * was written over before this read.
     *
     * @param {number} since
     * @param {number} count
     */
    const drain = (since, count)=>{
        /** @type {import('../layers/log/internal/journal.js').FormattedRecord[]} */
        const taken = [];
        for (const record of history)
        {
            if (record.sequence >= since && taken.length < count)
            {
                taken.push(record);
            }
        }
        const oldest = history.length > 0 ? history[0].sequence : cursor;
        const from = taken.length > 0 ? taken[0].sequence : Math.max(since, oldest);
        const end = taken.length > 0 ? taken[taken.length - 1].sequence + 1 : from;
        return { records: taken, from, next: end,
            lost: Math.max(0, end - since - taken.length) };
    };

    /** @param {any} message */
    const receive = message=>{
        switch (message.type)
        {
            case 'attach':
            {
                // One last look at the block being left, so its newest records
                // are in the history before the reader over it is dropped.
                poll();
                reader = createLogReader({ memory: message.memory });
                const base = reader.base?.() ?? 0;
                cursor = Math.max(cursor, base, Number(message.sequenceBase ?? 0));
                poll();
                return;
            }
            case 'feed':
            {
                // No shared memory: the page relays what the engine answered,
                // one batch per look, and the keeper keeps it like a poll would.
                const records = /** @type {any[]} */ (message.records ?? []);
                if (records.length > 0)
                {
                    append(records);
                    deliver(records);
                }
                if (message.lost > 0)
                {
                    lost += message.lost;
                    port.postMessage({ type: 'lost', count: message.lost });
                }
                if (typeof message.next === 'number')
                {
                    cursor = Math.max(cursor, message.next);
                }
                return;
            }
            case 'request':
            {
                try
                {
                    port.postMessage({ type: 'answer', id: message.id,
                        value: answer(message.name, message.args ?? []) });
                }
                catch (e){
                    port.postMessage({ type: 'answer', id: message.id,
                        error: { message: /** @type {any} */ (e)?.message ?? String(e) } });
                }
                return;
            }
            case 'subscribe':
            {
                const topics = message.topics === '*' || message.topics === undefined
                    || message.topics === null
                    ? null
                    : new Set(Array.isArray(message.topics) ? message.topics : [message.topics]);
                subscribers.set(message.id, { topics,
                    level: Number(message.level ?? 5) });
                return;
            }
            case 'unsubscribe':
                subscribers.delete(message.id);
                return;
            default:
                return;
        }
    };

    port.onmessage = ({ data })=>receive(data);

    const timer = intervalMs > 0 ? setInterval(poll, intervalMs) : null;

    return {
        close(){
            if (timer !== null)
            {
                clearInterval(timer);
            }
            port.onmessage = null;
        },
        poll,
    };
}
