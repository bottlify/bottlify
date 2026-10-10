/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A Direct3D 9 draw through shaders, followed to the GPU.
 *
 * The recording device runs no WGSL, so what is proved is everything up to
 * the queue, byte for byte: the vertex layout the declaration became, the
 * two modules the shaders became, the constant bytes each stage was bound to
 * at the draw, the geometry, and the bindings of the textures a pixel shader
 * reads. A wrong value in any of these is a wrong picture on a real GPU with
 * nothing to say why, which is why each is compared exactly.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3DFMT, D3DPOOL, D3DSWAPEFFECT, D3D_OK, floatToDword } from './constants.js';
import { D3DFMT_INDEX, D3DPT, D3DRS, D3DTS, D3DTSS } from '../d3d8/constants.js';
import { createDirect3D9 } from './device.js';
import { D3DDECLTYPE, D3DDECLUSAGE } from './declaration.js';
import { END_TOKEN, OPCODE, REGISTER, SHADER_KIND, versionToken } from './shader.js';
import { HYBRID_CONSTANTS, varyingLocation } from './wgsl.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { UNIFORM_FLOATS, multiplyMatrices, normalMatrixOf } from '../d3d8/render.js';

const RAM_BASE = 0x40000000;
const RAM_SIZE = 4 << 20;

/** @param {number} type @param {number} index @param {number} writeMask */
const dst = (type, index, writeMask = 0xf)=>(0x80000000 | ((type & 7) << 28)
    | ((type & 0x18) << 8) | (writeMask << 16) | index) >>> 0;
/** @param {number} type @param {number} index @param {number} swizzle */
const src = (type, index, swizzle = 0xe4)=>(0x80000000 | ((type & 7) << 28)
    | ((type & 0x18) << 8) | (swizzle << 16) | index) >>> 0;
/** @param {number} opcode @param {number} length */
const op = (opcode, length)=>((length << 24) | opcode) >>> 0;
/** @param {number} usage @param {number} register @param {number} [index] */
const dclInput = (usage, register, index = 0)=>[
    op(OPCODE.DCL, 2), (0x80000000 | (index << 16) | usage) >>> 0, dst(REGISTER.INPUT, register),
];

/**
 * vs_2_0: position through c0..c3, the colour scaled by c5.
 *
 *     dcl_position v0
 *     dcl_color v1
 *     m4x4 oPos, v0, c0
 *     mul oD0, v1, c5
 */
const VERTEX_SHADER = [
    versionToken(SHADER_KIND.VERTEX, 2, 0),
    ...dclInput(D3DDECLUSAGE.POSITION, 0),
    ...dclInput(D3DDECLUSAGE.COLOR, 1),
    op(OPCODE.M4x4, 3), dst(REGISTER.RASTOUT, 0), src(REGISTER.INPUT, 0), src(REGISTER.CONST, 0),
    op(OPCODE.MUL, 3), dst(REGISTER.ATTROUT, 0), src(REGISTER.INPUT, 1), src(REGISTER.CONST, 5),
    END_TOKEN,
];

/**
 * ps_2_0: the interpolated colour times a texture sample, offset by c2.
 *
 *     dcl_2d s0
 *     dcl t0
 *     dcl v0
 *     texld r0, t0, s0
 *     mad oC0, r0, v0, c2
 */
const PIXEL_SHADER = [
    versionToken(SHADER_KIND.PIXEL, 2, 0),
    op(OPCODE.DCL, 2), (2 << 27) >>> 0, dst(REGISTER.SAMPLER, 0),
    op(OPCODE.DCL, 2), 0x80000000, dst(REGISTER.TEXTURE, 0),
    op(OPCODE.DCL, 2), 0x80000000, dst(REGISTER.INPUT, 0),
    op(OPCODE.TEX, 3), dst(REGISTER.TEMP, 0), src(REGISTER.TEXTURE, 0), src(REGISTER.SAMPLER, 0),
    op(OPCODE.MAD, 4), dst(REGISTER.COLOROUT, 0), src(REGISTER.TEMP, 0), src(REGISTER.INPUT, 0),
    src(REGISTER.CONST, 2),
    END_TOKEN,
];

/** Position, a packed colour and one coordinate set: 24 bytes. */
const ELEMENTS = [
    { Stream: 0, Offset: 0, Type: D3DDECLTYPE.FLOAT3, Method: 0, Usage: D3DDECLUSAGE.POSITION,
        UsageIndex: 0 },
    { Stream: 0, Offset: 12, Type: D3DDECLTYPE.D3DCOLOR, Method: 0, Usage: D3DDECLUSAGE.COLOR,
        UsageIndex: 0 },
    { Stream: 0, Offset: 16, Type: D3DDECLTYPE.FLOAT2, Method: 0, Usage: D3DDECLUSAGE.TEXCOORD,
        UsageIndex: 0 },
];
const STRIDE = 24;

/**
 * @param {{ dumpDraws?: boolean, refusePipeline?: (descriptor: any) => string | null,
 *     model?: number }} [options]
 */
function harness(options = {}){
    const gpu = createFakeDevice({ refusePipeline: options.refusePipeline });
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
    const d3d = createDirect3D9({
        backend,
        vertexShaderVersion: { major: options.model ?? 2, minor: 0 },
        pixelShaderVersion: { major: options.model ?? 2, minor: 0 },
        readMemory: (address, length)=>ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
        allocate: bytes=>{
            const address = next;
            next += bytes + 0x100;
            return address;
        },
        divergence: (_api, detail)=>reports.push(detail),
        dumpDraws: options.dumpDraws ?? false,
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

    /** @type {{ buffer?: any }} */
    const vb = {};
    assert.equal(device.CreateVertexBuffer(STRIDE * 3, 0, 0, D3DPOOL.MANAGED, vb), D3D_OK);
    const vertices = new DataView(new ArrayBuffer(STRIDE * 3));
    [[0, 0], [1, 0], [0, 1]].forEach(([x, y], index)=>{
        const at = index * STRIDE;
        vertices.setFloat32(at, x, true);
        vertices.setFloat32(at + 4, y, true);
        vertices.setFloat32(at + 8, 0.5, true);
        vertices.setUint32(at + 12, 0xff203040 + index, true);
        vertices.setFloat32(at + 16, x, true);
        vertices.setFloat32(at + 20, y, true);
    });
    /** @type {{ pBits?: number }} */
    const lock = {};
    assert.equal(vb.buffer.Lock(0, 0, lock, 0), D3D_OK);
    ram.set(new Uint8Array(vertices.buffer), (lock.pBits ?? 0) - RAM_BASE);
    assert.equal(vb.buffer.Unlock(), D3D_OK);
    assert.equal(device.SetStreamSource(0, vb.buffer, 0, STRIDE), D3D_OK);

    /** @type {{ declaration?: any }} */
    const declaration = {};
    assert.equal(device.CreateVertexDeclaration(ELEMENTS, declaration), D3D_OK);
    assert.equal(device.SetVertexDeclaration(declaration.declaration), D3D_OK);

    /** @type {{ texture?: any }} */
    const texture = {};
    assert.equal(device.CreateTexture(2, 2, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, texture),
        D3D_OK);
    /** @type {{ pBits?: number, Pitch?: number }} */
    const texel = {};
    assert.equal(texture.texture.LockRect(0, texel), D3D_OK);
    assert.equal(texture.texture.UnlockRect(0), D3D_OK);

    return {
        gpu, device, reports, vb: vb.buffer, declaration: declaration.declaration,
        texture: texture.texture, vertexBytes: new Uint8Array(vertices.buffer),
        async draw(){
            assert.equal(device.BeginScene(), D3D_OK);
            assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
            assert.equal(device.EndScene(), D3D_OK);
            assert.equal(device.Present(), D3D_OK);
            await device.idle();
        },
        /** The bytes a bind group's buffer binding reads at its dynamic offset. */
        boundBytes(/** @type {any} */ group, /** @type {number} */ binding){
            const entry = group.descriptor.entries.find(
                (/** @type {any} */ one)=>one.binding === binding);
            const resource = entry.resource;
            const at = resource.dynamicOffset ?? resource.offset ?? 0;
            return resource.buffer.bytes.slice(at, at + resource.size);
        },
        /** The bind groups of the one draw, by group index. */
        groupsOfDraw(){
            const bound = gpu.of('setBindGroup');
            /** @type {Map<number, any>} */
            const groups = new Map();
            for (const call of bound)
            {
                groups.set(call.index, call.group);
            }
            return groups;
        },
    };
}

test('a shader pair draws: layout from the declaration, modules, constants, texture, geometry',
    async()=>{
        const h = harness();
        /** @type {{ shader?: any }} */
        const vs = {};
        /** @type {{ shader?: any }} */
        const ps = {};
        assert.equal(h.device.CreateVertexShader(VERTEX_SHADER, vs), D3D_OK);
        assert.equal(h.device.CreatePixelShader(PIXEL_SHADER, ps), D3D_OK);
        h.device.SetVertexShader(vs.shader);
        h.device.SetPixelShader(ps.shader);
        const matrix = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0.5, 0.25, 0, 1];
        assert.equal(h.device.SetVertexShaderConstantF(0, matrix, 4), D3D_OK);
        assert.equal(h.device.SetVertexShaderConstantF(5, [0.5, 0.5, 0.5, 1], 1), D3D_OK);
        assert.equal(h.device.SetVertexShaderConstantF(9, [9, 9, 9, 9], 1), D3D_OK);
        assert.equal(h.device.SetPixelShaderConstantF(2, [0.1, 0.2, 0.3, 0.4], 1), D3D_OK);
        assert.equal(h.device.SetVertexShaderConstantI(1, [3, 4, 5, 6], 1), D3D_OK);
        assert.equal(h.device.SetPixelShaderConstantB(3, [1], 1), D3D_OK);
        h.device.SetTexture(0, h.texture);
        h.device.SetSamplerState(0, 5, 2);

        await h.draw();
        assert.deepEqual(h.reports, []);
        const diagnostics = h.device.diagnostics();
        assert.equal(diagnostics.programmable, 1);
        assert.equal(diagnostics.skipped.program, 0);
        assert.equal(diagnostics.programs.built, 1);

        // The two modules, from the shaders bound, with the inputs typed as
        // the declaration lays them.
        const modules = h.gpu.of('createShaderModule').map(call=>call.descriptor);
        const vertexModule = modules.find(module=>module.label.startsWith('vs:'));
        const pixelModule = modules.find(module=>module.label.startsWith('ps:'));
        assert.ok(vertexModule && pixelModule);
        assert.ok(vertexModule.code.includes('@location(0) v0: vec3<f32>,'));
        assert.ok(vertexModule.code.includes('@location(1) v1: vec4<f32>,'));
        assert.ok(vertexModule.code.includes('let v1 = in.v1.zyxw;'));
        assert.ok(vertexModule.code.includes('c: array<vec4f, 7>;'),
            'up to c5, and the viewport register past it');
        assert.ok(pixelModule.code.includes('textureSample(tex0, samp0, in.t0.xy)'));
        assert.ok(pixelModule.code.includes('c: array<vec4f, 3>;'), 'up to c2');

        // The pipeline: one vertex buffer at the stream's stride, the two
        // elements the shader declared at the locations it declared them,
        // and the coordinate set it did not declare left out.
        const pipelines = h.gpu.of('createRenderPipeline').map(call=>call.descriptor);
        assert.equal(pipelines.length, 1);
        const [pipeline] = pipelines;
        assert.equal(pipeline.vertex.entryPoint, 'vs_main');
        assert.equal(pipeline.fragment.entryPoint, 'ps_main');
        assert.deepEqual(pipeline.vertex.buffers, [{
            arrayStride: STRIDE,
            stepMode: 'vertex',
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x3' },
                { shaderLocation: 1, offset: 12, format: 'unorm8x4' },
            ],
        }]);
        assert.equal(pipeline.layout.descriptor.bindGroupLayouts.length, 3);

        // The constants each stage was bound to, byte for byte: the vertex
        // floats to c5 and then the viewport's scale for the half-pixel move
        // of the position, all sixteen integers, the booleans.
        const groups = h.groupsOfDraw();
        const viewport = h.device.viewportState.scale;
        assert.deepEqual([...new Float32Array(h.boundBytes(groups.get(0), 0).buffer)],
            [...matrix, 0, 0, 0, 0, 0.5, 0.5, 0.5, 1, ...viewport, 0, 0].map(Math.fround));
        const ints = new Int32Array(h.boundBytes(groups.get(0), 1).buffer);
        assert.deepEqual([...ints.subarray(4, 8)], [3, 4, 5, 6]);
        assert.equal(ints.length, 64);
        const pixelFloats = new Float32Array(h.boundBytes(groups.get(1), 0).buffer);
        assert.equal(pixelFloats.length, 12);
        assert.deepEqual([...pixelFloats.subarray(8, 12)].map(v=>Math.round(v * 10) / 10),
            [0.1, 0.2, 0.3, 0.4]);
        const bools = new Uint32Array(h.boundBytes(groups.get(1), 2).buffer);
        assert.deepEqual([...bools], [0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

        // The texture at sampler zero, through a sampler carrying the state
        // the program set: linear magnification, point everything else.
        const sampled = groups.get(2).descriptor.entries;
        assert.equal(sampled.length, 2);
        assert.equal(sampled[1].resource.descriptor.magFilter, 'linear');
        assert.equal(sampled[1].resource.descriptor.minFilter, 'nearest');

        // The geometry: the bytes the program wrote, drawn as three vertices.
        const uploads = h.gpu.of('writeBuffer')
            .filter(call=>call.size === STRIDE * 3);
        assert.ok(uploads.some(call=>Buffer.from(call.bytes).equals(Buffer.from(h.vertexBytes))),
            'the vertex bytes reached a buffer');
        assert.deepEqual(h.gpu.of('draw').map(call=>call.args), [[3, 1, 0]]);

        h.device.SetTexture(0, null);
        h.device.SetVertexShader(null);
        h.device.SetPixelShader(null);
        h.device.SetVertexDeclaration(null);
        h.device.SetStreamSource(0, null, 0, 0);
        vs.shader.release();
        ps.shader.release();
        h.texture.release();
        h.declaration.release();
        h.vb.release();
        assert.equal(h.device.release(), 0);
    });

test('a ps_1_1 reads each stage as bound, projects as the stage asks, and bumps by its matrix',
    async()=>{
        // Wine's d3d9 visual.c texbem_test: tex t0, texbem t1, t0, mov r0, t1,
        // with stage 1's matrix and D3DTTFF_COUNT4 | D3DTTFF_PROJECTED.
        const h = harness();
        /** @type {{ shader?: any }} */
        const vs = {};
        /** @type {{ shader?: any }} */
        const ps = {};
        assert.equal(h.device.CreateVertexShader(VERTEX_SHADER, vs), D3D_OK);
        assert.equal(h.device.CreatePixelShader([
            versionToken(SHADER_KIND.PIXEL, 1, 1),
            0x00000042, 0xb00f0000,
            0x00000043, 0xb00f0001, 0xb0e40000,
            0x00000001, 0x800f0000, 0xb0e40001,
            END_TOKEN,
        ], ps), D3D_OK);
        h.device.SetVertexShader(vs.shader);
        h.device.SetPixelShader(ps.shader);
        /** @type {{ texture?: any }} */
        const cube = {};
        assert.equal(h.device.CreateCubeTexture(2, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, cube),
            D3D_OK);
        h.device.SetTexture(0, h.texture);
        h.device.SetTexture(1, cube.texture);
        const matrix = [0, 0.5, -0.5, 0];
        [D3DTSS.BUMPENVMAT00, D3DTSS.BUMPENVMAT01, D3DTSS.BUMPENVMAT10, D3DTSS.BUMPENVMAT11]
            .forEach((state, at)=>
                h.device.SetTextureStageState(1, state, floatToDword(matrix[at])));
        h.device.SetTextureStageState(1, D3DTSS.BUMPENVLSCALE, floatToDword(2));
        h.device.SetTextureStageState(1, D3DTSS.TEXTURETRANSFORMFLAGS, 4 | 0x100);

        await h.draw();
        assert.deepEqual(h.reports, []);
        assert.equal(h.device.diagnostics().programmable, 1);
        const pixelModule = h.gpu.of('createShaderModule').map(call=>call.descriptor)
            .find(module=>module.label.startsWith('ps:'));
        assert.ok(pixelModule.code.includes('var tex1: texture_cube<f32>;'),
            'stage one samples the cube bound there');
        assert.ok(pixelModule.code.includes('(in.t1 / in.t1.w)'), 'and divides by w');
        assert.ok(pixelModule.code.includes('const _bump = 0;'));

        // The bump registers, two a stage from the first past the constants
        // the shader reads, carry stage one's matrix and luminance.
        const groups = h.groupsOfDraw();
        const floats = new Float32Array(h.boundBytes(groups.get(1), 0).buffer);
        assert.equal(floats.length, 16 * 4);
        assert.deepEqual([...floats.subarray(8, 16)], [0, 0.5, -0.5, 0, 2, 0, 0, 0]);
        const sampled = groups.get(2).descriptor.entries;
        assert.equal(sampled[2].resource.viewDescriptor.dimension, 'cube');

        h.device.SetTexture(0, null);
        h.device.SetTexture(1, null);
        h.device.SetVertexShader(null);
        h.device.SetPixelShader(null);
        h.device.SetVertexDeclaration(null);
        h.device.SetStreamSource(0, null, 0, 0);
        vs.shader.release();
        ps.shader.release();
        cube.texture.release();
        h.texture.release();
        h.declaration.release();
        h.vb.release();
        assert.equal(h.device.release(), 0);
    });

test('a ps_1_1 over a 2D texture and over a cube map draws through a pipeline for each',
    async()=>{
        // A 1.x read samples whatever dimension is bound at its stage, so the
        // shader is translated once for each; the pipeline is the pair's, and
        // one made for the 2D read cannot bind the cube map.
        const h = harness();
        /** @type {{ shader?: any }} */
        const vs = {};
        /** @type {{ shader?: any }} */
        const ps = {};
        assert.equal(h.device.CreateVertexShader(VERTEX_SHADER, vs), D3D_OK);
        // tex t0; mov r0, t0
        assert.equal(h.device.CreatePixelShader([versionToken(SHADER_KIND.PIXEL, 1, 1),
            0x00000042, 0xb00f0000, 0x00000001, 0x800f0000, 0xb0e40000, END_TOKEN], ps),
        D3D_OK);
        h.device.SetVertexShader(vs.shader);
        h.device.SetPixelShader(ps.shader);
        /** @type {{ texture?: any }} */
        const cube = {};
        assert.equal(h.device.CreateCubeTexture(2, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, cube),
            D3D_OK);
        // Two frames of the same two draws: a frame asks for a draw's
        // pipeline once, so the second frame is where one is served again.
        for (let frame = 0; frame < 2; frame++)
        {
            assert.equal(h.device.BeginScene(), D3D_OK);
            for (const texture of [h.texture, cube.texture])
            {
                h.device.SetTexture(0, texture);
                assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
            }
            assert.equal(h.device.EndScene(), D3D_OK);
            assert.equal(h.device.Present(), D3D_OK);
        }
        await h.device.idle();
        assert.deepEqual(h.reports, []);

        assert.deepEqual(h.device.diagnostics().programs, { built: 2, reused: 2 },
            'one pipeline for each dimension, each served again in the next frame');
        const pixels = h.gpu.of('createShaderModule').map((/** @type {any} */ call)=>
            call.descriptor).filter((/** @type {any} */ module)=>module.label.startsWith('ps:'));
        assert.equal(pixels.length, 2);
        assert.ok(pixels[0].code.includes('var tex0: texture_2d<f32>;'));
        assert.ok(pixels[1].code.includes('var tex0: texture_cube<f32>;'));
        const views = h.gpu.of('createBindGroupLayout').map((/** @type {any} */ call)=>
            call.descriptor).filter((/** @type {any} */ one)=>
            String(one.label).startsWith('samplers:'))
            .map((/** @type {any} */ one)=>one.entries[0].texture.viewDimension ?? '2d');
        assert.deepEqual(views, ['2d', 'cube'], 'each pipeline binds the view it samples');

        h.device.SetTexture(0, null);
        h.device.SetVertexShader(null);
        h.device.SetPixelShader(null);
        vs.shader.release();
        ps.shader.release();
        cube.texture.release();
    });

test('a vertex shader reads the texture at D3DVERTEXTEXTURESAMPLER0 through texldl', async()=>{
    const h = harness({ model: 3 });
    const output = (/** @type {number} */ usage, /** @type {number} */ register)=>[
        op(OPCODE.DCL, 2), (0x80000000 | usage) >>> 0, dst(REGISTER.OUTPUT, register)];
    /** @type {{ shader?: any }} */
    const vs = {};
    /** @type {{ shader?: any }} */
    const ps = {};
    // vs_3_0: dcl_2d s0; texldl o2, v0, s0; mov o0, v0; mov o1, v0.
    assert.equal(h.device.CreateVertexShader([
        versionToken(SHADER_KIND.VERTEX, 3, 0),
        ...dclInput(D3DDECLUSAGE.POSITION, 0),
        ...output(D3DDECLUSAGE.POSITION, 0),
        ...output(D3DDECLUSAGE.TEXCOORD, 1),
        ...output(D3DDECLUSAGE.COLOR, 2),
        op(OPCODE.DCL, 2), (2 << 27) >>> 0, dst(REGISTER.SAMPLER, 0),
        op(OPCODE.TEXLDL, 3), dst(REGISTER.OUTPUT, 2), src(REGISTER.INPUT, 0),
        src(REGISTER.SAMPLER, 0),
        op(OPCODE.MOV, 2), dst(REGISTER.OUTPUT, 0), src(REGISTER.INPUT, 0),
        op(OPCODE.MOV, 2), dst(REGISTER.OUTPUT, 1), src(REGISTER.INPUT, 0),
        END_TOKEN,
    ], vs), D3D_OK);
    assert.equal(h.device.CreatePixelShader(PIXEL_SHADER, ps), D3D_OK);
    h.device.SetVertexShader(vs.shader);
    h.device.SetPixelShader(ps.shader);
    /** @type {{ texture?: any }} */
    const displacement = {};
    assert.equal(h.device.CreateTexture(4, 4, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED,
        displacement), D3D_OK);
    assert.equal(h.device.SetTexture(0, h.texture), D3D_OK);
    assert.equal(h.device.SetTexture(257, displacement.texture), D3D_OK);
    await h.draw();
    assert.deepEqual(h.reports, []);

    const vertexModule = h.gpu.of('createShaderModule')
        .find((/** @type {any} */ call)=>call.descriptor.code.includes('@vertex'));
    assert.ok(vertexModule.descriptor.code.includes('@binding(32) var tex0: texture_2d<f32>;'));
    assert.ok(vertexModule.descriptor.code.includes('textureSampleLevel(tex0, samp0,'));
    const layout = h.gpu.of('createBindGroupLayout').map((/** @type {any} */ call)=>call.descriptor)
        .find((/** @type {any} */ one)=>String(one.label).startsWith('samplers:'));
    assert.deepEqual(layout.entries.map((/** @type {any} */ entry)=>
        [entry.binding, entry.visibility]), [[0, 2], [1, 2], [32, 1], [33, 1]]);
    const entries = h.groupsOfDraw().get(2).descriptor.entries;
    const vertexView = entries.find((/** @type {any} */ entry)=>entry.binding === 32).resource;
    assert.equal(vertexView.texture.descriptor.size.width, 4, 'the 4x4 bound at sampler 257');
    assert.equal(entries.find((/** @type {any} */ entry)=>entry.binding === 0).resource
        .texture.descriptor.size.width, 2, 'the pixel stage keeps its own 2x2');

    h.device.SetTexture(0, null);
    h.device.SetTexture(257, null);
    h.device.SetVertexShader(null);
    h.device.SetPixelShader(null);
    vs.shader.release();
    ps.shader.release();
    displacement.texture.release();
});

test('a sampler declared a cube binds the cube map\'s cube view, and nothing of another kind',
    async()=>{
        const h = harness();
        /** @type {{ shader?: any }} */
        const vs = {};
        /** @type {{ shader?: any }} */
        const ps = {};
        const cubeSampler = (3 << 27) >>> 0;
        assert.equal(h.device.CreateVertexShader(VERTEX_SHADER, vs), D3D_OK);
        assert.equal(h.device.CreatePixelShader([
            PIXEL_SHADER[0], op(OPCODE.DCL, 2), cubeSampler, dst(REGISTER.SAMPLER, 0),
            ...PIXEL_SHADER.slice(4),
        ], ps), D3D_OK);
        h.device.SetVertexShader(vs.shader);
        h.device.SetPixelShader(ps.shader);
        /** @type {{ texture?: any }} */
        const cube = {};
        assert.equal(h.device.CreateCubeTexture(2, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, cube),
            D3D_OK);
        h.device.SetTexture(0, cube.texture);
        await h.draw();
        assert.deepEqual(h.reports, []);

        const layouts = h.gpu.of('createBindGroupLayout').map(call=>call.descriptor);
        assert.ok(layouts.some(layout=>layout.entries.some(
            (/** @type {any} */ entry)=>entry.texture?.viewDimension === 'cube')));
        const bound = ()=>h.groupsOfDraw().get(2).descriptor.entries[0].resource;
        assert.equal(bound().viewDescriptor.dimension, 'cube');
        assert.equal(bound().texture.descriptor.size.depthOrArrayLayers, 6);

        // A two-dimensional texture cannot be bound where a cube is declared:
        // the sampler reads a blank cube, and the program is told.
        h.device.SetTexture(0, h.texture);
        await h.draw();
        assert.equal(bound().texture.descriptor.label, 'placeholder:cube');
        // Every face of the placeholder reads opaque black, as an unbound
        // sampler does on Windows.
        const blank = h.gpu.of('writeTexture').find(
            (/** @type {any} */ call)=>call.destination.texture === bound().texture);
        assert.equal(blank.size.depthOrArrayLayers, 6);
        assert.deepEqual([...blank.bytes], Array.from({ length: 6 }, ()=>[0, 0, 0, 255]).flat());
        assert.equal(h.reports.length, 1);
        assert.match(h.reports[0], /declared cube and a 2d texture is bound/);

        h.device.SetTexture(0, null);
        h.device.SetVertexShader(null);
        h.device.SetPixelShader(null);
        vs.shader.release();
        ps.shader.release();
        cube.texture.release();
    });

test('a sampler declared a volume binds the volume texture\'s 3D view', async()=>{
    const h = harness();
    /** @type {{ shader?: any }} */
    const vs = {};
    /** @type {{ shader?: any }} */
    const ps = {};
    const volumeSampler = (4 << 27) >>> 0;
    assert.equal(h.device.CreateVertexShader(VERTEX_SHADER, vs), D3D_OK);
    assert.equal(h.device.CreatePixelShader([
        PIXEL_SHADER[0], op(OPCODE.DCL, 2), volumeSampler, dst(REGISTER.SAMPLER, 0),
        ...PIXEL_SHADER.slice(4),
    ], ps), D3D_OK);
    h.device.SetVertexShader(vs.shader);
    h.device.SetPixelShader(ps.shader);
    /** @type {{ texture?: any }} */
    const volume = {};
    assert.equal(h.device.CreateVolumeTexture(2, 2, 2, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED,
        volume), D3D_OK);
    h.device.SetTexture(0, volume.texture);
    await h.draw();
    assert.deepEqual(h.reports, []);
    const pixel = h.gpu.of('createShaderModule').map(call=>call.descriptor)
        .find(module=>module.label.startsWith('ps:'));
    assert.match(pixel.code, /texture_3d<f32>/);
    const bound = h.groupsOfDraw().get(2).descriptor.entries[0].resource;
    assert.equal(bound.viewDescriptor.dimension, '3d');
    assert.equal(bound.texture.descriptor.size.depthOrArrayLayers, 2);
    const sampler = h.groupsOfDraw().get(2).descriptor.entries[1].resource.descriptor;
    assert.equal(sampler.addressModeW, 'repeat', 'the third axis addressed as the program set');

    h.device.SetTexture(0, null);
    h.device.SetVertexShader(null);
    h.device.SetPixelShader(null);
    vs.shader.release();
    ps.shader.release();
    volume.texture.release();
});

test('a programmable draw is not blind to the dump: shaders, declaration and samplers', async()=>{
    // render.js's `--dump-draws` table used to skip every draw with
    // `prepared.program` outright (guarded by `!prepared.program`), so a
    // title drawing through shaders left no line in the dump at all -- the
    // instrument measured nothing on the one path this title actually draws.
    const h = harness({ dumpDraws: true });
    /** @type {{ shader?: any }} */
    const vs = {};
    /** @type {{ shader?: any }} */
    const ps = {};
    assert.equal(h.device.CreateVertexShader(VERTEX_SHADER, vs), D3D_OK);
    assert.equal(h.device.CreatePixelShader(PIXEL_SHADER, ps), D3D_OK);
    h.device.SetVertexShader(vs.shader);
    h.device.SetPixelShader(ps.shader);
    h.device.SetTexture(0, h.texture);

    await h.draw();
    assert.deepEqual(h.reports, []);
    const dump = h.device.diagnostics().lastDump;
    assert.equal(dump.length, 1, 'the programmable draw got its own line');
    assert.match(dump[0], /^#0 program /);
    assert.match(dump[0], new RegExp(`vs=${vs.shader.id} ps=${ps.shader.id}`),
        'both shader ids, not just "a program ran"');
    assert.match(dump[0], new RegExp(`decl=${h.declaration.id}`));
    // The texture bound at sampler 0 is named, not reported as a placeholder:
    // a program that samples nothing and one that samples the wrong texture
    // read the same otherwise.
    assert.doesNotMatch(dump[0], /#0:placeholder/);
    assert.match(dump[0], /\[#0:t\d+:/);

    h.device.SetTexture(0, null);
    h.device.SetVertexShader(null);
    h.device.SetPixelShader(null);
    h.device.SetVertexDeclaration(null);
    h.device.SetStreamSource(0, null, 0, 0);
    vs.shader.release();
    ps.shader.release();
    h.texture.release();
    h.declaration.release();
    h.vb.release();
    assert.equal(h.device.release(), 0);
});

test('a screen quad in target pixels draws past a bound vertex shader, which runs again after',
    async()=>{
        const h = harness({ dumpDraws: true });
        /** @type {{ shader?: any }} */
        const vs = {};
        assert.equal(h.device.CreateVertexShader(VERTEX_SHADER, vs), D3D_OK);
        h.device.SetVertexShader(vs.shader);
        h.device.SetTexture(0, h.texture);
        // XYZRHW, a colour and a coordinate set: a movie frame's quad. The
        // shader reads dcl_position, which these vertices do not carry; run,
        // it would place every vertex at c0..c3's last column and draw nothing.
        const RHW_STRIDE = 28;
        const quad = new DataView(new ArrayBuffer(RHW_STRIDE * 3));
        [[0, 0], [8, 0], [0, 8]].forEach(([x, y], index)=>{
            const at = index * RHW_STRIDE;
            quad.setFloat32(at, x, true);
            quad.setFloat32(at + 4, y, true);
            quad.setFloat32(at + 8, 0.5, true);
            quad.setFloat32(at + 12, 1, true);
            quad.setUint32(at + 16, 0xffffffff, true);
            quad.setFloat32(at + 20, x / 8, true);
            quad.setFloat32(at + 24, y / 8, true);
        });
        assert.equal(h.device.SetFVF(0x144), D3D_OK);
        assert.equal(h.device.BeginScene(), D3D_OK);
        assert.equal(h.device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1,
            new Uint8Array(quad.buffer), RHW_STRIDE), D3D_OK);
        assert.equal(h.device.EndScene(), D3D_OK);
        assert.equal(h.device.Present(), D3D_OK);
        await h.device.idle();
        assert.deepEqual(h.reports, []);
        let diagnostics = h.device.diagnostics();
        assert.equal(diagnostics.programmable, 0);
        assert.equal(diagnostics.draws, 1);
        assert.doesNotMatch(diagnostics.lastDump[0], /^#0 program /);
        const [pipeline] = h.gpu.of('createRenderPipeline').map(call=>call.descriptor);
        assert.deepEqual(pipeline.vertex.buffers[0].attributes.find(
            (/** @type {any} */ attribute)=>attribute.offset === 0),
        { shaderLocation: 0, offset: 0, format: 'float32x4' },
        'the position is read from the vertices, all four components');

        // DrawPrimitiveUP let go of stream zero.
        h.device.SetStreamSource(0, h.vb, 0, STRIDE);
        h.device.SetVertexDeclaration(h.declaration);
        await h.draw();
        diagnostics = h.device.diagnostics();
        assert.equal(diagnostics.programmable, 1, 'untransformed vertices run the shader');
        assert.match(diagnostics.lastDump[0], new RegExp(`^#0 program n=3 vs=${vs.shader.id} `));

        h.device.SetTexture(0, null);
        h.device.SetVertexShader(null);
        h.device.SetVertexDeclaration(null);
        h.device.SetStreamSource(0, null, 0, 0);
        vs.shader.release();
        h.texture.release();
        h.declaration.release();
        h.vb.release();
        assert.equal(h.device.release(), 0);
    });

test('a pixel shader over fixed-function vertices gets a vertex stage of its own', async()=>{
    const h = harness();
    /** @type {{ shader?: any }} */
    const ps = {};
    assert.equal(h.device.CreatePixelShader(PIXEL_SHADER, ps), D3D_OK);
    h.device.SetPixelShader(ps.shader);
    h.device.SetTexture(0, h.texture);
    const world = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1];
    const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 5, 0, 1];
    const projection = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0];
    h.device.SetTransform(D3DTS.WORLD, world);
    h.device.SetTransform(D3DTS.VIEW, view);
    h.device.SetTransform(D3DTS.PROJECTION, projection);

    await h.draw();
    assert.deepEqual(h.reports, []);
    assert.equal(h.device.diagnostics().programmable, 1);

    const vertexModule = h.gpu.of('createShaderModule')
        .map(call=>call.descriptor).find(module=>module.label.startsWith('vs:'));
    assert.ok(vertexModule);
    assert.ok(vertexModule.code.includes('mat4x4f(c[0], c[1], c[2], c[3])'));
    assert.ok(vertexModule.code.includes(`out.o${varyingLocation(D3DDECLUSAGE.COLOR, 0)} =`));
    assert.ok(vertexModule.code.includes(`out.o${varyingLocation(D3DDECLUSAGE.TEXCOORD, 0)} =`));

    // Every element of the declaration the pixel shader can read is bound.
    const [pipeline] = h.gpu.of('createRenderPipeline').map(call=>call.descriptor);
    assert.deepEqual(pipeline.vertex.buffers[0].attributes, [
        { shaderLocation: 0, offset: 0, format: 'float32x3' },
        { shaderLocation: 1, offset: 12, format: 'unorm8x4' },
        { shaderLocation: 2, offset: 16, format: 'float32x2' },
    ]);

    // The stage's constants: world, view and projection multiplied in that
    // order, row-major as the fixed-function block carries them, then the
    // viewport of the whole target.
    const groups = h.groupsOfDraw();
    const floats = new Float32Array(h.boundBytes(groups.get(0), 0).buffer);
    assert.equal(floats.length, HYBRID_CONSTANTS.COUNT * 4);
    const expected = multiplyMatrices(multiplyMatrices(world, view), projection);
    assert.deepEqual([...floats.subarray(0, 16)], [...expected]);
    // The offset is the negated origin -- negative zero here -- and the
    // scale two over the extent, y downward.
    assert.deepEqual([...floats.subarray(16, 20)].map(v=>v + 0), [0, 0, 2 / 8, -2 / 8],
        'the inverse offset and scale of an 8x8 viewport');

    h.device.SetTexture(0, null);
    h.device.SetPixelShader(null);
    h.device.SetVertexDeclaration(null);
    h.device.SetStreamSource(0, null, 0, 0);
    ps.shader.release();
    h.texture.release();
    h.declaration.release();
    h.vb.release();
    assert.equal(h.device.release(), 0);
});

/**
 * vs_2_0 for the fixed pixel stage: position through c0..c3, the colour and
 * the coordinate set passed on.
 *
 *     dcl_position v0
 *     dcl_color v1
 *     dcl_texcoord v2
 *     m4x4 oPos, v0, c0
 *     mov oD0, v1
 *     mov oT0, v2
 */
const TEXTURED_VERTEX_SHADER = [
    versionToken(SHADER_KIND.VERTEX, 2, 0),
    ...dclInput(D3DDECLUSAGE.POSITION, 0),
    ...dclInput(D3DDECLUSAGE.COLOR, 1),
    ...dclInput(D3DDECLUSAGE.TEXCOORD, 2),
    op(OPCODE.M4x4, 3), dst(REGISTER.RASTOUT, 0), src(REGISTER.INPUT, 0), src(REGISTER.CONST, 0),
    op(OPCODE.MOV, 2), dst(REGISTER.ATTROUT, 0), src(REGISTER.INPUT, 1),
    op(OPCODE.MOV, 2), dst(REGISTER.TEXCRDOUT, 0), src(REGISTER.INPUT, 2),
    END_TOKEN,
];

test('a vertex shader over the fixed-function pixel stage gets a fragment stage of its own',
    async()=>{
        // The shader-model-1 era's ordinary draw: transform in a program,
        // texture and blend in the stages. The stage cascade, the fog and
        // the alpha test in force become a fragment stage over what the
        // shader wrote, bound the way a pixel shader would be.
        const h = harness();
        /** @type {{ shader?: any }} */
        const vs = {};
        assert.equal(h.device.CreateVertexShader(TEXTURED_VERTEX_SHADER, vs), D3D_OK);
        h.device.SetVertexShader(vs.shader);
        h.device.SetTexture(0, h.texture);
        h.device.SetRenderState(D3DRS.ALPHATESTENABLE, 1);
        h.device.SetRenderState(D3DRS.ALPHAREF, 0x80);
        h.device.SetRenderState(D3DRS.ALPHAFUNC, 5);
        h.device.SetRenderState(D3DRS.TEXTUREFACTOR, 0xff204060);
        await h.draw();
        assert.deepEqual(h.reports, []);
        const diagnostics = h.device.diagnostics();
        assert.equal(diagnostics.programmable, 1);
        assert.equal(diagnostics.skipped.program, 0);

        const modules = h.gpu.of('createShaderModule').map(call=>call.descriptor);
        const fragment = modules.find(module=>module.label.startsWith('ps:'));
        assert.ok(fragment, 'a fragment stage was made for the shader');
        // The cascade over the shader's colour and coordinate set, the
        // block at the pixel stage's first binding, the texture in the
        // sampler group, and the alpha test the render state asked for.
        assert.ok(fragment.code.includes('@group(1) @binding(0) var<uniform> uniforms'));
        assert.ok(fragment.code.includes('@group(2) @binding(0) var texture0'));
        assert.ok(fragment.code.includes('input.diffuse = in.v0;'));
        assert.ok(fragment.code.includes('input.texCoord0 = in.t0.xy;'));
        assert.ok(fragment.code.includes('input.specular = vec4f(0.0);'),
            'a varying the shader does not write is the fixed function default');
        assert.ok(fragment.code.includes('sampleStage0(input.texCoord0)'));
        assert.ok(fragment.code.includes('current.a > uniforms.alphaRef'));
        assert.ok(!fragment.code.includes('@location(1) v1'),
            'and is not declared as an input the vertex stage would have to supply');

        // The block the fragment reads is the fixed-function block, with the
        // render state's texture factor and alpha reference in it.
        const groups = h.groupsOfDraw();
        const block = new Float32Array(h.boundBytes(groups.get(1), 0).buffer);
        assert.equal(block.length, UNIFORM_FLOATS);
        assert.deepEqual([...block.subarray(36, 40)].map(v=>Math.round(v * 255)),
            [0x20, 0x40, 0x60, 0xff]);
        assert.equal(Math.round(block[72] * 255), 0x80);

        h.device.SetTexture(0, null);
        h.device.SetVertexShader(null);
        h.device.SetVertexDeclaration(null);
        h.device.SetStreamSource(0, null, 0, 0);
        vs.shader.release();
        h.texture.release();
        h.declaration.release();
        h.vb.release();
        assert.equal(h.device.release(), 0);
    });

test('a vertex shader over the fixed pixel stage is prepared once for the state its draws share',
    async()=>{
        // How a program that draws each model through its own buffer goes:
        // before every draw the same declaration and shader again, another
        // buffer of the same layout, the model's constants. Nothing a draw's
        // preparation is built from has changed, so the state is named and
        // the pieces are made once -- while each draw still reads its own
        // constants from its own buffer.
        const h = harness();
        /** @type {{ shader?: any }} */
        const vs = {};
        assert.equal(h.device.CreateVertexShader(TEXTURED_VERTEX_SHADER, vs), D3D_OK);
        /** @type {{ buffer?: any }} */
        const other = {};
        assert.equal(h.device.CreateVertexBuffer(STRIDE * 3, 0, 0, D3DPOOL.MANAGED, other),
            D3D_OK);
        h.device.SetVertexShader(vs.shader);
        h.device.SetTexture(0, h.texture);
        assert.equal(h.device.BeginScene(), D3D_OK);
        for (let index = 0; index < 4; index++)
        {
            assert.equal(h.device.SetVertexDeclaration(h.declaration), D3D_OK);
            assert.equal(h.device.SetVertexShader(vs.shader), D3D_OK);
            assert.equal(h.device.SetStreamSource(0, index & 1 ? other.buffer : h.vb, 0, STRIDE),
                D3D_OK);
            assert.equal(h.device.SetVertexShaderConstantF(0,
                [index + 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 4), D3D_OK);
            assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        }
        const shared = h.device.diagnostics();
        assert.deepEqual(shared.prepared, { built: 1, reused: 3 });
        assert.equal(shared.statesNamed, 1, 'the state named once, not once a draw');

        // A render state changed is a state of its own.
        h.device.SetRenderState(D3DRS.CULLMODE, 1);
        assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        assert.equal(h.device.EndScene(), D3D_OK);
        assert.equal(h.device.Present(), D3D_OK);
        await h.device.idle();
        assert.equal(h.device.diagnostics().prepared.built, 2);
        assert.equal(h.device.diagnostics().statesNamed, 2);

        const firsts = h.gpu.of('setBindGroup')
            .filter((/** @type {any} */ call)=>call.index === 0)
            .map((/** @type {any} */ call)=>new Float32Array(call.resolved[0].range.buffer)[0]);
        assert.deepEqual(firsts, [1, 2, 3, 4, 4], 'each draw its own c0');
        const buffers = h.gpu.of('setVertexBuffer')
            .map((/** @type {any} */ call)=>call.buffer);
        assert.equal(new Set(buffers).size, 2, 'two buffers bound');
        assert.deepEqual(buffers.slice(0, 4).map(buffer=>buffer === buffers[0]),
            [true, false, true, false], 'each draw its own buffer');
        other.buffer.release();
        vs.shader.release();
    });

test('a fixed pixel stage over a vertex shader is prepared again when a texture comes or goes',
    async()=>{
        // Which stages have a texture shapes the cascade and moves no
        // version: a stage that reads a texture with none bound passes its
        // colour on, a different fragment stage.
        const h = harness();
        /** @type {{ shader?: any }} */
        const vs = {};
        assert.equal(h.device.CreateVertexShader(TEXTURED_VERTEX_SHADER, vs), D3D_OK);
        h.device.SetVertexShader(vs.shader);
        assert.equal(h.device.BeginScene(), D3D_OK);
        h.device.SetTexture(0, h.texture);
        assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        h.device.SetTexture(0, null);
        assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        assert.equal(h.device.diagnostics().prepared.built, 2, 'untextured is another stage');
        h.device.SetTexture(0, h.texture);
        assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        assert.deepEqual(h.device.diagnostics().prepared, { built: 2, reused: 1 },
            'and textured again is the first one, kept');
        assert.equal(h.device.EndScene(), D3D_OK);
        assert.equal(h.device.Present(), D3D_OK);
        await h.device.idle();
        const fragments = h.gpu.of('createShaderModule')
            .filter((/** @type {any} */ call)=>call.descriptor.label.startsWith('ps:'));
        assert.equal(fragments.length, 2);
        assert.ok(fragments[0].descriptor.code.includes('sampleStage0'));
        assert.ok(!fragments[1].descriptor.code.includes('sampleStage0'));
        vs.shader.release();
    });

test('draws switching between two vertex shaders name their state once, each with its shader',
    async()=>{
        // A shader switched between draws changes no render state: the pieces
        // are keyed by the shader, so the state is named once and each shader's
        // pieces are made once.
        const h = harness();
        /** @type {{ shader?: any }} */
        const textured = {};
        /** @type {{ shader?: any }} */
        const tinted = {};
        assert.equal(h.device.CreateVertexShader(TEXTURED_VERTEX_SHADER, textured), D3D_OK);
        assert.equal(h.device.CreateVertexShader(VERTEX_SHADER, tinted), D3D_OK);
        h.device.SetTexture(0, h.texture);
        assert.equal(h.device.BeginScene(), D3D_OK);
        for (const shader of [textured, tinted, textured, tinted])
        {
            assert.equal(h.device.SetVertexShader(shader.shader), D3D_OK);
            assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        }
        assert.equal(h.device.EndScene(), D3D_OK);
        assert.equal(h.device.Present(), D3D_OK);
        await h.device.idle();
        assert.deepEqual(h.device.diagnostics().prepared, { built: 2, reused: 2 });
        assert.equal(h.device.diagnostics().statesNamed, 1);
        const pipelines = h.gpu.of('setPipeline')
            .map((/** @type {any} */ call)=>call.pipeline);
        assert.equal(new Set(pipelines).size, 2, 'a pipeline for each shader');
        assert.deepEqual(pipelines.map(pipeline=>pipeline === pipelines[0]),
            [true, false, true, false], 'and each draw with its own');
        textured.shader.release();
        tinted.shader.release();
    });

test('fixed-function draws switching declarations each read through their own', async()=>{
    // The declaration is a binding the version does not move for, and the
    // fixed-function key holds the layout it names: a draw through another
    // declaration is another preparation, never the last one's.
    const h = harness();
    /** @type {{ declaration?: any }} */
    const short = {};
    assert.equal(h.device.CreateVertexDeclaration(ELEMENTS.slice(0, 2), short), D3D_OK);
    assert.equal(h.device.BeginScene(), D3D_OK);
    for (const declaration of [h.declaration, short.declaration, h.declaration])
    {
        assert.equal(h.device.SetVertexDeclaration(declaration), D3D_OK);
        assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    }
    assert.equal(h.device.EndScene(), D3D_OK);
    assert.equal(h.device.Present(), D3D_OK);
    await h.device.idle();
    assert.deepEqual(h.device.diagnostics().prepared, { built: 2, reused: 1 });
    const attributes = h.gpu.of('setPipeline').map((/** @type {any} */ call)=>
        call.pipeline.descriptor.vertex.buffers[0].attributes.length);
    assert.deepEqual(attributes, [3, 2, 3], 'position, colour and coordinates; then two');
    short.declaration.release();
});

test('a material set between shader draws is no new state for their pieces', async()=>{
    // A shader draw lights itself from its constants; the material is the
    // fixed-function vertex stage's. A program that sets one before every
    // model has changed nothing a shader draw's pieces are built from.
    const h = harness();
    /** @type {{ shader?: any }} */
    const vs = {};
    assert.equal(h.device.CreateVertexShader(TEXTURED_VERTEX_SHADER, vs), D3D_OK);
    h.device.SetVertexShader(vs.shader);
    h.device.SetTexture(0, h.texture);
    const none = { r: 0, g: 0, b: 0, a: 0 };
    assert.equal(h.device.BeginScene(), D3D_OK);
    for (const red of [0.25, 0.5, 0.75])
    {
        assert.equal(h.device.SetMaterial({ Diffuse: { r: red, g: 0, b: 0, a: 1 }, Ambient: none,
            Specular: none, Emissive: none, Power: 0 }), D3D_OK);
        assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    }
    assert.deepEqual(h.device.diagnostics().prepared, { built: 1, reused: 2 });
    // A render state is one.
    h.device.SetRenderState(D3DRS.ALPHABLENDENABLE, 1);
    assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    assert.equal(h.device.diagnostics().prepared.built, 2);
    assert.equal(h.device.EndScene(), D3D_OK);
    vs.shader.release();
});

test('a viewport set again names no new state; another viewport does', async()=>{
    // The viewport is part of the state a draw is named by, compared as the
    // object the device holds: one made again for the same rectangle was a
    // state named again on the next draw.
    const h = harness();
    h.device.SetTexture(0, h.texture);
    assert.equal(h.device.BeginScene(), D3D_OK);
    assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    const named = h.device.diagnostics().statesNamed;
    const viewport = { X: 0, Y: 0, Width: 8, Height: 8, MinZ: 0, MaxZ: 1 };
    assert.equal(h.device.SetViewport(viewport), D3D_OK);
    assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    assert.equal(h.device.diagnostics().statesNamed, named, 'the viewport in force, set again');
    assert.equal(h.device.SetViewport({ ...viewport, Width: 4 }), D3D_OK);
    assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    assert.equal(h.device.diagnostics().statesNamed, named + 1, 'another is a state of its own');
    /** @type {{ viewport?: any }} */
    const out = {};
    assert.equal(h.device.GetViewport(out), D3D_OK);
    assert.equal(out.viewport.Width, 4);
    assert.equal(h.device.EndScene(), D3D_OK);
});

test('a vertex shader that writes no coordinate set leaves a sampling stage reading zero',
    async()=>{
        const h = harness();
        /** @type {{ shader?: any }} */
        const vs = {};
        assert.equal(h.device.CreateVertexShader(VERTEX_SHADER, vs), D3D_OK);
        h.device.SetVertexShader(vs.shader);
        h.device.SetTexture(0, h.texture);
        await h.draw();
        assert.equal(h.device.diagnostics().programmable, 1);
        const fragment = h.gpu.of('createShaderModule').map(call=>call.descriptor)
            .find(module=>module.label.startsWith('ps:'));
        assert.ok(fragment);
        assert.ok(fragment.code.includes('sampleStage0'), 'the stage still samples');
        assert.match(fragment.code, /input\.texCoord0 = vec2f\(0\.0\);/,
            'at zero: coordinate set zero is one the shader never wrote');
        h.device.SetTexture(0, null);
        h.device.SetVertexShader(null);
        h.device.SetVertexDeclaration(null);
        h.device.SetStreamSource(0, null, 0, 0);
        vs.shader.release();
        h.texture.release();
        h.declaration.release();
        h.vb.release();
        assert.equal(h.device.release(), 0);
    });

/**
 * vs_2_0 that writes its position and a coordinate set and no colour.
 *
 *     dcl_position v0
 *     dcl_texcoord v2
 *     m4x4 oPos, v0, c0
 *     mov oT0, v2
 */
const COLOURLESS_VERTEX_SHADER = [
    versionToken(SHADER_KIND.VERTEX, 2, 0),
    ...dclInput(D3DDECLUSAGE.POSITION, 0),
    ...dclInput(D3DDECLUSAGE.TEXCOORD, 2),
    op(OPCODE.M4x4, 3), dst(REGISTER.RASTOUT, 0), src(REGISTER.INPUT, 0), src(REGISTER.CONST, 0),
    op(OPCODE.MOV, 2), dst(REGISTER.TEXCRDOUT, 0), src(REGISTER.INPUT, 2),
    END_TOKEN,
];

test('a varying the pixel shader reads and the vertex shader never writes is written as zero',
    async()=>{
        // Direct3D reads whatever was left in the register; a WebGPU fragment
        // input with no vertex output fails the pipeline and, with it, the
        // whole frame. So the vertex stage writes it, as zero.
        const h = harness();
        /** @type {{ shader?: any }} */
        const vs = {};
        /** @type {{ shader?: any }} */
        const ps = {};
        assert.equal(h.device.CreateVertexShader(COLOURLESS_VERTEX_SHADER, vs), D3D_OK);
        assert.equal(h.device.CreatePixelShader(PIXEL_SHADER, ps), D3D_OK);
        h.device.SetVertexShader(vs.shader);
        h.device.SetPixelShader(ps.shader);
        h.device.SetTexture(0, h.texture);
        await h.draw();
        assert.deepEqual(h.reports, []);
        assert.equal(h.device.diagnostics().programmable, 1);
        const vertexModule = h.gpu.of('createShaderModule')
            .map(call=>call.descriptor).find(module=>module.label.startsWith('vs:'));
        assert.ok(vertexModule);
        const colour = varyingLocation(D3DDECLUSAGE.COLOR, 0);
        assert.ok(vertexModule.code.includes(`@location(${colour}) oX${colour}: vec4f`),
            'the colour the pixel shader reads is an output');
        assert.ok(vertexModule.code.includes(`out.oX${colour} = vec4f(0.0);`), 'written as zero');

        h.device.SetTexture(0, null);
        h.device.SetPixelShader(null);
        h.device.SetVertexShader(null);
        h.device.SetVertexDeclaration(null);
        h.device.SetStreamSource(0, null, 0, 0);
        ps.shader.release();
        vs.shader.release();
        h.texture.release();
        h.declaration.release();
        h.vb.release();
        assert.equal(h.device.release(), 0);
    });

test('a pixel shader over a declaration that carries only a position is given what it reads',
    async()=>{
        // The fixed-function pipeline hands a pixel shader white where the
        // vertex has no colour and zero where it has no coordinate set; a
        // fragment input the vertex stage does not write fails the pipeline.
        const h = harness();
        /** @type {{ declaration?: any }} */
        const positionOnly = {};
        assert.equal(h.device.CreateVertexDeclaration([ELEMENTS[0]], positionOnly), D3D_OK);
        assert.equal(h.device.SetVertexDeclaration(positionOnly.declaration), D3D_OK);
        /** @type {{ shader?: any }} */
        const ps = {};
        assert.equal(h.device.CreatePixelShader(PIXEL_SHADER, ps), D3D_OK);
        h.device.SetPixelShader(ps.shader);
        h.device.SetTexture(0, h.texture);
        await h.draw();
        assert.deepEqual(h.reports, []);
        assert.deepEqual(h.device.diagnostics().failures, []);
        assert.equal(h.device.diagnostics().programmable, 1);
        const vertexModule = h.gpu.of('createShaderModule')
            .map(call=>call.descriptor).find(module=>module.label.startsWith('vs:'));
        assert.ok(vertexModule);
        const colour = varyingLocation(D3DDECLUSAGE.COLOR, 0);
        const coordinates = varyingLocation(D3DDECLUSAGE.TEXCOORD, 0);
        assert.ok(vertexModule.code.includes(`out.o${colour} = vec4f(1.0);`), 'colour white');
        assert.ok(vertexModule.code.includes(`out.o${coordinates} = vec4f(0.0);`),
            'coordinates zero');
        const [pipeline] = h.gpu.of('createRenderPipeline').map(call=>call.descriptor);
        assert.deepEqual(pipeline.vertex.buffers[0].attributes,
            [{ shaderLocation: 0, offset: 0, format: 'float32x3' }]);

        h.device.SetTexture(0, null);
        h.device.SetPixelShader(null);
        h.device.SetVertexDeclaration(null);
        h.device.SetStreamSource(0, null, 0, 0);
        ps.shader.release();
        positionOnly.declaration.release();
        h.texture.release();
        h.declaration.release();
        h.vb.release();
        assert.equal(h.device.release(), 0);
    });

test('a pixel shader over fixed-function vertices generating from the normal carries it as one',
    async()=>{
        // D3DTSS_TCI_CAMERASPACENORMAL: the made vertex stage's constants
        // carry the inverse transpose of world then view, which a view that
        // doubles x makes a half there.
        const h = harness();
        /** @type {{ shader?: any }} */
        const ps = {};
        assert.equal(h.device.CreatePixelShader(PIXEL_SHADER, ps), D3D_OK);
        h.device.SetPixelShader(ps.shader);
        h.device.SetTexture(0, h.texture);
        h.device.SetTextureStageState(0, D3DTSS.TEXCOORDINDEX, 0x10000);
        const view = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1];
        h.device.SetTransform(D3DTS.VIEW, view);
        await h.draw();
        assert.deepEqual(h.reports, []);
        const floats = new Float32Array(h.boundBytes(h.groupsOfDraw().get(0), 0).buffer);
        const at = HYBRID_CONSTANTS.CAMERA_NORMAL * 4;
        assert.deepEqual([...floats.subarray(at, at + 16)],
            [...normalMatrixOf(view)].map(Math.fround));
        assert.equal(floats[at], 0.5);
        h.device.SetTexture(0, null);
        h.device.SetPixelShader(null);
        h.device.SetVertexDeclaration(null);
        h.device.SetStreamSource(0, null, 0, 0);
        ps.shader.release();
        h.texture.release();
        h.declaration.release();
        h.vb.release();
        assert.equal(h.device.release(), 0);
    });

test('a pixel shader over fixed-function vertices reads a coordinate the stages generate',
    async()=>{
        // Stage 0 set to D3DTSS_TCI_CAMERASPACEPOSITION with a three-coordinate
        // transform: the vertex stage made for the pixel shader writes t0
        // from the vertex through world-view and the transform, and its
        // constants carry both, whatever set the declaration has.
        const h = harness();
        /** @type {{ shader?: any }} */
        const ps = {};
        assert.equal(h.device.CreatePixelShader(PIXEL_SHADER, ps), D3D_OK);
        h.device.SetPixelShader(ps.shader);
        h.device.SetTexture(0, h.texture);
        h.device.SetTextureStageState(0, D3DTSS.TEXCOORDINDEX, 0x20000);
        h.device.SetTextureStageState(0, D3DTSS.TEXTURETRANSFORMFLAGS, 3);
        h.device.SetTransform(D3DTS.TEXTURE0, [
            0.5, 0, 0, 0,
            0, -0.5, 0, 0,
            0, 0, 1, 0,
            0.25, 0.75, 0, 1,
        ]);
        h.device.SetTransform(D3DTS.VIEW, [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 5, 1,
        ]);
        await h.draw();
        assert.deepEqual(h.reports, []);
        assert.deepEqual(h.device.diagnostics().failures, []);
        const vertexModule = h.gpu.of('createShaderModule')
            .map(call=>call.descriptor).find(module=>module.label.startsWith('vs:'));
        assert.ok(vertexModule);
        const t0 = varyingLocation(D3DDECLUSAGE.TEXCOORD, 0);
        const row = HYBRID_CONSTANTS.TRANSFORMS;
        assert.ok(vertexModule.code.includes(
            `out.o${t0} = vec4f(dot(c[${row}], vec4f(cameraPosition, 1.0)),`),
        'the set the pixel shader reads is generated');
        assert.ok(!vertexModule.code.includes(`out.o${t0} = vec4f(in.v2`),
            'the carried set is not sent');
        const groups = h.groupsOfDraw();
        const floats = new Float32Array(h.boundBytes(groups.get(0), 0).buffer);
        assert.equal(floats.length, HYBRID_CONSTANTS.COUNT * 4);
        assert.deepEqual([...floats.subarray(HYBRID_CONSTANTS.WORLD_VIEW * 4 + 12,
            HYBRID_CONSTANTS.WORLD_VIEW * 4 + 16)], [0, 0, 5, 1]);
        assert.deepEqual([...floats.subarray(HYBRID_CONSTANTS.TRANSFORMS * 4,
            HYBRID_CONSTANTS.TRANSFORMS * 4 + 16)],
        [0.5, 0, 0, 0.25, 0, -0.5, 0, 0.75, 0, 0, 1, 0, 0, 0, 0, 1]);

        // D3DRS_NORMALIZENORMALS reaches the made stage's camera-space
        // normal, as it reaches the fixed-function stage's: off by default,
        // and set, a stage of its own.
        // The normal goes into camera space by the inverse transpose of
        // world then view, which the constants carry once a stage takes one.
        assert.ok(vertexModule.code.includes('let cameraNormal = (mat4x4f(c[43]'));
        h.device.SetRenderState(D3DRS.NORMALIZENORMALS, 1);
        h.device.SetTextureStageState(0, D3DTSS.TEXCOORDINDEX, 0x10000);
        await h.draw();
        assert.ok(h.gpu.of('createShaderModule').map(call=>call.descriptor)
            .some(module=>module.label.startsWith('vs:')
                && module.code.includes('let cameraNormal = d3dNrm((mat4x4f(c[43]')));

        h.device.SetTexture(0, null);
        h.device.SetPixelShader(null);
        h.device.SetVertexDeclaration(null);
        h.device.SetStreamSource(0, null, 0, 0);
        ps.shader.release();
        h.texture.release();
        h.declaration.release();
        h.vb.release();
        assert.equal(h.device.release(), 0);
    });

test('a pipeline the GPU refuses loses its draw and names the reason; the frame goes on',
    async()=>{
        // A pipeline handed back invalid fails every command buffer it is
        // set on, and with it every frame from then on: the build has to
        // reject instead, so that one draw is skipped and the failure read.
        const h = harness({
            refusePipeline: descriptor=>descriptor.label.startsWith('programmable:')
                ? 'Fragment input at location 2 has no vertex output' : null,
        });
        /** @type {{ shader?: any }} */
        const ps = {};
        assert.equal(h.device.CreatePixelShader(PIXEL_SHADER, ps), D3D_OK);
        h.device.SetPixelShader(ps.shader);
        h.device.SetTexture(0, h.texture);
        await h.draw();
        assert.deepEqual(h.device.diagnostics().failures,
            ['Fragment input at location 2 has no vertex output']);
        assert.equal(h.gpu.count('submit'), 1, 'the frame is still submitted');
        assert.equal(h.gpu.count('draw'), 0, 'without the draw');

        h.device.SetTexture(0, null);
        h.device.SetPixelShader(null);
        h.device.SetVertexDeclaration(null);
        h.device.SetStreamSource(0, null, 0, 0);
        ps.shader.release();
        h.texture.release();
        h.declaration.release();
        h.vb.release();
        assert.equal(h.device.release(), 0);
    });

test('a declaration the GPU cannot deliver is declined with the reason', async()=>{
    const h = harness();
    /** @type {{ shader?: any }} */
    const vs = {};
    /** @type {{ shader?: any }} */
    const ps = {};
    h.device.CreateVertexShader(VERTEX_SHADER, vs);
    h.device.CreatePixelShader(PIXEL_SHADER, ps);
    h.device.SetVertexShader(vs.shader);
    h.device.SetPixelShader(ps.shader);
    /** @type {{ declaration?: any }} */
    const packed = {};
    // UDEC3 has no WebGPU vertex format.
    assert.equal(h.device.CreateVertexDeclaration([
        { Stream: 0, Offset: 0, Type: D3DDECLTYPE.UDEC3, Method: 0, Usage: D3DDECLUSAGE.POSITION,
            UsageIndex: 0 },
    ], packed), D3D_OK);
    h.device.SetVertexDeclaration(packed.declaration);
    await h.draw();
    assert.equal(h.device.diagnostics().skipped.program, 1);
    assert.equal(h.reports.length, 1);
    assert.match(h.reports[0], /element type 13/);

    h.device.SetVertexShader(null);
    h.device.SetPixelShader(null);
    h.device.SetVertexDeclaration(null);
    h.device.SetStreamSource(0, null, 0, 0);
    vs.shader.release();
    ps.shader.release();
    packed.declaration.release();
    h.texture.release();
    h.declaration.release();
    h.vb.release();
    assert.equal(h.device.release(), 0);
});

test('a shader pair reads a member of another stream from that stream\'s buffer', async()=>{
    // A declaration may put each member in a stream of its own; the shader
    // reads the colour from stream 1, bound at its own stride, as a second
    // vertex buffer after stream zero's.
    const h = harness();
    /** @type {{ shader?: any }} */
    const vs = {};
    /** @type {{ shader?: any }} */
    const ps = {};
    h.device.CreateVertexShader(VERTEX_SHADER, vs);
    h.device.CreatePixelShader(PIXEL_SHADER, ps);
    h.device.SetVertexShader(vs.shader);
    h.device.SetPixelShader(ps.shader);
    /** @type {{ declaration?: any }} */
    const split = {};
    assert.equal(h.device.CreateVertexDeclaration([
        { Stream: 0, Offset: 0, Type: D3DDECLTYPE.FLOAT3, Method: 0,
            Usage: D3DDECLUSAGE.POSITION, UsageIndex: 0 },
        { Stream: 1, Offset: 0, Type: D3DDECLTYPE.D3DCOLOR, Method: 0,
            Usage: D3DDECLUSAGE.COLOR, UsageIndex: 0 },
    ], split), D3D_OK);
    h.device.SetVertexDeclaration(split.declaration);
    /** @type {{ buffer?: any }} */
    const colours = {};
    assert.equal(h.device.CreateVertexBuffer(12, 0, 0, D3DPOOL.MANAGED, colours), D3D_OK);
    assert.equal(h.device.SetStreamSource(1, colours.buffer, 0, 4), D3D_OK);
    await h.draw();
    assert.deepEqual(h.reports, []);
    assert.equal(h.device.diagnostics().skipped.program, 0);
    const [pipeline] = h.gpu.of('createRenderPipeline').map(call=>call.descriptor);
    assert.deepEqual(pipeline.vertex.buffers.map((/** @type {any} */ buffer)=>
        [buffer.arrayStride, buffer.attributes.map((/** @type {any} */ a)=>a.format)]),
    [[STRIDE, ['float32x3']], [4, ['unorm8x4']]]);
    assert.equal(h.gpu.of('setVertexBuffer').filter(call=>call.slot === 1).length, 1);

    h.device.SetVertexShader(null);
    h.device.SetPixelShader(null);
    h.device.SetVertexDeclaration(null);
    h.device.SetStreamSource(0, null, 0, 0);
    h.device.SetStreamSource(1, null, 0, 0);
    vs.shader.release();
    ps.shader.release();
    split.declaration.release();
    colours.buffer.release();
    h.texture.release();
    h.declaration.release();
    h.vb.release();
    assert.equal(h.device.release(), 0);
});

test('an indexed draw is instanced by stream zero\'s count, a stream stepping by instance',
    async()=>{
        // D3D9 instancing: stream zero carries D3DSTREAMSOURCE_INDEXEDDATA and
        // the count, a further stream D3DSTREAMSOURCE_INSTANCEDATA | 1, and an
        // indexed draw draws the geometry once an instance with the further
        // stream read once an instance (Wine's d3d9 stream_test).
        const h = harness();
        /** @type {{ shader?: any }} */
        const vs = {};
        /** @type {{ shader?: any }} */
        const ps = {};
        h.device.CreateVertexShader(VERTEX_SHADER, vs);
        h.device.CreatePixelShader(PIXEL_SHADER, ps);
        h.device.SetVertexShader(vs.shader);
        h.device.SetPixelShader(ps.shader);
        /** @type {{ declaration?: any }} */
        const split = {};
        assert.equal(h.device.CreateVertexDeclaration([
            { Stream: 0, Offset: 0, Type: D3DDECLTYPE.FLOAT3, Method: 0,
                Usage: D3DDECLUSAGE.POSITION, UsageIndex: 0 },
            { Stream: 1, Offset: 0, Type: D3DDECLTYPE.D3DCOLOR, Method: 0,
                Usage: D3DDECLUSAGE.COLOR, UsageIndex: 0 },
        ], split), D3D_OK);
        h.device.SetVertexDeclaration(split.declaration);
        /** @type {{ buffer?: any }} */
        const colours = {};
        assert.equal(h.device.CreateVertexBuffer(16, 0, 0, D3DPOOL.MANAGED, colours), D3D_OK);
        assert.equal(h.device.SetStreamSource(1, colours.buffer, 4, 4), D3D_OK);
        /** @type {{ buffer?: any }} */
        const indices = {};
        assert.equal(h.device.CreateIndexBuffer(6, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.MANAGED,
            indices), D3D_OK);
        assert.equal(h.device.SetIndices(indices.buffer), D3D_OK);
        assert.equal(h.device.SetStreamSourceFreq(0, (0x40000000 | 3) >>> 0), D3D_OK);
        assert.equal(h.device.SetStreamSourceFreq(1, (0x80000000 | 1) >>> 0), D3D_OK);
        const draw = async()=>{
            assert.equal(h.device.BeginScene(), D3D_OK);
            assert.equal(h.device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 0, 3, 0, 1),
                D3D_OK);
            assert.equal(h.device.EndScene(), D3D_OK);
            assert.equal(h.device.Present(), D3D_OK);
            await h.device.idle();
        };
        await draw();
        assert.deepEqual(h.reports, []);
        const [pipeline] = h.gpu.of('createRenderPipeline').map(call=>call.descriptor);
        assert.deepEqual(pipeline.vertex.buffers.map((/** @type {any} */ buffer)=>
            [buffer.arrayStride, buffer.stepMode]), [[STRIDE, 'vertex'], [4, 'instance']]);
        assert.deepEqual(h.gpu.of('drawIndexed').map(call=>call.args[1]), [3], 'three instances');
        assert.deepEqual(h.gpu.of('setVertexBuffer').filter(call=>call.slot === 1)
            .map(call=>call.offset), [4], 'the instance stream at its own offset');

        // A stream stepping every second instance is not what a vertex
        // buffer can do: the draw is not drawn, and that is said.
        assert.equal(h.device.SetStreamSourceFreq(1, (0x80000000 | 2) >>> 0), D3D_OK);
        await draw();
        assert.equal(h.gpu.of('drawIndexed').length, 1);
        assert.equal(h.device.diagnostics().skipped.instancing, 1);
        assert.equal(h.reports.length, 1);

        h.device.SetStreamSourceFreq(0, 1);
        h.device.SetStreamSourceFreq(1, 1);
        h.device.SetVertexShader(null);
        h.device.SetPixelShader(null);
        h.device.SetVertexDeclaration(null);
        h.device.SetStreamSource(0, null, 0, 0);
        h.device.SetStreamSource(1, null, 0, 0);
        h.device.SetIndices(null);
        vs.shader.release();
        ps.shader.release();
        split.declaration.release();
        colours.buffer.release();
        indices.buffer.release();
        h.texture.release();
        h.declaration.release();
        h.vb.release();
        assert.equal(h.device.release(), 0);
    });

test('draws that change only their constants share a preparation and read their own', async()=>{
    // The shape of a shader-drawn frame: constants set before every draw and
    // nothing else. The translations and pipeline state are made once for the
    // state; the constants are copied for each draw, so each still reads its own.
    const h = harness();
    /** @type {{ shader?: any }} */
    const vs = {};
    /** @type {{ shader?: any }} */
    const ps = {};
    assert.equal(h.device.CreateVertexShader(VERTEX_SHADER, vs), D3D_OK);
    assert.equal(h.device.CreatePixelShader(PIXEL_SHADER, ps), D3D_OK);
    h.device.SetVertexShader(vs.shader);
    h.device.SetPixelShader(ps.shader);
    h.device.SetTexture(0, h.texture);
    assert.equal(h.device.BeginScene(), D3D_OK);
    for (let index = 0; index < 3; index++)
    {
        assert.equal(h.device.SetVertexShaderConstantF(5, [index, index, index, 1], 1), D3D_OK);
        assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    }
    // A render state changed is a new preparation, with a pipeline of its own.
    h.device.SetRenderState(D3DRS.CULLMODE, 1);
    assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    assert.equal(h.device.EndScene(), D3D_OK);
    assert.equal(h.device.Present(), D3D_OK);
    await h.device.idle();

    const colours = h.gpu.of('setBindGroup')
        .filter((/** @type {any} */ call)=>call.index === 0)
        .map((/** @type {any} */ call)=>[...new Float32Array(call.resolved[0].range.buffer)]
            .slice(20, 24));
    assert.deepEqual(colours, [[0, 0, 0, 1], [1, 1, 1, 1], [2, 2, 2, 1], [2, 2, 2, 1]]);
    assert.equal(h.gpu.of('createRenderPipeline').length, 2, 'one pipeline per state');
});

/**
 * What a read fills of a texture of one channel (R16F, R32F) and of two
 * (G16R16F, G32R32F, G16R16): Direct3D samples the channels these lack as one
 * (Wine's d3d9 visual.c), the GPU's r16float and rg16float as zero. The
 * precision a wide format is kept at is still reported; nothing else is.
 */
const fillsOne = (/** @type {string} */ read)=>`vec4f(${read}.x, 1.0, 1.0, 1.0)`;
const fillsTwo = (/** @type {string} */ read)=>`vec4f(${read}.xy, 1.0, 1.0)`;

/** @param {ReturnType<typeof harness>} h @param {number} format @param {number} [size] */
const narrowTexture = (h, format, size = 2)=>{
    /** @type {{ texture?: any }} */
    const out = {};
    assert.equal(h.device.CreateTexture(size, size, 1, 0, format, D3DPOOL.MANAGED, out), D3D_OK);
    return out.texture;
};

/** @param {ReturnType<typeof harness>} h @param {string} prefix  'vs:' or 'ps:' */
const modulesOf = (h, prefix)=>h.gpu.of('createShaderModule')
    .map((/** @type {any} */ call)=>call.descriptor)
    .filter((/** @type {any} */ module)=>module.label.startsWith(prefix))
    .map((/** @type {any} */ module)=>/** @type {string} */ (module.code));

test('a pixel shader reads the channels its texture lacks as one, in a pipeline of its own',
    async()=>{
        const h = harness();
        /** @type {{ shader?: any }} */
        const vs = {};
        /** @type {{ shader?: any }} */
        const ps = {};
        assert.equal(h.device.CreateVertexShader(VERTEX_SHADER, vs), D3D_OK);
        assert.equal(h.device.CreatePixelShader(PIXEL_SHADER, ps), D3D_OK);
        h.device.SetVertexShader(vs.shader);
        h.device.SetPixelShader(ps.shader);
        const narrow = narrowTexture(h, D3DFMT.G16R16F);
        assert.equal(h.device.BeginScene(), D3D_OK);
        for (const texture of [h.texture, narrow, h.texture, narrow])
        {
            h.device.SetTexture(0, texture);
            assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        }
        assert.equal(h.device.EndScene(), D3D_OK);
        assert.equal(h.device.Present(), D3D_OK);
        await h.device.idle();
        assert.deepEqual(h.reports.filter(report=>!report.includes(' is kept ')), []);

        const pixels = modulesOf(h, 'ps:');
        assert.equal(pixels.length, 2, 'one module for each, each kept after');
        assert.ok(pixels[0].includes('r0 = textureSample(tex0, samp0, in.t0.xy);'),
            'the four-channel texture is read as it always was');
        assert.ok(pixels[1].includes(
            `r0 = ${fillsTwo('textureSample(tex0, samp0, in.t0.xy)')};`), pixels[1]);
        assert.equal(h.device.diagnostics().programs.built, 2);

        h.device.SetTexture(0, null);
        h.device.SetVertexShader(null);
        h.device.SetPixelShader(null);
        vs.shader.release();
        ps.shader.release();
        narrow.release();
    });

test('a ps_1_1 read and a pixel shader over fixed vertices fill a narrow texture alike',
    async()=>{
        const h = harness();
        /** @type {{ shader?: any }} */
        const vs = {};
        /** @type {{ shader?: any }} */
        const legacy = {};
        /** @type {{ shader?: any }} */
        const ps = {};
        assert.equal(h.device.CreateVertexShader(VERTEX_SHADER, vs), D3D_OK);
        // tex t0; mov r0, t0
        assert.equal(h.device.CreatePixelShader([versionToken(SHADER_KIND.PIXEL, 1, 1),
            0x00000042, 0xb00f0000, 0x00000001, 0x800f0000, 0xb0e40000, END_TOKEN], legacy),
        D3D_OK);
        assert.equal(h.device.CreatePixelShader(PIXEL_SHADER, ps), D3D_OK);
        const single = narrowTexture(h, D3DFMT.R32F);
        const pair = narrowTexture(h, D3DFMT.G16R16);
        assert.equal(h.device.BeginScene(), D3D_OK);
        h.device.SetVertexShader(vs.shader);
        h.device.SetPixelShader(legacy.shader);
        h.device.SetTexture(0, single);
        assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        // The hybrid: the fixed vertex stage made for a pixel shader.
        h.device.SetVertexShader(null);
        h.device.SetPixelShader(ps.shader);
        h.device.SetTexture(0, pair);
        assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        assert.equal(h.device.EndScene(), D3D_OK);
        assert.equal(h.device.Present(), D3D_OK);
        await h.device.idle();
        assert.deepEqual(h.reports.filter(report=>!report.includes(' is kept ')), []);

        const pixels = modulesOf(h, 'ps:');
        assert.equal(pixels.length, 2);
        assert.ok(pixels[0].includes(
            `t0 = ${fillsOne('textureSample(tex0, samp0, in.t0.xy)')};`), pixels[0]);
        assert.ok(pixels[1].includes(
            `r0 = ${fillsTwo('textureSample(tex0, samp0, in.t0.xy)')};`), pixels[1]);

        h.device.SetTexture(0, null);
        h.device.SetPixelShader(null);
        vs.shader.release();
        legacy.shader.release();
        ps.shader.release();
        single.release();
        pair.release();
    });

test('a vertex shader\'s texldl of a one-channel texture reads green and blue as one', async()=>{
    const h = harness({ model: 3 });
    const output = (/** @type {number} */ usage, /** @type {number} */ register)=>[
        op(OPCODE.DCL, 2), (0x80000000 | usage) >>> 0, dst(REGISTER.OUTPUT, register)];
    /** @type {{ shader?: any }} */
    const vs = {};
    /** @type {{ shader?: any }} */
    const ps = {};
    assert.equal(h.device.CreateVertexShader([
        versionToken(SHADER_KIND.VERTEX, 3, 0),
        ...dclInput(D3DDECLUSAGE.POSITION, 0),
        ...output(D3DDECLUSAGE.POSITION, 0),
        ...output(D3DDECLUSAGE.TEXCOORD, 1),
        ...output(D3DDECLUSAGE.COLOR, 2),
        op(OPCODE.DCL, 2), (2 << 27) >>> 0, dst(REGISTER.SAMPLER, 0),
        op(OPCODE.TEXLDL, 3), dst(REGISTER.OUTPUT, 2), src(REGISTER.INPUT, 0),
        src(REGISTER.SAMPLER, 0),
        op(OPCODE.MOV, 2), dst(REGISTER.OUTPUT, 0), src(REGISTER.INPUT, 0),
        op(OPCODE.MOV, 2), dst(REGISTER.OUTPUT, 1), src(REGISTER.INPUT, 0),
        END_TOKEN,
    ], vs), D3D_OK);
    assert.equal(h.device.CreatePixelShader(PIXEL_SHADER, ps), D3D_OK);
    h.device.SetVertexShader(vs.shader);
    h.device.SetPixelShader(ps.shader);
    const heights = narrowTexture(h, D3DFMT.R16F, 4);
    assert.equal(h.device.SetTexture(0, h.texture), D3D_OK);
    assert.equal(h.device.SetTexture(257, heights), D3D_OK);
    await h.draw();
    assert.deepEqual(h.reports.filter(report=>!report.includes(' is kept ')), []);

    const [vertex] = modulesOf(h, 'vs:');
    assert.ok(vertex.includes(fillsOne('textureSampleLevel(tex0, samp0, v0.xy, v0.w)')), vertex);
    const [pixel] = modulesOf(h, 'ps:');
    assert.ok(pixel.includes('r0 = textureSample(tex0, samp0, in.t0.xy);'),
        'the pixel stage\'s own texture has four');

    h.device.SetTexture(0, null);
    h.device.SetTexture(257, null);
    h.device.SetVertexShader(null);
    h.device.SetPixelShader(null);
    vs.shader.release();
    ps.shader.release();
    heights.release();
});

test('the fixed pixel stage over a vertex shader fills a narrow texture, and is made again for it',
    async()=>{
        const h = harness();
        /** @type {{ shader?: any }} */
        const vs = {};
        assert.equal(h.device.CreateVertexShader(TEXTURED_VERTEX_SHADER, vs), D3D_OK);
        h.device.SetVertexShader(vs.shader);
        const narrow = narrowTexture(h, D3DFMT.G32R32F);
        assert.equal(h.device.BeginScene(), D3D_OK);
        for (const texture of [h.texture, narrow, h.texture])
        {
            h.device.SetTexture(0, texture);
            assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        }
        assert.deepEqual(h.device.diagnostics().prepared, { built: 2, reused: 1 },
            'the narrow texture is a fragment stage of its own, the first one kept');
        assert.equal(h.device.EndScene(), D3D_OK);
        assert.equal(h.device.Present(), D3D_OK);
        await h.device.idle();
        assert.deepEqual(h.reports.filter(report=>!report.includes(' is kept ')), []);
        const fragments = modulesOf(h, 'ps:');
        assert.equal(fragments.length, 2);
        assert.ok(fragments[0].includes(
            'return textureSampleLevel(texture0, sampler0, uv, level);'));
        assert.ok(fragments[1].includes(
            `return ${fillsTwo('textureSampleLevel(texture0, sampler0, uv, level)')};`),
        fragments[1]);
        h.device.SetTexture(0, null);
        h.device.SetVertexShader(null);
        vs.shader.release();
        narrow.release();
    });

test('a sampler\'s level-of-detail bias reaches the reads of a shader pair and of the fixed stages',
    async()=>{
        const h = harness();
        /** @type {{ shader?: any }} */
        const vs = {};
        /** @type {{ shader?: any }} */
        const ps = {};
        assert.equal(h.device.CreateVertexShader(VERTEX_SHADER, vs), D3D_OK);
        assert.equal(h.device.CreatePixelShader(PIXEL_SHADER, ps), D3D_OK);
        h.device.SetTexture(0, h.texture);
        assert.equal(h.device.BeginScene(), D3D_OK);
        h.device.SetVertexShader(vs.shader);
        h.device.SetPixelShader(ps.shader);
        for (const bias of [0, -0.5, 0])
        {
            // D3DSAMP_MIPMAPLODBIAS.
            assert.equal(h.device.SetSamplerState(0, 8, floatToDword(bias)), D3D_OK);
            assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        }
        h.device.SetVertexShader(vs.shader);
        h.device.SetPixelShader(null);
        assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        assert.equal(h.device.SetSamplerState(0, 8, floatToDword(-0.5)), D3D_OK);
        assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        assert.equal(h.device.EndScene(), D3D_OK);
        assert.equal(h.device.Present(), D3D_OK);
        await h.device.idle();
        assert.deepEqual(h.reports, []);
        const pixels = modulesOf(h, 'ps:');
        assert.equal(pixels.length, 4, 'a translation and a fixed stage each with the bias and'
            + ' without; the draw back at zero shares the first');
        assert.ok(pixels[0].includes('textureSample(tex0, samp0, in.t0.xy)'));
        assert.ok(pixels[1].includes('textureSampleBias(tex0, samp0, in.t0.xy, -0.5)'));
        assert.ok(!pixels[2].includes(' + -0.5'));
        assert.ok(pixels[3].includes('1.0e-12)) + -0.5,'), pixels[3]);
        h.device.SetTexture(0, null);
        h.device.SetVertexShader(null);
        vs.shader.release();
        ps.shader.release();
    });

test('a border and a mirror-once axis reach a shader pair\'s reads and the fixed stages, clamped',
    async()=>{
        const h = harness();
        /** @type {{ shader?: any }} */
        const vs = {};
        /** @type {{ shader?: any }} */
        const ps = {};
        assert.equal(h.device.CreateVertexShader(VERTEX_SHADER, vs), D3D_OK);
        assert.equal(h.device.CreatePixelShader(PIXEL_SHADER, ps), D3D_OK);
        h.device.SetTexture(0, h.texture);
        // D3DSAMP_ADDRESSU BORDER, ADDRESSV MIRRORONCE, D3DSAMP_BORDERCOLOR.
        assert.equal(h.device.SetSamplerState(0, 1, 4), D3D_OK);
        assert.equal(h.device.SetSamplerState(0, 2, 5), D3D_OK);
        assert.equal(h.device.SetSamplerState(0, 4, 0xff00ff00), D3D_OK);
        assert.equal(h.device.BeginScene(), D3D_OK);
        h.device.SetVertexShader(vs.shader);
        h.device.SetPixelShader(ps.shader);
        assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        h.device.SetPixelShader(null);
        assert.equal(h.device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        assert.equal(h.device.EndScene(), D3D_OK);
        assert.equal(h.device.Present(), D3D_OK);
        await h.device.idle();
        assert.deepEqual(h.reports, []);
        const [translated, fixed] = modulesOf(h, 'ps:');
        assert.ok(translated.includes('select(textureSampleGrad(tex0, samp0, vec2f((in.t0.xy).x,'
            + ' abs((in.t0.xy).y)), dpdx(in.t0.xy), dpdy(in.t0.xy)), vec4f(0.0, 1.0, 0.0, 1.0),'
            + ' (in.t0.xy).x < 0.0 || (in.t0.xy).x > 1.0)'), translated);
        assert.ok(fixed.includes('addressCoordinate(abs(raw.y), (flags >> 2u) & 3u,'));
        assert.ok(fixed.includes('vec4f(0.0, 1.0, 0.0, 1.0), raw.x < 0.0 || raw.x > 1.0)'));
        const programSampler = h.gpu.device.calls
            .filter((/** @type {any} */ call)=>call.op === 'createBindGroup')
            .flatMap((/** @type {any} */ call)=>call.descriptor.entries)
            .map((/** @type {any} */ entry)=>entry.resource)
            .find((/** @type {any} */ resource)=>resource?.kind === 'sampler'
                && resource.descriptor.addressModeV !== 'repeat');
        assert.deepEqual([programSampler?.descriptor.addressModeU,
            programSampler?.descriptor.addressModeV], ['clamp-to-edge', 'clamp-to-edge'],
        'the GPU sampler clamps, and the shader folds and selects');
        h.device.SetTexture(0, null);
        h.device.SetVertexShader(null);
        vs.shader.release();
        ps.shader.release();
    });

test('a stage writes the temporary register and reads its own constant, which its block carries',
    async()=>{
        // D3DTSS_RESULTARG (28) D3DTA_TEMP; D3DTSS_CONSTANT (32), read as D3DTA_CONSTANT (6).
        const h = harness();
        h.device.SetTexture(0, null);
        const set = (/** @type {number} */ stage, /** @type {number} */ state,
            /** @type {number} */ value)=>assert.equal(
            h.device.SetTextureStageState(stage, state, value), D3D_OK);
        set(0, D3DTSS.COLOROP, 2);
        set(0, D3DTSS.COLORARG1, 6);
        set(0, D3DTSS.ALPHAOP, 2);
        set(0, D3DTSS.ALPHAARG1, 6);
        set(0, 28, 5);
        set(0, 32, 0x80402010);
        set(1, D3DTSS.COLOROP, 7);
        set(1, D3DTSS.COLORARG1, 1);
        set(1, D3DTSS.COLORARG2, 5);
        set(1, D3DTSS.ALPHAOP, 2);
        set(1, D3DTSS.ALPHAARG1, 1);
        set(1, 32, 0xff00ff00);
        /** @type {{ passes?: number }} */
        const validated = {};
        assert.equal(h.device.ValidateDevice(validated), D3D_OK, 'the combiner draws both');
        await h.draw();
        assert.deepEqual(h.reports, []);
        const [fragment] = modulesOf(h, 'fixed-function:');
        assert.ok(fragment.includes('    temp = vec4f(saturate((uniforms.stageConstant[0]).rgb),'));
        assert.ok(fragment.includes('    current = vec4f(saturate((current + temp).rgb),'));
        const floats = new Float32Array(h.boundBytes(h.groupsOfDraw().get(0), 0).buffer);
        assert.equal(floats.length, UNIFORM_FLOATS + 32, 'every stage\'s constant past the block');
        assert.deepEqual([...floats.subarray(UNIFORM_FLOATS, UNIFORM_FLOATS + 8)],
            [0x40, 0x20, 0x10, 0x80, 0, 0xff, 0, 0xff].map(byte=>Math.fround(byte / 255)));
    });
