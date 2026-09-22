/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where a translator keeps its regions between runs: a directory of the
 * origin's private file system, one file per record, under a name for the
 * bundle. Resolved inside the engine's own thread from a request, as the
 * block store is, since a store with functions in it cannot cross to the
 * engine from the page.
 *
 * A record's file name is a hash of its key, so a lookup cannot tell a miss
 * from a hit without asking the file system -- and a browser's file system
 * answers a miss with an exception that costs milliseconds. The bundle
 * therefore keeps an index of the record names in one file, read once when
 * the store is first used: a lookup is a probe of that set and only a hit
 * touches the file system for its bytes.
 */

/** @typedef {import('../engine.js').TranslationStore} TranslationStore */

/**
 * The store's own layout version: a bundle directory of another version is
 * not read, so a change to the record naming or the index does not mix old
 * files into the new set. (The records' own version is the emitter's.)
 */
export const STORE_VERSION = 1;

/** The one file that lists every record name in the bundle's directory. */
const INDEX = 'index';

/**
 * A file name for a key: the key's own characters are a path; what names
 * the file is a hash of it, two ways so a collision needs both to agree.
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
 * Writes the whole record into its file, the synchronous handle inside a
 * worker, the stream on the page.
 *
 * @param {any} handle @param {Uint8Array} bytes
 */
async function writeRecord(handle, bytes){
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
 * @returns {Promise<TranslationStore>}
 */
export async function createDirectoryTranslationStore(root, name){
    const safe = name.replace(/[^A-Za-z0-9._-]/g, '_') || 'bundle';
    const cork = await root.getDirectoryHandle('cork', { create: true });
    const directory = await cork.getDirectoryHandle(`${safe}.v${STORE_VERSION}`, { create: true });
    /** The record names, read once; null until then. @type {Set<string> | null} */
    let names = null;
    /** The bundle's record index. @returns {Promise<Set<string>>} */
    const index = async()=>{
        if (names !== null)
        {
            return names;
        }
        names = new Set();
        try
        {
            const handle = await directory.getFileHandle(INDEX);
            const text = await textOf(await handle.getFile());
            for (const line of text.split('\n'))
            {
                if (line)
                {
                    names.add(line);
                }
            }
        }
        catch {
            // No index yet: an empty bundle.
        }
        return names;
    };
    /** Appends a record name to the index. @param {string} line */
    const publish = async line=>{
        const handle = await directory.getFileHandle(INDEX, { create: true });
        if (typeof handle.createSyncAccessHandle === 'function')
        {
            const access = await handle.createSyncAccessHandle();
            try
            {
                access.write(new TextEncoder().encode(line), { at: access.getSize() });
                access.flush();
            }
            finally
            {
                access.close();
            }
            return;
        }
        // No synchronous handle: the index is small next to the records, so
        // read it back and rewrite it with the line.
        let existing = '';
        try
        {
            existing = await textOf(await handle.getFile());
        }
        catch {
            // The first line.
        }
        const writable = await handle.createWritable();
        await writable.write(new TextEncoder().encode(existing + line));
        await writable.close();
    };
    return {
        async get(key){
            const fileName = fileNameOf(key);
            if (!(await index()).has(fileName))
            {
                return null;
            }
            const handle = await directory.getFileHandle(fileName);
            const file = await handle.getFile();
            return new Uint8Array(await file.arrayBuffer());
        },
        async put(key, bytes){
            const fileName = fileNameOf(key);
            const handle = await directory.getFileHandle(fileName, { create: true });
            await writeRecord(handle, bytes);
            const set = await index();
            if (!set.has(fileName))
            {
                set.add(fileName);
                await publish(`${fileName}\n`);
            }
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
