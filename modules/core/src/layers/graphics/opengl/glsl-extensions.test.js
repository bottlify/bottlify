/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * `#extension` against the extensions' own specifications: an extension a
 * shader enables brings its features to a version before the one that made
 * them core, and nothing when it is disabled or not named. What the context
 * reports of them is `extensions.test.js`'s.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileShader } from './context-glsl.js';
import { linkProgram } from './glsl-link.js';
import { emitStage } from './glsl-wgsl.js';
import { GL_EXTENSIONS } from './extensions.js';
import { GLSL_EXTENSIONS, languageOf } from './glsl-versions.js';

/** @param {string} source @param {'vertex' | 'fragment'} [stage] */
const compiles = (source, stage = 'vertex')=>compileShader([source], stage);

/**
 * A shader that compiles with the extension enabled, not without it, nor
 * with it disabled.
 *
 * @param {string} extension @param {string} version @param {string} body
 * @param {'vertex' | 'fragment'} [stage]
 */
function gated(extension, version, body, stage = 'vertex'){
    const on = compiles(`#version ${version}\n#extension ${extension} : enable\n${body}`, stage);
    assert.ok(on.ok, `${extension} enabled: ${on.log}`);
    const off = compiles(`#version ${version}\n${body}`, stage);
    assert.equal(off.ok, false, `${extension} not named compiled`);
    const disabled = compiles(`#version ${version}\n#extension ${extension} : disable\n${body}`,
        stage);
    assert.equal(disabled.ok, false, `${extension} disabled compiled`);
    return /** @type {any} */ (on.unit);
}

/** @param {any} vertexUnit @param {any} [fragmentUnit] */
function wgslOf(vertexUnit, fragmentUnit){
    const result = /** @type {any} */ (linkProgram({ vertex: [vertexUnit],
        fragment: fragmentUnit ? [fragmentUnit] : [], attribBindings: new Map(),
        fragDataBindings: new Map() }));
    assert.ok(result.ok, result.log);
    /** @type {import('./glsl-wgsl.js').StageOptions} */
    const options = { attributes: [], flat: false, twoSide: false, alphaFunc: null, targets: 1,
        targetScalars: ['f32'], compare: ()=>'true' };
    const vertex = emitStage(result.program, 'vertex', options, null, 'glsl');
    const fragment = fragmentUnit
        ? emitStage(result.program, 'fragment', options, vertex.fields, 'glsl') : null;
    return { vertex: [...vertex.samplers, vertex.code].join('\n'),
        fragment: fragment ? [...fragment.samplers, fragment.code].join('\n') : '',
        blocks: vertex.usedBlocks };
}

test('GL_ARB_uniform_buffer_object: blocks and their std140 layout in 1.20', ()=>{
    const unit = gated('GL_ARB_uniform_buffer_object', '120', `
layout(std140) uniform Light { vec4 colour; mat4 view; };
void main() { gl_Position = view * colour; }`);
    const { vertex, blocks } = wgslOf(unit);
    assert.deepEqual(blocks, [0]);
    // std140: colour at 0, the matrix's columns at 16 to 64.
    assert.match(vertex, /mat4x4f\(bitcast<vec4f>\(glb0\[1\]\.xyzw\)/);
    assert.match(vertex, /\* bitcast<vec4f>\(glb0\[0\]\.xyzw\)/);
});

test('GL_ARB_explicit_attrib_location: an input\'s location in 1.30', ()=>{
    const unit = gated('GL_ARB_explicit_attrib_location', '130', `
layout(location = 3) in vec4 position; void main() { gl_Position = position; }`);
    const result = /** @type {any} */ (linkProgram({ vertex: [unit], fragment: [],
        attribBindings: new Map(), fragDataBindings: new Map() }));
    assert.ok(result.ok, result.log);
    assert.deepEqual(result.program.attributes.map((/** @type {any} */ a)=>
        [a.name, a.location]), [['position', 3]]);
});

test('GL_ARB_draw_instanced: gl_InstanceIDARB is gl_InstanceID, in 1.20 and 1.30', ()=>{
    for (const version of ['120', '130'])
    {
        const unit = gated('GL_ARB_draw_instanced', version, `
void main() { gl_Position = vec4(float(gl_InstanceIDARB)); }`);
        const { vertex } = wgslOf(unit);
        assert.match(vertex, /@builtin\(instance_index\)/, version);
        assert.match(vertex, /gl_InstanceID = i32\(instanceIndex\)/, version);
        assert.doesNotMatch(vertex, /InstanceIDARB/, version);
    }
});

test('GL_EXT_gpu_shader4: bit operators, gl_VertexID and gl_InstanceID in 1.20', ()=>{
    const unit = gated('GL_EXT_gpu_shader4', '120', `
void main() { gl_Position = vec4(float((gl_VertexID & 3) | (gl_InstanceID << 2))); }`);
    const { vertex } = wgslOf(unit);
    assert.match(vertex, /@builtin\(vertex_index\)/);
    assert.match(vertex, /@builtin\(instance_index\)/);
});

test('GL_ARB_texture_rectangle: its samplers and lookups in 1.10, with and without a'
    + ' projection or a comparison', ()=>{
    const unit = gated('GL_ARB_texture_rectangle', '110', `
uniform sampler2DRect image; uniform sampler2DRectShadow depth;
void main() { gl_FragColor = texture2DRect(image, gl_FragCoord.xy)
    + texture2DRectProj(image, vec3(gl_FragCoord.xy, 2.0))
    + texture2DRectProj(image, gl_FragCoord)
    + shadow2DRect(depth, vec3(gl_FragCoord.xy, 0.5))
    + shadow2DRectProj(depth, gl_FragCoord); }`, 'fragment');
    const vs = /** @type {any} */ (compiles('#version 110\nvoid main() { gl_Position = vec4(0.0); }')
        .unit);
    const { fragment } = wgslOf(vs, unit);
    assert.match(fragment, /texture_2d<f32>/);
    assert.match(fragment, /texture_depth_2d/);
    // Rectangle coordinates are texels: divided by the size before WGSL's sample.
    assert.match(fragment, /\/ vec2f\(textureDimensions\(/);
    assert.equal(fragment.match(/textureSampleCompare/g)?.length, 2);
    // No bias forms: the extension has none.
    assert.equal(compiles('#version 110\n#extension GL_ARB_texture_rectangle : enable\n'
        + 'uniform sampler2DRect s;\nvoid main() { gl_FragColor = texture2DRect(s, vec2(0.0),'
        + ' 1.0); }', 'fragment').ok, false);
});

test('GL_ARB_shading_language_packing: 4.20\'s packing functions in 1.30', ()=>{
    const unit = gated('GL_ARB_shading_language_packing', '130', `
out vec4 c;
void main() { uint h = packHalf2x16(vec2(0.5));
    c = vec4(unpackSnorm2x16(h), unpackUnorm4x8(h).xy); }`,
    'fragment');
    const vs = /** @type {any} */ (compiles('#version 130\nvoid main() { gl_Position = vec4(0.0); }')
        .unit);
    const { fragment } = wgslOf(vs, unit);
    assert.match(fragment, /pack2x16float/);
    assert.match(fragment, /unpack2x16snorm/);
    assert.match(fragment, /unpack4x8unorm/);
});

test('GL_ARB_gpu_shader5: the bit functions and int converting to uint in 3.30', ()=>{
    const unit = gated('GL_ARB_gpu_shader5', '330', `
out vec4 c;
void main() { uint u = 5; c = vec4(float(bitCount(u) + findMSB(u)), float(bitfieldReverse(u)),
    fma(1.0, 2.0, 3.0), 1.0); }`, 'fragment');
    const vs = /** @type {any} */ (compiles('#version 330\nvoid main() { gl_Position = vec4(0.0); }')
        .unit);
    const { fragment } = wgslOf(vs, unit);
    assert.match(fragment, /countOneBits/);
    assert.match(fragment, /reverseBits/);
    assert.match(fragment, /firstLeadingBit/);
});

test('an extension the front end does not have is a warning to enable and an error to'
    + ' require; `all` takes only warn and disable', ()=>{
    const warned = compiles('#version 130\n#extension GL_NV_nothing : enable\nvoid main() {}');
    assert.ok(warned.ok);
    assert.match(warned.log, /WARNING: .*GL_NV_nothing/);
    assert.equal(compiles('#version 130\n#extension GL_NV_nothing : require\nvoid main() {}').ok,
        false);
    assert.ok(compiles('#version 130\n#extension all : warn\nvoid main() {}').ok);
    assert.ok(compiles('#version 130\n#extension GL_ARB_gpu_shader5 : require\nvoid main() {}').ok);
    // An unknown name gives a language no features.
    assert.equal(languageOf(120, null, ['GL_NV_nothing']).extensions.size, 0);
});

test('every extension the context reports for the language is one the front end has', ()=>{
    for (const name of ['GL_ARB_uniform_buffer_object', 'GL_ARB_explicit_attrib_location',
        'GL_ARB_draw_instanced', 'GL_ARB_shading_language_packing'])
    {
        assert.ok(name in GL_EXTENSIONS, `${name} reported`);
        assert.ok(name in GLSL_EXTENSIONS, `${name} in the front end`);
    }
    // Half of these is here: they are enabled, never reported.
    for (const name of ['GL_EXT_gpu_shader4', 'GL_ARB_gpu_shader5', 'GL_ARB_texture_rectangle'])
    {
        assert.equal(name in GL_EXTENSIONS, false, `${name} reported`);
    }
});
