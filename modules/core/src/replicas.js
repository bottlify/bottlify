/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The files and the registry of processes that run side by side.
 *
 * On Windows two processes share one volume and one registry. Here each
 * process is a machine with a volume and a hive of its own, so what one of
 * them writes has to be carried to the others -- and it is carried when it
 * can matter: when one process is about to run on another's behalf, as a
 * call from one to an object in the other does, and when a process ends.
 *
 * A process's changes are what differs between its state now and its state
 * the last time it was brought up to date, so what another process wrote in
 * between is never mistaken for its own and carried back over something
 * newer. Its files are asked for by generation -- only those it wrote since --
 * and its registry is compared only when its revision moved: a process calls
 * another thousands of times, and reading every file it ever wrote at each
 * call cost more than the programs themselves.
 */

/**
 * @typedef {Object} RegistryValue
 * @property {string} key    The key's path, root first, as the hive spells it.
 * @property {string} name
 * @property {number} type
 * @property {Uint8Array} data
 */

/**
 * @typedef {Object} Snapshot
 * @property {number} generation  The volume's generation it was brought up to date at.
 * @property {number} revision    The hive's revision likewise.
 * @property {Map<string, RegistryValue>} values  By folded key path and value name.
 * @property {Map<string, string>} keys  Folded key path -> as spelled.
 */

/**
 * @typedef {Object} Changes
 * @property {{ path: string, bytes?: Uint8Array, delete?: boolean }[]} files
 * @property {RegistryValue[]} values
 * @property {RegistryValue[]} removedValues
 * @property {string[]} keys          Made, as spelled.
 * @property {string[]} removedKeys
 */

/** @param {string} text */
const fold = text=>text.toLowerCase();

/**
 * @param {{ roots?: { id: number, key: any }[] }} hive  A hive's `toJSON`.
 * @param {Snapshot} into
 */
function readHive(hive, into){
    /** @param {any} key @param {string} path */
    const walk = (key, path)=>{
        into.keys.set(fold(path), path);
        for (const value of key.values ?? [])
        {
            into.values.set(`${fold(path)}\0${fold(value.name)}`, {
                key: path, name: value.name, type: value.type, data: Uint8Array.from(value.data),
            });
        }
        for (const child of key.keys ?? [])
        {
            walk(child, `${path}\\${child.name}`);
        }
    };
    for (const root of hive.roots ?? [])
    {
        walk(root.key, String(root.id >>> 0));
    }
}

/**
 * Where a process stands right now: its volume's generation and its registry.
 *
 * @param {any} process
 * @returns {Snapshot}
 */
export function snapshotOf(process){
    /** @type {Snapshot} */
    const snapshot = { generation: process.session.generation(),
        revision: process.registry().revision(), values: new Map(), keys: new Map() };
    readHive(process.registry().toJSON(), snapshot);
    return snapshot;
}

/** @param {Uint8Array} a @param {Uint8Array} b */
function same(a, b){
    if (a.length !== b.length)
    {
        return false;
    }
    for (let index = 0; index < a.length; index++)
    {
        if (a[index] !== b[index])
        {
            return false;
        }
    }
    return true;
}

/**
 * @param {Snapshot} before @param {Snapshot} after
 * @returns {Changes}
 */
export function changesBetween(before, after){
    /** @type {Changes} */
    const changes = { files: [], values: [], removedValues: [], keys: [], removedKeys: [] };
    for (const [path, spelled] of after.keys)
    {
        if (!before.keys.has(path))
        {
            changes.keys.push(spelled);
        }
    }
    for (const [path, spelled] of before.keys)
    {
        if (!after.keys.has(path))
        {
            changes.removedKeys.push(spelled);
        }
    }
    for (const [at, value] of after.values)
    {
        const was = before.values.get(at);
        if (!was || was.type !== value.type || !same(was.data, value.data))
        {
            changes.values.push(value);
        }
    }
    for (const [at, value] of before.values)
    {
        if (!after.values.has(at))
        {
            changes.removedValues.push(value);
        }
    }
    return changes;
}

/** @param {Changes} changes */
export const isEmpty = changes=>changes.files.length + changes.values.length
    + changes.removedValues.length + changes.keys.length + changes.removedKeys.length === 0;

/**
 * The same changes made to a snapshot, so that it stays what its process
 * holds.
 *
 * @param {Snapshot} snapshot @param {Changes} changes
 */
export function applyToSnapshot(snapshot, changes){
    for (const path of changes.removedKeys)
    {
        const folded = fold(path);
        for (const known of [...snapshot.keys.keys()])
        {
            if (known === folded || known.startsWith(`${folded}\\`))
            {
                snapshot.keys.delete(known);
            }
        }
        for (const at of [...snapshot.values.keys()])
        {
            if (at.startsWith(`${folded}\0`) || at.startsWith(`${folded}\\`))
            {
                snapshot.values.delete(at);
            }
        }
    }
    for (const path of changes.keys)
    {
        snapshot.keys.set(fold(path), path);
    }
    for (const value of changes.removedValues)
    {
        snapshot.values.delete(`${fold(value.key)}\0${fold(value.name)}`);
    }
    for (const value of changes.values)
    {
        snapshot.values.set(`${fold(value.key)}\0${fold(value.name)}`, value);
    }
}

/**
 * The changes made to a hive's `toJSON` tree, in place.
 *
 * @param {{ roots: { id: number, key: any }[] }} hive @param {Changes} changes
 */
export function applyToHive(hive, changes){
    /**
     * @param {string} path @param {boolean} create
     * @returns {{ key: any, parent: any } | null}
     */
    const find = (path, create)=>{
        const [rootId, ...names] = path.split('\\');
        const root = hive.roots.find(entry=>String(entry.id >>> 0) === rootId);
        if (!root)
        {
            return null;
        }
        let key = root.key;
        let parent = null;
        for (const name of names)
        {
            let child = key.keys.find((/** @type {any} */ one)=>fold(one.name) === fold(name));
            if (!child)
            {
                if (!create)
                {
                    return null;
                }
                child = { name, values: [], keys: [] };
                key.keys.push(child);
            }
            parent = key;
            key = child;
        }
        return { key, parent };
    };
    for (const path of changes.removedKeys)
    {
        const found = find(path, false);
        if (found?.parent)
        {
            found.parent.keys = found.parent.keys.filter((/** @type {any} */ one)=>
                one !== found.key);
        }
    }
    for (const path of changes.keys)
    {
        find(path, true);
    }
    for (const value of changes.removedValues)
    {
        const found = find(value.key, false);
        if (found)
        {
            found.key.values = found.key.values.filter((/** @type {any} */ one)=>
                fold(one.name) !== fold(value.name));
        }
    }
    for (const value of changes.values)
    {
        const found = find(value.key, true);
        if (!found)
        {
            continue;
        }
        found.key.values = found.key.values.filter((/** @type {any} */ one)=>
            fold(one.name) !== fold(value.name));
        found.key.values.push({ name: value.name, type: value.type, data: [...value.data] });
    }
}

/**
 * Keeps the processes that stand at once in step.
 *
 * @param {(detail: string) => void} [report]  A file another process holds
 *        open cannot be replaced under it, and is said so.
 */
export function createReplicas(report){
    /** @type {Map<any, Snapshot>} */
    const known = new Map();

    /**
     * @param {any} process
     */
    const track = process=>{
        if (!known.has(process))
        {
            known.set(process, snapshotOf(process));
        }
    };

    return {
        track,

        /** @param {any} process */
        forget: process=>{
            known.delete(process);
        },

        /** @param {any} process */
        tracked: process=>known.has(process),

        /**
         * What `process` changed since it was last brought up to date, made
         * everywhere else.
         *
         * @param {any} process
         */
        publish(process){
            const before = known.get(process);
            if (!before)
            {
                return;
            }
            const generation = process.session.generation();
            const revision = process.registry().revision();
            if (generation === before.generation && revision === before.revision)
            {
                return;
            }
            /** @type {Changes} */
            let changes = { files: [], values: [], removedValues: [], keys: [], removedKeys: [] };
            if (revision !== before.revision)
            {
                const after = snapshotOf(process);
                changes = changesBetween(before, after);
                before.values = after.values;
                before.keys = after.keys;
            }
            if (generation !== before.generation)
            {
                changes.files = process.session.changesSince(before.generation);
            }
            before.generation = generation;
            before.revision = revision;
            if (isEmpty(changes))
            {
                return;
            }
            for (const [other, snapshot] of known)
            {
                if (other === process)
                {
                    continue;
                }
                for (const file of changes.files)
                {
                    try
                    {
                        // Quietly: it is the other's copy of this process's
                        // write, and not the other's to carry back.
                        other.session.apply([file], { quiet: true });
                    }
                    catch (e){
                        report?.(`${file.path} is open in another process and was not replaced:`
                            + ` ${e instanceof Error ? e.message : e}`);
                    }
                }
                if (changes.values.length + changes.removedValues.length + changes.keys.length
                    + changes.removedKeys.length > 0)
                {
                    const hive = other.registry().toJSON();
                    applyToHive(hive, changes);
                    other.registry().fromJSON(hive);
                }
                applyToSnapshot(snapshot, changes);
            }
        },
    };
}
