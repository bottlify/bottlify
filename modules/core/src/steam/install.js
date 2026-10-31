/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A Steam app's depots installed: their manifests, the files they leave -- a
 * path two depots ship is the later one's --, every chunk downloaded from the
 * content servers, and the redistributables applied (`redist.js`). The
 * engine's tools/steam-install.mjs installs into a directory this way, and a
 * page into a bottle it writes in place (`installBundle`): one install, two
 * places it lands.
 */

import { FILE_FLAG_DIRECTORY, downloadChunk, manifest } from './depot.js';
import { finishBundle, placeFiles } from '../bundle-in-place.js';
import { installSteamRedistributables } from './redist.js';

/** @typedef {import('./depot.js').ContentServer} ContentServer */
/** @typedef {import('./depot.js').Manifest} Manifest */
/** @typedef {import('./depot.js').ManifestChunk} ManifestChunk */
/** @typedef {import('../bundle-in-place.js').RandomAccess} RandomAccess */

/**
 * @typedef {Object} DepotOpening  What opens one depot at one manifest
 *     (depot.js's DepotAccess), and whether it is a redistributable's: another
 *     app's depot the app names (`depotfromapp`).
 * @property {number} depot @property {bigint} gid
 * @property {Uint8Array} key @property {bigint} code
 * @property {boolean} [shared]
 */

/**
 * A depot's manifest from the first content server that gives it.
 *
 * @param {ContentServer[]} servers @param {DepotOpening} opening
 * @returns {Promise<Manifest>}
 */
export async function depotManifest(servers, opening){
    /** @type {unknown} */
    let last = new Error('steam: no content server to ask');
    for (const server of servers.slice(0, 4))
    {
        try
        {
            return await manifest(server, opening);
        }
        catch (e){
            last = e;
        }
    }
    throw last;
}

/**
 * @typedef {Object} InstalledFile
 * @property {string} path  Backslashed.
 * @property {number} size
 * @property {Uint8Array} sha  SHA-1 of the whole file.
 * @property {number} depot @property {Uint8Array} key
 * @property {ManifestChunk[]} chunks
 */

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
 * The files an install of depots leaves, in the order a directory's are
 * packed. A path a later depot ships too is the later one's, and a path is
 * spelt as it was first written whatever case a later depot uses, as on
 * Windows. The folders left empty come too, which a program may expect; a
 * link is left out -- a bundle has none -- but keeps its folder from being empty.
 *
 * @param {{ manifest: Manifest, key: Uint8Array }[]} depots  In the order they install.
 * @returns {{ files: InstalledFile[], directories: string[] }}
 */
export function installedFiles(depots){
    /** @type {Map<string, string>} Each path's spelling, by its folded form. */
    const spelt = new Map();
    /** @param {string} name */
    const spell = name=>{
        let path = '';
        for (const part of name.replace(/\//g, '\\').split('\\').filter(Boolean))
        {
            const next = path ? `${path}\\${part}` : part;
            const folded = next.toLowerCase();
            if (!spelt.has(folded))
            {
                spelt.set(folded, next);
            }
            path = /** @type {string} */ (spelt.get(folded));
        }
        return path;
    };
    /** @type {Map<string, InstalledFile>} */
    const files = new Map();
    /** @type {Set<string>} */
    const folders = new Set();
    /** @type {Set<string>} Folders something is in. */
    const holding = new Set();
    for (const { manifest: listed, key } of depots)
    {
        for (const file of listed.files)
        {
            const path = spell(file.name);
            if (!path)
            {
                continue;
            }
            holding.add(path.slice(0, Math.max(0, path.lastIndexOf('\\'))).toLowerCase());
            if (file.flags & FILE_FLAG_DIRECTORY)
            {
                folders.add(path);
            }
            else if (!file.link)
            {
                files.set(path.toLowerCase(), { path, size: file.size, sha: file.sha,
                    depot: listed.depot, key, chunks: file.chunks });
            }
        }
    }
    // A file's own folders hold something; the manifests list them, but not always.
    for (const path of [...files.values()].map(file=>file.path).concat([...folders]))
    {
        for (let at = path.indexOf('\\'); at >= 0; at = path.indexOf('\\', at + 1))
        {
            holding.add(path.slice(0, at).toLowerCase());
        }
    }
    return {
        files: [...files.values()].sort((a, b)=>comparePaths(a.path, b.path)),
        directories: [...folders].filter(path=>!holding.has(path.toLowerCase())).sort(comparePaths),
    };
}

/**
 * Downloads files' chunks, `jobs` at a time, each from the first content
 * server that gives it -- each chunk starting from another server, so the
 * load spreads -- and hands each to `write`. Chunks are numbered across the
 * files in order; `done` says which are in place already. A failure, or the
 * signal, stops the chunks not started; those started finish first.
 *
 * @param {Object} options
 * @param {InstalledFile[]} options.files
 * @param {ContentServer[]} options.servers
 * @param {(file: InstalledFile, chunk: ManifestChunk, bytes: Uint8Array, task: number) => unknown}
 *     options.write
 * @param {(task: number) => boolean} [options.done]
 * @param {(server: ContentServer, depot: number, chunk: ManifestChunk, key: Uint8Array)
 *     => Promise<Uint8Array>} [options.decode]  How a chunk is fetched and opened
 *     (depot.js's downloadChunk): a page runs it in workers.
 * @param {number} [options.jobs]
 * @param {AbortSignal} [options.signal]
 * @param {(bytes: number, task: number) => unknown} [options.onChunk]  A chunk in place.
 */
export async function downloadFiles({ files, servers, write, done = ()=>false,
    decode = downloadChunk, jobs = 16, signal, onChunk })
{
    if (servers.length === 0)
    {
        throw new Error('steam: no content server offered');
    }
    /** @type {{ file: InstalledFile, chunk: ManifestChunk, task: number }[]} */
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
                for (let attempt = 0; attempt < servers.length * 2 && !bytes; attempt++)
                {
                    try
                    {
                        bytes = await decode(servers[(task + attempt) % servers.length],
                            file.depot, chunk, file.key);
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
 * What a run of `installBundle` that stopped part way has done: the depots at
 * their manifests it was installing (`stamp`), and a bit a chunk in place.
 *
 * @typedef {{ stamp: string, done: Uint8Array }} InstallProgress
 */

/**
 * Installs depots into a bundle written in place (bundle-in-place.js) -- a
 * page's install into a file of its origin's storage: every chunk goes
 * straight to where its file lies in the container, the redistributables are
 * applied over it and put after the files, and the index goes in last. A run
 * stopped part way is taken up where it was from what it saved (`onSave`,
 * after the bytes it counts are flushed); a manifest changed since starts it
 * over.
 *
 * @param {Object} options
 * @param {RandomAccess} options.handle
 * @param {DepotOpening[]} options.depots  In the order they install.
 * @param {ContentServer[]} options.servers
 * @param {string} [options.installscript]  The app's own (`extended.installscript`).
 * @param {string} [options.executable]  The program Steam starts, as a path in the app.
 * @param {InstallProgress | null} [options.resume]
 * @param {(progress: InstallProgress) => unknown} [options.onSave]
 * @param {Parameters<typeof downloadFiles>[0]['decode']} [options.decode]
 * @param {number} [options.jobs]
 * @param {AbortSignal} [options.signal]
 * @param {(progress: { stage: 'downloading' | 'finishing', done: number, total: number })
 *     => void} [options.onProgress]  Bytes.
 * @returns {Promise<{ bundle: Awaited<ReturnType<typeof finishBundle>>,
 *     entry: Uint8Array | null, said: string[] }>}
 */
export async function installBundle({ handle, depots, servers, installscript, executable,
    resume = null, onSave, decode, jobs, signal, onProgress })
{
    const listed = [];
    for (const opening of depots)
    {
        signal?.throwIfAborted();
        listed.push({ opening, manifest: await depotManifest(servers, opening) });
    }
    const { files, directories } = installedFiles(
        listed.map(({ opening, manifest: one })=>({ manifest: one, key: opening.key })));
    const placed = placeFiles(files);
    const chunks = files.reduce((sum, file)=>sum + file.chunks.length, 0);
    const stamp = JSON.stringify(depots.map(({ depot, gid })=>[depot, String(gid)]));
    const going = resume?.stamp === stamp && resume.done.length === Math.ceil(chunks / 8)
        && handle.getSize() >= placed.end;
    const done = going ? /** @type {InstallProgress} */ (resume).done
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
    const save = async()=>{
        await handle.flush();
        await onSave?.({ stamp, done });
        saved = Date.now();
    };
    const at = new Map(placed.files.map(file=>[file.path, file.at]));
    onProgress?.({ stage: 'downloading', done: installed, total });
    try
    {
        await downloadFiles({ files, servers, decode, jobs, signal,
            done: number=>(done[number >> 3] & (1 << (number & 7))) !== 0,
            write: (file, chunk, bytes)=>handle.write(bytes,
                { at: /** @type {number} */ (at.get(file.path)) + chunk.offset }),
            onChunk: async(bytes, number)=>{
                done[number >> 3] |= 1 << (number & 7);
                installed += bytes;
                onProgress?.({ stage: 'downloading', done: installed, total });
                if (Date.now() - saved > 2000)
                {
                    await save();
                }
            } });
    }
    finally
    {
        await save();
    }

    // The redistributables, over the files in place; what they write goes after them.
    /** @type {Map<string, Uint8Array>} By folded path. */
    const added = new Map();
    /** @type {Map<string, string>} */
    const spelt = new Map();
    const byPath = new Map(placed.files.map(file=>[file.path.toLowerCase(), file]));
    /** @type {import('./redist.js').AppTree} */
    const tree = {
        list: async()=>[...new Set([...placed.files.map(file=>file.path), ...spelt.values()])],
        read: async path=>{
            const fresh = added.get(path.toLowerCase());
            const file = byPath.get(path.toLowerCase());
            if (fresh || !file)
            {
                if (!fresh)
                {
                    throw new Error(`steam: ${path} is not in the app`);
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
    const said = await installSteamRedistributables(tree, { installscript, executable,
        shared: listed.filter(({ opening })=>opening.shared)
            .flatMap(({ manifest: one })=>one.files.map(file=>file.name)) });
    const extra = placeFiles([...added].map(([folded, bytes])=>({
        path: /** @type {string} */ (spelt.get(folded)), size: bytes.length })), placed.end);
    for (const file of extra.files)
    {
        handle.write(/** @type {Uint8Array} */ (added.get(file.path.toLowerCase())), { at: file.at });
    }
    const bundled = [...placed.files.filter(file=>!added.has(file.path.toLowerCase())),
        ...extra.files].sort((a, b)=>comparePaths(a.path, b.path));
    const bundle = await finishBundle(handle, bundled, directories, {
        onProgress: (read, all)=>onProgress?.({ stage: 'finishing', done: read, total: all }) });
    const program = executable ? byPath.get(executable.replace(/\//g, '\\').toLowerCase()) : null;
    return { bundle, entry: program ? await tree.read(program.path) : null, said };
}

/**
 * Steam's first launch option for Windows that names a program: how the app starts.
 *
 * @param {any} info  The app's product info.
 * @returns {{ executable: string, arguments?: string } | null}
 */
export function windowsLaunch(info){
    return /** @type {any} */ (Object.values(info?.config?.launch ?? {}).find(one=>one?.executable
        && (!one?.config?.oslist || String(one.config.oslist).split(',').includes('windows'))))
        ?? null;
}
