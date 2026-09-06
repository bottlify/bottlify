/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3DCUBEMAP_FACE, D3DERR_INVALIDCALL, D3DFMT, D3DPOOL, D3DSWAPEFFECT, D3DUSAGE, D3D_OK,
} from './constants.js';
import { createDirect3D9 } from './device.js';
import {
    FORMAT_KIND, RESOURCE_VALIDITY, SURFACE_TYPE, surfaceCreateResult, surfaceIsLockable,
    validatePresentParameters,
} from './validity.js';

const EXTENT = 16;

/**
 * @param {object} [caps]
 */
function createDevice(caps = {}){
    const d3d = createDirect3D9(caps);
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD }, out), D3D_OK);
    return out.device;
}

/**
 * @param {any} device
 */
function assertFullyReleased(device){
    assert.equal(device.release(), 0, 'the device reached a reference count of zero');
}

/**
 * @param {string} kind
 * @returns {number}
 */
function formatFor(kind){
    return kind === FORMAT_KIND.DEPTH ? D3DFMT.D24S8 : D3DFMT.A8R8G8B8;
}

/**
 * Asks the device for one row of the table as one surface type, and hands back
 * both the result and a way to let go of whatever was created.
 *
 * @param {any} device
 * @param {string} type
 * @param {import("./validity.js").ResourceValidityRow} row
 */
function createFor(device, type, row){
    const format = formatFor(row.format);
    const dynamic = (row.usage & D3DUSAGE.DYNAMIC) !== 0;
    /** @type {{ texture?: any, surface?: any }} */
    const out = {};

    switch (type)
    {
        case SURFACE_TYPE.TEXTURE_2D:
        {
            const hr = device.CreateTexture(EXTENT, EXTENT, 1, row.usage, format, row.pool, out);
            if (hr !== D3D_OK)
            {
                return { hr, surface: null, release: ()=>{} };
            }
            /** @type {{ surface?: any }} */
            const level = {};
            assert.equal(out.texture.GetSurfaceLevel(0, level), D3D_OK);
            return {
                hr,
                surface: level.surface,
                release: ()=>{
                    level.surface.release();
                    out.texture.release();
                },
            };
        }
        case SURFACE_TYPE.CUBE:
        {
            const hr = device.CreateCubeTexture(EXTENT, 1, row.usage, format, row.pool, out);
            if (hr !== D3D_OK)
            {
                return { hr, surface: null, release: ()=>{} };
            }
            /** @type {{ surface?: any }} */
            const face = {};
            assert.equal(
                out.texture.GetCubeMapSurface(D3DCUBEMAP_FACE.POSITIVE_X, 0, face), D3D_OK);
            return {
                hr,
                surface: face.surface,
                release: ()=>{
                    face.surface.release();
                    out.texture.release();
                },
            };
        }
        case SURFACE_TYPE.RENDER_TARGET:
        {
            const hr = device.CreateRenderTarget(EXTENT, EXTENT, format, dynamic, out);
            return hr === D3D_OK
                ? { hr, surface: out.surface, release: ()=>out.surface.release() }
                : { hr, surface: null, release: ()=>{} };
        }
        case SURFACE_TYPE.DEPTH_STENCIL:
        {
            const hr = device.CreateDepthStencilSurface(EXTENT, EXTENT, format, out);
            return hr === D3D_OK
                ? { hr, surface: out.surface, release: ()=>out.surface.release() }
                : { hr, surface: null, release: ()=>{} };
        }
        default:
        {
            const hr = device.CreateOffscreenPlainSurface(EXTENT, EXTENT, format, row.pool, out);
            return hr === D3D_OK
                ? { hr, surface: out.surface, release: ()=>out.surface.release() }
                : { hr, surface: null, release: ()=>{} };
        }
    }
}

/**
 * The two entry points that name a usage report that usage rather than the one
 * they were asked for, and an offscreen plain surface reports none at all --
 * which is how a program tells what it actually got.
 *
 * @param {any} surface
 * @param {string} type
 * @param {import("./validity.js").ResourceValidityRow} row
 * @param {string} label
 */
function assertDescribesItself(surface, type, row, label){
    /** @type {{ desc?: any }} */
    const out = {};
    assert.equal(surface.GetDesc(out), D3D_OK, label);

    if (type === SURFACE_TYPE.RENDER_TARGET || type === SURFACE_TYPE.DEPTH_STENCIL)
    {
        const usage = type === SURFACE_TYPE.RENDER_TARGET
            ? D3DUSAGE.RENDERTARGET
            : D3DUSAGE.DEPTHSTENCIL;
        assert.equal(out.desc.Usage, usage, `usage of ${label}`);
        assert.equal(out.desc.Pool, D3DPOOL.DEFAULT, `pool of ${label}`);
        return;
    }
    assert.equal(out.desc.Usage, type === SURFACE_TYPE.PLAIN ? 0 : row.usage, `usage of ${label}`);
    assert.equal(out.desc.Pool, row.pool, `pool of ${label}`);
}

/**
 * The whole table, once per depth-format support the adapter might report. The
 * condition travels with the expectation rather than being resolved to one
 * machine's answer, so both branches are walked here.
 */
for (const support of [
    { name: 'no depth support', depthTexture2d: false, depthCube: false, depthPlain: false },
    { name: 'full depth support', depthTexture2d: true, depthCube: true, depthPlain: true },
])
{
    test(`pool, usage and surface type decide creation (${support.name})`, ()=>{
        const device = createDevice(support);

        for (const type of Object.values(SURFACE_TYPE))
        {
            for (const row of RESOURCE_VALIDITY)
            {
                const expected = surfaceCreateResult(type, row, support);
                const label = `${type} pool ${row.pool} usage ${row.usage} ${row.format}`;
                const created = createFor(device, type, row);

                assert.equal(created.hr, expected, label);
                if (created.hr !== D3D_OK)
                {
                    assert.equal(created.hr, D3DERR_INVALIDCALL, label);
                    continue;
                }

                assertDescribesItself(created.surface, type, row, label);

                const locked = { pBits: 0, Pitch: 0 };
                const lockable = surfaceIsLockable({
                    type,
                    pool: row.pool,
                    usage: row.usage,
                    lockable: (row.usage & D3DUSAGE.DYNAMIC) !== 0,
                });
                assert.equal(created.surface.LockRect(locked, null, 0),
                    lockable ? D3D_OK : D3DERR_INVALIDCALL, `lock ${label}`);
                if (lockable)
                {
                    assert.equal(created.surface.UnlockRect(), D3D_OK, label);
                }
                created.release();
            }
        }

        assertFullyReleased(device);
    });
}

test('the lockability rule itself, at the four points that decide it', ()=>{
    const plain = { type: SURFACE_TYPE.PLAIN, pool: D3DPOOL.DEFAULT, usage: 0 };
    const depth = { type: SURFACE_TYPE.DEPTH_STENCIL, pool: D3DPOOL.DEFAULT, usage: 0 };
    const target = { type: SURFACE_TYPE.RENDER_TARGET, pool: D3DPOOL.DEFAULT, usage: 0 };
    const texture = { type: SURFACE_TYPE.TEXTURE_2D, pool: D3DPOOL.DEFAULT, usage: 0 };

    assert.equal(surfaceIsLockable(plain), true, 'an offscreen plain surface always locks');
    assert.equal(surfaceIsLockable(depth), false, 'a depth stencil never does');
    assert.equal(surfaceIsLockable({ ...target, lockable: false }), false);
    assert.equal(surfaceIsLockable({ ...target, lockable: true }), true,
        'a render target locks exactly when it was created lockable');
    assert.equal(surfaceIsLockable(texture), false, 'a default-pool texture surface does not');
    assert.equal(surfaceIsLockable({ ...texture, usage: D3DUSAGE.DYNAMIC }), true);
    assert.equal(surfaceIsLockable({ ...texture, pool: D3DPOOL.MANAGED }), true);
});

// --- swap chain parameters ---

/**
 * The back-buffer count each swap effect allows. COPY is the one that surprises
 * people: it takes zero or one, and two is a failure rather than a clamp.
 */
const SWAP_CHAIN_CASES = [
    { swapEffect: 0, backBufferCount: 1, expected: D3DERR_INVALIDCALL },
    { swapEffect: 0, backBufferCount: 0, expected: D3DERR_INVALIDCALL },
    { swapEffect: D3DSWAPEFFECT.COPY, backBufferCount: 0, expected: D3D_OK },
    { swapEffect: D3DSWAPEFFECT.COPY, backBufferCount: 1, expected: D3D_OK },
    { swapEffect: D3DSWAPEFFECT.COPY, backBufferCount: 2, expected: D3DERR_INVALIDCALL },
    { swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1, expected: D3D_OK },
    { swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 3, expected: D3D_OK },
    { swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 4, expected: D3DERR_INVALIDCALL },
    { swapEffect: D3DSWAPEFFECT.FLIP, backBufferCount: 3, expected: D3D_OK },
    { swapEffect: D3DSWAPEFFECT.FLIP, backBufferCount: 4, expected: D3DERR_INVALIDCALL },
    { swapEffect: D3DSWAPEFFECT.OVERLAY, backBufferCount: 1, expected: D3DERR_INVALIDCALL },
    { swapEffect: D3DSWAPEFFECT.FLIPEX, backBufferCount: 1, expected: D3DERR_INVALIDCALL },
    { swapEffect: D3DSWAPEFFECT.FLIPEX + 1, backBufferCount: 1, expected: D3DERR_INVALIDCALL },
];

test('the swap effect and the back-buffer count are checked together', ()=>{
    const d3d = createDirect3D9();

    for (const parameters of SWAP_CHAIN_CASES)
    {
        const label = `effect ${parameters.swapEffect}, ${parameters.backBufferCount} buffers`;
        assert.equal(validatePresentParameters(parameters), parameters.expected, label);

        /** @type {{ device?: any }} */
        const out = { device: null };
        assert.equal(d3d.CreateDevice(parameters, out), parameters.expected, label);
        if (parameters.expected !== D3D_OK)
        {
            assert.equal(out.device, null, `${label} produced no device`);
            continue;
        }
        assert.equal(out.device.release(), 0, label);
    }
});

test('a zero back-buffer count is reported back as one', ()=>{
    const device = createDevice();
    /** @type {{ swapChain?: any }} */
    const chain = {};
    assert.equal(device.GetSwapChain(0, chain), D3D_OK);

    /** @type {{ parameters?: any }} */
    const out = {};
    assert.equal(chain.swapChain.GetPresentParameters(out), D3D_OK);
    assert.equal(out.parameters.backBufferCount, 1);
    assert.equal(out.parameters.swapEffect, D3DSWAPEFFECT.DISCARD, 'the swap effect is unchanged');

    chain.swapChain.release();
    assertFullyReleased(device);
});
