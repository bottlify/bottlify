/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Several read-only sources as one: a bottle's bundle over the layers it
 * stands on (the .NET Framework, built once and shared by bottles).
 *
 * The first source that has a path answers for it: its stat, its bytes, its
 * spelling. Directories merge, each name under them answered by the first
 * source that has it, and a file shadows whatever a lower source holds at its
 * path or under it.
 *
 * Names are folded here exactly as the overlay folds them (`foldName`), though
 * no store folds case: the overlay makes one node of `WINDOWS` and `Windows`,
 * so two sources spelling one path two ways must answer as one, from the
 * source that wins. Each source is asked in its own spelling.
 */

import { ErrorCode, fsError } from './errors.js';
import { foldName } from './paths.js';

/**
 * @typedef {import('./memory-store.js').SourceStore} SourceStore
 * @typedef {{ store: SourceStore, path: string, directory: boolean }} Owner
 */

/**
 * @param {SourceStore[]} sources  the first wins
 * @returns {SourceStore}
 */
export function createUnionSource(sources){
    /** @type {Map<string, Owner>} by folded path */
    const owners = new Map();
    /** @type {import('./memory-store.js').StoredEntry[]} */
    const entries = [];

    // Each source listed once, here: a store is listed once in its life
    // (`SourceStore`), and the union is mounted on as many machines as a run has.
    for (const store of sources)
    {
        for (const entry of store.list())
        {
            const parts = entry.path.split('\\').filter(part=>part.length > 0);
            let key = '';
            let shadowed = false;
            for (let at = 0; at < parts.length - 1 && !shadowed; at++)
            {
                key = key === '' ? foldName(parts[at]) : `${key}\\${foldName(parts[at])}`;
                const owner = owners.get(key);
                if (owner === undefined)
                {
                    // A directory implied by what is under it, as the overlay
                    // implies it: this source's from here on.
                    owners.set(key, { store, path: parts.slice(0, at + 1).join('\\'),
                        directory: true });
                }
                shadowed = owner !== undefined && !owner.directory;
            }
            const folded = foldName(parts.join('\\'));
            if (shadowed || owners.has(folded))
            {
                continue;
            }
            owners.set(folded, { store, path: entry.path, directory: entry.directory });
            entries.push({ ...entry });
        }
    }

    return {
        list: ()=>entries.map(entry=>({ ...entry })),

        /** @param {string} path */
        stat(path){
            const owner = owners.get(foldName(path));
            if (owner === undefined)
            {
                return null;
            }
            return owner.directory ? { directory: true, size: 0 } : owner.store.stat(owner.path);
        },

        /**
         * The winning source's answer as it gives it: bytes, or a miss it throws
         * for the blocks it has to fetch first.
         *
         * @param {string} path @param {number} offset @param {number} length
         */
        read(path, offset, length){
            const owner = owners.get(foldName(path));
            if (owner === undefined || owner.directory)
            {
                throw fsError(ErrorCode.NOT_FOUND, `No file "${path}" in these sources`);
            }
            return owner.store.read(owner.path, offset, length);
        },
    };
}
