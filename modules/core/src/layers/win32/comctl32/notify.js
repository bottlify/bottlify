/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The window a common control tells what happened: the hWndParent it was
 * made with. For a child that is its parent; for a control made as an owned
 * window -- comctl32's tests make their controls so -- the window manager
 * keeps it as the owner, and the parent is none.
 *
 * @param {{ parent?: number, owner?: number }} record
 * @returns {number}  Zero for a control that has nobody to tell.
 */
export const notifyWindow = record=>(record.parent || record.owner || 0) >>> 0;
