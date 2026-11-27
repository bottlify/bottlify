/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a bundle's block cache (`cache.js`) left on the origin's file system, read
 * without the engine and without opening anything for writing: what a page asks
 * before a start (how much of a bundle is here), and a bundle put together from
 * the cache alone. Kept apart from the cache, whose keeper a page reading this
 * has no use for.
 */

import { INDEX_FILES, packFile, readSaved } from '@bottlify/cellar';
import { Codec, HEADER_SIZE, openBundle, withManifest } from './format.js';

/** The directory of the origin's file system every bundle's blocks are kept under. */
export const BLOCK_DIRECTORY = 'blocks';

/**
 * The name a bundle's blocks are kept under: its id and the fingerprint of its
 * index, so a bundle packed again starts a cache of its own.
 *
 * @param {string} id  @param {string} fingerprint
 */
export const blockCacheName = (id, fingerprint)=>`${id}-${fingerprint}`;

/**
 * A bare file name: the origin's file system refuses a name with a separator
 * in it, and a bundle's id is not ours to vet.
 *
 * @param {string} name
 */
export const fileNameOf = name=>name.replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * A file or folder the origin does not have is a miss; any other refusal (a
 * security error, a lock, a broken file system) is not, and goes to the caller.
 *
 * @param {any} error @returns {null}
 */
const notFound = error=>{
    if (error?.name === 'NotFoundError')
    {
        return null;
    }
    throw error;
};

/**
 * The bodies a keeper's disk holds as its last saved index names them, read
 * without opening anything for writing (a page asking, the engine elsewhere):
 * each body's pack and place, by name, those past their pack's end left out.
 * Null where the bundle has no directory or no index; an error of the origin's
 * other than a file not found rejects.
 *
 * Cellar reads its index (`readSaved`); `cache.test.js` saves one with
 * Cellar's own keeper and reads it back here.
 *
 * @param {any} root  the origin's file system
 * @param {string} name  the cache's (`blockCacheName`)
 * @returns {Promise<{ bodies: Map<string, { pack: number, offset: number, length: number }>,
 *     slice: (body: { pack: number, offset: number, length: number }) => Blob } | null>}
 */
export async function savedBlocks(root, name){
    /** @param {any} directory @param {string} file @returns {Promise<Blob | null>} */
    const fileOf = (directory, file)=>directory.getFileHandle(file)
        .then((/** @type {any} */ handle)=>handle.getFile()).catch(notFound);
    const directory = await root.getDirectoryHandle(BLOCK_DIRECTORY)
        .then((/** @type {any} */ blocks)=>blocks.getDirectoryHandle(fileNameOf(name)))
        .catch(notFound);
    if (directory === null)
    {
        return null;
    }
    /** @type {(Uint8Array | null)[]} */
    const files = [];
    for (const file of INDEX_FILES)
    {
        const blob = await fileOf(directory, file);
        files.push(blob === null ? null : new Uint8Array(await blob.arrayBuffer()));
    }
    const saved = readSaved(files);
    if (saved === null)
    {
        return null;
    }
    /** @type {Map<number, Blob | null>} */
    const packs = new Map();
    for (const number of saved.packs)
    {
        packs.set(number, await fileOf(directory, packFile(number)));
    }
    /** @type {Map<string, { pack: number, offset: number, length: number }>} */
    const bodies = new Map();
    for (const [body, place] of saved.bodies)
    {
        // The index is true of the disk as of its save: a pack cut since is
        // no body.
        const blob = packs.get(place.pack);
        if (blob && place.length > 0 && place.offset + place.length <= blob.size)
        {
            bodies.set(body, place);
        }
    }
    return { bodies, slice: ({ pack, offset, length })=>/** @type {Blob} */ (packs.get(pack))
        .slice(offset, offset + length) };
}

/** Whether block `index` is a block of the translation seed, the translator's store's. */
const inSeed = (/** @type {any} */ bundle, /** @type {number} */ index)=>{
    const seed = bundle.translations;
    return Boolean(seed) && index >= seed.firstBlock && index < seed.firstBlock + seed.blocks;
};

/**
 * How much of a bundle this machine already holds, read from the cache's
 * index without opening it for writing: what a page asks before a start, to
 * say whether the game is here whole. The blocks of the translation seed are
 * not counted, being the translator's store's and read once.
 *
 * @param {Object} options
 * @param {any} options.root  The origin's file system (`navigator.storage.getDirectory()`).
 * @param {string} options.id  The bundle's id, as the engine is given it.
 * @param {{ fingerprint: string, blockCount: number,
 *     block: (index: number) => { packed: number, codec: number, length: number },
 *     translations: { firstBlock: number, blocks: number } | null }} options.bundle  Opened.
 * @returns {Promise<{ blocks: number, resident: number, bytes: number, residentBytes: number }>}
 */
export async function bundleResidency({ root, id, bundle }){
    const saved = await savedBlocks(root, blockCacheName(id, bundle.fingerprint));
    const out = { blocks: 0, resident: 0, bytes: 0, residentBytes: 0 };
    for (let index = 0; index < bundle.blockCount; index++)
    {
        if (inSeed(bundle, index))
        {
            continue;
        }
        const { packed, length } = bundle.block(index);
        out.blocks++;
        out.bytes += packed;
        if (saved?.bodies.get(String(index))?.length === length)
        {
            out.resident++;
            out.residentBytes += packed;
        }
    }
    return out;
}

/**
 * A bundle as this machine holds it, put together as a container of its own
 * from the block cache alone: a game played or downloaded here is saved
 * without its bytes fetched again. Only the index is read from the container,
 * and with it the description to write in. Every block comes out stored, as
 * the cache keeps it decoded, and without its checksum, which was of the
 * packed bytes; the translation seed is left out, being the translator's
 * store's and not the cache's, and the next start translates afresh.
 *
 * @param {Object} options
 * @param {any} options.root  The origin's file system (`navigator.storage.getDirectory()`).
 * @param {string} options.id  The bundle's id, as the engine is given it.
 * @param {import('./format.js').FetchRange} options.fetchRange  The container.
 * @param {import('./format.js').IndexDecode} options.decode
 * @param {Record<string, unknown> | null} options.manifest
 * @returns {Promise<Blob | null>}  A Blob of slices of the cache, copied only as it is
 *     read; null when the cache does not hold every block.
 */
export async function cachedBundle({ root, id, fetchRange, decode, manifest }){
    /** @type {Map<string, Promise<Uint8Array>>} */
    const fetched = new Map();
    /** @type {import('./format.js').FetchRange} */
    const once = (offset, length)=>{
        const key = `${offset}+${length}`;
        if (!fetched.has(key))
        {
            fetched.set(key, fetchRange(offset, length));
        }
        return /** @type {Promise<Uint8Array>} */ (fetched.get(key));
    };
    const bundle = await openBundle(once, decode);
    const saved = await savedBlocks(root, blockCacheName(id, bundle.fingerprint));
    if (saved === null)
    {
        return null;
    }
    /** @type {Blob[]} */
    const parts = [];
    let whole = true;
    const { header, index } = await withManifest(once, decode, manifest, stored=>{
        let offset = HEADER_SIZE;
        stored.blocks = stored.blocks.map((/** @type {any} */ record, /** @type {number} */ at)=>{
            if (inSeed(bundle, at))
            {
                return { offset, packed: 0, codec: Codec.STORED };
            }
            const { length } = bundle.block(at);
            const body = saved.bodies.get(String(at));
            // A body of another length is not this block as a read hands it out.
            whole &&= body?.length === length;
            parts.push(body?.length === length ? saved.slice(body) : new Blob([]));
            const laid = { ...record, offset, packed: length, codec: Codec.STORED };
            delete laid.crc;
            offset += length;
            return laid;
        });
        delete stored.translations;
        return offset;
    });
    return whole ? new Blob(/** @type {BlobPart[]} */ ([header, ...parts, index])) : null;
}
