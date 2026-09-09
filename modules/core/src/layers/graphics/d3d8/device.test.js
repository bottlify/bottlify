/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3DCLEAR, D3DCREATE, D3DERR_DEVICELOST, D3DERR_DEVICENOTRESET, D3DERR_INVALIDCALL,
    D3DERR_NOTFOUND, D3DFMT, D3DFMT_INDEX, D3DLIGHTTYPE, D3DORDER, D3DPOOL, D3DPT, D3DRS, D3DRS_MAX,
    D3DPRESENTFLAG, D3DRS_REMOVED_IN_D3D9, D3DSWAPEFFECT, D3DTA, D3DTOP, D3DTS, D3DTSS,
    D3DUSAGE, D3D_OK,
    dwordToFloat, floatToDword, isShaderHandle,
} from './constants.js';
import { DEFAULT_STAGE_STATES } from './stagestates.js';
import { D3DRS as D3DRS9 } from '../d3d9/constants.js';
import { DEFAULT_RENDER_STATES, resolveRenderStateDefault } from './renderstates.js';
import { DEVICE_STATE, LIGHT_ENABLED, createDirect3D8 } from './device.js';

/** Distinguishes "the call wrote nothing" from "the call wrote a zero". */
const UNTOUCHED = Symbol('untouched');

const MAX_POINT_SIZE = 256.0;
const WIDTH = 640;
const HEIGHT = 480;

/** A vertex format, which is what SetVertexShader takes when it is not a handle. */
const FVF_XYZ_DIFFUSE = 0x042;

/** @type {number[]} */
const D3D9_STATES = Object.values(D3DRS9).map(Number);
/** @type {number[]} */
const D3D8_STATES = Object.values(D3DRS).map(Number);

/**
 * @param {{ caps?: object, parameters?: object, behaviourFlags?: number }} [options]
 */
function createDevice(options = {}){
    const d3d = createDirect3D8({ maxPointSize: MAX_POINT_SIZE, ...options.caps });
    /** @type {{ device?: any }} */
    const out = {};
    const parameters = {
        swapEffect: D3DSWAPEFFECT.DISCARD,
        backBufferCount: 1,
        backBufferWidth: WIDTH,
        backBufferHeight: HEIGHT,
        backBufferFormat: D3DFMT.X8R8G8B8,
        enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT.D24S8,
        ...options.parameters,
    };
    assert.equal(d3d.CreateDevice(parameters, out, options.behaviourFlags ?? 0), D3D_OK,
        'the fixture device is creatable');
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

// --- the state set, and where it parts from D3D9 ---

test('every D3D9 state up to the boundary exists here, and nothing above it does', ()=>{
    for (const [name, state] of Object.entries(D3DRS9))
    {
        if (state > D3DRS_MAX)
        {
            assert.equal(D3D8_STATES.includes(state), false, `${name} was added after D3D8`);
            continue;
        }
        assert.equal(D3D8_STATES.includes(state), true, `${name} is missing`);
    }
});

test('the six states D3D9 dropped are states here', ()=>{
    const device = createDevice();
    /** @type {{ value?: number }} */
    const out = {};

    for (const [name, state] of Object.entries(D3DRS_REMOVED_IN_D3D9))
    {
        assert.equal(D3D9_STATES.includes(state), false, `${name} should not be a D3D9 state`);
        assert.equal(device.GetRenderState(state, out), D3D_OK, name);
    }

    assertFullyReleased(device);
});

test('the two renamed states keep their numbers and change their names', ()=>{
    assert.equal(D3DRS.POSITIONORDER, D3DRS9.POSITIONDEGREE);
    assert.equal(D3DRS.NORMALORDER, D3DRS9.NORMALDEGREE);
    assert.equal(D3DRS.POSITIONDEGREE, undefined, 'the D3D9 spelling is not a D3D8 name');
    assert.equal(D3DRS.NORMALDEGREE, undefined);

    const position = DEFAULT_RENDER_STATES.find(entry=>entry.state === D3DRS.POSITIONORDER);
    const normal = DEFAULT_RENDER_STATES.find(entry=>entry.state === D3DRS.NORMALORDER);
    assert.equal(position?.name, 'POSITIONORDER');
    assert.equal(normal?.name, 'NORMALORDER');
});

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

    assert.equal(device.SetRenderTarget(target.surface, null), D3D_OK);
    assert.equal(device.EndScene(), D3DERR_INVALIDCALL, 'no scene was opened by the change');

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetRenderTarget(target.surface, null), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK, 'the scene survived the change');

    target.surface.release();
    assertFullyReleased(device);
});

// --- default device state ---

test('a fresh device reads back the documented default of every render state', ()=>{
    const device = createDevice();
    const inputs = {
        enableAutoDepthStencil: true,
        maxPointSize: MAX_POINT_SIZE,
        softwareVertexProcessing: false,
    };

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

test('the D3D8-only defaults are the ones D3D9 has no state for', ()=>{
    const device = createDevice();
    /** @type {{ value?: number }} */
    const out = {};

    assert.equal(device.GetRenderState(D3DRS.LINEPATTERN, out), D3D_OK);
    assert.equal(out.value, 0);
    assert.equal(device.GetRenderState(D3DRS.ZBIAS, out), D3D_OK);
    assert.equal(out.value, 0);
    assert.equal(device.GetRenderState(D3DRS.EDGEANTIALIAS, out), D3D_OK);
    assert.equal(out.value, 0);
    assert.equal(device.GetRenderState(D3DRS.ZVISIBLE, out), D3D_OK);
    assert.equal(out.value, 0);
    assert.equal(device.GetRenderState(D3DRS.PATCHSEGMENTS, out), D3D_OK);
    assert.equal(dwordToFloat(out.value ?? 0), 1.0);

    assert.equal(device.GetRenderState(D3DRS.POSITIONORDER, out), D3D_OK);
    assert.equal(out.value, D3DORDER.CUBIC);
    assert.equal(device.GetRenderState(D3DRS.NORMALORDER, out), D3D_OK);
    assert.equal(out.value, D3DORDER.LINEAR);

    assertFullyReleased(device);
});

test('SOFTWAREVERTEXPROCESSING follows the flags the device was created with', ()=>{
    /** @type {{ value?: number }} */
    const out = {};

    const hardware = createDevice();
    assert.equal(hardware.GetRenderState(D3DRS.SOFTWAREVERTEXPROCESSING, out), D3D_OK);
    assert.equal(out.value, 0);
    assertFullyReleased(hardware);

    const software = createDevice({
        behaviourFlags: D3DCREATE.SOFTWARE_VERTEXPROCESSING,
    });
    assert.equal(software.GetRenderState(D3DRS.SOFTWAREVERTEXPROCESSING, out), D3D_OK);
    assert.equal(out.value, 1);
    assertFullyReleased(software);
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

test('POINTSIZE_MAX follows the reported maximum point size', ()=>{
    const device = createDevice({ caps: { maxPointSize: 8.0 } });
    /** @type {{ value?: number }} */
    const out = {};

    assert.equal(device.GetRenderState(D3DRS.POINTSIZE_MAX, out), D3D_OK);
    assert.equal(dwordToFloat(out.value ?? 0), 8.0);

    assertFullyReleased(device);
});

test('a state D3D9 added is not a state here', ()=>{
    const device = createDevice();
    /** @type {{ value?: any }} */
    const out = { value: UNTOUCHED };

    assert.equal(device.SetRenderState(D3DRS9.SCISSORTESTENABLE, 1), D3DERR_INVALIDCALL);
    assert.equal(device.GetRenderState(D3DRS9.BLENDFACTOR, out), D3DERR_INVALIDCALL);
    assert.equal(device.GetRenderState(D3DRS9.WRAP8, out), D3DERR_INVALIDCALL);
    assert.equal(out.value, UNTOUCHED);

    assertFullyReleased(device);
});

test('Reset puts every render state back to its default', ()=>{
    const device = createDevice();
    /** @type {{ value?: number }} */
    const out = {};

    assert.equal(device.SetRenderState(D3DRS.ZBIAS, 7), D3D_OK);
    assert.equal(device.GetRenderState(D3DRS.ZBIAS, out), D3D_OK);
    assert.equal(out.value, 7);

    assert.equal(device.Reset(), D3D_OK);
    assert.equal(device.GetRenderState(D3DRS.ZBIAS, out), D3D_OK);
    assert.equal(out.value, 0);

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

test('enabling a light brings it into existence, at any index', ()=>{
    const device = createDevice();
    /** @type {{ light?: any, enabled?: any }} */
    const out = {};

    assert.equal(device.LightEnable(3, true), D3D_OK);
    assert.equal(device.GetLightEnable(3, out), D3D_OK);
    assert.ok(out.enabled, 'an enabled light reads back as true');

    assert.equal(device.GetLight(3, out), D3D_OK);
    assert.equal(out.light.Type, D3DLIGHTTYPE.DIRECTIONAL);
    assert.deepEqual(out.light.Direction, { x: 0.0, y: 0.0, z: 1.0 });

    // An index far past any reported maximum is still a light.
    assert.equal(device.LightEnable(4096, true), D3D_OK);
    assert.equal(device.GetLightEnable(4096, out), D3D_OK);
    assert.equal(out.enabled, LIGHT_ENABLED);

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

// --- the viewport, which is one value with two halves ---

test('a fresh device has the whole back buffer as its viewport', ()=>{
    const device = createDevice();
    /** @type {{ viewport?: any }} */
    const out = {};

    assert.equal(device.GetViewport(out), D3D_OK);
    assert.deepEqual(out.viewport,
        { X: 0, Y: 0, Width: WIDTH, Height: HEIGHT, MinZ: 0, MaxZ: 1 });

    assertFullyReleased(device);
});

test('the vertex-stage constants always match the rectangle', ()=>{
    const device = createDevice();

    assert.equal(device.SetViewport(
        { X: 10, Y: 20, Width: 30, Height: 40, MinZ: 0.25, MaxZ: 0.75 }), D3D_OK);

    const state = device.viewportState;
    assert.deepEqual(state.rect,
        { x: 10, y: 20, width: 30, height: 40, minDepth: 0.25, maxDepth: 0.75 });
    // The half that is invisible until the origin is not zero: a conversion
    // that scales by the extent and never subtracts the origin looks correct
    // for every viewport at (0, 0) and is wrong for every other one.
    assert.deepEqual(state.offset, [-10, -20]);
    assert.deepEqual(state.scale, [2 / 30, -2 / 40]);

    assertFullyReleased(device);
});

test('a viewport a program names in pixels lands on the pixel it names', ()=>{
    const device = createDevice();
    assert.equal(device.SetViewport(
        { X: 100, Y: 50, Width: 200, Height: 100, MinZ: 0, MaxZ: 1 }), D3D_OK);
    const { rect, offset, scale } = device.viewportState;

    // The two halves cancel: a pre-transformed vertex at the viewport's own
    // top-left is clip-space (-1, +1), and at its bottom-right (+1, -1).
    /**
     * @param {number} x
     * @param {number} y
     */
    const toClip = (x, y)=>[
        ((x + offset[0]) * scale[0]) - 1,
        ((y + offset[1]) * scale[1]) + 1,
    ];
    assert.deepEqual(toClip(rect.x, rect.y), [-1, 1]);
    assert.deepEqual(toClip(rect.x + rect.width, rect.y + rect.height), [1, -1]);

    assertFullyReleased(device);
});

test('a render target change resets the viewport to the whole new target', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const target = {};
    /** @type {{ viewport?: any }} */
    const out = {};

    assert.equal(device.CreateRenderTarget(128, 128, D3DFMT.A8R8G8B8, false, target), D3D_OK);
    assert.equal(device.SetRenderTarget(target.surface, null), D3D_OK);
    assert.equal(device.GetViewport(out), D3D_OK);
    assert.deepEqual(out.viewport, { X: 0, Y: 0, Width: 128, Height: 128, MinZ: 0, MaxZ: 1 });

    assert.equal(device.SetViewport(
        { X: 10, Y: 20, Width: 30, Height: 40, MinZ: 0.25, MaxZ: 0.75 }), D3D_OK);

    // Setting the target the device already has is still a change, and a small
    // viewport left over from an earlier pass must not stay latched.
    assert.equal(device.SetRenderTarget(target.surface, null), D3D_OK);
    assert.equal(device.GetViewport(out), D3D_OK);
    assert.deepEqual(out.viewport, { X: 0, Y: 0, Width: 128, Height: 128, MinZ: 0, MaxZ: 1 });

    target.surface.release();
    assertFullyReleased(device);
});

test('a viewport that does not fit the target is refused', ()=>{
    const device = createDevice();
    /** @type {{ viewport?: any }} */
    const out = {};

    assert.equal(device.SetViewport(
        { X: 0, Y: 0, Width: WIDTH + 1, Height: HEIGHT, MinZ: 0, MaxZ: 1 }), D3DERR_INVALIDCALL);
    assert.equal(device.SetViewport(
        { X: 0, Y: 0, Width: 0, Height: HEIGHT, MinZ: 0, MaxZ: 1 }), D3DERR_INVALIDCALL);

    assert.equal(device.GetViewport(out), D3D_OK);
    assert.equal(out.viewport.Width, WIDTH, 'the refused call changed nothing');

    assertFullyReleased(device);
});

// --- both targets, bound by one call ---

test('a null colour target keeps the one that is bound and unbinds the depth stencil', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const before = {};
    /** @type {{ surface?: any }} */
    const after = {};

    assert.equal(device.GetRenderTarget(before), D3D_OK);
    assert.equal(device.SetRenderTarget(null, null), D3D_OK);

    assert.equal(device.GetRenderTarget(after), D3D_OK);
    assert.equal(after.surface, before.surface, 'a null colour target is not an unbind');

    /** @type {{ surface?: any }} */
    const depth = { surface: UNTOUCHED };
    assert.equal(device.GetDepthStencilSurface(depth), D3DERR_NOTFOUND,
        'a null depth stencil is');
    assert.equal(depth.surface, null,
        'the failure writes null rather than leaving a stale pointer');

    before.surface.release();
    after.surface.release();
    assertFullyReleased(device);
});

test('a surface without the matching usage cannot be bound as either target', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const plain = {};
    /** @type {{ surface?: any }} */
    const target = {};
    /** @type {{ surface?: any }} */
    const depth = {};

    assert.equal(device.CreateImageSurface(64, 64, D3DFMT.A8R8G8B8, plain), D3D_OK);
    assert.equal(device.CreateRenderTarget(64, 64, D3DFMT.A8R8G8B8, false, target), D3D_OK);
    assert.equal(device.CreateDepthStencilSurface(64, 64, D3DFMT.D24S8, depth), D3D_OK);

    assert.equal(device.SetRenderTarget(plain.surface, null), D3DERR_INVALIDCALL);
    assert.equal(device.SetRenderTarget(depth.surface, null), D3DERR_INVALIDCALL,
        'a depth stencil is not a colour target');
    assert.equal(device.SetRenderTarget(target.surface, plain.surface), D3DERR_INVALIDCALL);
    assert.equal(device.SetRenderTarget(target.surface, target.surface), D3DERR_INVALIDCALL,
        'a colour target is not a depth stencil');

    assert.equal(device.SetRenderTarget(target.surface, depth.surface), D3D_OK);

    assert.equal(device.SetRenderTarget(null, null), D3D_OK);
    plain.surface.release();
    target.surface.release();
    depth.surface.release();
    assertFullyReleased(device);
});

// --- device loss and Reset ---

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

test('an outstanding default-pool resource makes Reset answer DEVICELOST', ()=>{
    const device = createDevice();
    /** @type {{ texture?: any }} */
    const texture = {};

    assert.equal(device.CreateTexture(16, 16, 1, 0, D3DFMT.R5G6B5, D3DPOOL.DEFAULT, texture),
        D3D_OK);
    // This is the version difference: D3D9 answers INVALIDCALL here. Both
    // versions then report the device resettable, so the second answer cannot
    // be used to tell the two situations apart.
    assert.equal(device.Reset(), D3DERR_DEVICELOST);
    assert.equal(device.TestCooperativeLevel(), D3DERR_DEVICENOTRESET);

    assert.equal(texture.texture.release(), 0);
    assert.equal(device.Reset(), D3D_OK);
    assert.equal(device.TestCooperativeLevel(), D3D_OK);

    assertFullyReleased(device);
});

test('a resource outside the default pool never blocks a Reset', ()=>{
    const device = createDevice();
    /** @type {{ texture?: any }} */
    const managed = {};
    /** @type {{ surface?: any }} */
    const image = {};

    assert.equal(device.CreateTexture(16, 16, 1, 0, D3DFMT.R5G6B5, D3DPOOL.MANAGED, managed),
        D3D_OK);
    assert.equal(device.CreateImageSurface(16, 16, D3DFMT.X8R8G8B8, image), D3D_OK);

    assert.equal(device.Reset(), D3D_OK);
    assert.equal(device.TestCooperativeLevel(), D3D_OK);

    managed.texture.release();
    image.surface.release();
    assertFullyReleased(device);
});

test('a reference on one of the device own surfaces blocks a Reset too', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const out = {};

    assert.equal(device.GetRenderTarget(out), D3D_OK);
    assert.equal(device.Reset(), D3DERR_DEVICELOST);
    assert.equal(device.TestCooperativeLevel(), D3DERR_DEVICENOTRESET);

    assert.equal(out.surface.release(), 0);
    assert.equal(device.Reset(), D3D_OK);

    assertFullyReleased(device);
});

test('Reset rebuilds the implicit resources from the parameters it is given', ()=>{
    const device = createDevice({ parameters: { enableAutoDepthStencil: false } });
    /** @type {{ surface?: any }} */
    const out = {};

    assert.equal(device.GetDepthStencilSurface(out), D3DERR_NOTFOUND);

    const withDepth = {
        swapEffect: D3DSWAPEFFECT.DISCARD,
        backBufferCount: 1,
        backBufferWidth: 320,
        backBufferHeight: 240,
        backBufferFormat: D3DFMT.X8R8G8B8,
        enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT.D24S8,
    };
    assert.equal(device.Reset(withDepth), D3D_OK);
    assert.equal(device.GetDepthStencilSurface(out), D3D_OK);
    assert.ok(out.surface);
    out.surface.release();

    /** @type {{ viewport?: any }} */
    const viewport = {};
    assert.equal(device.GetViewport(viewport), D3D_OK);
    assert.deepEqual(viewport.viewport,
        { X: 0, Y: 0, Width: 320, Height: 240, MinZ: 0, MaxZ: 1 });

    assert.equal(device.Reset({ ...withDepth, enableAutoDepthStencil: false }), D3D_OK);
    assert.equal(device.GetDepthStencilSurface(out), D3DERR_NOTFOUND);

    assertFullyReleased(device);
});

test('Reset restores the back buffer as the colour target', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const target = {};
    /** @type {{ surface?: any }} */
    const current = {};
    /** @type {{ surface?: any }} */
    const back = {};

    assert.equal(device.CreateRenderTarget(128, 128, D3DFMT.A8R8G8B8, false, target), D3D_OK);
    assert.equal(device.SetRenderTarget(target.surface, null), D3D_OK);
    assert.equal(target.surface.release(), 0, 'the device is the only holder now');

    assert.equal(device.Reset(), D3D_OK);
    assert.equal(device.GetRenderTarget(current), D3D_OK);
    assert.equal(device.GetBackBuffer(0, 0, back), D3D_OK);
    assert.equal(current.surface, back.surface);

    current.surface.release();
    back.surface.release();
    assertFullyReleased(device);
});

// --- the reference-count contract ---

test('the colour target and back buffer zero are the same surface', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const target = {};
    /** @type {{ surface?: any }} */
    const back = {};

    assert.equal(device.GetRenderTarget(target), D3D_OK);
    assert.equal(device.refCount, 2);
    assert.equal(target.surface.refCount, 1);

    assert.equal(device.GetBackBuffer(0, 0, back), D3D_OK);
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

    assert.equal(device.GetRenderTarget(out), D3D_OK);
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

test('a back buffer past the count is not a back buffer', ()=>{
    const device = createDevice({ parameters: { backBufferCount: 2 } });
    /** @type {{ surface?: any }} */
    const out = { surface: UNTOUCHED };

    assert.equal(device.GetBackBuffer(1, 0, out), D3D_OK);
    out.surface.release();
    out.surface = UNTOUCHED;
    assert.equal(device.GetBackBuffer(2, 0, out), D3DERR_INVALIDCALL);
    assert.equal(out.surface, UNTOUCHED);

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
    assert.equal(level.surface.refCount, 2, 'the two counts are one count');

    assert.equal(texture.texture.release(), 1);
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
    assert.equal(device.CreateIndexBuffer(512, 0, D3DFMT.UNKNOWN, D3DPOOL.DEFAULT, indices),
        D3D_OK);

    assert.equal(device.SetTexture(0, texture.texture), D3D_OK);
    assert.equal(texture.texture.refCount, 1, 'binding is not owning');
    assert.equal(device.SetTexture(0, null), D3D_OK);
    assert.equal(texture.texture.refCount, 1, 'and unbinding gives nothing back');

    assert.equal(device.SetStreamSource(0, vertices.buffer, 12), D3D_OK);
    assert.equal(vertices.buffer.refCount, 1);
    assert.equal(device.SetStreamSource(0, null, 0), D3D_OK);
    assert.equal(vertices.buffer.refCount, 1);

    assert.equal(device.SetIndices(indices.buffer, 0), D3D_OK);
    assert.equal(indices.buffer.refCount, 1);
    assert.equal(device.SetIndices(null, 0), D3D_OK);
    assert.equal(indices.buffer.refCount, 1);

    texture.texture.release();
    vertices.buffer.release();
    indices.buffer.release();
    assertFullyReleased(device);
});

test('an unbound stream keeps the stride of the previous binding', ()=>{
    const device = createDevice();
    /** @type {{ buffer?: any }} */
    const vertices = {};
    /** @type {{ buffer?: any, stride?: number }} */
    const out = {};

    assert.equal(device.CreateVertexBuffer(512, 0, 0, D3DPOOL.DEFAULT, vertices), D3D_OK);
    assert.equal(device.SetStreamSource(0, vertices.buffer, 32), D3D_OK);
    assert.equal(device.SetStreamSource(0, null, 0), D3D_OK);

    assert.equal(device.GetStreamSource(0, out), D3D_OK);
    assert.equal(out.buffer, null);
    assert.equal(out.stride, 32, 'clearing the whole record loses a stride the program reads back');
    assert.equal(vertices.buffer.refCount, 1, 'a null stream had nothing to add a reference to');

    assert.equal(device.SetStreamSource(0, vertices.buffer, 0), D3D_OK);
    assert.equal(device.GetStreamSource(0, out), D3D_OK);
    assert.equal(out.buffer, vertices.buffer);
    assert.equal(out.stride, 0);
    assert.equal(vertices.buffer.refCount, 2, 'reading a bound stream hands out a reference');
    /** @type {any} */
    const bound = out.buffer;
    bound.release();

    assert.equal(device.SetStreamSource(0, null, 0), D3D_OK);
    vertices.buffer.release();
    assertFullyReleased(device);
});

test('the base vertex index travels with the index binding', ()=>{
    const device = createDevice();
    /** @type {{ buffer?: any }} */
    const indices = {};
    /** @type {{ buffer?: any, baseVertexIndex?: number }} */
    const out = {};

    assert.equal(device.CreateIndexBuffer(512, 0, D3DFMT.UNKNOWN, D3DPOOL.DEFAULT, indices),
        D3D_OK);
    assert.equal(device.SetIndices(indices.buffer, 12), D3D_OK);
    assert.equal(device.GetIndices(out), D3D_OK);
    assert.equal(out.buffer, indices.buffer);
    assert.equal(out.baseVertexIndex, 12);
    out.buffer.release();

    assert.equal(device.SetIndices(null, 0), D3D_OK);
    indices.buffer.release();
    assertFullyReleased(device);
});

test('a leaked resource keeps the device alive, which is how a leak is noticed', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const out = {};

    assert.equal(device.CreateImageSurface(64, 64, D3DFMT.A8R8G8B8, out), D3D_OK);
    assert.equal(device.release(), 1, 'the surface still holds the device');

    assert.equal(out.surface.release(), 0);
    assert.equal(device.refCount, 0);
});

// --- shaders, which are handles rather than objects ---

test('creating a shader takes no reference on the device', ()=>{
    const device = createDevice();
    /** @type {{ handle?: number }} */
    const vertex = {};
    /** @type {{ handle?: number }} */
    const pixel = {};

    assert.equal(device.CreateVertexShader([0], [0], vertex), D3D_OK);
    assert.equal(device.refCount, 1, 'a handle is not an object with a lifetime');
    assert.equal(device.CreatePixelShader([0], pixel), D3D_OK);
    assert.equal(device.refCount, 1);

    assert.equal(device.DeleteVertexShader(vertex.handle ?? 0), D3D_OK);
    assert.equal(device.DeletePixelShader(pixel.handle ?? 0), D3D_OK);
    assertFullyReleased(device);
});

test('a vertex format passed to SetVertexShader reads back unchanged', ()=>{
    const device = createDevice();
    /** @type {{ handle?: number }} */
    const out = {};

    assert.equal(isShaderHandle(FVF_XYZ_DIFFUSE), false, 'no legal FVF looks like a handle');
    assert.equal(device.SetVertexShader(FVF_XYZ_DIFFUSE), D3D_OK);
    assert.equal(device.GetVertexShader(out), D3D_OK);
    assert.equal(out.handle, FVF_XYZ_DIFFUSE);
    assert.equal(device.stageProcessing.fixedFunctionVertex, true);
    assert.equal(device.stageProcessing.fvf, FVF_XYZ_DIFFUSE);
    assert.equal(device.stageProcessing.vertexShader, 0);

    assertFullyReleased(device);
});

test('a created shader is not bound by its creation', ()=>{
    const device = createDevice();
    /** @type {{ handle?: number }} */
    const shader = {};
    /** @type {{ handle?: number }} */
    const out = {};

    assert.equal(device.CreateVertexShader([0], [0], shader), D3D_OK);
    assert.equal(device.GetVertexShader(out), D3D_OK);
    assert.equal(out.handle, 0, 'creating a shader does not set it');

    assert.equal(device.SetVertexShader(shader.handle ?? 0), D3D_OK);
    assert.equal(device.GetVertexShader(out), D3D_OK);
    assert.equal(out.handle, shader.handle);
    assert.equal(device.stageProcessing.fixedFunctionVertex, false);
    assert.equal(device.stageProcessing.fvf, 0);

    assert.equal(device.DeleteVertexShader(shader.handle ?? 0), D3D_OK);
    assertFullyReleased(device);
});

test('a shader handle is never mistaken for a vertex format', ()=>{
    const device = createDevice();
    /** @type {{ handle?: number }} */
    const first = {};
    /** @type {{ handle?: number }} */
    const second = {};

    assert.equal(device.CreateVertexShader([0], [0], first), D3D_OK);
    assert.equal(device.CreateVertexShader([0], [0], second), D3D_OK);
    assert.notEqual(first.handle, second.handle);
    for (const handle of [first.handle ?? 0, second.handle ?? 0])
    {
        assert.notEqual(handle, 0, 'zero means no binding and can never be a handle');
        assert.equal(isShaderHandle(handle), true);
    }

    assert.equal(device.DeleteVertexShader(first.handle ?? 0), D3D_OK);
    assert.equal(device.DeleteVertexShader(second.handle ?? 0), D3D_OK);
    assertFullyReleased(device);
});

test('deleting the bound shader unbinds it and deleting another does not', ()=>{
    const device = createDevice();
    /** @type {{ handle?: number }} */
    const bound = {};
    /** @type {{ handle?: number }} */
    const other = {};
    /** @type {{ handle?: number }} */
    const out = {};

    assert.equal(device.CreateVertexShader([0], [0], bound), D3D_OK);
    assert.equal(device.CreateVertexShader([0], [0], other), D3D_OK);
    assert.equal(device.SetVertexShader(bound.handle ?? 0), D3D_OK);

    assert.equal(device.DeleteVertexShader(other.handle ?? 0), D3D_OK);
    assert.equal(device.GetVertexShader(out), D3D_OK);
    assert.equal(out.handle, bound.handle, 'deleting a different shader changed the binding');

    assert.equal(device.DeleteVertexShader(bound.handle ?? 0), D3D_OK);
    assert.equal(device.GetVertexShader(out), D3D_OK);
    assert.equal(out.handle, 0);

    // A double delete is an error, which is what makes the handle space
    // honest: a stale handle is refused rather than silently accepted.
    assert.equal(device.DeleteVertexShader(bound.handle ?? 0), D3DERR_INVALIDCALL);
    assert.equal(device.DeleteVertexShader(other.handle ?? 0), D3DERR_INVALIDCALL);

    assertFullyReleased(device);
});

test('the two shader stages are independent questions', ()=>{
    const device = createDevice();
    /** @type {{ handle?: number }} */
    const pixel = {};
    /** @type {{ handle?: number }} */
    const out = {};

    assert.equal(device.CreatePixelShader([0], pixel), D3D_OK);
    assert.equal(device.GetPixelShader(out), D3D_OK);
    assert.equal(out.handle, 0, 'creating a pixel shader does not set it either');

    assert.equal(device.SetVertexShader(FVF_XYZ_DIFFUSE), D3D_OK);
    assert.equal(device.SetPixelShader(pixel.handle ?? 0), D3D_OK);

    // A fixed-function vertex stage with a pixel shader bound is an ordinary
    // combination. A flag derived from the vertex side alone drops the shader.
    const processing = device.stageProcessing;
    assert.equal(processing.fixedFunctionVertex, true);
    assert.equal(processing.pixelShader, pixel.handle);

    assert.equal(device.DeletePixelShader(pixel.handle ?? 0), D3D_OK);
    assert.equal(device.GetPixelShader(out), D3D_OK);
    assert.equal(out.handle, 0);

    assertFullyReleased(device);
});

test('a handle from one shader kind is not a handle of the other', ()=>{
    const device = createDevice();
    /** @type {{ handle?: number }} */
    const vertex = {};

    assert.equal(device.CreateVertexShader([0], [0], vertex), D3D_OK);
    assert.equal(device.SetPixelShader(vertex.handle ?? 0), D3DERR_INVALIDCALL);
    assert.equal(device.DeletePixelShader(vertex.handle ?? 0), D3DERR_INVALIDCALL);
    assert.equal(device.SetVertexShader(vertex.handle ?? 0), D3D_OK);

    assert.equal(device.DeleteVertexShader(vertex.handle ?? 0), D3D_OK);
    assertFullyReleased(device);
});

// --- CopyRects, which D3D9 does not have ---

test('a depth stencil is refused on either side of a CopyRects', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const first = {};
    /** @type {{ surface?: any }} */
    const second = {};
    /** @type {{ surface?: any }} */
    const colour = {};

    assert.equal(device.CreateDepthStencilSurface(64, 64, D3DFMT.D24S8, first), D3D_OK);
    assert.equal(device.CreateDepthStencilSurface(64, 64, D3DFMT.D24S8, second), D3D_OK);
    assert.equal(device.CreateRenderTarget(64, 64, D3DFMT.A8R8G8B8, false, colour), D3D_OK);
    const rects = [{ left: 0, top: 0, right: 64, bottom: 64 }];
    const points = [{ x: 0, y: 0 }];

    assert.equal(device.CopyRects(first.surface, null, 0, second.surface, null),
        D3DERR_INVALIDCALL, 'no combination of depth surfaces works');
    assert.equal(device.CopyRects(first.surface, rects, 1, second.surface, points),
        D3DERR_INVALIDCALL);
    assert.equal(device.CopyRects(first.surface, rects, 1, colour.surface, points),
        D3DERR_INVALIDCALL, 'nor a depth to colour blit');

    first.surface.release();
    second.surface.release();
    colour.surface.release();
    assertFullyReleased(device);
});

test('CopyRects cannot stretch and cannot leave either surface', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const source = {};
    /** @type {{ surface?: any }} */
    const small = {};
    /** @type {{ surface?: any }} */
    const same = {};

    assert.equal(device.CreateImageSurface(64, 64, D3DFMT.A8R8G8B8, source), D3D_OK);
    assert.equal(device.CreateImageSurface(32, 32, D3DFMT.A8R8G8B8, small), D3D_OK);
    assert.equal(device.CreateImageSurface(64, 64, D3DFMT.A8R8G8B8, same), D3D_OK);

    assert.equal(device.CopyRects(source.surface, null, 0, same.surface, null), D3D_OK);
    assert.equal(device.CopyRects(source.surface, null, 0, small.surface, null),
        D3DERR_INVALIDCALL, 'a whole-surface copy has no room to scale');

    assert.equal(device.CopyRects(source.surface,
        [{ left: 0, top: 0, right: 32, bottom: 32 }], 1, small.surface, [{ x: 0, y: 0 }]), D3D_OK);
    const offEdge = device.CopyRects(source.surface,
        [{ left: 0, top: 0, right: 32, bottom: 32 }], 1, small.surface, [{ x: 8, y: 8 }]);
    assert.equal(offEdge, D3DERR_INVALIDCALL, 'the copy would run off the destination');
    const offSource = device.CopyRects(source.surface,
        [{ left: 0, top: 0, right: 96, bottom: 32 }], 1, same.surface, [{ x: 0, y: 0 }]);
    assert.equal(offSource, D3DERR_INVALIDCALL, 'the rectangle is not inside the source');
    const inverted = device.CopyRects(source.surface,
        [{ left: 0, top: 32, right: 32, bottom: 0 }], 1, same.surface, [{ x: 0, y: 0 }]);
    assert.equal(inverted, D3DERR_INVALIDCALL, 'the edges are the wrong way round');

    source.surface.release();
    small.surface.release();
    same.surface.release();
    assertFullyReleased(device);
});

test('CopyRects refuses a format it would have to convert', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const source = {};
    /** @type {{ surface?: any }} */
    const destination = {};

    assert.equal(device.CreateImageSurface(64, 64, D3DFMT.A8R8G8B8, source), D3D_OK);
    assert.equal(device.CreateImageSurface(64, 64, D3DFMT.R5G6B5, destination), D3D_OK);

    assert.equal(device.CopyRects(source.surface, null, 0, destination.surface, null),
        D3DERR_INVALIDCALL);

    source.surface.release();
    destination.surface.release();
    assertFullyReleased(device);
});

// --- image surfaces, where D3D9 has offscreen plain ones ---

test('an image surface is always system memory with no usage', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const out = {};

    assert.equal(device.CreateImageSurface(128, 128, D3DFMT.A8R8G8B8, out), D3D_OK);
    /** @type {{ desc?: any }} */
    const desc = {};
    assert.equal(out.surface.GetDesc(desc), D3D_OK);
    assert.equal(desc.desc.Pool, D3DPOOL.SYSTEMMEM, 'there is no pool parameter to disagree with');
    assert.equal(desc.desc.Usage, 0);

    // Which is also why it always answers a lock, and why an unpaired unlock
    // is still an error.
    assert.equal(out.surface.UnlockRect(), D3DERR_INVALIDCALL);
    /** @type {{ pBits?: number, Pitch?: number }} */
    const locked = {};
    assert.equal(out.surface.LockRect(locked), D3D_OK);
    assert.equal(locked.Pitch, 128 * 4);
    assert.equal(out.surface.UnlockRect(), D3D_OK);
    assert.equal(out.surface.UnlockRect(), D3DERR_INVALIDCALL);

    out.surface.release();
    assertFullyReleased(device);
});

test('an image surface of a depth format follows what the adapter reports', ()=>{
    const refusing = createDevice();
    /** @type {{ surface?: any }} */
    const refused = { surface: UNTOUCHED };
    assert.equal(refusing.CreateImageSurface(64, 64, D3DFMT.D24S8, refused), D3DERR_INVALIDCALL);
    assert.equal(refused.surface, UNTOUCHED);
    assertFullyReleased(refusing);

    const offering = createDevice({ caps: { depthPlain: true } });
    /** @type {{ surface?: any }} */
    const created = {};
    assert.equal(offering.CreateImageSurface(64, 64, D3DFMT.D24S8, created), D3D_OK);
    created.surface.release();
    assertFullyReleased(offering);
});

// --- what the device writes back into the parameters it was handed ---

test('creating a device reports the back buffer count and nothing else', ()=>{
    const d3d = createDirect3D8();
    /** @type {{ device?: any }} */
    const out = {};
    const parameters = {
        swapEffect: D3DSWAPEFFECT.DISCARD,
        backBufferCount: 0,
        backBufferWidth: 0,
        backBufferHeight: 0,
        backBufferFormat: D3DFMT.X8R8G8B8,
        windowed: true,
    };

    assert.equal(d3d.CreateDevice(parameters, out), D3D_OK);
    assert.equal(parameters.backBufferCount, 1, 'zero is reported back as one');
    // D3D9 resolves a zero extent to the client area and says so here; this
    // version leaves the zero the caller wrote, so a program that reads the
    // width back learns nothing.
    assert.equal(parameters.backBufferWidth, 0);
    assert.equal(parameters.backBufferHeight, 0);
    assert.equal(parameters.swapEffect, D3DSWAPEFFECT.DISCARD);

    assertFullyReleased(out.device);
});

test('a device with no explicit extent still has a viewport', ()=>{
    const device = createDevice({ parameters: { backBufferWidth: 0, backBufferHeight: 0 } });
    /** @type {{ viewport?: any }} */
    const out = {};

    assert.equal(device.GetViewport(out), D3D_OK);
    assert.ok(out.viewport.Width > 0 && out.viewport.Height > 0);

    assertFullyReleased(device);
});

test('an unusable usage combination is refused whatever the entry point', ()=>{
    const device = createDevice();
    /** @type {{ texture?: any }} */
    const out = {};

    assert.equal(
        device.CreateTexture(16, 16, 1, D3DUSAGE.RENDERTARGET, D3DFMT.X8R8G8B8, D3DPOOL.MANAGED,
            out),
        D3DERR_INVALIDCALL, 'a managed render target is not a thing');
    assert.equal(
        device.CreateTexture(16, 16, 1, D3DUSAGE.WRITEONLY, D3DFMT.X8R8G8B8, D3DPOOL.DEFAULT, out),
        D3DERR_INVALIDCALL, 'nor a write-only texture');
    assert.equal(
        device.CreateTexture(16, 16, 1, 0, D3DFMT.D24S8, D3DPOOL.DEFAULT, out),
        D3DERR_INVALIDCALL, 'nor a depth texture the adapter does not offer');

    assertFullyReleased(device);
});

// --- texture stages, transforms and the material: state a draw reads ---

test('stage zero modulates the texture by default and every other stage is off', ()=>{
    const device = createDevice();
    /** @type {{ value?: number }} */
    const out = {};

    assert.equal(device.GetTextureStageState(0, D3DTSS.COLOROP, out), D3D_OK);
    assert.equal(out.value, D3DTOP.MODULATE);
    assert.equal(device.GetTextureStageState(0, D3DTSS.ALPHAOP, out), D3D_OK);
    assert.equal(out.value, D3DTOP.SELECTARG1);
    for (let stage = 1; stage < 8; stage++)
    {
        assert.equal(device.GetTextureStageState(stage, D3DTSS.COLOROP, out), D3D_OK);
        assert.equal(out.value, D3DTOP.DISABLE, `stage ${stage} is off until armed`);
        assert.equal(device.GetTextureStageState(stage, D3DTSS.TEXCOORDINDEX, out), D3D_OK);
        assert.equal(out.value, stage, 'and reads its own coordinate set');
    }
    assert.equal(device.GetTextureStageState(3, D3DTSS.COLORARG1, out), D3D_OK);
    assert.equal(out.value, D3DTA.TEXTURE);
    assert.equal(device.GetTextureStageState(3, D3DTSS.COLORARG2, out), D3D_OK);
    assert.equal(out.value, D3DTA.CURRENT);
    for (const entry of DEFAULT_STAGE_STATES)
    {
        assert.equal(device.GetTextureStageState(5, entry.state, out), D3D_OK, entry.name);
    }

    assertFullyReleased(device);
});

test('a stage state reads back what was written, and Reset puts it back', ()=>{
    const device = createDevice();
    /** @type {{ value?: number }} */
    const out = {};

    assert.equal(device.SetTextureStageState(2, D3DTSS.COLOROP, D3DTOP.ADD), D3D_OK);
    assert.equal(device.GetTextureStageState(2, D3DTSS.COLOROP, out), D3D_OK);
    assert.equal(out.value, D3DTOP.ADD);
    assert.equal(device.SetTextureStageState(8, D3DTSS.COLOROP, D3DTOP.ADD), D3DERR_INVALIDCALL,
        'there are eight stages');
    assert.equal(device.SetTextureStageState(0, 99, 1), D3DERR_INVALIDCALL, 'not a stage state');
    assert.equal(device.GetTextureStageState(0, 99, out), D3DERR_INVALIDCALL);

    assert.equal(device.Reset(), D3D_OK);
    assert.equal(device.GetTextureStageState(2, D3DTSS.COLOROP, out), D3D_OK);
    assert.equal(out.value, D3DTOP.DISABLE);

    assertFullyReleased(device);
});

test('a transform never written is the identity, and a written one reads back', ()=>{
    const device = createDevice();
    /** @type {{ matrix?: Float32Array }} */
    const out = {};
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const translated = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 5, 6, 1];

    assert.equal(device.GetTransform(D3DTS.VIEW, out), D3D_OK);
    assert.deepEqual([...(out.matrix ?? [])], identity);
    assert.equal(device.SetTransform(D3DTS.WORLD + 3, translated), D3D_OK, 'world matrix three');
    assert.equal(device.GetTransform(D3DTS.WORLD + 3, out), D3D_OK);
    assert.deepEqual([...(out.matrix ?? [])], translated);
    assert.equal(device.GetTransform(D3DTS.WORLD, out), D3D_OK);
    assert.deepEqual([...(out.matrix ?? [])], identity, 'world matrix zero is another matrix');
    assert.equal(device.SetTransform(4, identity), D3DERR_INVALIDCALL, 'not a transform');
    assert.equal(device.SetTransform(D3DTS.VIEW, [1, 2, 3]), D3DERR_INVALIDCALL, 'not a matrix');

    assert.equal(device.Reset(), D3D_OK);
    assert.equal(device.GetTransform(D3DTS.WORLD + 3, out), D3D_OK);
    assert.deepEqual([...(out.matrix ?? [])], identity, 'Reset forgets every transform');

    assertFullyReleased(device);
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

test('the material reads back as a copy of what was set', ()=>{
    const device = createDevice();
    /** @type {{ material?: any }} */
    const out = {};
    const material = {
        Diffuse: { r: 1, g: 0.5, b: 0.25, a: 1 },
        Ambient: { r: 0, g: 0, b: 0, a: 0 },
        Specular: { r: 0, g: 0, b: 0, a: 0 },
        Emissive: { r: 0.1, g: 0.2, b: 0.3, a: 0 },
        Power: 8,
    };

    assert.equal(device.GetMaterial(out), D3D_OK);
    assert.equal(out.material.Power, 0);
    assert.equal(device.SetMaterial(material), D3D_OK);
    material.Power = 16;
    assert.equal(device.GetMaterial(out), D3D_OK);
    assert.equal(out.material.Power, 8, 'the device kept its own copy');
    assert.deepEqual(out.material.Emissive, { r: 0.1, g: 0.2, b: 0.3, a: 0 });

    assertFullyReleased(device);
});

// --- what a draw or a clear is refused for, with nothing behind the device ---

test('a draw outside a scene, of nothing, or without a stream is refused', ()=>{
    const device = createDevice();
    /** @type {{ buffer?: any }} */
    const vertices = {};
    assert.equal(device.CreateVertexBuffer(60, 0, FVF_XYZ_DIFFUSE, D3DPOOL.DEFAULT, vertices),
        D3D_OK);
    const bytes = new Uint8Array(60);

    assert.equal(device.SetVertexShader(FVF_XYZ_DIFFUSE), D3D_OK);
    assert.equal(device.SetStreamSource(0, vertices.buffer, 16), D3D_OK);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3DERR_INVALIDCALL,
        'no scene is open');
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 0), D3DERR_INVALIDCALL, 'nothing');
    assert.equal(device.DrawPrimitive(9, 0, 1), D3DERR_INVALIDCALL, 'not a primitive type');
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    assert.equal(device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 3, 0, 1), D3DERR_INVALIDCALL,
        'no indices are bound');
    assert.equal(device.SetStreamSource(0, null, 0), D3D_OK);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3DERR_INVALIDCALL, 'no stream');
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, bytes, 16), D3D_OK,
        'a user-pointer draw needs no stream');
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2, bytes, 16), D3DERR_INVALIDCALL,
        'but it needs enough bytes');
    assert.equal(device.DrawIndexedPrimitiveUP(D3DPT.TRIANGLELIST, 0, 3, 1, new Uint8Array(6),
        D3DFMT_INDEX.INDEX16, bytes, 16), D3D_OK);
    assert.equal(device.SetVertexShader(0), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, bytes, 16), D3DERR_INVALIDCALL,
        'no vertex format and no shader');

    assert.equal(device.EndScene(), D3D_OK);
    vertices.buffer.release();
    assertFullyReleased(device);
});

test('a user-pointer draw unbinds stream zero and the indices', ()=>{
    const device = createDevice();
    /** @type {{ buffer?: any }} */
    const vertices = {};
    /** @type {{ buffer?: any }} */
    const indices = {};
    assert.equal(device.CreateVertexBuffer(60, 0, FVF_XYZ_DIFFUSE, D3DPOOL.DEFAULT, vertices),
        D3D_OK);
    assert.equal(device.CreateIndexBuffer(6, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.DEFAULT, indices),
        D3D_OK);
    assert.equal(device.SetStreamSource(0, vertices.buffer, 16), D3D_OK);
    assert.equal(device.SetIndices(indices.buffer, 5), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_XYZ_DIFFUSE), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(48), 16), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);

    /** @type {{ buffer?: any, stride?: number, baseVertexIndex?: number }} */
    const out = {};
    assert.equal(device.GetStreamSource(0, out), D3D_OK);
    assert.equal(out.buffer, null);
    assert.equal(out.stride, 16, 'the stride survives, as it does for any unbinding');
    assert.equal(device.GetIndices(out), D3D_OK);
    assert.equal(out.buffer, null);
    assert.equal(out.baseVertexIndex, 0);

    vertices.buffer.release();
    indices.buffer.release();
    assertFullyReleased(device);
});

test('a buffer lock hands out its storage and refuses what does not fit', ()=>{
    const device = createDevice();
    /** @type {{ buffer?: any }} */
    const out = {};
    assert.equal(device.CreateVertexBuffer(100, 0, FVF_XYZ_DIFFUSE, D3DPOOL.DEFAULT, out), D3D_OK);
    /** @type {{ pBits?: number }} */
    const locked = {};

    assert.equal(out.buffer.Unlock(), D3DERR_INVALIDCALL, 'nothing to unlock');
    assert.equal(out.buffer.Lock(90, 20, locked, 0), D3DERR_INVALIDCALL, 'past the end');
    assert.equal(out.buffer.Lock(16, 0, locked, 0), D3D_OK, 'zero means to the end');
    assert.equal(locked.pBits, out.buffer.base + 16);
    assert.equal(out.buffer.Lock(0, 4, locked, 0), D3DERR_INVALIDCALL, 'already locked');
    assert.equal(out.buffer.Unlock(), D3D_OK);
    assert.equal(out.buffer.Unlock(), D3DERR_INVALIDCALL);

    out.buffer.release();
    assertFullyReleased(device);
});

test('Clear refuses a depth or stencil clear it has no buffer for', ()=>{
    const device = createDevice({ parameters: { enableAutoDepthStencil: false } });

    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, 0, 1, 0), D3D_OK);
    assert.equal(device.Clear(0, null, D3DCLEAR.ZBUFFER, 0, 1, 0), D3DERR_INVALIDCALL);
    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.STENCIL, 0, 1, 0),
        D3DERR_INVALIDCALL);
    assert.equal(device.Clear(0, null, 0, 0, 1, 0), D3DERR_INVALIDCALL, 'nothing to clear');
    assert.equal(device.Clear(2, null, D3DCLEAR.TARGET, 0, 1, 0), D3DERR_INVALIDCALL,
        'two rectangles and no rectangles');

    /** @type {{ surface?: any }} */
    const depth = {};
    assert.equal(device.CreateDepthStencilSurface(WIDTH, HEIGHT, D3DFMT.D16, depth), D3D_OK);
    assert.equal(device.SetRenderTarget(null, depth.surface), D3D_OK);
    assert.equal(device.Clear(0, null, D3DCLEAR.ZBUFFER, 0, 1, 0), D3D_OK);
    assert.equal(device.Clear(0, null, D3DCLEAR.STENCIL, 0, 1, 0), D3DERR_INVALIDCALL,
        'D16 has no stencil');
    assert.equal(device.SetRenderTarget(null, null), D3D_OK);
    depth.surface.release();
    assertFullyReleased(device);
});

test('a back buffer is lockable exactly when the program asked for one', ()=>{
    // The flag was read out of the parameters and then looked at by nothing, so
    // a program that asked to read its own back buffer was refused every frame
    // -- with D3DERR_INVALIDCALL, which is what a program that never asked
    // should get and a lie to one that did.
    const refused = createDevice();
    /** @type {{ surface?: any }} */
    const plain = {};
    assert.equal(refused.GetBackBuffer(0, 0, plain), D3D_OK);
    assert.equal(plain.surface.LockRect({}, null, 0), D3DERR_INVALIDCALL,
        'no flag, no lock, which is the real rule');
    refused.release();

    /** @type {string[]} */
    const reported = [];
    const asked = createDevice({
        parameters: { flags: D3DPRESENTFLAG.LOCKABLE_BACKBUFFER },
        caps: { divergence: (/** @type {string} */ api, /** @type {string} */ detail)=>
            reported.push(`${api}: ${detail}`) },
    });
    /** @type {{ surface?: any }} */
    const held = {};
    assert.equal(asked.GetBackBuffer(0, 0, held), D3D_OK);
    /** @type {any} */
    const locked = {};
    assert.equal(held.surface.LockRect(locked, null, 0), D3D_OK);
    assert.ok(locked.pBits > 0, 'and it hands out somewhere to read');
    // Succeeding is right and is not the whole truth: what is drawn lives on
    // the GPU and is never copied into those bytes. Accepting a call and not
    // honouring it is the defect class that shows as a picture rather than an
    // error, so it says so.
    assert.ok(reported.some(line=>/never copied into/.test(line)),
        'and says that what it hands out is not the rendered picture');
    assert.equal(held.surface.UnlockRect(), D3D_OK);
    asked.release();
});

test('the device reports memory it will not take back', ()=>{
    // A program sizes its texture cache from this and evicts to stay under it.
    // Nothing here evicts anything -- a texture's copy on the GPU lives as long
    // as the texture does -- so an answer small enough to make a program work
    // around it is describing a device other than this one. Sixty-four
    // megabytes did exactly that: measured on a real title's menu, a tenth of
    // every instruction the guest retired was inside its JPEG decoder,
    // re-decoding textures it had already loaded, and the picture flickered as
    // they came and went.
    const device = createDevice();
    const reported = device.GetAvailableTextureMem();

    assert.ok(reported >= 256 * 1024 * 1024,
        `${reported} is not enough room for a program of this era to stop evicting`);
    assert.ok(reported < 0x7fffffff,
        'and it stays positive in a caller that treats a DWORD as signed');
    assertFullyReleased(device);
});

test('setting a matrix that is already set does nothing, and is counted', ()=>{
    // Measured on a real title's menu: three and a half transform sets per
    // draw, most of them the value already there. Setting it again is
    // observably nothing -- but it was two copies of sixteen floats every time,
    // one of them built for a state block that was not recording.
    const device = createDevice();
    const matrix = Float32Array.from({ length: 16 }, (unused, at)=>at);

    assert.equal(device.SetTransform(D3DTS.WORLD, matrix), D3D_OK);
    assert.equal(device.diagnostics().redundantTransforms, 0, 'the first one is real work');

    assert.equal(device.SetTransform(D3DTS.WORLD, matrix), D3D_OK);
    assert.equal(device.SetTransform(D3DTS.WORLD, Float32Array.from(matrix)), D3D_OK,
        'a different array holding the same numbers is the same matrix');
    assert.equal(device.diagnostics().redundantTransforms, 2);

    // And what a program reads back is unchanged by any of it.
    /** @type {{ matrix?: Float32Array }} */
    const out = {};
    device.GetTransform(D3DTS.WORLD, out);
    assert.deepEqual([...(out.matrix ?? [])], [...matrix]);

    // One number different is not the same matrix.
    const moved = Float32Array.from(matrix);
    moved[12] = 99;
    assert.equal(device.SetTransform(D3DTS.WORLD, moved), D3D_OK);
    assert.equal(device.diagnostics().redundantTransforms, 2, 'a real change is not skipped');
    device.GetTransform(D3DTS.WORLD, out);
    assert.equal(out.matrix?.[12], 99);

    assertFullyReleased(device);
});
