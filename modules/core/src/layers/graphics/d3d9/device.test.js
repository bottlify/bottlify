/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3DERR_DEVICELOST, D3DERR_DEVICENOTRESET, D3DERR_INVALIDCALL, D3DERR_NOTAVAILABLE, D3DFMT,
    D3DLIGHTTYPE, D3DPOOL, D3DRS, D3DRTYPE, D3DSWAPEFFECT, D3DUSAGE, D3DZB, D3D_OK, dwordToFloat,
    floatToDword,
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

test('ValidateDevice refuses what the combiner does not draw, a filter of none included', ()=>{
    // Wine's d3d9 test_filter: a magnification or minification filter of
    // none is D3DERR_UNSUPPORTEDTEXTUREFILTER, with or without a texture.
    const device = createDevice();
    /** @type {{ passes?: number }} */
    const out = {};
    assert.equal(device.ValidateDevice(out), D3D_OK);
    assert.equal(out.passes, 1);
    assert.equal(device.SetSamplerState(0, 5, 0), D3D_OK, 'D3DSAMP_MAGFILTER, NONE');
    /** @type {{ passes?: number }} */
    const refused = {};
    assert.equal(device.ValidateDevice(refused), 0x88760822, 'D3DERR_UNSUPPORTEDTEXTUREFILTER');
    assert.equal(refused.passes, undefined);
    assert.equal(device.SetSamplerState(0, 5, 1), D3D_OK);
    assert.equal(device.SetTextureStageState(0, 1, 26), D3D_OK, 'D3DTOP_LERP');
    assert.equal(device.ValidateDevice(refused), 0x88760819, 'D3DERR_UNSUPPORTEDCOLOROPERATION');
    assert.equal(device.release(), 0);
});

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

// --- the block-compressed formats ---

test('a compressed texture is created whatever compressedTextures says -- the flag only'
    + ' chooses how its bytes travel to the GPU, never whether the format exists', ()=>{
    const d3d = createDirect3D9({});
    assert.equal(d3d.CheckDeviceFormat(0, D3DRTYPE.TEXTURE, D3DFMT.DXT1), D3D_OK,
        'legal on every device of the era, whatever the flag');
    const device = createDevice();
    /** @type {{ texture?: any }} */
    const out = {};
    assert.equal(
        device.CreateTexture(256, 256, 1, 0, D3DFMT.DXT1, D3DPOOL.MANAGED, out),
        D3D_OK,
        'compressedTextures defaults to false, and the create still succeeds');
    assert.ok(out.texture, 'the texture reached the caller');
    out.texture.release();
    assertFullyReleased(device);
});

test('a compressed texture is created when the backend can sample blocks too', ()=>{
    const device = createDevice({ caps: { compressedTextures: true } });
    /** @type {{ texture?: any }} */
    const out = {};
    assert.equal(
        device.CreateTexture(256, 256, 1, 0, D3DFMT.DXT5, D3DPOOL.MANAGED, out),
        D3D_OK);
    assert.ok(out.texture, 'the texture reached the caller');
    out.texture.release();
    assertFullyReleased(device);
});

test('nothing may be rendered into a compressed texture, whatever compressedTextures says', ()=>{
    const d3d = createDirect3D9({});
    assert.equal(d3d.CheckDeviceFormat(D3DUSAGE.RENDERTARGET, D3DRTYPE.TEXTURE, D3DFMT.DXT1),
        D3DERR_NOTAVAILABLE, 'nothing draws into blocks, whatever the flag');
    const device = createDevice();
    /** @type {{ texture?: any }} */
    const out = {};
    assert.equal(
        device.CreateTexture(256, 256, 1, D3DUSAGE.RENDERTARGET, D3DFMT.DXT1,
            D3DPOOL.DEFAULT, out),
        D3DERR_INVALIDCALL,
        'the blocks are not writable by the pipeline, whatever the adapter offers');
    assertFullyReleased(device);
});

test('a full-screen device\'s gamma ramp is the display\'s, and a windowed one\'s is kept', ()=>{
    // D3DCAPS2_FULLSCREENGAMMA: the ramp is the display's in full-screen mode;
    // windowed, SetGammaRamp succeeds and changes nothing on the screen.
    /** @type {any[][]} */
    const set = [];
    const gamma = {
        /** @param {any} owner @param {any} ramp */
        set: (owner, ramp)=>set.push([owner, ramp]),
        applies: ()=>true,
    };
    const channel = Uint16Array.from({ length: 256 }, (_, index)=>(255 - index) * 257);
    const inverted = { red: channel, green: channel.slice(), blue: channel.slice() };

    const windowed = createDevice({ caps: { gamma } });
    assert.equal(windowed.caps.fullscreenGamma, true, 'the display applies a ramp here');
    windowed.SetGammaRamp(inverted);
    assert.equal(set.length, 0, 'windowed: kept, not shown');
    /** @type {{ ramp?: any }} */
    const read = {};
    windowed.GetGammaRamp(read);
    assert.deepEqual([...read.ramp.red], [...channel]);
    assertFullyReleased(windowed);
    assert.equal(set.length, 0);

    const full = createDevice({ caps: { gamma }, parameters: { windowed: false } });
    full.SetGammaRamp(inverted);
    assert.equal(set.length, 1);
    assert.equal(set[0][0], full);
    assert.deepEqual([...set[0][1].blue], [...channel]);

    assert.equal(full.Reset({
        swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1, backBufferWidth: 640,
        backBufferHeight: 480, backBufferFormat: D3DFMT.X8R8G8B8, enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT.D24S8, windowed: true,
    }), D3D_OK);
    assert.deepEqual(set.at(-1), [full, null], 'reset to a window, the display is given back');
    assert.equal(full.Reset({
        swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1, backBufferWidth: 640,
        backBufferHeight: 480, backBufferFormat: D3DFMT.X8R8G8B8, enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT.D24S8, windowed: false,
    }), D3D_OK);
    assert.equal(set.at(-1)?.[1]?.red[0], 0xffff, 'and full-screen again, its ramp is shown');
    const count = set.length;
    assertFullyReleased(full);
    assert.deepEqual(set.at(-1), [full, null], 'the device\'s end gives the display back');
    assert.equal(set.length, count + 1);

    const headless = createDevice({ caps: { gamma: { set: ()=>{}, applies: ()=>false } } });
    assert.equal(headless.caps.fullscreenGamma, false);
    assertFullyReleased(headless);
    assert.equal(createDevice().caps.fullscreenGamma, false, 'nor without a display at all');
});

test('a buffer released to nothing while bound lives on until it is unbound', ()=>{
    // Wine's d3d9ex.c test_reset_ex: a vertex and an index buffer bound and
    // released are handed back by GetStreamSource and GetIndices, the same
    // objects; a buffer released while unbound goes at once, as before.
    let next = 0x10000;
    /** @type {number[]} */
    const freed = [];
    const d3d = createDirect3D9({
        /** @param {number} bytes */
        allocate: bytes=>(next += bytes + 0x100) - bytes - 0x100,
        /** @param {number} address */
        free: address=>{
            freed.push(address);
        },
    });
    /** @type {{ device?: any }} */
    const made = {};
    assert.equal(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT.DISCARD, backBufferWidth: 64, backBufferHeight: 64,
        backBufferFormat: D3DFMT.X8R8G8B8,
    }, made), D3D_OK);
    freed.length = 0;
    const device = made.device;
    const buffer = ()=>{
        /** @type {{ buffer?: any }} */
        const out = {};
        assert.equal(device.CreateVertexBuffer(16, 0, 0, D3DPOOL.DEFAULT, out), D3D_OK);
        return out.buffer;
    };

    const loose = buffer();
    assert.equal(loose.release(), 0);
    assert.equal(loose.destroyed, true, 'unbound, it goes with its last reference');
    assert.deepEqual(freed, [loose.base]);

    const vertices = buffer();
    assert.equal(device.SetStreamSource(0, vertices, 0, 16), D3D_OK);
    const deviceCount = device.refCount;
    assert.equal(vertices.release(), 0);
    assert.equal(vertices.destroyed, false, 'bound, it lives on');
    assert.equal(device.refCount, deviceCount - 1, 'holding no reference on the device');
    /** @type {{ buffer?: any, offset?: number, stride?: number }} */
    const bound = {};
    assert.equal(device.GetStreamSource(0, bound), D3D_OK);
    assert.equal(bound.buffer, vertices);
    assert.equal(vertices.release(), 0, 'the reference GetStreamSource took');

    /** @type {{ buffer?: any }} */
    const indexOut = {};
    assert.equal(device.CreateIndexBuffer(16, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.DEFAULT, indexOut),
        D3D_OK);
    const indices = indexOut.buffer;
    assert.equal(device.SetIndices(indices), D3D_OK);
    assert.equal(indices.release(), 0);
    /** @type {{ buffer?: any }} */
    const held = {};
    assert.equal(device.GetIndices(held), D3D_OK);
    assert.equal(held.buffer, indices);
    assert.equal(indices.release(), 0);

    freed.length = 0;
    assert.equal(device.SetStreamSource(0, null, 0, 0), D3D_OK);
    assert.equal(device.SetIndices(null), D3D_OK);
    assert.equal(vertices.destroyed, true, 'unbound at last, it goes');
    assert.equal(indices.destroyed, true);
    assert.deepEqual(freed.sort(), [vertices.base, indices.base].sort());

    // A buffer still bound when the device goes goes with it.
    const last = buffer();
    assert.equal(device.SetStreamSource(1, last, 0, 16), D3D_OK);
    assert.equal(last.release(), 0);
    assert.equal(device.release(), 0, 'the device holds no count for what it keeps bound');
    assert.equal(last.destroyed, true);
});

test('a state block moves the binding hold with the buffers it applies', ()=>{
    const device = createDevice();
    const buffer = ()=>{
        /** @type {{ buffer?: any }} */
        const out = {};
        assert.equal(device.CreateVertexBuffer(16, 0, 0, D3DPOOL.DEFAULT, out), D3D_OK);
        return out.buffer;
    };
    const first = buffer();
    const second = buffer();
    assert.equal(device.BeginStateBlock(), D3D_OK);
    assert.equal(device.SetStreamSource(0, second, 0, 16), D3D_OK);
    /** @type {{ block?: any }} */
    const out = {};
    assert.equal(device.EndStateBlock(out), D3D_OK);
    assert.equal(device.SetStreamSource(0, first, 0, 16), D3D_OK);
    assert.equal(first.release(), 0);
    assert.equal(first.destroyed, false);
    assert.equal(out.block.Apply(), D3D_OK);
    assert.equal(first.destroyed, true, 'replaced by the block, the released buffer goes');
    assert.equal(second.destroyed, false);
    assert.equal(second.release(), 0);
    assert.equal(second.destroyed, false, 'the block bound it, so it stays');
});

test('a signed bump-map format is a texture, sampled and never drawn into', ()=>{
    // Wine's d3d9 visual.c texbem_test assumes a ps_1_1 device makes V8U8
    // textures; the bump-map tests ask CheckDeviceFormat first.
    const d3d = createDirect3D9();
    const device = createDevice();
    for (const format of [D3DFMT.V8U8, D3DFMT.Q8W8V8U8])
    {
        assert.equal(d3d.CheckDeviceFormat(0, D3DRTYPE.TEXTURE, format), D3D_OK);
        assert.equal(d3d.CheckDeviceFormat(D3DUSAGE.RENDERTARGET, D3DRTYPE.TEXTURE, format),
            D3DERR_NOTAVAILABLE);
        assert.equal(d3d.CheckDeviceFormat(D3DUSAGE.AUTOGENMIPMAP, D3DRTYPE.TEXTURE, format),
            0x0876086f, 'D3DOK_NOAUTOGEN');
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateTexture(128, 128, 1, 0, format, D3DPOOL.MANAGED, out), D3D_OK);
        assert.equal(device.CreateTexture(128, 128, 1, D3DUSAGE.RENDERTARGET, format,
            D3DPOOL.DEFAULT, {}), D3DERR_INVALIDCALL);
        assert.equal(device.CreateRenderTarget(64, 64, format, false, {}), D3DERR_INVALIDCALL);
    }
});

test('a render target and a depth stencil released to nothing while set live on until replaced',
    ()=>{
        const device = createDevice();
        /** @type {{ surface?: any }} */
        const made = {};
        assert.equal(device.CreateRenderTarget(32, 32, D3DFMT.A8R8G8B8, false, made), D3D_OK);
        const target = made.surface;
        assert.equal(device.CreateDepthStencilSurface(32, 32, D3DFMT.D24S8, made), D3D_OK);
        const depth = made.surface;
        /** @type {{ surface?: any }} */
        const original = {};
        assert.equal(device.GetRenderTarget(0, original), D3D_OK);
        assert.equal(device.SetRenderTarget(0, target), D3D_OK);
        assert.equal(device.SetDepthStencilSurface(depth), D3D_OK);
        assert.equal(target.release(), 0);
        assert.equal(depth.release(), 0);
        assert.equal(target.destroyed, false, 'set, it lives on');
        /** @type {{ surface?: any }} */
        const out = {};
        assert.equal(device.GetRenderTarget(0, out), D3D_OK);
        assert.equal(out.surface, target, 'and is the one handed back');
        assert.equal(target.release(), 0);
        assert.equal(device.GetDepthStencilSurface(out), D3D_OK);
        assert.equal(out.surface, depth);
        assert.equal(depth.release(), 0);
        assert.equal(device.SetRenderTarget(0, original.surface), D3D_OK);
        assert.equal(device.SetDepthStencilSurface(null), D3D_OK);
        assert.equal(target.destroyed, true, 'replaced, it goes');
        assert.equal(depth.destroyed, true);
        original.surface.release();
        assertFullyReleased(device);
    });
