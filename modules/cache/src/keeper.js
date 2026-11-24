/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cache's keeper: the one thread that places, moves and drops bodies.
 * Every thread reads the index and the hot bodies by itself (`shared.js`); it
 * comes here only for room to write a body into (`reserve`), for a cold body
 * to be brought back (`raise`) and to drop a name.
 *
 * The hot part is segments of shared memory, `segmentBytes` each, as many as
 * the budget holds; a segment's room is handed out in powers of two
 * (`buddy.js`). A thread learns of a segment by a message (`announce`), and a
 * message reaches a thread only between its turns, so the keeper keeps the
 * next segment announced before it is needed, and places a writer's body only
 * in a segment the writer says it has (`known`).
 *
 * The cold part is packs on the disk, `packBytes` each, bodies appended; a
 * body written once stays valid there until its name is written anew, so a
 * body going cold again writes nothing. What the disk holds survives the run:
 * the index of it is saved (`save`) and read back when the keeper opens.
 *
 * Bodies are of two kinds. One the cache can make again from its source (a
 * block of a bundle, a translation) goes cold when idle and away when idle
 * long, or at once where there is no disk. One that is the only copy of its
 * data (what a program wrote) goes to the disk, never away, and leaves memory
 * only once the disk holds it.
 */

import { createBuddy } from './buddy.js';
import {
    COLD, F_DROP, F_ONLY_COPY, F_ON_DISK, GONE, HEADER_WORDS, HOT, H_COUNT, H_NAMES, H_TICK,
    MOVING, RECORD_WORDS, RETIRED, R_FLAGS, R_HASH_A, R_HASH_B, R_LENGTH, R_NAME, R_NAME_LENGTH,
    R_OFFSET, R_PACK, R_PACK_OFFSET, R_SEGMENT, R_STATE, R_TICK, WRITING, growableShared,
    hashName, readersOf, stateOf, stateWord, viewIndex,
} from './shared.js';

const MIB = 1024 * 1024;

/** Room the records and names reserve to grow into: address space only, touched as used. */
const MAX_RECORDS = 1 << 20;
const MAX_NAME_UNITS = 1 << 25;
const FIRST_TABLE = 1024;

/**
 * A file on the disk as the keeper uses it: the shape of a
 * `FileSystemSyncAccessHandle`.
 *
 * @typedef {Object} DiskFile
 * @property {(view: Uint8Array, options: { at: number }) => number} read
 * @property {(view: Uint8Array, options: { at: number }) => number} write
 * @property {() => void} flush
 * @property {() => number} getSize
 * @property {(size: number) => void} truncate
 * @property {() => void} close
 */

/**
 * @typedef {Object} Disk
 * @property {(name: string) => DiskFile | Promise<DiskFile>} open  made where missing
 * @property {(name: string) => void | Promise<void>} [remove]
 */

/**
 * @typedef {Object} KeeperOptions
 * @property {number} budget  bytes of segments at most
 * @property {number} [segmentBytes]
 * @property {Disk | null} [disk]
 * @property {number} [packBytes]
 * @property {number} [coldAfterMs]  idle so long, a hot body goes to the disk
 * @property {number} [goneAfterMs]  idle so long, a cold body that can be made again goes
 * @property {number} [releaseAfterMs]  empty so long, a segment is let go
 * @property {(message: { segment?: number, buffer?: SharedArrayBuffer | null,
 *     table?: SharedArrayBuffer }) => void} [announce]  sent to every thread reading
 * @property {() => number} [now]
 */

/**
 * @param {KeeperOptions} options
 */
export async function openKeeper(options){
    const {
        budget, segmentBytes = 16 * MIB, disk = null, packBytes = 64 * MIB,
        coldAfterMs = 30_000, goneAfterMs = 7 * 24 * 3600_000, releaseAfterMs = 10_000,
        announce = ()=>{}, now = ()=>performance.now(),
    } = options;
    const shared = {
        records: growableShared((HEADER_WORDS + 1024 * RECORD_WORDS) * 4,
            (HEADER_WORDS + MAX_RECORDS * RECORD_WORDS) * 4),
        names: growableShared(64 * 1024, MAX_NAME_UNITS * 2),
        table: new SharedArrayBuffer(FIRST_TABLE * 4),
    };
    const index = viewIndex(shared);
    const { words } = index;
    const started = now();

    /** @type {({ buffer: SharedArrayBuffer, bytes: Uint8Array, buddy: import('./buddy.js').Buddy,
     *     emptySince: number } | null)[]} */
    const segments = [];
    /** @type {DiskFile[]} */
    const packs = [];
    /** The pack bodies are appended to, and where. */
    let pack = -1;
    let packTop = 0;
    /** The next pack, opened ahead: opening a file may not be synchronous. @type {Promise<DiskFile> | null} */
    let nextPack = null;
    /** @type {DiskFile | null} */
    let readyPack = null;

    const counts = {
        reserved: 0, refusedBusy: 0, refusedRoom: 0, refusedLarge: 0, refusedUnseen: 0,
        replaced: 0, raised: 0, raiseFailed: 0, cooled: 0, written: 0, writtenBytes: 0, gone: 0,
        segmentsMade: 0, segmentsLetGo: 0, letGoBytes: 0, deadDiskBytes: 0, diskFailures: 0,
    };

    const tick = ()=>Math.max(0, Math.floor(now() - started));

    // --- records ------------------------------------------------------------

    /** @param {number} id @param {number} field */
    const get = (id, field)=>words[index.at(id) + field];
    /** @param {number} id @param {number} field @param {number} value */
    const set = (id, field, value)=>{
        words[index.at(id) + field] = value;
    };
    /** @param {number} id */
    const stateWordOf = id=>Atomics.load(words, index.at(id) + R_STATE);
    /** @param {number} id @param {number} state */
    const store = (id, state)=>Atomics.store(words, index.at(id) + R_STATE, stateWord(state));

    /** @param {number} need  units */
    const growNames = need=>{
        const units = shared.names.byteLength / 2;
        if (need > units)
        {
            shared.names.grow(Math.min(MAX_NAME_UNITS, Math.max(need, units * 2)) * 2);
        }
    };

    /**
     * The record of `name`, made where there is none.
     *
     * @param {string} name
     */
    const recordOf = name=>{
        const hash = hashName(name);
        const known = index.find(name, hash);
        if (known >= 0)
        {
            return known;
        }
        const from = words[H_NAMES];
        growNames(from + name.length);
        for (let i = 0; i < name.length; i++)
        {
            index.names[from + i] = name.charCodeAt(i);
        }
        words[H_NAMES] = from + name.length;
        const id = newRecord(hash[0], hash[1], from, name.length);
        if (id >= 0)
        {
            insert(id, hash[0]);
        }
        return id;
    };

    /**
     * A record of no body yet, at the end of the records, not in the table:
     * its id, or -1 where the records are full.
     *
     * @param {number} a @param {number} b @param {number} nameAt @param {number} nameLength
     */
    const newRecord = (a, b, nameAt, nameLength)=>{
        const id = words[H_COUNT];
        if (id >= MAX_RECORDS)
        {
            return -1;
        }
        const bytesNeeded = (HEADER_WORDS + (id + 1) * RECORD_WORDS) * 4;
        if (bytesNeeded > shared.records.byteLength)
        {
            shared.records.grow(Math.min(shared.records.maxByteLength,
                Math.max(bytesNeeded, shared.records.byteLength * 2)));
        }
        set(id, R_HASH_A, a);
        set(id, R_HASH_B, b);
        set(id, R_NAME, nameAt);
        set(id, R_NAME_LENGTH, nameLength);
        set(id, R_SEGMENT, -1);
        set(id, R_PACK, -1);
        set(id, R_FLAGS, 0);
        store(id, GONE);
        Atomics.store(words, H_COUNT, id + 1);
        return id;
    };

    /**
     * The name of record `old` led to a new record from now on, its name
     * shared; `old` retired, its readers left to finish. The new one's id, or
     * -1 where the records are full.
     *
     * @param {number} old
     */
    const replaceRecord = old=>{
        const id = newRecord(get(old, R_HASH_A), get(old, R_HASH_B), get(old, R_NAME),
            get(old, R_NAME_LENGTH));
        if (id < 0)
        {
            return -1;
        }
        const table = index.table();
        const mask = table.length - 1;
        for (let slot = get(old, R_HASH_A) & mask; ; slot = (slot + 1) & mask)
        {
            if (table[slot] === old + 1)
            {
                Atomics.store(table, slot, id + 1);
                break;
            }
        }
        for (;;)
        {
            const word = stateWordOf(old);
            const retired = stateWord(RETIRED, readersOf(word));
            if (Atomics.compareExchange(words, index.at(old) + R_STATE, word, retired) === word)
            {
                break;
            }
        }
        counts.replaced++;
        return id;
    };

    /** @param {number} id @param {number} first */
    const insert = (id, first)=>{
        let table = index.table();
        if ((words[H_COUNT] + 1) * 2 > table.length)
        {
            const larger = new SharedArrayBuffer(table.length * 2 * 4);
            const into = new Int32Array(larger);
            const mask = into.length - 1;
            for (let other = 0; other < words[H_COUNT]; other++)
            {
                if (other === id)
                {
                    continue;
                }
                let slot = get(other, R_HASH_A) & mask;
                while (into[slot] !== 0)
                {
                    slot = (slot + 1) & mask;
                }
                into[slot] = other + 1;
            }
            index.adoptTable(larger);
            table = into;
            announce({ table: larger });
        }
        const mask = table.length - 1;
        let slot = first & mask;
        while (table[slot] !== 0)
        {
            slot = (slot + 1) & mask;
        }
        Atomics.store(table, slot, id + 1);
    };

    // --- segments -----------------------------------------------------------

    const madeBytes = ()=>segments.reduce((sum, one)=>sum + (one ? one.bytes.length : 0), 0);

    /** A new segment, announced, or -1 past the budget. */
    const makeSegment = ()=>{
        if (madeBytes() + segmentBytes > budget)
        {
            return -1;
        }
        const buffer = new SharedArrayBuffer(segmentBytes);
        // A number is never given to a second buffer: a thread that has not
        // heard a segment was let go still reads through its old view, and
        // under the same number it would read another body.
        const at = segments.length;
        segments.push(null);
        segments[at] = { buffer, bytes: new Uint8Array(buffer), buddy: createBuddy(segmentBytes),
            emptySince: tick() };
        counts.segmentsMade++;
        announce({ segment: at, buffer });
        return at;
    };

    /** One segment no body is in, announced ahead of need, where the budget has room. */
    const keepSpare = ()=>{
        if (!segments.some(one=>one !== null && one.buddy.empty()))
        {
            makeSegment();
        }
    };

    /**
     * Room for `length` bytes in a segment below `limit`: where it is, or null.
     *
     * @param {number} length @param {number} limit
     */
    const placeIn = (length, limit)=>{
        for (let at = 0; at < Math.min(limit, segments.length); at++)
        {
            const one = segments[at];
            if (one === null)
            {
                continue;
            }
            const offset = one.buddy.place(length);
            if (offset >= 0)
            {
                return { segment: at, offset };
            }
        }
        return null;
    };

    /**
     * Room for `length` bytes, the least recently used bodies made cold to
     * find it.
     *
     * @param {number} length @param {number} limit  segments a writer has
     */
    const room = (length, limit)=>{
        let found = placeIn(length, limit);
        if (found !== null)
        {
            return found;
        }
        const made = makeSegment();
        if (made >= 0 && made < limit)
        {
            found = placeIn(length, limit);
            if (found !== null)
            {
                return found;
            }
        }
        for (const id of oldestHot(limit))
        {
            cool(id);
            found = placeIn(length, limit);
            if (found !== null)
            {
                return found;
            }
        }
        return null;
    };

    /** @param {number} limit  @returns {number[]} hot ids no one reads, oldest first */
    const oldestHot = limit=>{
        const ids = [];
        for (let id = 0; id < words[H_COUNT]; id++)
        {
            const word = stateWordOf(id);
            if (stateOf(word) === HOT && readersOf(word) === 0 && get(id, R_SEGMENT) < limit)
            {
                ids.push(id);
            }
        }
        return ids.sort((a, b)=>get(a, R_TICK) - get(b, R_TICK));
    };

    /** @param {number} id */
    const giveBack = id=>{
        const one = segments[get(id, R_SEGMENT)];
        if (one !== null)
        {
            one.buddy.give(get(id, R_OFFSET), get(id, R_LENGTH));
            if (one.buddy.empty())
            {
                one.emptySince = tick();
            }
        }
        set(id, R_SEGMENT, -1);
    };

    // --- disk ---------------------------------------------------------------

    const openNextPack = ()=>{
        if (disk !== null && nextPack === null && readyPack === null)
        {
            nextPack = Promise.resolve(disk.open(`pack-${packs.length}`))
                .then(file=>{
                    readyPack = file;
                    nextPack = null;
                    return file;
                }, e=>{
                    counts.diskFailures++;
                    nextPack = null;
                    throw e;
                });
            nextPack.catch(()=>{});
        }
    };

    /**
     * Writes a hot body to the disk: true where the disk holds it now.
     *
     * @param {number} id
     */
    const writeOut = id=>{
        if (disk === null)
        {
            return false;
        }
        const length = get(id, R_LENGTH);
        if (pack < 0 || packTop + length > packBytes)
        {
            if (readyPack === null)
            {
                openNextPack();
                return false;
            }
            packs.push(readyPack);
            readyPack = null;
            pack = packs.length - 1;
            packTop = 0;
            openNextPack();
        }
        const one = /** @type {NonNullable<typeof segments[0]>} */ (segments[get(id, R_SEGMENT)]);
        const offset = get(id, R_OFFSET);
        try
        {
            packs[pack].write(one.bytes.subarray(offset, offset + length), { at: packTop });
            if (get(id, R_FLAGS) & F_ONLY_COPY)
            {
                packs[pack].flush();
            }
        }
        catch {
            counts.diskFailures++;
            return false;
        }
        set(id, R_PACK, pack);
        set(id, R_PACK_OFFSET, packTop);
        set(id, R_FLAGS, get(id, R_FLAGS) | F_ON_DISK);
        packTop += length;
        counts.written++;
        counts.writtenBytes += length;
        return true;
    };

    /** @param {number} id */
    const forgetDisk = id=>{
        if (get(id, R_FLAGS) & F_ON_DISK)
        {
            counts.deadDiskBytes += get(id, R_LENGTH);
        }
        set(id, R_FLAGS, get(id, R_FLAGS) & ~F_ON_DISK);
        set(id, R_PACK, -1);
    };

    // --- moves --------------------------------------------------------------

    /**
     * Takes a hot body no one reads out of its segment: to the disk where it
     * goes there, away where it can be made again. False where it is read,
     * or is the only copy and the disk cannot take it now.
     *
     * @param {number} id
     */
    const cool = id=>{
        const index_ = index.at(id) + R_STATE;
        if (Atomics.compareExchange(words, index_, stateWord(HOT), stateWord(MOVING))
            !== stateWord(HOT))
        {
            return false;
        }
        const onlyCopy = (get(id, R_FLAGS) & F_ONLY_COPY) !== 0;
        const onDisk = (get(id, R_FLAGS) & F_ON_DISK) !== 0 || writeOut(id);
        if (!onDisk && onlyCopy)
        {
            store(id, HOT);
            return false;
        }
        giveBack(id);
        if (onDisk)
        {
            store(id, COLD);
            counts.cooled++;
        }
        else
        {
            store(id, GONE);
            counts.gone++;
        }
        return true;
    };

    /** @param {number} id */
    const drop = id=>{
        const word = stateWordOf(id);
        const state = stateOf(word);
        if (state === HOT)
        {
            if (Atomics.compareExchange(words, index.at(id) + R_STATE, stateWord(HOT),
                stateWord(MOVING)) !== stateWord(HOT))
            {
                set(id, R_FLAGS, get(id, R_FLAGS) | F_DROP);
                return false;
            }
            giveBack(id);
        }
        else if (state !== COLD)
        {
            return state === GONE;
        }
        forgetDisk(id);
        set(id, R_FLAGS, 0);
        store(id, GONE);
        counts.gone++;
        return true;
    };

    keepSpare();
    openNextPack();

    return {
        shared,
        /** Segments by index, for a thread joining later. */
        segmentBuffers: ()=>segments.map(one=>(one === null ? null : one.buffer)),

        /**
         * Room for `name`'s body of `length` bytes, in a segment below
         * `known`: the record and where to write, or null with why counted.
         * The writer stores the record hot (`commit`) once it has written.
         *
         * @param {string} name @param {number} length
         * @param {{ onlyCopy?: boolean, known?: number }} [options]
         */
        reserve(name, length, { onlyCopy = false, known = Infinity } = {}){
            if (length > segmentBytes)
            {
                counts.refusedLarge++;
                return null;
            }
            let id = recordOf(name);
            const state = id < 0 ? GONE : stateOf(stateWordOf(id));
            // A body no one is in is written over in place; one being read or
            // written is left to those inside, the name led to a new record.
            if (state === HOT && Atomics.compareExchange(words, index.at(id) + R_STATE,
                stateWord(HOT), stateWord(MOVING)) === stateWord(HOT))
            {
                giveBack(id);
            }
            else if (state === HOT || state === WRITING)
            {
                id = replaceRecord(id);
            }
            if (id < 0)
            {
                counts.refusedRoom++;
                return null;
            }
            forgetDisk(id);
            set(id, R_FLAGS, onlyCopy ? F_ONLY_COPY : 0);
            store(id, MOVING);
            const found = room(length, known);
            if (found === null)
            {
                store(id, GONE);
                counts[segments.length > known ? 'refusedUnseen' : 'refusedRoom']++;
                return null;
            }
            set(id, R_SEGMENT, found.segment);
            set(id, R_OFFSET, found.offset);
            set(id, R_LENGTH, length);
            set(id, R_TICK, Atomics.load(words, H_TICK));
            // The writer counts as one inside until it commits.
            Atomics.store(words, index.at(id) + R_STATE, stateWord(WRITING, 1));
            counts.reserved++;
            keepSpare();
            return { id, segment: found.segment, offset: found.offset };
        },

        /**
         * Brings `name`'s cold body back into a segment: true where it is hot
         * now.
         *
         * @param {string} name
         */
        raise(name){
            const id = index.find(name);
            if (id < 0)
            {
                return false;
            }
            const state = stateOf(stateWordOf(id));
            if (state !== COLD)
            {
                return state === HOT;
            }
            store(id, MOVING);
            const length = get(id, R_LENGTH);
            const found = room(length, Infinity);
            if (found === null)
            {
                store(id, COLD);
                counts.raiseFailed++;
                return false;
            }
            const one = /** @type {NonNullable<typeof segments[0]>} */ (segments[found.segment]);
            try
            {
                packs[get(id, R_PACK)].read(one.bytes.subarray(found.offset, found.offset + length),
                    { at: get(id, R_PACK_OFFSET) });
            }
            catch {
                one.buddy.give(found.offset, length);
                counts.diskFailures++;
                store(id, COLD);
                counts.raiseFailed++;
                return false;
            }
            set(id, R_SEGMENT, found.segment);
            set(id, R_OFFSET, found.offset);
            set(id, R_TICK, Atomics.load(words, H_TICK));
            store(id, HOT);
            counts.raised++;
            keepSpare();
            return true;
        },

        /** @param {string} name */
        drop(name){
            const id = index.find(name);
            return id < 0 || drop(id);
        },

        /**
         * The clock moves; idle bodies go cold, long idle cold ones go, bodies
         * asked away go once no one reads them, segments empty long enough are
         * let go but one.
         */
        sweep(){
            const at = tick();
            Atomics.store(words, H_TICK, at);
            for (let id = 0; id < words[H_COUNT]; id++)
            {
                const word = stateWordOf(id);
                const state = stateOf(word);
                if ((get(id, R_FLAGS) & F_DROP) !== 0 && readersOf(word) === 0)
                {
                    drop(id);
                    continue;
                }
                if (state === RETIRED && readersOf(word) === 0
                    && Atomics.compareExchange(words, index.at(id) + R_STATE, word,
                        stateWord(MOVING)) === word)
                {
                    if (get(id, R_SEGMENT) >= 0)
                    {
                        giveBack(id);
                    }
                    forgetDisk(id);
                    store(id, GONE);
                    continue;
                }
                if (state === HOT && readersOf(word) === 0 && at - get(id, R_TICK) >= coldAfterMs)
                {
                    cool(id);
                }
                else if (state === COLD && (get(id, R_FLAGS) & F_ONLY_COPY) === 0
                    && at - get(id, R_TICK) >= goneAfterMs)
                {
                    drop(id);
                }
            }
            let spare = false;
            for (let s = 0; s < segments.length; s++)
            {
                const one = segments[s];
                if (one === null || !one.buddy.empty())
                {
                    continue;
                }
                if (!spare)
                {
                    spare = true;
                    continue;
                }
                if (at - one.emptySince >= releaseAfterMs)
                {
                    segments[s] = null;
                    counts.segmentsLetGo++;
                    counts.letGoBytes += segmentBytes;
                    announce({ segment: s, buffer: null });
                }
            }
            for (const file of packs)
            {
                file.flush();
            }
        },

        /** Hot bytes, segments, cold bytes and what was done, for the report. */
        figures(){
            let hotBytes = 0;
            let coldBytes = 0;
            let hot = 0;
            let cold = 0;
            for (let id = 0; id < words[H_COUNT]; id++)
            {
                const state = stateOf(stateWordOf(id));
                if (state === HOT || state === WRITING || state === RETIRED)
                {
                    hot++;
                    hotBytes += get(id, R_LENGTH);
                }
                else if (state === COLD)
                {
                    cold++;
                    coldBytes += get(id, R_LENGTH);
                }
            }
            const live = segments.filter(one=>one !== null);
            return {
                records: words[H_COUNT], hot, hotBytes, cold, coldBytes,
                segments: live.length, segmentBytes: live.length * segmentBytes,
                placedBytes: live.reduce((sum, one)=>sum + one.buddy.used(), 0),
                roundingBytes: live.reduce((sum, one)=>sum + one.buddy.wasted(), 0),
                indexBytes: shared.records.byteLength + shared.names.byteLength
                    + index.table().byteLength,
                packs: packs.length, ...counts,
            };
        },
    };
}

/** @typedef {Awaited<ReturnType<typeof openKeeper>>} Keeper */
