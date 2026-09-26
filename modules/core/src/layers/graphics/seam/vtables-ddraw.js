/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The method order of the interfaces a DirectDraw object leads to beyond the
 * ones `vtables.js` lists: the gamma control a surface answers for.
 *
 * The rules are that file's: every slot is listed whether anything
 * implements it or not, in the header's order after IUnknown's three, and a
 * count is of arguments, not bytes -- `describe` adds `this`.
 */

/** IDirectDrawGammaControl: one ramp per surface, read and written whole. */
export const IDIRECTDRAWGAMMACONTROL_SLOTS = /** @type {[string, number][]} */ ([
    ['GetGammaRamp', 2],
    ['SetGammaRamp', 2],
]);
