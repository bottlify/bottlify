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
 */

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
    const bytes = componentBytes(type) * size;
    switch (type)
    {
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
 * @typedef {Object} ArrayRequest
 * @property {string} name
 * @property {import('./arrays.js').ArrayPointer} pointer
 * @property {boolean} normalised
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
        const format = vertexFormatOf(pointer.type, pointer.size, array.normalised);
        if (!format)
        {
            return null;
        }
        const stride = effectiveStride(pointer);
        if (stride % 4 !== 0 || stride > 2048)
        {
            return null;
        }
        // An attribute's offset must be a multiple of the smaller of four and
        // its own size, and a slot's base a multiple of four; a slot is
        // opened at the pointer rounded down so that the attribute's own
        // offset takes up the remainder.
        const align = Math.min(4, format.bytes);
        let slot = slots.findIndex(candidate=>candidate.buffer === pointer.buffer
            && candidate.stride === stride
            && pointer.pointer >= candidate.base
            && pointer.pointer - candidate.base + format.bytes <= stride
            && (pointer.pointer - candidate.base) % align === 0);
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
            slot = slots.push({ buffer: pointer.buffer, base, stride }) - 1;
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
    slots: [{ buffer: 0, base: 0, stride: CANONICAL_STRIDE }],
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
    if (mode === GL.LINES || mode === GL.LINE_STRIP || mode === GL.LINE_LOOP)
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
        default:
            break;
    }
    return Uint32Array.from(out);
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
 * What of client memory a draw by arrays reads, one entry per slot -- null for
 * a slot in a buffer object: from the first vertex the draw reaches when every
 * slot is client memory, and from vertex zero when a buffer object shares the
 * draw, so that one index numbers every slot alike. The renderer copies these
 * ranges and a renderer elsewhere is sent them, so both ask here.
 *
 * @param {readonly DrawSlot[]} slots
 * @param {number} min @param {number} max  the vertices the draw reaches
 * @returns {{ from: number, reads: ({ at: number, length: number } | null)[] }}
 *     `from` the vertex the client ranges begin at
 */
export function clientReads(slots, min, max){
    const from = slots.every(slot=>slot.buffer === 0) ? min : 0;
    return { from, reads: slots.map(slot=>(slot.buffer !== 0 ? null
        : { at: slot.base + from * slot.stride, length: (max + 1 - from) * slot.stride })) };
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
