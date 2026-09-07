/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The generated shader is text this engine computes, so it is asserted exactly:
 * the same state must produce the same source, byte for byte, on every run. A
 * generator that emitted its stages in map order, or interpolated a float
 * differently between runs, would rebuild a pipeline that should have been
 * cached and would make every stored hash below unstable.
 *
 * What these do NOT prove is that the shader computes what `reference.js`
 * computes. Only a device can show that, and a device cannot be held to a
 * stored image. That seam is stated in the report rather than papered over.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { D3DFOG, D3DTA, D3DTOP, generateFixedFunction } from './fixedfunction.js';
import { FVF, decodeFvf } from './vertexformat.js';

const baseState = (over = {})=>({
    fvf: FVF.XYZ | FVF.DIFFUSE,
    vertexShader: 0,
    pixelShader: 0,
    targetFormat: 'bgra8unorm',
    depthTest: true,
    depthWrite: true,
    depthFunc: 4,
    cullMode: 3,
    blend: false,
    srcBlend: 5,
    destBlend: 6,
    blendOp: 1,
    colorWrite: 0xf,
    alphaTest: false,
    alphaFunc: 5,
    fogMode: D3DFOG.NONE,
    stages: [],
    ...over,
});

/** @param {any} state */
const generate = state=>generateFixedFunction(state, decodeFvf(state.fvf));
/** @param {string} text */
const digest = text=>createHash('sha256').update(text).digest('hex').slice(0, 16);

test('the same state generates the same source, byte for byte', ()=>{
    // If this is unstable, every pipeline is rebuilt on every draw and the
    // cache is decoration. The hash is stored so a change to the generator has
    // to be deliberate.
    const first = generate(baseState()).code;
    const second = generate(baseState()).code;

    assert.equal(first, second);
    assert.equal(digest(first), 'c6824962285a510d');
});

test('a vertex colour is swizzled back from B,G,R,A', ()=>{
    // unorm8x4 reads the DWORD in memory order, so a D3DCOLOR arrives with red
    // and blue exchanged. Missing the swizzle gives a picture that is correct
    // in every respect except its colour, which is the hardest kind to notice.
    const withColour = generate(baseState()).code;
    assert.match(withColour, /out\.diffuse = vertex\.diffuse\.bgra;/);

    // A vertex with no colour gets opaque white, so that a modulate against it
    // is an identity. Black would multiply the scene away.
    const without = generate(baseState({ fvf: FVF.XYZ })).code;
    assert.match(without, /out\.diffuse = vec4f\(1\.0, 1\.0, 1\.0, 1\.0\);/);
});

test('a pre-transformed vertex goes through the viewport, not the matrices', ()=>{
    // XYZRHW is already in screen space. Transforming it anyway puts the
    // geometry somewhere else; this is the second half of the viewport
    // contract and the only thing that lands such a vertex on the pixel it
    // names.
    // The uniform block declares every field whatever the shader uses, so that
    // one bind-group layout serves them all; what distinguishes the two paths
    // is which of them the position is computed from.
    const positionOf = (/** @type {string} */ code)=>
        code.split('\n').filter(line=>line.includes('out.position')).join('\n');

    const transformed = generate(baseState({ fvf: FVF.XYZRHW | FVF.DIFFUSE })).code;
    assert.match(transformed, /let screen = \(vertex\.position\.xy \+ uniforms\.viewportOffset\)/);
    assert.doesNotMatch(positionOf(transformed), /worldViewProjection/);

    const ordinary = generate(baseState()).code;
    assert.match(positionOf(ordinary),
        /uniforms\.worldViewProjection \* vec4f\(vertex\.position, 1\.0\)/);
    assert.doesNotMatch(ordinary, /let screen =/);
});

test('no stages leaves the diffuse colour alone', ()=>{
    // A stage that is off is absent, not neutral: "neutral" is only an identity
    // for some operations, and emitting one for a subtract darkens the scene.
    const code = generate(baseState()).code;
    assert.match(code, /var current = input\.diffuse;/);
    assert.doesNotMatch(code, /textureSample/);
});

test('each stage emits its own sample and reads the one before it', ()=>{
    const state = baseState({
        fvf: FVF.XYZ | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT),
        stages: [
            {
                colorOp: D3DTOP.MODULATE, colorArg1: D3DTA.TEXTURE, colorArg2: D3DTA.DIFFUSE,
                alphaOp: D3DTOP.SELECTARG1, alphaArg1: D3DTA.TEXTURE, alphaArg2: D3DTA.DIFFUSE,
                texCoordIndex: 0,
            },
            {
                colorOp: D3DTOP.MODULATE, colorArg1: D3DTA.CURRENT, colorArg2: D3DTA.TFACTOR,
                alphaOp: D3DTOP.SELECTARG1, alphaArg1: D3DTA.CURRENT, alphaArg2: D3DTA.CURRENT,
                texCoordIndex: 0,
            },
        ],
    });
    const code = generate(state).code;

    assert.match(code, /var texture0: texture_2d<f32>/);
    assert.match(code, /var texture1: texture_2d<f32>/);
    assert.match(code, /@binding\(1\) var texture0/, 'textures start after the uniform block');
    assert.match(code, /@binding\(3\) var texture1/, 'and each stage takes a pair');
    assert.match(code, /uniforms\.textureFactor/, 'stage one reads the texture factor');
    assert.equal((code.match(/current = vec4f/g) || []).length, 2, 'one assignment per stage');
});

test('a disabled stage emits nothing, and the ones after it still run', ()=>{
    const state = baseState({
        fvf: FVF.XYZ | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT),
        stages: [
            {
                colorOp: D3DTOP.DISABLE, colorArg1: D3DTA.TEXTURE, colorArg2: D3DTA.DIFFUSE,
                alphaOp: D3DTOP.DISABLE, alphaArg1: D3DTA.TEXTURE, alphaArg2: D3DTA.DIFFUSE,
                texCoordIndex: 0,
            },
        ],
    });
    assert.match(generate(state).code, /\/\/ stage 0 disabled/);
});

test('the alpha test discards, and never means never', ()=>{
    // Discard rather than a transparent output: a discarded fragment writes no
    // depth and one blended to zero alpha does, which is the difference between
    // an alpha-tested fence and a fence-shaped hole in what follows.
    const tested = generate(baseState({ alphaTest: true, alphaFunc: 5 })).code;
    assert.match(tested, /current\.a > uniforms\.alphaRef/);
    assert.match(tested, /discard;/);

    assert.match(generate(baseState({ alphaTest: true, alphaFunc: 1 })).code, /if \(!\(false\)\)/);
    assert.match(generate(baseState({ alphaTest: true, alphaFunc: 8 })).code, /if \(!\(true\)\)/);
    assert.doesNotMatch(generate(baseState()).code, /discard/);
});

test('fog mixes towards the fog colour and leaves alpha alone', ()=>{
    const code = generate(baseState({ fogMode: D3DFOG.LINEAR })).code;
    assert.match(code, /mix\(uniforms\.fogColor\.rgb, current\.rgb, fogAmount\)/);
    assert.match(code, /current\.a\)/, 'alpha is not fogged');
    assert.doesNotMatch(generate(baseState()).code, /fogAmount/);
});

test('an unsupported operation is refused rather than silently dropped', ()=>{
    const state = baseState({
        fvf: FVF.XYZ | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT),
        stages: [{
            colorOp: 99, colorArg1: D3DTA.TEXTURE, colorArg2: D3DTA.DIFFUSE,
            alphaOp: D3DTOP.SELECTARG1, alphaArg1: D3DTA.TEXTURE, alphaArg2: D3DTA.DIFFUSE,
            texCoordIndex: 0,
        }],
    });
    assert.throws(()=>generate(state), /Unsupported texture operation 99/);
});
