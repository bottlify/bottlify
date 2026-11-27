/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The provoking vertex (OpenGL 3.2 section 2.18, table 2.12): GL takes a
 * flat value from a primitive's last vertex by default, WebGPU from its
 * first, so a draw that has one is drawn with each primitive turned round.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { lastProvoking } from './gpu-layout.js';
import { geometryIndexWgsl } from '../d3d10/geometry-wgsl.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/** @param {Uint32Array | null} order @param {number} size */
const primitives = (order, size)=>{
    const out = [];
    const list = order ?? new Uint32Array(0);
    for (let k = 0; k < list.length; k += size)
    {
        out.push([...list.subarray(k, k + size)].join(''));
    }
    return out;
};

test('each primitive\'s last vertex comes first, its winding kept', ()=>{
    // Table 2.12's provoking vertex (last convention), numbered from 0 here.
    assert.deepEqual(primitives(lastProvoking(GL.TRIANGLES, 6), 3), ['201', '534']);
    assert.deepEqual(primitives(lastProvoking(GL.TRIANGLE_STRIP, 5), 3),
        ['201', '321', '423']);
    assert.deepEqual(primitives(lastProvoking(GL.TRIANGLE_FAN, 4), 3), ['201', '302']);
    // A quad's fourth vertex, in both its triangles; a quad strip's 2i + 3.
    assert.deepEqual(primitives(lastProvoking(GL.QUADS, 4), 3), ['301', '312']);
    assert.deepEqual(primitives(lastProvoking(GL.QUAD_STRIP, 4), 3), ['301', '320']);
    assert.deepEqual(primitives(lastProvoking(GL.LINES, 4), 2), ['10', '32']);
    assert.deepEqual(primitives(lastProvoking(GL.LINE_LOOP, 3), 2), ['10', '21', '02']);
    // A polygon's is its first, and a point is its own.
    assert.equal(lastProvoking(GL.POLYGON, 5), null);
    assert.equal(lastProvoking(GL.POINTS, 5), null);
});

test('a geometry shader\'s list turns its primitives round where the last vertex provokes', ()=>{
    const first = geometryIndexWgsl({ streams: 1, maxOut: 4, outputVertices: 3 });
    const last = geometryIndexWgsl({ streams: 1, maxOut: 4, outputVertices: 3, last: true });
    assert.match(first, /indices\[base \+ 2u\] = at;/);
    assert.match(last, /indices\[base \+ 0u\] = at;/);
    assert.match(last, /indices\[base \+ 1u\] = select\(at - 2u, at - 1u, odd\);/);
});

test('glProvokingVertex sets the convention, the last by default', ()=>{
    const bytes = new Uint8Array(0x100);
    /** @type {any} */
    const gl = createGlContext({ memory: { read: (at, n)=>bytes.subarray(at, at + n),
        write: (at, v)=>bytes.set(v, at) } });
    assert.deepEqual(gl.glGetIntegerv(GL.PROVOKING_VERTEX), [GL.LAST_VERTEX_CONVENTION]);
    gl.glProvokingVertex(GL.FIRST_VERTEX_CONVENTION);
    assert.deepEqual(gl.glGetIntegerv(GL.PROVOKING_VERTEX), [GL.FIRST_VERTEX_CONVENTION]);
    gl.glProvokingVertex(GL.TRIANGLES);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    assert.deepEqual(gl.glGetIntegerv(GL.QUADS_FOLLOW_PROVOKING_VERTEX_CONVENTION), [0]);
});

test('a draw is turned round only where it has a flat value and the last vertex provokes',
    async()=>{
        const gpu = createFakeDevice();
        const backend = createBackend({ device: gpu.device, queue: gpu.queue,
            presentTo: ()=>{} });
        const renderer = createGpuRenderer({ backend,
            createSampler: descriptor=>({ kind: 'sampler', descriptor }) });
        const bytes = new Uint8Array(0x1000);
        /** @type {any} */
        const gl = createGlContext({ memory: { read: (at, n)=>bytes.subarray(at, at + n),
            write: (at, v)=>bytes.set(v, at) }, gpu: renderer });
        gl.attach({ width: 16, height: 16, doubleBuffered: true, depthBits: 24 });
        gl.glEnableClientState(GL.VERTEX_ARRAY);
        gl.glVertexPointer(2, GL.FLOAT, 8, 0x100);
        const draws = async()=>{
            gpu.calls.length = 0;
            gl.glDrawArrays(GL.TRIANGLES, 0, 3);
            renderer.present(gl);
            await renderer.settled();
            return gpu.of('drawIndexed').length;
        };
        assert.equal(await draws(), 0, 'smooth: drawn as it comes');
        gl.glShadeModel(GL.FLAT);
        assert.equal(await draws(), 1, 'flat: drawn through its turned order');
        gl.glProvokingVertex(GL.FIRST_VERTEX_CONVENTION);
        assert.equal(await draws(), 0, 'the first vertex provokes on the device already');
    });
