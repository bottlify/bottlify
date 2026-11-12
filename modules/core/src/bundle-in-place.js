/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A .btl laid out before its files' bytes are known, for a writer that gets
 * them out of order -- a download of chunks from several servers at once.
 * Every block is stored as it is, so where each file lies in the container
 * follows from the sizes alone: the bytes go straight to their place in any
 * order, and the bottle is never written a second time to pack it. The index
 * goes in last, once every byte is in (`finishBundle`), each block's checksum
 * and each file's digest read back from where they lie.
 *
 * What it gives up is compression: the Node writer deflates a block where that
 * saves a few per cent, and a game's data is mostly compressed already.
 */

import {
    Codec, DEFAULT_BLOCK_SIZE, FORMAT_VERSION, HEADER_SIZE, MAGIC,
} from './layers/filesystem/internal/bundle/format.js';
import { crc32 } from './layers/filesystem/internal/bundle/crc32.js';
import { createSha256 } from './layers/win32/crypto/digest.js';

/**
 * Random access to the container's bytes, as a worker's
 * FileSystemSyncAccessHandle gives it (a test's file in Node, the same shape).
 *
 * @typedef {Object} RandomAccess
 * @property {(buffer: Uint8Array, options: { at: number }) => number} read
 * @property {(buffer: Uint8Array, options: { at: number }) => number} write
 * @property {(size: number) => unknown} truncate
 * @property {() => unknown} flush
 * @property {() => number} getSize
 */

/**
 * @typedef {Object} PlacedFile
 * @property {string} path  Backslashed, as the bundle names it.
 * @property {number} size
 * @property {number} at  Where its bytes start in the container.
 */

/**
 * Where each file goes: one after another from `start`, in the order given.
 * Files placed later go after these, which do not move.
 *
 * @param {{ path: string, size: number }[]} files
 * @param {number} [start]  The header's end, or where the files placed before end.
 * @returns {{ files: PlacedFile[], end: number }}
 */
export function placeFiles(files, start = HEADER_SIZE){
    let at = start;
    const placed = files.map(({ path, size })=>{
        const file = { path, size, at };
        at += size;
        return file;
    });
    return { files: placed, end: at };
}

/** @param {Uint8Array} bytes */
const hex = bytes=>Array.from(bytes, byte=>byte.toString(16).padStart(2, '0')).join('');

/**
 * Paths in the order a directory's files are packed (tools/make-btl.mjs): each
 * folder's entries by name, as code units, a folder's files where its name falls.
 *
 * @param {string} a @param {string} b
 */
export function comparePaths(a, b){
    const left = a.split('\\');
    const right = b.split('\\');
    for (let at = 0; at < Math.min(left.length, right.length); at++)
    {
        if (left[at] !== right[at])
        {
            return left[at] < right[at] ? -1 : 1;
        }
    }
    return left.length - right.length;
}

/**
 * The files placed in the container as a tree a store's finishing steps read
 * and write (redist.js's AppTree): a file read is read where it lies; one
 * written is held, and `settle` places what was written after the files --
 * over a file of the same path, the new bytes -- and answers the bundle's
 * files in packing order.
 *
 * @param {RandomAccess} handle
 * @param {{ files: PlacedFile[], end: number }} placed
 * @param {string} store  Its name, for what a failure says.
 */
export function treeInPlace(handle, placed, store){
    /** @type {Map<string, Uint8Array>} By folded path. */
    const added = new Map();
    /** @type {Map<string, string>} */
    const spelt = new Map();
    const byPath = new Map(placed.files.map(file=>[file.path.toLowerCase(), file]));
    /** @type {import('./steam/redist.js').AppTree} */
    const tree = {
        list: async()=>[...new Set([...placed.files.map(file=>file.path), ...spelt.values()])],
        read: async path=>{
            const fresh = added.get(path.toLowerCase());
            const file = byPath.get(path.toLowerCase());
            if (fresh || !file)
            {
                if (!fresh)
                {
                    throw new Error(`${store}: ${path} is not in the app`);
                }
                return fresh;
            }
            const bytes = new Uint8Array(file.size);
            handle.read(bytes, { at: file.at });
            return bytes;
        },
        write: async(path, bytes)=>{
            added.set(path.toLowerCase(), bytes);
            spelt.set(path.toLowerCase(), byPath.get(path.toLowerCase())?.path ?? path);
        },
    };
    return {
        tree,
        /**
         * A path as the tree spells it, whatever its case and slashes.
         *
         * @param {string | null | undefined} path
         * @returns {string | null}
         */
        find: path=>{
            const folded = path?.replace(/\//g, '\\').toLowerCase();
            return folded ? spelt.get(folded) ?? byPath.get(folded)?.path ?? null : null;
        },
        /** @returns {PlacedFile[]} */
        settle(){
            const extra = placeFiles([...added].map(([folded, bytes])=>({
                path: /** @type {string} */ (spelt.get(folded)), size: bytes.length })), placed.end);
            for (const file of extra.files)
            {
                handle.write(/** @type {Uint8Array} */ (added.get(file.path.toLowerCase())),
                    { at: file.at });
            }
            return [...placed.files.filter(file=>!added.has(file.path.toLowerCase())),
                ...extra.files].sort((a, b)=>comparePaths(a.path, b.path));
        },
    };
}

/**
 * A file a store lists as chunks, each a stretch of it at `offset`.
 *
 * @typedef {{ path: string, size: number, chunks: { offset: number, size: number }[] }} ChunkedFile
 */

/**
 * Downloads files' chunks, `jobs` at a time, each from the first source that
 * gives it -- each chunk starting from another source, so the load spreads --
 * and hands each to `write`. Chunks are numbered across the files in order;
 * `done` says which are in place already. A failure, or the signal, stops the
 * chunks not started; those started finish first.
 *
 * @template {ChunkedFile} F
 * @template S
 * @param {Object} options
 * @param {F[]} options.files
 * @param {S[]} options.sources  Content servers, CDN endpoints: what `fetchChunk` is given.
 * @param {(source: S, file: F, chunk: F['chunks'][number]) => Promise<Uint8Array>}
 *     options.fetchChunk  A chunk's bytes as they lie in the file, checked.
 * @param {(file: F, chunk: F['chunks'][number], bytes: Uint8Array, task: number) => unknown}
 *     options.write
 * @param {(task: number) => boolean} [options.done]
 * @param {number} [options.jobs]
 * @param {AbortSignal} [options.signal]
 * @param {(bytes: number, task: number) => unknown} [options.onChunk]  A chunk in place.
 */
export async function downloadChunks({ files, sources, fetchChunk, write, done = ()=>false,
    jobs = 16, signal, onChunk })
{
    /** @type {{ file: F, chunk: F['chunks'][number], task: number }[]} */
    const tasks = [];
    let number = 0;
    for (const file of files)
    {
        for (const chunk of file.chunks)
        {
            const task = number++;
            if (!done(task))
            {
                tasks.push({ file, chunk, task });
            }
        }
    }
    let next = 0;
    /** @type {{ error: unknown } | null} */
    let failed = null;
    const worker = async()=>{
        while (next < tasks.length && !failed && !signal?.aborted)
        {
            const { file, chunk, task } = tasks[next++];
            try
            {
                /** @type {Uint8Array | null} */
                let bytes = null;
                /** @type {unknown} */
                let last;
                for (let attempt = 0; attempt < sources.length * 2 && !bytes; attempt++)
                {
                    try
                    {
                        bytes = await fetchChunk(sources[(task + attempt) % sources.length], file,
                            chunk);
                    }
                    catch (e){
                        last = e;
                    }
                }
                if (!bytes)
                {
                    throw last;
                }
                await write(file, chunk, bytes, task);
                await onChunk?.(chunk.size, task);
            }
            catch (e){
                failed ??= { error: e };
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
    if (failed)
    {
        throw /** @type {{ error: unknown }} */ (failed).error;
    }
    signal?.throwIfAborted();
}

/**
 * The chunks whose bytes in place are not what the store says, by task number
 * as `downloadChunks` counts them, and their files.
 *
 * @template {ChunkedFile} F
 * @param {F[]} files @param {Map<string, number>} at  Where each file starts.
 * @param {RandomAccess} handle
 * @param {(bytes: Uint8Array, chunk: F['chunks'][number]) => boolean} intact
 * @param {(task: number) => boolean} [which]  The chunks to read back; every one by default.
 */
export function wrongChunksOf(files, at, handle, intact, which = ()=>true){
    /** @type {number[]} */
    const tasks = [];
    /** @type {Set<string>} */
    const paths = new Set();
    let task = 0;
    for (const file of files)
    {
        for (const chunk of file.chunks)
        {
            if (!which(task))
            {
                task++;
                continue;
            }
            const bytes = new Uint8Array(chunk.size);
            const read = handle.read(bytes, { at: /** @type {number} */ (at.get(file.path))
                + chunk.offset });
            if (read !== chunk.size || !intact(bytes, chunk))
            {
                tasks.push(task);
                paths.add(file.path);
            }
            task++;
        }
    }
    return { tasks, paths: [...paths] };
}

/**
 * What a fill that stopped part way has done: the build it was filling
 * (`stamp`), and a bit a chunk in place.
 *
 * @typedef {{ stamp: string, done: Uint8Array }} FillProgress
 */

/**
 * Lays files out in the container and brings every chunk to its place
 * (`downloadChunks`). A run stopped part way is taken up where it was from
 * what it saved (`onSave`, after the bytes it counts are flushed); another
 * build's (`stamp`) starts it over. The chunks a run took up are read back
 * with `intact`, and one that differs is fetched again, once. The bundle is
 * not finished: what the store adds after its files goes after `placed.end`.
 *
 * @template {ChunkedFile} F
 * @template S
 * @param {Object} options
 * @param {RandomAccess} options.handle
 * @param {F[]} options.files  In the order the bundle packs them.
 * @param {S[]} options.sources
 * @param {(source: S, file: F, chunk: F['chunks'][number]) => Promise<Uint8Array>}
 *     options.fetchChunk
 * @param {(bytes: Uint8Array, chunk: F['chunks'][number]) => boolean} options.intact
 * @param {string} options.stamp  The build, as a resumed run is matched against.
 * @param {string} options.store  Its name, for what a failure says.
 * @param {FillProgress | null} [options.resume]
 * @param {(progress: FillProgress) => unknown} [options.onSave]
 * @param {number} [options.jobs]
 * @param {AbortSignal} [options.signal]
 * @param {(progress: { stage: 'downloading', done: number, total: number }) => void}
 *     [options.onProgress]  Bytes.
 * @returns {Promise<{ placed: { files: PlacedFile[], end: number }, rewritten: string[] }>}
 */
export async function fillInPlace({ handle, files, sources, fetchChunk, intact, stamp, store,
    resume = null, onSave, jobs, signal, onProgress })
{
    const placed = placeFiles(files);
    const chunks = files.reduce((sum, file)=>sum + file.chunks.length, 0);
    const going = resume?.stamp === stamp && resume.done.length === Math.ceil(chunks / 8)
        && handle.getSize() >= placed.end;
    const done = going ? /** @type {FillProgress} */ (resume).done
        : new Uint8Array(Math.ceil(chunks / 8));
    if (!going)
    {
        // Zeros where a file has no chunk, not what an earlier build left.
        await handle.truncate(0);
        await handle.truncate(placed.end);
    }

    let total = 0;
    let installed = 0;
    let task = 0;
    for (const file of files)
    {
        for (const chunk of file.chunks)
        {
            total += chunk.size;
            installed += done[task >> 3] & (1 << (task & 7)) ? chunk.size : 0;
            task++;
        }
    }
    let saved = Date.now();
    /**
     * One save at a time: chunks land from several downloads at once, and a
     * second save while the first still holds its file (a browser's sync
     * access handle) is refused.
     *
     * @type {Promise<void> | null}
     */
    let saving = null;
    const save = ()=>(saving ??= (async()=>{
        try
        {
            await handle.flush();
            await onSave?.({ stamp, done });
            saved = Date.now();
        }
        finally
        {
            saving = null;
        }
    })());
    const at = new Map(placed.files.map(file=>[file.path, file.at]));
    onProgress?.({ stage: 'downloading', done: installed, total });
    const fetchMissing = async()=>{
        try
        {
            await downloadChunks({ files, sources, fetchChunk, jobs, signal,
                done: number=>(done[number >> 3] & (1 << (number & 7))) !== 0,
                write: (file, chunk, bytes)=>handle.write(bytes,
                    { at: /** @type {number} */ (at.get(file.path)) + chunk.offset }),
                onChunk: async(bytes, number)=>{
                    done[number >> 3] |= 1 << (number & 7);
                    installed += bytes;
                    onProgress?.({ stage: 'downloading', done: installed, total });
                    if (saving === null && Date.now() - saved > 2000)
                    {
                        await save();
                    }
                } });
        }
        finally
        {
            await saving;
            await save();
        }
    };
    // What this run fetched was checked as it was opened; what it took up from
    // an earlier run is only what that run wrote down.
    const takenUp = going ? Uint8Array.from(done) : null;
    await fetchMissing();
    /** @type {string[]} */
    const rewritten = [];
    for (let round = 0; ; round++)
    {
        signal?.throwIfAborted();
        const wrong = takenUp ? wrongChunksOf(files, at, handle, intact,
            number=>(takenUp[number >> 3] & (1 << (number & 7))) !== 0) : { tasks: [], paths: [] };
        if (wrong.tasks.length === 0)
        {
            break;
        }
        if (round > 0)
        {
            throw new Error(`${store}: ${wrong.paths.length} file(s) still differ from the manifest`
                + ` after being fetched again: ${wrong.paths.slice(0, 5).join(', ')}`);
        }
        for (const wrongTask of wrong.tasks)
        {
            done[wrongTask >> 3] &= ~(1 << (wrongTask & 7));
        }
        rewritten.push(`${wrong.tasks.length} chunk(s) of ${wrong.paths.length} file(s) were not`
            + ` what the manifest says and were fetched again:`
            + ` ${wrong.paths.slice(0, 5).join(', ')}`);
        await fetchMissing();
    }
    return { placed, rewritten };
}

/**
 * Writes the index after the files and the header in front of them: a bundle
 * the engine opens as any other. The index lists the files in the order given;
 * a placed file left out of it is bytes nothing reads.
 *
 * @param {RandomAccess} handle
 * @param {PlacedFile[]} files  The bundle's files, their bytes in place.
 * @param {string[]} directories  The empty ones, which a program may expect.
 * @param {{ blockSize?: number, hashFiles?: boolean,
 *     onProgress?: (read: number, total: number) => void }} [options]
 *     hashFiles: each file's SHA-256 in the index; a store's install, whose
 *     files were checked against the store's own sums, leaves it out.
 */
export async function finishBundle(handle, files, directories,
    { blockSize = DEFAULT_BLOCK_SIZE, hashFiles = true, onProgress } = {})
{
    /** @type {{ offset: number, packed: number, codec: number, crc: number }[]} */
    const blocks = [];
    /** @type {{ path: string, size: number, firstBlock: number, blocks: number, sha256?: string }[]} */
    const index = [];
    const total = files.reduce((sum, file)=>sum + file.size, 0);
    const buffer = new Uint8Array(blockSize);
    const end = files.reduce((last, file)=>Math.max(last, file.at + file.size), HEADER_SIZE);
    let read = 0;
    for (const file of files)
    {
        const firstBlock = blocks.length;
        // SHA-256 in JS runs at about 100 MB/s, four times slower than the
        // blocks' CRC, and the most of finishing a large game.
        const digest = hashFiles ? createSha256() : null;
        for (let offset = 0; offset < file.size; offset += blockSize)
        {
            const block = buffer.subarray(0, Math.min(blockSize, file.size - offset));
            if (handle.read(block, { at: file.at + offset }) !== block.length)
            {
                throw new Error(`bundle: ${file.path} is cut short in the container`);
            }
            digest?.update(block);
            blocks.push({ offset: file.at + offset, packed: block.length, codec: Codec.STORED,
                crc: crc32(block) });
            read += block.length;
            onProgress?.(read, total);
        }
        index.push({ path: file.path, size: file.size, firstBlock,
            blocks: blocks.length - firstBlock,
            ...digest ? { sha256: hex(digest.digest()) } : {} });
    }

    const indexBytes = new TextEncoder().encode(
        JSON.stringify({ blockSize, files: index, directories, blocks }));
    await handle.truncate(end + indexBytes.length);
    handle.write(indexBytes, { at: end });
    const header = new Uint8Array(HEADER_SIZE);
    const view = new DataView(header.buffer);
    header.set(Array.from(MAGIC, character=>character.charCodeAt(0)));
    view.setUint32(4, FORMAT_VERSION, true);
    view.setUint32(8, blockSize, true);
    view.setBigUint64(0x10, BigInt(end), true);
    view.setBigUint64(0x18, BigInt(indexBytes.length), true);
    view.setUint32(0x20, Codec.STORED, true);
    handle.write(header, { at: 0 });
    await handle.flush();
    const indexDigest = createSha256();
    indexDigest.update(indexBytes);
    return {
        format: `btl/${FORMAT_VERSION}`,
        codec: 'stored',
        blockSize,
        files: index.length,
        directories: directories.length,
        uncompressedBytes: total,
        bytes: end + indexBytes.length,
        totalBlocks: blocks.length,
        indexSha256: hex(indexDigest.digest()),
    };
}
