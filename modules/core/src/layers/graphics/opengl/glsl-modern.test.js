/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GLSL 1.30 to 3.30 linked and written as WGSL, against the language
 * specifications (1.30, 1.40, 1.50, 3.30) and OpenGL 3.0 to 3.3's linking
 * rules: inputs matched to outputs by name, attribute and fragment output
 * locations, uniform blocks laid out by std140, and the WGSL each construct
 * WGSL lacks or spells otherwise becomes. Whether the WGSL is valid is
 * checked by a browser's compiler outside these tests; here, what it says.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMITTED_VERSIONS, compileShader } from './context-glsl.js';
import { linkProgram } from './glsl-link.js';
import { emitStage, interfaceStruct } from './glsl-wgsl.js';
import { canonicalAttribName } from './arb-program.js';

/**
 * @param {string | null} vertex @param {string | null} fragment
 * @param {{ attribs?: [string, number][], fragData?: [string, number, number][] }} [bindings]
 */
function link(vertex, fragment, bindings = {}){
    /** @param {string | null} source @param {'vertex' | 'fragment'} stage */
    const units = (source, stage)=>{
        if (source === null)
        {
            return [];
        }
        const compiled = compileShader([source], stage);
        assert.ok(compiled.ok, `${stage}: ${compiled.log}`);
        const unit = /** @type {any} */ (compiled.unit);
        return [unit];
    };
    return linkProgram({ vertex: units(vertex, 'vertex'), fragment: units(fragment, 'fragment'),
        attribBindings: new Map(bindings.attribs ?? []),
        fragDataBindings: new Map((bindings.fragData ?? []).map(([name, location, index])=>
            [name, { location, index }])) });
}

/** @param {ReturnType<typeof link>} result */
const linked = result=>{
    assert.ok(result.ok, result.log);
    return /** @type {import('./glsl-link.js').LinkedProgram} */ (/** @type {any} */ (result)
        .program);
};

/**
 * Both stages as WGSL, with an array for every attribute the program has and
 * the targets given.
 *
 * @param {import('./glsl-link.js').LinkedProgram} program
 * @param {string[]} [targetScalars]
 */
function emit(program, targetScalars = ['f32']){
    const attributes = program.attributes.map(a=>{
        const base = /** @type {any} */ (a.type).base ?? 'float';
        /** @type {'i32' | 'u32' | 'f32'} */
        const scalar = base === 'int' ? 'i32' : base === 'uint' ? 'u32' : 'f32';
        return { name: canonicalAttribName(a.location), slot: 0, offset: 0,
            format: 'float32x4', components: 4, scalar };
    });
    /** @type {import('./glsl-wgsl.js').StageOptions} */
    const options = { attributes, flat: false, twoSide: false, alphaFunc: null,
        targets: targetScalars.length, targetScalars, compare: ()=>'true' };
    const vertex = emitStage(program, 'vertex', options, null, 'glsl');
    const fragment = program.fragment
        ? emitStage(program, 'fragment', options, vertex.fields, 'glsl') : null;
    return { vertex, fragment: /** @type {any} */ (fragment),
        struct: interfaceStruct(vertex.fields) };
}

const PASS = `#version 130
in vec4 position; void main() { gl_Position = position; }`;
const WHITE = `#version 130
out vec4 c; void main() { c = vec4(1.0); }`;

test('every version from 1.10 to 4.60 compiles; one past them is refused', ()=>{
    assert.deepEqual(EMITTED_VERSIONS, [110, 120, 130, 140, 150, 330, 400, 410, 420, 430, 440,
        450, 460]);
    for (const version of ['130', '140', '150', '150 compatibility', '330 core', '400', '410 core',
        '420', '430 core', '440', '450 compatibility', '460 core'])
    {
        const compiled = compileShader([`#version ${version}\nvoid main() {}`], 'vertex');
        assert.ok(compiled.ok, `${version}: ${compiled.log}`);
    }
    assert.match(compileShader(['#version 470\nvoid main() {}'], 'vertex').log,
        /version 470 is not supported/);
});

test('an input reads the output of its name; a block member by Block.member', ()=>{
    const program = linked(link(`#version 150
in vec4 position; out vec2 uv; flat out int id; noperspective out float depth;
out Data { vec3 normal; centroid vec4 tint; } data;
void main() { uv = position.xy; id = 1; depth = 0.5; data.normal = vec3(0.0);
    data.tint = vec4(1.0); gl_Position = position; }`, `#version 150
in vec2 uv; flat in int id; noperspective in float depth;
in Data { vec3 normal; centroid vec4 tint; } fromVertex;
out vec4 c;
void main() { c = vec4(uv, float(id) + depth, 1.0) + vec4(fromVertex.normal, 0.0)
    + fromVertex.tint; }`));
    assert.deepEqual(program.varyings.map(v=>`${v.name}:${v.vertexPath}>${v.fragmentPath}`
        + `:${v.interpolation}${v.centroid ? ':centroid' : ''}`), [
        'uv:g_uv>g_uv:smooth', 'id:g_id>g_id:flat', 'depth:g_depth>g_depth:noperspective',
        'Data.normal:g_data.m_normal>g_fromVertex.m_normal:smooth',
        'Data.tint:g_data.m_tint>g_fromVertex.m_tint:smooth:centroid',
    ]);
    const { struct, vertex, fragment } = emit(program);
    assert.match(struct, /@location\(0\) i0: vec2f,/);
    assert.match(struct, /@location\(1\) @interpolate\(flat\) i1: i32,/);
    assert.match(struct, /@location\(2\) @interpolate\(linear\) i2: f32,/);
    assert.match(struct, /@location\(4\) @interpolate\(perspective, centroid\) i4: vec4f,/);
    assert.match(vertex.code, /out\.i3 = vg_data\.m_normal;/);
    assert.match(fragment.code, /fg_fromVertex\.m_tint = input\.i4;/);
});

test('a link refuses an input no output of its name, type or interpolation feeds', ()=>{
    assert.match(link(PASS, `#version 130
in vec2 uv; out vec4 c; void main() { c = vec4(uv, 0.0, 1.0); }`).log,
    /fragment shader input 'uv' is not declared in the vertex shader/);
    assert.match(link(`#version 130
in vec4 position; out vec3 uv; void main() { uv = position.xyz; gl_Position = position; }`,
    `#version 130
in vec2 uv; out vec4 c; void main() { c = vec4(uv, 0.0, 1.0); }`).log,
    /input 'uv' has type vec3 in the vertex shader and vec2 in the fragment shader/);
    assert.match(link(`#version 130
in vec4 position; flat out vec2 uv; void main() { uv = position.xy; gl_Position = position; }`,
    `#version 130
in vec2 uv; out vec4 c; void main() { c = vec4(uv, 0.0, 1.0); }`).log,
    /'uv' is interpolated flat in the vertex shader and smooth in the fragment shader/);
    assert.ok(link(`#version 130
in vec4 position; out vec2 unused; void main() { gl_Position = position; }`, WHITE).ok,
    'an output nothing reads is no error');
});

test('a layout(location) wins over glBindAttribLocation; the rest take what is free', ()=>{
    const program = linked(link(`#version 330
layout(location = 3) in vec4 position; in vec2 uv; in ivec2 bone;
void main() { gl_Position = position + vec4(uv, vec2(bone)); }`, null,
    { attribs: [['position', 7], ['bone', 5]] }));
    assert.deepEqual(program.attributes.map(a=>`${a.name}@${a.location}`),
        ['position@3', 'bone@5', 'uv@0']);
    const { vertex } = emit(program);
    assert.match(vertex.code, /vg_bone = vertex\.fogCoord\.xy;/,
        'an integer input read whole, from location 5 (the fog coordinate\'s alias)');
    assert.match(link(`#version 330
layout(location = 2) in vec4 a; layout(location = 2) in vec4 b;
void main() { gl_Position = a + b; }`, null).log, /another attribute has in the shader/);
});

test('fragment outputs: layout, then glBindFragDataLocation, then the lowest free', ()=>{
    const program = linked(link(PASS, `#version 330
layout(location = 2) out vec4 bright; out vec4 base; out ivec2 ids; out uvec4 mark;
void main() { bright = vec4(1.0); base = vec4(0.5); ids = ivec2(1); mark = uvec4(7u); }`,
    { fragData: [['mark', 3, 0], ['bright', 0, 0]] }));
    assert.deepEqual(program.outputs.map(o=>`${o.name}@${o.location}`),
        ['bright@2', 'mark@3', 'base@0', 'ids@1']);
    assert.deepEqual(linked(link(PASS, `#version 330
layout(location = 1) out vec4 one; out vec4 pair[2];
void main() { one = vec4(1.0); pair[0] = one; pair[1] = one; }`)).outputs
        .map(o=>`${o.name}@${o.location}`), ['one@1', 'pair@2'],
    'an array takes consecutive locations, the first run free');
    assert.match(link(PASS, `#version 330
out vec4 a; out vec4 b[4]; void main() { a = vec4(1.0); b[0] = a; }`).log,
    /past the 4 draw buffers/, 'four buffers, five outputs');
    assert.match(link(PASS, `#version 330
layout(location = 1) out vec4 a; layout(location = 1) out vec4 b;
void main() { a = vec4(1.0); b = a; }`).log, /location 1, which another output has/);
    const bound = link(PASS, `#version 150
out vec4 s_frag_color; out vec4 s_frag_data_0; out vec4 s_frag_data_1;
void main() { s_frag_data_0 = vec4(1.0); s_frag_data_1 = s_frag_data_0; }`, {
        fragData: [['s_frag_color', 0, 0], ['s_frag_data_0', 0, 0], ['s_frag_data_1', 1, 0]] });
    assert.deepEqual(linked(bound).outputs.map(o=>`${o.name}@${o.location}`),
        ['s_frag_data_0@0', 's_frag_data_1@1'],
        'an output main never writes is not active: its binding to a taken number is no conflict');
    assert.match(link(PASS, `#version 150
out vec4 c; out vec4 d; void main() { c = vec4(1.0); d = c; }`, {
        fragData: [['c', 0, 0], ['d', 0, 0]] }).log, /location 0, which another output has/,
    'two active outputs bound to one number fail the link');

    const written = linked(link(PASS, `#version 330
layout(location = 1) out ivec4 ids; layout(location = 0) out vec2 rg;
void main() { ids = ivec4(3); rg = vec2(0.5); }`));
    const { fragment } = emit(written, ['f32', 'i32', 'u32']);
    assert.match(fragment.code, /@location\(1\) c1: vec4i,/);
    assert.match(fragment.code, /out\.c0 = vec4f\(fg_rg, 0\.0f, 1\.0f\);/, 'widened as 0, 1');
    assert.match(fragment.code, /out\.c1 = fg_ids;/);
    assert.match(fragment.code, /out\.c2 = vec4u\(vec4f\(0\.0f\)\);/,
        'a target no output is at is written zero, in its own type');
});

test('uniform blocks: std140 offsets, the names the program lists, one block for both stages',
    ()=>{
        const program = linked(link(`#version 140
in vec4 position;
layout(std140) uniform Scene { vec3 a; float b; vec2 c; mat3 d; float e[2]; } scene;
uniform Shared { vec4 tint; };
void main() { gl_Position = position * scene.b + vec4(scene.a, scene.e[1]) + tint; }`,
        `#version 140
out vec4 c; uniform Shared { vec4 tint; };
void main() { c = tint; }`));
        assert.deepEqual(program.blocks.map(b=>`${b.name}:${b.size}:${b.stages.vertex ? 'v' : ''}`
            + `${b.stages.fragment ? 'f' : ''}`), ['Scene:112:v', 'Shared:16:vf']);
        assert.deepEqual(program.blockUniforms.map(u=>`${u.name}@${u.offset}/${u.arrayStride}`
            + `/${u.matrixStride}x${u.size}`), [
            'Scene.a@0/0/0x1', 'Scene.b@12/0/0x1', 'Scene.c@16/0/0x1', 'Scene.d@32/0/16x1',
            'Scene.e[0]@80/16/0x2', 'tint@0/0/0x1',
        ]);
        assert.deepEqual(program.uniforms, [], 'no default-block uniform');
        const { vertex, fragment } = emit(program);
        assert.match(vertex.code, /bitcast<f32>\(glb0\[0\]\.w\)/, 'b at 12');
        assert.match(vertex.code, /bitcast<vec3f>\(glb0\[0\]\.xyz\)/, 'a at 0');
        assert.match(vertex.code, /bitcast<f32>\(glb0\[6\]\.x\)/, 'e[1] at 80 + 16');
        assert.deepEqual([vertex.usedBlocks, fragment.usedBlocks], [[0, 1], [1]]);
    });

test('a block both stages declare differently does not link', ()=>{
    assert.match(link(`#version 140
in vec4 position; uniform B { vec4 x; };
void main() { gl_Position = position + x; }`, `#version 140
out vec4 c; uniform B { vec2 x; }; void main() { c = vec4(x, 0.0, 1.0); }`).log,
    /uniform block 'B' is declared differently/);
});

test('a block read at a computed index adds its stride; a row-major matrix\'s column is its'
    + ' rows\' components', ()=>{
    const program = linked(link(`#version 140
in vec4 position;
layout(std140, row_major) uniform M { mat4 m; vec4 list[3]; int at; };
void main() { gl_Position = m[1] + list[at] + m * position; }`, null));
    const { vertex } = emit(program);
    assert.match(vertex.code,
        /bitcast<vec4f>\(vec4u\(glb0\[0\]\.y, glb0\[1\]\.y, glb0\[2\]\.y, glb0\[3\]\.y\)\)/);
    const whole = String.raw`mat4x4f\(bitcast<vec4f>\(vec4u\(glb0\[0\]\.x, glb0\[1\]\.x,`
        + String.raw` glb0\[2\]\.x, glb0\[3\]\.x\)\), bitcast<vec4f>\(vec4u\(glb0\[0\]\.y,`;
    assert.match(vertex.code, new RegExp(whole),
        'the whole matrix column by column, each from the rows');
    assert.match(vertex.code, /let t\d+: u32 = u32\(bitcast<i32>\(glb0\[7\]\.x\)\) \* 16u;/,
        'list[at]: at\'s value times the array stride');
    assert.match(vertex.code, /vubw0\(t\d+ \+ 64u\)/, 'from list\'s offset');
    assert.match(vertex.code, /fn vubw0\(o: u32\) -> u32 \{\n {4}return glb0\[o >> 4u\]\[\(o >> 2u\) & 3u\];/);
});

test('a switch falls through by writing each label\'s clause to the next that leaves', ()=>{
    const program = linked(link(`#version 130
in vec4 position; uniform int mode; out float v;
void main() {
    float x = 0.0;
    switch (mode) {
    case 0: x = 1.0; break;
    case 1: case 2: x = 2.0;
    case 3: { x += 3.0; break; }
    case 4: int k = 4; x = float(k);
    }
    v = x; gl_Position = position;
}`, `#version 130
in float v; out vec4 c; void main() { c = vec4(v); }`));
    const { vertex } = emit(program);
    const body = vertex.code.slice(vertex.code.indexOf('switch'));
    assert.match(body, /case 1i, 2i: \{\n\s+l\d+_x = 2\.0f;\n\s+\{\n\s+l\d+_x = \(l\d+_x \+ 3\.0f\);\n\s+break;\n\s+\}\n\s+\}/,
        'case 1 and 2 fall into case 3, which leaves inside its block');
    assert.match(body, /case 4i: \{\n\s+l\d+_k = 4i;/, 'a declaration is assigned where it was');
    assert.match(vertex.code, /var l\d+_k: i32;\n\s+switch/, 'and declared before the switch');
    assert.match(body, /default: \{\}/, 'WGSL wants a default');
});

test('unsigned and bitwise operations are spelled as WGSL takes them', ()=>{
    const program = linked(link(`#version 130
in vec4 position; uniform uint u; uniform int s; flat out uvec3 r; flat out ivec3 i;
void main() {
    uint n = -u; uvec3 v = uvec3(u) << s; ivec3 w = ivec3(1) & 3; w >>= 1u; w = ~w;
    r = v + uvec3(n); i = w; gl_Position = position;
}`, `#version 130
flat in uvec3 r; flat in ivec3 i; out vec4 c;
void main() { c = vec4(vec3(r) + vec3(i), 1.0); }`));
    const { vertex } = emit(program);
    assert.match(vertex.code, /\(u32\(\) - bitcast<u32>|\(u32\(\) - vu\.u_u\.x\)/,
        'a uint negated as 0 - u');
    assert.match(vertex.code, /<< vec3u\(vu\.u_s\.x\)\)/, 'a scalar int count, made unsigned');
    assert.match(vertex.code, /\(vec3i\(1i, 1i, 1i\) & vec3i\(3i\)\)|vec3i\(1i, 1i, 1i\)/,
        'a scalar beside a vector made a vector');
    assert.match(vertex.code, />> vec3u\(1u\)\)/);
    assert.match(vertex.code, /\(~l\d+_w\)/);
});

test('built-ins: isnan by the bits, modf\'s whole part out, inverse as a function', ()=>{
    const program = linked(link(`#version 330
in vec4 position; uniform mat3 m; out vec4 v;
void main() { vec4 whole; vec4 f = modf(position, whole); bvec4 n = isnan(position);
    v = f + whole + vec4(inverse(m) * position.xyz, 0.0) + vec4(n);
    gl_Position = vec4(floatBitsToUint(position.x)); }`, `#version 330
in vec4 v; out vec4 c; void main() { c = v; }`));
    const { vertex } = emit(program);
    assert.match(vertex.code,
        /\(\(bitcast<vec4u>\(vg_position\) & vec4u\(0x7fffffffu\)\) > vec4u\(0x7f800000u\)\)/);
    assert.match(vertex.code, /let t\d+ = modf\(vg_position\);\n\s+l\d+_whole = t\d+\.whole;/);
    assert.match(vertex.code, /fn vinverse3\(m: mat3x3f\) -> mat3x3f/);
    assert.match(vertex.code, /vinverse3\(/);
    assert.match(vertex.code, /bitcast<u32>\(vg_position\.x\)/);
});

test('1.30\'s lookups: fetched, sized, at a level, compared, and integer textures loaded', ()=>{
    const program = linked(link(`#version 130
in vec4 position; out vec4 v;
void main() { v = position; gl_Position = position; }`, `#version 130
in vec4 v; out vec4 c;
uniform sampler2D s; uniform sampler2DArray a; uniform isampler2D i;
uniform sampler2DShadow d; uniform sampler1D one;
void main() {
    c = texelFetch(s, ivec2(v.xy), 2) + textureLod(a, v.xyz, 1.0) + vec4(texture(i, v.xy))
        + vec4(texture(d, v.xyz)) + texture(one, v.x) + textureOffset(s, v.xy, ivec2(1, -1))
        + vec4(textureSize(s, 1), textureSize(a, 0).z, 0);
}`));
    const { fragment } = emit(program);
    const code = fragment.code;
    assert.match(code, /let t0: vec2i = vec2i\(vec2i\(fg_v\.xy\)\);[^]*textureLoad\(glt0, t0, 2i\)/);
    assert.ok(code.includes('textureSampleLevel(glt1, gls1, fg_v.xyz.xy,'
        + ' i32(floor(fg_v.xyz.z + 0.5f)), 1.0f)'), 'an array\'s layer rounded');
    assert.match(code, /textureLoad\(glt2, clamp\(vec2i\(floor\(fg_v\.xy \* vec2f\(t\d+\)\)\), vec2i\(0\), t\d+ - vec2i\(1\)\), 0\)/);
    assert.match(code, /textureSampleCompare\(glt3, gls3, fg_v\.xyz\.xy, fg_v\.xyz\.z\)/,
        'a shadow sampler compares, by the texture\'s function');
    const declared = fragment.samplers.join('\n');
    assert.match(declared, /var glt3: texture_depth_2d;\n.*var gls3: sampler_comparison;/);
    assert.match(declared, /var glt1: texture_2d_array<f32>;/);
    assert.match(declared, /var glt2: texture_2d<i32>;/);
    assert.match(code, /textureSample\(glt4, gls4, vec2f\(fg_v\.x, 0\.5f\)\)/);
    assert.match(code, /textureSample\(glt0, gls0, fg_v\.xy, vec2i\(1i, \(-1i\)\)\)/);
    assert.match(code, /textureDimensions\(glt0, u32\(1i\)\)/);
    assert.match(code, /textureNumLayers\(glt1\)/);
});

test('gl_VertexID counts from the draw\'s bias, gl_InstanceID from WebGPU\'s instance', ()=>{
    const program = linked(link(`#version 140
out vec2 uv;
void main() { uv = vec2(float(gl_VertexID), float(gl_InstanceID)); gl_Position = vec4(0.0); }`,
    `#version 140
in vec2 uv; out vec4 c; void main() { c = vec4(uv, 0.0, 1.0); }`));
    const { vertex } = emit(program);
    assert.match(vertex.code, /fn vertexMain\(@builtin\(vertex_index\) vertexIndex: u32,/
        , 'no vertex struct when the shader reads no array');
    assert.match(vertex.code, /vgl_VertexID = i32\(vertexIndex\) \+ vu\.id_bias\.x;/);
    assert.match(vertex.code, /vgl_InstanceID = i32\(instanceIndex\);/);
    assert.equal(typeof vertex.plan?.idBias, 'number');
});
