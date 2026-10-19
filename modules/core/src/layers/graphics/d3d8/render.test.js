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
    D3DBLEND, D3DCLEAR, D3DCMP, D3DFMT, D3DFMT_INDEX, D3DFOG, D3DLIGHTTYPE, D3DLOCK, D3DMCS,
    D3DPOOL, D3DPT, D3DRS, D3DSWAPEFFECT, D3DTA, D3DTADDRESS, D3DTEXF, D3DTOP, D3DTS, D3DTSS,
    D3D_OK, D3DERR_INVALIDCALL, floatToDword,
} from './constants.js';
import { createDirect3D8 } from './device.js';
import {
    IDENTITY, LIGHT_FLOATS, UNIFORM_AT, UNIFORM_FLOATS, colorToFloats, expandTexels, eyePosition,
    gpuFormatOf,
    normalMatrixOf, viewerDirection,
    HARDWARE_SAMPLER, filledIndices, listIndices, multiplyMatrices, packLight, pipelineStateOf,
    samplerFlagsOf,
    screenExtent, transformPosition, uniformBlock, uniformsOf, pixelUniformsOf, fogModeOf, fogOf,
    addressVariantOf, clipMaskOf, clipPlanesOf, isAffine, lodBiasOf, samplerDescriptorOf,
    stageCascade,
    vertexCountOf, describeConstants, describeDeclaration,
} from './render.js';
import { parseShader } from '../d3d9/shader.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { FVF, decodeFvf } from '../webgpu/internal/vertexformat.js';
import { viewportState } from '../webgpu/internal/viewport.js';
import { pipelineDescriptor, pipelineKey } from '../webgpu/internal/pipeline.js';
import {
    clear as referenceClear, createReferenceSurface, fillRect, fogFactor,
    fogged as referenceFogged, toBase64,
} from '../webgpu/internal/reference.js';
import { generateFixedFunction } from '../webgpu/internal/fixedfunction.js';
import { FOG_SOURCE } from '../webgpu/internal/pipeline.js';
import { formatTraits } from '../webgpu/internal/textures.js';
import { D3DFMT as D3DFMT9, FORMAT_INFO, isCompressed, sampledOnes } from '../d3d9/constants.js';
import { toHalf } from '../d3d9/half.js';

/**
 * The sampler state of stage zero as the last uniform block on the queue carries it.
 *
 * @param {any} gpu the recording device
 */
function stageFlagsWritten(gpu){
    const writes = gpu.of('writeBuffer').filter((/** @type {any} */ call)=>
        call.buffer.descriptor.label.startsWith('uniforms'));
    const last = writes[writes.length - 1].bytes;
    return new DataView(last.buffer, last.byteOffset, last.byteLength)
        .getUint32(UNIFORM_AT.stage0 * 4, true);
}

/** Where the device hands out storage from; the fixture backs it with real bytes. */
const RAM_BASE = 0x40000000;
const RAM_SIZE = 32 << 20;

const FVF_QUAD = FVF.XYZRHW | FVF.DIFFUSE;
const FVF_TEXTURED_QUAD = FVF.XYZRHW | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT);

/**
 * A device with a backend over the recording GPU, and guest memory it can read.
 *
 * @param {{ width?: number, height?: number, format?: number, depth?: boolean,
 *           dumpDraws?: boolean, dumpEvery?: number, liveDump?: { dumpFrames: number,
 *               written?: (lines: string[], frame: number) => void },
 *           maxDraws?: number, fog?: boolean,
 *           mips?: boolean,
 *           probeTexture?: string,
 *           divergence?: (api: string, detail: string)=>void,
 *           skipTexture?: string, compressedTextures?: boolean,
 *           driverRules?: 'legacy' | 'current', writable?: boolean }} [options]
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
    /** @type {number[]} */
    const windows = [];
    const d3d = createDirect3D8({
        backend,
        readMemory: (address, length)=>ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        windowMemory: (address, length)=>{
            windows.push(length);
            return ram.subarray(address - RAM_BASE, address - RAM_BASE + length);
        },
        // Given, what a target holds can be read back into its memory.
        ...options.writable ? {
            writeMemory: (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>{
                ram.set(bytes, address - RAM_BASE);
            },
        } : {},
        createSampler: descriptor=>{
            const sampler = { kind: 'sampler', descriptor };
            samplers.push(sampler);
            return sampler;
        },
        dumpDraws: options.dumpDraws ?? false,
        dumpEvery: options.dumpEvery,
        liveDump: options.liveDump,
        maxDraws: options.maxDraws,
        divergence: options.divergence,
        skipTexture: options.skipTexture,
        probeTexture: options.probeTexture,
        fog: options.fog,
        mips: options.mips,
        driverRules: options.driverRules,
        compressedTextures: options.compressedTextures,
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
        windows,
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
            alphaRef: Math.round(command.uniforms[UNIFORM_AT.alphaRef] * 255),
            textureTransform: planarTransform(command.uniforms, 0),
        });
    }
    return surface;
}

/**
 * The six planar elements of a stage's texture transform, read back from the
 * rows the block carries for the shader: (m11, m21, m31) then (m12, m22, m32).
 *
 * @param {Float32Array} uniforms @param {number} stage
 */
function planarTransform(uniforms, stage){
    const at = UNIFORM_AT.textureTransforms + stage * 8;
    return [
        uniforms[at], uniforms[at + 1], uniforms[at + 2],
        uniforms[at + 4], uniforms[at + 5], uniforms[at + 6],
    ];
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

test('a back buffer copied into a system-memory surface is read back first, not copied on the GPU',
    async()=>{
        // How Wine's d3d8 tests read a pixel: CopyRects from the back buffer
        // into a system-memory texture's level, then a lock of that level. The
        // copy was made on the GPU and the level's memory stayed empty, so
        // every colour read back was black.
        const h = harness({ writable: true });
        const { device } = h;
        /** @type {{ surface?: any }} */
        const back = {};
        assert.equal(device.GetBackBuffer(0, 0, back), D3D_OK);
        /** @type {{ texture?: any }} */
        const texture = {};
        assert.equal(device.CreateTexture(4, 4, 1, 0, D3DFMT.X8R8G8B8, D3DPOOL.SYSTEMMEM, texture),
            D3D_OK);
        /** @type {{ surface?: any }} */
        const level = {};
        assert.equal(texture.texture.GetSurfaceLevel(0, level), D3D_OK);

        /** @type {{ moves?: any[] }} */
        const held = {};
        const answer = device.CopyRects(back.surface, null, 0, level.surface, null, held);
        assert.equal(typeof answer?.then, 'function', 'waits for the target to be read back');
        assert.equal(await answer, D3D_OK);
        assert.equal(held.moves?.length, 1, 'and copies through memory');
        assert.equal(held.moves?.[0].from, back.surface.base);
        assert.equal(held.moves?.[0].to, level.surface.base);

        level.surface.release();
        texture.texture.release();
        back.surface.release();
    });

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
    assert.ok(!Object.keys(h.device.diagnostics()).includes('lastFrame'),
        'the last frame, which holds live resources, is not walked when the table is posted');
    assert.deepEqual([...draw.uniforms.subarray(UNIFORM_AT.world, UNIFORM_AT.world + 16)],
        [...world], 'and the world matrix on its own, which is what lighting needs');
    assert.deepEqual(
        [...draw.uniforms.subarray(UNIFORM_AT.viewportOffset, UNIFORM_AT.viewportScale + 2)],
        [-1, -2, 2 / 2, -2 / 1],
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

    // Four bits a channel, which is what a soft glyph edge is drawn with: each
    // nibble is doubled into a byte, so the top value reaches 255 rather than
    // 240. 0x1234 is alpha 1, red 2, green 3, blue 4.
    assert.deepEqual([...expandTexels(D3DFMT.A4R4G4B4, Uint8Array.from([0x34, 0x12]), 1)],
        [0x44, 0x33, 0x22, 0x11]);
    assert.deepEqual([...expandTexels(D3DFMT.A4R4G4B4, Uint8Array.from([0xff, 0xff]), 1)],
        [255, 255, 255, 255]);
    assert.deepEqual([...expandTexels(D3DFMT.A4R4G4B4, Uint8Array.from([0x00, 0x80]), 1)],
        [0, 0, 0, 0x88], 'the top nibble is alpha');
    assert.deepEqual([...expandTexels(D3DFMT.X4R4G4B4, Uint8Array.from([0x34, 0x12]), 1)],
        [0x44, 0x33, 0x22, 255], 'an X4 texel has no alpha to sample, whatever the nibble held');

    assert.throws(()=>expandTexels(D3DFMT.A2R10G10B10, new Uint8Array(4), 1), /cannot be uploaded/);
});

test('a texture with four bits of alpha is created rather than refused', ()=>{
    // Refusing this format takes out every soft-edged glyph a program draws,
    // and what is left is a scene with no text in it.
    const { device } = harness();
    for (const format of [D3DFMT.A4R4G4B4, D3DFMT.X4R4G4B4])
    {
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateTexture(4, 4, 1, 0, format, D3DPOOL.MANAGED, out), D3D_OK,
            `format ${format.toString(16)} is one this engine can hold`);
        /** @type {{ surface?: any }} */
        const level = {};
        out.texture.GetSurfaceLevel(0, level);
        /** @type {{ desc?: any }} */
        const desc = {};
        level.surface.GetDesc(desc);
        assert.equal(desc.desc.Format, format, 'and it is stored as the format it was asked for');
        level.surface.release();
    }
});

test('byte-exact: a luminance texel fills the colour channels, its alpha its own', ()=>{
    // A glyph atlas is grey; the blend reads the colour where there is no
    // alpha and the alpha where there is, so both have to land where the
    // format puts them and nowhere else.
    assert.deepEqual([...expandTexels(D3DFMT.L8, Uint8Array.from([0x80]), 1)],
        [0x80, 0x80, 0x80, 255], 'luminance is opaque and fills b, g and r');
    assert.deepEqual([...expandTexels(D3DFMT.A8L8, Uint8Array.from([0x40, 0x20]), 1)],
        [0x40, 0x40, 0x40, 0x20], 'luminance first, alpha second');
    // One byte, low nibble luminance, high nibble alpha, each nibble doubled.
    assert.deepEqual([...expandTexels(D3DFMT.A4L4, Uint8Array.from([0xab]), 1)],
        [0xbb, 0xbb, 0xbb, 0xaa]);
});

test('a texture in a luminance format is created rather than refused', ()=>{
    // The interface and the fonts of a program of this era are kept in one of
    // these. Refusing them does not degrade the picture, it removes the text.
    const { device } = harness();
    for (const format of [D3DFMT.L8, D3DFMT.A8L8, D3DFMT.A4L4])
    {
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateTexture(4, 4, 1, 0, format, D3DPOOL.MANAGED, out), D3D_OK,
            `format ${format.toString(16)} is one this engine can hold`);
        /** @type {{ surface?: any }} */
        const level = {};
        out.texture.GetSurfaceLevel(0, level);
        /** @type {{ desc?: any }} */
        const desc = {};
        level.surface.GetDesc(desc);
        assert.equal(desc.desc.Format, format, 'and it is stored as the format it was asked for');
        level.surface.release();
        out.texture.release();
    }
});

test('byte-exact: strips and fans expand to the lists they draw, winding kept', ()=>{
    // Each triangle starts at the vertex a flat-shaded one takes its colours
    // from: a fan's first after the hub, which EXT_provoking_vertex (issue 7)
    // records as DirectX 9's, and a strip triangle's own first -- Wine's
    // test_shademode has the second triangle of a strip coloured by vertex 1.
    assert.deepEqual([...listIndices(D3DPT.TRIANGLEFAN, [0, 1, 2, 3, 4])],
        [1, 2, 0, 2, 3, 0, 3, 4, 0]);
    // The odd triangle is turned so the strip faces one way throughout, and
    // rotated so it still starts at its first vertex.
    assert.deepEqual([...listIndices(D3DPT.TRIANGLESTRIP, [0, 1, 2, 3])],
        [0, 1, 2, 1, 3, 2]);
    assert.deepEqual([...listIndices(D3DPT.LINESTRIP, [5, 6, 7])], [5, 6, 6, 7]);
    assert.ok(listIndices(D3DPT.TRIANGLEFAN, [0, 1, 70000]) instanceof Uint32Array,
        'an index past sixteen bits widens the list');
    assert.equal(vertexCountOf(D3DPT.TRIANGLESTRIP, 2), 4);
    assert.equal(vertexCountOf(D3DPT.TRIANGLELIST, 2), 6);
    assert.equal(vertexCountOf(7, 2), 0, 'not a primitive type');
    assert.equal(vertexCountOf(D3DPT.POINTLIST, 0), 0);
});

test('byte-exact: every sixteen-bit word expands to its channels widened by their top bits', ()=>{
    const words = new Uint8Array(0x10000 * 2);
    for (let word = 0; word < 0x10000; word++)
    {
        words[word * 2] = word & 0xff;
        words[word * 2 + 1] = word >>> 8;
    }
    /** @type {[number, (word: number) => number[]][]} */
    const formats = [
        [D3DFMT.R5G6B5, w=>[w & 31, (w >>> 5) & 63, w >>> 11].map((v, i)=>(i === 1
            ? (v << 2) | (v >>> 4) : (v << 3) | (v >>> 2))).concat(255)],
        [D3DFMT.X1R5G5B5, w=>[w & 31, (w >>> 5) & 31, (w >>> 10) & 31]
            .map(v=>(v << 3) | (v >>> 2)).concat(255)],
        [D3DFMT.A1R5G5B5, w=>[w & 31, (w >>> 5) & 31, (w >>> 10) & 31]
            .map(v=>(v << 3) | (v >>> 2)).concat(w & 0x8000 ? 255 : 0)],
        [D3DFMT.A4R4G4B4, w=>[w & 15, (w >>> 4) & 15, (w >>> 8) & 15, w >>> 12].map(v=>v * 17)],
        [D3DFMT.X4R4G4B4, w=>[w & 15, (w >>> 4) & 15, (w >>> 8) & 15].map(v=>v * 17).concat(255)],
    ];
    for (const [format, channels] of formats)
    {
        const out = expandTexels(format, words, 0x10000);
        for (let word = 0; word < 0x10000; word++)
        {
            const want = channels(word);
            const got = [...out.subarray(word * 4, word * 4 + 4)];
            if (got.some((value, index)=>value !== want[index]))
            {
                assert.deepEqual(got, want, `format ${format}, word 0x${word.toString(16)}`);
            }
        }
    }
});

test('a strip or fan of any length and index width expands as triangle by triangle', ()=>{
    // The rewrite writes straight into a typed array; this is the same lists
    // spelt out one primitive at a time, over lengths and widths at random.
    let seed = 0x2545f491;
    const random = ()=>{
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return (seed >>> 0) / 0x100000000;
    };
    /** @param {number} type @param {number[]} order */
    const spelt = (type, order)=>{
        /** @type {number[]} */
        const out = [];
        const step = type === D3DPT.LINESTRIP ? 2 : 3;
        for (let first = 0; first + step - 1 < order.length; first++)
        {
            out.push(...(type === D3DPT.LINESTRIP ? [order[first], order[first + 1]]
                : type === D3DPT.TRIANGLEFAN ? (first + 2 < order.length
                    ? [order[first + 1], order[first + 2], order[0]] : [])
                    : first % 2 === 0 ? [order[first], order[first + 1], order[first + 2]]
                        : [order[first], order[first + 2], order[first + 1]]));
        }
        return out;
    };
    for (let round = 0; round < 300; round++)
    {
        const type = [D3DPT.LINESTRIP, D3DPT.TRIANGLESTRIP, D3DPT.TRIANGLEFAN][round % 3];
        const length = Math.floor(random() * 40);
        const limit = random() < 0.2 ? 0x20000 : 0x10000;
        const order = Array.from({ length }, ()=>Math.floor(random() * limit));
        const narrow = round % 2 === 0 && limit === 0x10000;
        const list = listIndices(type, narrow ? Uint16Array.from(order) : order);
        assert.deepEqual([...list], spelt(type, order), `round ${round}`);
        assert.equal(list instanceof Uint32Array, order.some(index=>index > 0xffff),
            `round ${round}: wide only past sixteen bits`);
    }
});

test('byte-exact: triangles under a fill mode become their edges or their vertices', ()=>{
    // D3DFILL_WIREFRAME draws each triangle's three edges and D3DFILL_POINT
    // its three vertices (Microsoft's D3DFILLMODE), whatever type of
    // triangles they are.
    assert.deepEqual([...filledIndices(D3DPT.TRIANGLELIST, [0, 1, 2, 3, 4, 5], 2)],
        [0, 1, 1, 2, 2, 0, 3, 4, 4, 5, 5, 3]);
    assert.deepEqual([...filledIndices(D3DPT.TRIANGLESTRIP, [0, 1, 2, 3], 2)],
        [0, 1, 1, 2, 2, 0, 1, 3, 3, 2, 2, 1]);
    assert.deepEqual([...filledIndices(D3DPT.TRIANGLEFAN, [0, 1, 2, 3], 1)],
        [1, 2, 0, 2, 3, 0]);
    assert.deepEqual([...filledIndices(D3DPT.TRIANGLELIST, [7, 8, 9, 10], 1)], [7, 8, 9],
        'an incomplete triangle draws nothing');
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

test('recorded: an unlocked buffer is read through a window, not a copy', async()=>{
    // The bytes go straight into the staging copy the GPU gets, so the read
    // needs no copy of its own; a program that refills its buffers every draw
    // made that copy a measured share of a frame.
    const h = harness();
    const { device, gpu } = h;
    /** @type {{ buffer?: any }} */
    const out = {};
    assert.equal(device.CreateVertexBuffer(60, 0, FVF_QUAD, D3DPOOL.DEFAULT, out), D3D_OK);
    /** @type {{ pBits?: number }} */
    const locked = {};
    assert.equal(out.buffer.Lock(0, 0, locked, D3DLOCK.DISCARD), D3D_OK);
    h.write(/** @type {number} */ (locked.pBits), quad([0, 0, 4, 4], 0).subarray(0, 60));
    assert.equal(out.buffer.Unlock(), D3D_OK);
    assert.deepEqual(h.windows, [60], 'the unlock read the sixty bytes through a window');
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.SetStreamSource(0, out.buffer, 20), D3D_OK);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    const written = gpu.of('writeBuffer').find((/** @type {any} */ call)=>call.bytes?.length === 60);
    assert.ok(written, 'and the bytes reached the GPU');
    assert.deepEqual([...written.bytes], [...quad([0, 0, 4, 4], 0).subarray(0, 60)]);
});

test('a buffer released for the last time gives its GPU buffer back once no stream binds it',
    async()=>{
        // A program that makes and drops buffers while it loads kept every
        // one's GPU buffer and staging copy for the rest of the run.
        const h = harness();
        const { device, backend } = h;
        const held = ()=>backend.diagnostics().buffers.length;
        const before = held();
        /** @type {{ buffer?: any }} */
        const out = {};
        assert.equal(device.CreateVertexBuffer(60, 0, FVF_QUAD, D3DPOOL.DEFAULT, out), D3D_OK);
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(out.buffer.Lock(0, 0, locked, 0), D3D_OK);
        h.write(/** @type {number} */ (locked.pBits), quad([0, 0, 4, 4], 0).subarray(0, 60));
        assert.equal(out.buffer.Unlock(), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
        assert.equal(device.SetStreamSource(0, out.buffer, 20), D3D_OK);
        assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        assert.equal(held(), before + 1);
        assert.equal(out.buffer.release(), 0);
        await h.present();
        assert.equal(held(), before + 1, 'still bound to stream 0, it stays');
        assert.equal(device.SetStreamSource(0, null, 0), D3D_OK);
        await h.present();
        assert.equal(held(), before, 'unbound, it goes');
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

test('recorded: two draws with different transforms in one pass get their own offsets', async()=>{
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

    const writes = gpu.of('writeBuffer').filter((/** @type {any} */ call)=>
        call.buffer.descriptor.label.startsWith('uniforms'));
    assert.equal(writes.length, 1, 'both blocks reach the ring in one write, before the submit');
    const bound = gpu.of('setBindGroup');
    const blocks = bound.map((/** @type {any} */ call)=>call.resolved[0]);
    assert.equal(blocks[0].buffer, blocks[1].buffer, 'one ring');
    assert.notEqual(blocks[0].offset, blocks[1].offset,
        'one block rewritten twice would show both draws the second matrix');
    /** @param {any} block */
    const worldX = block=>new Float32Array(block.range.buffer, block.range.byteOffset, 16)[12];
    assert.equal(worldX(blocks[0]), 0);
    assert.equal(worldX(blocks[1]), 5);
    assert.equal(bound[0].group, bound[1].group, 'and both draws bound the one group');
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

test('recorded: a draw after a DISCARD reads the vertices written before it', async()=>{
    // A program fills the end of its ring, wraps the ring with DISCARD for the
    // next batch, and only then draws what it filled first. The bytes are in
    // its memory, as they stay in a driver's when the memory is handed back,
    // and the GPU has to draw them: a backing out of the pool held another
    // generation's there, which is what drew a sky in pieces.
    const h = harness({ width: 640, height: 480, dumpDraws: true });
    const { device } = h;
    /** @type {{ buffer?: any }} */
    const out = {};
    assert.equal(device.CreateVertexBuffer(1200, 0, FVF_QUAD, D3DPOOL.DEFAULT, out), D3D_OK);
    /** @param {number} at @param {Uint8Array} bytes @param {number} flags */
    const fill = (at, bytes, flags)=>{
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(out.buffer.Lock(at, bytes.length, locked, flags), D3D_OK);
        h.write(/** @type {number} */ (locked.pBits), bytes);
        assert.equal(out.buffer.Unlock(), D3D_OK);
    };
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.SetStreamSource(0, out.buffer, 20), D3D_OK);

    // A generation the GPU has drawn from, retired to the pool by the next.
    assert.equal(device.BeginScene(), D3D_OK);
    fill(0, quad([0, 0, 40, 40], argb(255, 0, 0, 255)), D3DLOCK.DISCARD);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 2), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    assert.equal(device.BeginScene(), D3D_OK);
    fill(0, quad([0, 0, 40, 40], argb(255, 0, 0, 255)), D3DLOCK.DISCARD);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 2), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    // The end of the ring, the wrap, then the draw of the end.
    assert.equal(device.BeginScene(), D3D_OK);
    fill(960, quad([10, 20, 110, 70], argb(255, 0, 255, 0)), D3DLOCK.NOOVERWRITE);
    fill(0, quad([0, 0, 40, 40], argb(255, 255, 0, 0)), D3DLOCK.DISCARD);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 48, 2), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const dumped = device.diagnostics().lastDump;
    assert.match(dumped[0], /^#0 10,20\.\.110,70 /, 'the quad written before the wrap');
    assert.match(dumped[0], / gpu=same /, 'drawn from the bytes the program wrote');
    out.buffer.release();
});

test('recorded: a draw after a DISCARD keeps its bytes when the ring reaches them again in the '
    + 'frame', async()=>{
    // A program fills the end of its ring, wraps it with DISCARD, draws
    // what it filled first, and before the frame ends its NOOVERWRITE
    // locks reach those bytes again. A frame's draws read at its submit,
    // after every write it made, where a driver has long drawn them.
    const h = harness({ width: 640, height: 480, dumpDraws: true });
    const { device } = h;
    /** @type {{ buffer?: any }} */
    const out = {};
    assert.equal(device.CreateVertexBuffer(1200, 0, FVF_QUAD, D3DPOOL.DEFAULT, out), D3D_OK);
    /** @param {number} at @param {Uint8Array} bytes @param {number} flags */
    const fill = (at, bytes, flags)=>{
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(out.buffer.Lock(at, bytes.length, locked, flags), D3D_OK);
        h.write(/** @type {number} */ (locked.pBits), bytes);
        assert.equal(out.buffer.Unlock(), D3D_OK);
    };
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.SetStreamSource(0, out.buffer, 20), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    fill(960, quad([10, 20, 110, 70], argb(255, 0, 255, 0)), D3DLOCK.NOOVERWRITE);
    fill(0, quad([0, 0, 40, 40], argb(255, 255, 0, 0)), D3DLOCK.DISCARD);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 48, 2), D3D_OK);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 2), D3D_OK);
    fill(940, quad([200, 200, 300, 300], argb(255, 255, 255, 0)), D3DLOCK.NOOVERWRITE);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 47, 2), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const dumped = device.diagnostics().lastDump;
    assert.match(dumped[0], /^#0 10,20\.\.110,70 /, 'the quad written before the wrap');
    assert.match(dumped[0], / gpu=same /, 'drawn from the bytes it was drawn with');
    assert.match(dumped[2], /^#2 200,200\.\.300,300 .* gpu=same /,
        'and the one written over them from its own');
    out.buffer.release();
});

test('recorded: NOOVERWRITE with DISCARD is NOOVERWRITE, and the buffer is not renamed', async()=>{
    // Wine's d3d8 and d3d9 test_map_synchronisation have
    // D3DLOCK_NOOVERWRITE | D3DLOCK_DISCARD lock unsynchronised, as
    // NOOVERWRITE alone does: the program promises not to touch what a draw
    // reads, and the contents outside the locked range are kept. Taken as a
    // DISCARD the buffer was renamed and everything outside the range lost.
    const h = harness();
    const { device, gpu } = h;
    /** @type {{ buffer?: any }} */
    const out = {};
    assert.equal(device.CreateVertexBuffer(1024, 0, FVF_QUAD, D3DPOOL.DEFAULT, out), D3D_OK);
    /** @param {number} at @param {number} value @param {number} flags */
    const fill = (at, value, flags)=>{
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(out.buffer.Lock(at, 60, locked, flags), D3D_OK);
        h.write(/** @type {number} */ (locked.pBits), new Uint8Array(60).fill(value));
        assert.equal(out.buffer.Unlock(), D3D_OK);
    };

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.SetStreamSource(0, out.buffer, 20), D3D_OK);
    fill(0, 1, D3DLOCK.DISCARD);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
    fill(60, 2, D3DLOCK.DISCARD | D3DLOCK.NOOVERWRITE);
    assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 3, 1), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const bound = gpu.of('setVertexBuffer').map((/** @type {any} */ call)=>call.buffer);
    // A rename between them would bind another buffer for the second draw.
    assert.equal(new Set(bound).size, 1, 'one generation serves both draws');
    out.buffer.release();
});

test('recorded: a lock with neither flag sends only the locked range when no draw has read it',
    async()=>{
        // A program that fills a range and then draws from it is the ordinary
        // case: nothing has observed the bytes yet, so the write goes into the
        // live backing and only the range the guest named travels.
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
        // Both ranges merged into the one dirty extent [100, 220), aligned
        // outward: no rename happened, so there was nothing else to carry.
        assert.equal(writes.length, 1);
        assert.equal(writes[0].size, 120);
        assert.equal(writes[0].bufferOffset, 100);
        out.buffer.release();
    });

test('recorded: a lock with neither flag after a draw renames, and carries the rest on the GPU',
    async()=>{
        // The draw already recorded reads the bytes the lock overwrites, so the
        // backing has to be renamed and its contents carried into the new one,
        // because the old bytes stay observable through it -- by a copy on the
        // GPU, with only the locked range travelling.
        const h = harness();
        const { device, gpu } = h;
        /** @type {{ buffer?: any }} */
        const out = {};
        assert.equal(device.CreateVertexBuffer(1024, 0, FVF_QUAD, D3DPOOL.DEFAULT, out), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
        assert.equal(device.SetStreamSource(0, out.buffer, 20), D3D_OK);
        assert.equal(device.DrawPrimitive(D3DPT.TRIANGLELIST, 0, 1), D3D_OK);
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(out.buffer.Lock(100, 20, locked, 0), D3D_OK);
        h.write(/** @type {number} */ (locked.pBits), new Uint8Array(20).fill(7));
        assert.equal(out.buffer.Unlock(), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();

        // The draw was replayed against the generation that existed when it was
        // recorded, which is the one the lock had to retire.
        const drawn = gpu.of('setVertexBuffer').at(-1).buffer;
        const writes = gpu.of('writeBuffer').filter((/** @type {any} */ call)=>
            call.buffer.descriptor.label.startsWith('vertices'));
        assert.equal(writes.length, 1);
        assert.equal(writes[0].size, 20, 'only the locked range travels');
        assert.notEqual(writes[0].buffer, drawn, 'through a renamed backing');
        const copies = gpu.of('copyBufferToBuffer');
        assert.deepEqual(copies.map((/** @type {any} */ copy)=>[copy.sourceOffset, copy.size]),
            [[0, 100], [120, 904]], 'the rest is carried from the backing the draw read');
        assert.ok(copies.every((/** @type {any} */ copy)=>copy.source === drawn
            && copy.destination === writes[0].buffer));
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

test('recorded: a stale texture argument the operation never reads keeps the cascade',
    async()=>{
        // Stage state persists across draws, so an unread slot holds whatever
        // an earlier draw left in it. Counting it as a demand for a texture cut
        // the cascade at a stage that never wanted one, and the draw lost its
        // texturing while the rest of the picture stayed right.
        /** @type {string[]} */
        const said = [];
        const h = harness({
            width: 640, height: 480, dumpDraws: true,
            divergence: (api, detail)=>said.push(`${api}: ${detail}`),
        });
        const { device } = h;
        device.SetTextureStageState(0, D3DTSS.COLOROP, D3DTOP.SELECTARG1);
        device.SetTextureStageState(0, D3DTSS.COLORARG1, D3DTA.DIFFUSE);
        device.SetTextureStageState(0, D3DTSS.COLORARG2, D3DTA.TEXTURE);
        device.SetTextureStageState(0, D3DTSS.ALPHAOP, D3DTOP.SELECTARG1);
        device.SetTextureStageState(0, D3DTSS.ALPHAARG1, D3DTA.DIFFUSE);
        device.SetTextureStageState(0, D3DTSS.ALPHAARG2, D3DTA.TEXTURE);

        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(
            D3DPT.TRIANGLELIST, 2, quad([10, 20, 110, 70], argb(255, 0, 0)), 20), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();

        const diagnostics = device.diagnostics();
        assert.deepEqual(diagnostics.cascade,
            { noTexture: 0, noCoordSet: 0, truncations: [] });
        assert.deepEqual(said, []);
        assert.ok(diagnostics.lastDump[0].includes(
            ` [${D3DTOP.SELECTARG1}(${D3DTA.DIFFUSE},${D3DTA.TEXTURE})`),
        'the stage ran, with the stale argument still in the slot nothing reads');
        assert.doesNotMatch(diagnostics.lastDump[0], / cut=/);
    });

test('recorded: an operation reading a texture nobody bound is counted, not reported', async()=>{
    // It passes the current colour on, as Windows does, which is no
    // divergence; the count is what tells a layer passed over from one drawn.
    /** @type {string[]} */
    const said = [];
    const h = harness({
        width: 640, height: 480, dumpDraws: true,
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
    });
    const { device } = h;
    selectTexture(device);

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(
        D3DPT.TRIANGLELIST, 2, quad([10, 20, 110, 70], argb(255, 0, 0)), 20), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const diagnostics = device.diagnostics();
    assert.equal(diagnostics.cascade.noTexture, 1);
    assert.equal(diagnostics.cascade.truncations.length, 1);
    assert.match(diagnostics.cascade.truncations[0], /^stage 0 texture: /);
    assert.deepEqual(said, []);
    assert.match(diagnostics.lastDump[0], / cut=0\/texture\//);
});

test('recorded: a second stage reusing coordinate set zero is not cut for its own number',
    async()=>{
        // One set in the vertex and two stages naming it is how a detail pass
        // is written. Comparing the stage's own number against the sets the
        // vertex carries lost every stage past the first.
        const h = harness({ width: 640, height: 480, dumpDraws: true });
        const { device, gpu } = h;
        const texture = textureFrom(h, 1, 1, D3DFMT.A8R8G8B8, Uint8Array.from([1, 2, 3, 4]));
        assert.equal(device.SetTexture(0, texture), D3D_OK);
        assert.equal(device.SetTexture(1, texture), D3D_OK);
        selectTexture(device);
        device.SetTextureStageState(1, D3DTSS.COLOROP, D3DTOP.MODULATE);
        device.SetTextureStageState(1, D3DTSS.COLORARG1, D3DTA.TEXTURE);
        device.SetTextureStageState(1, D3DTSS.COLORARG2, D3DTA.CURRENT);
        device.SetTextureStageState(1, D3DTSS.ALPHAOP, D3DTOP.SELECTARG1);
        device.SetTextureStageState(1, D3DTSS.ALPHAARG1, D3DTA.CURRENT);
        device.SetTextureStageState(1, D3DTSS.TEXCOORDINDEX, 0);

        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(84), 28),
            D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();

        const diagnostics = device.diagnostics();
        assert.equal(diagnostics.cascade.noCoordSet, 0);
        assert.doesNotMatch(diagnostics.lastDump[0], / cut=/);
        const code = gpu.of('createShaderModule')[0].descriptor.code;
        assert.match(code, /sampleStage1\(input\.texCoord0\)/,
            'stage one samples the set it named, not the set of its own number');
    });

test('recorded: a stage generating its coordinates is not cut for the set the vertex lacks',
    async()=>{
        // A vertex of position and colour alone, textured by where it is in
        // camera space through a three-coordinate transform: the cascade
        // runs, the block carries world-view and all four rows of the
        // transform, and nothing is reported as unapplied.
        /** @type {string[]} */
        const said = [];
        const h = harness({
            width: 640, height: 480, dumpDraws: true,
            divergence: (api, detail)=>said.push(`${api}: ${detail}`),
        });
        const { device, gpu } = h;
        const texture = textureFrom(h, 1, 1, D3DFMT.A8R8G8B8, Uint8Array.from([1, 2, 3, 4]));
        assert.equal(device.SetTexture(0, texture), D3D_OK);
        selectTexture(device);
        device.SetTextureStageState(0, D3DTSS.TEXCOORDINDEX, 0x20000);
        device.SetTextureStageState(0, D3DTSS.TEXTURETRANSFORMFLAGS, 3);
        assert.equal(device.SetTransform(D3DTS.TEXTURE0, [
            0.5, 0, 0, 0,
            0, -0.5, 0, 0,
            0, 0, 1, 0,
            0.25, 0.75, 0, 1,
        ]), D3D_OK);
        assert.equal(device.SetTransform(D3DTS.VIEW, [
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 5, 1,
        ]), D3D_OK);

        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF.XYZ | FVF.DIFFUSE), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(48), 16),
            D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();

        const diagnostics = device.diagnostics();
        assert.equal(diagnostics.cascade.noCoordSet, 0);
        assert.doesNotMatch(diagnostics.lastDump[0], / cut=/);
        assert.deepEqual(said, []);
        const code = gpu.of('createShaderModule')[0].descriptor.code;
        assert.match(code, /sampleStage0\(input\.generated0\)/);
        assert.match(code, /uniforms\.worldView \* vec4f\(vertex\.position, 1\.0\)/);
        const draw = diagnostics.lastFrame.find((/** @type {any} */ c)=>c.kind === 'draw');
        assert.deepEqual([...draw.uniforms.subarray(
            UNIFORM_AT.textureTransforms, UNIFORM_AT.textureTransforms + 16)],
        [0.5, 0, 0, 0.25, 0, -0.5, 0, 0.75, 0, 0, 1, 0, 0, 0, 0, 1]);
        assert.deepEqual([...draw.uniforms.subarray(
            UNIFORM_AT.worldView + 12, UNIFORM_AT.worldView + 16)], [0, 0, 5, 1],
        'the view\'s translation is in the world-view the coordinate is taken in');
    });

test('recorded: a sampler follows the stage filter and address states', async()=>{
    const h = harness();
    const { device, gpu } = h;
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

    // One hardware sampler for every draw, whatever the stage asked: the
    // request travels in the block and the shader applies it. A device was
    // measured keeping one sampler in force for every draw of a run no matter
    // which group each draw bound, so nothing in the picture may depend on it.
    assert.equal(h.samplers.length, 1);
    assert.deepEqual(h.samplers[0].descriptor,
        { label: h.samplers[0].descriptor.label, ...HARDWARE_SAMPLER });
    const flags = stageFlagsWritten(gpu);
    assert.equal(flags & 3, 2, 'u clamps');
    assert.equal((flags >> 2) & 3, 1, 'v mirrors');
    assert.equal((flags >> 4) & 1, 0, 'magnification is linear');
    assert.equal((flags >> 5) & 1, 1, 'minification is point, the default');
    assert.equal((flags >> 6) & 3, 0, 'no mip filter: the top level alone');
});

test('the sampler state packs as the shader unpacks it', ()=>{
    // Unit. Each field lands in its own bits, and MIPFILTER off pins the top
    // level whatever the mip filter says.
    const states = new Map([
        [D3DTSS.ADDRESSU, D3DTADDRESS.MIRROR], [D3DTSS.ADDRESSV, D3DTADDRESS.CLAMP],
        [D3DTSS.MAGFILTER, D3DTEXF.POINT], [D3DTSS.MINFILTER, D3DTEXF.LINEAR],
        [D3DTSS.MIPFILTER, D3DTEXF.LINEAR], [D3DTSS.MAXMIPLEVEL, 3],
    ]);
    assert.equal(samplerFlagsOf(states), 1 | (2 << 2) | (1 << 4) | (0 << 5) | (2 << 6) | (3 << 8));
    assert.equal((samplerFlagsOf(states, false) >> 6) & 3, 0, 'mips off: no mip mode');
    assert.equal(samplerFlagsOf(new Map()), 1 << 4 | 1 << 5, 'the defaults: wrap, point, no mips');
    assert.equal(samplerFlagsOf(new Map([[D3DTSS.ADDRESSW, D3DTADDRESS.CLAMP]])) >>> 16, 2,
        'a volume\'s third address mode above the rest');
});

test('border and mirror-once clamp on the GPU and are the sample\'s variant, by axis', ()=>{
    const states = new Map(/** @type {[number, number][]} */ ([
        [D3DTSS.ADDRESSU, D3DTADDRESS.MIRRORONCE], [D3DTSS.ADDRESSV, D3DTADDRESS.BORDER],
        [D3DTSS.ADDRESSW, D3DTADDRESS.MIRRORONCE], [D3DTSS.BORDERCOLOR, 0x11223344]]));
    const get = (/** @type {number} */ state)=>states.get(state) ?? 0;
    assert.equal(samplerFlagsOf(states) & 0xf, 2 | (2 << 2), 'both clamp in the flags');
    assert.equal(samplerFlagsOf(states) >>> 16, 2);
    const descriptor = samplerDescriptorOf(states);
    assert.deepEqual([descriptor.addressModeU, descriptor.addressModeV, descriptor.addressModeW],
        ['clamp-to-edge', 'clamp-to-edge', 'clamp-to-edge']);
    assert.deepEqual(addressVariantOf(get, '2d'),
        { mirrorOnce: 1, border: { mask: 2, colour: 0x11223344 } }, 'no w on a flat texture');
    assert.deepEqual(addressVariantOf(get, '3d'),
        { mirrorOnce: 5, border: { mask: 2, colour: 0x11223344 } });
    assert.deepEqual(addressVariantOf(get, 'cube'), {}, 'a cube\'s faces are not addressed');
    assert.deepEqual(addressVariantOf(()=>D3DTADDRESS.CLAMP, '3d'), {});
});

test('the enabled clip planes, in index order, go through a matrix into the vertex\'s own space',
    ()=>{
        const planes = new Map([[0, [1, 0, 0, 0]], [2, [0, 1, 0, -2]], [5, [0, 0, 1, 0.5]]]);
        const model = /** @type {any} */ ({ renderStates: new Map([[152, 0b100101]]),
            clipPlanes: planes });
        assert.equal(clipMaskOf(model), 0b100101);
        assert.deepEqual([...clipPlanesOf(model, 0b100101, null)],
            [1, 0, 0, 0, 0, 1, 0, -2, 0, 0, 1, 0.5], 'as set, for a vertex shader');
        // A world that scales x by two and moves y by three: a point p of the
        // model is at (2 p.x, p.y + 3, p.z) in the world, and y = 2 there --
        // plane 2 -- is y = -1 here.
        const world = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1];
        const object = clipPlanesOf(model, 0b000100, world);
        assert.deepEqual([...object], [0, 1, 0, 1]);
        const point = [5, -1, 7, 1];
        assert.equal(object.reduce((sum, value, at)=>sum + value * point[at], 0), 0,
            'a model point on the plane is on it in the world');
        // D3DRS_CLIPPING off clips by no plane at all; a device that keeps no
        // planes clips by none either.
        assert.equal(clipMaskOf({ ...model, renderStates: new Map([[152, 1], [136, 0]]) }), 0);
        assert.equal(clipMaskOf({ ...model, clipPlanes: undefined }), 0);
        assert.equal(clipMaskOf({ ...model, renderStates: new Map([[152, 0xffff]]) }), 0x3f,
            'six planes and no more');
    });

test('recorded: a Direct3D 8 draw is clipped by the planes D3DRS_CLIPPLANEENABLE turns on',
    async()=>{
        const h = harness();
        const { device, gpu } = h;
        assert.equal(device.SetClipPlane(2, [0, 0, 1, -1]), D3D_OK);
        assert.equal(device.SetRenderState(D3DRS.CLIPPLANEENABLE, 0b100), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF.XYZ | FVF.DIFFUSE), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(48), 16),
            D3D_OK);
        // Pre-transformed vertices are not clipped by the planes.
        assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(60), 20),
            D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
        const modules = gpu.of('createShaderModule').map((/** @type {any} */ call)=>
            /** @type {string} */ (call.descriptor.code));
        assert.equal(modules.filter(code=>code.includes('out.clip0 = vec4f(dot(uniforms'
            + '.clipPlane[0], vec4f(vertex.position, 1.0)), 1.0, 1.0, 1.0);')).length, 1);
        assert.equal(modules.filter(code=>code.includes('clipPlane')).length, 1);
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

test('recorded: a texture rewritten after a draw sampled it reaches only the draws after the write',
    async()=>{
        // Each draw samples the texels as they stood when it was made. The
        // queue runs a direct write before a frame not yet submitted, so a
        // write after a draw of that frame has to keep its place in it.
        const h = harness();
        const { device, gpu } = h;
        const texture = textureFrom(h, 1, 1, D3DFMT.X8R8G8B8, Uint8Array.from([9, 8, 7, 0]));
        assert.equal(device.SetTexture(0, texture), D3D_OK);
        selectTexture(device);
        assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
        const draw = ()=>{
            assert.equal(device.BeginScene(), D3D_OK);
            assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(84), 28),
                D3D_OK);
            assert.equal(device.EndScene(), D3D_OK);
        };
        /** @param {number} value */
        const write = value=>{
            /** @type {{ pBits?: number }} */
            const locked = {};
            assert.equal(texture.LockRect(0, locked, null, 0), D3D_OK);
            h.write(/** @type {number} */ (locked.pBits), Uint8Array.from([value, value, value, 0]));
            assert.equal(texture.UnlockRect(0), D3D_OK);
        };
        const order = ()=>gpu.calls.map((/** @type {any} */ call)=>call.op)
            .filter((/** @type {string} */ op)=>/^(writeTexture|copyBufferToTexture|draw|submit)$/
                .test(op));

        draw();
        write(1);
        draw();
        await h.present();
        assert.deepEqual(order(), ['writeTexture', 'draw', 'copyBufferToTexture', 'draw', 'submit'],
            'the second write lands between the two draws');

        // The next frame is recorded before this one reaches the queue.
        draw();
        assert.equal(device.Present(), D3D_OK);
        write(2);
        draw();
        await h.present();
        assert.deepEqual(order().slice(5),
            ['draw', 'submit', 'copyBufferToTexture', 'draw', 'submit'],
            'a frame still waiting for the queue does not see the next frame\'s write');

        // Once nothing unsubmitted samples it, a write goes straight to the queue.
        write(3);
        draw();
        await h.present();
        assert.deepEqual(order().slice(10), ['writeTexture', 'draw', 'submit']);
    });

test('recorded: a managed texture keeps its GPU copy through a lock that promised no change',
    async()=>{
        // Wine's d3d8 add_dirty_rect_test: a managed texture's read-only and
        // NO_DIRTY_UPDATE locks are not uploaded, and AddDirtyRect uploads
        // what they wrote; a default-pool texture's lock always is.
        const h = harness();
        const { device, gpu } = h;
        const texture = textureFrom(h, 1, 1, D3DFMT.X8R8G8B8, Uint8Array.from([9, 8, 7, 0]));
        assert.equal(device.SetTexture(0, texture), D3D_OK);
        selectTexture(device);
        assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
        const draw = async()=>{
            assert.equal(device.BeginScene(), D3D_OK);
            assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(84), 28),
                D3D_OK);
            assert.equal(device.EndScene(), D3D_OK);
            await h.present();
            return gpu.count('writeTexture');
        };
        /** @param {any} target @param {number} flags @param {number} value */
        const write = (target, flags, value)=>{
            /** @type {{ pBits?: number }} */
            const locked = {};
            assert.equal(target.LockRect(0, locked, null, flags), D3D_OK);
            h.write(/** @type {number} */ (locked.pBits), Uint8Array.from([value, value, value, 0]));
            assert.equal(target.UnlockRect(0), D3D_OK);
        };
        assert.equal(await draw(), 1);
        write(texture, D3DLOCK.READONLY, 1);
        write(texture, 0x8000, 2);
        assert.equal(await draw(), 1, 'neither lock went up');
        assert.equal(texture.AddDirtyRect(null), D3D_OK);
        assert.equal(await draw(), 2, 'AddDirtyRect sends what they wrote');
        assert.deepEqual([...gpu.of('writeTexture')[1].bytes], [2, 2, 2, 255]);

        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateTexture(1, 1, 1, 0x200, D3DFMT.X8R8G8B8, D3DPOOL.DEFAULT, out),
            D3D_OK);
        assert.equal(device.SetTexture(0, out.texture), D3D_OK);
        write(out.texture, 0, 3);
        assert.equal(await draw(), 3);
        write(out.texture, 0x8000, 4);
        assert.equal(await draw(), 4, 'a dynamic texture\'s lock is its texture');
    });

test('recorded: a chain of levels goes up level by level, into a texture with that many',
    async()=>{
        // A far surface sampled from its top level alone aliases, and the
        // aliasing moves with every fraction of a texel the camera moves. So
        // the chain a program fills is the chain the device holds, each level
        // at its own size, and a level written again goes up again on its own.
        const h = harness();
        const { device, gpu } = h;
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateTexture(4, 4, 3, 0, D3DFMT.X8R8G8B8, D3DPOOL.MANAGED, out),
            D3D_OK);
        const texture = out.texture;
        /** @param {number} level @param {number} value */
        const fill = (level, value)=>{
            /** @type {{ pBits?: number }} */
            const locked = {};
            assert.equal(texture.LockRect(level, locked, null, 0), D3D_OK);
            const extent = Math.max(1, 4 >> level);
            h.write(/** @type {number} */ (locked.pBits),
                new Uint8Array(extent * extent * 4).fill(value));
            assert.equal(texture.UnlockRect(level), D3D_OK);
        };
        fill(0, 10);
        fill(1, 20);
        fill(2, 30);
        assert.equal(device.SetTexture(0, texture), D3D_OK);
        selectTexture(device);
        assert.equal(device.SetTextureStageState(0, D3DTSS.MIPFILTER, D3DTEXF.LINEAR), D3D_OK);
        const draw = ()=>{
            assert.equal(device.BeginScene(), D3D_OK);
            assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
            assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(84), 28),
                D3D_OK);
            assert.equal(device.EndScene(), D3D_OK);
        };
        draw();
        await h.present();

        const made = gpu.of('createTexture').find(
            (/** @type {any} */ call)=>call.descriptor.label === 'texture');
        assert.equal(made.descriptor.mipLevelCount, 3);
        /** @param {any} call */
        const shape = call=>[call.destination.mipLevel, call.size.width, call.size.height,
            call.bytes[0]];
        const uploads = ()=>gpu.of('writeTexture')
            .filter((/** @type {any} */ call)=>call.destination.texture === made.texture)
            .map(shape);
        assert.deepEqual(uploads(), [[0, 4, 4, 10], [1, 2, 2, 20], [2, 1, 1, 30]]);
        assert.equal((stageFlagsWritten(gpu) >> 6) & 3, 2,
            'a linear mip filter, applied in the shader');

        // One level written again is one level sent again.
        fill(1, 40);
        draw();
        await h.present();
        assert.deepEqual(uploads().slice(3), [[1, 2, 2, 40]]);

        // No mip filter means the top level alone, whatever the chain holds.
        assert.equal(device.SetTextureStageState(0, D3DTSS.MIPFILTER, D3DTEXF.NONE), D3D_OK);
        draw();
        await h.present();
        assert.equal((stageFlagsWritten(gpu) >> 6) & 3, 0, 'no mip mode: the top level alone');

        // The record says which levels the program wrote and what the smallest
        // hold, because a far surface is sampled out of those and nothing else
        // says what they are.
        const record = device.diagnostics().textureRecords.find(
            (/** @type {any} */ entry)=>entry.width === 4 && entry.levels === 3);
        assert.deepEqual(record.written, [0, 1, 2]);
        assert.deepEqual(Object.keys(record.tails), ['0', '1', '2'], 'a 4x4 top is small enough');
        assert.deepEqual(record.tails[2].slice(0, 4), [30, 30, 30, 255]);
    });

test('mips can be switched off for a run, and every sample comes from the top level', async()=>{
    // Recorded commands. The knob exists so two runs differ by the mip chain
    // and nothing else; it has to reach the sampler, or the runs are one.
    const h = harness({ mips: false });
    const { device, gpu } = h;
    /** @type {{ texture?: any }} */
    const out = {};
    assert.equal(device.CreateTexture(4, 4, 3, 0, D3DFMT.X8R8G8B8, D3DPOOL.MANAGED, out), D3D_OK);
    assert.equal(device.SetTexture(0, out.texture), D3D_OK);
    selectTexture(device);
    assert.equal(device.SetTextureStageState(0, D3DTSS.MIPFILTER, D3DTEXF.LINEAR), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(84), 28), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    assert.equal((stageFlagsWritten(gpu) >> 6) & 3, 0,
        'the top level alone, whatever the program asked');
});

test('recorded: a managed texture\'s level of detail is the finest level a sample reaches',
    async()=>{
        // Wine's d3d9 maxmip_test: the finer of MAXMIPLEVEL and the texture's
        // own LOD limits the sample, and a LOD set between two draws of one
        // state is the second draw's.
        const h = harness();
        const { device, gpu } = h;
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateTexture(4, 4, 3, 0, D3DFMT.X8R8G8B8, D3DPOOL.MANAGED, out),
            D3D_OK);
        const texture = out.texture;
        assert.equal(device.SetTexture(0, texture), D3D_OK);
        selectTexture(device);
        assert.equal(device.SetTextureStageState(0, D3DTSS.MIPFILTER, D3DTEXF.POINT), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
        const draw = async()=>{
            assert.equal(device.BeginScene(), D3D_OK);
            assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(84), 28),
                D3D_OK);
            assert.equal(device.EndScene(), D3D_OK);
            await h.present();
            return (stageFlagsWritten(gpu) >> 8) & 0xff;
        };
        assert.equal(await draw(), 0);
        assert.equal(texture.SetLOD(1), 0);
        assert.equal(await draw(), 1, 'the texture\'s level');
        assert.equal(device.SetTextureStageState(0, D3DTSS.MAXMIPLEVEL, 2), D3D_OK);
        assert.equal(await draw(), 2, 'the stage\'s, when it is the coarser');
    });

test('recorded: a cube map is six layers of one texture, each face going up into its own',
    async()=>{
        // A cube stage reads a direction -- three components of the set the
        // vertex carries -- through a cube view, bound where the layout says
        // a cube is; a face written again is that face sent again.
        const h = harness();
        const { device, gpu } = h;
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateCubeTexture(4, 2, 0, D3DFMT.X8R8G8B8, D3DPOOL.MANAGED, out),
            D3D_OK);
        const cube = out.texture;
        /** @param {number} face @param {number} level @param {number} value */
        const fill = (face, level, value)=>{
            /** @type {{ pBits?: number }} */
            const locked = {};
            assert.equal(cube.LockCubeRect(face, level, locked, null, 0), D3D_OK);
            const extent = 4 >> level;
            h.write(/** @type {number} */ (locked.pBits),
                new Uint8Array(extent * extent * 4).fill(value));
            assert.equal(cube.UnlockCubeRect(face, level), D3D_OK);
        };
        for (let face = 0; face < 6; face++)
        {
            fill(face, 0, 10 + face);
            fill(face, 1, 20 + face);
        }
        assert.equal(device.SetTexture(0, cube), D3D_OK);
        selectTexture(device);
        const threeComponents = 1 << 16;
        const draw = async()=>{
            assert.equal(device.BeginScene(), D3D_OK);
            assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD | threeComponents), D3D_OK);
            assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(96), 32),
                D3D_OK);
            assert.equal(device.EndScene(), D3D_OK);
            await h.present();
        };
        await draw();

        const made = gpu.of('createTexture').find(
            (/** @type {any} */ call)=>call.descriptor.label === 'cube');
        assert.ok(made, 'the cube was made as one texture');
        assert.equal(made.descriptor.size.depthOrArrayLayers, 6);
        assert.equal(made.descriptor.mipLevelCount, 2);
        assert.ok(gpu.of('createView').some((/** @type {any} */ call)=>call.texture === made.texture
            && call.view.viewDescriptor?.dimension === 'cube'), 'sampled through a cube view');
        /** @param {any} call */
        const shape = call=>[call.destination.origin?.z ?? 0, call.destination.mipLevel,
            call.size.width, call.bytes[0]];
        const uploads = ()=>gpu.of('writeTexture')
            .filter((/** @type {any} */ call)=>call.destination.texture === made.texture)
            .map(shape);
        assert.deepEqual(uploads(), Array.from({ length: 6 },
            (_, face)=>[[face, 0, 4, 10 + face], [face, 1, 2, 20 + face]]).flat());

        const layouts = gpu.of('createBindGroupLayout').map(
            (/** @type {any} */ call)=>call.createBindGroupLayout?.descriptor ?? call.descriptor);
        assert.ok(layouts.some((/** @type {any} */ layout)=>layout.entries.some(
            (/** @type {any} */ entry)=>entry.texture?.viewDimension === 'cube')),
        'the stage\'s binding takes a cube view');
        const code = gpu.of('createShaderModule')
            .map((/** @type {any} */ call)=>call.descriptor.code).join('\n');
        assert.match(code, /var texture0: texture_cube<f32>;/);
        assert.match(code, /texCoord0: vec4f/, 'the set carries its third component');

        fill(3, 1, 99);
        await draw();
        assert.deepEqual(uploads().slice(12), [[3, 1, 2, 99]]);
    });

test('recorded: a volume texture is one texture of three dimensions, each level all its slices',
    async()=>{
        const h = harness();
        const { device, gpu } = h;
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateVolumeTexture(4, 4, 2, 2, 0, D3DFMT.X8R8G8B8, D3DPOOL.MANAGED,
            out), D3D_OK);
        const volume = out.texture;
        /** @param {number} level @param {number} value @param {number} [flags] */
        const fill = (level, value, flags = 0)=>{
            /** @type {{ pBits?: number, SlicePitch?: number }} */
            const locked = {};
            assert.equal(volume.LockBox(level, locked, null, flags), D3D_OK);
            const slices = level === 0 ? 2 : 1;
            h.write(/** @type {number} */ (locked.pBits),
                new Uint8Array(slices * /** @type {number} */ (locked.SlicePitch)).fill(value));
            assert.equal(volume.UnlockBox(level), D3D_OK);
        };
        fill(0, 10);
        fill(1, 20);
        assert.equal(device.SetTexture(0, volume), D3D_OK);
        selectTexture(device);
        assert.equal(device.SetTextureStageState(0, D3DTSS.ADDRESSW, D3DTADDRESS.CLAMP), D3D_OK);
        const threeComponents = 1 << 16;
        const draw = async()=>{
            assert.equal(device.BeginScene(), D3D_OK);
            assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD | threeComponents), D3D_OK);
            assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(96), 32),
                D3D_OK);
            assert.equal(device.EndScene(), D3D_OK);
            await h.present();
        };
        await draw();

        const made = gpu.of('createTexture').find(
            (/** @type {any} */ call)=>call.descriptor.label === 'volume');
        assert.ok(made, 'the volume was made as one texture');
        assert.equal(made.descriptor.dimension, '3d');
        assert.equal(made.descriptor.size.depthOrArrayLayers, 2);
        assert.equal(made.descriptor.mipLevelCount, 2);
        assert.ok(gpu.of('createView').some((/** @type {any} */ call)=>call.texture === made.texture
            && call.view.viewDescriptor?.dimension === '3d'), 'sampled through a 3D view');
        /** @param {any} call */
        const shape = call=>[call.destination.mipLevel, call.size.width, call.size.height,
            call.size.depthOrArrayLayers, call.bytes.length, call.bytes[0]];
        const uploads = ()=>gpu.of('writeTexture')
            .filter((/** @type {any} */ call)=>call.destination.texture === made.texture)
            .map(shape);
        assert.deepEqual(uploads(), [[0, 4, 4, 2, 128, 10], [1, 2, 2, 1, 16, 20]]);
        const layouts = gpu.of('createBindGroupLayout').map(
            (/** @type {any} */ call)=>call.descriptor);
        assert.ok(layouts.some((/** @type {any} */ layout)=>layout.entries.some(
            (/** @type {any} */ entry)=>entry.texture?.viewDimension === '3d')));
        const code = gpu.of('createShaderModule')
            .map((/** @type {any} */ call)=>call.descriptor.code).join('\n');
        assert.match(code, /var texture0: texture_3d<f32>;/);
        assert.equal((stageFlagsWritten(gpu) >>> 16) & 3, 2, 'the third axis clamps');

        // A managed volume keeps its copy through a read-only lock; a level
        // written again is that level sent again.
        fill(1, 30, D3DLOCK.READONLY);
        await draw();
        assert.equal(uploads().length, 2);
        fill(1, 40);
        await draw();
        assert.deepEqual(uploads().slice(2), [[1, 2, 2, 1, 16, 40]]);
    });

test('recorded: a default-pool volume goes up after UpdateTexture writes it', async()=>{
    const h = harness();
    const { device, gpu } = h;
    /** @param {number} pool */
    const volume = pool=>{
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateVolumeTexture(2, 2, 2, 1, 0, D3DFMT.X8R8G8B8, pool, out),
            D3D_OK);
        return out.texture;
    };
    const source = volume(D3DPOOL.SYSTEMMEM);
    const destination = volume(D3DPOOL.DEFAULT);
    assert.equal(device.SetTexture(0, destination), D3D_OK);
    selectTexture(device);
    const draw = async()=>{
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD | (1 << 16)), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(96), 32),
            D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
    };
    await draw();
    const made = gpu.of('createTexture').find(
        (/** @type {any} */ call)=>call.descriptor.label === 'volume');
    const uploads = ()=>gpu.of('writeTexture')
        .filter((/** @type {any} */ call)=>call.destination.texture === made.texture).length;
    assert.equal(uploads(), 1);
    await draw();
    assert.equal(uploads(), 1, 'nothing written, nothing sent');
    /** @type {{ moves?: any[] }} */
    const moved = {};
    assert.equal(device.UpdateTexture(source, destination, moved), D3D_OK);
    assert.equal(moved.moves?.length, 2, 'a move per slice');
    await draw();
    assert.equal(uploads(), 2);
});

test('recorded: with ZENABLE off no depth is written, whatever ZWRITEENABLE says', async()=>{
    // Direct3D ties the write to the test: ZENABLE=FALSE with ZWRITEENABLE=TRUE
    // leaves the depth buffer as it was. WebGPU writes under an 'always'
    // compare, so the write has to be switched off with the test.
    /** @param {number} zenable */
    const drawWith = async zenable=>{
        const h = harness();
        const { device, gpu } = h;
        assert.equal(device.SetRenderState(D3DRS.ZENABLE, zenable), D3D_OK);
        assert.equal(device.SetRenderState(D3DRS.ZWRITEENABLE, 1), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(60), 20), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
        return gpu.of('createRenderPipeline')[0].descriptor.depthStencil;
    };

    const off = await drawWith(0);
    assert.equal(off.depthCompare, 'always');
    assert.equal(off.depthWriteEnabled, false);
    const on = await drawWith(1);
    assert.equal(on.depthWriteEnabled, true, 'and with the test on, the write is ZWRITEENABLE');
});

test('recorded: a whole clear keeps its alpha in any target format that has one', async()=>{
    // The X8 case above is opaque because the format has no alpha; a format with
    // one -- four bits of it here -- is cleared to what the program asked for.
    for (const format of [D3DFMT.A8R8G8B8, D3DFMT.A4R4G4B4, D3DFMT.A1R5G5B5])
    {
        const h = harness({ depth: false });
        const { device, gpu } = h;
        /** @type {{ surface?: any }} */
        const target = {};
        assert.equal(device.CreateRenderTarget(4, 4, format, false, target), D3D_OK);
        assert.equal(device.SetRenderTarget(target.surface, null), D3D_OK);
        assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, argb(1, 2, 3, 0x40), 1, 0), D3D_OK);
        await h.present();
        const pass = gpu.of('beginRenderPass').find((/** @type {any} */ call)=>
            call.descriptor.colorAttachments[0].clearValue !== undefined);
        assert.equal(pass.descriptor.colorAttachments[0].clearValue.a, 0x40 / 255,
            `format ${format}`);
    }
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
    // Colour only. This asserted 0xf and was wrong: the target is X8R8G8B8 and
    // has no alpha channel, so nothing may write one -- and the clear above
    // already relies on that, having put an opaque alpha there for the frame
    // to be presented with.
    assert.equal(descriptor.fragment.targets[0].writeMask, 0x7);
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

/**
 * An indexed strip of four vertices beside a list from the same buffer, and
 * what the GPU was given for both.
 *
 * @param {number[]} order  the strip's four indices
 * @param {{ flat?: boolean }} [how]
 */
async function indexedStrip(order, how = {}){
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
    h.write(/** @type {number} */ (locked.pBits), new Uint8Array(Uint16Array.from(order).buffer));
    assert.equal(indices.buffer.Unlock(), D3D_OK);

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    if (how.flat)
    {
        assert.equal(device.SetRenderState(D3DRS.SHADEMODE, 1), D3D_OK);
    }
    assert.equal(device.SetStreamSource(0, vertices.buffer, 20), D3D_OK);
    assert.equal(device.SetIndices(indices.buffer, 7), D3D_OK);
    assert.equal(device.DrawIndexedPrimitive(D3DPT.TRIANGLESTRIP, 0, 4, 0, 2), D3D_OK);
    assert.equal(device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 3, 1, 1), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    const seen = {
        draws: gpu.of('drawIndexed').map((/** @type {any} */ call)=>call.args),
        bound: gpu.of('setIndexBuffer'),
        written: gpu.of('writeBuffer'),
        primitives: gpu.of('createRenderPipeline').map((/** @type {any} */ call)=>
            call.descriptor.primitive),
    };
    vertices.buffer.release();
    indices.buffer.release();
    return seen;
}

test('recorded: an indexed strip is drawn as a strip from the program\'s own indices', async()=>{
    // Rewritten as a list, every draw of it copied its indices out, built the
    // list on the processor and wrote it to the ring.
    const { draws, bound, primitives } = await indexedStrip([3, 2, 1, 0]);
    assert.deepEqual(draws[0], [4, 1, 0, 7], 'four indices of the strip, base kept');
    assert.deepEqual(draws[1], [3, 1, 0, 7], 'a list draws from the bound buffer');
    assert.match(bound[0].buffer.descriptor.label, /^indices#/, 'the program\'s own buffer');
    assert.equal(bound[0].format, 'uint16');
    assert.deepEqual(primitives.map((/** @type {any} */ p)=>[p.topology, p.stripIndexFormat]),
        [['triangle-strip', 'uint16'], ['triangle-list', undefined]],
        'a strip pipeline built for the index format');
});

test('recorded: an indexed strip WebGPU would cut, or one flat-shaded, is still a list', async()=>{
    // 0xFFFF is a vertex to Direct3D and a restart to a strip pipeline; a
    // flat triangle takes its colour from a vertex WebGPU's strip does not.
    for (const [order, how] of /** @type {[number[], any][]} */ ([
        [[3, 2, 0xffff, 0], {}],
        [[3, 2, 1, 0], { flat: true }],
    ]))
    {
        const { draws, bound, written, primitives } = await indexedStrip(order, how);
        assert.deepEqual(draws[0], [6, 1, 0, 7], 'two triangles, from the scratch list');
        assert.equal(bound[0].buffer.descriptor.label, 'scratch-indices#0');
        const scratch = written.find((/** @type {any} */ call)=>call.buffer === bound[0].buffer);
        assert.deepEqual([...new Uint16Array(scratch.bytes.buffer, scratch.bytes.byteOffset, 6)],
            [order[0], order[1], order[2], order[1], order[3], order[2]],
            'the strip the program wrote, as a list');
        assert.deepEqual(primitives.map((/** @type {any} */ p)=>p.topology), ['triangle-list'],
            'one pipeline serves both');
    }
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
    assert.equal(stream.stride, 0, 'and its stride');
    out.buffer.release();
});

test('recorded: a bound pixel shader is drawn through its translation, not as fixed function',
    async()=>{
        const h = harness({ driverRules: 'current' });
        const { device, gpu } = h;
        /** @type {{ handle?: number }} */
        const pixel = {};
        // ps_1_1: mov r0, v0.
        assert.equal(device.CreatePixelShader([0xffff0101, 0x00000001, 0x800f0000, 0x90e40000,
            0x0000ffff], pixel), D3D_OK);

        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
        assert.equal(device.SetPixelShader(pixel.handle ?? 0), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(60), 20),
            D3D_OK);
        assert.equal(device.SetPixelShader(0), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(60), 20),
            D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();

        assert.equal(gpu.count('draw'), 2);
        const diagnostics = h.device.diagnostics();
        assert.equal(diagnostics.programmable, 1, 'the first through the shader');
        assert.equal(diagnostics.skipped.pixelShader, 0);
        assert.deepEqual(diagnostics.failures, []);
    });

test('recorded: a stride past the format\'s steps over the rest, and one short of it is counted',
    async()=>{
        // Wine's d3d8 texop_test draws a format of no coordinate set at the
        // stride of a vertex carrying one: each element is read at its offset.
        const h = harness();
        const { device, gpu } = h;
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(96), 32), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(36), 12), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
        assert.equal(gpu.count('draw'), 1);
        assert.equal(h.device.diagnostics().skipped.stride, 1);
        const strides = gpu.calls.filter((/** @type {any} */ call)=>/RenderPipeline/.test(call.op))
            .map((/** @type {any} */ call)=>call.descriptor?.vertex?.buffers?.[0]?.arrayStride);
        assert.ok(strides.includes(32), `pipelines read at ${strides}`);
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

test('a DXT1 base narrower than one block is refused; a decoded one lies in B, G, R, A',
    async()=>{
        // Direct3D 8 and 9 make a compressed texture only in whole blocks
        // (Wine's test_surface_blocks).
        const refusing = harness({ compressedTextures: true });
        assert.equal(refusing.device.CreateTexture(2, 64, 1, 0, D3DFMT.DXT1, D3DPOOL.MANAGED, {}),
            D3DERR_INVALIDCALL);

        const h = harness({ compressedTextures: false });
        const { device, gpu } = h;
        const block = new Uint8Array(128).fill(7);
        const texture = textureFrom(h, 4, 64, D3DFMT.DXT1, block);
        assert.equal(device.SetTexture(0, texture), D3D_OK);
        selectTexture(device);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
            quad([0, 0, 2, 2], argb(255, 255, 255), true), 28), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();

        const surface = gpu.of('createTexture').find(c=>c.descriptor.label === 'texture');
        assert.equal(surface.descriptor.format, 'bgra8unorm');
        const written = gpu.of('writeTexture').find(w=>w.destination.texture === surface.texture);
        assert.ok(written, 'the level travelled decoded');
        // A block of 0x07 bytes: both endpoints 0x0707 (r 0, g 227, b 57 widened
        // from 5-6-5), index bits 0b00000111 -- the first texel index 3, which
        // the punch-through mode makes transparent black, the second index 1,
        // the colour. It has to lie as B, G, R, A, the order the texture is
        // stored in, or red and blue trade places on every DXT texture.
        assert.deepEqual([...written.bytes.subarray(4, 8)], [57, 227, 0, 0xff],
            'blue byte first');
    });

test('recorded: a block-aligned DXT5 surface decodes with compressedTextures off and takes'
    + ' the BC path with it on', async()=>{
    const block = new Uint8Array(16).fill(9); // one 4x4 DXT5 (BC3) block

    const off = harness({ compressedTextures: false });
    const decodedTexture = textureFrom(off, 4, 4, D3DFMT.DXT5, block);
    assert.equal(off.device.SetTexture(0, decodedTexture), D3D_OK);
    selectTexture(off.device);
    assert.equal(off.device.BeginScene(), D3D_OK);
    assert.equal(off.device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
    assert.equal(off.device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
        quad([0, 0, 2, 2], argb(255, 255, 255), true), 28), D3D_OK);
    assert.equal(off.device.EndScene(), D3D_OK);
    await off.present();

    const decodedSurface = off.gpu.of('createTexture')
        .find(c=>c.descriptor.label === 'texture');
    assert.equal(decodedSurface.descriptor.format, 'bgra8unorm',
        'the flag is off, so a block-aligned base decodes too');
    assert.equal(off.gpu.of('copyBufferToTexture').length, 0, 'no BC blocks were staged');
    assert.ok(
        off.gpu.of('writeTexture').some(w=>w.destination.texture === decodedSurface.texture),
        'the level travelled decoded');

    const on = harness({ compressedTextures: true });
    const bcTexture = textureFrom(on, 4, 4, D3DFMT.DXT5, block);
    assert.equal(on.device.SetTexture(0, bcTexture), D3D_OK);
    selectTexture(on.device);
    assert.equal(on.device.BeginScene(), D3D_OK);
    assert.equal(on.device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
    assert.equal(on.device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
        quad([0, 0, 2, 2], argb(255, 255, 255), true), 28), D3D_OK);
    assert.equal(on.device.EndScene(), D3D_OK);
    await on.present();

    const bcSurface = on.gpu.of('createTexture').find(c=>c.descriptor.label === 'texture');
    assert.equal(bcSurface.descriptor.format, 'bc3-rgba-unorm',
        'the flag is on and the base is block-aligned: it keeps the blocks');
    assert.ok(
        on.gpu.of('copyBufferToTexture').some(c=>c.destination.texture === bcSurface.texture),
        'the level travelled through staging, undecoded');
});

test('an ATI2 texture decodes to (y, x, 1, 1) and an ATI1 one to its channel in all four,'
    + ' whatever block compression the device keeps', async()=>{
    // A BC4 block of one value: both endpoints it, every index 0.
    const bc4 = (/** @type {number} */ value)=>Uint8Array.of(value, value, 0, 0, 0, 0, 0, 0);
    for (const compressedTextures of [false, true])
    {
        for (const [format, block, texel] of /** @type {[number, Uint8Array, number[]][]} */ ([
            [D3DFMT.ATI2, Uint8Array.from([...bc4(200), ...bc4(50)]), [255, 200, 50, 255]],
            [D3DFMT.ATI1, bc4(77), [77, 77, 77, 77]],
        ]))
        {
            const h = harness({ compressedTextures });
            /** @type {{ texture?: any }} */
            const out = {};
            assert.equal(h.device.CreateTexture(4, 4, 1, 0, format, D3DPOOL.MANAGED, out),
                D3D_OK);
            /** @type {{ pBits?: number, Pitch?: number }} */
            const locked = {};
            assert.equal(out.texture.LockRect(0, locked, null, 0), D3D_OK);
            assert.equal(locked.Pitch, block.length, 'a row of blocks');
            h.write(/** @type {number} */ (locked.pBits), block);
            assert.equal(out.texture.UnlockRect(0), D3D_OK);
            assert.equal(h.device.SetTexture(0, out.texture), D3D_OK);
            selectTexture(h.device);
            assert.equal(h.device.BeginScene(), D3D_OK);
            assert.equal(h.device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
            assert.equal(h.device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
                quad([0, 0, 2, 2], argb(255, 255, 255), true), 28), D3D_OK);
            assert.equal(h.device.EndScene(), D3D_OK);
            await h.present();
            const made = h.gpu.of('createTexture').find(c=>c.descriptor.label === 'texture');
            assert.equal(made.descriptor.format, 'bgra8unorm', 'decoded, never kept as blocks');
            const upload = h.gpu.of('writeTexture').find(w=>w.destination.texture === made.texture);
            assert.deepEqual([...upload.bytes.subarray(0, 64)],
                Array.from({ length: 16 }, ()=>texel).flat(), `format ${format.toString(16)}`);
        }
    }
});

/** One DXT1 block of a single 5-6-5 colour: both endpoints it, every index 0. @param {number} rgb565 */
const solidDxt1 = rgb565=>{
    const block = new Uint8Array(8);
    const view = new DataView(block.buffer);
    view.setUint16(0, rgb565, true);
    view.setUint16(2, rgb565, true);
    return block;
};

/** @param {any} device @param {any} texture */
const drawTextured = (device, texture)=>{
    assert.equal(device.SetTexture(0, texture), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
        quad([0, 0, 2, 2], argb(255, 255, 255), true), 28), D3D_OK);
};

test('compressed textures decoded one after another in a frame each go up as their own texels',
    async()=>{
        // The renderer decodes every level into the same bytes, kept from one
        // level to the next: the upload has copied them before the next level
        // is decoded over them.
        const h = harness({ compressedTextures: false });
        const { device, gpu } = h;
        const red = textureFrom(h, 4, 4, D3DFMT.DXT1, solidDxt1(0xf800));
        const blue = textureFrom(h, 4, 4, D3DFMT.DXT1, solidDxt1(0x001f));
        selectTexture(device);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
        drawTextured(device, red);
        drawTextured(device, blue);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();

        const [first, second] = gpu.of('createTexture')
            .filter(c=>c.descriptor.label === 'texture');
        /** @param {any} surface */
        const texelOf = surface=>[...gpu.of('writeTexture')
            .find(w=>w.destination.texture === surface.texture).bytes.subarray(0, 4)];
        assert.deepEqual(texelOf(first), [0, 0, 255, 255], 'red, as B, G, R, A');
        assert.deepEqual(texelOf(second), [255, 0, 0, 255], 'blue');
    });

test('a compressed level uploaded in the frame\'s order keeps its texels past the next decode',
    async()=>{
        // A texture a frame still to be submitted has drawn from uploads as a
        // frame command, which holds its texels until the frame is replayed: a
        // level decoded later in the same frame must not land in them.
        const h = harness({ compressedTextures: false });
        const { device, gpu } = h;
        const target = textureFrom(h, 4, 4, D3DFMT.DXT1, solidDxt1(0xf800));
        const later = textureFrom(h, 4, 4, D3DFMT.DXT1, solidDxt1(0xffff));
        selectTexture(device);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
        drawTextured(device, target);
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(target.LockRect(0, locked, null, 0), D3D_OK);
        h.write(/** @type {number} */ (locked.pBits), solidDxt1(0x07e0));
        assert.equal(target.UnlockRect(0), D3D_OK);
        drawTextured(device, target);
        drawTextured(device, later);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();

        const surface = gpu.of('createTexture').filter(c=>c.descriptor.label === 'texture')[0];
        const staged = gpu.of('copyBufferToTexture')
            .filter(c=>c.destination.texture === surface.texture);
        assert.equal(staged.length, 1, 'the second upload went in the frame\'s order');
        const written = gpu.of('writeBuffer').find(w=>w.buffer === staged[0].source.buffer);
        assert.deepEqual([...written.bytes.subarray(0, 4)], [0, 255, 0, 255],
            'green, as it was written, not the white decoded after it');
    });

// --- transform and lighting ---

/** @param {object} over @returns {any} a D3DLIGHT8 with every field written */
const light8 = (over = {})=>({
    Type: D3DLIGHTTYPE.DIRECTIONAL,
    Diffuse: { r: 1, g: 0.5, b: 0.25, a: 1 },
    Specular: { r: 0.5, g: 0.25, b: 0.125, a: 1 },
    Ambient: { r: 0.125, g: 0.0625, b: 0.03125, a: 1 },
    Position: { x: 1, y: 2, z: 3 },
    Direction: { x: 0, y: 0, z: 2 },
    Range: 50,
    Falloff: 1.5,
    Attenuation0: 0.25,
    Attenuation1: 0.5,
    Attenuation2: 0.75,
    Theta: 0,
    Phi: Math.PI,
    ...over,
});

/** @returns {any} a material with a different value in every field */
const material8 = ()=>({
    Diffuse: { r: 1, g: 0.5, b: 0.25, a: 0.125 },
    Ambient: { r: 0.0625, g: 0.125, b: 0.25, a: 0.5 },
    Specular: { r: 0.75, g: 0.5, b: 0.25, a: 1 },
    Emissive: { r: 0.5, g: 0.25, b: 0.75, a: 0 },
    Power: 16,
});

/** A vertex of the lit format: position, normal, D3DCOLOR. @param {number[]} at */
const litVertexBytes = at=>{
    const bytes = new DataView(new ArrayBuffer(28));
    [at[0], at[1], at[2], 0, 0, -1].forEach((value, index)=>
        bytes.setFloat32(index * 4, value, true));
    bytes.setUint32(24, 0xffffffff, true);
    return new Uint8Array(bytes.buffer);
};

test('the camera is the point the view matrix sends to the origin', ()=>{
    // Lighting happens in world space, and the specular half vector needs the
    // camera there -- which no matrix holds directly.
    const turned = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 2, 3, 1];
    assert.deepEqual(eyePosition(turned), [3, -2, -1]);
    assert.deepEqual(eyePosition(IDENTITY), [0, 0, 0], 'an identity view looks from the origin');

    // A view matrix with scale in it is where the transpose stops being the
    // inverse: this one would put the camera at four times the distance.
    const scaled = [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, -10, 1];
    assert.deepEqual(eyePosition(scaled), [0, 0, 5]);

    // A view matrix that collapses a dimension has no camera position at all,
    // and inventing one is better than a block full of infinities.
    assert.deepEqual(eyePosition(new Array(16).fill(0)), [0, 0, 0]);
});

test('a viewer at infinity is the line of sight turned back into the world', ()=>{
    assert.deepEqual(viewerDirection(IDENTITY), [0, 0, -1]);
    const turned = [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 2, 3, 1];
    assert.deepEqual(viewerDirection(turned), [1, 0, 0], 'a translation does not move it');
});

test('a normal goes through the inverse transpose of the world matrix', ()=>{
    // Wine's d3d9 lighting_test lights a quad whose normal faces the default
    // directional light under four world matrices: identity, a singular one
    // and a rotation with translation all light it fully, and a non-affine
    // one -- a w of -z -- leaves it black. The inverse transpose of the whole
    // 4x4 does exactly that; the world matrix itself turns the singular
    // case's normal aside, and its upper 3x3 alone lights the non-affine one.
    // With no inverse, the adjugate stands in: the direction is what counts.
    const through = (/** @type {number[]} */ world, /** @type {number[]} */ normal)=>{
        const n = normalMatrixOf(world);
        return [0, 1, 2].map(column=>
            normal[0] * n[column] + normal[1] * n[4 + column] + normal[2] * n[8 + column]);
    };
    /** @param {number[]} normal  lit by the default light, travelling along +z */
    const lit = normal=>Math.min(1, Math.max(0, -normal[2]));
    assert.equal(lit(through([...IDENTITY], [0, 0, -1])), 1);
    assert.equal(lit(through([1, 0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0.5, 1], [0, 0, -1])), 1,
        'singular');
    assert.equal(lit(through([0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 10, 10, 10, 1],
        [-1, 0, 0])), 1, 'rotated and translated');
    assert.equal(lit(through([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, -1, 10, 10, 10, 0], [0, 0, -1])),
        0, 'non-affine');
    // A mirror flips the normal with it, as an inverse does and an adjugate
    // would not.
    assert.deepEqual(through([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], [1, 0, 0]),
        [-1, 0, 0]);
});

test('a light is packed into the rows the shader declares', ()=>{
    // Every row is read by offset. A field one row out is read as a different
    // one, and every one of them is a plausible number.
    const block = new Float32Array(LIGHT_FLOATS);
    packLight(block, 0, light8({ Type: D3DLIGHTTYPE.SPOT, Theta: 0, Phi: (2 * Math.PI) / 3 }));

    assert.deepEqual([...block.subarray(0, 4)], [1, 0.5, 0.25, 1], 'diffuse');
    assert.deepEqual([...block.subarray(4, 8)], [0.5, 0.25, 0.125, 1], 'specular');
    assert.deepEqual([...block.subarray(8, 12)], [0.125, 0.0625, 0.03125, 1], 'ambient');
    assert.deepEqual([...block.subarray(12, 16)], [1, 2, 3, 50], 'position, and the range with it');
    assert.deepEqual([...block.subarray(16, 20)], [0, 0, 1, 0],
        'the direction arrives unnormalised and is normalised once, here');
    assert.deepEqual([...block.subarray(20, 24)], [0.25, 0.5, 0.75, 0], 'the three coefficients');
    // The cosines of the half-angles, not the angles: the shader compares them
    // against a dot product, and the conversion belongs where it happens once.
    assert.equal(block[24], 1, 'cos of half of theta, which is zero');
    assert.equal(block[25], 0.5, 'cos of half of phi, which is sixty degrees');
    assert.equal(block[26], 1.5, 'the falloff exponent');

    // A direction of no length would normalise to a not-a-number, which would
    // erase every triangle it touched rather than lighting none of them.
    const degenerate = new Float32Array(LIGHT_FLOATS);
    packLight(degenerate, 0, light8({ Direction: { x: 0, y: 0, z: 0 } }));
    assert.deepEqual([...degenerate.subarray(16, 20)], [0, 0, 0, 0]);
});

test('recorded: each lit draw carries the normal matrix of its own world', async()=>{
    // The world moves between draws of one prepared state, and a normal moves
    // with it: the block of each draw carries the inverse transpose of that
    // draw's world, not the first one's.
    const h = harness();
    const { device } = h;
    assert.equal(device.SetRenderState(D3DRS.LIGHTING, 1), D3D_OK);
    assert.equal(device.SetLight(0, light8()), D3D_OK);
    assert.equal(device.LightEnable(0, true), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF.XYZ | FVF.NORMAL | FVF.DIFFUSE), D3D_OK);
    const vertices = new Uint8Array(28 * 3);
    [[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach((at, index)=>
        vertices.set(litVertexBytes(at), index * 28));
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, vertices, 28), D3D_OK);
    const scaled = Float32Array.from(IDENTITY);
    scaled[0] = 2;
    assert.equal(device.SetTransform(D3DTS.WORLD, scaled), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, vertices, 28), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    const draws = h.device.diagnostics().lastFrame
        .filter((/** @type {any} */ command)=>command.kind === 'draw');
    const at = UNIFORM_AT.normalMatrix;
    assert.deepEqual([...draws[0].uniforms.subarray(at, at + 16)], [...IDENTITY]);
    assert.equal(draws[1].uniforms[at], 0.5, 'x scaled by two carries a normal by a half');
});

test('recorded: a coordinate generated from the normal carries it as a normal into camera space',
    async()=>{
        // D3DTSS_TCI_CAMERASPACENORMAL: the normal through the inverse
        // transpose of world then view, as a lit normal goes through the
        // world's -- a view doubling x carries a normal by a half there, where
        // world-view itself would double it. Each draw carries its own.
        const h = harness();
        const { device } = h;
        /** @type {{ texture?: any }} */
        const made = {};
        assert.equal(device.CreateTexture(1, 1, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, made),
            D3D_OK);
        assert.equal(device.SetTexture(0, made.texture), D3D_OK);
        assert.equal(device.SetTextureStageState(0, D3DTSS.TEXCOORDINDEX, 0x10000), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF.XYZ | FVF.NORMAL | FVF.DIFFUSE), D3D_OK);
        const vertices = new Uint8Array(28 * 3);
        [[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach((at, index)=>
            vertices.set(litVertexBytes(at), index * 28));
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, vertices, 28), D3D_OK);
        const scaled = Float32Array.from(IDENTITY);
        scaled[0] = 2;
        assert.equal(device.SetTransform(D3DTS.VIEW, scaled), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, vertices, 28), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
        const draws = h.device.diagnostics().lastFrame
            .filter((/** @type {any} */ command)=>command.kind === 'draw');
        const at = UNIFORM_AT.cameraNormalMatrix;
        assert.deepEqual([...draws[0].uniforms.subarray(at, at + 16)], [...IDENTITY]);
        assert.equal(draws[1].uniforms[at], 0.5);
        assert.equal(draws[1].uniforms[UNIFORM_AT.worldView], 2, 'world-view itself doubles');
        assert.equal(device.SetTexture(0, null), D3D_OK);
        made.texture.release();
    });

test('recorded: a lit draw carries its lights, its material and the scene ambient', async()=>{
    // The defect this pins is that all of this reached the device and stopped
    // there: the program set sixteen lights and a material, and the draw was
    // recorded without any of it.
    const h = harness();
    const { device } = h;
    assert.equal(device.SetRenderState(D3DRS.LIGHTING, 1), D3D_OK);
    assert.equal(device.SetRenderState(D3DRS.AMBIENT, 0x00204060), D3D_OK);
    assert.equal(device.SetMaterial(material8()), D3D_OK);
    assert.equal(device.SetLight(2, light8({ Type: D3DLIGHTTYPE.POINT })), D3D_OK);
    assert.equal(device.LightEnable(2, true), D3D_OK);
    // Enabled after a higher index, to show the order is the index order.
    assert.equal(device.SetLight(1, light8()), D3D_OK);
    assert.equal(device.LightEnable(1, true), D3D_OK);
    // Set but never enabled: not part of the equation and not in the shader.
    assert.equal(device.SetLight(5, light8({ Type: D3DLIGHTTYPE.SPOT })), D3D_OK);

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF.XYZ | FVF.NORMAL | FVF.DIFFUSE), D3D_OK);
    const vertices = new Uint8Array(28 * 3);
    [[0, 0, 0], [1, 0, 0], [0, 1, 0]].forEach((at, index)=>
        vertices.set(litVertexBytes(at), index * 28));
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, vertices, 28), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const draw = h.device.diagnostics().lastFrame.find((/** @type {any} */ c)=>c.kind === 'draw');
    assert.deepEqual(draw.state.lighting, {
        lights: [D3DLIGHTTYPE.DIRECTIONAL, D3DLIGHTTYPE.POINT],
        colorVertex: true,
        diffuseSource: D3DMCS.COLOR1,
        ambientSource: D3DMCS.MATERIAL,
        specularSource: D3DMCS.COLOR2,
        emissiveSource: D3DMCS.MATERIAL,
        localViewer: true,
    }, 'the enabled lights in index order, the default material sources, a local viewer');

    assert.equal(draw.uniforms.length, UNIFORM_FLOATS + 2 * LIGHT_FLOATS,
        'the block is exactly as long as the shader\'s array declaration');
    assert.deepEqual([...draw.uniforms.subarray(
        UNIFORM_AT.materialDiffuse, UNIFORM_AT.materialDiffuse + 4)], [1, 0.5, 0.25, 0.125]);
    assert.deepEqual([...draw.uniforms.subarray(
        UNIFORM_AT.materialEmissive, UNIFORM_AT.materialEmissive + 4)], [0.5, 0.25, 0.75, 0]);
    assert.deepEqual([...draw.uniforms.subarray(UNIFORM_AT.ambient, UNIFORM_AT.ambient + 3)],
        [0x20 / 255, 0x40 / 255, 0x60 / 255].map(Math.fround),
        'D3DRS_AMBIENT is a D3DCOLOR, red first, in the block\'s own precision');
    assert.equal(draw.uniforms[UNIFORM_AT.eye + 3], 16, 'the specular power rides with the eye');
    // The second light is the point light, which is where its position matters.
    const second = UNIFORM_AT.lights + LIGHT_FLOATS;
    assert.deepEqual([...draw.uniforms.subarray(second + 12, second + 16)], [1, 2, 3, 50]);
});

test('recorded: lighting off leaves the colour alone, and no normal still lights', async()=>{
    /** @param {number} fvf @param {number} lighting */
    const drawWith = async(fvf, lighting)=>{
        const h = harness();
        const { device } = h;
        assert.equal(device.SetRenderState(D3DRS.LIGHTING, lighting), D3D_OK);
        assert.equal(device.SetLight(0, light8()), D3D_OK);
        assert.equal(device.LightEnable(0, true), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(fvf), D3D_OK);
        const stride = decodeFvf(fvf).stride;
        assert.equal(
            device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(stride * 3), stride),
            D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
        return h.device.diagnostics().lastFrame
            .find((/** @type {any} */ c)=>c.kind === 'draw');
    };

    const lit = await drawWith(FVF.XYZ | FVF.NORMAL | FVF.DIFFUSE, 1);
    assert.equal(lit.state.lighting.lights.length, 1);

    const off = await drawWith(FVF.XYZ | FVF.NORMAL | FVF.DIFFUSE, 0);
    assert.equal(off.state.lighting, null);
    assert.equal(off.uniforms.length, UNIFORM_FLOATS,
        'and no light is carried for a shader that declares none');

    // A vertex with no normal is still lit, with a zero one: its ambient and
    // emissive colours are what Windows draws (Wine's d3d8 test_color_vertex).
    const noNormal = await drawWith(FVF.XYZ | FVF.DIFFUSE, 1);
    assert.equal(noNormal.state.lighting.lights.length, 1);

    // A pre-transformed vertex is past the point where lighting happens.
    const preTransformed = await drawWith(FVF.XYZRHW | FVF.DIFFUSE, 1);
    assert.equal(preTransformed.state.lighting, null);
});

test('a state with no lighting in its shape is unlit, and still reads the specular state', ()=>{
    // The quad a partial clear draws is the colour it was given. Lighting it
    // would multiply the clear colour by a material nobody set for it.
    const model = /** @type {any} */ ({
        renderStates: new Map([[D3DRS.LIGHTING, 1], [D3DRS.SPECULARENABLE, 1]]),
        stageStates: ()=>new Map(),
        textures: new Map(),
        transforms: new Map(),
        lights: new Map(),
        material: material8(),
    });
    const state = pipelineStateOf(model, {
        fvf: FVF.XYZRHW | FVF.DIFFUSE,
        topology: 'triangle-list',
        targetFormat: 'bgra8unorm',
        depthFormat: undefined,
        stages: [],
    });
    assert.equal(state.lighting, null, 'nothing asked for lighting, so there is none');
    assert.equal(state.specularEnable, true, 'but the specular state is read from the device');
});

test('recorded: a flat-shaded strip is drawn as a list, each triangle from its first vertex',
    async()=>{
        // Wine's d3d8 and d3d9 test_shademode: under D3DSHADE_FLAT the second
        // triangle of a strip takes the colour of vertex 1. WebGPU's own strip
        // starts its odd triangles at the vertex after -- it reorders them to
        // keep the winding -- so a flat-shaded strip is rewritten as a list
        // whose triangles start where Direct3D's do; Gouraud keeps the strip.
        const drawStrip = async(/** @type {number} */ shade)=>{
            const h = harness();
            const { device } = h;
            assert.equal(device.SetRenderState(D3DRS.LIGHTING, 0), D3D_OK);
            assert.equal(device.SetRenderState(D3DRS.SHADEMODE, shade), D3D_OK);
            assert.equal(device.BeginScene(), D3D_OK);
            assert.equal(device.SetVertexShader(FVF.XYZ | FVF.DIFFUSE), D3D_OK);
            assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLESTRIP, 2, new Uint8Array(16 * 4),
                16), D3D_OK);
            assert.equal(device.EndScene(), D3D_OK);
            await h.present();
            const draw = h.device.diagnostics().lastFrame
                .find((/** @type {any} */ c)=>c.kind === 'draw');
            return { h, draw };
        };
        const flat = await drawStrip(1);
        assert.equal(flat.draw.state.flatShading, true);
        assert.equal(flat.draw.state.topology, 'triangle-list');
        const scratch = flat.h.gpu.of('writeBuffer').filter((/** @type {any} */ call)=>
            call.buffer.descriptor.label.startsWith('scratch-indices'));
        assert.ok(scratch.length > 0);
        const written = scratch[scratch.length - 1].bytes;
        assert.deepEqual([...new Uint16Array(written.buffer, written.byteOffset, 6)],
            [0, 1, 2, 1, 3, 2]);
        const code = generateFixedFunction(flat.draw.state, decodeFvf(FVF.XYZ | FVF.DIFFUSE)).code;
        assert.ok(code.includes('@location(0) @interpolate(flat) diffuse: vec4f,'));

        const gouraud = await drawStrip(2);
        assert.equal(gouraud.draw.state.flatShading, false);
        assert.equal(gouraud.draw.state.topology, 'triangle-strip');
    });

test('recorded: FILLMODE WIREFRAME and POINT draw triangles as lines and points', async()=>{
    // WebGPU has no fill mode, so the topology carries it: the triangles'
    // edges as a line list, their vertices as a point list, rewritten from
    // the program's own vertices or indices; lines and points are left as
    // they are.
    const drawWith = async(/** @type {number} */ fill, /** @type {boolean} */ indexed)=>{
        const h = harness();
        const { device } = h;
        assert.equal(device.SetRenderState(D3DRS.LIGHTING, 0), D3D_OK);
        assert.equal(device.SetRenderState(D3DRS.FILLMODE, fill), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF.XYZ | FVF.DIFFUSE), D3D_OK);
        const vertices = new Uint8Array(16 * 4);
        assert.equal(indexed
            ? device.DrawIndexedPrimitiveUP(D3DPT.TRIANGLELIST, 0, 4, 2,
                new Uint8Array(Uint16Array.from([0, 1, 2, 2, 1, 3]).buffer),
                D3DFMT_INDEX.INDEX16, vertices, 16)
            : device.DrawPrimitiveUP(D3DPT.TRIANGLESTRIP, 2, vertices, 16), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.LINELIST, 1, vertices, 16), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
        const draws = h.device.diagnostics().lastFrame
            .filter((/** @type {any} */ c)=>c.kind === 'draw');
        const scratch = h.gpu.of('writeBuffer').filter((/** @type {any} */ call)=>
            call.buffer.descriptor.label.startsWith('scratch-indices'));
        const written = scratch.length > 0 ? scratch[scratch.length - 1].bytes : null;
        return { draws, written };
    };
    const wire = await drawWith(2, false);
    assert.equal(wire.draws[0].state.topology, 'line-list');
    assert.equal(wire.draws[0].count, 12);
    assert.deepEqual([...new Uint16Array(/** @type {Uint8Array} */ (wire.written).buffer,
        /** @type {Uint8Array} */ (wire.written).byteOffset, 12)],
    [0, 1, 1, 2, 2, 0, 1, 3, 3, 2, 2, 1]);
    assert.equal(wire.draws[1].state.topology, 'line-list', 'a line list is left a line list');
    assert.equal(wire.draws[1].count, 2);

    const points = await drawWith(1, true);
    assert.equal(points.draws[0].state.topology, 'point-list');
    assert.deepEqual([...new Uint16Array(/** @type {Uint8Array} */ (points.written).buffer,
        /** @type {Uint8Array} */ (points.written).byteOffset, 6)], [0, 1, 2, 2, 1, 3]);

    const solid = await drawWith(3, true);
    assert.equal(solid.draws[0].state.topology, 'triangle-list');
    assert.equal(solid.draws[0].count, 6, 'solid is the triangles as given');
});

test('a state renormalises its normals only when NORMALIZENORMALS asks', ()=>{
    const model = /** @type {any} */ ({
        renderStates: new Map([[D3DRS.LIGHTING, 1]]),
        stageStates: ()=>new Map(),
        textures: new Map(),
        transforms: new Map(),
        lights: new Map(),
        material: material8(),
    });
    const shape = {
        fvf: FVF.XYZ | FVF.NORMAL,
        topology: 'triangle-list',
        targetFormat: 'bgra8unorm',
        depthFormat: undefined,
        stages: [],
    };
    assert.equal(pipelineStateOf(model, shape).normalizeNormals, false, 'off by default');
    model.renderStates.set(D3DRS.NORMALIZENORMALS, 1);
    assert.equal(pipelineStateOf(model, shape).normalizeNormals, true);
});

test('a depth bias reaches the pipeline: Direct3D 9 in depth units, Direct3D 8 in ZBIAS steps',
    ()=>{
        const bits = (/** @type {number} */ f)=>new Uint32Array(new Float32Array([f]).buffer)[0];
        const model = /** @type {any} */ ({
            renderStates: new Map([[195, bits(-0.0001)], [175, bits(-2)]]),
            stageStates: ()=>new Map(),
            textures: new Map(),
            transforms: new Map(),
            lights: new Map(),
            material: material8(),
        });
        const shape = {
            fvf: FVF.XYZ, topology: 'triangle-list', targetFormat: 'bgra8unorm',
            depthFormat: 'depth24plus-stencil8', stages: [],
        };
        model.renderStates.set(D3DRS.CULLMODE, 1);
        const state = pipelineStateOf(model, shape);
        assert.equal(state.depthBias, Math.round(-0.0001 * 16777216));
        assert.equal(state.depthBiasSlopeScale, -2);
        const descriptor = pipelineDescriptor(state, null);
        assert.equal(descriptor.depthStencil.depthBias, state.depthBias);
        assert.equal(descriptor.depthStencil.depthBiasSlopeScale, -2);
        assert.notEqual(pipelineKey(state), pipelineKey(pipelineStateOf({ ...model,
            renderStates: new Map([[D3DRS.CULLMODE, 1]]) }, shape)),
        'a biased draw is a pipeline of its own');
        assert.equal(pipelineStateOf(model, { ...shape, topology: 'line-list' }).depthBias,
            undefined, 'not on lines, which WebGPU does not bias');
        const eight = { ...model, renderStates: new Map([[D3DRS.ZBIAS, 2], [D3DRS.CULLMODE, 1]]) };
        assert.equal(pipelineStateOf(eight, shape).depthBias, Math.round(2 * -0.000005 * 16777216));
        assert.equal(pipelineStateOf(eight, { ...shape, depthFormat: undefined }).depthBias,
            undefined, 'no depth, no bias');
    });

test('the run counts what lighting it was actually asked for', async()=>{
    // A picture that is uniformly too dark or too flat cannot be diagnosed from
    // the frame. The question is always whether the program enabled lighting,
    // how many lights it had on, what ambient it set, and how many draws were
    // lit without a normal -- and none of that was countable.
    const h = harness();
    const { device } = h;
    /** @param {number} fvf @param {number} lighting */
    const draw = (fvf, lighting)=>{
        assert.equal(device.SetRenderState(D3DRS.LIGHTING, lighting), D3D_OK);
        assert.equal(device.SetVertexShader(fvf), D3D_OK);
        const stride = decodeFvf(fvf).stride;
        assert.equal(
            device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(stride * 3), stride),
            D3D_OK);
    };

    assert.equal(device.SetLight(0, light8()), D3D_OK);
    assert.equal(device.LightEnable(0, true), D3D_OK);
    assert.equal(device.SetRenderState(D3DRS.AMBIENT, 0x00203040), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    draw(FVF.XYZ | FVF.NORMAL | FVF.DIFFUSE, 1);
    draw(FVF.XYZ | FVF.DIFFUSE, 1);
    draw(FVF.XYZRHW | FVF.DIFFUSE, 1);
    draw(FVF.XYZ | FVF.NORMAL | FVF.DIFFUSE, 0);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const counted = device.diagnostics().lighting;
    assert.equal(counted.lit, 2);
    assert.equal(counted.unlit, 2);
    assert.equal(counted.noNormal, 1, 'lit, and the format carried no normal');
    assert.equal(counted.preTransformed, 1, 'lighting was on and the vertices were past it');
    assert.equal(counted.mostLights, 1);
    assert.deepEqual(counted.types, [light8().Type]);
    assert.deepEqual(counted.ambients, ['00203040'],
        'the scene ambient a lit draw was made under, so a black one is visible as such');
});

test('a screen-space draw is recorded with what fills it', ()=>{
    // A draw whose model origin sits on the camera is a screen-space quad
    // written as ordinary geometry rather than as XYZRHW. It is rectangular by
    // construction, so when one is wrong it is wrong in the shape of a
    // rectangle -- and what makes it wrong is what fills and blends it, never
    // the transform. With no transform set at all the matrices are identity,
    // which puts the origin exactly there.
    const h = harness();
    const { device } = h;

    assert.equal(device.SetRenderState(D3DRS.FOGENABLE, 1), D3D_OK);
    assert.equal(device.SetRenderState(D3DRS.FOGVERTEXMODE, D3DFOG.LINEAR), D3D_OK);
    assert.equal(device.SetRenderState(D3DRS.FOGSTART, floatToDword(0)), D3D_OK);
    assert.equal(device.SetRenderState(D3DRS.FOGEND, floatToDword(7000)), D3D_OK);
    assert.equal(device.SetRenderState(D3DRS.ALPHABLENDENABLE, 1), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    const fvf = FVF.XYZ | FVF.DIFFUSE;
    assert.equal(device.SetVertexShader(fvf), D3D_OK);
    const stride = decodeFvf(fvf).stride;
    assert.equal(
        device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(stride * 3), stride),
        D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);

    const { fog } = device.diagnostics().lighting;
    assert.equal(fog.transformed, 1);
    assert.deepEqual(fog.depths, ['depth=1 amount=1'], 'on the camera, so not fogged');
    assert.equal(fog.screenSpace.length, 1, 'and recorded as a screen-space draw');
    assert.match(fog.screenSpace[0], /^blend=true/);
    assert.match(fog.screenSpace[0], /texture=none/, 'nothing bound, said as such');
});

test('a draw`s screen extent is the box its transformed vertices span', ()=>{
    // Unit. The projection is identity, so a vertex is already in clip space
    // with a w of one and the only arithmetic left is the viewport map: x from
    // -1..1 across the width, y from 1..-1 down the height. Those two
    // conventions disagree in sign, which is exactly the mistake that gives a
    // plausible box in the wrong half of the frame.
    const viewport = viewportState({ x: 0, y: 0, width: 640, height: 480 });
    const vertices = new DataView(new ArrayBuffer(24));
    vertices.setFloat32(0, -1, true);
    vertices.setFloat32(4, 1, true);
    vertices.setFloat32(8, 0, true);
    vertices.setFloat32(12, 0.5, true);
    vertices.setFloat32(16, -2, true);
    vertices.setFloat32(20, 0, true);

    assert.deepEqual(screenExtent({
        worldViewProjection: IDENTITY,
        viewport,
        preTransformed: false,
        vertices: new Uint8Array(vertices.buffer),
        stride: 12,
        indices: null,
    }), { x0: 0, y0: 0, x1: 480, y1: 720, behind: 0, before: 0, beyond: 0, depth: [0, 0],
        eye: [1, 1], nearest: [1, 1] });

    // The same bytes read as pre-transformed are target pixels already, which
    // is a different box entirely and is why the flag is carried.
    assert.deepEqual(screenExtent({
        worldViewProjection: IDENTITY,
        viewport,
        preTransformed: true,
        vertices: new Uint8Array(vertices.buffer),
        stride: 12,
        indices: null,
    }), { x0: -1, y0: -2, x1: 1, y1: 1, behind: 0, before: 0, beyond: 0,
        depth: [Infinity, -Infinity], eye: [Infinity, -Infinity], nearest: [] });
});

test('a vertex behind the eye is counted rather than divided by its own w', ()=>{
    // Unit. A clip w at or below zero has no screen position: dividing by it
    // throws the box out to an infinity that swallows every other vertex, so
    // the box would claim the draw covered the whole frame and name it as a
    // candidate for every patch of it. This matrix makes w the z.
    const projection = [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 1,
        0, 0, 0, 0,
    ];
    const vertices = new DataView(new ArrayBuffer(24));
    vertices.setFloat32(0, 2, true);
    vertices.setFloat32(4, 2, true);
    vertices.setFloat32(8, 2, true);
    vertices.setFloat32(12, 0, true);
    vertices.setFloat32(16, 0, true);
    vertices.setFloat32(20, -1, true);

    assert.deepEqual(screenExtent({
        worldViewProjection: projection,
        viewport: viewportState({ x: 0, y: 0, width: 640, height: 480 }),
        preTransformed: false,
        vertices: new Uint8Array(vertices.buffer),
        stride: 12,
        indices: null,
    }), { x0: 640, y0: 0, x1: 640, y1: 0, behind: 1, before: 0, beyond: 0, depth: [1, 1],
        eye: [2, 2], nearest: [-1, 2] });
});

test('a vertex past either depth plane is counted, because the far plane clips too', ()=>{
    // Unit. A draw whose vertices straddle the far plane is one the rasteriser
    // cuts triangles out of, and a surface placed on that plane on purpose is
    // cut whole or not at all as the camera moves by less than a depth unit.
    // The identity projection leaves z as the depth: one vertex before the
    // near plane, one on it, one past the far plane.
    const vertices = new DataView(new ArrayBuffer(36));
    vertices.setFloat32(8, -0.5, true);
    vertices.setFloat32(20, 0, true);
    vertices.setFloat32(32, 1.25, true);

    assert.deepEqual(screenExtent({
        worldViewProjection: IDENTITY,
        viewport: viewportState({ x: 0, y: 0, width: 640, height: 480 }),
        preTransformed: false,
        vertices: new Uint8Array(vertices.buffer),
        stride: 12,
        indices: null,
    }), { x0: 320, y0: 240, x1: 320, y1: 240, behind: 0, before: 1, beyond: 1,
        depth: [-0.5, 1.25], eye: [1, 1], nearest: [1, 1, 1] });
});

test('the frame dump says where each draw landed and is empty unless asked for', async()=>{
    // Recorded commands. A counter says a frame had many draws and a picture
    // says one patch of it is wrong; only this joins the two.
    const quiet = harness({ width: 640, height: 480 });
    assert.equal(quiet.device.BeginScene(), D3D_OK);
    assert.equal(quiet.device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(quiet.device.DrawPrimitiveUP(
        D3DPT.TRIANGLELIST, 2, quad([10, 20, 110, 70], argb(255, 0, 0)), 20), D3D_OK);
    assert.equal(quiet.device.EndScene(), D3D_OK);
    await quiet.present();
    assert.deepEqual(quiet.device.diagnostics().lastDump, [],
        'a run that did not ask for the dump pays nothing for it');

    const h = harness({ width: 640, height: 480, dumpDraws: true });
    const device = h.device;
    assert.equal(device.SetRenderState(D3DRS.ALPHABLENDENABLE, 1), D3D_OK);
    assert.equal(device.SetRenderState(D3DRS.SRCBLEND, D3DBLEND.SRCALPHA), D3D_OK);
    assert.equal(device.SetRenderState(D3DRS.DESTBLEND, D3DBLEND.INVSRCALPHA), D3D_OK);
    assert.equal(device.SetRenderState(D3DRS.ALPHATESTENABLE, 1), D3D_OK);
    assert.equal(device.SetRenderState(D3DRS.ALPHAFUNC, D3DCMP.GREATEREQUAL), D3D_OK);
    assert.equal(device.SetRenderState(D3DRS.ALPHAREF, 128), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(
        D3DPT.TRIANGLELIST, 2, quad([10, 20, 110, 70], argb(255, 0, 0)), 20), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const dumped = device.diagnostics().lastDump;
    assert.equal(dumped.length, 1);
    assert.match(dumped[0], /^#0 10,20\.\.110,70 \(100x50\) /,
        'the box a pre-transformed quad covers, in target pixels');
    assert.match(dumped[0], / n=6 /);
    assert.match(dumped[0], / lit=- /, 'a pre-transformed draw is past lighting');
    assert.match(dumped[0], new RegExp(` blend=${D3DBLEND.SRCALPHA},${D3DBLEND.INVSRCALPHA} `));
    assert.match(dumped[0], new RegExp(` aTest=${D3DCMP.GREATEREQUAL}/128 `));
    assert.match(dumped[0], / alpha=vertex:255\.\.255 /,
        'where a fragment`s transparency comes from -- here the vertex`s own colour');
    assert.match(dumped[0], / texXform=- /,
        'a stage this engine does not transform coordinates for says so');
    assert.match(dumped[0], / target=s\d+ /,
        'what it drew into, so a frame built through more than one target says so');
    assert.match(dumped[0], / view=0,0\+640x480@0..1 /,
        'the rectangle the draw was clipped and mapped by, which a later draw inherits');
    assert.match(dumped[0], / \[\] /, 'no stage is on, so the cascade is empty');
    assert.match(dumped[0], / at=10,20 110,20 10,70 110,70 pipe\d+ vb\d+@\d+\([^)]*\) gpu=same ugpu=same$/,
        'the corners themselves, because the union of a draw`s quads is not one of them');
});

test('every few frames keep their dump, each checked against what the GPU held', async()=>{
    // A picture wrong in one frame of a few is caught with its draws only when
    // more than the last frame is written down.
    const h = harness({ width: 640, height: 480, dumpEvery: 2 });
    const device = h.device;
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    for (let frame = 0; frame < 5; frame++)
    {
        assert.equal(device.BeginScene(), D3D_OK);
        // A frame of its own number of draws, so each dump is told apart.
        for (let draw = 0; draw <= frame; draw++)
        {
            assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
                quad([10, 20, 110, 70], argb(255, 0, 0)), 20), D3D_OK);
        }
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
    }
    const kept = device.diagnostics().dumps;
    assert.deepEqual(kept.map((/** @type {any} */ one)=>one.frame), [0, 2, 4]);
    assert.deepEqual(kept.map((/** @type {any} */ one)=>one.lines.length), [1, 3, 5],
        'each frame with its own draws');
    assert.match(kept[1].lines[2], /^#2 10,20\.\.110,70 \(100x50\) /);
    assert.match(kept[2].lines[4], / gpu=same ugpu=same$/,
        'the vertices and the block the GPU drew with, against what the program wrote');
    assert.equal(harness({ width: 640, height: 480 }).device.diagnostics().dumps, undefined,
        'a run that did not ask keeps none');
});

test('the dump reads back what the GPU holds for a draw: vertices, block and indices', async()=>{
    // Recorded commands, through a device whose buffers keep their bytes. A
    // draw is described from guest memory and shaded from the GPU's copies of
    // it, and the two are compared at replay: a draw whose picture no field of
    // its line explains is one whose copies differ, and only the comparison
    // can say which.
    const h = harness({ width: 640, height: 480, dumpDraws: true });
    const { device } = h;
    /** @type {{ buffer?: any }} */
    const vertices = {};
    /** @type {{ buffer?: any }} */
    const indices = {};
    assert.equal(device.CreateVertexBuffer(20 * 4, 0, FVF_QUAD, D3DPOOL.DEFAULT, vertices), D3D_OK);
    assert.equal(device.CreateIndexBuffer(6, 0, D3DFMT_INDEX.INDEX16, D3DPOOL.DEFAULT, indices),
        D3D_OK);
    /** @type {{ pBits?: number }} */
    const locked = {};
    assert.equal(vertices.buffer.Lock(0, 0, locked, 0), D3D_OK);
    h.write(/** @type {number} */ (locked.pBits), quad([10, 20, 110, 70], argb(255, 0, 0)));
    assert.equal(vertices.buffer.Unlock(), D3D_OK);
    assert.equal(indices.buffer.Lock(0, 0, locked, 0), D3D_OK);
    h.write(/** @type {number} */ (locked.pBits), new Uint8Array(Uint16Array.from([0, 1, 2]).buffer));
    assert.equal(indices.buffer.Unlock(), D3D_OK);

    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.SetStreamSource(0, vertices.buffer, 20), D3D_OK);
    assert.equal(device.SetIndices(indices.buffer, 0), D3D_OK);
    assert.equal(device.DrawIndexedPrimitive(D3DPT.TRIANGLELIST, 0, 3, 0, 1), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const dumped = device.diagnostics().lastDump;
    assert.equal(dumped.length, 1);
    assert.match(dumped[0], / u=[0-9a-f]{8} /, 'the block the draw was shaded with, as one word');
    assert.match(dumped[0], / pipe\d+ vb\d+@0\([^)]*\) ib\d+@0\([^)]*\) gpu=same ugpu=same igpu=same$/,
        'the vertices, the block and the indices the GPU holds are the ones described');
    assert.deepEqual(device.diagnostics().failures ?? [], [], 'the read-back is not an error');
    vertices.buffer.release();
    indices.buffer.release();
});

test('fog can be switched off for a run, and the dump says a draw ran without it', async()=>{
    // Recorded commands. The knob exists so two runs differ by fog and nothing
    // else, which only holds if the device hands it on to the renderer -- a
    // knob that stops at the device makes the two runs identical and the
    // conclusion drawn from them false.
    const fogged = async(/** @type {boolean | undefined} */ fog)=>{
        const h = harness({ width: 640, height: 480, dumpDraws: true, fog });
        const device = h.device;
        assert.equal(device.SetRenderState(D3DRS.FOGENABLE, 1), D3D_OK);
        assert.equal(device.SetRenderState(D3DRS.FOGVERTEXMODE, D3DFOG.LINEAR), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(
            D3DPT.TRIANGLELIST, 2, quad([10, 20, 110, 70], argb(255, 0, 0)), 20), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
        return device.diagnostics().lastDump[0];
    };
    assert.match(await fogged(undefined), / fog=3\//, 'on by default, as the program asked');
    assert.match(await fogged(false), / fog=- /, 'off, the draw ran as if never fogged');
});

test('a frame can be cut short after a given number of draws', async()=>{
    // Recorded commands. A dump says which draws could have painted a region;
    // only cutting the frame at each of them in turn says which one did, so
    // the cut has to drop the draw rather than hide it.
    const h = harness({ width: 640, height: 480, maxDraws: 2 });
    const device = h.device;
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    for (let at = 0; at < 5; at++)
    {
        assert.equal(device.DrawPrimitiveUP(
            D3DPT.TRIANGLELIST, 2, quad([at, 0, at + 10, 10], argb(255, 0, 0)), 20), D3D_OK);
    }
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    assert.equal(device.diagnostics().draws, 2, 'the rest never reached the queue');
});

test('byte-exact: a two-coordinate texture transform moves the sample by its third row', async()=>{
    // Direct3D puts (u, v, 1) through the matrix for D3DTTFF_COUNT2, so a
    // scroll is _31/_32 and the fourth row never reaches a two-dimensional
    // coordinate. A sprite sheet's cell is chosen exactly this way: the
    // vertex names the first cell and the matrix offsets to the one wanted.
    // Read from the wrong row, every offset is zero and every sheet shows its
    // first cell -- a picture that looks deliberate.
    const h = harness({ width: 2, height: 2 });
    const { device } = h;
    // Four different texels, B G R A each, as A8R8G8B8 lies in memory.
    const texture = textureFrom(h, 2, 2, D3DFMT.A8R8G8B8, Uint8Array.from([
        0, 0, 255, 255, 0, 255, 0, 255,
        255, 0, 0, 255, 0, 255, 255, 255,
    ]));
    assert.equal(device.SetTexture(0, texture), D3D_OK);
    selectTexture(device);
    assert.equal(device.SetTextureStageState(0, D3DTSS.TEXTURETRANSFORMFLAGS, 2), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
    // One pixel per draw, its centre at (0.5, 0.5) of the texture: the
    // bottom-right texel, yellow, when nothing moves it.
    assert.equal(device.SetTransform(D3DTS.TEXTURE0, [...IDENTITY]), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
        quad([0, 0, 1, 1], argb(255, 255, 255), true), 28), D3D_OK);
    // Half the texture back along both axes, in the third row: the top-left
    // texel, red.
    assert.equal(device.SetTransform(D3DTS.TEXTURE0, [
        1, 0, 0, 0,
        0, 1, 0, 0,
        -0.5, -0.5, 1, 0,
        0, 0, 0, 1,
    ]), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
        quad([1, 0, 2, 1], argb(255, 255, 255), true), 28), D3D_OK);
    // The same numbers in the fourth row move nothing: still yellow.
    assert.equal(device.SetTransform(D3DTS.TEXTURE0, [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        -0.5, -0.5, 0, 1,
    ]), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
        quad([0, 1, 1, 2], argb(255, 255, 255), true), 28), D3D_OK);
    // Half a texture along u only, from the third row: bottom-left, blue.
    assert.equal(device.SetTransform(D3DTS.TEXTURE0, [
        1, 0, 0, 0,
        0, 1, 0, 0,
        -0.5, 0, 1, 0,
        0, 0, 0, 1,
    ]), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
        quad([1, 1, 2, 2], argb(255, 255, 255), true), 28), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const surface = rasterise(h, 2, 2);
    assert.deepEqual(pixelAt(surface, 0, 0), [0, 255, 255, 255], 'untransformed: yellow');
    assert.deepEqual(pixelAt(surface, 1, 0), [0, 0, 255, 255], 'third row moved it: red');
    assert.deepEqual(pixelAt(surface, 0, 1), [0, 255, 255, 255], 'fourth row moved nothing');
    assert.deepEqual(pixelAt(surface, 1, 1), [255, 0, 0, 255], 'u alone: blue');
    assert.equal(toBase64(surface), 'AP///wAA//8A/////wAA/w==');
    // What the shader is handed is what the evaluator read: the matrix by
    // columns, (m11, m21, m31, m41) then (m12, m22, m32, m42), at the
    // documented place; a carried coordinate reads the first three of each,
    // and the fourth row is there for a generated one.
    const draws = h.device.diagnostics().lastFrame.filter(
        (/** @type {any} */ command)=>command.kind === 'draw');
    assert.equal(draws.length, 4);
    assert.deepEqual([...draws[1].uniforms.subarray(
        UNIFORM_AT.textureTransforms, UNIFORM_AT.textureTransforms + 8)],
    [1, 0, -0.5, 0, 0, 1, -0.5, 0]);
    assert.deepEqual([...draws[2].uniforms.subarray(
        UNIFORM_AT.textureTransforms, UNIFORM_AT.textureTransforms + 8)],
    [1, 0, 0, -0.5, 0, 1, 0, -0.5]);
});

test('the block lays a texture transform out as two rows per sampled stage', ()=>{
    // The shader reads array<vec4f, 32> at float 76 -- byte 304, sixteen-aligned
    // after the three sampler words, a matrix per stage for all eight --
    // then the world-view matrix at byte 816, the normal matrix at byte 880,
    // the camera-space normal matrix at byte 944 and the lights from byte
    // 1008. A row at the wrong index is read as another stage's, or as a light.
    assert.equal(UNIFORM_AT.textureTransforms, 76);
    assert.equal(UNIFORM_AT.worldView, 204);
    assert.equal(UNIFORM_AT.normalMatrix, 220);
    assert.equal(UNIFORM_AT.cameraNormalMatrix, 236);
    assert.equal(UNIFORM_AT.lights, 260);
    assert.equal(UNIFORM_FLOATS, 260);
    const columns = Array.from({ length: 16 }, (_, at)=>at + 2);
    const block = uniformBlock({
        worldViewProjection: IDENTITY,
        viewport: viewportState({ x: 0, y: 0, width: 1, height: 1 }),
        textureFactor: 0,
        fogColor: 0,
        alphaRef: 0,
        textureTransforms: [columns, IDENTITY, IDENTITY, columns],
    });
    assert.equal(block.length, UNIFORM_FLOATS);
    // The alpha reference is compared by its low byte alone (Wine's d3d8
    // test_alphatest sets 0xff70 and reads 0x70).
    const referenced = uniformBlock({
        worldViewProjection: IDENTITY,
        viewport: viewportState({ x: 0, y: 0, width: 1, height: 1 }),
        textureFactor: 0,
        fogColor: 0,
        alphaRef: 0xff70,
    });
    assert.equal(referenced[UNIFORM_AT.alphaRef], Math.fround(0x70 / 255));
    assert.deepEqual([...block.subarray(76, 92)], columns);
    assert.deepEqual([...block.subarray(92, 124)], [...IDENTITY, ...IDENTITY]);
    assert.deepEqual([...block.subarray(124, 140)], columns, 'a fourth stage has rows of its own');
    assert.deepEqual([...block.subarray(140, 204)],
        [...IDENTITY, ...IDENTITY, ...IDENTITY, ...IDENTITY], 'identity where none was given');
    assert.deepEqual([...block.subarray(204, 220)], [...IDENTITY]);
    // A block with no transforms at all still carries identities: a stage's
    // sample always goes through its rows.
    const plain = uniformBlock({
        worldViewProjection: IDENTITY,
        viewport: viewportState({ x: 0, y: 0, width: 1, height: 1 }),
        textureFactor: 0,
        fogColor: 0,
        alphaRef: 0,
    });
    assert.deepEqual([...plain.subarray(76, 204)],
        Array.from({ length: 8 }, ()=>[...IDENTITY]).flat());
});

test('a fixed pixel stage behind a shader reads from its own block what the full block holds',
    ()=>{
        // Behind a vertex shader the fixed stages read the texture factor, the
        // fog, the alpha reference and each stage's flags and transform. The
        // block made for them holds those as the full block does, and leaves
        // the vertex half, the shader's work, as identity.
        const tilted = [0.5, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1, 0, 0.25, 0.75, 0, 1];
        const model = /** @type {any} */ ({
            renderStates: new Map([
                [D3DRS.TEXTUREFACTOR, 0x80402010], [D3DRS.FOGCOLOR, 0xff336699],
                [D3DRS.FOGSTART, 0x3f800000], [D3DRS.FOGEND, 0x42c80000],
                [D3DRS.FOGDENSITY, 0x3e800000], [D3DRS.ALPHAREF, 0x1a7f],
            ]),
            stageStates: (/** @type {number} */ stage)=>new Map(stage === 0
                ? [[D3DTSS.TEXTURETRANSFORMFLAGS, 2], [D3DTSS.MAGFILTER, 2]]
                : []),
            textures: new Map(),
            transforms: new Map([
                [D3DTS.WORLD, tilted], [D3DTS.VIEW, tilted], [D3DTS.PROJECTION, tilted],
                [D3DTS.TEXTURE0, tilted],
            ]),
            lights: new Map(),
            material: material8(),
            viewport: viewportState({ x: 2, y: 4, width: 320, height: 200 }),
        });
        const full = uniformsOf(model, null);
        const pixel = pixelUniformsOf(model);
        const at = UNIFORM_AT;
        for (const [name, from, to] of /** @type {[string, number, number][]} */ ([
            ['viewport', at.viewportOffset, at.textureFactor],
            ['texture factor and fog', at.textureFactor, at.materialDiffuse],
            ['alpha reference and stage flags', at.alphaRef, at.textureTransforms],
            ['texture transforms', at.textureTransforms, at.worldView],
        ]))
        {
            assert.deepEqual([...pixel.subarray(from, to)], [...full.subarray(from, to)], name);
        }
        assert.deepEqual([...pixel.subarray(at.worldViewProjection, at.world)], [...IDENTITY],
            'the vertex half is left to the shader');
    });

test('the dump prints a texture transform as the elements a coordinate travels through', async()=>{
    // Recorded commands. The flags and the matrix by columns -- u's, v's,
    // then the w and q a generated coordinate would take -- so a sheet's
    // cell can be read off the first two.
    const h = harness({ width: 640, height: 480, dumpDraws: true });
    const device = h.device;
    assert.equal(device.SetTextureStageState(0, D3DTSS.TEXTURETRANSFORMFLAGS, 2), D3D_OK);
    assert.equal(device.SetTransform(D3DTS.TEXTURE0, [
        0.5, 0, 0, 0,
        0, 0.25, 0, 0,
        0.125, 0.375, 1, 0,
        0.9, 0.9, 0, 1,
    ]), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(
        D3DPT.TRIANGLELIST, 2, quad([0, 0, 10, 10], argb(255, 0, 0)), 20), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    assert.match(device.diagnostics().lastDump[0],
        / texXform=2:0.5,0,0.125,0.9,0,0.25,0.375,0.9,0,0,1,0,0,0,0,1 /,
        'm11, m21, m31, m41 then m12, m22, m32, m42, then the w and q columns');
});

test('a texture transform of more than two coordinates is reported, two are not', async()=>{
    // Recorded commands. Two coordinates through the matrix are applied at
    // the sample, so a program asking for that -- moving or not -- gets what
    // it asked for and nothing is said. Three or four, or a projected divide,
    // are accepted and not acted on, which is the one case that has to speak:
    // in silence it produces a picture instead of an error.
    /** @type {string[]} */
    const said = [];
    // Textured, because a transform on a stage the cascade never runs moves
    // nothing and should stay as quiet as an identity one.
    const draw = (/** @type {any} */ h)=>{
        const texture = textureFrom(h, 1, 1, D3DFMT.A8R8G8B8,
            Uint8Array.from([0, 0, 255, 255]));
        assert.equal(h.device.SetTexture(0, texture), D3D_OK);
        selectTexture(h.device);
        assert.equal(h.device.BeginScene(), D3D_OK);
        assert.equal(h.device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
        assert.equal(h.device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
            quad([0, 0, 2, 2], argb(255, 255, 255), true), 28), D3D_OK);
        assert.equal(h.device.EndScene(), D3D_OK);
    };
    const scaled = [
        2, 0, 0, 0,
        0, 2, 0, 0,
        0.5, 0.5, 1, 0,
        0, 0, 0, 1,
    ];
    const quiet = harness({
        dumpDraws: true,
        divergence: (api, detail)=>said.push(`${api}: ${detail}`),
    });
    assert.equal(quiet.device.SetTextureStageState(0, D3DTSS.TEXTURETRANSFORMFLAGS, 2), D3D_OK);
    assert.equal(quiet.device.SetTransform(D3DTS.TEXTURE0, scaled), D3D_OK);
    draw(quiet);
    assert.equal(said.length, 0, 'two coordinates through a moving matrix are applied');

    for (const flags of [1, 0x100 | 2, 0x100 | 3])
    {
        const h = harness({
            dumpDraws: true,
            divergence: (api, detail)=>said.push(`${api}: ${detail}`),
        });
        assert.equal(h.device.SetTextureStageState(0, D3DTSS.TEXTURETRANSFORMFLAGS, flags),
            D3D_OK);
        assert.equal(h.device.SetTransform(D3DTS.TEXTURE0, scaled), D3D_OK);
        draw(h);
    }
    assert.equal(said.length, 3, 'one coordinate and a projected carried set each spoke once');
    for (const line of said)
    {
        assert.match(line, /^Direct3D 8: a texture transform of one coordinate, or a projected one over a set the vertex carries, is accepted and not applied/);
    }
});

test('every draw sampling one texture can be dropped, by the id the dump names it', async()=>{
    // Recorded commands. A draw's index in a frame moves between runs, so an
    // index cannot remove the same draw twice and two frames cut by index
    // differ by whichever draw happened to land there. The texture it binds
    // does not move, which is what makes this the selector a difference image
    // can be built on.
    const h = harness({ dumpDraws: true, skipTexture: 't1' });
    const device = h.device;
    const first = textureFrom(h, 1, 1, D3DFMT.A8R8G8B8, Uint8Array.from([0, 0, 255, 255]));
    const second = textureFrom(h, 1, 1, D3DFMT.A8R8G8B8, Uint8Array.from([255, 0, 0, 255]));
    selectTexture(device);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
    for (const texture of [first, second])
    {
        assert.equal(device.SetTexture(0, texture), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
            quad([0, 0, 2, 2], argb(255, 255, 255), true), 28), D3D_OK);
    }
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const counted = device.diagnostics();
    assert.equal(counted.draws, 1, 'the draw that bound t1 never reached the queue');
    assert.equal(counted.skipped.texture, 1);
    assert.equal(counted.lastDump.length, 1, 'and the dump lists only the draw that survived');
    assert.match(counted.lastDump[0], /:t0:/);
});

test('a probed draw reports what the target held right after it, inside the frame', async()=>{
    // Recorded commands. A finished frame shows what every draw left; what one
    // draw painted is only knowable by copying the target out before the next
    // one runs, and the copy has to close and reopen the pass without losing
    // what was there or the viewport the rest of the frame runs under.
    const h = harness({ dumpDraws: true, probeTexture: 't0', width: 640, height: 480 });
    const { device, gpu } = h;
    const texture = textureFrom(h, 1, 1, D3DFMT.A8R8G8B8, Uint8Array.from([0, 0, 255, 255]));
    selectTexture(device);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
    assert.equal(device.SetTexture(0, texture), D3D_OK);
    for (let at = 0; at < 2; at++)
    {
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
            quad([0, 0, 2, 2], argb(255, 255, 255), true), 28), D3D_OK);
    }
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const dumped = device.diagnostics().lastDump;
    assert.equal(dumped.length, 2);
    for (const line of dumped)
    {
        // The double keeps texels through uploads, clears and copies and
        // paints nothing for a draw: the target reads as the zeros it was
        // made with, the sampled texture as the texels that were uploaded,
        // and each scratch redraw as the colour its target was cleared to.
        assert.match(line,
            / after=(0\/0\/0,){6}0\/0\/0 distinct=1 tex=(255\/0\/0,){6}255\/0\/0 distinct=1/);
        assert.match(line, / before=(0\/0\/0,){6}0\/0\/0 distinct=1/);
        for (const name of ['again', 'copy', 'host', 'hostuni', 'newpipe', 'newview',
            'newsampler',
            'newshader', 'quad', 'mirrorsampler', 'clampsampler'])
        {
            assert.match(line, new RegExp(` ${name}=(255\\/0\\/255,){6}255\\/0\\/255 distinct=1`),
                `the ${name} redraw's scratch target was cleared, and no draw paints here`);
        }
    }
    assert.equal(gpu.count('copyTextureToBuffer'), 28,
        'nine copies per probed draw: the target after it, the texture it sampled,'
        + ' and the target after each of the seven redraws');
    assert.equal(gpu.count('beginRenderPass'), 27, 'each copy reopens the pass');
    const reopened = gpu.of('beginRenderPass').slice(1).map((/** @type {any} */ call)=>
        call.descriptor.colorAttachments[0].loadOp);
    assert.equal(reopened.filter(op=>op === 'load').length, 4,
        'the frame is reopened keeping what was there, before and after the redraws');
    assert.equal(reopened.filter(op=>op === 'clear').length, 22,
        'each redraw paints into a scratch target cleared first');
    const passes = gpu.of('beginRenderPass').map((/** @type {any} */ call)=>call.pass);
    for (const pass of passes.slice(1))
    {
        assert.ok(gpu.of('setViewport').some((/** @type {any} */ call)=>call.pass === pass),
            'the viewport is set again after each reopening');
    }
});

test('a target whose format has no alpha channel is never written with one', async()=>{
    // Recorded commands. Every backend renders into four channels, because a
    // three-channel target does not exist -- so the channel Direct3D calls
    // undefined for an X8 format is physically there, and a blend that touches
    // it decides how opaque the presented frame is. Nothing in the colours
    // says so, and the picture that results is a hard-edged rectangle of the
    // blending draw's own extent.
    /** @param {number} format */
    const writeMaskOf = async format=>{
        const h = harness({ format });
        const { device, gpu } = h;
        assert.equal(device.SetRenderState(D3DRS.ALPHABLENDENABLE, 1), D3D_OK);
        assert.equal(device.SetRenderState(D3DRS.SRCBLEND, D3DBLEND.SRCALPHA), D3D_OK);
        assert.equal(device.SetRenderState(D3DRS.DESTBLEND, D3DBLEND.ONE), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(
            D3DPT.TRIANGLELIST, 2, quad([0, 0, 4, 4], argb(255, 0, 0, 128)), 20), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
        return gpu.of('createRenderPipeline')[0].descriptor.fragment.targets[0].writeMask;
    };

    assert.equal(await writeMaskOf(D3DFMT.X8R8G8B8), 0x7,
        'colour only, so the opaque alpha the clear left cannot be blended away');
    assert.equal(await writeMaskOf(D3DFMT.A8R8G8B8), 0xf,
        'a format that does have the channel keeps it');
});

// --- recorded: the preparation a state change builds and every later draw reuses ---

/**
 * How many pipelines the backend was asked for, hit or miss: the key of a
 * pipeline is a string per field and a join per stage, so one lookup a draw is
 * the most expensive thing a draw that changed no state can do.
 *
 * @param {ReturnType<typeof harness>} h
 */
function pipelineLookups(h){
    const stats = h.backend.diagnostics().pipelines;
    return stats.built + stats.reused;
}

/**
 * Two identical draws of one quad with `between` run in the middle, and what
 * the renderer made of them.
 *
 * @param {ReturnType<typeof harness>} h
 * @param {() => void} [between]
 */
async function twoDraws(h, between = ()=>{}){
    const { device } = h;
    const geometry = quad([0, 0, 4, 4], argb(255, 0, 0));
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2, geometry, 20), D3D_OK);
    between();
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2, geometry, 20), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    const diagnostics = device.diagnostics();
    return {
        draws: diagnostics.lastFrame.filter((/** @type {any} */ command)=>
            command.kind === 'draw'),
        prepared: diagnostics.prepared,
        lookups: pipelineLookups(h),
    };
}

test('recorded: a draw that changes no state reuses the preparation before it', async()=>{
    // Recorded commands. A frame of a match is hundreds of small draws with the
    // state cache of the program in front of it, so the fixed cost of a draw is
    // the whole cost: the cascade, the bindings, the sampler decisions and the
    // pipeline key depend on state alone and must be worked out once per change.
    const h = harness();
    const { draws, prepared, lookups } = await twoDraws(h);
    assert.equal(draws.length, 2);
    assert.deepEqual(prepared, { built: 1, reused: 1 });
    assert.equal(lookups, 1, 'the pipeline was looked up once, not once a draw');
    assert.equal(draws[0].state, draws[1].state, 'one state object, not two alike');
    assert.equal(draws[0].stageBindings, draws[1].stageBindings);
    assert.equal(draws[0].pipeline, draws[1].pipeline, 'and one entry in the frame pipeline list');
    assert.notEqual(draws[0].uniforms, draws[1].uniforms,
        'each draw still owns its own block in the arena');
});

test('recorded: the world transform reaches each draw of one prepared state', async()=>{
    // Recorded commands. The world matrix moves between most draws of a frame,
    // which is why the device counter that gates the reuse deliberately ignores
    // it -- so this is the test that says the draw still gets its own.
    const h = harness();
    const world = Float32Array.from(IDENTITY);
    world[12] = 7;
    const { draws, prepared } = await twoDraws(h, ()=>{
        assert.equal(h.device.SetTransform(D3DTS.WORLD, world), D3D_OK);
    });
    assert.deepEqual(prepared, { built: 1, reused: 1 },
        'the world transform alone does not build a preparation again');
    const at = UNIFORM_AT;
    assert.equal(draws[0].uniforms[at.world + 12], 0);
    assert.equal(draws[1].uniforms[at.world + 12], 7, 'the second draw carries the new world');
    assert.equal(draws[0].uniforms[at.worldViewProjection + 12], 0);
    assert.equal(draws[1].uniforms[at.worldViewProjection + 12], 7,
        'and its product with the view and the projection');
    // And its product with the view alone, which vertex fog takes its depth
    // from and a generated coordinate its camera space: a draw that read the
    // preparation's fogged and textured by where the first draw's model was.
    assert.equal(draws[0].uniforms[at.worldView + 12], 0);
    assert.equal(draws[1].uniforms[at.worldView + 12], 7);
    // Everything else past the world fields is what the preparation carries,
    // and a draw that rewrote any of it would be a draw served from a stale
    // block.
    assert.deepEqual(
        [...draws[0].uniforms.subarray(at.viewportOffset, at.worldView)],
        [...draws[1].uniforms.subarray(at.viewportOffset, at.worldView)],
        'and nothing else');
    assert.deepEqual(
        [...draws[0].uniforms.subarray(at.worldView + 16)],
        [...draws[1].uniforms.subarray(at.worldView + 16)]);
});

test('recorded: every state group the device publishes ends the reuse', async()=>{
    // Recorded commands. One case per group of the device state a preparation
    // is derived from. A group missing from this table is a group whose change
    // a later draw would not see: the picture then carries the state of the
    // draw before it, with nothing anywhere reporting it.
    /** @type {[string, (h: ReturnType<typeof harness>) => void][]} */
    const groups = [
        ['a render state', h=>{
            assert.equal(h.device.SetRenderState(D3DRS.ALPHABLENDENABLE, 1), D3D_OK);
        }],
        ['a texture stage state', h=>{
            assert.equal(h.device.SetTextureStageState(0, D3DTSS.ADDRESSU, D3DTADDRESS.CLAMP),
                D3D_OK);
        }],
        // The same call the guest-side shadow makes when it settles a texture
        // the program bound without crossing: the device setter is the funnel.
        ['a texture bound to a stage', h=>{
            const texture = textureFrom(h, 1, 1, D3DFMT.X8R8G8B8, new Uint8Array(4));
            assert.equal(h.device.SetTexture(0, texture), D3D_OK);
        }],
        ['a material', h=>{
            assert.equal(h.device.SetMaterial({
                Diffuse: { r: 1, g: 0, b: 0, a: 1 },
                Ambient: { r: 0, g: 0, b: 0, a: 1 },
                Specular: { r: 0, g: 0, b: 0, a: 1 },
                Emissive: { r: 0, g: 0, b: 0, a: 1 },
                Power: 1,
            }), D3D_OK);
        }],
        ['a light', h=>{
            assert.equal(h.device.LightEnable(0, true), D3D_OK);
        }],
        ['the viewport', h=>{
            assert.equal(h.device.SetViewport(
                { X: 0, Y: 0, Width: 2, Height: 2, MinZ: 0, MaxZ: 1 }), D3D_OK);
        }],
        ['a transform other than the world', h=>{
            const view = Float32Array.from(IDENTITY);
            view[13] = 3;
            assert.equal(h.device.SetTransform(D3DTS.VIEW, view), D3D_OK);
        }],
    ];
    for (const [what, change] of groups)
    {
        const h = harness();
        const { prepared } = await twoDraws(h, ()=>change(h));
        assert.deepEqual(prepared, { built: 2, reused: 0 }, `${what} was prepared for again`);
    }
});

test('recorded: a state change between two draws is the state the second draw runs under',
    async()=>{
        // Recorded commands. The counter says a preparation was built again;
        // this says the draw that followed it carries the new value, which is
        // the only thing a picture can be judged by.
        const h = harness();
        const { draws } = await twoDraws(h, ()=>{
            assert.equal(h.device.SetRenderState(D3DRS.ALPHABLENDENABLE, 1), D3D_OK);
            assert.equal(h.device.SetRenderState(D3DRS.SRCBLEND, D3DBLEND.SRCALPHA), D3D_OK);
            assert.equal(h.device.SetRenderState(D3DRS.DESTBLEND, D3DBLEND.INVSRCALPHA), D3D_OK);
        });
        assert.equal(draws[0].state.blend, false);
        assert.equal(draws[1].state.blend, true);
        assert.equal(draws[1].state.srcBlend, D3DBLEND.SRCALPHA);
        assert.notEqual(draws[0].pipeline, draws[1].pipeline, 'and a pipeline of its own');
    });

test('recorded: a state set to the value it already holds is not a change', async()=>{
    // Recorded commands. A program that sets a whole block of state before
    // every draw is ordinary, and a counter raised by the call rather than by
    // the change would make the reuse unreachable for such a program.
    const h = harness();
    assert.equal(h.device.SetRenderState(D3DRS.ALPHABLENDENABLE, 1), D3D_OK);
    const { prepared } = await twoDraws(h, ()=>{
        assert.equal(h.device.SetRenderState(D3DRS.ALPHABLENDENABLE, 1), D3D_OK);
        assert.equal(h.device.SetVertexShader(FVF_QUAD), D3D_OK);
        assert.equal(h.device.SetTextureStageState(0, D3DTSS.ADDRESSU, D3DTADDRESS.WRAP), D3D_OK);
    });
    assert.deepEqual(prepared, { built: 1, reused: 1 });
});

test('recorded: a vertex shader bound and unbound between two draws leaves their state reusable',
    async()=>{
        // Recorded commands. The excursion through a declaration is declined
        // and changes nothing the two quad draws do, so the state they share
        // is still the state that was built: a cache keyed on the values
        // serves the second from the first, and the handle never leaks into it.
        const h = harness();
        /** @type {{ handle?: number }} */
        const made = {};
        assert.equal(h.device.CreateVertexShader([0xffffffff], null, made), D3D_OK);
        const { draws, prepared } = await twoDraws(h, ()=>{
            assert.equal(h.device.SetVertexShader(made.handle ?? 0), D3D_OK);
            // Declined: the declaration loads no position, so the
            // fixed-function stage has nothing to read -- which is what makes
            // it an excursion.
            assert.equal(h.device.DrawPrimitiveUP(
                D3DPT.TRIANGLELIST, 2, quad([0, 0, 4, 4], 0), 20), D3D_OK);
            assert.equal(h.device.SetVertexShader(FVF_QUAD), D3D_OK);
        });
        assert.equal(draws.length, 2, 'the draw through the shader was not recorded');
        assert.deepEqual(prepared, { built: 1, reused: 1 });
        assert.equal(draws[0].state, draws[1].state, 'and the fixed-function state came back');
    });

test('recorded: a device reset ends the reuse', async()=>{
    // Recorded commands. A reset takes the state back to its defaults and
    // builds the implicit surfaces again, so every view a preparation holds is
    // a view of something that no longer exists.
    const h = harness();
    const { device } = h;
    const geometry = quad([0, 0, 4, 4], argb(255, 0, 0));
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2, geometry, 20), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    assert.equal(device.Reset(), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2, geometry, 20), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    assert.deepEqual(device.diagnostics().prepared, { built: 2, reused: 0 });
});

test('recorded: a texture rewritten between two draws is uploaded before the second', async()=>{
    // Recorded commands. The upload owed to a texture happens inside the draw
    // that samples it, so a preparation that already holds the view of that
    // texture has to be built again when the program rewrites its bytes --
    // otherwise the frame samples what the texture held last time. The first
    // draw samples it too, so the second upload is the frame's, between them.
    const h = harness();
    const { device, gpu } = h;
    const texture = textureFrom(h, 1, 1, D3DFMT.X8R8G8B8, Uint8Array.from([1, 2, 3, 255]));
    assert.equal(device.SetTexture(0, texture), D3D_OK);
    selectTexture(device);
    const geometry = new Uint8Array(28 * 6);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2, geometry, 28), D3D_OK);
    /** @type {{ pBits?: number }} */
    const locked = {};
    assert.equal(texture.LockRect(0, locked, null, 0), D3D_OK);
    h.write(/** @type {number} */ (locked.pBits), Uint8Array.from([9, 8, 7, 255]));
    assert.equal(texture.UnlockRect(0), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2, geometry, 28), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    assert.deepEqual(device.diagnostics().prepared, { built: 2, reused: 0 });
    assert.equal(gpu.count('writeTexture'), 1, 'the old bytes went straight to the queue');
    const [copy] = gpu.of('copyBufferToTexture');
    assert.ok(copy, 'the new bytes went up as well as the old');
    const staged = gpu.of('writeBuffer').find((/** @type {any} */ call)=>
        call.buffer === copy.source.buffer);
    assert.deepEqual([...staged.bytes.subarray(0, 4)], [9, 8, 7, 255]);
});

test('recorded: a frame of a match prepares once per state change, not once per draw', async()=>{
    // Recorded commands. The shape of a settled battle frame at 640x480: 372
    // draws, a state change before about two in five of them, the world
    // transform moved before every one. What is asserted is the shape and not a
    // time -- but the shape is the whole of why the frame is faster, because
    // every count below is work the draw used to do again from scratch.
    const DRAWS = 372;
    const h = harness();
    const { device } = h;
    const geometry = quad([0, 0, 4, 4], argb(255, 0, 0));
    const world = Float32Array.from(IDENTITY);
    const lookupsBefore = pipelineLookups(h);
    let changes = 0;
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    for (let index = 0; index < DRAWS; index++)
    {
        if (index % 12 < 5)
        {
            changes++;
            // A value no earlier draw set, so it is a change every time.
            assert.equal(device.SetRenderState(D3DRS.ALPHAREF, index), D3D_OK);
        }
        world[12] = index;
        assert.equal(device.SetTransform(D3DTS.WORLD, world), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2, geometry, 20), D3D_OK);
    }
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    // One preparation per change, and no more: the first draw of the frame is
    // one of the changing ones, so it needs no preparation of its own.
    const states = changes;
    assert.equal(states, 155, 'the frame this is modelled on');
    assert.deepEqual(device.diagnostics().prepared, { built: states, reused: DRAWS - states });
    assert.equal(pipelineLookups(h) - lookupsBefore, states,
        'the pipeline was looked up once per state, not once per draw');
    assert.equal(h.backend.diagnostics().pipelines.built, 1,
        'and every one of those states wants the same pipeline: the alpha reference'
        + ' is a uniform, so a key built per draw was 372 strings for one pipeline');
    const draws = device.diagnostics().lastFrame.filter((/** @type {any} */ command)=>
        command.kind === 'draw');
    assert.equal(draws.length, DRAWS);

    // The repeat path allocates nothing it can share: the draws of one state
    // hold the same state, bindings and pipeline entry, and differ only in the
    // block each took from the frame arena.
    const runs = new Set(draws.map((/** @type {any} */ command)=>command.state));
    assert.equal(runs.size, states);
    assert.equal(new Set(draws.map((/** @type {any} */ command)=>command.pipeline)).size, states);
    assert.equal(new Set(draws.map((/** @type {any} */ command)=>command.uniforms)).size, DRAWS);
});

test('recorded: a frame whose state never changes prepares once and binds one pipeline', async()=>{
    // Recorded commands. The floor of the draw path: the world transform is the
    // only thing that moves, which is the case a run of consecutive draws of one
    // mesh actually is.
    const DRAWS = 372;
    const h = harness();
    const { device } = h;
    const geometry = quad([0, 0, 4, 4], argb(255, 0, 0));
    const world = Float32Array.from(IDENTITY);
    const lookupsBefore = pipelineLookups(h);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    for (let index = 0; index < DRAWS; index++)
    {
        world[12] = index;
        assert.equal(device.SetTransform(D3DTS.WORLD, world), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2, geometry, 20), D3D_OK);
    }
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    assert.deepEqual(device.diagnostics().prepared, { built: 1, reused: DRAWS - 1 });
    assert.equal(pipelineLookups(h) - lookupsBefore, 1);
    const draws = device.diagnostics().lastFrame.filter((/** @type {any} */ command)=>
        command.kind === 'draw');
    assert.equal(new Set(draws.map((/** @type {any} */ command)=>command.state)).size, 1);
    assert.equal(new Set(draws.map((/** @type {any} */ command)=>command.stageBindings)).size, 1);
    // And each still drew where its own transform put it.
    assert.deepEqual(draws.map((/** @type {any} */ command)=>
        command.uniforms[UNIFORM_AT.world + 12]), [...Array(DRAWS).keys()]);
});

test('recorded: two draws alternating between two states prepare once each', async()=>{
    // Recorded commands. The shape a one-entry cache cannot serve: the state
    // changes on every draw, but it only ever changes back and forth between
    // two sets of values, so there are two preparations to build and not one
    // per draw. The device counter cannot name either state -- it only says
    // something changed -- which is why the cache is keyed on the values.
    const DRAWS = 100;
    const h = harness();
    const { device } = h;
    const geometry = quad([0, 0, 4, 4], argb(255, 0, 0));
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    for (let index = 0; index < DRAWS; index++)
    {
        assert.equal(device.SetRenderState(D3DRS.ALPHAREF, index % 2), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2, geometry, 20), D3D_OK);
    }
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    assert.deepEqual(device.diagnostics().prepared, { built: 2, reused: DRAWS - 2 });
    const draws = device.diagnostics().lastFrame.filter((/** @type {any} */ command)=>
        command.kind === 'draw');
    assert.equal(draws.length, DRAWS);
    assert.equal(new Set(draws.map((/** @type {any} */ command)=>command.state)).size, 2,
        'one state object per distinct state, not one per draw');
    // The two states want the same pipeline: the alpha reference is a uniform,
    // so the pipeline is looked up once and the two preparations share it.
    assert.equal(h.backend.diagnostics().pipelines.built, 1);
    // And each draw still carries its own alpha reference, whichever
    // preparation it was served from.
    assert.deepEqual(draws.map((/** @type {any} */ command)=>
        command.uniforms[UNIFORM_AT.alphaRef]),
    [...Array(DRAWS).keys()].map(index=>Math.fround((index % 2) / 255)));
});

test('recorded: a texture bound before each draw is served from its own preparation', async()=>{
    // Recorded commands. The shape of a terrain or a water surface: a new
    // texture before each draw and nothing else changed, so the rest of the
    // state is named once and each draw still binds the texture it asked for.
    const DRAWS = 40;
    const h = harness();
    const { device } = h;
    const white = Uint8Array.from({ length: 16 }, ()=>255);
    const textures = [0, 1, 2].map(()=>textureFrom(h, 2, 2, D3DFMT.A8R8G8B8, white));
    selectTexture(device);
    const geometry = quad([0, 0, 4, 4], argb(255, 255, 255), true);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
    for (let index = 0; index < DRAWS; index++)
    {
        assert.equal(device.SetTexture(0, textures[index % 3]), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2, geometry, 28), D3D_OK);
    }
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    assert.deepEqual(device.diagnostics().prepared, { built: 3, reused: DRAWS - 3 });
    const views = device.diagnostics().lastFrame
        .filter((/** @type {any} */ command)=>command.kind === 'draw')
        .map((/** @type {any} */ command)=>command.stageBindings[0].view);
    assert.equal(new Set(views).size, 3);
    views.forEach((/** @type {any} */ view, /** @type {number} */ index)=>{
        assert.equal(view, views[index % 3], `draw ${index} sampled another texture`);
    });
});

test('recorded: a texture released for the last time goes once no stage binds it', async()=>{
    // Recorded commands. A program that streams its textures creates and
    // releases them all the time, and the GPU texture has to go with them or
    // every one made is kept. A binding holds its texture without a public
    // reference, so a texture released while bound lives until it is unbound.
    const h = harness();
    const { device } = h;
    const texture = textureFrom(h, 2, 2, D3DFMT.A8R8G8B8, new Uint8Array(16));
    selectTexture(device);
    const geometry = quad([0, 0, 4, 4], argb(255, 255, 255), true);
    const draw = async()=>{
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2, geometry, 28), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
    };
    assert.equal(device.SetTexture(0, texture), D3D_OK);
    await draw();
    const made = h.gpu.of('createTexture').at(-1).texture;
    assert.equal(device.diagnostics().textureRecords.length, 1);

    assert.equal(texture.release(), 0);
    assert.equal(device.diagnostics().textureRecords.length, 0, 'no longer listed');
    await draw();
    assert.equal(h.gpu.of('destroyTexture').length, 0, 'still bound, still drawn with');

    assert.equal(device.SetTexture(0, null), D3D_OK);
    await h.present();
    assert.deepEqual(h.gpu.of('destroyTexture').map((/** @type {any} */ call)=>call.texture),
        [made], 'destroyed at the first present that finds it bound nowhere');
});

test('recorded: a view transform changed and set back is two preparations, not three', async()=>{
    // Recorded commands. The transforms beside the world one are part of the
    // state's name even when no string of them is rebuilt: a new matrix is a
    // new state, and the old matrix set again is the old state.
    const h = harness();
    const { device } = h;
    const geometry = quad([0, 0, 4, 4], argb(255, 0, 0));
    const shifted = Float32Array.from(IDENTITY);
    shifted[13] = 2;
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF.XYZ | FVF.DIFFUSE), D3D_OK);
    for (const view of [IDENTITY, shifted, IDENTITY, shifted])
    {
        assert.equal(device.SetTransform(D3DTS.VIEW, view), D3D_OK);
        assert.equal(device.SetRenderState(D3DRS.ALPHAREF, 1), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2, geometry, 16), D3D_OK);
        assert.equal(device.SetRenderState(D3DRS.ALPHAREF, 0), D3D_OK);
    }
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    assert.deepEqual(device.diagnostics().prepared, { built: 2, reused: 2 });
    const translations = device.diagnostics().lastFrame
        .filter((/** @type {any} */ command)=>command.kind === 'draw')
        .map((/** @type {any} */ command)=>command.uniforms[UNIFORM_AT.worldViewProjection + 13]);
    assert.deepEqual(translations, [0, 2, 0, 2]);
});

test('fog: the table mode is the one that runs when it is set, else the vertex mode', ()=>{
    /** @param {Record<number, number>} states @returns {any} */
    const modelOf = states=>({
        renderStates: new Map(Object.entries(states)
            .map(([state, value])=>[Number(state), value])),
    });
    // Table fog takes precedence at the API's own rule: both are set here and
    // the table mode is the one Direct3D runs.
    const both = modelOf({
        [D3DRS.FOGENABLE]: 1,
        [D3DRS.FOGTABLEMODE]: D3DFOG.LINEAR,
        [D3DRS.FOGVERTEXMODE]: D3DFOG.EXP,
    });
    assert.equal(fogModeOf(both), D3DFOG.LINEAR);
    // Only the vertex mode set is vertex fog.
    const vertexOnly = modelOf({
        [D3DRS.FOGENABLE]: 1,
        [D3DRS.FOGTABLEMODE]: D3DFOG.NONE,
        [D3DRS.FOGVERTEXMODE]: D3DFOG.EXP,
    });
    assert.equal(fogModeOf(vertexOnly), D3DFOG.EXP);
    // A mode set while fog is disabled fogs nothing, and neither does a
    // caller's own switch.
    const disabled = modelOf({
        [D3DRS.FOGENABLE]: 0,
        [D3DRS.FOGTABLEMODE]: D3DFOG.LINEAR,
    });
    assert.equal(fogModeOf(disabled), D3DFOG.NONE);
    assert.equal(fogModeOf(both, false), D3DFOG.NONE);

    // Where the factor comes from follows the same rule, and fog enabled with
    // neither mode set is the specular alpha rather than no fog at all.
    assert.deepEqual(fogOf(both), { source: FOG_SOURCE.TABLE, mode: D3DFOG.LINEAR });
    assert.deepEqual(fogOf(vertexOnly), { source: FOG_SOURCE.VERTEX, mode: D3DFOG.EXP });
    assert.deepEqual(fogOf(modelOf({ [D3DRS.FOGENABLE]: 1 })),
        { source: FOG_SOURCE.SPECULAR, mode: D3DFOG.NONE });
    assert.deepEqual(fogOf(disabled), { source: FOG_SOURCE.NONE, mode: D3DFOG.NONE });
});

test('fog: range fog is vertex fog over the distance from the eye, and table fog ignores it',
    async()=>{
        // Wine's d3d9 fog_test, "Test RANGEFOG vs FOGTABLEMODE": a quad at
        // z = 0.5 with corners at x, y = +/-1 under identity matrices, linear
        // fog from 0.75 to 0.75001. With D3DRS_RANGEFOGENABLE vertex fog takes
        // each corner's distance from the eye, 1.5, and the quad is all fog
        // colour; table fog does not use range fog, takes z = 0.5, and the
        // quad keeps its colour.
        const draw = async(/** @type {number} */ table)=>{
            const h = harness({ width: 640, height: 480 });
            const { device } = h;
            device.SetRenderState(D3DRS.LIGHTING, 0);
            device.SetRenderState(D3DRS.FOGENABLE, 1);
            device.SetRenderState(D3DRS.RANGEFOGENABLE, 1);
            device.SetRenderState(D3DRS.FOGSTART, floatToDword(0.75));
            device.SetRenderState(D3DRS.FOGEND, floatToDword(0.75001));
            device.SetRenderState(D3DRS.FOGTABLEMODE, table);
            device.SetRenderState(D3DRS.FOGVERTEXMODE, D3DFOG.LINEAR);
            assert.equal(device.BeginScene(), D3D_OK);
            assert.equal(device.SetVertexShader(FVF.XYZ | FVF.DIFFUSE), D3D_OK);
            const bytes = new DataView(new ArrayBuffer(16 * 4));
            [[-1, -1], [-1, 1], [1, -1], [1, 1]].forEach(([x, y], index)=>{
                bytes.setFloat32(index * 16, x, true);
                bytes.setFloat32(index * 16 + 4, y, true);
                bytes.setFloat32(index * 16 + 8, 0.5, true);
            });
            assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLESTRIP, 2,
                new Uint8Array(bytes.buffer), 16), D3D_OK);
            assert.equal(device.EndScene(), D3D_OK);
            await h.present();
            return h.device.diagnostics().lastFrame
                .find((/** @type {any} */ c)=>c.kind === 'draw');
        };
        const ranged = await draw(D3DFOG.NONE);
        assert.equal(ranged.state.fogSource, FOG_SOURCE.VERTEX);
        assert.equal(ranged.state.rangeFog, true);
        const worldView = ranged.uniforms.subarray(UNIFORM_AT.worldView,
            UNIFORM_AT.worldView + 16);
        const range = { start: 0.75, end: 0.75001, density: 1 };
        for (const corner of [[-1, -1, 0.5], [1, 1, 0.5]])
        {
            const eye = transformPosition(worldView, corner);
            assert.equal(fogFactor(D3DFOG.LINEAR, Math.hypot(eye[0], eye[1], eye[2]), range), 0,
                'the corner is all fog');
        }
        assert.ok(generateFixedFunction(ranged.state, decodeFvf(ranged.state.fvf)).code
            .includes('fogFactorOf(length((uniforms.worldView'));

        const table = await draw(D3DFOG.LINEAR);
        assert.equal(table.state.fogSource, FOG_SOURCE.TABLE);
        assert.equal(table.state.rangeFog, false, 'range fog is vertex fog alone');
        assert.equal(fogFactor(D3DFOG.LINEAR, 0.5, range), 1, 'z = 0.5 keeps the colour');
    });

test('fog: table fog is taken over z under an affine projection, over w otherwise', ()=>{
    // Microsoft's "Pixel Fog": a projection whose fourth column is
    // (0, 0, 0, 1) is affine and fogs by z; Wine's test_fog has _44 = 1.01
    // fog by w. The block's fog row carries which, beside the range.
    assert.equal(isAffine(IDENTITY), true);
    const perspective = [...IDENTITY];
    perspective[15] = 1.01;
    assert.equal(isAffine(perspective), false);
    const projective = [...IDENTITY];
    projective[11] = 1;
    projective[15] = 0;
    assert.equal(isAffine(projective), false);

    const block = (/** @type {boolean} */ affineProjection)=>uniformBlock({
        worldViewProjection: IDENTITY,
        viewport: viewportState({ x: 0, y: 0, width: 4, height: 4 }),
        textureFactor: 0,
        fogColor: 0,
        alphaRef: 0,
        fogFactors: [2, 10, 0.5],
        affineProjection,
    });
    assert.deepEqual([...block(true).subarray(UNIFORM_AT.fogFactors, UNIFORM_AT.fogFactors + 4)],
        [2, 10, 0.5, 1]);
    assert.equal(block(false)[UNIFORM_AT.fogFactors + 3], 0);
});

test('recorded: the fog interpolation scene fogs as Windows does in every mode', async()=>{
    // Wine's d3d8 and d3d9 test_fog_interpolation: a quad from x = -1 to 1
    // whose z runs from 0 on the left to 1 on the right under identity
    // matrices, the stage colour blue, the fog green at density 5, and a
    // specular alpha from 1 on the left to 0 on the right. Windows reads
    // blue at the left edge in every case, 0x00fd02 at the right, and in the
    // middle the interpolated specular alpha or vertex factor (0x007f80) or,
    // for table fog, the curve at z = 0.5 (0x00ea15) -- not the mean of the
    // ends. What is checked is what the renderer hands the shader -- the
    // source, the curve, the depth the block says to take, the camera-space
    // depth of each vertex -- carried through the reference's fog formula,
    // and that the shader takes the factor from the same place.
    const cases = [
        [D3DFOG.NONE, D3DFOG.NONE, 1, 0x007f80],
        [D3DFOG.NONE, D3DFOG.NONE, 2, 0x007f80],
        [D3DFOG.EXP, D3DFOG.NONE, 1, 0x007f80],
        [D3DFOG.EXP, D3DFOG.NONE, 2, 0x007f80],
        [D3DFOG.NONE, D3DFOG.EXP, 1, 0x00ea15],
        [D3DFOG.NONE, D3DFOG.EXP, 2, 0x00ea15],
        [D3DFOG.EXP, D3DFOG.EXP, 1, 0x00ea15],
        [D3DFOG.EXP, D3DFOG.EXP, 2, 0x00ea15],
    ];
    const fvf = FVF.XYZ | FVF.DIFFUSE | FVF.SPECULAR;
    const stride = 20;
    const corners = [[-1, -1, 0, 0xff000000], [-1, 1, 0, 0xff000000],
        [1, -1, 1, 0x00000000], [1, 1, 1, 0x00000000]];
    const bytes = new DataView(new ArrayBuffer(stride * 4));
    corners.forEach(([x, y, z, specular], index)=>{
        bytes.setFloat32(index * stride, x, true);
        bytes.setFloat32(index * stride + 4, y, true);
        bytes.setFloat32(index * stride + 8, z, true);
        bytes.setUint32(index * stride + 12, 0xffff0000, true);
        bytes.setUint32(index * stride + 16, specular, true);
    });
    const blue = { r: 0, g: 0, b: 255, a: 255 };
    const green = { r: 0, g: 255, b: 0, a: 255 };
    /** @param {number} rgb */
    const colourOf = rgb=>({ r: (rgb >> 16) & 0xff, g: (rgb >> 8) & 0xff, b: rgb & 0xff });

    for (const [vertexMode, tableMode, shade, middle] of cases)
    {
        const h = harness({ width: 640, height: 480 });
        const { device } = h;
        device.SetRenderState(D3DRS.LIGHTING, 0);
        device.SetRenderState(D3DRS.ZENABLE, 0);
        device.SetRenderState(D3DRS.FOGENABLE, 1);
        device.SetRenderState(D3DRS.FOGCOLOR, 0x0000ff00);
        device.SetRenderState(D3DRS.FOGDENSITY, floatToDword(5));
        device.SetRenderState(D3DRS.TEXTUREFACTOR, 0x000000ff);
        device.SetRenderState(D3DRS.SHADEMODE, shade);
        device.SetRenderState(D3DRS.FOGVERTEXMODE, vertexMode);
        device.SetRenderState(D3DRS.FOGTABLEMODE, tableMode);
        device.SetTextureStageState(0, D3DTSS.COLOROP, D3DTOP.SELECTARG1);
        device.SetTextureStageState(0, D3DTSS.COLORARG1, D3DTA.TFACTOR);
        device.SetTransform(D3DTS.PROJECTION, IDENTITY);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.SetVertexShader(fvf), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLESTRIP, 2,
            new Uint8Array(bytes.buffer), stride), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
        const draw = h.device.diagnostics().lastFrame
            .find((/** @type {any} */ c)=>c.kind === 'draw');
        const state = draw.state;
        const fog = draw.uniforms.subarray(UNIFORM_AT.fogFactors, UNIFORM_AT.fogFactors + 4);
        const range = { start: fog[0], end: fog[1], density: fog[2] };
        const code = generateFixedFunction(state, decodeFvf(state.fvf)).code;
        const worldView = draw.uniforms.subarray(UNIFORM_AT.worldView, UNIFORM_AT.worldView + 16);
        const cameraZ = (/** @type {number[]} */ at)=>transformPosition(worldView, at)[2];

        /** @param {number} t  from the left edge to the right, as the pixel centre lies */
        const factorAt = t=>{
            if (state.fogSource === FOG_SOURCE.TABLE)
            {
                assert.ok(code.includes('fogFactorOf(select(1.0 / input.position.w,'
                    + ' input.position.z, uniforms.fogFactors.w != 0.0))'));
                // The pixel's z is the interpolated z; its w is one here.
                return fogFactor(state.fogMode, fog[3] !== 0 ? t : 1, range);
            }
            if (state.fogSource === FOG_SOURCE.VERTEX)
            {
                assert.ok(code.includes('out.fogAmount = fogFactorOf(abs((uniforms.worldView'));
                const left = fogFactor(state.fogMode, Math.abs(cameraZ([-1, 0, 0])), range);
                const right = fogFactor(state.fogMode, Math.abs(cameraZ([1, 0, 1])), range);
                return left + (right - left) * t;
            }
            assert.equal(state.fogSource, FOG_SOURCE.SPECULAR);
            assert.ok(code.includes('out.fogAmount = vertex.specular.a;'));
            return 1 - t;
        };
        const label = `vertex ${vertexMode}, table ${tableMode}, shade ${shade}`;
        for (const [x, expected] of [[0, 0x0000ff], [320, middle], [639, 0x00fd02]])
        {
            const got = referenceFogged(blue, green, factorAt(x / 640));
            const want = colourOf(expected);
            for (const channel of /** @type {const} */ (['r', 'g', 'b']))
            {
                assert.ok(Math.abs(got[channel] - want[channel]) <= 2,
                    `${label}: x=${x} ${channel} ${got[channel]} against ${want[channel]}`);
            }
        }
    }
});

test('a signed bump map is sampled from rgba8snorm, U and V as they lie and the rest at one', ()=>{
    // Wine's d3d9 visual.c texbem_test: a ps_1_1 device's V8U8 texture.
    assert.equal(gpuFormatOf(D3DFMT.V8U8, 128, 128, true), 'rgba8snorm');
    assert.equal(gpuFormatOf(D3DFMT.Q8W8V8U8, 4, 4, false), 'rgba8snorm');
    assert.deepEqual([...expandTexels(D3DFMT.V8U8, Uint8Array.from([0x80, 0x7f, 0x01, 0xff]), 2)],
        [0x80, 0x7f, 0x7f, 0x7f, 0x01, 0xff, 0x7f, 0x7f]);
});

test('an L6V5U5 bump map widens its five-bit U and V and six-bit luminance into rgba8snorm', ()=>{
    assert.equal(gpuFormatOf(D3DFMT.L6V5U5, 64, 64, false), 'rgba8snorm');
    // U=+15 V=-16 L=63, then U=-1 V=0 L=0.
    const first = 0x0f | (0x10 << 5) | (63 << 10);
    const second = 0x1f;
    const texels = Uint8Array.from([first & 0xff, first >>> 8, second & 0xff, second >>> 8]);
    assert.deepEqual([...new Int8Array(expandTexels(D3DFMT.L6V5U5, texels, 2).buffer)],
        [127, -127, 127, 127, -8, 0, 0, 127]);
});

test('a texture samples the channels its format lacks as Direct3D does, each by one rule', ()=>{
    // Wine's d3d9 visual.c: R16F and R32F read (r, 1, 1, 1); G16R16F, G32R32F
    // and G16R16 (r, g, 1, 1). Their GPU textures hold one and two channels,
    // so a read fills the rest, alpha too; every other format is expanded on
    // upload to four channels that hold Direct3D's answer already, and fills
    // nothing.
    /** @type {Map<number, number>} */
    const expected = new Map([
        [D3DFMT9.R16F, 0b1110], [D3DFMT9.R32F, 0b1110],
        [D3DFMT9.G16R16F, 0b1100], [D3DFMT9.G32R32F, 0b1100], [D3DFMT9.G16R16, 0b1100],
    ]);
    for (const format of Object.keys(FORMAT_INFO).map(Number))
    {
        assert.equal(sampledOnes(format), expected.get(format) ?? 0, `format ${format}`);
    }
    assert.equal(sampledOnes(0), 0, 'an unknown format fills nothing');
    // The narrow formats of eight bits answer from their expansion: A8 is
    // (0, 0, 0, a), the luminance formats (l, l, l, a or 1), V8U8 (u, v, 1, 1),
    // L6V5U5 (u, v, l, 1) and Q8W8V8U8 (u, v, w, q).
    assert.deepEqual([...expandTexels(D3DFMT.A8, Uint8Array.from([9]), 1)], [0, 0, 0, 9]);
    assert.deepEqual([...expandTexels(D3DFMT9.Q8W8V8U8, Uint8Array.from([1, 0x81, 3, 0x7f]), 1)],
        [1, 0x81, 3, 0x7f], 'u, v, w and q as they lie, red first in rgba8snorm');
});

test('a cascade stage says what its texture fills, and a stage that samples nothing says nothing',
    ()=>{
        const narrow = { name: 'narrow' };
        const plain = { name: 'plain' };
        const states = [
            new Map([[D3DTSS.COLOROP, D3DTOP.SELECTARG1], [D3DTSS.COLORARG1, D3DTA.TEXTURE],
                [D3DTSS.ALPHAOP, D3DTOP.SELECTARG1], [D3DTSS.ALPHAARG1, D3DTA.TEXTURE]]),
            new Map([[D3DTSS.COLOROP, D3DTOP.MODULATE], [D3DTSS.COLORARG1, D3DTA.TEXTURE],
                [D3DTSS.COLORARG2, D3DTA.CURRENT], [D3DTSS.ALPHAOP, D3DTOP.SELECTARG1],
                [D3DTSS.ALPHAARG1, D3DTA.CURRENT]]),
            new Map([[D3DTSS.COLOROP, D3DTOP.MODULATE], [D3DTSS.COLORARG1, D3DTA.DIFFUSE],
                [D3DTSS.COLORARG2, D3DTA.CURRENT], [D3DTSS.ALPHAOP, D3DTOP.SELECTARG1],
                [D3DTSS.ALPHAARG1, D3DTA.CURRENT]]),
            new Map([[D3DTSS.COLOROP, D3DTOP.DISABLE]]),
        ];
        const model = /** @type {any} */ ({
            renderStates: new Map(),
            stageStates: (/** @type {number} */ stage)=>states[stage] ?? new Map(),
            textures: new Map([[0, narrow], [1, plain], [2, narrow]]),
        });
        const layout = decodeFvf(FVF.XYZ | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT));
        const filled = stageCascade(model, layout,
            { onesOf: texture=>(texture === narrow ? 0b1110 : 0) }).stages;
        assert.equal(filled[0].ones, 0b1110);
        assert.equal('ones' in filled[1], false, 'four channels add nothing to the key');
        assert.equal('ones' in filled[2], false, 'nor does a texture the stage never reads');
        const unfilled = stageCascade(model, layout).stages;
        assert.ok(unfilled.every(stage=>!('ones' in stage)), 'none is asked for by default');
        assert.deepEqual(unfilled.slice(1), filled.slice(1));
    });

test('a cascade stage that samples carries its level-of-detail bias, and only one that is set',
    ()=>{
        const texture = { name: 'texture' };
        const bits = (/** @type {number} */ value)=>new Uint32Array(Float32Array.of(value).buffer)[0];
        const states = [
            new Map([[D3DTSS.COLOROP, D3DTOP.SELECTARG1], [D3DTSS.COLORARG1, D3DTA.TEXTURE],
                [D3DTSS.ALPHAOP, D3DTOP.SELECTARG1], [D3DTSS.ALPHAARG1, D3DTA.TEXTURE],
                [D3DTSS.MIPMAPLODBIAS, bits(-0.75)]]),
            new Map([[D3DTSS.COLOROP, D3DTOP.MODULATE], [D3DTSS.COLORARG1, D3DTA.TEXTURE],
                [D3DTSS.COLORARG2, D3DTA.CURRENT], [D3DTSS.ALPHAOP, D3DTOP.SELECTARG1],
                [D3DTSS.ALPHAARG1, D3DTA.CURRENT], [D3DTSS.MIPMAPLODBIAS, bits(1e30)]]),
            // A bias on a stage that samples nothing shapes nothing.
            new Map([[D3DTSS.COLOROP, D3DTOP.MODULATE], [D3DTSS.COLORARG1, D3DTA.DIFFUSE],
                [D3DTSS.COLORARG2, D3DTA.CURRENT], [D3DTSS.ALPHAOP, D3DTOP.SELECTARG1],
                [D3DTSS.ALPHAARG1, D3DTA.CURRENT], [D3DTSS.MIPMAPLODBIAS, bits(2)]]),
            new Map([[D3DTSS.COLOROP, D3DTOP.MODULATE], [D3DTSS.COLORARG1, D3DTA.TEXTURE],
                [D3DTSS.COLORARG2, D3DTA.CURRENT], [D3DTSS.ALPHAOP, D3DTOP.SELECTARG1],
                [D3DTSS.ALPHAARG1, D3DTA.CURRENT], [D3DTSS.MIPMAPLODBIAS, bits(NaN)]]),
        ];
        const model = /** @type {any} */ ({
            renderStates: new Map(),
            stageStates: (/** @type {number} */ stage)=>states[stage] ?? new Map(),
            textures: new Map([[0, texture], [1, texture], [2, texture], [3, texture]]),
        });
        const layout = decodeFvf(FVF.XYZ | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT));
        const stages = stageCascade(model, layout).stages;
        assert.equal(stages[0].lodBias, -0.75);
        assert.equal(stages[1].lodBias, 16, 'held to what hardware reaches');
        assert.equal('lodBias' in stages[2], false);
        assert.equal('lodBias' in stages[3], false, 'a bias that is no number is none');
        assert.equal(lodBiasOf(bits(-0)), 0);
    });

test('a floating-point surface is an r16float, R32F narrowed to half precision on upload', ()=>{
    assert.equal(gpuFormatOf(D3DFMT.R16F, 64, 64, false), 'r16float');
    assert.equal(gpuFormatOf(D3DFMT.R32F, 64, 64, true), 'r16float');
    const floats = new Uint8Array(Float32Array.from([1, 0.5, -2, 65504]).buffer);
    assert.deepEqual([...new Uint16Array(expandTexels(D3DFMT.R32F, floats, 4).buffer)],
        [0x3c00, 0x3800, 0xc000, 0x7bff]);
    const halves = Uint8Array.from([0x00, 0x3c, 0x00, 0x38]);
    assert.deepEqual([...expandTexels(D3DFMT.R16F, halves, 2)], [...halves]);
});

test('a wide format is half floats by its channel count, red first, converted on upload', ()=>{
    /** @param {number[]} values @returns {Uint8Array} */
    const f32 = values=>new Uint8Array(Float32Array.from(values).buffer);
    /** @param {number[]} values @returns {Uint8Array} */
    const u16 = values=>new Uint8Array(Uint16Array.from(values).buffer);
    /** @param {Uint8Array} bytes */
    const halvesOf = bytes=>[...new Uint16Array(bytes.slice().buffer)];
    // Two texels each, every channel distinct, so a channel out of order shows.
    for (const { format, gpu, texels, halves } of [
        { format: D3DFMT.A16B16G16R16F, gpu: 'rgba16float',
            texels: u16([0x3c00, 0x3800, 0x0000, 0x3c00, 0xc000, 0x4000, 0x7bff, 0x0001]),
            halves: [0x3c00, 0x3800, 0x0000, 0x3c00, 0xc000, 0x4000, 0x7bff, 0x0001] },
        { format: D3DFMT.G16R16F, gpu: 'rg16float',
            texels: u16([0x3c00, 0x3800, 0xc000, 0x4000]),
            halves: [0x3c00, 0x3800, 0xc000, 0x4000] },
        { format: D3DFMT.A32B32G32R32F, gpu: 'rgba16float',
            texels: f32([1, 0.5, 0, 1, -2, 2, 65504, 1e6]),
            halves: [0x3c00, 0x3800, 0x0000, 0x3c00, 0xc000, 0x4000, 0x7bff, 0x7c00] },
        { format: D3DFMT.G32R32F, gpu: 'rg16float',
            texels: f32([1, 0.5, -2, 0.1]),
            halves: [0x3c00, 0x3800, 0xc000, 0x2e66] },
        { format: D3DFMT.A16B16G16R16, gpu: 'rgba16float',
            texels: u16([0xffff, 0, 0x8000, 0xffff, 0, 0xffff, 1, 0]),
            halves: [0x3c00, 0, 0x3800, 0x3c00, 0, 0x3c00, toHalf(1 / 0xffff), 0] },
        { format: D3DFMT.G16R16, gpu: 'rg16float',
            texels: u16([0xffff, 0, 0x8000, 0x4000]),
            halves: [0x3c00, 0, 0x3800, 0x3400] },
    ])
    {
        assert.equal(gpuFormatOf(format, 64, 64, true), gpu, `format ${format}`);
        assert.deepEqual(halvesOf(expandTexels(format, texels, 2)), halves, `format ${format}`);
    }
});

test('every format a surface is drawn into is one core WebGPU filters and blends into', ()=>{
    // Narrowing the 32-bit floats is what keeps this true; a mapping onto
    // `rgba32float` without float32-blendable needs the pipeline to drop the
    // blend it cannot make, and CheckDeviceFormat to stop offering it.
    for (const [key, info] of Object.entries(FORMAT_INFO))
    {
        const format = Number(key);
        if (info.depth || info.signed || info.video || isCompressed(format))
        {
            continue;
        }
        const traits = formatTraits(gpuFormatOf(format, 64, 64, true));
        assert.deepEqual(traits, { filterable: true, blendable: true }, `format ${format}`);
    }
});

test('recorded: a draw under the stencil test carries it, its reference set on the pass;'
    + ' a clear ignores it', async()=>{
    // A program marks pixels in the stencil and then lets only some draws write
    // through them -- a depth put back everywhere but where the scene stood is one --
    // and a renderer that drops the test lets those draws write everywhere.
    const h = harness();
    const { device, gpu } = h;
    const set = (/** @type {number} */ state, /** @type {number} */ value)=>
        assert.equal(device.SetRenderState(state, value), D3D_OK);
    set(52, 1);
    set(56, 6);
    set(57, 0xff);
    set(55, 3);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(60), 20), D3D_OK);
    assert.equal(device.Clear(1, [{ x1: 1, y1: 1, x2: 3, y2: 3 }], D3DCLEAR.TARGET,
        argb(4, 5, 6), 1, 0), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();

    const [drawn, cleared] = gpu.of('createRenderPipeline')
        .map((/** @type {any} */ call)=>call.descriptor.depthStencil);
    assert.deepEqual(drawn.stencilBack,
        { compare: 'not-equal', failOp: 'keep', depthFailOp: 'keep', passOp: 'replace' });
    assert.deepEqual(drawn.stencilFront, drawn.stencilBack, 'one-sided: both faces alike');
    assert.equal(drawn.stencilReadMask, 0xff);
    assert.deepEqual(gpu.of('setStencilReference').map((/** @type {any} */ call)=>call.reference),
        [0xff]);
    assert.equal(cleared.stencilFront, undefined, 'the clear quad runs no stencil test');
});

test('a blend by D3DRS_BLENDFACTOR sets that colour on the pass, out of the pipeline key', ()=>{
    const model = /** @type {any} */ ({
        renderStates: new Map([[27, 1], [19, 14], [20, 15], [193, 0x80402010]]),
    });
    const shape = {
        fvf: 0, targetFormat: 'bgra8unorm', depthFormat: undefined, topology: 'triangle-list',
        stages: [],
    };
    const state = pipelineStateOf(model, shape);
    assert.equal(state.blendConstant, 0x80402010);
    assert.equal(pipelineKey(state), pipelineKey({ ...state, blendConstant: 0 }));
    // Unset, it reads as its default, opaque white; a blend that reads no
    // constant carries none.
    model.renderStates.delete(193);
    assert.equal(pipelineStateOf(model, shape).blendConstant, 0xffffffff);
    model.renderStates.set(19, 5);
    model.renderStates.set(20, 6);
    assert.equal(pipelineStateOf(model, shape).blendConstant, undefined);
});

test('recorded: a draw blended by D3DRS_BLENDFACTOR sets it on the pass', async()=>{
    const h = harness();
    const { device, gpu } = h;
    const set = (/** @type {number} */ state, /** @type {number} */ value)=>
        device.SetRenderState(state, value);
    set(27, 1);
    set(19, 14);
    set(20, 6);
    // A Direct3D 8 device has no BLENDFACTOR state to set, so the draw
    // blends by its default, opaque white; the value is pipelineStateOf's.
    assert.notEqual(set(193, 0xff00ff00), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(60), 20), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    assert.deepEqual(gpu.of('setBlendConstant').map((/** @type {any} */ call)=>call.color),
        [{ r: 1, g: 1, b: 1, a: 1 }]);
});

test('a dump asked for on a running device writes down that many frames, then stops', async()=>{
    /** @type {{ lines: string[], frame: number }[]} */
    const handed = [];
    const liveDump = { dumpFrames: 0,
        written: (/** @type {string[]} */ lines, /** @type {number} */ frame)=>
            handed.push({ lines, frame }) };
    const h = harness({ width: 64, height: 64, liveDump });
    const { device } = h;
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    const frame = async()=>{
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
            quad([0, 0, 8, 8], argb(255, 255, 0, 0)), 20), D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
        return device.diagnostics().lastDump.length;
    };
    assert.equal(await frame(), 0, 'nothing until it is asked for');
    liveDump.dumpFrames = 1;
    assert.equal(await frame(), 1, 'the frame after the asking, one line a draw');
    assert.equal(liveDump.dumpFrames, 0, 'counted down');
    assert.equal(await frame(), 1, 'and kept, for a report asked for a frame later');
    const dumped = device.diagnostics().lastDump;
    assert.match(dumped[0], /^#0 /);
    // Handed over as it was written, once, with the frame it was.
    assert.deepEqual(handed, [{ lines: dumped, frame: 1 }]);
});

test('a frame submitted early for a read-back keeps the lines of its draws', async()=>{
    const h = harness({ width: 64, height: 64, dumpDraws: true });
    const { device } = h;
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
        quad([0, 0, 8, 8], argb(255, 0, 0)), 20), D3D_OK);
    // A chain presenting into a window the display does not show sends what
    // the frame has so far to the GPU, without ending the frame.
    /** @type {{ swapChain?: any }} */
    const chain = {};
    assert.equal(device.CreateAdditionalSwapChain({ windowed: true, backBufferWidth: 8,
        backBufferHeight: 8, swapEffect: 1 }, chain), D3D_OK);
    await chain.swapChain.Present(false);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
        quad([8, 8, 16, 16], argb(0, 255, 0)), 20), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    const dumped = device.diagnostics().lastDump.filter((/** @type {string} */ line)=>/^#/.test(line));
    assert.equal(dumped.length, 2, `both draws: ${device.diagnostics().lastDump.join(' | ')}`);
    chain.swapChain.release();
});

test('every word of every sixteen-bit format unpacks through its table as the formula says', ()=>{
    // The table is built once from the unpacking itself; this holds it to the
    // formats' definitions, word by word, so a table read wrongly shows.
    const five = (/** @type {number} */ v)=>(v << 3) | (v >>> 2);
    const six = (/** @type {number} */ v)=>(v << 2) | (v >>> 4);
    const four = (/** @type {number} */ v)=>(v << 4) | v;
    /** @type {[number, (w: number) => number[]][]} */
    const formats = [
        [D3DFMT.R5G6B5, w=>[five(w & 31), six((w >>> 5) & 63), five(w >>> 11), 255]],
        [D3DFMT.X1R5G5B5, w=>[five(w & 31), five((w >>> 5) & 31), five((w >>> 10) & 31), 255]],
        [D3DFMT.A1R5G5B5, w=>[five(w & 31), five((w >>> 5) & 31), five((w >>> 10) & 31),
            w & 0x8000 ? 255 : 0]],
        [D3DFMT.A4R4G4B4, w=>[four(w & 15), four((w >>> 4) & 15), four((w >>> 8) & 15),
            four(w >>> 12)]],
        [D3DFMT.X4R4G4B4, w=>[four(w & 15), four((w >>> 4) & 15), four((w >>> 8) & 15), 255]],
    ];
    const words = new Uint8Array(0x20000);
    for (let w = 0; w < 0x10000; w++)
    {
        words[w * 2] = w & 0xff;
        words[w * 2 + 1] = w >>> 8;
    }
    for (const [format, formula] of formats)
    {
        const out = expandTexels(format, words, 0x10000);
        for (let w = 0; w < 0x10000; w++)
        {
            const want = formula(w);
            if (out[w * 4] !== want[0] || out[w * 4 + 1] !== want[1]
                || out[w * 4 + 2] !== want[2] || out[w * 4 + 3] !== want[3])
            {
                assert.fail(`format ${format}, word 0x${w.toString(16)}: `
                    + `${[...out.subarray(w * 4, w * 4 + 4)]} for ${want}`);
            }
        }
    }
});

test('a program\'s dump line names the constants its shaders read and its declaration', ()=>{
    // A picture drawn black under shaders that translate is a constant or a
    // vertex element that reached them as zero, which only these say.
    const bits = (/** @type {number} */ x)=>new Uint32Array(Float32Array.of(x).buffer)[0];
    // vs_2_0: def c3, 1, 2, 3, 4; add r0, c1, c2[a0.x]; add r1, c3, c1
    const shader = parseShader(Uint32Array.from([0xfffe0200,
        0x05000051, 0xa00f0003, bits(1), bits(2), bits(3), bits(4),
        0x04000002, 0x800f0000, 0xa0e40001, 0xa0e42002, 0xb0000000,
        0x03000002, 0x800f0001, 0xa0e40003, 0xa0e40001, 0x0000ffff]));
    assert.equal(shader.error, null);
    const floats = new Float32Array(256 * 4);
    floats.set([0.5, 0, 1 / 3, 2], 4);
    assert.equal(describeConstants(shader, floats), 'c1(0.5,0,0.3333,2) c2[a]',
        'read by number with its values, through a0 by its first register, a def left out');
    assert.equal(describeConstants(null, floats), '-');
    assert.equal(describeDeclaration([
        { Stream: 0, Offset: 0, Type: 2, Usage: 0, UsageIndex: 0 },
        { Stream: 1, Offset: 12, Type: 4, Usage: 10, UsageIndex: 1 },
    ]), '0:0:t2:u0/0,1:12:t4:u10/1');
    assert.equal(describeDeclaration(null), '-');
});

test('a running device asked to keep fewer texture stages draws with that many, and with all again'
    + ' once asked for all, the state it drew with before prepared again', async()=>{
    const liveDump = { dumpFrames: 0, stageLimit: -1 };
    const h = harness({ liveDump });
    const { device, gpu } = h;
    const texture = textureFrom(h, 1, 1, D3DFMT.A8R8G8B8, Uint8Array.from([1, 2, 3, 4]));
    assert.equal(device.SetTexture(0, texture), D3D_OK);
    assert.equal(device.SetTexture(1, texture), D3D_OK);
    device.SetTextureStageState(1, D3DTSS.COLOROP, D3DTOP.MODULATE);
    device.SetTextureStageState(1, D3DTSS.ALPHAOP, D3DTOP.SELECTARG1);
    const fvf = FVF.XYZRHW | FVF.DIFFUSE | (2 << FVF.TEXCOUNT_SHIFT);
    assert.equal(device.SetVertexShader(fvf), D3D_OK);
    /** The stages the frame's draw sampled, as its dump line lists them. */
    const frame = async()=>{
        liveDump.dumpFrames = 1;
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(36 * 3), 36),
            D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
        const line = device.diagnostics().lastDump.find((/** @type {string} */ one)=>/^#0 /.test(one));
        return (String(line).match(/#\d+:t\d+/g) ?? []).length;
    };
    assert.equal(await frame(), 2, 'two stages');
    liveDump.stageLimit = 1;
    assert.equal(await frame(), 1, 'one stage, though the program changed nothing');
    liveDump.stageLimit = -1;
    assert.equal(await frame(), 2, 'two again');
    void gpu;
});

test('a bump matrix moved draw by draw draws through one pipeline, each matrix in its block',
    async()=>{
        // A program that animates or fades a bump-env-mapped surface sets
        // BUMPENVMAT every draw. Written into the shader, each value was a
        // pipeline of its own, built and compiled every frame -- a clone at the
        // middle distance cost the GPU twenty milliseconds a frame.
        const h = harness();
        const { device, gpu } = h;
        const texture = textureFrom(h, 1, 1, D3DFMT.A8R8G8B8, Uint8Array.from([1, 2, 3, 4]));
        assert.equal(device.SetTexture(0, texture), D3D_OK);
        assert.equal(device.SetTexture(1, texture), D3D_OK);
        device.SetTextureStageState(0, D3DTSS.COLOROP, D3DTOP.BUMPENVMAPLUMINANCE);
        device.SetTextureStageState(0, D3DTSS.COLORARG1, D3DTA.TEXTURE);
        device.SetTextureStageState(1, D3DTSS.COLOROP, D3DTOP.MODULATE);
        device.SetTextureStageState(1, D3DTSS.ALPHAOP, D3DTOP.SELECTARG1);
        const fvf = FVF.XYZRHW | FVF.DIFFUSE | (2 << FVF.TEXCOUNT_SHIFT);
        assert.equal(device.SetVertexShader(fvf), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        for (const scale of [0.25, 0.5, 0.75])
        {
            device.SetTextureStageState(0, D3DTSS.BUMPENVMAT00, floatToDword(scale));
            device.SetTextureStageState(0, D3DTSS.BUMPENVLSCALE, floatToDword(scale * 2));
            assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(36 * 3), 36),
                D3D_OK);
        }
        assert.equal(device.EndScene(), D3D_OK);
        await h.present();
        assert.equal(gpu.count('createRenderPipeline'), 1, 'one pipeline for every matrix');
        // Each draw's block carries its own matrix, as the shader reads it.
        const blocks = gpu.of('writeBuffer').map((/** @type {any} */ call)=>call)
            .filter((/** @type {any} */ call)=>call.buffer.descriptor.label?.startsWith('uniforms'));
        const floats = blocks.flatMap((/** @type {any} */ call)=>
            [...new Float32Array(call.bytes.slice().buffer)]);
        for (const scale of [0.25, 0.5, 0.75])
        {
            const index = floats.findIndex((value, at)=>value === scale
                && floats[at + 4] === scale * 2);
            assert.ok(index >= 0, `the block of the draw with matrix ${scale} carries it`);
        }
    });

test('a dump asked for a texture\'s stats reads its top level as the guest left it', async()=>{
    /** @type {string[][]} */
    const handed = [];
    const liveDump = { dumpFrames: 0, textureStats: '',
        written: (/** @type {string[]} */ lines)=>handed.push(lines) };
    const h = harness({ liveDump });
    const { device } = h;
    const texture = textureFrom(h, 2, 1, D3DFMT.A8R8G8B8,
        Uint8Array.from([0, 0, 0, 0, 2, 4, 6, 8]));
    assert.equal(device.SetTexture(0, texture), D3D_OK);
    selectTexture(device);
    assert.equal(device.SetVertexShader(FVF_QUAD), D3D_OK);
    liveDump.dumpFrames = 1;
    liveDump.textureStats = 't0,t999';
    assert.equal(device.BeginScene(), D3D_OK);
    assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
        quad([0, 0, 8, 8], argb(255, 255, 0, 0), true), 28), D3D_OK);
    assert.equal(device.EndScene(), D3D_OK);
    await h.present();
    const dumped = handed[0] ?? [];
    const line = dumped.find((/** @type {string} */ one)=>one.startsWith('texture t0'));
    assert.ok(line, dumped.join(' | '));
    assert.match(line, /least 0 most 8 mean 2\.5000 zero 50\.0%/);
    assert.ok(dumped.includes('texture t999: not known'));
});
