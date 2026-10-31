/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * OpenGL 2.1's shader and program objects against the specification
 * (section 2.15 and the errors of section 2.15.3 and 6.1.15): the object
 * model, compiling and linking, the program in use, and the typed uniform
 * calls -- every error a call is defined to raise and the state the queries
 * answer after it.
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

const VS = 'attribute vec4 position; uniform mat4 mvp;\n'
    + 'void main() { gl_Position = mvp * position; }';
const FS = 'uniform vec4 tint; uniform float weights[3]; uniform bool on; uniform ivec2 counts;\n'
    + 'uniform sampler2D image; uniform mat2x3 skew;\n'
    + 'void main() { gl_FragColor = tint * weights[2] * float(counts.y)'
    + ' + texture2D(image, vec2(0.5)) + vec4(skew * vec2(1.0), on ? 1.0 : 0.0); }';

/**
 * @param {any} gl @param {number} type @param {string} source
 * @returns {number}
 */
function shader(gl, type, source){
    const name = gl.glCreateShader(type);
    gl.glShaderSource(name, [source]);
    gl.glCompileShader(name);
    return name;
}

/** @param {any} gl @returns {number} a linked program of VS and FS */
function program(gl){
    const name = gl.glCreateProgram();
    gl.glAttachShader(name, shader(gl, GL.VERTEX_SHADER, VS));
    gl.glAttachShader(name, shader(gl, GL.FRAGMENT_SHADER, FS));
    gl.glLinkProgram(name);
    assert.deepEqual(gl.glGetProgramiv(name, GL.LINK_STATUS), [1], gl.glGetProgramInfoLog(name));
    return name;
}

test('shaders and programs share a namespace, and a name of one is no name of the other', ()=>{
    const gl = fixture();
    const vs = gl.glCreateShader(GL.VERTEX_SHADER);
    const prog = gl.glCreateProgram();
    assert.deepEqual([vs, prog], [1, 2], 'the lowest unused names, one namespace');
    assert.equal(gl.glCreateShader(0x1234), 0);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);

    gl.glCompileShader(prog);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a program is not a shader');
    gl.glCompileShader(99);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a name that is neither');
    gl.glLinkProgram(vs);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
    assert.deepEqual([gl.glIsShader(vs), gl.glIsShader(prog), gl.glIsProgram(prog)],
        [GL.TRUE, GL.FALSE, GL.TRUE]);
    assert.equal(gl.glGetShaderiv(vs, 0x1234), null);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.glShaderSource(vs, null);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a count below zero');
});

test('a compile reports its status, its log and its source with their terminators', ()=>{
    const gl = fixture();
    const good = shader(gl, GL.FRAGMENT_SHADER, 'void main() { gl_FragColor = vec4(1.0); }');
    assert.deepEqual(gl.glGetShaderiv(good, GL.COMPILE_STATUS), [1]);
    assert.deepEqual(gl.glGetShaderiv(good, GL.INFO_LOG_LENGTH), [0], 'an empty log is zero');
    assert.deepEqual(gl.glGetShaderiv(good, GL.SHADER_TYPE), [GL.FRAGMENT_SHADER]);
    assert.deepEqual(gl.glGetShaderiv(good, GL.SHADER_SOURCE_LENGTH),
        ['void main() { gl_FragColor = vec4(1.0); }'.length + 1]);

    const bad = shader(gl, GL.FRAGMENT_SHADER, 'void main() { gl_FragColor = nothing; }');
    assert.deepEqual(gl.glGetShaderiv(bad, GL.COMPILE_STATUS), [0]);
    const log = gl.glGetShaderInfoLog(bad);
    assert.match(log, /^ERROR: 0:1: 'nothing' : undeclared identifier\n$/);
    assert.deepEqual(gl.glGetShaderiv(bad, GL.INFO_LOG_LENGTH), [log.length + 1],
        'the length counts the terminator');
    assert.equal(gl.glGetShaderSource(bad), 'void main() { gl_FragColor = nothing; }');
});

test('a link of a shader that did not compile fails and says why', ()=>{
    const gl = fixture();
    const prog = gl.glCreateProgram();
    gl.glAttachShader(prog, shader(gl, GL.FRAGMENT_SHADER, 'void main() { broken }'));
    gl.glLinkProgram(prog);
    assert.deepEqual(gl.glGetProgramiv(prog, GL.LINK_STATUS), [0]);
    assert.match(gl.glGetProgramInfoLog(prog), /not compiled/);
    gl.glUseProgram(prog);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'an unlinked program cannot be used');
    assert.deepEqual(gl.glGetIntegerv(GL.CURRENT_PROGRAM), [0]);
});

test('attaching twice, and detaching what is not attached, are operation errors', ()=>{
    const gl = fixture();
    const prog = gl.glCreateProgram();
    const vs = shader(gl, GL.VERTEX_SHADER, VS);
    gl.glAttachShader(prog, vs);
    gl.glAttachShader(prog, vs);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
    const other = shader(gl, GL.VERTEX_SHADER, VS);
    gl.glAttachShader(prog, other);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'two shaders of one stage are allowed');
    assert.deepEqual(gl.glGetAttachedShaders(prog), [vs, other]);
    gl.glDetachShader(prog, other);
    gl.glDetachShader(prog, other);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
    assert.deepEqual(gl.glGetProgramiv(prog, GL.ATTACHED_SHADERS), [1]);
});

test('deleting waits while something holds the object', ()=>{
    const gl = fixture();
    const prog = program(gl);
    const [vs] = gl.glGetAttachedShaders(prog);
    gl.glDeleteShader(vs);
    assert.equal(gl.glIsShader(vs), GL.TRUE, 'an attached shader is only flagged');
    assert.deepEqual(gl.glGetShaderiv(vs, GL.DELETE_STATUS), [1]);
    gl.glUseProgram(prog);
    gl.glDeleteProgram(prog);
    assert.equal(gl.glIsProgram(prog), GL.TRUE, 'the program in use is only flagged');
    assert.deepEqual(gl.glGetProgramiv(prog, GL.DELETE_STATUS), [1]);
    assert.deepEqual(gl.glGetIntegerv(GL.CURRENT_PROGRAM), [prog]);
    gl.glUseProgram(0);
    assert.equal(gl.glIsProgram(prog), GL.FALSE, 'and goes when it is no longer in use');
    assert.equal(gl.glIsShader(vs), GL.FALSE, 'taking its flagged shaders with it');
    gl.glDeleteProgram(0);
    gl.glDeleteShader(0);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'zero is quietly nothing');
});

test('the active attributes and uniforms, their locations, and the queries of them', ()=>{
    const gl = fixture();
    const prog = program(gl);
    assert.deepEqual(gl.glGetProgramiv(prog, GL.ACTIVE_ATTRIBUTES), [1]);
    assert.deepEqual(gl.glGetActiveAttrib(prog, 0), { name: 'position', size: 1,
        type: GL.FLOAT_VEC4 });
    assert.equal(gl.glGetAttribLocation(prog, 'position'), 0);
    assert.equal(gl.glGetAttribLocation(prog, 'gl_Vertex'), -1);
    assert.deepEqual(gl.glGetProgramiv(prog, GL.ACTIVE_UNIFORMS), [7]);
    const active = Array.from({ length: 7 }, (_, k)=>gl.glGetActiveUniform(prog, k));
    assert.deepEqual(active.map(u=>`${u.name}:${u.size}:${u.type.toString(16)}`), [
        'mvp:1:8b5c', 'tint:1:8b52', 'weights[0]:3:1406', 'on:1:8b56', 'counts:1:8b53',
        'image:1:8b5e', 'skew:1:8b65',
    ]);
    assert.deepEqual(gl.glGetProgramiv(prog, GL.ACTIVE_UNIFORM_MAX_LENGTH),
        ['weights[0]'.length + 1]);
    assert.equal(gl.glGetActiveUniform(prog, 7), null);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    const weights = gl.glGetUniformLocation(prog, 'weights');
    assert.equal(gl.glGetUniformLocation(prog, 'weights[0]'), weights);
    assert.equal(gl.glGetUniformLocation(prog, 'weights[2]'), weights + 2);
    assert.equal(gl.glGetUniformLocation(prog, 'weights[3]'), -1);
    assert.equal(gl.glGetUniformLocation(prog, 'tint[0]'), -1, 'a non-array has no element');
    assert.equal(gl.glGetUniformLocation(prog, 'gl_ModelViewMatrix'), -1);
    assert.equal(gl.glGetUniformLocation(prog, 'missing'), -1);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    const unlinked = gl.glCreateProgram();
    assert.equal(gl.glGetUniformLocation(unlinked, 'tint'), -1);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
});

test('glBindAttribLocation takes effect at the next link, and refuses gl_ names', ()=>{
    const gl = fixture();
    const prog = program(gl);
    gl.glBindAttribLocation(prog, 5, 'position');
    assert.equal(gl.glGetAttribLocation(prog, 'position'), 0, 'not before the link');
    gl.glLinkProgram(prog);
    assert.equal(gl.glGetAttribLocation(prog, 'position'), 5);
    gl.glBindAttribLocation(prog, 16, 'position');
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glBindAttribLocation(prog, 1, 'gl_Vertex');
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
});

test('glUniform* writes the program in use, typed, and the values read back', ()=>{
    const gl = fixture();
    const prog = program(gl);
    const at = (/** @type {string} */ name)=>gl.glGetUniformLocation(prog, name);
    gl.uniform(at('tint'), 1, [1, 2, 3, 4], 'f', 4);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no program in use');
    gl.glUseProgram(prog);
    gl.uniform(at('tint'), 1, [1, 2, 3, 4], 'f', 4);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.getUniform(prog, at('tint')), { values: [1, 2, 3, 4], float: true });

    gl.uniform(at('tint'), 1, [1, 2, 3], 'f', 3);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a size other than the uniform\'s');
    gl.uniform(at('tint'), 1, [1, 2, 3, 4], 'i', 4);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'an int form into a float');
    gl.uniform(at('counts'), 1, [1.5, 2], 'f', 2);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a float form into an int');
    gl.uniform(at('tint'), 2, [1, 2, 3, 4, 5, 6, 7, 8], 'f', 4);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a count past one into a non-array');
    gl.uniform(at('tint'), -1, [], 'f', 4);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.uniform(-1, 1, [1, 2, 3, 4], 'f', 4);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'location -1 is quietly nothing');
    gl.uniform(1000, 1, [1, 2, 3, 4], 'f', 4);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a location the program has not');

    // An array from an element on, cut at its end.
    gl.uniform(at('weights[1]'), 5, [10, 20, 30, 40, 50], 'f', 1);
    assert.deepEqual([at('weights[0]'), at('weights[1]'), at('weights[2]')]
        .map(l=>gl.getUniform(prog, l).values[0]), [0, 10, 20]);
    // A bool from either form.
    gl.uniform(at('on'), 1, [0.5], 'f', 1);
    assert.deepEqual(gl.getUniform(prog, at('on')), { values: [1], float: false });
    gl.uniform(at('on'), 1, [0], 'i', 1);
    assert.deepEqual(gl.getUniform(prog, at('on')).values, [0]);
    // A sampler by glUniform1i alone, within the units.
    gl.uniform(at('image'), 1, [3], 'i', 1);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    gl.uniform(at('image'), 1, [3], 'f', 1);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
    gl.uniform(at('image'), 1, [8], 'i', 1);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    // A matrix of the uniform's shape, transposed when asked.
    gl.uniformMatrix(at('skew'), 1, 0, [1, 2, 3, 4, 5, 6], 2, 3);
    assert.deepEqual(gl.getUniform(prog, at('skew')).values, [1, 2, 3, 4, 5, 6]);
    gl.uniformMatrix(at('skew'), 1, 1, [1, 2, 3, 4, 5, 6], 2, 3);
    assert.deepEqual(gl.getUniform(prog, at('skew')).values, [1, 3, 5, 2, 4, 6],
        'given row by row, kept column by column');
    gl.uniformMatrix(at('skew'), 1, 0, [1, 2, 3, 4, 5, 6], 3, 2);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a mat3x2 into a mat2x3');
    gl.uniformMatrix(at('mvp'), 1, 0, new Array(16).fill(2), 4, 4);
    assert.deepEqual(gl.getUniform(prog, at('mvp')).values, new Array(16).fill(2));
});

test('a relink resets the uniforms; a failed relink keeps drawing with what linked last', ()=>{
    const gl = fixture();
    const prog = program(gl);
    gl.glUseProgram(prog);
    const tint = gl.glGetUniformLocation(prog, 'tint');
    gl.uniform(tint, 1, [1, 1, 1, 1], 'f', 4);
    const before = gl.side.glslExecutable();
    gl.glLinkProgram(prog);
    assert.deepEqual(gl.getUniform(prog, tint).values, [0, 0, 0, 0]);
    assert.notEqual(gl.side.glslExecutable(), before, 'a new executable');

    const kept = gl.side.glslExecutable();
    const [, fs] = gl.glGetAttachedShaders(prog);
    gl.glShaderSource(fs, ['void main() { broken }']);
    gl.glCompileShader(fs);
    gl.glLinkProgram(prog);
    assert.deepEqual(gl.glGetProgramiv(prog, GL.LINK_STATUS), [0]);
    assert.equal(gl.side.glslExecutable(), kept, 'the context draws with what linked last');
    gl.glUseProgram(prog);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
});

test('glValidateProgram finds two sampler types on one unit', ()=>{
    const gl = fixture();
    const prog = gl.glCreateProgram();
    gl.glAttachShader(prog, shader(gl, GL.FRAGMENT_SHADER, 'uniform sampler2D a;'
        + ' uniform samplerCube b;\nvoid main() { gl_FragColor = texture2D(a, vec2(0.0))'
        + ' + textureCube(b, vec3(1.0)); }'));
    gl.glLinkProgram(prog);
    gl.glValidateProgram(prog);
    assert.deepEqual(gl.glGetProgramiv(prog, GL.VALIDATE_STATUS), [0], 'both on unit zero');
    gl.glUseProgram(prog);
    gl.uniform(gl.glGetUniformLocation(prog, 'b'), 1, [1], 'i', 1);
    gl.glValidateProgram(prog);
    assert.deepEqual(gl.glGetProgramiv(prog, GL.VALIDATE_STATUS), [1]);
});

test('a display list records glUseProgram and the uniforms, and not the object calls', ()=>{
    const gl = fixture();
    const prog = program(gl);
    const tint = gl.glGetUniformLocation(prog, 'tint');
    gl.glNewList(1, GL.COMPILE);
    gl.glUseProgram(prog);
    gl.uniform(tint, 1, [0.5, 0.5, 0.5, 1], 'f', 4);
    const made = gl.glCreateShader(GL.VERTEX_SHADER);
    gl.glEndList();
    assert.ok(made > 0, 'a create runs while a list is being compiled');
    assert.deepEqual(gl.glGetIntegerv(GL.CURRENT_PROGRAM), [0], 'compiled, not run');
    gl.glCallList(1);
    assert.deepEqual(gl.glGetIntegerv(GL.CURRENT_PROGRAM), [prog]);
    assert.deepEqual(gl.getUniform(prog, tint).values, [0.5, 0.5, 0.5, 1]);
});

test('the version, the shading language and the limits are what is implemented', ()=>{
    const gl = fixture();
    assert.equal(gl.glGetString(GL.VERSION), '2.1');
    assert.equal(gl.glGetString(GL.SHADING_LANGUAGE_VERSION), '1.20');
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_VERTEX_ATTRIBS_ARB), [16]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_DRAW_BUFFERS), [4]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_VARYING_FLOATS), [32]);
    assert.deepEqual(gl.glGetIntegerv(GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS), [8]);
});
