/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseProgram } from './arb-program.js';
import {
    FRAGMENT_PROGRAM_BINDING, FRAGMENT_PROGRAM_GROUP, VERTEX_PROGRAM_BINDING,
    VERTEX_PROGRAM_GROUP, canonicalAttribName, emitFragment, emitVertex, needsOf,
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
        /let clip = uniforms\.modelViewProjection \* vec4f\(vertex\.position, 1\.0\);/);
    assert.match(code,
        /out\.position = vec4f\(clip\.x, clip\.y, \(clip\.z \+ clip\.w\) \* 0\.5, clip\.w\);/,
        'the remap line is the fixed stage\'s, byte for byte');
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
    assert.match(code, /textureSample\(t3Texture, t3Sampler, vec2f\(select\(0\.0, s\d+_0\.x \/ s\d+_0\.w, s\d+_0\.w != 0\.0\), 0\.5\)\)/,
        'a 1D target samples a 2D texture\'s only row, a zero q at the origin');
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
    assert.match(code,
        new RegExp(`@group\\(${VERTEX_PROGRAM_GROUP}\\) @binding\\(${VERTEX_PROGRAM_BINDING}\\)`));
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
    assert.match(emitted.code, new RegExp(
        `@group\\(${FRAGMENT_PROGRAM_GROUP}\\) @binding\\(${FRAGMENT_PROGRAM_BINDING}\\)`));
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

test('a 3D texture target refuses the fragment stage; a far coordinate set is carried', ()=>{
    const three = parseProgram('!!ARBfp1.0\nTEMP r0;\nTEX r0, r0, texture[0], 3D;\n'
        + 'MOV result.color, r0;\nEND\n');
    assert.ok(!('error' in three));
    const refused = emitFragment(three);
    assert.ok('error' in refused);
    assert.match(refused.error, /3D/);
    // The parser caps a coordinate set at the seventh and the varyings carry
    // eight, so every set a program can name reaches the fragment stage.
    const far = parseProgram('!!ARBfp1.0\nMOV result.color, fragment.texcoord[5];\nEND\n');
    assert.ok(!('error' in far));
    const carried = emitFragment(far);
    assert.ok(!('error' in carried), 'error' in carried ? carried.error : '');
    assert.match(carried.code, /input\.tc5/);
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

/**
 * A real title's per-light interaction pair, verbatim: the vertex half
 * computes seven coordinate sets from the light and view origins and the
 * projection and falloff planes it is given as env parameters; the fragment
 * half samples seven image units -- a normalisation cube map, a bump map,
 * the light's projection and falloff, and the surface's diffuse, specular
 * and specular-lookup maps. A level lit by these draws is dark when either
 * stage refuses or when the sampled units and the program's own blocks
 * collide in the bind layout.
 */
const INTERACTION_VERTEX = `!!ARBvp1.0 OPTION ARB_position_invariant ;

TEMP	R0, R1, R2;

PARAM	defaultTexCoord = { 0, 0.5, 0, 1 };

# calculate vector to light in R0
SUB		R0, program.env[4], vertex.position;

# put into texture space for TEX0
DP3		result.texcoord[0].x, vertex.attrib[9], R0;
DP3		result.texcoord[0].y, vertex.attrib[10], R0;
DP3		result.texcoord[0].z, vertex.attrib[11], R0;

# textures 1 takes the base coordinates by the texture matrix
MOV		result.texcoord[1], defaultTexCoord;
DP4		result.texcoord[1].x, vertex.attrib[8], program.env[10];
DP4		result.texcoord[1].y, vertex.attrib[8], program.env[11];

# texture 2 has one texgen
MOV		result.texcoord[2], defaultTexCoord;
DP4		result.texcoord[2].x, vertex.position, program.env[9];

# texture 3 has three texgens
DP4		result.texcoord[3].x, vertex.position, program.env[6];
DP4		result.texcoord[3].y, vertex.position, program.env[7];
DP4		result.texcoord[3].w, vertex.position, program.env[8];

# textures 4 takes the base coordinates by the texture matrix
MOV		result.texcoord[4], defaultTexCoord;
DP4		result.texcoord[4].x, vertex.attrib[8], program.env[12];
DP4		result.texcoord[4].y, vertex.attrib[8], program.env[13];

# textures 5 takes the base coordinates by the texture matrix
MOV		result.texcoord[5], defaultTexCoord;
DP4		result.texcoord[5].x, vertex.attrib[8], program.env[14];
DP4		result.texcoord[5].y, vertex.attrib[8], program.env[15];

# calculate normalized vector to light in R0
SUB		R0, program.env[4], vertex.position;
DP3		R1, R0, R0;
RSQ		R1, R1.x;
MUL		R0, R0, R1.x;

# calculate normalized vector to viewer in R1
SUB		R1, program.env[5], vertex.position;
DP3		R2, R1, R1;
RSQ		R2, R2.x;
MUL		R1, R1, R2.x;

# add together to become the half angle vector in object space
ADD		R0, R0, R1;

# put into texture space
DP3		result.texcoord[6].x, vertex.attrib[9], R0;
DP3		result.texcoord[6].y, vertex.attrib[10], R0;
DP3		result.texcoord[6].z, vertex.attrib[11], R0;

# generate the vertex color
MAD		result.color, vertex.color, program.env[16], program.env[17];

END
`;

const INTERACTION_FRAGMENT = `!!ARBfp1.0 
OPTION ARB_precision_hint_fastest;

TEMP	light, color, R1, R2, localNormal, specular;

PARAM	subOne = { -1, -1, -1, -1 };
PARAM	scaleTwo = { 2, 2, 2, 2 };

DP3		specular, fragment.texcoord[6],fragment.texcoord[6];
RSQ		specular, specular.x;
MUL		specular, specular.x, fragment.texcoord[6];

TEX	light, fragment.texcoord[0], texture[0], CUBE;
MAD	light, light, scaleTwo, subOne;

TEX	localNormal, fragment.texcoord[1], texture[1], 2D;
MOV localNormal.x, localNormal.a;
MAD	localNormal, localNormal, scaleTwo, subOne;
DP3	light, light, localNormal;

# modulate by the light projection
TXP	R1, fragment.texcoord[3], texture[3], 2D;
MUL	light, light, R1;

# modulate by the light falloff
TXP	R1, fragment.texcoord[2], texture[2], 2D;
MUL	light, light, R1;

# modulate by the diffuse map and constant diffuse factor
TEX	R1, fragment.texcoord[4], texture[4], 2D;
MUL	color, R1, program.env[0];

# perform the specular bump mapping
DP3	specular, specular, localNormal;

# perform a dependent table read for the specular falloff
TEX	R1, specular, texture[6], 2D;

# modulate by the constant specular factor
MUL	R1, R1, program.env[1];

# modulate by the specular map * 2
TEX	R2, fragment.texcoord[5], texture[5], 2D;
ADD	R2, R2, R2;
MAD	color, R1, R2, color;

MUL	color, light, color;

# modify by the vertex color
MUL result.color, color, fragment.color;

END
`;

test('the interaction pair carries seven coordinate sets and seven image units', ()=>{
    /** @type {import('./arb-wgsl.js').StageInput[]} */
    const inputs = [
        { name: 'position', components: 3, scalar: 'f32' },
        { name: 'texCoord0', components: 2, scalar: 'f32' },
        { name: 'texCoord1', components: 3, scalar: 'f32' },
        { name: 'texCoord2', components: 3, scalar: 'f32' },
        { name: 'texCoord3', components: 3, scalar: 'f32' },
    ];
    const parsedVertex = parseProgram(INTERACTION_VERTEX);
    assert.ok(!('error' in parsedVertex));
    const vertexStage = emitVertex(parsedVertex, inputs,
        { texcoords: [0, 1, 2, 3, 4, 5, 6, 7], fogCoord: false });
    assert.ok(!('error' in vertexStage), 'error' in vertexStage ? vertexStage.error : '');
    // The sets past the fourth reach the varyings instead of being dropped.
    assert.match(vertexStage.code, /out\.tc4\.x = /);
    assert.match(vertexStage.code, /out\.tc5\.y = /);
    assert.match(vertexStage.code, /out\.tc6\.z = /);
    // attrib[8..11] are the coordinate arrays of units 0..3, all fed here.
    assert.match(vertexStage.code, /vec4f\(vertex\.texCoord1, 1\.0\)/);
    assert.match(vertexStage.code, /vec4f\(vertex\.texCoord0, 0\.0, 1\.0\)/);
    assert.deepEqual(vertexStage.needs.genericFallbacks, []);
    // The light's origins and planes arrive as env parameters, in block order.
    const env = vertexStage.needs.params.filter(slot=>slot.source === 'env')
        .map(slot=>slot.index);
    for (const index of [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
    {
        assert.ok(env.includes(index), `env[${index}] is a parameter slot`);
    }
    assert.match(vertexStage.code, /uniforms\.modelViewProjection/,
        'the position-invariance option computes the fixed position');

    const parsedFragment = parseProgram(INTERACTION_FRAGMENT);
    assert.ok(!('error' in parsedFragment));
    const fragmentStage = emitFragment(parsedFragment);
    assert.ok(!('error' in fragmentStage),
        'error' in fragmentStage ? fragmentStage.error : '');
    // The coordinate sets past the fourth are read, not refused.
    assert.match(fragmentStage.code, /input\.tc4/);
    assert.match(fragmentStage.code, /input\.tc5/);
    assert.match(fragmentStage.code, /input\.tc6/);
    // Unit 0 samples as the cube map it is; units 1..6 as 2D, each at its
    // own pair of bindings.
    assert.match(fragmentStage.code,
        /@group\(0\) @binding\(1\) var t0Texture: texture_cube<f32>/);
    assert.match(fragmentStage.code,
        /@group\(0\) @binding\(3\) var t1Texture: texture_2d<f32>/);
    assert.match(fragmentStage.code,
        /@group\(0\) @binding\(9\) var t4Texture: texture_2d<f32>/);
    assert.match(fragmentStage.code,
        /@group\(0\) @binding\(13\) var t6Texture: texture_2d<f32>/);
    assert.match(fragmentStage.code, /textureSample\(t6Texture, t6Sampler, /,
        'the dependent specular lookup samples with the computed coordinate');
    assert.match(fragmentStage.code,
        /textureSample\(t3Texture, t3Sampler, select\(vec2f\(0\.0\), s\d+_0\.xy \/ s\d+_0\.w, s\d+_0\.w != 0\.0\)\)/,
        'the projection is projective, and a zero q samples at the origin');
    // The cube sample takes the direction as it is, all three components and
    // no divide: a TEX on a cube is not projective, and a face selected from a
    // mirrored t would flip the sign of the light the program dots the bump
    // normal with.
    assert.match(fragmentStage.code,
        /textureSample\(t0Texture, t0Sampler, s\d+_0\.xyz\)/,
        'the cube map is sampled with the direction itself');
    // The program's own uniform blocks sit past the last unit's pair, so no
    // sampled texture and no block share a binding number.
    assert.ok(VERTEX_PROGRAM_BINDING > 16,
        'the vertex block is past the eighth unit\'s sampler');
    assert.ok(FRAGMENT_PROGRAM_BINDING > 16);
    assert.deepEqual(fragmentStage.needs.textures.map(texture=>texture.unit),
        [0, 1, 3, 2, 4, 6, 5], 'every unit the instructions sample, in first-use order');
});

test('a MOV of a sampled alpha into x carries the sample\'s w and leaves yzw alone', ()=>{
    // The bump map of the interaction program is rxgb: the sampled alpha is
    // the normal's x, so "MOV localNormal.x, localNormal.a" must read the
    // sample's w and write only the x component; the signed MAD that follows
    // then makes it 2 * a - 1. A swizzle mapped a -> x, or a whole-vector
    // write, would drop the stored x and flatten every lit normal.
    const text = `!!ARBfp1.0
TEMP localNormal;
TEX localNormal, fragment.texcoord[1], texture[1], 2D;
MOV localNormal.x, localNormal.a;
MAD localNormal, localNormal, {2, 2, 2, 2}, {-1, -1, -1, -1};
MOV result.color, localNormal;
END
`;
    const parsed = parseProgram(text);
    assert.ok(!('error' in parsed));
    assert.deepEqual(parsed.instructions[1].src[0].components, ['w', 'w', 'w', 'w'],
        'the rgba letter a is the xyzw w, replicated');
    const { code } = fragment(text);
    assert.match(code, /let s\d+_0 = vec4f\(tmp0\.w\);/,
        'the sample\'s stored alpha, w, comes out of the texel');
    assert.match(code, /tmp0\.x = v\d+\.x;/,
        'and only the x component is written: y and z keep the sampled normal');
    assert.match(code, /let s\d+_1 = vec4f\(2\.0, 2\.0, 2\.0, 2\.0\);/,
        'the scale of the signed range is two');
    assert.match(code, /let s\d+_2 = vec4f\(-1\.0, -1\.0, -1\.0, -1\.0\);/,
        'and its offset is minus one');
    assert.match(code, /let v\d+ = s\d+_0 \* s\d+_1 \+ s\d+_2;/,
        'so the result is 2 * value - 1');
});

test('a two-component attribute array widens to (s, t, 0, 1), the specification\'s fill', ()=>{
    // GL_ARB_vertex_program 2.14.3: an attribute array of fewer than four
    // components is read with the missing z as 0 and the missing w as 1, so a
    // DP4 against it applies the parameter's translation column.
    // Derived from Wine d3d9 tests/visual.c test_texture_transform_flags: its
    // vertex-shader branch seeds z = 0 and w = 1 around the declared
    // components before the texture matrix reads them.
    const { code } = vertex(`!!ARBvp1.0
TEMP r0;
DP4 r0.x, vertex.attrib[8], program.env[10];
DP4 r0.y, vertex.attrib[8], program.env[11];
MOV result.texcoord[1].x, r0.x;
MOV result.texcoord[1].y, r0.y;
MOV result.position, r0;
END
`, { inputs: [
        { name: 'position', components: 3, scalar: 'f32' },
        { name: 'texCoord0', components: 2, scalar: 'f32' },
    ] });
    assert.match(code, /vec4f\(vertex\.texCoord0, 0\.0, 1\.0\)/,
        'the widened coordinate carries w = 1');
    assert.doesNotMatch(code, /vec4f\(vertex\.texCoord0, 0\.0, 0\.0\)/,
        'a w of 0 would drop the translation column');
});

test('components of a result the program never writes keep the default (0, 0, 0, 1)', ()=>{
    // GL_ARB_vertex_program 2.14.4.5: a result attribute starts at
    // (0, 0, 0, 1), so a write of .x alone leaves w = 1 -- not the current
    // value of a conventional coordinate, and not 0, which a TXP on the set
    // would divide by.
    // Derived from Wine wined3d/arb_program_shader.c (wine-5.0) at the vertex
    // prologue: "GL_NV_vertex_program defines that all output values are
    // initialized to {0.0, 0.0, 0.0, 1.0}. This assertion is in effect even
    // when using GL_ARB_vertex_program", and its WINED3D_QUIRK_SET_TEXCOORD_W
    // "MOV result.texcoord[i].w, 1" for a partly written set.
    const { code } = vertex(`!!ARBvp1.0
TEMP r0;
DP4 r0.x, vertex.position, program.env[0];
MOV result.texcoord[2].x, r0.x;
END
`);
    assert.match(code, /out\.tc2 = vec4f\(0\.0, 0\.0, 0\.0, 1\.0\);/,
        'the varying starts at the specification\'s default');
    assert.match(code, /out\.tc2\.x = v\d+\.x;/, 'and the write lands on top of it');
});

test('TXP divides by the w the vertex stage carries, and an unwritten w is 1', ()=>{
    // GL_ARB_fragment_program 3.11.5.32: the projective sample divides the
    // coordinate by its w before the lookup, so the w a vertex stage leaves
    // unwritten is the 1 of the default, never a 0 the sampler would see.
    // Derived from Wine d3d9 tests/visual.c test_texture_transform_flags: the
    // projected branch expects the sample at (0, 0) when q is 0, so a zero q
    // must not reach the sampler as a divide; and from wined3d's TXP emission
    // in arb_program_shader.c for the divide itself.
    const { code } = fragment(`!!ARBfp1.0
TEMP r0;
TXP r0, fragment.texcoord[2], texture[2], 2D;
MOV result.color, r0;
END
`);
    assert.match(code,
        /textureSample\(t2Texture, t2Sampler, select\(vec2f\(0\.0\), s\d+_0\.xy \/ s\d+_0\.w, s\d+_0\.w != 0\.0\)\)/,
        'the fragment divides by the varying\'s w, and a zero w samples at 0');
    const written = vertex(`!!ARBvp1.0
TEMP r0;
DP4 r0.x, vertex.position, program.env[0];
MOV result.texcoord[2].x, r0.x;
END
`, { varyings: { texcoords: [2], fogCoord: false } });
    assert.match(written.code, /out\.tc2 = vec4f\(0\.0, 0\.0, 0\.0, 1\.0\);/,
        'a coordinate only .x is written to carries w = 1 into that divide');
});

test('the fragment stage reads the same varying fields the vertex stage writes', ()=>{
    // GL_ARB_fragment_program 3.11.4.5: fragment.texcoord[n] is the
    // interpolated result.texcoord[n], all four components, in the same
    // order -- one struct, named alike at both ends.
    // Derived from Wine wined3d/arb_program_shader.c (wine-5.0): its vertex
    // stage's result.texcoord[0..7] table and the fragment stage's
    // fragment.texcoord[0..7] table are the same eight names, one per set.
    const sets = [0, 1, 2, 3, 4, 5, 6, 7];
    const writes = sets.map(set=>`MOV result.texcoord[${set}], vertex.position;`).join('\n');
    const written = vertex(`!!ARBvp1.0
${writes}
END
`, { inputs: [{ name: 'position', components: 4, scalar: 'f32' }],
        varyings: { texcoords: sets, fogCoord: false } });
    const reads = sets.map(set=>`fragment.texcoord[${set}]`).join(', ');
    const read = fragment(`!!ARBfp1.0
TEMP acc;
MUL acc, ${reads.split(', ').slice(0, 2).join(', ')};
MOV result.color, acc;
END
`);
    for (const set of sets)
    {
        assert.match(written.code, new RegExp(`@location\\(${3 + set}\\) tc${set}: vec4f,`),
            `the vertex stage declares set ${set}`);
    }
    assert.match(read.code, /input\.tc0/);
    assert.match(read.code, /input\.tc1/);
});

test('env parameters materialise in the order the program text names them', ()=>{
    // Derived from Wine wined3d/arb_program_shader.c (wine-5.0): a shader's
    // constants are declared as one contiguous run, "PARAM C[%d] =
    // { program.env[0..%d] }", so a slot's index is its place in the
    // declaration, and the draw path fills the run in that same order.
    const { code, needs } = vertex(`!!ARBvp1.0
TEMP r0, r1;
DP4 r0.x, vertex.attrib[8], program.env[10];
DP4 r0.y, vertex.attrib[8], program.env[11];
SUB r1, program.env[4], vertex.position;
MOV result.texcoord[1].x, r0.x;
MOV result.texcoord[1].y, r0.y;
MOV result.position, r1;
END
`, { inputs: [
        { name: 'position', components: 3, scalar: 'f32' },
        { name: 'texCoord0', components: 2, scalar: 'f32' },
    ] });
    assert.deepEqual(needs.params, [
        { source: 'env', index: 10 },
        { source: 'env', index: 11 },
        { source: 'env', index: 4 },
    ], 'the block lists the slots in the order the instructions reach them');
    assert.match(code, /let s\d+_1 = vertexProgram\.params\[0\];/,
        'the first-named env parameter is slot zero');
    assert.match(code, /let s\d+_1 = vertexProgram\.params\[1\];/,
        'the second is slot one, consecutive with it');
    assert.match(code, /let s\d+_0 = vertexProgram\.params\[2\];/,
        'and the later-named one follows both');
});

test('coordinate sets up to the seventh are carried, and generic attributes'
    + ' 12 to 15 are the sets 4 to 7', ()=>{
    const { code } = fragment(`!!ARBfp1.0
TEMP acc;
ADD acc, fragment.texcoord[4], fragment.texcoord[7];
MOV result.color, acc;
END
`);
    assert.match(code, /input\.tc4/);
    assert.match(code, /input\.tc7/);
    assert.equal(canonicalAttribName(12), 'texCoord4');
    assert.equal(canonicalAttribName(15), 'texCoord7');
});

test('the interaction pair\'s falloff set carries its declared default and both'
    + ' projective samples divide by the carried w', ()=>{
    // The per-light interaction text: the falloff set is the declared constant
    // with only its .x computed, the projection set three of four components,
    // and the fragment samples both projectively. Wine's wined3d emits exactly
    // this shape for a D3D projective texture argument, and its d3d9 visual
    // tests pin the divide; the constant's .y is the sample's row.
    const vpText = `!!ARBvp1.0
OPTION ARB_position_invariant;
PARAM defaultTexCoord = { 0, 0.5, 0, 1 };
MOV result.texcoord[2], defaultTexCoord;
DP4 result.texcoord[2].x, vertex.position, program.env[9];
DP4 result.texcoord[3].x, vertex.position, program.env[6];
DP4 result.texcoord[3].y, vertex.position, program.env[7];
DP4 result.texcoord[3].w, vertex.position, program.env[8];
MAD result.color, vertex.color, program.env[16], program.env[17];
END
`;
    const fpText = `!!ARBfp1.0
TEMP R1;
TXP R1, fragment.texcoord[3], texture[3], 2D;
TXP R1, fragment.texcoord[2], texture[2], 2D;
MUL result.color, R1, fragment.color;
END
`;
    /** @type {import('./arb-wgsl.js').StageInput[]} */
    const inputs = [
        { name: 'position', components: 3, scalar: 'f32' },
        { name: 'color', components: 4, scalar: 'f32' },
    ];
    const varyings = { texcoords: [2, 3], fogCoord: false };
    const parsedVertex = parseProgram(vpText);
    assert.ok(!('error' in parsedVertex),
        'error' in parsedVertex ? parsedVertex.error.message : '');
    const emittedVertex = emitVertex(parsedVertex, inputs, varyings);
    assert.ok(!('error' in emittedVertex),
        'error' in emittedVertex ? emittedVertex.error : '');
    assert.equal(emittedVertex.needs.params[0].source, 'constant');
    assert.deepEqual(emittedVertex.needs.params[0].values, [0, 0.5, 0, 1],
        'the falloff row the constant declares is the block\'s first slot');
    assert.match(emittedVertex.code,
        /let (\w+) = vertexProgram\.params\[0\];\n {4}let (\w+) = \1;\n {4}out\.tc2 = \2;/,
        'the set takes the constant whole');
    assert.match(emittedVertex.code, /out\.tc2\.x = \w+\.x;/, 'then its computed .x');
    assert.ok(emittedVertex.code.includes('out.tc3 = vec4f(0.0, 0.0, 0.0, 1.0);')
        && !/out\.tc3\.z/.test(emittedVertex.code),
    'the projection set keeps the default w its writes leave alone');
    const parsedFragment = parseProgram(fpText);
    assert.ok(!('error' in parsedFragment),
        'error' in parsedFragment ? parsedFragment.error.message : '');
    const emittedFragment = emitFragment(parsedFragment);
    assert.ok(!('error' in emittedFragment),
        'error' in emittedFragment ? emittedFragment.error : '');
    const projective = emittedFragment.code.match(
        /select\(vec2f\(0\.0\), (\w+)\.xy \/ \1\.w, \1\.w != 0\.0\)/g) ?? [];
    assert.equal(projective.length, 2, 'both TXPs divide by the w they were given');
});
