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

/** The refresh rate a display reports when it is told none (`refreshOf`). */
export const REFRESH_HZ = 60;

/**
 * The rate the display reports: its own, `screen.refresh` -- what the person
 * says their display shows at most, the bottle's maxFps -- else REFRESH_HZ.
 * A program's vertical sync holds it to this rate, as a display of it would.
 *
 * @param {{ refresh?: number }} screen
 */
export const refreshOf = screen=>(screen.refresh !== undefined && screen.refresh > 0
    ? Math.round(screen.refresh) : REFRESH_HZ);

/**
 * The rates every size is listed at: the era's two and the display's own, none
 * faster than the display shows -- a display of 60 lists 60 alone. Without a
 * rate of its own, the era's two.
 *
 * @param {{ refresh?: number }} screen
 * @returns {number[]}
 */
export const refreshRatesOf = screen=>{
    const own = screen.refresh !== undefined && screen.refresh > 0 ? refreshOf(screen) : Infinity;
    return [...new Set([...REFRESH_RATES, ...(own === Infinity ? [] : [own])])]
        .filter(rate=>rate <= own)
        .sort((a, b)=>a - b);
};

/**
 * The rates every size is listed at. A program that saved a rate the display
 * it was configured on ran at looks for a mode with exactly that rate and,
 * finding none, falls back to a list of its own; the two rates of the era's
 * displays are both here so either setting finds its mode.
 */
export const REFRESH_RATES = Object.freeze([REFRESH_HZ, 120]);

/**
 * A handful of sizes, not a catalogue: the 4:3 and 5:4 ladder a driver of the
 * era lists, which a program of the era filters its menu down to (one that
 * keeps only 4:3 sizes found three here while this held only three), the
 * widescreen standards, the sizes the laptops of today present themselves
 * at -- both the scaled size a person sees and the native one behind it,
 * since a page can be either -- and the display's own size added below.
 *
 * @type {readonly (readonly [number, number])[]}
 */
const SIZES = Object.freeze([
    [640, 480], [800, 600], [1024, 768], [1152, 864], [1280, 720], [1280, 800], [1280, 832],
    [1280, 960], [1280, 1024], [1400, 1050], [1440, 900], [1512, 982], [1600, 900],
    [1600, 1200], [1680, 1050], [1728, 1117], [1920, 1080], [1920, 1200], [1920, 1440],
    [2048, 1536], [2560, 1440], [2560, 1600], [2560, 1664], [2880, 1800], [3024, 1964],
    [3456, 2234],
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
 *           displayWidth?: number, displayHeight?: number, refresh?: number }} screen
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
    return sizes.flatMap(({ width, height })=>refreshRatesOf(screen).map(refresh=>({
        width, height, bitsPerPixel: screen.bitsPerPixel, refresh,
    })));
}
