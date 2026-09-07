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
    D3DTA, D3DTADDRESS, D3DTEXF, D3DTOP, D3DTS, D3DTSS, D3DZB, D3D_OK, FORMAT_INFO,
} from './constants.js';
import { FVF, decodeFvf } from '../webgpu/internal/vertexformat.js';

/** A stage state's DWORD, as the D3D8 header lays it out. */
const D3DTA_SELECTMASK = D3DTA.SELECTMASK;

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
 * @returns {Float32Array}
 */
export function multiplyMatrices(a, b){
    const out = new Float32Array(16);
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
 * The uniform block the generated shader declares, laid out as WGSL lays it
 * out: a mat4x4f, two vec2f, three vec4f and an f32, padded to 16 bytes.
 */
export const UNIFORM_FLOATS = 36;

/**
 * @param {Object} values
 * @param {ArrayLike<number>} values.worldViewProjection
 * @param {import('../webgpu/contract.js').ViewportState} values.viewport
 * @param {number} values.textureFactor  D3DCOLOR
 * @param {number} values.fogColor       D3DCOLOR
 * @param {number} values.alphaRef       0..255
 * @returns {Float32Array}
 */
export function uniformBlock(values){
    const block = new Float32Array(UNIFORM_FLOATS);
    block.set(values.worldViewProjection, 0);
    block.set(values.viewport.offset, 16);
    block.set(values.viewport.scale, 18);
    const factor = colorToFloats(values.textureFactor);
    block.set([factor.r, factor.g, factor.b, factor.a], 20);
    const fog = colorToFloats(values.fogColor);
    block.set([fog.r, fog.g, fog.b, fog.a], 24);
    // The generated shader mixes by a constant amount; one is "no fog", and
    // there is no distance for it to attenuate by yet.
    block.set([1, 0, 0, 0], 28);
    block[32] = values.alphaRef / 255;
    return block;
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
 * @param {RenderModel} model
 * @returns {Float32Array} the block an ordinary draw carries
 */
export function uniformsOf(model){
    const rs = (/** @type {string} */ name)=>model.renderStates.get(D3DRS[name]) ?? 0;
    return uniformBlock({
        worldViewProjection: multiplyMatrices(
            multiplyMatrices(transformOf(model, D3DTS.WORLD), transformOf(model, D3DTS.VIEW)),
            transformOf(model, D3DTS.PROJECTION)),
        viewport: model.viewport,
        textureFactor: rs('TEXTUREFACTOR'),
        fogColor: rs('FOGCOLOR'),
        alphaRef: rs('ALPHAREF'),
    });
}

/**
 * The stage cascade a draw runs, and which texture each stage samples.
 *
 * The cascade ends at the first stage whose colour operation is off. It also
 * ends at a stage that names the texture argument with nothing bound there, or
 * with no coordinate set for it in the vertex: the generated shader would
 * otherwise sample a binding that does not exist, and a program that binds one
 * texture and leaves stage zero at its default expects that texture drawn, not
 * a refusal.
 *
 * @param {RenderModel} model
 * @param {import('../webgpu/internal/vertexformat.js').VertexLayout} layout
 * @returns {{ stages: import('../webgpu/internal/pipeline.js').StageKey[],
 *             textures: (any | null)[] }}
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
        const alphaOp = get(D3DTSS.ALPHAOP);
        const selectors = [get(D3DTSS.COLORARG1), get(D3DTSS.COLORARG2)];
        if (alphaOp !== D3DTOP.DISABLE)
        {
            selectors.push(get(D3DTSS.ALPHAARG1), get(D3DTSS.ALPHAARG2));
        }
        const samples = selectors.some(arg=>(arg & D3DTA_SELECTMASK) === D3DTA.TEXTURE);
        const texture = model.textures.get(stage) ?? null;
        if (samples && (!texture || stage >= layout.texCoordSets))
        {
            break;
        }
        stages.push({
            colorOp,
            colorArg1: get(D3DTSS.COLORARG1),
            colorArg2: get(D3DTSS.COLORARG2),
            alphaOp,
            alphaArg1: get(D3DTSS.ALPHAARG1),
            alphaArg2: get(D3DTSS.ALPHAARG2),
            texCoordIndex: get(D3DTSS.TEXCOORDINDEX),
        });
        textures.push(samples ? texture : null);
    }
    return { stages, textures };
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
 * @param {string | undefined} shape.depthFormat
 * @param {import('../webgpu/internal/pipeline.js').StageKey[]} shape.stages
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
        colorWrite: rs('COLORWRITEENABLE'),
        alphaTest: rs('ALPHATESTENABLE') !== 0,
        alphaFunc: rs('ALPHAFUNC'),
        fogMode,
        stages: shape.stages,
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
 */

/**
 * @param {RendererOptions} options
 * @returns {any}
 */
export function createRenderer(options){
    const { backend, readMemory } = options;
    const createSampler = options.createSampler ?? null;
    const { LockFlags, BufferUsage, TextureUsage } = backend;

    /** @type {WeakMap<object, any>} d3d8 surface -> backend surface */
    const surfaces = new WeakMap();
    /** @type {WeakMap<object, any>} d3d8 buffer -> { gpu, held } */
    const buffers = new WeakMap();
    /** @type {WeakMap<object, any>} d3d8 texture -> { gpu, dirty, ... } */
    const textures = new WeakMap();
    /** @type {Map<string, any>} */
    const samplers = new Map();
    /** @type {any} */
    let placeholder = null;

    /** @type {any} the frame being recorded, or null between frames */
    let recording = null;
    /** @type {Promise<void>} */
    let chain = Promise.resolve();
    /** @type {any[]} the commands of the frame most recently replayed */
    let lastFrame = [];

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
        },
        /** @type {string[]} */
        failures: [],
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
                usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
            });
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
                usage: TextureUsage.TEXTURE_BINDING | TextureUsage.COPY_DST,
            });
        }
        if (record.dirty)
        {
            const count = record.width * record.height;
            const bytes = readMemory(record.base, count * FORMAT_INFO[record.format].bytesPerPixel);
            backend.uploadTexture({
                texture: record.gpu.texture,
                format: COLOR_FORMAT,
                width: record.width,
                height: record.height,
                data: expandTexels(record.format, bytes, count),
            });
            record.dirty = false;
        }
        return record.gpu;
    };

    // --- recording ---

    const ensureFrame = ()=>{
        if (!recording)
        {
            recording = { commands: [], pipelines: [], pass: null, viewport: null };
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
        const stageBindings = cascade.stages.map((stage, index)=>{
            const texture = cascade.textures[index];
            return {
                view: texture ? uploadIfDirty(texture).view : placeholderView(),
                sampler: samplerFor(model.stageStates(index)),
            };
        });
        const state = pipelineStateOf(model, {
            fvf: processing.fvf,
            topology,
            ...formatsOf(model),
            stages: cascade.stages,
        });
        return { state, uniforms: uniformsOf(model), stageBindings };
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
            const entry = { gpu: null, dirty: true, base: top.surface.base, ...desc };
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
                colorWrite: (flags & D3DCLEAR.TARGET) !== 0 ? 0xf : 0,
                alphaTest: false,
                fogMode: D3DFOG.NONE,
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
                return;
            }
            // The strip's order is in guest memory, where the program left it.
            const order = indicesFrom(
                readMemory(model.indices.base + byteOffset, count * format.bytes), format.bytes);
            record(model, prepared.state, prepared.uniforms, prepared.stageBindings, {
                vertices,
                ...expandedGeometry(type, order, model.baseVertexIndex),
            });
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
                failures: [...counters.failures],
                recording: recording ? recording.commands.length : 0,
                // What the last frame was made of, for a test that wants to
                // evaluate the same draws on the processor.
                lastFrame,
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
        frame.end();
        lastFrame = recorded.commands;
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
