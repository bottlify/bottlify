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

import { pipelineDescriptor, pipelineKey } from './pipeline.js';

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
 * @property {number} stride
 * @property {{ shaderLocation: number, offset: number, format: string }[]} attributes
 * @property {Map<number, { components: number, scalar: 'f32' | 'u32' | 'i32', bgra: boolean }>}
 *           shapes   By register, for the inputs the declaration supplies.
 */

/**
 * The vertex layout a declaration gives the inputs a shader declares.
 *
 * Only stream zero is read: the renderer binds one vertex buffer. An input
 * the declaration has no element for is left out, and the shader reads it as
 * the default vertex; an element of a type WebGPU cannot deliver, or one in
 * another stream, refuses the whole layout.
 *
 * @param {readonly VertexElement[]} elements
 * @param {readonly DeclaredInput[]} wanted
 * @param {number} stride  The bound stream's.
 * @returns {{ layout: VertexInputLayout | null, error: string | null }}
 */
export function vertexLayoutOf(elements, wanted, stride){
    /** @type {VertexInputLayout} */
    const layout = { stride, attributes: [], shapes: new Map() };
    for (const input of wanted)
    {
        const element = elements.find(one=>
            one.Usage === input.usage && one.UsageIndex === input.usageIndex);
        if (!element)
        {
            continue;
        }
        if (element.Stream !== 0)
        {
            return { layout: null, error: `element in stream ${element.Stream}` };
        }
        const attribute = DECLTYPE_ATTRIBUTE[element.Type];
        if (!attribute)
        {
            return { layout: null, error: `element type ${element.Type}` };
        }
        if (element.Offset + attribute.bytes > stride)
        {
            return { layout: null, error: `element past the stride of ${stride}` };
        }
        layout.attributes.push({
            shaderLocation: input.location, offset: element.Offset, format: attribute.format,
        });
        layout.shapes.set(input.register, {
            components: attribute.components, scalar: attribute.scalar, bgra: attribute.bgra,
        });
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
 * @param {{ floats: Float32Array, ints: Int32Array, bools: Uint32Array }} file
 * @param {number} reach   Float registers the shader reads.
 * @param {(floats: number) => Float32Array} take
 * @returns {Float32Array[]}
 */
export function constantBlocks(file, reach, take){
    const count = Math.max(1, Math.min(reach, file.floats.length / 4));
    const floats = take(count * 4);
    floats.set(file.floats.subarray(0, count * 4));
    const ints = take(16 * 4);
    new Int32Array(ints.buffer, ints.byteOffset, ints.length).set(file.ints.subarray(0, 64));
    const bools = take(16);
    new Uint32Array(bools.buffer, bools.byteOffset, bools.length).set(file.bools.subarray(0, 16));
    return [floats, ints, bools];
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
 *             => Promise<any>, stats: () => { built: number, reused: number } }}
 */
export function createProgramCache({ backend }){
    /** @type {Map<string, Promise<any>>} */
    const pipelines = new Map();
    /** @type {Map<number, any>} sampler count -> the three group layouts and the pipeline layout */
    const layouts = new Map();
    let built = 0;
    let reused = 0;

    /** @param {number} samplerCount */
    const layoutsFor = samplerCount=>{
        const existing = layouts.get(samplerCount);
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
            samplerEntries.push({ binding: index * 2, visibility: FRAGMENT_STAGE, texture: {} });
            samplerEntries.push(
                { binding: index * 2 + 1, visibility: FRAGMENT_STAGE, sampler: {} });
        }
        const groups = [
            constants(VERTEX_STAGE),
            constants(FRAGMENT_STAGE),
            backend.createBindGroupLayout(
                { label: `samplers:${samplerCount}`, entries: samplerEntries }),
        ];
        const made = {
            groups,
            pipeline: backend.createPipelineLayout({
                label: `programmable:${samplerCount}`,
                bindGroupLayouts: groups,
            }),
        };
        layouts.set(samplerCount, made);
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
                const bound = layoutsFor(program.pixel.samplers.length);
                return {
                    bindGroupLayouts: bound.groups,
                    gpu: backend.createRenderPipeline({
                        label: `programmable:${program.key}`,
                        layout: bound.pipeline,
                        vertex: {
                            module: vertexModule,
                            entryPoint: program.vertex.entry,
                            buffers: [{
                                arrayStride: program.layout.stride,
                                stepMode: 'vertex',
                                attributes: program.layout.attributes,
                            }],
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
            pipelines.set(key, building);
            return building;
        },
        stats: ()=>({ built, reused }),
    };
}

/**
 * @typedef {Object} ProgramSource
 *     What a programmable pipeline is built from.
 * @property {string} key   Names the shader pair and the layout, for the cache.
 * @property {{ wgsl: string, entry: string }} vertex
 * @property {{ wgsl: string, entry: string, samplers: { index: number, type: string }[] }} pixel
 * @property {VertexInputLayout} layout
 */
