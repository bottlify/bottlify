/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * OpenGL 3.0 and 3.1's program calls against the specification: unsigned
 * uniforms (section 2.20.3 of 3.0), fragment data locations (3.9.2 of 3.0,
 * 3.3's indexed form), the uniform buffer binding points and the uniform
 * block queries (2.11.4 of 3.1, GL_ARB_uniform_buffer_object) -- the errors
 * each call is defined to raise and what the queries answer.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';

/** @returns {any} a context attached to a window */
function fixture(){
    const context = createGlContext({});
    context.attach({ width: 64, height: 32, doubleBuffered: true, depthBits: 24 });
    return context;
}

/**
 * @param {any} gl @param {string} vs @param {string} fs
 * @param {(program: number) => void} [before]  calls before the link
 * @returns {number}
 */
function program(gl, vs, fs, before = ()=>{}){
    const name = gl.glCreateProgram();
    for (const [type, text] of [[GL.VERTEX_SHADER, vs], [GL.FRAGMENT_SHADER, fs]])
    {
        const shader = gl.glCreateShader(type);
        gl.glShaderSource(shader, [text]);
        gl.glCompileShader(shader);
        assert.deepEqual(gl.glGetShaderiv(shader, GL.COMPILE_STATUS), [1],
            gl.glGetShaderInfoLog(shader));
        gl.glAttachShader(name, shader);
    }
    before(name);
    gl.glLinkProgram(name);
    assert.deepEqual(gl.glGetProgramiv(name, GL.LINK_STATUS), [1], gl.glGetProgramInfoLog(name));
    return name;
}

const VS = `#version 140
in vec4 position;
layout(std140) uniform Frame { mat4 view; vec3 eye; float time; } frame;
uniform Lights { vec4 colour[3]; ivec2 count; };
void main() { gl_Position = frame.view * position * frame.time + colour[count.x]; }`;
const FS = `#version 140
out vec4 c; out vec4 glow;
uniform Lights { vec4 colour[3]; ivec2 count; };
uniform uint mask; uniform uvec2 pair;
void main() { c = colour[0] * float(mask); glow = vec4(pair, 0, 1); }`;

test('glUniform*ui writes an unsigned uniform only, and glGetUniformuiv reads it unsigned', ()=>{
    const gl = fixture();
    const prog = program(gl, VS, FS);
    gl.glUseProgram(prog);
    const mask = gl.glGetUniformLocation(prog, 'mask');
    const pair = gl.glGetUniformLocation(prog, 'pair');
    gl.uniform(mask, 1, [0xffffffff], 'u', 1);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.getUniform(prog, mask), { values: [0xffffffff], float: false,
        unsigned: true });
    gl.uniform(mask, 1, [3], 'i', 1);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'an int form into a uint');
    gl.uniform(pair, 1, [1, 2], 'u', 1);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a size other than the uniform\'s');
    gl.uniform(pair, 1, [1, 2], 'u', 2);
    assert.deepEqual(gl.getUniform(prog, pair)?.values, [1, 2]);
    const types = Object.fromEntries([0, 1, 2, 3, 4, 5, 6, 7].map(k=>gl.glGetActiveUniform(prog,
        k)).filter(Boolean).map((/** @type {any} */ u)=>[u.name, u.type]));
    assert.equal(types.mask, GL.UNSIGNED_INT);
    assert.equal(types.pair, GL.UNSIGNED_INT_VEC2);
});

test('fragment data locations: bound for the next link, asked of the last one', ()=>{
    const gl = fixture();
    const prog = program(gl, VS, FS, name=>{
        gl.bindFragData(name, 1, 0, 'c');
        gl.bindFragData(name, 0, 0, 'glow');
    });
    assert.equal(gl.fragData(prog, 'c', 'location'), 1);
    assert.equal(gl.fragData(prog, 'glow', 'location'), 0);
    assert.equal(gl.fragData(prog, 'c', 'index'), 0);
    assert.equal(gl.fragData(prog, 'nothing', 'location'), -1);
    assert.equal(gl.fragData(prog, 'c[0]', 'location'), -1, 'not an array');
    assert.equal(gl.glGetError(), GL.NO_ERROR);

    gl.bindFragData(prog, 4, 0, 'c');
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past MAX_DRAW_BUFFERS');
    gl.bindFragData(prog, 1, 1, 'c');
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past MAX_DUAL_SOURCE_DRAW_BUFFERS');
    gl.bindFragData(prog, 0, 0, 'gl_FragColor');
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a reserved name');
    assert.equal(gl.fragData(prog, 'c', 'location'), 1, 'what the last link made');

    const unlinked = gl.glCreateProgram();
    assert.equal(gl.fragData(unlinked, 'c', 'location'), -1);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
});

test('a program\'s blocks: their indices, sizes, members, stages and binding points', ()=>{
    const gl = fixture();
    const prog = program(gl, VS, FS);
    assert.deepEqual(gl.glGetProgramiv(prog, GL.ACTIVE_UNIFORM_BLOCKS), [2]);
    assert.deepEqual(gl.glGetProgramiv(prog, GL.ACTIVE_UNIFORM_BLOCK_MAX_NAME_LENGTH), [7]);
    const frame = gl.glGetUniformBlockIndex(prog, 'Frame');
    const lights = gl.glGetUniformBlockIndex(prog, 'Lights');
    assert.deepEqual([frame, lights].sort(), [0, 1]);
    assert.equal(gl.glGetUniformBlockIndex(prog, 'frame'), GL.INVALID_INDEX,
        'an instance name is no block name');
    assert.equal(gl.glGetActiveUniformBlockName(prog, frame), 'Frame');
    /** @param {number} block @param {number} pname */
    const ask = (block, pname)=>gl.glGetActiveUniformBlockiv(prog, block, pname);
    assert.deepEqual(ask(frame, GL.UNIFORM_BLOCK_DATA_SIZE), [80], 'mat4 64, vec3 + float 16');
    assert.deepEqual(ask(lights, GL.UNIFORM_BLOCK_DATA_SIZE), [64]);
    assert.deepEqual(ask(frame, GL.UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER), [1]);
    assert.deepEqual(ask(frame, GL.UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER), [0]);
    assert.deepEqual(ask(lights, GL.UNIFORM_BLOCK_REFERENCED_BY_FRAGMENT_SHADER), [1]);
    assert.deepEqual(ask(frame, GL.UNIFORM_BLOCK_ACTIVE_UNIFORMS), [3]);
    assert.deepEqual(ask(frame, GL.UNIFORM_BLOCK_BINDING), [0]);
    ask(5, GL.UNIFORM_BLOCK_BINDING);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past the blocks');
    ask(frame, GL.UNIFORM_BLOCK_INDEX);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);

    gl.glUniformBlockBinding(prog, frame, 7);
    assert.deepEqual(ask(frame, GL.UNIFORM_BLOCK_BINDING), [7]);
    gl.glUniformBlockBinding(prog, frame, 24);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past MAX_UNIFORM_BUFFER_BINDINGS');
    gl.glUniformBlockBinding(prog, 9, 0);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glLinkProgram(prog);
    assert.deepEqual(ask(frame, GL.UNIFORM_BLOCK_BINDING), [0], 'a link starts them again');
});

test('a block\'s uniforms: listed after the default block\'s, Block.member where it has an'
    + ' instance, with std140 offsets and strides', ()=>{
    const gl = fixture();
    const prog = program(gl, VS, FS);
    const names = ['Frame.view', 'Frame.eye', 'Frame.time', 'colour', 'count', 'mask', 'view'];
    const indices = gl.glGetUniformIndices(prog, names);
    assert.equal(indices[6], GL.INVALID_INDEX, 'a member of an instanced block by its own name');
    const found = indices.slice(0, 6);
    assert.ok(found.every((/** @type {number} */ k)=>k !== GL.INVALID_INDEX));
    /** @param {number} pname */
    const ask = pname=>gl.glGetActiveUniformsiv(prog, found, pname);
    const frame = gl.glGetUniformBlockIndex(prog, 'Frame');
    const lights = gl.glGetUniformBlockIndex(prog, 'Lights');
    assert.deepEqual(ask(GL.UNIFORM_BLOCK_INDEX), [frame, frame, frame, lights, lights, -1]);
    assert.deepEqual(ask(GL.UNIFORM_OFFSET), [0, 64, 76, 0, 48, -1]);
    assert.deepEqual(ask(GL.UNIFORM_ARRAY_STRIDE), [0, 0, 0, 16, 0, -1]);
    assert.deepEqual(ask(GL.UNIFORM_MATRIX_STRIDE), [16, 0, 0, 0, 0, -1]);
    assert.deepEqual(ask(GL.UNIFORM_SIZE), [1, 1, 1, 3, 1, 1]);
    assert.deepEqual(ask(GL.UNIFORM_TYPE), [GL.FLOAT_MAT4, GL.FLOAT_VEC3, GL.FLOAT,
        GL.FLOAT_VEC4, GL.INT_VEC2, GL.UNSIGNED_INT]);
    assert.deepEqual(ask(GL.UNIFORM_IS_ROW_MAJOR), [0, 0, 0, 0, 0, 0]);
    assert.deepEqual(ask(GL.UNIFORM_NAME_LENGTH), [11, 10, 11, 10, 6, 5]);
    assert.equal(gl.glGetActiveUniformName(prog, found[3]), 'colour[0]');
    assert.equal(gl.glGetUniformLocation(prog, 'colour'), -1, 'a block member has no location');
    assert.deepEqual(gl.glGetProgramiv(prog, GL.ACTIVE_UNIFORMS), [7]);
    gl.glGetActiveUniformsiv(prog, [0, 7], GL.UNIFORM_TYPE);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'an index past the uniforms');
    gl.glGetActiveUniformsiv(prog, [0], GL.UNIFORM_BLOCK_BINDING);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
});

test('the uniform buffer points refuse an offset off the alignment, a size of zero, a point past'
    + ' the last and a target with none', ()=>{
    const gl = fixture();
    const [a, b] = gl.glGenBuffersARB(2);
    gl.glBindBufferBase(GL.UNIFORM_BUFFER, 2, a);
    assert.deepEqual(gl.glGetIntegerv(GL.UNIFORM_BUFFER_BINDING), [a], 'the general binding too');
    gl.glBindBufferRange(GL.UNIFORM_BUFFER, 5, b, 512, 64);
    assert.deepEqual(gl.glGetIntegerv(GL.UNIFORM_BUFFER_BINDING), [b]);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    gl.glBindBufferRange(GL.UNIFORM_BUFFER, 5, b, 100, 64);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE,
        'an offset off UNIFORM_BUFFER_OFFSET_ALIGNMENT');
    gl.glBindBufferRange(GL.UNIFORM_BUFFER, 5, b, 0, 0);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a size of zero');
    gl.glBindBufferBase(GL.UNIFORM_BUFFER, 24, a);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past MAX_UNIFORM_BUFFER_BINDINGS');
    gl.glBindBufferBase(GL.ARRAY_BUFFER, 0, a);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'not an indexed target');
    assert.deepEqual(gl.glGetIntegerv(GL.UNIFORM_BUFFER_OFFSET_ALIGNMENT), [256]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_UNIFORM_BUFFER_BINDINGS), [24]);
    gl.glDeleteBuffersARB([b]);
    assert.deepEqual(gl.glGetIntegerv(GL.UNIFORM_BUFFER_BINDING), [0],
        'the general binding held b last');
});

// The indexed queries are the context's glGetIntegeri_v (context-indexed.js),
// which reads the points through kernel.side.indexed.
test('the uniform buffer points answer their buffer, start and size, and a deleted buffer'
    + ' leaves them', { skip: typeof fixture().glGetIntegeri_v !== 'function'
    && 'glGetIntegeri_v comes with context-indexed.js' }, ()=>{
    const gl = fixture();
    const [a, b] = gl.glGenBuffersARB(2);
    gl.glBindBufferBase(GL.UNIFORM_BUFFER, 2, a);
    assert.deepEqual(gl.glGetIntegeri_v(GL.UNIFORM_BUFFER_BINDING, 2), [a]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.UNIFORM_BUFFER_START, 2), [0]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.UNIFORM_BUFFER_SIZE, 2), [0]);
    gl.glBindBufferRange(GL.UNIFORM_BUFFER, 5, b, 512, 64);
    assert.deepEqual([GL.UNIFORM_BUFFER_BINDING, GL.UNIFORM_BUFFER_START,
        GL.UNIFORM_BUFFER_SIZE].map(p=>gl.glGetIntegeri_v(p, 5)[0]), [b, 512, 64]);
    gl.glBindBufferRange(GL.UNIFORM_BUFFER, 5, b, 100, 64);
    assert.deepEqual(gl.glGetIntegeri_v(GL.UNIFORM_BUFFER_START, 5), [512],
        'a refused call leaves it');
    gl.glGetError();
    gl.glGetIntegeri_v(GL.UNIFORM_BUFFER_BINDING, 30);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glDeleteBuffersARB([b]);
    assert.deepEqual(gl.glGetIntegeri_v(GL.UNIFORM_BUFFER_BINDING, 5), [0],
        'a deleted buffer leaves its points');
    gl.glBindBufferBase(GL.UNIFORM_BUFFER, 2, 0);
    assert.deepEqual(gl.glGetIntegeri_v(GL.UNIFORM_BUFFER_BINDING, 2), [0]);
});
