/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A layer: a runtime built once - the .NET Framework, installed by its own
 * setup on an empty machine - and mounted under every bottle that needs it
 * (core's `bundle.layers`). It is a bottle's system files alone: what the runs
 * wrote on C:, each file under `.bottlify\drive_c` by its path from C:, and in
 * `.bottlify\registry.json` the keys and values the runs added or changed,
 * since the machine's own are every bottle's already and a layer only adds to
 * a machine. The run's scratch stays out: the temporary directories, the
 * folder the setup was put in to be run, and the folders a setup unpacks
 * itself into at the drive's root under a name of 32 hex digits.
 */

import { REGISTRY_PATH } from './prefix.js';
import { atPath } from './chunks.js';

/** Where a layer's files are, under the drive's root as the bundle holds them. */
export const LAYER_DRIVE = '.bottlify\\drive_c';

/** A setup's own extraction folder at the drive's root: `C:\97476d1986e5182a495ef1e5aa1d8c20`. */
const EXTRACTION = /^[0-9a-f]{32}\\/i;

/**
 * What a run added to a hive and changed in it: keys and values not in
 * `before`, or not as there. Removed ones are not carried.
 *
 * @param {any} before  A key as the registry's `toJSON` writes it, or null.
 * @param {any} after
 * @returns {any | null}  null when nothing differs
 */
export function hiveAdded(before, after){
    const values = (after.values ?? []).filter((/** @type {any} */ value)=>{
        const was = (before?.values ?? []).find((/** @type {any} */ old)=>
            old.name.toLowerCase() === value.name.toLowerCase());
        return !was || was.type !== value.type || was.data.join() !== value.data.join();
    });
    const keys = (after.keys ?? []).map((/** @type {any} */ key)=>hiveAdded(
        (before?.keys ?? []).find((/** @type {any} */ old)=>
            old.name.toLowerCase() === key.name.toLowerCase()) ?? null, key))
        .filter(Boolean);
    return values.length > 0 || keys.length > 0 || !before
        ? { name: after.name, values, keys } : null;
}

/**
 * The layer a run made, from what it left: its files as the session exports
 * them (`C:\...` paths) and its hive, against the hive it started from.
 *
 * @param {Object} run
 * @param {import('./chunks.js').ChunkedFile[]} run.files
 * @param {any} run.registry  The hive after the runs (`toJSON`).
 * @param {any} run.before    The hive before the first program ran.
 * @param {string[]} [run.leave]  Folders whose files are not the layer's: where
 *     the setup was put to be run.
 * @returns {import('./chunks.js').ChunkedFile[]}  each file re-pathed under `LAYER_DRIVE`,
 *     its pieces not copied, and the registry's diff at `REGISTRY_PATH`.
 */
export function collectLayer({ files, registry, before, leave = [] }){
    const left = leave.map(folder=>`${folder.replace(/\\+$/, '')}\\`.toLowerCase());
    /** @type {import('./chunks.js').ChunkedFile[]} */
    const kept = [];
    for (const file of files)
    {
        const [, drive, rest] = /^([A-Za-z]):\\(.*)$/.exec(file.path) ?? [];
        const folder = rest?.slice(0, rest.lastIndexOf('\\') + 1) ?? '';
        if (drive?.toUpperCase() !== 'C' || /(^|\\)temp\\/i.test(folder) || EXTRACTION.test(rest)
            || left.some(prefix=>file.path.toLowerCase().startsWith(prefix)))
        {
            continue;
        }
        kept.push(atPath(file, `${LAYER_DRIVE}\\${rest}`));
    }
    const roots = (registry?.roots ?? []).map((/** @type {any} */ root)=>{
        const key = hiveAdded((before?.roots ?? []).find((/** @type {any} */ old)=>
            old.id === root.id)?.key ?? null, root.key);
        return key ? { id: root.id, key } : null;
    }).filter(Boolean);
    kept.push({ path: REGISTRY_PATH, bytes: new TextEncoder().encode(JSON.stringify({ roots })) });
    return kept;
}
