/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Recorded calls as bytes: one record a batch, written as the calls are made
 * where the played side reads them -- a root's ring (`ring.js`) -- so that a
 * frame of thousands of calls crosses as a few records rather than as
 * thousands of objects to clone.
 *
 * A value is a tag and what it holds: a number as a 32-bit integer or a
 * double, a string by its number in a table both ends build -- its text
 * where it is first sent -- bytes aligned to eight so the reader views them
 * where they lie, an array or a structure member by member, and one of the
 * device's objects by its number. A structure is a shape, its keys, which
 * both ends number as it is first sent from a place (`Site`), and its values.
 *
 * A call is its object's number, its method, its arguments, and after them
 * what making it gave: the guest addresses its allocations got, what the
 * caller's services answered, the bytes to put in place before it is played
 * and after, and whether -- and as which -- the caller waits for its answer.
 */

import { textOf } from '@bottlify/cellar';

/** What a record is. */
export const OP = { CALL: 1, GET: 2, SET: 3, WROTE: 4, LENT: 5 };

/** A string's number when it is sent for the first time, its text following. */
const NEW_STRING = 0xffffffff;
/** A string sent where it stands, its text following, and not numbered. */
const INLINE_STRING = 0xfffffffe;

const TAG = {
    UNDEFINED: 0, NULL: 1, FALSE: 2, TRUE: 3, INT: 4, DOUBLE: 5, STRING: 6, ARRAY: 7,
    OBJECT: 8, BYTES: 9, REF: 10, SERVICE: 11, NEW_SHAPE: 12, SHAPE: 13, FLAT: 14,
    MAP: 15, SET: 16,
};

/**
 * What a place in a call -- an argument of one method, a member of one, an
 * element of one -- was given the last time: the keys of the structure, in
 * order, and the shape's number on the wire. A structure in the same place
 * with the same keys goes as that number and its values, the keys unsent;
 * the call sites of a program pass the same structures every time. One whose
 * every member is a number, or such a structure itself -- a light, a
 * material, a viewport -- goes flat: the number and the members' values as
 * doubles, depth first, with no tag between them.
 *
 * @typedef {{ keys: string[] | null, id: number, members: (Site | undefined)[],
 *     element?: Site, flat: boolean, leaves: number }} Site
 */

/** @returns {Site} */
export function createSite(){
    return { keys: null, id: -1, members: [], flat: false, leaves: 0 };
}

/** @param {Site} site @param {number} index */
const memberSite = (site, index)=>(site.members[index] ??= createSite());

/** The kinds of typed array, by number. */
const ARRAYS = [Uint8Array, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array,
    Float32Array, Float64Array, Uint8ClampedArray];
/** @type {Map<Function, number>} */
const KINDS = new Map(ARRAYS.map((type, kind)=>[type, kind]));

/** What a call record holds after its arguments, one bit each. */
export const SECTION = { ALLOCS: 1, REPLIES: 2, SHIP: 4, WROTE: 8 };

/** How the caller waits for a call: not at all, for its answer, or when the played side holds it. */
export const WAIT = { NONE: 0, ANSWER: 1, PACED: 2 };

/**
 * What a value of the device's is on the wire: its number, `SERVICE_REF` for
 * a service of the caller's, or undefined for anything else -- which is sent
 * member by member, unless a member is a function: then it is an object of
 * another device's, and goes as null, or as a service when it is an argument
 * itself, which `value` says.
 *
 * @typedef {(object: object) => number | undefined} RefOf
 */
export const SERVICE_REF = -1;

const encoder = new TextEncoder();

/**
 * Buffers given back to a writer, kept to write on again: as many as the
 * batches in flight at once, and none past 1 MiB, so one large upload's batch
 * does not hold its memory for good.
 */
const SPARE_BUFFERS = 4;
const SPARE_LARGEST = 1 << 20;

/** Where a writer that builds its batches in place has none yet: its first write asks for room. */
const UNPLACED = new Uint8Array(0);

/**
 * The writing end.
 *
 * A writer given `place` builds each batch where it is read -- in a ring's
 * room (`ring.js`) -- rather than in a buffer of its own that is copied
 * there: the first write of a batch asks `place` for room, and a batch that
 * outgrows it, or finds none, goes on in this side's own buffer, which its
 * sender then copies over (`spilled`). `placed` says which of the two holds
 * the batch.
 *
 * @param {Object} [options]
 * @param {((least: number) => Uint8Array | null) | null} [options.place]  room for at least
 *     `least` bytes, at a multiple of eight in its buffer, or null where there is none now
 * @param {() => void} [options.unplaced]  the room `place` gave goes back unused: the
 *     batch outgrew it
 * @param {number} [options.strings]  how many strings are numbered, their text sent once,
 *     as a program's names are; past that each is written where it stands: a bound
 *     for what says something new every time -- a failure, a divergence
 */
export function createWriter({ place = null, unplaced = ()=>{}, strings: most = Infinity } = {}){
    /** This side's own buffer, written on when nothing is placed. */
    let own = new ArrayBuffer(1 << 16);
    /** @type {Uint8Array} */
    let bytes = place ? UNPLACED : new Uint8Array(own);
    /** @type {DataView} */
    let view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 0;
    /** Whether the batch is being built in the room `place` gave. */
    let placed = false;
    /** @type {Map<string, number>} */
    const strings = new Map();
    /** The strings by number, to forget those defined in what is taken back. @type {string[]} */
    const defined = [];
    /** The places whose shapes were sent, by the shape's number. @type {Site[]} */
    const shaped = [];
    /** Buffers given back (`reuse`). @type {ArrayBuffer[]} */
    const spare = [];
    /**
     * Buffers made, and the batches that outgrew theirs: each a buffer twice
     * the size and a copy of what was written (`copied`, in bytes). A buffer
     * that grew comes back grown and is written on again, so in a steady run
     * both stay still: what moves them is a batch with no buffer back to
     * write on, or one past `SPARE_LARGEST`. `spilled` counts the batches
     * that outgrew the room they were placed in, copied out of it.
     */
    const figures = { made: 1, grown: 0, copied: 0, spilled: 0 };

    /** @param {Uint8Array} next */
    const writeOn = next=>{
        bytes = next;
        view = new DataView(next.buffer, next.byteOffset, next.byteLength);
    };
    /** @param {number} more */
    const room = more=>{
        if (at + more <= bytes.length)
        {
            return;
        }
        if (place && !placed && at === 0)
        {
            const given = place(more);
            if (given)
            {
                placed = true;
                writeOn(given);
                if (more <= given.length)
                {
                    return;
                }
            }
        }
        let size = own.byteLength;
        while (size < at + more)
        {
            size *= 2;
        }
        if (placed)
        {
            placed = false;
            unplaced();
            figures.spilled++;
        }
        else if (at > 0)
        {
            figures.grown++;
        }
        if (size > own.byteLength)
        {
            own = new ArrayBuffer(size);
            figures.made++;
        }
        if (at > 0)
        {
            new Uint8Array(own).set(bytes.subarray(0, at));
            figures.copied += at;
        }
        writeOn(new Uint8Array(own));
    };
    /** @param {number} value */
    const u8 = value=>{
        room(1);
        bytes[at++] = value;
    };
    /** @param {number} value */
    const u32 = value=>{
        room(4);
        view.setUint32(at, value >>> 0, true);
        at += 4;
    };
    /**
     * @param {string} text
     * @returns {number} its number, which may be written for it from here on
     */
    const string = text=>{
        const id = strings.get(text);
        if (id !== undefined)
        {
            u32(id);
            return id;
        }
        const numbered = strings.size < most;
        if (numbered)
        {
            strings.set(text, strings.size);
            defined.push(text);
        }
        const encoded = encoder.encode(text);
        room(8 + encoded.length);
        view.setUint32(at, numbered ? NEW_STRING : INLINE_STRING, true);
        view.setUint32(at + 4, encoded.length, true);
        at += 8;
        bytes.set(encoded, at);
        at += encoded.length;
        return numbered ? strings.size - 1 : -1;
    };
    /**
     * What was written from `start` is taken back, and the strings and
     * shapes it defined with it.
     *
     * @param {number} start @param {number} knownStrings @param {number} knownShapes
     */
    const takeBack = (start, knownStrings, knownShapes)=>{
        at = start;
        while (defined.length > knownStrings)
        {
            strings.delete(/** @type {string} */ (defined.pop()));
        }
        while (shaped.length > knownShapes)
        {
            /** @type {Site} */ (shaped.pop()).keys = null;
        }
    };
    /** @param {ArrayBufferView} array */
    const typed = array=>{
        const kind = KINDS.get(array.constructor) ?? -1;
        if (kind < 0)
        {
            throw new TypeError('remote: a call passed bytes of a kind the wire does not carry');
        }
        const length = array.byteLength;
        room(16 + length);
        bytes[at++] = TAG.BYTES;
        bytes[at++] = kind;
        view.setUint32(at, length, true);
        at += 4;
        at = (at + 7) & ~7;
        bytes.set(new Uint8Array(array.buffer, array.byteOffset, length), at);
        at += length;
    };

    /**
     * @param {any} item @param {RefOf} refOf @param {number} [depth]
     * @param {Site} [site]  where in a call the value is, for a structure's shape
     * @returns {boolean} whether an argument was a service, sent as one
     */
    const value = (item, refOf, depth = 0, site = undefined)=>{
        switch (typeof item)
        {
            case 'number':
                if ((item | 0) === item && !Object.is(item, -0))
                {
                    room(5);
                    bytes[at++] = TAG.INT;
                    view.setInt32(at, item, true);
                    at += 4;
                }
                else
                {
                    room(9);
                    bytes[at++] = TAG.DOUBLE;
                    view.setFloat64(at, item, true);
                    at += 8;
                }
                return false;
            case 'boolean':
                u8(item ? TAG.TRUE : TAG.FALSE);
                return false;
            case 'undefined':
            case 'symbol':
                // A symbol is the caller's own mark -- what an out-structure
                // held before the call -- and means nothing to a device.
                u8(TAG.UNDEFINED);
                return false;
            case 'string':
                u8(TAG.STRING);
                string(item);
                return false;
            case 'object':
                break;
            default:
                throw new TypeError(
                    `remote: a call passed a ${typeof item}, which cannot be replayed`);
        }
        if (item === null || depth > 16)
        {
            u8(TAG.NULL);
            return false;
        }
        if (ArrayBuffer.isView(item))
        {
            typed(item);
            return false;
        }
        const ref = refOf(item);
        if (ref !== undefined)
        {
            if (ref === SERVICE_REF)
            {
                u8(TAG.SERVICE);
            }
            else
            {
                room(5);
                bytes[at++] = TAG.REF;
                view.setUint32(at, ref, true);
                at += 4;
            }
            return false;
        }
        if (item instanceof Map || item instanceof Set)
        {
            u8(item instanceof Map ? TAG.MAP : TAG.SET);
            u32(item.size);
            for (const entry of item)
            {
                if (item instanceof Map)
                {
                    value(entry[0], refOf, depth + 1);
                    value(entry[1], refOf, depth + 1);
                }
                else
                {
                    value(entry, refOf, depth + 1);
                }
            }
            return false;
        }
        if (Array.isArray(item))
        {
            u8(TAG.ARRAY);
            u32(item.length);
            const element = site ? (site.element ??= createSite()) : undefined;
            for (let index = 0; index < item.length; index++)
            {
                value(item[index], refOf, depth + 1, element);
            }
            return false;
        }
        const start = at;
        const knownStrings = defined.length;
        const knownShapes = shaped.length;
        if (site?.keys && site.flat)
        {
            room(5 + site.leaves * 8);
            bytes[at++] = TAG.FLAT;
            view.setUint32(at, site.id, true);
            at += 4;
            if (flat(item, site))
            {
                return false;
            }
            at = start;
        }
        if (site?.keys)
        {
            const keys = site.keys;
            room(5);
            bytes[at++] = TAG.SHAPE;
            view.setUint32(at, site.id, true);
            at += 4;
            let index = 0;
            let fits = true;
            for (const key in item)
            {
                const member = item[key];
                if (index >= keys.length || key !== keys[index] || typeof member === 'function')
                {
                    fits = false;
                    break;
                }
                value(member, refOf, depth + 1, memberSite(site, index));
                index++;
            }
            if (fits && index === keys.length)
            {
                return false;
            }
            takeBack(start, knownStrings, knownShapes);
        }
        u8(site ? TAG.NEW_SHAPE : TAG.OBJECT);
        room(4);
        const counted = at;
        at += 4;
        /** @type {string[]} */
        const keys = [];
        if (site)
        {
            site.members = [];
        }
        for (const key in item)
        {
            const member = item[key];
            if (typeof member === 'function')
            {
                // An object with methods that is not the device's own; what
                // was written of it is taken back.
                takeBack(start, knownStrings, knownShapes);
                u8(depth === 0 ? TAG.SERVICE : TAG.NULL);
                return depth === 0;
            }
            string(key);
            value(member, refOf, depth + 1, site ? memberSite(site, keys.length) : undefined);
            keys.push(key);
        }
        view.setUint32(counted, keys.length, true);
        if (site)
        {
            // Flat when every member is a number or a flat structure of its
            // own: what the reader works out from the same values' tags.
            let leaves = 0;
            let flatAll = true;
            for (let index = 0; index < keys.length && flatAll; index++)
            {
                const member = item[keys[index]];
                const child = site.members[index];
                if (typeof member === 'number')
                {
                    leaves++;
                }
                else if (member !== null && typeof member === 'object' && child?.keys && child.flat
                    && child.id >= knownShapes)
                {
                    leaves += child.leaves;
                }
                else
                {
                    flatAll = false;
                }
            }
            site.flat = flatAll;
            site.leaves = leaves;
            site.keys = keys;
            site.id = shaped.length;
            shaped.push(site);
        }
        return false;
    };

    /**
     * A structure's values as doubles, depth first, in its place's shape;
     * false when it is not that shape, or a value is not a number.
     *
     * @param {any} item @param {Site} site
     * @returns {boolean}
     */
    const flat = (item, site)=>{
        const keys = /** @type {string[]} */ (site.keys);
        let index = 0;
        for (const key in item)
        {
            if (index >= keys.length || key !== keys[index])
            {
                return false;
            }
            const member = item[key];
            if (typeof member === 'number')
            {
                if (site.members[index]?.keys)
                {
                    return false;
                }
                view.setFloat64(at, member, true);
                at += 8;
            }
            else
            {
                const child = site.members[index];
                if (member === null || typeof member !== 'object' || !child?.keys
                    || !flat(member, child))
                {
                    return false;
                }
            }
            index++;
        }
        return index === keys.length;
    };

    const writer = {
        u8,
        u32,
        value,
        string,
        /**
         * A call record's head: its object, its method by a number `string`
         * gave, and how many arguments follow.
         *
         * @param {number} target @param {number} name @param {number} count
         */
        call(target, name, count){
            room(10);
            bytes[at] = OP.CALL;
            view.setUint32(at + 1, target, true);
            view.setUint32(at + 5, name, true);
            bytes[at + 9] = count;
            at += 10;
        },
        /**
         * Guest memory: its address and its bytes.
         *
         * @param {number} address @param {Uint8Array} data
         */
        memory(address, data){
            u32(address);
            typed(data);
        },
        /** Whether anything has been written since the last `give` or `published`. */
        empty: ()=>at === 0,
        /**
         * This side's own buffer written on, and how much of it is written:
         * what is copied or read elsewhere and comes back (`reuse`), where a
         * buffer of its own for every batch would be hundreds of fresh ones
         * a second, whose memory outside the heap drives a thread's full
         * collections. Writing goes on in one given back, or a fresh one.
         *
         * @returns {{ buffer: ArrayBuffer, length: number }}
         */
        give(){
            if (placed)
            {
                throw new Error('remote: a batch built in place is published where it lies,'
                    + ' not given');
            }
            const given = { buffer: own, length: at };
            let next = spare.pop();
            if (!next)
            {
                next = new ArrayBuffer(1 << 16);
                figures.made++;
            }
            own = next;
            writeOn(place ? UNPLACED : new Uint8Array(own));
            at = 0;
            return given;
        },
        /** Whether the batch written is in the room `place` gave, rather than this side's own buffer. */
        placed: ()=>placed,
        /**
         * The batch built in place has been published where it lies: the
         * next one asks for room of its own.
         */
        published(){
            placed = false;
            writeOn(UNPLACED);
            at = 0;
        },
        /**
         * Takes back a buffer `give` gave, read and done with, to write on
         * again: a few of them, none grown past `SPARE_LARGEST`.
         *
         * @param {ArrayBuffer} returned
         */
        reuse(returned){
            if (spare.length < SPARE_BUFFERS && returned.byteLength <= SPARE_LARGEST
                && returned.byteLength > 0)
            {
                spare.push(returned);
            }
        },
        /** How many bytes are written. */
        size: ()=>at,
        /** Buffers made, batches grown and batches spilled so far (`figures` above). */
        figures: ()=>({ ...figures }),
    };
    return writer;
}

/**
 * @typedef {Object} ReadCall
 * @property {number} op
 * @property {number} t
 * @property {string} [m]          the method, or the property got or set
 * @property {any[]} [a]           its arguments
 * @property {any} [v]             the value set
 * @property {number[]} [allocs]
 * @property {any[]} [replies]
 * @property {{ address: number, bytes: Uint8Array }[]} [ship]
 * @property {{ address: number, bytes: Uint8Array }[]} [wrote]
 * @property {Uint32Array} [lent]  guest memory the played side reads in place, by its
 *     lend's slot (`lending.js`): three words a lend - address, length, slot - in the
 *     reader's own words, good until the next record
 * @property {number} lentCount  how many lends `lent` holds
 * @property {number} [wait]       one of `WAIT`
 * @property {number} [serial]     a waited call's number, which its answer comes back under
 */

/** What a reader looks at between batches. */
const NO_BATCH = new ArrayBuffer(0);

/**
 * The reading end: its string table outlives every batch.
 *
 * Reading is the largest part of what a batch costs the played side's
 * thread, and what it costs is objects and calls, not bytes. So the batch
 * and the place in it are the reader's own, set by `read` rather than held
 * by functions made again for every batch; every call is one object of one
 * layout, all its fields there from the start, rather than one that grows a
 * field at a time into a layout of its own for each kind of record; and an
 * integer argument, most of them, is read where the arguments are.
 *
 * A batch may lie in shared memory -- a ring's record, read in place -- at
 * an offset of its buffer (`read`'s `start`, a multiple of eight as the
 * writer's room is): its bytes are viewed there, its text copied out first,
 * as a browser decodes no view of shared memory.
 *
 * @param {Object} options
 * @param {(number: number) => any} options.ref      a device object by its number
 * @param {() => any} options.service                 what stands in for a caller's service
 * @param {boolean} [options.owned]  bytes are copied out of the batch rather than
 *     viewed where they lie: for values kept past the reading, as answers are
 */
export function createReader({ ref, service, owned = false }){
    /** @type {string[]} */
    const strings = [];
    /**
     * Each shape: its keys, and for a flat one each member's child shape, or
     * -1 for a number.
     *
     * @type {{ keys: string[], kinds: number[] | null }[]}
     */
    const shapes = [];
    /** The batch being read and where in it: `read`'s, the one before put back after it. */
    /** @type {ArrayBufferLike} */
    let buffer = NO_BATCH;
    /** @type {DataView} */
    let view = new DataView(NO_BATCH);
    /** @type {Uint8Array} */
    let bytes = new Uint8Array(NO_BATCH);
    let at = 0;
    /** Where in `buffer` the batch begins. */
    let base = 0;

    const u32 = ()=>{
        const value = view.getUint32(at, true);
        at += 4;
        return value;
    };
    /** @param {number} length */
    const textAt = length=>{
        const text = textOf(bytes.subarray(at, at + length));
        at += length;
        return text;
    };
    const string = ()=>{
        const id = u32();
        if (id === INLINE_STRING)
        {
            return textAt(u32());
        }
        if (id !== NEW_STRING)
        {
            return strings[id];
        }
        const text = textAt(u32());
        strings.push(text);
        return text;
    };
    const typed = ()=>{
        const kind = bytes[at];
        const length = view.getUint32(at + 1, true);
        at = (at + 12) & ~7;
        const type = ARRAYS[kind];
        const array = new type(/** @type {ArrayBuffer} */ (buffer), base + at,
            length / type.BYTES_PER_ELEMENT);
        at += length;
        return owned ? array.slice() : array;
    };
    /**
     * @param {{ keys: string[], kinds: number[] | null }} shape
     * @returns {Record<string, any>}
     */
    const flat = shape=>{
        const kinds = /** @type {number[]} */ (shape.kinds);
        const keys = shape.keys;
        /** @type {Record<string, any>} */
        const out = {};
        for (let index = 0; index < kinds.length; index++)
        {
            if (kinds[index] < 0)
            {
                out[keys[index]] = view.getFloat64(at, true);
                at += 8;
            }
            else
            {
                out[keys[index]] = flat(shapes[kinds[index]]);
            }
        }
        return out;
    };
    /** @returns {any} */
    const value = ()=>{
        const tag = bytes[at++];
        switch (tag)
        {
            case TAG.INT:
            {
                const read = view.getInt32(at, true);
                at += 4;
                return read;
            }
            case TAG.DOUBLE:
            {
                const read = view.getFloat64(at, true);
                at += 8;
                return read;
            }
            case TAG.UNDEFINED: return undefined;
            case TAG.NULL: return null;
            case TAG.FALSE: return false;
            case TAG.TRUE: return true;
            case TAG.STRING: return string();
            case TAG.MAP:
            case TAG.SET:
            {
                const size = u32();
                if (tag === TAG.SET)
                {
                    const out = new Set();
                    for (let index = 0; index < size; index++)
                    {
                        out.add(value());
                    }
                    return out;
                }
                const out = new Map();
                for (let index = 0; index < size; index++)
                {
                    const key = value();
                    out.set(key, value());
                }
                return out;
            }
            case TAG.BYTES: return typed();
            case TAG.REF: return ref(u32());
            case TAG.SERVICE: return service();
            case TAG.FLAT: return flat(shapes[u32()]);
            case TAG.ARRAY:
            {
                const length = u32();
                const out = new Array(length);
                for (let index = 0; index < length; index++)
                {
                    out[index] = value();
                }
                return out;
            }
            case TAG.OBJECT:
            case TAG.NEW_SHAPE:
            {
                const count = u32();
                const known = shapes.length;
                /** @type {Record<string, any>} */
                const out = {};
                /** @type {string[]} */
                const keys = [];
                /** @type {number[] | null} */
                let kinds = [];
                for (let index = 0; index < count; index++)
                {
                    const key = string();
                    keys.push(key);
                    const kind = bytes[at];
                    out[key] = value();
                    if (kind === TAG.INT || kind === TAG.DOUBLE)
                    {
                        kinds?.push(-1);
                    }
                    else if (kind === TAG.NEW_SHAPE && shapes.length > known
                        && shapes[shapes.length - 1].kinds)
                    {
                        kinds?.push(shapes.length - 1);
                    }
                    else
                    {
                        kinds = null;
                    }
                }
                if (tag === TAG.NEW_SHAPE)
                {
                    shapes.push({ keys, kinds });
                }
                return out;
            }
            case TAG.SHAPE:
            {
                const { keys } = shapes[u32()];
                /** @type {Record<string, any>} */
                const out = {};
                for (let index = 0; index < keys.length; index++)
                {
                    out[keys[index]] = value();
                }
                return out;
            }
            default:
                throw new Error(`remote: a value of tag ${tag} on the wire`);
        }
    };
    /** @returns {{ address: number, bytes: Uint8Array }[]} */
    const memories = ()=>{
        const count = u32();
        const out = new Array(count);
        for (let index = 0; index < count; index++)
        {
            const address = u32();
            at++;
            out[index] = { address, bytes: /** @type {Uint8Array} */ (typed()) };
        }
        return out;
    };
    /** The lends of the record read, three words each, grown to the most a record held. */
    let lends = new Uint32Array(48);
    /** Readings under way, one inside another's `each`. */
    let reading = 0;
    /** @returns {ReadCall} */
    const freshCall = ()=>({ op: 0, t: 0, m: undefined, a: undefined, v: undefined,
        allocs: undefined, replies: undefined, ship: undefined, wrote: undefined, lent: undefined,
        lentCount: 0, wait: undefined, serial: undefined });
    /**
     * The next record, read into `call`, every field set again: one call a
     * batch rather than one a record, which with an object a lend was a
     * measured share of the played side's garbage.
     *
     * @param {ReadCall} call @returns {ReadCall}
     */
    const record = call=>{
        const op = bytes[at++];
        call.op = op;
        call.t = 0;
        call.m = undefined;
        call.a = undefined;
        call.v = undefined;
        call.allocs = undefined;
        call.replies = undefined;
        call.ship = undefined;
        call.wrote = undefined;
        call.lent = undefined;
        call.lentCount = 0;
        call.wait = undefined;
        call.serial = undefined;
        if (op === OP.LENT)
        {
            const count = u32();
            if (lends.length < count * 3)
            {
                lends = new Uint32Array(count * 3);
            }
            for (let index = 0; index < count * 3; index++)
            {
                lends[index] = u32();
            }
            call.lent = lends;
            call.lentCount = count;
            return call;
        }
        if (op === OP.WROTE)
        {
            call.wrote = memories();
            return call;
        }
        call.t = view.getUint32(at, true);
        const name = view.getUint32(at + 4, true);
        if (name === NEW_STRING || name === INLINE_STRING)
        {
            at += 4;
            call.m = string();
        }
        else
        {
            at += 8;
            call.m = strings[name];
        }
        if (op === OP.SET)
        {
            call.v = value();
            return call;
        }
        if (op !== OP.CALL)
        {
            return call;
        }
        const count = bytes[at++];
        const args = call.a = new Array(count);
        for (let index = 0; index < count; index++)
        {
            if (bytes[at] === TAG.INT)
            {
                args[index] = view.getInt32(at + 1, true);
                at += 5;
            }
            else
            {
                args[index] = value();
            }
        }
        const sections = bytes[at++];
        if (sections & SECTION.ALLOCS)
        {
            const allocs = call.allocs = new Array(u32());
            for (let index = 0; index < allocs.length; index++)
            {
                allocs[index] = u32();
            }
        }
        if (sections & SECTION.REPLIES)
        {
            const replies = call.replies = new Array(u32());
            for (let index = 0; index < replies.length; index++)
            {
                replies[index] = value();
            }
        }
        if (sections & SECTION.SHIP)
        {
            call.ship = memories();
        }
        if (sections & SECTION.WROTE)
        {
            call.wrote = memories();
        }
        const wait = call.wait = bytes[at++];
        if (wait === WAIT.ANSWER)
        {
            call.serial = u32();
        }
        return call;
    };
    return {
        /**
         * Every record of a batch, in order, each read into the one call of
         * this reading: a call is good until `each` returns, and what a
         * waited call needs after (its serial) is taken from it there. What a
         * record holds of the batch's bytes is a view of them, good until the
         * reading returns: the bytes are then written over by a batch to
         * come, so what is kept of them past `each` is copied. Its arguments
         * are an array of its own, which may be kept.
         *
         * @param {ArrayBufferLike} batch
         * @param {(call: ReadCall) => boolean | void} each  false stops the reading
         * @param {number} [size]  how much of the buffer the batch is, all of it by default
         * @param {number} [start]  where in the buffer it begins, a multiple of eight
         */
        read(batch, each, size = undefined, start = 0){
            size ??= batch.byteLength - start;
            const outer = { buffer, view, bytes, at, base };
            // A reading inside another's `each` lends into words of its own:
            // the outer record's lends are still being read.
            const outerLends = lends;
            if (reading > 0)
            {
                lends = new Uint32Array(lends.length);
            }
            reading++;
            buffer = batch;
            view = new DataView(batch, start, size);
            bytes = new Uint8Array(batch, start, size);
            at = 0;
            base = start;
            try
            {
                const call = freshCall();
                let more = at < size;
                while (more)
                {
                    more = each(record(call)) !== false && at < size;
                }
            }
            finally
            {
                ({ buffer, view, bytes, at, base } = outer);
                lends = outerLends;
                reading--;
            }
        },
        /**
         * The one value `size` bytes at `start` of the buffer hold, as a
         * writer's `value` wrote it.
         *
         * @param {ArrayBufferLike} batch @param {number} size @param {number} [start]
         * @returns {any}
         */
        value(batch, size, start = 0){
            const outer = { buffer, view, bytes, at, base };
            buffer = batch;
            view = new DataView(batch, start, size);
            bytes = new Uint8Array(batch, start, size);
            at = 0;
            base = start;
            try
            {
                return value();
            }
            finally
            {
                ({ buffer, view, bytes, at, base } = outer);
            }
        },
    };
}
