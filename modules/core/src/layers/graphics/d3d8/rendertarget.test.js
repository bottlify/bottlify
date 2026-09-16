/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One backend texture per Direct3D surface, whichever way the program reaches
 * it: a render-target texture drawn into and then sampled reads what was
 * drawn, a copy from a render target carries the pixels the GPU holds, and a
 * read-back brings them into guest memory.
 *
 * Byte-exact, the way `render.test.js` is: the frame is recomputed on the
 * processor from the commands the renderer recorded and the bytes the backend
 * put on the queue, with one reference surface per target. What a draw paints
 * is the reference rasteriser's; what a clear, an upload or a copy moves is
 * followed through the recording double, which keeps texels for exactly those.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    D3DCLEAR, D3DFMT, D3DPOOL, D3DPT, D3DSWAPEFFECT, D3DTA, D3DTOP, D3DTSS, D3DUSAGE, D3D_OK,
} from './constants.js';
import { createDirect3D8 } from './device.js';
import { createDirect3D9 } from '../d3d9/device.js';
import { colorToFloats } from './render.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { FVF, decodeFvf } from '../webgpu/internal/vertexformat.js';
import {
    clear as referenceClear, createReferenceSurface, fillRect, toBase64,
} from '../webgpu/internal/reference.js';

const RAM_BASE = 0x40000000;
const RAM_SIZE = 32 << 20;

const FVF_TEXTURED_QUAD = FVF.XYZRHW | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT);

/** @param {number} r @param {number} g @param {number} b @param {number} [a] */
const argb = (r, g, b, a = 255)=>((a << 24) | (r << 16) | (g << 8) | b) >>> 0;

/**
 * A device of either version over the recording GPU, with guest memory it can
 * read and write.
 *
 * @param {8 | 9} version
 * @param {{ width?: number, height?: number, lockableBackBuffer?: boolean }} [options]
 */
function harness(version, options = {}){
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
    let next = RAM_BASE;
    /** @type {string[]} */
    const reports = [];
    const services = {
        backend,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        /** @param {number} address @param {number} length */
        windowMemory: (address, length)=>
            ram.subarray(address - RAM_BASE, address - RAM_BASE + length),
        /** @param {number} address @param {Uint8Array} bytes */
        writeMemory: (address, bytes)=>ram.set(bytes, address - RAM_BASE),
        /** @param {any} descriptor */
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
        /** @param {number} bytes */
        allocate: bytes=>{
            const address = next;
            next += bytes + 0x100;
            return address;
        },
        /** @param {string} _api @param {string} detail */
        divergence: (_api, detail)=>reports.push(detail),
    };
    const parameters = {
        swapEffect: D3DSWAPEFFECT.DISCARD,
        backBufferCount: 1,
        backBufferWidth: options.width ?? 4,
        backBufferHeight: options.height ?? 4,
        backBufferFormat: D3DFMT.X8R8G8B8,
        enableAutoDepthStencil: false,
    };
    /** @type {{ device?: any }} */
    const out = {};
    if (version === 9)
    {
        const d3d = createDirect3D9(services);
        assert.equal(d3d.CreateDevice({
            ...parameters, lockableBackBuffer: options.lockableBackBuffer === true,
        }, out), D3D_OK);
    }
    else
    {
        const d3d = createDirect3D8(services);
        assert.equal(d3d.CreateDevice({ ...parameters, flags: options.lockableBackBuffer ? 1 : 0 },
            out), D3D_OK);
    }
    const device = out.device;
    return {
        gpu,
        presented,
        reports,
        device,
        /** @param {number} address @param {number} length */
        read(address, length){
            return ram.slice(address - RAM_BASE, address - RAM_BASE + length);
        },
        /** @param {number} address @param {Uint8Array} bytes */
        write(address, bytes){
            ram.set(bytes, address - RAM_BASE);
        },
        async present(){
            assert.equal(device.Present(), D3D_OK);
            await device.idle();
        },
        /** The back buffer, whichever version's call hands it out. */
        backBuffer(){
            /** @type {{ surface?: any }} */
            const held = {};
            assert.equal(version === 9
                ? device.GetBackBuffer(0, 0, 0, held)
                : device.GetBackBuffer(0, 0, held), D3D_OK);
            held.surface.release();
            return held.surface;
        },
        /** @param {any} surface */
        setTarget(surface){
            assert.equal(version === 9
                ? device.SetRenderTarget(0, surface)
                : device.SetRenderTarget(surface, null), D3D_OK);
        },
        /** @param {number} colour */
        clear(colour){
            assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, colour, 1, 0), D3D_OK);
        },
        /** @param {any} texture stage zero selects the texture and nothing else */
        drawSampling(texture){
            assert.equal(device.SetTexture(0, texture), D3D_OK);
            device.SetTextureStageState(0, D3DTSS.COLOROP, D3DTOP.SELECTARG1);
            device.SetTextureStageState(0, D3DTSS.COLORARG1, D3DTA.TEXTURE);
            device.SetTextureStageState(0, D3DTSS.ALPHAOP, D3DTOP.SELECTARG1);
            device.SetTextureStageState(0, D3DTSS.ALPHAARG1, D3DTA.TEXTURE);
            assert.equal(device.BeginScene(), D3D_OK);
            assert.equal(version === 9
                ? device.SetFVF(FVF_TEXTURED_QUAD)
                : device.SetVertexShader(FVF_TEXTURED_QUAD), D3D_OK);
            assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 2,
                quad([0, 0, parameters.backBufferWidth, parameters.backBufferHeight]), 28), D3D_OK);
            assert.equal(device.EndScene(), D3D_OK);
        },
        /**
         * A render-target texture and its top level.
         *
         * @param {number} width @param {number} height
         */
        renderTargetTexture(width, height){
            /** @type {{ texture?: any }} */
            const made = {};
            assert.equal(device.CreateTexture(width, height, 1, D3DUSAGE.RENDERTARGET,
                D3DFMT.X8R8G8B8, D3DPOOL.DEFAULT, made), D3D_OK);
            /** @type {{ surface?: any }} */
            const level = {};
            assert.equal(made.texture.GetSurfaceLevel(0, level), D3D_OK);
            level.surface.release();
            return { texture: made.texture, level: level.surface };
        },
    };
}

/**
 * Two triangles over `[x1, x2) x [y1, y2)` in target pixels, white, with the
 * texture spanning the rectangle exactly once.
 *
 * @param {number[]} rect
 */
function quad(rect){
    const [x1, y1, x2, y2] = rect;
    const corners = [
        [[x1, y1], [0, 0]], [[x2, y1], [1, 0]], [[x1, y2], [0, 1]],
        [[x1, y2], [0, 1]], [[x2, y1], [1, 0]], [[x2, y2], [1, 1]],
    ];
    const out = new Uint8Array(28 * 6);
    corners.forEach(([corner, uv], index)=>{
        const bytes = new DataView(out.buffer, index * 28, 28);
        bytes.setFloat32(0, corner[0], true);
        bytes.setFloat32(4, corner[1], true);
        bytes.setFloat32(8, 0.5, true);
        bytes.setFloat32(12, 1, true);
        bytes.setUint32(16, argb(255, 255, 255), true);
        bytes.setFloat32(20, uv[0], true);
        bytes.setFloat32(24, uv[1], true);
    });
    return out;
}

/** @param {any} surface @param {number} x @param {number} y */
const pixelAt = (surface, x, y)=>
    [...surface.bytes.subarray((y * surface.width + x) * 4, (y * surface.width + x) * 4 + 4)];

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

/**
 * The software evaluation of the last frame the device replayed, one
 * reference surface per backend texture the frame touched.
 *
 * A draw's texture is the reference surface of the texture its stage binds
 * when the frame drew or copied into that texture, and the texels the queue
 * carried for it otherwise. An upload command carries its own texels; a copy
 * moves rows between two surfaces.
 *
 * @param {ReturnType<typeof harness>} h
 * @returns {{ of: (surface: any) => any, frame: any[] }}
 */
function rasterise(h){
    /** @type {Map<any, any>} backend texture -> reference surface */
    const surfaces = new Map();
    /** @param {any} surface a backend surface */
    const of = surface=>{
        let made = surfaces.get(surface.texture);
        if (!made)
        {
            made = createReferenceSurface(surface.texture.descriptor.size.width,
                surface.texture.descriptor.size.height);
            surfaces.set(surface.texture, made);
        }
        return made;
    };
    /** @param {any} view a texture view a draw bound */
    const sampled = view=>{
        if (surfaces.has(view.texture))
        {
            return surfaces.get(view.texture);
        }
        const uploads = h.gpu.of('writeTexture').filter((/** @type {any} */ call)=>
            call.destination.texture === view.texture);
        assert.ok(uploads.length > 0, 'the texture this draw samples reached the queue');
        const upload = uploads[uploads.length - 1];
        return { width: upload.size.width, height: upload.size.height, bytes: upload.bytes };
    };
    /** @type {any} */
    let target = null;
    const frame = h.device.diagnostics().lastFrame;
    for (const command of frame)
    {
        if (command.kind === 'pass')
        {
            target = of(command.target);
            if (command.clearColor)
            {
                const c = command.clearColor;
                referenceClear(target, {
                    r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255),
                });
            }
            continue;
        }
        if (command.kind === 'upload')
        {
            const into = of(command.surface);
            assert.equal(command.mipLevel, 0, 'the evaluator keeps top levels only');
            into.bytes.set(command.texels.subarray(0, into.bytes.length));
            continue;
        }
        if (command.kind === 'copy')
        {
            const from = of(command.source);
            const into = of(command.destination);
            for (let row = 0; row < command.height; row++)
            {
                const start = ((command.sourceOrigin.y + row) * from.width + command.sourceOrigin.x)
                    * 4;
                into.bytes.set(from.bytes.subarray(start, start + command.width * 4),
                    ((command.destinationOrigin.y + row) * into.width + command.destinationOrigin.x)
                        * 4);
            }
            continue;
        }
        if (command.kind !== 'draw')
        {
            continue;
        }
        const layout = decodeFvf(command.state.fvf);
        assert.ok(layout.preTransformed, 'the evaluator understands pre-transformed quads only');
        assert.equal(command.count, 6);
        const bytes = queuedBytes(h.gpu, command.vertices, 6 * layout.stride);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const xs = new Set();
        const ys = new Set();
        let colour = 0;
        for (let index = 0; index < 6; index++)
        {
            xs.add(view.getFloat32(index * layout.stride, true));
            ys.add(view.getFloat32(index * layout.stride + 4, true));
            colour = view.getUint32(index * layout.stride + 16, true);
        }
        const [x1, x2] = [...xs].sort((a, b)=>a - b);
        const [y1, y2] = [...ys].sort((a, b)=>a - b);
        const diffuse = colorToFloats(colour);
        fillRect(target, { x0: x1, y0: y1, x1: x2, y1: y2 }, {
            diffuse: {
                r: diffuse.r * 255, g: diffuse.g * 255, b: diffuse.b * 255, a: diffuse.a * 255,
            },
            texture: sampled(command.stageBindings[0].view),
            stages: command.state.stages,
            blend: false,
        });
    }
    return { of, frame };
}

for (const version of /** @type {const} */ ([9, 8]))
{
    test(`byte-exact (D3D${version}): a render-target texture drawn into and then sampled`
        + ' reads what was drawn', async()=>{
        const h = harness(version);
        const { texture, level } = h.renderTargetTexture(2, 2);
        h.setTarget(level);
        h.clear(argb(0x12, 0x34, 0x56));
        h.setTarget(h.backBuffer());
        h.clear(argb(0, 0, 255));
        h.drawSampling(texture);
        await h.present();

        const passes = h.device.diagnostics().lastFrame.filter(
            (/** @type {any} */ command)=>command.kind === 'pass');
        const draw = h.device.diagnostics().lastFrame.find(
            (/** @type {any} */ command)=>command.kind === 'draw');
        assert.equal(passes.length, 2);
        assert.equal(passes[0].target.texture, draw.stageBindings[0].view.texture,
            'the level the clear went into and the texture the draw samples are one texture');
        assert.equal(h.gpu.count('copyBufferToTexture') + h.gpu.count('writeTexture'), 1,
            'the level was uploaded once, from its untouched guest bytes, and never again');
        const presented = rasterise(h).of(h.presented[0].surface);
        assert.deepEqual(pixelAt(presented, 0, 0), [0x56, 0x34, 0x12, 0xff]);
        assert.deepEqual(pixelAt(presented, 3, 3), [0x56, 0x34, 0x12, 0xff]);
        assert.equal(toBase64(presented),
            'VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/w==',
            'the whole back buffer is the colour the render target was cleared to');
        assert.equal(h.reports.length, 0);
    });

    test(`byte-exact (D3D${version}): a copy from the back buffer into a render-target texture`
        + ' carries the pixels the GPU holds', async()=>{
        const h = harness(version);
        const { texture, level } = h.renderTargetTexture(4, 4);
        const backBuffer = h.backBuffer();
        h.clear(argb(0x21, 0x43, 0x65));
        if (version === 9)
        {
            assert.equal(h.device.StretchRect(backBuffer, null, level, null, 1), D3D_OK);
        }
        else
        {
            assert.equal(h.device.CopyRects(backBuffer, null, 0, level, null), D3D_OK);
        }
        h.clear(argb(0, 0, 255));
        h.drawSampling(texture);
        await h.present();

        const kinds = h.device.diagnostics().lastFrame.map(
            (/** @type {any} */ command)=>command.kind);
        const moves = kinds.filter((/** @type {string} */ kind)=>
            kind !== 'viewport' && kind !== 'upload');
        assert.deepEqual(moves, ['pass', 'copy', 'pass', 'draw'],
            'the copy is a frame command between the clear before it and the clear after it');
        const copies = h.gpu.of('copyTextureToTexture');
        assert.equal(copies.length, 1, 'and it is a texture-to-texture copy on the encoder');
        assert.equal(copies[0].source.texture, h.presented[0].surface.texture);
        assert.equal(copies[0].destination.texture, h.device.diagnostics().lastFrame.find(
            (/** @type {any} */ command)=>command.kind === 'draw').stageBindings[0].view.texture);
        const presented = rasterise(h).of(h.presented[0].surface);
        assert.deepEqual(pixelAt(presented, 2, 1), [0x65, 0x43, 0x21, 0xff]);
        assert.equal(toBase64(presented),
            'ZUMh/2VDIf9lQyH/ZUMh/2VDIf9lQyH/ZUMh/2VDIf9lQyH/ZUMh/2VDIf9lQyH/ZUMh/2VDIf9lQyH/ZUMh/w==',
            'the frame presents what the back buffer held when it was copied');
        assert.equal(h.reports.length, 0, 'nothing to report: no guest bytes were copied');
    });

    test(`recorded (D3D${version}): a lock write to a plain texture still uploads before the`
        + ' draw that samples it', async()=>{
        const h = harness(version);
        /** @type {{ texture?: any }} */
        const made = {};
        assert.equal(h.device.CreateTexture(1, 1, 1, 0, D3DFMT.A8R8G8B8, D3DPOOL.MANAGED, made),
            D3D_OK);
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(made.texture.LockRect(0, locked, null, 0), D3D_OK);
        h.write(/** @type {number} */ (locked.pBits), Uint8Array.from([0x56, 0x34, 0x12, 0xff]));
        assert.equal(made.texture.UnlockRect(0), D3D_OK);
        h.clear(argb(0, 0, 255));
        h.drawSampling(made.texture);
        await h.present();

        assert.equal(h.gpu.count('writeTexture'), 1, 'a plain texture goes straight to the queue');
        assert.equal(h.gpu.count('copyBufferToTexture'), 0);
        const presented = rasterise(h).of(h.presented[0].surface);
        assert.equal(toBase64(presented),
            'VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/w==');
    });
}

test('byte-exact (D3D9): GetRenderTargetData after a clear reads the clear colour into guest'
    + ' memory', async()=>{
    const h = harness(9);
    const backBuffer = h.backBuffer();
    /** @type {{ surface?: any }} */
    const twin = {};
    assert.equal(h.device.CreateOffscreenPlainSurface(4, 4, D3DFMT.X8R8G8B8, D3DPOOL.SYSTEMMEM,
        twin), D3D_OK);
    h.write(twin.surface.base, new Uint8Array(64).fill(0xab));
    h.clear(argb(0x12, 0x34, 0x56));
    assert.equal(await h.device.GetRenderTargetData(backBuffer, twin.surface), D3D_OK);

    // The frame recorded so far went to the GPU without a present, the clear
    // pass first and the copy out of the target after it.
    assert.equal(h.presented.length, 0);
    assert.equal(h.gpu.count('submit'), 1);
    const ops = h.gpu.calls.filter((/** @type {any} */ call)=>
        call.op === 'beginRenderPass' || call.op === 'copyTextureToBuffer').map(
        (/** @type {any} */ call)=>call.op);
    assert.deepEqual(ops, ['beginRenderPass', 'copyTextureToBuffer']);
    const readback = h.gpu.of('copyTextureToBuffer')[0];
    assert.equal(readback.source.texture, h.gpu.of('beginRenderPass')[0]
        .descriptor.colorAttachments[0].view.texture, 'read from the target that was cleared');
    const evaluated = rasterise(h).of({ texture: readback.source.texture });
    assert.equal(toBase64(evaluated),
        'VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/1Y0Ev9WNBL/VjQS/w==');
    // And the guest bytes are those pixels, in the surface's own layout.
    assert.equal(Buffer.from(h.read(twin.surface.base, 64)).toString('base64'),
        toBase64(evaluated),
        'the destination holds the clear colour, blue byte first, X8 as opaque');
    assert.deepEqual([...h.read(twin.surface.base, 4)], [0x56, 0x34, 0x12, 0xff]);
    assert.equal(h.reports.length, 0, 'a read-back that reads back reports nothing');

    // The frame goes on after the read-back and presents as one more submit.
    h.clear(argb(0, 0, 255));
    await h.present();
    assert.equal(h.gpu.count('submit'), 2);
    assert.equal(h.presented.length, 1);
});

test('byte-exact (D3D9): a lock of a lockable back buffer reads the GPU back, and the unlock'
    + ' uploads what was written', async()=>{
    const h = harness(9, { lockableBackBuffer: true });
    const backBuffer = h.backBuffer();
    h.clear(argb(0x12, 0x34, 0x56));
    /** @type {{ pBits?: number, Pitch?: number }} */
    const locked = {};
    assert.equal(await backBuffer.LockRect(locked, null, 0), D3D_OK);
    assert.deepEqual([...h.read(/** @type {number} */ (locked.pBits), 4)],
        [0x56, 0x34, 0x12, 0xff], 'the clear colour is in guest memory before the program reads');
    h.write(/** @type {number} */ (locked.pBits), Uint8Array.from([0x65, 0x43, 0x21, 0xff]));
    assert.equal(backBuffer.UnlockRect(), D3D_OK);
    await h.present();

    const kinds = h.device.diagnostics().lastFrame.map((/** @type {any} */ command)=>command.kind);
    assert.deepEqual(kinds, ['upload'], 'the written bytes travel as a frame command');
    assert.equal(h.gpu.count('copyBufferToTexture'), 1, 'through the staged path, in order');
    const presented = rasterise(h).of(h.presented[0].surface);
    assert.deepEqual(pixelAt(presented, 0, 0), [0x65, 0x43, 0x21, 0xff], 'the program\'s pixel');
    assert.deepEqual(pixelAt(presented, 1, 0), [0x56, 0x34, 0x12, 0xff],
        'beside what the read-back brought in');
    assert.equal(h.reports.length, 0);
});

test('a lock of a render target made without lockable is refused, as the real API refuses it',
    ()=>{
        const h = harness(9);
        /** @type {{ surface?: any }} */
        const target = {};
        assert.equal(h.device.CreateRenderTarget(4, 4, D3DFMT.A8R8G8B8, false, target), D3D_OK);
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(target.surface.LockRect(locked, null, 0), 0x8876086c);
        assert.equal(locked.pBits, undefined);
        assert.equal(h.backBuffer().LockRect(locked, null, 0), 0x8876086c,
            'and so is the back buffer without D3DPRESENTFLAG_LOCKABLE_BACKBUFFER');
    });
