/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Whether a Direct3D 8 or 9 present's picture is shown, decided per present.
 *
 * Windows 7's desktop window manager shows a windowed present's back buffer
 * in the window it presents into - Present's override, else the swap chain's
 * own window, which for a device's own chain is the device's - and a hidden
 * window shows nothing; a full-screen device owns the screen. So a program
 * may make its device on a hidden helper window and show every frame through
 * a chain into its visible one, and a device's window says nothing about
 * where its pictures are seen.
 *
 * The screen holds one GPU picture a process, whole: pictures presented into
 * two shown windows take it in turn rather than each filling its own window,
 * which is said. The window the last picture shown went into is remembered:
 * what the screen shows there is that picture, not the window's own surface,
 * which GDI never drew it into (`presentedWindow`, graphics/module.js).
 *
 * @param {{ api: string, windowShown?: (window: number) => boolean,
 *     divergence?: (api: string, detail: string) => void,
 *     shownIn?: (window: number, fullscreen: boolean) => void }} deps
 *     `windowShown` whether a window and every ancestor of it is shown, false
 *     for a handle that names none; absent where nothing keeps windows (a test
 *     of a device alone), and then every present is shown. `shownIn` hears each
 *     picture shown, with its window: the seam's one record across the APIs.
 * @returns {((window: number, fullscreen: boolean) => boolean)
 *     & { last: () => ({ window: number, fullscreen: boolean } | null) }}
 */
export function createPresentWindows({ api, windowShown, divergence, shownIn }){
    /** The window the last picture shown went into. */
    let last = 0;
    /** @type {{ window: number, fullscreen: boolean } | null} */
    let lastShown = null;
    /** @param {number} window @param {boolean} fullscreen */
    const decide = (window, fullscreen)=>{
        const into = window >>> 0;
        const shown = fullscreen || !windowShown || windowShown(into);
        if (!shown)
        {
            return false;
        }
        if (!fullscreen && last !== 0 && last !== into && windowShown?.(last))
        {
            divergence?.(api, 'pictures presented into two shown windows take the screen in'
                + ' turn, each whole, not each in its own window');
        }
        last = into;
        lastShown = { window: into, fullscreen };
        shownIn?.(into, fullscreen);
        return true;
    };
    return Object.assign(decide, { last: ()=>lastShown });
}
