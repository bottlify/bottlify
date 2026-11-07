/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Tessellation's state, calls and program queries on a context (OpenGL 4.0
 * section 2.12): glPatchParameter*, the limits, what a linked program
 * answers, and which modes a program with or without tessellation draws.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { TESS } from './context-tessellation.js';

const VS = `#version 150
in vec4 position; out vec3 vColour;
void main() { vColour = position.xyz; gl_Position = position; }`;
const TCS = `#version 400
layout(vertices = 3) out;
in vec3 vColour[]; out vec3 tColour[]; patch out float scale;
uniform float level;
void main() {
    gl_out[gl_InvocationID].gl_Position = gl_in[gl_InvocationID].gl_Position;
    tColour[gl_InvocationID] = vColour[gl_InvocationID];
    if (gl_InvocationID == 0) {
        gl_TessLevelOuter[0] = level; gl_TessLevelOuter[1] = level;
        gl_TessLevelOuter[2] = level; gl_TessLevelInner[0] = level;
        scale = 1.0;
    }
}`;
const TES = `#version 400
layout(triangles, fractional_odd_spacing, cw) in;
in vec3 tColour[]; patch in float scale; out vec3 colour;
void main() {
    gl_Position = scale * (gl_TessCoord.x * gl_in[0].gl_Position
        + gl_TessCoord.y * gl_in[1].gl_Position + gl_TessCoord.z * gl_in[2].gl_Position);
    colour = tColour[0] * gl_TessCoord.x + tColour[1] * gl_TessCoord.y
        + tColour[2] * gl_TessCoord.z;
}`;
const FS = `#version 150
in vec3 colour; out vec4 c; void main() { c = vec4(colour, 1.0); }`;

function context(){
    const bytes = new Uint8Array(0x10000);
    /** @type {string[]} */
    const divergences = [];
    /** @type {any} */
    const gl = createGlContext({ memory: {
        read: (/** @type {number} */ at, /** @type {number} */ n)=>bytes.slice(at, at + n),
        write: (/** @type {number} */ at, /** @type {Uint8Array} */ v)=>bytes.set(v, at),
    }, divergence: d=>divergences.push(d) });
    gl.attach({ width: 8, height: 8, doubleBuffered: true, depthBits: 24 });
    return { gl, divergences };
}

/** @param {any} gl @param {[number, string][]} shaders @returns {number} */
function program(gl, shaders){
    const made = gl.glCreateProgram();
    for (const [type, text] of shaders)
    {
        const shader = gl.glCreateShader(type);
        assert.notEqual(shader, 0, `type ${type}`);
        gl.glShaderSource(shader, [text]);
        gl.glCompileShader(shader);
        assert.deepEqual(gl.glGetShaderiv(shader, GL.COMPILE_STATUS), [1],
            gl.glGetShaderInfoLog(shader));
        assert.deepEqual(gl.glGetShaderiv(shader, GL.SHADER_TYPE), [type]);
        gl.glAttachShader(made, shader);
    }
    gl.glLinkProgram(made);
    return made;
}

test('glPatchParameter keeps the control points and default levels, and checks them', ()=>{
    const { gl } = context();
    assert.deepEqual(gl.glGetIntegerv(TESS.PATCH_VERTICES), [3]);
    assert.deepEqual(gl.glGetFloatv(TESS.PATCH_DEFAULT_OUTER_LEVEL), [1, 1, 1, 1]);
    assert.deepEqual(gl.glGetFloatv(TESS.PATCH_DEFAULT_INNER_LEVEL), [1, 1]);
    gl.glPatchParameteri(TESS.PATCH_VERTICES, 16);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetIntegerv(TESS.PATCH_VERTICES), [16]);
    gl.glPatchParameteri(TESS.PATCH_VERTICES, 0);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE);
    gl.glPatchParameteri(TESS.PATCH_VERTICES, 33);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past GL_MAX_PATCH_VERTICES');
    gl.glPatchParameteri(TESS.PATCH_DEFAULT_OUTER_LEVEL, 4);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    assert.deepEqual(gl.glGetIntegerv(TESS.PATCH_VERTICES), [16]);
    gl.glPatchParameterfv(TESS.PATCH_DEFAULT_OUTER_LEVEL, [2, 3, 4, 5]);
    gl.glPatchParameterfv(TESS.PATCH_DEFAULT_INNER_LEVEL, [6.5, 7]);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.glGetFloatv(TESS.PATCH_DEFAULT_OUTER_LEVEL), [2, 3, 4, 5]);
    assert.deepEqual(gl.glGetFloatv(TESS.PATCH_DEFAULT_INNER_LEVEL), [6.5, 7]);
    gl.glPatchParameterfv(TESS.PATCH_VERTICES, [1]);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    assert.deepEqual(gl.glGetIntegerv(TESS.MAX_PATCH_VERTICES), [32]);
    assert.deepEqual(gl.glGetIntegerv(TESS.MAX_TESS_GEN_LEVEL), [64]);
    assert.deepEqual(gl.glGetIntegerv(TESS.MAX_TESS_CONTROL_UNIFORM_COMPONENTS), [1024]);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
});

test('a program with tessellation shaders answers its layout; one without, INVALID_OPERATION',
    ()=>{
        const { gl } = context();
        const made = program(gl, [[GL.VERTEX_SHADER, VS], [TESS.TESS_CONTROL_SHADER, TCS],
            [TESS.TESS_EVALUATION_SHADER, TES], [GL.FRAGMENT_SHADER, FS]]);
        assert.deepEqual(gl.glGetProgramiv(made, GL.LINK_STATUS), [1],
            gl.glGetProgramInfoLog(made));
        assert.deepEqual(gl.glGetProgramiv(made, TESS.TESS_CONTROL_OUTPUT_VERTICES), [3]);
        assert.deepEqual(gl.glGetProgramiv(made, TESS.TESS_GEN_MODE), [GL.TRIANGLES]);
        assert.deepEqual(gl.glGetProgramiv(made, TESS.TESS_GEN_SPACING),
            [TESS.FRACTIONAL_ODD]);
        assert.deepEqual(gl.glGetProgramiv(made, TESS.TESS_GEN_VERTEX_ORDER), [GL.CW]);
        assert.deepEqual(gl.glGetProgramiv(made, TESS.TESS_GEN_POINT_MODE), [0]);
        assert.equal(gl.glGetError(), GL.NO_ERROR);

        const plain = program(gl, [[GL.VERTEX_SHADER, VS], [GL.FRAGMENT_SHADER,
            FS.replace('in vec3 colour;', 'in vec3 vColour;')
                .replace('vec4(colour', 'vec4(vColour')]]);
        assert.deepEqual(gl.glGetProgramiv(plain, GL.LINK_STATUS), [1],
            gl.glGetProgramInfoLog(plain));
        for (const pname of [TESS.TESS_CONTROL_OUTPUT_VERTICES, TESS.TESS_GEN_MODE,
            TESS.TESS_GEN_SPACING, TESS.TESS_GEN_VERTEX_ORDER, TESS.TESS_GEN_POINT_MODE])
        {
            assert.equal(gl.glGetProgramiv(plain, pname), null);
            assert.equal(gl.glGetError(), GL.INVALID_OPERATION, `pname ${pname}`);
        }

        // An evaluation shader alone answers its own, not the control stage's.
        const evaluated = program(gl, [[GL.VERTEX_SHADER, VS], [TESS.TESS_EVALUATION_SHADER,
            `#version 400
layout(isolines, point_mode) in; in vec3 vColour[]; out vec3 colour;
void main() { colour = vColour[1]; gl_Position = gl_in[0].gl_Position; }`],
        [GL.FRAGMENT_SHADER, FS]]);
        assert.deepEqual(gl.glGetProgramiv(evaluated, GL.LINK_STATUS), [1],
            gl.glGetProgramInfoLog(evaluated));
        assert.deepEqual(gl.glGetProgramiv(evaluated, TESS.TESS_GEN_MODE), [TESS.ISOLINES]);
        assert.deepEqual(gl.glGetProgramiv(evaluated, TESS.TESS_GEN_SPACING), [GL.EQUAL]);
        assert.deepEqual(gl.glGetProgramiv(evaluated, TESS.TESS_GEN_VERTEX_ORDER), [GL.CCW]);
        assert.deepEqual(gl.glGetProgramiv(evaluated, TESS.TESS_GEN_POINT_MODE), [1]);
        assert.equal(gl.glGetProgramiv(evaluated, TESS.TESS_CONTROL_OUTPUT_VERTICES), null);
        assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
    });

test('a uniform block says which tessellation stages read it', ()=>{
    const { gl } = context();
    const made = program(gl, [[GL.VERTEX_SHADER, VS],
        [TESS.TESS_CONTROL_SHADER, TCS.replace('uniform float level;',
            'layout(std140) uniform Levels { float level; };')],
        [TESS.TESS_EVALUATION_SHADER, TES], [GL.FRAGMENT_SHADER, FS]]);
    assert.deepEqual(gl.glGetProgramiv(made, GL.LINK_STATUS), [1], gl.glGetProgramInfoLog(made));
    const index = gl.glGetUniformBlockIndex(made, 'Levels');
    assert.equal(index, 0);
    assert.deepEqual(gl.glGetActiveUniformBlockiv(made, index,
        TESS.UNIFORM_BLOCK_REFERENCED_BY_TESS_CONTROL_SHADER), [1]);
    assert.deepEqual(gl.glGetActiveUniformBlockiv(made, index,
        TESS.UNIFORM_BLOCK_REFERENCED_BY_TESS_EVALUATION_SHADER), [0]);
    assert.deepEqual(gl.glGetActiveUniformBlockiv(made, index,
        GL.UNIFORM_BLOCK_REFERENCED_BY_VERTEX_SHADER), [0]);
});

test('patches are drawn only through an evaluation shader, and nothing else is', ()=>{
    const { gl, divergences } = context();
    gl.glVertexAttribPointerARB(0, 4, GL.FLOAT, 0, 16, 0x1000);
    gl.glEnableVertexAttribArrayARB(0);
    gl.glDrawArrays(TESS.PATCHES, 0, 3);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no program');
    const tessellated = program(gl, [[GL.VERTEX_SHADER, VS], [TESS.TESS_CONTROL_SHADER, TCS],
        [TESS.TESS_EVALUATION_SHADER, TES], [GL.FRAGMENT_SHADER, FS]]);
    gl.glUseProgram(tessellated);
    gl.glDrawArrays(GL.TRIANGLES, 0, 3);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'triangles through tessellation');
    gl.glDrawElements(GL.TRIANGLES, 3, GL.UNSIGNED_SHORT, Uint8Array.of(0, 0, 1, 0, 2, 0));
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
    gl.glDrawArrays(TESS.PATCHES, 0, 3);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    // Without a device the patches cannot be drawn: a loss, said.
    assert.ok(divergences.some(d=>/drew patches/.test(d)), divergences.join('\n'));
});
