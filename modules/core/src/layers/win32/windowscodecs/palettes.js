/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WIC's palettes: the predefined ones (WICBitmapPaletteType) and one made of
 * an image's own colours. A colour is a WICColor, 0xAARRGGBB.
 *
 * The predefined palettes are as Wine's palette test records Windows giving
 * them: the halftone cubes in blue-fastest order, the eight Windows system
 * colours after the cubes that leave room for them, and a transparent entry
 * appended when asked for (the last one replaced where a palette already has
 * 256). The black-and-white and grey palettes take no transparent entry.
 */

/** WICBitmapPaletteType. */
export const PALETTE_TYPE = Object.freeze({ CUSTOM: 0, MEDIAN_CUT: 1, FIXED_BW: 2,
    FIXED_HALFTONE8: 3, FIXED_HALFTONE27: 4, FIXED_HALFTONE64: 5, FIXED_HALFTONE125: 6,
    FIXED_HALFTONE216: 7, FIXED_HALFTONE252: 8, FIXED_HALFTONE256: 9, FIXED_GRAY4: 10,
    FIXED_GRAY16: 11, FIXED_GRAY256: 12 });

/** The eight colours after a halftone cube that leaves room for them. */
const SYSTEM_EIGHT = [0xc0c0c0, 0x808080, 0x800000, 0x008000, 0x000080, 0x808000, 0x800080,
    0x008080];

/**
 * A cube of blue, green and red levels, blue fastest.
 *
 * @param {number[]} blue @param {number[]} green @param {number[]} red
 */
const cube = (blue, green, red)=>{
    /** @type {number[]} */
    const out = [];
    for (const r of red)
    {
        for (const g of green)
        {
            for (const b of blue)
            {
                out.push((0xff000000 | r << 16 | g << 8 | b) >>> 0);
            }
        }
    }
    return out;
};

/** @param {number[]} colours */
const opaque = colours=>colours.map(c=>(0xff000000 | c) >>> 0);

/**
 * A predefined palette's colours, or null for a type that names none.
 *
 * @param {number} type @param {boolean} addTransparent
 * @returns {number[] | null}
 */
export function predefinedPalette(type, addTransparent){
    /** @type {number[]} */
    let colours;
    switch (type)
    {
        case PALETTE_TYPE.FIXED_BW:
            return [0xff000000, 0xffffffff];
        case PALETTE_TYPE.FIXED_GRAY4:
            return [0, 0x55, 0xaa, 0xff].map(v=>(0xff000000 | v * 0x010101) >>> 0);
        case PALETTE_TYPE.FIXED_GRAY16:
            return Array.from({ length: 16 }, (_, i)=>(0xff000000 | i * 0x111111) >>> 0);
        case PALETTE_TYPE.FIXED_GRAY256:
            return Array.from({ length: 256 }, (_, i)=>(0xff000000 | i * 0x010101) >>> 0);
        case PALETTE_TYPE.FIXED_HALFTONE8:
            colours = [...Array.from({ length: 8 }, (_, i)=>(0xff000000 | (i & 4 ? 0xff0000 : 0)
                | (i & 2 ? 0xff00 : 0) | (i & 1 ? 0xff : 0)) >>> 0), ...opaque(SYSTEM_EIGHT)];
            break;
        case PALETTE_TYPE.FIXED_HALFTONE27:
            colours = [...cube([0, 0x80, 0xff], [0, 0x80, 0xff], [0, 0x80, 0xff]), 0xffc0c0c0];
            break;
        case PALETTE_TYPE.FIXED_HALFTONE64:
        {
            const levels = [0, 0x55, 0xaa, 0xff];
            colours = [...cube(levels, levels, levels), ...opaque(SYSTEM_EIGHT)];
            break;
        }
        case PALETTE_TYPE.FIXED_HALFTONE125:
        {
            const levels = [0, 0x40, 0x80, 0xbf, 0xff];
            colours = [...cube(levels, levels, levels), 0xffc0c0c0];
            break;
        }
        case PALETTE_TYPE.FIXED_HALFTONE216:
        {
            const levels = [0, 0x33, 0x66, 0x99, 0xcc, 0xff];
            colours = [...cube(levels, levels, levels), ...opaque(SYSTEM_EIGHT)];
            break;
        }
        case PALETTE_TYPE.FIXED_HALFTONE252:
        {
            const rb = [0, 0x33, 0x66, 0x99, 0xcc, 0xff];
            colours = cube(rb, [0, 0x2b, 0x55, 0x80, 0xaa, 0xd5, 0xff], rb);
            break;
        }
        case PALETTE_TYPE.FIXED_HALFTONE256:
        {
            const gr = [0, 0x24, 0x49, 0x6d, 0x92, 0xb6, 0xdb, 0xff];
            colours = cube([0, 0x55, 0xaa, 0xff], gr, gr);
            if (addTransparent)
            {
                colours[255] = 0;
            }
            return colours;
        }
        default:
            return null;
    }
    return addTransparent ? [...colours, 0] : colours;
}

/**
 * A palette of at most `count` colours for a set of BGRA texels, by median
 * cut: the box of colours with the widest channel split at its median until
 * there are `count` boxes, each box's colour its average. With `alpha`, one
 * entry is kept transparent for the texels whose alpha is under half.
 *
 * @param {Uint8Array} bgra @param {number} count @param {boolean} alpha
 * @returns {number[]}
 */
export function medianCut(bgra, count, alpha){
    /** @type {number[][]} */
    const texels = [];
    let transparent = false;
    for (let i = 0; i < bgra.length; i += 4)
    {
        if (alpha && bgra[i + 3] < 128)
        {
            transparent = true;
            continue;
        }
        texels.push([bgra[i + 2], bgra[i + 1], bgra[i]]);
    }
    const room = Math.max(1, count - (transparent ? 1 : 0));
    /** @type {number[][][]} */
    let boxes = texels.length ? [texels] : [];
    while (boxes.length < room)
    {
        let widest = -1;
        let channel = 0;
        let spread = 0;
        boxes.forEach((box, index)=>{
            if (box.length < 2)
            {
                return;
            }
            for (let c = 0; c < 3; c++)
            {
                const values = box.map(t=>t[c]);
                const range = Math.max(...values) - Math.min(...values);
                if (range > spread)
                {
                    spread = range;
                    widest = index;
                    channel = c;
                }
            }
        });
        if (widest < 0)
        {
            break;
        }
        const box = boxes[widest].slice().sort((p, q)=>p[channel] - q[channel]);
        const half = box.length >> 1;
        boxes = [...boxes.slice(0, widest), box.slice(0, half), box.slice(half),
            ...boxes.slice(widest + 1)];
    }
    const colours = boxes.map(box=>{
        const sum = box.reduce((s, t)=>[s[0] + t[0], s[1] + t[1], s[2] + t[2]], [0, 0, 0]);
        const [r, g, b] = sum.map(v=>Math.round(v / box.length));
        return (0xff000000 | r << 16 | g << 8 | b) >>> 0;
    });
    return transparent ? [...colours, 0] : colours;
}
