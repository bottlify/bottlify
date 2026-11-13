/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Texturing rules on the device path: a fake WebGPU device records every
 * call, the draw dump says which texture each binding read - what an
 * incomplete texture samples, texture object 0, and the LOD range and base
 * level a sampler and a view are made with.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/** @param {object} [services] */
function rig(services = {}){
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} });
    /** @type {any[]} */
    const samplers = [];
    /** @type {string[]} */
    const divergences = [];
    const renderer = createGpuRenderer({
        backend,
        createSampler: (/** @type {any} */ descriptor)=>{
            samplers.push(descriptor);
            return { kind: 'sampler', descriptor };
        },
        divergence: (/** @type {string} */ detail)=>divergences.push(detail),
        ...services,
    });
    const bytes = new Uint8Array(0x10000);
    const memory = {
        read: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>bytes.set(value, at),
    };
    /** @type {any} */
    const context = createGlContext({ memory, gpu: renderer,
        divergence: (/** @type {string} */ d)=>divergences.push(d) });
    context.attach({ width: 64, height: 32, doubleBuffered: true, depthBits: 24 });
    context.glMatrixMode(GL.PROJECTION);
    context.glLoadIdentity();
    context.glOrtho(0, 64, 0, 32, -1, 1);
    context.glMatrixMode(GL.MODELVIEW);
    context.glLoadIdentity();
    const swap = async()=>{
        renderer.present(context);
        await renderer.settled();
    };
    return { gpu, renderer, context, bytes, samplers, divergences, swap };
}

/** A textured triangle drawn immediate-mode on the fixed path. @param {any} context */
function texturedTriangle(context){
    context.glBegin(GL.TRIANGLES);
    context.glTexCoord2f(0, 0);
    context.glVertex2f(0, 0);
    context.glTexCoord2f(1, 0);
    context.glVertex2f(16, 0);
    context.glTexCoord2f(1, 1);
    context.glVertex2f(16, 16);
    context.glEnd();
}

const FRAGMENT_PROGRAM = '!!ARBfp1.0\nTEX result.color, fragment.texcoord[0], texture[0], 2D;'
    + '\nEND\n';

test('ARB_fragment_program issue 23: a sample of an incomplete texture is (0,0,0,1)', async()=>{
    const r = rig({ dumpDraws: true });
    const { context } = r;
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    // The default min filter wants mipmaps; only level 0 is given: incomplete.
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(64).fill(0x80));
    assert.equal(context.isTextureComplete(GL.TEXTURE_2D), false);
    r.bytes.set(new TextEncoder().encode(FRAGMENT_PROGRAM), 0x4000);
    context.glGenProgramsARB(1);
    context.glBindProgramARB(GL.FRAGMENT_PROGRAM_ARB, 1);
    context.glProgramStringARB(GL.FRAGMENT_PROGRAM_ARB, GL.PROGRAM_FORMAT_ASCII_ARB,
        FRAGMENT_PROGRAM.length, 0x4000);
    context.glEnable(GL.FRAGMENT_PROGRAM_ARB);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    texturedTriangle(context);
    await r.swap();
    const line = r.renderer.diagnostics().lastDump.find((/** @type {string} */ text)=>
        text.startsWith('draw 0:'));
    assert.ok(line, 'the draw has a line');
    // `tex=[binding:tName:...]`: the placeholder is t0, the program's texture t1.
    assert.doesNotMatch(line, new RegExp(`tex=\\[\\d+:t${name}:`),
        `the incomplete texture t${name} must not be sampled`);
});

test('2.1 3.8.12: texture object 0 is a texture a fragment program samples', ()=>{
    const r = rig();
    const { context } = r;
    // Images loaded into the default texture, no name ever generated.
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(4).fill(0x80));
    assert.ok(context.side.textureBoundAt(0, GL.TEXTURE_2D),
        'unit 0 has the default texture, with an image, bound to TEXTURE_2D');
});

test('3.8.8: TEXTURE_MIN_LOD and TEXTURE_MAX_LOD reach the sampler', async()=>{
    const r = rig();
    const { context } = r;
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    context.glTexParameteri(GL.TEXTURE_2D, GL.GENERATE_MIPMAP, GL.TRUE);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 8, 8, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(256));
    context.glTexParameterf(GL.TEXTURE_2D, GL.TEXTURE_MIN_LOD, 1);
    context.glTexParameterf(GL.TEXTURE_2D, GL.TEXTURE_MAX_LOD, 2);
    context.glEnable(GL.TEXTURE_2D);
    texturedTriangle(context);
    await r.swap();
    const last = r.samplers.filter(s=>/gl-sampler/.test(s.label)).at(-1);
    assert.ok(last, 'a sampler was made');
    assert.equal(last.lodMinClamp, 1, JSON.stringify(last));
    assert.equal(last.lodMaxClamp, 2, JSON.stringify(last));
});

test('3.8.8: a mipmapped texture samples no level past GL_TEXTURE_MAX_LEVEL', async()=>{
    const r = rig();
    const { context } = r;
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    context.glTexParameteri(GL.TEXTURE_2D, GL.GENERATE_MIPMAP, GL.TRUE);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 8, 8, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(256));
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 1);
    context.glEnable(GL.TEXTURE_2D);
    texturedTriangle(context);
    await r.swap();
    const last = r.samplers.filter(s=>/gl-sampler/.test(s.label)).at(-1);
    const surface = r.gpu.of('createTexture').find((/** @type {any} */ t)=>
        new RegExp(`gl-texture:${name}$`).test(t.descriptor.label));
    const levels = Math.min(surface.descriptor.mipLevelCount, Math.floor(last.lodMaxClamp) + 1);
    assert.equal(levels, 2, `levels 0 and 1 only: surface ${surface.descriptor.mipLevelCount},`
        + ` lodMaxClamp ${last.lodMaxClamp}`);
});

test('3.8.8: magnification reads level_base, not level 0', async()=>{
    const r = rig();
    const { context } = r;
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(64));
    context.glTexImage2D(GL.TEXTURE_2D, 1, GL.RGBA, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(16).fill(255));
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_BASE_LEVEL, 1);
    context.glEnable(GL.TEXTURE_2D);
    texturedTriangle(context);
    await r.swap();
    // The view a draw binds starts at level 1, or the surface holds level 1 as its first.
    const views = r.gpu.of('createView').map((/** @type {any} */ v)=>
        v.view.viewDescriptor ?? {});
    const surface = r.gpu.of('createTexture').find((/** @type {any} */ t)=>
        new RegExp(`gl-texture:${name}$`).test(t.descriptor.label));
    assert.ok(surface.descriptor.size.width === 2 || views.some(v=>v.baseMipLevel === 1),
        `surface ${surface.descriptor.size.width} wide, views ${JSON.stringify(views)}`);
});

test('3.8.10: a texture loaded from GL_TEXTURE_BASE_LEVEL down only is drawn, and a level 0'
    + ' of another shape is left out of its copy', async()=>{
    const r = rig();
    const { context } = r;
    const [name] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, name);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR_MIPMAP_LINEAR);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_BASE_LEVEL, 1);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 16, 16, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(1024));
    context.glTexImage2D(GL.TEXTURE_2D, 1, GL.RGBA, 2, 2, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(16).fill(255));
    context.glTexImage2D(GL.TEXTURE_2D, 2, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(4).fill(255));
    assert.equal(context.isTextureComplete(GL.TEXTURE_2D), true);
    context.glEnable(GL.TEXTURE_2D);
    texturedTriangle(context);
    await r.swap();
    const surface = r.gpu.of('createTexture').find((/** @type {any} */ t)=>
        new RegExp(`gl-texture:${name}$`).test(t.descriptor.label));
    assert.equal(surface.descriptor.size.width, 4, 'a level 0 the base level is a mipmap of');
    assert.equal(surface.descriptor.mipLevelCount, 3);
    const writes = r.gpu.of('writeTexture').filter((/** @type {any} */ w)=>
        w.destination.texture === surface.texture);
    assert.deepEqual(writes.map((/** @type {any} */ w)=>w.destination.mipLevel).sort(), [1, 2],
        'the 16x16 level 0 does not fit the copy and is not uploaded');
    const views = r.gpu.of('createView').map((/** @type {any} */ v)=>v.view.viewDescriptor ?? {});
    assert.ok(views.some(v=>v.baseMipLevel === 1 && v.mipLevelCount === 2));
    const last = r.samplers.filter(s=>/gl-sampler/.test(s.label)).at(-1);
    assert.equal(last.lodMinClamp, undefined, 'GL_TEXTURE_MIN_LOD -1000 is no clamp');
    assert.equal(last.lodMaxClamp, 32);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAX_LEVEL, 2);
    texturedTriangle(context);
    await r.swap();
    assert.equal(r.samplers.filter(s=>/gl-sampler/.test(s.label)).at(-1).lodMaxClamp, 1,
        'MAX_LEVEL counted from the base level');
});
