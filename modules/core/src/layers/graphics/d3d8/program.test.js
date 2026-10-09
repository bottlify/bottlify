/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A Direct3D 8 draw through a vertex shader handle, followed to the GPU.
 *
 * The recording device runs no WGSL, so what is proved is everything up to
 * the queue: the vertex layout the declaration's registers became, the module
 * the function became, the constants the vertex stage was bound to, and the
 * streams the declaration reads.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3DFMT, D3DPOOL, D3DPT, D3DSWAPEFFECT, D3DTOP, D3DTSS, D3D_OK } from './constants.js';
import { createDirect3D8 } from './device.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

const RAM_BASE = 0x40000000;
const RAM_SIZE = 4 << 20;

/** D3DVSD_STREAM(index). */
const stream = (/** @type {number} */ index)=>(0x20000000 | index) >>> 0;
/** D3DVSD_REG(register, type). */
const reg = (/** @type {number} */ register, /** @type {number} */ type)=>
    (0x40000000 | (type << 16) | register) >>> 0;
const D3DVSDT_FLOAT3 = 2;
const D3DVSDT_D3DCOLOR = 4;
const D3DVSDE_POSITION = 0;
const D3DVSDE_DIFFUSE = 5;
const D3DVSDE_TEXCOORD0 = 7;

/**
 * Position from stream zero, the colour from stream one, and c4 loaded by the
 * declaration: D3DVSD_CONST(4, 1).
 */
const DECLARATION = [
    stream(0), reg(D3DVSDE_POSITION, D3DVSDT_FLOAT3),
    stream(1), reg(D3DVSDE_DIFFUSE, D3DVSDT_D3DCOLOR),
    0x82000004, 0x3f000000, 0x3f000000, 0x3f000000, 0x3f800000,
    0xffffffff,
];

/**
 * vs_1_1, which declares nothing of its own:
 *
 *     m4x4 oPos, v0, c0
 *     mul oD0, v5, c4
 *     mov oT0, v7        ; a register the declaration does not load
 */
const SHADER = [
    0xfffe0101,
    0x00000014, 0xc00f0000, 0x90e40000, 0xa0e40000,
    0x00000005, 0xd00f0000, 0x90e40005, 0xa0e40004,
    0x00000001, 0xe00f0000, 0x90e40000 | D3DVSDE_TEXCOORD0,
    0x0000ffff,
];

function harness(){
    const gpu = createFakeDevice();
    /** @type {string[]} */
    const reports = [];
    const backend = createBackend({
        device: gpu.device,
        queue: gpu.queue,
        presentTo: ()=>{},
        now: ()=>0,
    });
    const ram = new Uint8Array(RAM_SIZE);
    let next = RAM_BASE;
    const d3d = createDirect3D8({
        backend,
        readMemory: (address, length)=>ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
        allocate: bytes=>{
            const address = next;
            next += bytes + 0x100;
            return address;
        },
        divergence: (_api, detail)=>reports.push(detail),
    });
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT.DISCARD,
        backBufferCount: 1,
        backBufferWidth: 8,
        backBufferHeight: 8,
        backBufferFormat: D3DFMT.X8R8G8B8,
        enableAutoDepthStencil: false,
    }, out), D3D_OK);
    const device = out.device;

    /**
     * A vertex buffer holding these bytes.
     *
     * @param {Uint8Array} bytes
     */
    const buffer = bytes=>{
        /** @type {{ buffer?: any }} */
        const made = {};
        assert.equal(device.CreateVertexBuffer(bytes.length, 0, 0, D3DPOOL.MANAGED, made),
            D3D_OK);
        /** @type {{ pBits?: number }} */
        const lock = {};
        assert.equal(made.buffer.Lock(0, 0, lock), D3D_OK);
        ram.set(bytes, (lock.pBits ?? 0) - RAM_BASE);
        assert.equal(made.buffer.Unlock(), D3D_OK);
        return made.buffer;
    };
    const positions = new Float32Array([0, 0, 0.5, 1, 0, 0.5, 0, 1, 0.5]);
    const colours = new Uint32Array([0xff203040, 0xff203041, 0xff203042]);
    const first = buffer(new Uint8Array(positions.buffer));
    const second = buffer(new Uint8Array(colours.buffer));
    assert.equal(device.SetStreamSource(0, first, 12), D3D_OK);
    assert.equal(device.SetStreamSource(1, second, 4), D3D_OK);
    // The diffuse colour alone, so no stage asks for a texture nothing binds.
    assert.equal(device.SetTextureStageState(0, D3DTSS.COLOROP, D3DTOP.SELECTARG2), D3D_OK);
    assert.equal(device.SetTextureStageState(0, D3DTSS.ALPHAOP, D3DTOP.SELECTARG2), D3D_OK);

    return {
        gpu, device, reports, first, second,
        async draw(){
            assert.equal(device.BeginScene(), D3D_OK);
            assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
            assert.equal(device.EndScene(), D3D_OK);
            assert.equal(device.Present(), D3D_OK);
            await device.idle();
        },
        /**
         * The floats a stage's first constant buffer was bound to at the
         * draw: group 0 for the vertex stage, 1 for the pixel stage.
         */
        vertexConstants(group = 0){
            const bound = gpu.of('setBindGroup').find(call=>call.index === group);
            const entry = bound.group.descriptor.entries.find(
                (/** @type {any} */ one)=>one.binding === 0);
            const at = entry.resource.dynamicOffset ?? entry.resource.offset ?? 0;
            return new Float32Array(entry.resource.buffer.bytes.slice(at, at + entry.resource.size)
                .buffer);
        },
        release(){
            assert.equal(device.SetStreamSource(0, null, 0), D3D_OK);
            assert.equal(device.SetStreamSource(1, null, 0), D3D_OK);
            first.release();
            second.release();
            assert.equal(device.release(), 0);
        },
    };
}

test('a vs_1_1 draws through its translation, reading the registers its declaration loads',
    async()=>{
        const h = harness();
        /** @type {{ handle?: number }} */
        const made = {};
        assert.equal(h.device.CreateVertexShader(DECLARATION, SHADER, made), D3D_OK);
        assert.equal(h.device.SetVertexShader(made.handle), D3D_OK);
        const matrix = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0.5, 0.25, 0, 1];
        assert.equal(h.device.SetVertexShaderConstant(0, matrix, 4), D3D_OK);

        await h.draw();
        assert.deepEqual(h.reports, []);
        const diagnostics = h.device.diagnostics();
        assert.equal(diagnostics.programmable, 1, 'drawn through a shader');
        assert.equal(diagnostics.skipped.vertexShader, 0);
        assert.equal(diagnostics.skipped.program, 0);

        // The module: v0 and v5 from the vertex buffers, as the declaration
        // types them, and v7 -- loaded by nothing -- as the default vertex.
        const vertexModule = h.gpu.of('createShaderModule').map(call=>call.descriptor)
            .find(module=>module.label.startsWith('vs:'));
        assert.ok(vertexModule);
        assert.match(vertexModule.code, /@location\(0\) v0: vec3<f32>,/);
        assert.match(vertexModule.code, /@location\(5\) v5: vec4<f32>,/);
        assert.match(vertexModule.code, /let v5 = in\.v5\.zyxw;/, 'a D3DCOLOR is B, G, R, A');
        assert.match(vertexModule.code, /let v7 = vec4f\(0\.0, 0\.0, 0\.0, 1\.0\);/);

        // Two vertex buffers, one a stream, each at its own stride.
        const [pipeline] = h.gpu.of('createRenderPipeline').map(call=>call.descriptor);
        assert.deepEqual(pipeline.vertex.buffers, [
            { arrayStride: 12, stepMode: 'vertex',
                attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
            { arrayStride: 4, stepMode: 'vertex',
                attributes: [{ shaderLocation: 5, offset: 0, format: 'unorm8x4' }] },
        ]);
        assert.equal(h.gpu.of('setVertexBuffer').length, 2);

        // The constants: the matrix the program set, and c4 as the
        // declaration loaded it when the shader was set.
        const floats = h.vertexConstants();
        assert.deepEqual([...floats.subarray(0, 16)], matrix.map(Math.fround));
        assert.deepEqual([...floats.subarray(16, 20)], [0.5, 0.5, 0.5, 1]);
        assert.deepEqual(h.gpu.of('draw').map(call=>call.args), [[3, 1, 0]]);

        assert.equal(h.device.SetVertexShader(0), D3D_OK);
        assert.equal(h.device.DeleteVertexShader(made.handle), D3D_OK);
        h.release();
    });

test('a declaration made alone draws through the fixed-function stage, from both streams',
    async()=>{
        const h = harness();
        /** @type {{ handle?: number }} */
        const made = {};
        assert.equal(h.device.CreateVertexShader(DECLARATION, null, made), D3D_OK);
        assert.equal(h.device.SetVertexShader(made.handle), D3D_OK);

        await h.draw();
        assert.deepEqual(h.reports, []);
        const diagnostics = h.device.diagnostics();
        assert.equal(diagnostics.programmable, 0);
        assert.equal(diagnostics.skipped.vertexShader, 0);
        assert.equal(diagnostics.skipped.layout, 0);
        const [pipeline] = h.gpu.of('createRenderPipeline').map(call=>call.descriptor);
        assert.deepEqual(pipeline.vertex.buffers.map(
            (/** @type {any} */ one)=>[one.arrayStride, one.attributes.map(
                (/** @type {any} */ attribute)=>attribute.format)]),
        [[12, ['float32x3']], [4, ['unorm8x4']]]);
        assert.deepEqual(h.gpu.of('draw').map(call=>call.args), [[3, 1, 0]]);

        assert.equal(h.device.SetVertexShader(0), D3D_OK);
        assert.equal(h.device.DeleteVertexShader(made.handle), D3D_OK);
        h.release();
    });

test('a ps_1_4 over a vertex format draws through the fixed vertex stage, with its constants',
    async()=>{
        // Wine's d3d8 visual.c cnd_test, the 1.4 shader: texcrd r0, t0;
        // mov r0.a, c0.a; cnd r0, r0, c1, c2 over D3DFVF_XYZ | D3DFVF_TEX1.
        const h = harness();
        /** @type {{ handle?: number }} */
        const made = {};
        assert.equal(h.device.CreatePixelShader([
            0xffff0104,
            0x00000051, 0xa00f0000, 0x00000000, 0x00000000, 0x00000000, 0x3f800000,
            0x00000040, 0x80070000, 0xb0e40000,
            0x00000001, 0x80080000, 0xa0ff0000,
            0x00000050, 0x800f0000, 0x80e40000, 0xa0e40001, 0xa0e40002,
            0x0000ffff,
        ], made), D3D_OK);
        assert.equal(h.device.SetPixelShaderConstant(1, [0, 0, 0, 0], 1), D3D_OK);
        assert.equal(h.device.SetPixelShaderConstant(2, [1, 1, 1, 1], 1), D3D_OK);
        assert.equal(h.device.SetVertexShader(0x002 | 0x100), D3D_OK, 'XYZ | TEX1');
        assert.equal(h.device.SetPixelShader(made.handle), D3D_OK);
        const quad = new Float32Array([
            -1, -1, 0.1, 0, 1, -1, 0, 0.1, 0, 0, 0, -1, 0.1, 1, 1, 0, 0, 0.1, 1, 0,
        ]);
        assert.equal(h.device.BeginScene(), D3D_OK);
        assert.equal(h.device.DrawPrimitiveUP(D3DPT.TRIANGLESTRIP, 2,
            new Uint8Array(quad.buffer), 20), D3D_OK);
        assert.equal(h.device.EndScene(), D3D_OK);
        assert.equal(h.device.Present(), D3D_OK);
        await h.device.idle();

        assert.deepEqual(h.reports, []);
        const diagnostics = h.device.diagnostics();
        assert.equal(diagnostics.programmable, 1);
        assert.equal(diagnostics.skipped.pixelShader, 0);
        const pixelModule = h.gpu.of('createShaderModule').map(call=>call.descriptor)
            .find(module=>module.label.startsWith('ps:'));
        assert.ok(pixelModule.code.includes('> vec4f(0.5)'), 'cnd compares each component');
        assert.ok(pixelModule.code.includes('in.t0'), 'texcrd reads the coordinate set');
        const floats = h.vertexConstants(1);
        assert.deepEqual([...floats.subarray(4, 12)], [0, 0, 0, 0, 1, 1, 1, 1],
            'c1 and c2 as the program set them');
        assert.deepEqual(h.gpu.of('draw').map(call=>call.args), [[4, 1, 0]]);

        assert.equal(h.device.SetPixelShader(0), D3D_OK);
        assert.equal(h.device.DeletePixelShader(made.handle), D3D_OK);
        h.release();
    });

test('a vs_1_1 and a ps_1_1 draw as a pair, the pixel shader sampling its stage', async()=>{
    const h = harness();
    /** @type {{ handle?: number }} */
    const vs = {};
    /** @type {{ handle?: number }} */
    const ps = {};
    assert.equal(h.device.CreateVertexShader(DECLARATION, SHADER, vs), D3D_OK);
    // ps_1_1: tex t0; mul r0, t0, v0.
    assert.equal(h.device.CreatePixelShader([0xffff0101, 0x00000042, 0xb00f0000,
        0x00000005, 0x800f0000, 0xb0e40000, 0x90e40000, 0x0000ffff], ps), D3D_OK);
    /** @type {{ texture?: any }} */
    const texture = {};
    assert.equal(h.device.CreateTexture(2, 2, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, texture),
        D3D_OK);
    assert.equal(h.device.SetTexture(0, texture.texture), D3D_OK);
    assert.equal(h.device.SetVertexShader(vs.handle), D3D_OK);
    assert.equal(h.device.SetPixelShader(ps.handle), D3D_OK);

    await h.draw();
    assert.deepEqual(h.reports, []);
    assert.equal(h.device.diagnostics().programmable, 1);
    const modules = h.gpu.of('createShaderModule').map(call=>call.descriptor);
    const pixelModule = modules.find(module=>module.label.startsWith('ps:'));
    assert.ok(pixelModule.code.includes('t0 = textureSample(tex0, samp0, in.t0.xy);'));
    assert.ok(modules.some(module=>module.label.startsWith('vs:')
        && module.code.includes('@location(5) v5: vec4<f32>,')));
    const sampled = h.gpu.of('setBindGroup').find(call=>call.index === 2).group.descriptor;
    assert.equal(sampled.entries.length, 2, 'the texture at stage zero and its sampler');

    assert.equal(h.device.SetTexture(0, null), D3D_OK);
    assert.equal(h.device.SetVertexShader(0), D3D_OK);
    assert.equal(h.device.SetPixelShader(0), D3D_OK);
    assert.equal(h.device.DeleteVertexShader(vs.handle), D3D_OK);
    assert.equal(h.device.DeletePixelShader(ps.handle), D3D_OK);
    texture.texture.release();
    h.release();
});

test('under a vertex shader a stage samples the set of its own number, whatever its index says',
    async()=>{
        // A program that leaves D3DTSS_TEXCOORDINDEX at a generation mode and
        // set 0 while its shader writes what the stage needs into oT1: the
        // index is fixed-function vertex processing, which the shader
        // replaces, so stage 1 reads oT1.
        const h = harness();
        /** @type {{ handle?: number }} */
        const made = {};
        const shader = [
            0xfffe0101,
            0x00000014, 0xc00f0000, 0x90e40000, 0xa0e40000,
            0x00000001, 0xd00f0000, 0x90e40005,
            0x00000001, 0xe00f0000, 0x90e40005,
            0x00000001, 0xe00f0001, 0x90e40005,
            0x0000ffff,
        ];
        assert.equal(h.device.CreateVertexShader(DECLARATION, shader, made), D3D_OK);
        assert.equal(h.device.SetVertexShader(made.handle), D3D_OK);
        /** @type {{ texture?: any }} */
        const texture = {};
        assert.equal(h.device.CreateTexture(4, 4, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED,
            texture), D3D_OK);
        assert.equal(h.device.SetTexture(1, texture.texture), D3D_OK);
        assert.equal(h.device.SetTextureStageState(1, D3DTSS.COLOROP, D3DTOP.MODULATE), D3D_OK);
        assert.equal(h.device.SetTextureStageState(1, D3DTSS.TEXCOORDINDEX, 0x10000), D3D_OK);

        await h.draw();
        const fragment = h.gpu.of('createShaderModule').map(call=>call.descriptor.code)
            .find(code=>code.includes('fn ps_main'));
        assert.ok(fragment);
        assert.match(fragment, /sampleStage1\(input\.texCoord1\b/, 'stage 1 reads oT1');
        assert.doesNotMatch(fragment, /sampleStage1\(input\.texCoord0\b/);

        assert.equal(h.device.SetTexture(1, null), D3D_OK);
        texture.texture.release();
        assert.equal(h.device.SetVertexShader(0), D3D_OK);
        assert.equal(h.device.DeleteVertexShader(made.handle), D3D_OK);
        h.release();
    });
