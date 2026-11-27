/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Whether a stream-output declaration is one CreateGeometryShaderWithStreamOutput
 * takes, as Windows answers it (Wine's test_stream_output and
 * test_fl10_stream_output_desc). Nothing here writes a stream-output buffer;
 * the shader is made so that a program goes on, and its draws say so.
 */

/** D3D11_SO_NO_RASTERIZED_STREAM. */
export const SO_NO_RASTERIZED_STREAM = 0xffffffff;
/** D3D11_SO_STREAM_COUNT and D3D11_SO_BUFFER_SLOT_COUNT. */
const STREAMS = 4;
const SLOTS = 4;
/** D3D11_SO_BUFFER_MAX_STRIDE_IN_BYTES. */
const MOST_STRIDE = 2048;

/**
 * @typedef {Object} StreamOutputEntry
 * @property {number} Stream          0 under Direct3D 10, which has none.
 * @property {string | null} SemanticName  null for a gap.
 * @property {number} SemanticIndex
 * @property {number} StartComponent
 * @property {number} ComponentCount
 * @property {number} OutputSlot
 */

/**
 * @param {Object} request
 * @param {readonly import('./dxbc.js').SignatureElement[]} request.outputs  the shader's
 * @param {readonly StreamOutputEntry[] | null} request.entries  null for no declaration
 * @param {readonly number[] | null} request.strides  null or empty for none given
 * @param {number} request.rasterizedStream
 * @param {boolean} request.eleven  the device is of level 11 or above
 * @param {boolean} request.vertex  the bytecode is a vertex shader's
 * @param {boolean} [request.oneStride]  Direct3D 10's call, whose one stride is slot
 *     zero's: given when only slot zero is written, and zero when a later slot is,
 *     each of whose buffers takes one element (d3d10core.c test_stream_output)
 * @returns {boolean}
 */
export function validStreamOutput({ outputs, entries, strides, rasterizedStream, eleven, vertex,
    oneStride = false })
{
    const given = strides && strides.length > 0 ? strides : null;
    if (eleven ? rasterizedStream >= STREAMS && rasterizedStream !== SO_NO_RASTERIZED_STREAM
        : rasterizedStream !== 0)
    {
        return false;
    }
    if (!entries)
    {
        // A geometry shader may stream nothing out; a vertex shader is made
        // into one only to stream out. Below 11 a stride without entries is
        // refused as well.
        return !vertex && (eleven || !given);
    }
    if (entries.length === 0 || (!eleven && given && given.length > 1))
    {
        return false;
    }
    const laterSlot = entries.some(entry=>entry.OutputSlot > 0);
    if (oneStride && (laterSlot ? given !== null : given === null))
    {
        return false;
    }
    /** @type {Map<string, number>} components written, by output */
    const written = new Map();
    /** @type {Map<number, { entries: number, outputs: number, components: number }>} */
    const slots = new Map();
    for (const entry of entries)
    {
        if (entry.Stream >= (eleven ? STREAMS : 1) || entry.OutputSlot >= SLOTS
            || entry.ComponentCount === 0)
        {
            return false;
        }
        const slot = slots.get(entry.OutputSlot) ?? { entries: 0, outputs: 0, components: 0 };
        slots.set(entry.OutputSlot, slot);
        slot.entries++;
        slot.components += entry.ComponentCount;
        if (entry.SemanticName === null)
        {
            if (entry.SemanticIndex !== 0 || entry.StartComponent !== 0)
            {
                return false;
            }
            continue;
        }
        const name = entry.SemanticName.toUpperCase();
        const element = outputs.find(output=>output.name.toUpperCase() === name
            && output.index === entry.SemanticIndex && (output.stream ?? 0) === entry.Stream);
        // An entry's components count from its element's first: COLOR2 in
        // .zw has two, ATTRIB4 in .z one (test_stream_output).
        const width = element ? [0, 1, 2, 3].filter(c=>(element.mask & (1 << c)) !== 0).length
            : 0;
        if (!element || entry.StartComponent + entry.ComponentCount > width)
        {
            return false;
        }
        const key = `${name}|${entry.SemanticIndex}|${entry.Stream}`;
        const bits = ((1 << entry.ComponentCount) - 1) << entry.StartComponent;
        if (((written.get(key) ?? 0) & bits) !== 0)
        {
            return false;
        }
        written.set(key, (written.get(key) ?? 0) | bits);
        slot.outputs++;
    }
    for (const [index, slot] of slots)
    {
        // A buffer of gaps alone is refused; below 11 several buffers take
        // one output each.
        if (slot.outputs === 0 || (!eleven && slots.size > 1 && slot.entries > 1))
        {
            return false;
        }
        const stride = given ? given[index] : undefined;
        if (given && (stride === undefined || stride % 4 !== 0 || stride > MOST_STRIDE
            || stride < slot.components * 4))
        {
            return false;
        }
    }
    return true;
}
