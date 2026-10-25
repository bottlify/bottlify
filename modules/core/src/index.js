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
// The page's speaker, opened inside the gesture that starts a run.
export { openSpeaker } from './host/speaker.js';
// The page's screen while a run plays: fullscreen in every browser's names, kept lit.
export { canFullscreen, exitFullscreen, fullscreenElement, keepScreenAwake, requestFullscreen,
    watchFullscreen } from './host/screen.js';
// For a consumer that wants a reader of its own over `app.log.memory()` -- a
// worker of its own, a view that polls at its own rate. The controller already
// holds one; this is for reading the same memory from somewhere else.
export { createLogReader } from './layers/log/reader.js';
