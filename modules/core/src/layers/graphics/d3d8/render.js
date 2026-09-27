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
    COLORWRITEENABLE_ALPHA, COORD_SET_MASK, D3DBLEND, D3DCLEAR, D3DCMP, D3DCULL, D3DFILL, D3DFMT,
    D3DFMT_INDEX, D3DFOG, D3DLOCK, D3DPOOL, D3DPT, D3DRS, D3DSHADE, D3DTA, D3DTADDRESS, D3DTEXF,
    D3DTOP, D3DTS, D3DTSS, D3DUSAGE, D3DZB, D3D_OK, FORMAT_INFO, argumentsRead, dwordToFloat,
    isCompressed, surfaceBytes,
} from './constants.js';
import { FVF, POSITION_MASK, decodeFvf } from '../webgpu/internal/vertexformat.js';
import { D3DLOCK_NO_DIRTY_UPDATE, levelExtent } from '../d3d9/resources.js';
import { D3DRS as D3DRS9 } from '../d3d9/constants.js';
import { resourceId } from '../webgpu/internal/bindings.js';
import {
    constantBlocks, createProgramCache, samplerDimension, shapeKey, vertexLayoutOf,
} from '../webgpu/internal/programmable.js';
import {
    HYBRID_CONSTANTS, fixedVertexStage, translateShader, varyingLocation,
} from '../d3d9/wgsl.js';
import { D3DDECLUSAGE } from '../d3d9/declaration.js';
import { decodeS3tc } from '../webgpu/internal/s3tc.js';
import {
    fixedFragmentStage, generates, generationOf, readsNormal,
} from '../webgpu/internal/fixedfunction.js';
import { FOG_SOURCE, fogSourceOf, pipelineKey } from '../webgpu/internal/pipeline.js';

/**
 * Direct3D 7's D3DRENDERSTATE_COLORKEYENABLE. Its number is free in Direct3D
 * 8 and 9, which never set it, so only a Direct3D 7 device keys a draw.
 */
const D3DRENDERSTATE_COLORKEYENABLE = 41;

/**
 * The buffer a stream with nothing bound reads from: WebGPU's default
 * largest stride, so any member read at a stride of zero lies inside it.
 */
const ZERO_STREAM_BYTES = 2048;

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

/**
 * The stages a 1.x pixel shader samples: four below 1.4, six in it.
 */
const LEGACY_STAGES = 6;

/**
 * The component D3DTTFF_PROJECTED divides a coordinate set by, for each
 * D3DTTFF_COUNTn: the last of the count, or w with no count; one coordinate
 * has nothing to divide by.
 *
 * @type {Readonly<Record<number, string>>}
 */
const PROJECTED_BY = Object.freeze({ 0: 'w', 2: 'y', 3: 'z', 4: 'w' });

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
 * Each triangle also starts at the vertex Direct3D takes a flat-shaded
 * triangle's colours from, since the list's first vertex is the one flat
 * interpolation reads: a strip triangle's first, and a fan triangle's first
 * after the hub (EXT_provoking_vertex, issue 7, records the latter as
 * DirectX 9's). Rotating a triangle's vertices keeps its winding.
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
                    out.push(indices[index], indices[index + 2], indices[index + 1]);
                }
            }
            break;
        case D3DPT.TRIANGLEFAN:
            for (let index = 1; index + 1 < count; index++)
            {
                out.push(indices[index], indices[index + 1], indices[0]);
            }
            break;
        default:
            throw new Error(`Primitive type ${type} is already a list`);
    }
    const wide = out.some(value=>value > 0xffff);
    return wide ? Uint32Array.from(out) : Uint16Array.from(out);
}

/**
 * Triangles under D3DRS_FILLMODE WIREFRAME or POINT, rewritten as the lines
 * or points they draw: each triangle's three edges, or its three vertices.
 * WebGPU has no fill mode, so the topology is what carries it.
 *
 * @param {number} type  D3DPT, a triangle type
 * @param {ArrayLike<number>} indices  The vertex indices in the type's order.
 * @param {number} fill  D3DFILL, WIREFRAME or POINT
 * @returns {Uint16Array | Uint32Array}
 */
export function filledIndices(type, indices, fill){
    const triangles = type === D3DPT.TRIANGLELIST ? indices : listIndices(type, indices);
    const whole = triangles.length - triangles.length % 3;
    /** @type {number[]} */
    const out = [];
    for (let at = 0; at < whole; at += 3)
    {
        const [a, b, c] = [triangles[at], triangles[at + 1], triangles[at + 2]];
        if (fill === D3DFILL.WIREFRAME)
        {
            out.push(a, b, b, c, c, a);
        }
        else
        {
            out.push(a, b, c);
        }
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
    // The inverse transpose of the world matrix, which a lit normal goes
    // through; identity unless the draw is lit.
    normalMatrix: 220,
    // The inverse transpose of world then view, which a normal a coordinate
    // is generated from goes through; identity unless a stage takes one.
    cameraNormalMatrix: 236,
    lights: 252,
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
 * Whether two lights hold the same values, field for field: a zero's sign and
 * not-a-number compared as `Object.is` compares them, so a light set again
 * with what it holds is told apart from one that reads back differently.
 *
 * @param {Light} a @param {Light} b
 */
export function sameLight(a, b){
    return a.Type === b.Type && sameColour(a.Diffuse, b.Diffuse)
        && sameColour(a.Specular, b.Specular) && sameColour(a.Ambient, b.Ambient)
        && sameNumber(a.Position.x, b.Position.x) && sameNumber(a.Position.y, b.Position.y)
        && sameNumber(a.Position.z, b.Position.z) && sameNumber(a.Direction.x, b.Direction.x)
        && sameNumber(a.Direction.y, b.Direction.y) && sameNumber(a.Direction.z, b.Direction.z)
        && sameNumber(a.Range, b.Range) && sameNumber(a.Falloff, b.Falloff)
        && sameNumber(a.Attenuation0, b.Attenuation0) && sameNumber(a.Attenuation1, b.Attenuation1)
        && sameNumber(a.Attenuation2, b.Attenuation2) && sameNumber(a.Theta, b.Theta)
        && sameNumber(a.Phi, b.Phi);
}

/** @param {ColourValue} a @param {ColourValue} b */
const sameColour = (a, b)=>sameNumber(a.r, b.r) && sameNumber(a.g, b.g) && sameNumber(a.b, b.b)
    && sameNumber(a.a, b.a);

/** `Object.is`, which would box each double handed to it. @param {number} a @param {number} b */
const sameNumber = (a, b)=>(a === b ? a !== 0 || 1 / a === 1 / b
    : Number.isNaN(a) && Number.isNaN(b));

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
 * @property {boolean} [affineProjection]
 *     Whether the projection's fourth column is (0, 0, 0, 1), which makes
 *     table fog take the pixel's z rather than its w.
 * @property {number[]} [stages]     Packed sampler state per stage; see `samplerFlagsOf`.
 * @property {(readonly number[])[]} [textureTransforms]
 *     Per stage, the sixteen elements in `PLANAR_ROWS` order; identity when absent.
 * @property {ArrayLike<number>} [worldView]  Identity unless a stage generates coordinates.
 * @property {ArrayLike<number>} [normalMatrix]  See `normalMatrixOf`; identity unless lit.
 * @property {ArrayLike<number>} [cameraNormalMatrix]
 *     `normalMatrixOf` world then view; identity unless a stage generates from the normal.
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
    // Start, end and density, which is everything the three fog curves need,
    // and which depth table fog runs over; which curve is in force shaped the
    // shader and is not carried here.
    const fog = values.fogFactors ?? [0, 1, 1];
    put4(block, at.fogFactors, fog[0], fog[1], fog[2], values.affineProjection ? 1 : 0);
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
    block.set(values.normalMatrix ?? IDENTITY, at.normalMatrix);
    block.set(values.cameraNormalMatrix ?? IDENTITY, at.cameraNormalMatrix);
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
 * What a normal is carried into world space by: the inverse transpose of the
 * world matrix, laid out as a matrix is, so a normal times it is the normal
 * the surface has after the world matrix moved it. The whole 4x4 is
 * inverted, not its upper 3x3 -- the two differ only under a non-affine
 * world, where Direct3D lights by the former (Wine's d3d9 lighting_test has
 * such a world leave a lit quad black). A matrix with no inverse gives its
 * adjugate transpose: the cofactors, which the inverse is a scaling of, and a
 * normal's direction is what lighting reads.
 *
 * @param {ArrayLike<number>} m  row-major, as D3DMATRIX
 * @param {Float32Array} [out]
 * @returns {Float32Array}
 */
export function normalMatrixOf(m, out = new Float32Array(16)){
    for (let row = 0; row < 4; row++)
    {
        for (let column = 0; column < 4; column++)
        {
            // Negative zero is the same matrix and a worse one to read.
            out[row * 4 + column] = ((row + column) % 2 === 0 ? 1 : -1) * minorOf(m, row, column)
                || 0;
        }
    }
    const determinant = m[0] * out[0] + m[1] * out[1] + m[2] * out[2] + m[3] * out[3];
    if (determinant !== 0)
    {
        for (let at = 0; at < 16; at++)
        {
            out[at] /= determinant;
        }
    }
    return out;
}

/**
 * For each of the sixteen cells, the nine others outside its row and column,
 * row by row: the 3x3 whose determinant is that cell's minor.
 */
const MINOR_CELLS = (()=>{
    const cells = new Uint8Array(16 * 9);
    let at = 0;
    for (let row = 0; row < 4; row++)
    {
        for (let column = 0; column < 4; column++)
        {
            for (let r = 0; r < 4; r++)
            {
                for (let c = 0; c < 4; c++)
                {
                    if (r !== row && c !== column)
                    {
                        cells[at++] = r * 4 + c;
                    }
                }
            }
        }
    }
    return cells;
})();

/**
 * The determinant of the 3x3 left when a row and a column are struck out,
 * expanded along its first row -- read through a table rather than gathered
 * into an array, which a draw would otherwise make sixteen of.
 *
 * @param {ArrayLike<number>} m @param {number} row @param {number} column
 */
function minorOf(m, row, column){
    const at = (row * 4 + column) * 9;
    const cells = MINOR_CELLS;
    const a = m[cells[at]], b = m[cells[at + 1]], c = m[cells[at + 2]];
    const d = m[cells[at + 3]], e = m[cells[at + 4]], f = m[cells[at + 5]];
    const g = m[cells[at + 6]], h = m[cells[at + 7]], i = m[cells[at + 8]];
    return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
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
 * @property {{ buffer: any, stride: number, offset?: number }} stream       Stream zero.
 * @property {(index: number) => { buffer: any, stride: number, offset?: number }} [streamAt]
 * @property {Map<number, number>} [streamFrequencies]
 *           D3DSTREAMSOURCE frequencies by stream, Direct3D 9's; none steps by instance.
 *     Any stream by its number, where the API has more than one: a
 *     declaration may read members from streams past zero.
 * @property {{ left: number, top: number, right: number, bottom: number }} [scissor]
 *     The scissor rectangle, where the API has one; D3DRS_SCISSORTESTENABLE
 *     says whether draws are cut to it.
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
    listedCount = 0;
    model.lights.forEach(listEnabled);
    /** @type {Light[]} */
    const lights = new Array(listedCount);
    // By index, in place: a handful of lights, listed again only when one changed.
    for (let count = 0; count < listedCount; count++)
    {
        const index = listedIndices[count];
        let at = count;
        while (at > 0 && listedIndices[at - 1] > index)
        {
            listedIndices[at] = listedIndices[at - 1];
            lights[at] = lights[at - 1];
            at--;
        }
        listedIndices[at] = index;
        lights[at] = /** @type {Light} */ (listedLights[count]);
    }
    listedLights.fill(null, 0, listedCount);
    if (model.lightsVersion !== undefined)
    {
        if (kept)
        {
            kept.version = model.lightsVersion;
            kept.lights = lights;
        }
        else
        {
            enabledLightsKept.set(model, { version: model.lightsVersion, lights });
        }
    }
    return lights;
}

/**
 * The enabled lights of the map `enabledLights` is walking, and their indices:
 * the first `listedCount` of each, kept from call to call rather than emptied,
 * which would give their storage back only to take it again.
 */
/** @type {number[]} */
const listedIndices = [];
/** @type {(Light | null)[]} */
const listedLights = [];
let listedCount = 0;

/** @param {{ light: Light, enabled: boolean }} record @param {number} index */
function listEnabled(record, index){
    if (record.enabled)
    {
        listedIndices[listedCount] = index;
        listedLights[listedCount] = record.light;
        listedCount++;
    }
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
    const projection = transformOf(model, D3DTS.PROJECTION);
    return uniformBlock({
        worldViewProjection: multiplyMatrices(worldView, projection, WORLD_VIEW_PROJECTION),
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
        affineProjection: isAffine(projection),
        alphaRef: rs('ALPHAREF'),
        stages: stageFlags(model, mips),
        textureTransforms: stageTransforms(model),
        material: model.material,
        ambient: rs('AMBIENT'),
        eye: eyePosition(view),
        ...(lighting ? { normalMatrix: normalMatrixOf(world, NORMAL_MATRIX) } : {}),
        ...(generatesFromNormal(model)
            ? { cameraNormalMatrix: normalMatrixOf(worldView, CAMERA_NORMAL_MATRIX) }
            : {}),
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

/**
 * The level of detail a managed texture was set to: the most detailed level a
 * sample reaches, alongside the stage's own MAXMIPLEVEL, whichever is less
 * detailed (Wine's d3d9 maxmip_test).
 *
 * @param {any} texture
 * @returns {number}
 */
const lodOf = texture=>texture?.GetLOD?.() ?? 0;

/** @param {RenderModel} model @param {boolean} mips */
const stageFlags = (model, mips)=>{
    const flags = [];
    for (let index = 0; index < SAMPLED_STAGES; index++)
    {
        flags.push(samplerFlagsOf(model.stageStates(index), mips,
            lodOf(model.textures.get(index))));
    }
    return flags;
};

/** Scratch for the two products every draw forms; copied into the block at once. */
const WORLD_VIEW = new Float32Array(16);
const WORLD_VIEW_PROJECTION = new Float32Array(16);
/** Scratch for a lit draw's normal matrix, likewise. */
const NORMAL_MATRIX = new Float32Array(16);
/** Scratch for the camera-space one of a draw generating from the normal. */
const CAMERA_NORMAL_MATRIX = new Float32Array(16);

/**
 * Whether two matrices hold the same bits: equal elements, zeros of the same
 * sign, and no not-a-number (which is never taken to be the same).
 *
 * @param {ArrayLike<number>} a @param {ArrayLike<number>} b
 */
function sameBits(a, b){
    for (let at = 0; at < 16; at++)
    {
        const x = a[at];
        if (x !== b[at] || (x === 0 && 1 / x !== 1 / b[at]))
        {
            return false;
        }
    }
    return true;
}

/**
 * Writes a value where it differs from what is there, zeros of either sign
 * and not-a-number told apart as `Object.is` tells them (which, called here,
 * would box each double it is handed).
 *
 * @param {Float64Array} values @param {number} at @param {number} value
 * @returns {number} 1 when it differed
 */
function keepValue(values, at, value){
    const held = values[at];
    if (held === value ? held !== 0 || 1 / held === 1 / value
        : Number.isNaN(held) && Number.isNaN(value))
    {
        return 0;
    }
    values[at] = value;
    return 1;
}

/**
 * A colour's four channels by `keepValue`, and whether there is one at all.
 *
 * @param {Float64Array} values @param {number} at @param {ColourValue | undefined} colour
 * @returns {number}
 */
function keepColour(values, at, colour){
    if (!colour)
    {
        // No colour is sampled as '-', which no four numbers are.
        return keepValue(values, at + 4, 0) | keepValue(values, at, NaN) | 1;
    }
    return keepValue(values, at + 4, 1) | keepValue(values, at, colour.r)
        | keepValue(values, at + 1, colour.g) | keepValue(values, at + 2, colour.b)
        | keepValue(values, at + 3, colour.a);
}

/**
 * Whether a stage of a cascade generates its coordinates from the normal.
 *
 * @param {readonly { texCoordIndex: number }[]} stages
 */
function readsNormalAnywhere(stages){
    for (let index = 0; index < stages.length; index++)
    {
        if (readsNormal(stages[index].texCoordIndex))
        {
            return true;
        }
    }
    return false;
}

/**
 * Whether a stage the cascade runs generates its coordinates from the
 * vertex normal.
 *
 * @param {RenderModel} model
 */
function generatesFromNormal(model){
    for (let stage = 0; stage < STAGE_COUNT; stage++)
    {
        const states = model.stageStates(stage);
        if ((states.get(D3DTSS.COLOROP) ?? 0) === D3DTOP.DISABLE)
        {
            return false;
        }
        if (readsNormal(states.get(D3DTSS.TEXCOORDINDEX) ?? 0))
        {
            return true;
        }
    }
    return false;
}

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
        const dimension = samples ? textureDimensionOf(texture) : '2d';
        stages.push(dimension === '2d' ? key : { ...key, dimension });
        textures.push(samples ? texture : null);
    }
    return { stages, textures, truncated: null };
}

/**
 * What a texture is sampled as: a cube map, a volume, or two-dimensional.
 *
 * @param {any} texture
 * @returns {'2d' | 'cube' | '3d'}
 */
export function textureDimensionOf(texture){
    if (texture?.cube === true)
    {
        return 'cube';
    }
    return texture?.volume === true ? '3d' : '2d';
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
    return fogOf(model, applied).mode;
}

/**
 * Where a draw's fog factor comes from, and the curve it is computed by.
 *
 * D3DRS_FOGENABLE with both modes NONE is not "no fog": the factor is then
 * the specular alpha, which is how a program that computes its own fog hands
 * it over. Wine's d3d9 test_fog_interpolation draws that case fogged by the
 * interpolated specular alpha, flat shading or not.
 *
 * @param {RenderModel} model
 * @param {boolean} [applied]  False runs the draw as if fog were disabled.
 * @returns {{ source: number, mode: number }} FOG_SOURCE and D3DFOG
 */
export function fogOf(model, applied = true){
    const rs = (/** @type {string} */ name)=>model.renderStates.get(D3DRS[name]) ?? 0;
    if (!applied || rs('FOGENABLE') === 0)
    {
        return { source: FOG_SOURCE.NONE, mode: D3DFOG.NONE };
    }
    if (rs('FOGTABLEMODE') !== D3DFOG.NONE)
    {
        return { source: FOG_SOURCE.TABLE, mode: rs('FOGTABLEMODE') };
    }
    if (rs('FOGVERTEXMODE') !== D3DFOG.NONE)
    {
        return { source: FOG_SOURCE.VERTEX, mode: rs('FOGVERTEXMODE') };
    }
    return { source: FOG_SOURCE.SPECULAR, mode: D3DFOG.NONE };
}

/**
 * Whether the vertex colours are flat over each primitive: D3DSHADE_FLAT.
 * Gouraud is the default, and Phong, which no device implements, draws as it.
 *
 * @param {RenderModel} model
 */
export const isFlatShaded = model=>
    (model.renderStates.get(D3DRS.SHADEMODE) ?? 0) === D3DSHADE.FLAT;

/**
 * Whether a projection is affine -- its fourth column (0, 0, 0, 1) -- which is
 * Direct3D's test for taking table fog over the pixel's z rather than its w.
 *
 * @param {ArrayLike<number>} projection
 */
export const isAffine = projection=>projection[3] === 0 && projection[7] === 0
    && projection[11] === 0 && projection[15] === 1;

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
    const fog = fogOf(model, shape.fog !== false);
    // Direct3D ties the depth write to the test: with ZENABLE off nothing is
    // written, whatever ZWRITEENABLE says. WebGPU writes under 'always', so
    // the write goes off with the test here, where the API's rule is known.
    const depthTest = shape.depthFormat !== undefined && rs('ZENABLE') !== D3DZB.FALSE;

    return {
        fvf: shape.fvf,
        vertexShader: 0,
        pixelShader: 0,
        targetFormat: shape.targetFormat,
        depthFormat: shape.depthFormat,
        topology: shape.topology,
        depthTest,
        depthWrite: depthTest && rs('ZWRITEENABLE') !== 0,
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
        fogMode: fog.mode,
        fogSource: fog.source,
        stages: shape.stages,
        // Specular is a fragment-stage decision as much as a lighting one: the
        // vertex's specular colour is added after the cascade whether lighting
        // computed it or the program supplied it.
        specularEnable: rs('SPECULARENABLE') !== 0,
        lighting: shape.lighting ?? null,
        normalizeNormals: rs('NORMALIZENORMALS') !== 0,
        flatShading: isFlatShaded(model),
        // Range fog is vertex fog's alone: table fog is the pixel's depth.
        rangeFog: fog.source === FOG_SOURCE.VERTEX && rs('RANGEFOGENABLE') !== 0,
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

/** GPUShaderStage.FRAGMENT. */
const FRAGMENT_VISIBILITY = 2;

/** D3DSTREAMSOURCE_INDEXEDDATA and _INSTANCEDATA, and the count beside them. */
const STREAMSOURCE_INDEXEDDATA = 0x40000000;
const STREAMSOURCE_INSTANCEDATA = 0x80000000;
const STREAMSOURCE_COUNT = 0x3fffffff;

/**
 * One level from the level above: a triangle over the target, and each pixel
 * the sampler's reading of the source at the pixel's centre, which for a
 * level half the size is the shared corner of the four texels it covers.
 */
const MIP_SHADER = `@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var sourceSampler: sampler;

struct Corner {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> Corner {
    let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
    var out: Corner;
    out.position = vec4f(corner * 2.0 - 1.0, 0.0, 1.0);
    out.uv = vec2f(corner.x, 1.0 - corner.y);
    return out;
}

@fragment
fn fs_main(in: Corner) -> @location(0) vec4f {
    return textureSampleLevel(source, sourceSampler, in.uv, 0.0);
}
`;

/**
 * @param {Map<number, number>} states  one stage's states
 * @param {boolean} [mips]  False pins every sample to the top level.
 * @param {number} [lod]  The bound texture's own level of detail.
 * @returns {{ magFilter: string, minFilter: string, mipmapFilter: string,
 *             addressModeU: string, addressModeV: string, addressModeW: string,
 *             lodMinClamp: number, lodMaxClamp: number }}
 */
export function samplerDescriptorOf(states, mips = true, lod = 0){
    const get = (/** @type {number} */ state)=>states.get(state) ?? 0;
    const mipFilter = mips ? get(D3DTSS.MIPFILTER) : D3DTEXF.NONE;
    const finest = Math.max(get(D3DTSS.MAXMIPLEVEL), lod);
    return {
        magFilter: FILTER[get(D3DTSS.MAGFILTER)] ?? 'nearest',
        minFilter: FILTER[get(D3DTSS.MINFILTER)] ?? 'nearest',
        mipmapFilter: FILTER[mipFilter] ?? 'nearest',
        addressModeU: ADDRESS[get(D3DTSS.ADDRESSU)] ?? 'repeat',
        addressModeV: ADDRESS[get(D3DTSS.ADDRESSV)] ?? 'repeat',
        addressModeW: ADDRESS[get(D3DTSS.ADDRESSW)] ?? 'repeat',
        // D3DTEXF_NONE for the mip filter means one level alone, however many
        // the texture has: the finest a program allows, which is the nearest
        // it lets any sample come.
        lodMinClamp: finest,
        lodMaxClamp: mipFilter === D3DTEXF.NONE ? finest : LOD_MAX,
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
 * uniform block instead: address mode per axis (bits 0-3, and 16-17 for a
 * volume's third), point filtering for magnification and minification (bits
 * 4-5), the mip mode (bits 6-7: none, point, linear) and the most detailed
 * level allowed (bits 8-15).
 * Measured reason: a device was seen to keep one sampler in force for every
 * draw of a run regardless of the group each draw bound, for stretches of
 * frames at a time, so a picture whose sampling depends on which sampler is
 * bound is not a picture the device can be trusted with.
 *
 * @param {Map<number, number>} states  one stage's states
 * @param {boolean} [mips]  False pins every sample to the top level.
 * @param {number} [lod]  The bound texture's own level of detail.
 * @returns {number}
 */
export function samplerFlagsOf(states, mips = true, lod = 0){
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
        | ((Math.min(255, Math.max(0, get(D3DTSS.MAXMIPLEVEL), lod)) & 0xff) << 8)
        | ((ADDRESS_BITS[get(D3DTSS.ADDRESSW)] ?? 0) << 16);
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
 * NOOVERWRITE wins when both are given: the lock is unsynchronised, and what
 * lies outside the locked range is kept rather than discarded.
 *
 * @param {number} flags D3DLOCK
 * @param {any} LockFlags the backend's
 * @returns {number}
 */
const lockFlagsOf = (flags, LockFlags)=>{
    if ((flags & D3DLOCK.NOOVERWRITE) !== 0)
    {
        return LockFlags.NOOVERWRITE;
    }
    if ((flags & D3DLOCK.DISCARD) !== 0)
    {
        return LockFlags.DISCARD;
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
    /** @type {WeakMap<object, number>} a cube face's surface -> which face it is */
    const surfaceFaces = new WeakMap();
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
    /**
     * Textures that make their own levels and whose top level changed since
     * they last made them: the levels are made again before the next draw
     * that samples one.
     *
     * @type {Set<any>}
     */
    const staleMips = new Set();
    /** @param {any} record */
    const markMips = record=>{
        if (record.autogen)
        {
            staleMips.add(record);
        }
    };
    /** @type {Map<string, Promise<any>>} a level-making pipeline per GPU format */
    const mipPipelines = new Map();

    /**
     * The occlusion count a BEGIN opened and replay has reached without its
     * END: it goes on counting across passes and frames until then. Replays
     * run one after another, so one is enough.
     *
     * @type {any}
     */
    let countingQuery = null;
    /**
     * The frame being replayed's occlusion queries: whose count each slot of
     * its set goes to, and the counts it holds a part of. Null in a frame
     * that counts nothing.
     *
     * @type {{ slots: any[], touched: Set<any> } | null}
     */
    let frameOcclusion = null;
    /** @param {any} count  An occlusion count every counter of which is back. */
    const settleOcclusion = count=>{
        count.value = count.total;
        count.resolve(count.total);
    };
    /** @returns {any} a count a BEGIN, or an END with no BEGIN, starts */
    const occlusionCount = ()=>{
        /** @type {any} */
        const count = { total: 0, outstanding: 0, ended: false, value: null, recording: null };
        count.settled = new Promise(resolve=>{
            count.resolve = resolve;
        });
        return count;
    };
    /** @type {Map<string, any>} one blank texture per dimension a binding may want */
    const placeholders = new Map();

    /** @type {any} the frame being recorded, or null between frames */
    let recording = null;
    /** @type {Promise<void>} */
    let chain = Promise.resolve();
    /** @type {any} The GPU surface the last present handed over: the front buffer. */
    let front = null;
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
            /**
             * A draw whose further stream is bound at an offset its vertex
             * buffer cannot start at.
             */
            stream: 0,
            /**
             * An instanced draw with a stream stepping once every several
             * instances, which a WebGPU vertex buffer cannot.
             */
            instancing: 0,
        },
        /** Draws that ran through a program rather than the fixed-function pipeline. */
        programmable: 0,
        /** Times a texture that makes its own levels made them again. */
        mipsGenerated: 0,
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
        for (let index = 0; index < lighting.lights.length; index++)
        {
            tally.types.add(lighting.lights[index]);
        }
        // Each sample below is text, and a set whose values repeat never
        // fills: what was sampled last is remembered, so a draw under the
        // same ambient, lights, world or material as the one before builds
        // nothing. Each of them is replaced, never written into, when it
        // changes.
        const ambient = (model.renderStates.get(D3DRS.AMBIENT) ?? 0) >>> 0;
        if (tally.ambients.size < SAMPLE_LIMIT && ambient !== lastSampled.ambient)
        {
            lastSampled.ambient = ambient;
            tally.ambients.add(ambient.toString(16).padStart(8, '0'));
        }
        const lights = enabledLights(model);
        if (lights !== lastSampled.lights && tally.lightValues.size < SAMPLE_LIMIT)
        {
            lastSampled.lights = lights;
            for (let index = 0; index < lights.length; index++)
            {
                const light = lights[index];
                if (!lightMoved(index, light))
                {
                    continue;
                }
                sample(tally.lightValues, ()=>`type=${light.Type} range=${round(light.Range)}`
                    + ` atten=${round(light.Attenuation0)}/${round(light.Attenuation1)}`
                    + `/${round(light.Attenuation2)}`
                    + ` at=${round(light.Position.x)},${round(light.Position.y)}`
                    + `,${round(light.Position.z)}`
                    + ` diffuse=${colourText(light.Diffuse)} ambient=${colourText(light.Ambient)}`);
            }
        }
        // A light lives in world space and a vertex reaches it through the
        // world matrix. A program that leaves the world matrix at identity and
        // puts the model transform in the view matrix -- which is common, and
        // legal -- has its geometry nowhere near its lights, and every
        // attenuated light then falls off to nothing. Comparing the two
        // translations is what tells that apart from a light that is simply
        // dim, and nothing else in a frame does.
        const world = transformOf(model, D3DTS.WORLD);
        if (tally.worlds.size < SAMPLE_LIMIT && sampledWorldMoved(world))
        {
            sample(tally.worlds, ()=>`origin=${round(world[12])},${round(world[13])}`
                + `,${round(world[14])}`
                + ` scale=${round(Math.hypot(world[0], world[1], world[2]))}`);
        }
        const material = model.material;
        if (material !== lastSampled.material && tally.materials.size < SAMPLE_LIMIT)
        {
            lastSampled.material = material;
            sample(tally.materials, ()=>`diffuse=${colourText(material?.Diffuse)}`
                + ` ambient=${colourText(material?.Ambient)}`
                + ` emissive=${colourText(material?.Emissive)}`);
        }
    };

    /**
     * Whether the light at a place in the enabled list holds other values
     * than the one sampled there last, of those its sample reads: a program
     * that sets the same light again before every draw makes a new object
     * each time, with nothing new to say.
     *
     * @param {number} slot @param {Light} light
     */
    const lightMoved = (slot, light)=>{
        const need = (slot + 1) * LIGHT_SAMPLE_FLOATS;
        if (need > sampledLightValues.length)
        {
            const grown = new Float64Array(need * 2).fill(NaN);
            grown.set(sampledLightValues);
            sampledLightValues = grown;
        }
        const values = sampledLightValues;
        const at = slot * LIGHT_SAMPLE_FLOATS;
        let moved = 0;
        moved |= keepValue(values, at, light.Type);
        moved |= keepValue(values, at + 1, light.Range);
        moved |= keepValue(values, at + 2, light.Attenuation0);
        moved |= keepValue(values, at + 3, light.Attenuation1);
        moved |= keepValue(values, at + 4, light.Attenuation2);
        moved |= keepValue(values, at + 5, light.Position.x);
        moved |= keepValue(values, at + 6, light.Position.y);
        moved |= keepValue(values, at + 7, light.Position.z);
        moved |= keepColour(values, at + 8, light.Diffuse);
        moved |= keepColour(values, at + 13, light.Ambient);
        return moved !== 0;
    };
    const LIGHT_SAMPLE_FLOATS = 18;
    let sampledLightValues = new Float64Array(8 * LIGHT_SAMPLE_FLOATS).fill(NaN);

    /**
     * Whether the world matrix differs from the one sampled last in what its
     * sample reads: the translation and the length of the first row. The
     * device writes a new world into the matrix it holds, so the object says
     * nothing.
     *
     * @param {ArrayLike<number>} world
     */
    const sampledWorldMoved = world=>(keepValue(sampledWorld, 0, world[0])
        | keepValue(sampledWorld, 1, world[1]) | keepValue(sampledWorld, 2, world[2])
        | keepValue(sampledWorld, 3, world[12]) | keepValue(sampledWorld, 4, world[13])
        | keepValue(sampledWorld, 5, world[14])) !== 0;
    const sampledWorld = new Float64Array(6).fill(NaN);

    /** What `countLighting` sampled last, of each thing it samples. */
    const lastSampled = {
        ambient: -1,
        /** @type {unknown} */
        lights: null,
        /** @type {unknown} */
        material: null,
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
            + ` fog=${fogSourceOf(state) === FOG_SOURCE.NONE ? '-' : fogSettingOf(model)}`
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
            + ` fog=${fogSourceOf(prepared.state) === FOG_SOURCE.NONE
                ? '-' : fogSettingOf(model)}`
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
     * @param {RenderModel} model  whose further streams' strides it reads
     * @returns {import('../webgpu/internal/vertexformat.js').VertexLayout | null}
     */
    const layoutOfDeclaration = (declared, stride, model)=>{
        const streams = declared.streams.map(stream=>({ stream, stride: strideOf(model, stream) }));
        /** @param {number} stream */
        const own = stream=>(stream === 0 ? stride
            : /** @type {{ stride: number }} */ (streams.find(one=>one.stream === stream)).stride);
        // A stream of stride zero is read at its start for every vertex, and
        // what it holds is only as long as its longest member.
        if (declared.attributes.some(attribute=>own(attribute.stream) !== 0
            && attribute.offset + attribute.bytes > own(attribute.stream)))
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
                ...(attribute.stream === 0 ? {} : { stream: attribute.stream }),
            })),
            preTransformed: declared.preTransformed,
            texCoordSets: declared.texCoordSets,
            blendWeights: 0,
            ...(streams.length === 0 ? {} : { streams: stepped({ streams }, model).streams }),
        };
    };

    /**
     * A layout whose further streams say which step once an instance rather
     * than once a vertex: those whose frequency D3DSTREAMSOURCE_INSTANCEDATA
     * marks. Stream zero always steps by vertex; a device that sets no
     * frequency has every stream do so.
     *
     * @template {{ streams?: { stream: number, stride: number, instanced?: boolean }[] }} L
     * @param {L} layout @param {RenderModel} model
     * @returns {L}
     */
    const stepped = (layout, model)=>{
        const frequencies = model.streamFrequencies;
        if (!layout.streams || !frequencies || frequencies.size === 0)
        {
            return layout;
        }
        return {
            ...layout,
            streams: layout.streams.map(one=>(
                ((frequencies.get(one.stream) ?? 1) & STREAMSOURCE_INSTANCEDATA) !== 0
                    ? { ...one, instanced: true }
                    : one)),
        };
    };

    /**
     * How many instances an indexed draw draws: the count stream zero's
     * frequency carries, when D3DSTREAMSOURCE_INDEXEDDATA marks it or a
     * further stream steps by instance (Wine's d3d9 stream_test reads it
     * from stream zero either way); one otherwise. Zero when a stream steps
     * once every several instances, which is not drawn.
     *
     * @param {RenderModel} model
     */
    const instancesOf = model=>{
        const frequencies = model.streamFrequencies;
        if (!frequencies || frequencies.size === 0)
        {
            return 1;
        }
        let instanced = false;
        for (const [stream, frequency] of frequencies)
        {
            if (stream !== 0 && (frequency & STREAMSOURCE_INSTANCEDATA) !== 0)
            {
                if ((frequency & STREAMSOURCE_COUNT) !== 1)
                {
                    return 0;
                }
                instanced = true;
            }
        }
        const zero = frequencies.get(0) ?? 1;
        return instanced || (zero & STREAMSOURCE_INDEXEDDATA) !== 0
            ? Math.max(1, zero & STREAMSOURCE_COUNT)
            : 1;
    };

    /**
     * The stride a further stream is read at: its binding's, or zero with
     * nothing bound -- every vertex then reads the start of a buffer of
     * zeros, which is what a member in an empty stream reads as (Wine's
     * d3d9 test_color_vertex draws such a colour black).
     *
     * @param {RenderModel} model @param {number} stream
     */
    const strideOf = (model, stream)=>{
        const source = model.streamAt?.(stream);
        return source?.buffer ? source.stride : 0;
    };

    /** @type {any} a buffer of zeros for a stream with nothing bound */
    let zeroStream = null;

    /**
     * How many vertices stream zero's offset was folded into the first
     * vertex as, which a device with offsets does before a buffer draw.
     *
     * @param {RenderModel} model
     */
    const streamZeroBias = model=>(model.stream.stride > 0
        ? Math.floor((model.stream.offset ?? 0) / model.stream.stride) : 0);

    /**
     * The further streams a layout reads and their strides, for a key: a
     * stride is the pipeline's.
     *
     * @param {{ streams?: readonly { stream: number, stride: number,
     *     instanced?: boolean }[] }} layout
     */
    const streamsKey = layout=>(layout.streams ?? [])
        .map(one=>`|s${one.stream}:${one.stride}${one.instanced ? 'i' : ''}`).join('');

    /**
     * Binds a recorded draw's further streams, after stream zero's.
     *
     * @param {any} pass @param {any} command
     */
    const bindStreams = (pass, command)=>{
        for (const bound of command.streams ?? [])
        {
            pass.setVertexBuffer(bound.slot, bound.gpu, bound.offset);
        }
    };

    /**
     * The vertex buffers a draw binds past stream zero's, slot by slot, or
     * null when one of them cannot be bound as it lies: WebGPU starts a
     * vertex buffer at a multiple of four bytes, and stream zero's offset is
     * folded into the first vertex (`bias` of them), which a further stream
     * has to take back from its own.
     *
     * @param {RenderModel} model
     * @param {readonly { stream: number, stride: number, instanced?: boolean }[] | undefined}
     *        streams
     * @param {number} bias
     * @returns {readonly { slot: number, gpu: any, offset: number }[] | null}
     */
    const streamBindings = (model, streams, bias)=>{
        if (!streams || streams.length === 0)
        {
            return NO_STREAM_BINDINGS;
        }
        /** @type {{ slot: number, gpu: any, offset: number }[]} */
        const bound = [];
        for (let index = 0; index < streams.length; index++)
        {
            const { stream, instanced } = streams[index];
            const source = model.streamAt?.(stream);
            if (!source?.buffer)
            {
                zeroStream ??= backend.createDynamicBuffer({
                    size: ZERO_STREAM_BYTES,
                    usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
                    label: 'zero-stream',
                });
                bound.push({ slot: index + 1, gpu: zeroStream.gpu, offset: 0 });
                continue;
            }
            // Stream zero's first vertex moves the streams that step with it;
            // one stepping by instance starts at its first instance.
            const offset = (source.offset ?? 0) - (instanced ? 0 : bias * source.stride);
            if (offset < 0 || offset % 4 !== 0)
            {
                return null;
            }
            const buffer = bufferFor(source.buffer).gpu;
            buffer.markRead();
            bound.push({ slot: index + 1, gpu: buffer.gpu, offset });
        }
        return bound;
    };

    /** What a draw reading stream zero alone binds beside it. */
    const NO_STREAM_BINDINGS = Object.freeze(
        /** @type {{ slot: number, gpu: any, offset: number }[]} */ ([]));

    let layoutReported = false;
    let instancingReported = false;
    /** Says once that fixed-function draws were dropped for want of a format. */
    const reportLayout = ()=>{
        if (divergence && !layoutReported)
        {
            layoutReported = true;
            divergence('Direct3D 8',
                'a fixed-function draw over a vertex declaration the fixed-function stage'
                + ' cannot read (blend weights, a colour that is not a D3DCOLOR, or a member'
                + ' past the vertex) is not drawn');
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
            const face = surfaceFaces.get(surface) ?? 0;
            return level === 0 && record.gpuLevels === 1 && record.faces === 1
                ? record.gpu
                : levelSurfaceOf(record, level, face);
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
     * A volume texture's levels, taken into care as a texture's surfaces are:
     * each unlock, through the texture or through the level, marks that
     * level for upload unless a managed texture keeps its copy, AddDirtyBox
     * marks them all, and a level handed out is known by what it is a level
     * of, so a copy into it marks it too.
     *
     * @param {any} texture @param {any} entry
     * @param {(level: number) => void} soiled
     * @param {(volume: any) => boolean} keepsCopy
     */
    const trackVolumeLevels = (texture, entry, soiled, keepsCopy)=>{
        const volumeLevel = texture.GetVolumeLevel;
        const unlockBox = texture.UnlockBox;
        const addDirtyBox = texture.AddDirtyBox;
        texture.UnlockBox = (/** @type {number} */ level)=>{
            /** @type {{ volume?: any }} */
            const held = {};
            const keeps = volumeLevel(level, held) === D3D_OK && keepsCopy(held.volume);
            held.volume?.release();
            const hr = unlockBox(level);
            if (hr === D3D_OK && !keeps)
            {
                soiled(level);
            }
            return hr;
        };
        texture.AddDirtyBox = (/** @type {any} */ box)=>{
            const hr = addDirtyBox(box);
            if (hr === D3D_OK)
            {
                for (let level = 0; level < entry.levels; level++)
                {
                    soiled(level);
                }
            }
            return hr;
        };
        const hooked = new WeakSet();
        /** @param {number} level @param {{ volume?: any }} out */
        texture.GetVolumeLevel = (level, out)=>{
            const hr = volumeLevel(level, out);
            const volume = hr === D3D_OK ? out.volume : null;
            if (volume && !hooked.has(volume))
            {
                hooked.add(volume);
                textures.set(volume, entry);
                surfaceLevels.set(volume, level);
                const unlockVolume = volume.UnlockBox;
                volume.UnlockBox = ()=>{
                    const keeps = keepsCopy(volume);
                    const unlocked = unlockVolume();
                    if (unlocked === D3D_OK && !keeps)
                    {
                        soiled(level);
                    }
                    return unlocked;
                };
            }
            return hr;
        };
        /** @type {{ volume?: any }} */
        const top = {};
        if (texture.GetVolumeLevel(0, top) === D3D_OK)
        {
            top.volume.release();
            entry.base = top.volume.base;
        }
    };

    /**
     * A level above the top, or a face of a cube, as a target: the same
     * backend texture through a view of that level of that face alone.
     *
     * @param {any} record @param {number} level @param {number} [face]
     */
    const levelSurfaceOf = (record, level, face = 0)=>{
        const views = record.levelSurfaces ??= new Map();
        const key = face * record.gpuLevels + level;
        let made = views.get(key);
        if (!made)
        {
            const label = `texture:${record.id}:${face > 0 ? `${face}:` : ''}${level}`;
            made = {
                texture: record.gpu.texture,
                view: record.gpu.texture.createView({
                    label, dimension: '2d', baseMipLevel: level, mipLevelCount: 1,
                    baseArrayLayer: face, arrayLayerCount: 1,
                }),
                width: levelExtent(record.width, level),
                height: levelExtent(record.height, level),
                format: record.gpu.format,
                mipLevelCount: 1,
                layers: 1,
                label,
                mipLevel: level,
                layer: face,
            };
            views.set(key, made);
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
     *           texels: Uint8Array, layer?: number, depth?: number }} upload
     *        `layer` is a cube's face; `depth` a volume level's slices, one after another.
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
            ...(upload.layer ? { origin: { x: 0, y: 0, z: upload.layer } } : {}),
            ...(upload.depth ? { depthOrArrayLayers: upload.depth } : {}),
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

    /**
     * A 1x1 texture for a stage that reads no texture but is declared to have
     * one, of the dimension it is declared with.
     *
     * @param {string} [dimension]  '2d', 'cube' or '3d'.
     */
    const placeholderView = (dimension = '2d')=>{
        let placeholder = placeholders.get(dimension);
        if (!placeholder)
        {
            placeholder = backend.createSurface({
                width: 1,
                height: 1,
                format: COLOR_FORMAT,
                label: dimension === '2d' ? 'placeholder' : `placeholder:${dimension}`,
                usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST
                    | (dumpDraws ? TextureUsage.COPY_SRC : 0),
                ...(dimension === 'cube' ? { layers: 6, dimension: 'cube' } : {}),
                ...(dimension === '3d' ? { depth: 1, dimension: '3d' } : {}),
            });
            placeholders.set(dimension, placeholder);
            if (dumpDraws && dimension === '2d')
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
     * One level of a volume texture, all its slices, into the GPU's. A volume
     * is never in blocks and never drawn into, so it is widened like any
     * texture and goes up out of the frame's order.
     *
     * @param {any} record @param {number} level @param {number} width @param {number} height
     */
    const uploadVolumeLevel = (record, level, width, height)=>{
        /** @type {{ volume?: any }} */
        const held = {};
        if (record.texture.GetVolumeLevel(level, held) !== D3D_OK || !held.volume)
        {
            return;
        }
        held.volume.release();
        const depth = levelExtent(record.depth, level);
        const bytes = readMemory(held.volume.base, held.volume.slicePitch * depth);
        uploadTexels(record.gpu, {
            format: gpuFormatOf(record.format, record.width, record.height, false),
            mipLevel: level, width, height, depth,
            texels: expandTexels(record.format, bytes, width * height * depth),
        }, false);
        (record.written ??= new Set()).add(level);
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
                mipLevelCount: record.gpuLevels,
                ...(record.faces === 6 ? { layers: 6, dimension: 'cube' } : {}),
                ...(record.volume ? { depth: record.depth, dimension: '3d' } : {}),
                label: record.faces === 6 ? 'cube' : record.volume ? 'volume' : 'texture',
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
            for (const subresource of [...record.dirtyLevels].sort((left, right)=>left - right))
            {
                const level = subresource % record.levels;
                const face = Math.floor(subresource / record.levels);
                const width = levelExtent(record.width, level);
                const height = levelExtent(record.height, level);
                if (record.volume)
                {
                    uploadVolumeLevel(record, level, width, height);
                    continue;
                }
                // The level's own storage, made if the program never touched
                // it: a level it left unwritten is sampled as whatever lies
                // there, which is what a real device does with such a level.
                /** @type {{ surface?: any }} */
                const held = {};
                if ((record.faces === 6
                    ? texture.GetCubeMapSurface(face, level, held)
                    : texture.GetSurfaceLevel(level, held)) !== D3D_OK || !held.surface)
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
                    { format: gpuFormat, mipLevel: level, width, height, texels, layer: face },
                    record.ordered);
                if (level === 0)
                {
                    markMips(record);
                }
                // Which levels the program has written, and what its smallest
                // ones hold: a surface sampled far away comes out of those,
                // and a level the program never wrote is sampled all the same.
                (record.written ??= new Set()).add(level);
                if (width * height <= 16 && !keepsBlocks && face === 0)
                {
                    (record.tails ??= {})[level] = [...texels];
                }
                if (subresource === 0 && dumpDraws && !keepsBlocks)
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
            recording = {
                commands: [], pipelines: [], pass: null, viewport: null, scissor: '', arena,
            };
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
        const drawnInto = textures.get(model.renderTarget);
        if (drawnInto && (surfaceLevels.get(model.renderTarget) ?? 0) === 0)
        {
            markMips(drawnInto);
        }
        const depth = depthFor(model, target);
        frame.commands.push({ kind: 'pass', target, depth, ...clearing });
        frame.pass = { target, depth };
        frame.viewport = null;
        frame.scissor = '';
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
            frame.scissor = '';
        }
        return frame;
    };

    /**
     * The scissor a draw runs under: under D3DRS_SCISSORTESTENABLE the
     * scissor rectangle cut to the viewport, which is what the draw may
     * touch; otherwise the viewport's own, which setting the viewport set.
     * The recording remembers which is in force (the empty string for the
     * viewport's), so a run of draws under one scissor sets it once.
     *
     * @param {RenderModel} model
     * @param {any} frame  the recording, with the model's viewport applied
     */
    const ensureScissor = (model, frame)=>{
        const scissor = model.scissor;
        const on = scissor !== undefined
            && (model.renderStates.get(D3DRS9.SCISSORTESTENABLE) ?? 0) !== 0;
        const view = model.viewport.rect;
        let key = '';
        let rect = null;
        if (on)
        {
            const x = Math.max(view.x, scissor.left);
            const y = Math.max(view.y, scissor.top);
            rect = {
                x, y,
                width: Math.max(0, Math.min(view.x + view.width, scissor.right) - x),
                height: Math.max(0, Math.min(view.y + view.height, scissor.bottom) - y),
            };
            key = `${rect.x},${rect.y},${rect.width},${rect.height}`;
        }
        if (frame.scissor === key)
        {
            return;
        }
        frame.scissor = key;
        frame.commands.push({ kind: 'scissor', rect: rect ?? {
            x: view.x, y: view.y, width: view.width, height: view.height,
        } });
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
     * @param {number} [lod]  The bound texture's own level of detail.
     */
    const programSamplerFor = (states, lod = 0)=>{
        const descriptor = samplerDescriptorOf(states, mipsApplied, lod);
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
     * Numbers name states for as long as the renderer lives and are never
     * reused, so a key made before a table was cleared cannot name a different
     * state after it.
     */
    let nextStateNumber = 0;
    const STATE_NUMBERS_LIMIT = 1024;

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

    /**
     * A table numbering states laid out as words: equal numbers are equal
     * words. Looked up by an FNV-1a hash of them, with nothing built for a
     * hit; a hit is compared in full, so a collision costs a comparison and
     * never names two states alike.
     */
    const createNumbering = ()=>{
        /** @type {Map<number, { values: Int32Array, number: number }[]>} */
        const buckets = new Map();
        let size = 0;
        /** @param {Int32Array} words @param {number} count @returns {number} */
        return (words, count)=>{
            let hash = 0x811c9dc5;
            for (let index = 0; index < count; index++)
            {
                hash = Math.imul(hash ^ words[index], 0x01000193);
            }
            const bucket = buckets.get(hash);
            if (bucket !== undefined)
            {
                for (let index = 0; index < bucket.length; index++)
                {
                    const entry = bucket[index];
                    if (entry.values.length === count && sameWords(entry.values, words))
                    {
                        return entry.number;
                    }
                }
            }
            if (size >= STATE_NUMBERS_LIMIT)
            {
                buckets.clear();
                size = 0;
            }
            const entry = { values: words.slice(0, count), number: nextStateNumber++ };
            const held = buckets.get(hash);
            if (held !== undefined)
            {
                held.push(entry);
            }
            else
            {
                buckets.set(hash, [entry]);
            }
            size++;
            return entry.number;
        };
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
        // Everything but the constants and the texture views depends only on
        // state the device versions, so it is worked out once per change of
        // that state -- a program that sets its constants and binds a texture
        // before every draw, which is how a shader-drawn frame goes, changes
        // none of it. A 1.x pixel shader's reads also take the dimension of
        // what is bound, which a binding changes without a version.
        //
        // When that state has changed, it may be one this frame has drawn with
        // before -- a program flipping a render state between draws -- and the
        // pieces are looked up by its values, as a fixed-function preparation
        // is.
        const version = model.stateVersionBesideTextures;
        const legacy = legacyStages(model, program);
        const last = programPieces;
        let pieces = version !== undefined && last.made !== null
            && last.version === version
            && last.vertexShader === program.vertexShader
            && last.pixelShader === program.pixelShader
            && last.declarationId === program.declarationId
            && last.stride === stride && last.topology === topology
            && last.legacy === legacy.key
            ? last.made
            : null;
        if (pieces === null)
        {
            const key = programKeyOf(model, stride, topology, program, legacy.key);
            pieces = programPiecesKept.get(key) ?? null;
            if (pieces === null)
            {
                pieces = programPiecesOf(model, stride, topology, program, legacy);
                if (pieces === null)
                {
                    return null;
                }
                programPiecesKept.set(key, pieces);
                if (programPiecesKept.size > PREPARED_CACHE_LIMIT)
                {
                    const oldest = programPiecesKept.keys().next().value;
                    if (oldest !== undefined)
                    {
                        programPiecesKept.delete(oldest);
                    }
                }
            }
            last.version = version;
            last.vertexShader = program.vertexShader;
            last.pixelShader = program.pixelShader;
            last.declarationId = program.declarationId;
            last.stride = stride;
            last.topology = topology;
            last.legacy = legacy.key;
            last.made = version === undefined ? null : pieces;
        }
        const { pixel, vertex, samplerPlan, state, source } = pieces;
        const samplerBindings = samplerBindingsOf(model, pieces, samplerPlan);
        const take = ensureFrame().arena.take;
        const vertexBlocks = program.vertex
            ? shaderVertexBlocks(model, program, vertex, take)
            : hybridBlocks(model, take);
        const pixelBlocks = constantBlocks(program.pixelConstants, pixel.constants, take);
        if (pixel.bumpRegister !== undefined)
        {
            bumpMatrices(model, pixelBlocks[0], pixel.bumpRegister);
        }
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
                source,
                declarationId: program.declarationId,
                vertexBlocks,
                pixelBlocks,
                samplerBindings,
                held: pieces,
            },
        };
    };

    /**
     * The textures, views and samplers a shader draw binds, as the list its
     * pieces handed out last when every one of them is the same -- a draw's
     * command keeps the list, and the list is never written into -- or a new
     * one.
     *
     * @param {RenderModel} model @param {any} pieces @param {any[]} samplerPlan
     * @returns {any[]}
     */
    const samplerBindingsOf = (model, pieces, samplerPlan)=>{
        const last = pieces.samplerBindings;
        let same = last !== null && last.length === samplerPlan.length;
        for (let index = 0; index < samplerPlan.length; index++)
        {
            const planned = samplerPlan[index];
            const bound = model.textures.get(planned.stage);
            // A texture of another dimension than the shader declared cannot
            // be bound to it: the sampler reads a blank one instead.
            const texture = bound && textureDimensionOf(bound) === planned.dimension
                ? bound
                : null;
            if (bound && !texture)
            {
                reportProgram(`dimension:${planned.stage}:${planned.dimension}`,
                    `sampler s${planned.stage} is declared ${planned.dimension} and a`
                    + ` ${textureDimensionOf(bound)} texture is bound there: it samples nothing`);
            }
            // A binding moves no state version, and a managed texture's own
            // level of detail is part of how it is sampled.
            const lod = lodOf(texture);
            const view = texture ? uploadIfDirty(texture).view : placeholderView(planned.dimension);
            const sampler = lod === planned.lod
                ? planned.sampler
                : programSamplerFor(model.stageStates(planned.stage), lod);
            boundTextures[index] = texture;
            boundViews[index] = view;
            boundSamplers[index] = sampler;
            same = same && last[index].texture === texture && last[index].view === view
                && last[index].sampler === sampler;
        }
        if (same)
        {
            return last;
        }
        const made = samplerPlan.map((/** @type {any} */ planned, /** @type {number} */ index)=>({
            stage: planned.stage,
            texture: boundTextures[index],
            view: boundViews[index],
            sampler: boundSamplers[index],
            placeholder: !boundTextures[index],
        }));
        pieces.samplerBindings = made;
        return made;
    };
    /** What `samplerBindingsOf` worked out for each planned sampler of the draw. */
    /** @type {any[]} */
    const boundTextures = [];
    /** @type {any[]} */
    const boundViews = [];
    /** @type {any[]} */
    const boundSamplers = [];

    /**
     * The last shader draw's state-dependent pieces and the state they were
     * made for; see `prepareProgram`.
     *
     * @type {{ version: number | undefined, vertexShader: any, pixelShader: any,
     *          declarationId: number, stride: number, topology: string, legacy: string,
     *          made: any }}
     */
    const programPieces = { version: undefined, vertexShader: null, pixelShader: null,
        declarationId: 0, stride: 0, topology: '', legacy: '', made: null };

    /**
     * The pieces of the states this frame's shader draws were made with, by
     * `programKeyOf`, bounded as `preparedCache` is.
     *
     * @type {Map<number, any>}
     */
    const programPiecesKept = new Map();

    /**
     * What a shader draw's pieces depend on, as a number: the device state
     * beside the textures as `stateNumberOf` names it (kept while
     * `stateVersionBesideTextures` holds still), the two shaders, the
     * declaration, the stride and topology, a 1.x pixel shader's texture
     * dimensions and projections, and every stream's stride and frequency,
     * which the vertex layout is read through.
     *
     * @param {RenderModel} model @param {number} stride @param {string} topology
     * @param {ProgramState} program @param {string} legacyKey
     * @returns {number}
     */
    const programKeyOf = (model, stride, topology, program, legacyKey)=>{
        const version = model.stateVersionBesideTextures;
        if (version === undefined || version !== programStateVersion)
        {
            programStateNumber = stateNumberOf(model, PROGRAM_PROCESSING);
            programStateVersion = version;
        }
        const words = programWords;
        let at = 0;
        words[at++] = programStateNumber;
        words[at++] = objectSerialOf(program.vertexShader);
        words[at++] = objectSerialOf(program.pixelShader);
        words[at++] = program.declarationId;
        words[at++] = stride;
        words[at++] = topologyIdOf(topology);
        words[at++] = legacyIdOf(legacyKey);
        const frequencies = model.streamFrequencies;
        for (let stream = 0; stream < PROGRAM_STREAMS; stream++)
        {
            words[at++] = strideOf(model, stream);
            words[at++] = frequencies?.get(stream) ?? 1;
        }
        return programNumbering(words, at);
    };

    /** The streams a declaration may read, as Direct3D 9 has them. */
    const PROGRAM_STREAMS = 16;
    /** A shader draw's state is named apart from any vertex format. */
    const PROGRAM_PROCESSING = Object.freeze({ fvf: 0, fixedFunctionLayout: null });
    const programWords = new Int32Array(7 + PROGRAM_STREAMS * 2);
    const programNumbering = createNumbering();
    let programStateNumber = -1;
    /** @type {number | undefined} */
    let programStateVersion;
    /** @type {Map<string, number>} */
    const legacyIds = new Map();
    /** @param {string} key */
    const legacyIdOf = key=>{
        let id = legacyIds.get(key);
        if (id === undefined)
        {
            id = legacyIds.size;
            legacyIds.set(key, id);
        }
        return id;
    };
    /** @type {WeakMap<object, number>} */
    const objectSerials = new WeakMap();
    let nextObjectSerial = 1;
    /** @param {object | null} object  Zero for none. */
    const objectSerialOf = object=>{
        if (!object)
        {
            return 0;
        }
        let serial = objectSerials.get(object);
        if (serial === undefined)
        {
            serial = nextObjectSerial++;
            objectSerials.set(object, serial);
        }
        return serial;
    };

    /** What `legacyStages` answers for a shader of model 2 or later. */
    const NO_LEGACY_STAGES = Object.freeze({ key: '' });

    /**
     * What a 1.x pixel shader's reads depend on beyond the shader: the
     * dimension of the texture bound at each stage and, below 1.4, the
     * component D3DTTFF_PROJECTED divides each stage's coordinates by. None
     * for any other shader.
     *
     * @param {RenderModel} model @param {ProgramState} program
     * @returns {{ key: string, stageDimensions?: string[], projectedBy?: string[] }}
     */
    const legacyStages = (model, program)=>{
        const version = program.pixel?.version;
        if (!version || version.major >= 2)
        {
            return NO_LEGACY_STAGES;
        }
        /** @type {string[]} */
        const stageDimensions = [];
        /** @type {string[]} */
        const projectedBy = [];
        for (let stage = 0; stage < LEGACY_STAGES; stage++)
        {
            stageDimensions.push(textureDimensionOf(model.textures.get(stage)));
            const flags = version.minor >= 4
                ? 0
                : model.stageStates(stage).get(D3DTSS.TEXTURETRANSFORMFLAGS) ?? 0;
            projectedBy.push((flags & TTFF_PROJECTED) === 0
                ? ''
                : PROJECTED_BY[flags & 0xff] ?? '');
        }
        return {
            key: `${stageDimensions.join(',')}|${projectedBy.join(',')}`,
            stageDimensions, projectedBy,
        };
    };

    /**
     * Each stage's bump matrix and luminance, into the registers a 1.x pixel
     * shader's translation reads them from.
     *
     * @param {RenderModel} model @param {Float32Array} floats @param {number} register
     */
    const bumpMatrices = (model, floats, register)=>{
        for (let stage = 0; stage < STAGE_COUNT; stage++)
        {
            const states = model.stageStates(stage);
            const read = (/** @type {number} */ state)=>dwordToFloat(states.get(state) ?? 0);
            floats.set([
                read(D3DTSS.BUMPENVMAT00), read(D3DTSS.BUMPENVMAT01),
                read(D3DTSS.BUMPENVMAT10), read(D3DTSS.BUMPENVMAT11),
                read(D3DTSS.BUMPENVLSCALE), read(D3DTSS.BUMPENVLOFFSET), 0, 0,
            ], (register + stage * 2) * 4);
        }
    };

    /**
     * The translations, layout, pipeline state and samplers of a shader draw:
     * what `prepareProgram` keeps while the state holds still, or null when
     * the draw cannot be built (reported here).
     *
     * @param {RenderModel} model
     * @param {number} stride
     * @param {string} topology
     * @param {ProgramState} program
     * @param {ReturnType<typeof legacyStages>} legacy
     */
    const programPiecesOf = (model, stride, topology, program, legacy)=>{
        if (!program.declaration)
        {
            return null;
        }
        const pixelShader = /** @type {object} */ (program.pixelShader);
        // The fixed-function fog stage runs after a pixel shader below model 3,
        // so a shader-drawn surface is fogged exactly as a fixed-function one
        // is -- and this device refuses a pixel shader above model 2. Only a
        // draw whose vertex stage is the fixed one can promise the oFog
        // varying the mix reads, so a draw through a vertex shader of the
        // program's own keeps the fog Direct3D would take from that shader,
        // which this translation does not compute.
        const fog = program.vertex
            ? { source: FOG_SOURCE.NONE, mode: D3DFOG.NONE }
            : fogOf(model, fogApplied);
        // Flat shading is declared on both sides of the two colour varyings,
        // so every translation of the pair is made for it.
        const flat = isFlatShaded(model);
        const normalizeNormals = (model.renderStates.get(D3DRS.NORMALIZENORMALS) ?? 0) !== 0;
        const rangeFog = fog.source === FOG_SOURCE.VERTEX
            && (model.renderStates.get(D3DRS.RANGEFOGENABLE) ?? 0) !== 0;
        const pixel = translationOf(pixelShader,
            `ps|fog${fog.source}/${fog.mode}${flat ? '|flat' : ''}|${legacy.key}`,
            ()=>translateShader(
                /** @type {import('../d3d9/shader.js').ParsedShader} */ (program.pixel), {
                    ...(fog.source === FOG_SOURCE.NONE
                        ? {} : { fog: fog.mode, fogSource: fog.source }),
                    flatColours: flat,
                    stageDimensions: legacy.stageDimensions,
                    projectedBy: legacy.projectedBy,
                }));
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
        const laid = vertexLayoutOf(program.declaration, wanted, stride,
            stream=>strideOf(model, stream));
        if (!laid.layout)
        {
            skip('program');
            reportProgram(`decl:${program.declarationId}`,
                `a draw through declaration ${program.declarationId} was not drawn: ${laid.error}`);
            return null;
        }
        const layout = stepped(laid.layout, model);
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
                `vs:${shapes}|w${missing.join(',')}${flat ? '|flat' : ''}`,
                ()=>translateShader(
                    /** @type {import('../d3d9/shader.js').ParsedShader} */ (program.vertex),
                    { inputs: layout.shapes, alsoWrite: missing, flatColours: flat }))
            : hybridStageFor(
                `${program.declarationId}|${shapes}|w${missing.join(',')}|g${generated.join(',')}`
                    + `|f${fog.source}/${fog.mode}${flat ? '|flat' : ''}`
                    + `${normalizeNormals ? '|normalize' : ''}${rangeFog ? '|range' : ''}`,
                wanted, layout.shapes, missing, generated, fog,
                { flatColours: flat, normalizeNormals, rangeFog });
        if (vertex.error)
        {
            skip('program');
            reportProgram(`vs:${program.vertexId}:${program.declarationId}`,
                `vertex stage of shader ${program.vertexId} was not drawn: ${vertex.error}`);
            return null;
        }
        const samplerPlan = pixel.samplers.map((/** @type {any} */ entry)=>{
            const lod = lodOf(model.textures.get(entry.index));
            return {
                stage: entry.index,
                dimension: samplerDimension(entry.type),
                lod,
                sampler: programSamplerFor(model.stageStates(entry.index), lod),
            };
        });
        const state = {
            ...pipelineStateOf(model, {
                fvf: 0, topology, ...formatsOf(model), stages: [], lighting: null,
                fog: fogApplied,
            }),
            vertexShader: program.vertex ? program.vertexId : -1,
            pixelShader: program.pixelId,
        };
        return {
            pixel,
            vertex,
            samplerPlan,
            state,
            // The bindings handed out last, and the recording and index of the
            // pipeline in it: kept with the pieces, where a draw's own
            // preparation is made for it alone.
            samplerBindings: null,
            pipelineFrame: null,
            pipelineIndex: 0,
            source: {
                key: `${state.vertexShader}/${state.pixelShader}/${program.declarationId}`
                    + `/${shapes}/${stride}${streamsKey(layout)}`,
                vertex, pixel, layout,
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
        const laid = vertexLayoutOf(declaration, base.inputs, stride,
            stream=>strideOf(model, stream));
        if (!laid.layout)
        {
            skip('program');
            reportProgram(`decl:${program.declarationId}`,
                `a draw through declaration ${program.declarationId} was not drawn: ${laid.error}`);
            return null;
        }
        const layout = stepped(laid.layout, model);
        const shapes = shapeKey(layout);
        const flat = isFlatShaded(model);
        /** @type {import('../d3d9/wgsl.js').TranslatedShader} */
        const vertex = translationOf(/** @type {object} */ (program.vertexShader),
            `vs:${shapes}${flat ? '|flat' : ''}`, ()=>translateShader(
                /** @type {import('../d3d9/shader.js').ParsedShader} */ (program.vertex),
                { inputs: layout.shapes, flatColours: flat }));
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
        const vertexBlocks = shaderVertexBlocks(model, program, vertex, take);
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
                        + `${streamsKey(layout)}/${pipelineKey(state)}`,
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
     * @param {{ source: number, mode: number }} fog  See `fogOf`.
     * @param {{ flatColours: boolean, normalizeNormals: boolean, rangeFog: boolean }} shading
     *     See `fixedVertexStage`.
     */
    const hybridStageFor = (key, wanted, shapes, alsoWrite, generated, fog, shading)=>{
        const existing = hybridStages.get(key);
        if (existing)
        {
            return existing;
        }
        const made = fixedVertexStage(wanted, shapes, alsoWrite, generated, fog.mode, fog.source,
            shading);
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
     * The constant blocks a vertex shader reads: its file, and the viewport's
     * scale in the register past it, for the half-pixel move of its position.
     *
     * @param {RenderModel} model @param {ProgramState} program
     * @param {import('../d3d9/wgsl.js').TranslatedShader} vertex
     * @param {(floats: number) => Float32Array} take
     */
    const shaderVertexBlocks = (model, program, vertex, take)=>{
        const blocks = constantBlocks(program.vertexConstants, vertex.constants, take);
        if (vertex.viewportRegister !== undefined)
        {
            blocks[0].set(model.viewport.scale, vertex.viewportRegister * 4);
        }
        return blocks;
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
        if (generatesFromNormal(model))
        {
            floats.set(normalMatrixOf(worldView, CAMERA_NORMAL_MATRIX),
                HYBRID_CONSTANTS.CAMERA_NORMAL * 4);
        }
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
            isAffine(transformOf(model, D3DTS.PROJECTION)) ? 1 : 0,
        ], HYBRID_CONSTANTS.FOG * 4);
        const fogColour = colorToFloats(rs('FOGCOLOR'));
        floats.set([fogColour.r, fogColour.g, fogColour.b, fogColour.a],
            HYBRID_CONSTANTS.FOG_COLOR * 4);
        return [floats, take(64), take(16)];
    };

    /**
     * The levels of each texture a draw samples that makes its own and whose
     * top level changed, made again ahead of the draw.
     *
     * @param {any} frame @param {any} prepared
     */
    const regenerateSampled = (frame, prepared)=>{
        for (const binding of prepared.stageBindings)
        {
            const record = binding.texture ? textures.get(binding.texture) : null;
            if (!record || !staleMips.has(record) || !record.gpu)
            {
                continue;
            }
            staleMips.delete(record);
            const format = record.gpu.format;
            let pipeline = mipPipelines.get(format);
            if (!pipeline)
            {
                pipeline = mipPipeline(format);
                mipPipelines.set(format, pipeline);
            }
            frame.pipelines.push(pipeline);
            frame.commands.push({
                kind: 'mips',
                record,
                pipeline: frame.pipelines.length - 1,
                // D3DTEXF_POINT picks a texel of the four; every other filter
                // a program may name is made linearly.
                linear: record.texture.GetAutoGenFilterType?.() !== D3DTEXF.POINT,
            });
            counters.mipsGenerated++;
        }
    };

    /**
     * The pipeline that draws one level from the level above: a triangle over
     * the level, each pixel sampling the four texels above it at their shared
     * corner.
     *
     * @param {string} format
     */
    const mipPipeline = async format=>{
        const layout = backend.createBindGroupLayout({
            label: 'mips',
            entries: [
                { binding: 0, visibility: FRAGMENT_VISIBILITY, texture: {} },
                { binding: 1, visibility: FRAGMENT_VISIBILITY, sampler: {} },
            ],
        });
        const module = await backend.createShaderModule({ label: 'mips', code: MIP_SHADER });
        const gpu = await backend.createRenderPipelineAsync({
            label: `mips:${format}`,
            layout: backend.createPipelineLayout({ label: 'mips', bindGroupLayouts: [layout] }),
            vertex: { module, entryPoint: 'vs_main' },
            fragment: { module, entryPoint: 'fs_main', targets: [{ format }] },
            primitive: { topology: 'triangle-list' },
        });
        return { gpu, layout };
    };

    /** @type {Map<string, any>} */
    const mipSamplers = new Map();

    /**
     * A draw counts for the occlusion query open where it stands: a query of
     * the frame's set around it alone, whose samples go to that query's count
     * once the set comes back. A draw past the set's last query is not
     * counted, and that is reported.
     *
     * @param {any} pass
     * @returns {number | null} the slot the draw counts in
     */
    const beginCounting = pass=>{
        if (!countingQuery || !frameOcclusion)
        {
            return null;
        }
        const slot = pass.beginOcclusionQuery();
        if (slot === null && divergence && !occlusionOverflowReported)
        {
            occlusionOverflowReported = true;
            divergence('Direct3D', 'a frame with more draws inside occlusion queries than'
                + ' WebGPU counts in one frame: the draws past them are not counted');
        }
        return slot;
    };
    /** @param {any} pass @param {number | null} slot */
    const endCounting = (pass, slot)=>{
        const occlusion = frameOcclusion;
        if (slot === null || !occlusion)
        {
            return;
        }
        pass.endOcclusionQuery();
        occlusion.slots[slot] = countingQuery;
        if (!occlusion.touched.has(countingQuery))
        {
            occlusion.touched.add(countingQuery);
            countingQuery.outstanding++;
        }
    };
    let occlusionOverflowReported = false;

    /**
     * Every level of a texture below the top, each from the one above it, in
     * the frame where the draw that samples them stands.
     *
     * @param {any} frame @param {any} pipeline @param {any} command
     */
    function replayMips(frame, pipeline, command){
        const record = command.record;
        const filter = command.linear ? 'linear' : 'nearest';
        let sampler = mipSamplers.get(filter);
        if (!sampler)
        {
            if (!createSampler)
            {
                throw new Error('graphics/d3d8: levels are made through a sampler, and this'
                    + ' renderer was given no way to make one');
            }
            sampler = createSampler({
                label: `mips:${filter}`, magFilter: filter, minFilter: filter,
                addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge',
            });
            mipSamplers.set(filter, sampler);
        }
        for (let face = 0; face < record.faces; face++)
        {
            for (let level = 1; level < record.gpuLevels; level++)
            {
                const pass = frame.beginPass({
                    target: levelSurfaceOf(record, level, face),
                    clear: false,
                    label: `mips:${record.id}:${face}:${level}`,
                });
                pass.setPipeline(pipeline.gpu);
                pass.setBindings(0, pipeline.layout, [
                    { binding: 0, resource: levelSurfaceOf(record, level - 1, face).view },
                    { binding: 1, resource: sampler },
                ]);
                pass.draw(3);
            }
        }
    }

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
     * @param {boolean} [scissored]
     *     False for a draw that sets its own scissor -- a partial clear, cut to
     *     its area already.
     * @param {number} [bias]
     *     The vertices stream zero's offset was folded into the first vertex as.
     */
    const record = (model, prepared, geometry, scissored = true, bias = 0)=>{
        if (maxDraws >= 0 && kept >= maxDraws)
        {
            return;
        }
        const streams = streamBindings(model,
            prepared.layout?.streams ?? prepared.program?.source?.layout?.streams,
            bias);
        if (!streams)
        {
            skip('stream');
            return;
        }
        const instances = geometry.indices ? instancesOf(model) : 1;
        if (instances === 0)
        {
            skip('instancing');
            if (divergence && !instancingReported)
            {
                instancingReported = true;
                divergence('Direct3D 9', 'an instanced draw with a stream stepping once every'
                    + ' several instances is not drawn: a vertex buffer steps every instance');
            }
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
        if (scissored)
        {
            ensureScissor(model, frame);
        }
        if (staleMips.size > 0)
        {
            regenerateSampled(frame, prepared);
        }
        // A shader draw's preparation is its own, and the pipeline is its
        // pieces': asked for once per recording, as a fixed-function one is.
        const holder = prepared.program?.held ?? prepared;
        if (holder.pipelineFrame !== frame)
        {
            holder.pipelineIndex = frame.pipelines.length;
            holder.pipelineFrame = frame;
            frame.pipelines.push(prepared.program
                ? programs.get(prepared.state, prepared.program.source)
                : backend.pipelineFor(prepared.state));
        }
        prepared.pipelineIndex = holder.pipelineIndex;
        const command = {
            kind: 'draw',
            pipeline: prepared.pipelineIndex,
            state: prepared.state,
            uniforms: prepared.uniforms,
            stageBindings: prepared.stageBindings,
            program: prepared.program,
            ...geometry,
        };
        if (streams.length !== 0)
        {
            command.streams = streams;
        }
        if (instances !== 1)
        {
            command.instances = instances;
        }
        frame.commands.push(command);
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
     * @property {readonly Light[] | null} [packedLights]
     *     The lights the template's rows hold, as `enabledLights` listed them.
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
     * @type {Map<number, PreparedDraw>}
     */
    const preparedCache = new Map();
    const PREPARED_CACHE_LIMIT = 64;

    /**
     * The entries a fixed-function draw binds its group with, made once for
     * the stage bindings of a preparation: the uniform block at binding zero,
     * which the caller writes before each draw, and each stage's view and
     * sampler after it. The group is looked up and made from them at once,
     * so a draw's block written over the last draw's is never read late.
     *
     * @param {{ view: any, sampler: any }[]} stageBindings
     * @returns {{ binding: number, resource: any }[]}
     */
    const bindingEntriesOf = stageBindings=>{
        let entries = bindingEntries.get(stageBindings);
        if (entries === undefined)
        {
            entries = [{ binding: 0, resource: null }];
            stageBindings.forEach((stage, index)=>{
                /** @type {{ binding: number, resource: any }[]} */ (entries).push(
                    { binding: 1 + index * 2, resource: stage.view },
                    { binding: 2 + index * 2, resource: stage.sampler });
            });
            bindingEntries.set(stageBindings, entries);
        }
        return entries;
    };
    /** @type {WeakMap<object, { binding: number, resource: any }[]>} */
    const bindingEntries = new WeakMap();

    /**
     * A shader stage's constant blocks as the entries of its group, each
     * given its slot in the uniform ring: one list per length, written for
     * each draw, as the group is looked up and made from them at once.
     *
     * @param {any} pass @param {Float32Array[]} blocks
     * @returns {{ binding: number, resource: any }[]}
     */
    const blockEntries = (pass, blocks)=>{
        while (blockEntryLists.length <= blocks.length)
        {
            const length = blockEntryLists.length;
            blockEntryLists.push(
                Array.from({ length }, (_, binding)=>({ binding, resource: null })));
        }
        const entries = blockEntryLists[blocks.length];
        for (let binding = 0; binding < blocks.length; binding++)
        {
            entries[binding].resource = pass.uniforms(blocks[binding]);
        }
        return entries;
    };
    /** @type {{ binding: number, resource: any }[][]} */
    const blockEntryLists = [];

    /**
     * A shader draw's samplers as the entries of its group, made once for each
     * list of bindings, which a draw that binds what the one before bound
     * shares with it.
     *
     * @param {{ view: any, sampler: any }[]} samplerBindings
     */
    const samplerEntriesOf = samplerBindings=>{
        let entries = samplerEntries.get(samplerBindings);
        if (entries === undefined)
        {
            entries = samplerBindings.flatMap((bound, index)=>[
                { binding: index * 2, resource: bound.view },
                { binding: index * 2 + 1, resource: bound.sampler },
            ]);
            samplerEntries.set(samplerBindings, entries);
        }
        return entries;
    };
    /** @type {WeakMap<object, { binding: number, resource: any }[]>} */
    const samplerEntries = new WeakMap();

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
     * material, the types of the enabled lights and the viewport, as a number:
     * equal numbers are equal values. They are laid out as doubles and
     * numbered by their bits, so a program that moves a light or changes its
     * material between draws names the state without a string built for it.
     * A program that flips a render state between draws changes none of them;
     * so, for a device that replaces these objects rather than writing into
     * them (one that offers `stateVersionBesideTextures` and `lightsVersion`),
     * the number is kept while every one of them is the same object and the
     * enabled lights are of the same types.
     *
     * What the lights hold is not in it: a light moves more often than
     * anything else here, and the shader is shaped by the types alone. Its
     * values are packed into the preparation's block by `blockFor`, as the
     * lights stand at the draw.
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
        const lights = enabledLights(model);
        if (replaces && slowHeld && slowSourcesHeld(model) && sameLightTypes(lights))
        {
            return slowNumber;
        }
        const needed = 8 + 17 * model.transforms.size + 17 + 1 + lights.length + 8;
        if (needed > slowFloats.length)
        {
            slowFloats = new Float64Array(Math.max(needed, slowFloats.length * 2));
            slowWords = new Int32Array(slowFloats.buffer);
        }
        const floats = slowFloats;
        let at = 0;
        const formats = formatsOf(model);
        floats[at++] = formatIdOf(formats.targetFormat);
        floats[at++] = formats.targetHasAlpha ? 1 : 0;
        floats[at++] = formats.depthFormat === undefined ? -1 : formatIdOf(formats.depthFormat);
        floats[at++] = surfaceIdOf(surfaceFor(model.renderTarget));
        floats[at++] = model.depthStencil ? surfaceIdOf(surfaceFor(model.depthStencil)) : -1;
        slowAt = at;
        model.transforms.forEach(putTransform);
        at = slowAt;
        const material = model.material;
        at = putColourFloats(floats, at, material.Diffuse);
        at = putColourFloats(floats, at, material.Ambient);
        at = putColourFloats(floats, at, material.Specular);
        at = putColourFloats(floats, at, material.Emissive);
        floats[at++] = material.Power;
        floats[at++] = lights.length;
        for (let index = 0; index < lights.length; index++)
        {
            floats[at++] = lights[index].Type;
        }
        const viewport = model.viewport;
        floats[at++] = viewport.rect.x;
        floats[at++] = viewport.rect.y;
        floats[at++] = viewport.rect.width;
        floats[at++] = viewport.rect.height;
        floats[at++] = viewport.offset[0];
        floats[at++] = viewport.offset[1];
        floats[at++] = viewport.scale[0];
        floats[at++] = viewport.scale[1];
        slowNumber = slowNumbering(slowWords, at * 2);
        slowHeld = replaces;
        if (replaces)
        {
            holdSlowSources(model);
        }
        heldLightTypes.length = lights.length;
        for (let index = 0; index < lights.length; index++)
        {
            heldLightTypes[index] = lights[index].Type;
        }
        return slowNumber;
    };

    /** @param {Float64Array} floats @param {number} at @param {ColourValue} colour */
    const putColourFloats = (floats, at, colour)=>{
        floats[at] = colour.r;
        floats[at + 1] = colour.g;
        floats[at + 2] = colour.b;
        floats[at + 3] = colour.a;
        return at + 4;
    };

    /**
     * A transform beside the world ones into the slow state's floats, at
     * `slowAt`: a `forEach` callback made once, where `for...of` over the map
     * would make an array of every entry.
     *
     * @param {ArrayLike<number>} matrix @param {number} type
     */
    const putTransform = (matrix, type)=>{
        if (type >= D3DTS.WORLD && type <= D3DTS.WORLD_LAST)
        {
            return;
        }
        const floats = slowFloats;
        floats[slowAt++] = type;
        for (let index = 0; index < 16; index++)
        {
            floats[slowAt++] = matrix[index];
        }
    };

    /**
     * Whether the objects the slow state was last numbered from are the
     * model's still: its targets, material and viewport, and each transform
     * beside the world ones, in the map's order.
     *
     * @param {RenderModel} model
     */
    const slowSourcesHeld = model=>{
        if (model.renderTarget !== heldTarget || model.depthStencil !== heldDepth
            || model.material !== heldMaterial || model.viewport !== heldViewport)
        {
            return false;
        }
        slowAt = 0;
        slowMatch = true;
        model.transforms.forEach(matchTransform);
        return slowMatch && slowAt === heldTransforms.length;
    };

    /** @param {ArrayLike<number>} matrix @param {number} type */
    const matchTransform = (matrix, type)=>{
        if (type >= D3DTS.WORLD && type <= D3DTS.WORLD_LAST)
        {
            return;
        }
        if (heldTransforms[slowAt] !== type || heldTransforms[slowAt + 1] !== matrix)
        {
            slowMatch = false;
        }
        slowAt += 2;
    };

    /** @param {RenderModel} model */
    const holdSlowSources = model=>{
        heldTarget = model.renderTarget;
        heldDepth = model.depthStencil;
        heldMaterial = model.material;
        heldViewport = model.viewport;
        heldTransforms.length = 0;
        model.transforms.forEach(holdTransform);
    };

    /** @param {ArrayLike<number>} matrix @param {number} type */
    const holdTransform = (matrix, type)=>{
        if (type < D3DTS.WORLD || type > D3DTS.WORLD_LAST)
        {
            heldTransforms.push(type, matrix);
        }
    };

    /** @param {readonly Light[]} lights */
    const sameLightTypes = lights=>{
        if (lights.length !== heldLightTypes.length)
        {
            return false;
        }
        for (let index = 0; index < lights.length; index++)
        {
            if (lights[index].Type !== heldLightTypes[index])
            {
                return false;
            }
        }
        return true;
    };

    /** @param {string} format */
    const formatIdOf = format=>{
        let id = formatIds.get(format);
        if (id === undefined)
        {
            id = formatIds.size;
            formatIds.set(format, id);
        }
        return id;
    };

    const slowNumbering = createNumbering();
    let slowFloats = new Float64Array(256);
    let slowWords = new Int32Array(slowFloats.buffer);
    /** Where `putTransform` writes next, and where `matchTransform` reads. */
    let slowAt = 0;
    let slowMatch = false;
    let slowNumber = -1;
    let slowHeld = false;
    /** @type {unknown} */
    let heldTarget = null;
    /** @type {unknown} */
    let heldDepth = null;
    /** @type {unknown} */
    let heldMaterial = null;
    /** @type {unknown} */
    let heldViewport = null;
    /** Type then matrix, for each transform beside the world ones. @type {unknown[]} */
    const heldTransforms = [];
    /** @type {number[]} */
    const heldLightTypes = [];
    /** @type {Map<string, number>} */
    const formatIds = new Map();

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
     * The render and stage states are laid out as words and numbered with no
     * string built: a program that flips one render state between draws names
     * a state on every draw. Texture bindings and the draw's own shape are not
     * in it: see `preparationKeyOf`, which adds them.
     *
     * @param {RenderModel} model
     * @param {{ fvf: number, fixedFunctionLayout?: { id: number, streams?: number[] } | null }}
     *     processing
     * @returns {number}
     */
    const stateNumberOf = (model, processing)=>{
        const streams = processing.fixedFunctionLayout?.streams ?? NO_STREAMS;
        // Sized once for the words below, so that writing them tests nothing.
        let needed = 4 + streams.length + 2 * model.renderStates.size;
        for (let stage = 0; stage < STAGE_COUNT; stage++)
        {
            needed += 1 + 2 * model.stageStates(stage).size;
        }
        if (needed > stateScratch.length)
        {
            stateScratch = new Int32Array(Math.max(needed, stateScratch.length * 2));
        }
        const words = stateScratch;
        let at = 0;
        words[at++] = slowStateOf(model);
        words[at++] = processing.fvf;
        // A declaration read without a format is told apart by its own id,
        // and by the strides its further streams are bound at.
        words[at++] = processing.fixedFunctionLayout?.id ?? 0;
        for (let index = 0; index < streams.length; index++)
        {
            words[at++] = strideOf(model, streams[index]);
        }
        words[at++] = model.renderStates.size;
        stateAt = at;
        // Through `forEach` with a callback made once rather than `for...of`,
        // which makes an array of each entry, and a state has some hundreds.
        model.renderStates.forEach(putEntry);
        for (let stage = 0; stage < STAGE_COUNT; stage++)
        {
            const states = model.stageStates(stage);
            stateScratch[stateAt++] = states.size;
            states.forEach(putEntry);
        }
        return stateNumbering(stateScratch, stateAt);
    };

    /** @param {number} value @param {number} state */
    const putEntry = (value, state)=>{
        stateScratch[stateAt++] = state;
        stateScratch[stateAt++] = value;
    };

    /** @type {readonly number[]} */
    const NO_STREAMS = Object.freeze([]);
    let stateScratch = new Int32Array(2048);
    /** Where `putEntry` writes next. */
    let stateAt = 0;
    const stateNumbering = createNumbering();
    let stateKey = -1;
    /** @type {number | undefined} */
    let stateKeyVersion;

    /**
     * The whole key, as a number numbered like the state's: the state beside
     * textures, kept while `stateVersionBesideTextures` holds still -- a
     * program that binds a new texture before most draws changes nothing else
     * between them -- then the draw's own shape and every stage's texture with
     * the generation of its bytes, which change without the device hearing of
     * it.
     *
     * @param {RenderModel} model
     * @param {{ fvf: number, fixedFunctionLayout?: { id: number, streams?: number[] } | null }}
     *     processing
     * @param {number} stride
     * @param {string} topology
     * @returns {number}
     */
    const preparationKeyOf = (model, processing, stride, topology)=>{
        const version = model.stateVersionBesideTextures;
        if (version === undefined || version !== stateKeyVersion)
        {
            stateKey = stateNumberOf(model, processing);
            stateKeyVersion = version;
        }
        const words = keyWords;
        let at = 0;
        words[at++] = stateKey;
        words[at++] = stride;
        words[at++] = topologyIdOf(topology);
        for (let stage = 0; stage < STAGE_COUNT; stage++)
        {
            const texture = model.textures.get(stage);
            const held = texture ? textures.get(texture) : null;
            words[at++] = held ? held.serial : -1;
            words[at++] = held ? held.soil : 0;
            // A managed texture's level of detail is sampled by, and set on
            // the texture where no state counter sees it.
            words[at++] = lodOf(texture);
            // A Direct3D 7 texture's colour key is set on the surface and
            // shapes the shader, and no state counter sees it change.
            if (texture?.colorKey)
            {
                const colorKey = texture.colorKey();
                words[at++] = colorKey === null ? 1 : 2;
                words[at++] = colorKey ?? 0;
            }
            else
            {
                words[at++] = 0;
                words[at++] = 0;
            }
        }
        return keyNumbering(words, at);
    };

    const keyWords = new Int32Array(3 + STAGE_COUNT * 5);
    const keyNumbering = createNumbering();
    /** @type {Map<string, number>} */
    const topologyIds = new Map();
    /** @param {string} topology */
    const topologyIdOf = topology=>{
        let id = topologyIds.get(topology);
        if (id === undefined)
        {
            id = topologyIds.size;
            topologyIds.set(topology, id);
        }
        return id;
    };

    /**
     * This draw's uniform block: the prepared state's block with the fields
     * the world transform reaches written over it, and the lights as they
     * stand, which the state's number leaves out.
     *
     * World then view, its product with the projection and the two normal
     * matrices are formed again only when a matrix they come from holds other
     * bits than the one they were last formed from: a program draws a model
     * in several state changes under one world, and the view and projection
     * hold still for a frame.
     *
     * @param {RenderModel} model
     * @param {PreparedDraw} prepared
     * @returns {Float32Array}
     */
    const blockFor = (model, prepared)=>{
        const template = /** @type {Float32Array} */ (prepared.template);
        if (prepared.lighting)
        {
            const lights = enabledLights(model);
            if (lights !== prepared.packedLights)
            {
                for (let index = 0; index < lights.length; index++)
                {
                    packLight(template, UNIFORM_AT.lights + index * LIGHT_FLOATS, lights[index]);
                }
                prepared.packedLights = lights;
            }
        }
        const block = ensureFrame().arena.take(template.length);
        block.set(template);
        const world = transformOf(model, D3DTS.WORLD);
        const worldMoved = !sameBits(world, formedWorld);
        if (worldMoved || !sameBits(transformOf(model, D3DTS.VIEW), formedView))
        {
            formedWorld.set(world);
            formedView.set(transformOf(model, D3DTS.VIEW));
            multiplyMatrices(formedWorld, formedView, formedWorldView);
            formedProjection.set(transformOf(model, D3DTS.PROJECTION));
            multiplyMatrices(formedWorldView, formedProjection, formedWorldViewProjection);
            normalFormed = worldMoved ? false : normalFormed;
            cameraNormalFormed = false;
        }
        else if (!sameBits(transformOf(model, D3DTS.PROJECTION), formedProjection))
        {
            formedProjection.set(transformOf(model, D3DTS.PROJECTION));
            multiplyMatrices(formedWorldView, formedProjection, formedWorldViewProjection);
        }
        block.set(formedWorldViewProjection, UNIFORM_AT.worldViewProjection);
        block.set(formedWorld, UNIFORM_AT.world);
        // World then view too: vertex fog's depth and a generated coordinate's
        // camera space move with the model as its position does, and a lit
        // normal with the model's own transform.
        block.set(formedWorldView, UNIFORM_AT.worldView);
        if (prepared.lighting)
        {
            if (!normalFormed)
            {
                normalMatrixOf(formedWorld, formedNormal);
                normalFormed = true;
            }
            block.set(formedNormal, UNIFORM_AT.normalMatrix);
        }
        if (readsNormalAnywhere(prepared.state.stages))
        {
            if (!cameraNormalFormed)
            {
                normalMatrixOf(formedWorldView, formedCameraNormal);
                cameraNormalFormed = true;
            }
            block.set(formedCameraNormal, UNIFORM_AT.cameraNormalMatrix);
        }
        return block;
    };

    /**
     * What `blockFor` last formed its matrices from, and what it formed. The
     * copies start as not-a-number, which no matrix compares equal to.
     */
    const formedWorld = new Float32Array(16).fill(NaN);
    const formedView = new Float32Array(16).fill(NaN);
    const formedProjection = new Float32Array(16).fill(NaN);
    const formedWorldView = new Float32Array(16);
    const formedWorldViewProjection = new Float32Array(16);
    const formedNormal = new Float32Array(16);
    const formedCameraNormal = new Float32Array(16);
    let normalFormed = false;
    let cameraNormalFormed = false;

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
     * Direct3D 7 colour keying: with D3DRENDERSTATE_COLORKEYENABLE on, a
     * stage sampling a texture that has a source colour key is keyed by it
     * (Wine's ddraw7 test_ck_default). The key is the texel it names,
     * expanded as the upload expands the texture, so the shader compares like
     * with like; a compressed or unexpandable format is left unkeyed.
     *
     * @param {RenderModel} model
     * @param {{ stages: import('../webgpu/internal/pipeline.js').StageKey[],
     *     textures: (any | null)[] }} cascade
     */
    const keyStages = (model, cascade)=>{
        if ((model.renderStates.get(D3DRENDERSTATE_COLORKEYENABLE) ?? 0) === 0)
        {
            return;
        }
        cascade.textures.forEach((texture, index)=>{
            const raw = texture?.colorKey?.() ?? null;
            const held = texture ? textures.get(texture) : undefined;
            const info = held ? FORMAT_INFO[held.format] : undefined;
            if (raw === null || !held || !info || !TEXEL_EXPANSION[held.format])
            {
                return;
            }
            const bytes = new Uint8Array(new Uint32Array([raw >>> 0]).buffer)
                .subarray(0, info.bytesPerPixel);
            const texel = expandTexels(held.format, bytes, 1);
            cascade.stages[index] = {
                ...cascade.stages[index],
                colorKey: (texel[2] << 16) | (texel[1] << 8) | texel[0],
            };
        });
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
                ? layoutOfDeclaration(processing.fixedFunctionLayout, stride, model)
                : null;
            if (!declared)
            {
                skip('layout');
                reportLayout();
                return null;
            }
            layout = declared;
            vertexLayoutKey = `d${stride}:${declared.attributes
                .map(attribute=>`${attribute.name}@${attribute.stream ?? 0}.${attribute.offset}`
                    + `:${attribute.format}`)
                .join(',')}${streamsKey(declared)}`;
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
        keyStages(model, cascade);
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
                texture,
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
            packedLights: lighting ? enabledLights(model) : null,
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
     * @param {number} [fill]  D3DFILL; SOLID rewrites a strip or fan as a list.
     */
    const expandedGeometry = (type, indices, baseVertex, fill = D3DFILL.SOLID)=>{
        const expanded = fill === D3DFILL.SOLID
            ? listIndices(type, indices)
            : filledIndices(type, indices, fill);
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

    /**
     * Whether a draw from vertices in order is rewritten as a list: a fan
     * always, and a strip under flat shading, whose odd triangles WebGPU
     * would otherwise take their colours from the wrong vertex -- its strip
     * reorders them to keep the winding, and the first vertex is the one flat
     * interpolation reads.
     *
     * @param {RenderModel} model @param {number} type
     */
    const listed = (model, type)=>type === D3DPT.TRIANGLEFAN
        || (type === D3DPT.TRIANGLESTRIP && isFlatShaded(model));

    /**
     * The fill mode a draw's triangles are drawn under; anything that is not
     * a triangle is SOLID, as D3DRS_FILLMODE leaves it. WebGPU cannot cull a
     * line or a point, so a culled wireframe also draws its back faces'
     * edges, where Direct3D culls the triangle before it is turned to lines.
     *
     * @param {RenderModel} model @param {number} type
     */
    const fillOf = (model, type)=>{
        if (type !== D3DPT.TRIANGLELIST && type !== D3DPT.TRIANGLESTRIP
            && type !== D3DPT.TRIANGLEFAN)
        {
            return D3DFILL.SOLID;
        }
        const fill = model.renderStates.get(D3DRS.FILLMODE) ?? D3DFILL.SOLID;
        return fill === D3DFILL.POINT || fill === D3DFILL.WIREFRAME ? fill : D3DFILL.SOLID;
    };

    /** @type {Readonly<Record<number, string>>} the topology a fill mode draws triangles as */
    const FILLED = Object.freeze({
        [D3DFILL.POINT]: 'point-list',
        [D3DFILL.WIREFRAME]: 'line-list',
    });

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
         *           usage?: number, depth?: number, gpuLevels?: number }} desc
         *        `depth` is a volume's; `gpuLevels` more than `levels` for a
         *        texture whose lower levels the device makes.
         */
        trackTexture(texture, desc){
            const levels = desc.levels ?? 1;
            // A cube map's six faces are six layers of one texture; a face's
            // level is a subresource numbered face * levels + level.
            const faces = texture.cube === true ? 6 : 1;
            // The GPU's copy of a texture that makes its own levels holds the
            // whole chain, of which the program sees the top.
            const gpuLevels = desc.gpuLevels ?? levels;
            const entry = {
                gpu: null, dirty: true, base: 0, levels, faces, texture, gpuLevels,
                autogen: gpuLevels > levels,
                volume: texture.volume === true,
                // A render-target texture is written by the GPU as well as
                // by the guest, so its uploads have to keep their place in
                // the frame; see `uploadTexels`. A copy landing in a plain
                // texture turns this on too.
                // So is one whose levels the GPU makes from the top.
                ordered: ((desc.usage ?? 0) & D3DUSAGE.RENDERTARGET) !== 0 || gpuLevels > levels,
                // Every level, until each has been uploaded once: a program
                // fills the chain it asked for, and a chain sampled with a
                // level missing shows the gap at the distance that level
                // covers.
                dirtyLevels: new Set(Array.from({ length: levels * faces }, (_, index)=>index)),
                serial: nextTextureId,
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
            const surfaceLevel = texture.GetSurfaceLevel;
            /**
             * Whether an unlock leaves the GPU's copy as it is: a managed
             * texture's does after a read-only lock or one that asked for no
             * dirty update, until AddDirtyRect says otherwise (Wine's d3d8 and
             * d3d9 add_dirty_rect_test). Any other pool's lock writes the
             * texture it draws from.
             *
             * @param {any} surface  A level's surface, or a volume texture's level.
             */
            const keepsCopy = surface=>texture.pool === D3DPOOL.MANAGED
                && ((surface?.lockFlags ?? 0) & (D3DLOCK.READONLY | D3DLOCK_NO_DIRTY_UPDATE)) !== 0;
            if (texture.volume === true)
            {
                trackVolumeLevels(texture, entry, soiled, keepsCopy);
                return;
            }
            const unlockLevel = texture.UnlockRect;
            texture.UnlockRect = (/** @type {number} */ level)=>{
                /** @type {{ surface?: any }} */
                const held = {};
                const keeps = texture.pool === D3DPOOL.MANAGED
                    && surfaceLevel(level, held) === D3D_OK && keepsCopy(held.surface);
                held.surface?.release();
                const hr = unlockLevel(level);
                if (hr === D3D_OK && !keeps)
                {
                    soiled(level);
                }
                return hr;
            };
            const addDirtyRect = texture.AddDirtyRect;
            if (typeof addDirtyRect === 'function')
            {
                texture.AddDirtyRect = (/** @type {any} */ rect, /** @type {number} */ face = 0)=>{
                    const hr = addDirtyRect(rect, face);
                    if (hr === D3D_OK)
                    {
                        for (let level = 0; level < levels; level++)
                        {
                            soiled(face * levels + level);
                        }
                    }
                    return hr;
                };
            }
            const cubeSurface = texture.GetCubeMapSurface;
            const unlockCube = texture.UnlockCubeRect;
            if (faces === 6)
            {
                texture.UnlockCubeRect = (/** @type {number} */ face, /** @type {number} */ level)=>{
                    /** @type {{ surface?: any }} */
                    const held = {};
                    const keeps = texture.pool === D3DPOOL.MANAGED
                        && cubeSurface(face, level, held) === D3D_OK && keepsCopy(held.surface);
                    held.surface?.release();
                    const hr = unlockCube(face, level);
                    if (hr === D3D_OK && !keeps)
                    {
                        soiled(face * levels + level);
                    }
                    return hr;
                };
            }
            // Each level's storage is reachable through the level's own
            // surface too -- one object however many times it is asked for --
            // and a copy names that rather than the texture it belongs to. The
            // surfaces are made on demand, so each is taken into care as it is
            // first handed out.
            const hooked = new WeakSet();
            /** @param {any} surface @param {number} face @param {number} level */
            const hook = (surface, face, level)=>{
                if (!surface || hooked.has(surface))
                {
                    return;
                }
                hooked.add(surface);
                textures.set(surface, entry);
                surfaceLevels.set(surface, level);
                surfaceFaces.set(surface, face);
                const unlockSurface = surface.UnlockRect;
                surface.UnlockRect = ()=>{
                    const keeps = keepsCopy(surface);
                    const unlocked = unlockSurface();
                    if (unlocked === D3D_OK && !keeps)
                    {
                        soiled(face * levels + level);
                    }
                    return unlocked;
                };
            };
            texture.GetSurfaceLevel = (/** @type {number} */ level, /** @type {any} */ out)=>{
                const hr = surfaceLevel(level, out);
                hook(hr === D3D_OK ? out.surface : null, 0, level);
                return hr;
            };
            if (faces === 6)
            {
                /** @param {number} face @param {number} level @param {any} out */
                texture.GetCubeMapSurface = (face, level, out)=>{
                    const hr = cubeSurface(face, level, out);
                    hook(hr === D3D_OK ? out.surface : null, face, level);
                    return hr;
                };
            }
            if (entry.autogen)
            {
                texture.GenerateMipSubLevels = ()=>markMips(entry);
            }
            // A level of detail changes how the texture is sampled, which the
            // prepared state of the draw in hand holds: it is prepared again.
            const setLod = texture.SetLOD;
            if (typeof setLod === 'function')
            {
                texture.SetLOD = (/** @type {number} */ lod)=>{
                    const was = setLod(lod);
                    if (texture.GetLOD() !== was)
                    {
                        contentVersion++;
                    }
                    return was;
                };
            }
            /** @type {{ surface?: any }} */
            const top = {};
            if ((faces === 6 ? texture.GetCubeMapSurface(0, 0, top)
                : texture.GetSurfaceLevel(0, top)) === D3D_OK)
            {
                top.surface.release();
                entry.base = top.surface.base;
            }
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
                tracked.dirtyLevels.add((surfaceFaces.get(resource) ?? 0) * tracked.levels
                    + (surfaceLevels.get(resource) ?? 0));
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
                if ((surfaceLevels.get(destination) ?? 0) === 0)
                {
                    markMips(tracked);
                }
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
         * What has been recorded so far goes to the GPU with nothing shown:
         * the frame of a swap chain whose picture has nowhere to go is still
         * drawn, into targets that later draws and reads find as it left them.
         */
        /**
         * An occlusion query, as the device keeps it: the count its last
         * BEGIN opened, and the one its last END closed.
         *
         * @returns {{ open: any, latest: any }}
         */
        createOcclusionQuery(){
            return { open: null, latest: null };
        },

        /**
         * Counts the samples of every draw from here to the query's END,
         * in this frame's order; a BEGIN while it counts starts again.
         *
         * @param {{ open: any, latest: any }} query
         */
        beginOcclusion(query){
            query.open = occlusionCount();
            ensureFrame().commands.push({ kind: 'occlusion', count: query.open, begin: true });
        },

        /** @param {{ open: any, latest: any }} query */
        endOcclusion(query){
            const count = query.open ?? occlusionCount();
            query.open = null;
            query.latest = count;
            const frame = ensureFrame();
            count.recording = frame;
            frame.commands.push({ kind: 'occlusion', count, begin: false });
        },

        /**
         * Where a query's answer stands: counting still, never asked, done,
         * or on its way. Flushing sends the frame its END was recorded in to
         * the GPU, which is what has to happen before it can come back.
         *
         * @param {{ open: any, latest: any }} query
         * @param {boolean} flush
         * @returns {{ state: 'building' | 'none' } | { state: 'done', value: number }
         *     | { state: 'pending', settled: Promise<number> }}
         */
        occlusionResult(query, flush){
            if (query.open)
            {
                return { state: 'building' };
            }
            const count = query.latest;
            if (!count)
            {
                return { state: 'none' };
            }
            if (count.value !== null)
            {
                return { state: 'done', value: count.value };
            }
            if (flush && recording && count.recording === recording)
            {
                this.submit();
            }
            return { state: 'pending', settled: count.settled };
        },

        /** @returns {Promise<void>} settled when this frame has been submitted */
        submit(){
            const recorded = ensureFrame();
            recording = null;
            recorded.dump = dump;
            dump = [];
            kept = 0;
            chain = chain.then(()=>replay(recorded, null)).catch(failure);
            return chain;
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
                }, false);
            }
            frame.commands.push({ kind: 'scissor', rect: {
                x: rect.x, y: rect.y, width: rect.width, height: rect.height,
            } });
            frame.scissor = '';
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
            const fill = fillOf(model, type);
            const rewrite = fill !== D3DFILL.SOLID || listed(model, type);
            const prepared = prepare(model, stream.stride,
                FILLED[fill] ?? (rewrite ? LIST_OF[type] : TOPOLOGY[type]));
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
                ...(rewrite
                    ? expandedGeometry(type, ascending(count), startVertex, fill)
                    : { indices: null, count, first: startVertex }),
            }, true, streamZeroBias(model));
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
            const fill = fillOf(model, type);
            // A list drawn solid binds the program's own indices; anything
            // else is rewritten from them.
            const list = fill === D3DFILL.SOLID ? LIST_OF[type] : FILLED[fill];
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
                }, true, streamZeroBias(model));
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
                ...expandedGeometry(type, order, model.baseVertexIndex, fill),
            }, true, streamZeroBias(model));
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
            const fill = fillOf(model, type);
            const rewrite = fill !== D3DFILL.SOLID || listed(model, type);
            const topology = FILLED[fill] ?? (rewrite ? LIST_OF[type] : TOPOLOGY[type]);
            const prepared = prepare(model, stride, topology);
            if (!prepared)
            {
                return;
            }
            const vertices = scratchVertices.write(vertexData.subarray(0, count * stride));
            const geometry = rewrite
                ? expandedGeometry(type, ascending(count), 0, fill)
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
            const fill = fillOf(model, type);
            const list = fill === D3DFILL.SOLID ? LIST_OF[type] : FILLED[fill];
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
                    : expandedGeometry(type, indices, 0, fill)),
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
            front = surface;
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
         * The picture the last present showed, for GetFrontBuffer: the
         * surface it handed over, read once its frame has reached the queue
         * and before a later one has. The draws recorded since are replayed
         * at the next present, so they are not in it -- unless a read-back of
         * a target (`readSurface`) replayed them early. Four bytes a pixel,
         * blue first; null when nothing was presented.
         *
         * @param {any} [surface]
         *        A d3d8 surface to read in place of what the display shows: a
         *        back buffer a swap chain presented and the display did not.
         * @returns {Promise<{ width: number, height: number, data: Uint8Array } | null>}
         */
        readFront(surface){
            const asked = surface ? surfaceFor(surface) : null;
            const read = chain.then(()=>{
                const shown = asked ?? front;
                if (!shown)
                {
                    return null;
                }
                const frame = backend.beginFrame();
                const reader = frame.snapshot(shown);
                frame.end();
                return reader();
            });
            chain = read.then(()=>undefined, failure);
            return read;
        },

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
                if (front === made)
                {
                    front = null;
                }
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
                mipsGenerated: counters.mipsGenerated,
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
        // A frame counts when a query is open as it starts or opens in it,
        // and then every pass of it can: a BEGIN may land in any of them.
        const counts = countingQuery !== null
            || recorded.commands.some((/** @type {any} */ command)=>command.kind === 'occlusion');
        /** @type {{ slots: any[], touched: Set<any> } | null} */
        const occlusion = counts ? { slots: [], touched: new Set() } : null;
        frameOcclusion = occlusion;
        /** @type {(() => Promise<number[]>) | null} */
        let counted = null;
        /** @type {any[]} */
        const checks = [];
        /** @type {(() => Promise<Uint8Array[]>) | null} */
        let read = null;
        /** @type {(() => Promise<any>) | null} */
        let shot = null;
        try
        {
            replayInto(frame, pipelines, recorded, surface);
            if (occlusion && occlusion.touched.size > 0)
            {
                counted = frame.occlusionResults();
            }
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
        if (counted && occlusion)
        {
            // Not waited for: the next frame replays while these come back,
            // and a count is settled once every frame it counted in has.
            const { slots, touched } = occlusion;
            counted().then(samples=>{
                samples.forEach((value, slot)=>{
                    if (slots[slot])
                    {
                        slots[slot].total += value;
                    }
                });
                for (const count of touched)
                {
                    count.outstanding--;
                    if (count.ended && count.outstanding === 0)
                    {
                        settleOcclusion(count);
                    }
                }
            }).catch(failure);
        }
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
        pass.setBindings(0, pipeline.bindGroupLayouts[0],
            blockEntries(pass, program.vertexBlocks));
        pass.setBindings(1, pipeline.bindGroupLayouts[1],
            blockEntries(pass, program.pixelBlocks));
        pass.setBindings(2, pipeline.bindGroupLayouts[2],
            samplerEntriesOf(program.samplerBindings));
        pass.setVertexBuffer(0, command.vertices.gpu, command.vertices.offset);
        bindStreams(pass, command);
        const slot = beginCounting(pass);
        if (command.indices)
        {
            pass.setIndexBuffer(command.indices.gpu, command.indices.format,
                command.indices.offset);
            pass.drawIndexed(command.count, command.instances ?? 1, command.first,
                command.baseVertex);
        }
        else
        {
            pass.draw(command.count, 1, command.first);
        }
        endCounting(pass, slot);
        counters.draws++;
        counters.programmable++;
    }

    /**
     * @param {any} frame @param {any[]} pipelines
     * @param {any} recorded @param {any} surface
     */
    function replayInto(frame, pipelines, recorded, surface){
        /**
         * A pass for the frame's draws, one its draws can count in when the
         * frame counts.
         *
         * @param {any} descriptor
         */
        const countingPass = descriptor=>frame.beginPass(frameOcclusion
            ? { ...descriptor, occlusion: true }
            : descriptor);
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
            pass = countingPass({
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
            if (command.kind === 'occlusion')
            {
                if (command.begin)
                {
                    countingQuery = command.count;
                }
                else
                {
                    if (countingQuery === command.count)
                    {
                        countingQuery = null;
                    }
                    command.count.ended = true;
                    if (command.count.outstanding === 0)
                    {
                        settleOcclusion(command.count);
                    }
                }
                continue;
            }
            if (command.kind === 'pass')
            {
                opened = command;
                pass = countingPass({
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
                    ...(command.layer ? { origin: { x: 0, y: 0, z: command.layer } } : {}),
                    ...(command.depth ? { depthOrArrayLayers: command.depth } : {}),
                });
                pass = null;
                continue;
            }
            if (command.kind === 'mips')
            {
                const made = pipelines[command.pipeline];
                if (made.status === 'rejected')
                {
                    failure(made.reason);
                }
                else
                {
                    replayMips(frame, made.value, command);
                }
                pass = null;
                continue;
            }
            if (command.kind === 'copy')
            {
                frame.copyTexture(
                    { texture: command.source.texture, mipLevel: command.source.mipLevel ?? 0,
                        origin: { ...command.sourceOrigin, z: command.source.layer ?? 0 } },
                    { texture: command.destination.texture,
                        mipLevel: command.destination.mipLevel ?? 0,
                        origin: { ...command.destinationOrigin,
                            z: command.destination.layer ?? 0 } },
                    { width: command.width, height: command.height, depthOrArrayLayers: 1 });
                pass = null;
                continue;
            }
            reopen();
            if (command.kind === 'viewport')
            {
                // Setting the viewport sets the scissor to it, so a pass
                // reopened after this must not bring back an older scissor.
                viewport = command.rect;
                scissor = null;
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
                pass = countingPass({
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
            const entries = bindingEntriesOf(command.stageBindings);
            entries[0].resource = block;
            pass.setBindings(0, pipeline.bindGroupLayout, entries);
            pass.setVertexBuffer(0, command.vertices.gpu, command.vertices.offset);
            bindStreams(pass, command);
            const slot = beginCounting(pass);
            if (command.indices)
            {
                pass.setIndexBuffer(command.indices.gpu, command.indices.format,
                    command.indices.offset);
                pass.drawIndexed(command.count, command.instances ?? 1, command.first,
                    command.baseVertex);
            }
            else
            {
                pass.draw(command.count, 1, command.first);
            }
            endCounting(pass, slot);
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
                bindStreams(pass, command);
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
                    bindStreams(pass, command);
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
                pass = countingPass({
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
