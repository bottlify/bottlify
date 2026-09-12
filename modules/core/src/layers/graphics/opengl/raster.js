/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The colour and depth buffers, and everything that writes a fragment to them.
 *
 * This runs on the processor rather than on the GPU, for the same reason
 * `webgpu/internal/reference.js` does: a picture off a real device is not
 * reproducible -- drivers differ in their rasterisation rules and their
 * rounding -- so a stored image can only ever be compared against arithmetic
 * that is written down. What is written down here is the fill rule, the
 * interpolation and the per-fragment operations, and the byte-exact tests
 * compare against exactly this.
 *
 * Pixels are the engine's own: 32-bit BGRX, so the byte at the lowest address
 * is blue. `graphics/gdi` and the reference formula both say the same thing,
 * and two conventions in one engine is a bug generator.
 *
 * Three rules decide whether a triangle is right or merely plausible:
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
 * - **Attributes are interpolated in the perspective the vertices were
 *   projected with.** Each vertex carries its reciprocal clip w; an attribute
 *   is interpolated as `a / w` and divided back by the interpolated `1 / w`.
 *   A texture on a floor seen at an angle swims otherwise. Depth is the one
 *   exception: window z is linear in screen space by construction.
 *
 * Lines and points are drawn with rules of their own. A line covers the
 * pixel under each centre it crosses along its major axis, from its first
 * endpoint up to but not including its last, which is the half-open rule the
 * specification's diamond-exit test amounts to on an axis-aligned segment. A
 * point covers the square of its size around its centre.
 *
 * ponytail: the depth buffer is a float per pixel rather than the 16 or 24
 * bits a format promises. Nothing reads it back at that precision except
 * glReadPixels, which quantises on the way out.
 */

/** Bytes per pixel, everywhere in this engine. */
const BPP = 4;

/**
 * @typedef {Object} Framebuffer
 * @property {number} width
 * @property {number} height
 * @property {Uint8Array} bytes  BGRX, `width * 4` bytes to a row, row zero at the top.
 * @property {Float32Array | null} depth  window z per pixel, or none when the
 *           format has no depth buffer -- and then the depth test never runs.
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
 * @property {number} z  window depth, 0..1
 * @property {number} w  the reciprocal of clip w, for perspective correction
 * @property {readonly number[]} colour  r, g, b, a, each 0..255
 * @property {readonly number[]} [attributes]  whatever else is interpolated,
 *           in an order only the caller knows
 */

/**
 * What arrives at the per-fragment operations: a position, a depth, and the
 * interpolated colour and attributes.
 *
 * @typedef {Object} Fragment
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {number[]} colour  r, g, b, a, each 0..255, not yet rounded
 * @property {number[]} attributes
 */

/**
 * @typedef {Object} FragmentOperations
 * @property {(func: number, incoming: number, stored: number) => boolean} [depthTest]
 *           Absent when the depth test is off.
 * @property {number} [depthFunc]
 * @property {boolean} depthWrite
 * @property {((source: number[], destination: number[]) => number[]) | null} blend
 *           Absent when blending is off. Both colours are 0..255.
 * @property {((source: number, destination: number) => number) | null} logicOp
 *           Applied per channel byte when on; takes precedence over blending.
 * @property {readonly boolean[]} colourMask  r, g, b, a
 */

/**
 * @param {number} width
 * @param {number} height
 * @param {{ depth?: boolean }} [options]
 * @returns {Framebuffer}
 */
export function createFramebuffer(width, height, options = {}){
    const pixels = Math.max(0, width) * Math.max(0, height);
    return {
        width,
        height,
        bytes: new Uint8Array(pixels * BPP),
        depth: options.depth ? new Float32Array(pixels).fill(1) : null,
    };
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

/** @param {number} value @returns {number} the nearest byte */
function roundByte(value){
    const rounded = Math.round(value);
    return rounded < 0 ? 0 : rounded > 255 ? 255 : rounded;
}

/**
 * @param {Framebuffer} target
 * @param {readonly number[]} colour  r, g, b, a, each 0..255
 * @param {Box} box
 * @param {readonly boolean[]} [mask]  which channels the clear may touch
 */
export function fillBox(target, colour, box, mask = [true, true, true, true]){
    const [r, g, b, a] = colour;
    const clipped = clipBox(box, target);
    for (let y = clipped.y0; y < clipped.y1; y++)
    {
        for (let x = clipped.x0; x < clipped.x1; x++)
        {
            const at = (y * target.width + x) * BPP;
            if (mask[2])
            {
                target.bytes[at] = b;
            }
            if (mask[1])
            {
                target.bytes[at + 1] = g;
            }
            if (mask[0])
            {
                target.bytes[at + 2] = r;
            }
            if (mask[3])
            {
                target.bytes[at + 3] = a;
            }
        }
    }
}

/**
 * @param {Framebuffer} target
 * @param {number} depth  0..1
 * @param {Box} box
 */
export function fillDepth(target, depth, box){
    if (!target.depth)
    {
        return;
    }
    const clipped = clipBox(box, target);
    for (let y = clipped.y0; y < clipped.y1; y++)
    {
        target.depth.fill(depth, y * target.width + clipped.x0, y * target.width + clipped.x1);
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
 * Interpolates the colour and attributes of a fragment from three weighted
 * vertices, perspective-correctly.
 *
 * @param {readonly RasterVertex[]} vertices
 * @param {readonly number[]} weights  one per vertex, summing to the area
 * @returns {{ colour: number[], attributes: number[] }}
 */
function interpolate(vertices, weights){
    let invW = 0;
    for (let i = 0; i < vertices.length; i++)
    {
        invW += weights[i] * vertices[i].w;
    }
    const colour = [0, 0, 0, 0];
    const count = vertices[0].attributes?.length ?? 0;
    const attributes = new Array(count).fill(0);
    for (let i = 0; i < vertices.length; i++)
    {
        const scale = weights[i] * vertices[i].w / invW;
        const vertex = vertices[i];
        for (let channel = 0; channel < 4; channel++)
        {
            colour[channel] += vertex.colour[channel] * scale;
        }
        const from = vertex.attributes;
        if (from)
        {
            for (let k = 0; k < count; k++)
            {
                attributes[k] += from[k] * scale;
            }
        }
    }
    return { colour, attributes };
}

/**
 * Rasterises a triangle and hands every covered pixel to `emit`, which is
 * where the fragment operations live.
 *
 * @param {Framebuffer} target
 * @param {readonly RasterVertex[]} triangle
 * @param {Box} box  what the scissor and the viewport leave
 * @param {(fragment: Fragment) => void} emit
 */
export function rasterTriangle(target, triangle, box, emit){
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
    const vertices = [a, b, c];

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
            const z = (wa * a.z + wb * b.z + wc * c.z) / doubled;
            const { colour, attributes } = interpolate(vertices, [wa, wb, wc]);
            emit({ x, y, z, colour, attributes });
        }
    }
}

/**
 * Rasterises a line segment. See the half-open major-axis rule in the header.
 *
 * @param {Framebuffer} target
 * @param {RasterVertex} from
 * @param {RasterVertex} to
 * @param {Box} box
 * @param {(fragment: Fragment) => void} emit
 */
export function rasterLine(target, from, to, box, emit){
    const allowed = clipBox(box, target);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const alongX = Math.abs(dx) >= Math.abs(dy);
    const length = alongX ? dx : dy;
    if (length === 0)
    {
        return;
    }
    const start = alongX ? from.x : from.y;
    const end = alongX ? to.x : to.y;
    const step = length > 0 ? 1 : -1;
    // The first pixel whose centre lies on the segment, walking towards the
    // far end; the far end's own centre is excluded.
    let major = length > 0 ? Math.ceil(start - 0.5) : Math.floor(start - 0.5);
    for (; length > 0 ? major + 0.5 < end : major + 0.5 > end; major += step)
    {
        const centre = major + 0.5;
        if (length > 0 ? centre < start : centre > start)
        {
            continue;
        }
        const t = (centre - start) / length;
        const minor = alongX ? from.y + dy * t : from.x + dx * t;
        const x = alongX ? major : Math.floor(minor);
        const y = alongX ? Math.floor(minor) : major;
        if (x < allowed.x0 || x >= allowed.x1 || y < allowed.y0 || y >= allowed.y1)
        {
            continue;
        }
        const z = from.z + (to.z - from.z) * t;
        const { colour, attributes } = interpolate([from, to], [1 - t, t]);
        emit({ x, y, z, colour, attributes });
    }
}

/**
 * Rasterises a point of the given size, as the square around its centre.
 *
 * @param {Framebuffer} target
 * @param {RasterVertex} vertex
 * @param {number} size  in pixels, already rounded to a whole number
 * @param {Box} box
 * @param {(fragment: Fragment) => void} emit
 */
export function rasterPoint(target, vertex, size, box, emit){
    const allowed = clipBox(box, target);
    const half = Math.max(1, size) / 2;
    const x0 = Math.ceil(vertex.x - half - 0.5);
    const x1 = Math.ceil(vertex.x + half - 0.5);
    const y0 = Math.ceil(vertex.y - half - 0.5);
    const y1 = Math.ceil(vertex.y + half - 0.5);
    const colour = [...vertex.colour];
    const attributes = [...(vertex.attributes ?? [])];
    for (let y = Math.max(y0, allowed.y0); y < Math.min(y1, allowed.y1); y++)
    {
        for (let x = Math.max(x0, allowed.x0); x < Math.min(x1, allowed.x1); x++)
        {
            emit({ x, y, z: vertex.z, colour: [...colour], attributes: [...attributes] });
        }
    }
}

/**
 * The per-fragment operations, in the specification's order: depth test,
 * then blending or the logic op, then the write mask. Whatever precedes the
 * depth test -- texturing, fog, the alpha test, the scissor -- has already
 * happened by the time a colour reaches here, or the fragment was dropped.
 *
 * @param {Framebuffer} target
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {readonly number[]} colour  r, g, b, a, 0..255, not yet rounded
 * @param {FragmentOperations} operations
 */
export function writeFragment(target, x, y, z, colour, operations){
    const index = y * target.width + x;
    if (operations.depthTest && target.depth)
    {
        if (!operations.depthTest(operations.depthFunc ?? 0, z, target.depth[index]))
        {
            return;
        }
        if (operations.depthWrite)
        {
            target.depth[index] = z;
        }
    }
    const at = index * BPP;
    const stored = [
        target.bytes[at + 2], target.bytes[at + 1], target.bytes[at], target.bytes[at + 3],
    ];
    let result = [
        roundByte(colour[0]), roundByte(colour[1]), roundByte(colour[2]), roundByte(colour[3]),
    ];
    if (operations.logicOp)
    {
        const op = operations.logicOp;
        result = result.map((value, channel)=>op(value, stored[channel]) & 0xff);
    }
    else if (operations.blend)
    {
        result = operations.blend(result, stored).map(roundByte);
    }
    const mask = operations.colourMask;
    if (mask[0])
    {
        target.bytes[at + 2] = result[0];
    }
    if (mask[1])
    {
        target.bytes[at + 1] = result[1];
    }
    if (mask[2])
    {
        target.bytes[at] = result[2];
    }
    if (mask[3])
    {
        target.bytes[at + 3] = result[3];
    }
}

/**
 * A pixel's colour as r, g, b, a.
 *
 * @param {Framebuffer} target
 * @param {number} x
 * @param {number} y
 * @returns {number[]}
 */
export function readPixel(target, x, y){
    const at = (y * target.width + x) * BPP;
    return [target.bytes[at + 2], target.bytes[at + 1], target.bytes[at], target.bytes[at + 3]];
}
