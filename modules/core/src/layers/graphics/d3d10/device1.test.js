/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 10.1's entry points and the three methods ID3D10Device1 adds,
 * after Wine's d3d10_1 tests (test_create_device, test_device_interfaces,
 * test_create_shader_resource_view, test_create_blend_state).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3D10_1_SDK_VERSION, D3D10_BIND, D3D10_BLEND, D3D10_BLEND_OP, D3D10_COLOR_WRITE_ENABLE,
    D3D10_DRIVER_TYPE, D3D10_SDK_VERSION, D3D10_USAGE, D3D_FEATURE_LEVEL, DXGI_ERROR_INVALID_CALL,
    DXGI_ERROR_UNSUPPORTED, DXGI_FORMAT, E_INVALIDARG, IID, S_OK,
} from './constants.js';
import {
    D3D10CreateDevice, D3D10CreateDevice1, D3D10CreateDeviceAndSwapChain1,
} from './device.js';
import { defaultSwapChainDesc } from './dxgi.js';

const LEVEL = D3D_FEATURE_LEVEL;

/** @param {number} [level] */
function createDevice1(level = LEVEL.LEVEL_10_0){
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(D3D10CreateDevice1(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0, level,
        D3D10_1_SDK_VERSION, out), S_OK);
    return out.device;
}

test('the 10.1 entry point makes a device at 10.0 and says so for every other level', ()=>{
    const device = createDevice1();
    assert.equal(device.GetFeatureLevel(), LEVEL.LEVEL_10_0);
    for (const iid of [IID.ID3D10Device, IID.ID3D10Device1, IID.IDXGIDevice, IID.IDXGIDevice1,
        IID.ID3D10Multithread, IID.IDXGIObject])
    {
        assert.ok(device.supports(iid), iid);
    }
    assert.equal(device.release(), 0);

    /** @type {{ device?: any }} */
    const out = { device: 'untouched' };
    for (const level of [LEVEL.LEVEL_10_1, LEVEL.LEVEL_9_3, LEVEL.LEVEL_9_2, LEVEL.LEVEL_9_1])
    {
        assert.equal(D3D10CreateDevice1(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0, level,
            D3D10_1_SDK_VERSION, out), DXGI_ERROR_UNSUPPORTED, `level ${level}`);
        assert.equal(out.device, null);
    }
    assert.equal(D3D10CreateDevice1(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0, 0,
        D3D10_1_SDK_VERSION, out), E_INVALIDARG, 'no level at all');
    assert.equal(D3D10CreateDevice1(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0, LEVEL.LEVEL_10_0,
        D3D10_SDK_VERSION, out), E_INVALIDARG, '10.0\'s SDK version');
    assert.equal(D3D10CreateDevice1(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0, LEVEL.LEVEL_10_0,
        D3D10_1_SDK_VERSION, null), E_INVALIDARG, 'no device pointer');

    // A device from the 10.0 entry point is the same device.
    /** @type {{ device?: any }} */
    const old = {};
    assert.equal(D3D10CreateDevice(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0, D3D10_SDK_VERSION,
        old), S_OK);
    assert.ok(old.device.supports(IID.ID3D10Device1));
    assert.equal(old.device.GetFeatureLevel(), LEVEL.LEVEL_10_0);
    old.device.release();
});

test('the 10.1 device-and-swap-chain entry point needs a device pointer', ()=>{
    const desc = { ...defaultSwapChainDesc(), outputWindow: 0x1234 };
    const make = (/** @type {any} */ chain, /** @type {any} */ device,
        /** @type {number} */ level = LEVEL.LEVEL_10_0,
        swapChainDesc = /** @type {any} */ (desc))=>D3D10CreateDeviceAndSwapChain1(null,
        D3D10_DRIVER_TYPE.HARDWARE, null, 0, level, D3D10_1_SDK_VERSION, swapChainDesc, chain,
        device);

    /** @type {{ swapChain?: any }} */
    const chain = {};
    /** @type {{ device?: any }} */
    const device = {};
    assert.equal(make(chain, device), S_OK);
    assert.ok(chain.swapChain && device.device);
    assert.equal(chain.swapChain.release(), 0);
    assert.equal(device.device.release(), 0);

    assert.equal(make(null, device, LEVEL.LEVEL_10_0, null), S_OK, 'the device alone');
    device.device.release();
    assert.equal(make(null, null, LEVEL.LEVEL_10_0, null), E_INVALIDARG);
    assert.equal(make(null, null), E_INVALIDARG);
    chain.swapChain = 'untouched';
    assert.equal(make(chain, null), E_INVALIDARG);
    assert.equal(chain.swapChain, null);
    device.device = 'untouched';
    assert.equal(make(chain, device, 0), E_INVALIDARG);
    assert.deepEqual([chain.swapChain, device.device], [null, null]);
    assert.equal(make(null, device, LEVEL.LEVEL_10_0, { ...desc, outputWindow: 0 }), S_OK,
        'a description is not read without a swap chain pointer');
    device.device.release();
    assert.equal(make(chain, device, LEVEL.LEVEL_10_0, { ...desc, outputWindow: 0 }),
        DXGI_ERROR_INVALID_CALL, 'a swap chain with no window');
    assert.deepEqual([chain.swapChain, device.device], [null, null]);
});

test('CreateShaderResourceView1 makes the view CreateShaderResourceView does, as its 10.1 self',
    ()=>{
        const device = createDevice1();
        /** @type {{ resource?: any }} */
        const buffer = {};
        assert.equal(device.CreateBuffer({
            ByteWidth: 1024, Usage: D3D10_USAGE.DEFAULT, BindFlags: D3D10_BIND.SHADER_RESOURCE,
            CPUAccessFlags: 0, MiscFlags: 0,
        }, null, buffer), S_OK);
        /** @type {{ view?: any }} */
        const view = {};
        assert.equal(device.CreateShaderResourceView1(buffer.resource, null, view), E_INVALIDARG,
            'a buffer view needs a description');
        const bufferDesc = { Format: DXGI_FORMAT.R32G32B32A32_FLOAT, ViewDimension: 1,
            ElementOffset: 0, ElementWidth: 64 };
        assert.equal(device.CreateShaderResourceView1(null, bufferDesc, view), E_INVALIDARG);
        assert.equal(device.CreateShaderResourceView1(buffer.resource, bufferDesc, view), S_OK);
        assert.ok(view.view.supports(IID.ID3D10ShaderResourceView1));
        assert.ok(view.view.supports(IID.ID3D10ShaderResourceView));
        view.view.release();

        /** @type {{ resource?: any }} */
        const texture = {};
        assert.equal(device.CreateTexture2D({
            Width: 512, Height: 512, MipLevels: 0, ArraySize: 1, Format: DXGI_FORMAT.R8G8B8A8_UNORM,
            SampleDesc: { Count: 1, Quality: 0 }, Usage: D3D10_USAGE.DEFAULT,
            BindFlags: D3D10_BIND.SHADER_RESOURCE, CPUAccessFlags: 0, MiscFlags: 0,
        }, null, texture), S_OK);
        assert.equal(device.CreateShaderResourceView1(texture.resource, null, view), S_OK);
        /** @type {{ desc?: any }} */
        const desc = {};
        view.view.GetDesc(desc);
        assert.deepEqual([desc.desc.Format, desc.desc.ViewDimension, desc.desc.MostDetailedMip,
            desc.desc.MipLevels], [DXGI_FORMAT.R8G8B8A8_UNORM, 4, 0, 10]);
        view.view.release();
        assert.equal(device.CreateShaderResourceView1(texture.resource, {
            Format: DXGI_FORMAT.R8G8B8A8_UNORM, ViewDimension: 10, MostDetailedMip: 0,
            MipLevels: 1, FirstArraySlice: 0, ArraySize: 1,
        }, view), E_INVALIDARG, 'a cube array is 10.1\'s, and this device is 10.0');
        texture.resource.release();
        buffer.resource.release();
        assert.equal(device.release(), 0);
    });

/**
 * @param {boolean} enable
 * @param {number} [writeMask]
 * @param {number} [op]
 */
const target = (enable, writeMask = D3D10_COLOR_WRITE_ENABLE.ALL, op = D3D10_BLEND_OP.ADD)=>({
    BlendEnable: enable, SrcBlend: D3D10_BLEND.ONE, DestBlend: D3D10_BLEND.ZERO, BlendOp: op,
    SrcBlendAlpha: D3D10_BLEND.ONE, DestBlendAlpha: D3D10_BLEND.ZERO,
    BlendOpAlpha: D3D10_BLEND_OP.ADD, RenderTargetWriteMask: writeMask,
});

test('CreateBlendState1 keeps a description per target and reads back as both versions', ()=>{
    const device = createDevice1();
    /** @type {{ state?: any }} */
    const first = {};
    assert.equal(device.CreateBlendState1(null, first), E_INVALIDARG);
    const plain = { AlphaToCoverageEnable: false, IndependentBlendEnable: false,
        RenderTarget: [target(false)] };
    assert.equal(device.CreateBlendState1(plain, first), S_OK);
    /** @type {{ state?: any }} */
    const second = {};
    assert.equal(device.CreateBlendState1(plain, second), S_OK);
    assert.equal(second.state, first.state, 'one object per description');
    /** @type {{ desc?: any }} */
    const desc1 = {};
    first.state.GetDesc1(desc1);
    assert.equal(desc1.desc.IndependentBlendEnable, false);
    assert.equal(desc1.desc.RenderTarget.length, 8);
    for (const each of desc1.desc.RenderTarget)
    {
        assert.deepEqual({ ...each }, target(false), 'every target is the first');
    }
    first.state.release();
    second.state.release();

    // After the conversion table of test_create_blend_state: a 10.0 reading
    // carries the first target's factors and every target's enable and mask.
    const independent = { AlphaToCoverageEnable: false, IndependentBlendEnable: true,
        RenderTarget: [target(true), target(false, D3D10_COLOR_WRITE_ENABLE.RED), target(true),
            target(false, D3D10_COLOR_WRITE_ENABLE.GREEN), target(true), target(true),
            target(true), target(true, D3D10_COLOR_WRITE_ENABLE.ALL, D3D10_BLEND_OP.SUBTRACT)] };
    assert.equal(device.CreateBlendState1(independent, first), S_OK);
    /** @type {{ desc?: any }} */
    const desc = {};
    first.state.GetDesc(desc);
    assert.deepEqual([...desc.desc.BlendEnable], [true, false, true, false, true, true, true,
        true]);
    assert.deepEqual([...desc.desc.RenderTargetWriteMask], [15, 1, 15, 2, 15, 15, 15, 15]);
    assert.deepEqual([desc.desc.SrcBlend, desc.desc.DestBlend, desc.desc.BlendOp],
        [D3D10_BLEND.ONE, D3D10_BLEND.ZERO, D3D10_BLEND_OP.ADD]);
    first.state.GetDesc1(desc1);
    assert.equal(desc1.desc.RenderTarget[7].BlendOp, D3D10_BLEND_OP.SUBTRACT,
        'the 10.1 reading keeps each target\'s own factors');
    first.state.release();

    // A 10.0 blend state read as 10.1: independent where its targets differ.
    /** @type {{ state?: any }} */
    const old = {};
    assert.equal(device.CreateBlendState({
        AlphaToCoverageEnable: false, BlendEnable: [true, false, false, false, false, false,
            false, false], SrcBlend: D3D10_BLEND.SRC_ALPHA, DestBlend: D3D10_BLEND.INV_SRC_ALPHA,
        BlendOp: D3D10_BLEND_OP.ADD, SrcBlendAlpha: D3D10_BLEND.ONE,
        DestBlendAlpha: D3D10_BLEND.ZERO, BlendOpAlpha: D3D10_BLEND_OP.ADD,
        RenderTargetWriteMask: new Array(8).fill(D3D10_COLOR_WRITE_ENABLE.ALL),
    }, old), S_OK);
    old.state.GetDesc1(desc1);
    assert.equal(desc1.desc.IndependentBlendEnable, true);
    assert.equal(desc1.desc.RenderTarget[0].SrcBlend, D3D10_BLEND.SRC_ALPHA);
    assert.equal(desc1.desc.RenderTarget[1].SrcBlend, D3D10_BLEND.ONE,
        'a target that does not blend reads the default factors');
    old.state.release();
    assert.equal(device.release(), 0);
});
