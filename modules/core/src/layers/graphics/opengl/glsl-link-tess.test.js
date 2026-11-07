/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Linking tessellation shaders (OpenGL 4.0 section 2.12): the layouts, what
 * each stage reads of the one before, the link errors, and the tessellator's
 * kind a layout is drawn with, its vertex order pinned against GL's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileShader } from './context-glsl.js';
import { linkProgram } from './glsl-link.js';
import { tessellatorKind } from './glsl-link-tess.js';
import { OUTPUT, PARTITIONING, tessellate } from '../d3d10/tessellator.js';

/** @param {string} text @param {any} stage */
function unit(text, stage){
    const compiled = compileShader([text], stage);
    assert.ok(compiled.ok, compiled.log);
    return /** @type {any} */ (compiled.unit);
}

/**
 * @param {{ vs?: string, tcs?: string, tes?: string, fs?: string }} texts
 * @returns {any}
 */
function link(texts){
    return linkProgram({
        vertex: texts.vs ? [unit(texts.vs, 'vertex')] : [],
        tessControl: texts.tcs ? [unit(texts.tcs, 'tessControl')] : [],
        tessEvaluation: texts.tes ? [unit(texts.tes, 'tessEvaluation')] : [],
        fragment: texts.fs ? [unit(texts.fs, 'fragment')] : [],
        attribBindings: new Map(),
    });
}

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
    barrier();
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

test('a program with both tessellation stages links their layouts and interfaces', ()=>{
    const result = link({ vs: VS, tcs: TCS, tes: TES, fs: FS });
    assert.ok(result.ok, result.log);
    const program = result.program;
    assert.deepEqual(program.tessLayout, { mode: 'triangles', spacing: 'fractional_odd_spacing',
        order: 'cw', pointMode: false, vertices: 3 });
    assert.deepEqual(program.controlInputs.map((/** @type {any} */ i)=>[i.name, i.fromPath,
        i.path]), [['vColour', 'g_vColour', 'g_vColour[]']]);
    assert.deepEqual(program.evaluationInputs.map((/** @type {any} */ i)=>[i.name, i.fromPath,
        i.path]), [['tColour', 'g_tColour[]', 'g_tColour[]']]);
    assert.deepEqual(program.patchInputs.map((/** @type {any} */ i)=>[i.name, i.fromPath,
        i.path]), [['scale', 'g_scale', 'g_scale']]);
    // The fragment stage reads the evaluation stage's outputs.
    assert.deepEqual(program.varyings.map((/** @type {any} */ v)=>[v.name, v.vertexPath]),
        [['colour', 'g_colour']]);
    // A uniform the control stage reads is the program's.
    assert.deepEqual(program.uniforms.map((/** @type {any} */ u)=>u.name), ['level']);
});

test('without a control shader the evaluation stage reads the vertex stage, and the'
    + ' layout\'s defaults are equal spacing and ccw', ()=>{
    const result = link({ vs: VS, tes: `#version 400
layout(quads) in; in vec3 vColour[]; out vec3 colour;
void main() { colour = vColour[0]; gl_Position = gl_in[3].gl_Position * gl_TessCoord.x; }`,
    fs: FS });
    assert.ok(result.ok, result.log);
    assert.deepEqual(result.program.tessLayout, { mode: 'quads', spacing: 'equal_spacing',
        order: 'ccw', pointMode: false, vertices: 0 });
    assert.deepEqual(result.program.evaluationInputs.map((/** @type {any} */ i)=>
        [i.name, i.fromPath, i.path]), [['vColour', 'g_vColour', 'g_vColour[]']]);
});

test('the link errors of the tessellation stages', ()=>{
    /** @param {Parameters<typeof link>[0]} texts @param {RegExp} pattern */
    const fails = (texts, pattern)=>{
        const result = link(texts);
        assert.equal(result.ok, false);
        assert.match(result.log, pattern);
    };
    fails({ vs: VS, tcs: TCS, fs: FS }, /no tessellation evaluation shader/);
    fails({ tes: TES, fs: FS }, /no vertex shader/);
    fails({ vs: VS, tcs: TCS, tes: `#version 400
layout(equal_spacing) in; in vec3 tColour[]; void main() { gl_Position = vec4(tColour[0], 1.0); }`,
    fs: FS }, /no primitive mode/);
    fails({ vs: VS, tcs: TCS.replace('patch out float scale;', 'patch out float other;')
        .replace('scale = 1.0;', 'other = 1.0;'), tes: TES, fs: FS }, /patch input 'scale'/);
    fails({ vs: VS.replace(/vColour/g, 'vOther'), tcs: TCS, tes: TES, fs: FS },
        /control shader input 'vColour'/);
    fails({ vs: VS, tcs: TCS.replace('layout(vertices = 3) out;', ''), tes: TES, fs: FS },
        /no output vertices/);
});

test('GL\'s vertex orders: ccw turns positively in (u, v), cw negatively', ()=>{
    /** @param {number} a */
    const sign = a=>Math.sign(a);
    for (const mode of /** @type {const} */ (['triangles', 'quads']))
    {
        for (const order of /** @type {const} */ (['ccw', 'cw']))
        {
            const kind = tessellatorKind({ mode, spacing: 'equal_spacing', order,
                pointMode: false, vertices: 3 });
            const made = tessellate(mode === 'triangles' ? 'tri' : 'quad', kind.partitioning,
                kind.output, [3, 2, 4, 3, 2, 3]);
            const signs = new Set();
            for (let k = 0; k < made.indices.length; k += 3)
            {
                const [a, b, c] = [0, 1, 2].map(j=>made.indices[k + j]);
                const at = (/** @type {number} */ i)=>[made.points[i * 2], made.points[i * 2 + 1]];
                const [A, B, C] = [at(a), at(b), at(c)];
                signs.add(sign((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1])));
            }
            assert.deepEqual([...signs], [order === 'ccw' ? 1 : -1], `${mode} ${order}`);
        }
    }
    assert.deepEqual(tessellatorKind({ mode: 'isolines', spacing: 'fractional_even_spacing',
        order: 'ccw', pointMode: false, vertices: 2 }),
    { domain: 0, partitioning: PARTITIONING.FRACTIONAL_EVEN, output: OUTPUT.LINE });
    assert.deepEqual(tessellatorKind({ mode: 'triangles', spacing: 'fractional_odd_spacing',
        order: 'cw', pointMode: true, vertices: 3 }),
    { domain: 1, partitioning: PARTITIONING.FRACTIONAL_ODD, output: OUTPUT.POINT });
});

test('a triangle\'s domain point is (u, v), and the level of edge u = 0 is outer 0', ()=>{
    // Outer 0 at 4 cuts only the edge where u is 0: every point made
    // besides the corners and inner ones lies on it.
    const made = tessellate('tri', PARTITIONING.INTEGER, OUTPUT.TRIANGLE_CW, [4, 1, 1, 1]);
    const onEdges = { u0: 0, v0: 0, w0: 0 };
    for (let k = 0; k < made.points.length; k += 2)
    {
        const [u, v] = [made.points[k], made.points[k + 1]];
        const w = 1 - u - v;
        const corner = [u, v, w].filter(x=>Math.abs(x - 1) < 1e-6).length === 1;
        if (corner)
        {
            continue;
        }
        if (Math.abs(u) < 1e-6)
        {
            onEdges.u0++;
        }
        else if (Math.abs(v) < 1e-6)
        {
            onEdges.v0++;
        }
        else if (Math.abs(w) < 1e-6)
        {
            onEdges.w0++;
        }
    }
    assert.deepEqual(onEdges, { u0: 3, v0: 0, w0: 0 });
});
