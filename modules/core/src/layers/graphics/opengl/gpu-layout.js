/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * From GL's vertex arrays and primitive modes to what a GPU draw takes.
 *
 * A GL draw names its arrays one pointer at a time, each with its own type,
 * size and stride, into client memory or a buffer object; a GPU draw takes
 * vertex buffer slots with a stride each and attributes at fixed offsets in
 * a fixed format. The two meet here, as pure functions of the pointers, so
 * the decision "can these arrays be handed to the GPU as they lie" is one a
 * test can ask without a device:
 *
 * - **An array whose type and size have no vertex format is not handed over.**
 *   A three-component short, a byte normal, a double: WebGPU delivers none of
 *   them, and the vertex is assembled on the processor instead into the one
 *   canonical layout below. Nothing is read as something else.
 * - **Pointers into one buffer at one stride share a slot** when every one of
 *   them fits inside the stride from the slot's base: one interleaved vertex
 *   is one slot with several attributes, which is what the buffer holds.
 * - **A primitive mode WebGPU has no topology for becomes a list.** Quads,
 *   fans, polygons, strips and loops are expanded into triangle- or
 *   line-list indices; a strip is not handed over as a strip because a strip
 *   pipeline is a second pipeline per state for no saving worth having.
 * - **Indices are widened to a format the GPU takes** and scanned for their
 *   range on the way, because a client-memory array is copied by the range
 *   the indices reach and not by whatever the program allocated.
 */

import { GL } from './constants.js';
import { componentBytes, effectiveStride } from './arrays.js';

/** WebGPU allows this many vertex buffer slots. */
export const MAX_SLOTS = 8;

/**
 * The attribute names a draw can carry, in the order the canonical layout
 * packs the named ones, then the generic vertex attributes a program reads
 * that alias to no named array (`attribN`, by their generic index). The
 * aliasing table's coordinate sets run to the seventh, so generic attributes
 * 12 to 15 arrive as texCoord4 to texCoord7 and never as names of their own.
 */
export const ATTRIBUTE_NAMES = Object.freeze([
    'position', 'color', 'secondary', 'normal', 'fogCoord',
    'texCoord0', 'texCoord1', 'texCoord2', 'texCoord3',
    'texCoord4', 'texCoord5', 'texCoord6', 'texCoord7',
    'attrib1', 'attrib6', 'attrib7',
]);

/**
 * @typedef {Object} VertexFormat
 * @property {string} format          the WebGPU vertex format
 * @property {number} components
 * @property {'f32' | 'i32' | 'u32'} scalar   what the shader reads
 * @property {number} bytes
 */

/**
 * @typedef {Object} DrawAttribute
 * @property {string} name        one of ATTRIBUTE_NAMES
 * @property {number} slot
 * @property {number} offset      within the slot's vertex
 * @property {string} format
 * @property {number} components
 * @property {'f32' | 'i32' | 'u32'} scalar
 */

/**
 * @typedef {Object} DrawSlot
 * @property {number} buffer      the buffer object's name, or zero for client memory
 * @property {number} base        address or buffer offset of vertex zero
 * @property {number} stride
 * @property {number} divisor     zero for a vertex's step; n for one element every n
 *           instances (glVertexAttribDivisor)
 * @property {boolean} [constant]  a binding point's stride of zero (4.3): one
 *           element for every vertex and instance, read as a per-instance slot
 *           whose every instance takes element zero
 */

/**
 * The divisor a constant slot carries: past any instance count, so that the
 * slot is read by instance and never steps.
 */
const CONSTANT_DIVISOR = 0xffffffff;

/**
 * @typedef {Object} DrawLayout
 * @property {DrawSlot[]} slots
 * @property {DrawAttribute[]} attributes
 */

/**
 * The vertex format an array's type and size become, or null when WebGPU
 * has none. Normalised integer arrays (colours, normals) become unorm/snorm
 * formats; the rest are read as the integers they are, and the shader
 * converts.
 *
 * @param {number} type
 * @param {number} size
 * @param {boolean} normalised
 * @returns {VertexFormat | null}
 */
export function vertexFormatOf(type, size, normalised){
    // Asked for every array of every draw, and a handful of answers covers
    // every program: each is made once, and never changed by whoever reads it.
    const key = type * 64 + size * 2 + (normalised ? 1 : 0);
    let known = VERTEX_FORMATS.get(key);
    if (known === undefined)
    {
        known = makeVertexFormat(type, size, normalised);
        VERTEX_FORMATS.set(key, known);
    }
    return known;
}

/** @type {Map<number, VertexFormat | null>} */
const VERTEX_FORMATS = new Map();

/**
 * @param {number} type
 * @param {number} size
 * @param {boolean} normalised
 * @returns {VertexFormat | null}
 */
function makeVertexFormat(type, size, normalised){
    const bytes = componentBytes(type) * size;
    switch (type)
    {
        // The one packed format WebGPU reads: unsigned and normalised, all four.
        case GL.UNSIGNED_INT_2_10_10_10_REV:
            return normalised && size === 4
                ? { format: 'unorm10-10-10-2', components: 4, scalar: 'f32', bytes: 4 }
                : null;
        case GL.FLOAT:
            return { format: size === 1 ? 'float32' : `float32x${size}`,
                components: size, scalar: 'f32', bytes };
        case GL.INT:
            return { format: size === 1 ? 'sint32' : `sint32x${size}`,
                components: size, scalar: 'i32', bytes };
        case GL.UNSIGNED_INT:
            return { format: size === 1 ? 'uint32' : `uint32x${size}`,
                components: size, scalar: 'u32', bytes };
        case GL.SHORT:
            return size === 2 || size === 4
                ? { format: `${normalised ? 'snorm' : 'sint'}16x${size}`,
                    components: size, scalar: normalised ? 'f32' : 'i32', bytes }
                : null;
        case GL.UNSIGNED_SHORT:
            return size === 2 || size === 4
                ? { format: `${normalised ? 'unorm' : 'uint'}16x${size}`,
                    components: size, scalar: normalised ? 'f32' : 'u32', bytes }
                : null;
        case GL.UNSIGNED_BYTE:
            return size === 2 || size === 4
                ? { format: `${normalised ? 'unorm' : 'uint'}8x${size}`,
                    components: size, scalar: normalised ? 'f32' : 'u32', bytes }
                : null;
        case GL.BYTE:
            return size === 2 || size === 4
                ? { format: `${normalised ? 'snorm' : 'sint'}8x${size}`,
                    components: size, scalar: normalised ? 'f32' : 'i32', bytes }
                : null;
        default:
            return null;
    }
}

/**
 * Three byte or short components -- a normal of GL_BYTE or GL_SHORT, a colour
 * of three GL_UNSIGNED_BYTE -- which no vertex format holds, read as the four
 * of the next format up with the shader taking the first three. Only from
 * client memory, which is copied a whole stride a vertex, so the fourth
 * component read is inside what was copied; the layout's own check that the
 * format fits the stride holds the rest. A buffer object's size is not known
 * here, and its last vertex could end before the fourth component.
 *
 * @param {import('./arrays.js').ArrayPointer} pointer
 * @param {boolean} normalised
 * @returns {VertexFormat | null}
 */
function widenedTriple(pointer, normalised){
    if (pointer.size !== 3 || pointer.buffer !== 0)
    {
        return null;
    }
    const four = vertexFormatOf(pointer.type, 4, normalised);
    return four && four.bytes <= 8 ? { ...four, components: 3 } : null;
}

/**
 * @typedef {Object} ArrayRequest
 * @property {string} name
 * @property {import('./arrays.js').ArrayPointer} pointer
 * @property {boolean} normalised
 * @property {number} [divisor]  glVertexAttribDivisor's, zero or absent per vertex
 */

/**
 * The slots and attributes a set of enabled arrays becomes, as they lie, or
 * null when one of them cannot be handed to the GPU in place.
 *
 * @param {readonly ArrayRequest[]} arrays
 * @returns {DrawLayout | null}
 */
export function planLayout(arrays){
    /** @type {DrawSlot[]} */
    const slots = [];
    /** @type {DrawAttribute[]} */
    const attributes = [];
    for (const array of arrays)
    {
        const pointer = array.pointer;
        const format = vertexFormatOf(pointer.type, pointer.size, array.normalised)
            ?? widenedTriple(pointer, array.normalised);
        if (!format)
        {
            return null;
        }
        // A stride of zero (a binding point's, 4.3) is one element for every
        // vertex: its slot is a per-instance one wide enough for the element,
        // whose every instance reads element zero (`instanceElements`).
        const constant = effectiveStride(pointer) === 0;
        const stride = constant ? Math.ceil(((pointer.pointer % 4) + format.bytes) / 4) * 4
            : effectiveStride(pointer);
        const divisor = constant ? CONSTANT_DIVISOR : array.divisor ?? pointer.divisor ?? 0;
        if (stride % 4 !== 0 || stride > 2048)
        {
            return null;
        }
        // An attribute's offset must be a multiple of the smaller of four and
        // its own size, and a slot's base a multiple of four; a slot is
        // opened at the pointer rounded down so that the attribute's own
        // offset takes up the remainder.
        const align = Math.min(4, format.bytes);
        let slot = -1;
        for (let index = 0; index < slots.length; index++)
        {
            const candidate = slots[index];
            if (!constant && !candidate.constant
                && candidate.buffer === pointer.buffer && candidate.stride === stride
                && candidate.divisor === divisor
                && pointer.pointer >= candidate.base
                && pointer.pointer - candidate.base + format.bytes <= stride
                && (pointer.pointer - candidate.base) % align === 0)
            {
                slot = index;
                break;
            }
        }
        if (slot < 0)
        {
            if (slots.length === MAX_SLOTS)
            {
                return null;
            }
            const base = pointer.pointer - (pointer.pointer % 4);
            if (pointer.pointer - base + format.bytes > stride
                || (pointer.pointer - base) % align !== 0)
            {
                return null;
            }
            slot = slots.push(constant ? { buffer: pointer.buffer, base, stride, divisor, constant }
                : { buffer: pointer.buffer, base, stride, divisor }) - 1;
        }
        attributes.push({
            name: array.name,
            slot,
            offset: pointer.pointer - slots[slot].base,
            format: format.format,
            components: format.components,
            scalar: format.scalar,
        });
    }
    return { slots, attributes };
}

/**
 * One vertex of the canonical layout: what a vertex assembled on the
 * processor is packed as. Every attribute is present, in floats.
 */
export const CANONICAL_STRIDE = 4 * (4 + 4 + 4 + 3 + 1 + 4 * 8);

/** @type {DrawLayout} */
export const CANONICAL_LAYOUT = Object.freeze({
    slots: [{ buffer: 0, base: 0, stride: CANONICAL_STRIDE, divisor: 0 }],
    attributes: [
        { name: 'position', slot: 0, offset: 0, format: 'float32x4', components: 4, scalar: 'f32' },
        { name: 'color', slot: 0, offset: 16, format: 'float32x4', components: 4, scalar: 'f32' },
        { name: 'secondary', slot: 0, offset: 32, format: 'float32x4', components: 4,
            scalar: 'f32' },
        { name: 'normal', slot: 0, offset: 48, format: 'float32x3', components: 3, scalar: 'f32' },
        { name: 'fogCoord', slot: 0, offset: 60, format: 'float32', components: 1, scalar: 'f32' },
        { name: 'texCoord0', slot: 0, offset: 64, format: 'float32x4', components: 4,
            scalar: 'f32' },
        { name: 'texCoord1', slot: 0, offset: 80, format: 'float32x4', components: 4,
            scalar: 'f32' },
        { name: 'texCoord2', slot: 0, offset: 96, format: 'float32x4', components: 4,
            scalar: 'f32' },
        { name: 'texCoord3', slot: 0, offset: 112, format: 'float32x4', components: 4,
            scalar: 'f32' },
        { name: 'texCoord4', slot: 0, offset: 128, format: 'float32x4', components: 4,
            scalar: 'f32' },
        { name: 'texCoord5', slot: 0, offset: 144, format: 'float32x4', components: 4,
            scalar: 'f32' },
        { name: 'texCoord6', slot: 0, offset: 160, format: 'float32x4', components: 4,
            scalar: 'f32' },
        { name: 'texCoord7', slot: 0, offset: 176, format: 'float32x4', components: 4,
            scalar: 'f32' },
    ],
});

/**
 * Packs vertices assembled on the processor into the canonical layout.
 *
 * @param {readonly import('./pipeline.js').PipelineVertex[]} vertices
 * @returns {Float32Array}
 */
export function packVertices(vertices){
    const floats = CANONICAL_STRIDE / 4;
    const out = new Float32Array(vertices.length * floats);
    let at = 0;
    for (const vertex of vertices)
    {
        const p = vertex.position;
        out[at] = p[0];
        out[at + 1] = p[1];
        out[at + 2] = p[2] ?? 0;
        out[at + 3] = p[3] ?? 1;
        const c = vertex.color;
        out[at + 4] = c[0];
        out[at + 5] = c[1];
        out[at + 6] = c[2];
        out[at + 7] = c[3] ?? 1;
        const s = vertex.secondary;
        out[at + 8] = s[0];
        out[at + 9] = s[1];
        out[at + 10] = s[2];
        out[at + 11] = s[3] ?? 1;
        const n = vertex.normal;
        out[at + 12] = n[0];
        out[at + 13] = n[1];
        out[at + 14] = n[2];
        out[at + 15] = vertex.fogCoord;
        for (let unit = 0; unit < 8; unit++)
        {
            const t = vertex.texCoords[unit] ?? [0, 0, 0, 1];
            out[at + 16 + unit * 4] = t[0];
            out[at + 17 + unit * 4] = t[1] ?? 0;
            out[at + 18 + unit * 4] = t[2] ?? 0;
            out[at + 19 + unit * 4] = t[3] ?? 1;
        }
        at += floats;
    }
    return out;
}

/**
 * The WebGPU topology a mode is drawn as once expanded: points and lines stay
 * what they are, everything else is triangles.
 *
 * @param {number} mode
 * @returns {'point-list' | 'line-list' | 'triangle-list'}
 */
export function topologyOf(mode){
    if (mode === GL.POINTS)
    {
        return 'point-list';
    }
    if (mode === GL.LINES || mode === GL.LINE_STRIP || mode === GL.LINE_LOOP
        || mode === GL.LINES_ADJACENCY || mode === GL.LINE_STRIP_ADJACENCY)
    {
        return 'line-list';
    }
    return 'triangle-list';
}

/**
 * Whether a mode's vertices can be drawn in the order they come, without an
 * index list of their own.
 *
 * @param {number} mode
 */
export function isList(mode){
    return mode === GL.POINTS || mode === GL.LINES || mode === GL.TRIANGLES;
}

/**
 * The list indices a mode makes of `count` vertices numbered from zero: the
 * triangles of a strip, fan, quad, quad strip or polygon, or the segments of a
 * line strip or loop. A list mode is returned as null, its vertices being in
 * order already.
 *
 * @param {number} mode
 * @param {number} count
 * @returns {Uint32Array | null}
 */
export function expandMode(mode, count){
    if (isList(mode))
    {
        return null;
    }
    // The same mode and count give the same order, and a frame draws the
    // same few hundred times over: each is built once. The answer is shared,
    // so no caller writes into it.
    const key = mode * 0x100000 + count;
    const known = EXPANDED.get(key);
    if (known !== undefined)
    {
        return known;
    }
    if (EXPANDED.size >= EXPANDED_KEPT)
    {
        EXPANDED.clear();
    }
    const order = buildOrder(mode, count);
    EXPANDED.set(key, order);
    return order;
}

/** The orders `expandMode` has built, by mode and count. @type {Map<number, Uint32Array>} */
const EXPANDED = new Map();
/** How many it keeps before starting over: a bound, not a working set. */
const EXPANDED_KEPT = 1024;

/**
 * @param {number} mode @param {number} count
 * @returns {Uint32Array}
 */
function buildOrder(mode, count){
    /** @type {number[]} */
    const out = [];
    switch (mode)
    {
        case GL.TRIANGLE_STRIP:
            for (let i = 0; i + 2 < count; i++)
            {
                // Every second triangle of a strip is wound the other way, and
                // is turned back so culling sees one facing.
                out.push(...(i % 2 === 0 ? [i, i + 1, i + 2] : [i + 1, i, i + 2]));
            }
            break;
        case GL.TRIANGLE_FAN:
        case GL.POLYGON:
            for (let i = 1; i + 1 < count; i++)
            {
                out.push(0, i, i + 1);
            }
            break;
        case GL.QUADS:
            for (let i = 0; i + 3 < count; i += 4)
            {
                out.push(i, i + 1, i + 2, i, i + 2, i + 3);
            }
            break;
        case GL.QUAD_STRIP:
            for (let i = 0; i + 3 < count; i += 2)
            {
                out.push(i, i + 1, i + 3, i, i + 3, i + 2);
            }
            break;
        case GL.LINE_STRIP:
        case GL.LINE_LOOP:
            for (let i = 0; i + 1 < count; i++)
            {
                out.push(i, i + 1);
            }
            if (mode === GL.LINE_LOOP && count >= 2)
            {
                out.push(count - 1, 0);
            }
            break;
        // Without a geometry shader the adjacent vertices are passed over
        // (OpenGL 3.2 section 2.6.1).
        case GL.LINES_ADJACENCY:
            for (let i = 0; i + 3 < count; i += 4)
            {
                out.push(i + 1, i + 2);
            }
            break;
        case GL.LINE_STRIP_ADJACENCY:
            for (let i = 1; i + 2 < count; i++)
            {
                out.push(i, i + 1);
            }
            break;
        case GL.TRIANGLES_ADJACENCY:
            for (let i = 0; i + 5 < count; i += 6)
            {
                out.push(i, i + 2, i + 4);
            }
            break;
        case GL.TRIANGLE_STRIP_ADJACENCY: {
            const strip = stripWithAdjacency(count);
            for (let k = 0; k < strip.length; k += 6)
            {
                out.push(strip[k], strip[k + 2], strip[k + 4]);
            }
            break;
        }
        default:
            break;
    }
    return Uint32Array.from(out);
}

/**
 * A triangle strip with adjacency as the six vertices of each of its
 * triangles in the order a geometry shader reads them: the triangle's first
 * vertex, the one adjacent to its first edge, its second, the one adjacent
 * to its second edge, its third, the one adjacent to its third
 * (GL_ARB_geometry_shader4, table 2.X1, numbered here from 0). n triangles
 * take 2(n + 2) vertices, and an odd one past them is passed over.
 *
 * @param {number} count @returns {number[]}
 */
export function stripWithAdjacency(count){
    const n = Math.max(0, Math.floor((count - 4) / 2));
    /** @type {number[]} */
    const out = [];
    for (let i = 0; i < n; i++)
    {
        const odd = (i & 1) === 1;
        const [first, second] = i > 0 && odd ? [2 * i + 2, 2 * i] : [2 * i, 2 * i + 2];
        const third = 2 * i + 4;
        /** @type {[number, number, number]} */
        let adjacent;
        if (n === 1)
        {
            adjacent = [1, 5, 3];
        }
        else if (i === 0)
        {
            adjacent = [1, 6, 3];
        }
        else if (i === n - 1)
        {
            adjacent = odd ? [2 * i - 2, 2 * i + 3, 2 * i + 5] : [2 * i - 2, 2 * i + 5, 2 * i + 3];
        }
        else
        {
            adjacent = odd ? [2 * i - 2, 2 * i + 3, 2 * i + 6] : [2 * i - 2, 2 * i + 6, 2 * i + 3];
        }
        out.push(first, adjacent[0], second, adjacent[1], third, adjacent[2]);
    }
    return out;
}

/**
 * A draw's vertices in an order that puts each primitive's provoking vertex
 * first, which is the one WebGPU takes a flat value from, where GL takes the
 * last (OpenGL 3.2 section 2.18, table 2.12, GL_LAST_VERTEX_CONVENTION): each
 * primitive of the mode's list turned round by one, which keeps a
 * triangle's winding. A quad's is its fourth vertex, which its two
 * triangles take only when the diagonal runs to it; a polygon's is its
 * first, where it is already. Null for a mode with nothing to turn.
 *
 * @param {number} mode @param {number} count
 * @returns {Uint32Array | null}
 */
export function lastProvoking(mode, count){
    if (mode === GL.POINTS || mode === GL.POLYGON)
    {
        return null;
    }
    /** @type {number[]} */
    let order = [];
    let size = topologyOf(mode) === 'line-list' ? 2 : 3;
    if (mode === GL.QUADS)
    {
        for (let i = 0; i + 3 < count; i += 4)
        {
            order.push(i, i + 1, i + 3, i + 1, i + 2, i + 3);
        }
    }
    else if (mode === GL.QUAD_STRIP)
    {
        for (let i = 0; i + 3 < count; i += 2)
        {
            order.push(i, i + 1, i + 3, i + 2, i, i + 3);
        }
    }
    else if (isList(mode))
    {
        order = Array.from({ length: count - count % size }, (_, k)=>k);
    }
    else
    {
        order = [...expandMode(mode, count) ?? []];
    }
    size = Math.max(1, size);
    const out = new Uint32Array(order.length - order.length % size);
    for (let k = 0; k < out.length; k += size)
    {
        out[k] = order[k + size - 1];
        for (let j = 1; j < size; j++)
        {
            out[k + j] = order[k + j - 1];
        }
    }
    return out;
}

/** The vertices a geometry shader reads a primitive, by the primitive it takes. */
export const GEOMETRY_INPUT_VERTICES = Object.freeze(/** @type {Record<string, number>} */ ({
    points: 1, lines: 2, lines_adjacency: 4, triangles: 3, triangles_adjacency: 6,
}));

/**
 * The modes a geometry shader's input primitive draws (OpenGL 3.2 section
 * 2.12.1): any other is GL_INVALID_OPERATION.
 */
const GEOMETRY_MODES = Object.freeze(/** @type {Record<string, number[]>} */ ({
    points: [GL.POINTS],
    lines: [GL.LINES, GL.LINE_STRIP, GL.LINE_LOOP],
    lines_adjacency: [GL.LINES_ADJACENCY, GL.LINE_STRIP_ADJACENCY],
    triangles: [GL.TRIANGLES, GL.TRIANGLE_STRIP, GL.TRIANGLE_FAN],
    triangles_adjacency: [GL.TRIANGLES_ADJACENCY, GL.TRIANGLE_STRIP_ADJACENCY],
}));

/** @param {number} mode @param {string} input  a geometry shader's input primitive */
export const drawsGeometryInput = (mode, input)=>GEOMETRY_MODES[input]?.includes(mode) ?? false;

/**
 * The positions of a draw a geometry shader reads, a primitive's vertices
 * after another's in the order it reads them: a strip's or a fan's
 * primitives as the lists they make (`buildOrder`'s, a strip's triangles
 * keeping its winding), an adjacency strip's by its table; null for a list,
 * read in order.
 *
 * @param {number} mode @param {number} count
 * @returns {Uint32Array | null}
 */
export function geometryOrder(mode, count){
    switch (mode)
    {
        case GL.POINTS:
        case GL.LINES:
        case GL.TRIANGLES:
        case GL.LINES_ADJACENCY:
        case GL.TRIANGLES_ADJACENCY:
            return null;
        case GL.LINE_STRIP_ADJACENCY: {
            const out = [];
            for (let i = 0; i + 3 < count; i++)
            {
                out.push(i, i + 1, i + 2, i + 3);
            }
            return Uint32Array.from(out);
        }
        case GL.TRIANGLE_STRIP_ADJACENCY:
            return Uint32Array.from(stripWithAdjacency(count));
        default:
            return expandMode(mode, count);
    }
}

/**
 * @typedef {Object} ScannedIndices
 * @property {Uint16Array | Uint32Array} indices
 * @property {'uint16' | 'uint32'} format
 * @property {number} min
 * @property {number} max
 */

/**
 * Reads an index list out of its bytes into a format the GPU takes, and finds
 * the range of vertices it reaches. Unsigned bytes are widened to sixteen
 * bits, the narrowest index format there is. Sixteen- and 32-bit indices on
 * their own alignment are answered as a view of the bytes, not a copy: a
 * draw writes them into the device's ring right after, and a copy here was a
 * second pass and an allocation for every draw. A caller that keeps them
 * past the call keeps them only as long as the bytes stay as they are.
 *
 * @param {Uint8Array} bytes
 * @param {number} type   GL_UNSIGNED_BYTE, GL_UNSIGNED_SHORT or GL_UNSIGNED_INT
 * @param {number} count
 * @returns {ScannedIndices}
 */
export function scanIndices(bytes, type, count){
    let min = count === 0 ? 0 : 0xffffffff;
    let max = 0;
    if (type === GL.UNSIGNED_INT)
    {
        // A 4-aligned span is read through a typed view of the same bytes --
        // the platform's own little-endian layout, which every engine target
        // this runs on uses. An unaligned span (not promised by the API, but
        // not refused either) is copied byte-exact.
        let indices;
        if (bytes.byteOffset % 4 === 0)
        {
            indices = new Uint32Array(bytes.buffer, bytes.byteOffset, count);
        }
        else
        {
            indices = new Uint32Array(count);
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            for (let i = 0; i < count; i++)
            {
                indices[i] = view.getUint32(i * 4, true);
            }
        }
        for (let i = 0; i < count; i++)
        {
            const index = indices[i];
            min = index < min ? index : min;
            max = index > max ? index : max;
        }
        return { indices, format: 'uint32', min, max };
    }
    if (type === GL.UNSIGNED_SHORT && bytes.byteOffset % 2 === 0)
    {
        const indices = new Uint16Array(bytes.buffer, bytes.byteOffset, count);
        for (let i = 0; i < count; i++)
        {
            const index = indices[i];
            min = index < min ? index : min;
            max = index > max ? index : max;
        }
        return { indices, format: 'uint16', min, max };
    }
    const indices = new Uint16Array(count);
    if (type === GL.UNSIGNED_SHORT)
    {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        for (let i = 0; i < count; i++)
        {
            const index = view.getUint16(i * 2, true);
            indices[i] = index;
            min = index < min ? index : min;
            max = index > max ? index : max;
        }
    }
    else
    {
        for (let i = 0; i < count; i++)
        {
            const index = bytes[i];
            indices[i] = index;
            min = index < min ? index : min;
            max = index > max ? index : max;
        }
    }
    return { indices, format: 'uint16', min, max };
}

/**
 * The vertices a draw reaches: its range, or the range its indices reach
 * moved by the base vertex (OpenGL 3.2's glDrawElementsBaseVertex adds it to
 * every index before the arrays are read).
 *
 * @param {{ first: number, count: number, baseVertex?: number }} request
 * @param {{ min: number, max: number } | null} scanned  the indices' own range
 * @returns {{ min: number, max: number }}
 */
export function vertexRange(request, scanned){
    if (!scanned)
    {
        return { min: request.first, max: request.first + request.count - 1 };
    }
    const base = request.baseVertex ?? 0;
    return { min: scanned.min + base, max: scanned.max + base };
}

/**
 * Where each instance's element of a per-instance slot is (glVertexAttribDivisor):
 * instance i reads element floor(i / divisor) after the base instance, which
 * GL adds after the division. Contiguous when the divisor is one.
 *
 * @param {DrawSlot} slot @param {number} instances @param {number} baseInstance
 * @returns {{ at: number, length: number } | number[]}  one run, or each
 *     instance's element offset from the slot's base
 */
export function instanceElements(slot, instances, baseInstance){
    if (slot.constant)
    {
        return new Array(instances).fill(0);
    }
    if (slot.divisor === 1)
    {
        return { at: slot.base + baseInstance * slot.stride,
            length: instances * slot.stride };
    }
    return Array.from({ length: instances }, (_, i)=>
        (Math.floor(i / slot.divisor) + baseInstance) * slot.stride);
}

/**
 * What of client memory a draw by arrays reads, one entry per slot -- null for
 * a slot in a buffer object or one read by instance: from the first vertex
 * the draw reaches when every slot is client memory, and from vertex zero
 * when a buffer object shares the draw, so that one index numbers every slot
 * alike. The renderer copies these ranges and a renderer elsewhere is sent
 * them, so both ask here.
 *
 * @param {readonly DrawSlot[]} slots
 * @param {number} min @param {number} max  the vertices the draw reaches
 * @returns {{ from: number, reads: ({ at: number, length: number } | null)[] }}
 *     `from` the vertex the client ranges begin at
 */
export function clientReads(slots, min, max){
    // A per-instance slot is read by instance (`instanceElements`), not here.
    const from = slots.every(slot=>slot.buffer === 0 || slot.divisor > 0) ? min : 0;
    return { from, reads: slots.map(slot=>(slot.buffer !== 0 || slot.divisor > 0 ? null
        : { at: slot.base + from * slot.stride, length: (max + 1 - from) * slot.stride })) };
}

/**
 * The locked range a draw reads inside, or null: GL_EXT_compiled_vertex_array
 * promises its arrays do not change while locked, so a renderer may read the
 * whole range once and draw every pass from that. A draw reaching outside it
 * is read as any other.
 *
 * @param {{ lock?: { first: number, count: number, epoch: number } | null }} request
 * @param {number} min @param {number} max  the vertices the draw reaches
 */
export function lockedFor(request, min, max){
    const lock = request.lock;
    return lock && min >= lock.first && max < lock.first + lock.count ? lock : null;
}

/**
 * The list indices of a draw whose vertices are numbered `first` onward,
 * through an index list when it has one: what a non-list mode is drawn with.
 *
 * @param {number} mode
 * @param {Uint16Array | Uint32Array | null} indices   the program's, or null for a range
 * @param {number} count
 * @returns {Uint32Array | null}   null when the mode is a list already
 */
export function expandIndices(mode, indices, count){
    const order = expandMode(mode, count);
    if (order === null || indices === null)
    {
        return order;
    }
    const out = new Uint32Array(order.length);
    for (let i = 0; i < order.length; i++)
    {
        out[i] = indices[order[i]];
    }
    return out;
}
