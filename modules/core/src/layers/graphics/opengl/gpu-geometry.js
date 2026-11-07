/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A draw through a GLSL geometry shader (OpenGL 3.2 section 2.12), as
 * WebGPU draws it: compute passes and an indirect draw, recorded in the order
 * they run -- the shape Direct3D 11's geometry shaders take
 * (`../d3d10/geometry.js`), whose sums, index lists and stream output these
 * passes share.
 *
 * 1. The vertex shader over every position of the draw and instance
 *    (`emitStage`'s `vertexCompute`), what the geometry shader reads of it
 *    kept a register a leaf.
 * 2. The geometry shader, one invocation a primitive and instance
 *    (`geometryMain`): the vertices it emits, each in its invocation's
 *    places, and how many primitives and vertices it made.
 * 3. The running sums of the primitives (`GEOMETRY_SCAN_WGSL`): each
 *    invocation's first, and the draw's arguments.
 * 4. The index list of its primitives (`geometryIndexWgsl`), a strip made a list.
 * 5. Stream output, where transform feedback is active (`streamOutWgsl`).
 * 6. The draw, indexed and indirect, its vertex stage reading the places
 *    (`geometryDrawStage`).
 *
 * The buffers between the passes are shared by every such draw: each
 * draw's passes and its draw run before the next draw's passes, in the order
 * recorded, so one draw's places are read before the next one writes them.
 */

import {
    GEOMETRY_INDEX_BINDING, GEOMETRY_SCAN_BINDING, GEOMETRY_SCAN_WGSL, STREAM_ARGS_WORDS,
    geometryIndexWgsl,
} from '../d3d10/geometry-wgsl.js';
import { GLSL_GEOMETRY_PASS_BINDING, GLSL_VERTEX_PASS_BINDING } from './glsl-wgsl.js';

/** The most bytes one buffer between the passes may take: the least a device binds. */
const MOST_BYTES = 1 << 27;
/** A register between the passes: four words. */
const REGISTER = 16;

const COMPUTE_STAGE = 4;
/** @param {number} binding @param {string} type */
const entry = (binding, type)=>({ binding, visibility: COMPUTE_STAGE, buffer: { type } });

const GEOMETRY_PASS_ENTRIES = Object.freeze([
    entry(GLSL_GEOMETRY_PASS_BINDING.inputs, 'read-only-storage'),
    entry(GLSL_GEOMETRY_PASS_BINDING.vertices, 'storage'),
    entry(GLSL_GEOMETRY_PASS_BINDING.starts, 'storage'),
    entry(GLSL_GEOMETRY_PASS_BINDING.counts, 'storage'),
    entry(GLSL_GEOMETRY_PASS_BINDING.params, 'uniform'),
]);
const SCAN_ENTRIES = Object.freeze([
    entry(GEOMETRY_SCAN_BINDING.counts, 'read-only-storage'),
    entry(GEOMETRY_SCAN_BINDING.offsets, 'storage'),
    entry(GEOMETRY_SCAN_BINDING.args, 'storage'),
    entry(GEOMETRY_SCAN_BINDING.params, 'uniform'),
]);
const INDEX_ENTRIES = Object.freeze([
    entry(GEOMETRY_INDEX_BINDING.starts, 'read-only-storage'),
    entry(GEOMETRY_INDEX_BINDING.counts, 'read-only-storage'),
    entry(GEOMETRY_INDEX_BINDING.offsets, 'read-only-storage'),
    entry(GEOMETRY_INDEX_BINDING.indices, 'storage'),
    entry(GEOMETRY_INDEX_BINDING.params, 'uniform'),
]);

/** @param {number} slots the draw's arrays @returns {object[]} */
const vertexPassEntries = slots=>[
    entry(GLSL_VERTEX_PASS_BINDING.indices, 'read-only-storage'),
    entry(GLSL_VERTEX_PASS_BINDING.out, 'storage'),
    entry(GLSL_VERTEX_PASS_BINDING.params, 'uniform'),
    ...Array.from({ length: slots }, (_, k)=>entry(GLSL_VERTEX_PASS_BINDING.slots + k,
        'read-only-storage')),
];

/**
 * @typedef {Object} GeometryServices
 * @property {any} backend
 * @property {(view: ArrayBufferView) => { gpu: any, offset: number }} uniform
 *     a draw's uniform bytes, written where a uniform binding may start
 * @property {(detail: string) => void} lose
 */

/**
 * @typedef {Object} ComputeGroup
 * @property {object[]} layout  group 0's layout entries: the fixed block, the
 *     stage's own block, its textures and samplers, its uniform blocks
 * @property {object[]} entries  what is bound there for this draw
 */

/**
 * @typedef {Object} GeometryDraw
 * @property {string} key  what the passes' code is cached by: the draw's program and arrays
 * @property {import('./wgsl.js').GeometryPasses} passes
 * @property {ComputeGroup} vertexGroup
 * @property {ComputeGroup} geometryGroup
 * @property {{ gpu: any, offset: number, stride: number, instance: boolean }[]} slots
 *     the draw's arrays, by slot
 * @property {{ gpu: any, offset: number, bytes: number } | null} indices
 * @property {number} first  the first index read, or the first vertex
 * @property {number} baseVertex  added to each index
 * @property {number} positions  the positions of the draw an instance, in the
 *     order the geometry shader reads them
 * @property {number} instances
 */

/** @param {GeometryServices} services */
export function createGlGeometry(services){
    const { backend } = services;
    const BufferUsage = backend.BufferUsage;
    /** @type {Map<string, Promise<{ gpu: any, layouts: any[] }>>} */
    const pipelines = new Map();
    /** @type {Record<string, any>} */
    const scratch = {};
    const counted = { draws: 0, invocations: 0, refused: 0 };

    /**
     * A buffer between the passes, grown as a draw needs: an outgrown one
     * is released as a ring's is, its destruction deferred past the work
     * that may still name it.
     *
     * @param {string} name @param {number} bytes @param {number} [extra]
     */
    const scratchOf = (name, bytes, extra = 0)=>{
        let buffer = scratch[name];
        if (!buffer || buffer.size < bytes)
        {
            if (buffer)
            {
                backend.releaseDynamicBuffer?.(buffer);
            }
            let size = Math.max(256, buffer ? buffer.size : 0);
            while (size < bytes)
            {
                size *= 2;
            }
            buffer = backend.createDynamicBuffer({ label: `gl:geometry:${name}`, size,
                usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST | extra,
                keep: false, gpuOnly: true });
            scratch[name] = buffer;
        }
        buffer.markRead();
        return buffer;
    };

    /** @param {any} buffer @param {number} bytes */
    const whole = (buffer, bytes)=>({ buffer: buffer.gpu, offset: 0,
        size: Math.max(16, Math.ceil(bytes / 16) * 16) });

    /** @param {ArrayBufferView} view */
    const uniform = view=>{
        const written = services.uniform(view);
        return { buffer: written.gpu, offset: written.offset,
            size: Math.max(16, Math.ceil(view.byteLength / 16) * 16) };
    };

    /**
     * @param {string} key @param {string} code @param {string} entryPoint
     * @param {readonly (readonly object[])[]} groups @param {string} label
     * @returns {Promise<{ gpu: any, layouts: any[] }>}
     */
    const computeFor = (key, code, entryPoint, groups, label)=>{
        let promise = pipelines.get(key);
        if (!promise)
        {
            promise = (async()=>{
                const module = await backend.createShaderModule({ code, label });
                const layouts = groups.map((entries, index)=>backend.createBindGroupLayout({
                    label: `${label}:${index}`, entries }));
                const gpu = await backend.createComputePipelineAsync({
                    label,
                    layout: backend.createPipelineLayout({ label, bindGroupLayouts: layouts }),
                    compute: { module, entryPoint },
                });
                return { gpu, layouts };
            })();
            pipelines.set(key, promise);
        }
        return promise;
    };

    /**
     * The passes before a draw through a geometry shader, and what its draw
     * binds and reads, or null where it makes nothing.
     *
     * @param {GeometryDraw} draw
     * @returns {{ passes: { pipeline: Promise<any>, label: string, groups: object[][],
     *     grid: number[] }[],
     *     drawn: { group: object[], args: { gpu: any, offset: number },
     *         indexBuffer: { gpu: any, format: string, offset: number } } } | null}
     */
    const prepare = draw=>{
        const { passes } = draw;
        const layout = passes.layout;
        const vertices = layout.inputVertices;
        const vpp = layout.outputVertices;
        const most = Math.max(1, layout.maxVertices);
        const prims = Math.floor(draw.positions / vertices);
        const invocations = draw.instances * prims;
        if (invocations === 0)
        {
            return null;
        }
        const positions = draw.instances * prims * vertices;
        const vsBytes = positions * passes.inputs * REGISTER;
        const placesBytes = invocations * most * passes.outputs * REGISTER;
        const room = invocations * Math.max(1, most - vpp + 1);
        const indicesBytes = room * vpp * 4;
        if (vsBytes > MOST_BYTES || placesBytes > MOST_BYTES || indicesBytes > MOST_BYTES)
        {
            counted.refused++;
            services.lose(`a draw of ${invocations} geometry shader invocations was not drawn:`
                + ' what they could make is past the room a buffer between the passes has');
            return null;
        }
        const slots = Math.max(1, draw.slots.length);
        const vsOut = scratchOf('vertices', vsBytes);
        const places = scratchOf('places', placesBytes);
        const startsBytes = invocations * most * 4;
        const starts = scratchOf('starts', startsBytes);
        const counts = scratchOf('counts', invocations * 32);
        const offsets = scratchOf('offsets', invocations * 16);
        const indices = scratchOf('indices', indicesBytes, BufferUsage.INDEX);
        const args = scratchOf('args', 4 * STREAM_ARGS_WORDS * 4, BufferUsage.INDIRECT);
        const zeros = scratchOf('zeros', 16);

        // 1. the vertex shader over every position
        const vertexParams = new Uint32Array(8 + 4 * slots);
        vertexParams.set([positions, prims * vertices, draw.indices ? draw.indices.bytes : 0,
            draw.indices ? draw.indices.offset : 0, draw.first, draw.baseVertex >>> 0, 0, 0]);
        draw.slots.forEach((slot, k)=>{
            vertexParams.set([slot.offset, slot.stride, slot.instance ? 1 : 0, 0], 8 + 4 * k);
        });
        const vertexPipeline = computeFor(`vs|${draw.key}|${slots}`, passes.vertex.code,
            'vertexCompute', [draw.vertexGroup.layout, vertexPassEntries(slots)],
            'gl:vs-geometry');
        /** @type {{ pipeline: Promise<any>, label: string, groups: object[][], grid: number[] }[]} */
        const recorded = [{
            pipeline: vertexPipeline, label: 'gl:vs-geometry',
            groups: [draw.vertexGroup.entries, [
                { binding: GLSL_VERTEX_PASS_BINDING.indices, resource: draw.indices
                    ? { buffer: draw.indices.gpu, offset: 0, size: undefined }
                    : whole(zeros, 16) },
                { binding: GLSL_VERTEX_PASS_BINDING.out, resource: whole(vsOut, vsBytes) },
                { binding: GLSL_VERTEX_PASS_BINDING.params, resource: uniform(vertexParams) },
                ...Array.from({ length: slots }, (_, k)=>({
                    binding: GLSL_VERTEX_PASS_BINDING.slots + k,
                    resource: draw.slots[k]
                        ? { buffer: draw.slots[k].gpu, offset: 0, size: undefined }
                        : whole(zeros, 16) })),
            ]],
            grid: [Math.ceil(positions / 64), 1, 1],
        }];

        // 2. the geometry shader
        recorded.push({
            pipeline: computeFor(`gs|${draw.key}`, passes.geometry.code, 'geometryMain',
                [draw.geometryGroup.layout, GEOMETRY_PASS_ENTRIES], 'gl:gs'),
            label: 'gl:gs',
            groups: [draw.geometryGroup.entries, [
                { binding: GLSL_GEOMETRY_PASS_BINDING.inputs, resource: whole(vsOut, vsBytes) },
                { binding: GLSL_GEOMETRY_PASS_BINDING.vertices,
                    resource: whole(places, placesBytes) },
                { binding: GLSL_GEOMETRY_PASS_BINDING.starts,
                    resource: whole(starts, startsBytes) },
                { binding: GLSL_GEOMETRY_PASS_BINDING.counts,
                    resource: whole(counts, invocations * 32) },
                { binding: GLSL_GEOMETRY_PASS_BINDING.params,
                    resource: uniform(new Uint32Array([invocations, prims, 0, 0])) },
            ]],
            grid: [Math.ceil(invocations / 64), 1, 1],
        });

        // 3-4. the sums and the list
        const argsResource = whole(args, 4 * STREAM_ARGS_WORDS * 4);
        recorded.push({
            pipeline: computeFor('gs-scan', GEOMETRY_SCAN_WGSL, 'scanGeometry', [SCAN_ENTRIES],
                'gl:geometry-scan'),
            label: 'gl:geometry-scan',
            groups: [[
                { binding: GEOMETRY_SCAN_BINDING.counts,
                    resource: whole(counts, invocations * 32) },
                { binding: GEOMETRY_SCAN_BINDING.offsets,
                    resource: whole(offsets, invocations * 16) },
                { binding: GEOMETRY_SCAN_BINDING.args, resource: argsResource },
                { binding: GEOMETRY_SCAN_BINDING.params,
                    resource: uniform(new Uint32Array([invocations, room, vpp, 0])) },
            ]],
            grid: [1, 1, 1],
        });
        recorded.push({
            pipeline: computeFor(`gs-list:${most}|${vpp}`, geometryIndexWgsl({ streams: 1,
                maxOut: most, outputVertices: vpp }), 'listGeometry', [INDEX_ENTRIES],
            'gl:geometry-list'),
            label: 'gl:geometry-list',
            groups: [[
                { binding: GEOMETRY_INDEX_BINDING.starts, resource: whole(starts, startsBytes) },
                { binding: GEOMETRY_INDEX_BINDING.counts,
                    resource: whole(counts, invocations * 32) },
                { binding: GEOMETRY_INDEX_BINDING.offsets,
                    resource: whole(offsets, invocations * 16) },
                { binding: GEOMETRY_INDEX_BINDING.indices, resource: whole(indices, indicesBytes) },
                { binding: GEOMETRY_INDEX_BINDING.params,
                    resource: uniform(new Uint32Array([invocations, room, 0, 0])) },
            ]],
            grid: [Math.ceil(invocations / 64), 1, 1],
        });
        counted.draws++;
        counted.invocations += invocations;
        return {
            passes: recorded,
            drawn: {
                group: [{ binding: 0, resource: whole(places, placesBytes) }],
                args: { gpu: args.gpu, offset: 0 },
                indexBuffer: { gpu: indices.gpu, format: 'uint32', offset: 0 },
            },
        };
    };

    return {
        prepare,
        diagnostics: ()=>({ ...counted }),
    };
}
