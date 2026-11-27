/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createGlContext } from './context.js';
import { SAMPLER_BINDING } from './context-samplers.js';
import { TEX } from './formats.js';

/** @returns {any} */
function fixture(){
    const context = createGlContext({});
    context.attach({ width: 8, height: 4, doubleBuffered: true });
    return context;
}

test('sampler names, binding and deleting, as section 3.9.2 of 3.3 has them', ()=>{
    const gl = fixture();
    const [a, b] = gl.glGenSamplers(2);
    assert.deepEqual([gl.glIsSampler(a), gl.glIsSampler(b), gl.glIsSampler(9)],
        [GL.TRUE, GL.TRUE, GL.FALSE], 'an object once generated');
    gl.glBindSampler(3, a);
    gl.glActiveTextureARB(GL.TEXTURE0 + 3);
    assert.deepEqual(gl.glGetIntegerv(SAMPLER_BINDING), [a], 'the active unit\'s');
    gl.glActiveTextureARB(GL.TEXTURE0);
    assert.deepEqual(gl.glGetIntegerv(SAMPLER_BINDING), [0]);
    gl.glBindSampler(0, 9);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'a name not generated');
    const units = gl.glGetIntegerv(GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS)[0];
    gl.glBindSampler(units, a);
    assert.equal(gl.glGetError(), GL.INVALID_VALUE, 'past the last unit');
    gl.glBindSampler(0, b);
    assert.deepEqual(gl.side.boundSamplers().map((/** @type {any} */ s)=>s?.name ?? 0)
        .slice(0, 4), [b, 0, 0, a]);
    gl.glDeleteSamplers([a]);
    assert.equal(gl.glIsSampler(a), GL.FALSE);
    gl.glActiveTextureARB(GL.TEXTURE0 + 3);
    assert.deepEqual(gl.glGetIntegerv(SAMPLER_BINDING), [0], 'deleting unbinds it');
    gl.glBindSampler(0, 0);
    assert.equal(gl.side.boundSamplers(), null, 'no unit has one');
    assert.equal(gl.glGetError(), GL.NO_ERROR);
});

test('a sampler\'s parameters: the defaults, what it takes, and what it refuses', ()=>{
    const gl = fixture();
    const [s] = gl.glGenSamplers(1);
    /** @param {number} pname */
    const ask = pname=>gl.getSamplerParameter(s, pname);
    assert.deepEqual([GL.TEXTURE_MIN_FILTER, GL.TEXTURE_MAG_FILTER, GL.TEXTURE_WRAP_R,
        GL.TEXTURE_MIN_LOD, GL.TEXTURE_MAX_LOD, TEX.TEXTURE_COMPARE_MODE,
        TEX.TEXTURE_COMPARE_FUNC].map(pname=>ask(pname)[0]),
    [GL.NEAREST_MIPMAP_LINEAR, GL.LINEAR, GL.REPEAT, -1000, 1000, GL.NONE, GL.LEQUAL]);
    assert.deepEqual(ask(GL.TEXTURE_BORDER_COLOR), [0, 0, 0, 0]);
    gl.samplerParameter(s, GL.TEXTURE_WRAP_S, [GL.CLAMP_TO_EDGE]);
    gl.samplerParameter(s, GL.TEXTURE_BORDER_COLOR, [1, 0.5, 0, 1]);
    gl.samplerParameter(s, GL.TEXTURE_MIN_LOD, [2]);
    assert.equal(gl.glGetError(), GL.NO_ERROR);
    assert.deepEqual(ask(GL.TEXTURE_WRAP_S), [GL.CLAMP_TO_EDGE]);
    assert.deepEqual(ask(GL.TEXTURE_BORDER_COLOR), [1, 0.5, 0, 1]);
    assert.deepEqual(ask(GL.TEXTURE_MIN_LOD), [2]);
    gl.samplerParameter(s, GL.TEXTURE_MAG_FILTER, [GL.LINEAR_MIPMAP_LINEAR]);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'not a magnification filter');
    gl.samplerParameter(s, GL.TEXTURE_BASE_LEVEL, [1]);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM, 'the texture\'s, not a sampler\'s');
    gl.samplerParameter(s, TEX.TEXTURE_COMPARE_FUNC, [GL.TEXTURE_2D]);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
    gl.samplerParameter(77, GL.TEXTURE_WRAP_S, [GL.REPEAT]);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION, 'no such sampler');
    assert.equal(gl.getSamplerParameter(77, GL.TEXTURE_WRAP_S), null);
    assert.equal(gl.glGetError(), GL.INVALID_OPERATION);
    // The texture's own parameters are judged as they were.
    gl.glTexParameteri(GL.TEXTURE_2D, GL.TEXTURE_WRAP_S, GL.TEXTURE_2D);
    assert.equal(gl.glGetError(), GL.INVALID_ENUM);
});
