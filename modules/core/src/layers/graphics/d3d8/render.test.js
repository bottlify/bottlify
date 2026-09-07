/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Two kinds of test, kept apart on purpose.
 *
 * **Byte-exact.** What this engine computes itself -- the bytes it puts on the
 * queue for a draw, the uniform block, the texels it expands, the matrix it
 * combines -- is evaluated on the processor with the software reference in
 * `webgpu/internal/reference.js` and compared byte for byte against a stored
 * image: base64 of the raw BGRX buffer, beside the code that produced it. No
 * tolerance, ever. These prove the formula and the plumbing up to the queue.
 *
 * **Recorded commands.** What a GPU would do is checked by what it was asked to
 * do -- which draw, with which pipeline, in which pass, reading which buffer
 * generation -- through the recording device in `webgpu/internal/fake-device.js`.
 * A real GPU cannot be held to a stored image: drivers differ in their
 * rasterisation rules, filtering and rounding. Nothing here judges a frame by
 * looking at it.
 *
 * Every test says which it is.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3DBLEND, D3DCLEAR, D3DCMP, D3DFMT, D3DFMT_INDEX, D3DLOCK, D3DPOOL, D3DPT, D3DRS,
    D3DSWAPEFFECT, D3DTA, D3DTADDRESS, D3DTEXF, D3DTOP, D3DTS, D3DTSS, D3D_OK,
} from './constants.js';
import { createDirect3D8 } from './device.js';
import {
    IDENTITY, colorToFloats, expandTexels, listIndices, multiplyMatrices, transformPosition,
    vertexCountOf,
} from './render.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { FVF, decodeFvf } from '../webgpu/internal/vertexformat.js';
import {
    clear as referenceClear, createReferenceSurface, fillRect, toBase64,
} from '../webgpu/internal/reference.js';

/** Where the device hands out storage from; the fixture backs it with real bytes. */
const RAM_BASE = 0x40000000;
const RAM_SIZE = 32 << 20;

const FVF_QUAD = FVF.XYZRHW | FVF.DIFFUSE;
const FVF_TEXTURED_QUAD = FVF.XYZRHW | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT);

/**
 * A device with a backend over the recording GPU, and guest memory it can read.
 *
 * @param {{ width?: number, height?: number, format?: number, depth?: boolean }} [options]
 */
function harness(options = {}){
    const gpu = createFakeDevice();
    /** @type {any[]} */
    const presented = [];
    const backend = createBackend({
        device: gpu.device,
        queue: gpu.queue,
        presentTo: frame=>presented.push(frame),
        now: ()=>0,
    });
    const ram = new Uint8Array(RAM_SIZE);
    /** @type {any[]} */
    const samplers = [];
    const d3d = createDirect3D8({
        backend,
        readMemory: (address, length)=>ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        createSampler: descriptor=>{
            const sampler = { kind: 'sampler', descriptor };
            samplers.push(sampler);
            return sampler;
        },
    });
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({
        swapEffect: D3DSWAPEFFECT.DISCARD,
        backBufferCount: 1,
        backBufferWidth: options.width ?? 4,
        backBufferHeight: options.height ?? 4,
        backBufferFormat: options.format ?? D3DFMT.X8R8G8B8,
        enableAutoDepthStencil: options.depth ?? true,
        autoDepthStencilFormat: D3DFMT.D24S8,
    }, out), D3D_OK);
    const device = out.device;

    return {
        gpu,
        backend,
        presented,
        samplers,
        device,
        /** @param {number} address @param {Uint8Array} bytes */
        write(address, bytes){
            ram.set(bytes, address - RAM_BASE);
        },
        /** Draws the frame and waits for it to reach the queue. */
        async present(){
            assert.equal(device.Present(), D3D_OK);
            await device.idle();
        },
    };
}

/**
 * A pre-transformed vertex: x, y, z, rhw, a D3DCOLOR, and a coordinate pair
 * when the format has one.
 *
 * @param {number[]} corner
 * @param {number} color
 * @param {number[] | null} uv
 */
function vertex(corner, color, uv){
    const bytes = new DataView(new ArrayBuffer(uv ? 28 : 20));
    bytes.setFloat32(0, corner[0], true);
    bytes.setFloat32(4, corner[1], true);
    bytes.setFloat32(8, 0.5, true);
    bytes.setFloat32(12, 1, true);
    bytes.setUint32(16, color >>> 0, true);
    if (uv)
    {
        bytes.setFloat32(20, uv[0], true);
        bytes.setFloat32(24, uv[1], true);
    }
    return new Uint8Array(bytes.buffer);
}

/**
 * Two triangles covering `[x1, x2) x [y1, y2)` in target pixels, with the
 * texture (if any) spanning it exactly once.
 *
 * @param {number[]} rect x1, y1, x2, y2
 * @param {number} color D3DCOLOR
 * @param {boolean} [textured]
 * @returns {Uint8Array}
 */
function quad(rect, color, textured = false){
    const [x1, y1, x2, y2] = rect;
    const corners = [
        [[x1, y1], [0, 0]], [[x2, y1], [1, 0]], [[x1, y2], [0, 1]],
        [[x1, y2], [0, 1]], [[x2, y1], [1, 0]], [[x2, y2], [1, 1]],
    ];
    const stride = textured ? 28 : 20;
    const out = new Uint8Array(stride * 6);
    corners.forEach(([corner, uv], index)=>{
        out.set(vertex(corner, color, textured ? uv : null), index * stride);
    });
    return out;
}

/** @param {number} r @param {number} g @param {number} b @param {number} [a] */
const argb = (r, g, b, a = 255)=>((a << 24) | (r << 16) | (g << 8) | b) >>> 0;

/** @param {any} surface @param {number} x @param {number} y */
const pixelAt = (surface, x, y)=>
    [...surface.bytes.subarray((y * surface.width + x) * 4, (y * surface.width + x) * 4 + 4)];

/**
 * The software evaluation of the last frame the device replayed.
 *
 * Reads the commands the renderer recorded and, for every draw, the vertex
 * bytes the backend actually put on the queue -- not the bytes the test
 * wrote, so a draw whose bytes never travelled is a draw this cannot see.
 * Only axis-aligned pre-transformed quads are understood; that is enough to
 * hold the formula and the plumbing to account, and a triangle would only add
 * edge rules that say nothing about either.
 *
 * @param {ReturnType<typeof harness>} h
 * @param {number} width @param {number} height
 */
function rasterise(h, width, height){
    const surface = createReferenceSurface(width, height);
    let scissor = { x: 0, y: 0, width, height };
    for (const command of h.device.diagnostics().lastFrame)
    {
        if (command.kind === 'pass')
        {
            if (command.clearColor)
            {
                const c = command.clearColor;
                referenceClear(surface, {
                    r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255),
                });
            }
            scissor = { x: 0, y: 0, width, height };
            continue;
        }
        if (command.kind === 'scissor')
        {
            scissor = command.rect;
            continue;
        }
        if (command.kind !== 'draw')
        {
            continue;
        }
        const state = command.state;
        const layout = decodeFvf(state.fvf);
        assert.ok(layout.preTransformed, 'the evaluator understands pre-transformed quads only');
        assert.equal(command.count, 6);
        const bytes = queuedBytes(h.gpu, command.vertices, 6 * layout.stride);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const xs = new Set();
        const ys = new Set();
        const colours = new Set();
        for (let index = 0; index < 6; index++)
        {
            const at = index * layout.stride;
            xs.add(view.getFloat32(at, true));
            ys.add(view.getFloat32(at + 4, true));
            colours.add(view.getUint32(at + 16, true));
        }
        assert.equal(xs.size, 2, 'an axis-aligned quad');
        assert.equal(ys.size, 2);
        assert.equal(colours.size, 1, 'one colour across the quad');
        const [x1, x2] = [...xs].sort((a, b)=>a - b);
        const [y1, y2] = [...ys].sort((a, b)=>a - b);
        const rect = {
            x0: Math.max(x1, scissor.x),
            y0: Math.max(y1, scissor.y),
            x1: Math.min(x2, scissor.x + scissor.width),
            y1: Math.min(y2, scissor.y + scissor.height),
        };
        const diffuse = colorToFloats([...colours][0]);
        const texture = command.stageBindings.length > 0 && command.stageBindings[0].view
            ? uploadedTexture(h.gpu, command.stageBindings[0].view)
            : undefined;
        fillRect(surface, rect, {
            diffuse: {
                r: diffuse.r * 255, g: diffuse.g * 255, b: diffuse.b * 255, a: diffuse.a * 255,
            },
            texture,
            stages: state.stages,
            blend: blendOf(state),
            alphaTest: state.alphaTest,
            alphaFunc: state.alphaFunc,
            alphaRef: Math.round(command.uniforms[32] * 255),
        });
    }
    return surface;
}

/** @param {any} state */
function blendOf(state){
    if (!state.blend)
    {
        return false;
    }
    assert.equal(state.srcBlend, D3DBLEND.SRCALPHA, 'the evaluator knows straight alpha only');
    assert.equal(state.destBlend, D3DBLEND.INVSRCALPHA);
    return true;
}

/**
 * The bytes the queue received for a range of a buffer: the last write that
 * covered it.
 *
 * @param {any} gpu @param {{ gpu: any, offset: number }} at @param {number} length
 */
function queuedBytes(gpu, at, length){
    const writes = gpu.of('writeBuffer').filter((/** @type {any} */ call)=>
        call.buffer === at.gpu && call.bufferOffset <= at.offset
            && call.bufferOffset + call.size >= at.offset + length);
    assert.ok(writes.length > 0, 'the vertices this draw reads reached the queue');
    const write = writes[writes.length - 1];
    const from = at.offset - write.bufferOffset;
    return write.bytes.subarray(from, from + length);
}

/** @param {any} gpu @param {any} view a texture view the draw bound */
function uploadedTexture(gpu, view){
    const uploads = gpu.of('writeTexture').filter((/** @type {any} */ call)=>
        call.destination.texture === view.texture);
    assert.ok(uploads.length > 0, 'the texture this draw samples reached the queue');
    const upload = uploads[uploads.length - 1];
    return { width: upload.size.width, height: upload.size.height, bytes: upload.bytes };
}

/**
 * A texture the program has filled by locking it, the way a program does.
 *
 * @param {ReturnType<typeof harness>} h
 * @param {number} width @param {number} height @param {number} format
 * @param {Uint8Array} texels
 */
function textureFrom(h, width, height, format, texels){
    /** @type {{ texture?: any }} */
    const out = {};
    assert.equal(h.device.CreateTexture(width, height, 1, 0, format, D3DPOOL.MANAGED, out), D3D_OK);
    /** @type {{ pBits?: number, Pitch?: number }} */
    const locked = {};
    assert.equal(out.texture.LockRect(0, locked, null, 0), D3D_OK);
    h.write(/** @type {number} */ (locked.pBits), texels);
    assert.equal(out.texture.UnlockRect(0), D3D_OK);
    return out.texture;
}

/** Stage zero selects the texture and nothing else. @param {any} device */
function selectTexture(device){
    device.SetTextureStageState(0, D3DTSS.COLOROP, D3DTOP.SELECTARG1);
    device.SetTextureStageState(0, D3DTSS.COLORARG1, D3DTA.TEXTURE);
    device.SetTextureStageState(0, D3DTSS.ALPHAOP, D3DTOP.SELECTARG1);
    device.SetTextureStageState(0, D3DTSS.ALPHAARG1, D3DTA.TEXTURE);
}

// --- byte-exact: what the engine computes, evaluated on the processor ---

test('byte-exact: a solid fill is that colour in every pixel it covers, blue byte first', async()=>{
    const h = harness();
    const { device } = h;
    // Channels all different, because a channel swap is invisible in grey.
    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, argb(0x12, 0x34, 0x56), 1, 0), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
        quad([1, 1, 3, 3], argb(0, 0, 255)), 20), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const surface = rasterise(h, 4, 4);
    // BGRX: the byte at the lowest address is blue. A D3DCOLOR is 0xaarrggbb
    // and a pixel is 0x00rrggbb, so the clear colour lands as 56 34 12.
    assert.deepEqual(pixelAt(surface, 0, 0), [0x56, 0x34, 0x12, 0xff], 'the clear colour');
    assert.deepEqual(pixelAt(surface, 1, 1), [0xff, 0x00, 0x00, 0xff], 'the quad is blue');
    assert.deepEqual(pixelAt(surface, 3, 3), [0x56, 0x34, 0x12, 0xff], 'and stops where it said');
    // The whole image: two rows of clear colour around a 2x2 blue block.
    assert.equal(toBase64(surface),
        'VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev//AAD//wAA/1Y0Ev9WNBL//wAA//8AAP9WNBL/VjQS/1Y0Ev9WNBL/VjQS/w==');
});

test('byte-exact: alpha blending is straight, rounds, and the two ends are exact', async()=>{
    const h = harness();
    const { device } = h;
    const drawOver = async(/** @type {number} */ colour)=>{
        assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, argb(40, 60, 80), 1, 0), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2, quad([0, 0, 4, 4], colour), 20),
            D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
        return rasterise(h, 4, 4);
    };
    device.SetRenderState(D3DRS.ALPHABLENDENABLE, 1);
    device.SetRenderState(D3DRS.SRCBLEND, D3DBLEND.SRCALPHA);
    device.SetRenderState(D3DRS.DESTBLEND, D3DBLEND.INVSRCALPHA);

    // 200 at half alpha over 40 is 120 straight and near 60 premultiplied, and
    // 0 over 80 is 40 -- values chosen so a wrong formula cannot round right.
    assert.deepEqual(pixelAt(await drawOver(argb(200, 100, 0, 128)), 2, 2), [40, 80, 120, 255]);
    assert.deepEqual(pixelAt(await drawOver(argb(255, 238, 221, 0)), 2, 2), [80, 60, 40, 255],
        'alpha 0 leaves the destination untouched');
    assert.deepEqual(pixelAt(await drawOver(argb(255, 238, 221, 255)), 2, 2), [221, 238, 255, 255],
        'alpha 255 replaces it exactly');
});

test('byte-exact: colour precision survives a vertex round trip, all 256 levels', async()=>{
    const h = harness({ width: 16, height: 16 });
    const { device } = h;
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    for (let value = 0; value < 256; value++)
    {
        const x = value % 16;
        const y = (value / 16) | 0;
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
            quad([x, y, x + 1, y + 1], argb(value, 255 - value, value ^ 0x55)), 20), D3D_OK);
    }
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const surface = rasterise(h, 16, 16);
    for (let value = 0; value < 256; value++)
    {
        assert.deepEqual(pixelAt(surface, value % 16, (value / 16) | 0),
            [value ^ 0x55, 255 - value, value, 255], `level ${value} did not survive`);
    }
    assert.equal(h.gpu.count('draw'), 256, 'every level was its own draw');
});

test('byte-exact: a texture drawn one-to-one reproduces its texels exactly', async()=>{
    const h = harness({ width: 2, height: 2 });
    const { device } = h;
    // Four different texels, B G R A each, as A8R8G8B8 lies in memory.
    const texels = Uint8Array.from([
        0, 0, 255, 255, 0, 255, 0, 255,
        255, 0, 0, 255, 0, 255, 255, 255,
    ]);
    const texture = textureFrom(h, 2, 2, D3DFMT.A8R8G8B8, texels);
    assert.equal(device.SetTexture(0, texture), D3D_OK);
    selectTexture(device);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
        quad([0, 0, 2, 2], argb(255, 255, 255), true), 28), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const surface = rasterise(h, 2, 2);
    assert.deepEqual(pixelAt(surface, 0, 0), [0, 0, 255, 255], 'red stayed top left');
    assert.deepEqual(pixelAt(surface, 1, 1), [0, 255, 255, 255], 'yellow stayed bottom right');
    // All four in place: nothing transposed, nothing flipped, nothing shifted.
    assert.equal(toBase64(surface), 'AAD//wD/AP//AAD/AP///w==');
    // And the texels that went to the queue are the texels the program wrote.
    assert.deepEqual([...h.gpu.of('writeTexture')[0].bytes], [...texels]);
});

test('byte-exact: a magnified texture repeats each texel with no half-pixel drift', async()=>{
    const h = harness({ width: 4, height: 1 });
    const { device } = h;
    const texture = textureFrom(h, 2, 1, D3DFMT.A8R8G8B8,
        Uint8Array.from([0, 0, 255, 255, 255, 0, 0, 255]));
    assert.equal(device.SetTexture(0, texture), D3D_OK);
    selectTexture(device);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
        quad([0, 0, 4, 1], argb(255, 255, 255), true), 28), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const surface = rasterise(h, 4, 1);
    assert.equal(toBase64(surface), 'AAD//wAA////AAD//wAA/w==',
        'two red pixels then two blue, the boundary after pixel one');
});

test('byte-exact: the alpha test discards and never writes a discarded fragment', async()=>{
    const h = harness();
    const { device } = h;
    device.SetRenderState(D3DRS.ALPHATESTENABLE, 1);
    device.SetRenderState(D3DRS.ALPHAFUNC, D3DCMP.GREATER);
    device.SetRenderState(D3DRS.ALPHAREF, 128);
    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, argb(0x11, 0x22, 0x33), 1, 0), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
        quad([0, 0, 4, 4], argb(255, 255, 255, 100)), 20), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
        quad([0, 0, 1, 1], argb(255, 255, 255, 200)), 20), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const surface = rasterise(h, 4, 4);
    assert.deepEqual(pixelAt(surface, 3, 3), [0x33, 0x22, 0x11, 0xff], 'alpha 100 failed');
    assert.deepEqual(pixelAt(surface, 0, 0), [0xff, 0xff, 0xff, 0xc8], 'alpha 200 passed');
});

test('byte-exact: known matrices in, known transformed positions out', async()=>{
    const h = harness();
    const { device } = h;
    const world = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 2, 3, 1];
    const view = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1];
    const projection = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    assert.equal(device.SetTransform(D3DTS.WORLD, world), D3D_OK);
    assert.equal(device.SetTransform(D3DTS.VIEW, view), D3D_OK);
    assert.equal(device.SetTransform(D3DTS.PROJECTION, projection), D3D_OK);

    // The product is translate-then-scale, in that order: a row vector goes
    // through the world matrix first. The other order would give (3, 4, 5).
    const combined = multiplyMatrices(multiplyMatrices(world, view), projection);
    assert.deepEqual(transformPosition(combined, [1, 1, 1]), [4, 6, 8, 1]);
    assert.deepEqual(transformPosition(IDENTITY, [7, 8, 9]), [7, 8, 9, 1]);

    // The block a draw carries holds exactly that product, in memory order,
    // and the viewport's two halves for a viewport whose origin is not zero.
    assert.equal(device.SetViewport({ X: 1, Y: 2, Width: 2, Height: 1, MinZ: 0, MaxZ: 1 }),
        D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF.XYZ | FVF.DIFFUSE), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(16 * 3), 16),
        D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const draw = h.device.diagnostics().lastFrame.find((/** @type {any} */ c)=>c.kind === 'draw');
    assert.deepEqual([...draw.uniforms.subarray(0, 16)], [...combined]);
    assert.deepEqual([...draw.uniforms.subarray(16, 20)], [-1, -2, 2 / 2, -2 / 1],
        'the inverse offset and extent, so that a pixel-space vertex lands where it says');
    const block = h.gpu.of('writeBuffer').find((/** @type {any} */ call)=>
        call.buffer.descriptor.label.startsWith('uniforms'));
    assert.deepEqual([...new Float32Array(block.bytes.buffer, block.bytes.byteOffset, 16)],
        [...combined], 'and those are the bytes on the queue');
});

test('byte-exact: sixteen-bit texels expand to eight with the top bits replicated', ()=>{
    // 0x8410 is 10000 100000 10000: each channel at its midpoint. A shift
    // alone gives 128 and 128; replicating the top bits gives 132 and 130,
    // and the top value gives 255 rather than 248.
    assert.deepEqual([...expandTexels(D3DFMT.R5G6B5, Uint8Array.from([0x10, 0x84]), 1)],
        [132, 130, 132, 255]);
    assert.deepEqual([...expandTexels(D3DFMT.R5G6B5, Uint8Array.from([0xff, 0xff]), 1)],
        [255, 255, 255, 255]);
    assert.deepEqual([...expandTexels(D3DFMT.R5G6B5, Uint8Array.from([0x00, 0xf8]), 1)],
        [0, 0, 255, 255], 'red is the top five bits');
    assert.deepEqual([...expandTexels(D3DFMT.A1R5G5B5, Uint8Array.from([0x1f, 0x80]), 1)],
        [255, 0, 0, 255], 'blue, with the alpha bit set');
    assert.deepEqual([...expandTexels(D3DFMT.A1R5G5B5, Uint8Array.from([0x1f, 0x00]), 1)],
        [255, 0, 0, 0], 'and clear');
    assert.deepEqual([...expandTexels(D3DFMT.X8R8G8B8, Uint8Array.from([1, 2, 3, 4]), 1)],
        [1, 2, 3, 255], 'an X8 texel has no alpha to sample, whatever the byte held');
    assert.deepEqual([...expandTexels(D3DFMT.A8, Uint8Array.from([9]), 1)], [0, 0, 0, 9]);
    assert.throws(()=>expandTexels(D3DFMT.A2R10G10B10, new Uint8Array(4), 1), /cannot be uploaded/);
});

test('byte-exact: strips and fans expand to the lists they draw, winding kept', ()=>{
    assert.deepEqual([...listIndices(D3DPT.TRIANGLEFAN, [0, 1, 2, 3, 4])],
        [0, 1, 2, 0, 2, 3, 0, 3, 4]);
    // The odd triangle is flipped so the strip faces one way throughout.
    assert.deepEqual([...listIndices(D3DPT.TRIANGLESTRIP, [0, 1, 2, 3])],
        [0, 1, 2, 2, 1, 3]);
    assert.deepEqual([...listIndices(D3DPT.LINESTRIP, [5, 6, 7])], [5, 6, 6, 7]);
    assert.ok(listIndices(D3DPT.TRIANGLEFAN, [0, 1, 70000]) instanceof Uint32Array,
        'an index past sixteen bits widens the list');
    assert.equal(vertexCountOf(D3DPT.TRIANGLESTRIP, 2), 4);
    assert.equal(vertexCountOf(D3DPT.TRIANGLELIST, 2), 6);
    assert.equal(vertexCountOf(7, 2), 0, 'not a primitive type');
    assert.equal(vertexCountOf(D3DPT.POINTLIST, 0), 0);
});

// --- recorded commands: what the GPU was asked to do ---

test('recorded: one encoder and one submit per frame, a target change is a new pass', async()=>{
    const h = harness();
    const { device, gpu } = h;
    /** @type {{ surface?: any }} */
    const other = {};
    assert.equal(device.CreateRenderTarget(4, 4, D3DFMT.X8R8G8B8, false, other), D3D_OK);

    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER, 0, 1, 0), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2, quad([0, 0, 4, 4], 0), 20), D3D_OK);
    assert.equal(device.SetRenderTarget(other.surface, null), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2, quad([0, 0, 4, 4], 0), 20), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    assert.equal(gpu.count('createCommandEncoder'), 1, 'one encoder for the whole frame');
    assert.equal(gpu.count('submit'), 1, 'submitted once, at the end');
    assert.equal(gpu.count('beginRenderPass'), 2, 'the target change opened a second pass');
    assert.equal(gpu.count('endPass'), 2);
    assert.equal(gpu.count('draw'), 2);
    const passes = gpu.of('beginRenderPass').map((/** @type {any} */ call)=>call.descriptor);
    assert.equal(passes[0].colorAttachments[0].loadOp, 'clear');
    assert.equal(passes[0].depthStencilAttachment.depthLoadOp, 'clear');
    assert.equal(passes[0].depthStencilAttachment.stencilLoadOp, 'load',
        'stencil was not asked for');
    assert.equal(passes[1].colorAttachments[0].loadOp, 'load');
    assert.equal(passes[1].depthStencilAttachment, undefined, 'the new target has no depth');
    assert.equal(h.presented.length, 1);
    other.surface.release();
});

test('recorded: a draw binds its pipeline, its stream and a viewport inside its pass', async()=>{
    const h = harness();
    const { device, gpu } = h;
    /** @type {{ buffer?: any }} */
    const out = {};
    assert.equal(device.CreateVertexBuffer(20 * 3, 0, FVF_QUAD, D3DPOOL.DEFAULT, out), D3D_OK);
    /** @type {{ pBits?: number }} */
    const locked = {};
    assert.equal(out.buffer.Lock(0, 0, locked, D3DLOCK.DISCARD), D3D_OK);
    h.write(/** @type {number} */ (locked.pBits), quad([0, 0, 4, 4], 0).subarray(0, 60));
    assert.equal(out.buffer.Unlock(), D3D_OK);

    assert.equal(device.SetViewport({ X: 1, Y: 1, Width: 2, Height: 2, MinZ: 0, MaxZ: 1 }), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.SetStreamSource(0, out.buffer, 20), D3D_OK);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const order = gpu.calls.map((/** @type {any} */ call)=>call.op);
    const pass = order.indexOf('beginRenderPass');
    for (const op of ['setViewport', 'setPipeline', 'setBindGroup', 'setVertexBuffer', 'draw'])
    {
        assert.ok(order.lastIndexOf(op) > pass && order.lastIndexOf(op) < order.indexOf('endPass'),
            `${op} was recorded inside the pass`);
    }
    assert.deepEqual(gpu.of('setViewport').pop().rect, [1, 1, 2, 2, 0, 1]);
    assert.deepEqual(gpu.of('draw')[0].args, [3, 1, 0]);
    const bound = gpu.of('setVertexBuffer')[0];
    // Generation one: the DISCARD lock renamed the buffer the program was
    // handed, and the draw reads the generation it was recorded against.
    assert.equal(bound.buffer.descriptor.label, 'vertices#1', 'the stream the program bound');
    assert.equal(bound.offset, 0);
    const uploaded = gpu.of('writeBuffer').find((/** @type {any} */ call)=>call.buffer === bound.buffer);
    assert.deepEqual([...uploaded.bytes], [...quad([0, 0, 4, 4], 0).subarray(0, 60)],
        'and the bytes it wrote are the bytes on the queue');
    out.buffer.release();
});

test('recorded: two draws with different transforms in one pass get their own uniforms', async()=>{
    const h = harness();
    const { device, gpu } = h;
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF.XYZ | FVF.DIFFUSE), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(48), 16), D3D_OK);
    assert.equal(device.SetTransform(D3DTS.WORLD,
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1]), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(48), 16), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const blocks = gpu.of('writeBuffer').filter((/** @type {any} */ call)=>
        call.buffer.descriptor.label.startsWith('uniforms'));
    assert.equal(blocks.length, 2);
    assert.notEqual(blocks[0].buffer, blocks[1].buffer,
        'one buffer rewritten twice would show both draws the second matrix');
    assert.equal(new Float32Array(blocks[0].bytes.buffer, blocks[0].bytes.byteOffset, 16)[12], 0);
    assert.equal(new Float32Array(blocks[1].bytes.buffer, blocks[1].bytes.byteOffset, 16)[12], 5);
    const groups = gpu.of('setBindGroup').map((/** @type {any} */ call)=>call.group);
    assert.notEqual(groups[0], groups[1], 'and each draw bound its own group');
    assert.equal(gpu.count('beginRenderPass'), 1, 'in one pass');
    assert.equal(gpu.count('createRenderPipeline'), 1,
        'with one pipeline: the state did not change');
});

test('recorded: a DISCARD lock renames, and the earlier draw reads the old generation', async()=>{
    const h = harness();
    const { device, gpu } = h;
    /** @type {{ buffer?: any }} */
    const out = {};
    assert.equal(device.CreateVertexBuffer(1024, 0, FVF_QUAD, D3DPOOL.DEFAULT, out), D3D_OK);
    const fill = (/** @type {number} */ value, /** @type {number} */ flags)=>{
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(out.buffer.Lock(0, 60, locked, flags), D3D_OK);
        h.write(/** @type {number} */ (locked.pBits), new Uint8Array(60).fill(value));
        assert.equal(out.buffer.Unlock(), D3D_OK);
    };

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.SetStreamSource(0, out.buffer, 20), D3D_OK);
    fill(1, D3DLOCK.DISCARD);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    fill(2, D3DLOCK.DISCARD);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const bound = gpu.of('setVertexBuffer').map((/** @type {any} */ call)=>call.buffer);
    assert.notEqual(bound[0], bound[1], 'the second lock renamed');
    const written = gpu.of('writeBuffer').filter((/** @type {any} */ call)=>
        bound.includes(call.buffer));
    assert.equal(written.length, 2);
    assert.equal(written[0].buffer, bound[0]);
    assert.equal(written[0].bytes[0], 1, 'the first generation carries the first write');
    assert.equal(written[1].bytes[0], 2);
    assert.equal(written[0].size, 60, 'only the locked range travels after a DISCARD');
    assert.equal(written[1].size, 60);
    out.buffer.release();
});

test('recorded: a lock with neither flag resends the whole buffer', async()=>{
    const h = harness();
    const { device, gpu } = h;
    /** @type {{ buffer?: any }} */
    const out = {};
    assert.equal(device.CreateVertexBuffer(1024, 0, FVF_QUAD, D3DPOOL.DEFAULT, out), D3D_OK);
    /** @type {{ pBits?: number }} */
    const locked = {};
    assert.equal(out.buffer.Lock(100, 20, locked, 0), D3D_OK);
    assert.equal(out.buffer.Unlock(), D3D_OK);
    assert.equal(out.buffer.Lock(200, 20, locked, D3DLOCK.NOOVERWRITE), D3D_OK);
    assert.equal(out.buffer.Unlock(), D3D_OK);
    await h.present();

    const writes = gpu.of('writeBuffer').filter((/** @type {any} */ call)=>
        call.buffer.descriptor.label.startsWith('vertices'));
    // The plain lock renamed and dirtied everything; the NOOVERWRITE range
    // merged into that same generation's dirty range, so one upload of all of it.
    assert.equal(writes.length, 1);
    assert.equal(writes[0].size, 1024);
    out.buffer.release();
});

test('recorded: a read-only lock touches nothing on the backend', async()=>{
    const h = harness();
    const { device, gpu } = h;
    /** @type {{ buffer?: any }} */
    const out = {};
    assert.equal(device.CreateVertexBuffer(64, 0, FVF_QUAD, D3DPOOL.DEFAULT, out), D3D_OK);
    /** @type {{ pBits?: number }} */
    const locked = {};
    assert.equal(out.buffer.Lock(0, 0, locked, D3DLOCK.READONLY), D3D_OK);
    assert.equal(out.buffer.Unlock(), D3D_OK);
    await h.present();
    assert.equal(gpu.of('writeBuffer').filter((/** @type {any} */ call)=>
        call.buffer.descriptor.label.startsWith('vertices')).length, 0);
    out.buffer.release();
});

test('recorded: a draw that differs only at stage one gets its own pipeline', async()=>{
    const h = harness();
    const { device, gpu } = h;
    const texture = textureFrom(h, 1, 1, D3DFMT.A8R8G8B8, Uint8Array.from([1, 2, 3, 4]));
    assert.equal(device.SetTexture(0, texture), D3D_OK);
    assert.equal(device.SetTexture(1, texture), D3D_OK);
    device.SetTextureStageState(1, D3DTSS.COLOROP, D3DTOP.MODULATE);
    device.SetTextureStageState(1, D3DTSS.ALPHAOP, D3DTOP.SELECTARG1);
    const fvf = FVF.XYZRHW | FVF.DIFFUSE | (2 << FVF.TEXCOUNT_SHIFT);

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(fvf), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(36 * 3), 36), D3D_OK);
    device.SetTextureStageState(1, D3DTSS.COLOROP, D3DTOP.ADD);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(36 * 3), 36), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    assert.equal(gpu.count('createRenderPipeline'), 2,
        'a key folding only stage zero would draw the second with the first formula');
    const layout = gpu.of('createBindGroupLayout')[0].descriptor;
    assert.deepEqual(layout.entries.map((/** @type {any} */ e)=>e.binding), [0, 1, 2, 3, 4],
        'the uniform block and a texture and sampler for each of two stages');
    const groups = gpu.of('createBindGroup').map((/** @type {any} */ call)=>call.descriptor);
    assert.equal(groups[0].entries.length, 5);
    assert.equal(groups[0].entries[2].resource.kind, 'sampler');
    assert.equal(gpu.count('writeTexture'), 1, 'the texture went up once for both draws');
    assert.equal(h.device.diagnostics().draws, 2);
});

test('recorded: the cascade ends at a stage that samples a texture nobody bound', async()=>{
    const h = harness();
    const { device, gpu } = h;
    // Stage zero at its default modulates the texture, and there is none: the
    // draw is the diffuse alone, with no texture binding at all.
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(60), 20), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    assert.equal(gpu.count('draw'), 1);
    assert.deepEqual(gpu.of('createBindGroupLayout')[0].descriptor.entries.length, 1,
        'the uniform block only');
    assert.equal(h.samplers.length, 0, 'no sampler was needed');
});

test('recorded: a sampler follows the stage filter and address states', async()=>{
    const h = harness();
    const { device } = h;
    const texture = textureFrom(h, 1, 1, D3DFMT.X8R8G8B8, Uint8Array.from([1, 2, 3, 4]));
    assert.equal(device.SetTexture(0, texture), D3D_OK);
    device.SetTextureStageState(0, D3DTSS.MAGFILTER, D3DTEXF.LINEAR);
    device.SetTextureStageState(0, D3DTSS.ADDRESSU, D3DTADDRESS.CLAMP);
    device.SetTextureStageState(0, D3DTSS.ADDRESSV, D3DTADDRESS.MIRROR);

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(84), 28), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    assert.equal(h.samplers.length, 1);
    const descriptor = h.samplers[0].descriptor;
    assert.equal(descriptor.magFilter, 'linear');
    assert.equal(descriptor.minFilter, 'nearest', 'the default is point');
    assert.equal(descriptor.addressModeU, 'clamp-to-edge');
    assert.equal(descriptor.addressModeV, 'mirror-repeat');
});

test('recorded: a texture is uploaded after it is unlocked, and only then', async()=>{
    const h = harness();
    const { device, gpu } = h;
    const texture = textureFrom(h, 1, 1, D3DFMT.X8R8G8B8, Uint8Array.from([9, 8, 7, 0]));
    assert.equal(device.SetTexture(0, texture), D3D_OK);
    selectTexture(device);
    const draw = ()=>{
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(84), 28), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
    };
    draw();
    draw();
    await h.present();
    assert.equal(gpu.count('writeTexture'), 1, 'two draws, one upload');
    assert.deepEqual([...gpu.of('writeTexture')[0].bytes], [9, 8, 7, 255],
        'X8 has no alpha, so the undefined byte went up as opaque');

    // The program writes the texture again through the level's own surface.
    /** @type {{ surface?: any }} */
    const level = {};
    assert.equal(texture.GetSurfaceLevel(0, level), D3D_OK);
    /** @type {{ pBits?: number }} */
    const locked = {};
    assert.equal(level.surface.LockRect(locked, null, 0), D3D_OK);
    h.write(/** @type {number} */ (locked.pBits), Uint8Array.from([1, 1, 1, 0]));
    assert.equal(level.surface.UnlockRect(), D3D_OK);
    level.surface.release();
    draw();
    await h.present();
    assert.equal(gpu.count('writeTexture'), 2, 'the unlock made it dirty again');
    assert.deepEqual([...gpu.of('writeTexture')[1].bytes], [1, 1, 1, 255]);
});

test('recorded: a whole clear is a clearing pass, a partial clear a scissored quad', async()=>{
    const h = harness();
    const { device, gpu } = h;
    // Cleared with alpha zero, as programs do: the target has no alpha channel,
    // and a transparent clear would make the presented frame see through.
    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, argb(1, 2, 3, 0), 1, 0), D3D_OK);
    assert.equal(device.Clear(1, [{ x1: 1, y1: 1, x2: 3, y2: 3 }],
        D3DCLEAR.TARGET | D3DCLEAR.ZBUFFER, argb(4, 5, 6), 0.25, 0), D3D_OK);
    await h.present();

    const pass = gpu.of('beginRenderPass')[0].descriptor;
    assert.equal(gpu.count('beginRenderPass'), 1, 'the partial clear joined the pass');
    assert.deepEqual(pass.colorAttachments[0].clearValue,
        { r: 1 / 255, g: 2 / 255, b: 3 / 255, a: 1 }, 'an X8 target clears opaque');
    assert.equal(pass.depthStencilAttachment.depthLoadOp, 'load');
    const scissors = gpu.of('setScissorRect').map((/** @type {any} */ call)=>call.rect);
    assert.deepEqual(scissors, [[0, 0, 4, 4], [0, 0, 4, 4], [1, 1, 2, 2], [0, 0, 4, 4]],
        'the pass, the viewport, the rectangle, and the viewport put back');
    assert.deepEqual(gpu.of('draw')[0].args, [6, 1, 0]);
    const descriptor = gpu.of('createRenderPipeline')[0].descriptor;
    assert.equal(descriptor.depthStencil.depthWriteEnabled, true);
    assert.equal(descriptor.depthStencil.depthCompare, 'always');
    assert.equal(descriptor.fragment.targets[0].writeMask, 0xf);
    assert.equal(h.device.diagnostics().clears, 2);
});

test('recorded: a clear of only the viewport leaves the rest of the target alone', async()=>{
    const h = harness();
    const { device, gpu } = h;
    assert.equal(device.SetViewport({ X: 0, Y: 0, Width: 2, Height: 2, MinZ: 0, MaxZ: 1 }), D3D_OK);
    assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, 0, 1, 0), D3D_OK);
    await h.present();

    assert.equal(gpu.of('beginRenderPass')[0].descriptor.colorAttachments[0].loadOp, 'load',
        'not a whole-target clear');
    assert.deepEqual(gpu.of('setScissorRect').map((/** @type {any} */ call)=>call.rect)[1],
        [0, 0, 2, 2]);
    assert.equal(gpu.count('draw'), 1);
});

test('recorded: an indexed strip is expanded to a list from the bytes the program wrote', async()=>{
    const h = harness();
    const { device, gpu } = h;
    /** @type {{ buffer?: any }} */
    const vertices = {};
    /** @type {{ buffer?: any }} */
    const indices = {};
    assert.equal(device.CreateVertexBuffer(20 * 4, 0, FVF_QUAD, D3DPOOL.DEFAULT, vertices), D3D_OK);
    assert.equal(device.CreateIndexBuffer(8, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.DEFAULT, indices),
        D3D_OK);
    /** @type {{ pBits?: number }} */
    const locked = {};
    assert.equal(indices.buffer.Lock(0, 0, locked, 0), D3D_OK);
    h.write(/** @type {number} */ (locked.pBits), new Uint8Array(Uint16Array.from([3, 2, 1, 0]).buffer));
    assert.equal(indices.buffer.Unlock(), D3D_OK);

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.SetStreamSource(0, vertices.buffer, 20), D3D_OK);
    assert.equal(device.SetIndices(indices.buffer, 7), D3D_OK);
    assert.equal(device.DrawIndexedPrimitive(D3DPT.TRIANGLESTRIP, 0, 4, 0, 2), D3D_OK);
    assert.equal(device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 3, 1, 1), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const draws = gpu.of('drawIndexed').map((/** @type {any} */ call)=>call.args);
    assert.deepEqual(draws[0], [6, 1, 0, 7], 'two triangles, from the scratch list, base kept');
    assert.deepEqual(draws[1], [3, 1, 0, 7], 'a list draws from the bound buffer');
    const bound = gpu.of('setIndexBuffer');
    assert.equal(bound[0].buffer.descriptor.label, 'scratch-indices#0');
    assert.equal(bound[0].format, 'uint16');
    assert.match(bound[1].buffer.descriptor.label, /^indices#/,
        'the generation the plain lock renamed to, which the draw was recorded against');
    assert.equal(bound[1].offset, 2, 'the start index, in bytes');
    const scratch = gpu.of('writeBuffer').find((/** @type {any} */ call)=>
        call.buffer === bound[0].buffer);
    assert.deepEqual([...new Uint16Array(scratch.bytes.buffer, scratch.bytes.byteOffset, 6)],
        [3, 2, 1, 1, 2, 0], 'the strip the program wrote, as a list');
    const pipelines = gpu.of('createRenderPipeline').map((/** @type {any} */ call)=>
        call.descriptor.primitive.topology);
    assert.deepEqual(pipelines, ['triangle-list'], 'one pipeline serves both');
    vertices.buffer.release();
    indices.buffer.release();
});

test('recorded: a fan drawn from user memory is expanded, and unbinds stream zero', async()=>{
    const h = harness();
    const { device, gpu } = h;
    /** @type {{ buffer?: any }} */
    const out = {};
    assert.equal(device.CreateVertexBuffer(80, 0, FVF_QUAD, D3DPOOL.DEFAULT, out), D3D_OK);
    assert.equal(device.SetStreamSource(0, out.buffer, 20), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLEFAN, 2, new Uint8Array(80), 20), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    assert.deepEqual(gpu.of('drawIndexed')[0].args, [6, 1, 0, 0]);
    assert.equal(gpu.of('setVertexBuffer')[0].buffer.descriptor.label, 'scratch-vertices#0');
    /** @type {{ buffer?: any, stride?: number }} */
    const stream = {};
    assert.equal(device.GetStreamSource(0, stream), D3D_OK);
    assert.equal(stream.buffer, null, 'a user-pointer draw leaves stream zero empty');
    assert.equal(stream.stride, 20, 'but the stride is not forgotten');
    out.buffer.release();
});

test('recorded: a bound shader is counted and not drawn as fixed function', async()=>{
    const h = harness();
    const { device, gpu } = h;
    /** @type {{ handle?: number }} */
    const shader = {};
    assert.equal(device.CreateVertexShader([0], null, shader), D3D_OK);
    /** @type {{ handle?: number }} */
    const pixel = {};
    assert.equal(device.CreatePixelShader([0], pixel), D3D_OK);

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(shader.handle ?? 0), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(60), 20), D3D_OK,
        'the program is told the draw succeeded');
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.SetPixelShader(pixel.handle ?? 0), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(60), 20), D3D_OK);
    assert.equal(device.SetPixelShader(0), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(60), 20), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    assert.equal(gpu.count('draw'), 1, 'only the fixed-function draw reached the pass');
    const skipped = h.device.diagnostics().skipped;
    assert.equal(skipped.vertexShader, 1, 'a vertex shader draw would be wrong geometry');
    assert.equal(skipped.pixelShader, 1, 'a pixel shader draw would be the wrong formula');
    assert.deepEqual(h.device.diagnostics().failures, []);
});

test('recorded: a stream whose stride is not the format\'s is counted, not misread', async()=>{
    const h = harness();
    const { device, gpu } = h;
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(96), 32), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    assert.equal(gpu.count('draw'), 0);
    assert.equal(h.device.diagnostics().skipped.stride, 1);
});

test('recorded: a frame with nothing drawn still presents the back buffer', async()=>{
    const h = harness();
    await h.present();
    await h.present();
    assert.equal(h.presented.length, 2);
    assert.equal(h.gpu.count('submit'), 2, 'one submit per frame, drawn or not');
    assert.equal(h.presented[0].surface, h.presented[1].surface, 'the same back buffer');
});

test('recorded: frames replay in order, one at a time, however fast Present is called', async()=>{
    const h = harness();
    const { device, gpu } = h;
    for (let frame = 0; frame < 3; frame++)
    {
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(60), 20), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        assert.equal(device.Present(), D3D_OK);
    }
    await device.idle();
    assert.equal(gpu.count('submit'), 3);
    assert.equal(gpu.count('draw'), 3);
    const order = gpu.calls.map((/** @type {any} */ call)=>call.op);
    const positions = (/** @type {string} */ op)=>order
        .map((candidate, index)=>(candidate === op ? index : -1))
        .filter(index=>index >= 0);
    const encoders = positions('createCommandEncoder');
    const submits = positions('submit');
    assert.ok(submits[0] < encoders[1] && submits[1] < encoders[2],
        'a frame is submitted before the next is encoded');
    assert.equal(h.device.diagnostics().frames, 3);
});

test('recorded: a textured draw without a sampler factory fails loudly, not white', ()=>{
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} });
    const ram = new Uint8Array(RAM_SIZE);
    const d3d = createDirect3D8({
        backend,
        readMemory: (address, length)=>ram.slice(address - RAM_BASE, address - RAM_BASE + length),
    });
    /** @type {{ device?: any }} */
    const out = {};
    assert.equal(d3d.CreateDevice({ swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1 }, out),
        D3D_OK);
    const { device } = out;
    /** @type {{ texture?: any }} */
    const texture = {};
    assert.equal(device.CreateTexture(1, 1, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, texture),
        D3D_OK);
    assert.equal(device.SetTexture(0, texture.texture), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
    assert.throws(()=>device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(84), 28),
        /sampler factory/);
    assert.throws(()=>createDirect3D8({ backend }), /readMemory/);
});
