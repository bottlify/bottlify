/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Sized texture levels on the device: the WebGPU format each lives in, the
 * bytes uploaded into it, how a draw binds it (a texture no sampler filters
 * gets a layout and a sampler of its own), a depth level drawn in by the
 * backend's depth write, and framebuffers drawing into float and depth
 * textures. A recording device stands in for the GPU and refuses what WebGPU
 * refuses.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { TEX } from './formats.js';
import { createGpuRenderer } from './gpu.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/** @param {string[]} [features] */
function rig(features = []){
    const gpu = createFakeDevice({ features });
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} });
    /** @type {string[]} */
    const said = [];
    const renderer = createGpuRenderer({
        backend,
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
        divergence: detail=>said.push(detail),
    });
    const bytes = new Uint8Array(0x10000);
    /** @type {any} */
    const context = createGlContext({
        memory: {
            read: (/** @type {number} */ at, /** @type {number} */ length)=>
                bytes.subarray(at, at + length),
            write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>bytes.set(value, at),
        },
        gpu: renderer, divergence: detail=>said.push(detail),
    });
    context.attach({ width: 16, height: 16, doubleBuffered: true, depthBits: 24 });
    context.glPixelStorei(GL.UNPACK_ALIGNMENT, 1);
    context.glMatrixMode(GL.PROJECTION);
    context.glLoadIdentity();
    context.glOrtho(0, 16, 0, 16, -1, 1);
    context.glMatrixMode(GL.MODELVIEW);
    context.glLoadIdentity();
    const draw = ()=>{
        context.glBegin(GL.TRIANGLES);
        context.glTexCoord2f(0, 0);
        context.glVertex2f(0, 0);
        context.glTexCoord2f(1, 0);
        context.glVertex2f(16, 0);
        context.glTexCoord2f(1, 1);
        context.glVertex2f(16, 16);
        context.glEnd();
    };
    const swap = async()=>{
        renderer.present(context);
        await renderer.settled();
    };
    return { gpu, context, said, draw, swap, renderer };
}

/** @param {ReturnType<typeof rig>} r @param {number} name */
const surfaceOf = (r, name)=>r.gpu.of('createTexture')
    .find((/** @type {any} */ t)=>t.descriptor.label === `gl-texture:${name}`);

/** @param {ArrayBufferView} view */
const bytesOf = view=>new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

/**
 * A 2D texture of one level bound and enabled on unit 0.
 *
 * @param {ReturnType<typeof rig>} r @param {number} internal
 * @param {number} width @param {number} height
 * @param {number} format @param {number} type @param {Uint8Array | null} data
 */
function texture2D(r, internal, width, height, format, type, data){
    const [name] = r.context.glGenTextures(1);
    r.context.glBindTexture(GL.TEXTURE_2D, name);
    r.context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
    r.context.glTexImage2D(GL.TEXTURE_2D, 0, internal, width, height, 0, format, type, data);
    assert.equal(r.context.glGetError(), GL.NO_ERROR);
    r.context.glEnable(GL.TEXTURE_2D);
    return name;
}

test('a half float texture lives as rgba16float and uploads its own bytes', async()=>{
    const r = rig();
    const halves = Uint16Array.from([0x3c00, 0x3800, 0, 0x3c00, 0, 0, 0, 0]);
    const name = texture2D(r, TEX.RGBA16F, 2, 1, GL.RGBA, TEX.HALF_FLOAT, bytesOf(halves));
    r.draw();
    await r.swap();
    const surface = surfaceOf(r, name);
    assert.equal(surface.descriptor.format, 'rgba16float');
    const upload = r.gpu.of('writeTexture').find((/** @type {any} */ w)=>
        w.destination.texture === surface.texture);
    assert.ok(upload, 'the level went up');
    assert.deepEqual(Array.from(new Uint16Array(upload.bytes.buffer)),
        Array.from(halves));
    assert.equal(r.renderer.diagnostics().failures?.length ?? 0, 0);
});

test('an RGB float texture lives as RGBA with an alpha of one', async()=>{
    const r = rig();
    const name = texture2D(r, TEX.RGB32F, 1, 1, GL.RGB, GL.FLOAT,
        bytesOf(Float32Array.from([0.5, 2, -1])));
    r.draw();
    await r.swap();
    const surface = surfaceOf(r, name);
    assert.equal(surface.descriptor.format, 'rgba32float');
    const upload = r.gpu.of('writeTexture').find((/** @type {any} */ w)=>
        w.destination.texture === surface.texture);
    assert.deepEqual(Array.from(new Float32Array(upload.bytes.buffer)),
        [0.5, 2, -1, 1]);
});

test('a 32-bit float texture without float32-filterable binds unfiltered, read nearest',
    async()=>{
        const r = rig();
        const name = texture2D(r, TEX.R32F, 1, 1, GL.RED, GL.FLOAT,
            bytesOf(Float32Array.from([0.25])));
        r.context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.LINEAR);
        r.draw();
        await r.swap();
        assert.equal(surfaceOf(r, name).descriptor.format, 'r32float');
        const entries = r.gpu.of('createBindGroupLayout').flatMap((/** @type {any} */ l)=>
            l.descriptor.entries);
        assert.ok(entries.some((/** @type {any} */ e)=>
            e.texture?.sampleType === 'unfilterable-float'), 'an unfilterable binding');
        assert.ok(entries.some((/** @type {any} */ e)=>e.sampler?.type === 'non-filtering'));
        assert.ok(r.said.some(d=>/read nearest/.test(d)), 'the linear filter is said dropped');
        assert.equal(r.gpu.of('draw').length + r.gpu.of('drawIndexed').length > 0, true);
        assert.deepEqual(r.gpu.errors ?? [], []);
    });

test('with float32-filterable the same texture is filtered as asked', async()=>{
    const r = rig(['float32-filterable']);
    texture2D(r, TEX.R32F, 1, 1, GL.RED, GL.FLOAT, bytesOf(Float32Array.from([0.25])));
    r.context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.LINEAR);
    r.draw();
    await r.swap();
    const entries = r.gpu.of('createBindGroupLayout').flatMap((/** @type {any} */ l)=>
        l.descriptor.entries);
    assert.ok(!entries.some((/** @type {any} */ e)=>e.texture?.sampleType));
    assert.ok(!r.said.some(d=>/read nearest/.test(d)));
});

test('sixteen-bit normalised levels go up as half floats where the device has none', async()=>{
    const r = rig();
    const name = texture2D(r, TEX.R16, 2, 1, GL.RED, GL.UNSIGNED_SHORT,
        bytesOf(Uint16Array.from([65535, 0])));
    r.draw();
    await r.swap();
    const surface = surfaceOf(r, name);
    assert.equal(surface.descriptor.format, 'r16float');
    const upload = r.gpu.of('writeTexture').find((/** @type {any} */ w)=>
        w.destination.texture === surface.texture);
    assert.deepEqual(Array.from(new Uint16Array(upload.bytes.buffer)),
        [0x3c00, 0]);
    const tier = rig(['texture-formats-tier1']);
    const kept = texture2D(tier, TEX.R16, 2, 1, GL.RED, GL.UNSIGNED_SHORT,
        bytesOf(Uint16Array.from([65535, 0])));
    tier.draw();
    await tier.swap();
    assert.equal(surfaceOf(tier, kept).descriptor.format, 'r16unorm');
});

test('an integer texture sampled by the fixed pipeline reads the incomplete texture', async()=>{
    const r = rig();
    const name = texture2D(r, TEX.RGBA8UI, 1, 1, TEX.RGBA_INTEGER, GL.UNSIGNED_BYTE,
        Uint8Array.from([1, 2, 3, 4]));
    r.draw();
    await r.swap();
    assert.ok(r.said.some(d=>/integer texture/.test(d)));
    assert.equal(surfaceOf(r, name), undefined, 'nothing made for it');
});

test('a depth texture is drawn in by the depth write and binds through its depth', async()=>{
    const r = rig();
    const depths = Float32Array.from([0, 0.5, 1, 0.25]);
    // A float depth keeps what it is given; on a device without
    // depth32float-stencil8 it lives with 24 bits of depth.
    const name = texture2D(r, TEX.DEPTH_COMPONENT32F, 2, 2, GL.DEPTH_COMPONENT, GL.FLOAT,
        bytesOf(depths));
    r.draw();
    await r.swap();
    const surface = surfaceOf(r, name);
    assert.equal(surface.descriptor.format, 'depth24plus-stencil8');
    assert.equal(r.gpu.of('writeTexture').filter((/** @type {any} */ w)=>
        w.destination.texture === surface.texture).length, 0, 'no copy into a depth texture');
    const written = r.gpu.of('writeBuffer').find((/** @type {any} */ w)=>
        /depth-write/.test(w.buffer.descriptor.label));
    assert.ok(written, 'the depths went to the depth write');
    const words = new Uint32Array(written.bytes.slice().buffer);
    assert.deepEqual([words[0], words[1]], [2, 4], 'width and count');
    assert.deepEqual(Array.from(new Float32Array(words.buffer, 8, 4)),
        [0, 0.5, 1, 0.25]);
    const views = r.gpu.of('createView').filter((/** @type {any} */ v)=>
        v.texture === surface.texture && v.view.viewDescriptor?.aspect === 'depth-only');
    assert.equal(views.length, 1, 'sampled through its depth');
    const entries = r.gpu.of('createBindGroupLayout').flatMap((/** @type {any} */ l)=>
        l.descriptor.entries);
    assert.ok(entries.some((/** @type {any} */ e)=>
        e.texture?.sampleType === 'unfilterable-float'));
    assert.ok(r.gpu.of('createBindGroup').some((/** @type {any} */ g)=>g.descriptor.entries
        .some((/** @type {any} */ e)=>e.resource === views[0].view)), 'bound through it');
});

test('a float depth attachment is a depth32float-stencil8 pass where the device has it',
    async()=>{
        const r = rig(['depth32float-stencil8']);
        const { context } = r;
        const [colour, depth] = context.glGenTextures(2);
        context.glBindTexture(GL.TEXTURE_2D, colour);
        context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.R32F, 16, 16, 0, GL.RED, GL.FLOAT, null);
        context.glBindTexture(GL.TEXTURE_2D, depth);
        context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.DEPTH_COMPONENT32F, 16, 16, 0,
            GL.DEPTH_COMPONENT, GL.FLOAT, null);
        const [fbo] = context.glGenFramebuffers(1);
        context.bindFramebuffer(GL.FRAMEBUFFER, fbo, false);
        context.framebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, colour, 0);
        context.framebufferTexture(GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, GL.TEXTURE_2D, depth, 0);
        assert.equal(context.glCheckFramebufferStatus(GL.FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE);
        context.glEnable(GL.DEPTH_TEST);
        r.draw();
        await r.swap();
        assert.equal(surfaceOf(r, depth).descriptor.format, 'depth32float-stencil8');
        const pipelines = r.gpu.of('createRenderPipeline').map((/** @type {any} */ p)=>
            p.descriptor);
        assert.ok(pipelines.some((/** @type {any} */ d)=>d.fragment?.targets?.[0]?.format
            === 'r32float' && d.depthStencil?.format === 'depth32float-stencil8'));
        assert.deepEqual(r.gpu.errors ?? [], []);
    });

test('a 2D array lives as layers and uploads them in one copy', async()=>{
    const r = rig();
    const [name] = r.context.glGenTextures(1);
    r.context.glBindTexture(TEX.TEXTURE_2D_ARRAY, name);
    r.context.glTexImage3D(TEX.TEXTURE_2D_ARRAY, 0, TEX.RG8, 2, 2, 3, 0, TEX.RG,
        GL.UNSIGNED_BYTE, new Uint8Array(24).map((_, i)=>i));
    assert.equal(r.context.glGetError(), GL.NO_ERROR);
    // Nothing samples an array yet: a copy into one of its layers brings the
    // device's copy up, and draws into that layer.
    r.context.glClearColor(1, 0, 0, 1);
    r.context.glClear(GL.COLOR_BUFFER_BIT);
    r.context.glCopyTexSubImage3D(TEX.TEXTURE_2D_ARRAY, 0, 0, 0, 1, 0, 0, 2, 2);
    assert.equal(r.context.glGetError(), GL.NO_ERROR);
    await r.swap();
    const surface = surfaceOf(r, name);
    assert.equal(surface.descriptor.size.depthOrArrayLayers, 3);
    assert.equal(surface.descriptor.format, 'rg8unorm');
    const upload = r.gpu.of('writeTexture').find((/** @type {any} */ w)=>
        w.destination.texture === surface.texture);
    assert.equal(upload.size.depthOrArrayLayers, 3, 'every layer in one copy');
    assert.deepEqual(Array.from(upload.bytes), Array.from({ length: 24 }, (_, i)=>i));
    const layer = r.gpu.of('createView').find((/** @type {any} */ v)=>
        v.texture === surface.texture && v.view.viewDescriptor?.baseArrayLayer === 1);
    assert.ok(layer, 'the copy drew into layer 1');
    const pass = r.gpu.of('beginRenderPass').find((/** @type {any} */ p)=>
        p.descriptor.colorAttachments[0]?.view === layer.view);
    const scissor = r.gpu.of('setScissorRect').find((/** @type {any} */ c)=>c.pass === pass.pass);
    assert.deepEqual(scissor.rect, [0, 0, 2, 2], 'the layer\'s own size');
    assert.deepEqual(r.gpu.errors ?? [], []);
});

test('a framebuffer draws into a half float colour texture and a depth texture', async()=>{
    const r = rig();
    const { context } = r;
    const [colour, depth] = context.glGenTextures(2);
    context.glBindTexture(GL.TEXTURE_2D, colour);
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RGBA16F, 16, 16, 0, GL.RGBA, TEX.HALF_FLOAT, null);
    context.glBindTexture(GL.TEXTURE_2D, depth);
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.DEPTH_COMPONENT24, 16, 16, 0, GL.DEPTH_COMPONENT,
        GL.FLOAT, null);
    const [fbo] = context.glGenFramebuffers(1);
    context.bindFramebuffer(GL.FRAMEBUFFER, fbo, false);
    context.framebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, colour, 0);
    context.framebufferTexture(GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, GL.TEXTURE_2D, depth, 0);
    assert.equal(context.glCheckFramebufferStatus(GL.FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE);
    context.glEnable(GL.DEPTH_TEST);
    context.glClear(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);
    r.draw();
    await r.swap();
    const passes = r.gpu.of('beginRenderPass');
    const into = passes.find((/** @type {any} */ p)=>
        p.descriptor.depthStencilAttachment?.view?.texture === surfaceOf(r, depth).texture
        && p.descriptor.colorAttachments.length > 0);
    assert.ok(into, 'a pass drew into the depth texture');
    assert.equal(into.descriptor.colorAttachments[0].view.texture, surfaceOf(r, colour).texture);
    const pipelines = r.gpu.of('createRenderPipeline').map((/** @type {any} */ p)=>p.descriptor);
    assert.ok(pipelines.some((/** @type {any} */ d)=>d.fragment?.targets?.[0]?.format
        === 'rgba16float' && d.depthStencil?.format === 'depth24plus-stencil8'));
    assert.deepEqual(r.gpu.errors ?? [], []);
});

test('an attachment of a sized format answers its sizes, component type and encoding', ()=>{
    const { context } = rig();
    const [colour, depth] = context.glGenTextures(2);
    context.glBindTexture(GL.TEXTURE_2D, colour);
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.SRGB8_ALPHA8, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        null);
    context.glBindTexture(GL.TEXTURE_2D, depth);
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.DEPTH32F_STENCIL8, 4, 4, 0, GL.DEPTH_STENCIL,
        TEX.FLOAT_32_UNSIGNED_INT_24_8_REV, null);
    const [fbo] = context.glGenFramebuffers(1);
    context.bindFramebuffer(GL.FRAMEBUFFER, fbo, false);
    context.framebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, colour, 0);
    context.framebufferTexture(GL.FRAMEBUFFER, GL.DEPTH_ATTACHMENT, GL.TEXTURE_2D, depth, 0);
    /** @param {number} point @param {number} pname */
    const ask = (point, pname)=>context.glGetFramebufferAttachmentParameteriv(GL.FRAMEBUFFER,
        point, pname)[0];
    assert.equal(ask(GL.COLOR_ATTACHMENT0, TEX.FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING), 0x8c40);
    assert.equal(ask(GL.COLOR_ATTACHMENT0, TEX.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE),
        GL.UNSIGNED_NORMALIZED);
    assert.equal(ask(GL.DEPTH_ATTACHMENT, TEX.FRAMEBUFFER_ATTACHMENT_COMPONENT_TYPE), GL.FLOAT);
    assert.equal(ask(GL.DEPTH_ATTACHMENT, GL.FRAMEBUFFER_ATTACHMENT_DEPTH_SIZE), 32);
    assert.equal(ask(GL.DEPTH_ATTACHMENT, GL.FRAMEBUFFER_ATTACHMENT_STENCIL_SIZE), 8);
    assert.equal(ask(GL.DEPTH_ATTACHMENT, GL.FRAMEBUFFER_ATTACHMENT_RED_SIZE), 0);
});

test('an integer texture as an attachment is a complete framebuffer', ()=>{
    const r = rig();
    const { context } = r;
    const [colour] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, colour);
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RGBA8UI, 4, 4, 0, TEX.RGBA_INTEGER,
        GL.UNSIGNED_BYTE, null);
    const [fbo] = context.glGenFramebuffers(1);
    context.bindFramebuffer(GL.FRAMEBUFFER, fbo, false);
    context.framebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, colour, 0);
    assert.equal(context.glCheckFramebufferStatus(GL.FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE,
        'a GLSL program writes its integers (gpu-glsl.test.js)');
});

test('glCopyImageSubData between two images of one format is the device\'s copy', async()=>{
    const r = rig();
    const { context } = r;
    const [from, into] = context.glGenTextures(2);
    context.glBindTexture(TEX.TEXTURE_2D_ARRAY, from);
    context.glTexStorage3D(TEX.TEXTURE_2D_ARRAY, 2, TEX.RGBA16F, 4, 4, 3);
    context.glBindTexture(GL.TEXTURE_CUBE_MAP, into);
    context.glTexStorage2D(GL.TEXTURE_CUBE_MAP, 1, TEX.RGBA16F, 2, 2);
    context.glCopyImageSubData(from, TEX.TEXTURE_2D_ARRAY, 1, 0, 1, 1, into, GL.TEXTURE_CUBE_MAP,
        0, 1, 0, 2, 1, 1, 2);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    await r.swap();
    const [copy] = r.gpu.of('copyTextureToTexture');
    assert.ok(copy, 'copied on the device');
    assert.equal(copy.source.texture, surfaceOf(r, from).texture);
    assert.equal(copy.destination.texture, surfaceOf(r, into).texture);
    assert.deepEqual([copy.source.mipLevel, copy.source.origin, copy.destination.mipLevel,
        copy.destination.origin, copy.size], [1, { x: 0, y: 1, z: 1 }, 0, { x: 1, y: 0, z: 2 },
        { width: 1, height: 1, depthOrArrayLayers: 2 }], 'layers 1-2 into faces 2-3');
    assert.equal(r.renderer.diagnostics().failures?.length ?? 0, 0);
    assert.deepEqual(r.said, []);
});

test('glCopyImageSubData across two formats is made here, and its box goes up', async()=>{
    const r = rig();
    const { context } = r;
    const [from, into] = context.glGenTextures(2);
    context.glBindTexture(GL.TEXTURE_2D, from);
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RGBA8UI, 1, 1, 0, TEX.RGBA_INTEGER,
        GL.UNSIGNED_BYTE, Uint8Array.from([0, 0, 0x80, 0x3f]));
    context.glBindTexture(GL.TEXTURE_2D, into);
    context.glTexStorage2D(GL.TEXTURE_2D, 1, TEX.R32F, 2, 1);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
    context.glEnable(GL.TEXTURE_2D);
    r.draw();
    await r.swap();
    context.glCopyImageSubData(from, GL.TEXTURE_2D, 0, 0, 0, 0, into, GL.TEXTURE_2D, 0, 1, 0, 0,
        1, 1, 1);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    r.draw();
    await r.swap();
    assert.equal(r.gpu.of('copyTextureToTexture').length, 0, 'rgba8uint is not r32float');
    const held = surfaceOf(r, into).texture.bytes;
    assert.deepEqual(Array.from(new Float32Array(held.buffer, held.byteOffset, 2)), [0, 1],
        'the float those bytes spell, in the box');
});

test('a colour renderbuffer is a copy\'s source on the device', async()=>{
    const r = rig();
    const { context } = r;
    const [rb] = context.glCreateRenderbuffers(1);
    context.bindRenderbuffer(GL.RENDERBUFFER, rb, false);
    context.glRenderbufferStorageMultisample(GL.RENDERBUFFER, 0, GL.RGBA8, 4, 4);
    const [into] = context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, into);
    context.glTexStorage2D(GL.TEXTURE_2D, 1, GL.RGBA8, 4, 4);
    context.glCopyImageSubData(rb, GL.RENDERBUFFER, 0, 0, 0, 0, into, GL.TEXTURE_2D, 0, 0, 0, 0,
        4, 4, 1);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    await r.swap();
    const [copy] = r.gpu.of('copyTextureToTexture');
    const surface = r.gpu.of('createTexture').find((/** @type {any} */ t)=>
        t.descriptor.label === `gl-renderbuffer:${rb}`);
    assert.equal(copy?.source.texture, surface.texture);
    assert.ok(surface.descriptor.usage & 0x02, 'a renderbuffer is a copy\'s destination too');
    assert.deepEqual(r.said, []);
});

test('a level the device copied into is not uploaded over from this side', async()=>{
    const r = rig();
    const { context } = r;
    const [from, into] = context.glGenTextures(2);
    // Both levels' bytes held here as well: the copy is made on both sides,
    // and what this side makes of it must not go up over the device's (whose
    // source a draw may have changed since).
    for (const name of [from, into])
    {
        context.glBindTexture(GL.TEXTURE_2D, name);
        context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.RGBA16F, 2, 2, 0, GL.RGBA, TEX.HALF_FLOAT,
            new Uint8Array(32).fill(name));
    }
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
    context.glEnable(GL.TEXTURE_2D);
    r.draw();
    await r.swap();
    const surface = surfaceOf(r, into).texture;
    /** The uploads into the destination so far. */
    const uploads = ()=>r.gpu.calls.filter((/** @type {any} */ call)=>
        (call.op === 'writeTexture' || call.op === 'copyBufferToTexture')
        && call.destination.texture === surface).length;
    const before = uploads();
    context.glCopyImageSubData(from, GL.TEXTURE_2D, 0, 0, 0, 0, into, GL.TEXTURE_2D, 0, 1, 1, 0,
        1, 1, 1);
    r.draw();
    await r.swap();
    assert.equal(r.gpu.of('copyTextureToTexture').length, 1);
    assert.equal(uploads(), before, 'what the device drew in the source is the copy\'s');
});
