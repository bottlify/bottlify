/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Kept constant blocks, as a gate: a shader draw's integer and boolean
 * blocks are the last draw's while the registers hold the values they were
 * made of, and the uniform ring lays a block handed twice in a frame once.
 * Whatever a program sets, the GPU must read at every draw the bytes it reads
 * with every draw taking blocks of its own (`keepConstantBlocks: false`).
 *
 * Programs are drawn from a seed: integer, boolean and float constants of
 * both stages set over any registers, with values whose bits are no number
 * as a float (-1, a NaN with a payload) among them; two vertex and two pixel
 * shaders switched between; a state block of everything captured and applied,
 * which writes the files without the setters; draws, and frames presented
 * between them. What is compared is every draw's bound uniform bytes, read at
 * the submit that carries the draw, before any later frame writes the ring.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { D3DFMT, D3DPOOL, D3DSWAPEFFECT, D3D_OK } from './constants.js';
import { D3DPT, D3DSBT } from '../d3d8/constants.js';
import { createDirect3D9 } from './device.js';
import { D3DDECLTYPE, D3DDECLUSAGE } from './declaration.js';
import { END_TOKEN, OPCODE, REGISTER, SHADER_KIND, versionToken } from './shader.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

const RAM_BASE = 0x40000000;
const SEEDS = 24;

/** @param {number} type @param {number} index */
const dst = (type, index)=>(0x80000000 | ((type & 7) << 28) | ((type & 0x18) << 8)
    | (0xf << 16) | index) >>> 0;
/** @param {number} type @param {number} index */
const src = (type, index)=>(0x80000000 | ((type & 7) << 28) | ((type & 0x18) << 8)
    | (0xe4 << 16) | index) >>> 0;
/** @param {number} opcode @param {number} length */
const op = (opcode, length)=>((length << 24) | opcode) >>> 0;
/** @param {number} usage @param {number} register */
const dclInput = (usage, register)=>[op(OPCODE.DCL, 2), (0x80000000 | usage) >>> 0,
    dst(REGISTER.INPUT, register)];

/** Two vertex shaders reaching four and nine float registers. */
const VERTEX_SHADERS = [
    [versionToken(SHADER_KIND.VERTEX, 2, 0), ...dclInput(D3DDECLUSAGE.POSITION, 0),
        op(OPCODE.M4x4, 3), dst(REGISTER.RASTOUT, 0), src(REGISTER.INPUT, 0),
        src(REGISTER.CONST, 0), END_TOKEN],
    [versionToken(SHADER_KIND.VERTEX, 2, 0), ...dclInput(D3DDECLUSAGE.POSITION, 0),
        ...dclInput(D3DDECLUSAGE.COLOR, 1),
        op(OPCODE.M4x4, 3), dst(REGISTER.RASTOUT, 0), src(REGISTER.INPUT, 0),
        src(REGISTER.CONST, 4),
        op(OPCODE.MUL, 3), dst(REGISTER.ATTROUT, 0), src(REGISTER.INPUT, 1),
        src(REGISTER.CONST, 8), END_TOKEN],
];
/** Two pixel shaders reading c2 and c5. */
const PIXEL_SHADERS = [2, 5].map(register=>[
    versionToken(SHADER_KIND.PIXEL, 2, 0),
    op(OPCODE.DCL, 2), 0x80000000, dst(REGISTER.INPUT, 0),
    op(OPCODE.ADD, 3), dst(REGISTER.COLOROUT, 0), src(REGISTER.INPUT, 0),
    src(REGISTER.CONST, register),
    END_TOKEN,
]);

const ELEMENTS = [
    { Stream: 0, Offset: 0, Type: D3DDECLTYPE.FLOAT3, Method: 0, Usage: D3DDECLUSAGE.POSITION,
        UsageIndex: 0 },
    { Stream: 0, Offset: 12, Type: D3DDECLTYPE.D3DCOLOR, Method: 0, Usage: D3DDECLUSAGE.COLOR,
        UsageIndex: 0 },
];

/** @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * The program a seed draws, as calls on a device: the same list for both
 * paths.
 *
 * @param {number} seed
 * @returns {{ name: string, args: any[] }[]}
 */
function programOf(seed){
    const next = random(seed);
    /** @param {number} n */
    const below = n=>Math.floor(next() * n);
    /** Bits that are no number as a float among them: -1 and a NaN with a payload. */
    const word = ()=>[0, 1, -1, 7, 0x7fc00001, -0x10000][below(6)]
        + (below(4) === 0 ? below(9) : 0);
    /** @type {{ name: string, args: any[] }[]} */
    const calls = [];
    const frames = 2 + below(3);
    for (let frame = 0; frame < frames; frame++)
    {
        calls.push({ name: 'BeginScene', args: [] });
        const steps = 20 + below(40);
        for (let step = 0; step < steps; step++)
        {
            const roll = below(100);
            const stage = below(2) === 0 ? 'Vertex' : 'Pixel';
            if (roll < 30)
            {
                calls.push({ name: 'Draw', args: [] });
            }
            else if (roll < 45)
            {
                const count = 1 + below(3);
                calls.push({ name: `Set${stage}ShaderConstantF`, args: [below(12),
                    Array.from({ length: count * 4 }, ()=>next() * 4 - 2), count] });
            }
            else if (roll < 60)
            {
                const count = 1 + below(2);
                const start = below(17 - count);
                calls.push({ name: `Set${stage}ShaderConstantI`, args: [start,
                    Array.from({ length: count * 4 }, word), count] });
            }
            else if (roll < 75)
            {
                const count = 1 + below(3);
                const start = below(17 - count);
                calls.push({ name: `Set${stage}ShaderConstantB`, args: [start,
                    Array.from({ length: count }, ()=>(below(3) === 0 ? word() : below(2))),
                    count] });
            }
            else if (roll < 83)
            {
                calls.push({ name: 'Shader', args: [stage, below(2)] });
            }
            else if (roll < 88)
            {
                calls.push({ name: 'Capture', args: [] });
            }
            else if (roll < 94)
            {
                calls.push({ name: 'Apply', args: [] });
            }
            else
            {
                // The same values again: a set that changes nothing.
                calls.push({ name: `Set${stage}ShaderConstantI`, args: [0, [0, 0, 0, 0], 1] });
            }
        }
        calls.push({ name: 'Draw', args: [] });
        calls.push({ name: 'EndScene', args: [] });
        calls.push({ name: 'Present', args: [] });
    }
    return calls;
}

/**
 * Plays a program on a device drawing over the fake GPU, and answers each
 * draw's bound uniform bytes in the order the GPU was given them.
 *
 * @param {{ name: string, args: any[] }[]} calls @param {boolean} keep
 */
async function play(calls, keep){
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{},
        now: ()=>0 });
    /** @type {string[]} */
    const drawn = [];
    // Read at each submit: the frame's writes have all landed, and no later
    // frame's has.
    let seen = 0;
    /** @type {Map<number, string>} */
    const groups = new Map();
    const submit = gpu.queue.submit.bind(gpu.queue);
    gpu.queue.submit = (/** @type {any[]} */ buffers)=>{
        submit(buffers);
        for (; seen < gpu.calls.length; seen++)
        {
            const call = gpu.calls[seen];
            if (call.op === 'setBindGroup' && call.index < 2)
            {
                groups.set(call.index, call.resolved.map((/** @type {any} */ range)=>
                    createHash('sha1').update(range.buffer.bytes.subarray(range.offset,
                        range.offset + range.size)).digest('hex').slice(0, 16)).join(','));
            }
            else if (call.op === 'draw' || call.op === 'drawIndexed')
            {
                drawn.push(`${groups.get(0)}/${groups.get(1)}`);
            }
        }
    };
    const ram = new Uint8Array(1 << 20);
    let next = RAM_BASE;
    const d3d = createDirect3D9({
        backend,
        vertexShaderVersion: { major: 2, minor: 0 },
        pixelShaderVersion: { major: 2, minor: 0 },
        readMemory: (address, length)=>ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
        allocate: bytes=>{
            const address = next;
            next += bytes + 0x100;
            return address;
        },
        keepConstantBlocks: keep,
    });
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1,
        backBufferWidth: 8, backBufferHeight: 8, backBufferFormat: D3DFMT.X8R8G8B8,
        enableAutoDepthStencil: false }, out), D3D_OK);
    const device = out.device;
    /** @type {{ buffer?: any }} */
    const vb = {};
    assert.equal(device.CreateVertexBuffer(16 * 3, 0, 0, D3DPOOL.MANAGED, vb), D3D_OK);
    assert.equal(device.SetStreamSource(0, vb.buffer, 0, 16), D3D_OK);
    /** @type {{ declaration?: any }} */
    const declaration = {};
    assert.equal(device.CreateVertexDeclaration(ELEMENTS, declaration), D3D_OK);
    assert.equal(device.SetVertexDeclaration(declaration.declaration), D3D_OK);
    const shaders = {
        Vertex: VERTEX_SHADERS.map(tokens=>{
            /** @type {{ shader?: any }} */
            const made = {};
            assert.equal(device.CreateVertexShader(tokens, made), D3D_OK);
            return made.shader;
        }),
        Pixel: PIXEL_SHADERS.map(tokens=>{
            /** @type {{ shader?: any }} */
            const made = {};
            assert.equal(device.CreatePixelShader(tokens, made), D3D_OK);
            return made.shader;
        }),
    };
    assert.equal(device.SetVertexShader(shaders.Vertex[0]), D3D_OK);
    assert.equal(device.SetPixelShader(shaders.Pixel[0]), D3D_OK);
    /** @type {{ block?: any }} */
    const block = {};
    assert.equal(device.CreateStateBlock(D3DSBT.ALL, block), D3D_OK);
    for (const { name, args } of calls)
    {
        if (name === 'Draw')
        {
            assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        }
        else if (name === 'Shader')
        {
            const [stage, index] = /** @type {['Vertex' | 'Pixel', number]} */ (args);
            assert.equal(device[`Set${stage}Shader`](shaders[stage][index]), D3D_OK);
        }
        else if (name === 'Capture' || name === 'Apply')
        {
            assert.equal(block.block[name](), D3D_OK);
        }
        else if (name === 'Present')
        {
            assert.equal(device.Present(), D3D_OK);
            await device.idle();
        }
        else
        {
            assert.equal(device[name](...args), D3D_OK, name);
        }
    }
    await device.idle();
    return { drawn, shared: backend.diagnostics().uniforms.shared };
}

test('every draw is bound the uniform bytes it is bound with blocks of its own', async()=>{
    let shared = 0;
    let draws = 0;
    for (let seed = 1; seed <= SEEDS; seed++)
    {
        const calls = programOf(seed);
        const kept = await play(calls, true);
        const own = await play(calls, false);
        assert.equal(kept.drawn.length, own.drawn.length, `seed ${seed}: the same draws`);
        for (let draw = 0; draw < kept.drawn.length; draw++)
        {
            assert.equal(kept.drawn[draw], own.drawn[draw], `seed ${seed}, draw ${draw}`);
        }
        assert.equal(own.shared, 0, 'blocks of their own are never laid twice');
        shared += kept.shared;
        draws += kept.drawn.length;
    }
    // Or the gate compared nothing it was written for.
    assert.ok(draws > SEEDS * 20, `${draws} draws`);
    assert.ok(shared > draws / 2, `${shared} blocks laid once for ${draws} draws`);
});
