/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Where a session comes from and where it goes.
 *
 * A bundle is the game and never changes. Everything a program produces --
 * saves, configuration, add-ons someone dropped in -- is the session, and it is
 * the only thing worth carrying anywhere. So the engine takes it in once,
 * before the first instruction, and reports outwards when it changes. That
 * direction is the point: nothing is pulled in behind a running program's
 * back, which is what makes a save the program wrote the save that is kept.
 *
 * A session is packed as one compressed stream rather than the per-block
 * arrangement a bundle uses, and the difference is the access pattern. A bundle
 * is read at random offsets forever, so it is cut into blocks that can be
 * fetched alone. A session travels whole and is unpacked whole, so blocks would
 * only cost ratio. Same data, opposite answer, for a reason that is visible in
 * the question rather than in the numbers.
 */

/** Magic and version of the packed session. */
const MAGIC = 0x53544201; // "BTS", version 1

/**
 * Compression that works wherever this runs.
 *
 * The browser has `CompressionStream` and Node has `zlib`, and neither has the
 * other. Both are asked for the same thing, so the difference stays here.
 *
 * @param {Uint8Array} bytes
 * @param {'deflate-raw'} format
 * @param {boolean} compress
 * @returns {Promise<Uint8Array>}
 */
async function recode(bytes, format, compress){
    const Stream = compress
        ? globalThis.CompressionStream
        : globalThis.DecompressionStream;
    if (Stream)
    {
        const part = /** @type {any} */ (bytes);
        const stream = new Blob([part]).stream().pipeThrough(new Stream(format));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    const zlib = await import('node:zlib');
    return new Promise((resolve, reject)=>{
        const done = (/** @type {any} */ error, /** @type {any} */ result)=>
            error ? reject(error) : resolve(new Uint8Array(result));
        if (compress)
        {
            zlib.deflateRaw(bytes, { level: 9 }, done);
        }
        else
        {
            zlib.inflateRaw(bytes, done);
        }
    });
}

/**
 * Packs a session into one stream.
 *
 * Framed rather than indexed: a session is read from the front every time, so
 * an index would be a second thing to keep consistent for no benefit.
 *
 * @param {{ path: string, bytes: Uint8Array }[]} files
 * @returns {Promise<Uint8Array>}
 */
export async function packSession(files){
    const encoder = new TextEncoder();
    const parts = files.map(file=>({ name: encoder.encode(file.path), bytes: file.bytes }));
    const size = parts.reduce((total, part)=>total + 8 + part.name.length + part.bytes.length, 4);

    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    view.setUint32(0, MAGIC, true);

    let at = 4;
    for (const part of parts)
    {
        view.setUint32(at, part.name.length, true);
        view.setUint32(at + 4, part.bytes.length, true);
        out.set(part.name, at + 8);
        out.set(part.bytes, at + 8 + part.name.length);
        at += 8 + part.name.length + part.bytes.length;
    }
    return recode(out, 'deflate-raw', true);
}

/**
 * @param {Uint8Array} packed
 * @returns {Promise<{ path: string, bytes: Uint8Array }[]>}
 */
export async function unpackSession(packed){
    if (packed.length === 0)
    {
        return [];
    }
    const raw = await recode(packed, 'deflate-raw', false);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (view.getUint32(0, true) !== MAGIC)
    {
        throw new Error('storage: this is not a packed session');
    }

    const decoder = new TextDecoder();
    /** @type {{ path: string, bytes: Uint8Array }[]} */
    const files = [];
    let at = 4;
    while (at < raw.length)
    {
        const nameLength = view.getUint32(at, true);
        const byteLength = view.getUint32(at + 4, true);
        const name = decoder.decode(raw.subarray(at + 8, at + 8 + nameLength));
        const start = at + 8 + nameLength;
        files.push({ path: name, bytes: raw.slice(start, start + byteLength) });
        at = start + byteLength;
    }
    return files;
}

/** @param {Uint8Array} bytes */
const toBase64 = bytes=>{
    let text = '';
    for (const byte of bytes)
    {
        text += String.fromCharCode(byte);
    }
    return btoa(text);
};

/** @param {string} text */
const fromBase64 = text=>Uint8Array.from(atob(text), character=>character.charCodeAt(0));

/**
 * A session kept in the page's own local storage.
 *
 * Convenience, not architecture: it is synchronous, capped at a few megabytes,
 * stores strings so bytes cost a third more as base64, and does not exist in a
 * worker at all. It is here because for a single machine with small saves it is
 * one line for the caller, and because saying plainly where it stops is more
 * useful than leaving people to find out.
 *
 * @param {string} key
 */
export function localStorageSession(key){
    const store = ()=>{
        const local = globalThis.localStorage;
        if (!local)
        {
            throw new Error(
                'storage: "local" needs localStorage, which does not exist here '
                + '(a worker has none) -- pass a provider of your own instead');
        }
        return local;
    };

    return {
        async load(){
            const text = store().getItem(key);
            return text ? unpackSession(fromBase64(text)) : [];
        },
        /** @param {{ path: string, bytes: Uint8Array }[]} files */
        async save(files){
            store().setItem(key, toBase64(await packSession(files)));
        },
    };
}

/**
 * Turns whatever a caller passed as `storage` into the one shape the engine
 * uses. A provider object, the string `local`, a function that loads and
 * nothing else, or nothing at all.
 *
 * @param {any} spec
 * @param {string} key  Names the session when the caller did not.
 * @returns {{ load: () => Promise<any[]>, save: ((files: any[], changes: any[]) => any) | null }}
 */
export function resolveStorage(spec, key){
    if (!spec)
    {
        return { load: async()=>[], save: null };
    }
    if (spec === 'local')
    {
        return localStorageSession(`bottlify:${key}`);
    }
    // A bare function is the common case: fetch the session from somewhere and
    // hand it over. Nothing goes back out, which is a legitimate thing to want.
    if (typeof spec === 'function')
    {
        return { load: async()=>(await spec()) ?? [], save: null };
    }
    return {
        load: async()=>(await spec.load?.()) ?? [],
        save: spec.save ? (files, changes)=>spec.save(files, changes) : null,
    };
}
