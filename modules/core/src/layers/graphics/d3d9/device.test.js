/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3DERR_DEVICELOST, D3DERR_DEVICENOTRESET, D3DERR_INVALIDCALL, D3DFMT, D3DLIGHTTYPE, D3DPOOL,
    D3DRS, D3DSWAPEFFECT, D3DZB, D3D_OK, dwordToFloat, floatToDword,
} from './constants.js';
import { D3DFMT_INDEX } from '../d3d8/constants.js';
import { DEFAULT_RENDER_STATES, resolveRenderStateDefault } from './renderstates.js';
import { DEVICE_STATE, LIGHT_ENABLED, createDirect3D9 } from './device.js';

/** Distinguishes "the call wrote nothing" from "the call wrote a zero". */
const UNTOUCHED = Symbol('untouched');

const MAX_POINT_SIZE = 256.0;

/**
 * @param {{ caps?: object, parameters?: object }} [options]
 */
function createDevice(options = {}){
    const d3d = createDirect3D9({ maxPointSize: MAX_POINT_SIZE, ...options.caps });
    /** @type {{ device?: any }} */
    const out = {};
    const parameters = {
        swapEffect: D3DSWAPEFFECT.DISCARD,
        backBufferCount: 1,
        backBufferWidth: 640,
        backBufferHeight: 480,
        backBufferFormat: D3DFMT.X8R8G8B8,
        enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT.D24S8,
        ...options.parameters,
    };
    assert.equal(d3d.CreateDevice(parameters, out), D3D_OK, 'the fixture device is creatable');
    return out.device;
}

/**
 * Every test ends here. A device whose last reference is not the caller's has
 * something still holding it, which for a graphics layer is a leaked resource.
 *
 * @param {any} device
 */
function assertFullyReleased(device){
    assert.equal(device.release(), 0, 'the device reached a reference count of zero');
}

// --- the scene state machine ---

test('an EndScene without a BeginScene fails', ()=>{
    const device = createDevice();

    assert.equal(device.EndScene(), D3DERR_INVALIDCALL);

    assertFullyReleased(device);
});

test('a Begin/End pair succeeds, and a second End does not', ()=>{
    const device = createDevice();

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    assert.equal(device.EndScene(), D3DERR_INVALIDCALL);

    assertFullyReleased(device);
});

test('a nested BeginScene fails without opening a second scene', ()=>{
    const device = createDevice();

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.BeginScene(), D3DERR_INVALIDCALL);
    // Still exactly one scene deep: the refused call must not have counted.
    assert.equal(device.EndScene(), D3D_OK);
    assert.equal(device.EndScene(), D3DERR_INVALIDCALL);

    assertFullyReleased(device);
});

test('Reset closes an open scene', ()=>{
    const device = createDevice();

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.Reset(), D3D_OK);
    assert.equal(device.EndScene(), D3DERR_INVALIDCALL);

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);

    assertFullyReleased(device);
});

test('SetRenderTarget neither opens nor closes a scene', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const target = {};
    assert.equal(device.CreateRenderTarget(128, 128, D3DFMT.A8R8G8B8, false, target), D3D_OK);

    assert.equal(device.SetRenderTarget(0, target.surface), D3D_OK);
    assert.equal(device.EndScene(), D3DERR_INVALIDCALL, 'no scene was opened by the change');

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetRenderTarget(0, target.surface), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK, 'the scene survived the change');

    target.surface.release();
    assertFullyReleased(device);
});

// --- default device state ---

test('a fresh device reads back the documented default of every render state', ()=>{
    const device = createDevice();
    const inputs = { enableAutoDepthStencil: true, maxPointSize: MAX_POINT_SIZE };

    for (const entry of DEFAULT_RENDER_STATES)
    {
        if (entry.asserted === false)
        {
            continue;
        }
        /** @type {{ value?: number }} */
        const out = { value: 0x1337c0de };
        assert.equal(device.GetRenderState(entry.state, out), D3D_OK, entry.name);
        assert.equal(out.value, resolveRenderStateDefault(entry, inputs) >>> 0,
            `default of ${entry.name}`);
    }

    assertFullyReleased(device);
});

test('ZENABLE follows the automatic depth stencil the device was created with', ()=>{
    /** @type {{ value?: number }} */
    const out = {};

    const withDepth = createDevice({ parameters: { enableAutoDepthStencil: true } });
    assert.equal(withDepth.GetRenderState(D3DRS.ZENABLE, out), D3D_OK);
    assert.equal(out.value, D3DZB.TRUE);
    assertFullyReleased(withDepth);

    const withoutDepth = createDevice({ parameters: { enableAutoDepthStencil: false } });
    assert.equal(withoutDepth.GetRenderState(D3DRS.ZENABLE, out), D3D_OK);
    assert.equal(out.value, D3DZB.FALSE);
    assertFullyReleased(withoutDepth);
});

test('POINTSIZE_MAX follows the reported maximum point size', ()=>{
    const device = createDevice({ caps: { maxPointSize: 8.0 } });
    /** @type {{ value?: number }} */
    const out = {};

    assert.equal(device.GetRenderState(D3DRS.POINTSIZE_MAX, out), D3D_OK);
    assert.equal(dwordToFloat(out.value ?? 0), 8.0);

    assertFullyReleased(device);
});

test('a float render state is stored as the bit pattern the guest wrote', ()=>{
    const device = createDevice();
    /** @type {{ value?: number }} */
    const out = {};

    assert.equal(device.SetRenderState(D3DRS.FOGSTART, floatToDword(0.25)), D3D_OK);
    assert.equal(device.GetRenderState(D3DRS.FOGSTART, out), D3D_OK);
    assert.equal(out.value, 0x3e800000);
    assert.equal(dwordToFloat(out.value ?? 0), 0.25);

    assertFullyReleased(device);
});

test('the two states nobody may assert a default for are marked as such', ()=>{
    const pointSize = DEFAULT_RENDER_STATES.find(entry=>entry.state === D3DRS.POINTSIZE);
    const token = DEFAULT_RENDER_STATES.find(entry=>entry.state === D3DRS.DEBUGMONITORTOKEN);

    assert.equal(pointSize?.asserted, false, 'POINTSIZE is the driver\'s choice');
    assert.equal(token?.capturedByStateBlock, false, 'a state block does not record the token');
});

test('Reset puts every render state back to its default', ()=>{
    const device = createDevice();
    /** @type {{ value?: number }} */
    const out = {};

    assert.equal(device.SetRenderState(D3DRS.LIGHTING, 0), D3D_OK);
    assert.equal(device.GetRenderState(D3DRS.LIGHTING, out), D3D_OK);
    assert.equal(out.value, 0);

    assert.equal(device.Reset(), D3D_OK);
    assert.equal(device.GetRenderState(D3DRS.LIGHTING, out), D3D_OK);
    assert.equal(out.value, 1);

    assertFullyReleased(device);
});

test('an unknown render state is not a state', ()=>{
    const device = createDevice();
    /** @type {{ value?: any }} */
    const out = { value: UNTOUCHED };

    assert.equal(device.SetRenderState(0xdead, 1), D3DERR_INVALIDCALL);
    assert.equal(device.GetRenderState(0xdead, out), D3DERR_INVALIDCALL);
    assert.equal(out.value, UNTOUCHED);

    assertFullyReleased(device);
});

// --- lights, which have no defaults at all until one is written ---

test('reading a light that was never written fails and writes nothing', ()=>{
    const device = createDevice();
    /** @type {{ light?: any, enabled?: any }} */
    const out = { light: UNTOUCHED, enabled: UNTOUCHED };

    assert.equal(device.GetLight(0, out), D3DERR_INVALIDCALL,
        'the light array starts empty rather than populated');
    assert.equal(out.light, UNTOUCHED);
    assert.equal(device.GetLightEnable(0, out), D3DERR_INVALIDCALL);
    assert.equal(out.enabled, UNTOUCHED);

    assertFullyReleased(device);
});

test('enabling a light brings it into existence', ()=>{
    const device = createDevice();
    /** @type {{ light?: any, enabled?: any }} */
    const out = {};

    assert.equal(device.LightEnable(3, true), D3D_OK);
    assert.equal(device.GetLightEnable(3, out), D3D_OK);
    assert.equal(out.enabled, LIGHT_ENABLED, 'an enabled light does not read back as one');

    assert.equal(device.GetLight(3, out), D3D_OK);
    assert.equal(out.light.Type, D3DLIGHTTYPE.DIRECTIONAL);
    assert.deepEqual(out.light.Direction, { x: 0.0, y: 0.0, z: 1.0 });
    assert.deepEqual(out.light.Diffuse, { r: 1.0, g: 1.0, b: 1.0, a: 0.0 });

    assert.equal(device.LightEnable(3, false), D3D_OK);
    assert.equal(device.GetLightEnable(3, out), D3D_OK);
    assert.equal(out.enabled, 0);

    assertFullyReleased(device);
});

test('a written light reads back, and writing one does not enable it', ()=>{
    const device = createDevice();
    /** @type {{ light?: any, enabled?: any }} */
    const out = {};
    const light = {
        Type: D3DLIGHTTYPE.POINT,
        Diffuse: { r: 2.0, g: 2.0, b: 2.0, a: 2.0 },
        Specular: { r: 3.0, g: 3.0, b: 3.0, a: 3.0 },
        Ambient: { r: 4.0, g: 4.0, b: 4.0, a: 4.0 },
        Position: { x: 5.0, y: 5.0, z: 5.0 },
        Direction: { x: 6.0, y: 6.0, z: 6.0 },
        Range: 7.0,
        Falloff: 8.0,
        Attenuation0: 9.0,
        Attenuation1: 10.0,
        Attenuation2: 11.0,
        Theta: 12.0,
        Phi: 13.0,
    };

    assert.equal(device.SetLight(1, light), D3D_OK);
    assert.equal(device.GetLight(1, out), D3D_OK);
    assert.deepEqual(out.light, light);

    assert.equal(device.GetLightEnable(1, out), D3D_OK);
    assert.equal(out.enabled, 0);

    assertFullyReleased(device);
});

test('an index past the reported light count is still a light', ()=>{
    const device = createDevice();
    /** @type {{ enabled?: any }} */
    const out = {};

    assert.equal(device.LightEnable(4096, true), D3D_OK);
    assert.equal(device.GetLightEnable(4096, out), D3D_OK);
    assert.equal(out.enabled, LIGHT_ENABLED);

    assertFullyReleased(device);
});

// --- device loss ---

test('a working device presents and reports no problem', ()=>{
    const device = createDevice();

    assert.equal(device.deviceState, DEVICE_STATE.OK);
    assert.equal(device.TestCooperativeLevel(), D3D_OK);
    assert.equal(device.Present(), D3D_OK);

    assertFullyReleased(device);
});

test('a lost device answers both questions with DEVICELOST', ()=>{
    const device = createDevice();

    device.injectDeviceLoss(false);
    assert.equal(device.TestCooperativeLevel(), D3DERR_DEVICELOST);
    assert.equal(device.Present(), D3DERR_DEVICELOST);
    assert.equal(device.Reset(), D3DERR_DEVICELOST, 'a device that is still lost cannot reset');

    assertFullyReleased(device);
});

test('a restorable device may be reset but still may not present', ()=>{
    const device = createDevice();

    device.injectDeviceLoss(true);
    assert.equal(device.TestCooperativeLevel(), D3DERR_DEVICENOTRESET);
    // The two answers differ on purpose: a program watching Present alone never
    // learns that the device has become resettable.
    assert.equal(device.Present(), D3DERR_DEVICELOST);

    assert.equal(device.Reset(), D3D_OK);
    assert.equal(device.TestCooperativeLevel(), D3D_OK);
    assert.equal(device.Present(), D3D_OK);

    assertFullyReleased(device);
});

// --- the reference-count contract ---

test('the implicit swap chain hands back an object of its own', ()=>{
    const device = createDevice();
    /** @type {{ swapChain?: any }} */
    const out = {};

    assert.equal(device.GetSwapChain(0, out), D3D_OK);
    assert.equal(device.refCount, 2, 'the swap chain took a reference on the device');
    assert.equal(out.swapChain.refCount, 1);

    assert.equal(out.swapChain.release(), 0);
    assert.equal(device.refCount, 1);

    assertFullyReleased(device);
});

test('render target zero and back buffer zero are the same surface', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const target = {};
    /** @type {{ surface?: any }} */
    const back = {};

    assert.equal(device.GetRenderTarget(0, target), D3D_OK);
    assert.equal(device.refCount, 2);
    assert.equal(target.surface.refCount, 1);

    assert.equal(device.GetBackBuffer(0, 0, 0, back), D3D_OK);
    assert.equal(back.surface, target.surface);
    // The second reference is on the same object, so the device gained nothing.
    assert.equal(device.refCount, 2);
    assert.equal(target.surface.refCount, 2);

    assert.equal(back.surface.release(), 1);
    assert.equal(target.surface.release(), 0);
    assert.equal(device.refCount, 1);

    assertFullyReleased(device);
});

test('an implicit surface at zero references may be addrefed again', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const out = {};

    assert.equal(device.GetRenderTarget(0, out), D3D_OK);
    const surface = out.surface;
    assert.equal(surface.release(), 0);
    assert.equal(device.refCount, 1);

    // The device still owns it, so this is not a resurrection: the pointer a
    // program kept is still the same surface.
    assert.equal(surface.addRef(), 1);
    assert.equal(device.refCount, 2);
    assert.equal(surface.release(), 0);
    assert.equal(device.refCount, 1);
    assert.equal(surface.release(), 0, 'releasing one that is already at zero is harmless');

    assertFullyReleased(device);
});

test('the automatic depth stencil counts like the other implicit surfaces', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const out = {};

    assert.equal(device.GetDepthStencilSurface(out), D3D_OK);
    assert.equal(device.refCount, 2);
    assert.equal(out.surface.refCount, 1);
    assert.equal(out.surface.release(), 0);
    assert.equal(device.refCount, 1);

    assertFullyReleased(device);
});

test('a device created without one has no depth stencil to hand back', ()=>{
    const device = createDevice({ parameters: { enableAutoDepthStencil: false } });
    // Seeded with something live, because that is the case the behaviour is
    // about: a program reuses the variable it last got a surface in, and tests
    // the pointer rather than the HRESULT.
    /** @type {{ surface?: any }} */
    const out = { surface: UNTOUCHED };

    assert.notEqual(device.GetDepthStencilSurface(out), D3D_OK);
    assert.equal(out.surface, null, 'the failure clears the caller\'s pointer');

    assertFullyReleased(device);
});

test('a texture and a surface level of it share one count', ()=>{
    const device = createDevice();
    /** @type {{ texture?: any }} */
    const texture = {};
    /** @type {{ surface?: any }} */
    const level = {};

    assert.equal(device.CreateTexture(32, 32, 3, 0, D3DFMT.X8R8G8B8, D3DPOOL.DEFAULT, texture),
        D3D_OK);
    assert.equal(device.refCount, 2, 'creating a resource takes a reference on the device');
    assert.equal(texture.texture.refCount, 1);

    assert.equal(texture.texture.GetSurfaceLevel(1, level), D3D_OK);
    assert.equal(device.refCount, 2, 'a level of an existing texture is not a new device user');
    assert.equal(texture.texture.refCount, 2);
    assert.equal(level.surface.refCount, 2, 'the two counts are one count');

    assert.equal(level.surface.addRef(), 3);
    assert.equal(texture.texture.refCount, 3);
    assert.equal(level.surface.release(), 2);

    assert.equal(texture.texture.release(), 1);
    assert.equal(level.surface.refCount, 1);
    assert.equal(level.surface.release(), 0);
    assert.equal(device.refCount, 1);

    assertFullyReleased(device);
});

test('binding a resource never changes its count', ()=>{
    const device = createDevice();
    /** @type {{ texture?: any }} */
    const texture = {};
    /** @type {{ buffer?: any }} */
    const vertices = {};
    /** @type {{ buffer?: any }} */
    const indices = {};

    assert.equal(device.CreateTexture(32, 32, 1, 0, D3DFMT.X8R8G8B8, D3DPOOL.DEFAULT, texture),
        D3D_OK);
    assert.equal(device.CreateVertexBuffer(512, 0, 0, D3DPOOL.DEFAULT, vertices), D3D_OK);
    assert.equal(device.CreateIndexBuffer(512, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.DEFAULT, indices),
        D3D_OK);

    assert.equal(device.SetTexture(0, texture.texture), D3D_OK);
    assert.equal(texture.texture.refCount, 1, 'binding is not owning');
    assert.equal(device.SetTexture(0, null), D3D_OK);
    assert.equal(texture.texture.refCount, 1, 'and unbinding gives nothing back');

    assert.equal(device.SetStreamSource(0, vertices.buffer, 0, 12), D3D_OK);
    assert.equal(vertices.buffer.refCount, 1);
    assert.equal(device.SetStreamSource(0, null, 0, 0), D3D_OK);
    assert.equal(vertices.buffer.refCount, 1);

    assert.equal(device.SetIndices(indices.buffer), D3D_OK);
    assert.equal(indices.buffer.refCount, 1);
    assert.equal(device.SetIndices(null), D3D_OK);
    assert.equal(indices.buffer.refCount, 1);

    texture.texture.release();
    vertices.buffer.release();
    indices.buffer.release();
    assertFullyReleased(device);
});

test('an unbound stream keeps the stride and offset of the previous binding', ()=>{
    const device = createDevice();
    /** @type {{ buffer?: any }} */
    const vertices = {};
    /** @type {{ buffer?: any, offset?: number, stride?: number }} */
    const out = {};

    assert.equal(device.CreateVertexBuffer(512, 0, 0, D3DPOOL.DEFAULT, vertices), D3D_OK);
    assert.equal(device.SetStreamSource(0, vertices.buffer, 4, 32), D3D_OK);
    assert.equal(device.SetStreamSource(0, null, 0, 0), D3D_OK);

    assert.equal(device.GetStreamSource(0, out), D3D_OK);
    assert.equal(out.buffer, null);
    assert.equal(out.stride, 32, 'clearing the whole record loses a stride the program reads back');
    assert.equal(out.offset, 4);
    assert.equal(vertices.buffer.refCount, 1, 'a null stream had nothing to add a reference to');

    assert.equal(device.SetStreamSource(0, vertices.buffer, 0, 0), D3D_OK);
    assert.equal(device.GetStreamSource(0, out), D3D_OK);
    assert.equal(out.buffer, vertices.buffer);
    assert.equal(out.offset, 0);
    assert.equal(out.stride, 0);
    assert.equal(vertices.buffer.refCount, 2, 'reading a bound stream hands out a reference');
    /** @type {any} */
    const bound = out.buffer;
    bound.release();

    assert.equal(device.SetStreamSource(0, null, 0, 0), D3D_OK);
    vertices.buffer.release();
    assertFullyReleased(device);
});

test('a leaked resource keeps the device alive, which is how a leak is noticed', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const out = {};

    assert.equal(device.CreateOffscreenPlainSurface(64, 64, D3DFMT.A8R8G8B8, D3DPOOL.DEFAULT, out),
        D3D_OK);
    assert.equal(device.release(), 1, 'the surface still holds the device');

    assert.equal(out.surface.release(), 0);
    assert.equal(device.refCount, 0);
});

test('a fresh device has a white material, not a black one', ()=>{
    // Geometry that never calls SetMaterial and carries no vertex colour takes
    // every lighting term from here. All zeros -- which is what an unseeded
    // structure holds -- lights such a model to black, and it disappears while
    // every state a program reads back still says what it expects.
    const device = createDevice();
    /** @type {{ material?: any }} */
    const out = {};

    assert.equal(device.GetMaterial(out), D3D_OK);
    assert.deepEqual(out.material.Diffuse, { r: 1, g: 1, b: 1, a: 1 });
    assert.deepEqual(out.material.Ambient, { r: 1, g: 1, b: 1, a: 1 });
    assert.deepEqual(out.material.Specular, { r: 0, g: 0, b: 0, a: 0 },
        'no highlight until a program asks for one');
    assert.deepEqual(out.material.Emissive, { r: 0, g: 0, b: 0, a: 0 }, 'and no glow');
    assert.equal(out.material.Power, 0);

    assertFullyReleased(device);
});
