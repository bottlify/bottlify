/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { expandTexels } from '../d3d8/render.js';

/**
 * Tells whoever shows the frame what a Direct3D device holds as its cursor:
 * the bitmap read out of the surface's own bytes, in the order they lie, and
 * the hot spot -- but only when any of it changed. A program sets its cursor
 * every frame or every time it shows it, and each telling is a read of the
 * surface, an expansion and a crossing of the port; the same picture told a
 * few thousand times a second is a load the taker cannot see through.
 *
 * @param {(cursor: { width: number, height: number, hotSpot: { x: number, y: number },
 *     bgra: Uint8Array, shown: boolean }) => void} cursor
 * @param {(address: number, length: number) => Uint8Array} readMemory
 * @returns {(device: { GetCursor: () => { surface: any, hotSpot: { x: number, y: number },
 *     shown: boolean } }) => void}
 */
export function createCursorTeller(cursor, readMemory){
    /** @type {{ base: number, x: number, y: number, shown: boolean, bytes: Uint8Array } | null} */
    let told = null;
    return device=>{
        const held = device.GetCursor();
        if (!held.surface)
        {
            return;
        }
        /** @type {{ desc?: any }} */
        const out = {};
        held.surface.GetDesc(out);
        const { Width: width, Height: height, Format: format } = out.desc;
        const bytes = readMemory(held.surface.base, width * height * 4);
        if (told && told.base === held.surface.base && told.x === held.hotSpot.x
            && told.y === held.hotSpot.y && told.shown === held.shown
            && sameBytes(told.bytes, bytes))
        {
            return;
        }
        told = { base: held.surface.base, x: held.hotSpot.x, y: held.hotSpot.y,
            shown: held.shown, bytes: bytes.slice() };
        cursor({
            width, height,
            hotSpot: { ...held.hotSpot },
            bgra: expandTexels(format, bytes, width * height),
            shown: held.shown,
        });
    };
}

/** @param {Uint8Array} a @param {Uint8Array} b */
function sameBytes(a, b){
    if (a.length !== b.length)
    {
        return false;
    }
    for (let i = 0; i < a.length; i++)
    {
        if (a[i] !== b[i])
        {
            return false;
        }
    }
    return true;
}
