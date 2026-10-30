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

/**
 * A bundle's block cache's files, by the name the cache gives them -- its data
 * in one `.blocks` file or in segments after it (`.blocks.<k>`), and the table
 * a reverted appended layout left beside some (`cache.js`), which goes with them.
 */
const BLOCK_FILE = /^(.+)\.(blocks(?:\.[0-9A-Za-z]+)?|present|order|slots)$/;

/** A session's folder and its earlier one-file form (`opfsSession`). */
const SESSION_ENTRY = /^(.+)\.(files|session)$/;

/** The fingerprint `blockCacheName` puts after a bundle's id: the index's CRC-32 in hex. */
const FINGERPRINT = /-[0-9a-f]{8}$/;

/** A translations' directory's layout version (`createDirectoryTranslationStore`). */
const LAYOUT = /\.v\d+$/;

/** The lock a running bundle's translations hold, by its name (`resolveTranslationStore`). */
const STORE_LOCK = 'bottlify-cork:';

/**
 * The name the origin's file system knows a bottle by: its id with anything a
 * file name may not hold made safe, as every store here names its files.
 *
 * @param {string} id
 */
export const storageName = id=>id.replace(/[^A-Za-z0-9._-]/g, '_');

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
 * A file's facts, or a directory's: every file under it added up, by its newest.
 *
 * @param {any} handle
 * @returns {Promise<{ size: number, modified: number }>}
 */
async function entryFacts(handle){
    if (typeof handle?.getFile === 'function')
    {
        return fileFacts(handle);
    }
    const total = { size: 0, modified: 0 };
    if (typeof handle?.entries === 'function')
    {
        for await (const [, child] of handle.entries())
        {
            const facts = await entryFacts(child);
            total.size += facts.size;
            total.modified = Math.max(total.modified, facts.modified);
        }
    }
    return total;
}

/**
 * @typedef {'blocks' | 'translations' | 'saves'} StoredKind
 * @typedef {{ kind: StoredKind, name: string, bottle: string, bytes: number,
 *     modified: number, remove: () => Promise<void> }} Stored
 *     One thing the origin holds of a bottle: `name` the cache's or session's
 *     own, `bottle` the bottle's (`storageName`).
 */

/**
 * Everything the engine keeps on the origin's file system, one record a
 * cache or session: a bundle's block cache (one per packing of it), its
 * translations (one directory per layout version) and its session.
 *
 * @param {any} root
 * @returns {Promise<Stored[]>}
 */
async function scanStorage(root){
    /** @type {Map<string, { bytes: number, modified: number, files: string[] }>} */
    const caches = new Map();
    /** @type {Stored[]} */
    const out = [];
    /** @type {any} */
    let cork = null;
    for await (const [name, handle] of root.entries())
    {
        if (name === 'cork' && typeof handle?.entries === 'function')
        {
            cork = handle;
            continue;
        }
        const session = SESSION_ENTRY.exec(name);
        if (session !== null)
        {
            const facts = await entryFacts(handle);
            const bottle = /** @type {string} */ (session[1]);
            out.push({ kind: 'saves', name, bottle, bytes: facts.size, modified: facts.modified,
                remove: ()=>root.removeEntry(name, { recursive: true }) });
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
    for (const [base, { bytes, modified, files }] of caches)
    {
        out.push({ kind: 'blocks', name: base, bottle: base.replace(FINGERPRINT, ''), bytes,
            modified, remove: async()=>{
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
            if (typeof handle?.entries !== 'function')
            {
                continue;
            }
            const facts = await entryFacts(handle);
            out.push({ kind: 'translations', name, bottle: name.replace(LAYOUT, ''),
                bytes: facts.size, modified: facts.modified,
                remove: ()=>cork.removeEntry(name, { recursive: true }) });
        }
    }
    return out;
}

/**
 * The caches on the origin's storage another run could let go: every bundle's
 * block cache and translations but the ones named in `keep` or in `busy`.
 *
 * @param {any} root
 * @param {{ blocks?: string, translations?: string }} keep
 * @param {string[]} busy  the bundles (by safe name) a run holds now
 * @returns {Promise<Stored[]>}
 */
async function evictables(root, keep, busy){
    /** @param {string} name  a cache's, whose bundle a run may hold */
    const held = name=>busy.some(bundle=>name === bundle || name.startsWith(`${bundle}-`)
        || name.startsWith(`${bundle}.v`));
    return (await scanStorage(root)).filter(one=>!held(one.name)
        && (one.kind === 'blocks' ? one.name !== keep.blocks
            : one.kind === 'translations' && !(keep.translations !== undefined
                && one.name.startsWith(`${keep.translations}.v`))));
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
        const kept = {
            blocks: keep.blocks === undefined ? undefined : storageName(keep.blocks),
            translations: keep.translations === undefined ? undefined
                : storageName(keep.translations),
        };
        // The asking run holds its own bundle's lock: what it keeps is named in
        // `keep`, and its bundle's caches of an earlier packing may go.
        const bundles = busy.filter(name=>name.startsWith(STORE_LOCK))
            .map(name=>storageName(name.slice(STORE_LOCK.length)))
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

/**
 * @typedef {{ bottle: string, busy: boolean, blocks: number, translations: number,
 *     saves: number }} BottleStorage
 *     What the origin holds of one bottle, in bytes, by kind; `busy` while a
 *     run of it holds its translations' lock, in this tab or another.
 */

/** The browser's storage and locks, or a test's of the same shape. @param {any} options */
const browserOf = options=>{
    const nav = /** @type {any} */ (globalThis).navigator;
    return { storage: options.storage ?? nav?.storage, locks: options.locks ?? nav?.locks };
};

/**
 * Every bottle the origin holds anything of, whether a library lists it or
 * not, with the origin's usage and quota and whether the browser keeps its
 * storage rather than clearing it when the disk runs low. What the engine
 * does not keep -- a launcher's own folders -- is the launcher's to add.
 *
 * @param {{ storage?: any, locks?: any }} [options]  the browser's by default
 * @returns {Promise<{ usage: number | null, quota: number | null, persisted: boolean | null,
 *     bottles: BottleStorage[] }>}  null: the browser did not say
 */
export async function bottleStorage(options = {}){
    const { storage, locks } = browserOf(options);
    if (typeof storage?.getDirectory !== 'function')
    {
        throw new Error('no origin file system here');
    }
    const estimate = await storage.estimate?.().catch(()=>null) ?? null;
    const persisted = await storage.persisted?.().catch(()=>null) ?? null;
    const held = typeof locks?.query === 'function' ? await locks.query().catch(()=>null) : null;
    /** @type {string[]} */
    const names = (held?.held ?? []).map((/** @type {any} */ lock)=>String(lock.name));
    const busy = new Set(names
        .filter(name=>name.startsWith(STORE_LOCK))
        .map(name=>storageName(name.slice(STORE_LOCK.length))));
    /** @type {Map<string, BottleStorage>} */
    const bottles = new Map();
    for (const one of await scanStorage(await storage.getDirectory()))
    {
        const entry = bottles.get(one.bottle) ?? { bottle: one.bottle, busy: busy.has(one.bottle),
            blocks: 0, translations: 0, saves: 0 };
        entry[one.kind] += one.bytes;
        bottles.set(one.bottle, entry);
    }
    return {
        usage: typeof estimate?.usage === 'number' ? estimate.usage : null,
        quota: typeof estimate?.quota === 'number' ? estimate.quota : null,
        persisted: typeof persisted === 'boolean' ? persisted : null,
        bottles: [...bottles.values()],
    };
}

/**
 * Removes what the origin holds of a bottle, of the kinds named: `blocks` and
 * `translations` are caches the next start makes again, `saves` is what the
 * program wrote and is gone for good. Holds the bottle's translations' lock
 * while it does, so a running bottle is refused with an error rather than
 * having its files taken from under it.
 *
 * @param {string} id  the bottle's, or the name `bottleStorage` lists it by
 * @param {StoredKind[]} kinds
 * @param {{ storage?: any, locks?: any }} [options]  the browser's by default
 * @returns {Promise<{ kind: StoredKind, name: string, bytes: number }[]>}  what went
 */
export async function clearBottleStorage(id, kinds, options = {}){
    const { storage, locks } = browserOf(options);
    if (typeof storage?.getDirectory !== 'function')
    {
        throw new Error('no origin file system here');
    }
    const sweep = async()=>{
        const bottle = storageName(id);
        const mine = (await scanStorage(await storage.getDirectory()))
            .filter(one=>one.bottle === bottle && kinds.includes(one.kind));
        for (const one of mine)
        {
            await one.remove();
        }
        return mine.map(({ kind, name, bytes })=>({ kind, name, bytes }));
    };
    if (typeof locks?.request !== 'function')
    {
        return sweep();
    }
    // The lock is named by the id a run was given; an orphan listed only by its
    // safe name matches it whenever the id had nothing to make safe.
    return locks.request(`${STORE_LOCK}${id}`, { ifAvailable: true }, (/** @type {any} */ lock)=>{
        if (!lock)
        {
            throw new Error('it is in use by a running title');
        }
        return sweep();
    });
}
