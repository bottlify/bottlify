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
 * @typedef {TranslationStore & {
 *     flush: () => Promise<void>, close: () => void, prepare: () => Promise<void>,
 *     getNow: (key: string) => Uint8Array | null | undefined,
 *     seed: (source: Uint8Array | null | Promise<Uint8Array | null>, identity?: string)
 *         => Promise<{ taken: boolean, added: number, present: number }>,
 *     seededWith: () => Promise<string | null>,
 *     exportSeed: (options?: { select?: (records: [string, Uint8Array][])
 *         => [string, Uint8Array][] }) => Promise<Uint8Array> }} SeedableStore
 */

/**
 * The store's own layout version: a bundle directory of another version is
 * not read, so a change to the record naming or the files does not mix old
 * bytes into the new set. (The records' own version is the emitter's.)
 */
export const STORE_VERSION = 3;

/** How long the records' writes may hold the thread before letting it go, in ms. */
const WRITE_SLICE_MS = 4;

/** The file every record is appended to, and the one naming their places. */
const RECORDS = 'records';
const INDEX = 'index';
/** Names the generation the two files above are: `records.<g>`, `index.<g>` (none: 0). */
const CURRENT = 'current';
/** Names the last seed taken in, so a start that finds it there fetches nothing. */
const SEEDED = 'seeded';

/**
 * A seed: a store's records in one blob, which a bundle carries so the first
 * run of it on a machine starts with the translations a run made elsewhere.
 *
 *     0x00  magic "CORKSEED"                  8
 *     0x08  seed format                       4
 *     0x0c  STORE_VERSION of the names        4
 *     0x10  record count                      4
 *     0x14  reserved                          4
 *     0x18  per record: its name's 16 hex digits as 8 bytes, its length   12 each
 *           ... the records, back to back in the same order ...
 *
 * A record is under the name of its key, and the key carries everything its
 * code was made from -- the code bytes' hash, the entry, the emitter's
 * version, the host's features, the emitting settings, the layout, the
 * bundle -- so a record another engine made is one no lookup of this one
 * names, and it simply never hits.
 */
const SEED_MAGIC = 'CORKSEED';
export const SEED_FORMAT = 1;
const SEED_HEADER = 0x18;
const SEED_ENTRY = 12;
const RECORD_NAME = /^([0-9a-f]{8})([0-9a-f]{8})\.cork$/;

/**
 * Packs records into a seed, in the order of their names, so the same records
 * make the same bytes whatever order the store held them in.
 *
 * @param {Iterable<[string, Uint8Array]>} records  name and bytes
 * @returns {Uint8Array}
 */
export function packSeed(records){
    const sorted = [...new Map(records)].filter(([name])=>RECORD_NAME.test(name))
        .sort((a, b)=>(a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const body = sorted.reduce((sum, [, bytes])=>sum + bytes.length, 0);
    const out = new Uint8Array(SEED_HEADER + sorted.length * SEED_ENTRY + body);
    const view = new DataView(out.buffer);
    for (let i = 0; i < SEED_MAGIC.length; i++)
    {
        out[i] = SEED_MAGIC.charCodeAt(i);
    }
    view.setUint32(8, SEED_FORMAT, true);
    view.setUint32(12, STORE_VERSION, true);
    view.setUint32(16, sorted.length, true);
    let at = SEED_HEADER + sorted.length * SEED_ENTRY;
    sorted.forEach(([name, bytes], i)=>{
        const [, high, low] = /** @type {RegExpExecArray} */ (RECORD_NAME.exec(name));
        const entry = SEED_HEADER + i * SEED_ENTRY;
        view.setUint32(entry, parseInt(high, 16));
        view.setUint32(entry + 4, parseInt(low, 16));
        view.setUint32(entry + 8, bytes.length, true);
        out.set(bytes, at);
        at += bytes.length;
    });
    return out;
}

/**
 * The records of a seed, as views into it; null for bytes that are not a seed
 * of this format and this store's layout version, or that end before their
 * records do.
 *
 * @param {Uint8Array} seed
 * @returns {[string, Uint8Array][] | null}
 */
export function unpackSeed(seed){
    if (seed.length < SEED_HEADER
        || String.fromCharCode(...seed.subarray(0, SEED_MAGIC.length)) !== SEED_MAGIC)
    {
        return null;
    }
    const view = new DataView(seed.buffer, seed.byteOffset, seed.byteLength);
    const count = view.getUint32(16, true);
    if (view.getUint32(8, true) !== SEED_FORMAT || view.getUint32(12, true) !== STORE_VERSION
        || SEED_HEADER + count * SEED_ENTRY > seed.length)
    {
        return null;
    }
    /** @type {[string, Uint8Array][]} */
    const records = [];
    let at = SEED_HEADER + count * SEED_ENTRY;
    for (let i = 0; i < count; i++)
    {
        const entry = SEED_HEADER + i * SEED_ENTRY;
        const length = view.getUint32(entry + 8, true);
        if (length === 0 || at + length > seed.length)
        {
            return null;
        }
        const name = view.getUint32(entry).toString(16).padStart(8, '0')
            + view.getUint32(entry + 4).toString(16).padStart(8, '0') + '.cork';
        records.push([name, seed.subarray(at, at + length)]);
        at += length;
    }
    return records;
}

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
 * re-put stayed for ever: a profile reached 29 GB. The index is judged on its
 * own as well: a warm run touches every record it reads, a line each, so with
 * the records under the floor it grew by a run's reads every run and was read
 * whole at every open; past `indexFloor` and four times the lines the live
 * records need, it is rewritten with them.
 */
const LIMITS = { keepSessions: 4, compactFloor: 64 << 20, cap: 1 << 30, indexFloor: 4 << 20 };

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
 * @param {{ keepSessions: number, compactFloor: number, cap: number,
 *     indexFloor?: number }} [limits]
 *     the ages and sizes it is kept to (tests shrink them)
 * @returns {Promise<SeedableStore>}
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
    /** The index is read and the files are this opening's, so `places` answers at once. */
    let opened = false;
    /** Seeds on their way in, which every lookup waits for. */
    let seedsTaking = 0;
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

    /** Through the synchronous handle. @param {number} offset @param {number} length */
    const readNow = (offset, length)=>{
        const bytes = new Uint8Array(length);
        return access.read(bytes, { at: offset }) === length ? bytes : null;
    };

    /** @param {number} offset @param {number} length */
    const readAt = async(offset, length)=>{
        if (access !== null)
        {
            return readNow(offset, length);
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
        // A live record's line is some fifty bytes.
        const indexBloated = indexEnd > Math.max(limits.indexFloor ?? LIMITS.indexFloor,
            live.length * 200);
        if (liveBytes <= limits.cap && !indexBloated
            && (end < limits.compactFloor || liveBytes * 2 > end))
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
            opened = true;
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

    /**
     * Appends records at places already taken from `end`: one write each
     * through the synchronous handle, one stream for all of them without it.
     *
     * @param {[number, Uint8Array][]} writes  offset and bytes
     */
    const appendRecords = async writes=>{
        if (access !== null)
        {
            // A few milliseconds at a time, the thread let go between: the
            // writes run on the engine's own thread, and a seed's thousands
            // held it for hundreds of milliseconds while the program loaded --
            // long enough for a guest's sound mixer to miss its turns.
            let since = performance.now();
            for (const [offset, bytes] of writes)
            {
                access.write(bytes, { at: offset });
                if (performance.now() - since >= WRITE_SLICE_MS)
                {
                    await new Promise(resolve=>setTimeout(resolve, 0));
                    since = performance.now();
                }
            }
            return;
        }
        appending = appending.then(async()=>{
            const writable = await records.createWritable({ keepExistingData: true });
            for (const [offset, bytes] of writes)
            {
                await writable.write({ type: 'write', position: offset, data: bytes });
            }
            await writable.close();
        });
        await appending;
    };

    /**
     * The seeds being taken in, one after another. Every lookup waits for
     * them, so the engine's first lookup already sees what a seed brought.
     * @type {Promise<unknown>}
     */
    let seeding = Promise.resolve();
    const ready = async()=>{
        await open();
        await seeding;
    };

    /**
     * The place of a key's record, named again in this session when it is
     * used in it, so it outlives the records nobody reads (written with the
     * next batch of lines).
     *
     * @param {string} key
     */
    const use = key=>{
        const recordName = fileNameOf(key);
        const place = /** @type {Map<string, Place>} */ (places).get(recordName);
        if (place && place.session !== session)
        {
            place.session = session;
            pendingLines.push(`${recordName} ${place.offset} ${place.length}\n`);
            if (pendingLines.length >= 512)
            {
                publish();
            }
        }
        return place;
    };

    return {
        async get(key){
            await ready();
            const place = use(key);
            return place ? readAt(place.offset, place.length) : null;
        },
        /**
         * The record at once, without a turn of the event loop -- through the
         * records file's synchronous handle, which a worker has -- or
         * undefined when the store cannot answer that way yet: not opened
         * (asking starts the opening), a seed on its way in, or no such
         * handle (a page). The translator then asks `get`.
         *
         * @param {string} key
         * @returns {Uint8Array | null | undefined}
         */
        getNow(key){
            if (!opened || seedsTaking > 0 || access === null)
            {
                open();
                return undefined;
            }
            const place = use(key);
            return place ? readNow(place.offset, place.length) : null;
        },
        /** Opens the store ahead of its first lookup: its index read, its files open. */
        prepare: ()=>open(),
        async put(key, bytes){
            await ready();
            const offset = end;
            end += bytes.length;
            await appendRecords([[offset, bytes]]);
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
        /**
         * Takes in a seed's records this store does not hold: appended, named
         * in the index and counted as used in this session, before any lookup
         * of this opening is answered. A name held already is left as it is,
         * so taking a seed twice adds nothing; a seed of another format or
         * layout version adds nothing either. `identity` (the seed's digest) is
         * kept once the records are on disk, for `seededWith`.
         *
         * @param {Uint8Array | null | Promise<Uint8Array | null>} source
         * @param {string} [identity]
         * @returns {Promise<{ taken: boolean, added: number, present: number }>}
         */
        seed(source, identity){
            const after = seeding;
            seedsTaking++;
            const taking = (async()=>{
                await after;
                await open();
                const bytes = await source;
                const entries = bytes ? unpackSeed(bytes) : null;
                if (entries === null)
                {
                    return { taken: false, added: 0, present: 0 };
                }
                const all = /** @type {Map<string, Place>} */ (places);
                /** @type {[number, Uint8Array][]} */
                const writes = [];
                for (const [recordName, record] of entries)
                {
                    if (all.has(recordName))
                    {
                        continue;
                    }
                    writes.push([end, record]);
                    all.set(recordName, { offset: end, length: record.length, session });
                    pendingLines.push(`${recordName} ${end} ${record.length}\n`);
                    end += record.length;
                }
                if (writes.length > 0)
                {
                    await appendRecords(writes);
                    await publish();
                }
                if (identity)
                {
                    await writeWhole(directory, SEEDED, new TextEncoder().encode(identity));
                }
                return { taken: true, added: writes.length,
                    present: entries.length - writes.length };
            })().catch(()=>({ taken: false, added: 0, present: 0 })).finally(()=>{
                seedsTaking--;
            });
            seeding = taking;
            return taking;
        },
        /** The identity of the last seed taken in, or null. */
        async seededWith(){
            try
            {
                return await textOf(await (await directory.getFileHandle(SEEDED)).getFile());
            }
            catch {
                return null;
            }
        },
        /**
         * The live records -- the later place of each name used in the last
         * `keepSessions` sessions, what a compaction would keep -- as a seed.
         * `select` narrows them with what only the translator can read in a
         * record: which of them its lookups can still reach.
         *
         * @param {{ select?: (records: [string, Uint8Array][]) => [string, Uint8Array][] }}
         *     [options]
         * @returns {Promise<Uint8Array>}
         */
        async exportSeed({ select } = {}){
            await ready();
            await appending;
            access?.flush();
            const whole = access === null
                ? new Uint8Array(await (await records.getFile()).arrayBuffer()) : null;
            /** @type {[string, Uint8Array][]} */
            const out = [];
            for (const [recordName, place] of /** @type {Map<string, Place>} */ (places))
            {
                if (place.session < session - limits.keepSessions)
                {
                    continue;
                }
                const bytes = whole === null ? await readAt(place.offset, place.length)
                    : whole.subarray(place.offset, place.offset + place.length);
                if (bytes !== null && bytes.length === place.length)
                {
                    out.push([recordName, bytes]);
                }
            }
            return packSeed(select ? select(out) : out);
        },
        /** Lets go of the records file's access handle; nothing else holds one. */
        close(){
            access?.close();
            access = null;
        },
    };
}

/**
 * A directory in memory, with the shape the store uses inside a worker (a
 * synchronous access handle on every file): for a host with no origin file
 * system, such as Node, where a run is captured into a seed or started from
 * one.
 *
 * @returns {{ getDirectoryHandle: Function, getFileHandle: Function,
 *     entries: () => AsyncGenerator<[string, any]>, removeEntry: Function }}
 */
export function createMemoryDirectory(){
    /** @type {Map<string, any>} */
    const children = new Map();
    const fileHandle = ()=>{
        let bytes = new Uint8Array(0);
        let size = 0;
        /** @param {number} wanted */
        const reserve = wanted=>{
            if (wanted > bytes.length)
            {
                // Doubled, as a run appends its records a few at a time.
                const grown = new Uint8Array(Math.max(wanted, bytes.length * 2));
                grown.set(bytes.subarray(0, size));
                bytes = grown;
            }
        };
        return {
            async getFile(){
                const copy = bytes.slice(0, size);
                return { size, arrayBuffer: async()=>copy.buffer };
            },
            async createSyncAccessHandle(){
                return {
                    getSize: ()=>size,
                    /** @param {Uint8Array} into @param {{ at: number }} where */
                    read(into, { at }){
                        const length = Math.max(0, Math.min(into.length, size - at));
                        into.set(bytes.subarray(at, at + length));
                        return length;
                    },
                    /** @param {Uint8Array} from @param {{ at: number }} where */
                    write(from, { at }){
                        reserve(at + from.length);
                        bytes.set(from, at);
                        size = Math.max(size, at + from.length);
                        return from.length;
                    },
                    /** @param {number} length */
                    truncate(length){
                        reserve(length);
                        bytes.fill(0, Math.min(length, size), bytes.length);
                        size = length;
                    },
                    flush(){},
                    close(){},
                };
            },
        };
    };
    /**
     * @param {string} name @param {{ create?: boolean }} options
     * @param {() => any} make
     */
    const child = (name, options, make)=>{
        let found = children.get(name);
        if (found === undefined)
        {
            if (!options.create)
            {
                throw new DOMException(`${name} not found`, 'NotFoundError');
            }
            found = make();
            children.set(name, found);
        }
        return found;
    };
    return {
        /** @param {string} name @param {{ create?: boolean }} [options] */
        getDirectoryHandle: async(name, options = {})=>child(name, options, createMemoryDirectory),
        /** @param {string} name @param {{ create?: boolean }} [options] */
        getFileHandle: async(name, options = {})=>child(name, options, fileHandle),
        async* entries(){
            yield* children;
        },
        /** @param {string} name */
        removeEntry: async name=>{
            children.delete(name);
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
