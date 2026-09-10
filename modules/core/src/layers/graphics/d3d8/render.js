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
    D3DBLEND, D3DCLEAR, D3DCMP, D3DCULL, D3DFMT, D3DFMT_INDEX, D3DFOG, D3DLOCK, D3DPT, D3DRS,
    COLORWRITEENABLE_ALPHA, COORD_SET_MASK, D3DTA, D3DTADDRESS, D3DTEXF, D3DTOP, D3DTS, D3DTSS,
    D3DZB, D3D_OK, FORMAT_INFO, argumentsRead, dwordToFloat,
} from './constants.js';
import { FVF, decodeFvf } from '../webgpu/internal/vertexformat.js';
import { resourceId } from '../webgpu/internal/bindings.js';

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

/** The matrix elements a two-dimensional texture coordinate passes through. */
const PLANAR_ROWS = Object.freeze([0, 1, 4, 5, 12, 13]);

/** What those elements hold when the transform moves nothing. */
const PLANAR_IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

/** D3DTTFF_COUNT2: two coordinates through the matrix, and no projection. */
const TTFF_COUNT2 = 2;

/** Textures whose texels a dumping run keeps. Enough to find one, not a heap dump. */
const TEXTURE_DUMP_LIMIT = 24;

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
 * @param {ScreenDraw} draw
 * @returns {{ points: number[][], behind: number }}
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
            if (!(clip[3] > 0))
            {
                behind++;
                continue;
            }
            x = rect.x + (clip[0] / clip[3] * 0.5 + 0.5) * rect.width;
            y = rect.y + (0.5 - clip[1] / clip[3] * 0.5) * rect.height;
        }
        // The vertex it came from rides along: a caller matching a corner
        // against what the vertex carried there cannot recover it otherwise,
        // because vertices behind the eye leave no gap in this list.
        points.push([x, y, at]);
    }
    return { points, behind };
}

/**
 * The box those positions span, in whole pixels.
 *
 * @param {ScreenDraw} draw
 * @returns {{ x0: number, y0: number, x1: number, y1: number, behind: number }
 *           | null}
 */
export function screenExtent(draw){
    const { points, behind } = screenPositions(draw);
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

/** The WebGPU format every colour target and texture is. */
export const COLOR_FORMAT = 'bgra8unorm';

/** @type {Readonly<Record<number, string>>} */
const DEPTH_FORMAT = Object.freeze({
    [D3DFMT.D16]: 'depth16unorm',
    [D3DFMT.D24X8]: 'depth24plus',
    [D3DFMT.D24S8]: 'depth24plus-stencil8',
    [D3DFMT.D32]: 'depth32float',
});

/**
 * @param {number} format  D3DFMT
 * @returns {string} the WebGPU format a surface of it is created as
 */
export function gpuFormatOf(format){
    const info = FORMAT_INFO[format];
    if (!info)
    {
        throw new Error(`Surface format ${format} has no backend counterpart`);
    }
    if (!info.depth)
    {
        return COLOR_FORMAT;
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
 * f32, and then the lights, which start at the next multiple of four floats
 * because a uniform array is aligned to sixteen bytes. A field written at the
 * wrong index is read as a different one, and every one of them is a plausible
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
    lights: 76,
});

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
 * @property {Material} material
 * @property {any} backBuffer                                What Present shows.
 * @property {{ vertexShader: number, fvf: number, pixelShader: number }} stageProcessing
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
 * @returns {Float32Array} the block an ordinary draw carries
 */
export function uniformsOf(model, lighting, take){
    const rs = (/** @type {string} */ name)=>model.renderStates.get(D3DRS[name]) ?? 0;
    const world = transformOf(model, D3DTS.WORLD);
    const view = transformOf(model, D3DTS.VIEW);
    return uniformBlock({
        worldViewProjection: multiplyMatrices(
            multiplyMatrices(world, view, WORLD_VIEW), transformOf(model, D3DTS.PROJECTION),
            WORLD_VIEW_PROJECTION),
        world,
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
        material: model.material,
        ambient: rs('AMBIENT'),
        eye: eyePosition(view),
        // The shader declares an array exactly as long as the lighting state
        // said, so a block that carried lights it does not know about would be
        // read past its own end.
        lights: lighting ? enabledLights(model) : [],
    }, take);
}

/** Scratch for the two products every draw forms; copied into the block at once. */
const WORLD_VIEW = new Float32Array(16);
const WORLD_VIEW_PROJECTION = new Float32Array(16);

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
        const key = {
            colorOp,
            colorArg1: get(D3DTSS.COLORARG1),
            colorArg2: get(D3DTSS.COLORARG2),
            alphaOp: get(D3DTSS.ALPHAOP),
            alphaArg1: get(D3DTSS.ALPHAARG1),
            alphaArg2: get(D3DTSS.ALPHAARG2),
            texCoordIndex: get(D3DTSS.TEXCOORDINDEX),
        };
        const selectors = [
            ...argumentsRead(key.colorOp, key.colorArg1, key.colorArg2),
            ...argumentsRead(key.alphaOp, key.alphaArg1, key.alphaArg2),
        ];
        const samples = selectors.some(arg=>(arg & D3DTA_SELECTMASK) === D3DTA.TEXTURE);
        const texture = model.textures.get(stage) ?? null;
        const coordSet = key.texCoordIndex & COORD_SET_MASK;
        if (samples && (!texture || coordSet >= layout.texCoordSets))
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
 * The render state of a draw, as the pipeline cache keys it.
 *
 * The two paired blend modes are expanded here: they set both factors from one
 * value, and the pipeline table refuses them by name rather than guessing.
 *
 * @param {RenderModel} model
 * @param {Object} shape
 * @param {number} shape.fvf
 * @param {string} shape.topology
 * @param {string} shape.targetFormat
 * @param {boolean} [shape.targetHasAlpha]
 *     Whether the target's Direct3D format has an alpha channel at all.
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
    const fogMode = rs('FOGENABLE') !== 0
        ? (rs('FOGTABLEMODE') || rs('FOGVERTEXMODE'))
        : D3DFOG.NONE;

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
 * @returns {{ magFilter: string, minFilter: string, mipmapFilter: string,
 *             addressModeU: string, addressModeV: string }}
 */
export function samplerDescriptorOf(states){
    const get = (/** @type {number} */ state)=>states.get(state) ?? 0;
    return {
        magFilter: FILTER[get(D3DTSS.MAGFILTER)] ?? 'nearest',
        minFilter: FILTER[get(D3DTSS.MINFILTER)] ?? 'nearest',
        // Surfaces are created with one level, so there is nothing to filter between.
        mipmapFilter: 'nearest',
        addressModeU: ADDRESS[get(D3DTSS.ADDRESSU)] ?? 'repeat',
        addressModeV: ADDRESS[get(D3DTSS.ADDRESSV)] ?? 'repeat',
    };
}

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
 * @property {string | null} [skipTexture]
 *     Drop every draw that samples the texture with this dump id. A draw's
 *     position in a frame moves between runs and its bound texture does not,
 *     so this is what lets the same draw be removed from two runs and the
 *     frames compared -- which is the only way to see what one draw paints.
 */

/**
 * @param {RendererOptions} options
 * @returns {any}
 */
export function createRenderer(options){
    const { backend, readMemory } = options;
    const createSampler = options.createSampler ?? null;
    const dumpDraws = options.dumpDraws === true;
    const maxDraws = options.maxDraws === undefined ? -1 : options.maxDraws;
    const divergence = options.divergence ?? null;
    const skipTexture = options.skipTexture ?? null;
    const { LockFlags, BufferUsage, TextureUsage } = backend;

    /** @type {WeakMap<object, any>} d3d8 surface -> backend surface */
    const surfaces = new WeakMap();
    /** @type {WeakMap<object, any>} d3d8 buffer -> { gpu, held } */
    const buffers = new WeakMap();
    /** @type {WeakMap<object, any>} d3d8 texture -> { gpu, dirty, ... } */
    const textures = new WeakMap();
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
        },
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
            ? `${entry.id}:${entry.format}@${entry.width}x${entry.height}${entry.census ?? ''}`
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
     * @param {RenderModel} model
     * @param {any} layout
     * @param {import('../webgpu/internal/pipeline.js').LightingState | null} lighting
     */
    const countLighting = (model, layout, lighting)=>{
        const tally = counters.lighting;
        const fogMode = (model.renderStates.get(D3DRS.FOGENABLE) ?? 0) !== 0
            ? ((model.renderStates.get(D3DRS.FOGTABLEMODE) ?? 0)
                || (model.renderStates.get(D3DRS.FOGVERTEXMODE) ?? 0))
            : 0;
        if (fogMode !== 0)
        {
            tally.fog.modes.add(fogMode);
            tally.fog[layout.preTransformed ? 'preTransformed' : 'transformed']++;
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
            : 'nowhere';
        // A draw of a handful of quads has its own corners, and the union of
        // them is not one of them: an artefact bounded by one quad of six is
        // invisible in the box and obvious in the list.
        const drawn = indices ? indices.length : Math.floor(vertices.byteLength / stride);
        const texCoord = prepared.layout.attributes.find(
            (/** @type {any} */ entry)=>entry.name === 'texCoord0');
        const view = new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength);
        const corners = box && drawn <= 64
            ? ` at=${[...new Set(screenPositions(geometry).points.map(point=>
                `${Math.round(point[0])},${Math.round(point[1])}`
                + (texCoord
                    ? `@${round(view.getFloat32(point[2] + texCoord.offset, true))}`
                        + `,${round(view.getFloat32(point[2] + texCoord.offset + 4, true))}`
                    : '')))].join(' ')}`
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
        dump.push(`#${dump.length} ${where}`
            + ` fvf=0x${state.fvf.toString(16)} n=${drawn}`
            + ` lit=${state.lighting ? state.lighting.lights.length : '-'}`
            + ` fog=${state.fogMode} spec=${state.specularEnable ? 1 : 0}`
            + ` z=${state.depthTest ? state.depthFunc : '-'}/${state.depthWrite ? 1 : 0}`
            + ` cull=${state.cullMode}`
            + ` blend=${state.blend ? `${state.srcBlend},${state.destBlend}` : '-'}`
            + ` aTest=${state.alphaTest
                ? `${state.alphaFunc}/${model.renderStates.get(D3DRS.ALPHAREF) ?? 0}`
                : '-'}`
            + ` ${transparencyOf(model, prepared, vertices, stride, indices)}`
            + ` sampler=${Object.values(samplerDescriptorOf(model.stageStates(0))).join(',')}`
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
     * The texture transform a stage asks for, which this engine accepts and
     * does not apply. A program that scrolls, scales or projects a coordinate
     * set through D3DTS_TEXTURE0 gets the untransformed coordinate instead --
     * a sprite sampled over the wrong part of its own texture, with every
     * other piece of state around it reading correct. So the flags and the
     * matrix are printed whenever either is set, and nothing at all when the
     * stage genuinely wants the coordinate as it lies.
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
        // The rows a two-dimensional texture coordinate actually travels
        // through: the two it is scaled and sheared by, and the one it is
        // offset by. The rest of the matrix cannot reach it.
        return `${flags}:${(matrix ? PLANAR_ROWS.map(at=>matrix[at]) : PLANAR_IDENTITY)
            .map(round).join(',')}`;
    };

    /**
     * Whether a stage's transform would move a coordinate at all.
     *
     * A program that asks for two-dimensional coordinates through an identity
     * matrix -- which is the common case, and what a fixed-function pipeline
     * does by default once the flag is set -- gets the same texel either way,
     * so calling that a divergence would put a warning on every frame of every
     * title and say nothing.
     *
     * @param {RenderModel} model @param {number} stage
     */
    const transformMoves = (model, stage)=>{
        const flags = model.stageStates(stage)?.get(D3DTSS.TEXTURETRANSFORMFLAGS) ?? 0;
        if (flags === 0)
        {
            return false;
        }
        if (flags !== TTFF_COUNT2)
        {
            // Three or four coordinates, or a projected divide: none of which
            // this engine does, whatever the matrix holds.
            return true;
        }
        const matrix = model.transforms.get(D3DTS.TEXTURE0 + stage);
        return matrix !== undefined
            && PLANAR_ROWS.some((at, index)=>matrix[at] !== PLANAR_IDENTITY[index]);
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
        dumpDraw(model, prepared,
            wanted > 0 ? readMemory(stream.buffer.base + skipped, wanted) : new Uint8Array(0),
            stream.stride, order);
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
        if (stages.some(stage=>(stage.texCoordIndex & ~COORD_SET_MASK) !== 0))
        {
            divergence('Direct3D 8',
                'texture coordinate generation is accepted and not applied'
                + ' (D3DTSS_TEXCOORDINDEX, D3DTSS_TCI_*): the set named in the low'
                + ' bits is sampled as the vertex carries it');
        }
    };

    /**
     * Says once that a stage asked for a texture transform and did not get one.
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
                    'a texture transform is accepted and not applied'
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

    /** @param {any} surface a d3d8 surface */
    const surfaceFor = surface=>{
        const existing = surfaces.get(surface);
        if (existing)
        {
            return existing;
        }
        const desc = describe(surface);
        const format = gpuFormatOf(desc.Format);
        const made = backend.createSurface({
            width: desc.Width,
            height: desc.Height,
            format,
            label: FORMAT_INFO[desc.Format].depth ? 'depth' : 'target',
            usage: FORMAT_INFO[desc.Format].depth ? TextureUsage.RENDER_ATTACHMENT : undefined,
        });
        surfaces.set(surface, made);
        return made;
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
                usage: (index ? BufferUsage.INDEX : BufferUsage.VERTEX) | BufferUsage.COPY_DST,
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
        BufferUsage.VERTEX | BufferUsage.COPY_DST, 1 << 20);
    const scratchIndices = ring('scratch-indices',
        BufferUsage.INDEX | BufferUsage.COPY_DST, 1 << 18);

    /** @param {Map<number, number>} states */
    const samplerFor = states=>{
        const descriptor = samplerDescriptorOf(states);
        const key = Object.values(descriptor).join('|');
        const existing = samplers.get(key);
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
                format: COLOR_FORMAT,
                label: 'texture',
                // A dumping run reads these back to compare what the device
                // holds against what was handed to it, which is the one link
                // in the upload that reading the source cannot check.
                usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST
                    | (dumpDraws ? TextureUsage.COPY_SRC : 0),
            });
        }
        if (record.dirty)
        {
            const count = record.width * record.height;
            const bytes = readMemory(record.base, count * FORMAT_INFO[record.format].bytesPerPixel);
            const texels = expandTexels(record.format, bytes, count);
            backend.uploadTexture({
                texture: record.gpu.texture,
                format: COLOR_FORMAT,
                width: record.width,
                height: record.height,
                data: texels,
            });
            if (dumpDraws)
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
            record.dirty = false;
        }
        return record.gpu;
    };

    // --- recording ---

    /** Arenas of frames already replayed, for the next recording to take. @type {any[]} */
    const arenas = [];
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
     * @param {RenderModel} model
     * @param {{ clearColor?: any, clearDepth?: number, clearStencil?: number }} clearing
     */
    const beginPass = (model, clearing)=>{
        const frame = ensureFrame();
        const target = surfaceFor(model.renderTarget);
        const depth = model.depthStencil ? surfaceFor(model.depthStencil) : null;
        frame.commands.push({ kind: 'pass', target, depth, ...clearing });
        frame.pass = { target, depth };
        frame.viewport = null;
    };

    /** @param {RenderModel} model */
    const ensurePass = model=>{
        const frame = ensureFrame();
        const target = surfaceFor(model.renderTarget);
        const depth = model.depthStencil ? surfaceFor(model.depthStencil) : null;
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

    /**
     * Records one draw against the pass the model's targets name.
     *
     * @param {RenderModel} model
     * @param {import('../webgpu/internal/pipeline.js').PipelineState} state
     * @param {Float32Array} uniforms
     * @param {{ view: any, sampler: any }[]} stageBindings
     * @param {any} geometry
     */
    const record = (model, state, uniforms, stageBindings, geometry)=>{
        if (maxDraws >= 0 && kept >= maxDraws)
        {
            return;
        }
        kept++;
        const frame = ensureViewport(model);
        const pipeline = frame.pipelines.length;
        frame.pipelines.push(backend.pipelineFor(state));
        frame.commands.push(
            { kind: 'draw', pipeline, state, uniforms, stageBindings, ...geometry });
    };

    /**
     * Everything a fixed-function draw needs that is not its geometry, or null
     * when the draw cannot be rendered by what exists -- counted, not raised,
     * because the program has already been told the call succeeded.
     *
     * @param {RenderModel} model
     * @param {number} stride
     * @param {string} topology
     */
    const prepare = (model, stride, topology)=>{
        const processing = model.stageProcessing;
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
        const layout = decodeFvf(processing.fvf);
        if (stride !== layout.stride)
        {
            skip('stride');
            return null;
        }
        const cascade = stageCascade(model, layout);
        reportCascade(cascade);
        if (skipTexture !== null && cascade.textures.some(
            texture=>texture && textures.get(texture)?.id === skipTexture))
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
        countLighting(model, layout, lighting);
        const state = pipelineStateOf(model, {
            fvf: processing.fvf,
            topology,
            ...formatsOf(model),
            stages: cascade.stages,
            lighting,
        });
        // `layout` and `textures` are the frame dump's, and are handed back
        // rather than worked out again there: both are already in hand and
        // neither can be recovered from the recorded command.
        return {
            state, uniforms: uniformsOf(model, lighting, ensureFrame().arena.take), stageBindings,
            layout, textures: cascade.textures, truncated: cascade.truncated,
        };
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
            held.data.set(readMemory(buffer.base + held.offset, held.length));
            entry.gpu.unlock(held);
            entry.held = null;
        },

        /**
         * Takes a texture the device created into the renderer's care: from
         * now on an unlock of its top level marks it for upload before the
         * next draw that samples it.
         *
         * @param {any} texture
         * @param {{ width: number, height: number, format: number }} desc
         */
        trackTexture(texture, desc){
            /** @type {{ surface?: any }} */
            const top = {};
            texture.GetSurfaceLevel(0, top);
            top.surface.release();
            const entry = {
                gpu: null, dirty: true, base: top.surface.base,
                id: `t${nextTextureId++}`, ...desc,
            };
            textures.set(texture, entry);
            // Reachable by the level's surface as well, because a copy names
            // that rather than the texture it belongs to.
            textures.set(top.surface, entry);

            const unlockLevel = texture.UnlockRect;
            texture.UnlockRect = (/** @type {number} */ level)=>{
                const hr = unlockLevel(level);
                if (hr === D3D_OK && level === 0)
                {
                    entry.dirty = true;
                }
                return hr;
            };
            // The same storage is reachable through the level's own surface,
            // which is one object however many times it is asked for.
            const unlockSurface = top.surface.UnlockRect;
            top.surface.UnlockRect = ()=>{
                const hr = unlockSurface();
                if (hr === D3D_OK)
                {
                    entry.dirty = true;
                }
                return hr;
            };
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
                tracked.dirty = true;
            }
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
            const uniforms = uniformBlock({
                worldViewProjection: IDENTITY,
                viewport: model.viewport,
                textureFactor: 0,
                fogColor: 0,
                alphaRef: 0,
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
                record(model, state, uniforms, [], {
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
            record(model, prepared.state, prepared.uniforms, prepared.stageBindings, {
                vertices: { gpu: bufferFor(stream.buffer).gpu.gpu, offset: 0 },
                ...(fan
                    ? expandedGeometry(type, ascending(count), startVertex)
                    : { indices: null, count, first: startVertex }),
            });
            if (dumpDraws)
            {
                dumpDraw(model, prepared,
                    readMemory(stream.buffer.base + startVertex * stream.stride,
                        count * stream.stride),
                    stream.stride, null);
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
            const vertices = { gpu: bufferFor(stream.buffer).gpu.gpu, offset: 0 };
            if (list === undefined)
            {
                record(model, prepared.state, prepared.uniforms, prepared.stageBindings, {
                    vertices,
                    indices: {
                        gpu: bufferFor(model.indices).gpu.gpu,
                        offset: byteOffset,
                        format: format.gpu,
                    },
                    count,
                    first: 0,
                    baseVertex: model.baseVertexIndex,
                });
                if (dumpDraws)
                {
                    dumpIndexed(model, prepared, indicesFrom(
                        readMemory(model.indices.base + byteOffset, count * format.bytes),
                        format.bytes));
                }
                return;
            }
            // The strip's order is in guest memory, where the program left it.
            const order = indicesFrom(
                readMemory(model.indices.base + byteOffset, count * format.bytes), format.bytes);
            record(model, prepared.state, prepared.uniforms, prepared.stageBindings, {
                vertices,
                ...expandedGeometry(type, order, model.baseVertexIndex),
            });
            if (dumpDraws)
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
            record(model, prepared.state, prepared.uniforms, prepared.stageBindings,
                { vertices, ...geometry });
            if (dumpDraws)
            {
                dumpDraw(model, prepared, vertexData.subarray(0, count * stride), stride, null);
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
            record(model, prepared.state, prepared.uniforms, prepared.stageBindings, {
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
            if (dumpDraws)
            {
                dumpDraw(model, prepared, vertexData.subarray(0, numVertices * stride),
                    stride, indices);
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
            const recorded = ensureFrame();
            recording = null;
            lastDump = dump;
            dump = [];
            kept = 0;
            const surface = surfaceFor(model.backBuffer);
            counters.frames++;
            chain = chain.then(()=>replay(recorded, surface)).catch(failure);
            return chain;
        },

        /** @returns {Promise<void>} settled when every presented frame has been submitted */
        idle: ()=>chain,

        diagnostics(){
            return {
                frames: counters.frames,
                draws: counters.draws,
                clears: counters.clears,
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
                // What the last frame was made of, for a test that wants to
                // evaluate the same draws on the processor.
                lastFrame,
                // Empty unless the build asked for it; see `dumpDraws`.
                lastDump,
                textures: [...uploaded.values()],
            };
        },
    };

    /**
     * @param {any} recorded
     * @param {any} surface what to present
     */
    async function replay(recorded, surface){
        const pipelines = await Promise.allSettled(recorded.pipelines);
        const frame = backend.beginFrame();
        try
        {
            replayInto(frame, pipelines, recorded, surface);
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
    }

    /**
     * @param {any} frame @param {any[]} pipelines
     * @param {any} recorded @param {any} surface
     */
    function replayInto(frame, pipelines, recorded, surface){
        /** @type {any} */
        let pass = null;
        for (const command of recorded.commands)
        {
            if (command.kind === 'pass')
            {
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
            if (command.kind === 'viewport')
            {
                pass.setViewport(command.rect);
                continue;
            }
            if (command.kind === 'scissor')
            {
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
            pass.setPipeline(pipeline.gpu);
            const entries = [{ binding: 0, resource: pass.uniforms(command.uniforms) }];
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
        }
        frame.present(surface);
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
