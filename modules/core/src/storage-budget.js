/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The origin's storage kept under a budget: what the browser allows the site
 * (`navigator.storage.estimate()`, its quota, which each browser sets by the
 * system it runs on and the disk it has), less a share left for the run that
 * starts to write into. Past it, the caches go, the least recently written
 * first: a bundle's fetched blocks (`<name>.blocks`, `.present`, `.order` at
 * the root) and a bundle's translations (`cork/<name>.v<n>`). Both are made
 * again by the next run that needs them; a session -- the files a program
 * wrote, its saved games -- is never touched. Neither are the caches of the
 * run asking, nor those of a bundle a run in another tab holds the lock of.
 */

/** The quota's share the site keeps itself to: room for what the run writes next. */
export const STORAGE_SHARE = 0.8;

/** A bundle's block cache's files, by the name the cache gives them. */
const BLOCK_FILE = /^(.+)\.(blocks|present|order)$/;

/** The lock a running bundle's translations hold, by its name (`resolveTranslationStore`). */
const STORE_LOCK = 'bottlify-cork:';

/** @param {string} name */
const safe = name=>name.replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * A file's size and when it was last written, or nothing where it cannot say.
 *
 * @param {any} handle
 * @returns {Promise<{ size: number, modified: number }>}
 */
async function fileFacts(handle){
    try
    {
        const file = await handle.getFile();
        return { size: file.size ?? 0, modified: file.lastModified ?? 0 };
    }
    catch {
        return { size: 0, modified: 0 };
    }
}

/**
 * @typedef {{ kind: 'blocks' | 'translations', name: string, bytes: number,
 *     modified: number, remove: () => Promise<void> }} Evictable
 */

/**
 * The caches on the origin's storage another run could let go: every bundle's
 * block cache and translations but the ones named in `keep` or in `busy`.
 *
 * @param {any} root
 * @param {{ blocks?: string, translations?: string }} keep
 * @param {string[]} busy  the bundles (by safe name) a run holds now
 * @returns {Promise<Evictable[]>}
 */
async function evictables(root, keep, busy){
    /** @type {Map<string, { bytes: number, modified: number, files: string[] }>} */
    const caches = new Map();
    /** @type {any} */
    let cork = null;
    for await (const [name, handle] of root.entries())
    {
        if (name === 'cork' && typeof handle?.entries === 'function')
        {
            cork = handle;
            continue;
        }
        const found = BLOCK_FILE.exec(name);
        if (found === null || typeof handle?.getFile !== 'function')
        {
            continue;
        }
        const base = /** @type {string} */ (found[1]);
        const facts = await fileFacts(handle);
        const one = caches.get(base) ?? { bytes: 0, modified: 0, files: [] };
        one.bytes += facts.size;
        one.modified = Math.max(one.modified, facts.modified);
        one.files.push(name);
        caches.set(base, one);
    }
    /** @param {string} name  a cache's, whose bundle a run may hold */
    const held = name=>busy.some(bundle=>name === bundle || name.startsWith(`${bundle}-`)
        || name.startsWith(`${bundle}.v`));
    /** @type {Evictable[]} */
    const out = [];
    for (const [base, { bytes, modified, files }] of caches)
    {
        if (base === keep.blocks || held(base))
        {
            continue;
        }
        out.push({ kind: 'blocks', name: base, bytes, modified, remove: async()=>{
            for (const file of files)
            {
                await root.removeEntry(file);
            }
        } });
    }
    if (cork !== null)
    {
        for await (const [name, handle] of cork.entries())
        {
            if (typeof handle?.entries !== 'function' || held(name)
                || (keep.translations !== undefined && name.startsWith(`${keep.translations}.v`)))
            {
                continue;
            }
            let bytes = 0;
            let modified = 0;
            for await (const [, file] of handle.entries())
            {
                if (typeof file?.getFile === 'function')
                {
                    const facts = await fileFacts(file);
                    bytes += facts.size;
                    modified = Math.max(modified, facts.modified);
                }
            }
            out.push({ kind: 'translations', name, bytes, modified,
                remove: ()=>cork.removeEntry(name, { recursive: true }) });
        }
    }
    return out;
}

/**
 * Lets the oldest caches go until what the origin holds is under its budget.
 *
 * @param {Object} options
 * @param {any} options.root  the origin's file system (`navigator.storage.getDirectory()`)
 * @param {{ usage?: number, quota?: number }} options.estimate  the browser's
 *     (`navigator.storage.estimate()`)
 * @param {{ blocks?: string, translations?: string }} [options.keep]  the asking run's
 *     own: its block cache's name (`blockCacheName`) and its bundle's, as its
 *     translations are named
 * @param {string[]} [options.busy]  the names of the locks held now
 *     (`navigator.locks.query()`): a bundle whose translations a run holds keeps
 *     its caches
 * @param {number} [options.share]  of the quota, the budget (`STORAGE_SHARE`)
 * @returns {Promise<{ measured: false, reason: string } | { measured: true,
 *     budget: number, usage: number, freed: number,
 *     evicted: { kind: string, name: string, bytes: number }[], over: boolean }>}
 *     `over`: still past the budget once nothing else could go
 */
export async function keepStorageWithin({ root, estimate, keep = {}, busy = [],
    share = STORAGE_SHARE })
{
    const { usage, quota } = estimate ?? {};
    if (typeof usage !== 'number' || typeof quota !== 'number' || quota <= 0)
    {
        return { measured: false, reason: 'the browser gave no usage and quota' };
    }
    const budget = Math.floor(quota * share);
    /** @type {{ kind: string, name: string, bytes: number }[]} */
    const evicted = [];
    let freed = 0;
    if (usage > budget && typeof root?.entries === 'function'
        && typeof root.removeEntry === 'function')
    {
        const kept = { blocks: keep.blocks === undefined ? undefined : safe(keep.blocks),
            translations: keep.translations === undefined ? undefined : safe(keep.translations) };
        // The asking run holds its own bundle's lock: what it keeps is named in
        // `keep`, and its bundle's caches of an earlier packing may go.
        const bundles = busy.filter(name=>name.startsWith(STORE_LOCK))
            .map(name=>safe(name.slice(STORE_LOCK.length)))
            .filter(bundle=>bundle !== kept.translations);
        const candidates = (await evictables(root, kept, bundles))
            .sort((a, b)=>a.modified - b.modified);
        for (const one of candidates)
        {
            if (usage - freed <= budget)
            {
                break;
            }
            try
            {
                await one.remove();
            }
            catch {
                // A file a run in another tab still holds open: it stays.
                continue;
            }
            freed += one.bytes;
            evicted.push({ kind: one.kind, name: one.name, bytes: one.bytes });
        }
    }
    return { measured: true, budget, usage, freed, evicted, over: usage - freed > budget };
}

/**
 * The same, on the origin's own storage, asked of the browser: nothing where
 * the page has no file system of its own.
 *
 * @param {{ blocks?: string, translations?: string }} keep
 */
export async function keepOriginStorageWithin(keep){
    const nav = /** @type {any} */ (globalThis).navigator;
    if (typeof nav?.storage?.estimate !== 'function'
        || typeof nav?.storage?.getDirectory !== 'function')
    {
        return { measured: false, reason: 'no storage estimate or origin file system here' };
    }
    const held = typeof nav.locks?.query === 'function'
        ? await nav.locks.query().catch(()=>null) : null;
    /** @type {string[]} */
    const busy = (held?.held ?? []).map((/** @type {any} */ lock)=>String(lock.name));
    return keepStorageWithin({ root: await nav.storage.getDirectory(),
        estimate: await nav.storage.estimate(), keep, busy });
}
