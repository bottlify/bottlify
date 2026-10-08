/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GradientFill: rectangles shaded from one edge to the other, and triangles
 * shaded between their corners.
 *
 * A TRIVERTEX carries each channel in sixteen bits of which the high byte is
 * the colour, so the shading is worked out at sixteen bits and only the pixel
 * written is cut to eight -- interpolating the bytes would lose the steps a
 * long, shallow gradient takes between them. The alpha is a channel like the
 * others and lands in the byte a 32-bit surface keeps for it, where a later
 * AlphaBlend reads it.
 *
 * Both shapes follow the filling convention of every other figure here: a
 * rectangle covers `[left, right)` by `[top, bottom)`, and a triangle the
 * pixels whose centres are inside it, as a polygon does. The pixels are
 * written as they are; no binary raster operation applies.
 */

import { intersectRect, isEmptyRect } from './surface.js';

/** GradientFill's modes. */
export const GRADIENT_FILL_RECT_H = 0;
export const GRADIENT_FILL_RECT_V = 1;
export const GRADIENT_FILL_TRIANGLE = 2;

/**
 * A TRIVERTEX: a point, in the surface's coordinates, and its colour, each
 * channel sixteen bits.
 *
 * @typedef {Object} Vertex
 * @property {number} x
 * @property {number} y
 * @property {number} red
 * @property {number} green
 * @property {number} blue
 * @property {number} alpha
 */

/** The channels, in the order of the bytes they become, lowest first. */
const CHANNELS = /** @type {const} */ (['blue', 'green', 'red', 'alpha']);

/**
 * A pixel from four sixteen-bit channels: the high byte of each.
 *
 * @param {(channel: 'blue' | 'green' | 'red' | 'alpha') => number} valueOf
 * @returns {number}
 */
function pixelOf(valueOf){
    let pixel = 0;
    for (let index = 0; index < CHANNELS.length; index++)
    {
        pixel |= ((valueOf(CHANNELS[index]) >>> 8) & 0xff) << (index * 8);
    }
    return pixel >>> 0;
}

/**
 * A rectangle between two vertices, its colour running from the one nearer
 * the left edge to the other (or, vertically, from the top edge down): the
 * near edge is that vertex's colour exactly, and every pixel after it a step
 * closer to the far one's.
 *
 * @param {import("./shapes.js").Painter} painter
 * @param {Vertex} first @param {Vertex} second
 * @param {boolean} vertical
 */
export function gradientRect(painter, first, second, vertical){
    const box = {
        left: Math.min(first.x, second.x),
        top: Math.min(first.y, second.y),
        right: Math.max(first.x, second.x),
        bottom: Math.max(first.y, second.y),
    };
    const area = intersectRect(box, painter.clip);
    if (isEmptyRect(area))
    {
        return;
    }
    const [near, far] = (vertical ? first.y <= second.y : first.x <= second.x)
        ? [first, second]
        : [second, first];
    const start = vertical ? box.top : box.left;
    const span = vertical ? box.bottom - box.top : box.right - box.left;
    /** @param {number} at @returns {number} */
    const colorAt = at=>pixelOf(channel=>near[channel]
        + Math.trunc((far[channel] - near[channel]) * (at - start) / span));
    const along = vertical
        ? Array.from({ length: area.bottom - area.top }, (_, row)=>colorAt(area.top + row))
        : Array.from({ length: area.right - area.left }, (_, column)=>colorAt(area.left + column));
    for (let y = area.top; y < area.bottom; y++)
    {
        for (let x = area.left; x < area.right; x++)
        {
            painter.plot(x, y, vertical ? along[y - area.top] : along[x - area.left]);
        }
    }
}

/**
 * A triangle shaded between its corners: each pixel's colour is the corners'
 * weighted by how near the pixel is to each, so a pixel on a corner is that
 * corner's colour, kept within the corners' own range where a pixel on an
 * edge lies a fraction outside. A triangle with no area covers no pixel.
 *
 * @param {import("./shapes.js").Painter} painter
 * @param {Vertex} a @param {Vertex} b @param {Vertex} c
 */
export function gradientTriangle(painter, a, b, c){
    const determinant = (b.y - c.y) * (a.x - c.x) + (c.x - b.x) * (a.y - c.y);
    if (determinant === 0)
    {
        return;
    }
    const clip = painter.clip;
    const top = Math.max(clip.top, Math.min(a.y, b.y, c.y));
    const bottom = Math.min(clip.bottom, Math.max(a.y, b.y, c.y) + 1);
    const edges = [[a, b], [b, c], [c, a]];
    /** @param {'blue' | 'green' | 'red' | 'alpha'} channel */
    const range = channel=>[Math.min(a[channel], b[channel], c[channel]),
        Math.max(a[channel], b[channel], c[channel])];
    const limits = Object.fromEntries(CHANNELS.map(channel=>[channel, range(channel)]));
    for (let y = top; y < bottom; y++)
    {
        const sample = y + 0.5;
        /** @type {number[]} */
        const crossings = [];
        for (const [from, to] of edges)
        {
            if ((from.y <= sample) !== (to.y <= sample))
            {
                crossings.push(from.x + (sample - from.y) * (to.x - from.x) / (to.y - from.y));
            }
        }
        if (crossings.length < 2)
        {
            continue;
        }
        const left = Math.max(clip.left, Math.ceil(Math.min(...crossings) - 0.5));
        const right = Math.min(clip.right, Math.ceil(Math.max(...crossings) - 0.5));
        for (let x = left; x < right; x++)
        {
            const weightA = ((b.y - c.y) * (x - c.x) + (c.x - b.x) * (y - c.y)) / determinant;
            const weightB = ((c.y - a.y) * (x - c.x) + (a.x - c.x) * (y - c.y)) / determinant;
            const weightC = 1 - weightA - weightB;
            painter.plot(x, y, pixelOf(channel=>{
                const [low, high] = limits[channel];
                const value = Math.trunc(weightA * a[channel] + weightB * b[channel]
                    + weightC * c[channel]);
                return Math.min(high, Math.max(low, value));
            }));
        }
    }
}

/**
 * GradientFill over a mesh: each entry two vertex indices for a rectangle,
 * three for a triangle, all of them indices the caller has checked.
 *
 * @param {import("./shapes.js").Painter} painter
 * @param {Vertex[]} vertices
 * @param {number[][]} mesh
 * @param {number} mode
 */
export function gradientFill(painter, vertices, mesh, mode){
    for (const entry of mesh)
    {
        if (mode === GRADIENT_FILL_TRIANGLE)
        {
            gradientTriangle(painter, vertices[entry[0]], vertices[entry[1]], vertices[entry[2]]);
        }
        else
        {
            gradientRect(painter, vertices[entry[0]], vertices[entry[1]],
                mode === GRADIENT_FILL_RECT_V);
        }
    }
}
