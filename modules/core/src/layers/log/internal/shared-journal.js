/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The journal's storage: records one writer fills and any number of readers
 * on any thread decode, with neither ever waiting for the other.
 *
 * The engine writes a record and moves on. Whoever reads it -- a log worker,
 * the page, a sink on the same thread -- finds it in memory and formats it
 * there, so the thread being measured does no string work for a record nobody
 * reads and never answers a request for its log. When the memory is shared
 * the readers are on other threads; when it is not, they are on this one, and
 * nothing about the contract changes.
 *
 * Two parts, handed over as one object:
 *
 *  - the records, a Cellar journal (`vendor/cellar/`): one writer, readers by
 *    sequence, the oldest written over and a reader lapped mid-read told so;
 *  - a dictionary of strings written once each -- templates, categories, and
 *    any name a table wants to refer to by number -- so that a record carries
 *    ids and the reader looks the words up.
 *
 * A record is its time, level, argument count, topic and template id, then
 * the template inline when the dictionary had no room for it, then its
 * arguments, each a number or a string. The dictionary is published by
 * `Atomics.store` of its count, after its bytes.
 */

import { createJournalMemory as createRecords, openJournal } from '../../../../vendor/cellar/cellar.js';

/** Dictionary control words, at the start of its buffer. */
const DICT_COUNT = 0;
const DICT_HEAD = 1;
const DICT_REFUSED = 2;
const DICT_CONTROL_BYTES = 16;

/** A template the dictionary had no room for travels inline instead. */
export const INLINE_TEMPLATE = 0xffffffff;

const TAG_NUMBER = 0;
const TAG_STRING = 1;

/** Code units a string argument keeps; the rest is cut, which the reader can tell. */
const STRING_UNITS = 1024;
/** Time (8), level, argument count, topic (4), template (4). */
const RECORD_HEADER = 16;

/**
 * What a journal's memory is handed over as: its records and its dictionary.
 *
 * @typedef {{ records: import('../../../../vendor/cellar/cellar.js').JournalMemory,
 *     dictionary: ArrayBufferLike }} JournalBuffers
 */

/**
 * @typedef {Object} JournalViews
 * @property {JournalBuffers} buffer  what is handed to a reader
 * @property {import('../../../../vendor/cellar/cellar.js').Journal} journal
 * @property {Int32Array} dictControl
 * @property {DataView} dictView
 * @property {number} records
 * @property {number} ringBytes
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
 * @param {JournalBuffers} buffer
 * @returns {JournalViews}
 */
export function openJournalMemory(buffer){
    const journal = openJournal(buffer.records);
    const dictBytes = buffer.dictionary.byteLength - DICT_CONTROL_BYTES;
    return {
        buffer,
        journal,
        dictControl: new Int32Array(buffer.dictionary, 0, DICT_CONTROL_BYTES / 4),
        dictView: new DataView(buffer.dictionary, DICT_CONTROL_BYTES),
        records: journal.records,
        ringBytes: journal.maxRecord + 8,
        dictBytes,
        sequenceBase: journal.first(),
    };
}

/**
 * @param {Object} [options]
 * @param {number} [options.records]      Records the index remembers.
 * @param {number} [options.bytes]        Bytes of records, a power of two.
 * @param {number} [options.dictionary]   Bytes of the string dictionary.
 * @param {number} [options.sequenceBase]
 *        The sequence the first record gets. A machine rebuilt on a child's
 *        image starts a fresh block, and a reader holding a cursor from the one
 *        it replaced resumes here rather than at zero.
 * @returns {JournalViews}
 */
export function createJournalMemory(options = {}){
    const records = createRecords({
        records: Math.max(1, Math.floor(options.records ?? 4096)),
        bytes: Math.max(4096, options.bytes ?? 1024 * 1024),
        first: (options.sequenceBase ?? 0) >>> 0,
    });
    const dictBytes = align(Math.max(256, options.dictionary ?? 512 * 1024), 8);
    const dictionary = new SharedArrayBuffer(DICT_CONTROL_BYTES + dictBytes);
    return openJournalMemory({ records, dictionary });
}

/** @param {number} value @param {number} to */
const align = (value, to)=>Math.ceil(value / to) * to;

/**
 * The single writer. One per journal: two writers would race for its head.
 *
 * @param {JournalViews} memory
 */
export function createJournalWriter(memory){
    const { journal, dictControl, dictView, dictBytes } = memory;
    const view = new DataView(journal.bytes.buffer);
    /** @type {Map<string, number>} */
    const interned = new Map();
    let dictHead = 0;
    let dictCount = 0;
    /** Records too big for the journal, which cannot be written at all. */
    let oversized = 0;

    /**
     * @param {DataView} into
     * @param {number} at
     * @param {string} text
     * @param {number} limit
     * @returns {number} bytes used, a multiple of four
     */
    const putString = (into, at, text, limit)=>{
        const units = Math.min(text.length, limit);
        into.setUint32(at, units, true);
        let cursor = at + 4;
        for (let i = 0; i < units; i++)
        {
            into.setUint16(cursor, text.charCodeAt(i), true);
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
                Atomics.add(dictControl, DICT_REFUSED, 1);
                return -1;
            }
            putString(dictView, dictHead, text, STRING_UNITS);
            dictHead += bytes;
            const id = dictCount++;
            interned.set(text, id);
            // The bytes first, then the head, then the count that publishes
            // them: a reader that sees the count sees the entry.
            Atomics.store(dictControl, DICT_HEAD, dictHead);
            Atomics.store(dictControl, DICT_COUNT, dictCount);
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
            // Sized before it is reserved: a record is whole in the journal.
            // Anything that is not a number travels as the string it prints
            // as, which is what the reader would have made of it anyway.
            const arg0 = argc > 0 ? asValue(a) : 0;
            const arg1 = argc > 1 ? asValue(b) : 0;
            const arg2 = argc > 2 ? asValue(c) : 0;
            const arg3 = argc > 3 ? asValue(d) : 0;
            length += argc > 0 ? valueBytes(arg0) : 0;
            length += argc > 1 ? valueBytes(arg1) : 0;
            length += argc > 2 ? valueBytes(arg2) : 0;
            length += argc > 3 ? valueBytes(arg3) : 0;
            if (length > journal.maxRecord)
            {
                oversized++;
                return -1;
            }
            let at = journal.reserve(length);
            view.setFloat64(at, time, true);
            view.setUint8(at + 8, level);
            view.setUint8(at + 9, argc);
            view.setUint16(at + 10, Math.min(topic, 0xffff), true);
            view.setUint32(at + 12, template < 0 ? INLINE_TEMPLATE : template, true);
            at += RECORD_HEADER;
            if (template < 0)
            {
                at += putString(view, at, message, STRING_UNITS);
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
            return journal.commit();
        },

        written: ()=>journal.written(),
        oversized: ()=>oversized,
        refused: ()=>Atomics.load(dictControl, DICT_REFUSED),
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
        return 4 + putString(view, at + 4, value, STRING_UNITS);
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
 * @param {DataView} view @param {number} at @param {number} limit
 * @returns {string | null}  null where the length is past the limit (bytes not a string)
 */
const getString = (view, at, limit)=>{
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

/**
 * A reader's view of the journal: the dictionary as it grows, and the
 * records by sequence. Stateless apart from the dictionary cache, so any
 * number of these can read one journal; what each has and has not seen is
 * its caller's cursor.
 *
 * @param {JournalViews} memory
 */
export function createJournalCursor(memory){
    const { journal, dictControl, dictView } = memory;
    const view = new DataView(journal.bytes.buffer);
    /** @type {string[]} */
    const words = [];
    let dictRead = 0;

    /** Catches the cache up with what the writer has published. */
    const dictionary = ()=>{
        const count = Atomics.load(dictControl, DICT_COUNT);
        while (words.length < count)
        {
            const text = getString(dictView, dictRead, STRING_UNITS);
            if (text === null)
            {
                break;
            }
            words.push(text);
            dictRead += align(4 + text.length * 2, 4);
        }
        return words;
    };

    return {
        /** @param {number} id */
        word(id){
            const known = dictionary();
            return id >= 0 && id < known.length ? known[id] : `#${id}`;
        },

        /** The sequence this journal starts from; 0 unless it took over from one. */
        base: ()=>journal.first(),

        /** Records ever written; the sequence the next one gets. */
        written: ()=>journal.written(),

        /** The oldest sequence the journal still holds. */
        oldest: ()=>journal.oldest(),

        /**
         * One record by sequence, or null if it has been written over --
         * before this read, or during it.
         *
         * @param {number} sequence
         * @returns {DecodedRecord | null}
         */
        read(sequence){
            const base = journal.find(sequence);
            if (base < 0)
            {
                return null;
            }
            const length = journal.lengthAt(base);
            if (length < RECORD_HEADER)
            {
                return null;
            }
            const record = {
                sequence: sequence >>> 0,
                time: view.getFloat64(base, true),
                level: view.getUint8(base + 8),
                topic: view.getUint16(base + 10, true),
                template: view.getUint32(base + 12, true),
                inline: '',
                /** @type {(number | string)[]} */
                args: [],
            };
            const argc = view.getUint8(base + 9);
            const end = base + length;
            let at = base + RECORD_HEADER;
            if (record.template === INLINE_TEMPLATE)
            {
                const text = getString(view, at, STRING_UNITS);
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
                    const text = getString(view, at + 4, STRING_UNITS);
                    if (text === null)
                    {
                        return null;
                    }
                    record.args.push(text);
                    at += 4 + align(4 + text.length * 2, 4);
                }
            }
            // Decoded where it lies: good only if the writer reached none of it.
            return journal.intact() ? record : null;
        },
    };
}
