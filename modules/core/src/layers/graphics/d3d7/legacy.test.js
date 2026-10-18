/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Direct3D of DirectX 3, 5 and 6 as a model over the Direct3D 7 device.
 *
 * The device underneath is the real one, watched: what these tests check is
 * what the older interface asks of it -- which render state a draw is lit
 * by, which stage states a blend mode stands for, which rectangle and
 * projection a viewport sets -- because that is the whole of the translation.
 * The expectations are Wine's ddraw1/2/4.c conformance tests, each named
 * where it is used.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipVolumeMatrix, createLegacyDirect3D, createTextureHandles } from './legacy.js';
import { createDirect3D7 } from './device.js';
import {
    D3DDP_DONOTLIGHT, D3DERR_LIGHTHASVIEWPORT, D3DERR_LIGHTNOTINTHISVIEWPORT,
    D3DERR_NOCURRENTVIEWPORT, D3DERR_VIEWPORTDATANOTSET, D3DERR_VIEWPORTHASNODEVICE, D3DFILTER,
    D3DLIGHTSTATE, D3DLIGHT_ACTIVE, D3DNEXT_HEAD, D3DNEXT_NEXT, D3DNEXT_TAIL, D3DTBLEND, D3D_OK,
    DDERR_INVALIDPARAMS, DDERR_NOTFOUND, DEVICE_IDS,
} from './constants.js';
import { D3DCLEAR, D3DPT, D3DTOP, D3DTSS } from '../d3d8/constants.js';
import { FVF } from '../webgpu/internal/vertexformat.js';
import { createDirectDraw } from '../ddraw/objects.js';
import {
    DDPF_ALPHAPIXELS, DDPF_RGB, DDSCAPS_3DDEVICE, DDSCAPS_OFFSCREENPLAIN, DDSCAPS_TEXTURE,
    DDSCL_NORMAL, DDSD_CAPS, DDSD_HEIGHT, DDSD_PIXELFORMAT, DDSD_WIDTH,
} from '../ddraw/constants.js';

const HWND = 0x00010044;
const RS_LIGHTING = 137;
const RS_SPECULARENABLE = 29;
const RS_TEXTUREHANDLE = 1;
const RS_TEXTUREMAPBLEND = 21;
const RS_TEXTUREMIN = 18;
const D3DTRANSFORMSTATE_PROJECTION = 3;

const XRGB32 = Object.freeze({
    size: 0x20, flags: DDPF_RGB, fourCC: 0, bitCount: 32,
    redMask: 0xff0000, greenMask: 0xff00, blueMask: 0xff, alphaMask: 0,
});
const ARGB32 = Object.freeze({ ...XRGB32, flags: DDPF_RGB | DDPF_ALPHAPIXELS,
    alphaMask: 0xff000000 });

/** A D3DVERTEX: a position, a normal and one coordinate set. */
const FVF_VERTEX = FVF.XYZ | FVF.NORMAL | (1 << FVF.TEXCOUNT_SHIFT);
/** A D3DLVERTEX's layout without its reserved dword: lit colours, no normal. */
const FVF_LVERTEX = FVF.XYZ | FVF.DIFFUSE | FVF.SPECULAR;
const FVF_TLVERTEX = FVF.XYZRHW | FVF.DIFFUSE | FVF.SPECULAR;

/**
 * @param {any} root
 * @param {{ caps?: number, pixelFormat?: any, width?: number, height?: number }} [options]
 */
function surface(root, options = {}){
    const made = root.createSurface({
        flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT,
        caps: options.caps ?? (DDSCAPS_3DDEVICE | DDSCAPS_OFFSCREENPLAIN),
        width: options.width ?? 64,
        height: options.height ?? 48,
        pixelFormat: options.pixelFormat ?? XRGB32,
    }, { version: 4 });
    assert.equal(made.hr, D3D_OK);
    return made.surface;
}

/**
 * A legacy Direct3D object over a real Direct3D 7 one, whose devices report
 * every state call made on them.
 *
 * @param {1 | 2 | 3} [version]
 */
function fixture(version = 3){
    const root = createDirectDraw({ version: 4, screenWidth: 64, screenHeight: 48 });
    root.setCooperativeLevel(HWND, DDSCL_NORMAL);
    const d3d7 = createDirect3D7(root);
    /** @type {any[][]} */
    const calls = [];
    const watched = {
        ...d3d7,
        /** @param {string} id @param {any} target */
        createDevice(id, target){
            const made = d3d7.createDevice(id, target);
            if (made.device)
            {
                const inner = made.device;
                made.device = new Proxy(inner, {
                    get(object, key){
                        const value = object[key];
                        if (typeof value !== 'function' || typeof key !== 'string'
                            || !/^[A-Z]/.test(key))
                        {
                            return value;
                        }
                        return (/** @type {any[]} */ ...args)=>{
                            calls.push([key, ...args]);
                            return value.apply(object, args);
                        };
                    },
                });
            }
            return made;
        },
    };
    const textures = createTextureHandles();
    const legacy = createLegacyDirect3D(watched, textures);
    const target = surface(root);
    const made = legacy.createDevice(DEVICE_IDS.HAL, target, version);
    assert.equal(made.hr, D3D_OK);
    const device = made.device;
    return {
        root, legacy, target, device, calls, textures,
        /** @param {string} name @returns {any[][]} the calls of that name since the mark */
        since: (name, mark = 0)=>calls.slice(mark).filter(call=>call[0] === name),
        /** A viewport on the device, current, over the whole target. */
        viewport(){
            const viewport = legacy.createViewport();
            assert.equal(device.addViewport(viewport), D3D_OK);
            assert.equal(viewport.setViewport2({ x: 0, y: 0, width: 64, height: 48,
                clipX: -1, clipY: 1, clipWidth: 2, clipHeight: 2, minZ: 0, maxZ: 1 }), D3D_OK);
            assert.equal(device.setCurrentViewport(viewport), D3D_OK);
            return viewport;
        },
        done(){
            assert.equal(device.release(), 0, 'the device reached zero');
            assert.equal(target.release(), 0, 'the target reached zero');
            assert.equal(root.release('IDirectDraw4'), 0);
            assert.ok(root.destroyed, 'the DirectDraw object is gone');
        },
    };
}

/** @param {number} count @param {number} stride */
const zeros = (count, stride)=>new Uint8Array(count * stride);

// --- the object ---

test('the older versions make the software and hardware devices, and no T&L one', ()=>{
    const f = fixture();
    assert.deepEqual(f.legacy.devices().map((/** @type {any} */ device)=>device.id),
        [DEVICE_IDS.RGB, DEVICE_IDS.HAL]);
    assert.equal(f.legacy.createDevice(DEVICE_IDS.TNLHAL, f.target, 3).hr, DDERR_NOTFOUND);
    f.done();
});

// --- viewports (Wine's ddraw4.c test_viewport_object) ---

test('a viewport converts between its scale form and its clip-volume form as Windows does', ()=>{
    const f = fixture();
    const viewport = f.legacy.createViewport();
    assert.equal(viewport.getViewport().hr, D3DERR_VIEWPORTDATANOTSET);
    assert.equal(viewport.getViewport2().hr, D3DERR_VIEWPORTDATANOTSET);
    assert.equal(viewport.setViewport2({ x: 0, y: 0, width: 1, height: 1, clipX: -1, clipY: 1,
        clipWidth: 2, clipHeight: 2, minZ: 0, maxZ: 1 }), D3DERR_VIEWPORTHASNODEVICE,
    'data is set only on a viewport a device holds');
    assert.equal(f.device.addViewport(viewport), D3D_OK);

    // Wine's numbers on a 640x480 target, a tenth the size on this 64x48 one.
    assert.equal(viewport.setViewport2({ x: 16, y: 12, width: 48, height: 36, clipX: 2,
        clipY: -1.75, clipWidth: 2.5, clipHeight: -1.5, minZ: 0.5, maxZ: 2 }), D3D_OK);
    assert.deepEqual(viewport.getViewport().viewport, { x: 16, y: 12, width: 48,
        height: 36, scaleX: 19.2, scaleY: -24, maxX: 4.5, maxY: -1.75, minZ: 0, maxZ: 1 });

    assert.equal(viewport.setViewport({ x: 16, y: 12, width: 48, height: 36,
        scaleX: -32, scaleY: 18, maxX: -3, maxY: 1.75, minZ: 0.5, maxZ: 2 }), D3D_OK);
    const second = /** @type {any} */ (viewport.getViewport2().viewport);
    assert.deepEqual([second.clipX, second.clipY, second.clipWidth, second.clipHeight,
        second.minZ, second.maxZ], [0.75, 1, -1.5, 2, 0, 1],
    'the scale form names no volume corner: it is centred, and its depth is zero to one');

    assert.equal(f.device.release(), 0);
    assert.equal(viewport.refCount, 1, 'the device\'s release gave its reference back');
    assert.equal(viewport.setViewport({ x: 0, y: 0, width: 1, height: 1, scaleX: 1,
        scaleY: 1, maxX: 1, maxY: 1, minZ: 0, maxZ: 1 }), D3DERR_VIEWPORTHASNODEVICE);
    assert.equal(viewport.release(), 0);
    assert.equal(f.target.release(), 0);
    assert.equal(f.root.release('IDirectDraw4'), 0);
});

test('the current viewport is held by the device, and the third generation lets go of it on delete',
    ()=>{
        const f = fixture();
        const first = f.legacy.createViewport();
        const second = f.legacy.createViewport();
        assert.equal(f.device.getCurrentViewport().hr, D3DERR_NOCURRENTVIEWPORT);
        assert.equal(f.device.setCurrentViewport(second), DDERR_INVALIDPARAMS,
            'a viewport the device does not hold cannot be current');
        assert.equal(f.device.deleteViewport(null), DDERR_INVALIDPARAMS);

        assert.equal(f.device.addViewport(first), D3D_OK);
        assert.equal(first.refCount, 2);
        assert.equal(f.device.addViewport(second), D3D_OK);
        assert.equal(f.device.setCurrentViewport(first), D3D_OK);
        assert.equal(first.refCount, 3);
        const current = f.device.getCurrentViewport();
        assert.equal(current.viewport, first);
        assert.equal(first.refCount, 4, 'the caller gets a reference of its own');
        first.release();

        assert.equal(f.device.setCurrentViewport(second), D3D_OK);
        assert.equal(first.refCount, 2, 'the old current viewport\'s reference was given back');
        assert.equal(second.refCount, 3);
        assert.equal(f.device.deleteViewport(second), D3D_OK);
        assert.equal(second.refCount, 1, 'the delete took both references');
        assert.equal(f.device.getCurrentViewport().hr, D3DERR_NOCURRENTVIEWPORT);

        const walked = f.device.nextViewport(null, D3DNEXT_HEAD);
        assert.equal(walked.found, first);
        walked.found.release();
        assert.equal(f.device.nextViewport(first, D3DNEXT_NEXT).hr, DDERR_INVALIDPARAMS,
            'the list ends');
        const tail = f.device.nextViewport(null, D3DNEXT_TAIL);
        assert.equal(tail.found, first);
        tail.found.release();

        assert.equal(second.release(), 0);
        f.done();
        assert.equal(first.refCount, 1);
        assert.equal(first.release(), 0);
    });

test('the second generation never gives back the reference that made a viewport current', ()=>{
    // Wine's ddraw2.c test_viewport_object, whose counts Windows meets and
    // Wine marks todo: the reference leaks on delete and on the device's end.
    const f = fixture(2);
    const deleted = f.legacy.createViewport();
    f.device.addViewport(deleted);
    f.device.setCurrentViewport(deleted);
    assert.equal(deleted.refCount, 3);
    assert.equal(f.device.deleteViewport(deleted), D3D_OK);
    assert.equal(deleted.refCount, 2, 'only the list\'s reference went');
    assert.equal(f.device.getCurrentViewport().hr, D3DERR_NOCURRENTVIEWPORT,
        'though it is current no more');

    const kept = f.legacy.createViewport();
    f.device.addViewport(kept);
    f.device.setCurrentViewport(kept);
    assert.equal(deleted.refCount, 2, 'a new current viewport does not free the old reference');
    assert.equal(kept.refCount, 3);
    f.done();
    assert.equal(kept.refCount, 2, 'the device\'s end leaves the current viewport\'s reference');
    for (const viewport of [deleted, kept])
    {
        viewport.release();
        assert.equal(viewport.release(), 0);
    }
});

test('a DrawPrimitive device refuses a viewport its target cannot hold', ()=>{
    // Wine's ddraw2.c and ddraw4.c test_viewport; the execute-buffer device
    // keeps one and draws nothing through it (ddraw1.c test_viewport).
    for (const [version, expected] of /** @type {const} */ ([
        [3, DDERR_INVALIDPARAMS], [2, DDERR_INVALIDPARAMS], [1, D3D_OK],
    ]))
    {
        const f = fixture(version);
        const viewport = f.legacy.createViewport();
        f.device.addViewport(viewport);
        assert.equal(viewport.setViewport2({ x: 8, y: 4, width: 57, height: 20, clipX: -1,
            clipY: 1, clipWidth: 2, clipHeight: 2, minZ: 0, maxZ: 1 }), expected);
        assert.equal(viewport.setViewport2({ x: 8, y: 4, width: 56, height: 44, clipX: -1,
            clipY: 1, clipWidth: 2, clipHeight: 2, minZ: 0, maxZ: 1 }), D3D_OK);
        viewport.release();
        f.done();
    }
});

test('the current viewport sets the rectangle and carries its clip volume on the projection', ()=>{
    const f = fixture(1);
    const viewport = f.legacy.createViewport();
    f.device.addViewport(viewport);
    viewport.setViewport2({ x: 8, y: 4, width: 500, height: 20, clipX: 0, clipY: 1,
        clipWidth: 1, clipHeight: 2, minZ: 0.25, maxZ: 0.75 });
    const mark = f.calls.length;
    assert.equal(f.device.setCurrentViewport(viewport), D3D_OK);

    const [, rect] = f.since('SetViewport', mark).at(-1) ?? [];
    assert.deepEqual(rect, { X: 8, Y: 4, Width: 56, Height: 20, MinZ: 0, MaxZ: 1 },
        'a rectangle past the target, which the first generation keeps, is cut to it, and '
        + 'the depth the whole of the buffer');
    const [, type, projection] = f.since('SetTransform', mark).at(-1) ?? [];
    assert.equal(type, D3DTRANSFORMSTATE_PROJECTION);
    assert.deepEqual([...projection], [...clipVolumeMatrix(/** @type {any} */ (viewport.data))]);
    // The right half of the unit square, (0..1, -1..1), fills the viewport.
    assert.deepEqual([projection[0], projection[12]], [2, -1]);
    // And the volume's depth, 0.25 to 0.75, fills the buffer's 0 to 1.
    assert.deepEqual([projection[10], projection[14]], [2, -0.5]);

    const scale = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    assert.equal(f.device.setTransform(D3DTRANSFORMSTATE_PROJECTION, scale), D3D_OK);
    /** @type {{ matrix?: Float32Array }} */
    const read = {};
    f.device.getTransform(D3DTRANSFORMSTATE_PROJECTION, read);
    assert.deepEqual([...(read.matrix ?? [])], scale,
        'the program reads back the projection it set, not the one drawn with');
    const [, , drawn] = f.since('SetTransform', mark).at(-1) ?? [];
    assert.deepEqual([drawn[0], drawn[12]], [4, -1]);

    viewport.release();
    f.done();
});

test('a clear of no rectangles clears nothing, and a clear goes through its own viewport',
    ()=>{
        const f = fixture();
        const viewport = f.viewport();
        const rect = [{ x1: 0, y1: 0, x2: 64, y2: 48 }];
        const mark = f.calls.length;
        assert.equal(viewport.clear2(rect, D3DCLEAR.TARGET, 0x00ffffff, 0, 0), D3D_OK);
        assert.equal(viewport.clear2([], D3DCLEAR.TARGET, 0x00ff0000, 0, 0), D3D_OK);
        assert.equal(viewport.clear2(null, D3DCLEAR.TARGET, 0x0000ff00, 0, 0), D3D_OK);
        const clears = f.since('Clear', mark);
        assert.equal(clears.length, 1, 'Wine\'s ddraw4.c test_clear_rect_count');
        assert.equal(clears[0][4], 0x00ffffff);

        const unattached = f.legacy.createViewport();
        assert.equal(unattached.clear2(rect, D3DCLEAR.TARGET, 0, 0, 0),
            D3DERR_VIEWPORTHASNODEVICE);
        assert.equal(unattached.release(), 0);
        viewport.release();
        f.done();
    });

test('a viewport clears to its background material\'s diffuse colour, or black', ()=>{
    const f = fixture();
    const viewport = f.viewport();
    const material = f.legacy.createMaterial();
    material.setMaterial({ diffuse: { r: 1, g: 0, b: 0, a: 1 }, ambient: { r: 0, g: 0, b: 0, a: 0 },
        specular: { r: 0, g: 0, b: 0, a: 0 }, emissive: { r: 0, g: 0, b: 0, a: 0 }, power: 0,
        texture: 0, rampSize: 0 });
    const handle = material.getHandle();
    assert.equal(material.getHandle(), handle, 'one material, one handle');
    const rect = [{ x1: 0, y1: 0, x2: 64, y2: 48 }];

    assert.deepEqual(viewport.getBackground(), { handle: 0, valid: false });
    let mark = f.calls.length;
    viewport.clear(rect, D3DCLEAR.TARGET);
    assert.equal(f.since('Clear', mark)[0][4], 0);

    assert.equal(viewport.setBackground(handle), D3D_OK);
    assert.equal(viewport.setBackground(0), DDERR_INVALIDPARAMS);
    assert.deepEqual(viewport.getBackground(), { handle, valid: true },
        'a refused handle leaves the one set before (Wine\'s ddraw4.c test_material)');
    mark = f.calls.length;
    viewport.clear(rect, D3DCLEAR.TARGET);
    assert.equal(f.since('Clear', mark)[0][4], 0xffff0000);

    assert.equal(material.release(), 0);
    assert.equal(f.legacy.materialOf(handle), null, 'the handle goes with the material');
    viewport.release();
    f.done();
});

// --- lighting (Wine's ddraw4.c test_lighting_interface_versions, test_lighting) ---

test('a draw is lit when a material is set, the vertices have normals and it did not say not to',
    ()=>{
        const f = fixture();
        f.viewport();
        f.device.BeginScene();
        /** @param {number} fvf @param {number} flags */
        const lit = (fvf, flags)=>{
            const mark = f.calls.length;
            const stride = /** @type {Record<number, number>} */ ({
                [FVF_VERTEX]: 32, [FVF_LVERTEX]: 20, [FVF_TLVERTEX]: 24 })[fvf];
            assert.equal(f.device.drawPrimitive(D3DPT.TRIANGLESTRIP, fvf, zeros(4, stride), 4,
                flags), D3D_OK);
            const set = f.since('SetRenderState', mark).filter(call=>call[1] === RS_LIGHTING);
            return set.at(-1)?.[2];
        };

        assert.equal(lit(FVF_VERTEX, 0), 0, 'no material: a quad with normals is drawn unlit');
        const material = f.legacy.createMaterial();
        assert.equal(f.device.setLightState(D3DLIGHTSTATE.MATERIAL, material.getHandle()),
            D3D_OK);
        assert.equal(lit(FVF_VERTEX, 0), 1);
        assert.equal(lit(FVF_VERTEX, D3DDP_DONOTLIGHT), 0);
        assert.equal(lit(FVF_LVERTEX, 0), 0, 'no normals');
        assert.equal(lit(FVF_TLVERTEX, 0), 0, 'transformed already');

        // D3DRENDERSTATE_LIGHTING is not a state of these versions: it reads
        // back as set and changes nothing.
        assert.equal(f.device.setRenderState(RS_LIGHTING, 0), D3D_OK);
        /** @type {{ value?: number }} */
        const read = {};
        f.device.getRenderState(RS_LIGHTING, read);
        assert.equal(read.value, 0);
        assert.equal(lit(FVF_VERTEX, 0), 1);

        f.device.EndScene();
        assert.equal(material.release(), 0);
        f.done();
    });

test('specular highlights start off on the third generation and on before it', ()=>{
    for (const [version, expected] of /** @type {const} */ ([[3, 0], [2, 1]]))
    {
        const f = fixture(version);
        /** @type {{ value?: number }} */
        const read = {};
        assert.equal(f.device.getRenderState(RS_SPECULARENABLE, read), D3D_OK);
        assert.equal(read.value, expected);
        f.done();
    }
});

test('a light belongs to one viewport, and only an active one lights a draw', ()=>{
    const f = fixture();
    const viewport = f.viewport();
    const other = f.legacy.createViewport();
    const light = f.legacy.createLight();
    const directional = {
        type: 3, color: { r: 1, g: 1, b: 1, a: 0.5 }, position: { x: 0, y: 0, z: 0 },
        direction: { x: 0, y: 0, z: 1 }, range: 0, falloff: 0, attenuation0: 0,
        attenuation1: 0, attenuation2: 0, theta: 0, phi: 0, flags: 0,
    };
    assert.equal(light.setLight(directional, true), D3D_OK);
    assert.equal(viewport.addLight(light), D3D_OK);
    assert.equal(light.refCount, 2);
    assert.equal(viewport.addLight(light), D3DERR_LIGHTHASVIEWPORT);
    assert.equal(other.addLight(light), D3DERR_LIGHTHASVIEWPORT);
    assert.equal(other.deleteLight(light), D3DERR_LIGHTNOTINTHISVIEWPORT);

    const material = f.legacy.createMaterial();
    f.device.setLightState(D3DLIGHTSTATE.MATERIAL, material.getHandle());
    f.device.BeginScene();
    /** @returns {any[][]} the lights switched on for one lit draw */
    const enabledFor = ()=>{
        const mark = f.calls.length;
        f.device.drawPrimitive(D3DPT.TRIANGLESTRIP, FVF_VERTEX, zeros(4, 32), 4, 0);
        return f.since('LightEnable', mark).filter(call=>call[2] === true);
    };
    assert.equal(enabledFor().length, 0, 'a D3DLIGHT2 without D3DLIGHT_ACTIVE is off');

    assert.equal(light.setLight({ ...directional, flags: D3DLIGHT_ACTIVE }, true), D3D_OK);
    assert.equal(enabledFor().length, 1);
    assert.equal(light.getLight()?.flags, D3DLIGHT_ACTIVE, 'the flags read back as set');

    assert.equal(light.setLight({ ...directional, flags: 0 }, false), D3D_OK);
    assert.equal(light.getLight()?.flags, D3DLIGHT_ACTIVE, 'a D3DLIGHT has no flags: it is on');

    const walked = viewport.nextLight(null, D3DNEXT_HEAD);
    assert.equal(walked.found, light);
    assert.equal(light.refCount, 3, 'the walk hands back a reference (Wine\'s d3d.c)');
    light.release();
    assert.equal(viewport.deleteLight(light), D3D_OK);
    assert.equal(light.refCount, 1);
    assert.equal(light.viewport, null);
    assert.equal(light.setLight({ ...directional, type: 0 }, true), DDERR_INVALIDPARAMS);

    f.device.EndScene();
    assert.equal(light.release(), 0);
    assert.equal(material.release(), 0);
    assert.equal(other.release(), 0);
    viewport.release();
    f.done();
});

// --- texturing (Wine's ddraw4.c test_texturemapblend) ---

test('TEXTUREMAPBLEND sets stage zero, until a stage state set to something else ends it', ()=>{
    const f = fixture();
    f.viewport();
    /** @type {{ value?: number }} */
    const read = {};
    f.device.getRenderState(RS_TEXTUREMAPBLEND, read);
    assert.equal(read.value, D3DTBLEND.MODULATE);
    f.device.inner.GetTextureStageState(0, D3DTSS.ALPHAOP, read);
    assert.equal(read.value, D3DTOP.SELECTARG1);

    const plain = surface(f.root, { caps: DDSCAPS_TEXTURE, pixelFormat: XRGB32 });
    const alpha = surface(f.root, { caps: DDSCAPS_TEXTURE, pixelFormat: ARGB32 });
    f.device.BeginScene();
    /** @returns {number[]} the stage-zero alpha operations a draw set, in order */
    const alphaOpsOfDraw = ()=>{
        const mark = f.calls.length;
        f.device.drawPrimitive(D3DPT.TRIANGLESTRIP, FVF_TLVERTEX, zeros(4, 24), 4, 0);
        return f.since('SetTextureStageState', mark)
            .filter(call=>call[1] === 0 && call[2] === D3DTSS.ALPHAOP).map(call=>call[3]);
    };

    assert.equal(f.device.setTexture(0, plain), D3D_OK);
    assert.deepEqual(alphaOpsOfDraw(), [D3DTOP.SELECTARG2, D3DTOP.SELECTARG1],
        'MODULATE takes the vertex alpha for a texture that has none, for that draw only');
    f.device.setTexture(0, alpha);
    assert.deepEqual(alphaOpsOfDraw(), [], 'and the texture\'s for one that has it');
    f.device.setTexture(0, plain);

    assert.equal(f.device.setTextureStageState(0, D3DTSS.COLOROP, D3DTOP.MODULATE), D3D_OK);
    assert.deepEqual(alphaOpsOfDraw(), [D3DTOP.SELECTARG2, D3DTOP.SELECTARG1],
        'a stage state set to what the blend already put there leaves the blend on');
    f.device.setTextureStageState(0, D3DTSS.ALPHAOP, D3DTOP.SELECTARG2);
    assert.deepEqual(alphaOpsOfDraw(), [], 'set to anything else, the program owns the stage');
    f.device.setRenderState(RS_TEXTUREMAPBLEND, D3DTBLEND.MODULATE);
    assert.deepEqual(alphaOpsOfDraw(), [], 'the same mode again does not take it back');
    f.device.setRenderState(RS_TEXTUREMAPBLEND, D3DTBLEND.ADD);
    f.device.setRenderState(RS_TEXTUREMAPBLEND, D3DTBLEND.MODULATE);
    assert.deepEqual(alphaOpsOfDraw(), [D3DTOP.SELECTARG2, D3DTOP.SELECTARG1],
        'a different mode does');

    f.device.EndScene();
    f.device.setTexture(0, null);
    assert.equal(plain.release(), 0);
    assert.equal(alpha.release(), 0);
    f.done();
});

test('a texture handle names a surface, looked up at the draw so a swap is seen', ()=>{
    const f = fixture(2);
    f.viewport();
    const first = surface(f.root, { caps: DDSCAPS_TEXTURE });
    const second = surface(f.root, { caps: DDSCAPS_TEXTURE });
    assert.equal(f.textures.swap(first, second), DDERR_INVALIDPARAMS,
        'neither has a handle yet (Wine\'s ddraw2.c test_multiple_devices)');
    const a = f.textures.handleOf(first);
    assert.equal(f.textures.handleOf(first), a, 'asked twice, one handle');
    assert.equal(f.textures.swap(first, second), DDERR_INVALIDPARAMS);
    const b = f.textures.handleOf(second);
    assert.notEqual(a, b);

    assert.equal(f.device.setRenderState(RS_TEXTUREHANDLE, a), D3D_OK);
    assert.equal(f.textures.swap(first, second), D3D_OK);
    assert.equal(f.textures.handleOf(first), b);
    /** @type {{ value?: number }} */
    const read = {};
    f.device.getRenderState(RS_TEXTUREHANDLE, read);
    assert.equal(read.value, a, 'the state still reads the number set');

    f.device.BeginScene();
    const mark = f.calls.length;
    f.device.drawPrimitive(D3DPT.TRIANGLESTRIP, FVF_TLVERTEX, zeros(4, 24), 4, 0);
    assert.equal(f.since('SetTexture', mark).at(-1)?.[2], second,
        'the draw textures with the surface the handle names now');
    f.device.EndScene();

    f.device.setRenderState(RS_TEXTUREHANDLE, 0);
    assert.equal(first.release(), 0);
    assert.equal(second.release(), 0);
    assert.equal(f.textures.surfaceOf(b), null, 'a handle to a released surface names nothing');
    f.done();
});

test('the legacy filters become stage-zero filters in Direct3D 7\'s numbering', ()=>{
    const f = fixture();
    const mark = f.calls.length;
    assert.equal(f.device.setRenderState(RS_TEXTUREMIN, D3DFILTER.LINEARMIPLINEAR), D3D_OK);
    const set = f.since('SetTextureStageState', mark);
    assert.deepEqual(set.map(call=>call.slice(1)), [
        [0, D3DTSS.MINFILTER, 2], [0, D3DTSS.MIPFILTER, 3],
    ], 'linear, and linear between levels');
    /** @type {{ value?: number }} */
    const read = {};
    f.device.getRenderState(RS_TEXTUREMIN, read);
    assert.equal(read.value, D3DFILTER.LINEARMIPLINEAR);
    f.done();
});

// --- immediate mode and statistics ---

test('Begin, Vertex and End draw one primitive a vertex at a time, and are counted', ()=>{
    const f = fixture();
    f.viewport();
    f.device.BeginScene();
    assert.equal(f.device.vertex(zeros(1, 24)), 0x88760303, 'D3DERR_NOTINBEGIN');
    assert.equal(f.device.begin(D3DPT.TRIANGLELIST, FVF_TLVERTEX, 0), D3D_OK);
    assert.equal(f.device.begin(D3DPT.TRIANGLELIST, FVF_TLVERTEX, 0), 0x88760302,
        'D3DERR_INBEGIN');
    assert.equal(f.device.beginStride, 24);
    for (let k = 0; k < 3; k++)
    {
        assert.equal(f.device.vertex(zeros(1, 24)), D3D_OK);
    }
    const mark = f.calls.length;
    assert.equal(f.device.end(), D3D_OK);
    const [draw] = f.since('DrawPrimitive', mark);
    assert.deepEqual([draw[1], draw[2], draw[3].byteLength, draw[4]],
        [D3DPT.TRIANGLELIST, FVF_TLVERTEX, 72, 3]);

    f.device.drawPrimitive(D3DPT.LINESTRIP, FVF_TLVERTEX, zeros(3, 24), 3, 0);
    assert.deepEqual(f.device.getStats(),
        { triangles: 1, lines: 2, points: 0, vertices: 6 });
    f.device.EndScene();
    f.done();
});
