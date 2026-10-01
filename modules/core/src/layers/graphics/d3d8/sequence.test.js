/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Recorded commands, held whole: a run of lit, indexed draws whose world,
 * view, lights, material, texture, render states and viewport change between
 * them, as a program's frame changes them, and every call the renderer made on
 * the recording GPU for it -- each uniform block's bytes, each pipeline's
 * descriptor and shader, each binding and draw -- with the lighting tallies a
 * frame's diagnostics report, reduced to one digest per frame.
 *
 * The digests were taken from the renderer before the work that keeps a
 * frame's preparation, key and matrices out of the heap: what that work may
 * change is what a draw costs, never what it asks of the GPU.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3DCLEAR, D3DCULL, D3DFMT, D3DFMT_INDEX, D3DFOG, D3DLIGHTTYPE, D3DPOOL, D3DPT, D3DRS,
    D3DSWAPEFFECT, D3DTS, D3DTSS, D3D_OK, floatToDword,
} from './constants.js';
import { createDirect3D8 } from './device.js';
import { normalMatrixOf } from './render.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { FVF } from '../webgpu/internal/vertexformat.js';

const RAM_BASE = 0x40000000;
const CAMERASPACENORMAL = 0x10000;

/** @param {number} value */
const ok = value=>assert.equal(value, D3D_OK);

/** FNV-1a over a string, as eight hex digits. @param {string} text */
function digest(text){
    let hash = 0x811c9dc5;
    for (let at = 0; at < text.length; at++)
    {
        hash = Math.imul(hash ^ text.charCodeAt(at), 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * A call's arguments as text: an object the double made by its id, bytes by
 * their exact bits.
 *
 * @param {any} value @param {number} depth
 * @returns {any}
 */
function plain(value, depth = 0){
    if (value === null || typeof value !== 'object')
    {
        return typeof value === 'number' && Object.is(value, -0) ? '-0' : value;
    }
    if (ArrayBuffer.isView(value))
    {
        const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        return `bytes:${bytes.length}:${digest(String.fromCharCode(...bytes))}`;
    }
    if (value instanceof ArrayBuffer)
    {
        return plain(new Uint8Array(value), depth);
    }
    if (typeof value.id === 'string' && typeof value.kind === 'string' && depth > 0)
    {
        return value.id;
    }
    if (depth > 6)
    {
        return '...';
    }
    if (Array.isArray(value))
    {
        return value.map(item=>plain(item, depth + 1));
    }
    /** @type {Record<string, any>} */
    const out = {};
    for (const key of Object.keys(value).sort())
    {
        if (typeof value[key] !== 'function')
        {
            out[key] = plain(value[key], depth + 1);
        }
    }
    return out;
}

/** @param {Partial<any>} over */
const light = (over = {})=>({
    Type: D3DLIGHTTYPE.DIRECTIONAL,
    Diffuse: { r: 1, g: 0.5, b: 0.25, a: 1 },
    Specular: { r: 0.5, g: 0.25, b: 0.125, a: 1 },
    Ambient: { r: 0.125, g: 0.0625, b: 0.03125, a: 1 },
    Position: { x: 1, y: 2, z: 3 },
    Direction: { x: 0, y: -1, z: 1 },
    Range: 50,
    Falloff: 1,
    Attenuation0: 1,
    Attenuation1: 0.1,
    Attenuation2: 0,
    Theta: 0.5,
    Phi: 1,
    ...over,
});

/** @param {number} value */
const material = value=>({
    Diffuse: { r: value, g: 1, b: 1, a: 1 },
    Ambient: { r: 1, g: value, b: 1, a: 1 },
    Specular: { r: 0.5, g: 0.5, b: value, a: 0 },
    Emissive: { r: 0, g: 0, b: 0, a: 0 },
    Power: 8 * value,
});

/** @param {number} index @returns {Float32Array} */
function worldOf(index){
    const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    matrix[0] = 1 + (index % 5) / 4;
    matrix[5] = 1 - (index % 3) / 8;
    matrix[1] = (index % 4) / 10;
    matrix[12] = index % 7 - 3;
    matrix[13] = (index >> 2) % 5 - 2;
    matrix[14] = 10 + (index % 3);
    if (index % 11 === 5)
    {
        // A world that is not affine, which is lit by its whole inverse.
        matrix[3] = 0.25;
    }
    if (index % 13 === 7)
    {
        // A world that collapses a dimension, which has no inverse.
        matrix[10] = 0;
    }
    return matrix;
}

function scene(){
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const ram = new Uint8Array(4 << 20);
    const d3d = createDirect3D8({
        backend,
        readMemory: (address, length)=>ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        windowMemory: (address, length)=>ram.subarray(address - RAM_BASE,
            address - RAM_BASE + length),
        createSampler: descriptor=>({ kind: 'sampler', id: `sampler-${JSON.stringify(descriptor)}`,
            descriptor }),
    });
    /** @type {{ device?: any }} */
    const out = {};
    ok(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1, backBufferWidth: 32,
        backBufferHeight: 32, backBufferFormat: D3DFMT.X8R8G8B8, enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT.D24S8,
    }, out));
    const device = out.device;
    const fvf = FVF.XYZ | FVF.NORMAL | (1 << FVF.TEXCOUNT_SHIFT);
    const stride = 32;
    /** @type {{ buffer?: any }} */
    const vertices = {};
    /** @type {{ buffer?: any }} */
    const indices = {};
    ok(device.CreateVertexBuffer(4 * stride, 0, fvf, D3DPOOL.MANAGED, vertices));
    ok(device.CreateIndexBuffer(6 * 2, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.MANAGED, indices));
    /** @type {{ pBits?: number }} */
    const locked = {};
    ok(vertices.buffer.Lock(0, 0, locked, 0));
    const view = new DataView(ram.buffer, /** @type {number} */ (locked.pBits) - RAM_BASE,
        4 * stride);
    [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([x, y], corner)=>{
        [x, y, 0, 0.6, 0, -0.8, (corner & 1), (corner >> 1)].forEach((value, index)=>
            view.setFloat32(corner * stride + index * 4, value, true));
    });
    ok(vertices.buffer.Unlock());
    ok(indices.buffer.Lock(0, 0, locked, 0));
    new Uint16Array(ram.buffer, /** @type {number} */ (locked.pBits) - RAM_BASE, 6)
        .set([0, 1, 2, 2, 1, 3]);
    ok(indices.buffer.Unlock());
    /** @type {any[]} */
    const textures = [];
    for (let made = 0; made < 2; made++)
    {
        /** @type {{ texture?: any }} */
        const texture = {};
        ok(device.CreateTexture(4, 4, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, texture));
        /** @type {{ pBits?: number }} */
        const rect = {};
        ok(texture.texture.LockRect(0, rect, null, 0));
        const at = /** @type {number} */ (rect.pBits) - RAM_BASE;
        ram.fill(0x30 + made * 0x50, at, at + 64);
        ok(texture.texture.UnlockRect(0));
        textures.push(texture.texture);
    }
    return { gpu, device, fvf, stride, vertices: vertices.buffer, indices: indices.buffer,
        textures };
}

test('recorded: a frame of lit draws asks the same of the GPU as it did', async()=>{
    const s = scene();
    const { gpu, device } = s;
    ok(device.SetRenderState(D3DRS.LIGHTING, 1));
    ok(device.SetRenderState(D3DRS.AMBIENT, 0xff203040));
    ok(device.SetRenderState(D3DRS.SPECULARENABLE, 1));
    ok(device.SetMaterial(material(1)));
    ok(device.SetLight(0, light()));
    ok(device.SetLight(1, light({ Type: D3DLIGHTTYPE.POINT, Position: { x: 2, y: 1, z: 8 } })));
    ok(device.SetLight(2, light({ Type: D3DLIGHTTYPE.SPOT, Direction: { x: 0, y: 0, z: 1 } })));
    ok(device.SetLight(5, light({ Type: D3DLIGHTTYPE.POINT, Range: 4 })));
    [0, 1, 2].forEach(index=>ok(device.LightEnable(index, true)));
    ok(device.SetTransform(D3DTS.PROJECTION, new Float32Array([1.5, 0, 0, 0, 0, 2, 0, 0,
        0, 0, 1.001, 1, 0, 0, -0.1, 0])));
    const views = [
        new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1]),
        new Float32Array([0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, -2, 6, 1]),
    ];
    const worlds = Array.from({ length: 32 }, (_, index)=>worldOf(index));
    /** @type {string[]} */
    const frames = [];
    for (let frame = 0; frame < 4; frame++)
    {
        ok(device.BeginScene());
        ok(device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER, 0xff000000, 1, 0));
        ok(device.SetTransform(D3DTS.VIEW, views[0]));
        ok(device.SetViewport({ X: 0, Y: 0, Width: 32, Height: 32, MinZ: 0, MaxZ: 1 }));
        ok(device.SetVertexShader(s.fvf));
        ok(device.SetStreamSource(0, s.vertices, s.stride));
        ok(device.SetIndices(s.indices, 0));
        if (frame === 2)
        {
            ok(device.SetRenderState(D3DRS.FOGENABLE, 1));
            ok(device.SetRenderState(D3DRS.FOGVERTEXMODE, D3DFOG.LINEAR));
            ok(device.SetRenderState(D3DRS.FOGSTART, floatToDword(2)));
            ok(device.SetRenderState(D3DRS.FOGEND, floatToDword(40)));
        }
        if (frame === 3)
        {
            ok(device.SetRenderState(D3DRS.FOGENABLE, 0));
        }
        for (let index = 0; index < 32; index++)
        {
            // The same world twice in a row now and then, as a program that
            // sets it per draw does for two draws of one model.
            const model = index % 4 === 1 ? index - 1 : index;
            ok(device.SetTransform(D3DTS.WORLD, worlds[(model * 3 + frame) % 32]));
            ok(device.SetTexture(0, s.textures[(index >> 1) & 1]));
            ok(device.SetRenderState(D3DRS.CULLMODE, index & 2 ? D3DCULL.CW : D3DCULL.CCW));
            ok(device.SetRenderState(D3DRS.ALPHABLENDENABLE, index % 3 === 0 ? 1 : 0));
            // The same light again, where a program sets its lights per model.
            ok(device.SetLight(0, light()));
            ok(device.LightEnable(0, true));
            if (index === 8)
            {
                ok(device.SetLight(1, light({ Type: D3DLIGHTTYPE.POINT,
                    Position: { x: -2, y: 3, z: 9 + frame } })));
            }
            if (index === 12)
            {
                ok(device.LightEnable(5, true));
            }
            if (index === 16)
            {
                ok(device.LightEnable(2, false));
            }
            if (index === 24)
            {
                ok(device.LightEnable(2, true));
                ok(device.LightEnable(5, false));
            }
            if (index === 14)
            {
                ok(device.SetTransform(D3DTS.VIEW, views[1]));
            }
            if (index === 22)
            {
                ok(device.SetTransform(D3DTS.VIEW, views[0]));
            }
            if (index === 18)
            {
                ok(device.SetMaterial(material(0.5 + frame / 8)));
            }
            if (index === 26)
            {
                ok(device.SetMaterial(material(1)));
            }
            if (index === 6)
            {
                ok(device.SetTextureStageState(0, D3DTSS.TEXCOORDINDEX, CAMERASPACENORMAL));
            }
            if (index === 10)
            {
                ok(device.SetTextureStageState(0, D3DTSS.TEXCOORDINDEX, 0));
            }
            if (index === 20)
            {
                ok(device.SetViewport({ X: 4, Y: 2, Width: 20, Height: 24, MinZ: 0, MaxZ: 1 }));
            }
            if (index === 28)
            {
                ok(device.SetRenderState(D3DRS.AMBIENT, 0xff101010 * (frame + 1)));
            }
            ok(device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 4, 0, 2));
        }
        ok(device.EndScene());
        ok(device.Present());
        await device.idle();
        const { lighting, failures } = device.diagnostics();
        assert.deepEqual(failures, []);
        frames.push(digest(JSON.stringify(plain({ calls: gpu.calls, lighting }))));
        gpu.reset();
    }
    assert.deepEqual(frames, EXPECTED);
});

/**
 * The normal matrix as it was formed with each minor gathered into an array
 * of its own: the arithmetic the table-driven one must repeat exactly.
 *
 * @param {ArrayLike<number>} m @param {Float32Array} out
 */
function gatheredNormalMatrix(m, out){
    /** @param {number} row @param {number} column */
    const minor = (row, column)=>{
        /** @type {number[]} */
        const cells = [];
        for (let r = 0; r < 4; r++)
        {
            for (let c = 0; c < 4; c++)
            {
                if (r !== row && c !== column)
                {
                    cells.push(m[r * 4 + c]);
                }
            }
        }
        const [a, b, c, d, e, f, g, h, i] = cells;
        return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    };
    for (let row = 0; row < 4; row++)
    {
        for (let column = 0; column < 4; column++)
        {
            out[row * 4 + column] = ((row + column) % 2 === 0 ? 1 : -1) * minor(row, column) || 0;
        }
    }
    const determinant = m[0] * out[0] + m[1] * out[1] + m[2] * out[2] + m[3] * out[3];
    if (determinant !== 0)
    {
        for (let at = 0; at < 16; at++)
        {
            out[at] /= determinant;
        }
    }
    return out;
}

test('the normal matrix is the same bits as the minors gathered one by one gave', ()=>{
    // A generator of its own, so the matrices are the same on every run.
    let seed = 0x2545f491;
    const next = ()=>{
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return (seed >>> 0) / 0x100000000;
    };
    const expected = new Uint32Array(16);
    const actual = new Uint32Array(16);
    for (let round = 0; round < 4000; round++)
    {
        const m = new Float32Array(16);
        for (let at = 0; at < 16; at++)
        {
            // Every fourth a small integer, zero among them, so singular
            // matrices and exact zeros come up as well as general ones.
            m[at] = round % 4 === 0 ? Math.floor(next() * 3) - 1 : (next() - 0.5) * 20;
        }
        gatheredNormalMatrix(m, new Float32Array(expected.buffer));
        normalMatrixOf(m, new Float32Array(actual.buffer));
        assert.deepEqual(actual, expected, `matrix ${[...m]}`);
    }
});

const EXPECTED = ['e9efd744', '51803e24', '8278ac61', 'bf6e68cb'];
