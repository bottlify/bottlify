/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/*
 * The front end from 1.30 to 4.60, each case from the GLSL specification of
 * the version it names: what a version has, what it took away, and the error
 * a driver reports for what it does not have.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileFront } from './glsl-front.js';
import { GLSL_CONSTANTS } from './glsl-library.js';

/**
 * @param {string} source
 * @param {import('./glsl-versions.js').Stage} [stage]
 * @param {import('./glsl-front.js').FrontOptions} [options]
 */
const compile = (source, stage = 'fragment', options = {})=>compileFront([source], stage,
    options);

/** @param {string} source @param {import('./glsl-versions.js').Stage} [stage] */
function ok(source, stage = 'fragment'){
    const result = compile(source, stage);
    assert.equal(result.log, '', source);
    assert.ok(result.unit);
    return result.unit;
}

/**
 * @param {string} source @param {RegExp} message
 * @param {import('./glsl-versions.js').Stage} [stage]
 */
function fails(source, message, stage = 'fragment'){
    const result = compile(source, stage);
    assert.equal(result.ok, false, `compiled: ${source}`);
    assert.match(result.log, message, source);
}

const OUT = 'out vec4 color;\n';

test('#version names the profile from 1.50; core is the default, and 1.40 takes none', ()=>{
    const unit = ok('#version 460 core\nin vec4 p;\nvoid main() { gl_Position = p; }', 'vertex');
    assert.deepEqual([unit.version, unit.profile], [460, 'core']);
    assert.equal(ok('#version 330\nvoid main() {}').profile, 'core');
    fails('#version 140 core\nvoid main() {}', /ERROR: 0:1: .*profile needs version 150/);
    fails('#version 150 strict\nvoid main() {}', /profile is not supported/);
    fails('#version 150\nattribute vec4 p;\nvoid main() { gl_Position = p; }',
        /ERROR: 0:2: 'attribute' : not supported in the core profile/, 'vertex');
    ok('#version 150 compatibility\nattribute vec4 p;\nvoid main() { gl_Position = p; }',
        'vertex');
    fails('#version 330\nvoid main() { gl_FragColor = vec4(1.0); }',
        /'gl_FragColor' : undeclared identifier/);
    ok('#version 330 compatibility\nvoid main() { gl_FragColor = texture2D(s, vec2(0.0)); }'
        .replace('void', 'uniform sampler2D s;\nvoid'));
    ok('#version 140\nvoid main() { gl_FragColor = vec4(1.0); }');
    fails('#version 345\nvoid main() {}', /ERROR: 0:1: .*version/);
});

test('a version has the types and words it came with, and not later ones', ()=>{
    ok('#version 130\nflat in uint u;\nout vec4 c;\nvoid main() { c = vec4(float(u)); }');
    fails('#version 120\nvarying float uint;\nvoid main() { gl_FragColor = vec4(uint); }'
        .replace('varying float uint', 'uniform uint u'), /ERROR: 0:2: /);
    ok('#version 130\nfloat layout;\nout vec4 c;\nvoid main() { c = vec4(layout); }');
    fails('#version 140\nfloat layout;\nvoid main() {}', /ERROR: 0:2: /);
    fails('#version 460\nfloat input;\nvoid main() {}', /'input' : reserved/);
    fails('#version 330\ndouble d;\nvoid main() {}', /ERROR: 0:2: /);
    ok(`#version 400\n${OUT}void main() { double d = 1.0lf; color = vec4(float(d)); }`);
    fails('#version 120\nvoid main() { float f = 1.0f; }', /needs version 130/);
    fails('#version 420\nuniform atomic_uint a;\nvoid main() {}', /needs a binding/);
    ok('#version 420\nlayout(binding = 0) uniform atomic_uint a;\nvoid main() {}');
});

test('implicit conversions grow with the version: uint to float at 1.30, to double and'
    + ' int to uint at 4.00', ()=>{
    ok(`#version 130\n${OUT}void main() { float f = 1u; color = vec4(f); }`);
    fails('#version 330\nvoid main() { uint u = 1; }', /cannot convert from 'int' to 'uint'/);
    ok('#version 400\nvoid main() { uint u = 1; double d = 2; dvec2 v = vec2(1.0); }');
    fails('#version 400\nvoid main() { int i = 1u; }', /cannot convert from 'uint' to 'int'/);
    fails('#version 400\nvoid main() { float f = 1.0lf; }', /cannot convert/);
});

test('from 4.00 a call takes the best conversion; before, two are ambiguous', ()=>{
    // Section 6.1: an integer to float is better than an integer to double.
    const unit = ok('#version 400\nvoid f(float x) {}\nvoid f(double x) {}\n'
        + 'void main() { f(1); }');
    const main = unit.functions.find(fn=>fn.name === 'main');
    assert.deepEqual([...(main?.calls ?? [])], ['f(float)']);
    fails('#version 400\nvoid g(float a, double b) {}\nvoid g(double a, float b) {}\n'
        + 'void main() { g(1.0, 1.0); }', /'g' : ambiguous overloaded function call/);
    fails('#version 330\nvoid h(float a, int b) {}\nvoid h(int a, float b) {}\n'
        + 'void main() { h(1, 1); }', /ambiguous/);
    // float to double beats int to uint as the exact match beats both.
    const best = ok('#version 400\nvoid k(double a, uint b) {}\nvoid k(float a, int b) {}\n'
        + 'void main() { k(1.0, 1); }');
    assert.deepEqual([...(best.functions.find(fn=>fn.name === 'main')?.calls ?? [])],
        ['k(float,int)']);
});

test('the integer operators fold: %, shifts, bitwise, ~', ()=>{
    const unit = ok('#version 130\nconst int a = 7 % 3;\nconst uint b = 0xffffffffu >> 28u;\n'
        + 'const int c = -8 >> 1;\nconst int d = ~5 & 0xff;\nconst int e = 1 << 4 | 3 ^ 1;\n'
        + 'float x[a + int(b)];\nvoid main() {}');
    const values = ['a', 'b', 'c', 'd', 'e'].map(n=>unit.globals.get(n)?.constant?.[0]);
    assert.deepEqual(values, [1, 15, -4, 250, 18]);
    const x = unit.globals.get('x')?.type;
    assert.equal(x?.kind === 'array' && x.length, 16);
    fails('#version 130\nvoid main() { float f = 1.0 % 2.0; }', /'%' : wrong operand types/);
    fails('#version 130\nvoid main() { int i = 1 & 1u; }', /wrong operand types/);
    fails('#version 120\nvoid main() { int i = 5 % 2; }', /'%' : reserved operator/);
    ok('#version 400\nvoid main() { uint u = 1 & 1u; }');
});

test('a switch takes an integer, constant labels once each, one default', ()=>{
    ok(`#version 130\n${OUT}uniform int k;\nvoid main() { switch (k) { case 0: color = vec4(0.0);`
        + ' break; case 1: case 2: { color = vec4(1.0); } default: discard; } }');
    ok('#version 130\nuniform uint k;\nvoid main() { switch (k) { case 1u: break; } }');
    const head = '#version 130\nuniform int k;\nuniform float f;\nvoid main() { ';
    fails(`${head}switch (f) { case 0: break; } }`, /selector must be a scalar integer/);
    fails(`${head}switch (k) { case 0: break; case 0: break; } }`, /label 0 is used twice/);
    fails(`${head}switch (k) { default: break; default: break; } }`, /default' : used twice/);
    fails(`${head}switch (k) { discard; case 0: break; } }`, /before the first case/);
    fails(`${head}switch (k) { case 0: break; case 1: } }`, /must be followed by a statement/);
    fails(`${head}switch (k) { case k: break; } }`, /constant integer expression/);
    fails(`${head}continue; }`, /only allowed in loops/);
});

test('layout qualifiers: where each is allowed and the version it came with', ()=>{
    ok('#version 330\nlayout(location = 2) in vec4 p;\nvoid main() { gl_Position = p; }',
        'vertex');
    fails('#version 150\nlayout(location = 2) in vec4 p;\nvoid main() {}',
        /'location' : layout qualifier needs version 330/, 'vertex');
    ok('#version 330\nlayout(LOCATION = 1) out vec4 c;\nvoid main() { c = vec4(1.0); }');
    fails('#version 410\nlayout(binding = 1) uniform sampler2D t;\nvoid main() {}',
        /'binding' : layout qualifier needs version 420/);
    ok('#version 420\nlayout(binding = 1) uniform sampler2D t;\nvoid main() {}');
    fails('#version 430\nlayout(std430) uniform B { float x; };\nvoid main() {}',
        /'std430' : layout qualifier not allowed here/);
    ok('#version 430\nlayout(std430) buffer B { float x; };\nvoid main() {}');
    fails('#version 420\nuniform image2D img;\nvoid main() {}', /needs a format/);
    ok('#version 420\nwriteonly uniform image2D img;\nvoid main() {}');
    ok('#version 420\nlayout(rgba8) readonly uniform image2D img;\nvoid main() {}');
    fails('#version 420\nlayout(r32i) uniform image2D img;\nvoid main() {}',
        /'r32i' : the format does not match/);
    fails('#version 420\nlayout(location = 0) uniform float f;\nvoid main() {}',
        /needs version 430/);
    fails('#version 330\nlayout(location = -1) out vec4 c;\nvoid main() {}', /negative/);
});

test('interpolation: an integer fragment input is flat; patch belongs to tessellation', ()=>{
    fails('#version 130\nin int i;\nvoid main() {}', /must be qualified flat/);
    ok('#version 130\nflat in int i;\nvoid main() {}');
    ok('#version 400\nnoperspective centroid in vec2 uv;\nsample in vec4 s;\nvoid main() {}');
    fails('#version 400\npatch in vec4 p;\nvoid main() {}', /'patch' : only a tessellation/);
    fails('#version 130\nflat uniform float f;\nvoid main() {}', /interpolated/);
    fails('#version 330\nin bool b;\nvoid main() {}', /cannot be a boolean/);
    fails('#version 330\nout mat2 m;\nvoid main() {}', /fragment output must be/);
});

test('uniform and buffer blocks: members, instance, defaults, the std140 places', ()=>{
    const unit = ok('#version 430\nlayout(std140, row_major) uniform;\n'
        + 'uniform Lights { vec4 tint; layout(column_major) mat4 view; float w[2]; } lights;\n'
        + 'layout(std140) uniform Plain { float a; vec3 b; float c; };\n'
        + 'buffer Data { float n; vec4 v[]; } data;\n'
        + `${OUT}void main() { color = lights.tint * lights.view[0] * a * c * b.x`
        + ' * data.v[data.v.length() - 1] * lights.w[1]; }');
    const [lights, plain, data] = unit.blocks;
    assert.deepEqual([lights.name, lights.instance, lights.storage], ['Lights', 'lights',
        'uniform']);
    assert.ok(lights.layout.std140 && lights.layout.row_major, 'the defaults apply');
    assert.deepEqual(lights.members.map(m=>[m.name, !!m.layout.row_major]),
        [['tint', true], ['view', false], ['w', true]]);
    assert.deepEqual(lights.laid?.members.map(m=>m.offset), [0, 16, 80]);
    assert.equal(unit.globals.get('lights')?.block, lights);
    assert.deepEqual(plain.laid?.members.map(m=>m.offset), [0, 16, 28]);
    assert.equal(unit.globals.get('b')?.block, plain, 'an anonymous block\'s members are globals');
    assert.deepEqual([data.layout.shared, data.laid], [true, null], 'shared by default');
    assert.equal(data.members[1].type.kind === 'array' && data.members[1].type.length, 0);
    fails('#version 430\nbuffer D { float v[]; float n; };\nvoid main() {}',
        /only a buffer block's last member/);
    fails('#version 130\nuniform B { float x; };\nvoid main() {}', /needs version 140/);
    fails('#version 430\nuniform B { float x; };\nuniform B { float y; } b;\nvoid main() {}',
        /redefinition of a block/);
    fails('#version 440\nuniform B { layout(offset = 4) float x; };\nvoid main() {}',
        /only in a std140 or std430 block/);
    fails('#version 440\nlayout(std140) uniform B { layout(offset = 2) float x; };\n'
        + 'void main() {}', /not a multiple/);
    fails('#version 430\nuniform B { sampler2D s; };\nvoid main() {}', /cannot be/);
});

test('input and output blocks between stages, and gl_PerVertex redeclared', ()=>{
    const vs = ok('#version 150\nout Data { vec2 uv; flat int id; } data;\n'
        + 'void main() { data.uv = vec2(0.0); data.id = 1; gl_Position = vec4(0.0); }',
    'vertex');
    assert.equal(vs.blocks[0].storage, 'out');
    ok('#version 150\nin Data { vec2 uv; flat int id; } data;\nout vec4 c;\n'
        + 'void main() { c = vec4(data.uv, 0.0, 1.0); }');
    fails('#version 150\nin Data { vec2 uv; } data;\nvoid main() {}',
        /this stage has no input blocks/, 'vertex');
    ok('#version 410\nout gl_PerVertex { vec4 gl_Position; };\n'
        + 'void main() { gl_Position = vec4(1.0); }', 'vertex');
    fails('#version 410\nout gl_PerVertex { vec4 gl_Color; };\nvoid main() {}',
        /not a member of gl_PerVertex/, 'vertex');
});

test('compute: the local size, shared memory, gl_WorkGroupSize folded from the layout', ()=>{
    const unit = ok('#version 430\nlayout(local_size_x = 8, local_size_y = 2) in;\n'
        + 'shared float s[gl_WorkGroupSize.x];\nbuffer B { uint n[]; };\n'
        + 'void main() { s[gl_LocalInvocationID.x] = 1.0; barrier(); memoryBarrierShared();'
        + ' atomicAdd(n[0], 1u); }', 'compute');
    assert.deepEqual(unit.builtins.get('gl_WorkGroupSize')?.constant, [8, 2, 1]);
    assert.deepEqual(unit.layouts.input, { local_size_x: 8, local_size_y: 2 });
    assert.equal(unit.globals.get('s')?.storage, 'shared');
    fails('#version 430\nlayout(local_size_x = 0) in;\nvoid main() {}', /must be 1 to/,
        'compute');
    fails('#version 430\nshared float s;\nvoid main() {}', /compute shaders only/);
    fails('#version 420\nvoid main() {}', /needs a later version/, 'compute');
    fails('#version 430\nvoid main() { uint u = 0u; atomicAdd(u, 1u); }',
        /must be a buffer or shared variable/, 'compute');
    fails('#version 430\nvoid main() { memoryBarrierShared(); }', /compute shader only/);
});

test('geometry: gl_in sized by the input primitive; emits only there', ()=>{
    const unit = ok('#version 150\nlayout(triangles) in;\n'
        + 'layout(triangle_strip, max_vertices = 3) out;\nin vec2 uv[];\nout vec2 tc;\n'
        + 'void main() { for (int i = 0; i < gl_in.length(); i++) { tc = uv[i];'
        + ' gl_Position = gl_in[i].gl_Position; EmitVertex(); } EndPrimitive(); }',
    'geometry');
    const gl_in = unit.builtins.get('gl_in')?.type;
    assert.equal(gl_in?.kind === 'array' && gl_in.length, 3);
    const uv = unit.globals.get('uv')?.type;
    assert.equal(uv?.kind === 'array' && uv.length, 3, 'an unsized input takes the primitive');
    fails('#version 150\nlayout(points) in;\nlayout(lines) in;\nvoid main() {}',
        /a different primitive/, 'geometry');
    fails('#version 150\nlayout(triangle_strip, max_vertices = 4096) out;\nvoid main() {}',
        /more than gl_MaxGeometryOutputVertices/, 'geometry');
    fails('#version 150\nvoid main() { EmitVertex(); }', /geometry shader only/, 'vertex');
    fails('#version 150\nin vec2 uv;\nvoid main() {}', /must be an array/, 'geometry');
});

test('tessellation: vertices, patch outputs, barrier only at main\'s top level', ()=>{
    const unit = ok('#version 400\nlayout(vertices = 4) out;\nout vec3 p[];\n'
        + 'patch out float w;\nvoid main() { p[gl_InvocationID] = vec3(0.0);'
        + ' gl_out[gl_InvocationID].gl_Position = gl_in[gl_InvocationID].gl_Position;'
        + ' gl_TessLevelOuter[0] = 1.0; w = 1.0; barrier(); }', 'tessControl');
    const p = unit.globals.get('p')?.type;
    assert.equal(p?.kind === 'array' && p.length, 4);
    const gl_out = unit.builtins.get('gl_out')?.type;
    assert.equal(gl_out?.kind === 'array' && gl_out.length, 4);
    fails('#version 400\nlayout(vertices = 3) out;\nuniform bool b;\n'
        + 'void main() { if (b) { barrier(); } }', /outside control flow/, 'tessControl');
    ok('#version 400\nlayout(quads, fractional_odd_spacing, cw) in;\npatch in float w;\n'
        + 'void main() { gl_Position = vec4(gl_TessCoord, w); }', 'tessEvaluation');
    fails('#version 400\nlayout(quads) in;\nlayout(isolines) in;\nvoid main() {}',
        /a different primitive/, 'tessEvaluation');
    fails('#version 330\nvoid main() {}', /needs a later version/, 'tessControl');
});

test('built-in constants come from the limits the caller gives', ()=>{
    const source = '#version 330\nfloat a[gl_MaxDrawBuffers];\nvoid main() {}';
    const spec = compile(source).unit?.globals.get('a')?.type;
    assert.equal(spec?.kind === 'array' && spec.length, GLSL_CONSTANTS.gl_MaxDrawBuffers);
    const given = compile(source, 'fragment', { constants: { ...GLSL_CONSTANTS,
        gl_MaxDrawBuffers: 4 } }).unit?.globals.get('a')?.type;
    assert.equal(given?.kind === 'array' && given.length, 4);
});

test('built-in functions per version, stage and profile', ()=>{
    fails('#version 120\nuniform sampler2D s;\nvoid main() { gl_FragColor = texture(s,'
        + ' vec2(0.0)); }', /'texture' : no matching overloaded function/);
    ok(`#version 130\n${OUT}uniform sampler2D s;\nvoid main() { color = texture(s, vec2(0.0));`
        + ' }');
    fails(`#version 330\n${OUT}uniform sampler2D s;\nvoid main() { color = texture2D(s,`
        + ' vec2(0.0)); }', /'texture2D' : no matching/);
    fails('#version 330\nvoid main() { int i = bitfieldExtract(1, 0, 1); }', /no matching/);
    ok('#version 400\nvoid main() { int i = bitfieldExtract(1, 0, 1); uint u ='
        + ' bitCount(5u) + uint(findMSB(8)); }');
    const offset = `#version 330\n${OUT}uniform sampler2D s;\nuniform ivec2 o;\nvoid main() `;
    ok(`${offset}{ color = textureOffset(s, vec2(0.0), ivec2(1, -8)); }`);
    fails(`${offset}{ color = textureOffset(s, vec2(0.0), o); }`, /must be a constant/);
    fails(`${offset}{ color = textureOffset(s, vec2(0.0), ivec2(8, 0)); }`,
        /within \[-8, 7\]/);
    fails(`#version 400\n${OUT}uniform sampler2D s;\nuniform int k;\nvoid main() { color =`
        + ' textureGather(s, vec2(0.0), k); }', /component must be a constant 0 to 3/);
    fails('#version 400\nin vec2 uv;\nvoid main() {}'.replace('void main() {}',
        'void main() { vec2 v = interpolateAtCentroid(uv); }'), /interpolateAtCentroid/,
    'vertex');
    fails('#version 420\nlayout(rgba8) writeonly uniform image2D i;\n'
        + 'void main() { vec4 v = imageLoad(i, ivec2(0)); }', /the image is writeonly/);
    fails('#version 130\nvoid main() { float x = dFdx(1.0); }', /fragment shader only/,
        'vertex');
});

test('constructors, .length() and initializer lists, arrays of arrays from 4.30', ()=>{
    const unit = ok('#version 430\nconst float k[] = float[](1.0, 2.0, 3.0);\n'
        + 'const int n = k.length();\nconst vec3 v = { 1.0, 2.0, 3.0 };\n'
        + 'float g[2][3];\nconst int inner = g[0].length();\nconst mat2 m = mat2(2.0);\n'
        + 'void main() { g[1][2] = v.z; }');
    assert.deepEqual(['n', 'inner'].map(name=>unit.globals.get(name)?.constant),
        [[3], [3]]);
    assert.deepEqual(unit.globals.get('m')?.constant, [2, 0, 0, 2]);
    assert.deepEqual(unit.globals.get('k')?.constant, [1, 2, 3]);
    fails('#version 420\nfloat g[2][3];\nvoid main() {}', /arrays of arrays/);
    fails('#version 410\nconst vec2 v = { 1.0, 2.0 };\nvoid main() {}', /ERROR: 0:2: /);
    fails('#version 430\nconst vec3 v = { 1.0, 2.0 };\nvoid main() {}',
        /wrong number of initializers/);
    ok('#version 420\nvoid main() { vec4 v = vec4(1.0); int n = v.length(); }');
    fails('#version 410\nvoid main() { vec4 v = vec4(1.0); int n = v.length(); }',
        /only an array has a length/);
});

test('subroutines: a type, the functions of it, a uniform called through', ()=>{
    const unit = ok(`#version 400\n${OUT}subroutine vec4 Shade(vec3 n);\n`
        + 'subroutine(Shade) vec4 flatShade(vec3 n) { return vec4(n, 1.0); }\n'
        + 'subroutine uniform Shade shade;\nvoid main() { color = shade(vec3(1.0)); }');
    assert.equal(unit.globals.get('shade')?.subroutine, 'Shade');
    assert.deepEqual(unit.functions.find(f=>f.name === 'flatShade')?.subroutines, ['Shade']);
    fails('#version 400\nsubroutine vec4 Shade(vec3 n);\n'
        + 'subroutine(Shade) vec4 bad(vec2 n) { return vec4(0.0); }\nvoid main() {}',
    /does not match subroutine type 'Shade'/);
    fails('#version 330\nsubroutine vec4 Shade(vec3 n);\nvoid main() {}', /ERROR: 0:2: /);
});

test('a fragment shader writes gl_FragColor, gl_FragData or its own outputs, one of them', ()=>{
    fails('#version 130\nout vec4 c;\nvoid main() { c = vec4(0.0); gl_FragColor = c; }',
        /cannot write both/);
    fails('#version 130\nvoid main() { gl_FragColor = vec4(0.0); gl_FragData[0] = vec4(0.0); }',
        /both gl_FragColor and gl_FragData/);
});

test('the log is ERROR: <string>:<line>: as a driver writes it', ()=>{
    const result = compileFront(['#version 330\n', 'void main() {\n  undefinedName;\n}'],
        'fragment');
    assert.equal(result.log, "ERROR: 1:2: 'undefinedName' : undeclared identifier\n");
});
