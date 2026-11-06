/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A draw through the tessellator, as WebGPU draws it: five compute passes and
 * a draw, recorded in the order they run.
 *
 * 1. The vertex shader over the draw's control points (`linkVertexPatches`),
 *    the vertex buffers and the index buffer read as words.
 * 2. The hull shader, one invocation a patch (`linkHull`): output control
 *    points, patch constants, and each patch's record for the tessellator.
 * 3. The tessellator's counting pass (`tessellator-wgsl.js`).
 * 4. The running sums of the counts (`TESS_SCAN_WGSL`): each patch's offsets,
 *    the patches past the buffers' room culled, and the draw's arguments.
 * 5. The tessellator's writing pass: domain points and indices.
 * 6. The draw, indirect, of the domain and pixel shaders (`linkDomain`), one
 *    vertex an index the tessellator wrote.
 *
 * The buffers between the passes are shared by every such draw of a frame:
 * the GPU runs passes in the order they were encoded, so a draw's passes read
 * what its own passes wrote. What the counts asked for is read back once a
 * frame and the room grown to it; patches that did not fit are a loss, said.
 */

import { tessellate } from './tessellator.js';
import {
    PATCH_BYTES, TESSELLATOR_BINDINGS, TESSELLATOR_WGSL, TESS_ARGS_WORDS, TESS_INDIRECT_AT,
    TESS_INDIRECT_BINDINGS, TESS_INDIRECT_WGSL, TESS_SCAN_BINDINGS, TESS_SCAN_WGSL,
} from './tessellator-wgsl.js';
import {
    DOMAIN_BINDING, HULL_BINDING, STAGE, VERTEX_PATCH_BINDING, linkHull, linkVertexPatches,
} from './wgsl.js';
import { LockFlags } from '../webgpu/internal/buffers.js';
import { SYSTEM_VALUE } from './dxbc.js';
import { DXGI_FORMAT } from './constants.js';

/** D3D11_PRIMITIVE_TOPOLOGY_1_CONTROL_POINT_PATCHLIST; 32 more is 32 points. */
export const FIRST_PATCH_LIST = 33;

/** The tessellator's output primitives, as the draw over them takes them. */
const OUTPUT_TOPOLOGY = Object.freeze(['point-list', 'line-list', 'triangle-list',
    'triangle-list']);

/** What a uniform binding's offset is a multiple of, at the least a device may ask. */
const UNIFORM_SLOT = 256;
/** A draw's uniforms: the vertex program's (two slots), the shared four words, the passes'. */
const SLOT = Object.freeze({ vertex: 0, shared: 2, count: 3, write: 4 });
const SLOTS = 5;
/** Where a draw's arguments sit in the arguments buffer: a storage binding's alignment. */
const ARGS_SLOT = 256;

/** The room the first draws get, and the most it grows to, in points and indices. */
const FIRST_ROOM = Object.freeze({ points: 1 << 16, indices: 1 << 18 });
const MOST_ROOM = Object.freeze({ points: 1 << 23, indices: 1 << 24 });
/**
 * The patches an indirect draw's buffers are sized for, before and at most:
 * how many it draws is on the GPU, read back and the room grown to it.
 */
const FIRST_PATCH_ROOM = 1 << 10;
const MOST_PATCH_ROOM = 1 << 16;
/** An indirect draw's block (`TESS_INDIRECT_AT`), in bytes: a uniform binding's alignment. */
const INDIRECT_BLOCK = TESS_INDIRECT_AT.words * 4;

const COMPUTE = STAGE.COMPUTE;
const VERTEX = STAGE.VERTEX;
/** @param {number} binding @param {number} visibility @param {string} type */
const entry = (binding, visibility, type)=>({ binding, visibility, buffer: { type } });

/** Group 1 of the vertex program as compute, before its streams. */
const VERTEX_PATCH_ENTRIES = [
    entry(VERTEX_PATCH_BINDING.indices, COMPUTE, 'read-only-storage'),
    entry(VERTEX_PATCH_BINDING.out, COMPUTE, 'storage'),
    entry(VERTEX_PATCH_BINDING.params, COMPUTE, 'uniform'),
];
const HULL_ENTRIES = [
    entry(HULL_BINDING.inputs, COMPUTE, 'read-only-storage'),
    entry(HULL_BINDING.points, COMPUTE, 'storage'),
    entry(HULL_BINDING.constants, COMPUTE, 'storage'),
    entry(HULL_BINDING.patches, COMPUTE, 'storage'),
    entry(HULL_BINDING.params, COMPUTE, 'uniform'),
];
const TESSELLATOR_ENTRIES = [
    entry(TESSELLATOR_BINDINGS.patches, COMPUTE, 'read-only-storage'),
    entry(TESSELLATOR_BINDINGS.counts, COMPUTE, 'storage'),
    entry(TESSELLATOR_BINDINGS.offsets, COMPUTE, 'read-only-storage'),
    entry(TESSELLATOR_BINDINGS.points, COMPUTE, 'storage'),
    entry(TESSELLATOR_BINDINGS.indices, COMPUTE, 'storage'),
    entry(TESSELLATOR_BINDINGS.params, COMPUTE, 'uniform'),
];
const INDIRECT_ENTRIES = [
    entry(TESS_INDIRECT_BINDINGS.io, COMPUTE, 'storage'),
    entry(TESS_INDIRECT_BINDINGS.given, COMPUTE, 'uniform'),
];
const SCAN_ENTRIES = [
    entry(TESS_SCAN_BINDINGS.counts, COMPUTE, 'read-only-storage'),
    entry(TESS_SCAN_BINDINGS.offsets, COMPUTE, 'storage'),
    entry(TESS_SCAN_BINDINGS.patches, COMPUTE, 'storage'),
    entry(TESS_SCAN_BINDINGS.args, COMPUTE, 'storage'),
    entry(TESS_SCAN_BINDINGS.params, COMPUTE, 'uniform'),
];
/** Group 2 of the draw: what the domain shader reads its vertex from. */
export const DOMAIN_ENTRIES = Object.freeze([
    entry(DOMAIN_BINDING.points, VERTEX, 'read-only-storage'),
    entry(DOMAIN_BINDING.constants, VERTEX, 'read-only-storage'),
    entry(DOMAIN_BINDING.domain, VERTEX, 'read-only-storage'),
    entry(DOMAIN_BINDING.indices, VERTEX, 'read-only-storage'),
    entry(DOMAIN_BINDING.offsets, VERTEX, 'read-only-storage'),
    entry(DOMAIN_BINDING.params, VERTEX, 'uniform'),
]);

/**
 * The most points and indices one patch makes in a domain, partitioning and
 * output: the reference tessellator's answer at the largest factors.
 *
 * @type {Map<string, { points: number, indices: number }>}
 */
const mostOfPatch = new Map();
/** @param {'isoline' | 'tri' | 'quad'} domain @param {number} partitioning @param {number} output */
export function patchMost(domain, partitioning, output){
    const key = `${domain}|${partitioning}|${output}`;
    let most = mostOfPatch.get(key);
    if (!most)
    {
        const made = tessellate(domain, partitioning, output, [64, 64, 64, 64, 64, 64]);
        most = { points: made.points.length / 2, indices: made.indices.length };
        mostOfPatch.set(key, most);
    }
    return most;
}

/**
 * @typedef {Object} TessellationServices
 * @property {any} backend
 * @property {any} BufferUsage
 * @property {(detail: string) => void} lose
 * @property {(entries: any[], label: string) => any} layoutFor
 * @property {(object: any) => number} idOf
 * @property {(shader: any, variant?: string) => any} translationOf
 * @property {(stage: any, entries: any[], uavs?: readonly any[]) => object[]} bindingsFor
 * @property {(inputLayout: any, program: any, strides: number[]) =>
 *     ({ buffers: any[], slots: number[] } | string)} vertexLayouts
 * @property {(resource: any) => any} backingOf
 * @property {Map<string, Promise<any>>} pipelines
 * @property {() => any} placeholder  A storage buffer of zeros, for a buffer not bound.
 */

/** @param {TessellationServices} services */
export function createTessellation(services){
    const { backend, BufferUsage, lose, layoutFor, idOf } = services;
    /** @type {WeakMap<object, any>} hull shader -> its linked program */
    const hulls = new WeakMap();
    /** @type {Record<string, any>} the buffers between the passes, by name */
    const scratch = {};
    let params = /** @type {any} */ (null);
    let args = /** @type {any} */ (null);
    /** The blocks of indirect draws (`TESS_INDIRECT_AT`). */
    let blocks = /** @type {any} */ (null);
    /** Draws through the tessellator recorded this frame: their uniform and argument slots. */
    let drawn = 0;
    /** Indirect draws among them: their blocks. */
    let drawnIndirect = 0;
    const room = { ...FIRST_ROOM };
    let patchRoom = FIRST_PATCH_ROOM;
    let lostReported = false;
    let patchesLostReported = false;
    const counted = { draws: 0, indirect: 0, patches: 0, culledFrames: 0, grown: 0 };

    /** @param {any} shader */
    const hullOf = shader=>{
        let linked = hulls.get(shader);
        if (!linked)
        {
            linked = linkHull(shader.container);
            hulls.set(shader, linked);
        }
        return linked;
    };

    /**
     * A buffer between the passes with room for `bytes`, grown (never
     * shrunk) as draws need: what earlier draws of the frame were given stays
     * theirs until the frames that read it are submitted.
     *
     * @param {string} name @param {number} bytes
     */
    const scratchOf = (name, bytes)=>{
        let buffer = scratch[name];
        if (!buffer || buffer.size < bytes)
        {
            if (buffer)
            {
                backend.releaseDynamicBuffer(buffer);
            }
            let size = Math.max(256, buffer ? buffer.size : 0);
            while (size < bytes)
            {
                size *= 2;
            }
            buffer = backend.createDynamicBuffer({ label: `d3d11:tessellation:${name}`, size,
                usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST,
                keep: false, gpuOnly: true });
            scratch[name] = buffer;
        }
        buffer.markRead();
        return buffer;
    };

    /** @param {any} buffer @param {number} bytes @param {number} [offset] */
    const whole = (buffer, bytes, offset = 0)=>({ buffer: buffer.gpu, offset,
        size: Math.max(16, Math.ceil(bytes / 16) * 16) });

    /**
     * The uniforms of this frame's next draw through the tessellator, written
     * into a slot of their own: a later draw's never land on an earlier's.
     *
     * @param {(Uint32Array | null)[]} slots by `SLOT`
     */
    const paramsFor = slots=>{
        const at = drawn * SLOTS * UNIFORM_SLOT;
        const bytes = SLOTS * UNIFORM_SLOT;
        if (!params || params.size < at + bytes)
        {
            if (params)
            {
                backend.releaseDynamicBuffer(params);
            }
            params = backend.createDynamicBuffer({ label: 'd3d11:tessellation:params',
                size: Math.max(4 * bytes, 2 * (at + bytes)),
                usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST });
        }
        const lock = params.lock(at, bytes, LockFlags.NONE);
        lock.data.fill(0);
        slots.forEach((words, slot)=>{
            if (words)
            {
                lock.data.set(new Uint8Array(words.buffer, words.byteOffset, words.byteLength),
                    slot * UNIFORM_SLOT);
            }
        });
        params.unlock(lock);
        params.markRead(at, at + bytes);
        return { gpu: params.gpu, at };
    };

    /** The arguments buffer, with this frame's next slot. */
    const argsFor = ()=>{
        const bytes = (drawn + 1) * ARGS_SLOT;
        if (!args || args.size < bytes)
        {
            if (args)
            {
                backend.releaseDynamicBuffer(args);
            }
            args = backend.createDynamicBuffer({ label: 'd3d11:tessellation:args',
                size: Math.max(4096, 2 * bytes),
                usage: BufferUsage.STORAGE | BufferUsage.INDIRECT | BufferUsage.COPY_SRC,
                keep: false, gpuOnly: true });
        }
        args.markRead();
        return { gpu: args.gpu, at: drawn * ARGS_SLOT };
    };

    /** The blocks of indirect draws, with this frame's next. */
    const blockFor = ()=>{
        const bytes = (drawnIndirect + 1) * INDIRECT_BLOCK;
        if (!blocks || blocks.size < bytes)
        {
            if (blocks)
            {
                backend.releaseDynamicBuffer(blocks);
            }
            blocks = backend.createDynamicBuffer({ label: 'd3d11:tessellation:indirect',
                size: Math.max(4 * INDIRECT_BLOCK, 2 * bytes),
                usage: BufferUsage.STORAGE | BufferUsage.UNIFORM | BufferUsage.INDIRECT
                    | BufferUsage.COPY_SRC | BufferUsage.COPY_DST,
                keep: false, gpuOnly: true });
        }
        blocks.markRead();
        return { gpu: blocks.gpu, at: drawnIndirect * INDIRECT_BLOCK };
    };

    /**
     * A compute pipeline over several groups, built once for its key; it
     * refuses to build what the translator could not translate.
     *
     * @param {string} key @param {string} code @param {string} entryPoint
     * @param {any[][]} groups @param {string} label @param {string[]} [unsupported]
     * @returns {Promise<{ gpu: any, layouts: any[] }>}
     */
    const computeFor = (key, code, entryPoint, groups, label, unsupported = [])=>{
        let promise = services.pipelines.get(key);
        if (!promise)
        {
            promise = (async()=>{
                if (unsupported.length > 0)
                {
                    throw Object.assign(new Error(`the ${label} program cannot be translated:`
                        + ` ${unsupported.join('; ')}`), { untranslatable: true });
                }
                const module = await backend.createShaderModule({ code, label });
                const layouts = groups.map((entries, index)=>layoutFor(entries,
                    `${label}:${index}`));
                const gpu = await backend.createComputePipelineAsync({
                    label,
                    layout: backend.createPipelineLayout({ label, bindGroupLayouts: layouts }),
                    compute: { module, entryPoint },
                });
                return { gpu, layouts };
            })();
            services.pipelines.set(key, promise);
        }
        return promise;
    };

    /**
     * The passes before a draw through the tessellator, or null where the
     * draw is not drawn (said).
     *
     * @param {any} pipeline the device's state (`PipelineSnapshot`)
     * @param {{ vertexCount: number, startVertex: number, instanceCount?: number,
     *     indexCount?: number, startIndex?: number, baseVertex?: number,
     *     startInstance?: number, indirect?: any }} draw
     * @returns {{ commands: any[], waits: Promise<any>[], topology: string, hull: any,
     *     group: object[], args: { gpu: any, offset: number }, positions: number } | null}
     *     `positions`: the most indices the tessellator may write for the draw, which
     *     `args`' first word counts on the GPU
     */
    const prepare = (pipeline, draw)=>{
        const hullShader = pipeline.stages.hs.shader;
        const vertexShader = pipeline.stages.vs.shader;
        if (!hullShader || !pipeline.stages.ds.shader)
        {
            lose(`a draw with a ${hullShader ? 'hull shader and no domain'
                : 'domain shader and no hull'} shader is not drawn, as Direct3D draws none`);
            return null;
        }
        if (!vertexShader)
        {
            return null;
        }
        const hull = hullOf(hullShader);
        const points = pipeline.topology - FIRST_PATCH_LIST + 1;
        if (points !== hull.stage.inputPoints)
        {
            lose(`a draw of ${points > 0 ? `${points}-point patches` : 'no patches'} through a`
                + ` hull shader that takes ${hull.stage.inputPoints} is not drawn, as Direct3D`
                + ' draws none');
            return null;
        }
        const indexed = draw.indexCount !== undefined;
        // An indirect draw's counts are on the GPU: its buffers are sized for
        // the room in patches, and a pass before the others makes its
        // arguments into their uniforms and dispatch counts (`indirectOf`).
        const programArgs = draw.indirect ? services.backingOf(draw.indirect.buffer) : null;
        if (draw.indirect && !programArgs?.gpu)
        {
            return null;
        }
        const perInstance = programArgs ? 0
            : Math.floor((indexed ? draw.indexCount ?? 0 : draw.vertexCount) / points);
        const instances = draw.instanceCount ?? 1;
        const patches = programArgs ? patchRoom : perInstance * instances;
        if (patches === 0)
        {
            return null;
        }

        // 1. the vertex shader over every control point
        const vs = services.translationOf(vertexShader);
        const inputLayout = pipeline.inputLayout;
        const attributes = vs.inputs.filter((/** @type {any} */ element)=>
            element.systemValue === SYSTEM_VALUE.UNDEFINED
            && element.register < vs.inputRegisters)
            .map((/** @type {any} */ element)=>({ location: element.register,
                semantic: element.name, index: element.index }));
        const layout = inputLayout
            ? services.vertexLayouts(inputLayout, { attributes }, pipeline.vertexStrides)
            : attributes.length > 0 ? 'no input layout is bound' : { buffers: [], slots: [] };
        if (typeof layout === 'string')
        {
            lose(`a draw through the tessellator is not drawn: ${layout}`);
            return null;
        }
        const stage = hull.stage;
        const linkedVertex = linkVertexPatches(vs, hullShader.container.inputs,
            stage.inputRegisters, layout.buffers);
        const vertexEntries = [...VERTEX_PATCH_ENTRIES, ...layout.buffers.map((_, k)=>
            entry(VERTEX_PATCH_BINDING.streams + k, COMPUTE, 'read-only-storage'))];
        const vertexPipeline = computeFor(
            `tess-vs:${idOf(vertexShader)}|${idOf(hullShader)}|${idOf(inputLayout)}|`
                + `${layout.buffers.map(buffer=>`${buffer.stepMode}:${buffer.arrayStride}`)}`,
            linkedVertex.code, 'vertexPatches', [linkedVertex.entries, vertexEntries],
            `d3d11:vs-patches#${idOf(vertexShader)}`, linkedVertex.unsupported);

        /** @param {any} resource @returns {object} a buffer bound as words, or zeros */
        const asWords = resource=>{
            const backing = resource ? services.backingOf(resource) : null;
            if (!backing || !backing.gpu || backing.gpu.size < 4)
            {
                const zeros = services.placeholder();
                return { buffer: zeros.gpu, offset: 0, size: 16 };
            }
            backing.gpu.markRead();
            // The GPU buffer is the program's bytes rounded up to a word: a
            // 16-bit index in the last two bytes of six is in the binding.
            const size = backing.gpu.gpu.size ?? Math.ceil(backing.gpu.size / 4) * 4;
            return { buffer: backing.gpu.gpu, offset: 0, size: size & ~3 };
        };
        const indexBytes = indexed ? pipeline.indexFormat === DXGI_FORMAT.R16_UINT ? 2 : 4 : 0;
        const vertexParams = new Uint32Array(8 + 4 * Math.max(1, layout.buffers.length));
        vertexParams.set([patches * points, perInstance * points, indexBytes,
            pipeline.indexOffset ?? 0, indexed ? draw.startIndex ?? 0 : draw.startVertex,
            (draw.baseVertex ?? 0) >>> 0, draw.startInstance ?? 0, 0]);
        layout.slots.forEach((slot, k)=>{
            vertexParams[8 + 4 * k] = pipeline.vertexOffsets[slot] ?? 0;
            vertexParams[8 + 4 * k + 1] = layout.buffers[k].arrayStride ?? 0;
        });

        const capacity = {
            points: Math.min(room.points, patches * patchMost(stage.domain, stage.partitioning,
                stage.output).points),
            indices: Math.min(room.indices, patches * patchMost(stage.domain,
                stage.partitioning, stage.output).indices),
        };
        const shared = new Uint32Array([patches, perInstance, capacity.points,
            capacity.indices]);
        const most = patchMost(stage.domain, stage.partitioning, stage.output);
        const uniforms = paramsFor([vertexParams, null, shared,
            programArgs ? new Uint32Array([points, indexed ? 1 : 0, patchRoom, most.points,
                most.indices, capacity.points, capacity.indices, 0])
                : new Uint32Array([patches, 0]),
            new Uint32Array([patches, 1])]);
        const block = programArgs ? blockFor() : null;
        /** @param {number} slot @param {number} bytes */
        const uniform = (slot, bytes)=>({ buffer: block ? block.gpu : uniforms.gpu,
            offset: (block ? block.at : uniforms.at) + slot * UNIFORM_SLOT,
            size: Math.ceil(bytes / 16) * 16 });
        /** @param {number} word @param {number[]} grid */
        const gridOf = (word, grid)=>(block ? { buffer: block.gpu, offset: block.at + word * 4 }
            : grid);

        const register = 16;
        const vsOut = scratchOf('vertices', patches * points * stage.inputRegisters * register);
        const hullPoints = scratchOf('points', patches * stage.outputPoints
            * stage.outputRegisters * register);
        const hullConstants = scratchOf('constants', patches * stage.constantRegisters
            * register);
        const records = scratchOf('patches', patches * PATCH_BYTES);
        const counts = scratchOf('counts', patches * 8);
        const offsets = scratchOf('offsets', patches * 8);
        const domain = scratchOf('domain', capacity.points * 8);
        const indices = scratchOf('indices', capacity.indices * 4);
        const argSlot = argsFor();

        const commands = [];
        if (block && programArgs && draw.indirect)
        {
            programArgs.gpu.markRead();
            commands.push({ kind: 'copyBuffer', source: programArgs.gpu.gpu,
                sourceOffset: draw.indirect.offset, destination: block.gpu,
                destinationOffset: block.at + TESS_INDIRECT_AT.args * 4,
                size: (indexed ? 5 : 4) * 4 });
            commands.push({
                kind: 'dispatch', what: 'an indirect draw\'s arguments were not read',
                ids: [], label: 'd3d11:tessellation-indirect',
                pipeline: computeFor('tess-indirect', TESS_INDIRECT_WGSL, 'indirectPatches',
                    [INDIRECT_ENTRIES], 'd3d11:tessellation-indirect'),
                groups: [[
                    { binding: TESS_INDIRECT_BINDINGS.io, resource: { buffer: block.gpu,
                        offset: block.at, size: INDIRECT_BLOCK } },
                    { binding: TESS_INDIRECT_BINDINGS.given, resource: { buffer: uniforms.gpu,
                        offset: uniforms.at, size: SLOTS * UNIFORM_SLOT } },
                ]],
                grid: [1, 1, 1],
            });
        }
        commands.push({
            kind: 'dispatch', what: 'a vertex shader run before the tessellator was skipped',
            ids: [], pipeline: vertexPipeline, label: 'd3d11:vs-patches',
            groups: [
                services.bindingsFor(pipeline.stages.vs, linkedVertex.entries),
                [
                    { binding: VERTEX_PATCH_BINDING.indices,
                        resource: asWords(indexed ? pipeline.indexBuffer : null) },
                    { binding: VERTEX_PATCH_BINDING.out, resource: whole(vsOut,
                        patches * points * stage.inputRegisters * register) },
                    { binding: VERTEX_PATCH_BINDING.params,
                        resource: uniform(SLOT.vertex, vertexParams.byteLength) },
                    ...layout.slots.map((slot, k)=>({ binding: VERTEX_PATCH_BINDING.streams + k,
                        resource: asWords(pipeline.vertexBuffers[slot]) })),
                ],
            ],
            grid: gridOf(TESS_INDIRECT_AT.vertexGrid, [Math.ceil((patches * points) / 64), 1, 1]),
        });

        // 2. the hull shader, a patch an invocation
        const hullPipeline = computeFor(`tess-hs:${idOf(hullShader)}`, hull.code, 'hullMain',
            [hull.entries, HULL_ENTRIES], `d3d11:hs#${idOf(hullShader)}`, hull.unsupported);
        commands.push({
            kind: 'dispatch', what: 'a hull shader was skipped', ids: [],
            pipeline: hullPipeline, label: 'd3d11:hs',
            groups: [
                services.bindingsFor(pipeline.stages.hs, hull.entries),
                [
                    { binding: HULL_BINDING.inputs, resource: whole(vsOut,
                        patches * points * stage.inputRegisters * register) },
                    { binding: HULL_BINDING.points, resource: whole(hullPoints,
                        patches * stage.outputPoints * stage.outputRegisters * register) },
                    { binding: HULL_BINDING.constants, resource: whole(hullConstants,
                        patches * stage.constantRegisters * register) },
                    { binding: HULL_BINDING.patches, resource: whole(records,
                        patches * PATCH_BYTES) },
                    { binding: HULL_BINDING.params, resource: uniform(SLOT.shared, 16) },
                ],
            ],
            grid: gridOf(TESS_INDIRECT_AT.patchGrid, [Math.ceil(patches / 64), 1, 1]),
        });

        // 3-5. the tessellator's counts, their sums, its points and indices
        const tessellator = computeFor('tess-fixed', TESSELLATOR_WGSL, 'tessellatePatches',
            [TESSELLATOR_ENTRIES], 'd3d11:tessellator');
        /** @param {number} slot */
        const tessellatorGroup = slot=>[[
            { binding: TESSELLATOR_BINDINGS.patches, resource: whole(records,
                patches * PATCH_BYTES) },
            { binding: TESSELLATOR_BINDINGS.counts, resource: whole(counts, patches * 8) },
            { binding: TESSELLATOR_BINDINGS.offsets, resource: whole(offsets, patches * 8) },
            { binding: TESSELLATOR_BINDINGS.points, resource: whole(domain,
                capacity.points * 8) },
            { binding: TESSELLATOR_BINDINGS.indices, resource: whole(indices,
                capacity.indices * 4) },
            { binding: TESSELLATOR_BINDINGS.params, resource: uniform(slot, 8) },
        ]];
        commands.push({ kind: 'dispatch', what: 'the tessellator\'s count was skipped', ids: [],
            pipeline: tessellator, label: 'd3d11:tessellator-count',
            groups: tessellatorGroup(SLOT.count),
            grid: gridOf(TESS_INDIRECT_AT.patchGrid, [Math.ceil(patches / 64), 1, 1]) });
        commands.push({ kind: 'dispatch', what: 'the tessellator\'s sums were skipped', ids: [],
            pipeline: computeFor('tess-scan', TESS_SCAN_WGSL, 'scanPatches', [SCAN_ENTRIES],
                'd3d11:tessellator-scan'),
            label: 'd3d11:tessellator-scan',
            groups: [[
                { binding: TESS_SCAN_BINDINGS.counts, resource: whole(counts, patches * 8) },
                { binding: TESS_SCAN_BINDINGS.offsets, resource: whole(offsets, patches * 8) },
                { binding: TESS_SCAN_BINDINGS.patches, resource: whole(records,
                    patches * PATCH_BYTES) },
                { binding: TESS_SCAN_BINDINGS.args, resource: { buffer: argSlot.gpu,
                    offset: argSlot.at, size: TESS_ARGS_WORDS * 4 } },
                { binding: TESS_SCAN_BINDINGS.params, resource: uniform(SLOT.shared, 16) },
            ]],
            grid: [1, 1, 1] });
        commands.push({ kind: 'dispatch', what: 'the tessellator\'s points were skipped', ids: [],
            pipeline: tessellator, label: 'd3d11:tessellator-write',
            groups: tessellatorGroup(SLOT.write),
            grid: gridOf(TESS_INDIRECT_AT.patchGrid, [Math.ceil(patches / 64), 1, 1]) });

        counted.draws++;
        if (block)
        {
            counted.indirect++;
            drawnIndirect++;
        }
        else
        {
            counted.patches += patches;
        }
        drawn++;
        return {
            commands,
            waits: [vertexPipeline, hullPipeline, tessellator],
            topology: OUTPUT_TOPOLOGY[stage.output] ?? 'triangle-list',
            hull,
            group: [
                { binding: DOMAIN_BINDING.points, resource: whole(hullPoints,
                    patches * stage.outputPoints * stage.outputRegisters * register) },
                { binding: DOMAIN_BINDING.constants, resource: whole(hullConstants,
                    patches * stage.constantRegisters * register) },
                { binding: DOMAIN_BINDING.domain, resource: whole(domain, capacity.points * 8) },
                { binding: DOMAIN_BINDING.indices, resource: whole(indices,
                    capacity.indices * 4) },
                { binding: DOMAIN_BINDING.offsets, resource: whole(offsets, patches * 8) },
                { binding: DOMAIN_BINDING.params, resource: uniform(SLOT.shared, 16) },
            ],
            args: { gpu: argSlot.gpu, offset: argSlot.at },
            positions: capacity.indices,
        };
    };

    /**
     * The frame's draws through the tessellator are recorded: a read-back of
     * the room each asked for, to grow it for the next frames and to say a
     * frame drew fewer patches than it was given; null when there were none.
     *
     * @returns {any | null} a `readbackBuffer` command
     */
    const endFrame = ()=>{
        if (drawn === 0)
        {
            return null;
        }
        const draws = drawn;
        const indirect = drawnIndirect;
        drawn = 0;
        drawnIndirect = 0;
        const asked = { points: room.points, indices: room.indices, patches: patchRoom };
        return {
            kind: 'readbackBuffer',
            ranges: [
                ...Array.from({ length: draws }, (_, index)=>({ buffer: args.gpu,
                    offset: index * ARGS_SLOT + 16, size: 8 })),
                ...Array.from({ length: indirect }, (_, index)=>({ buffer: blocks.gpu,
                    offset: index * INDIRECT_BLOCK + TESS_INDIRECT_AT.asked * 4, size: 4 })),
            ],
            /** @param {Uint8Array[] | null} results */
            deliver(results){
                if (!results)
                {
                    return;
                }
                let patchesOver = false;
                for (const bytes of results.slice(draws))
                {
                    const wanted = new Uint32Array(bytes.buffer, bytes.byteOffset, 1)[0];
                    patchesOver ||= wanted > asked.patches;
                    while (patchRoom < Math.min(wanted, MOST_PATCH_ROOM))
                    {
                        patchRoom *= 2;
                        counted.grown++;
                    }
                }
                if (patchesOver)
                {
                    counted.culledFrames++;
                    if (!patchesLostReported || patchRoom >= MOST_PATCH_ROOM)
                    {
                        patchesLostReported = true;
                        lose('patches of an indirect draw through the tessellator past the room'
                            + ' its buffers had were not drawn; the room is grown for the next'
                            + ' frames');
                    }
                }
                let over = false;
                for (const bytes of results.slice(0, draws))
                {
                    const words = new Uint32Array(bytes.buffer, bytes.byteOffset, 2);
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
                        lose('patches past the room the tessellator\'s buffers had were not'
                            + ' drawn; the room is grown for the next frames');
                    }
                }
            },
        };
    };

    return {
        hullOf,
        prepare,
        endFrame,
        diagnostics: ()=>({ ...counted, room: { ...room, patches: patchRoom } }),
    };
}
