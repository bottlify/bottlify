/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Program pipelines (OpenGL 4.1, ARB_separate_shader_objects): separable
 * programs' stages drawn together, each uniform from its stage's program.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';

const VS = '#version 330\nuniform vec4 off; layout(location = 3) in vec4 p; out vec4 v;\n'
    + 'void main() { gl_Position = p + off; v = p; }';
const FS = '#version 330\nuniform vec4 tint; in vec4 v; layout(location = 0) out vec4 c;\n'
    + 'void main() { c = v * tint; }';

/** @returns {any} */
function context(){
    const gl = createGlContext({});
    gl.attach({ width: 4, height: 4, doubleBuffered: true });
    return gl;
}

test('separable programs\' stages draw together, each uniform its own program\'s', ()=>{
    const gl = context();
    const vertex = gl.glCreateShaderProgramv(GL.VERTEX_SHADER, [VS]);
    const fragment = gl.glCreateShaderProgramv(GL.FRAGMENT_SHADER, [FS]);
    assert.deepEqual([gl.glGetProgramiv(vertex, GL.LINK_STATUS), gl.glGetProgramiv(vertex,
        GL.PROGRAM_SEPARABLE)], [[1], [1]], gl.glGetProgramInfoLog(vertex));
    const [pipeline] = gl.genProgramPipelines(1, false);
    assert.equal(gl.glIsProgramPipeline(pipeline), GL.FALSE, 'an object once bound');
    gl.glBindProgramPipeline(pipeline);
    assert.equal(gl.glIsProgramPipeline(pipeline), GL.TRUE);
    gl.glUseProgramStages(pipeline, 0x1, vertex);
    gl.glUseProgramStages(pipeline, 0x2, fragment);
    assert.deepEqual([gl.glGetProgramPipelineiv(pipeline, GL.VERTEX_SHADER),
        gl.glGetProgramPipelineiv(pipeline, GL.FRAGMENT_SHADER)], [[vertex], [fragment]]);
    assert.deepEqual(gl.glGetIntegerv(GL.PROGRAM_PIPELINE_BINDING), [pipeline]);

    gl.programUniform(vertex, gl.glGetUniformLocation(vertex, 'off'), 1, [1, 2, 3, 4], 'f', 4,
        null);
    gl.glActiveShaderProgram(pipeline, fragment);
    gl.uniform(gl.glGetUniformLocation(fragment, 'tint'), 1, [5, 6, 7, 8], 'f', 4);
    assert.equal(gl.glGetError(), GL.NO_ERROR, 'glUniform reaches the active program');
    assert.deepEqual(gl.getUniform(fragment, gl.glGetUniformLocation(fragment, 'tint')).values,
        [5, 6, 7, 8]);

    gl.glValidateProgramPipeline(pipeline);
    assert.deepEqual(gl.glGetProgramPipelineiv(pipeline, GL.VALIDATE_STATUS), [1],
        gl.glGetProgramPipelineInfoLog(pipeline));
    const runs = gl.programInUse();
    assert.ok(runs, 'a draw runs the stages together');
    const value = (/** @type {string} */ name)=>{
        const leaf = runs.linked.uniforms.find((/** @type {any} */ u)=>u.name === name);
        return Array.from(runs.floats.subarray(leaf.offset, leaf.offset + 4));
    };
    assert.deepEqual(value('off'), [1, 2, 3, 4], 'the vertex program\'s');
    assert.deepEqual(value('tint'), [5, 6, 7, 8], 'the fragment program\'s');
    assert.equal(runs.linked.attributes.find((/** @type {any} */ a)=>a.name === 'p').location,
        3, 'the vertex program\'s attribute locations kept');
    gl.programUniform(fragment, gl.glGetUniformLocation(fragment, 'tint'), 1, [0, 0, 0, 1], 'f',
        4, null);
    assert.deepEqual(Array.from(gl.programInUse().floats.subarray(
        runs.linked.uniforms.find((/** @type {any} */ u)=>u.name === 'tint').offset).slice(0, 4)),
    [0, 0, 0, 1], 'a later value reaches the next draw');
});

test('a pipeline\'s refusals', ()=>{
    const gl = context();
    gl.glBindProgramPipeline(5);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a name never generated');
    const [pipeline] = gl.genProgramPipelines(1, true);
    assert.equal(gl.glIsProgramPipeline(pipeline), GL.TRUE, 'created is an object');
    const shader = gl.glCreateShader(GL.VERTEX_SHADER);
    gl.glShaderSource(shader, [VS]);
    gl.glCompileShader(shader);
    const plain = gl.glCreateProgram();
    gl.glAttachShader(plain, shader);
    gl.glLinkProgram(plain);
    gl.glUseProgramStages(pipeline, 0x1, plain);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'not separable');
    gl.glUseProgramStages(pipeline, 0x40, 0);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'a stage there is not');
    const vertex = gl.glCreateShaderProgramv(GL.VERTEX_SHADER, [VS]);
    gl.glUseProgramStages(pipeline, 0xffffffff, vertex);
    assert.deepEqual(gl.glGetProgramPipelineiv(pipeline, GL.FRAGMENT_SHADER), [0],
        'a stage the program lacks is taken away');
    assert.deepEqual(gl.glGetProgramPipelineiv(pipeline, GL.VERTEX_SHADER), [vertex]);
    const broken = gl.glCreateShaderProgramv(GL.FRAGMENT_SHADER, ['void main() { oops }']);
    assert.deepEqual(gl.glGetProgramiv(broken, GL.LINK_STATUS), [0]);
    assert.match(gl.glGetProgramInfoLog(broken), /ERROR/, 'the compile log is the program\'s');
    gl.glDeleteProgramPipelines([pipeline]);
    assert.equal(gl.glIsProgramPipeline(pipeline), GL.FALSE);
});

test('a vertex program\'s bound attribute locations are what the pipeline reads', ()=>{
    const gl = context();
    const shader = gl.glCreateShader(GL.VERTEX_SHADER);
    gl.glShaderSource(shader, ['#version 330\nin vec4 a; in vec4 q; out vec4 v;\n'
        + 'void main() { gl_Position = a + q; v = q; }']);
    gl.glCompileShader(shader);
    const vertex = gl.glCreateProgram();
    gl.glProgramParameteri(vertex, GL.PROGRAM_SEPARABLE, GL.TRUE);
    gl.glAttachShader(vertex, shader);
    gl.glBindAttribLocation(vertex, 5, 'q');
    gl.glLinkProgram(vertex);
    const fragment = gl.glCreateShaderProgramv(GL.FRAGMENT_SHADER, [FS]);
    const [pipeline] = gl.genProgramPipelines(1, true);
    gl.glBindProgramPipeline(pipeline);
    gl.glUseProgramStages(pipeline, 0x1, vertex);
    gl.glUseProgramStages(pipeline, 0x2, fragment);
    const runs = gl.programInUse();
    assert.ok(runs, gl.glGetProgramInfoLog(vertex));
    assert.equal(runs.linked.attributes.find((/** @type {any} */ a)=>a.name === 'q').location, 5,
        'glBindAttribLocation before the vertex program\'s link');
});
