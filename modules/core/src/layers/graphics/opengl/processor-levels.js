/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the processor path keeps of its contexts' texture levels, under the
 * run's cache rather than in the drawing thread's heap. Two kinds, kept two
 * ways:
 *
 * - A level's own bytes - legacy RGBA `texels`, a sized level's `data`, the
 *   S3TC blocks it keeps - are the only copy, written in place by sub-image
 *   writes. A level no draw has sampled since the look before (`look`, about
 *   once a second) hands them to the texel store (`level-spill.js`), and its
 *   first reader or writer takes them back as they were. A drawn level keeps
 *   them: the rasteriser reads them every draw, and a draw that took them
 *   back from the cache each second would copy them out each second.
 * - The RGBA the rasteriser samples, made from a sized level's data or
 *   decoded from its blocks (`rgbaOf`, `decodeS3tc`), is read every draw
 *   while the level is unchanged: it is held memory of the cache
 *   (`cache/scratch.js` `hold`), read in place, and let go of when the level
 *   is written, spilled, replaced or deleted. It can be made again, so it is
 *   never spilled.
 *
 * Without a cache under the root, or without room in it, the RGBA is the
 * plain memory it was made in, and without one nothing is spilled: the same
 * contract, the bytes in this heap.
 */

import { createTexelStore } from '../internal/texel-store.js';
import { createLevelSpill } from './level-spill.js';

/**
 * A level's RGBA made for the processor's rasteriser, and how it is let go
 * of: by level, whichever context or root made it, since a texture view's
 * level and the level it views are written through either.
 *
 * @type {WeakMap<object, { bytes: Uint8Array | null, release: () => void }>}
 */
const rgbaOfLevel = new WeakMap();

const NOTHING = ()=>{};

/**
 * The RGBA kept of a level: undefined where none is, null where it was kept
 * as none (a level let go of on a device).
 *
 * @param {object} level @returns {Uint8Array | null | undefined}
 */
export const keptRgba = level=>rgbaOfLevel.get(level)?.bytes;

/**
 * Keeps `bytes` as a level's RGBA until it is forgotten: copied into held
 * memory where the level is the processor's (`levels`) and there is room,
 * the bytes themselves otherwise.
 *
 * @param {object} level @param {Uint8Array | null} bytes
 * @param {ProcessorLevels | null} levels
 * @returns {Uint8Array | null}  what the level reads as its RGBA from now on
 */
export function keepRgba(level, bytes, levels){
    rgbaOfLevel.get(level)?.release();
    const kept = bytes && levels ? levels.held(level, bytes) : { bytes, release: NOTHING };
    rgbaOfLevel.set(level, kept);
    return kept.bytes;
}

/**
 * Forgets the RGBA kept of one level, not of the level it reads from: the
 * level holds texels of its own from now on.
 *
 * @param {object} level
 */
export function dropRgba(level){
    rgbaOfLevel.get(level)?.release();
    rgbaOfLevel.delete(level);
}

/**
 * Forgets the RGBA kept of a level whose bytes were written, and of the
 * level it reads them from (a texture view's, `texture-views.js`).
 *
 * @param {import('./objects.js').TextureLevel | undefined} level
 */
export function forgetRgba(level){
    for (let at = level; at; at = at.source)
    {
        dropRgba(at);
    }
}

/**
 * @typedef {ReturnType<typeof createProcessorLevels>} ProcessorLevels
 */

/**
 * @param {{ cache?: import('../internal/texel-store.js').TexelCache | null,
 *     hold?: import('../../cache/scratch.js').Hold | null,
 *     divergence?: ((detail: string, severity?: 'loss') => void) | null }} [options]
 *     `cache`: the root's names in the run's cache, where idle levels wait; `hold`:
 *     where the RGBA is held, null where there is no room; `divergence`: where a level
 *     the cache lost is said
 */
export function createProcessorLevels({ cache = null, hold = null, divergence = null } = {}){
    const store = createTexelStore({ cache,
        divergence: (detail, severity)=>divergence?.(`a texture's ${detail}: it draws blank`,
            severity) });
    const spill = createLevelSpill({ store, kinds: ['texels', 'data', 'compressed'] });
    /** The levels sampled by a draw since the last look. @type {WeakSet<object>} */
    let drawn = new WeakSet();
    /** The levels the last look saw: one made since is not idle yet. @type {WeakSet<object>} */
    let seen = new WeakSet();
    /**
     * The RGBA held here, by level, for a look to let go of what belongs to
     * a level the program replaced or deleted.
     *
     * @type {Map<object, () => void>}
     */
    const heldRgba = new Map();
    let holdNames = 0;
    const counts = { looks: 0, rgbaHeld: 0, rgbaHeldBytes: 0, rgbaPlain: 0, rgbaReleased: 0,
        spilledLevels: 0 };

    return {
        /**
         * Memory for a level's RGBA, `bytes` copied in: held where there is
         * room, `bytes` themselves where not.
         *
         * @param {object} level @param {Uint8Array} bytes
         * @returns {{ bytes: Uint8Array, release: () => void }}
         */
        held(level, bytes){
            // A name a hold: the cache lets a name's earlier hold go when it is held anew.
            const got = hold?.(`rgba/${++holdNames}`, bytes.byteLength) ?? null;
            if (got === null || got.bytes.byteLength < bytes.byteLength)
            {
                got?.release();
                counts.rgbaPlain++;
                return { bytes, release: NOTHING };
            }
            const into = got.bytes.subarray(0, bytes.byteLength);
            into.set(bytes);
            counts.rgbaHeld++;
            counts.rgbaHeldBytes += bytes.byteLength;
            const release = ()=>{
                if (heldRgba.get(level) === release)
                {
                    heldRgba.delete(level);
                    counts.rgbaHeldBytes -= bytes.byteLength;
                    counts.rgbaReleased++;
                    got.release();
                }
            };
            heldRgba.set(level, release);
            return { bytes: into, release };
        },

        /**
         * A level a draw samples, and the level it reads its bytes from.
         *
         * @param {import('./objects.js').TextureLevel} level
         */
        drawn(level){
            for (let at = /** @type {any} */ (level); at; at = at.source)
            {
                drawn.add(at);
            }
        },

        /**
         * The look for idle levels: each level of `all`, the textures alive,
         * that no draw sampled since the look before hands its bytes to the
         * store and lets its RGBA go; what is kept of a texture no longer
         * alive, or of a level it no longer has, is let go of.
         *
         * @param {Iterable<import('./objects.js').TextureObject>} all
         */
        look(all){
            counts.looks++;
            const alive = new Set(all);
            spill.forget(alive);
            /** @type {Set<object>} */
            const levels = new Set();
            const nextSeen = new WeakSet();
            for (const texture of alive)
            {
                for (const level of texture.levels?.values() ?? [])
                {
                    levels.add(level);
                    nextSeen.add(level);
                    if (drawn.has(level) || !seen.has(level))
                    {
                        continue;
                    }
                    if (!store.cached)
                    {
                        continue;
                    }
                    forgetRgba(level);
                    if (spill.spill(texture, level) > 0)
                    {
                        counts.spilledLevels++;
                    }
                }
            }
            for (const [level, release] of [...heldRgba])
            {
                if (!levels.has(level))
                {
                    release();
                    rgbaOfLevel.delete(level);
                }
            }
            seen = nextSeen;
            drawn = new WeakSet();
        },

        /** Every RGBA held here let go of: the root goes. */
        dispose(){
            for (const [level, release] of [...heldRgba])
            {
                release();
                rgbaOfLevel.delete(level);
            }
        },

        /** @param {object} level  whether any of its own bytes wait in the store */
        waits: (/** @type {object} */ level)=>spill.waits(level),

        figures: ()=>({ ...counts, held: heldRgba.size, spills: spill.figures(),
            store: store.figures() }),
    };
}
