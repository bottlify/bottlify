/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The common controls, as built-in classes.
 *
 * comctl32's controls are window procedures on this side exactly as user32's
 * are: a window of one of these classes has a procedure address, paints in the
 * system colours and tells its parent what happened. The difference is only
 * where they are registered -- user32's seven are a fixed table, these arrive
 * through the window manager's registration hook, because the library that
 * owns them is not the one that owns windows.
 *
 * Each is built from the same host and the same drawing helpers the system
 * classes use, so a progress bar and a button agree on what a sunken edge and
 * the highlight colour are.
 */

import { PROGRESS_CLASS, PROGRESS_ATOM, createProgressProcedure } from './progress.js';

/**
 * The classes, in the order a program is likeliest to meet them.
 *
 * @param {import('../user32/controls.js').ControlHost} host
 * @param {any} toolkit  The drawing helpers the system classes share.
 * @returns {{ name: string, procedure: any, atom: number,
 *     windowExtra?: number, background?: number }[]}
 */
export function createCommonControls(host, toolkit){
    return [
        {
            name: PROGRESS_CLASS,
            atom: PROGRESS_ATOM,
            procedure: createProgressProcedure(host, toolkit),
        },
    ];
}
