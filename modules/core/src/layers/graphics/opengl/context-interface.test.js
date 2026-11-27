/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Program interface queries (OpenGL 4.3 section 7.3.1): each interface's
 * resources and properties, their agreement with the older queries that
 * answer the same lists, locations by array element, and the section's errors.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { INTERFACE as I } from './context-interface.js';

/** @returns {any} */
function context(){
    const gl = createGlContext({});
    gl.attach({ width: 4, height: 4, doubleBuffered: true });
    return gl;
}

/**
 * @param {any} gl @param {[number, string][]} shaders @param {string[]} [feedback]
 * @returns {number}
 */
function program(gl, shaders, feedback){
    const made = gl.glCreateProgram();
    for (const [type, source] of shaders)
    {
        const shader = gl.glCreateShader(type);
        gl.glShaderSource(shader, [source]);
        gl.glCompileShader(shader);
        assert.deepEqual(gl.glGetShaderiv(shader, GL.COMPILE_STATUS), [1],
            gl.glGetShaderInfoLog(shader));
        gl.glAttachShader(made, shader);
    }
    if (feedback)
    {
        gl.glTransformFeedbackVaryings(made, feedback, GL.INTERLEAVED_ATTRIBS);
    }
    gl.glLinkProgram(made);
    assert.deepEqual(gl.glGetProgramiv(made, GL.LINK_STATUS), [1], gl.glGetProgramInfoLog(made));
    return made;
}

const DRAWING = /** @type {[number, string][]} */ ([[GL.VERTEX_SHADER, `#version 330
struct S { float f; vec2 g[3]; };
uniform vec4 a; uniform mat3 m[2]; uniform S st;
layout(std140) uniform B { vec4 x; mat4 y; float z[2]; };
layout(location = 2) in vec4 pos; in vec3 nrm;
out vec4 v;
void main() { v = a + vec4(m[1][0], st.f + st.g[2].x) + x + y[0] + vec4(z[1]) + vec4(nrm, 0.0);
    gl_Position = pos; }`],
[GL.FRAGMENT_SHADER, `#version 330
uniform sampler2D tex; uniform vec4 a;
in vec4 v; layout(location = 0) out vec4 c; layout(location = 1) out vec4 d[2];
void main() { c = v + texture(tex, v.xy) + a; d[0] = v; d[1] = v; }`]]);

const COMPUTING = /** @type {[number, string][]} */ ([[GL.COMPUTE_SHADER, `#version 430
layout(local_size_x = 4) in;
layout(std430, binding = 2) buffer Data { vec4 head; mat2 m; float tail[]; } data;
layout(std430) buffer Plain { uint count; };
layout(binding = 0, offset = 4) uniform atomic_uint hits;
void main() { data.tail[gl_GlobalInvocationID.x] = data.head.x + data.m[0][0];
    atomicCounterIncrement(hits); count = 1u; }`]]);

const CAPTURING = /** @type {[number, string][]} */ ([[GL.VERTEX_SHADER, `#version 330
in vec4 pos; out vec4 p; out float w[2];
void main() { p = pos; w[0] = 1.0; w[1] = 2.0; gl_Position = pos; }`]]);

/**
 * @param {any} gl @param {number} made @param {number} programInterface @param {number} index
 * @param {number} property
 */
const one = (gl, made, programInterface, index, property)=>{
    const values = gl.glGetProgramResourceiv(made, programInterface, index, [property], 16);
    assert.equal(gl.glGetError(), GL.NO_ERROR, `property 0x${property.toString(16)}`);
    return values.length === 1 ? values[0] : values;
};

/** @param {any} gl @param {number} made @param {number} programInterface */
const countOf = (gl, made, programInterface)=>gl.glGetProgramInterfaceiv(made, programInterface,
    I.ACTIVE_RESOURCES)[0];

/** @param {any} gl @param {number} made @param {number} programInterface */
const namesOf = (gl, made, programInterface)=>Array.from({
    length: countOf(gl, made, programInterface) }, (unused, k)=>gl.glGetProgramResourceName(made,
    programInterface, k, 64));

test('each list agrees with the older queries of it', ()=>{
    const gl = context();
    const programs = [program(gl, DRAWING), program(gl, COMPUTING),
        program(gl, CAPTURING, ['p', 'gl_SkipComponents1', 'w'])];
    for (const made of programs)
    {
        const uniforms = countOf(gl, made, I.UNIFORM);
        assert.equal(uniforms, gl.glGetProgramiv(made, GL.ACTIVE_UNIFORMS)[0]);
        for (let k = 0; k < uniforms; k++)
        {
            const older = gl.glGetActiveUniform(made, k);
            const name = gl.glGetProgramResourceName(made, I.UNIFORM, k, 64);
            assert.deepEqual([name, one(gl, made, I.UNIFORM, k, I.ARRAY_SIZE),
                one(gl, made, I.UNIFORM, k, I.TYPE)], [older.name, older.size, older.type]);
            assert.equal(gl.glGetProgramResourceIndex(made, I.UNIFORM, name),
                gl.glGetUniformIndices(made, [name])[0]);
            assert.equal(gl.glGetProgramResourceLocation(made, I.UNIFORM, name),
                gl.glGetUniformLocation(made, name), name);
            for (const [now, then] of [[I.OFFSET, GL.UNIFORM_OFFSET],
                [I.BLOCK_INDEX, GL.UNIFORM_BLOCK_INDEX], [I.ARRAY_STRIDE, GL.UNIFORM_ARRAY_STRIDE],
                [I.MATRIX_STRIDE, GL.UNIFORM_MATRIX_STRIDE],
                [I.IS_ROW_MAJOR, GL.UNIFORM_IS_ROW_MAJOR],
                [I.ATOMIC_COUNTER_BUFFER_INDEX, GL.UNIFORM_ATOMIC_COUNTER_BUFFER_INDEX]])
            {
                assert.equal(one(gl, made, I.UNIFORM, k, now),
                    gl.glGetActiveUniformsiv(made, [k], then)[0], `${name} 0x${now.toString(16)}`);
            }
        }
        const blocks = countOf(gl, made, I.UNIFORM_BLOCK);
        assert.equal(blocks, gl.glGetProgramiv(made, GL.ACTIVE_UNIFORM_BLOCKS)[0]);
        for (let k = 0; k < blocks; k++)
        {
            const name = gl.glGetProgramResourceName(made, I.UNIFORM_BLOCK, k, 64);
            assert.equal(name, gl.glGetActiveUniformBlockName(made, k));
            assert.equal(gl.glGetProgramResourceIndex(made, I.UNIFORM_BLOCK, name),
                gl.glGetUniformBlockIndex(made, name));
            assert.deepEqual(one(gl, made, I.UNIFORM_BLOCK, k, I.ACTIVE_VARIABLES),
                gl.glGetActiveUniformBlockiv(made, k, GL.UNIFORM_BLOCK_ACTIVE_UNIFORM_INDICES));
        }
        const counters = countOf(gl, made, I.ATOMIC_COUNTER_BUFFER);
        assert.equal(counters, gl.glGetProgramiv(made, GL.ACTIVE_ATOMIC_COUNTER_BUFFERS)?.[0]
            ?? 0);
        for (let k = 0; k < counters; k++)
        {
            assert.equal(one(gl, made, I.ATOMIC_COUNTER_BUFFER, k, I.BUFFER_DATA_SIZE),
                gl.glGetActiveAtomicCounterBufferiv(made, k,
                    GL.ATOMIC_COUNTER_BUFFER_DATA_SIZE)[0]);
        }
        if (gl.glGetAttachedShaders(made).some((/** @type {number} */ s)=>
            gl.glGetShaderiv(s, GL.SHADER_TYPE)[0] === GL.VERTEX_SHADER))
        {
            const inputs = countOf(gl, made, I.PROGRAM_INPUT);
            assert.equal(inputs, gl.glGetProgramiv(made, GL.ACTIVE_ATTRIBUTES)[0]);
            for (let k = 0; k < inputs; k++)
            {
                const older = gl.glGetActiveAttrib(made, k);
                const name = gl.glGetProgramResourceName(made, I.PROGRAM_INPUT, k, 64);
                assert.deepEqual([name, one(gl, made, I.PROGRAM_INPUT, k, I.TYPE)],
                    [older.name, older.type]);
                assert.equal(gl.glGetProgramResourceLocation(made, I.PROGRAM_INPUT, name),
                    gl.glGetAttribLocation(made, name));
            }
        }
        const captured = countOf(gl, made, I.TRANSFORM_FEEDBACK_VARYING);
        assert.equal(captured, gl.glGetProgramiv(made, GL.TRANSFORM_FEEDBACK_VARYINGS)[0]);
        for (let k = 0; k < captured; k++)
        {
            const older = gl.glGetTransformFeedbackVarying(made, k);
            assert.deepEqual([gl.glGetProgramResourceName(made, I.TRANSFORM_FEEDBACK_VARYING, k,
                64), one(gl, made, I.TRANSFORM_FEEDBACK_VARYING, k, I.ARRAY_SIZE),
            one(gl, made, I.TRANSFORM_FEEDBACK_VARYING, k, I.TYPE)],
            [older.name, older.size, older.type]);
        }
    }
    const drawing = programs[0];
    for (const name of ['c', 'd', 'd[1]'])
    {
        assert.equal(gl.glGetProgramResourceLocation(drawing, I.PROGRAM_OUTPUT, name),
            gl.fragData(drawing, name, 'location'));
        assert.equal(gl.glGetProgramResourceLocationIndex(drawing, I.PROGRAM_OUTPUT, name),
            gl.fragData(drawing, name, 'index'));
    }
    assert.equal(gl.glGetError(), GL.NO_ERROR);
});

test('a drawing program\'s uniforms, block, inputs and outputs', ()=>{
    const gl = context();
    const made = program(gl, DRAWING);
    assert.deepEqual(namesOf(gl, made, I.UNIFORM),
        ['a', 'm[0]', 'st.f', 'st.g[0]', 'tex', 'x', 'y', 'z[0]']);
    const tex = gl.glGetProgramResourceIndex(made, I.UNIFORM, 'tex');
    const a = gl.glGetProgramResourceIndex(made, I.UNIFORM, 'a');
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.UNIFORM, tex,
        [I.REFERENCED_BY_VERTEX_SHADER, I.REFERENCED_BY_FRAGMENT_SHADER, I.TYPE], 8),
    [0, 1, GL.SAMPLER_2D]);
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.UNIFORM, a,
        [I.REFERENCED_BY_VERTEX_SHADER, I.REFERENCED_BY_FRAGMENT_SHADER], 8), [1, 1],
    'one uniform of both stages');
    const z = gl.glGetProgramResourceIndex(made, I.UNIFORM, 'z');
    assert.equal(z, 7, 'an array found by its name without [0]');
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.UNIFORM, z, [I.OFFSET, I.ARRAY_STRIDE,
        I.ARRAY_SIZE, I.BLOCK_INDEX, I.LOCATION], 8), [80, 16, 2, 0, -1]);
    assert.equal(gl.glGetProgramResourceLocation(made, I.UNIFORM, 'm[1]'),
        gl.glGetProgramResourceLocation(made, I.UNIFORM, 'm') + 1);
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.UNIFORM_BLOCK, 0, [I.NAME_LENGTH,
        I.BUFFER_DATA_SIZE, I.NUM_ACTIVE_VARIABLES, I.ACTIVE_VARIABLES,
        I.REFERENCED_BY_VERTEX_SHADER, I.REFERENCED_BY_FRAGMENT_SHADER], 16),
    [2, 112, 3, 5, 6, 7, 1, 0]);
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.UNIFORM_BLOCK, 0, [I.ACTIVE_VARIABLES],
        2), [5, 6], 'as many values as the buffer takes');

    assert.deepEqual(namesOf(gl, made, I.PROGRAM_INPUT), ['pos', 'nrm']);
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.PROGRAM_INPUT, 0, [I.LOCATION, I.TYPE,
        I.REFERENCED_BY_VERTEX_SHADER, I.REFERENCED_BY_FRAGMENT_SHADER, I.IS_PER_PATCH], 8),
    [2, GL.FLOAT_VEC4, 1, 0, 0]);
    assert.deepEqual(namesOf(gl, made, I.PROGRAM_OUTPUT), ['c', 'd[0]']);
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.PROGRAM_OUTPUT, 1, [I.LOCATION,
        I.ARRAY_SIZE, I.LOCATION_INDEX, I.REFERENCED_BY_FRAGMENT_SHADER], 8), [1, 2, 0, 1]);
    assert.equal(gl.glGetProgramResourceLocation(made, I.PROGRAM_OUTPUT, 'd[1]'), 2);
    assert.equal(gl.glGetProgramResourceLocation(made, I.PROGRAM_OUTPUT, 'd[2]'), -1);
    assert.equal(gl.glGetProgramResourceLocation(made, I.PROGRAM_OUTPUT, 'gl_FragColor'), -1);
    assert.deepEqual(gl.glGetProgramInterfaceiv(made, I.UNIFORM, I.MAX_NAME_LENGTH), [8]);
    assert.deepEqual(gl.glGetProgramInterfaceiv(made, I.UNIFORM_BLOCK,
        I.MAX_NUM_ACTIVE_VARIABLES), [3]);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
});

test('a compute program\'s storage blocks, buffer variables and counters', ()=>{
    const gl = context();
    const made = program(gl, COMPUTING);
    assert.deepEqual(namesOf(gl, made, I.BUFFER_VARIABLE),
        ['Data.head', 'Data.m', 'Data.tail[0]', 'count']);
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.BUFFER_VARIABLE, 1, [I.OFFSET,
        I.MATRIX_STRIDE, I.TYPE, I.BLOCK_INDEX], 8), [16, 8, GL.FLOAT_MAT2, 0]);
    const tail = gl.glGetProgramResourceIndex(made, I.BUFFER_VARIABLE, 'Data.tail');
    assert.equal(tail, 2);
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.BUFFER_VARIABLE, tail, [I.OFFSET,
        I.ARRAY_SIZE, I.ARRAY_STRIDE, I.TOP_LEVEL_ARRAY_SIZE, I.TOP_LEVEL_ARRAY_STRIDE,
        I.REFERENCED_BY_COMPUTE_SHADER], 8), [32, 0, 4, 0, 4, 1],
    'an array sized at run time is of size 0');
    assert.deepEqual(namesOf(gl, made, I.SHADER_STORAGE_BLOCK), ['Data', 'Plain']);
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.SHADER_STORAGE_BLOCK, 0,
        [I.BUFFER_BINDING, I.BUFFER_DATA_SIZE, I.NUM_ACTIVE_VARIABLES, I.ACTIVE_VARIABLES], 8),
    [2, 36, 3, 0, 1, 2], 'one element of the last array counted');
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.SHADER_STORAGE_BLOCK, 1,
        [I.ACTIVE_VARIABLES, I.BUFFER_BINDING], 8), [3, 0]);
    gl.glShaderStorageBlockBinding(made, 1, 5);
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.SHADER_STORAGE_BLOCK, 1,
        [I.BUFFER_BINDING], 8), [5], 'the binding as set since');
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.ATOMIC_COUNTER_BUFFER, 0,
        [I.BUFFER_BINDING, I.BUFFER_DATA_SIZE, I.ACTIVE_VARIABLES,
            I.REFERENCED_BY_COMPUTE_SHADER], 8), [0, 8, 0, 1]);
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.UNIFORM, 0, [I.OFFSET,
        I.ATOMIC_COUNTER_BUFFER_INDEX, I.LOCATION], 8), [4, 0, -1]);
    assert.deepEqual(namesOf(gl, made, I.PROGRAM_INPUT), ['gl_GlobalInvocationID']);
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.PROGRAM_INPUT, 0, [I.TYPE, I.LOCATION],
        8), [GL.UNSIGNED_INT_VEC3, -1]);
    assert.equal(countOf(gl, made, I.PROGRAM_OUTPUT), 0);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
});

test('captured varyings and their buffers; a vertex stage\'s outputs', ()=>{
    const gl = context();
    const made = program(gl, CAPTURING, ['p', 'gl_SkipComponents1', 'w']);
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.TRANSFORM_FEEDBACK_VARYING, 2,
        [I.OFFSET, I.TRANSFORM_FEEDBACK_BUFFER_INDEX, I.ARRAY_SIZE], 8), [20, 0, 2]);
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.TRANSFORM_FEEDBACK_VARYING, 1,
        [I.TYPE, I.OFFSET], 8), [0, 16], 'a gap has no type');
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.TRANSFORM_FEEDBACK_BUFFER, 0,
        [I.BUFFER_BINDING, I.NUM_ACTIVE_VARIABLES, I.ACTIVE_VARIABLES,
            I.TRANSFORM_FEEDBACK_BUFFER_STRIDE], 8), [0, 2, 0, 2, 28]);
    assert.deepEqual(namesOf(gl, made, I.PROGRAM_OUTPUT), ['p', 'w[0]', 'gl_Position']);
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.PROGRAM_OUTPUT, 1, [I.ARRAY_SIZE,
        I.LOCATION, I.LOCATION_INDEX, I.REFERENCED_BY_VERTEX_SHADER], 8), [2, -1, -1, 1]);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
});

test('a separable fragment program\'s inputs carry their own locations', ()=>{
    const gl = context();
    const made = gl.glCreateShaderProgramv(GL.FRAGMENT_SHADER, [`#version 430
layout(location = 3) in vec4 v; in vec2 t[2]; layout(location = 4) in vec2 q[2]; out vec4 c;
void main() { c = v + vec4(t[1], q[1]); }`]);
    assert.deepEqual(gl.glGetProgramiv(made, GL.LINK_STATUS), [1], gl.glGetProgramInfoLog(made));
    assert.deepEqual(namesOf(gl, made, I.PROGRAM_INPUT), ['v', 't[0]', 'q[0]']);
    assert.equal(gl.glGetProgramResourceLocation(made, I.PROGRAM_INPUT, 'v'), 3);
    assert.equal(gl.glGetProgramResourceLocation(made, I.PROGRAM_INPUT, 't[1]'), -1,
        'no location given, none answered');
    assert.deepEqual(['q', 'q[1]', 'q[2]'].map(name=>gl.glGetProgramResourceLocation(made,
        I.PROGRAM_INPUT, name)), [4, 5, -1], 'an element by its suffix, within the array');
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.PROGRAM_INPUT, 1, [I.ARRAY_SIZE,
        I.TYPE, I.REFERENCED_BY_FRAGMENT_SHADER, I.REFERENCED_BY_VERTEX_SHADER], 8),
    [2, GL.FLOAT_VEC2, 1, 0]);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
});

test('an evaluation shader last: its outputs, none per patch', ()=>{
    const gl = context();
    const made = program(gl, [[GL.VERTEX_SHADER, `#version 330
in vec4 pos; out vec4 vp; void main() { vp = pos; }`],
    [0x8e88 /* TESS_CONTROL_SHADER */, `#version 400
layout(vertices = 3) out; in vec4 vp[]; patch out vec4 pp; out vec4 cv[];
void main() { pp = vp[0]; cv[gl_InvocationID] = vp[gl_InvocationID];
    gl_TessLevelOuter[0] = 1.0; }`],
    [0x8e87 /* TESS_EVALUATION_SHADER */, `#version 400
layout(triangles) in; patch in vec4 pp; in vec4 cv[]; out vec4 ev;
void main() { ev = pp; gl_Position = cv[0] * gl_TessCoord.x; }`]]);
    assert.deepEqual(namesOf(gl, made, I.PROGRAM_OUTPUT), ['ev', 'gl_Position']);
    assert.deepEqual(gl.glGetProgramResourceiv(made, I.PROGRAM_OUTPUT, 0, [I.IS_PER_PATCH,
        I.REFERENCED_BY_TESS_EVALUATION_SHADER, I.REFERENCED_BY_VERTEX_SHADER, I.LOCATION], 8),
    [0, 1, 0, -1]);
    assert.deepEqual(namesOf(gl, made, I.PROGRAM_INPUT), ['pos']);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
});

test('the section\'s errors, and the lists of what never linked', ()=>{
    const gl = context();
    const made = program(gl, DRAWING);
    /** @param {number} error @param {string} why */
    const expect = (error, why)=>assert.equal(gl.glGetError(), error, why);
    gl.glGetProgramInterfaceiv(999, I.UNIFORM, I.ACTIVE_RESOURCES);
    expect(GL.INVALID_VALUE, 'no such object');
    const shader = gl.glCreateShader(GL.VERTEX_SHADER);
    gl.glGetProgramInterfaceiv(shader, I.UNIFORM, I.ACTIVE_RESOURCES);
    expect(GL.INVALID_OPERATION, 'a shader');
    gl.glGetProgramInterfaceiv(made, GL.TEXTURE_2D, I.ACTIVE_RESOURCES);
    expect(GL.INVALID_ENUM, 'no interface');
    gl.glGetProgramInterfaceiv(made, I.UNIFORM, I.LOCATION);
    expect(GL.INVALID_ENUM, 'no interface query');
    gl.glGetProgramInterfaceiv(made, I.ATOMIC_COUNTER_BUFFER, I.MAX_NAME_LENGTH);
    expect(GL.INVALID_OPERATION, 'counter buffers have no names');
    gl.glGetProgramInterfaceiv(made, I.UNIFORM, I.MAX_NUM_ACTIVE_VARIABLES);
    expect(GL.INVALID_OPERATION, 'a uniform holds no variables');
    gl.glGetProgramInterfaceiv(made, I.UNIFORM, I.MAX_NUM_COMPATIBLE_SUBROUTINES);
    expect(GL.INVALID_OPERATION, 'nor subroutines');
    assert.deepEqual(gl.glGetProgramInterfaceiv(made, I.FRAGMENT_SUBROUTINE_UNIFORM,
        I.MAX_NUM_COMPATIBLE_SUBROUTINES), [0]);
    assert.deepEqual(gl.glGetProgramInterfaceiv(made, I.VERTEX_SUBROUTINE, I.ACTIVE_RESOURCES),
        [0]);
    expect(GL.NO_ERROR, 'subroutines: none');

    assert.equal(gl.glGetProgramResourceIndex(made, I.ATOMIC_COUNTER_BUFFER, 'x'),
        GL.INVALID_INDEX);
    expect(GL.INVALID_ENUM, 'a nameless interface has no index by name');
    assert.equal(gl.glGetProgramResourceIndex(made, I.UNIFORM, 'nothing'), GL.INVALID_INDEX);
    expect(GL.NO_ERROR, 'an unknown name is no error');
    gl.glGetProgramResourceName(made, I.UNIFORM, 99, 64);
    expect(GL.INVALID_VALUE, 'past the list');
    gl.glGetProgramResourceName(made, I.UNIFORM, 0, -1);
    expect(GL.INVALID_VALUE, 'a negative buffer');
    gl.glGetProgramResourceName(made, I.TRANSFORM_FEEDBACK_BUFFER, 0, 64);
    expect(GL.INVALID_ENUM, 'no names');

    gl.glGetProgramResourceiv(made, I.UNIFORM, 0, [], 8);
    expect(GL.INVALID_VALUE, 'no property');
    gl.glGetProgramResourceiv(made, I.UNIFORM, 0, [I.TYPE], -1);
    expect(GL.INVALID_VALUE, 'a negative buffer');
    gl.glGetProgramResourceiv(made, I.UNIFORM, 99, [I.TYPE], 8);
    expect(GL.INVALID_VALUE, 'past the list');
    gl.glGetProgramResourceiv(made, I.UNIFORM, 0, [GL.TEXTURE_2D], 8);
    expect(GL.INVALID_ENUM, 'no property at all');
    gl.glGetProgramResourceiv(made, I.UNIFORM, 0, [I.TYPE, I.TOP_LEVEL_ARRAY_SIZE], 8);
    expect(GL.INVALID_OPERATION, 'a property not of uniforms');
    gl.glGetProgramResourceiv(made, I.PROGRAM_INPUT, 0, [I.LOCATION_INDEX], 8);
    expect(GL.INVALID_OPERATION, 'an input has no location index');

    gl.glGetProgramResourceLocation(made, I.UNIFORM_BLOCK, 'B');
    expect(GL.INVALID_ENUM, 'blocks have no location');
    gl.glGetProgramResourceLocationIndex(made, I.PROGRAM_INPUT, 'pos');
    expect(GL.INVALID_ENUM, 'only outputs have location indices');
    const unlinked = gl.glCreateProgram();
    assert.deepEqual(gl.glGetProgramInterfaceiv(unlinked, I.UNIFORM, I.ACTIVE_RESOURCES), [0]);
    assert.equal(gl.glGetProgramResourceIndex(unlinked, I.UNIFORM, 'a'), GL.INVALID_INDEX);
    expect(GL.NO_ERROR, 'never linked: no resource');
    assert.equal(gl.glGetProgramResourceLocation(unlinked, I.UNIFORM, 'a'), -1);
    expect(GL.INVALID_OPERATION, 'a location of what never linked');
    assert.equal(gl.glGetProgramResourceLocation(made, I.FRAGMENT_SUBROUTINE_UNIFORM, 's'), -1);
    expect(GL.NO_ERROR, 'a subroutine uniform: none, so no location');
});
