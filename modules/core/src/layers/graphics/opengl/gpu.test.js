/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { FRAGMENT_PROGRAM_BINDING, VERTEX_PROGRAM_BINDING } from './arb-wgsl.js';import { createGlContext } from './context.js';
import { createGpuRenderer, describeSnapshot } from './gpu.js';
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
/**
 * The uniform blocks the draws were given, in the order they were bound: each
 * as the ring holds it once the frame is submitted, since the blocks reach the
 * ring in one write per frame rather than a write each.
 *
 * @param {{ gpu: any }} r
 * @returns {{ buffer: any, bytes: Uint8Array, size: number }[]}
 */
function uniformBlocks(r){
    return r.gpu.of('setBindGroup')
        .flatMap((/** @type {any} */ call)=>call.resolved)
        .filter((/** @type {any} */ block)=>/uniforms/.test(block.buffer.descriptor.label))
        .map((/** @type {any} */ block)=>({
            buffer: block.buffer, bytes: block.range, size: block.size,
        }));
}

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

test('a buffer object given other sizes keeps one GPU copy while it fits and lets an outgrown or '
    + 'deleted one go once its frame is submitted', async()=>{
    const r = rig();
    const { context } = r;
    triangle(r, 0x1000);
    triangle(r, 0x1000 + 3 * STRIDE);
    context.glGenBuffersARB(1);
    context.glBindBufferARB(GL.ARRAY_BUFFER, 1);
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glEnableClientState(GL.TEXTURE_COORD_ARRAY);
    context.glVertexPointer(3, GL.FLOAT, STRIDE, 0);
    context.glTexCoordPointer(2, GL.FLOAT, STRIDE, 12);
    r.words(0x2000, [0, 1, 2]);
    const copies = ()=>r.gpu.of('createBuffer')
        .filter(call=>/^gl-buffer:1#/.test(call.descriptor.label)).map(call=>call.createBuffer);
    const destroyed = ()=>new Set(r.gpu.of('destroy').map(call=>call.buffer));
    /** @param {number} size */
    const drawWith = async size=>{
        context.glBufferDataARB(GL.ARRAY_BUFFER, size, 0x1000, GL.STATIC_DRAW);
        context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
        await r.swap();
    };
    await drawWith(3 * STRIDE);
    assert.equal(copies().length, 1);
    await drawWith(6 * STRIDE);
    assert.equal(copies().length, 2, 'outgrown: a second copy');
    await r.swap();
    assert.ok(destroyed().has(copies()[0]), 'and the first one gone once its frame was submitted');
    await drawWith(3 * STRIDE);
    await drawWith(5 * STRIDE);
    assert.equal(copies().length, 2, 'smaller sizes fit the copy there is');
    context.glDeleteBuffersARB([1]);
    await r.swap();
    await r.swap();
    assert.ok(copies().every(copy=>destroyed().has(copy)), 'deleted: every copy gone');
    assert.equal(r.renderer.diagnostics().fallbacks, 0);
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

test('a repeated draw from an index buffer hits the scan cache; a rewritten buffer misses',
    async()=>{
        const r = rig();
        const { context } = r;
        triangle(r, 0x1000);
        const [vbo] = context.glGenBuffersARB(1);
        context.glBindBufferARB(GL.ARRAY_BUFFER, vbo);
        context.glBufferDataARB(GL.ARRAY_BUFFER, 3 * STRIDE, 0x1000, GL.STATIC_DRAW);
        context.glEnableClientState(GL.VERTEX_ARRAY);
        context.glVertexPointer(3, GL.FLOAT, STRIDE, 0);
        r.words(0x2000, [0, 1, 2]);
        const [ibo] = context.glGenBuffersARB(1);
        context.glBindBufferARB(GL.ELEMENT_ARRAY_BUFFER, ibo);
        context.glBufferDataARB(GL.ELEMENT_ARRAY_BUFFER, 3 * 4, 0x2000, GL.STATIC_DRAW);

        // A static mesh drawn under several lights: the same buffer, the
        // same offset and count, draw after draw.
        context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0);
        context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0);
        await r.swap();
        let diag = r.renderer.diagnostics();
        assert.equal(diag.indexScansBuilt, 1, 'the first draw scans the index buffer');
        assert.equal(diag.indexScansReused, 1, 'the second, unchanged, hits the cache');

        r.words(0x2000, [2, 1, 0]);
        context.glBufferSubDataARB(GL.ELEMENT_ARRAY_BUFFER, 0, 3 * 4, 0x2000);
        context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0);
        await r.swap();
        diag = r.renderer.diagnostics();
        assert.equal(diag.indexScansBuilt, 2, 'a rewritten buffer is scanned again');
        assert.equal(diag.indexScansReused, 1, 'unchanged since the rebuild');
    });

test('two draws under unchanged state whose index ranges are adjacent join into one',
    async()=>{
        const r = rig();
        const { context } = r;
        triangle(r, 0x1000);
        triangle(r, 0x1000 + 3 * STRIDE);
        const [vbo] = context.glGenBuffersARB(1);
        context.glBindBufferARB(GL.ARRAY_BUFFER, vbo);
        context.glBufferDataARB(GL.ARRAY_BUFFER, 6 * STRIDE, 0x1000, GL.STATIC_DRAW);
        context.glEnableClientState(GL.VERTEX_ARRAY);
        context.glVertexPointer(3, GL.FLOAT, STRIDE, 0);
        r.words(0x2000, [0, 1, 2, 3, 4, 5]);
        const [ibo] = context.glGenBuffersARB(1);
        context.glBindBufferARB(GL.ELEMENT_ARRAY_BUFFER, ibo);
        context.glBufferDataARB(GL.ELEMENT_ARRAY_BUFFER, 6 * 4, 0x2000, GL.STATIC_DRAW);

        // Two sub-ranges of the same mesh, back to back, under state that
        // never changes between them -- what a surface split across two
        // glDrawElements calls looks like.
        context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0);
        context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 12);
        await r.swap();

        const diag = r.renderer.diagnostics();
        assert.equal(diag.draws, 1, 'one draw call, not two');
        assert.equal(diag.merged, 1);
        const indexed = r.gpu.of('drawIndexed');
        assert.equal(indexed.length, 1, 'the replay issued one drawIndexed');
        assert.deepEqual(indexed[0].args, [6, 1, 0, 0],
            'the joined draw covers both ranges: six indices from the first one\'s offset');
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

    const uniforms = uniformBlocks(r).filter(w=>/uniforms/.test(w.buffer.descriptor.label));
    // The show copy's block is the last write; the draw's is the one before.
    const block = new Float32Array(uniforms[uniforms.length - 2].bytes.buffer,
        uniforms[uniforms.length - 2].bytes.byteOffset, UNIFORM.floats);
    // An orthographic projection of 0..64 by 0..32: x scales by 2/64.
    assert.equal(block[UNIFORM.modelViewProjection], 2 / 64);
    assert.deepEqual([...block.subarray(UNIFORM.color, UNIFORM.color + 4)], [0.25, 0.5, 0.75, 1]);
    assert.equal(block[UNIFORM.misc], 0.5);
});

test('two draws with unchanged state share the fixed uniform block; a changed one rebuilds it',
    async()=>{
        const r = rig();
        const { context } = r;
        const draw = ()=>{
            context.glBegin(GL.TRIANGLES);
            context.glVertex2f(0, 0);
            context.glVertex2f(8, 0);
            context.glVertex2f(8, 8);
            context.glEnd();
        };
        context.glColor4f(0.25, 0.5, 0.75, 1);
        draw();
        draw();
        await r.swap();
        let diag = r.renderer.diagnostics();
        assert.equal(diag.uniformsBuilt, 1, 'the first draw builds the block');
        assert.equal(diag.uniformsReused, 1, 'the second, unchanged, reuses it');

        context.glColor4f(0, 1, 0, 1);
        draw();
        await r.swap();
        diag = r.renderer.diagnostics();
        assert.equal(diag.uniformsBuilt, 2, 'a changed current colour rebuilds it');
        assert.equal(diag.uniformsReused, 1, 'unchanged from the rebuild');

        // A matrix reloaded with the same sixteen values is the same matrix:
        // a program drawing a screen's text loads one per glyph.
        const same = Float32Array.from(context.glGetFloatv(GL.MODELVIEW_MATRIX));
        context.glLoadMatrixf(same);
        draw();
        await r.swap();
        diag = r.renderer.diagnostics();
        assert.equal(diag.uniformsBuilt, 2, 'the same matrix reloaded rebuilds nothing');
        assert.equal(diag.uniformsReused, 2, 'and the block is reused');

        const uniforms = uniformBlocks(r)
            .filter(w=>/uniforms/.test(w.buffer.descriptor.label));
        // The show copy's block is the last write of each swap; the draw's is
        // the one before it.
        const last = new Float32Array(uniforms[uniforms.length - 2].bytes.buffer,
            uniforms[uniforms.length - 2].bytes.byteOffset, UNIFORM.floats);
        assert.deepEqual([...last.subarray(UNIFORM.color, UNIFORM.color + 4)], [0, 1, 0, 1],
            'the rendered draw record carries the new colour, not a stale reused one');
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

test('a sampler is read off the texture, not rebuilt from a descriptor every draw', async()=>{
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
    // The first draw with this texture builds and caches the sampler; the
    // repeats below are what the test pins.
    draw();
    const stringify = JSON.stringify;
    let calls = 0;
    JSON.stringify = /** @type {typeof JSON.stringify} */ ((value, replacer, space)=>{
        calls++;
        return stringify(value, /** @type {any} */ (replacer), space);
    });
    try
    {
        draw();
        draw();
        draw();
    }
    finally
    {
        JSON.stringify = stringify;
    }
    await r.swap();
    assert.equal(calls, 0,
        'the sampler comes from the texture\'s own cache, not a JSON key built per draw');
});

test('a texture\'s sampler is rebuilt only when its filter or wrap parameters change', async()=>{
    const r = rig();
    const { context } = r;
    context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, 1);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.NEAREST);
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
    await r.swap();
    const samplerOf = ()=>r.gpu.of('createBindGroup').at(-1).descriptor.entries
        .find((/** @type {any} */ e)=>e.binding === 2).resource;
    const first = samplerOf();
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    draw();
    await r.swap();
    const second = samplerOf();
    assert.notEqual(first, second,
        'the parameters version moved, so the cached sampler was not reused');
});

test('a sampled texture\'s id string is built only for a skip filter or a dump', async()=>{
    const r = rig();
    const { context } = r;
    context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, 1);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(4 * 4 * 4).fill(0x80));
    context.glEnable(GL.TEXTURE_2D);
    const draw = ()=>{
        context.glBegin(GL.TRIANGLES);
        context.glVertex2f(0, 0);
        context.glVertex2f(8, 0);
        context.glVertex2f(8, 8);
        context.glEnd();
    };
    // The first draw creates the GPU texture record, whose label reads the
    // name once; only reads after that are the ones this test pins.
    draw();
    const texture = context.shareGroup.textures.objects.get(1);
    const value = texture.name;
    let reads = 0;
    Object.defineProperty(texture, 'name', {
        get(){
            reads++;
            return value;
        },
        configurable: true,
    });
    draw();
    assert.equal(reads, 0,
        'no skip filter and no dump were asked for: the id string was never built');
});

test('a DXT5 level reaches the upload decoded, its alpha per texel intact', async()=>{
    // The bump map of a per-light interaction program is an rxgb S3TC image:
    // the normal's x lives in the alpha block, so a decode or an upload that
    // conforms alpha to one turns every normal's x into +1 and flips the sign
    // of the half whose light has a negative x. Nothing between
    // glCompressedTexImage2DARB and backend.uploadTexture may do that.
    const r = rig();
    const { context } = r;
    const indices = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7];
    const block = new Uint8Array(16);
    block[0] = 255;
    block[1] = 0;
    for (let i = 0; i < 16; i++)
    {
        const bit = i * 3;
        block[2 + (bit >> 3)] |= (indices[i] & 7) << (bit & 7);
        if ((bit & 7) > 5)
        {
            block[3 + (bit >> 3)] |= (indices[i] & 7) >> (8 - (bit & 7));
        }
    }
    const view = new DataView(block.buffer);
    view.setUint16(8, 0xf800, true);
    view.setUint16(10, 0x001f, true);
    view.setUint32(12, 0, true);
    context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, 1);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    context.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0,
        GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, 4, 4, 0, 16, block);
    assert.equal(context.glGetError(), GL.NO_ERROR, 'the compressed level loaded');
    context.glEnable(GL.TEXTURE_2D);
    context.glBegin(GL.TRIANGLES);
    context.glVertex2f(0, 0);
    context.glVertex2f(8, 0);
    context.glVertex2f(8, 8);
    context.glEnd();
    await r.swap();

    const level = context.shareGroup.textures.objects.get(1).levels.get(0);
    assert.equal(level.baseFormat, GL.RGBA, 'the level keeps the four components of DXT5');
    assert.equal(level.compressedFormat, GL.COMPRESSED_RGBA_S3TC_DXT5_EXT);
    assert.deepEqual([...level.texels.subarray(3, 4)], [255], 'texel 0: table index 0');
    assert.deepEqual([...level.texels.subarray(7, 8)], [0], 'texel 1: table index 1');
    const upload = r.gpu.of('writeTexture').find(w=>w.destination.origin.z === 0
        && w.destination.origin.x === 0);
    assert.ok(upload, 'the level was uploaded');
    assert.equal(upload.bytes[3], 255, 'the uploaded alpha byte is the table value, texel 0');
    assert.equal(upload.bytes[7], 0, 'and texel 1\'s');
    assert.equal(upload.bytes[11], 219, 'and texel 2\'s interpolated value');
    assert.deepEqual([...upload.bytes.subarray(0, 3)], [255, 0, 0],
        'the colour block is untouched by the alpha decode');
});

test('a DXT5 texture with the device compressed and every level kept travels as blocks',
    async()=>{
        const r = rig({ compressedTextures: true });
        const { context } = r;
        const block = new Uint8Array(16).fill(7);
        context.glGenTextures(1);
        context.glBindTexture(GL.TEXTURE_2D, 1);
        context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
        context.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0,
            GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, 4, 4, 0, 16, block);
        assert.equal(context.glGetError(), GL.NO_ERROR, 'the compressed level loaded');
        context.glEnable(GL.TEXTURE_2D);
        context.glBegin(GL.TRIANGLES);
        context.glVertex2f(0, 0);
        context.glVertex2f(8, 0);
        context.glVertex2f(8, 8);
        context.glEnd();
        await r.swap();

        const surface = r.gpu.of('createTexture')
            .find(c=>/gl-texture:1/.test(c.descriptor.label));
        assert.equal(surface.descriptor.format, 'bc3-rgba-unorm', 'the surface itself is BC3');
        assert.equal(surface.descriptor.usage & r.backend.TextureUsage.RENDER_ATTACHMENT, 0,
            'a compressed surface never asks WebGPU for a render attachment usage');
        assert.equal(r.gpu.of('writeTexture').length, 0, 'no decoded, unstaged upload happened');
        // Padded to the copy's row-pitch alignment; the block itself is the
        // first sixteen bytes, unpadded and undecoded.
        const staged = r.gpu.of('writeBuffer').find(w=>w.bytes[0] === 7 && w.bytes[15] === 7);
        assert.ok(staged, 'the sixteen compressed bytes travelled, undecoded, through staging');
        const copy = r.gpu.of('copyBufferToTexture')
            .find(c=>c.destination.texture === surface.texture);
        assert.ok(copy, 'and were copied into the BC surface');
        assert.deepEqual(copy.size, { width: 4, height: 4, depthOrArrayLayers: 1 });
    });

test('a DXT5 tail mip copies its block-rounded extent, not its own 2x2 or 1x1 size',
    async()=>{
        const r = rig({ compressedTextures: true });
        const { context } = r;
        const block = new Uint8Array(16).fill(7);
        context.glGenTextures(1);
        context.glBindTexture(GL.TEXTURE_2D, 1);
        context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
        context.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0,
            GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, 4, 4, 0, 16, block);
        context.glCompressedTexImage2DARB(GL.TEXTURE_2D, 1,
            GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, 2, 2, 0, 16, block);
        context.glCompressedTexImage2DARB(GL.TEXTURE_2D, 2,
            GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, 1, 1, 0, 16, block);
        context.glEnable(GL.TEXTURE_2D);
        context.glBegin(GL.TRIANGLES);
        context.glVertex2f(0, 0);
        context.glVertex2f(8, 0);
        context.glVertex2f(8, 8);
        context.glEnd();
        await r.swap();

        const surface = r.gpu.of('createTexture')
            .find(c=>/gl-texture:1/.test(c.descriptor.label));
        const copies = r.gpu.of('copyBufferToTexture')
            .filter(c=>c.destination.texture === surface.texture);
        assert.equal(copies.length, 3, 'all three levels travelled through staging');
        const level1 = copies.find(c=>c.destination.mipLevel === 1);
        const level2 = copies.find(c=>c.destination.mipLevel === 2);
        assert.deepEqual(level1.size, { width: 4, height: 4, depthOrArrayLayers: 1 },
            'a 2x2 level\'s copySize is the block it physically occupies');
        assert.deepEqual(level2.size, { width: 4, height: 4, depthOrArrayLayers: 1 },
            'and a 1x1 level\'s likewise');
    });

test('a DXT1 base level narrower than one block decodes, a whole-block one takes the BC path',
    async()=>{
        const narrow = rig({ compressedTextures: true });
        const wide = rig({ compressedTextures: true });
        // Both a 2-wide and a 4-wide base round up to one column of blocks,
        // so both need the same 16 rows-of-blocks worth of compressed bytes.
        const block = new Uint8Array(128).fill(7);
        /** @param {ReturnType<typeof rig>} r @param {number} width */
        const upload = (r, width)=>{
            const { context } = r;
            context.glGenTextures(1);
            context.glBindTexture(GL.TEXTURE_2D, 1);
            context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
            context.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0,
                GL.COMPRESSED_RGBA_S3TC_DXT1_EXT, width, 64, 0, 128, block);
            context.glEnable(GL.TEXTURE_2D);
            context.glBegin(GL.TRIANGLES);
            context.glVertex2f(0, 0);
            context.glVertex2f(8, 0);
            context.glVertex2f(8, 8);
            context.glEnd();
            return r.swap();
        };
        await upload(narrow, 2);
        await upload(wide, 4);

        const narrowSurface = narrow.gpu.of('createTexture')
            .find(c=>/gl-texture:1/.test(c.descriptor.label));
        assert.equal(narrowSurface.descriptor.format, 'rgba8unorm',
            'a 2-wide base is narrower than one block, so WebGPU refuses it as compressed');
        assert.equal(narrow.gpu.of('copyBufferToTexture').length, 0,
            'no staged, undecoded copy happened');
        assert.equal(narrow.gpu.of('writeTexture').length, 1,
            'the level travelled decoded instead');

        const wideSurface = wide.gpu.of('createTexture')
            .find(c=>/gl-texture:1/.test(c.descriptor.label));
        assert.equal(wideSurface.descriptor.format, 'bc1-rgba-unorm',
            'a 4-wide base is a whole block: it still takes the BC path');
        assert.equal(wide.gpu.of('writeTexture').length, 0, 'no decoded, unstaged upload happened');
    });

test('a sub-image write into a kept level falls that texture back to the decoded path',
    async()=>{
        const r = rig({ compressedTextures: true });
        const { context } = r;
        const block = new Uint8Array(16).fill(7);
        context.glGenTextures(1);
        context.glBindTexture(GL.TEXTURE_2D, 1);
        context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
        context.glCompressedTexImage2DARB(GL.TEXTURE_2D, 0,
            GL.COMPRESSED_RGBA_S3TC_DXT5_EXT, 4, 4, 0, 16, block);
        context.glTexSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE,
            Uint8Array.from([1, 2, 3, 4]));
        context.glEnable(GL.TEXTURE_2D);
        context.glBegin(GL.TRIANGLES);
        context.glVertex2f(0, 0);
        context.glVertex2f(8, 0);
        context.glVertex2f(8, 8);
        context.glEnd();
        await r.swap();

        const surface = r.gpu.of('createTexture')
            .find(c=>/gl-texture:1/.test(c.descriptor.label));
        assert.equal(surface.descriptor.format, 'rgba8unorm',
            'the rewritten level has no blocks to keep, so the whole texture falls back');
    });

test('with the depth test off a draw writes no depth, whatever the depth mask', async()=>{
    // glEnable(GL_DEPTH_TEST): "even if the depth buffer exists and the depth
    // mask is non-zero, the depth buffer is not updated if the depth test is
    // disabled". WebGPU writes under an 'always' compare, so the write has to
    // go off with the test.
    /** @param {boolean} tested */
    const drawWith = async tested=>{
        const r = rig();
        const { context } = r;
        if (tested)
        {
            context.glEnable(GL.DEPTH_TEST);
        }
        context.glDepthMask(1);
        context.glBegin(GL.TRIANGLES);
        context.glVertex2f(0, 0);
        context.glVertex2f(8, 0);
        context.glVertex2f(8, 8);
        context.glEnd();
        await r.swap();
        return r.gpu.of('createRenderPipeline')[0].descriptor.depthStencil;
    };

    const off = await drawWith(false);
    assert.equal(off.depthCompare, 'always');
    assert.equal(off.depthWriteEnabled, false);
    assert.equal((await drawWith(true)).depthWriteEnabled, true,
        'with the test on, the write is the mask');
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

test('a depth range run backwards is the viewport\'s range with the depth turned round',
    async()=>{
        // GL allows glDepthRange(1, 0); a WebGPU viewport must have its
        // minimum depth at or below its maximum, or the pass is invalid.
        const r = rig();
        const { context } = r;
        context.glDepthRange(0.9, 0.1);
        context.glBegin(GL.TRIANGLES);
        context.glVertex2f(0, 0);
        context.glVertex2f(8, 0);
        context.glVertex2f(8, 8);
        context.glEnd();
        await r.swap();
        const viewport = r.gpu.of('setViewport').map(c=>c.rect)
            .find(rect=>rect[4] !== 0 || rect[5] !== 1);
        assert.deepEqual(viewport?.slice(4), [0.1, 0.9]);
        const uniforms = uniformBlocks(r).filter(w=>/uniforms/.test(w.buffer.descriptor.label));
        const block = new Float32Array(uniforms[uniforms.length - 2].bytes.buffer,
            uniforms[uniforms.length - 2].bytes.byteOffset, UNIFORM.floats);
        assert.equal(block[UNIFORM.misc + 1], -1, 'the vertex stage turns the depth round');

        context.glDepthRange(0.1, 0.9);
        context.glBegin(GL.TRIANGLES);
        context.glVertex2f(0, 0);
        context.glVertex2f(8, 0);
        context.glVertex2f(8, 8);
        context.glEnd();
        await r.swap();
        const again = uniformBlocks(r).filter(w=>/uniforms/.test(w.buffer.descriptor.label));
        const forward = new Float32Array(again[again.length - 2].bytes.buffer,
            again[again.length - 2].bytes.byteOffset, UNIFORM.floats);
        assert.equal(forward[UNIFORM.misc + 1], 1, 'and leaves a forward range alone');
    });

test('a read of the framebuffer on the device path is reported, not answered', ()=>{
    const r = rig();
    const { context } = r;
    context.glReadPixels(0, 0, 2, 2, GL.RGBA, GL.UNSIGNED_BYTE, 0x3000);
    assert.ok(r.divergences.some(d=>/glReadPixels was accepted and read black/.test(d)));
});

test('the stencil test on the device path is not reported: the depth attachment carries it',
    ()=>{
        const r = rig();
        const { context } = r;
        context.glEnable(GL.STENCIL_TEST);
        assert.equal(r.divergences.some(d=>/stencil buffer/.test(d)), false);
    });

/** @param {ReturnType<typeof rig>} r a triangle, drawn under whatever stencil state is set */
async function drawTriangle(r){
    const { context } = r;
    context.glBegin(GL.TRIANGLES);
    context.glVertex2f(0, 0);
    context.glVertex2f(8, 0);
    context.glVertex2f(8, 8);
    context.glEnd();
    await r.swap();
}

test('GL_EXT_stencil_two_side: a back record set while the two-sided enable is off never '
    + 'reaches a draw -- the scene mirrors the front', async()=>{
    const r = rig();
    const { context } = r;
    context.glEnable(GL.STENCIL_TEST);
    context.glStencilFunc(GL.GEQUAL, 3, 0xff);
    context.glStencilOp(GL.KEEP, GL.KEEP, GL.REPLACE);
    // Selecting the back face and giving it different ops is legal with
    // GL_STENCIL_TEST_TWO_SIDE_EXT off (the selector does not depend on the
    // enable), but a draw's test only ever consults the front while it is
    // off, so this must never be what a pipeline is built from.
    context.glActiveStencilFaceEXT(GL.BACK);
    context.glStencilFunc(GL.ALWAYS, 9, 0xff);
    context.glStencilOp(GL.KEEP, GL.KEEP, GL.INCR_WRAP);
    context.glActiveStencilFaceEXT(GL.FRONT);
    await drawTriangle(r);
    const pipeline = r.gpu.of('createRenderPipeline')
        .find(p=>p.descriptor.depthStencil.stencilFront.compare === 'greater-equal');
    assert.ok(pipeline, 'the front ops reached a pipeline');
    assert.deepEqual(pipeline.descriptor.depthStencil.stencilBack,
        pipeline.descriptor.depthStencil.stencilFront,
        'the back face the draw never enabled must not carry the ops set on GL_BACK');
});

test('GL_EXT_stencil_two_side: a differing reference is not reported when the back face '
    + 'never reads it', async()=>{
    const r = rig();
    const { context } = r;
    context.glEnable(GL.STENCIL_TEST);
    context.glEnable(GL.STENCIL_TEST_TWO_SIDE_EXT);
    context.glStencilFunc(GL.GEQUAL, 5, 0xff);
    context.glActiveStencilFaceEXT(GL.BACK);
    context.glStencilFunc(GL.ALWAYS, 0, 0xff);
    await drawTriangle(r);
    assert.equal(r.divergences.some(d=>/different reference or mask/.test(d)), false,
        'GL_ALWAYS with the default KEEP ops never reads its reference');
});

test('GL_EXT_stencil_two_side: a differing reference the back face does read is reported',
    async()=>{
        const r = rig();
        const { context } = r;
        context.glEnable(GL.STENCIL_TEST);
        context.glEnable(GL.STENCIL_TEST_TWO_SIDE_EXT);
        context.glStencilFunc(GL.GEQUAL, 5, 0xff);
        context.glActiveStencilFaceEXT(GL.BACK);
        context.glStencilFunc(GL.GEQUAL, 9, 0xff);
        await drawTriangle(r);
        assert.ok(r.divergences.some(d=>/different reference or mask/.test(d)));
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
    const block = uniformBlocks(r)
        .find(w=>/uniforms/.test(w.buffer.descriptor.label)
            && w.size === COPY_UNIFORM_FLOATS * 4);
    assert.ok(block, 'the copy wrote a uniform block');
    const floats = new Float32Array(block.bytes.buffer, block.bytes.byteOffset,
        COPY_UNIFORM_FLOATS);
    return [...floats.subarray(0, 6)];
}

/**
 * A texture with an 8x8 RGBA level, drawn once so the define itself is
 * uploaded.
 *
 * @param {ReturnType<typeof rig>} r
 * @returns {Promise<() => void>} draws the triangle again
 */
async function definedTexture(r){
    const { context } = r;
    context.glGenTextures(1);
    context.glBindTexture(GL.TEXTURE_2D, 1);
    context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 8, 8, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(8 * 8 * 4));
    context.glEnable(GL.TEXTURE_2D);
    const draw = ()=>{
        context.glBegin(GL.TRIANGLES);
        context.glVertex2f(0, 0);
        context.glVertex2f(8, 0);
        context.glVertex2f(8, 8);
        context.glEnd();
    };
    draw();
    await r.swap();
    return draw;
}

test('a sub-image write uploads only its rectangle, at its own origin', async()=>{
    const r = rig();
    const { context } = r;
    const draw = await definedTexture(r);

    context.glTexSubImage2D(GL.TEXTURE_2D, 0, 2, 3, 4, 2, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(4 * 2 * 4).fill(9));
    draw();
    await r.swap();

    const uploads = r.gpu.of('writeTexture').filter(w=>w.destination.mipLevel === 0);
    assert.equal(uploads.length, 2, 'the full define, then the rectangle alone');
    const sub = uploads[1];
    assert.deepEqual([sub.destination.origin.x, sub.destination.origin.y], [2, 3]);
    assert.equal(sub.bytes.length, 4 * 2 * 4, 'only the rectangle\'s bytes, not the whole level');
});

test('a sub-image write after a draw sampled the texture reaches only the draws after it',
    async()=>{
        // Each draw samples the texels as they stood when it was made. The
        // queue runs a direct write before a frame not yet flushed, so a
        // write after a draw of that frame keeps its place in it.
        const r = rig();
        const { context } = r;
        const draw = await definedTexture(r);
        const order = ()=>r.gpu.calls.map((/** @type {any} */ call)=>call.op)
            .filter((/** @type {string} */ op)=>/^(writeTexture|copyBufferToTexture|draw|submit)$/
                .test(op));
        /** @param {number} value */
        const write = value=>context.glTexSubImage2D(GL.TEXTURE_2D, 0, 0, 0, 2, 2, GL.RGBA,
            GL.UNSIGNED_BYTE, new Uint8Array(2 * 2 * 4).fill(value));
        const before = order().length;

        draw();
        write(1);
        draw();
        await r.swap();
        assert.deepEqual(order().slice(before),
            ['draw', 'copyBufferToTexture', 'draw', 'draw', 'submit'],
            'the write lands between the two draws (the last draw shows the frame)');

        // The next frame is recorded before this one is flushed.
        draw();
        r.renderer.present(context);
        write(2);
        draw();
        await r.swap();
        assert.deepEqual(order().slice(before + 5),
            ['draw', 'draw', 'submit', 'copyBufferToTexture', 'draw', 'draw', 'submit'],
            'a frame still waiting for the queue does not see the next frame\'s write');

        write(3);
        draw();
        await r.swap();
        assert.deepEqual(order().slice(before + 12), ['writeTexture', 'draw', 'draw', 'submit'],
            'once nothing unflushed samples it, a write goes straight to the queue');
    });

test('two overlapping sub-image writes upload their union once', async()=>{
    const r = rig();
    const { context } = r;
    const draw = await definedTexture(r);

    context.glTexSubImage2D(GL.TEXTURE_2D, 0, 1, 1, 3, 3, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(3 * 3 * 4).fill(1));
    context.glTexSubImage2D(GL.TEXTURE_2D, 0, 2, 2, 3, 3, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(3 * 3 * 4).fill(2));
    draw();
    await r.swap();

    const uploads = r.gpu.of('writeTexture').filter(w=>w.destination.mipLevel === 0);
    assert.equal(uploads.length, 2, 'the full define, then one upload of the union');
    const union = uploads[1];
    // (1,1) 3x3 and (2,2) 3x3 -> (1,1) 4x4.
    assert.deepEqual([union.destination.origin.x, union.destination.origin.y], [1, 1]);
    assert.equal(union.bytes.length, 4 * 4 * 4);
});

test('a full redefine after a sub-write uploads the whole level again', async()=>{
    const r = rig();
    const { context } = r;
    const draw = await definedTexture(r);

    context.glTexSubImage2D(GL.TEXTURE_2D, 0, 2, 3, 1, 1, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(4).fill(9));
    context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 8, 8, 0, GL.RGBA, GL.UNSIGNED_BYTE,
        new Uint8Array(8 * 8 * 4));
    draw();
    await r.swap();

    const uploads = r.gpu.of('writeTexture').filter(w=>w.destination.mipLevel === 0);
    assert.equal(uploads.length, 2, 'the original define, then the redefine');
    assert.equal(uploads[1].bytes.length, 8 * 8 * 4, 'the redefine sent the whole level');
});

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
    const bindGroupLayouts = r.gpu.of('createBindGroupLayout');
    /** @param {number} binding */
    const withBinding = binding=>bindGroupLayouts.find(l=>l.descriptor.entries
        .some((/** @type {any} */ e)=>e.binding === binding));
    const vertexLayout = withBinding(VERTEX_PROGRAM_BINDING);
    const fragmentLayout = withBinding(FRAGMENT_PROGRAM_BINDING);
    assert.ok(vertexLayout, 'a layout with the vertex program block');
    assert.ok(fragmentLayout, 'a layout with the fragment program block');
    const fixedLayout = withBinding(0);
    assert.equal(vertexLayout, fixedLayout,
        'the vertex block shares the fixed group, the only group its stage reads');
    assert.notEqual(fragmentLayout, fixedLayout,
        'the fragment block gets a group the fragment stage reads alone');
    const fixedBindings = fixedLayout.descriptor.entries
        .map((/** @type {any} */ e)=>e.binding);
    assert.ok(fixedBindings.includes(1) && fixedBindings.includes(2),
        'unit zero samples out of the fixed group');

    // The vertex block: four MVP rows, then the env parameter. An orthographic
    // projection of 0..64 by 0..32 over an identity modelview.
    const vertexBlock = uniformBlocks(r).find(w=>w.size === 20 * 4
        && /uniforms/.test(w.buffer.descriptor.label));
    assert.ok(vertexBlock, 'the vertex program block travelled');
    const vertexFloats = new Float32Array(vertexBlock.bytes.buffer,
        vertexBlock.bytes.byteOffset, 20);
    assert.equal(vertexFloats[0], 2 / 64, 'MVP row zero, x scale');
    assert.equal(vertexFloats[3], -1, 'MVP row zero, translation');
    assert.deepEqual([...vertexFloats.subarray(16, 20)], [1, 0.5, 0.25, 1],
        'the env parameter the program binds');
    const fragmentBlock = uniformBlocks(r).find(w=>w.size === 4 * 4
        && /uniforms/.test(w.buffer.descriptor.label));
    assert.ok(fragmentBlock, 'the fragment program block travelled');
    const fragmentFloats = new Float32Array(fragmentBlock.bytes.buffer,
        fragmentBlock.bytes.byteOffset, 4);
    assert.deepEqual([...fragmentFloats], [0.25, 0.5, 0.75, 1],
        'the local parameter of the bound program object');
    assert.deepEqual(r.gpu.of('drawIndexed')[0].args, [3, 1, 0, 0]);
});

test('the MVP product is computed once per draw and shared with a program that reads it',
    async()=>{
        // The vertex program above binds all four rows of state.matrix.mvp;
        // the fixed block's own modelViewProjection uniform needs the same
        // product. A matrix is a view of sixteen carved out of a block
        // (`matrix.js`'s `matrix()`), which is what `multiply` (and only
        // `multiply`, on this path) allocates its result as, so counting
        // those across one draw counts the multiplies.
        const r = rig();
        programRig(r);
        const { context } = r;
        const RealFloat64Array = globalThis.Float64Array;
        let mvpSizedAllocations = 0;
        globalThis.Float64Array = /** @type {any} */ (class extends RealFloat64Array {
            constructor(/** @type {any[]} */ ...args){
                // @ts-ignore -- a spread onto the real constructor's overloads
                super(...args);
                if (args.length === 3 && args[2] === 16)
                {
                    mvpSizedAllocations++;
                }
            }
        });
        try
        {
            context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
        }
        finally
        {
            globalThis.Float64Array = RealFloat64Array;
        }
        await r.swap();
        assert.equal(mvpSizedAllocations, 1,
            'one MVP product per draw, shared with the vertex program\'s four mvp rows');
    });

test('a repeated draw state generates its source once and reuses it', async()=>{
    // A frame repeats one state for a hundred shadow-volume draws. The
    // pipeline cache already keyed the built pipeline by that state; the
    // source it was built from was emitted again for every draw, which is
    // per-draw work for a state that did not change.
    const r = rig();
    programRig(r);
    const { context } = r;
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    await r.swap();

    const diagnostics = r.renderer.diagnostics();
    // These two draws read the same three indices under the same state --
    // provably the same picture as one draw of six reading them twice over
    // -- so the draw-joining pass below folds them into one; `prepared` and
    // `preparedReused` still count generation per draw *attempt*, which is
    // what this test is about.
    assert.equal(diagnostics.draws, 1, 'joined into one draw');
    assert.equal(diagnostics.merged, 1);
    assert.equal(diagnostics.prepared, 1, 'the source was generated for the first');
    assert.equal(diagnostics.preparedReused, 1, 'and the second reused it');
});

test('a changed draw state generates its source again', ()=>{
    const r = rig();
    programRig(r);
    const { context } = r;
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    // A different fixed state -- blending on, with its own factors -- is a
    // different key and its own generation.
    context.glEnable(GL.BLEND);
    context.glBlendFunc(GL.SRC_ALPHA, GL.ONE);
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);

    const diagnostics = r.renderer.diagnostics();
    assert.equal(diagnostics.draws, 2, 'both draws ran');
    assert.equal(diagnostics.prepared, 2, 'each state generated its own source');
    assert.equal(diagnostics.preparedReused, 0, 'neither reused the other');
});

test('the vertex block binds in the fixed group, the fragment block in its own', async()=>{
    // The device hands a stage zero for a dynamic uniform block outside the
    // first group the stage reads, and the fixed block is that first group's.
    // So the vertex block binds beside the fixed block, whose binding the
    // vertex stage also reads, and the fragment block binds in a group of its
    // own. The device double records, per bind, the buffer, offset and size a
    // dynamic binding resolves to, and that range holds the block the draw
    // wrote.
    const r = rig();
    programRig(r);
    const { context } = r;
    context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    await r.swap();

    const binds = r.gpu.of('setBindGroup');
    const vertex = binds.find(b=>b.resolved?.some(
        (/** @type {any} */ x)=>x.binding === VERTEX_PROGRAM_BINDING));
    const fragment = binds.find(b=>b.resolved?.some(
        (/** @type {any} */ x)=>x.binding === FRAGMENT_PROGRAM_BINDING));
    const fixed = binds.find(b=>b.resolved?.some(
        (/** @type {any} */ x)=>x.binding === 0));
    assert.ok(vertex, 'the vertex program block was bound');
    assert.ok(fragment, 'the fragment program block was bound');
    assert.ok(fixed, 'the fixed block was bound');
    assert.equal(vertex.group, fixed.group,
        'the vertex block shares the group the vertex stage already reads');
    assert.notEqual(fragment.group, fixed.group,
        'the fragment block gets a group of its own');

    const vertexRange = vertex.resolved.find(
        (/** @type {any} */ x)=>x.binding === VERTEX_PROGRAM_BINDING).range;
    const vertexFloats = new Float32Array(vertexRange.buffer, vertexRange.byteOffset, 4);
    assert.deepEqual([...vertexFloats], [2 / 64, 0, 0, -1],
        'the bytes at the vertex block\'s offset are the vertex block');

    const fragmentRange = fragment.resolved.find(
        (/** @type {any} */ x)=>x.binding === FRAGMENT_PROGRAM_BINDING).range;
    const fragmentFloats = new Float32Array(fragmentRange.buffer, fragmentRange.byteOffset, 4);
    assert.deepEqual([...fragmentFloats], [0.25, 0.5, 0.75, 1],
        'and the bytes at the fragment block\'s offset are the fragment block');
});

test('the draw path fills a program block in the order the stage declares', async()=>{
    // Derived from Wine wined3d/arb_program_shader.c (wine-5.0): the declared
    // "PARAM C[%d] = { program.env[0..%d] }" run is filled positionally, so
    // the block a draw uploads holds each env parameter at the slot the
    // stage's declaration gave it, not at its env index.
    const r = rig();
    const { context } = r;
    triangle(r, 0x1000);
    context.glGenBuffersARB(1);
    context.glBindBufferARB(GL.ARRAY_BUFFER, 1);
    context.glBufferDataARB(GL.ARRAY_BUFFER, 3 * STRIDE, 0x1000, GL.STATIC_DRAW);
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glVertexPointer(3, GL.FLOAT, STRIDE, 0);
    context.glGenProgramsARB(1);
    context.glBindProgramARB(GL.VERTEX_PROGRAM_ARB, 1);
    // The three env parameters named in the order the instructions reach
    // them, not in the order of their indices.
    const text = `!!ARBvp1.0
TEMP r0, r1;
DP4 r0.x, vertex.position, program.env[10];
DP4 r0.y, vertex.position, program.env[11];
SUB r1, program.env[4], vertex.position;
MOV result.texcoord[1].x, r0.x;
MOV result.texcoord[1].y, r0.y;
MOV result.position, r1;
END
`;
    context.glProgramStringARB(GL.VERTEX_PROGRAM_ARB, GL.PROGRAM_FORMAT_ASCII_ARB,
        putProgram(r, 0x3000, text), 0x3000);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    context.glProgramEnvParameter4fARB(GL.VERTEX_PROGRAM_ARB, 4, [4, 4, 4, 4]);
    context.glProgramEnvParameter4fARB(GL.VERTEX_PROGRAM_ARB, 10, [10, 10, 10, 10]);
    context.glProgramEnvParameter4fARB(GL.VERTEX_PROGRAM_ARB, 11, [11, 11, 11, 11]);
    context.glEnable(GL.VERTEX_PROGRAM_ARB);
    context.glDrawArrays(GL.TRIANGLES, 0, 3);
    await r.swap();

    const block = uniformBlocks(r).find(w=>w.size === 12 * 4
        && /uniforms/.test(w.buffer.descriptor.label));
    assert.ok(block, 'the vertex program block travelled');
    const floats = new Float32Array(block.bytes.buffer, block.bytes.byteOffset, 12);
    assert.deepEqual([...floats.subarray(0, 4)], [10, 10, 10, 10],
        'slot zero holds the first-named parameter, env[10]');
    assert.deepEqual([...floats.subarray(4, 8)], [11, 11, 11, 11],
        'slot one the second, env[11]');
    assert.deepEqual([...floats.subarray(8, 12)], [4, 4, 4, 4],
        'and slot two the one named last, env[4]');
});

test('a program block is reused when a redundant env-parameter write repeats the same value',
    async()=>{
        // Doom 3 sets a light's environment parameters before every
        // interaction draw, whether or not they moved since the last one:
        // the cache must tell the two apart by value, not by "a setter ran".
        const r = rig();
        programRig(r);
        const { context } = r;
        context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
        context.glProgramEnvParameter4fARB(GL.VERTEX_PROGRAM_ARB, 2, [1, 0.5, 0.25, 1]);
        context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
        await r.swap();

        let diag = r.renderer.diagnostics();
        assert.equal(diag.programUniformsBuilt, 2, 'the vertex and fragment blocks, built once');
        assert.equal(diag.programUniformsReused, 2,
            'the redundant write repeated the value, so the second draw reused both');

        context.glProgramEnvParameter4fARB(GL.VERTEX_PROGRAM_ARB, 2, [0, 1, 0, 1]);
        context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
        await r.swap();
        diag = r.renderer.diagnostics();
        assert.equal(diag.programUniformsBuilt, 3,
            'the vertex block, whose env parameter actually moved, rebuilt');
        assert.equal(diag.programUniformsReused, 3,
            'the fragment block, untouched, still reused');
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
    assert.match(line, /tex=\[1:t1:4x4\/1\]/,
        'the fragment program samples t1, 4x4 with one level, at binding 1');
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

test('a probed texture reads the target before and after its frame\'s last draws', async()=>{
    const r = rig({ dumpDraws: true, probeTexture: 't1' });
    programRig(r);
    const { context } = r;
    for (let i = 0; i < 6; i++)
    {
        context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    }
    await r.swap();

    const dump = r.renderer.diagnostics().lastDump;
    const line = dump.find(text=>text.startsWith('draw 5:'));
    assert.ok(line, 'the frame\'s last draw sampling the texture is probed');
    assert.match(line, /before=\d+\/\d+\/\d+(,\d+\/\d+\/\d+){6} distinct=\d+/);
    assert.match(line, /after=\d+\/\d+\/\d+(,\d+\/\d+\/\d+){6} distinct=\d+/,
        'the recording device keeps no texels, so both reads are zeroes of the right shape');
    assert.match(line, /census=\[t1:4x4:0x1908:distinct=1\]/,
        'and the draw\'s line carries what its texture holds');
    const copies = r.gpu.of('copyTextureToBuffer');
    assert.equal(copies.length, 8, 'two reads per probed draw, four draws per frame');
    const probed = dump.filter(text=>text.startsWith('draw ') && text.includes('before='));
    assert.deepEqual(probed.map(text=>text.slice(0, 7)),
        ['draw 2:', 'draw 3:', 'draw 4:', 'draw 5:'], 'the last four, not the first');
    const drawn = r.gpu.calls.indexOf(r.gpu.of('drawIndexed')[5]);
    assert.ok(r.gpu.calls.indexOf(copies[6]) < drawn
        && drawn < r.gpu.calls.indexOf(copies[7]),
    'and the probed draw sits between its two reads');
});

test('a probe window names the draws of a frame it reads around', async()=>{
    const r = rig({ dumpDraws: true, probeTexture: 't1@1-2' });
    programRig(r);
    const { context } = r;
    for (let i = 0; i < 6; i++)
    {
        context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
    }
    await r.swap();

    const dump = r.renderer.diagnostics().lastDump;
    const probed = dump.filter(text=>text.startsWith('draw ') && text.includes('before='));
    assert.deepEqual(probed.map(text=>text.slice(0, 7)), ['draw 1:', 'draw 2:'],
        'the window, not the frame\'s end, chooses');
    assert.equal(r.gpu.of('copyTextureToBuffer').length, 4);
});

test('a probe reads only while its frame is the newest, so a late replay reads nothing', async()=>{
    // Two frames presented before either is replayed: the first is behind by
    // the time it runs, and a probe there would add two read-backs a frame to
    // a replay already late. Only the second, the one the report reads, is probed.
    const r = rig({ dumpDraws: true, probeTexture: 't1' });
    programRig(r);
    const { context, renderer } = r;
    for (let frame = 0; frame < 2; frame++)
    {
        for (let i = 0; i < 6; i++)
        {
            context.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_INT, 0x2000);
        }
        renderer.present(context);
    }
    await renderer.settled();
    assert.equal(r.gpu.of('copyTextureToBuffer').length, 8, 'four probed draws, one frame');
});

test('a probe reads its points inside the scissor of the draw, not at fixed places', ()=>{
    // An 8x8 target, blue everywhere but a 2x2 red square at 4,4 -- the
    // rectangle the draw was scissored to. Every point and the grid fall in it.
    const data = new Uint8Array(8 * 8 * 4);
    for (let y = 0; y < 8; y++)
    {
        for (let x = 0; x < 8; x++)
        {
            const at = (y * 8 + x) * 4;
            const inside = x >= 4 && x < 6 && y >= 4 && y < 6;
            data.set(inside ? [0, 0, 255, 255] : [255, 0, 0, 255], at);
        }
    }
    const text = describeSnapshot({ width: 8, height: 8, data },
        { x: 4, y: 4, width: 2, height: 2 });
    assert.equal(text, `${Array(7).fill('255/0/0').join(',')} distinct=1`);
});

test('a program sampling past the fourth unit gets bindings of its own', async()=>{
    const r = rig();
    const { context } = r;
    triangle(r, 0x1000);
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glEnableClientState(GL.TEXTURE_COORD_ARRAY);
    context.glVertexPointer(3, GL.FLOAT, STRIDE, 0x1000);
    context.glTexCoordPointer(2, GL.FLOAT, STRIDE, 0x1000 + 12);
    context.glGenTextures(2);
    for (const [unit, name] of [[4, 1], [6, 2]])
    {
        context.glActiveTextureARB(GL.TEXTURE0 + unit);
        context.glBindTexture(GL.TEXTURE_2D, name);
        context.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR);
        context.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 4, 4, 0, GL.RGBA, GL.UNSIGNED_BYTE,
            new Uint8Array(4 * 4 * 4).fill(0x80));
    }
    assert.equal(context.glGetError(), GL.NO_ERROR, 'both units took their texture');
    context.glGenProgramsARB(1);
    context.glBindProgramARB(GL.FRAGMENT_PROGRAM_ARB, 1);
    const text = `!!ARBfp1.0
TEMP a, b;
TEX a, fragment.texcoord[0], texture[4], 2D;
TEX b, fragment.texcoord[0], texture[6], 2D;
MUL result.color, a, b;
END
`;
    context.glProgramStringARB(GL.FRAGMENT_PROGRAM_ARB, GL.PROGRAM_FORMAT_ASCII_ARB,
        putProgram(r, 0x4000, text), 0x4000);
    assert.equal(context.glGetError(), GL.NO_ERROR);
    context.glEnable(GL.FRAGMENT_PROGRAM_ARB);
    context.glDrawArrays(GL.TRIANGLES, 0, 3);
    await r.swap();

    const layout = r.gpu.of('createBindGroupLayout')
        .find(l=>l.descriptor.entries.some((/** @type {any} */ e)=>e.binding === 9));
    assert.ok(layout, 'unit four samples at binding 9');
    const bindings = layout.descriptor.entries.map((/** @type {any} */ e)=>e.binding);
    assert.equal(new Set(bindings).size, bindings.length,
        `no two entries share a binding: ${bindings.join(',')}`);
    const entryAt = (/** @type {number} */ binding)=>layout.descriptor.entries
        .find((/** @type {any} */ e)=>e.binding === binding);
    assert.ok(entryAt(9).texture, 'binding 9 is the unit\'s texture');
    assert.ok(entryAt(10).sampler, 'and 10 its sampler');
    assert.ok(entryAt(13).texture && entryAt(14).sampler, 'unit six at its own pair');
    const fragmentLayout = r.gpu.of('createBindGroupLayout')
        .find(l=>l.descriptor.entries
            .some((/** @type {any} */ e)=>e.binding === FRAGMENT_PROGRAM_BINDING));
    assert.ok(fragmentLayout, 'the program block keeps a group of its own, past the units');
    assert.equal(r.gpu.count('draw'), 2, 'the draw and the shown copy were issued');
});

test('a ranged draw starts at its first vertex by the base vertex, not in the order', async()=>{
    // The order a mode and count expand to is built once and shared; a range
    // that starts past zero was written into it, and the next draw of the
    // same mode and count read the first one's start.
    const r = rig();
    const { context } = r;
    for (let i = 0; i < 6; i++)
    {
        r.floats(0x1000 + i * STRIDE, [i, i, 0]);
    }
    context.glEnableClientState(GL.VERTEX_ARRAY);
    context.glVertexPointer(3, GL.FLOAT, STRIDE, 0x1000);
    context.glDrawArrays(GL.TRIANGLE_FAN, 2, 4);
    context.glDrawArrays(GL.TRIANGLE_FAN, 0, 4);
    await r.swap();
    const draws = r.gpu.of('drawIndexed').map((/** @type {any} */ call)=>call.args);
    assert.deepEqual(draws[0], [6, 1, 0, 0], 'from vertex two, which the copy starts at');
    assert.deepEqual(draws[1], [6, 1, 0, 0]);
    const orders = r.gpu.of('writeBuffer')
        .filter(w=>/gl-scratch-indices/.test(w.buffer.descriptor.label))
        .map(w=>[...new Uint32Array(w.bytes.buffer, w.bytes.byteOffset, 6)]);
    assert.ok(orders.length > 0);
    for (const order of orders)
    {
        assert.deepEqual(order, [0, 1, 2, 0, 2, 3], 'the shared order, unwritten by either draw');
    }
});
