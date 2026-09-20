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

/** The refresh rate the mode in effect reports. A browser presents at its own pace. */
export const REFRESH_HZ = 60;

/**
 * The rates every size is listed at. A program that saved a rate the display
 * it was configured on ran at looks for a mode with exactly that rate and,
 * finding none, falls back to a list of its own; the two rates of the era's
 * displays are both here so either setting finds its mode.
 */
export const REFRESH_RATES = Object.freeze([REFRESH_HZ, 120]);

/**
 * A handful of sizes, not a catalogue: the three every program of the era
 * assumes exist, the two widescreen standards, and the display's own size
 * added below. A long list is a menu nobody scrolls, and every size a person
 * would actually pick is here.
 *
 * @type {readonly (readonly [number, number])[]}
 */
const SIZES = Object.freeze([
    [640, 480], [800, 600], [1024, 768], [1280, 720], [1440, 900], [1600, 900], [1680, 1050],
    [1920, 1080], [1920, 1200], [2560, 1440], [2560, 1600],
]);

/**
 * @typedef {Object} DisplayMode
 * @property {number} width
 * @property {number} height
 * @property {number} bitsPerPixel
 * @property {number} refresh
 */

/**
 * Every mode the display offers at one colour depth, smallest first, each
 * size at each of `REFRESH_RATES`.
 *
 * Every size of the era, whatever the display's own: the picture is a
 * canvas the page scales, so a mode larger than the display is shown
 * smaller rather than refused, and a person on a small screen still gets
 * to pick the size the program looks best at. The display's own size and
 * the mode in effect are always among them even when they are not sizes of
 * the era, because a program that reads the current mode and then looks
 * for it in the list expects to find it.
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
    const sizes = SIZES.map(([width, height])=>({ width, height }));
    for (const size of [limit, screen])
    {
        if (!sizes.some(one=>one.width === size.width && one.height === size.height))
        {
            sizes.push({ width: size.width, height: size.height });
        }
    }
    sizes.sort((left, right)=>left.width - right.width || left.height - right.height);
    return sizes.flatMap(({ width, height })=>REFRESH_RATES.map(refresh=>({
        width, height, bitsPerPixel: screen.bitsPerPixel, refresh,
    })));
}
