/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * comctl32's standard image strips - the standard, view and history
 * glyphs a toolbar names by IDB_ number, which are comctl32's own bitmap
 * resources - as their shapes: how many square images each holds and how
 * large they are. Their pixels are not in this build; whoever makes one
 * makes it blank at its size and says so once.
 */

/**
 * The strips by resource id: fifteen standard images, twelve view, five
 * history, small (16 pixels) and large (24). Wine's toolbar test
 * (test_add_bitmap) and rebar test (test_layout, an image list of resource
 * 121 24 pixels tall) see these sizes on Windows.
 */
export const STANDARD_STRIPS = Object.freeze({
    120: Object.freeze({ count: 15, side: 16 }),
    121: Object.freeze({ count: 15, side: 24 }),
    124: Object.freeze({ count: 12, side: 16 }),
    125: Object.freeze({ count: 12, side: 24 }),
    130: Object.freeze({ count: 5, side: 16 }),
    131: Object.freeze({ count: 5, side: 24 }),
});

/**
 * The strip a toolbar's IDB_ number names: IDB_STD_SMALL_COLOR (0) through
 * IDB_HIST_LARGE_COLOR (9), an odd number the large one; the numbers between
 * the named ones answer as their neighbours do (Wine's toolbar test).
 *
 * @param {number} id
 * @returns {{ count: number, side: number } | null}
 */
export function stripOfBitmapId(id){
    if ((id >>> 0) > 9)
    {
        return null;
    }
    const family = id < 4 ? 120 : id < 8 ? 124 : 130;
    return /** @type {Record<number, { count: number, side: number }>} */ (STANDARD_STRIPS)[
        family + (id & 1)];
}
