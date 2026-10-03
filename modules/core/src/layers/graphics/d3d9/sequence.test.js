/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Recorded commands, held whole: Direct3D 9 frames of lit fixed-function
 * draws and of draws through a shader pair, with the world, lights, texture,
 * constants and render states changed between them as a program's frame
 * changes them, and every call the renderer made on the recording GPU for
 * them -- each uniform and constant block's bytes, each pipeline and shader,
 * each binding and draw -- reduced to one digest per frame.
 *
 * The digests were taken from the device and renderer before the work that
 * keeps a light set again, a world written again and a shader draw's pieces
 * from being made again: that work may change what a draw costs, never what
 * it asks of the GPU.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3DFMT, D3DPOOL, D3DSWAPEFFECT, D3D_OK } from './constants.js';
import {
    D3DBLEND, D3DCLEAR, D3DCULL, D3DFMT_INDEX, D3DLIGHTTYPE, D3DPT, D3DRS, D3DTS,
} from '../d3d8/constants.js';
import { createDirect3D9 } from './device.js';
import { D3DDECLTYPE, D3DDECLUSAGE } from './declaration.js';
import { END_TOKEN, OPCODE, REGISTER, SHADER_KIND, versionToken } from './shader.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { FVF } from '../webgpu/internal/vertexformat.js';

const RAM_BASE = 0x40000000;

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

/** @param {number} type @param {number} index */
const dst = (type, index)=>(0x80000000 | ((type & 7) << 28) | ((type & 0x18) << 8) | (0xf << 16)
    | index) >>> 0;
/** @param {number} type @param {number} index */
const src = (type, index)=>(0x80000000 | ((type & 7) << 28) | ((type & 0x18) << 8) | (0xe4 << 16)
    | index) >>> 0;
/** @param {number} opcode @param {number} length */
const op = (opcode, length)=>((length << 24) | opcode) >>> 0;
/** @param {number} usage @param {number} register */
const dclInput = (usage, register)=>[
    op(OPCODE.DCL, 2), (0x80000000 | usage) >>> 0, dst(REGISTER.INPUT, register),
];

/** vs_2_0: the position through c0..c3, the coordinate set carried. */
const VERTEX_SHADER = [
    versionToken(SHADER_KIND.VERTEX, 2, 0),
    ...dclInput(D3DDECLUSAGE.POSITION, 0),
    ...dclInput(D3DDECLUSAGE.TEXCOORD, 1),
    op(OPCODE.M4x4, 3), dst(REGISTER.RASTOUT, 0), src(REGISTER.INPUT, 0), src(REGISTER.CONST, 0),
    op(OPCODE.MOV, 2), dst(REGISTER.TEXCRDOUT, 0), src(REGISTER.INPUT, 1),
    END_TOKEN,
];

/** ps_2_0: a texture sample offset by c2. */
const PIXEL_SHADER = [
    versionToken(SHADER_KIND.PIXEL, 2, 0),
    op(OPCODE.DCL, 2), (2 << 27) >>> 0, dst(REGISTER.SAMPLER, 0),
    op(OPCODE.DCL, 2), 0x80000000, dst(REGISTER.TEXTURE, 0),
    op(OPCODE.TEX, 3), dst(REGISTER.TEMP, 0), src(REGISTER.TEXTURE, 0), src(REGISTER.SAMPLER, 0),
    op(OPCODE.ADD, 3), dst(REGISTER.COLOROUT, 0), src(REGISTER.TEMP, 0), src(REGISTER.CONST, 2),
    END_TOKEN,
];

const ELEMENTS = [
    { Stream: 0, Offset: 0, Type: D3DDECLTYPE.FLOAT3, Method: 0, Usage: D3DDECLUSAGE.POSITION,
        UsageIndex: 0 },
    { Stream: 0, Offset: 12, Type: D3DDECLTYPE.FLOAT3, Method: 0, Usage: D3DDECLUSAGE.NORMAL,
        UsageIndex: 0 },
    { Stream: 0, Offset: 24, Type: D3DDECLTYPE.FLOAT2, Method: 0, Usage: D3DDECLUSAGE.TEXCOORD,
        UsageIndex: 0 },
];

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

/** @param {number} index @returns {Float32Array} */
function worldOf(index){
    const matrix = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    matrix[0] = 1 + (index % 5) / 4;
    matrix[1] = (index % 4) / 10;
    matrix[12] = index % 7 - 3;
    matrix[14] = 10 + (index % 3);
    return matrix;
}

function scene(){
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    const ram = new Uint8Array(4 << 20);
    let next = RAM_BASE + (2 << 20);
    const d3d = createDirect3D9({
        backend,
        vertexShaderVersion: { major: 2, minor: 0 },
        pixelShaderVersion: { major: 2, minor: 0 },
        readMemory: (address, length)=>ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        windowMemory: (address, length)=>ram.subarray(address - RAM_BASE,
            address - RAM_BASE + length),
        createSampler: descriptor=>({ kind: 'sampler', id: `sampler-${JSON.stringify(descriptor)}`,
            descriptor }),
        allocate: bytes=>{
            const address = next;
            next += bytes + 0x100;
            return address;
        },
    });
    /** @type {{ device?: any }} */
    const out = {};
    ok(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1, backBufferWidth: 32,
        backBufferHeight: 32, backBufferFormat: D3DFMT.X8R8G8B8, enableAutoDepthStencil: true,
        autoDepthStencilFormat: D3DFMT.D24S8,
    }, out));
    const device = out.device;
    const stride = 32;
    /** @type {{ buffer?: any }} */
    const vertices = {};
    /** @type {{ buffer?: any }} */
    const indices = {};
    const fvf = FVF.XYZ | FVF.NORMAL | (1 << FVF.TEXCOUNT_SHIFT);
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
        ok(texture.texture.LockRect(0, rect));
        const at = /** @type {number} */ (rect.pBits) - RAM_BASE;
        ram.fill(0x30 + made * 0x50, at, at + 64);
        ok(texture.texture.UnlockRect(0));
        textures.push(texture.texture);
    }
    ok(device.SetStreamSource(0, vertices.buffer, 0, stride));
    ok(device.SetIndices(indices.buffer));
    return { gpu, device, fvf, textures };
}

test('recorded: Direct3D 9 frames of lit and shader draws ask the same of the GPU as they did',
    async()=>{
        const { gpu, device, fvf, textures } = scene();
        ok(device.SetRenderState(D3DRS.LIGHTING, 1));
        ok(device.SetRenderState(D3DRS.AMBIENT, 0xff203040));
        ok(device.SetMaterial({
            Diffuse: { r: 1, g: 1, b: 1, a: 1 }, Ambient: { r: 1, g: 0.5, b: 1, a: 1 },
            Specular: { r: 0.5, g: 0.5, b: 0.5, a: 0 }, Emissive: { r: 0, g: 0, b: 0, a: 0 },
            Power: 8,
        }));
        ok(device.SetLight(0, light()));
        ok(device.SetLight(1, light({ Type: D3DLIGHTTYPE.POINT, Position: { x: 2, y: 1, z: 8 } })));
        ok(device.LightEnable(0, true));
        ok(device.LightEnable(1, true));
        ok(device.SetTransform(D3DTS.VIEW,
            new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1])));
        ok(device.SetTransform(D3DTS.PROJECTION, new Float32Array([1.5, 0, 0, 0, 0, 2, 0, 0,
            0, 0, 1.001, 1, 0, 0, -0.1, 0])));
        /** @type {{ shader?: any, declaration?: any }} */
        const made = {};
        ok(device.CreateVertexDeclaration(ELEMENTS, made));
        const declaration = made.declaration;
        ok(device.CreateVertexShader(VERTEX_SHADER, made));
        const vertexShader = made.shader;
        ok(device.CreatePixelShader(PIXEL_SHADER, made));
        const pixelShader = made.shader;
        const worlds = Array.from({ length: 24 }, (_, index)=>worldOf(index));
        /** @type {string[]} */
        const frames = [];
        for (let frame = 0; frame < 3; frame++)
        {
            ok(device.BeginScene());
            ok(device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER, 0xff000000, 1, 0));
            // Fixed-function and lit: the world moved, the same light set
            // again and enabled again, and a light moved part of the way.
            ok(device.SetVertexShader(null));
            ok(device.SetPixelShader(null));
            ok(device.SetFVF(fvf));
            for (let index = 0; index < 12; index++)
            {
                const model = index % 4 === 1 ? index - 1 : index;
                ok(device.SetTransform(D3DTS.WORLD, worlds[(model * 5 + frame) % 24]));
                ok(device.SetLight(0, light()));
                ok(device.LightEnable(0, true));
                if (index === 6)
                {
                    ok(device.SetLight(1, light({ Type: D3DLIGHTTYPE.POINT,
                        Position: { x: -2, y: 3, z: 9 + frame } })));
                }
                ok(device.SetTexture(0, textures[(index >> 1) & 1]));
                ok(device.SetRenderState(D3DRS.CULLMODE, index & 2 ? D3DCULL.CW : D3DCULL.CCW));
                ok(device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 0, 4, 0, 2));
            }
            // Through the shader pair: the matrix constants before every draw,
            // with the texture and two render states flipped among them.
            ok(device.SetVertexDeclaration(declaration));
            ok(device.SetVertexShader(vertexShader));
            ok(device.SetPixelShader(pixelShader));
            ok(device.SetPixelShaderConstantF(2, [0.1, 0.2, 0.3 + frame / 8, 0.4], 1));
            for (let index = 0; index < 12; index++)
            {
                ok(device.SetVertexShaderConstantF(0, worlds[(index * 7 + frame) % 24], 4));
                ok(device.SetTexture(0, textures[index & 1]));
                ok(device.SetRenderState(D3DRS.CULLMODE, index & 2 ? D3DCULL.CW : D3DCULL.CCW));
                ok(device.SetRenderState(D3DRS.ALPHABLENDENABLE, index % 3 === 0 ? 1 : 0));
                ok(device.SetRenderState(D3DRS.SRCBLEND,
                    index % 5 === 0 ? D3DBLEND.SRCALPHA : D3DBLEND.ONE));
                ok(device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 0, 4, 0, 2));
            }
            ok(device.EndScene());
            ok(device.Present());
            await device.idle();
            const { lighting, failures, programmable } = device.diagnostics();
            assert.deepEqual(failures, []);
            assert.equal(programmable, 12 * (frame + 1));
            frames.push(digest(JSON.stringify(plain({ calls: gpu.calls, lighting }))));
            gpu.reset();
        }
        assert.deepEqual(frames, EXPECTED);
    });

const EXPECTED = ['d1e63bc3', 'fc294022', '1710935d'];
