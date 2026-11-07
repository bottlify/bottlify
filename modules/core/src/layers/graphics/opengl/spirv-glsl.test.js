/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * SPIR-V entry points written as GLSL 4.60 (`spirv-glsl.js`): every stage's
 * fixture is written and compiled by the GLSL front end, interfaces are
 * named by location and binding, specialization constants take their
 * values, and what OpenGL's SPIR-V environment does not have is refused
 * with its reason.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSpirv } from './spirv-module.js';
import { liftSpirv, specIdsOf } from './spirv-glsl.js';
import { compileShader } from './context-glsl.js';
import { spirvFixture } from './spirv-fixtures.js';

/**
 * @param {string} name
 * @param {keyof typeof import('./spirv-glsl.js').EXECUTION_MODELS} stage
 * @param {Map<number, number>} [constants] @param {string} [entry]
 */
const lift = (name, stage, constants = new Map(), entry = 'main')=>{
    const read = readSpirv(spirvFixture(name));
    assert.ok('module' in read);
    return liftSpirv(read.module, { entry, stage, constants });
};

/**
 * The GLSL a fixture is written as, compiled.
 *
 * @param {string} name
 * @param {keyof typeof import('./spirv-glsl.js').EXECUTION_MODELS} stage
 * @param {Map<number, number>} [constants]
 */
const lifted = (name, stage, constants)=>{
    const result = lift(name, stage, constants);
    assert.ok(result.ok, result.ok ? '' : result.log);
    const compiled = compileShader([result.source], stage);
    assert.ok(compiled.ok, `${compiled.log}\n${result.source}`);
    return result.source;
};

test('every stage\'s module is written as GLSL the front end compiles', ()=>{
    for (const [name, stage] of /** @type {const} */ ([['vertex', 'vertex'],
        ['fragment', 'fragment'], ['texturesVertex', 'vertex'], ['textures', 'fragment'],
        ['texturesOptimized', 'fragment'], ['geometry', 'geometry'],
        ['tessControl', 'tessControl'], ['tessEvaluation', 'tessEvaluation'],
        ['compute', 'compute'], ['computeOptimized', 'compute'], ['mismatch', 'fragment']]))
    {
        lifted(name, stage);
    }
});

test('interfaces are named by location, component and index, resources by binding', ()=>{
    const vertex = lifted('vertex', 'vertex');
    assert.match(vertex, /layout\(location = 0\) in vec3 _a0;/, 'an attribute by its location');
    assert.match(vertex, /layout\(location = 0\) out _L0c0 \{ vec4 v; \} _o0c0;/);
    assert.match(vertex, /layout\(location = 1\) flat out _L1c0 \{ int v; \} _o1c0;/);
    assert.match(vertex, /layout\(location = 2\) uniform mat4 _l2;/, 'a uniform by its location');
    assert.match(vertex, /layout\(std140, binding = 1\) uniform _U1 \{\n {4}layout\(offset = 0\) vec4 m0;\n {4}layout\(offset = 16\) mat3 m1;\n {4}layout\(offset = 64\) float m2\[3\];\n\} _u1;/);
    const fragment = lifted('fragment', 'fragment');
    assert.match(fragment, /layout\(location = 0\) in _L0c0 \{ vec4 v; \} _i0c0;/,
        'the same block name as the vertex stage\'s output: matched by location');
    assert.match(fragment, /layout\(binding = 2\) uniform sampler2D _t2;/);
    const textures = lifted('textures', 'fragment');
    assert.match(textures, /layout\(location = 0, index = 1\) out vec4 _f0i1;/);
    assert.match(textures, /uniform sampler2DArrayShadow _t5;/);
    assert.match(textures, /texture\(_t0, vec3\(_r\d+\.xy, _r\d+\)\)/,
        'a shadow lookup takes the coordinate the image needs and the reference after it');
    assert.match(textures, /textureProj\(_t0, vec4\(_r\d+\.xy, _r\d+, _r\d+\.z\)\)/);
    const geometry = lifted('geometry', 'geometry');
    assert.match(geometry, /layout\(location = 0\) in _L0c0 \{ vec4 v; \} _i0c0\[\];/);
    assert.match(geometry, /gl_in\[_r\d+\]\.gl_Position/);
    const control = lifted('tessControl', 'tessControl');
    assert.match(control, /layout\(location = 1\) patch out float _P1c0;/);
    assert.match(control, /gl_out\[_r\d+\]\.gl_Position = /);
    const compute = lifted('compute', 'compute');
    assert.match(compute, /layout\(std430, binding = 1\) readonly buffer _B1 \{/);
    assert.match(compute, /layout\(binding = 0, offset = 4\) uniform atomic_uint _c0o4;/);
    assert.match(compute, /layout\(binding = 3, rgba8\) uniform writeonly image2D _t3;/);
    assert.match(compute, /_r\d+ = atomicCounterIncrement\(_c0o4\);/);
});

test('specialization constants take the values given by SpecId, the rest their own', ()=>{
    const read = readSpirv(spirvFixture('vertex'));
    assert.ok('module' in read);
    assert.deepEqual([...specIdsOf(read.module)].sort(), [3, 4]);
    const plain = lifted('vertex', 'vertex');
    assert.match(plain, /const float _k\d+ = 2\.0;/);
    assert.match(plain, /const bool _k\d+ = false;/);
    const given = lifted('vertex', 'vertex', new Map([[3, 0x40400000], [4, 1]]));
    assert.match(given, /const float _k\d+ = 3\.0;/, 'a float given by its bits');
    assert.match(given, /const bool _k\d+ = true;/);
    assert.match(lifted('compute', 'compute'), /layout\(local_size_x = 1, local_size_y = 2/);
    assert.match(lifted('compute', 'compute', new Map([[0, 8]])),
        /layout\(local_size_x = 8, local_size_y = 2, local_size_z = 1\) in;/,
        'local_size_x_id: the work group size is its constant\'s');
});

test('a loop\'s continue construct runs at its top, a break out of a switch in it by a flag',
    ()=>{
        const textures = lifted('textures', 'fragment');
        assert.match(textures, /while \(true\) \{\n\s+if \(_l\d+\) \{\n\s+_r\d+ = /,
            'the continue construct\'s own code, run before the header from the second time');
        assert.match(textures, /if \(_x\d+\) \{\n\s+break;/, 'a switch in a loop is left');
        // Values made in one construct and read past it are variables of the function.
        assert.match(lifted('texturesOptimized', 'fragment'), /^ {4}\w+ _r\d+;$/m);
    });

test('an entry point is chosen by name and stage', ()=>{
    const vs = lift('twoEntries', 'vertex', new Map(), 'vs');
    assert.ok(vs.ok && /gl_Position = _r\d+;/.test(vs.source));
    const fs = lift('twoEntries', 'fragment', new Map([[9, 0x3f000000]]), 'fs');
    assert.ok(fs.ok && /const vec4 _k\d+ = vec4\(_k\d+, 1\.0, _k\d+, 1\.0\);/.test(fs.source)
        && /const float _k\d+ = 0\.5;/.test(fs.source));
    const wrong = lift('twoEntries', 'fragment', new Map(), 'vs');
    assert.ok(!wrong.ok && /no entry point 'vs'/.test(wrong.log));
});

test('what OpenGL\'s SPIR-V does not have is refused with its reason', ()=>{
    /** @type {[string, 'vertex' | 'fragment', RegExp][]} */
    const cases = [
        ['refuse_push', 'fragment', /push constants/],
        ['refuse_int64', 'fragment', /capability Int64/],
        ['refuse_set1', 'fragment', /descriptor set other than 0/],
        ['refuse_stride', 'fragment', /array stride of 4, where std140 gives 16/],
        ['refuse_sampler', 'fragment', /separate sampler/],
        ['refuse_vertexIndex', 'vertex', /VertexIndex/],
        ['refuse_noLocation', 'fragment', /output with no location/],
        ['refuse_debugPrintf', 'fragment', /NonSemantic\.DebugPrintf/],
        ['refuse_minLod', 'fragment', /capability MinLod/],
    ];
    for (const [name, stage, reason] of cases)
    {
        const result = lift(name, stage);
        assert.ok(!result.ok, `${name} was taken`);
        assert.match(result.log, /^ERROR: SPIR-V: /);
        assert.match(result.log, reason, name);
    }
});
