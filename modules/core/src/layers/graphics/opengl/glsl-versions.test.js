/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasStage, languageOf } from './glsl-versions.js';
import { basicTypeAt } from './glsl-types.js';

test('a word is a keyword from its version, reserved before it where the list says so', ()=>{
    // Section 3.6 of each version: `switch` was reserved in 1.10 and 1.20
    // and a keyword from 1.30; `layout` came with 1.40; `buffer` with 4.30.
    assert.equal(languageOf(120).reserved.has('switch'), true);
    assert.equal(languageOf(130).keywords.has('switch'), true);
    assert.equal(languageOf(130).reserved.has('switch'), false);
    assert.equal(languageOf(130).keywords.has('layout'), false);
    assert.equal(languageOf(140).keywords.has('layout'), true);
    assert.equal(languageOf(420).keywords.has('buffer'), false);
    assert.equal(languageOf(430).keywords.has('buffer'), true);
    assert.equal(languageOf(460).reserved.has('input'), true);
    assert.equal(languageOf(460).keywords.has('dmat4x3'), true);
    assert.equal(languageOf(330).keywords.has('dmat4x3'), false);
});

test('compatibility is 1.x, 1.40, or a profile that says so', ()=>{
    assert.equal(languageOf(120).compatibility, true);
    assert.equal(languageOf(140).compatibility, true);
    assert.equal(languageOf(150, 'core').compatibility, false);
    assert.equal(languageOf(150, 'compatibility').compatibility, true);
    assert.equal(languageOf(460, 'core'), languageOf(460, 'core'), 'one language a key');
});

test('features and stages arrive with their versions', ()=>{
    assert.deepEqual([330, 400].map(v=>languageOf(v).has('double')), [false, true]);
    assert.deepEqual([420, 430].map(v=>languageOf(v).has('arraysOfArrays')), [false, true]);
    assert.deepEqual([140, 150].map(v=>hasStage('geometry', languageOf(v))), [false, true]);
    assert.deepEqual([330, 400].map(v=>hasStage('tessControl', languageOf(v))), [false, true]);
    assert.deepEqual([420, 430].map(v=>hasStage('compute', languageOf(v))), [false, true]);
});

test('a type name is a type from the version it came with', ()=>{
    assert.equal(basicTypeAt('uvec3', 120) ?? null, null);
    assert.equal(basicTypeAt('uvec3', 130)?.kind, 'vector');
    assert.equal(basicTypeAt('samplerCubeArray', 330) ?? null, null);
    assert.equal(basicTypeAt('samplerCubeArray', 400)?.kind, 'sampler');
    assert.equal(basicTypeAt('image2D', 410) ?? null, null);
    assert.equal(basicTypeAt('uimage2DMSArray', 420)?.kind, 'image');
    assert.equal(basicTypeAt('isampler2DRect', 140)?.kind, 'sampler');
});
