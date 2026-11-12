/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GOG's content system as its Galaxy client reads it, generation 2: a
 * product's builds (`content-system.gog.com/products/<id>/os/windows/builds`),
 * a build's manifest and each depot's on the CDN by the hash of their bytes
 * (`content-system/v2/meta/ab/cd/abcd…`), zlib-deflated JSON; a depot lists
 * its files, each a run of chunks named by the MD5 of their deflated bytes,
 * fetched from the endpoints a secure link gives. The redistributables a
 * build depends on (`dependencies`) come from a repository of their own,
 * public, with the program each one runs.
 *
 * What a build installs is chosen here as Galaxy would on a 64-bit Windows in
 * one language: the depots for that language or for every one (`*`), and for
 * that machine's bitness or none named.
 */

import { createMd5 } from '../layers/win32/crypto/digest.js';
import { installedFiles as depotFiles } from '../steam/install.js';

/** The CDN the manifests are read from: they are public and answer any origin. */
export const GOG_CDN = 'https://gog-cdn-fastly.gog.com';

/** A file Galaxy keeps out of the game's own tree (`support`): where it goes in the bottle. */
export const SUPPORT_DIRECTORY = '__support';

/**
 * Where a hash lies under a content-system root: `ab/cd/abcd…`.
 *
 * @param {string} hash
 */
export const galaxyPath = hash=>(hash.includes('/') ? hash
    : `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}`);

/** @param {Uint8Array} bytes */
const hex = bytes=>Array.from(bytes, byte=>byte.toString(16).padStart(2, '0')).join('');

/** @param {Uint8Array} bytes */
export function md5Hex(bytes){
    const digest = createMd5();
    digest.update(bytes);
    return hex(digest.digest());
}

/**
 * zlib's stream (RFC 1950) opened.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
export async function inflate(bytes){
    const part = /** @type {Uint8Array<ArrayBuffer>} */ (bytes);
    const stream = new Blob([part]).stream()
        .pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * A manifest's bytes as JSON: deflated, as the CDN keeps them, or plain.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<any>}
 */
export async function readMeta(bytes){
    // A deflated stream's first byte is 0x78; JSON's is `{`.
    const text = bytes[0] === 0x78 ? await inflate(bytes) : bytes;
    return JSON.parse(new TextDecoder().decode(text));
}

/**
 * @typedef {Object} Build  One of a product's builds, as the builds list gives it.
 * @property {string} build_id
 * @property {string | null} branch  Null for the one a person gets.
 * @property {number} generation
 * @property {string} link  Its manifest.
 * @property {string} [version_name]
 */

/**
 * The build Galaxy installs: the newest of the default branch (the list is
 * newest first), of the newest generation it has.
 *
 * @param {{ items?: Build[] }} builds
 * @returns {Build | null}
 */
export function pickBuild(builds){
    const items = builds?.items ?? [];
    return items.find(build=>build.branch === null && build.generation === 2)
        ?? items.find(build=>build.branch === null) ?? items[0] ?? null;
}

/**
 * @typedef {Object} BuildDepot
 * @property {string} productId
 * @property {string} manifest  Its hash.
 * @property {string[]} languages  `*` for every one.
 * @property {string[]} [osBitness]  Empty or absent: either.
 * @property {number} size
 */

/**
 * @typedef {Object} BuildManifest  Generation 2.
 * @property {string} baseProductId
 * @property {string} installDirectory
 * @property {BuildDepot[]} depots
 * @property {string[]} [dependencies]  Ids in the dependencies' repository.
 * @property {{ productId: string, name: string }[]} products
 */

/** @param {{ osBitness?: string[] }} depot @param {string} bitness */
const forBitness = (depot, bitness)=>!depot.osBitness?.length || depot.osBitness.includes(bitness);

/**
 * The languages a build is offered in, as its depots name them.
 *
 * @param {BuildManifest} build
 */
export function buildLanguages(build){
    return [...new Set(build.depots.flatMap(depot=>depot.languages))].filter(one=>one !== '*');
}

/**
 * The depots an install in one language takes: those for it or for every
 * language, for the machine's bitness. A language the build does not have
 * falls back to English, then to the first it has. One manifest listed under
 * several languages is taken once.
 *
 * @param {BuildManifest} build
 * @param {{ language?: string, bitness?: '32' | '64' }} [options]
 * @returns {{ language: string, depots: BuildDepot[] }}
 */
export function pickDepots(build, { language = 'en-US', bitness = '64' } = {}){
    const offered = buildLanguages(build);
    const chosen = offered.includes(language) ? language
        : offered.includes('en-US') ? 'en-US' : offered[0] ?? language;
    const seen = new Set();
    const depots = build.depots.filter(depot=>(depot.languages.includes('*')
        || depot.languages.includes(chosen)) && forBitness(depot, bitness)
        && !seen.has(depot.manifest) && seen.add(depot.manifest));
    return { language: chosen, depots };
}

/**
 * @typedef {Object} DependencyDepot  One entry of the dependencies' repository.
 * @property {string} dependencyId
 * @property {string} manifest
 * @property {{ path: string, arguments: string }} executable  Empty path: files alone.
 * @property {boolean} internal  Files the game runs from its own folder (ScummVM, DOSBox).
 * @property {string[]} [osBitness]
 * @property {number} size
 */

/**
 * The repository's depots a build names, for the machine's bitness.
 *
 * @param {{ depots: DependencyDepot[] }} repository
 * @param {string[]} ids  The build's `dependencies`.
 * @param {'32' | '64'} [bitness]
 */
export function dependencyDepots(repository, ids, bitness = '64'){
    return repository.depots.filter(depot=>ids.includes(depot.dependencyId)
        && forBitness(depot, bitness));
}

/**
 * @typedef {Object} DepotChunk
 * @property {string} md5  Of its bytes as they lie in the file.
 * @property {string} compressedMd5  Of what the CDN serves, which names it there.
 * @property {number} size @property {number} compressedSize
 */

/**
 * @typedef {Object} DepotItem
 * @property {'DepotFile' | 'DepotDirectory' | 'DepotLink'} type
 * @property {string} path  Backslashed.
 * @property {DepotChunk[]} [chunks] @property {string[]} [flags]
 * @property {string} [target]  A link's.
 */

/**
 * @typedef {DepotChunk & { offset: number }} PlacedChunk
 * @typedef {{ path: string, size: number, source: number, chunks: PlacedChunk[] }} GogFile
 *     `source`: which of the listed depots it came from, which says where its chunks are fetched.
 */

/**
 * Where an item of a depot goes in the bottle. A `support` file is Galaxy's
 * own -- settings it copies over the game's, scripts, icons -- kept by Galaxy
 * apart from the game: under `__support`, by its path, so nothing of the
 * game's own tree is overwritten by what its script interpreter would decide.
 *
 * @param {DepotItem} item
 */
export function itemPath(item){
    const path = item.path.replace(/\//g, '\\').replace(/^\\+/, '');
    return item.flags?.includes('support') ? `${SUPPORT_DIRECTORY}\\${path}` : path;
}

/**
 * The files an install of depots leaves, in the order a directory's are
 * packed -- a path a later depot ships too is the later one's, spelt as first
 * written (`steam/install.js`'s rule, which is Windows') -- each chunk with
 * where it lies in its file.
 *
 * @param {{ items: DepotItem[] }[]} depots  In the order they install.
 * @returns {{ files: GogFile[], directories: string[] }}
 */
export function installedFiles(depots){
    /** @type {Map<string, { source: number, chunks: PlacedChunk[] }>} */
    const byFile = new Map();
    const listed = depots.map(({ items }, source)=>({
        key: new Uint8Array(0),
        manifest: { depot: source, gid: 0n, created: 0, size: 0, files: items.map(item=>{
            const name = itemPath(item);
            if (item.type === 'DepotDirectory')
            {
                return { name, size: 0, flags: 0x40, sha: new Uint8Array(0), chunks: [] };
            }
            if (item.type === 'DepotLink')
            {
                return { name, size: 0, flags: 0, sha: new Uint8Array(0), chunks: [],
                    link: item.target ?? '' };
            }
            let offset = 0;
            const chunks = (item.chunks ?? []).map(chunk=>{
                const placed = { ...chunk, offset };
                offset += chunk.size;
                return placed;
            });
            byFile.set(`${source}\n${name.toLowerCase()}`, { source, chunks });
            return { name, size: offset, flags: 0, sha: new Uint8Array(0), chunks: [] };
        }) },
    }));
    const { files, directories } = depotFiles(/** @type {any} */ (listed));
    return {
        files: files.map(file=>{
            // The later depot's, by the path folded as both sides fold it.
            const own = /** @type {{ source: number, chunks: PlacedChunk[] }} */ (
                byFile.get(`${file.depot}\n${file.path.toLowerCase()}`));
            return { path: file.path, size: file.size, source: own.source, chunks: own.chunks };
        }),
        directories,
    };
}

/**
 * @typedef {Object} Endpoint  One of a secure or open link's `urls`.
 * @property {string} url_format  With `{name}` for each of `parameters`.
 * @property {Record<string, string | number>} parameters
 * @property {string} [endpoint_name] @property {number} [priority]
 */

/**
 * A chunk's address at an endpoint: its galaxy path after the endpoint's own
 * `path` parameter, or after its address where it has none.
 *
 * @param {Endpoint} endpoint
 * @param {string} hash  The chunk's `compressedMd5`.
 */
export function chunkUrl(endpoint, hash){
    const parameters = { ...endpoint.parameters };
    let format = endpoint.url_format;
    if (typeof parameters.path === 'string' && format.includes('{path}'))
    {
        parameters.path = `${parameters.path}/${galaxyPath(hash)}`;
    }
    else
    {
        format = `${format}/${galaxyPath(hash)}`;
    }
    return format.replace(/\{(\w+)\}/g, (whole, name)=>(Object.hasOwn(parameters, name)
        ? String(parameters[name]) : whole));
}

/**
 * The endpoints of a link in the order to try them: the highest priority first.
 *
 * @param {{ urls?: Endpoint[] }} link
 * @returns {Endpoint[]}
 */
export const endpointsOf = link=>[...link?.urls ?? []]
    .sort((a, b)=>(b.priority ?? 0) - (a.priority ?? 0));

/**
 * A chunk as the CDN served it, checked and opened: the MD5 of the deflated
 * bytes, then their length and MD5 once inflated.
 *
 * @param {Uint8Array} bytes
 * @param {DepotChunk} chunk
 */
export async function openChunk(bytes, chunk){
    if (bytes.length !== chunk.compressedSize || md5Hex(bytes) !== chunk.compressedMd5)
    {
        throw new Error(`gog: chunk ${chunk.compressedMd5} is not what its name says`);
    }
    const plain = await inflate(bytes);
    if (plain.length !== chunk.size || md5Hex(plain) !== chunk.md5)
    {
        throw new Error(`gog: chunk ${chunk.compressedMd5} opens to something else`);
    }
    return plain;
}

/**
 * The program a person starts, from the game's `goggame-<id>.info`: the
 * primary play task's path, arguments and working folder, backslashed.
 *
 * @param {Uint8Array} bytes
 * @returns {{ path: string, arguments: string, workingDir: string } | null}
 */
export function primaryTask(bytes){
    /** @type {any} */
    let info;
    try
    {
        info = JSON.parse(new TextDecoder().decode(bytes).replace(/^\uFEFF/, ''));
    }
    catch {
        return null;
    }
    const tasks = Array.isArray(info?.playTasks) ? info.playTasks : [];
    const task = tasks.find((/** @type {any} */ one)=>one?.isPrimary && one?.type !== 'URLTask')
        ?? tasks.find((/** @type {any} */ one)=>one?.type === 'FileTask');
    if (typeof task?.path !== 'string')
    {
        return null;
    }
    /** @param {unknown} value */
    const backslashed = value=>(typeof value === 'string' ? value.replace(/\//g, '\\') : '');
    return {
        path: backslashed(task.path),
        arguments: Array.isArray(task.arguments) ? task.arguments.join(' ')
            : typeof task.arguments === 'string' ? task.arguments : '',
        workingDir: backslashed(task.workingDir),
    };
}
