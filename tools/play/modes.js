/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The engine's run modes by name, one table for the player
 * (`tools/play/index.html`, `?mode=` or `bottlifyMode()` in the console) and
 * the browser harness (`tools/cdp_test/game.mjs --mode`), so that a run on a
 * person's machine and one an agent makes are the same configuration when
 * they carry the same name.
 *
 * A mode is what `createApp` is given beyond the bottle: `cores` (`cpu.cores`),
 * the program's threads on that many executors at once, and `cork`, the
 * translator's settings (`EngineConfig`). `default` is the configuration every
 * program runs with when nobody chooses.
 */

/**
 * @typedef {Object} Mode
 * @property {string} what            One line on what the mode is for.
 * @property {number} [cores]
 * @property {Record<string, unknown>} [cork]
 */

/** @type {Record<string, Mode>} */
export const MODES = {
    default: { what: 'the cores the host allows, the translator as shipped: what every program'
        + ' runs with' },
    multi2: { what: 'two cores: threads ready together run at once', cores: 2 },
    multi: { what: 'three cores', cores: 3 },
    multi4: { what: 'four cores', cores: 4 },
    checked: { what: 'translated reads test their pages from the start, not from the first fault',
        cork: { checkReads: true } },
};

/**
 * The mode a name stands for.
 *
 * @param {string | null | undefined} name
 * @returns {Mode & { name: string }}
 */
export function modeOf(name){
    const key = name || 'default';
    const mode = MODES[key];
    if (!mode)
    {
        throw new Error(`no mode "${key}"; modes: ${Object.keys(MODES).join(', ')}`);
    }
    return { name: key, ...mode };
}
