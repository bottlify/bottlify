/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * opfs-file -- the one way the engine writes to the origin's private file
 * system: a file's synchronous handle taken, a write taken whole or not at
 * all, a whole file replaced, a small file appended to. Every writer below
 * goes through it, so the rules are said once:
 *
 * - A synchronous handle is taken here (`openSync`) and nowhere else: none
 *   where the thread has none (a page's own thread) or where the browser's
 *   answers with promises (WebKit before 16.4), the shared mode asked for
 *   where two holders have to stand together.
 * - A write the disk takes in part is not written (`writeAll`): it throws, as
 *   a refused one does, and the caller's failure path takes it -- a place
 *   named after it would read bytes that are not there, or zeroes once a
 *   later write past the end filled the gap.
 * - A file replaced whole (`replaceWhole`) is replaced through the browser's
 *   stream where the caller needs the old one left whole if the write is cut
 *   short (`atomic`: the stream writes a copy and swaps it in at close); a
 *   stream cut short is aborted, so its copy and its lock go with it.
 *   Otherwise through a synchronous handle where the thread has one, the
 *   reader then expected to tell a file cut short from a whole one.
 * - Two writes of one file through this module go one after the other
 *   (`replaceWhole`, `writeAt`): a sync handle is the origin's exclusive lock
 *   on its file, and a second taken while the first is held is refused.
 * - The disk full is `QuotaExceededError` as the browser names it, passed on
 *   as it is: each writer decides what it gives up (`isQuota`).
 *
 * The writers, what each writes and how it survives a write cut short:
 *
 * | writer | writes | thread, handles | flushed | cut short | read back by |
 * | --- | --- | --- | --- | --- | --- |
 * | `filesystem/internal/opfs-store.js` (the bundle's block cache, `bundle/cache.js`) | the cache's table, packs of blocks, read order | the engine's worker, a pool of exclusive sync handles, one a file | at `flush`, `close` and when a handle leaves the pool | the table names a block only once its record is written; a record's header is checked against the block it is taken for | the cache, this run and the next |
 * | `filesystem/internal/page-file.js` | what a program wrote that the pieces held in memory do not fit | the engine's worker, one exclusive sync handle on a file of the run's own | never: nothing after the run reads it | a write refused or cut short is said once and nothing more is written out; the pieces stay in memory | itself, this run only; a left file is removed at the next start |
 * | `cpu/internal/translation-store.js` | the records file, its index (a log), `current` and `seeded`, a compaction's next generation | the engine's worker: the records through the writer worker below or its own sync handle, the index appended and the small files replaced through a sync handle each time; a page: streams | before each index append (so the index never names bytes not on the disk), at `flush` | an index line past the records' end is no record; a torn `current` names no generation; a write cut short breaks the store for the run | the store at the next opening; an executor reading records by place |
 * | `cpu/internal/translation-store.writer.js` | the records and the index appends of the store above | a worker of its own, a shared (`readwrite-unsafe`) handle beside the store's | when the store asks | as the store above: its answer fails, and the store is broken | the store |
 * | `storage.js` (`opfsSession`) | a session's entries, one file each | whichever thread holds the session, streams (atomic) | at each stream's close | the stream's copy is swapped in only when whole; one cut short is aborted, the old entry left | `load`, `list`, `read` at the next start |
 *
 * Not writers: `cpu/internal/executor.worker.js` reads records through a
 * shared handle of its own (`openSync`); `storage-budget.js` lists and removes
 * whole entries; `bundle-in-place.js` writes a container through a handle its
 * caller opened and hands in (a launcher's download).
 */

/**
 * The surface of a `FileSystemSyncAccessHandle` the writers use.
 *
 * @typedef {Object} SyncFile
 * @property {(into: Uint8Array, where: { at: number }) => number} read
 * @property {(from: Uint8Array, where: { at: number }) => number} write
 * @property {(size: number) => void} truncate
 * @property {() => number} getSize
 * @property {() => void} flush
 * @property {() => void} close
 */

/**
 * A file's synchronous handle, or null where this thread has none to give:
 * no such call on the file (a page's own thread), or a handle whose calls are
 * promises (WebKit before 16.4), which cannot answer a guest's read at once
 * and is closed again here. `shared`: the mode two holders stand together in
 * (`readwrite-unsafe`); a browser that has no such mode refuses it, and the
 * refusal is the caller's to take. A lock another holder has is refused with
 * the browser's `NoModificationAllowedError`.
 *
 * @param {any} file  a `FileSystemFileHandle`
 * @param {{ shared?: boolean }} [options]
 * @returns {Promise<SyncFile | null>}
 */
export async function openSync(file, { shared = false } = {}){
    if (typeof file?.createSyncAccessHandle !== 'function')
    {
        return null;
    }
    const access = shared ? await file.createSyncAccessHandle({ mode: 'readwrite-unsafe' })
        : await file.createSyncAccessHandle();
    if (typeof access?.getSize?.()?.then === 'function')
    {
        await access.close();
        return null;
    }
    return access;
}

/**
 * Writes `bytes` at `at`, whole or not at all: a disk that takes part of them
 * throws here as one that refuses them does.
 *
 * @param {Pick<SyncFile, 'write'>} access @param {Uint8Array} bytes @param {number} at
 */
export function writeAll(access, bytes, at){
    const wrote = access.write(bytes, { at });
    if (wrote !== bytes.length)
    {
        throw new Error(`opfs: ${wrote} of ${bytes.length} bytes written at ${at}`);
    }
}

/** @template T @typedef {Iterable<T> | AsyncIterable<T>} Parts */

/** Whether a failure is the disk out of room. @param {unknown} e */
export const isQuota = e=>/** @type {any} */ (e)?.name === 'QuotaExceededError';

/**
 * The writes of each file under way through this module, by its handle: the
 * next one waits for them.
 *
 * @type {WeakMap<object, Promise<unknown>>}
 */
const underWay = new WeakMap();

/**
 * `write` after every write of `file` this module has under way.
 *
 * @template T
 * @param {any} file @param {() => Promise<T>} write
 * @returns {Promise<T>}
 */
function inTurn(file, write){
    const before = underWay.get(file) ?? Promise.resolve();
    const done = before.catch(()=>{}).then(write);
    const settled = done.catch(()=>{});
    underWay.set(file, settled);
    settled.then(()=>{
        if (underWay.get(file) === settled)
        {
            underWay.delete(file);
        }
    });
    return done;
}

/**
 * Writes the parts into a stream, closed when all are in and aborted when one
 * is refused: an unclosed stream keeps its copy and the file's lock.
 *
 * @param {any} stream @param {Parts<Uint8Array | { type: 'write', position: number,
 *     data: Uint8Array }>} parts
 */
async function intoStream(stream, parts){
    try
    {
        for await (const part of parts)
        {
            await stream.write(part);
        }
    }
    catch (e){
        await Promise.resolve(stream.abort?.()).catch(()=>{});
        throw e;
    }
    await stream.close();
}

/**
 * Replaces a file of `directory` whole with `parts`, one after another, the
 * file made where it is not there.
 *
 * `atomic`: through the browser's stream, which leaves the old file whole
 * until the new one is; for a file a write cut short must not lose (a saved
 * game). Otherwise through a synchronous handle where the thread has one
 * (cut, written, flushed, closed), the stream where it has none.
 *
 * @param {any} directory  a `FileSystemDirectoryHandle`
 * @param {string} name
 * @param {Parts<Uint8Array>} parts  made as they are written where they come from a
 *     generator: a compaction reads each record as it copies it
 * @param {{ atomic?: boolean }} [options]
 */
export async function replaceWhole(directory, name, parts, { atomic = false } = {}){
    const file = await directory.getFileHandle(name, { create: true });
    return inTurn(file, async()=>{
        const access = atomic ? null : await openSync(file);
        if (access === null)
        {
            await intoStream(await file.createWritable(), parts);
            return;
        }
        try
        {
            access.truncate(0);
            let at = 0;
            for await (const part of parts)
            {
                writeAll(access, part, at);
                at += part.length;
            }
            access.flush();
        }
        finally
        {
            access.close();
        }
    });
}

/**
 * Writes each of `writes` at its place in a file, kept as it is around them:
 * a synchronous handle taken for these writes, flushed and closed, where the
 * thread has one; one stream for all of them where it has none (a stream is a
 * copy of the whole file, so one for each would copy it each time).
 *
 * @param {any} file  a `FileSystemFileHandle`
 * @param {[number, Uint8Array][]} writes  where and what
 */
export function writeAt(file, writes){
    return inTurn(file, async()=>{
        const access = await openSync(file);
        if (access === null)
        {
            await intoStream(await file.createWritable({ keepExistingData: true }),
                writes.map(([position, data])=>({ type: /** @type {const} */ ('write'),
                    position, data })));
            return;
        }
        try
        {
            for (const [at, bytes] of writes)
            {
                writeAll(access, bytes, at);
            }
            access.flush();
        }
        finally
        {
            access.close();
        }
    });
}
