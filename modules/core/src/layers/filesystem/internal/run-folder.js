/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A run's own folder in the origin's private file system: where it keeps
 * what it lets go of from memory and no later run reads - its page file
 * (`page-file.js`), the bodies of its cache that are the only copy for the
 * run (`process/run-cache.js`). One folder, one lock and one sweep for all
 * of them, so a run that ended without closing (a tab that was killed)
 * leaves nothing behind past the next run's start.
 *
 * The folder goes once every part that used it has let go of it. A folder
 * another run holds is never taken: its lock says so where the browser has
 * locks, and otherwise its open handles refuse the removal.
 */

/** The folder of the origin's file system the runs' folders are kept in. */
const FOLDER = 'bottlify-runs';

/** Where page files were kept before they moved into a run's folder. */
const OLD_FOLDERS = ['bottlify-pages'];

/** @param {string} name */
const lockOf = name=>`bottlify-run:${name}`;

/**
 * @typedef {Object} RunFolder
 * @property {any} folder  a `FileSystemDirectoryHandle`, or one shaped as it
 * @property {() => () => void} use  one more part using the folder: what it
 *     calls once it has let go of every file in it
 */

/**
 * Opens a folder of its own for a run, or answers null where there is none to
 * be had for synchronous files: no origin file system, or a thread with no
 * synchronous access handles (a page's own thread).
 *
 * @param {{ root?: any }} [options]  `root`: the origin's file system by default;
 *     a test hands in its own
 * @returns {Promise<RunFolder | null>}
 */
export async function openRunFolder({ root } = {}){
    const nav = /** @type {any} */ (globalThis).navigator;
    let base = root;
    if (!base)
    {
        // A page's own thread has the folders and no synchronous handles; the
        // check costs a folder opened for nothing, so it is made first.
        const Handle = /** @type {any} */ (globalThis).FileSystemFileHandle;
        if (typeof nav?.storage?.getDirectory !== 'function'
            || typeof Handle?.prototype?.createSyncAccessHandle !== 'function')
        {
            return null;
        }
        base = await nav.storage.getDirectory();
    }
    const locks = nav?.locks;
    const name = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    /** @type {() => void} */
    let unlock = ()=>{};
    try
    {
        const runs = await base.getDirectoryHandle(FOLDER, { create: true });
        if (typeof locks?.request === 'function')
        {
            await new Promise(held=>{
                locks.request(lockOf(name), ()=>new Promise(done=>{
                    unlock = ()=>done(undefined);
                    held(undefined);
                })).catch(()=>held(undefined));
            });
        }
        await sweep(runs, locks);
        for (const old of OLD_FOLDERS)
        {
            // Files a running run of an older build holds refuse the removal.
            await base.removeEntry?.(old, { recursive: true }).catch(()=>{});
        }
        const folder = await runs.getDirectoryHandle(name, { create: true });
        let users = 0;
        return {
            folder,
            use(){
                users++;
                let used = true;
                return ()=>{
                    if (!used)
                    {
                        return;
                    }
                    used = false;
                    if (--users === 0)
                    {
                        runs.removeEntry(name, { recursive: true }).catch(()=>{}).finally(unlock);
                    }
                };
            },
        };
    }
    catch {
        unlock();
        return null;
    }
}

/**
 * Takes away the folders of runs that are gone.
 *
 * @param {any} runs @param {any} locks
 */
async function sweep(runs, locks){
    /** @type {Set<string> | null} */
    let held = null;
    if (typeof locks?.query === 'function')
    {
        const state = await locks.query().catch(()=>null);
        held = state ? new Set([...state.held ?? [], ...state.pending ?? []]
            .map((/** @type {any} */ lock)=>lock.name)) : null;
    }
    /** @type {string[]} */
    const names = [];
    for await (const [entryName] of runs.entries())
    {
        names.push(entryName);
    }
    for (const entryName of names)
    {
        // Browser locks that cannot be asked about: only open handles guard
        // a running run's folder, and a removal they refuse leaves it whole
        // only for a file - so without an answer, nothing is taken.
        if (held ? held.has(lockOf(entryName)) : locks)
        {
            continue;
        }
        await runs.removeEntry(entryName, { recursive: true }).catch(()=>{});
    }
}
