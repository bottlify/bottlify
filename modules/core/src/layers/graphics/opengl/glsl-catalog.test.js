/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readCatalog } from '../../../../../../tools/glsl-functions.mjs';
import { GLSL_CATALOG } from './glsl-catalog.js';
import { modernOverloads } from './glsl-library.js';
import { glslName } from './glsl-types.js';
import { languageOf } from './glsl-versions.js';

/** @param {string} body a source block of the specification's chapter */
const chapter = body=>`=== Section\n\n[source,glsl]\n----\n${body}\n----\n`;

/** @param {ReturnType<typeof readCatalog>} rows */
const spelled = rows=>rows.map(([, name, returns, params, outs, bias])=>
    `${returns} ${name}(${params.join(', ')})${outs.length ? ` outs ${outs}` : ''}`
    + `${bias ? ' bias' : ''}`);

test('the generator spells generic types out in parallel, not as a product', ()=>{
    assert.deepEqual(spelled(readCatalog(chapter('genFType mix(genFType x, genFType y,'
        + ' float a)'))), ['float mix(float, float, float)', 'vec2 mix(vec2, vec2, float)',
        'vec3 mix(vec3, vec3, float)', 'vec4 mix(vec4, vec4, float)']);
    assert.deepEqual(spelled(readCatalog(chapter('gvec4 texture(gsampler2D sampler, vec2 P'
        + ' [, float bias])'))), ['vec4 texture(sampler2D, vec2)',
        'ivec4 texture(isampler2D, vec2)', 'uvec4 texture(usampler2D, vec2)',
        'vec4 texture(sampler2D, vec2, float) bias', 'ivec4 texture(isampler2D, vec2, float) bias',
        'uvec4 texture(usampler2D, vec2, float) bias']);
    assert.deepEqual(spelled(readCatalog(chapter('genFType modf(genFType x, out genFType i)'))),
        ['float modf(float, float) outs 2', 'vec2 modf(vec2, vec2) outs 2',
            'vec3 modf(vec3, vec3) outs 2', 'vec4 modf(vec4, vec4) outs 2']);
});

test('the generator sets the specification\'s slips right and skips ES-only text', ()=>{
    assert.deepEqual(spelled(readCatalog(chapter('ivec2 textureSize(gsamler2DRect sampler)'))),
        ['ivec2 textureSize(sampler2DRect)', 'ivec2 textureSize(isampler2DRect)',
            'ivec2 textureSize(usampler2DRect)']);
    assert.deepEqual(spelled(readCatalog(chapter('ifdef::ESSL[]\nfloat esOnly(float x)\n'
        + 'endif::ESSL[]\nfloat both(float x)'))), ['float both(float)']);
});

test('IMAGE_PARAMS stands for each image and its coordinates; an atomic for its own type', ()=>{
    const text = '{empty}:: gimage2D _image_, ivec2 _P_\n'
        + '{empty}:: gimage2DMS _image_, ivec2 _P_, int _sample_\n'
        + chapter('gvec4 imageLoad(readonly IMAGE_PARAMS)\n'
            + 'int imageAtomicAdd(IMAGE_PARAMS, int data)');
    assert.deepEqual(spelled(readCatalog(text)), ['vec4 imageLoad(image2D, ivec2)',
        'ivec4 imageLoad(iimage2D, ivec2)', 'uvec4 imageLoad(uimage2D, ivec2)',
        'vec4 imageLoad(image2DMS, ivec2, int)', 'ivec4 imageLoad(iimage2DMS, ivec2, int)',
        'uvec4 imageLoad(uimage2DMS, ivec2, int)', 'int imageAtomicAdd(iimage2D, ivec2, int)',
        'int imageAtomicAdd(iimage2DMS, ivec2, int, int)']);
});

/** @param {string} name @param {number} version @param {'core' | 'compatibility' | null} [profile] */
const forms = (name, version, profile = null)=>modernOverloads(name, languageOf(version, profile))
    .map(o=>`${glslName(o.returns)} ${name}(${o.params.map(glslName).join(', ')})`);

test('each function is there from the version it came with', ()=>{
    assert.equal(GLSL_CATALOG.length > 1500, true);
    assert.deepEqual(forms('textureGather', 330), []);
    assert.ok(forms('textureGather', 400).includes('vec4 textureGather(sampler2D, vec2)'));
    assert.ok(!forms('mix', 130).includes('int mix(int, int, bool)'), 'integer mix is 4.50');
    assert.ok(forms('mix', 450).includes('int mix(int, int, bool)'));
    assert.ok(forms('mix', 130).includes('float mix(float, float, bool)'));
    assert.ok(forms('abs', 400).includes('double abs(double)'));
    assert.ok(!forms('abs', 330).some(f=>f.includes('double')), 'no doubles before 4.00');
    assert.deepEqual(forms('ftransform', 150), []);
    assert.deepEqual(forms('ftransform', 150, 'compatibility'), ['vec4 ftransform()']);
    assert.ok(forms('texture2D', 130).length > 0, '1.30 still has the 1.x names');
    assert.deepEqual(forms('anyInvocation', 450), []);
    assert.ok(forms('anyInvocation', 460).includes('bool anyInvocation(bool)'));
});
