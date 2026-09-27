/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3DCLEAR, D3DCREATE, D3DERR_DEVICELOST, D3DERR_DEVICENOTRESET, D3DERR_INVALIDCALL,
    D3DERR_NOTFOUND, D3DFMT, D3DFMT_INDEX, D3DLIGHTTYPE, D3DLOCK, D3DORDER, D3DPOOL, D3DPT, D3DRS,
    D3DRS_MAX,
    D3DPRESENTFLAG, D3DRS_REMOVED_IN_D3D9, D3DSBT, D3DSWAPEFFECT, D3DTA, D3DTOP, D3DTS, D3DTSS,
    D3DUSAGE, D3D_OK,
    dwordToFloat, floatToDword, isShaderHandle, surfaceBytes,
} from './constants.js';
import { DEFAULT_STAGE_STATES } from './stagestates.js';
import { D3DRS as D3DRS9 } from '../d3d9/constants.js';
import { DEFAULT_RENDER_STATES, resolveRenderStateDefault } from './renderstates.js';
import { DEVICE_STATE, LIGHT_ENABLED, createDirect3D8 } from './device.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

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

test('a light set again with what it holds keeps it, and a zero of the other sign changes it', ()=>{
    // Setting what is there is nothing; but the values read back are the
    // program's, bit for bit, so -0 where there was 0 is a different light.
    const device = createDevice();
    /** @type {{ light?: any, enabled?: any }} */
    const out = {};
    const light = {
        Type: D3DLIGHTTYPE.SPOT,
        Diffuse: { r: 1, g: 0.5, b: 0.25, a: 1 },
        Specular: { r: 0, g: 0, b: 0, a: 0 },
        Ambient: { r: 0.125, g: 0, b: 0, a: 1 },
        Position: { x: 1, y: 2, z: 3 },
        Direction: { x: 0, y: 0, z: 1 },
        Range: 50,
        Falloff: 1,
        Attenuation0: 1,
        Attenuation1: 0,
        Attenuation2: 0,
        Theta: 0.5,
        Phi: 1,
    };
    assert.equal(device.SetLight(2, light), D3D_OK);
    assert.equal(device.LightEnable(2, true), D3D_OK);
    assert.equal(device.SetLight(2, { ...light }), D3D_OK);
    assert.equal(device.LightEnable(2, true), D3D_OK);
    assert.equal(device.GetLight(2, out), D3D_OK);
    assert.deepEqual(out.light, light);
    assert.equal(device.GetLightEnable(2, out), D3D_OK);
    assert.equal(out.enabled, LIGHT_ENABLED, 'enabling it again leaves it enabled');

    assert.equal(device.SetLight(2, { ...light, Attenuation1: -0,
        Position: { x: 1, y: 2, z: 3 } }), D3D_OK);
    assert.equal(device.GetLight(2, out), D3D_OK);
    assert.ok(Object.is(out.light.Attenuation1, -0), 'the negative zero is what reads back');
    assert.equal(device.GetLightEnable(2, out), D3D_OK);
    assert.equal(out.enabled, LIGHT_ENABLED, 'setting a light does not disable it');

    assert.equal(device.LightEnable(2, false), D3D_OK);
    assert.equal(device.GetLightEnable(2, out), D3D_OK);
    assert.equal(out.enabled, 0);

    assertFullyReleased(device);
});

test('a world written over the one held reads back new, and a block captured before keeps its own',
    ()=>{
        // The device writes a new world into the matrix it holds; whoever
        // took the old one took a copy.
        const device = createDevice();
        /** @type {{ matrix?: Float32Array, handle?: number }} */
        const out = {};
        const first = Float32Array.from({ length: 16 }, (_, at)=>at + 1);
        const second = Float32Array.from({ length: 16 }, (_, at)=>-at);
        assert.equal(device.SetTransform(D3DTS.WORLD, first), D3D_OK);
        assert.equal(device.GetTransform(D3DTS.WORLD, out), D3D_OK);
        const read = /** @type {Float32Array} */ (out.matrix);
        assert.equal(device.CreateStateBlock(D3DSBT.ALL, out), D3D_OK);
        const block = /** @type {number} */ (out.handle);

        assert.equal(device.SetTransform(D3DTS.WORLD, second), D3D_OK);
        assert.deepEqual([...read], [...first], 'what GetTransform answered is the caller\'s');
        assert.equal(device.GetTransform(D3DTS.WORLD, out), D3D_OK);
        assert.deepEqual([...(/** @type {Float32Array} */ (out.matrix))], [...second]);
        second[0] = 99;
        assert.equal(device.GetTransform(D3DTS.WORLD, out), D3D_OK);
        assert.equal(/** @type {Float32Array} */ (out.matrix)[0], -0,
            'the device copied the matrix it was handed');

        assert.equal(device.ApplyStateBlock(block), D3D_OK);
        assert.equal(device.GetTransform(D3DTS.WORLD, out), D3D_OK);
        assert.deepEqual([...(/** @type {Float32Array} */ (out.matrix))], [...first]);

        assert.equal(device.DeleteStateBlock(block), D3D_OK);
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

test('a level count of zero is the whole chain, down to one texel', ()=>{
    // Zero is how a program asks for every level; answered with one, it locks
    // levels that do not exist and fills nothing past the top.
    const device = createDevice();
    /** @type {{ texture?: any }} */
    const texture = {};
    /** @type {{ surface?: any }} */
    const last = {};

    assert.equal(device.CreateTexture(8, 4, 0, 0, D3DFMT.X8R8G8B8, D3DPOOL.DEFAULT, texture),
        D3D_OK);
    assert.equal(texture.texture.levels, 4, 'eight wide: 8, 4, 2, 1');
    assert.equal(texture.texture.GetSurfaceLevel(3, last), D3D_OK);
    /** @type {{ desc?: any }} */
    const described = {};
    assert.equal(last.surface.GetDesc(described), D3D_OK);
    assert.equal(described.desc.Width, 1);
    assert.equal(described.desc.Height, 1, 'the narrow side stops at one and stays there');
    assert.equal(last.surface.release(), 1);
    assert.equal(texture.texture.release(), 0);
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
    assert.equal(device.SetTexture(8, texture.texture), D3DERR_INVALIDCALL, 'eight stages');
    assert.equal(device.GetTexture(8, texture), D3DERR_INVALIDCALL);

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

/** D3DVSD_STREAM(0), D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3), D3DVSD_END(). */
const DECLARATION = [0x20000000, 0x40020000, 0xffffffff];

/** ps_1_1: def c1, tex t0, dp3, mul, mul -- Wine's simple_ps. */
const PIXEL_SHADER = [
    0xffff0101,
    0x00000051, 0xa00f0001, 0x3f800000, 0x00000000, 0x00000000, 0x00000000,
    0x00000042, 0xb00f0000,
    0x00000008, 0x800f0000, 0xa0e40001, 0xa0e40000,
    0x00000005, 0x800f0000, 0x90e40000, 0x80e40000,
    0x00000005, 0x800f0000, 0xb0e40000, 0x80e40000,
    0x0000ffff,
];

/** vs_1_1: dp4 oPos.x..w, v0, c0..c3 -- Wine's simple_vs. */
const SHADER = [
    0xfffe0101,
    0x00000009, 0xc0010000, 0x90e40000, 0xa0e40000,
    0x00000009, 0xc0020000, 0x90e40000, 0xa0e40001,
    0x00000009, 0xc0040000, 0x90e40000, 0xa0e40002,
    0x00000009, 0xc0080000, 0x90e40000, 0xa0e40003,
    0x0000ffff,
];

test('creating a shader takes no reference on the device', ()=>{
    const device = createDevice();
    /** @type {{ handle?: number }} */
    const vertex = {};
    /** @type {{ handle?: number }} */
    const pixel = {};

    assert.equal(device.CreateVertexShader(DECLARATION, SHADER, vertex), D3D_OK);
    assert.equal(device.refCount, 1, 'a handle is not an object with a lifetime');
    assert.equal(device.CreatePixelShader(PIXEL_SHADER, pixel), D3D_OK);
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

    assert.equal(device.CreateVertexShader(DECLARATION, SHADER, shader), D3D_OK);
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

    assert.equal(device.CreateVertexShader(DECLARATION, SHADER, first), D3D_OK);
    assert.equal(device.CreateVertexShader(DECLARATION, SHADER, second), D3D_OK);
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

    assert.equal(device.CreateVertexShader(DECLARATION, SHADER, bound), D3D_OK);
    assert.equal(device.CreateVertexShader(DECLARATION, SHADER, other), D3D_OK);
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

    assert.equal(device.CreatePixelShader(PIXEL_SHADER, pixel), D3D_OK);
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

test('a shader hands back the declaration and function it was made with', ()=>{
    // Wine's d3d8 test_shader: no buffer is told the size in bytes, a buffer
    // too small is refused and told nothing, and the tokens come back as given.
    const device = createDevice();
    /** @type {{ handle?: number }} */
    const made = {};
    assert.equal(device.CreateVertexShader([...DECLARATION, 0x12345678], SHADER, made), D3D_OK);
    const handle = made.handle ?? 0;

    /** @type {{ bytes?: number, tokens?: Uint32Array }} */
    let out = {};
    assert.equal(device.GetVertexShaderDeclaration(handle, out, null), D3D_OK);
    assert.equal(out.bytes, 12, 'to the end token and no further');
    assert.equal(out.tokens, undefined, 'a caller with no buffer gets no tokens');
    out = {};
    assert.equal(device.GetVertexShaderDeclaration(handle, out, 1), D3DERR_INVALIDCALL);
    assert.deepEqual(out, {}, 'a refusal tells the caller nothing');
    assert.equal(device.GetVertexShaderDeclaration(handle, out, 12), D3D_OK);
    assert.deepEqual([...out.tokens ?? []], DECLARATION);

    out = {};
    assert.equal(device.GetVertexShaderFunction(handle, out, null), D3D_OK);
    assert.equal(out.bytes, SHADER.length * 4);
    assert.equal(device.GetVertexShaderFunction(handle, {}, SHADER.length * 4 - 4),
        D3DERR_INVALIDCALL);
    assert.equal(device.GetVertexShaderFunction(handle, out, 1024), D3D_OK);
    assert.deepEqual([...out.tokens ?? []], SHADER, 'as given: no declaration of ours in it');

    /** @type {{ handle?: number }} */
    const alone = {};
    assert.equal(device.CreateVertexShader(DECLARATION, null, alone), D3D_OK);
    out = {};
    assert.equal(device.GetVertexShaderFunction(alone.handle ?? 0, out, 64), D3D_OK);
    assert.equal(out.bytes, 0, 'a declaration made alone has no function');

    assert.equal(device.DeleteVertexShader(handle), D3D_OK);
    assert.equal(device.GetVertexShaderDeclaration(handle, {}, null), D3DERR_INVALIDCALL);
    assert.equal(device.DeleteVertexShader(alone.handle ?? 0), D3D_OK);
    assertFullyReleased(device);
});

test('a vertex shader is made only from what this version runs', ()=>{
    const device = createDevice();
    const make = (/** @type {number[] | null} */ declaration,
        /** @type {number[] | null} */ code)=>device.CreateVertexShader(declaration, code, {});
    // Wine's d3d8 test_shader: a normal the fixed-function stage cannot read
    // refuses a declaration made alone and not one beside a function.
    for (const type of [1, 3, 4])
    {
        const normal = [0x20000000, 0x40020000, (0x40000003 | (type << 16)) >>> 0, 0xffffffff];
        assert.equal(make(normal, null), D3DERR_INVALIDCALL, `a normal of type ${type} alone`);
        assert.equal(make(normal, SHADER), D3D_OK);
    }
    // Wine's d3d8 test_unsupported_shaders: a pixel shader, a vs_2_0, a
    // constant past the file.
    assert.equal(make(DECLARATION, [0xffff0101, 0x0000ffff]), D3DERR_INVALIDCALL);
    assert.equal(make(DECLARATION, [0xfffe0200, 0x0000ffff]), D3DERR_INVALIDCALL);
    /** @param {number} register */
    const defining = register=>[
        0xfffe0101,
        0x00000051, (0xa00f0000 | register) >>> 0, 0x3f800000, 0x3f800000, 0x3f800000,
        0x3f800000,
        0x00000002, 0x800f0000, 0x90e40000, (0xa0e40000 | register) >>> 0,
        0x00000001, 0xc00f0000, 0x80e40000,
        0x0000ffff,
    ];
    assert.equal(make(DECLARATION, defining(255)), D3D_OK);
    assert.equal(make(DECLARATION, defining(256)), D3DERR_INVALIDCALL);
    // And what is not a declaration or a function at all.
    assert.equal(make(null, SHADER), D3DERR_INVALIDCALL);
    assert.equal(make([0x20000000, 0x40020000], SHADER), D3DERR_INVALIDCALL, 'no end token');
    assert.equal(make(DECLARATION, [0xfffe0101, 0x00000001]), D3DERR_INVALIDCALL);
    // A device that claims no vertex shader makes none.
    const none = createDevice({ caps: { vertexShaderVersion: { major: 0, minor: 0 } } });
    assert.equal(none.CreateVertexShader(DECLARATION, SHADER, {}), D3DERR_INVALIDCALL);
    assert.equal(none.CreateVertexShader(DECLARATION, null, {}), D3D_OK,
        'a declaration alone is the fixed-function stage');
    assertFullyReleased(none);
    assertFullyReleased(device);
});

test('vertex shader constants are a file of 256 registers a state block records into', ()=>{
    // Wine's d3d8 test_shader_constant_apply: a set while recording goes into
    // the block and not the device, and applying the block writes only what
    // it recorded.
    const device = createDevice();
    const initial = [0, 0, 0, 0];
    const vs = [1, 2, 3, 4];
    /** @param {number} register */
    const read = register=>{
        /** @type {{ values?: Float32Array }} */
        const out = {};
        assert.equal(device.GetVertexShaderConstant(register, 1, out), D3D_OK);
        return [...out.values ?? []];
    };
    assert.equal(device.SetVertexShaderConstant(0, vs, 1), D3D_OK);
    assert.equal(device.BeginStateBlock(), D3D_OK);
    assert.equal(device.SetVertexShaderConstant(1, vs, 1), D3D_OK);
    /** @type {{ handle?: number }} */
    const block = {};
    assert.equal(device.EndStateBlock(block), D3D_OK);
    assert.deepEqual(read(0), vs);
    assert.deepEqual(read(1), initial, 'the recorded set did not reach the device');
    assert.equal(device.SetVertexShaderConstant(0, [9, 9, 9, 9], 1), D3D_OK);
    assert.equal(device.ApplyStateBlock(block.handle ?? 0), D3D_OK);
    assert.deepEqual(read(0), [9, 9, 9, 9], 'a register the block did not record is left');
    assert.deepEqual(read(1), vs);

    // A block of every state holds every register, and gives them back.
    /** @type {{ handle?: number }} */
    const all = {};
    assert.equal(device.CreateStateBlock(D3DSBT.ALL, all), D3D_OK);
    assert.equal(device.SetVertexShaderConstant(255, [5, 6, 7, 8], 1), D3D_OK);
    assert.equal(device.ApplyStateBlock(all.handle ?? 0), D3D_OK);
    assert.deepEqual(read(255), initial);

    assert.equal(device.SetVertexShaderConstant(255, vs, 1), D3D_OK, 'the last register');
    assert.equal(device.SetVertexShaderConstant(255, [...vs, ...vs], 2), D3DERR_INVALIDCALL);
    assert.equal(device.GetVertexShaderConstant(256, 1, {}), D3DERR_INVALIDCALL);
    assert.equal(device.SetVertexShaderConstant(0, null, 1), D3DERR_INVALIDCALL);
    assert.equal(device.DeleteStateBlock(block.handle ?? 0), D3D_OK);
    assert.equal(device.DeleteStateBlock(all.handle ?? 0), D3D_OK);
    assertFullyReleased(device);
});

test('setting a shader loads the constants its declaration carries', ()=>{
    // Wine's d3d8 visual.c test_scalar_instructions draws with c0 given by
    // D3DVSD_CONST in the declaration and never set otherwise.
    const device = createDevice();
    /** @type {{ handle?: number }} */
    const made = {};
    assert.equal(device.CreateVertexShader([
        0x20000000, 0x40020000,
        0x82000002, 0x3e800000, 0x3f000000, 0x3f800000, 0x40000000,
        0xffffffff,
    ], SHADER, made), D3D_OK);
    /** @type {{ values?: Float32Array }} */
    const out = {};
    assert.equal(device.GetVertexShaderConstant(2, 1, out), D3D_OK);
    assert.deepEqual([...out.values ?? []], [0, 0, 0, 0], 'not by making it');
    assert.equal(device.SetVertexShader(made.handle ?? 0), D3D_OK);
    assert.equal(device.GetVertexShaderConstant(2, 1, out), D3D_OK);
    assert.deepEqual([...out.values ?? []], [0.25, 0.5, 1, 2]);
    assert.equal(device.DeleteVertexShader(made.handle ?? 0), D3D_OK);
    assertFullyReleased(device);
});

test('a declaration made alone is a fixed-function stage, and one with a function a program',
    ()=>{
        const device = createDevice();
        /** @type {{ handle?: number }} */
        const alone = {};
        /** @type {{ handle?: number }} */
        const programmed = {};
        // Position in stream zero, the colour in stream one.
        const twoStreams = [0x20000000, 0x40020000, 0x20000001, 0x40040005, 0xffffffff];
        assert.equal(device.CreateVertexShader(twoStreams, null, alone), D3D_OK);
        assert.equal(device.CreateVertexShader(twoStreams, SHADER, programmed), D3D_OK);

        assert.equal(device.SetVertexShader(alone.handle ?? 0), D3D_OK);
        let processing = device.stageProcessing;
        assert.equal(processing.vertexShader, 0, 'no shader runs');
        assert.equal(processing.fixedFunctionVertex, true);
        assert.equal(processing.fvf, 0);
        assert.deepEqual(processing.fixedFunctionLayout.attributes.map(
            (/** @type {any} */ attribute)=>[attribute.name, attribute.stream, attribute.offset]),
        [['position', 0, 0], ['diffuse', 1, 0]]);
        assert.deepEqual(processing.fixedFunctionLayout.streams, [1]);
        assert.equal(processing.program, null);

        assert.equal(device.SetVertexShader(programmed.handle ?? 0), D3D_OK);
        processing = device.stageProcessing;
        assert.equal(processing.vertexShader, programmed.handle);
        assert.equal(processing.fixedFunctionVertex, false);
        assert.equal(processing.fixedFunctionLayout, null);
        assert.equal(processing.program.vertexId, programmed.handle);
        assert.equal(processing.program.pixel, null);
        assert.deepEqual(processing.program.declaration.map(
            (/** @type {any} */ element)=>[element.Stream, element.Usage]), [[0, 0], [1, 10]]);

        assert.equal(device.DeleteVertexShader(alone.handle ?? 0), D3D_OK);
        assert.equal(device.DeleteVertexShader(programmed.handle ?? 0), D3D_OK);
        assertFullyReleased(device);
    });

test('a pixel shader is made from a ps_1_x, hands its function back and has eight constants',
    ()=>{
        // Wine's d3d8 test_shader and test_unsupported_shaders.
        const device = createDevice();
        /** @type {{ handle?: number }} */
        const made = {};
        assert.equal(device.CreatePixelShader(PIXEL_SHADER, made), D3D_OK);
        /** @type {{ handle?: number }} */
        const out = {};
        assert.equal(device.GetPixelShader(out), D3D_OK);
        assert.equal(out.handle, 0, 'made, not set');
        /** @type {{ bytes?: number, tokens?: Uint32Array }} */
        const read = {};
        assert.equal(device.GetPixelShaderFunction(made.handle, read, null), D3D_OK);
        assert.equal(read.bytes, PIXEL_SHADER.length * 4);
        assert.equal(device.GetPixelShaderFunction(made.handle, {}, 1), D3DERR_INVALIDCALL);
        assert.equal(device.GetPixelShaderFunction(made.handle, read, 1024), D3D_OK);
        assert.deepEqual([...read.tokens ?? []], PIXEL_SHADER);
        assert.equal(device.GetPixelShaderFunction(1234567, {}, null), D3DERR_INVALIDCALL);

        for (const tokens of [
            SHADER,                                     // a vertex shader
            [0xffff0200, 0x0000ffff],                   // ps_2_0
            [0xffff0105, 0x0000ffff],                   // past ps_1_4
            // def c8: past the eight registers.
            [0xffff0101, 0x00000051, 0xa00f0008, 0, 0, 0, 0, 0x0000ffff],
            [0xffff0101, 0x00000001],                   // no end token
        ])
        {
            assert.equal(device.CreatePixelShader(tokens, {}), D3DERR_INVALIDCALL);
        }
        for (const minor of [0, 1, 2, 3, 4])
        {
            /** @type {{ handle?: number }} */
            const each = {};
            assert.equal(device.CreatePixelShader([0xffff0100 | minor, 0x0000ffff], each), D3D_OK,
                `ps_1_${minor}`);
            assert.equal(device.DeletePixelShader(each.handle ?? 0), D3D_OK);
        }
        const none = createDevice({ caps: { pixelShaderVersion: { major: 0, minor: 0 } } });
        assert.equal(none.CreatePixelShader(PIXEL_SHADER, {}), D3DERR_INVALIDCALL,
            'a device that claims no pixel shader makes none');
        assertFullyReleased(none);

        // Constants: c0 to c7, recorded into a block (Wine's d3d8
        // test_shader_constant_apply).
        const ps = [5, 6, 7, 8];
        assert.equal(device.SetPixelShaderConstant(7, ps, 1), D3D_OK);
        assert.equal(device.SetPixelShaderConstant(7, [...ps, ...ps], 2), D3DERR_INVALIDCALL);
        assert.equal(device.BeginStateBlock(), D3D_OK);
        assert.equal(device.SetPixelShaderConstant(1, ps, 1), D3D_OK);
        /** @type {{ handle?: number }} */
        const block = {};
        assert.equal(device.EndStateBlock(block), D3D_OK);
        /** @type {{ values?: Float32Array }} */
        const values = {};
        assert.equal(device.GetPixelShaderConstant(1, 1, values), D3D_OK);
        assert.deepEqual([...values.values ?? []], [0, 0, 0, 0]);
        assert.equal(device.ApplyStateBlock(block.handle ?? 0), D3D_OK);
        assert.equal(device.GetPixelShaderConstant(1, 1, values), D3D_OK);
        assert.deepEqual([...values.values ?? []], ps);
        assert.equal(device.GetPixelShaderConstant(7, 2, values), D3DERR_INVALIDCALL);

        assert.equal(device.SetPixelShader(made.handle ?? 0), D3D_OK);
        assert.equal(device.DeletePixelShader(made.handle ?? 0), D3D_OK);
        assert.equal(device.GetPixelShader(out), D3D_OK);
        assert.equal(out.handle, 0, 'deleting the bound shader unbinds it');
        assert.equal(device.DeletePixelShader(made.handle ?? 0), D3DERR_INVALIDCALL);
        assert.equal(device.DeleteStateBlock(block.handle ?? 0), D3D_OK);
        assertFullyReleased(device);
    });

test('a pixel shader over a vertex format is a program over the format\'s elements', ()=>{
    const device = createDevice();
    /** @type {{ handle?: number }} */
    const made = {};
    assert.equal(device.CreatePixelShader(PIXEL_SHADER, made), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_XYZ_DIFFUSE), D3D_OK);
    assert.equal(device.SetPixelShader(made.handle ?? 0), D3D_OK);
    const processing = device.stageProcessing;
    assert.equal(processing.fixedFunctionVertex, true);
    assert.equal(processing.program.vertex, null, 'the vertex stage is the fixed one');
    assert.equal(processing.program.pixelId, made.handle);
    assert.deepEqual(processing.program.declaration.map(
        (/** @type {any} */ element)=>[element.Usage, element.Offset]), [[0, 0], [10, 12]]);
    assert.equal(processing.program.declarationId, FVF_XYZ_DIFFUSE,
        'a format is never odd, so it is never a handle');
    assert.equal(device.SetPixelShader(0), D3D_OK);
    assert.equal(device.stageProcessing.program, null, 'no shader, no program');
    assert.equal(device.DeletePixelShader(made.handle ?? 0), D3D_OK);
    assertFullyReleased(device);
});

test('a handle from one shader kind is not a handle of the other', ()=>{
    const device = createDevice();
    /** @type {{ handle?: number }} */
    const vertex = {};

    assert.equal(device.CreateVertexShader(DECLARATION, SHADER, vertex), D3D_OK);
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

// --- state blocks, after Wine's d3d8 stateblock tests ---

/**
 * One value of each kind a block may or may not hold, set as the test's
 * values or as the device's defaults, and read back.
 *
 * @param {any} device
 */
function stateKinds(device){
    /** @type {{ texture?: any }} */
    const texture = {};
    /** @type {{ buffer?: any }} */
    const vertices = {};
    /** @type {{ buffer?: any }} */
    const indices = {};
    /** @type {{ handle?: number }} */
    const vs = {};
    /** @type {{ handle?: number }} */
    const ps = {};
    assert.equal(device.CreateTexture(8, 8, 1, 0, D3DFMT.X8R8G8B8, D3DPOOL.DEFAULT, texture),
        D3D_OK);
    assert.equal(device.CreateVertexBuffer(64, 0, 0, D3DPOOL.DEFAULT, vertices), D3D_OK);
    assert.equal(device.CreateIndexBuffer(64, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.DEFAULT, indices),
        D3D_OK);
    assert.equal(device.CreateVertexShader([0x20000000, 0xffffffff], null, vs), D3D_OK);
    assert.equal(device.CreatePixelShader([0xffff0101, 0x0000ffff], ps), D3D_OK);
    const scaled = (/** @type {number} */ x)=>[x, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    /** @param {boolean} testing */
    const set = testing=>{
        device.SetRenderState(D3DRS.CULLMODE, testing ? 1 : 3);
        device.SetRenderState(D3DRS.ZFUNC, testing ? 8 : 4);
        device.SetTransform(D3DTS.WORLD, scaled(testing ? 7 : 1));
        device.SetTexture(0, testing ? texture.texture : null);
        device.LightEnable(0, testing);
        device.SetVertexShader(testing ? vs.handle : 0);
        device.SetPixelShader(testing ? ps.handle : 0);
        device.SetStreamSource(0, testing ? vertices.buffer : null, 16);
        device.SetIndices(testing ? indices.buffer : null, 0);
    };
    const read = ()=>{
        /** @type {any} */
        const out = {};
        const value = (/** @type {number} */ state)=>{
            device.GetRenderState(state, out);
            return out.value;
        };
        device.GetTransform(D3DTS.WORLD, out);
        const world = out.matrix[0];
        device.GetTexture(0, out);
        const boundTexture = out.texture;
        boundTexture?.release();
        device.GetLightEnable(0, out);
        const light = out.enabled !== 0;
        device.GetVertexShader(out);
        const vertexShader = out.handle;
        device.GetPixelShader(out);
        const pixelShader = out.handle;
        device.GetStreamSource(0, out);
        const stream = out.buffer;
        stream?.release();
        device.GetIndices(out);
        const index = out.buffer;
        index?.release();
        return {
            cull: value(D3DRS.CULLMODE), zfunc: value(D3DRS.ZFUNC), world,
            texture: boundTexture === texture.texture, light,
            vs: vertexShader === vs.handle, ps: pixelShader === ps.handle,
            stream: stream === vertices.buffer, indices: index === indices.buffer,
        };
    };
    const release = ()=>{
        set(false);
        texture.texture.release();
        vertices.buffer.release();
        indices.buffer.release();
    };
    return { set, read, release };
}

const TEST_ALL = { cull: 1, zfunc: 8, world: 7, texture: true, light: true, vs: true, ps: true,
    stream: true, indices: true };
const DEFAULTS = { cull: 3, zfunc: 4, world: 1, texture: false, light: false, vs: false,
    ps: false, stream: false, indices: false };

test('a recorded block changes nothing until it is applied', ()=>{
    const device = createDevice();
    const kinds = stateKinds(device);
    kinds.set(false);
    /** @type {{ handle?: number }} */
    const block = {};

    assert.equal(device.BeginStateBlock(), D3D_OK);
    kinds.set(true);
    assert.equal(device.EndStateBlock(block), D3D_OK);
    assert.deepEqual(kinds.read(), DEFAULTS, 'what was set while recording is the block\'s');
    assert.equal(device.ApplyStateBlock(block.handle), D3D_OK);
    assert.deepEqual(kinds.read(), TEST_ALL, 'and applying it is what sets it');

    kinds.set(false);
    assert.equal(device.BeginStateBlock(), D3D_OK);
    kinds.set(true);
    assert.equal(device.EndStateBlock(block), D3D_OK);
    assert.equal(device.DeleteStateBlock(block.handle), D3D_OK);
    assert.deepEqual(kinds.read(), DEFAULTS, 'an abandoned block leaves the device as it was');

    kinds.release();
    assertFullyReleased(device);
});

test('a made block holds its half: the vertex half, the pixel half, or everything', ()=>{
    const expected = {
        [D3DSBT.ALL]: TEST_ALL,
        // Transforms, textures, streams and indices are in neither half.
        [D3DSBT.VERTEXSTATE]: { ...DEFAULTS, cull: 1, light: true, vs: true },
        [D3DSBT.PIXELSTATE]: { ...DEFAULTS, zfunc: 8, ps: true },
    };
    for (const type of [D3DSBT.ALL, D3DSBT.VERTEXSTATE, D3DSBT.PIXELSTATE])
    {
        const device = createDevice();
        const kinds = stateKinds(device);
        /** @type {{ handle?: number }} */
        const block = {};

        kinds.set(true);
        assert.equal(device.CreateStateBlock(type, block), D3D_OK);
        kinds.set(false);
        assert.equal(device.ApplyStateBlock(block.handle), D3D_OK);
        assert.deepEqual(kinds.read(), expected[type], `made with the test values, ${type}`);

        // The same half, made at the defaults and captured at the test values.
        kinds.set(false);
        assert.equal(device.CreateStateBlock(type, block), D3D_OK);
        kinds.set(true);
        assert.equal(device.CaptureStateBlock(block.handle), D3D_OK);
        kinds.set(false);
        assert.equal(device.ApplyStateBlock(block.handle), D3D_OK);
        assert.deepEqual(kinds.read(), expected[type], `captured at the test values, ${type}`);

        kinds.release();
        assertFullyReleased(device);
    }
});

test('ValidateDevice refuses a stage the combiner does not draw, and writes no passes', ()=>{
    const device = createDevice();
    /** @type {{ passes?: number }} */
    const out = {};
    assert.equal(device.ValidateDevice(out), D3D_OK);
    assert.equal(out.passes, 1);

    /** @type {{ passes?: number }} */
    const refused = {};
    assert.equal(device.SetTextureStageState(0, D3DTSS.COLOROP, 24), D3D_OK, 'DOTPRODUCT3');
    assert.equal(device.ValidateDevice(refused), 0x88760819, 'D3DERR_UNSUPPORTEDCOLOROPERATION');
    assert.equal(refused.passes, undefined);

    // A pixel shader replaces the cascade, so the cascade is not what is drawn.
    /** @type {{ handle?: number }} */
    const ps = {};
    assert.equal(device.CreatePixelShader([0xffff0101, 0x0000ffff], ps), D3D_OK);
    assert.equal(device.SetPixelShader(ps.handle), D3D_OK);
    assert.equal(device.ValidateDevice(out), D3D_OK);
    assert.equal(device.SetPixelShader(0), D3D_OK);
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

test('Clear takes the rectangle count at its word and the missing array as the whole target',
    ()=>{
        // Wine's visual tests on d3d8: Clear(0, rects) succeeds and leaves the
        // target as it was, Clear(1, NULL) succeeds and clears all of it.
        const gpu = createFakeDevice();
        const backend = createBackend({
            device: gpu.device, queue: gpu.queue, presentTo: ()=>{}, now: ()=>0,
        });
        const device = createDevice({ caps: { backend, readMemory: ()=>new Uint8Array(0) } });
        const everything = [{ x1: 0, y1: 0, x2: WIDTH, y2: HEIGHT }];

        assert.equal(device.Clear(0, everything, D3DCLEAR.TARGET, 0xffff0000, 0, 0), D3D_OK);
        assert.equal(device.diagnostics().clears, 0, 'no rectangles counted, none cleared');
        assert.equal(device.Clear(1, null, D3DCLEAR.TARGET, 0xff00ff00, 0, 0), D3D_OK);
        assert.equal(device.diagnostics().clears, 1, 'a count without an array is the whole');
        assert.equal(device.Clear(2, null, D3DCLEAR.TARGET, 0, 1, 0), D3D_OK);
        assert.equal(device.diagnostics().clears, 2);
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
    assert.equal(held.surface.LockRect(locked, null, D3DLOCK.READONLY), D3D_OK);
    assert.ok(locked.pBits > 0, 'and it hands out somewhere to read');
    // Succeeding is right and is not the whole truth: what is drawn lives on
    // the GPU and is never copied into those bytes. Accepting a call and not
    // honouring it is the defect class that shows as a picture rather than an
    // error, so it says so.
    assert.ok(reported.some(line=>/never copied into/.test(line)),
        'and says that what it hands out is not the rendered picture');
    assert.equal(held.surface.UnlockRect(), D3D_OK);

    // The other direction of the same lock, and the worse of the two: a program
    // drawing into its back buffer by hand has those bytes thrown away, because
    // only a texture's unlock uploads what was written.
    reported.length = 0;
    assert.equal(held.surface.LockRect(locked, null, 0), D3D_OK);
    assert.ok(reported.some(line=>/discarded/.test(line)),
        'and says that what the program writes into it never reaches the surface');
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

test('the cursor is kept as the program set it, and refused when it could not be one', ()=>{
    const device = createDevice();
    /** @type {{ surface?: any }} */
    const made = {};
    device.CreateImageSurface(32, 32, D3DFMT.A8R8G8B8, made);
    /** @type {{ surface?: any }} */
    const wrong = {};
    device.CreateImageSurface(32, 32, D3DFMT.X8R8G8B8, wrong);

    assert.equal(device.SetCursorProperties(0, 0, null), D3DERR_INVALIDCALL);
    assert.equal(device.SetCursorProperties(0, 0, wrong.surface), D3DERR_INVALIDCALL,
        'a cursor is A8R8G8B8 and nothing else');
    assert.equal(device.SetCursorProperties(32, 0, made.surface), D3DERR_INVALIDCALL,
        'the hot spot is inside the bitmap');
    assert.equal(device.SetCursorProperties(3, 5, made.surface), D3D_OK);
    assert.deepEqual(device.GetCursor().hotSpot, { x: 3, y: 5 });
    assert.equal(device.GetCursor().surface, made.surface);

    assert.equal(device.ShowCursor(true), false, 'hidden until shown');
    assert.equal(device.ShowCursor(false), true, 'and the previous state comes back');
    assert.equal(device.GetCursor().shown, false);
    made.surface.release();
    wrong.surface.release();
    assertFullyReleased(device);
});

test('a lockable back buffer is given storage for the whole mode, not a fixed megabyte', ()=>{
    // A lock hands the program this address and it reads and writes the whole
    // surface through it. The allocation was a fixed megabyte whatever the mode,
    // so anything above 512x512 at four bytes a pixel ran off the end of it and
    // into whatever the heap put next -- and further past it the larger the mode,
    // which makes the damage depend on the display a run was configured for.
    /** @type {{ address: number, bytes: number }[]} */
    const given = [];
    let next = 0x10000;
    const device = createDevice({
        parameters: {
            backBufferWidth: 1600,
            backBufferHeight: 1200,
            flags: D3DPRESENTFLAG.LOCKABLE_BACKBUFFER,
        },
        caps: {
            /** @param {number} bytes */
            allocate: (/** @type {number} */ bytes)=>{
                const address = next;
                next += bytes;
                given.push({ address, bytes });
                return address;
            },
        },
    });

    /** @type {{ surface?: any }} */
    const held = {};
    assert.equal(device.GetBackBuffer(0, 0, held), D3D_OK);
    /** @type {any} */
    const locked = {};
    assert.equal(held.surface.LockRect(locked, null, D3DLOCK.READONLY), D3D_OK);

    const surface = given.find(entry=>entry.address === held.surface.base);
    assert.ok(surface, 'the back buffer was given guest memory of its own');
    assert.ok(surface.bytes >= surfaceBytes(D3DFMT.X8R8G8B8, 1600, 1200),
        'and enough of it for every pixel of the mode');
    // Nothing else may be sitting inside the span a lock hands out.
    const end = held.surface.base + surfaceBytes(D3DFMT.X8R8G8B8, 1600, 1200);
    const overlapping = given.filter(entry=>entry !== surface
        && entry.address < end && entry.address + entry.bytes > held.surface.base);
    assert.deepEqual(overlapping, [], 'and nothing else was put inside it');

    assert.equal(held.surface.UnlockRect(), D3D_OK);
    device.release();
});

test('what a back buffer says about itself agrees with the storage it was given', ()=>{
    // The three numbers a program reads the back buffer by -- the descriptor's
    // Width/Height/Format, the Size it reports in bytes, and the Pitch the lock
    // hands back -- have to describe the same span, and that span has to be
    // inside the allocation. A program copies the surface out every frame and
    // works the length out from these; any one of them larger than the storage
    // is a read past the end, and any one larger than the buffer the program
    // sized from it is a write past the end of that.
    for (const [format, bytesPerPixel] of [
        [D3DFMT.X8R8G8B8, 4], [D3DFMT.A8R8G8B8, 4], [D3DFMT.R5G6B5, 2],
    ])
    {
        for (const [width, height] of [[640, 480], [800, 600], [1024, 768], [1366, 768]])
        {
            /** @type {{ address: number, bytes: number }[]} */
            const given = [];
            let next = 0x10000;
            const device = createDevice({
                parameters: {
                    backBufferWidth: width,
                    backBufferHeight: height,
                    backBufferFormat: format,
                    flags: D3DPRESENTFLAG.LOCKABLE_BACKBUFFER,
                },
                caps: {
                    allocate: (/** @type {number} */ bytes)=>{
                        const address = next;
                        next += bytes;
                        given.push({ address, bytes });
                        return address;
                    },
                },
            });
            const where = `${width}x${height} format ${format}`;

            /** @type {{ surface?: any }} */
            const held = {};
            assert.equal(device.GetBackBuffer(0, 0, held), D3D_OK, where);
            /** @type {{ desc?: any }} */
            const described = {};
            assert.equal(held.surface.GetDesc(described), D3D_OK, where);
            const desc = described.desc;
            assert.equal(desc.Width, width, where);
            assert.equal(desc.Height, height, where);
            assert.equal(desc.Format, format, where);

            /** @type {any} */
            const locked = {};
            assert.equal(held.surface.LockRect(locked, null, D3DLOCK.READONLY), D3D_OK, where);
            assert.equal(locked.Pitch, width * bytesPerPixel, `pitch at ${where}`);
            assert.equal(desc.Size, locked.Pitch * height, `size against pitch at ${where}`);

            const storage = given.find(entry=>entry.address === held.surface.base);
            assert.ok(storage, `the back buffer has storage of its own at ${where}`);
            assert.ok(storage.bytes >= desc.Size, `storage covers Size at ${where}`);
            const inside = given.filter(entry=>entry !== storage
                && entry.address < held.surface.base + desc.Size
                && entry.address + entry.bytes > held.surface.base);
            assert.deepEqual(inside, [], `nothing else lies inside the surface at ${where}`);

            assert.equal(held.surface.UnlockRect(), D3D_OK, where);
            device.release();
        }
    }
});

test('UpdateTexture carries what the source was written in since it was last carried', ()=>{
    // Wine's d3d8 add_dirty_rect_test: a texture starts dirty; an update
    // takes its region, so a second finds nothing; a lock records its
    // rectangle unless it is read-only or asked for no dirty update; and
    // AddDirtyRect adds one, refusing a rectangle that is empty or leaves the
    // texture.
    const device = createDevice();
    /** @param {number} pool */
    const texture = pool=>{
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateTexture(256, 256, 2, 0, D3DFMT.X8R8G8B8, pool, out), D3D_OK);
        return out.texture;
    };
    const source = texture(D3DPOOL.SYSTEMMEM);
    const destination = texture(D3DPOOL.DEFAULT);
    /** @returns {any[]} */
    const update = ()=>{
        /** @type {{ moves?: any[] }} */
        const out = {};
        assert.equal(device.UpdateTexture(source, destination, out), D3D_OK);
        return out.moves ?? [];
    };
    /** @param {any} move */
    const extent = move=>[move.rowBytes / 4, move.rows];

    assert.deepEqual(update().map(extent), [[256, 256], [128, 128]], 'all of it, at first');
    assert.deepEqual(update(), [], 'and nothing, once carried');

    /** @param {any} rect @param {number} flags */
    const lock = (rect, flags)=>{
        /** @type {any} */
        const locked = {};
        assert.equal(source.LockRect(0, locked, rect, flags), D3D_OK);
        assert.equal(source.UnlockRect(0), D3D_OK);
    };
    lock(null, D3DLOCK.READONLY);
    lock(null, 0x8000);
    assert.deepEqual(update(), [], 'a read-only lock and a NO_DIRTY_UPDATE one record nothing');

    const part = { left: 96, top: 96, right: 160, bottom: 160 };
    lock(part, 0);
    const moves = update();
    assert.deepEqual(moves.map(extent), [[64, 64], [32, 32]], 'a lock\'s rectangle, per level');
    const top = /** @type {any} */ ({});
    assert.equal(source.GetSurfaceLevel(0, top), D3D_OK);
    top.surface.release();
    assert.equal(moves[0].from, top.surface.base + 96 * 1024 + 96 * 4);

    assert.equal(destination.AddDirtyRect(part), D3D_OK);
    assert.deepEqual(update(), [], 'a dirty rectangle on the destination is not carried');
    assert.equal(source.AddDirtyRect(part), D3D_OK);
    assert.deepEqual(update().map(extent), [[64, 64], [32, 32]]);
    assert.equal(source.AddDirtyRect(null), D3D_OK);
    assert.deepEqual(update().map(extent), [[256, 256], [128, 128]]);
    for (const rect of [{ left: 0, top: 0, right: 300, bottom: 200 },
        { left: 100, top: 100, right: 10, bottom: 10 }, { left: 0, top: 0, right: 0, bottom: 0 }])
    {
        assert.equal(source.AddDirtyRect(rect), D3DERR_INVALIDCALL);
    }
    assert.deepEqual(update(), []);

    // A copy into a level is a write the next update carries.
    /** @type {{ surface?: any }} */
    const image = {};
    assert.equal(device.CreateImageSurface(16, 16, D3DFMT.X8R8G8B8, image), D3D_OK);
    assert.equal(device.CopyRects(image.surface, [{ left: 0, top: 0, right: 16, bottom: 16 }], 1,
        top.surface, [{ x: 32, y: 48 }]), D3D_OK);
    assert.deepEqual(update().map(extent), [[16, 16], [8, 8]]);

    image.surface.release();
    source.release();
    destination.release();
    device.release();
});

test('UpdateTexture into a smaller texture starts from the source level of its size', ()=>{
    // Wine's d3d8 visual test_texture_blending cases: Windows skips the
    // source's larger levels, and accepts another size or format as well.
    /** @type {string[]} */
    const reported = [];
    const device = createDevice({
        caps: { divergence: (/** @type {string} */ api, /** @type {string} */ detail)=>
            reported.push(`${api}: ${detail}`) },
    });
    /** @param {number[]} size @param {number} levels @param {number} format @param {number} pool */
    const texture = ([width, height], levels, format, pool)=>{
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateTexture(width, height, levels, 0, format, pool, out), D3D_OK);
        return out.texture;
    };
    /** @param {any} of @param {number} level */
    const baseOf = (of, level)=>{
        /** @type {{ surface?: any }} */
        const held = {};
        assert.equal(of.GetSurfaceLevel(level, held), D3D_OK);
        held.surface.release();
        return held.surface.base;
    };
    /** @param {any} source @param {any} destination */
    const update = (source, destination)=>{
        /** @type {{ moves?: any[] }} */
        const out = {};
        const result = device.UpdateTexture(source, destination, out);
        source.release();
        destination.release();
        return { result, moves: out.moves ?? [] };
    };
    const { SYSTEMMEM, DEFAULT } = D3DPOOL;

    const deep = texture([8, 8], 4, D3DFMT.A8R8G8B8, SYSTEMMEM);
    const at = baseOf(deep, 2);
    const skipped = update(deep, texture([2, 2], 2, D3DFMT.A8R8G8B8, DEFAULT));
    assert.equal(skipped.result, D3D_OK);
    assert.deepEqual(skipped.moves.map(move=>[move.rowBytes, move.rows]), [[8, 2], [4, 1]]);
    assert.equal(skipped.moves[0].from, at, 'from the 2x2 level');
    assert.deepEqual(reported, [], 'a level of the size is the real rule');

    const odd = update(texture([8, 4], 4, D3DFMT.A8R8G8B8, SYSTEMMEM),
        texture([2, 4], 2, D3DFMT.A8R8G8B8, DEFAULT));
    assert.equal(odd.result, D3D_OK);
    assert.deepEqual(odd.moves.map(move=>[move.rowBytes, move.rows]), [[8, 2], [4, 1]],
        'the 4x2 level where it overlaps 2x4, then 2x1 over 1x2');
    assert.equal(reported.length, 1, 'and it says so');

    const alpha = update(texture([8, 8], 1, D3DFMT.A8R8G8B8, SYSTEMMEM),
        texture([8, 8], 1, D3DFMT.X8R8G8B8, DEFAULT));
    assert.equal(alpha.result, D3D_OK);
    assert.equal(alpha.moves.length, 1, 'one texel size, so the bytes are carried');

    const narrow = update(texture([8, 8], 1, D3DFMT.A8R8G8B8, SYSTEMMEM),
        texture([8, 8], 1, D3DFMT.R5G6B5, DEFAULT));
    assert.equal(narrow.result, D3D_OK);
    assert.deepEqual(narrow.moves, [], 'texels are not converted');
    assert.equal(reported.length, 2);

    /** @param {number} size @param {number} levels @param {number} format @param {number} pool */
    const volume = (size, levels, format, pool)=>{
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateVolumeTexture(size, size, size, levels, 0, format, pool, out),
            D3D_OK);
        return out.texture;
    };
    const kept = update(volume(8, 4, D3DFMT.A8R8G8B8, SYSTEMMEM),
        volume(8, 2, D3DFMT.X8R8G8B8, DEFAULT));
    assert.equal(kept.result, D3D_OK);
    assert.equal(kept.moves.length, 8 + 4, 'a volume of the same size keeps its top levels,'
        + ' a slice at a time');

    const small = update(texture([4, 4], 1, D3DFMT.A8R8G8B8, SYSTEMMEM),
        texture([8, 8], 1, D3DFMT.A8R8G8B8, DEFAULT));
    assert.equal(small.result, D3DERR_INVALIDCALL, 'a smaller source is refused');
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

test('a surface made on its own gives its storage back with its last reference', ()=>{
    // A render target made and released in a loop otherwise keeps the heap it
    // took, and a program that makes enough of them runs the arena out.
    /** @type {Map<number, number>} */
    const held = new Map();
    let next = 0x100000;
    const device = createDevice({ caps: {
        allocate: (/** @type {number} */ bytes)=>{
            const at = next;
            next += bytes + 0x1000;
            held.set(at, bytes);
            return at;
        },
        free: (/** @type {number} */ at)=>held.delete(at),
    } });
    const before = held.size;
    for (let round = 0; round < 3; round++)
    {
        /** @type {{ surface?: any }} */
        const target = {};
        assert.equal(device.CreateRenderTarget(64, 64, D3DFMT.A8R8G8B8, true, target), D3D_OK);
        /** @type {{ surface?: any }} */
        const depth = {};
        assert.equal(device.CreateDepthStencilSurface(64, 64, D3DFMT.D24S8, depth), D3D_OK);
        /** @type {{ surface?: any }} */
        const image = {};
        assert.equal(device.CreateImageSurface(64, 64, D3DFMT.A8R8G8B8, image), D3D_OK);
        for (const made of [target, depth, image])
        {
            assert.equal(made.surface.release(), 0);
        }
    }
    assert.equal(held.size, before, 'every block went back');
    assertFullyReleased(device);
});

test('a buffer gives its storage back with its last reference, a Reset the surfaces it replaces',
    ()=>{
        /** @type {Map<number, number>} */
        const held = new Map();
        let next = 0x100000;
        const device = createDevice({ caps: {
            allocate: (/** @type {number} */ bytes)=>{
                const at = next;
                next += bytes + 0x1000;
                held.set(at, bytes);
                return at;
            },
            free: (/** @type {number} */ at)=>held.delete(at),
        } });
        const before = held.size;
        for (let round = 0; round < 3; round++)
        {
            /** @type {{ buffer?: any }} */
            const vertices = {};
            assert.equal(device.CreateVertexBuffer(4096, 0, 0, D3DPOOL.DEFAULT, vertices), D3D_OK);
            /** @type {{ buffer?: any }} */
            const indices = {};
            assert.equal(device.CreateIndexBuffer(4096, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.DEFAULT,
                indices), D3D_OK);
            assert.equal(vertices.buffer.release(), 0);
            assert.equal(indices.buffer.release(), 0);
        }
        assert.equal(held.size, before, 'every buffer\'s block went back');
        for (const width of [128, 96, WIDTH])
        {
            assert.equal(device.Reset({
                swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1, backBufferWidth: width,
                backBufferHeight: HEIGHT, backBufferFormat: D3DFMT.X8R8G8B8,
                enableAutoDepthStencil: true, autoDepthStencilFormat: D3DFMT.D24S8,
            }), D3D_OK);
        }
        assert.equal(held.size, before, 'a Reset keeps one back buffer and one depth stencil');
        assertFullyReleased(device);
        assert.equal(held.size, 0, 'and the device\'s own surfaces go with its last reference');
    });

test('a buffer released to nothing while bound lives until it is unbound, and is handed back', ()=>{
    // Wine's d3d8 visual test releases a bound vertex buffer to a count of
    // zero and asks for the stream again: Windows keeps it for the device and
    // hands back the same object. Answered NULL, the test released NULL and
    // hung there.
    const device = createDevice();
    /** @type {{ buffer?: any }} */
    const made = {};
    assert.equal(device.CreateVertexBuffer(64, 0, 0, D3DPOOL.DEFAULT, made), D3D_OK);
    assert.equal(device.SetStreamSource(0, made.buffer, 16), D3D_OK);
    assert.equal(made.buffer.release(), 0, 'what the device keeps is not counted');
    /** @type {{ buffer?: any, stride?: number }} */
    const after = {};
    assert.equal(device.GetStreamSource(0, after), D3D_OK);
    assert.equal(after.buffer, made.buffer, 'the same buffer, alive');
    assert.equal(after.stride, 16);
    assert.equal(after.buffer.release(), 0);
    assert.equal(made.buffer.destroyed, false, 'kept while bound');
    assert.equal(device.SetStreamSource(0, null, 0), D3D_OK);
    assert.equal(made.buffer.destroyed, true, 'and gone once unbound');
    assertFullyReleased(device);
});
