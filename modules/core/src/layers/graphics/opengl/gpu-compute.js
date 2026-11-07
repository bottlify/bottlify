/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A compute dispatch (OpenGL 4.3 chapter 19) as WebGPU makes it: the
 * program's one stage (`wgsl.js` generateGlslCompute) as a compute pass,
 * recorded in the context's recording among its draws, so that it runs
 * after the draws before it and before the ones after it, as GL orders them.
 *
 * Its one group is what a draw's stages bind: the fixed block, the stage's
 * own uniforms, its samplers and its uniform blocks, and what it writes: its
 * storage blocks and atomic counter buffers (`createGlMemory`).
 *
 * **What the device writes is the device's**: a pass or a draw that writes a
 * buffer object ends the recording it is in (the caller replays it at once),
 * so that bytes the program stores into the buffer later reach the device
 * after it, in a frame of their own; the buffer is marked `captured`, and a
 * read of it on this side waits for the device's copy (`readBuffer`).
 */

import {
    GLSL_BLOCK_BINDING, GLSL_COMPUTE_BINDING, GLSL_COUNTER_BINDING, GLSL_IMAGE_BINDING,
    GLSL_STORAGE_BINDING, samplerTypeOf, textureLayoutOf,
} from './glsl-wgsl.js';
import { IMAGE_FORMATS, STORAGE_BUFFER_OFFSET_ALIGNMENT } from './glsl-storage.js';
import { generateGlslCompute } from './wgsl.js';

const COMPUTE_STAGE = 4;

/**
 * @typedef {Object} MemoryServices
 * @property {any} backend
 * @property {(buffer: any) => any} bufferFor  a buffer object's GPU copy
 * @property {(texture: any, recording: any) => any} textureFor  a texture's GPU copy
 * @property {(detail: string) => void} lose
 */

/**
 * @typedef {Object} MemoryBinding
 * @property {object[]} layout  the bind group layout's entries
 * @property {object[]} entries  the bind group's
 * @property {string} key  what the layout's shape adds to a pipeline's key
 * @property {boolean} writes  whether the stage writes a buffer object
 */

/**
 * The buffer objects a stage's storage blocks and atomic counters reach, at
 * the ranges bound to their binding points.
 *
 * @param {MemoryServices} services
 */
export function createGlMemory(services){
    /** Storage a block with nothing bound reads and writes, by size. @type {any} */
    let spare = null;
    /** @param {number} size */
    const spareOf = size=>{
        if (!spare || spare.size < size)
        {
            spare = services.backend.createDynamicBuffer({ size: Math.max(size, 256),
                usage: 0x80 | 0x8, label: 'gl-spare-storage' });
        }
        return spare.gpu;
    };

    /**
     * @param {{ buffer: any, offset: number, size: number } | null | undefined} bound
     * @param {number} least  the bytes the stage reaches at the least
     * @param {number} recording  the recording's id, which reads the range
     * @param {string} what  for a divergence
     * @returns {{ buffer: any, offset: number, size: number } | null}
     */
    const rangeOf = (bound, least, recording, what)=>{
        if (!bound)
        {
            services.lose(`${what} has no buffer bound: what it read was zero and what it`
                + ' wrote was dropped');
            return null;
        }
        if (bound.offset % STORAGE_BUFFER_OFFSET_ALIGNMENT !== 0)
        {
            services.lose(`${what} is bound at offset ${bound.offset}, which WebGPU does not`
                + ` bind storage at (a multiple of ${STORAGE_BUFFER_OFFSET_ALIGNMENT}): it read`
                + ' zero and wrote nothing');
            return null;
        }
        const size = Math.min(bound.size, bound.buffer.size - bound.offset) & ~3;
        if (size < Math.max(4, least))
        {
            services.lose(`${what} is bound to ${size} bytes, fewer than the ${least} it`
                + ' holds: it read zero and wrote nothing');
            return null;
        }
        const backing = services.bufferFor(bound.buffer);
        backing.reads.note(recording, bound.offset, bound.offset + size);
        return { buffer: backing.gpu.gpu, offset: bound.offset, size };
    };

    /**
     * @param {import('./pipeline.js').Scene} scene @param {any} executable
     * @param {{ storage?: number[], written?: number[], counters?: number[],
     *     images?: import('./glsl-wgsl.js').UsedImage[] }} stage
     * @param {any} recorded  the recording the command goes into
     * @param {number} visibility
     * @returns {MemoryBinding}
     */
    const bind = (scene, executable, stage, recorded, visibility)=>{
        const recording = recorded.id;
        /** @type {MemoryBinding} */
        const out = { layout: [], entries: [], key: '', writes: false };
        const linked = executable.linked;
        for (const index of stage.storage ?? [])
        {
            const block = linked.storageBlocks[index];
            const point = executable.storageBindings?.[index] ?? block.binding;
            const bound = scene.storageBuffers?.[point];
            const written = (stage.written ?? []).includes(index);
            const least = block.size + block.runtimeStride;
            const range = rangeOf(bound, least, recording,
                `shader storage block '${block.name}' (binding ${point})`);
            if (range && written && bound)
            {
                bound.buffer.captured = true;
                out.writes = true;
            }
            const binding = GLSL_STORAGE_BINDING + index;
            out.layout.push({ binding, visibility, buffer: { type: 'storage' } });
            out.entries.push({ binding, resource: range
                ?? { buffer: spareOf(least), offset: 0, size: Math.max(4, least) } });
            out.key += `s${index}`;
        }
        for (const binding of stage.counters ?? [])
        {
            const reach = Math.max(...linked.counters.filter((/** @type {any} */ c)=>
                c.binding === binding).map((/** @type {any} */ c)=>c.offset + 4 * c.count));
            const bound = scene.counterBuffers?.[binding];
            const range = rangeOf(bound, reach, recording,
                `the atomic counter buffer at binding ${binding}`);
            if (range && bound)
            {
                bound.buffer.captured = true;
                out.writes = true;
            }
            out.layout.push({ binding: GLSL_COUNTER_BINDING + binding, visibility,
                buffer: { type: 'storage' } });
            out.entries.push({ binding: GLSL_COUNTER_BINDING + binding, resource: range
                ?? { buffer: spareOf(reach), offset: 0, size: Math.max(4, reach) } });
            out.key += `c${binding}`;
        }
        for (const { index, access, format, viewDimension } of stage.images ?? [])
        {
            const image = linked.images[index];
            const unit = executable.ints[image.leaf.offset + image.element];
            const view = imageView(scene.imageUnits?.[unit], unit, format, viewDimension,
                recorded);
            if (view && access !== 'read-only')
            {
                out.writes = true;
            }
            const binding = GLSL_IMAGE_BINDING + index;
            out.layout.push({ binding, visibility, storageTexture: { access, format,
                viewDimension } });
            out.entries.push({ binding, resource: view ?? spareImage(format, viewDimension) });
            out.key += `i${index}${access}${format}${viewDimension}`;
        }
        return out;
    };

    /**
     * The view of the level and layers an image unit binds, as the shader
     * declared it, or null - said - where WebGPU cannot show it so.
     *
     * @param {{ texture: any, level: number, layered: boolean, layer: number,
     *     format: number } | null | undefined} bound
     * @param {number} unit @param {string} format @param {string} viewDimension
     * @param {any} recorded
     */
    const imageView = (bound, unit, format, viewDimension, recorded)=>{
        const what = `image unit ${unit}`;
        if (!bound?.texture)
        {
            services.lose(`${what} has no texture bound: its loads read zero and its stores`
                + ' were dropped');
            return null;
        }
        const unitFormat = IMAGE_FORMATS.find(([, gl])=>gl === bound.format)?.[2];
        const copy = services.textureFor(bound.texture, recorded);
        if (unitFormat !== format || copy.format !== format)
        {
            services.lose(`${what} binds a texture of ${copy.format} as ${unitFormat
                ?? `format 0x${bound.format.toString(16)}`} to an image of ${format}: WebGPU`
                + ' views a storage texture in its own format alone, and nothing was read or'
                + ' written');
            return null;
        }
        const whole = viewDimension === '2d-array' || viewDimension === '3d';
        if (whole !== (bound.layered || viewDimension === '3d'))
        {
            services.lose(`${what} binds ${bound.layered ? 'every layer' : 'one layer'} to an`
                + ` image of ${viewDimension}, which WebGPU does not view so: nothing was read`
                + ' or written');
            return null;
        }
        if (bound.level >= copy.levels)
        {
            services.lose(`${what} binds level ${bound.level}, which the texture lacks`);
            return null;
        }
        return copy.gpu.texture.createView({ label: `gl-image:${unit}`, format,
            dimension: viewDimension, baseMipLevel: bound.level, mipLevelCount: 1,
            ...whole ? {} : { baseArrayLayer: bound.layer, arrayLayerCount: 1 } });
    };

    /** Storage textures an image with nothing usable bound reaches, by shape. */
    /** @type {Map<string, any>} */
    const spareImages = new Map();
    /** @param {string} format @param {string} viewDimension */
    const spareImage = (format, viewDimension)=>{
        const key = `${format}|${viewDimension}`;
        let view = spareImages.get(key);
        if (!view)
        {
            const surface = services.backend.createSurface({ width: 1,
                height: 1, format, label: `gl-spare-image:${key}`,
                dimension: viewDimension === '3d' ? '3d' : undefined,
                // STORAGE_BINDING and TEXTURE_BINDING.
                usage: 0x08 | 0x04 });
            view = surface.texture.createView({ format, dimension: viewDimension });
            spareImages.set(key, view);
        }
        return view;
    };

    return { bind };
}

/**
 * @typedef {Object} ComputeServices
 * @property {any} backend
 * @property {(context: object) => any} recordingOf
 * @property {(context: object) => boolean} attached
 * @property {(context: object, scene: any) => Float64Array} mvpFor
 * @property {(context: object, scene: any, mvp: Float64Array) => Float32Array} uniformsOf
 * @property {(plan: any, executable: any, scene: any, mvp: Float64Array) => ArrayBufferView}
 *     glslUniforms
 * @property {(view: ArrayBufferView) => { gpu: any, offset: number }} uniform
 * @property {(scene: any, executable: any, entry: any) => any} textureForSampler
 * @property {(texture: any, recording: any) => any} textureFor
 * @property {(texture: any, filtered: boolean, compared: boolean) => any} samplerFor
 * @property {(scene: any, executable: any, blocks: number[], recording: any) => object[]}
 *     uniformBlocksFor
 * @property {(scene: any, executable: any) => string} samplerSwizzlesOf
 * @property {(buffer: any) => any} bufferFor  a buffer object's GPU copy
 * @property {(recording: any, work: object[]) => void} dispatchAll
 * @property {(detail: string, severity?: 'loss') => void} diverge
 * @property {ReturnType<typeof createGlMemory>} memory
 * @property {(context: object) => void} wrote  the context's recording ends now: a
 *     pass in it wrote buffer objects
 */

/**
 * @param {ComputeServices} services
 */
export function createGlCompute(services){
    const { backend } = services;
    /** @type {WeakMap<object, Map<string, ReturnType<typeof generateGlslCompute>>>} */
    const generated = new WeakMap();
    /** @type {Map<string, Promise<{ gpu: any, layouts: any[] }>>} */
    const pipelines = new Map();
    let nextModule = 0;
    /** @type {WeakMap<object, number>} */
    const moduleIds = new WeakMap();

    /**
     * The stage's WGSL for a program and the swizzles its samplers read
     * through, made once.
     *
     * @param {any} linked @param {string} swizzles
     */
    const stageFor = (linked, swizzles)=>{
        let byKey = generated.get(linked);
        if (!byKey)
        {
            byKey = new Map();
            generated.set(linked, byKey);
        }
        let stage = byKey.get(swizzles);
        if (!stage)
        {
            stage = generateGlslCompute(linked, swizzles ? new Map(swizzles.split(',')
                .map(entry=>{
                    const [index, code] = entry.split(':');
                    return [Number(index), code];
                })) : undefined);
            byKey.set(swizzles, stage);
            moduleIds.set(stage, nextModule++);
        }
        return stage;
    };

    /**
     * @param {string} key @param {string} code @param {object[][]} groups
     * @returns {Promise<{ gpu: any, layouts: any[] }>}
     */
    const pipelineFor = (key, code, groups)=>{
        let promise = pipelines.get(key);
        if (!promise)
        {
            promise = (async()=>{
                const module = await backend.createShaderModule({ code, label: 'gl:compute' });
                const layouts = groups.map((entries, index)=>backend.createBindGroupLayout({
                    label: `gl:compute:${index}`, entries }));
                const gpu = await backend.createComputePipelineAsync({
                    label: 'gl:compute',
                    layout: backend.createPipelineLayout({ label: 'gl:compute',
                        bindGroupLayouts: layouts }),
                    compute: { module, entryPoint: 'computeMain' },
                });
                return { gpu, layouts };
            })();
            pipelines.set(key, promise);
        }
        return promise;
    };

    /**
     * Records a dispatch of the current program's compute stage.
     *
     * @param {object} context
     * @param {{ grid: [number, number, number] }
     *     | { indirect: { buffer: any, offset: number } }} request
     * @param {any} scene
     * @returns {boolean} whether it was recorded
     */
    const dispatch = (context, request, scene)=>{
        if (!services.attached(context))
        {
            return false;
        }
        const executable = scene.programs.glsl;
        if (!executable?.linked.compute)
        {
            return false;
        }
        const swizzles = services.samplerSwizzlesOf(scene, executable);
        const stage = stageFor(executable.linked, swizzles);
        if (stage.error)
        {
            services.diverge(`a compute dispatch was refused and ran nothing: ${stage.error}`,
                'loss');
            return true;
        }
        const recording = services.recordingOf(context);
        const mvp = services.mvpFor(context, scene);
        /** @param {ArrayBufferView} view */
        const uniform = view=>{
            const written = services.uniform(view);
            return { buffer: written.gpu, offset: written.offset,
                size: Math.ceil(view.byteLength / 16) * 16 };
        };
        /** @type {object[]} */
        const layout = [{ binding: 0, visibility: COMPUTE_STAGE, buffer: { type: 'uniform' } }];
        /** @type {object[]} */
        const entries = [{ binding: 0, resource: uniform(services.uniformsOf(context, scene,
            mvp)) }];
        let signature = '';
        if (stage.plan)
        {
            layout.push({ binding: GLSL_COMPUTE_BINDING, visibility: COMPUTE_STAGE,
                buffer: { type: 'uniform' } });
            entries.push({ binding: GLSL_COMPUTE_BINDING, resource: uniform(
                services.glslUniforms(stage.plan, executable, scene, mvp)) });
        }
        for (const index of stage.samplers)
        {
            const textureLayout = textureLayoutOf(samplerTypeOf(executable.linked.samplers[index]));
            const entry = { binding: 1 + index * 2, unit: -1, sampler: index,
                cube: textureLayout.viewDimension === 'cube', layout: textureLayout };
            const texture = services.textureForSampler(scene, executable, entry);
            const copy = services.textureFor(texture, recording);
            const kind = copy.kind ?? 'f';
            const compared = textureLayout.sampleType === 'depth';
            const loaded = textureLayout.sampleType === 'sint'
                || textureLayout.sampleType === 'uint';
            const unfilterable = kind === 'u' && !compared && !loaded;
            signature += kind;
            layout.push({ binding: entry.binding, visibility: COMPUTE_STAGE, texture: {
                viewDimension: textureLayout.viewDimension,
                sampleType: textureLayout.sampleType !== 'float' ? textureLayout.sampleType
                    : unfilterable ? 'unfilterable-float' : 'float',
                multisampled: textureLayout.multisampled } },
            { binding: entry.binding + 1, visibility: COMPUTE_STAGE, sampler: {
                type: compared ? 'comparison' : unfilterable ? 'non-filtering'
                    : 'filtering' } });
            entries.push({ binding: entry.binding, resource: copy.sampleView ?? copy.gpu.view },
                { binding: entry.binding + 1, resource: services.samplerFor(texture,
                    kind === 'f' || compared || loaded, compared) });
        }
        for (const index of stage.blocks)
        {
            layout.push({ binding: GLSL_BLOCK_BINDING + index, visibility: COMPUTE_STAGE,
                buffer: { type: 'uniform' } });
            entries.push(...services.uniformBlocksFor(scene, executable, [index], recording));
        }
        const memory = services.memory.bind(scene, executable, stage, recording,
            COMPUTE_STAGE);
        layout.push(...memory.layout);
        entries.push(...memory.entries);
        signature += `|${memory.key}`;
        const groups = [layout];
        const given = [entries];
        /** @type {[number, number, number] | { buffer: any, offset: number }} */
        let grid;
        if ('indirect' in request)
        {
            const backing = services.bufferFor(request.indirect.buffer);
            backing.reads.note(recording.id, request.indirect.offset,
                request.indirect.offset + 12);
            grid = { buffer: backing.gpu.gpu, offset: request.indirect.offset };
        }
        else
        {
            grid = request.grid;
        }
        services.dispatchAll(recording, [{
            pipeline: pipelineFor(`${moduleIds.get(stage)}|${signature}`, stage.code, groups),
            label: 'gl:compute', groups: given, grid,
        }]);
        if (memory.writes)
        {
            services.wrote(context);
        }
        return true;
    };

    return { dispatch, stageFor };
}
