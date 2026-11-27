/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The smaller state of OpenGL 4.6: the polygon offset's clamp and
 * anisotropic filtering.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';
import { GL_EXTENSIONS } from './extensions.js';

/** A context drawing through the fake device, and that device. */
function rig(){
    /** @type {string[]} */
    const said = [];
    /** @type {any[]} */
    const samplers = [];
    const gpu = createFakeDevice();
    const renderer = createGpuRenderer({
        backend: createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} }),
        createSampler: (/** @type {any} */ descriptor)=>{
            samplers.push(descriptor);
            return { kind: 'sampler', descriptor };
        },
        divergence: d=>said.push(d),
    });
    const gl = /** @type {any} */ (createGlContext({ gpu: renderer }));
    gl.attach({ width: 4, height: 4, doubleBuffered: true, depthBits: 24 });
    const triangle = ()=>{
        gl.glBegin(GL.TRIANGLES);
        gl.glTexCoord2f(0, 0);
        gl.glVertex2f(0, 0);
        gl.glTexCoord2f(1, 0);
        gl.glVertex2f(1, 0);
        gl.glTexCoord2f(0, 1);
        gl.glVertex2f(0, 1);
        gl.glEnd();
    };
    const swap = async()=>{
        renderer.present(gl);
        await renderer.settled();
    };
    return { gl, gpu, said, samplers, triangle, swap };
}

test('glPolygonOffsetClamp sets the offset and its clamp, which the depth bias takes',
    async()=>{
        const { gl, gpu, triangle, swap } = rig();
        assert.deepEqual(gl.glGetFloatv(GL.POLYGON_OFFSET_CLAMP), [0], 'none at first');
        gl.glPolygonOffsetClamp(2, 3, -0.25);
        assert.deepEqual([GL.POLYGON_OFFSET_FACTOR, GL.POLYGON_OFFSET_UNITS,
            GL.POLYGON_OFFSET_CLAMP].map(q=>gl.glGetFloatv(q)[0]), [2, 3, -0.25]);
        gl.glPolygonOffset(1, 1);
        assert.deepEqual(gl.glGetFloatv(GL.POLYGON_OFFSET_CLAMP), [-0.25],
            'glPolygonOffset leaves the clamp');

        gl.glPushAttrib(GL.POLYGON_BIT);
        gl.glPolygonOffsetClamp(1, 1, 7);
        gl.glPopAttrib();
        assert.deepEqual(gl.glGetFloatv(GL.POLYGON_OFFSET_CLAMP), [-0.25], 'saved with polygons');

        const list = gl.glGenLists(1);
        gl.glNewList(list, GL.COMPILE);
        gl.glPolygonOffsetClamp(4, 5, 0.5);
        gl.glEndList();
        assert.deepEqual(gl.glGetFloatv(GL.POLYGON_OFFSET_CLAMP), [-0.25], 'compiled, not run');
        gl.glCallList(list);
        assert.deepEqual(gl.glGetFloatv(GL.POLYGON_OFFSET_CLAMP), [0.5], 'run from the list');

        gl.glEnable(GL.POLYGON_OFFSET_FILL);
        triangle();
        gl.glPolygonOffsetClamp(4, 5, 0.125);
        triangle();
        await swap();
        const biases = gpu.of('createRenderPipeline').map((/** @type {any} */ call)=>
            call.descriptor.depthStencil?.depthBiasClamp);
        assert.ok(biases.includes(0.5) && biases.includes(0.125),
            'each clamp a pipeline of its own');
    });

test('anisotropy is a texture and sampler parameter WebGPU filters by when every filter is linear',
    async()=>{
        const { gl, samplers, triangle, swap } = rig();
        assert.ok(GL_EXTENSIONS.GL_EXT_texture_filter_anisotropic);
        assert.ok(GL_EXTENSIONS.GL_ARB_texture_filter_anisotropic);
        assert.deepEqual(gl.glGetFloatv(GL.MAX_TEXTURE_MAX_ANISOTROPY), [16]);
        const [name] = gl.glGenTextures(1);
        gl.glBindTexture(GL.TEXTURE_2D, name);
        assert.deepEqual(gl.glGetTexParameterfv(GL.TEXTURE_2D, GL.TEXTURE_MAX_ANISOTROPY), [1]);
        gl.glTexParameterf(GL.TEXTURE_2D, GL.TEXTURE_MAX_ANISOTROPY, 0.5);
        assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'less than one');
        gl.glTexParameterf(GL.TEXTURE_2D, GL.TEXTURE_MAX_ANISOTROPY, 64);
        assert.equal(gl.glGetError(), GL.NO_ERROR);
        assert.deepEqual(gl.glGetTexParameterfv(GL.TEXTURE_2D, GL.TEXTURE_MAX_ANISOTROPY), [64],
            'kept as given, bounded where it is used');

        const [sampler] = gl.glGenSamplers(1);
        assert.deepEqual(gl.getSamplerParameter(sampler, GL.TEXTURE_MAX_ANISOTROPY), [1]);
        gl.samplerParameter(sampler, GL.TEXTURE_MAX_ANISOTROPY, [0]);
        assert.equal(gl.glGetError(), GL.INVALID_VALUE);
        gl.samplerParameter(sampler, GL.TEXTURE_MAX_ANISOTROPY, [4.5]);
        assert.deepEqual(gl.getSamplerParameter(sampler, GL.TEXTURE_MAX_ANISOTROPY), [4.5]);

        gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 1, 1, 0, GL.RGBA, GL.UNSIGNED_BYTE,
            [1, 2, 3, 4]);
        gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, GL.LINEAR_MIPMAP_NEAREST);
        gl.glEnable(GL.TEXTURE_2D);
        triangle();
        await swap();
        /** @returns {any[]} the samplers made so far */
        const made = ()=>samplers;
        const most = made().find(d=>d.maxAnisotropy === 16);
        assert.ok(most, 'the texture\'s, bounded by the most there is');
        assert.equal(most.mipmapFilter, 'linear', 'every filter linear, the levels too');

        gl.samplerParameter(sampler, GL.TEXTURE_MIN_FILTER, [GL.LINEAR_MIPMAP_LINEAR]);
        gl.glBindSampler(0, sampler);
        triangle();
        await swap();
        assert.ok(made().some(d=>d.maxAnisotropy === 4), 'the bound sampler\'s, whole degrees');

        gl.glBindSampler(0, 0);
        gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_MAG_FILTER, GL.NEAREST);
        const before = made().length;
        triangle();
        await swap();
        const nearest = made().slice(before).find(d=>d.magFilter === 'nearest');
        assert.ok(nearest, 'a nearest filter is a sampler of its own');
        assert.equal(nearest.maxAnisotropy, undefined, 'sampled as asked, without anisotropy');
        assert.equal(nearest.mipmapFilter, 'nearest');
    });
