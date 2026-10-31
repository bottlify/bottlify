/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a GLSL program and a framebuffer object give the device: a context
 * on the renderer on the backend on the recording device, a program drawing
 * into a texture and the window sampling it, as OpenGL 2.0 with
 * GL_ARB_framebuffer_object draws a scene through a render target.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createGpuRenderer } from './gpu.js';
import { UNIFORM } from './wgsl.js';
import { createBackend } from '../webgpu/backend.js';
import { createFakeDevice } from '../webgpu/internal/fake-device.js';

const VS = `#version 120
uniform mat4 projection;
uniform mat4 modelview;
attribute vec2 vTex;
attribute vec4 vColor;
attribute vec3 vPosition;
varying vec4 color;
varying vec2 texCoord;
void main()
{
  color = vColor;
  texCoord = vTex;
  gl_Position = projection * modelview * vec4(vPosition, 1.0);
}
`;
const FS = `#version 120
uniform sampler2D texture;
uniform bool alpha;
uniform bool useTexture;
varying vec4 color;
varying vec2 texCoord;
void main()
{
  vec4 outColor = color;
  if (useTexture) {
    outColor *= texture2D(texture, texCoord);
  }
  if (alpha && outColor.a < (1.0 / 255.0)) {
    discard;
  }
  gl_FragColor = outColor;
}
`;

/** Bytes per vertex: a position, a colour in bytes, a coordinate. */
const STRIDE = 24;

function rig(){
    const gpu = createFakeDevice();
    const backend = createBackend({ device: gpu.device, queue: gpu.queue, presentTo: ()=>{} });
    /** @type {string[]} */
    const divergences = [];
    const renderer = createGpuRenderer({
        backend, createSampler: descriptor=>({ kind: 'sampler', descriptor }),
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
    // A quad over the viewport, red, its corners' coordinates 0..1.
    const view = new DataView(bytes.buffer);
    [[-1, -1, 0, 0], [1, -1, 1, 0], [1, 1, 1, 1], [-1, 1, 0, 1]].forEach(([x, y, u, v], i)=>{
        const at = 0x1000 + i * STRIDE;
        view.setFloat32(at, x, true);
        view.setFloat32(at + 4, y, true);
        view.setUint32(at + 12, 0xff0000ff, true);
        view.setFloat32(at + 16, u, true);
        view.setFloat32(at + 20, v, true);
    });
    gl.glVertexAttribPointerARB(0, 3, GL.FLOAT, 0, STRIDE, 0x1000);
    gl.glVertexAttribPointerARB(1, 4, GL.UNSIGNED_BYTE, 1, STRIDE, 0x100c);
    gl.glVertexAttribPointerARB(2, 2, GL.FLOAT, 0, STRIDE, 0x1010);
    for (const index of [0, 1, 2])
    {
        gl.glEnableVertexAttribArrayARB(index);
    }
    const swap = async()=>{
        renderer.present(gl);
        await renderer.settled();
    };
    return { gpu, renderer, gl, divergences, swap };
}

/** @param {any} gl @returns {number} World of Goo's program, linked and in use */
function program(gl){
    const name = gl.glCreateProgram();
    for (const [type, source] of [[GL.VERTEX_SHADER, VS], [GL.FRAGMENT_SHADER, FS]])
    {
        const shader = gl.glCreateShader(type);
        gl.glShaderSource(shader, [source]);
        gl.glCompileShader(shader);
        gl.glAttachShader(name, shader);
    }
    gl.glBindAttribLocation(name, 0, 'vPosition');
    gl.glBindAttribLocation(name, 1, 'vColor');
    gl.glBindAttribLocation(name, 2, 'vTex');
    gl.glLinkProgram(name);
    gl.glUseProgram(name);
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    gl.uniformMatrix(gl.glGetUniformLocation(name, 'projection'), 1, 0,
        identity.map((v, k)=>(k === 0 ? 0.5 : v)), 4, 4);
    gl.uniformMatrix(gl.glGetUniformLocation(name, 'modelview'), 1, 0, identity, 4, 4);
    return name;
}

/**
 * A 32x16 texture with a depth and stencil renderbuffer, attached to a
 * framebuffer object left bound.
 *
 * @param {any} gl
 */
function framebuffer(gl){
    const [texture] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, texture);
    gl.glTexParameterfv(GL.TEXTURE_2D, GL.TEXTURE_MIN_FILTER, [GL.LINEAR]);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGBA, 32, 16, 0, GL.RGBA, GL.UNSIGNED_BYTE, null);
    gl.glBindTexture(GL.TEXTURE_2D, 0);
    const [fbo] = gl.glGenFramebuffers(1);
    gl.bindFramebuffer(GL.FRAMEBUFFER, fbo, false);
    gl.framebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0, GL.TEXTURE_2D, texture, 0);
    const [depth] = gl.glGenRenderbuffers(1);
    gl.bindRenderbuffer(GL.RENDERBUFFER, depth, false);
    gl.glRenderbufferStorageMultisample(GL.RENDERBUFFER, 0, GL.DEPTH24_STENCIL8, 32, 16);
    gl.glFramebufferRenderbuffer(GL.FRAMEBUFFER, GL.DEPTH_STENCIL_ATTACHMENT, GL.RENDERBUFFER,
        depth);
    assert.equal(gl.glCheckFramebufferStatus(GL.FRAMEBUFFER), GL.FRAMEBUFFER_COMPLETE);
    return { texture, fbo };
}

/**
 * The blocks a draw bound at a group's binding, as floats, in draw order.
 *
 * @param {any} gpu @param {number} binding
 */
const blocksAt = (gpu, binding)=>gpu.of('setBindGroup').flatMap((/** @type {any} */ call)=>
    call.resolved.filter((/** @type {any} */ r)=>r.binding === binding))
    .map((/** @type {any} */ r)=>new Float32Array(r.range.buffer, r.range.byteOffset,
        r.range.byteLength / 4));

test('a GLSL program draws into a texture, upside down, and the window samples it', async()=>{
    const r = rig();
    const { gl, gpu } = r;
    const prog = program(gl);
    const { texture } = framebuffer(gl);
    gl.glViewport(0, 0, 32, 16);
    gl.glClearColor(0, 0, 1, 1);
    gl.glClear(GL.COLOR_BUFFER_BIT | GL.DEPTH_BUFFER_BIT);
    gl.glDrawArrays(GL.TRIANGLE_FAN, 0, 4);
    gl.bindFramebuffer(GL.FRAMEBUFFER, 0, false);
    gl.glViewport(0, 0, 64, 32);
    gl.uniform(gl.glGetUniformLocation(prog, 'useTexture'), 1, [1], 'i', 1);
    gl.glBindTexture(GL.TEXTURE_2D, texture);
    gl.glDrawArrays(GL.TRIANGLE_FAN, 0, 4);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    await r.swap();
    assert.deepEqual(r.renderer.diagnostics().failures, []);
    assert.deepEqual(r.divergences, []);

    // Two passes for the draws: into the texture with its depth, and the window.
    const passes = gpu.of('beginRenderPass');
    const into = passes.find((/** @type {any} */ p)=>/gl-texture:/.test(
        p.descriptor.colorAttachments[0]?.view?.viewDescriptor?.label ?? ''));
    assert.ok(into, 'a pass draws into the texture\'s level');
    assert.ok(into.descriptor.depthStencilAttachment, 'with the renderbuffer\'s depth');

    const pipelines = gpu.of('createRenderPipeline').map((/** @type {any} */ p)=>p.descriptor);
    const glsl = pipelines.filter((/** @type {any} */ d)=>d.vertex.module.descriptor.code
        .includes('fn vmain()'));
    assert.deepEqual(glsl.map((/** @type {any} */ d)=>d.fragment.targets[0].format).sort(),
        ['bgra8unorm', 'rgba8unorm'], 'one pipeline per target format');
    const fboPipeline = glsl.find((/** @type {any} */ d)=>d.fragment.targets[0].format
        === 'rgba8unorm');
    assert.equal(fboPipeline.primitive.frontFace, 'cw', 'drawn upside down, it turns the'
        + ' other way');

    // The fixed block's row order, and the vertex block's matrices.
    const fixed = blocksAt(gpu, 0).filter((/** @type {Float32Array} */ b)=>
        b.length >= UNIFORM.floats);
    assert.deepEqual(fixed.map((/** @type {Float32Array} */ b)=>[b[UNIFORM.misc + 2],
        b[UNIFORM.misc + 3]]),
    [[-1, 16], [1, 32]], 'a framebuffer object\'s rows run up, the window\'s down');
    const vertex = blocksAt(gpu, 17);
    assert.equal(vertex[0][0], 0.5, 'the projection the program set, column by column');
    const fragment = blocksAt(gpu, 18);
    assert.deepEqual([...fragment[0].slice(0, 8)].map(v=>new Int32Array(
        new Float32Array([v]).buffer)[0]), [0, 0, 0, 0, 0, 0, 0, 0],
    'alpha and useTexture start false');
    assert.equal(new Int32Array(fragment[1].buffer, fragment[1].byteOffset)[4], 1,
        'useTexture true for the second draw');

    // The window's draw samples the texture's level: the view drawn into.
    const sampled = gpu.of('setBindGroup').flatMap((/** @type {any} */ call)=>
        call.group?.entries ?? []).find((/** @type {any} */ e)=>e.binding === 1
        && e.resource?.viewDescriptor?.label?.startsWith('gl-texture'));
    assert.ok(sampled, 'the texture is bound for the window\'s draw');
});

test('a draw sampling the texture its framebuffer draws into samples black instead', async()=>{
    const r = rig();
    const { gl } = r;
    program(gl);
    const { texture } = framebuffer(gl);
    gl.glBindTexture(GL.TEXTURE_2D, texture);
    gl.glDrawArrays(GL.TRIANGLE_FAN, 0, 4);
    await r.swap();
    assert.deepEqual(r.renderer.diagnostics().failures, [],
        'no pass both draws into and samples one texture');
    assert.ok(r.divergences.some(d=>/sampled a texture its framebuffer draws into/.test(d)));
});

test('several draw buffers: a target each, the fixed colour broadcast and a GLSL program\'s'
    + ' gl_FragData', async()=>{
    const r = rig();
    const { gl, gpu } = r;
    const { fbo } = framebuffer(gl);
    const [second] = gl.glGenTextures(1);
    gl.glBindTexture(GL.TEXTURE_2D, second);
    gl.glTexImage2D(GL.TEXTURE_2D, 0, GL.RGB, 32, 16, 0, GL.RGB, GL.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(GL.FRAMEBUFFER, fbo, false);
    gl.framebufferTexture(GL.FRAMEBUFFER, GL.COLOR_ATTACHMENT0 + 1, GL.TEXTURE_2D, second, 0);
    gl.glDrawBuffers([GL.COLOR_ATTACHMENT0, GL.COLOR_ATTACHMENT0 + 1]);
    gl.glBindTexture(GL.TEXTURE_2D, 0);
    gl.glDisableVertexAttribArrayARB(1);
    gl.glDrawArrays(GL.TRIANGLE_FAN, 0, 4);

    const prog = gl.glCreateProgram();
    const fs = gl.glCreateShader(GL.FRAGMENT_SHADER);
    gl.glShaderSource(fs, ['void main() { gl_FragData[0] = vec4(1.0); gl_FragData[1] ='
        + ' vec4(0.5); }']);
    gl.glCompileShader(fs);
    gl.glAttachShader(prog, fs);
    gl.glLinkProgram(prog);
    gl.glUseProgram(prog);
    gl.glDrawArrays(GL.TRIANGLE_FAN, 0, 4);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    await r.swap();
    assert.deepEqual(r.renderer.diagnostics().failures, []);

    const two = gpu.of('createRenderPipeline').map((/** @type {any} */ p)=>p.descriptor)
        .filter((/** @type {any} */ d)=>d.fragment.targets.length === 2);
    assert.equal(two.length, 2, 'the fixed pipeline\'s and the program\'s');
    for (const d of two)
    {
        assert.deepEqual(d.fragment.targets.map((/** @type {any} */ t)=>t.writeMask), [0xf, 0x7],
            'an RGB attachment keeps its alpha');
    }
    const fixedCode = two.find((/** @type {any} */ d)=>!d.fragment.module.descriptor.code
        .includes('fmain'));
    assert.match(fixedCode.fragment.module.descriptor.code, /out\.c1 = colour;/);
});

test('glBlitFramebuffer and glGenerateMipmap draw on the device', async()=>{
    const r = rig();
    const { gl, gpu } = r;
    const { texture, fbo } = framebuffer(gl);
    gl.bindFramebuffer(GL.READ_FRAMEBUFFER, fbo, false);
    gl.bindFramebuffer(GL.DRAW_FRAMEBUFFER, 0, false);
    gl.glBlitFramebuffer(0, 0, 32, 16, 0, 32, 64, 0, GL.COLOR_BUFFER_BIT, GL.LINEAR);
    gl.bindFramebuffer(GL.FRAMEBUFFER, 0, false);
    gl.glBindTexture(GL.TEXTURE_2D, texture);
    gl.glGenerateMipmap(GL.TEXTURE_2D);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    await r.swap();
    assert.deepEqual(r.renderer.diagnostics().failures, []);
    const stats = r.renderer.diagnostics();
    assert.equal(stats.blits, 1);
    assert.equal(stats.mipmaps, 5, '16x32 down to 1x1 is five levels below the base');
    const blit = gpu.of('createShaderModule').find((/** @type {any} */ m)=>
        m.descriptor.code.includes('BlitUniforms'));
    assert.ok(blit, 'one shader blits and makes the levels');
});

test('a blend of the constant colour sets the pass\'s constant', async()=>{
    const r = rig();
    const { gl, gpu } = r;
    gl.glEnable(GL.BLEND);
    gl.glBlendColor(0.25, 0.5, 0.75, 1);
    gl.glBlendFuncSeparate(GL.CONSTANT_COLOR, GL.ZERO, GL.ONE, GL.ZERO);
    gl.glBlendEquationSeparate(GL.FUNC_ADD, GL.MAX);
    gl.glDrawArrays(GL.TRIANGLE_FAN, 0, 4);
    await r.swap();
    assert.deepEqual(gpu.of('setBlendConstant').map((/** @type {any} */ c)=>c.color),
        [{ r: 0.25, g: 0.5, b: 0.75, a: 1 }]);
    const blend = gpu.of('createRenderPipeline').map((/** @type {any} */ p)=>p.descriptor)
        .find((/** @type {any} */ d)=>d.fragment.targets[0].blend)?.fragment.targets[0].blend;
    assert.deepEqual(blend, {
        color: { srcFactor: 'constant', dstFactor: 'zero', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
    });
});
