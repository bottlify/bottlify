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
import { createDirect3D7, d3dFormatOf } from './device.js';
import {
    D3DDEVCAPS_HWRASTERIZATION, D3DDEVCAPS_HWTRANSFORMANDLIGHT, D3DERR_INBEGINSTATEBLOCK,
    D3DERR_INVALIDSTATEBLOCK, D3DERR_INVALIDVERTEXFORMAT, D3DERR_NOTINBEGINSTATEBLOCK,
    D3DERR_SCENE_IN_SCENE, D3DERR_SCENE_NOT_IN_SCENE, D3DERR_SURFACENOTINVIDMEM,
    D3DERR_VERTEXBUFFERLOCKED, D3DFMT, D3DRENDERSTATE, D3DRENDERSTATE_MAX, D3DSBT,
    D3DTRANSFORMSTATE, D3DVBCAPS_OPTIMIZED, D3DZB, D3D_OK, DDERR_INVALIDCAPS, DDERR_INVALIDPARAMS,
    DDERR_NOTFOUND, DEVICE_IDS, floatToDword,
} from './constants.js';
import { D3DCLEAR, D3DPT, D3DTA, D3DTOP, D3DTSS } from '../d3d8/constants.js';
import { FVF } from '../webgpu/internal/vertexformat.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { createDirectDraw } from '../ddraw/objects.js';
import {
    DDPF_ALPHAPIXELS, DDPF_RGB, DDSCAPS_3DDEVICE, DDSCAPS_OFFSCREENPLAIN, DDSCAPS_SYSTEMMEMORY,
    DDSCAPS_TEXTURE, DDSCAPS_ZBUFFER, DDSCL_NORMAL, DDSD_CAPS, DDSD_HEIGHT, DDSD_PIXELFORMAT,
    DDSD_WIDTH, DDSD_ZBUFFERBITDEPTH,
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
 * @param {{ allocate?: (bytes: number) => number }} [options]
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

test('the scene is a pair, and a draw belongs inside it', ()=>{
    const f = fixture();
    const { device } = f;
    const triangle = new Uint8Array(20 * 3);

    assert.equal(device.EndScene(), D3DERR_SCENE_NOT_IN_SCENE);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, FVF_TL, triangle, 3),
        D3DERR_SCENE_NOT_IN_SCENE);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.BeginScene(), D3DERR_SCENE_IN_SCENE);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, FVF_TL, triangle, 3), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK, 'the refused begin did not count');
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
        assert.equal(device.GetRenderState(state, out), D3D_OK, name);
        assert.ok(state <= D3DRENDERSTATE_MAX, `${name} is a D3D7 state`);
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

    // World is translate; multiplying by scale is translate then scale, so
    // the translation is doubled. The other order would leave it at five.
    assert.equal(device.MultiplyTransform(D3DTRANSFORMSTATE.WORLD, scale), D3D_OK);
    assert.equal(device.GetTransform(D3DTRANSFORMSTATE.WORLD, out), D3D_OK);
    assert.equal(out.matrix?.[12], 10);

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
    assert.equal(device.SetTextureStageState(2, D3DTSS.COLOROP, D3DTOP.ADD), D3D_OK);
    assert.equal(device.GetTextureStageState(2, D3DTSS.COLOROP, out), D3D_OK);
    assert.equal(out.value, D3DTOP.ADD);

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
    assert.equal(buffer.Lock(0, {}), D3DERR_VERTEXBUFFERLOCKED);
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
    assert.equal(device.Clear(2, null, D3DCLEAR.TARGET, 0, 1, 0), DDERR_INVALIDPARAMS,
        'two rectangles and none given');
    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, 0x00123456, 1, 0), D3D_OK);

    releaseAll(f);
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

/** A device over the recording GPU, with guest memory the test owns. */
function recorded(){
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
    const root = ddrawObject({
        allocate: bytes=>{
            const at = next;
            next += bytes + 0xfff & ~0xfff;
            return at;
        },
    });
    const d3d = createDirect3D7(root, {
        backend,
        readMemory: (address, length)=>ram.slice(address, address + length),
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
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

test('a fresh device has a white material, not a black one', ()=>{
    // This is the version Warcraft III draws its menu through, and lighting now
    // reads the material. All zeros -- what an unseeded structure holds -- takes
    // every term to zero for geometry that never calls SetMaterial and carries
    // no vertex colour, so the whole scene lights to black while every state a
    // program reads back still says what it expects.
    const f = fixture();
    /** @type {{ material?: any }} */
    const out = {};

    assert.equal(f.device.GetMaterial(out), D3D_OK);
    assert.deepEqual(out.material.Diffuse, { r: 1, g: 1, b: 1, a: 1 });
    assert.deepEqual(out.material.Ambient, { r: 1, g: 1, b: 1, a: 1 });
    assert.deepEqual(out.material.Specular, { r: 0, g: 0, b: 0, a: 0 });
    assert.deepEqual(out.material.Emissive, { r: 0, g: 0, b: 0, a: 0 });
    assert.equal(out.material.Power, 0);

    releaseAll(f);
});
