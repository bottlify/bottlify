/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Two kinds of test, kept apart on purpose, the way the other Direct3D
 * renderers keep them.
 *
 * **Byte-exact.** What this engine computes itself -- the clear colour, the
 * vertices it put on the queue, the viewport mapping -- is evaluated on the
 * processor with the software reference in `webgpu/internal/reference.js` and
 * a rasteriser here, and compared byte for byte against a stored image. No
 * tolerance. The pixel shader's colour is a constant the test knows; nothing
 * here runs a shader, so a shader that computes its colour is out of reach of
 * this kind of test and is pinned by the translator's tests instead.
 *
 * **Recorded commands.** What a GPU would do is checked by what it was asked
 * to do -- which pass, which pipeline with which descriptor, which bind group
 * entries, which draw -- through the recording device in
 * `webgpu/internal/fake-device.js`. Nothing here judges a frame by looking.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3D10_BIND, D3D10_CLEAR, D3D10_CPU_ACCESS, D3D10_DRIVER_TYPE, D3D10_FILTER, D3D10_MAP,
    D3D10_PRIMITIVE_TOPOLOGY, D3D10_QUERY, D3D10_RESOURCE_MISC, D3D10_SDK_VERSION,
    D3D10_TEXTURE_ADDRESS, D3D10_USAGE, DXGI_FORMAT, S_FALSE, S_OK,
} from './constants.js';
import { D3D10_ASYNC_GETDATA_DONOTFLUSH } from './queries.js';
import { D3D10CreateDeviceAndSwapChain } from './device.js';
import { defaultSwapChainDesc } from './dxgi.js';
import { RESOURCE_DIMENSION, RETURN_TYPE } from './sm4.js';
import { SHADER_KIND, SYSTEM_VALUE } from './dxbc.js';
import {
    assemble, cb, dclConstantBuffer, dclInputPs, dclOutput, dclResource, dclSampler, ld, mov, o,
    passThroughVertexShader, r, ret, s, sample, solidPixelShader, t, v,
} from './shader-fixtures.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import {
    clear as referenceClear, createReferenceSurface, toBase64,
} from '../webgpu/internal/reference.js';

/**
 * A device with a backend over the recording GPU, and a swap chain to present.
 *
 * @param {{ width?: number, height?: number }} [options]
 */
function harness(options = {}){
    const gpu = createFakeDevice();
    /** @type {any[]} */
    const presented = [];
    /** @type {string[]} */
    const divergences = [];
    const backend = createBackend({
        device: gpu.device,
        queue: gpu.queue,
        presentTo: frame=>presented.push(frame),
        now: ()=>0,
    });
    const desc = defaultSwapChainDesc();
    desc.bufferDesc.width = options.width ?? 8;
    desc.bufferDesc.height = options.height ?? 8;
    desc.outputWindow = 0x1234;
    /** @type {{ device?: any }} */
    const deviceOut = {};
    /** @type {{ swapChain?: any }} */
    const chainOut = {};
    assert.equal(D3D10CreateDeviceAndSwapChain(null, D3D10_DRIVER_TYPE.HARDWARE, null, 0,
        D3D10_SDK_VERSION, desc, chainOut, deviceOut, {
            backend,
            createSampler: descriptor=>({ kind: 'sampler', descriptor }),
            createTexture: gpu.device.createTexture,
            divergence: (api, detail)=>divergences.push(`${api}: ${detail}`),
        }), S_OK);
    const device = deviceOut.device;
    const swapChain = chainOut.swapChain;
    /** @type {{ buffer?: any }} */
    const held = {};
    assert.equal(swapChain.GetBuffer(0, '{9B7E4C04-342C-4106-A19F-4F2704F689F0}', held), S_OK);
    const backBuffer = held.buffer;
    /** @type {{ view?: any }} */
    const view = {};
    assert.equal(device.CreateRenderTargetView(backBuffer, null, view), S_OK);

    return {
        gpu,
        backend,
        presented,
        divergences,
        device,
        swapChain,
        backBuffer,
        renderTargetView: view.view,
        width: desc.bufferDesc.width,
        height: desc.bufferDesc.height,
        /** Presents and waits for the frame to reach the queue. */
        async present(){
            assert.equal(swapChain.Present(0, 0), S_OK);
            await device.idle();
        },
    };
}

/** @param {number[]} floats */
const floatBytes = floats=>new Uint8Array(Float32Array.from(floats).buffer);

/**
 * Whether some divergence names the call. Read through a function so that an
 * earlier `deepEqual([], ...)` in the same test cannot narrow the list to
 * nothing for the checker.
 *
 * @param {ReturnType<typeof harness>} h
 * @param {string} call
 */
const diverged = (h, call)=>{
    /** @type {string[]} */
    const lines = h.divergences;
    return lines.some(line=>line.includes(call));
};

const POSITION_ELEMENT = Object.freeze({
    SemanticName: 'POSITION',
    SemanticIndex: 0,
    Format: DXGI_FORMAT.R32G32B32A32_FLOAT,
    InputSlot: 0,
    AlignedByteOffset: 0,
    InputSlotClass: 0,
    InstanceDataStepRate: 0,
});

/**
 * Binds everything a triangle needs: the vertices given, the pass-through
 * vertex shader, a solid pixel shader, a full viewport.
 *
 * @param {ReturnType<typeof harness>} h
 * @param {number[][]} clipPositions  x, y, z, w per vertex.
 * @param {number[]} rgba
 */
function bindTriangle(h, clipPositions, rgba){
    const { device } = h;
    /** @type {{ resource?: any }} */
    const vertices = {};
    assert.equal(device.CreateBuffer({
        ByteWidth: clipPositions.length * 16,
        Usage: D3D10_USAGE.IMMUTABLE,
        BindFlags: D3D10_BIND.VERTEX_BUFFER,
        CPUAccessFlags: 0,
        MiscFlags: 0,
    }, { pSysMem: floatBytes(clipPositions.flat()) }, vertices), S_OK);
    /** @type {{ layout?: any }} */
    const layout = {};
    assert.equal(device.CreateInputLayout([POSITION_ELEMENT], passThroughVertexShader(), layout),
        S_OK);
    /** @type {{ shader?: any }} */
    const vs = {};
    /** @type {{ shader?: any }} */
    const ps = {};
    assert.equal(device.CreateVertexShader(passThroughVertexShader(), vs), S_OK);
    assert.equal(device.CreatePixelShader(solidPixelShader(rgba), ps), S_OK);

    device.IASetInputLayout(layout.layout);
    device.IASetVertexBuffers(0, [vertices.resource], [16], [0]);
    device.IASetPrimitiveTopology(D3D10_PRIMITIVE_TOPOLOGY.TRIANGLELIST);
    device.VSSetShader(vs.shader);
    device.PSSetShader(ps.shader);
    device.RSSetViewports([{
        TopLeftX: 0, TopLeftY: 0, Width: h.width, Height: h.height, MinDepth: 0, MaxDepth: 1,
    }]);
    device.OMSetRenderTargets([h.renderTargetView], null);
    return { vertices: vertices.resource, layout: layout.layout, vs: vs.shader, ps: ps.shader };
}

/**
 * The bytes the queue received for a buffer: the last write that covered it.
 *
 * @param {ReturnType<typeof harness>} h
 * @param {any} gpu
 */
function queuedBytes(h, gpu){
    const writes = h.gpu.of('writeBuffer').filter((/** @type {any} */ call)=>call.buffer === gpu);
    assert.ok(writes.length > 0, 'the buffer reached the queue');
    return writes[writes.length - 1].bytes;
}

/** @param {import('../webgpu/internal/reference.js').ReferenceSurface} surface @param {number} x @param {number} y */
const pixelAt = (surface, x, y)=>
    [...surface.bytes.subarray((y * surface.width + x) * 4, (y * surface.width + x) * 4 + 4)];

/**
 * A triangle over pixel centres, the top-left rule for a centre exactly on an
 * edge. The test data never puts a centre on an edge, so the rule is stated
 * rather than exercised.
 *
 * @param {import('../webgpu/internal/reference.js').ReferenceSurface} surface
 * @param {{ x: number, y: number }[]} points  In pixels.
 * @param {{ r: number, g: number, b: number, a: number }} colour
 */
function fillTriangle(surface, points, colour){
    const [a, b, c] = points;
    /** @param {{x:number,y:number}} p @param {{x:number,y:number}} q @param {number} x @param {number} y */
    const edge = (p, q, x, y)=>(q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x);
    const area = edge(a, b, c.x, c.y);
    for (let y = 0; y < surface.height; y++)
    {
        for (let x = 0; x < surface.width; x++)
        {
            const px = x + 0.5;
            const py = y + 0.5;
            const w0 = edge(b, c, px, py) * Math.sign(area);
            const w1 = edge(c, a, px, py) * Math.sign(area);
            const w2 = edge(a, b, px, py) * Math.sign(area);
            if (w0 > 0 && w1 > 0 && w2 > 0)
            {
                const at = (y * surface.width + x) * 4;
                surface.bytes[at] = colour.b;
                surface.bytes[at + 1] = colour.g;
                surface.bytes[at + 2] = colour.r;
                surface.bytes[at + 3] = colour.a;
            }
        }
    }
}

/**
 * The software evaluation of the last frame: the clear from the record, and
 * every triangle from the vertices that reached the queue, mapped through the
 * viewport as the rasteriser would.
 *
 * @param {ReturnType<typeof harness>} h
 * @param {number[]} rgba  The pixel shader's constant, 0..1 each.
 */
function rasterise(h, rgba){
    const surface = createReferenceSurface(h.width, h.height);
    for (const command of h.device.diagnostics().lastFrame)
    {
        if (command.kind === 'clear')
        {
            referenceClear(surface, {
                r: Math.round(command.color[0] * 255),
                g: Math.round(command.color[1] * 255),
                b: Math.round(command.color[2] * 255),
            });
            continue;
        }
        if (command.kind !== 'draw')
        {
            continue;
        }
        assert.equal(command.topology, 'triangle-list', 'the evaluator knows one topology');
        assert.equal(command.indexCount, null, 'and non-indexed draws only');
        const stream = command.vertexBuffers[0];
        assert.equal(stream.stride, 16, 'and one vertex format: a float4 position');
        const bytes = queuedBytes(h, stream.gpu);
        const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
        const viewport = command.viewport;
        /** @param {number} index */
        const point = index=>{
            const at = (stream.offset / 16 + command.startVertex + index) * 4;
            const w = floats[at + 3];
            return {
                x: viewport.x + (floats[at] / w * 0.5 + 0.5) * viewport.width,
                y: viewport.y + (0.5 - floats[at + 1] / w * 0.5) * viewport.height,
            };
        };
        for (let first = 0; first < command.vertexCount; first += 3)
        {
            fillTriangle(surface, [point(first), point(first + 1), point(first + 2)], {
                r: Math.round(rgba[0] * 255),
                g: Math.round(rgba[1] * 255),
                b: Math.round(rgba[2] * 255),
                a: Math.round(rgba[3] * 255),
            });
        }
    }
    return surface;
}

// --- the first frame ---

test('byte-exact: a cleared back buffer is that colour in every pixel', async()=>{
    const h = harness({ width: 4, height: 4 });
    h.device.OMSetRenderTargets([h.renderTargetView], null);
    // Channels all different, so a channel swap cannot hide in grey.
    h.device.ClearRenderTargetView(h.renderTargetView, [0.2, 0.4, 0.6, 1]);
    await h.present();

    const surface = rasterise(h, [0, 0, 0, 0]);
    assert.deepEqual(pixelAt(surface, 0, 0), [153, 102, 51, 255]);
    assert.deepEqual(pixelAt(surface, 3, 3), [153, 102, 51, 255]);
    assert.equal(toBase64(surface),
        'mWYz/5lmM/+ZZjP/mWYz/5lmM/+ZZjP/mWYz/5lmM/+ZZjP/mWYz/5lmM/+ZZjP/mWYz/5lmM/+ZZjP/mWYz/w==');
});

test('recorded: a clear and a present are one pass that clears and one submit', async()=>{
    const h = harness();
    h.device.ClearRenderTargetView(h.renderTargetView, [0.2, 0.4, 0.6, 1]);
    await h.present();

    const passes = h.gpu.of('beginRenderPass');
    assert.equal(passes.length, 1);
    const attachment = passes[0].descriptor.colorAttachments[0];
    assert.equal(attachment.loadOp, 'clear');
    assert.deepEqual(attachment.clearValue, { r: 0.2, g: 0.4, b: 0.6, a: 1 });
    assert.equal(h.gpu.count('submit'), 1);
    assert.equal(h.presented.length, 1);
    assert.equal(h.presented[0].surface.texture, attachment.view.texture,
        'the frame shown is the texture the pass cleared');
    assert.equal(h.presented[0].surface.format, 'rgba8unorm');
    assert.equal(h.presented[0].surface.width, 8);
    assert.deepEqual(h.divergences, []);
    const diagnostics = h.device.diagnostics();
    assert.equal(diagnostics.frames, 1);
    assert.equal(diagnostics.clears, 1);
    assert.deepEqual(diagnostics.failures, []);
});

test('a frame that draws nothing and clears nothing still presents', async()=>{
    const h = harness();
    await h.present();
    assert.equal(h.gpu.count('beginRenderPass'), 0);
    assert.equal(h.gpu.count('submit'), 1);
    assert.equal(h.presented.length, 1);
});

// --- a triangle ---

/** Corners at pixels (1,1), (7,1) and (1,5) of an 8x8 target; no centre on an edge. */
const TRIANGLE = [
    [-0.75, 0.75, 0.5, 1],
    [0.75, 0.75, 0.5, 1],
    [-0.75, -0.25, 0.5, 1],
];

test('byte-exact: a triangle from an immutable buffer covers the pixels it names', async()=>{
    const h = harness();
    bindTriangle(h, TRIANGLE, [0, 0, 1, 1]);
    h.device.ClearRenderTargetView(h.renderTargetView, [0.2, 0.4, 0.6, 1]);
    h.device.Draw(3, 0);
    await h.present();

    assert.deepEqual(h.divergences, []);
    const surface = rasterise(h, [0, 0, 1, 1]);
    assert.deepEqual(pixelAt(surface, 1, 1), [255, 0, 0, 255], 'the corner is covered');
    assert.deepEqual(pixelAt(surface, 5, 1), [255, 0, 0, 255], 'and the far end of the top leg');
    assert.deepEqual(pixelAt(surface, 1, 4), [255, 0, 0, 255], 'and of the left leg');
    assert.deepEqual(pixelAt(surface, 6, 1), [153, 102, 51, 255], 'past the sloped edge');
    assert.deepEqual(pixelAt(surface, 1, 5), [153, 102, 51, 255], 'below the last row');
    assert.deepEqual(pixelAt(surface, 0, 1), [153, 102, 51, 255], 'left of the vertical edge');
    assert.equal(toBase64(surface),
        'mWYz/5lmM/+ZZjP/mWYz/5lmM/+ZZjP/mWYz/5lmM/+ZZjP//wAA//8AAP//AAD//wAA//8AAP+ZZjP/mWYz/5'
        + 'lmM///AAD//wAA//8AAP//AAD/mWYz/5lmM/+ZZjP/mWYz//8AAP//AAD/mWYz/5lmM/+ZZjP/mWYz/5lmM/+Z'
        + 'ZjP//wAA/5lmM/+ZZjP/mWYz/5lmM/+ZZjP/mWYz/5lmM/+ZZjP/mWYz/5lmM/+ZZjP/mWYz/5lmM/+ZZjP/mW'
        + 'Yz/5lmM/+ZZjP/mWYz/5lmM/+ZZjP/mWYz/5lmM/+ZZjP/mWYz/5lmM/+ZZjP/mWYz/5lmM/+ZZjP/mWYz/w==',
        'the whole image: the clear, and the triangle over the pixels the reference covers');
});

test('recorded: the triangle is one pipeline, its state, and one draw', async()=>{
    const h = harness();
    const bound = bindTriangle(h, TRIANGLE, [0, 0, 1, 1]);
    h.device.ClearRenderTargetView(h.renderTargetView, [0.2, 0.4, 0.6, 1]);
    h.device.Draw(3, 0);
    await h.present();

    const pipelines = h.gpu.of('createRenderPipeline');
    assert.equal(pipelines.length, 1);
    const descriptor = pipelines[0].descriptor;
    assert.deepEqual(descriptor.vertex.buffers, [{
        arrayStride: 16,
        stepMode: 'vertex',
        attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }],
    }]);
    assert.equal(descriptor.vertex.entryPoint, 'vertexMain');
    assert.equal(descriptor.fragment.entryPoint, 'fragmentMain');
    assert.deepEqual(descriptor.fragment.targets, [{ format: 'rgba8unorm', writeMask: 0xf }]);
    assert.deepEqual(descriptor.primitive,
        { topology: 'triangle-list', cullMode: 'back', frontFace: 'cw' });
    assert.equal(descriptor.depthStencil, undefined, 'no depth target was bound');
    assert.deepEqual(descriptor.multisample,
        { count: 1, mask: 0xffffffff, alphaToCoverageEnabled: false });
    assert.equal(descriptor.layout.descriptor.bindGroupLayouts.length, 2, 'one group per stage');

    const modules = h.gpu.of('createShaderModule');
    assert.equal(modules.length, 2);
    assert.match(modules[0].descriptor.code, /@vertex fn vertexMain/);
    assert.match(modules[1].descriptor.code, /o0 = vec4<u32>\(0u, 0u, 1065353216u, 1065353216u\);/);

    const passes = h.gpu.of('beginRenderPass');
    assert.equal(passes.length, 1, 'the clear and the draw share a pass');
    assert.equal(passes[0].descriptor.colorAttachments[0].loadOp, 'clear');
    assert.deepEqual(h.gpu.of('setViewport')[0].rect, [0, 0, 8, 8, 0, 1]);
    const vertexBuffers = h.gpu.of('setVertexBuffer');
    assert.equal(vertexBuffers.length, 1);
    assert.equal(vertexBuffers[0].slot, 0);
    assert.equal(vertexBuffers[0].offset, 0);
    assert.deepEqual([...queuedBytes(h, vertexBuffers[0].buffer)],
        [...floatBytes(TRIANGLE.flat())], 'the program\'s vertices are what the queue got');
    assert.deepEqual(h.gpu.of('draw').map((/** @type {any} */ call)=>call.args), [[3, 1, 0, 0]]);
    assert.equal(h.device.diagnostics().draws, 1);

    // Everything made is released, and the device with it.
    h.device.IASetInputLayout(null);
    for (const object of [bound.vertices, bound.layout, bound.vs, bound.ps])
    {
        assert.equal(object.release(), 0);
    }
});

test('a second frame with the same state reuses the pipeline and draws again', async()=>{
    const h = harness();
    bindTriangle(h, TRIANGLE, [0, 0, 1, 1]);
    h.device.Draw(3, 0);
    await h.present();
    h.device.Draw(3, 0);
    await h.present();
    assert.equal(h.gpu.count('createRenderPipeline'), 1);
    assert.equal(h.gpu.count('draw'), 2);
    assert.equal(h.gpu.count('submit'), 2);
    assert.equal(h.device.diagnostics().pipelines, 1);
});

test('a draw with no viewport, no target or no shader draws nothing and is counted', async()=>{
    const h = harness();
    bindTriangle(h, TRIANGLE, [1, 0, 0, 1]);
    h.device.RSSetViewports([]);
    h.device.Draw(3, 0);
    h.device.RSSetViewports([{
        TopLeftX: 0, TopLeftY: 0, Width: 8, Height: 8, MinDepth: 0, MaxDepth: 1,
    }]);
    h.device.PSSetShader(null);
    h.device.Draw(3, 0);
    h.device.OMSetRenderTargets([], null);
    h.device.Draw(3, 0);
    await h.present();
    assert.equal(h.gpu.count('draw'), 0);
    assert.deepEqual(h.device.diagnostics().skipped,
        { noViewport: 1, noTarget: 1, noShader: 1, untranslatable: 0, pipeline: 0 });
});

// --- constant buffers ---

test('a dynamic constant buffer is mapped, written, and bound at the draw', async()=>{
    const h = harness();
    const { device } = h;
    bindTriangle(h, TRIANGLE, [0, 0, 1, 1]);
    // A pixel shader whose colour is the first register of cb0.
    /** @type {{ shader?: any }} */
    const ps = {};
    assert.equal(device.CreatePixelShader(assemble({
        kind: SHADER_KIND.PIXEL,
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
        instructions: [dclConstantBuffer(0, 1), dclOutput(o(0)), mov(o(0), cb(0, 0)), ret()],
    }), ps), S_OK);
    device.PSSetShader(ps.shader);

    /** @type {{ resource?: any }} */
    const constants = {};
    assert.equal(device.CreateBuffer({
        ByteWidth: 16,
        Usage: D3D10_USAGE.DYNAMIC,
        BindFlags: D3D10_BIND.CONSTANT_BUFFER,
        CPUAccessFlags: D3D10_CPU_ACCESS.WRITE,
        MiscFlags: 0,
    }, null, constants), S_OK);
    const buffer = constants.resource;
    /** @type {{ data?: Uint8Array | null }} */
    const mapped = {};
    assert.equal(buffer.Map(0, D3D10_MAP.WRITE_DISCARD, 0, mapped), S_OK);
    assert.ok(mapped.data);
    mapped.data.set(floatBytes([1, 0.5, 0, 1]));
    buffer.Unmap(0);
    device.PSSetConstantBuffers(0, [buffer]);
    device.Draw(3, 0);
    await h.present();

    assert.deepEqual(h.divergences, []);
    const layouts = h.gpu.of('createBindGroupLayout');
    const fragmentLayout = layouts.find((/** @type {any} */ call)=>
        call.descriptor.label === 'd3d10:ps');
    assert.deepEqual(fragmentLayout.descriptor.entries,
        [{ binding: 0, visibility: 2, buffer: { type: 'uniform' } }]);
    const groups = h.gpu.of('createBindGroup');
    const fragmentGroup = groups.find((/** @type {any} */ call)=>
        call.descriptor.layout === fragmentLayout.createBindGroupLayout);
    assert.ok(fragmentGroup, 'the pixel stage got a group');
    const entry = fragmentGroup.descriptor.entries[0];
    assert.equal(entry.binding, 0);
    assert.equal(entry.resource.size, 16);
    assert.deepEqual([...queuedBytes(h, entry.resource.buffer)], [...floatBytes([1, 0.5, 0, 1])],
        'the bytes written through the map are the ones the draw reads');
    assert.deepEqual(h.gpu.of('setBindGroup').map((/** @type {any} */ call)=>call.index), [0, 1]);
});

test('a discard map between two draws renames the buffer, so each draw keeps its bytes',
    async()=>{
        const h = harness();
        const { device } = h;
        bindTriangle(h, TRIANGLE, [0, 0, 1, 1]);
        /** @type {{ resource?: any }} */
        const constants = {};
        assert.equal(device.CreateBuffer({
            ByteWidth: 16,
            Usage: D3D10_USAGE.DYNAMIC,
            BindFlags: D3D10_BIND.CONSTANT_BUFFER,
            CPUAccessFlags: D3D10_CPU_ACCESS.WRITE,
            MiscFlags: 0,
        }, null, constants), S_OK);
        const buffer = constants.resource;
        device.VSSetConstantBuffers(0, [buffer]);
        /** @type {{ data?: Uint8Array | null }} */
        const mapped = {};
        assert.equal(buffer.Map(0, D3D10_MAP.WRITE_DISCARD, 0, mapped), S_OK);
        /** @type {Uint8Array} */ (mapped.data).fill(1);
        buffer.Unmap(0);
        device.Draw(3, 0);
        assert.equal(buffer.Map(0, D3D10_MAP.WRITE_DISCARD, 0, mapped), S_OK);
        /** @type {Uint8Array} */ (mapped.data).fill(2);
        buffer.Unmap(0);
        device.Draw(3, 0);
        await h.present();

        // Neither draw's shader reads cb0, so no group names the buffer; the
        // renames themselves are what the backend was asked for.
        const backing = h.backend.diagnostics().buffers.find((/** @type {any} */ entry)=>
            entry.label.startsWith('d3d10:buffer#16'));
        assert.ok(backing);
        assert.equal(backing.renames, 2, 'one rename per discard');
        assert.equal(h.gpu.count('draw'), 2);
    });

// --- textures ---

const TEXTURE_2X2 = Object.freeze({
    Width: 2,
    Height: 2,
    MipLevels: 1,
    ArraySize: 1,
    Format: DXGI_FORMAT.R8G8B8A8_UNORM,
    SampleDesc: { Count: 1, Quality: 0 },
    Usage: D3D10_USAGE.DEFAULT,
    BindFlags: D3D10_BIND.SHADER_RESOURCE,
    CPUAccessFlags: 0,
    MiscFlags: 0,
});

/** Four texels, each channel distinct. */
const TEXELS = Uint8Array.from([
    255, 0, 0, 255, 0, 255, 0, 255,
    0, 0, 255, 255, 255, 255, 255, 255,
]);

test('a texture with initial data is uploaded, and a draw binds its view and sampler',
    async()=>{
        const h = harness();
        const { device } = h;
        bindTriangle(h, TRIANGLE, [0, 0, 1, 1]);
        /** @type {{ shader?: any }} */
        const ps = {};
        assert.equal(device.CreatePixelShader(assemble({
            kind: SHADER_KIND.PIXEL,
            inputs: [{ name: 'TEXCOORD', register: 0 }],
            outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
            instructions: [
                dclResource(0, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.FLOAT), dclSampler(0),
                dclInputPs(v(0)), dclOutput(o(0)), sample(o(0), v(0, 'xy'), t(0), s(0)), ret(),
            ],
        }), ps), S_OK);
        device.PSSetShader(ps.shader);

        /** @type {{ resource?: any }} */
        const texture = {};
        assert.equal(device.CreateTexture2D(TEXTURE_2X2, [{ pSysMem: TEXELS, SysMemPitch: 8 }],
            texture), S_OK);
        const uploads = h.gpu.of('writeTexture');
        assert.equal(uploads.length, 1, 'uploaded on creation');
        assert.deepEqual([...uploads[0].bytes], [...TEXELS]);
        assert.deepEqual(uploads[0].layout, { offset: 0, bytesPerRow: 8, rowsPerImage: 2 });
        assert.deepEqual(uploads[0].size, { width: 2, height: 2, depthOrArrayLayers: 1 });
        assert.equal(uploads[0].destination.texture.descriptor.format, 'rgba8unorm');

        /** @type {{ view?: any }} */
        const view = {};
        assert.equal(device.CreateShaderResourceView(texture.resource, null, view), S_OK);
        /** @type {{ state?: any }} */
        const sampler = {};
        assert.equal(device.CreateSamplerState({
            Filter: D3D10_FILTER.MIN_MAG_LINEAR_MIP_POINT,
            AddressU: D3D10_TEXTURE_ADDRESS.CLAMP,
            AddressV: D3D10_TEXTURE_ADDRESS.WRAP,
            AddressW: D3D10_TEXTURE_ADDRESS.MIRROR,
            MipLODBias: 0,
            MaxAnisotropy: 1,
            ComparisonFunc: 0,
            BorderColor: [0, 0, 0, 0],
            MinLOD: 0,
            MaxLOD: 8,
        }, sampler), S_OK);
        device.PSSetShaderResources(0, [view.view]);
        device.PSSetSamplers(0, [sampler.state]);
        device.Draw(3, 0);
        await h.present();

        // The vertex shader writes no TEXCOORD, which the link reports; the
        // draw is refused rather than fed zeros.
        assert.equal(h.gpu.count('draw'), 0);
        assert.ok(h.divergences.some(line=>line.includes('TEXCOORD0 has no vertex output')));
    });

test('a sampled draw binds the texture view and a sampler built from the state', async()=>{
    const h = harness();
    const { device } = h;
    bindTriangle(h, TRIANGLE, [0, 0, 1, 1]);
    // A pixel shader that loads a texel by address needs no coordinate from
    // the vertex stage.
    /** @type {{ shader?: any }} */
    const ps = {};
    assert.equal(device.CreatePixelShader(assemble({
        kind: SHADER_KIND.PIXEL,
        outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
        instructions: [
            dclResource(0, RESOURCE_DIMENSION.TEXTURE2D, RETURN_TYPE.FLOAT), dclSampler(0),
            dclOutput(o(0)), ld(o(0), r(0), t(0)), ret(),
        ],
    }), ps), S_OK);
    device.PSSetShader(ps.shader);
    /** @type {{ resource?: any }} */
    const texture = {};
    assert.equal(device.CreateTexture2D(TEXTURE_2X2, [{ pSysMem: TEXELS, SysMemPitch: 8 }],
        texture), S_OK);
    /** @type {{ view?: any }} */
    const view = {};
    assert.equal(device.CreateShaderResourceView(texture.resource, null, view), S_OK);
    /** @type {{ state?: any }} */
    const sampler = {};
    assert.equal(device.CreateSamplerState({
        Filter: D3D10_FILTER.MIN_MAG_LINEAR_MIP_POINT,
        AddressU: D3D10_TEXTURE_ADDRESS.CLAMP,
        AddressV: D3D10_TEXTURE_ADDRESS.WRAP,
        AddressW: D3D10_TEXTURE_ADDRESS.MIRROR,
        MipLODBias: 0,
        MaxAnisotropy: 1,
        ComparisonFunc: 0,
        BorderColor: [0, 0, 0, 0],
        MinLOD: 0,
        MaxLOD: 8,
    }, sampler), S_OK);
    device.PSSetShaderResources(0, [view.view]);
    device.PSSetSamplers(0, [sampler.state]);
    device.Draw(3, 0);
    await h.present();

    assert.deepEqual(h.divergences, []);
    assert.equal(h.gpu.count('draw'), 1);
    const fragmentLayout = h.gpu.of('createBindGroupLayout').find((/** @type {any} */ call)=>
        call.descriptor.label === 'd3d10:ps');
    assert.deepEqual(fragmentLayout.descriptor.entries, [
        { binding: 16, visibility: 2, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 144, visibility: 2, sampler: { type: 'filtering' } },
    ]);
    const group = h.gpu.of('createBindGroup').find((/** @type {any} */ call)=>
        call.descriptor.layout === fragmentLayout.createBindGroupLayout);
    const [textureEntry, samplerEntry] = group.descriptor.entries;
    assert.equal(textureEntry.binding, 16);
    assert.equal(textureEntry.resource.texture.descriptor.format, 'rgba8unorm');
    assert.equal(textureEntry.resource.viewDescriptor.dimension, '2d');
    assert.equal(samplerEntry.binding, 144);
    assert.deepEqual(samplerEntry.resource.descriptor, {
        label: 'd3d10:sampler:14',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'repeat',
        addressModeW: 'mirror-repeat',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'nearest',
        lodMinClamp: 0,
        lodMaxClamp: 8,
        maxAnisotropy: 1,
    });
});

test('an unbound slot the shader declares is fed a placeholder rather than refused',
    async()=>{
        const h = harness();
        const { device } = h;
        bindTriangle(h, TRIANGLE, [0, 0, 1, 1]);
        /** @type {{ shader?: any }} */
        const ps = {};
        assert.equal(device.CreatePixelShader(assemble({
            kind: SHADER_KIND.PIXEL,
            outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
            instructions: [dclConstantBuffer(3, 2), dclOutput(o(0)), mov(o(0), cb(3, 1)), ret()],
        }), ps), S_OK);
        device.PSSetShader(ps.shader);
        device.Draw(3, 0);
        await h.present();
        assert.equal(h.gpu.count('draw'), 1);
        const group = h.gpu.of('createBindGroup').find((/** @type {any} */ call)=>
            call.descriptor.entries.some((/** @type {any} */ entry)=>entry.binding === 3));
        assert.ok(group);
        assert.equal(group.descriptor.entries[0].resource.buffer.descriptor.label,
            'd3d10:unbound-constants#0');
    });

// --- depth ---

test('a depth stencil view attaches to the pass and shapes the pipeline', async()=>{
    const h = harness();
    const { device } = h;
    bindTriangle(h, TRIANGLE, [0, 0, 1, 1]);
    /** @type {{ resource?: any }} */
    const depth = {};
    assert.equal(device.CreateTexture2D({
        ...TEXTURE_2X2,
        Width: 8,
        Height: 8,
        Format: DXGI_FORMAT.D24_UNORM_S8_UINT,
        BindFlags: D3D10_BIND.DEPTH_STENCIL,
    }, null, depth), S_OK);
    /** @type {{ view?: any }} */
    const view = {};
    assert.equal(device.CreateDepthStencilView(depth.resource, null, view), S_OK);
    device.OMSetRenderTargets([h.renderTargetView], view.view);
    device.ClearDepthStencilView(view.view, D3D10_CLEAR.DEPTH | D3D10_CLEAR.STENCIL, 0.75, 3);
    device.Draw(3, 0);
    await h.present();

    assert.deepEqual(h.divergences, []);
    const pass = h.gpu.of('beginRenderPass')[0].descriptor;
    assert.equal(pass.depthStencilAttachment.view.texture.descriptor.format,
        'depth24plus-stencil8');
    assert.equal(pass.depthStencilAttachment.depthLoadOp, 'clear');
    assert.equal(pass.depthStencilAttachment.depthClearValue, 0.75);
    assert.equal(pass.depthStencilAttachment.stencilLoadOp, 'clear');
    assert.equal(pass.depthStencilAttachment.stencilClearValue, 3);
    const descriptor = h.gpu.of('createRenderPipeline')[0].descriptor;
    assert.deepEqual(descriptor.depthStencil, {
        format: 'depth24plus-stencil8',
        depthWriteEnabled: true,
        depthCompare: 'less',
        depthBias: 0,
        depthBiasSlopeScale: 0,
        depthBiasClamp: 0,
    });
});

// --- resource traffic ---

test('UpdateSubresource lands a box at its offset and uploads the level', ()=>{
    const h = harness();
    const { device } = h;
    /** @type {{ resource?: any }} */
    const texture = {};
    assert.equal(device.CreateTexture2D({ ...TEXTURE_2X2, Width: 4, Height: 4 }, null, texture),
        S_OK);
    device.UpdateSubresource(texture.resource, 0,
        { left: 1, top: 2, front: 0, right: 3, bottom: 3, back: 1 },
        Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]), 8, 0);
    const uploads = h.gpu.of('writeTexture');
    assert.equal(uploads.length, 1);
    const bytes = uploads[0].bytes;
    assert.equal(bytes.length, 64);
    assert.deepEqual([...bytes.subarray(2 * 16 + 4, 2 * 16 + 12)], [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual([...bytes.subarray(0, 16)], new Array(16).fill(0), 'row 0 untouched');
    assert.deepEqual(h.divergences, []);

    // Not a default resource: ignored, and said so.
    /** @type {{ resource?: any }} */
    const dynamic = {};
    assert.equal(device.CreateTexture2D({
        ...TEXTURE_2X2, Usage: D3D10_USAGE.DYNAMIC, CPUAccessFlags: D3D10_CPU_ACCESS.WRITE,
    }, null, dynamic), S_OK);
    device.UpdateSubresource(dynamic.resource, 0, null, TEXELS, 8, 0);
    assert.equal(h.gpu.count('writeTexture'), 1);
    assert.ok(diverged(h, 'UpdateSubresource'));
});

test('CopyResource moves the bytes the program wrote and uploads the destination', ()=>{
    const h = harness();
    const { device } = h;
    /** @type {{ resource?: any }} */
    const source = {};
    assert.equal(device.CreateTexture2D(TEXTURE_2X2, [{ pSysMem: TEXELS, SysMemPitch: 8 }],
        source), S_OK);
    /** @type {{ resource?: any }} */
    const destination = {};
    assert.equal(device.CreateTexture2D(TEXTURE_2X2, null, destination), S_OK);
    device.CopyResource(destination.resource, source.resource);
    const uploads = h.gpu.of('writeTexture');
    assert.equal(uploads.length, 2);
    assert.deepEqual([...uploads[1].bytes], [...TEXELS]);
    assert.notEqual(uploads[1].destination.texture, uploads[0].destination.texture);
    assert.deepEqual(h.divergences, []);

    // A staging copy is readable back through a map.
    /** @type {{ resource?: any }} */
    const staging = {};
    assert.equal(device.CreateTexture2D({
        ...TEXTURE_2X2, Usage: D3D10_USAGE.STAGING, BindFlags: 0,
        CPUAccessFlags: D3D10_CPU_ACCESS.READ,
    }, null, staging), S_OK);
    device.CopyResource(staging.resource, source.resource);
    /** @type {{ data?: Uint8Array | null, rowPitch?: number }} */
    const mapped = {};
    assert.equal(staging.resource.Map(0, D3D10_MAP.READ, 0, mapped), S_OK);
    assert.deepEqual([...(/** @type {Uint8Array} */ (mapped.data))], [...TEXELS]);
    assert.equal(mapped.rowPitch, 8);
    staging.resource.Unmap(0);
    assert.equal(h.gpu.count('writeTexture'), 2, 'a staging resource is never uploaded');

    // Out of a render target, what is copied is not what was drawn.
    device.CopyResource(destination.resource, h.backBuffer);
    assert.ok(diverged(h, 'copy out of a render target'));
});

test('CopySubresourceRegion places a box at the destination offset', ()=>{
    const h = harness();
    const { device } = h;
    /** @type {{ resource?: any }} */
    const source = {};
    assert.equal(device.CreateTexture2D(TEXTURE_2X2, [{ pSysMem: TEXELS, SysMemPitch: 8 }],
        source), S_OK);
    /** @type {{ resource?: any }} */
    const destination = {};
    assert.equal(device.CreateTexture2D({ ...TEXTURE_2X2, Width: 4, Height: 4 }, null,
        destination), S_OK);
    device.CopySubresourceRegion(destination.resource, 0, 2, 1, 0, source.resource, 0,
        { left: 1, top: 0, front: 0, right: 2, bottom: 2, back: 1 });
    const bytes = h.gpu.of('writeTexture')[1].bytes;
    assert.deepEqual([...bytes.subarray(1 * 16 + 8, 1 * 16 + 12)], [0, 255, 0, 255]);
    assert.deepEqual([...bytes.subarray(2 * 16 + 8, 2 * 16 + 12)], [255, 255, 255, 255]);
    assert.deepEqual([...bytes.subarray(0, 16)], new Array(16).fill(0));
});

test('GenerateMips filters a texture made for it and leaves any other alone', ()=>{
    const h = harness();
    const { device } = h;
    /** @type {{ resource?: any }} */
    const texture = {};
    assert.equal(device.CreateTexture2D({
        ...TEXTURE_2X2,
        MipLevels: 2,
        BindFlags: D3D10_BIND.SHADER_RESOURCE | D3D10_BIND.RENDER_TARGET,
        MiscFlags: D3D10_RESOURCE_MISC.GENERATE_MIPS,
    }, [{ pSysMem: TEXELS, SysMemPitch: 8 }], texture), S_OK);
    /** @type {{ view?: any }} */
    const view = {};
    assert.equal(device.CreateShaderResourceView(texture.resource, null, view), S_OK);
    device.GenerateMips(view.view);
    const uploads = h.gpu.of('writeTexture');
    assert.equal(uploads.length, 2);
    assert.equal(uploads[1].destination.mipLevel, 1);
    // The average of red, green, blue and white: (255+0+0+255)/4 rounded.
    assert.deepEqual([...uploads[1].bytes], [128, 128, 128, 255]);

    /** @type {{ resource?: any }} */
    const plain = {};
    assert.equal(device.CreateTexture2D({ ...TEXTURE_2X2, MipLevels: 2 },
        [{ pSysMem: TEXELS, SysMemPitch: 8 }, { pSysMem: new Uint8Array(4) }], plain), S_OK);
    /** @type {{ view?: any }} */
    const plainView = {};
    assert.equal(device.CreateShaderResourceView(plain.resource, null, plainView), S_OK);
    device.GenerateMips(plainView.view);
    assert.equal(h.gpu.count('writeTexture'), 4, 'two levels of initial data, nothing more');
});

// --- queries ---

test('an event ended after a draw waits for the draw to be sent, and polling sends it',
    async()=>{
        const h = harness();
        bindTriangle(h, TRIANGLE, [0, 0, 1, 1]);
        /** @type {{ query?: any }} */
        const made = {};
        assert.equal(h.device.CreateQuery({ Query: D3D10_QUERY.EVENT, MiscFlags: 0 }, made),
            S_OK);
        const event = made.query;
        h.device.Draw(3, 0);
        event.End();
        /** @type {{ data?: Uint8Array | null }} */
        const out = {};
        assert.equal(event.GetData(true, 4, D3D10_ASYNC_GETDATA_DONOTFLUSH, out), S_FALSE,
            'the draw before it has not reached the GPU');
        assert.equal(h.gpu.count('submit'), 0);
        assert.equal(event.GetData(true, 4, 0, out), S_OK, 'a poll that may flush, flushes');
        assert.deepEqual([...(out.data ?? [])], [1, 0, 0, 0]);
        await h.device.idle();
        assert.equal(h.gpu.count('submit'), 1, 'the draw went in a frame of its own');
        assert.equal(h.gpu.count('draw'), 1);
        assert.equal(h.presented.length, 0, 'and nothing was shown');

        // Ended with nothing recorded before it, the event has nothing to wait on.
        await h.present();
        event.End();
        assert.equal(event.GetData(false, 0, D3D10_ASYNC_GETDATA_DONOTFLUSH, out), S_OK);
        h.device.Draw(3, 0);
        h.device.Flush();
        event.End();
        assert.equal(event.GetData(false, 0, D3D10_ASYNC_GETDATA_DONOTFLUSH, out), S_OK,
            'Flush sends the recording as a poll does');
        await h.device.idle();
        assert.equal(h.gpu.count('draw'), 2);
        assert.deepEqual(h.device.diagnostics().failures, []);
        event.release();
    });

test('ResolveSubresource and the other unsupported calls say what they did not do', ()=>{
    const h = harness();
    const { device } = h;
    device.ResolveSubresource(h.backBuffer, 0, h.backBuffer, 0, DXGI_FORMAT.R8G8B8A8_UNORM);
    assert.ok(h.divergences.some(line=>line.includes('ResolveSubresource')));
    device.DrawAuto();
    assert.ok(h.divergences.some(line=>line.includes('DrawAuto')));
    /** @type {{ shader?: any }} */
    const shader = {};
    assert.equal(device.CreateGeometryShaderWithStreamOutput(new Uint8Array(0), [], 0, shader),
        0x80004001);
    assert.equal(shader.shader, null);
});

test('a shader with an instruction that has no translation refuses its draws by name',
    async()=>{
        const h = harness();
        const { device } = h;
        bindTriangle(h, TRIANGLE, [0, 0, 1, 1]);
        /** @type {{ shader?: any }} */
        const ps = {};
        assert.equal(device.CreatePixelShader(assemble({
            kind: SHADER_KIND.PIXEL,
            outputs: [{ name: 'SV_TARGET', systemValue: SYSTEM_VALUE.TARGET, register: 0 }],
            instructions: [
                dclResource(0, RESOURCE_DIMENSION.TEXTURE2DMS, RETURN_TYPE.FLOAT),
                dclOutput(o(0)),
                { opcode: 46, operands: [o(0), r(0), t(0), r(1, 'x')] },
                ret(),
            ],
        }), ps), S_OK, 'the create accepts it: the refusal is the draw\'s');
        device.PSSetShader(ps.shader);
        device.Draw(3, 0);
        await h.present();
        assert.equal(h.gpu.count('draw'), 0);
        assert.equal(h.device.diagnostics().skipped.pipeline, 1);
        assert.ok(h.divergences.some(line=>line.includes('ld_ms')), h.divergences.join('\n'));
    });
