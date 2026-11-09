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
    D3D10_APPEND_ALIGNED_ELEMENT, D3D10_BIND, D3D10_CREATE_DEVICE, D3D10_CREATE_DEVICE_MASK,
    D3D10_DRIVER_TYPE,
    D3D10_DRIVER_TYPES, D3D10_LIMITS, D3D10_QUERY,
    D3D10_RESOURCE_DIMENSION, D3D10_RESOURCE_MISC, D3D10_SDK_VERSION, D3D10_1_SDK_VERSION,
    D3D10_USAGE, D3D11_RESOURCE_MISC, D3D11_TWIN,
    DXGI_ERROR_INVALID_CALL, DXGI_ERROR_SDK_COMPONENT_MISSING, DXGI_ERROR_UNSUPPORTED, DXGI_FORMAT,
    D3D_FEATURE_LEVEL, E_FAIL,
    E_INVALIDARG, FORMAT_INFO, FORMAT_KIND, IID, S_FALSE, S_OK,
} from './constants.js';
import {
    SHADER_KIND, SYSTEM_VALUE, declaresBufferViews, parseDxbc, parseShaderOfKind,
} from './dxbc.js';
import { createSharing } from './sharing.js';
import { isSixteenBit } from './blocks.js';
import { createFactory } from './dxgi.js';
import {
    INDEX_FORMAT, MIPS_GENERATED, MULTISAMPLE_COUNT, PULLED_VERTEX_FORMAT, VERTEX_FORMAT,
    gpuRenderable, multisampleQualityLevels as webgpuMultisampleQualityLevels, textureStorage,
} from './gpuformats.js';
import { createDrawStatistics, createQueryObject } from './queries.js';
import { channelsOf } from './uavclear.js';
import { D3D10_COMMANDS } from './commands.js';
import { createRenderer } from './render.js';
import { validStreamOutput } from './streamout.js';
import {
    VIEW_KINDS, createResource, createView, resolveMipLevels, resolveViewDesc, textureInterfaces,
} from './resources.js';
import { copyPipeline, createPipelineState } from './pipeline.js';
import { createDeferredContext, createImmediateContext } from '../d3d11/context.js';
import { STATE_KIND, createStateStore } from './states.js';
import {
    DISPLAY_FORMATS, bindFlagsForUsage, bufferCreateResult, levelHasFormat, resolveViewFormat,
    textureCreateResult,
} from './validity.js';

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
    MULTISAMPLE_RESOLVE: 0x40000,
    DISPLAY: 0x80000,
    MULTISAMPLE_RENDERTARGET: 0x200000,
    MULTISAMPLE_LOAD: 0x400000,
});

/**
 * The views of a depth family that read its depth, and so can be sampled
 * against a reference: R32_FLOAT, R24_UNORM_X8_TYPELESS, R16_UNORM and
 * R32_FLOAT_X8X24_TYPELESS (D3D10's format support table).
 *
 * @type {ReadonlySet<number>}
 */
const DEPTH_READING_VIEWS = new Set([
    DXGI_FORMAT.R32_FLOAT, DXGI_FORMAT.R24_UNORM_X8_TYPELESS, DXGI_FORMAT.R16_UNORM,
    DXGI_FORMAT.R32_FLOAT_X8X24_TYPELESS,
]);

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
 * @property {(api: string, detail: string, severity?: 'loss') => void} [divergence]
 *     Where a call that succeeded without doing all it promises is reported.
 * @property {() => number} [now]  Milliseconds, for a timestamp query.
 * @property {boolean} [compressedTextures]  Whether the GPU samples BC blocks as they are;
 *     without it a block-compressed texture is decoded on the processor.
 * @property {boolean} [depthClipControl]  Whether the GPU device can leave depth
 *     unclipped, as a rasterizer state with DepthClipEnable FALSE asks.
 * @property {boolean} [formatsTier1]  Whether the GPU has texture-formats-tier1: the
 *     16-bit normalised formats, and the snorm ones as targets. Absent, taken as so.
 * @property {boolean} [rg11b10Renderable]  Whether it draws into R11G11B10_FLOAT.
 * @property {import('../webgpu/internal/latency.js').FrameQueued} [frameQueued]
 *     Told of every frame a swap chain's present queues; what it answers is
 *     what the present waits on before it answers the program.
 * @property {import('./render.js').GuestStorage} [guest]  Guest memory for the bytes of
 *     the resources a program maps, which a map then hands out as they are.
 * @property {ReturnType<typeof createSharing>} [sharing]  The shared resources of every
 *     device made with the same options (`sharing.js`).
 */

/**
 * The devices made with one options object, as a root makes all of its own,
 * share their shared resources.
 *
 * @type {WeakMap<object, ReturnType<typeof createSharing>>}
 */
const SHARINGS = new WeakMap();

/** @param {DeviceOptions} options */
function sharingOf(options){
    if (options.sharing)
    {
        return options.sharing;
    }
    let sharing = SHARINGS.get(options);
    if (!sharing)
    {
        sharing = createSharing();
        SHARINGS.set(options, sharing);
    }
    return sharing;
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
    if ((flags & CREATE_DEVICE_DEBUG) !== 0)
    {
        return DXGI_ERROR_SDK_COMPONENT_MISSING;
    }
    out.device = createDevice({ ...options, sharing: sharingOf(options), adapter, flags });
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
        // back would have no way of telling it apart from a full success. The
        // swap chain's own answer is the call's (d3d10_1.c:252-266).
        device.release();
        deviceOut.device = null;
        chain.swapChain = null;
        return created;
    }
    return S_OK;
}

// --- Direct3D 11 ---

/** D3D_DRIVER_TYPE as Direct3D 11 numbers it: 1 is the hardware, 0 an adapter's own. */
const D3D11_DRIVER_TYPE = Object.freeze({
    UNKNOWN: 0, HARDWARE: 1, REFERENCE: 2, NULL: 3, SOFTWARE: 4, WARP: 5,
});

/** D3D11_CREATE_DEVICE_* : every bit a program may pass. */
/**
 * The uncompressed families a compressed texture's blocks are copied to and
 * from, by the bytes of one texel: the D3D 10.1 rule ("Format Conversion
 * using Direct3D 10.1") Wine's test_compressed_format_compatibility checks.
 */
const BLOCK_COPY_FAMILIES = new Set(/** @type {number[]} */ ([DXGI_FORMAT.R32G32B32A32_TYPELESS,
    DXGI_FORMAT.R16G16B16A16_TYPELESS, DXGI_FORMAT.R32G32_TYPELESS]));

/**
 * Whether a copy between two formats moves blocks into texels or back: one
 * compressed, one uncompressed of an allowed family, a block the size of a texel.
 *
 * @param {number} a @param {number} b
 */
export function blockCopyable(a, b){
    const one = FORMAT_INFO[a];
    const other = FORMAT_INFO[b];
    if (!one || !other || (one.blockEdge === 1) === (other.blockEdge === 1))
    {
        return false;
    }
    const plain = one.blockEdge === 1 ? one : other;
    return one.bytesPerPixel === other.bytesPerPixel && BLOCK_COPY_FAMILIES.has(plain.family);
}

/**
 * Whether a copy moves R9G9B9E5_SHAREDEXP texels into a 32-bit family's or
 * back, which Direct3D 11's runtime makes (test_format_compatibility,
 * d3d11.c:29476) and Direct3D 10's does not (d3d10core.c:16362).
 *
 * @param {number} a @param {number} b
 */
function sharedExponentCopyable(a, b){
    const R9G9B9E5 = DXGI_FORMAT.R9G9B9E5_SHAREDEXP;
    return (a === R9G9B9E5 && FORMAT_INFO[b]?.family === DXGI_FORMAT.R32_TYPELESS)
        || (b === R9G9B9E5 && FORMAT_INFO[a]?.family === DXGI_FORMAT.R32_TYPELESS);
}

/**
 * D3D10_CREATE_DEVICE_DEBUG and D3D11_CREATE_DEVICE_DEBUG: the debug layer,
 * which is not here, as it is not on a Windows without its Graphics Tools
 * (decision A81).
 */
const CREATE_DEVICE_DEBUG = 0x2;

/** D3D11_CREATE_DEVICE_VIDEO_SUPPORT. */
const D3D11_CREATE_DEVICE_VIDEO_SUPPORT = 0x800;
const D3D11_CREATE_DEVICE_MASK = 0x1 | 0x2 | 0x4 | 0x8 | 0x20 | 0x40 | 0x80 | 0x100 | 0x800;

/**
 * The levels a device is made at here, the highest first. 11.1's interfaces
 * are not offered, and the 9.x levels' restrictions are not enforced, so
 * those are refused as an adapter without them refuses them.
 */
/** @type {readonly number[]} */
const DEVICE_LEVELS_11 = Object.freeze([
    D3D_FEATURE_LEVEL.LEVEL_11_0, D3D_FEATURE_LEVEL.LEVEL_10_1, D3D_FEATURE_LEVEL.LEVEL_10_0,
]);

/** What a program that names no levels is offered, in order. */
const DEFAULT_LEVELS_11 = Object.freeze([
    D3D_FEATURE_LEVEL.LEVEL_11_0, D3D_FEATURE_LEVEL.LEVEL_10_1, D3D_FEATURE_LEVEL.LEVEL_10_0,
    D3D_FEATURE_LEVEL.LEVEL_9_3, D3D_FEATURE_LEVEL.LEVEL_9_2, D3D_FEATURE_LEVEL.LEVEL_9_1,
]);

/** Every level the enumeration names, 9.1 to 12.1: anything else in the list is refused. */
const KNOWN_LEVELS = new Set([0x9100, 0x9200, 0x9300, 0xa000, 0xa100, 0xb000, 0xb100, 0xc000,
    0xc100]);

/**
 * @typedef {Object} DeviceRequest11
 * @property {boolean} wantDevice   whether the caller passed somewhere for the device
 * @property {boolean} wantContext  whether it passed somewhere for the immediate context
 * @property {any} [device]   the device made, with the caller's reference
 * @property {any} [made]     the device made, whoever holds it
 * @property {any} [context]  its immediate context, with the caller's reference
 * @property {number} [featureLevel]  the level chosen, 0 when the call failed
 */

/**
 * HRESULT D3D11CreateDevice(IDXGIAdapter*, D3D_DRIVER_TYPE, HMODULE, UINT,
 * const D3D_FEATURE_LEVEL*, UINT, UINT SDKVersion, ID3D11Device**,
 * D3D_FEATURE_LEVEL*, ID3D11DeviceContext**).
 *
 * The first level of the list the device can be made at is the one it is;
 * with no list, the runtime's own. Asked for neither the device nor its
 * context, the call says whether it could make one: S_FALSE.
 *
 * @param {any} adapter @param {number} driverType @param {any} software
 * @param {number} flags @param {readonly number[] | null} levels
 * @param {DeviceRequest11} out
 * @param {DeviceOptions} [options]
 * @returns {number}
 */
export function D3D11CreateDevice(adapter, driverType, software, flags, levels, out,
    options = {})
{
    out.device = null;
    out.context = null;
    out.featureLevel = 0;
    // An adapter given is the driver; a driver named needs no adapter.
    if (adapter ? driverType !== D3D11_DRIVER_TYPE.UNKNOWN
        : driverType === D3D11_DRIVER_TYPE.UNKNOWN || driverType > D3D11_DRIVER_TYPE.WARP)
    {
        return E_INVALIDARG;
    }
    if ((driverType === D3D11_DRIVER_TYPE.SOFTWARE) !== !!software
        || (flags & ~D3D11_CREATE_DEVICE_MASK) !== 0)
    {
        return E_INVALIDARG;
    }
    // No video device stands behind a device yet (decision A80, temporary): a
    // program that asks for one decodes its video another way.
    if ((flags & D3D11_CREATE_DEVICE_VIDEO_SUPPORT) !== 0)
    {
        return DXGI_ERROR_UNSUPPORTED;
    }
    if ((flags & CREATE_DEVICE_DEBUG) !== 0)
    {
        return DXGI_ERROR_SDK_COMPONENT_MISSING;
    }
    const asked = levels && levels.length > 0 ? levels : DEFAULT_LEVELS_11;
    if (asked.some(level=>!KNOWN_LEVELS.has(level)))
    {
        return E_INVALIDARG;
    }
    const level = asked.find(one=>DEVICE_LEVELS_11.includes(one));
    if (level === undefined)
    {
        return E_INVALIDARG;
    }
    out.featureLevel = level;
    if (!out.wantDevice && !out.wantContext)
    {
        return S_FALSE;
    }
    const device = createDevice({ ...options, sharing: sharingOf(options), adapter, flags,
        api: 'd3d11', featureLevel: level });
    out.made = device;
    if (out.wantContext)
    {
        const context = device.immediateContext();
        context.addRef();
        out.context = context;
    }
    if (out.wantDevice)
    {
        out.device = device;
    }
    else
    {
        // The context alone was asked for, and holds the device.
        device.release();
    }
    return S_OK;
}

/**
 * HRESULT D3D11CreateDeviceAndSwapChain(..., const DXGI_SWAP_CHAIN_DESC*,
 * IDXGISwapChain**, ID3D11Device**, D3D_FEATURE_LEVEL*, ID3D11DeviceContext**).
 *
 * A swap chain asked for needs its description and a window; asked for
 * nothing, the call answers as the device's create does.
 *
 * @param {any} adapter @param {number} driverType @param {any} software
 * @param {number} flags @param {readonly number[] | null} levels
 * @param {import('./structs.js').SwapChainFields | null} swapChainDesc
 * @param {DeviceRequest11 & { wantSwapChain: boolean, swapChain?: any }} out
 * @param {DeviceOptions} [options]
 * @returns {number}
 */
export function D3D11CreateDeviceAndSwapChain(adapter, driverType, software, flags, levels,
    swapChainDesc, out, options = {})
{
    out.swapChain = null;
    if (out.wantSwapChain && (!swapChainDesc || !swapChainDesc.outputWindow))
    {
        out.device = null;
        out.context = null;
        out.featureLevel = 0;
        return swapChainDesc ? DXGI_ERROR_INVALID_CALL : E_INVALIDARG;
    }
    const wanted = { wantDevice: out.wantDevice, wantContext: out.wantContext };
    // The device is made for the swap chain even when the caller keeps none.
    const request = { ...out, wantDevice: out.wantDevice || out.wantSwapChain };
    const hr = D3D11CreateDevice(adapter, driverType, software, flags, levels, request, options);
    out.featureLevel = request.featureLevel;
    out.context = request.context;
    out.made = request.made;
    if (hr !== S_OK || !out.wantSwapChain)
    {
        out.device = request.device;
        return hr;
    }
    const device = request.device;
    out.made = device;
    /** @type {{ swapChain?: any }} */
    const chain = {};
    const created = device.factory().CreateSwapChain(device, swapChainDesc, chain);
    if (created !== S_OK)
    {
        request.context?.release();
        device.release();
        out.device = null;
        out.made = null;
        out.context = null;
        out.featureLevel = 0;
        return created;
    }
    out.swapChain = chain.swapChain;
    if (wanted.wantDevice)
    {
        out.device = device;
    }
    else
    {
        // The swap chain holds the device it presents through.
        device.release();
        out.device = null;
    }
    return S_OK;
}

/**
 * D3D11_FEATURE_*'s answers, by the structure the program hands in: what
 * this device does past its level. Its views are emulated, so a command
 * list is the runtime's and not the driver's; WebGPU has no minimum
 * precision and no tiling to say; a 10.x level runs no compute.
 *
 * @param {number} feature @param {Uint8Array} input @param {number} level
 * @param {any} device  for a format's support
 * @returns {Uint8Array | null}  the structure's bytes, or null for a feature not known
 */
function featureSupport(feature, input, level, device){
    /** @param {number[]} words */
    const bytesOf = words=>new Uint8Array(Uint32Array.from(words).buffer);
    const format = input.length >= 4 ? new DataView(input.buffer, input.byteOffset).getUint32(0,
        true) : 0;
    switch (feature)
    {
        case 0: // THREADING: concurrent creates, driver command lists
            return bytesOf([1, 0]);
        case 1: // DOUBLES: worked out in integers (wgsl-doubles.js), at shader model 5
            return bytesOf([level >= 0xb000 ? 1 : 0]);
        case 2: { // FORMAT_SUPPORT: the format, then what it supports
            /** @type {{ support?: number }} */
            const held = {};
            return device.CheckFormatSupport(format, held) === S_OK
                ? bytesOf([format, held.support ?? 0]) : null;
        }
        case 3: // FORMAT_SUPPORT2: no typed view loads or atomics
            return bytesOf([format, 0]);
        case 4: // D3D10_X_HARDWARE_OPTIONS: compute at shader model 4
            return bytesOf([0]);
        case 5: { // D3D11_OPTIONS: of 11.1's fourteen, the extended doubles, exact as the rest
            const options = new Uint8Array(14 * 4);
            options[12 * 4] = level >= 0xb000 ? 1 : 0;
            return options;
        }
        case 6: // ARCHITECTURE_INFO: not a tiled renderer
            return bytesOf([0]);
        case 7: // D3D9_OPTIONS: textures of any size
            return bytesOf([1]);
        case 8: // SHADER_MIN_PRECISION_SUPPORT
            return bytesOf([0, 0]);
        case 9: // D3D9_SHADOW_SUPPORT: depth compared through a view
            return bytesOf([1]);
        case 10: // D3D11_OPTIONS1
            return new Uint8Array(4 * 4);
        case 11: // D3D9_SIMPLE_INSTANCING_SUPPORT
            return bytesOf([1]);
        case 12: // MARKER_SUPPORT
            return bytesOf([0]);
        case 13: // D3D9_OPTIONS1
            return bytesOf([1, 1, 1, 1]);
        case 14: // D3D11_OPTIONS2: none of its eight
            return new Uint8Array(8 * 4);
        case 15: // D3D11_OPTIONS3: a layer and viewport index from any stage
            return bytesOf([1]);
        default:
            void level;
            return null;
    }
}

/**
 * The bytes an input element's offset is a multiple of: its channel's size,
 * at most a word; a word for a format of packed channels.
 *
 * @param {number} format
 */
function elementAlignment(format){
    const bits = channelsOf(format)?.channels.map(channel=>channel.bits) ?? [];
    return bits.length > 0 && bits.every(one=>one === bits[0] && one % 8 === 0)
        ? Math.min(4, bits[0] / 8) : 4;
}

/**
 * @param {DeviceOptions & { flags?: number, api?: 'd3d10' | 'd3d11', featureLevel?: number }}
 *     [options]  `api` is the version whose entry point made it; `featureLevel` the
 *     level Direct3D 11 made it at
 */
export function createDevice(options = {}){
    const multisampleQualityLevels = options.multisampleQualityLevels
        ?? webgpuMultisampleQualityLevels;
    const caps = { multisampleQualityLevels };
    const factory = options.adapter
        ? null
        // Direct3D 11's runtime makes its own factory through DXGI 1.1's
        // entry point (test_device_interfaces); Direct3D 10's through 1.0's.
        : createFactory(options.factoryOptions, options.api === 'd3d11');
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
    const textureOptions = { compressed: options.compressedTextures ?? false,
        formatsTier1: options.formatsTier1, rg11b10Renderable: options.rg11b10Renderable };
    const renderer = createRenderer({
        backend: options.backend ?? null,
        createSampler: options.createSampler ?? (()=>null),
        createTexture: options.createTexture ?? (()=>null),
        divergence: options.divergence,
        compressedTextures: textureOptions.compressed,
        depthClipControl: options.depthClipControl ?? false,
        formatsTier1: options.formatsTier1,
        rg11b10Renderable: options.rg11b10Renderable,
        guest: options.guest,
        featureLevel: options.featureLevel,
    });
    const statistics = createDrawStatistics();
    /** @type {import('./resources.js').ResourceStorage} */
    const storage = {
        map: (resource, subresource)=>renderer.map(resource, subresource),
        unmap: (resource, subresource, discard, noOverwrite)=>
            renderer.unmap(resource, subresource, discard, noOverwrite),
        pending: resource=>renderer.pendingReadback(resource),
        readBack: resource=>renderer.readBack(resource),
        guest: resource=>renderer.guestOf(resource),
        addStorage: resource=>renderer.addStorage(resource),
        unmapStorage: (resource, base, discard, noOverwrite)=>
            renderer.unmapStorage(resource, base, discard, noOverwrite),
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

    /** Whether Direct3D 11 made the device, which decides what it answers to. */
    const d3d11 = options.api === 'd3d11';
    // Direct3D 10's device keeps the rasterizer state it binds alive past the
    // program's last reference, and nothing else (test_state_refcounting).
    const state = createPipelineState({ diverge, keepsBound: d3d11, keepsRasterizer: true });
    const featureLevel = options.featureLevel ?? D3D_FEATURE_LEVEL.LEVEL_10_0;
    const sharing = options.sharing ?? createSharing();
    /** The newest shader model the device takes, as 0xMm (`dxbc.js`). */
    const shaderModel = !d3d11 ? 0x40
        : featureLevel >= D3D_FEATURE_LEVEL.LEVEL_11_0 ? 0x50
            : featureLevel >= D3D_FEATURE_LEVEL.LEVEL_10_1 ? 0x41 : 0x40;
    /** @type {import('./validity.js').CreateRules} */
    const rules = { d3d11, featureLevel };
    /**
     * A resource only Direct3D 11 can describe -- a structured buffer, a
     * clamped texture -- answers to none of Direct3D 10's interfaces
     * (test_buffer_interfaces, test_texture1d_interfaces): its own list, in
     * Direct3D 11's names.
     *
     * @param {any} desc @param {string[]} interfaces
     */
    const elevenOnly = (desc, interfaces)=>(((desc.MiscFlags11 ?? 0)
        & (D3D11_RESOURCE_MISC.BUFFER_STRUCTURED | D3D11_RESOURCE_MISC.RESOURCE_CLAMP)) !== 0
        ? interfaces.map(id=>D3D11_TWIN[id] ?? id) : interfaces);
    /** Whether a context state was ever made, which has the device answer Direct3D 10. */
    let stateEmulation = false;
    /** The context state the immediate context is on, once one was swapped on. @type {any} */
    let currentState = null;
    /**
     * @param {string} emulated @param {boolean} implicit  the device's own, made at the
     *     first swap with no count of the program's
     */
    const contextState = (emulated, implicit)=>attachCom({
        /** Gone with its last reference, and what its pipeline binds with it. */
        get destroyed(){
            const gone = this.refCount === 0 && !(this.bound > 0);
            if (gone && this.pipeline)
            {
                state.letGo(this.pipeline);
                this.pipeline = null;
            }
            return gone;
        },
        emulated,
        /** @type {any} */
        pipeline: null,
        /** @param {{ device?: any }} target */
        GetDevice(target){
            retainDevice();
            target.device = self;
            return S_OK;
        },
    }, {
        interfaces: [IID.ID3D11DeviceChild, IID.ID3DDeviceContextState],
        implicit,
        onFirstRef: retainDevice,
        onLastRef: releaseDevice,
    });
    /** @type {import('../d3d11/context.js').ContextServices} */
    const contextServices = { device: deviceHandle, retainDevice, releaseDevice, diverge };
    const immediate = createImmediateContext(contextServices);
    let exceptionMode = 0;
    let textFilter = { width: 0, height: 0 };
    // A Direct3D 10 device is thread-safe unless it was made single-threaded;
    // Direct3D 11's leaves its context unguarded until asked
    // (test_immediate_context).
    let multithreadProtected = options.api !== 'd3d11'
        && ((options.flags ?? 0) & D3D10_CREATE_DEVICE.SINGLETHREADED) === 0;
    let maximumFrameLatency = DEFAULT_FRAME_LATENCY;

    /**
     * Says a format kept as another with what it changes (decisions.md A83,
     * temporary).
     *
     * @param {number} format
     */
    const noteKept = format=>{
        if (format === DXGI_FORMAT.R10G10B10_XR_BIAS_A2_UNORM)
        {
            diverge('R10G10B10_XR_BIAS_A2_UNORM is kept as R10G10B10A2_UNORM: its bias is'
                + ' not applied when it is drawn, read or shown');
        }
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
        const data = asSubresources(initialData);
        // Initial data that names no memory is a caller's mistake, not an
        // absent argument: the two are different calls and only one of them
        // satisfies an immutable resource.
        if (namesNoMemory(data))
        {
            return E_INVALIDARG;
        }
        const hr = textureCreateResult(desc, dimension, caps, !!data, rules);
        if (hr !== S_OK)
        {
            return hr;
        }
        noteKept(desc.Format);
        if ((desc.SampleDesc?.Count ?? 1) > 1 && (desc.ArraySize ?? 1) > 1)
        {
            diverge('a multisampled texture array is refused: WebGPU multisamples a texture'
                + ' of one layer only');
            return E_INVALIDARG;
        }
        const resolved = Object.freeze({
            ...desc,
            MipLevels: resolveMipLevels(desc, dimension),
            ArraySize: dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
                ? undefined
                : (desc.ArraySize ?? 1),
            SampleDesc: Object.freeze({ ...(desc.SampleDesc ?? { Count: 1, Quality: 0 }) }),
        });
        const keyed = (resolved.MiscFlags & D3D10_RESOURCE_MISC.SHARED_KEYEDMUTEX) !== 0;
        const interfaces = elevenOnly(resolved, textureInterfaces(resolved, iid, dimension));
        out.resource = createResource({
            dimension,
            desc: resolved,
            interfaces: keyed ? [...interfaces, IID.IDXGIKeyedMutex] : interfaces,
            retainDevice,
            releaseDevice,
            device: deviceHandle,
            storage,
            onLastRef: ()=>released(made),
        });
        const made = out.resource;
        renderer.resourceCreated(out.resource, data);
        if (keyed || (resolved.MiscFlags & D3D10_RESOURCE_MISC.SHARED) !== 0)
        {
            made.share = sharing.share(made, renderer.shareBacking(made), { keyed,
                nt: ((resolved.MiscFlags11 ?? 0) & D3D11_RESOURCE_MISC.SHARED_NTHANDLE) !== 0,
                interfaces: keyed ? [...interfaces, IID.IDXGIKeyedMutex] : interfaces });
        }
        return S_OK;
    };

    /**
     * A resource's last reference is gone: its storage with it, unless
     * another device's object of the same share still holds it.
     *
     * @param {any} resource
     */
    const released = resource=>{
        if (!resource.share || sharing.letGo(resource.share, deviceHandle()))
        {
            renderer.resourceReleased(resource);
        }
    };

    /**
     * ID3D11Device::OpenSharedResource and ID3D11Device1::OpenSharedResource1:
     * an object of this device over a texture another device made shared,
     * named by its legacy handle or by the key an NT handle names
     * (test_shared_resource). Each opens only what its kind of handle names.
     *
     * @param {number} key @param {{ resource?: any }} out @param {boolean} [nt]
     * @returns {number}
     */
    const openShared = (key, out, nt = false)=>{
        out.resource = null;
        const share = sharing.find(key);
        if (!share || share.nt !== nt)
        {
            return E_INVALIDARG;
        }
        const source = share.resource;
        const opened = createResource({
            dimension: source.dimension,
            desc: source.desc,
            interfaces: share.interfaces,
            retainDevice,
            releaseDevice,
            device: deviceHandle,
            storage,
            onLastRef: ()=>released(opened),
        });
        sharing.hold(share);
        opened.share = share;
        renderer.adoptBacking(opened, share.backing);
        out.resource = opened;
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
            eleven: kind.eleven,
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
     * A Direct3D 11 device takes the shader models its level has: 4.0 at
     * 10.0, 4.1 at 10.1, 5.0 at 11.0 -- and a hull, domain or compute shader
     * only at 5.0.
     *
     * @param {string} iid
     * @param {number} kind  A SHADER_KIND.
     * @param {{ shader?: any }} out
     * @param {Uint8Array | null} bytecode
     * @param {any} [made]  the container, parsed already
     * @returns {number}
     */
    const createShader = (iid, kind, out, bytecode, made = null)=>{
        out.shader = null;
        const container = made ?? (bytecode ? parseShaderOfKind(bytecode, kind, shaderModel)
            : null);
        if (!container || (kind >= SHADER_KIND.HULL
            && /** @type {any} */ (container.shader).major < 5))
        {
            return E_INVALIDARG;
        }
        if (featureLevel < D3D_FEATURE_LEVEL.LEVEL_11_0
            && declaresBufferViews(/** @type {any} */ (container.shader)))
        {
            return E_INVALIDARG;
        }
        out.shader = attachCom({
            container,
            // A geometry shader made of a vertex or domain shader's bytecode
            // to stream its vertices out: no stage of its own.
            passThrough: /** @type {any} */ (container.shader).kind === SHADER_KIND.VERTEX
                || /** @type {any} */ (container.shader).kind === SHADER_KIND.DOMAIN,
            /** @param {{ device?: any }} target */
            GetDevice(target){
                retainDevice();
                target.device = self;
                return S_OK;
            },
        }, {
            interfaces: [kind >= SHADER_KIND.HULL ? IID.ID3D11DeviceChild : IID.ID3D10DeviceChild,
                iid],
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
        // Direct3D 11 adds a stream-output count and overflow per stream.
        if (!desc || !(Object.values(D3D10_QUERY).includes(desc.Query)
            || (d3d11 && desc.Query >= 8 && desc.Query <= 15)))
        {
            return E_INVALIDARG;
        }
        // A stream's overflow is a predicate, which only CreateQuery makes
        // (test_create_query).
        const streamOverflow = desc.Query >= 8 && desc.Query % 2 === 1;
        const isPredicate = PREDICATE_QUERIES.has(desc.Query) || streamOverflow;
        if (predicate && (!isPredicate || streamOverflow))
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
                eleven: d3d11,
                streams: ()=>renderer.streamStatistics(),
                occlusion: {
                    begin: ()=>renderer.beginOcclusion(),
                    end: counter=>renderer.endOcclusion(counter),
                },
            }, { retainDevice, releaseDevice, device: deviceHandle });
        return S_OK;
    };

    const snapshot = ()=>state.snapshot();

    /**
     * Every draw, as the queries count it and the renderer records it.
     *
     * @param {{ vertexCount: number, startVertex: number, instanceCount?: number,
     *           indexCount?: number, startIndex?: number, baseVertex?: number,
     *           startInstance?: number, indirect?: { buffer: any, offset: number } }} request
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
        // One subresource of a texture copies into another of it; a resource
        // whole never into itself.
        if (!destination || !source || (destination === source
            && (call !== 'CopySubresourceRegion'
                || destination.dimension === D3D10_RESOURCE_DIMENSION.BUFFER)))
        {
            diverge(`${call} between a resource and itself, or with a null resource, is ignored`);
            return false;
        }
        // A region moves between textures of any shape: a slice of a volume
        // to or from a 2D texture's (test_copy_subresource_region_3d).
        const textures = destination.dimension !== D3D10_RESOURCE_DIMENSION.BUFFER
            && source.dimension !== D3D10_RESOURCE_DIMENSION.BUFFER;
        if (destination.dimension !== source.dimension
            && !(textures && call === 'CopySubresourceRegion'))
        {
            diverge(`${call} between resources of different kinds is ignored`);
            return false;
        }
        if (destination.desc.Usage === D3D10_USAGE.IMMUTABLE)
        {
            diverge(`${call} into an immutable resource is ignored`);
            return false;
        }
        // Direct3D 10's runtime copies into a depth-stencil texture only from
        // another; 11's from a colour one of its family too
        // (test_format_compatibility, d3d10core.c and d3d11.c).
        if (!d3d11 && (destination.desc.BindFlags & D3D10_BIND.DEPTH_STENCIL) !== 0
            && (source.desc.BindFlags & D3D10_BIND.DEPTH_STENCIL) === 0)
        {
            diverge(`${call} into a depth-stencil texture from a colour one is ignored,`
                + ' as Direct3D 10 ignores it');
            return false;
        }
        // Bits move between formats of one family, and from level 10.1 between
        // a compressed format and an uncompressed one whose texel is as big
        // as its block; a copy between any other two families has no meaning
        // and the runtime leaves the destination as it was.
        if (destination.dimension !== D3D10_RESOURCE_DIMENSION.BUFFER
            && FORMAT_INFO[destination.desc.Format]?.family
                !== FORMAT_INFO[source.desc.Format]?.family
            && !(featureLevel >= D3D_FEATURE_LEVEL.LEVEL_10_1
                && blockCopyable(destination.desc.Format, source.desc.Format))
            && !(d3d11 && sharedExponentCopyable(destination.desc.Format, source.desc.Format)))
        {
            diverge(`${call} between formats of different families is ignored`);
            return false;
        }
        return true;
    };

    /**
     * The arguments an indirect call reads out of a buffer: `count` words at
     * `offset`, from the bytes the device keeps of it; or, for a buffer the
     * GPU may have written them into, the buffer and offset the GPU reads
     * them from in its turn.
     *
     * @param {any} buffer @param {number} offset @param {number} count
     * @returns {Uint32Array | { buffer: any, offset: number } | null}
     */
    const indirectArguments = (buffer, offset, count)=>{
        if (!buffer || (offset & 3) !== 0
            || offset + count * 4 > (buffer.desc?.ByteWidth ?? 0))
        {
            return null;
        }
        if (renderer.gpuArguments?.(buffer))
        {
            return { buffer, offset };
        }
        const bytes = renderer.bufferBytes(buffer);
        return bytes ? new Uint32Array(bytes.slice(offset, offset + count * 4).buffer) : null;
    };

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
            const hr = bufferCreateResult(desc, !!data, rules);
            if (hr !== S_OK)
            {
                return hr;
            }
            out.resource = createResource({
                dimension: D3D10_RESOURCE_DIMENSION.BUFFER,
                desc: Object.freeze({ ...desc, MipLevels: 1, ArraySize: 1,
                    // A buffer of no structures has no stride (test_create_buffer).
                    StructureByteStride: ((desc.MiscFlags11 ?? 0)
                        & D3D11_RESOURCE_MISC.BUFFER_STRUCTURED) !== 0
                        ? desc.StructureByteStride : 0 }),
                interfaces: elevenOnly(desc, [IID.ID3D10DeviceChild, IID.ID3D10Resource,
                    IID.IDXGIObject, IID.IDXGIDeviceSubObject, IID.IDXGIResource,
                    IID.IDXGIResource1, IID.ID3D10Buffer]),
                retainDevice,
                releaseDevice,
                device: deviceHandle,
                storage,
                onLastRef: ()=>renderer.resourceReleased(made),
            });
            const made = out.resource;
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
            // Only a swap chain's first buffer is drawn into; the others are
            // there to be read (test_swapchain_flip).
            if ((resource?.backBufferIndex ?? 0) > 0)
            {
                if (out)
                {
                    out.view = null;
                }
                return E_INVALIDARG;
            }
            return createViewOf(resource, desc, VIEW_KINDS.RENDER_TARGET, out);
        },

        /** @param {any} resource @param {any} desc @param {{ view?: any }} out */
        CreateDepthStencilView(resource, desc, out){
            return createViewOf(resource, desc,
                d3d11 ? VIEW_KINDS.DEPTH_STENCIL11 : VIEW_KINDS.DEPTH_STENCIL, out);
        },

        /** @param {any} resource @param {any} desc @param {{ view?: any }} out */
        CreateShaderResourceView(resource, desc, out){
            if (d3d11 && desc?.ViewDimension === D3D10_SRV_DIMENSION1_TEXTURECUBEARRAY
                && featureLevel < D3D_FEATURE_LEVEL.LEVEL_10_1)
            {
                out.view = null;
                return E_INVALIDARG;
            }
            return createViewOf(resource, desc,
                d3d11 ? VIEW_KINDS.SHADER_RESOURCE11 : VIEW_KINDS.SHADER_RESOURCE, out);
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
         * A geometry shader is made, and a draw with one bound is skipped
         * (`render.js`): WebGPU has no geometry stage and none is emulated
         * here, and drawing the program's points and triangles where it
         * expands, culls or routes them would draw what it never asked for.
         * The shader is made because hardware of this level always has the
         * stage, so a program checks nothing before relying on it
         * (`roadmap/decisions.md`, A75).
         *
         * @param {Uint8Array} bytecode @param {{ shader?: any }} out
         */
        CreateGeometryShader(bytecode, out){
            return createShader(IID.ID3D10GeometryShader, SHADER_KIND.GEOMETRY, out, bytecode);
        },

        /**
         * Tessellation's two stages: a draw with both bound runs them and the
         * tessellator as compute passes (`tessellation.js`).
         *
         * @param {Uint8Array} bytecode @param {{ shader?: any }} out
         */
        CreateHullShader(bytecode, out){
            return createShader(IID.ID3D11HullShader, SHADER_KIND.HULL, out, bytecode);
        },
        /** @param {Uint8Array} bytecode @param {{ shader?: any }} out */
        CreateDomainShader(bytecode, out){
            return createShader(IID.ID3D11DomainShader, SHADER_KIND.DOMAIN, out, bytecode);
        },
        /** @param {Uint8Array} bytecode @param {{ shader?: any }} out */
        CreateComputeShader(bytecode, out){
            return createShader(IID.ID3D11ComputeShader, SHADER_KIND.COMPUTE, out, bytecode);
        },

        /**
         * Dynamic linkage's library of class instances. A shader that names
         * none links nothing, which is every shader made here: the linkage is
         * made and holds no instance.
         *
         * @param {{ linkage?: any }} out
         */
        CreateClassLinkage(out){
            out.linkage = attachCom({
                /** @param {{ device?: any }} target */
                GetDevice(target){
                    retainDevice();
                    target.device = self;
                    return S_OK;
                },
            }, {
                interfaces: [IID.ID3D11DeviceChild, IID.ID3D11ClassLinkage],
                onFirstRef: retainDevice,
                onLastRef: releaseDevice,
            });
            return S_OK;
        },

        /**
         * @param {any} resource @param {any} desc @param {{ view?: any }} out
         * @returns {number}
         */
        CreateUnorderedAccessView(resource, desc, out){
            out.view = null;
            if (featureLevel < D3D_FEATURE_LEVEL.LEVEL_11_0)
            {
                return E_INVALIDARG;
            }
            return createViewOf(resource, desc, VIEW_KINDS.UNORDERED_ACCESS, out);
        },

        /**
         * A context of its own pipeline, whose calls a command list carries
         * to the immediate context. A device made single-threaded has none.
         *
         * @param {number} flags @param {{ context?: any }} out
         */
        CreateDeferredContext(flags, out){
            out.context = null;
            if (flags !== 0 || ((options.flags ?? 0) & D3D10_CREATE_DEVICE.SINGLETHREADED) !== 0)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            out.context = createDeferredContext(contextServices, flags);
            return S_OK;
        },

        /** @returns {any} the immediate context, with no reference taken */
        immediateContext(){
            return immediate;
        },

        /** @returns {boolean} whether the context state swapped on is Direct3D 10's */
        drawsAsTen(){
            return currentState !== null && (currentState.emulated === IID.ID3D10Device
                || currentState.emulated === IID.ID3D10Device1);
        },

        /**
         * Direct3D 11.1's context state: a whole pipeline the immediate
         * context can be swapped onto, made for the version a program will
         * draw through. A device that has made one answers Direct3D 10's
         * interfaces as well (test_device_context_state).
         *
         * @param {readonly number[]} levels @param {string} emulated  the device interface
         * @param {{ state?: any, featureLevel?: number } | null} out  null asks whether one
         *     could be made
         * @returns {number}
         */
        CreateDeviceContextState(levels, emulated, out){
            const level = levels.find(one=>one <= featureLevel
                && one >= D3D_FEATURE_LEVEL.LEVEL_10_0);
            if (level === undefined
                || !/** @type {string[]} */ ([IID.ID3D10Device, IID.ID3D10Device1,
                    IID.ID3D11Device, IID.ID3D11Device1]).includes(emulated))
            {
                return E_INVALIDARG;
            }
            stateEmulation = true;
            if (!out)
            {
                return S_FALSE;
            }
            out.featureLevel = level;
            out.state = contextState(emulated, false);
            return S_OK;
        },

        /**
         * The immediate context's whole pipeline swapped for a context
         * state's: the one it had goes into the state handed back, which the
         * device made for it the first time.
         *
         * @param {any} next @param {{ previous?: any } | null} out
         */
        SwapDeviceContextState(next, out){
            if (!next)
            {
                if (out)
                {
                    out.previous = null;
                }
                return;
            }
            const previous = currentState ?? contextState(d3d11 ? IID.ID3D11Device
                : IID.ID3D10Device, true);
            if (next === previous)
            {
                // The state it is on: the pipeline is that state's already.
                if (out)
                {
                    previous.addRef();
                    out.previous = previous;
                }
                return;
            }
            previous.pipeline = state.exchange(next.pipeline);
            next.pipeline = null;
            next.bound = (next.bound ?? 0) + 1;
            previous.bound = Math.max(0, (previous.bound ?? 0) - 1);
            currentState = next;
            if (out)
            {
                previous.addRef();
                out.previous = previous;
            }
        },

        /**
         * A geometry shader, or a vertex shader's bytecode made into one,
         * with a declaration of what it streams out, taken or refused as
         * Windows does (streamout.js). Nothing is streamed out: the shader is
         * made so that a program goes on, a draw through a geometry shader is
         * skipped as any other is, and one through a vertex shader's draws as
         * if no geometry shader were bound, unless no stream is rasterized.
         *
         * @param {Uint8Array | null} bytecode
         * @param {readonly import('./streamout.js').StreamOutputEntry[] | null} declaration
         *     null where the program gave none
         * @param {readonly number[] | null} strides  each buffer's, or none
         * @param {number} rasterizedStream  0 under Direct3D 10
         * @param {{ shader?: any }} out
         */
        CreateGeometryShaderWithStreamOutput(bytecode, declaration, strides, rasterizedStream,
            out)
        {
            out.shader = null;
            // From level 11 the stage before may be the domain shader: what
            // the tessellator made is streamed out.
            const eleven = featureLevel >= D3D_FEATURE_LEVEL.LEVEL_11_0;
            const container = bytecode ? (parseShaderOfKind(bytecode, SHADER_KIND.GEOMETRY,
                shaderModel) ?? parseShaderOfKind(bytecode, SHADER_KIND.VERTEX, shaderModel)
                ?? (eleven ? parseShaderOfKind(bytecode, SHADER_KIND.DOMAIN, shaderModel) : null))
                : null;
            if (!container || !validStreamOutput({
                outputs: container.outputs, entries: declaration, strides, rasterizedStream,
                eleven, oneStride: !d3d11,
                vertex: /** @type {any} */ (container.shader).kind !== SHADER_KIND.GEOMETRY,
            }))
            {
                return E_INVALIDARG;
            }
            const hr = createShader(IID.ID3D10GeometryShader, SHADER_KIND.GEOMETRY, out, null,
                container);
            if (out.shader)
            {
                out.shader.rasterizedStream = rasterizedStream;
                out.shader.streamOutput = declaration
                    ? { entries: declaration.map(entry=>({ ...entry })),
                        strides: strides ? [...strides] : null }
                    : null;
            }
            return hr;
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
            // Direct3D 11 takes an empty array, not a null one (test_create_input_layout).
            if (given.length > D3D10_LIMITS.INPUT_ELEMENTS || !shaderBytecode
                || (d3d11 && elements === null))
            {
                return E_INVALIDARG;
            }
            // One slot's elements are all per vertex or all per instance.
            const classes = new Map();
            for (const element of given)
            {
                const slotClass = element.InputSlotClass ?? 0;
                if ((classes.get(element.InputSlot) ?? slotClass) !== slotClass)
                {
                    return E_INVALIDARG;
                }
                classes.set(element.InputSlot, slotClass);
            }
            for (const element of given)
            {
                if (!element.SemanticName || element.InputSlot >= D3D10_LIMITS.VERTEX_INPUT_SLOTS)
                {
                    return E_INVALIDARG;
                }
                // An element's offset is a whole number of its channels, up to
                // a word (test_input_layout_alignment).
                if (element.AlignedByteOffset !== D3D10_APPEND_ALIGNED_ELEMENT
                    && (element.AlignedByteOffset >>> 0) % elementAlignment(element.Format) !== 0)
                {
                    return E_INVALIDARG;
                }
            }
            const container = parseDxbc(shaderBytecode);
            if (!container)
            {
                return E_INVALIDARG;
            }
            // The input assembler makes the vertex and instance ids; every
            // other input -- a position a pixel shader's signature reads among
            // them -- is fed by an element (test_create_input_layout).
            for (const input of container.inputs)
            {
                // A pixel shader's signature names them without the value.
                if (input.systemValue === SYSTEM_VALUE.VERTEX_ID
                    || input.systemValue === SYSTEM_VALUE.INSTANCE_ID
                    || /^SV_(VERTEXID|INSTANCEID)$/i.test(input.name))
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
            if (!info || !levelHasFormat(format, featureLevel))
            {
                return E_FAIL;
            }
            const block = info.blockEdge > 1;
            const depth = info.kind === FORMAT_KIND.DEPTH;
            // A buffer holds elements a view can name: no blocks, and no depth.
            let support = FORMAT_SUPPORT.CPU_LOCKABLE
                | (block || depth ? 0 : FORMAT_SUPPORT.BUFFER);
            if (VERTEX_FORMAT[format] || PULLED_VERTEX_FORMAT[format])
            {
                support |= FORMAT_SUPPORT.IA_VERTEX_BUFFER;
            }
            if (INDEX_FORMAT[format])
            {
                support |= FORMAT_SUPPORT.IA_INDEX_BUFFER;
            }
            // The view of a depth family that reads its depth is kept as that
            // family's depth texture, whatever it would be as a colour.
            const readsDepth = DEPTH_READING_VIEWS.has(format);
            const kept = textureStorage(format, depth ? D3D10_BIND.DEPTH_STENCIL : 0,
                textureOptions) ?? (readsDepth ? { format: 'depth', conversion: null,
                depth: true } : null);
            if (kept)
            {
                // WebGPU makes no compressed or depth texture of three dimensions.
                support |= FORMAT_SUPPORT.TEXTURE2D | FORMAT_SUPPORT.TEXTURECUBE
                    | FORMAT_SUPPORT.MIP
                    | (block ? 0 : FORMAT_SUPPORT.TEXTURE1D)
                    | (block || kept.depth ? 0 : FORMAT_SUPPORT.TEXTURE3D);
            }
            if (kept && !kept.depth && info.kind === FORMAT_KIND.COLOUR)
            {
                support |= FORMAT_SUPPORT.SHADER_LOAD;
                // A 16-bit normalised format kept in floats is still the
                // format feature level 10.0 requires: sampled, drawn into and
                // blended, as Direct3D's own is.
                const sixteen = isSixteenBit(kept.conversion);
                const family = sixteen ? String(kept.conversion) : kept.format;
                // What a sampler may filter: normalised and float formats, but
                // not the 32-bit floats, which WebGPU does not filter.
                const filterable = sixteen || (/unorm|snorm|float/.test(kept.format)
                    && !/32float/.test(kept.format));
                if (filterable)
                {
                    support |= FORMAT_SUPPORT.SHADER_SAMPLE;
                }
                // A8_UNORM is drawn into as the alpha of an eight-bit texture;
                // its conversion is for the bytes a program uploads. A target is also
                // one only of a format the GPU draws into.
                if (info.renderable && (!kept.conversion || kept.conversion === 'a8' || sixteen)
                    && gpuRenderable(kept.format, textureOptions))
                {
                    // A normalised signed target is blended from feature
                    // level 10.1 (Wine's test_format_support sees 10.0 refuse it).
                    const blended = filterable && (!/snorm/.test(family)
                        || featureLevel >= D3D_FEATURE_LEVEL.LEVEL_10_1);
                    support |= FORMAT_SUPPORT.RENDER_TARGET
                        | (blended ? FORMAT_SUPPORT.BLENDABLE : 0);
                }
                if (MIPS_GENERATED.test(kept.format) && !kept.conversion)
                {
                    support |= FORMAT_SUPPORT.MIP_AUTOGEN;
                }
            }
            if (DISPLAY_FORMATS.has(format))
            {
                support |= FORMAT_SUPPORT.DISPLAY;
            }
            if (depth && kept)
            {
                support |= FORMAT_SUPPORT.DEPTH_STENCIL;
            }
            // Comparison is a read of depth, through the view that reads it:
            // the typed depth format itself is never bound to a shader.
            if (readsDepth)
            {
                support |= FORMAT_SUPPORT.SHADER_SAMPLE_COMPARISON;
            }
            if (multisampleQualityLevels(format, MULTISAMPLE_COUNT) > 0)
            {
                support |= FORMAT_SUPPORT.MULTISAMPLE_RENDERTARGET
                    | (depth || kept?.depth ? 0 : FORMAT_SUPPORT.MULTISAMPLE_RESOLVE
                        | FORMAT_SUPPORT.MULTISAMPLE_LOAD);
            }
            out.support = support;
            return S_OK;
        },

        ...state.methods,

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

        /** A draw of what stream output last left in the buffer at the first vertex slot. */
        DrawAuto(){
            renderer.drawAuto(snapshot());
        },

        /** @param {readonly any[]} buffers @param {readonly number[]} offsets */
        SOSetTargets(buffers, offsets){
            state.methods.SOSetTargets(buffers, offsets);
            renderer.streamTargets(buffers ?? [], offsets ?? []);
        },

        /**
         * A draw whose counts the GPU reads out of a buffer: its arguments
         * are read here, from the bytes the device keeps, as of now.
         *
         * @param {any} buffer @param {number} offset
         */
        DrawInstancedIndirect(buffer, offset){
            const words = indirectArguments(buffer, offset, 4);
            if (words && !(words instanceof Uint32Array))
            {
                // Counts the processor never sees: none are counted.
                draw({ vertexCount: 0, instanceCount: 0, startVertex: 0, indirect: words });
            }
            else if (words)
            {
                draw({ vertexCount: words[0], instanceCount: words[1], startVertex: words[2],
                    startInstance: words[3] });
            }
        },
        /** @param {any} buffer @param {number} offset */
        DrawIndexedInstancedIndirect(buffer, offset){
            const words = indirectArguments(buffer, offset, 5);
            if (words && !(words instanceof Uint32Array))
            {
                draw({ vertexCount: 0, startVertex: 0, indexCount: 0, instanceCount: 0,
                    indirect: words });
            }
            else if (words)
            {
                draw({ vertexCount: 0, startVertex: 0, indexCount: words[0],
                    instanceCount: words[1], startIndex: words[2], baseVertex: words[3] | 0,
                    startInstance: words[4] });
            }
        },

        /**
         * A compute shader run over a grid of thread groups.
         *
         * @param {number} x @param {number} y @param {number} z
         */
        Dispatch(x, y, z){
            if (x === 0 || y === 0 || z === 0)
            {
                return;
            }
            renderer.dispatch(state.snapshot(), { x, y, z });
        },
        /** @param {any} buffer @param {number} offset */
        DispatchIndirect(buffer, offset){
            const words = indirectArguments(buffer, offset, 3);
            if (words && !(words instanceof Uint32Array))
            {
                renderer.dispatch(state.snapshot(), words);
            }
            else if (words)
            {
                this.Dispatch(words[0], words[1], words[2]);
            }
        },

        /**
         * @param {any} view @param {readonly number[]} values  four words, each a channel's
         *     bits as the view's format holds them
         */
        ClearUnorderedAccessViewUint(view, values){
            if (view && values)
            {
                renderer.clearUnorderedAccessView(view, [...values], false);
            }
        },
        /** @param {any} view @param {readonly number[]} values  four floats */
        ClearUnorderedAccessViewFloat(view, values){
            if (view && values)
            {
                renderer.clearUnorderedAccessView(view, [...values], true);
            }
        },
        /**
         * An append view's hidden count, written into a buffer.
         *
         * @param {any} destination @param {number} offset @param {any} view
         */
        CopyStructureCount(destination, offset, view){
            if (destination && view)
            {
                renderer.copyStructureCount(destination, offset, view);
            }
        },

        /**
         * The most detailed level a shader may sample: kept for the getter,
         * and not applied -- WebGPU clamps a view's levels when the view is
         * made, not per resource.
         *
         * @param {any} resource @param {number} lod
         */
        SetResourceMinLOD(resource, lod){
            if (resource)
            {
                resource.minLod = lod;
                if (lod !== 0)
                {
                    diverge('SetResourceMinLOD is kept and not applied to sampling');
                }
            }
        },
        /** @param {any} resource @returns {number} */
        GetResourceMinLOD(resource){
            return resource?.minLod ?? 0;
        },

        /**
         * A deferred context's command list, played on the device: from a
         * cleared pipeline, as the list was recorded, and after it the
         * pipeline as it was -- or cleared, unless the program asks to keep
         * its own.
         *
         * @param {any} list @param {boolean} restore
         */
        ExecuteCommandList(list, restore){
            if (!list?.calls)
            {
                return;
            }
            const kept = state.capture();
            state.clear();
            // A list finished keeping its context's bindings starts from them.
            if (list.start)
            {
                state.restore(copyPipeline(list.start));
            }
            for (const [name, args] of list.calls)
            {
                if (name === 'Begin' || name === 'End')
                {
                    args[0]?.[name]();
                    continue;
                }
                /** @type {any} */ (self)[name](...args);
            }
            if (restore)
            {
                state.restore(kept);
            }
            else
            {
                state.clear();
            }
        },

        /**
         * What the device can do past its feature level, as a structure the
         * program names by number and hands in -- a format's support is
         * asked by the format at its head. A feature not known, or a size
         * not the structure's, is refused and nothing written.
         *
         * @param {number} feature @param {Uint8Array | null} data  the structure as given
         * @returns {{ hr: number, data?: Uint8Array }}
         */
        CheckFeatureSupport(feature, data){
            // A format with no support is E_FAIL with none written, as
            // CheckFormatSupport answers it (Wine's test_format_support).
            if (feature === 2 && data?.length === 8)
            {
                const format = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
                /** @type {{ support?: number }} */
                const held = {};
                const hr = this.CheckFormatSupport(format, held);
                return { hr: hr === S_OK ? S_OK : E_FAIL,
                    data: new Uint8Array(Uint32Array.of(format, held.support ?? 0).buffer) };
            }
            const answer = data ? featureSupport(feature, data, featureLevel, this) : null;
            return answer && answer.length === data?.length ? { hr: S_OK, data: answer }
                : { hr: E_INVALIDARG };
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

        /**
         * What a program wrote into a buffer mapped on a deferred context, put
         * where its command list plays: the whole buffer, whatever its usage,
         * as an immediate map's unmap puts it.
         *
         * @param {any} resource @param {Uint8Array} data
         */
        WriteMapped(resource, data){
            if (!resource || !data)
            {
                return;
            }
            renderer.updateSubresource(resource, 0, null, data, data.length, data.length);
        },

        /** @param {any} destination @param {any} source */
        CopyResource(destination, source){
            if (!copyable(destination, source, 'CopyResource'))
            {
                return;
            }
            // A compressed resource and an uncompressed one are of one extent
            // when they have as many blocks as the other has texels.
            const edge = (/** @type {any} */ desc)=>FORMAT_INFO[desc.Format]?.blockEdge ?? 1;
            const extent = ['ByteWidth', 'Width', 'Height', 'Depth', 'MipLevels', 'ArraySize'];
            /** @param {any} desc @param {string} field */
            const measure = (desc, field)=>((field === 'Width' || field === 'Height')
                && desc[field] !== undefined ? Math.ceil(desc[field] / edge(desc)) : desc[field]);
            if (extent.some(field=>measure(destination.desc, field)
                !== measure(source.desc, field)))
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
            if (destination === source && destinationSubresource === sourceSubresource)
            {
                diverge('CopySubresourceRegion of a subresource into itself is ignored');
                return;
            }
            if (box && (box.right <= box.left || box.bottom <= box.top || box.back <= box.front))
            {
                return;
            }
            // A depth stencil or multisampled resource is copied whole or not
            // at all: no box, no offset (test_format_compatibility).
            const whole = (/** @type {any} */ resource)=>resource.dimension
                !== D3D10_RESOURCE_DIMENSION.BUFFER
                && ((resource.desc.BindFlags & D3D10_BIND.DEPTH_STENCIL) !== 0
                    || (resource.desc.SampleDesc?.Count ?? 1) > 1);
            if ((whole(source) || whole(destination)) && (box || x || y || z))
            {
                diverge('CopySubresourceRegion of a part of a depth stencil or multisampled'
                    + ' resource is ignored, as the runtime ignores it');
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
            renderer.generateMips(resource, view.range ?? null);
        },

        /**
         * The samples of a multisampled texture averaged into a one-sample
         * one. Both have to be two-dimensional textures of one extent, the
         * destination a default one, and the format one each can be viewed
         * in: the resource's own when it is typed, a member of its family when
         * it is typeless. A call that breaks a rule is dropped, as the runtime
         * drops it; one that keeps them is made by the GPU in its turn.
         *
         * @param {any} destination
         * @param {number} destinationSubresource
         * @param {any} source
         * @param {number} sourceSubresource
         * @param {number} format
         */
        ResolveSubresource(destination, destinationSubresource, source, sourceSubresource,
            format)
        {
            const texture2D = (/** @type {any} */ resource)=>resource
                && resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE2D;
            if (!texture2D(destination) || !texture2D(source))
            {
                return;
            }
            const to = destination.desc;
            const from = source.desc;
            const castable = (/** @type {any} */ desc)=>{
                const info = FORMAT_INFO[desc.Format];
                return info && (info.kind === FORMAT_KIND.TYPELESS
                    ? resolveViewFormat(desc.Format, format) === format
                    : desc.Format === format);
            };
            const level = destinationSubresource % to.MipLevels;
            if (from.SampleDesc.Count < 2 || to.SampleDesc.Count !== 1
                || to.Usage !== D3D10_USAGE.DEFAULT
                || sourceSubresource >= from.MipLevels * from.ArraySize
                || destinationSubresource >= to.MipLevels * to.ArraySize
                || Math.max(1, to.Width >>> level) !== from.Width
                || Math.max(1, to.Height >>> level) !== from.Height
                || !castable(from) || !castable(to))
            {
                return;
            }
            renderer.resolve(destination, destinationSubresource, source, sourceSubresource,
                format);
        },

        /** What has been recorded goes to the GPU now rather than at the next present. */
        Flush(){
            renderer.flush();
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
         * A texture another device of the same root made shared, by its
         * legacy handle.
         *
         * @param {number} handle @param {{ resource?: any }} out
         * @returns {number}
         */
        OpenSharedResource(handle, out){
            return openShared(handle, out);
        },

        /**
         * By the key an NT handle names (`ntShareKey`): only a texture made
         * with SHARED_NTHANDLE.
         *
         * @param {number} key @param {{ resource?: any }} out
         * @returns {number}
         */
        OpenSharedResource1(key, out){
            return openShared(key, out, true);
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
            state.clear();
        },

        /** @returns {number} the level the device was made at: 10.0 for Direct3D 10's */
        GetFeatureLevel(){
            return featureLevel;
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
            if (!out || (format !== DXGI_FORMAT.UNKNOWN && !FORMAT_INFO[format]))
            {
                return E_INVALIDARG;
            }
            // No sample at all, or more than the API has room for, is a
            // failure and still an answer of none (test_check_multisample_
            // quality_levels).
            if (sampleCount === 0 || sampleCount > D3D10_LIMITS.MAX_MULTISAMPLE_SAMPLE_COUNT)
            {
                out.levels = 0;
                return E_FAIL;
            }
            out.levels = format === DXGI_FORMAT.UNKNOWN
                ? 0
                : multisampleQualityLevels(format, sampleCount);
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

        /**
         * Where DXGI says what it accepted and did not do, as the device's own
         * calls say it.
         *
         * @param {string} detail
         */
        diverge(detail){
            diverge(detail);
        },

        /**
         * A run of the calls the program's routines wrote into the device's
         * command ring (`seam/d3d10-inguest.js`), made in order: one call
         * here, which a recording sends as one and its twin makes the same.
         *
         * @param {Uint8Array} records  whole records (`d3d8/commands.js`)
         * @param {readonly any[]} objects  what their object arguments name, in order
         * @returns {number} how many calls were made
         */
        commands(records, objects){
            return D3D10_COMMANDS.runCommands(this, records, objects, ()=>{});
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
            noteKept(request.format);
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
                // A swap chain made GDI-compatible makes its buffers so.
                MiscFlags: request.gdiCompatible ? D3D10_RESOURCE_MISC.GDI_COMPATIBLE : 0,
                DXGIUsage: request.usage,
            });
            const buffer = createResource({
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
            /** @type {any} */ (buffer).backBufferIndex = request.index ?? 0;
            return buffer;
        },
    }, {
        // Direct3D 10's device is Direct3D 11's too; one made by Direct3D 11
        // is not Direct3D 10's (test_device_interfaces).
        also: iid=>stateEmulation && (iid === IID.ID3D10Device || iid === IID.ID3D10Device1),
        interfaces: [...(d3d11 ? [IID.ID3D11Device1] : [IID.ID3D10Device, IID.ID3D10Device1]),
            IID.ID3D11Device,
            IID.ID3D10Multithread, IID.IDXGIObject, IID.IDXGIDevice, IID.IDXGIDevice1,
            IID.IDXGIDevice2, IID.IDXGIDevice3, IID.IDXGIDevice4],
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
