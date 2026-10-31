/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a device context holds bound -- shaders, their slots, the input
 * assembler's buffers, the output merger's targets and states, the
 * rasterizer's viewports -- and the setters and getters a program reaches
 * it through.
 *
 * Direct3D 10's device and Direct3D 11's immediate context are one holder of
 * it; a deferred context is another, and the command list it records starts
 * from a cleared one. The methods are named as both APIs name them, and take
 * what the device's own methods take: objects, numbers, arrays.
 *
 * Binding an object takes no reference on it (`device.js`): what a slot
 * holds may be gone, and every read goes through `stillAlive`.
 */

import {
    D3D10_DEFAULTS, D3D10_LIMITS, D3D10_PRIMITIVE_TOPOLOGY,
    D3D11_KEEP_RENDER_TARGETS_AND_DEPTH_STENCIL, D3D11_KEEP_UNORDERED_ACCESS_VIEWS, D3D11_LIMITS,
    DXGI_FORMAT,
} from './constants.js';

/** @param {number} count @returns {any[]} */
export function emptySlots(count){
    return new Array(count).fill(null);
}

/**
 * A binding is not ownership in Direct3D 10, so what a slot holds may already
 * be gone. Direct3D 11's context keeps what it binds alive -- the program's
 * count may reach zero while it is bound, and a getter hands it back
 * (test_state_refcounting) -- which `bound` counts. This is the one place
 * that is decided, and everything that reads a slot goes through it.
 *
 * @param {any} object
 * @returns {any | null}
 */
export function stillAlive(object){
    return object && (object.refCount > 0 || object.bound > 0) ? object : null;
}

/** The per-stage half of the pipeline, the same for every shader stage. */
function createStage(){
    return {
        shader: /** @type {any} */ (null),
        constantBuffers: emptySlots(D3D10_LIMITS.CONSTANT_BUFFER_SLOTS),
        shaderResources: emptySlots(D3D10_LIMITS.SHADER_RESOURCE_SLOTS),
        samplers: emptySlots(D3D10_LIMITS.SAMPLER_SLOTS),
    };
}

/**
 * @param {any[]} slots
 * @param {number} startSlot
 * @param {number} count
 * @returns {any[]} the live objects in those slots, each with a new reference
 */
function readSlots(slots, startSlot, count){
    const result = [];
    for (let index = 0; index < count; index++)
    {
        const object = stillAlive(slots[startSlot + index]);
        if (object)
        {
            object.addRef();
        }
        result.push(object ?? null);
    }
    return result;
}

/** @param {any} object @returns {any} it, with a reference taken for the caller */
function handedOut(object){
    const alive = stillAlive(object);
    if (alive)
    {
        alive.addRef();
    }
    return alive;
}

/** The six shader stages, by their two-letter prefix. */
export const STAGES = Object.freeze(/** @type {const} */ (['vs', 'hs', 'ds', 'gs', 'ps', 'cs']));

/** Every slot a pixel shader and a compute shader may write through a view. */
const UAV_SLOTS = D3D11_LIMITS.UNORDERED_ACCESS_SLOTS_1;

/** Everything bound, as a fresh context holds it. */
function emptyPipeline(){
    return {
        stages: /** @type {Record<typeof STAGES[number], ReturnType<typeof createStage>>} */ (
            Object.fromEntries(STAGES.map(stage=>[stage, createStage()]))),
        inputLayout: /** @type {any} */ (null),
        vertexBuffers: emptySlots(D3D11_LIMITS.VERTEX_INPUT_SLOTS),
        vertexStrides: /** @type {number[]} */ (new Array(D3D11_LIMITS.VERTEX_INPUT_SLOTS).fill(0)),
        vertexOffsets: /** @type {number[]} */ (new Array(D3D11_LIMITS.VERTEX_INPUT_SLOTS).fill(0)),
        indexBuffer: /** @type {any} */ (null),
        indexFormat: /** @type {number} */ (DXGI_FORMAT.UNKNOWN),
        indexOffset: 0,
        topology: /** @type {number} */ (D3D10_PRIMITIVE_TOPOLOGY.UNDEFINED),
        renderTargets: emptySlots(D3D10_LIMITS.SIMULTANEOUS_RENDER_TARGETS),
        depthStencilView: /** @type {any} */ (null),
        /** What a pixel shader writes through, by slot: the slots past the targets. */
        pixelViews: emptySlots(UAV_SLOTS),
        /** What a compute shader writes through, by slot. */
        computeViews: emptySlots(UAV_SLOTS),
        blendState: /** @type {any} */ (null),
        blendFactor: /** @type {number[]} */ ([...D3D10_DEFAULTS.BLEND_FACTOR]),
        sampleMask: /** @type {number} */ (D3D10_DEFAULTS.SAMPLE_MASK),
        depthStencilState: /** @type {any} */ (null),
        stencilRef: 0,
        rasterizerState: /** @type {any} */ (null),
        /** @type {any[]} */
        viewports: [],
        /** @type {any[]} */
        scissorRects: [],
        streamOutput: emptySlots(D3D10_LIMITS.SO_BUFFER_SLOTS),
        /** @type {number[]} */
        streamOutputOffsets: new Array(D3D10_LIMITS.SO_BUFFER_SLOTS).fill(0),
        predicate: /** @type {any} */ (null),
        predicateValue: false,
    };
}

/** @typedef {ReturnType<typeof emptyPipeline>} Pipeline */

/**
 * A context's bindings and the methods over them.
 *
 * @param {{ diverge: (detail: string) => void, uavSlots?: number, keepsBound?: boolean }}
 *     services  where what is accepted and not done is said, how many view slots
 *     the device's level gives a stage that writes (8 or 64), and whether the
 *     context keeps what it binds alive -- Direct3D 11's does
 */
export function createPipelineState(services){
    const { diverge } = services;
    const uavSlots = services.uavSlots ?? D3D11_LIMITS.UNORDERED_ACCESS_SLOTS;
    const keeps = services.keepsBound === true;
    let pipeline = emptyPipeline();

    /** @param {any} object */
    const hold = object=>{
        if (object)
        {
            object.bound = (object.bound ?? 0) + 1;
        }
    };
    /** @param {any} object */
    const drop = object=>{
        if (object && object.bound > 0)
        {
            object.bound--;
            if (object.bound === 0)
            {
                object.unbound?.();
            }
        }
    };
    /**
     * A slot's new object in place of its old one: what a context that keeps
     * its bindings alive holds and lets go of.
     *
     * @param {any} old @param {any} value @returns {any} the value
     */
    const swap = (old, value)=>{
        if (keeps && old !== value)
        {
            hold(value);
            drop(old);
        }
        return value;
    };
    /**
     * Every object a pipeline binds, each handed to `each`.
     *
     * @param {Pipeline} bound @param {(object: any) => void} each
     */
    const everyBinding = (bound, each)=>{
        for (const stage of Object.values(bound.stages))
        {
            [stage.shader, ...stage.constantBuffers, ...stage.shaderResources,
                ...stage.samplers].forEach(each);
        }
        [bound.inputLayout, ...bound.vertexBuffers, bound.indexBuffer, ...bound.renderTargets,
            bound.depthStencilView, ...bound.pixelViews, ...bound.computeViews,
            bound.blendState, bound.depthStencilState, bound.rasterizerState,
            ...bound.streamOutput, bound.predicate].forEach(each);
    };
    /** @param {any[]} old @param {any[]} replacement @returns {any[]} the replacement */
    const replaced = (old, replacement)=>{
        if (keeps)
        {
            old.forEach(drop);
        }
        return replacement;
    };

    /**
     * @param {any[]} slots
     * @param {number} startSlot
     * @param {readonly any[]} values
     * @param {any} [absent]  What an unsupplied entry means: no object, or zero.
     */
    const writeSlots = (slots, startSlot, values, absent = null)=>{
        for (let index = 0; index < values.length; index++)
        {
            const slot = startSlot + index;
            if (slot < slots.length)
            {
                slots[slot] = absent === null ? swap(slots[slot], values[index] ?? null)
                    : values[index] ?? absent;
            }
        }
    };

    /** @param {typeof STAGES[number]} stage @param {string} prefix */
    const stageMethods = (stage, prefix)=>({
        /** @param {any} shader */
        [`${prefix}SetShader`](shader){
            pipeline.stages[stage].shader = swap(pipeline.stages[stage].shader, shader ?? null);
        },
        /** @param {{ shader?: any }} out */
        [`${prefix}GetShader`](out){
            out.shader = handedOut(pipeline.stages[stage].shader);
        },
        /** @param {number} startSlot @param {readonly any[]} buffers */
        [`${prefix}SetConstantBuffers`](startSlot, buffers){
            writeSlots(pipeline.stages[stage].constantBuffers, startSlot, buffers);
        },
        /** @param {number} startSlot @param {number} count @param {{ buffers?: any[] }} out */
        [`${prefix}GetConstantBuffers`](startSlot, count, out){
            out.buffers = readSlots(pipeline.stages[stage].constantBuffers, startSlot, count);
        },
        /** @param {number} startSlot @param {readonly any[]} views */
        [`${prefix}SetShaderResources`](startSlot, views){
            writeSlots(pipeline.stages[stage].shaderResources, startSlot, views);
        },
        /** @param {number} startSlot @param {number} count @param {{ views?: any[] }} out */
        [`${prefix}GetShaderResources`](startSlot, count, out){
            out.views = readSlots(pipeline.stages[stage].shaderResources, startSlot, count);
        },
        /** @param {number} startSlot @param {readonly any[]} samplers */
        [`${prefix}SetSamplers`](startSlot, samplers){
            writeSlots(pipeline.stages[stage].samplers, startSlot, samplers);
        },
        /** @param {number} startSlot @param {number} count @param {{ samplers?: any[] }} out */
        [`${prefix}GetSamplers`](startSlot, count, out){
            out.samplers = readSlots(pipeline.stages[stage].samplers, startSlot, count);
        },
    });

    const methods = {
        ...stageMethods('vs', 'VS'),
        ...stageMethods('hs', 'HS'),
        ...stageMethods('ds', 'DS'),
        ...stageMethods('gs', 'GS'),
        ...stageMethods('ps', 'PS'),
        ...stageMethods('cs', 'CS'),

        // --- input assembler ---

        /** @param {any} layout */
        IASetInputLayout(layout){
            pipeline.inputLayout = swap(pipeline.inputLayout, layout ?? null);
        },
        /** @param {{ layout?: any }} out */
        IAGetInputLayout(out){
            out.layout = handedOut(pipeline.inputLayout);
        },
        /**
         * @param {number} startSlot
         * @param {readonly any[]} buffers
         * @param {readonly number[]} strides
         * @param {readonly number[]} offsets
         */
        IASetVertexBuffers(startSlot, buffers, strides, offsets){
            writeSlots(pipeline.vertexBuffers, startSlot, buffers);
            writeSlots(pipeline.vertexStrides, startSlot, strides ?? [], 0);
            writeSlots(pipeline.vertexOffsets, startSlot, offsets ?? [], 0);
        },
        /**
         * @param {number} startSlot
         * @param {number} count
         * @param {{ buffers?: any[], strides?: number[], offsets?: number[] }} out
         */
        IAGetVertexBuffers(startSlot, count, out){
            out.buffers = readSlots(pipeline.vertexBuffers, startSlot, count);
            out.strides = pipeline.vertexStrides.slice(startSlot, startSlot + count);
            out.offsets = pipeline.vertexOffsets.slice(startSlot, startSlot + count);
        },
        /** @param {any} buffer @param {number} format @param {number} offset */
        IASetIndexBuffer(buffer, format, offset){
            pipeline.indexBuffer = swap(pipeline.indexBuffer, buffer ?? null);
            pipeline.indexFormat = format;
            pipeline.indexOffset = offset;
        },
        /** @param {{ buffer?: any, format?: number, offset?: number }} out */
        IAGetIndexBuffer(out){
            out.buffer = handedOut(pipeline.indexBuffer);
            out.format = pipeline.indexFormat;
            out.offset = pipeline.indexOffset;
        },
        /** @param {number} topology */
        IASetPrimitiveTopology(topology){
            pipeline.topology = topology;
        },
        /** @param {{ topology?: number }} out */
        IAGetPrimitiveTopology(out){
            out.topology = pipeline.topology;
        },

        // --- rasterizer ---

        /** @param {any} state */
        RSSetState(state){
            pipeline.rasterizerState = swap(pipeline.rasterizerState, state ?? null);
        },
        /** @param {{ state?: any }} out */
        RSGetState(out){
            out.state = handedOut(pipeline.rasterizerState);
        },
        /** @param {readonly any[]} viewports */
        RSSetViewports(viewports){
            // More than the pipeline has slots for is ignored whole, not cut
            // down to what fits.
            if ((viewports?.length ?? 0) > D3D10_LIMITS.VIEWPORT_AND_SCISSOR_SLOTS)
            {
                return;
            }
            pipeline.viewports = (viewports ?? []).map(viewport=>({ ...viewport }));
        },
        /** @param {{ count?: number, viewports?: any[] }} out */
        RSGetViewports(out){
            out.count = pipeline.viewports.length;
            out.viewports = pipeline.viewports.map(viewport=>({ ...viewport }));
        },
        /** @param {readonly any[]} rects */
        RSSetScissorRects(rects){
            pipeline.scissorRects = (rects ?? [])
                .slice(0, D3D10_LIMITS.VIEWPORT_AND_SCISSOR_SLOTS)
                .map(rect=>({ ...rect }));
        },
        /** @param {{ count?: number, rects?: any[] }} out */
        RSGetScissorRects(out){
            out.count = pipeline.scissorRects.length;
            out.rects = pipeline.scissorRects.map(rect=>({ ...rect }));
        },

        // --- output merger ---

        /** @param {readonly any[]} renderTargetViews @param {any} depthStencilView */
        OMSetRenderTargets(renderTargetViews, depthStencilView){
            pipeline.renderTargets = replaced(pipeline.renderTargets,
                emptySlots(D3D10_LIMITS.SIMULTANEOUS_RENDER_TARGETS));
            writeSlots(pipeline.renderTargets, 0, renderTargetViews ?? []);
            pipeline.depthStencilView = swap(pipeline.depthStencilView, depthStencilView ?? null);
        },
        /** @param {number} count @param {{ views?: any[], depthStencilView?: any }} out */
        OMGetRenderTargets(count, out){
            out.views = readSlots(pipeline.renderTargets, 0, count);
            out.depthStencilView = handedOut(pipeline.depthStencilView);
        },
        /**
         * Targets, and the views a pixel shader writes through from slot
         * `start` -- either half kept as it is by its own sentinel count.
         * A view slot overlapping a target, or past the level's slots, makes
         * the call do nothing, as the runtime drops it.
         *
         * @param {number} targetCount  D3D11_KEEP_RENDER_TARGETS_AND_DEPTH_STENCIL keeps them
         * @param {readonly any[]} renderTargetViews @param {any} depthStencilView
         * @param {number} start @param {number} viewCount  D3D11_KEEP_UNORDERED_ACCESS_VIEWS
         *     keeps them
         * @param {readonly any[]} views @param {readonly number[]} initialCounts
         */
        OMSetRenderTargetsAndUnorderedAccessViews(targetCount, renderTargetViews,
            depthStencilView, start, viewCount, views, initialCounts)
        {
            const keepTargets = targetCount === D3D11_KEEP_RENDER_TARGETS_AND_DEPTH_STENCIL;
            const keepViews = viewCount === D3D11_KEEP_UNORDERED_ACCESS_VIEWS;
            if (!keepViews && (start + viewCount > uavSlots
                || (!keepTargets && viewCount > 0 && start < targetCount)))
            {
                diverge('OMSetRenderTargetsAndUnorderedAccessViews with views over the targets'
                    + ' or past the slots is ignored');
                return;
            }
            if (!keepTargets)
            {
                pipeline.renderTargets = replaced(pipeline.renderTargets,
                    emptySlots(D3D10_LIMITS.SIMULTANEOUS_RENDER_TARGETS));
                writeSlots(pipeline.renderTargets, 0, renderTargetViews ?? []);
                pipeline.depthStencilView = swap(pipeline.depthStencilView,
                    depthStencilView ?? null);
            }
            if (!keepViews)
            {
                pipeline.pixelViews = replaced(pipeline.pixelViews, emptySlots(UAV_SLOTS));
                writeSlots(pipeline.pixelViews, start, views ?? []);
                (views ?? []).forEach((view, index)=>{
                    view?.setInitialCount?.(initialCounts?.[index] ?? 0xffffffff);
                });
            }
        },
        /**
         * @param {number} targetCount @param {number} start @param {number} viewCount
         * @param {{ views?: any[], depthStencilView?: any, unordered?: any[] }} out
         */
        OMGetRenderTargetsAndUnorderedAccessViews(targetCount, start, viewCount, out){
            out.views = readSlots(pipeline.renderTargets, 0, targetCount);
            out.depthStencilView = handedOut(pipeline.depthStencilView);
            out.unordered = readSlots(pipeline.pixelViews, start, viewCount);
        },
        /**
         * A null blend factor is not "all zero": it means the default, which is
         * white, and a program that passes null and then reads the factor back
         * sees ones.
         *
         * @param {any} state
         * @param {readonly number[] | null} blendFactor
         * @param {number} sampleMask
         */
        OMSetBlendState(state, blendFactor, sampleMask){
            pipeline.blendState = swap(pipeline.blendState, state ?? null);
            pipeline.blendFactor = blendFactor
                ? [...blendFactor]
                : [...D3D10_DEFAULTS.BLEND_FACTOR];
            pipeline.sampleMask = sampleMask >>> 0;
        },
        /** @param {{ state?: any, blendFactor?: number[], sampleMask?: number }} out */
        OMGetBlendState(out){
            out.state = handedOut(pipeline.blendState);
            out.blendFactor = [...pipeline.blendFactor];
            out.sampleMask = pipeline.sampleMask;
        },
        /** @param {any} state @param {number} stencilRef */
        OMSetDepthStencilState(state, stencilRef){
            pipeline.depthStencilState = swap(pipeline.depthStencilState, state ?? null);
            pipeline.stencilRef = stencilRef;
        },
        /** @param {{ state?: any, stencilRef?: number }} out */
        OMGetDepthStencilState(out){
            out.state = handedOut(pipeline.depthStencilState);
            out.stencilRef = pipeline.stencilRef;
        },

        // --- what a compute shader writes through ---

        /**
         * @param {number} start @param {readonly any[]} views
         * @param {readonly number[]} initialCounts  an append view's count, or ~0 to keep it
         */
        CSSetUnorderedAccessViews(start, views, initialCounts){
            if (start + (views?.length ?? 0) > uavSlots)
            {
                diverge('CSSetUnorderedAccessViews past the slots is ignored');
                return;
            }
            writeSlots(pipeline.computeViews, start, views ?? []);
            (views ?? []).forEach((view, index)=>{
                view?.setInitialCount?.(initialCounts?.[index] ?? 0xffffffff);
            });
        },
        /** @param {number} start @param {number} count @param {{ views?: any[] }} out */
        CSGetUnorderedAccessViews(start, count, out){
            out.views = readSlots(pipeline.computeViews, start, count);
        },

        // --- stream output and predication ---

        /** @param {readonly any[]} buffers @param {readonly number[]} offsets */
        SOSetTargets(buffers, offsets){
            if (buffers && buffers.some(buffer=>buffer))
            {
                diverge('a stream-output target is bound and never written');
            }
            pipeline.streamOutput = replaced(pipeline.streamOutput,
                emptySlots(D3D10_LIMITS.SO_BUFFER_SLOTS));
            writeSlots(pipeline.streamOutput, 0, (buffers ?? []).slice(0,
                D3D10_LIMITS.SO_BUFFER_SLOTS));
            pipeline.streamOutputOffsets = new Array(D3D10_LIMITS.SO_BUFFER_SLOTS).fill(0);
            writeSlots(pipeline.streamOutputOffsets, 0, (offsets ?? []).slice(0,
                D3D10_LIMITS.SO_BUFFER_SLOTS), 0);
        },
        /** @param {number} count @param {{ buffers?: any[], offsets?: number[] }} out */
        SOGetTargets(count, out){
            out.buffers = readSlots(pipeline.streamOutput, 0, count);
            out.offsets = pipeline.streamOutputOffsets.slice(0, count);
        },
        /** @param {any} predicate @param {boolean} value */
        SetPredication(predicate, value){
            if (predicate)
            {
                diverge('predication is recorded and never consulted: every draw runs');
            }
            pipeline.predicate = swap(pipeline.predicate, predicate ?? null);
            pipeline.predicateValue = !!value;
        },
        /** @param {{ predicate?: any, value?: boolean }} out */
        GetPredication(out){
            out.predicate = handedOut(pipeline.predicate);
            out.value = pipeline.predicateValue;
        },
    };

    return {
        methods,
        /** The bindings as they stand, for the device's own reads. */
        get pipeline(){
            return pipeline;
        },
        /**
         * Everything bound, with anything released since read as nothing: the
         * one moment a draw looks at the pipeline.
         *
         * @returns {import('./render.js').PipelineSnapshot}
         */
        snapshot(){
            /** @param {any[]} slots */
            const live = slots=>slots.map(stillAlive);
            /** @param {ReturnType<typeof createStage>} stage */
            const stageOf = stage=>({
                shader: stillAlive(stage.shader),
                constantBuffers: live(stage.constantBuffers),
                shaderResources: live(stage.shaderResources),
                samplers: live(stage.samplers),
            });
            return {
                stages: /** @type {any} */ (Object.fromEntries(STAGES.map(stage=>[stage,
                    stageOf(pipeline.stages[stage])]))),
                inputLayout: stillAlive(pipeline.inputLayout),
                vertexBuffers: live(pipeline.vertexBuffers),
                vertexStrides: pipeline.vertexStrides,
                vertexOffsets: pipeline.vertexOffsets,
                indexBuffer: stillAlive(pipeline.indexBuffer),
                indexFormat: pipeline.indexFormat,
                indexOffset: pipeline.indexOffset,
                topology: pipeline.topology,
                renderTargets: live(pipeline.renderTargets),
                depthStencilView: stillAlive(pipeline.depthStencilView),
                pixelViews: live(pipeline.pixelViews),
                computeViews: live(pipeline.computeViews),
                blendState: stillAlive(pipeline.blendState),
                blendFactor: pipeline.blendFactor,
                sampleMask: pipeline.sampleMask,
                depthStencilState: stillAlive(pipeline.depthStencilState),
                stencilRef: pipeline.stencilRef,
                rasterizerState: stillAlive(pipeline.rasterizerState),
                viewports: pipeline.viewports,
                scissorRects: pipeline.scissorRects,
            };
        },
        /**
         * Everything a program set goes back to the value a fresh device holds:
         * no bindings, no viewports at all -- not one covering the target -- a
         * white blend factor, a full sample mask, and an undefined topology.
         */
        clear(){
            if (keeps)
            {
                everyBinding(pipeline, drop);
            }
            pipeline = emptyPipeline();
        },
        /** The bindings, kept whole to be put back (`ExecuteCommandList`). */
        capture(){
            return pipeline;
        },
        /**
         * The bindings put in place of the ones there, which are handed back
         * still held: a context state keeps what its pipeline binds alive
         * while the context is on another (test_device_context_state).
         *
         * @param {Pipeline | null} next  null for bindings of nothing
         * @returns {Pipeline} the ones there were
         */
        exchange(next){
            const previous = pipeline;
            pipeline = next ?? emptyPipeline();
            return previous;
        },
        /** @param {Pipeline} kept bindings a context state let go of: its holds go too */
        letGo(kept){
            if (keeps)
            {
                everyBinding(kept, drop);
            }
        },
        /** @param {Pipeline} kept what `capture` gave */
        restore(kept){
            if (keeps)
            {
                everyBinding(pipeline, drop);
                everyBinding(kept, hold);
            }
            pipeline = kept;
        },
    };
}
