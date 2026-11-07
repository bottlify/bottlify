/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GLSL 4.00 to 4.60 written as WGSL: the built-in functions WGSL spells
 * otherwise or lacks, doubles carried as f32 (decision A178), sampler arrays
 * an expression indexes, and the API of doubles. Whether the WGSL is valid is
 * checked by a browser's compiler outside these tests; here, what it says.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { compileShader } from './context-glsl.js';
import { createGlContext } from './context.js';
import { linkProgram } from './glsl-link.js';
import { emitStage } from './glsl-wgsl.js';
import { canonicalAttribName } from './arb-program.js';

const PASS = `#version 400
in vec4 position; out vec4 colour; void main() { colour = position; gl_Position = position; }`;

/**
 * The fragment stage's WGSL for `fragment` after `vertex`.
 *
 * @param {string} fragment @param {string} [vertex]
 * @returns {{ code: string, program: any }}
 */
function fragmentOf(fragment, vertex = PASS){
    /** @param {string} source @param {'vertex' | 'fragment'} stage */
    const unit = (source, stage)=>{
        const compiled = compileShader([source], stage);
        assert.ok(compiled.ok, `${stage}: ${compiled.log}`);
        return /** @type {any} */ (compiled.unit);
    };
    const result = /** @type {any} */ (linkProgram({ vertex: [unit(vertex, 'vertex')],
        fragment: [unit(fragment, 'fragment')], attribBindings: new Map(),
        fragDataBindings: new Map() }));
    assert.ok(result.ok, result.log);
    const program = result.program;
    const attributes = program.attributes.map((/** @type {any} */ a)=>({
        name: canonicalAttribName(a.location), slot: 0, offset: 0, format: 'float32x4',
        components: 4, scalar: 'f32' }));
    /** @type {import('./glsl-wgsl.js').StageOptions} */
    const options = { attributes, flat: false, twoSide: false, alphaFunc: null, targets: 1,
        targetScalars: ['f32'], compare: ()=>'true' };
    const vs = emitStage(program, 'vertex', options, null, 'glsl');
    return { code: emitStage(program, 'fragment', options, vs.fields, 'glsl').code, program };
}

test('4.00\'s integer functions: carries, borrows, a 64-bit product\'s words, bit fields', ()=>{
    const { code } = fragmentOf(`#version 400
in vec4 colour; out vec4 c; uniform uint u; uniform ivec2 i;
void main() { uint carry; uint lo; uint hi; ivec2 ilo; ivec2 ihi;
    uint s = uaddCarry(u, 3u, carry); uint d = usubBorrow(u, 5u, carry);
    umulExtended(u, u, hi, lo); imulExtended(i, i, ihi, ilo);
    int e = bitfieldExtract(i.x, 2, 3); uint f = bitfieldInsert(u, 7u, 4, 3);
    c = colour + vec4(float(s + d + hi + lo + f), float(e + ihi.x + ilo.y), 0.0, 1.0); }`);
    assert.match(code, /select\(u32\(0u\), u32\(1u\), t\d+ < /, 'a carry where the sum wrapped');
    assert.match(code, /fn fmulHigh_u32\(a: u32, b: u32\) -> u32/);
    assert.match(code, /fn fmulHigh_vec2u\(a: vec2u, b: vec2u\) -> vec2u/);
    assert.match(code, /let (t\d+): vec2u = bitcast<vec2u>\(([\w.]+)\);\s+let (t\d+): vec2u = bitcast<vec2u>\(([\w.]+)\);[\s\S]*fmulHigh_vec2u\(\1, \3\) - select\(vec2u\(0u\), \3, \2 < vec2i\(0\)\) - select\(vec2u\(0u\), \1, \4 < vec2i\(0\)\)/,
        'a negative operand takes the other off the signed high word');
    assert.match(code, /extractBits\([^,]+, u32\(2i\), u32\(3i\)\)/);
    assert.match(code, /insertBits\([^,]+, 7u, u32\(4i\), u32\(3i\)\)/);
});

test('4.00\'s frexp, ldexp, gathers and level queries', ()=>{
    const { code } = fragmentOf(`#version 430
in vec4 colour; out vec4 c; uniform sampler2D s; uniform sampler2DShadow d;
uniform samplerCubeArray a;
void main() { int e; float m = frexp(colour.x, e); float l = ldexp(m, e);
    c = textureGather(s, colour.xy, 1) + textureGatherOffset(s, colour.xy, ivec2(1, -1))
    + textureGatherOffsets(s, colour.xy, ivec2[4](ivec2(0), ivec2(1), ivec2(-1), ivec2(2)))
    + textureGather(d, colour.xy, 0.5) + texture(a, colour)
    + vec4(textureQueryLod(s, colour.xy), l, float(textureQueryLevels(s))); }`);
    assert.match(code, /let (t\d+) = frexp\([^;]+\);[\s\S]*\1\.exp/);
    assert.match(code, /ldexp\(/);
    assert.match(code, /textureGather\(1i, glt\d+, gls\d+, [^)]+\)/, 'the component asked');
    assert.match(code, /textureGather\(0, glt0, gls0, fg_colour\.xy, vec2i\(1i, \(-1i\)\)\)/,
        'the offset, the coordinates as they are');
    assert.match(code, /vec4<f32>\(textureGather[\s\S]*?\.w, textureGather/,
        'four gathers, each footprint\'s i0j0');
    assert.match(code, /textureGatherCompare\(glt\d+, gls\d+, [^,]+, 0\.5f\)/);
    assert.match(code, /textureSample\(glt2, gls2, fg_colour\.xyz, i32\(floor\(fg_colour\.w \+ 0\.5f\)\)\)/,
        'a cube array\'s layer from the fourth coordinate');
    assert.match(code, /i32\(textureNumLevels\(glt\d+\)\)/);
    assert.match(code, /0\.5f \* log2\(max\(max\(dot\(/, 'the lambda of the derivatives');
});

test('interpolation at the centroid and a sample is at the centre; at an offset, along the'
    + ' derivatives', ()=>{
    const { code } = fragmentOf(`#version 400
in vec4 colour; out vec4 c;
void main() { c = interpolateAtCentroid(colour) + interpolateAtSample(colour, 3)
    + interpolateAtOffset(colour, vec2(0.25, -0.5)); }`);
    assert.match(code, /dpdx\(fg_colour\) \* t\d+\.x \+ dpdy\(fg_colour\) \* \(t\d+\.y \* -uniforms\.misc\.z\)/);
});

test('a sampler array an expression indexes is a switch over its elements', ()=>{
    const { code } = fragmentOf(`#version 400
in vec4 colour; out vec4 c; uniform sampler2D s[3]; uniform int k;
void main() { c = texture(s[k], colour.xy); }`);
    assert.match(code, /switch \(t\d+\) \{\n\s+case 0: \{\n\s+t\d+ = textureSample\(glt0/);
    assert.match(code, /case 1: \{\n\s+t\d+ = textureSample\(glt1/);
    assert.match(code, /default: \{\n\s+t\d+ = textureSample\(glt2/, 'the last one past them');
});

test('4.60\'s votes are of a group of one invocation', ()=>{
    const { code } = fragmentOf(`#version 460
in vec4 colour; out vec4 c;
void main() { bool b = colour.x > 0.5; c = vec4(float(anyInvocation(b)),
    float(allInvocations(b)), float(allInvocationsEqual(b)), 1.0); }`);
    assert.match(code, /f32\(true\)/, 'every invocation agrees with itself');
    assert.doesNotMatch(code, /subgroup/);
});

test('a double is an f32: its operations, and its words in a block turned into one and back',
    ()=>{
        const { code } = fragmentOf(`#version 430
in vec4 colour; out vec4 c; uniform double scale;
layout(std140, binding = 0) uniform D { double a; dvec3 b; dmat2 m; };
layout(std430, binding = 1) buffer S { double d; };
void main() { double x = 1.0lf / 3.0lf; d = a + b.y + m[1][0];
    uvec2 w = unpackDouble2x32(x); c = vec4(float(packDouble2x32(w) * scale)); }`);
        assert.match(code, /var \w+: f32 = 0\.3333333432674408f;/, 'a constant folded to the f32');
        assert.match(code, /fn fdoubleToFloat\(lo: u32, hi: u32\) -> f32/);
        assert.match(code, /fn ffloatToDouble\(v: f32\) -> vec2u/);
        // std140: a at 0, b at 32 (a dvec3 is aligned to 32), its y 8 bytes on;
        // m at 64, its second column at 80.
        assert.match(code, /fdoubleToFloat\(glb0\[0\]\.x, glb0\[0\]\.y\)/, 'a: words 0 and 1');
        assert.ok(code.includes('vec3f(fdoubleToFloat(glb0[2].x, glb0[2].y), fdoubleToFloat('
            + 'glb0[2].z, glb0[2].w), fdoubleToFloat(glb0[3].x, glb0[3].y))'),
        'b: eight bytes a component from 32');
        assert.match(code, /fdoubleToFloat\(glb0\[5\]\.x, glb0\[5\]\.y\)/, 'm[1][0] at 80');
        assert.doesNotMatch(code, /bitcast<f32>\(glb0/, 'no double read as one word');
        assert.match(code, /(gss\d+)\[0u\] = (t\d+)\.x;\n\s+\1\[1u\] = \2\.y;/,
            'a double written as its two words');
    });

test('a dvec3 or dvec4 input takes two locations, a dmat4 two a column', ()=>{
    const compiled = compileShader([`#version 410
in dvec3 a; in float b; in dmat4 m;
void main() { gl_Position = vec4(vec3(a) + b, 1.0) + vec4(m[3]); }`], 'vertex');
    assert.ok(compiled.ok, compiled.log);
    const unit = /** @type {any} */ (compiled.unit);
    const result = /** @type {any} */ (linkProgram({ vertex: [unit], fragment: [],
        attribBindings: new Map([['a', 0], ['m', 4]]), fragDataBindings: new Map() }));
    assert.ok(result.ok, result.log);
    const at = Object.fromEntries(result.program.attributes.map((/** @type {any} */ x)=>
        [x.name, x.location]));
    assert.equal(at.b, 2, 'past the dvec3\'s two');
    assert.deepEqual([at.a, at.m], [0, 4]);
    const overlapping = /** @type {any} */ (linkProgram({ vertex: [unit], fragment: [],
        attribBindings: new Map([['a', 0], ['m', 10]]), fragDataBindings: new Map() }));
    assert.ok(!overlapping.ok, 'a dmat4 from 10 runs past location 15');
});

test('double uniforms: glUniform*d, their type, refusals, and what glGetUniform answers', ()=>{
    const gl = /** @type {any} */ (createGlContext({}));
    gl.attach({ width: 4, height: 4, doubleBuffered: true });
    const program = gl.glCreateProgram();
    for (const [type, text] of [[GL.VERTEX_SHADER, PASS], [GL.FRAGMENT_SHADER, `#version 400
in vec4 colour; out vec4 c; uniform double k; uniform dvec2 v; uniform dmat2 m; uniform float f;
void main() { c = colour * float(k + v.y + m[1][1]) * f; }`]])
    {
        const shader = gl.glCreateShader(type);
        gl.glShaderSource(shader, [text]);
        gl.glCompileShader(shader);
        gl.glAttachShader(program, shader);
    }
    gl.glLinkProgram(program);
    assert.deepEqual(gl.glGetProgramiv(program, GL.LINK_STATUS), [1],
        gl.glGetProgramInfoLog(program));
    gl.glUseProgram(program);
    const k = gl.glGetUniformLocation(program, 'k');
    const v = gl.glGetUniformLocation(program, 'v');
    const m = gl.glGetUniformLocation(program, 'm');
    const f = gl.glGetUniformLocation(program, 'f');
    gl.uniform(k, 1, [1 / 3], 'd', 1);
    gl.uniform(v, 1, [2, 4], 'd', 2);
    gl.uniformMatrix(m, 1, 1, [1, 2, 3, 4], 2, 2, 'd');
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(gl.getUniform(program, k).values, [Math.fround(1 / 3)],
        'kept as the shader carries it');
    assert.deepEqual(gl.getUniform(program, m).values, [1, 3, 2, 4], 'given row by row');
    gl.uniform(k, 1, [1], 'f', 1);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a float call for a double');
    gl.uniform(f, 1, [1], 'd', 1);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a double call for a float');
    gl.uniformMatrix(m, 1, 0, [1, 2, 3, 4], 2, 2, 'f');
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'glUniformMatrix2fv for a dmat2');
    const types = [];
    for (let index = 0; index < 4; index++)
    {
        types.push(gl.glGetActiveUniform(program, index).type);
    }
    /** @param {number[]} list */
    const sorted = list=>[...list].sort((a, b)=>a - b);
    assert.deepEqual(sorted(types), sorted([GL.FLOAT, GL.DOUBLE, 0x8f46, 0x8ffc]),
        'GL_DOUBLE, GL_DOUBLE_VEC2 and GL_DOUBLE_MAT2');
});
