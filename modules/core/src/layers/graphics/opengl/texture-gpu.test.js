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

/**
 * @param {string[]} [features] @param {boolean} [compressedTextures]  BC sampled as blocks
 * @param {any} [liveDump]  the switches of a running program (`app.debug`)
 */
function rig(features = [], compressedTextures = false, liveDump = null){
    const gpu = createFakeDevice({ features });
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} });
    /** @type {string[]} */
    const said = [];
    const renderer = createGpuRenderer({
        backend,
        compressedTextures,
        liveDump,
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

/**
 * A framebuffer of a colour texture and a DEPTH24_STENCIL8 one, its depth
 * written by a first draw; then the depth texture bound on unit 0, linearly
 * filtered, for the draws a test makes, as a deferred light reads the scene's
 * depth while testing against it.
 *
 * @param {ReturnType<typeof rig>} r
 */
function depthReadRig(r){
    const { context } = r;
    const [colour, depth] = context.glGenTextures(2);
    context.glBindTexture(GL.TEXTURE_2D, colour);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 16, 16, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
    context.glBindTexture(GL.TEXTURE_2D, depth);
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.DEPTH24_STENCIL8, 16, 16, 0, GL.DEPTH_STENCIL,
        GL.UNSIGNED_INT_24_8, null);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.LINEAR);
    context.glBindTexture(GL.TEXTURE_2D, 0);
    const [fbo] = context.glGenFramebuffers(1);
    context.bindFramebuffer(GL.FRAMEBUFFER, fbo, false);
    context.framebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, colour, 0);
    context.framebufferTexture(GL.FRAMEBUFFER, GL.DEPTH_STENCIL_ATTACHMENT, GL.TEXTURE_2D, depth,
        0);
    assert.equal(context.glCheckFramebufferStatus(GL.FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE);
    context.glEnable(GL.DEPTH_TEST);
    context.glClear(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT | GL.STENCIL_BUFFER_BIT);
    r.draw();
    context.glBindTexture(GL.TEXTURE_2D, depth);
    context.glEnable(GL.TEXTURE_2D);
    context.glDepthFunc(GL.GREATER);
    context.glEnable(GL.STENCIL_TEST);
    context.glStencilFunc(GL.EQUAL, 1, 0xff);
    context.glStencilOp(GL.KEEP, GL.KEEP, GL.KEEP);
    context.glEnable(GL.BLEND);
    context.glBlendFunc(GL.ONE, GL.ONE);
    return { depth };
}

/**
 * The passes into the depth texture in order, each with the depth views its
 * draws sampled.
 *
 * @param {ReturnType<typeof rig>} r @param {number} depth
 */
function depthPasses(r, depth){
    const surface = surfaceOf(r, depth).texture;
    return r.gpu.of('beginRenderPass').filter((/** @type {any} */ p)=>
        p.descriptor.depthStencilAttachment?.view?.texture === surface).map((/** @type {any} */ p)=>({
        attachment: p.descriptor.depthStencilAttachment,
        draws: r.gpu.of('draw').concat(r.gpu.of('drawIndexed'))
            .filter((/** @type {any} */ d)=>d.pass === p.pass).length,
        sampled: r.gpu.of('setBindGroup').filter((/** @type {any} */ c)=>c.pass === p.pass)
            .flatMap((/** @type {any} */ c)=>c.group?.entries ?? [])
            .filter((/** @type {any} */ e)=>e.resource?.texture === surface)
            .map((/** @type {any} */ e)=>e.resource.viewDescriptor?.aspect),
    }));
}

test('a draw writing neither depth nor stencil samples its depth attachment, held read-only',
    async()=>{
        const r = rig();
        const { context } = r;
        const { depth } = depthReadRig(r);
        context.glDepthMask(false);
        r.draw();
        r.draw();
        // Depth written again after the lights: a pass of its own again.
        context.glDisable(GL.TEXTURE_2D);
        context.glDepthMask(true);
        context.glDepthFunc(GL.LESS);
        context.glDisable(GL.STENCIL_TEST);
        r.draw();
        await r.swap();
        assert.deepEqual(r.gpu.errors, []);
        assert.ok(!r.said.some(d=>/framebuffer draws into/.test(d)), r.said.join('\n'));
        assert.ok(r.said.some(d=>/read nearest/.test(d)), 'the linear filter is said dropped');
        const passes = depthPasses(r, depth).filter(p=>p.draws > 0);
        const at = passes.findIndex(p=>p.attachment.depthReadOnly);
        assert.ok(at > 0, 'a pass that writes depth comes before the read-only one');
        const [before, reading, after] = passes.slice(at - 1, at + 2);
        assert.deepEqual(reading.attachment, { view: reading.attachment.view,
            depthReadOnly: true, stencilLoadOp: 'load', stencilStoreOp: 'store' },
        'the depth read-only, no load or store; the stencil written still');
        assert.equal(reading.draws, 2, 'both lights in the one read-only pass');
        assert.deepEqual(reading.sampled, ['depth-only'], 'bound once, through its depth');
        // What the first draw wrote is kept across the break and loaded after.
        assert.equal(before.attachment.depthStoreOp, 'store');
        assert.equal(before.attachment.stencilStoreOp, 'store');
        assert.ok(after, 'the draw writing depth again is a pass of its own');
        assert.equal(after.attachment.depthReadOnly, undefined);
        assert.equal(after.attachment.depthLoadOp, 'load');
        assert.equal(after.attachment.stencilLoadOp, 'load');
        assert.deepEqual(after.sampled, []);
    });

test('a draw sampling its depth attachment samples black when it writes depth, and the depth'
    + ' itself when it writes the stencil alone', async()=>{
    for (const writes of ['depth', 'stencil'])
    {
        const r = rig();
        const { context } = r;
        const { depth } = depthReadRig(r);
        if (writes === 'depth')
        {
            context.glDepthMask(true);
        }
        else
        {
            context.glDepthMask(false);
            context.glStencilOp(GL.KEEP, GL.KEEP, GL.REPLACE);
        }
        r.draw();
        await r.swap();
        assert.deepEqual(r.gpu.errors, [], writes);
        const passes = depthPasses(r, depth);
        if (writes === 'stencil')
        {
            // A light that marks the stencil where it reached, reading the
            // scene's depth: black in place of the depth left the scene dark.
            assert.ok(!r.said.some(d=>/framebuffer draws into/.test(d)), r.said.join(' | '));
            const reading = passes.filter(p=>p.attachment.depthReadOnly);
            assert.equal(reading.length, 1);
            assert.equal(reading[0].attachment.stencilStoreOp, 'store');
            assert.deepEqual(reading[0].sampled, ['depth-only']);
            continue;
        }
        assert.ok(r.said.some(d=>/sampled a texture its framebuffer draws into/.test(d)),
            writes);
        assert.ok(passes.every(p=>!p.attachment.depthReadOnly), writes);
        assert.ok(passes.every(p=>p.sampled.length === 0), `${writes}: the placeholder`);
    }
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

test('glCopyImageSubData across two formats of one texel size goes through a buffer', async()=>{
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
    const surface = surfaceOf(r, into).texture;
    /** The uploads into the destination. */
    const uploads = ()=>r.gpu.of('writeTexture').filter((/** @type {any} */ write)=>
        write.destination.texture === surface).length;
    const before = uploads();
    context.glCopyImageSubData(from, GL.TEXTURE_2D, 0, 0, 0, 0, into, GL.TEXTURE_2D, 0, 1, 0, 0,
        1, 1, 1);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    r.draw();
    await r.swap();
    assert.equal(r.gpu.of('copyTextureToTexture').length, 0, 'rgba8uint is not r32float');
    const [down] = r.gpu.of('copyTextureToBuffer');
    const [up] = r.gpu.of('copyBufferToTexture').filter((/** @type {any} */ copy)=>
        copy.destination.texture === surface);
    assert.equal(down?.source.texture, surfaceOf(r, from).texture);
    assert.deepEqual(up?.destination.origin, { x: 1, y: 0, z: 0 });
    assert.equal(uploads(), before, 'nothing made here went up');
});

for (const features of [[], ['texture-compression-bc']])
{
    test(`blocks copied into texels are made here, the box to go up (${features})`, async()=>{
        const r = rig(features, features.length > 0);
        const { context } = r;
        const [from, into] = context.glGenTextures(2);
        const blocks = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
        context.glBindTexture(GL.TEXTURE_2D, from);
        context.glTexStorage2D(GL.TEXTURE_2D, 1, TEX.COMPRESSED_RED_RGTC1, 4, 4);
        context.glCompressedTexSubImage2DARB(GL.TEXTURE_2D, 0, 0, 0, 4, 4,
            TEX.COMPRESSED_RED_RGTC1, 8, blocks);
        context.glBindTexture(GL.TEXTURE_2D, into);
        context.glTexStorage2D(GL.TEXTURE_2D, 1, TEX.RG32UI, 1, 1);
        context.glCopyImageSubData(from, GL.TEXTURE_2D, 0, 0, 0, 0, into, GL.TEXTURE_2D, 0, 0, 0,
            0, 4, 4, 1);
        assert.equal(context.glGetError(), GL.NO_ERROR);
        await r.swap();
        assert.equal(r.gpu.of('copyTextureToTexture').length + r.gpu.of('copyTextureToBuffer')
            .length, 0, 'a block is no texel to a device copy, decoded or not');
        assert.deepEqual([...context.side.textureBoundAt(0, GL.TEXTURE_2D).dirty],
            [[0, [{ x: 0, y: 0, width: 1, height: 1 }]]], 'the box is to go up');
        assert.deepEqual(Array.from(context.glGetTextureSubImage(into, 0, { x: 0, y: 0, z: 0,
            width: 1, height: 1, depth: 1 }, TEX.RG_INTEGER, GL.UNSIGNED_INT, 8)),
        Array.from(blocks), 'one block, one texel');
        assert.deepEqual(r.said, []);
    });
}

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

test('a level kept in other bits than its own is copied here, to another format', async()=>{
    const r = rig();
    const { context } = r;
    const [from, into] = context.glGenTextures(2);
    context.glBindTexture(GL.TEXTURE_2D, from);
    context.glTexImage2D(GL.TEXTURE_2D, 0, TEX.R16, 1, 1, 0, GL.RED, GL.UNSIGNED_SHORT,
        Uint8Array.from([0x00, 0x3c]));
    context.glBindTexture(GL.TEXTURE_2D, into);
    context.glTexStorage2D(GL.TEXTURE_2D, 1, TEX.R16F, 1, 1);
    context.glCopyImageSubData(from, GL.TEXTURE_2D, 0, 0, 0, 0, into, GL.TEXTURE_2D, 0, 0, 0, 0,
        1, 1, 1);
    await r.swap();
    assert.equal(surfaceOf(r, from).descriptor.format, 'r16float', 'R16 kept as half floats');
    assert.equal(r.gpu.of('copyTextureToTexture').length + r.gpu.of('copyTextureToBuffer')
        .length, 0, 'the half float of R16 is not its bits');
    assert.deepEqual(Array.from(context.glGetTextureSubImage(into, 0, { x: 0, y: 0, z: 0,
        width: 1, height: 1, depth: 1 }, GL.RED, TEX.HALF_FLOAT, 2)), [0x00, 0x3c],
    'the bits, here: the half float one');
});

test('a snapshot of a texture that cannot be read ends its frame, and the program draws on',
    async()=>{
        // A depth-stencil has no row pitch to be read by: the read threw with
        // the snapshot's frame open, and every frame of the program after it
        // was refused ("A frame is already open") - a debug switch froze the game.
        /** @type {any[]} */
        const snapped = [];
        const live = { dumpFrames: 0, snapshot: '',
            snapped: (/** @type {string} */ id, /** @type {any} */ got)=>snapped.push({ id, ...got }) };
        const r = rig([], false, live);
        const { depth } = depthReadRig(r);
        r.draw();
        await r.swap();
        live.snapshot = 't' + depth;
        for (let frame = 0; frame < 4; frame++)
        {
            r.draw();
            await r.swap();
        }
        assert.equal(snapped.length, 1);
        assert.match(snapped[0].info, /not read/);
        assert.ok(!r.said.some(d=>/already open|lost/.test(d)), r.said.join(' | '));
        assert.deepEqual(r.gpu.errors, []);
    });
