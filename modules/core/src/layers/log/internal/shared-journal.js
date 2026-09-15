/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The journal's storage: one block of memory a writer fills and any number of
 * readers on any thread decode, with neither ever waiting for the other.
 *
 * The engine writes a record and moves on. Whoever reads it -- a log worker,
 * the page, a sink on the same thread -- finds it in the block and formats it
 * there, so the thread being measured does no string work for a record nobody
 * reads and never answers a request for its log. When the block is a
 * `SharedArrayBuffer` the readers are on other threads; when it is not, they
 * are on this one, and nothing about the contract changes.
 *
 * Three regions, in one buffer so that handing it over is one object:
 *
 *  - a dictionary of strings written once each -- templates, categories, and
 *    any name a table wants to refer to by number -- so that a record carries
 *    ids and the reader looks the words up;
 *  - an index of the last N records' byte offsets;
 *  - a ring of bytes the records themselves are encoded into.
 *
 * Publication is by `Atomics.store` of the counters, after the bytes; a reader
 * that loads a counter sees everything written before it. A record's bytes are
 * reserved before they are written and checked by the reader after they are
 * copied, so a reader that was lapped mid-copy discards what it copied rather
 * than trusting it. Being lapped is counted exactly, per reader, by sequence.
 *
 * Counters are 32-bit and wrap; every comparison is by unsigned difference,
 * which is exact as long as no reader falls 2^31 behind.
 */

/** Control words, at the start of the block. */
const VERSION = 0;
const RECORDS = 1;
const RING_BYTES = 2;
const DICT_BYTES = 3;
const WRITTEN = 4;
const HEAD = 5;
const DICT_COUNT = 6;
const DICT_HEAD = 7;
const DICT_REFUSED = 8;
const SEQUENCE_BASE = 9;
const CONTROL_WORDS = 16;
const CONTROL_BYTES = CONTROL_WORDS * 4;

const LAYOUT_VERSION = 1;

/** A template the dictionary had no room for travels inline instead. */
export const INLINE_TEMPLATE = 0xffffffff;

const TAG_NUMBER = 0;
const TAG_STRING = 1;

/** Code units a string argument keeps; the rest is cut, which the reader can tell. */
const STRING_UNITS = 1024;
const RECORD_HEADER = 24;

/**
 * @typedef {Object} JournalViews
 * @property {ArrayBufferLike} buffer
 * @property {Int32Array} control
 * @property {DataView} view
 * @property {Int32Array} index
 * @property {number} records
 * @property {number} ringBytes
 * @property {number} ringOffset
 * @property {number} dictOffset
 * @property {number} dictBytes
 * @property {number} sequenceBase
 */

/**
 * @typedef {Object} DecodedRecord
 * @property {number} sequence
 * @property {number} time
 * @property {number} level
 * @property {number} topic      Dictionary id of the category.
 * @property {number} template   Dictionary id, or `INLINE_TEMPLATE`.
 * @property {string} inline     The template text when it travelled inline.
 * @property {(number | string)[]} args
 */

/**
 * @param {ArrayBufferLike} buffer
 * @returns {JournalViews}
 */
export function openJournalMemory(buffer){
    const control = new Int32Array(buffer, 0, CONTROL_WORDS);
    if (control[VERSION] !== LAYOUT_VERSION)
    {
        throw new Error('log: the journal memory is not laid out the way this reader expects');
    }
    const records = control[RECORDS];
    const dictBytes = control[DICT_BYTES];
    const ringBytes = control[RING_BYTES];
    const dictOffset = CONTROL_BYTES;
    const indexOffset = dictOffset + dictBytes;
    const ringOffset = indexOffset + records * 4;
    return {
        buffer,
        control,
        view: new DataView(buffer),
        index: new Int32Array(buffer, indexOffset, records),
        records,
        ringBytes,
        ringOffset,
        dictOffset,
        dictBytes,
        sequenceBase: control[SEQUENCE_BASE] >>> 0,
    };
}

/**
 * @param {Object} [options]
 * @param {number} [options.records]      Records the index remembers.
 * @param {number} [options.bytes]        Bytes of the record ring.
 * @param {number} [options.dictionary]   Bytes of the string dictionary.
 * @param {boolean} [options.shared]      Whether to ask for shared memory when there is any.
 * @param {number} [options.sequenceBase]
 *        The sequence the first record gets. A machine rebuilt on a child's
 *        image starts a fresh block, and a reader holding a cursor from the one
 *        it replaced resumes here rather than at zero.
 * @returns {JournalViews}
 */
export function createJournalMemory(options = {}){
    const records = Math.max(1, Math.floor(options.records ?? 4096));
    const ringBytes = align(Math.max(4096, options.bytes ?? 1024 * 1024), 8);
    const dictBytes = align(Math.max(256, options.dictionary ?? 512 * 1024), 8);
    const total = CONTROL_BYTES + dictBytes + records * 4 + ringBytes;
    const buffer = (options.shared ?? true) && typeof SharedArrayBuffer === 'function'
        ? new SharedArrayBuffer(align(total, 8))
        : new ArrayBuffer(align(total, 8));
    const control = new Int32Array(buffer, 0, CONTROL_WORDS);
    control[VERSION] = LAYOUT_VERSION;
    control[RECORDS] = records;
    control[RING_BYTES] = ringBytes;
    control[DICT_BYTES] = dictBytes;
    control[SEQUENCE_BASE] = (options.sequenceBase ?? 0) >>> 0;
    return openJournalMemory(buffer);
}

/** @param {number} value @param {number} to */
const align = (value, to)=>Math.ceil(value / to) * to;

/**
 * The single writer. One per block: two writers would race for the head.
 *
 * @param {JournalViews} memory
 */
export function createJournalWriter(memory){
    const { control, view, index, records, ringBytes, ringOffset, dictOffset, dictBytes } = memory;
    const sequenceBase = memory.sequenceBase ?? 0;
    /** @type {Map<string, number>} */
    const interned = new Map();
    let written = 0;
    let head = 0;
    let dictHead = 0;
    let dictCount = 0;
    /** Records too big for the ring, which cannot be written at all. */
    let oversized = 0;

    /**
     * @param {number} at
     * @param {string} text
     * @param {number} limit
     * @returns {number} bytes used, a multiple of four
     */
    const putString = (at, text, limit)=>{
        const units = Math.min(text.length, limit);
        view.setUint32(at, units, true);
        let cursor = at + 4;
        for (let i = 0; i < units; i++)
        {
            view.setUint16(cursor, text.charCodeAt(i), true);
            cursor += 2;
        }
        return align(4 + units * 2, 4);
    };

    /** @param {string} text @returns {number} the bytes it takes, before it is written */
    const stringBytes = text=>align(4 + Math.min(text.length, STRING_UNITS) * 2, 4);

    const writer = {
        /**
         * The id of a string, written into the dictionary the first time it is
         * seen. For words that recur -- a template, a category, a thread's
         * name -- not for values. A dictionary with no room left refuses, and
         * the caller sends the text inline instead.
         *
         * @param {string} text
         * @returns {number} the id, or -1 when refused
         */
        intern(text){
            const known = interned.get(text);
            if (known !== undefined)
            {
                return known;
            }
            const bytes = stringBytes(text);
            if (dictHead + bytes > dictBytes)
            {
                Atomics.add(control, DICT_REFUSED, 1);
                return -1;
            }
            putString(dictOffset + dictHead, text, STRING_UNITS);
            dictHead += bytes;
            const id = dictCount++;
            interned.set(text, id);
            // The bytes first, then the head, then the count that publishes
            // them: a reader that sees the count sees the entry.
            Atomics.store(control, DICT_HEAD, dictHead);
            Atomics.store(control, DICT_COUNT, dictCount);
            return id;
        },

        /**
         * @param {number} time
         * @param {number} level
         * @param {number} topic       A dictionary id.
         * @param {string} message     The template.
         * @param {number} argc
         * @param {unknown} a @param {unknown} b @param {unknown} c @param {unknown} d
         * @returns {number} the record's sequence
         */
        write(time, level, topic, message, argc, a, b, c, d){
            const template = writer.intern(message);
            let length = RECORD_HEADER;
            if (template < 0)
            {
                length += stringBytes(message);
            }
            // Sized before it is written, because the record must be
            // contiguous and the ring's end is where it cannot be. Anything
            // that is not a number travels as the string it prints as, which
            // is what the reader would have made of it anyway.
            const arg0 = argc > 0 ? asValue(a) : 0;
            const arg1 = argc > 1 ? asValue(b) : 0;
            const arg2 = argc > 2 ? asValue(c) : 0;
            const arg3 = argc > 3 ? asValue(d) : 0;
            length += argc > 0 ? valueBytes(arg0) : 0;
            length += argc > 1 ? valueBytes(arg1) : 0;
            length += argc > 2 ? valueBytes(arg2) : 0;
            length += argc > 3 ? valueBytes(arg3) : 0;
            if (length > ringBytes)
            {
                oversized++;
                return -1;
            }
            let start = head;
            if ((start % ringBytes) + length > ringBytes)
            {
                // Skip the tail nobody can use; the index knows where each
                // record actually starts, so no reader has to find a pad.
                start += ringBytes - (start % ringBytes);
            }
            head = start + length;
            // Reserved before written: a reader checks its copy against the
            // head afterwards, and that check is only honest if the head
            // already covers bytes being overwritten.
            Atomics.store(control, HEAD, head >>> 0);

            const sequence = (sequenceBase + written++) >>> 0;
            let at = ringOffset + (start % ringBytes);
            view.setUint32(at, length, true);
            view.setUint32(at + 4, sequence >>> 0, true);
            view.setFloat64(at + 8, time, true);
            view.setUint8(at + 16, level);
            view.setUint8(at + 17, argc);
            view.setUint16(at + 18, Math.min(topic, 0xffff), true);
            view.setUint32(at + 20, template < 0 ? INLINE_TEMPLATE : template, true);
            at += RECORD_HEADER;
            if (template < 0)
            {
                at += putString(at, message, STRING_UNITS);
            }
            if (argc > 0)
            {
                at += putValue(at, arg0);
            }
            if (argc > 1)
            {
                at += putValue(at, arg1);
            }
            if (argc > 2)
            {
                at += putValue(at, arg2);
            }
            if (argc > 3)
            {
                putValue(at, arg3);
            }
            index[sequence % records] = start >>> 0;
            Atomics.store(control, WRITTEN, written >>> 0);
            return sequence;
        },

        written: ()=>(sequenceBase + written) >>> 0,
        oversized: ()=>oversized,
        refused: ()=>Atomics.load(control, DICT_REFUSED),
    };

    /** @param {number} at @param {number | string} value @returns {number} bytes */
    function putValue(at, value){
        if (typeof value === 'number')
        {
            view.setUint32(at, TAG_NUMBER, true);
            view.setFloat64(at + 4, value, true);
            return 12;
        }
        view.setUint32(at, TAG_STRING, true);
        return 4 + putString(at + 4, value, STRING_UNITS);
    }

    /** @param {number | string} value */
    function valueBytes(value){
        return typeof value === 'number' ? 12 : 4 + stringBytes(value);
    }

    return writer;
}

/** @param {unknown} value @returns {number | string} */
function asValue(value){
    return typeof value === 'number' ? value
        : typeof value === 'string' ? value
            : String(value);
}

/**
 * A reader's view of the block: the dictionary as it grows, and the records
 * by sequence. Stateless apart from the dictionary cache and the monotonic
 * count, so any number of these can read one block; what each has and has not
 * seen is its caller's cursor.
 *
 * @param {JournalViews} memory
 */
export function createJournalCursor(memory){
    const { control, view, index, records, ringBytes, ringOffset, dictOffset } = memory;
    const sequenceBase = memory.sequenceBase ?? 0;
    /** @type {string[]} */
    const words = [];
    let dictRead = 0;
    let written = 0;
    let lastWord = 0;

    const getString = (/** @type {number} */ at, /** @type {number} */ limit)=>{
        const units = view.getUint32(at, true);
        if (units > limit)
        {
            return null;
        }
        let text = '';
        let cursor = at + 4;
        for (let i = 0; i < units; i++)
        {
            text += String.fromCharCode(view.getUint16(cursor, true));
            cursor += 2;
        }
        return text;
    };

    /** Catches the cache up with what the writer has published. */
    const dictionary = ()=>{
        const count = Atomics.load(control, DICT_COUNT);
        while (words.length < count)
        {
            const text = getString(dictOffset + dictRead, STRING_UNITS);
            if (text === null)
            {
                break;
            }
            words.push(text);
            dictRead += align(4 + text.length * 2, 4);
        }
        return words;
    };

    /** Records ever written, monotonic; the sequence the next one gets. */
    const count = ()=>{
        const word = Atomics.load(control, WRITTEN) >>> 0;
        written += (word - lastWord) >>> 0;
        lastWord = word;
        return (sequenceBase + written) >>> 0;
    };

    return {
        /** @param {number} id */
        word(id){
            const known = dictionary();
            return id >= 0 && id < known.length ? known[id] : `#${id}`;
        },

        /** The sequence this block starts from; 0 unless it took over from one. */
        base: ()=>sequenceBase,

        written: count,

        /** The oldest sequence the index still points at. */
        oldest: ()=>Math.max(sequenceBase, count() - records),

        /**
         * One record by sequence, or null if it has been written over --
         * before this read, or during it, which the check at the end tells.
         *
         * @param {number} sequence
         * @returns {DecodedRecord | null}
         */
        read(sequence){
            const start = index[sequence % records] >>> 0;
            const base = ringOffset + (start % ringBytes);
            const length = view.getUint32(base, true);
            if (length < RECORD_HEADER || length > ringBytes
                || (start % ringBytes) + length > ringBytes)
            {
                return null;
            }
            const record = {
                sequence,
                time: view.getFloat64(base + 8, true),
                level: view.getUint8(base + 16),
                topic: view.getUint16(base + 18, true),
                template: view.getUint32(base + 20, true),
                inline: '',
                /** @type {(number | string)[]} */
                args: [],
            };
            const argc = view.getUint8(base + 17);
            const end = base + length;
            let at = base + RECORD_HEADER;
            if (record.template === INLINE_TEMPLATE)
            {
                const text = getString(at, STRING_UNITS);
                if (text === null)
                {
                    return null;
                }
                record.inline = text;
                at += align(4 + text.length * 2, 4);
            }
            for (let i = 0; i < argc && at + 4 <= end; i++)
            {
                const tag = view.getUint32(at, true);
                if (tag === TAG_NUMBER)
                {
                    record.args.push(view.getFloat64(at + 4, true));
                    at += 12;
                }
                else
                {
                    const text = getString(at + 4, STRING_UNITS);
                    if (text === null)
                    {
                        return null;
                    }
                    record.args.push(text);
                    at += 4 + align(4 + text.length * 2, 4);
                }
            }
            // The copy is only good if nothing reached these bytes while it
            // was taken, and if the index still pointed at this sequence.
            const headNow = Atomics.load(control, HEAD) >>> 0;
            if (((headNow - start) >>> 0) > ringBytes
                || view.getUint32(base + 4, true) !== (sequence >>> 0))
            {
                return null;
            }
            return record;
        },
    };
}
