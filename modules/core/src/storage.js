/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
 * @typedef {{ path: string, bytes: Uint8Array }} SessionFile
 * @typedef {{ files: SessionFile[], registry: any | null }} Session
 *     Everything a program leaves behind: the files it wrote and the registry
 *     it wrote, because a program's settings live in either and a session that
 *     carries only one of them forgets half of what was chosen.
 */

/**
 * Where the registry travels inside a packed session: as one more entry, under
 * a name no path can have. Kept out of `files` on the way in and out, so a
 * caller applying a session to a volume never writes it as a file.
 */
const REGISTRY_ENTRY = '<registry>';

/**
 * The one shape a session has inside the engine, from whatever a provider or
 * an older caller handed over: a bare list of files is a session with no
 * registry, and nothing at all is an empty one.
 *
 * @param {any} session
 * @returns {Session}
 */
export function normaliseSession(session){
    if (!session)
    {
        return { files: [], registry: null };
    }
    if (Array.isArray(session))
    {
        return { files: session, registry: null };
    }
    return { files: session.files ?? [], registry: session.registry ?? null };
}

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
 * Inflates a raw deflate stream, wherever this is running.
 *
 * Exported because a bundle block written with deflate needs it, and there is
 * no synchronous way to do this in a browser -- so such a block is decoded when
 * it is fetched rather than when it is read.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export const inflateRaw = bytes=>recode(bytes, 'deflate-raw', false);

/**
 * Packs a session into one stream.
 *
 * Framed rather than indexed: a session is read from the front every time, so
 * an index would be a second thing to keep consistent for no benefit.
 *
 * @param {Session | SessionFile[]} session
 * @returns {Promise<Uint8Array>}
 */
export async function packSession(session){
    const { files, registry } = normaliseSession(session);
    const encoder = new TextEncoder();
    const parts = files.map(file=>({ name: encoder.encode(file.path), bytes: file.bytes }));
    if (registry)
    {
        parts.push({ name: encoder.encode(REGISTRY_ENTRY),
            bytes: encoder.encode(JSON.stringify(registry)) });
    }
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
 * @returns {Promise<Session>}
 */
export async function unpackSession(packed){
    if (packed.length === 0)
    {
        return { files: [], registry: null };
    }
    const raw = await recode(packed, 'deflate-raw', false);
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    if (view.getUint32(0, true) !== MAGIC)
    {
        throw new Error('storage: this is not a packed session');
    }

    const decoder = new TextDecoder();
    /** @type {SessionFile[]} */
    const files = [];
    let registry = null;
    let at = 4;
    while (at < raw.length)
    {
        const nameLength = view.getUint32(at, true);
        const byteLength = view.getUint32(at + 4, true);
        const name = decoder.decode(raw.subarray(at + 8, at + 8 + nameLength));
        const start = at + 8 + nameLength;
        if (name === REGISTRY_ENTRY)
        {
            registry = JSON.parse(decoder.decode(raw.subarray(start, start + byteLength)));
        }
        else
        {
            files.push({ path: name, bytes: raw.slice(start, start + byteLength) });
        }
        at = start + byteLength;
    }
    return { files, registry };
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
            return text ? unpackSession(fromBase64(text)) : normaliseSession(null);
        },
        /** @param {Session} session */
        async save(session){
            store().setItem(key, toBase64(await packSession(session)));
        },
    };
}

/**
 * A session kept in the origin's private file system.
 *
 * The right place for one on a single machine: it is not capped at a few
 * megabytes, it holds bytes rather than strings, and it survives the tab. The
 * whole session is written each time, as one file; a program's own saves are
 * small next to its game and a partial write is a session nobody can load.
 * Saves are serialised, and one asked for while another is in flight waits
 * for it and then writes the latest.
 *
 * @param {string} key
 * @param {() => Promise<any>} [directory]
 *     Where the file lives; defaults to the origin's own root. Takes the
 *     directory handle's interface, so a test can hand in one of its own.
 */
export function opfsSession(key, directory){
    const name = `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.session`;
    const open = directory ?? (async()=>{
        const storage = globalThis.navigator?.storage;
        if (!storage?.getDirectory)
        {
            throw new Error('storage: "opfs" needs the origin private file system, '
                + 'which does not exist here -- pass a provider of your own instead');
        }
        return storage.getDirectory();
    });
    /** @type {Promise<void>} */
    let writing = Promise.resolve();

    return {
        async load(){
            const dir = await open();
            let handle;
            try
            {
                handle = await dir.getFileHandle(name);
            }
            catch {
                return normaliseSession(null);
            }
            const file = await handle.getFile();
            return unpackSession(new Uint8Array(await file.arrayBuffer()));
        },
        /** @param {Session} session */
        save(session){
            const packed = packSession(session);
            writing = writing.then(async()=>{
                const dir = await open();
                const handle = await dir.getFileHandle(name, { create: true });
                const stream = await handle.createWritable();
                await stream.write(await packed);
                await stream.close();
            });
            return writing;
        },
    };
}

/**
 * Turns whatever a caller passed as `storage` into the one shape the engine
 * uses. A provider object, the string `local` or `opfs`, a function that loads and
 * nothing else, or nothing at all.
 *
 * @param {any} spec
 * @param {string} key  Names the session when the caller did not.
 * @returns {{ load: () => Promise<any>, save: ((session: Session, changes: any[]) => any) | null }}
 */
export function resolveStorage(spec, key){
    if (!spec)
    {
        return { load: async()=>normaliseSession(null), save: null };
    }
    if (spec === 'local')
    {
        return localStorageSession(`bottlify:${key}`);
    }
    if (spec === 'opfs')
    {
        return opfsSession(key);
    }
    // A bare function is the common case: fetch the session from somewhere and
    // hand it over. Nothing goes back out, which is a legitimate thing to want.
    if (typeof spec === 'function')
    {
        return { load: async()=>normaliseSession(await spec()), save: null };
    }
    return {
        load: async()=>(await spec.load?.()) ?? [],
        save: spec.save ? (files, changes)=>spec.save(files, changes) : null,
    };
}
