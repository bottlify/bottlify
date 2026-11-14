/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One arm of the stand: a checkout's cork host and translator. The page loads
 * this file from the checkout as it is; `build.mjs` bundles it from each tree it
 * is given into `arm-<name>.js`, so a page can hold two versions of cork.
 */

export { createCorkHost } from '../../modules/core/src/layers/cpu/internal/cork-host.js';
export * as engine from '../../modules/cork/src/index.js';
