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
 * built on `core.js`, so `core.js` cannot name either back. Neither the
 * engine nor its layers load with this module: each is imported where it is
 * first needed, so a page that runs its program in a worker holds only the
 * side that talks to it.
 */

export { createApp } from './host/create.js';

/**
 * The engine's module graph, assembled (`core.js`), loaded when first asked
 * for: a page that only starts programs in a worker never loads the layers.
 *
 * @param {Record<string, unknown>} [config]
 * @returns {Promise<import('./system/contract.js').CoreInstance>}
 */
export async function assembleModules(config){
    const core = await import('./core.js');
    return core.assembleModules(config);
}
// The page's speaker, opened inside the gesture that starts a run.
export { openSpeaker } from './host/speaker.js';
// The page's screen while a run plays: fullscreen in every browser's names, kept lit.
export { canFullscreen, exitFullscreen, fullscreenElement, keepScreenAwake, requestFullscreen,
    watchFullscreen } from './host/screen.js';
// For a consumer that wants a reader of its own over `app.log.memory()` -- a
// worker of its own, a view that polls at its own rate. The controller already
// holds one; this is for reading the same memory from somewhere else.
export { createLogReader } from './layers/log/reader.js';
// A program's own icon, for a page to show it by (a tab's, a home screen's).
export { programIcon } from './layers/win32/shell32/icons.js';
