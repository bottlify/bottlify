/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A read-back of a level whose texels the device holds alone - let go here
 * once uploaded, or written there by a draw - answers what the device holds:
 * the texels are read back from it, once what the context recorded before
 * the read has run, and the answer comes when they are here. Every getter of
 * a level's image goes through it: glGetTexImage (its RGBA and packed
 * paths), glGetTextureImage, glGetTextureSubImage, glGetnTexImage, and the
 * exports that write the answer into the program's memory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { TEX } from './formats.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { createOpengl } from './exports.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/** A 4x4 level whose texels are all different. */
const LEVEL = Uint8Array.from({ length: 64 }, (_, at)=>(at * 7 + 3) & 0xff);

function rig(){
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} });
    /** @type {string[]} */
    const divergences = [];
    const renderer = createGpuRenderer({
        backend,
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
        divergence: detail=>divergences.push(detail),
    });
    /** @type {any} */
    const context = createGlContext({ gpu: renderer, divergence: d=>divergences.push(d) });
    context.attach({ width: 16, height: 16, doubleBuffered: true });
    context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, 1);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        LEVEL.slice());
    const level = context.shareGroup.textures.objects.get(1).levels.get(0);
    /** Draws with the texture and swaps: the level is on the device and let go here. */
    const drawn = async()=>{
        context.glEnable(GL.TEXTURE_2D);
        context.glBegin(GL.TRIANGLES);
        context.glVertex2f(0, 0);
        context.glVertex2f(1, 0);
        context.glVertex2f(1, 1);
        context.glEnd();
        renderer.present(context);
        await renderer.settled();
        assert.equal(level.texels, null, 'the rig lets the level go');
    };
    const losses = ()=>divergences.filter(d=>/device holds|read back/.test(d));
    return { gpu, renderer, context, drawn, losses, divergences };
}

test('glGetTexImage of a let-go level answers the device\'s texels', async()=>{
    const r = rig();
    await r.drawn();
    const reading = r.context.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.ok(reading instanceof Promise, 'the answer waits for the device');
    assert.deepEqual([...await reading], [...LEVEL]);
    assert.deepEqual(r.losses(), []);
    assert.equal(r.context.shareGroup.textures.objects.get(1).levels.get(0).texels, null,
        'nothing is kept here after the read');
});

test('glGetTexImage into a type packed here reads the device\'s texels too', async()=>{
    const r = rig();
    const before = r.context.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.HALF_FLOAT);
    assert.ok(before?.packed instanceof Uint8Array, 'half floats are packed by the context');
    await r.drawn();
    const after = await r.context.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.HALF_FLOAT);
    assert.deepEqual([...after.packed], [...before.packed], 'as packed before the level went');
    assert.deepEqual(r.losses(), []);
});

test('a level the device drew into reads back what the device holds', async()=>{
    const r = rig();
    await r.drawn();
    // The device's copy changed where this side never saw it.
    const texture = r.gpu.calls.find((/** @type {any} */ c)=>c.op === 'createTexture'
        && /gl-texture:1/.test(c.descriptor.label)).texture;
    texture.bytes.fill(0x5a);
    assert.deepEqual([...await r.context.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA,
        GL.UNSIGNED_BYTE)], new Array(64).fill(0x5a));
});

test('glGetTextureSubImage, glGetTextureImage and glGetnTexImage read the device', async()=>{
    const r = rig();
    await r.drawn();
    const box = await r.context.glGetTextureSubImage(1, 0, { x: 1, y: 2, z: 0, width: 2,
        height: 1, depth: 1 }, GL.RGBA, GL.UNSIGNED_BYTE, 64);
    assert.deepEqual([...box], [...LEVEL.subarray((2 * 4 + 1) * 4, (2 * 4 + 3) * 4)]);
    assert.deepEqual([...await r.context.glGetTextureImage(1, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        64)], [...LEVEL]);
    assert.deepEqual([...await r.context.getnTexImage(false, GL.TEXTURE_2D, 0, GL.RGBA,
        GL.UNSIGNED_BYTE, 64)], [...LEVEL]);
    assert.deepEqual(r.losses(), []);
});

test('a sized level the device drew into is read from this side, a loss said', async()=>{
    const r = rig();
    r.context.glGenTextures(1);
    r.context.glBindTexture(GL.TEXTURE_2D, 2);
    r.context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RGBA16F, 4, 4, 0, GL.RGBA, GL.FLOAT, null);
    const sized = r.context.shareGroup.textures.objects.get(2).levels.get(0);
    assert.ok(sized.sized, 'kept as its format');
    assert.ok(!(r.context.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.FLOAT) instanceof Promise));
    assert.deepEqual(r.losses(), [], 'nothing the device wrote yet');
    r.context.glGenFramebuffers(1);
    r.context.bindFramebuffer(GL.FRAMEBUFFER, 1, false);
    r.context.framebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, 2, 0);
    r.context.glClear(GL.COLOR_BUFFER_BIT);
    r.renderer.present(r.context);
    await r.renderer.settled();
    r.context.bindFramebuffer(GL.FRAMEBUFFER, 0, false);
    assert.ok(!(r.context.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.FLOAT) instanceof Promise),
        'answered here');
    assert.equal(r.losses().length, 1, 'and said: the device hands back RGBA levels alone');
});

test('glGetCompressedTexImage answers an S3TC level\'s blocks while they are held', async()=>{
    const r = rig();
    const blocks = Uint8Array.from([0x00, 0xf8, 0x1f, 0x00, 0xe4, 0xe4, 0xe4, 0xe4]);
    r.context.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0, GL.COMPRESSED_RGB_S3TC_DXT1_EXT, 4, 4,
        0, 8, blocks);
    assert.equal(r.context.glGetError(), GL.NO_ERROR);
    assert.deepEqual([...r.context.glGetCompressedTexImageARB(GL.TEXTURE_2D, 0)], [...blocks],
        'as they were given');
    assert.equal(r.context.glGetError(), GL.NO_ERROR);
    const decoded = r.context.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    // Drawn on a device that decodes them, the blocks go: the decoding is
    // read back from it, the blocks are not there to hand back.
    r.context.glEnable(GL.TEXTURE_2D);
    r.context.glBegin(GL.TRIANGLES);
    r.context.glVertex2f(0, 0);
    r.context.glVertex2f(1, 0);
    r.context.glVertex2f(1, 1);
    r.context.glEnd();
    r.renderer.present(r.context);
    await r.renderer.settled();
    assert.deepEqual([...await r.context.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA,
        GL.UNSIGNED_BYTE)], [...decoded], 'the device\'s decoding');
    assert.equal(r.context.glGetCompressedTexImageARB(GL.TEXTURE_2D, 0), null);
    assert.equal(r.context.glGetError(), GL.INVALID_OPERATION);
    assert.equal(r.divergences.filter(d=>/glGetCompressedTexImage .*let go/.test(d)).length, 1,
        'refused, a loss said');
});

test('a read before the level is drawn answers at once from this side', ()=>{
    const r = rig();
    const answer = r.context.glGetTexImage(GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE);
    assert.ok(answer instanceof Uint8Array, 'nothing to wait for');
    assert.deepEqual([...answer], [...LEVEL]);
});

test('the exports write the device\'s answer into the program\'s memory once it is here',
    async()=>{
        const gpu = createFakeDevice();
        const backend = createBackend({ device: gpu.device, queue: gpu.queue,
            presentTo: ()=>{} });
        const bytes = new Uint8Array(0x10000);
        let next = 0x100;
        const opengl = createOpengl({
            readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
                bytes.subarray(at, at + length),
            writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>
                bytes.set(value, at),
            screen: ()=>({ width: 16, height: 16 }),
            scratch: { allocate: (/** @type {number} */ size)=>{
                const at = next;
                next += size + 16 & ~15;
                return at;
            } },
            backend: ()=>backend,
            createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }),
        });
        const table = /** @type {Record<string, { handler: (args: number[]) => any }>} */ (
            opengl.table);
        const hdc = 0x900d;
        table.wglSetPixelFormat.handler([hdc, 1, 0]);
        table.wglMakeCurrent.handler([hdc, table.wglCreateContext.handler([hdc])]);
        bytes.set(LEVEL, 0x3000);
        table.glGenTextures.handler([1, 0x2000]);
        table.glBindTexture.handler([GL.TEXTURE_2D, bytes[0x2000]]);
        table.glTexParameteri.handler([GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR]);
        table.glTexImage2D.handler([GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA,
            GL.UNSIGNED_BYTE, 0x3000]);
        table.glEnable.handler([GL.TEXTURE_2D]);
        table.glBegin.handler([GL.TRIANGLES]);
        for (let i = 0; i < 3; i++)
        {
            table.glVertex2i.handler([i & 1, i >> 1]);
        }
        table.glEnd.handler([]);
        await table.wglSwapBuffers.handler([hdc]);
        const name = bytes[0x2000];
        for (const [call, args, out] of /** @type {[string, number[], number][]} */ ([
            ['glGetTexImage', [GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE, 0x4000], 0x4000],
            ['glGetTextureImage', [name, 0, GL.RGBA, GL.UNSIGNED_BYTE, 64, 0x4100], 0x4100],
            ['glGetnTexImage', [GL.TEXTURE_2D, 0, GL.RGBA, GL.UNSIGNED_BYTE, 64, 0x4200],
                0x4200],
            ['glGetTextureSubImage', [name, 0, 0, 0, 0, 4, 4, 1, GL.RGBA, GL.UNSIGNED_BYTE, 64,
                0x4300], 0x4300],
        ]))
        {
            const answered = table[call].handler(args);
            assert.ok(answered instanceof Promise, `${call} waits for the device`);
            assert.equal(await answered, 0);
            assert.deepEqual([...bytes.subarray(out, out + 64)], [...LEVEL],
                `${call} wrote the device's texels`);
        }
        assert.equal(opengl.entry('glGetTexImage'), null,
            'a call that may wait is no entry for a caller that cannot');
    });
