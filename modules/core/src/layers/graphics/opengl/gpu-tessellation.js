/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A draw through GLSL tessellation shaders (OpenGL 4.0 section 2.12), as
 * WebGPU draws it: compute passes and an indirect draw, recorded in the order
 * they run -- the shape Direct3D 11's tessellation takes
 * (`../d3d10/tessellation.js`), whose tessellator, sums and draw over the
 * tessellator's indices these passes share.
 *
 * 1. The vertex shader over every control point of the draw and instance
 *    (`gpu-geometry.js` vertexPass), what the next stage reads kept a register
 *    a leaf.
 * 2. The control shader, a workgroup a patch and an invocation a control
 *    point it makes (`controlMain`): the points, the patch's values and
 *    levels, and the patch's record for the tessellator. Without one, the
 *    default levels made each patch's record (`DEFAULT_PATCHES_WGSL`), and
 *    the evaluation shader reads the vertex pass's points.
 * 3. The tessellator's counts, their running sums (the patches past the
 *    buffers' room culled) and its points and indices.
 * 4. The draw, indirect, of the evaluation and fragment shaders, the
 *    evaluation shader as the vertex stage over the tessellator's indices.
 *
 * The buffers between the passes are shared by every such draw: each draw's
 * passes and its draw run before the next draw's passes, in the order
 * recorded. What the counts asked for is read back after the frame and the
 * room grown to it; patches that did not fit are a loss, said.
 */

import {
    PATCH_BYTES, TESSELLATOR_BINDINGS, TESSELLATOR_WGSL, TESS_ARGS_WORDS, TESS_SCAN_BINDINGS,
    TESS_SCAN_WGSL,
} from '../d3d10/tessellator-wgsl.js';
import { patchMost } from '../d3d10/tessellation.js';
import { DOMAIN_BINDING } from '../d3d10/wgsl.js';
import { tessellatorKind } from './glsl-link-tess.js';
import { GLSL_TESS_CONTROL_BINDING, TESS_RECORD_WGSL } from './glsl-wgsl-tess.js';

/** The most bytes one buffer between the passes may take: the least a device binds. */
const MOST_BYTES = 1 << 27;
/** A register between the passes: four words. */
const REGISTER = 16;
/** The room the first draws get, and the most it grows to, in points and indices. */
const FIRST_ROOM = Object.freeze({ points: 1 << 16, indices: 1 << 18 });
const MOST_ROOM = Object.freeze({ points: 1 << 23, indices: 1 << 24 });
/** Where a draw's arguments sit: a storage binding's alignment; and the slots taken in turn. */
const ARGS_SLOT = 256;
const ARGS_SLOTS = 1024;
/** The tessellator's domains, by `tessellatorKind`'s number. */
const DOMAINS = /** @type {const} */ (['isoline', 'tri', 'quad']);
/** The most workgroups a dimension of a dispatch has (WebGPU's least limit). */
const MOST_GROUPS = 65535;

const COMPUTE_STAGE = 4;
const VERTEX_STAGE = 1;
/** @param {number} binding @param {string} type @param {number} [visibility] */
const entry = (binding, type, visibility = COMPUTE_STAGE)=>({ binding, visibility,
    buffer: { type } });

const CONTROL_ENTRIES = Object.freeze([
    entry(GLSL_TESS_CONTROL_BINDING.inputs, 'read-only-storage'),
    entry(GLSL_TESS_CONTROL_BINDING.points, 'storage'),
    entry(GLSL_TESS_CONTROL_BINDING.constants, 'storage'),
    entry(GLSL_TESS_CONTROL_BINDING.patches, 'storage'),
    entry(GLSL_TESS_CONTROL_BINDING.params, 'uniform'),
]);
const DEFAULTS_ENTRIES = Object.freeze([
    entry(0, 'storage'),
    entry(1, 'storage'),
    entry(2, 'uniform'),
]);
const TESSELLATOR_ENTRIES = Object.freeze([
    entry(TESSELLATOR_BINDINGS.patches, 'read-only-storage'),
    entry(TESSELLATOR_BINDINGS.counts, 'storage'),
    entry(TESSELLATOR_BINDINGS.offsets, 'read-only-storage'),
    entry(TESSELLATOR_BINDINGS.points, 'storage'),
    entry(TESSELLATOR_BINDINGS.indices, 'storage'),
    entry(TESSELLATOR_BINDINGS.params, 'uniform'),
]);
const SCAN_ENTRIES = Object.freeze([
    entry(TESS_SCAN_BINDINGS.counts, 'read-only-storage'),
    entry(TESS_SCAN_BINDINGS.offsets, 'storage'),
    entry(TESS_SCAN_BINDINGS.patches, 'storage'),
    entry(TESS_SCAN_BINDINGS.args, 'storage'),
    entry(TESS_SCAN_BINDINGS.params, 'uniform'),
]);

/** Group 2 of the draw: what the evaluation shader reads its vertex from (`DOMAIN_BINDING`). */
export const TESS_DRAW_ENTRIES = Object.freeze([
    entry(DOMAIN_BINDING.points, 'read-only-storage', VERTEX_STAGE),
    entry(DOMAIN_BINDING.constants, 'read-only-storage', VERTEX_STAGE),
    entry(DOMAIN_BINDING.domain, 'read-only-storage', VERTEX_STAGE),
    entry(DOMAIN_BINDING.indices, 'read-only-storage', VERTEX_STAGE),
    entry(DOMAIN_BINDING.offsets, 'read-only-storage', VERTEX_STAGE),
    entry(DOMAIN_BINDING.params, 'uniform', VERTEX_STAGE),
]);

/**
 * Without a control shader, each patch's levels are the defaults
 * glPatchParameterfv set (4.0 section 2.12): its record for the tessellator
 * and its levels where the evaluation shader reads them, two registers.
 * `params`: the patches, then the kind (domain, partitioning, output), the
 * outer levels and the inner.
 */
export const DEFAULT_PATCHES_WGSL = /* wgsl */ `
struct Params {
    patches: u32,
    pad0: u32,
    pad1: u32,
    pad2: u32,
    kind: vec4u,
    outer: vec4f,
    inner: vec4f,
}
@group(0) @binding(0) var<storage, read_write> constants: array<vec4u>;
@group(0) @binding(1) var<storage, read_write> records: array<TessRecord>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(64)
fn defaultPatches(@builtin(global_invocation_id) id: vec3u) {
    if (id.x >= params.patches) {
        return;
    }
    constants[id.x * 2u] = bitcast<vec4u>(params.outer);
    constants[id.x * 2u + 1u] = bitcast<vec4u>(vec4f(params.inner.xy, 0.0, 0.0));
    records[id.x] = tessRecord(params.kind, params.outer, params.inner);
}
`;

/**
 * @typedef {Object} TessellationServices
 * @property {any} backend
 * @property {(view: ArrayBufferView) => { gpu: any, offset: number }} uniform
 *     a draw's uniform bytes, written where a uniform binding may start
 * @property {(detail: string) => void} lose
 * @property {(draw: any, code: string, positions: number, perInstance: number,
 *     out: object) => { pipeline: Promise<any>, label: string, groups: object[][],
 *     grid: number[] }} vertexPass  the vertex shader over a draw's positions
 *     (`gpu-geometry.js`)
 */

/**
 * @typedef {Object} TessellationDraw
 * @property {string} key  what the passes' code is cached by
 * @property {import('./wgsl.js').TessellationPasses} passes
 * @property {import('./gpu-geometry.js').ComputeGroup} vertexGroup
 * @property {import('./gpu-geometry.js').ComputeGroup | null} controlGroup
 * @property {{ gpu: any, offset: number, stride: number, instance: boolean }[]} slots
 * @property {{ gpu: any, offset: number, bytes: number } | null} indices
 * @property {number} first @property {number} baseVertex
 * @property {number} positions  of the draw, an instance
 * @property {number} instances
 * @property {number} patchVertices  GL_PATCH_VERTICES
 * @property {readonly number[]} outer  GL_PATCH_DEFAULT_OUTER_LEVEL
 * @property {readonly number[]} inner  GL_PATCH_DEFAULT_INNER_LEVEL
 */

/** @param {TessellationServices} services */
export function createGlTessellation(services){
    const { backend } = services;
    const BufferUsage = backend.BufferUsage;
    /** @type {Map<string, Promise<{ gpu: any, layouts: any[] }>>} */
    const pipelines = new Map();
    /** @type {Record<string, any>} */
    const scratch = {};
    let args = /** @type {any} */ (null);
    let nextArgs = 0;
    const room = { ...FIRST_ROOM };
    let lostReported = false;
    const counted = { draws: 0, patches: 0, culledFrames: 0, grown: 0 };

    /** @param {string} name @param {number} bytes @param {number} [extra] */
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
            buffer = backend.createDynamicBuffer({ label: `gl:tessellation:${name}`, size,
                usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST | extra,
                keep: false, gpuOnly: true });
            scratch[name] = buffer;
        }
        buffer.markRead();
        return buffer;
    };

    /** The arguments buffer and this draw's slot in it, taken in turn. */
    const argsSlot = ()=>{
        if (!args)
        {
            args = backend.createDynamicBuffer({ label: 'gl:tessellation:args',
                size: ARGS_SLOTS * ARGS_SLOT,
                usage: BufferUsage.STORAGE | BufferUsage.INDIRECT | BufferUsage.COPY_SRC
                    | BufferUsage.COPY_DST,
                keep: false, gpuOnly: true });
        }
        args.markRead();
        const at = nextArgs * ARGS_SLOT;
        nextArgs = (nextArgs + 1) % ARGS_SLOTS;
        return { gpu: args.gpu, offset: at };
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
     * The passes before a draw through the tessellator, and what its draw
     * binds and reads, or null where it draws nothing.
     *
     * @param {TessellationDraw} draw
     * @returns {{ passes: { pipeline: Promise<any>, label: string, groups: object[][],
     *     grid: number[] }[],
     *     drawn: { group: object[], args: { gpu: any, offset: number },
 *         asked: { points: number, indices: number } } } | null}
 *     `asked`: the room the draw was given, which its read-back is weighed against
     */
    const prepare = draw=>{
        const { passes } = draw;
        const layout = passes.layout;
        const points = draw.patchVertices;
        const perInstance = Math.floor(draw.positions / points);
        const patches = perInstance * draw.instances;
        if (patches === 0)
        {
            return null;
        }
        const kind = tessellatorKind(layout);
        const most = patchMost(DOMAINS[kind.domain], kind.partitioning, kind.output);
        const capacity = {
            points: Math.min(room.points, patches * most.points),
            indices: Math.min(room.indices, patches * most.indices),
        };
        const positions = patches * points;
        const vsBytes = positions * passes.inputs * REGISTER;
        const control = passes.control;
        const outPoints = control ? layout.vertices : points;
        const pointsBytes = control ? patches * outPoints * passes.pointRegisters * REGISTER
            : vsBytes;
        const constantsBytes = patches * passes.patchRegisters * REGISTER;
        if (vsBytes > MOST_BYTES || pointsBytes > MOST_BYTES || constantsBytes > MOST_BYTES
            || patches * PATCH_BYTES > MOST_BYTES)
        {
            services.lose(`a draw of ${patches} patches was not drawn: its control points are`
                + ' past the room a buffer between the passes has');
            return null;
        }
        const vsOut = scratchOf('vertices', vsBytes);
        const controlPoints = control ? scratchOf('points', pointsBytes) : vsOut;
        const constants = scratchOf('constants', constantsBytes);
        const records = scratchOf('patches', patches * PATCH_BYTES);
        const counts = scratchOf('counts', patches * 8);
        const offsets = scratchOf('offsets', patches * 8);
        const domain = scratchOf('domain', capacity.points * 8);
        const indices = scratchOf('indices', capacity.indices * 4);
        const argSlot = argsSlot();

        /** @type {{ pipeline: Promise<any>, label: string, groups: object[][], grid: number[] }[]} */
        const recorded = [services.vertexPass(draw, passes.vertex.code, positions,
            perInstance * points, whole(vsOut, vsBytes))];
        const kindWords = [kind.domain, kind.partitioning, kind.output, 0];
        if (control && draw.controlGroup)
        {
            const binding = GLSL_TESS_CONTROL_BINDING;
            recorded.push({
                pipeline: computeFor(`tcs|${draw.key}`, control.code, 'controlMain',
                    [draw.controlGroup.layout, CONTROL_ENTRIES], 'gl:tcs'),
                label: 'gl:tcs',
                groups: [draw.controlGroup.entries, [
                    { binding: binding.inputs, resource: whole(vsOut, vsBytes) },
                    { binding: binding.points, resource: whole(controlPoints, pointsBytes) },
                    { binding: binding.constants, resource: whole(constants, constantsBytes) },
                    { binding: binding.patches, resource: whole(records,
                        patches * PATCH_BYTES) },
                    { binding: binding.params, resource: uniform(new Uint32Array([patches,
                        perInstance, points, 0])) },
                ]],
                grid: [Math.min(patches, MOST_GROUPS), Math.ceil(patches / MOST_GROUPS), 1],
            });
        }
        else
        {
            const params = new ArrayBuffer(64);
            new Uint32Array(params, 0, 8).set([patches, 0, 0, 0, ...kindWords]);
            new Float32Array(params, 32, 8).set([...draw.outer.slice(0, 4),
                ...draw.inner.slice(0, 2), 0, 0]);
            recorded.push({
                pipeline: computeFor('tess-defaults', `${TESS_RECORD_WGSL}${DEFAULT_PATCHES_WGSL}`,
                    'defaultPatches', [DEFAULTS_ENTRIES], 'gl:tess-defaults'),
                label: 'gl:tess-defaults',
                groups: [[
                    { binding: 0, resource: whole(constants, constantsBytes) },
                    { binding: 1, resource: whole(records, patches * PATCH_BYTES) },
                    { binding: 2, resource: uniform(new Uint8Array(params)) },
                ]],
                grid: [Math.ceil(patches / 64), 1, 1],
            });
        }

        const tessellator = computeFor('tess-fixed', TESSELLATOR_WGSL, 'tessellatePatches',
            [TESSELLATOR_ENTRIES], 'gl:tessellator');
        /** @param {number} write */
        const tessellatorGroup = write=>[[
            { binding: TESSELLATOR_BINDINGS.patches, resource: whole(records,
                patches * PATCH_BYTES) },
            { binding: TESSELLATOR_BINDINGS.counts, resource: whole(counts, patches * 8) },
            { binding: TESSELLATOR_BINDINGS.offsets, resource: whole(offsets, patches * 8) },
            { binding: TESSELLATOR_BINDINGS.points, resource: whole(domain,
                capacity.points * 8) },
            { binding: TESSELLATOR_BINDINGS.indices, resource: whole(indices,
                capacity.indices * 4) },
            { binding: TESSELLATOR_BINDINGS.params, resource: uniform(new Uint32Array([patches,
                write, 0, 0])) },
        ]];
        // The evaluation shader's control points a patch: the control shader's, or the patch's.
        const shared = uniform(new Uint32Array([patches, perInstance, capacity.points,
            capacity.indices, outPoints, 0, 0, 0]));
        const grid = [Math.ceil(patches / 64), 1, 1];
        recorded.push({ pipeline: tessellator, label: 'gl:tessellator-count',
            groups: tessellatorGroup(0), grid });
        recorded.push({
            pipeline: computeFor('tess-scan', TESS_SCAN_WGSL, 'scanPatches', [SCAN_ENTRIES],
                'gl:tessellator-scan'),
            label: 'gl:tessellator-scan',
            groups: [[
                { binding: TESS_SCAN_BINDINGS.counts, resource: whole(counts, patches * 8) },
                { binding: TESS_SCAN_BINDINGS.offsets, resource: whole(offsets, patches * 8) },
                { binding: TESS_SCAN_BINDINGS.patches, resource: whole(records,
                    patches * PATCH_BYTES) },
                { binding: TESS_SCAN_BINDINGS.args, resource: { buffer: argSlot.gpu,
                    offset: argSlot.offset, size: TESS_ARGS_WORDS * 4 } },
                { binding: TESS_SCAN_BINDINGS.params, resource: shared },
            ]],
            grid: [1, 1, 1],
        });
        recorded.push({ pipeline: tessellator, label: 'gl:tessellator-write',
            groups: tessellatorGroup(1), grid });
        counted.draws++;
        counted.patches += patches;
        return {
            passes: recorded,
            drawn: {
                group: [
                    { binding: DOMAIN_BINDING.points, resource: whole(controlPoints,
                        pointsBytes) },
                    { binding: DOMAIN_BINDING.constants, resource: whole(constants,
                        constantsBytes) },
                    { binding: DOMAIN_BINDING.domain, resource: whole(domain,
                        capacity.points * 8) },
                    { binding: DOMAIN_BINDING.indices, resource: whole(indices,
                        capacity.indices * 4) },
                    { binding: DOMAIN_BINDING.offsets, resource: whole(offsets, patches * 8) },
                    { binding: DOMAIN_BINDING.params, resource: shared },
                ],
                args: argSlot,
                asked: { points: room.points, indices: room.indices },
            },
        };
    };

    /**
     * What a frame's draws through the tessellator asked for, read back
     * (each draw's arguments past the four the draw takes): the room grown
     * to it for the draws after, and a frame that drew fewer patches than it
     * was given said.
     *
     * @param {{ asked: { points: number, indices: number }, words: Uint32Array }[]} results
     */
    const grow = results=>{
        let over = false;
        for (const { asked, words } of results)
        {
            if (words[0] > asked.points || words[1] > asked.indices)
            {
                over = true;
            }
            while (room.points < Math.min(words[0], MOST_ROOM.points))
            {
                room.points *= 2;
                counted.grown++;
            }
            while (room.indices < Math.min(words[1], MOST_ROOM.indices))
            {
                room.indices *= 2;
                counted.grown++;
            }
        }
        if (over)
        {
            counted.culledFrames++;
            if (!lostReported || room.points >= MOST_ROOM.points
                || room.indices >= MOST_ROOM.indices)
            {
                lostReported = true;
                services.lose('patches past the room the tessellator\'s buffers had were not'
                    + ' drawn; the room is grown for the next frames');
            }
        }
    };

    return {
        prepare,
        grow,
        /** Where in a draw's arguments the points and indices every patch asked for are. */
        askedOffset: 16,
        diagnostics: ()=>({ ...counted, room: { ...room } }),
    };
}
