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
import { TREEVIEW_CLASS, TREEVIEW_ATOM, createTreeViewProcedure } from './treeview.js';
import { TAB_CLASS, TAB_ATOM, createTabProcedure } from './tab.js';
import { TOOLBAR_CLASS, TOOLBAR_ATOM, createToolbarProcedure } from './toolbar.js';
import { STATUSBAR_CLASS, STATUSBAR_ATOM, createStatusBarProcedure } from './statusbar.js';
import { TRACKBAR_CLASS, TRACKBAR_ATOM, createTrackbarProcedure } from './trackbar.js';
import { UPDOWN_CLASS, UPDOWN_ATOM, createUpDownProcedure } from './updown.js';

/** The face colour's brush, as a class's background names it: the index plus one. */
const FACE_BACKGROUND = 15 + 1;

/**
 * The classes, in the order a program is likeliest to meet them.
 *
 * @param {import('../user32/controls.js').ControlHost} host
 * @param {any} toolkit  The drawing helpers the system classes share.
 * @param {import('./toolbar.js').ToolbarImages} [images]  The image lists a tab and a
 *     toolbar draw from.
 * @param {{ loadBitmap?: (instance: number, id: number) => number,
 *     subclassing?: import('./updown.js').Subclassing }} [resources]
 *     A module's bitmap resources, which a toolbar takes its images from, and
 *     comctl32's subclassing, which an up-down control hooks its buddy with.
 * @returns {{ name: string, procedure: any, atom: number,
 *     windowExtra?: number, background?: number }[]}
 */
export function createCommonControls(host, toolkit, images, resources){
    return [
        {
            name: PROGRESS_CLASS,
            atom: PROGRESS_ATOM,
            procedure: createProgressProcedure(host, toolkit),
        },
        {
            name: TREEVIEW_CLASS,
            atom: TREEVIEW_ATOM,
            procedure: createTreeViewProcedure(host, toolkit),
        },
        {
            name: TAB_CLASS,
            atom: TAB_ATOM,
            procedure: createTabProcedure(host, toolkit, images),
        },
        {
            name: TOOLBAR_CLASS,
            atom: TOOLBAR_ATOM,
            procedure: createToolbarProcedure(host, toolkit, images, resources),
            background: FACE_BACKGROUND,
        },
        {
            name: STATUSBAR_CLASS,
            atom: STATUSBAR_ATOM,
            procedure: createStatusBarProcedure(host, toolkit),
            background: FACE_BACKGROUND,
        },
        {
            name: TRACKBAR_CLASS,
            atom: TRACKBAR_ATOM,
            procedure: createTrackbarProcedure(host, toolkit),
        },
        {
            name: UPDOWN_CLASS,
            atom: UPDOWN_ATOM,
            procedure: createUpDownProcedure(host, toolkit, resources?.subclassing),
        },
    ];
}
