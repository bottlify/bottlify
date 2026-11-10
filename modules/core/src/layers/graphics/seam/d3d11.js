/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 11, between a guest call and the objects in `d3d10/` and
 * `d3d11/`: the same device, resources, views, states and shaders Direct3D
 * 10 is given, under Direct3D 11's interfaces.
 *
 * Direct3D 10 is the thinner of the two fronts: the device's pipeline is
 * Direct3D 11's immediate context, and a call through either version is
 * one call to the device -- the command ring (`d3d10-inguest.js`) writes one
 * record for both, and a recording sends one. What this file adds is the
 * difference in what the program hands over: a context apart from the
 * device, descriptions with a field or a dimension more, viewports in
 * floats, shaders that name class linkage, and a map on the context rather
 * than on the resource.
 *
 * Every object answers both versions' interfaces (`d3d10/com.js`), so the
 * descriptors here are added to the Direct3D 10 seam's lists for the same
 * objects, and it is that seam that publishes them (`d3d10.js`).
 */

import {
    D3D10_MAP, D3D10_RESOURCE_DIMENSION, DXGI_ERROR_INVALID_CALL, E_INVALIDARG, E_NOTIMPL,
    E_OUTOFMEMORY, IID, S_FALSE, S_OK,
} from '../d3d10/constants.js';
import { VIEW_UNION, readViewDesc, writeViewDesc } from '../d3d10/structs.js';
import { readGuid } from './ddraw.js';

// --- the interfaces, after IUnknown's three, in their headers' order ---

export const ID3D11DEVICECHILD_SLOTS = /** @type {[string, number][]} */ ([
    ['GetDevice', 1], ['GetPrivateData', 3], ['SetPrivateData', 3],
    ['SetPrivateDataInterface', 2],
]);

const ID3D11RESOURCE_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D11DEVICECHILD_SLOTS, ['GetType', 1], ['SetEvictionPriority', 1],
    ['GetEvictionPriority', 0],
]);

/** A buffer's and every texture's: a resource and its description. */
export const ID3D11RESOURCEDESC_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D11RESOURCE_SLOTS, ['GetDesc', 1],
]);

const ID3D11VIEW_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D11DEVICECHILD_SLOTS, ['GetResource', 1],
]);

/** Every view's: a view and its description. */
export const ID3D11VIEWDESC_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D11VIEW_SLOTS, ['GetDesc', 1],
]);

/** Every state's, and a counter's: a child and its description. */
const ID3D11CHILDDESC_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D11DEVICECHILD_SLOTS, ['GetDesc', 1],
]);

/** Direct3D 11.1's blend and rasterizer states: the description in its newer form too. */
const ID3D11STATE1_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D11CHILDDESC_SLOTS, ['GetDesc1', 1],
]);

const ID3D11ASYNCHRONOUS_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D11DEVICECHILD_SLOTS, ['GetDataSize', 0],
]);

/** A query's and a predicate's. */
const ID3D11QUERY_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D11ASYNCHRONOUS_SLOTS, ['GetDesc', 1],
]);

const ID3D11CLASSLINKAGE_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D11DEVICECHILD_SLOTS, ['GetClassInstance', 3], ['CreateClassInstance', 6],
]);

const ID3D11COMMANDLIST_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D11DEVICECHILD_SLOTS, ['GetContextFlags', 0],
]);

export const ID3D11DEVICE_SLOTS = /** @type {[string, number][]} */ ([
    ['CreateBuffer', 3], ['CreateTexture1D', 3], ['CreateTexture2D', 3], ['CreateTexture3D', 3],
    ['CreateShaderResourceView', 3], ['CreateUnorderedAccessView', 3],
    ['CreateRenderTargetView', 3], ['CreateDepthStencilView', 3], ['CreateInputLayout', 5],
    ['CreateVertexShader', 4], ['CreateGeometryShader', 4],
    ['CreateGeometryShaderWithStreamOutput', 9], ['CreatePixelShader', 4],
    ['CreateHullShader', 4], ['CreateDomainShader', 4], ['CreateComputeShader', 4],
    ['CreateClassLinkage', 1], ['CreateBlendState', 2], ['CreateDepthStencilState', 2],
    ['CreateRasterizerState', 2], ['CreateSamplerState', 2], ['CreateQuery', 2],
    ['CreatePredicate', 2], ['CreateCounter', 2], ['CreateDeferredContext', 2],
    ['OpenSharedResource', 3], ['CheckFormatSupport', 2], ['CheckMultisampleQualityLevels', 3],
    ['CheckCounterInfo', 1], ['CheckCounter', 9], ['CheckFeatureSupport', 3],
    ['GetPrivateData', 3], ['SetPrivateData', 3], ['SetPrivateDataInterface', 2],
    ['GetFeatureLevel', 0], ['GetCreationFlags', 0], ['GetDeviceRemovedReason', 0],
    ['GetImmediateContext', 1], ['SetExceptionMode', 1], ['GetExceptionMode', 0],
]);

/**
 * ID3D11DeviceContext after ID3D11DeviceChild: 108 slots. Its setters and
 * draws are Direct3D 10's device's, in another order and with the stages
 * Direct3D 11 added between them.
 */
export const ID3D11DEVICECONTEXT_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D11DEVICECHILD_SLOTS,
    ['VSSetConstantBuffers', 3], ['PSSetShaderResources', 3], ['PSSetShader', 3],
    ['PSSetSamplers', 3], ['VSSetShader', 3], ['DrawIndexed', 3], ['Draw', 2], ['Map', 5],
    ['Unmap', 2], ['PSSetConstantBuffers', 3], ['IASetInputLayout', 1],
    ['IASetVertexBuffers', 5], ['IASetIndexBuffer', 3], ['DrawIndexedInstanced', 5],
    ['DrawInstanced', 4], ['GSSetConstantBuffers', 3], ['GSSetShader', 3],
    ['IASetPrimitiveTopology', 1], ['VSSetShaderResources', 3], ['VSSetSamplers', 3],
    ['Begin', 1], ['End', 1], ['GetData', 4], ['SetPredication', 2],
    ['GSSetShaderResources', 3], ['GSSetSamplers', 3], ['OMSetRenderTargets', 3],
    ['OMSetRenderTargetsAndUnorderedAccessViews', 7], ['OMSetBlendState', 3],
    ['OMSetDepthStencilState', 2], ['SOSetTargets', 3], ['DrawAuto', 0],
    ['DrawIndexedInstancedIndirect', 2], ['DrawInstancedIndirect', 2], ['Dispatch', 3],
    ['DispatchIndirect', 2], ['RSSetState', 1], ['RSSetViewports', 2], ['RSSetScissorRects', 2],
    ['CopySubresourceRegion', 8], ['CopyResource', 2], ['UpdateSubresource', 6],
    ['CopyStructureCount', 3], ['ClearRenderTargetView', 2],
    ['ClearUnorderedAccessViewUint', 2], ['ClearUnorderedAccessViewFloat', 2],
    ['ClearDepthStencilView', 4], ['GenerateMips', 1], ['SetResourceMinLOD', 2],
    ['GetResourceMinLOD', 1], ['ResolveSubresource', 5], ['ExecuteCommandList', 2],
    ['HSSetShaderResources', 3], ['HSSetShader', 3], ['HSSetSamplers', 3],
    ['HSSetConstantBuffers', 3], ['DSSetShaderResources', 3], ['DSSetShader', 3],
    ['DSSetSamplers', 3], ['DSSetConstantBuffers', 3], ['CSSetShaderResources', 3],
    ['CSSetUnorderedAccessViews', 4], ['CSSetShader', 3], ['CSSetSamplers', 3],
    ['CSSetConstantBuffers', 3], ['VSGetConstantBuffers', 3], ['PSGetShaderResources', 3],
    ['PSGetShader', 3], ['PSGetSamplers', 3], ['VSGetShader', 3], ['PSGetConstantBuffers', 3],
    ['IAGetInputLayout', 1], ['IAGetVertexBuffers', 5], ['IAGetIndexBuffer', 3],
    ['GSGetConstantBuffers', 3], ['GSGetShader', 3], ['IAGetPrimitiveTopology', 1],
    ['VSGetShaderResources', 3], ['VSGetSamplers', 3], ['GetPredication', 2],
    ['GSGetShaderResources', 3], ['GSGetSamplers', 3], ['OMGetRenderTargets', 3],
    ['OMGetRenderTargetsAndUnorderedAccessViews', 6], ['OMGetBlendState', 3],
    ['OMGetDepthStencilState', 2], ['SOGetTargets', 2], ['RSGetState', 1],
    ['RSGetViewports', 2], ['RSGetScissorRects', 2], ['HSGetShaderResources', 3],
    ['HSGetShader', 3], ['HSGetSamplers', 3], ['HSGetConstantBuffers', 3],
    ['DSGetShaderResources', 3], ['DSGetShader', 3], ['DSGetSamplers', 3],
    ['DSGetConstantBuffers', 3], ['CSGetShaderResources', 3], ['CSGetUnorderedAccessViews', 3],
    ['CSGetShader', 3], ['CSGetSamplers', 3], ['CSGetConstantBuffers', 3], ['ClearState', 0],
    ['Flush', 0], ['GetType', 0], ['GetContextFlags', 0], ['FinishCommandList', 2],
]);

/** ID3D11DeviceContext1, Direct3D 11.1's: copies with flags, discards, offset constants. */
export const ID3D11DEVICECONTEXT1_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D11DEVICECONTEXT_SLOTS,
    ['CopySubresourceRegion1', 9], ['UpdateSubresource1', 7], ['DiscardResource', 1],
    ['DiscardView', 1], ['VSSetConstantBuffers1', 5], ['HSSetConstantBuffers1', 5],
    ['DSSetConstantBuffers1', 5], ['GSSetConstantBuffers1', 5], ['PSSetConstantBuffers1', 5],
    ['CSSetConstantBuffers1', 5], ['VSGetConstantBuffers1', 5], ['HSGetConstantBuffers1', 5],
    ['DSGetConstantBuffers1', 5], ['GSGetConstantBuffers1', 5], ['PSGetConstantBuffers1', 5],
    ['CSGetConstantBuffers1', 5], ['SwapDeviceContextState', 2], ['ClearView', 4],
    ['DiscardView1', 3],
]);

/** ID3D11Device1, Direct3D 11.1's device. */
export const ID3D11DEVICE1_SLOTS = /** @type {[string, number][]} */ ([
    ...ID3D11DEVICE_SLOTS,
    ['GetImmediateContext1', 1], ['CreateDeferredContext1', 2], ['CreateBlendState1', 2],
    ['CreateRasterizerState1', 2], ['CreateDeviceContextState', 7], ['OpenSharedResource1', 3],
]);

/** ID3DUserDefinedAnnotation, which a context answers to. */
const ID3DUSERDEFINEDANNOTATION_SLOTS = /** @type {[string, number][]} */ ([
    ['BeginEvent', 1], ['EndEvent', 0], ['SetMarker', 1], ['GetStatus', 0],
]);

/** ID3D11Multithread, whose identifier is ID3D10Multithread's. */
const ID3D11MULTITHREAD_SLOTS = /** @type {[string, number][]} */ ([
    ['Enter', 0], ['Leave', 0], ['SetMultithreadProtected', 1], ['GetMultithreadProtected', 0],
]);

// --- structures, by offset ---

const D3D11_BUFFER_DESC = Object.freeze({
    ByteWidth: 0x00, Usage: 0x04, BindFlags: 0x08, CPUAccessFlags: 0x0c, MiscFlags: 0x10,
    StructureByteStride: 0x14, SIZE: 0x18,
});

/** D3D11_RENDER_TARGET_BLEND_DESC1: 10.1's target, with a logic operation. */
const RENDER_TARGET_BLEND_DESC1 = Object.freeze({
    BlendEnable: 0x00, LogicOpEnable: 0x04, SrcBlend: 0x08, DestBlend: 0x0c, BlendOp: 0x10,
    SrcBlendAlpha: 0x14, DestBlendAlpha: 0x18, BlendOpAlpha: 0x1c, LogicOp: 0x20,
    RenderTargetWriteMask: 0x24, SIZE: 0x28,
});

/** D3D11_RASTERIZER_DESC1's last field, past Direct3D 10's ten. */
const FORCED_SAMPLE_COUNT = 0x28;

const D3D11_VIEWPORT = Object.freeze({
    TopLeftX: 0x00, TopLeftY: 0x04, Width: 0x08, Height: 0x0c, MinDepth: 0x10, MaxDepth: 0x14,
    SIZE: 0x18,
});
const VIEWPORT_FLOATS = ['TopLeftX', 'TopLeftY', 'Width', 'Height', 'MinDepth', 'MaxDepth'];

/**
 * D3D11_RESOURCE_MISC_* as the device keeps them: Direct3D 10's numbers for
 * what both versions have -- 11 moved the keyed mutex and GDI's flags up --
 * and Direct3D 11's own flags apart, in `MiscFlags11`.
 *
 * @param {number} flags @returns {{ MiscFlags: number, MiscFlags11: number }}
 */
export function miscFlagsIn(flags){
    return {
        MiscFlags: (flags & 0x7) | ((flags & 0x100) !== 0 ? 0x10 : 0)
            | ((flags & 0x200) !== 0 ? 0x20 : 0),
        MiscFlags11: (flags & ~(0x7 | 0x100 | 0x200)) >>> 0,
    };
}

/** @param {{ MiscFlags: number, MiscFlags11?: number }} desc @returns {number} */
export function miscFlagsOut(desc){
    return ((desc.MiscFlags & 0x7) | ((desc.MiscFlags & 0x10) !== 0 ? 0x100 : 0)
        | ((desc.MiscFlags & 0x20) !== 0 ? 0x200 : 0) | (desc.MiscFlags11 ?? 0)) >>> 0;
}

/** D3D11_MAP_FLAG_DO_NOT_WAIT. */
const MAP_DO_NOT_WAIT = 0x100000;
/** A deferred context's WRITE_NO_OVERWRITE before its first WRITE_DISCARD of the buffer. */
const D3D11_ERROR_DEFERRED_CONTEXT_MAP_WITHOUT_INITIAL_DISCARD = 0x887c0004 | 0;

/** D3D11_VIEWPORT_AND_SCISSORRECT_OBJECT_COUNT_PER_PIPELINE. */
const VIEWPORT_SLOTS = 16;

/** Each kind of view: its description, its interface, and the core's create. */
const VIEWS = Object.freeze({
    srv: { union: VIEW_UNION.SHADER_RESOURCE11, iid: IID.ID3D11ShaderResourceView },
    rtv: { union: VIEW_UNION.RENDER_TARGET, iid: IID.ID3D11RenderTargetView },
    dsv: { union: VIEW_UNION.DEPTH_STENCIL11, iid: IID.ID3D11DepthStencilView },
    uav: { union: VIEW_UNION.UNORDERED_ACCESS, iid: IID.ID3D11UnorderedAccessView },
});

/** A resource's Direct3D 11 interface, by its dimension. */
const RESOURCE_IID = Object.freeze({
    [D3D10_RESOURCE_DIMENSION.BUFFER]: IID.ID3D11Buffer,
    [D3D10_RESOURCE_DIMENSION.TEXTURE1D]: IID.ID3D11Texture1D,
    [D3D10_RESOURCE_DIMENSION.TEXTURE2D]: IID.ID3D11Texture2D,
    [D3D10_RESOURCE_DIMENSION.TEXTURE3D]: IID.ID3D11Texture3D,
});

/** The six stages, by the prefix their methods carry, and their shaders' interfaces. */
const STAGE_SHADERS = Object.freeze({
    VS: IID.ID3D11VertexShader, HS: IID.ID3D11HullShader, DS: IID.ID3D11DomainShader,
    GS: IID.ID3D11GeometryShader, PS: IID.ID3D11PixelShader, CS: IID.ID3D11ComputeShader,
});

/**
 * What the Direct3D 10 seam lends this one: its publisher and fields, its
 * readers and writers of the descriptions the two versions share, its
 * hand-backs, and the interface lists the objects are published with --
 * which this file's descriptors are part of, so they are read when a call
 * runs, never when the descriptors are made.
 *
 * @typedef {Object} Direct3D11Kit
 * @property {any} publisher
 * @property {any} memory
 * @property {ReturnType<typeof import('./structs.js').createFields>} fields
 * @property {(object: any, interfaces: any[], id: string, out: number) => number} handBack
 * @property {(address: number, objects: any[], interfaces: any[], id: string) => void}
 *     writeObjects
 * @property {(address: number, count: number) => any[]} readObjects
 * @property {4 | 8} pointerSize  8 in a 64-bit process
 * @property {(address: number, value: number) => void} writePointer  a pointer out, whole
 * @property {(address: number, count: number) => number[]} readDwords
 * @property {(address: number, count: number) => number[]} readFloats
 * @property {Record<string, Function>} privateDataMethods
 * @property {(address: number, desc: any, dimension: number) => any} readInitialData
 * @property {(address: number) => any} readTexture2DDesc
 * @property {(at: number, count: number, streamed: boolean) =>
 *     import('../d3d10/streamout.js').StreamOutputEntry[] | null} readStreamOutput
 * @property {(address: number) => any} readTexture1DDesc
 * @property {(address: number) => any} readTexture3DDesc
 * @property {(texture: any, out: number) => void} writeTextureDesc
 * @property {(address: number) => any} readBox
 * @property {(resource: any, subresource: number, box: any, rowPitch: number,
 *     depthPitch: number) => number} updateBytesOf
 * @property {(address: number, count: number) => object[]} readInputElements
 * @property {(address: number, count: number) => object[]} readRects
 * @property {(address: number) => any} readBlendDesc1
 * @property {(address: number) => any} readDepthStencilDesc
 * @property {(address: number) => any} readRasterizerDesc
 * @property {(address: number) => any} readSamplerDesc
 * @property {(desc: any, out: number) => void} writeBlendDesc1
 * @property {(desc: any, out: number) => void} writeDepthStencilDesc
 * @property {(desc: any, out: number) => void} writeRasterizerDesc
 * @property {(desc: any, out: number) => void} writeSamplerDesc
 * @property {(address: number) => any} readQueryDesc
 * @property {(desc: any, out: number) => void} writeQueryDesc
 * @property {(resource: any, subresource: number, mapType: number, flags: number,
 *     use: (mapped: { hr: number, address: number, rowPitch: number, depthPitch: number })
 *     => number) => number | Promise<number>} mapInto
 * @property {(resource: any, subresource: number) => void} unmapFrom
 * @property {(resource: any, flags: number, run: () => number | Promise<number>) =>
 *     number | Promise<number>}
 *     whenMappable
 * @property {(object: any) => any} ringOf
 * @property {(buffer: any) => void} countUnattached
 * @property {(device: any) => void} attachRing
 * @property {(device: any, buffer: any) => void} attachBuffer
 * @property {(device: any) => void} created
 * @property {(swapChain: any, device: any) => void} pairSwapChain
 * @property {(address: number) => any} readSwapChainDesc  sized to the window
 * @property {() => any} root
 * @property {(value: number) => void} [floatResult]
 * @property {(detail: string) => void} diverge
 * @property {(detail: string) => void} lose  what a program made that did not happen, said as lost
 * @property {((bytes: number) => number) | undefined} allocate  guest memory, for a deferred map
 * @property {((address: number) => void) | undefined} free
 * @property {Record<string, any[]>} lists  the published interface lists, by kind
 * @property {(resource: any) => any[]} resourceInterfaces
 * @property {(device: any, method: string, key: number | null, iid: number, out: number)
 *     => number} openShared  A device's object over a shared texture (`d3d10.js`).
 * @property {(handle: number) => number | null} sharedKeyOf  What an NT handle names.
 */

/**
 * @param {(id: string, slots: [string, number][], implemented: Record<string, any>,
 *     guests?: Record<string, (builder: { trap: number }) => number>,
 *     released?: (target: any, pointers: Iterable<number>) => void) => any} describe
 *     the Direct3D 10 seam's: each method made after the device rings are played
 * @param {() => Direct3D11Kit} kit
 * @param {{ context: Record<string, (builder: { trap: number }) => number> }} guests
 *     the context's methods that run in the guest
 */
export function createDirect3D11Seam(describe, kit, guests){
    const k = kit;
    /** @param {number} address */
    const isNull = address=>(address >>> 0) === 0;
    /** @param {number} address */
    const guidAt = address=>readGuid(k().memory, address);

    // --- children ---

    /** @param {any} child @param {number[]} args */
    const getDevice = (child, [out])=>{
        /** @type {{ device?: any }} */
        const held = {};
        child.GetDevice(held);
        k().handBack(held.device, k().lists.device, IID.ID3D11Device, out);
    };
    /** Each private-data method, read when it is called. */
    const privateData = Object.fromEntries(['SetPrivateData', 'SetPrivateDataInterface',
        'GetPrivateData'].map(name=>[name, (/** @type {any} */ object,
        /** @type {number[]} */ args)=>k().privateDataMethods[name](object, args)]));
    const childMethods = { GetDevice: getDevice, ...privateData };
    const childFace = describe(IID.ID3D11DeviceChild, ID3D11DEVICECHILD_SLOTS, childMethods);

    // --- resources ---

    /** @param {any} resource @param {number} out */
    const handBackResource = (resource, out)=>k().handBack(resource,
        k().resourceInterfaces(resource),
        /** @type {Record<number, string>} */ (RESOURCE_IID)[resource.dimension], out);

    const resourceMethods = {
        ...childMethods,
        /** @param {any} resource @param {number[]} args */
        GetType: (resource, [out])=>{
            k().fields.writeU32(out, resource.dimension);
        },
        /** @param {any} resource @param {number[]} args */
        SetEvictionPriority: (resource, [priority])=>{
            resource.SetEvictionPriority(priority >>> 0);
        },
        /** @param {any} resource */
        GetEvictionPriority: resource=>resource.GetEvictionPriority(),
    };
    const resourceBases = [
        describe(IID.ID3D11Resource, ID3D11RESOURCE_SLOTS, resourceMethods),
        describe(IID.ID3D11DeviceChild, ID3D11DEVICECHILD_SLOTS, resourceMethods),
    ];
    const buffer = [describe(IID.ID3D11Buffer, ID3D11RESOURCEDESC_SLOTS, {
        ...resourceMethods,
        /** @param {any} resource @param {number[]} args */
        GetDesc: (resource, [out])=>{
            k().fields.writeStruct(out, D3D11_BUFFER_DESC, {
                ...resource.desc, MiscFlags: miscFlagsOut(resource.desc),
                StructureByteStride: resource.desc.StructureByteStride ?? 0,
            });
        },
    }), ...resourceBases];
    /** @param {string} id */
    const texture = id=>[describe(id, ID3D11RESOURCEDESC_SLOTS, {
        ...resourceMethods,
        /** @param {any} resource @param {number[]} args */
        GetDesc: (resource, [out])=>{
            k().writeTextureDesc({ ...resource,
                desc: { ...resource.desc, MiscFlags: miscFlagsOut(resource.desc) } }, out);
        },
    }), ...resourceBases];

    // --- views ---

    /** @param {keyof typeof VIEWS} kind */
    const view = kind=>{
        const methods = {
            ...childMethods,
            /** @param {any} object @param {number[]} args */
            GetResource: (object, [out])=>{
                /** @type {{ resource?: any }} */
                const held = {};
                object.GetResource(held);
                handBackResource(held.resource, out);
            },
            /** @param {any} object @param {number[]} args */
            GetDesc: (object, [out])=>{
                /** @type {{ desc?: any }} */
                const held = {};
                object.GetDesc(held);
                writeViewDesc(k().memory, out, VIEWS[kind].union, held.desc);
            },
        };
        return [describe(VIEWS[kind].iid, ID3D11VIEWDESC_SLOTS, methods),
            describe(IID.ID3D11View, ID3D11VIEW_SLOTS, methods),
            describe(IID.ID3D11DeviceChild, ID3D11DEVICECHILD_SLOTS, methods)];
    };

    // --- states, shaders, layouts, queries ---

    /** @param {string} id @param {(state: any, out: number) => void} write */
    const state = (id, write)=>[describe(id, ID3D11CHILDDESC_SLOTS, {
        ...childMethods,
        /** @param {any} object @param {number[]} args */
        GetDesc: (object, [out])=>{
            write(object, out);
        },
    }), childFace];
    /** @param {string} id */
    const child = id=>[describe(id, ID3D11DEVICECHILD_SLOTS, childMethods), childFace];
    const queryMethods = {
        ...childMethods,
        /** @param {any} query */
        GetDataSize: query=>query.GetDataSize(),
        /** @param {any} query @param {number[]} args */
        GetDesc: (query, [out])=>{
            k().writeQueryDesc(query.desc, out);
        },
    };
    const query = [IID.ID3D11Query, IID.ID3D11Predicate]
        .map(id=>describe(id, ID3D11QUERY_SLOTS, queryMethods))
        .concat(describe(IID.ID3D11Asynchronous, ID3D11ASYNCHRONOUS_SLOTS, queryMethods),
            childFace);
    const classLinkage = [describe(IID.ID3D11ClassLinkage, ID3D11CLASSLINKAGE_SLOTS, {
        ...childMethods,
        /** @param {any} linkage @param {number[]} args */
        GetClassInstance: (linkage, [, , out])=>{
            k().fields.writeU32(out, 0);
            return E_INVALIDARG;
        },
        /** @param {any} linkage @param {number[]} args */
        CreateClassInstance: (linkage, [, , , , , out])=>{
            k().fields.writeU32(out, 0);
            k().diverge('a class instance is not made: shaders here link no classes');
            return E_NOTIMPL;
        },
    }), childFace];
    const contextStateFaces = [describe(IID.ID3DDeviceContextState, ID3D11DEVICECHILD_SLOTS,
        childMethods), childFace];
    const commandList = [describe(IID.ID3D11CommandList, ID3D11COMMANDLIST_SLOTS, {
        ...childMethods,
        /** @param {any} list */
        GetContextFlags: list=>list.GetContextFlags(),
    }), childFace];

    // --- the device ---

    /** @param {number} at @returns {Uint8Array | null} */
    const bytecodeAt = (at, length = 0)=>(isNull(at) ? null
        : k().memory.readMemory(at >>> 0, length >>> 0));

    /**
     * A create's failure: the out pointer cleared, the answer given.
     *
     * @param {number} out @param {number} hr
     */
    const failed = (out, hr)=>{
        if (!isNull(out))
        {
            k().fields.writeU32(out, 0);
        }
        return hr;
    };

    /** @param {string} method @param {string} list @param {string} id */
    const shaderCreate = (method, list, id)=>
        /** @param {any} device @param {number[]} args */
        (device, [code, length, , out])=>{
            /** @type {{ shader?: any }} */
            const held = {};
            const hr = device[method](bytecodeAt(code, length), held);
            return hr === S_OK ? k().handBack(held.shader, k().lists[list], id, out)
                : failed(out, hr);
        };

    /**
     * @param {string} method @param {(at: number) => any} read @param {string} list
     * @param {string} id
     */
    const stateCreate = (method, read, list, id)=>
        /** @param {any} device @param {number[]} args */
        (device, [descAt, out])=>{
            /** @type {{ state?: any }} */
            const held = {};
            const hr = device[method](isNull(descAt) ? null : read(descAt), held);
            return hr === S_OK ? k().handBack(held.state, k().lists[list], id, out)
                : failed(out, hr);
        };

    /** @param {keyof typeof VIEWS} kind @param {string} method @param {string} list */
    const viewCreate = (kind, method, list)=>
        /** @param {any} device @param {number[]} args */
        (device, [resourceAt, descAt, out])=>{
            /** @type {{ view?: any }} */
            const held = {};
            const hr = device[method](k().publisher.objectAt(resourceAt),
                isNull(descAt) ? null : readViewDesc(k().memory, descAt, VIEWS[kind].union),
                held);
            return hr === S_OK ? k().handBack(held.view, k().lists[list], VIEWS[kind].iid, out)
                : failed(out, hr);
        };

    /** @param {string} method @param {number} dimension @param {(at: number) => any} read */
    const textureCreate = (method, dimension, read)=>
        /** @param {any} device @param {number[]} args */
        (device, [descAt, dataAt, out])=>{
            const desc = isNull(descAt) ? null : read(descAt);
            /** @type {{ resource?: any }} */
            const held = {};
            const hr = device[method](desc, desc ? k().readInitialData(dataAt, desc, dimension)
                : null, held);
            return hr === S_OK ? handBackResource(held.resource, out) : failed(out, hr);
        };

    /** @param {any} desc a description as the program wrote it */
    const miscIn = desc=>({ ...desc, ...miscFlagsIn(desc.MiscFlags) });

    /** @param {any} device */
    const contextOf = device=>{
        const context = device.immediateContext();
        context.guestState ??= device.guestState;
        return context;
    };

    /**
     * Constants a buffer is bound from part of: Direct3D 11.1's offsets,
     * which this device says it does not take (D3D11_FEATURE_D3D11_OPTIONS),
     * so a program that names them anyway has the whole buffer bound.
     *
     * @param {number} first @param {number} constants @param {number} count
     */
    const offsetsIgnored = (first, constants, count)=>{
        if (isNull(first) && isNull(constants))
        {
            return;
        }
        const firsts = isNull(first) ? [] : k().readDwords(first, count >>> 0);
        if (firsts.some(value=>value !== 0))
        {
            k().diverge('constant buffer offsets are ignored: the whole buffer is bound');
        }
    };

    /**
     * XSSetConstantBuffers1(start, count, buffers, firstConstants, numConstants).
     *
     * @param {string} stage
     */
    const setConstantBuffers1 = stage=>
        /** @param {any} target @param {number[]} args */
        (target, [start, count, buffers, first, constants])=>{
            offsetsIgnored(first, constants, count);
            target[`${stage}SetConstantBuffers`](start >>> 0,
                k().readObjects(buffers, count >>> 0));
        };

    /**
     * XSGetConstantBuffers1: the buffers, each bound whole -- from its first
     * constant, for the most a binding sees.
     *
     * @param {string} stage
     */
    const getConstantBuffers1 = stage=>
        /** @param {any} target @param {number[]} args */
        (target, [start, count, out, first, constants])=>{
            /** @type {{ buffers?: any[] }} */
            const held = {};
            target[`${stage}GetConstantBuffers`](start >>> 0, count >>> 0, held);
            k().writeObjects(out, held.buffers ?? [], k().lists.buffer, IID.ID3D11Buffer);
            for (let index = 0; index < (count >>> 0); index++)
            {
                if (!isNull(first))
                {
                    k().fields.writeU32(first + index * 4, 0);
                }
                if (!isNull(constants))
                {
                    k().fields.writeU32(constants + index * 4, 4096);
                }
            }
        };

    const deviceMethods = {
        ...privateData,
        /** @param {any} device @param {number[]} args */
        CreateBuffer: (device, [descAt, dataAt, out])=>{
            const desc = isNull(descAt) ? null
                : miscIn(k().fields.readStruct(descAt, D3D11_BUFFER_DESC));
            /** @type {{ resource?: any }} */
            const held = {};
            const hr = device.CreateBuffer(desc, desc ? k().readInitialData(dataAt, desc,
                D3D10_RESOURCE_DIMENSION.BUFFER) : null, held);
            if (hr !== S_OK)
            {
                return failed(out, hr);
            }
            k().attachBuffer(device, held.resource);
            return handBackResource(held.resource, out);
        },
        CreateTexture1D: textureCreate('CreateTexture1D', D3D10_RESOURCE_DIMENSION.TEXTURE1D,
            at=>miscIn(k().readTexture1DDesc(at))),
        CreateTexture2D: textureCreate('CreateTexture2D', D3D10_RESOURCE_DIMENSION.TEXTURE2D,
            at=>miscIn(k().readTexture2DDesc(at))),
        CreateTexture3D: textureCreate('CreateTexture3D', D3D10_RESOURCE_DIMENSION.TEXTURE3D,
            at=>miscIn(k().readTexture3DDesc(at))),
        CreateShaderResourceView: viewCreate('srv', 'CreateShaderResourceView', 'srv'),
        CreateUnorderedAccessView: viewCreate('uav', 'CreateUnorderedAccessView', 'uav'),
        CreateRenderTargetView: viewCreate('rtv', 'CreateRenderTargetView', 'rtv'),
        CreateDepthStencilView: viewCreate('dsv', 'CreateDepthStencilView', 'dsv'),
        /** @param {any} device @param {number[]} args */
        CreateInputLayout: (device, [elements, count, code, length, out])=>{
            /** @type {{ layout?: any }} */
            const held = {};
            const hr = device.CreateInputLayout(isNull(elements) ? null
                : k().readInputElements(elements, count >>> 0), bytecodeAt(code, length), held);
            return hr === S_OK
                ? k().handBack(held.layout, k().lists.inputLayout, IID.ID3D11InputLayout, out)
                : failed(out, hr);
        },
        CreateVertexShader: shaderCreate('CreateVertexShader', 'vs', IID.ID3D11VertexShader),
        CreateGeometryShader: shaderCreate('CreateGeometryShader', 'gs',
            IID.ID3D11GeometryShader),
        /** @param {any} device @param {number[]} args */
        CreateGeometryShaderWithStreamOutput: (device,
            [code, length, declarationAt, count, stridesAt, strideCount, rasterizedStream, ,
                out])=>
        {
            /** @type {{ shader?: any }} */
            const held = {};
            const strides = isNull(stridesAt) ? null : Array.from({ length: strideCount >>> 0 },
                (_, index)=>k().fields.readU32(stridesAt + index * 4));
            const hr = device.CreateGeometryShaderWithStreamOutput(bytecodeAt(code, length),
                k().readStreamOutput(declarationAt, count, true), strides, rasterizedStream >>> 0,
                held);
            return hr === S_OK ? k().handBack(held.shader, k().lists.gs, IID.ID3D11GeometryShader,
                out) : failed(out, hr);
        },
        CreatePixelShader: shaderCreate('CreatePixelShader', 'ps', IID.ID3D11PixelShader),
        CreateHullShader: shaderCreate('CreateHullShader', 'hs', IID.ID3D11HullShader),
        CreateDomainShader: shaderCreate('CreateDomainShader', 'ds', IID.ID3D11DomainShader),
        CreateComputeShader: shaderCreate('CreateComputeShader', 'cs', IID.ID3D11ComputeShader),
        /** @param {any} device @param {number[]} args */
        CreateClassLinkage: (device, [out])=>{
            if (isNull(out))
            {
                return E_INVALIDARG;
            }
            /** @type {{ linkage?: any }} */
            const held = {};
            device.CreateClassLinkage(held);
            return k().handBack(held.linkage, classLinkage, IID.ID3D11ClassLinkage, out);
        },
        // Direct3D 11's blend description is 10.1's: a target's state each.
        CreateBlendState: stateCreate('CreateBlendState1', at=>k().readBlendDesc1(at), 'blend',
            IID.ID3D11BlendState),
        CreateDepthStencilState: stateCreate('CreateDepthStencilState',
            at=>k().readDepthStencilDesc(at), 'depthStencil', IID.ID3D11DepthStencilState),
        CreateRasterizerState: stateCreate('CreateRasterizerState',
            at=>k().readRasterizerDesc(at), 'rasterizer', IID.ID3D11RasterizerState),
        CreateSamplerState: stateCreate('CreateSamplerState', at=>k().readSamplerDesc(at),
            'sampler', IID.ID3D11SamplerState),
        /** @param {any} device @param {number[]} args */
        CreateQuery: (device, [descAt, out])=>{
            /** @type {{ query?: any }} */
            const held = {};
            const hr = device.CreateQuery(isNull(descAt) ? null : k().readQueryDesc(descAt),
                isNull(out) ? null : held);
            return hr === S_OK && held.query
                ? k().handBack(held.query, k().lists.query, IID.ID3D11Query, out)
                : failed(out, hr);
        },
        /** @param {any} device @param {number[]} args */
        CreatePredicate: (device, [descAt, out])=>{
            /** @type {{ query?: any }} */
            const held = {};
            const hr = device.CreatePredicate(isNull(descAt) ? null
                : k().readQueryDesc(descAt), isNull(out) ? null : held);
            return hr === S_OK && held.query
                ? k().handBack(held.query, k().lists.query, IID.ID3D11Predicate, out)
                : failed(out, hr);
        },
        /** @param {any} device @param {number[]} args */
        CreateCounter: (device, [descAt, out])=>failed(out,
            device.CreateCounter(isNull(descAt) ? null : {}, null)),
        /** @param {any} device @param {number[]} args */
        CreateDeferredContext: (device, [flags, out])=>{
            if (isNull(out))
            {
                return E_INVALIDARG;
            }
            /** @type {{ context?: any }} */
            const held = {};
            const hr = device.CreateDeferredContext(flags >>> 0, held);
            return hr === S_OK ? k().handBack(held.context, context, IID.ID3D11DeviceContext,
                out) : failed(out, hr);
        },
        /** @param {any} device @param {number[]} args */
        OpenSharedResource: (device, [handle, iid, out])=>
            k().openShared(device, 'OpenSharedResource', handle >>> 0, iid, out),
        /** @param {any} device @param {number[]} args */
        CheckFormatSupport: (device, [format, out])=>{
            /** @type {{ support?: number }} */
            const held = {};
            const hr = device.CheckFormatSupport(format >>> 0, isNull(out) ? null : held);
            if (!isNull(out))
            {
                k().fields.writeU32(out, held.support ?? 0);
            }
            return hr;
        },
        /** @param {any} device @param {number[]} args */
        CheckMultisampleQualityLevels: (device, [format, count, out])=>{
            /** @type {{ levels?: number }} */
            const held = {};
            const hr = device.CheckMultisampleQualityLevels(format >>> 0, count >>> 0,
                isNull(out) ? null : held);
            if (held.levels !== undefined)
            {
                k().fields.writeU32(out, held.levels);
            }
            return hr;
        },
        /** @param {any} device @param {number[]} args */
        CheckCounterInfo: (device, [out])=>{
            if (!isNull(out))
            {
                k().fields.writeU32(out, 0);
                k().fields.writeU32(out + 4, 0);
                k().fields.writeU32(out + 8, 1);
            }
        },
        /** @param {any} device */
        CheckCounter: device=>device.CheckCounter(),
        /** @param {any} device @param {number[]} args */
        CheckFeatureSupport: (device, [feature, data, size])=>{
            if (isNull(data) || (size >>> 0) === 0)
            {
                return E_INVALIDARG;
            }
            const answer = device.CheckFeatureSupport(feature >>> 0,
                k().memory.readMemory(data >>> 0, size >>> 0));
            // A failure that names its answer (a format with no support) writes it too.
            if (answer.data)
            {
                k().memory.writeMemory(data >>> 0, answer.data);
            }
            return answer.hr;
        },
        /** @param {any} device */
        GetFeatureLevel: device=>device.GetFeatureLevel(),
        /** @param {any} device */
        GetCreationFlags: device=>device.GetCreationFlags(),
        /** @param {any} device */
        GetDeviceRemovedReason: device=>device.GetDeviceRemovedReason(),
        /** @param {any} device @param {number[]} args */
        GetImmediateContext: (device, [out])=>{
            const immediate = contextOf(device);
            immediate.addRef();
            k().handBack(immediate, context, IID.ID3D11DeviceContext, out);
        },
        /** @param {any} device @param {number[]} args */
        SetExceptionMode: (device, [flags])=>device.SetExceptionMode(flags >>> 0),
        /** @param {any} device */
        GetExceptionMode: device=>device.GetExceptionMode(),

        // --- Direct3D 11.1 ---

        /** @param {any} device @param {number[]} args */
        GetImmediateContext1: (device, [out])=>{
            const immediate = contextOf(device);
            immediate.addRef();
            k().handBack(immediate, context, IID.ID3D11DeviceContext1, out);
        },
        /** @param {any} device @param {number[]} args */
        CreateDeferredContext1: (device, [flags, out])=>{
            if (isNull(out))
            {
                return E_INVALIDARG;
            }
            /** @type {{ context?: any }} */
            const held = {};
            const hr = device.CreateDeferredContext(flags >>> 0, held);
            return hr === S_OK ? k().handBack(held.context, context, IID.ID3D11DeviceContext1,
                out) : failed(out, hr);
        },
        /**
         * A logic operation in place of a blend is refused when it is asked
         * for: WebGPU has none.
         *
         * @param {any} device @param {number[]} args
         */
        CreateBlendState1: (device, [descAt, out])=>{
            if (isNull(descAt))
            {
                return failed(out, E_INVALIDARG);
            }
            for (let index = 0; index < 8; index++)
            {
                const at = descAt + 8 + index * RENDER_TARGET_BLEND_DESC1.SIZE;
                if (k().fields.readU32(at + RENDER_TARGET_BLEND_DESC1.LogicOpEnable) !== 0)
                {
                    k().diverge('a blend state with a logic operation is refused: WebGPU has'
                        + ' none');
                    return failed(out, E_INVALIDARG);
                }
            }
            /** @type {{ state?: any }} */
            const held = {};
            const hr = device.CreateBlendState1(readBlendDesc11(descAt), held);
            return hr === S_OK ? k().handBack(held.state, k().lists.blend, IID.ID3D11BlendState1,
                out) : failed(out, hr);
        },
        /**
         * A forced sample count rasterizes at a count the targets do not
         * have, which WebGPU cannot; none is the plain state.
         *
         * @param {any} device @param {number[]} args
         */
        CreateRasterizerState1: (device, [descAt, out])=>{
            if (isNull(descAt))
            {
                return failed(out, E_INVALIDARG);
            }
            if (k().fields.readU32(descAt + FORCED_SAMPLE_COUNT) !== 0)
            {
                k().diverge('a rasterizer state with a forced sample count is refused');
                return failed(out, E_INVALIDARG);
            }
            /** @type {{ state?: any }} */
            const held = {};
            const hr = device.CreateRasterizerState(k().readRasterizerDesc(descAt), held);
            return hr === S_OK ? k().handBack(held.state, k().lists.rasterizer,
                IID.ID3D11RasterizerState1, out) : failed(out, hr);
        },
        /** @param {any} device @param {number[]} args */
        CreateDeviceContextState: (device, [, levelsAt, count, , riid, levelAt, out])=>{
            const levels = isNull(levelsAt) ? [] : k().readDwords(levelsAt, count >>> 0);
            /** @type {{ state?: any, featureLevel?: number }} */
            const held = {};
            const hr = device.CreateDeviceContextState(levels,
                isNull(riid) ? '' : guidAt(riid), isNull(out) ? null : held);
            if (!isNull(levelAt))
            {
                k().fields.writeU32(levelAt, hr === S_OK || hr === S_FALSE
                    ? held.featureLevel ?? levels.find(level=>level >= 0xa000) ?? 0 : 0);
            }
            return hr === S_OK ? k().handBack(held.state, contextStateFaces,
                IID.ID3DDeviceContextState, out) : failed(out, hr);
        },
        /** @param {any} device @param {number[]} args */
        OpenSharedResource1: (device, [handle, iid, out])=>
            k().openShared(device, 'OpenSharedResource1', k().sharedKeyOf(handle), iid, out),
    };

    /**
     * D3D11_BLEND_DESC1 as the device takes a blend description: 10.1's, the
     * logic operation left out once it is known to be off.
     *
     * @param {number} address
     */
    const readBlendDesc11 = address=>({
        AlphaToCoverageEnable: k().fields.readU32(address) !== 0,
        IndependentBlendEnable: k().fields.readU32(address + 4) !== 0,
        RenderTarget: Array.from({ length: 8 }, (_, index)=>{
            const target = k().fields.readStruct(address + 8
                + index * RENDER_TARGET_BLEND_DESC1.SIZE, RENDER_TARGET_BLEND_DESC1);
            return {
                BlendEnable: target.BlendEnable !== 0, SrcBlend: target.SrcBlend,
                DestBlend: target.DestBlend, BlendOp: target.BlendOp,
                SrcBlendAlpha: target.SrcBlendAlpha, DestBlendAlpha: target.DestBlendAlpha,
                BlendOpAlpha: target.BlendOpAlpha,
                RenderTargetWriteMask: target.RenderTargetWriteMask & 0xff,
            };
        }),
    });

    // --- the context ---

    /** @param {number} address @param {number} count */
    const readViewports = (address, count)=>Array.from({ length: count }, (_, index)=>
        k().fields.readStruct(address + index * D3D11_VIEWPORT.SIZE, D3D11_VIEWPORT,
            VIEWPORT_FLOATS));

    /**
     * A stage's methods, which differ by prefix and by the interface their
     * shader is handed back as.
     *
     * @param {keyof typeof STAGE_SHADERS} stage
     */
    const stageMethods = stage=>{
        const list = stage.toLowerCase();
        return {
            /** @param {any} target @param {number[]} args */
            [`${stage}SetShader`]: (target, [shader, , count])=>{
                if ((count >>> 0) !== 0)
                {
                    k().diverge('a shader\'s class instances are ignored: no class is linked');
                }
                target[`${stage}SetShader`](k().publisher.objectAt(shader));
            },
            /** @param {any} target @param {number[]} args */
            [`${stage}GetShader`]: (target, [out, , countAt])=>{
                /** @type {{ shader?: any }} */
                const held = {};
                target[`${stage}GetShader`](held);
                k().writeObjects(out, [held.shader ?? null], k().lists[list],
                    STAGE_SHADERS[stage]);
                if (!isNull(countAt))
                {
                    k().fields.writeU32(countAt, 0);
                }
            },
            /** @param {any} target @param {number[]} args */
            [`${stage}SetConstantBuffers`]: (target, [start, count, buffers])=>{
                target[`${stage}SetConstantBuffers`](start >>> 0,
                    k().readObjects(buffers, count >>> 0));
            },
            /** @param {any} target @param {number[]} args */
            [`${stage}GetConstantBuffers`]: (target, [start, count, out])=>{
                /** @type {{ buffers?: any[] }} */
                const held = {};
                target[`${stage}GetConstantBuffers`](start >>> 0, count >>> 0, held);
                k().writeObjects(out, held.buffers ?? [], k().lists.buffer, IID.ID3D11Buffer);
            },
            /** @param {any} target @param {number[]} args */
            [`${stage}SetShaderResources`]: (target, [start, count, views])=>{
                target[`${stage}SetShaderResources`](start >>> 0,
                    k().readObjects(views, count >>> 0));
            },
            /** @param {any} target @param {number[]} args */
            [`${stage}GetShaderResources`]: (target, [start, count, out])=>{
                /** @type {{ views?: any[] }} */
                const held = {};
                target[`${stage}GetShaderResources`](start >>> 0, count >>> 0, held);
                k().writeObjects(out, held.views ?? [], k().lists.srv,
                    IID.ID3D11ShaderResourceView);
            },
            /** @param {any} target @param {number[]} args */
            [`${stage}SetSamplers`]: (target, [start, count, samplers])=>{
                target[`${stage}SetSamplers`](start >>> 0, k().readObjects(samplers, count >>> 0));
            },
            /** @param {any} target @param {number[]} args */
            [`${stage}GetSamplers`]: (target, [start, count, out])=>{
                /** @type {{ samplers?: any[] }} */
                const held = {};
                target[`${stage}GetSamplers`](start >>> 0, count >>> 0, held);
                k().writeObjects(out, held.samplers ?? [], k().lists.sampler,
                    IID.ID3D11SamplerState);
            },
        };
    };

    /**
     * Whether a context is deferred: its maps, queries and lists are its
     * own record's, not the device's.
     *
     * @param {any} target
     */
    const deferred = target=>target.GetType() !== 0;

    /**
     * A deferred context's maps, by context and then resource: the guest
     * memory a buffer's WRITE_DISCARD was handed, which a WRITE_NO_OVERWRITE
     * after it on the same context is handed again.
     *
     * @type {WeakMap<object, Map<object, { address: number, bytes: number }>>}
     */
    const deferredMaps = new WeakMap();

    /**
     * A buffer mapped on a deferred context, as Direct3D 11 allows it: with
     * WRITE_DISCARD, guest memory of its own, or with WRITE_NO_OVERWRITE the
     * same as its last discard on that context. What the program writes there
     * is recorded at Unmap, as an UpdateSubresource of the whole buffer the
     * command list plays where it plays. A texture's map on a deferred context
     * is not made here, and said as lost.
     *
     * @param {any} target @param {any} resource @param {number} type @param {number} out
     */
    const mapDeferred = (target, resource, type, out)=>{
        if (resource.dimension !== D3D10_RESOURCE_DIMENSION.BUFFER)
        {
            k().lose('a texture mapped on a deferred context is not mapped: only buffers are');
            return E_INVALIDARG;
        }
        const held = deferredMaps.get(target) ?? new Map();
        deferredMaps.set(target, held);
        const last = held.get(resource);
        if (type !== D3D10_MAP.WRITE_DISCARD
            && !(type === D3D10_MAP.WRITE_NO_OVERWRITE && last))
        {
            // A refused map hands out no pointer; the pitches stay as they were.
            k().writePointer(out, 0);
            return type === D3D10_MAP.WRITE_NO_OVERWRITE
                ? D3D11_ERROR_DEFERRED_CONTEXT_MAP_WITHOUT_INITIAL_DISCARD : E_INVALIDARG;
        }
        const bytes = resource.desc.ByteWidth >>> 0;
        if (type === D3D10_MAP.WRITE_DISCARD)
        {
            const address = k().allocate?.(Math.max(bytes, 4)) ?? 0;
            if (address === 0)
            {
                k().lose('a buffer mapped on a deferred context had no guest memory to map into');
                return E_OUTOFMEMORY;
            }
            if (last)
            {
                k().free?.(last.address);
            }
            held.set(resource, { address, bytes });
        }
        const mapped = /** @type {{ address: number }} */ (held.get(resource));
        k().writePointer(out, mapped.address);
        k().fields.writeU32(out + k().pointerSize, bytes);
        k().fields.writeU32(out + k().pointerSize + 4, bytes);
        return S_OK;
    };

    /**
     * A map on the immediate context: the resource's own, made as Direct3D
     * 10's is, the address and the pitches written into the structure. On a
     * deferred context, `mapDeferred`.
     *
     * @param {any} target @param {number[]} args
     */
    const map = (target, [resourceAt, subresource, type, flags, out])=>{
        const resource = k().publisher.objectAt(resourceAt);
        if (!resource || isNull(out))
        {
            return E_INVALIDARG;
        }
        if (deferred(target))
        {
            return mapDeferred(target, resource, type >>> 0, out >>> 0);
        }
        return k().whenMappable(resource, flags & MAP_DO_NOT_WAIT, ()=>{
            if (resource.dimension === D3D10_RESOURCE_DIMENSION.BUFFER)
            {
                k().countUnattached(resource);
                k().ringOf(resource)?.hostMap(resource, type >>> 0);
            }
            return k().mapInto(resource, subresource >>> 0, type >>> 0, flags & MAP_DO_NOT_WAIT,
                mapped=>{
                    // A refused map clears the pointer and leaves the pitches
                    // as they were (test_resource_map).
                    if (mapped.hr !== S_OK)
                    {
                        k().writePointer(out, 0);
                        return mapped.hr;
                    }
                    const whole = resource.dimension === D3D10_RESOURCE_DIMENSION.BUFFER
                        ? resource.desc.ByteWidth : 0;
                    // D3D11_MAPPED_SUBRESOURCE: pData a pointer, the pitches past it.
                    const pitches = out + k().pointerSize;
                    k().writePointer(out, mapped.address);
                    k().fields.writeU32(pitches, whole || mapped.rowPitch);
                    k().fields.writeU32(pitches + 4, whole || mapped.depthPitch);
                    return S_OK;
                });
        });
    };

    /** @param {any} target @param {number[]} args */
    const unmap = (target, [resourceAt, subresource])=>{
        const resource = k().publisher.objectAt(resourceAt);
        if (!resource)
        {
            return;
        }
        if (deferred(target))
        {
            // What the program wrote, recorded for where the list plays.
            const mapped = deferredMaps.get(target)?.get(resource);
            if (mapped)
            {
                target.WriteMapped(resource, k().memory.readMemory(mapped.address, mapped.bytes));
            }
            return;
        }
        // A map the guest made, unmapped here when its ring had no room.
        if (resource.dimension !== D3D10_RESOURCE_DIMENSION.BUFFER
            || !k().ringOf(resource)?.hostUnmap(resource))
        {
            k().unmapFrom(resource, subresource >>> 0);
        }
    };

    const contextMethods = {
        ...childMethods,
        ...stageMethods('VS'),
        ...stageMethods('HS'),
        ...stageMethods('DS'),
        ...stageMethods('GS'),
        ...stageMethods('PS'),
        ...stageMethods('CS'),
        Map: map,
        Unmap: unmap,

        /** @param {any} target @param {number[]} args */
        DrawIndexed: (target, [count, start, base])=>{
            target.DrawIndexed(count >>> 0, start >>> 0, base | 0);
        },
        /** @param {any} target @param {number[]} args */
        Draw: (target, [count, start])=>{
            target.Draw(count >>> 0, start >>> 0);
        },
        /** @param {any} target @param {number[]} args */
        DrawIndexedInstanced: (target, [count, instances, start, base, first])=>{
            target.DrawIndexedInstanced(count >>> 0, instances >>> 0, start >>> 0, base | 0,
                first >>> 0);
        },
        /** @param {any} target @param {number[]} args */
        DrawInstanced: (target, [count, instances, start, first])=>{
            target.DrawInstanced(count >>> 0, instances >>> 0, start >>> 0, first >>> 0);
        },
        /** @param {any} target */
        DrawAuto: target=>{
            target.DrawAuto();
        },
        /** @param {any} target @param {number[]} args */
        DrawIndexedInstancedIndirect: (target, [bufferAt, offset])=>{
            target.DrawIndexedInstancedIndirect(k().publisher.objectAt(bufferAt), offset >>> 0);
        },
        /** @param {any} target @param {number[]} args */
        DrawInstancedIndirect: (target, [bufferAt, offset])=>{
            target.DrawInstancedIndirect(k().publisher.objectAt(bufferAt), offset >>> 0);
        },
        /** @param {any} target @param {number[]} args */
        Dispatch: (target, [x, y, z])=>{
            target.Dispatch(x >>> 0, y >>> 0, z >>> 0);
        },
        /** @param {any} target @param {number[]} args */
        DispatchIndirect: (target, [bufferAt, offset])=>{
            target.DispatchIndirect(k().publisher.objectAt(bufferAt), offset >>> 0);
        },

        /** @param {any} target @param {number[]} args */
        IASetInputLayout: (target, [layout])=>{
            target.IASetInputLayout(k().publisher.objectAt(layout));
        },
        /** @param {any} target @param {number[]} args */
        IAGetInputLayout: (target, [out])=>{
            /** @type {{ layout?: any }} */
            const held = {};
            target.IAGetInputLayout(held);
            k().writeObjects(out, [held.layout ?? null], k().lists.inputLayout,
                IID.ID3D11InputLayout);
        },
        /** @param {any} target @param {number[]} args */
        IASetVertexBuffers: (target, [start, count, buffers, strides, offsets])=>{
            target.IASetVertexBuffers(start >>> 0, k().readObjects(buffers, count >>> 0),
                k().readDwords(strides, count >>> 0), k().readDwords(offsets, count >>> 0));
        },
        /** @param {any} target @param {number[]} args */
        IAGetVertexBuffers: (target, [start, count, buffers, strides, offsets])=>{
            /** @type {{ buffers?: any[], strides?: number[], offsets?: number[] }} */
            const held = {};
            target.IAGetVertexBuffers(start >>> 0, count >>> 0, held);
            k().writeObjects(buffers, held.buffers ?? [], k().lists.buffer, IID.ID3D11Buffer);
            (held.strides ?? []).forEach((stride, index)=>{
                if (!isNull(strides))
                {
                    k().fields.writeU32(strides + index * 4, stride);
                }
                if (!isNull(offsets))
                {
                    k().fields.writeU32(offsets + index * 4, (held.offsets ?? [])[index] ?? 0);
                }
            });
        },
        /** @param {any} target @param {number[]} args */
        IASetIndexBuffer: (target, [bufferAt, format, offset])=>{
            target.IASetIndexBuffer(k().publisher.objectAt(bufferAt), format >>> 0, offset >>> 0);
        },
        /** @param {any} target @param {number[]} args */
        IAGetIndexBuffer: (target, [out, formatAt, offsetAt])=>{
            /** @type {{ buffer?: any, format?: number, offset?: number }} */
            const held = {};
            target.IAGetIndexBuffer(held);
            k().writeObjects(out, [held.buffer ?? null], k().lists.buffer, IID.ID3D11Buffer);
            if (!isNull(formatAt))
            {
                k().fields.writeU32(formatAt, held.format ?? 0);
            }
            if (!isNull(offsetAt))
            {
                k().fields.writeU32(offsetAt, held.offset ?? 0);
            }
        },
        /** @param {any} target @param {number[]} args */
        IASetPrimitiveTopology: (target, [topology])=>{
            target.IASetPrimitiveTopology(topology >>> 0);
        },
        /** @param {any} target @param {number[]} args */
        IAGetPrimitiveTopology: (target, [out])=>{
            /** @type {{ topology?: number }} */
            const held = {};
            target.IAGetPrimitiveTopology(held);
            k().fields.writeU32(out, held.topology ?? 0);
        },

        /** @param {any} target @param {number[]} args */
        Begin: (target, [queryAt])=>{
            const object = k().publisher.objectAt(queryAt);
            if (object)
            {
                if (deferred(target))
                {
                    target.Begin(object);
                }
                else
                {
                    object.Begin();
                }
            }
        },
        /** @param {any} target @param {number[]} args */
        End: (target, [queryAt])=>{
            const object = k().publisher.objectAt(queryAt);
            if (object)
            {
                if (deferred(target))
                {
                    target.End(object);
                }
                else
                {
                    object.End();
                }
            }
        },
        /**
         * A deferred context answers no query: what it would count has not
         * run yet.
         *
         * @param {any} target @param {number[]} args
         */
        GetData: (target, [queryAt, data, size, flags])=>{
            const object = k().publisher.objectAt(queryAt);
            if (!object || deferred(target))
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            /** @type {{ data?: Uint8Array | null }} */
            const held = {};
            const hr = object.GetData(!isNull(data), size >>> 0, flags >>> 0, held);
            if (hr === S_OK && held.data && !isNull(data))
            {
                k().memory.writeMemory(data >>> 0, held.data);
            }
            return hr;
        },
        /** @param {any} target @param {number[]} args */
        SetPredication: (target, [predicate, value])=>{
            target.SetPredication(k().publisher.objectAt(predicate), value !== 0);
        },
        /** @param {any} target @param {number[]} args */
        GetPredication: (target, [out, valueAt])=>{
            /** @type {{ predicate?: any, value?: boolean }} */
            const held = {};
            target.GetPredication(held);
            k().writeObjects(out, [held.predicate ?? null], k().lists.query, IID.ID3D11Predicate);
            if (!isNull(valueAt))
            {
                k().fields.writeU32(valueAt, held.value ? 1 : 0);
            }
        },

        /** @param {any} target @param {number[]} args */
        OMSetRenderTargets: (target, [count, views, depth])=>{
            target.OMSetRenderTargets(k().readObjects(views, count >>> 0),
                k().publisher.objectAt(depth));
        },
        /** @param {any} target @param {number[]} args */
        OMSetRenderTargetsAndUnorderedAccessViews: (target, args)=>{
            const [count, views, depth, start, viewCount, unordered, initialCounts] = args;
            const keepTargets = (count >>> 0) === 0xffffffff;
            const keepViews = (viewCount >>> 0) === 0xffffffff;
            target.OMSetRenderTargetsAndUnorderedAccessViews(count >>> 0,
                keepTargets ? [] : k().readObjects(views, count >>> 0),
                keepTargets ? null : k().publisher.objectAt(depth), start >>> 0, viewCount >>> 0,
                keepViews ? [] : k().readObjects(unordered, viewCount >>> 0),
                keepViews || isNull(initialCounts) ? []
                    : k().readDwords(initialCounts, viewCount >>> 0));
        },
        /** @param {any} target @param {number[]} args */
        OMGetRenderTargets: (target, [count, views, depth])=>{
            /** @type {{ views?: any[], depthStencilView?: any }} */
            const held = {};
            target.OMGetRenderTargets(count >>> 0, held);
            k().writeObjects(views, held.views ?? [], k().lists.rtv, IID.ID3D11RenderTargetView);
            k().writeObjects(depth, [held.depthStencilView ?? null], k().lists.dsv,
                IID.ID3D11DepthStencilView);
        },
        /** @param {any} target @param {number[]} args */
        OMGetRenderTargetsAndUnorderedAccessViews: (target, args)=>{
            const [count, views, depth, start, viewCount, unordered] = args;
            /** @type {{ views?: any[], depthStencilView?: any, unordered?: any[] }} */
            const held = {};
            target.OMGetRenderTargetsAndUnorderedAccessViews(count >>> 0, start >>> 0,
                viewCount >>> 0, held);
            k().writeObjects(views, held.views ?? [], k().lists.rtv, IID.ID3D11RenderTargetView);
            k().writeObjects(depth, [held.depthStencilView ?? null], k().lists.dsv,
                IID.ID3D11DepthStencilView);
            k().writeObjects(unordered, held.unordered ?? [], k().lists.uav,
                IID.ID3D11UnorderedAccessView);
        },
        /** @param {any} target @param {number[]} args */
        OMSetBlendState: (target, [stateAt, factorAt, mask])=>{
            target.OMSetBlendState(k().publisher.objectAt(stateAt),
                isNull(factorAt) ? null : k().readFloats(factorAt, 4), mask >>> 0);
        },
        /** @param {any} target @param {number[]} args */
        OMGetBlendState: (target, [out, factorAt, maskAt])=>{
            /** @type {{ state?: any, blendFactor?: number[], sampleMask?: number }} */
            const held = {};
            target.OMGetBlendState(held);
            k().writeObjects(out, [held.state ?? null], k().lists.blend, IID.ID3D11BlendState);
            if (!isNull(factorAt))
            {
                (held.blendFactor ?? []).forEach((value, index)=>{
                    k().fields.writeF32(factorAt + index * 4, value);
                });
            }
            if (!isNull(maskAt))
            {
                k().fields.writeU32(maskAt, held.sampleMask ?? 0);
            }
        },
        /** @param {any} target @param {number[]} args */
        OMSetDepthStencilState: (target, [stateAt, reference])=>{
            target.OMSetDepthStencilState(k().publisher.objectAt(stateAt), reference >>> 0);
        },
        /** @param {any} target @param {number[]} args */
        OMGetDepthStencilState: (target, [out, referenceAt])=>{
            /** @type {{ state?: any, stencilRef?: number }} */
            const held = {};
            target.OMGetDepthStencilState(held);
            k().writeObjects(out, [held.state ?? null], k().lists.depthStencil,
                IID.ID3D11DepthStencilState);
            if (!isNull(referenceAt))
            {
                k().fields.writeU32(referenceAt, held.stencilRef ?? 0);
            }
        },
        /** @param {any} target @param {number[]} args */
        SOSetTargets: (target, [count, buffers, offsets])=>{
            target.SOSetTargets(k().readObjects(buffers, count >>> 0),
                k().readDwords(offsets, count >>> 0));
        },
        /** @param {any} target @param {number[]} args */
        SOGetTargets: (target, [count, buffers])=>{
            /** @type {{ buffers?: any[] }} */
            const held = {};
            target.SOGetTargets(count >>> 0, held);
            k().writeObjects(buffers, held.buffers ?? [], k().lists.buffer, IID.ID3D11Buffer);
        },

        /** @param {any} target @param {number[]} args */
        RSSetState: (target, [stateAt])=>{
            target.RSSetState(k().publisher.objectAt(stateAt));
        },
        /** @param {any} target @param {number[]} args */
        RSGetState: (target, [out])=>{
            /** @type {{ state?: any }} */
            const held = {};
            target.RSGetState(held);
            k().writeObjects(out, [held.state ?? null], k().lists.rasterizer,
                IID.ID3D11RasterizerState);
        },
        /** @param {any} target @param {number[]} args */
        RSSetViewports: (target, [count, viewports])=>{
            if ((count >>> 0) > VIEWPORT_SLOTS)
            {
                return;
            }
            target.RSSetViewports(readViewports(viewports, count >>> 0));
        },
        /**
         * As Direct3D 10's: a null array asks how many; otherwise every slot
         * of the room given is written, those past the bound ones zeroed.
         *
         * @param {any} target @param {number[]} args
         */
        RSGetViewports: (target, [countAt, out])=>{
            /** @type {{ count?: number, viewports?: any[] }} */
            const held = {};
            target.RSGetViewports(held);
            if (isNull(out))
            {
                k().fields.writeU32(countAt, held.count ?? 0);
                return;
            }
            const room = k().fields.readU32(countAt);
            const bound = (held.viewports ?? []).slice(0, room);
            bound.forEach((viewport, index)=>{
                k().fields.writeStruct(out + index * D3D11_VIEWPORT.SIZE, D3D11_VIEWPORT,
                    viewport, VIEWPORT_FLOATS);
            });
            k().memory.writeMemory(out + bound.length * D3D11_VIEWPORT.SIZE,
                new Uint8Array((Math.min(room, VIEWPORT_SLOTS) - Math.min(bound.length, room))
                    * D3D11_VIEWPORT.SIZE));
            k().fields.writeU32(countAt, bound.length);
        },
        /** @param {any} target @param {number[]} args */
        RSSetScissorRects: (target, [count, rects])=>{
            target.RSSetScissorRects(k().readRects(rects, count >>> 0));
        },
        /** @param {any} target @param {number[]} args */
        RSGetScissorRects: (target, [countAt, out])=>{
            /** @type {{ count?: number, rects?: any[] }} */
            const held = {};
            target.RSGetScissorRects(held);
            if (isNull(out))
            {
                k().fields.writeU32(countAt, held.count ?? 0);
                return;
            }
            const room = k().fields.readU32(countAt);
            const bound = (held.rects ?? []).slice(0, room);
            bound.forEach((rect, index)=>{
                k().fields.writeU32(out + index * 16, rect.left);
                k().fields.writeU32(out + index * 16 + 4, rect.top);
                k().fields.writeU32(out + index * 16 + 8, rect.right);
                k().fields.writeU32(out + index * 16 + 12, rect.bottom);
            });
            k().memory.writeMemory(out + bound.length * 16, new Uint8Array(
                (Math.min(room, VIEWPORT_SLOTS) - Math.min(bound.length, room)) * 16));
            k().fields.writeU32(countAt, bound.length);
        },

        /** @param {any} target @param {number[]} args */
        CopySubresourceRegion: (target, [dst, dstSub, x, y, z, src, srcSub, box])=>{
            target.CopySubresourceRegion(k().publisher.objectAt(dst), dstSub >>> 0, x >>> 0,
                y >>> 0, z >>> 0, k().publisher.objectAt(src), srcSub >>> 0, k().readBox(box));
        },
        /** @param {any} target @param {number[]} args */
        CopyResource: (target, [dst, src])=>{
            target.CopyResource(k().publisher.objectAt(dst), k().publisher.objectAt(src));
        },
        /** @param {any} target @param {number[]} args */
        UpdateSubresource: (target, [dst, subresource, boxAt, data, rowPitch, depthPitch])=>{
            const resource = k().publisher.objectAt(dst);
            if (!resource || isNull(data))
            {
                return;
            }
            const box = k().readBox(boxAt);
            const bytes = k().updateBytesOf(resource, subresource >>> 0, box, rowPitch >>> 0,
                depthPitch >>> 0);
            if (bytes <= 0)
            {
                return;
            }
            target.UpdateSubresource(resource, subresource >>> 0, box,
                k().memory.readMemory(data >>> 0, bytes), rowPitch >>> 0, depthPitch >>> 0);
        },
        /** @param {any} target @param {number[]} args */
        CopyStructureCount: (target, [dst, offset, viewAt])=>{
            target.CopyStructureCount(k().publisher.objectAt(dst), offset >>> 0,
                k().publisher.objectAt(viewAt));
        },
        /** @param {any} target @param {number[]} args */
        ClearRenderTargetView: (target, [viewAt, colorAt])=>{
            target.ClearRenderTargetView(k().publisher.objectAt(viewAt),
                isNull(colorAt) ? null : k().readFloats(colorAt, 4));
        },
        /** @param {any} target @param {number[]} args */
        ClearUnorderedAccessViewUint: (target, [viewAt, valuesAt])=>{
            target.ClearUnorderedAccessViewUint(k().publisher.objectAt(viewAt),
                isNull(valuesAt) ? null : k().readDwords(valuesAt, 4));
        },
        /** @param {any} target @param {number[]} args */
        ClearUnorderedAccessViewFloat: (target, [viewAt, valuesAt])=>{
            target.ClearUnorderedAccessViewFloat(k().publisher.objectAt(viewAt),
                isNull(valuesAt) ? null : k().readFloats(valuesAt, 4));
        },
        /** @param {any} target @param {number[]} args */
        ClearDepthStencilView: (target, [viewAt, flags, depth, stencil])=>{
            target.ClearDepthStencilView(k().publisher.objectAt(viewAt), flags >>> 0,
                k().fields.asFloat(depth), stencil & 0xff);
        },
        /** @param {any} target @param {number[]} args */
        GenerateMips: (target, [viewAt])=>{
            target.GenerateMips(k().publisher.objectAt(viewAt));
        },
        /** @param {any} target @param {number[]} args */
        SetResourceMinLOD: (target, [resourceAt, lod])=>{
            target.SetResourceMinLOD(k().publisher.objectAt(resourceAt), k().fields.asFloat(lod));
        },
        /**
         * FLOAT GetResourceMinLOD(ID3D11Resource*): answered on the floating
         * point stack, where a float comes back.
         *
         * @param {any} target @param {number[]} args
         */
        GetResourceMinLOD: (target, [resourceAt])=>{
            k().floatResult?.(target.GetResourceMinLOD(k().publisher.objectAt(resourceAt)));
        },
        /** @param {any} target @param {number[]} args */
        ResolveSubresource: (target, [dst, dstSub, src, srcSub, format])=>{
            target.ResolveSubresource(k().publisher.objectAt(dst), dstSub >>> 0,
                k().publisher.objectAt(src), srcSub >>> 0, format >>> 0);
        },
        /** @param {any} target @param {number[]} args */
        ExecuteCommandList: (target, [listAt, restore])=>{
            target.ExecuteCommandList(k().publisher.objectAt(listAt), restore !== 0);
        },
        /** @param {any} target @param {number[]} args */
        CSSetUnorderedAccessViews: (target, [start, count, views, initialCounts])=>{
            target.CSSetUnorderedAccessViews(start >>> 0, k().readObjects(views, count >>> 0),
                isNull(initialCounts) ? [] : k().readDwords(initialCounts, count >>> 0));
        },
        /** @param {any} target @param {number[]} args */
        CSGetUnorderedAccessViews: (target, [start, count, out])=>{
            /** @type {{ views?: any[] }} */
            const held = {};
            target.CSGetUnorderedAccessViews(start >>> 0, count >>> 0, held);
            k().writeObjects(out, held.views ?? [], k().lists.uav,
                IID.ID3D11UnorderedAccessView);
        },
        /** @param {any} target */
        ClearState: target=>{
            target.ClearState();
        },
        /** @param {any} target */
        Flush: target=>{
            target.Flush();
        },
        /** @param {any} target */
        GetType: target=>target.GetType(),
        /** @param {any} target */
        GetContextFlags: target=>target.GetContextFlags(),
        /** @param {any} target @param {number[]} args */
        FinishCommandList: (target, [restore, out])=>{
            /** @type {{ list?: any }} */
            const held = {};
            const hr = target.FinishCommandList(restore !== 0, isNull(out) ? null : held);
            // A list ends its maps: the next one starts with a discard again.
            for (const mapped of deferredMaps.get(target)?.values() ?? [])
            {
                k().free?.(mapped.address);
            }
            deferredMaps.delete(target);
            return hr === S_OK ? k().handBack(held.list, commandList, IID.ID3D11CommandList, out)
                : failed(out, hr);
        },

        // --- Direct3D 11.1 ---

        /** @param {any} target @param {number[]} args */
        CopySubresourceRegion1: (target, args)=>{
            contextMethods.CopySubresourceRegion(target, args.slice(0, 8));
        },
        /** @param {any} target @param {number[]} args */
        UpdateSubresource1: (target, args)=>{
            contextMethods.UpdateSubresource(target, args.slice(0, 6));
        },
        // A discard says the contents are no longer needed: what is there
        // stays, which is one of the things undefined contents may be.
        DiscardResource: ()=>{},
        DiscardView: ()=>{},
        DiscardView1: ()=>{},
        ...Object.fromEntries(['VS', 'HS', 'DS', 'GS', 'PS', 'CS'].flatMap(stage=>[
            [`${stage}SetConstantBuffers1`, setConstantBuffers1(stage)],
            [`${stage}GetConstantBuffers1`, getConstantBuffers1(stage)],
        ])),
        /** @param {any} target @param {number[]} args */
        SwapDeviceContextState: (target, [stateAt, out])=>{
            /** @type {{ previous?: any }} */
            const held = {};
            target.SwapDeviceContextState(k().publisher.objectAt(stateAt),
                isNull(out) ? null : held);
            // Under Direct3D 10's state the context's calls do nothing: none
            // may go into the ring, where they would be made.
            const device = target.owner?.();
            k().ringOf(device)?.slow(device?.drawsAsTen() === true);
            if (!isNull(out))
            {
                if (held.previous)
                {
                    k().handBack(held.previous, contextStateFaces, IID.ID3DDeviceContextState,
                        out);
                }
                else
                {
                    k().fields.writeU32(out, 0);
                }
            }
        },
        /**
         * A clear of a whole view, as its own kind's clear makes it; a clear of
         * rectangles in it is not made.
         *
         * @param {any} target @param {number[]} args
         */
        ClearView: (target, [viewAt, colorAt, rects, count])=>{
            const cleared = k().publisher.objectAt(viewAt);
            if (!cleared || isNull(colorAt))
            {
                return;
            }
            if ((count >>> 0) !== 0 && !isNull(rects))
            {
                k().diverge('ClearView of rectangles is not made');
                return;
            }
            if (cleared.supports(IID.ID3D11RenderTargetView))
            {
                target.ClearRenderTargetView(cleared, k().readFloats(colorAt, 4));
            }
            else if (cleared.supports(IID.ID3D11UnorderedAccessView))
            {
                target.ClearUnorderedAccessViewFloat(cleared, k().readFloats(colorAt, 4));
            }
        },

        // ID3D11Multithread and ID3DUserDefinedAnnotation, on the same object.
        /** @param {any} target */
        Enter: target=>{
            target.Enter();
        },
        /** @param {any} target */
        Leave: target=>{
            target.Leave();
        },
        /** @param {any} target @param {number[]} args */
        SetMultithreadProtected: (target, [enable])=>
            (target.SetMultithreadProtected(enable !== 0) ? 1 : 0),
        /** @param {any} target */
        GetMultithreadProtected: target=>(target.GetMultithreadProtected() ? 1 : 0),
        /** @param {any} target */
        BeginEvent: target=>target.BeginEvent(),
        /** @param {any} target */
        EndEvent: target=>target.EndEvent(),
        /** @param {any} target */
        SetMarker: target=>{
            target.SetMarker();
        },
        /** @param {any} target */
        GetStatus: target=>target.GetStatus(),
    };

    const context = [
        describe(IID.ID3D11DeviceContext1, ID3D11DEVICECONTEXT1_SLOTS, contextMethods,
            guests.context),
        describe(IID.ID3D11DeviceContext, ID3D11DEVICECONTEXT_SLOTS, contextMethods,
            guests.context),
        describe(IID.ID3D11DeviceChild, ID3D11DEVICECHILD_SLOTS, contextMethods),
        describe(IID.ID3D10Multithread, ID3D11MULTITHREAD_SLOTS, contextMethods),
        describe(IID.ID3DUserDefinedAnnotation, ID3DUSERDEFINEDANNOTATION_SLOTS,
            contextMethods),
    ];

    // --- d3d11.dll ---

    /**
     * The two entry points' shared half: the levels read, the device made,
     * and what the caller left room for written.
     *
     * @param {number[]} args @param {boolean} withSwapChain
     */
    const createEntry = (args, withSwapChain)=>{
        const [adapterAt, driverType, software, flags, levelsAt, levelCount, sdkVersion] = args;
        const [descAt, chainAt, deviceAt, levelAt, contextAt] = withSwapChain
            ? args.slice(7, 12) : [0, 0, ...args.slice(7, 10)];
        // The SDK version is not checked: every Direct3D 11 header names 7.
        void sdkVersion;
        const levels = isNull(levelsAt) || (levelCount >>> 0) === 0 ? null
            : k().readDwords(levelsAt, levelCount >>> 0);
        const request = {
            /** @type {any} */
            made: null,
            wantDevice: !isNull(deviceAt),
            wantContext: !isNull(contextAt),
            wantSwapChain: !isNull(chainAt),
            /** @type {any} */
            device: null,
            /** @type {any} */
            context: null,
            /** @type {any} */
            swapChain: null,
            featureLevel: 0,
        };
        const adapter = k().publisher.objectAt(adapterAt);
        const softwareModule = isNull(software) ? null : { module: software >>> 0 };
        const hr = withSwapChain
            ? k().root().CreateDeviceAndSwapChain11(adapter, driverType >>> 0, softwareModule,
                flags >>> 0, levels, isNull(descAt) ? null : k().readSwapChainDesc(descAt), request)
            : k().root().CreateDevice11(adapter, driverType >>> 0, softwareModule, flags >>> 0,
                levels, request);
        for (const out of [chainAt, deviceAt, contextAt])
        {
            if (!isNull(out))
            {
                k().fields.writeU32(out, 0);
            }
        }
        if (!isNull(levelAt))
        {
            k().fields.writeU32(levelAt, hr === S_OK || hr === S_FALSE ? request.featureLevel : 0);
        }
        if (hr !== S_OK)
        {
            return hr;
        }
        // The device made, which the caller may not hold: the context or the
        // swap chain does then.
        const made = request.made;
        if (made)
        {
            k().created(made);
            k().attachRing(made);
        }
        if (request.swapChain)
        {
            k().pairSwapChain(request.swapChain, made);
            k().fields.writeU32(chainAt, k().publisher.publish(request.swapChain,
                k().lists.swapChain, IID.IDXGISwapChain));
        }
        if (request.context)
        {
            k().handBack(contextOf(made), context, IID.ID3D11DeviceContext, contextAt);
        }
        if (request.device)
        {
            return k().handBack(request.device, k().lists.device, IID.ID3D11Device, deviceAt);
        }
        return S_OK;
    };

    return {
        faces: {
            buffer, texture1D: texture(IID.ID3D11Texture1D),
            texture2D: texture(IID.ID3D11Texture2D), texture3D: texture(IID.ID3D11Texture3D),
            srv: view('srv'), rtv: view('rtv'), dsv: view('dsv'),
            blend: [...state(IID.ID3D11BlendState, (object, out)=>{
                /** @type {{ desc?: any }} */
                const held = {};
                object.GetDesc1(held);
                k().writeBlendDesc1(held.desc, out);
            }), describe(IID.ID3D11BlendState1, ID3D11STATE1_SLOTS, {
                ...childMethods,
                /** @param {any} object @param {number[]} args */
                GetDesc: (object, [out])=>{
                    /** @type {{ desc?: any }} */
                    const held = {};
                    object.GetDesc1(held);
                    k().writeBlendDesc1(held.desc, out);
                },
                /**
                 * 11.1's: each target with a logic operation, which none has.
                 *
                 * @param {any} object @param {number[]} args
                 */
                GetDesc1: (object, [out])=>{
                    /** @type {{ desc?: any }} */
                    const held = {};
                    object.GetDesc1(held);
                    const words = new Uint32Array((8 + 8 * RENDER_TARGET_BLEND_DESC1.SIZE) >>> 2);
                    words[0] = held.desc.AlphaToCoverageEnable ? 1 : 0;
                    words[1] = held.desc.IndependentBlendEnable ? 1 : 0;
                    for (let index = 0; index < 8; index++)
                    {
                        const target = held.desc.RenderTarget[index];
                        const at = 2 + index * (RENDER_TARGET_BLEND_DESC1.SIZE >>> 2);
                        words.set([target.BlendEnable ? 1 : 0, 0, target.SrcBlend,
                            target.DestBlend, target.BlendOp, target.SrcBlendAlpha,
                            target.DestBlendAlpha, target.BlendOpAlpha, 0,
                            target.RenderTargetWriteMask & 0xff], at);
                    }
                    k().memory.writeMemory(out >>> 0, new Uint8Array(words.buffer));
                },
            })],
            depthStencil: state(IID.ID3D11DepthStencilState, (object, out)=>{
                /** @type {{ desc?: any }} */
                const held = {};
                object.GetDesc(held);
                k().writeDepthStencilDesc(held.desc, out);
            }),
            rasterizer: [...state(IID.ID3D11RasterizerState, (object, out)=>{
                /** @type {{ desc?: any }} */
                const held = {};
                object.GetDesc(held);
                k().writeRasterizerDesc(held.desc, out);
            }), describe(IID.ID3D11RasterizerState1, ID3D11STATE1_SLOTS, {
                ...childMethods,
                /** @param {any} object @param {number[]} args */
                GetDesc: (object, [out])=>{
                    /** @type {{ desc?: any }} */
                    const held = {};
                    object.GetDesc(held);
                    k().writeRasterizerDesc(held.desc, out);
                },
                /** @param {any} object @param {number[]} args */
                GetDesc1: (object, [out])=>{
                    /** @type {{ desc?: any }} */
                    const held = {};
                    object.GetDesc(held);
                    k().writeRasterizerDesc(held.desc, out);
                    k().fields.writeU32(out + FORCED_SAMPLE_COUNT, 0);
                },
            })],
            sampler: state(IID.ID3D11SamplerState, (object, out)=>{
                /** @type {{ desc?: any }} */
                const held = {};
                object.GetDesc(held);
                k().writeSamplerDesc(held.desc, out);
            }),
            vs: child(IID.ID3D11VertexShader), gs: child(IID.ID3D11GeometryShader),
            ps: child(IID.ID3D11PixelShader), inputLayout: child(IID.ID3D11InputLayout),
            query,
            device: [describe(IID.ID3D11Device1, ID3D11DEVICE1_SLOTS, deviceMethods),
                describe(IID.ID3D11Device, ID3D11DEVICE_SLOTS, deviceMethods)],
        },
        lists: {
            uav: view('uav'), hs: child(IID.ID3D11HullShader), ds: child(IID.ID3D11DomainShader),
            cs: child(IID.ID3D11ComputeShader), context, classLinkage, commandList,
        },
        library: {
            /**
             * HRESULT D3D11CreateDevice(IDXGIAdapter*, D3D_DRIVER_TYPE, HMODULE, UINT,
             *     const D3D_FEATURE_LEVEL*, UINT, UINT, ID3D11Device**, D3D_FEATURE_LEVEL*,
             *     ID3D11DeviceContext**)
             */
            D3D11CreateDevice: {
                argBytes: 40,
                /** @param {number[]} args */
                handler: args=>createEntry(args, false),
            },
            /**
             * HRESULT D3D11CreateDeviceAndSwapChain(..., const DXGI_SWAP_CHAIN_DESC*,
             *     IDXGISwapChain**, ID3D11Device**, D3D_FEATURE_LEVEL*, ID3D11DeviceContext**)
             */
            D3D11CreateDeviceAndSwapChain: {
                argBytes: 48,
                /** @param {number[]} args */
                handler: args=>createEntry(args, true),
            },
        },
    };
}
