/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the published package exports.
 *
 * This exists only so that the two surfaces can be exported together without
 * either importing the other: `host/create.js` is built on `app.js`, which is
 * built on `core.js`, so `core.js` cannot name either back.
 */

export { createApp } from './host/create.js';
export { assembleModules } from './core.js';
