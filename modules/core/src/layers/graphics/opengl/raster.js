/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The colour buffer, and the two operations that write to it.
 *
 * This runs on the processor rather than on the GPU, for the same reason
 * `webgpu/internal/reference.js` does: a picture off a real device is not
 * reproducible -- drivers differ in their rasterisation rules and their
 * rounding -- so a stored image can only ever be compared against arithmetic
 * that is written down. What is written down here is the fill rule and the
 * interpolation, and the byte-exact tests compare against exactly this.
 *
 * Pixels are the engine's own: 32-bit BGRX, so the byte at the lowest address
 * is blue. `graphics/gdi` and the reference formula both say the same thing,
 * and two conventions in one engine is a bug generator.
 *
 * Two rules decide whether a triangle is right or merely plausible:
 *
 * - **A pixel belongs to a triangle when its centre does**, at `(x + 0.5,
 *   y + 0.5)`. Testing the corner instead shifts every edge half a pixel,
 *   which reads as a plausible picture and is wrong.
 * - **A pixel exactly on a shared edge belongs to one triangle, not both.**
 *   The top-left rule decides which: with the winding put clockwise in window
 *   coordinates -- y increasing downwards -- an edge is *top* when it is
 *   horizontal and runs left to right, and *left* when it runs upwards.
 *   Without this, two triangles sharing an edge blend twice along it and a
 *   seam appears exactly where the geometry says there is none.
 *
 * ponytail: no depth buffer, no blending, no texturing here -- a fragment
 * replaces what it lands on. Those belong with the state that drives them and
 * go in when the context can honour them.
 */

/** Bytes per pixel, everywhere in this engine. */
const BPP = 4;

/**
 * @typedef {Object} Framebuffer
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} bytes  BGRX, `width * 4` bytes to a row, row zero at the top.
 */

/**
 * @typedef {Object} Box
 * @property {number} x0
 * @property {number} y0
 * @property {number} x1  half-open, as everywhere else in this engine
 * @property {number} y1
 */

/**
 * @typedef {Object} RasterVertex
 * @property {number} x  window coordinates, y increasing downwards
 * @property {number} y
 * @property {readonly number[]} colour  r, g, b, a, each 0..255
 */

/**
 * @param {number} width
 * @param {number} height
 * @returns {Framebuffer}
 */
export function createFramebuffer(width, height){
    const pixels = Math.max(0, width) * Math.max(0, height);
    return { width, height, bytes: new Uint8Array(pixels * BPP) };
}

/**
 * The whole surface, as a box.
 *
 * @param {Framebuffer} target
 * @returns {Box}
 */
export function wholeOf(target){
    return { x0: 0, y0: 0, x1: target.width, y1: target.height };
}

/**
 * @param {Box} box
 * @param {Framebuffer} target
 * @returns {Box} the part of the box that is on the surface
 */
export function clipBox(box, target){
    return {
        x0: Math.max(0, Math.min(target.width, Math.floor(box.x0))),
        y0: Math.max(0, Math.min(target.height, Math.floor(box.y0))),
        x1: Math.max(0, Math.min(target.width, Math.ceil(box.x1))),
        y1: Math.max(0, Math.min(target.height, Math.ceil(box.y1))),
    };
}

/**
 * A colour component the way the framebuffer stores it. GL takes these
 * clamped to 0..1 and the buffer holds bytes, so the mapping is the full
 * range and the rounding is to nearest -- truncating loses a level on every
 * value that is not already exact.
 *
 * @param {number} value
 * @returns {number} 0..255
 */
export function toByte(value){
    const scaled = Math.round(value * 255);
    return scaled < 0 ? 0 : scaled > 255 ? 255 : scaled;
}

/**
 * @param {Framebuffer} target
 * @param {readonly number[]} colour  r, g, b, a, each 0..255
 * @param {Box} box
 */
export function fillBox(target, colour, box){
    const [r, g, b, a] = colour;
    const clipped = clipBox(box, target);
    for (let y = clipped.y0; y < clipped.y1; y++)
    {
        for (let x = clipped.x0; x < clipped.x1; x++)
        {
            const at = (y * target.width + x) * BPP;
            target.bytes[at] = b;
            target.bytes[at + 1] = g;
            target.bytes[at + 2] = r;
            target.bytes[at + 3] = a;
        }
    }
}

/**
 * Twice the signed area of the triangle `p, q, r`. Positive is clockwise in
 * window coordinates, where y grows downwards.
 *
 * @param {{ x: number, y: number }} p
 * @param {{ x: number, y: number }} q
 * @param {{ x: number, y: number }} r
 * @returns {number}
 */
function edge(p, q, r){
    return (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
}

/**
 * Whether a point exactly on this edge is inside. See the top-left rule in
 * the header; the winding is already clockwise by the time this is asked.
 *
 * @param {{ x: number, y: number }} p
 * @param {{ x: number, y: number }} q
 * @returns {boolean}
 */
function ownsItsEdge(p, q){
    const dy = q.y - p.y;
    return dy < 0 || (dy === 0 && q.x - p.x > 0);
}

/**
 * @param {Framebuffer} target
 * @param {readonly RasterVertex[]} triangle
 * @param {Box} box  what the scissor and the viewport leave
 */
export function fillTriangle(target, triangle, box){
    // A clockwise winding is what the fill rule is written against, so a
    // counter-clockwise one is reordered rather than special-cased -- two fill
    // rules would disagree along exactly the edges this one exists to settle.
    const area = edge(triangle[0], triangle[1], triangle[2]);
    if (area === 0)
    {
        return;
    }
    const [a, b, c] = area > 0 ? triangle : [triangle[0], triangle[2], triangle[1]];

    const extent = clipBox({
        x0: Math.min(a.x, b.x, c.x),
        y0: Math.min(a.y, b.y, c.y),
        x1: Math.max(a.x, b.x, c.x),
        y1: Math.max(a.y, b.y, c.y),
    }, target);
    const allowed = clipBox(box, target);
    const bounds = {
        x0: Math.max(extent.x0, allowed.x0),
        y0: Math.max(extent.y0, allowed.y0),
        x1: Math.min(extent.x1, allowed.x1),
        y1: Math.min(extent.y1, allowed.y1),
    };

    const doubled = Math.abs(area);
    const bcOwns = ownsItsEdge(b, c);
    const caOwns = ownsItsEdge(c, a);
    const abOwns = ownsItsEdge(a, b);

    for (let y = bounds.y0; y < bounds.y1; y++)
    {
        for (let x = bounds.x0; x < bounds.x1; x++)
        {
            const centre = { x: x + 0.5, y: y + 0.5 };
            const wa = edge(b, c, centre);
            const wb = edge(c, a, centre);
            const wc = edge(a, b, centre);
            if (wa < 0 || wb < 0 || wc < 0)
            {
                continue;
            }
            if ((wa === 0 && !bcOwns) || (wb === 0 && !caOwns) || (wc === 0 && !abOwns))
            {
                continue;
            }
            const at = (y * target.width + x) * BPP;
            for (let channel = 0; channel < 4; channel++)
            {
                const mixed = (wa * a.colour[channel] + wb * b.colour[channel]
                    + wc * c.colour[channel]) / doubled;
                const rounded = Math.round(mixed);
                // The framebuffer is BGRX and the colour is RGBA, so the two
                // colour channels that are not green trade places.
                target.bytes[at + (channel === 0 ? 2 : channel === 2 ? 0 : channel)]
                    = rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
            }
        }
    }
}
