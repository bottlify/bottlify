/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The programmable pipeline: a translated vertex and pixel shader, a vertex
 * layout taken from a declaration rather than a format, and the constant
 * files each stage reads.
 *
 * What is decided here and nowhere else:
 *
 * - **A declaration element becomes a vertex attribute** at the location the
 *   translated shader expects it, in the WebGPU format its type is, and the
 *   shader is told the element's shape so it can promote it. The two are
 *   decided together because they have to agree: an attribute delivered as
 *   four unsigned bytes must be read as `vec4<u32>`, or the pipeline fails
 *   to build and the draw silently disappears.
 * - **The vertex stride is the stream's, not the declaration's.** A program
 *   binds a stream at a stride the declaration only has to fit inside, and
 *   an attribute reaching past the stride is refused by the GPU.
 * - **The bind group layouts are fixed by the translation's contract**, so a
 *   pipeline is built once per shader pair and layout, and every draw binds
 *   its blocks into the same groups.
 */

import { createBuildLog, pipelineDescriptor, pipelineKey, vertexBuffersOf } from './pipeline.js';
import { VERTEX_SAMPLER_BINDING } from '../../d3d9/wgsl.js';

/**
 * D3DDECLTYPE → the WebGPU vertex format, and the shape the shader reads.
 *
 * Two types have no WebGPU counterpart -- the packed ten-bit triples -- and
 * are absent, which refuses a declaration that uses them rather than reading
 * it as something else.
 *
 * @type {Readonly<Record<number, { format: string, components: number,
 *     scalar: 'f32' | 'u32' | 'i32', bgra: boolean, bytes: number }>>}
 */
export const DECLTYPE_ATTRIBUTE = Object.freeze({
    0: { format: 'float32', components: 1, scalar: 'f32', bgra: false, bytes: 4 },
    1: { format: 'float32x2', components: 2, scalar: 'f32', bgra: false, bytes: 8 },
    2: { format: 'float32x3', components: 3, scalar: 'f32', bgra: false, bytes: 12 },
    3: { format: 'float32x4', components: 4, scalar: 'f32', bgra: false, bytes: 16 },
    // A colour is one DWORD of B,G,R,A bytes; the shader puts them back.
    4: { format: 'unorm8x4', components: 4, scalar: 'f32', bgra: true, bytes: 4 },
    5: { format: 'uint8x4', components: 4, scalar: 'u32', bgra: false, bytes: 4 },
    6: { format: 'sint16x2', components: 2, scalar: 'i32', bgra: false, bytes: 4 },
    7: { format: 'sint16x4', components: 4, scalar: 'i32', bgra: false, bytes: 8 },
    8: { format: 'unorm8x4', components: 4, scalar: 'f32', bgra: false, bytes: 4 },
    9: { format: 'snorm16x2', components: 2, scalar: 'f32', bgra: false, bytes: 4 },
    10: { format: 'snorm16x4', components: 4, scalar: 'f32', bgra: false, bytes: 8 },
    11: { format: 'unorm16x2', components: 2, scalar: 'f32', bgra: false, bytes: 4 },
    12: { format: 'unorm16x4', components: 4, scalar: 'f32', bgra: false, bytes: 8 },
    15: { format: 'float16x2', components: 2, scalar: 'f32', bgra: false, bytes: 4 },
    16: { format: 'float16x4', components: 4, scalar: 'f32', bgra: false, bytes: 8 },
});

/**
 * @typedef {Object} VertexElement
 *     One element of a vertex declaration, as the device holds it.
 * @property {number} Stream
 * @property {number} Offset
 * @property {number} Type
 * @property {number} Usage
 * @property {number} UsageIndex
 */

/**
 * @typedef {Object} DeclaredInput
 *     One element the shader wants, and where it is to arrive.
 * @property {number} location
 * @property {number} usage
 * @property {number} usageIndex
 * @property {number} register
 */

/**
 * @typedef {Object} VertexInputLayout
 * @property {number} stride  Stream zero's.
 * @property {{ shaderLocation: number, offset: number, format: string,
 *     stream?: number }[]} attributes
 * @property {{ stream: number, stride: number }[]} [streams]
 *     The further streams read, each a vertex buffer after stream zero's.
 * @property {Map<number, { components: number, scalar: 'f32' | 'u32' | 'i32', bgra: boolean }>}
 *           shapes   By register, for the inputs the declaration supplies.
 */

/**
 * The vertex layout a declaration gives the inputs a shader declares.
 *
 * Each element is read from its own stream, a vertex buffer per stream at the
 * stride that stream is bound with. An input the declaration has no element
 * for is left out, and the shader reads it as the default vertex; an element
 * of a type WebGPU cannot deliver, or past its stream's stride, refuses the
 * whole layout.
 *
 * @param {readonly VertexElement[]} elements
 * @param {readonly DeclaredInput[]} wanted
 * @param {number} stride  Stream zero's.
 * @param {(stream: number) => number} [strideOf]
 *     A further stream's stride; zero reads every vertex from its start.
 * @returns {{ layout: VertexInputLayout | null, error: string | null }}
 */
export function vertexLayoutOf(elements, wanted, stride, strideOf = ()=>0){
    /** @type {VertexInputLayout} */
    const layout = { stride, attributes: [], shapes: new Map() };
    /** @type {Map<number, number>} */
    const streams = new Map();
    for (const input of wanted)
    {
        const element = elements.find(one=>
            one.Usage === input.usage && one.UsageIndex === input.usageIndex);
        if (!element)
        {
            continue;
        }
        const attribute = DECLTYPE_ATTRIBUTE[element.Type];
        if (!attribute)
        {
            return { layout: null, error: `element type ${element.Type}` };
        }
        const own = element.Stream === 0 ? stride : strideOf(element.Stream);
        if (element.Stream !== 0)
        {
            streams.set(element.Stream, own);
        }
        if (own !== 0 && element.Offset + attribute.bytes > own)
        {
            return { layout: null, error: `element past the stride of ${own}` };
        }
        layout.attributes.push({
            shaderLocation: input.location, offset: element.Offset, format: attribute.format,
            ...(element.Stream === 0 ? {} : { stream: element.Stream }),
        });
        layout.shapes.set(input.register, {
            components: attribute.components, scalar: attribute.scalar, bgra: attribute.bgra,
        });
    }
    if (streams.size > 0)
    {
        layout.streams = [...streams.entries()]
            .sort(([left], [right])=>left - right)
            .map(([stream, own])=>({ stream, stride: own }));
    }
    return { layout, error: null };
}

/**
 * A string that names the shapes a layout supplies, for caching a translation
 * that depends on them.
 *
 * @param {VertexInputLayout} layout
 */
export function shapeKey(layout){
    return [...layout.shapes.entries()]
        .sort((left, right)=>left[0] - right[0])
        .map(([register, shape])=>
            `${register}:${shape.components}${shape.scalar}${shape.bgra ? 'b' : ''}`)
        .join(',');
}

/**
 * The three uniform blocks a stage's constant file becomes: the floats the
 * shader reaches, all sixteen integer registers, and the sixteen booleans
 * packed four to a vector. Each is taken from the frame's arena, so a draw's
 * constants stay what they were when it was recorded.
 *
 * The float block is as long as the shader declares, which may run past the
 * file -- the register a vertex shader's viewport scale rides in does -- and
 * reads as zero there until the caller fills it: a block shorter than the
 * declaration fails the binding.
 *
 * The integer and boolean blocks are kept (`kept`) while the registers hold
 * the same values in one arena: the same block for the next draw, which a
 * program that sets them once a frame, or never, draws every draw with, and
 * which the uniform ring then lays once (`createUniformPool`). The registers
 * are compared with a copy of what the kept block was made of, eighty words,
 * rather than trusted to a count of writes every writer would have to raise.
 *
 * @param {{ floats: Float32Array, ints: Int32Array, bools: Uint32Array,
 *     intBits?: Float32Array, boolBits?: Float32Array }} file
 * @param {number} reach   Float registers the shader declares.
 * @param {(floats: number) => Float32Array} take
 * @param {KeptBlocks} [kept]  the stage's
 * @param {number} [serial]  the arena's (`createUniformArena`): a block
 *     outlives none of its resets, and is never another arena's
 * @returns {Float32Array[]}
 */
export function constantBlocks(file, reach, take, kept, serial = -1){
    const count = Math.max(1, reach);
    const floats = take(count * 4);
    // A draw sets two stages' blocks: the file whole where it fits, rather
    // than a view of it made to say so.
    floats.set(count * 4 >= file.floats.length
        ? file.floats
        : file.floats.subarray(0, count * 4));
    if (kept === undefined || serial < 0 || file.ints.length !== 64 || file.bools.length !== 16)
    {
        return [floats, intsBlock(file, take), boolsBlock(file, take)];
    }
    const fresh = kept.serial !== serial;
    if (fresh || kept.ints === null || !sameWords(kept.intsMade, file.ints))
    {
        kept.ints = intsBlock(file, take);
        kept.intsMade.set(file.ints);
    }
    if (fresh || kept.bools === null || !sameWords(kept.boolsMade, file.bools))
    {
        kept.bools = boolsBlock(file, take);
        kept.boolsMade.set(file.bools);
    }
    kept.serial = serial;
    return [floats, kept.ints, kept.bools];
}

/**
 * @param {Int32Array | Uint32Array} made @param {Int32Array | Uint32Array} now
 */
const sameWords = (made, now)=>{
    for (let index = 0; index < made.length; index++)
    {
        if (made[index] !== now[index])
        {
            return false;
        }
    }
    return true;
};

/**
 * A stage's integer and boolean blocks, kept by `constantBlocks` while the
 * registers hold the values they were made of.
 *
 * @typedef {Object} KeptBlocks
 * @property {number} serial
 * @property {Float32Array | null} ints
 * @property {Int32Array} intsMade
 * @property {Float32Array | null} bools
 * @property {Uint32Array} boolsMade
 */

/** @returns {KeptBlocks} */
export const keptBlocks = ()=>({ serial: -1, ints: null, intsMade: new Int32Array(64),
    bools: null, boolsMade: new Uint32Array(16) });

/**
 * All sixteen integer registers as a block of floats, the same bits.
 *
 * @param {{ ints: Int32Array, intBits?: Float32Array }} file
 * @param {(floats: number) => Float32Array} take
 */
function intsBlock(file, take){
    const ints = take(16 * 4);
    if (file.intBits !== undefined && file.intBits.length === 64)
    {
        ints.set(file.intBits);
        return ints;
    }
    new Int32Array(ints.buffer, ints.byteOffset, ints.length)
        .set(file.ints.length === 64 ? file.ints : file.ints.subarray(0, 64));
    return ints;
}

/**
 * The sixteen booleans, one to a float, the same bits.
 *
 * @param {{ bools: Uint32Array, boolBits?: Float32Array }} file
 * @param {(floats: number) => Float32Array} take
 */
function boolsBlock(file, take){
    const bools = take(16);
    if (file.boolBits !== undefined && file.boolBits.length === 16)
    {
        bools.set(file.boolBits);
        return bools;
    }
    new Uint32Array(bools.buffer, bools.byteOffset, bools.length)
        .set(file.bools.length === 16 ? file.bools : file.bools.subarray(0, 16));
    return bools;
}

/**
 * The view a sampler declared as `type` binds: a WGSL texture type, or the
 * fixed stage's own '2d', 'cube' or '3d'.
 *
 * @param {string} type
 * @returns {string}
 */
export function samplerDimension(type){
    if (type === 'texture_cube<f32>' || type === 'cube')
    {
        return 'cube';
    }
    return type === 'texture_3d<f32>' || type === '3d' ? '3d' : '2d';
}

/** GPUShaderStage bits. */
const VERTEX_STAGE = 1;
const FRAGMENT_STAGE = 2;

/**
 * Builds and caches programmable pipelines through the backend's own entry
 * points.
 *
 * @param {Object} options
 * @param {any} options.backend
 * @returns {{ get: (state: import('./pipeline.js').PipelineState, program: ProgramSource)
 *             => Promise<any>, stats: () => { built: number, reused: number,
 *             buildMs: number, latest: string[], churn: any[] } }}
 */
export function createProgramCache({ backend }){
    /** @type {Map<string, Promise<any>>} */
    const pipelines = new Map();
    /**
     * The samplers' dimensions -> the three group layouts and the pipeline layout.
     *
     * @type {Map<string, any>}
     */
    const layouts = new Map();
    let built = 0;
    const log = createBuildLog();
    let reused = 0;

    /**
     * @param {readonly string[]} dimensions  Each pixel sampler's: '2d', 'cube' or '3d'.
     * @param {readonly string[]} [vertexDimensions]  Each vertex sampler's, bound
     *     from VERTEX_SAMPLER_BINDING on.
     */
    const layoutsFor = (dimensions, vertexDimensions = [])=>{
        const key = vertexDimensions.length > 0
            ? `${dimensions.join(',')}|v${vertexDimensions.join(',')}` : dimensions.join(',');
        const samplerCount = dimensions.length;
        const existing = layouts.get(key);
        if (existing)
        {
            return existing;
        }
        /** @param {number} visibility */
        const constants = visibility=>backend.createBindGroupLayout({
            label: `constants:${visibility}`,
            entries: [0, 1, 2].map(binding=>({
                binding, visibility, buffer: { type: 'uniform', hasDynamicOffset: true },
            })),
        });
        /** @type {any[]} */
        const samplerEntries = [];
        for (let index = 0; index < samplerCount; index++)
        {
            samplerEntries.push({ binding: index * 2, visibility: FRAGMENT_STAGE,
                texture: dimensions[index] === '2d' ? {} : { viewDimension: dimensions[index] } });
            samplerEntries.push(
                { binding: index * 2 + 1, visibility: FRAGMENT_STAGE, sampler: {} });
        }
        vertexDimensions.forEach((dimension, index)=>{
            // A vertex texture is read at a level, never filtered between texels'
            // derivatives, so it binds as a plain sampled texture like the rest.
            samplerEntries.push({ binding: VERTEX_SAMPLER_BINDING + index * 2,
                visibility: VERTEX_STAGE,
                texture: dimension === '2d' ? {} : { viewDimension: dimension } });
            samplerEntries.push({ binding: VERTEX_SAMPLER_BINDING + index * 2 + 1,
                visibility: VERTEX_STAGE, sampler: {} });
        });
        const groups = [
            constants(VERTEX_STAGE),
            constants(FRAGMENT_STAGE),
            backend.createBindGroupLayout(
                { label: `samplers:${key}`, entries: samplerEntries }),
        ];
        const made = {
            groups,
            pipeline: backend.createPipelineLayout({
                label: `programmable:${key}`,
                bindGroupLayouts: groups,
            }),
        };
        layouts.set(key, made);
        return made;
    };

    return {
        /**
         * @param {import('./pipeline.js').PipelineState} state
         * @param {ProgramSource} program
         */
        get(state, program){
            const key = `${pipelineKey(state)}|${program.key}`;
            const existing = pipelines.get(key);
            if (existing)
            {
                reused++;
                return existing;
            }
            built++;
            const building = (async()=>{
                const [vertexModule, pixelModule] = await Promise.all([
                    backend.createShaderModule(
                        { code: program.vertex.wgsl, label: `vs:${program.key}` }),
                    backend.createShaderModule(
                        { code: program.pixel.wgsl, label: `ps:${program.key}` }),
                ]);
                const descriptor = pipelineDescriptor(state, null);
                const bound = layoutsFor(program.pixel.samplers.map(
                    (/** @type {{ type: string }} */ entry)=>samplerDimension(entry.type)),
                (program.vertex.samplers ?? []).map(
                    (/** @type {{ type: string }} */ entry)=>samplerDimension(entry.type)));
                return {
                    bindGroupLayouts: bound.groups,
                    gpu: await backend.createRenderPipelineAsync({
                        label: `programmable:${program.key}`,
                        layout: bound.pipeline,
                        vertex: {
                            module: vertexModule,
                            entryPoint: program.vertex.entry,
                            buffers: vertexBuffersOf(program.layout.stride,
                                program.layout.attributes, program.layout.streams,
                                Boolean(state.points)),
                        },
                        fragment: {
                            module: pixelModule,
                            entryPoint: program.pixel.entry,
                            targets: [descriptor.target],
                        },
                        primitive: descriptor.primitive,
                        depthStencil: descriptor.depthStencil,
                        multisample: descriptor.multisample,
                    }),
                };
            })();
            log.built(key, building);
            pipelines.set(key, building);
            return building;
        },
        stats: ()=>({ built, reused, ...log.stats() }),
    };
}

/**
 * @typedef {Object} ProgramSource
 *     What a programmable pipeline is built from.
 * @property {string} key   Names the shader pair and the layout, for the cache.
 * @property {{ wgsl: string, entry: string, samplers?: { index: number, type: string }[] }} vertex
 * @property {{ wgsl: string, entry: string, samplers: { index: number, type: string }[] }} pixel
 * @property {VertexInputLayout} layout
 */
