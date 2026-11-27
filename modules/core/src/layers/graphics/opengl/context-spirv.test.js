/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * SPIR-V shaders through the context (OpenGL 4.6 sections 7.2, 7.2.1 and
 * 7.3, GL_ARB_gl_spirv): glShaderBinary associates a module, glSpecializeShader
 * compiles its entry point with the constants given, a program is linked of
 * SPIR-V shaders alone and draws and dispatches as a GLSL one does; each
 * call's errors are the extension's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { createOpengl } from './exports.js';
import { computeRig } from './compute-fixture.js';
import { spirvFixture } from './spirv-fixtures.js';

/** @returns {any} */
function context(){
    const bytes = new Uint8Array(0x1000);
    const gl = createGlContext({ memory: {
        read: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.slice(at, at + n),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ v)=>bytes.set(v, at),
    } });
    gl.attach({ width: 8, height: 8, doubleBuffered: true, depthBits: 24 });
    return gl;
}

/**
 * A shader of `type` given the fixture's module, specialized when an entry
 * point is named.
 *
 * @param {any} gl @param {number} type @param {string} fixture
 * @param {string | null} [entry] @param {[number, number][]} [constants]
 */
function spirvShader(gl, type, fixture, entry = 'main', constants = []){
    const shader = gl.glCreateShader(type);
    const bytes = spirvFixture(fixture);
    gl.glShaderBinary([shader], GL.SHADER_BINARY_FORMAT_SPIR_V, bytes.length, bytes);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    if (entry !== null)
    {
        gl.glSpecializeShader(shader, entry, constants.map(c=>c[0]), constants.map(c=>c[1]));
        assert.equal(gl.glGetError(), GL.NO_ERROR);
        assert.deepEqual(gl.glGetShaderiv(shader, GL.COMPILE_STATUS), [1],
            gl.glGetShaderInfoLog(shader));
    }
    return shader;
}

/** @param {any} gl @param {number[]} shaders */
function linked(gl, shaders){
    const program = gl.glCreateProgram();
    for (const shader of shaders)
    {
        gl.glAttachShader(program, shader);
    }
    gl.glLinkProgram(program);
    return program;
}

test('SPIR-V is the one binary format, and no SPIR-V extension is taken', ()=>{
    const gl = context();
    assert.deepEqual(gl.glGetIntegerv(GL.NUM_SHADER_BINARY_FORMATS), [1]);
    assert.deepEqual(gl.glGetIntegerv(GL.SHADER_BINARY_FORMATS), [GL.SHADER_BINARY_FORMAT_SPIR_V]);
    assert.deepEqual(gl.glGetIntegerv(GL.NUM_SPIR_V_EXTENSIONS), [0]);
    assert.equal(gl.glGetStringi(GL.SPIR_V_EXTENSIONS, 0), null);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'no index names one');
    gl.glGetStringi(GL.VERSION, 0);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'still the only two lists');
});

test('glShaderBinary associates the module, dropping the source and the compile', ()=>{
    const gl = context();
    const [a, b] = [gl.glCreateShader(GL.VERTEX_SHADER), gl.glCreateShader(GL.VERTEX_SHADER)];
    gl.glShaderSource(a, ['void main() { gl_Position = vec4(0.0); }']);
    gl.glCompileShader(a);
    assert.deepEqual(gl.glGetShaderiv(a, GL.COMPILE_STATUS), [1]);
    assert.deepEqual(gl.glGetShaderiv(a, GL.SPIR_V_BINARY), [0]);
    const bytes = spirvFixture('vertex');
    gl.glShaderBinary([a, b], GL.SHADER_BINARY_FORMAT_SPIR_V, bytes.length, bytes);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'two of one type: SPIR-V allows it');
    for (const shader of [a, b])
    {
        assert.deepEqual(gl.glGetShaderiv(shader, GL.SPIR_V_BINARY), [1]);
        assert.deepEqual(gl.glGetShaderiv(shader, GL.COMPILE_STATUS), [0]);
        assert.deepEqual(gl.glGetShaderiv(shader, GL.SHADER_SOURCE_LENGTH), [0]);
    }
    gl.glCompileShader(a);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a SPIR-V shader is not compiled');

    const c = gl.glCreateShader(GL.FRAGMENT_SHADER);
    gl.glShaderBinary([c], GL.SHADER_BINARY_FORMAT_SPIR_V, 8, new Uint8Array(8));
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'not a module');
    assert.deepEqual(gl.glGetShaderiv(c, GL.SPIR_V_BINARY), [0]);
    gl.glShaderBinary([c], GL.SHADER_BINARY_FORMAT_SPIR_V, -1, bytes);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glShaderBinary([77], GL.SHADER_BINARY_FORMAT_SPIR_V, bytes.length, bytes);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'no object');
    gl.glShaderBinary([gl.glCreateProgram()], GL.SHADER_BINARY_FORMAT_SPIR_V, bytes.length, bytes);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a program');
    gl.glShaderBinary([c], 0x1234, 16, bytes);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'another format is still no format');

    gl.glShaderSource(a, ['void main() { gl_Position = vec4(1.0); }']);
    assert.deepEqual(gl.glGetShaderiv(a, GL.SPIR_V_BINARY), [0], 'a source breaks it');
    gl.glCompileShader(a);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
});

test('glSpecializeShader\'s errors are the extension\'s, and it specializes once', ()=>{
    const gl = context();
    const shader = spirvShader(gl, GL.VERTEX_SHADER, 'twoEntries', null);
    gl.glSpecializeShader(99, 'vs', [], []);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'no object');
    gl.glSpecializeShader(gl.glCreateProgram(), 'vs', [], []);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a program');
    const plain = gl.glCreateShader(GL.VERTEX_SHADER);
    gl.glSpecializeShader(plain, 'vs', [], []);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no module');
    gl.glSpecializeShader(shader, 'main', [], []);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'no such entry point');
    gl.glSpecializeShader(shader, 'fs', [], []);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'the fragment stage\'s');
    gl.glSpecializeShader(shader, 'vs', [10], [0]);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'no SpecId 10');
    assert.deepEqual(gl.glGetShaderiv(shader, GL.COMPILE_STATUS), [0], 'nothing done');
    gl.glSpecializeShader(shader, 'vs', [9], [0]);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetShaderiv(shader, GL.COMPILE_STATUS), [1]);
    gl.glSpecializeShader(shader, 'vs', [], []);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'specialized already');
    const bytes = spirvFixture('twoEntries');
    gl.glShaderBinary([shader], GL.SHADER_BINARY_FORMAT_SPIR_V, bytes.length, bytes);
    assert.deepEqual(gl.glGetShaderiv(shader, GL.COMPILE_STATUS), [0]);
    gl.glSpecializeShader(shader, 'vs', [], []);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'the module given again: specialized again');

    const refused = spirvShader(gl, GL.FRAGMENT_SHADER, 'refuse_push', null);
    gl.glSpecializeShader(refused, 'main', [], []);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'a failure is the compile status, not an error');
    assert.deepEqual(gl.glGetShaderiv(refused, GL.COMPILE_STATUS), [0]);
    assert.match(gl.glGetShaderInfoLog(refused), /^ERROR: SPIR-V: push constants/);
    gl.glSpecializeShader(refused, 'main', [], []);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'a failed one may be tried again (A232)');
});

test('a program links SPIR-V shaders alone, specialized, their interfaces matched by location',
    ()=>{
        const gl = context();
        const vertex = spirvShader(gl, GL.VERTEX_SHADER, 'vertex');
        const fragment = spirvShader(gl, GL.FRAGMENT_SHADER, 'fragment');
        const good = linked(gl, [vertex, fragment]);
        assert.deepEqual(gl.glGetProgramiv(good, GL.LINK_STATUS), [1],
            gl.glGetProgramInfoLog(good));

        const source = gl.glCreateShader(GL.FRAGMENT_SHADER);
        gl.glShaderSource(source, ['#version 330\nout vec4 c; void main() { c = vec4(1.0); }']);
        gl.glCompileShader(source);
        const mixed = linked(gl, [vertex, source]);
        assert.deepEqual(gl.glGetProgramiv(mixed, GL.LINK_STATUS), [0]);
        assert.match(gl.glGetProgramInfoLog(mixed), /SPIR-V shaders and shaders from source/);

        const unspecialized = linked(gl, [vertex,
            spirvShader(gl, GL.FRAGMENT_SHADER, 'fragment', null)]);
        assert.deepEqual(gl.glGetProgramiv(unspecialized, GL.LINK_STATUS), [0]);
        assert.match(gl.glGetProgramInfoLog(unspecialized), /not compiled/);

        // Location 0 a vec4 out of the vertex stage, a vec3 into the fragment one.
        const mismatched = linked(gl, [vertex,
            spirvShader(gl, GL.FRAGMENT_SHADER, 'mismatch')]);
        assert.deepEqual(gl.glGetProgramiv(mismatched, GL.LINK_STATUS), [0]);
    });

test('a SPIR-V program draws, its default uniforms set by location', async()=>{
    const r = computeRig();
    const { gl } = r;
    const program = linked(gl, [
        spirvShader(gl, GL.VERTEX_SHADER, 'vertex', 'main', [[3, 0x3f800000]]),
        spirvShader(gl, GL.FRAGMENT_SHADER, 'fragment', 'main', [[7, 2]])]);
    assert.deepEqual(gl.glGetProgramiv(program, GL.LINK_STATUS), [1],
        gl.glGetProgramInfoLog(program));
    gl.glUseProgram(program);
    gl.uniform(4, 1, [0.5], 'f', 1);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'the fragment stage\'s scale, at location 4');
    const block = r.buffer(GL.UNIFORM_BUFFER, new Uint8Array(128));
    gl.glBindBufferBase(GL.UNIFORM_BUFFER, 1, block);
    r.bytes.set(new Uint8Array(new Float32Array([0, 0, 0, 1, 1, 0, 0, 1, 0, 1, 0, 1]).buffer),
        0x1000);
    gl.glVertexAttribPointerARB(0, 3, GL.FLOAT, 0, 16, 0x1000);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    await r.swap();
    assert.deepEqual(r.renderer.diagnostics().failures, []);
    assert.deepEqual(r.divergences, []);
    assert.equal(r.gpu.of('draw').length, 1);
    const code = r.gpu.of('createShaderModule').map((/** @type {any} */ m)=>m.descriptor.code)
        .find((/** @type {string} */ text)=>text.includes('VertexOut'));
    assert.match(code, /@location\(0\) i0: vec4f/);
    assert.match(code, /@location\(1\) @interpolate\(flat\) i1: i32/);
});

test('a SPIR-V compute program dispatches with the work group its constant gives', async()=>{
    const r = computeRig();
    const { gl } = r;
    const program = linked(gl, [spirvShader(gl, GL.COMPUTE_SHADER, 'computeOptimized', 'main',
        [[0, 4]])]);
    assert.deepEqual(gl.glGetProgramiv(program, GL.LINK_STATUS), [1],
        gl.glGetProgramInfoLog(program));
    assert.deepEqual(gl.glGetProgramiv(program, GL.COMPUTE_WORK_GROUP_SIZE), [4, 2, 1]);
    gl.glUseProgram(program);
    gl.glBindBufferBase(GL.SHADER_STORAGE_BUFFER, 0,
        r.buffer(GL.SHADER_STORAGE_BUFFER, new Uint8Array(256)));
    gl.glBindBufferBase(GL.SHADER_STORAGE_BUFFER, 1,
        r.buffer(GL.SHADER_STORAGE_BUFFER, new Uint8Array(256)));
    gl.glBindBufferBase(GL.ATOMIC_COUNTER_BUFFER, 0,
        r.buffer(GL.ATOMIC_COUNTER_BUFFER, new Uint8Array(16)));
    gl.glDispatchCompute(2, 1, 1);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    await r.swap();
    const [dispatched] = r.gpu.of('dispatchWorkgroups');
    assert.deepEqual(dispatched.grid, [2, 1, 1]);
    assert.match(dispatched.pipeline.descriptor.compute.module.descriptor.code,
        /@workgroup_size\(4, 2, 1\)/);
});

test('the exports read the module and the specialization from guest memory', ()=>{
    const bytes = new Uint8Array(0x20000);
    let next = 0x100;
    const opengl = createOpengl({
        readMemory: (at, length)=>bytes.subarray(at, at + length),
        writeMemory: (at, value)=>bytes.set(value, at),
        screen: ()=>({ width: 4, height: 4 }),
        scratch: { allocate: size=>{
            const at = next;
            next += (size + 16) & ~15;
            return at;
        } },
        exportAddress: ()=>0x7000_0000,
        pointerSize: 4,
    });
    const table = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        opengl.table);
    assert.equal(table.wglSetPixelFormat.handler([0x900d, 1, 0]), 1);
    assert.equal(table.wglMakeCurrent.handler([0x900d,
        table.wglCreateContext.handler([0x900d])]), 1);
    /** @param {Uint8Array} data */
    const put = data=>{
        const at = next;
        bytes.set(data, at);
        next += (data.length + 16) & ~15;
        return at;
    };
    /** @param {number[]} values */
    const words = values=>put(new Uint8Array(new Uint32Array(values).buffer));
    const module = spirvFixture('twoEntries');
    const shader = table.glCreateShader.handler([GL.FRAGMENT_SHADER]);
    table.glShaderBinary.handler([1, words([shader]), GL.SHADER_BINARY_FORMAT_SPIR_V,
        put(module), module.length]);
    const out = words([7]);
    table.glGetShaderiv.handler([shader, GL.SPIR_V_BINARY, out]);
    assert.equal(new DataView(bytes.buffer).getInt32(out, true), 1);
    for (const name of ['glSpecializeShader', 'glSpecializeShaderARB'])
    {
        table.glShaderBinary.handler([1, words([shader]), GL.SHADER_BINARY_FORMAT_SPIR_V,
            put(module), module.length]);
        table[name].handler([shader, put(new TextEncoder().encode('fs\0')), 1, words([9]),
            words([0x3f000000])]);
        assert.equal(table.glGetError.handler([]), GL.NO_ERROR, name);
        table.glGetShaderiv.handler([shader, GL.COMPILE_STATUS, out]);
        assert.equal(new DataView(bytes.buffer).getInt32(out, true), 1, name);
    }
});
