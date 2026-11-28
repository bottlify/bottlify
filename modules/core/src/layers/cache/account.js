/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's account, Cellar's: the one budget every byte the run holds is
 * taken from, by kind, the run's cache's segments and the bundles' blocks
 * among them, made once by the run (`app.js`) and handed to every process.
 */

import { createAccountMemory } from '@bottlify/cellar';

const MIB = 1024 * 1024;

/**
 * The bytes of shared memory the run's cache holds bodies in, at most, unless
 * the run names its own (`AppOptions.cache.budget`): the reads it kept before,
 * 32 MiB for ranges read again and one range alone up to 128 MiB, fit.
 */
export const RUN_CACHE_BYTES = 160 * MIB;

/** The bundles' blocks' kind (`bundle/cache.js`). */
export const BLOCKS = 'blocks';

/**
 * The bytes of shared memory the bundles' fetched blocks are held hot in, at
 * most, all bundles of the run together (`bundle/cache.js`): what a start
 * reads before its first frame fits.
 */
export const BLOCK_CACHE_BYTES = 64 * MIB;

/**
 * The run's account (Cellar's): the machine's memory, `machineMemory` bytes
 * (none: no limit), and what it is held for, by kind - the guests' memories,
 * the engine's own parts, the translator's modules, the run's cache's
 * segments (at most `cacheBytes`) and the bundles' blocks (at most
 * `BLOCK_CACHE_BYTES`). Every process of the run is handed it and takes from
 * it on its own holder (`roadmap/decisions.md` A243).
 *
 * @param {{ machineMemory?: number, cacheBytes?: number, blocksBytes?: number }} [sizes]
 */
export function createRunAccount(sizes = {}){
    const { machineMemory, cacheBytes = RUN_CACHE_BYTES, blocksBytes = BLOCK_CACHE_BYTES } = sizes;
    const limit = machineMemory !== undefined && machineMemory > 0 ? machineMemory : Infinity;
    return createAccountMemory({ limit, kinds: { cache: cacheBytes, [BLOCKS]: blocksBytes,
        guest: Infinity, engine: Infinity, translation: Infinity } });
}
