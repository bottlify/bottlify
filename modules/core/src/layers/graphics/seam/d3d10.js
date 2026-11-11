/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 10 and DXGI, between a guest call and the objects in `d3d10/`.
 *
 * Everything here is translation: a slot reads the arguments the guest pushed,
 * turns pointers into structures and interface pointers into objects, calls
 * the method that already exists, and writes back whatever the caller left
 * room for. Every slot of every interface is declared, so a method with no
 * implementation answers E_NOTIMPL from the index the guest compiled against
 * rather than shifting the ones after it.
 *
 * Two things this API does differently from the older ones, and both shape
 * the seam:
 *
 * - **An array of interfaces arrives as a pointer and a count**, so a `Set`
 *   reads `count` pointers and a `Get` writes `count` back, each one already
 *   referenced by the object model for the caller.
 * - **A map hands the program memory it writes directly.** The objects keep
 *   their bytes on the host, so a map allocates a guest block of the
 *   subresource's size, shows it the current bytes, and the unmap reads the
 *   block back before the object is told. The block lives as long as the map.
 */

import { describe as describeSlots } from './vtables.js';
import { compiledAt } from './shadow.js';
import { createDeviceRing } from './d3d10-ring.js';
import { createDirect3D11Seam } from './d3d11.js';
import { COMPILED } from './d3d10-inguest.x86.js';

/** The routines by name. @type {Record<string, any>} */
const IN_GUEST = COMPILED;
import { ID3D10DEVICE_SLOTS } from '../d3d10/slots.js';
import { createEffectSeam } from './d3d10-effect.js';
import { readGuid } from './ddraw.js';
import { describeAdapter } from './adapter.js';
import { createFields } from './structs.js';
import { SHADER_KIND } from '../d3d10/dxbc.js';
import {
    D3D10_CPU_ACCESS, D3D10_LIMITS, D3D10_MAP, D3D10_MAP_FLAG_DO_NOT_WAIT,
    D3D10_RESOURCE_DIMENSION, D3D10_USAGE,
    DXGI_ERROR_INVALID_CALL, DXGI_ERROR_MORE_DATA, DXGI_ERROR_UNSUPPORTED, E_FAIL, E_INVALIDARG,
    E_NOINTERFACE, E_NOTIMPL, E_OUTOFMEMORY, IID, S_OK, formatPitch,
} from '../d3d10/constants.js';
import {
    DXGI_MODE_DESC, VIEW_UNION, readModeDesc, readSwapChainDesc, readSwapChainDesc1,
    readViewDesc, writeFullscreenDesc, writeModeDesc, writeSwapChainDesc, writeSwapChainDesc1,
    writeViewDesc,
} from '../d3d10/structs.js';
import { bindFlagsForUsage, levelExtent } from '../d3d10/validity.js';
import {
    D3DERR_INVALIDCALL, SHADER_BUFFER_DESC_FIELDS, SHADER_DESC_FIELDS, SHADER_PROFILE,
    SHADER_TYPE_DESC_FIELDS, SHADER_VARIABLE_DESC_FIELDS, containerOf, createBlob,
    createShaderReflection, debugInfoOf, reflectShader,
} from '../d3d10/reflection.js';
import { STATE_BLOCK_MASK_SIZE, createStateBlock, stateBlockMask } from '../d3d10/stateblock.js';
import { createCompilerSeam } from './d3dcompiler.js';

/**
 * A method here may answer nothing: the setters of this API are `void`, and
 * the bridge reads an absent result as zero. It may also answer a promise,
 * which the bridge parks the caller on. The declared type of a slot's
 * implementation says a number, so the map is widened once, here.
 *
 * @param {string} id
 * @param {[string, number][]} slots
 * @param {Record<string, (target: any, args: number[]) => number | void | Promise<number>>}
 *     implemented
 */
/**
 * @param {string} id @param {[string, number][]} slots
 * @param {Record<string, (target: any, args: number[]) => number | void | Promise<number>>}
 *     implemented
 * @param {Record<string, (builder: { trap: number }) => number>} [guests]
 * @param {(target: any, pointers: Iterable<number>) => void} [released]
 */
const describeAt = (id, slots, implemented, guests = {}, released = undefined)=>describeSlots(id,
    slots, /** @type {Record<string, (target: any, args: number[]) => number>} */ (implemented),
    guests, released);

/**
 * ID3D10Device's methods that run in the guest (`d3d10-inguest.js`): each
 * writes its call into the device's command ring.
 */
const RING_METHODS = Object.freeze(['VSSetShader', 'PSSetShader', 'GSSetShader',
    'IASetInputLayout', 'IASetPrimitiveTopology', 'RSSetState', 'VSSetConstantBuffers',
    'PSSetConstantBuffers', 'GSSetConstantBuffers', 'VSSetShaderResources',
    'PSSetShaderResources', 'GSSetShaderResources', 'VSSetSamplers', 'PSSetSamplers',
    'GSSetSamplers', 'IASetVertexBuffers', 'IASetIndexBuffer', 'OMSetRenderTargets',
    'OMSetBlendState', 'OMSetDepthStencilState', 'RSSetViewports', 'RSSetScissorRects', 'Draw',
    'DrawIndexed', 'DrawInstanced', 'DrawIndexedInstanced', 'ClearRenderTargetView',
    'ClearDepthStencilView']);

/**
 * Direct3D 11's immediate context's methods that run in the guest, by the
 * routine that carries each: 10's own where the two calls mean the same, a
 * routine of the context's where 11's arguments differ.
 */
export const CONTEXT_RING = Object.freeze({
    ...Object.fromEntries(['IASetInputLayout', 'IASetPrimitiveTopology', 'RSSetState',
        'VSSetConstantBuffers', 'PSSetConstantBuffers', 'GSSetConstantBuffers',
        'VSSetShaderResources', 'PSSetShaderResources', 'GSSetShaderResources', 'VSSetSamplers',
        'PSSetSamplers', 'GSSetSamplers', 'IASetVertexBuffers', 'IASetIndexBuffer',
        'OMSetRenderTargets', 'OMSetBlendState', 'OMSetDepthStencilState', 'RSSetScissorRects',
        'Draw', 'DrawIndexed', 'DrawInstanced', 'DrawIndexedInstanced', 'ClearRenderTargetView',
        'ClearDepthStencilView'].map(name=>[name, name])),
    VSSetShader: 'ContextVSSetShader',
    PSSetShader: 'ContextPSSetShader',
    GSSetShader: 'ContextGSSetShader',
    RSSetViewports: 'ContextRSSetViewports',
    Map: 'ContextMap',
    Unmap: 'ContextUnmap',
});

/** DXGI_ERROR_NOT_CURRENTLY_AVAILABLE, for what a browser has no counterpart of. */
const DXGI_ERROR_NOT_CURRENTLY_AVAILABLE = 0x887a0022 | 0;

/** DXGI_RESIDENCY_FULLY_RESIDENT. */
const DXGI_RESIDENCY_FULLY_RESIDENT = 1;
/** DXGI_PRESENT_TEST: a present that only asks whether it would be shown. */
const DXGI_PRESENT_TEST = 0x1;

// --- structures, by offset ---

const D3D10_BUFFER_DESC = Object.freeze({
    ByteWidth: 0x00, Usage: 0x04, BindFlags: 0x08, CPUAccessFlags: 0x0c, MiscFlags: 0x10,
    SIZE: 0x14,
});

const D3D10_TEXTURE1D_DESC = Object.freeze({
    Width: 0x00, MipLevels: 0x04, ArraySize: 0x08, Format: 0x0c, Usage: 0x10, BindFlags: 0x14,
    CPUAccessFlags: 0x18, MiscFlags: 0x1c, SIZE: 0x20,
});

const D3D10_TEXTURE2D_DESC = Object.freeze({
    Width: 0x00, Height: 0x04, MipLevels: 0x08, ArraySize: 0x0c, Format: 0x10,
    SampleCount: 0x14, SampleQuality: 0x18, Usage: 0x1c, BindFlags: 0x20, CPUAccessFlags: 0x24,
    MiscFlags: 0x28, SIZE: 0x2c,
});

const D3D10_TEXTURE3D_DESC = Object.freeze({
    Width: 0x00, Height: 0x04, Depth: 0x08, MipLevels: 0x0c, Format: 0x10, Usage: 0x14,
    BindFlags: 0x18, CPUAccessFlags: 0x1c, MiscFlags: 0x20, SIZE: 0x24,
});

const D3D10_SUBRESOURCE_DATA = Object.freeze({
    pSysMem: 0x00, SysMemPitch: 0x04, SysMemSlicePitch: 0x08, SIZE: 0x0c,
});

/** The same in a 64-bit process: pSysMem a quadword. */
const D3D10_SUBRESOURCE_DATA_64 = Object.freeze({
    pSysMem: 0x00, SysMemPitch: 0x08, SysMemSlicePitch: 0x0c, SIZE: 0x10,
});

const D3D10_BLEND_DESC = Object.freeze({
    AlphaToCoverageEnable: 0x00, BlendEnable: 0x04, SrcBlend: 0x24, DestBlend: 0x28,
    BlendOp: 0x2c, SrcBlendAlpha: 0x30, DestBlendAlpha: 0x34, BlendOpAlpha: 0x38,
    RenderTargetWriteMask: 0x3c, SIZE: 0x44,
});

const D3D10_DEPTH_STENCIL_DESC = Object.freeze({
    DepthEnable: 0x00, DepthWriteMask: 0x04, DepthFunc: 0x08, StencilEnable: 0x0c,
    StencilReadMask: 0x10, StencilWriteMask: 0x11, FrontFace: 0x14, BackFace: 0x24, SIZE: 0x34,
});

const STENCIL_FACE = Object.freeze({
    StencilFailOp: 0x00, StencilDepthFailOp: 0x04, StencilPassOp: 0x08, StencilFunc: 0x0c,
});

const D3D10_RASTERIZER_DESC = Object.freeze({
    FillMode: 0x00, CullMode: 0x04, FrontCounterClockwise: 0x08, DepthBias: 0x0c,
    DepthBiasClamp: 0x10, SlopeScaledDepthBias: 0x14, DepthClipEnable: 0x18, ScissorEnable: 0x1c,
    MultisampleEnable: 0x20, AntialiasedLineEnable: 0x24, SIZE: 0x28,
});

const D3D10_SAMPLER_DESC = Object.freeze({
    Filter: 0x00, AddressU: 0x04, AddressV: 0x08, AddressW: 0x0c, MipLODBias: 0x10,
    MaxAnisotropy: 0x14, ComparisonFunc: 0x18, BorderColor: 0x1c, MinLOD: 0x2c, MaxLOD: 0x30,
    SIZE: 0x34,
});

const D3D10_VIEWPORT = Object.freeze({
    TopLeftX: 0x00, TopLeftY: 0x04, Width: 0x08, Height: 0x0c, MinDepth: 0x10, MaxDepth: 0x14,
    SIZE: 0x18,
});

const D3D10_INPUT_ELEMENT_DESC = Object.freeze({
    SemanticName: 0x00, SemanticIndex: 0x04, Format: 0x08, InputSlot: 0x0c,
    AlignedByteOffset: 0x10, InputSlotClass: 0x14, InstanceDataStepRate: 0x18, SIZE: 0x1c,
});

/** The same in a 64-bit process: SemanticName a quadword. */
const D3D10_INPUT_ELEMENT_DESC_64 = Object.freeze({
    SemanticName: 0x00, SemanticIndex: 0x08, Format: 0x0c, InputSlot: 0x10,
    AlignedByteOffset: 0x14, InputSlotClass: 0x18, InstanceDataStepRate: 0x1c, SIZE: 0x20,
});

const D3D10_BOX = Object.freeze({
    left: 0x00, top: 0x04, front: 0x08, right: 0x0c, bottom: 0x10, back: 0x14, SIZE: 0x18,
});

const D3D10_QUERY_DESC = Object.freeze({ Query: 0x00, MiscFlags: 0x04, SIZE: 0x08 });

const DXGI_SURFACE_DESC = Object.freeze({
    Width: 0x00, Height: 0x04, Format: 0x08, SampleCount: 0x0c, SampleQuality: 0x10, SIZE: 0x14,
});

/**
 * DXGI_MAP_READ, _WRITE and _DISCARD as the Direct3D map they ask for, or
 * zero for a combination that asks for nothing a map can be.
 *
 * @param {number} flags
 * @returns {number}
 */
const dxgiMapType = flags=>{
    if ((flags & 0x4) !== 0)
    {
        return (flags & 0x1) === 0 ? D3D10_MAP.WRITE_DISCARD : 0;
    }
    switch (flags & 0x3)
    {
        case 0x1:
            return D3D10_MAP.READ;
        case 0x2:
            return D3D10_MAP.WRITE;
        case 0x3:
            return D3D10_MAP.READ_WRITE;
        default:
            return 0;
    }
};

const RECT = Object.freeze({ left: 0x00, top: 0x04, right: 0x08, bottom: 0x0c, SIZE: 0x10 });

/** DXGI_ADAPTER_DESC: a 128-wide-character description first. */
const DXGI_ADAPTER_DESC = Object.freeze({
    Description: 0x000, VendorId: 0x100, DeviceId: 0x104, SubSysId: 0x108, Revision: 0x10c,
    DedicatedVideoMemory: 0x110, DedicatedSystemMemory: 0x114, SharedSystemMemory: 0x118,
    AdapterLuidLow: 0x11c, AdapterLuidHigh: 0x120, SIZE: 0x124,
});

/** The same in a 64-bit process: the three memories SIZE_T, quadwords. */
const DXGI_ADAPTER_DESC_64 = Object.freeze({
    Description: 0x000, VendorId: 0x100, DeviceId: 0x104, SubSysId: 0x108, Revision: 0x10c,
    DedicatedVideoMemory: 0x110, DedicatedSystemMemory: 0x118, SharedSystemMemory: 0x120,
    AdapterLuidLow: 0x128, AdapterLuidHigh: 0x12c, SIZE: 0x130,
});

/** DXGI_OUTPUT_DESC: a 32-wide-character name first. */
const DXGI_OUTPUT_DESC = Object.freeze({
    DeviceName: 0x00, DesktopCoordinates: 0x40, AttachedToDesktop: 0x50, Rotation: 0x54,
    Monitor: 0x58, SIZE: 0x5c,
});

/** The same in a 64-bit process: Monitor an HMONITOR, a quadword. */
const DXGI_OUTPUT_DESC_64 = Object.freeze({ ...DXGI_OUTPUT_DESC, SIZE: 0x60 });

/**
 * DXGI_GRAPHICS_PREEMPTION_DMA_BUFFER_BOUNDARY and
 * DXGI_COMPUTE_PREEMPTION_DISPATCH_BOUNDARY: where a GPU of today's driver
 * model can stop a draw and a dispatch.
 */
const PREEMPTION_DMA_BUFFER = 0;
const PREEMPTION_DISPATCH = 1;

/** What the adapter claims to have, in bytes: enough that no program budgets down. */
const REPORTED_VIDEO_MEMORY = 1 << 30;

// --- slot tables, after IUnknown's three ---

const IDXGIOBJECT_SLOTS = /** @type {[string, number][]} */ ([
    ['SetPrivateData', 3],
    ['SetPrivateDataInterface', 2],
    ['GetPrivateData', 3],
    ['GetParent', 2],
]);

export const IDXGIFACTORY_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIOBJECT_SLOTS,
    ['EnumAdapters', 2],
    ['MakeWindowAssociation', 2],
    ['GetWindowAssociation', 1],
    ['CreateSwapChain', 3],
    ['CreateSoftwareAdapter', 2],
]);

export const IDXGIFACTORY1_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIFACTORY_SLOTS,
    ['EnumAdapters1', 2],
    ['IsCurrent', 0],
]);

export const IDXGIADAPTER_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIOBJECT_SLOTS,
    ['EnumOutputs', 2],
    ['GetDesc', 1],
    ['CheckInterfaceSupport', 2],
]);

export const IDXGIADAPTER1_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIADAPTER_SLOTS,
    ['GetDesc1', 1],
]);

const IDXGIDEVICESUBOBJECT_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIOBJECT_SLOTS,
    ['GetDevice', 2],
]);

export const IDXGIRESOURCE_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIDEVICESUBOBJECT_SLOTS,
    ['GetSharedHandle', 1],
    ['GetUsage', 1],
    ['SetEvictionPriority', 1],
    ['GetEvictionPriority', 1],
]);

export const IDXGIRESOURCE1_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIRESOURCE_SLOTS,
    ['CreateSubresourceSurface', 2],
    ['CreateSharedHandle', 4],
]);

/** AcquireSync(UINT64 Key, DWORD ms) and ReleaseSync(UINT64 Key): a key is two words. */
export const IDXGIKEYEDMUTEX_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIDEVICESUBOBJECT_SLOTS,
    ['AcquireSync', 3],
    ['ReleaseSync', 2],
]);

export const IDXGISURFACE_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIDEVICESUBOBJECT_SLOTS,
    ['GetDesc', 1],
    ['Map', 2],
    ['Unmap', 0],
]);

export const IDXGISURFACE1_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGISURFACE_SLOTS,
    ['GetDC', 2],
    ['ReleaseDC', 1],
]);

export const IDXGIOUTPUT_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIOBJECT_SLOTS,
    ['GetDesc', 1],
    ['GetDisplayModeList', 4],
    ['FindClosestMatchingMode', 3],
    ['WaitForVBlank', 0],
    ['TakeOwnership', 2],
    ['ReleaseOwnership', 0],
    ['GetGammaControlCapabilities', 1],
    ['SetGammaControl', 1],
    ['GetGammaControl', 1],
    ['SetDisplaySurface', 1],
    ['GetDisplaySurfaceData', 1],
    ['GetFrameStatistics', 1],
]);

export const IDXGISWAPCHAIN_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIOBJECT_SLOTS,
    ['GetDevice', 2],
    ['Present', 2],
    ['GetBuffer', 3],
    ['SetFullscreenState', 2],
    ['GetFullscreenState', 2],
    ['GetDesc', 1],
    ['ResizeBuffers', 5],
    ['ResizeTarget', 1],
    ['GetContainingOutput', 1],
    ['GetFrameStatistics', 1],
    ['GetLastPresentCount', 1],
]);

export const IDXGIDEVICE_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIOBJECT_SLOTS,
    ['GetAdapter', 1],
    ['CreateSurface', 5],
    ['QueryResourceResidency', 3],
    ['SetGPUThreadPriority', 1],
    ['GetGPUThreadPriority', 1],
]);

export const IDXGIDEVICE1_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIDEVICE_SLOTS,
    ['SetMaximumFrameLatency', 1],
    ['GetMaximumFrameLatency', 1],
]);

// DXGI 1.2 to 1.6, each a prefix of the next (Wine's dxgi1_2.idl to dxgi1_6.idl).

export const IDXGIFACTORY2_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIFACTORY1_SLOTS,
    ['IsWindowedStereoEnabled', 0],
    ['CreateSwapChainForHwnd', 6],
    ['CreateSwapChainForCoreWindow', 5],
    ['GetSharedResourceAdapterLuid', 2],
    ['RegisterStereoStatusWindow', 3],
    ['RegisterStereoStatusEvent', 2],
    ['UnregisterStereoStatus', 1],
    ['RegisterOcclusionStatusWindow', 3],
    ['RegisterOcclusionStatusEvent', 2],
    ['UnregisterOcclusionStatus', 1],
    ['CreateSwapChainForComposition', 4],
]);
export const IDXGIFACTORY3_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIFACTORY2_SLOTS,
    ['GetCreationFlags', 0],
]);
export const IDXGIFACTORY4_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIFACTORY3_SLOTS,
    // A LUID by value: two dwords.
    ['EnumAdapterByLuid', 4],
    ['EnumWarpAdapter', 2],
]);
export const IDXGIFACTORY5_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIFACTORY4_SLOTS,
    ['CheckFeatureSupport', 3],
]);
export const IDXGIFACTORY6_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIFACTORY5_SLOTS,
    ['EnumAdapterByGpuPreference', 4],
]);
export const IDXGIFACTORY7_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIFACTORY6_SLOTS,
    ['RegisterAdaptersChangedEvent', 2],
    ['UnregisterAdaptersChangedEvent', 1],
]);

export const IDXGIADAPTER2_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIADAPTER1_SLOTS,
    ['GetDesc2', 1],
]);
export const IDXGIADAPTER3_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIADAPTER2_SLOTS,
    ['RegisterHardwareContentProtectionTeardownStatusEvent', 2],
    ['UnregisterHardwareContentProtectionTeardownStatus', 1],
    ['QueryVideoMemoryInfo', 3],
    // A UINT64 by value: two dwords.
    ['SetVideoMemoryReservation', 4],
    ['RegisterVideoMemoryBudgetChangeNotificationEvent', 2],
    ['UnregisterVideoMemoryBudgetChangeNotification', 1],
]);
export const IDXGIADAPTER4_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIADAPTER3_SLOTS,
    ['GetDesc3', 1],
]);

export const IDXGIOUTPUT1_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIOUTPUT_SLOTS,
    ['GetDisplayModeList1', 4],
    ['FindClosestMatchingMode1', 3],
    ['GetDisplaySurfaceData1', 1],
    ['DuplicateOutput', 2],
]);
export const IDXGIOUTPUT2_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIOUTPUT1_SLOTS,
    ['SupportsOverlays', 0],
]);
export const IDXGIOUTPUT3_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIOUTPUT2_SLOTS,
    ['CheckOverlaySupport', 3],
]);
export const IDXGIOUTPUT4_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIOUTPUT3_SLOTS,
    ['CheckOverlayColorSpaceSupport', 4],
]);
export const IDXGIOUTPUT5_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIOUTPUT4_SLOTS,
    ['DuplicateOutput1', 5],
]);
export const IDXGIOUTPUT6_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIOUTPUT5_SLOTS,
    ['GetDesc1', 1],
    ['CheckHardwareCompositionSupport', 1],
]);

export const IDXGISWAPCHAIN1_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGISWAPCHAIN_SLOTS,
    ['GetDesc1', 1],
    ['GetFullscreenDesc', 1],
    ['GetHwnd', 1],
    ['GetCoreWindow', 2],
    ['Present1', 3],
    ['IsTemporaryMonoSupported', 0],
    ['GetRestrictToOutput', 1],
    ['SetBackgroundColor', 1],
    ['GetBackgroundColor', 1],
    ['SetRotation', 1],
    ['GetRotation', 1],
]);
export const IDXGISWAPCHAIN2_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGISWAPCHAIN1_SLOTS,
    ['SetSourceSize', 2],
    ['GetSourceSize', 2],
    ['SetMaximumFrameLatency', 1],
    ['GetMaximumFrameLatency', 1],
    ['GetFrameLatencyWaitableObject', 0],
    ['SetMatrixTransform', 1],
    ['GetMatrixTransform', 1],
]);
export const IDXGISWAPCHAIN3_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGISWAPCHAIN2_SLOTS,
    ['GetCurrentBackBufferIndex', 0],
    ['CheckColorSpaceSupport', 2],
    ['SetColorSpace1', 1],
    ['ResizeBuffers1', 7],
]);
export const IDXGISWAPCHAIN4_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGISWAPCHAIN3_SLOTS,
    ['SetHDRMetaData', 3],
]);

export const IDXGIDEVICE2_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIDEVICE1_SLOTS,
    ['OfferResources', 3],
    ['ReclaimResources', 3],
    ['EnqueueSetEvent', 1],
]);
export const IDXGIDEVICE3_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIDEVICE2_SLOTS,
    ['Trim', 0],
]);
export const IDXGIDEVICE4_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIDEVICE3_SLOTS,
    ['OfferResources1', 4],
    ['ReclaimResources1', 3],
]);

export const ID3D10MULTITHREAD_SLOTS = /** @type {[string, number][]} */ ([
    ['Enter', 0],
    ['Leave', 0],
    ['SetMultithreadProtected', 1],
    ['GetMultithreadProtected', 0],
]);

export const ID3D10DEVICECHILD_SLOTS = /** @type {[string, number][]} */ ([
    ['GetDevice', 1],
    ['GetPrivateData', 3],
    ['SetPrivateData', 3],
    ['SetPrivateDataInterface', 2],
]);

export const ID3D10RESOURCE_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D10DEVICECHILD_SLOTS,
    ['GetType', 1],
    ['SetEvictionPriority', 1],
    ['GetEvictionPriority', 0],
]);

export const ID3D10BUFFER_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D10RESOURCE_SLOTS,
    ['Map', 3],
    ['Unmap', 0],
    ['GetDesc', 1],
]);

/** The three textures share a shape; only the map's out structure differs. */
export const ID3D10TEXTURE_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D10RESOURCE_SLOTS,
    ['Map', 4],
    ['Unmap', 1],
    ['GetDesc', 1],
]);

export const ID3D10VIEW_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D10DEVICECHILD_SLOTS,
    ['GetResource', 1],
    ['GetDesc', 1],
]);

/** The view every view derives from: the resource, and no description. */
const ID3D10BASEVIEW_SLOTS = /** @type {[string, number][]} */ (ID3D10VIEW_SLOTS.slice(0, -1));

export const ID3D10STATE_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D10DEVICECHILD_SLOTS,
    ['GetDesc', 1],
]);

export const ID3D10SHADERRESOURCEVIEW1_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D10VIEW_SLOTS,
    ['GetDesc1', 1],
]);

export const ID3D10BLENDSTATE1_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D10STATE_SLOTS,
    ['GetDesc1', 1],
]);

export const ID3D10SHADER_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D10DEVICECHILD_SLOTS,
]);

export const ID3D10QUERY_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D10DEVICECHILD_SLOTS,
    ['Begin', 0],
    ['End', 0],
    ['GetData', 3],
    ['GetDataSize', 0],
    ['GetDesc', 1],
]);

export const ID3D10BLOB_SLOTS = /** @type {[string, number][]} */ ([
    ['GetBufferPointer', 0],
    ['GetBufferSize', 0],
]);

export const ID3D10STATEBLOCK_SLOTS = /** @type {[string, number][]} */ ([
    ['Capture', 0],
    ['Apply', 0],
    ['ReleaseAllDeviceObjects', 0],
    ['GetDevice', 1],
]);

export const ID3D10SHADERREFLECTION_SLOTS = /** @type {[string, number][]} */ ([
    ['GetDesc', 1],
    ['GetConstantBufferByIndex', 1],
    ['GetConstantBufferByName', 1],
    ['GetResourceBindingDesc', 2],
    ['GetInputParameterDesc', 2],
    ['GetOutputParameterDesc', 2],
]);

/*
 * The reflection's constant buffers, variables and types derive from no
 * interface: their tables start with their own first method.
 */
export const ID3D10SHADERREFLECTIONCONSTANTBUFFER_SLOTS = /** @type {[string, number][]} */ ([
    ['GetDesc', 1],
    ['GetVariableByIndex', 1],
    ['GetVariableByName', 1],
]);

export const ID3D10SHADERREFLECTIONVARIABLE_SLOTS = /** @type {[string, number][]} */ ([
    ['GetDesc', 1],
    ['GetType', 0],
]);

export const ID3D10SHADERREFLECTIONTYPE_SLOTS = /** @type {[string, number][]} */ ([
    ['GetDesc', 1],
    ['GetMemberTypeByIndex', 1],
    ['GetMemberTypeByName', 1],
    ['GetMemberTypeName', 1],
]);

/** ID3D11ShaderReflection, D3DReflect's: Direct3D 10's methods, then its own. */
export const ID3D11SHADERREFLECTION_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D10SHADERREFLECTION_SLOTS,
    ['GetPatchConstantParameterDesc', 2],
    ['GetVariableByName', 1],
    ['GetResourceBindingDescByName', 2],
    ['GetMovInstructionCount', 0],
    ['GetMovcInstructionCount', 0],
    ['GetConversionInstructionCount', 0],
    ['GetBitwiseInstructionCount', 0],
    ['GetGSInputPrimitive', 0],
    ['IsSampleFrequencyShader', 0],
    ['GetNumInterfaceSlots', 0],
    ['GetMinFeatureLevel', 1],
    ['GetThreadGroupSize', 3],
    ['GetRequiresFlags', 0],
]);

export const ID3D11SHADERREFLECTIONCONSTANTBUFFER_SLOTS = /** @type {[string, number][]} */ ([
    ['GetDesc', 1],
    ['GetVariableByIndex', 1],
    ['GetVariableByName', 1],
]);

export const ID3D11SHADERREFLECTIONVARIABLE_SLOTS = /** @type {[string, number][]} */ ([
    ['GetDesc', 1],
    ['GetType', 0],
    ['GetBuffer', 0],
    ['GetInterfaceSlot', 1],
]);

export const ID3D11SHADERREFLECTIONTYPE_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D10SHADERREFLECTIONTYPE_SLOTS,
    ['IsEqual', 1],
    ['GetSubType', 0],
    ['GetBaseClass', 0],
    ['GetNumInterfaces', 0],
    ['GetInterfaceByIndex', 1],
    ['IsOfType', 1],
    ['ImplementsInterface', 1],
]);

/** D3D10_BLEND_DESC1: two words, then eight targets of thirty-two bytes. */
const D3D10_BLEND_DESC1 = Object.freeze({
    AlphaToCoverageEnable: 0x00, IndependentBlendEnable: 0x04, RenderTarget: 0x08,
    TARGET_SIZE: 0x20, SIZE: 0x108,
});

/** One target of D3D10_BLEND_DESC1; the write mask is a byte. */
const D3D10_RENDER_TARGET_BLEND_DESC1 = Object.freeze({
    BlendEnable: 0x00, SrcBlend: 0x04, DestBlend: 0x08, BlendOp: 0x0c, SrcBlendAlpha: 0x10,
    DestBlendAlpha: 0x14, BlendOpAlpha: 0x18,
});

/** Where the write mask byte of a D3D10_RENDER_TARGET_BLEND_DESC1 sits. */
const RENDER_TARGET_WRITE_MASK1 = 0x1c;

export { ID3D10DEVICE_SLOTS };

/** ID3D10Device1: the device, and three methods Direct3D 10.1 added after it. */
export const ID3D10DEVICE1_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D10DEVICE_SLOTS,
    ['CreateShaderResourceView1', 3],
    ['CreateBlendState1', 2],
    ['GetFeatureLevel', 0],
]);

/**
 * @typedef {Object} Deps
 * @property {any} publisher   From createPublisher.
 * @property {any} memory      readMemory/writeMemory.
 * @property {(bytes: number) => number} [allocate]  Guest memory a map hands out.
 * @property {(address: number) => void} [free]
 * @property {(bytes: number) => number} [ringAllocate]  Guest memory for a device's
 *     command ring (`d3d10-ring.js`); absent, every call of a device traps.
 * @property {(bytes: number, unbroken?: boolean) => number} [allocateCode]  Where the
 *     ring's routines are placed.
 * @property {Set<string>} [traps]  Methods kept as traps whatever runs in the guest.
 * @property {number} [ringBytes]
 * @property {4 | 8} [pointerSize]  8 for a 64-bit process, whose structures lay out a
 *     pointer, an HWND or a SIZE_T in eight bytes and whose pointer outs are written whole
 * @property {(factoryOptions: import('../d3d10/dxgi.js').FactoryOptions) => any} root
 *     The entry points every factory and device comes from (`d3d10/root.js`), made with
 *     what a device draws with -- here, or recorded for the graphics worker -- when a
 *     program first asks for one rather than before.
 * @property {(api: string, detail: string, severity?: 'loss') => void} [divergence]
 * @property {import('../d3d10/dxgi.js').FactoryOptions} [factoryOptions]
 * @property {() => { width: number, height: number, displayWidth?: number,
 *                     displayHeight?: number }} [screen]
 *     The desktop user32 reports, which DXGI's one output shows.
 * @property {() => import('./adapter.js').AdapterIdentity | null} [identity]
 * @property {() => number | null} [videoMemory]  The card's memory in bytes, as the
 *           graphics layer reports it to every API; null keeps this seam's own figure.
 *     The hardware behind the GPU, which DXGI's adapter reports as Direct3D 9's does.
 * @property {import('../d3d10/dxgi.js').FactoryOptions['resolution']} [resolution]
 *     Told the mode a fullscreen swap chain takes the screen at, as Direct3D 9 tells it.
 * @property {import('./ddraw.js').SurfaceDcServices} [gdi]
 *     Device contexts over guest memory, for IDXGISurface1::GetDC; absent, none is handed out.
 * @property {(value: number) => void} [floatResult]  Sets the float a method answers on
 *     the floating-point stack (GetResourceMinLOD).
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>}
 *     [callGuest]   Into the program, for the ID3DInclude a compile is given.
 * @property {() => any} [currentThread]  The thread a compile's include calls run on.
 * @property {{ create: (options: { manualReset: boolean, signalled: boolean }) => number,
 *     set: (handle: number) => void }} [events]  Kernel events by handle: a swap chain's
 *     frame latency object, and the event IDXGIDevice2::EnqueueSetEvent sets.
 * @property {{ open: (key: number) => number, resolve: (handle: number) => number | null }}
 *     [sharedHandles]  The NT handles of shared resources (`d3d10/sharing.js`): one opened
 *     over a share's key, and the key a handle names.
 */

/**
 * The bytes an update of `depth` slices of `packed.rows` rows reads, at the
 * pitches given, zero among them (every row from the same bytes): the last
 * row of the last slice ends a row's bytes past its start, so a pitch
 * shorter than a row (rows that overlap, as test_update_subresource gives
 * them) reads no less than a row.
 *
 * @param {{ rowPitch: number, rows: number }} packed @param {number} depth
 * @param {number} rowPitch @param {number} depthPitch
 * @returns {number}
 */
export function updateSpan(packed, depth, rowPitch, depthPitch){
    return depthPitch * (depth - 1) + rowPitch * (packed.rows - 1) + packed.rowPitch;
}

/**
 * @param {Deps} deps
 */
export function createDirect3D10Seam({ publisher, memory, allocate, free, root: makeRoot,
    divergence, factoryOptions: given, screen, identity, videoMemory, resolution, gdi,
    ringAllocate, allocateCode, traps = new Set(), ringBytes, floatResult, events,
    sharedHandles, callGuest, currentThread, pointerSize = 4 })
{
    const setEvent = events?.set;
    const fields = createFields(memory);
    const long = pointerSize === 8;
    /**
     * An interface, an address or a handle written to an out parameter: in a
     * 64-bit process the parameter is eight bytes and its high half is written
     * too, as zero -- whatever the program left there would otherwise make the
     * pointer it reads back another one.
     *
     * @param {number} address @param {number} value
     */
    const writePointer = (address, value)=>{
        fields.writeU32(address, value);
        if (long)
        {
            fields.writeU32((address >>> 0) + 4, 0);
        }
    };
    const SUBRESOURCE_DATA = long ? D3D10_SUBRESOURCE_DATA_64 : D3D10_SUBRESOURCE_DATA;
    const INPUT_ELEMENT_DESC = long ? D3D10_INPUT_ELEMENT_DESC_64 : D3D10_INPUT_ELEMENT_DESC;
    const ADAPTER_DESC = long ? DXGI_ADAPTER_DESC_64 : DXGI_ADAPTER_DESC;
    const OUTPUT_DESC = long ? DXGI_OUTPUT_DESC_64 : DXGI_OUTPUT_DESC;

    /**
     * Each device's command ring (`d3d10-ring.js`), where its calls in the
     * guest wait for the host.
     *
     * @type {Set<NonNullable<ReturnType<typeof createDeviceRing>>>}
     */
    const rings = new Set();
    /**
     * What the guest's routines wrote, made on the devices: before any call
     * the host makes, so that a call the program made after them meets them
     * made, and before a count is read or lowered on the host, since a record
     * may name the object.
     */
    const syncRings = ()=>{
        for (const ring of rings)
        {
            ring.sync();
        }
    };
    /**
     * Each method of a map, after the rings are played.
     *
     * @template {Record<string, any>} T @param {T} implemented @returns {T}
     */
    const synced = implemented=>/** @type {T} */ (Object.fromEntries(Object.entries(implemented)
        .map(([name, method])=>[name, typeof method !== 'function' ? method
            : (/** @type {any} */ target, /** @type {number[]} */ args)=>{
                syncRings();
                return method(target, args);
            }])));
    /**
     * An interface whose methods the host makes after the rings are played.
     *
     * @param {string} id @param {[string, number][]} slots
     * @param {Record<string, (target: any, args: number[]) => number | void | Promise<number>>}
     *     implemented
     * @param {Record<string, (options: { trap: number }) => number>} [guests]
     * @param {(target: any, pointers: Iterable<number>) => void} [released]
     */
    const describe = (id, slots, implemented, guests, released)=>describeAt(id, slots,
        synced(implemented), guests, released);
    /** @param {(at: number) => Uint8Array} code */
    const placeCode = code=>{
        // Sized by a throwaway rendering: the bytes depend on where they land
        // only through relative jumps, never in length.
        const length = code(0).length;
        const at = allocateCode ? allocateCode(length, true)
            : /** @type {(bytes: number) => number} */ (ringAllocate)(length);
        if (at !== 0)
        {
            memory.writeMemory(at, code(at));
        }
        return at;
    };
    /**
     * The ring each device has, and each buffer whose map and unmap run in
     * the guest the ring of its device.
     *
     * @type {WeakMap<object, NonNullable<ReturnType<typeof createDeviceRing>>>}
     */
    const ringsOf = new WeakMap();
    /** @param {any} object */
    const ringOf = object=>ringsOf.get(object) ?? null;
    /**
     * A dynamic buffer the program writes, whose bytes live in guest memory,
     * gets a block its map and unmap in the guest read and write
     * (`BufferMap`): made before it is published, since publishing writes
     * the block's address beside each of its interface pointers.
     *
     * @param {any} device @param {any} buffer
     */
    const attachBuffer = (device, buffer)=>{
        const ring = ringOf(device);
        if (!ring || buffer.desc?.Usage !== D3D10_USAGE.DYNAMIC
            || ((buffer.desc?.CPUAccessFlags ?? 0) & D3D10_CPU_ACCESS.WRITE) === 0)
        {
            return;
        }
        const block = ring.attachBuffer(buffer);
        if (block !== 0)
        {
            ringsOf.set(buffer, ring);
            buffer.guestState = ()=>block;
        }
    };
    /** @type {Record<string, number>} usage -> maps of buffers with no block of their own */
    const unattachedMaps = {};
    /** @param {any} buffer */
    const countUnattached = buffer=>{
        if (!ringOf(buffer))
        {
            const usage = String(buffer.desc?.Usage ?? '?');
            unattachedMaps[usage] = (unattachedMaps[usage] ?? 0) + 1;
        }
    };
    /** A dynamic buffer's map and unmap, in the guest, where devices have rings. */
    const bufferGuests = ringAllocate
        ? Object.fromEntries([['Map', 'BufferMap'], ['Unmap', 'BufferUnmap']]
            .filter(([name])=>!traps.has(`Buffer.${name}`)).map(([name, routine])=>[name,
                (/** @type {{ trap: number }} */ { trap })=>placeCode(at=>compiledAt(
                    IN_GUEST[routine], at, trap)) || trap]))
        : {};
    /** The device's methods that run in the guest, where a device has a ring. */
    const ringGuests = ringAllocate
        ? Object.fromEntries(RING_METHODS.filter(name=>!traps.has(name)).map(name=>[name,
            (/** @type {{ trap: number }} */ { trap })=>placeCode(at=>compiledAt(IN_GUEST[name], at,
                trap)) || trap]))
        : {};
    /** Direct3D 11's immediate context's, into its device's ring. */
    const contextGuests = ringAllocate
        ? Object.fromEntries(Object.entries(CONTEXT_RING)
            .filter(([name])=>!traps.has(`Context.${name}`)).map(([name, routine])=>[name,
                (/** @type {{ trap: number }} */ { trap })=>placeCode(at=>compiledAt(
                    IN_GUEST[routine], at, trap)) || trap]))
        : {};
    /**
     * A device's command ring, made before the device is published: publishing
     * is when the block's address is written one word past each of its
     * interface pointers, where the routines look for it.
     *
     * @param {any} device
     */
    const attachRing = device=>{
        if (!ringAllocate)
        {
            return;
        }
        const ring = createDeviceRing({
            allocate: ringAllocate,
            // A word in place where the memory reads one; through the bytes otherwise.
            memory: { ...memory, readU32: memory.readU32 ?? (address=>fields.readU32(address)) },
            device,
            objectAt: pointer=>publisher.objectAt(pointer),
            refuse: detail=>divergence?.('Direct3D 10', `the command ring: ${detail}`),
            ringBytes,
        });
        if (ring)
        {
            rings.add(ring);
            ringsOf.set(device, ring);
            device.guestState = ()=>ring.address();
        }
    };
    /** @type {import('../d3d10/dxgi.js').FactoryOptions} */
    const factoryOptions = {
        ...(screen ? { display: ()=>screen() } : {}),
        ...(resolution ? { resolution } : {}),
        ...(identity ? { vendorId: ()=>describeAdapter(identity()).vendorId } : {}),
        ...(events ? { createEvent: events.create } : {}),
        ...given,
    };
    /** @type {any} */
    let rootMade = null;
    /** The entry points, made once: every factory and device of the process comes from them. */
    const root = ()=>(rootMade ??= makeRoot(factoryOptions));

    /**
     * A swap chain's description with its extent the window's where it asks
     * for zero, measured here, where the window is: a device drawn elsewhere
     * makes its buffers from what it is told.
     *
     * @param {import('../d3d10/structs.js').SwapChainFields | null} desc
     */
    const sized = desc=>{
        if (!desc || (desc.bufferDesc.width !== 0 && desc.bufferDesc.height !== 0))
        {
            return desc;
        }
        const client = factoryOptions.windowClientSize?.(desc.outputWindow)
            ?? { width: 0, height: 0 };
        return { ...desc, bufferDesc: { ...desc.bufferDesc,
            width: desc.bufferDesc.width || client.width || 8,
            height: desc.bufferDesc.height || client.height || 8 } };
    };

    /** @param {number} address @param {number} count @returns {number[]} */
    const readPointers = (address, count)=>{
        /** @type {number[]} */
        const pointers = [];
        for (let index = 0; index < count; index++)
        {
            // A pointer's low half: every object the seam publishes lies below 4 GiB.
            pointers.push((address >>> 0) === 0 ? 0
                : fields.readU32(address + index * pointerSize));
        }
        return pointers;
    };

    /** @param {number} address @param {number} count @returns {any[]} */
    const readObjects = (address, count)=>readPointers(address, count)
        .map(pointer=>publisher.objectAt(pointer));

    /** @param {number} address @param {number} count @returns {number[]} */
    const readDwords = (address, count)=>{
        /** @type {number[]} */
        const values = [];
        for (let index = 0; index < count; index++)
        {
            values.push(fields.readU32(address + index * 4));
        }
        return values;
    };

    /** @param {number} address @param {number} count */
    const readFloats = (address, count)=>readDwords(address, count).map(fields.asFloat);


    /**
     * Objects an API `Get` handed back, written as published pointers. Each
     * already carries the caller's reference; a null slot is a null pointer.
     *
     * @param {number} address
     * @param {any[]} objects
     * @param {import('./com.js').InterfaceDescriptor[]} interfaces
     * @param {string} id
     */
    const writeObjects = (address, objects, interfaces, id)=>{
        if ((address >>> 0) === 0)
        {
            for (const object of objects)
            {
                object?.release();
            }
            return;
        }
        objects.forEach((object, index)=>{
            writePointer(address + index * pointerSize,
                object ? publisher.publish(object, interfaces, id) : 0);
        });
    };

    /**
     * @param {any} object
     * @param {import('./com.js').InterfaceDescriptor[]} interfaces
     * @param {string} id
     * @param {number} out
     */
    const handBack = (object, interfaces, id, out)=>{
        if ((out >>> 0) === 0)
        {
            object.release();
            return S_OK;
        }
        // A record in a ring may name it: the rings are played before its
        // count is touched on the host.
        object.settleGuestRefs ??= syncRings;
        const pointer = publisher.publish(object, interfaces, id);
        writePointer(out, pointer);
        return pointer === 0 ? E_INVALIDARG : S_OK;
    };

    // --- private data, in both orders ---

    /** @param {any} object @param {number[]} args */
    const setPrivateData = (object, [guid, size, data])=>object.SetPrivateData(
        readGuid(memory, guid), size >>> 0,
        (data >>> 0) === 0 ? null : memory.readMemory(data >>> 0, size >>> 0));

    /** @param {any} object @param {number[]} args */
    const setPrivateDataInterface = (object, [guid, pointer])=>object.SetPrivateDataInterface(
        readGuid(memory, guid), publisher.objectAt(pointer), pointer >>> 0);

    /**
     * An interface entry is answered as the pointer of a published IUnknown;
     * bytes are copied out as they are.
     *
     * @param {any} object @param {number[]} args
     */
    const getPrivateData = (object, [guid, sizeAt, data])=>{
        const answer = object.GetPrivateData(readGuid(memory, guid), {
            size: (sizeAt >>> 0) === 0 ? null : fields.readU32(sizeAt),
            wantsData: (data >>> 0) !== 0,
        });
        if ((sizeAt >>> 0) !== 0)
        {
            fields.writeU32(sizeAt, answer.size);
        }
        if (answer.hr !== S_OK || (data >>> 0) === 0)
        {
            return answer.hr;
        }
        if (answer.data)
        {
            memory.writeMemory(data >>> 0, answer.data);
        }
        else
        {
            // The pointer the program stored, through whichever interface it
            // was; one stored before the pointer was kept, as IUnknown.
            fields.writeU32(data, answer.object
                ? answer.pointer || publisher.publish(answer.object, [], IID.IUnknown)
                : 0);
        }
        return answer.hr;
    };

    const privateDataMethods = {
        SetPrivateData: setPrivateData,
        SetPrivateDataInterface: setPrivateDataInterface,
        GetPrivateData: getPrivateData,
    };

    /**
     * A child's device, as Direct3D 10's. An object Direct3D 11 made answers
     * Direct3D 10's interfaces too, but its device does not: it hands back
     * none (test_buffer_interfaces).
     *
     * @param {any} child @param {number[]} args
     */
    const getDevice = (child, [out])=>{
        /** @type {{ device?: any }} */
        const held = {};
        child.GetDevice(held);
        if (!held.device?.supports(IID.ID3D10Device))
        {
            held.device?.release();
            fields.writeU32(out, 0);
            return;
        }
        handBack(held.device, deviceInterfaces, IID.ID3D10Device, out);
    };

    // --- DXGI ---

    /** @param {any} object @param {number[]} args */
    const getParent = (object, [guid, out])=>{
        const id = readGuid(memory, guid);
        /** @type {{ parent?: any }} */
        const held = {};
        const hr = object.GetParent(id, held);
        if (hr !== S_OK)
        {
            fields.writeU32(out, 0);
            return hr;
        }
        const interfaces = held.parent.supports(IID.IDXGIFactory)
            ? factoryInterfaces
            : held.parent.supports(IID.IDXGIAdapter) ? adapterInterfaces : deviceInterfaces;
        return handBack(held.parent, interfaces, id, out);
    };

    /** @param {number} address @param {string} text @param {number} capacity in wide characters */
    const writeWide = (address, text, capacity)=>{
        const bytes = new Uint8Array(capacity * 2);
        for (let index = 0; index < Math.min(text.length, capacity - 1); index++)
        {
            const code = text.charCodeAt(index);
            bytes[index * 2] = code & 0xff;
            bytes[index * 2 + 1] = code >>> 8;
        }
        memory.writeMemory(address, bytes);
    };

    /**
     * The same method map under an interface and the bases it extends: a base
     * is a prefix of the derived vtable, so the map serves both.
     *
     * @param {[string, [string, number][]][]} faces  Interface id and its slots.
     * @param {Record<string, (target: any, args: number[]) => number | void | Promise<number>>}
     *     methods
     */
    /**
     * The longest of the faces' slot lists this one is a prefix of: every version of an
     * interface the object has, its vtable whole. Windows hands one object out under
     * IDXGIFactory1 to 7 with one vtable, and a program calls IDXGIFactory2's methods
     * through the pointer CreateDXGIFactory1 gave it; a vtable cut at the asked
     * version's end sent such a call to whatever lay past it.
     *
     * @param {[string, number][]} slots @param {[string, [string, number][]][]} faces
     * @returns {[string, number][]}
     */
    const widest = (slots, faces)=>faces.reduce((best, [, other])=>(other.length > best.length
        && slots.every(([name], index)=>other[index]?.[0] === name) ? other : best), slots);

    /**
     * @param {[string, [string, number][]][]} faces @param {any} methods
     * @param {Record<string, (builder: { trap: number }) => number>} [guests]
     */
    const describeAll =(faces, methods, guests)=>faces.map(([id, slots])=>describe(id,
        widest(slots, faces), methods, guests));

    /**
     * A notice registered by cookie, which is never sent here (nothing is
     * occluded, turned stereo or taken away).
     *
     * @param {any} object  what keeps the cookies @param {number} cookieAt
     */
    const registered = (object, cookieAt)=>{
        if ((cookieAt >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        fields.writeU32(cookieAt, object.register());
        return S_OK;
    };

    /**
     * A mode list of DXGI_MODE_DESC1 (DXGI_MODE_DESC and its Stereo after),
     * with the count, as GetDisplayModeList answers it.
     *
     * @param {any[]} modes @param {number} countAt @param {number} listAt
     */
    const writeModeList1 = (modes, countAt, listAt)=>{
        if ((countAt >>> 0) === 0)
        {
            return DXGI_ERROR_INVALID_CALL;
        }
        if ((listAt >>> 0) === 0)
        {
            fields.writeU32(countAt, modes.length);
            return S_OK;
        }
        const room = fields.readU32(countAt);
        modes.slice(0, room).forEach((mode, index)=>{
            const at = listAt + index * (DXGI_MODE_DESC.SIZE + 4);
            writeModeDesc(memory, at, mode);
            fields.writeU32(at + DXGI_MODE_DESC.SIZE, 0);
        });
        if (room < modes.length)
        {
            return DXGI_ERROR_MORE_DATA;
        }
        fields.writeU32(countAt, modes.length);
        return S_OK;
    };

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const outputInterfaces = describeAll([
        [IID.IDXGIOutput, IDXGIOUTPUT_SLOTS], [IID.IDXGIOutput1, IDXGIOUTPUT1_SLOTS],
        [IID.IDXGIOutput2, IDXGIOUTPUT2_SLOTS], [IID.IDXGIOutput3, IDXGIOUTPUT3_SLOTS],
        [IID.IDXGIOutput4, IDXGIOUTPUT4_SLOTS], [IID.IDXGIOutput5, IDXGIOUTPUT5_SLOTS],
        [IID.IDXGIOutput6, IDXGIOUTPUT6_SLOTS], [IID.IDXGIObject, IDXGIOBJECT_SLOTS],
    ], {
        ...privateDataMethods,
        GetParent: getParent,
        /** @param {any} output @param {number[]} args */
        GetDesc: (output, [out])=>{
            /** @type {{ desc?: any }} */
            const held = {};
            const hr = output.GetDesc(held);
            if (hr !== S_OK || (out >>> 0) === 0)
            {
                return hr;
            }
            writeWide(out + OUTPUT_DESC.DeviceName, held.desc.DeviceName, 32);
            fields.writeStruct(out + OUTPUT_DESC.DesktopCoordinates, RECT,
                held.desc.DesktopCoordinates);
            fields.writeU32(out + OUTPUT_DESC.AttachedToDesktop,
                held.desc.AttachedToDesktop ? 1 : 0);
            fields.writeU32(out + OUTPUT_DESC.Rotation, held.desc.Rotation);
            writePointer(out + OUTPUT_DESC.Monitor, held.desc.Monitor);
            return S_OK;
        },
        /**
         * With no list, how many modes there are; with one, as many as it has
         * room for -- DXGI_ERROR_MORE_DATA when that is not all of them, the
         * count then left as the program gave it.
         *
         * @param {any} output @param {number[]} args
         */
        GetDisplayModeList: (output, [format, , countAt, listAt])=>{
            if ((countAt >>> 0) === 0)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            const modes = output.GetDisplayModeList(format >>> 0);
            if ((listAt >>> 0) === 0)
            {
                fields.writeU32(countAt, modes.length);
                return S_OK;
            }
            const room = fields.readU32(countAt);
            modes.slice(0, room).forEach((/** @type {any} */ mode, /** @type {number} */ index)=>{
                writeModeDesc(memory, listAt + index * DXGI_MODE_DESC.SIZE, mode);
            });
            if (room < modes.length)
            {
                return DXGI_ERROR_MORE_DATA;
            }
            fields.writeU32(countAt, modes.length);
            return S_OK;
        },
        /** @param {any} output @param {number[]} args */
        FindClosestMatchingMode: (output, [wantedAt, closestAt, device])=>{
            if ((wantedAt >>> 0) === 0 || (closestAt >>> 0) === 0)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            /** @type {{ mode?: any }} */
            const held = {};
            const hr = output.FindClosestMatchingMode(readModeDesc(memory, wantedAt),
                (device >>> 0) !== 0, held);
            if (hr === S_OK)
            {
                writeModeDesc(memory, closestAt, held.mode);
            }
            return hr;
        },
        WaitForVBlank: ()=>S_OK,
        TakeOwnership: ()=>DXGI_ERROR_NOT_CURRENTLY_AVAILABLE,
        ReleaseOwnership: ()=>S_OK,
        // The gamma ramp and the scanned-out surface belong to a swap chain
        // that has the output fullscreen, and none here ever does.
        GetGammaControlCapabilities: ()=>DXGI_ERROR_INVALID_CALL,
        SetGammaControl: ()=>DXGI_ERROR_INVALID_CALL,
        GetGammaControl: ()=>DXGI_ERROR_INVALID_CALL,
        SetDisplaySurface: ()=>DXGI_ERROR_INVALID_CALL,
        GetDisplaySurfaceData: ()=>DXGI_ERROR_NOT_CURRENTLY_AVAILABLE,
        GetFrameStatistics: ()=>DXGI_ERROR_INVALID_CALL,
        /** @param {any} output @param {number[]} args */
        GetDisplayModeList1: (output, [format, , countAt, listAt])=>
            writeModeList1(output.GetDisplayModeList(format >>> 0), countAt, listAt),
        /** @param {any} output @param {number[]} args */
        FindClosestMatchingMode1: (output, [wantedAt, closestAt, device])=>{
            if ((wantedAt >>> 0) === 0 || (closestAt >>> 0) === 0)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            /** @type {{ mode?: any }} */
            const held = {};
            const hr = output.FindClosestMatchingMode(readModeDesc(memory, wantedAt),
                (device >>> 0) !== 0, held);
            if (hr === S_OK)
            {
                writeModeDesc(memory, closestAt, held.mode);
                fields.writeU32(closestAt + DXGI_MODE_DESC.SIZE, 0);
            }
            return hr;
        },
        GetDisplaySurfaceData1: ()=>DXGI_ERROR_NOT_CURRENTLY_AVAILABLE,
        // Desktop duplication reads what other programs show, which a page
        // cannot: the call's own answer for a desktop it may not read.
        /** @param {any} output @param {number[]} args */
        DuplicateOutput: (output, [, out])=>{
            if ((out >>> 0) !== 0)
            {
                fields.writeU32(out, 0);
            }
            return DXGI_ERROR_UNSUPPORTED;
        },
        /** @param {any} output @param {number[]} args */
        DuplicateOutput1: (output, [, , , , out])=>{
            if ((out >>> 0) !== 0)
            {
                fields.writeU32(out, 0);
            }
            return DXGI_ERROR_UNSUPPORTED;
        },
        // No overlay plane, no hardware composition: the page composes.
        SupportsOverlays: ()=>0,
        /** @param {any} output @param {number[]} args */
        CheckOverlaySupport: (output, [, , flagsAt])=>{
            if ((flagsAt >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            fields.writeU32(flagsAt, 0);
            return S_OK;
        },
        /** @param {any} output @param {number[]} args */
        CheckOverlayColorSpaceSupport: (output, [, , , flagsAt])=>{
            if ((flagsAt >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            fields.writeU32(flagsAt, 0);
            return S_OK;
        },
        /** @param {any} output @param {number[]} args */
        CheckHardwareCompositionSupport: (output, [flagsAt])=>{
            if ((flagsAt >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            fields.writeU32(flagsAt, 0);
            return S_OK;
        },
        /**
         * DXGI_OUTPUT_DESC1: the first description, then what a display of
         * eight bits a channel in sRGB has -- its primaries, white point and
         * an SDR panel's luminance.
         *
         * @param {any} output @param {number[]} args
         */
        GetDesc1: (output, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            /** @type {{ desc?: any }} */
            const held = {};
            const hr = output.GetDesc(held);
            if (hr !== S_OK)
            {
                return hr;
            }
            writeWide(out + OUTPUT_DESC.DeviceName, held.desc.DeviceName, 32);
            fields.writeStruct(out + OUTPUT_DESC.DesktopCoordinates, RECT,
                held.desc.DesktopCoordinates);
            fields.writeU32(out + OUTPUT_DESC.AttachedToDesktop,
                held.desc.AttachedToDesktop ? 1 : 0);
            fields.writeU32(out + OUTPUT_DESC.Rotation, held.desc.Rotation);
            writePointer(out + OUTPUT_DESC.Monitor, held.desc.Monitor);
            const after = out + DXGI_OUTPUT_DESC.SIZE;
            fields.writeU32(after, 8);
            fields.writeU32(after + 4, 0);
            [0.64, 0.33, 0.30, 0.60, 0.15, 0.06, 0.3127, 0.3290, 0.5, 270, 270]
                .forEach((value, index)=>fields.writeF32(after + 8 + index * 4, value));
            return S_OK;
        },
    });

    /**
     * DXGI_ADAPTER_DESC, the first part of DXGI_ADAPTER_DESC1 too.
     *
     * @param {any} adapter
     * @param {number} out
     */
    const writeAdapterDesc = (adapter, out)=>{
        /** @type {{ desc?: any }} */
        const held = {};
        const hr = adapter.GetDesc(held);
        if (hr !== S_OK || (out >>> 0) === 0)
        {
            return hr === S_OK ? E_INVALIDARG : hr;
        }
        writeWide(out + ADAPTER_DESC.Description, held.desc.Description, 128);
        if (long)
        {
            // The memories' high halves: a gigabyte is a low half alone.
            for (const field of /** @type {const} */ (['DedicatedVideoMemory',
                'DedicatedSystemMemory', 'SharedSystemMemory']))
            {
                fields.writeU32(out + ADAPTER_DESC[field] + 4, 0);
            }
        }
        fields.writeStruct(out, ADAPTER_DESC, {
            VendorId: held.desc.VendorId,
            DeviceId: held.desc.DeviceId,
            SubSysId: held.desc.SubSysId,
            Revision: held.desc.Revision,
            DedicatedVideoMemory: videoMemory?.() ?? REPORTED_VIDEO_MEMORY,
            DedicatedSystemMemory: 0,
            SharedSystemMemory: videoMemory?.() ?? REPORTED_VIDEO_MEMORY,
            AdapterLuidLow: held.desc.AdapterLuid?.low ?? 1,
            AdapterLuidHigh: held.desc.AdapterLuid?.high ?? 0,
        });
        return S_OK;
    };

    /**
     * An adapter's description of DXGI 1.1 and later: the first one, then
     * its flags, and (DXGI_ADAPTER_DESC2 and DESC3) the preemption
     * granularities, a DMA buffer's and a dispatch's, as a GPU of today's
     * driver model has them.
     *
     * @param {any} adapter @param {number} out @param {boolean} granularities
     */
    const writeAdapterDescAs = (adapter, out, granularities)=>{
        const hr = writeAdapterDesc(adapter, out);
        if (hr !== S_OK)
        {
            return hr;
        }
        /** @type {{ desc?: any }} */
        const held = {};
        adapter.GetDesc(held);
        fields.writeU32(out + ADAPTER_DESC.SIZE, held.desc?.Flags ?? 0);
        if (granularities)
        {
            fields.writeU32(out + ADAPTER_DESC.SIZE + 4, PREEMPTION_DMA_BUFFER);
            fields.writeU32(out + ADAPTER_DESC.SIZE + 8, PREEMPTION_DISPATCH);
        }
        return S_OK;
    };

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const adapterInterfaces = describeAll([
        [IID.IDXGIAdapter, IDXGIADAPTER_SLOTS], [IID.IDXGIAdapter1, IDXGIADAPTER1_SLOTS],
        [IID.IDXGIAdapter2, IDXGIADAPTER2_SLOTS], [IID.IDXGIAdapter3, IDXGIADAPTER3_SLOTS],
        [IID.IDXGIAdapter4, IDXGIADAPTER4_SLOTS], [IID.IDXGIObject, IDXGIOBJECT_SLOTS],
    ], {
        ...privateDataMethods,
        GetParent: getParent,
        /** @param {any} adapter @param {number[]} args */
        EnumOutputs: (adapter, [index, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            /** @type {{ output?: any }} */
            const held = {};
            const hr = adapter.EnumOutputs(index >>> 0, held);
            if (hr !== S_OK)
            {
                fields.writeU32(out, 0);
                return hr;
            }
            return handBack(held.output, outputInterfaces, IID.IDXGIOutput, out);
        },
        /** @param {any} adapter @param {number[]} args */
        GetDesc: (adapter, [out])=>writeAdapterDesc(adapter, out),
        /**
         * The same description and a word of flags after it: none, for an
         * adapter that is neither remote nor software.
         *
         * @param {any} adapter @param {number[]} args
         */
        GetDesc1: (adapter, [out])=>writeAdapterDescAs(adapter, out, false),
        /** @param {any} adapter @param {number[]} args */
        GetDesc2: (adapter, [out])=>writeAdapterDescAs(adapter, out, true),
        /** @param {any} adapter @param {number[]} args */
        GetDesc3: (adapter, [out])=>writeAdapterDescAs(adapter, out, true),
        /** @param {any} adapter @param {number[]} args */
        QueryVideoMemoryInfo: (adapter, [node, group, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const answer = adapter.QueryVideoMemoryInfo(node >>> 0, group >>> 0,
                videoMemory?.() ?? REPORTED_VIDEO_MEMORY);
            if (answer.hr === S_OK && answer.info)
            {
                const { budget, usage, reservable, reserved } = answer.info;
                [budget, usage, reservable, reserved].forEach((value, index)=>{
                    fields.writeU32(out + index * 8, value % 0x100000000);
                    fields.writeU32(out + index * 8 + 4, Math.floor(value / 0x100000000));
                });
            }
            return answer.hr;
        },
        /** @param {any} adapter @param {number[]} args */
        SetVideoMemoryReservation: (adapter, [node, group, low, high])=>
            adapter.SetVideoMemoryReservation(node >>> 0, group >>> 0,
                (high >>> 0) * 0x100000000 + (low >>> 0)),
        /** @param {any} adapter @param {number[]} args */
        RegisterHardwareContentProtectionTeardownStatusEvent: (adapter, [, cookie])=>
            registered(adapter, cookie),
        UnregisterHardwareContentProtectionTeardownStatus: ()=>{},
        /**
         * The budget is told at once, as Windows does on registering: the
         * event is set, and never again, as the budget never moves here.
         *
         * @param {any} adapter @param {number[]} args
         */
        RegisterVideoMemoryBudgetChangeNotificationEvent: (adapter, [event, cookie])=>{
            if ((event >>> 0) === 0 || (cookie >>> 0) === 0)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            setEvent?.(event >>> 0);
            return registered(adapter, cookie);
        },
        UnregisterVideoMemoryBudgetChangeNotification: ()=>{},
        /** @param {any} adapter @param {number[]} args */
        CheckInterfaceSupport: (adapter, [guid, version])=>{
            /** @type {{ version?: { low: number, high: number } }} */
            const held = {};
            const hr = adapter.CheckInterfaceSupport(readGuid(memory, guid), held);
            if (hr === S_OK && held.version && (version >>> 0) !== 0)
            {
                fields.writeU32(version, held.version.low);
                fields.writeU32(version + 4, held.version.high);
            }
            return hr;
        },
    });

    /** @param {string} id @returns {string} the factory face a pointer for `id` is */
    const factoryFace = id=>(factoryInterfaces.some(face=>face.id === id)
        && id !== IID.IDXGIObject ? id : IID.IDXGIFactory);

    /**
     * An adapter a factory found, handed back as the interface asked for.
     *
     * @param {number} hr @param {any} adapter @param {number} guid @param {number} out
     */
    const adapterAs = (hr, adapter, guid, out)=>{
        if ((out >>> 0) === 0)
        {
            adapter?.release();
            return DXGI_ERROR_INVALID_CALL;
        }
        if (hr !== S_OK)
        {
            fields.writeU32(out, 0);
            return hr;
        }
        const id = readGuid(memory, guid);
        if (!adapter.supports(id))
        {
            adapter.release();
            fields.writeU32(out, 0);
            return E_NOINTERFACE;
        }
        return handBack(adapter, adapterInterfaces, id, out);
    };

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const factoryInterfaces = describeAll([
        [IID.IDXGIFactory, IDXGIFACTORY_SLOTS], [IID.IDXGIObject, IDXGIOBJECT_SLOTS],
        [IID.IDXGIFactory1, IDXGIFACTORY1_SLOTS], [IID.IDXGIFactory2, IDXGIFACTORY2_SLOTS],
        [IID.IDXGIFactory3, IDXGIFACTORY3_SLOTS], [IID.IDXGIFactory4, IDXGIFACTORY4_SLOTS],
        [IID.IDXGIFactory5, IDXGIFACTORY5_SLOTS], [IID.IDXGIFactory6, IDXGIFACTORY6_SLOTS],
        [IID.IDXGIFactory7, IDXGIFACTORY7_SLOTS],
    ], {
        ...privateDataMethods,
        GetParent: getParent,
        /** @param {any} factory @param {number[]} args */
        EnumAdapters: (factory, [index, out])=>{
            if ((out >>> 0) === 0)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            /** @type {{ adapter?: any }} */
            const held = {};
            const hr = factory.EnumAdapters(index >>> 0, held);
            if (hr !== S_OK)
            {
                fields.writeU32(out, 0);
                return hr;
            }
            return handBack(held.adapter, adapterInterfaces, IID.IDXGIAdapter, out);
        },
        /** @param {any} factory @param {number[]} args */
        EnumAdapters1: (factory, [index, out])=>{
            if ((out >>> 0) === 0)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            /** @type {{ adapter?: any }} */
            const held = {};
            const hr = factory.EnumAdapters1(index >>> 0, held);
            if (hr !== S_OK)
            {
                fields.writeU32(out, 0);
                return hr;
            }
            return handBack(held.adapter, adapterInterfaces, IID.IDXGIAdapter1, out);
        },
        /** @param {any} factory */
        IsCurrent: factory=>(factory.IsCurrent() ? 1 : 0),
        // Alt-Enter and the window's association are the host's business; the
        // program is told what it asked for was noted.
        MakeWindowAssociation: ()=>S_OK,
        /** @param {any} factory @param {number[]} args */
        GetWindowAssociation: (factory, [out])=>{
            fields.writeU32(out, 0);
            return S_OK;
        },
        /** @param {any} factory @param {number[]} args */
        CreateSwapChain: (factory, [devicePointer, descAt, out])=>{
            const device = publisher.objectAt(devicePointer);
            if (!device || (descAt >>> 0) === 0 || (out >>> 0) === 0)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            /** @type {{ swapChain?: any }} */
            const held = {};
            const hr = factory.CreateSwapChain(device,
                sized(readSwapChainDesc(memory, descAt, pointerSize)),
                held);
            if (hr !== S_OK)
            {
                fields.writeU32(out, 0);
                return hr;
            }
            swapChainDevices.set(held.swapChain, device);
            return handBack(held.swapChain, swapChainInterfaces, IID.IDXGISwapChain, out);
        },
        /** @param {any} factory */
        IsWindowedStereoEnabled: factory=>(factory.IsWindowedStereoEnabled() ? 1 : 0),
        /** @param {any} factory @param {number[]} args */
        CreateSwapChainForHwnd: (factory, args)=>{
            const [devicePointer, window, descAt, fullscreenAt, restrictAt, out] = args;
            const device = publisher.objectAt(devicePointer);
            if (!device || (descAt >>> 0) === 0 || (out >>> 0) === 0)
            {
                if ((out >>> 0) !== 0)
                {
                    fields.writeU32(out, 0);
                }
                return DXGI_ERROR_INVALID_CALL;
            }
            /** @type {{ swapChain?: any }} */
            const held = {};
            const hr = factory.CreateSwapChainForHwnd(device, window >>> 0,
                readSwapChainDesc1(memory, descAt >>> 0, fullscreenAt >>> 0),
                (restrictAt >>> 0) === 0 ? null : publisher.objectAt(restrictAt), held);
            if (hr !== S_OK)
            {
                fields.writeU32(out, 0);
                return hr;
            }
            swapChainDevices.set(held.swapChain, device);
            return handBack(held.swapChain, swapChainInterfaces, IID.IDXGISwapChain1, out);
        },
        // A program of the desktop has no core window, and nothing here
        // composes a swap chain into a visual tree (decision A82, temporary).
        /** @param {any} factory @param {number[]} args */
        CreateSwapChainForCoreWindow: (factory, [, , , , out])=>{
            if ((out >>> 0) !== 0)
            {
                fields.writeU32(out, 0);
            }
            return DXGI_ERROR_INVALID_CALL;
        },
        /** @param {any} factory @param {number[]} args */
        CreateSwapChainForComposition: (factory, [, , , out])=>{
            if ((out >>> 0) !== 0)
            {
                fields.writeU32(out, 0);
            }
            divergence?.('dxgi', 'a swap chain for composition is refused: nothing here'
                + ' composes one into a visual tree (decision A82, temporary)');
            return DXGI_ERROR_UNSUPPORTED;
        },
        // No resource is shared by handle across adapters yet.
        GetSharedResourceAdapterLuid: ()=>E_INVALIDARG,
        /** @param {any} factory @param {number[]} args */
        RegisterStereoStatusWindow: (factory, [, , cookie])=>registered(factory, cookie),
        /** @param {any} factory @param {number[]} args */
        RegisterStereoStatusEvent: (factory, [, cookie])=>registered(factory, cookie),
        UnregisterStereoStatus: ()=>{},
        /** @param {any} factory @param {number[]} args */
        RegisterOcclusionStatusWindow: (factory, [, , cookie])=>registered(factory, cookie),
        /** @param {any} factory @param {number[]} args */
        RegisterOcclusionStatusEvent: (factory, [, cookie])=>registered(factory, cookie),
        UnregisterOcclusionStatus: ()=>{},
        /** @param {any} factory */
        GetCreationFlags: factory=>factory.GetCreationFlags(),
        /** @param {any} factory @param {number[]} args */
        EnumAdapterByLuid: (factory, [low, high, guid, out])=>{
            /** @type {{ adapter?: any }} */
            const held = {};
            const hr = factory.EnumAdapterByLuid(low >>> 0, high >>> 0, held);
            return adapterAs(hr, held.adapter, guid, out);
        },
        /** @param {any} factory @param {number[]} args */
        EnumWarpAdapter: (factory, [guid, out])=>{
            /** @type {{ adapter?: any }} */
            const held = {};
            return adapterAs(factory.EnumWarpAdapter(held), held.adapter, guid, out);
        },
        /** @param {any} factory @param {number[]} args */
        CheckFeatureSupport: (factory, [feature, dataAt, size])=>{
            const answer = factory.CheckFeatureSupport(feature >>> 0, size >>> 0);
            if (answer.hr !== S_OK || (dataAt >>> 0) === 0)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            fields.writeU32(dataAt, answer.value ?? 0);
            return S_OK;
        },
        // One adapter: the one of every preference.
        /** @param {any} factory @param {number[]} args */
        EnumAdapterByGpuPreference: (factory, [index, preference, guid, out])=>{
            if ((preference >>> 0) > 2)
            {
                if ((out >>> 0) !== 0)
                {
                    fields.writeU32(out, 0);
                }
                return E_INVALIDARG;
            }
            /** @type {{ adapter?: any }} */
            const held = {};
            return adapterAs(factory.EnumAdapters(index >>> 0, held), held.adapter, guid, out);
        },
        /** @param {any} factory @param {number[]} args */
        RegisterAdaptersChangedEvent: (factory, [, cookie])=>registered(factory, cookie),
        UnregisterAdaptersChangedEvent: ()=>S_OK,
        /**
         * A software rasteriser is a module a program loads; nothing here can
         * run one.
         *
         * @param {any} factory @param {number[]} args
         */
        CreateSoftwareAdapter: (factory, [module, out])=>{
            if ((out >>> 0) !== 0)
            {
                fields.writeU32(out, 0);
            }
            return (module >>> 0) === 0 || (out >>> 0) === 0
                ? DXGI_ERROR_INVALID_CALL
                : DXGI_ERROR_UNSUPPORTED;
        },
    });

    /**
     * ResizeBuffers and ResizeBuffers1: a size of zero is the window's.
     *
     * @param {any} swapChain @param {number[]} args
     */
    const resizeBuffers = (swapChain, [count, width, height, format, flags])=>{
        /** @type {{ desc?: any }} */
        const held = {};
        const asked = (width >>> 0) === 0 || (height >>> 0) === 0
            ? sized(swapChain.GetDesc(held) === S_OK && held.desc
                ? { ...held.desc, bufferDesc: { ...held.desc.bufferDesc, width: width >>> 0,
                    height: height >>> 0 } }
                : null)
            : null;
        return swapChain.ResizeBuffers(count >>> 0,
            asked ? asked.bufferDesc.width : width >>> 0,
            asked ? asked.bufferDesc.height : height >>> 0, format >>> 0, flags >>> 0);
    };

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const swapChainInterfaces = describeAll([
        [IID.IDXGISwapChain, IDXGISWAPCHAIN_SLOTS], [IID.IDXGISwapChain1, IDXGISWAPCHAIN1_SLOTS],
        [IID.IDXGISwapChain2, IDXGISWAPCHAIN2_SLOTS], [IID.IDXGISwapChain3, IDXGISWAPCHAIN3_SLOTS],
        [IID.IDXGISwapChain4, IDXGISWAPCHAIN4_SLOTS], [IID.IDXGIObject, IDXGIOBJECT_SLOTS],
        [IID.IDXGIDeviceSubObject, IDXGIDEVICESUBOBJECT_SLOTS],
    ], {
        ...privateDataMethods,
        GetParent: getParent,
        // The device is not the parent -- the factory is -- so the seam keeps
        // the pairing itself, from the moment the chain was made.
        /** @param {any} swapChain @param {number[]} args */
        GetDevice: (swapChain, [guid, out])=>{
            const id = readGuid(memory, guid);
            const device = swapChainDevices.get(swapChain);
            if (!device || !device.supports(id))
            {
                fields.writeU32(out, 0);
                return E_INVALIDARG;
            }
            device.addRef();
            return handBack(device, deviceInterfaces, id, out);
        },
        /** @param {any} swapChain @param {number[]} args */
        Present: (swapChain, [interval, flags])=>presented(swapChain,
            swapChain.Present(interval >>> 0, flags >>> 0), flags >>> 0),
        /** @param {any} swapChain @param {number[]} args */
        GetBuffer: (swapChain, [index, guid, out])=>{
            const id = readGuid(memory, guid);
            /** @type {{ buffer?: any }} */
            const held = {};
            const hr = swapChain.GetBuffer(index >>> 0, id, held);
            if (hr !== S_OK)
            {
                fields.writeU32(out, 0);
                return hr;
            }
            return handBack(held.buffer, texture2DInterfaces, id, out);
        },
        /** @param {any} swapChain @param {number[]} args */
        SetFullscreenState: (swapChain, [fullscreen, target])=>
            swapChain.SetFullscreenState(fullscreen !== 0,
                (target >>> 0) === 0 ? null : publisher.objectAt(target)),
        /**
         * The target is a reference of the caller's, and released here when
         * the caller left no room for it.
         *
         * @param {any} swapChain @param {number[]} args
         */
        GetFullscreenState: (swapChain, [fullscreenAt, targetAt])=>{
            /** @type {{ fullscreen?: boolean, target?: any }} */
            const held = {};
            const hr = swapChain.GetFullscreenState(held);
            if ((fullscreenAt >>> 0) !== 0)
            {
                fields.writeU32(fullscreenAt, held.fullscreen ? 1 : 0);
            }
            if ((targetAt >>> 0) === 0)
            {
                held.target?.release();
            }
            else if (held.target)
            {
                handBack(held.target, outputInterfaces, IID.IDXGIOutput, targetAt);
            }
            else
            {
                fields.writeU32(targetAt, 0);
            }
            return hr;
        },
        /** @param {any} swapChain @param {number[]} args */
        GetDesc: (swapChain, [out])=>{
            /** @type {{ desc?: any }} */
            const held = {};
            const hr = swapChain.GetDesc(held);
            if (hr === S_OK && (out >>> 0) !== 0)
            {
                writeSwapChainDesc(memory, out, held.desc, pointerSize);
            }
            return hr;
        },
        ResizeBuffers: resizeBuffers,
        // The queues of a Direct3D 12 chain's buffers have no meaning for 10 and 11.
        ResizeBuffers1: resizeBuffers,
        /** @param {any} swapChain @param {number[]} args */
        ResizeTarget: (swapChain, [mode])=>swapChain.ResizeTarget((mode >>> 0) === 0
            ? null
            : readModeDesc(memory, mode >>> 0)),
        /** @param {any} swapChain @param {number[]} args */
        GetContainingOutput: (swapChain, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            /** @type {{ output?: any }} */
            const held = {};
            const hr = swapChain.GetContainingOutput(held);
            if (hr !== S_OK)
            {
                fields.writeU32(out, 0);
                return hr;
            }
            return handBack(held.output, outputInterfaces, IID.IDXGIOutput, out);
        },
        // Frame statistics are kept for a fullscreen swap chain only.
        GetFrameStatistics: ()=>DXGI_ERROR_INVALID_CALL,
        /** @param {any} swapChain @param {number[]} args */
        GetDesc1: (swapChain, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            /** @type {{ desc?: any }} */
            const held = {};
            swapChain.GetDesc1(held);
            writeSwapChainDesc1(memory, out, held.desc);
            return S_OK;
        },
        /** @param {any} swapChain @param {number[]} args */
        GetFullscreenDesc: (swapChain, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            /** @type {{ desc?: any }} */
            const held = {};
            swapChain.GetDesc(held);
            writeFullscreenDesc(memory, out, held.desc);
            return S_OK;
        },
        /** @param {any} swapChain @param {number[]} args */
        GetHwnd: (swapChain, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            /** @type {{ desc?: any }} */
            const held = {};
            swapChain.GetDesc(held);
            writePointer(out, held.desc.outputWindow);
            return S_OK;
        },
        // A window's swap chain has no core window.
        /** @param {any} swapChain @param {number[]} args */
        GetCoreWindow: (swapChain, [, out])=>{
            if ((out >>> 0) !== 0)
            {
                fields.writeU32(out, 0);
            }
            return DXGI_ERROR_INVALID_CALL;
        },
        // Dirty rectangles and scrolling only say what changed: the whole is shown.
        /** @param {any} swapChain @param {number[]} args */
        Present1: (swapChain, [interval, flags])=>presented(swapChain,
            swapChain.Present(interval >>> 0, flags >>> 0), flags >>> 0),
        /** @param {any} swapChain */
        IsTemporaryMonoSupported: swapChain=>(swapChain.IsTemporaryMonoSupported() ? 1 : 0),
        /** @param {any} swapChain @param {number[]} args */
        GetRestrictToOutput: (swapChain, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            /** @type {{ output?: any }} */
            const held = {};
            swapChain.GetRestrictToOutput(held);
            if (!held.output)
            {
                fields.writeU32(out, 0);
                return S_OK;
            }
            return handBack(held.output, outputInterfaces, IID.IDXGIOutput, out);
        },
        /** @param {any} swapChain @param {number[]} args */
        SetBackgroundColor: (swapChain, [rgbaAt])=>swapChain.SetBackgroundColor(
            (rgbaAt >>> 0) === 0 ? null : readFloats(rgbaAt, 4)),
        /** @param {any} swapChain @param {number[]} args */
        GetBackgroundColor: (swapChain, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            /** @type {{ rgba?: number[] }} */
            const held = {};
            swapChain.GetBackgroundColor(held);
            (held.rgba ?? []).forEach((value, index)=>fields.writeF32(out + index * 4, value));
            return S_OK;
        },
        /** @param {any} swapChain @param {number[]} args */
        SetRotation: (swapChain, [rotation])=>swapChain.SetRotation(rotation >>> 0),
        /** @param {any} swapChain @param {number[]} args */
        GetRotation: (swapChain, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            /** @type {{ rotation?: number }} */
            const held = {};
            swapChain.GetRotation(held);
            fields.writeU32(out, held.rotation ?? 1);
            return S_OK;
        },
        /** @param {any} swapChain @param {number[]} args */
        SetSourceSize: (swapChain, [width, height])=>swapChain.SetSourceSize(width >>> 0,
            height >>> 0),
        /** @param {any} swapChain @param {number[]} args */
        GetSourceSize: (swapChain, [widthAt, heightAt])=>{
            if ((widthAt >>> 0) === 0 || (heightAt >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            /** @type {{ width?: number, height?: number }} */
            const held = {};
            swapChain.GetSourceSize(held);
            fields.writeU32(widthAt, held.width ?? 0);
            fields.writeU32(heightAt, held.height ?? 0);
            return S_OK;
        },
        /** @param {any} swapChain @param {number[]} args */
        SetMaximumFrameLatency: (swapChain, [frames])=>
            swapChain.SetMaximumFrameLatency(frames >>> 0),
        /** @param {any} swapChain @param {number[]} args */
        GetMaximumFrameLatency: (swapChain, [out])=>{
            if ((out >>> 0) === 0)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            /** @type {{ frames?: number }} */
            const held = {};
            const hr = swapChain.GetMaximumFrameLatency(held);
            if (hr === S_OK)
            {
                fields.writeU32(out, held.frames ?? 1);
            }
            return hr;
        },
        /** @param {any} swapChain */
        GetFrameLatencyWaitableObject: swapChain=>swapChain.GetFrameLatencyWaitableObject(),
        // A matrix scales a composition swap chain, which a window's is not.
        SetMatrixTransform: ()=>DXGI_ERROR_INVALID_CALL,
        GetMatrixTransform: ()=>DXGI_ERROR_INVALID_CALL,
        /** @param {any} swapChain */
        GetCurrentBackBufferIndex: swapChain=>swapChain.GetCurrentBackBufferIndex(),
        /** @param {any} swapChain @param {number[]} args */
        CheckColorSpaceSupport: (swapChain, [colorSpace, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            fields.writeU32(out, swapChain.CheckColorSpaceSupport(colorSpace >>> 0));
            return S_OK;
        },
        /** @param {any} swapChain @param {number[]} args */
        SetColorSpace1: (swapChain, [colorSpace])=>swapChain.SetColorSpace1(colorSpace >>> 0),
        /** @param {any} swapChain @param {number[]} args */
        SetHDRMetaData: (swapChain, [type])=>swapChain.SetHDRMetaData(type >>> 0),
        /** @param {any} swapChain @param {number[]} args */
        GetLastPresentCount: (swapChain, [out])=>{
            /** @type {{ count?: number }} */
            const held = {};
            const hr = swapChain.GetLastPresentCount(held);
            if (hr === S_OK)
            {
                fields.writeU32(out, held.count ?? 0);
            }
            return hr;
        },
    });

    /** The device each swap chain presents for, for `GetDevice`. */
    /** @type {WeakMap<object, any>} */
    const swapChainDevices = new WeakMap();
    /**
     * The window the last swap chain that showed a frame presents into, and
     * whether it is full screen: what the screen shows there is that frame,
     * not the window's own surface (`presentedWindow`). Null until one has.
     *
     * @type {{ window: number, fullscreen: boolean } | null}
     */
    let presentedInto = null;
    /**
     * A present's answer, the window it showed in remembered: one that only
     * tests (DXGI_PRESENT_TEST) or failed shows nothing. A present held until
     * the GPU takes the frame answers later, and is remembered then.
     *
     * @template {number | Promise<number>} T
     * @param {any} swapChain @param {T} answer @param {number} flags
     * @returns {T}
     */
    const presented = (swapChain, answer, flags)=>{
        /** @param {number} hr */
        const shown = hr=>{
            /** @type {{ desc?: any }} */
            const held = {};
            if (hr >= 0 && (flags & DXGI_PRESENT_TEST) === 0 && swapChain.GetDesc?.(held) >= 0
                && held.desc)
            {
                presentedInto = { window: held.desc.outputWindow >>> 0,
                    fullscreen: !held.desc.windowed };
            }
        };
        if (answer instanceof Promise)
        {
            answer.then(shown, ()=>{});
        }
        else
        {
            shown(/** @type {number} */ (answer));
        }
        return answer;
    };

    // --- resources ---

    /**
     * Where a mapped subresource's guest block is: one per resource and
     * subresource, for as long as the map lasts.
     *
     * @type {WeakMap<object, Map<number, { address: number, data: Uint8Array }>>}
     */
    const mappings = new WeakMap();

    /**
     * @param {any} resource
     * @param {number} subresource
     * @param {number} mapType
     * @param {number} flags
     * @param {(mapped: { hr: number, address: number, rowPitch: number, depthPitch: number })
     *     => number} use  what the call answers once the map is made
     * @returns {number | Promise<number>}
     */
    const mapInto = (resource, subresource, mapType, flags, use)=>{
        /** @type {{ data?: Uint8Array | null, rowPitch?: number, depthPitch?: number,
         *     pData?: number }} */
        const held = {};
        const made = resource.Map(subresource, mapType, flags, held);
        // A device drawn elsewhere answers a read map of a staging resource
        // when its bytes arrive: the map is finished then.
        return typeof made?.then === 'function'
            ? made.then((/** @type {number} */ hr)=>use(mappedOf(resource, subresource, hr, held)))
            : use(mappedOf(resource, subresource, made, held));
    };

    /**
     * @param {any} resource @param {number} subresource @param {number} hr
     * @param {{ data?: Uint8Array | null, rowPitch?: number, depthPitch?: number,
     *     pData?: number }} held  what the object's map gave
     * @returns {{ hr: number, address: number, rowPitch: number, depthPitch: number }}
     */
    const mappedOf = (resource, subresource, hr, held)=>{
        if (hr === S_OK && typeof held.pData === 'number')
        {
            // The bytes are in guest memory already: the address is the map.
            return { hr, address: held.pData, rowPitch: held.rowPitch ?? 0,
                depthPitch: held.depthPitch ?? 0 };
        }
        if (hr !== S_OK || !held.data)
        {
            return { hr, address: 0, rowPitch: 0, depthPitch: 0 };
        }
        if (!allocate)
        {
            resource.Unmap(subresource);
            return { hr: E_INVALIDARG, address: 0, rowPitch: 0, depthPitch: 0 };
        }
        let held2 = mappings.get(resource);
        if (!held2)
        {
            held2 = new Map();
            mappings.set(resource, held2);
        }
        let block = held2.get(subresource);
        if (!block)
        {
            const address = allocate(Math.max(held.data.length, 4));
            if (address === 0)
            {
                resource.Unmap(subresource);
                return { hr: E_INVALIDARG, address: 0, rowPitch: 0, depthPitch: 0 };
            }
            block = { address, data: held.data };
            held2.set(subresource, block);
        }
        // The program may read what is there before writing over it.
        memory.writeMemory(block.address, held.data);
        return {
            hr: S_OK,
            address: block.address,
            rowPitch: held.rowPitch ?? 0,
            depthPitch: held.depthPitch ?? 0,
        };
    };

    /**
     * Runs a map once the GPU has delivered what the resource is waiting for
     * -- a copy it is making into it -- parking the caller until then. A map
     * that asked not to wait is answered at once, by the object.
     *
     * @param {any} resource
     * @param {number} flags
     * @param {() => number | Promise<number>} run
     * @returns {number | Promise<number>}
     */
    const whenMappable = (resource, flags, run)=>{
        const waiting = (flags & D3D10_MAP_FLAG_DO_NOT_WAIT) === 0
            ? resource.pendingReadback?.() ?? null
            : null;
        return waiting ? waiting.then(run) : run();
    };

    /** @param {any} resource @param {number} subresource */
    const unmapFrom = (resource, subresource)=>{
        const block = mappings.get(resource)?.get(subresource);
        if (block)
        {
            block.data.set(memory.readMemory(block.address, block.data.length));
            mappings.get(resource)?.delete(subresource);
            free?.(block.address);
        }
        resource.Unmap(subresource);
    };

    /** @param {any} resource @param {number[]} args */
    const getType = (resource, [out])=>{
        /** @type {{ type?: number }} */
        const held = {};
        resource.GetType(held);
        fields.writeU32(out, held.type ?? 0);
    };

    const resourceMethods = {
        GetDevice: getDevice,
        ...privateDataMethods,
        GetType: getType,
        /** @param {any} resource @param {number[]} args */
        SetEvictionPriority: (resource, [priority])=>{
            resource.SetEvictionPriority(priority >>> 0);
        },
        /** @param {any} resource */
        GetEvictionPriority: resource=>resource.GetEvictionPriority(),
    };

    /**
     * IDXGIDeviceSubObject::GetDevice: the device, as whichever interface the
     * caller names.
     *
     * @param {any} child @param {number[]} args
     */
    const subObjectDevice = (child, [guid, out])=>{
        const id = readGuid(memory, guid);
        /** @type {{ device?: any }} */
        const held = {};
        child.GetDevice(held);
        if (!held.device.supports(id))
        {
            held.device.release();
            fields.writeU32(out, 0);
            return 0x80004002 | 0;
        }
        return handBack(held.device, deviceInterfaces, id, out);
    };

    /** The same resource through DXGI: a resource, and a surface when it is one image. */
    const dxgiResourceMethods = {
        ...privateDataMethods,
        GetParent: getParent,
        GetDevice: subObjectDevice,
        /**
         * A legacy handle for a texture made shared, none for one that is not,
         * and nothing written for one only an NT handle names.
         *
         * @param {any} resource @param {number[]} args
         */
        GetSharedHandle: (resource, [out])=>{
            /** @type {{ handle?: number }} */
            const held = {};
            const hr = resource.GetSharedHandle(held);
            if (hr === S_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out, held.handle ?? 0);
            }
            return hr;
        },
        /**
         * An NT handle to a texture made with SHARED_NTHANDLE, a kernel
         * object of the process (test_shared_resource); none for any other.
         * A name is not kept: what OpenSharedResourceByName would find is said.
         *
         * @param {any} resource @param {number[]} args
         */
        CreateSharedHandle: (resource, [, , name, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const key = resource.ntShareKey();
            if (key === null || !sharedHandles)
            {
                fields.writeU32(out, 0);
                if (key !== null)
                {
                    divergence?.('DXGI', 'an NT handle to a shared resource needs the kernel;'
                        + ' none is made');
                }
                return E_INVALIDARG;
            }
            if ((name >>> 0) !== 0)
            {
                divergence?.('DXGI', 'a shared resource\'s handle is made without its name:'
                    + ' it is not found by name');
            }
            fields.writeU32(out, sharedHandles.open(key));
            return S_OK;
        },
        /**
         * One subresource of a resource as a surface of its own: not made yet,
         * said, and refused as not implemented.
         *
         * @param {any} resource @param {number[]} args
         */
        CreateSubresourceSurface: (resource, [, out])=>{
            if ((out >>> 0) !== 0)
            {
                fields.writeU32(out, 0);
            }
            divergence?.('DXGI', 'IDXGIResource1::CreateSubresourceSurface is not implemented');
            return E_NOTIMPL;
        },
        /** @param {any} resource @param {number[]} args */
        AcquireSync: (resource, [low, high, milliseconds])=>
            resource.AcquireSync((low >>> 0) + (high >>> 0) * 0x100000000, milliseconds >>> 0),
        /** @param {any} resource @param {number[]} args */
        ReleaseSync: (resource, [low, high])=>
            resource.ReleaseSync((low >>> 0) + (high >>> 0) * 0x100000000),
        /** @param {any} resource @param {number[]} args */
        GetUsage: (resource, [out])=>{
            fields.writeU32(out, resource.GetUsage());
            return S_OK;
        },
        /** @param {any} resource @param {number[]} args */
        SetEvictionPriority: (resource, [priority])=>{
            resource.SetEvictionPriority(priority >>> 0);
            return S_OK;
        },
        /** @param {any} resource @param {number[]} args */
        GetEvictionPriority: (resource, [out])=>{
            fields.writeU32(out, resource.GetEvictionPriority());
            return S_OK;
        },
        /** @param {any} texture @param {number[]} args */
        GetDesc: (texture, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const desc = texture.desc;
            fields.writeStruct(out, DXGI_SURFACE_DESC, {
                Width: desc.Width,
                Height: desc.Height ?? 1,
                Format: desc.Format,
                SampleCount: desc.SampleDesc?.Count ?? 1,
                SampleQuality: desc.SampleDesc?.Quality ?? 0,
            });
            return S_OK;
        },
        /**
         * The surface's one subresource, mapped as DXGI names the access.
         *
         * @param {any} texture @param {number[]} args
         */
        Map: (texture, [rect, flags])=>{
            const mapType = dxgiMapType(flags >>> 0);
            if (mapType === 0 || (rect >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            return whenMappable(texture, 0, ()=>mapInto(texture, 0, mapType, 0, mapped=>{
                if (mapped.hr === S_OK)
                {
                    fields.writeU32(rect, mapped.rowPitch);
                    fields.writeU32(rect + 4, mapped.address);
                }
                return mapped.hr;
            }));
        },
        /** @param {any} texture */
        Unmap: texture=>{
            unmapFrom(texture, 0);
            return S_OK;
        },
        /**
         * A device context over the surface: GDI draws into guest memory
         * holding the surface's pixels -- once the GPU's last drawing of them
         * has come back, unless the program discards them -- and ReleaseDC
         * hands what it drew to the surface.
         *
         * @param {any} texture @param {number[]} args
         */
        GetDC: (texture, [discard, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            if (!gdi || !allocate)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            const opened = texture.OpenDC(discard !== 0);
            if (opened.hr !== S_OK)
            {
                return opened.hr;
            }
            const open = ()=>{
                const data = /** @type {Uint8Array} */ (opened.data);
                const address = allocate(Math.max(data.length, 4));
                const handle = address === 0 ? 0 : gdi.createSurfaceDc({
                    width: texture.desc.Width, height: texture.desc.Height,
                    pitch: /** @type {number} */ (opened.rowPitch), bitCount: 32,
                    bits: address, palette: null, format: '555', sizeImage: 0,
                });
                if (handle === 0)
                {
                    if (address !== 0)
                    {
                        free?.(address);
                    }
                    texture.CloseDC();
                    return DXGI_ERROR_INVALID_CALL;
                }
                memory.writeMemory(address, data);
                contexts.set(texture, { address, handle, data });
                fields.writeU32(out, handle);
                return S_OK;
            };
            return opened.ready ? opened.ready.then(open) : open();
        },
        /** @param {any} texture */
        ReleaseDC: texture=>{
            const held = contexts.get(texture);
            if (!held || !gdi)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            contexts.delete(texture);
            held.data.set(memory.readMemory(held.address, held.data.length));
            gdi.deleteSurfaceDc(held.handle);
            free?.(held.address);
            return texture.CloseDC();
        },
    };

    /**
     * The device context a surface has open, and the guest memory it draws
     * into.
     *
     * @type {WeakMap<object, { address: number, handle: number, data: Uint8Array }>}
     */
    const contexts = new WeakMap();

    /**
     * Direct3D 11's faces of the same objects (`d3d11.js`), each list below
     * ending with its own: what a program reaches through either version.
     */
    const eleven = createDirect3D11Seam(describe, ()=>kit, { context: contextGuests });

    /**
     * The interfaces every resource shares, after its own: Direct3D's two
     * bases and DXGI's four faces of the same object. Which of them a given
     * resource answers to is its own to say (its `supports`, which the publisher asks).
     *
     * @type {import('./com.js').InterfaceDescriptor[]}
     */
    const resourceBases = [
        describe(IID.ID3D10Resource, ID3D10RESOURCE_SLOTS, resourceMethods),
        describe(IID.ID3D10DeviceChild, ID3D10DEVICECHILD_SLOTS, resourceMethods),
        // IDXGIResource derives from IDXGIDeviceSubObject and IDXGIObject:
        // asked for either, a resource hands back its IDXGIResource pointer
        // (test_dxgi_resource).
        ...describeAll([
            [IID.IDXGIObject, IDXGIOBJECT_SLOTS],
            [IID.IDXGIDeviceSubObject, IDXGIDEVICESUBOBJECT_SLOTS],
        ], dxgiResourceMethods).map(face=>({ ...face, sharedWith: IID.IDXGIResource })),
        ...describeAll([
            [IID.IDXGIResource, IDXGIRESOURCE_SLOTS],
            [IID.IDXGIResource1, IDXGIRESOURCE1_SLOTS],
            [IID.IDXGIKeyedMutex, IDXGIKEYEDMUTEX_SLOTS],
            [IID.IDXGISurface, IDXGISURFACE_SLOTS],
            [IID.IDXGISurface1, IDXGISURFACE1_SLOTS],
        ], dxgiResourceMethods),
    ];

    /**
     * @param {any} texture
     * @param {number[]} args
     * @param {boolean} pitches  Whether the out structure has room for pitches.
     */
    const mapTexture = (texture, [subresource, mapType, flags, out], pitches)=>
        whenMappable(texture, flags >>> 0, ()=>mapInto(texture, subresource >>> 0,
            mapType >>> 0, flags >>> 0, mapped=>{
                if (mapped.hr !== S_OK || (out >>> 0) === 0)
                {
                    return mapped.hr;
                }
                writePointer(out, mapped.address);
                if (pitches)
                {
                    fields.writeU32(out + pointerSize, mapped.rowPitch);
                }
                return S_OK;
            }));

    /** @param {any} texture @param {number[]} args */
    const unmapTexture = (texture, [subresource])=>unmapFrom(texture, subresource >>> 0);

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const bufferInterfaces = [describe(IID.ID3D10Buffer, ID3D10BUFFER_SLOTS, {
        ...resourceMethods,
        /** @param {any} buffer @param {number[]} args */
        Map: (buffer, [mapType, flags, out])=>whenMappable(buffer, flags >>> 0, ()=>{
            countUnattached(buffer);
            ringOf(buffer)?.hostMap(buffer, mapType >>> 0);
            return mapInto(buffer, 0, mapType >>> 0, flags >>> 0, mapped=>{
                if (mapped.hr === S_OK && (out >>> 0) !== 0)
                {
                    writePointer(out, mapped.address);
                }
                return mapped.hr;
            });
        }),
        /** @param {any} buffer */
        Unmap: buffer=>{
            // A map the guest made, unmapped here when its ring had no room.
            if (!ringOf(buffer)?.hostUnmap(buffer))
            {
                unmapFrom(buffer, 0);
            }
        },
        /** @param {any} buffer @param {number[]} args */
        GetDesc: (buffer, [out])=>{
            fields.writeStruct(out, D3D10_BUFFER_DESC, buffer.desc);
        },
    }, bufferGuests, buffer=>ringOf(buffer)?.released(buffer)), ...resourceBases,
    ...eleven.faces.buffer];

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const texture1DInterfaces = [describe(IID.ID3D10Texture1D, ID3D10TEXTURE_SLOTS, {
        ...resourceMethods,
        /** @param {any} texture @param {number[]} args */
        Map: (texture, args)=>mapTexture(texture, args, false),
        Unmap: unmapTexture,
        /** @param {any} texture @param {number[]} args */
        GetDesc: (texture, [out])=>{
            fields.writeStruct(out, D3D10_TEXTURE1D_DESC, texture.desc);
        },
    }), ...resourceBases, ...eleven.faces.texture1D];

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const texture2DInterfaces = [describe(IID.ID3D10Texture2D, ID3D10TEXTURE_SLOTS, {
        ...resourceMethods,
        /** @param {any} texture @param {number[]} args */
        Map: (texture, args)=>mapTexture(texture, args, true),
        Unmap: unmapTexture,
        /** @param {any} texture @param {number[]} args */
        GetDesc: (texture, [out])=>{
            fields.writeStruct(out, D3D10_TEXTURE2D_DESC, {
                ...texture.desc,
                SampleCount: texture.desc.SampleDesc.Count,
                SampleQuality: texture.desc.SampleDesc.Quality,
            });
        },
    }), ...resourceBases, ...eleven.faces.texture2D];

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const texture3DInterfaces = [describe(IID.ID3D10Texture3D, ID3D10TEXTURE_SLOTS, {
        ...resourceMethods,
        /** @param {any} texture @param {number[]} args */
        Map: (texture, [subresource, mapType, flags, out])=>whenMappable(texture, flags >>> 0,
            ()=>mapInto(texture, subresource >>> 0, mapType >>> 0, flags >>> 0, mapped=>{
                if (mapped.hr !== S_OK || (out >>> 0) === 0)
                {
                    return mapped.hr;
                }
                writePointer(out, mapped.address);
                fields.writeU32(out + pointerSize, mapped.rowPitch);
                fields.writeU32(out + pointerSize + 4, mapped.depthPitch);
                return S_OK;
            })),
        Unmap: unmapTexture,
        /** @param {any} texture @param {number[]} args */
        GetDesc: (texture, [out])=>{
            fields.writeStruct(out, D3D10_TEXTURE3D_DESC, texture.desc);
        },
    }), ...resourceBases, ...eleven.faces.texture3D];

    /**
     * The interface list a resource is published as, by what it is.
     *
     * @param {any} resource
     * @returns {[import('./com.js').InterfaceDescriptor[], string]}
     */
    const resourceInterfaces = resource=>{
        switch (resource.dimension)
        {
            case D3D10_RESOURCE_DIMENSION.BUFFER:
                return [bufferInterfaces, IID.ID3D10Buffer];
            case D3D10_RESOURCE_DIMENSION.TEXTURE1D:
                return [texture1DInterfaces, IID.ID3D10Texture1D];
            case D3D10_RESOURCE_DIMENSION.TEXTURE3D:
                return [texture3DInterfaces, IID.ID3D10Texture3D];
            default:
                return [texture2DInterfaces, IID.ID3D10Texture2D];
        }
    };

    // --- views and states ---

    /**
     * @param {string} id
     * @param {import('../d3d10/structs.js').ViewUnion} union  How its description is laid out.
     * @param {[string, [string, number][]][]} [later]  Later versions it also answers as.
     * @param {import('../d3d10/structs.js').ViewUnion} [union1]  The 10.1 description's.
     */
    const viewInterfaces = (id, union, later = [], union1 = union)=>describeAll([
        [id, ID3D10VIEW_SLOTS], [IID.ID3D10View, ID3D10BASEVIEW_SLOTS],
        [IID.ID3D10DeviceChild, ID3D10DEVICECHILD_SLOTS], ...later,
    ], {
        GetDevice: getDevice,
        ...privateDataMethods,
        /** @param {any} view @param {number[]} args */
        GetResource: (view, [out])=>{
            /** @type {{ resource?: any }} */
            const held = {};
            view.GetResource(held);
            const [interfaces, iid] = resourceInterfaces(held.resource);
            handBack(held.resource, interfaces, iid, out);
        },
        /** @param {any} view @param {number[]} args */
        GetDesc: (view, [out])=>{
            /** @type {{ desc?: any }} */
            const held = {};
            view.GetDesc(held);
            writeViewDesc(memory, out, union, held.desc);
        },
        /** @param {any} view @param {number[]} args */
        GetDesc1: (view, [out])=>{
            /** @type {{ desc?: any }} */
            const held = {};
            view.GetDesc(held);
            writeViewDesc(memory, out, union1, held.desc);
        },
    });

    const renderTargetViewInterfaces = [...viewInterfaces(IID.ID3D10RenderTargetView,
        VIEW_UNION.RENDER_TARGET), ...eleven.faces.rtv];
    const depthStencilViewInterfaces = [...viewInterfaces(IID.ID3D10DepthStencilView,
        VIEW_UNION.DEPTH_STENCIL), ...eleven.faces.dsv];
    const shaderResourceViewInterfaces = [...viewInterfaces(IID.ID3D10ShaderResourceView,
        VIEW_UNION.SHADER_RESOURCE, [[IID.ID3D10ShaderResourceView1,
            ID3D10SHADERRESOURCEVIEW1_SLOTS]], VIEW_UNION.SHADER_RESOURCE1),
    ...eleven.faces.srv];

    /**
     * @param {string} id
     * @param {(desc: any, out: number) => void} write
     * @param {[string, [string, number][]][]} [later]  Later versions it also answers as.
     */
    const stateInterfaces = (id, write, later = [])=>describeAll([
        [id, ID3D10STATE_SLOTS], [IID.ID3D10DeviceChild, ID3D10DEVICECHILD_SLOTS], ...later,
    ], {
        GetDevice: getDevice,
        ...privateDataMethods,
        /** @param {any} state @param {number[]} args */
        GetDesc: (state, [out])=>{
            /** @type {{ desc?: any }} */
            const held = {};
            state.GetDesc(held);
            write(held.desc, out);
        },
        /** @param {any} state @param {number[]} args */
        GetDesc1: (state, [out])=>{
            /** @type {{ desc?: any }} */
            const held = {};
            state.GetDesc1(held);
            writeBlendDesc1(held.desc, out);
        },
    });

    /** @param {any} desc a normalised D3D10_BLEND_DESC1 @param {number} out */
    const writeBlendDesc1 = (desc, out)=>{
        fields.writeU32(out + D3D10_BLEND_DESC1.AlphaToCoverageEnable,
            desc.AlphaToCoverageEnable ? 1 : 0);
        fields.writeU32(out + D3D10_BLEND_DESC1.IndependentBlendEnable,
            desc.IndependentBlendEnable ? 1 : 0);
        desc.RenderTarget.forEach((/** @type {any} */ target, /** @type {number} */ index)=>{
            const at = out + D3D10_BLEND_DESC1.RenderTarget + index * D3D10_BLEND_DESC1.TARGET_SIZE;
            fields.writeStruct(at, D3D10_RENDER_TARGET_BLEND_DESC1, {
                ...target, BlendEnable: target.BlendEnable ? 1 : 0,
            });
            memory.writeMemory(at + RENDER_TARGET_WRITE_MASK1,
                Uint8Array.from([target.RenderTargetWriteMask, 0, 0, 0]));
        });
    };

    /**
     * A BOOL as its word: a description an effect computed keeps the word its
     * expression gave (0xffffffff), one made of booleans reads 1 or 0.
     *
     * @param {boolean | number} value
     */
    const boolWord = value=>(typeof value === 'number' ? value >>> 0 : value ? 1 : 0);
    /** @param {any} desc @param {number} out */
    const writeBlendDesc = (desc, out)=>{
        fields.writeStruct(out, D3D10_BLEND_DESC, {
            AlphaToCoverageEnable: boolWord(desc.AlphaToCoverageEnable),
            SrcBlend: desc.SrcBlend,
            DestBlend: desc.DestBlend,
            BlendOp: desc.BlendOp,
            SrcBlendAlpha: desc.SrcBlendAlpha,
            DestBlendAlpha: desc.DestBlendAlpha,
            BlendOpAlpha: desc.BlendOpAlpha,
        });
        for (let index = 0; index < 8; index++)
        {
            fields.writeU32(out + D3D10_BLEND_DESC.BlendEnable + index * 4,
                boolWord(desc.BlendEnable[index]));
        }
        memory.writeMemory(out + D3D10_BLEND_DESC.RenderTargetWriteMask,
            Uint8Array.from(desc.RenderTargetWriteMask));
    };
    /** @param {any} desc @param {number} out */
    const writeDepthStencilDesc = (desc, out)=>{
        fields.writeStruct(out, D3D10_DEPTH_STENCIL_DESC, {
            DepthEnable: boolWord(desc.DepthEnable),
            DepthWriteMask: desc.DepthWriteMask,
            DepthFunc: desc.DepthFunc,
            StencilEnable: boolWord(desc.StencilEnable),
        });
        memory.writeMemory(out + D3D10_DEPTH_STENCIL_DESC.StencilReadMask,
            Uint8Array.from([desc.StencilReadMask, desc.StencilWriteMask, 0, 0]));
        fields.writeStruct(out + D3D10_DEPTH_STENCIL_DESC.FrontFace, STENCIL_FACE, desc.FrontFace);
        fields.writeStruct(out + D3D10_DEPTH_STENCIL_DESC.BackFace, STENCIL_FACE, desc.BackFace);
    };
    /** @param {any} desc @param {number} out */
    const writeRasterizerDesc = (desc, out)=>{
        fields.writeStruct(out, D3D10_RASTERIZER_DESC, {
            FillMode: desc.FillMode,
            CullMode: desc.CullMode,
            FrontCounterClockwise: boolWord(desc.FrontCounterClockwise),
            DepthBias: desc.DepthBias,
            DepthBiasClamp: desc.DepthBiasClamp,
            SlopeScaledDepthBias: desc.SlopeScaledDepthBias,
            DepthClipEnable: boolWord(desc.DepthClipEnable),
            ScissorEnable: boolWord(desc.ScissorEnable),
            MultisampleEnable: boolWord(desc.MultisampleEnable),
            AntialiasedLineEnable: boolWord(desc.AntialiasedLineEnable),
        }, ['DepthBiasClamp', 'SlopeScaledDepthBias']);
    };
    /** @param {any} desc @param {number} out */
    const writeSamplerDesc = (desc, out)=>{
        fields.writeStruct(out, D3D10_SAMPLER_DESC, {
            Filter: desc.Filter,
            AddressU: desc.AddressU,
            AddressV: desc.AddressV,
            AddressW: desc.AddressW,
            MipLODBias: desc.MipLODBias,
            MaxAnisotropy: desc.MaxAnisotropy,
            ComparisonFunc: desc.ComparisonFunc,
            MinLOD: desc.MinLOD,
            MaxLOD: desc.MaxLOD,
        }, ['MipLODBias', 'MinLOD', 'MaxLOD']);
        desc.BorderColor.forEach((/** @type {number} */ value, /** @type {number} */ index)=>{
            fields.writeF32(out + D3D10_SAMPLER_DESC.BorderColor + index * 4, value);
        });
    };
    const blendStateInterfaces = [...stateInterfaces(IID.ID3D10BlendState, writeBlendDesc,
        [[IID.ID3D10BlendState1, ID3D10BLENDSTATE1_SLOTS]]), ...eleven.faces.blend];
    const depthStencilStateInterfaces = [...stateInterfaces(IID.ID3D10DepthStencilState,
        writeDepthStencilDesc), ...eleven.faces.depthStencil];
    const rasterizerStateInterfaces = [...stateInterfaces(IID.ID3D10RasterizerState,
        writeRasterizerDesc), ...eleven.faces.rasterizer];
    const samplerStateInterfaces = [...stateInterfaces(IID.ID3D10SamplerState,
        writeSamplerDesc), ...eleven.faces.sampler];

    const childMethods = { GetDevice: getDevice, ...privateDataMethods };
    const childBase = describe(IID.ID3D10DeviceChild, ID3D10DEVICECHILD_SLOTS, childMethods);
    const vertexShaderInterfaces = [describe(IID.ID3D10VertexShader, ID3D10SHADER_SLOTS,
        childMethods), childBase, ...eleven.faces.vs];
    const geometryShaderInterfaces = [describe(IID.ID3D10GeometryShader, ID3D10SHADER_SLOTS,
        childMethods), childBase, ...eleven.faces.gs];
    const pixelShaderInterfaces = [describe(IID.ID3D10PixelShader, ID3D10SHADER_SLOTS,
        childMethods), childBase, ...eleven.faces.ps];
    const inputLayoutInterfaces = [describe(IID.ID3D10InputLayout, ID3D10SHADER_SLOTS,
        childMethods), childBase, ...eleven.faces.inputLayout];
    const queryMethods = {
        ...childMethods,
        /** @param {any} query */
        Begin: query=>{
            query.Begin();
        },
        /** @param {any} query */
        End: query=>{
            query.End();
        },
        /** @param {any} query @param {number[]} args */
        GetData: (query, [data, size, flags])=>{
            /** @type {{ data?: Uint8Array | null }} */
            const held = {};
            const hr = query.GetData((data >>> 0) !== 0, size >>> 0, flags >>> 0, held);
            if (hr === S_OK && held.data)
            {
                memory.writeMemory(data >>> 0, held.data);
            }
            return hr;
        },
        /** @param {any} query */
        GetDataSize: query=>query.GetDataSize(),
        /** @param {any} query @param {number[]} args */
        GetDesc: (query, [out])=>{
            fields.writeStruct(out, D3D10_QUERY_DESC, query.desc);
        },
    };
    // A predicate is a query and a query is an asynchronous object, one vtable
    // for all three; which of them an object answers to is its own to say.
    const queryDescriptors = [IID.ID3D10Query, IID.ID3D10Asynchronous, IID.ID3D10Predicate]
        .map(id=>describe(id, ID3D10QUERY_SLOTS, queryMethods))
        .concat(describe(IID.ID3D10DeviceChild, ID3D10DEVICECHILD_SLOTS, queryMethods),
            eleven.faces.query);

    // --- reading descriptions ---

    /** @param {number} address @returns {any} */
    const readTexture2DDesc = address=>{
        const raw = fields.readStruct(address, D3D10_TEXTURE2D_DESC);
        const { SampleCount, SampleQuality, ...rest } = raw;
        return { ...rest, SampleDesc: { Count: SampleCount, Quality: SampleQuality } };
    };

    /**
     * How many bytes one subresource of a texture holds, from the pitches the
     * program supplied or, when it supplied none, from the format.
     *
     * @param {any} desc
     * @param {number} dimension
     * @param {number} level
     * @param {number} pitch
     * @param {number} slicePitch
     */
    const subresourceBytes = (desc, dimension, level, pitch, slicePitch)=>{
        const width = levelExtent(desc.Width, level);
        const height = dimension === D3D10_RESOURCE_DIMENSION.TEXTURE1D
            ? 1
            : levelExtent(desc.Height, level);
        const depth = dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
            ? levelExtent(desc.Depth, level)
            : 1;
        const packed = formatPitch(desc.Format, width, height);
        const rowBytes = pitch || packed.rowPitch;
        return (slicePitch || rowBytes * packed.rows) * (depth - 1) + rowBytes * packed.rows;
    };

    /**
     * The initial data of every subresource, read out of the guest.
     *
     * @param {number} address
     * @param {any} desc
     * @param {number} dimension
     * @returns {import('../d3d10/render.js').SubresourceData[] | null}
     */
    const readInitialData = (address, desc, dimension)=>{
        if ((address >>> 0) === 0)
        {
            return null;
        }
        const levels = dimension === D3D10_RESOURCE_DIMENSION.BUFFER
            ? 1
            : (desc.MipLevels || fullChain(desc, dimension));
        const slices = dimension === D3D10_RESOURCE_DIMENSION.BUFFER
            || dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
            ? 1
            : (desc.ArraySize ?? 1);
        /** @type {import('../d3d10/render.js').SubresourceData[]} */
        const data = [];
        for (let index = 0; index < levels * slices; index++)
        {
            const entry = fields.readStruct(address + index * SUBRESOURCE_DATA.SIZE,
                SUBRESOURCE_DATA);
            const bytes = dimension === D3D10_RESOURCE_DIMENSION.BUFFER
                ? desc.ByteWidth
                : subresourceBytes(desc, dimension, index % levels, entry.SysMemPitch,
                    entry.SysMemSlicePitch);
            data.push({
                pSysMem: entry.pSysMem === 0 ? null : memory.readMemory(entry.pSysMem, bytes),
                SysMemPitch: entry.SysMemPitch,
                SysMemSlicePitch: entry.SysMemSlicePitch,
            });
        }
        return data;
    };

    /** @param {any} desc @param {number} dimension */
    const fullChain = (desc, dimension)=>{
        let extent = Math.max(desc.Width,
            dimension === D3D10_RESOURCE_DIMENSION.TEXTURE1D ? 1 : desc.Height ?? 1,
            dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D ? desc.Depth ?? 1 : 1);
        let levels = 1;
        while (extent > 1)
        {
            extent >>>= 1;
            levels++;
        }
        return levels;
    };

    /**
     * A view description, or null for the default view.
     *
     * @param {number} address
     * @param {import('../d3d10/structs.js').ViewUnion} union
     */
    const readViewDescAt = (address, union)=>((address >>> 0) === 0
        ? null
        : readViewDesc(memory, address, union));

    /**
     * @param {number} address
     * @param {number} count
     * @returns {object[]}
     */
    const readInputElements = (address, count)=>{
        /** @type {object[]} */
        const elements = [];
        for (let index = 0; index < count; index++)
        {
            const raw = fields.readStruct(address + index * INPUT_ELEMENT_DESC.SIZE,
                INPUT_ELEMENT_DESC);
            elements.push({
                ...raw,
                SemanticName: raw.SemanticName === 0 ? '' : readCString(raw.SemanticName),
            });
        }
        return elements;
    };

    /**
     * A stream-output declaration: null where the program gave none, and
     * empty where it gave a list of no entries or a count with no list.
     * Direct3D 10's entry has no stream; 11's begins with one.
     *
     * @param {number} at @param {number} count @param {boolean} streamed
     * @returns {import('../d3d10/streamout.js').StreamOutputEntry[] | null}
     */
    const readStreamOutput = (at, count, streamed)=>{
        if ((at >>> 0) === 0 || (count >>> 0) === 0)
        {
            return (at >>> 0) === 0 && (count >>> 0) === 0 ? null : [];
        }
        // The name on a pointer's boundary, past the stream where 11 has one: 12 or 16
        // bytes an entry in a 32-bit process, 16 or 24 in a 64-bit one.
        const nameAt = streamed ? pointerSize : 0;
        const size = nameAt + pointerSize + 8;
        return Array.from({ length: count >>> 0 }, (_, index)=>{
            const entry = (at >>> 0) + index * size;
            const named = entry + nameAt;
            const name = fields.readU32(named);
            const bytes = fields.readU32(named + pointerSize + 4);
            return {
                Stream: streamed ? fields.readU32(entry) : 0,
                SemanticName: name === 0 ? null : readCString(name),
                SemanticIndex: fields.readU32(named + pointerSize),
                StartComponent: bytes & 0xff,
                ComponentCount: (bytes >>> 8) & 0xff,
                OutputSlot: (bytes >>> 16) & 0xff,
            };
        });
    };

    /** @param {number} address */
    const readCString = address=>{
        let text = '';
        for (let at = address; ; at++)
        {
            const byte = memory.readMemory(at, 1)[0];
            if (byte === 0 || text.length > 255)
            {
                return text;
            }
            text += String.fromCharCode(byte);
        }
    };

    /** @param {number} address @returns {any} */
    const readBlendDesc = address=>{
        const raw = fields.readStruct(address, D3D10_BLEND_DESC);
        const enables = readDwords(address + D3D10_BLEND_DESC.BlendEnable, 8);
        const masks = memory.readMemory(address + D3D10_BLEND_DESC.RenderTargetWriteMask, 8);
        return {
            ...raw,
            AlphaToCoverageEnable: raw.AlphaToCoverageEnable !== 0,
            BlendEnable: enables.map(value=>value !== 0),
            RenderTargetWriteMask: [...masks],
        };
    };

    /** @param {number} address @returns {any} */
    const readBlendDesc1 = address=>({
        AlphaToCoverageEnable: fields.readU32(address + D3D10_BLEND_DESC1.AlphaToCoverageEnable)
            !== 0,
        IndependentBlendEnable: fields.readU32(address + D3D10_BLEND_DESC1.IndependentBlendEnable)
            !== 0,
        RenderTarget: Array.from({ length: 8 }, (_, index)=>{
            const at = address + D3D10_BLEND_DESC1.RenderTarget
                + index * D3D10_BLEND_DESC1.TARGET_SIZE;
            const target = fields.readStruct(at, D3D10_RENDER_TARGET_BLEND_DESC1);
            return {
                ...target,
                BlendEnable: target.BlendEnable !== 0,
                RenderTargetWriteMask: memory.readMemory(at + RENDER_TARGET_WRITE_MASK1, 1)[0],
            };
        }),
    });

    /** @param {number} address @returns {any} */
    const readDepthStencilDesc = address=>{
        const raw = fields.readStruct(address, D3D10_DEPTH_STENCIL_DESC);
        const masks = memory.readMemory(address + D3D10_DEPTH_STENCIL_DESC.StencilReadMask, 2);
        return {
            DepthEnable: raw.DepthEnable !== 0,
            DepthWriteMask: raw.DepthWriteMask,
            DepthFunc: raw.DepthFunc,
            StencilEnable: raw.StencilEnable !== 0,
            StencilReadMask: masks[0],
            StencilWriteMask: masks[1],
            FrontFace: fields.readStruct(address + D3D10_DEPTH_STENCIL_DESC.FrontFace,
                STENCIL_FACE),
            BackFace: fields.readStruct(address + D3D10_DEPTH_STENCIL_DESC.BackFace,
                STENCIL_FACE),
        };
    };

    /** @param {number} address @returns {any} */
    const readRasterizerDesc = address=>{
        const raw = fields.readStruct(address, D3D10_RASTERIZER_DESC,
            ['DepthBiasClamp', 'SlopeScaledDepthBias']);
        return {
            ...raw,
            DepthBias: raw.DepthBias | 0,
            FrontCounterClockwise: raw.FrontCounterClockwise !== 0,
            DepthClipEnable: raw.DepthClipEnable !== 0,
            ScissorEnable: raw.ScissorEnable !== 0,
            MultisampleEnable: raw.MultisampleEnable !== 0,
            AntialiasedLineEnable: raw.AntialiasedLineEnable !== 0,
        };
    };

    /** @param {number} address @returns {any} */
    const readSamplerDesc = address=>({
        ...fields.readStruct(address, D3D10_SAMPLER_DESC, ['MipLODBias', 'MinLOD', 'MaxLOD']),
        BorderColor: readFloats(address + D3D10_SAMPLER_DESC.BorderColor, 4),
    });

    /** @param {number} address */
    const readBox = address=>((address >>> 0) === 0
        ? null
        : fields.readStruct(address, D3D10_BOX));

    /**
     * How many bytes an update brings: the box's worth, or the subresource's
     * when there is no box, at the pitches the program gave or the format's.
     *
     * @param {any} resource
     * @param {number} subresource
     * @param {Record<string, number> | null} box
     * @param {number} rowPitch
     * @param {number} depthPitch
     */
    const updateBytesOf = (resource, subresource, box, rowPitch, depthPitch)=>{
        if (resource.dimension === D3D10_RESOURCE_DIMENSION.BUFFER)
        {
            return box ? box.right - box.left : resource.desc.ByteWidth;
        }
        const level = subresource % resource.desc.MipLevels;
        const width = box ? box.right - box.left : levelExtent(resource.desc.Width, level);
        const height = box
            ? box.bottom - box.top
            : resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE1D
                ? 1
                : levelExtent(resource.desc.Height, level);
        const depth = box
            ? box.back - box.front
            : resource.dimension === D3D10_RESOURCE_DIMENSION.TEXTURE3D
                ? levelExtent(resource.desc.Depth, level)
                : 1;
        return updateSpan(formatPitch(resource.desc.Format, width, height), depth, rowPitch,
            depthPitch);
    };

    /** @param {number} address @param {number} count */
    const readViewports = (address, count)=>{
        /** @type {object[]} */
        const viewports = [];
        for (let index = 0; index < count; index++)
        {
            const raw = fields.readStruct(address + index * D3D10_VIEWPORT.SIZE, D3D10_VIEWPORT,
                ['MinDepth', 'MaxDepth']);
            viewports.push({ ...raw, TopLeftX: raw.TopLeftX | 0, TopLeftY: raw.TopLeftY | 0 });
        }
        return viewports;
    };

    /** @param {number} address @param {number} count */
    const readRects = (address, count)=>{
        /** @type {object[]} */
        const rects = [];
        for (let index = 0; index < count; index++)
        {
            const raw = fields.readStruct(address + index * RECT.SIZE, RECT);
            rects.push({
                left: raw.left | 0, top: raw.top | 0, right: raw.right | 0, bottom: raw.bottom | 0,
            });
        }
        return rects;
    };

    // --- the device ---

    /**
     * The `Set`/`Get` families of a stage, which differ only in the method
     * name and the interface the objects are handed back as.
     *
     * @param {'VS' | 'GS' | 'PS'} stage
     */
    const stageMethods = stage=>({
        /** @param {any} device @param {number[]} args */
        [`${stage}SetConstantBuffers`]: (device, [start, count, buffers])=>{
            device[`${stage}SetConstantBuffers`](start >>> 0, readObjects(buffers, count >>> 0));
        },
        /** @param {any} device @param {number[]} args */
        [`${stage}GetConstantBuffers`]: (device, [start, count, out])=>{
            /** @type {{ buffers?: any[] }} */
            const held = {};
            device[`${stage}GetConstantBuffers`](start >>> 0, count >>> 0, held);
            writeObjects(out, held.buffers ?? [], bufferInterfaces, IID.ID3D10Buffer);
        },
        /** @param {any} device @param {number[]} args */
        [`${stage}SetShaderResources`]: (device, [start, count, views])=>{
            device[`${stage}SetShaderResources`](start >>> 0, readObjects(views, count >>> 0));
        },
        /** @param {any} device @param {number[]} args */
        [`${stage}GetShaderResources`]: (device, [start, count, out])=>{
            /** @type {{ views?: any[] }} */
            const held = {};
            device[`${stage}GetShaderResources`](start >>> 0, count >>> 0, held);
            writeObjects(out, held.views ?? [], shaderResourceViewInterfaces,
                IID.ID3D10ShaderResourceView);
        },
        /** @param {any} device @param {number[]} args */
        [`${stage}SetSamplers`]: (device, [start, count, samplers])=>{
            device[`${stage}SetSamplers`](start >>> 0, readObjects(samplers, count >>> 0));
        },
        /** @param {any} device @param {number[]} args */
        [`${stage}GetSamplers`]: (device, [start, count, out])=>{
            /** @type {{ samplers?: any[] }} */
            const held = {};
            device[`${stage}GetSamplers`](start >>> 0, count >>> 0, held);
            writeObjects(out, held.samplers ?? [], samplerStateInterfaces, IID.ID3D10SamplerState);
        },
        /** @param {any} device @param {number[]} args */
        [`${stage}SetShader`]: (device, [shader])=>{
            device[`${stage}SetShader`](publisher.objectAt(shader));
        },
        /** @param {any} device @param {number[]} args */
        [`${stage}GetShader`]: (device, [out])=>{
            /** @type {{ shader?: any }} */
            const held = {};
            device[`${stage}GetShader`](held);
            const [interfaces, id] = stage === 'VS'
                ? [vertexShaderInterfaces, IID.ID3D10VertexShader]
                : stage === 'GS'
                    ? [geometryShaderInterfaces, IID.ID3D10GeometryShader]
                    : [pixelShaderInterfaces, IID.ID3D10PixelShader];
            writeObjects(out, [held.shader ?? null], interfaces, id);
        },
    });

    /**
     * A create that reads a description, makes an object and hands it back.
     *
     * @param {string} method
     * @param {(descAt: number) => any} read
     * @param {import('./com.js').InterfaceDescriptor[]} interfaces
     * @param {string} id
     * @param {string} key  The out record's field.
     */
    const stateCreate = (method, read, interfaces, id, key)=>
        /** @param {any} device @param {number[]} args */
        (device, [descAt, out])=>{
            /** @type {Record<string, any>} */
            const held = {};
            const hr = device[method]((descAt >>> 0) === 0 ? null : read(descAt), held);
            if (hr !== S_OK)
            {
                if ((out >>> 0) !== 0)
                {
                    fields.writeU32(out, 0);
                }
                return hr;
            }
            return handBack(held[key], interfaces, id, out);
        };

    /**
     * @param {string} method
     * @param {import('./com.js').InterfaceDescriptor[]} interfaces
     * @param {string} id
     * @param {import('../d3d10/structs.js').ViewUnion} union  How its description is laid out.
     */
    const viewCreate = (method, interfaces, id, union)=>
        /** @param {any} device @param {number[]} args */
        (device, [resourcePointer, descAt, out])=>{
            /** @type {{ view?: any }} */
            const held = {};
            const hr = device[method](publisher.objectAt(resourcePointer),
                readViewDescAt(descAt, union), held);
            if (hr !== S_OK)
            {
                if ((out >>> 0) !== 0)
                {
                    fields.writeU32(out, 0);
                }
                return hr;
            }
            return handBack(held.view, interfaces, id, out);
        };

    /**
     * @param {string} method
     * @param {number} dimension
     * @param {(descAt: number) => any} read
     */
    const textureCreate = (method, dimension, read)=>
        /** @param {any} device @param {number[]} args */
        (device, [descAt, dataAt, out])=>{
            const desc = (descAt >>> 0) === 0 ? null : read(descAt);
            /** @type {{ resource?: any }} */
            const held = {};
            const hr = device[method](desc, desc ? readInitialData(dataAt, desc, dimension) : null,
                held);
            if (hr !== S_OK)
            {
                if ((out >>> 0) !== 0)
                {
                    fields.writeU32(out, 0);
                }
                return hr;
            }
            const [interfaces, id] = resourceInterfaces(held.resource);
            return handBack(held.resource, interfaces, id, out);
        };

    /**
     * A device's object over a shared texture, handed back as the interface
     * asked for: by a legacy handle (`OpenSharedResource`) or by the key an
     * NT handle names (`OpenSharedResource1`).
     *
     * @param {any} device @param {string} method @param {number | null} key
     * @param {number} iid @param {number} out
     * @returns {number}
     */
    const openShared = (device, method, key, iid, out)=>{
        if ((out >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        fields.writeU32(out, 0);
        /** @type {{ resource?: any }} */
        const held = {};
        const hr = key === null ? E_INVALIDARG : device[method](key, held);
        if (hr !== S_OK)
        {
            return hr;
        }
        const id = readGuid(memory, iid);
        if (!held.resource.supports(id))
        {
            held.resource.release();
            return E_NOINTERFACE;
        }
        return handBack(held.resource, resourceInterfaces(held.resource)[0], id, out);
    };

    /**
     * @param {string} method
     * @param {import('./com.js').InterfaceDescriptor[]} interfaces
     * @param {string} id
     */
    const shaderCreate = (method, interfaces, id)=>
        /** @param {any} device @param {number[]} args */
        (device, [bytecode, length, out])=>{
            /** @type {{ shader?: any }} */
            const held = {};
            const bytes = (bytecode >>> 0) === 0
                ? null
                : memory.readMemory(bytecode >>> 0, length >>> 0);
            const hr = device[method](bytes, held);
            if (hr !== S_OK)
            {
                if ((out >>> 0) !== 0)
                {
                    fields.writeU32(out, 0);
                }
                return hr;
            }
            return handBack(held.shader, interfaces, id, out);
        };

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const deviceInterfaces = [
        ...describeAll([
            [IID.ID3D10Device, ID3D10DEVICE_SLOTS], [IID.ID3D10Device1, ID3D10DEVICE1_SLOTS],
        ], {
            ...stageMethods('VS'),
            ...stageMethods('GS'),
            ...stageMethods('PS'),

            /** @param {any} device @param {number[]} args */
            DrawIndexed: (device, [count, start, base])=>{
                device.DrawIndexed(count >>> 0, start >>> 0, base | 0);
            },
            /** @param {any} device @param {number[]} args */
            Draw: (device, [count, start])=>{
                device.Draw(count >>> 0, start >>> 0);
            },
            /** @param {any} device @param {number[]} args */
            DrawIndexedInstanced: (device, [count, instances, start, base, firstInstance])=>{
                device.DrawIndexedInstanced(count >>> 0, instances >>> 0, start >>> 0, base | 0,
                    firstInstance >>> 0);
            },
            /** @param {any} device @param {number[]} args */
            DrawInstanced: (device, [count, instances, start, firstInstance])=>{
                device.DrawInstanced(count >>> 0, instances >>> 0, start >>> 0,
                    firstInstance >>> 0);
            },
            /** @param {any} device */
            DrawAuto: device=>{
                device.DrawAuto();
            },

            /** @param {any} device @param {number[]} args */
            IASetInputLayout: (device, [layout])=>{
                device.IASetInputLayout(publisher.objectAt(layout));
            },
            /** @param {any} device @param {number[]} args */
            IAGetInputLayout: (device, [out])=>{
                /** @type {{ layout?: any }} */
                const held = {};
                device.IAGetInputLayout(held);
                writeObjects(out, [held.layout ?? null], inputLayoutInterfaces,
                    IID.ID3D10InputLayout);
            },
            /** @param {any} device @param {number[]} args */
            IASetVertexBuffers: (device, [start, count, buffers, strides, offsets])=>{
                device.IASetVertexBuffers(start >>> 0, readObjects(buffers, count >>> 0),
                    readDwords(strides, count >>> 0), readDwords(offsets, count >>> 0));
            },
            /** @param {any} device @param {number[]} args */
            IAGetVertexBuffers: (device, [start, count, buffers, strides, offsets])=>{
                /** @type {{ buffers?: any[], strides?: number[], offsets?: number[] }} */
                const held = {};
                device.IAGetVertexBuffers(start >>> 0, count >>> 0, held);
                writeObjects(buffers, held.buffers ?? [], bufferInterfaces, IID.ID3D10Buffer);
                (held.strides ?? []).forEach((stride, index)=>{
                    if ((strides >>> 0) !== 0)
                    {
                        fields.writeU32(strides + index * 4, stride);
                    }
                    if ((offsets >>> 0) !== 0)
                    {
                        fields.writeU32(offsets + index * 4, (held.offsets ?? [])[index] ?? 0);
                    }
                });
            },
            /** @param {any} device @param {number[]} args */
            IASetIndexBuffer: (device, [buffer, format, offset])=>{
                device.IASetIndexBuffer(publisher.objectAt(buffer), format >>> 0, offset >>> 0);
            },
            /** @param {any} device @param {number[]} args */
            IAGetIndexBuffer: (device, [out, formatAt, offsetAt])=>{
                /** @type {{ buffer?: any, format?: number, offset?: number }} */
                const held = {};
                device.IAGetIndexBuffer(held);
                writeObjects(out, [held.buffer ?? null], bufferInterfaces, IID.ID3D10Buffer);
                if ((formatAt >>> 0) !== 0)
                {
                    fields.writeU32(formatAt, held.format ?? 0);
                }
                if ((offsetAt >>> 0) !== 0)
                {
                    fields.writeU32(offsetAt, held.offset ?? 0);
                }
            },
            /** @param {any} device @param {number[]} args */
            IASetPrimitiveTopology: (device, [topology])=>{
                device.IASetPrimitiveTopology(topology >>> 0);
            },
            /** @param {any} device @param {number[]} args */
            IAGetPrimitiveTopology: (device, [out])=>{
                /** @type {{ topology?: number }} */
                const held = {};
                device.IAGetPrimitiveTopology(held);
                fields.writeU32(out, held.topology ?? 0);
            },

            /** @param {any} device @param {number[]} args */
            SetPredication: (device, [predicate, value])=>{
                device.SetPredication(publisher.objectAt(predicate), value !== 0);
            },
            /** @param {any} device @param {number[]} args */
            GetPredication: (device, [out, valueAt])=>{
                /** @type {{ predicate?: any, value?: boolean }} */
                const held = {};
                device.GetPredication(held);
                writeObjects(out, [held.predicate ?? null], queryDescriptors, IID.ID3D10Predicate);
                if ((valueAt >>> 0) !== 0)
                {
                    fields.writeU32(valueAt, held.value ? 1 : 0);
                }
            },

            /** @param {any} device @param {number[]} args */
            OMSetRenderTargets: (device, [count, views, depth])=>{
                device.OMSetRenderTargets(readObjects(views, count >>> 0),
                    publisher.objectAt(depth));
            },
            /** @param {any} device @param {number[]} args */
            OMGetRenderTargets: (device, [count, views, depth])=>{
                /** @type {{ views?: any[], depthStencilView?: any }} */
                const held = {};
                device.OMGetRenderTargets(count >>> 0, held);
                writeObjects(views, held.views ?? [], renderTargetViewInterfaces,
                    IID.ID3D10RenderTargetView);
                writeObjects(depth, [held.depthStencilView ?? null], depthStencilViewInterfaces,
                    IID.ID3D10DepthStencilView);
            },
            /** @param {any} device @param {number[]} args */
            OMSetBlendState: (device, [state, factorAt, mask])=>{
                device.OMSetBlendState(publisher.objectAt(state),
                    (factorAt >>> 0) === 0 ? null : readFloats(factorAt, 4), mask >>> 0);
            },
            /** @param {any} device @param {number[]} args */
            OMGetBlendState: (device, [out, factorAt, maskAt])=>{
                /** @type {{ state?: any, blendFactor?: number[], sampleMask?: number }} */
                const held = {};
                device.OMGetBlendState(held);
                writeObjects(out, [held.state ?? null], blendStateInterfaces, IID.ID3D10BlendState);
                if ((factorAt >>> 0) !== 0)
                {
                    (held.blendFactor ?? []).forEach((value, index)=>{
                        fields.writeF32(factorAt + index * 4, value);
                    });
                }
                if ((maskAt >>> 0) !== 0)
                {
                    fields.writeU32(maskAt, held.sampleMask ?? 0);
                }
            },
            /** @param {any} device @param {number[]} args */
            OMSetDepthStencilState: (device, [state, reference])=>{
                device.OMSetDepthStencilState(publisher.objectAt(state), reference >>> 0);
            },
            /** @param {any} device @param {number[]} args */
            OMGetDepthStencilState: (device, [out, referenceAt])=>{
                /** @type {{ state?: any, stencilRef?: number }} */
                const held = {};
                device.OMGetDepthStencilState(held);
                writeObjects(out, [held.state ?? null], depthStencilStateInterfaces,
                    IID.ID3D10DepthStencilState);
                if ((referenceAt >>> 0) !== 0)
                {
                    fields.writeU32(referenceAt, held.stencilRef ?? 0);
                }
            },
            /** @param {any} device @param {number[]} args */
            SOSetTargets: (device, [count, buffers, offsets])=>{
                device.SOSetTargets(readObjects(buffers, count >>> 0),
                    readDwords(offsets, count >>> 0));
            },
            /** @param {any} device @param {number[]} args */
            SOGetTargets: (device, [count, buffers, offsets])=>{
                /** @type {{ buffers?: any[], offsets?: number[] }} */
                const held = {};
                device.SOGetTargets(count >>> 0, held);
                writeObjects(buffers, held.buffers ?? [], bufferInterfaces, IID.ID3D10Buffer);
                if ((offsets >>> 0) !== 0)
                {
                    (held.offsets ?? []).forEach((offset, index)=>{
                        fields.writeU32(offsets + index * 4, offset);
                    });
                }
            },

            /** @param {any} device @param {number[]} args */
            RSSetState: (device, [state])=>{
                device.RSSetState(publisher.objectAt(state));
            },
            /** @param {any} device @param {number[]} args */
            RSGetState: (device, [out])=>{
                /** @type {{ state?: any }} */
                const held = {};
                device.RSGetState(held);
                writeObjects(out, [held.state ?? null], rasterizerStateInterfaces,
                    IID.ID3D10RasterizerState);
            },
            /** @param {any} device @param {number[]} args */
            RSSetViewports: (device, [count, viewports])=>{
                // More than the pipeline has slots for is a call ignored
                // whole, so there is nothing to read.
                if ((count >>> 0) > D3D10_LIMITS.VIEWPORT_AND_SCISSOR_SLOTS)
                {
                    return;
                }
                device.RSSetViewports(readViewports(viewports, count >>> 0));
            },
            /**
             * A null array asks how many there are. Otherwise the count is
             * what the caller has room for: every slot of that room is
             * written, those past the bound viewports with zeroes, and the
             * count comes back as the number bound.
             *
             * @param {any} device @param {number[]} args
             */
            RSGetViewports: (device, [countAt, out])=>{
                /** @type {{ count?: number, viewports?: any[] }} */
                const held = {};
                device.RSGetViewports(held);
                const room = fields.readU32(countAt);
                if ((out >>> 0) === 0)
                {
                    fields.writeU32(countAt, held.count ?? 0);
                    return;
                }
                const bound = (held.viewports ?? []).slice(0, room);
                bound.forEach((viewport, index)=>{
                    fields.writeStruct(out + index * D3D10_VIEWPORT.SIZE, D3D10_VIEWPORT,
                        viewport, ['MinDepth', 'MaxDepth']);
                });
                memory.writeMemory(out + bound.length * D3D10_VIEWPORT.SIZE,
                    new Uint8Array((Math.min(room, D3D10_LIMITS.VIEWPORT_AND_SCISSOR_SLOTS)
                        - Math.min(bound.length, room)) * D3D10_VIEWPORT.SIZE));
                fields.writeU32(countAt, bound.length);
            },
            /** @param {any} device @param {number[]} args */
            RSSetScissorRects: (device, [count, rects])=>{
                device.RSSetScissorRects(readRects(rects, count >>> 0));
            },
            /** @param {any} device @param {number[]} args */
            RSGetScissorRects: (device, [countAt, out])=>{
                /** @type {{ count?: number, rects?: any[] }} */
                const held = {};
                device.RSGetScissorRects(held);
                const room = fields.readU32(countAt);
                if ((out >>> 0) === 0)
                {
                    fields.writeU32(countAt, held.count ?? 0);
                    return;
                }
                const bound = (held.rects ?? []).slice(0, room);
                bound.forEach((rect, index)=>{
                    fields.writeStruct(out + index * RECT.SIZE, RECT, rect);
                });
                memory.writeMemory(out + bound.length * RECT.SIZE,
                    new Uint8Array((Math.min(room, D3D10_LIMITS.VIEWPORT_AND_SCISSOR_SLOTS)
                        - Math.min(bound.length, room)) * RECT.SIZE));
                fields.writeU32(countAt, bound.length);
            },

            /** @param {any} device @param {number[]} args */
            CopySubresourceRegion: (device, [dst, dstSub, x, y, z, src, srcSub, box])=>{
                device.CopySubresourceRegion(publisher.objectAt(dst), dstSub >>> 0, x >>> 0,
                    y >>> 0, z >>> 0, publisher.objectAt(src), srcSub >>> 0, readBox(box));
            },
            /** @param {any} device @param {number[]} args */
            CopyResource: (device, [dst, src])=>{
                device.CopyResource(publisher.objectAt(dst), publisher.objectAt(src));
            },
            /**
             * The bytes are read out of the guest whole: the box says how many,
             * or the subresource does when there is no box.
             *
             * @param {any} device @param {number[]} args
             */
            UpdateSubresource: (device, [dst, subresource, boxAt, data, rowPitch, depthPitch])=>{
                const resource = publisher.objectAt(dst);
                if (!resource || (data >>> 0) === 0)
                {
                    return;
                }
                const box = readBox(boxAt);
                const bytes = updateBytesOf(resource, subresource >>> 0, box, rowPitch >>> 0,
                    depthPitch >>> 0);
                if (bytes <= 0)
                {
                    return;
                }
                device.UpdateSubresource(resource, subresource >>> 0, box,
                    memory.readMemory(data >>> 0, bytes), rowPitch >>> 0, depthPitch >>> 0);
            },
            /** @param {any} device @param {number[]} args */
            ClearRenderTargetView: (device, [view, colorAt])=>{
                device.ClearRenderTargetView(publisher.objectAt(view),
                    (colorAt >>> 0) === 0 ? null : readFloats(colorAt, 4));
            },
            /** @param {any} device @param {number[]} args */
            ClearDepthStencilView: (device, [view, flags, depth, stencil])=>{
                device.ClearDepthStencilView(publisher.objectAt(view), flags >>> 0,
                    fields.asFloat(depth), stencil & 0xff);
            },
            /** @param {any} device @param {number[]} args */
            GenerateMips: (device, [view])=>{
                device.GenerateMips(publisher.objectAt(view));
            },
            /** @param {any} device @param {number[]} args */
            ResolveSubresource: (device, [dst, dstSub, src, srcSub, format])=>{
                device.ResolveSubresource(publisher.objectAt(dst), dstSub >>> 0,
                    publisher.objectAt(src), srcSub >>> 0, format >>> 0);
            },

            /** @param {any} device */
            GetDeviceRemovedReason: device=>device.GetDeviceRemovedReason(),
            /** @param {any} device @param {number[]} args */
            SetExceptionMode: (device, [flags])=>device.SetExceptionMode(flags >>> 0),
            /** @param {any} device */
            GetExceptionMode: device=>device.GetExceptionMode(),
            ...privateDataMethods,
            /** @param {any} device */
            ClearState: device=>{
                device.ClearState();
            },
            /** @param {any} device */
            Flush: device=>{
                device.Flush();
            },

            /** @param {any} device @param {number[]} args */
            CreateBuffer: (device, [descAt, dataAt, out])=>{
                const desc = (descAt >>> 0) === 0
                    ? null
                    : fields.readStruct(descAt, D3D10_BUFFER_DESC);
                /** @type {{ resource?: any }} */
                const held = {};
                const hr = device.CreateBuffer(desc,
                    desc ? readInitialData(dataAt, desc, D3D10_RESOURCE_DIMENSION.BUFFER) : null,
                    held);
                if (hr !== S_OK)
                {
                    if ((out >>> 0) !== 0)
                    {
                        fields.writeU32(out, 0);
                    }
                    return hr;
                }
                attachBuffer(device, held.resource);
                return handBack(held.resource, bufferInterfaces, IID.ID3D10Buffer, out);
            },
            CreateTexture1D: textureCreate('CreateTexture1D', D3D10_RESOURCE_DIMENSION.TEXTURE1D,
                address=>fields.readStruct(address, D3D10_TEXTURE1D_DESC)),
            CreateTexture2D: textureCreate('CreateTexture2D', D3D10_RESOURCE_DIMENSION.TEXTURE2D,
                readTexture2DDesc),
            CreateTexture3D: textureCreate('CreateTexture3D', D3D10_RESOURCE_DIMENSION.TEXTURE3D,
                address=>fields.readStruct(address, D3D10_TEXTURE3D_DESC)),
            CreateShaderResourceView: viewCreate('CreateShaderResourceView',
                shaderResourceViewInterfaces, IID.ID3D10ShaderResourceView,
                VIEW_UNION.SHADER_RESOURCE),
            CreateRenderTargetView: viewCreate('CreateRenderTargetView',
                renderTargetViewInterfaces, IID.ID3D10RenderTargetView,
                VIEW_UNION.RENDER_TARGET),
            CreateDepthStencilView: viewCreate('CreateDepthStencilView',
                depthStencilViewInterfaces, IID.ID3D10DepthStencilView,
                VIEW_UNION.DEPTH_STENCIL),
            /** @param {any} device @param {number[]} args */
            CreateInputLayout: (device, [elements, count, bytecode, length, out])=>{
                /** @type {{ layout?: any }} */
                const held = {};
                const hr = device.CreateInputLayout(readInputElements(elements, count >>> 0),
                    (bytecode >>> 0) === 0 ? null : memory.readMemory(bytecode >>> 0, length >>> 0),
                    held);
                if (hr !== S_OK)
                {
                    if ((out >>> 0) !== 0)
                    {
                        fields.writeU32(out, 0);
                    }
                    return hr;
                }
                return handBack(held.layout, inputLayoutInterfaces, IID.ID3D10InputLayout, out);
            },
            CreateVertexShader: shaderCreate('CreateVertexShader', vertexShaderInterfaces,
                IID.ID3D10VertexShader),
            CreateGeometryShader: shaderCreate('CreateGeometryShader', geometryShaderInterfaces,
                IID.ID3D10GeometryShader),
            /** @param {any} device @param {number[]} args */
            CreateGeometryShaderWithStreamOutput: (device,
                [code, length, declarationAt, count, stride, out])=>
            {
                /** @type {{ shader?: any }} */
                const held = {};
                const hr = device.CreateGeometryShaderWithStreamOutput(
                    (code >>> 0) === 0 ? null : memory.readMemory(code >>> 0, length >>> 0),
                    readStreamOutput(declarationAt, count, false),
                    stride >>> 0 ? [stride >>> 0] : null, 0, held);
                if (hr !== S_OK)
                {
                    if ((out >>> 0) !== 0)
                    {
                        fields.writeU32(out, 0);
                    }
                    return hr;
                }
                return handBack(held.shader, geometryShaderInterfaces, IID.ID3D10GeometryShader,
                    out);
            },
            CreatePixelShader: shaderCreate('CreatePixelShader', pixelShaderInterfaces,
                IID.ID3D10PixelShader),
            CreateBlendState: stateCreate('CreateBlendState', readBlendDesc, blendStateInterfaces,
                IID.ID3D10BlendState, 'state'),
            CreateBlendState1: stateCreate('CreateBlendState1', readBlendDesc1,
                blendStateInterfaces, IID.ID3D10BlendState1, 'state'),
            CreateShaderResourceView1: viewCreate('CreateShaderResourceView1',
                shaderResourceViewInterfaces, IID.ID3D10ShaderResourceView1,
                VIEW_UNION.SHADER_RESOURCE1),
            /** @param {any} device */
            GetFeatureLevel: device=>device.GetFeatureLevel(),
            CreateDepthStencilState: stateCreate('CreateDepthStencilState', readDepthStencilDesc,
                depthStencilStateInterfaces, IID.ID3D10DepthStencilState, 'state'),
            CreateRasterizerState: stateCreate('CreateRasterizerState', readRasterizerDesc,
                rasterizerStateInterfaces, IID.ID3D10RasterizerState, 'state'),
            CreateSamplerState: stateCreate('CreateSamplerState', readSamplerDesc,
                samplerStateInterfaces, IID.ID3D10SamplerState, 'state'),
            /** @param {any} device @param {number[]} args */
            CreateQuery: (device, [descAt, out])=>{
                /** @type {{ query?: any }} */
                const held = {};
                const hr = device.CreateQuery(
                    (descAt >>> 0) === 0 ? null : fields.readStruct(descAt, D3D10_QUERY_DESC),
                    (out >>> 0) === 0 ? null : held);
                if (hr !== S_OK)
                {
                    if ((out >>> 0) !== 0)
                    {
                        fields.writeU32(out, 0);
                    }
                    return hr;
                }
                return handBack(held.query, queryDescriptors, IID.ID3D10Query, out);
            },
            /** @param {any} device @param {number[]} args */
            CreatePredicate: (device, [descAt, out])=>{
                /** @type {{ query?: any }} */
                const held = {};
                const hr = device.CreatePredicate(
                    (descAt >>> 0) === 0 ? null : fields.readStruct(descAt, D3D10_QUERY_DESC),
                    (out >>> 0) === 0 ? null : held);
                if (hr !== S_OK)
                {
                    if ((out >>> 0) !== 0)
                    {
                        fields.writeU32(out, 0);
                    }
                    return hr;
                }
                return handBack(held.query, queryDescriptors, IID.ID3D10Predicate, out);
            },
            /** @param {any} device @param {number[]} args */
            CreateCounter: (device, [descAt, out])=>{
                if ((out >>> 0) !== 0)
                {
                    fields.writeU32(out, 0);
                }
                return device.CreateCounter((descAt >>> 0) === 0 ? null : {}, null);
            },
            /** @param {any} device @param {number[]} args */
            CheckFormatSupport: (device, [format, out])=>{
                /** @type {{ support?: number }} */
                const held = {};
                const hr = device.CheckFormatSupport(format >>> 0, (out >>> 0) === 0 ? null : held);
                if ((out >>> 0) !== 0)
                {
                    fields.writeU32(out, held.support ?? 0);
                }
                return hr;
            },
            /** @param {any} device @param {number[]} args */
            CheckMultisampleQualityLevels: (device, [format, count, out])=>{
                /** @type {{ levels?: number }} */
                const held = {};
                const hr = device.CheckMultisampleQualityLevels(format >>> 0, count >>> 0,
                    (out >>> 0) === 0 ? null : held);
                // A count out of range fails and still writes its zero; an
                // unknown format fails and writes nothing.
                if (held.levels !== undefined)
                {
                    fields.writeU32(out, held.levels);
                }
                return hr;
            },
            /** @param {any} device @param {number[]} args */
            CheckCounterInfo: (device, [out])=>{
                if ((out >>> 0) !== 0)
                {
                    fields.writeU32(out, 0);
                    fields.writeU32(out + 4, 0);
                    fields.writeU32(out + 8, 1);
                }
            },
            /** @param {any} device */
            CheckCounter: device=>device.CheckCounter(),
            /** @param {any} device */
            GetCreationFlags: device=>device.GetCreationFlags(),
            /** @param {any} device @param {number[]} args */
            OpenSharedResource: (device, [handle, iid, out])=>
                openShared(device, 'OpenSharedResource', handle >>> 0, iid, out),
            /** @param {any} device @param {number[]} args */
            SetTextFilterSize: (device, [width, height])=>{
                device.SetTextFilterSize(width >>> 0, height >>> 0);
            },
            /** @param {any} device @param {number[]} args */
            GetTextFilterSize: (device, [widthAt, heightAt])=>{
                /** @type {{ width?: number, height?: number }} */
                const held = {};
                device.GetTextFilterSize(held);
                if ((widthAt >>> 0) !== 0)
                {
                    fields.writeU32(widthAt, held.width ?? 0);
                }
                if ((heightAt >>> 0) !== 0)
                {
                    fields.writeU32(heightAt, held.height ?? 0);
                }
            },
        }, ringGuests),

        // The same object answers as a DXGI device: what a program asks the
        // adapter through.
        ...describeAll([
            [IID.IDXGIDevice, IDXGIDEVICE_SLOTS], [IID.IDXGIDevice1, IDXGIDEVICE1_SLOTS],
            [IID.IDXGIDevice2, IDXGIDEVICE2_SLOTS], [IID.IDXGIDevice3, IDXGIDEVICE3_SLOTS],
            [IID.IDXGIDevice4, IDXGIDEVICE4_SLOTS], [IID.IDXGIObject, IDXGIOBJECT_SLOTS],
        ], {
            // Nothing is evicted, so an offered resource is never discarded:
            // what a program reclaims has its contents.
            OfferResources: ()=>S_OK,
            /** @param {any} device @param {number[]} args */
            ReclaimResources: (device, [count, , discardedAt])=>{
                const reclaimed = (discardedAt >>> 0) === 0 ? 0 : count >>> 0;
                for (let index = 0; index < reclaimed; index++)
                {
                    fields.writeU32(discardedAt + index * 4, 0);
                }
                return S_OK;
            },
            OfferResources1: ()=>S_OK,
            /** @param {any} device @param {number[]} args */
            ReclaimResources1: (device, [count, , resultsAt])=>{
                const reclaimed = (resultsAt >>> 0) === 0 ? 0 : count >>> 0;
                for (let index = 0; index < reclaimed; index++)
                {
                    fields.writeU32(resultsAt + index * 4, 0);
                }
                return S_OK;
            },
            /**
             * The event is set once the GPU has run what was handed to it.
             *
             * @param {any} device @param {number[]} args
             */
            EnqueueSetEvent: (device, [event])=>{
                if ((event >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                device.Flush?.();
                Promise.resolve(device.idle?.()).then(()=>setEvent?.(event >>> 0));
                return S_OK;
            },
            // Nothing temporary is kept that a trim would give back.
            Trim: ()=>{},
            ...privateDataMethods,
            GetParent: getParent,
            /** @param {any} device @param {number[]} args */
            GetAdapter: (device, [out])=>{
                const adapter = device.adapter();
                adapter.addRef();
                return handBack(adapter, adapterInterfaces, IID.IDXGIAdapter, out);
            },
            /**
             * Surfaces are two-dimensional textures of one level, bound as
             * the usage word says, handed back as IDXGISurface.
             *
             * @param {any} device @param {number[]} args
             */
            CreateSurface: (device, [descAt, count, usage, , out])=>{
                if ((descAt >>> 0) === 0 || (out >>> 0) === 0 || (count >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const desc = fields.readStruct(descAt, DXGI_SURFACE_DESC);
                /** @type {any[]} */
                const made = [];
                for (let index = 0; index < (count >>> 0); index++)
                {
                    /** @type {{ resource?: any }} */
                    const held = {};
                    const hr = device.CreateTexture2D({
                        Width: desc.Width, Height: desc.Height, MipLevels: 1, ArraySize: 1,
                        Format: desc.Format,
                        SampleDesc: { Count: desc.SampleCount, Quality: desc.SampleQuality },
                        Usage: 0, BindFlags: bindFlagsForUsage(usage >>> 0),
                        CPUAccessFlags: 0, MiscFlags: 0,
                    }, null, held);
                    if (hr !== S_OK)
                    {
                        made.forEach(surface=>surface.release());
                        fields.writeU32(out, 0);
                        return hr;
                    }
                    made.push(held.resource);
                }
                made.forEach((surface, index)=>{
                    fields.writeU32(out + index * 4, publisher.publish(surface,
                        texture2DInterfaces, IID.IDXGISurface));
                });
                return S_OK;
            },
            /**
             * Everything is where the GPU can reach it: nothing is evicted.
             *
             * @param {any} device @param {number[]} args
             */
            QueryResourceResidency: (device, [, statusAt, count])=>{
                if ((statusAt >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                for (let index = 0; index < (count >>> 0); index++)
                {
                    fields.writeU32(statusAt + index * 4, DXGI_RESIDENCY_FULLY_RESIDENT);
                }
                return S_OK;
            },
            SetGPUThreadPriority: ()=>S_OK,
            /** @param {any} device @param {number[]} args */
            GetGPUThreadPriority: (device, [out])=>{
                fields.writeU32(out, 0);
                return S_OK;
            },
            /** @param {any} device @param {number[]} args */
            SetMaximumFrameLatency: (device, [latency])=>
                device.SetMaximumFrameLatency(latency >>> 0),
            /** @param {any} device @param {number[]} args */
            GetMaximumFrameLatency: (device, [out])=>{
                /** @type {{ latency?: number }} */
                const held = {};
                const hr = device.GetMaximumFrameLatency((out >>> 0) === 0 ? null : held);
                if (hr === S_OK)
                {
                    fields.writeU32(out, held.latency ?? 0);
                }
                return hr;
            },
        }),
        describe(IID.ID3D10Multithread, ID3D10MULTITHREAD_SLOTS, {
            /** @param {any} device */
            Enter: device=>{
                device.Enter();
            },
            /** @param {any} device */
            Leave: device=>{
                device.Leave();
            },
            /** @param {any} device @param {number[]} args */
            SetMultithreadProtected: (device, [enable])=>
                (device.SetMultithreadProtected(enable !== 0) ? 1 : 0),
            /** @param {any} device */
            GetMultithreadProtected: device=>(device.GetMultithreadProtected() ? 1 : 0),
        }),
        // Direct3D 11's device: the same object, created by either version.
        ...eleven.faces.device,
    ];

    /** What Direct3D 11's half of the seam reads of this one, when its calls run. */
    /** @type {import('./d3d11.js').Direct3D11Kit} */
    const kit = {
        publisher, memory, fields, handBack, writeObjects, readObjects, readDwords, readFloats,
        pointerSize, writePointer, privateDataMethods, readInitialData, readTexture2DDesc,
        readStreamOutput,
        readTexture1DDesc: address=>fields.readStruct(address, D3D10_TEXTURE1D_DESC),
        readTexture3DDesc: address=>fields.readStruct(address, D3D10_TEXTURE3D_DESC),
        writeTextureDesc: (texture, out)=>{
            switch (texture.dimension)
            {
                case D3D10_RESOURCE_DIMENSION.TEXTURE1D:
                    fields.writeStruct(out, D3D10_TEXTURE1D_DESC, texture.desc);
                    break;
                case D3D10_RESOURCE_DIMENSION.TEXTURE3D:
                    fields.writeStruct(out, D3D10_TEXTURE3D_DESC, texture.desc);
                    break;
                default:
                    fields.writeStruct(out, D3D10_TEXTURE2D_DESC, {
                        ...texture.desc,
                        SampleCount: texture.desc.SampleDesc.Count,
                        SampleQuality: texture.desc.SampleDesc.Quality,
                    });
            }
        },
        readBox, updateBytesOf, readInputElements, readRects, readBlendDesc1,
        readDepthStencilDesc, readRasterizerDesc, readSamplerDesc, writeBlendDesc1,
        writeDepthStencilDesc, writeRasterizerDesc, writeSamplerDesc,
        readQueryDesc: address=>fields.readStruct(address, D3D10_QUERY_DESC),
        writeQueryDesc: (desc, out)=>{
            fields.writeStruct(out, D3D10_QUERY_DESC, desc);
        },
        mapInto, unmapFrom, whenMappable, ringOf, countUnattached, attachRing, attachBuffer,
        created: device=>{
            created.push(device);
        },
        pairSwapChain: (swapChain, device)=>{
            swapChainDevices.set(swapChain, device);
        },
        readSwapChainDesc: address=>sized(readSwapChainDesc(memory, address, pointerSize)),
        root,
        floatResult,
        diverge: detail=>divergence?.('Direct3D 11', detail),
        lose: detail=>divergence?.('Direct3D 11', `lost: ${detail}`, 'loss'),
        allocate,
        free,
        lists: {
            device: deviceInterfaces, buffer: bufferInterfaces,
            srv: shaderResourceViewInterfaces, rtv: renderTargetViewInterfaces,
            dsv: depthStencilViewInterfaces, uav: eleven.lists.uav,
            blend: blendStateInterfaces, depthStencil: depthStencilStateInterfaces,
            rasterizer: rasterizerStateInterfaces, sampler: samplerStateInterfaces,
            vs: vertexShaderInterfaces, hs: eleven.lists.hs, ds: eleven.lists.ds,
            gs: geometryShaderInterfaces, ps: pixelShaderInterfaces, cs: eleven.lists.cs,
            inputLayout: inputLayoutInterfaces, query: queryDescriptors,
            swapChain: swapChainInterfaces,
        },
        resourceInterfaces: resource=>resourceInterfaces(resource)[0],
        openShared,
        /** @param {number} handle @returns {number | null} the key an NT handle names */
        sharedKeyOf: handle=>sharedHandles?.resolve(handle >>> 0) ?? null,
    };

    // --- blobs and reflection ---

    /**
     * The most a program is taken to hand over in one blob. A length beyond
     * it is a caller's garbage rather than a shader, and reading it would
     * take the host down with it.
     */
    const LARGEST_BLOB = 0x10000000;

    /** @param {string} detail */
    const report = detail=>divergence?.('d3d10', detail);

    /**
     * An ID3D10Blob holding these bytes in guest memory, which the program
     * reads and writes through its pointer.
     *
     * @param {Uint8Array} bytes
     * @returns {any} null when there is no memory to give
     */
    const makeBlob = bytes=>{
        const address = allocate ? allocate(Math.max(bytes.length, 4)) : 0;
        if (!address)
        {
            return null;
        }
        memory.writeMemory(address, bytes);
        return createBlob(address, bytes.length, ()=>free?.(address));
    };

    const blobInterfaces = [describe(IID.ID3D10Blob, ID3D10BLOB_SLOTS, {
        /** @param {any} blob */
        GetBufferPointer: blob=>blob.GetBufferPointer(),
        /** @param {any} blob */
        GetBufferSize: blob=>blob.GetBufferSize(),
    })];

    /**
     * @param {number} out
     * @param {Uint8Array | null} bytes
     * @param {number} missing  What to answer when there are no bytes.
     */
    const blobInto = (out, bytes, missing)=>{
        if (!bytes)
        {
            return missing;
        }
        const blob = makeBlob(bytes);
        return blob ? handBack(blob, blobInterfaces, IID.ID3D10Blob, out) : E_OUTOFMEMORY;
    };

    /**
     * A shader the program handed over, or null for a pointer or length that
     * cannot be one.
     *
     * @param {number} data
     * @param {number} size
     */
    const shaderBytes = (data, size)=>((data >>> 0) === 0 || (size >>> 0) === 0
        || (size >>> 0) > LARGEST_BLOB
        ? null
        : memory.readMemory(data >>> 0, size >>> 0));

    /**
     * Where each reflection's copy of its container sits: every name it hands
     * out points into it, so it lives as long as the reflection.
     *
     * @type {WeakMap<any, number>}
     */
    const reflectionCopies = new WeakMap();

    /** @param {any} reflection @param {number} at  An offset into the container. */
    const pointerInto = (reflection, at)=>(at < 0
        ? 0
        : (reflectionCopies.get(reflection) ?? 0) + at);

    /**
     * D3D10_SIGNATURE_PARAMETER_DESC: the name, four dwords, and the two
     * masks as bytes.
     *
     * @param {'GetInputParameterDesc' | 'GetOutputParameterDesc'} method
     */
    const parameterDesc = method=>{
        /** @param {any} reflection @param {number[]} args */
        const write = (reflection, [index, out])=>{
            /** @type {{ entry?: any }} */
            const held = {};
            const hr = reflection[method](index >>> 0, (out >>> 0) === 0 ? null : held);
            if (hr === S_OK)
            {
                const entry = held.entry;
                [pointerInto(reflection, entry.nameAt), entry.index, entry.register,
                    entry.systemValue, entry.componentType,
                    entry.mask | (entry.readWriteMask << 8)]
                    .forEach((value, position)=>fields.writeU32(out + position * 4, value));
            }
            return hr;
        };
        return write;
    };

    /**
     * A description whose `Name` and `DefaultValue` are offsets into the
     * container, written as pointers into its owner's copy of it.
     *
     * @param {readonly string[]} names  The structure's fields in order.
     */
    const describedAs = names=>{
        /** @param {any} object @param {number[]} args */
        const write = (object, [out])=>{
            /** @type {{ desc?: Record<string, number> }} */
            const held = {};
            const hr = object.GetDesc((out >>> 0) === 0 ? null : held);
            if (hr === S_OK && held.desc)
            {
                const desc = held.desc;
                names.forEach((field, index)=>fields.writeU32(out + index * 4,
                    field === 'Name' || field === 'DefaultValue'
                        ? pointerInto(object.owner, desc[field])
                        : desc[field]));
            }
            return hr;
        };
        return write;
    };

    /** A name the program passed, or null for a null pointer. @param {number} address */
    const nameArgument = address=>((address >>> 0) === 0 ? null : readCString(address >>> 0));

    /**
     * The reflection's constant buffers, variables and types, whose tables
     * have no IUnknown. Nothing the program calls ends one: each is given
     * back with the reflection's last Release, with the copy of the
     * container its names point into, as the runtime frees them with it.
     * The invalid object of each kind belongs to no reflection and stays.
     *
     * @param {import('./com.js').InterfaceDescriptor} descriptor
     */
    const bare = descriptor=>({ ...descriptor, bare: true });

    /** @param {any} type @returns {number} */
    const publishType = type=>publisher.publish(type, reflectedTypeInterfaces,
        IID.ID3D10ShaderReflectionType);
    /** @param {any} variable @returns {number} */
    const publishVariable = variable=>publisher.publish(variable, reflectedVariableInterfaces,
        IID.ID3D10ShaderReflectionVariable);
    /** @param {any} buffer @returns {number} */
    const publishBuffer = buffer=>publisher.publish(buffer, reflectedBufferInterfaces,
        IID.ID3D10ShaderReflectionConstantBuffer);

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const reflectedTypeInterfaces = [bare(describe(IID.ID3D10ShaderReflectionType,
        ID3D10SHADERREFLECTIONTYPE_SLOTS, {
            GetDesc: describedAs(SHADER_TYPE_DESC_FIELDS),
            /** @param {any} type @param {number[]} args */
            GetMemberTypeByIndex: (type, [index])=>
                publishType(type.GetMemberTypeByIndex(index >>> 0)),
            /** @param {any} type @param {number[]} args */
            GetMemberTypeByName: (type, [name])=>
                publishType(type.GetMemberTypeByName(nameArgument(name))),
            /** @param {any} type @param {number[]} args */
            GetMemberTypeName: (type, [index])=>{
                const name = type.GetMemberTypeName(index >>> 0);
                if (!name)
                {
                    return 0;
                }
                return 'text' in name
                    ? constantString(name.text)
                    : pointerInto(type.owner, name.at);
            },
        }))];

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const reflectedVariableInterfaces = [bare(describe(IID.ID3D10ShaderReflectionVariable,
        ID3D10SHADERREFLECTIONVARIABLE_SLOTS, {
            GetDesc: describedAs(SHADER_VARIABLE_DESC_FIELDS),
            /** @param {any} variable */
            GetType: variable=>publishType(variable.GetType()),
        }))];

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const reflectedBufferInterfaces = [bare(describe(IID.ID3D10ShaderReflectionConstantBuffer,
        ID3D10SHADERREFLECTIONCONSTANTBUFFER_SLOTS, {
            GetDesc: describedAs(SHADER_BUFFER_DESC_FIELDS),
            /** @param {any} buffer @param {number[]} args */
            GetVariableByIndex: (buffer, [index])=>
                publishVariable(buffer.GetVariableByIndex(index >>> 0)),
            /** @param {any} buffer @param {number[]} args */
            GetVariableByName: (buffer, [name])=>
                publishVariable(buffer.GetVariableByName(nameArgument(name))),
        }))];

    const reflectionInterfaces = [describe(IID.ID3D10ShaderReflection,
        ID3D10SHADERREFLECTION_SLOTS, {
            /** @param {any} reflection @param {number[]} args */
            GetDesc: (reflection, [out])=>{
                /** @type {{ desc?: Record<string, number> }} */
                const held = {};
                const hr = reflection.GetDesc((out >>> 0) === 0 ? null : held);
                if (hr === S_OK && held.desc)
                {
                    const desc = held.desc;
                    SHADER_DESC_FIELDS.forEach((field, index)=>fields.writeU32(out + index * 4,
                        field === 'Creator' ? pointerInto(reflection, desc.Creator) : desc[field]));
                }
                return hr;
            },
            /** @param {any} reflection @param {number[]} args */
            GetConstantBufferByIndex: (reflection, [index])=>
                publishBuffer(reflection.GetConstantBufferByIndex(index >>> 0)),
            /** @param {any} reflection @param {number[]} args */
            GetConstantBufferByName: (reflection, [name])=>
                publishBuffer(reflection.GetConstantBufferByName(nameArgument(name))),
            /**
             * D3D10_SHADER_INPUT_BIND_DESC, whose order is not the order the
             * compiler stored the same fields in.
             *
             * @param {any} reflection @param {number[]} args
             */
            GetResourceBindingDesc: (reflection, [index, out])=>{
                /** @type {{ entry?: any }} */
                const held = {};
                const hr = reflection.GetResourceBindingDesc(index >>> 0,
                    (out >>> 0) === 0 ? null : held);
                if (hr === S_OK)
                {
                    const entry = held.entry;
                    // The flags (a texture's component count) are Direct3D 11's
                    // reflector's: Direct3D 10's answers none (test_reflection_bound_resources).
                    [pointerInto(reflection, entry.nameAt), entry.type, entry.bindPoint,
                        entry.bindCount, 0, entry.returnType, entry.dimension,
                        entry.sampleCount]
                        .forEach((value, position)=>fields.writeU32(out + position * 4, value));
                }
                return hr;
            },
            GetInputParameterDesc: parameterDesc('GetInputParameterDesc'),
            GetOutputParameterDesc: parameterDesc('GetOutputParameterDesc'),
        })];

    /**
     * The runtime's own strings -- the profile names, the invalid type's
     * member name -- live in guest memory for the life of the process, as the
     * runtime's constants do.
     *
     * @type {Map<string, number>}
     */
    const constants = new Map();
    /** @param {string} text */
    const constantString = text=>{
        if (!constants.has(text))
        {
            const bytes = Uint8Array.from([...text].map(char=>char.charCodeAt(0)).concat(0));
            const at = allocate ? allocate(bytes.length) : 0;
            if (at)
            {
                memory.writeMemory(at, bytes);
            }
            constants.set(text, at);
        }
        return constants.get(text) ?? 0;
    };

    // --- Direct3D 11's reflection, D3DReflect's ---

    /** D3D_NAME of a pixel shader's output named by its semantic alone, as fxc writes them. */
    const OUTPUT_NAMES = /** @type {Record<string, number>} */ ({ SV_TARGET: 64, SV_DEPTH: 65,
        SV_COVERAGE: 66, SV_DEPTHGREATEREQUAL: 67, SV_DEPTHLESSEQUAL: 68 });

    /** @param {any} reflection @param {any} entry @param {boolean} output */
    const systemValueOf = (reflection, entry, output)=>{
        const pixel = (reflection.reflection.desc.Version >>> 16) === 0;
        return output && pixel && entry.systemValue === 0
            ? OUTPUT_NAMES[entry.name.toUpperCase()] ?? 0 : entry.systemValue;
    };

    /** The name of a type as model 5's RDEF gives it, or the one its shape spells. */
    const typeNameOf = (/** @type {any} */ type)=>{
        const entry = type.entry;
        if (!entry)
        {
            return 0;
        }
        if (entry.nameAt !== undefined)
        {
            return pointerInto(type.owner, entry.nameAt);
        }
        const base = /** @type {Record<number, string>} */ ({ 1: 'bool', 2: 'int', 3: 'float',
            19: 'uint' })[entry.type] ?? 'void';
        const shape = entry.class === 0 ? base : entry.class === 1 ? `${base}${entry.columns}`
            : entry.class <= 3 ? `${base}${entry.rows}x${entry.columns}` : '';
        return constantString(shape);
    };

    /**
     * The interfaces of one version of ID3D11ShaderReflection: 43's signature description is
     * seven dwords, 46 and 47 add MinPrecision.
     *
     * @param {string} id   The interface's identifier.
     * @param {boolean} precision   Whether the signature description has MinPrecision.
     */
    const reflection11 = (id, precision)=>{
        /** @param {any} type @returns {number} */
        const publishType11 = type=>publisher.publish(type, typeInterfaces,
            IID.ID3D11ShaderReflectionType);
        /** @param {any} variable @returns {number} */
        const publishVariable11 = variable=>publisher.publish(variable, variableInterfaces,
            IID.ID3D11ShaderReflectionVariable);
        /** @param {any} buffer @returns {number} */
        const publishBuffer11 = buffer=>publisher.publish(buffer, bufferInterfaces11,
            IID.ID3D11ShaderReflectionConstantBuffer);
        /** @type {import('./com.js').InterfaceDescriptor[]} */
        const typeInterfaces = [bare(describe(IID.ID3D11ShaderReflectionType,
            ID3D11SHADERREFLECTIONTYPE_SLOTS, {
                /** @param {any} type @param {number[]} args */
                GetDesc: (type, [out])=>{
                    const hr = describedAs(SHADER_TYPE_DESC_FIELDS)(type, [out]);
                    if (hr === S_OK)
                    {
                        fields.writeU32(out + 28, typeNameOf(type));
                    }
                    return hr;
                },
                /** @param {any} type @param {number[]} args */
                GetMemberTypeByIndex: (type, [index])=>
                    publishType11(type.GetMemberTypeByIndex(index >>> 0)),
                /** @param {any} type @param {number[]} args */
                GetMemberTypeByName: (type, [name])=>
                    publishType11(type.GetMemberTypeByName(nameArgument(name))),
                /** @param {any} type @param {number[]} args */
                GetMemberTypeName: (type, [index])=>{
                    const name = type.GetMemberTypeName(index >>> 0);
                    if (!name)
                    {
                        return 0;
                    }
                    return 'text' in name ? constantString(name.text)
                        : pointerInto(type.owner, name.at);
                },
                /** @param {any} type @param {number[]} args */
                IsEqual: (type, [other])=>(publisher.objectAt(other) === type ? S_OK : 1),
                GetSubType: ()=>0,
                GetBaseClass: ()=>0,
                GetNumInterfaces: ()=>0,
                GetInterfaceByIndex: ()=>0,
                IsOfType: ()=>1,
                ImplementsInterface: ()=>1,
            }))];
        /** @type {import('./com.js').InterfaceDescriptor[]} */
        const variableInterfaces = [bare(describe(IID.ID3D11ShaderReflectionVariable,
            ID3D11SHADERREFLECTIONVARIABLE_SLOTS, {
                /** @param {any} variable @param {number[]} args */
                GetDesc: (variable, [out])=>{
                    const hr = describedAs(SHADER_VARIABLE_DESC_FIELDS)(variable, [out]);
                    if (hr === S_OK)
                    {
                        // Where a model 5 entry says it binds textures and samplers; a model
                        // 4 one binds none.
                        (variable.entry?.bindings ?? [0xffffffff, 0, 0xffffffff, 0])
                            .forEach((/** @type {number} */ word, /** @type {number} */ i)=>
                                fields.writeU32(out + 20 + i * 4, word));
                    }
                    return hr;
                },
                /** @param {any} variable */
                GetType: variable=>publishType11(variable.GetType()),
                /** @param {any} variable */
                GetBuffer: variable=>(variable.GetBuffer
                    ? publishBuffer11(variable.GetBuffer()) : 0),
                GetInterfaceSlot: ()=>0xffffffff,
            }))];
        /** @type {import('./com.js').InterfaceDescriptor[]} */
        const bufferInterfaces11 = [bare(describe(IID.ID3D11ShaderReflectionConstantBuffer,
            ID3D11SHADERREFLECTIONCONSTANTBUFFER_SLOTS, {
                GetDesc: describedAs(SHADER_BUFFER_DESC_FIELDS),
                /** @param {any} buffer @param {number[]} args */
                GetVariableByIndex: (buffer, [index])=>
                    publishVariable11(buffer.GetVariableByIndex(index >>> 0)),
                /** @param {any} buffer @param {number[]} args */
                GetVariableByName: (buffer, [name])=>
                    publishVariable11(buffer.GetVariableByName(nameArgument(name))),
            }))];
        /** @param {'GetInputParameterDesc' | 'GetOutputParameterDesc'} method */
        const signature = method=>{
            /** @param {any} reflection @param {number[]} args */
            const write = (reflection, [index, out])=>{
                /** @type {{ entry?: any }} */
                const held = {};
                const hr = reflection[method](index >>> 0, (out >>> 0) === 0 ? null : held);
                if (hr === S_OK)
                {
                    const entry = held.entry;
                    [pointerInto(reflection, entry.nameAt), entry.index, entry.register,
                        systemValueOf(reflection, entry, method === 'GetOutputParameterDesc'),
                        entry.componentType, entry.mask | (entry.readWriteMask << 8), 0,
                        ...(precision ? [0] : [])]
                        .forEach((value, position)=>fields.writeU32(out + position * 4, value));
                }
                return hr;
            };
            return write;
        };
        /** @param {any} reflection @param {number} index */
        const stat = (reflection, index)=>reflection.reflection.statistics?.[index] ?? 0;
        /** @param {any} reflection @param {any} entry @param {number} out */
        const writeBinding = (reflection, entry, out)=>{
            [pointerInto(reflection, entry.nameAt), entry.type, entry.bindPoint,
                entry.bindCount, entry.flags, entry.returnType, entry.dimension,
                entry.sampleCount]
                .forEach((value, position)=>fields.writeU32(out + position * 4, value));
        };
        return [describe(id, ID3D11SHADERREFLECTION_SLOTS, {
            /** @param {any} reflection @param {number[]} args */
            GetDesc: (reflection, [out])=>{
                /** @type {{ desc?: Record<string, number> }} */
                const held = {};
                const hr = reflection.GetDesc((out >>> 0) === 0 ? null : held);
                if (hr === S_OK && held.desc)
                {
                    const desc = held.desc;
                    SHADER_DESC_FIELDS.forEach((field, index)=>fields.writeU32(out + index * 4,
                        field === 'Creator' ? pointerInto(reflection, desc.Creator)
                            : desc[field]));
                    // InputPrimitive, then the hull, domain and compute fields: none here.
                    fields.writeU32(out + SHADER_DESC_FIELDS.length * 4, stat(reflection, 23));
                    for (let i = SHADER_DESC_FIELDS.length + 1; i < 38; i++)
                    {
                        fields.writeU32(out + i * 4, 0);
                    }
                }
                return hr;
            },
            /** @param {any} reflection @param {number[]} args */
            GetConstantBufferByIndex: (reflection, [index])=>
                publishBuffer11(reflection.GetConstantBufferByIndex(index >>> 0)),
            /** @param {any} reflection @param {number[]} args */
            GetConstantBufferByName: (reflection, [name])=>
                publishBuffer11(reflection.GetConstantBufferByName(nameArgument(name))),
            /** @param {any} reflection @param {number[]} args */
            GetResourceBindingDesc: (reflection, [index, out])=>{
                /** @type {{ entry?: any }} */
                const held = {};
                const hr = reflection.GetResourceBindingDesc(index >>> 0,
                    (out >>> 0) === 0 ? null : held);
                if (hr === S_OK)
                {
                    writeBinding(reflection, held.entry, out);
                }
                return hr;
            },
            GetInputParameterDesc: signature('GetInputParameterDesc'),
            GetOutputParameterDesc: signature('GetOutputParameterDesc'),
            GetPatchConstantParameterDesc: ()=>E_INVALIDARG,
            /** @param {any} reflection @param {number[]} args */
            GetVariableByName: (reflection, [name])=>
                publishVariable11(reflection.GetVariableByName(nameArgument(name))),
            /** @param {any} reflection @param {number[]} args */
            GetResourceBindingDescByName: (reflection, [name, out])=>{
                /** @type {{ entry?: any }} */
                const held = {};
                const hr = reflection.GetResourceBindingDescByName(nameArgument(name),
                    (out >>> 0) === 0 ? null : held);
                if (hr === S_OK)
                {
                    writeBinding(reflection, held.entry, out);
                }
                return hr;
            },
            /** @param {any} reflection */
            GetMovInstructionCount: reflection=>stat(reflection, 19),
            /** @param {any} reflection */
            GetMovcInstructionCount: reflection=>stat(reflection, 20),
            /** @param {any} reflection */
            GetConversionInstructionCount: reflection=>stat(reflection, 21),
            GetBitwiseInstructionCount: ()=>{
                report('ID3D11ShaderReflection::GetBitwiseInstructionCount: not counted here; '
                    + 'answered 0');
                return 0;
            },
            /** @param {any} reflection */
            GetGSInputPrimitive: reflection=>stat(reflection, 23),
            IsSampleFrequencyShader: ()=>0,
            GetNumInterfaceSlots: ()=>0,
            /** @param {any} reflection @param {number[]} args */
            GetMinFeatureLevel: (reflection, [out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const major = (reflection.reflection.desc.Version >>> 4) & 0xf;
                fields.writeU32(out, major >= 5 ? 0xb000 : 0xa000);
                return S_OK;
            },
            /** @param {any} reflection @param {number[]} args */
            GetThreadGroupSize: (reflection, [x, y, z])=>{
                for (const out of [x, y, z])
                {
                    if ((out >>> 0) !== 0)
                    {
                        fields.writeU32(out, 0);
                    }
                }
                return 0;
            },
            GetRequiresFlags: ()=>0,
        })];
    };
    const reflection11Interfaces43 = reflection11(IID.ID3D11ShaderReflection43, false);
    const reflection11Interfaces = reflection11(IID.ID3D11ShaderReflection, true);

    /**
     * D3DReflect: an ID3D11ShaderReflection of either version over a copy of the container,
     * or of Direct3D 10 when that is what was asked.
     *
     * @param {Uint8Array} bytes @param {number} riid @param {number} out
     */
    const reflectInto = (bytes, riid, out)=>{
        const id = readGuid(memory, riid);
        /** @type {string[]} */
        const ids = [IID.ID3D11ShaderReflection43, IID.ID3D11ShaderReflection,
            IID.ID3D10ShaderReflection];
        if (!ids.includes(id))
        {
            fields.writeU32(out, 0);
            return 0x80004002 | 0;
        }
        const reflected = reflectShader(bytes);
        if (!reflected)
        {
            fields.writeU32(out, 0);
            return E_FAIL;
        }
        const copy = allocate ? allocate(bytes.length) : 0;
        if (!copy)
        {
            fields.writeU32(out, 0);
            return E_OUTOFMEMORY;
        }
        memory.writeMemory(copy, bytes);
        const reflection = createShaderReflection(reflected, ()=>{
            for (const child of reflection.children())
            {
                publisher.unpublish(child);
            }
            free?.(copy);
        }, [id]);
        reflectionCopies.set(reflection, copy);
        const interfaces = id === IID.ID3D11ShaderReflection43 ? reflection11Interfaces43
            : id === IID.ID3D11ShaderReflection ? reflection11Interfaces : reflectionInterfaces;
        return handBack(reflection, interfaces, id, out);
    };

    const compiler = createCompilerSeam({ fields, memory, allocate, free, report, blobInto,
        readCString, callGuest, currentThread, reflect: reflectInto });

    /** @param {string[]} chunks */
    const signatureEntry = chunks=>({
        argBytes: 12,
        /**
         * A missing argument is D3DERR_INVALIDCALL and a container without
         * the chunk E_FAIL, and either leaves the program's pointer as it was.
         *
         * @param {number[]} args
         */
        handler: ([data, size, out])=>{
            const bytes = shaderBytes(data, size);
            if (!bytes || (out >>> 0) === 0)
            {
                return D3DERR_INVALIDCALL;
            }
            return blobInto(out, containerOf(bytes, chunks), E_FAIL);
        },
    });

    /** @param {string} profile */
    const profileEntry = profile=>({ argBytes: 4, handler: ()=>constantString(profile) });

    /**
     * An entry point this build answers with a refusal: the out pointer, when
     * the program gave one, cleared, and the reason reported.
     *
     * @param {number} argBytes
     * @param {number} outIndex  Which argument is the out pointer.
     * @param {string} reason
     */
    const refusal = (argBytes, outIndex, reason)=>({
        argBytes,
        /** @param {number[]} args */
        handler: args=>{
            if ((args[outIndex] >>> 0) !== 0)
            {
                fields.writeU32(args[outIndex], 0);
            }
            report(reason);
            return E_NOTIMPL;
        },
    });

    const effects = createEffectSeam({
        sync: syncRings,
        publisher, fields, memory, allocate, free, report, constantString, readCString, handBack,
        writeObjects, deviceInterfaces: ()=>deviceInterfaces,
        children: {
            buffer: [bufferInterfaces, IID.ID3D10Buffer],
            shaderResourceView: [shaderResourceViewInterfaces, IID.ID3D10ShaderResourceView],
            renderTargetView: [renderTargetViewInterfaces, IID.ID3D10RenderTargetView],
            depthStencilView: [depthStencilViewInterfaces, IID.ID3D10DepthStencilView],
            vertex: [vertexShaderInterfaces, IID.ID3D10VertexShader],
            pixel: [pixelShaderInterfaces, IID.ID3D10PixelShader],
            geometry: [geometryShaderInterfaces, IID.ID3D10GeometryShader],
            blend: [blendStateInterfaces, IID.ID3D10BlendState],
            depthStencil: [depthStencilStateInterfaces, IID.ID3D10DepthStencilState],
            rasterizer: [rasterizerStateInterfaces, IID.ID3D10RasterizerState],
            sampler: [samplerStateInterfaces, IID.ID3D10SamplerState],
        },
        writeStateDesc: {
            blend: writeBlendDesc, depthStencil: writeDepthStencilDesc,
            rasterizer: writeRasterizerDesc, sampler: writeSamplerDesc,
        },
    });

    // --- state blocks ---

    const stateBlockInterfaces = [describe(IID.ID3D10StateBlock, ID3D10STATEBLOCK_SLOTS, {
        /** @param {any} block */
        Capture: block=>block.Capture(),
        /** @param {any} block */
        Apply: block=>block.Apply(),
        /** @param {any} block */
        ReleaseAllDeviceObjects: block=>block.ReleaseAllDeviceObjects(),
        /** @param {any} block @param {number[]} args */
        GetDevice: (block, [out])=>{
            if ((out >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            /** @type {{ device?: any }} */
            const held = {};
            block.GetDevice(held);
            return handBack(held.device, deviceInterfaces, IID.ID3D10Device, out);
        },
    })];

    /**
     * A mask in guest memory, read whole; null for a null pointer.
     *
     * @param {number} address
     */
    const readMask = address=>((address >>> 0) === 0
        ? null
        : Uint8Array.from(memory.readMemory(address >>> 0, STATE_BLOCK_MASK_SIZE)));

    /**
     * A mask function that changes one mask in place.
     *
     * @param {(mask: Uint8Array | null, ...rest: number[]) => number} operation
     * @param {number} argBytes
     */
    const maskEntry = (operation, argBytes)=>({
        argBytes,
        /** @param {number[]} args */
        handler: ([address, ...rest])=>{
            const mask = readMask(address);
            const hr = operation(mask, ...rest.map(value=>value >>> 0));
            if (mask && hr === S_OK)
            {
                memory.writeMemory(address >>> 0, mask);
            }
            return hr;
        },
    });

    /**
     * A mask function of two masks into a third.
     *
     * @param {(a: Uint8Array | null, b: Uint8Array | null, out: Uint8Array | null) => number}
     *     operation
     */
    const combineEntry = operation=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([a, b, out])=>{
            const result = (out >>> 0) === 0 ? null : new Uint8Array(STATE_BLOCK_MASK_SIZE);
            const hr = operation(readMask(a), readMask(b), result);
            if (result && hr === S_OK)
            {
                memory.writeMemory(out >>> 0, result);
            }
            return hr;
        },
    });

    // --- the entry points ---

    /**
     * @param {number[]} args  adapter, driverType, software, flags, sdkVersion,
     *     [swapChainDesc, swapChainOut,] deviceOut
     * @param {boolean} withSwapChain
     */
    const createDeviceEntry = (args, withSwapChain)=>{
        const [adapterPointer, driverType, software, flags, sdkVersion] = args;
        const adapter = publisher.objectAt(adapterPointer);
        const softwareModule = (software >>> 0) === 0 ? null : { module: software >>> 0 };
        /** @type {{ device?: any }} */
        const deviceOut = {};
        /** @type {{ swapChain?: any }} */
        const chainOut = {};
        let hr;
        let out;
        if (withSwapChain)
        {
            const [, , , , , descAt, chainAt, deviceAt] = args;
            out = deviceAt;
            hr = root().CreateDeviceAndSwapChain(adapter, driverType >>> 0, softwareModule,
                flags >>> 0, sdkVersion >>> 0,
                (descAt >>> 0) === 0 ? null : sized(readSwapChainDesc(memory, descAt, pointerSize)),
                chainOut, deviceOut);
            if ((chainAt >>> 0) !== 0)
            {
                fields.writeU32(chainAt, 0);
            }
            if (hr === S_OK && chainOut.swapChain)
            {
                swapChainDevices.set(chainOut.swapChain, deviceOut.device);
                if ((chainAt >>> 0) !== 0)
                {
                    fields.writeU32(chainAt, publisher.publish(chainOut.swapChain,
                        swapChainInterfaces, IID.IDXGISwapChain));
                }
                else
                {
                    chainOut.swapChain.release();
                }
            }
        }
        else
        {
            out = args[5];
            hr = root().CreateDevice(adapter, driverType >>> 0, softwareModule, flags >>> 0,
                sdkVersion >>> 0, deviceOut);
        }
        if (hr !== S_OK)
        {
            if ((out >>> 0) !== 0)
            {
                fields.writeU32(out, 0);
            }
            return hr;
        }
        // A program that passes no device pointer wanted only to know whether
        // one could be made.
        if ((out >>> 0) === 0)
        {
            deviceOut.device.release();
            return S_OK;
        }
        created.push(deviceOut.device);
        attachRing(deviceOut.device);
        return handBack(deviceOut.device, deviceInterfaces, IID.ID3D10Device, out);
    };

    /**
     * Direct3D 10.1's two entry points, which name a feature level and, unlike
     * the 10.0 ones, have no use for a null device pointer.
     *
     * @param {number[]} args  adapter, driverType, software, flags, featureLevel,
     *     sdkVersion, [swapChainDesc, swapChainOut,] deviceOut
     * @param {boolean} withSwapChain
     */
    const createDevice1Entry = (args, withSwapChain)=>{
        const [adapterPointer, driverType, software, flags, featureLevel, sdkVersion] = args;
        const [descAt, chainAt, deviceAt] = withSwapChain ? args.slice(6, 9) : [0, 0, args[6]];
        /** @type {{ device?: any } | null} */
        const deviceOut = (deviceAt >>> 0) === 0 ? null : {};
        /** @type {{ swapChain?: any } | null} */
        const chainOut = (chainAt >>> 0) === 0 ? null : {};
        const adapter = publisher.objectAt(adapterPointer);
        const softwareModule = (software >>> 0) === 0 ? null : { module: software >>> 0 };
        const hr = withSwapChain
            ? root().CreateDeviceAndSwapChain1(adapter, driverType >>> 0, softwareModule,
                flags >>> 0, featureLevel >>> 0, sdkVersion >>> 0,
                (descAt >>> 0) === 0 ? null : sized(readSwapChainDesc(memory, descAt, pointerSize)),
                chainOut,
                deviceOut)
            : root().CreateDevice1(adapter, driverType >>> 0, softwareModule, flags >>> 0,
                featureLevel >>> 0, sdkVersion >>> 0, deviceOut);
        if ((chainAt >>> 0) !== 0)
        {
            fields.writeU32(chainAt, 0);
        }
        if (hr !== S_OK || !deviceOut)
        {
            if ((deviceAt >>> 0) !== 0)
            {
                fields.writeU32(deviceAt, 0);
            }
            return hr;
        }
        if (chainOut?.swapChain)
        {
            swapChainDevices.set(chainOut.swapChain, deviceOut.device);
            fields.writeU32(chainAt, publisher.publish(chainOut.swapChain, swapChainInterfaces,
                IID.IDXGISwapChain));
        }
        created.push(deviceOut.device);
        attachRing(deviceOut.device);
        return handBack(deviceOut.device, deviceInterfaces, IID.ID3D10Device1, deviceAt);
    };

    /** @type {any[]} */
    const created = [];

    /** d3d10.dll's exports, which d3d10_1.dll forwards but for its own two creates. */
    const d3d10Exports = {
        /**
         * HRESULT D3D10CreateDevice(IDXGIAdapter*, D3D10_DRIVER_TYPE, HMODULE, UINT,
         *                           UINT SDKVersion, ID3D10Device**)
         */
        D3D10CreateDevice: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: args=>createDeviceEntry(args, false),
        },
        /**
         * HRESULT D3D10CreateDeviceAndSwapChain(IDXGIAdapter*, D3D10_DRIVER_TYPE,
         *     HMODULE, UINT, UINT SDKVersion, DXGI_SWAP_CHAIN_DESC*, IDXGISwapChain**,
         *     ID3D10Device**)
         */
        D3D10CreateDeviceAndSwapChain: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: args=>createDeviceEntry(args, true),
        },
        /** HRESULT D3D10CreateBlob(SIZE_T, ID3D10Blob**) */
        D3D10CreateBlob: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([size, out])=>{
                if ((out >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                return (size >>> 0) > LARGEST_BLOB
                    ? E_OUTOFMEMORY
                    : blobInto(out, new Uint8Array(size >>> 0), E_OUTOFMEMORY);
            },
        },
        /** HRESULT D3D10GetInputSignatureBlob(const void*, SIZE_T, ID3D10Blob**) */
        D3D10GetInputSignatureBlob: signatureEntry(['ISGN']),
        /** HRESULT D3D10GetOutputSignatureBlob(const void*, SIZE_T, ID3D10Blob**) */
        D3D10GetOutputSignatureBlob: signatureEntry(['OSGN']),
        /**
         * HRESULT D3D10GetInputAndOutputSignatureBlob(const void*, SIZE_T,
         *     ID3D10Blob**)
         */
        D3D10GetInputAndOutputSignatureBlob: signatureEntry(['ISGN', 'OSGN']),
        /** HRESULT D3D10GetShaderDebugInfo(const void*, SIZE_T, ID3D10Blob**) */
        D3D10GetShaderDebugInfo: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([data, size, out])=>{
                const bytes = shaderBytes(data, size);
                if (!bytes || (out >>> 0) === 0)
                {
                    return D3DERR_INVALIDCALL;
                }
                return blobInto(out, debugInfoOf(bytes), E_FAIL);
            },
        },
        /** HRESULT D3D10ReflectShader(const void*, SIZE_T, ID3D10ShaderReflection**) */
        D3D10ReflectShader: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([data, size, out])=>{
                if ((out >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const bytes = shaderBytes(data, size);
                const reflected = bytes ? reflectShader(bytes) : null;
                if (!bytes || !reflected)
                {
                    fields.writeU32(out, 0);
                    return E_FAIL;
                }
                // Direct3D 10's reflector knows the vertex, geometry and pixel
                // stages up to shader model 5.0, and reads a program through its
                // resource definitions: a stage Direct3D 11 added, model 5.1, or
                // a container stripped of its RDEF is refused (reflection.c as
                // d3d10 builds it: test_reflection_cs, _desc_ps_output,
                // _bound_resources).
                const version = reflected.desc.Version;
                if ((version >>> 16) > SHADER_KIND.GEOMETRY || (version & 0xff) > 0x50
                    || !reflected.hasDefinitions)
                {
                    fields.writeU32(out, 0);
                    return E_INVALIDARG;
                }
                const copy = allocate ? allocate(bytes.length) : 0;
                if (!copy)
                {
                    fields.writeU32(out, 0);
                    return E_OUTOFMEMORY;
                }
                memory.writeMemory(copy, bytes);
                const reflection = createShaderReflection(reflected, ()=>{
                    for (const child of reflection.children())
                    {
                        publisher.unpublish(child);
                    }
                    free?.(copy);
                });
                reflectionCopies.set(reflection, copy);
                return handBack(reflection, reflectionInterfaces,
                    IID.ID3D10ShaderReflection, out);
            },
        },
        /**
         * HRESULT D3D10CreateEffectFromMemory(void*, SIZE_T, UINT, ID3D10Device*,
         *     ID3D10EffectPool*, ID3D10Effect**)
         */
        D3D10CreateEffectFromMemory: { argBytes: 24, handler: effects.fromMemory },
        /**
         * HRESULT D3D10CreateEffectPoolFromMemory(void*, SIZE_T, UINT, ID3D10Device*,
         *     ID3D10EffectPool**)
         */
        D3D10CreateEffectPoolFromMemory: { argBytes: 20, handler: effects.poolFromMemory },
        /** HRESULT D3D10DisassembleEffect(ID3D10Effect*, BOOL, ID3D10Blob**) */
        D3D10DisassembleEffect: refusal(12, 2, 'D3D10DisassembleEffect: no disassembler is'
            + ' kept here'),
        /**
         * HRESULT D3D10PreprocessShader(const char*, SIZE_T, const char*,
         *     const D3D10_SHADER_MACRO*, ID3D10Include*, ID3D10Blob**, ID3D10Blob**)
         */
        D3D10PreprocessShader: refusal(28, 5, 'D3D10PreprocessShader: this runtime has no'
            + ' HLSL preprocessor'),
        /**
         * HRESULT D3D10CreateStateBlock(ID3D10Device*, D3D10_STATE_BLOCK_MASK*,
         *     ID3D10StateBlock**)
         */
        D3D10CreateStateBlock: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([devicePointer, maskAt, out])=>{
                const device = publisher.objectAt(devicePointer);
                const mask = readMask(maskAt);
                if (!device || !mask || (out >>> 0) === 0)
                {
                    if ((out >>> 0) !== 0)
                    {
                        fields.writeU32(out, 0);
                    }
                    return E_INVALIDARG;
                }
                return handBack(createStateBlock(device, mask), stateBlockInterfaces,
                    IID.ID3D10StateBlock, out);
            },
        },
        /** HRESULT D3D10StateBlockMaskEnableAll(D3D10_STATE_BLOCK_MASK*) */
        D3D10StateBlockMaskEnableAll: maskEntry(stateBlockMask.EnableAll, 4),
        /** HRESULT D3D10StateBlockMaskDisableAll(D3D10_STATE_BLOCK_MASK*) */
        D3D10StateBlockMaskDisableAll: maskEntry(stateBlockMask.DisableAll, 4),
        /**
         * HRESULT D3D10StateBlockMaskEnableCapture(D3D10_STATE_BLOCK_MASK*,
         *     D3D10_DEVICE_STATE_TYPES, UINT, UINT)
         */
        D3D10StateBlockMaskEnableCapture: maskEntry(stateBlockMask.EnableCapture, 16),
        /**
         * HRESULT D3D10StateBlockMaskDisableCapture(D3D10_STATE_BLOCK_MASK*,
         *     D3D10_DEVICE_STATE_TYPES, UINT, UINT)
         */
        D3D10StateBlockMaskDisableCapture: maskEntry(stateBlockMask.DisableCapture, 16),
        /**
         * BOOL D3D10StateBlockMaskGetSetting(D3D10_STATE_BLOCK_MASK*,
         *     D3D10_DEVICE_STATE_TYPES, UINT)
         */
        D3D10StateBlockMaskGetSetting: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([maskAt, type, entry])=>stateBlockMask.GetSetting(readMask(maskAt),
                type >>> 0, entry >>> 0),
        },
        /** HRESULT D3D10StateBlockMaskDifference(mask*, mask*, mask*) */
        D3D10StateBlockMaskDifference: combineEntry(stateBlockMask.Difference),
        /** HRESULT D3D10StateBlockMaskIntersect(mask*, mask*, mask*) */
        D3D10StateBlockMaskIntersect: combineEntry(stateBlockMask.Intersect),
        /** HRESULT D3D10StateBlockMaskUnion(mask*, mask*, mask*) */
        D3D10StateBlockMaskUnion: combineEntry(stateBlockMask.Union),
        /** const char* D3D10GetVertexShaderProfile(ID3D10Device*) */
        D3D10GetVertexShaderProfile: profileEntry(SHADER_PROFILE.VERTEX),
        /** const char* D3D10GetPixelShaderProfile(ID3D10Device*) */
        D3D10GetPixelShaderProfile: profileEntry(SHADER_PROFILE.PIXEL),
        /** const char* D3D10GetGeometryShaderProfile(ID3D10Device*) */
        D3D10GetGeometryShaderProfile: profileEntry(SHADER_PROFILE.GEOMETRY),
        /**
         * HRESULT D3D10CompileShader(const char*, SIZE_T, const char*,
         *     const D3D10_SHADER_MACRO*, ID3D10Include*, const char*, const char*,
         *     UINT, ID3D10Blob**, ID3D10Blob**)
         */
        D3D10CompileShader: compiler.D3D10CompileShader,
        /**
         * HRESULT D3D10CompileEffectFromMemory(void*, SIZE_T, const char*,
         *     const D3D10_SHADER_MACRO*, ID3D10Include*, UINT, UINT, ID3D10Blob**,
         *     ID3D10Blob**)
         */
        D3D10CompileEffectFromMemory: compiler.D3D10CompileEffectFromMemory,
        /**
         * HRESULT D3D10DisassembleShader(const void*, SIZE_T, BOOL, const char*,
         *     ID3D10Blob**)
         */
        D3D10DisassembleShader: refusal(20, 4, 'D3D10DisassembleShader: no disassembler is'
            + ' kept here'),
    };

    return {
        /**
         * The window the last swap chain presented a frame into and whether
         * it is full screen, or null: full screen, or windowed over the whole
         * screen, its frames are the screen.
         */
        presentedWindow: ()=>presentedInto,
        deviceInterfaces,
        swapChainInterfaces,
        factoryInterfaces,
        /** The effect framework, which D3D10CreateEffectFromMemory calls. */
        effects,

        libraries: {
            'D3D10_1.dll': {
                /**
                 * HRESULT D3D10CreateDevice1(IDXGIAdapter*, D3D10_DRIVER_TYPE, HMODULE, UINT,
                 *     D3D10_FEATURE_LEVEL1, UINT SDKVersion, ID3D10Device1**)
                 */
                D3D10CreateDevice1: {
                    argBytes: 28,
                    /** @param {number[]} args */
                    handler: args=>createDevice1Entry(args, false),
                },
                /**
                 * HRESULT D3D10CreateDeviceAndSwapChain1(IDXGIAdapter*, D3D10_DRIVER_TYPE,
                 *     HMODULE, UINT, D3D10_FEATURE_LEVEL1, UINT SDKVersion,
                 *     DXGI_SWAP_CHAIN_DESC*, IDXGISwapChain**, ID3D10Device1**)
                 */
                D3D10CreateDeviceAndSwapChain1: {
                    argBytes: 36,
                    /** @param {number[]} args */
                    handler: args=>createDevice1Entry(args, true),
                },
                // Everything else d3d10_1.dll exports is d3d10.dll's, forwarded.
                ...Object.fromEntries(Object.entries(d3d10Exports).filter(([name])=>
                    name !== 'D3D10CreateDevice' && name !== 'D3D10CreateDeviceAndSwapChain')),
            },
            'D3D10.dll': d3d10Exports,
            'D3D11.dll': eleven.library,
            // D3DCompile, D3DReflect and the blob functions: the June 2010 runtime's library
            // and the one Windows ships.
            'D3DCompiler_43.dll': compiler.exports,
            'D3DCOMPILER_47.dll': compiler.exports,
            'DXGI.dll': {
                /** HRESULT CreateDXGIFactory(REFIID, void**) */
                CreateDXGIFactory: {
                    argBytes: 8,
                    /** @param {number[]} args */
                    handler: ([guid, out])=>{
                        const id = readGuid(memory, guid);
                        /** @type {{ object?: any }} */
                        const held = {};
                        const hr = root().CreateDXGIFactory(id, held);
                        if (hr !== S_OK)
                        {
                            fields.writeU32(out, 0);
                            return hr;
                        }
                        return handBack(held.object, factoryInterfaces, factoryFace(id), out);
                    },
                },
                /** HRESULT CreateDXGIFactory2(UINT, REFIID, void**) */
                CreateDXGIFactory2: {
                    argBytes: 12,
                    /** @param {number[]} args */
                    handler: ([flags, guid, out])=>{
                        const id = readGuid(memory, guid);
                        /** @type {{ object?: any }} */
                        const held = {};
                        const hr = root().CreateDXGIFactory2(flags >>> 0, id, held);
                        if (hr !== S_OK)
                        {
                            fields.writeU32(out, 0);
                            return hr;
                        }
                        return handBack(held.object, factoryInterfaces, factoryFace(id), out);
                    },
                },
                /** HRESULT CreateDXGIFactory1(REFIID, void**) */
                CreateDXGIFactory1: {
                    argBytes: 8,
                    /** @param {number[]} args */
                    handler: ([guid, out])=>{
                        const id = readGuid(memory, guid);
                        /** @type {{ object?: any }} */
                        const held = {};
                        const hr = root().CreateDXGIFactory1(id, held);
                        if (hr !== S_OK)
                        {
                            fields.writeU32(out, 0);
                            return hr;
                        }
                        return handBack(held.object, factoryInterfaces, factoryFace(id), out);
                    },
                },
            },
        },

        diagnostics: ()=>({
            devices: created.length,
            renderer: created.length > 0 ? created[created.length - 1].diagnostics() : null,
            // Each device's ring: how often and how long it was played, and why
            // a dynamic buffer's maps reached the host.
            rings: [...rings].map(ring=>ring.counters()),
            // Maps of buffers the guest cannot map, by their usage.
            unattachedMaps: { ...unattachedMaps },
        }),
    };
}
