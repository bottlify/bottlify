/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProgram } from './arb-program.js';
import {
    FRAGMENT_PROGRAM_BINDING, VERTEX_PROGRAM_BINDING, canonicalAttribName, emitFragment,
    emitVertex, needsOf,
} from './arb-wgsl.js';

/**
 * The emitted stage of a program text, or the test fails with the refusal.
 *
 * @param {string} text
 * @param {{ inputs?: import('./arb-wgsl.js').StageInput[],
 *           varyings?: import('./arb-wgsl.js').StageVaryings }} [options]
 */
function vertex(text, options = {}){
    const parsed = parseProgram(text);
    assert.ok(!('error' in parsed), 'error' in parsed ? parsed.error.message : '');
    const emitted = emitVertex(parsed, options.inputs ?? [
        { name: 'position', components: 4, scalar: 'f32' },
    ], options.varyings ?? { texcoords: [0, 1, 2, 3], fogCoord: false });
    assert.ok(!('error' in emitted), 'error' in emitted ? emitted.error : '');
    return emitted;
}

/** @param {string} text */
function fragment(text){
    const parsed = parseProgram(text);
    assert.ok(!('error' in parsed), 'error' in parsed ? parsed.error.message : '');
    const emitted = emitFragment(parsed);
    assert.ok(!('error' in emitted), 'error' in emitted ? emitted.error : '');
    return emitted;
}

const VARYINGS = { texcoords: [0, 1, 2, 3], fogCoord: false };

test('every vertex instruction emits its arithmetic in vec4f', ()=>{
    const { code } = vertex(`!!ARBvp1.0
TEMP r0, r1, r2, r3;
ADDRESS a0;
ABS r1, r0;
ADD r1, r0, r2;
SUB r1, r0, r2;
MUL r1, r0, r2;
MAD r1, r0, r2, r3;
MIN r1, r0, r2;
MAX r1, r0, r2;
MOV r1, r0;
FLR r1, r0;
FRC r1, r0;
DP3 r1, r0, r2;
DP4 r1, r0, r2;
DPH r1, r0, r2;
DST r1, r0, r2;
SLT r1, r0, r2;
SGE r1, r0, r2;
XPD r1, r0, r2;
RCP r1.x, r0.x;
RSQ r1.x, r0.x;
EX2 r1.x, r0.x;
LG2 r1.x, r0.x;
POW r1.x, r0.x, r2.x;
EXP r1, r0.x;
LOG r1, r0.x;
LIT r1, r0;
ARL a0.x, r0.x;
END
`);
    assert.match(code, /let v\d+ = abs\(s\d+_0\);/);
    assert.match(code, /= s\d+_0 \+ s\d+_1;/);
    assert.match(code, /= s\d+_0 - s\d+_1;/);
    assert.match(code, /= s\d+_0 \* s\d+_1;/);
    assert.match(code, /= s\d+_0 \* s\d+_1 \+ s\d+_2;/);
    assert.match(code, /= min\(s\d+_0, s\d+_1\);/);
    assert.match(code, /= max\(s\d+_0, s\d+_1\);/);
    assert.match(code, /= floor\(s\d+_0\);/);
    assert.match(code, /= fract\(s\d+_0\);/);
    assert.match(code, /= vec4f\(dot\(s\d+_0\.xyz, s\d+_1\.xyz\)\);/);
    assert.match(code, /= vec4f\(dot\(s\d+_0, s\d+_1\)\);/);
    assert.match(code, /= vec4f\(dot\(vec4f\(s\d+_0\.xyz, 1\.0\), s\d+_1\)\);/);
    assert.match(code, /= vec4f\(1\.0, s\d+_0\.x \* s\d+_1\.x, s\d+_0\.y, s\d+_1\.y\);/);
    assert.match(code, /= select\(vec4f\(0\.0\), vec4f\(1\.0\), s\d+_0 < s\d+_1\);/);
    assert.match(code, /= select\(vec4f\(0\.0\), vec4f\(1\.0\), s\d+_0 >= s\d+_1\);/);
    assert.match(code, /= vec4f\(cross\(s\d+_0\.xyz, s\d+_1\.xyz\), 1\.0\);/);
    assert.match(code, /= vec4f\(1\.0 \/ s\d+_0\.x\);/);
    assert.match(code, /= vec4f\(1\.0 \/ sqrt\(s\d+_0\.x\)\);/);
    assert.match(code, /= vec4f\(exp2\(s\d+_0\.x\)\);/);
    assert.match(code, /= vec4f\(log2\(s\d+_0\.x\)\);/);
    assert.match(code, /= vec4f\(pow\(s\d+_0\.x, s\d+_1\.x\)\);/);
    assert.match(code, /= vec4f\(exp2\(floor\(e\d+\)\), e\d+ - floor\(e\d+\), exp2\(e\d+\), 1\.0\);/);
    assert.match(code, /= vec4f\(lf\d+, l\d+ \/ exp2\(lf\d+\), log2\(l\d+\), 1\.0\);/);
    assert.match(code, /pow\(max\(t\d+\.y, 0\.0\), clamp\(t\d+\.w, -128\.0, 128\.0\)\)/);
    assert.match(code, /a0\.x = v\d+\.x;/);
    assert.match(code, /var a0 = vec4f\(0\.0\);/);
});

test('every fragment-only instruction emits its arithmetic', ()=>{
    const { code } = fragment(`!!ARBfp1.0
TEMP r0, r1, r2, r3;
CMP r1, r0, r2, r3;
LRP r1, r0, r2, r3;
SIN r1.x, r0.x;
COS r1.x, r0.x;
SCS r1, r0.x;
SWZ r1, r0, (x, -y, 1, 0);
END
`);
    assert.match(code, /= select\(s\d+_2, s\d+_1, s\d+_0\.x < 0\.0\);/,
        'CMP picks per a.x < 0');
    assert.match(code, /= s\d+_0 \* s\d+_1 \+ \(vec4f\(1\.0\) - s\d+_0\) \* s\d+_2;/,
        'LRP interpolates');
    assert.match(code, /= vec4f\(sin\(s\d+_0\.x\)\);/);
    assert.match(code, /= vec4f\(cos\(s\d+_0\.x\)\);/);
    assert.match(code, /= vec4f\(cos\(s\d+_0\.x\), sin\(s\d+_0\.x\), 0\.0, 0\.0\);/,
        'SCS is cosine in x, sine in y');
    assert.match(code, /let v\d+ = vec4f\(tmp0\.x, -tmp0\.y, 1\.0, 0\.0\);/,
        'the extended swizzle selects and negates per component');
});

test('swizzles, masks, negation and saturation land in the emitted code', ()=>{
    const { code } = fragment(`!!ARBfp1.0
TEMP r0, r1;
MOV_SAT r1.zw, -r0.rgba;
MUL r1.xy, r0.xxxy, r0;
MOV result.color, { 0.25, 0.5 };
END
`);
    assert.match(code, /let v\d+ = clamp\(s\d+_0, vec4f\(0\.0\), vec4f\(1\.0\)\);/,
        '_SAT clamps the value');
    assert.match(code, /let s\d+_0 = vec4f\(-tmp0\.x, -tmp0\.y, -tmp0\.z, -tmp0\.w\);/,
        'rgba is the xyzw swizzle and the sign negates every component');
    assert.match(code, /tmp1\.z = v\d+\.z;/);
    assert.match(code, /tmp1\.w = v\d+\.w;/);
    assert.match(code, /vec4f\(tmp0\.x, tmp0\.x, tmp0\.x, tmp0\.y\)/,
        'a four-component swizzle reads per component');
    assert.match(code, /let s\d+_0 = vec4f\(0\.25, 0\.5, 0\.0, 1\.0\);/,
        'a constant literal pads to a vec4f');
    assert.match(code, /resultColor = v\d+;/);
    // A partial write of the clip position still remaps its depth.
    const masked = vertex(`!!ARBvp1.0
TEMP r0;
MOV result.position.zw, r0;
END
`);
    assert.match(masked.code, /out\.position\.z = \(v\d+\.z \+ v\d+\.w\) \* 0\.5;/);
    assert.match(masked.code, /out\.position\.w = v\d+\.w;/);
});

test('the clip position is depth-remapped, the way the fixed path remaps it', ()=>{
    const { code } = vertex(`!!ARBvp1.0
TEMP r0;
MOV result.position, r0;
END
`);
    assert.match(code,
        /out\.position = vec4f\(v\d+\.x, v\d+\.y, \(v\d+\.z \+ v\d+\.w\) \* 0\.5, v\d+\.w\);/);
});

test('position invariance emits the modelview-projection multiply', ()=>{
    const { code } = vertex(`!!ARBvp1.0
OPTION ARB_position_invariant;
TEMP r0;
MOV r0, vertex.position;
END
`, { inputs: [{ name: 'position', components: 3, scalar: 'f32' }] });
    assert.match(code,
        /let invariant = uniforms\.modelViewProjection \* vec4f\(vertex\.position, 1\.0\);/);
    assert.match(code,
        /out\.position = vec4f\(invariant\.x, invariant\.y, \(invariant\.z \+ invariant\.w\) \* 0\.5, invariant\.w\);/);
    assert.doesNotMatch(code, /out\.position = vec4f\(v\d+/);
});

test('KIL discards on any negative component', ()=>{
    const { code, needs } = fragment(`!!ARBfp1.0
TEMP r0;
KIL r0.xyxy;
MOV result.color, r0;
END
`);
    assert.match(code, /if \(any\(vec4f\(tmp0\.x, tmp0\.y, tmp0\.x, tmp0\.y\) < vec4f\(0\.0\)\)\)/);
    assert.match(code, /discard;/);
    assert.equal(needs.discards, true);
});

test('texture instructions sample the fixed path\'s slots, projective and biased', ()=>{
    const { code, needs } = fragment(`!!ARBfp1.0
TEMP r0, r1;
TEX r0, r1.xyxy, texture[1], 2D;
TXP r0, r1, texture[2], CUBE;
TXB r0, r1, texture, RECT;
TXP r0, r1, texture[3], 1D;
MOV result.color, r0;
END
`);
    assert.match(code,
        /@group\(0\) @binding\(3\) var t1Texture: texture_2d<f32>;/);
    assert.match(code,
        /@group\(0\) @binding\(4\) var t1Sampler: sampler;/);
    assert.match(code,
        /@group\(0\) @binding\(5\) var t2Texture: texture_cube<f32>;/);
    assert.match(code, /textureSample\(t1Texture, t1Sampler, s\d+_0\.xy\)/,
        'TEX samples the coordinate as it is');
    assert.match(code, /textureSample\(t2Texture, t2Sampler, s\d+_0\.xyz \/ s\d+_0\.w\)/,
        'TXP divides a cube coordinate by w');
    assert.match(code, /textureSampleBias\(t0Texture, t0Sampler, s\d+_0\.xy, s\d+_0\.w\)/,
        'TXB biases with the source w');
    assert.match(code, /textureSample\(t3Texture, t3Sampler, vec2f\(s\d+_0\.x \/ s\d+_0\.w, 0\.5\)\)/,
        'a 1D target samples a 2D texture\'s only row');
    assert.deepEqual(needs.textures.map(t=>t.unit), [1, 2, 0, 3]);
    assert.deepEqual(needs.textures.find(t=>t.unit === 2)?.target, 'CUBE');
});

test('parameter slots materialise in block order and the needs list them', ()=>{
    const { code, needs } = vertex(`!!ARBvp1.0
TEMP r0;
PARAM mvp[4] = { state.matrix.mvp };
PARAM mv = state.matrix.modelview[1].transpose.row[0];
PARAM env = program.env[7];
PARAM lit = { 0.5, 0.25, 0.125, 1.0 };
PARAM loc = program.local[2];
DP4 r0.x, vertex.position, mvp[0];
ADD r0, r0, env;
ADD r0, r0, lit;
ADD r0, r0, program.env[3];
ADD r0, r0, state.matrix.projection.row[1];
MOV result.position, r0;
END
`);
    assert.deepEqual(needs.params.slice(0, 5).map(s=>s.source),
        ['matrix', 'matrix', 'matrix', 'matrix', 'matrix']);
    assert.deepEqual(needs.params[5], { source: 'env', index: 7 });
    assert.deepEqual(needs.params[6], { source: 'constant', values: [0.5, 0.25, 0.125, 1] });
    assert.deepEqual(needs.params[7], { source: 'local', index: 2 });
    assert.deepEqual(needs.params[8], { source: 'env', index: 3 },
        'an inline reference is appended after the declarations');
    assert.deepEqual(needs.params[9],
        { source: 'matrix', matrix: 'projection', number: 0, modifier: '', row: 1 });
    assert.deepEqual(needs.matrices, [
        { matrix: 'mvp', number: 0, modifier: '' },
        { matrix: 'modelview', number: 1, modifier: 'transpose' },
        { matrix: 'projection', number: 0, modifier: '' },
    ]);
    assert.match(code, /vertexProgram\.params\[0\]/, 'the first matrix row is slot zero');
    assert.match(code, /vertexProgram\.params\[5\]/);
    assert.match(code, /vertexProgram\.params\[9\]/);
    assert.match(code, new RegExp(`@group\\(0\\) @binding\\(${VERTEX_PROGRAM_BINDING}\\)`));
});

test('relative addressing clamps into the declaration\'s own run', ()=>{
    const { code, needs } = vertex(`!!ARBvp1.0
TEMP r0;
ADDRESS a0;
PARAM head = program.env[0];
PARAM bones[8] = { program.local[0..7] };
ARL a0.x, r0.x;
MOV result.position, bones[a0.x + 2];
END
`);
    assert.equal(needs.params.length, 9);
    assert.match(code,
        /vertexProgram\.params\[clamp\(i32\(a0\.x\) \+ 3, 1, 8\)\]/);
});

test('a state matrix slot reads the uniform the draw path fills for it', ()=>{
    const emitted = fragment(`!!ARBfp1.0
TEMP r0;
PARAM row = state.matrix.texture[2].invtrans.row[3];
MUL result.color, r0, row;
END
`);
    assert.deepEqual(emitted.needs.params, [{
        source: 'matrix', matrix: 'texture', number: 2, modifier: 'invtrans', row: 3,
    }]);
    assert.deepEqual(emitted.needs.matrices,
        [{ matrix: 'texture', number: 2, modifier: 'invtrans' }]);
    assert.match(emitted.code, /fragmentProgram\.params\[0\]/);
    assert.match(emitted.code,
        new RegExp(`@group\\(0\\) @binding\\(${FRAGMENT_PROGRAM_BINDING}\\)`));
});

test('an unsupported state binding refuses the stage with the binding named', ()=>{
    const parsed = parseProgram(`!!ARBvp1.0
PARAM mat = state.material.ambient;
MOV result.position, mat;
END
`);
    assert.ok(!('error' in parsed));
    const emitted = emitVertex(parsed, [], VARYINGS);
    assert.ok('error' in emitted);
    assert.match(emitted.error, /state\.material\.ambient/);
    const refused = needsOf(parsed);
    assert.ok('error' in refused);
    assert.match(refused.error, /no value on the GPU path/);
});

test('a 3D texture target and a far coordinate set refuse the fragment stage', ()=>{
    const three = parseProgram('!!ARBfp1.0\nTEMP r0;\nTEX r0, r0, texture[0], 3D;\n'
        + 'MOV result.color, r0;\nEND\n');
    assert.ok(!('error' in three));
    const refused = emitFragment(three);
    assert.ok('error' in refused);
    assert.match(refused.error, /3D/);
    const far = parseProgram('!!ARBfp1.0\nMOV result.color, fragment.texcoord[5];\nEND\n');
    assert.ok(!('error' in far));
    const refusedFar = emitFragment(far);
    assert.ok('error' in refusedFar);
    assert.match(refusedFar.error, /fragment\.texcoord\[5\]/);
});

test('attributes read their inputs, and absent ones their current values', ()=>{
    /** @type {import('./arb-wgsl.js').StageInput[]} */
    const inputs = [
        { name: 'position', components: 3, scalar: 'f32' },
        { name: 'color', components: 4, scalar: 'u32' },
        { name: 'texCoord1', components: 2, scalar: 'f32' },
    ];
    const { code, needs } = vertex(`!!ARBvp1.0
TEMP r0;
ATTRIB pos = vertex.position;
ATTRIB gen = vertex.attrib[7];
MUL r0, pos, vertex.color;
MUL r0, r0, vertex.attrib[9];
MUL r0, r0, gen;
ADD r0, r0, vertex.normal;
MOV result.position, r0;
END
`, { inputs });
    assert.match(code, /@location\(0\) position: vec3<f32>,/);
    assert.match(code, /@location\(1\) color: vec4<u32>,/);
    assert.match(code, /vec4f\(vertex\.position, 1\.0\)/, 'a short input is widened');
    assert.match(code, /vec4f\(vertex\.color\)/, 'an integer input is converted');
    assert.match(code, /vec4f\(vertex\.texCoord1, 0\.0, 1\.0\)/,
        'vertex.attrib[9] is the coordinate array of unit 1');
    assert.match(code, /vertexProgram\.attribs\[0\]/,
        'vertex.attrib[7] has no array here and reads its current value');
    assert.match(code, /uniforms\.normal/, 'an absent normal reads the current one');
    assert.deepEqual(needs.genericFallbacks, [7]);
    assert.match(code, /attribs: array<vec4f, 1>,/);
    assert.equal(canonicalAttribName(7), 'attrib7');
    assert.equal(canonicalAttribName(0), 'position');
    assert.equal(canonicalAttribName(11), 'texCoord3');
});

test('fragment attributes read the fixed varyings, and fogcoord asks for the raw one', ()=>{
    const { code, needs } = fragment(`!!ARBfp1.0
TEMP acc;
MUL acc, fragment.color.primary, fragment.texcoord[2];
ADD acc, acc, fragment.color.secondary;
ADD acc, acc, fragment.fogcoord;
ADD acc, acc, fragment.position;
MOV result.color, acc;
END
`);
    assert.match(code, /let s\d+_0 = input\.color;/);
    assert.match(code, /let s\d+_1 = input\.tc2;/);
    assert.match(code, /let s\d+_1 = input\.secondary;/);
    assert.match(code, /let s\d+_1 = vec4f\(input\.fogCoord\);/);
    assert.match(code, /let s\d+_1 = input\.position;/);
    assert.equal(needs.readsFogCoord, true);
});

test('a fragment depth write becomes frag_depth, and the colour is clamped', ()=>{
    const { code, needs } = fragment(`!!ARBfp1.0
MOV result.depth, { 0.5 };
MOV result.color, { 2.0 };
END
`);
    assert.equal(needs.writesDepth, true);
    assert.match(code, /@builtin\(frag_depth\) depth: f32,/);
    assert.match(code, /output\.depth = clamp\(resultDepth, 0\.0, 1\.0\);/);
    assert.match(code, /var finalColor = clamp\(resultColor, vec4f\(0\.0\), vec4f\(1\.0\)\);/);
    const plain = fragment('!!ARBfp1.0\nMOV result.color, fragment.color;\nEND\n');
    assert.equal(plain.needs.writesDepth, false);
    assert.match(plain.code, /-> @location\(0\) vec4f \{/);
    assert.match(plain.code, /return finalColor;/);
});

test('a fog option mixes the specification\'s curve into the clamped colour', ()=>{
    /** @type {[string, RegExp][]} */
    const curves = [
        ['ARB_fog_exp', /exp\(-uniforms\.fogParams\.x \* fogC\)/],
        ['ARB_fog_exp2',
            /exp\(-\(uniforms\.fogParams\.x \* fogC\) \* \(uniforms\.fogParams\.x \* fogC\)\)/],
        ['ARB_fog_linear',
            /\(uniforms\.fogParams\.z - fogC\) \/ max\(uniforms\.fogParams\.z - uniforms\.fogParams\.y, 1e-6\)/],
    ];
    for (const [option, curve] of curves)
    {
        const { code, needs } = fragment(`!!ARBfp1.0
OPTION ${option};
MOV result.color, fragment.color;
END
`);
        assert.equal(needs.fogged, true);
        assert.match(code, curve);
        assert.match(code, /let fogC = input\.fogCoord;/);
        assert.match(code,
            /finalColor = vec4f\(mix\(uniforms\.fogColor\.rgb, finalColor\.rgb, fogF\), finalColor\.a\);/);
        const fogOrder = code.indexOf('clamp(resultColor');
        const mixOrder = code.indexOf('mix(uniforms.fogColor');
        assert.ok(fogOrder >= 0 && fogOrder < mixOrder, 'fog applies to the clamped colour');
    }
});

test('vertex results route into the fixed varyings, and named outputs too', ()=>{
    const { code, needs } = vertex(`!!ARBvp1.0
TEMP r0;
OUTPUT col = result.color.front.secondary;
OUTPUT tc = result.texcoord[2];
OUTPUT fc = result.fogcoord;
OUTPUT ps = result.pointsize;
MOV col, r0;
MOV tc, r0;
MOV fc, r0;
MOV ps, r0;
MOV result.color.back.primary, r0;
END
`, { varyings: { texcoords: [1, 2], fogCoord: true } });
    assert.match(code, /out\.secondary = v\d+;/, 'a secondary colour output writes the secondary');
    assert.match(code, /out\.tc2 = v\d+;/);
    assert.match(code, /out\.fogCoord = v\d+;/);
    assert.match(code, /out\.color = v\d+;/, 'the back colour lands in the one colour varying');
    assert.doesNotMatch(code, /out\.tc1 = v\d+/, 'a coordinate set with no varying is dropped');
    assert.equal(needs.writesPointSize, true);
    assert.equal(needs.writesBackColour, true);
    assert.equal(needs.writesFogCoord, true);
    assert.match(code, /@location\(3\) tc1: vec4f,/);
    assert.match(code, /@location\(4\) tc2: vec4f,/);
    assert.match(code, /@location\(5\) fogCoord: f32,/);
});

test('an aliased temporary and parameter share their storage', ()=>{
    const { code } = vertex(`!!ARBvp1.0
TEMP r0;
ALIAS q0 = r0;
PARAM p = program.env[1];
ALIAS pp = p;
MOV q0, pp;
MOV result.position, q0;
END
`);
    assert.match(code, /let s\d+_0 = vertexProgram\.params\[0\];/);
    assert.match(code, /tmp0 = v\d+;/);
    assert.match(code, /out\.position = vec4f\(v\d+\.x/);
});
