/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where a Direct3D 8 draw becomes commands on the backend.
 *
 * The device in `device.js` models what a program can observe; this file is
 * what happens underneath when the device has a backend to draw on. Nothing
 * here is reachable through a COM table, and nothing here validates a call --
 * by the time a draw arrives it is legal, and the only questions left are what
 * pipeline it needs, which bytes it reads, and where they are.
 *
 * Draws are recorded, not encoded. A pipeline is compiled asynchronously and a
 * guest call returns synchronously, so the frame is a list of commands that is
 * replayed onto one backend frame once every pipeline it needs exists. That
 * replay is where the backend's own rules are honoured: one encoder and one
 * submit per frame, a fresh pass whenever the target changes, a fresh bind
 * group cache with every pass, and one uniform block per draw rather than one
 * rewritten between draws. The recording captures the buffer *generation* a
 * draw was issued against, because a lock with DISCARD between recording and
 * replay renames the buffer and the draw must still read the old one.
 *
 * Guest memory is the boundary. A locked buffer or texture hands the program an
 * address, the program writes there, and the unlock is when those bytes are
 * read back and handed to the backend under the lock flags the program gave.
 * Nothing here reads guest memory at any other time, and the user-pointer draws
 * take bytes rather than addresses for the same reason.
 *
 * Pixels are the engine's own: a colour target is `bgra8unorm`, so a D3DCOLOR
 * texel is uploaded as it lies in memory and a D3DCOLOR vertex colour is
 * swizzled by the shader. Every other texture format is expanded to that one on
 * upload, in integer arithmetic that is the same on every machine.
 */

import {
    COLORWRITEENABLE_ALPHA, COORD_SET_MASK, D3DBLEND, D3DCLEAR, D3DCMP, D3DCULL, D3DFMT,
    D3DFMT_INDEX, D3DFOG, D3DLOCK, D3DPT, D3DRS, D3DTA, D3DTADDRESS, D3DTEXF, D3DTOP, D3DTS,
    D3DTSS, D3DUSAGE, D3DZB, D3D_OK, FORMAT_INFO, argumentsRead, dwordToFloat, isCompressed,
    surfaceBytes,
} from './constants.js';
import { FVF, POSITION_MASK, decodeFvf } from '../webgpu/internal/vertexformat.js';
import { levelExtent } from '../d3d9/resources.js';
import { resourceId } from '../webgpu/internal/bindings.js';
import {
    constantBlocks, createProgramCache, shapeKey, vertexLayoutOf,
} from '../webgpu/internal/programmable.js';
import {
    HYBRID_CONSTANTS, fixedVertexStage, translateShader, varyingLocation,
} from '../d3d9/wgsl.js';
import { D3DDECLUSAGE } from '../d3d9/declaration.js';
import { decodeS3tc } from '../webgpu/internal/s3tc.js';
import {
    fixedFragmentStage, generates, generationOf,
} from '../webgpu/internal/fixedfunction.js';
import { pipelineKey } from '../webgpu/internal/pipeline.js';

/** A stage state's DWORD, as the D3D8 header lays it out. */
const D3DTA_SELECTMASK = D3DTA.SELECTMASK;

/**
 * The two lighting structures, written here rather than referenced from the
 * device that owns them: the devices already reach this file, and a type that
 * pointed back at one of them would close a cycle the boundary check refuses.
 *
 * @typedef {{ r: number, g: number, b: number, a: number }} ColourValue
 *
 * @typedef {Object} Material  D3DMATERIAL8.
 * @property {ColourValue} Diffuse
 * @property {ColourValue} Ambient
 * @property {ColourValue} Specular
 * @property {ColourValue} Emissive
 * @property {number} Power
 *
 * @typedef {Object} Light  D3DLIGHT8.
 * @property {number} Type          D3DLIGHTTYPE.
 * @property {ColourValue} Diffuse
 * @property {ColourValue} Specular
 * @property {ColourValue} Ambient
 * @property {{ x: number, y: number, z: number }} Position
 * @property {{ x: number, y: number, z: number }} Direction
 *     The direction the light travels, not the direction towards it.
 * @property {number} Range
 * @property {number} Falloff
 * @property {number} Attenuation0
 * @property {number} Attenuation1
 * @property {number} Attenuation2
 * @property {number} Theta         The inner cone's full angle, in radians.
 * @property {number} Phi           The outer cone's.
 */

/**
 * The matrix elements a two-dimensional texture coordinate passes through:
 * Direct3D extends (u, v) with a third component of one, so the coordinate
 * goes through the first two columns of the first three rows, and a program
 * that scrolls a texture puts its offset in the third row. Read from the
 * fourth, every such offset is zero and every sprite sheet shows its first
 * cell -- a picture, not an error.
 */
const PLANAR_ROWS = Object.freeze([0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15]);

/** What those elements hold when the transform moves nothing: the identity, by columns. */
const PLANAR_IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** D3DTTFF_COUNTn: how many coordinates go through the matrix; PROJECTED divides by the last. */
const TTFF_COUNT_MASK = 0xff;
const TTFF_PROJECTED = 0x100;
const TTFF_COUNT2 = 2;
const TTFF_COUNT4 = 4;

/**
 * Whether a stage's transform flags are ones the sampler applies: two to
 * four coordinates, with a projective divide only where the coordinate is
 * generated, since a carried set is two components with nothing to divide by.
 *
 * @param {number} flags @param {boolean} generated
 */
const transformApplies = (flags, generated)=>{
    const count = flags & TTFF_COUNT_MASK;
    return count >= TTFF_COUNT2 && count <= TTFF_COUNT4
        && ((flags & TTFF_PROJECTED) === 0 || generated);
};

/** Textures whose texels a dumping run keeps. Enough to find one, not a heap dump. */
const TEXTURE_DUMP_LIMIT = 96;

/** Distinct cascade truncations a run keeps, so a report names them without a flood. */
const TRUNCATION_SAMPLES = 8;

/** Stages a device has. Every one past the cascade's end is ignored, not an error. */
export const STAGE_COUNT = 8;

// --- pure arithmetic, exported so the byte-exact tests can hold it to account ---

/** @type {readonly number[]} */
export const IDENTITY = Object.freeze([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
]);

/**
 * `a * b` for two row-major matrices, in the row-vector convention Direct3D
 * uses: a point goes through `a` first and then `b`, and the world, view and
 * projection matrices combine in that order.
 *
 * The product is uploaded in memory order and read by WGSL as column-major,
 * which hands the shader the transpose -- and a column-vector multiply by the
 * transpose is exactly a row-vector multiply by the original. No transpose is
 * ever done explicitly, and doing one would be the error.
 *
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @param {Float32Array} [out]  Where the product goes; fresh when not given.
 * @returns {Float32Array}
 */
export function multiplyMatrices(a, b, out = new Float32Array(16)){
    for (let row = 0; row < 4; row++)
    {
        for (let column = 0; column < 4; column++)
        {
            let sum = 0;
            for (let k = 0; k < 4; k++)
            {
                sum += a[row * 4 + k] * b[k * 4 + column];
            }
            out[row * 4 + column] = sum;
        }
    }
    return out;
}

/**
 * A point as a row vector through a matrix, homogeneous coordinate included.
 *
 * @param {ArrayLike<number>} m
 * @param {readonly number[]} point  x, y, z
 * @returns {number[]} x, y, z, w
 */
export function transformPosition(m, point){
    const [x, y, z] = point;
    return [
        x * m[0] + y * m[4] + z * m[8] + m[12],
        x * m[1] + y * m[5] + z * m[9] + m[13],
        x * m[2] + y * m[6] + z * m[10] + m[14],
        x * m[3] + y * m[7] + z * m[11] + m[15],
    ];
}

/**
 * Where a draw lands on its target, in target pixels.
 *
 * The extent of its vertices, not their coverage: the box the transformed
 * corners span. That is what answers "which draw painted this patch of the
 * frame", and it costs one transform per vertex rather than a rasteriser.
 *
 * A vertex whose clip w is not positive is behind the eye and has no screen
 * position; dividing by it anyway throws the box out to either infinity and
 * swallows every other vertex in it, so those are counted and dropped.
 *
 * @typedef {Object} ScreenDraw
 * @property {ArrayLike<number>} worldViewProjection
 * @property {import('../webgpu/contract.js').ViewportState} viewport
 * @property {boolean} preTransformed  Already in target pixels.
 * @property {Uint8Array} vertices     From the first vertex the draw reads.
 * @property {number} stride
 * @property {ArrayLike<number> | null} indices  Relative to that first vertex.
 */

/**
 * Depth is reported beside position, because the far plane is a clip too:
 * a vertex whose clip z exceeds its w is cut away with every triangle it is
 * in, and a surface built to sit exactly on the far plane -- a sky -- is the
 * one this decides frame by frame. `before` counts vertices nearer than the
 * near plane among those in front of the eye, `beyond` those past the far
 * plane, `depth` spans their z/w and `eye` their clip w -- the eye-space
 * distance a vertex is fogged by.
 *
 * @param {ScreenDraw} draw
 * `nearest` lists the clip w of the vertices closest to the eye plane, behind
 * or before it: a triangle with a vertex on that plane is interpolated through
 * a division by nothing, and what it paints is decided by rounding.
 *
 * @returns {{ points: number[][], behind: number, before: number, beyond: number,
 *            depth: [number, number], eye: [number, number], nearest: number[] }}
 */
export function screenPositions(draw){
    const { rect } = draw.viewport;
    const bytes = draw.vertices;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const total = draw.indices
        ? draw.indices.length
        : Math.floor(bytes.byteLength / draw.stride);
    /** @type {number[][]} */
    const points = [];
    let behind = 0;
    let before = 0;
    let beyond = 0;
    /** @type {[number, number]} */
    const depth = [Infinity, -Infinity];
    /** @type {[number, number]} */
    const eye = [Infinity, -Infinity];
    /** @type {number[]} */
    const nearest = [];
    for (let index = 0; index < total; index++)
    {
        const at = (draw.indices ? draw.indices[index] : index) * draw.stride;
        if (at < 0 || at + 12 > bytes.byteLength)
        {
            continue;
        }
        let x = view.getFloat32(at, true);
        let y = view.getFloat32(at + 4, true);
        if (!draw.preTransformed)
        {
            const clip = transformPosition(draw.worldViewProjection,
                [x, y, view.getFloat32(at + 8, true)]);
            nearest.push(clip[3]);
            if (!(clip[3] > 0))
            {
                behind++;
                continue;
            }
            const z = clip[2] / clip[3];
            if (z < 0)
            {
                before++;
            }
            else if (z > 1)
            {
                beyond++;
            }
            depth[0] = Math.min(depth[0], z);
            depth[1] = Math.max(depth[1], z);
            eye[0] = Math.min(eye[0], clip[3]);
            eye[1] = Math.max(eye[1], clip[3]);
            x = rect.x + (clip[0] / clip[3] * 0.5 + 0.5) * rect.width;
            y = rect.y + (0.5 - clip[1] / clip[3] * 0.5) * rect.height;
        }
        // The vertex it came from rides along: a caller matching a corner
        // against what the vertex carried there cannot recover it otherwise,
        // because vertices behind the eye leave no gap in this list.
        points.push([x, y, at]);
    }
    nearest.sort((left, right)=>Math.abs(left) - Math.abs(right));
    return { points, behind, before, beyond, depth, eye, nearest: nearest.slice(0, 5) };
}

/**
 * The box those positions span, in whole pixels.
 *
 * @param {ScreenDraw} draw
 * @returns {{ x0: number, y0: number, x1: number, y1: number, behind: number,
 *            before: number, beyond: number, depth: [number, number],
 *            eye: [number, number], nearest: number[] } | null}
 */
export function screenExtent(draw){
    const { points, behind, before, beyond, depth, eye, nearest } = screenPositions(draw);
    if (points.length === 0)
    {
        return null;
    }
    return {
        x0: Math.round(Math.min(...points.map(point=>point[0]))),
        y0: Math.round(Math.min(...points.map(point=>point[1]))),
        x1: Math.round(Math.max(...points.map(point=>point[0]))),
        y1: Math.round(Math.max(...points.map(point=>point[1]))),
        behind,
        before,
        beyond,
        depth,
        eye,
        nearest,
    };
}

/**
 * A D3DCOLOR (A8R8G8B8 as one DWORD) as the four floats a shader reads.
 *
 * @param {number} dword
 * @returns {{ r: number, g: number, b: number, a: number }}
 */
export function colorToFloats(dword){
    return {
        r: ((dword >>> 16) & 0xff) / 255,
        g: ((dword >>> 8) & 0xff) / 255,
        b: (dword & 0xff) / 255,
        a: (dword >>> 24) / 255,
    };
}

/**
 * How many vertices a primitive count spans, or zero for a type that is not
 * one -- which is what makes a zero count and an unknown type the same refusal.
 *
 * @param {number} type       D3DPRIMITIVETYPE
 * @param {number} primitiveCount
 * @returns {number}
 */
export function vertexCountOf(type, primitiveCount){
    if (!(primitiveCount > 0))
    {
        return 0;
    }
    switch (type)
    {
        case D3DPT.POINTLIST:
            return primitiveCount;
        case D3DPT.LINELIST:
            return primitiveCount * 2;
        case D3DPT.LINESTRIP:
            return primitiveCount + 1;
        case D3DPT.TRIANGLELIST:
            return primitiveCount * 3;
        case D3DPT.TRIANGLESTRIP:
        case D3DPT.TRIANGLEFAN:
            return primitiveCount + 2;
        default:
            return 0;
    }
}

/**
 * The WebGPU topology a primitive type draws as when its vertices come in
 * order. Fans have no counterpart and are always expanded.
 *
 * @type {Readonly<Record<number, string>>}
 */
const TOPOLOGY = Object.freeze({
    [D3DPT.POINTLIST]: 'point-list',
    [D3DPT.LINELIST]: 'line-list',
    [D3DPT.LINESTRIP]: 'line-strip',
    [D3DPT.TRIANGLELIST]: 'triangle-list',
    [D3DPT.TRIANGLESTRIP]: 'triangle-strip',
});

/** @type {Readonly<Record<number, string>>} */
const LIST_OF = Object.freeze({
    [D3DPT.LINESTRIP]: 'line-list',
    [D3DPT.TRIANGLESTRIP]: 'triangle-list',
    [D3DPT.TRIANGLEFAN]: 'triangle-list',
});

/**
 * A strip or fan, rewritten as the list it draws.
 *
 * Indexed strips need a strip index format the pipeline does not declare, and
 * fans do not exist at all, so both become lists here. A strip alternates its
 * winding on every odd triangle so that all of them face the same way; the
 * rewrite keeps that, because a cull mode that discards half the strip is not
 * something a test on a list would notice.
 *
 * @param {number} type
 * @param {ArrayLike<number>} indices  The vertex indices in strip or fan order.
 * @returns {Uint16Array | Uint32Array}
 */
export function listIndices(type, indices){
    const count = indices.length;
    /** @type {number[]} */
    const out = [];
    switch (type)
    {
        case D3DPT.LINESTRIP:
            for (let index = 0; index + 1 < count; index++)
            {
                out.push(indices[index], indices[index + 1]);
            }
            break;
        case D3DPT.TRIANGLESTRIP:
            for (let index = 0; index + 2 < count; index++)
            {
                if (index % 2 === 0)
                {
                    out.push(indices[index], indices[index + 1], indices[index + 2]);
                }
                else
                {
                    out.push(indices[index + 1], indices[index], indices[index + 2]);
                }
            }
            break;
        case D3DPT.TRIANGLEFAN:
            for (let index = 1; index + 1 < count; index++)
            {
                out.push(indices[0], indices[index], indices[index + 1]);
            }
            break;
        default:
            throw new Error(`Primitive type ${type} is already a list`);
    }
    const wide = out.some(value=>value > 0xffff);
    return wide ? Uint32Array.from(out) : Uint16Array.from(out);
}

/**
 * The colour formats this can upload, each expanded to `bgra8unorm`.
 *
 * Five and six bit channels are widened by replicating their top bits into the
 * low ones, which is what maps the top value to 255 rather than to 248; a
 * shift alone darkens every texture by a step nothing else explains.
 *
 * @type {Readonly<Record<number, (pixels: Uint8Array, count: number)=>Uint8Array>>}
 */
const TEXEL_EXPANSION = Object.freeze({
    [D3DFMT.A8R8G8B8]: pixels=>pixels,
    [D3DFMT.X8R8G8B8]: (pixels, count)=>{
        // The fourth byte is undefined in memory and would sample as alpha.
        const out = new Uint8Array(pixels.subarray(0, count * 4));
        for (let at = 3; at < out.length; at += 4)
        {
            out[at] = 0xff;
        }
        return out;
    },
    [D3DFMT.R5G6B5]: (pixels, count)=>expandSixteen(pixels, count, word=>[
        five(word & 0x1f), six((word >>> 5) & 0x3f), five(word >>> 11), 0xff,
    ]),
    [D3DFMT.X1R5G5B5]: (pixels, count)=>expandSixteen(pixels, count, word=>[
        five(word & 0x1f), five((word >>> 5) & 0x1f), five((word >>> 10) & 0x1f), 0xff,
    ]),
    [D3DFMT.A1R5G5B5]: (pixels, count)=>expandSixteen(pixels, count, word=>[
        five(word & 0x1f), five((word >>> 5) & 0x1f), five((word >>> 10) & 0x1f),
        (word & 0x8000) !== 0 ? 0xff : 0,
    ]),
    [D3DFMT.A4R4G4B4]: (pixels, count)=>expandSixteen(pixels, count, word=>[
        four(word & 0xf), four((word >>> 4) & 0xf), four((word >>> 8) & 0xf),
        four(word >>> 12),
    ]),
    [D3DFMT.X4R4G4B4]: (pixels, count)=>expandSixteen(pixels, count, word=>[
        four(word & 0xf), four((word >>> 4) & 0xf), four((word >>> 8) & 0xf), 0xff,
    ]),
    [D3DFMT.A8]: (pixels, count)=>{
        const out = new Uint8Array(count * 4);
        for (let index = 0; index < count; index++)
        {
            out[index * 4 + 3] = pixels[index];
        }
        return out;
    },
    // Luminance is the colour, replicated across the three channels a
    // `bgra8unorm` texel reads from, and alpha is whatever the format carries
    // or opaque. A font atlas in one of these draws as glyphs, not as the
    // rectangle it is stored in, only because the grey and the coverage each
    // land in the channel the blend and the shader read.
    [D3DFMT.L8]: (pixels, count)=>{
        const out = new Uint8Array(count * 4);
        for (let index = 0; index < count; index++)
        {
            const value = pixels[index];
            out.set([value, value, value, 0xff], index * 4);
        }
        return out;
    },
    [D3DFMT.A8L8]: (pixels, count)=>{
        const out = new Uint8Array(count * 4);
        for (let index = 0; index < count; index++)
        {
            const value = pixels[index * 2];
            out.set([value, value, value, pixels[index * 2 + 1]], index * 4);
        }
        return out;
    },
    [D3DFMT.A4L4]: (pixels, count)=>{
        const out = new Uint8Array(count * 4);
        for (let index = 0; index < count; index++)
        {
            const packed = pixels[index];
            const value = four(packed & 0xf);
            out.set([value, value, value, four(packed >>> 4)], index * 4);
        }
        return out;
    },
});

/** @param {number} value five bits @returns {number} eight */
const five = value=>(value << 3) | (value >>> 2);
/** @param {number} value four bits @returns {number} eight */
const four = value=>(value << 4) | value;
/** @param {number} value six bits @returns {number} eight */
const six = value=>(value << 2) | (value >>> 4);

/**
 * @param {Uint8Array} pixels
 * @param {number} count
 * @param {(word: number)=>number[]} unpack  b, g, r, a of one little-endian word
 * @returns {Uint8Array}
 */
function expandSixteen(pixels, count, unpack){
    const out = new Uint8Array(count * 4);
    for (let index = 0; index < count; index++)
    {
        const word = pixels[index * 2] | (pixels[index * 2 + 1] << 8);
        out.set(unpack(word), index * 4);
    }
    return out;
}

/**
 * A texture level's bytes as they lie in guest memory, expanded to the one
 * format the backend samples.
 *
 * @param {number} format  D3DFMT
 * @param {Uint8Array} pixels
 * @param {number} count   Texels.
 * @returns {Uint8Array}
 */
export function expandTexels(format, pixels, count){
    const expand = TEXEL_EXPANSION[format];
    if (!expand)
    {
        throw new Error(`Texture format ${format} cannot be uploaded`);
    }
    return expand(pixels, count);
}

/** The WebGPU format every uncompressed colour target and texture is. */
export const COLOR_FORMAT = 'bgra8unorm';

/**
 * The block-compressed formats, by the D3DFMT they arrive as.
 *
 * These are uploaded as they lie rather than expanded: the blocks are what the
 * program has, the GPU samples them directly, and decompressing on the way
 * through would throw away both the memory saving and the work the program
 * already did to keep them compressed.
 *
 * DXT2 and DXT4 carry colour already multiplied by alpha. The block layout is
 * identical to DXT3 and DXT5 and WebGPU has no separate format for them, so
 * they sample as their unmultiplied siblings; a program that uses them gets a
 * picture whose blending is wrong where alpha is not one, and is told so.
 *
 * @type {Readonly<Record<number, string>>}
 */
export const COMPRESSED_FORMAT = Object.freeze({
    [D3DFMT.DXT1]: 'bc1-rgba-unorm',
    [D3DFMT.DXT2]: 'bc2-rgba-unorm',
    [D3DFMT.DXT3]: 'bc2-rgba-unorm',
    [D3DFMT.DXT4]: 'bc3-rgba-unorm',
    [D3DFMT.DXT5]: 'bc3-rgba-unorm',
});

/**
 * The S3TC block kind a DXTn format shares, for the layer's shared decoder
 * (`webgpu/internal/s3tc.js`): the block bits DXTn and S3TC name are
 * identical. DXT2/DXT4 decode as their unmultiplied siblings DXT3/DXT5, the
 * same substitution `COMPRESSED_FORMAT` already makes for the kept-compressed
 * path.
 *
 * @type {Readonly<Record<number, import('../webgpu/internal/s3tc.js').S3tcKind>>}
 */
const S3TC_OF = Object.freeze({
    [D3DFMT.DXT1]: 'dxt1',
    [D3DFMT.DXT2]: 'dxt3',
    [D3DFMT.DXT3]: 'dxt3',
    [D3DFMT.DXT4]: 'dxt5',
    [D3DFMT.DXT5]: 'dxt5',
});

/** @type {Readonly<Record<number, string>>} */
const DEPTH_FORMAT = Object.freeze({
    [D3DFMT.D16]: 'depth16unorm',
    [D3DFMT.D24X8]: 'depth24plus',
    [D3DFMT.D24S8]: 'depth24plus-stencil8',
    [D3DFMT.D32]: 'depth32float',
});

/**
 * Whether a compressed surface of this base size can be created as a BC
 * texture. WebGPU validates a compressed texture's own (base level) size
 * against the block size -- unlike a copy's tail mip, the base level itself
 * does not round up -- so a base narrower or shorter than one block (legal in
 * Direct3D, whose data is one block wide) must decode instead.
 *
 * @param {number} width @param {number} height
 */
const blockAligned = (width, height)=>width % 4 === 0 && height % 4 === 0;

/**
 * A compressed level decoded into the texel order every other format is
 * expanded to: the decoder answers R, G, B, A and the textures here are
 * `bgra8unorm`, so the two end bytes change places -- missed, every DXT
 * texture on a GPU without block compression (an Apple GPU, a software
 * rasteriser) is drawn with red and blue exchanged and nothing else wrong.
 *
 * `decodeS3tc` answers null only when the bytes are too few for the shape,
 * which cannot happen here: every caller reads exactly `surfaceBytes` worth,
 * the same block-rounded count `decodeS3tc` requires.
 *
 * @param {Uint8Array} bytes
 * @param {import('../webgpu/internal/s3tc.js').S3tcKind} kind
 * @param {number} width @param {number} height
 * @returns {Uint8Array}
 */
const decodeCompressed = (bytes, kind, width, height)=>{
    const decoded = /** @type {Uint8Array} */ (decodeS3tc(bytes, kind, width, height));
    for (let at = 0; at < decoded.length; at += 4)
    {
        const red = decoded[at];
        decoded[at] = decoded[at + 2];
        decoded[at + 2] = red;
    }
    return decoded;
};

/**
 * @param {number} format  D3DFMT
 * @param {number} width @param {number} height  the surface's base level
 * @param {boolean} compressedTextures  whether the device keeps BC blocks at all;
 *           off, every level decodes to `COLOR_FORMAT` regardless of alignment
 * @returns {string} the WebGPU format a surface of it is created as
 */
export function gpuFormatOf(format, width, height, compressedTextures){
    const info = FORMAT_INFO[format];
    if (!info)
    {
        throw new Error(`Surface format ${format} has no backend counterpart`);
    }
    if (!info.depth)
    {
        const compressed = COMPRESSED_FORMAT[format];
        return compressed && compressedTextures && blockAligned(width, height)
            ? compressed
            : COLOR_FORMAT;
    }
    const depth = DEPTH_FORMAT[format];
    if (!depth)
    {
        throw new Error(`Depth format ${format} has no backend counterpart`);
    }
    return depth;
}

/** @param {string} format a WebGPU depth format */
const hasStencil = format=>format.endsWith('stencil8');

/**
 * Where each field of the uniform block begins, counted in floats.
 *
 * This is WGSL's own layout for the struct the generator declares, worked out
 * once here rather than at each `set`: two mat4x4f, two vec2f, ten vec4f, an
 * f32 with three u32 in its padding, six vec4f of texture transform rows, and
 * then the lights, which start at the next multiple of four floats because a
 * uniform array is aligned to sixteen bytes. A field written at the wrong
 * index is read as a different one, and every one of them is a plausible
 * number, so nothing reports it.
 */
export const UNIFORM_AT = Object.freeze({
    worldViewProjection: 0,
    world: 16,
    viewportOffset: 32,
    viewportScale: 34,
    textureFactor: 36,
    fogColor: 40,
    fogFactors: 44,
    materialDiffuse: 48,
    materialAmbient: 52,
    materialSpecular: 56,
    materialEmissive: 60,
    ambient: 64,
    eye: 68,
    alphaRef: 72,
    // Three scalars in the padding after alphaRef: the sampler state of the
    // first three stages, packed as the shader unpacks it.
    stage0: 73,
    stage1: 74,
    stage2: 75,
    // Four vec4f rows per stage for every stage, the matrix by columns:
    // (m11, m21, m31, m41) makes u, (m12, m22, m32, m42) makes v -- from
    // (u, v, 1) for a carried set, from (x, y, z, 1) for a generated
    // coordinate, which also takes the third and fourth for a projective
    // divide.
    textureTransforms: 76,
    // World then view: the camera space a generated coordinate is taken in.
    worldView: 204,
    lights: 220,
});

/** How many stages the block carries sampler state for. */
export const SAMPLED_STAGES = 3;

/** How many stages the block carries a texture transform for: every one. */
export const TRANSFORM_STAGES = STAGE_COUNT;

/** The block's own length, before any light is appended. */
export const UNIFORM_FLOATS = UNIFORM_AT.lights;

/** Floats one light occupies: the seven vec4f rows of the shader's `Light`. */
export const LIGHT_FLOATS = 28;

/** @type {Material} the material a block carries when nothing lights it */
const NO_MATERIAL = Object.freeze({
    Diffuse: { r: 0, g: 0, b: 0, a: 0 },
    Ambient: { r: 0, g: 0, b: 0, a: 0 },
    Specular: { r: 0, g: 0, b: 0, a: 0 },
    Emissive: { r: 0, g: 0, b: 0, a: 0 },
    Power: 0,
});

/**
 * One light, written into the block where the shader's array expects it.
 *
 * Two things are computed here rather than per vertex because they are constant
 * for the light: the direction is normalised (a zero-length one stays zero, so
 * the light contributes nothing instead of a not-a-number), and the cone is
 * carried as the cosines of its half-angles.
 *
 * @param {Float32Array} block
 * @param {number} at    the first float of this light's rows
 * @param {Light} light
 */
export function packLight(block, at, light){
    putColour(block, at, light.Diffuse);
    putColour(block, at + 4, light.Specular);
    putColour(block, at + 8, light.Ambient);
    put4(block, at + 12, light.Position.x, light.Position.y, light.Position.z, light.Range);
    const { x, y, z } = light.Direction;
    const length = Math.sqrt(x * x + y * y + z * z);
    if (length > 0)
    {
        put4(block, at + 16, x / length, y / length, z / length, 0);
    }
    else
    {
        put4(block, at + 16, 0, 0, 0, 0);
    }
    put4(block, at + 20, light.Attenuation0, light.Attenuation1, light.Attenuation2, 0);
    put4(block, at + 24, Math.cos(light.Theta / 2), Math.cos(light.Phi / 2), light.Falloff, 0);
}

/**
 * Four floats into a block, without an array to carry them: a draw packs
 * dozens, and a frame has hundreds of draws.
 *
 * @param {Float32Array} block @param {number} at
 * @param {number} a @param {number} b @param {number} c @param {number} d
 */
function put4(block, at, a, b, c, d){
    block[at] = a;
    block[at + 1] = b;
    block[at + 2] = c;
    block[at + 3] = d;
}

/** @param {Float32Array} block @param {number} at @param {ColourValue} colour */
function putColour(block, at, colour){
    put4(block, at, colour.r, colour.g, colour.b, colour.a);
}

/** A D3DCOLOR into a block, as four floats. @param {Float32Array} block @param {number} at @param {number} dword */
function putDword(block, at, dword){
    putColour(block, at, colorToFloats(dword));
}

/**
 * @typedef {Object} UniformValues
 * @property {ArrayLike<number>} worldViewProjection
 * @property {import('../webgpu/contract.js').ViewportState} viewport
 * @property {number} textureFactor  D3DCOLOR
 * @property {number} fogColor       D3DCOLOR
 * @property {number} alphaRef       0..255
 * @property {ArrayLike<number>} [world]   Identity unless the draw is lit.
 * @property {Material} [material]
 * @property {number[]} [fogFactors] Fog start, end and density, as floats.
 * @property {number[]} [stages]     Packed sampler state per stage; see `samplerFlagsOf`.
 * @property {(readonly number[])[]} [textureTransforms]
 *     Per stage, the sixteen elements in `PLANAR_ROWS` order; identity when absent.
 * @property {ArrayLike<number>} [worldView]  Identity unless a stage generates coordinates.
 * @property {number} [ambient]      D3DCOLOR, the scene's own ambient light.
 * @property {readonly number[]} [eye]     Camera position in world space.
 * @property {readonly Light[]} [lights]
 */

/**
 * @param {UniformValues} values
 * @param {(floats: number) => Float32Array} [take]
 *     Where the block's floats come from; a fresh array when not given.
 * @returns {Float32Array}
 */
export function uniformBlock(values, take = floats=>new Float32Array(floats)){
    const at = UNIFORM_AT;
    const lights = values.lights ?? [];
    const block = take(UNIFORM_FLOATS + lights.length * LIGHT_FLOATS);
    block.set(values.worldViewProjection, at.worldViewProjection);
    block.set(values.world ?? IDENTITY, at.world);
    block.set(values.viewport.offset, at.viewportOffset);
    block.set(values.viewport.scale, at.viewportScale);
    putDword(block, at.textureFactor, values.textureFactor);
    putDword(block, at.fogColor, values.fogColor);
    // Start, end and density, which is everything the three fog curves need;
    // which curve is in force shaped the shader and is not carried here.
    const fog = values.fogFactors ?? [0, 1, 1];
    put4(block, at.fogFactors, fog[0], fog[1], fog[2], 0);
    const material = values.material ?? NO_MATERIAL;
    putColour(block, at.materialDiffuse, material.Diffuse);
    putColour(block, at.materialAmbient, material.Ambient);
    putColour(block, at.materialSpecular, material.Specular);
    putColour(block, at.materialEmissive, material.Emissive);
    putDword(block, at.ambient, values.ambient ?? 0);
    // The specular power rides in the eye row: it is one float, and a row of
    // its own would cost sixteen bytes to carry four.
    const eye = values.eye ?? [0, 0, 0];
    put4(block, at.eye, eye[0], eye[1], eye[2], material.Power);
    block[at.alphaRef] = values.alphaRef / 255;
    // Raw bit patterns, not colours: the shader reads these fields as u32.
    const stages = values.stages ?? [];
    const words = new Uint32Array(block.buffer, block.byteOffset, block.length);
    for (let index = 0; index < SAMPLED_STAGES; index++)
    {
        words[at.stage0 + index] = (stages[index] ?? 0) >>> 0;
    }
    const transforms = values.textureTransforms ?? [];
    for (let index = 0; index < TRANSFORM_STAGES; index++)
    {
        block.set(transforms[index] ?? PLANAR_IDENTITY, at.textureTransforms + index * 16);
    }
    block.set(values.worldView ?? IDENTITY, at.worldView);
    for (let index = 0; index < lights.length; index++)
    {
        packLight(block, at.lights + index * LIGHT_FLOATS, lights[index]);
    }
    return block;
}

/**
 * Where a frame's uniform blocks are laid: one array the frame's draws take
 * their blocks out of in turn, kept from frame to frame. A block is read at
 * replay, after the frame is recorded, so the arena is the recording's until
 * then and goes back to the pool after.
 *
 * @param {number} [floats]
 */
export function createUniformArena(floats = 1 << 16){
    let storage = new Float32Array(floats);
    let used = 0;
    return {
        reset(){
            used = 0;
        },
        /** @param {number} count @returns {Float32Array} */
        take(count){
            // The arena outgrown: the draws recorded so far keep their views
            // of the old array, which the old array keeps alive for them.
            if (used + count > storage.length)
            {
                storage = new Float32Array(Math.max(storage.length * 2, used + count));
                used = 0;
            }
            const block = storage.subarray(used, used + count);
            block.fill(0);
            // Blocks are bound at a 256-byte alignment on the GPU side; kept
            // here at a 4-float one, which every field of a block already has.
            used += Math.ceil(count / 4) * 4;
            return block;
        },
    };
}

/**
 * Where the camera is, in world space, which is where the lighting equation
 * needs it and is not what any matrix holds directly.
 *
 * The view matrix takes world space to camera space, so the camera is the point
 * it sends to the origin: `-translation * inverse(rotation)`. The full inverse
 * of the upper 3x3 is computed rather than its transpose -- the transpose is
 * only the inverse for a matrix with no scale in it, and a view matrix that
 * mirrors or scales would otherwise put the camera somewhere else entirely.
 *
 * @param {ArrayLike<number>} view
 * @returns {number[]} x, y, z
 */
export function eyePosition(view){
    const a = view[0], b = view[1], c = view[2];
    const d = view[4], e = view[5], f = view[6];
    const g = view[8], h = view[9], i = view[10];
    const cofactor = [e * i - f * h, f * g - d * i, d * h - e * g];
    const determinant = a * cofactor[0] + b * cofactor[1] + c * cofactor[2];
    if (determinant === 0)
    {
        return [0, 0, 0];
    }
    const inverse = [
        cofactor[0], c * h - b * i, b * f - c * e,
        cofactor[1], a * i - c * g, c * d - a * f,
        cofactor[2], b * g - a * h, a * e - b * d,
    ].map(value=>value / determinant);
    const t = [view[12], view[13], view[14]];
    return [0, 1, 2].map(column=>{
        const along = t[0] * inverse[column] + t[1] * inverse[3 + column]
            + t[2] * inverse[6 + column];
        // Negating zero gives negative zero, which is the same camera and a
        // worse thing to read in a diagnostic.
        return along === 0 ? 0 : -along;
    });
}

/**
 * @typedef {Object} RenderModel
 *     What the renderer reads from the device at the moment of a draw. Every
 *     member is a live view, not a copy: the device owns the state and this is
 *     only how it is reached.
 * @property {Map<number, number>} renderStates
 * @property {(stage: number)=>Map<number, number>} stageStates
 * @property {Map<number, any>} textures
 * @property {{ buffer: any, stride: number }} stream       Stream zero.
 * @property {any} indices
 * @property {number} baseVertexIndex
 * @property {import('../webgpu/contract.js').ViewportState} viewport
 * @property {any} renderTarget
 * @property {any} depthStencil
 * @property {Map<number, Float32Array>} transforms
 * @property {Map<number, { light: Light, enabled: boolean }>} lights
 * @property {number} [lightsVersion]   Raised whenever `lights` changes.
 * @property {number} [drawStateVersion]
 *     Raised by every state change a draw's preparation depends on, so that the
 *     preparation happens once per change rather than once per draw. The world
 *     transform is the one state it deliberately ignores -- it moves between
 *     most draws, and a counter it raised would never hold still -- so whoever
 *     reads this owes the world matrix a fresh read on every draw. A device
 *     that does not offer it is prepared for on every draw, as before.
 * @property {number} [stateVersionBesideTextures]
 *     Raised by every change `drawStateVersion` counts except a texture
 *     binding, so the part of a preparation's key that bindings do not reach is
 *     built once per such change rather than once per draw.
 * @property {Material} material
 * @property {any} backBuffer                                What Present shows.
 * @property {{ vertexShader: number, fvf: number, pixelShader: number,
 *              program?: ProgramState | null,
 *              fixedFunctionLayout?: import('../d3d9/declaration.js').FixedFunctionLayout | null
 *            }} stageProcessing
 *     `fixedFunctionLayout` is how the fixed-function stage reads a bound
 *     declaration that no vertex format spells (`fvf` is then zero).
 *     `program` is what a device that makes shader objects hands over: the
 *     parsed shaders, the declaration and the constant files. Absent, a bound
 *     shader is a draw this renderer declines.
 */

/**
 * @typedef {Object} ProgramState
 *     The programmable half of a draw, as the device holds it.
 * @property {import('../d3d9/shader.js').ParsedShader | null} vertex
 * @property {object | null} vertexShader   The shader object, for caching by identity.
 * @property {number} vertexId
 * @property {import('../d3d9/shader.js').ParsedShader | null} pixel
 * @property {object | null} pixelShader
 * @property {number} pixelId
 * @property {readonly import('../webgpu/internal/programmable.js').VertexElement[] | null}
 *           declaration
 * @property {number} declarationId
 * @property {{ floats: Float32Array, ints: Int32Array, bools: Uint32Array }} vertexConstants
 * @property {{ floats: Float32Array, ints: Int32Array, bools: Uint32Array }} pixelConstants
 */

/**
 * @param {RenderModel} model
 * @param {number} type D3DTS
 * @returns {ArrayLike<number>}
 */
const transformOf = (model, type)=>model.transforms.get(type) ?? IDENTITY;

/**
 * The lights a draw is lit by: every enabled one, in index order.
 *
 * The order is the index order and not the order they were set, because the
 * shader unrolls one block per light and two draws that enabled the same lights
 * in a different order must not compile two pipelines.
 *
 * @param {RenderModel} model
 * @returns {Light[]}
 */
export function enabledLights(model){
    const kept = enabledLightsKept.get(model);
    if (kept && kept.version === model.lightsVersion && model.lightsVersion !== undefined)
    {
        return kept.lights;
    }
    const lights = [...model.lights.entries()]
        .filter(([, record])=>record.enabled)
        .sort(([left], [right])=>left - right)
        .map(([, record])=>record.light);
    if (model.lightsVersion !== undefined)
    {
        enabledLightsKept.set(model, { version: model.lightsVersion, lights });
    }
    return lights;
}

/**
 * The enabled lights of each model as last listed, with the version they
 * were listed at: a draw asks three times, and a frame has hundreds.
 *
 * @type {WeakMap<object, { version: number, lights: Light[] }>}
 */
const enabledLightsKept = new WeakMap();

/**
 * What the vertex stage lights this draw with, or null when it lights nothing.
 *
 * Three things switch lighting off, and only one of them is the render state.
 * A pre-transformed vertex is past the point where lighting happens, and a
 * vertex with no normal has no surface to light -- which Direct3D leaves
 * undefined, and where carrying the vertex colour through is the reading that
 * keeps such a draw looking like it did rather than turning it black.
 *
 * @param {RenderModel} model
 * @param {import('../webgpu/internal/vertexformat.js').VertexLayout} layout
 * @returns {import('../webgpu/internal/pipeline.js').LightingState | null}
 */
export function lightingOf(model, layout){
    const rs = (/** @type {string} */ name)=>model.renderStates.get(D3DRS[name]) ?? 0;
    const lit = rs('LIGHTING') !== 0
        && !layout.preTransformed
        && layout.attributes.some(attribute=>attribute.name === 'normal');
    if (!lit)
    {
        return null;
    }
    return {
        lights: enabledLights(model).map(light=>light.Type),
        colorVertex: rs('COLORVERTEX') !== 0,
        diffuseSource: rs('DIFFUSEMATERIALSOURCE'),
        ambientSource: rs('AMBIENTMATERIALSOURCE'),
        specularSource: rs('SPECULARMATERIALSOURCE'),
        emissiveSource: rs('EMISSIVEMATERIALSOURCE'),
    };
}

/**
 * @param {RenderModel} model
 * @param {import('../webgpu/internal/pipeline.js').LightingState | null} [lighting]
 * @param {(floats: number) => Float32Array} [take]  Where the block's floats come from.
 * @param {boolean} [mips]  False pins every sample to the top level.
 * @returns {Float32Array} the block an ordinary draw carries
 */
export function uniformsOf(model, lighting, take, mips = true){
    const rs = (/** @type {string} */ name)=>model.renderStates.get(D3DRS[name]) ?? 0;
    const world = transformOf(model, D3DTS.WORLD);
    const view = transformOf(model, D3DTS.VIEW);
    const worldView = multiplyMatrices(world, view, WORLD_VIEW);
    return uniformBlock({
        worldViewProjection: multiplyMatrices(
            worldView, transformOf(model, D3DTS.PROJECTION), WORLD_VIEW_PROJECTION),
        world,
        worldView,
        viewport: model.viewport,
        textureFactor: rs('TEXTUREFACTOR'),
        fogColor: rs('FOGCOLOR'),
        // Held as DWORDs like every other render state, and floats to everyone
        // who uses them. A fog that fades over the wrong distance is the same
        // picture as no fog at all when the range is huge, and a white frame
        // when it is tiny.
        fogFactors: [
            dwordToFloat(rs('FOGSTART')),
            dwordToFloat(rs('FOGEND')),
            dwordToFloat(rs('FOGDENSITY')),
        ],
        alphaRef: rs('ALPHAREF'),
        stages: stageFlags(model, mips),
        textureTransforms: stageTransforms(model),
        material: model.material,
        ambient: rs('AMBIENT'),
        eye: eyePosition(view),
        // The shader declares an array exactly as long as the lighting state
        // said, so a block that carried lights it does not know about would be
        // read past its own end.
        lights: lighting ? enabledLights(model) : [],
    }, take);
}

/**
 * The transform of each sampled stage, when the stage's flags are ones the
 * sampler applies (`transformApplies`). Any other -- one coordinate, a
 * projective divide of a carried set -- is not applied and is reported per
 * draw.
 *
 * @param {RenderModel} model
 */
const stageTransforms = model=>{
    /** @type {(readonly number[])[]} */
    const transforms = [];
    for (let index = 0; index < TRANSFORM_STAGES; index++)
    {
        const states = model.stageStates(index);
        const flags = states?.get(D3DTSS.TEXTURETRANSFORMFLAGS) ?? 0;
        const matrix = model.transforms.get(D3DTS.TEXTURE0 + index);
        const generated = generates(states?.get(D3DTSS.TEXCOORDINDEX) ?? 0);
        transforms.push(transformApplies(flags, generated) && matrix
            ? PLANAR_ROWS.map(at=>matrix[at])
            : PLANAR_IDENTITY);
    }
    return transforms;
};

/** @param {RenderModel} model @param {boolean} mips */
const stageFlags = (model, mips)=>{
    const flags = [];
    for (let index = 0; index < SAMPLED_STAGES; index++)
    {
        flags.push(samplerFlagsOf(model.stageStates(index), mips));
    }
    return flags;
};

/** Scratch for the two products every draw forms; copied into the block at once. */
const WORLD_VIEW = new Float32Array(16);
const WORLD_VIEW_PROJECTION = new Float32Array(16);

/** What a preparation's block field holds before its first draw writes one. */
const EMPTY_BLOCK = new Float32Array(0);

/**
 * Why a cascade stopped before the program's stages ran out.
 *
 * @typedef {Object} CascadeTruncation
 * @property {number} stage  the stage that ended it
 * @property {'texture' | 'coordSet'} reason
 * @property {string} detail  the stage's state, for a report to name
 */

/**
 * The stage cascade a draw runs, and which texture each stage samples.
 *
 * The cascade ends at the first stage whose colour operation is off. It also
 * ends at a stage that reads the texture argument with nothing bound there, or
 * with no such coordinate set in the vertex: the generated shader would
 * otherwise sample a binding that does not exist, and a program that binds one
 * texture and leaves stage zero at its default expects that texture drawn, not
 * a refusal.
 *
 * Only the arguments the two operations actually read count. Stage state
 * persists across draws, so an unread slot holds whatever an earlier draw put
 * there; treating a stale D3DTA_TEXTURE in one as a demand for a texture ends
 * the cascade at a stage that never wanted one, and the draw loses its
 * texturing with the rest of the picture intact.
 *
 * @param {RenderModel} model
 * @param {import('../webgpu/internal/vertexformat.js').VertexLayout} layout
 * @returns {{ stages: import('../webgpu/internal/pipeline.js').StageKey[],
 *             textures: (any | null)[], truncated: CascadeTruncation | null }}
 */
export function stageCascade(model, layout){
    /** @type {import('../webgpu/internal/pipeline.js').StageKey[]} */
    const stages = [];
    /** @type {(any | null)[]} */
    const textures = [];
    for (let stage = 0; stage < STAGE_COUNT; stage++)
    {
        const states = model.stageStates(stage);
        const get = (/** @type {number} */ state)=>states.get(state) ?? 0;
        const colorOp = get(D3DTSS.COLOROP);
        if (colorOp === D3DTOP.DISABLE)
        {
            break;
        }
        const texCoordIndex = get(D3DTSS.TEXCOORDINDEX);
        const transformFlags = get(D3DTSS.TEXTURETRANSFORMFLAGS);
        const key = {
            colorOp,
            colorArg1: get(D3DTSS.COLORARG1),
            colorArg2: get(D3DTSS.COLORARG2),
            alphaOp: get(D3DTSS.ALPHAOP),
            alphaArg1: get(D3DTSS.ALPHAARG1),
            alphaArg2: get(D3DTSS.ALPHAARG2),
            texCoordIndex,
            // A projected generated coordinate is divided by its third or
            // fourth component at the sample, which is the count's last.
            projected: generates(texCoordIndex) && (transformFlags & TTFF_PROJECTED) !== 0
                && (transformFlags & TTFF_COUNT_MASK) >= 3
                ? Math.min(transformFlags & TTFF_COUNT_MASK, 4)
                : 0,
        };
        const selectors = [
            ...argumentsRead(key.colorOp, key.colorArg1, key.colorArg2),
            ...argumentsRead(key.alphaOp, key.alphaArg1, key.alphaArg2),
        ];
        const samples = selectors.some(arg=>(arg & D3DTA_SELECTMASK) === D3DTA.TEXTURE);
        const texture = model.textures.get(stage) ?? null;
        const coordSet = key.texCoordIndex & COORD_SET_MASK;
        const carried = generates(key.texCoordIndex) || coordSet < layout.texCoordSets;
        if (samples && (!texture || !carried))
        {
            return {
                stages,
                textures,
                truncated: {
                    stage,
                    reason: texture ? 'coordSet' : 'texture',
                    detail: `${key.colorOp}(${key.colorArg1},${key.colorArg2})`
                        + `/${key.alphaOp}(${key.alphaArg1},${key.alphaArg2})`
                        + ` tci=${key.texCoordIndex} sets=${layout.texCoordSets}`,
                },
            };
        }
        stages.push(key);
        textures.push(samples ? texture : null);
    }
    return { stages, textures, truncated: null };
}

/**
 * The fog mode a draw runs under: the table mode when the program set one,
 * else the vertex mode, and none when fog is disabled or a caller turned it
 * off. Table fog takes precedence at the API's own rule.
 *
 * @param {RenderModel} model
 * @param {boolean} [applied]  False runs the draw as if fog were disabled.
 * @returns {number} D3DFOG; NONE is 0.
 */
export function fogModeOf(model, applied = true){
    const rs = (/** @type {string} */ name)=>model.renderStates.get(D3DRS[name]) ?? 0;
    if (!applied || rs('FOGENABLE') === 0)
    {
        return D3DFOG.NONE;
    }
    return rs('FOGTABLEMODE') || rs('FOGVERTEXMODE');
}

/**
 * The render state of a draw, as the pipeline cache keys it.
 *
 * The two paired blend modes are expanded here: they set both factors from one
 * value, and the pipeline table refuses them by name rather than guessing.
 *
 * @param {RenderModel} model
 * @param {Object} shape
 * @param {number} shape.fvf
 * @param {import('../webgpu/internal/vertexformat.js').VertexLayout} [shape.vertexLayout]
 * @param {string} [shape.vertexLayoutKey]
 * @param {string} shape.topology
 * @param {string} shape.targetFormat
 * @param {boolean} [shape.targetHasAlpha]
 *     Whether the target's Direct3D format has an alpha channel at all.
 * @param {boolean} [shape.fog]  Whether fog is applied at all; see RendererOptions.
 * @param {string | undefined} shape.depthFormat
 * @param {import('../webgpu/internal/pipeline.js').StageKey[]} shape.stages
 * @param {import('../webgpu/internal/pipeline.js').LightingState | null} [shape.lighting]
 * @returns {import('../webgpu/internal/pipeline.js').PipelineState}
 */
export function pipelineStateOf(model, shape){
    const rs = (/** @type {string} */ name)=>model.renderStates.get(D3DRS[name]) ?? 0;
    let srcBlend = rs('SRCBLEND');
    let destBlend = rs('DESTBLEND');
    if (srcBlend === D3DBLEND.BOTHSRCALPHA)
    {
        srcBlend = D3DBLEND.SRCALPHA;
        destBlend = D3DBLEND.INVSRCALPHA;
    }
    else if (srcBlend === D3DBLEND.BOTHINVSRCALPHA)
    {
        srcBlend = D3DBLEND.INVSRCALPHA;
        destBlend = D3DBLEND.SRCALPHA;
    }
    const fogMode = fogModeOf(model, shape.fog !== false);

    return {
        fvf: shape.fvf,
        vertexShader: 0,
        pixelShader: 0,
        targetFormat: shape.targetFormat,
        depthFormat: shape.depthFormat,
        topology: shape.topology,
        depthTest: shape.depthFormat !== undefined && rs('ZENABLE') !== D3DZB.FALSE,
        depthWrite: shape.depthFormat !== undefined && rs('ZWRITEENABLE') !== 0,
        depthFunc: rs('ZFUNC'),
        cullMode: rs('CULLMODE'),
        blend: rs('ALPHABLENDENABLE') !== 0,
        srcBlend,
        destBlend,
        blendOp: rs('BLENDOP'),
        // A target whose format has no alpha channel must not be written with
        // one. Every backend renders into four channels because three-channel
        // targets do not exist, so the channel the program was told is absent
        // is physically there -- and a blend that touches it decides how
        // opaque the presented frame is, which nothing in the picture explains.
        colorWrite: rs('COLORWRITEENABLE')
            & (shape.targetHasAlpha === false ? ~COLORWRITEENABLE_ALPHA : ~0),
        alphaTest: rs('ALPHATESTENABLE') !== 0,
        alphaFunc: rs('ALPHAFUNC'),
        fogMode,
        stages: shape.stages,
        // Specular is a fragment-stage decision as much as a lighting one: the
        // vertex's specular colour is added after the cascade whether lighting
        // computed it or the program supplied it.
        specularEnable: rs('SPECULARENABLE') !== 0,
        lighting: shape.lighting ?? null,
        ...(shape.vertexLayout ? {
            vertexLayout: shape.vertexLayout,
            vertexLayoutKey: shape.vertexLayoutKey,
        } : {}),
    };
}

/** @type {Readonly<Record<number, string>>} */
const FILTER = Object.freeze({
    [D3DTEXF.NONE]: 'nearest',
    [D3DTEXF.POINT]: 'nearest',
    [D3DTEXF.LINEAR]: 'linear',
    [D3DTEXF.ANISOTROPIC]: 'linear',
});

/** @type {Readonly<Record<number, string>>} */
const ADDRESS = Object.freeze({
    [D3DTADDRESS.WRAP]: 'repeat',
    [D3DTADDRESS.MIRROR]: 'mirror-repeat',
    [D3DTADDRESS.CLAMP]: 'clamp-to-edge',
    [D3DTADDRESS.BORDER]: 'clamp-to-edge',
    [D3DTADDRESS.MIRRORONCE]: 'mirror-repeat',
});

/**
 * @param {Map<number, number>} states  one stage's states
 * @param {boolean} [mips]  False pins every sample to the top level.
 * @returns {{ magFilter: string, minFilter: string, mipmapFilter: string,
 *             addressModeU: string, addressModeV: string,
 *             lodMinClamp: number, lodMaxClamp: number }}
 */
export function samplerDescriptorOf(states, mips = true){
    const get = (/** @type {number} */ state)=>states.get(state) ?? 0;
    const mipFilter = mips ? get(D3DTSS.MIPFILTER) : D3DTEXF.NONE;
    return {
        magFilter: FILTER[get(D3DTSS.MAGFILTER)] ?? 'nearest',
        minFilter: FILTER[get(D3DTSS.MINFILTER)] ?? 'nearest',
        mipmapFilter: FILTER[mipFilter] ?? 'nearest',
        addressModeU: ADDRESS[get(D3DTSS.ADDRESSU)] ?? 'repeat',
        addressModeV: ADDRESS[get(D3DTSS.ADDRESSV)] ?? 'repeat',
        // D3DTEXF_NONE for the mip filter means the top level alone, however
        // many the texture has; the finest level a program allows is the
        // nearest it lets a sample come.
        lodMinClamp: get(D3DTSS.MAXMIPLEVEL),
        lodMaxClamp: mipFilter === D3DTEXF.NONE ? 0 : LOD_MAX,
    };
}

/** WebGPU's own default for the far end of the level range. */
const LOD_MAX = 32;

/** D3DTADDRESS, as the shader's two-bit address mode. */
/** @type {Readonly<Record<number, number>>} */
const ADDRESS_BITS = Object.freeze({
    [D3DTADDRESS.WRAP]: 0,
    [D3DTADDRESS.MIRROR]: 1,
    [D3DTADDRESS.CLAMP]: 2,
    [D3DTADDRESS.BORDER]: 2,
    [D3DTADDRESS.MIRRORONCE]: 1,
});

/**
 * A stage's sampler state packed for the shader, which applies it itself.
 *
 * Every draw samples through one hardware sampler -- linear, repeating,
 * whole mip chain -- and the state a program set per stage is carried in the
 * uniform block instead: address mode per axis (bits 0-3), point filtering
 * for magnification and minification (bits 4-5), the mip mode (bits 6-7:
 * none, point, linear) and the most detailed level allowed (bits 8-15).
 * Measured reason: a device was seen to keep one sampler in force for every
 * draw of a run regardless of the group each draw bound, for stretches of
 * frames at a time, so a picture whose sampling depends on which sampler is
 * bound is not a picture the device can be trusted with.
 *
 * @param {Map<number, number>} states  one stage's states
 * @param {boolean} [mips]  False pins every sample to the top level.
 * @returns {number}
 */
export function samplerFlagsOf(states, mips = true){
    const get = (/** @type {number} */ state)=>states.get(state) ?? 0;
    const mipFilter = mips ? get(D3DTSS.MIPFILTER) : D3DTEXF.NONE;
    const mipMode = mipFilter === D3DTEXF.LINEAR ? 2 : mipFilter === D3DTEXF.NONE ? 0 : 1;
    const point = (/** @type {number} */ filter)=>
        filter === D3DTEXF.LINEAR || filter === D3DTEXF.ANISOTROPIC ? 0 : 1;
    return (ADDRESS_BITS[get(D3DTSS.ADDRESSU)] ?? 0)
        | ((ADDRESS_BITS[get(D3DTSS.ADDRESSV)] ?? 0) << 2)
        | (point(get(D3DTSS.MAGFILTER)) << 4)
        | (point(get(D3DTSS.MINFILTER)) << 5)
        | (mipMode << 6)
        | ((Math.min(255, Math.max(0, get(D3DTSS.MAXMIPLEVEL))) & 0xff) << 8);
}

/** The one sampler every draw samples through; the state is in the shader. */
export const HARDWARE_SAMPLER = Object.freeze({
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
    lodMinClamp: 0,
    lodMaxClamp: LOD_MAX,
});

/**
 * @param {number} flags D3DLOCK
 * @param {any} LockFlags the backend's
 * @returns {number}
 */
const lockFlagsOf = (flags, LockFlags)=>{
    if ((flags & D3DLOCK.DISCARD) !== 0)
    {
        return LockFlags.DISCARD;
    }
    if ((flags & D3DLOCK.NOOVERWRITE) !== 0)
    {
        return LockFlags.NOOVERWRITE;
    }
    return LockFlags.NONE;
};

/** @param {any} surface @returns {import('../d3d9/resources.js').SurfaceDesc} */
const describe = surface=>{
    /** @type {{ desc?: any }} */
    const out = {};
    surface.GetDesc(out);
    return out.desc;
};

/** One D3DRECT, clipped to another. @param {any} rect @param {any} bounds */
const clip = (rect, bounds)=>({
    x1: Math.max(rect.x1, bounds.x1),
    y1: Math.max(rect.y1, bounds.y1),
    x2: Math.min(rect.x2, bounds.x2),
    y2: Math.min(rect.y2, bounds.y2),
});

/** Bytes to the next multiple of four, which every buffer offset here must be. */
const alignUp = (/** @type {number} */ bytes)=>(bytes + 3) & ~3;

/** The vertex a clear quad is made of: x, y, z, rhw and a D3DCOLOR. */
const CLEAR_FVF = FVF.XYZRHW | FVF.DIFFUSE;
const CLEAR_STRIDE = 20;

/**
 * @typedef {Object} RendererOptions
 * @property {any} backend
 * @property {(address: number, length: number)=>Uint8Array} readMemory
 * @property {(address: number, length: number)=>Uint8Array} [windowMemory]
 *     The same bytes without the copy, for a reader that is done with them
 *     before the guest runs again. Absent, a copy is read.
 * @property {((descriptor: any)=>any) | null} [createSampler]
 *     The backend has no sampler of its own yet, so one is borrowed from
 *     whoever assembled the device. A textured draw without it is refused
 *     loudly rather than drawn white.
 * @property {boolean} [dumpDraws]
 *     Record where every draw of the last frame landed and what state it ran
 *     under. Off by default: it transforms every vertex of every draw a second
 *     time on the processor, which is a cost an ordinary run must not pay.
 * @property {number} [maxDraws]
 *     Record only this many draws of each frame and drop the rest. Negative --
 *     the default -- keeps all of them. A frame dump says which draws could
 *     have painted a region; cutting the frame short is what says which one
 *     did, because the region is either there or not at each cut.
 * @property {((api: string, detail: string)=>void) | null} [divergence]
 *     Where "this call succeeded and did not do all of what it promises" goes.
 * @property {boolean} [fog]
 *     Whether fog is applied at all; on by default. Off, every draw runs the
 *     shader it would run with D3DRS_FOGENABLE clear, which is how a picture
 *     washed towards the fog colour is told apart from one washed by something
 *     else -- two runs then differ by fog and nothing else.
 * @property {boolean} [mips]
 *     Whether a sample may come from a level below the top; on by default.
 *     Off, every texture is sampled at its top level whatever the program
 *     asked, so two runs differ by the mip chain and nothing else.
 * @property {string | null} [probeTexture]
 *     Copy the colour target out right after each dumped draw that samples the
 *     texture with this dump id, inside the frame, and put a few of its pixels
 *     on the draw's line. What a draw painted is otherwise only knowable from
 *     the finished frame, where every later draw has had its say.
 * @property {string | null} [skipTexture]
 *     Drop every draw that samples the texture with this dump id. A draw's
 *     position in a frame moves between runs and its bound texture does not,
 *     so this is what lets the same draw be removed from two runs and the
 *     frames compared -- which is the only way to see what one draw paints.
 * @property {boolean} [compressedTextures]
 *     Whether a DXT surface uploads as BC blocks (true, when its base is also
 *     block-aligned) or decodes to `bgra8unorm` (false, the default). Never
 *     whether a DXT surface may be created -- that is always legal.
 */

/**
 * @param {RendererOptions} options
 * @returns {any}
 */
export function createRenderer(options){
    const { backend, readMemory } = options;
    const windowMemory = options.windowMemory ?? readMemory;
    const createSampler = options.createSampler ?? null;
    const dumpDraws = options.dumpDraws === true;
    const maxDraws = options.maxDraws === undefined ? -1 : options.maxDraws;
    const divergence = options.divergence ?? null;
    // One id or several, comma-separated: a picture painted by a family of
    // draws is only removed by removing the family.
    const skipTextures = new Set((options.skipTexture ?? '').split(',').filter(Boolean));
    const probeTexture = options.probeTexture ?? null;
    const compressedTextures = options.compressedTextures === true;
    const fogApplied = options.fog !== false;
    const mipsApplied = options.mips !== false;
    const { LockFlags, BufferUsage, TextureUsage } = backend;
    // A dumping run reads vertex buffers back off the GPU to compare them
    // with what the program wrote, which needs them made as copy sources.
    const dumpCopySource = dumpDraws ? BufferUsage.COPY_SRC : 0;

    /** @type {WeakMap<object, any>} d3d8 surface -> backend surface */
    const surfaces = new WeakMap();
    /**
     * Render targets that are not texture levels whose guest bytes are newer
     * than the GPU's -- written through a lock, or by a move in guest memory
     * that the caller makes after the call that marked them. Flushed at the
     * surface's next use on the GPU, as a texture level's dirty levels are.
     *
     * @type {WeakSet<object>}
     */
    const dirtyTargets = new WeakSet();
    /** @type {WeakMap<object, any>} d3d8 buffer -> { gpu, held } */
    const buffers = new WeakMap();
    /** @type {WeakMap<object, any>} d3d8 texture -> { gpu, dirty, ... } */
    const textures = new WeakMap();
    /** @type {WeakMap<object, number>} a level's surface -> which level it is */
    const surfaceLevels = new WeakMap();
    /** @type {Map<string, any>} */
    const samplers = new Map();
    /**
     * The texels of each texture as they were last uploaded, when a run asked
     * for them. A rectangle in the picture is either something a draw put
     * there or something already in the texture it sampled, and no amount of
     * per-draw state separates those two -- only the image does.
     *
     * @type {Map<string, any>}
     */
    const uploaded = new Map();
    /**
     * Every live texture record in creation order.
     *
     * `textures` is weak, so it cannot be walked, and a diagnostic that wants
     * to show what a program made needs the list. A record leaves it when the
     * program releases its texture for the last time -- it holds the GPU
     * texture, and a program that streams its textures in and out would keep
     * every one it ever made.
     *
     * @type {Set<any>}
     */
    const roster = new Set();
    /**
     * Records whose texture the program released for the last time, waiting
     * for a present that finds them bound on no stage.
     *
     * @type {Set<any>}
     */
    const released = new Set();
    let nextTextureId = 0;
    /** @type {any} */
    let placeholder = null;

    /** @type {any} the frame being recorded, or null between frames */
    let recording = null;
    /** @type {Promise<void>} */
    let chain = Promise.resolve();
    /** @type {any[]} the commands of the frame most recently replayed */
    let lastFrame = [];
    /** @type {string[]} one line per draw of the frame being recorded */
    let dump = [];
    /** @type {string[]} the same, for the frame most recently presented */
    let lastDump = [];
    /** Draws kept in the frame being recorded, against `maxDraws`. */
    let kept = 0;

    const counters = {
        frames: 0,
        draws: 0,
        clears: 0,
        skipped: {
            vertexShader: 0,
            pixelShader: 0,
            stride: 0,
            indexFormat: 0,
            stencilRect: 0,
            texture: 0,
            /** A draw through shaders this renderer could not build a pipeline for. */
            program: 0,
            /**
             * A fixed-function draw whose vertex format names no position: a
             * declaration the fixed-function path cannot read as a format.
             */
            layout: 0,
        },
        /** Draws that ran through a program rather than the fixed-function pipeline. */
        programmable: 0,
        /**
         * How often a draw's preparation was built and how often the previous
         * draw's was reused.
         *
         * The reused share is what says whether the state a program sets between
         * its draws is being tracked as coarsely as it changes: a run where it
         * is near zero while the program sets no state between draws is a
         * counter somewhere raised by something that did not change.
         */
        prepared: { built: 0, reused: 0 },
        /**
         * Draws that ran fewer stages than the program had set up.
         *
         * A cascade cut short draws untextured geometry and reports success,
         * which reads as a texture that vanished while everything around it
         * stayed right. Nothing else in a frame distinguishes that from a draw
         * the program meant to be flat, so it is counted rather than inferred.
         */
        cascade: {
            /** Ended at a stage that reads TEXTURE with nothing bound there. */
            noTexture: 0,
            /** Ended at a stage whose coordinate set the vertex does not carry. */
            noCoordSet: 0,
            /** @type {string[]} The distinct stage states that ended one. */
            truncations: [],
        },
        /** @type {string[]} */
        failures: [],
        /**
         * What lighting a run actually asked for.
         *
         * A picture that is uniformly too dark or too flat cannot be diagnosed
         * from the frame: the question is always whether the program enabled
         * lighting at all, how many lights it had on, what ambient it set, and
         * how many draws carried a normal to be lit by. Reading that off a
         * counter is the difference between finding it and guessing at it.
         */
        lighting: {
            lit: 0,
            unlit: 0,
            /** Lit was refused because the vertex format carried no normal. */
            noNormal: 0,
            /** Lit was refused because the vertices were already transformed. */
            preTransformed: 0,
            /** The largest number of lights any one draw had enabled. */
            mostLights: 0,
            /** Every distinct D3DRS_AMBIENT a draw was made under, in hex. */
            /** @type {Set<string>} */
            ambients: new Set(),
            /** Every distinct light type enabled, by its D3DLIGHT_TYPE. */
            /** @type {Set<number>} */
            types: new Set(),
            /**
             * The numbers themselves, deduplicated.
             *
             * Knowing that five point lights were on says nothing about why a
             * scene is dark: a range of zero, an attenuation that divides the
             * light away, or a black diffuse all count the same and look the
             * same. A handful of the actual structures is what separates them,
             * and a program sets few enough distinct ones for this to be cheap.
             *
             * @type {Set<string>}
             */
            lightValues: new Set(),
            /** @type {Set<string>} */
            materials: new Set(),
            /** Where each draw's world matrix puts it, against the light positions. */
            /** @type {Set<string>} */
            worlds: new Set(),
            /**
             * Fog, split by whether the draw had a distance to fade by.
             *
             * A pre-transformed draw has none, and Direct3D takes its factor
             * from the specular alpha the program supplied instead. A program
             * that leaves fog on while drawing a two-dimensional overlay, and
             * whose specular alpha means something else entirely, gets that
             * overlay painted in fog -- which looks like a rectangle of haze
             * where no haze belongs, and looks like nothing else.
             */
            fog: {
                transformed: 0,
                preTransformed: 0,
                modes: /** @type {Set<number>} */ (new Set()),
                /** @type {Set<string>} */
                settings: new Set(),
                /** @type {Set<string>} */
                depths: new Set(),
                /** @type {Set<string>} */
                screenSpace: new Set(),
            },
        },
    };

    /** Enough of a set of values to tell them apart, and no more. */
    const SAMPLE_LIMIT = 12;

    /** @param {number} value */
    const round = value=>Math.round(value * 1000) / 1000;

    /** @param {any} colour */
    const colourText = colour=>colour
        ? `${round(colour.r)},${round(colour.g)},${round(colour.b)},${round(colour.a)}`
        : '-';

    /**
     * FNV-1a over a block's bytes, as eight hex digits.
     *
     * @param {Float32Array | Uint8Array} block
     */
    const hashOf = block=>{
        const bytes = new Uint8Array(block.buffer, block.byteOffset, block.byteLength);
        let hash = 0x811c9dc5;
        for (let at = 0; at < bytes.length; at++)
        {
            hash = Math.imul(hash ^ bytes[at], 0x01000193);
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    };

    /** @param {Uint8Array} bytes */
    const bytesToBase64 = bytes=>{
        let text = '';
        for (let at = 0; at < bytes.length; at += 4096)
        {
            text += String.fromCharCode(...bytes.subarray(at, at + 4096));
        }
        return btoa(text);
    };

    /**
     * What is bound to a stage, by format and size.
     *
     * The format is the half of a sprite that decides whether it has a shape
     * at all: a texture whose alpha channel is dropped in the decode draws as
     * the rectangle it is stored in rather than as the thing it depicts, and
     * every other piece of state around it looks correct while it does.
     *
     * @param {any} texture
     */
    const describeTexture = texture=>{
        if (!texture)
        {
            return 'none';
        }
        const entry = textures.get(texture);
        return entry
            ? `${entry.id}:${entry.format}@${entry.width}x${entry.height}`
                + `^${entry.uploads || 0}${entry.census ?? ''}`
            : 'untracked';
    };

    /**
     * What a texture's texels actually are, once expanded.
     *
     * A sprite drawn additively is transparent where it is black and a sprite
     * drawn through alpha is transparent where its alpha is low; either way the
     * rectangle it is stored in is only invisible because most of it is one of
     * those. So "how much of this texture is neither" is the difference
     * between a decode that produced a picture and one that produced a slab,
     * and no other piece of state around the draw distinguishes them.
     *
     * @param {Uint8Array} texels  b, g, r, a
     * @returns {string}
     */
    const censusOf = texels=>{
        let opaque = 0;
        let bright = 0;
        for (let at = 0; at < texels.length; at += 4)
        {
            if (texels[at + 3] >= 4)
            {
                opaque++;
            }
            if (Math.max(texels[at], texels[at + 1], texels[at + 2]) >= 8)
            {
                bright++;
            }
        }
        const texelCount = texels.length / 4;
        return `{a>0=${Math.round(opaque / texelCount * 100)}%`
            + ` rgb>0=${Math.round(bright / texelCount * 100)}%`
            + ` [0]=${texels[2]},${texels[1]},${texels[0]},${texels[3]}}`;
    };

    /** @param {Set<string>} into @param {() => string} text  Built only when there is room. */
    const sample = (into, text)=>{
        if (into.size < SAMPLE_LIMIT)
        {
            into.add(text());
        }
    };
    /**
     * How many fogged draws have been examined for the samples below. A set
     * whose values never vary never fills, and examining every draw for it
     * would build a matrix and three strings per draw for the whole run.
     */
    let fogExamined = 0;
    const FOG_EXAMINED_LIMIT = 256;

    /**
     * The fog a draw runs under, as one short string: mode, colour, range
     * and density. Short because it is built per fogged draw, and a frame has
     * a hundred of those.
     *
     * @param {RenderModel} model
     */
    const fogSettingOf = model=>{
        const rs = (/** @type {number} */ state)=>model.renderStates.get(state) ?? 0;
        return `${rs(D3DRS.FOGTABLEMODE) || rs(D3DRS.FOGVERTEXMODE)}`
            + `/${(rs(D3DRS.FOGCOLOR) >>> 0).toString(16).padStart(8, '0')}`
            + `/${round(dwordToFloat(rs(D3DRS.FOGSTART)))}`
            + `..${round(dwordToFloat(rs(D3DRS.FOGEND)))}`
            + `/${round(dwordToFloat(rs(D3DRS.FOGDENSITY)))}`;
    };

    /**
     * @param {RenderModel} model
     * @param {PreparedDraw} prepared
     */
    const countLighting = (model, prepared)=>{
        const layout = prepared.layout;
        if (!layout)
        {
            // A draw through shaders: what its vertex stage lights and how is
            // in the shader, not in the state this counts.
            return;
        }
        const lighting = prepared.lighting;
        const tally = counters.lighting;
        const fogMode = (model.renderStates.get(D3DRS.FOGENABLE) ?? 0) !== 0
            ? ((model.renderStates.get(D3DRS.FOGTABLEMODE) ?? 0)
                || (model.renderStates.get(D3DRS.FOGVERTEXMODE) ?? 0))
            : 0;
        if (fogMode !== 0)
        {
            tally.fog.modes.add(fogMode);
            tally.fog[layout.preTransformed ? 'preTransformed' : 'transformed']++;
            frameStats.fogged++;
            // Read every fogged draw, kept as one short string per frame. The
            // sampled sets below stop at the first few hundred draws of a run,
            // so they describe how a program started and cannot show a setting
            // it changed to later. A scene that washes towards the fog colour
            // and stays there is precisely that, and this is what can see it.
            frameStats.fog = prepared.fogSetting ??= fogSettingOf(model);
            // And how many draws ran under each setting: a program fogs its
            // sky, its ground and its interface differently, and a frame that
            // goes wrong is one where a draw ran under another draw's fog --
            // which only a count per setting can show.
            frameStats.fogs.set(frameStats.fog, (frameStats.fogs.get(frameStats.fog) ?? 0) + 1);
        }
        // The samples below are text, built per draw, and a frame has hundreds
        // of draws: they are built for the first few hundred fogged draws only.
        if (fogMode !== 0 && fogExamined < FOG_EXAMINED_LIMIT)
        {
            fogExamined++;
            // The numbers, because a fog whose range is the default 0..1 while
            // the world is thousands of units across fogs everything equally
            // and completely -- which is a wall of fog colour, not fog.
            // How fogged this draw comes out, which is the thing a rectangle of
            // haze is evidence of. The eye distance of the model's origin is
            // the last element of its world-view-projection -- w of the point
            // (0,0,0) -- and it stands in for the whole draw closely enough to
            // separate "fogged like its neighbours" from "fogged to a solid
            // block of fog colour", which is the only distinction wanted here.
            const toScreen = multiplyMatrices(
                multiplyMatrices(transformOf(model, D3DTS.WORLD), transformOf(model, D3DTS.VIEW)),
                transformOf(model, D3DTS.PROJECTION));
            const start = dwordToFloat(model.renderStates.get(D3DRS.FOGSTART) ?? 0);
            const end = dwordToFloat(model.renderStates.get(D3DRS.FOGEND) ?? 0);
            const depth = toScreen[15];
            const amount = end > start
                ? Math.max(0, Math.min(1, (end - depth) / (end - start)))
                : 1;
            sample(tally.fog.depths, ()=>`depth=${round(depth)} amount=${round(amount)}`);
            // A draw whose model origin sits on the camera is a screen-space
            // quad written as ordinary geometry rather than as XYZRHW. It is
            // rectangular by construction, so when one of these is wrong it is
            // wrong in the shape of a rectangle -- and what makes it wrong is
            // never the transform but what it is filled and blended with.
            if (depth <= 1)
            {
                const stage = model.stageStates(0);
                const get = (/** @type {number} */ state)=>stage?.get(state) ?? 0;
                sample(tally.fog.screenSpace, ()=>
                    `blend=${(model.renderStates.get(D3DRS.ALPHABLENDENABLE) ?? 0) !== 0}`
                    + `/${model.renderStates.get(D3DRS.SRCBLEND) ?? 0}`
                    + `,${model.renderStates.get(D3DRS.DESTBLEND) ?? 0}`
                    + ` alphaTest=${(model.renderStates.get(D3DRS.ALPHATESTENABLE) ?? 0) !== 0}`
                    + ` colorOp=${get(D3DTSS.COLOROP)}`
                    + `(${get(D3DTSS.COLORARG1)},${get(D3DTSS.COLORARG2)})`
                    + ` alphaOp=${get(D3DTSS.ALPHAOP)}`
                    + `(${get(D3DTSS.ALPHAARG1)},${get(D3DTSS.ALPHAARG2)})`
                    + ` texture=${describeTexture(model.textures.get(0) ?? null)}`
                    // Where this draw's transparency is supposed to come from.
                    // A sprite fades by its alpha, and that alpha has three
                    // possible sources -- the texture, the vertex, the material
                    // -- of which lighting decides which two are even consulted.
                    + ` lit=${lighting !== null}`
                    + ` alphaFunc=${model.renderStates.get(D3DRS.ALPHAFUNC) ?? 0}`
                    + `/${model.renderStates.get(D3DRS.ALPHAREF) ?? 0}`
                    + ` materialAlpha=${round(model.material?.Diffuse?.a ?? -1)}`
                    + ` diffuseSource=${model.renderStates.get(D3DRS.DIFFUSEMATERIALSOURCE) ?? 0}`
                    + ` colorVertex=${(model.renderStates.get(D3DRS.COLORVERTEX) ?? 0) !== 0}`);
            }
            sample(tally.fog.settings, ()=>
                `colour=${((model.renderStates.get(D3DRS.FOGCOLOR) ?? 0) >>> 0)
                    .toString(16).padStart(8, '0')}`
                + ` start=${round(dwordToFloat(model.renderStates.get(D3DRS.FOGSTART) ?? 0))}`
                + ` end=${round(dwordToFloat(model.renderStates.get(D3DRS.FOGEND) ?? 0))}`
                + ` density=${round(dwordToFloat(model.renderStates.get(D3DRS.FOGDENSITY) ?? 0))}`);
        }
        if (!lighting)
        {
            tally.unlit++;
            if ((model.renderStates.get(D3DRS.LIGHTING) ?? 0) !== 0)
            {
                // Lighting was on and we declined it, which is the case worth
                // separating: the program believes it is lighting this draw.
                if (layout.preTransformed)
                {
                    tally.preTransformed++;
                }
                else
                {
                    tally.noNormal++;
                }
            }
            return;
        }
        tally.lit++;
        tally.mostLights = Math.max(tally.mostLights, lighting.lights.length);
        for (const type of lighting.lights)
        {
            tally.types.add(type);
        }
        if (tally.ambients.size < SAMPLE_LIMIT)
        {
            tally.ambients.add(
                ((model.renderStates.get(D3DRS.AMBIENT) ?? 0) >>> 0).toString(16).padStart(8, '0'));
        }
        for (const light of enabledLights(model))
        {
            sample(tally.lightValues, ()=>`type=${light.Type} range=${round(light.Range)}`
                + ` atten=${round(light.Attenuation0)}/${round(light.Attenuation1)}`
                + `/${round(light.Attenuation2)}`
                + ` at=${round(light.Position.x)},${round(light.Position.y)}`
                + `,${round(light.Position.z)}`
                + ` diffuse=${colourText(light.Diffuse)} ambient=${colourText(light.Ambient)}`);
        }
        // A light lives in world space and a vertex reaches it through the
        // world matrix. A program that leaves the world matrix at identity and
        // puts the model transform in the view matrix -- which is common, and
        // legal -- has its geometry nowhere near its lights, and every
        // attenuated light then falls off to nothing. Comparing the two
        // translations is what tells that apart from a light that is simply
        // dim, and nothing else in a frame does.
        const world = transformOf(model, D3DTS.WORLD);
        sample(tally.worlds, ()=>`origin=${round(world[12])},${round(world[13])}`
            + `,${round(world[14])}`
            + ` scale=${round(Math.hypot(world[0], world[1], world[2]))}`);
        const material = model.material;
        sample(tally.materials, ()=>`diffuse=${colourText(material?.Diffuse)}`
            + ` ambient=${colourText(material?.Ambient)}`
            + ` emissive=${colourText(material?.Emissive)}`);
    };

    /**
     * One draw as a line: where it landed and what it ran under.
     *
     * A counter says a frame had sixteen hundred draws and a picture says one
     * patch of it is wrong; neither says which draw painted that patch. This
     * is the join between them, and the screen extent is the only part of it
     * that cannot be read straight off the recorded state.
     *
     * @param {RenderModel} model
     * @param {any} prepared      what `prepare` returned
     * @param {Uint8Array} vertices
     * @param {number} stride
     * @param {ArrayLike<number> | null} indices
     */
    const dumpDraw = (model, prepared, vertices, stride, indices)=>{
        const state = prepared.state;
        const geometry = {
            worldViewProjection: prepared.uniforms.subarray(
                UNIFORM_AT.worldViewProjection, UNIFORM_AT.worldViewProjection + 16),
            viewport: model.viewport,
            preTransformed: prepared.layout.preTransformed,
            vertices,
            stride,
            indices,
        };
        const box = screenExtent(geometry);
        const where = box
            ? `${box.x0},${box.y0}..${box.x1},${box.y1}`
                + ` (${box.x1 - box.x0}x${box.y1 - box.y0})`
                + (box.behind > 0 ? ` behind=${box.behind}` : '')
                + (box.before > 0 ? ` before=${box.before}` : '')
                + (box.beyond > 0 ? ` beyond=${box.beyond}` : '')
                + (prepared.layout.preTransformed
                    ? ''
                    : ` depth=${box.depth[0].toFixed(6)}..${box.depth[1].toFixed(6)}`
                        + ` eye=${round(box.eye[0])}..${round(box.eye[1])}`
                        + (box.behind > 0
                            ? ` nearest=${box.nearest.map(w=>w.toPrecision(4)).join(',')}`
                            : ''))
            : 'nowhere';
        // A draw of a handful of quads has its own corners, and the union of
        // them is not one of them: an artefact bounded by one quad of six is
        // invisible in the box and obvious in the list.
        const drawn = indices ? indices.length : Math.floor(vertices.byteLength / stride);
        const texCoord = prepared.layout.attributes.find(
            (/** @type {any} */ entry)=>entry.name === 'texCoord0');
        const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
        const corners = box && drawn <= 128
            ? ` at=${[...new Set(screenPositions(geometry).points.map(point=>
                `${Math.round(point[0])},${Math.round(point[1])}`
                + (texCoord
                    ? `@${round(view.getFloat32(point[2] + texCoord.offset, true))}`
                        + `,${round(view.getFloat32(point[2] + texCoord.offset + 4, true))}`
                    : '')))].join(' ')}`
            : '';
        // A draw with vertices behind the eye is clipped by the hardware, and
        // what the clipper makes of its attributes cannot be read from any
        // field above -- so such a draw carries its bytes and its transform,
        // for a replay of the one draw on its own.
        const geometry64 = box && box.behind > 0 && drawn <= 128
            ? ` geo=v:${bytesToBase64(vertices)};i:${indices
                ? bytesToBase64(new Uint8Array(Uint16Array.from(indices).buffer))
                : '-'};m:${Array.from(prepared.uniforms.subarray(
                UNIFORM_AT.worldViewProjection, UNIFORM_AT.worldViewProjection + 16)).join(',')}`
                + `;u:${bytesToBase64(new Uint8Array(prepared.uniforms.buffer,
                    prepared.uniforms.byteOffset, prepared.uniforms.byteLength))}`
                + `;s:${bytesToBase64(new TextEncoder().encode(JSON.stringify(state)))}`
            : '';
        const cascade = state.stages.map((/** @type {any} */ stage, /** @type {number} */ at)=>
            `${stage.colorOp}(${stage.colorArg1},${stage.colorArg2})`
            + `/${stage.alphaOp}(${stage.alphaArg1},${stage.alphaArg2})`
            + `#${stage.texCoordIndex}`
            + `:${prepared.stageBindings[at]?.placeholder
                ? 'placeholder'
                : describeTexture(prepared.textures[at])}`).join(' ');
        // A draw that lost its texturing is a draw whose cascade ended before
        // the program's stages did, and the state of the stage that ended it is
        // the only thing that says why.
        const cut = prepared.truncated
            ? ` cut=${prepared.truncated.stage}/${prepared.truncated.reason}`
                + `/${prepared.truncated.detail.replace(/ /g, ',')}`
            : '';
        dump.push(`#${dump.length} ${where}${geometry64}`
            + ` fvf=0x${state.fvf.toString(16)} n=${drawn}`
            + (indices ? ` base=${model.baseVertexIndex}` : '')
            + ` lit=${state.lighting ? state.lighting.lights.length : '-'}`
            + ` fog=${state.fogMode === D3DFOG.NONE ? '-' : fogSettingOf(model)}`
            + ` spec=${state.specularEnable ? 1 : 0}`
            + ` z=${state.depthTest ? state.depthFunc : '-'}/${state.depthWrite ? 1 : 0}`
            // The bias a program leans on to keep a layer in front of the
            // surface it lies on: without it, two coplanar layers take turns
            // as the camera moves by less than a depth unit.
            + `/bias${model.renderStates.get(D3DRS.ZBIAS) ?? 0}`
            + `/${state.depthFormat ?? 'nodepth'}`
            // Which channels the draw may write, and the stencil states in
            // force: a draw that writes no colour is one made for the
            // stencil, and one drawn under a stencil test is what reads it.
            + ` cw=${state.colorWrite}`
            + (model.renderStates.get(52) ? ` stencil=${[53, 54, 55, 56, 57, 58, 59]
                .map(index=>((model.renderStates.get(index) ?? 0) >>> 0).toString(16))
                .join('/')}` : '')
            // Whether the program asked for its primitives to be clipped at
            // all: with clipping off, a vertex past the far plane is a depth
            // to clamp, not a triangle to drop.
            + `/clip${model.renderStates.get(D3DRS.CLIPPING) ?? 1}`
            + ` cull=${state.cullMode}`
            + ` blend=${state.blend ? `${state.srcBlend},${state.destBlend}` : '-'}`
            + ` aTest=${state.alphaTest
                ? `${state.alphaFunc}/${model.renderStates.get(D3DRS.ALPHAREF) ?? 0}`
                : '-'}`
            + ` ${transparencyOf(model, prepared, vertices, stride, indices)}`
            // What the draw is lit with and where it is: a picture that
            // changes while every draw's geometry and texture stay the same
            // is one whose material or transform moved, and only these show it.
            + ` mat=${describeMaterial(model.material)}`
            // The whole block the draw was shaded with, as one word: two draws
            // that read the same in every field above and shade differently
            // differ in a field this line does not print, and the word says so.
            + ` u=${hashOf(prepared.uniforms)}`
            + ` wvp=${[0, 5, 10, 12, 13, 14, 15]
                .map(index=>round(prepared.uniforms[UNIFORM_AT.worldViewProjection + index]))
                .join(',')}`
            + ` sampler=${Object.values(samplerDescriptorOf(model.stageStates(0), mipsApplied))
                .join(',')}`
            + ` texXform=${textureTransformOf(model, 0)}`
            // The rectangle the draw was clipped and mapped by. A viewport
            // left set by one draw and inherited by the next puts a hard
            // axis-aligned edge across real geometry, at coordinates that
            // belong to neither draw's own shape.
            // What it drew into. A frame that renders through a chain of
            // targets composites each one as a rectangle on the screen, and a
            // rectangle composited under the wrong alpha is indistinguishable
            // from a draw that painted one -- unless the target is named.
            + ` target=${describeTarget(model)}`
            + ` view=${model.viewport.rect.x},${model.viewport.rect.y}`
            + `+${model.viewport.rect.width}x${model.viewport.rect.height}`
            + `@${round(model.viewport.rect.minDepth)}..${round(model.viewport.rect.maxDepth)}`
            + ` [${cascade}]${cut}${corners}`);
    };

    /**
     * The dump line for a programmable draw. Its vertices go through a
     * vertex shader rather than the fixed-function pipeline `screenExtent`
     * projects with, so there is no screen box to print -- what is
     * ambiguous instead is which shaders and declaration ran, and what each
     * sampler was bound to.
     *
     * @param {RenderModel} model
     * @param {PreparedDraw} prepared
     * @param {number} count
     */
    const dumpProgram = (model, prepared, count)=>{
        const program = prepared.program;
        const bound = program.samplerBindings.map((/** @type {any} */ binding)=>
            `#${binding.stage}:${binding.placeholder
                ? 'placeholder'
                : describeTexture(binding.texture)}`).join(' ');
        dump.push(`#${dump.length} program n=${count}`
            + ` vs=${prepared.state.vertexShader} ps=${prepared.state.pixelShader}`
            + ` decl=${program.declarationId}`
            // The fog stage below model 3 runs after the shader too, so a
            // program's draw is another place its numbers can be wrong.
            + ` fog=${prepared.state.fogMode === D3DFOG.NONE ? '-' : fogSettingOf(model)}`
            + ` target=${describeTarget(model)}`
            + ` view=${model.viewport.rect.x},${model.viewport.rect.y}`
            + `+${model.viewport.rect.width}x${model.viewport.rect.height}`
            + ` [${bound}]`);
    };

    /**
     * What a draw's colour target is, and whether it is a texture the frame
     * goes on to sample. Anything but the back buffer means the frame is built
     * in more than one place, and each place is a rectangle of its own.
     *
     * @param {RenderModel} model
     * @returns {string}
     */
    const describeTarget = model=>{
        const target = surfaceFor(model.renderTarget);
        const tracked = textures.get(model.renderTarget);
        return `s${resourceId(target)}${tracked ? `=${tracked.id}` : ''}`
            + `${model.renderTarget === model.backBuffer ? '' : '!backbuffer'}`;
    };

    /**
     * The texture transform a stage asks for. A program that scrolls or
     * scales a coordinate set through D3DTS_TEXTURE0 samples a different part
     * of its texture than the vertex names -- a sprite sheet's cell is chosen
     * this way -- with every other piece of state around the draw reading the
     * same. So the flags and the matrix are printed whenever either is set,
     * and nothing at all when the stage genuinely wants the coordinate as it
     * lies.
     *
     * @param {RenderModel} model
     * @param {number} stage
     * @returns {string}
     */
    const textureTransformOf = (model, stage)=>{
        const flags = model.stageStates(stage)?.get(D3DTSS.TEXTURETRANSFORMFLAGS) ?? 0;
        const matrix = model.transforms.get(D3DTS.TEXTURE0 + stage);
        if (flags === 0 && !matrix)
        {
            return '-';
        }
        // The matrix by columns, as the block carries it: the u column, then
        // v, w and q -- so a sheet's cell can be read off the first two.
        return `${flags}:${(matrix ? PLANAR_ROWS.map(at=>matrix[at]) : PLANAR_IDENTITY)
            .map(round).join(',')}`;
    };

    /**
     * Whether a stage's transform asks for what the sampler does not do:
     * one coordinate, or a projective divide of a carried set.
     *
     * @param {RenderModel} model @param {number} stage
     */
    const transformMoves = (model, stage)=>{
        const states = model.stageStates(stage);
        const flags = states?.get(D3DTSS.TEXTURETRANSFORMFLAGS) ?? 0;
        return flags !== 0
            && !transformApplies(flags, generates(states?.get(D3DTSS.TEXCOORDINDEX) ?? 0));
    };

    /**
     * A material as diffuse, ambient and emissive colours, one short clause.
     *
     * @param {Material | undefined} material
     */
    const describeMaterial = material=>{
        if (!material)
        {
            return '-';
        }
        const colour = (/** @type {ColourValue} */ value)=>
            `${round(value.r)},${round(value.g)},${round(value.b)},${round(value.a)}`;
        return `d(${colour(material.Diffuse)})a(${colour(material.Ambient)})`
            + `e(${colour(material.Emissive)})`;
    };

    /**
     * Where this draw's transparency comes from, and what it samples with.
     *
     * A rectangle that should not be visible is a fragment that should have
     * been transparent and was not, and there are only three places that can
     * come from: the alpha the vertex carries, the alpha the material lends it
     * when the vertex carries none, and the texel the coordinates land on. All
     * three look ordinary in the state and are only distinguished by their
     * values, so the values are what is printed.
     *
     * @param {RenderModel} model
     * @param {any} prepared
     * @param {Uint8Array} vertices
     * @param {number} stride
     * @param {ArrayLike<number> | null} indices
     * @returns {string}
     */
    const transparencyOf = (model, prepared, vertices, stride, indices)=>{
        /** @param {string} name */
        const attribute = name=>prepared.layout.attributes.find(
            (/** @type {any} */ entry)=>entry.name === name);
        const diffuse = attribute('diffuse');
        const texCoord = attribute('texCoord0');
        const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
        let alphaLow = 256, alphaHigh = -1;
        let uLow = Infinity, uHigh = -Infinity, vLow = Infinity, vHigh = -Infinity;
        const total = indices ? indices.length : Math.floor(vertices.byteLength / stride);
        for (let index = 0; index < total; index++)
        {
            const at = (indices ? indices[index] : index) * stride;
            if (at < 0 || at + stride > vertices.byteLength)
            {
                continue;
            }
            if (diffuse)
            {
                const alpha = vertices[at + diffuse.offset + 3];
                alphaLow = Math.min(alphaLow, alpha);
                alphaHigh = Math.max(alphaHigh, alpha);
            }
            if (texCoord)
            {
                const u = view.getFloat32(at + texCoord.offset, true);
                const v = view.getFloat32(at + texCoord.offset + 4, true);
                uLow = Math.min(uLow, u);
                uHigh = Math.max(uHigh, u);
                vLow = Math.min(vLow, v);
                vHigh = Math.max(vHigh, v);
            }
        }
        return `alpha=${alphaHigh < 0
            ? `material:${round(model.material?.Diffuse?.a ?? -1)}`
            : `vertex:${alphaLow}..${alphaHigh}`}`
            + ` uv=${texCoord && uLow !== Infinity
                ? `${round(uLow)}..${round(uHigh)},${round(vLow)}..${round(vHigh)}`
                : '-'}`;
    };

    /**
     * The same, for an indexed draw out of a vertex buffer: the indices say
     * which vertices, so the span they reach over is what has to be read back
     * from guest memory to be transformed.
     *
     * @param {RenderModel} model
     * @param {any} prepared
     * @param {ArrayLike<number>} order
     */
    const dumpIndexed = (model, prepared, order)=>{
        const stream = model.stream;
        let most = 0;
        for (let at = 0; at < order.length; at++)
        {
            most = Math.max(most, order[at]);
        }
        const skipped = model.baseVertexIndex * stream.stride;
        const wanted = Math.min((most + 1) * stream.stride, stream.buffer.length - skipped);
        const vertices = wanted > 0
            ? readMemory(stream.buffer.base + skipped, wanted)
            : new Uint8Array(0);
        dumpDraw(model, prepared, vertices, stream.stride, order);
        noteDumpVertices(prepared, vertices, skipped, stream.stride);
    };

    /** How many of a frame's dumped draws get their GPU-side vertices checked. */
    const CHECKED_DRAWS = 48;

    /**
     * Keeps the vertices a dumped draw was described from, so that at replay
     * the bytes the GPU actually holds for it can be read back and compared.
     *
     * The dump's positions and coordinates come from guest memory, which is
     * what the program wrote; the picture comes from the GPU's copy, which
     * travelled through a lock ring, a rename and a flush. A draw whose two
     * copies differ is drawn from data nobody described, and nothing but this
     * comparison can say so.
     *
     * @type {(prepared: any, vertices: Uint8Array, offset: number, stride: number) => void}
     *     `offset` is where `vertices` begins within the bound buffer.
     */
    const noteDumpVertices = (prepared, vertices, offset, stride)=>{
        const commands = recording?.commands ?? [];
        const command = commands[commands.length - 1];
        // The draw just recorded, and only that one: a draw cut by `maxDraws`
        // was never recorded, and the last command then belongs to another.
        // The first draws of a frame only: a frame is a hundred and more, the
        // scene is drawn before its interface, and every range copied is time
        // the run does not spend running the program.
        if (!command || command.kind !== 'draw' || command.check || vertices.byteLength === 0
            || dump.length > CHECKED_DRAWS)
        {
            return;
        }
        command.check = {
            dump: dump.length - 1,
            probe: probeTexture !== null && prepared.textures.some(
                (/** @type {any} */ texture)=>texture && textures.get(texture)?.id === probeTexture),
            // The texture as it is on the device when this draw samples it:
            // nothing else says what the sampler actually read.
            sampled: probeTexture !== null
                ? textures.get(prepared.textures.find((/** @type {any} */ texture)=>
                    texture && textures.get(texture)?.id === probeTexture))?.gpu ?? null
                : null,
            vertices: command.vertices,
            // A pipeline of the same shader under another key, to draw with a
            // pipeline object other than the cached one.
            alternate: probeTexture !== null && recording
                ? recording.pipelines.push(backend.pipelineFor(
                    { ...prepared.state, colorWrite: prepared.state.colorWrite ^ 8 })) - 1
                : -1,
            // The same draw through a fragment shader whose source differs, so
            // the module is compiled afresh; the alpha test it adds passes.
            alternateShader: probeTexture !== null && recording
                ? recording.pipelines.push(backend.pipelineFor(
                    { ...prepared.state, alphaTest: true, alphaFunc: D3DCMP.GREATEREQUAL })) - 1
                : -1,
            // A pre-transformed quad that samples the same texture over the
            // top of the target with plain coordinates: what the texture looks
            // like to a draw with no transform at all.
            quad: probeTexture !== null && recording
                ? recording.pipelines.push(backend.pipelineFor({
                    fvf: FVF.XYZRHW | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT),
                    vertexShader: 0,
                    pixelShader: 0,
                    targetFormat: prepared.state.targetFormat,
                    depthFormat: prepared.state.depthFormat,
                    topology: 'triangle-list',
                    depthTest: false,
                    depthWrite: false,
                    depthFunc: D3DCMP.ALWAYS,
                    cullMode: D3DCULL.NONE,
                    blend: false,
                    srcBlend: D3DBLEND.ONE,
                    destBlend: D3DBLEND.ZERO,
                    blendOp: 1,
                    colorWrite: 0xf,
                    alphaTest: false,
                    alphaFunc: D3DCMP.ALWAYS,
                    fogMode: D3DFOG.NONE,
                    stages: [{
                        colorOp: 2, colorArg1: 2, colorArg2: 1,
                        alphaOp: 2, alphaArg1: 2, alphaArg2: 1, texCoordIndex: 0,
                    }],
                    specularEnable: false,
                    lighting: null,
                })) - 1
                : -1,
            bytes: vertices.slice(),
            // The block as recorded, because the arena it lives in is reused
            // before the read-back lands.
            uniforms: new Uint8Array(prepared.uniforms.buffer, prepared.uniforms.byteOffset,
                prepared.uniforms.byteLength).slice(),
            offset,
            stride,
            texCoord: prepared.layout.attributes.find(
                (/** @type {any} */ entry)=>entry.name === 'texCoord0')?.offset,
        };
    };

    /** @type {{ target: any, depth: any, width: number, height: number } | null} */
    let probeScratch = null;
    /**
     * A target of the frame's size that the probe's redraws paint into, so a
     * redraw that paints nothing is seen as the clear and not as the frame.
     *
     * @param {any} like  the frame's target
     * @param {any} depth the frame's depth surface, or null
     */
    const probeScratchFor = (like, depth)=>{
        if (!probeScratch || probeScratch.width !== like.width
            || probeScratch.height !== like.height)
        {
            probeScratch = {
                width: like.width,
                height: like.height,
                target: backend.createSurface({
                    width: like.width,
                    height: like.height,
                    format: like.format,
                    label: 'probe-target',
                }),
                depth: depth
                    ? backend.createSurface({
                        width: like.width, height: like.height, format: depth.format,
                        label: 'probe-depth', usage: TextureUsage.RENDER_ATTACHMENT,
                    })
                    : null,
            };
        }
        return probeScratch;
    };

    /** The pass a probe's redraw runs in: the scratch target, cleared, depth cleared. */
    const probePass = (/** @type {any} */ frame, /** @type {any} */ scratch)=>frame.beginPass({
        target: scratch.target,
        clear: true,
        clearValue: { r: 1, g: 0, b: 1, a: 1 },
        depthStencilAttachment: scratch.depth
            ? {
                view: scratch.depth.view,
                depthLoadOp: 'clear',
                depthStoreOp: 'store',
                depthClearValue: 1,
            }
            : undefined,
    });

    /** Where a probe reads the target: a few points, and a grid for how varied it is. */
    const PROBE_POINTS = [[0.5, 0.125], [0.625, 0.2], [0.3125, 0.3125], [0.78, 0.4], [0.5, 0.52],
        [0.15, 0.625], [0.94, 0.17]];

    /**
     * @param {{ width: number, height: number, data: Uint8Array }} shot
     */
    const describeSnapshot = shot=>{
        const at = (/** @type {number} */ x, /** @type {number} */ y)=>{
            const index = (Math.min(shot.height - 1, Math.floor(y * shot.height)) * shot.width
                + Math.min(shot.width - 1, Math.floor(x * shot.width))) * 4;
            return `${shot.data[index + 2]}/${shot.data[index + 1]}/${shot.data[index]}`;
        };
        const seen = new Set();
        for (let y = 0.05; y < 0.62; y += 0.04)
        {
            for (let x = 0.03; x < 0.97; x += 0.03)
            {
                seen.add(at(x, y));
            }
        }
        return `after=${PROBE_POINTS.map(([x, y])=>at(x, y)).join(',')} distinct=${seen.size}`;
    };

    /**
     * The indices a dumped draw reads from the program's own buffer, kept
     * beside its vertices for the same read-back.
     *
     * @param {Uint8Array} bytes  What the program wrote, from the draw's start.
     */
    const noteDumpIndices = bytes=>{
        const commands = recording?.commands ?? [];
        const command = commands[commands.length - 1];
        if (command?.check && command.indices && !command.check.indices)
        {
            command.check.indices = { buffer: command.indices, bytes: bytes.slice() };
        }
    };

    /**
     * Bytes the GPU holds against bytes the program wrote, as one clause.
     *
     * @param {string} name
     * @param {Uint8Array} guest
     * @param {Uint8Array} gpu
     */
    const describeBytes = (name, guest, gpu)=>{
        if (gpu.byteLength !== guest.byteLength)
        {
            return `${name}=short(${gpu.byteLength}/${guest.byteLength})`;
        }
        let differing = 0;
        let first = -1;
        for (let at = 0; at < guest.byteLength; at++)
        {
            if (gpu[at] !== guest[at])
            {
                differing++;
                if (first < 0)
                {
                    first = at;
                }
            }
        }
        return differing === 0
            ? `${name}=same`
            : `${name}=differs(${differing}/${guest.byteLength} bytes, first at ${first})`;
    };

    /**
     * What the GPU held for a dumped draw against what the program wrote,
     * as one short clause for the dump line.
     *
     * @param {{ bytes: Uint8Array, stride: number, texCoord: number | undefined }} check
     * @param {Uint8Array} gpu
     */
    const describeCheck = (check, gpu)=>{
        const guest = check.bytes;
        if (gpu.byteLength !== guest.byteLength)
        {
            return `gpu=short(${gpu.byteLength}/${guest.byteLength})`;
        }
        let differing = 0;
        let first = -1;
        for (let at = 0; at < guest.byteLength; at++)
        {
            if (gpu[at] !== guest[at])
            {
                differing++;
                if (first < 0)
                {
                    first = at;
                }
            }
        }
        if (differing === 0)
        {
            return 'gpu=same';
        }
        const vertex = Math.floor(first / check.stride);
        let coordinates = '';
        if (check.texCoord !== undefined)
        {
            const at = vertex * check.stride + check.texCoord;
            const wrote = new DataView(guest.buffer, guest.byteOffset, guest.byteLength);
            const held = new DataView(gpu.buffer, gpu.byteOffset, gpu.byteLength);
            coordinates = ` uv@${vertex}=${round(wrote.getFloat32(at, true))}`
                + `,${round(wrote.getFloat32(at + 4, true))}`
                + `->${round(held.getFloat32(at, true))},${round(held.getFloat32(at + 4, true))}`;
        }
        return `gpu=differs(${differing}/${guest.byteLength} bytes, first at vertex ${vertex})`
            + coordinates;
    };

    /**
     * Counts and reports a cascade that stopped short of the program's stages.
     *
     * The draw still happens -- refusing it would change what the program does
     * -- so nothing else says the picture lost a texture layer. The counter
     * carries the distinct stage states so that a run names which ones, and the
     * divergence says it once.
     *
     * @param {{ truncated: CascadeTruncation | null }} cascade
     */
    const reportCascade = cascade=>{
        const truncated = cascade.truncated;
        if (!truncated)
        {
            return;
        }
        counters.cascade[truncated.reason === 'texture' ? 'noTexture' : 'noCoordSet']++;
        frameStats.truncated++;
        const line = `stage ${truncated.stage} ${truncated.reason}: ${truncated.detail}`;
        if (!counters.cascade.truncations.includes(line)
            && counters.cascade.truncations.length < TRUNCATION_SAMPLES)
        {
            counters.cascade.truncations.push(line);
        }
        if (divergence)
        {
            divergence('Direct3D 8',
                'a texture stage cascade was cut short and the draw ran untextured'
                + ` from that stage on: ${line}`);
        }
    };

    /**
     * The vertex layout of a declaration the fixed-function stage reads, for a
     * stream of this stride, or null when a member would reach past the vertex.
     *
     * @param {import('../d3d9/declaration.js').FixedFunctionLayout} declared
     * @param {number} stride
     * @returns {import('../webgpu/internal/vertexformat.js').VertexLayout | null}
     */
    const layoutOfDeclaration = (declared, stride)=>{
        if (declared.attributes.some(attribute=>attribute.offset + attribute.bytes > stride))
        {
            return null;
        }
        return {
            stride,
            attributes: declared.attributes.map((attribute, index)=>({
                name: attribute.name,
                offset: attribute.offset,
                format: attribute.format,
                shaderLocation: index,
            })),
            preTransformed: declared.preTransformed,
            texCoordSets: declared.texCoordSets,
            blendWeights: 0,
        };
    };

    let layoutReported = false;
    /** Says once that fixed-function draws were dropped for want of a format. */
    const reportLayout = ()=>{
        if (divergence && !layoutReported)
        {
            layoutReported = true;
            divergence('Direct3D 8',
                'a fixed-function draw over a vertex declaration the fixed-function stage'
                + ' cannot read (a second stream, blend weights, a colour that is not a'
                + ' D3DCOLOR, or a member past the vertex) is not drawn');
        }
    };

    /**
     * Says once that a stage asked for coordinates this engine does not
     * generate. The set it names is used regardless, which is the coordinates
     * the vertex carried rather than the ones the program asked to be computed.
     *
     * @param {import('../webgpu/internal/pipeline.js').StageKey[]} stages
     */
    const reportCoordGeneration = stages=>{
        if (!divergence)
        {
            return;
        }
        if (stages.some(stage=>generationOf(stage.texCoordIndex) !== 0
            && !generates(stage.texCoordIndex)))
        {
            divergence('Direct3D 8',
                'a sphere-map texture coordinate generation is accepted and not applied'
                + ' (D3DTSS_TEXCOORDINDEX, D3DTSS_TCI_SPHEREMAP): the set named in the'
                + ' low bits is sampled as the vertex carries it');
        }
    };

    /**
     * Says once that a stage asked for a texture transform this engine does
     * not do: three or four coordinates, or a projected divide.
     *
     * The state is accepted -- refusing SetTransform or the stage state would
     * change what a program does -- and then not acted on, which is the defect
     * class that shows up as a picture rather than an error. Reported per draw
     * because that is where it is observable; the reporter deduplicates.
     *
     * @param {RenderModel} model
     * @param {number} stages  How many the cascade runs.
     */
    const reportTextureTransform = (model, stages)=>{
        if (!divergence)
        {
            return;
        }
        for (let stage = 0; stage < stages; stage++)
        {
            if (transformMoves(model, stage))
            {
                divergence('Direct3D 8',
                    'a texture transform of one coordinate, or a projected one'
                    + ' over a set the vertex carries, is accepted and not applied'
                    + ' (D3DTSS_TEXTURETRANSFORMFLAGS, D3DTS_TEXTURE0..7):'
                    + ' coordinates are sampled as the vertex carries them');
                return;
            }
        }
    };

    /** @param {string} reason */
    const skip = reason=>{
        counters.skipped[/** @type {keyof typeof counters.skipped} */ (reason)]++;
    };

    /** @param {any} error */
    const failure = error=>{
        if (counters.failures.length < 16)
        {
            counters.failures.push(String(error && error.message ? error.message : error));
        }
    };

    /**
     * The one backend texture behind a d3d8 surface, made on first use.
     *
     * A texture's level is a view of the texture's own backend texture: a
     * program draws into `GetSurfaceLevel(n)` and samples the texture, and
     * both have to name the same pixels. Whatever the surface is, its guest
     * bytes are uploaded first if they are newer than what the GPU holds.
     *
     * @param {any} surface a d3d8 surface
     */
    const surfaceFor = surface=>{
        const record = textures.get(surface);
        if (record)
        {
            uploadIfDirty(record.texture);
            // A pass attaches one level, and the texture's own view spans
            // them all: even level zero of a chained texture goes through a
            // view of that level alone.
            const level = surfaceLevels.get(surface) ?? 0;
            return level === 0 && record.levels === 1 ? record.gpu : levelSurfaceOf(record, level);
        }
        // A hit is the per-draw case, twice per draw; the description is
        // for making the texture and for a flush, and neither is the common
        // path.
        let made = surfaces.get(surface);
        if (!made)
        {
            const desc = describe(surface);
            const depth = FORMAT_INFO[desc.Format].depth;
            made = backend.createSurface({
                width: desc.Width,
                height: desc.Height,
                format: gpuFormatOf(desc.Format, desc.Width, desc.Height, compressedTextures),
                label: depth ? 'depth' : 'target',
                // A colour target is copied into as well as out of: a program
                // that blits a decoded frame onto its target, or locks the
                // target and writes it, puts bytes into it that a draw never
                // did.
                usage: depth
                    ? TextureUsage.RENDER_ATTACHMENT
                    : TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING
                        | TextureUsage.COPY_SRC | TextureUsage.COPY_DST,
            });
            surfaces.set(surface, made);
        }
        if (dirtyTargets.delete(surface))
        {
            const desc = describe(surface);
            const bytes = readMemory(surface.base,
                surfaceBytes(desc.Format, desc.Width, desc.Height));
            const keepsBlocks = isCompressed(desc.Format) && compressedTextures
                && blockAligned(desc.Width, desc.Height);
            uploadTexels(made, {
                format: made.format,
                mipLevel: 0,
                width: desc.Width,
                height: desc.Height,
                texels: keepsBlocks
                    ? bytes
                    : isCompressed(desc.Format)
                        ? decodeCompressed(bytes, S3TC_OF[desc.Format], desc.Width, desc.Height)
                        : expandTexels(desc.Format, bytes, desc.Width * desc.Height),
            }, true);
        }
        return made;
    };

    /**
     * A level above the top as a target: the same backend texture through a
     * view of that level alone.
     *
     * @param {any} record @param {number} level
     */
    const levelSurfaceOf = (record, level)=>{
        const views = record.levelSurfaces ??= new Map();
        let made = views.get(level);
        if (!made)
        {
            const label = `texture:${record.id}:${level}`;
            made = {
                texture: record.gpu.texture,
                view: record.gpu.texture.createView({
                    label, dimension: '2d', baseMipLevel: level, mipLevelCount: 1,
                }),
                width: levelExtent(record.width, level),
                height: levelExtent(record.height, level),
                format: record.gpu.format,
                mipLevelCount: 1,
                layers: 1,
                label,
                mipLevel: level,
            };
            views.set(level, made);
        }
        return made;
    };

    /**
     * Whether a surface's pixels are the GPU's to give: a render target, or a
     * level of a texture, which has a backend texture whichever way it is
     * reached. An offscreen plain surface lives in guest memory and nowhere
     * else, and a depth surface is never copied.
     *
     * @param {any} surface a d3d8 surface
     */
    const onGpu = surface=>{
        const desc = describe(surface);
        return !FORMAT_INFO[desc.Format].depth
            && (textures.has(surface) || (desc.Usage & D3DUSAGE.RENDERTARGET) !== 0);
    };

    /**
     * One level's texels onto the GPU.
     *
     * A level only the guest writes goes straight to the queue, which orders
     * it before the frame's command buffer: enough, and the cheapest path. A
     * level the GPU also writes -- a render-target texture, a level a copy
     * has landed in -- needs its upload in command order, or a frame that
     * clears the level and then blits into it would be replayed as the blit
     * and then the clear; that upload is a frame command, replayed through
     * the staged path on the frame's own encoder.
     *
     * @param {any} surface a backend surface
     * @param {{ format: string, mipLevel: number, width: number, height: number,
     *           texels: Uint8Array }} upload
     * @param {boolean} ordered
     */
    const uploadTexels = (surface, upload, ordered)=>{
        if (ordered)
        {
            ensureFrame().commands.push({ kind: 'upload', surface, ...upload });
            return;
        }
        backend.uploadTexture({
            texture: surface.texture,
            format: upload.format,
            mipLevel: upload.mipLevel,
            width: upload.width,
            height: upload.height,
            data: upload.texels,
        });
    };

    /** @param {any} buffer a d3d8 vertex or index buffer */
    const bufferFor = buffer=>{
        const existing = buffers.get(buffer);
        if (existing)
        {
            return existing;
        }
        const index = buffer.format !== undefined;
        const made = {
            gpu: backend.createDynamicBuffer({
                size: buffer.length,
                usage: (index ? BufferUsage.INDEX : BufferUsage.VERTEX) | BufferUsage.COPY_DST
                    | dumpCopySource,
                label: index ? 'indices' : 'vertices',
            }),
            held: null,
        };
        buffers.set(buffer, made);
        return made;
    };

    /**
     * A ring over one dynamic buffer, for bytes that exist only for one draw:
     * user-pointer vertices and expanded index lists. Writes go in with
     * NOOVERWRITE until the ring wraps, and the wrap is a DISCARD -- exactly the
     * contract the backend charges for, and the reason a ring rather than a
     * fresh buffer per draw.
     *
     * @param {string} label @param {number} usage @param {number} size
     */
    const ring = (label, usage, size)=>{
        let buffer = backend.createDynamicBuffer({ size, usage, label });
        let cursor = 0;
        // A buffer nothing has read yet needs no rename to be written at zero.
        let fresh = true;
        return {
            /** @param {ArrayBufferView} view @returns {{ gpu: any, offset: number }} */
            write(view){
                const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
                const aligned = alignUp(bytes.byteLength);
                if (aligned > buffer.size)
                {
                    buffer = backend.createDynamicBuffer({ size: aligned * 2, usage, label });
                    cursor = 0;
                    fresh = true;
                }
                if (cursor + aligned > buffer.size)
                {
                    cursor = 0;
                }
                const lock = buffer.lock(cursor, bytes.byteLength,
                    cursor === 0 && !fresh ? LockFlags.DISCARD : LockFlags.NOOVERWRITE);
                fresh = false;
                lock.data.set(bytes);
                buffer.unlock(lock);
                const offset = cursor;
                cursor += aligned;
                return { gpu: buffer.gpu, offset };
            },
        };
    };

    const scratchVertices = ring('scratch-vertices',
        BufferUsage.VERTEX | BufferUsage.COPY_DST | dumpCopySource, 1 << 20);
    const scratchIndices = ring('scratch-indices',
        BufferUsage.INDEX | BufferUsage.COPY_DST, 1 << 18);

    /**
     * The one hardware sampler. What the stage asked for is in the block; the
     * descriptor of the request is kept on the sampler for a probe.
     *
     * @param {Map<number, number>} states
     */
    const samplerFor = states=>{
        const descriptor = { ...HARDWARE_SAMPLER };
        const key = Object.values(descriptor).join('|');
        const existing = samplers.get(key);
        if (existing)
        {
            existing.probeDescriptor = samplerDescriptorOf(states, mipsApplied);
            return existing;
        }
        if (!createSampler)
        {
            throw new Error(
                'graphics/d3d8: a textured draw needs a sampler factory and none was supplied');
        }
        const made = createSampler({ label: `sampler:${key}`, ...descriptor });
        // Kept on the object for a probe that wants one just like it.
        made.probeDescriptor = samplerDescriptorOf(states, mipsApplied);
        samplers.set(key, made);
        return made;
    };

    /** A 1x1 texture for a cascade stage that reads no texture but is declared to have one. */
    const placeholderView = ()=>{
        if (!placeholder)
        {
            placeholder = backend.createSurface({
                width: 1,
                height: 1,
                format: COLOR_FORMAT,
                label: 'placeholder',
                usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST
                    | (dumpDraws ? TextureUsage.COPY_SRC : 0),
            });
            if (dumpDraws)
            {
                uploaded.set('placeholder', {
                    id: 'placeholder',
                    format: 0,
                    width: 1,
                    height: 1,
                    texels: new Uint8Array(4),
                    gpu: placeholder,
                });
            }
        }
        return placeholder.view;
    };

    /**
     * The GPU texture behind a d3d8 texture, with level zero uploaded if the
     * program has written it since the last draw that read it.
     *
     * @param {any} texture
     */
    const uploadIfDirty = texture=>{
        const record = textures.get(texture);
        if (!record)
        {
            throw new Error('graphics/d3d8: a texture from another device was bound');
        }
        if (!record.gpu)
        {
            record.gpu = backend.createSurface({
                width: record.width,
                height: record.height,
                format: gpuFormatOf(record.format, record.width, record.height, compressedTextures),
                mipLevelCount: record.levels,
                label: 'texture',
                // Copied out of as well as into: a dumping run reads a
                // texture back to compare what the device holds against what
                // was handed to it, and a program copies a texture level into
                // a render target. A render-target texture is drawn into too.
                usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST
                    | TextureUsage.COPY_SRC
                    | (record.ordered ? TextureUsage.RENDER_ATTACHMENT : 0),
            });
        }
        if (record.dirtyLevels.size > 0)
        {
            frameStats.uploads++;
            record.uploads = (record.uploads || 0) + 1;
            const gpuFormat = gpuFormatOf(record.format, record.width, record.height,
                compressedTextures);
            // The base level's size, not each mip's, decides the whole
            // texture's path: WebGPU already refused (and gpuFormatOf already
            // fell back) on the base alone, so every level -- mips round down
            // further still -- follows the same choice.
            const keepsBlocks = isCompressed(record.format) && compressedTextures
                && blockAligned(record.width, record.height);
            for (const level of [...record.dirtyLevels].sort((left, right)=>left - right))
            {
                const width = levelExtent(record.width, level);
                const height = levelExtent(record.height, level);
                // The level's own storage, made if the program never touched
                // it: a level it left unwritten is sampled as whatever lies
                // there, which is what a real device does with such a level.
                /** @type {{ surface?: any }} */
                const held = {};
                if (texture.GetSurfaceLevel(level, held) !== D3D_OK || !held.surface)
                {
                    continue;
                }
                held.surface.release();
                const bytes = readMemory(held.surface.base,
                    surfaceBytes(record.format, width, height));
                // Compressed blocks go as they lie when the surface stayed a
                // BC texture; a compressed base too narrow or short for a
                // whole block has none of that (there is no decoder for a
                // format expandTexels does not know), so it is decompressed
                // instead of expanded; everything else is widened to the one
                // uncompressed format the backend samples.
                const texels = keepsBlocks
                    ? bytes
                    : isCompressed(record.format)
                        ? decodeCompressed(bytes, S3TC_OF[record.format], width, height)
                        : expandTexels(record.format, bytes, width * height);
                uploadTexels(record.gpu,
                    { format: gpuFormat, mipLevel: level, width, height, texels },
                    record.ordered);
                // Which levels the program has written, and what its smallest
                // ones hold: a surface sampled far away comes out of those,
                // and a level the program never wrote is sampled all the same.
                (record.written ??= new Set()).add(level);
                if (width * height <= 16 && !keepsBlocks)
                {
                    (record.tails ??= {})[level] = [...texels];
                }
                if (level === 0 && dumpDraws && !keepsBlocks)
                {
                    record.census = censusOf(texels);
                    if (uploaded.has(record.id) || uploaded.size < TEXTURE_DUMP_LIMIT)
                    {
                        uploaded.set(record.id, {
                            id: record.id,
                            format: record.format,
                            width: record.width,
                            height: record.height,
                            texels,
                            gpu: record.gpu,
                        });
                    }
                }
            }
            record.dirtyLevels.clear();
            record.dirty = false;
        }
        return record.gpu;
    };

    // --- recording ---

    /** Arenas of frames already replayed, for the next recording to take. @type {any[]} */
    const arenas = [];
    /**
     * What one frame drew, as it is being recorded: closed out at present.
     *
     * @returns {{ draws: number, placeholder: number, truncated: number, fogged: number,
     *             fog: string, fogs: Map<string, number>,
     *     uploads: number, textures: Set<any>, clears: number, clearColor: number,
     *     offscreenDraws: number, offscreenTargets: Set<any> }}
     */
    const blankFrameStats = ()=>({
        draws: 0, placeholder: 0, truncated: 0, uploads: 0, fogged: 0, fog: '',
        fogs: new Map(), textures: new Set(), clears: 0, clearColor: -1, offscreenDraws: 0,
        offscreenTargets: new Set(),
    });
    let frameStats = blankFrameStats();
    /** @type {{ index: number, draws: number, placeholder: number, truncated: number,
     *     uploads: number, textures: number, fogged: number, fog: string, fogs: string,
     *     lights: string, clears: number, clearColor: string, offscreenDraws: number,
     *     offscreenTargets: number, viewport: string, target: string }[]} */
    const frameHistory = [];
    const FRAME_HISTORY = 240;

    const ensureFrame = ()=>{
        if (!recording)
        {
            const arena = arenas.pop() ?? createUniformArena();
            arena.reset();
            recording = { commands: [], pipelines: [], pass: null, viewport: null, arena };
        }
        return recording;
    };

    /**
     * Depth surfaces of a target's own size, standing in for a depth
     * surface larger than the target it is bound with. Direct3D allows a
     * depth surface at least as large as the colour target and uses its
     * top-left corner; WebGPU attaches only equal sizes, and a pass that
     * disagrees invalidates the whole frame's command buffer -- a black
     * frame with nothing else wrong in it. A program drawing a glow into a
     * quarter-size target with its screen-size depth still bound is the
     * ordinary case. The stand-in is per depth surface and size, kept for
     * the run; what it holds is not what the corner of the larger one
     * would, which a program that reads depth back across that boundary
     * would notice and nothing else does.
     *
     * @type {WeakMap<object, Map<string, import('../webgpu/contract.js').Surface>>}
     */
    const standInDepths = new WeakMap();
    /**
     * Surfaces given up by the device, destroyed once the frame being
     * recorded when they were has been replayed.
     * @type {import('../webgpu/contract.js').Surface[]}
     */
    const retiring = [];

    /**
     * The depth attachment for the model's targets: the bound depth surface
     * when it is the target's size, a stand-in of the target's size when
     * it is larger, and none when there is none.
     *
     * @param {RenderModel} model
     * @param {import('../webgpu/contract.js').Surface} target
     */
    const depthFor = (model, target)=>{
        if (!model.depthStencil)
        {
            return null;
        }
        const depth = surfaceFor(model.depthStencil);
        if (depth.width === target.width && depth.height === target.height)
        {
            return depth;
        }
        let sizes = standInDepths.get(depth);
        if (!sizes)
        {
            sizes = new Map();
            standInDepths.set(depth, sizes);
        }
        const key = `${target.width}x${target.height}`;
        const standing = sizes.get(key);
        if (standing)
        {
            return standing;
        }
        const made = backend.createSurface({
            width: target.width,
            height: target.height,
            format: depth.format,
            label: 'depth-stand-in',
            usage: TextureUsage.RENDER_ATTACHMENT,
        });
        sizes.set(key, made);
        return made;
    };

    /**
     * @param {RenderModel} model
     * @param {{ clearColor?: any, clearDepth?: number, clearStencil?: number }} clearing
     */
    const beginPass = (model, clearing)=>{
        const frame = ensureFrame();
        const target = surfaceFor(model.renderTarget);
        const depth = depthFor(model, target);
        frame.commands.push({ kind: 'pass', target, depth, ...clearing });
        frame.pass = { target, depth };
        frame.viewport = null;
    };

    /** @param {RenderModel} model */
    const ensurePass = model=>{
        const frame = ensureFrame();
        const target = surfaceFor(model.renderTarget);
        const depth = depthFor(model, target);
        if (!frame.pass || frame.pass.target !== target || frame.pass.depth !== depth)
        {
            beginPass(model, {});
        }
        return frame;
    };

    /** @param {RenderModel} model */
    const formatsOf = model=>({
        targetFormat: surfaceFor(model.renderTarget).format,
        targetHasAlpha: FORMAT_INFO[describe(model.renderTarget).Format].alpha !== false,
        depthFormat: model.depthStencil ? surfaceFor(model.depthStencil).format : undefined,
    });

    /**
     * The pass for the model's targets, with the model's viewport applied.
     * Setting the viewport also sets the scissor, so anything that narrows
     * the scissor has to come after this, not before.
     *
     * @param {RenderModel} model
     */
    const ensureViewport = model=>{
        const frame = ensurePass(model);
        if (frame.viewport !== model.viewport)
        {
            frame.commands.push({ kind: 'viewport', rect: model.viewport.rect });
            frame.viewport = model.viewport;
        }
        return frame;
    };

    const programs = createProgramCache({ backend });
    /**
     * A shader's translations, by the shape of the inputs it was translated
     * for; the object itself is the key, so a released shader takes its
     * translations with it.
     *
     * @type {WeakMap<object, Map<string, any>>}
     */
    const translations = new WeakMap();
    /** @type {Map<string, any>} the fixed vertex stages of hybrids, by declaration and shapes */
    const hybridStages = new Map();
    /** @type {Map<string, any>} real samplers for the program path, by descriptor */
    const programSamplers = new Map();
    /** What has been reported once already about a program. */
    const programReports = new Set();

    /**
     * @param {object} shader @param {string} tag @param {() => any} make
     */
    const translationOf = (shader, tag, make)=>{
        let held = translations.get(shader);
        if (!held)
        {
            held = new Map();
            translations.set(shader, held);
        }
        let made = held.get(tag);
        if (!made)
        {
            made = make();
            held.set(tag, made);
        }
        return made;
    };

    /**
     * @param {string} key @param {string} detail
     */
    const reportProgram = (key, detail)=>{
        if (programReports.has(key))
        {
            return;
        }
        programReports.add(key);
        divergence?.('Direct3D', detail);
    };

    /**
     * A real sampler for the program path, one per distinct state. The
     * fixed-function path samples through one hardware sampler and applies
     * the state in its own shader; a translated shader samples as it was
     * written, so the state has to be in the sampler it is given.
     *
     * @param {Map<number, number>} states
     */
    const programSamplerFor = states=>{
        const descriptor = samplerDescriptorOf(states, mipsApplied);
        const key = Object.values(descriptor).join('|');
        const existing = programSamplers.get(key);
        if (existing)
        {
            return existing;
        }
        if (!createSampler)
        {
            throw new Error(
                'graphics/d3d8: a textured draw needs a sampler factory and none was supplied');
        }
        const made = createSampler({ label: `sampler:${key}`, ...descriptor });
        programSamplers.set(key, made);
        return made;
    };

    /**
     * The usages a hybrid's fixed vertex stage carries through: what a pixel
     * shader can read from a fixed-function vertex.
     */
    const HYBRID_USAGES = new Set([0, 9, 10, 5, 3]);

    /**
     * Everything a draw through shaders needs that is not its geometry, or
     * null when no pipeline can be built for it -- counted and reported, not
     * raised, because the program has already been told the call succeeded.
     *
     * @param {RenderModel} model
     * @param {number} stride
     * @param {string} topology
     * @param {ProgramState} program
     */
    const prepareProgram = (model, stride, topology, program)=>{
        if (!program.declaration)
        {
            skip('program');
            reportProgram(`nodecl:${program.vertexId}/${program.pixelId}`,
                `a draw with shaders ${program.vertexId}/${program.pixelId} and no vertex`
                + ' declaration or FVF was not drawn');
            return null;
        }
        if (!program.pixel)
        {
            return prepareMixed(model, stride, topology, program);
        }
        const pixelShader = /** @type {object} */ (program.pixelShader);
        // The fixed-function fog stage runs after a pixel shader below model 3,
        // so a shader-drawn surface is fogged exactly as a fixed-function one
        // is -- and this device refuses a pixel shader above model 2. Only a
        // draw whose vertex stage is the fixed one can promise the oFog
        // varying the mix reads, so a draw through a vertex shader of the
        // program's own keeps the fog Direct3D would take from that shader,
        // which this translation does not compute.
        const fog = program.vertex ? 0 : fogModeOf(model, fogApplied);
        const pixel = translationOf(pixelShader, `ps|fog${fog}`,
            ()=>translateShader(
                /** @type {import('../d3d9/shader.js').ParsedShader} */ (program.pixel),
                fog === 0 ? {} : { fog }));
        if (pixel.error)
        {
            skip('program');
            reportProgram(`ps:${program.pixelId}`,
                `pixel shader ${program.pixelId} was not drawn: ${pixel.error}`);
            return null;
        }
        /** @type {import('../webgpu/internal/programmable.js').DeclaredInput[]} */
        let wanted;
        if (program.vertex)
        {
            const base = translationOf(/** @type {object} */ (program.vertexShader), 'vs',
                ()=>translateShader(
                    /** @type {import('../d3d9/shader.js').ParsedShader} */ (program.vertex)));
            if (base.error)
            {
                skip('program');
                reportProgram(`vs:${program.vertexId}`,
                    `vertex shader ${program.vertexId} was not drawn: ${base.error}`);
                return null;
            }
            wanted = base.inputs;
        }
        else
        {
            wanted = program.declaration
                .filter(element=>HYBRID_USAGES.has(element.Usage))
                .map((element, index)=>({
                    location: index, usage: element.Usage, usageIndex: element.UsageIndex,
                    register: index,
                }));
        }
        const laid = vertexLayoutOf(program.declaration, wanted, stride);
        if (!laid.layout)
        {
            skip('program');
            reportProgram(`decl:${program.declarationId}`,
                `a draw through declaration ${program.declarationId} was not drawn: ${laid.error}`);
            return null;
        }
        const layout = laid.layout;
        const shapes = shapeKey(layout);
        // A varying the pixel stage reads and the vertex shader never writes
        // is zero, as the vertex stage's own output: a fragment input with
        // no vertex output fails the pipeline, where Direct3D reads whatever
        // was left in the register.
        const written = program.vertex
            ? translationOf(/** @type {object} */ (program.vertexShader), 'vs',
                ()=>translateShader(
                    /** @type {import('../d3d9/shader.js').ParsedShader} */ (program.vertex)))
                .outputs
            : wanted
                .filter(element=>element.usage === D3DDECLUSAGE.COLOR
                    || element.usage === D3DDECLUSAGE.TEXCOORD)
                .map(element=>varyingLocation(element.usage, element.usageIndex));
        // A coordinate set the fixed-function stages generate from the vertex
        // in camera space is written by the made vertex stage whatever the
        // declaration carries under that number, since that is what the
        // fixed function hands a pixel shader.
        const generated = program.vertex ? [] : hybridGeneration(model);
        const missing = pixel.reads.filter(
            (/** @type {number} */ location)=>!written.includes(location)
                && !generated.some((mode, set)=>mode !== 0
                    && varyingLocation(D3DDECLUSAGE.TEXCOORD, set) === location));
        const vertex = program.vertex
            ? translationOf(/** @type {object} */ (program.vertexShader),
                `vs:${shapes}|w${missing.join(',')}`,
                ()=>translateShader(
                    /** @type {import('../d3d9/shader.js').ParsedShader} */ (program.vertex),
                    { inputs: layout.shapes, alsoWrite: missing }))
            : hybridStageFor(
                `${program.declarationId}|${shapes}|w${missing.join(',')}|g${generated.join(',')}`
                    + `|f${fog}`,
                wanted, layout.shapes, missing, generated, fog);
        if (vertex.error)
        {
            skip('program');
            reportProgram(`vs:${program.vertexId}:${program.declarationId}`,
                `vertex stage of shader ${program.vertexId} was not drawn: ${vertex.error}`);
            return null;
        }
        const samplerBindings = pixel.samplers.map((/** @type {any} */ entry)=>{
            const texture = model.textures.get(entry.index);
            return {
                stage: entry.index,
                texture,
                view: texture ? uploadIfDirty(texture).view : placeholderView(),
                sampler: programSamplerFor(model.stageStates(entry.index)),
                placeholder: !texture,
            };
        });
        const take = ensureFrame().arena.take;
        const vertexBlocks = program.vertex
            ? constantBlocks(program.vertexConstants, vertex.constants, take)
            : hybridBlocks(model, take);
        const pixelBlocks = constantBlocks(program.pixelConstants, pixel.constants, take);
        const state = {
            ...pipelineStateOf(model, {
                fvf: 0, topology, ...formatsOf(model), stages: [], lighting: null,
                fog: fogApplied,
            }),
            vertexShader: program.vertex ? program.vertexId : -1,
            pixelShader: program.pixelId,
        };
        return {
            version: undefined,
            contentVersion: 0,
            stride,
            topology,
            state,
            uniforms: vertexBlocks[0],
            template: null,
            stageBindings: samplerBindings,
            lighting: null,
            fogSetting: '',
            layout: null,
            textures: [],
            truncated: null,
            pipelineFrame: null,
            pipelineIndex: 0,
            program: {
                source: {
                    key: `${state.vertexShader}/${state.pixelShader}/${program.declarationId}`
                        + `/${shapes}/${stride}`,
                    vertex, pixel, layout,
                },
                declarationId: program.declarationId,
                vertexBlocks,
                pixelBlocks,
                samplerBindings,
            },
        };
    };

    /**
     * A vertex shader over the fixed-function pixel stage: the shader's
     * translation as the vertex stage, and a fragment stage made from the
     * stage cascade, fog and alpha test in force, reading what the shader
     * wrote. The pipeline is the programmable one, so the cascade's block
     * travels as the pixel stage's first constant buffer and its textures
     * in the sampler group.
     *
     * @param {RenderModel} model
     * @param {number} stride
     * @param {string} topology
     * @param {ProgramState} program
     * @returns {PreparedDraw | null}
     */
    const prepareMixed = (model, stride, topology, program)=>{
        const base = translationOf(/** @type {object} */ (program.vertexShader), 'vs',
            ()=>translateShader(
                /** @type {import('../d3d9/shader.js').ParsedShader} */ (program.vertex)));
        if (base.error)
        {
            skip('program');
            reportProgram(`vs:${program.vertexId}`,
                `vertex shader ${program.vertexId} was not drawn: ${base.error}`);
            return null;
        }
        const declaration = /** @type {readonly import('../webgpu/internal/programmable.js')
            .VertexElement[]} */ (program.declaration);
        const laid = vertexLayoutOf(declaration, base.inputs, stride);
        if (!laid.layout)
        {
            skip('program');
            reportProgram(`decl:${program.declarationId}`,
                `a draw through declaration ${program.declarationId} was not drawn: ${laid.error}`);
            return null;
        }
        const layout = laid.layout;
        const shapes = shapeKey(layout);
        /** @type {import('../d3d9/wgsl.js').TranslatedShader} */
        const vertex = translationOf(/** @type {object} */ (program.vertexShader),
            `vs:${shapes}`, ()=>translateShader(
                /** @type {import('../d3d9/shader.js').ParsedShader} */ (program.vertex),
                { inputs: layout.shapes }));
        if (vertex.error)
        {
            skip('program');
            reportProgram(`vs:${program.vertexId}:${program.declarationId}`,
                `vertex stage of shader ${program.vertexId} was not drawn: ${vertex.error}`);
            return null;
        }
        // The cascade ends where the shader stopped writing coordinate sets,
        // as it ends where a vertex format stops carrying them.
        let sets = 0;
        for (const location of vertex.outputs)
        {
            if (location >= 2 && location < 10)
            {
                sets = Math.max(sets, location - 1);
            }
        }
        const cascade = stageCascade(model, {
            texCoordSets: sets, attributes: [], stride, preTransformed: false, blendWeights: 0,
        });
        reportCascade(cascade);
        const state = {
            ...pipelineStateOf(model, {
                fvf: 0, topology, ...formatsOf(model), stages: cascade.stages, lighting: null,
                fog: fogApplied,
            }),
            vertexShader: program.vertexId,
            pixelShader: -1,
        };
        const pixel = fixedFragmentStage(state, vertex.outputs);
        const samplerBindings = cascade.stages.map((stage, index)=>{
            const texture = cascade.textures[index];
            return {
                stage: index,
                texture,
                view: texture ? uploadIfDirty(texture).view : placeholderView(),
                sampler: samplerFor(model.stageStates(index)),
                placeholder: !texture,
            };
        });
        const take = ensureFrame().arena.take;
        const vertexBlocks = constantBlocks(program.vertexConstants, vertex.constants, take);
        const pixelBlocks = [uniformsOf(model, null, take, mipsApplied), take(64), take(16)];
        counters.prepared.built++;
        return {
            version: undefined,
            contentVersion: 0,
            stride,
            topology,
            state,
            uniforms: vertexBlocks[0],
            template: null,
            stageBindings: samplerBindings,
            lighting: null,
            fogSetting: '',
            layout: null,
            textures: cascade.textures,
            truncated: cascade.truncated,
            pipelineFrame: null,
            pipelineIndex: 0,
            program: {
                source: {
                    key: `${state.vertexShader}/ffp/${program.declarationId}/${shapes}/${stride}`
                        + `/${pipelineKey(state)}`,
                    vertex, pixel, layout,
                },
                declarationId: program.declarationId,
                vertexBlocks,
                pixelBlocks,
                samplerBindings,
            },
        };
    };

    /**
     * @param {string} key
     * @param {import('../webgpu/internal/programmable.js').DeclaredInput[]} wanted
     * @param {Map<number, import('../d3d9/wgsl.js').InputShape>} shapes
     * @param {number[]} alsoWrite
     * @param {number[]} generated
     * @param {number} fog  D3DFOG; zero for none.
     */
    const hybridStageFor = (key, wanted, shapes, alsoWrite, generated, fog)=>{
        const existing = hybridStages.get(key);
        if (existing)
        {
            return existing;
        }
        const made = fixedVertexStage(wanted, shapes, alsoWrite, generated, fog);
        hybridStages.set(key, made);
        return made;
    };

    /**
     * Per coordinate set, the generation mode of the stage of that number,
     * up to the last stage the cascade runs: zero for a carried set.
     *
     * @param {RenderModel} model
     */
    const hybridGeneration = model=>{
        /** @type {number[]} */
        const modes = [];
        for (let stage = 0; stage < STAGE_COUNT; stage++)
        {
            const states = model.stageStates(stage);
            if ((states.get(D3DTSS.COLOROP) ?? 0) === D3DTOP.DISABLE)
            {
                break;
            }
            const index = states.get(D3DTSS.TEXCOORDINDEX) ?? 0;
            modes.push(generates(index) ? generationOf(index) : 0);
        }
        while (modes.length > 0 && modes[modes.length - 1] === 0)
        {
            modes.pop();
        }
        return modes;
    };

    /**
     * The constants a hybrid's fixed vertex stage reads: the same
     * world-view-projection the fixed-function block carries, then the
     * viewport's offset and scale, world-view and the stage transforms for a
     * generated coordinate.
     *
     * @param {RenderModel} model @param {(floats: number) => Float32Array} take
     */
    const hybridBlocks = (model, take)=>{
        const floats = take(HYBRID_CONSTANTS.COUNT * 4);
        const world = transformOf(model, D3DTS.WORLD);
        const view = transformOf(model, D3DTS.VIEW);
        const worldView = multiplyMatrices(world, view);
        floats.set(multiplyMatrices(worldView, transformOf(model, D3DTS.PROJECTION)),
            HYBRID_CONSTANTS.MATRIX * 4);
        floats.set(model.viewport.offset, HYBRID_CONSTANTS.VIEWPORT * 4);
        floats.set(model.viewport.scale, HYBRID_CONSTANTS.VIEWPORT * 4 + 2);
        floats.set(worldView, HYBRID_CONSTANTS.WORLD_VIEW * 4);
        for (const [index, rows] of stageTransforms(model).entries())
        {
            floats.set(rows, (HYBRID_CONSTANTS.TRANSFORMS + index * 4) * 4);
        }
        // The fog the fixed vertex stage computes and carries to a fogged
        // pixel shader: its range and colour, beside the transform it already
        // reads.
        const rs = (/** @type {string} */ name)=>model.renderStates.get(D3DRS[name]) ?? 0;
        floats.set([
            dwordToFloat(rs('FOGSTART')),
            dwordToFloat(rs('FOGEND')),
            dwordToFloat(rs('FOGDENSITY')),
            0,
        ], HYBRID_CONSTANTS.FOG * 4);
        const fogColour = colorToFloats(rs('FOGCOLOR'));
        floats.set([fogColour.r, fogColour.g, fogColour.b, fogColour.a],
            HYBRID_CONSTANTS.FOG_COLOR * 4);
        return [floats, take(64), take(16)];
    };

    /**
     * Records one draw against the pass the model's targets name.
     *
     * The pipeline is asked for once per prepared state and then named by the
     * index it took in this frame's list: building the cache key is a string
     * per field and a join per stage, which at one a draw is the most expensive
     * thing a draw that changed no state does.
     *
     * @param {RenderModel} model
     * @param {PreparedDraw} prepared
     * @param {any} geometry
     */
    const record = (model, prepared, geometry)=>{
        if (maxDraws >= 0 && kept >= maxDraws)
        {
            return;
        }
        kept++;
        frameStats.draws++;
        if (model.renderTarget !== model.backBuffer)
        {
            frameStats.offscreenDraws++;
            frameStats.offscreenTargets.add(model.renderTarget);
        }
        for (const binding of prepared.stageBindings)
        {
            if (binding.placeholder)
            {
                frameStats.placeholder++;
            }
            else
            {
                frameStats.textures.add(binding.view);
            }
        }
        const frame = ensureViewport(model);
        if (prepared.pipelineFrame !== frame)
        {
            prepared.pipelineIndex = frame.pipelines.length;
            prepared.pipelineFrame = frame;
            frame.pipelines.push(prepared.program
                ? programs.get(prepared.state, prepared.program.source)
                : backend.pipelineFor(prepared.state));
        }
        frame.commands.push({
            kind: 'draw',
            pipeline: prepared.pipelineIndex,
            state: prepared.state,
            uniforms: prepared.uniforms,
            stageBindings: prepared.stageBindings,
            program: prepared.program,
            ...geometry,
        });
    };

    /**
     * What one state of the device prepares to, kept until the state changes.
     *
     * @typedef {Object} PreparedDraw
     * @property {number | undefined} version   The device state this was prepared from.
     * @property {number} contentVersion        The texture contents it was prepared from.
     * @property {number} stride
     * @property {string} topology
     * @property {import('../webgpu/internal/pipeline.js').PipelineState} state
     * @property {Float32Array} uniforms        This draw's block: the one field that is per draw.
     * @property {Float32Array | null} template
     *     The block every draw of this state copies, with the two world rows still to write.
     * @property {{ view: any, sampler: any, placeholder?: boolean }[]} stageBindings
     * @property {import('../webgpu/internal/pipeline.js').LightingState | null} lighting
     * @property {string} fogSetting            Built on first use; a frame's diagnostics read it.
     * @property {import('../webgpu/internal/vertexformat.js').VertexLayout | null} layout
     * @property {(any | null)[]} textures
     * @property {CascadeTruncation | null} truncated
     * @property {any} pipelineFrame            The recording the index below belongs to.
     * @property {number} pipelineIndex
     * @property {any} program                  The programmable half, or null.
     */

    /**
     * The preparation of the state the last fixed-function draw ran under, or
     * null when there is none to reuse.
     *
     * Everything in it is derived from device state and from the draw's stride
     * and topology, and nothing from the draw's own vertices -- so while the
     * device's counter and those two agree with what it was built from, it is
     * what this draw would have built again. The world transform is the one
     * state that counter deliberately ignores, and `blockFor` writes it per
     * draw; nothing else derived from the world transform may be kept here.
     *
     * @type {PreparedDraw | null}
     */
    let preparedState = null;
    /**
     * Raised whenever a texture's own bytes are marked for upload, so that a
     * preparation holding that texture's view is built again and the upload
     * owed to it happens before the next draw that samples it.
     */
    let contentVersion = 0;

    /**
     * The preparations of the states this frame has drawn with, so a program
     * that alternates between a few states does not build each of them again on
     * every draw. Bounded because a frame's distinct states are few and one
     * that is no longer drawn with should not be kept for ever.
     *
     * @type {Map<string, PreparedDraw>}
     */
    const preparedCache = new Map();
    const PREPARED_CACHE_LIMIT = 64;

    /** @type {WeakMap<object, number>} */
    const surfaceIds = new WeakMap();
    let nextSurfaceId = 0;
    /** @param {any} surface @returns {number} */
    const surfaceIdOf = surface=>{
        let id = surfaceIds.get(surface);
        if (id === undefined)
        {
            id = ++nextSurfaceId;
            surfaceIds.set(surface, id);
        }
        return id;
    };

    /**
     * The targets and their formats, the transforms beside the world ones, the
     * material, the enabled lights and the viewport, as a number: equal numbers
     * are equal values. Printing their floats is most of what naming a state
     * costs, and a program that flips a render state between draws changes
     * none of them; so, for a device that replaces these objects rather than
     * writing into them (one that offers `stateVersionBesideTextures`), the
     * number is kept while every one of them is the same object and the lights
     * have not changed.
     *
     * Surface identity is part of it because a Reset rebuilds the implicit
     * surfaces: two states that read alike across one are not the same
     * preparation, because the views they hold are of different things.
     *
     * @param {RenderModel} model
     * @returns {number}
     */
    const slowStateOf = model=>{
        const replaces = model.stateVersionBesideTextures !== undefined
            && model.lightsVersion !== undefined;
        /** @type {unknown[]} */
        const sources = [model.renderTarget, model.depthStencil, model.material, model.viewport,
            model.lightsVersion];
        for (const [type, matrix] of model.transforms)
        {
            if (type < D3DTS.WORLD || type > D3DTS.WORLD_LAST)
            {
                sources.push(type, matrix);
            }
        }
        if (replaces && sources.length === floatSources.length
            && sources.every((source, index)=>source === floatSources[index]))
        {
            return slowNumber;
        }
        const formats = formatsOf(model);
        /** @type {(string | number)[]} */
        const parts = [formats.targetFormat, formats.targetHasAlpha ? 1 : 0,
            formats.depthFormat ?? '-', surfaceIdOf(surfaceFor(model.renderTarget)),
            model.depthStencil ? surfaceIdOf(surfaceFor(model.depthStencil)) : '-'];
        for (const [type, matrix] of model.transforms)
        {
            if (type >= D3DTS.WORLD && type <= D3DTS.WORLD_LAST)
            {
                continue;
            }
            parts.push(type, ...matrix);
        }
        const material = model.material;
        for (const colour of [material.Diffuse, material.Ambient, material.Specular,
            material.Emissive])
        {
            parts.push(colour.r, colour.g, colour.b, colour.a);
        }
        parts.push(material.Power);
        for (const light of enabledLights(model))
        {
            parts.push(light.Type, light.Range, light.Falloff, light.Theta, light.Phi,
                light.Diffuse.r, light.Diffuse.g, light.Diffuse.b, light.Diffuse.a,
                light.Specular.r, light.Specular.g, light.Specular.b, light.Specular.a,
                light.Ambient.r, light.Ambient.g, light.Ambient.b, light.Ambient.a,
                light.Position.x, light.Position.y, light.Position.z,
                light.Direction.x, light.Direction.y, light.Direction.z,
                light.Attenuation0, light.Attenuation1, light.Attenuation2);
        }
        parts.push(model.viewport.rect.x, model.viewport.rect.y,
            model.viewport.rect.width, model.viewport.rect.height,
            ...model.viewport.offset, ...model.viewport.scale);
        const text = parts.join('|');
        let number = slowNumbers.get(text);
        if (number === undefined)
        {
            if (slowNumbers.size >= STATE_NUMBERS_LIMIT)
            {
                slowNumbers.clear();
            }
            number = nextStateNumber++;
            slowNumbers.set(text, number);
        }
        slowNumber = number;
        floatSources = replaces ? sources : [];
        return slowNumber;
    };
    /** @type {Map<string, number>} */
    const slowNumbers = new Map();
    let slowNumber = -1;
    /** @type {unknown[]} */
    let floatSources = [];
    /**
     * Numbers name states for as long as the renderer lives and are never
     * reused, so a key made before a table was cleared cannot name a different
     * state after it.
     */
    let nextStateNumber = 0;
    const STATE_NUMBERS_LIMIT = 1024;

    /**
     * A stable number for the device state a preparation is built from: equal
     * numbers are equal values.
     *
     * The device raises `drawStateVersion` on every change, but a counter cannot
     * name a state that comes back: two draws alternating between the same two
     * states raise it twice per pair, so a one-entry cache keyed on it misses on
     * every draw. This is the state itself -- the values, not the fact that they
     * changed -- so a preparation can be kept per distinct state the frame draws
     * with. The world transform is the one state left out, because it moves
     * between most draws and the block is written afresh from it on every one.
     *
     * The render and stage states are laid out as words and looked up by
     * their hash, with no string built: a program that flips one render state
     * between draws names a state on every draw. Texture bindings and the
     * draw's own shape are not in it: see `preparationKeyOf`, which adds them.
     *
     * @param {RenderModel} model
     * @param {{ fvf: number, fixedFunctionLayout?: { id: number } | null }} processing
     * @returns {number}
     */
    const stateNumberOf = (model, processing)=>{
        let at = 0;
        /** @param {number} value */
        const put = value=>{
            if (at === stateScratch.length)
            {
                const grown = new Int32Array(stateScratch.length * 2);
                grown.set(stateScratch);
                stateScratch = grown;
            }
            stateScratch[at++] = value;
        };
        put(slowStateOf(model));
        put(processing.fvf);
        // A declaration read without a format is told apart by its own id.
        put(processing.fixedFunctionLayout?.id ?? 0);
        put(model.renderStates.size);
        for (const [state, value] of model.renderStates)
        {
            put(state);
            put(value);
        }
        for (let stage = 0; stage < STAGE_COUNT; stage++)
        {
            const states = model.stageStates(stage);
            put(states.size);
            for (const [state, value] of states)
            {
                put(state);
                put(value);
            }
        }
        // FNV-1a over the words; a hit is compared in full, so a collision
        // costs a comparison and never names two states alike.
        let hash = 0x811c9dc5;
        for (let index = 0; index < at; index++)
        {
            hash = Math.imul(hash ^ stateScratch[index], 0x01000193);
        }
        const bucket = intStates.get(hash);
        if (bucket !== undefined)
        {
            for (const entry of bucket)
            {
                if (entry.values.length === at && sameWords(entry.values, stateScratch))
                {
                    return entry.number;
                }
            }
        }
        if (intStateCount >= STATE_NUMBERS_LIMIT)
        {
            intStates.clear();
            intStateCount = 0;
        }
        const entry = { values: stateScratch.slice(0, at), number: nextStateNumber++ };
        if (bucket !== undefined && intStates.has(hash))
        {
            bucket.push(entry);
        }
        else
        {
            intStates.set(hash, [entry]);
        }
        intStateCount++;
        return entry.number;
    };

    /** @param {Int32Array} stored @param {Int32Array} scratch @returns {boolean} */
    const sameWords = (stored, scratch)=>{
        for (let index = 0; index < stored.length; index++)
        {
            if (stored[index] !== scratch[index])
            {
                return false;
            }
        }
        return true;
    };

    let stateScratch = new Int32Array(2048);
    /** @type {Map<number, { values: Int32Array, number: number }[]>} */
    const intStates = new Map();
    let intStateCount = 0;
    let stateKey = '';
    /** @type {number | undefined} */
    let stateKeyVersion;

    /**
     * The whole key: the state beside textures, kept while
     * `stateVersionBesideTextures` holds still -- a program that binds a new
     * texture before most draws changes nothing else between them -- then the
     * draw's own shape and every stage's texture with the generation of its
     * bytes, which change without the device hearing of it.
     *
     * @param {RenderModel} model
     * @param {{ fvf: number, fixedFunctionLayout?: { id: number } | null }} processing
     * @param {number} stride
     * @param {string} topology
     * @returns {string}
     */
    const preparationKeyOf = (model, processing, stride, topology)=>{
        const version = model.stateVersionBesideTextures;
        if (version === undefined || version !== stateKeyVersion)
        {
            stateKey = `s${stateNumberOf(model, processing)}`;
            stateKeyVersion = version;
        }
        let key = `${stateKey}|${stride}|${topology}`;
        for (let stage = 0; stage < STAGE_COUNT; stage++)
        {
            const texture = model.textures.get(stage);
            const held = texture ? textures.get(texture) : null;
            key += held ? `|${held.id}:${held.soil}` : '|-';
        }
        return key;
    };

    /**
     * This draw's uniform block: the prepared state's block with the two
     * fields the world transform reaches written over it.
     *
     * @param {RenderModel} model
     * @param {PreparedDraw} prepared
     * @returns {Float32Array}
     */
    const blockFor = (model, prepared)=>{
        const template = /** @type {Float32Array} */ (prepared.template);
        const block = ensureFrame().arena.take(template.length);
        block.set(template);
        const world = transformOf(model, D3DTS.WORLD);
        block.set(multiplyMatrices(
            multiplyMatrices(world, transformOf(model, D3DTS.VIEW), WORLD_VIEW),
            transformOf(model, D3DTS.PROJECTION), WORLD_VIEW_PROJECTION),
        UNIFORM_AT.worldViewProjection);
        block.set(world, UNIFORM_AT.world);
        return block;
    };

    /**
     * Serves a draw from a preparation already built for its state, giving it a
     * block of its own with this draw's world transform written over it.
     *
     * The tallies are per draw even where the state is not: a report that
     * counted states rather than draws would say a frame drew a fraction of
     * what it drew.
     *
     * @param {RenderModel} model
     * @param {PreparedDraw} prepared
     * @returns {PreparedDraw}
     */
    const reuse = (model, prepared)=>{
        counters.prepared.reused++;
        reportCascade(prepared);
        countLighting(model, prepared);
        prepared.uniforms = blockFor(model, prepared);
        return prepared;
    };

    /**
     * Everything a fixed-function draw needs that is not its geometry, or null
     * when the draw cannot be rendered by what exists -- counted, not raised,
     * because the program has already been told the call succeeded.
     *
     * @param {RenderModel} model
     * @param {number} stride
     * @param {string} topology
     * @returns {PreparedDraw | null}
     */
    const prepare = (model, stride, topology)=>{
        const processing = model.stageProcessing;
        if (processing.program && (processing.vertexShader !== 0 || processing.pixelShader !== 0))
        {
            return prepareProgram(model, stride, topology, processing.program);
        }
        if (processing.vertexShader !== 0)
        {
            skip('vertexShader');
            return null;
        }
        if (processing.pixelShader !== 0)
        {
            skip('pixelShader');
            return null;
        }
        const version = model.drawStateVersion;
        if (preparedState !== null && version !== undefined && preparedState.version === version
            && preparedState.contentVersion === contentVersion
            && preparedState.stride === stride && preparedState.topology === topology)
        {
            return reuse(model, preparedState);
        }
        // The state changed, but it may be one this frame has drawn with
        // before and kept. A program that alternates between a few states is
        // the case a one-entry cache cannot serve.
        const key = preparationKeyOf(model, processing, stride, topology);
        const cached = preparedCache.get(key);
        if (cached !== undefined)
        {
            // The key names the values, so this is the state that was built.
            // Its textures' generations are in the key, so nothing they hold
            // was rewritten since. Refreshing the counters lets the next
            // unchanged draw take the cheap path above.
            cached.version = version;
            cached.contentVersion = contentVersion;
            cached.stride = stride;
            cached.topology = topology;
            // Moved to the end of the insertion order, so the entry a frame
            // stops drawing with is the one eviction reaches first.
            preparedCache.delete(key);
            preparedCache.set(key, cached);
            preparedState = cached;
            return reuse(model, cached);
        }
        /** @type {import('../webgpu/internal/vertexformat.js').VertexLayout} */
        let layout;
        /** @type {string | undefined} */
        let vertexLayoutKey;
        if ((processing.fvf & POSITION_MASK) === 0)
        {
            // A declaration no format spells: read through the layout the
            // device worked out from its elements, when the fixed-function
            // stage can read it at all. Otherwise the draw is dropped and
            // counted -- the program was already told it succeeded -- and never
            // raised into the program's thread.
            const declared = processing.fixedFunctionLayout
                ? layoutOfDeclaration(processing.fixedFunctionLayout, stride)
                : null;
            if (!declared)
            {
                skip('layout');
                reportLayout();
                return null;
            }
            layout = declared;
            vertexLayoutKey = `d${stride}:${declared.attributes
                .map(attribute=>`${attribute.name}@${attribute.offset}:${attribute.format}`)
                .join(',')}`;
        }
        else
        {
            layout = decodeFvf(processing.fvf);
            if (stride !== layout.stride)
            {
                skip('stride');
                return null;
            }
        }
        const cascade = stageCascade(model, layout);
        reportCascade(cascade);
        if (skipTextures.size > 0 && cascade.textures.some(
            texture=>texture && skipTextures.has(textures.get(texture)?.id ?? '')))
        {
            skip('texture');
            return null;
        }
        const stageBindings = cascade.stages.map((stage, index)=>{
            const texture = cascade.textures[index];
            return {
                view: texture ? uploadIfDirty(texture).view : placeholderView(),
                sampler: samplerFor(model.stageStates(index)),
                // Which of those two it was, recorded rather than inferred: a
                // stage bound to the placeholder samples a texture nothing
                // wrote, and every piece of state around it still names the
                // texture the program bound.
                placeholder: !texture,
            };
        });
        const lighting = lightingOf(model, layout);
        reportTextureTransform(model, cascade.stages.length);
        reportCoordGeneration(cascade.stages);
        counters.prepared.built++;
        const state = pipelineStateOf(model, {
            fvf: processing.fvf,
            ...(vertexLayoutKey === undefined ? {} : { vertexLayout: layout, vertexLayoutKey }),
            topology,
            ...formatsOf(model),
            stages: cascade.stages,
            lighting,
            fog: fogApplied,
        });
        // `layout` and `textures` are the frame dump's, and are handed back
        // rather than worked out again there: both are already in hand and
        // neither can be recovered from the recorded command.
        //
        // The template carries whatever world transform this draw had; the
        // block below writes those two fields again, here as in every later
        // draw of this state, so one draw and a hundred produce the same bytes.
        preparedState = {
            version,
            contentVersion,
            stride,
            topology,
            state,
            uniforms: EMPTY_BLOCK,
            template: uniformsOf(model, lighting, undefined, mipsApplied),
            stageBindings,
            lighting,
            fogSetting: '',
            layout,
            textures: cascade.textures,
            truncated: cascade.truncated,
            pipelineFrame: null,
            pipelineIndex: 0,
            program: null,
        };
        countLighting(model, preparedState);
        preparedState.uniforms = blockFor(model, preparedState);
        preparedCache.set(key, preparedState);
        if (preparedCache.size > PREPARED_CACHE_LIMIT)
        {
            const oldest = preparedCache.keys().next().value;
            if (oldest !== undefined)
            {
                preparedCache.delete(oldest);
            }
        }
        return preparedState;
    };

    /** @param {number} format D3DFMT_INDEX @returns {{ gpu: string, bytes: number } | null} */
    const indexFormatOf = format=>{
        if (format === D3DFMT_INDEX.INDEX16)
        {
            return { gpu: 'uint16', bytes: 2 };
        }
        if (format === D3DFMT_INDEX.INDEX32)
        {
            return { gpu: 'uint32', bytes: 4 };
        }
        return null;
    };

    /**
     * @param {Uint8Array} bytes
     * @param {number} elementBytes
     * @returns {Uint16Array | Uint32Array}
     */
    const indicesFrom = (bytes, elementBytes)=>{
        // Copied, so that the view is aligned whatever offset the bytes came in at.
        const copy = bytes.slice();
        return elementBytes === 2
            ? new Uint16Array(copy.buffer, 0, copy.byteLength >>> 1)
            : new Uint32Array(copy.buffer, 0, copy.byteLength >>> 2);
    };

    /**
     * A strip or fan rewritten as a list, written to the scratch ring.
     *
     * @param {number} type
     * @param {ArrayLike<number>} indices  in strip or fan order
     * @param {number} baseVertex
     */
    const expandedGeometry = (type, indices, baseVertex)=>{
        const expanded = listIndices(type, indices);
        return {
            indices: {
                ...scratchIndices.write(expanded),
                format: expanded.BYTES_PER_ELEMENT === 2 ? 'uint16' : 'uint32',
            },
            count: expanded.length,
            first: 0,
            baseVertex,
        };
    };

    /** The vertices zero to count, which is what a non-indexed fan is a fan of. */
    const ascending = (/** @type {number} */ count)=>
        Uint32Array.from({ length: count }, (_, index)=>index);

    return {
        /**
         * The program is about to write into a buffer's storage in guest
         * memory. The backend's lock is taken now, under the same flags, so
         * that a DISCARD renames before any draw recorded after it.
         *
         * @param {any} buffer @param {number} offset @param {number} length
         * @param {number} flags D3DLOCK
         */
        lockBuffer(buffer, offset, length, flags){
            if ((flags & D3DLOCK.READONLY) !== 0)
            {
                return;
            }
            const entry = bufferFor(buffer);
            entry.held = entry.gpu.lock(offset, length, lockFlagsOf(flags, LockFlags));
        },

        /**
         * The bytes the program wrote are read from guest memory now, and only
         * the locked range: after a DISCARD the rest of the buffer is
         * undefined by contract, and resending it would be the §14.1 traffic.
         *
         * @param {any} buffer
         */
        unlockBuffer(buffer){
            const entry = buffers.get(buffer);
            if (!entry || !entry.held)
            {
                return;
            }
            const held = entry.held;
            // The bytes go straight into the staging copy: a window is
            // enough, and the copy a read makes was a measured share of a
            // frame in a match, where a program refills its buffers every
            // draw.
            held.data.set(windowMemory(buffer.base + held.offset, held.length));
            entry.gpu.unlock(held);
            entry.held = null;
        },

        /**
         * Takes a texture the device created into the renderer's care: from
         * now on an unlock of its top level marks it for upload before the
         * next draw that samples it.
         *
         * @param {any} texture
         * @param {{ width: number, height: number, format: number, levels?: number,
         *           usage?: number }} desc
         */
        trackTexture(texture, desc){
            const levels = desc.levels ?? 1;
            const entry = {
                gpu: null, dirty: true, base: 0, levels, texture,
                // A render-target texture is written by the GPU as well as
                // by the guest, so its uploads have to keep their place in
                // the frame; see `uploadTexels`. A copy landing in a plain
                // texture turns this on too.
                ordered: ((desc.usage ?? 0) & D3DUSAGE.RENDERTARGET) !== 0,
                // Every level, until each has been uploaded once: a program
                // fills the chain it asked for, and a chain sampled with a
                // level missing shows the gap at the distance that level
                // covers.
                dirtyLevels: new Set(Array.from({ length: levels }, (_, level)=>level)),
                id: `t${nextTextureId++}`,
                // A per-texture generation of its contents, so a preparation
                // key can say which bytes it was built against without a
                // global counter that would invalidate every other texture's.
                soil: 0,
                ...desc,
            };
            textures.set(texture, entry);
            roster.add(entry);

            // The last release gives the texture's guest storage back. Its GPU
            // texture outlives that for as long as a stage still binds it --
            // a binding holds its texture without a public reference, and a
            // program may release its own and go on drawing -- and goes at the
            // first present that finds it bound nowhere, after that frame's
            // replay.
            const releaseTexture = texture.release;
            if (typeof releaseTexture === 'function')
            {
                texture.release = ()=>{
                    const left = releaseTexture();
                    if (left === 0 && roster.has(entry))
                    {
                        roster.delete(entry);
                        released.add(entry);
                    }
                    return left;
                };
            }

            /** @param {number} level */
            const soiled = level=>{
                entry.dirtyLevels.add(level);
                entry.dirty = true;
                entry.soil++;
                contentVersion++;
            };
            const unlockLevel = texture.UnlockRect;
            texture.UnlockRect = (/** @type {number} */ level)=>{
                const hr = unlockLevel(level);
                if (hr === D3D_OK)
                {
                    soiled(level);
                }
                return hr;
            };
            // Each level's storage is reachable through the level's own
            // surface too -- one object however many times it is asked for --
            // and a copy names that rather than the texture it belongs to. The
            // surfaces are made on demand, so each is taken into care as it is
            // first handed out.
            const hooked = new WeakSet();
            const surfaceLevel = texture.GetSurfaceLevel;
            /** @type {(level: number, out: { surface?: any }) => number} */
            const takeLevel = (level, out)=>{
                const hr = surfaceLevel(level, out);
                const surface = hr === D3D_OK ? out.surface : null;
                if (surface && !hooked.has(surface))
                {
                    hooked.add(surface);
                    textures.set(surface, entry);
                    surfaceLevels.set(surface, level);
                    const unlockSurface = surface.UnlockRect;
                    surface.UnlockRect = ()=>{
                        const unlocked = unlockSurface();
                        if (unlocked === D3D_OK)
                        {
                            soiled(level);
                        }
                        return unlocked;
                    };
                }
                return hr;
            };
            texture.GetSurfaceLevel = takeLevel;
            /** @type {{ surface?: any }} */
            const top = {};
            texture.GetSurfaceLevel(0, top);
            top.surface.release();
            entry.base = top.surface.base;
        },

        /**
         * Says that something other than a lock has written a texture's top
         * level, which is how a copy between surfaces reaches a texture that is
         * not lockable at all.
         *
         * A resource this renderer does not track is not an error: only a
         * texture is ever uploaded from guest memory, so a copy into anything
         * else has nothing to invalidate.
         *
         * @param {any} resource  A texture, or the surface of its top level.
         */
        markDirty(resource){
            const tracked = textures.get(resource);
            if (tracked)
            {
                tracked.dirtyLevels.add(surfaceLevels.get(resource) ?? 0);
                tracked.dirty = true;
                tracked.soil++;
                contentVersion++;
                return;
            }
            // A render target that is not a texture level: its bytes go up
            // at its next use on the GPU, in the order of the frame. A plain
            // surface has no GPU copy to bring up to date.
            const desc = describe(resource);
            if ((desc.Usage & D3DUSAGE.RENDERTARGET) !== 0 && !FORMAT_INFO[desc.Format].depth)
            {
                dirtyTargets.add(resource);
            }
        },

        /**
         * A rectangle of one surface into another, on the GPU, when both live
         * there: a render target's pixels are the GPU's and nothing else has
         * them. Answers false when the copy is not one this can make -- a
         * plain surface on either side, a depth format, two formats the GPU
         * stores differently, or one texture on both sides -- and the caller
         * then moves guest bytes as before.
         *
         * @param {any} source
         * @param {{ left: number, top: number, right: number, bottom: number }} rect
         * @param {any} destination @param {{ x: number, y: number }} point
         * @returns {boolean}
         */
        copySurface(source, rect, destination, point){
            if (!onGpu(source) || !onGpu(destination))
            {
                return false;
            }
            const from = surfaceFor(source);
            const into = surfaceFor(destination);
            if (from.format !== into.format || from.texture === into.texture)
            {
                return false;
            }
            const tracked = textures.get(destination);
            if (tracked)
            {
                // The GPU has written this texture now; its uploads from
                // here on keep their place in the frame.
                tracked.ordered = true;
            }
            ensureFrame().commands.push({
                kind: 'copy',
                source: from,
                destination: into,
                sourceOrigin: { x: rect.left, y: rect.top },
                destinationOrigin: { x: point.x, y: point.y },
                width: rect.right - rect.left,
                height: rect.bottom - rect.top,
            });
            return true;
        },

        /**
         * A surface's pixels as the GPU holds them at this point of the
         * frame, for a program that reads its target back.
         *
         * What has been recorded so far is replayed and submitted without a
         * present, and the surface copied out after it: the one case where a
         * frame reaches the queue in more than one piece, and the program
         * asked for exactly that. Rows are four bytes a pixel in the
         * surface's GPU format, blue first.
         *
         * @param {any} surface a d3d8 surface
         * @returns {Promise<{ width: number, height: number, data: Uint8Array }>}
         */
        readSurface(surface){
            const gpu = surfaceFor(surface);
            const recorded = ensureFrame();
            recording = null;
            recorded.dump = dump;
            const read = chain.then(()=>replay(recorded, null, gpu));
            chain = read.then(()=>undefined, failure);
            return /** @type {Promise<any>} */ (read);
        },

        /**
         * @param {RenderModel} model
         * @param {readonly { x1: number, y1: number, x2: number, y2: number }[]} rects
         * @param {number} flags D3DCLEAR
         * @param {number} color D3DCOLOR
         * @param {number} z
         * @param {number} stencil
         */
        clear(model, rects, flags, color, z, stencil){
            const target = describe(model.renderTarget);
            const rect = model.viewport.rect;
            const viewport = {
                x1: rect.x,
                y1: rect.y,
                x2: rect.x + rect.width,
                y2: rect.y + rect.height,
            };
            const areas = (rects.length > 0 ? rects.map(r=>clip(r, viewport)) : [viewport])
                .filter(area=>area.x2 > area.x1 && area.y2 > area.y1);
            if (areas.length === 0)
            {
                return;
            }
            counters.clears++;
            frameStats.clears++;
            if ((flags & D3DCLEAR.TARGET) !== 0 && model.renderTarget === model.backBuffer)
            {
                frameStats.clearColor = color >>> 0;
            }
            const whole = areas.length === 1 && areas[0].x1 === 0 && areas[0].y1 === 0
                && areas[0].x2 === target.Width && areas[0].y2 === target.Height;
            if (whole)
            {
                const value = colorToFloats(color);
                // A target without alpha has none to clear: the format says the
                // channel is undefined, and a zero there would make the
                // presented frame transparent.
                const alpha = target.Format === D3DFMT.A8R8G8B8 ? value.a : 1;
                beginPass(model, {
                    clearColor: (flags & D3DCLEAR.TARGET) !== 0
                        ? { ...value, a: alpha }
                        : undefined,
                    clearDepth: (flags & D3DCLEAR.ZBUFFER) !== 0 ? z : undefined,
                    clearStencil: (flags & D3DCLEAR.STENCIL) !== 0 ? stencil : undefined,
                });
                return;
            }
            if ((flags & (D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER)) === 0)
            {
                // A stencil-only clear of part of the target needs stencil
                // state the pipeline does not carry yet.
                skip('stencilRect');
                return;
            }
            // A clear of less than the target is a scissored quad through the
            // ordinary draw path, with the depth test off and the writes
            // chosen by the flags.
            const frame = ensureViewport(model);
            const state = {
                ...pipelineStateOf(model, {
                    fvf: CLEAR_FVF,
                    topology: 'triangle-list',
                    ...formatsOf(model),
                    stages: [],
                }),
                depthTest: false,
                depthWrite: (flags & D3DCLEAR.ZBUFFER) !== 0 && !!model.depthStencil,
                depthFunc: D3DCMP.ALWAYS,
                cullMode: D3DCULL.NONE,
                blend: false,
                srcBlend: D3DBLEND.ONE,
                destBlend: D3DBLEND.ZERO,
                colorWrite: ((flags & D3DCLEAR.TARGET) !== 0 ? 0xf : 0)
                    & (formatsOf(model).targetHasAlpha ? ~0 : ~COLORWRITEENABLE_ALPHA),
                alphaTest: false,
                fogMode: D3DFOG.NONE,
                // A clear is the colour it was given and nothing else: neither
                // the scene's lighting nor its specular pass belongs to it.
                specularEnable: false,
                lighting: null,
            };
            const prepared = /** @type {PreparedDraw} */ ({
                version: undefined,
                contentVersion: 0,
                stride: CLEAR_STRIDE,
                topology: 'triangle-list',
                state,
                uniforms: uniformBlock({
                    worldViewProjection: IDENTITY,
                    viewport: model.viewport,
                    textureFactor: 0,
                    fogColor: 0,
                    alphaRef: 0,
                }),
                template: null,
                stageBindings: [],
                lighting: null,
                fogSetting: '',
                layout: null,
                textures: [],
                truncated: null,
                pipelineFrame: null,
                pipelineIndex: 0,
                program: null,
            });
            for (const area of areas)
            {
                const vertices = new DataView(new ArrayBuffer(CLEAR_STRIDE * 6));
                const corners = [
                    [area.x1, area.y1], [area.x2, area.y1], [area.x1, area.y2],
                    [area.x1, area.y2], [area.x2, area.y1], [area.x2, area.y2],
                ];
                corners.forEach(([x, y], index)=>{
                    const at = index * CLEAR_STRIDE;
                    vertices.setFloat32(at, x, true);
                    vertices.setFloat32(at + 4, y, true);
                    vertices.setFloat32(at + 8, z, true);
                    vertices.setFloat32(at + 12, 1, true);
                    vertices.setUint32(at + 16, color >>> 0, true);
                });
                frame.commands.push({ kind: 'scissor', rect: {
                    x: area.x1, y: area.y1, width: area.x2 - area.x1, height: area.y2 - area.y1,
                } });
                record(model, prepared, {
                    vertices: scratchVertices.write(new Uint8Array(vertices.buffer)),
                    indices: null,
                    count: 6,
                    first: 0,
                });
            }
            frame.commands.push({ kind: 'scissor', rect: {
                x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            } });
        },

        /**
         * @param {RenderModel} model
         * @param {number} type
         * @param {number} startVertex
         * @param {number} primitiveCount
         */
        drawPrimitive(model, type, startVertex, primitiveCount){
            const stream = model.stream;
            const count = vertexCountOf(type, primitiveCount);
            const fan = type === D3DPT.TRIANGLEFAN;
            const prepared = prepare(model, stream.stride, fan ? LIST_OF[type] : TOPOLOGY[type]);
            if (!prepared)
            {
                return;
            }
            const streamBuffer = bufferFor(stream.buffer).gpu;
            // The bytes this draw reads must survive a later lock of the same
            // buffer in this frame, which is what makes such a lock rename.
            streamBuffer.markRead();
            record(model, prepared, {
                vertices: { gpu: streamBuffer.gpu, offset: 0 },
                ...(fan
                    ? expandedGeometry(type, ascending(count), startVertex)
                    : { indices: null, count, first: startVertex }),
            });
            if (dumpDraws && prepared.program)
            {
                dumpProgram(model, prepared, count);
            }
            else if (dumpDraws)
            {
                const vertices = readMemory(stream.buffer.base + startVertex * stream.stride,
                    count * stream.stride);
                dumpDraw(model, prepared, vertices, stream.stride, null);
                noteDumpVertices(prepared, vertices, startVertex * stream.stride, stream.stride);
            }
        },

        /**
         * @param {RenderModel} model
         * @param {number} type
         * @param {number} startIndex
         * @param {number} primitiveCount
         */
        drawIndexedPrimitive(model, type, startIndex, primitiveCount){
            const stream = model.stream;
            const format = indexFormatOf(model.indices.format);
            if (!format)
            {
                skip('indexFormat');
                return;
            }
            const count = vertexCountOf(type, primitiveCount);
            const list = LIST_OF[type];
            const prepared = prepare(model, stream.stride,
                list === undefined ? TOPOLOGY[type] : list);
            if (!prepared)
            {
                return;
            }
            const byteOffset = startIndex * format.bytes;
            const streamBuffer = bufferFor(stream.buffer).gpu;
            const indexBuffer = bufferFor(model.indices).gpu;
            streamBuffer.markRead();
            indexBuffer.markRead();
            const vertices = { gpu: streamBuffer.gpu, offset: 0 };
            if (list === undefined)
            {
                record(model, prepared, {
                    vertices,
                    indices: {
                        gpu: indexBuffer.gpu,
                        offset: byteOffset,
                        format: format.gpu,
                    },
                    count,
                    first: 0,
                    baseVertex: model.baseVertexIndex,
                });
                if (dumpDraws && prepared.program)
                {
                    dumpProgram(model, prepared, count);
                }
                else if (dumpDraws)
                {
                    const bytes = readMemory(model.indices.base + byteOffset, count * format.bytes);
                    dumpIndexed(model, prepared, indicesFrom(bytes, format.bytes));
                    noteDumpIndices(bytes);
                }
                return;
            }
            // The strip's order is in guest memory, where the program left it.
            const order = indicesFrom(
                readMemory(model.indices.base + byteOffset, count * format.bytes), format.bytes);
            record(model, prepared, {
                vertices,
                ...expandedGeometry(type, order, model.baseVertexIndex),
            });
            if (dumpDraws && prepared.program)
            {
                dumpProgram(model, prepared, count);
            }
            else if (dumpDraws)
            {
                dumpIndexed(model, prepared, order);
            }
        },

        /**
         * @param {RenderModel} model
         * @param {number} type
         * @param {number} primitiveCount
         * @param {Uint8Array} vertexData
         * @param {number} stride
         */
        drawPrimitiveUp(model, type, primitiveCount, vertexData, stride){
            const count = vertexCountOf(type, primitiveCount);
            const list = LIST_OF[type];
            const topology = type === D3DPT.TRIANGLEFAN ? list : TOPOLOGY[type];
            const prepared = prepare(model, stride, topology);
            if (!prepared)
            {
                return;
            }
            const vertices = scratchVertices.write(vertexData.subarray(0, count * stride));
            const geometry = type === D3DPT.TRIANGLEFAN
                ? expandedGeometry(type, ascending(count), 0)
                : { indices: null, count, first: 0 };
            record(model, prepared, { vertices, ...geometry });
            if (dumpDraws && prepared.program)
            {
                dumpProgram(model, prepared, count);
            }
            else if (dumpDraws)
            {
                dumpDraw(model, prepared, vertexData.subarray(0, count * stride), stride, null);
                noteDumpVertices(prepared, vertexData.subarray(0, count * stride), 0, stride);
            }
        },

        /**
         * @param {RenderModel} model
         * @param {number} type
         * @param {number} numVertices
         * @param {number} primitiveCount
         * @param {Uint8Array} indexData
         * @param {number} indexFormat D3DFMT_INDEX
         * @param {Uint8Array} vertexData
         * @param {number} stride
         */
        drawIndexedPrimitiveUp(
            model, type, numVertices, primitiveCount, indexData, indexFormat, vertexData, stride,
        )
        {
            const format = indexFormatOf(indexFormat);
            if (!format)
            {
                skip('indexFormat');
                return;
            }
            const count = vertexCountOf(type, primitiveCount);
            const list = LIST_OF[type];
            const prepared = prepare(model, stride, list === undefined ? TOPOLOGY[type] : list);
            if (!prepared)
            {
                return;
            }
            const vertices = scratchVertices.write(vertexData.subarray(0, numVertices * stride));
            const indices = indicesFrom(indexData.subarray(0, count * format.bytes), format.bytes);
            record(model, prepared, {
                vertices,
                ...(list === undefined
                    ? {
                        indices: { ...scratchIndices.write(indices), format: format.gpu },
                        count,
                        first: 0,
                        baseVertex: 0,
                    }
                    : expandedGeometry(type, indices, 0)),
            });
            if (dumpDraws && prepared.program)
            {
                dumpProgram(model, prepared, count);
            }
            else if (dumpDraws)
            {
                dumpDraw(model, prepared, vertexData.subarray(0, numVertices * stride),
                    stride, indices);
                noteDumpVertices(prepared, vertexData.subarray(0, numVertices * stride), 0, stride);
            }
        },

        /**
         * Hands the recorded frame to the backend once its pipelines exist,
         * and presents the back buffer. Frames replay in the order they were
         * recorded, one at a time, because the backend allows one open frame.
         *
         * @param {RenderModel} model
         * @returns {Promise<void>} settled when this frame has been submitted
         */
        present(model){
            // Before the frame closes: a back buffer the program wrote by
            // hand owes its upload to this frame, not the next.
            const surface = surfaceFor(model.backBuffer);
            const recorded = ensureFrame();
            recording = null;
            // Before the replay chain, so a rename in the next frame's
            // recording retires this frame's backings against this present.
            backend.markPresent();
            // The dump travels with its frame: the GPU-side check is appended
            // at replay, which happens after another frame may have begun.
            recorded.dump = dump;
            lastDump = dump;
            dump = [];
            kept = 0;
            const shown = describe(model.backBuffer);
            const rect = model.viewport.rect;
            frameHistory.push({
                index: counters.frames,
                draws: frameStats.draws,
                placeholder: frameStats.placeholder,
                truncated: frameStats.truncated,
                uploads: frameStats.uploads,
                textures: frameStats.textures.size,
                // What decides a black or a frozen picture: a frame that only
                // cleared, or drew only into targets that are not the one
                // shown, or a viewport that was not the back buffer at all.
                clears: frameStats.clears,
                clearColor: frameStats.clearColor < 0
                    ? '' : `#${frameStats.clearColor.toString(16).padStart(8, '0')}`,
                offscreenDraws: frameStats.offscreenDraws,
                offscreenTargets: frameStats.offscreenTargets.size,
                viewport: `${rect.x},${rect.y} ${rect.width}x${rect.height}`,
                target: `${shown.Width}x${shown.Height}`,
                fogged: frameStats.fogged,
                fog: frameStats.fog,
                fogs: [...frameStats.fogs].map(([setting, draws])=>`${setting}x${draws}`)
                    .join(' '),
                // The lights as the frame ended, colour and position each. A
                // scene that brightens and darkens on its own is either lit
                // differently frame to frame or drawn differently, and this
                // is what separates the two.
                lights: enabledLights(model).map(light=>
                    `${round(light.Diffuse.r)},${round(light.Diffuse.g)},${round(light.Diffuse.b)}`
                    + `@${Math.round(light.Position.x)},${Math.round(light.Position.y)}`
                    + `,${Math.round(light.Position.z)}`).join(' '),
            });
            if (frameHistory.length > FRAME_HISTORY)
            {
                frameHistory.shift();
            }
            frameStats = blankFrameStats();
            counters.frames++;
            chain = chain.then(()=>replay(recorded, surface)).catch(failure);
            if (released.size > 0)
            {
                const bound = new Set(model.textures.values());
                for (const entry of released)
                {
                    if (!bound.has(entry.texture))
                    {
                        released.delete(entry);
                        if (entry.gpu)
                        {
                            retiring.push(entry.gpu);
                            entry.gpu = null;
                        }
                    }
                }
            }
            if (retiring.length > 0)
            {
                const gone = retiring.splice(0);
                chain = chain.then(()=>{
                    for (const made of gone)
                    {
                        backend.destroySurface?.(made);
                    }
                }).catch(failure);
            }
            return chain;
        },

        /** @returns {Promise<void>} settled when every presented frame has been submitted */
        idle: ()=>chain,

        /**
         * A surface the program can no longer reach: its GPU texture goes
         * now rather than when the collector finds the object. Only a
         * surface this renderer made a texture for on its own is affected;
         * a level of a texture is the texture's and goes with it.
         *
         * @param {any} surface a d3d8 surface
         */
        retire(surface){
            const made = surfaces.get(surface);
            if (made)
            {
                surfaces.delete(surface);
                dirtyTargets.delete(surface);
                // Not now, and not after the frames already queued either:
                // the frame being recorded may hold a pass against it -- a
                // program that resets its device on the WM_SIZE its first
                // frame brought has cleared its old target before the reset
                // -- so it goes after that frame's replay, at its present.
                retiring.push(made);
            }
        },

        diagnostics(){
            return {
                frames: counters.frames,
                draws: counters.draws,
                clears: counters.clears,
                programmable: counters.programmable,
                prepared: { ...counters.prepared },
                programs: programs.stats(),
                skipped: { ...counters.skipped },
                cascade: {
                    ...counters.cascade,
                    truncations: [...counters.cascade.truncations],
                },
                failures: [...counters.failures],
                lighting: {
                    ...counters.lighting,
                    ambients: [...counters.lighting.ambients],
                    types: [...counters.lighting.types],
                    lightValues: [...counters.lighting.lightValues],
                    materials: [...counters.lighting.materials],
                    worlds: [...counters.lighting.worlds],
                    fog: {
                        ...counters.lighting.fog,
                        modes: [...counters.lighting.fog.modes],
                        settings: [...counters.lighting.fog.settings],
                        depths: [...counters.lighting.fog.depths],
                        screenSpace: [...counters.lighting.fog.screenSpace],
                    },
                },
                recording: recording ? recording.commands.length : 0,
                // Frame by frame, so a picture that is wrong for one frame in
                // fifty can be found: a draw that sampled the placeholder, a
                // cascade cut short, a texture uploaded, how many textures
                // the frame drew with.
                recentFrames: frameHistory.slice(),
                // What the last frame was made of, for a test that wants to
                // evaluate the same draws on the processor.
                lastFrame,
                // Empty unless the build asked for it; see `dumpDraws`.
                lastDump,
                // What the program made, and where its pixels live. Addresses
                // rather than pixels: a reader that can read guest memory can
                // fetch the ones it wants, and every texture at once would be
                // tens of megabytes through a diagnostics call.
                textureRecords: [...roster].map(entry=>({
                    id: entry.id,
                    base: entry.base,
                    width: entry.width,
                    height: entry.height,
                    format: entry.format,
                    bytesPerPixel: FORMAT_INFO[entry.format]
                        ? FORMAT_INFO[entry.format].bytesPerPixel
                        : 0,
                    uploads: entry.uploads || 0,
                    dirty: !!entry.dirty,
                    resident: !!entry.gpu,
                    levels: entry.levels,
                    written: [...(entry.written ?? [])].sort((left, right)=>left - right),
                    tails: entry.tails ?? {},
                })),
                textures: [...uploaded.values()],
            };
        },
    };

    /**
     * @param {any} recorded
     * @param {any} surface what to present, or null for a flush
     * @param {any} [snapshot] a backend surface to read back after the replay
     * @returns {Promise<any>} the snapshot's pixels, when one was asked for
     */
    async function replay(recorded, surface, snapshot = null){
        const pipelines = await Promise.allSettled(recorded.pipelines);
        const frame = backend.beginFrame();
        /** @type {any[]} */
        const checks = [];
        /** @type {(() => Promise<Uint8Array[]>) | null} */
        let read = null;
        /** @type {(() => Promise<any>) | null} */
        let shot = null;
        try
        {
            replayInto(frame, pipelines, recorded, surface);
            if (snapshot)
            {
                shot = frame.snapshot(snapshot);
            }
            // After the draws, so the copies see the buffers as the draws did:
            // a flush at the end of the frame lands before the whole command
            // buffer, draws and copies alike.
            for (const command of recorded.commands)
            {
                if (command.check)
                {
                    checks.push(command.check);
                }
            }
            if (checks.length > 0)
            {
                read = frame.copyOut(checks.flatMap(check=>[
                    {
                        buffer: check.vertices.gpu,
                        offset: check.vertices.offset + check.offset,
                        size: check.bytes.byteLength,
                    },
                    {
                        buffer: check.block.buffer,
                        offset: check.block.offset + (check.block.dynamicOffset ?? 0),
                        size: check.uniforms.byteLength,
                    },
                    ...(check.indices
                        ? [{
                            buffer: check.indices.buffer.gpu,
                            offset: check.indices.buffer.offset,
                            size: check.indices.bytes.byteLength,
                        }]
                        : []),
                ]));
            }
        }
        finally
        {
            if (recorded.arena)
            {
                arenas.push(recorded.arena);
            }
            // Ended whatever happened. One object owns the command encoder and
            // one call releases it, so a throw anywhere above -- a command
            // whose buffer never reached the GPU, a depth attachment for a
            // surface that has gone, a bind group the layout refuses -- would
            // otherwise leave the frame open forever. Every later present then
            // fails at `beginFrame` saying a frame is already open, and each
            // failure is swallowed into a ring nobody reads. One bad frame
            // becomes every frame after it, and the only symptom is a picture
            // that stopped changing while the counters keep climbing.
            frame.end();
        }
        lastFrame = recorded.commands;
        const pixels = shot ? await shot() : undefined;
        if (read)
        {
            const held = await read();
            let next = 0;
            for (const check of checks)
            {
                recorded.dump[check.dump] += ` ${check.bound}`
                    + ` ${describeCheck(check, held[next++])}`
                    + ` ${describeBytes('ugpu', check.uniforms, held[next++])}`
                    + (check.indices
                        ? ` ${describeBytes('igpu', check.indices.bytes, held[next++])}`
                        : '')
                    + (check.before
                        ? ` ${describeSnapshot(await check.before()).replace('after=', 'before=')}`
                        : '')
                    + (check.snapshot ? ` ${describeSnapshot(await check.snapshot())}` : '')
                    + (check.sampledShot
                        ? ` tex${describeSnapshot(await check.sampledShot())
                            .replace('after=', '=')}`
                        : '')
                    + (check.again
                        ? ` again${describeSnapshot(await check.again()).replace('after=', '=')}`
                        : '')
                    + (check.copy
                        ? ` copy${describeSnapshot(await check.copy()).replace('after=', '=')}`
                        : '')
                    + (check.host
                        ? ` host${describeSnapshot(await check.host()).replace('after=', '=')}`
                        : '')
                    + (check.quadShot
                        ? ` quad${describeSnapshot(await check.quadShot()).replace('after=', '=')}`
                        : '')
                    + (await Promise.all(
                        ['hostidx', 'hostuni', 'newpipe', 'newview', 'newsampler', 'newshader',
                            'mirrorsampler', 'clampsampler', 'smallview']
                            .map(async name=>check[name]
                                ? ` ${name}${describeSnapshot(await check[name]())
                                    .replace('after=', '=')}`
                                : ''))).join('');
            }
        }
        return pixels;
    }

    /**
     * One draw through shaders: its constants into the two stages' groups,
     * its textures into the third, then the geometry.
     *
     * @param {any} pass @param {any} pipeline @param {any} command
     */
    function replayProgram(pass, pipeline, command){
        const program = command.program;
        pass.setPipeline(pipeline.gpu);
        pass.setBindings(0, pipeline.bindGroupLayouts[0], program.vertexBlocks.map(
            (/** @type {Float32Array} */ block, /** @type {number} */ binding)=>(
                { binding, resource: pass.uniforms(block) })));
        pass.setBindings(1, pipeline.bindGroupLayouts[1], program.pixelBlocks.map(
            (/** @type {Float32Array} */ block, /** @type {number} */ binding)=>(
                { binding, resource: pass.uniforms(block) })));
        /** @type {any[]} */
        const sampled = [];
        program.samplerBindings.forEach((/** @type {any} */ bound, /** @type {number} */ index)=>{
            sampled.push({ binding: index * 2, resource: bound.view },
                { binding: index * 2 + 1, resource: bound.sampler });
        });
        pass.setBindings(2, pipeline.bindGroupLayouts[2], sampled);
        pass.setVertexBuffer(0, command.vertices.gpu, command.vertices.offset);
        if (command.indices)
        {
            pass.setIndexBuffer(command.indices.gpu, command.indices.format,
                command.indices.offset);
            pass.drawIndexed(command.count, 1, command.first, command.baseVertex);
        }
        else
        {
            pass.draw(command.count, 1, command.first);
        }
        counters.draws++;
        counters.programmable++;
    }

    /**
     * @param {any} frame @param {any[]} pipelines
     * @param {any} recorded @param {any} surface
     */
    function replayInto(frame, pipelines, recorded, surface){
        /** @type {any} */
        let pass = null;
        /** @type {any} */
        let opened = null;
        /** @type {any} */
        let viewport = null;
        /** @type {any} */
        let scissor = null;
        // An upload or a copy closes the pass it lands in; the pass is
        // reopened, loading what is there, before the next command that
        // needs one.
        const reopen = ()=>{
            if (pass || !opened)
            {
                return;
            }
            pass = frame.beginPass({
                target: opened.target,
                clear: false,
                depthStencilAttachment: opened.depth
                    ? depthAttachment({ depth: opened.depth })
                    : undefined,
            });
            if (viewport)
            {
                pass.setViewport(viewport);
            }
            if (scissor)
            {
                pass.setScissor(scissor);
            }
        };
        for (const command of recorded.commands)
        {
            if (command.kind === 'pass')
            {
                opened = command;
                pass = frame.beginPass({
                    target: command.target,
                    clear: command.clearColor !== undefined,
                    clearValue: command.clearColor,
                    depthStencilAttachment: command.depth
                        ? depthAttachment(command)
                        : undefined,
                });
                continue;
            }
            if (command.kind === 'upload')
            {
                backend.uploadTexture({
                    texture: command.surface.texture,
                    format: command.format,
                    mipLevel: command.mipLevel,
                    width: command.width,
                    height: command.height,
                    data: command.texels,
                    staging: true,
                });
                pass = null;
                continue;
            }
            if (command.kind === 'copy')
            {
                frame.copyTexture(
                    { texture: command.source.texture, mipLevel: command.source.mipLevel ?? 0,
                        origin: command.sourceOrigin },
                    { texture: command.destination.texture,
                        mipLevel: command.destination.mipLevel ?? 0,
                        origin: command.destinationOrigin },
                    { width: command.width, height: command.height, depthOrArrayLayers: 1 });
                pass = null;
                continue;
            }
            reopen();
            if (command.kind === 'viewport')
            {
                viewport = command.rect;
                pass.setViewport(command.rect);
                continue;
            }
            if (command.kind === 'scissor')
            {
                scissor = command.rect;
                pass.setScissor(command.rect);
                continue;
            }
            const outcome = pipelines[command.pipeline];
            if (outcome.status === 'rejected')
            {
                failure(outcome.reason);
                continue;
            }
            const pipeline = outcome.value;
            if (command.program)
            {
                replayProgram(pass, pipeline, command);
                continue;
            }
            if (command.check?.probe && opened)
            {
                // What the target held before this draw: a draw that seems to
                // paint what was already there painted nothing.
                command.check.before = frame.snapshot(opened.target);
                pass = frame.beginPass({
                    target: opened.target,
                    clear: false,
                    depthStencilAttachment: opened.depth
                        ? depthAttachment({ depth: opened.depth })
                        : undefined,
                });
                if (viewport)
                {
                    pass.setViewport(viewport);
                }
                if (scissor)
                {
                    pass.setScissor(scissor);
                }
            }
            pass.setPipeline(pipeline.gpu);
            const block = pass.uniforms(command.uniforms);
            if (command.check)
            {
                command.check.block = block;
                // The objects this draw actually binds, by identity: two draws
                // recorded alike that bind different objects were served by a
                // cache, and only the identities say which one lied.
                command.check.bound = `pipe${resourceId(pipeline.gpu)}`
                    + ` vb${resourceId(command.vertices.gpu)}@${command.vertices.offset}`
                    + `(${command.vertices.gpu.label ?? '?'},${command.vertices.gpu.size ?? '?'})`
                    + (command.indices
                        ? ` ib${resourceId(command.indices.gpu)}@${command.indices.offset}`
                            + `(${command.indices.gpu.label ?? '?'},`
                            + `${command.indices.gpu.size ?? '?'})`
                        : '')
                    + command.stageBindings.map((/** @type {any} */ stage)=>
                        ` tv${resourceId(stage.view)}/sm${resourceId(stage.sampler)}`).join('');
            }
            const entries = [{ binding: 0, resource: block }];
            command.stageBindings.forEach((/** @type {any} */ stage, /** @type {number} */ index)=>{
                entries.push(
                    { binding: 1 + index * 2, resource: stage.view },
                    { binding: 2 + index * 2, resource: stage.sampler });
            });
            pass.setBindings(0, pipeline.bindGroupLayout, entries);
            pass.setVertexBuffer(0, command.vertices.gpu, command.vertices.offset);
            if (command.indices)
            {
                pass.setIndexBuffer(command.indices.gpu, command.indices.format,
                    command.indices.offset);
                pass.drawIndexed(command.count, 1, command.first, command.baseVertex);
            }
            else
            {
                pass.draw(command.count, 1, command.first);
            }
            counters.draws++;
            if (command.check?.probe && opened)
            {
                // The target as this draw left it. The copy closes the pass,
                // so one that keeps what is there is opened for the rest.
                command.check.snapshot = frame.snapshot(opened.target);
                if (command.check.sampled && !String(command.check.sampled.format).startsWith('bc'))
                {
                    command.check.sampledShot = frame.snapshot(command.check.sampled);
                }
                const scratch = probeScratchFor(opened.target, opened.depth);
                pass = probePass(frame, scratch);
                if (viewport)
                {
                    pass.setViewport(viewport);
                }
                if (scissor)
                {
                    pass.setScissor(scissor);
                }
                pass.setPipeline(pipeline.gpu);
                pass.setBindings(0, pipeline.bindGroupLayout, entries);
                pass.setVertexBuffer(0, command.vertices.gpu, command.vertices.offset);
                if (command.indices)
                {
                    pass.setIndexBuffer(command.indices.gpu, command.indices.format,
                        command.indices.offset);
                    pass.drawIndexed(command.count, 1, command.first, command.baseVertex);
                }
                else
                {
                    pass.draw(command.count, 1, command.first);
                }
                command.check.again = frame.snapshot(scratch.target);
                // The same vertices, twice more: from a fresh buffer the region
                // was copied into on the device, and from one the program's own
                // bytes were written into.
                const check = command.check;
                const length = check.bytes.byteLength;
                const copied = backend.createDynamicBuffer({
                    size: length,
                    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
                    label: 'probe-copy',
                });
                const written = backend.createDynamicBuffer({
                    size: length,
                    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
                    label: 'probe-host',
                });
                const lock = written.lock(0, length, LockFlags.NOOVERWRITE);
                lock.data.set(check.bytes);
                written.unlock(lock);
                frame.copyBuffer(command.vertices.gpu, command.vertices.offset + check.offset,
                    copied.gpu, 0, length);
                const hostIndices = check.indices
                    ? backend.createDynamicBuffer({
                        size: check.indices.bytes.byteLength,
                        usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
                        label: 'probe-indices',
                    })
                    : null;
                if (hostIndices)
                {
                    const held = hostIndices.lock(0, check.indices.bytes.byteLength,
                        LockFlags.NOOVERWRITE);
                    held.data.set(check.indices.bytes);
                    hostIndices.unlock(held);
                }
                const hostBlock = backend.createDynamicBuffer({
                    size: Math.ceil(check.uniforms.byteLength / 256) * 256,
                    usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
                    label: 'probe-block',
                });
                {
                    const held = hostBlock.lock(0, check.uniforms.byteLength,
                        LockFlags.NOOVERWRITE);
                    held.data.set(check.uniforms);
                    hostBlock.unlock(held);
                }
                const alternate = check.alternate >= 0
                    && pipelines[check.alternate]?.status === 'fulfilled'
                    ? pipelines[check.alternate].value
                    : null;
                const stage0 = command.stageBindings[0];
                const freshView = check.sampled
                    ? check.sampled.texture.createView({ label: 'probe-view' })
                    : null;
                const freshSampler = createSampler && stage0?.sampler?.probeDescriptor
                    ? createSampler({ ...stage0.sampler.probeDescriptor, label: 'probe-sampler' })
                    : null;
                /** @type {[string, Record<string, any>][]} */
                const variants = [
                    ['copy', { vertices: copied.gpu }],
                    ['host', { vertices: written.gpu }],
                    ['hostidx', { indices: hostIndices }],
                    ['hostuni', { block:
                        {
                            buffer: hostBlock.gpu,
                            offset: 0,
                            size: check.uniforms.byteLength,
                            dynamicOffset: 0,
                        } }],
                    ['newpipe', { pipeline: alternate }],
                    ['newview', { view: freshView }],
                    ['newsampler', { sampler: freshSampler }],
                    // A control: the same texture through a view of its smallest
                    // level. A draw that still shows the top level is not drawing
                    // with these entries at all.
                    ['smallview', {
                        view: check.sampled && (check.sampled.mipLevelCount ?? 1) > 1
                            ? check.sampled.texture.createView({
                                label: 'probe-small',
                                baseMipLevel: check.sampled.mipLevelCount - 1,
                                mipLevelCount: 1,
                            })
                            : null,
                    }],
                    // Two samplers that must change the picture if the binding
                    // is honoured at all: one mirrors, one clamps and points.
                    ['mirrorsampler', {
                        sampler: createSampler && stage0?.sampler?.probeDescriptor
                            ? createSampler({
                                ...stage0.sampler.probeDescriptor,
                                addressModeU: 'mirror-repeat',
                                addressModeV: 'mirror-repeat',
                                label: 'probe-mirror',
                            })
                            : null,
                    }],
                    ['clampsampler', {
                        sampler: createSampler && stage0?.sampler?.probeDescriptor
                            ? createSampler({
                                ...stage0.sampler.probeDescriptor,
                                magFilter: 'nearest',
                                minFilter: 'nearest',
                                addressModeU: 'clamp-to-edge',
                                addressModeV: 'clamp-to-edge',
                                lodMaxClamp: 0,
                                label: 'probe-clamp',
                            })
                            : null,
                    }],
                    ['newshader', {
                        pipeline: check.alternateShader >= 0
                            && pipelines[check.alternateShader]?.status === 'fulfilled'
                            ? pipelines[check.alternateShader].value
                            : null,
                    }],
                ];
                for (const [name, variant] of variants)
                {
                    if (Object.values(variant).some(value=>!value))
                    {
                        continue;
                    }
                    const drawPipeline = variant.pipeline ?? pipeline;
                    const drawEntries = entries.map((/** @type {any} */ entry)=>{
                        if (entry.binding === 0 && variant.block)
                        {
                            return { binding: 0, resource: variant.block };
                        }
                        if (entry.binding === 1 && variant.view)
                        {
                            return { binding: 1, resource: variant.view };
                        }
                        if (entry.binding === 2 && variant.sampler)
                        {
                            return { binding: 2, resource: variant.sampler };
                        }
                        return entry;
                    });
                    pass = probePass(frame, scratch);
                    if (viewport)
                    {
                        pass.setViewport(viewport);
                    }
                    pass.setPipeline(drawPipeline.gpu);
                    pass.setBindings(0, drawPipeline.bindGroupLayout, drawEntries);
                    pass.setVertexBuffer(0, variant.vertices ?? command.vertices.gpu,
                        variant.vertices ? 0 : command.vertices.offset);
                    if (command.indices)
                    {
                        if (variant.indices)
                        {
                            pass.setIndexBuffer(variant.indices.gpu, command.indices.format, 0);
                        }
                        else
                        {
                            pass.setIndexBuffer(command.indices.gpu, command.indices.format,
                                command.indices.offset);
                        }
                        pass.drawIndexed(command.count, 1, command.first,
                            variant.vertices ? 0 : command.baseVertex);
                    }
                    else
                    {
                        pass.draw(command.count, 1, command.first);
                    }
                    check[name] = frame.snapshot(scratch.target);
                }
                const quadPipeline = check.quad >= 0
                    && pipelines[check.quad]?.status === 'fulfilled'
                    ? pipelines[check.quad].value
                    : null;
                if (quadPipeline)
                {
                    const width = opened.target.width;
                    const height = Math.round(opened.target.height * 0.625);
                    const quad = new DataView(new ArrayBuffer(28 * 6));
                    [[0, 0, 0, 0], [width, 0, 1, 0], [0, height, 0, 1],
                        [0, height, 0, 1], [width, 0, 1, 0], [width, height, 1, 1]]
                        .forEach(([x, y, u, v], index)=>{
                            const at = index * 28;
                            quad.setFloat32(at, x, true);
                            quad.setFloat32(at + 4, y, true);
                            quad.setFloat32(at + 8, 0.5, true);
                            quad.setFloat32(at + 12, 1, true);
                            quad.setUint32(at + 16, 0xffffffff, true);
                            quad.setFloat32(at + 20, u, true);
                            quad.setFloat32(at + 24, v, true);
                        });
                    const quadBuffer = backend.createDynamicBuffer({
                        size: quad.byteLength,
                        usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
                        label: 'probe-quad',
                    });
                    const held = quadBuffer.lock(0, quad.byteLength, LockFlags.NOOVERWRITE);
                    held.data.set(new Uint8Array(quad.buffer));
                    quadBuffer.unlock(held);
                    pass = probePass(frame, scratch);
                    if (viewport)
                    {
                        pass.setViewport(viewport);
                    }
                    pass.setPipeline(quadPipeline.gpu);
                    pass.setBindings(0, quadPipeline.bindGroupLayout, entries.map(
                        (/** @type {any} */ entry)=>entry.binding === 0
                            ? { binding: 0, resource:
                                {
                                    buffer: hostBlock.gpu,
                                    offset: 0,
                                    size: check.uniforms.byteLength,
                                    dynamicOffset: 0,
                                } }
                            : entry));
                    pass.setVertexBuffer(0, quadBuffer.gpu, 0);
                    pass.draw(6, 1, 0);
                    check.quadShot = frame.snapshot(scratch.target);
                }
                pass = frame.beginPass({
                    target: opened.target,
                    clear: false,
                    depthStencilAttachment: opened.depth
                        ? depthAttachment({ depth: opened.depth })
                        : undefined,
                });
                if (viewport)
                {
                    pass.setViewport(viewport);
                }
                if (scissor)
                {
                    pass.setScissor(scissor);
                }
            }
        }
        if (surface)
        {
            frame.present(surface);
        }
    }


    /** @param {any} command a pass command with a depth target */
    function depthAttachment(command){
        const attachment = {
            view: command.depth.view,
            depthLoadOp: command.clearDepth === undefined ? 'load' : 'clear',
            depthStoreOp: 'store',
            depthClearValue: command.clearDepth === undefined ? 1 : command.clearDepth,
        };
        if (!hasStencil(command.depth.format))
        {
            return attachment;
        }
        return {
            ...attachment,
            stencilLoadOp: command.clearStencil === undefined ? 'load' : 'clear',
            stencilStoreOp: 'store',
            stencilClearValue: command.clearStencil === undefined ? 0 : command.clearStencil,
        };
    }
}
