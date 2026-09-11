/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The registry hive: keys, the values hanging off them, and nothing else.
 *
 * This is a store, not an API surface -- it knows nothing about handles, guest
 * memory or error codes. What it does know are the two rules that make a
 * registry a registry rather than a nested map: names compare without regard to
 * case, and string data carries its own terminator. Both are the kind of detail
 * a program only notices by failing to find a setting it wrote itself.
 *
 * A session's registry outlives the session, so the whole tree converts to a
 * plain JSON-able object and back.
 */

/** The predefined roots. A guest names these by constant; it never opens them. */
export const HKEY_CLASSES_ROOT = 0x80000000;
export const HKEY_CURRENT_USER = 0x80000001;
export const HKEY_LOCAL_MACHINE = 0x80000002;
export const HKEY_USERS = 0x80000003;

/** Value types. The numbers are the guest's, not ours. */
export const REG_NONE = 0;
export const REG_SZ = 1;
export const REG_EXPAND_SZ = 2;
export const REG_BINARY = 3;
export const REG_DWORD = 4;
export const REG_MULTI_SZ = 7;

/** Types whose data is text, and is therefore expected to end in a terminator. */
const STRING_TYPES = new Set([REG_SZ, REG_EXPAND_SZ, REG_MULTI_SZ]);

const ROOT_NAMES = new Map([
    [HKEY_CLASSES_ROOT, 'HKEY_CLASSES_ROOT'],
    [HKEY_CURRENT_USER, 'HKEY_CURRENT_USER'],
    [HKEY_LOCAL_MACHINE, 'HKEY_LOCAL_MACHINE'],
    [HKEY_USERS, 'HKEY_USERS'],
]);

/**
 * @typedef {Object} RegistryValue
 * @property {string} name   As the writer spelled it; lookups ignore its case.
 * @property {number} type
 * @property {Uint8Array} data
 */

/**
 * @typedef {Object} RegistryKey
 * @property {string} name
 * @property {Map<string, RegistryKey>} keys      Keyed by folded name.
 * @property {Map<string, RegistryValue>} values  Keyed by folded name.
 */

/**
 * @typedef {Object} StoredValue
 * @property {string} name
 * @property {number} type
 * @property {number[]} data
 */

/**
 * @typedef {Object} StoredKey
 * @property {string} name
 * @property {StoredValue[]} values
 * @property {StoredKey[]} keys
 */

/**
 * Windows folds case with the invariant mapping, never the user's locale, so
 * `toLowerCase` rather than `toLocaleLowerCase` is the correct one here.
 *
 * @param {string} name
 */
const fold = name=>name.toLowerCase();

/** @param {string} name @returns {RegistryKey} */
function makeKey(name){
    return { name, keys: new Map(), values: new Map() };
}

/**
 * Splits a subkey path. A leading or trailing separator is tolerated because
 * guest code builds these paths by concatenation and often leaves one behind.
 *
 * @param {string | null | undefined} path
 * @returns {string[]}
 */
function segments(path){
    return typeof path === 'string' ? path.split('\\').filter(part=>part.length > 0) : [];
}

/**
 * String data is stored the way a reader expects to find it: REG_SZ ends in one
 * NUL, REG_MULTI_SZ in two. Guests that pass `strlen` as the byte count are
 * common enough that fixing the terminator here beats handing back a string
 * whose end nobody can find.
 *
 * @param {number} type @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function terminate(type, data){
    if (!STRING_TYPES.has(type))
    {
        return data;
    }
    const wanted = type === REG_MULTI_SZ ? 2 : 1;
    let present = 0;
    while (present < wanted && data[data.length - 1 - present] === 0)
    {
        present++;
    }
    if (present === wanted)
    {
        return data;
    }
    const padded = new Uint8Array(data.length + (wanted - present));
    padded.set(data);
    return padded;
}

/** @param {RegistryKey} key @returns {StoredKey} */
function keyToJSON(key){
    return {
        name: key.name,
        values: [...key.values.values()].map(value=>({
            name: value.name,
            type: value.type,
            data: [...value.data],
        })),
        keys: [...key.keys.values()].map(keyToJSON),
    };
}

/** @param {any} stored @returns {RegistryKey} */
function keyFromJSON(stored){
    const key = makeKey(stored?.name ?? '');
    for (const value of stored?.values ?? [])
    {
        const name = value?.name ?? '';
        key.values.set(fold(name), {
            name,
            type: value?.type >>> 0,
            data: Uint8Array.from(value?.data ?? []),
        });
    }
    for (const child of stored?.keys ?? [])
    {
        key.keys.set(fold(child?.name ?? ''), keyFromJSON(child));
    }
    return key;
}

/**
 * Builds an empty hive: the four predefined roots and nothing under them.
 *
 * Enumeration order is insertion order throughout, which is what makes an
 * index-based enumeration answer the same thing twice. Overwriting a value
 * leaves it where it was; only deleting and re-adding moves it to the end.
 */
export function createHive(){
    /** @type {Map<number, RegistryKey>} */
    const roots = new Map();

    /**
     * Whoever keeps the hive between runs. Told once per burst of changes and
     * on a microtask, so a program writing its settings one value at a time
     * costs one save rather than one per value, and nothing is announced from
     * inside the call that is still making the change.
     *
     * @type {(() => void)[]}
     */
    const listeners = [];
    let announcing = false;
    const changed = ()=>{
        if (announcing || listeners.length === 0)
        {
            return;
        }
        announcing = true;
        queueMicrotask(()=>{
            announcing = false;
            for (const listener of listeners)
            {
                listener();
            }
        });
    };

    const reset = ()=>{
        roots.clear();
        for (const [id, name] of ROOT_NAMES)
        {
            roots.set(id, makeKey(name));
        }
    };
    reset();

    /**
     * Walks to the parent of the last path segment, which is where both
     * creation and deletion have to act.
     *
     * @param {RegistryKey} key @param {string | null | undefined} path
     * @returns {{ parent: RegistryKey, name: string } | null}
     */
    const parentOf = (key, path)=>{
        const parts = segments(path);
        if (parts.length === 0)
        {
            return null;
        }
        let node = key;
        for (const part of parts.slice(0, -1))
        {
            const next = node.keys.get(fold(part));
            if (!next)
            {
                return null;
            }
            node = next;
        }
        return { parent: node, name: parts[parts.length - 1] };
    };

    return {
        /**
         * @param {number} id
         * @returns {RegistryKey | null}
         */
        root(id){
            return roots.get(id >>> 0) ?? null;
        },

        /**
         * Resolves a subkey path. An empty or absent path names the key itself,
         * which is how a caller reopens the key it already holds.
         *
         * @param {RegistryKey} key @param {string | null} [path]
         * @returns {RegistryKey | null}
         */
        open(key, path){
            let node = key;
            for (const part of segments(path))
            {
                const next = node.keys.get(fold(part));
                if (!next)
                {
                    return null;
                }
                node = next;
            }
            return node;
        },

        /**
         * Creates a subkey path, intermediate keys included.
         *
         * @param {RegistryKey} key @param {string | null} [path]
         * @returns {{ key: RegistryKey, created: boolean }}
         */
        create(key, path){
            let node = key;
            let created = false;
            for (const part of segments(path))
            {
                let next = node.keys.get(fold(part));
                if (!next)
                {
                    next = makeKey(part);
                    node.keys.set(fold(part), next);
                    created = true;
                }
                node = next;
            }
            if (created)
            {
                changed();
            }
            return { key: node, created };
        },

        /**
         * Deletes a subkey. One that has subkeys of its own is refused rather
         * than removed recursively -- NT's rule, and the reason a delete can
         * fail on a key that plainly exists.
         *
         * @param {RegistryKey} key @param {string | null} [path]
         * @returns {'deleted' | 'missing' | 'has-subkeys'}
         */
        remove(key, path){
            const target = parentOf(key, path);
            if (!target)
            {
                return 'missing';
            }
            const doomed = target.parent.keys.get(fold(target.name));
            if (!doomed)
            {
                return 'missing';
            }
            if (doomed.keys.size > 0)
            {
                return 'has-subkeys';
            }
            target.parent.keys.delete(fold(target.name));
            changed();
            return 'deleted';
        },

        /**
         * @param {RegistryKey} key
         * @returns {string[]} subkey names, in enumeration order
         */
        subkeys(key){
            return [...key.keys.values()].map(child=>child.name);
        },

        /**
         * @param {RegistryKey} key
         * @returns {RegistryValue[]} in enumeration order
         */
        values(key){
            return [...key.values.values()];
        },

        /**
         * The unnamed default value is the one whose name is the empty string.
         *
         * @param {RegistryKey} key @param {string} name
         * @returns {RegistryValue | null}
         */
        getValue(key, name){
            return key.values.get(fold(name)) ?? null;
        },

        /**
         * @param {RegistryKey} key @param {string} name
         * @param {number} type @param {Uint8Array} data
         * @returns {RegistryValue}
         */
        setValue(key, name, type, data){
            const value = { name, type: type >>> 0, data: terminate(type >>> 0, data) };
            key.values.set(fold(name), value);
            changed();
            return value;
        },

        /** @param {RegistryKey} key @param {string} name @returns {boolean} */
        deleteValue(key, name){
            const deleted = key.values.delete(fold(name));
            if (deleted)
            {
                changed();
            }
            return deleted;
        },

        /**
         * Asks to be told when the hive has changed. A restore is not a change.
         *
         * @param {() => void} listener
         * @returns {() => void} forgets the listener
         */
        onChanged(listener){
            listeners.push(listener);
            return ()=>{
                const at = listeners.indexOf(listener);
                if (at >= 0)
                {
                    listeners.splice(at, 1);
                }
            };
        },

        /**
         * The whole hive as a plain object. Roots are a list rather than an
         * object so that nothing depends on how a JSON implementation orders
         * numeric keys.
         *
         * @returns {{ roots: { id: number, key: StoredKey }[] }}
         */
        toJSON(){
            return {
                roots: [...roots.entries()].map(([id, key])=>({ id, key: keyToJSON(key) })),
            };
        },

        /**
         * Replaces the contents with a saved tree. Roots the save does not
         * mention come back empty rather than missing, so a hive is always
         * usable after a restore.
         *
         * @param {any} stored
         */
        fromJSON(stored){
            reset();
            for (const entry of stored?.roots ?? [])
            {
                const id = entry?.id >>> 0;
                if (!ROOT_NAMES.has(id))
                {
                    continue;
                }
                roots.set(id, keyFromJSON(entry.key));
            }
        },
    };
}
