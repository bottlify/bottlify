/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3D10_BIND, D3D10_BLEND, D3D10_BLEND_OP, D3D10_COLOR_WRITE_ENABLE, D3D10_COMPARISON,
    D3D10_CPU_ACCESS, D3D10_CREATE_DEVICE, D3D10_CULL_MODE, D3D10_DEFAULTS,
    D3D10_DEPTH_WRITE_MASK, D3D10_DRIVER_TYPE, D3D10_DSV_DIMENSION, D3D10_FILL_MODE, D3D10_FILTER,
    D3D10_LIMITS, D3D10_PRIMITIVE_TOPOLOGY, D3D10_RESOURCE_MISC, D3D10_RTV_DIMENSION,
    D3D10_MAP, D3D10_QUERY, D3D10_SDK_VERSION, D3D10_SRV_DIMENSION, D3D10_STENCIL_OP,
    D3D10_TEXTURE_ADDRESS, D3D10_USAGE, DXGI_ERROR_INVALID_CALL, DXGI_ERROR_MORE_DATA,
    DXGI_ERROR_NOT_FOUND, DXGI_ERROR_UNSUPPORTED, DXGI_FORMAT, D3D_FEATURE_LEVEL, E_FAIL,
    E_INVALIDARG, IID, S_FALSE, S_OK, D3D11_DSV_FLAG,
} from './constants.js';
import { D3D10CreateDevice, D3D10CreateDeviceAndSwapChain, D3D11CreateDevice } from './device.js';
import { defaultSwapChainDesc } from './dxgi.js';
import {
    assemble, dclInputSiv, dclOutput, dclOutputSiv, dclResourceRaw, ldRaw, l, o,
    passThroughVertexShader, quadDomainShader, ret, solidPixelShader, t, utof, v,
} from './shader-fixtures.js';
import { COMPONENT_TYPE, SHADER_KIND, SYSTEM_VALUE } from './dxbc.js';

/** @param {object} [options] */
function createDevice(options = {}){
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(
        D3D10CreateDevice(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0, D3D10_SDK_VERSION, out,
            options),
        S_OK);
    return out.device;
}

/** @param {any} device */
function assertFullyReleased(device){
    assert.equal(device.release(), 0, 'the device reached a reference count of zero');
}

const TEXTURE_2D = Object.freeze({
    Width: 512,
    Height: 512,
    MipLevels: 1,
    ArraySize: 1,
    Format: DXGI_FORMAT.R8G8B8A8_UNORM,
    SampleDesc: { Count: 1, Quality: 0 },
    Usage: D3D10_USAGE.DEFAULT,
    BindFlags: D3D10_BIND.RENDER_TARGET,
    CPUAccessFlags: 0,
    MiscFlags: 0,
});

/** @param {any} device @param {object} [overrides] */
function createTexture2D(device, overrides = {}){
    /** @type {{ resource?: any }} */
    const out = {};
    assert.equal(device.CreateTexture2D({ ...TEXTURE_2D, ...overrides }, null, out), S_OK);
    return out.resource;
}

// --- creating a device ---

/**
 * The SDK version is the one argument with no runtime meaning at all: it exists
 * so that a program built against the wrong headers fails here rather than
 * somewhere unrecognisable later.
 */
test('a device is refused for any SDK version but its own', ()=>{
    for (let version = 0; version < 64; version++)
    {
        /** @type {{ device?: any }} */
        const out = { device: 'untouched' };
        const hr = D3D10CreateDevice(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0, version, out);
        if (version === D3D10_SDK_VERSION)
        {
            assert.equal(hr, S_OK, `version ${version}`);
            assertFullyReleased(out.device);
            continue;
        }
        assert.equal(hr, E_INVALIDARG, `version ${version}`);
        assert.equal(out.device, null, `version ${version} left no device behind`);
    }
});

test('the driver type is an enumeration with a hole, not a range', ()=>{
    for (let driverType = 0; driverType <= 6; driverType++)
    {
        /** @type {{ device?: any }} */
        const out = {};
        const software = driverType === D3D10_DRIVER_TYPE.SOFTWARE ? { module: 1 } : null;
        const hr = D3D10CreateDevice(null, driverType, software, 0, D3D10_SDK_VERSION, out);
        // 4 is not a driver type; 6 is past the end of the enumeration.
        const expected = [0, 1, 2, 3, 5].includes(driverType) ? S_OK : E_INVALIDARG;
        assert.equal(hr, expected, `driver type ${driverType}`);
        if (hr === S_OK)
        {
            assertFullyReleased(out.device);
        }
    }
});

test('a software driver and a software module go together or not at all', ()=>{
    /** @type {{ device?: any }} */
    const missing = {};
    assert.equal(
        D3D10CreateDevice(null, D3D10_DRIVER_TYPE.SOFTWARE, null, 0, D3D10_SDK_VERSION, missing),
        E_INVALIDARG, 'a software driver needs the module that implements it');

    /** @type {{ device?: any }} */
    const spurious = {};
    assert.equal(
        D3D10CreateDevice(null, D3D10_DRIVER_TYPE.HARDWARE, { module: 1 }, 0, D3D10_SDK_VERSION,
            spurious),
        E_INVALIDARG, 'no other driver type has anywhere to put one');
});

test('an unknown creation flag is refused rather than ignored', ()=>{
    /** @type {{ device?: any }} */
    const known = {};
    const flags = D3D10_CREATE_DEVICE.SINGLETHREADED | D3D10_CREATE_DEVICE.BGRA_SUPPORT;
    assert.equal(
        D3D10CreateDevice(null, D3D10_DRIVER_TYPE.HARDWARE, null, flags, D3D10_SDK_VERSION, known),
        S_OK);
    assert.equal(known.device.GetCreationFlags(), flags);
    assertFullyReleased(known.device);

    /** @type {{ device?: any }} */
    const unknown = {};
    assert.equal(
        D3D10CreateDevice(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0x40000, D3D10_SDK_VERSION,
            unknown),
        E_INVALIDARG);
    assert.equal(unknown.device, null);
});

test('a device made through this entry point is always feature level 10.0', ()=>{
    const device = createDevice();
    assert.equal(device.GetFeatureLevel(), D3D_FEATURE_LEVEL.LEVEL_10_0);
    // There is no lost state in this API; what replaced it stays fine.
    assert.equal(device.GetDeviceRemovedReason(), S_OK);
    assertFullyReleased(device);
});

test('a device is a DXGI device too, and parents to its adapter', ()=>{
    const device = createDevice();
    for (const iid of [IID.IUnknown, IID.ID3D10Device, IID.IDXGIObject, IID.IDXGIDevice,
        IID.ID3D10Multithread])
    {
        assert.ok(device.supports(iid), iid);
    }

    /** @type {{ parent?: any }} */
    const parent = {};
    assert.equal(device.GetParent(IID.IDXGIAdapter, parent), S_OK);
    assert.equal(parent.parent, device.adapter());
    parent.parent.release();

    assertFullyReleased(device);
});

test('the combined entry point produces both objects or neither', ()=>{
    /** @type {{ device?: any }} */
    const deviceOut = {};
    /** @type {{ swapChain?: any }} */
    const chainOut = {};
    const desc = { ...defaultSwapChainDesc(), outputWindow: 0x1234 };
    assert.equal(
        D3D10CreateDeviceAndSwapChain(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0,
            D3D10_SDK_VERSION, desc, chainOut, deviceOut),
        S_OK);
    assert.ok(deviceOut.device);
    assert.ok(chainOut.swapChain);
    assert.equal(chainOut.swapChain.factory, deviceOut.device.factory(),
        'the swap chain comes from the device\'s own factory');
    chainOut.swapChain.release();
    assertFullyReleased(deviceOut.device);

    // A swap chain that cannot be made takes the device with it: a caller left
    // holding one of the two could not tell that apart from a full success.
    /** @type {{ device?: any }} */
    const failedDevice = {};
    /** @type {{ swapChain?: any }} */
    const failedChain = {};
    assert.equal(
        D3D10CreateDeviceAndSwapChain(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0,
            D3D10_SDK_VERSION, { ...desc, outputWindow: 0 }, failedChain, failedDevice),
        DXGI_ERROR_INVALID_CALL);
    assert.equal(failedDevice.device, null);
    assert.equal(failedChain.swapChain, null);

    // A null description asks for the device alone, which is not a failure.
    /** @type {{ device?: any }} */
    const alone = {};
    /** @type {{ swapChain?: any }} */
    const none = {};
    assert.equal(
        D3D10CreateDeviceAndSwapChain(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0,
            D3D10_SDK_VERSION, null, none, alone),
        S_OK);
    assert.equal(none.swapChain, null);
    assertFullyReleased(alone.device);
});

// --- the immutable state objects ---

const BLEND_DESC = Object.freeze({
    AlphaToCoverageEnable: false,
    BlendEnable: [false, false, false, false, false, false, false, false],
    SrcBlend: 0,
    DestBlend: 0,
    BlendOp: 0,
    SrcBlendAlpha: 0,
    DestBlendAlpha: 0,
    BlendOpAlpha: 0,
    RenderTargetWriteMask: new Array(8).fill(D3D10_COLOR_WRITE_ENABLE.ALL),
});

const DEPTH_STENCIL_DESC = Object.freeze({
    DepthEnable: true,
    DepthWriteMask: D3D10_DEPTH_WRITE_MASK.ALL,
    DepthFunc: D3D10_COMPARISON.LESS,
    StencilEnable: false,
    StencilReadMask: D3D10_DEFAULTS.STENCIL_READ_MASK,
    StencilWriteMask: D3D10_DEFAULTS.STENCIL_WRITE_MASK,
    FrontFace: {
        StencilFailOp: D3D10_STENCIL_OP.KEEP,
        StencilDepthFailOp: D3D10_STENCIL_OP.KEEP,
        StencilPassOp: D3D10_STENCIL_OP.KEEP,
        StencilFunc: D3D10_COMPARISON.ALWAYS,
    },
    BackFace: {
        StencilFailOp: D3D10_STENCIL_OP.KEEP,
        StencilDepthFailOp: D3D10_STENCIL_OP.KEEP,
        StencilPassOp: D3D10_STENCIL_OP.KEEP,
        StencilFunc: D3D10_COMPARISON.ALWAYS,
    },
});

const RASTERIZER_DESC = Object.freeze({
    FillMode: D3D10_FILL_MODE.SOLID,
    CullMode: D3D10_CULL_MODE.BACK,
    FrontCounterClockwise: false,
    DepthBias: 0,
    DepthBiasClamp: 0,
    SlopeScaledDepthBias: 0,
    DepthClipEnable: true,
    ScissorEnable: false,
    MultisampleEnable: false,
    AntialiasedLineEnable: false,
});

const SAMPLER_DESC = Object.freeze({
    Filter: D3D10_FILTER.MIN_MAG_MIP_LINEAR,
    AddressU: D3D10_TEXTURE_ADDRESS.WRAP,
    AddressV: D3D10_TEXTURE_ADDRESS.WRAP,
    AddressW: D3D10_TEXTURE_ADDRESS.WRAP,
    MipLODBias: 0,
    MaxAnisotropy: 16,
    ComparisonFunc: D3D10_COMPARISON.ALWAYS,
    BorderColor: [0, 1, 0, 1],
    MinLOD: 0,
    MaxLOD: 16,
});

const STATE_CASES = [
    { name: 'blend', method: 'CreateBlendState', desc: BLEND_DESC },
    { name: 'depth stencil', method: 'CreateDepthStencilState', desc: DEPTH_STENCIL_DESC },
    { name: 'rasterizer', method: 'CreateRasterizerState', desc: RASTERIZER_DESC },
    { name: 'sampler', method: 'CreateSamplerState', desc: SAMPLER_DESC },
];

test('a state object needs a description, and a null one is not a default', ()=>{
    const device = createDevice();
    for (const testCase of STATE_CASES)
    {
        /** @type {{ state?: any }} */
        const out = { state: 'untouched' };
        assert.equal(device[testCase.method](null, out), E_INVALIDARG, testCase.name);
        assert.equal(out.state, null, testCase.name);
    }
    assertFullyReleased(device);
});

/**
 * Two identical descriptions are one object. That is what makes these safe to
 * treat as values, and it is observable: the pointers are equal and the count
 * went up rather than a second object appearing.
 */
test('an identical description gets the same state object back', ()=>{
    const device = createDevice();
    for (const testCase of STATE_CASES)
    {
        const before = device.refCount;
        /** @type {{ state?: any }} */
        const first = {};
        /** @type {{ state?: any }} */
        const second = {};
        assert.equal(device[testCase.method](testCase.desc, first), S_OK, testCase.name);
        assert.equal(device[testCase.method](testCase.desc, second), S_OK, testCase.name);

        assert.equal(first.state, second.state, `${testCase.name}: one object, not two`);
        assert.equal(first.state.refCount, 2, testCase.name);
        assert.equal(device.refCount, before + 1,
            `${testCase.name}: the device was held once, not twice`);
        assert.equal(device.stateObjectCount(), 1, testCase.name);

        assert.equal(second.state.release(), 1, testCase.name);
        assert.equal(first.state.release(), 0, testCase.name);
        assert.equal(device.refCount, before, `${testCase.name}: the device got it back`);
        assert.equal(device.stateObjectCount(), 0, testCase.name);
    }
    assertFullyReleased(device);
});

test('asking a state object for its device takes a reference on it', ()=>{
    const device = createDevice();
    /** @type {{ state?: any }} */
    const created = {};
    assert.equal(device.CreateRasterizerState(RASTERIZER_DESC, created), S_OK);
    const before = device.refCount;

    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(created.state.GetDevice(out), S_OK);
    assert.equal(out.device, device);
    assert.equal(device.refCount, before + 1);
    out.device.release();

    created.state.release();
    assertFullyReleased(device);
});

/**
 * The normalisation rule, in the one place where it is cheapest to see: with
 * blending disabled the factors are not consulted, so a description of zeros --
 * which are not valid blend values at all -- is accepted and reads back as the
 * API's defaults.
 */
test('a blend description with blending off reads back as one, zero and add', ()=>{
    const device = createDevice();
    /** @type {{ state?: any }} */
    const created = {};
    assert.equal(device.CreateBlendState(BLEND_DESC, created), S_OK);

    /** @type {{ desc?: any }} */
    const out = {};
    assert.equal(created.state.GetDesc(out), S_OK);
    assert.equal(out.desc.SrcBlend, D3D10_BLEND.ONE);
    assert.equal(out.desc.DestBlend, D3D10_BLEND.ZERO);
    assert.equal(out.desc.BlendOp, D3D10_BLEND_OP.ADD);
    assert.equal(out.desc.SrcBlendAlpha, D3D10_BLEND.ONE);
    assert.equal(out.desc.DestBlendAlpha, D3D10_BLEND.ZERO);
    assert.equal(out.desc.BlendOpAlpha, D3D10_BLEND_OP.ADD);
    for (let index = 0; index < D3D10_LIMITS.SIMULTANEOUS_RENDER_TARGETS; index++)
    {
        assert.equal(out.desc.BlendEnable[index], false, `target ${index}`);
        assert.equal(out.desc.RenderTargetWriteMask[index], D3D10_COLOR_WRITE_ENABLE.ALL,
            `target ${index}`);
    }

    // With blending on, the factors do mean something, and nonsense is refused.
    /** @type {{ state?: any }} */
    const bad = {};
    assert.equal(device.CreateBlendState({
        ...BLEND_DESC,
        BlendEnable: [true, false, false, false, false, false, false, false],
    }, bad), E_INVALIDARG);

    created.state.release();
    assertFullyReleased(device);
});

test('a disabled test reports the defaults, not what was asked for', ()=>{
    const device = createDevice();
    /** @type {{ state?: any }} */
    const created = {};
    assert.equal(device.CreateDepthStencilState({
        DepthEnable: false,
        DepthWriteMask: D3D10_DEPTH_WRITE_MASK.ZERO,
        DepthFunc: D3D10_COMPARISON.NEVER,
        StencilEnable: false,
        StencilReadMask: 0,
        StencilWriteMask: 0,
        FrontFace: {
            StencilFailOp: D3D10_STENCIL_OP.ZERO,
            StencilDepthFailOp: D3D10_STENCIL_OP.ZERO,
            StencilPassOp: D3D10_STENCIL_OP.ZERO,
            StencilFunc: D3D10_COMPARISON.NEVER,
        },
        BackFace: {
            StencilFailOp: D3D10_STENCIL_OP.ZERO,
            StencilDepthFailOp: D3D10_STENCIL_OP.ZERO,
            StencilPassOp: D3D10_STENCIL_OP.ZERO,
            StencilFunc: D3D10_COMPARISON.NEVER,
        },
    }, created), S_OK);

    /** @type {{ desc?: any }} */
    const out = {};
    assert.equal(created.state.GetDesc(out), S_OK);
    assert.equal(out.desc.DepthEnable, false);
    assert.equal(out.desc.DepthWriteMask, D3D10_DEPTH_WRITE_MASK.ALL,
        'the depth half is not consulted, so it reads back as the default');
    assert.equal(out.desc.DepthFunc, D3D10_COMPARISON.LESS);
    assert.equal(out.desc.StencilReadMask, D3D10_DEFAULTS.STENCIL_READ_MASK);
    assert.equal(out.desc.StencilWriteMask, D3D10_DEFAULTS.STENCIL_WRITE_MASK);
    for (const face of [out.desc.FrontFace, out.desc.BackFace])
    {
        assert.equal(face.StencilFailOp, D3D10_STENCIL_OP.KEEP);
        assert.equal(face.StencilDepthFailOp, D3D10_STENCIL_OP.KEEP);
        assert.equal(face.StencilPassOp, D3D10_STENCIL_OP.KEEP);
        assert.equal(face.StencilFunc, D3D10_COMPARISON.ALWAYS);
    }

    created.state.release();
    assertFullyReleased(device);
});

/**
 * Three fields of a sampler description mean nothing unless the filter or the
 * addressing asks for them, and all three are zeroed rather than kept. A layer
 * that stores what it was handed reports all three wrongly.
 */
test('a sampler zeroes the fields its filter does not use', ()=>{
    const device = createDevice();
    /** @type {{ state?: any }} */
    const created = {};
    assert.equal(device.CreateSamplerState(SAMPLER_DESC, created), S_OK);

    /** @type {{ desc?: any }} */
    const out = {};
    assert.equal(created.state.GetDesc(out), S_OK);
    assert.equal(out.desc.Filter, D3D10_FILTER.MIN_MAG_MIP_LINEAR);
    assert.equal(out.desc.MaxAnisotropy, 0, 'not an anisotropic filter');
    assert.equal(out.desc.ComparisonFunc, D3D10_COMPARISON.NEVER, 'not a comparison filter');
    assert.deepEqual([...out.desc.BorderColor], [0, 0, 0, 0], 'no address mode reaches a border');
    assert.equal(out.desc.MaxLOD, 16, 'the fields it does use are kept');
    created.state.release();

    /** @type {{ state?: any }} */
    const anisotropic = {};
    assert.equal(device.CreateSamplerState({
        ...SAMPLER_DESC,
        Filter: D3D10_FILTER.ANISOTROPIC,
        AddressU: D3D10_TEXTURE_ADDRESS.BORDER,
    }, anisotropic), S_OK);
    /** @type {{ desc?: any }} */
    const kept = {};
    anisotropic.state.GetDesc(kept);
    assert.equal(kept.desc.MaxAnisotropy, 16);
    assert.deepEqual([...kept.desc.BorderColor], [0, 1, 0, 1]);
    assert.equal(kept.desc.ComparisonFunc, D3D10_COMPARISON.NEVER,
        'anisotropic is still not a comparison filter');
    anisotropic.state.release();

    // Two descriptions that differ only where normalisation erases the
    // difference are the same object.
    /** @type {{ state?: any }} */
    const first = {};
    /** @type {{ state?: any }} */
    const second = {};
    assert.equal(device.CreateSamplerState(SAMPLER_DESC, first), S_OK);
    assert.equal(device.CreateSamplerState({ ...SAMPLER_DESC, MaxAnisotropy: 4 }, second), S_OK);
    assert.equal(first.state, second.state);
    second.state.release();
    first.state.release();

    assertFullyReleased(device);
});

// --- resources ---

test('creating a resource holds the device, and releasing it lets go', ()=>{
    const device = createDevice();
    const before = device.refCount;
    const texture = createTexture2D(device);
    assert.equal(device.refCount, before + 1);

    /** @type {{ device?: any }} */
    const owner = {};
    assert.equal(texture.GetDevice(owner), S_OK);
    assert.equal(owner.device, device);
    assert.equal(device.refCount, before + 2, 'asking for the device is another reference');
    owner.device.release();

    assert.equal(texture.release(), 0);
    assert.equal(device.refCount, before);
    assertFullyReleased(device);
});

test('a mip level count of zero means the whole chain, and reads back resolved', ()=>{
    const device = createDevice();
    const texture = createTexture2D(device, { MipLevels: 0 });
    /** @type {{ desc?: any }} */
    const out = {};
    assert.equal(texture.GetDesc(out), S_OK);
    assert.equal(out.desc.MipLevels, 10, '512 by 512 is ten levels');
    assert.equal(out.desc.Width, 512);

    // A chain longer than the extents allow is not a resource that can exist.
    /** @type {{ resource?: any }} */
    const tooMany = { resource: 'untouched' };
    assert.equal(device.CreateTexture2D({ ...TEXTURE_2D, MipLevels: 11 }, null, tooMany),
        E_INVALIDARG);
    assert.equal(tooMany.resource, null);

    texture.release();
    assertFullyReleased(device);
});

/**
 * A texture is an `IDXGISurface` only while it is a single image. A program
 * uses that to decide whether it may hand the texture to something that speaks
 * DXGI instead of Direct3D, so answering yes for a mip chain misleads it.
 */
test('only a single-subresource texture is a DXGI surface', ()=>{
    const device = createDevice();

    const single = createTexture2D(device);
    assert.ok(single.supports(IID.IDXGISurface));
    single.release();

    const chained = createTexture2D(device, { MipLevels: 0 });
    assert.equal(chained.supports(IID.IDXGISurface), false, 'a mip chain is not one surface');
    assert.ok(chained.supports(IID.IDXGIResource), 'but it is still a DXGI resource');
    chained.release();

    const array = createTexture2D(device, { ArraySize: 2 });
    assert.equal(array.supports(IID.IDXGISurface), false, 'nor is an array');
    array.release();

    assertFullyReleased(device);
});

test('a texture is refused the bind flags only a buffer has', ()=>{
    const device = createDevice();
    for (const bindFlag of [D3D10_BIND.VERTEX_BUFFER, D3D10_BIND.INDEX_BUFFER,
        D3D10_BIND.CONSTANT_BUFFER])
    {
        /** @type {{ resource?: any }} */
        const out = {};
        assert.equal(device.CreateTexture2D({ ...TEXTURE_2D, BindFlags: bindFlag }, null, out),
            E_INVALIDARG, `bind flag ${bindFlag}`);
    }

    // A colour surface cannot be the depth half of the output merger, and no
    // surface can be both halves at once.
    /** @type {{ resource?: any }} */
    const depth = {};
    assert.equal(device.CreateTexture2D({
        ...TEXTURE_2D, BindFlags: D3D10_BIND.DEPTH_STENCIL,
    }, null, depth), E_INVALIDARG);

    /** @type {{ resource?: any }} */
    const both = {};
    assert.equal(device.CreateTexture2D({
        ...TEXTURE_2D,
        Format: DXGI_FORMAT.R32_TYPELESS,
        BindFlags: D3D10_BIND.RENDER_TARGET | D3D10_BIND.DEPTH_STENCIL,
    }, null, both), E_INVALIDARG);

    // The same typeless format is happily both sampled and depth-tested, which
    // is the combination that makes shadow mapping possible.
    /** @type {{ resource?: any }} */
    const sampledDepth = {};
    assert.equal(device.CreateTexture2D({
        ...TEXTURE_2D,
        Format: DXGI_FORMAT.R32_TYPELESS,
        BindFlags: D3D10_BIND.SHADER_RESOURCE | D3D10_BIND.DEPTH_STENCIL,
    }, null, sampledDepth), S_OK);
    sampledDepth.resource.release();

    assertFullyReleased(device);
});

test('a cube texture is six faces and exactly six', ()=>{
    const device = createDevice();
    for (const arraySize of [1, 3, 5, 6, 7, 12])
    {
        /** @type {{ resource?: any }} */
        const out = {};
        const hr = device.CreateTexture2D({
            ...TEXTURE_2D,
            ArraySize: arraySize,
            BindFlags: D3D10_BIND.SHADER_RESOURCE,
            MiscFlags: D3D10_RESOURCE_MISC.TEXTURECUBE,
        }, null, out);
        // Arrays of cubes arrived with a later feature level, so a multiple of
        // six is no more acceptable here than any other wrong number.
        assert.equal(hr, arraySize === 6 ? S_OK : E_INVALIDARG, `array size ${arraySize}`);
        if (hr === S_OK)
        {
            out.resource.release();
        }
    }
    assertFullyReleased(device);
});

test('an array of no slices is not an array', ()=>{
    const device = createDevice();
    /** @type {{ resource?: any }} */
    const out = {};
    assert.equal(device.CreateTexture2D({ ...TEXTURE_2D, ArraySize: 0 }, null, out),
        E_INVALIDARG);
    assertFullyReleased(device);
});

test('initial data that names no memory is a mistake, not an absent argument', ()=>{
    const device = createDevice();
    /** @type {{ resource?: any }} */
    const empty = {};
    assert.equal(
        device.CreateTexture2D(TEXTURE_2D, { pSysMem: null, SysMemPitch: 0 }, empty),
        E_INVALIDARG);
    assert.equal(empty.resource, null);

    // The same call with nothing at all is how a program asks for uninitialised
    // storage, and that is fine.
    const texture = createTexture2D(device);
    texture.release();
    assertFullyReleased(device);
});

test('a multisample quality level past what the format supports is refused', ()=>{
    const device = createDevice({
        /** @param {number} format @param {number} count */
        multisampleQualityLevels: (format, count)=>(count === 1 || count === 4 ? 2 : 0),
    });
    /** @type {{ levels?: number }} */
    const levels = {};
    assert.equal(device.CheckMultisampleQualityLevels(TEXTURE_2D.Format, 4, levels), S_OK);
    assert.equal(levels.levels, 2);

    const supported = createTexture2D(device, { SampleDesc: { Count: 4, Quality: 1 } });
    supported.release();

    /** @type {{ resource?: any }} */
    const past = {};
    assert.equal(device.CreateTexture2D({
        ...TEXTURE_2D, SampleDesc: { Count: 4, Quality: 2 },
    }, null, past), E_INVALIDARG, 'the quality level is an index, so two of two is past the end');

    /** @type {{ resource?: any }} */
    const unsupported = {};
    assert.equal(device.CreateTexture2D({
        ...TEXTURE_2D, SampleDesc: { Count: 8, Quality: 0 },
    }, null, unsupported), E_INVALIDARG);

    assertFullyReleased(device);
});

// --- views ---

test('a view holds the device and not the resource it looks at', ()=>{
    const device = createDevice();
    const texture = createTexture2D(device);
    const deviceBefore = device.refCount;
    const textureBefore = texture.refCount;

    /** @type {{ view?: any }} */
    const view = {};
    assert.equal(device.CreateRenderTargetView(texture, null, view), S_OK);
    assert.equal(texture.refCount, textureBefore, 'a view takes nothing from its resource');
    assert.equal(device.refCount, deviceBefore + 1, 'it takes one from the device');

    // Handing the resource back to a caller is a different thing, and that does
    // take a reference.
    /** @type {{ resource?: any }} */
    const owner = {};
    assert.equal(view.view.GetResource(owner), S_OK);
    assert.equal(owner.resource, texture);
    assert.equal(texture.refCount, textureBefore + 1);
    owner.resource.release();

    view.view.release();
    assert.equal(device.refCount, deviceBefore);
    texture.release();
    assertFullyReleased(device);
});

test('a null view description means the obvious view, and resolves to it', ()=>{
    const device = createDevice();

    const single = createTexture2D(device);
    /** @type {{ view?: any }} */
    const flat = {};
    assert.equal(device.CreateRenderTargetView(single, null, flat), S_OK);
    /** @type {{ desc?: any }} */
    const flatDesc = {};
    flat.view.GetDesc(flatDesc);
    assert.equal(flatDesc.desc.Format, DXGI_FORMAT.R8G8B8A8_UNORM);
    assert.equal(flatDesc.desc.ViewDimension, D3D10_RTV_DIMENSION.TEXTURE2D);
    assert.equal(flatDesc.desc.MipSlice, 0);
    flat.view.release();
    single.release();

    // More than one slice and the obvious view is the array, covering all of it.
    const array = createTexture2D(device, { ArraySize: 4 });
    /** @type {{ view?: any }} */
    const arrayView = {};
    assert.equal(device.CreateRenderTargetView(array, null, arrayView), S_OK);
    /** @type {{ desc?: any }} */
    const arrayDesc = {};
    arrayView.view.GetDesc(arrayDesc);
    assert.equal(arrayDesc.desc.ViewDimension, D3D10_RTV_DIMENSION.TEXTURE2DARRAY);
    assert.equal(arrayDesc.desc.FirstArraySlice, 0);
    assert.equal(arrayDesc.desc.ArraySize, 4);
    arrayView.view.release();
    array.release();

    assertFullyReleased(device);
});

/**
 * A typeless resource is the one case where a null description cannot work: the
 * format the view would inherit does not exist, and there is nothing to guess.
 */
test('a typeless resource has no obvious view', ()=>{
    const device = createDevice();
    const texture = createTexture2D(device, { Format: DXGI_FORMAT.R8G8B8A8_TYPELESS });

    /** @type {{ view?: any }} */
    const implicit = { view: 'untouched' };
    assert.equal(device.CreateRenderTargetView(texture, null, implicit), E_INVALIDARG);
    assert.equal(implicit.view, null);

    /** @type {{ view?: any }} */
    const named = {};
    assert.equal(device.CreateRenderTargetView(texture, {
        Format: DXGI_FORMAT.R8G8B8A8_UNORM,
        ViewDimension: D3D10_RTV_DIMENSION.TEXTURE2D,
        MipSlice: 0,
    }, named), S_OK);
    named.view.release();

    // Naming a format from another family is not a cast.
    /** @type {{ view?: any }} */
    const foreign = {};
    assert.equal(device.CreateRenderTargetView(texture, {
        Format: DXGI_FORMAT.R16G16_UNORM,
        ViewDimension: D3D10_RTV_DIMENSION.TEXTURE2D,
        MipSlice: 0,
    }, foreign), E_INVALIDARG);

    texture.release();
    assertFullyReleased(device);
});

test('a buffer has no view unless one is described', ()=>{
    const device = createDevice();
    /** @type {{ resource?: any }} */
    const created = {};
    assert.equal(device.CreateBuffer({
        ByteWidth: 1024,
        Usage: D3D10_USAGE.DEFAULT,
        BindFlags: D3D10_BIND.SHADER_RESOURCE,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    }, null, created), S_OK);

    /** @type {{ view?: any }} */
    const implicit = { view: 'untouched' };
    assert.equal(device.CreateShaderResourceView(created.resource, null, implicit), E_INVALIDARG);
    assert.equal(implicit.view, null);

    /** @type {{ view?: any }} */
    const named = {};
    assert.equal(device.CreateShaderResourceView(created.resource, {
        Format: DXGI_FORMAT.R32G32B32A32_FLOAT,
        ViewDimension: D3D10_SRV_DIMENSION.BUFFER,
        ElementOffset: 0,
        ElementWidth: 64,
    }, named), S_OK);
    named.view.release();

    created.resource.release();
    assertFullyReleased(device);
});

test('a view over a resource that is not bound that way is refused', ()=>{
    const device = createDevice();
    const target = createTexture2D(device);

    /** @type {{ view?: any }} */
    const wrong = { view: 'untouched' };
    assert.equal(device.CreateShaderResourceView(target, null, wrong), E_INVALIDARG,
        'the texture was never made a shader resource');
    assert.equal(wrong.view, null);

    /** @type {{ view?: any }} */
    const right = {};
    assert.equal(device.CreateRenderTargetView(target, null, right), S_OK);
    right.view.release();

    target.release();
    assertFullyReleased(device);
});

/**
 * The bounds of a view are checked against the resource, and "all remaining"
 * is resolved against it rather than stored. Every row here is a way of asking
 * for a slice the resource does not have.
 */
test('a view is bounded by the resource it looks at', ()=>{
    const device = createDevice();
    const texture = createTexture2D(device, { MipLevels: 4, ArraySize: 4 });
    const base = { Format: DXGI_FORMAT.R8G8B8A8_UNORM };

    const cases = [
        { desc: { ViewDimension: D3D10_RTV_DIMENSION.UNKNOWN }, valid: false },
        { desc: { ViewDimension: D3D10_RTV_DIMENSION.TEXTURE1D, MipSlice: 0 }, valid: false },
        { desc: { ViewDimension: D3D10_RTV_DIMENSION.TEXTURE3D, MipSlice: 0 }, valid: false },
        { desc: { ViewDimension: D3D10_RTV_DIMENSION.TEXTURE2D, MipSlice: 3 }, valid: true },
        { desc: { ViewDimension: D3D10_RTV_DIMENSION.TEXTURE2D, MipSlice: 4 }, valid: false },
        {
            desc: {
                ViewDimension: D3D10_RTV_DIMENSION.TEXTURE2DARRAY,
                MipSlice: 0, FirstArraySlice: 0, ArraySize: 0,
            },
            valid: false,
        },
        {
            desc: {
                ViewDimension: D3D10_RTV_DIMENSION.TEXTURE2DARRAY,
                MipSlice: 0, FirstArraySlice: 2, ArraySize: 3,
            },
            valid: false,
        },
        {
            desc: {
                ViewDimension: D3D10_RTV_DIMENSION.TEXTURE2DARRAY,
                MipSlice: 0, FirstArraySlice: 2, ArraySize: 2,
            },
            valid: true,
        },
    ];

    for (const testCase of cases)
    {
        /** @type {{ view?: any }} */
        const out = {};
        const label = JSON.stringify(testCase.desc);
        const hr = device.CreateRenderTargetView(texture, { ...base, ...testCase.desc }, out);
        assert.equal(hr, testCase.valid ? S_OK : E_INVALIDARG, label);
        if (hr === S_OK)
        {
            out.view.release();
        }
        else
        {
            assert.equal(out.view, null, label);
        }
    }

    // "All remaining" is resolved against the resource, not carried through.
    /** @type {{ view?: any }} */
    const remaining = {};
    assert.equal(device.CreateRenderTargetView(texture, {
        ...base,
        ViewDimension: D3D10_RTV_DIMENSION.TEXTURE2DARRAY,
        MipSlice: 1,
        FirstArraySlice: 1,
        ArraySize: 0xffffffff,
    }, remaining), S_OK);
    /** @type {{ desc?: any }} */
    const resolved = {};
    remaining.view.GetDesc(resolved);
    assert.equal(resolved.desc.ArraySize, 3);
    assert.equal(resolved.desc.MipSlice, 1);
    remaining.view.release();

    texture.release();
    assertFullyReleased(device);
});

test('a depth stencil view uses its own dimension numbering', ()=>{
    const device = createDevice();
    const texture = createTexture2D(device, {
        Format: DXGI_FORMAT.D24_UNORM_S8_UINT,
        BindFlags: D3D10_BIND.DEPTH_STENCIL,
    });

    /** @type {{ view?: any }} */
    const view = {};
    assert.equal(device.CreateDepthStencilView(texture, null, view), S_OK);
    /** @type {{ desc?: any }} */
    const out = {};
    view.view.GetDesc(out);
    // Three here is TEXTURE2D; the same number in a render-target view means
    // TEXTURE1DARRAY, which is why the two enumerations are never compared.
    assert.equal(out.desc.ViewDimension, D3D10_DSV_DIMENSION.TEXTURE2D);
    assert.notEqual(D3D10_DSV_DIMENSION.TEXTURE2D, D3D10_RTV_DIMENSION.TEXTURE2D);

    view.view.release();
    texture.release();
    assertFullyReleased(device);
});

test('a shader resource view names a range of mip levels', ()=>{
    const device = createDevice();
    const texture = createTexture2D(device, {
        MipLevels: 4,
        BindFlags: D3D10_BIND.SHADER_RESOURCE,
    });

    /** @type {{ view?: any }} */
    const whole = {};
    assert.equal(device.CreateShaderResourceView(texture, null, whole), S_OK);
    /** @type {{ desc?: any }} */
    const out = {};
    whole.view.GetDesc(out);
    assert.equal(out.desc.MostDetailedMip, 0);
    assert.equal(out.desc.MipLevels, 4, 'the default view covers the whole chain');
    whole.view.release();

    /** @type {{ view?: any }} */
    const tail = {};
    assert.equal(device.CreateShaderResourceView(texture, {
        Format: DXGI_FORMAT.R8G8B8A8_UNORM,
        ViewDimension: D3D10_SRV_DIMENSION.TEXTURE2D,
        MostDetailedMip: 2,
        MipLevels: 0xffffffff,
    }, tail), S_OK);
    /** @type {{ desc?: any }} */
    const tailDesc = {};
    tail.view.GetDesc(tailDesc);
    assert.equal(tailDesc.desc.MipLevels, 2, 'all remaining, from level two');
    tail.view.release();

    /** @type {{ view?: any }} */
    const past = {};
    assert.equal(device.CreateShaderResourceView(texture, {
        Format: DXGI_FORMAT.R8G8B8A8_UNORM,
        ViewDimension: D3D10_SRV_DIMENSION.TEXTURE2D,
        MostDetailedMip: 2,
        MipLevels: 3,
    }, past), E_INVALIDARG);

    texture.release();
    assertFullyReleased(device);
});

// --- the binding model ---

/** @param {any} device */
function createSampler(device){
    /** @type {{ state?: any }} */
    const out = {};
    assert.equal(device.CreateSamplerState(SAMPLER_DESC, out), S_OK);
    return out.state;
}

/**
 * The rule that surprises everybody: binding is not owning. A program may bind
 * an object and then release its last reference, and the device does not keep
 * it alive -- so asking what is bound answers with nothing.
 */
test('binding takes no reference, and what is bound can die under the device', ()=>{
    const device = createDevice();
    const sampler = createSampler(device);
    assert.equal(sampler.refCount, 1);

    device.PSSetSamplers(0, [sampler]);
    assert.equal(sampler.refCount, 1, 'setting a sampler added no reference');

    /** @type {{ samplers: any[] }} */
    const bound = { samplers: [] };
    device.PSGetSamplers(0, 1, bound);
    assert.equal(bound.samplers[0], sampler);
    assert.equal(sampler.refCount, 2, 'but asking for it back did');
    bound.samplers[0].release();

    assert.equal(sampler.release(), 0, 'the program let go while it was still bound');
    /** @type {{ samplers: any[] }} */
    const gone = { samplers: [] };
    device.PSGetSamplers(0, 1, gone);
    assert.equal(gone.samplers[0], null, 'the device was not keeping it alive');

    assertFullyReleased(device);
});

test('a render target view bound and released is likewise gone', ()=>{
    const device = createDevice();
    const texture = createTexture2D(device);
    /** @type {{ view?: any }} */
    const created = {};
    assert.equal(device.CreateRenderTargetView(texture, null, created), S_OK);
    texture.release();

    device.OMSetRenderTargets([created.view], null);
    assert.equal(created.view.refCount, 1);
    assert.equal(created.view.release(), 0);

    /** @type {{ views: any[], depthStencilView?: any }} */
    const out = { views: [] };
    device.OMGetRenderTargets(D3D10_LIMITS.SIMULTANEOUS_RENDER_TARGETS, out);
    assert.equal(out.views[0], null);
    assert.equal(out.depthStencilView, null);

    assertFullyReleased(device);
});

test('the input assembler records a layout, streams and a topology', ()=>{
    const device = createDevice();
    /** @type {{ layout?: any }} */
    const layout = {};
    assert.equal(device.CreateInputLayout([{
        SemanticName: 'POSITION',
        SemanticIndex: 0,
        Format: DXGI_FORMAT.R32G32B32A32_FLOAT,
        InputSlot: 0,
        AlignedByteOffset: 0,
        InputSlotClass: 0,
        InstanceDataStepRate: 0,
    }], passThroughVertexShader(), layout), S_OK);

    /** @type {{ resource?: any }} */
    const vertices = {};
    assert.equal(device.CreateBuffer({
        ByteWidth: 1024,
        Usage: D3D10_USAGE.DEFAULT,
        BindFlags: D3D10_BIND.VERTEX_BUFFER,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    }, null, vertices), S_OK);

    device.IASetInputLayout(layout.layout);
    device.IASetVertexBuffers(0, [vertices.resource], [32], [16]);
    device.IASetIndexBuffer(vertices.resource, DXGI_FORMAT.R16_UINT, 8);
    device.IASetPrimitiveTopology(D3D10_PRIMITIVE_TOPOLOGY.TRIANGLELIST);

    /** @type {{ layout?: any }} */
    const boundLayout = {};
    device.IAGetInputLayout(boundLayout);
    assert.equal(boundLayout.layout, layout.layout);
    boundLayout.layout.release();

    /** @type {{ buffers: any[], strides: number[], offsets: number[] }} */
    const streams = { buffers: [], strides: [], offsets: [] };
    device.IAGetVertexBuffers(0, 2, streams);
    assert.equal(streams.buffers[0], vertices.resource);
    assert.equal(streams.strides[0], 32);
    assert.equal(streams.offsets[0], 16);
    assert.equal(streams.buffers[1], null, 'an untouched slot stays empty');
    assert.equal(streams.strides[1], 0);
    streams.buffers[0].release();

    /** @type {{ buffer?: any, format?: number, offset?: number }} */
    const indices = {};
    device.IAGetIndexBuffer(indices);
    assert.equal(indices.buffer, vertices.resource);
    assert.equal(indices.format, DXGI_FORMAT.R16_UINT);
    assert.equal(indices.offset, 8);
    indices.buffer.release();

    /** @type {{ topology?: number }} */
    const topology = {};
    device.IAGetPrimitiveTopology(topology);
    assert.equal(topology.topology, D3D10_PRIMITIVE_TOPOLOGY.TRIANGLELIST);

    vertices.resource.release();
    layout.layout.release();
    assertFullyReleased(device);
});

test('an input layout needs elements and a signature to match them against', ()=>{
    const device = createDevice();
    const element = {
        SemanticName: 'POSITION',
        SemanticIndex: 0,
        Format: DXGI_FORMAT.R32G32B32A32_FLOAT,
        InputSlot: 0,
        AlignedByteOffset: 0,
        InputSlotClass: 0,
        InstanceDataStepRate: 0,
    };
    /** @type {{ layout?: any }} */
    const out = {};
    const signature = passThroughVertexShader();
    assert.equal(device.CreateInputLayout([], signature, out), E_INVALIDARG,
        'no elements feed nothing, and this shader reads POSITION0');
    assert.equal(device.CreateInputLayout([element], null, out), E_INVALIDARG);
    assert.equal(device.CreateInputLayout([{ ...element, SemanticName: '' }], signature,
        out), E_INVALIDARG);
    assert.equal(device.CreateInputLayout([{ ...element, InputSlot: 16 }], signature,
        out), E_INVALIDARG);
    // The shader reads POSITION0; a layout that feeds only NORMAL0 cannot assemble it.
    assert.equal(device.CreateInputLayout([{ ...element, SemanticName: 'NORMAL' }], signature,
        out), E_INVALIDARG);
    assert.equal(device.CreateInputLayout([element], new Uint8Array([1, 2, 3, 4]), out),
        E_INVALIDARG, 'the signature has to come in a container');
    assert.equal(out.layout, null);
    assertFullyReleased(device);
});

test('each shader stage keeps its own bindings', ()=>{
    const device = createDevice();
    /** @type {{ shader?: any }} */
    const vertexShader = {};
    /** @type {{ shader?: any }} */
    const pixelShader = {};
    assert.equal(device.CreateVertexShader(passThroughVertexShader(), vertexShader), S_OK);
    assert.equal(device.CreatePixelShader(solidPixelShader([1, 0, 0, 1]), pixelShader), S_OK);

    device.VSSetShader(vertexShader.shader);
    device.PSSetShader(pixelShader.shader);

    /** @type {{ shader?: any }} */
    const boundVertex = {};
    device.VSGetShader(boundVertex);
    assert.equal(boundVertex.shader, vertexShader.shader);
    boundVertex.shader.release();

    /** @type {{ shader?: any }} */
    const boundGeometry = {};
    device.GSGetShader(boundGeometry);
    assert.equal(boundGeometry.shader, null, 'the geometry stage was never set');

    // A constant buffer in the pixel stage is not one in the vertex stage.
    /** @type {{ resource?: any }} */
    const constants = {};
    assert.equal(device.CreateBuffer({
        ByteWidth: 32,
        Usage: D3D10_USAGE.DEFAULT,
        BindFlags: D3D10_BIND.CONSTANT_BUFFER,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    }, null, constants), S_OK);
    device.PSSetConstantBuffers(1, [constants.resource]);

    /** @type {{ buffers: any[] }} */
    const pixelSlots = { buffers: [] };
    device.PSGetConstantBuffers(0, 3, pixelSlots);
    assert.equal(pixelSlots.buffers[0], null);
    assert.equal(pixelSlots.buffers[1], constants.resource);
    pixelSlots.buffers[1].release();

    /** @type {{ buffers?: any[] }} */
    const vertexSlots = {};
    device.VSGetConstantBuffers(0, 3, vertexSlots);
    assert.deepEqual(vertexSlots.buffers, [null, null, null]);

    constants.resource.release();
    pixelShader.shader.release();
    vertexShader.shader.release();
    assertFullyReleased(device);
});

test('a null blend factor means white, not black', ()=>{
    const device = createDevice();
    /** @type {{ state?: any }} */
    const created = {};
    assert.equal(device.CreateBlendState(BLEND_DESC, created), S_OK);

    device.OMSetBlendState(created.state, null, 0x0f);
    /** @type {{ state?: any, blendFactor?: number[], sampleMask?: number }} */
    const out = {};
    device.OMGetBlendState(out);
    assert.equal(out.state, created.state);
    assert.deepEqual(out.blendFactor, [1, 1, 1, 1]);
    assert.equal(out.sampleMask, 0x0f);
    out.state.release();

    device.OMSetBlendState(created.state, [0.25, 0.5, 0.75, 1], D3D10_DEFAULTS.SAMPLE_MASK);
    /** @type {{ state?: any, blendFactor?: number[] }} */
    const given = {};
    device.OMGetBlendState(given);
    assert.deepEqual(given.blendFactor, [0.25, 0.5, 0.75, 1]);
    given.state.release();

    created.state.release();
    assertFullyReleased(device);
});

test('viewports and scissor rectangles are lists, and an empty one is legal', ()=>{
    const device = createDevice();
    device.RSSetViewports([
        { TopLeftX: 0, TopLeftY: 0, Width: 640, Height: 480, MinDepth: 0, MaxDepth: 1 },
        { TopLeftX: 8, TopLeftY: 8, Width: 32, Height: 32, MinDepth: 0, MaxDepth: 1 },
    ]);
    device.RSSetScissorRects([{ left: 1, top: 2, right: 3, bottom: 4 }]);

    /** @type {{ count?: number, viewports: any[] }} */
    const viewports = { viewports: [] };
    device.RSGetViewports(viewports);
    assert.equal(viewports.count, 2);
    assert.equal(viewports.viewports[1].Width, 32);

    /** @type {{ count?: number, rects: any[] }} */
    const rects = { rects: [] };
    device.RSGetScissorRects(rects);
    assert.equal(rects.count, 1);
    assert.deepEqual(rects.rects[0], { left: 1, top: 2, right: 3, bottom: 4 });

    // More viewports than the pipeline has room for is a call Windows ignores
    // whole, as Wine's d3d10core tests show: what was set before stays.
    device.RSSetViewports(new Array(D3D10_LIMITS.VIEWPORT_AND_SCISSOR_SLOTS + 1).fill(
        { TopLeftX: 1, TopLeftY: 0, Width: 1, Height: 1, MinDepth: 0, MaxDepth: 1 }));
    device.RSGetViewports(viewports);
    assert.equal(viewports.count, 2);
    assert.equal(viewports.viewports[0].TopLeftX, 0);
    device.RSSetViewports(new Array(D3D10_LIMITS.VIEWPORT_AND_SCISSOR_SLOTS).fill(
        { TopLeftX: 1, TopLeftY: 0, Width: 1, Height: 1, MinDepth: 0, MaxDepth: 1 }));
    device.RSGetViewports(viewports);
    assert.equal(viewports.count, D3D10_LIMITS.VIEWPORT_AND_SCISSOR_SLOTS,
        'exactly as many is taken');

    device.RSSetViewports([]);
    device.RSGetViewports(viewports);
    assert.equal(viewports.count, 0);

    assertFullyReleased(device);
});

/**
 * What a cleared device holds is also what a fresh one holds, and the two
 * values that are not simply zero -- a white blend factor and a full sample
 * mask -- are the ones worth naming.
 */
test('clearing the state puts back exactly what a fresh device holds', ()=>{
    const device = createDevice();

    /** @type {{ state?: any }} */
    const blend = {};
    /** @type {{ state?: any }} */
    const rasterizer = {};
    /** @type {{ state?: any }} */
    const depthStencil = {};
    assert.equal(device.CreateBlendState(BLEND_DESC, blend), S_OK);
    assert.equal(device.CreateRasterizerState(RASTERIZER_DESC, rasterizer), S_OK);
    assert.equal(device.CreateDepthStencilState(DEPTH_STENCIL_DESC, depthStencil), S_OK);
    const sampler = createSampler(device);
    const texture = createTexture2D(device);
    /** @type {{ view?: any }} */
    const target = {};
    assert.equal(device.CreateRenderTargetView(texture, null, target), S_OK);

    device.OMSetBlendState(blend.state, [0, 0, 0, 0], 0x1234);
    device.OMSetDepthStencilState(depthStencil.state, 7);
    device.OMSetRenderTargets([target.view], target.view);
    device.RSSetState(rasterizer.state);
    device.RSSetViewports([
        { TopLeftX: 0, TopLeftY: 0, Width: 8, Height: 8, MinDepth: 0, MaxDepth: 1 },
    ]);
    device.RSSetScissorRects([{ left: 0, top: 0, right: 8, bottom: 8 }]);
    device.PSSetSamplers(0, [sampler]);
    device.IASetPrimitiveTopology(D3D10_PRIMITIVE_TOPOLOGY.TRIANGLESTRIP);
    device.IASetIndexBuffer(null, DXGI_FORMAT.R32_UINT, 4);

    device.ClearState();

    /** @type {{ state?: any, blendFactor?: number[], sampleMask?: number }} */
    const blendOut = {};
    device.OMGetBlendState(blendOut);
    assert.equal(blendOut.state, null);
    assert.deepEqual(blendOut.blendFactor, [1, 1, 1, 1], 'white, not zero');
    assert.equal(blendOut.sampleMask, D3D10_DEFAULTS.SAMPLE_MASK);

    /** @type {{ state?: any, stencilRef?: number }} */
    const depthOut = {};
    device.OMGetDepthStencilState(depthOut);
    assert.equal(depthOut.state, null);
    assert.equal(depthOut.stencilRef, 0);

    /** @type {{ views?: any[], depthStencilView?: any }} */
    const targets = {};
    device.OMGetRenderTargets(D3D10_LIMITS.SIMULTANEOUS_RENDER_TARGETS, targets);
    assert.deepEqual(targets.views,
        new Array(D3D10_LIMITS.SIMULTANEOUS_RENDER_TARGETS).fill(null));
    assert.equal(targets.depthStencilView, null);

    /** @type {{ state?: any }} */
    const rasterOut = {};
    device.RSGetState(rasterOut);
    assert.equal(rasterOut.state, null);

    /** @type {{ count?: number }} */
    const viewports = {};
    device.RSGetViewports(viewports);
    assert.equal(viewports.count, 0, 'not one viewport covering the target: none at all');
    /** @type {{ count?: number }} */
    const scissors = {};
    device.RSGetScissorRects(scissors);
    assert.equal(scissors.count, 0);

    /** @type {{ samplers?: any[] }} */
    const samplers = {};
    device.PSGetSamplers(0, D3D10_LIMITS.SAMPLER_SLOTS, samplers);
    assert.deepEqual(samplers.samplers, new Array(D3D10_LIMITS.SAMPLER_SLOTS).fill(null));

    /** @type {{ topology?: number }} */
    const topology = {};
    device.IAGetPrimitiveTopology(topology);
    assert.equal(topology.topology, D3D10_PRIMITIVE_TOPOLOGY.UNDEFINED);

    /** @type {{ buffer?: any, format?: number, offset?: number }} */
    const indices = {};
    device.IAGetIndexBuffer(indices);
    assert.equal(indices.buffer, null);
    assert.equal(indices.format, DXGI_FORMAT.UNKNOWN);
    assert.equal(indices.offset, 0);

    target.view.release();
    texture.release();
    sampler.release();
    depthStencil.state.release();
    rasterizer.state.release();
    blend.state.release();
    assertFullyReleased(device);
});

test('a buffer honours the usage and access table the tables describe', ()=>{
    const device = createDevice();
    const base = {
        ByteWidth: 1024,
        BindFlags: D3D10_BIND.VERTEX_BUFFER,
        MiscFlags: 0,
    };

    /** @type {{ resource?: any }} */
    const dynamic = {};
    assert.equal(device.CreateBuffer({
        ...base, Usage: D3D10_USAGE.DYNAMIC, CPUAccessFlags: D3D10_CPU_ACCESS.WRITE,
    }, null, dynamic), S_OK);
    dynamic.resource.release();

    /** @type {{ resource?: any }} */
    const unreachable = {};
    assert.equal(device.CreateBuffer({
        ...base, Usage: D3D10_USAGE.DYNAMIC, CPUAccessFlags: 0,
    }, null, unreachable), E_INVALIDARG, 'a dynamic buffer the CPU cannot write');

    /** @type {{ resource?: any }} */
    const readable = {};
    assert.equal(device.CreateBuffer({
        ...base, Usage: D3D10_USAGE.DYNAMIC, CPUAccessFlags: D3D10_CPU_ACCESS.READ,
    }, null, readable), E_INVALIDARG, 'dynamic means written by the CPU, not read');

    /** @type {{ resource?: any }} */
    const staging = {};
    assert.equal(device.CreateBuffer({
        ...base,
        BindFlags: 0,
        Usage: D3D10_USAGE.STAGING,
        CPUAccessFlags: D3D10_CPU_ACCESS.READ | D3D10_CPU_ACCESS.WRITE,
    }, null, staging), S_OK);
    staging.resource.release();

    assertFullyReleased(device);
});

// --- mapping ---

/**
 * Which maps a resource of each usage and access allows, as the runtime
 * decides it. Every row is a resource that can be created; the columns are
 * the five map kinds.
 *
 * @type {{ usage: number, access: number, read: boolean, write: boolean,
 *          readWrite: boolean, discard: boolean, noOverwrite: boolean }[]}
 */
const MAP_TABLE = [
    { usage: D3D10_USAGE.DEFAULT, access: 0,
        read: false, write: false, readWrite: false, discard: false, noOverwrite: false },
    { usage: D3D10_USAGE.DYNAMIC, access: D3D10_CPU_ACCESS.WRITE,
        read: false, write: false, readWrite: false, discard: true, noOverwrite: true },
    { usage: D3D10_USAGE.STAGING, access: D3D10_CPU_ACCESS.READ,
        read: true, write: false, readWrite: false, discard: false, noOverwrite: false },
    { usage: D3D10_USAGE.STAGING, access: D3D10_CPU_ACCESS.WRITE,
        read: false, write: true, readWrite: false, discard: false, noOverwrite: false },
    { usage: D3D10_USAGE.STAGING, access: D3D10_CPU_ACCESS.READ | D3D10_CPU_ACCESS.WRITE,
        read: true, write: true, readWrite: true, discard: false, noOverwrite: false },
];

test('a buffer allows the maps its usage and access say, and no others', ()=>{
    const device = createDevice();
    for (const row of MAP_TABLE)
    {
        /** @type {{ resource?: any }} */
        const out = {};
        assert.equal(device.CreateBuffer({
            ByteWidth: 64,
            Usage: row.usage,
            BindFlags: row.usage === D3D10_USAGE.STAGING ? 0 : D3D10_BIND.VERTEX_BUFFER,
            CPUAccessFlags: row.access,
            MiscFlags: 0,
        }, null, out), S_OK);
        const buffer = out.resource;
        const expectations = [
            [D3D10_MAP.READ, row.read], [D3D10_MAP.WRITE, row.write],
            [D3D10_MAP.READ_WRITE, row.readWrite], [D3D10_MAP.WRITE_DISCARD, row.discard],
            [D3D10_MAP.WRITE_NO_OVERWRITE, row.noOverwrite],
        ];
        for (const [mapType, allowed] of expectations)
        {
            /** @type {{ data?: Uint8Array | null }} */
            const mapped = {};
            const hr = buffer.Map(0, mapType, 0, mapped);
            assert.equal(hr, allowed ? S_OK : E_INVALIDARG,
                `usage ${row.usage} access ${row.access} map ${mapType}`);
            if (hr === S_OK)
            {
                assert.equal(/** @type {Uint8Array} */ (mapped.data).length, 64);
                buffer.Unmap(0);
            }
            else
            {
                assert.equal(mapped.data, null);
            }
        }
        assert.equal(buffer.Map(0, 0, 0, {}), E_INVALIDARG, 'zero is not a map type');
        buffer.release();
    }
    assertFullyReleased(device);
});

test('a texture allows the same maps, except that no-overwrite is a buffer\'s promise', ()=>{
    const device = createDevice();
    for (const row of MAP_TABLE)
    {
        /** @type {{ resource?: any }} */
        const out = {};
        assert.equal(device.CreateTexture2D({
            ...TEXTURE_2D,
            Usage: row.usage,
            BindFlags: row.usage === D3D10_USAGE.STAGING
                ? 0
                : D3D10_BIND.SHADER_RESOURCE,
            CPUAccessFlags: row.access,
        }, null, out), S_OK, `usage ${row.usage} access ${row.access}`);
        const texture = out.resource;
        const expectations = [
            [D3D10_MAP.READ, row.read], [D3D10_MAP.WRITE, row.write],
            [D3D10_MAP.READ_WRITE, row.readWrite], [D3D10_MAP.WRITE_DISCARD, row.discard],
            [D3D10_MAP.WRITE_NO_OVERWRITE, false],
        ];
        for (const [mapType, allowed] of expectations)
        {
            /** @type {{ data?: Uint8Array | null, rowPitch?: number }} */
            const mapped = {};
            const hr = texture.Map(0, mapType, 0, mapped);
            assert.equal(hr, allowed ? S_OK : E_INVALIDARG,
                `usage ${row.usage} access ${row.access} map ${mapType}`);
            if (hr === S_OK)
            {
                assert.equal(mapped.rowPitch, 512 * 4);
                assert.equal(/** @type {Uint8Array} */ (mapped.data).length, 512 * 512 * 4);
                texture.Unmap(0);
            }
        }
        assert.equal(texture.Map(1, D3D10_MAP.READ, 0, {}), E_INVALIDARG,
            'a subresource the texture does not have');
        texture.release();
    }
    assertFullyReleased(device);
});

test('a mip level maps at its own pitch and size', ()=>{
    const device = createDevice();
    /** @type {{ resource?: any }} */
    const out = {};
    assert.equal(device.CreateTexture2D({
        ...TEXTURE_2D,
        Width: 16,
        Height: 8,
        MipLevels: 0,
        Usage: D3D10_USAGE.STAGING,
        BindFlags: 0,
        CPUAccessFlags: D3D10_CPU_ACCESS.READ,
    }, null, out), S_OK);
    const texture = out.resource;
    /** @type {{ data?: Uint8Array | null, rowPitch?: number }} */
    const level2 = {};
    assert.equal(texture.Map(2, D3D10_MAP.READ, 0, level2), S_OK);
    assert.equal(level2.rowPitch, 4 * 4);
    assert.equal(/** @type {Uint8Array} */ (level2.data).length, 4 * 2 * 4);
    texture.Unmap(2);
    assert.equal(texture.Map(5, D3D10_MAP.READ, 0, {}), E_INVALIDARG, 'five levels: 0..4');
    texture.release();
    assertFullyReleased(device);
});

// --- generating mips ---

test('a texture that will generate mips has to be a target and a shader resource', ()=>{
    const device = createDevice();
    const withMips = { ...TEXTURE_2D, MiscFlags: D3D10_RESOURCE_MISC.GENERATE_MIPS };
    /** @type {{ resource?: any }} */
    const out = {};
    assert.equal(device.CreateTexture2D({ ...withMips, BindFlags: D3D10_BIND.SHADER_RESOURCE },
        null, out), E_INVALIDARG);
    assert.equal(device.CreateTexture2D({ ...withMips, BindFlags: D3D10_BIND.RENDER_TARGET },
        null, out), E_INVALIDARG);
    assert.equal(device.CreateTexture2D({
        ...withMips, BindFlags: D3D10_BIND.RENDER_TARGET | D3D10_BIND.SHADER_RESOURCE,
    }, null, out), S_OK);
    out.resource.release();
    assertFullyReleased(device);
});

// --- queries ---

test('a query is made for every kind, and only two kinds are predicates', ()=>{
    const device = createDevice();
    assert.equal(device.CreateQuery(null, {}), E_INVALIDARG);
    assert.equal(device.CreatePredicate(null, {}), E_INVALIDARG);
    for (const kind of Object.values(D3D10_QUERY))
    {
        const desc = { Query: kind, MiscFlags: 0 };
        const predicate = kind === D3D10_QUERY.OCCLUSION_PREDICATE
            || kind === D3D10_QUERY.SO_OVERFLOW_PREDICATE;
        assert.equal(device.CreateQuery(desc, null), S_FALSE, `query ${kind} can be made`);
        /** @type {{ query?: any }} */
        const out = {};
        assert.equal(device.CreateQuery(desc, out), S_OK);
        assert.equal(out.query.supports(IID.ID3D10Query), true);
        assert.equal(out.query.supports(IID.ID3D10Asynchronous), true);
        assert.equal(out.query.supports(IID.ID3D10Predicate), predicate);
        /** @type {{ device?: any }} */
        const owner = {};
        out.query.GetDevice(owner);
        assert.equal(owner.device, device);
        device.release();
        out.query.release();
        assert.equal(device.CreatePredicate(desc, null), predicate ? S_FALSE : E_INVALIDARG);
        /** @type {{ query?: any }} */
        const made = {};
        assert.equal(device.CreatePredicate(desc, made), predicate ? S_OK : E_INVALIDARG);
        if (predicate)
        {
            made.query.release();
        }
        else
        {
            assert.equal(made.query, null);
        }
    }
    assert.equal(device.CreateQuery({ Query: 8, MiscFlags: 0 }, null), E_INVALIDARG);
    assert.equal(device.CreateCounter({ Counter: 0 }, {}), DXGI_ERROR_UNSUPPORTED);
    assertFullyReleased(device);
});

/**
 * @param {any} device
 * @param {number} kind
 */
function createQuery(device, kind){
    /** @type {{ query?: any }} */
    const out = {};
    assert.equal(device.CreateQuery({ Query: kind, MiscFlags: 0 }, out), S_OK);
    return out.query;
}

/**
 * The answer a query gives into a buffer of its own size.
 *
 * @param {any} query
 * @returns {{ hr: number, view: DataView | null }}
 */
function queryData(query){
    /** @type {{ data?: Uint8Array | null }} */
    const out = {};
    const hr = query.GetData(true, query.GetDataSize(), 0, out);
    return {
        hr,
        view: out.data ? new DataView(out.data.buffer, out.data.byteOffset, out.data.length)
            : null,
    };
}

/**
 * A 640x480 target, its view bound with a full viewport, and a four-vertex
 * strip ready to draw: the context Wine's query tests draw in.
 *
 * @param {any} device
 * @param {{ pixelShader?: boolean }} [options]
 */
function bindQuad(device, options = {}){
    const texture = createTexture2D(device, { Width: 640, Height: 480 });
    /** @type {{ view?: any }} */
    const view = {};
    assert.equal(device.CreateRenderTargetView(texture, null, view), S_OK);
    /** @type {{ shader?: any }} */
    const vs = {};
    assert.equal(device.CreateVertexShader(passThroughVertexShader(), vs), S_OK);
    device.VSSetShader(vs.shader);
    /** @type {{ shader?: any }} */
    const ps = {};
    if (options.pixelShader)
    {
        assert.equal(device.CreatePixelShader(solidPixelShader([1, 0, 0, 1]), ps), S_OK);
        device.PSSetShader(ps.shader);
    }
    device.IASetPrimitiveTopology(D3D10_PRIMITIVE_TOPOLOGY.TRIANGLESTRIP);
    device.OMSetRenderTargets([view.view], null);
    device.RSSetViewports([{
        TopLeftX: 0, TopLeftY: 0, Width: 640, Height: 480, MinDepth: 0, MaxDepth: 1,
    }]);
    return [texture, view.view, vs.shader, ps.shader ?? null];
}

test('each kind of query answers a structure of its own size', ()=>{
    // After Wine's d3d10core test_occlusion_query, test_pipeline_statistics_query,
    // test_timestamp_query and test_so_statistics_query, and the header's structures.
    const device = createDevice();
    const sizes = {
        [D3D10_QUERY.EVENT]: 4,
        [D3D10_QUERY.OCCLUSION]: 8,
        [D3D10_QUERY.TIMESTAMP]: 8,
        [D3D10_QUERY.TIMESTAMP_DISJOINT]: 16,
        [D3D10_QUERY.PIPELINE_STATISTICS]: 64,
        [D3D10_QUERY.OCCLUSION_PREDICATE]: 4,
        [D3D10_QUERY.SO_STATISTICS]: 16,
        [D3D10_QUERY.SO_OVERFLOW_PREDICATE]: 4,
    };
    for (const [kind, size] of Object.entries(sizes))
    {
        const query = createQuery(device, Number(kind));
        assert.equal(query.GetDataSize(), size, `query ${kind}`);
        query.release();
    }
    assertFullyReleased(device);
});

test('a query never ended, or begun again, has no answer and says so', ()=>{
    const device = createDevice();
    const query = createQuery(device, D3D10_QUERY.OCCLUSION);
    /** @type {{ data?: Uint8Array | null }} */
    const out = {};
    assert.equal(query.GetData(false, 0, 0, out), DXGI_ERROR_INVALID_CALL);
    assert.equal(query.GetData(true, 8, 0, out), DXGI_ERROR_INVALID_CALL);
    // An end with no beginning is nothing; a beginning makes it build.
    query.End();
    query.Begin();
    query.Begin();
    assert.equal(query.GetData(false, 0, 0, out), DXGI_ERROR_INVALID_CALL);
    query.End();
    assert.equal(query.GetData(false, 0, 0, out), S_OK);
    query.release();

    const event = createQuery(device, D3D10_QUERY.EVENT);
    assert.equal(event.GetData(true, 4, 0, out), DXGI_ERROR_INVALID_CALL);
    event.Begin();
    assert.equal(event.GetData(true, 4, 0, out), DXGI_ERROR_INVALID_CALL,
        'an event has no beginning, and Begin does not issue it');
    event.End();
    const answer = queryData(event);
    assert.equal(answer.hr, S_OK);
    assert.equal(answer.view?.getUint32(0, true), 1, 'TRUE: the work before it is done');
    event.release();
    assertFullyReleased(device);
});

test('an answer is refused into a buffer of any size but its own', ()=>{
    const device = createDevice();
    const query = createQuery(device, D3D10_QUERY.OCCLUSION);
    query.Begin();
    query.End();
    /** @type {{ data?: Uint8Array | null }} */
    const out = {};
    for (const size of [4, 2, 7, 9])
    {
        assert.equal(query.GetData(true, size, 0, out), E_INVALIDARG, `${size} bytes`);
        assert.equal(out.data, null, 'nothing is written');
    }
    assert.equal(query.GetData(true, 0, 0, out), S_OK, 'no room asks only whether it is ready');
    assert.equal(out.data, null);
    assert.equal(query.GetData(false, 4, 0, out), E_INVALIDARG, 'a size with nowhere to put it');
    assert.equal(query.GetData(false, 8, 0, out), E_INVALIDARG);
    query.release();
    assertFullyReleased(device);
});

test('an occlusion query counts the samples its draws cover, and none for no draw', ()=>{
    const device = createDevice();
    const bound = bindQuad(device, { pixelShader: true });
    const query = createQuery(device, D3D10_QUERY.OCCLUSION);
    const predicate = createQuery(device, D3D10_QUERY.OCCLUSION_PREDICATE);
    query.Begin();
    predicate.Begin();
    device.Draw(4, 0);
    query.End();
    predicate.End();
    assert.equal(queryData(query).view?.getBigUint64(0, true), 640n * 480n);
    assert.equal(queryData(predicate).view?.getUint32(0, true), 1);

    query.Begin();
    query.End();
    query.End();
    assert.equal(queryData(query).view?.getBigUint64(0, true), 0n);
    predicate.Begin();
    predicate.End();
    assert.equal(queryData(predicate).view?.getUint32(0, true), 0);
    query.release();
    predicate.release();
    bound.forEach(object=>object?.release());
    assertFullyReleased(device);
});

test('pipeline statistics count what the input assembler and the shaders were given', ()=>{
    const device = createDevice();
    const bound = bindQuad(device);
    const query = createQuery(device, D3D10_QUERY.PIPELINE_STATISTICS);
    query.Begin();
    device.Draw(4, 0);
    query.End();
    let view = /** @type {DataView} */ (queryData(query).view);
    const counters = ()=>[0, 8, 16, 24, 32, 40, 48, 56]
        .map(at=>Number(view.getBigUint64(at, true)));
    assert.deepEqual(counters(), [4, 2, 4, 0, 0, 2, 2, 0],
        'IA vertices and primitives, VS, GS, clipper in and out, and no pixel shader');

    /** @type {{ shader?: any }} */
    const ps = {};
    assert.equal(device.CreatePixelShader(solidPixelShader([1, 0, 0, 1]), ps), S_OK);
    device.PSSetShader(ps.shader);
    query.Begin();
    device.DrawInstanced(4, 3, 0, 0);
    query.End();
    view = /** @type {DataView} */ (queryData(query).view);
    assert.deepEqual(counters().slice(0, 3), [12, 6, 12], 'three instances');
    assert.ok(counters()[7] >= 3 * 640 * 480, 'a pixel shader runs over what is covered');
    query.release();
    ps.shader.release();
    bound.forEach(object=>object?.release());
    assertFullyReleased(device);
});

test('a timestamp ends where it is issued, and its disjoint query says to discard it', ()=>{
    let clock = 5;
    /** @type {{ device?: any }} */
    const out = {};
    /** @type {string[]} */
    const divergences = [];
    assert.equal(D3D10CreateDevice(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0,
        D3D10_SDK_VERSION, out, {
            now: ()=>clock,
            divergence: (api, detail)=>divergences.push(detail),
        }), S_OK);
    const device = out.device;
    const disjoint = createQuery(device, D3D10_QUERY.TIMESTAMP_DISJOINT);
    const stamp = createQuery(device, D3D10_QUERY.TIMESTAMP);
    disjoint.Begin();
    assert.equal(queryData(disjoint).hr, DXGI_ERROR_INVALID_CALL);
    assert.equal(queryData(stamp).hr, DXGI_ERROR_INVALID_CALL);
    stamp.End();
    clock = 7;
    const first = queryData(stamp);
    assert.equal(first.hr, S_OK);
    assert.equal(first.view?.getBigUint64(0, true), 5_000_000n, 'nanoseconds at its end');
    stamp.End();
    assert.equal(queryData(stamp).view?.getBigUint64(0, true), 7_000_000n);
    disjoint.End();
    const answer = queryData(disjoint);
    assert.equal(answer.hr, S_OK);
    assert.equal(answer.view?.getBigUint64(0, true), 1_000_000_000n, 'Frequency');
    assert.equal(answer.view?.getUint32(8, true), 1, 'Disjoint: this clock is not the GPU\'s');
    // The clock is the one the device was handed -- the guest's, in an
    // assembled build -- so the report names neither.
    assert.ok(divergences.some(line=>line.includes('the clock the device was given, not the'
        + ' GPU\'s')), divergences.join('; '));
    stamp.release();
    disjoint.release();
    assertFullyReleased(device);
});

test('stream-output queries count nothing written and no overflow', ()=>{
    const device = createDevice();
    const bound = bindQuad(device);
    const statistics = createQuery(device, D3D10_QUERY.SO_STATISTICS);
    const overflow = createQuery(device, D3D10_QUERY.SO_OVERFLOW_PREDICATE);
    statistics.Begin();
    overflow.Begin();
    device.Draw(4, 0);
    statistics.End();
    overflow.End();
    const data = queryData(statistics);
    assert.equal(data.hr, S_OK);
    assert.equal(data.view?.getBigUint64(0, true), 0n);
    assert.equal(data.view?.getBigUint64(8, true), 0n);
    assert.equal(queryData(overflow).view?.getUint32(0, true), 0);
    statistics.release();
    overflow.release();
    bound.forEach(object=>object?.release());
    assertFullyReleased(device);
});

// --- private data ---

test('private data is kept per object and an interface entry holds a reference', ()=>{
    const device = createDevice();
    const guid = '{12345678-1234-1234-1234-123456789ABC}';
    assert.equal(device.SetPrivateData(guid, 0, null), S_FALSE, 'nothing to clear');
    assert.equal(device.SetPrivateDataInterface(guid, null), S_OK, 'a null interface is an entry');
    assert.equal(device.SetPrivateData(guid, 0xffffffff, null), S_OK, 'which a clear removes');
    assert.equal(device.SetPrivateData(guid, 0xffffffff, null), S_FALSE);

    assert.equal(device.SetPrivateDataInterface(guid, null), S_OK);
    assert.deepEqual(device.GetPrivateData(guid, { size: 8, wantsData: true }),
        { hr: S_OK, size: 4, object: null, pointer: 0 });

    const other = createDevice();
    const before = other.refCount;
    assert.equal(device.SetPrivateDataInterface(guid, other), S_OK);
    assert.equal(other.refCount, before + 1);
    assert.equal(device.SetPrivateDataInterface(guid, other), S_OK, 'setting it again');
    assert.equal(other.refCount, before + 1, 'holds one reference, not two');
    assert.equal(device.SetPrivateDataInterface(guid, null), S_OK);
    assert.equal(other.refCount, before, 'and gives it back');

    assert.equal(device.SetPrivateDataInterface(guid, other), S_OK);
    assert.equal(device.SetPrivateData(guid, 4, Uint8Array.from([1, 2, 3, 4])), S_OK);
    assert.equal(other.refCount, before, 'bytes replace the interface and release it');
    assert.equal(device.SetPrivateData(guid, 42, null), S_OK);
    assert.equal(device.SetPrivateData(guid, 42, null), S_FALSE);

    assert.equal(device.SetPrivateDataInterface(guid, other, 0x1234), S_OK);
    const answered = device.GetPrivateData(guid, { size: 8, wantsData: true });
    assert.equal(answered.hr, S_OK);
    assert.equal(answered.size, 4);
    assert.equal(answered.object, other);
    assert.equal(answered.pointer, 0x1234, 'the pointer it was given, through its interface');
    assert.equal(other.refCount, before + 2, 'reading takes a reference for the caller');
    other.release();

    assert.deepEqual(device.GetPrivateData(guid, { size: 1, wantsData: false }),
        { hr: S_OK, size: 4 }, 'no room is needed to ask the size');
    assert.deepEqual(device.GetPrivateData(guid, { size: 1, wantsData: true }),
        { hr: DXGI_ERROR_MORE_DATA, size: 4 });
    assert.deepEqual(device.GetPrivateData(guid, { size: null, wantsData: true }),
        { hr: E_INVALIDARG, size: 0 });
    assert.deepEqual(
        device.GetPrivateData('{00000000-0000-0000-0000-000000000001}',
            { size: 8, wantsData: true }),
        { hr: DXGI_ERROR_NOT_FOUND, size: 0 });

    const texture = createTexture2D(device);
    assert.equal(texture.SetPrivateData(guid, 2, Uint8Array.from([7, 8])), S_OK);
    assert.deepEqual(texture.GetPrivateData(guid, { size: 2, wantsData: true }),
        { hr: S_OK, size: 2, data: Uint8Array.from([7, 8]) });
    // An object gone lets go of the interfaces it held (test_private_data).
    const kept = other.refCount;
    assert.equal(texture.SetPrivateDataInterface('{87654321-1234-1234-1234-123456789ABC}',
        other), S_OK);
    assert.equal(other.refCount, kept + 1);
    texture.release();
    assert.equal(other.refCount, kept, 'the texture gone, its reference with it');

    assert.equal(device.SetPrivateDataInterface(guid, null), S_OK);
    assert.equal(other.refCount, before);
    assertFullyReleased(other);
    assertFullyReleased(device);
});

// --- format support ---

test('a format reports what it can be used for, and an unknown one fails', ()=>{
    const device = createDevice();
    /** @type {{ support?: number }} */
    const out = {};
    assert.equal(device.CheckFormatSupport(0xffffffff, out), E_FAIL);
    assert.equal(out.support, 0);
    assert.equal(device.CheckFormatSupport(DXGI_FORMAT.R8G8B8A8_UNORM, out), S_OK);
    const rgba = /** @type {number} */ (out.support);
    assert.ok(rgba & 0x200, 'sampled');
    assert.ok(rgba & 0x4000, 'a render target');
    assert.ok(rgba & 0x2, 'a vertex buffer');
    assert.ok(!(rgba & 0x4), 'not an index buffer');
    assert.ok(!(rgba & 0x800000), 'never gathered');
    assert.equal(device.CheckFormatSupport(DXGI_FORMAT.R32G32B32A32_UINT, out), S_OK);
    assert.ok(/** @type {number} */ (out.support) & 0x100, 'loaded');
    assert.ok(!(/** @type {number} */ (out.support) & 0x200), 'integers are not sampled');
    assert.equal(device.CheckFormatSupport(DXGI_FORMAT.R16_UINT, out), S_OK);
    assert.ok(/** @type {number} */ (out.support) & 0x4, 'an index buffer');
    assert.equal(device.CheckFormatSupport(DXGI_FORMAT.D24_UNORM_S8_UINT, out), S_OK);
    assert.ok(/** @type {number} */ (out.support) & 0x10000, 'a depth stencil');
    assertFullyReleased(device);
});

test('a GPU without texture-formats-tier1 is claimed no snorm target and no 16-bit normalised'
    + ' texture; with it, both', ()=>{
    /** @param {any} device @param {number} format */
    const support = (device, format)=>{
        /** @type {{ support?: number }} */
        const out = {};
        assert.equal(device.CheckFormatSupport(format, out), S_OK);
        return /** @type {number} */ (out.support);
    };
    const [TEXTURE2D, RENDER_TARGET] = [0x20, 0x4000];
    const core = createDevice({ formatsTier1: false, rg11b10Renderable: false });
    assert.ok(support(core, DXGI_FORMAT.R8G8B8A8_SNORM) & TEXTURE2D, 'sampled still');
    assert.equal(support(core, DXGI_FORMAT.R8G8B8A8_SNORM) & RENDER_TARGET, 0);
    assert.equal(support(core, DXGI_FORMAT.R16G16B16A16_UNORM) & TEXTURE2D, 0);
    assert.equal(support(core, DXGI_FORMAT.R11G11B10_FLOAT) & RENDER_TARGET, 0);
    assert.ok(support(core, DXGI_FORMAT.R8G8B8A8_UNORM) & RENDER_TARGET);
    assertFullyReleased(core);
    const tier1 = createDevice({ formatsTier1: true });
    for (const format of [DXGI_FORMAT.R8G8B8A8_SNORM, DXGI_FORMAT.R16G16B16A16_UNORM,
        DXGI_FORMAT.R16G16B16A16_SNORM, DXGI_FORMAT.R11G11B10_FLOAT])
    {
        assert.equal(support(tier1, format) & (TEXTURE2D | RENDER_TARGET),
            TEXTURE2D | RENDER_TARGET, `${format}`);
    }
    assertFullyReleased(tier1);
});

test('a level 11 device answers support for a format as Wine test_format_support sees Windows'
    + ' do: no format is E_FAIL with none written, and snorm blends from 10.1', ()=>{
    /** @param {number} level */
    const device11 = level=>{
        /** @type {any} */
        const out = { wantDevice: true, wantContext: false };
        assert.equal(D3D11CreateDevice(null, 1, null, 0, [level], out, {}), S_OK);
        return out.device;
    };
    /** @param {any} device @param {number} format */
    const asked = (device, format)=>device.CheckFeatureSupport(2,
        new Uint8Array(Uint32Array.of(format, 0xdeadbeef).buffer));
    const BLENDABLE = 0x8000;
    const ten = device11(D3D_FEATURE_LEVEL.LEVEL_10_0);
    const none = asked(ten, 0xffffffff);
    assert.equal(none.hr, E_FAIL);
    assert.equal(new Uint32Array(none.data.buffer)[1], 0, 'none written as none');
    const rgba = asked(ten, DXGI_FORMAT.R8G8B8A8_UNORM);
    assert.equal(rgba.hr, S_OK);
    /** @type {{ support?: number }} */
    const held = {};
    ten.CheckFormatSupport(DXGI_FORMAT.R8G8B8A8_UNORM, held);
    assert.equal(new Uint32Array(rgba.data.buffer)[1], held.support,
        'the same as CheckFormatSupport');
    ten.CheckFormatSupport(DXGI_FORMAT.R8G8B8A8_SNORM, held);
    assert.equal(/** @type {number} */ (held.support) & BLENDABLE, 0, 'not blended at 10.0');
    const eleven = device11(D3D_FEATURE_LEVEL.LEVEL_11_0);
    eleven.CheckFormatSupport(DXGI_FORMAT.R8G8B8A8_SNORM, held);
    assert.ok(/** @type {number} */ (held.support) & BLENDABLE, 'blended at 11.0');
});

test('a multisampled texture may name the standard or centre pattern for its quality from'
    + ' level 10.1, as Wine\'s test_standard_pattern makes one', ()=>{
    /** @param {number} level @param {number} quality */
    const made = (level, quality)=>{
        /** @type {any} */
        const out = { wantDevice: true, wantContext: false };
        assert.equal(D3D11CreateDevice(null, 1, null, 0, [level], out, {}), S_OK);
        /** @type {{ resource?: any }} */
        const texture = {};
        const hr = out.device.CreateTexture2D({ Width: 8, Height: 8, MipLevels: 1, ArraySize: 1,
            Format: DXGI_FORMAT.R8G8B8A8_UNORM, SampleDesc: { Count: 4, Quality: quality },
            Usage: 0, BindFlags: 0x20 | 0x8, CPUAccessFlags: 0, MiscFlags: 0 }, null, texture);
        texture.resource?.release();
        out.device.release();
        return hr;
    };
    assert.equal(made(D3D_FEATURE_LEVEL.LEVEL_11_0, 0xffffffff), S_OK, 'the standard pattern');
    assert.equal(made(D3D_FEATURE_LEVEL.LEVEL_10_1, 0xfffffffe), S_OK, 'the centre pattern');
    assert.equal(made(D3D_FEATURE_LEVEL.LEVEL_10_0, 0xffffffff), E_INVALIDARG, 'not at 10.0');
    assert.equal(made(D3D_FEATURE_LEVEL.LEVEL_11_0, 7), E_INVALIDARG,
        'a level past the ones it has');
});

test('the compressed, packed and typeless formats report what this device does with them', ()=>{
    // After Wine's d3d10core test_format_support and its display format list.
    const device = createDevice();
    /** @param {number} format */
    const support = format=>{
        /** @type {{ support?: number }} */
        const out = {};
        assert.equal(device.CheckFormatSupport(format, out), S_OK, `format ${format}`);
        return /** @type {number} */ (out.support);
    };
    for (const format of [DXGI_FORMAT.BC1_UNORM, DXGI_FORMAT.BC3_UNORM_SRGB,
        DXGI_FORMAT.BC4_SNORM, DXGI_FORMAT.BC5_UNORM])
    {
        const bits = support(format);
        assert.ok(bits & 0x20, 'a 2D texture');
        assert.ok(bits & 0x200, 'sampled');
        assert.ok(!(bits & 0x4000), 'never a render target');
        assert.ok(!(bits & 0x1), 'never a buffer');
    }
    assert.ok(support(DXGI_FORMAT.R11G11B10_FLOAT) & 0x4000, 'R11G11B10 is a render target');
    assert.ok(!(support(DXGI_FORMAT.R9G9B9E5_SHAREDEXP) & 0x4000), 'a shared exponent is not');
    assert.ok(support(DXGI_FORMAT.R9G9B9E5_SHAREDEXP) & 0x200);
    assert.ok(!(support(DXGI_FORMAT.R32G32B32A32_FLOAT) & 0x200),
        'a 32-bit float is loaded, not filtered');
    assert.ok(support(DXGI_FORMAT.R16_FLOAT) & 0x2, 'a one-channel vertex element');
    assert.ok(support(DXGI_FORMAT.R8G8_UINT) & 0x2);
    // display_format_support (d3d10core.c:54-63): the four required, the BGRA
    // pair allowed; nothing else is shown.
    for (const format of [DXGI_FORMAT.R8G8B8A8_UNORM, DXGI_FORMAT.R8G8B8A8_UNORM_SRGB,
        DXGI_FORMAT.B8G8R8A8_UNORM, DXGI_FORMAT.B8G8R8A8_UNORM_SRGB,
        DXGI_FORMAT.R16G16B16A16_FLOAT, DXGI_FORMAT.R10G10B10A2_UNORM])
    {
        assert.ok(support(format) & 0x80000, `format ${format} can be displayed`);
    }
    for (const format of [DXGI_FORMAT.R8G8B8A8_TYPELESS, DXGI_FORMAT.B8G8R8X8_UNORM,
        DXGI_FORMAT.R32G32B32A32_FLOAT])
    {
        assert.ok(!(support(format) & 0x80000), `format ${format} is not displayed`);
    }
    for (const format of [DXGI_FORMAT.R1_UNORM, DXGI_FORMAT.B5G6R5_UNORM,
        DXGI_FORMAT.B5G5R5A1_UNORM])
    {
        /** @type {{ support?: number }} */
        const out = {};
        assert.equal(device.CheckFormatSupport(format, out), E_FAIL, `format ${format}`);
    }
    assertFullyReleased(device);
});

test('a texture is made in every format a shader can read, and drawn into only in those'
    + ' a shader can write', ()=>{
    // After the format table of Wine's d3d10core test_create_texture2d.
    const device = createDevice();
    /** @param {number} format @param {number} bindFlags */
    const result = (format, bindFlags)=>{
        /** @type {{ resource?: any }} */
        const out = {};
        const hr = device.CreateTexture2D({
            ...TEXTURE_2D, Width: 16, Height: 16, Format: format, BindFlags: bindFlags,
        }, null, out);
        out.resource?.release();
        return hr;
    };
    const { SHADER_RESOURCE, RENDER_TARGET, DEPTH_STENCIL } = D3D10_BIND;
    for (const format of [
        DXGI_FORMAT.BC1_TYPELESS, DXGI_FORMAT.BC1_UNORM, DXGI_FORMAT.BC1_UNORM_SRGB,
        DXGI_FORMAT.BC2_TYPELESS, DXGI_FORMAT.BC2_UNORM, DXGI_FORMAT.BC2_UNORM_SRGB,
        DXGI_FORMAT.BC3_TYPELESS, DXGI_FORMAT.BC3_UNORM, DXGI_FORMAT.BC3_UNORM_SRGB,
        DXGI_FORMAT.BC4_TYPELESS, DXGI_FORMAT.BC4_UNORM, DXGI_FORMAT.BC4_SNORM,
        DXGI_FORMAT.BC5_TYPELESS, DXGI_FORMAT.BC5_UNORM, DXGI_FORMAT.BC5_SNORM,
    ])
    {
        assert.equal(result(format, SHADER_RESOURCE), S_OK, `format ${format} is sampled`);
        assert.equal(result(format, RENDER_TARGET), E_INVALIDARG, `format ${format} is not drawn`);
    }
    assert.equal(result(DXGI_FORMAT.R9G9B9E5_SHAREDEXP, SHADER_RESOURCE), S_OK);
    assert.equal(result(DXGI_FORMAT.R9G9B9E5_SHAREDEXP, RENDER_TARGET), E_INVALIDARG);
    assert.equal(result(DXGI_FORMAT.R9G9B9E5_SHAREDEXP, DEPTH_STENCIL), E_INVALIDARG);
    assert.equal(result(DXGI_FORMAT.R11G11B10_FLOAT, RENDER_TARGET), S_OK);
    assert.equal(result(DXGI_FORMAT.R32G8X24_TYPELESS, DEPTH_STENCIL), S_OK);
    assert.equal(result(DXGI_FORMAT.R32G8X24_TYPELESS, RENDER_TARGET), E_INVALIDARG);
    assert.equal(result(DXGI_FORMAT.R16_TYPELESS, RENDER_TARGET), S_OK);
    assert.equal(result(DXGI_FORMAT.R16_TYPELESS, DEPTH_STENCIL | SHADER_RESOURCE), S_OK);
    assert.equal(result(DXGI_FORMAT.R24_UNORM_X8_TYPELESS, RENDER_TARGET), E_INVALIDARG);
    assert.equal(result(DXGI_FORMAT.R8G8B8A8_UNORM, DEPTH_STENCIL), E_INVALIDARG);
    assert.equal(result(DXGI_FORMAT.R10G10B10A2_UINT, RENDER_TARGET), S_OK);
    assert.equal(result(DXGI_FORMAT.B5G6R5_UNORM, SHADER_RESOURCE), E_INVALIDARG,
        'not a format of this version of the API');
    assertFullyReleased(device);
});

test('a block-compressed texture maps a row of blocks at a time', ()=>{
    const device = createDevice();
    /** @type {{ resource?: any }} */
    const out = {};
    assert.equal(device.CreateTexture2D({
        ...TEXTURE_2D, Width: 8, Height: 8, MipLevels: 0, Format: DXGI_FORMAT.BC3_UNORM,
        Usage: D3D10_USAGE.STAGING, BindFlags: 0,
        CPUAccessFlags: D3D10_CPU_ACCESS.READ | D3D10_CPU_ACCESS.WRITE,
    }, null, out), S_OK);
    /** @type {{ data?: Uint8Array | null, rowPitch?: number, depthPitch?: number }} */
    const mapped = {};
    assert.equal(out.resource.Map(0, D3D10_MAP.READ, 0, mapped), S_OK);
    assert.equal(mapped.rowPitch, 32, 'two blocks of sixteen bytes');
    assert.equal(mapped.data?.length, 64, 'two rows of blocks');
    out.resource.Unmap(0);
    assert.equal(out.resource.Map(3, D3D10_MAP.READ, 0, mapped), S_OK);
    assert.equal(mapped.rowPitch, 16, 'a 1x1 level is still one whole block');
    assert.equal(mapped.data?.length, 16);
    out.resource.Unmap(3);
    out.resource.release();
    assertFullyReleased(device);
});

test('a copy moves bits within a format family and never between families', ()=>{
    // After Wine's d3d10core test_format_compatibility and
    // test_compressed_format_compatibility.
    const device = createDevice();
    /**
     * @param {number} format @param {number} width @param {number} height
     * @param {Uint8Array} bytes
     */
    const texture = (format, width, height, bytes)=>{
        /** @type {{ resource?: any }} */
        const out = {};
        assert.equal(device.CreateTexture2D({
            ...TEXTURE_2D, Width: width, Height: height, Format: format,
            Usage: D3D10_USAGE.STAGING, BindFlags: 0,
            CPUAccessFlags: D3D10_CPU_ACCESS.READ | D3D10_CPU_ACCESS.WRITE,
        }, [{ pSysMem: bytes }], out), S_OK);
        return out.resource;
    };
    /** @param {any} resource */
    const contents = resource=>{
        /** @type {{ data?: Uint8Array | null }} */
        const mapped = {};
        assert.equal(resource.Map(0, D3D10_MAP.READ, 0, mapped), S_OK);
        const bytes = [.../** @type {Uint8Array} */ (mapped.data)];
        resource.Unmap(0);
        return bytes;
    };
    const texels = Uint8Array.from({ length: 64 }, (_, at)=>at + 1);
    const zeros = new Uint8Array(64);

    const typeless = texture(DXGI_FORMAT.R8G8B8A8_TYPELESS, 4, 4, texels);
    const unorm = texture(DXGI_FORMAT.R8G8B8A8_UNORM, 4, 4, zeros);
    device.CopyResource(unorm, typeless);
    assert.deepEqual(contents(unorm), [...texels], 'a typeless resource and its member');

    const bgra = texture(DXGI_FORMAT.B8G8R8A8_UNORM, 4, 4, zeros);
    device.CopyResource(bgra, unorm);
    assert.deepEqual(contents(bgra), [...zeros], 'RGBA and BGRA are two families');

    // A 16x16 BC1 texture is 64 bytes, as the 4x4 texture is: the extents differ.
    const blocks = texture(DXGI_FORMAT.BC1_UNORM, 8, 8, texels.subarray(0, 32));
    const other = texture(DXGI_FORMAT.R16G16B16A16_UINT, 2, 2, zeros.subarray(0, 32));
    device.CopySubresourceRegion(other, 0, 0, 0, 0, blocks, 0, null);
    assert.deepEqual(contents(other), [...zeros.subarray(0, 32)], 'blocks are not texels');

    // Within a family, a region lands at its offset, counted in blocks.
    const target = texture(DXGI_FORMAT.BC1_TYPELESS, 8, 8, zeros.subarray(0, 32));
    device.CopySubresourceRegion(target, 0, 4, 4, 0, blocks, 0,
        { left: 0, top: 0, front: 0, right: 4, bottom: 4, back: 1 });
    assert.deepEqual(contents(target), [...zeros.subarray(0, 24), ...texels.subarray(0, 8)],
        'the first block of the source, as the last block of the target');
    for (const resource of [typeless, unorm, bgra, blocks, other, target])
    {
        resource.release();
    }
    assertFullyReleased(device);
});

test('a shader and an input layout answer for their device', ()=>{
    const device = createDevice();
    /** @type {{ shader?: any }} */
    const vs = {};
    assert.equal(device.CreateVertexShader(passThroughVertexShader(), vs), S_OK);
    /** @type {{ device?: any }} */
    const owner = {};
    vs.shader.GetDevice(owner);
    assert.equal(owner.device, device);
    device.release();
    assert.equal(vs.shader.supports(IID.ID3D10DeviceChild), true);
    assert.equal(vs.shader.supports(IID.ID3D10VertexShader), true);
    assert.equal(vs.shader.supports(IID.ID3D10PixelShader), false);
    vs.shader.release();

    /** @type {{ shader?: any }} */
    const wrong = { shader: 'untouched' };
    assert.equal(device.CreateVertexShader(solidPixelShader([1, 1, 1, 1]), wrong), E_INVALIDARG,
        'a pixel shader is not a vertex shader');
    assert.equal(wrong.shader, null);
    assert.equal(device.CreatePixelShader(new Uint8Array([0xff, 0xfe, 0, 3]), wrong),
        E_INVALIDARG, 'a Shader Model 3 blob is no container');
    assertFullyReleased(device);
});

test('a buffer view without an element count is refused, not made over nothing', ()=>{
    const device = createDevice();
    /** @type {{ resource?: any }} */
    const buffer = {};
    assert.equal(device.CreateBuffer({ ByteWidth: 64, Usage: D3D10_USAGE.DEFAULT,
        BindFlags: D3D10_BIND.SHADER_RESOURCE, CPUAccessFlags: 0, MiscFlags: 0 }, null, buffer),
    S_OK);
    /** @type {{ view?: any }} */
    const out = {};
    assert.equal(device.CreateShaderResourceView(buffer.resource, {
        Format: DXGI_FORMAT.R32_FLOAT, ViewDimension: D3D10_SRV_DIMENSION.BUFFER,
        ElementOffset: 0 }, out), E_INVALIDARG);
    assert.equal(out.view, null);
});

test('a layout of no elements feeds a vertex shader that reads only system values', ()=>{
    const device = createDevice();
    const vertexId = assemble({
        kind: SHADER_KIND.VERTEX,
        inputs: [{ name: 'SV_VERTEXID', systemValue: SYSTEM_VALUE.VERTEX_ID, register: 0,
            componentType: COMPONENT_TYPE.UINT }],
        outputs: [{ name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        instructions: [dclInputSiv(v(0), SYSTEM_VALUE.VERTEX_ID),
            dclOutputSiv(o(0), SYSTEM_VALUE.POSITION), utof(o(0), v(0)), ret()],
    });
    /** @type {{ layout?: any }} */
    const empty = {};
    assert.equal(device.CreateInputLayout([], vertexId, empty), S_OK);
    /** @type {{ layout?: any }} */
    const none = {};
    assert.equal(device.CreateInputLayout(null, vertexId, none), S_OK);
    assert.deepEqual([empty.layout.elements, none.layout.elements], [[], []]);
    empty.layout.release();
    none.layout.release();
    assertFullyReleased(device);
});

test('Direct3D 11 refuses a null element array, and a slot fed both per vertex and per'
    + ' instance (test_create_input_layout)', ()=>{
    /** @type {any} */
    const out = { wantDevice: true };
    assert.equal(D3D11CreateDevice(null, 1, null, 0, [0xb000], out, {}), S_OK);
    const device = out.device;
    const vertexId = assemble({
        kind: SHADER_KIND.VERTEX,
        inputs: [{ name: 'SV_VERTEXID', systemValue: SYSTEM_VALUE.VERTEX_ID, register: 0,
            componentType: COMPONENT_TYPE.UINT }],
        outputs: [{ name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        instructions: [dclInputSiv(v(0), SYSTEM_VALUE.VERTEX_ID),
            dclOutputSiv(o(0), SYSTEM_VALUE.POSITION), utof(o(0), v(0)), ret()],
    });
    /** @type {{ layout?: any }} */
    const made = {};
    assert.equal(device.CreateInputLayout(null, vertexId, made), E_INVALIDARG);
    assert.equal(device.CreateInputLayout([], vertexId, made), S_OK);
    made.layout.release();
    const element = { SemanticName: 'TEXCOORD', SemanticIndex: 0, Format: 6, InputSlot: 0,
        AlignedByteOffset: 0, InputSlotClass: 0, InstanceDataStepRate: 0 };
    assert.equal(device.CreateInputLayout([element, { ...element, SemanticIndex: 1,
        AlignedByteOffset: 12, InputSlotClass: 1 }], vertexId, made), E_INVALIDARG);
    assert.equal(device.CreateInputLayout([element, { ...element, SemanticIndex: 1,
        InputSlot: 1, InputSlotClass: 1 }], vertexId, made), S_OK, 'each slot its own');
    made.layout.release();
    device.release();
});

test('a layout made against a pixel shader feeds its position too: the vertex and instance'
    + ' ids alone are made by the input assembler', ()=>{
    const device = createDevice();
    const pixel = solidPixelShaderReadingPosition();
    /** @type {{ layout?: any }} */
    const out = {};
    assert.equal(device.CreateInputLayout([], pixel, out), E_INVALIDARG);
    assert.equal(device.CreateInputLayout([{ SemanticName: 'SV_Position', SemanticIndex: 0,
        Format: DXGI_FORMAT.R32G32B32A32_FLOAT, InputSlot: 0, AlignedByteOffset: 0,
        InputSlotClass: 0, InstanceDataStepRate: 0 }], pixel, out), S_OK);
    out.layout.release();
    assertFullyReleased(device);
});

/** A pixel shader whose signature reads SV_POSITION. */
function solidPixelShaderReadingPosition(){
    return assemble({
        kind: SHADER_KIND.PIXEL,
        inputs: [{ name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
        instructions: [dclOutputSiv(o(0), SYSTEM_VALUE.TARGET), ret()],
    });
}

test('multisample quality levels answer as Windows does at the edges'
    + ' (test_check_multisample_quality_levels, d3d10core.c:10613-10679)', ()=>{
    const device = createDevice();
    const RGBA8 = DXGI_FORMAT.R8G8B8A8_UNORM;
    /** @param {number} format @param {number} count */
    const check = (format, count)=>{
        const out = { levels: 0xdeadbeef };
        return [device.CheckMultisampleQualityLevels(format, count, out), out.levels];
    };
    assert.deepEqual(check(RGBA8, 0), [E_FAIL, 0], 'no samples');
    assert.deepEqual(check(RGBA8, 1), [S_OK, 1]);
    assert.deepEqual(check(RGBA8, 4), [S_OK, 1], 'four samples, the count WebGPU has');
    assert.deepEqual(check(DXGI_FORMAT.R8G8B8A8_TYPELESS, 4), [S_OK, 1],
        'a typeless family, as test_multisample_resolve asks');
    assert.deepEqual(check(DXGI_FORMAT.R24G8_TYPELESS, 4), [S_OK, 1], 'a depth family');
    assert.deepEqual(check(DXGI_FORMAT.D32_FLOAT, 4), [S_OK, 1]);
    assert.deepEqual(check(RGBA8, 2), [S_OK, 0], 'two samples WebGPU does not have');
    assert.deepEqual(check(RGBA8, 15), [S_OK, 0]);
    assert.equal(check(RGBA8, 32)[0], S_OK);
    assert.deepEqual(check(RGBA8, 33), [E_FAIL, 0], 'past the API\'s 32');
    assert.deepEqual(check(RGBA8, 64), [E_FAIL, 0]);
    assert.deepEqual(check(DXGI_FORMAT.BC3_UNORM, 2), [S_OK, 0]);
    assert.deepEqual(check(DXGI_FORMAT.BC3_UNORM, 4), [S_OK, 0], 'blocks are never drawn into');
    assert.deepEqual(check(DXGI_FORMAT.R32G32B32A32_FLOAT, 4), [S_OK, 0],
        'a format WebGPU does not multisample');
    assert.deepEqual(check(DXGI_FORMAT.UNKNOWN, 2), [S_OK, 0]);
    assert.deepEqual(check(65536, 2), [E_INVALIDARG, 0xdeadbeef], 'no format at all');
    assert.equal(device.CheckMultisampleQualityLevels(RGBA8, 2, null), E_INVALIDARG);
    assertFullyReleased(device);
});

test('a texture is made at the sample counts the device reports and no other'
    + ' (test_create_texture2d, d3d10core.c:2159-2177)', ()=>{
    const device = createDevice();
    const ms = createTexture2D(device, { SampleDesc: { Count: 4, Quality: 0 } });
    assert.deepEqual(ms.desc.SampleDesc, { Count: 4, Quality: 0 });
    ms.release();
    /** @param {object} overrides */
    const refused = overrides=>{
        /** @type {{ resource?: any }} */
        const out = { resource: 'untouched' };
        const hr = device.CreateTexture2D({ ...TEXTURE_2D, ...overrides }, null, out);
        return [hr, out.resource];
    };
    for (const [overrides, why] of /** @type {[object, string][]} */ ([
        [{ SampleDesc: { Count: 4, Quality: 1 } }, 'one quality level, and this asks the second'],
        [{ SampleDesc: { Count: 2, Quality: 0 } }, 'a count the device reported none of'],
        [{ SampleDesc: { Count: 15, Quality: 0 } }, 'fifteen samples'],
        [{ SampleDesc: { Count: 4, Quality: 0 }, MipLevels: 2 }, 'a multisampled mip chain'],
        [{ SampleDesc: { Count: 4, Quality: 0 }, MipLevels: 0 }, 'the full chain of 512'],
        [{ SampleDesc: { Count: 4, Quality: 0 }, Usage: D3D10_USAGE.STAGING, BindFlags: 0,
            CPUAccessFlags: D3D10_CPU_ACCESS.READ }, 'a multisampled staging texture'],
    ]))
    {
        assert.deepEqual(refused(overrides), [E_INVALIDARG, null], why);
    }
    assertFullyReleased(device);
});

test('a multisampled texture array is refused and says why: WebGPU has none', ()=>{
    /** @type {string[]} */
    const divergences = [];
    const device = createDevice({ divergence: (/** @type {string} */ api,
        /** @type {string} */ detail)=>divergences.push(`${api}: ${detail}`) });
    /** @type {{ resource?: any }} */
    const out = {};
    assert.equal(device.CreateTexture2D({ ...TEXTURE_2D, ArraySize: 2,
        SampleDesc: { Count: 4, Quality: 0 } }, null, out), E_INVALIDARG);
    assert.ok(divergences.some(line=>line.includes('multisampled texture array')),
        divergences.join('\n'));
    assertFullyReleased(device);
});

test('a multisampled texture\'s default views look at it by sample, and no other dimension'
    + ' does', ()=>{
    const device = createDevice();
    const ms = createTexture2D(device, { SampleDesc: { Count: 4, Quality: 0 },
        BindFlags: D3D10_BIND.RENDER_TARGET | D3D10_BIND.SHADER_RESOURCE });
    /** @type {{ view?: any }} */
    const rtv = {};
    assert.equal(device.CreateRenderTargetView(ms, null, rtv), S_OK);
    /** @type {{ desc?: any }} */
    const described = {};
    rtv.view.GetDesc(described);
    assert.equal(described.desc.ViewDimension, D3D10_RTV_DIMENSION.TEXTURE2DMS);
    /** @type {{ view?: any }} */
    const srv = {};
    assert.equal(device.CreateShaderResourceView(ms, null, srv), S_OK);
    srv.view.GetDesc(described);
    assert.equal(described.desc.ViewDimension, D3D10_SRV_DIMENSION.TEXTURE2DMS);
    /** @type {{ view?: any }} */
    const flat = {};
    assert.equal(device.CreateRenderTargetView(ms, { Format: 0,
        ViewDimension: D3D10_RTV_DIMENSION.TEXTURE2D, MipSlice: 0 }, flat), E_INVALIDARG);
    rtv.view.release();
    srv.view.release();
    ms.release();
    assertFullyReleased(device);
});

test('the combined entry points answer with the swap chain\'s own failure and hand back'
    + ' neither object (test_create_device, d3d10_1.c:249-266)', ()=>{
    for (const [window, format, expected] of [
        [0, DXGI_FORMAT.R8G8B8A8_UNORM, DXGI_ERROR_INVALID_CALL],
        [0x1234, DXGI_FORMAT.BC5_UNORM, E_INVALIDARG],
    ])
    {
        const desc = { ...defaultSwapChainDesc(), outputWindow: window };
        desc.bufferDesc = { ...desc.bufferDesc, format };
        /** @type {{ swapChain?: any }} */
        const chain = { swapChain: 'untouched' };
        /** @type {{ device?: any }} */
        const device = { device: 'untouched' };
        assert.equal(D3D10CreateDeviceAndSwapChain(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0,
            D3D10_SDK_VERSION, desc, chain, device), expected, `window ${window}, ${format}`);
        assert.deepEqual([chain.swapChain, device.device], [null, null]);
    }
});

test('a shadow map\'s formats say what each is for: the depth format draws depth, the view that'
    + ' reads it compares (D3D10 format support; test_format_support, d3d10core.c:13827)', ()=>{
    const device = createDevice();
    /** @param {number} format */
    const support = format=>{
        /** @type {{ support?: number }} */
        const out = {};
        assert.equal(device.CheckFormatSupport(format, out), S_OK, `format ${format}`);
        return /** @type {number} */ (out.support);
    };
    const [TEXTURE2D, COMPARISON, DEPTH_STENCIL, BUFFER] = [0x20, 0x400, 0x10000, 0x1];
    for (const format of [DXGI_FORMAT.D24_UNORM_S8_UINT, DXGI_FORMAT.D32_FLOAT,
        DXGI_FORMAT.D16_UNORM])
    {
        const bits = support(format);
        assert.ok(bits & DEPTH_STENCIL && bits & TEXTURE2D, `${format} is a depth texture`);
        assert.ok(!(bits & COMPARISON), `${format} is never bound to a shader`);
        assert.ok(!(bits & BUFFER), `${format} is never a buffer's element`);
    }
    for (const format of [DXGI_FORMAT.R24_UNORM_X8_TYPELESS, DXGI_FORMAT.R32_FLOAT,
        DXGI_FORMAT.R16_UNORM, DXGI_FORMAT.R32_FLOAT_X8X24_TYPELESS])
    {
        const bits = support(format);
        assert.ok(bits & TEXTURE2D && bits & COMPARISON, `${format} reads depth to compare`);
    }
    assert.ok(!(support(DXGI_FORMAT.R8G8B8A8_UNORM) & COMPARISON));
    assertFullyReleased(device);
});

test('an A8 texture is drawn into, as test_render_a8 draws (d3d10core.c:18552), and mips are'
    + ' generated in every format the GPU makes them in', ()=>{
    const device = createDevice();
    /** @param {number} format */
    const support = format=>{
        /** @type {{ support?: number }} */
        const out = {};
        device.CheckFormatSupport(format, out);
        return /** @type {number} */ (out.support);
    };
    assert.ok(support(DXGI_FORMAT.A8_UNORM) & 0x4000, 'RENDER_TARGET');
    createTexture2D(device, { Format: DXGI_FORMAT.A8_UNORM }).release();
    for (const format of [DXGI_FORMAT.R8G8B8A8_UNORM, DXGI_FORMAT.R16G16B16A16_FLOAT,
        DXGI_FORMAT.R10G10B10A2_UNORM, DXGI_FORMAT.R8_UNORM])
    {
        assert.ok(support(format) & 0x2000, `MIP_AUTOGEN for ${format}`);
    }
    assert.ok(!(support(DXGI_FORMAT.R32G32B32A32_FLOAT) & 0x2000), 'not a 32-bit float');
    assertFullyReleased(device);
});

test('the multisample bits follow the quality levels: a four-sample target, resolved and read'
    + ' where it is colour', ()=>{
    const device = createDevice();
    /** @param {number} format */
    const support = format=>{
        /** @type {{ support?: number }} */
        const out = {};
        device.CheckFormatSupport(format, out);
        return /** @type {number} */ (out.support);
    };
    const [RESOLVE, RENDERTARGET, LOAD] = [0x40000, 0x200000, 0x400000];
    assert.equal(support(DXGI_FORMAT.R8G8B8A8_UNORM) & (RESOLVE | RENDERTARGET | LOAD),
        RESOLVE | RENDERTARGET | LOAD);
    assert.equal(support(DXGI_FORMAT.D24_UNORM_S8_UINT) & (RESOLVE | RENDERTARGET | LOAD),
        RENDERTARGET, 'depth is drawn at four samples and never resolved');
    assert.equal(support(DXGI_FORMAT.R32G32B32A32_FLOAT) & (RESOLVE | RENDERTARGET | LOAD), 0);
    assertFullyReleased(device);
});

test('a Direct3D 10 device keeps the rasterizer state it binds past the last release, and'
    + ' nothing else', ()=>{
    const device = createDevice();
    /** @type {{ state?: any }} */
    const rasterizer = {};
    assert.equal(device.CreateRasterizerState(RASTERIZER_DESC, rasterizer), S_OK);
    device.RSSetState(rasterizer.state);
    assert.equal(rasterizer.state.release(), 0);
    /** @type {{ state?: any }} */
    const got = {};
    device.RSGetState(got);
    assert.equal(got.state, rasterizer.state, 'the same object, still alive');
    assert.equal(got.state.release(), 0);
    /** @type {{ state?: any }} */
    const sampler = {};
    assert.equal(device.CreateSamplerState(SAMPLER_DESC, sampler), S_OK);
    device.PSSetSamplers(0, [sampler.state]);
    assert.equal(sampler.state.release(), 0);
    /** @type {{ samplers?: any[] }} */
    const samplers = {};
    device.PSGetSamplers(0, 1, samplers);
    assert.deepEqual(samplers.samplers, [null], 'a sampler goes with its last release');
    device.ClearState();
    assertFullyReleased(device);
});

test('a device asked for video support is refused as one without it: no video device stands'
    + ' behind it yet (decision A80, temporary; test_video_support, d3d11.c:37722)', ()=>{
    for (const [adapter, driverType] of /** @type {[any, number][]} */ ([[null, 1], [{}, 0]]))
    {
        /** @type {any} */
        const out = { wantDevice: true, wantContext: true };
        assert.equal(D3D11CreateDevice(adapter, driverType, null, 0x800, null, out, {}),
            0x887a0004);
        assert.equal(out.device, null);
    }
    /** @type {any} */
    const out = { wantDevice: true };
    assert.equal(D3D11CreateDevice(null, 0, null, 0x800, null, out, {}), 0x80070057,
        'an unknown driver with no adapter is a bad argument before anything else');
});

test('from level 11 stream output may follow the domain shader: a stage of no shader of its own,'
    + ' as a vertex shader\'s is', ()=>{
    const entries = [{ Stream: 0, SemanticName: 'SV_POSITION', SemanticIndex: 0,
        StartComponent: 0, ComponentCount: 4, OutputSlot: 0 }];
    /** @type {any} */
    const eleven = { wantDevice: true };
    assert.equal(D3D11CreateDevice(null, 1, null, 0, [0xb000], eleven, {}), S_OK);
    /** @type {{ shader?: any }} */
    const made = {};
    assert.equal(eleven.device.CreateGeometryShaderWithStreamOutput(quadDomainShader(), entries,
        [16], 0, made), S_OK);
    assert.equal(made.shader.passThrough, true);
    made.shader.release();
    eleven.device.release();
    /** @type {any} */
    const ten = { wantDevice: true };
    assert.equal(D3D11CreateDevice(null, 1, null, 0, [0xa000], ten, {}), S_OK);
    assert.equal(ten.device.CreateGeometryShaderWithStreamOutput(quadDomainShader(), entries,
        [16], 0, made), 0x80070057, 'level 10 has no domain shader');
    ten.device.release();
});

test('an update\'s pitch of zero reads every row from the same bytes'
    + ' (test_copy_subresource_region)', async()=>{
    const device = createDevice();
    const texture = createTexture2D(device, { Width: 4, Height: 4 });
    device.UpdateSubresource(texture, 0, null, new Uint8Array(16).fill(0x45), 0, 0);
    const staging = createTexture2D(device, { Width: 4, Height: 4,
        Usage: D3D10_USAGE.STAGING, BindFlags: 0, CPUAccessFlags: D3D10_CPU_ACCESS.READ });
    device.CopyResource(staging, texture);
    /** @type {{ data?: Uint8Array }} */
    const mapped = {};
    assert.equal(await staging.Map(0, D3D10_MAP.READ, 0, mapped), S_OK);
    assert.deepEqual([...(mapped.data ?? new Uint8Array(0)).subarray(0, 64)],
        new Array(64).fill(0x45), 'all four rows the one row given');
    staging.Unmap(0);
    staging.release();
    texture.release();
});

test('a device asked for with the debug layer is refused as on a Windows without its Graphics'
    + ' Tools (decision A81)', ()=>{
    /** @type {any} */
    const eleven = { wantDevice: true, wantContext: true };
    assert.equal(D3D11CreateDevice(null, 1, null, 0x2, null, eleven, {}), 0x887a002d);
    assert.equal(eleven.device, null);
    /** @type {any} */
    const ten = {};
    assert.equal(D3D10CreateDevice(null, 0, null, 0x2, 29, ten, {}), 0x887a002d);
    assert.equal(ten.device, null);
});

test('from level 10.1 a copy moves compressed blocks into texels as big, and back, each counted'
    + ' in its own format (test_compressed_format_compatibility, d3d11.c:29631)', ()=>{
    /** @type {any} */
    const made = { wantDevice: true };
    assert.equal(D3D11CreateDevice(null, 1, null, 0, [0xb000], made, {}), S_OK);
    const device = made.device;
    /**
     * @param {number} format @param {number} width @param {number} height
     * @param {Uint8Array} bytes
     */
    const texture = (format, width, height, bytes)=>{
        /** @type {{ resource?: any }} */
        const out = {};
        assert.equal(device.CreateTexture2D({
            ...TEXTURE_2D, Width: width, Height: height, Format: format,
            Usage: D3D10_USAGE.STAGING, BindFlags: 0,
            CPUAccessFlags: D3D10_CPU_ACCESS.READ | D3D10_CPU_ACCESS.WRITE,
        }, [{ pSysMem: bytes }], out), S_OK);
        return out.resource;
    };
    /** @param {any} resource */
    const contents = resource=>{
        /** @type {{ data?: Uint8Array | null }} */
        const mapped = {};
        assert.equal(resource.Map(0, D3D10_MAP.READ, 0, mapped), S_OK);
        const bytes = [.../** @type {Uint8Array} */ (mapped.data)];
        resource.Unmap(0);
        return bytes;
    };
    const texels = Uint8Array.from({ length: 32 }, (_, at)=>at + 1);
    const zeros = new Uint8Array(32);
    // 8x8 texels of BC1 are 2x2 blocks of 8 bytes, as 2x2 texels of R16G16B16A16 are.
    const blocks = texture(DXGI_FORMAT.BC1_UNORM, 8, 8, texels);
    const plain = texture(DXGI_FORMAT.R16G16B16A16_UINT, 2, 2, zeros);
    device.CopyResource(plain, blocks);
    assert.deepEqual(contents(plain), [...texels], 'the whole resource, block for texel');
    const back = texture(DXGI_FORMAT.BC1_TYPELESS, 8, 8, zeros);
    device.CopySubresourceRegion(back, 0, 4, 4, 0, plain, 0,
        { left: 0, top: 0, front: 0, right: 1, bottom: 1, back: 1 });
    assert.deepEqual(contents(back), [...zeros.subarray(0, 24), ...texels.subarray(0, 8)],
        'one texel into the last block, at (4, 4) in the target\'s texels');
    const narrow = texture(DXGI_FORMAT.R8G8B8A8_UINT, 4, 2, zeros);
    device.CopyResource(narrow, blocks);
    assert.deepEqual(contents(narrow), [...zeros], 'a texel smaller than a block takes none');
    for (const resource of [blocks, plain, back, narrow])
    {
        resource.release();
    }
});

test('a shader resource view over a subresource bound as a target is set as none and unbound'
    + ' when the target is bound; another level of the texture, or a depth aspect the depth view'
    + ' keeps read-only, stays (test_sample_attached_rtv, d3d11.c:32684)', ()=>{
    /** @type {any} */
    const out = { wantDevice: true, wantContext: true };
    assert.equal(D3D11CreateDevice(null, 1, null, 0, [0xb000], out, {}), S_OK);
    const { device, context } = out;
    /** @type {any} */
    const made = {};
    assert.equal(device.CreateTexture2D({ Width: 8, Height: 8, MipLevels: 2, ArraySize: 1,
        Format: DXGI_FORMAT.R8G8B8A8_UNORM, SampleDesc: { Count: 1, Quality: 0 }, Usage: 0,
        BindFlags: D3D10_BIND.SHADER_RESOURCE | D3D10_BIND.RENDER_TARGET, CPUAccessFlags: 0,
        MiscFlags: 0 }, null, made), S_OK);
    const texture = made.resource;
    assert.equal(device.CreateRenderTargetView(texture, { Format: DXGI_FORMAT.R8G8B8A8_UNORM,
        ViewDimension: 4, MipSlice: 0 }, made), S_OK);
    const target = made.view;
    /** @param {number} mip */
    const levelView = mip=>{
        assert.equal(device.CreateShaderResourceView(texture, { Format:
            DXGI_FORMAT.R8G8B8A8_UNORM, ViewDimension: 4, MostDetailedMip: mip, MipLevels: 1 },
        made), S_OK);
        return made.view;
    };
    const top = levelView(0);
    const second = levelView(1);
    /** @returns {any[]} */
    const bound = ()=>{
        /** @type {any} */
        const got = {};
        context.PSGetShaderResources(0, 2, got);
        const views = got.views;
        views.forEach((/** @type {any} */ view)=>view?.Release?.());
        return views;
    };
    context.PSSetShaderResources(0, [top, second]);
    context.OMSetRenderTargets([target], null);
    assert.deepEqual(bound(), [null, second], 'level 0 unbound with its target; level 1 kept');
    context.PSSetShaderResources(0, [top, second]);
    assert.deepEqual(bound(), [null, second], 'set while a target, set as none');
    context.OMSetRenderTargets([], null);
    context.PSSetShaderResources(0, [top]);
    assert.deepEqual(bound(), [top, second]);

    assert.equal(device.CreateTexture2D({ Width: 8, Height: 8, MipLevels: 1, ArraySize: 1,
        Format: DXGI_FORMAT.R24G8_TYPELESS, SampleDesc: { Count: 1, Quality: 0 }, Usage: 0,
        BindFlags: D3D10_BIND.SHADER_RESOURCE | D3D10_BIND.DEPTH_STENCIL, CPUAccessFlags: 0,
        MiscFlags: 0 }, null, made), S_OK);
    const depthTexture = made.resource;
    /** @param {number} format */
    const aspectView = format=>{
        assert.equal(device.CreateShaderResourceView(depthTexture, { Format: format,
            ViewDimension: 4, MostDetailedMip: 0, MipLevels: 1 }, made), S_OK);
        return made.view;
    };
    const depthRead = aspectView(DXGI_FORMAT.R24_UNORM_X8_TYPELESS);
    const stencilRead = aspectView(DXGI_FORMAT.X24_TYPELESS_G8_UINT);
    for (const [flags, kept] of /** @type {[number, any[]][]} */ ([
        [0, [null, null]],
        [D3D11_DSV_FLAG.READ_ONLY_DEPTH, [depthRead, null]],
        [D3D11_DSV_FLAG.READ_ONLY_STENCIL, [null, stencilRead]],
        [D3D11_DSV_FLAG.READ_ONLY_DEPTH | D3D11_DSV_FLAG.READ_ONLY_STENCIL,
            [depthRead, stencilRead]],
    ]))
    {
        assert.equal(device.CreateDepthStencilView(depthTexture, { Format:
            DXGI_FORMAT.D24_UNORM_S8_UINT, ViewDimension: 3, Flags: flags, MipSlice: 0 },
        made), S_OK);
        context.OMSetRenderTargets([], null);
        context.PSSetShaderResources(0, [depthRead, stencilRead]);
        context.OMSetRenderTargets([], made.view);
        assert.deepEqual(bound(), kept, `flags ${flags}`);
    }
});

test('an input element\'s offset is a whole number of its channels, up to a word'
    + ' (test_input_layout_alignment, d3d11.c:19406)', ()=>{
    /** @type {any} */
    const out = { wantDevice: true };
    assert.equal(D3D11CreateDevice(null, 1, null, 0, [0xb000], out, {}), S_OK);
    /** @param {number} first @param {number} second @param {number} offset */
    const made = (first, second, offset)=>out.device.CreateInputLayout([
        { SemanticName: 'POSITION', SemanticIndex: 0, Format: first, InputSlot: 0,
            AlignedByteOffset: 0, InputSlotClass: 0, InstanceDataStepRate: 0 },
        { SemanticName: 'COLOR', SemanticIndex: 0, Format: second, InputSlot: 0,
            AlignedByteOffset: offset, InputSlotClass: 0, InstanceDataStepRate: 0 },
    ], passThroughVertexShader(), {});
    const F = DXGI_FORMAT;
    assert.equal(made(F.R8_UINT, F.R16_UINT, 2), S_OK);
    assert.equal(made(F.R8_UINT, F.R16_UINT, 1), E_INVALIDARG);
    assert.equal(made(F.R8_UINT, F.R8_UINT, 1), S_OK);
    assert.equal(made(F.R16_UINT, F.R32_UINT, 2), E_INVALIDARG);
    assert.equal(made(F.R32G32B32_FLOAT, F.R32G32B32A32_FLOAT, 17), E_INVALIDARG);
    assert.equal(made(F.R32G32B32_FLOAT, F.R32G32B32A32_FLOAT, 20), S_OK);
});

test('a shader model 4 program that reads raw memory is refused below level 11, where no'
    + ' device here computes through shader model 4 (test_unaligned_raw_buffer_access)', ()=>{
    const raw = assemble({
        kind: SHADER_KIND.PIXEL,
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
        instructions: [
            dclResourceRaw(0),
            dclOutput(o(0)),
            ldRaw(o(0, 'x'), l(0), t(0)),
            ret(),
        ],
    });
    /** @param {number} level @param {Uint8Array} code */
    const made = (level, code)=>{
        /** @type {any} */
        const out = { wantDevice: true };
        assert.equal(D3D11CreateDevice(null, 1, null, 0, [level], out, {}), S_OK);
        /** @type {{ shader?: any }} */
        const shader = {};
        const hr = out.device.CreatePixelShader(code, shader);
        shader.shader?.release();
        out.device.release();
        return hr;
    };
    /** @type {any} */
    const ten = { wantDevice: true };
    assert.equal(D3D11CreateDevice(null, 1, null, 0, [0xa000], ten, {}), S_OK);
    const answer = ten.device.CheckFeatureSupport(4, new Uint8Array(4));
    ten.device.release();
    assert.deepEqual([answer.hr, ...answer.data], [S_OK, 0, 0, 0, 0],
        'no compute through shader model 4');
    assert.equal(made(0xa000, raw), E_INVALIDARG);
    assert.equal(made(0xa100, raw), E_INVALIDARG);
    assert.equal(made(0xb000, raw), S_OK);
    assert.equal(made(0xa000, solidPixelShader([1, 0, 0, 1])), S_OK);
});

test('doubles are there at shader model 5: D3D11_FEATURE_DOUBLES is true at 11.0, not at 10.x',
    ()=>{
        /** @param {number} level */
        const doubles = level=>{
            /** @type {any} */
            const out = { wantDevice: true };
            assert.equal(D3D11CreateDevice(null, 1, null, 0, [level], out, {}), S_OK);
            const answer = out.device.CheckFeatureSupport(1, new Uint8Array(4));
            out.device.release();
            return [answer.hr, answer.data[0]];
        };
        assert.deepEqual(doubles(0xb000), [S_OK, 1]);
        assert.deepEqual(doubles(0xa100), [S_OK, 0]);
    });

test('a texture made shared is opened by another device of the same root over the same'
    + ' bytes, by the kind of handle it was made for (test_shared_resource)', async()=>{
    const options = {};
    /** @param {number} [level] */
    const device11 = (level = 0xb000)=>{
        /** @type {any} */
        const out = { wantDevice: true };
        assert.equal(D3D11CreateDevice(null, 1, null, 0, [level], out, options), S_OK);
        return out.device;
    };
    const one = device11();
    const two = device11(0xa000);
    /** @param {number} misc @param {number} misc11 */
    const made = (misc, misc11)=>{
        /** @type {{ resource?: any }} */
        const out = {};
        const hr = one.CreateTexture2D({ ...TEXTURE_2D, Width: 4, Height: 4,
            MiscFlags: misc, MiscFlags11: misc11 }, null, out);
        return { hr, resource: out.resource ?? null };
    };
    const SHARED = 0x2;
    const KEYED = 0x10;
    const NT = 0x800;
    assert.equal(made(SHARED | KEYED, 0).hr, E_INVALIDARG, 'one way of sharing');
    assert.equal(made(0, NT).hr, E_INVALIDARG, 'an NT handle names a share');
    assert.equal(made(SHARED | KEYED, NT).hr, E_INVALIDARG);

    const plain = made(0, 0).resource;
    /** @type {{ handle?: number }} */
    const none = {};
    assert.equal(plain.GetSharedHandle(none), S_OK);
    assert.equal(none.handle, 0, 'no handle for a texture not shared');
    assert.ok(plain.supports(IID.IDXGIResource1) && !plain.supports(IID.IDXGIKeyedMutex));

    const shared = made(SHARED, 0).resource;
    /** @type {{ handle?: number }} */
    const legacy = {};
    assert.equal(shared.GetSharedHandle(legacy), S_OK);
    assert.ok(((legacy.handle ?? 0) & 0xc0000000) !== 0, 'a legacy handle');
    assert.equal(shared.ntShareKey(), null, 'no NT handle for it');
    /** @type {{ resource?: any }} */
    const opened = {};
    assert.equal(two.OpenSharedResource1(legacy.handle, opened), E_INVALIDARG);
    assert.equal(two.OpenSharedResource(legacy.handle, opened), S_OK);
    assert.equal(two.OpenSharedResource(0x1234, {}), E_INVALIDARG, 'a handle naming nothing');

    // What one device writes the other reads.
    const texels = new Uint8Array(64).map((_, index)=>index);
    one.UpdateSubresource(shared, 0, null, texels, 16, 64);
    const staging = createTexture2D(two, { Width: 4, Height: 4, Usage: D3D10_USAGE.STAGING,
        BindFlags: 0, CPUAccessFlags: 0x20000 });
    two.CopyResource(staging, opened.resource);
    /** @type {{ data?: Uint8Array }} */
    const mapped = {};
    assert.equal(await staging.Map(0, 1, 0, mapped), S_OK);
    assert.deepEqual([...(mapped.data ?? []).slice(0, 64)], [...texels]);
    staging.Unmap(0);

    const nt = made(SHARED, NT).resource;
    assert.equal(nt.GetSharedHandle({}), E_INVALIDARG, 'named by an NT handle only');
    const key = nt.ntShareKey();
    assert.notEqual(key, null);
    assert.equal(two.OpenSharedResource(key, {}), E_INVALIDARG);
    /** @type {{ resource?: any }} */
    const byNt = {};
    assert.equal(two.OpenSharedResource1(key, byNt), S_OK);

    // The share outlives the object it was made as while another holds it.
    shared.release();
    /** @type {{ resource?: any }} */
    const again = {};
    assert.equal(two.OpenSharedResource(legacy.handle, again), S_OK, 'still opened by its handle');
    again.resource.release();
    opened.resource.release();
    assert.equal(two.OpenSharedResource(legacy.handle, {}), E_INVALIDARG, 'gone with the last');
    byNt.resource.release();
    nt.release();
    plain.release();
});

test('a keyed mutex is held by one device at a time, taken with the key it was let go with,'
    + ' and abandoned with the object that held it (test_keyed_mutex)', async()=>{
    const options = {};
    const device11 = ()=>{
        /** @type {any} */
        const out = { wantDevice: true };
        assert.equal(D3D11CreateDevice(null, 1, null, 0, [0xb000], out, options), S_OK);
        return out.device;
    };
    const one = device11();
    const two = device11();
    /** @type {{ resource?: any }} */
    const made = {};
    assert.equal(one.CreateTexture2D({ ...TEXTURE_2D, MiscFlags: 0x10 }, null, made), S_OK);
    const texture = made.resource;
    assert.ok(texture.supports(IID.IDXGIKeyedMutex));
    const INVALID_CALL = DXGI_ERROR_INVALID_CALL;
    const TIMEOUT = 0x102;
    const ABANDONED = 0x80;
    assert.deepEqual([texture.ReleaseSync(0), texture.ReleaseSync(1)], [INVALID_CALL, INVALID_CALL],
        'not held');
    assert.equal(texture.AcquireSync(1, 0), TIMEOUT, 'zero at first');
    assert.equal(texture.AcquireSync(0, 0), S_OK);
    assert.deepEqual([texture.AcquireSync(0, 0), texture.AcquireSync(1, 0)],
        [INVALID_CALL, INVALID_CALL], 'held by this device already');
    assert.equal(texture.ReleaseSync(0), S_OK);
    assert.equal(texture.AcquireSync(0, 0), S_OK);
    assert.equal(texture.ReleaseSync(1), S_OK, 'let go with any key');
    assert.deepEqual([texture.AcquireSync(0, 0), texture.AcquireSync(2, 0)], [TIMEOUT, TIMEOUT]);
    assert.equal(texture.AcquireSync(1, 0), S_OK);
    assert.equal(texture.ReleaseSync(0), S_OK);
    assert.equal(texture.AcquireSync(0, 0), S_OK);

    /** @type {{ handle?: number }} */
    const handle = {};
    texture.GetSharedHandle(handle);
    /** @type {{ resource?: any }} */
    const opened = {};
    assert.equal(two.OpenSharedResource(handle.handle, opened), S_OK);
    const other = opened.resource;
    assert.ok(other.supports(IID.IDXGIKeyedMutex));
    assert.deepEqual([other.AcquireSync(0, 0), other.AcquireSync(1, 0)], [TIMEOUT, TIMEOUT],
        'held by the other device');
    assert.deepEqual([other.ReleaseSync(0), other.ReleaseSync(1)], [INVALID_CALL, INVALID_CALL]);

    // A wait is answered when the holder lets go, or when it runs out.
    const waited = other.AcquireSync(5, 10000);
    assert.ok(waited instanceof Promise);
    assert.equal(texture.ReleaseSync(5), S_OK);
    assert.equal(await waited, S_OK);
    assert.equal(await texture.AcquireSync(0, 5), TIMEOUT, 'a wait that runs out');
    assert.equal(other.ReleaseSync(0), S_OK);
    assert.equal(texture.AcquireSync(0, 0), S_OK);

    texture.release();
    assert.deepEqual([other.AcquireSync(0, 0), other.AcquireSync(0, 0)], [ABANDONED, ABANDONED]);
    assert.deepEqual([other.ReleaseSync(0), other.ReleaseSync(1)], [INVALID_CALL, INVALID_CALL]);
    other.release();
});

test('a shared-exponent texture copies into a 32-bit family on Direct3D 11 and not on'
    + ' Direct3D 10 (test_format_compatibility in d3d11.c and d3d10core.c)', async()=>{
    /** @param {any} device */
    const copied = async device=>{
        const texels = new Uint8Array(64).map((_, index)=>index + 1);
        /** @type {{ resource?: any }} */
        const source = {};
        assert.equal(device.CreateTexture2D({ ...TEXTURE_2D, Width: 4, Height: 4,
            Format: DXGI_FORMAT.R9G9B9E5_SHAREDEXP, Usage: D3D10_USAGE.IMMUTABLE,
            BindFlags: D3D10_BIND.SHADER_RESOURCE }, [{ pSysMem: texels, SysMemPitch: 16,
            SysMemSlicePitch: 0 }], source), S_OK);
        const staging = createTexture2D(device, { Width: 4, Height: 4,
            Format: DXGI_FORMAT.R32_UINT, Usage: D3D10_USAGE.STAGING, BindFlags: 0,
            CPUAccessFlags: 0x20000 });
        device.CopyResource(staging, source.resource);
        /** @type {{ data?: Uint8Array }} */
        const mapped = {};
        assert.equal(await staging.Map(0, 1, 0, mapped), S_OK);
        const bytes = [...(mapped.data ?? []).slice(0, 64)];
        staging.Unmap(0);
        return bytes.every((byte, index)=>byte === texels[index]) ? 'copied'
            : bytes.every(byte=>byte === 0) ? 'left' : 'mixed';
    };
    /** @type {any} */
    const eleven = { wantDevice: true };
    assert.equal(D3D11CreateDevice(null, 1, null, 0, [0xb000], eleven, {}), S_OK);
    assert.equal(await copied(eleven.device), 'copied');
    assert.equal(await copied(createDevice()), 'left');
});

test('SOGetTargets answers ~0 as the offset of every bound buffer and zero for an empty slot'
    + ' (d3d10core.c test_clear_state)', ()=>{
    const device = createDevice();
    /** @type {{ resource?: any }} */
    const made = {};
    assert.equal(device.CreateBuffer({ ByteWidth: 64, Usage: D3D10_USAGE.DEFAULT,
        BindFlags: D3D10_BIND.STREAM_OUTPUT, CPUAccessFlags: 0, MiscFlags: 0 }, null, made), S_OK);
    device.SOSetTargets([made.resource, null], [16, 32]);
    /** @type {{ buffers?: any[], offsets?: number[] }} */
    const out = {};
    device.SOGetTargets(4, out);
    assert.deepEqual(out.offsets, [0xffffffff, 0, 0, 0]);
    assert.equal(out.buffers?.[0], made.resource);
    out.buffers?.[0]?.release();
    device.ClearState();
    device.SOGetTargets(4, out);
    assert.deepEqual(out.offsets, [0, 0, 0, 0], 'cleared');
});

test('one blend state for the same blending, whether Direct3D 10\'s or 10.1\'s description made'
    + ' it (test_create_blend_state)', ()=>{
    const device = createDevice();
    const blend = { AlphaToCoverageEnable: false, BlendEnable: [true, false, false, false,
        false, false, false, false], SrcBlend: 2, DestBlend: 1, BlendOp: 1, SrcBlendAlpha: 2,
    DestBlendAlpha: 1, BlendOpAlpha: 1, RenderTargetWriteMask: [0xf, 1, 2, 4, 0xf, 0xf, 0xf, 0xf] };
    /** @type {{ state?: any }} */
    const ten = {};
    assert.equal(device.CreateBlendState(blend, ten), S_OK);
    /** @type {{ desc?: any }} */
    const read = {};
    ten.state.GetDesc1(read);
    assert.equal(read.desc.IndependentBlendEnable, true, 'the targets differ');
    /** @type {{ state?: any }} */
    const one = {};
    assert.equal(device.CreateBlendState1(read.desc, one), S_OK);
    assert.equal(one.state, ten.state);

    const same = { ...blend, BlendEnable: new Array(8).fill(false),
        RenderTargetWriteMask: new Array(8).fill(0xf) };
    /** @type {{ state?: any }} */
    const plain = {};
    assert.equal(device.CreateBlendState(same, plain), S_OK);
    plain.state.GetDesc1(read);
    /** @type {{ state?: any }} */
    const independent = {};
    assert.equal(device.CreateBlendState1({ ...read.desc, IndependentBlendEnable: true },
        independent), S_OK);
    assert.equal(independent.state, plain.state, 'independent targets that are all alike');
    assert.notEqual(plain.state, ten.state);
});

test('a buffer is refused with a texture\'s misc flags: faces, GDI, levels to generate'
    + ' (d3d10core.c test_create_buffer)', ()=>{
    const device = createDevice();
    /** @param {number} misc */
    const made = misc=>{
        /** @type {{ resource?: any }} */
        const out = {};
        const hr = device.CreateBuffer({ ByteWidth: 1024, Usage: D3D10_USAGE.DEFAULT,
            BindFlags: D3D10_BIND.SHADER_RESOURCE, CPUAccessFlags: 0, MiscFlags: misc }, null, out);
        out.resource?.release();
        return hr;
    };
    assert.equal(made(0), S_OK);
    assert.equal(made(0x2), S_OK, 'shared');
    for (const misc of [0x1, 0x4, 0x20])
    {
        assert.equal(made(misc), E_INVALIDARG, `misc ${misc}`);
    }
});

test('R11G11B10_FLOAT is a vertex buffer format, read by the vertex stage itself'
    + ' (d3d10core.c test_required_format_support)', ()=>{
    const device = createDevice();
    /** @type {{ support?: number }} */
    const out = {};
    assert.equal(device.CheckFormatSupport(DXGI_FORMAT.R11G11B10_FLOAT, out), S_OK);
    assert.ok(((out.support ?? 0) & 0x2) !== 0, 'IA_VERTEX_BUFFER');
});

test('Direct3D 10 copies into a depth-stencil texture only from another; 11 from a colour one'
    + ' too (test_format_compatibility)', async()=>{
    /** @param {any} device */
    const copied = async device=>{
        const texels = new Uint8Array(32).map((_, index)=>index + 1);
        /** @type {{ resource?: any }} */
        const colour = {};
        assert.equal(device.CreateTexture2D({ ...TEXTURE_2D, Width: 4, Height: 4,
            Format: DXGI_FORMAT.R16_UNORM, Usage: D3D10_USAGE.IMMUTABLE,
            BindFlags: D3D10_BIND.SHADER_RESOURCE }, [{ pSysMem: texels, SysMemPitch: 8,
            SysMemSlicePitch: 0 }], colour), S_OK);
        const depth = createTexture2D(device, { Width: 4, Height: 4,
            Format: DXGI_FORMAT.D16_UNORM, BindFlags: D3D10_BIND.DEPTH_STENCIL });
        device.CopyResource(depth, colour.resource);
        const staging = createTexture2D(device, { Width: 4, Height: 4,
            Format: DXGI_FORMAT.R16_UNORM, Usage: D3D10_USAGE.STAGING, BindFlags: 0,
            CPUAccessFlags: 0x20000 });
        device.CopyResource(staging, depth);
        /** @type {{ data?: Uint8Array }} */
        const mapped = {};
        assert.equal(await staging.Map(0, 1, 0, mapped), S_OK);
        const bytes = [...(mapped.data ?? []).slice(0, 32)];
        staging.Unmap(0);
        return bytes.every((byte, index)=>byte === texels[index]) ? 'copied'
            : bytes.every(byte=>byte === 0) ? 'left' : 'mixed';
    };
    /** @type {any} */
    const eleven = { wantDevice: true };
    assert.equal(D3D11CreateDevice(null, 1, null, 0, [0xb000], eleven, {}), S_OK);
    assert.equal(await copied(eleven.device), 'copied');
    assert.equal(await copied(createDevice()), 'left');
});
