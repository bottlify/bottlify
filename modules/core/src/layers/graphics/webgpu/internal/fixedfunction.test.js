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
import {
    D3DFOG, D3DLIGHT, D3DMCS, D3DTA, D3DTOP, TCI, fixedFragmentStage, generateFixedFunction,
} from './fixedfunction.js';
import { FOG_SOURCE } from './pipeline.js';
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
    assert.equal(digest(first), 'df32dcf97ac7fd52');
});

test('a stage generating its coordinates takes them from the vertex in camera space', ()=>{
    // D3DTSS_TCI_CAMERASPACEPOSITION and its two siblings: the coordinate
    // is the vertex through world and view, put through the stage's texture
    // transform in the vertex stage -- where Direct3D applies it -- and
    // sampled from a varying of its own, so a vertex carrying no set at all
    // still textures, and the sample does not transform it a second time.
    const stage = (/** @type {number} */ texCoordIndex)=>({
        colorOp: D3DTOP.SELECTARG1,
        colorArg1: D3DTA.TEXTURE,
        colorArg2: D3DTA.SELECTMASK,
        alphaOp: D3DTOP.SELECTARG1,
        alphaArg1: D3DTA.DIFFUSE,
        alphaArg2: D3DTA.SELECTMASK,
        texCoordIndex,
    });
    const position = generate(baseState({
        fvf: FVF.XYZ | FVF.DIFFUSE, stages: [stage(TCI.CAMERASPACEPOSITION)],
    })).code;
    assert.ok(position.includes(
        'let cameraPosition = (uniforms.worldView * vec4f(vertex.position, 1.0)).xyz;'));
    assert.ok(position.includes('@location(2) generated0: vec4f,'));
    assert.ok(position.includes('out.generated0 = vec4f('
        + 'dot(uniforms.texTransform[0], vec4f(cameraPosition, 1.0)),'
        + ' dot(uniforms.texTransform[1], vec4f(cameraPosition, 1.0)),'
        + ' dot(uniforms.texTransform[2], vec4f(cameraPosition, 1.0)),'
        + ' dot(uniforms.texTransform[3], vec4f(cameraPosition, 1.0)));'));
    assert.ok(position.includes('sampleStage0(input.generated0)'));
    assert.ok(!position.includes('input.texCoord0'), 'no carried set is read');
    // The sample function of a generated stage applies no transform of its
    // own, and takes the coordinate's first two components.
    const sampler = position.slice(position.indexOf('fn sampleStage0'));
    assert.ok(sampler.startsWith('fn sampleStage0(carried: vec4f)'));
    assert.ok(sampler.slice(0, sampler.indexOf('}')).includes('let raw = carried.xy;'));

    // Projected: divided per pixel by the third component of the transformed
    // coordinate for a three-coordinate transform, the fourth for four --
    // which is how a texture is thrown onto the ground from a point.
    const projected = generate(baseState({
        fvf: FVF.XYZ | FVF.DIFFUSE,
        stages: [{ ...stage(TCI.CAMERASPACEPOSITION), projected: 3 }],
    })).code;
    const projectedSampler = projected.slice(projected.indexOf('fn sampleStage0'));
    assert.ok(projectedSampler.slice(0, projectedSampler.indexOf('}'))
        .includes('let raw = carried.xy / carried.z;'));
    const four = generate(baseState({
        fvf: FVF.XYZ | FVF.DIFFUSE,
        stages: [{ ...stage(TCI.CAMERASPACEPOSITION), projected: 4 }],
    })).code;
    assert.ok(four.includes('let raw = carried.xy / carried.w;'));

    // Without a normal in the vertex the camera-space normal is the one the
    // fixed function assumes, straight at the camera.
    const normal = generate(baseState({
        fvf: FVF.XYZ | FVF.DIFFUSE, stages: [stage(TCI.CAMERASPACENORMAL)],
    })).code;
    assert.ok(normal.includes('let cameraNormal = vec3f(0.0, 0.0, 1.0);'));
    assert.ok(normal.includes('vec4f(cameraNormal, 1.0)'));
    const lit = generate(baseState({
        fvf: FVF.XYZ | FVF.NORMAL, stages: [stage(TCI.CAMERASPACEREFLECTIONVECTOR)],
        normalizeNormals: true,
    })).code;
    assert.ok(lit.includes(
        'let cameraNormal = normalize((uniforms.worldView * vec4f(vertex.normal, 0.0)).xyz);'));
    assert.ok(lit.includes('reflect(normalize(cameraPosition), cameraNormal)'));

    // A pre-transformed vertex has no camera space to be taken in.
    const flat = generate(baseState({
        fvf: FVF.XYZRHW | FVF.DIFFUSE, stages: [stage(TCI.CAMERASPACEPOSITION)],
    })).code;
    assert.ok(flat.includes('out.generated0 = vec4f(0.0, 0.0, 1.0, 1.0);'));
    assert.ok(!flat.includes('cameraPosition'));
});

test('the blending operations weigh the two arguments by an alpha', ()=>{
    // D3DTOP_BLEND*ALPHA: arg1 by the alpha, arg2 by its complement, which
    // WGSL's mix spells with the arguments the other way round. The
    // premultiplied one adds arg1 whole.
    const fvf = FVF.XYZ | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT);
    const stage = (/** @type {number} */ colorOp)=>({
        colorOp, colorArg1: D3DTA.TEXTURE, colorArg2: D3DTA.CURRENT,
        alphaOp: D3DTOP.SELECTARG1, alphaArg1: D3DTA.CURRENT, alphaArg2: D3DTA.CURRENT,
        texCoordIndex: 0,
    });
    const codeOf = (/** @type {number} */ op)=>generate(baseState({ fvf, stages: [stage(op)] })).code;
    assert.ok(codeOf(D3DTOP.BLENDDIFFUSEALPHA).includes(
        'mix(current, sampleStage0(input.texCoord0), (input.diffuse).a)'));
    assert.ok(codeOf(D3DTOP.BLENDTEXTUREALPHA).includes(
        'mix(current, sampleStage0(input.texCoord0), (sampleStage0(input.texCoord0)).a)'));
    assert.ok(codeOf(D3DTOP.BLENDFACTORALPHA).includes(
        'mix(current, sampleStage0(input.texCoord0), (uniforms.textureFactor).a)'));
    assert.ok(codeOf(D3DTOP.BLENDCURRENTALPHA).includes(
        'mix(current, sampleStage0(input.texCoord0), (current).a)'));
    assert.ok(codeOf(D3DTOP.BLENDTEXTUREALPHAPM).includes(
        'sampleStage0(input.texCoord0) + current * (1.0 - (sampleStage0(input.texCoord0)).a)'));
    assert.ok(codeOf(D3DTOP.ADDSMOOTH).includes(
        'sampleStage0(input.texCoord0) + current - sampleStage0(input.texCoord0) * current'));
    assert.ok(codeOf(D3DTOP.ADDSIGNED2X).includes(
        '(sampleStage0(input.texCoord0) + current - vec4f(0.5)) * 2.0'));
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

test('a Direct3D screen coordinate lands on the centre of the pixel it names', ()=>{
    // Direct3D 9 and before put a pixel's centre on its integer coordinate
    // (Microsoft's "Directly Mapping Texels to Pixels": (0, 0) is the centre
    // of the top-left pixel); WebGPU puts it half a pixel further on. So
    // every position, transformed or not, is moved by half a pixel -- half
    // the viewport scale in clip space, times w -- and a quad drawn at pixel
    // edges still covers exactly the pixels it covered.
    const fixup = 'out.position = vec4f(out.position.xy'
        + ' + out.position.w * uniforms.viewportScale * 0.5, out.position.zw);';
    for (const fvf of [FVF.XYZ | FVF.DIFFUSE, FVF.XYZRHW | FVF.DIFFUSE])
    {
        const code = generate(baseState({ fvf })).code;
        const body = code.slice(code.indexOf('fn vertexMain'), code.indexOf('@fragment'));
        const lines = body.split('\n').map(line=>line.trim());
        const at = lines.indexOf(fixup);
        assert.ok(at > 0, body);
        assert.ok(lines.slice(0, at).some(line=>line.startsWith('out.position = ')),
            'after the position is computed');
    }
});

test('the position is invariant, so two passes over the same geometry meet exactly', ()=>{
    // A second pass drawn with ZFUNC EQUAL over the first -- a light map, a
    // detail layer, a highlight -- runs a different module whenever its stage
    // or light setup differs, and WGSL promises two modules the same position
    // from the same data and control flow only under @invariant; without it a
    // compiler may fuse the product differently and the pass z-fights.
    for (const state of [baseState(), baseState({ fvf: FVF.XYZRHW | FVF.DIFFUSE }),
        baseState({ fvf: LIT_FVF, lighting: lighting() })])
    {
        assert.match(generate(state).code, /@builtin\(position\) @invariant position: vec4f,/);
    }
});

test('flat shading takes both colours from the provoking vertex, but not the fog', ()=>{
    // D3DSHADE_FLAT (Wine's test_shademode; Microsoft's D3DSHADEMODE): the
    // colour and specular of the first vertex hold over the triangle, while
    // the specular alpha is still interpolated -- test_fog_interpolation
    // fogs a flat quad as smoothly as a Gouraud one.
    const code = generate(baseState({
        fvf: FVF.XYZ | FVF.DIFFUSE | FVF.SPECULAR,
        flatShading: true,
        fogMode: D3DFOG.NONE,
        fogSource: FOG_SOURCE.SPECULAR,
        stages: [{
            colorOp: D3DTOP.SELECTARG1, colorArg1: D3DTA.DIFFUSE, colorArg2: D3DTA.CURRENT,
            alphaOp: D3DTOP.SELECTARG1, alphaArg1: D3DTA.SPECULAR, alphaArg2: D3DTA.CURRENT,
            texCoordIndex: 0,
        }],
    })).code;
    assert.ok(code.includes('@location(0) @interpolate(flat) diffuse: vec4f,'));
    assert.ok(code.includes('@location(1) @interpolate(flat) specular: vec4f,'));
    assert.ok(code.includes('@location(2) specularAlpha: f32,'));
    assert.ok(code.includes('out.specularAlpha = out.specular.a;'));
    assert.match(code, /@location\(\d+\) fogAmount: f32,/, 'the fog is not flat');
    assert.ok(code.includes('saturate((vec4f(input.specular.rgb, input.specularAlpha)).a)'),
        'a stage reading the specular alpha reads the interpolated one');

    const gouraud = generate(baseState({ fvf: FVF.XYZ | FVF.DIFFUSE })).code;
    assert.doesNotMatch(gouraud, /interpolate/);
    assert.doesNotMatch(gouraud, /specularAlpha/);
});

test('a pre-transformed vertex gives its RHW back as the clip w', ()=>{
    // The RHW is what the rasteriser interpolates by: Microsoft's "Viewports
    // and Clipping" has a pre-transformed vertex taken back to clip space by
    // it, and D3DPTEXTURECAPS_PERSPECTIVE promises the perspective-correct
    // interpolation it makes possible. A w of one everywhere interpolates a
    // perspective-drawn quad affinely and bends its texture along the
    // diagonal. An RHW of zero or less has no w to give, and Windows still
    // draws such a vertex (Wine's test_table_fog_zw draws RHW 0), so it is
    // taken as one.
    const code = generate(baseState({ fvf: FVF.XYZRHW | FVF.DIFFUSE })).code;
    assert.ok(code.includes('let clipW = select(1.0, 1.0 / vertex.position.w,'
        + ' vertex.position.w > 0.0);'), code);
    assert.ok(code.includes('out.position = vec4f(screen.x - 1.0, screen.y + 1.0,'
        + ' vertex.position.z, 1.0) * clipW;'));
});

test('no stages leaves the diffuse colour alone', ()=>{
    // A stage that is off is absent, not neutral: "neutral" is only an identity
    // for some operations, and emitting one for a subtract darkens the scene.
    const code = generate(baseState()).code;
    assert.match(code, /var current = input\.diffuse;/);
    assert.doesNotMatch(code, /sampleStage/);
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

test('each stage saturates its result before the next stage reads it', ()=>{
    // Wine's d3d9 test_color_clamping: stage 0 adds diffuse and specular,
    // both white, and stage 1 modulates that by a texture factor of 0x40.
    // Windows draws 0x404040 -- the sum is held at one before the modulate --
    // and so does reference.js. An unsaturated sum of two reaches the second
    // stage and draws 0x808080; an ADDSIGNED or SUBTRACT below zero goes on
    // as a negative the same way.
    const stage = (/** @type {number} */ colorOp, /** @type {number} */ colorArg1,
        /** @type {number} */ colorArg2)=>({
        colorOp, colorArg1, colorArg2,
        alphaOp: D3DTOP.ADD, alphaArg1: D3DTA.DIFFUSE, alphaArg2: D3DTA.SPECULAR,
        texCoordIndex: 0,
    });
    const code = generate(baseState({
        fvf: FVF.XYZ | FVF.DIFFUSE | FVF.SPECULAR,
        stages: [
            stage(D3DTOP.ADD, D3DTA.DIFFUSE, D3DTA.SPECULAR),
            stage(D3DTOP.MODULATE, D3DTA.TFACTOR, D3DTA.CURRENT),
        ],
    })).code;
    const assignments = code.split('\n').filter(line=>/^ {4}current = /.test(line));
    assert.deepEqual(assignments, [
        '    current = vec4f(saturate((input.diffuse + input.specular).rgb),'
            + ' saturate((input.diffuse + input.specular).a));',
        '    current = vec4f(saturate((uniforms.textureFactor * current).rgb),'
            + ' saturate((input.diffuse + input.specular).a));',
    ]);
});

test('a colour-keyed stage discards where its nearest texel is the key', ()=>{
    // Direct3D 7's D3DRENDERSTATE_COLORKEYENABLE: a texel of the texture's
    // source colour key is not drawn. The key is compared against the texel
    // itself, before filtering blends it with its neighbours, and against
    // its colour alone; the stage's sample is taken as ever.
    const code = generate(baseState({
        fvf: FVF.XYZ | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT),
        stages: [{
            colorOp: D3DTOP.SELECTARG1, colorArg1: D3DTA.TEXTURE, colorArg2: D3DTA.CURRENT,
            alphaOp: D3DTOP.SELECTARG1, alphaArg1: D3DTA.TEXTURE, alphaArg2: D3DTA.CURRENT,
            texCoordIndex: 0, colorKey: 0xff00ff,
        }],
    })).code;
    assert.ok(code.includes('var<private> colourKeyed: bool = false;'));
    const sampler = code.slice(code.indexOf('fn sampleStage0'));
    assert.ok(sampler.includes('let keyTexel = textureLoad(texture0,'
        + ' vec2i(clamp(floor(uv * size), vec2f(0.0), size - 1.0)), 0);'), sampler);
    assert.ok(sampler.includes('if (all(abs(keyTexel.rgb - vec3f(1.0, 0.0, 1.0))'
        + ' < vec3f(0.5 / 255.0)))'));
    assert.match(code, /if \(colourKeyed\)\s*\{\s*discard;/);
    assert.doesNotMatch(generate(baseState()).code, /colourKeyed/, 'unkeyed, nothing');
});

test('an argument slot the operation does not read is never built', ()=>{
    // Stage state persists across draws, so the unread slot holds whatever an
    // earlier operation put there. Building it anyway sampled a texture the
    // stage does not use and failed the draw outright on a source this engine
    // cannot spell.
    const stage = (/** @type {object} */ over)=>({
        colorOp: D3DTOP.SELECTARG1,
        colorArg1: D3DTA.DIFFUSE,
        colorArg2: D3DTA.SELECTMASK,
        alphaOp: D3DTOP.SELECTARG1,
        alphaArg1: D3DTA.DIFFUSE,
        alphaArg2: D3DTA.TEXTURE,
        texCoordIndex: 0,
        ...over,
    });
    const fvf = FVF.XYZ | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT);

    const code = generate(baseState({ fvf, stages: [stage({})] })).code;
    assert.doesNotMatch(code, /sampleStage\d\(input/,
        'neither operation reads its second slot, so nothing samples');

    const selected = generate(baseState({
        fvf,
        stages: [stage({
            colorOp: D3DTOP.SELECTARG2,
            colorArg1: D3DTA.SELECTMASK,
            colorArg2: D3DTA.TFACTOR,
            alphaOp: D3DTOP.SELECTARG2,
            alphaArg1: D3DTA.SELECTMASK,
            alphaArg2: D3DTA.DIFFUSE,
        })],
    })).code;
    assert.match(selected, /current = vec4f\(saturate\(\(uniforms\.textureFactor\)\.rgb/,
        'argument two is what a select-two selects');
});

test('a stage samples the coordinate set it names, not its own number', ()=>{
    // A second stage reusing set zero is how a detail or lightmap pass is
    // written, and there is one set in the vertex for both. Reading set N for
    // stage N samples a varying the vertex never carried.
    const textured = {
        colorOp: D3DTOP.MODULATE, colorArg1: D3DTA.TEXTURE, colorArg2: D3DTA.CURRENT,
        alphaOp: D3DTOP.SELECTARG1, alphaArg1: D3DTA.TEXTURE, alphaArg2: D3DTA.CURRENT,
        texCoordIndex: 0,
    };
    const code = generate(baseState({
        fvf: FVF.XYZ | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT),
        stages: [textured, textured],
    })).code;

    assert.match(code, /sampleStage1\(input\.texCoord0\)/);
    assert.doesNotMatch(code, /texCoord1/, 'the vertex carries one set and only one is read');
    // The stage samples through the one hardware sampler with its own state
    // from the block: the address mode, the filters and the mip mode are
    // applied in the shader, and the level is chosen there.
    assert.match(code,
        /fn sampleStage1\(carried: vec2f\) -> vec4f \{\n(.*\n){3} {4}let flags = uniforms\.stage1;/);
    assert.match(code, /textureSampleLevel\(texture1, sampler1, uv, level\)/);
    assert.match(code, /fn addressCoordinate\(t: f32, mode: u32, texels: f32\) -> f32/);
});

test('a stage puts its coordinate through its own texture transform before sampling', ()=>{
    // Direct3D applies D3DTS_TEXTURE0..7 to (u, v, 1) for a two-coordinate
    // set: two dot products against the rows the block carries, computed
    // before the level and the address mode, which see the moved coordinate.
    // A sprite sheet's cell is chosen this way, so a stage that sampled the
    // carried coordinate would draw every sheet's first cell.
    const textured = {
        colorOp: D3DTOP.MODULATE, colorArg1: D3DTA.TEXTURE, colorArg2: D3DTA.CURRENT,
        alphaOp: D3DTOP.SELECTARG1, alphaArg1: D3DTA.TEXTURE, alphaArg2: D3DTA.CURRENT,
        texCoordIndex: 0,
    };
    const code = generate(baseState({
        fvf: FVF.XYZ | FVF.DIFFUSE | (1 << FVF.TEXCOUNT_SHIFT),
        stages: [textured, textured, textured, textured],
    })).code;

    assert.match(code, /texTransform: array<vec4f, 32>,/);
    for (const stage of [0, 1, 2])
    {
        const rows = `${stage * 4}`;
        const next = `${stage * 4 + 1}`;
        assert.match(code, new RegExp(
            `fn sampleStage${stage}\\(carried: vec2f\\) -> vec4f \\{\\n`
            + ` {4}let extended = vec3f\\(carried, 1\\.0\\);\\n`
            + ` {4}let raw = vec2f\\(dot\\(uniforms\\.texTransform\\[${rows}\\]\\.xyz,`
            + ` extended\\),\\n`
            + ` {8}dot\\(uniforms\\.texTransform\\[${next}\\]\\.xyz, extended\\)\\);\\n`
            + ` {4}let flags = uniforms\\.stage${stage};\\n`
            + ` {4}let size = vec2f\\(textureDimensions\\(texture${stage}, 0\\)\\);`),
        `stage ${stage} transforms with its own two rows, then measures its level`);
    }
    // The block carries rows for every stage; a fourth transforms with its
    // own, though its sampler state is the default.
    assert.match(code, /fn sampleStage3\(carried: vec2f\) -> vec4f \{\n {4}let extended = vec3f\(carried, 1\.0\);\n {4}let raw = vec2f\(dot\(uniforms\.texTransform\[12\]\.xyz, extended\),\n {8}dot\(uniforms\.texTransform\[13\]\.xyz, extended\)\);\n {4}let flags = 0u;/);
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

test('vertex fog fades by the magnitude of the camera-space z, not the clip w', ()=>{
    // Wine's d3d9 test_fog: with vertex fog the source is the vertex's
    // camera-space z whatever the projection -- an orthographic one holds
    // the clip w at one at every depth -- and test_negative_fixedfunction_fog
    // has the magnitude taken before the curve.
    const code = generate(baseState({
        fogMode: D3DFOG.LINEAR, fogSource: FOG_SOURCE.VERTEX,
    })).code;
    assert.ok(code.includes('out.fogAmount = fogFactorOf(abs((uniforms.worldView'
        + ' * vec4f(vertex.position, 1.0)).z));'));
    assert.doesNotMatch(code, /fogFactorOf\(out\.position\.w\)/);
});

test('range fog fades vertex fog by the distance from the eye', ()=>{
    // D3DRS_RANGEFOGENABLE: the vertex's distance from the camera instead of
    // its depth (Microsoft's "Vertex Fog"; Wine's d3d9 fog_test puts a quad
    // at z = 0.5 whose corners are 1.5 from the eye).
    const code = generate(baseState({
        fogMode: D3DFOG.LINEAR, fogSource: FOG_SOURCE.VERTEX, rangeFog: true,
    })).code;
    assert.ok(code.includes('out.fogAmount = fogFactorOf(length((uniforms.worldView'
        + ' * vec4f(vertex.position, 1.0)).xyz));'), code);
});

test('table fog is the pixel\'s: the curve over its z or its w, in the fragment stage', ()=>{
    // Wine's d3d9 test_fog_interpolation draws a quad whose z runs from 0 to 1
    // under table EXP fog and finds the middle at the curve's value there,
    // not at the mean of the two ends; test_fog has the depth be z under an
    // affine projection and w otherwise, which the block's fog row says.
    const code = generate(baseState({
        fogMode: D3DFOG.EXP, fogSource: FOG_SOURCE.TABLE,
    })).code;
    const fragment = code.slice(code.indexOf('@fragment'));
    assert.ok(fragment.includes('clamp(fogFactorOf(select(1.0 / input.position.w,'
        + ' input.position.z, uniforms.fogFactors.w != 0.0)), 0.0, 1.0)'), fragment);
    assert.doesNotMatch(code, /fogAmount/, 'no factor travels from the vertex');
    assert.match(code, /exp\(-uniforms\.fogFactors\.z \* dist\)/);

    // A pre-transformed vertex is fogged by the same pixel depth -- its z, or
    // the w its RHW gives -- and not by its specular alpha (test_table_fog_zw).
    const screen = generate(baseState({
        fvf: FVF.XYZRHW | FVF.DIFFUSE | FVF.SPECULAR,
        fogMode: D3DFOG.LINEAR, fogSource: FOG_SOURCE.TABLE,
    })).code;
    assert.ok(screen.includes('fogFactorOf(select(1.0 / input.position.w,'));
    assert.doesNotMatch(screen, /specular\.a/);
});

test('fog enabled with no mode set is the specular alpha, transformed or not', ()=>{
    // D3DRS_FOGENABLE with both modes NONE: Wine's test_fog_interpolation
    // finds the quad fogged by its interpolated specular alpha, as a program
    // that computes its own fog expects.
    for (const fvf of [FVF.XYZ | FVF.DIFFUSE | FVF.SPECULAR,
        FVF.XYZRHW | FVF.DIFFUSE | FVF.SPECULAR])
    {
        const code = generate(baseState({
            fvf, fogMode: D3DFOG.NONE, fogSource: FOG_SOURCE.SPECULAR,
        })).code;
        assert.ok(code.includes('out.fogAmount = vertex.specular.a;'));
        assert.ok(code.includes('clamp(input.fogAmount, 0.0, 1.0)'));
        assert.doesNotMatch(code, /fogFactorOf/, 'and no curve');
    }
});

test('a vertex shader over the fixed pixel stage is fogged by what it wrote, or per pixel', ()=>{
    // Below table fog the factor is the shader's oFog, else its specular
    // alpha -- the vertex mode's curve does not apply to it (Wine's test_fog,
    // VS_MODE_VS_FOG and VS_MODE_VS_NO_FOG); table fog is the pixel's.
    const state = (/** @type {object} */ over)=>/** @type {any} */ (baseState({
        fvf: 0, fogMode: D3DFOG.LINEAR, fogSource: FOG_SOURCE.VERTEX, ...over,
    }));
    assert.ok(fixedFragmentStage(state({}), [0, 1, 10]).wgsl
        .includes('input.fogAmount = in.fog.x;'));
    assert.ok(fixedFragmentStage(state({}), [0, 1]).wgsl
        .includes('input.fogAmount = in.v1.a;'));
    const table = fixedFragmentStage(state({ fogSource: FOG_SOURCE.TABLE }), [0, 1, 10]).wgsl;
    assert.ok(table.includes('fogFactorOf(select(1.0 / in.position.w, in.position.z,'));
    assert.doesNotMatch(table, /fogAmount/);
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
    const code = generate(baseState({
        fvf: LIT_FVF, lighting: lighting(), normalizeNormals: true,
    })).code;
    // By the inverse transpose of the world matrix, which the block carries:
    // the world matrix itself carries a normal wrong under non-uniform scale
    // and under a non-affine world (Wine's d3d9 lighting_test).
    assert.match(code, /let worldNormal = normalize\(\(uniforms\.normalMatrix \* vec4f\(vertex\.normal,/);
    assert.match(code,
        /let worldPosition = \(uniforms\.world \* vec4f\(vertex\.position, 1\.0\)\)\.xyz;/);
    // The position still goes through the whole product, not the world matrix.
    assert.match(code, /out\.position = uniforms\.worldViewProjection/);
});

test('with NORMALIZENORMALS off a normal keeps the length its transform gave it', ()=>{
    // The state's default. A normal longer or shorter than one -- as the
    // program supplied it, or scaled by the world matrix -- lights its vertex
    // by that length on Windows, and only D3DRS_NORMALIZENORMALS renormalises
    // it, for lighting and for a coordinate generated from it alike.
    const lit = generate(baseState({ fvf: LIT_FVF, lighting: lighting() })).code;
    assert.ok(lit.includes(
        'let worldNormal = (uniforms.normalMatrix * vec4f(vertex.normal, 0.0)).xyz;'), lit);
    const generating = {
        colorOp: D3DTOP.SELECTARG1, colorArg1: D3DTA.TEXTURE, colorArg2: D3DTA.CURRENT,
        alphaOp: D3DTOP.SELECTARG1, alphaArg1: D3DTA.DIFFUSE, alphaArg2: D3DTA.CURRENT,
        texCoordIndex: TCI.CAMERASPACENORMAL,
    };
    const unnormalized = generate(baseState({
        fvf: FVF.XYZ | FVF.NORMAL, stages: [generating],
    })).code;
    assert.ok(unnormalized.includes(
        'let cameraNormal = (uniforms.worldView * vec4f(vertex.normal, 0.0)).xyz;'));
    const normalized = generate(baseState({
        fvf: FVF.XYZ | FVF.NORMAL, stages: [generating], normalizeNormals: true,
    })).code;
    assert.ok(normalized.includes(
        'let cameraNormal = normalize((uniforms.worldView * vec4f(vertex.normal, 0.0)).xyz);'));
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
