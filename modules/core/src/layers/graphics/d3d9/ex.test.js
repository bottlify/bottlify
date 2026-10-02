/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A device made through IDirect3D9Ex, against Wine's d3d9ex.c: what it
 * answers that a plain device does not, and where the two part company.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3DERR_DEVICELOST, D3DERR_DEVICEREMOVED, D3DERR_INVALIDCALL, D3DFMT, D3DPOOL, D3DRS,
    D3DSWAPEFFECT, D3DUSAGE, D3D_OK,
} from './constants.js';
import { D3DFMT_INDEX } from '../d3d8/constants.js';
import { createDirect3D9 } from './device.js';

/** @param {boolean} extended @param {object} [parameters] */
function make(extended, parameters = {}){
    const d3d = createDirect3D9();
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT.DISCARD,
        backBufferCount: 1,
        backBufferWidth: 64,
        backBufferHeight: 48,
        backBufferFormat: D3DFMT.X8R8G8B8,
        enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT.D24S8,
        ...parameters,
    }, out, 0, {}, extended), D3D_OK);
    return out.device;
}

test('an Ex device is never lost: a GPU that went away is removed', ()=>{
    // Wine's d3d9ex.c test_lost_device: TestCooperativeLevel succeeds
    // throughout, Present and CheckDeviceState answer for the device.
    const device = make(true);
    assert.equal(device.extended, true);
    assert.equal(device.CheckDeviceState(0), D3D_OK);
    assert.equal(device.Present(), D3D_OK);
    device.injectDeviceLoss(false);
    assert.equal(device.TestCooperativeLevel(), D3D_OK);
    assert.equal(device.Present(), D3DERR_DEVICEREMOVED);
    assert.equal(device.CheckDeviceState(0), D3DERR_DEVICEREMOVED);
    assert.equal(device.release(), 0);

    const plain = make(false);
    assert.equal(plain.extended, false);
    plain.injectDeviceLoss(false);
    assert.equal(plain.Present(), D3DERR_DEVICELOST, 'a plain device is lost as it was');
    assert.equal(plain.release(), 0);
});

test('an Ex device has no managed pool', ()=>{
    // Wine's d3d9ex.c test_resource_access.
    const device = make(true);
    const plain = make(false);
    for (const [name, args] of /** @type {[string, any[]][]} */ ([
        ['CreateTexture', [8, 8, 1, 0, D3DFMT.A8R8G8B8]],
        ['CreateCubeTexture', [8, 1, 0, D3DFMT.A8R8G8B8]],
        ['CreateVolumeTexture', [8, 8, 8, 1, 0, D3DFMT.A8R8G8B8]],
        ['CreateVertexBuffer', [64, 0, 0]],
        ['CreateIndexBuffer', [64, 0, D3DFMT_INDEX.INDEX16]],
    ]))
    {
        assert.equal(device[name](...args, D3DPOOL.MANAGED, {}), D3DERR_INVALIDCALL, name);
        /** @type {any} */
        const made = {};
        assert.equal(device[name](...args, D3DPOOL.SYSTEMMEM, made), D3D_OK,
            `${name} in system memory`);
        Object.values(made)[0].release();
        assert.equal(plain[name](...args, D3DPOOL.MANAGED, made), D3D_OK,
            `a plain device's ${name}`);
        Object.values(made)[0].release();
    }
    assert.equal(device.release(), 0);
    assert.equal(plain.release(), 0);
});

test('an Ex reset keeps the state and does not wait for default-pool resources', ()=>{
    // Wine's d3d9ex.c test_reset_ex and test_reset_resources: a render
    // state and the depth range survive, the viewport and scissor take the
    // new size, and a target the program holds does not stop the reset.
    const device = make(true);
    /** @type {{ surface?: any }} */
    const target = {};
    assert.equal(device.CreateRenderTarget(16, 16, D3DFMT.A8R8G8B8, false, target), D3D_OK);
    assert.equal(device.SetRenderState(D3DRS.LIGHTING, 0), D3D_OK);
    assert.equal(device.SetViewport({ X: 1, Y: 2, Width: 8, Height: 8, MinZ: 0.25, MaxZ: 0.5 }),
        D3D_OK);
    assert.equal(device.Reset({
        swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1, backBufferWidth: 40,
        backBufferHeight: 30, backBufferFormat: D3DFMT.X8R8G8B8, windowed: true,
    }), D3D_OK);
    /** @type {{ value?: number }} */
    const state = {};
    assert.equal(device.GetRenderState(D3DRS.LIGHTING, state), D3D_OK);
    assert.equal(state.value, 0, 'the render state is kept');
    /** @type {{ viewport?: any }} */
    const read = {};
    assert.equal(device.GetViewport(read), D3D_OK);
    assert.deepEqual([read.viewport.X, read.viewport.Y, read.viewport.Width,
        read.viewport.Height, read.viewport.MinZ, read.viewport.MaxZ], [0, 0, 40, 30, 0.25, 0.5]);
    assert.equal(target.surface.release(), 0);
    assert.equal(device.release(), 0);

    const plain = make(false);
    assert.equal(plain.CreateRenderTarget(16, 16, D3DFMT.A8R8G8B8, false, target), D3D_OK);
    assert.equal(plain.Reset(), D3DERR_INVALIDCALL, 'a plain device waits for it');
    assert.equal(target.surface.release(), 0);
    assert.equal(plain.Reset(), D3D_OK);
    assert.equal(plain.SetRenderState(D3DRS.LIGHTING, 0), D3D_OK);
    assert.equal(plain.Reset(), D3D_OK);
    assert.equal(plain.GetRenderState(D3DRS.LIGHTING, state), D3D_OK);
    assert.equal(state.value, 1, 'and puts the state back');
    assert.equal(plain.release(), 0);
});

test('the Ex latency, priority, residency and vertical blank', ()=>{
    // Wine's d3d9ex.c test_frame_latency: three to begin with, zero for the
    // default, thirty at most.
    const device = make(true);
    /** @type {{ latency?: number }} */
    const latency = {};
    assert.equal(device.GetMaximumFrameLatency(latency), D3D_OK);
    assert.equal(latency.latency, 3);
    assert.equal(device.SetMaximumFrameLatency(1), D3D_OK);
    assert.equal(device.GetMaximumFrameLatency(latency), D3D_OK);
    assert.equal(latency.latency, 1);
    assert.equal(device.SetMaximumFrameLatency(0), D3D_OK);
    assert.equal(device.GetMaximumFrameLatency(latency), D3D_OK);
    assert.equal(latency.latency, 3);
    assert.equal(device.SetMaximumFrameLatency(30), D3D_OK);
    assert.equal(device.SetMaximumFrameLatency(31), D3DERR_INVALIDCALL);

    /** @type {{ priority?: number }} */
    const priority = {};
    assert.equal(device.GetGPUThreadPriority(priority), D3D_OK);
    assert.equal(priority.priority, 0);
    assert.equal(device.SetGPUThreadPriority(-7), D3D_OK);
    assert.equal(device.SetGPUThreadPriority(8), D3DERR_INVALIDCALL);
    assert.equal(device.GetGPUThreadPriority(priority), D3D_OK);
    assert.equal(priority.priority, -7);

    assert.equal(device.CheckResourceResidency(3), D3D_OK);
    assert.equal(device.CheckResourceResidency(65536), D3DERR_INVALIDCALL);
    assert.equal(device.WaitForVBlank(0), D3D_OK);
    assert.equal(device.WaitForVBlank(1), D3DERR_INVALIDCALL);

    // The chain counts what was presented.
    /** @type {{ swapChain?: any }} */
    const chain = {};
    assert.equal(device.GetSwapChain(0, chain), D3D_OK);
    assert.equal(chain.swapChain.presentCount, 0);
    assert.equal(device.Present(), D3D_OK);
    assert.equal(device.Present(), D3D_OK);
    assert.equal(chain.swapChain.presentCount, 2);
    chain.swapChain.release();
    assert.equal(device.release(), 0);
});

test('the Ex surface creates take the sharing and content restrictions and nothing else', ()=>{
    // Wine's d3d9ex.c test_create_depth_stencil_surface_ex.
    const device = make(true);
    for (const [usage, hr] of [[0, D3D_OK], [D3DUSAGE.DEPTHSTENCIL, D3DERR_INVALIDCALL],
        [D3DUSAGE.RESTRICTED_CONTENT, D3D_OK]])
    {
        /** @type {{ surface?: any }} */
        const made = {};
        assert.equal(device.CreateDepthStencilSurfaceEx(64, 64, D3DFMT.D24S8, usage, made), hr);
        if (hr === D3D_OK)
        {
            /** @type {{ desc?: any }} */
            const desc = {};
            made.surface.GetDesc(desc);
            assert.equal(desc.desc.Usage, usage | D3DUSAGE.DEPTHSTENCIL);
            assert.equal(desc.desc.Pool, D3DPOOL.DEFAULT);
            assert.equal(made.surface.release(), 0);
        }
        else
        {
            assert.deepEqual(made, {}, 'a refusal hands nothing back');
        }
    }
    /** @type {{ surface?: any }} */
    const target = {};
    assert.equal(device.CreateRenderTargetEx(8, 8, D3DFMT.A8R8G8B8, false,
        D3DUSAGE.RESTRICT_SHARED_RESOURCE, target), D3D_OK);
    assert.equal(target.surface.release(), 0);
    assert.equal(device.CreateRenderTargetEx(8, 8, D3DFMT.A8R8G8B8, false,
        D3DUSAGE.RENDERTARGET, {}), D3DERR_INVALIDCALL);
    /** @type {{ surface?: any }} */
    const plainSurface = {};
    assert.equal(device.CreateOffscreenPlainSurfaceEx(8, 8, D3DFMT.A8R8G8B8, D3DPOOL.SYSTEMMEM,
        0, plainSurface), D3D_OK);
    assert.equal(plainSurface.surface.release(), 0);
    assert.equal(device.release(), 0);
});

test('an Ex device takes FLIPEX and up to thirty back buffers', ()=>{
    // Wine's d3d9ex.c test_swapchain_parameters.
    for (const [swapEffect, backBufferCount, extended, hr] of [
        [D3DSWAPEFFECT.FLIPEX, 1, true, D3D_OK],
        [D3DSWAPEFFECT.FLIPEX + 1, 1, true, D3DERR_INVALIDCALL],
        [D3DSWAPEFFECT.DISCARD, 30, true, D3D_OK],
        [D3DSWAPEFFECT.DISCARD, 31, true, D3DERR_INVALIDCALL],
        [D3DSWAPEFFECT.COPY, 2, true, D3DERR_INVALIDCALL],
        [D3DSWAPEFFECT.FLIPEX, 1, false, D3DERR_INVALIDCALL],
        [D3DSWAPEFFECT.DISCARD, 4, false, D3DERR_INVALIDCALL],
    ])
    {
        /** @type {{ device?: any }} */
        const out = {};
        assert.equal(createDirect3D9().CreateDevice({
            swapEffect: Number(swapEffect), backBufferCount: Number(backBufferCount),
            backBufferWidth: 8, backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8,
        }, out, 0, {}, Boolean(extended)), hr, `${swapEffect} x${backBufferCount} ${extended}`);
        out.device?.release();
    }
});

test("an Ex device keeps a system-memory texture or surface in the program's own memory", ()=>{
    // Wine's d3d9ex.c test_user_memory: the shared handle of a system-memory
    // texture of one level, or a plain surface, is memory the program owns,
    // and a lock hands it back with a pitch of the rows laid end to end.
    const device = make(true);
    const MEMORY = 0x40000;
    /** @type {{ texture?: any }} */
    const made = {};
    for (const [width, levels, pool] of [[128, 0, D3DPOOL.SYSTEMMEM], [128, 2, D3DPOOL.SYSTEMMEM],
        [128, 1, D3DPOOL.SCRATCH]])
    {
        assert.equal(device.CreateTexture(width, width, levels, 0, D3DFMT.A8R8G8B8, pool, made,
            MEMORY), D3DERR_INVALIDCALL, `${levels} levels in pool ${pool}`);
    }
    assert.equal(device.CreateTexture(33, 33, 1, 0, D3DFMT.L8, D3DPOOL.SYSTEMMEM, made, MEMORY),
        D3D_OK);
    /** @type {{ pBits?: number, Pitch?: number }} */
    const locked = {};
    assert.equal(made.texture.LockRect(0, locked, null, 0), D3D_OK);
    assert.deepEqual([locked.pBits, locked.Pitch], [MEMORY, 33]);
    assert.equal(made.texture.UnlockRect(0), D3D_OK);

    /** @type {{ surface?: any }} */
    const plain = {};
    assert.equal(device.CreateOffscreenPlainSurface(128, 128, D3DFMT.A8R8G8B8, D3DPOOL.SCRATCH,
        plain, 0, MEMORY), D3DERR_INVALIDCALL);
    assert.equal(device.CreateOffscreenPlainSurface(128, 128, D3DFMT.A8R8G8B8,
        D3DPOOL.SYSTEMMEM, plain, 0, MEMORY), D3D_OK);
    assert.equal(plain.surface.LockRect(locked, null, 0), D3D_OK);
    assert.deepEqual([locked.pBits, locked.Pitch], [MEMORY, 512]);
});

test("a back buffer an Ex device's program holds past a reset is the chain's no longer", ()=>{
    // Wine's d3d9ex.c test_backbuffer_resize: its container is the device.
    const device = make(true);
    /** @type {{ surface?: any }} */
    const out = {};
    assert.equal(device.GetBackBuffer(0, 0, 0, out), D3D_OK);
    const old = out.surface;
    assert.notEqual(old.container, null, 'the chain holds it');
    assert.equal(device.Reset({
        swapEffect: D3DSWAPEFFECT.DISCARD, backBufferWidth: 80, backBufferHeight: 60,
        backBufferFormat: D3DFMT.A8R8G8B8,
    }), D3D_OK);
    assert.equal(old.container, null);
    /** @type {{ surface?: any }} */
    const fresh = {};
    assert.equal(device.GetBackBuffer(0, 0, 0, fresh), D3D_OK);
    assert.notEqual(fresh.surface, old);
    assert.notEqual(fresh.surface.container, null);
});
