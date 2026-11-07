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
 * Group 0 of the pass is what a draw's stages read: the fixed block, the
 * stage's own uniforms, its samplers and its uniform blocks. Group 1 is what
 * the stage writes: its storage blocks, images and atomic counters.
 */

import { GLSL_BLOCK_BINDING, GLSL_COMPUTE_BINDING, samplerTypeOf, textureLayoutOf }
    from './glsl-wgsl.js';
import { generateGlslCompute } from './wgsl.js';

const COMPUTE_STAGE = 4;

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
     * @param {object[]} [writes]  group 1's layout and entries: what the stage writes
     * @returns {boolean} whether it was recorded
     */
    const dispatch = (context, request, scene, writes)=>{
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
        const groups = [layout];
        const given = [entries];
        if (writes && writes.length > 0)
        {
            groups.push(writes.map((/** @type {any} */ w)=>w.layout));
            given.push(writes.map((/** @type {any} */ w)=>w.entry));
            signature += `|${writes.map((/** @type {any} */ w)=>w.key).join(',')}`;
        }
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
        return true;
    };

    return { dispatch, stageFor };
}
