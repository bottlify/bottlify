/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A draw through a geometry shader, as WebGPU draws it: compute passes and a
 * draw, recorded in the order they run.
 *
 * 1. The vertex shader over every position of the draw (`linkVertexPatches`),
 *    what it wrote kept at the registers the geometry shader reads.
 * 2. The geometry shader, one invocation a primitive and instance of the
 *    shader (`linkGeometry`): the vertices it emits a stream, each kept in its
 *    invocation's places, and how many primitives and vertices it made.
 * 3. The running sums of the primitives (`GEOMETRY_SCAN_WGSL`): each
 *    invocation's first, and the arguments of each stream's draw.
 * 4. The index lists of each stream's primitives (`geometryIndexWgsl`), a
 *    strip made a list.
 * 5. Stream output, where the shader declares one (`streamOutWgsl`), and its
 *    counters moved on.
 * 6. The draw, indexed and indirect, of the rasterized stream's list, its
 *    vertex stage reading the places (`linkGeometryDraw`).
 *
 * A vertex shader's bytecode made a geometry shader to stream out is a stage
 * that passes each primitive on (`passThroughGeometry`).
 *
 * After the tessellator the first pass is the domain shader instead, over
 * every index the tessellator wrote (`linkDomainPositions`), and the
 * geometry shader takes them as a list of its primitives; how many there are
 * is on the GPU, so the passes are sized by the most the tessellator may
 * write and an invocation past what it did write makes nothing.
 *
 * The buffers between the passes are shared by every such draw of a frame,
 * as the tessellator's are (`tessellation.js`).
 */

import {
    COUNTER, COUNTER_BINDING, COUNTER_WGSL, GEOMETRY_INDEX_BINDING, GEOMETRY_SCAN_BINDING,
    GEOMETRY_SCAN_WGSL, STREAM_ARGS_WORDS, STREAM_OUT_BINDING, geometryIndexWgsl, streamOutWgsl,
} from './geometry-wgsl.js';
import {
    DOMAIN_POSITION_BINDING, GEOMETRY_BINDING, GEOMETRY_DRAW_BINDING, STAGE,
    VERTEX_PATCH_BINDING, geometryStage, linkDomainPositions, linkGeometry, linkVertexPatches,
    passThroughGeometry,
} from './wgsl.js';
import { LockFlags } from '../webgpu/internal/buffers.js';
import { SYSTEM_VALUE } from './dxbc.js';
import { DXGI_FORMAT } from './constants.js';
import { SO_NO_RASTERIZED_STREAM } from './streamout.js';

/** What a uniform binding's offset is a multiple of, at the least a device may ask. */
const UNIFORM_SLOT = 256;
/** A draw's uniforms: the vertex program's (two slots), the shader's, the passes'. */
const SLOT = Object.freeze({ vertex: 0, geometry: 2, scan: 3, list: 4, out: 5 });
const SLOTS = 6;
/** Where a draw's arguments sit in the arguments buffer: a storage binding's alignment. */
const ARGS_SLOT = 256;
/** The stream-output buffers a counter is kept for, at the most. */
const MOST_COUNTERS = 16384;
/** The most bytes one buffer between the passes may take. */
const MOST_BYTES = 1 << 27;

/** The vertices of each primitive of a topology, as Direct3D numbers them. */
const TOPOLOGY_VERTICES = Object.freeze(/** @type {Record<number, number>} */ ({
    1: 1, 2: 2, 3: 2, 4: 3, 5: 3, 10: 4, 11: 4, 12: 6, 13: 6,
}));
const STRIPS = Object.freeze([3, 5, 11, 13]);
/** The list the tessellator's primitives are, as Direct3D numbers it. */
const TESSELLATED_TOPOLOGY = Object.freeze(/** @type {Record<string, number>} */ ({
    'point-list': 1, 'line-list': 2, 'triangle-list': 4,
}));
/** A list of primitives of so many vertices, as the draw over them takes it. */
const LIST_TOPOLOGY = Object.freeze(['', 'point-list', 'line-list', 'triangle-list']);

const COMPUTE = STAGE.COMPUTE;
/** @param {number} binding @param {number} visibility @param {string} type */
const entry = (binding, visibility, type)=>({ binding, visibility, buffer: { type } });

const VERTEX_PATCH_ENTRIES = [
    entry(VERTEX_PATCH_BINDING.indices, COMPUTE, 'read-only-storage'),
    entry(VERTEX_PATCH_BINDING.out, COMPUTE, 'storage'),
    entry(VERTEX_PATCH_BINDING.params, COMPUTE, 'uniform'),
];
const GEOMETRY_ENTRIES = [
    entry(GEOMETRY_BINDING.inputs, COMPUTE, 'read-only-storage'),
    entry(GEOMETRY_BINDING.indices, COMPUTE, 'read-only-storage'),
    entry(GEOMETRY_BINDING.vertices, COMPUTE, 'storage'),
    entry(GEOMETRY_BINDING.starts, COMPUTE, 'storage'),
    entry(GEOMETRY_BINDING.counts, COMPUTE, 'storage'),
    entry(GEOMETRY_BINDING.params, COMPUTE, 'uniform'),
];
/** A geometry shader after the tessellator reads how many indices it wrote too. */
const LIMITED_GEOMETRY_ENTRIES = [...GEOMETRY_ENTRIES,
    entry(GEOMETRY_BINDING.limit, COMPUTE, 'read-only-storage')];
/** Group 1 of the domain shader run over the tessellator's indices. */
const DOMAIN_POSITION_ENTRIES = [
    ...['points', 'constants', 'domain', 'indices', 'offsets'].map(name=>entry(
        DOMAIN_POSITION_BINDING[/** @type {'points'} */ (name)], COMPUTE, 'read-only-storage')),
    entry(DOMAIN_POSITION_BINDING.params, COMPUTE, 'uniform'),
    entry(DOMAIN_POSITION_BINDING.out, COMPUTE, 'storage'),
    entry(DOMAIN_POSITION_BINDING.count, COMPUTE, 'read-only-storage'),
];
const SCAN_ENTRIES = [
    entry(GEOMETRY_SCAN_BINDING.counts, COMPUTE, 'read-only-storage'),
    entry(GEOMETRY_SCAN_BINDING.offsets, COMPUTE, 'storage'),
    entry(GEOMETRY_SCAN_BINDING.args, COMPUTE, 'storage'),
    entry(GEOMETRY_SCAN_BINDING.params, COMPUTE, 'uniform'),
];
const INDEX_ENTRIES = [
    entry(GEOMETRY_INDEX_BINDING.starts, COMPUTE, 'read-only-storage'),
    entry(GEOMETRY_INDEX_BINDING.counts, COMPUTE, 'read-only-storage'),
    entry(GEOMETRY_INDEX_BINDING.offsets, COMPUTE, 'read-only-storage'),
    entry(GEOMETRY_INDEX_BINDING.indices, COMPUTE, 'storage'),
    entry(GEOMETRY_INDEX_BINDING.params, COMPUTE, 'uniform'),
];
const STREAM_OUT_ENTRIES = [
    entry(STREAM_OUT_BINDING.vertices, COMPUTE, 'read-only-storage'),
    entry(STREAM_OUT_BINDING.indices, COMPUTE, 'read-only-storage'),
    entry(STREAM_OUT_BINDING.args, COMPUTE, 'read-only-storage'),
    entry(STREAM_OUT_BINDING.counters, COMPUTE, 'storage'),
    entry(STREAM_OUT_BINDING.params, COMPUTE, 'uniform'),
    ...[0, 1, 2, 3].map(index=>entry(STREAM_OUT_BINDING.buffers + index, COMPUTE, 'storage')),
];
const COUNTER_ENTRIES = [
    entry(COUNTER_BINDING.counters, COMPUTE, 'storage'),
    entry(COUNTER_BINDING.params, COMPUTE, 'uniform'),
    entry(COUNTER_BINDING.args, COMPUTE, 'storage'),
];
/** Group 2 of the draw: the places its vertices are read from. */
export const GEOMETRY_DRAW_ENTRIES = Object.freeze([
    entry(GEOMETRY_DRAW_BINDING.vertices, STAGE.VERTEX, 'read-only-storage'),
]);

/**
 * @typedef {Object} GeometryServices
 * @property {any} backend
 * @property {any} BufferUsage
 * @property {(detail: string) => void} lose
 * @property {(detail: string) => void} [diverge]  says, once, what is drawn otherwise than asked
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

/**
 * The words of each stream-output slot a declaration writes, and its stride.
 *
 * @param {any} gs  the translated shader, for its outputs
 * @param {readonly import('./streamout.js').StreamOutputEntry[]} entries
 * @param {readonly number[] | null} strides
 * @returns {{ writes: import('./geometry-wgsl.js').StreamOutWrite[], strides: number[] }}
 */
export function streamOutWrites(gs, entries, strides){
    /** @type {Map<number, import('./geometry-wgsl.js').StreamOutWrite>} */
    const bySlot = new Map();
    /** @type {number[]} */
    const words = [0, 0, 0, 0];
    for (const declared of entries)
    {
        const slot = declared.OutputSlot;
        let write = bySlot.get(slot);
        if (!write)
        {
            write = { slot, stream: declared.Stream ?? 0, words: [] };
            bySlot.set(slot, write);
        }
        if (declared.SemanticName)
        {
            const name = declared.SemanticName.toUpperCase();
            const element = gs.outputs.find((/** @type {any} */ output)=>
                output.name.toUpperCase() === name && output.index === declared.SemanticIndex
                && (output.stream ?? 0) === (declared.Stream ?? 0));
            if (element)
            {
                const first = [0, 1, 2, 3].find(c=>(element.mask & (1 << c)) !== 0) ?? 0;
                for (let c = 0; c < declared.ComponentCount; c++)
                {
                    write.words.push({ register: element.register,
                        component: Math.min(3, first + declared.StartComponent + c),
                        word: words[slot] + c });
                }
            }
        }
        words[slot] += declared.ComponentCount;
    }
    return {
        writes: [...bySlot.values()],
        strides: words.map((count, slot)=>(strides && strides[slot] ? strides[slot] : count * 4)),
    };
}

/** @param {GeometryServices} services */
export function createGeometry(services){
    const { backend, BufferUsage, lose, layoutFor, idOf } = services;
    const diverge = services.diverge ?? (()=>{});
    /** @type {WeakMap<object, any>} shader -> its translation and stage */
    const stages = new WeakMap();
    /** @type {Record<string, any>} */
    const scratch = {};
    let params = /** @type {any} */ (null);
    let args = /** @type {any} */ (null);
    let counters = /** @type {any} */ (null);
    /** @type {WeakMap<object, number>} stream-output buffer -> its counter */
    const counterOf = new WeakMap();
    let nextCounter = COUNTER.filled;
    let drawn = 0;
    const counted = { draws: 0, invocations: 0, streamedOut: 0, autoDraws: 0 };

    /** @param {string} name @param {number} bytes @param {number} [extra] */
    const scratchOf = (name, bytes, extra = 0)=>{
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
            buffer = backend.createDynamicBuffer({ label: `d3d11:geometry:${name}`, size,
                usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST | extra,
                keep: false, gpuOnly: true });
            scratch[name] = buffer;
        }
        buffer.markRead();
        return buffer;
    };

    /** @param {any} buffer @param {number} bytes @param {number} [offset] */
    const whole = (buffer, bytes, offset = 0)=>({ buffer: buffer.gpu, offset,
        size: Math.max(16, Math.ceil(bytes / 16) * 16) });

    /** The device's counters: each stream's statistics and each buffer's filled size. */
    const countersOf = ()=>{
        if (!counters)
        {
            counters = backend.createDynamicBuffer({ label: 'd3d11:stream-output:counters',
                size: MOST_COUNTERS * 4,
                usage: BufferUsage.STORAGE | BufferUsage.COPY_SRC | BufferUsage.COPY_DST,
                keep: false, gpuOnly: true });
        }
        counters.markRead();
        return counters;
    };

    /** @param {any} buffer the resource @returns {number} its counter, or -1 past the most */
    const counterFor = buffer=>{
        let index = counterOf.get(buffer);
        if (index === undefined)
        {
            if (nextCounter >= MOST_COUNTERS)
            {
                return -1;
            }
            index = nextCounter++;
            counterOf.set(buffer, index);
        }
        return index;
    };

    /** @param {(Uint32Array | null)[]} slots by `SLOT` */
    const paramsFor = slots=>{
        const at = drawn * SLOTS * UNIFORM_SLOT;
        const bytes = SLOTS * UNIFORM_SLOT;
        if (!params || params.size < at + bytes)
        {
            if (params)
            {
                backend.releaseDynamicBuffer(params);
            }
            params = backend.createDynamicBuffer({ label: 'd3d11:geometry:params',
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
        drawn++;
        return { gpu: params.gpu, at };
    };

    /** The arguments buffer, with this frame's next slot. */
    const argsFor = ()=>{
        const bytes = drawn * ARGS_SLOT;
        if (!args || args.size < bytes)
        {
            if (args)
            {
                backend.releaseDynamicBuffer(args);
            }
            args = backend.createDynamicBuffer({ label: 'd3d11:geometry:args',
                size: Math.max(4096, 2 * bytes),
                usage: BufferUsage.STORAGE | BufferUsage.INDIRECT | BufferUsage.COPY_SRC,
                keep: false, gpuOnly: true });
        }
        args.markRead();
        return { gpu: args.gpu, at: (drawn - 1) * ARGS_SLOT };
    };

    /**
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
     * The geometry stage a shader is, translated once: a vertex shader's
     * bytecode is a stage that passes on primitives of the draw's vertices.
     *
     * @param {any} shader @param {number} vertices  the draw's primitive, for a pass-through
     * @returns {{ gs: any, stage: import('./wgsl.js').GeometryStage }}
     */
    const stageOf = (shader, vertices)=>{
        let made = stages.get(shader);
        if (!made || (shader.passThrough && made.stage.inputVertices !== vertices))
        {
            const translated = services.translationOf(shader);
            made = shader.passThrough ? passThroughGeometry(translated, vertices)
                : { shader: translated, stage: geometryStage(shader.container, translated) };
            made = { gs: made.shader, stage: made.stage };
            stages.set(shader, made);
        }
        return made;
    };

    /** @param {any} resource @returns {object} a buffer bound as words, or zeros */
    const asWords = resource=>{
        const backing = resource ? services.backingOf(resource) : null;
        if (!backing || !backing.gpu || backing.gpu.size < 4)
        {
            const zeros = services.placeholder();
            return { buffer: zeros.gpu, offset: 0, size: 16 };
        }
        backing.gpu.markRead();
        const size = backing.gpu.gpu.size ?? Math.ceil(backing.gpu.size / 4) * 4;
        return { buffer: backing.gpu.gpu, offset: 0, size: size & ~3 };
    };

    /** The most primitives an instance of an indirect draw is sized for, its count unbounded. */
    const MOST_INDIRECT_PRIMITIVES = 16384;

    /**
     * An indirect draw as one of the most it may draw: its count bounded by
     * what the counter copied into it may hold (`CopyStructureCount`), else by
     * MOST_INDIRECT_PRIMITIVES, its instances as the program last wrote them;
     * and the copies of its count and instances into the words the geometry
     * shader stops at. Null where its arguments are on no GPU buffer.
     *
     * @param {any} draw @param {number} topology
     * @returns {{ draw: any, limit: any, copies: object[] } | null}
     */
    const indirectBounds = (draw, topology)=>{
        const { buffer, offset } = draw.indirect;
        const backing = services.backingOf(buffer);
        if (!backing?.gpu)
        {
            return null;
        }
        const indexed = draw.indexCount !== undefined;
        const host = new DataView(backing.bytes.buffer, backing.bytes.byteOffset,
            backing.bytes.byteLength);
        /** @param {number} k */
        const word = k=>(offset + 4 * k + 4 <= host.byteLength
            ? host.getUint32(offset + 4 * k, true) : 0);
        /** @param {number} k @returns {number | undefined} */
        const bound = k=>backing.counted?.get(offset + 4 * k);
        const vertices = TOPOLOGY_VERTICES[topology] ?? 3;
        let points = bound(0);
        if (points === undefined)
        {
            points = MOST_INDIRECT_PRIMITIVES * vertices;
            diverge(`an indirect draw through a geometry shader whose count no structure count`
                + ` bounds draws at most ${MOST_INDIRECT_PRIMITIVES} primitives an instance`);
        }
        const instances = Math.max(1, bound(1) ?? word(1));
        backing.gpu.markRead();
        const limit = scratchOf('indirect-limit', 16);
        const copy = (/** @type {number} */ k, /** @type {number} */ to)=>({ kind: 'copyBuffer',
            source: backing.gpu.gpu, sourceOffset: offset + 4 * k, destination: limit.gpu,
            destinationOffset: to, size: 4 });
        return {
            limit,
            copies: [copy(0, 0), copy(1, 4)],
            draw: indexed
                ? { ...draw, indirect: undefined, indexCount: points, instanceCount: instances,
                    startIndex: word(2), baseVertex: word(3) | 0, startInstance: word(4) }
                : { ...draw, indirect: undefined, vertexCount: points, instanceCount: instances,
                    startVertex: word(2), startInstance: word(3) },
        };
    };

    /**
     * The passes before a draw through a geometry shader, or null where the
     * draw makes nothing (said where Direct3D would have made something).
     *
     * @param {any} pipeline the device's state (`PipelineSnapshot`)
     * @param {{ vertexCount: number, startVertex: number, instanceCount?: number,
     *     indexCount?: number, startIndex?: number, baseVertex?: number,
     *     startInstance?: number, indirect?: any, auto?: any }} draw
     * @param {any} [tessellated]  the tessellator's passes before it (`tessellation.js`'s
     *     `prepare`), whose indices the geometry shader takes in place of the draw's
     * @returns {{ commands: any[], waits: Promise<any>[], gs: any,
     *     stage: import('./wgsl.js').GeometryStage, drawn: null | { stream: number,
     *     topology: string, group: object[], args: { gpu: any, offset: number },
     *     indexBuffer: { gpu: any, format: string, offset: number } } } | null}
     */
    const prepare = (pipeline, draw, tessellated = null)=>{
        const shader = pipeline.stages.gs.shader;
        const vertexShader = pipeline.stages.vs.shader;
        if (!vertexShader)
        {
            return null;
        }
        if (draw.auto || (draw.indirect && tessellated))
        {
            lose(`${draw.auto ? 'DrawAuto' : 'an indirect draw of patches'} through a geometry`
                + ' shader is not drawn: how many primitives it draws is on the GPU, and the'
                + ' passes before it are sized by it');
            return null;
        }
        // An indirect draw: its counts are on the GPU. The passes are sized
        // by the most it may draw and the geometry shader runs for what the
        // arguments hold (`gsLimit`, the count and the instances copied
        // there), the rest of the arguments as the program last wrote them.
        const indirect = draw.indirect ? indirectBounds(draw, pipeline.topology) : null;
        if (draw.indirect && !indirect)
        {
            return null;
        }
        if (indirect)
        {
            draw = indirect.draw;
        }
        const topology = tessellated ? TESSELLATED_TOPOLOGY[tessellated.topology] ?? 4
            : pipeline.topology;
        const vertices = TOPOLOGY_VERTICES[topology] ?? (topology >= 33 ? topology - 32 : 0);
        const { gs, stage } = stageOf(shader, Math.min(3, vertices));
        if (vertices !== stage.inputVertices)
        {
            lose(`a draw of primitives of ${vertices} vertices through a geometry shader that`
                + ` takes ${stage.inputVertices} is not drawn, as Direct3D draws none`);
            return null;
        }
        if (topology === 13)
        {
            lose('a triangle strip with adjacency through a geometry shader is not drawn');
            return null;
        }
        // The tessellator's instances are among its patches already.
        const indexed = !tessellated && draw.indexCount !== undefined;
        const points = tessellated ? tessellated.positions
            : indexed ? draw.indexCount ?? 0 : draw.vertexCount;
        const instances = tessellated ? 1 : draw.instanceCount ?? 1;
        const prims = STRIPS.includes(topology) ? Math.max(0, points - vertices + 1)
            : Math.floor(points / vertices);
        const invocations = instances * prims * stage.instances;
        if (invocations === 0)
        {
            return null;
        }
        const streams = stage.streams.length;
        const register = 16;
        const vpp = stage.outputVertices;
        const placesBytes = invocations * streams * stage.maxOut * stage.outputRegisters
            * register;
        const room = invocations * Math.max(1, stage.maxOut - vpp + 1);
        if (placesBytes > MOST_BYTES || instances * points * stage.inputRegisters * register
            > MOST_BYTES || streams * room * vpp * 4 > MOST_BYTES)
        {
            lose(`a draw of ${invocations} geometry shader invocations is not drawn: what they`
                + ' could make is past the room a buffer between the passes has');
            return null;
        }

        // 1. the vertex shader over every position of the draw, or the domain
        // shader over every index the tessellator wrote
        const vs = services.translationOf(vertexShader);
        const inputLayout = tessellated ? null : pipeline.inputLayout;
        const attributes = vs.inputs.filter((/** @type {any} */ element)=>
            element.systemValue === SYSTEM_VALUE.UNDEFINED
            && element.register < vs.inputRegisters)
            .map((/** @type {any} */ element)=>({ location: element.register,
                semantic: element.name, index: element.index }));
        const layout = tessellated ? { buffers: [], slots: [] } : inputLayout
            ? services.vertexLayouts(inputLayout, { attributes }, pipeline.vertexStrides)
            : attributes.length > 0 ? 'no input layout is bound' : { buffers: [], slots: [] };
        if (typeof layout === 'string')
        {
            lose(`a draw through a geometry shader is not drawn: ${layout}`);
            return null;
        }
        const domainShader = tessellated ? pipeline.stages.ds.shader : null;
        const hullShader = tessellated ? pipeline.stages.hs.shader : null;
        const linkedVertex = domainShader
            ? linkDomainPositions(services.translationOf(domainShader), domainShader.container,
                hullShader.container, tessellated.hull.stage, gs.inputs, stage.inputRegisters)
            : linkVertexPatches(vs, gs.inputs, stage.inputRegisters, layout.buffers);
        const vertexEntries = [...VERTEX_PATCH_ENTRIES, ...layout.buffers.map((_, k)=>
            entry(VERTEX_PATCH_BINDING.streams + k, COMPUTE, 'read-only-storage'))];
        const vertexPipeline = domainShader
            ? computeFor(`gs-ds:${idOf(domainShader)}|${idOf(hullShader)}|${idOf(shader)}|`
                + `${stage.inputVertices}`, linkedVertex.code, 'domainPositions',
            [linkedVertex.entries, DOMAIN_POSITION_ENTRIES],
            `d3d11:ds-geometry#${idOf(domainShader)}`, linkedVertex.unsupported)
            : computeFor(
                `gs-vs:${idOf(vertexShader)}|${idOf(shader)}|${stage.inputVertices}|`
                    + `${idOf(inputLayout)}|`
                    + `${layout.buffers.map(buffer=>`${buffer.stepMode}:${buffer.arrayStride}`)}`,
                linkedVertex.code, 'vertexPatches', [linkedVertex.entries, vertexEntries],
                `d3d11:vs-geometry#${idOf(vertexShader)}`, linkedVertex.unsupported);
        const indexBytes = indexed ? pipeline.indexFormat === DXGI_FORMAT.R16_UINT ? 2 : 4 : 0;
        const vertexParams = new Uint32Array(8 + 4 * Math.max(1, layout.buffers.length));
        vertexParams.set([instances * points, points, indexBytes, pipeline.indexOffset ?? 0,
            indexed ? draw.startIndex ?? 0 : draw.startVertex, (draw.baseVertex ?? 0) >>> 0,
            draw.startInstance ?? 0, 0]);
        layout.slots.forEach((slot, k)=>{
            vertexParams[8 + 4 * k] = pipeline.vertexOffsets[slot] ?? 0;
            vertexParams[8 + 4 * k + 1] = layout.buffers[k].arrayStride ?? 0;
        });
        const geometryParams = new Uint32Array([invocations, prims, topology, points,
            indexBytes, pipeline.indexOffset ?? 0, indexed ? draw.startIndex ?? 0 : 0, 0]);

        // Stream output, where the shader declares one.
        const declared = shader.streamOutput ?? null;
        const so = declared ? streamOutWrites(gs, declared.entries, declared.strides) : null;
        const soParams = new Uint32Array(20);
        /** @type {object[]} */
        const soBuffers = [];
        if (so)
        {
            for (let slot = 0; slot < 4; slot++)
            {
                const buffer = pipeline.streamOutput?.[slot] ?? null;
                const backing = buffer ? services.backingOf(buffer) : null;
                const counter = buffer ? counterFor(buffer) : -1;
                if (buffer && backing?.gpu && counter >= 0)
                {
                    backing.gpu.markRead();
                    backing.gpuDirty = true;
                    const size = (buffer.desc.ByteWidth ?? backing.gpu.size) & ~3;
                    soParams.set([counter, size, so.strides[slot], 1], slot * 4);
                    soBuffers.push({ binding: STREAM_OUT_BINDING.buffers + slot,
                        resource: { buffer: backing.gpu.gpu, offset: 0,
                            size: Math.max(4, size) } });
                }
                else
                {
                    if (buffer && counter < 0)
                    {
                        lose('a stream-output buffer past the most this device counts is not'
                            + ' written');
                    }
                    // A buffer of its own: two writable bindings may not share one.
                    soBuffers.push({ binding: STREAM_OUT_BINDING.buffers + slot,
                        resource: whole(scratchOf(`unbound-${slot}`, 16), 16) });
                }
            }
            soParams[16] = room;
        }

        const uniforms = paramsFor([vertexParams, null, geometryParams,
            new Uint32Array([invocations, room, vpp, 0]), new Uint32Array([invocations, room]),
            soParams]);
        /** @param {number} slot @param {number} bytes */
        const uniform = (slot, bytes)=>({ buffer: uniforms.gpu,
            offset: uniforms.at + slot * UNIFORM_SLOT, size: Math.ceil(bytes / 16) * 16 });
        const argSlot = argsFor();

        const vsBytes = instances * points * stage.inputRegisters * register;
        const vsOut = scratchOf('vertices', vsBytes);
        const places = scratchOf('places', placesBytes);
        const startsBytes = invocations * streams * stage.maxOut * 4;
        const starts = scratchOf('starts', startsBytes);
        const counts = scratchOf('counts', invocations * 32);
        const offsets = scratchOf('offsets', invocations * 16);
        const indicesBytes = streams * room * vpp * 4;
        const indices = scratchOf('indices', indicesBytes, BufferUsage.INDEX);

        const commands = [];
        // The tessellator's first word: the indices it wrote; an indirect
        // draw's count and instances, copied from its arguments.
        const limit = tessellated ? { buffer: tessellated.args.gpu, offset: tessellated.args.offset,
            size: 16 } : indirect ? { buffer: indirect.limit.gpu, offset: 0, size: 16 } : null;
        if (indirect)
        {
            commands.push(...indirect.copies);
        }
        if (domainShader && limit)
        {
            commands.push({
                kind: 'dispatch', what: 'a domain shader run before a geometry shader was skipped',
                ids: [], pipeline: vertexPipeline, label: 'd3d11:ds-geometry',
                groups: [
                    services.bindingsFor(pipeline.stages.ds, linkedVertex.entries),
                    [
                        ...tessellated.group,
                        { binding: DOMAIN_POSITION_BINDING.out, resource: whole(vsOut, vsBytes) },
                        { binding: DOMAIN_POSITION_BINDING.count, resource: limit },
                    ],
                ],
                grid: [Math.ceil(points / 64), 1, 1],
            });
        }
        else
        {
            commands.push({
                kind: 'dispatch', what: 'a vertex shader run before a geometry shader was skipped',
                ids: [], pipeline: vertexPipeline, label: 'd3d11:vs-geometry',
                groups: [
                    services.bindingsFor(pipeline.stages.vs, linkedVertex.entries),
                    [
                        { binding: VERTEX_PATCH_BINDING.indices,
                            resource: asWords(indexed ? pipeline.indexBuffer : null) },
                        { binding: VERTEX_PATCH_BINDING.out, resource: whole(vsOut, vsBytes) },
                        { binding: VERTEX_PATCH_BINDING.params,
                            resource: uniform(SLOT.vertex, vertexParams.byteLength) },
                        ...layout.slots.map((slot, k)=>({ binding: VERTEX_PATCH_BINDING.streams + k,
                            resource: asWords(pipeline.vertexBuffers[slot]) })),
                    ],
                ],
                grid: [Math.ceil((instances * points) / 64), 1, 1],
            });
        }

        // 2. the geometry shader
        const linked = linkGeometry(gs, stage, limit ? { limited: true, instanced: !!indirect }
            : {});
        const geometryPipeline = computeFor(
            `gs:${idOf(shader)}|${stage.inputVertices}${limit ? '|limited' : ''}`
                + `${indirect ? '|instanced' : ''}`,
            linked.code, 'geometryMain',
            [linked.entries, limit ? LIMITED_GEOMETRY_ENTRIES : GEOMETRY_ENTRIES],
            `d3d11:gs#${idOf(shader)}`, linked.unsupported);
        commands.push({
            kind: 'dispatch', what: 'a geometry shader was skipped', ids: [],
            pipeline: geometryPipeline, label: 'd3d11:gs',
            groups: [
                shader.passThrough ? []
                    : services.bindingsFor(pipeline.stages.gs, linked.entries),
                [
                    { binding: GEOMETRY_BINDING.inputs, resource: whole(vsOut, vsBytes) },
                    { binding: GEOMETRY_BINDING.indices,
                        resource: asWords(indexed ? pipeline.indexBuffer : null) },
                    { binding: GEOMETRY_BINDING.vertices, resource: whole(places, placesBytes) },
                    { binding: GEOMETRY_BINDING.starts, resource: whole(starts, startsBytes) },
                    { binding: GEOMETRY_BINDING.counts, resource: whole(counts,
                        invocations * 32) },
                    { binding: GEOMETRY_BINDING.params, resource: uniform(SLOT.geometry, 32) },
                    ...(limit ? [{ binding: GEOMETRY_BINDING.limit, resource: limit }] : []),
                ],
            ],
            grid: [Math.ceil(invocations / 64), 1, 1],
        });

        // 3-4. the sums and the lists
        const argsResource = { buffer: argSlot.gpu, offset: argSlot.at,
            size: 4 * STREAM_ARGS_WORDS * 4 };
        commands.push({ kind: 'dispatch', what: 'a geometry shader\'s sums were skipped', ids: [],
            pipeline: computeFor('gs-scan', GEOMETRY_SCAN_WGSL, 'scanGeometry', [SCAN_ENTRIES],
                'd3d11:geometry-scan'),
            label: 'd3d11:geometry-scan',
            groups: [[
                { binding: GEOMETRY_SCAN_BINDING.counts, resource: whole(counts,
                    invocations * 32) },
                { binding: GEOMETRY_SCAN_BINDING.offsets, resource: whole(offsets,
                    invocations * 16) },
                { binding: GEOMETRY_SCAN_BINDING.args, resource: argsResource },
                { binding: GEOMETRY_SCAN_BINDING.params, resource: uniform(SLOT.scan, 16) },
            ]],
            grid: [1, 1, 1] });
        const listKey = `${streams}|${stage.maxOut}|${vpp}`;
        commands.push({ kind: 'dispatch', what: 'a geometry shader\'s lists were skipped',
            ids: [],
            pipeline: computeFor(`gs-list:${listKey}`, geometryIndexWgsl({ streams,
                maxOut: stage.maxOut, outputVertices: vpp }), 'listGeometry', [INDEX_ENTRIES],
            'd3d11:geometry-list'),
            label: 'd3d11:geometry-list',
            groups: [[
                { binding: GEOMETRY_INDEX_BINDING.starts, resource: whole(starts, startsBytes) },
                { binding: GEOMETRY_INDEX_BINDING.counts, resource: whole(counts,
                    invocations * 32) },
                { binding: GEOMETRY_INDEX_BINDING.offsets, resource: whole(offsets,
                    invocations * 16) },
                { binding: GEOMETRY_INDEX_BINDING.indices, resource: whole(indices,
                    indicesBytes) },
                { binding: GEOMETRY_INDEX_BINDING.params, resource: uniform(SLOT.list, 16) },
            ]],
            grid: [Math.ceil(invocations / 64), 1, 1] });

        // 5. stream output
        /** @type {Promise<any>[]} */
        const waits = [vertexPipeline, geometryPipeline, ...tessellated?.waits ?? []];
        if (so && so.writes.length > 0)
        {
            const code = streamOutWgsl(stage, so.writes);
            const key = `so:${idOf(shader)}|${stage.inputVertices}`;
            const writer = computeFor(`${key}|out`, code, 'streamOut', [STREAM_OUT_ENTRIES],
                `d3d11:stream-out#${idOf(shader)}`);
            const done = computeFor(`${key}|done`, code, 'streamOutDone', [STREAM_OUT_ENTRIES],
                `d3d11:stream-out-done#${idOf(shader)}`);
            const group = [[
                { binding: STREAM_OUT_BINDING.vertices, resource: whole(places, placesBytes) },
                { binding: STREAM_OUT_BINDING.indices, resource: whole(indices, indicesBytes) },
                { binding: STREAM_OUT_BINDING.args, resource: argsResource },
                { binding: STREAM_OUT_BINDING.counters, resource: whole(countersOf(),
                    MOST_COUNTERS * 4) },
                { binding: STREAM_OUT_BINDING.params, resource: uniform(SLOT.out,
                    soParams.byteLength) },
                ...soBuffers,
            ]];
            commands.push({ kind: 'dispatch', what: 'stream output was skipped', ids: [],
                pipeline: writer, label: 'd3d11:stream-out', groups: group,
                grid: [Math.ceil((room * vpp) / 64), 1, 1] });
            commands.push({ kind: 'dispatch', what: 'stream output\'s counts were skipped',
                ids: [], pipeline: done, label: 'd3d11:stream-out-done', groups: group,
                grid: [1, 1, 1] });
            waits.push(writer, done);
            counted.streamedOut++;
        }
        counted.draws++;
        counted.invocations += invocations;

        // 6. the draw, of the rasterized stream
        const rasterized = shader.passThrough ? 0 : shader.rasterizedStream ?? 0;
        const slot = stage.streams.indexOf(rasterized);
        const rasterizes = rasterized !== SO_NO_RASTERIZED_STREAM && slot >= 0
            && !shader.passThrough;
        return {
            commands,
            waits,
            gs,
            stage,
            drawn: rasterizes ? {
                stream: rasterized,
                topology: LIST_TOPOLOGY[vpp],
                group: [{ binding: GEOMETRY_DRAW_BINDING.vertices,
                    resource: whole(places, placesBytes) }],
                args: { gpu: argSlot.gpu, offset: argSlot.at + slot * STREAM_ARGS_WORDS * 4 },
                indexBuffer: { gpu: indices.gpu, format: 'uint32', offset: 0 },
            } : null,
        };
    };

    /**
     * A bind of stream-output buffers: the filled size of each given an
     * offset is set to it, in its turn among the GPU's work; an offset of
     * -1 appends where the buffer's last stream output ended.
     *
     * @param {readonly any[]} buffers @param {readonly number[]} offsets
     * @returns {any | null} the command that sets them
     */
    const bind = (buffers, offsets)=>{
        const words = new Uint32Array(16);
        let any = false;
        buffers.slice(0, 4).forEach((buffer, slot)=>{
            const offset = offsets[slot] ?? 0;
            const counter = buffer ? counterFor(buffer) : -1;
            if (!buffer || counter < 0 || offset >>> 0 === 0xffffffff)
            {
                return;
            }
            words.set([counter, offset >>> 0, 1, 0], slot * 4);
            any = true;
        });
        if (!any)
        {
            return null;
        }
        const uniforms = paramsFor([words]);
        const zeros = services.placeholder();
        return {
            kind: 'dispatch', what: 'a stream-output bind\'s offsets were not set', ids: [],
            pipeline: computeFor('so-counter:set', COUNTER_WGSL, 'setFilled', [COUNTER_ENTRIES],
                'd3d11:stream-out-set'),
            label: 'd3d11:stream-out-set',
            groups: [[
                { binding: COUNTER_BINDING.counters, resource: whole(countersOf(),
                    MOST_COUNTERS * 4) },
                { binding: COUNTER_BINDING.params, resource: { buffer: uniforms.gpu,
                    offset: uniforms.at, size: 64 } },
                { binding: COUNTER_BINDING.args, resource: { buffer: zeros.gpu, offset: 0,
                    size: 16 } },
            ]],
            grid: [1, 1, 1],
        };
    };

    /**
     * The arguments of `DrawAuto`: the vertices stream output last left in
     * the buffer bound at the first vertex slot, after the bytes its offset
     * skips.
     *
     * @param {any} buffer @param {number} stride @param {number} offset
     * @returns {{ command: any, args: { gpu: any, offset: number } } | null}
     */
    const autoArgs = (buffer, stride, offset)=>{
        const counter = buffer ? counterFor(buffer) : -1;
        if (counter < 0)
        {
            return null;
        }
        const uniforms = paramsFor([new Uint32Array([counter, stride, offset, 0])]);
        const argSlot = argsFor();
        counted.autoDraws++;
        return {
            command: {
                kind: 'dispatch', what: 'DrawAuto\'s count was skipped', ids: [],
                pipeline: computeFor('so-counter:auto', COUNTER_WGSL, 'drawAuto',
                    [COUNTER_ENTRIES], 'd3d11:draw-auto'),
                label: 'd3d11:draw-auto',
                groups: [[
                    { binding: COUNTER_BINDING.counters, resource: whole(countersOf(),
                        MOST_COUNTERS * 4) },
                    { binding: COUNTER_BINDING.params, resource: { buffer: uniforms.gpu,
                        offset: uniforms.at, size: 64 } },
                    { binding: COUNTER_BINDING.args, resource: { buffer: argSlot.gpu,
                        offset: argSlot.at, size: 16 } },
                ]],
                grid: [1, 1, 1],
            },
            args: { gpu: argSlot.gpu, offset: argSlot.at },
        };
    };

    /**
     * A read-back of the streams' statistics where it is recorded, for a
     * query's beginning or end: `words` once the frame holding it is back.
     *
     * @returns {{ command: any, mark: { words: Uint32Array | null, failed: boolean } }}
     */
    const statistics = ()=>{
        const mark = { words: /** @type {Uint32Array | null} */ (null), failed: false };
        return {
            mark,
            command: {
                kind: 'readbackBuffer',
                ranges: [{ buffer: countersOf().gpu, offset: 0, size: COUNTER.filled * 4 }],
                /** @param {Uint8Array[] | null} results */
                deliver(results){
                    // A read-back is delivered once more, empty, after its frame.
                    if (mark.words)
                    {
                        return;
                    }
                    if (!results || !results[0])
                    {
                        mark.failed = true;
                        mark.words = new Uint32Array(COUNTER.filled);
                        return;
                    }
                    const bytes = results[0];
                    mark.words = new Uint32Array(bytes.buffer.slice(bytes.byteOffset,
                        bytes.byteOffset + COUNTER.filled * 4));
                },
            },
        };
    };

    return {
        prepare,
        bind,
        autoArgs,
        statistics,
        /** The frame is recorded: its uniform and argument slots are free again. */
        endFrame(){
            drawn = 0;
        },
        diagnostics: ()=>({ ...counted, counters: nextCounter - COUNTER.filled }),
    };
}
