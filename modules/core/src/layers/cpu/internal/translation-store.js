/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where a translator keeps its regions between runs: a directory of the
 * origin's private file system under a name for the bundle, holding one
 * `records` file with every record appended back to back and one `index`
 * file naming each record's place in it. Resolved inside the engine's own
 * thread from a request, as the block store is, since a store with functions
 * in it cannot cross to the engine from the page.
 *
 * Why one file: a record per file cost a file-system round trip per hit --
 * a title's warm load read tens of thousands of them at a millisecond each,
 * and the engine thread spent more of the load waiting on those reads than
 * running the program. With the records in one file the index (read once)
 * says where each is, a miss touches nothing, and a hit is one read at an
 * offset -- synchronous through the file's access handle inside a worker,
 * which is where the engine runs, so a lookup costs microseconds and no
 * turn of the event loop. The index is a log: a batch appends its lines,
 * and a name that appears twice means the later place (a rewrite of the
 * whole index per batch was seconds of a loading phase's engine thread).
 *
 * A record's name is a hash of its key, two ways so a collision needs both
 * to agree; the key's own characters would be a path.
 */

/** @typedef {import('../engine.js').TranslationStore} TranslationStore */
/** @typedef {{ offset: number, length: number, session: number }} Place */

/**
 * The store's own layout version: a bundle directory of another version is
 * not read, so a change to the record naming or the files does not mix old
 * bytes into the new set. (The records' own version is the emitter's.)
 */
export const STORE_VERSION = 3;

/** The file every record is appended to, and the one naming their places. */
const RECORDS = 'records';
const INDEX = 'index';
/** Names the generation the two files above are: `records.<g>`, `index.<g>` (none: 0). */
const CURRENT = 'current';

/**
 * The store is kept to what recent runs used. A session is one opening; the
 * index marks each (`# <n>`) and names again a record read or written in it,
 * so every record carries the last session that used it. On opening, a
 * records file past `compactFloor` of which half is not live -- superseded by
 * a later write of its name, or unused for `keepSessions` sessions, which is
 * what a translator version's records become once the version changes and
 * what a relink's module no region names any more becomes -- is copied, live
 * records only, into the next generation; and live records past `cap` go, the
 * least recently used first. Without it every run's relinked modules and every
 * re-put stayed for ever: a profile reached 29 GB.
 */
const LIMITS = { keepSessions: 4, compactFloor: 64 << 20, cap: 1 << 30 };

/** @param {string} base @param {number} generation */
const generationName = (base, generation)=>(generation === 0 ? base : `${base}.${generation}`);

/**
 * Writes a whole file, replacing what was there.
 *
 * @param {any} directory @param {string} name @param {Uint8Array} bytes
 */
async function writeWhole(directory, name, bytes){
    const handle = await directory.getFileHandle(name, { create: true });
    if (typeof handle.createSyncAccessHandle === 'function')
    {
        const access = await handle.createSyncAccessHandle();
        try
        {
            access.truncate(0);
            access.write(bytes, { at: 0 });
            access.flush();
        }
        finally
        {
            access.close();
        }
        return;
    }
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
}

/**
 * A record name for a key.
 *
 * @param {string} key
 */
export function fileNameOf(key){
    let a = 0x811c9dc5;
    let b = 0x1000193;
    for (let i = 0; i < key.length; i++)
    {
        const c = key.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193) >>> 0;
        b = Math.imul(b + c, 0x9e3779b1) >>> 0;
    }
    return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}.cork`;
}

/** @param {any} file */
const textOf = async file=>new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()));

/**
 * Removes `<name>.v<n>` directories of any version but this one.
 *
 * @param {any} cork  the store's own directory
 * @param {string} name  the bundle's safe name
 */
async function sweepOtherVersions(cork, name){
    if (typeof cork.entries !== 'function' || typeof cork.removeEntry !== 'function')
    {
        return;
    }
    const keep = `${name}.v${STORE_VERSION}`;
    /** @type {string[]} */
    const stale = [];
    for await (const [entry] of cork.entries())
    {
        if (entry !== keep && entry.startsWith(`${name}.v`))
        {
            stale.push(entry);
        }
    }
    for (const entry of stale)
    {
        await cork.removeEntry(entry, { recursive: true }).catch(()=>{});
    }
}

/**
 * Appends to a small file at a known end: the synchronous handle inside a
 * worker, the stream on the page.
 *
 * @param {any} handle @param {number} at @param {Uint8Array} bytes
 */
async function appendAt(handle, at, bytes){
    if (typeof handle.createSyncAccessHandle === 'function')
    {
        const access = await handle.createSyncAccessHandle();
        try
        {
            access.write(bytes, { at });
            access.flush();
        }
        finally
        {
            access.close();
        }
        return;
    }
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.write({ type: 'write', position: at, data: bytes });
    await writable.close();
}

/**
 * A store over a directory handle (the origin private file system's, or
 * anything with its shape).
 *
 * @param {{ getDirectoryHandle: Function }} root  where the bundle's directory is made
 * @param {string} name  the bundle's, made safe for a directory name
 * @param {typeof LIMITS} [limits]  the ages and sizes it is kept to (tests shrink them)
 * @returns {Promise<TranslationStore & { flush: () => Promise<void>, close: () => void }>}
 */
export async function createDirectoryTranslationStore(root, name, limits = LIMITS){
    const safe = name.replace(/[^A-Za-z0-9._-]/g, '_') || 'bundle';
    const cork = await root.getDirectoryHandle('cork', { create: true });
    const directory = await cork.getDirectoryHandle(`${safe}.v${STORE_VERSION}`, { create: true });
    // The bundle's directories of other layout versions go: nothing reads
    // them again, and the block store mounts the origin's whole file system
    // and stats every file in it on every start -- a version that kept a
    // file per record left tens of thousands, a minute of a launch.
    await sweepOtherVersions(cork, safe);
    /** Each record's place in the records file and the last session that
     * used it, read once; null until then.
     * @type {Map<string, Place> | null} */
    let places = null;
    /** This opening's session, and the generation of the files. */
    let session = 0;
    let generation = 0;
    /** The records file's handle, and its synchronous access inside a worker. */
    /** @type {any} */
    let records = null;
    /** @type {any} */
    let access = null;
    /** Where the next record goes: the records file's size. */
    let end = 0;
    /** @type {Promise<void> | null} */
    let opening = null;
    /** The index file's length: where the next lines go. */
    let indexEnd = 0;
    /** Lines put since the last append. @type {string[]} */
    let pendingLines = [];

    /** Opens the current generation's records file: its handle, access and size. */
    const openRecords = async()=>{
        records = await directory.getFileHandle(generationName(RECORDS, generation),
            { create: true });
        access = null;
        if (typeof records.createSyncAccessHandle === 'function')
        {
            try
            {
                access = await records.createSyncAccessHandle();
                end = access.getSize();
            }
            catch {
                access = null;
            }
        }
        if (access === null)
        {
            end = (await records.getFile()).size;
        }
    };

    /** @param {number} offset @param {number} length */
    const readAt = async(offset, length)=>{
        if (access !== null)
        {
            const bytes = new Uint8Array(length);
            return access.read(bytes, { at: offset }) === length ? bytes : null;
        }
        const file = await records.getFile();
        return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
    };

    /**
     * Copies the live records into the next generation when the file is
     * mostly dead weight or the live ones are past the cap. The generation is
     * switched by the `current` file, written last: a page that goes away
     * before it leaves the old generation current and whole.
     */
    const compact = async()=>{
        const all = /** @type {Map<string, Place>} */ (places);
        let live = [...all].filter(([, place])=>place.session >= session - limits.keepSessions);
        let liveBytes = live.reduce((sum, [, place])=>sum + place.length, 0);
        if (liveBytes <= limits.cap && (end < limits.compactFloor || liveBytes * 2 > end))
        {
            return;
        }
        if (liveBytes > limits.cap)
        {
            live.sort((a, b)=>b[1].session - a[1].session);
            liveBytes = 0;
            live = live.filter(([, place])=>(liveBytes += place.length) <= limits.cap);
        }
        const next = generation + 1;
        const target = await directory.getFileHandle(generationName(RECORDS, next),
            { create: true });
        /** @type {Map<string, Place>} */
        const moved = new Map();
        let at = 0;
        /** @param {(bytes: Uint8Array, at: number) => unknown} write */
        const copy = async write=>{
            for (const [recordName, place] of live)
            {
                const bytes = await readAt(place.offset, place.length);
                if (bytes === null)
                {
                    continue;
                }
                await write(bytes, at);
                moved.set(recordName, { offset: at, length: place.length, session: place.session });
                at += place.length;
            }
        };
        if (typeof target.createSyncAccessHandle === 'function')
        {
            const out = await target.createSyncAccessHandle();
            try
            {
                out.truncate(0);
                await copy((bytes, offset)=>out.write(bytes, { at: offset }));
                out.flush();
            }
            finally
            {
                out.close();
            }
        }
        else
        {
            const out = await target.createWritable();
            await copy((bytes, offset)=>out.write(
                { type: 'write', position: offset, data: bytes }));
            await out.close();
        }
        // The index by session, so the next opening reads each record's age.
        /** @type {Map<number, string[]>} */
        const bySession = new Map();
        for (const [recordName, place] of moved)
        {
            const lines = bySession.get(place.session) ?? [];
            lines.push(`${recordName} ${place.offset} ${place.length}\n`);
            bySession.set(place.session, lines);
        }
        const indexBytes = new TextEncoder().encode([...bySession].sort((a, b)=>a[0] - b[0])
            .map(([number, lines])=>`# ${number}\n${lines.join('')}`).join(''));
        await writeWhole(directory, generationName(INDEX, next), indexBytes);
        await writeWhole(directory, CURRENT, new TextEncoder().encode(String(next)));
        access?.close();
        const old = generation;
        generation = next;
        places = moved;
        indexEnd = indexBytes.length;
        await openRecords();
        if (typeof directory.removeEntry === 'function')
        {
            await directory.removeEntry(generationName(RECORDS, old)).catch(()=>{});
            await directory.removeEntry(generationName(INDEX, old)).catch(()=>{});
        }
    };

    const open = ()=>{
        opening ??= (async()=>{
            places = new Map();
            try
            {
                const text = await textOf(await (await directory.getFileHandle(CURRENT)).getFile());
                generation = Number.isInteger(Number(text)) && Number(text) > 0 ? Number(text) : 0;
            }
            catch {
                generation = 0;
            }
            await openRecords();
            let last = 0;
            try
            {
                const handle = await directory.getFileHandle(generationName(INDEX, generation));
                const text = await textOf(await handle.getFile());
                indexEnd = new TextEncoder().encode(text).length;
                for (const line of text.split('\n'))
                {
                    const parts = line.split(' ');
                    const [recordName, offsetText, lengthText] = parts;
                    if (recordName === '#' && parts.length === 2)
                    {
                        // A session's mark: the lines after it are that session's.
                        last = Math.max(last, Number(offsetText) || 0);
                        continue;
                    }
                    const offset = Number(offsetText);
                    const length = Number(lengthText);
                    // A place past the file's end is a write the index outran
                    // (the page went away between the two): not a record; nor
                    // is a line cut short, which reads as a length of zero.
                    if (parts.length === 3 && recordName && lengthText !== ''
                        && Number.isInteger(offset) && Number.isInteger(length)
                        && length > 0 && offset + length <= end)
                    {
                        places.set(recordName, { offset, length, session: last });
                    }
                }
            }
            catch {
                // No index yet: an empty bundle.
                indexEnd = 0;
            }
            session = last + 1;
            await compact();
            pendingLines.push(`# ${session}\n`);
        })();
        return opening;
    };

    // The index is appended to, one write in flight at a time: several puts
    // land in the same turn, and the write that is queued carries all of
    // their lines. The records are flushed first, so the index never names
    // bytes not yet on disk.
    /** @type {Promise<void> | null} */
    let publishing = null;
    /** A place set since the index was last written: the write goes round again. */
    let dirty = false;
    const publish = ()=>{
        dirty = true;
        if (publishing !== null)
        {
            return publishing;
        }
        publishing = (async()=>{
            while (dirty)
            {
                dirty = false;
                await Promise.resolve();
                access?.flush();
                const bytes = new TextEncoder().encode(pendingLines.join(''));
                pendingLines = [];
                const at = indexEnd;
                indexEnd += bytes.length;
                await appendAt(await directory.getFileHandle(generationName(INDEX, generation),
                    { create: true }), at, bytes);
            }
            publishing = null;
        })().catch(()=>{
            publishing = null;
        });
        return publishing;
    };

    // Without a synchronous handle (a page, a test) the appends go one at a
    // time: a writable stream is a copy of the file closed over the original,
    // and two open at once keep only the last one's bytes.
    /** @type {Promise<void>} */
    let appending = Promise.resolve();

    return {
        async get(key){
            await open();
            const recordName = fileNameOf(key);
            const place = /** @type {Map<string, Place>} */ (places).get(recordName);
            if (!place)
            {
                return null;
            }
            if (place.session !== session)
            {
                // Used in this session: named in it again, so it outlives the
                // records nobody reads. Written with the next batch of lines.
                place.session = session;
                pendingLines.push(`${recordName} ${place.offset} ${place.length}\n`);
                if (pendingLines.length >= 512)
                {
                    publish();
                }
            }
            return readAt(place.offset, place.length);
        },
        async put(key, bytes){
            await open();
            const offset = end;
            end += bytes.length;
            if (access !== null)
            {
                access.write(bytes, { at: offset });
            }
            else
            {
                appending = appending.then(async()=>{
                    const writable = await records.createWritable({ keepExistingData: true });
                    await writable.write({ type: 'write', position: offset, data: bytes });
                    await writable.close();
                });
                await appending;
            }
            const recordName = fileNameOf(key);
            /** @type {Map<string, Place>} */ (places)
                .set(recordName, { offset, length: bytes.length, session });
            pendingLines.push(`${recordName} ${offset} ${bytes.length}\n`);
            await publish();
        },
        /**
         * Writes any index not yet on disk and flushes the records. `put`
         * already queues its own, so this is for a caller that finishes a run.
         */
        async flush(){
            await appending;
            if (publishing !== null)
            {
                await publishing;
            }
            access?.flush();
        },
        /** Lets go of the records file's access handle; nothing else holds one. */
        close(){
            access?.close();
            access = null;
        },
    };
}

/**
 * Turns what a caller asked for into a store, or nothing: `'local'` is the
 * origin's private file system, which a page without one (a test, a host
 * without the API) answers with no store rather than a failure; an object
 * is taken as a store of the caller's own; anything falsy means none.
 *
 * @param {any} spec @param {string} name
 * @returns {Promise<TranslationStore | null>}
 */
export async function resolveTranslationStore(spec, name){
    if (!spec)
    {
        return null;
    }
    if (spec !== 'local')
    {
        return spec;
    }
    const storage = /** @type {any} */ (globalThis).navigator?.storage;
    if (typeof storage?.getDirectory !== 'function')
    {
        return null;
    }
    try
    {
        return await createDirectoryTranslationStore(await storage.getDirectory(), name);
    }
    catch {
        return null;
    }
}
