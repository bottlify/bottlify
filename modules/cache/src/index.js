/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * @bottlify/cache - one cache for every thread of a page: bodies in shared
 * memory read in place by name, one keeper thread placing them, a budget for
 * all of them, idle bodies on the disk (OPFS) and brought back on demand.
 */

export { openKeeper } from './keeper.js';
export { createReader } from './reader.js';

/** @typedef {import('./keeper.js').Keeper} Keeper */
/** @typedef {import('./keeper.js').KeeperOptions} KeeperOptions */
/** @typedef {import('./keeper.js').Disk} Disk */
/** @typedef {import('./keeper.js').DiskFile} DiskFile */
/** @typedef {import('./reader.js').Reader} Reader */
/** @typedef {import('./reader.js').KeeperCalls} KeeperCalls */
/** @typedef {import('./shared.js').SharedIndex} SharedIndex */
