/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The modes a display offers, for every path a program asks through.
 *
 * A program of this era reads the list once -- from user32, or from Direct3D's
 * adapter, or both -- and builds its own resolution menu out of it. Answering
 * with one mode gives it a menu with one entry and no way to ask for another,
 * which from the person's side reads as a game that cannot change resolution.
 * The list is therefore the one a real adapter reports: the sizes of the era
 * up to the display's own, because every one of them can actually be set --
 * the surface follows whatever size the program creates its device at.
 */

/** The refresh rate every mode reports. A browser presents at its own pace. */
export const REFRESH_HZ = 60;

/**
 * A handful of sizes, not a catalogue: the three every program of the era
 * assumes exist, the two widescreen standards, and the display's own size
 * added below. A long list is a menu nobody scrolls, and every size a person
 * would actually pick is here.
 *
 * @type {readonly (readonly [number, number])[]}
 */
const SIZES = Object.freeze([
    [640, 480], [800, 600], [1024, 768], [1280, 720], [1920, 1080],
]);

/**
 * @typedef {Object} DisplayMode
 * @property {number} width
 * @property {number} height
 * @property {number} bitsPerPixel
 * @property {number} refresh
 */

/**
 * Every mode the display offers at one colour depth, smallest first.
 *
 * Bounded by the display's own size, not by the mode in effect: a program
 * that has set a small mode is still on a large display, and a list bounded
 * by the mode it is in would offer it nothing else. The display's size is
 * always among them even when it is not a size of the era, because a program
 * that reads the current mode and then looks for it in the list expects to
 * find it.
 *
 * @param {{ width: number, height: number, bitsPerPixel: number,
 *           displayWidth?: number, displayHeight?: number }} screen
 *        The mode in effect, carrying the display's own size when that is
 *        larger -- a screen that names no display is its own display.
 * @returns {DisplayMode[]}
 */
export function displayModes(screen){
    const limit = { width: screen.displayWidth ?? screen.width,
        height: screen.displayHeight ?? screen.height };
    const modes = SIZES
        .filter(([width, height])=>width <= limit.width && height <= limit.height)
        .map(([width, height])=>({ width, height, bitsPerPixel: screen.bitsPerPixel,
            refresh: REFRESH_HZ }));
    for (const size of [limit, screen])
    {
        if (!modes.some(mode=>mode.width === size.width && mode.height === size.height))
        {
            modes.push({ width: size.width, height: size.height,
                bitsPerPixel: screen.bitsPerPixel, refresh: REFRESH_HZ });
        }
    }
    return modes.sort((left, right)=>left.width - right.width || left.height - right.height);
}
