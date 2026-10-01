/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Recorded calls as bytes: one buffer a batch, written as the calls are made
 * and read where they are played, so that a frame of thousands of calls
 * crosses as one transfer rather than as thousands of objects to clone.
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

/** What a record is. */
export const OP = { CALL: 1, GET: 2, SET: 3, WROTE: 4 };

/** A string's number when it is sent for the first time, its text following. */
const NEW_STRING = 0xffffffff;

const TAG = {
    UNDEFINED: 0, NULL: 1, FALSE: 2, TRUE: 3, INT: 4, DOUBLE: 5, STRING: 6, ARRAY: 7,
    OBJECT: 8, BYTES: 9, REF: 10, SERVICE: 11, NEW_SHAPE: 12, SHAPE: 13, FLAT: 14,
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
const decoder = new TextDecoder();

/** The writing end. */
export function createWriter(){
    let buffer = new ArrayBuffer(1 << 16);
    let view = new DataView(buffer);
    let bytes = new Uint8Array(buffer);
    let at = 0;
    /** @type {Map<string, number>} */
    const strings = new Map();
    /** The strings by number, to forget those defined in what is taken back. @type {string[]} */
    const defined = [];
    /** The places whose shapes were sent, by the shape's number. @type {Site[]} */
    const shaped = [];

    /** @param {number} more */
    const room = more=>{
        if (at + more <= buffer.byteLength)
        {
            return;
        }
        let size = buffer.byteLength * 2;
        while (size < at + more)
        {
            size *= 2;
        }
        const grown = new ArrayBuffer(size);
        new Uint8Array(grown).set(bytes.subarray(0, at));
        buffer = grown;
        view = new DataView(buffer);
        bytes = new Uint8Array(buffer);
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
        strings.set(text, strings.size);
        defined.push(text);
        const encoded = encoder.encode(text);
        room(8 + encoded.length);
        view.setUint32(at, NEW_STRING, true);
        view.setUint32(at + 4, encoded.length, true);
        at += 8;
        bytes.set(encoded, at);
        at += encoded.length;
        return strings.size - 1;
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
        /** Whether anything has been written since the last `take`. */
        empty: ()=>at === 0,
        /**
         * What has been written, as a buffer of its own, and a fresh one to
         * write on.
         *
         * @returns {ArrayBuffer}
         */
        take(){
            const taken = buffer.slice(0, at);
            at = 0;
            return taken;
        },
        /** How many bytes are written. */
        size: ()=>at,
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
 * @property {number} [wait]       one of `WAIT`
 * @property {number} [serial]     a waited call's number, which its answer comes back under
 */

/**
 * The reading end: its string table outlives every batch.
 *
 * @param {Object} options
 * @param {(number: number) => any} options.ref      a device object by its number
 * @param {() => any} options.service                 what stands in for a caller's service
 */
export function createReader({ ref, service }){
    /** @type {string[]} */
    const strings = [];
    /**
     * Each shape: its keys, and for a flat one each member's child shape, or
     * -1 for a number.
     *
     * @type {{ keys: string[], kinds: number[] | null }[]}
     */
    const shapes = [];
    return {
        /**
         * Every record of a batch, in order. What a record holds of the
         * batch's bytes is a view of them, so the batch is never written again.
         *
         * @param {ArrayBuffer} buffer
         * @param {(call: ReadCall) => boolean | void} each  false stops the reading
         */
        read(buffer, each){
            const view = new DataView(buffer);
            const bytes = new Uint8Array(buffer);
            let at = 0;
            const u8 = ()=>bytes[at++];
            const u32 = ()=>{
                const value = view.getUint32(at, true);
                at += 4;
                return value;
            };
            const string = ()=>{
                const id = u32();
                if (id !== NEW_STRING)
                {
                    return strings[id];
                }
                const length = u32();
                const text = decoder.decode(bytes.subarray(at, at + length));
                at += length;
                strings.push(text);
                return text;
            };
            const typed = ()=>{
                const kind = u8();
                const length = u32();
                at = (at + 7) & ~7;
                const type = ARRAYS[kind];
                const array = new type(buffer, at, length / type.BYTES_PER_ELEMENT);
                at += length;
                return array;
            };
            /**
             * @param {{ keys: string[], kinds: number[] | null }} shape
             * @returns {Record<string, any>}
             */
            const flat = shape=>{
                const kinds = /** @type {number[]} */ (shape.kinds);
                /** @type {Record<string, any>} */
                const out = {};
                for (let index = 0; index < kinds.length; index++)
                {
                    if (kinds[index] < 0)
                    {
                        out[shape.keys[index]] = view.getFloat64(at, true);
                        at += 8;
                    }
                    else
                    {
                        out[shape.keys[index]] = flat(shapes[kinds[index]]);
                    }
                }
                return out;
            };
            /** @returns {any} */
            const value = ()=>{
                const tag = u8();
                switch (tag)
                {
                    case TAG.UNDEFINED: return undefined;
                    case TAG.NULL: return null;
                    case TAG.FALSE: return false;
                    case TAG.TRUE: return true;
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
                    case TAG.STRING: return string();
                    case TAG.BYTES: return typed();
                    case TAG.REF: return ref(u32());
                    case TAG.SERVICE: return service();
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
                    case TAG.FLAT: return flat(shapes[u32()]);
                    default:
                        throw new Error(`remote: a value of tag ${tag} on the wire`);
                }
            };
            const memory = ()=>{
                const address = u32();
                at++;
                return { address, bytes: /** @type {Uint8Array} */ (typed()) };
            };
            while (at < bytes.length)
            {
                const op = u8();
                /** @type {ReadCall} */
                const call = { op, t: 0 };
                if (op === OP.WROTE)
                {
                    const count = u32();
                    call.wrote = [];
                    for (let index = 0; index < count; index++)
                    {
                        call.wrote.push(memory());
                    }
                }
                else
                {
                    call.t = u32();
                    call.m = string();
                    if (op === OP.SET)
                    {
                        call.v = value();
                    }
                    else if (op === OP.CALL)
                    {
                        const count = u8();
                        call.a = new Array(count);
                        for (let index = 0; index < count; index++)
                        {
                            call.a[index] = value();
                        }
                        const sections = u8();
                        if (sections & SECTION.ALLOCS)
                        {
                            const allocs = u32();
                            call.allocs = [];
                            for (let index = 0; index < allocs; index++)
                            {
                                call.allocs.push(u32());
                            }
                        }
                        if (sections & SECTION.REPLIES)
                        {
                            const replies = u32();
                            call.replies = [];
                            for (let index = 0; index < replies; index++)
                            {
                                call.replies.push(value());
                            }
                        }
                        if (sections & SECTION.SHIP)
                        {
                            const ships = u32();
                            call.ship = [];
                            for (let index = 0; index < ships; index++)
                            {
                                call.ship.push(memory());
                            }
                        }
                        if (sections & SECTION.WROTE)
                        {
                            const wrote = u32();
                            call.wrote = [];
                            for (let index = 0; index < wrote; index++)
                            {
                                call.wrote.push(memory());
                            }
                        }
                        call.wait = u8();
                        if (call.wait === WAIT.ANSWER)
                        {
                            call.serial = u32();
                        }
                    }
                }
                if (each(call) === false)
                {
                    return;
                }
            }
        },
    };
}
