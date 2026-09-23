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
 * turn of the event loop.
 *
 * A record's name is a hash of its key, two ways so a collision needs both
 * to agree; the key's own characters would be a path.
 */

/** @typedef {import('../engine.js').TranslationStore} TranslationStore */

/**
 * The store's own layout version: a bundle directory of another version is
 * not read, so a change to the record naming or the files does not mix old
 * bytes into the new set. (The records' own version is the emitter's.)
 */
export const STORE_VERSION = 2;

/** The file every record is appended to, and the one naming their places. */
const RECORDS = 'records';
const INDEX = 'index';

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
 * Writes the whole of a small file: the synchronous handle inside a worker,
 * the stream on the page.
 *
 * @param {any} handle @param {Uint8Array} bytes
 */
async function writeWhole(handle, bytes){
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
 * A store over a directory handle (the origin private file system's, or
 * anything with its shape).
 *
 * @param {{ getDirectoryHandle: Function }} root  where the bundle's directory is made
 * @param {string} name  the bundle's, made safe for a directory name
 * @returns {Promise<TranslationStore & { flush: () => Promise<void>, close: () => void }>}
 */
export async function createDirectoryTranslationStore(root, name){
    const safe = name.replace(/[^A-Za-z0-9._-]/g, '_') || 'bundle';
    const cork = await root.getDirectoryHandle('cork', { create: true });
    const directory = await cork.getDirectoryHandle(`${safe}.v${STORE_VERSION}`, { create: true });
    /** Each record's place in the records file, read once; null until then.
     * @type {Map<string, { offset: number, length: number }> | null} */
    let places = null;
    /** The records file's handle, and its synchronous access inside a worker. */
    /** @type {any} */
    let records = null;
    /** @type {any} */
    let access = null;
    /** Where the next record goes: the records file's size. */
    let end = 0;
    /** @type {Promise<void> | null} */
    let opening = null;

    const open = ()=>{
        opening ??= (async()=>{
            places = new Map();
            records = await directory.getFileHandle(RECORDS, { create: true });
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
            try
            {
                const handle = await directory.getFileHandle(INDEX);
                const text = await textOf(await handle.getFile());
                for (const line of text.split('\n'))
                {
                    const [recordName, offsetText, lengthText] = line.split(' ');
                    const offset = Number(offsetText);
                    const length = Number(lengthText);
                    // A place past the file's end is a write the index outran
                    // (the page went away between the two): not a record.
                    if (recordName && Number.isInteger(offset) && Number.isInteger(length)
                        && length >= 0 && offset + length <= end)
                    {
                        places.set(recordName, { offset, length });
                    }
                }
            }
            catch {
                // No index yet: an empty bundle.
            }
        })();
        return opening;
    };

    // The index is rewritten whole from the in-memory map, not appended to,
    // and one write is in flight at a time: several puts land in the same
    // turn, and the write that is queued carries all of them. The records
    // are flushed first, so the index never names bytes not yet on disk.
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
                const text = [...places ?? []]
                    .map(([recordName, place])=>`${recordName} ${place.offset} ${place.length}\n`)
                    .join('');
                await writeWhole(await directory.getFileHandle(INDEX, { create: true }),
                    new TextEncoder().encode(text));
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
            const place = /** @type {Map<string, { offset: number, length: number }>} */ (places)
                .get(fileNameOf(key));
            if (!place)
            {
                return null;
            }
            if (access !== null)
            {
                const bytes = new Uint8Array(place.length);
                const read = access.read(bytes, { at: place.offset });
                return read === place.length ? bytes : null;
            }
            const file = await records.getFile();
            return new Uint8Array(
                await file.slice(place.offset, place.offset + place.length).arrayBuffer());
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
            /** @type {Map<string, { offset: number, length: number }>} */ (places)
                .set(fileNameOf(key), { offset, length: bytes.length });
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
