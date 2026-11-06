/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D 7 object model, as a program observes it. Nothing here looks
 * at a picture: the first part is state and reference counts with no backend
 * at all, the second checks what the GPU was asked to do through the
 * recording device. Every test ends with the device and the DirectDraw object
 * it came from at zero -- a count that stayed up is a resource still held.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bufferLockFlags, createDirect3D7, d3dFormatOf } from './device.js';
import {
    D3DDEVCAPS_HWRASTERIZATION, D3DDEVCAPS_HWTRANSFORMANDLIGHT, D3DERR_INBEGINSTATEBLOCK,
    D3DERR_INVALIDSTATEBLOCK, D3DERR_INVALIDVERTEXFORMAT, D3DERR_NOTINBEGINSTATEBLOCK,
    D3DERR_SCENE_IN_SCENE, D3DERR_SCENE_NOT_IN_SCENE, D3DERR_SURFACENOTINVIDMEM,
    D3DFMT, D3DRENDERSTATE, D3DRENDERSTATE_MAX, D3DSBT,
    D3DTRANSFORMSTATE, D3DVBCAPS_OPTIMIZED, D3DZB, D3D_OK, DDERR_INVALIDCAPS, DDERR_INVALIDPARAMS,
    DDERR_NOTFOUND, DEVICE_IDS, floatToDword,
} from './constants.js';
import { D3DCLEAR, D3DPT, D3DTA, D3DTOP, D3DTSS } from '../d3d8/constants.js';
import { FVF } from '../webgpu/internal/vertexformat.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { UNIFORM_AT } from '../d3d8/render.js';
import { createDirectDraw, depthFormatForDepth } from '../ddraw/objects.js';
import {
    DDCKEY_SRCBLT, DDPF_ALPHAPIXELS, DDPF_FOURCC, DDPF_RGB, DDPF_STENCILBUFFER, DDSCAPS_3DDEVICE,
    DDSCAPS_COMPLEX,
    DDSCAPS_MIPMAP,
    DDSCAPS_OFFSCREENPLAIN, DDSCAPS_SYSTEMMEMORY, DDSCAPS_TEXTURE, DDSCAPS_ZBUFFER, DDSCL_NORMAL,
    DDSD_CAPS, DDSD_HEIGHT, DDSD_MIPMAPCOUNT, DDSD_PIXELFORMAT, DDSD_WIDTH, DDSD_ZBUFFERBITDEPTH,
} from '../ddraw/constants.js';

const HWND = 0x00010044;
const FVF_TL = FVF.XYZRHW | FVF.DIFFUSE;
const FVF_TL_TEX = FVF_TL | (1 << FVF.TEXCOUNT_SHIFT);
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const ARGB32 = Object.freeze({
    size: 0x20, flags: DDPF_RGB | DDPF_ALPHAPIXELS, fourCC: 0, bitCount: 32,
    redMask: 0xff0000, greenMask: 0xff00, blueMask: 0xff, alphaMask: 0xff000000,
});

/**
 * A DirectDraw object under a cooperative level, the way a program has one
 * before it asks for Direct3D.
 *
 * @param {{ allocate?: (bytes: number) => number, free?: (address: number) => void }} [options]
 */
function ddrawObject(options = {}){
    const root = createDirectDraw({ version: 7, screenWidth: 16, screenHeight: 16, ...options });
    root.setCooperativeLevel(HWND, DDSCL_NORMAL);
    return root;
}

/**
 * @param {any} root
 * @param {{ caps?: number, width?: number, height?: number, pixelFormat?: any,
 *           zBufferBitDepth?: number }} [options]
 */
function surface(root, options = {}){
    const depth = options.zBufferBitDepth !== undefined;
    const made = root.createSurface({
        flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT
            | (options.pixelFormat ? DDSD_PIXELFORMAT : 0)
            | (depth ? DDSD_ZBUFFERBITDEPTH : 0),
        caps: options.caps ?? (DDSCAPS_3DDEVICE | DDSCAPS_OFFSCREENPLAIN),
        width: options.width ?? 8,
        height: options.height ?? 8,
        pixelFormat: options.pixelFormat,
        zBufferBitDepth: options.zBufferBitDepth,
    });
    assert.equal(made.hr, D3D_OK, 'the fixture surface is created');
    return made.surface;
}

/** A device on a fresh target, with everything needed to release it. */
function fixture(){
    const root = ddrawObject();
    const d3d = createDirect3D7(root);
    const target = surface(root);
    const made = d3d.createDevice(DEVICE_IDS.HAL, target);
    assert.equal(made.hr, D3D_OK);
    return { root, d3d, target, device: made.device };
}

/**
 * Every test ends here: the device's last reference is the test's, the
 * target's too, and then the DirectDraw object has nothing left holding it.
 *
 * @param {{ root: any, target: any, device: any }} f
 */
function releaseAll(f){
    assert.equal(f.device.release(), 0, 'the device reached zero');
    assert.equal(f.target.release(), 0, 'the target reached zero');
    assert.equal(f.root.release('IDirectDraw7'), 0);
    assert.ok(f.root.destroyed, 'the DirectDraw object is gone');
}

// --- the object ---

test('three devices are offered, and only the T&L one transforms in hardware', ()=>{
    const root = ddrawObject();
    const d3d = createDirect3D7(root);
    const devices = d3d.enumDevices();

    assert.deepEqual(devices.map(device=>device.id),
        [DEVICE_IDS.RGB, DEVICE_IDS.HAL, DEVICE_IDS.TNLHAL]);
    assert.equal(devices[0].caps.devCaps & D3DDEVCAPS_HWRASTERIZATION, 0,
        'RGB rasterises in software');
    assert.equal(devices[1].caps.devCaps & D3DDEVCAPS_HWRASTERIZATION, D3DDEVCAPS_HWRASTERIZATION);
    assert.deepEqual(
        devices.map(device=>(device.caps.devCaps & D3DDEVCAPS_HWTRANSFORMANDLIGHT) !== 0),
        [false, false, true]);
    for (const device of devices)
    {
        assert.equal(device.caps.deviceGuid, device.id);
    }
    assert.equal(root.release('IDirectDraw7'), 0);
    assert.ok(root.destroyed);
});

test('a device is created on a 3D surface in video memory, and on nothing else', ()=>{
    const root = ddrawObject();
    const d3d = createDirect3D7(root);
    const target = surface(root);

    assert.equal(d3d.createDevice(DEVICE_IDS.REF, target).hr, DDERR_NOTFOUND,
        'no reference rasteriser');
    assert.equal(d3d.createDevice(DEVICE_IDS.NULL, target).hr, DDERR_NOTFOUND);
    assert.equal(d3d.createDevice('{00000000-0000-0000-0000-000000000000}', target).hr,
        DDERR_NOTFOUND);
    assert.equal(d3d.createDevice(DEVICE_IDS.HAL, null).hr, DDERR_INVALIDPARAMS);

    const plain = surface(root, { caps: DDSCAPS_OFFSCREENPLAIN });
    assert.equal(d3d.createDevice(DEVICE_IDS.HAL, plain).hr, DDERR_INVALIDCAPS,
        'not a 3D device target');
    const system = surface(root,
        { caps: DDSCAPS_3DDEVICE | DDSCAPS_OFFSCREENPLAIN | DDSCAPS_SYSTEMMEMORY });
    assert.equal(d3d.createDevice(DEVICE_IDS.TNLHAL, system).hr, D3DERR_SURFACENOTINVIDMEM);
    assert.equal(plain.release(), 0);
    assert.equal(system.release(), 0);

    const before = root.refCount('IDirectDraw7');
    const made = d3d.createDevice(DEVICE_IDS.HAL, target);
    assert.equal(made.hr, D3D_OK);
    assert.equal(made.device.refCount, 1);
    assert.equal(target.refCount, 2, 'the device holds its target');
    assert.equal(root.refCount('IDirectDraw7'), before + 1, 'and the object that made it');
    assert.equal(made.device.description.id, DEVICE_IDS.HAL);

    assert.equal(made.device.addRef(), 2);
    assert.equal(made.device.release(), 1);
    assert.equal(made.device.release(), 0);
    assert.equal(target.refCount, 1, 'the target came back');
    assert.equal(root.refCount('IDirectDraw7'), before);
    assert.equal(target.release(), 0);
    assert.equal(root.release('IDirectDraw7'), 0);
    assert.ok(root.destroyed);
});

// --- the scene ---

test('the scene is a pair, and a draw outside it is drawn all the same', ()=>{
    const f = fixture();
    const { device } = f;
    const triangle = new Uint8Array(20 * 3);

    assert.equal(device.EndScene(), D3DERR_SCENE_NOT_IN_SCENE);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, FVF_TL, triangle, 3), D3D_OK,
        'Wine\'s test_draw_primitive draws before any BeginScene');
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.BeginScene(), D3DERR_SCENE_IN_SCENE);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, FVF_TL, triangle, 3), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK, 'the refused begin did not count');
    // Indices into no vertices draw nothing and succeed, a null array too.
    const indices = new Uint8Array(8);
    assert.equal(device.DrawIndexedPrimitive(D3DPT.TRIANGLESTRIP, FVF_TL, new Uint8Array(0), 0,
        indices, 4), D3D_OK);
    assert.equal(device.DrawIndexedPrimitive(D3DPT.TRIANGLESTRIP, FVF_TL,
        /** @type {any} */ (null), 0, indices, 4), D3D_OK);
    assert.equal(device.EndScene(), D3DERR_SCENE_NOT_IN_SCENE);

    releaseAll(f);
});

// --- state ---

test('a fresh device answers every D3D7 render state and nothing newer', ()=>{
    const f = fixture();
    const { device } = f;
    /** @type {{ value?: number }} */
    const out = {};

    for (const [name, state] of Object.entries(D3DRENDERSTATE))
    {
        assert.ok(state <= D3DRENDERSTATE_MAX, `${name} is a D3D7 state`);
        if (name === 'TEXTUREHANDLE' || name === 'TEXTUREMAPBLEND')
        {
            // Wine's ddraw7 test_set_render_state: the earlier interfaces'
            // texture states are refused here, and the value left alone.
            const left = { value: 0xdeadbeef };
            assert.equal(device.SetRenderState(state, 0), DDERR_INVALIDPARAMS, name);
            assert.equal(device.GetRenderState(state, left), DDERR_INVALIDPARAMS, name);
            assert.equal(left.value, 0xdeadbeef);
            continue;
        }
        assert.equal(device.GetRenderState(state, out), D3D_OK, name);
    }
    assert.equal(device.GetRenderState(154, out), DDERR_INVALIDPARAMS, 'POINTSIZE is D3D8');
    assert.equal(device.SetRenderState(154, 1), DDERR_INVALIDPARAMS);

    assert.equal(device.GetRenderState(D3DRENDERSTATE.ZENABLE, out), D3D_OK);
    assert.equal(out.value, D3DZB.FALSE, 'no depth buffer is attached');

    assert.equal(device.SetRenderState(D3DRENDERSTATE.CULLMODE, 2), D3D_OK);
    assert.equal(device.GetRenderState(D3DRENDERSTATE.CULLMODE, out), D3D_OK);
    assert.equal(out.value, 2);
    assert.equal(device.SetRenderState(D3DRENDERSTATE.FOGSTART, floatToDword(0.25)), D3D_OK);
    assert.equal(device.GetRenderState(D3DRENDERSTATE.FOGSTART, out), D3D_OK);
    assert.equal(out.value, floatToDword(0.25), 'a float state is its bit pattern');

    releaseAll(f);
});

test('a 24-bit z-buffer is one the renderer takes, held in 32 bits', ()=>{
    const root = ddrawObject();
    const depth = surface(root, { caps: DDSCAPS_ZBUFFER, zBufferBitDepth: 24 });
    assert.equal(d3dFormatOf(depth.pixelFormat), D3DFMT.D24X8);
});

test('a depth buffer attached at creation turns the depth test on', ()=>{
    const root = ddrawObject();
    const d3d = createDirect3D7(root);
    const target = surface(root);
    const depth = surface(root, { caps: DDSCAPS_ZBUFFER, zBufferBitDepth: 16 });
    assert.equal(target.addAttachedSurface(depth), D3D_OK);
    assert.equal(d3dFormatOf(depth.pixelFormat), D3DFMT.D16);

    const made = d3d.createDevice(DEVICE_IDS.HAL, target);
    assert.equal(made.hr, D3D_OK);
    /** @type {{ value?: number }} */
    const out = {};
    assert.equal(made.device.GetRenderState(D3DRENDERSTATE.ZENABLE, out), D3D_OK);
    assert.equal(out.value, D3DZB.TRUE);
    assert.equal(made.device.Clear(0, null, D3DCLEAR.ZBUFFER, 0, 1, 0), D3D_OK);

    assert.equal(made.device.release(), 0);
    assert.equal(target.deleteAttachedSurface(depth), D3D_OK);
    assert.equal(depth.release(), 0);
    assert.equal(target.release(), 0);
    assert.equal(root.release('IDirectDraw7'), 0);
    assert.ok(root.destroyed);
});

test('lights start empty, and enabling one brings it into existence', ()=>{
    const f = fixture();
    const { device } = f;
    /** @type {{ light?: any }} */
    const out = {};
    /** @type {{ enabled?: boolean }} */
    const enabled = {};

    assert.equal(device.GetLight(0, out), DDERR_INVALIDPARAMS);
    assert.equal(device.GetLightEnable(0, enabled), DDERR_INVALIDPARAMS);
    assert.equal(device.LightEnable(3, true), D3D_OK);
    assert.equal(device.GetLight(3, out), D3D_OK, 'enabling made it');
    assert.equal(device.GetLightEnable(3, enabled), D3D_OK);
    assert.equal(enabled.enabled, true);

    const light = { ...out.light, Range: 42 };
    assert.equal(device.SetLight(5, light), D3D_OK);
    light.Range = 1;
    assert.equal(device.GetLight(5, out), D3D_OK);
    assert.equal(out.light.Range, 42, 'the device kept its own copy');
    assert.equal(device.GetLightEnable(5, enabled), D3D_OK);
    assert.equal(enabled.enabled, false, 'writing does not enable');

    releaseAll(f);
});

test('the world matrix is one here and 256 in D3D8, and a multiply composes in order', ()=>{
    const f = fixture();
    const { device } = f;
    /** @type {{ matrix?: Float32Array }} */
    const out = {};
    const translate = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1];
    const scale = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];

    assert.equal(device.GetTransform(D3DTRANSFORMSTATE.WORLD, out), D3D_OK);
    assert.deepEqual([...(out.matrix ?? [])], IDENTITY);
    // D3D8 numbers the world matrix 256; this version does not know that
    // number, and a program that used it would be a D3D8 program.
    assert.equal(device.SetTransform(256, translate), DDERR_INVALIDPARAMS);
    assert.equal(device.SetTransform(D3DTRANSFORMSTATE.WORLD, translate), D3D_OK);
    assert.equal(device.GetTransform(D3DTRANSFORMSTATE.WORLD, out), D3D_OK);
    assert.deepEqual([...(out.matrix ?? [])], translate);

    for (const type of [D3DTRANSFORMSTATE.VIEW, D3DTRANSFORMSTATE.PROJECTION])
    {
        assert.equal(device.SetTransform(type, scale), D3D_OK);
        assert.equal(device.GetTransform(type, out), D3D_OK);
        assert.deepEqual([...(out.matrix ?? [])], scale);
    }

    // World is translate; multiplying by scale is scale then translate, the
    // given matrix times the one there (Wine's multiply_matrix(mat, mat,
    // matrix)), so the translation stays at five. The other order doubles it.
    assert.equal(device.MultiplyTransform(D3DTRANSFORMSTATE.WORLD, scale), D3D_OK);
    assert.equal(device.GetTransform(D3DTRANSFORMSTATE.WORLD, out), D3D_OK);
    assert.equal(out.matrix?.[12], 5);
    assert.equal(out.matrix?.[0], 2, 'and the scale is kept');

    assert.equal(device.SetTransform(7, IDENTITY), DDERR_INVALIDPARAMS, 'not a transform');
    assert.equal(device.GetTransform(7, out), DDERR_INVALIDPARAMS);
    assert.equal(device.SetTransform(D3DTRANSFORMSTATE.VIEW, IDENTITY.slice(0, 15)),
        DDERR_INVALIDPARAMS);

    releaseAll(f);
});

test('the viewport is the target until told otherwise, and follows a target change', ()=>{
    const f = fixture();
    const { device, root } = f;
    /** @type {{ viewport?: any }} */
    const out = {};

    assert.equal(device.GetViewport(out), D3D_OK);
    assert.deepEqual(out.viewport, { X: 0, Y: 0, Width: 8, Height: 8, MinZ: 0, MaxZ: 1 });
    assert.equal(device.SetViewport({ X: 4, Y: 4, Width: 8, Height: 8, MinZ: 0, MaxZ: 1 }),
        DDERR_INVALIDPARAMS, 'outside the target');
    assert.equal(device.SetViewport({ X: 2, Y: 2, Width: 4, Height: 4, MinZ: 0, MaxZ: 1 }),
        D3D_OK);

    const wider = surface(root, { width: 16, height: 8 });
    assert.equal(device.SetRenderTarget(wider), D3D_OK);
    assert.equal(wider.refCount, 2, 'the new target is held');
    assert.equal(f.target.refCount, 1, 'and the old one let go');
    assert.equal(device.GetViewport(out), D3D_OK);
    assert.deepEqual(out.viewport, { X: 0, Y: 0, Width: 16, Height: 8, MinZ: 0, MaxZ: 1 });

    /** @type {{ surface?: any }} */
    const held = {};
    assert.equal(device.GetRenderTarget(held), D3D_OK);
    assert.equal(held.surface, wider);
    assert.equal(wider.refCount, 3);
    assert.equal(held.surface.release(), 2);

    assert.equal(device.SetRenderTarget(f.target), D3D_OK);
    assert.equal(wider.release(), 0);
    releaseAll(f);
});

test('stage zero modulates by default and the stage states stop at D3D7\'s last', ()=>{
    const f = fixture();
    const { device } = f;
    /** @type {{ value?: number }} */
    const out = {};

    assert.equal(device.GetTextureStageState(0, D3DTSS.COLOROP, out), D3D_OK);
    assert.equal(out.value, D3DTOP.MODULATE);
    assert.equal(device.GetTextureStageState(1, D3DTSS.COLOROP, out), D3D_OK);
    assert.equal(out.value, D3DTOP.DISABLE);
    assert.equal(device.SetTextureStageState(0, 25, 1), DDERR_INVALIDPARAMS, 'ADDRESSW is D3D8');
    assert.equal(device.GetTextureStageState(0, 25, out), DDERR_INVALIDPARAMS);
    // D3DTSS_ADDRESS (12) is both directions at once, U's value read back.
    assert.equal(device.SetTextureStageState(1, 12, 3), D3D_OK, 'ADDRESS sets U and V');
    assert.equal(device.GetTextureStageState(1, D3DTSS.ADDRESSU, out), D3D_OK);
    assert.equal(out.value, 3);
    assert.equal(device.GetTextureStageState(1, D3DTSS.ADDRESSV, out), D3D_OK);
    assert.equal(out.value, 3);
    assert.equal(device.GetTextureStageState(1, 12, out), D3D_OK);
    assert.equal(out.value, 3);
    assert.equal(device.SetTextureStageState(2, D3DTSS.COLOROP, D3DTOP.ADD), D3D_OK);
    assert.equal(device.GetTextureStageState(2, D3DTSS.COLOROP, out), D3D_OK);
    assert.equal(out.value, D3DTOP.ADD);

    releaseAll(f);
});

test('ComputeSphereVisibility names the planes a sphere crosses and the ones it lies beyond', ()=>{
    // Wine's ddraw7 test_compute_sphere_visibility, its table and its answers.
    const f = fixture();
    const { device } = f;
    const proj1 = [1.810660, 0, 0, 0, 0, 2.414213, 0, 0, 0, 0, 1.020408, 1, 0, 0, -0.102041, 0];
    const proj2 = [10, 0, 0, 0, 0, 10, 0, 0, 0, 0, 10, 0, 0, 0, 0, 1];
    const view1 = [1, 0, 0, 0, 0, 0.768221, -0.640185, 0, -0, 0.640185, 0.768221, 0,
        -14.852037, 9.857489, 11.600972, 1];
    const CLIPPLANEENABLE = 152;
    /** @type {[number[], number[], number[][], number[], number, number[]][]} */
    const cases = [
        [view1, proj1, [[11.461533, -4.761727, -1.171646]], [38.252632], 0, [0x3f]],
        [view1, proj1, [[-3.515620, -1.560661, -12.464638], [14.290396, -2.981143, -24.311312],
            [1.461626, -6.093709, -13.901010]], [4.354097, 12.500704, 17.251318], 0,
        [0x103d, 0x3f, 0x3f]],
        [IDENTITY, proj2, [[0, 0, 0.05]], [0.04], 0, [0]],
        [IDENTITY, IDENTITY, [[0, 0, 0.5]], [0.5], 0, [0]],
        [IDENTITY, IDENTITY, [[0, 0, 0]], [0], 0, [0]],
        [IDENTITY, IDENTITY, [[-1, -1, 0.5]], [0.25], 0, [0x9]],
        [IDENTITY, IDENTITY, [[-20, 0, 0.5]], [3], 0, [0x103d]],
        [IDENTITY, IDENTITY, [[20, 0, 0.5]], [3], 0, [0x203e]],
        [IDENTITY, IDENTITY, [[0, -20, 0.5]], [3], 0, [0x803b]],
        [IDENTITY, IDENTITY, [[0, 20, 0.5]], [3], 0, [0x4037]],
        [IDENTITY, IDENTITY, [[0, 0, -20]], [3], 0, [0x1001f]],
        [IDENTITY, IDENTITY, [[0, 0, 20]], [3], 0, [0x2002f]],
        [IDENTITY, IDENTITY, [[0, 0, 0]], [5], 1, [0x7f]],
        [IDENTITY, IDENTITY, [[-0.5, 0, 0]], [5], 1, [0x7f]],
        [IDENTITY, IDENTITY, [[-0.5, 0, 0]], [1], 1, [0x51]],
        [IDENTITY, IDENTITY, [[-2.5, 0, 0]], [1], 1, [0x41051]],
    ];
    assert.equal(device.SetClipPlane(0, [1, 0, 0, 0.5]), D3D_OK);
    assert.equal(device.SetTransform(D3DTRANSFORMSTATE.WORLD, IDENTITY), D3D_OK);
    cases.forEach(([view, projection, centers, radii, planes, expected], index)=>{
        assert.equal(device.SetTransform(D3DTRANSFORMSTATE.VIEW, view), D3D_OK);
        assert.equal(device.SetTransform(D3DTRANSFORMSTATE.PROJECTION, projection), D3D_OK);
        assert.equal(device.SetRenderState(CLIPPLANEENABLE, planes), D3D_OK);
        /** @type {{ results?: number[] }} */
        const out = {};
        assert.equal(device.ComputeSphereVisibility(centers, radii, out), D3D_OK);
        assert.deepEqual(out.results, expected, `case ${index}`);
    });

    // Wine's ddraw4 test_compute_sphere_visibility: the same spheres in D3DVIS
    // bits, a sphere touching a side crossing it. Its cases 2 and 5 are left
    // out: Windows answers them otherwise (decisions.md A93).
    assert.equal(device.SetRenderState(CLIPPLANEENABLE, 0), D3D_OK);
    /** @type {[number[], number[], number[][], number[], number[]][]} */
    const third = [
        [view1, proj1, [[11.461533, -4.761727, -1.171646]], [38.252632], [0x1555]],
        [view1, proj1, [[-3.515620, -1.560661, -12.464638], [14.290396, -2.981143, -24.311312],
            [1.461626, -6.093709, -13.901010]], [4.354097, 12.500704, 17.251318],
        [0x154a, 0x1555, 0x1555]],
        [IDENTITY, IDENTITY, [[0, 0, 0.5]], [0.5], [0x1401]],
        [IDENTITY, IDENTITY, [[0, 0, 0]], [0], [0x401]],
        [IDENTITY, IDENTITY, [[-20, 0, 0.5]], [3], [0x154a]],
        [IDENTITY, IDENTITY, [[20, 0, 0.5]], [3], [0x1562]],
        [IDENTITY, IDENTITY, [[0, -20, 0.5]], [3], [0x1616]],
        [IDENTITY, IDENTITY, [[0, 20, 0.5]], [3], [0x1496]],
        [IDENTITY, IDENTITY, [[0, 0, -20]], [3], [0x956]],
        [IDENTITY, IDENTITY, [[0, 0, 20]], [3], [0x2156]],
    ];
    third.forEach(([view, projection, centers, radii, expected], index)=>{
        assert.equal(device.SetTransform(D3DTRANSFORMSTATE.VIEW, view), D3D_OK);
        assert.equal(device.SetTransform(D3DTRANSFORMSTATE.PROJECTION, projection), D3D_OK);
        /** @type {{ results?: number[] }} */
        const out = {};
        assert.equal(device.ComputeSphereVisibility(centers, radii, out, true), D3D_OK);
        assert.deepEqual(out.results, expected, `third generation, case ${index}`);
    });

    releaseAll(f);
});

test('ValidateDevice refuses a stage the combiner does not draw', ()=>{
    const f = fixture();
    const { device } = f;
    /** @type {{ passes?: number }} */
    const out = {};
    assert.equal(device.ValidateDevice(out), D3D_OK);
    assert.equal(out.passes, 1);
    assert.equal(device.SetTextureStageState(0, D3DTSS.COLORARG1, 5), D3D_OK, 'D3DTA_TEMP');
    /** @type {{ passes?: number }} */
    const refused = {};
    assert.equal(device.ValidateDevice(refused), 0x8876081a, 'D3DERR_UNSUPPORTEDCOLORARG');
    assert.equal(refused.passes, undefined);
    assert.equal(device.SetTextureStageState(0, D3DTSS.COLORARG1, D3DTA.TEXTURE), D3D_OK);

    // Read in this version's numbering: D3DTFP_LINEAR is drawn, D3DTFG_FLATCUBIC is not.
    assert.equal(device.SetTextureStageState(0, D3DTSS.MIPFILTER, 3), D3D_OK);
    assert.equal(device.ValidateDevice(out), D3D_OK);
    assert.equal(device.SetTextureStageState(0, D3DTSS.MAGFILTER, 3), D3D_OK);
    assert.equal(device.ValidateDevice(refused), 0x88760822, 'D3DERR_UNSUPPORTEDTEXTUREFILTER');

    releaseAll(f);
});

test('binding a texture owns it, in this version', ()=>{
    const f = fixture();
    const { device, root } = f;
    const first = surface(root, { caps: DDSCAPS_TEXTURE | DDSCAPS_OFFSCREENPLAIN });
    const second = surface(root, { caps: DDSCAPS_TEXTURE | DDSCAPS_OFFSCREENPLAIN });
    /** @type {{ surface?: any }} */
    const out = {};

    assert.equal(device.SetTexture(0, first), D3D_OK);
    assert.equal(first.refCount, 2, 'bound is held');
    assert.equal(device.GetTexture(0, out), D3D_OK);
    assert.equal(out.surface, first);
    assert.equal(first.refCount, 3, 'and read back adds one');
    assert.equal(first.release(), 2);

    assert.equal(device.SetTexture(0, second), D3D_OK);
    assert.equal(first.refCount, 1, 'replaced gives it back');
    assert.equal(second.refCount, 2);
    assert.equal(device.SetTexture(0, null), D3D_OK);
    assert.equal(second.refCount, 1, 'unbound gives it back');

    assert.equal(device.SetTexture(1, first), D3D_OK);
    assert.equal(device.release(), 0, 'the device drops what it holds');
    assert.equal(first.refCount, 1);
    assert.equal(first.release(), 0);
    assert.equal(second.release(), 0);
    assert.equal(f.target.release(), 0);
    assert.equal(root.release('IDirectDraw7'), 0);
    assert.ok(root.destroyed);
});

test('a state block holds what was set between begin and end, and can be refreshed', ()=>{
    const f = fixture();
    const { device } = f;
    /** @type {{ handle?: number }} */
    const out = {};
    /** @type {{ value?: number }} */
    const value = {};
    const cull = D3DRENDERSTATE.CULLMODE;
    const shade = D3DRENDERSTATE.SHADEMODE;

    assert.equal(device.EndStateBlock(out), D3DERR_NOTINBEGINSTATEBLOCK);
    assert.equal(device.BeginStateBlock(), D3D_OK);
    assert.equal(device.BeginStateBlock(), D3DERR_INBEGINSTATEBLOCK);
    assert.equal(device.SetRenderState(cull, 1), D3D_OK);
    assert.equal(device.EndStateBlock(out), D3D_OK);
    const block = /** @type {number} */ (out.handle);

    assert.equal(device.SetRenderState(cull, 2), D3D_OK);
    assert.equal(device.SetRenderState(shade, 1), D3D_OK);
    assert.equal(device.ApplyStateBlock(block), D3D_OK);
    assert.equal(device.GetRenderState(cull, value), D3D_OK);
    assert.equal(value.value, 1, 'the recorded state came back');
    assert.equal(device.GetRenderState(shade, value), D3D_OK);
    assert.equal(value.value, 1, 'a state outside the block is left alone');

    assert.equal(device.SetRenderState(cull, 3), D3D_OK);
    assert.equal(device.CaptureStateBlock(block), D3D_OK);
    assert.equal(device.SetRenderState(cull, 2), D3D_OK);
    assert.equal(device.ApplyStateBlock(block), D3D_OK);
    assert.equal(device.GetRenderState(cull, value), D3D_OK);
    assert.equal(value.value, 3, 'capture took the value of the moment');

    assert.equal(device.DeleteStateBlock(block), D3D_OK);
    assert.equal(device.DeleteStateBlock(block), D3DERR_INVALIDSTATEBLOCK);
    assert.equal(device.ApplyStateBlock(99), D3DERR_INVALIDSTATEBLOCK);

    assert.equal(device.CreateStateBlock(D3DSBT.ALL, out), D3D_OK);
    const all = /** @type {number} */ (out.handle);
    assert.equal(device.SetRenderState(cull, 1), D3D_OK);
    assert.equal(device.ApplyStateBlock(all), D3D_OK);
    assert.equal(device.GetRenderState(cull, value), D3D_OK);
    assert.equal(value.value, 3, 'everything as it stood when the block was made');
    assert.equal(device.CreateStateBlock(9, out), DDERR_INVALIDPARAMS);

    releaseAll(f);
});

test('what is set while a block is recorded goes into the block, not the device', ()=>{
    // Wine's ddraw7 test_begin_end_state_block.
    const f = fixture();
    const { device } = f;
    /** @type {{ handle?: number }} */
    const out = {};
    /** @type {{ value?: number }} */
    const value = {};
    /** @type {{ value?: number }} */
    const stage = {};
    /** @type {{ matrix?: Float32Array }} */
    const world = {};
    const lighting = D3DRENDERSTATE.LIGHTING;
    const scaled = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];

    assert.equal(device.GetRenderState(lighting, value), D3D_OK);
    assert.equal(value.value, 1, 'lighting starts on');
    assert.equal(device.BeginStateBlock(), D3D_OK);
    assert.equal(device.SetRenderState(lighting, 0), D3D_OK);
    assert.equal(device.SetTextureStageState(0, D3DTSS.COLOROP, D3DTOP.ADD), D3D_OK);
    assert.equal(device.SetTransform(D3DTRANSFORMSTATE.WORLD, scaled), D3D_OK);
    assert.equal(device.GetRenderState(lighting, value), D3D_OK);
    assert.equal(value.value, 1, 'the device kept its own');
    assert.equal(device.GetTextureStageState(0, D3DTSS.COLOROP, stage), D3D_OK);
    assert.equal(stage.value, D3DTOP.MODULATE);
    assert.equal(device.GetTransform(D3DTRANSFORMSTATE.WORLD, world), D3D_OK);
    assert.equal(world.matrix?.[0], 1);
    assert.equal(device.EndStateBlock(out), D3D_OK);
    const block = /** @type {number} */ (out.handle);
    assert.equal(device.GetRenderState(lighting, value), D3D_OK);
    assert.equal(value.value, 1, 'and keeps it after the end');

    assert.equal(device.BeginStateBlock(), D3D_OK);
    assert.equal(device.ApplyStateBlock(block), D3DERR_INBEGINSTATEBLOCK);
    assert.equal(device.CaptureStateBlock(block), D3DERR_INBEGINSTATEBLOCK);
    assert.equal(device.CreateStateBlock(D3DSBT.ALL, out), D3DERR_INBEGINSTATEBLOCK);
    assert.equal(device.EndStateBlock(out), D3D_OK);

    assert.equal(device.ApplyStateBlock(block), D3D_OK);
    assert.equal(device.GetRenderState(lighting, value), D3D_OK);
    assert.equal(value.value, 0, 'the block applied');
    assert.equal(device.GetTextureStageState(0, D3DTSS.COLOROP, stage), D3D_OK);
    assert.equal(stage.value, D3DTOP.ADD);
    assert.equal(device.GetTransform(D3DTRANSFORMSTATE.WORLD, world), D3D_OK);
    assert.equal(world.matrix?.[0], 2);

    releaseAll(f);
});

test('a vertex buffer gives its guest memory back with its last reference', ()=>{
    /** @type {number[]} */
    const freed = [];
    const root = ddrawObject({
        allocate: ()=>0x200000,
        free: (/** @type {number} */ address)=>{
            freed.push(address);
        },
    });
    const d3d = createDirect3D7(root);
    const made = d3d.createVertexBuffer({ caps: 0, fvf: FVF_TL, numVertices: 4 });
    assert.equal(made.hr, D3D_OK);
    assert.equal(made.buffer.base, 0x200000);
    made.buffer.addRef();
    made.buffer.release();
    assert.deepEqual(freed, [], 'not while a reference is held');
    assert.equal(made.buffer.release(), 0);
    assert.deepEqual(freed, [0x200000]);
    assert.equal(root.release('IDirectDraw7'), 0);
});

test('a vertex buffer is a guest allocation with one lock at a time', ()=>{
    const f = fixture();
    const { d3d, device, root } = f;

    assert.equal(d3d.createVertexBuffer({ caps: 0, fvf: FVF.DIFFUSE, numVertices: 4 }).hr,
        D3DERR_INVALIDVERTEXFORMAT, 'no position');
    assert.equal(d3d.createVertexBuffer({ caps: 0, fvf: FVF_TL, numVertices: 0 }).hr,
        DDERR_INVALIDPARAMS);

    const before = root.refCount('IDirectDraw7');
    const made = d3d.createVertexBuffer({ caps: 0, fvf: FVF_TL, numVertices: 4 });
    assert.equal(made.hr, D3D_OK);
    const buffer = made.buffer;
    assert.equal(root.refCount('IDirectDraw7'), before + 1, 'a buffer holds the object');

    /** @type {{ data?: number, size?: number }} */
    const lock = {};
    assert.equal(buffer.Unlock(), D3D_OK, 'unlocking an unlocked buffer is nothing');
    assert.equal(buffer.Lock(0, lock), D3D_OK);
    assert.equal(lock.data, buffer.base);
    assert.equal(lock.size, 4 * 20);
    /** @type {{ data?: number, size?: number }} */
    const again = {};
    assert.equal(buffer.Lock(0, again), D3D_OK, 'locked again (test_process_vertices)');
    assert.deepEqual(again, lock, 'the same memory');
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitiveVB(D3DPT.TRIANGLELIST, buffer, 0, 3), DDERR_INVALIDPARAMS,
        'a locked buffer cannot be drawn');
    assert.equal(buffer.Unlock(), D3D_OK);
    assert.equal(device.DrawPrimitiveVB(D3DPT.TRIANGLELIST, buffer, 3, 3), DDERR_INVALIDPARAMS,
        'past its end');
    assert.equal(device.DrawPrimitiveVB(D3DPT.TRIANGLELIST, buffer, 0, 3), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);

    /** @type {{ desc?: any }} */
    const desc = {};
    assert.equal(buffer.GetVertexBufferDesc(desc), D3D_OK);
    assert.equal((desc.desc.caps & D3DVBCAPS_OPTIMIZED) >>> 0, 0);
    assert.equal(buffer.Optimize(), D3D_OK);
    assert.equal(buffer.GetVertexBufferDesc(desc), D3D_OK);
    assert.equal((desc.desc.caps & D3DVBCAPS_OPTIMIZED) >>> 0, D3DVBCAPS_OPTIMIZED);
    assert.equal(desc.desc.numVertices, 4);

    assert.equal(buffer.release(), 0);
    assert.equal(root.refCount('IDirectDraw7'), before, 'and gives it back');
    releaseAll(f);
});

test('Clear needs something to clear and a depth buffer to clear depth', ()=>{
    const f = fixture();
    const { device } = f;

    assert.equal(device.Clear(0, null, 0, 0, 1, 0), DDERR_INVALIDPARAMS);
    assert.equal(device.Clear(0, null, D3DCLEAR.ZBUFFER, 0, 1, 0), DDERR_INVALIDPARAMS,
        'no depth attached');
    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, 0x00123456, 1, 0), D3D_OK);

    releaseAll(f);
});

test('a Clear given a count and no rectangles clears the whole target (test_clear_rect_count)',
    async()=>{
        const { device, gpu, root, target } = recorded();
        assert.equal(device.Clear(2, null, D3DCLEAR.TARGET, 0x0000ff00, 1, 0), D3D_OK);
        device.present(target.buffer);
        await device.idle();
        const pass = gpu.of('beginRenderPass')[0].descriptor.colorAttachments[0];
        assert.equal(pass.loadOp, 'clear', 'all of it, as a pass\'s clear');
        assert.deepEqual([pass.clearValue.r, pass.clearValue.g, pass.clearValue.b], [0, 1, 0]);
        assert.equal(device.release(), 0);
        assert.equal(target.release(), 0);
        assert.equal(root.release('IDirectDraw7'), 0);
    });

test('the material, clip status and clip planes read back as copies', ()=>{
    const f = fixture();
    const { device } = f;
    const material = {
        Diffuse: { r: 1, g: 0.5, b: 0.25, a: 1 },
        Ambient: { r: 0, g: 0, b: 0, a: 0 },
        Specular: { r: 0, g: 0, b: 0, a: 0 },
        Emissive: { r: 0.1, g: 0.2, b: 0.3, a: 0 },
        Power: 8,
    };
    /** @type {{ material?: any }} */
    const out = {};
    assert.equal(device.SetMaterial(material), D3D_OK);
    material.Power = 16;
    assert.equal(device.GetMaterial(out), D3D_OK);
    assert.equal(out.material.Power, 8);
    assert.deepEqual(out.material.Emissive, { r: 0.1, g: 0.2, b: 0.3, a: 0 });
    // A material of no power: GetMaterial and drawing say zero, ProcessVertices
    // highlights by the last power that was not (test_specular_lighting).
    assert.equal(device.SetMaterial({ ...material, Power: 0 }), D3D_OK);
    assert.equal(device.GetMaterial(out), D3D_OK);
    assert.equal(out.material.Power, 0);
    assert.equal(device.processingState().material.Power, 8);

    const status = { flags: 1, status: 0, extents: [1, 2, 3, 4, 5, 6] };
    /** @type {{ status?: any }} */
    const clip = {};
    assert.equal(device.SetClipStatus(status), D3D_OK);
    status.extents[0] = 9;
    assert.equal(device.GetClipStatus(clip), D3D_OK);
    assert.deepEqual(clip.status.extents, [1, 2, 3, 4, 5, 6]);

    /** @type {{ plane?: number[] }} */
    const plane = {};
    assert.equal(device.SetClipPlane(32, [0, 0, 1, 0]), DDERR_INVALIDPARAMS);
    assert.equal(device.SetClipPlane(1, [0, 0, 1, -2]), D3D_OK);
    assert.equal(device.GetClipPlane(1, plane), D3D_OK);
    assert.deepEqual(plane.plane, [0, 0, 1, -2]);
    assert.equal(device.GetClipPlane(0, plane), D3D_OK);
    assert.deepEqual(plane.plane, [0, 0, 0, 0], 'an unset plane is zero');

    releaseAll(f);
});

// --- recorded: what the GPU was asked to do ---

/**
 * A device over the recording GPU, with guest memory the test owns.
 *
 * @param {{ writable?: boolean, driverRules?: 'legacy' | 'current',
 *     divergence?: (api: string, detail: string, severity?: 'loss') => any,
 *     reuse?: boolean }} [options]
 *     Whether the device may write guest memory, the renderer's rules, where it diverges, and
 *     whether the heap hands a freed address out again.
 */
function recorded(options = {}){
    const gpu = createFakeDevice();
    const backend = createBackend({
        device: gpu.device,
        queue: gpu.queue,
        presentTo: ()=>{},
        now: ()=>0,
    });
    const ram = new Uint8Array(1 << 20);
    let next = 0x1000;
    /** @type {number[]} */
    const claimed = [];
    /** @type {number[]} */
    const released = [];
    /** @type {number[]} addresses given back, handed out again first */
    const given = [];
    const root = ddrawObject({
        allocate: bytes=>{
            if (options.reuse && given.length > 0)
            {
                return /** @type {number} */ (given.pop());
            }
            const at = next;
            next += bytes + 0xfff & ~0xfff;
            return at;
        },
        free: address=>given.push(address),
    });
    const d3d = createDirect3D7(root, {
        backend,
        readMemory: (address, length)=>ram.slice(address, address + length),
        ...(options.writable
            ? { writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>
                ram.set(bytes, address) }
            : {}),
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
        ...(options.driverRules ? { driverRules: options.driverRules } : {}),
        ...(options.divergence ? { divergence: options.divergence } : {}),
        presenter: {
            claim: buffer=>claimed.push(buffer),
            release: buffer=>released.push(buffer),
        },
    });
    const target = surface(root);
    const made = d3d.createDevice(DEVICE_IDS.TNLHAL, target);
    assert.equal(made.hr, D3D_OK);
    return { gpu, ram, root, d3d, target, device: made.device, claimed, released };
}

/** A pre-transformed vertex: x, y, z, rhw, colour, and a coordinate pair if asked. */
function vertex(/** @type {number} */ x, /** @type {number} */ y, /** @type {number[]} */ uv){
    const bytes = new DataView(new ArrayBuffer(uv ? 28 : 20));
    bytes.setFloat32(0, x, true);
    bytes.setFloat32(4, y, true);
    bytes.setFloat32(8, 0.5, true);
    bytes.setFloat32(12, 1, true);
    bytes.setUint32(16, 0xffffffff, true);
    if (uv)
    {
        bytes.setFloat32(20, uv[0], true);
        bytes.setFloat32(24, uv[1], true);
    }
    return new Uint8Array(bytes.buffer);
}

/** @param {number[][]} corners @param {boolean} textured */
function vertices(corners, textured){
    const stride = textured ? 28 : 20;
    const out = new Uint8Array(stride * corners.length);
    corners.forEach(([x, y, u, v], index)=>{
        out.set(vertex(x, y, textured ? [u, v] : /** @type {any} */ (null)), index * stride);
    });
    return out;
}

test('recorded: a blended draw adds and writes every channel, as a D3D7 device always does',
    async()=>{
        // BLENDOP and COLORWRITEENABLE are Direct3D 8's: a program of this
        // version can neither set nor read them, but the renderer it draws
        // through reads them, and as zero they were no blend operation and a
        // write mask of nothing -- every draw failed or painted no pixel.
        const f = recorded();
        const { device, gpu, target } = f;
        /** @type {{ value?: number }} */
        const out = {};
        assert.equal(device.GetRenderState(171, out), DDERR_INVALIDPARAMS, 'BLENDOP is D3D8');
        assert.equal(device.SetRenderState(168, 0), DDERR_INVALIDPARAMS,
            'COLORWRITEENABLE is D3D8');
        assert.equal(device.SetRenderState(D3DRENDERSTATE.ALPHABLENDENABLE, 1), D3D_OK);
        assert.equal(device.SetRenderState(D3DRENDERSTATE.SRCBLEND, 5), D3D_OK);
        assert.equal(device.SetRenderState(D3DRENDERSTATE.DESTBLEND, 6), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.DrawPrimitive(D3DPT.TRIANGLESTRIP, FVF_TL,
            vertices([[0, 0], [8, 0], [0, 8], [8, 8]], false), 4), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        device.present(target.buffer);
        await device.idle();

        assert.equal(device.diagnostics().draws, 1);
        assert.equal(gpu.count('draw'), 1);
        const [pipeline] = gpu.of('createRenderPipeline').map(call=>call.descriptor);
        const [colour] = pipeline.fragment.targets;
        assert.equal(colour.writeMask & 7, 7, 'red, green and blue are written');
        assert.deepEqual(colour.blend.color,
            { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' });
        assert.equal(device.release(), 0);
        assert.equal(target.release(), 0);
        assert.equal(f.root.release('IDirectDraw7'), 0);
    });

test('recorded: two devices on one surface draw into one picture, shown through the first and'
    + ' then the one left (test_multiple_devices)', async()=>{
    /** @param {number} devices @returns {Promise<number>} the targets drawn into */
    const drawn = async devices=>{
        const f = recorded({ writable: true });
        const others = Array.from({ length: devices - 1 },
            ()=>f.d3d.createDevice(DEVICE_IDS.TNLHAL, f.target).device);
        for (const one of [f.device, ...others, f.device])
        {
            assert.equal(one.DrawPrimitive(D3DPT.TRIANGLESTRIP, FVF_TL,
                vertices([[0, 0], [8, 0], [0, 8], [8, 8]], false), 4), D3D_OK);
        }
        f.device.present(f.target.buffer);
        await f.device.idle();
        const views = new Set(f.gpu.of('beginRenderPass')
            .map(call=>call.descriptor.colorAttachments[0].view));
        assert.deepEqual(f.claimed, [f.target.buffer], 'one claim on the address');
        if (devices > 1)
        {
            const reading = f.device.ReadBack(f.target);
            assert.notEqual(reading, null, 'the first answers for the picture');
            assert.deepEqual(others.map(one=>one.ReadBack(f.target)), [null], 'and only it');
            await reading;
            assert.equal(f.device.release(), 0);
            assert.deepEqual(f.claimed, [f.target.buffer, f.target.buffer],
                'the first gone, the one left shows it');
            assert.deepEqual(f.released, []);
            for (const one of others)
            {
                assert.equal(one.release(), 0);
            }
            assert.deepEqual(f.released, [f.target.buffer], 'given back with the last');
            assert.equal(f.target.release(), 0);
            assert.equal(f.root.release('IDirectDraw7'), 0);
        }
        else
        {
            releaseAll(f);
        }
        return views.size;
    };
    assert.equal(await drawn(2), await drawn(1), 'as many pictures as one device draws into');
});

test('recorded: a draw and a present are one encoder, one submit, one frame', async()=>{
    const f = recorded();
    const { device, gpu, target } = f;

    assert.deepEqual(f.claimed, [target.buffer], 'the target address is GPU-owned from creation');
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, FVF_TL,
        vertices([[0, 0], [8, 0], [0, 8]], false), 3), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    device.present(target.buffer);
    await device.idle();

    assert.equal(gpu.count('createCommandEncoder'), 1);
    assert.equal(gpu.count('submit'), 1);
    assert.equal(gpu.count('draw'), 1);
    assert.deepEqual(gpu.of('draw')[0].args, [3, 1, 0]);
    const pass = gpu.of('beginRenderPass')[0].descriptor;
    const texture = pass.colorAttachments[0].view.texture.descriptor;
    assert.deepEqual([texture.size.width, texture.size.height], [8, 8]);
    assert.equal(device.diagnostics().draws, 1);

    assert.equal(device.release(), 0);
    assert.deepEqual(f.released, [target.buffer], 'and the claim went with the device');
    assert.equal(target.release(), 0);
    assert.equal(f.root.release('IDirectDraw7'), 0);
    assert.ok(f.root.destroyed);
});

test('recorded: a depth fill of the device\'s depth buffer clears the depth it draws against',
    async()=>{
        // The depth a device draws against lives on the GPU, so a DirectDraw
        // depth fill of that surface reaches it there, not only in memory.
        const f = recorded();
        const { device, gpu, root, target } = f;
        const depth = surface(root, { caps: DDSCAPS_ZBUFFER, zBufferBitDepth: 16 });
        assert.equal(target.addAttachedSurface(depth), D3D_OK);
        const other = surface(root, { caps: DDSCAPS_ZBUFFER, zBufferBitDepth: 16 });

        other.depthFilled(null, 0x1234);
        assert.equal(device.diagnostics().clears, 0, 'a depth buffer the device does not use');
        depth.depthFilled(null, 0x8000);
        assert.equal(device.diagnostics().clears, 1);
        device.present(target.buffer);
        await device.idle();
        const pass = gpu.of('beginRenderPass')[0].descriptor;
        assert.equal(pass.depthStencilAttachment.depthLoadOp, 'clear');
        assert.equal(pass.depthStencilAttachment.depthClearValue, 0x8000 / 0xffff);

        assert.equal(target.deleteAttachedSurface(depth), D3D_OK);
        assert.equal(depth.release(), 0);
        assert.equal(other.release(), 0);
        assert.equal(device.release(), 0);
        assert.equal(target.release(), 0);
        assert.equal(root.release('IDirectDraw7'), 0);
        assert.ok(root.destroyed);
    });

test('recorded: a target made where a depth buffer\'s pixels were is a colour target, not the'
    + ' depth buffer', async()=>{
    // Wine's ddraw7 test_depth_readback and test_viewport: a depth buffer
    // drawn against and released, then a colour target the heap put at its
    // address. The device kept its renderer's view of a surface by that
    // address, and drew into the colour target as the depth buffer it had
    // been -- a pipeline WebGPU refused -- and a lock of it read the depth
    // texture back, which threw.
    const f = recorded({ writable: true, reuse: true });
    const { device, gpu, root, target } = f;
    const depth = surface(root, { caps: DDSCAPS_ZBUFFER, width: 16, height: 16,
        zBufferBitDepth: 16 });
    const colour = surface(root, { width: 16, height: 16 });
    assert.equal(colour.addAttachedSurface(depth), D3D_OK);
    assert.equal(device.SetRenderTarget(colour), D3D_OK);
    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER, 0, 1, 0), D3D_OK);
    assert.equal(device.SetRenderTarget(target), D3D_OK);
    assert.equal(colour.deleteAttachedSurface(depth), D3D_OK);
    const address = depth.buffer;
    assert.equal(depth.release(), 0);
    const next = surface(root, { width: 16, height: 16 });
    assert.equal(next.buffer, address, 'the heap gave the depth buffer\'s pixels out again');
    assert.equal(device.SetRenderTarget(next), D3D_OK);
    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, 0xff00ff00, 1, 0), D3D_OK);
    device.present(target.buffer);
    await device.idle();
    const made = gpu.of('createTexture').filter((/** @type {any} */ call)=>
        call.descriptor.size.width === 16).map((/** @type {any} */ call)=>call.descriptor.format);
    assert.equal(made.filter(format=>!format.startsWith('depth')).length, 2,
        'a colour texture for each colour target');
    assert.deepEqual(gpu.errors, []);

    assert.equal(device.SetRenderTarget(target), D3D_OK);
    assert.equal(next.release(), 0);
    assert.equal(colour.release(), 0);
    assert.equal(device.release(), 0);
    assert.equal(target.release(), 0);
    assert.equal(root.release('IDirectDraw7'), 0);
});

test('recorded: a colour fill of the device\'s target clears it on the GPU, no read-back first',
    async()=>{
        // As Direct3D 9's ColorFill: the target's picture is the GPU's, and a
        // fill read back, filled in memory and taken up again cost a game
        // clearing its target by Blt a wait for the GPU every frame.
        const f = recorded({ writable: true });
        const { device, gpu, root, target } = f;
        const other = surface(root, { caps: DDSCAPS_TEXTURE, pixelFormat: ARGB32 });

        assert.equal(other.colorFilled(null, 0xff00ff00), false,
            'a surface the device does not draw into is filled in memory');
        assert.equal(target.colorFilled(null, 0x00ff0000), true);
        assert.equal(device.diagnostics().clears, 1);
        device.present(target.buffer);
        await device.idle();
        const pass = gpu.of('beginRenderPass')[0].descriptor.colorAttachments[0];
        assert.equal(pass.loadOp, 'clear');
        assert.deepEqual([pass.clearValue.r, pass.clearValue.g, pass.clearValue.b],
            [1, 0, 0], 'the fill, read in the target\'s own format');
        assert.equal(gpu.of('copyTextureToBuffer').length, 0, 'nothing read back for it');

        assert.equal(device.release(), 0);
        assert.equal(other.release(), 0);
        assert.equal(target.release(), 0);
        assert.equal(root.release('IDirectDraw7'), 0);
    });

test('a surface made without DDSCAPS_TEXTURE: Direct3D 7 binds nothing, an earlier device keeps it'
    + ' and only its software rasteriser samples it (test_texture_wrong_caps)', async()=>{
    for (const [id, legacy, keeps, samples] of /** @type {[string, boolean, boolean, boolean][]} */ ([
        [DEVICE_IDS.TNLHAL, false, false, false],
        [DEVICE_IDS.RGB, false, false, false],
        [DEVICE_IDS.HAL, true, true, false],
        [DEVICE_IDS.RGB, true, true, true],
    ]))
    {
        const f = recorded();
        assert.equal(f.device.release(), 0);
        const made = f.d3d.createDevice(id, f.target, { legacy });
        assert.equal(made.hr, D3D_OK);
        const device = made.device;
        const plain = surface(f.root, { caps: DDSCAPS_OFFSCREENPLAIN, width: 2, height: 2,
            pixelFormat: ARGB32 });
        assert.equal(device.SetTexture(0, plain), D3D_OK, `${id} ${legacy}`);
        /** @type {{ surface?: any }} */
        const bound = {};
        assert.equal(device.GetTexture(0, bound), D3D_OK);
        assert.equal(bound.surface, keeps ? plain : null, `${id} ${legacy} keeps it bound`);
        bound.surface?.release();
        assert.equal(device.SetTextureStageState(0, D3DTSS.COLOROP, D3DTOP.SELECTARG1), D3D_OK);
        assert.equal(device.SetTextureStageState(0, D3DTSS.COLORARG1, D3DTA.TEXTURE), D3D_OK);
        const quad = vertices([[0, 0, 0, 0], [8, 0, 1, 0], [0, 8, 0, 1], [8, 8, 1, 1]], true);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.DrawPrimitive(D3DPT.TRIANGLESTRIP, FVF_TL_TEX, quad, 4), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        device.present(f.target.buffer);
        await device.idle();
        assert.equal(f.gpu.count('writeTexture'), samples ? 1 : 0, `${id} ${legacy} samples it`);
        assert.equal(device.release(), 0);
        assert.equal(plain.release(), 0);
        assert.equal(f.target.release(), 0);
    }
});

test('a texture bound as a handle binds it is not held, and is unbound once it is gone'
    + ' (test_texturemapblend)', ()=>{
    const f = recorded();
    const { device, root } = f;
    const texture = surface(root, { caps: DDSCAPS_TEXTURE, width: 2, height: 2,
        pixelFormat: ARGB32 });
    assert.equal(device.SetTexture(0, texture, { unheld: true }), D3D_OK);
    assert.equal(texture.refCount, 1, 'no reference taken');
    /** @type {{ surface?: any }} */
    const bound = {};
    assert.equal(device.GetTexture(0, bound), D3D_OK);
    assert.equal(bound.surface, texture);
    bound.surface.release();
    assert.equal(device.SetTexture(0, texture), D3D_OK);
    assert.equal(texture.refCount, 2, 'bound again as SetTexture binds, it is held');
    assert.equal(device.SetTexture(0, texture, { unheld: true }), D3D_OK);
    assert.equal(texture.refCount, 1, 'and let go of when bound by handle');
    assert.equal(texture.release(), 0);
    /** @type {{ surface?: any }} */
    const gone = {};
    assert.equal(device.GetTexture(0, gone), D3D_OK);
    assert.equal(gone.surface, null, 'its last reference unbinds it');
    assert.equal(device.release(), 0, 'and the device lets go of nothing more');
    assert.equal(f.target.release(), 0);
    assert.equal(root.release('IDirectDraw7'), 0);
});

test('recorded: a texture goes up once, and again only after the program wrote it', async()=>{
    const f = recorded();
    const { device, gpu, root, ram, target } = f;
    const texture = surface(root, {
        caps: DDSCAPS_TEXTURE | DDSCAPS_OFFSCREENPLAIN, width: 2, height: 2, pixelFormat: ARGB32,
    });
    const texels = Uint8Array.from([
        0, 0, 255, 255, 0, 255, 0, 255,
        255, 0, 0, 255, 0, 255, 255, 255,
    ]);
    ram.set(texels, texture.buffer);
    assert.equal(device.SetTexture(0, texture), D3D_OK);
    assert.equal(device.SetTextureStageState(0, D3DTSS.COLOROP, D3DTOP.SELECTARG1), D3D_OK);
    assert.equal(device.SetTextureStageState(0, D3DTSS.COLORARG1, D3DTA.TEXTURE), D3D_OK);
    const quad = vertices([[0, 0, 0, 0], [8, 0, 1, 0], [0, 8, 0, 1], [8, 8, 1, 1]], true);
    const draw = async()=>{
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.DrawPrimitive(D3DPT.TRIANGLESTRIP, FVF_TL_TEX, quad, 4), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        device.present(target.buffer);
        await device.idle();
    };

    await draw();
    assert.equal(gpu.count('writeTexture'), 1);
    assert.deepEqual([...gpu.of('writeTexture')[0].bytes], [...texels],
        'the bytes at the surface address, as the program wrote them');
    assert.equal(gpu.count('draw'), 1);

    ram.set([9, 9, 9, 9], texture.buffer);
    assert.equal(texture.lock(null).hr, D3D_OK);
    assert.equal(texture.unlock(null), D3D_OK);
    await draw();
    assert.equal(gpu.count('writeTexture'), 2, 'an unlock makes the copy stale');
    assert.deepEqual([...gpu.of('writeTexture')[1].bytes.subarray(0, 4)], [9, 9, 9, 9]);

    await draw();
    assert.equal(gpu.count('writeTexture'), 2, 'untouched, it stays up');

    assert.equal(device.SetTexture(0, null), D3D_OK);
    assert.equal(texture.release(), 0);
    assert.equal(device.release(), 0);
    assert.equal(target.release(), 0);
    assert.equal(root.release('IDirectDraw7'), 0);
    assert.ok(root.destroyed);
});

test('recorded: COLORKEYENABLE discards the texels of the texture\'s source colour key', async()=>{
    // Wine's ddraw7 test_ck_default: a texture filled with its own
    // DDCKEY_SRCBLT colour draws that colour with the state off, its
    // default, and draws nothing -- the clear shows through -- with it on.
    // Only the colour bits are compared, so the unused top byte of an X8R8G8B8
    // key does not decide it.
    const f = recorded();
    const { device, gpu, root, ram, target } = f;
    const texture = surface(root, {
        caps: DDSCAPS_TEXTURE | DDSCAPS_OFFSCREENPLAIN, width: 2, height: 2, pixelFormat: ARGB32,
    });
    ram.set(new Uint8Array(16).fill(0).map((_, at)=>(at % 4 === 0 || at % 4 === 3 ? 255 : 0)),
        texture.buffer);
    assert.equal(texture.setColorKey(DDCKEY_SRCBLT, { low: 0x770000ff, high: 0x770000ff }), D3D_OK);
    assert.equal(device.SetTexture(0, texture), D3D_OK);
    assert.equal(device.SetTextureStageState(0, D3DTSS.COLOROP, D3DTOP.SELECTARG1), D3D_OK);
    assert.equal(device.SetTextureStageState(0, D3DTSS.COLORARG1, D3DTA.TEXTURE), D3D_OK);
    const quad = vertices([[0, 0, 0, 0], [8, 0, 1, 0], [0, 8, 0, 1], [8, 8, 1, 1]], true);
    const draw = async()=>{
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.DrawPrimitive(D3DPT.TRIANGLESTRIP, FVF_TL_TEX, quad, 4), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        device.present(target.buffer);
        await device.idle();
        const modules = gpu.of('createShaderModule');
        return modules[modules.length - 1].descriptor.code;
    };

    const plain = await draw();
    assert.doesNotMatch(plain, /discard/, 'off by default, the key is ordinary colour');
    assert.equal(device.SetRenderState(D3DRENDERSTATE.COLORKEYENABLE, 1), D3D_OK);
    const keyed = await draw();
    assert.ok(keyed.includes('textureLoad(texture0,'), keyed);
    assert.ok(keyed.includes('vec3f(0.0, 0.0, 1.0)'), 'the key, blue, as the texel expands');
    assert.match(keyed, /if \(colourKeyed\)\s*\{\s*discard;/);
    // A key set on the surface afterwards is the one the next draw keys by.
    assert.equal(texture.setColorKey(DDCKEY_SRCBLT, { low: 0x00ff0000, high: 0x00ff0000 }),
        D3D_OK);
    assert.ok((await draw()).includes('vec3f(1.0, 0.0, 0.0)'));

    assert.equal(device.SetTexture(0, null), D3D_OK);
    assert.equal(texture.release(), 0);
    assert.equal(device.release(), 0);
    assert.equal(target.release(), 0);
    assert.equal(root.release('IDirectDraw7'), 0);
});

test('recorded: every level of a DirectDraw mip chain goes up, each when it was written', async()=>{
    const f = recorded();
    const { device, gpu, root, ram, target } = f;
    const made = root.createSurface({
        flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT | DDSD_MIPMAPCOUNT,
        caps: DDSCAPS_TEXTURE | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP,
        width: 4, height: 4, mipMapCount: 3, pixelFormat: ARGB32,
    });
    assert.equal(made.hr, D3D_OK);
    const texture = /** @type {any} */ (made.surface);
    const levels = [texture, texture.mipNext, texture.mipNext.mipNext];
    levels.forEach((level, index)=>{
        ram.fill(index + 1, level.buffer, level.buffer + level.pitch * level.height);
    });
    assert.equal(device.SetTexture(0, texture), D3D_OK);
    assert.equal(device.SetTextureStageState(0, D3DTSS.COLOROP, D3DTOP.SELECTARG1), D3D_OK);
    assert.equal(device.SetTextureStageState(0, D3DTSS.COLORARG1, D3DTA.TEXTURE), D3D_OK);
    const quad = vertices([[0, 0, 0, 0], [8, 0, 1, 0], [0, 8, 0, 1], [8, 8, 1, 1]], true);
    const draw = async()=>{
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.DrawPrimitive(D3DPT.TRIANGLESTRIP, FVF_TL_TEX, quad, 4), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        device.present(target.buffer);
        await device.idle();
    };
    const written = ()=>gpu.of('writeTexture').map((/** @type {any} */ call)=>
        [call.destination.mipLevel ?? 0, call.bytes[0], call.bytes.length]);

    await draw();
    const chain = gpu.of('createTexture').find((/** @type {any} */ call)=>
        call.descriptor.size.width === 4 && call.descriptor.size.height === 4);
    assert.equal(chain?.descriptor.mipLevelCount, 3);
    assert.deepEqual(written(), [[0, 1, 64], [1, 2, 16], [2, 3, 4]], 'each level, its own bytes');

    ram.fill(9, levels[1].buffer, levels[1].buffer + 16);
    assert.equal(levels[1].lock(null).hr, D3D_OK);
    assert.equal(levels[1].unlock(null), D3D_OK);
    await draw();
    assert.deepEqual(written().slice(3), [[1, 9, 16]], 'a level written goes up alone');

    assert.equal(device.SetTexture(0, null), D3D_OK);
    assert.equal(texture.release(), 0);
    assert.equal(device.release(), 0);
    assert.equal(target.release(), 0);
    assert.equal(root.release('IDirectDraw7'), 0);
    assert.ok(root.destroyed);
});

test('recorded: Direct3D 7 filters are its own numbering, D3DTFP_NONE the mip default', async()=>{
    // d3dtypes.h: D3DTFP_NONE is 1, D3DTFP_POINT 2 and D3DTFP_LINEAR 3, and
    // D3DTFG_ANISOTROPIC 5, where Direct3D 8 numbers them 0, 1, 2 and 3.
    const f = recorded();
    const { device, gpu, root, target } = f;
    /** @type {{ value?: number }} */
    const out = {};
    assert.equal(device.GetTextureStageState(0, D3DTSS.MIPFILTER, out), D3D_OK);
    assert.equal(out.value, 1, 'D3DTFP_NONE');
    const texture = surface(root, {
        caps: DDSCAPS_TEXTURE | DDSCAPS_OFFSCREENPLAIN, width: 2, height: 2, pixelFormat: ARGB32,
    });
    assert.equal(device.SetTexture(0, texture), D3D_OK);
    const quad = vertices([[0, 0, 0, 0], [8, 0, 1, 0], [0, 8, 0, 1], [8, 8, 1, 1]], true);
    /** @param {number} mip @param {number} mag */
    const flagsFor = async(mip, mag)=>{
        assert.equal(device.SetTextureStageState(0, D3DTSS.MIPFILTER, mip), D3D_OK);
        assert.equal(device.SetTextureStageState(0, D3DTSS.MAGFILTER, mag), D3D_OK);
        assert.equal(device.GetTextureStageState(0, D3DTSS.MIPFILTER, out), D3D_OK);
        assert.equal(out.value, mip, 'read back as it was set');
        assert.equal(device.GetTextureStageState(0, D3DTSS.MAGFILTER, out), D3D_OK);
        assert.equal(out.value, mag);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.DrawPrimitive(D3DPT.TRIANGLESTRIP, FVF_TL_TEX, quad, 4), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        device.present(target.buffer);
        await device.idle();
        const writes = gpu.of('writeBuffer').filter((/** @type {any} */ call)=>
            call.buffer.descriptor.label.startsWith('uniforms'));
        const last = writes[writes.length - 1].bytes;
        const flags = new DataView(last.buffer, last.byteOffset, last.byteLength)
            .getUint32(UNIFORM_AT.stage0 * 4, true);
        return { mipMode: (flags >> 6) & 3, magPoint: (flags >> 4) & 1 };
    };
    assert.deepEqual(await flagsFor(1, 1), { mipMode: 0, magPoint: 1 }, 'none, point');
    assert.deepEqual(await flagsFor(2, 2), { mipMode: 1, magPoint: 0 }, 'point, linear');
    assert.deepEqual(await flagsFor(3, 5), { mipMode: 2, magPoint: 0 }, 'linear, anisotropic');

    assert.equal(device.SetTexture(0, null), D3D_OK);
    assert.equal(texture.release(), 0);
    assert.equal(device.release(), 0);
    assert.equal(target.release(), 0);
    assert.equal(root.release('IDirectDraw7'), 0);
});

test('recorded: indices by pointer and vertices in a buffer draw as one indexed call', async()=>{
    const f = recorded();
    const { d3d, device, gpu, ram, root, target } = f;
    const made = d3d.createVertexBuffer({ caps: 0, fvf: FVF_TL, numVertices: 4 });
    assert.equal(made.hr, D3D_OK);
    const buffer = made.buffer;
    /** @type {{ data?: number, size?: number }} */
    const lock = {};
    assert.equal(buffer.Lock(0, lock), D3D_OK);
    const corners = vertices([[0, 0], [8, 0], [0, 8], [8, 8]], false);
    ram.set(corners, /** @type {number} */ (lock.data));
    assert.equal(buffer.Unlock(), D3D_OK);

    const indices = 0x80000;
    ram.set(new Uint8Array(Uint16Array.from([0, 1, 2, 2, 1, 3]).buffer), indices);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawIndexedPrimitiveVB(D3DPT.TRIANGLELIST, buffer, 0, 4, indices, 6),
        D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    device.present(target.buffer);
    await device.idle();

    assert.equal(gpu.count('drawIndexed'), 1);
    assert.deepEqual(gpu.of('drawIndexed')[0].args, [6, 1, 0, 0]);
    const bound = gpu.of('setIndexBuffer')[0];
    assert.equal(bound.format, 'uint16');
    const upload = gpu.of('writeBuffer').find(call=>call.buffer === bound.buffer);
    assert.deepEqual([...new Uint16Array(upload.bytes.buffer, upload.bytes.byteOffset, 6)],
        [0, 1, 2, 2, 1, 3], 'the program\'s own indices travelled');
    const stream = gpu.of('writeBuffer').find(call=>
        call.buffer === gpu.of('setVertexBuffer')[0].buffer);
    assert.deepEqual([...stream.bytes], [...corners], 'and so did its vertices');

    assert.equal(buffer.release(), 0);
    assert.equal(device.release(), 0);
    assert.equal(target.release(), 0);
    assert.equal(root.release('IDirectDraw7'), 0);
    assert.ok(root.destroyed);
});

test('recorded: a render target\'s pixels are read back into its guest bytes when asked for,'
    + ' and taken up again when the program wrote them', async()=>{
    // ddraw7.c get_surface_color (453-470) locks the target after drawing;
    // the lock's bytes are the GPU's picture only once they are read back.
    const f = recorded({ writable: true });
    const { device, gpu, ram, root, target } = f;
    const depth = surface(root, { caps: DDSCAPS_ZBUFFER, zBufferBitDepth: 16 });
    assert.equal(target.addAttachedSurface(depth), D3D_OK);
    const texture = surface(root, { caps: DDSCAPS_TEXTURE, pixelFormat: ARGB32 });

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, FVF_TL,
        vertices([[0, 0], [8, 0], [0, 8]], false), 3), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    device.present(target.buffer);
    await device.idle();
    assert.equal(texture.pixelsCurrent(), null, 'a texture\'s bytes are its pixels already');

    // What the GPU holds for the target: the fake keeps texels, so they are
    // put there as a draw would have left them.
    const drawn = gpu.of('beginRenderPass')[0].descriptor.colorAttachments[0].view.texture;
    for (let at = 0; at < drawn.bytes.length; at += 4)
    {
        drawn.bytes.set([0x30, 0x20, 0x10, 0xff], at);
    }
    const pending = target.pixelsCurrent();
    assert.ok(pending, 'a target is read back');
    await pending;
    const copies = gpu.of('copyTextureToBuffer');
    assert.equal(copies.length, 1);
    assert.equal(copies[0].source.texture, drawn, 'out of the texture the draw went into');
    assert.deepEqual([...ram.subarray(target.buffer, target.buffer + 8)],
        [0x30, 0x20, 0x10, 0xff, 0x30, 0x20, 0x10, 0xff]);
    assert.deepEqual([...ram.subarray(target.buffer + 8 * 8 * 4 - 4, target.buffer + 8 * 8 * 4)],
        [0x30, 0x20, 0x10, 0xff], 'every pixel of it, at the surface\'s own pitch');

    // A write lock's bytes go up to the target, in the frame's order, before
    // it is drawn to again.
    const uploads = ()=>gpu.of('copyBufferToTexture')
        .filter(call=>call.destination.texture === drawn);
    assert.equal(target.lock(null, 0).hr, D3D_OK);
    ram.set([1, 2, 3, 4], target.buffer);
    assert.equal(target.unlock(null), D3D_OK);
    assert.equal(uploads().length, 0, 'not before the target is used');
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, FVF_TL,
        vertices([[0, 0], [8, 0], [0, 8]], false), 3), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    device.present(target.buffer);
    await device.idle();
    assert.equal(uploads().length, 1);
    assert.deepEqual([...drawn.bytes.subarray(0, 8)], [1, 2, 3, 0xff, 0x30, 0x20, 0x10, 0xff],
        'the program\'s pixel, X8 as opaque, beside what the read-back brought in');

    assert.equal(device.release(), 0);
    assert.equal(target.pixelsCurrent(), null, 'a released device holds no copy');
    assert.equal(texture.release(), 0);
    assert.equal(target.release(), 0);
    assert.equal(depth.release(), 0);
    assert.equal(root.release('IDirectDraw7'), 0);
    assert.ok(root.destroyed);
});

test('recorded: a depth buffer drawn against is read back in its own depth format, and what the'
    + ' program wrote into it is drawn into the GPU\'s copy (test_depth_readback, test_depth_blit)',
async()=>{
    const f = recorded({ writable: true });
    const { device, gpu, ram, root, target } = f;
    const depth = surface(root, { caps: DDSCAPS_ZBUFFER, zBufferBitDepth: 16 });
    assert.equal(target.addAttachedSurface(depth), D3D_OK);
    assert.equal(depth.pixelsCurrent(), null, 'one never drawn against holds its own bytes');
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, FVF_TL,
        vertices([[0, 0], [8, 0], [0, 8]], false), 3), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await device.idle();

    // What the GPU holds: the fake runs no shader, so the words the read's
    // pass writes are put in its buffer as the pass would leave them.
    const made = gpu.device.createBuffer;
    gpu.device.createBuffer = (/** @type {any} */ descriptor)=>{
        const buffer = made(descriptor);
        if (descriptor.label === 'depth-read')
        {
            const floats = new Float32Array(buffer.bytes.buffer, 0, 64);
            floats.forEach((_, index)=>{
                floats[index] = index / 63;
            });
        }
        return buffer;
    };
    const pending = depth.pixelsCurrent();
    assert.ok(pending, 'a depth buffer drawn against is read back');
    await pending;
    gpu.device.createBuffer = made;
    assert.equal(gpu.of('dispatchWorkgroups').length, 1, 'by a pass that loads its depths');
    const depthTexture = gpu.of('createTexture')
        .find(call=>call.descriptor.format === 'depth16unorm');
    assert.ok(depthTexture && (depthTexture.descriptor.usage & 0x04) !== 0,
        'which binds the depth texture');
    const row = (/** @type {number} */ y)=>Array.from({ length: 8 },
        (_, x)=>ram[depth.buffer + y * depth.pitch + x * 2]
            | ram[depth.buffer + y * depth.pitch + x * 2 + 1] << 8);
    assert.deepEqual(row(0), Array.from({ length: 8 }, (_, x)=>Math.round(x / 63 * 65535)),
        'each pixel a share of D16\'s range');
    assert.equal(row(7)[7], 65535, 'at the surface\'s own pitch');

    // A blit into it: its bytes drawn into the GPU's copy before the next draw.
    assert.equal(depth.lock(null, 0).hr, D3D_OK);
    ram.fill(0, depth.buffer, depth.buffer + depth.pitch * 8);
    ram[depth.buffer + 2] = 0xff;
    ram[depth.buffer + 3] = 0xff;
    assert.equal(depth.unlock(null), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, FVF_TL,
        vertices([[0, 0], [8, 0], [0, 8]], false), 3), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    device.present(target.buffer);
    await device.idle();
    const passes = gpu.of('beginRenderPass').map(call=>call.descriptor.label);
    const written = passes.indexOf('depth-write');
    assert.ok(written >= 0, 'a pass draws the depths in');
    assert.ok(passes.slice(written + 1).length > 0, 'ahead of the draw after it');
    const words = gpu.of('writeBuffer').find(call=>call.buffer.descriptor.label === 'depth-write');
    assert.ok(words);
    const values = new Uint32Array(words.bytes.buffer, words.bytes.byteOffset, 2 + 64);
    assert.deepEqual([values[0], values[1]], [8, 64], 'the width and the texel count first');
    assert.deepEqual([...new Float32Array(values.buffer, values.byteOffset + 8, 3)], [0, 1, 0],
        'then each pixel\'s depth, 0 to 1');

    assert.equal(device.release(), 0);
    assert.equal(target.release(), 0);
    assert.equal(depth.release(), 0);
    assert.equal(root.release('IDirectDraw7'), 0);
    assert.ok(root.destroyed);
});

test('recorded: a buffer the runtime clips is clipped behind the eye, and under current rules '
    + 'every draw is', async()=>{
    // ProcessVertices with D3DVOP_CLIP leaves a vertex behind the eye with a
    // negative RHW, and the runtime clipped the buffer's triangles when it
    // was drawn (decisions.md A45). Taken at w one, Half-Life's Direct3D
    // world was spikes across the screen from every wall behind the camera.
    // The seam tells the draw; the drivers of the time drew a negative RHW
    // in any other draw, and Wine clips it in every one.
    /**
     * @param {'legacy' | 'current' | undefined} driverRules
     * @param {number} clipped  what the seam tells the draw
     * @param {number} [clipping]  D3DRENDERSTATE_CLIPPING
     */
    const vertexStageOf = async(driverRules, clipped, clipping = 1)=>{
        const f = recorded({ driverRules });
        const { d3d, device, gpu, ram, root, target } = f;
        const buffer = d3d.createVertexBuffer({ caps: 0, fvf: FVF_TL, numVertices: 4 }).buffer;
        /** @type {{ data?: number, size?: number }} */
        const lock = {};
        assert.equal(buffer.Lock(0, lock), D3D_OK);
        ram.set(vertices([[0, 0], [8, 0], [0, 8], [8, 8]], false),
            /** @type {number} */ (lock.data));
        assert.equal(buffer.Unlock(), D3D_OK);
        assert.equal(device.SetRenderState(D3DRENDERSTATE.CLIPPING, clipping), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.DrawPrimitiveVB(D3DPT.TRIANGLESTRIP, buffer, 0, 4, clipped), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        device.present(target.buffer);
        await device.idle();
        const modules = gpu.of('createShaderModule');
        const code = modules[modules.length - 1].descriptor.code;
        assert.equal(buffer.release(), 0);
        assert.equal(device.release(), 0);
        assert.equal(target.release(), 0);
        assert.equal(root.release('IDirectDraw7'), 0);
        return code;
    };
    const behindEye = 'vertex.position.w != 0.0);';
    const atOne = 'vertex.position.w > 0.0);';
    assert.ok((await vertexStageOf(undefined, 1)).includes(behindEye), 'a clipped buffer');
    assert.ok((await vertexStageOf(undefined, 0)).includes(atOne), 'a buffer nothing clipped');
    assert.ok((await vertexStageOf(undefined, 1, 0)).includes(atOne),
        'D3DRENDERSTATE_CLIPPING off: the program promised nothing needs it');
    assert.ok((await vertexStageOf('current', 0)).includes(behindEye),
        'every draw, under current rules');
});

test('a fresh device\'s material is all zeros (test_material)', ()=>{
    const f = fixture();
    /** @type {{ material?: any }} */
    const out = {};

    assert.equal(f.device.GetMaterial(out), D3D_OK);
    for (const term of ['Diffuse', 'Ambient', 'Specular', 'Emissive'])
    {
        assert.deepEqual(out.material[term], { r: 0, g: 0, b: 0, a: 0 }, term);
    }
    assert.equal(out.material.Power, 0);

    releaseAll(f);
});

test('recorded: a stencil test the caps claim is drawn, over the depth format with stencil',
    async()=>{
        const f = recorded();
        const { device, gpu, root, target } = f;
        // The format EnumZBufferFormats offers with stencil, named whole.
        const depth = surface(root, { caps: DDSCAPS_ZBUFFER,
            pixelFormat: depthFormatForDepth(32) });
        assert.equal(depth.pixelFormat.flags & DDPF_STENCILBUFFER, DDPF_STENCILBUFFER,
            'a depth format with stencil says so, as a program picks one by the flag');
        assert.equal(target.addAttachedSurface(depth), D3D_OK);
        // STENCILENABLE, STENCILFUNC EQUAL, STENCILPASS REPLACE.
        assert.equal(device.SetRenderState(52, 1), D3D_OK);
        assert.equal(device.SetRenderState(56, 3), D3D_OK);
        assert.equal(device.SetRenderState(55, 3), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.DrawPrimitive(D3DPT.TRIANGLESTRIP, FVF_TL,
            vertices([[0, 0], [8, 0], [0, 8], [8, 8]], false), 4), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        device.present(target.buffer);
        await device.idle();
        const [pipeline] = gpu.of('createRenderPipeline').map(call=>call.descriptor);
        assert.equal(pipeline.depthStencil.format, 'depth24plus-stencil8');
        assert.equal(pipeline.depthStencil.stencilFront.compare, 'equal');
        assert.equal(pipeline.depthStencil.stencilFront.passOp, 'replace');
        assert.deepEqual(gpu.errors, []);
        assert.equal(target.deleteAttachedSurface(depth), D3D_OK);
        assert.equal(depth.release(), 0);
        assert.equal(device.release(), 0);
        assert.equal(target.release(), 0);
        assert.equal(root.release('IDirectDraw7'), 0);
    });

test('recorded: a DXT1 texture is drawn; a palettised one is drawn without, said as a loss',
    async()=>{
        /** @type {string[]} */
        const losses = [];
        /** @param {string} api @param {string} detail @param {string} [severity] */
        const divergence = (api, detail, severity)=>(severity === 'loss' ? losses.push(detail) : 0);
        const f = recorded({ divergence });
        const { device, gpu, root, target } = f;
        const quad = vertices([[0, 0, 0, 0], [8, 0, 1, 0], [0, 8, 0, 1], [8, 8, 1, 1]], true);
        const drawWith = async(/** @type {any} */ texture)=>{
            assert.equal(device.SetTexture(0, texture), D3D_OK);
            assert.equal(device.BeginScene(), D3D_OK);
            assert.equal(device.DrawPrimitive(D3DPT.TRIANGLESTRIP, FVF_TL_TEX, quad, 4), D3D_OK);
            assert.equal(device.EndScene(), D3D_OK);
            device.present(target.buffer);
            await device.idle();
        };
        // 'DXT1', a 4 by 4 level of one block.
        const dxt = surface(root, { caps: DDSCAPS_TEXTURE, width: 4, height: 4,
            pixelFormat: { size: 0x20, flags: DDPF_FOURCC, fourCC: 0x31545844, bitCount: 0,
                redMask: 0, greenMask: 0, blueMask: 0, alphaMask: 0 } });
        await drawWith(dxt);
        assert.equal(gpu.count('draw'), 1);
        assert.ok(gpu.count('writeTexture') >= 1, 'its level went up');
        assert.deepEqual(losses, []);
        assert.deepEqual(gpu.errors, []);

        const indexed = surface(root, { caps: DDSCAPS_TEXTURE, width: 4, height: 4,
            pixelFormat: { size: 0x20, flags: 0x20 /* DDPF_PALETTEINDEXED8 */, fourCC: 0,
                bitCount: 8, redMask: 0, greenMask: 0, blueMask: 0, alphaMask: 0 } });
        await drawWith(indexed);
        assert.equal(gpu.count('draw'), 2, 'the draw goes on');
        // Said each time the draw looks for it; the journal counts the repeats.
        assert.ok(losses.length > 0);
        assert.ok(losses.every(detail=>detail === losses[0]));
        assert.match(losses[0], /flags 0x20, 8 bits is drawn as no texture/);

        assert.equal(device.SetTexture(0, null), D3D_OK);
        assert.equal(dxt.release(), 0);
        assert.equal(indexed.release(), 0);
        assert.equal(device.release(), 0);
        assert.equal(target.release(), 0);
        assert.equal(root.release('IDirectDraw7'), 0);
    });

test('the earlier interfaces\' sampler render states are kept on IDirect3DDevice7, and said', ()=>{
    /** @type {string[]} */
    const said = [];
    const f = recorded({ divergence: (api, detail)=>said.push(detail) });
    const { device, target, root } = f;
    /** @type {{ value?: number }} */
    const out = {};
    // D3DRENDERSTATE_TEXTUREADDRESSU, clamp.
    assert.equal(device.SetRenderState(44, 3), D3D_OK);
    assert.equal(device.GetRenderState(44, out), D3D_OK);
    assert.equal(out.value, 3, 'kept');
    assert.ok(said.some(detail=>/kept and not applied on IDirect3DDevice7/.test(detail)));
    assert.equal(device.release(), 0);
    assert.equal(target.release(), 0);
    assert.equal(root.release('IDirectDraw7'), 0);
});

test('a device is made on no indexed surface, and its target moves to one in system memory or a'
    + ' depth buffer, not an indexed one (test_rt_caps)', ()=>{
    const root = ddrawObject();
    const d3d = createDirect3D7(root);
    const p8 = { size: 0x20, flags: 0x20 | 0x40, fourCC: 0, bitCount: 8, redMask: 0,
        greenMask: 0, blueMask: 0, alphaMask: 0 };
    const palette = /** @type {any} */ (root.createPalette(4 | 0x40, new Array(256).fill(0))
        .palette);
    const indexed = (/** @type {number} */ caps)=>{
        const made = surface(root, { caps: caps | DDSCAPS_3DDEVICE | 0x40, pixelFormat: p8 });
        assert.equal(made.setPalette(palette), D3D_OK);
        return made;
    };
    const video = indexed(0x4000);
    const system = indexed(0x800);
    assert.equal(d3d.createDevice(DEVICE_IDS.HAL, video).hr >>> 0, 0x88760091,
        'DDERR_INVALIDPIXELFORMAT');
    assert.equal(d3d.createDevice(DEVICE_IDS.HAL, system).hr >>> 0, 0x887602eb,
        'D3DERR_SURFACENOTINVIDMEM');
    assert.equal(d3d.createDevice(DEVICE_IDS.RGB, system).hr >>> 0, 0x80004005, 'E_FAIL');
    assert.equal(d3d.createDevice(DEVICE_IDS.RGB, video).hr >>> 0, 0x88760091,
        'in video memory the software rasteriser refuses the format too');
    const olderVideo = d3d.createDevice(DEVICE_IDS.RGB, video, { legacy: true });
    assert.equal(olderVideo.hr, D3D_OK, 'where an older interface\'s makes it');
    olderVideo.device.release();
    const older = d3d.createDevice(DEVICE_IDS.RGB, system, { legacy: true });
    assert.equal(older.hr, D3D_OK, 'an older interface\'s rasteriser makes it');
    older.device.release();

    const target = surface(root);
    const made = d3d.createDevice(DEVICE_IDS.HAL, target);
    assert.equal(made.hr, D3D_OK);
    const device = made.device;
    const sysmem = surface(root, { caps: DDSCAPS_3DDEVICE | 0x40 | 0x800 });
    assert.equal(device.SetRenderTarget(sysmem), D3D_OK, 'system memory is taken as a target');
    assert.equal(device.SetRenderTarget(video) >>> 0, 0x88760064, 'DDERR_INVALIDCAPS');
    const depth = surface(root, { caps: DDSCAPS_3DDEVICE | DDSCAPS_ZBUFFER, zBufferBitDepth: 16 });
    assert.equal(device.SetRenderTarget(depth) >>> 0, 0x88760091,
        'a depth buffer is refused as a format');
    /** @type {{ surface?: any }} */
    const held = {};
    assert.equal(device.GetRenderTarget(held), D3D_OK);
    assert.equal(held.surface, depth, 'and taken all the same');
    held.surface.release();
    assert.equal(depth.refCount, 2, 'with a reference of its own');
    // Through IDirect3DDevice2 no reference is taken.
    assert.equal(device.SetRenderTarget(target), D3D_OK);
    assert.equal(device.SetRenderTarget(depth, { unheldDepth: true }) >>> 0, 0x88760091);
    assert.equal(depth.refCount, 1);
    assert.equal(depth.addRef(), 2);
    assert.equal(device.release(), 0);
    assert.equal(depth.refCount, 1, 'let go of at the device\'s release');
});

test('a vertex buffer locked with both NOOVERWRITE and DISCARDCONTENTS is written in place'
    + ' (ddraw7 test_map_synchronisation)', ()=>{
    const D3DLOCK_DISCARD = 0x2000;
    const D3DLOCK_NOOVERWRITE = 0x1000;
    assert.equal(bufferLockFlags(0x2000), D3DLOCK_DISCARD);
    assert.equal(bufferLockFlags(0x1000), D3DLOCK_NOOVERWRITE);
    assert.equal(bufferLockFlags(0x3000), D3DLOCK_NOOVERWRITE);
});
