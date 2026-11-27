/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A Cellar keeper's disk (`@bottlify/cellar`, `Disk`) over a directory of the
 * origin's file system: each file the keeper names (its packs, its two
 * indexes) a file of the directory, made where it is missing, through a
 * synchronous handle taken by `system/opfs-file.js`, as every writer of the
 * origin's file system takes one.
 *
 * The keeper calls a file's methods on its own thread in the middle of its
 * work, and they call none of its methods: a write refused for room is told
 * to `onQuota` (once a refusal, its message) and thrown on, which the keeper
 * counts as a failure of the disk, the body then staying where it was.
 *
 * Where the thread has no synchronous handle to give (a page's own thread), a
 * file does not open: the keeper that asked does not open either, and the
 * cache over it runs in memory alone.
 *
 * A keeper opens its next pack ahead, without waiting for it, and writes
 * nothing out until it is open: `settled` is when every file asked for so far
 * has opened or failed to.
 */

import { isQuota, openSync } from '../../../system/opfs-file.js';

/** @typedef {import('@bottlify/cellar').Disk} Disk */

/**
 * @param {any} directory  a `FileSystemDirectoryHandle`, or one shaped as it
 * @param {{ onQuota?: (reason: string) => void }} [options]
 * @returns {Disk & { settled: () => Promise<void> }}
 */
export function opfsDisk(directory, { onQuota = ()=>{} } = {}){
    /** The opens under way. @type {Set<Promise<unknown>>} */
    const opening = new Set();
    /** @param {string} name */
    const take = async name=>{
        const access = await openSync(await directory.getFileHandle(name, { create: true }));
        if (access === null)
        {
            throw new Error('no synchronous file handle on this thread');
        }
        /** @type {import('@bottlify/cellar').DiskFile} */
        const file = {
            read: (view, where)=>access.read(view, where),
            write(view, where){
                try
                {
                    return access.write(view, where);
                }
                catch (e){
                    if (isQuota(e))
                    {
                        onQuota(/** @type {Error} */ (e).message);
                    }
                    throw e;
                }
            },
            flush: ()=>access.flush(),
            getSize: ()=>access.getSize(),
            truncate: size=>access.truncate(size),
            close: ()=>access.close(),
        };
        return file;
    };
    return {
        open(name){
            const opened = take(name);
            const done = opened.catch(()=>{});
            opening.add(done);
            done.then(()=>opening.delete(done));
            return opened;
        },
        remove: name=>directory.removeEntry(name),
        async settled(){
            while (opening.size > 0)
            {
                await Promise.all(opening);
            }
        },
    };
}
