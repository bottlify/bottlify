/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The libraries of Windows' own (`windows-libraries.js`) that came with a
 * Windows later than XP, by the first one that carries them in system32, as
 * learn.microsoft.com's "minimum supported client" of their functions has it:
 * on an earlier Windows a static import of one is a library found nowhere,
 * and the process does not start. Only those a game links against and the
 * engine does not provide on every Windows are listed; a library the engine
 * provides is the engine's to withhold (win32's per-version tables).
 *
 * @type {ReadonlyMap<string, readonly [number, number]>}  name -> [major, minor]
 */
export const LIBRARIES_SINCE = new Map([
    ['xaudio2_8.dll', [6, 2]],
    ['xinput1_4.dll', [6, 2]],
    ['dcomp.dll', [6, 2]],
    ['xaudio2_9.dll', [10, 0]],
    ['d3d12.dll', [10, 0]],
]);
