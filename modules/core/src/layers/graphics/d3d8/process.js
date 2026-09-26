/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ProcessVertices for Direct3D 8 and 9: the fixed-function transform and
 * lighting a draw would do, run on the processor over the bound streams and
 * written into a vertex buffer the program reads back or draws later.
 *
 * The arithmetic is Direct3D 7's vertex buffer's (`../d3d7/process.js`),
 * which is the same pipeline; what this file adds is where the vertices come
 * from -- the streams a draw would read, through the layout a draw would read
 * them with -- and telling the renderer that the destination's bytes changed
 * under it.
 */

import { D3D_OK, D3DERR_INVALIDCALL } from './constants.js';
import { D3DVOP, processVertices as transformAndLight } from '../d3d7/process.js';
import { FVF, POSITION_MASK, decodeFvf } from '../webgpu/internal/vertexformat.js';
import { IDENTITY } from './render.js';

/**
 * One member of the source vertex: where it lies in which stream.
 *
 * @typedef {Object} SourceAttribute
 * @property {string} name     As the fixed-function layout names it: position, normal, ...
 * @property {number} stream
 * @property {number} offset   Bytes into the stream's vertex.
 * @property {string} format   A WebGPU vertex format.
 */

/**
 * A bound stream as the source reads it.
 *
 * @typedef {Object} SourceStream
 * @property {number} base     The guest address of vertex zero.
 * @property {number} stride
 * @property {number} vertices How many whole vertices lie between `base` and the buffer's end.
 */

/** WebGPU float formats against the FVF's two-bit texture coordinate sizes. */
const TEXCOORD_SIZE_BITS = Object.freeze({ float32x2: 0, float32x3: 1, float32x4: 2, float32: 3 });

/**
 * A flexible vertex format naming the same members as the attributes, so the
 * arithmetic knows what the vertex carries. Where each member lies is the
 * attributes' own business: this format's offsets are never read.
 *
 * @param {readonly SourceAttribute[]} attributes
 * @returns {number} zero when the members are not ones a format can name
 */
export function fvfNaming(attributes){
    const named = new Map(attributes.map(attribute=>[attribute.name, attribute]));
    const position = named.get('position');
    if (!position)
    {
        return 0;
    }
    let fvf = position.format === 'float32x4' ? FVF.XYZRHW : FVF.XYZ;
    const weights = named.get('blendWeight');
    if (weights)
    {
        const count = weights.format === 'float32' ? 1 : Number(weights.format.slice(-1));
        fvf = FVF.XYZB1 + (count - 1) * 2;
    }
    fvf |= named.has('normal') ? FVF.NORMAL : 0;
    fvf |= named.has('pointSize') ? FVF.PSIZE : 0;
    fvf |= named.has('diffuse') ? FVF.DIFFUSE : 0;
    fvf |= named.has('specular') ? FVF.SPECULAR : 0;
    let sets = 0;
    while (named.has(`texCoord${sets}`))
    {
        const bits = /** @type {Record<string, number>} */ (TEXCOORD_SIZE_BITS)[
            /** @type {SourceAttribute} */ (named.get(`texCoord${sets}`)).format];
        if (bits === undefined)
        {
            return 0;
        }
        fvf |= bits << (16 + sets * 2);
        sets++;
    }
    return (fvf | (sets << FVF.TEXCOUNT_SHIFT)) >>> 0;
}

/**
 * @param {Object} request
 * @param {{ readMemory: (address: number, length: number) => Uint8Array,
 *           writeMemory: (address: number, bytes: Uint8Array) => void }} request.memory
 * @param {import('./render.js').RenderModel} request.model  The device's state.
 * @param {readonly SourceAttribute[]} request.attributes
 * @param {(stream: number) => SourceStream | null} request.streamAt
 * @param {number} request.start      The first source vertex.
 * @param {number} request.count
 * @param {any} request.destination   The vertex buffer written.
 * @param {number} request.destinationFvf  What each destination vertex holds.
 * @param {number} request.destinationIndex
 * @param {number} request.flags      D3DPV
 * @param {any} [request.renderer]    Told the destination's bytes changed.
 * @returns {number} HRESULT
 */
export function processStreams(request){
    const { memory, model, attributes, destination } = request;
    const start = request.start >>> 0;
    const count = request.count >>> 0;
    const sourceFvf = fvfNaming(attributes);
    const destinationFvf = request.destinationFvf >>> 0;
    if (sourceFvf === 0 || (destinationFvf & POSITION_MASK) === 0)
    {
        return D3DERR_INVALIDCALL;
    }
    /** @type {Map<number, SourceStream>} */
    const streams = new Map();
    for (const attribute of attributes)
    {
        const stream = streams.get(attribute.stream) ?? request.streamAt(attribute.stream);
        if (!stream || !(stream.stride > 0) || start + count > stream.vertices)
        {
            return D3DERR_INVALIDCALL;
        }
        streams.set(attribute.stream, stream);
    }
    const byName = new Map(attributes.map(attribute=>[attribute.name, attribute]));
    const stride = decodeFvf(destinationFvf).stride;
    const rs = (/** @type {number} */ state)=>model.renderStates.get(state) ?? 0;
    const rect = model.viewport.rect;
    const hr = transformAndLight({
        memory,
        // Lighting follows D3DRS_LIGHTING, as a draw's does; the Direct3D 7
        // operation flags have no counterpart here.
        vertexOp: D3DVOP.TRANSFORM | D3DVOP.LIGHT,
        dest: {
            base: destination.base,
            fvf: destinationFvf,
            numVertices: Math.floor(destination.length / stride),
        },
        destIndex: request.destinationIndex >>> 0,
        count,
        source: {
            fvf: sourceFvf,
            addressOf: (name, vertex)=>{
                const attribute = byName.get(name);
                if (!attribute)
                {
                    return null;
                }
                const stream = /** @type {SourceStream} */ (streams.get(attribute.stream));
                return stream.base + (start + vertex) * stream.stride + attribute.offset;
            },
        },
        state: {
            transform: type=>model.transforms.get(type) ?? IDENTITY,
            viewport: {
                x: rect.x, y: rect.y, width: rect.width, height: rect.height,
                minDepth: rect.minDepth, maxDepth: rect.maxDepth,
            },
            renderState: rs,
            lights: [...model.lights.entries()]
                .filter(([, record])=>record.enabled)
                .sort(([left], [right])=>left - right)
                .map(([, record])=>record.light),
            material: model.material,
        },
        flags: request.flags >>> 0,
    });
    if (hr !== D3D_OK)
    {
        return D3DERR_INVALIDCALL;
    }
    // The bytes written, and the reciprocal w a position without one leaves
    // at the start of the vertex after the last.
    const from = (request.destinationIndex >>> 0) * stride;
    const to = Math.min(destination.length, from + count * stride + 4);
    if (request.renderer && to > from)
    {
        request.renderer.lockBuffer(destination, from, to - from, 0);
        request.renderer.unlockBuffer(destination);
    }
    return D3D_OK;
}

