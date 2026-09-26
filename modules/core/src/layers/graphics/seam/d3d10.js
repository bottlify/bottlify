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
import { readGuid } from './ddraw.js';
import { createFields } from './structs.js';
import {
    D3D10_LIMITS, D3D10_MAP, D3D10_RESOURCE_DIMENSION, DXGI_ERROR_INVALID_CALL, E_INVALIDARG,
    E_NOTIMPL, IID, S_OK, formatPitch,
} from '../d3d10/constants.js';
import { D3D10CreateDevice, D3D10CreateDeviceAndSwapChain } from '../d3d10/device.js';
import { CreateDXGIFactory } from '../d3d10/dxgi.js';
import { readSwapChainDesc, writeSwapChainDesc } from '../d3d10/structs.js';
import { levelExtent } from '../d3d10/validity.js';

/**
 * A method here may answer nothing: the setters of this API are `void`, and
 * the bridge reads an absent result as zero. The declared type of a slot's
 * implementation says a number, so the map is widened once, here.
 *
 * @param {string} id
 * @param {[string, number][]} slots
 * @param {Record<string, (target: any, args: number[]) => number | void>} implemented
 */
const describe = (id, slots, implemented)=>describeSlots(id, slots,
    /** @type {Record<string, (target: any, args: number[]) => number>} */ (implemented));

/** DXGI_ERROR_NOT_CURRENTLY_AVAILABLE, for what a browser has no counterpart of. */
const DXGI_ERROR_NOT_CURRENTLY_AVAILABLE = 0x887a0022 | 0;

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

/**
 * The three view descriptions share a head and differ in the union after it.
 * The union is read as three dwords whatever the dimension names, and the
 * object model sorts out which fields mean anything.
 */
const VIEW_DESC = Object.freeze({
    Format: 0x00, ViewDimension: 0x04, u0: 0x08, u1: 0x0c, u2: 0x10, u3: 0x14,
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

/** DXGI_OUTPUT_DESC: a 32-wide-character name first. */
const DXGI_OUTPUT_DESC = Object.freeze({
    DeviceName: 0x00, DesktopCoordinates: 0x40, AttachedToDesktop: 0x50, Rotation: 0x54,
    Monitor: 0x58, SIZE: 0x5c,
});

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

export const IDXGISURFACE_SLOTS = /** @type {[string, number][]} */ ([
    ...IDXGIDEVICESUBOBJECT_SLOTS,
    ['GetDesc', 1],
    ['Map', 2],
    ['Unmap', 0],
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

/**
 * ID3D10Device, after IUnknown's three: ninety-five slots, transcribed from
 * the header in its order. The `Set` family comes first, the `Get` family
 * mirrors it, and the creates come last -- the opposite of how a program
 * uses them.
 */
export const ID3D10DEVICE_SLOTS = /** @type {[string, number][]} */ ([
    ['VSSetConstantBuffers', 3],
    ['PSSetShaderResources', 3],
    ['PSSetShader', 1],
    ['PSSetSamplers', 3],
    ['VSSetShader', 1],
    ['DrawIndexed', 3],
    ['Draw', 2],
    ['PSSetConstantBuffers', 3],
    ['IASetInputLayout', 1],
    ['IASetVertexBuffers', 5],
    ['IASetIndexBuffer', 3],
    ['DrawIndexedInstanced', 5],
    ['DrawInstanced', 4],
    ['GSSetConstantBuffers', 3],
    ['GSSetShader', 1],
    ['IASetPrimitiveTopology', 1],
    ['VSSetShaderResources', 3],
    ['VSSetSamplers', 3],
    ['SetPredication', 2],
    ['GSSetShaderResources', 3],
    ['GSSetSamplers', 3],
    ['OMSetRenderTargets', 3],
    ['OMSetBlendState', 3],
    ['OMSetDepthStencilState', 2],
    ['SOSetTargets', 3],
    ['DrawAuto', 0],
    ['RSSetState', 1],
    ['RSSetViewports', 2],
    ['RSSetScissorRects', 2],
    ['CopySubresourceRegion', 8],
    ['CopyResource', 2],
    ['UpdateSubresource', 6],
    ['ClearRenderTargetView', 2],
    ['ClearDepthStencilView', 4],
    ['GenerateMips', 1],
    ['ResolveSubresource', 5],
    ['VSGetConstantBuffers', 3],
    ['PSGetShaderResources', 3],
    ['PSGetShader', 1],
    ['PSGetSamplers', 3],
    ['VSGetShader', 1],
    ['PSGetConstantBuffers', 3],
    ['IAGetInputLayout', 1],
    ['IAGetVertexBuffers', 5],
    ['IAGetIndexBuffer', 3],
    ['GSGetConstantBuffers', 3],
    ['GSGetShader', 1],
    ['IAGetPrimitiveTopology', 1],
    ['VSGetShaderResources', 3],
    ['VSGetSamplers', 3],
    ['GetPredication', 2],
    ['GSGetShaderResources', 3],
    ['GSGetSamplers', 3],
    ['OMGetRenderTargets', 3],
    ['OMGetBlendState', 3],
    ['OMGetDepthStencilState', 2],
    ['SOGetTargets', 3],
    ['RSGetState', 1],
    ['RSGetViewports', 2],
    ['RSGetScissorRects', 2],
    ['GetDeviceRemovedReason', 0],
    ['SetExceptionMode', 1],
    ['GetExceptionMode', 0],
    ['GetPrivateData', 3],
    ['SetPrivateData', 3],
    ['SetPrivateDataInterface', 2],
    ['ClearState', 0],
    ['Flush', 0],
    ['CreateBuffer', 3],
    ['CreateTexture1D', 3],
    ['CreateTexture2D', 3],
    ['CreateTexture3D', 3],
    ['CreateShaderResourceView', 3],
    ['CreateRenderTargetView', 3],
    ['CreateDepthStencilView', 3],
    ['CreateInputLayout', 5],
    ['CreateVertexShader', 3],
    ['CreateGeometryShader', 3],
    ['CreateGeometryShaderWithStreamOutput', 6],
    ['CreatePixelShader', 3],
    ['CreateBlendState', 2],
    ['CreateDepthStencilState', 2],
    ['CreateRasterizerState', 2],
    ['CreateSamplerState', 2],
    ['CreateQuery', 2],
    ['CreatePredicate', 2],
    ['CreateCounter', 2],
    ['CheckFormatSupport', 2],
    ['CheckMultisampleQualityLevels', 3],
    ['CheckCounterInfo', 1],
    ['CheckCounter', 9],
    ['GetCreationFlags', 0],
    ['OpenSharedResource', 3],
    ['SetTextFilterSize', 2],
    ['GetTextFilterSize', 2],
]);

/**
 * @typedef {Object} Deps
 * @property {any} publisher   From createPublisher.
 * @property {any} memory      readMemory/writeMemory.
 * @property {(bytes: number) => number} [allocate]  Guest memory a map hands out.
 * @property {(address: number) => void} [free]
 * @property {() => import('../d3d10/device.js').DeviceOptions} deviceOptions
 *     What a device draws with: the backend and the GPU's sampler and texture
 *     makers, reached when a program creates one rather than before.
 * @property {import('../d3d10/dxgi.js').FactoryOptions} [factoryOptions]
 */

/**
 * @param {Deps} deps
 */
export function createDirect3D10Seam({ publisher, memory, allocate, free, deviceOptions,
    factoryOptions })
{
    const fields = createFields(memory);

    /** @param {number} address @param {number} count @returns {number[]} */
    const readPointers = (address, count)=>{
        /** @type {number[]} */
        const pointers = [];
        for (let index = 0; index < count; index++)
        {
            pointers.push((address >>> 0) === 0 ? 0 : fields.readU32(address + index * 4));
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
     * The descriptors an object answers to: an interface it does not claim is
     * left out, so QueryInterface refuses it rather than answering for it.
     *
     * @param {any} object
     * @param {import('./com.js').InterfaceDescriptor[]} interfaces
     */
    const answeredBy = (object, interfaces)=>(typeof object?.supports === 'function'
        ? interfaces.filter(entry=>object.supports(entry.id))
        : interfaces);

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
            fields.writeU32(address + index * 4,
                object ? publisher.publish(object, answeredBy(object, interfaces), id) : 0);
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
        const pointer = publisher.publish(object, answeredBy(object, interfaces), id);
        fields.writeU32(out, pointer);
        return pointer === 0 ? E_INVALIDARG : S_OK;
    };

    // --- private data, in both orders ---

    /** @param {any} object @param {number[]} args */
    const setPrivateData = (object, [guid, size, data])=>object.SetPrivateData(
        readGuid(memory, guid), size >>> 0,
        (data >>> 0) === 0 ? null : memory.readMemory(data >>> 0, size >>> 0));

    /** @param {any} object @param {number[]} args */
    const setPrivateDataInterface = (object, [guid, pointer])=>object.SetPrivateDataInterface(
        readGuid(memory, guid), publisher.objectAt(pointer));

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
            fields.writeU32(data, answer.object
                ? publisher.publish(answer.object, [], IID.IUnknown)
                : 0);
        }
        return answer.hr;
    };

    const privateDataMethods = {
        SetPrivateData: setPrivateData,
        SetPrivateDataInterface: setPrivateDataInterface,
        GetPrivateData: getPrivateData,
    };

    /** @param {any} child @param {number[]} args */
    const getDevice = (child, [out])=>{
        /** @type {{ device?: any }} */
        const held = {};
        child.GetDevice(held);
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
     * @param {Record<string, (target: any, args: number[]) => number | void>} methods
     */
    const describeAll = (faces, methods)=>faces.map(([id, slots])=>describe(id, slots, methods));

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const outputInterfaces = describeAll([
        [IID.IDXGIOutput, IDXGIOUTPUT_SLOTS], [IID.IDXGIObject, IDXGIOBJECT_SLOTS],
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
            writeWide(out + DXGI_OUTPUT_DESC.DeviceName, held.desc.DeviceName, 32);
            fields.writeStruct(out + DXGI_OUTPUT_DESC.DesktopCoordinates, RECT,
                held.desc.DesktopCoordinates);
            fields.writeU32(out + DXGI_OUTPUT_DESC.AttachedToDesktop,
                held.desc.AttachedToDesktop ? 1 : 0);
            fields.writeU32(out + DXGI_OUTPUT_DESC.Rotation, held.desc.Rotation);
            fields.writeU32(out + DXGI_OUTPUT_DESC.Monitor, 1);
            return S_OK;
        },
        // No mode is switched in a browser; a program that asks for the list
        // is told it is empty and keeps the mode it has.
        /** @param {any} output @param {number[]} args */
        GetDisplayModeList: (output, [, , countAt])=>{
            if ((countAt >>> 0) !== 0)
            {
                fields.writeU32(countAt, 0);
            }
            return S_OK;
        },
        WaitForVBlank: ()=>S_OK,
        TakeOwnership: ()=>DXGI_ERROR_NOT_CURRENTLY_AVAILABLE,
        ReleaseOwnership: ()=>S_OK,
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
        writeWide(out + DXGI_ADAPTER_DESC.Description, held.desc.Description, 128);
        fields.writeStruct(out, DXGI_ADAPTER_DESC, {
            VendorId: held.desc.VendorId,
            DeviceId: held.desc.DeviceId,
            SubSysId: held.desc.SubSysId,
            Revision: held.desc.Revision,
            DedicatedVideoMemory: REPORTED_VIDEO_MEMORY,
            DedicatedSystemMemory: 0,
            SharedSystemMemory: REPORTED_VIDEO_MEMORY,
            AdapterLuidLow: 1,
            AdapterLuidHigh: 0,
        });
        return S_OK;
    };

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const adapterInterfaces = describeAll([
        [IID.IDXGIAdapter, IDXGIADAPTER_SLOTS], [IID.IDXGIAdapter1, IDXGIADAPTER1_SLOTS],
        [IID.IDXGIObject, IDXGIOBJECT_SLOTS],
    ], {
        ...privateDataMethods,
        GetParent: getParent,
        /** @param {any} adapter @param {number[]} args */
        EnumOutputs: (adapter, [index, out])=>{
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
        GetDesc1: (adapter, [out])=>{
            const hr = writeAdapterDesc(adapter, out);
            if (hr === S_OK)
            {
                fields.writeU32(out + DXGI_ADAPTER_DESC.SIZE, 0);
            }
            return hr;
        },
        // Direct3D 10 is what this adapter speaks; anything else asked by GUID
        // is refused, which is how a program picks between its own paths.
        /** @param {any} adapter @param {number[]} args */
        CheckInterfaceSupport: (adapter, [guid, version])=>{
            if ((version >>> 0) !== 0)
            {
                fields.writeU32(version, 0);
                fields.writeU32(version + 4, 0);
            }
            return readGuid(memory, guid) === IID.ID3D10Device ? S_OK : DXGI_ERROR_INVALID_CALL;
        },
    });

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const factoryInterfaces = describeAll([
        [IID.IDXGIFactory, IDXGIFACTORY_SLOTS], [IID.IDXGIObject, IDXGIOBJECT_SLOTS],
    ], {
        ...privateDataMethods,
        GetParent: getParent,
        /** @param {any} factory @param {number[]} args */
        EnumAdapters: (factory, [index, out])=>{
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
            if (!device || (descAt >>> 0) === 0)
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            /** @type {{ swapChain?: any }} */
            const held = {};
            const hr = factory.CreateSwapChain(device, readSwapChainDesc(memory, descAt), held);
            if (hr !== S_OK)
            {
                fields.writeU32(out, 0);
                return hr;
            }
            swapChainDevices.set(held.swapChain, device);
            return handBack(held.swapChain, swapChainInterfaces, IID.IDXGISwapChain, out);
        },
        CreateSoftwareAdapter: ()=>E_NOTIMPL,
    });

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const swapChainInterfaces = describeAll([
        [IID.IDXGISwapChain, IDXGISWAPCHAIN_SLOTS], [IID.IDXGIObject, IDXGIOBJECT_SLOTS],
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
        Present: (swapChain, [interval, flags])=>swapChain.Present(interval >>> 0, flags >>> 0),
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
        // The browser owns the display; a request to go exclusive is noted and
        // reported back as windowed, which a program handles as a refusal.
        SetFullscreenState: ()=>S_OK,
        /** @param {any} swapChain @param {number[]} args */
        GetFullscreenState: (swapChain, [fullscreenAt, targetAt])=>{
            /** @type {{ fullscreen?: boolean, target?: any }} */
            const held = {};
            const hr = swapChain.GetFullscreenState(held);
            if ((fullscreenAt >>> 0) !== 0)
            {
                fields.writeU32(fullscreenAt, held.fullscreen ? 1 : 0);
            }
            if ((targetAt >>> 0) !== 0)
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
                writeSwapChainDesc(memory, out, held.desc);
            }
            return hr;
        },
        /** @param {any} swapChain @param {number[]} args */
        ResizeBuffers: (swapChain, [count, width, height, format, flags])=>
            swapChain.ResizeBuffers(count >>> 0, width >>> 0, height >>> 0, format >>> 0,
                flags >>> 0),
        ResizeTarget: ()=>S_OK,
        /** @param {any} swapChain @param {number[]} args */
        GetContainingOutput: (swapChain, [out])=>{
            fields.writeU32(out, 0);
            return DXGI_ERROR_NOT_CURRENTLY_AVAILABLE;
        },
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
     * @returns {{ hr: number, address: number, rowPitch: number, depthPitch: number }}
     */
    const mapInto = (resource, subresource, mapType, flags)=>{
        /** @type {{ data?: Uint8Array | null, rowPitch?: number, depthPitch?: number }} */
        const held = {};
        const hr = resource.Map(subresource, mapType, flags, held);
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
         * Nothing is shared between processes here, so no resource has a
         * handle to share.
         *
         * @param {any} resource @param {number[]} args
         */
        GetSharedHandle: (resource, [out])=>{
            fields.writeU32(out, 0);
            return S_OK;
        },
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
            const mapped = mapInto(texture, 0, mapType, 0);
            if (mapped.hr === S_OK)
            {
                fields.writeU32(rect, mapped.rowPitch);
                fields.writeU32(rect + 4, mapped.address);
            }
            return mapped.hr;
        },
        /** @param {any} texture */
        Unmap: texture=>{
            unmapFrom(texture, 0);
            return S_OK;
        },
    };

    /**
     * The interfaces every resource shares, after its own: Direct3D's two
     * bases and DXGI's four faces of the same object. Which of them a given
     * resource answers to is its own to say (`answeredBy`).
     *
     * @type {import('./com.js').InterfaceDescriptor[]}
     */
    const resourceBases = [
        describe(IID.ID3D10Resource, ID3D10RESOURCE_SLOTS, resourceMethods),
        describe(IID.ID3D10DeviceChild, ID3D10DEVICECHILD_SLOTS, resourceMethods),
        ...describeAll([
            [IID.IDXGIObject, IDXGIOBJECT_SLOTS],
            [IID.IDXGIDeviceSubObject, IDXGIDEVICESUBOBJECT_SLOTS],
            [IID.IDXGIResource, IDXGIRESOURCE_SLOTS],
            [IID.IDXGISurface, IDXGISURFACE_SLOTS],
        ], dxgiResourceMethods),
    ];

    /**
     * @param {any} texture
     * @param {number[]} args
     * @param {boolean} pitches  Whether the out structure has room for pitches.
     */
    const mapTexture = (texture, [subresource, mapType, flags, out], pitches)=>{
        const mapped = mapInto(texture, subresource >>> 0, mapType >>> 0, flags >>> 0);
        if (mapped.hr !== S_OK || (out >>> 0) === 0)
        {
            return mapped.hr;
        }
        fields.writeU32(out, mapped.address);
        if (pitches)
        {
            fields.writeU32(out + 4, mapped.rowPitch);
        }
        return S_OK;
    };

    /** @param {any} texture @param {number[]} args */
    const unmapTexture = (texture, [subresource])=>unmapFrom(texture, subresource >>> 0);

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const bufferInterfaces = [describe(IID.ID3D10Buffer, ID3D10BUFFER_SLOTS, {
        ...resourceMethods,
        /** @param {any} buffer @param {number[]} args */
        Map: (buffer, [mapType, flags, out])=>{
            const mapped = mapInto(buffer, 0, mapType >>> 0, flags >>> 0);
            if (mapped.hr === S_OK && (out >>> 0) !== 0)
            {
                fields.writeU32(out, mapped.address);
            }
            return mapped.hr;
        },
        /** @param {any} buffer */
        Unmap: buffer=>unmapFrom(buffer, 0),
        /** @param {any} buffer @param {number[]} args */
        GetDesc: (buffer, [out])=>{
            fields.writeStruct(out, D3D10_BUFFER_DESC, buffer.desc);
        },
    }), ...resourceBases];

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
    }), ...resourceBases];

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
    }), ...resourceBases];

    /** @type {import('./com.js').InterfaceDescriptor[]} */
    const texture3DInterfaces = [describe(IID.ID3D10Texture3D, ID3D10TEXTURE_SLOTS, {
        ...resourceMethods,
        /** @param {any} texture @param {number[]} args */
        Map: (texture, [subresource, mapType, flags, out])=>{
            const mapped = mapInto(texture, subresource >>> 0, mapType >>> 0, flags >>> 0);
            if (mapped.hr !== S_OK || (out >>> 0) === 0)
            {
                return mapped.hr;
            }
            fields.writeU32(out, mapped.address);
            fields.writeU32(out + 4, mapped.rowPitch);
            fields.writeU32(out + 8, mapped.depthPitch);
            return S_OK;
        },
        Unmap: unmapTexture,
        /** @param {any} texture @param {number[]} args */
        GetDesc: (texture, [out])=>{
            fields.writeStruct(out, D3D10_TEXTURE3D_DESC, texture.desc);
        },
    }), ...resourceBases];

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
     * @param {(desc: any) => Record<string, number>} unionOf
     *     The union fields after the head, in order, as the view reports them.
     */
    const viewInterfaces = (id, unionOf)=>describeAll([
        [id, ID3D10VIEW_SLOTS], [IID.ID3D10View, ID3D10BASEVIEW_SLOTS],
        [IID.ID3D10DeviceChild, ID3D10DEVICECHILD_SLOTS],
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
            fields.writeStruct(out, VIEW_DESC, {
                Format: held.desc.Format,
                ViewDimension: held.desc.ViewDimension,
                ...unionOf(held.desc),
            });
        },
    });

    const renderTargetViewInterfaces = viewInterfaces(IID.ID3D10RenderTargetView, desc=>({
        u0: desc.MipSlice ?? desc.ElementOffset ?? 0,
        u1: desc.FirstArraySlice ?? desc.ElementWidth ?? 0,
        u2: desc.ArraySize ?? 0,
    }));
    const depthStencilViewInterfaces = viewInterfaces(IID.ID3D10DepthStencilView, desc=>({
        u0: desc.MipSlice ?? 0,
        u1: desc.FirstArraySlice ?? 0,
        u2: desc.ArraySize ?? 0,
    }));
    const shaderResourceViewInterfaces = viewInterfaces(IID.ID3D10ShaderResourceView, desc=>({
        u0: desc.MostDetailedMip ?? desc.ElementOffset ?? 0,
        u1: desc.MipLevels ?? desc.ElementWidth ?? 0,
        u2: desc.FirstArraySlice ?? 0,
        u3: desc.ArraySize ?? 0,
    }));

    /**
     * @param {string} id
     * @param {(desc: any, out: number) => void} write
     */
    const stateInterfaces = (id, write)=>describeAll([
        [id, ID3D10STATE_SLOTS], [IID.ID3D10DeviceChild, ID3D10DEVICECHILD_SLOTS],
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
    });

    const blendStateInterfaces = stateInterfaces(IID.ID3D10BlendState, (desc, out)=>{
        fields.writeStruct(out, D3D10_BLEND_DESC, {
            AlphaToCoverageEnable: desc.AlphaToCoverageEnable ? 1 : 0,
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
                desc.BlendEnable[index] ? 1 : 0);
        }
        memory.writeMemory(out + D3D10_BLEND_DESC.RenderTargetWriteMask,
            Uint8Array.from(desc.RenderTargetWriteMask));
    });
    const depthStencilStateInterfaces = stateInterfaces(IID.ID3D10DepthStencilState, (desc, out)=>{
        fields.writeStruct(out, D3D10_DEPTH_STENCIL_DESC, {
            DepthEnable: desc.DepthEnable ? 1 : 0,
            DepthWriteMask: desc.DepthWriteMask,
            DepthFunc: desc.DepthFunc,
            StencilEnable: desc.StencilEnable ? 1 : 0,
        });
        memory.writeMemory(out + D3D10_DEPTH_STENCIL_DESC.StencilReadMask,
            Uint8Array.from([desc.StencilReadMask, desc.StencilWriteMask, 0, 0]));
        fields.writeStruct(out + D3D10_DEPTH_STENCIL_DESC.FrontFace, STENCIL_FACE, desc.FrontFace);
        fields.writeStruct(out + D3D10_DEPTH_STENCIL_DESC.BackFace, STENCIL_FACE, desc.BackFace);
    });
    const rasterizerStateInterfaces = stateInterfaces(IID.ID3D10RasterizerState, (desc, out)=>{
        fields.writeStruct(out, D3D10_RASTERIZER_DESC, {
            FillMode: desc.FillMode,
            CullMode: desc.CullMode,
            FrontCounterClockwise: desc.FrontCounterClockwise ? 1 : 0,
            DepthBias: desc.DepthBias,
            DepthBiasClamp: desc.DepthBiasClamp,
            SlopeScaledDepthBias: desc.SlopeScaledDepthBias,
            DepthClipEnable: desc.DepthClipEnable ? 1 : 0,
            ScissorEnable: desc.ScissorEnable ? 1 : 0,
            MultisampleEnable: desc.MultisampleEnable ? 1 : 0,
            AntialiasedLineEnable: desc.AntialiasedLineEnable ? 1 : 0,
        }, ['DepthBiasClamp', 'SlopeScaledDepthBias']);
    });
    const samplerStateInterfaces = stateInterfaces(IID.ID3D10SamplerState, (desc, out)=>{
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
    });

    const childMethods = { GetDevice: getDevice, ...privateDataMethods };
    const childBase = describe(IID.ID3D10DeviceChild, ID3D10DEVICECHILD_SLOTS, childMethods);
    const vertexShaderInterfaces = [describe(IID.ID3D10VertexShader, ID3D10SHADER_SLOTS,
        childMethods), childBase];
    const geometryShaderInterfaces = [describe(IID.ID3D10GeometryShader, ID3D10SHADER_SLOTS,
        childMethods), childBase];
    const pixelShaderInterfaces = [describe(IID.ID3D10PixelShader, ID3D10SHADER_SLOTS,
        childMethods), childBase];
    const inputLayoutInterfaces = [describe(IID.ID3D10InputLayout, ID3D10SHADER_SLOTS,
        childMethods), childBase];
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
        .concat(describe(IID.ID3D10DeviceChild, ID3D10DEVICECHILD_SLOTS, queryMethods));

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
            const entry = fields.readStruct(address + index * D3D10_SUBRESOURCE_DATA.SIZE,
                D3D10_SUBRESOURCE_DATA);
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
     * @param {string[]} names  What the union's dwords are called for this view kind.
     */
    const readViewDesc = (address, names)=>{
        if ((address >>> 0) === 0)
        {
            return null;
        }
        const raw = fields.readStruct(address, VIEW_DESC);
        /** @type {Record<string, number>} */
        const desc = { Format: raw.Format, ViewDimension: raw.ViewDimension };
        names.forEach((name, index)=>{
            desc[name] = raw[`u${index}`];
        });
        return desc;
    };

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
            const raw = fields.readStruct(address + index * D3D10_INPUT_ELEMENT_DESC.SIZE,
                D3D10_INPUT_ELEMENT_DESC);
            elements.push({
                ...raw,
                SemanticName: raw.SemanticName === 0 ? '' : readCString(raw.SemanticName),
            });
        }
        return elements;
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
        const packed = formatPitch(resource.desc.Format, width, height);
        const pitch = rowPitch || packed.rowPitch;
        const slicePitch = depthPitch || pitch * packed.rows;
        return slicePitch * (depth - 1) + pitch * packed.rows;
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
     * @param {string[]} unionNames
     */
    const viewCreate = (method, interfaces, id, unionNames)=>
        /** @param {any} device @param {number[]} args */
        (device, [resourcePointer, descAt, out])=>{
            /** @type {{ view?: any }} */
            const held = {};
            const hr = device[method](publisher.objectAt(resourcePointer),
                readViewDesc(descAt, unionNames), held);
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
        describe(IID.ID3D10Device, ID3D10DEVICE_SLOTS, {
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
                ['MostDetailedMip', 'MipLevels', 'FirstArraySlice', 'ArraySize']),
            CreateRenderTargetView: viewCreate('CreateRenderTargetView',
                renderTargetViewInterfaces, IID.ID3D10RenderTargetView,
                ['MipSlice', 'FirstArraySlice', 'ArraySize']),
            CreateDepthStencilView: viewCreate('CreateDepthStencilView',
                depthStencilViewInterfaces, IID.ID3D10DepthStencilView,
                ['MipSlice', 'FirstArraySlice', 'ArraySize']),
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
            CreateGeometryShaderWithStreamOutput: (device, [, , , , , out])=>{
                if ((out >>> 0) !== 0)
                {
                    fields.writeU32(out, 0);
                }
                return device.CreateGeometryShaderWithStreamOutput(null, [], 0, {});
            },
            CreatePixelShader: shaderCreate('CreatePixelShader', pixelShaderInterfaces,
                IID.ID3D10PixelShader),
            CreateBlendState: stateCreate('CreateBlendState', readBlendDesc, blendStateInterfaces,
                IID.ID3D10BlendState, 'state'),
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
                if (hr === S_OK)
                {
                    fields.writeU32(out, held.levels ?? 0);
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
            OpenSharedResource: (device, [, , out])=>{
                if ((out >>> 0) !== 0)
                {
                    fields.writeU32(out, 0);
                }
                return device.OpenSharedResource();
            },
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
        }),

        // The same object answers as a DXGI device: what a program asks the
        // adapter through.
        ...describeAll([
            [IID.IDXGIDevice, IDXGIDEVICE_SLOTS], [IID.IDXGIDevice1, IDXGIDEVICE1_SLOTS],
            [IID.IDXGIObject, IDXGIOBJECT_SLOTS],
        ], {
            ...privateDataMethods,
            GetParent: getParent,
            /** @param {any} device @param {number[]} args */
            GetAdapter: (device, [out])=>{
                const adapter = device.adapter();
                adapter.addRef();
                return handBack(adapter, adapterInterfaces, IID.IDXGIAdapter, out);
            },
            CreateSurface: ()=>E_NOTIMPL,
            QueryResourceResidency: ()=>E_NOTIMPL,
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
    ];

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
        const options = { ...deviceOptions(), factoryOptions };
        let hr;
        let out;
        if (withSwapChain)
        {
            const [, , , , , descAt, chainAt, deviceAt] = args;
            out = deviceAt;
            hr = D3D10CreateDeviceAndSwapChain(adapter, driverType >>> 0, softwareModule,
                flags >>> 0, sdkVersion >>> 0,
                (descAt >>> 0) === 0 ? null : readSwapChainDesc(memory, descAt),
                chainOut, deviceOut, options);
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
            hr = D3D10CreateDevice(adapter, driverType >>> 0, softwareModule, flags >>> 0,
                sdkVersion >>> 0, deviceOut, options);
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
        return handBack(deviceOut.device, deviceInterfaces, IID.ID3D10Device, out);
    };

    /** @type {any[]} */
    const created = [];

    return {
        deviceInterfaces,
        swapChainInterfaces,
        factoryInterfaces,

        libraries: {
            'D3D10.dll': {
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
            },
            'DXGI.dll': {
                /** HRESULT CreateDXGIFactory(REFIID, void**) */
                CreateDXGIFactory: {
                    argBytes: 8,
                    /** @param {number[]} args */
                    handler: ([guid, out])=>{
                        const id = readGuid(memory, guid);
                        /** @type {{ object?: any }} */
                        const held = {};
                        const hr = CreateDXGIFactory(id, held, factoryOptions);
                        if (hr !== S_OK)
                        {
                            fields.writeU32(out, 0);
                            return hr;
                        }
                        return handBack(held.object, factoryInterfaces, IID.IDXGIFactory, out);
                    },
                },
                /**
                 * The first version is what this build speaks; asking for the
                 * second is refused by the same rule the object model applies.
                 */
                CreateDXGIFactory1: {
                    argBytes: 8,
                    /** @param {number[]} args */
                    handler: ([, out])=>{
                        fields.writeU32(out, 0);
                        return 0x80004002 | 0;
                    },
                },
            },
        },

        diagnostics: ()=>({
            devices: created.length,
            renderer: created.length > 0 ? created[created.length - 1].diagnostics() : null,
        }),
    };
}
