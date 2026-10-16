/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The cursor the page shows, of the two Windows keeps: the system's, from
 * user32's count and SetCursor, which a program holding the mouse exclusively
 * through DirectInput hides; and a Direct3D device's. A device that has set
 * its cursor (SetCursorProperties) owns the pointer from then on -- showing
 * it puts that cursor up, hiding it leaves none, as SetCursor(NULL) does
 * (Wine's wined3d_device_show_cursor) -- and an exclusive DirectInput mouse
 * does not touch it: a game that takes the mouse exclusively and shows its
 * cursor through the device has it on screen throughout.
 *
 * @param {any} system  What user32 last reported.
 * @param {any} device  What a device last reported, null before any did.
 * @param {boolean} mouseHeld  Whether DirectInput holds the mouse exclusively.
 * @returns {any}
 */
export function visibleCursor(system, device, mouseHeld){
    if (device)
    {
        return device;
    }
    return mouseHeld ? { ...system, shown: false } : system;
}
