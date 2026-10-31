/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Linking GLSL programs and writing them as WGSL: what a program's active
 * attributes and uniforms are and where they live, what a link refuses, and
 * the WGSL each construct WGSL lacks is spelled out in. Whether a device
 * draws what GLSL says is `tools/cdp_test/triangle.mjs --glsl`'s question;
 * this is the text's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileShader } from './context-glsl.js';
import { linkProgram } from './glsl-link.js';
import { emitStage, floatLiteral, intLiteral } from './glsl-wgsl.js';

/**
 * @param {string | string[] | null} vertex @param {string | string[] | null} fragment
 * @param {[string, number][]} [bindings]
 */
function link(vertex, fragment, bindings = []){
    /** @param {string | string[] | null} source @param {'vertex' | 'fragment'} stage */
    const units = (source, stage)=>{
        if (source === null)
        {
            return [];
        }
        return (Array.isArray(source) ? source : [source]).map(text=>{
            const compiled = compileShader([text], stage);
            assert.equal(compiled.log, '', `${stage}: ${text}`);
            return /** @type {any} */ (compiled.unit);
        });
    };
    return linkProgram({ vertex: units(vertex, 'vertex'), fragment: units(fragment, 'fragment'),
        attribBindings: new Map(bindings) });
}

/** @param {ReturnType<typeof link>} result */
const linked = result=>{
    assert.ok(result.ok, result.log);
    return /** @type {import('./glsl-link.js').LinkedProgram} */ (/** @type {any} */ (result)
        .program);
};

/** @type {import('./glsl-wgsl.js').StageOptions} */
const OPTIONS = {
    attributes: [{ name: 'position', slot: 0, offset: 0, format: 'float32x3', components: 3,
        scalar: 'f32' }],
    flat: false, twoSide: false, alphaFunc: null, targets: 1,
    compare: (func, value, reference)=>`${value} < ${reference}`,
};

/**
 * A program's stages as WGSL, with the options given: a fragment shader with
 * no vertex shader meets the fixed vertex stage's struct.
 *
 * @returns {{ vertex: any, fragment: any }}
 */
function emit(/** @type {any} */ program, options = OPTIONS){
    if (!program.vertex)
    {
        return { vertex: null,
            fragment: emitStage(program, 'fragment', options, null, 'fixed') };
    }
    const vertex = emitStage(program, 'vertex', options, null, 'glsl');
    const fragment = emitStage(program, 'fragment', options, vertex.fields, 'glsl');
    return { vertex, fragment };
}

test('attributes take the lowest free locations, the first 0, past what a conventional one'
    + ' the shader reads aliases', ()=>{
    const program = linked(link(`attribute vec3 position; attribute vec4 colour;
attribute mat3 frame; attribute vec2 uv;
void main() { gl_Position = vec4(position + frame * colour.xyz, uv.x) + gl_Color; }`,
    'void main() { gl_FragColor = vec4(1.0); }'));
    const at = Object.fromEntries(program.attributes.map(a=>[a.name, a.location]));
    // gl_Color reads conventional attribute 3, which generic 3 aliases.
    assert.deepEqual(at, { position: 0, colour: 1, frame: 4, uv: 2 });
    assert.deepEqual(program.builtinAttributes, ['gl_Color']);

    const bound = linked(link('attribute vec4 a; attribute vec4 b;\n'
        + 'void main() { gl_Position = a + b; }', null, [['b', 0], ['a', 7]]));
    assert.deepEqual(bound.attributes.map(a=>`${a.name}@${a.location}`), ['a@7', 'b@0'],
        'glBindAttribLocation\'s, at the next link');
    assert.match(link('attribute mat4 m;\nvoid main() { gl_Position = m[0]; }', null,
        [['m', 14]]).log, /bound past the last location/);
});

test('only what main reaches is active', ()=>{
    const program = linked(link(`uniform vec4 used; uniform vec4 unused; attribute vec4 idle;
vec4 never() { return unused + idle; }
void main() { gl_Position = used; }`, null));
    assert.deepEqual(program.uniforms.map(u=>u.name), ['used']);
    assert.deepEqual(program.attributes, []);
});

test('uniforms are laid out leaf by leaf: an array at consecutive locations, a struct by'
    + ' its members', ()=>{
    const program = linked(link(null, `struct Light { vec3 colour; float power; };
uniform Light lights[2];
uniform float weights[3];
uniform mat3 basis;
uniform bool on;
void main()
{
    vec3 sum = basis * (lights[0].colour * lights[1].power) * weights[2];
    gl_FragColor = vec4(sum, on ? 1.0 : 0.0);
}`));
    assert.deepEqual(program.uniforms.map(u=>`${u.name}@${u.location}+${u.offset}x${u.size}`), [
        'lights[0].colour@0+0x1', 'lights[0].power@1+3x1', 'lights[1].colour@2+4x1',
        'lights[1].power@3+7x1', 'weights[0]@4+8x3', 'basis@7+11x1', 'on@8+20x1',
    ]);
    const { fragment } = emit(program);
    const plan = /** @type {import('./glsl-wgsl.js').BlockPlan} */ (fragment.plan);
    // Every value in vec4 slots: the struct's two members, the array a slot an
    // element, the matrix a slot a column; runs that lie together copy as one.
    assert.deepEqual(Array.from(plan.copies), [
        0, 0, 3, 3, 4, 1, 4, 8, 3, 7, 12, 1,
        8, 16, 1, 9, 20, 1, 10, 24, 1,
        11, 28, 3, 14, 32, 3, 17, 36, 3,
        20, 40, 1,
    ]);
    assert.equal(plan.words, 44);
    assert.match(fragment.code, /u_lights: array<fsu_Light, 2>/);
    assert.match(fragment.code, /u_weights: array<vec4f, 3>/);
    assert.match(fragment.code, /u_on: vec4i/);
    assert.match(fragment.code, /\(fu\.u_on\.x != 0i\)/, 'a bool reads as its word not zero');
    assert.match(fragment.code, /fu\.u_weights\[2i\]\.x/);
    assert.match(fragment.code, /fu\.u_lights\[0i\]\.m_colour\.xyz/);
});

test('a link refuses what the stages do not agree on, and what main cannot reach', ()=>{
    assert.match(link('void main() { gl_Position = vec4(1.0); }',
        'varying vec2 uv; void main() { gl_FragColor = vec4(uv, 0.0, 1.0); }').log,
    /varying 'uv' is not declared in the vertex shader/);
    assert.match(link('varying vec3 uv; void main() { uv = vec3(1.0); gl_Position = vec4(1.0); }',
        'varying vec2 uv; void main() { gl_FragColor = vec4(uv, 0.0, 1.0); }').log,
    /has type vec3 in the vertex shader and vec2/);
    assert.match(link(null, 'void main() { gl_FragColor = vec4(1.0); gl_FragData[1] = vec4(0.0); }')
        .log, /both gl_FragColor and gl_FragData/);
    assert.match(link(null, 'float f(float x);\nvoid main() { gl_FragColor = vec4(f(1.0)); }').log,
        /'f\(float\)' is called and not defined/);
    assert.match(link(null, 'float f(float x);\nfloat g(float x) { return f(x); }\n'
        + 'float f(float x) { return g(x); }\nvoid main() { gl_FragColor = vec4(f(1.0)); }').log,
    /recursion is not allowed/);
    assert.match(link(null, 'float helper() { return 1.0; }').log, /no 'main' function/);
    assert.match(link('uniform vec2 u; void main() { gl_Position = vec4(u, 0.0, 1.0); }',
        'uniform vec3 u; void main() { gl_FragColor = vec4(u, 1.0); }').log,
    /different type in the two shaders/);
    assert.equal(link(null, null).ok, false);
});

test('a stage links from several shaders, a function in one called from another', ()=>{
    const program = linked(link(null, [
        'float shade(float x);\nvoid main() { gl_FragColor = vec4(shade(0.5)); }',
        'float shade(float x) { return x * 2.0; }',
    ]));
    const { fragment } = emit(program);
    assert.match(fragment.code, /fn ff\d+_shade\(a\d+_x: f32\) -> f32/);
});

test('the varyings pass by name at locations of their own, and the built-in ones'
    + ' the fragment stage reads', ()=>{
    const program = linked(link(`varying vec2 uv; varying mat2 spin;
void main() { uv = vec2(1.0); spin = mat2(1.0); gl_FrontColor = vec4(1.0);
gl_TexCoord[1] = vec4(2.0); gl_Position = ftransform(); }`,
    `varying vec2 uv; varying mat2 spin;
void main() { gl_FragColor = vec4(spin * uv, 0.0, 1.0) * gl_Color + gl_TexCoord[1]; }`));
    const { vertex, fragment } = emit(program, { ...OPTIONS, flat: true });
    assert.deepEqual(vertex.fields.map((/** @type {{ type: string, flat?: boolean }} */ f)=>`${f.type}${f.flat ? ' flat' : ''}`), [
        'vec2f', 'vec2f', 'vec2f', 'vec4f flat',
        ...new Array(8).fill('vec4f'),
    ], 'a matrix a column a location; GL_FLAT flattens the colour alone');
    assert.match(vertex.code, /out\.i1 = vg_spin\[0\];/);
    assert.match(fragment.code, /fg_spin\[1\] = input\.i2;/);
    assert.match(fragment.code, /fgl_Color = input\.i3;/);
    assert.match(vertex.code, /\(uniforms\.modelViewProjection \* vgl_Vertex\)/,
        'ftransform is the fixed stage\'s product');
});

test('a swizzle of several components, an out argument and a compound assignment are'
    + ' statements of their own', ()=>{
    const program = linked(link(null, `void scale(inout vec3 v, out float k) { k = 2.0; v *= k; }
void main()
{
    vec4 c = vec4(0.0);
    c.zx = vec2(1.0, 2.0);
    float k;
    scale(c.xyz, k);
    c.w += k;
    gl_FragColor = c;
}`));
    const code = emit(program).fragment.code;
    assert.match(code, /l\d+_c\.z = t\d+\.x;\s+l\d+_c\.x = t\d+\.y;/);
    assert.match(code, /var t\d+: vec3f = l\d+_c\.xyz;/);
    assert.match(code, /ff\d+_scale\(&t\d+, &t\d+\);/);
    assert.match(code, /l\d+_c\.x = t\d+\.x;\s+l\d+_c\.y = t\d+\.y;\s+l\d+_c\.z = t\d+\.z;/,
        'the inout swizzle is written back a component at a time');
    assert.match(code, /l\d+_c\.w = \(l\d+_c\.w \+ l\d+_k\);/);
    assert.match(code, /fn ff\d+_scale\(pp\d+_v: ptr<function, vec3f>, pp\d+_k: ptr<function, f32>\)/);
});

test('the operations WGSL lacks are spelled out', ()=>{
    const program = linked(link(null, `uniform mat3 m; uniform vec2 v; uniform float s;
void main()
{
    mat3 a = m / s;
    mat3 b = m + s;
    mat3 c = matrixCompMult(m, m);
    float r = mod(s, 3.0);
    bool same = v == vec2(1.0);
    gl_FragColor = vec4(a[0] + b[1] + c[2], r) * (same ? 1.0 : 0.5);
}`));
    const code = emit(program).fragment.code;
    assert.match(code, /\(fu\.u_m \* \(1\.0f \/ fu\.u_s\.x\)\)/, 'a matrix by a scalar divides');
    assert.ok(code.includes('mat3x3f((fu.u_m[0] + fu.u_s.x), (fu.u_m[1] + fu.u_s.x),'
        + ' (fu.u_m[2] + fu.u_s.x))'), 'a matrix plus a scalar, column by column');
    assert.ok(code.includes('mat3x3f(fu.u_m[0] * fu.u_m[0], fu.u_m[1] * fu.u_m[1],'
        + ' fu.u_m[2] * fu.u_m[2])'));
    assert.ok(code.includes('(fu.u_s.x - 3.0f * floor(fu.u_s.x / 3.0f))'),
        'mod is GLSL\'s, floored, where WGSL\'s % truncates');
    assert.match(code, /all\(fu\.u_v\.xy == vec2f\(1\.0f, 1\.0f\)\)/,
        'vectors compare whole');
    assert.match(code, /select\(0\.5f, 1\.0f, l\d+_same\)/, 'a pure ?: is a select');
});

test('a ?: whose branch does something becomes an if; an && keeps WGSL\'s short circuit',
    ()=>{
        const program = linked(link(null, `float count = 0.0;
float bump() { count += 1.0; return count; }
void main()
{
    bool b = count > 0.0 && bump() > 1.0;
    float x = b ? bump() : 0.0;
    gl_FragColor = vec4(x);
}`));
        const code = emit(program).fragment.code;
        assert.ok(code.includes('((fg_count > 0.0f) && (ff0_bump() > 1.0f))'));
        assert.match(code, /var t\d+: f32;\s+if \(l\d+_b\) \{\s+t\d+ = ff0_bump\(\);/);
    });

test('loops become WGSL loops whose continuing block steps them', ()=>{
    const program = linked(link(null, `void main()
{
    float s = 0.0;
    for (int i = 0, j = 4; i < j; i++, j--) { if (i == 1) continue; s += 1.0; }
    int k = 3;
    do { k--; } while (k > 0);
    gl_FragColor = vec4(s);
}`));
    const code = emit(program).fragment.code;
    assert.match(code, /loop \{\s+if \(!\(\(l\d+_i < l\d+_j\)\)\) \{ break; \}/);
    assert.match(code, /continuing \{\s+l\d+_i = l\d+_i \+ 1i;\s+l\d+_j = l\d+_j - 1i;\s+\}/);
    assert.match(code, /break if !\(\(l\d+_k > 0i\)\);/);
});

test('state, attributes without an array, and samplers are the block\'s and the bindings\'',
    ()=>{
        const program = linked(link(`attribute vec4 weight;
void main() { gl_Position = gl_ModelViewProjectionMatrix * gl_Vertex * weight.x
    + gl_LightSource[1].diffuse + vec4(gl_NormalMatrix * gl_Normal, 0.0); }`,
        `uniform sampler2D base; uniform samplerCube sky;
void main() { gl_FragColor = texture2D(base, gl_FragCoord.xy) + textureCube(sky, vec3(1.0)); }`));
        const { vertex, fragment } = emit(program);
        const plan = /** @type {import('./glsl-wgsl.js').BlockPlan} */ (vertex.plan);
        assert.deepEqual(plan.state.map(s=>s.name).sort(),
            ['gl_LightSource', 'gl_ModelViewProjectionMatrix', 'gl_NormalMatrix']);
        assert.deepEqual(plan.attribs.map(a=>`${a.location}:${a.builtin}`).sort(),
            ['1:null', '2:gl_Normal'],
            'the generic attribute, past 0 which gl_Vertex holds, and gl_Normal have no array'
                + ' in this draw');
        assert.match(vertex.code, /vgl_Vertex = vec4f\(vertex\.position, 1\.0\);/);
        assert.match(fragment.samplers.join('\n'),
            /@binding\(1\) var glt0: texture_2d<f32>;[\s\S]*@binding\(3\) var glt1: texture_cube<f32>;/);
        assert.match(fragment.code, /textureSample\(glt0, gls0, fgl_FragCoord\.xy\)/);
        assert.match(fragment.code,
            /select\(input\.position\.y, uniforms\.misc\.w - input\.position\.y, uniforms\.misc\.z/,
            'gl_FragCoord counts rows up from the bottom whichever way the target runs');
    });

test('the fragment stage writes every target, the alpha test after it', ()=>{
    const data = linked(link(null, 'void main() { gl_FragData[0] = vec4(1.0);'
        + ' gl_FragData[2] = vec4(0.5); }'));
    const many = emit(data, { ...OPTIONS, targets: 3 }).fragment.code;
    assert.match(many, /@location\(2\) c2: vec4f/);
    assert.match(many, /out\.c2 = fgl_FragData\[2\];/);
    const colour = linked(link(null, 'void main() { gl_FragColor = vec4(1.0); }'));
    const broadcast = emit(colour, { ...OPTIONS, targets: 2, alphaFunc: 0x0201 }).fragment.code;
    assert.match(broadcast, /out\.c1 = fgl_FragColor;/, 'gl_FragColor goes to every draw buffer');
    assert.match(broadcast, /if \(!\(fgl_FragColor\.a < uniforms\.misc\.x\)\) \{\s+discard;/);
});

test('literals are WGSL\'s typed ones', ()=>{
    assert.equal(floatLiteral(1), '1.0f');
    assert.equal(floatLiteral(0.1), `${Math.fround(0.1)}f`);
    assert.equal(floatLiteral(1e30), '1.0000000150474662e+30f');
    assert.equal(floatLiteral(Infinity), 'bitcast<f32>(0x7f800000u)');
    assert.equal(intLiteral(-3), '(-3i)');
    assert.equal(intLiteral(-2147483648), '(-2147483647i - 1i)');
});

test('a program that samples a 3D texture does not link, and says why', ()=>{
    const result = link(null, 'uniform sampler3D volume;\n'
        + 'void main() { gl_FragColor = texture3D(volume, vec3(0.5)); }');
    assert.equal(result.ok, false);
    assert.match(result.log, /no 3D textures/);
});
