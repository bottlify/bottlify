/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A GOG build installed into a bundle written in place (bundle-in-place.js):
 * the depots its language and the machine take and the dependencies it names
 * (content.js), every chunk from the CDN to where its file lies, the
 * redistributables among the dependencies applied as Windows would have run
 * them (`steam/redist.js`), and the program its primary play task starts.
 *
 * What it is given is what an account's session alone can ask -- the build's
 * manifest and a secure link to each product's chunks (GameHub's `download`)
 * -- and what anyone may read, the manifests on the CDN, it reads itself.
 */

import { fillInPlace, finishBundle, treeInPlace } from '../bundle-in-place.js';
import {
    GOG_CDN, chunkUrl, dependencyDepots, endpointsOf, galaxyPath, installedFiles, md5Hex,
    openChunk, pickDepots, primaryTask, readMeta,
} from './content.js';
import { imageMachine, installRedistributables } from '../steam/redist.js';

/** @typedef {import('./content.js').BuildManifest} BuildManifest */
/** @typedef {import('./content.js').Endpoint} Endpoint */
/** @typedef {import('./content.js').GogFile} GogFile */
/** @typedef {import('./content.js').PlacedChunk} PlacedChunk */
/** @typedef {import('../bundle-in-place.js').RandomAccess} RandomAccess */
/** @typedef {import('../bundle-in-place.js').FillProgress} InstallProgress */

/**
 * @typedef {Object} InstallPlan  What GameHub's `download` answers for a GOG game.
 * @property {BuildManifest} build  The build's manifest, as read.
 * @property {Record<string, { urls: Endpoint[] }>} links  A secure link by product id.
 * @property {{ manifest: string, link: { urls: Endpoint[] } }} [dependencies]  The
 *     repository's manifest and the open link to its chunks.
 */

/**
 * @param {(url: string) => Promise<Response>} get @param {string} url
 * @returns {Promise<Uint8Array>}
 */
async function bytesOf(get, url){
    const answer = await get(url);
    if (!answer.ok)
    {
        throw new Error(`gog: ${url} answered ${answer.status}`);
    }
    return new Uint8Array(await answer.arrayBuffer());
}

/**
 * A chunk fetched from an endpoint and opened, as `installGogBundle` does it
 * by default: a page hands the same to workers.
 *
 * @param {string} url @param {import('./content.js').DepotChunk} chunk
 * @param {(url: string) => Promise<Response>} [get]
 */
export const downloadChunk = async(url, chunk, get = fetch)=>
    openChunk(await bytesOf(get, url), chunk);

/**
 * Installs a GOG build into a bundle in place. A run stopped part way goes on
 * from what it saved; another build, language or set of depots starts it over.
 *
 * @param {Object} options
 * @param {RandomAccess} options.handle
 * @param {InstallPlan} options.plan
 * @param {string} [options.language]  As GOG names one: `en-US`, `de-DE`.
 * @param {(url: string, chunk: PlacedChunk) => Promise<Uint8Array>} [options.decode]
 *     A chunk's opened bytes from its address.
 * @param {(url: string) => Promise<Response>} [options.fetch]  How a manifest is read.
 * @param {InstallProgress | null} [options.resume]
 * @param {(progress: InstallProgress) => unknown} [options.onSave]
 * @param {number} [options.jobs]
 * @param {AbortSignal} [options.signal]
 * @param {(progress: { stage: 'downloading' | 'finishing', done: number, total: number })
 *     => void} [options.onProgress]  Bytes.
 * @returns {Promise<{ bundle: Awaited<ReturnType<typeof finishBundle>>, entry: Uint8Array | null,
 *     executable: string | null, arguments: string, workingDir: string, language: string,
 *     said: string[] }>}
 */
export async function installGogBundle({ handle, plan, language, decode, fetch: get = fetch,
    resume = null, onSave, jobs, signal, onProgress })
{
    const { build } = plan;
    const picked = pickDepots(build, { language });
    /** @type {string[]} */
    const said = [];
    /** @type {{ manifest: string, meta: string, endpoints: Endpoint[] }[]} */
    const sources = [];
    const ids = build.dependencies ?? [];
    /** @type {import('./content.js').DependencyDepot[]} */
    let dependencies = [];
    if (ids.length > 0)
    {
        if (!plan.dependencies)
        {
            throw new Error(`gog: the build needs ${ids.join(', ')} and no repository was given`);
        }
        const repository = await readMeta(await bytesOf(get, plan.dependencies.manifest));
        dependencies = dependencyDepots(repository, ids);
        const missing = ids.filter(id=>!repository.depots.some((/** @type {any} */ depot)=>
            depot.dependencyId === id));
        if (missing.length > 0)
        {
            said.push(`dependencies not in GOG's repository: ${missing.join(', ')}`);
        }
        const endpoints = endpointsOf(plan.dependencies.link);
        // First: a game's own file of the same path is the game's.
        sources.push(...dependencies.map(depot=>({ manifest: depot.manifest, endpoints,
            meta: `${GOG_CDN}/content-system/v2/dependencies/meta/${galaxyPath(depot.manifest)}` })));
    }
    for (const depot of picked.depots)
    {
        const endpoints = endpointsOf(plan.links[depot.productId]);
        if (endpoints.length === 0)
        {
            throw new Error(`gog: no link to product ${depot.productId}'s files`);
        }
        sources.push({ manifest: depot.manifest, endpoints,
            meta: `${GOG_CDN}/content-system/v2/meta/${galaxyPath(depot.manifest)}` });
    }

    const listed = [];
    for (const source of sources)
    {
        signal?.throwIfAborted();
        listed.push({ items: (await readMeta(await bytesOf(get, source.meta))).depot.items });
    }
    const { files, directories } = installedFiles(listed);
    const open = decode ?? ((url, chunk)=>downloadChunk(url, chunk, get));
    const widest = Math.max(1, ...sources.map(source=>source.endpoints.length));
    const { placed, rewritten } = await fillInPlace({ handle, files,
        // The n-th try of a chunk goes to the n-th endpoint of its own product's.
        sources: Array.from({ length: widest }, (_, at)=>at),
        fetchChunk: (at, file, chunk)=>{
            const { endpoints } = sources[file.source];
            return open(chunkUrl(endpoints[at % endpoints.length], chunk.compressedMd5), chunk);
        },
        intact: (bytes, chunk)=>md5Hex(bytes) === chunk.md5, store: 'gog',
        stamp: JSON.stringify(sources.map(source=>source.manifest)),
        resume, onSave, jobs, signal, onProgress });
    said.push(...rewritten);

    const { tree, settle, find } = treeInPlace(handle, placed, 'gog');
    const info = find(`goggame-${build.baseProductId}.info`);
    const task = info ? primaryTask(await tree.read(info)) : null;
    if (!task)
    {
        said.push(`goggame-${build.baseProductId}.info names no program to start`);
    }
    const executable = find(task?.path);
    const machine = executable ? imageMachine((await tree.read(executable)).subarray(0, 4096))
        : 'x86';
    const programs = dependencies.map(depot=>depot.executable?.path).filter(Boolean);
    said.push(...await installRedistributables(tree, [], machine, programs));
    if (find(`goggame-${build.baseProductId}.script`))
    {
        said.push(`goggame-${build.baseProductId}.script: Galaxy's install script is not run`);
    }
    const bundled = settle();
    // Every chunk's bytes were checked against GOG's MD5s as they landed and
    // again where a run was taken up: no SHA-256 of each besides.
    const bundle = await finishBundle(handle, bundled, directories, { hashFiles: false,
        onProgress: (read, all)=>onProgress?.({ stage: 'finishing', done: read, total: all }) });
    return {
        bundle,
        entry: executable ? await tree.read(executable) : null,
        executable,
        arguments: task?.arguments ?? '',
        workingDir: task?.workingDir ?? '',
        language: picked.language,
        said,
    };
}
