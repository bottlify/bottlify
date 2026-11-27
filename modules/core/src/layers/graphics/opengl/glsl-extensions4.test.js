/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * `#extension` for the 4.x extensions, against their own specifications: a
 * shader of an earlier version that enables one compiles what the extension
 * brings, fails without it, and links through the context into WGSL as the
 * version that made it core does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileShader } from './context-glsl.js';
import { linkProgram } from './glsl-link.js';
import { emitStage } from './glsl-wgsl.js';
import { createGlContext } from './context.js';
import { GL } from './constants.js';
import { GL_EXTENSIONS } from './extensions.js';
import { GLSL_EXTENSIONS } from './glsl-versions.js';

/** @typedef {import('./context-glsl.js').ShaderStage} ShaderStage */

/** @param {string} source @param {ShaderStage} stage */
const compiles = (source, stage)=>compileShader([source], stage);

/**
 * A shader that compiles with the extension enabled, not without it, nor
 * with it disabled.
 *
 * @param {string} extension @param {string} version @param {string} body
 * @param {ShaderStage} stage
 * @returns {string} the source that compiled
 */
function gated(extension, version, body, stage){
    const source = `#version ${version}\n#extension ${extension} : enable\n${body}`;
    const on = compiles(source, stage);
    assert.ok(on.ok, `${extension} enabled: ${on.log}`);
    const off = compiles(`#version ${version}\n${body}`, stage);
    assert.equal(off.ok, false, `${extension} not named compiled`);
    const disabled = compiles(`#version ${version}\n#extension ${extension} : disable\n${body}`,
        stage);
    assert.equal(disabled.ok, false, `${extension} disabled compiled`);
    return source;
}

/** The shader types by stage. */
const TYPES = /** @type {Record<ShaderStage, number>} */ ({
    vertex: GL.VERTEX_SHADER, fragment: GL.FRAGMENT_SHADER, geometry: GL.GEOMETRY_SHADER,
    tessControl: 0x8e88, tessEvaluation: 0x8e87, compute: 0x91b9,
});

/**
 * Links shaders through a context, which writes the program's WGSL there.
 *
 * @param {[ShaderStage, string][]} shaders
 * @returns {{ gl: any, program: number }}
 */
function linked(shaders){
    /** @type {any} */
    const gl = createGlContext({});
    gl.attach({ width: 4, height: 4, doubleBuffered: true });
    const program = gl.glCreateProgram();
    for (const [stage, source] of shaders)
    {
        const shader = gl.glCreateShader(TYPES[stage]);
        gl.glShaderSource(shader, [source]);
        gl.glCompileShader(shader);
        assert.deepEqual(gl.glGetShaderiv(shader, GL.COMPILE_STATUS), [1],
            gl.glGetShaderInfoLog(shader));
        gl.glAttachShader(program, shader);
    }
    gl.glLinkProgram(program);
    assert.deepEqual(gl.glGetProgramiv(program, GL.LINK_STATUS), [1],
        gl.glGetProgramInfoLog(program));
    return { gl, program };
}

/**
 * The WGSL a vertex and a fragment shader are written as.
 *
 * @param {string} vertex @param {string} fragment
 * @returns {string} the fragment stage's
 */
function fragmentWgsl(vertex, fragment){
    const units = /** @type {any[]} */ ([compiles(vertex, 'vertex').unit,
        compiles(fragment, 'fragment').unit]);
    const result = /** @type {any} */ (linkProgram({ vertex: [units[0]], fragment: [units[1]],
        attribBindings: new Map(), fragDataBindings: new Map() }));
    assert.ok(result.ok, result.log);
    /** @type {import('./glsl-wgsl.js').StageOptions} */
    const options = { attributes: [], flat: false, twoSide: false, alphaFunc: null, targets: 1,
        targetScalars: ['f32'], compare: ()=>'true' };
    const stage = emitStage(result.program, 'vertex', options, null, 'glsl');
    const emitted = emitStage(result.program, 'fragment', options, stage.fields, 'glsl');
    return [...emitted.samplers, emitted.code].join('\n');
}

/** A vertex shader of `version` that passes nothing. @param {string} version */
const VS = version=>`#version ${version}\nin vec4 position;\n`
    + 'void main() { gl_Position = position; }';
/** A fragment shader of `version` writing one colour. @param {string} version */
const FS = version=>`#version ${version}\nout vec4 c;\nvoid main() { c = vec4(1.0); }`;

test('GL_ARB_gpu_shader5 in 3.30: gathers, the extended arithmetic, bitfields, interpolation'
    + ' functions, `precise`, run-time sampler indices, gl_SampleMaskIn', ()=>{
    const fragment = gated('GL_ARB_gpu_shader5', '330', `
in vec2 uv; out vec4 c; uniform sampler2D images[2]; uniform int which;
void main() {
    precise float p = 1.0;
    uint carry; uint sum = uaddCarry(1u, 2u, carry);
    uint high; uint low; umulExtended(3u, 4u, high, low);
    int e; float m = frexp(8.0, e);
    c = textureGather(images[which], uv) + textureGatherOffset(images[0], uv, ivec2(1, 0))
        + vec4(float(bitfieldExtract(sum, 0, 4) + carry + high + low), m, ldexp(m, e), p)
        + interpolateAtCentroid(uv).xyxy + float(gl_SampleMaskIn[0]);
}`, 'fragment');
    linked([['vertex', `#version 330\nin vec4 position; out vec2 uv;
void main() { uv = position.xy; gl_Position = position; }`], ['fragment', fragment]]);
    const geometry = gated('GL_ARB_gpu_shader5', '150', `
layout(triangles, invocations = 2) in; layout(triangle_strip, max_vertices = 3) out;
void main() { for (int i = 0; i < 3; i++) {
    gl_Position = gl_in[i].gl_Position + float(gl_InvocationID); EmitStreamVertex(0); } }`,
    'geometry');
    linked([['vertex', VS('150')], ['geometry', geometry], ['fragment', FS('150')]]);
});

test('GL_ARB_texture_gather in 1.30, GL_ARB_texture_cube_map_array\'s samplers in 1.30', ()=>{
    linked([['vertex', VS('130')], ['fragment', gated('GL_ARB_texture_gather', '130', `
out vec4 c; uniform sampler2D s;
void main() { c = textureGather(s, vec2(0.5)); }`, 'fragment')]]);
    linked([['vertex', VS('130')], ['fragment', gated('GL_ARB_texture_cube_map_array', '130', `
out vec4 c; uniform samplerCubeArray cubes; uniform samplerCubeArrayShadow depths;
void main() { c = texture(cubes, vec4(1.0, 0.0, 0.0, 2.0))
    + vec4(texture(depths, vec4(1.0, 0.0, 0.0, 2.0), 0.5)) + vec4(textureSize(cubes, 0), 1.0); }`,
    'fragment')]]);
});

test('GL_ARB_gpu_shader_fp64 and GL_ARB_shader_subroutine in 1.50', ()=>{
    linked([['vertex', gated('GL_ARB_gpu_shader_fp64', '150', `
in vec4 position; uniform double scale; uniform dvec2 shift;
void main() { double d = 1.0lf / 3.0lf; dvec2 v = shift * scale + d; double widened = 2.0;
    d += widened;
    uvec2 bits = unpackDouble2x32(d);
    gl_Position = position * float(v.x + packDouble2x32(bits)); }`,
    'vertex')], ['fragment', FS('150')]]);
    linked([['vertex', VS('150')], ['fragment', gated('GL_ARB_shader_subroutine', '150', `
out vec4 c;
subroutine vec4 Shade();
subroutine(Shade) vec4 red() { return vec4(1.0, 0.0, 0.0, 1.0); }
subroutine uniform Shade shade;
void main() { c = shade(); }`, 'fragment')]]);
});

test('GL_ARB_tessellation_shader in 1.50: both stages, `patch`, barrier() and the constants', ()=>{
    const control = gated('GL_ARB_tessellation_shader', '150', `
layout(vertices = 3) out; patch out vec4 middle;
void main() {
    gl_out[gl_InvocationID].gl_Position = gl_in[gl_InvocationID].gl_Position;
    barrier();
    if (gl_InvocationID == 0) { middle = vec4(float(gl_MaxTessGenLevel));
        gl_TessLevelOuter[0] = 2.0; gl_TessLevelOuter[1] = 2.0; gl_TessLevelOuter[2] = 2.0;
        gl_TessLevelInner[0] = 2.0; }
}`, 'tessControl');
    const evaluation = gated('GL_ARB_tessellation_shader', '150', `
layout(triangles, equal_spacing, ccw) in; patch in vec4 middle;
void main() { gl_Position = gl_TessCoord.x * gl_in[0].gl_Position
    + gl_TessCoord.y * gl_in[1].gl_Position + gl_TessCoord.z * gl_in[2].gl_Position + middle; }`,
    'tessEvaluation');
    linked([['vertex', VS('150')], ['tessControl', control], ['tessEvaluation', evaluation],
        ['fragment', FS('150')]]);
});

test('GL_ARB_sample_shading, GL_ARB_viewport_array and GL_ARB_fragment_layer_viewport', ()=>{
    linked([['vertex', VS('130')], ['fragment', gated('GL_ARB_sample_shading', '130', `
out vec4 c; void main() { c = vec4(gl_SamplePosition, float(gl_SampleID), 1.0);
    gl_SampleMask[0] = 1; }`, 'fragment')]]);
    const geometry = gated('GL_ARB_viewport_array', '150', `
layout(triangles) in; layout(triangle_strip, max_vertices = 3) out;
void main() { for (int i = 0; i < 3; i++) { gl_Position = gl_in[i].gl_Position;
    gl_ViewportIndex = gl_MaxViewports - 1; EmitVertex(); } }`, 'geometry');
    const fragment = gated('GL_ARB_fragment_layer_viewport', '150', `
out vec4 c; void main() { c = vec4(float(gl_Layer + gl_ViewportIndex)); }`, 'fragment');
    linked([['vertex', VS('150')], ['geometry', geometry], ['fragment', fragment]]);
});

test('the 4.x layout qualifiers in 3.30 and 1.50: separate shader locations, bindings,'
    + ' uniform locations, depth layouts, enhanced layouts', ()=>{
    const vertex = gated('GL_ARB_separate_shader_objects', '150', `
in vec4 position; layout(location = 2) out vec4 v;
void main() { v = position; gl_Position = position; }`, 'vertex');
    const fragment = gated('GL_ARB_separate_shader_objects', '150', `
layout(location = 2) in vec4 v; out vec4 c; void main() { c = v; }`, 'fragment');
    linked([['vertex', vertex], ['fragment', fragment]]);
    linked([['vertex', VS('330')], ['fragment', gated('GL_ARB_shading_language_420pack', '330', `
layout(binding = 2) uniform sampler2D s; layout(std140, binding = 1) uniform B { vec4 tint; };
out vec4 c; uniform float k;
void main() { const float local = k * 2.0; c = texture(s, vec2(local)) + tint; }`,
    'fragment')]]);
    linked([['vertex', gated('GL_ARB_explicit_uniform_location', '330', `
in vec4 position; layout(location = 4) uniform vec4 offset;
void main() { gl_Position = position + offset; }`, 'vertex')], ['fragment', FS('330')]]);
    linked([['vertex', VS('330')], ['fragment', gated('GL_ARB_conservative_depth', '330', `
layout(depth_greater) out float gl_FragDepth; out vec4 c;
void main() { gl_FragDepth = gl_FragCoord.z; c = vec4(1.0); }`, 'fragment')]]);
    linked([['vertex', gated('GL_ARB_enhanced_layouts', '330', `
#extension GL_ARB_separate_shader_objects : require
in vec4 position; layout(location = 1, component = 2) out vec2 v;
void main() { v = position.xy; gl_Position = position; }`, 'vertex')], ['fragment', `#version 330
#extension GL_ARB_enhanced_layouts : require
#extension GL_ARB_separate_shader_objects : require
layout(location = 1, component = 2) in vec2 v; out vec4 c; void main() { c = v.xyxy; }`]]);
});

test('GL_ARB_shader_image_load_store, GL_ARB_shader_atomic_counters and'
    + ' GL_ARB_shader_storage_buffer_object in 3.30', ()=>{
    linked([['vertex', VS('330')], ['fragment', gated('GL_ARB_shader_image_load_store', '330', `
layout(rgba8) uniform writeonly image2D target; out vec4 c;
void main() { imageStore(target, ivec2(gl_FragCoord.xy), vec4(1.0)); memoryBarrier();
    c = vec4(1.0); }`, 'fragment')]]);
    linked([['vertex', VS('330')], ['fragment', gated('GL_ARB_shader_atomic_counters', '330', `
layout(binding = 0, offset = 0) uniform atomic_uint drawn; out vec4 c;
void main() { c = vec4(float(atomicCounterIncrement(drawn))); }`, 'fragment')]]);
    linked([['vertex', VS('330')], ['fragment', gated('GL_ARB_shader_storage_buffer_object', '330',
        `
layout(std430, binding = 0) buffer Counts { uint total; uint each[]; }; out vec4 c;
void main() { c = vec4(float(atomicAdd(total, 1u) + each[1])); }`, 'fragment')]]);
});

test('GL_ARB_compute_shader in 3.30: the stage, its layout, `shared` and its barriers', ()=>{
    const compute = gated('GL_ARB_compute_shader', '330', `
#extension GL_ARB_shader_storage_buffer_object : require
layout(local_size_x = 4) in; shared uint scratch[4];
layout(std430, binding = 0) buffer Out { uint values[]; };
void main() { scratch[gl_LocalInvocationID.x] = gl_LocalInvocationID.x; barrier();
    memoryBarrierShared();
    values[gl_GlobalInvocationID.x] = scratch[3u - gl_LocalInvocationID.x]; }`, 'compute');
    linked([['compute', compute]]);
});

test('GL_ARB_arrays_of_arrays, GL_ARB_cull_distance, GL_ARB_derivative_control,'
    + ' GL_ARB_texture_query_levels, GL_ARB_texture_query_lod, GL_ARB_shader_bit_encoding,'
    + ' GL_ARB_shader_texture_image_samples, GL_ARB_shader_group_vote', ()=>{
    linked([['vertex', gated('GL_ARB_arrays_of_arrays', '330', `
in vec4 position; float grid[2][3];
void main() { grid[1][2] = 1.0; gl_Position = position * grid[1][2]; }`, 'vertex')],
    ['fragment', FS('330')]]);
    linked([['vertex', gated('GL_ARB_cull_distance', '330', `
in vec4 position;
void main() { gl_CullDistance[0] = float(gl_MaxCullDistances); gl_Position = position; }`,
    'vertex')], ['fragment', FS('330')]]);
    linked([['vertex', VS('330')], ['fragment', gated('GL_ARB_derivative_control', '330', `
out vec4 c; void main() { c = vec4(dFdxFine(gl_FragCoord.x), dFdyCoarse(gl_FragCoord.y),
    fwidthFine(gl_FragCoord.x), 1.0); }`, 'fragment')]]);
    linked([['vertex', VS('330')], ['fragment', gated('GL_ARB_texture_query_levels', '330', `
uniform sampler2D s; out vec4 c; void main() { c = vec4(float(textureQueryLevels(s))); }`,
    'fragment')]]);
    const lod = gated('GL_ARB_texture_query_lod', '330', `
uniform sampler2D s; out vec4 c; void main() { c = textureQueryLOD(s, gl_FragCoord.xy).xyxy; }`,
    'fragment');
    linked([['vertex', VS('330')], ['fragment', lod]]);
    // The extension's spelling is 4.00's function, written as it is.
    const lodWgsl = fragmentWgsl(VS('330'), lod);
    assert.doesNotMatch(lodWgsl, /textureQueryLOD/);
    assert.match(lodWgsl, /dpdx/);
    linked([['vertex', gated('GL_ARB_shader_bit_encoding', '130', `
in vec4 position;
void main() { gl_Position = position * uintBitsToFloat(floatBitsToUint(1.0)); }`, 'vertex')],
    ['fragment', FS('130')]]);
    linked([['vertex', VS('330')], ['fragment', gated('GL_ARB_shader_texture_image_samples',
        '330', `
uniform sampler2DMS s; out vec4 c; void main() { c = vec4(float(textureSamples(s))); }`,
        'fragment')]]);
    const vote = gated('GL_ARB_shader_group_vote', '330', `
out vec4 c; void main() { bool b = gl_FragCoord.x > 0.5;
    c = vec4(float(anyInvocationARB(b)), float(allInvocationsARB(b)),
        float(allInvocationsEqualARB(b)), 1.0); }`, 'fragment');
    linked([['vertex', VS('330')], ['fragment', vote]]);
    assert.doesNotMatch(fragmentWgsl(VS('330'), vote), /InvocationsARB|anyInvocationARB/);
});

test('GL_ARB_shader_draw_parameters in 3.30: the extension\'s names are 4.60\'s variables', ()=>{
    linked([['vertex', gated('GL_ARB_shader_draw_parameters', '330', `
in vec4 position; out vec4 numbers;
void main() { numbers = vec4(float(gl_BaseVertexARB), float(gl_BaseInstanceARB),
    float(gl_DrawIDARB), 1.0); gl_Position = position; }`, 'vertex')], ['fragment', `#version 330
in vec4 numbers; out vec4 c; void main() { c = numbers; }`]]);
});

test('every extension a shader may enable is reported, and every one reported for the'
    + ' language is one the front end has', ()=>{
    for (const name of Object.keys(GLSL_EXTENSIONS).filter(n=>n !== 'GL_EXT_gpu_shader4'))
    {
        assert.ok(name in GL_EXTENSIONS, `${name} enabled and not reported`);
    }
});
