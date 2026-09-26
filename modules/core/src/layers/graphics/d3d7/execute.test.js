/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Execute buffers run on a legacy device: what the instructions leave in the
 * transformed vertices a draw is handed. The expectations are Wine's ddraw1.c
 * test_lighting, whose colours come from exactly these vertices.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExecuteBuffer, executeBuffer } from './execute.js';
import { createLegacyDirect3D, createTextureHandles } from './legacy.js';
import { createDirect3D7 } from './device.js';
import { D3DLIGHTSTATE, D3DLIGHT_ACTIVE, D3D_OK, DEVICE_IDS } from './constants.js';
import { createDirectDraw } from '../ddraw/objects.js';
import {
    DDPF_RGB, DDSCAPS_3DDEVICE, DDSCAPS_OFFSCREENPLAIN, DDSCL_NORMAL, DDSD_CAPS, DDSD_HEIGHT,
    DDSD_PIXELFORMAT, DDSD_WIDTH,
} from '../ddraw/constants.js';

const HWND = 0x00010044;
const XRGB32 = Object.freeze({
    size: 0x20, flags: DDPF_RGB, fourCC: 0, bitCount: 32,
    redMask: 0xff0000, greenMask: 0xff00, blueMask: 0xff, alphaMask: 0,
});

/** A device of the first generation over a 64x48 target, whose draws are recorded. */
function fixture(){
    const bytes = new Uint8Array(1 << 16);
    const view = new DataView(bytes.buffer);
    const memory = {
        /** @param {number} at @param {number} length */
        readMemory: (at, length)=>bytes.slice(at, at + length),
        /** @param {number} at @param {Uint8Array} value */
        writeMemory: (at, value)=>bytes.set(value, at),
    };
    const root = createDirectDraw({ version: 1, screenWidth: 64, screenHeight: 48 });
    root.setCooperativeLevel(HWND, DDSCL_NORMAL);
    const d3d7 = createDirect3D7(root);
    /** @type {any[][]} */
    const draws = [];
    const watched = {
        ...d3d7,
        /** @param {string} id @param {any} target */
        createDevice(id, target){
            const made = d3d7.createDevice(id, target);
            const inner = made.device;
            const draw = inner.DrawIndexedPrimitive;
            inner.DrawIndexedPrimitive = (/** @type {any[]} */ ...args)=>{
                draws.push(args);
                return draw(...args);
            };
            return made;
        },
    };
    const legacy = createLegacyDirect3D(watched, createTextureHandles());
    const target = root.createSurface({
        flags: DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT | DDSD_PIXELFORMAT,
        caps: DDSCAPS_3DDEVICE | DDSCAPS_OFFSCREENPLAIN, width: 64, height: 48,
        pixelFormat: XRGB32,
    }, { version: 1 }).surface;
    const device = legacy.createDevice(DEVICE_IDS.HAL, target, 1).device;
    const viewport = legacy.createViewport();
    device.addViewport(viewport);
    viewport.setViewport2({ x: 0, y: 0, width: 64, height: 48, clipX: -1, clipY: 1,
        clipWidth: 2, clipHeight: 2, minZ: 0, maxZ: 1 });
    const identity = device.createMatrix();

    const base = 0x1000;
    const buffer = createExecuteBuffer({ caps: 0, size: 1024, data: base });
    /**
     * Four D3DVERTEX at the start of the buffer, with this normal, and the
     * instructions after them: transform, view and projection the identity,
     * then process with `flags` and draw the square.
     *
     * @param {number[]} normal @param {number[]} extra  Instruction bytes before processing.
     */
    const run = (normal, extra = [])=>{
        [[-1, -1], [-1, 1], [1, 1], [1, -1]].forEach(([x, y], k)=>{
            [x, y, 0, ...normal, 0, 0].forEach((value, index)=>
                view.setFloat32(base + k * 32 + index * 4, value, true));
        });
        /** @type {number[]} */
        const stream = [];
        const dword = (/** @type {number} */ value)=>stream.push(value & 0xff,
            value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff);
        for (const type of [1, 2, 3])
        {
            stream.push(6, 8, 1, 0);
            dword(type);
            dword(identity);
        }
        stream.push(...extra);
        stream.push(9, 16, 1, 0);
        dword(0);
        dword(0);
        dword(4);
        dword(0);
        stream.push(3, 8, 2, 0, 0, 0, 1, 0, 2, 0, 1, 0, 2, 0, 3, 0, 0, 0, 1, 0);
        stream.push(11, 0, 0, 0);
        bytes.set(stream, base + 128);
        buffer.setExecuteData({ vertexOffset: 0, vertexCount: 4, instructionOffset: 128,
            instructionLength: stream.length, hVertexOffset: 0,
            status: { flags: 0, status: 0, extent: [0, 0, 0, 0] } });
        draws.length = 0;
        device.BeginScene();
        const hr = executeBuffer({ memory, device, buffer, viewport });
        device.EndScene();
        assert.equal(hr, D3D_OK);
        assert.equal(draws.length, 1, 'one draw of the square');
        const [, , vertices] = draws[0];
        return new DataView(vertices.buffer, vertices.byteOffset, vertices.byteLength)
            .getUint32(16, true);
    };
    return { device, viewport, legacy, run };
}

test('a D3DVERTEX processed with no material is white, and one lit takes its light', ()=>{
    const f = fixture();
    // ddraw1.c test_lighting: "Unlit quad with normals" is white.
    assert.equal(f.run([1, 1, 1]), 0xffffffff);

    const material = f.legacy.createMaterial();
    const one = { r: 1, g: 1, b: 1, a: 1 };
    const none = { r: 0, g: 0, b: 0, a: 0 };
    material.setMaterial({ diffuse: one, ambient: one, specular: none, emissive: none,
        power: 0, texture: 0, rampSize: 0 });
    const light = f.legacy.createLight();
    light.setLight({ type: 3, color: { r: 0, g: 0.25, b: 1, a: 1 },
        position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 }, range: 0,
        falloff: 0, attenuation0: 0, attenuation1: 0, attenuation2: 0, theta: 0, phi: 0,
        flags: D3DLIGHT_ACTIVE }, false);
    assert.equal(f.viewport.addLight(light), D3D_OK);

    // The material and the ambient light arrive by D3DOP_STATELIGHT, as the test sends them.
    const handle = material.getHandle();
    const states = [7, 8, 2, 0,
        D3DLIGHTSTATE.MATERIAL, 0, 0, 0, handle & 0xff, handle >>> 8 & 0xff, 0, 0,
        D3DLIGHTSTATE.AMBIENT, 0, 0, 0, 0x00, 0x20, 0x00, 0xff];
    assert.equal(f.run([0, 0, -1], states) & 0xffffff, 0x0060ff,
        'Lit quad with light: the light\'s green and blue, and the ambient\'s green');
});
