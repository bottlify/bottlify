/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The formats of sixteen and thirty-two bits a channel, through a whole device
 * over the recording GPU: what a texture of one puts on the queue, what a
 * target of one is made, cleared and drawn into as, and what a read-back of
 * one leaves in guest memory.
 *
 * The recording GPU keeps a half-float texture's bytes as clears and copies
 * move them, and paints nothing for a draw; so a read-back here reads the
 * clear, and what a draw is asked to do is read off the pipeline it is given.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D3DFMT, D3DPOOL, D3DRS, D3DSWAPEFFECT, D3DUSAGE, D3D_OK } from './constants.js';
import { D3DBLEND, D3DCLEAR, D3DPT, D3DTA, D3DTOP, D3DTSS } from '../d3d8/constants.js';
import { createDirect3D9 } from './device.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { FVF } from '../webgpu/internal/vertexformat.js';
import { fromHalf, toHalf } from './half.js';

const RAM_BASE = 0x40000000;
const RAM_SIZE = 4 << 20;

/** @type {{ format: number, gpu: string, channels: 1 | 2 | 4,
 *     stored: 'half' | 'float' | 'unorm16', name: string }[]} */
const WIDE = [
    { format: D3DFMT.A16B16G16R16F, gpu: 'rgba16float', channels: 4, stored: 'half',
        name: 'A16B16G16R16F' },
    { format: D3DFMT.G16R16F, gpu: 'rg16float', channels: 2, stored: 'half', name: 'G16R16F' },
    { format: D3DFMT.A32B32G32R32F, gpu: 'rgba16float', channels: 4, stored: 'float',
        name: 'A32B32G32R32F' },
    { format: D3DFMT.G32R32F, gpu: 'rg16float', channels: 2, stored: 'float', name: 'G32R32F' },
    { format: D3DFMT.A16B16G16R16, gpu: 'rgba16float', channels: 4, stored: 'unorm16',
        name: 'A16B16G16R16' },
    { format: D3DFMT.G16R16, gpu: 'rg16float', channels: 2, stored: 'unorm16', name: 'G16R16' },
    { format: D3DFMT.R16F, gpu: 'r16float', channels: 1, stored: 'half', name: 'R16F' },
    { format: D3DFMT.R32F, gpu: 'r16float', channels: 1, stored: 'float', name: 'R32F' },
];

/**
 * What the fixed-function stage's sample fills of a texture of so many
 * channels: green and blue for one, blue for two, as Direct3D reads them.
 *
 * @type {Record<number, string>}
 */
const FILLED = {
    1: 'vec4f(textureSampleLevel(texture0, sampler0, uv, level).x, 1.0, 1.0, 1.0)',
    2: 'vec4f(textureSampleLevel(texture0, sampler0, uv, level).xy, 1.0, 1.0)',
};

/** @param {'half' | 'float' | 'unorm16'} stored */
const channelBytes = stored=>(stored === 'float' ? 4 : 2);

/**
 * Channel values as a format stores them, red first.
 *
 * @param {'half' | 'float' | 'unorm16'} stored @param {number[]} values
 * @returns {Uint8Array}
 */
function storedBytes(stored, values){
    const view = new DataView(new ArrayBuffer(values.length * channelBytes(stored)));
    values.forEach((value, index)=>{
        if (stored === 'float')
        {
            view.setFloat32(index * 4, value, true);
        }
        else
        {
            view.setUint16(index * 2,
                stored === 'half' ? toHalf(value) : Math.round(value * 0xffff), true);
        }
    });
    return new Uint8Array(view.buffer);
}

function harness(){
    const gpu = createFakeDevice();
    const backend = createBackend({
        device: gpu.device, queue: gpu.queue, presentTo: ()=>{}, now: ()=>0,
    });
    const ram = new Uint8Array(RAM_SIZE);
    let next = RAM_BASE;
    /** @type {string[]} */
    const reports = [];
    const d3d = createDirect3D9({
        backend,
        readMemory: (address, length)=>ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        writeMemory: (address, bytes)=>ram.set(bytes, address - RAM_BASE),
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
        swapEffect: D3DSWAPEFFECT.DISCARD, backBufferCount: 1, backBufferWidth: 4,
        backBufferHeight: 4, backBufferFormat: D3DFMT.X8R8G8B8,
    }, out), D3D_OK);
    const device = out.device;
    return {
        gpu,
        device,
        reports,
        /** @param {number} address @param {Uint8Array} bytes */
        write: (address, bytes)=>ram.set(bytes, address - RAM_BASE),
        /** @param {number} address @param {number} length */
        read: (address, length)=>ram.slice(address - RAM_BASE, address - RAM_BASE + length),
        /** A triangle of the one stage's texture, the frame presented. */
        async drawTextured(){
            assert.equal(device.SetTextureStageState(0, D3DTSS.COLOROP, D3DTOP.SELECTARG1),
                D3D_OK);
            assert.equal(device.SetTextureStageState(0, D3DTSS.COLORARG1, D3DTA.TEXTURE), D3D_OK);
            assert.equal(device.SetFVF(FVF.XYZRHW | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT)),
                D3D_OK);
            assert.equal(device.BeginScene(), D3D_OK);
            assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(84), 28),
                D3D_OK);
            assert.equal(device.EndScene(), D3D_OK);
            assert.equal(device.Present(), D3D_OK);
            await device.idle();
        },
    };
}

for (const { format, gpu, channels, stored, name } of WIDE)
{
    test(`${name}: a texture goes up to an ${gpu} as half floats, red first`, async()=>{
        const h = harness();
        const { device } = h;
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateTexture(2, 2, 1, 0, format, D3DPOOL.MANAGED, out), D3D_OK);
        // Every channel of every texel its own value, so a channel moved or a
        // texel misplaced arrives as another one.
        const values = Array.from({ length: 4 * channels }, (_, index)=>(index + 1) / 32);
        /** @type {{ pBits?: number }} */
        const locked = {};
        assert.equal(out.texture.LockRect(0, locked, null, 0), D3D_OK);
        h.write(/** @type {number} */ (locked.pBits), storedBytes(stored, values));
        assert.equal(out.texture.UnlockRect(0), D3D_OK);
        assert.equal(device.SetTexture(0, out.texture), D3D_OK);
        await h.drawTextured();

        const made = h.gpu.of('createTexture').find((/** @type {any} */ call)=>
            call.descriptor.label === 'texture');
        assert.equal(made.descriptor.format, gpu);
        const upload = h.gpu.of('writeTexture').find((/** @type {any} */ call)=>
            call.destination.texture === made.texture);
        assert.equal(upload.layout.bytesPerRow, 2 * channels * 2);
        assert.deepEqual([...new Uint16Array(upload.bytes.buffer)], values.map(toHalf),
            'n/32 is a half exactly, whatever the format held it as');
        const draw = h.device.diagnostics().lastFrame.find(
            (/** @type {any} */ command)=>command.kind === 'draw');
        assert.equal(draw.stageBindings[0].view.texture, made.texture, 'and the draw samples it');

        const narrowed = h.reports.filter(report=>report.includes(` of ${name} `));
        assert.equal(narrowed.some(report=>report.includes('half precision')), stored === 'float');
        assert.equal(narrowed.some(report=>report.includes('eleven significant bits')),
            stored === 'unorm16');
        assert.ok(!h.reports.some(report=>report.includes('lacks')),
            'a channel the format lacks is no longer a divergence');
        // Direct3D samples the channels the format lacks as one; the GPU's
        // texture has them as zero, so the stage's sample fills them.
        const stage = h.gpu.of('createShaderModule').map((/** @type {any} */ call)=>
            call.descriptor.code).find((/** @type {string} */ code)=>code.includes('fn sampleStage0'));
        if (channels === 4)
        {
            assert.ok(stage.includes(
                'return textureSampleLevel(texture0, sampler0, uv, level);'), 'nothing filled');
        }
        else
        {
            assert.ok(stage.includes(`return ${FILLED[channels]};`), stage);
        }
        assert.equal(device.SetTexture(0, null), D3D_OK);
        out.texture.release();
    });

    test(`${name}: a target is cleared, blended into and read back as its own format`, async()=>{
        const h = harness();
        const { device } = h;
        /** @type {{ surface?: any }} */
        const back = {};
        assert.equal(device.GetRenderTarget(0, back), D3D_OK);
        /** @type {{ texture?: any }} */
        const out = {};
        assert.equal(device.CreateTexture(4, 4, 1, D3DUSAGE.RENDERTARGET, format,
            D3DPOOL.DEFAULT, out), D3D_OK);
        /** @type {{ surface?: any }} */
        const level = {};
        assert.equal(out.texture.GetSurfaceLevel(0, level), D3D_OK);
        assert.equal(device.SetRenderTarget(0, level.surface), D3D_OK);
        // Red 255, green 128, blue 0, alpha 128: a format with alpha keeps it.
        const colour = 0x80ff8000;
        assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, colour, 1, 0), D3D_OK);
        assert.equal(device.SetRenderState(D3DRS.ALPHABLENDENABLE, 1), D3D_OK);
        assert.equal(device.SetRenderState(D3DRS.SRCBLEND, D3DBLEND.SRCALPHA), D3D_OK);
        assert.equal(device.SetRenderState(D3DRS.DESTBLEND, D3DBLEND.INVSRCALPHA), D3D_OK);
        assert.equal(device.SetFVF(FVF.XYZRHW | FVF.DIFFUSE), D3D_OK);
        assert.equal(device.BeginScene(), D3D_OK);
        assert.equal(device.DrawPrimitiveUP(D3DPT.TRIANGLELIST, 1, new Uint8Array(60), 20),
            D3D_OK);
        assert.equal(device.EndScene(), D3D_OK);
        /** @type {{ surface?: any }} */
        const twin = {};
        assert.equal(device.CreateOffscreenPlainSurface(4, 4, format, D3DPOOL.SYSTEMMEM, twin),
            D3D_OK);
        assert.equal(await device.GetRenderTargetData(level.surface, twin.surface), D3D_OK);

        const pass = h.gpu.of('beginRenderPass').find((/** @type {any} */ call)=>
            call.descriptor.colorAttachments[0].view.texture.format === gpu);
        assert.ok(pass, `the target is an ${gpu}`);
        assert.equal(pass.descriptor.colorAttachments[0].clearValue.a,
            channels === 4 ? 128 / 255 : 1);
        const pipeline = h.gpu.of('createRenderPipeline').find((/** @type {any} */ call)=>
            call.descriptor.fragment?.targets?.[0]?.format === gpu);
        assert.ok(pipeline, 'the draw has a pipeline for the target');
        assert.deepEqual(pipeline.descriptor.fragment.targets[0].blend.color,
            { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' });

        // What the clear left, through a half and into the format's own channels.
        const kept = [1, 128 / 255, 0, 128 / 255].slice(0, channels)
            .map(value=>fromHalf(toHalf(value)));
        const pixel = stored === 'half' ? storedBytes('half', kept)
            : stored === 'float' ? storedBytes('float', kept) : storedBytes('unorm16', kept);
        const read = h.read(twin.surface.base, 16 * pixel.length);
        for (let at = 0; at < 16; at++)
        {
            assert.deepEqual([...read.subarray(at * pixel.length, (at + 1) * pixel.length)],
                [...pixel], `pixel ${at}`);
        }
        twin.surface.release();
        assert.equal(device.SetRenderTarget(0, back.surface), D3D_OK);
        back.surface.release();
        level.surface.release();
        out.texture.release();
    });
}

test('a lockable HDR target locks as its own format, and a stretch takes it to the screen',
    async()=>{
        const h = harness();
        const { device } = h;
        /** @type {{ surface?: any }} */
        const back = {};
        assert.equal(device.GetBackBuffer(0, 0, 0, back), D3D_OK);
        /** @type {{ surface?: any }} */
        const hdr = {};
        assert.equal(device.CreateRenderTarget(4, 4, D3DFMT.A32B32G32R32F, true, hdr), D3D_OK);
        /** @type {{ surface?: any }} */
        const half = {};
        assert.equal(device.CreateRenderTarget(4, 4, D3DFMT.A16B16G16R16F, false, half), D3D_OK);
        assert.equal(device.SetRenderTarget(0, hdr.surface), D3D_OK);
        assert.equal(device.Clear(0, null, D3DCLEAR.TARGET, 0x00ff0000, 1, 0), D3D_OK);
        /** @type {{ pBits?: number, Pitch?: number }} */
        const locked = {};
        assert.equal(await hdr.surface.LockRect(locked, null, 0), D3D_OK);
        assert.equal(locked.Pitch, 64);
        assert.deepEqual([...new Float32Array(h.read(/** @type {number} */ (locked.pBits), 16)
            .buffer)], [1, 0, 0, 0], 'red, and the alpha the clear gave');
        assert.equal(hdr.surface.UnlockRect(), D3D_OK);

        // Between two formats kept alike on the GPU a copy; to the back buffer a
        // draw, the tone-mapped scene's way to the screen.
        assert.equal(device.StretchRect(hdr.surface, null, half.surface, null, 0), D3D_OK);
        assert.equal(device.StretchRect(half.surface, null, back.surface, null, 2), D3D_OK);
        assert.equal(device.SetRenderTarget(0, back.surface), D3D_OK);
        assert.equal(device.Present(), D3D_OK);
        await device.idle();
        const copy = h.gpu.of('copyTextureToTexture').find((/** @type {any} */ call)=>
            call.source.texture.format === 'rgba16float'
                && call.destination.texture.format === 'rgba16float');
        assert.ok(copy, 'A32B32G32R32F into A16B16G16R16F is a copy');
        const stretch = h.gpu.of('createRenderPipeline').find((/** @type {any} */ call)=>
            call.descriptor.label === 'stretch:bgra8unorm');
        assert.ok(stretch, 'A16B16G16R16F onto the back buffer is drawn');
        back.surface.release();
        hdr.surface.release();
        half.surface.release();
    });
