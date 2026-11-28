/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A texture level's own bytes - RGBA `texels`, a sized level's `data`, kept
 * S3TC blocks (`compressed`), each the only copy - handed to the texel store
 * while nothing needs them: by the device path before a draw uploads them
 * (`gpu.js` `spill`), by the processor path while no draw samples them
 * (`processor-levels.js`). The property becomes an accessor: read, it takes
 * the bytes back as the level's own (a write in place meets them); set, it
 * lets them go; an upload reads them in place (`readLevel`). An accessor
 * already there (a sized level's RGBA, a view's) is not the level's bytes.
 * A level's bytes go with its texture's others (the store's group), so the
 * small levels of a chain's tail share one body of the cache.
 */

/**
 * A kind of a level's bytes: `bytesOf` names the bytes a value holds and
 * `made` makes the value again from them; `names` the key a level's bytes
 * wait under.
 *
 * @typedef {{ property: 'texels' | 'compressed' | 'data',
 *     bytesOf: (value: any) => Uint8Array | null,
 *     made: (bytes: Uint8Array, format: number) => any,
 *     names: WeakMap<object, string> }} Spillable
 */

/** @param {Spillable['property']} property @returns {Spillable} */
const kindOf = property=>(property === 'compressed'
    ? { property, bytesOf: value=>(value?.bytes instanceof Uint8Array ? value.bytes : null),
        made: (bytes, format)=>({ format, bytes }), names: new WeakMap() }
    : { property, bytesOf: value=>(value instanceof Uint8Array ? value : null),
        made: bytes=>bytes, names: new WeakMap() });

/** @param {object} image @param {string} property @param {any} value */
const plain = (image, property, value)=>Object.defineProperty(image, property,
    { value, writable: true, configurable: true, enumerable: true });

/**
 * @param {{ store: import('../internal/texel-store.js').TexelStore,
 *     kinds: readonly Spillable['property'][] }} options
 */
export function createLevelSpill({ store, kinds }){
    const spillable = kinds.map(kindOf);
    // A key a level, never the texture's name and level: a name the program
    // deleted and made again would meet the bytes of the one before it until
    // the next `forget` let them go.
    let names = 0;
    const counts = { levels: 0, bytes: 0, blockBytes: 0, back: 0, backBytes: 0, inPlace: 0,
        forgotten: 0 };
    /** The texture each key waiting in the store is a level of, for `forget`. @type {Map<string, object>} */
    const spilledOf = new Map();

    /**
     * A waiting level's bytes back as the level's own, not a view of the
     * cache: a reader through the property may write them in place.
     *
     * @param {Spillable} kind @param {object} image @param {string} key @param {number} format
     */
    const takeBack = (kind, image, key, format)=>{
        const length = store.lengthOf(key);
        const value = kind.made(store.take(key) ?? new Uint8Array(length), format);
        plain(image, kind.property, value);
        kind.names.delete(image);
        spilledOf.delete(key);
        counts.back++;
        counts.backBytes += length;
        return value;
    };

    /**
     * A level whose bytes of one kind wait in the store under `key`; its
     * accessors hold no reference to the bytes they let go of.
     *
     * @param {Spillable} kind @param {object} texture @param {object} image @param {string} key
     * @param {number} format  an S3TC level's format
     */
    const waiting = (kind, texture, image, key, format)=>{
        kind.names.set(image, key);
        spilledOf.set(key, texture);
        Object.defineProperty(image, kind.property, {
            configurable: true, enumerable: true,
            get(){
                return takeBack(kind, image, key, format);
            },
            set(value){
                plain(image, kind.property, value);
                kind.names.delete(image);
                spilledOf.delete(key);
                store.drop(key);
            },
        });
    };

    return {
        /** The kinds in the order asked, each with the keys its levels wait under. */
        kinds: spillable,

        /**
         * A level's bytes of every kind that is a plain value handed to the
         * store, with its texture's others.
         *
         * @param {object} texture @param {object} image
         * @returns {number}  the bytes handed over
         */
        spill(texture, image){
            let handed = 0;
            for (const kind of spillable)
            {
                const held = Object.getOwnPropertyDescriptor(image, kind.property);
                const was = held && 'value' in held ? held.value : null;
                const bytes = kind.bytesOf(was);
                if (bytes === null)
                {
                    continue;
                }
                const key = String(++names);
                store.put(key, bytes, texture);
                counts.levels++;
                counts.bytes += bytes.byteLength;
                counts.blockBytes += kind.property === 'compressed' ? bytes.byteLength : 0;
                handed += bytes.byteLength;
                waiting(kind, texture, image, key, was?.format ?? 0);
            }
            return handed;
        },

        /**
         * A level's bytes of one kind read: in place where they wait under
         * `waits`, else as the level holds them (`held`).
         *
         * @param {string | undefined} waits @param {() => any} held
         * @param {(bytes: any) => void} read
         */
        readLevel(waits, held, read){
            if (waits === undefined)
            {
                read(held());
                return;
            }
            store.with(waits, read);
            counts.inPlace++;
        },

        /** @param {object} image  whether any of its bytes wait in the store */
        waits: image=>spillable.some(kind=>kind.names.has(image)),

        /**
         * What waits of a texture not among `alive` (deleted) let go of.
         *
         * @param {Set<object>} alive
         */
        forget(alive){
            for (const [key, texture] of spilledOf)
            {
                if (!alive.has(texture))
                {
                    spilledOf.delete(key);
                    store.drop(key);
                    counts.forgotten++;
                }
            }
        },

        figures: ()=>({ ...counts }),
    };
}
