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
import { D3DFOG, D3DLIGHT, D3DMCS, D3DTA, D3DTOP, generateFixedFunction } from './fixedfunction.js';
import { FVF, decodeFvf } from './vertexformat.js';

/** The vertex format a lit draw needs at the very least. */
const LIT_FVF = FVF.XYZ | FVF.NORMAL | FVF.DIFFUSE;

/** @param {object} over */
const lighting = (over = {})=>({
    lights: [D3DLIGHT.DIRECTIONAL],
    colorVertex: true,
    diffuseSource: D3DMCS.COLOR1,
    ambientSource: D3DMCS.MATERIAL,
    specularSource: D3DMCS.COLOR2,
    emissiveSource: D3DMCS.MATERIAL,
    ...over,
});

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
    assert.equal(digest(first), '5e003f3ab4867f4d');
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
    assert.match(code,
        /mix\(uniforms\.fogColor\.rgb, current\.rgb, clamp\(input\.fogAmount, 0\.0, 1\.0\)\)/);
    assert.match(code, /current\.a\)/, 'alpha is not fogged');
    assert.doesNotMatch(generate(baseState()).code, /fogAmount/);
});

test('each fog mode gets its own curve, and only its own', ()=>{
    // The mode shapes the shader rather than riding in a uniform, so a build
    // that emitted the wrong curve would be wrong for every draw that ever used
    // that mode and right for the rest -- which reads as some geometry fading
    // and some not.
    const linear = generate(baseState({ fogMode: D3DFOG.LINEAR })).code;
    assert.match(linear, /\(end - dist\) \/ \(end - start\)/);
    assert.doesNotMatch(linear, /exp\(/);

    const exponential = generate(baseState({ fogMode: D3DFOG.EXP })).code;
    assert.match(exponential, /exp\(-uniforms\.fogFactors\.z \* dist\)/);

    const squared = generate(baseState({ fogMode: D3DFOG.EXP2 })).code;
    assert.match(squared, /exp\(-scaled \* scaled\)/);

    assert.doesNotMatch(generate(baseState()).code, /fogFactorOf/,
        'and a shader with no fog carries no curve at all');
});

test('fog fades by eye distance, which is the clip-space w', ()=>{
    // Direct3D defines fog against eye-space depth, and for a perspective
    // projection that is exactly the w the transform produces. Fading by the
    // depth buffer's z instead compresses the whole scene into the far end of
    // the curve, where everything is equally fogged.
    const code = generate(baseState({ fogMode: D3DFOG.LINEAR })).code;
    assert.match(code, /out\.fogAmount = fogFactorOf\(out\.position\.w\);/);
});

test('a pre-transformed vertex takes its fog factor from the specular alpha', ()=>{
    // Such a vertex is already on the screen and has no eye to be far from.
    // Direct3D has the program supply the factor instead, and a format that
    // carries no specular has nothing to fog by -- fading it by the depth of
    // whatever is behind it would fog a two-dimensional overlay.
    const withSpecular = generate(baseState({
        fvf: FVF.XYZRHW | FVF.DIFFUSE | FVF.SPECULAR,
        fogMode: D3DFOG.LINEAR,
    })).code;
    assert.match(withSpecular, /out\.fogAmount = vertex\.specular\.a;/);

    const without = generate(baseState({
        fvf: FVF.XYZRHW | FVF.DIFFUSE,
        fogMode: D3DFOG.LINEAR,
    })).code;
    assert.match(without, /out\.fogAmount = 1\.0;/, 'which is "not fogged"');
});

test('lighting off leaves the vertex colours exactly as they arrived', ()=>{
    // This is the path every draw took before there was a lighting equation at
    // all, and it has to keep being that path: D3DRS_LIGHTING off means the
    // vertex colour is the colour, not a lit version of it.
    const code = generate(baseState({ fvf: LIT_FVF })).code;
    assert.match(code, /out\.diffuse = vertex\.diffuse\.bgra;/);
    assert.doesNotMatch(code, /worldNormal/);
    assert.doesNotMatch(code, /struct Light/);
});

test('a lit vertex transforms its normal by the world matrix and renormalises', ()=>{
    // Lighting happens in world space. A normal left in object space is lit as
    // though the model never rotated, which reads as light that follows the
    // geometry around -- and only once something rotates.
    const code = generate(baseState({ fvf: LIT_FVF, lighting: lighting() })).code;
    assert.match(code,
        /let worldNormal = normalize\(\(uniforms\.world \* vec4f\(vertex\.normal, 0\.0\)\)\.xyz\);/);
    assert.match(code,
        /let worldPosition = \(uniforms\.world \* vec4f\(vertex\.position, 1\.0\)\)\.xyz;/);
    // The position still goes through the whole product, not the world matrix.
    assert.match(code, /out\.position = uniforms\.worldViewProjection/);
});

test('a directional light is a negated direction and nothing else', ()=>{
    // D3DLIGHT8.Direction is the direction the light travels; the equation
    // wants the direction towards it. Missing the negation lights exactly the
    // faces that should be dark.
    const code = generate(baseState({ fvf: LIT_FVF, lighting: lighting() })).code;
    assert.match(code, /let toLight = -light\.direction\.xyz;/);
    assert.match(code, /let scale = 1\.0;/);
    assert.doesNotMatch(code, /attenuationOf/, 'a directional light does not attenuate');
    assert.doesNotMatch(code, /spotFactor/);
    assert.match(code, /lights: array<Light, 1>/);
});

test('a point light attenuates by distance and a spot light also by its cone', ()=>{
    const point = generate(
        baseState({ fvf: LIT_FVF, lighting: lighting({ lights: [D3DLIGHT.POINT] }) })).code;
    assert.match(point, /let scale = attenuationOf\(light, dist\);/);
    assert.match(point, /fn attenuationOf/);
    assert.doesNotMatch(point, /fn spotFactor/, 'a point light has no cone');
    // Past the range a light contributes nothing at all, which is what the
    // range means; without the test it keeps adding its attenuated remainder.
    assert.match(point, /if \(dist > light\.position\.w\)/);

    const spot = generate(
        baseState({ fvf: LIT_FVF, lighting: lighting({ lights: [D3DLIGHT.SPOT] }) })).code;
    assert.match(spot, /let scale = attenuationOf\(light, dist\) \* spotFactor\(light, toLight\);/);
    assert.match(spot, /fn spotFactor/);
});

test('each enabled light gets its own unrolled block, in order', ()=>{
    const code = generate(baseState({
        fvf: LIT_FVF,
        lighting: lighting({ lights: [D3DLIGHT.DIRECTIONAL, D3DLIGHT.POINT, D3DLIGHT.SPOT] }),
    })).code;
    assert.match(code, /lights: array<Light, 3>/);
    assert.match(code, /let light = uniforms\.lights\[0\];\n\s+let toLight = -light\.direction/);
    assert.match(code, /let light = uniforms\.lights\[1\];\n\s+let offset/);
    assert.equal((code.match(/let light = uniforms\.lights\[/g) || []).length, 3);
    assert.equal((code.match(/fn attenuationOf/g) || []).length, 1,
        'the helpers are declared once however many lights call them');
});

test('lighting with no light enabled is ambient and emissive only', ()=>{
    // Not "unlit": a program that turns lighting on with nothing enabled gets
    // the material's own emissive and the scene's ambient, which is dark. An
    // array of zero lights is not expressible in WGSL, so neither the struct
    // nor the array may be declared.
    const code = generate(
        baseState({ fvf: LIT_FVF, lighting: lighting({ lights: [] }) })).code;
    assert.doesNotMatch(code, /struct Light/);
    assert.doesNotMatch(code, /lights: array/);
    assert.match(code, /var lightDiffuse = vec3f\(0\.0, 0\.0, 0\.0\);/);
    assert.match(code, /sourceEmissive\.rgb \+ sourceAmbient\.rgb \* \(uniforms\.ambient\.rgb/);

    // And with the specular term on there is still nothing to reflect, so the
    // eye vector and the accumulator are not emitted either.
    const withSpecular = generate(baseState({
        fvf: LIT_FVF, lighting: lighting({ lights: [] }), specularEnable: true,
    })).code;
    assert.doesNotMatch(withSpecular, /toEye/);
    assert.match(withSpecular, /out\.specular = vec4f\(0\.0, 0\.0, 0\.0, 0\.0\);/);
});

test('a material source takes the vertex colour only when it is there to take', ()=>{
    // D3DRS_COLORVERTEX with a source of COLOR1 means the vertex's own diffuse
    // stands in for the material's. A program that sets it and gets the
    // material anyway draws a scene in one flat colour.
    const vertexLit = generate(baseState({ fvf: LIT_FVF, lighting: lighting() })).code;
    assert.match(vertexLit, /let sourceDiffuse = vertex\.diffuse\.bgra;/);
    assert.match(vertexLit, /let sourceAmbient = uniforms\.materialAmbient;/);

    // Off, every term is the material's, whatever the sources say.
    const materialOnly = generate(baseState({
        fvf: LIT_FVF, lighting: lighting({ colorVertex: false }),
    })).code;
    assert.match(materialOnly, /let sourceDiffuse = uniforms\.materialDiffuse;/);

    // And a colour the vertex does not carry is the material's too: the
    // alternative is a shader that reads an attribute the layout has not got.
    const noColour = generate(baseState({
        fvf: FVF.XYZ | FVF.NORMAL, lighting: lighting(),
    })).code;
    assert.match(noColour, /let sourceDiffuse = uniforms\.materialDiffuse;/);

    const fromSpecular = generate(baseState({
        fvf: LIT_FVF | FVF.SPECULAR,
        lighting: lighting({ emissiveSource: D3DMCS.COLOR2 }),
    })).code;
    assert.match(fromSpecular, /let sourceEmissive = vertex\.specular\.bgra;/);
});

test('a lit vertex takes its alpha from the diffuse source alone', ()=>{
    // The equation is over the three colour channels. An alpha that picked up
    // the lighting would make lit geometry fade as it turned away.
    const code = generate(baseState({ fvf: LIT_FVF, lighting: lighting() })).code;
    assert.match(code,
        /out\.diffuse = vec4f\(clamp\(lit, vec3f\(0\.0\), vec3f\(1\.0\)\), sourceDiffuse\.a\);/);
});

test('the specular term is computed only when it is enabled, and added after the cascade', ()=>{
    const on = generate(baseState({
        fvf: LIT_FVF, lighting: lighting(), specularEnable: true,
    })).code;
    assert.match(on, /let highlight = pow\(max\(dot\(worldNormal, halfNormal\), 0\.0\),/);
    assert.match(on, /uniforms\.eye\.w\)/, 'the exponent is the material power');
    assert.match(on, /current = vec4f\(current\.rgb \+ input\.specular\.rgb, current\.a\);/);

    const off = generate(baseState({ fvf: LIT_FVF, lighting: lighting() })).code;
    assert.doesNotMatch(off, /highlight/);
    assert.doesNotMatch(off, /input\.specular\.rgb/);
    assert.match(off, /out\.specular = vec4f\(0\.0, 0\.0, 0\.0, 0\.0\);/);
});

test('the specular colour is added even when nothing was lit', ()=>{
    // D3DRS_SPECULARENABLE is a fragment-stage decision as well: a program that
    // supplies its own specular colour and turns lighting off still expects it
    // on top of the texture.
    const code = generate(baseState({
        fvf: FVF.XYZ | FVF.DIFFUSE | FVF.SPECULAR, specularEnable: true,
    })).code;
    assert.match(code, /out\.specular = vertex\.specular\.bgra;/);
    assert.match(code, /current = vec4f\(current\.rgb \+ input\.specular\.rgb, current\.a\);/);
});

test('a lit format without a normal, and an unknown light type, are refused', ()=>{
    // Both would compile into something: the first into a shader reading an
    // attribute that is not there, the second into a light that contributes
    // nothing. A refusal is what the shader cache is for.
    assert.throws(
        ()=>generate(baseState({ fvf: FVF.XYZ | FVF.DIFFUSE, lighting: lighting() })),
        /must carry a normal/);
    assert.throws(
        ()=>generate(baseState({ fvf: LIT_FVF, lighting: lighting({ lights: [7] }) })),
        /Unsupported light type 7/);
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
