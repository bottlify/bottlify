/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A Steam app's depots installed: their manifests, the files they leave -- a
 * path two depots ship is the later one's --, every chunk downloaded from the
 * content servers, and the redistributables applied (`redist.js`). The
 * launcher's bottlify-ui/gamehub/tools/steam-install.mjs installs into a directory this way, and a
 * page into a bottle it writes in place (`installBundle`): one install, two
 * places it lands.
 */

import { FILE_FLAG_DIRECTORY, adler32, downloadChunk, manifest } from './depot.js';
import { comparePaths, downloadChunks, fillInPlace, finishBundle, treeInPlace, wrongChunksOf }
    from '../bundle-in-place.js';

export { comparePaths };
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
 * @param {import('./depot.js').Get} [get]  How a server is asked.
 * @returns {Promise<Manifest>}
 */
export async function depotManifest(servers, opening, get){
    /** @type {unknown} */
    let last = new Error('steam: no content server to ask');
    for (const server of servers.slice(0, 4))
    {
        try
        {
            return await manifest(server, opening, get);
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
 * server that gives it (`downloadChunks`), and hands each to `write`.
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
export async function downloadFiles({ files, servers, write, done, decode = downloadChunk, jobs,
    signal, onChunk })
{
    if (servers.length === 0)
    {
        throw new Error('steam: no content server offered');
    }
    await downloadChunks({ files, sources: servers, write, done, jobs, signal, onChunk,
        fetchChunk: (server, file, chunk)=>decode(server, file.depot, chunk, file.key) });
}

/**
 * What a run of `installBundle` that stopped part way has done: the depots at
 * their manifests it was installing (`stamp`), and a bit a chunk in place.
 *
 * @typedef {import('../bundle-in-place.js').FillProgress} InstallProgress
 */

/** Whether a chunk's bytes are what the manifest says: its length and Adler-32. */
const adlerIntact = (/** @type {Uint8Array} */ bytes, /** @type {ManifestChunk} */ chunk)=>
    bytes.length === chunk.size && adler32(bytes) === chunk.crc;

/**
 * The chunks whose bytes in place are not what the manifest says (length and
 * Adler-32), by task number as `downloadFiles` counts them, and their files.
 *
 * @param {InstalledFile[]} files @param {Map<string, number>} at
 * @param {RandomAccess} handle
 * @param {(task: number) => boolean} [which]  The chunks to read back; every one by default.
 */
export const wrongChunks = (files, at, handle, which)=>
    wrongChunksOf(files, at, handle, adlerIntact, which);

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
 * @param {import('./depot.js').Get} [options.fetch]  How a server is asked for a manifest.
 * @param {number} [options.jobs]
 * @param {AbortSignal} [options.signal]
 * @param {(progress: { stage: 'downloading' | 'finishing', done: number, total: number })
 *     => void} [options.onProgress]  Bytes.
 * @returns {Promise<{ bundle: Awaited<ReturnType<typeof finishBundle>>,
 *     entry: Uint8Array | null, said: string[] }>}
 */
export async function installBundle({ handle, depots, servers, installscript, executable,
    resume = null, onSave, decode = downloadChunk, fetch: get, jobs, signal, onProgress })
{
    const listed = [];
    for (const opening of depots)
    {
        signal?.throwIfAborted();
        listed.push({ opening, manifest: await depotManifest(servers, opening, get) });
    }
    const { files, directories } = installedFiles(
        listed.map(({ opening, manifest: one })=>({ manifest: one, key: opening.key })));
    if (servers.length === 0)
    {
        throw new Error('steam: no content server offered');
    }
    const { placed, rewritten } = await fillInPlace({ handle, files, sources: servers,
        fetchChunk: (server, file, chunk)=>decode(server, file.depot, chunk, file.key),
        intact: adlerIntact, store: 'steam',
        stamp: JSON.stringify(depots.map(({ depot, gid })=>[depot, String(gid)])),
        resume, onSave, jobs, signal, onProgress });

    // The redistributables, over the files in place; what they write goes after them.
    const { tree, settle, find } = treeInPlace(handle, placed, 'steam');
    const said = await installSteamRedistributables(tree, { installscript, executable,
        shared: listed.filter(({ opening })=>opening.shared)
            .flatMap(({ manifest: one })=>one.files.map(file=>file.name)) });
    const bundled = settle();
    // Every file's bytes were checked against Steam's own sums as they landed
    // and again where a run was taken up: no SHA-256 of each besides.
    const bundle = await finishBundle(handle, bundled, directories, { hashFiles: false,
        onProgress: (read, all)=>onProgress?.({ stage: 'finishing', done: read, total: all }) });
    const program = find(executable);
    return { bundle, entry: program ? await tree.read(program) : null,
        said: [...rewritten, ...said] };
}
