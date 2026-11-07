/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A context drawing on a recording device, for the tests of what shaders
 * write (`context-compute.test.js`, `context-storage.test.js` and the rest):
 * programs made from sources, buffers filled from guest memory.
 */

import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

/** A context on a recording device, its memory and its helpers. */
export function computeRig(){
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} });
    /** @type {string[]} */
    const divergences = [];
    const renderer = createGpuRenderer({
        backend,
        createSampler: descriptor=>({ kind: 'sampler', descriptor }),
        divergence: detail=>divergences.push(detail),
    });
    const bytes = new Uint8Array(0x10000);
    const memory = {
        read: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>bytes.set(value, at),
    };
    /** @type {any} */
    const gl = createGlContext({ memory, gpu: renderer, divergence: d=>divergences.push(d) });
    gl.attach({ width: 64, height: 32, doubleBuffered: true, depthBits: 24 });
    const swap = async()=>{
        renderer.present(gl);
        await renderer.settled();
    };
    /** @param {[number, string][]} shaders @returns {number} the program */
    const program = shaders=>{
        const made = gl.glCreateProgram();
        for (const [type, text] of shaders)
        {
            const shader = gl.glCreateShader(type);
            assert.notEqual(shader, 0);
            gl.glShaderSource(shader, [text]);
            gl.glCompileShader(shader);
            assert.deepEqual(gl.glGetShaderiv(shader, GL.COMPILE_STATUS), [1],
                gl.glGetShaderInfoLog(shader));
            gl.glAttachShader(made, shader);
        }
        gl.glLinkProgram(made);
        return made;
    };
    /**
     * @param {number} target @param {Uint8Array | null} data
     * @returns {number} a buffer bound to `target`
     */
    const buffer = (target, data)=>{
        const [name] = gl.glGenBuffersARB(1);
        gl.glBindBufferARB(target, name);
        if (data)
        {
            bytes.set(data, 0x8000);
            gl.glBufferDataARB(target, data.length, 0x8000, GL.STATIC_DRAW);
        }
        return name;
    };
    return { gpu, renderer, gl, divergences, swap, program, buffer, bytes };
}
