/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
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
    D3D10_CREATE_DEVICE_MASK, D3D10_DEFAULTS, D3D10_DRIVER_TYPE, D3D10_DRIVER_TYPES, D3D10_LIMITS,
    D3D10_PRIMITIVE_TOPOLOGY, D3D10_RESOURCE_DIMENSION, D3D10_SDK_VERSION, D3D10_USAGE,
    DXGI_ERROR_INVALID_CALL, DXGI_FORMAT, D3D_FEATURE_LEVEL, E_INVALIDARG, IID, S_OK,
} from './constants.js';
import { createFactory } from './dxgi.js';
import {
    VIEW_KINDS, createResource, createView, resolveMipLevels, resolveViewDesc, textureInterfaces,
} from './resources.js';
import { STATE_KIND, createStateStore } from './states.js';
import { bindFlagsForUsage, bufferCreateResult, textureCreateResult } from './validity.js';

/**
 * @typedef {Object} DeviceOptions
 * @property {any} [adapter]   The adapter the device runs on; one is made if absent.
 * @property {(format: number, sampleCount: number) => number} [multisampleQualityLevels]
 * @property {import('./dxgi.js').FactoryOptions} [factoryOptions]
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
    };

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
        // Initial data that names no memory is a caller's mistake, not an
        // absent argument: the two are different calls and only one of them
        // satisfies an immutable resource.
        if (initialData && !initialData.pSysMem)
        {
            return E_INVALIDARG;
        }
        const hr = textureCreateResult(desc, dimension, caps, !!initialData);
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
        });
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
            dimensions: kind.dimensions,
            bindFlag: kind.bindFlag,
            mipRange: kind.mipRange,
        });
        if (!resolved)
        {
            return E_INVALIDARG;
        }
        out.view = createView({
            resource,
            desc: Object.freeze(resolved),
            iid: kind.iid,
            retainDevice,
            releaseDevice,
            device: deviceHandle,
        });
        return S_OK;
    };

    /**
     * @param {string} iid
     * @param {{ shader?: any }} out
     * @param {any} bytecode
     * @returns {number}
     */
    const createShader = (iid, out, bytecode)=>{
        out.shader = null;
        if (!bytecode)
        {
            return E_INVALIDARG;
        }
        // The bytecode is kept and not read: translating it is a separate piece
        // of work, and everything this layer promises is observable without it.
        out.shader = attachCom({ bytecode }, {
            interfaces: [iid],
            onFirstRef: retainDevice,
            onLastRef: releaseDevice,
        });
        return S_OK;
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
            if (initialData && !initialData.pSysMem)
            {
                return E_INVALIDARG;
            }
            const hr = bufferCreateResult(desc, !!initialData);
            if (hr !== S_OK)
            {
                return hr;
            }
            out.resource = createResource({
                dimension: D3D10_RESOURCE_DIMENSION.BUFFER,
                desc: Object.freeze({ ...desc, MipLevels: 1, ArraySize: 1 }),
                interfaces: [IID.IDXGIObject, IID.IDXGIDeviceSubObject, IID.IDXGIResource,
                    IID.ID3D10Buffer],
                retainDevice,
                releaseDevice,
                device: deviceHandle,
            });
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

        // --- immutable state objects ---

        /** @param {any} desc @param {{ state?: any }} out */
        CreateBlendState(desc, out){
            out.state = null;
            return states.create(STATE_KIND.BLEND, desc, out);
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

        /** @param {any} bytecode @param {{ shader?: any }} out */
        CreateVertexShader(bytecode, out){
            return createShader(IID.ID3D10VertexShader, out, bytecode);
        },

        /** @param {any} bytecode @param {{ shader?: any }} out */
        CreateGeometryShader(bytecode, out){
            return createShader(IID.ID3D10GeometryShader, out, bytecode);
        },

        /** @param {any} bytecode @param {{ shader?: any }} out */
        CreatePixelShader(bytecode, out){
            return createShader(IID.ID3D10PixelShader, out, bytecode);
        },

        /**
         * @param {readonly any[]} elements
         * @param {any} shaderBytecode  The signature the layout is matched against.
         * @param {{ layout?: any }} out
         * @returns {number}
         */
        CreateInputLayout(elements, shaderBytecode, out){
            out.layout = null;
            if (!elements || elements.length === 0
                || elements.length > D3D10_LIMITS.INPUT_ELEMENTS || !shaderBytecode)
            {
                return E_INVALIDARG;
            }
            for (const element of elements)
            {
                if (!element.SemanticName || element.InputSlot >= D3D10_LIMITS.VERTEX_INPUT_SLOTS)
                {
                    return E_INVALIDARG;
                }
            }
            out.layout = attachCom({ elements: Object.freeze([...elements]) }, {
                interfaces: [IID.ID3D10InputLayout],
                onFirstRef: retainDevice,
                onLastRef: releaseDevice,
            });
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
            pipeline.viewports = (viewports ?? [])
                .slice(0, D3D10_LIMITS.VIEWPORT_AND_SCISSOR_SLOTS)
                .map(viewport=>({ ...viewport }));
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
        },

        /** @returns {number} always 10.0: this entry point has no other level */
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
                implicit: true,
                onFirstRef: request.onFirstRef,
                onLastRef: request.onLastRef,
            });
        },
    }, {
        interfaces: [IID.ID3D10Device, IID.ID3D10Multithread, IID.IDXGIObject, IID.IDXGIDevice,
            IID.IDXGIDevice1],
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
