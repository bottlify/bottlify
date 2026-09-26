/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * ProcessVertices through Direct3D 8 and 9 devices, against Wine's d3d8 and
 * d3d9 visual.c test_sysmem_draw: the bound stream transformed through the
 * device's matrices and viewport into a buffer the program reads back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3DFMT, D3DLIGHTTYPE, D3DPOOL, D3DRS, D3DSWAPEFFECT, D3D_OK,
} from './constants.js';
import { createDirect3D8 } from './device.js';
import { createDirect3D9 } from '../d3d9/device.js';
import { D3DDECLTYPE, D3DDECLUSAGE } from '../d3d9/declaration.js';
import { FVF } from '../webgpu/internal/vertexformat.js';
import { fvfNaming, processStreams } from './process.js';

const D3DERR_INVALIDCALL = 0x8876086c;
const RAM_BASE = 0x40000000;

/** @param {8 | 9} version */
function harness(version){
    const ram = new Uint8Array(4 << 20);
    let next = RAM_BASE;
    const services = {
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>ram.set(bytes, address - RAM_BASE),
        /** @param {number} bytes */
        allocate: bytes=>{
            const address = next;
            next += bytes + 0xff & ~0xff;
            return address;
        },
    };
    const parameters = {
        swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1, backBufferWidth: 640,
        backBufferHeight: 480, backBufferFormat: D3DFMT.X8R8G8B8, windowed: true,
    };
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal((version === 9 ? createDirect3D9(services) : createDirect3D8(services))
        .CreateDevice(parameters, out), D3D_OK);
    const device = out.device;
    /** @param {number} length @param {number} fvf */
    const vertexBuffer = (length, fvf)=>{
        /** @type {{ buffer?: any }} */
        const made = {};
        assert.equal(device.CreateVertexBuffer(length, 0, fvf, D3DPOOL.SYSTEMMEM, made), D3D_OK);
        return made.buffer;
    };
    /** @param {any} buffer @param {number[]} words  floats, or dwords where an integer */
    const fill = (buffer, words)=>{
        const bytes = new DataView(new ArrayBuffer(words.length * 4));
        words.forEach((word, index)=>(Number.isInteger(word) && word > 0xffff
            ? bytes.setUint32(index * 4, word, true)
            : bytes.setFloat32(index * 4, word, true)));
        services.writeMemory(buffer.base, new Uint8Array(bytes.buffer));
    };
    /** @param {any} buffer @param {number} vertex @param {number} stride @param {number} words */
    const read = (buffer, vertex, stride, words)=>{
        const bytes = services.readMemory(buffer.base + vertex * stride, words * 4);
        return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
    /** @param {number} fvf */
    const setFvf = fvf=>(version === 9 ? device.SetFVF(fvf) : device.SetVertexShader(fvf));
    /** @param {any} buffer @param {number} stride */
    const setStream = (buffer, stride)=>(version === 9
        ? device.SetStreamSource(0, buffer, 0, stride)
        : device.SetStreamSource(0, buffer, stride));
    /** @param {number} start @param {number} index @param {number} count @param {any} into */
    const process = (start, index, count, into)=>(version === 9
        ? device.ProcessVertices(start, index, count, into, null, 0)
        : device.ProcessVertices(start, index, count, into, 0));
    return { device, vertexBuffer, fill, read, setFvf, setStream, process };
}

const QUAD = [[-0.5, -0.5], [-0.5, 0.5], [0.5, -0.5], [0.5, 0.5]];
const COLOURS = [0xffff0000, 0xff00ff00, 0xff0000ff, 0xffffffff];

for (const version of /** @type {const} */ ([8, 9]))
{
    test(`Direct3D ${version}: ProcessVertices writes the bound stream in screen space`, ()=>{
        const h = harness(version);
        const source = h.vertexBuffer(16 * 4, 0);
        h.fill(source, QUAD.flatMap(([x, y], index)=>[x, y, 0, COLOURS[index]]));
        assert.equal(h.device.SetRenderState(D3DRS.LIGHTING, 0), D3D_OK);
        assert.equal(h.setFvf(FVF.XYZ | FVF.DIFFUSE), D3D_OK);
        assert.equal(h.setStream(source, 16), D3D_OK);
        const into = h.vertexBuffer(16 * 4, FVF.XYZRHW);
        assert.equal(h.process(0, 0, 4, into), D3D_OK);
        QUAD.forEach(([x, y], index)=>{
            const vertex = h.read(into, index, 16, 4);
            assert.deepEqual([0, 1, 2, 3].map(k=>vertex.getFloat32(k * 4, true)),
                [x * 320 + 320, -y * 240 + 240, 0, 1], `vertex ${index}`);
        });

        // Out of range, either side, and a destination that is not a vertex
        // buffer, are refused.
        assert.equal(h.process(1, 0, 4, into), D3DERR_INVALIDCALL, 'past the source');
        assert.equal(h.process(0, 1, 4, into), D3DERR_INVALIDCALL, 'past the destination');
        assert.equal(h.process(0, 0, 4, null), D3DERR_INVALIDCALL);
        assert.equal(h.process(2, 3, 1, into), D3D_OK, 'one vertex, from and to the middle');
    });

    test(`Direct3D ${version}: ProcessVertices lights into the destination's colour`, ()=>{
        const h = harness(version);
        const source = h.vertexBuffer(24, 0);
        h.fill(source, [0, 0, 0, 0, 0, -1]);
        assert.equal(h.setFvf(FVF.XYZ | FVF.NORMAL), D3D_OK);
        assert.equal(h.setStream(source, 24), D3D_OK);
        assert.equal(h.device.SetRenderState(D3DRS.LIGHTING, 1), D3D_OK);
        assert.equal(h.device.SetLight(0, {
            Type: D3DLIGHTTYPE.DIRECTIONAL,
            Diffuse: { r: 1, g: 0.5, b: 0, a: 1 },
            Specular: { r: 0, g: 0, b: 0, a: 0 },
            Ambient: { r: 0, g: 0, b: 0, a: 0 },
            Position: { x: 0, y: 0, z: 0 },
            Direction: { x: 0, y: 0, z: 1 },
            Range: 0, Falloff: 0, Attenuation0: 0, Attenuation1: 0, Attenuation2: 0,
            Theta: 0, Phi: 0,
        }), D3D_OK);
        assert.equal(h.device.LightEnable(0, true), D3D_OK);
        const into = h.vertexBuffer(20, FVF.XYZRHW | FVF.DIFFUSE);
        assert.equal(h.process(0, 0, 1, into), D3D_OK);
        assert.equal(h.read(into, 0, 20, 5).getUint32(16, true), 0xffff8000,
            'the default white material under a light facing the normal');
    });
}

test('Direct3D 9: ProcessVertices reads a declaration\'s streams, and refuses a shader', ()=>{
    const h = harness(9);
    const positions = h.vertexBuffer(12 * 4, 0);
    h.fill(positions, QUAD.flatMap(([x, y])=>[x, y, 0]));
    const colours = h.vertexBuffer(4 * 4, 0);
    h.fill(colours, COLOURS);
    /** @type {{ declaration?: any }} */
    const made = {};
    assert.equal(h.device.CreateVertexDeclaration([
        { Stream: 0, Offset: 0, Type: D3DDECLTYPE.FLOAT3, Method: 0,
            Usage: D3DDECLUSAGE.POSITION, UsageIndex: 0 },
        { Stream: 1, Offset: 0, Type: D3DDECLTYPE.D3DCOLOR, Method: 0,
            Usage: D3DDECLUSAGE.COLOR, UsageIndex: 0 },
    ], made), D3D_OK);
    assert.equal(h.device.SetVertexDeclaration(made.declaration), D3D_OK);
    assert.equal(h.device.SetStreamSource(0, positions, 0, 12), D3D_OK);
    assert.equal(h.device.SetStreamSource(1, colours, 0, 4), D3D_OK);
    assert.equal(h.device.SetRenderState(D3DRS.LIGHTING, 0), D3D_OK);
    const into = h.vertexBuffer(20 * 4, FVF.XYZRHW | FVF.DIFFUSE);
    assert.equal(h.device.ProcessVertices(0, 0, 4, into, null, 0), D3D_OK);
    COLOURS.forEach((colour, index)=>{
        assert.equal(h.read(into, index, 20, 5).getUint32(16, true), colour,
            `vertex ${index} took its colour from stream one`);
    });
    // A declaration names the destination's layout over the buffer's own.
    assert.equal(h.device.CreateVertexDeclaration([
        { Stream: 0, Offset: 0, Type: D3DDECLTYPE.FLOAT4, Method: 0,
            Usage: D3DDECLUSAGE.POSITIONT, UsageIndex: 0 },
    ], made), D3D_OK);
    const bare = h.vertexBuffer(16 * 4, 0);
    assert.equal(h.device.ProcessVertices(0, 0, 4, bare, null, 0), D3DERR_INVALIDCALL,
        'a buffer made without a format names no destination');
    assert.equal(h.device.ProcessVertices(0, 0, 4, bare, made.declaration, 0), D3D_OK);
    assert.equal(h.read(bare, 3, 16, 4).getFloat32(0, true), 480);

    /** @type {{ shader?: any }} */
    const shader = {};
    assert.equal(h.device.CreateVertexShader(Uint32Array.from([0xfffe0101, 0x0000ffff]),
        shader), D3D_OK);
    assert.equal(h.device.SetVertexShader(shader.shader), D3D_OK);
    assert.equal(h.device.ProcessVertices(0, 0, 4, into, null, 0), D3DERR_INVALIDCALL,
        'no shader runs on the processor');
});

test('Direct3D 8: ProcessVertices reads a declaration\'s streams, and refuses a shader', ()=>{
    const h = harness(8);
    const positions = h.vertexBuffer(12 * 4, 0);
    h.fill(positions, QUAD.flatMap(([x, y])=>[x, y, 0]));
    const colours = h.vertexBuffer(4 * 4, 0);
    h.fill(colours, COLOURS);
    // D3DVSD_STREAM(0), D3DVSD_REG(D3DVSDE_POSITION, D3DVSDT_FLOAT3),
    // D3DVSD_STREAM(1), D3DVSD_REG(D3DVSDE_DIFFUSE, D3DVSDT_D3DCOLOR).
    const declaration = [0x20000000, 0x40020000, 0x20000001, 0x40040005, 0xffffffff];
    /** @type {{ handle?: number }} */
    const alone = {};
    assert.equal(h.device.CreateVertexShader(declaration, null, alone), D3D_OK);
    assert.equal(h.device.SetVertexShader(alone.handle), D3D_OK);
    assert.equal(h.device.SetStreamSource(0, positions, 12), D3D_OK);
    assert.equal(h.device.SetStreamSource(1, colours, 4), D3D_OK);
    assert.equal(h.device.SetRenderState(D3DRS.LIGHTING, 0), D3D_OK);
    const into = h.vertexBuffer(20 * 4, FVF.XYZRHW | FVF.DIFFUSE);
    assert.equal(h.process(0, 0, 4, into), D3D_OK);
    COLOURS.forEach((colour, index)=>{
        assert.equal(h.read(into, index, 20, 5).getUint32(16, true), colour,
            `vertex ${index} took its colour from stream one`);
    });
    assert.equal(h.read(into, 3, 20, 5).getFloat32(0, true), 480);

    /** @type {{ handle?: number }} */
    const shader = {};
    assert.equal(h.device.CreateVertexShader(declaration,
        [0xfffe0101, 0x00000001, 0xc00f0000, 0x90e40000, 0x0000ffff], shader), D3D_OK);
    assert.equal(h.device.SetVertexShader(shader.handle), D3D_OK);
    assert.equal(h.process(0, 0, 4, into), D3DERR_INVALIDCALL, 'no shader runs on the processor');
});

test('the source is named by a format, and the destination\'s written range is uploaded', ()=>{
    assert.equal(fvfNaming([
        { name: 'position', stream: 0, offset: 0, format: 'float32x3' },
        { name: 'diffuse', stream: 1, offset: 0, format: 'unorm8x4' },
        { name: 'texCoord0', stream: 0, offset: 12, format: 'float32x2' },
        { name: 'texCoord1', stream: 0, offset: 20, format: 'float32' },
    ]), FVF.XYZ | FVF.DIFFUSE | (2 << FVF.TEXCOUNT_SHIFT) | (3 << 18));
    assert.equal(fvfNaming([{ name: 'normal', stream: 0, offset: 0, format: 'float32x3' }]), 0,
        'no position, no format');

    const ram = new Uint8Array(4096);
    /** @type {any[]} */
    const calls = [];
    const destination = { base: 1024, length: 64 };
    assert.equal(processStreams({
        memory: {
            readMemory: (at, length)=>ram.slice(at, at + length),
            writeMemory: (at, bytes)=>ram.set(bytes, at),
        },
        model: /** @type {any} */ ({
            renderStates: new Map(), transforms: new Map(), lights: new Map(),
            material: {}, viewport: { rect: { x: 0, y: 0, width: 2, height: 2,
                minDepth: 0, maxDepth: 1 } },
        }),
        attributes: [{ name: 'position', stream: 0, offset: 0, format: 'float32x3' }],
        streamAt: ()=>({ base: 0, stride: 12, vertices: 8 }),
        start: 0, count: 2, destinationIndex: 1, flags: 0,
        destination, destinationFvf: FVF.XYZ,
        renderer: {
            lockBuffer: (/** @type {any[]} */ ...args)=>calls.push(['lock', ...args]),
            unlockBuffer: (/** @type {any} */ buffer)=>calls.push(['unlock', buffer]),
        },
    }), D3D_OK);
    assert.deepEqual(calls, [['lock', destination, 12, 28, 0], ['unlock', destination]],
        'two vertices and the reciprocal w after them');
});
