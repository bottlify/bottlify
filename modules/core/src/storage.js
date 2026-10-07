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
 * A session that travels -- to localStorage, out of the device -- is packed
 * as one compressed stream rather than the per-block arrangement a bundle
 * uses, and the difference is the access pattern. A bundle is read at random
 * offsets forever, so it is cut into blocks that can be fetched alone. A
 * session travels whole and is unpacked whole, so blocks would only cost
 * ratio. Same data, opposite answer, for a reason that is visible in
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

/** The head of one entry of a session kept in the origin's file system: "BTE", version 1. */
const ENTRY_MAGIC = 0x45544201;

/**
 * The name an entry of a session is kept under in the origin's file system:
 * a digest of its path, which is short and safe whatever the path holds, and
 * the path itself is kept inside the entry.
 *
 * @param {string} path
 */
const entryName = async path=>{
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',
        new TextEncoder().encode(path)));
    return [...digest.subarray(0, 16)].map(byte=>byte.toString(16).padStart(2, '0')).join('');
};

/** @param {string} path @param {Uint8Array} bytes */
const entryOf = (path, bytes)=>{
    const name = new TextEncoder().encode(path);
    const out = new Uint8Array(8 + name.length + bytes.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, ENTRY_MAGIC, true);
    view.setUint32(4, name.length, true);
    out.set(name, 8);
    out.set(bytes, 8 + name.length);
    return out;
};

/**
 * A session kept in the origin's private file system, a file to each of its
 * files and one to its registry.
 *
 * The right place for one on a single machine: it is not capped at a few
 * megabytes, it holds bytes rather than strings, and it survives the tab. A
 * save writes what changed and nothing else -- a program that rewrites its
 * configuration in the middle of play must not pay for its saved games,
 * which a session written whole, packed and compressed on the thread the
 * program runs on made it do every time. Each entry is replaced whole when
 * its writer closes, so an entry is the old one or the new one. The first
 * save of a run writes everything, as does a change that names no path;
 * a session left in the earlier one-file form is read, and gone after the
 * first save. Saves are serialised, and one asked for while another is in
 * flight waits for it and then writes the latest.
 *
 * @param {string} key
 * @param {() => Promise<any>} [directory]
 *     Where the session lives; defaults to the origin's own root. Takes the
 *     directory handle's interface, so a test can hand in one of its own.
 */
export function opfsSession(key, directory){
    const base = key.replace(/[^A-Za-z0-9._-]/g, '_');
    const legacy = `${base}.session`;
    const folderName = `${base}.files`;
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
    /** Whether the folder holds this run's whole session, so a change is all a save needs. */
    let whole = false;

    /** @param {any} folder @param {string} path @param {Uint8Array} bytes */
    const put = async(folder, path, bytes)=>{
        const handle = await folder.getFileHandle(await entryName(path), { create: true });
        const stream = await handle.createWritable();
        await stream.write(entryOf(path, bytes));
        await stream.close();
    };
    /** @param {any} folder @param {string} name */
    const drop = async(folder, name)=>{
        try
        {
            await folder.removeEntry(name);
        }
        catch {
            // Not there: nothing to drop.
        }
    };
    /** @param {any} session */
    const registryBytes = session=>new TextEncoder().encode(JSON.stringify(session.registry));

    /**
     * The folder an edit writes into, a session left in the one-file form moved
     * into it first.
     */
    const folderToEdit = async()=>{
        const dir = await open();
        const existing = await dir.getDirectoryHandle(folderName).catch(()=>null);
        if (existing)
        {
            return existing;
        }
        const folder = await dir.getDirectoryHandle(folderName, { create: true });
        const handle = await dir.getFileHandle(legacy).catch(()=>null);
        if (handle)
        {
            const old = await unpackSession(new Uint8Array(await (await handle.getFile())
                .arrayBuffer()));
            for (const file of old.files)
            {
                await put(folder, file.path, file.bytes);
            }
            if (old.registry)
            {
                await put(folder, REGISTRY_ENTRY, registryBytes(old));
            }
            await drop(dir, legacy);
        }
        return folder;
    };

    /**
     * An entry's path and where its bytes start, read from its head alone.
     *
     * @param {any} file  A File.
     * @returns {Promise<{ path: string, start: number } | null>}
     */
    const headOf = async file=>{
        const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
        const view = new DataView(head.buffer);
        if (head.length < 8 || view.getUint32(0, true) !== ENTRY_MAGIC)
        {
            return null;
        }
        const start = 8 + view.getUint32(4, true);
        const path = new TextDecoder().decode(
            new Uint8Array(await file.slice(8, start).arrayBuffer()));
        return { path, start };
    };

    const store = {
        /**
         * The files kept, by path and size, their bytes left unread: what an
         * editor lists while no machine holds the session.
         *
         * @returns {Promise<{ path: string, size: number }[]>}
         */
        async list(){
            await writing;
            const folder = await (await open()).getDirectoryHandle(folderName).catch(()=>null);
            if (!folder)
            {
                return (await store.load()).files
                    .map(file=>({ path: file.path, size: file.bytes.length }));
            }
            /** @type {{ path: string, size: number }[]} */
            const files = [];
            for await (const [, handle] of folder.entries())
            {
                const file = await handle.getFile();
                const head = await headOf(file);
                if (head && head.path !== REGISTRY_ENTRY)
                {
                    files.push({ path: head.path, size: file.size - head.start });
                }
            }
            return files;
        },
        /**
         * One file's bytes, or null when the session holds none at that path.
         *
         * @param {string} path
         * @returns {Promise<Uint8Array | null>}
         */
        async read(path){
            await writing;
            const folder = await (await open()).getDirectoryHandle(folderName).catch(()=>null);
            if (!folder)
            {
                return (await store.load()).files.find(file=>file.path === path)?.bytes ?? null;
            }
            const handle = await folder.getFileHandle(await entryName(path)).catch(()=>null);
            if (!handle)
            {
                return null;
            }
            const file = await handle.getFile();
            const head = await headOf(file);
            return head ? new Uint8Array(await file.slice(head.start).arrayBuffer()) : null;
        },
        /**
         * A file put in the session, or replaced: what the program will find at
         * its next start.
         *
         * @param {string} path @param {Uint8Array} bytes
         */
        write(path, bytes){
            writing = writing.then(async()=>put(await folderToEdit(), path, bytes));
            return writing;
        },
        /**
         * A file taken out of the session.
         *
         * @param {string} path
         */
        remove(path){
            writing = writing.then(async()=>drop(await folderToEdit(), await entryName(path)));
            return writing;
        },
        async load(){
            const dir = await open();
            const folder = await dir.getDirectoryHandle(folderName).catch(()=>null);
            if (!folder)
            {
                let handle;
                try
                {
                    handle = await dir.getFileHandle(legacy);
                }
                catch {
                    return normaliseSession(null);
                }
                const file = await handle.getFile();
                return unpackSession(new Uint8Array(await file.arrayBuffer()));
            }
            const decoder = new TextDecoder();
            /** @type {SessionFile[]} */
            const files = [];
            let registry = null;
            for await (const [, handle] of folder.entries())
            {
                const raw = new Uint8Array(await (await handle.getFile()).arrayBuffer());
                const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
                if (raw.length < 8 || view.getUint32(0, true) !== ENTRY_MAGIC)
                {
                    continue;
                }
                const start = 8 + view.getUint32(4, true);
                const path = decoder.decode(raw.subarray(8, start));
                if (path === REGISTRY_ENTRY)
                {
                    registry = JSON.parse(decoder.decode(raw.subarray(start)));
                }
                else
                {
                    files.push({ path, bytes: raw.slice(start) });
                }
            }
            return { files, registry };
        },
        /**
         * @param {Session} session
         * @param {SessionChange[]} [changes]  what changed since the last save; none for all
         */
        save(session, changes){
            const { files, registry } = normaliseSession(session);
            writing = writing.then(async()=>{
                const dir = await open();
                const folder = await dir.getDirectoryHandle(folderName, { create: true });
                const full = !whole || !changes
                    || changes.some(change=>change.kind !== 'registry'
                        && typeof change.path !== 'string');
                if (full)
                {
                    const keep = new Set();
                    for (const file of files)
                    {
                        keep.add(await entryName(file.path));
                        await put(folder, file.path, file.bytes);
                    }
                    if (registry)
                    {
                        keep.add(await entryName(REGISTRY_ENTRY));
                        await put(folder, REGISTRY_ENTRY, registryBytes({ registry }));
                    }
                    /** @type {string[]} */
                    const stale = [];
                    for await (const [name] of folder.entries())
                    {
                        if (!keep.has(name))
                        {
                            stale.push(name);
                        }
                    }
                    for (const name of stale)
                    {
                        await drop(folder, name);
                    }
                    await drop(dir, legacy);
                    whole = true;
                    return;
                }
                const byPath = new Map(files.map(file=>[file.path, file]));
                for (const change of /** @type {SessionChange[]} */ (changes))
                {
                    if (change.kind === 'registry')
                    {
                        if (registry)
                        {
                            await put(folder, REGISTRY_ENTRY, registryBytes({ registry }));
                        }
                        continue;
                    }
                    const path = /** @type {string} */ (change.path);
                    const file = byPath.get(path);
                    if (file)
                    {
                        await put(folder, path, file.bytes);
                    }
                    else
                    {
                        await drop(folder, await entryName(path));
                    }
                }
            });
            return writing;
        },
    };
    return store;
}

/**
 * What a save is told changed: a file by its path, or the registry.
 *
 * @typedef {{ kind: string, path?: string }} SessionChange
 */

/**
 * One save for a burst of changes.
 *
 * A program saving a game writes its file in hundreds of pieces, and a
 * session saved on every piece packed the whole session -- every file and the
 * registry, compressed -- hundreds of times over, on the thread the program
 * runs on. Measured on a real title: the machine spent four fifths of its
 * time packing and the save took minutes. Changes are noted and the save
 * waits for them to settle; a change that arrives while a save is under way
 * is saved once that one is done, never alongside it, so the store sees one
 * session at a time and always the latest.
 *
 * @param {Object} options
 * @param {() => Session} options.snapshot  The session as it is now; called once per save.
 * @param {(session: Session, changes: SessionChange[]) => unknown} options.persist
 * @param {number} [options.settleMs]  How long after the last change a save begins.
 * @param {(fn: () => void, ms: number) => unknown} [options.schedule]
 *        How to wait; the default is the host's timer.
 */
export function coalescedSaver({ snapshot, persist, settleMs = 250, schedule }){
    const later = schedule ?? ((fn, ms)=>setTimeout(fn, ms));
    /** @type {SessionChange[]} */
    let pending = [];
    /** @type {unknown} */
    let timer = null;
    /** @type {Promise<unknown> | null} */
    let inFlight = null;

    const flush = ()=>{
        timer = null;
        if (inFlight)
        {
            return inFlight;
        }
        if (pending.length === 0)
        {
            return Promise.resolve();
        }
        const changes = pending;
        pending = [];
        inFlight = Promise.resolve(persist(snapshot(), changes)).finally(()=>{
            inFlight = null;
            if (pending.length > 0 && timer === null)
            {
                timer = later(flush, settleMs);
            }
        });
        return inFlight;
    };

    return {
        /** @param {SessionChange[]} changes */
        note(changes){
            pending.push(...changes);
            if (timer === null && !inFlight)
            {
                timer = later(flush, settleMs);
            }
        },
        /** Saves what is pending now rather than after it settles. */
        flush,
        /** Changes noted and not yet handed to the store. */
        get pending(){
            return pending.length;
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
