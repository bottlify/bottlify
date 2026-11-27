/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The processor path's idle texture levels in the run's cache: a level no
 * draw has sampled since the look before (`look`, about once a second) hands
 * its own bytes to the texel store (`level-spill.js`), and its first reader
 * or writer takes them back. A drawn level keeps them, as the rasteriser
 * reads them every draw. The RGBA it samples is held memory of the cache
 * already (`context-textures.js` `rgbaCache`): made again at will, it is not
 * spilled but let go of with the bytes it was made from.
 */

import { createTexelStore } from '../internal/texel-store.js';
import { createLevelSpill } from './level-spill.js';

/**
 * @typedef {ReturnType<typeof createProcessorLevels>} ProcessorLevels
 */

/**
 * @param {{ cache: import('../internal/texel-store.js').TexelCache,
 *     forgetRgba?: ((level: import('./objects.js').TextureLevel) => void) | null,
 *     divergence?: ((detail: string, severity?: 'loss') => void) | null }} options
 *     `cache`: the root's names in the run's cache, where idle levels wait;
 *     `forgetRgba`: lets an idle level's RGBA go (`context-textures.js`, handed in
 *     so this module is not one its kernel's types lead back to); `divergence`:
 *     where a level the cache lost is said
 */
export function createProcessorLevels(options){
    const { cache, forgetRgba = null, divergence = null } = options;
    const store = createTexelStore({ cache,
        divergence: (detail, severity)=>divergence?.(`a texture's ${detail}: it draws blank`,
            severity) });
    const spill = createLevelSpill({ store, kinds: ['texels', 'data', 'compressed'] });
    /** The levels sampled by a draw since the last look. @type {WeakSet<object>} */
    let drawn = new WeakSet();
    /** The levels the last look saw: one made since is not idle yet. @type {WeakSet<object>} */
    let seen = new WeakSet();
    const counts = { looks: 0, spilledLevels: 0 };

    return {
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
         * that no draw sampled since the look before lets its RGBA go and
         * hands its bytes to the store; what waits there of a texture no
         * longer alive is let go of.
         *
         * @param {Iterable<import('./objects.js').TextureObject>} all
         */
        look(all){
            counts.looks++;
            const alive = new Set(all);
            spill.forget(alive);
            const nextSeen = new WeakSet();
            for (const texture of alive)
            {
                for (const level of texture.levels?.values() ?? [])
                {
                    nextSeen.add(level);
                    if (drawn.has(level) || !seen.has(level))
                    {
                        continue;
                    }
                    forgetRgba?.(level);
                    if (spill.spill(texture, level) > 0)
                    {
                        counts.spilledLevels++;
                    }
                }
            }
            seen = nextSeen;
            drawn = new WeakSet();
        },

        /** @param {object} level  whether any of its own bytes wait in the store */
        waits: (/** @type {object} */ level)=>spill.waits(level),

        figures: ()=>({ ...counts, spills: spill.figures(), store: store.figures() }),
    };
}
