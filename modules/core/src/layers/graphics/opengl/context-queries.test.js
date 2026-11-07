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
import { QUERY } from './context-queries.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/**
 * @param {((slot: number) => number) | null} samples  what each occlusion slot counts, or
 *     null for a context without a device
 * @returns {{ gl: any, renderer: any, gpu: any }}
 */
function fixture(samples){
    const gpu = createFakeDevice(samples ? { occlusionSamples: samples } : {});
    const renderer = samples ? createGpuRenderer({
        backend: createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} }),
        createSampler: (/** @type {any} */ descriptor)=>({ kind: 'sampler', descriptor }),
    }) : null;
    const gl = /** @type {any} */ (createGlContext(renderer ? { gpu: renderer } : {}));
    gl.attach({ width: 8, height: 4, doubleBuffered: true, depthBits: 24 });
    gl.glMatrixMode(GL.PROJECTION);
    gl.glOrtho(0, 8, 0, 4, -1, 1);
    gl.glMatrixMode(GL.MODELVIEW);
    return { gl, renderer, gpu };
}

/** @param {any} gl */
function triangle(gl){
    gl.glBegin(GL.TRIANGLES);
    gl.glVertex2f(0, 0);
    gl.glVertex2f(8, 0);
    gl.glVertex2f(0, 4);
    gl.glEnd();
}

test('a query\'s errors and queries, as section 4.1.7 of 3.3 has them', ()=>{
    const { gl } = fixture(null);
    const [q, t, s] = gl.glGenQueries(3);
    assert.equal(gl.glIsQuery(q), GL.FALSE, 'not a query until begun');
    gl.glBeginQuery(0x1234, q);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glBeginQuery(GL.SAMPLES_PASSED, 0);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'zero is no query');
    gl.glBeginQuery(GL.SAMPLES_PASSED, q);
    assert.deepEqual(gl.glGetQueryiv(GL.SAMPLES_PASSED, QUERY.CURRENT_QUERY), [q]);
    gl.glBeginQuery(GL.SAMPLES_PASSED, t);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'one active a target');
    gl.glBeginQuery(QUERY.TIME_ELAPSED, q);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'active at another target');
    assert.equal(gl.glGetQueryObject(q, QUERY.QUERY_RESULT), null);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'not while it is active');
    gl.glBeginQuery(QUERY.TIME_ELAPSED, t);
    gl.glEndQuery(GL.SAMPLES_PASSED);
    gl.glEndQuery(QUERY.TIME_ELAPSED);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetQueryObject(q, QUERY.QUERY_RESULT_AVAILABLE), [GL.TRUE]);
    assert.ok(gl.glGetQueryObject(q, QUERY.QUERY_RESULT)[0] > 0, 'the viewport\'s area');
    assert.ok(gl.glGetQueryObject(t, QUERY.QUERY_RESULT)[0] >= 0, 'nanoseconds');
    gl.glBeginQuery(GL.SAMPLES_PASSED, t);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a time query is not an occlusion one');
    gl.glBeginQuery(QUERY.ANY_SAMPLES_PASSED, q);
    gl.glEndQuery(QUERY.ANY_SAMPLES_PASSED);
    assert.deepEqual(gl.glGetQueryObject(q, QUERY.QUERY_RESULT), [1],
        'occlusion targets share their objects; any samples is a boolean');
    gl.glEndQuery(GL.SAMPLES_PASSED);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'none active');
    gl.glQueryCounter(s, QUERY.TIMESTAMP);
    assert.ok(gl.glGetQueryObject(s, QUERY.QUERY_RESULT)[0] > 0);
    gl.glQueryCounter(s, QUERY.TIME_ELAPSED);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glQueryCounter(q, QUERY.TIMESTAMP);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'an occlusion query is no timestamp');
    assert.deepEqual([GL.SAMPLES_PASSED, QUERY.ANY_SAMPLES_PASSED, QUERY.TIME_ELAPSED,
        QUERY.TIMESTAMP].map(target=>gl.glGetQueryiv(target, QUERY.QUERY_COUNTER_BITS)[0]),
    [64, 1, 64, 64]);
    assert.equal(gl.glGetQueryiv(QUERY.TIMESTAMP, QUERY.CURRENT_QUERY), null);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glDeleteQueries([q]);
    assert.equal(gl.glIsQuery(q), GL.FALSE);
});

test('on a device an occlusion query answers the samples its draws passed, once they are '
    + 'counted; asked before, the result is waited for', async()=>{
    const { gl, renderer } = fixture(slot=>5 + slot);
    const [q, any] = gl.glGenQueries(2);
    triangle(gl);
    gl.glBeginQuery(GL.SAMPLES_PASSED, q);
    triangle(gl);
    gl.glTranslatef(1, 0, 0);
    triangle(gl);
    gl.glEndQuery(GL.SAMPLES_PASSED);
    triangle(gl);
    assert.deepEqual(gl.glGetQueryObject(q, QUERY.QUERY_RESULT_AVAILABLE), [GL.FALSE]);
    assert.equal(gl.glGetQueryObject(q, QUERY.QUERY_RESULT_NO_WAIT), null);
    const waited = gl.glGetQueryObject(q, QUERY.QUERY_RESULT);
    assert.ok(waited instanceof Promise);
    assert.deepEqual(await waited, [5 + 6], 'the two draws it counted, slot by slot');
    assert.deepEqual(gl.glGetQueryObject(q, QUERY.QUERY_RESULT_AVAILABLE), [GL.TRUE]);
    gl.glBeginQuery(QUERY.ANY_SAMPLES_PASSED, any);
    triangle(gl);
    gl.glEndQuery(QUERY.ANY_SAMPLES_PASSED);
    renderer.present(gl);
    await renderer.settled();
    assert.deepEqual(gl.glGetQueryObject(any, QUERY.QUERY_RESULT), [1], 'counted at the swap');
});

test('rendering conditional on a query draws only when it counted something, the inverted '
    + 'modes the other way round', async()=>{
    for (const [counted, mode, drawn] of /** @type {[number, number, boolean][]} */ ([
        [0, QUERY.QUERY_WAIT, false], [3, QUERY.QUERY_NO_WAIT, true],
        [0, QUERY.QUERY_WAIT_INVERTED, true], [3, QUERY.QUERY_BY_REGION_WAIT_INVERTED, false],
    ]))
    {
        const { gl, renderer, gpu } = fixture(()=>counted);
        const [q] = gl.glGenQueries(1);
        gl.glBeginQuery(GL.SAMPLES_PASSED, q);
        triangle(gl);
        gl.glEndQuery(GL.SAMPLES_PASSED);
        gl.glBeginConditionalRender(q, mode);
        triangle(gl);
        gl.glClear(GL.COLOR_BUFFER_BIT);
        gl.glEndConditionalRender();
        assert.equal(gl.glGetError(), GL.NO_ERROR);
        renderer.present(gl);
        await renderer.settled();
        // The query's draw, the show; and the two on the condition when it holds.
        const draws = gpu.of('draw').length + gpu.of('drawIndexed').length;
        assert.equal(draws, drawn ? 4 : 2, `counted ${counted}, mode ${mode.toString(16)}`);
    }
});

test('conditional rendering\'s errors', ()=>{
    const { gl } = fixture(null);
    const [q, t] = gl.glGenQueries(2);
    gl.glBeginConditionalRender(q, QUERY.QUERY_WAIT);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'not a query yet');
    gl.glBeginQuery(QUERY.TIME_ELAPSED, t);
    gl.glEndQuery(QUERY.TIME_ELAPSED);
    gl.glBeginConditionalRender(t, QUERY.QUERY_WAIT);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'not an occlusion query');
    gl.glBeginQuery(GL.SAMPLES_PASSED, q);
    gl.glBeginConditionalRender(q, QUERY.QUERY_WAIT);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'while it is active');
    gl.glEndQuery(GL.SAMPLES_PASSED);
    gl.glBeginConditionalRender(q, GL.TEXTURE_2D);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glBeginConditionalRender(q, QUERY.QUERY_WAIT);
    gl.glBeginConditionalRender(q, QUERY.QUERY_WAIT);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'one at a time');
    gl.glEndConditionalRender();
    gl.glEndConditionalRender();
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'none to end');
});
