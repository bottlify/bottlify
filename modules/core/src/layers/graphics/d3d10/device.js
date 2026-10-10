/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D 10 device, and the two entry points that produce one.
 *
 * Nothing here draws. What it models is everything a program can find out about
 * a device between draws: what it agreed to create, what those objects report
 * about themselves, what is currently bound, and what a reference count says.
 *
 * Four conventions run through the file, and three of them are inherited from
 * the object model rather than invented here:
 *
 * - **A creation method returns an HRESULT and writes its result into a record
 *   the caller supplies**, the way the guest passes a pointer. A failed call
 *   sets that record to null rather than leaving it alone -- programs read it
 *   back without checking, and this API clears it for them.
 * - **A *setting* method returns nothing at all.** That is not a shortcut: in
 *   this version of Direct3D the pipeline setters are `void`, and a rejected
 *   argument is reported to the debug layer rather than to the caller. Giving
 *   them a return value would invent a contract programs cannot use.
 * - **Creating an object takes a reference on the device; binding one takes
 *   nothing.** This is the single most surprising rule in the API and the one
 *   worth stating twice. A program may bind a texture view and then release its
 *   last reference to it, and the device does *not* keep it alive; asking for
 *   what is bound then answers with nothing. Wine's own tests carry that
 *   expectation as a known failure, which is a good sign of how easy it is to
 *   get wrong by being helpful.
 * - **A device is not lost.** There is no equivalent of the older APIs' lost
 *   state to model; what replaced it is a removal reason, which stays `S_OK`
 *   for as long as the device works.
 */

import { attachCom } from './com.js';
import {
    D3D10_BIND, D3D10_CREATE_DEVICE, D3D10_CREATE_DEVICE_MASK, D3D10_DEFAULTS, D3D10_DRIVER_TYPE,
    D3D10_DRIVER_TYPES, D3D10_LIMITS, D3D10_PRIMITIVE_TOPOLOGY, D3D10_QUERY,
    D3D10_RESOURCE_DIMENSION, D3D10_RESOURCE_MISC, D3D10_SDK_VERSION, D3D10_1_SDK_VERSION,
    D3D10_USAGE,
    DXGI_ERROR_INVALID_CALL, DXGI_ERROR_UNSUPPORTED, DXGI_FORMAT, D3D_FEATURE_LEVEL, E_FAIL,
    E_INVALIDARG, E_NOTIMPL, FORMAT_INFO, FORMAT_KIND, IID, S_FALSE, S_OK,
} from './constants.js';
import { SHADER_KIND, SYSTEM_VALUE, parseDxbc, parseShaderOfKind } from './dxbc.js';
import { createFactory } from './dxgi.js';
import { INDEX_FORMAT, VERTEX_FORMAT, textureStorage } from './gpuformats.js';
import { createDrawStatistics, createQueryObject } from './queries.js';
import { createRenderer } from './render.js';
import {
    VIEW_KINDS, createResource, createView, resolveMipLevels, resolveViewDesc, textureInterfaces,
} from './resources.js';
import { STATE_KIND, createStateStore } from './states.js';
import { bindFlagsForUsage, bufferCreateResult, textureCreateResult } from './validity.js';

/**
 * @typedef {import('./render.js').SubresourceData} SubresourceData
 * @typedef {import('./render.js').Box} Box
 * @typedef {import('./render.js').StageBindings} StageBindings
 * @typedef {import('./render.js').PipelineSnapshot} PipelineSnapshot
 */

/** D3D10_FORMAT_SUPPORT bits, the ones this device can claim. */
const FORMAT_SUPPORT = Object.freeze({
    BUFFER: 0x1,
    IA_VERTEX_BUFFER: 0x2,
    IA_INDEX_BUFFER: 0x4,
    TEXTURE1D: 0x10,
    TEXTURE2D: 0x20,
    TEXTURE3D: 0x40,
    TEXTURECUBE: 0x80,
    SHADER_LOAD: 0x100,
    SHADER_SAMPLE: 0x200,
    SHADER_SAMPLE_COMPARISON: 0x400,
    MIP: 0x1000,
    MIP_AUTOGEN: 0x2000,
    RENDER_TARGET: 0x4000,
    BLENDABLE: 0x8000,
    DEPTH_STENCIL: 0x10000,
    CPU_LOCKABLE: 0x20000,
    DISPLAY: 0x80000,
});

/** The frames a DXGI device queues ahead unless told otherwise, and the most it will. */
const DEFAULT_FRAME_LATENCY = 3;
const MAXIMUM_FRAME_LATENCY = 16;

/** The query kinds that are also predicates. */
const PREDICATE_QUERIES = new Set([
    D3D10_QUERY.OCCLUSION_PREDICATE, D3D10_QUERY.SO_OVERFLOW_PREDICATE,
]);

/**
 * @typedef {Object} DeviceOptions
 * @property {any} [adapter]   The adapter the device runs on; one is made if absent.
 * @property {(format: number, sampleCount: number) => number} [multisampleQualityLevels]
 * @property {import('./dxgi.js').FactoryOptions} [factoryOptions]
 * @property {any} [backend]   The GPU backend; absent, the device keeps state and never draws.
 * @property {(descriptor: object) => any} [createSampler]
 * @property {(descriptor: object) => any} [createTexture]
 * @property {(api: string, detail: string) => void} [divergence]
 *     Where a call that succeeded without doing all it promises is reported.
 * @property {() => number} [now]  Milliseconds, for a timestamp query.
 * @property {boolean} [compressedTextures]  Whether the GPU samples BC blocks as they are;
 *     without it a block-compressed texture is decoded on the processor.
 * @property {boolean} [depthClipControl]  Whether the GPU device can leave depth
 *     unclipped, as a rasterizer state with DepthClipEnable FALSE asks.
 * @property {import('../webgpu/internal/latency.js').FrameQueued} [frameQueued]
 *     Told of every frame a swap chain's present queues; what it answers is
 *     what the present waits on before it answers the program.
 */

/**
 * The multisample support a backend with no multisampling reports: one sample
 * at one quality level, and nothing beyond that.
 *
 * @param {number} format
 * @param {number} sampleCount
 * @returns {number}
 */
function noMultisampling(format, sampleCount){
    return sampleCount === 1 ? 1 : 0;
}

/**
 * @param {any} adapter
 * @param {number} driverType
 * @param {any} software
 * @param {number} flags
 * @param {number} sdkVersion
 * @param {{ device?: any }} out
 * @param {DeviceOptions} [options]
 * @returns {number} S_OK or E_INVALIDARG
 */
export function D3D10CreateDevice(adapter, driverType, software, flags, sdkVersion, out,
    options = {})
{
    if (!out)
    {
        return E_INVALIDARG;
    }
    out.device = null;
    // The version the caller's headers were built against. Refusing anything
    // else is how a mismatched runtime is caught here rather than as nonsense
    // much deeper in.
    if (sdkVersion !== D3D10_SDK_VERSION)
    {
        return E_INVALIDARG;
    }
    if (!D3D10_DRIVER_TYPES.includes(driverType))
    {
        return E_INVALIDARG;
    }
    if ((flags & ~D3D10_CREATE_DEVICE_MASK) !== 0)
    {
        return E_INVALIDARG;
    }
    // A software driver is a module the caller supplies, and no other driver
    // type has anywhere to put one.
    if ((driverType === D3D10_DRIVER_TYPE.SOFTWARE) !== !!software)
    {
        return E_INVALIDARG;
    }
    out.device = createDevice({ ...options, adapter, flags });
    return S_OK;
}

/** D3D10_SRV_DIMENSION1_TEXTURECUBEARRAY: a view Direct3D 10.1 added. */
const D3D10_SRV_DIMENSION1_TEXTURECUBEARRAY = 10;

/**
 * The feature levels Direct3D 10.1's entry points name.
 *
 * @type {readonly number[]}
 */
const FEATURE_LEVELS_1 = Object.freeze([
    D3D_FEATURE_LEVEL.LEVEL_10_1, D3D_FEATURE_LEVEL.LEVEL_10_0, D3D_FEATURE_LEVEL.LEVEL_9_3,
    D3D_FEATURE_LEVEL.LEVEL_9_2, D3D_FEATURE_LEVEL.LEVEL_9_1,
]);

/**
 * Whether a Direct3D 10.1 entry point's version and level can be met: its own
 * SDK version, and of the levels it may name, 10.0 -- the one this device
 * is. 10.1 needs cube arrays and more samples than this renderer has, and the
 * 9.x levels restrictions it does not enforce, so both are refused the way an
 * adapter without them refuses them.
 *
 * @param {number} featureLevel
 * @param {number} sdkVersion
 * @returns {number}
 */
function featureLevelResult(featureLevel, sdkVersion){
    if (sdkVersion !== D3D10_1_SDK_VERSION || !FEATURE_LEVELS_1.includes(featureLevel))
    {
        return E_INVALIDARG;
    }
    return featureLevel === D3D_FEATURE_LEVEL.LEVEL_10_0 ? S_OK : DXGI_ERROR_UNSUPPORTED;
}

/**
 * HRESULT D3D10CreateDevice1(IDXGIAdapter*, D3D10_DRIVER_TYPE, HMODULE, UINT,
 * D3D10_FEATURE_LEVEL1, UINT, ID3D10Device1**). Unlike the 10.0 entry point
 * it has no use for a null device pointer.
 *
 * @param {any} adapter
 * @param {number} driverType
 * @param {any} software
 * @param {number} flags
 * @param {number} featureLevel
 * @param {number} sdkVersion
 * @param {{ device?: any } | null} out
 * @param {DeviceOptions} [options]
 * @returns {number}
 */
export function D3D10CreateDevice1(adapter, driverType, software, flags, featureLevel,
    sdkVersion, out, options = {})
{
    if (!out)
    {
        return E_INVALIDARG;
    }
    out.device = null;
    const hr = featureLevelResult(featureLevel, sdkVersion);
    return hr === S_OK
        ? D3D10CreateDevice(adapter, driverType, software, flags, D3D10_SDK_VERSION, out, options)
        : hr;
}

/**
 * @param {any} adapter
 * @param {number} driverType
 * @param {any} software
 * @param {number} flags
 * @param {number} featureLevel
 * @param {number} sdkVersion
 * @param {import('./structs.js').SwapChainFields | null} swapChainDesc
 * @param {{ swapChain?: any } | null} swapChainOut
 * @param {{ device?: any } | null} deviceOut
 * @param {DeviceOptions} [options]
 * @returns {number}
 */
export function D3D10CreateDeviceAndSwapChain1(adapter, driverType, software, flags,
    featureLevel, sdkVersion, swapChainDesc, swapChainOut, deviceOut, options = {})
{
    if (swapChainOut)
    {
        swapChainOut.swapChain = null;
    }
    if (!deviceOut)
    {
        return E_INVALIDARG;
    }
    deviceOut.device = null;
    const hr = featureLevelResult(featureLevel, sdkVersion);
    if (hr !== S_OK)
    {
        return hr;
    }
    return D3D10CreateDeviceAndSwapChain(adapter, driverType, software, flags, D3D10_SDK_VERSION,
        swapChainOut ? swapChainDesc : null, swapChainOut ?? {}, deviceOut, options);
}

/**
 * @param {any} adapter
 * @param {number} driverType
 * @param {any} software
 * @param {number} flags
 * @param {number} sdkVersion
 * @param {import('./structs.js').SwapChainFields | null} swapChainDesc
 * @param {{ swapChain?: any }} swapChainOut
 * @param {{ device?: any }} deviceOut
 * @param {DeviceOptions} [options]
 * @returns {number}
 */
export function D3D10CreateDeviceAndSwapChain(adapter, driverType, software, flags, sdkVersion,
    swapChainDesc, swapChainOut, deviceOut, options = {})
{
    const hr = D3D10CreateDevice(adapter, driverType, software, flags, sdkVersion, deviceOut,
        options);
    if (hr !== S_OK)
    {
        if (swapChainOut)
        {
            swapChainOut.swapChain = null;
        }
        return hr;
    }
    // A null description means the caller wanted only the device; the swap
    // chain half of this entry point is optional and its absence is not a
    // failure.
    if (!swapChainDesc)
    {
        if (swapChainOut)
        {
            swapChainOut.swapChain = null;
        }
        return S_OK;
    }

    const device = deviceOut.device;
    const chain = swapChainOut ?? {};
    const created = device.factory().CreateSwapChain(device, swapChainDesc, chain);
    if (created !== S_OK)
    {
        // Neither object survives a failure here: a caller that got a device
        // back would have no way of telling it apart from a full success.
        device.release();
        deviceOut.device = null;
        chain.swapChain = null;
        return DXGI_ERROR_INVALID_CALL;
    }
    return S_OK;
}

/** @param {number} count @returns {any[]} */
function emptySlots(count){
    return new Array(count).fill(null);
}

/**
 * A binding is not ownership, so what a slot holds may already be gone. This is
 * the one place that is decided, and everything that reads a slot goes through
 * it.
 *
 * @param {any} object
 * @returns {any | null}
 */
function stillAlive(object){
    return object && object.refCount > 0 ? object : null;
}

/** The per-stage half of the pipeline, identical for all three shader stages. */
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
 * @param {readonly any[]} values
 * @param {any} [absent]  What an unsupplied entry means: no object, or zero.
 */
function writeSlots(slots, startSlot, values, absent = null){
    for (let index = 0; index < values.length; index++)
    {
        const slot = startSlot + index;
        if (slot < slots.length)
        {
            slots[slot] = values[index] ?? absent;
        }
    }
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

/**
 * @param {DeviceOptions & { flags?: number }} [options]
 */
export function createDevice(options = {}){
    const multisampleQualityLevels = options.multisampleQualityLevels ?? noMultisampling;
    const caps = { multisampleQualityLevels };
    const factory = options.adapter
        ? null
        : createFactory(options.factoryOptions);
    /** @type {{ adapter?: any }} */
    const enumerated = {};
    if (factory)
    {
        factory.EnumAdapters(0, enumerated);
    }
    const adapter = options.adapter ?? enumerated.adapter;
    // The factory this device answers `CreateSwapChain` through is the one its
    // adapter came out of, never a second one: a swap chain made by a different
    // factory than the device's would report a parent the program has never
    // seen. The reference `GetParent` took is given straight back -- the
    // adapter already keeps the factory alive, and a second hold here would
    // have to be unwound on the way out for nothing.
    /** @type {{ parent?: any }} */
    const owner = {};
    adapter.GetParent(IID.IDXGIFactory, owner);
    owner.parent.release();

    /** @type {any} */
    let self = null;
    const retainDevice = ()=>self.addRef();
    const releaseDevice = ()=>self.release();
    const deviceHandle = ()=>self;
    const states = createStateStore({ retainDevice, releaseDevice, device: deviceHandle });

    /** Said once per distinct detail, so a call in a loop does not flood. */
    const divergences = new Set();
    /** @param {string} detail */
    const diverge = detail=>{
        if (!options.divergence || divergences.has(detail))
        {
            return;
        }
        divergences.add(detail);
        options.divergence('Direct3D 10', detail);
    };

    // With a backend the renderer draws; without one it still keeps every
    // resource's bytes, so a map, a copy and an update mean the same thing in
    // a headless build as under a GPU.
    const textureOptions = { compressed: options.compressedTextures ?? false };
    const renderer = createRenderer({
        backend: options.backend ?? null,
        createSampler: options.createSampler ?? (()=>null),
        createTexture: options.createTexture ?? (()=>null),
        divergence: options.divergence,
        compressedTextures: textureOptions.compressed,
        depthClipControl: options.depthClipControl ?? false,
    });
    const statistics = createDrawStatistics();
    /** @type {import('./resources.js').ResourceStorage} */
    const storage = {
        map: (resource, subresource)=>renderer.map(resource, subresource),
        unmap: (resource, subresource, discard, noOverwrite)=>
            renderer.unmap(resource, subresource, discard, noOverwrite),
        pending: resource=>renderer.pendingReadback(resource),
    };

    /**
     * @param {SubresourceData | SubresourceData[] | null} initialData
     * @returns {SubresourceData[] | null}
     */
    const asSubresources = initialData=>{
        if (!initialData)
        {
            return null;
        }
        return Array.isArray(initialData) ? initialData : [initialData];
    };

    /**
     * @param {SubresourceData[] | null} data
     * @returns {boolean} whether any of it names no memory
     */
    const namesNoMemory = data=>!!data && data.some(entry=>!entry || !entry.pSysMem);

    const pipeline = {
        stages: { vs: createStage(), gs: createStage(), ps: createStage() },
        inputLayout: /** @type {any} */ (null),
        vertexBuffers: emptySlots(D3D10_LIMITS.VERTEX_INPUT_SLOTS),
        vertexStrides: /** @type {number[]} */ (new Array(D3D10_LIMITS.VERTEX_INPUT_SLOTS).fill(0)),
        vertexOffsets: /** @type {number[]} */ (new Array(D3D10_LIMITS.VERTEX_INPUT_SLOTS).fill(0)),
        indexBuffer: /** @type {any} */ (null),
        indexFormat: /** @type {number} */ (DXGI_FORMAT.UNKNOWN),
        indexOffset: 0,
        topology: /** @type {number} */ (D3D10_PRIMITIVE_TOPOLOGY.UNDEFINED),
        renderTargets: emptySlots(D3D10_LIMITS.SIMULTANEOUS_RENDER_TARGETS),
        depthStencilView: /** @type {any} */ (null),
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
    let exceptionMode = 0;
    let textFilter = { width: 0, height: 0 };
    // A device is thread-safe unless it was made single-threaded.
    let multithreadProtected = ((options.flags ?? 0) & D3D10_CREATE_DEVICE.SINGLETHREADED) === 0;
    let maximumFrameLatency = DEFAULT_FRAME_LATENCY;

    /**
     * @param {any} desc
     * @param {number} dimension
     * @param {any} initialData
     * @param {{ resource?: any }} out
     * @param {string} iid
     * @returns {number}
     */
    const createTexture = (desc, dimension, initialData, out, iid)=>{
        out.resource = null;
        if (!desc)
        {
            return E_INVALIDARG;
        }
        const data = asSubresources(initialData);
        // Initial data that names no memory is a caller's mistake, not an
        // absent argument: the two are different calls and only one of them
        // satisfies an immutable resource.
        if (namesNoMemory(data))
        {
            return E_INVALIDARG;
        }
        const hr = textureCreateResult(desc, dimension, caps, !!data);
        if (hr !== S_OK)
        {
            return hr;
        }
        const resolved = Object.freeze({
            ...desc,
            MipLevels: resolveMipLevels(desc, dimension),
            ArraySize: dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
                ? undefined
                : (desc.ArraySize ?? 1),
            SampleDesc: Object.freeze({ ...(desc.SampleDesc ?? { Count: 1, Quality: 0 }) }),
        });
        out.resource = createResource({
            dimension,
            desc: resolved,
            interfaces: textureInterfaces(resolved, iid, dimension),
            retainDevice,
            releaseDevice,
            device: deviceHandle,
            storage,
        });
        renderer.resourceCreated(out.resource, data);
        return S_OK;
    };

    /**
     * @param {any} resource
     * @param {any} desc
     * @param {any} kind
     * @param {{ view?: any }} out
     * @returns {number}
     */
    const createViewOf = (resource, desc, kind, out)=>{
        out.view = null;
        if (!resource)
        {
            return E_INVALIDARG;
        }
        const resolved = resolveViewDesc({
            resource,
            desc: desc ?? null,
            dimensions: kind.union.dimensions,
            members: kind.union.members,
            bindFlag: kind.bindFlag,
        });
        if (!resolved)
        {
            return E_INVALIDARG;
        }
        out.view = createView({
            resource,
            desc: Object.freeze(resolved.desc),
            dimensionName: resolved.dimensionName,
            range: resolved.range,
            iid: kind.iid,
            also: kind.also,
            retainDevice,
            releaseDevice,
            device: deviceHandle,
        });
        return S_OK;
    };

    /**
     * A shader is made from a container holding a program of the kind the
     * create is for. Anything else -- an older shader model's tokens, a pixel
     * shader handed to the vertex create -- is the plain bad-argument code.
     *
     * @param {string} iid
     * @param {number} kind  A SHADER_KIND.
     * @param {{ shader?: any }} out
     * @param {Uint8Array} bytecode
     * @returns {number}
     */
    const createShader = (iid, kind, out, bytecode)=>{
        out.shader = null;
        const container = bytecode ? parseShaderOfKind(bytecode, kind) : null;
        if (!container)
        {
            return E_INVALIDARG;
        }
        out.shader = attachCom({
            container,
            /** @param {{ device?: any }} target */
            GetDevice(target){
                retainDevice();
                target.device = self;
                return S_OK;
            },
        }, {
            interfaces: [IID.ID3D10DeviceChild, iid],
            onFirstRef: retainDevice,
            onLastRef: releaseDevice,
        });
        return S_OK;
    };

    /**
     * @param {any} desc
     * @param {{ query?: any } | null} out
     * @param {boolean} predicate  Whether the create is for a predicate.
     * @returns {number}
     */
    const createQuery = (desc, out, predicate)=>{
        if (out)
        {
            out.query = null;
        }
        if (!desc || !Object.values(D3D10_QUERY).includes(desc.Query))
        {
            return E_INVALIDARG;
        }
        const isPredicate = PREDICATE_QUERIES.has(desc.Query);
        if (predicate && !isPredicate)
        {
            return E_INVALIDARG;
        }
        // A null out pointer asks whether the query could be made.
        if (!out)
        {
            return S_FALSE;
        }
        /** @type {string[]} */
        const interfaces = [IID.ID3D10Query];
        if (isPredicate)
        {
            interfaces.push(IID.ID3D10Predicate);
        }
        out.query = createQueryObject(
            Object.freeze({ Query: desc.Query, MiscFlags: desc.MiscFlags ?? 0 }), interfaces, {
                totals: statistics.snapshot,
                recorded: ()=>renderer.recorded(),
                submitted: ()=>renderer.submitted(),
                flush: ()=>{
                    renderer.flush();
                },
                now: options.now ?? (()=>performance.now()),
                diverge,
                occlusion: {
                    begin: ()=>renderer.beginOcclusion(),
                    end: counter=>renderer.endOcclusion(counter),
                },
            }, { retainDevice, releaseDevice, device: deviceHandle });
        return S_OK;
    };

    /**
     * Everything bound, with anything released since read as nothing: the
     * one moment a draw looks at the pipeline.
     *
     * @returns {PipelineSnapshot}
     */
    const snapshot = ()=>{
        /** @param {any[]} slots */
        const live = slots=>slots.map(stillAlive);
        /** @param {StageBindings} stage */
        const stageOf = stage=>({
            shader: stillAlive(stage.shader),
            constantBuffers: live(stage.constantBuffers),
            shaderResources: live(stage.shaderResources),
            samplers: live(stage.samplers),
        });
        return {
            stages: {
                vs: stageOf(pipeline.stages.vs),
                gs: stageOf(pipeline.stages.gs),
                ps: stageOf(pipeline.stages.ps),
            },
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
            blendState: stillAlive(pipeline.blendState),
            blendFactor: pipeline.blendFactor,
            sampleMask: pipeline.sampleMask,
            depthStencilState: stillAlive(pipeline.depthStencilState),
            stencilRef: pipeline.stencilRef,
            rasterizerState: stillAlive(pipeline.rasterizerState),
            viewports: pipeline.viewports,
            scissorRects: pipeline.scissorRects,
        };
    };

    /**
     * Every draw, as the queries count it and the renderer records it.
     *
     * @param {{ vertexCount: number, startVertex: number, instanceCount?: number,
     *           indexCount?: number, startIndex?: number, baseVertex?: number,
     *           startInstance?: number }} request
     */
    const draw = request=>{
        const bound = snapshot();
        statistics.note(bound, request);
        renderer.draw(bound, request);
    };

    /**
     * A copy's two resources have to be the same kind of thing; the runtime
     * ignores a copy that is not, and so does this, saying so.
     *
     * @param {any} destination
     * @param {any} source
     * @param {string} call
     * @returns {boolean}
     */
    const copyable = (destination, source, call)=>{
        if (!destination || !source || destination === source)
        {
            diverge(`${call} between a resource and itself, or with a null resource, is ignored`);
            return false;
        }
        if (destination.dimension !== source.dimension)
        {
            diverge(`${call} between resources of different kinds is ignored`);
            return false;
        }
        if (destination.desc.Usage === D3D10_USAGE.IMMUTABLE)
        {
            diverge(`${call} into an immutable resource is ignored`);
            return false;
        }
        // Bits move between formats of one family and no others: a copy
        // between two families -- a compressed block and a texel among them --
        // has no meaning and the runtime leaves the destination as it was.
        if (destination.dimension !== D3D10_RESOURCE_DIMENSION.BUFFER
            && FORMAT_INFO[destination.desc.Format]?.family
                !== FORMAT_INFO[source.desc.Format]?.family)
        {
            diverge(`${call} between formats of different families is ignored`);
            return false;
        }
        return true;
    };

    /** @param {'vs' | 'gs' | 'ps'} stage */
    const stageMethods = stage=>({
        /** @param {any} shader */
        setShader(shader){
            pipeline.stages[stage].shader = shader ?? null;
        },
        /** @param {{ shader?: any }} out */
        getShader(out){
            const shader = stillAlive(pipeline.stages[stage].shader);
            if (shader)
            {
                shader.addRef();
            }
            out.shader = shader;
        },
        /** @param {number} startSlot @param {readonly any[]} buffers */
        setConstantBuffers(startSlot, buffers){
            writeSlots(pipeline.stages[stage].constantBuffers, startSlot, buffers);
        },
        /** @param {number} startSlot @param {number} count @param {{ buffers?: any[] }} out */
        getConstantBuffers(startSlot, count, out){
            out.buffers = readSlots(pipeline.stages[stage].constantBuffers, startSlot, count);
        },
        /** @param {number} startSlot @param {readonly any[]} views */
        setShaderResources(startSlot, views){
            writeSlots(pipeline.stages[stage].shaderResources, startSlot, views);
        },
        /** @param {number} startSlot @param {number} count @param {{ views?: any[] }} out */
        getShaderResources(startSlot, count, out){
            out.views = readSlots(pipeline.stages[stage].shaderResources, startSlot, count);
        },
        /** @param {number} startSlot @param {readonly any[]} samplers */
        setSamplers(startSlot, samplers){
            writeSlots(pipeline.stages[stage].samplers, startSlot, samplers);
        },
        /** @param {number} startSlot @param {number} count @param {{ samplers?: any[] }} out */
        getSamplers(startSlot, count, out){
            out.samplers = readSlots(pipeline.stages[stage].samplers, startSlot, count);
        },
    });

    const vs = stageMethods('vs');
    const gs = stageMethods('gs');
    const ps = stageMethods('ps');

    self = attachCom({
        // --- resources ---

        /**
         * @param {any} desc
         * @param {any} initialData
         * @param {{ resource?: any }} out
         * @returns {number}
         */
        CreateBuffer(desc, initialData, out){
            out.resource = null;
            if (!desc)
            {
                return E_INVALIDARG;
            }
            const data = asSubresources(initialData);
            if (namesNoMemory(data))
            {
                return E_INVALIDARG;
            }
            const hr = bufferCreateResult(desc, !!data);
            if (hr !== S_OK)
            {
                return hr;
            }
            out.resource = createResource({
                dimension: D3D10_RESOURCE_DIMENSION.BUFFER,
                desc: Object.freeze({ ...desc, MipLevels: 1, ArraySize: 1 }),
                interfaces: [IID.ID3D10DeviceChild, IID.ID3D10Resource, IID.IDXGIObject,
                    IID.IDXGIDeviceSubObject, IID.IDXGIResource, IID.ID3D10Buffer],
                retainDevice,
                releaseDevice,
                device: deviceHandle,
                storage,
            });
            renderer.resourceCreated(out.resource, data);
            return S_OK;
        },

        /** @param {any} desc @param {any} data @param {{ resource?: any }} out */
        CreateTexture1D(desc, data, out){
            return createTexture(desc, D3D10_RESOURCE_DIMENSION.TEXTURE1D, data, out,
                IID.ID3D10Texture1D);
        },

        /** @param {any} desc @param {any} data @param {{ resource?: any }} out */
        CreateTexture2D(desc, data, out){
            return createTexture(desc, D3D10_RESOURCE_DIMENSION.TEXTURE2D, data, out,
                IID.ID3D10Texture2D);
        },

        /** @param {any} desc @param {any} data @param {{ resource?: any }} out */
        CreateTexture3D(desc, data, out){
            return createTexture(desc, D3D10_RESOURCE_DIMENSION.TEXTURE3D, data, out,
                IID.ID3D10Texture3D);
        },

        // --- views ---

        /** @param {any} resource @param {any} desc @param {{ view?: any }} out */
        CreateRenderTargetView(resource, desc, out){
            return createViewOf(resource, desc, VIEW_KINDS.RENDER_TARGET, out);
        },

        /** @param {any} resource @param {any} desc @param {{ view?: any }} out */
        CreateDepthStencilView(resource, desc, out){
            return createViewOf(resource, desc, VIEW_KINDS.DEPTH_STENCIL, out);
        },

        /** @param {any} resource @param {any} desc @param {{ view?: any }} out */
        CreateShaderResourceView(resource, desc, out){
            return createViewOf(resource, desc, VIEW_KINDS.SHADER_RESOURCE, out);
        },

        /**
         * Direct3D 10.1's description adds cube arrays, which a device of
         * feature level 10.0 does not have; everything else is laid out as
         * before.
         *
         * @param {any} resource @param {any} desc @param {{ view?: any }} out
         */
        CreateShaderResourceView1(resource, desc, out){
            if (desc && desc.ViewDimension === D3D10_SRV_DIMENSION1_TEXTURECUBEARRAY)
            {
                out.view = null;
                return E_INVALIDARG;
            }
            return createViewOf(resource, desc, VIEW_KINDS.SHADER_RESOURCE, out);
        },

        // --- immutable state objects ---

        /** @param {any} desc @param {{ state?: any }} out */
        CreateBlendState(desc, out){
            out.state = null;
            return states.create(STATE_KIND.BLEND, desc, out);
        },

        /**
         * Direct3D 10.1's blend state: factors per target.
         *
         * @param {any} desc @param {{ state?: any }} out
         */
        CreateBlendState1(desc, out){
            out.state = null;
            return states.create(STATE_KIND.BLEND1, desc, out);
        },

        /** @param {any} desc @param {{ state?: any }} out */
        CreateDepthStencilState(desc, out){
            out.state = null;
            return states.create(STATE_KIND.DEPTH_STENCIL, desc, out);
        },

        /** @param {any} desc @param {{ state?: any }} out */
        CreateRasterizerState(desc, out){
            out.state = null;
            return states.create(STATE_KIND.RASTERIZER, desc, out);
        },

        /** @param {any} desc @param {{ state?: any }} out */
        CreateSamplerState(desc, out){
            out.state = null;
            return states.create(STATE_KIND.SAMPLER, desc, out);
        },

        // --- shaders and the input layout ---

        /** @param {Uint8Array} bytecode @param {{ shader?: any }} out */
        CreateVertexShader(bytecode, out){
            return createShader(IID.ID3D10VertexShader, SHADER_KIND.VERTEX, out, bytecode);
        },

        /**
         * A geometry shader is refused, once its bytecode is known to be one:
         * WebGPU has no geometry stage and the translator does not emulate
         * one, and a shader made and then left out of every draw would draw
         * the program's points and triangles where it expands, culls or
         * routes them. Bytecode that is not a geometry shader is the plain
         * bad-argument answer Windows gives.
         *
         * @param {Uint8Array} bytecode @param {{ shader?: any }} out
         */
        CreateGeometryShader(bytecode, out){
            out.shader = null;
            if (!bytecode || !parseShaderOfKind(bytecode, SHADER_KIND.GEOMETRY))
            {
                return E_INVALIDARG;
            }
            diverge('a geometry shader is refused: WebGPU has no geometry stage and none is'
                + ' emulated here');
            return E_NOTIMPL;
        },

        /**
         * Stream output is not something this build can do, and a shader that
         * promises it is refused rather than made to draw without it.
         *
         * @param {Uint8Array} bytecode
         * @param {readonly any[]} declaration
         * @param {number} outputStride
         * @param {{ shader?: any }} out
         */
        CreateGeometryShaderWithStreamOutput(bytecode, declaration, outputStride, out){
            void bytecode;
            void declaration;
            void outputStride;
            out.shader = null;
            diverge('a geometry shader with stream output is refused: nothing here writes'
                + ' a stream-output buffer');
            return E_NOTIMPL;
        },

        /** @param {Uint8Array} bytecode @param {{ shader?: any }} out */
        CreatePixelShader(bytecode, out){
            return createShader(IID.ID3D10PixelShader, SHADER_KIND.PIXEL, out, bytecode);
        },

        /**
         * The layout is matched against the signature by semantic name and
         * index: every input the shader declares has to be fed by some element,
         * or the draw could never assemble a vertex.
         *
         * @param {readonly any[] | null} elements
         * @param {Uint8Array} shaderBytecode  A container with the input signature.
         * @param {{ layout?: any }} out
         * @returns {number}
         */
        CreateInputLayout(elements, shaderBytecode, out){
            out.layout = null;
            // No elements at all is a layout: a vertex shader that reads only
            // system values -- a full-screen pass built from SV_VertexID --
            // is fed by it.
            const given = elements ?? [];
            if (given.length > D3D10_LIMITS.INPUT_ELEMENTS || !shaderBytecode)
            {
                return E_INVALIDARG;
            }
            for (const element of given)
            {
                if (!element.SemanticName || element.InputSlot >= D3D10_LIMITS.VERTEX_INPUT_SLOTS)
                {
                    return E_INVALIDARG;
                }
            }
            const container = parseDxbc(shaderBytecode);
            if (!container)
            {
                return E_INVALIDARG;
            }
            for (const input of container.inputs)
            {
                if (input.systemValue !== SYSTEM_VALUE.UNDEFINED)
                {
                    continue;
                }
                const fed = given.some(element=>
                    element.SemanticName.toUpperCase() === input.name.toUpperCase()
                    && (element.SemanticIndex ?? 0) === input.index);
                if (!fed)
                {
                    return E_INVALIDARG;
                }
            }
            out.layout = attachCom({
                elements: Object.freeze(given.map(element=>Object.freeze({ ...element }))),
                /** @param {{ device?: any }} target */
                GetDevice(target){
                    retainDevice();
                    target.device = self;
                    return S_OK;
                },
            }, {
                interfaces: [IID.ID3D10DeviceChild, IID.ID3D10InputLayout],
                onFirstRef: retainDevice,
                onLastRef: releaseDevice,
            });
            return S_OK;
        },

        // --- queries ---

        /** @param {any} desc @param {{ query?: any } | null} out */
        CreateQuery(desc, out){
            return createQuery(desc, out, false);
        },

        /** @param {any} desc @param {{ query?: any } | null} out */
        CreatePredicate(desc, out){
            return createQuery(desc, out, true);
        },

        /** @param {any} desc @param {{ counter?: any } | null} out */
        CreateCounter(desc, out){
            if (out)
            {
                out.counter = null;
            }
            // No counter is offered, which is what a device without any says.
            return desc ? DXGI_ERROR_UNSUPPORTED : E_INVALIDARG;
        },

        /** @param {{ info?: any }} out */
        CheckCounterInfo(out){
            out.info = { LastDeviceDependentCounter: 0, NumSimultaneousCounters: 0,
                NumDetectableParallelUnits: 1 };
        },

        /** @returns {number} */
        CheckCounter(){
            return DXGI_ERROR_UNSUPPORTED;
        },

        /**
         * What a format can be used for on this device, as the runtime reports
         * it: from the format table for what a resource may be, and from the
         * GPU spellings for what can be drawn.
         *
         * @param {number} format
         * @param {{ support?: number }} out
         * @returns {number}
         */
        CheckFormatSupport(format, out){
            if (!out)
            {
                return E_INVALIDARG;
            }
            out.support = 0;
            const info = FORMAT_INFO[format];
            if (!info)
            {
                return E_FAIL;
            }
            const block = info.blockEdge > 1;
            let support = FORMAT_SUPPORT.CPU_LOCKABLE | (block ? 0 : FORMAT_SUPPORT.BUFFER);
            if (VERTEX_FORMAT[format])
            {
                support |= FORMAT_SUPPORT.IA_VERTEX_BUFFER;
            }
            if (INDEX_FORMAT[format])
            {
                support |= FORMAT_SUPPORT.IA_INDEX_BUFFER;
            }
            const kept = textureStorage(format,
                info.kind === FORMAT_KIND.DEPTH ? D3D10_BIND.DEPTH_STENCIL : 0, textureOptions);
            if (kept)
            {
                // WebGPU makes no compressed or depth texture of three dimensions.
                support |= FORMAT_SUPPORT.TEXTURE2D | FORMAT_SUPPORT.TEXTURECUBE
                    | FORMAT_SUPPORT.MIP
                    | (block ? 0 : FORMAT_SUPPORT.TEXTURE1D)
                    | (block || kept.depth ? 0 : FORMAT_SUPPORT.TEXTURE3D);
            }
            if (kept && info.kind === FORMAT_KIND.COLOUR)
            {
                support |= FORMAT_SUPPORT.SHADER_LOAD;
                // What a sampler may filter: normalised and float formats, but
                // not the 32-bit floats, which WebGPU does not filter.
                const filterable = /unorm|snorm|float/.test(kept.format)
                    && !/32float/.test(kept.format);
                if (filterable)
                {
                    support |= FORMAT_SUPPORT.SHADER_SAMPLE;
                }
                if (info.renderable && !kept.conversion)
                {
                    support |= FORMAT_SUPPORT.RENDER_TARGET
                        | (filterable ? FORMAT_SUPPORT.BLENDABLE : 0);
                }
                if (/^(rgba8unorm|bgra8unorm)/.test(kept.format) && !kept.conversion)
                {
                    support |= FORMAT_SUPPORT.MIP_AUTOGEN | FORMAT_SUPPORT.DISPLAY;
                }
            }
            if (info.kind === FORMAT_KIND.DEPTH && kept)
            {
                support |= FORMAT_SUPPORT.DEPTH_STENCIL | FORMAT_SUPPORT.SHADER_SAMPLE_COMPARISON;
            }
            out.support = support;
            return S_OK;
        },

        // --- input assembler ---

        /** @param {any} layout */
        IASetInputLayout(layout){
            pipeline.inputLayout = layout ?? null;
        },

        /** @param {{ layout?: any }} out */
        IAGetInputLayout(out){
            const layout = stillAlive(pipeline.inputLayout);
            if (layout)
            {
                layout.addRef();
            }
            out.layout = layout;
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
            pipeline.indexBuffer = buffer ?? null;
            pipeline.indexFormat = format;
            pipeline.indexOffset = offset;
        },

        /** @param {{ buffer?: any, format?: number, offset?: number }} out */
        IAGetIndexBuffer(out){
            const buffer = stillAlive(pipeline.indexBuffer);
            if (buffer)
            {
                buffer.addRef();
            }
            out.buffer = buffer;
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

        // --- shader stages ---

        /** @param {any} shader */
        VSSetShader(shader){
            vs.setShader(shader);
        },
        /** @param {{ shader?: any }} out */
        VSGetShader(out){
            vs.getShader(out);
        },
        /** @param {number} startSlot @param {readonly any[]} buffers */
        VSSetConstantBuffers(startSlot, buffers){
            vs.setConstantBuffers(startSlot, buffers);
        },
        /** @param {number} startSlot @param {number} count @param {{ buffers?: any[] }} out */
        VSGetConstantBuffers(startSlot, count, out){
            vs.getConstantBuffers(startSlot, count, out);
        },
        /** @param {number} startSlot @param {readonly any[]} views */
        VSSetShaderResources(startSlot, views){
            vs.setShaderResources(startSlot, views);
        },
        /** @param {number} startSlot @param {number} count @param {{ views?: any[] }} out */
        VSGetShaderResources(startSlot, count, out){
            vs.getShaderResources(startSlot, count, out);
        },
        /** @param {number} startSlot @param {readonly any[]} samplers */
        VSSetSamplers(startSlot, samplers){
            vs.setSamplers(startSlot, samplers);
        },
        /** @param {number} startSlot @param {number} count @param {{ samplers?: any[] }} out */
        VSGetSamplers(startSlot, count, out){
            vs.getSamplers(startSlot, count, out);
        },

        /** @param {any} shader */
        GSSetShader(shader){
            gs.setShader(shader);
        },
        /** @param {{ shader?: any }} out */
        GSGetShader(out){
            gs.getShader(out);
        },
        /** @param {number} startSlot @param {readonly any[]} buffers */
        GSSetConstantBuffers(startSlot, buffers){
            gs.setConstantBuffers(startSlot, buffers);
        },
        /** @param {number} startSlot @param {number} count @param {{ buffers?: any[] }} out */
        GSGetConstantBuffers(startSlot, count, out){
            gs.getConstantBuffers(startSlot, count, out);
        },
        /** @param {number} startSlot @param {readonly any[]} views */
        GSSetShaderResources(startSlot, views){
            gs.setShaderResources(startSlot, views);
        },
        /** @param {number} startSlot @param {number} count @param {{ views?: any[] }} out */
        GSGetShaderResources(startSlot, count, out){
            gs.getShaderResources(startSlot, count, out);
        },
        /** @param {number} startSlot @param {readonly any[]} samplers */
        GSSetSamplers(startSlot, samplers){
            gs.setSamplers(startSlot, samplers);
        },
        /** @param {number} startSlot @param {number} count @param {{ samplers?: any[] }} out */
        GSGetSamplers(startSlot, count, out){
            gs.getSamplers(startSlot, count, out);
        },

        /** @param {any} shader */
        PSSetShader(shader){
            ps.setShader(shader);
        },
        /** @param {{ shader?: any }} out */
        PSGetShader(out){
            ps.getShader(out);
        },
        /** @param {number} startSlot @param {readonly any[]} buffers */
        PSSetConstantBuffers(startSlot, buffers){
            ps.setConstantBuffers(startSlot, buffers);
        },
        /** @param {number} startSlot @param {number} count @param {{ buffers?: any[] }} out */
        PSGetConstantBuffers(startSlot, count, out){
            ps.getConstantBuffers(startSlot, count, out);
        },
        /** @param {number} startSlot @param {readonly any[]} views */
        PSSetShaderResources(startSlot, views){
            ps.setShaderResources(startSlot, views);
        },
        /** @param {number} startSlot @param {number} count @param {{ views?: any[] }} out */
        PSGetShaderResources(startSlot, count, out){
            ps.getShaderResources(startSlot, count, out);
        },
        /** @param {number} startSlot @param {readonly any[]} samplers */
        PSSetSamplers(startSlot, samplers){
            ps.setSamplers(startSlot, samplers);
        },
        /** @param {number} startSlot @param {number} count @param {{ samplers?: any[] }} out */
        PSGetSamplers(startSlot, count, out){
            ps.getSamplers(startSlot, count, out);
        },

        // --- rasterizer ---

        /** @param {any} state */
        RSSetState(state){
            pipeline.rasterizerState = state ?? null;
        },

        /** @param {{ state?: any }} out */
        RSGetState(out){
            const state = stillAlive(pipeline.rasterizerState);
            if (state)
            {
                state.addRef();
            }
            out.state = state;
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
            pipeline.renderTargets = emptySlots(D3D10_LIMITS.SIMULTANEOUS_RENDER_TARGETS);
            writeSlots(pipeline.renderTargets, 0, renderTargetViews ?? []);
            pipeline.depthStencilView = depthStencilView ?? null;
        },

        /** @param {number} count @param {{ views?: any[], depthStencilView?: any }} out */
        OMGetRenderTargets(count, out){
            out.views = readSlots(pipeline.renderTargets, 0, count);
            const dsv = stillAlive(pipeline.depthStencilView);
            if (dsv)
            {
                dsv.addRef();
            }
            out.depthStencilView = dsv;
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
            pipeline.blendState = state ?? null;
            pipeline.blendFactor = blendFactor
                ? [...blendFactor]
                : [...D3D10_DEFAULTS.BLEND_FACTOR];
            pipeline.sampleMask = sampleMask >>> 0;
        },

        /** @param {{ state?: any, blendFactor?: number[], sampleMask?: number }} out */
        OMGetBlendState(out){
            const state = stillAlive(pipeline.blendState);
            if (state)
            {
                state.addRef();
            }
            out.state = state;
            out.blendFactor = [...pipeline.blendFactor];
            out.sampleMask = pipeline.sampleMask;
        },

        /** @param {any} state @param {number} stencilRef */
        OMSetDepthStencilState(state, stencilRef){
            pipeline.depthStencilState = state ?? null;
            pipeline.stencilRef = stencilRef;
        },

        /** @param {{ state?: any, stencilRef?: number }} out */
        OMGetDepthStencilState(out){
            const state = stillAlive(pipeline.depthStencilState);
            if (state)
            {
                state.addRef();
            }
            out.state = state;
            out.stencilRef = pipeline.stencilRef;
        },

        // --- drawing ---

        /** @param {number} vertexCount @param {number} startVertex */
        Draw(vertexCount, startVertex){
            draw({ vertexCount, startVertex });
        },

        /** @param {number} indexCount @param {number} startIndex @param {number} baseVertex */
        DrawIndexed(indexCount, startIndex, baseVertex){
            draw({ vertexCount: 0, startVertex: 0, indexCount, startIndex, baseVertex });
        },

        /**
         * @param {number} vertexCount @param {number} instanceCount
         * @param {number} startVertex @param {number} startInstance
         */
        DrawInstanced(vertexCount, instanceCount, startVertex, startInstance){
            draw({ vertexCount, startVertex, instanceCount, startInstance });
        },

        /**
         * @param {number} indexCount @param {number} instanceCount @param {number} startIndex
         * @param {number} baseVertex @param {number} startInstance
         */
        DrawIndexedInstanced(indexCount, instanceCount, startIndex, baseVertex, startInstance){
            draw({ vertexCount: 0, startVertex: 0, indexCount, startIndex, baseVertex,
                instanceCount, startInstance });
        },

        DrawAuto(){
            diverge('DrawAuto draws nothing: there is no stream-output buffer to count');
        },

        /** @param {any} view @param {readonly number[]} color */
        ClearRenderTargetView(view, color){
            if (!view || !color)
            {
                return;
            }
            renderer.clearRenderTargetView(view, [...color]);
        },

        /**
         * @param {any} view @param {number} flags @param {number} depth @param {number} stencil
         */
        ClearDepthStencilView(view, flags, depth, stencil){
            if (!view)
            {
                return;
            }
            renderer.clearDepthStencilView(view, flags, depth, stencil & 0xff);
        },

        // --- resource traffic ---

        /**
         * @param {any} resource
         * @param {number} subresource
         * @param {Box | null} box
         * @param {Uint8Array} data
         * @param {number} rowPitch
         * @param {number} depthPitch
         */
        UpdateSubresource(resource, subresource, box, data, rowPitch, depthPitch){
            if (!resource || !data)
            {
                return;
            }
            if (resource.desc.Usage !== D3D10_USAGE.DEFAULT)
            {
                diverge('UpdateSubresource on anything but a default-usage resource is'
                    + ' ignored');
                return;
            }
            if (box && (box.right <= box.left || box.bottom <= box.top || box.back <= box.front))
            {
                return;
            }
            renderer.updateSubresource(resource, subresource, box, data, rowPitch, depthPitch);
        },

        /** @param {any} destination @param {any} source */
        CopyResource(destination, source){
            if (!copyable(destination, source, 'CopyResource'))
            {
                return;
            }
            const extent = ['ByteWidth', 'Width', 'Height', 'Depth', 'MipLevels', 'ArraySize'];
            if (extent.some(field=>destination.desc[field] !== source.desc[field]))
            {
                diverge('CopyResource between resources of different extents is ignored');
                return;
            }
            renderer.copyResource(destination, source);
        },

        /**
         * @param {any} destination @param {number} destinationSubresource
         * @param {number} x @param {number} y @param {number} z
         * @param {any} source @param {number} sourceSubresource @param {Box | null} box
         */
        CopySubresourceRegion(destination, destinationSubresource, x, y, z, source,
            sourceSubresource, box)
        {
            if (!copyable(destination, source, 'CopySubresourceRegion'))
            {
                return;
            }
            if (box && (box.right <= box.left || box.bottom <= box.top || box.back <= box.front))
            {
                return;
            }
            renderer.copySubresourceRegion(destination, destinationSubresource, { x, y, z },
                source, sourceSubresource, box);
        },

        /**
         * Only a texture made for it gets levels generated; on any other the
         * call does nothing, which is what the runtime does too.
         *
         * @param {any} view a shader resource view
         */
        GenerateMips(view){
            if (!view)
            {
                return;
            }
            /** @type {{ resource?: any }} */
            const held = {};
            view.GetResource(held);
            const resource = held.resource;
            resource.release();
            if ((resource.desc.MiscFlags & D3D10_RESOURCE_MISC.GENERATE_MIPS) === 0)
            {
                return;
            }
            renderer.generateMips(resource);
        },

        /**
         * There is no multisampling here, so no resource can be a multisampled
         * source and the call always names something it cannot resolve.
         */
        ResolveSubresource(){
            diverge('ResolveSubresource does nothing: the source is not multisampled, and'
                + ' resolving one that is not is refused');
        },

        /** What has been recorded goes to the GPU now rather than at the next present. */
        Flush(){
            renderer.flush();
        },

        // --- stream output and predication ---

        /** @param {readonly any[]} buffers @param {readonly number[]} offsets */
        SOSetTargets(buffers, offsets){
            if (buffers && buffers.some(buffer=>buffer))
            {
                diverge('a stream-output target is bound and never written');
            }
            pipeline.streamOutput = (buffers ?? []).slice(0, D3D10_LIMITS.SO_BUFFER_SLOTS);
            pipeline.streamOutputOffsets = (offsets ?? []).slice(0, D3D10_LIMITS.SO_BUFFER_SLOTS);
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
            pipeline.predicate = predicate ?? null;
            pipeline.predicateValue = !!value;
        },

        /** @param {{ predicate?: any, value?: boolean }} out */
        GetPredication(out){
            const predicate = stillAlive(pipeline.predicate);
            if (predicate)
            {
                predicate.addRef();
            }
            out.predicate = predicate;
            out.value = pipeline.predicateValue;
        },

        // --- odds and ends ---

        /** @param {number} flags */
        SetExceptionMode(flags){
            exceptionMode = flags >>> 0;
            return S_OK;
        },

        GetExceptionMode(){
            return exceptionMode;
        },

        /** @param {number} width @param {number} height */
        SetTextFilterSize(width, height){
            textFilter = { width, height };
        },

        /** @param {{ width?: number, height?: number }} out */
        GetTextFilterSize(out){
            out.width = textFilter.width;
            out.height = textFilter.height;
        },

        /**
         * Nothing here is ever shared, so no handle names a resource.
         *
         * @returns {number}
         */
        OpenSharedResource(){
            return E_INVALIDARG;
        },

        // --- ID3D10Multithread ---

        /**
         * A guest thread reaches the device one call at a time already, so
         * the device's own lock has nothing left to exclude.
         */
        Enter(){
        },

        Leave(){
        },

        /**
         * @param {boolean} enable
         * @returns {boolean} whether protection was on before
         */
        SetMultithreadProtected(enable){
            const before = multithreadProtected;
            multithreadProtected = !!enable;
            return before;
        },

        /** @returns {boolean} */
        GetMultithreadProtected(){
            return multithreadProtected;
        },

        // --- IDXGIDevice1 ---

        /**
         * Frames queued ahead of the display: sixteen at most, and zero puts
         * the default back.
         *
         * @param {number} latency
         * @returns {number}
         */
        SetMaximumFrameLatency(latency){
            if (latency > MAXIMUM_FRAME_LATENCY)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            maximumFrameLatency = latency === 0 ? DEFAULT_FRAME_LATENCY : latency;
            return S_OK;
        },

        /** @param {{ latency?: number } | null} out @returns {number} */
        GetMaximumFrameLatency(out){
            if (!out)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            out.latency = maximumFrameLatency;
            return S_OK;
        },

        // --- device-wide ---

        /**
         * Everything a program set goes back to the value a fresh device holds:
         * no bindings, no viewports at all -- not one covering the target -- a
         * white blend factor, a full sample mask, and an undefined topology.
         */
        ClearState(){
            pipeline.stages = { vs: createStage(), gs: createStage(), ps: createStage() };
            pipeline.inputLayout = null;
            pipeline.vertexBuffers = emptySlots(D3D10_LIMITS.VERTEX_INPUT_SLOTS);
            pipeline.vertexStrides = new Array(D3D10_LIMITS.VERTEX_INPUT_SLOTS).fill(0);
            pipeline.vertexOffsets = new Array(D3D10_LIMITS.VERTEX_INPUT_SLOTS).fill(0);
            pipeline.indexBuffer = null;
            pipeline.indexFormat = DXGI_FORMAT.UNKNOWN;
            pipeline.indexOffset = 0;
            pipeline.topology = D3D10_PRIMITIVE_TOPOLOGY.UNDEFINED;
            pipeline.renderTargets = emptySlots(D3D10_LIMITS.SIMULTANEOUS_RENDER_TARGETS);
            pipeline.depthStencilView = null;
            pipeline.blendState = null;
            pipeline.blendFactor = [...D3D10_DEFAULTS.BLEND_FACTOR];
            pipeline.sampleMask = D3D10_DEFAULTS.SAMPLE_MASK;
            pipeline.depthStencilState = null;
            pipeline.stencilRef = 0;
            pipeline.rasterizerState = null;
            pipeline.viewports = [];
            pipeline.scissorRects = [];
            pipeline.streamOutput = emptySlots(D3D10_LIMITS.SO_BUFFER_SLOTS);
            pipeline.streamOutputOffsets = new Array(D3D10_LIMITS.SO_BUFFER_SLOTS).fill(0);
            pipeline.predicate = null;
            pipeline.predicateValue = false;
        },

        /** @returns {number} always 10.0, the one level any entry point makes a device at */
        GetFeatureLevel(){
            return D3D_FEATURE_LEVEL.LEVEL_10_0;
        },

        /** @returns {number} the flags the device was created with */
        GetCreationFlags(){
            return options.flags ?? 0;
        },

        /** @returns {number} S_OK for as long as the device works */
        GetDeviceRemovedReason(){
            return S_OK;
        },

        /**
         * @param {number} format
         * @param {number} sampleCount
         * @param {{ levels?: number }} out
         * @returns {number}
         */
        CheckMultisampleQualityLevels(format, sampleCount, out){
            if (!out)
            {
                return E_INVALIDARG;
            }
            out.levels = multisampleQualityLevels(format, sampleCount);
            return S_OK;
        },

        /** @returns {any} the factory this device's swap chains come from */
        factory(){
            return owner.parent;
        },

        /** @returns {any} the adapter the device runs on */
        adapter(){
            return adapter;
        },

        /** @returns {number} how many distinct state objects are alive */
        stateObjectCount(){
            return states.size();
        },

        /**
         * A swap chain presenting: the recorded frame goes to the GPU and the
         * buffer is shown.
         *
         * @param {any} backBuffer
         * @returns {Promise<void>}
         */
        present(backBuffer){
            return renderer.present(backBuffer);
        },

        /**
         * What a present waits on, once its frame is queued, before it answers
         * the program; null when it may answer at once.
         *
         * @param {Promise<void>} submitted  settled when the frame is on the queue
         * @returns {Promise<void> | null}
         */
        frameQueued(submitted){
            return options.backend ? options.frameQueued?.(submitted) ?? null : null;
        },

        /** @returns {Promise<void>} settled when every presented frame has been submitted */
        idle(){
            return renderer.idle();
        },

        /** What the renderer has done and declined to do. */
        diagnostics(){
            return renderer.diagnostics();
        },

        /**
         * A swap chain's back buffer, made here because a resource belongs to
         * the device however it was asked for.
         *
         * @param {any} request
         * @returns {any}
         */
        createSwapChainBuffer(request){
            const desc = Object.freeze({
                Width: request.width,
                Height: request.height,
                MipLevels: 1,
                ArraySize: 1,
                Format: request.format,
                SampleDesc: Object.freeze({
                    Count: request.sampleDesc.count,
                    Quality: request.sampleDesc.quality,
                }),
                Usage: D3D10_USAGE.DEFAULT,
                BindFlags: bindFlagsForUsage(request.usage),
                CPUAccessFlags: 0,
                MiscFlags: 0,
                DXGIUsage: request.usage,
            });
            return createResource({
                dimension: D3D10_RESOURCE_DIMENSION.TEXTURE2D,
                desc,
                interfaces: textureInterfaces(desc, IID.ID3D10Texture2D,
                    D3D10_RESOURCE_DIMENSION.TEXTURE2D),
                retainDevice,
                releaseDevice,
                device: deviceHandle,
                storage,
                implicit: true,
                onFirstRef: request.onFirstRef,
                onLastRef: request.onLastRef,
            });
        },
    }, {
        interfaces: [IID.ID3D10Device, IID.ID3D10Device1, IID.ID3D10Multithread, IID.IDXGIObject,
            IID.IDXGIDevice, IID.IDXGIDevice1],
        parent: adapter,
        // The adapter is the device's to hold: a program that releases its own
        // reference to the adapter and keeps the device must still be able to
        // reach the adapter -- and the factory behind it -- through the device.
        onFirstRef: ()=>adapter.addRef(),
        onLastRef: ()=>adapter.release(),
    });

    if (factory)
    {
        // The factory and adapter this device made for itself are now held only
        // by the device, so releasing the device unwinds the whole graph and a
        // leak check has something to measure.
        enumerated.adapter.release();
        factory.release();
    }
    return self;
}
