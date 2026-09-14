/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { CANONICAL_STRIDE } from './gpu-layout.js';
import { COPY_UNIFORM_FLOATS, UNIFORM } from './wgsl.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/**
 * A context on a renderer on a backend on a recording device: what the
 * assembled layer builds when it has a GPU, with every call to the device
 * on record.
 *
 * @param {object} [services]  extra renderer services (the dump options)
 */
function rig(services = {}){
    const gpu = createFakeDevice();
    /** @type {any[]} */
    const presented = [];
    const backend = createBackend({
        device: gpu.device, queue: gpu.queue, presentTo: frame=>presented.push(frame),
    });
    /** @type {string[]} */
    const divergences = [];
    const renderer = createGpuRenderer({
        backend,
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
        divergence: detail=>divergences.push(detail),
        ...services,
    });
    const bytes = new Uint8Array(0x10000);
    const memory = {
        read: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>bytes.set(value, at),
    };
    /** @type {any} */
    const context = createGlContext({ memory, gpu: renderer, divergence: d=>divergences.push(d) });
    context.attach({ width: 64, height: 32, doubleBuffered: true, depthBits: 24 });
    context.glMatrixMode(GL.PROJECTION);
    context.glLoadIdentity();
    context.glOrtho(0, 64, 0, 32, -1, 1);
    context.glMatrixMode(GL.MODELVIEW);
    context.glLoadIdentity();
    /** @param {number} at @param {number[]} values */
    const floats = (at, values)=>{
        const view = new DataView(bytes.buffer);
        values.forEach((value, i)=>view.setFloat32(at + i * 4, value, true));
    };
    /** @param {number} at @param {number[]} values */
    const words = (at, values)=>{
        const view = new DataView(bytes.buffer);
        values.forEach((value, i)=>view.setUint32(at + i * 4, value, true));
    };
    /** Swaps, and waits for the replay the swap queued. */
    const swap = async()=>{
        renderer.present(context);
        await renderer.settled();
    };
    return { gpu, backend, renderer, context, presented, divergences, bytes, floats, words,
        swap };
}

/** Three vertices of 60 bytes each: a position and a texture coordinate. */
const STRIDE = 60;
/** @param {ReturnType<typeof rig>} r @param {number} at */
function triangle(r, at){
    for (let i = 0; i < 3; i++)
    {
        r.floats(at + i * STRIDE, [i * 8, i * 4, 0]);
        r.floats(at + i * STRIDE + 12, [i * 0.5, 0]);
    }
}

test('a draw from a buffer object binds the buffer as it lies, unread here', async()=>{
    const r = rig();
    const { context } = r;
    triangle(r, 0x1000);
    context.glGenBuffersARB(1);
    context.glBindBufferARB(GL.ARRAY_BUFFER, 1);
    context.glBufferDataARB(GL.ARRAY_BUFFER, 3 * STRIDE, 0x1000, GL.STATIC_DRAW);
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glEnableClientState(GL.TEXTURE_COORD_ARRAY);
    context.glVertexPointer(3, GL.FLOAT, STRIDE, 0);
    context.glTexCoordPointer(2, GL.FLOAT, STRIDE, 12);
    r.words(0x2000, [0, 1, 2]);
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    await r.swap();

    const bound = r.gpu.of('setVertexBuffer');
    assert.equal(bound.length, 1, 'one slot: both arrays share the vertex');
    assert.match(bound[0].buffer.descriptor.label, /gl-buffer:1/);
    assert.equal(bound[0].offset, 0);
    const indexed = r.gpu.of('drawIndexed');
    assert.deepEqual(indexed[0].args, [3, 1, 0, 0]);
    assert.equal(r.gpu.of('setIndexBuffer')[0].format, 'uint32');
    const uploads = r.gpu.of('writeBuffer').filter(w=>/gl-buffer:1/.test(w.buffer.descriptor.label));
    assert.equal(uploads.length, 1, 'the buffer object\'s bytes travelled once');
    assert.equal(uploads[0].size, 3 * STRIDE);
    assert.equal(r.renderer.diagnostics().fallbacks, 0);
    assert.equal(r.presented.length, 1);
    assert.match(r.presented[0].surface.label, /gl-shown\[0\]/);
});

test('a write into a range a recorded draw read renames; one elsewhere does not', async()=>{
    const r = rig();
    const { context } = r;
    triangle(r, 0x1000);
    triangle(r, 0x1000 + 3 * STRIDE);
    context.glGenBuffersARB(1);
    context.glBindBufferARB(GL.ARRAY_BUFFER, 1);
    context.glBufferDataARB(GL.ARRAY_BUFFER, 6 * STRIDE, 0x1000, GL.STATIC_DRAW);
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glVertexPointer(3, GL.FLOAT, STRIDE, 0);
    r.words(0x2000, [0, 1, 2]);
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);

    // The second triangle, which nothing recorded has read: a range upload.
    context.glBufferSubDataARB(GL.ARRAY_BUFFER, 3 * STRIDE, 3 * STRIDE, 0x1000);
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    assert.equal(r.renderer.diagnostics().renames, 0);

    // The first triangle, which the draws above still read: a rename, so
    // those draws keep what they read.
    context.glBufferSubDataARB(GL.ARRAY_BUFFER, 0, 12, 0x1000);
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    assert.equal(r.renderer.diagnostics().renames, 1);
    await r.swap();

    const backings = new Set(r.gpu.of('setVertexBuffer').map(call=>call.buffer.id));
    assert.equal(backings.size, 2, 'the draws before the rename bind the retired backing');

    // Once the frame that read the range has been flushed, a write into it
    // is a range upload again.
    context.glBufferSubDataARB(GL.ARRAY_BUFFER, 0, 12, 0x1000);
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    assert.equal(r.renderer.diagnostics().renames, 1);
});

test('arrays in client memory are copied by the range the indices reach', async()=>{
    const r = rig();
    const { context } = r;
    triangle(r, 0x1000 + 5 * STRIDE);
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glVertexPointer(3, GL.FLOAT, STRIDE, 0x1000);
    r.words(0x2000, [5, 6, 7]);
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    await r.swap();

    const scratch = r.gpu.of('writeBuffer')
        .filter(w=>/gl-scratch-vertices/.test(w.buffer.descriptor.label));
    assert.equal(scratch.length, 1);
    assert.equal(scratch[0].size, 3 * STRIDE, 'vertices five to seven, not zero to seven');
    assert.deepEqual(r.gpu.of('drawIndexed')[0].args, [3, 1, 0, -5],
        'the base vertex takes the copy\'s origin off every index');
});

test('a quad drawn in immediate mode is packed canonically as two triangles', async()=>{
    const r = rig();
    const { context } = r;
    context.glColor4f(1, 0, 0, 1);
    context.glBegin(GL.QUADS);
    context.glVertex2f(0, 0);
    context.glVertex2f(8, 0);
    context.glVertex2f(8, 8);
    context.glVertex2f(0, 8);
    context.glEnd();
    await r.swap();

    const scratch = r.gpu.of('writeBuffer')
        .filter(w=>/gl-scratch-vertices/.test(w.buffer.descriptor.label));
    assert.equal(scratch[0].size, 4 * CANONICAL_STRIDE);
    const indices = r.gpu.of('writeBuffer')
        .filter(w=>/gl-scratch-indices/.test(w.buffer.descriptor.label));
    assert.deepEqual([...new Uint32Array(indices[0].bytes.buffer, indices[0].bytes.byteOffset, 6)],
        [0, 1, 2, 0, 2, 3]);
    assert.deepEqual(r.gpu.of('drawIndexed')[0].args, [6, 1, 0, 0]);
});

test('the uniform block carries the matrices, the current colour and the unit constants', async()=>{
    const r = rig();
    const { context } = r;
    context.glColor4f(0.25, 0.5, 0.75, 1);
    context.glEnable(GL.ALPHA_TEST);
    context.glAlphaFunc(GL.GREATER, 0.5);
    context.glBegin(GL.TRIANGLES);
    context.glVertex2f(0, 0);
    context.glVertex2f(8, 0);
    context.glVertex2f(8, 8);
    context.glEnd();
    await r.swap();

    const uniforms = r.gpu.of('writeBuffer').filter(w=>/uniforms/.test(w.buffer.descriptor.label));
    // The show copy's block is the last write; the draw's is the one before.
    const block = new Float32Array(uniforms[uniforms.length - 2].bytes.buffer,
        uniforms[uniforms.length - 2].bytes.byteOffset, UNIFORM.floats);
    // An orthographic projection of 0..64 by 0..32: x scales by 2/64.
    assert.equal(block[UNIFORM.modelViewProjection], 2 / 64);
    assert.deepEqual([...block.subarray(UNIFORM.color, UNIFORM.color + 4)], [0.25, 0.5, 0.75, 1]);
    assert.equal(block[UNIFORM.misc], 0.5);
});

test('a texture is uploaded once per version, a cube map face by face', async()=>{
    const r = rig();
    const { context } = r;
    context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, 1);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    const texels = new Uint8Array(4 * 4 * 4).fill(0x80);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE, texels);
    context.glEnable(GL.TEXTURE_2D);
    const draw = ()=>{
        context.glBegin(GL.TRIANGLES);
        context.glVertex2f(0, 0);
        context.glVertex2f(8, 0);
        context.glVertex2f(8, 8);
        context.glEnd();
    };
    draw();
    draw();
    await r.swap();
    assert.equal(r.gpu.of('writeTexture').length, 1, 'two draws, one upload');
    context.glTexSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 4, 4, GL.RGBA, GL.UNSIGNED_BYTE, texels);
    draw();
    await r.swap();
    assert.equal(r.gpu.of('writeTexture').length, 2, 'a write brings the copy up to date');

    context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_CUBE_MAP, 2);
    context.glTexParameteri(GL.TEXTURE_CUBE_MAP, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    for (let face = 0; face < 6; face++)
    {
        context.glTexImage2D(GL.TEXTURE_CUBE_MAP_POSITIVE_X + face, 0, GL.RGB, 4, 4, 0, GL.RGB,
            GL.UNSIGNED_BYTE, new Uint8Array(4 * 4 * 3));
    }
    context.glDisable(GL.TEXTURE_2D);
    context.glEnable(GL.TEXTURE_CUBE_MAP);
    draw();
    await r.swap();
    const faces = r.gpu.of('writeTexture').slice(2);
    assert.equal(faces.length, 6);
    assert.deepEqual(faces.map(f=>f.destination.origin.z), [0, 1, 2, 3, 4, 5]);
    const cube = r.gpu.of('createTexture').find(t=>/gl-texture:2/.test(t.descriptor.label));
    assert.equal(cube.descriptor.size.depthOrArrayLayers, 6);
    const layout = r.gpu.of('createBindGroupLayout')
        .find(l=>l.descriptor.entries
            .some((/** @type {any} */ e)=>e.texture?.viewDimension === 'cube'));
    assert.equal(layout.descriptor.entries[1].texture.viewDimension, 'cube');
});

test('a clear is a triangle under the scissor with the masks in its pipeline', async()=>{
    const r = rig();
    const { context } = r;
    context.glEnable(GL.SCISSOR_TEST);
    context.glScissor(4, 2, 8, 8);
    context.glColorMask(1, 1, 1, 0);
    context.glClearColor(0.5, 0.25, 0, 1);
    context.glClear(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);
    await r.swap();

    const draws = r.gpu.of('draw');
    assert.deepEqual(draws[0].args, [3, 1, 0], 'the clear, then the shown copy');
    // GL's box is from the bottom; the target's y runs down: 32 - 2 - 8 = 22.
    assert.deepEqual(r.gpu.of('setScissorRect').map(c=>c.rect).find(rect=>rect[0] === 4),
        [4, 22, 8, 8]);
    const pipeline = r.gpu.of('createRenderPipeline').find(p=>/clear/.test(p.descriptor.label));
    assert.equal(pipeline.descriptor.fragment.targets[0].writeMask, 0x7);
    assert.equal(pipeline.descriptor.depthStencil.depthWriteEnabled, true);
    assert.equal(pipeline.descriptor.depthStencil.stencilWriteMask, 0);
});

test('a pipeline is built once per state, across frames', async()=>{
    const r = rig();
    const { context } = r;
    const draw = ()=>{
        context.glBegin(GL.TRIANGLES);
        context.glVertex2f(0, 0);
        context.glVertex2f(8, 0);
        context.glVertex2f(8, 8);
        context.glEnd();
    };
    draw();
    await r.swap();
    context.glEnable(GL.BLEND);
    draw();
    draw();
    await r.swap();
    context.glDisable(GL.BLEND);
    draw();
    await r.swap();
    const diagnostics = r.renderer.diagnostics();
    assert.equal(diagnostics.draws, 4);
    assert.equal(diagnostics.pipelines, 3, 'unblended, blended, and the shown copy');
    assert.equal(r.gpu.count('createRenderPipeline'), 3);
    assert.equal(r.gpu.count('submit'), 3, 'one submit per swap');
    assert.equal(r.presented.length, 3);
    assert.match(r.presented[1].surface.label, /gl-shown\[1\]/, 'the shown copies alternate');
});

test('the viewport is set from the bottom-left box GL keeps, with the depth range', async()=>{
    const r = rig();
    const { context } = r;
    context.glViewport(2, 4, 16, 8);
    context.glDepthRange(0.1, 0.9);
    context.glBegin(GL.TRIANGLES);
    context.glVertex2f(0, 0);
    context.glVertex2f(8, 0);
    context.glVertex2f(8, 8);
    context.glEnd();
    await r.swap();
    const viewport = r.gpu.of('setViewport').map(c=>c.rect).find(rect=>rect[0] === 2);
    assert.deepEqual(viewport, [2, 32 - 4 - 8, 16, 8, 0.1, 0.9]);
});

test('a read of the framebuffer on the device path is reported, not answered', ()=>{
    const r = rig();
    const { context } = r;
    context.glReadPixels(0, 0, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE, 0x3000);
    assert.ok(r.divergences.some(d=>/glReadPixels was accepted and read black/.test(d)));
});

/**
 * The one view of a single level the copy renders into, and its render pass.
 *
 * @param {ReturnType<typeof rig>} r
 */
function copyTarget(r){
    const view = r.gpu.of('createView')
        .find(c=>c.view.viewDescriptor.mipLevelCount === 1
            && c.view.viewDescriptor.baseMipLevel !== undefined);
    assert.ok(view, 'the copy made a view of one level');
    const pass = r.gpu.of('beginRenderPass')
        .find(p=>p.descriptor.colorAttachments[0].view === view.view);
    assert.ok(pass, 'the copy is a render pass into that view');
    return { view, pass };
}

/**
 * The copy's uniform block: the source rect, its offset and the source size.
 *
 * @param {ReturnType<typeof rig>} r
 */
function copyUniforms(r){
    const block = r.gpu.of('writeBuffer')
        .find(w=>/uniforms/.test(w.buffer.descriptor.label)
            && w.size === COPY_UNIFORM_FLOATS * 4);
    assert.ok(block, 'the copy wrote a uniform block');
    const floats = new Float32Array(block.bytes.buffer, block.bytes.byteOffset,
        COPY_UNIFORM_FLOATS);
    return [...floats.subarray(0, 6)];
}

test('glCopyTexSubImage2D renders the framebuffer rect into a view of the level', async()=>{
    const r = rig();
    const { context } = r;
    context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, 1);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 8, 8, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(8 * 8 * 4));
    context.glTexImage2D(GL.TEXTURE_2D, 1, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(4 * 4 * 4));
    context.glEnable(GL.TEXTURE_2D);
    const draw = ()=>{
        context.glBegin(GL.TRIANGLES);
        context.glVertex2f(0, 0);
        context.glVertex2f(8, 0);
        context.glVertex2f(8, 8);
        context.glEnd();
    };
    draw();
    // Framebuffer (3,4) 2x2, from the bottom -> level 1 at (1,1).
    context.glCopyTexSubImage2D(GL.TEXTURE_2D, 1, 1, 1, 3, 4, 2, 2);
    draw();
    await r.swap();

    const { view, pass } = copyTarget(r);
    assert.equal(view.view.viewDescriptor.baseMipLevel, 1, 'a view of the level copied into');
    assert.equal(view.view.viewDescriptor.dimension, '2d');
    const scissor = r.gpu.of('setScissorRect').filter(c=>c.pass === pass.pass).map(c=>c.rect);
    assert.ok(scissor.some(rect=>rect.join() === [1, 1, 2, 2].join()),
        `the scissor is the destination rect, got ${JSON.stringify(scissor)}`);
    assert.deepEqual(copyUniforms(r), [3, 4, 1, 1, 64, 32]);
    // The level the copy wrote is uploaded by the first draw alone: the draw
    // after the copy finds it clean and leaves the device's bytes alone.
    const uploads = r.gpu.of('writeTexture').filter(w=>w.destination.mipLevel === 1);
    assert.equal(uploads.length, 1, 'the level was uploaded once, before the copy');
    assert.ok(r.gpu.calls.indexOf(uploads[0]) < r.gpu.calls.indexOf(view),
        'the upload precedes the copy; the later draw uploaded nothing over it');
});

test('glCopyTexImage2D gives a level a shape and copies the framebuffer into it', async()=>{
    const r = rig();
    const { context } = r;
    context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, 1);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    // Framebuffer (2,3) 8x8, from the bottom -> a whole new level.
    context.glCopyTexImage2D(GL.TEXTURE_2D, 0, GL.RGB8, 2, 3, 8, 8, 0);
    context.glEnable(GL.TEXTURE_2D);
    context.glBegin(GL.TRIANGLES);
    context.glVertex2f(0, 0);
    context.glVertex2f(8, 0);
    context.glVertex2f(8, 8);
    context.glEnd();
    await r.swap();

    const { view, pass } = copyTarget(r);
    assert.equal(view.view.viewDescriptor.baseMipLevel, 0);
    const scissor = r.gpu.of('setScissorRect').filter(c=>c.pass === pass.pass).map(c=>c.rect);
    assert.ok(scissor.some(rect=>rect.join() === [0, 0, 8, 8].join()),
        'the scissor covers the whole level');
    assert.deepEqual(copyUniforms(r), [2, 3, 0, 0, 64, 32]);
    // Defined with a shape and no texels, and not marked dirty: the copy, not
    // an upload of these absent texels, is what fills the level.
    const stored = context.shareGroup.textures.objects.get(1).levels.get(0);
    assert.equal(stored.texels, null);
    assert.equal(context.glGetError(), GL.NO_ERROR);
});

// --- ARB programs on the device path ---

/** A vertex program: the MVP transform, an env tint, one coordinate set. */
const VERTEX_PROGRAM = `!!ARBvp1.0
TEMP clip;
PARAM mvp[4] = { state.matrix.mvp };
PARAM tint = program.env[2];
DP4 clip.x, vertex.position, mvp[0];
DP4 clip.y, vertex.position, mvp[1];
DP4 clip.z, vertex.position, mvp[2];
DP4 clip.w, vertex.position, mvp[3];
MOV result.position, clip;
MUL result.color, vertex.color, tint;
MOV result.texcoord[0], vertex.texcoord[0];
END
`;

/** A fragment program: one texture sample scaled by a local parameter. */
const FRAGMENT_PROGRAM = `!!ARBfp1.0
TEMP texel;
PARAM scale = program.local[1];
TEX texel, fragment.texcoord[0], texture[0], 2D;
MUL result.color, texel, scale;
END
`;

/**
 * @param {ReturnType<typeof rig>} r
 * @param {number} at
 * @param {string} text
 */
function putProgram(r, at, text){
    r.bytes.set(new TextEncoder().encode(text), at);
    return text.length;
}

/**
 * Three vertices of 48 bytes: a position, a colour and a texture coordinate,
 * in a buffer object, with both programs loaded, bound and enabled and the
 * fragment program's texture bound but its unit not enabled.
 *
 * @param {ReturnType<typeof rig>} r
 */
function programRig(r){
    const { context } = r;
    for (let i = 0; i < 3; i++)
    {
        r.floats(0x1000 + i * 48, [i * 8, i * 4, 0]);
        r.floats(0x1000 + i * 48 + 12, [1, 0.5, 0.25, 1]);
        r.floats(0x1000 + i * 48 + 28, [i * 0.5, 0]);
    }
    context.glGenBuffersARB(1);
    context.glBindBufferARB(GL.ARRAY_BUFFER, 1);
    context.glBufferDataARB(GL.ARRAY_BUFFER, 3 * 48, 0x1000, GL.STATIC_DRAW);
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glEnableClientState(GL.COLOR_ARRAY);
    context.glEnableClientState(GL.TEXTURE_COORD_ARRAY);
    context.glVertexPointer(3, GL.FLOAT, 48, 0);
    context.glColorPointer(4, GL.FLOAT, 48, 12);
    context.glTexCoordPointer(2, GL.FLOAT, 48, 28);
    context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, 1);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(4 * 4 * 4).fill(0x80));
    context.glGenProgramsARB(2);
    context.glBindProgramARB(GL.VERTEX_PROGRAM_ARB, 1);
    context.glProgramStringARB(GL.VERTEX_PROGRAM_ARB, GL.PROGRAM_FORMAT_ASCII_ARB,
        putProgram(r, 0x3000, VERTEX_PROGRAM), 0x3000);
    context.glBindProgramARB(GL.FRAGMENT_PROGRAM_ARB, 2);
    context.glProgramStringARB(GL.FRAGMENT_PROGRAM_ARB, GL.PROGRAM_FORMAT_ASCII_ARB,
        putProgram(r, 0x4000, FRAGMENT_PROGRAM), 0x4000);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    context.glProgramEnvParameter4fARB(GL.VERTEX_PROGRAM_ARB, 2, [1, 0.5, 0.25, 1]);
    context.glProgramLocalParameter4fARB(GL.FRAGMENT_PROGRAM_ARB, 1, [0.25, 0.5, 0.75, 1]);
    context.glEnable(GL.VERTEX_PROGRAM_ARB);
    context.glEnable(GL.FRAGMENT_PROGRAM_ARB);
    r.words(0x2000, [0, 1, 2]);
}

test('a draw under both programs runs the emitted stages and fills their blocks', async()=>{
    const r = rig();
    programRig(r);
    const { context } = r;
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    await r.swap();

    const modules = r.gpu.of('createShaderModule')
        .filter(m=>/vertexProgram\.params/.test(m.descriptor.code));
    assert.equal(modules.length, 1, 'one module carries the program stages');
    const code = modules[0].descriptor.code;
    assert.match(code, /fn vertexMain\(vertex: VertexIn\) -> VertexOut/,
        'the vertex stage is the emitted one');
    assert.match(code, /fn fragmentMain\(input: VertexOut\)/,
        'and so is the fragment stage');
    assert.match(code, /textureSample\(t0Texture, t0Sampler, s\d+_0\.xy\)/);
    assert.match(code, /struct FragmentProgramUniforms/);

    // The layout carries both program blocks and the sampled unit's texture,
    // bound although its target was never enabled.
    const layout = r.gpu.of('createBindGroupLayout')
        .find(l=>l.descriptor.entries.some((/** @type {any} */ e)=>e.binding === 9));
    assert.ok(layout, 'a layout with the vertex program block');
    const bindings = layout.descriptor.entries.map((/** @type {any} */ e)=>e.binding);
    assert.ok(bindings.includes(10), 'the fragment program block');
    assert.ok(bindings.includes(1) && bindings.includes(2), 'unit zero samples anyway');

    // The vertex block: four MVP rows, then the env parameter. An orthographic
    // projection of 0..64 by 0..32 over an identity modelview.
    const vertexBlock = r.gpu.of('writeBuffer').find(w=>w.size === 20 * 4
        && /uniforms/.test(w.buffer.descriptor.label));
    assert.ok(vertexBlock, 'the vertex program block travelled');
    const vertexFloats = new Float32Array(vertexBlock.bytes.buffer,
        vertexBlock.bytes.byteOffset, 20);
    assert.equal(vertexFloats[0], 2 / 64, 'MVP row zero, x scale');
    assert.equal(vertexFloats[3], -1, 'MVP row zero, translation');
    assert.deepEqual([...vertexFloats.subarray(16, 20)], [1, 0.5, 0.25, 1],
        'the env parameter the program binds');
    const fragmentBlock = r.gpu.of('writeBuffer').find(w=>w.size === 4 * 4
        && /uniforms/.test(w.buffer.descriptor.label));
    assert.ok(fragmentBlock, 'the fragment program block travelled');
    const fragmentFloats = new Float32Array(fragmentBlock.bytes.buffer,
        fragmentBlock.bytes.byteOffset, 4);
    assert.deepEqual([...fragmentFloats], [0.25, 0.5, 0.75, 1],
        'the local parameter of the bound program object');
    assert.deepEqual(r.gpu.of('drawIndexed')[0].args, [3, 1, 0, 0]);
});

test('a re-specified program is a new pipeline', async()=>{
    const r = rig();
    programRig(r);
    const { context } = r;
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    await r.swap();
    const before = r.renderer.diagnostics().pipelines;
    // The same object with a new string: the key names the version, so the
    // next draw builds a pipeline rather than reusing the stale one.
    const second = `!!ARBfp1.0
TEMP texel;
PARAM scale = program.local[1];
TEX texel, fragment.texcoord[0], texture[0], 2D;
MUL result.color, texel, scale;
MOV result.depth, fragment.position.z;
END
`;
    context.glBindProgramARB(GL.FRAGMENT_PROGRAM_ARB, 2);
    context.glProgramStringARB(GL.FRAGMENT_PROGRAM_ARB, GL.PROGRAM_FORMAT_ASCII_ARB,
        putProgram(r, 0x4000, second), 0x4000);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    await r.swap();
    assert.equal(r.renderer.diagnostics().pipelines, before + 1,
        'the re-specified program compiled its own pipeline');
    const depths = r.gpu.of('createShaderModule')
        .filter(m=>/frag_depth/.test(m.descriptor.code));
    assert.equal(depths.length, 1, 'and the new stage writes depth');
});

test('a generic attribute array becomes a vertex buffer slot', async()=>{
    const r = rig();
    const { context } = r;
    for (let i = 0; i < 3; i++)
    {
        r.floats(0x1000 + i * 32, [i * 8, i * 4, 0]);
        r.floats(0x1000 + i * 32 + 12, [1, 0, 0, 1]);
    }
    context.glGenBuffersARB(1);
    context.glBindBufferARB(GL.ARRAY_BUFFER, 1);
    context.glBufferDataARB(GL.ARRAY_BUFFER, 3 * 32, 0x1000, GL.STATIC_DRAW);
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glVertexPointer(3, GL.FLOAT, 32, 0);
    context.glVertexAttribPointerARB(7, 4, GL.FLOAT, 0, 32, 12);
    context.glEnableVertexAttribArrayARB(7);
    context.glGenProgramsARB(1);
    context.glBindProgramARB(GL.VERTEX_PROGRAM_ARB, 1);
    const text = `!!ARBvp1.0
ATTRIB extra = vertex.attrib[7];
PARAM mvp[4] = { state.matrix.mvp };
TEMP clip;
DP4 clip.x, vertex.position, mvp[0];
DP4 clip.y, vertex.position, mvp[1];
DP4 clip.z, vertex.position, mvp[2];
DP4 clip.w, vertex.position, mvp[3];
MOV result.position, clip;
MOV result.color, extra;
END
`;
    context.glProgramStringARB(GL.VERTEX_PROGRAM_ARB, GL.PROGRAM_FORMAT_ASCII_ARB,
        putProgram(r, 0x3000, text), 0x3000);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    context.glEnable(GL.VERTEX_PROGRAM_ARB);
    r.words(0x2000, [0, 1, 2]);
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    await r.swap();

    const pipeline = r.gpu.of('createRenderPipeline')
        .find(p=>/vp1\./.test(p.descriptor.label));
    assert.ok(pipeline, 'the program draw built a pipeline');
    const attributes = pipeline.descriptor.vertex.buffers
        .flatMap((/** @type {any} */ b)=>b.attributes);
    const generic = attributes.some((/** @type {any} */ a)=>a.offset === 12
        && a.format === 'float32x4');
    assert.ok(generic, 'the generic array is bound as it lies, at its own offset');
    const code = r.gpu.of('createShaderModule')
        .find(m=>/attrib7: vec4<f32>/.test(m.descriptor.code)).descriptor.code;
    assert.match(code, /vertex\.attrib7/, 'and the stage reads it');
    assert.doesNotMatch(code, /vertexProgram\.attribs/,
        'an attribute with an array needs no current-value fallback');
});

test('a program draw on the processor path is reported and draws nothing', ()=>{
    const bytes = new Uint8Array(0x4000);
    /** @type {string[]} */
    const divergences = [];
    /** @type {any} */
    const context = createGlContext({
        memory: {
            read: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.subarray(at, at + n),
            write: (/** @type {number} */ at, /** @type {Uint8Array} */ v)=>bytes.set(v, at),
        },
        divergence: d=>divergences.push(d),
    });
    context.attach({ width: 8, height: 8, doubleBuffered: false });
    const text = '!!ARBfp1.0\nMOV result.color, fragment.color;\nEND\n';
    bytes.set(new TextEncoder().encode(text), 0x2000);
    context.glGenProgramsARB(1);
    context.glBindProgramARB(GL.FRAGMENT_PROGRAM_ARB, 1);
    context.glProgramStringARB(GL.FRAGMENT_PROGRAM_ARB, GL.PROGRAM_FORMAT_ASCII_ARB,
        text.length, 0x2000);
    context.glEnable(GL.FRAGMENT_PROGRAM_ARB);
    context.glBegin(GL.TRIANGLES);
    context.glVertex2f(0, 0);
    context.glVertex2f(4, 0);
    context.glVertex2f(4, 4);
    context.glEnd();
    assert.ok(divergences.some(d=>/draws nothing/.test(d)));
    assert.equal(context.framebuffer.bytes
        .some((/** @type {number} */ b)=>b !== 0), false);
});

// --- the draw dump, the cut, the skip and the probe ---

test('a dumped draw carries its state, its textures and its uniform blocks', async()=>{
    const r = rig({ dumpDraws: true });
    programRig(r);
    const { context } = r;
    context.glEnable(GL.BLEND);
    context.glBlendFunc(GL.ONE, GL.ONE);
    context.glEnable(GL.DEPTH_TEST);
    context.glDepthFunc(GL.EQUAL);
    context.glDepthMask(0);
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    await r.swap();

    const dump = r.renderer.diagnostics().lastDump;
    const line = dump.find(text=>text.startsWith('draw 0:'));
    assert.ok(line, 'the draw has a line');
    assert.match(line, /triangle-list count=3 first=0 base=0/);
    assert.match(line, new RegExp(`blend=0x1,0x1`), 'the additive blend, as the enums say');
    assert.match(line, /depth=0x202(?!\+write)/, 'GL_EQUAL, and the depth mask is off');
    assert.match(line, /tex=\[1:t1\]/, 'the fragment program samples t1 at binding 1');
    assert.match(line, /vp=p1\.1 fp=p2\.1/, 'both programs, by name and version');
    assert.match(line, /attrs=\[position@0\+0:float32x3 color@0\+12:float32x4/);
    assert.match(line, /vuni=\[[^\]]*0\.25[^\]]*\]/, 'the vertex block: the MVP, then env[2]');
    assert.match(line, /funi=\[0\.25 0\.5 0\.75 1\]/, 'the fragment block: local[1]');
    const text = dump.find(entry=>entry.startsWith('== vp1.1'));
    assert.ok(text && text.includes('!!ARBvp1.0'), 'the program text is printed once');
    assert.equal(dump.filter(entry=>entry.startsWith('== vp1.1')).length, 1);
    assert.match(dump[dump.length - 1], /^frame 0: draws=1 clears=0 copies=0 refused=0/);
});

test('a refused program draw is dumped with its reason and what was bound', async()=>{
    const r = rig({ dumpDraws: true });
    const { context } = r;
    context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, 1);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(4 * 4 * 4));
    context.glGenProgramsARB(1);
    context.glBindProgramARB(GL.FRAGMENT_PROGRAM_ARB, 1);
    // A state binding the GPU path has no value for: the stage refuses, the
    // draw is not issued, and the dump says so with the reason.
    const text = '!!ARBfp1.0\nPARAM mat = state.material.ambient;\n'
        + 'MUL result.color, fragment.color, mat;\nEND\n';
    context.glProgramStringARB(GL.FRAGMENT_PROGRAM_ARB, GL.PROGRAM_FORMAT_ASCII_ARB,
        putProgram(r, 0x4000, text), 0x4000);
    context.glEnable(GL.FRAGMENT_PROGRAM_ARB);
    context.glBegin(GL.TRIANGLES);
    context.glVertex2f(0, 0);
    context.glVertex2f(8, 0);
    context.glVertex2f(8, 8);
    context.glEnd();
    await r.swap();

    assert.equal(r.gpu.count('drawIndexed'), 0, 'nothing was issued');
    assert.equal(r.gpu.count('draw'), 1, 'the shown copy only');
    const dump = r.renderer.diagnostics().lastDump;
    const refused = dump.find(line=>line.startsWith('refused:'));
    assert.ok(refused, 'the refusal has a line');
    assert.match(refused, /state\.material\.ambient/);
    assert.match(refused, /fp=p1\.1/, 'the program it came from');
    assert.match(refused, /bound=\[0:t1/, 'and what the units held');
    assert.match(dump[dump.length - 1], /refused=1/);
    assert.ok(r.divergences.some(d=>/refused and drew nothing/.test(d)));
});

test('max-draws cuts a frame short and the dump counts the cut', async()=>{
    const r = rig({ dumpDraws: true, maxDraws: 1 });
    const { context } = r;
    context.glEnableClientState(GL.VERTEX_ARRAY);
    triangle(r, 0x1000);
    context.glVertexPointer(3, GL.FLOAT, STRIDE, 0x1000);
    context.glDrawArrays(GL.TRIANGLES, 0, 3);
    context.glDrawArrays(GL.TRIANGLES, 0, 3);
    context.glDrawArrays(GL.TRIANGLES, 0, 3);
    await r.swap();

    assert.equal(r.gpu.count('draw'), 2, 'the kept draw and the shown copy');
    assert.equal(r.renderer.diagnostics().cut, 2);
    const dump = r.renderer.diagnostics().lastDump;
    assert.match(dump[dump.length - 1], /draws=1.*cut=2/);
});

test('a skipped texture drops the draws that sample it and nothing else', async()=>{
    const r = rig({ dumpDraws: true, skipTexture: 't1' });
    programRig(r);
    const { context } = r;
    // The program draw samples t1 and goes; a plain untextured draw stays.
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    context.glDisable(GL.VERTEX_PROGRAM_ARB);
    context.glDisable(GL.FRAGMENT_PROGRAM_ARB);
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    await r.swap();

    assert.equal(r.renderer.diagnostics().skipped, 1);
    assert.equal(r.gpu.count('drawIndexed'), 1, 'only the draw that samples nothing');
    const dump = r.renderer.diagnostics().lastDump;
    assert.equal(dump.filter(line=>line.startsWith('draw ')).length, 1);
});

test('a probed texture reads the target before and after each of its draws', async()=>{
    const r = rig({ dumpDraws: true, probeTexture: 't1' });
    programRig(r);
    const { context } = r;
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    await r.swap();

    const line = r.renderer.diagnostics().lastDump.find(text=>text.startsWith('draw 0:'));
    assert.ok(line, 'the probed draw has a line');
    assert.match(line, /before=\d+\/\d+\/\d+(,\d+\/\d+\/\d+){6} distinct=\d+/);
    assert.match(line, /after=\d+\/\d+\/\d+(,\d+\/\d+\/\d+){6} distinct=\d+/,
        'the recording device keeps no texels, so both reads are zeroes of the right shape');
    const copies = r.gpu.of('copyTextureToBuffer');
    assert.equal(copies.length, 2, 'one read before the draw, one after');
    const drawn = r.gpu.calls.indexOf(r.gpu.of('drawIndexed')[0]);
    assert.ok(r.gpu.calls.indexOf(copies[0]) < drawn && drawn < r.gpu.calls.indexOf(copies[1]),
        'and the draw sits between the two reads');
});
