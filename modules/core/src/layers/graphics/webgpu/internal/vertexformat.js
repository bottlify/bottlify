/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A flexible vertex format, decoded into a vertex buffer layout.
 *
 * An FVF is a bit field that says which attributes a vertex carries; their
 * order in memory is fixed by the API and is not encoded anywhere in the bits.
 * So the order below is the specification, not a choice, and getting it wrong
 * reads every attribute after the mistake from the wrong offset -- which draws
 * geometry rather than failing, and is why the offsets are asserted.
 *
 * Two details are worth stating because both are silent when wrong:
 *
 * - **A position is three floats, or four when it is pre-transformed.** An
 *   XYZRHW vertex is already in screen space and carries its own reciprocal w;
 *   it does not go through the world/view/projection matrices at all, and a
 *   pipeline that transforms it anyway puts the geometry somewhere else.
 * - **A colour is one DWORD in B,G,R,A byte order.** WebGPU's `unorm8x4` reads
 *   the four bytes in memory order, so it arrives as (b, g, r, a) and the shader
 *   is what puts it back. Nothing about that is visible until the picture comes
 *   out with red and blue exchanged.
 */

/** Position, and the blend-weight counts that share its field. */
export const POSITION_MASK = 0x00e;
const POSITION = Object.freeze({
    XYZ: 0x002,
    XYZRHW: 0x004,
    XYZB1: 0x006,
    XYZB2: 0x008,
    XYZB3: 0x00a,
    XYZB4: 0x00c,
    XYZB5: 0x00e,
});

export const FVF = Object.freeze({
    RESERVED0: 0x001,
    ...POSITION,
    NORMAL: 0x010,
    PSIZE: 0x020,
    DIFFUSE: 0x040,
    SPECULAR: 0x080,
    TEXCOUNT_MASK: 0xf00,
    TEXCOUNT_SHIFT: 8,
});

/**
 * How many floats a texture coordinate set carries.
 *
 * Two bits per set, packed from bit 16 upward, and the encoding is not the
 * obvious one: three means *one* float, not four. A decoder that treats the
 * pair as a count reads one-dimensional coordinates as four-dimensional and
 * every attribute after them from the wrong place.
 */
const TEXCOORD_SIZES = Object.freeze([2, 3, 4, 1]);

/** WebGPU's name for a run of `count` 32-bit floats. @param {number} count */
const floatFormat = count=>(count === 1 ? 'float32' : `float32x${count}`);

/**
 * @typedef {Object} VertexAttribute
 * @property {string} name        What the generated shader calls it.
 * @property {number} offset      Bytes from the start of the vertex.
 * @property {string} format      A WebGPU vertex format.
 * @property {number} shaderLocation
 */

/**
 * @typedef {Object} VertexLayout
 * @property {number} stride           Bytes per vertex.
 * @property {VertexAttribute[]} attributes
 * @property {boolean} preTransformed  True for XYZRHW: already in screen space.
 * @property {number} texCoordSets
 * @property {number} blendWeights
 */

/**
 * @param {number} fvf
 * @returns {VertexLayout}
 */
export function decodeFvf(fvf){
    const position = fvf & POSITION_MASK;
    if (position === 0)
    {
        throw new Error(`Vertex format 0x${fvf.toString(16)} declares no position`);
    }

    /** @type {VertexAttribute[]} */
    const attributes = [];
    let offset = 0;
    let location = 0;

    /** @param {string} name @param {string} format @param {number} bytes */
    const add = (name, format, bytes)=>{
        attributes.push({ name, offset, format, shaderLocation: location++ });
        offset += bytes;
    };

    const preTransformed = position === POSITION.XYZRHW;
    add('position', preTransformed ? 'float32x4' : 'float32x3', preTransformed ? 16 : 12);

    // Blend weights sit immediately after the position and share its field:
    // XYZB1 through XYZB5 carry one to five floats.
    const blendWeights = position >= POSITION.XYZB1
        ? (position - POSITION.XYZB1) / 2 + 1
        : 0;
    if (blendWeights > 0)
    {
        add('blendWeight', floatFormat(blendWeights), blendWeights * 4);
    }

    if ((fvf & FVF.NORMAL) !== 0)
    {
        add('normal', 'float32x3', 12);
    }
    if ((fvf & FVF.PSIZE) !== 0)
    {
        add('pointSize', 'float32', 4);
    }
    // Both colours are B,G,R,A bytes; the shader swizzles. See the header.
    if ((fvf & FVF.DIFFUSE) !== 0)
    {
        add('diffuse', 'unorm8x4', 4);
    }
    if ((fvf & FVF.SPECULAR) !== 0)
    {
        add('specular', 'unorm8x4', 4);
    }

    const texCoordSets = (fvf & FVF.TEXCOUNT_MASK) >>> FVF.TEXCOUNT_SHIFT;
    for (let set = 0; set < texCoordSets; set++)
    {
        const count = TEXCOORD_SIZES[(fvf >>> (16 + set * 2)) & 3];
        add(`texCoord${set}`, floatFormat(count), count * 4);
    }

    return { stride: offset, attributes, preTransformed, texCoordSets, blendWeights };
}
