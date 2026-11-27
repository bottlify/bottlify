/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The functions a run's translation emitted, kept as bodies of the run's
 * Cellar cache, so every thread working for the run - its executors, their
 * translation workers - takes what any of them emitted, read where it lies,
 * and a thread that leaves takes nothing with it.
 *
 * One body a function, named by a 64-bit hash of its key (`keptName`), laid
 * out as an entry (`entryOf`): the key itself, the region's shape, the
 * function's body and the rest the emitter answered. A take reads the entry in
 * place, and hands it back only where the key and the shape are the ones
 * asked: two keys of one name are two misses, never one's function for the
 * other's.
 *
 * A thread keeps through what its host gives it (`KeptSpace`). The thread
 * that holds a reader which may write (a process's) puts the body itself; a
 * thread that only reads (a translation worker, an executor) collects the
 * entries it would have kept and hands them to that thread with its answer,
 * which puts them (`readingSpace`): the run's keeper is one thread's, and a
 * worker never waits on it.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** An entry's leading words: its whole length, the key's bytes, the shape's numbers,
 * the body's bytes, the rest's bytes. */
const ENTRY_WORDS = 5;

/**
 * @typedef {Object} KeptFunction  What a hit hands the emitter.
 * @property {number} typeIndex
 * @property {number[]} locals
 * @property {Uint8Array} body
 * @property {number[]} hints
 * @property {any} region  what the emitter answered for the region
 */

/**
 * The names a thread keeps functions under, as its host gives them: a space
 * of the run's cache (`cacheSpace` in the core's cache layer) on the thread
 * that writes, or one that reads in place and hands its keeps on.
 *
 * @typedef {Object} KeptSpace
 * @property {<T>(name: string, read: (body: Uint8Array) => T) => T | undefined} with
 *     the body read in place inside `read`, never kept past it; undefined on a miss
 * @property {(name: string, bytes: Uint8Array) => boolean} put  a copy kept
 */

/**
 * The run's cache as a host gives it to cork (`RuntimeSettings.kept`): the
 * space this thread keeps through, and how a translation worker of this
 * thread's is joined to the run's cache to read the same names in place.
 *
 * @typedef {Object} KeptStore
 * @property {KeptSpace} space
 * @property {string} prefix  what the space puts before a name: a reader of
 *     the whole cache reads `prefix + name`
 * @property {((post: (message: any) => void) =>
 *     ({ shared: any, segments: (SharedArrayBuffer | null)[], leave?: () => void } | null))
 *     | null} [join]  a worker joined: the index and the segments as they are, the
 *     segments made and let go after posted to it; null where none can be
 */

/**
 * Two lanes of FNV-1a over the key's UTF-16 units, each from its own basis:
 * the name a key's function is kept under. A name two keys share costs a miss
 * (the entry says whose it is), never a wrong function.
 *
 * @param {string} key
 */
export function keptName(key){
    let a = 0x811c9dc5;
    let b = 0x01000193;
    for (let i = 0; i < key.length; i++)
    {
        const unit = key.charCodeAt(i);
        a = Math.imul(a ^ unit, 0x01000193);
        b = Math.imul(b ^ (unit + i), 0x01000193);
    }
    return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}`;
}

/**
 * An entry laid out: its length, and how to write it at an offset of a
 * buffer's bytes, each part once, where it goes.
 *
 * @param {string} key @param {number[]} shape @param {KeptFunction} kept
 * @returns {{ length: number, write: (target: Uint8Array, at: number) => void }}
 */
export function entryOf(key, shape, { typeIndex, locals, body, hints, region }){
    const keyBytes = encoder.encode(key);
    const rest = encoder.encode(JSON.stringify([typeIndex, locals, hints, region]));
    const shapeAt = (ENTRY_WORDS * 4 + keyBytes.length + 7) & ~7;
    const bodyAt = shapeAt + shape.length * 8;
    const restAt = bodyAt + body.length;
    const length = restAt + rest.length;
    return {
        length,
        write(target, at){
            const view = new DataView(target.buffer, target.byteOffset + at, length);
            view.setUint32(0, length, true);
            view.setUint32(4, keyBytes.length, true);
            view.setUint32(8, shape.length, true);
            view.setUint32(12, body.length, true);
            view.setUint32(16, rest.length, true);
            target.set(keyBytes, at + ENTRY_WORDS * 4);
            // The key's pad zero: the bytes there may be another body's.
            target.fill(0, at + ENTRY_WORDS * 4 + keyBytes.length, at + shapeAt);
            for (let i = 0; i < shape.length; i++)
            {
                view.setFloat64(shapeAt + i * 8, shape[i], true);
            }
            target.set(body, at + bodyAt);
            target.set(rest, at + restAt);
        },
    };
}

/**
 * Whether the entry in `bytes` is kept under `key`, compared where it lies: a
 * key is ASCII as the emitter makes it, its units the bytes; one that is not
 * is encoded to compare.
 *
 * @param {Uint8Array} bytes @param {string} key
 */
function holdsKey(bytes, key){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    if (bytes.length < ENTRY_WORDS * 4 || view.getUint32(0, true) !== bytes.length)
    {
        return false;
    }
    const length = view.getUint32(4, true);
    const from = ENTRY_WORDS * 4;
    let i = 0;
    for (; i < key.length; i++)
    {
        const unit = key.charCodeAt(i);
        if (unit >= 0x80)
        {
            break;
        }
        if (i >= length || bytes[from + i] !== unit)
        {
            return false;
        }
    }
    if (i === key.length)
    {
        return length === key.length;
    }
    const encoded = encoder.encode(key);
    if (encoded.length !== length)
    {
        return false;
    }
    for (let j = i; j < length; j++)
    {
        if (bytes[from + j] !== encoded[j])
        {
            return false;
        }
    }
    return true;
}

/**
 * The function in an entry read in place, where its key and shape are the
 * ones asked: its body and shape copied out once, as the emitter keeps them
 * past the read; undefined otherwise.
 *
 * @param {Uint8Array} bytes @param {string} key @param {number[]} shape
 * @returns {KeptFunction | undefined}
 */
export function takeEntry(bytes, key, shape){
    if (!holdsKey(bytes, key))
    {
        return undefined;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const keyLength = view.getUint32(4, true);
    const shapeCount = view.getUint32(8, true);
    const bodyLength = view.getUint32(12, true);
    const restLength = view.getUint32(16, true);
    const shapeAt = (ENTRY_WORDS * 4 + keyLength + 7) & ~7;
    if (shapeCount !== shape.length)
    {
        return undefined;
    }
    for (let i = 0; i < shapeCount; i++)
    {
        if (view.getFloat64(shapeAt + i * 8, true) !== shape[i])
        {
            return undefined;
        }
    }
    const bodyAt = shapeAt + shapeCount * 8;
    const restAt = bodyAt + bodyLength;
    const [typeIndex, locals, hints, region] = JSON.parse(
        decoder.decode(bytes.subarray(restAt, restAt + restLength)));
    return { typeIndex, locals, body: bytes.slice(bodyAt, restAt), hints, region };
}

/**
 * An entry read whole, its key included: what a store holds, listed (the
 * bench that weighs keepers on the functions a run emitted).
 *
 * @param {Uint8Array} bytes
 * @returns {{ key: string, shape: number[], kept: KeptFunction }}
 */
export function readEntry(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
    const keyLength = view.getUint32(4, true);
    const shapeCount = view.getUint32(8, true);
    const shapeAt = (ENTRY_WORDS * 4 + keyLength + 7) & ~7;
    const key = decoder.decode(bytes.subarray(ENTRY_WORDS * 4, ENTRY_WORDS * 4 + keyLength));
    const shape = Array.from({ length: shapeCount },
        (_, i)=>view.getFloat64(shapeAt + i * 8, true));
    return { key, shape, kept: /** @type {KeptFunction} */ (takeEntry(bytes, key, shape)) };
}

/**
 * The functions kept in `space`: what any thread of the run kept under a
 * key, every other takes. The context goes into the key whole, as every
 * thread must name it alike.
 *
 * @param {KeptSpace} space
 * @returns {import('./emit-built.js').EmitCache}
 */
export function keptEmitCache(space){
    // The last key's name: the emitter keeps under the key it just missed.
    let lastKey = '';
    let lastName = '';
    /** @param {string} key */
    const nameOf = key=>{
        if (key !== lastKey)
        {
            lastKey = key;
            lastName = keptName(key);
        }
        return lastName;
    };
    /** @type {import('./emit-built.js').EmitCache} */
    const cache = {
        hits: 0,
        context: signature=>signature,
        take(key, shape){
            const kept = space.with(nameOf(key), bytes=>takeEntry(bytes, key, shape));
            if (kept !== undefined)
            {
                cache.hits++;
            }
            return kept;
        },
        keep(key, shape, kept){
            const entry = entryOf(key, shape, kept);
            const bytes = new Uint8Array(entry.length);
            entry.write(bytes, 0);
            putNew(space, nameOf(key), bytes);
        },
    };
    return cache;
}

/**
 * A space a thread that only reads the run's cache keeps through: it reads
 * through `with`, and the entries it would keep wait in `taken()` for the
 * thread that writes, which puts them (`putAll`) - a worker hands them over
 * with its answer, their buffers transferred.
 *
 * @param {<T>(name: string, read: (body: Uint8Array) => T) => T | undefined} read
 * @returns {KeptSpace & { taken: () => { name: string, bytes: Uint8Array }[] }}
 */
export function readingSpace(read){
    /** @type {{ name: string, bytes: Uint8Array }[]} */
    let waiting = [];
    return {
        with: read,
        put(name, bytes){
            waiting.push({ name, bytes });
            return true;
        },
        taken(){
            const out = waiting;
            waiting = [];
            return out;
        },
    };
}

/**
 * Puts `bytes` under `name` unless the body there is the same already: a
 * second thread that emitted the function too writes nothing, and another
 * key's or another shape's function under the name gives way to the newer,
 * as a thread's own cache keeps the last.
 *
 * @param {KeptSpace} space @param {string} name @param {Uint8Array} bytes
 */
function putNew(space, name, bytes){
    const same = space.with(name, body=>body.length === bytes.length
        && body.every((byte, at)=>byte === bytes[at]));
    if (same !== true)
    {
        space.put(name, bytes);
    }
}

/**
 * The entries a reading thread handed over, put by the thread that writes.
 *
 * @param {KeptSpace} space @param {{ name: string, bytes: Uint8Array }[] | undefined} entries
 */
export function putAll(space, entries){
    for (const { name, bytes } of entries ?? [])
    {
        putNew(space, name, bytes);
    }
}
