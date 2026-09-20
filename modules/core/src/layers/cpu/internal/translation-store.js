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
 */

/** @typedef {import('../engine.js').TranslationStore} TranslationStore */

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
    const directory = await cork.getDirectoryHandle(safe, { create: true });
    return {
        async get(key){
            let handle;
            try
            {
                handle = await directory.getFileHandle(fileNameOf(key));
            }
            catch {
                return null;
            }
            const file = await handle.getFile();
            return new Uint8Array(await file.arrayBuffer());
        },
        async put(key, bytes){
            const handle = await directory.getFileHandle(fileNameOf(key), { create: true });
            if (typeof handle.createSyncAccessHandle === 'function')
            {
                // Inside a worker: the synchronous handle, no stream to close.
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
