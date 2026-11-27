/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A texture level's own bytes handed to the texel store while nothing needs
 * them (`internal/texel-store.js`), and back as they were at their first
 * reader. Both of OpenGL's drawing sides keep levels this way: the device
 * path the levels no draw has uploaded yet (`gpu.js` `spill`), the processor
 * path the levels no draw has sampled for a while (`processor-levels.js`).
 *
 * A level's bytes of one kind - its RGBA `texels`, a sized level's `data`,
 * the S3TC blocks it keeps (`compressed`) - are each the only copy of what
 * the program made. Spilled, the level's property becomes an accessor: read,
 * it takes the bytes back (one copy out of the cache) and is a plain value
 * again, so a write in place, a decode or a read-back meets the same bytes;
 * set, it lets them go. A reader that only reads (an upload) reads them in
 * place where they wait (`readLevel`). Only a plain value is spilled: a
 * property already an accessor (a sized level's RGBA, made from its data; a
 * view's, read from the level it views) is not the level's own bytes.
 */

import { KEPT_FROM } from '../internal/texel-store.js';

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

/** @param {any} value */
const plainBytes = value=>(value instanceof Uint8Array ? value : null);

/** @type {Record<Spillable['property'], () => Spillable>} */
const KINDS = {
    texels: ()=>({ property: 'texels', bytesOf: plainBytes, made: bytes=>bytes,
        names: new WeakMap() }),
    data: ()=>({ property: 'data', bytesOf: plainBytes, made: bytes=>bytes,
        names: new WeakMap() }),
    compressed: ()=>({ property: 'compressed',
        bytesOf: value=>(value?.bytes instanceof Uint8Array ? value.bytes : null),
        made: (bytes, format)=>({ format, bytes }), names: new WeakMap() }),
};

/** @param {object} image @param {string} property @param {any} value */
const plain = (image, property, value)=>Object.defineProperty(image, property,
    { value, writable: true, configurable: true, enumerable: true });

/**
 * @param {{ store: import('../internal/texel-store.js').TexelStore,
 *     kinds: readonly Spillable['property'][] }} options
 */
export function createLevelSpill({ store, kinds }){
    const spillable = kinds.map(kind=>KINDS[kind]());
    // A key a level, never the texture's name and level: a name the program
    // deleted and made again would meet the bytes of the one before it until
    // the next `forget` let them go.
    let names = 0;
    const counts = { levels: 0, bytes: 0, blockBytes: 0, back: 0, backBytes: 0, inPlace: 0,
        forgotten: 0 };
    /**
     * The texture each key waiting in the store is a level of: a level of
     * one the program deleted is read by nothing, and its key is let go of
     * by `forget`, which is handed the textures that are alive.
     *
     * @type {Map<string, object>}
     */
    const spilledOf = new Map();

    /**
     * A waiting level's bytes back as the level's own, the level plain again:
     * a reader through the property may write them in place, so they are
     * the level's and not a view of the cache (`TexelStore.take`).
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
     * A level whose bytes of one kind wait in the store under `key`. Made
     * apart from `spillLevel`, so its accessors hold no reference to the
     * bytes they let go of.
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
         * A level's bytes of every kind handed to the store, where they are a
         * plain value large enough: they move into the run's cache once it
         * grants their room, and a write or a read meanwhile meets them in
         * the store.
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
                if (bytes === null || bytes.byteLength < KEPT_FROM)
                {
                    continue;
                }
                const key = String(++names);
                store.put(key, bytes);
                counts.levels++;
                counts.bytes += bytes.byteLength;
                counts.blockBytes += kind.property === 'compressed' ? bytes.byteLength : 0;
                handed += bytes.byteLength;
                waiting(kind, texture, image, key, was?.format ?? 0);
            }
            return handed;
        },

        /**
         * A level's bytes of one kind read for something that only reads
         * them: in place where they wait in the store under `waits`, else as
         * the level holds them (`held`).
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
         * The levels waiting in the store of a texture not among `alive`,
         * which the program deleted, let go of: nothing reads them again.
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
