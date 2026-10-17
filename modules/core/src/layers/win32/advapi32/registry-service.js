/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The registry as the system half of Win32 offers it to a process: the
 * hive's own operations, with every key named by a number rather than handed
 * out as the hive's object.
 *
 * A key the hive hands out is a node of its tree, which only the thread that
 * holds the tree can follow. A process that runs in a worker of its own
 * cannot be given one, so what crosses between the halves is values only --
 * numbers, strings, bytes -- and this is that interface: one service per
 * run, called directly while every process runs on the system's thread,
 * and the same calls carried over a ring once one does not.
 *
 * A key's number is its own for as long as the run lasts: the same node is
 * always the same number, so a process comparing two keys it opened compares
 * numbers. A key seen through the classes root has no node of its own -- it
 * is the user's and the machine's key at once -- and is numbered by its path.
 */

import { detachedKey } from './registry.js';

/**
 * @param {ReturnType<typeof import('./registry.js').createHive>} hive
 */
export function createRegistryService(hive){
    /** @type {WeakMap<object, number>} */
    const numbered = new WeakMap();
    /** Keys through the classes root, by their path. @type {Map<string, number>} */
    const classes = new Map();
    /** @type {Map<number, any>} */
    const keys = new Map();
    /** Keys outside every root, the only ones a number is ever let go of. @type {Set<number>} */
    const detached = new Set();
    let next = 1;

    /** @param {any} key @returns {number | null} */
    const numberOf = key=>{
        if (!key)
        {
            return null;
        }
        if (key.view === 'classes')
        {
            const path = `${key.path.join('\\').toLowerCase()}`;
            let id = classes.get(path);
            if (id === undefined)
            {
                // Kept as first seen: the spelling a key is named by does not
                // change with the spelling of the next caller to open it.
                id = next++;
                classes.set(path, id);
                keys.set(id, key);
            }
            return id;
        }
        let id = numbered.get(key);
        if (id === undefined)
        {
            id = next++;
            numbered.set(key, id);
            keys.set(id, key);
        }
        return id;
    };
    /** @param {number} id */
    const keyOf = id=>keys.get(id) ?? null;

    return {
        /** @param {number} root @returns {number | null} */
        root: root=>numberOf(hive.root(root)),

        /** @param {number} key @param {string | null} [path] @returns {number | null} */
        open(key, path){
            const at = keyOf(key);
            return at ? numberOf(hive.open(at, path)) : null;
        },

        /**
         * @param {number} key @param {string | null} [path]
         * @returns {{ key: number, created: boolean }}
         */
        create(key, path){
            const at = keyOf(key);
            if (!at)
            {
                // A number this service never gave out is the caller's mistake,
                // not a key that went away: a deleted key keeps its number.
                throw new Error(`registry: no key numbered ${key}`);
            }
            const made = hive.create(at, path);
            return { key: /** @type {number} */ (numberOf(made.key)), created: made.created };
        },

        /**
         * @param {number} key @param {string | null} [path]
         * @returns {'deleted' | 'missing' | 'has-subkeys'}
         */
        remove(key, path){
            const at = keyOf(key);
            return at ? hive.remove(at, path) : 'missing';
        },

        /** @param {number} key @returns {string[]} */
        subkeys(key){
            const at = keyOf(key);
            return at ? hive.subkeys(at) : [];
        },

        /** @param {number} key @returns {import('./registry.js').RegistryValue[]} */
        values(key){
            const at = keyOf(key);
            return at ? hive.values(at) : [];
        },

        /**
         * @param {number} key @param {string} name
         * @returns {import('./registry.js').RegistryValue | null}
         */
        getValue(key, name){
            const at = keyOf(key);
            return at ? hive.getValue(at, name) : null;
        },

        /**
         * @param {number} key @param {string} name @param {number} type @param {Uint8Array} data
         * @returns {import('./registry.js').RegistryValue | null}
         */
        setValue(key, name, type, data){
            const at = keyOf(key);
            return at ? hive.setValue(at, name, type, data) : null;
        },

        /**
         * @param {number} parent @param {string} name @param {string} to
         * @returns {'renamed' | 'missing' | 'taken'}
         */
        rename(parent, name, to){
            const at = keyOf(parent);
            return at ? hive.rename(at, name, to) : 'missing';
        },

        /** @param {number} key @param {string} name @returns {boolean} */
        deleteValue(key, name){
            const at = keyOf(key);
            return at ? hive.deleteValue(at, name) : false;
        },

        /**
         * Where a key hangs: its parent and its name there, or null for a root,
         * a key outside every root, or one deleted since.
         *
         * @param {number} key @returns {{ parent: number, name: string } | null}
         */
        placeOf(key){
            const at = keyOf(key);
            const place = at ? hive.placeOf(at) : null;
            return place ? { parent: /** @type {number} */ (numberOf(place.parent)),
                name: place.name } : null;
        },

        /**
         * Whether a key is seen through the classes root, the user's and the
         * machine's key at once: renamed and deleted only as one or the other.
         *
         * @param {number} key
         */
        throughClasses: key=>keyOf(key)?.view === 'classes',

        /**
         * A key outside every root: the tree RegLoadAppKey opens a hive file as.
         *
         * @returns {number}
         */
        detached(){
            const id = /** @type {number} */ (numberOf(detachedKey()));
            detached.add(id);
            return id;
        },

        /**
         * Lets go of a key outside every root once nothing holds it: a key in
         * the tree stays numbered for as long as the run does.
         *
         * @param {number} key
         */
        forget(key){
            if (detached.delete(key))
            {
                keys.delete(key);
            }
        },

        revision: ()=>hive.revision(),
        /** @param {() => void} listener */
        onChanged: listener=>hive.onChanged(listener),
        toJSON: ()=>hive.toJSON(),
        /** @param {any} stored */
        fromJSON: stored=>hive.fromJSON(stored),
        /** @param {any} stored */
        /** @param {any} stored @param {boolean} [over] */
        fillFromJSON: (stored, over)=>hive.fillFromJSON(stored, over),
    };
}
