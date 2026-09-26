/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import { createTextureEnvironment } from './texture.js';
import { parseProgram } from './arb-program.js';
import { VARYING_TEXCOORDS, emitVertex } from './arb-wgsl.js';
import { CANONICAL_LAYOUT } from './gpu-layout.js';
import {
    UNIFORM, clearDescriptor, clearKey, copyKey, drawDescriptor, drawKey, generateClear,
    generateCopy, generateDraw, generateShow, showDescriptor,
} from './wgsl.js';

/**
 * @param {Partial<import('./wgsl.js').UnitState>} [fields]
 * @returns {import('./wgsl.js').UnitState}
 */
const unit = (fields = {})=>({
    index: 0,
    cube: false,
    mode: GL.MODULATE,
    combine: createTextureEnvironment().combine,
    hasColour: true,
    hasAlpha: true,
    intensity: false,
    rgbOnly: false,
    generation: [null, null, null, null],
    ...fields,
});

/**
 * @param {Partial<import('./wgsl.js').DrawState>} [fields]
 * @returns {import('./wgsl.js').DrawState}
 */
const state = (fields = {})=>({
    attributes: CANONICAL_LAYOUT.attributes,
    strides: CANONICAL_LAYOUT.slots.map(slot=>slot.stride),
    topology: 'triangle-list',
    targetFormat: 'bgra8unorm',
    depthFormat: 'depth24plus-stencil8',
    units: [],
    colourSum: false,
    fog: null,
    alphaFunc: null,
    flat: false,
    blend: null,
    depth: { test: true, func: GL.LESS, write: true },
    stencil: null,
    cull: 'none',
    frontIsCcw: true,
    viewportHeight: 0,
    colourMask: 0xf,
    polygonOffset: null,
    vertexProgram: null,
    fragmentProgram: null,
    ...fields,
});

test('every field the descriptor or the shader reads changes the key', ()=>{
    const base = drawKey(state());
    /** @type {Partial<import('./wgsl.js').DrawState>[]} */
    const variants = [
        { attributes: CANONICAL_LAYOUT.attributes.slice(0, 1) },
        { strides: [64] },
        { topology: 'line-list' },
        { targetFormat: 'rgba8unorm' },
        { units: [unit()] },
        { units: [unit({ cube: true })] },
        { units: [unit({ mode: GL.REPLACE })] },
        { units: [unit({ hasAlpha: false })] },
        { units: [unit({ generation: [GL.OBJECT_LINEAR, null, null, null] })] },
        { units: [unit({ mode: GL.COMBINE,
            combine: { ...createTextureEnvironment().combine, rgb: GL.DOT3_RGBA } })] },
        { colourSum: true },
        { fog: { mode: GL.LINEAR, fromCoordinate: false } },
        { fog: { mode: GL.LINEAR, fromCoordinate: true } },
        { alphaFunc: GL.GREATER },
        { flat: true },
        { blend: { src: GL.ONE, dst: GL.ONE } },
        { depth: { test: false, func: GL.LESS, write: true } },
        { depth: { test: true, func: GL.LEQUAL, write: true } },
        { depth: { test: true, func: GL.LESS, write: false } },
        { stencil: { func: GL.ALWAYS, fail: GL.KEEP, zfail: GL.KEEP, zpass: GL.INCR,
            readMask: 0xff, writeMask: 0xff } },
        {
            stencil: { func: GL.ALWAYS, fail: GL.KEEP, zfail: GL.KEEP, zpass: GL.DECR,
                readMask: 0xff, writeMask: 0xff },
            stencilBack: { func: GL.ALWAYS, fail: GL.KEEP, zfail: GL.KEEP, zpass: GL.INCR,
                readMask: 0xff, writeMask: 0xff },
        },
        { cull: 'back' },
        { frontIsCcw: false },
        { colourMask: 0x8 },
        { polygonOffset: { factor: 0, units: -600 } },
    ];
    const keys = new Set([base]);
    for (const variant of variants)
    {
        const key = drawKey(state(variant));
        assert.ok(!keys.has(key), `${JSON.stringify(variant)} folds into another key`);
        keys.add(key);
    }
});

test('a unit reads its own coordinate set, divides by q, and applies its environment', ()=>{
    const { code } = generateDraw(state({ units: [unit({ index: 1 })] }));
    assert.match(code, /@binding\(1\) var t1Texture: texture_2d<f32>/);
    assert.match(code, /out\.tc1 = uniforms\.textureMatrix\[1\] \* tc1/);
    assert.match(code, /textureSample\(t1Texture, t1Sampler, input\.tc1\.xy \/ input\.tc1\.w\)/);
    assert.match(code, /current = vec4f\(current\.rgb \* t1\.rgb, current\.a \* t1\.a\)/,
        'MODULATE on an RGBA texture multiplies both');
});

test('the environment table follows the base format', ()=>{
    const replaceRgb = generateDraw(state({ units: [unit({ mode: GL.REPLACE, hasAlpha: false,
        rgbOnly: true })] })).code;
    assert.match(replaceRgb, /current = vec4f\(t0\.rgb, current\.a\)/,
        'REPLACE on an RGB texture keeps the fragment\'s alpha');
    const decalRgb = generateDraw(state({ units: [unit({ mode: GL.DECAL, hasAlpha: false,
        rgbOnly: true })] })).code;
    assert.match(decalRgb, /current = vec4f\(t0\.rgb, current\.a\)/);
    const decal = generateDraw(state({ units: [unit({ mode: GL.DECAL })] })).code;
    assert.match(decal, /mix\(current\.rgb, t0\.rgb, t0\.a\)/);
    const intensityAdd = generateDraw(state({ units: [unit({ mode: GL.ADD, intensity: true })] }))
        .code;
    assert.match(intensityAdd, /min\(current\.a \+ t0\.a, 1\.0\)/,
        'ADD on an intensity texture adds the alpha too');
});

test('GL_COMBINE writes the dot product for both colour and alpha under DOT3_RGBA', ()=>{
    const combine = {
        ...createTextureEnvironment().combine,
        rgb: GL.DOT3_RGBA,
        sourceRgb: [GL.TEXTURE, GL.PREVIOUS, GL.CONSTANT],
        operandRgb: [GL.SRC_COLOR, GL.SRC_COLOR, GL.SRC_ALPHA],
        rgbScale: 2,
    };
    const { code } = generateDraw(state({ units: [unit({ mode: GL.COMBINE, combine })] }));
    assert.match(code,
        /4\.0 \* dot\(\(t0\)\.rgb - vec3f\(0\.5\), \(current\)\.rgb - vec3f\(0\.5\)\)/);
    assert.match(code, /\* 2\.0, vec3f\(0\.0\), vec3f\(1\.0\)\)/, 'the scale is applied and clamped');
    assert.match(code, /current = vec4f\(rgb, rgb\.x\)/, 'the alpha is the dot product');
});

test('texture generation reads the plane of its coordinate, in object or eye space', ()=>{
    const { code } = generateDraw(state({ units: [unit({
        generation: [GL.OBJECT_LINEAR, GL.EYE_LINEAR, null, GL.OBJECT_LINEAR],
    })] }));
    assert.match(code, /tc0\.x = dot\(objectPosition, uniforms\.planes\[0\]\)/);
    assert.match(code, /tc0\.y = dot\(eyePosition, uniforms\.planes\[1\]\)/);
    assert.doesNotMatch(code, /tc0\.z =/);
    assert.match(code, /tc0\.w = dot\(objectPosition, uniforms\.planes\[3\]\)/);
});

test('the clip depth is remapped, and an absent attribute is the current value', ()=>{
    const { code } = generateDraw(state({
        attributes: CANONICAL_LAYOUT.attributes.filter(a=>a.name === 'position'),
    }));
    assert.ok(code.includes('out.position = vec4f(clip.x, clip.y,'
        + ' (clip.z * uniforms.misc.y + clip.w) * 0.5, clip.w)'));
    assert.match(code, /out\.color = uniforms\.color;/);
    assert.match(code, /out\.secondary = uniforms\.secondary;/);
});

test('an integer attribute is converted and a short one widened', ()=>{
    const { code } = generateDraw(state({
        attributes: [
            { name: 'position', slot: 0, offset: 0, format: 'sint32x2', components: 2,
                scalar: 'i32' },
        ],
        strides: [8],
    }));
    assert.match(code, /@location\(0\) position: vec2<i32>/);
    assert.match(code, /let objectPosition = vec4f\(vec2f\(vertex\.position\), 0\.0, 1\.0\);/);
});

test('the alpha test discards, fog mixes, and the colour sum adds before it', ()=>{
    const { code } = generateDraw(state({
        alphaFunc: GL.GEQUAL, fog: { mode: GL.EXP2, fromCoordinate: false }, colourSum: true,
    }));
    assert.match(code, /exp\(-\(uniforms\.fogParams\.x \* c\) \* \(uniforms\.fogParams\.x \* c\)\)/);
    const sum = code.indexOf('input.secondary');
    const fog = code.indexOf('mix(uniforms.fogColor.rgb');
    const discard = code.indexOf('discard');
    assert.ok(sum > 0 && sum < fog && fog < discard, 'colour sum, then fog, then the alpha test');
    assert.match(code, /if \(!\(current\.a >= uniforms\.misc\.x\)\)/);
});

test('flat shading marks the colour varyings flat', ()=>{
    const { code } = generateDraw(state({ flat: true }));
    assert.match(code, /@location\(0\) @interpolate\(flat\) color: vec4f/);
});

test('the uniform block layout the shader declares is the one the renderer fills', ()=>{
    // Each field's float offset, as WGSL lays the struct out: matrices are
    // sixteen floats, vectors four, and nothing here needs padding.
    assert.equal(UNIFORM.modelView, 16);
    assert.equal(UNIFORM.textureMatrix, 48);
    assert.equal(UNIFORM.planes, UNIFORM.textureMatrix + 4 * 16);
    assert.equal(UNIFORM.color, UNIFORM.planes + 16 * 4);
    assert.equal(UNIFORM.texCoord, UNIFORM.normal + 4);
    assert.equal(UNIFORM.envColor, UNIFORM.texCoord + VARYING_TEXCOORDS * 4,
        'the current values run to every coordinate set the varyings carry');
    assert.equal(UNIFORM.fogColor, UNIFORM.envColor + 4 * 4);
    assert.equal(UNIFORM.floats, UNIFORM.misc + 4);
    assert.equal(UNIFORM.floats % 4, 0);
});

test('the descriptor maps GL state onto WebGPU\'s, with the stencil on both faces', ()=>{
    const descriptor = drawDescriptor(state({
        blend: { src: GL.SRC_ALPHA, dst: GL.ONE_MINUS_SRC_ALPHA },
        depth: { test: true, func: GL.GEQUAL, write: false },
        stencil: { func: GL.GEQUAL, fail: GL.KEEP, zfail: GL.DECR, zpass: GL.INCR_WRAP,
            readMask: 0xff, writeMask: 0x7f },
        cull: 'front',
        frontIsCcw: false,
        colourMask: 0x8,
        polygonOffset: { factor: 0, units: -600 },
    }));
    assert.deepEqual(descriptor.target.blend.color,
        { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' });
    assert.equal(descriptor.target.writeMask, 0x8);
    assert.equal(descriptor.primitive.cullMode, 'front');
    assert.equal(descriptor.primitive.frontFace, 'cw');
    assert.equal(descriptor.depthStencil.depthCompare, 'greater-equal');
    assert.equal(descriptor.depthStencil.depthWriteEnabled, false);
    assert.deepEqual(descriptor.depthStencil.stencilFront, {
        compare: 'greater-equal', failOp: 'keep', depthFailOp: 'decrement-clamp',
        passOp: 'increment-wrap',
    });
    assert.deepEqual(descriptor.depthStencil.stencilBack, descriptor.depthStencil.stencilFront);
    assert.equal(descriptor.depthStencil.stencilWriteMask, 0x7f);
    assert.equal(descriptor.depthStencil.depthBias, -600);
    assert.deepEqual(descriptor.vertexBuffers[0].attributes[1],
        { shaderLocation: 1, offset: 16, format: 'float32x4' });
});

test('GL_EXT_stencil_two_side gives WebGPU\'s stencilFront and stencilBack their own ops', ()=>{
    const descriptor = drawDescriptor(state({
        stencil: { func: GL.ALWAYS, fail: GL.KEEP, zfail: GL.KEEP, zpass: GL.INCR_WRAP,
            readMask: 0xff, writeMask: 0xff },
        stencilBack: { func: GL.ALWAYS, fail: GL.KEEP, zfail: GL.KEEP, zpass: GL.DECR_WRAP,
            readMask: 0xff, writeMask: 0xff },
    })).depthStencil;
    assert.equal(descriptor.stencilFront.passOp, 'increment-wrap');
    assert.equal(descriptor.stencilBack.passOp, 'decrement-wrap');
    // A one-sided state (`stencilBack` absent) has no back ops of its own:
    // both faces get the front's.
    const oneSided = drawDescriptor(state({
        stencil: { func: GL.ALWAYS, fail: GL.KEEP, zfail: GL.KEEP, zpass: GL.INCR,
            readMask: 0xff, writeMask: 0xff },
    })).depthStencil;
    assert.deepEqual(oneSided.stencilBack, oneSided.stencilFront);
});

test('a stencilBack present and equal to the front is the same key and descriptor as one '
    + 'absent: the shape context-scene.js\'s builder actually emits', ()=>{
    const front = { func: GL.GEQUAL, fail: GL.KEEP, zfail: GL.INCR, zpass: GL.REPLACE,
        readMask: 0xff, writeMask: 0x0f };
    const withBack = state({ stencil: front, stencilBack: { ...front } });
    const withoutBack = state({ stencil: front });
    assert.equal(drawKey(withBack), drawKey(withoutBack));
    assert.deepEqual(drawDescriptor(withBack), drawDescriptor(withoutBack));
});

test('the back face\'s masks fold into neither the key nor the descriptor: WebGPU has no '
    + 'per-face mask to give them', ()=>{
    const front = { func: GL.GEQUAL, fail: GL.KEEP, zfail: GL.INCR, zpass: GL.REPLACE,
        readMask: 0xff, writeMask: 0x0f };
    const a = state({ stencil: front,
        stencilBack: { ...front, readMask: 0x0f, writeMask: 0xf0 } });
    const b = state({ stencil: front,
        stencilBack: { ...front, readMask: 0xff, writeMask: 0xff } });
    assert.equal(drawKey(a), drawKey(b));
    assert.deepEqual(drawDescriptor(a), drawDescriptor(b));
});

test('a stencil-shadowed light\'s three passes get the descriptor their state names', ()=>{
    // The states a per-light pass of a stencil-shadowed scene runs under: the
    // volume counts with the clamped ops, one culled face set at a time, over
    // a depth-equal test it does not write; the interaction then tests GEQUAL
    // against the cleared reference; the light's rectangle is re-cleared by a
    // clear that writes stencil alone.
    const volume = state({
        depth: { test: true, func: GL.LEQUAL, write: false },
        stencil: { func: GL.ALWAYS, fail: GL.KEEP, zfail: GL.KEEP, zpass: GL.INCR,
            readMask: 0xff, writeMask: 0xff },
        cull: 'front',
        colourMask: 0x0,
        polygonOffset: { factor: 0, units: 1 },
    });
    const counted = drawDescriptor(volume).depthStencil;
    assert.equal(counted.depthCompare, 'less-equal');
    assert.equal(counted.depthWriteEnabled, false);
    assert.deepEqual(counted.stencilFront, {
        compare: 'always', failOp: 'keep', depthFailOp: 'keep',
        passOp: 'increment-clamp',
    });
    assert.deepEqual(counted.stencilBack, counted.stencilFront,
        'one-sided stencil state is both of WebGPU\'s faces');
    assert.equal(counted.stencilReadMask, 0xff);
    assert.equal(counted.stencilWriteMask, 0xff);
    assert.equal(counted.depthBias, 1);
    assert.equal(counted.depthBiasSlopeScale, 0);
    const otherFace = drawDescriptor({ ...volume, cull: 'back',
        stencil: { func: GL.ALWAYS, fail: GL.KEEP, zfail: GL.KEEP, zpass: GL.DECR,
            readMask: 0xff, writeMask: 0xff } });
    assert.equal(otherFace.depthStencil.stencilFront.passOp, 'decrement-clamp');
    assert.equal(otherFace.primitive.cullMode, 'back');
    const interaction = drawDescriptor(state({
        blend: { src: GL.ONE, dst: GL.ONE },
        depth: { test: true, func: GL.EQUAL, write: false },
        stencil: { func: GL.GEQUAL, fail: GL.KEEP, zfail: GL.KEEP, zpass: GL.KEEP,
            readMask: 0xff, writeMask: 0xff },
        cull: 'front',
    })).depthStencil;
    assert.equal(interaction.depthCompare, 'equal');
    assert.equal(interaction.depthWriteEnabled, false);
    assert.deepEqual(interaction.stencilFront, {
        compare: 'greater-equal', failOp: 'keep', depthFailOp: 'keep', passOp: 'keep',
    });
    assert.deepEqual(interaction.stencilBack, interaction.stencilFront);
    assert.equal(interaction.stencilWriteMask, 0xff);
    const recleared = clearDescriptor({ targetFormat: 'bgra8unorm',
        depthFormat: 'depth24plus-stencil8', colourMask: 0, depth: false,
        stencilMask: 0xff }).depthStencil;
    assert.equal(recleared.depthCompare, 'always');
    assert.equal(recleared.depthWriteEnabled, false);
    assert.deepEqual(recleared.stencilFront, {
        compare: 'always', failOp: 'keep', depthFailOp: 'keep', passOp: 'replace',
    });
    assert.deepEqual(recleared.stencilBack, recleared.stencilFront);
    assert.equal(recleared.stencilWriteMask, 0xff);
});

test('a position-invariant program emits the fixed stage\'s position lines', ()=>{
    // GL_ARB_vertex_program's OPTION ARB_position_invariant promises the fixed
    // pipeline's position; a depth-equal pass over a fixed-function pre-pass
    // only survives if the emitted arithmetic is the same expression.
    const parsed = parseProgram('!!ARBvp1.0\nOPTION ARB_position_invariant;\n'
        + 'MOV result.color, vertex.color;\nEND\n');
    assert.ok(!('error' in parsed), 'error' in parsed ? parsed.error.message : '');
    const emitted = emitVertex(parsed,
        [{ name: 'position', components: 3, scalar: 'f32' }],
        { texcoords: [], fogCoord: false });
    assert.ok(!('error' in emitted), 'error' in emitted ? emitted.error : '');
    const fixed = generateDraw(state({
        attributes: [{ name: 'position', components: 3, scalar: 'f32', slot: 0,
            offset: 0, format: 'float32x3' }],
        strides: [12],
    })).code;
    const remap = '    out.position = vec4f(clip.x, clip.y,'
        + ' (clip.z * uniforms.misc.y + clip.w) * 0.5, clip.w);';
    assert.ok(fixed.includes(remap), 'the fixed stage remaps the depth the way GL does');
    assert.ok(emitted.code.includes(remap), 'the invariant position is the fixed one');
    assert.ok(emitted.code.includes(
        '    let clip = uniforms.modelViewProjection * vec4f(vertex.position, 1.0);'));
    assert.ok(fixed.includes('let objectPosition = vec4f(vertex.position, 1.0);')
        && fixed.includes('let clip = uniforms.modelViewProjection * objectPosition;'),
    'the same widening and the same product, under another local\'s name');
});

test('the position both vertex stages write is @invariant', ()=>{
    // WGSL promises two entry points the same position from the same data and
    // control flow only under @invariant, so without it the position-invariant
    // option's promise -- the fixed pipeline's position -- need not hold on the
    // device, and a depth-equal pass over a fixed pre-pass can fight it.
    const parsed = parseProgram('!!ARBvp1.0\nOPTION ARB_position_invariant;\n'
        + 'MOV result.color, vertex.color;\nEND\n');
    assert.ok(!('error' in parsed), 'error' in parsed ? parsed.error.message : '');
    const emitted = emitVertex(parsed,
        [{ name: 'position', components: 3, scalar: 'f32' }],
        { texcoords: [], fogCoord: false });
    assert.ok(!('error' in emitted), 'error' in emitted ? emitted.error : '');
    assert.match(emitted.code, /@builtin\(position\) @invariant position: vec4f,/);
    const fixed = generateDraw(state()).code;
    assert.match(fixed, /@builtin\(position\) @invariant position: vec4f,/);
});

test('a depth test that is off is always-passing, with the attachment kept', ()=>{
    const descriptor = drawDescriptor(
        state({ depth: { test: false, func: GL.LESS, write: true } }));
    assert.equal(descriptor.depthStencil.depthCompare, 'always');
    assert.equal(descriptor.depthStencil.format, 'depth24plus-stencil8');
    assert.equal(descriptor.depthStencil.stencilWriteMask, 0, 'no stencil test writes nothing');
});

test('a blend factor GL has and WebGPU lacks is refused by name', ()=>{
    assert.throws(()=>drawDescriptor(state({ blend: { src: 0x9999, dst: GL.ONE } })),
        /Unsupported source blend: 0x9999/);
});

test('a clear is a triangle over the target under the masks it was asked with', ()=>{
    const cleared = { targetFormat: 'bgra8unorm', depthFormat: 'depth24plus-stencil8',
        colourMask: 0x7, depth: true, stencilMask: 0xff };
    const descriptor = clearDescriptor(cleared);
    assert.equal(descriptor.target.writeMask, 0x7);
    assert.equal(descriptor.depthStencil.depthCompare, 'always');
    assert.equal(descriptor.depthStencil.depthWriteEnabled, true);
    assert.equal(descriptor.depthStencil.stencilFront.passOp, 'replace');
    assert.equal(descriptor.depthStencil.stencilWriteMask, 0xff);
    assert.notEqual(clearKey(cleared), clearKey({ ...cleared, depth: false }));
    assert.notEqual(clearKey(cleared), clearKey({ ...cleared, stencilMask: 0 }));
    assert.notEqual(clearKey(cleared), clearKey({ ...cleared, colourMask: 0 }));
    const { code } = generateClear();
    assert.match(code, /return vec4f\(x, y, uniforms\.depth\.x, 1\.0\)/);
    const untouched = clearDescriptor({ ...cleared, stencilMask: 0 });
    assert.equal(untouched.depthStencil.stencilFront.passOp, 'keep');
});

test('the shown copy is opaque and reads the back buffer top row first', ()=>{
    const { code } = generateShow();
    assert.match(code,
        /return vec4f\(textureSample\(sourceTexture, sourceSampler, input\.uv\)\.rgb, 1\.0\)/);
    assert.match(code, /out\.uv = vec2f\(\(x \+ 1\.0\) \* 0\.5, \(1\.0 - y\) \* 0\.5\)/);
    assert.equal(showDescriptor('bgra8unorm').depthStencil, undefined);
});

test('the copy key folds its target format, and the shader reads the source flipped', ()=>{
    assert.notEqual(copyKey('rgba8unorm'), copyKey('bgra8unorm'),
        'a copy into another format is another pipeline');
    const { code } = generateCopy();
    // GL counts framebuffer rows from the bottom and texture rows from the
    // first one given, so the source is sampled with v measured from the top.
    assert.match(code, /let u = \(uniforms\.rect\.x \+ k\.x\) \/ uniforms\.size\.x/);
    assert.match(code,
        /let v = \(uniforms\.size\.y - uniforms\.rect\.y - k\.y\) \/ uniforms\.size\.y/);
});

/**
 * A bound, loaded program, as the scene hands it to the draw state.
 *
 * @param {string} text
 * @param {number} [version]
 */
function program(text, version = 1){
    const parsed = parseProgram(text);
    assert.ok(!('error' in parsed), 'error' in parsed ? parsed.error.message : '');
    return {
        name: 1, version, text, ir: parsed, local: new Float32Array(4), localVersion: 0,
        env: new Float32Array(4), envVersion: 0,
    };
}

test('a program stage replaces the fixed stage it is bound for', ()=>{
    const vertex = program('!!ARBvp1.0\nMOV result.position, vertex.position;\n'
        + 'MOV result.color, vertex.color;\nEND\n');
    const both = state({ vertexProgram: vertex, fragmentProgram: program(
        '!!ARBfp1.0\nMOV result.color, fragment.color;\nEND\n') });
    const generated = generateDraw(both);
    assert.equal(generated.programs?.error, null);
    assert.match(generated.code, /fn vertexMain\(vertex: VertexIn\) -> VertexOut/);
    assert.match(generated.code, /struct VertexProgramUniforms/);
    assert.match(generated.code, /struct FragmentProgramUniforms/);
    assert.match(generated.code, /var finalColor = clamp\(resultColor/,
        'the fragment stage is the emitted one');
    assert.ok(generated.programs?.vertex && generated.programs?.fragment);

    // The mixed pair: the emitted vertex feeds the fixed fragment through the
    // shared varyings, and the fixed fragment is the one the key already ran.
    const mixed = generateDraw(state({ vertexProgram: vertex }));
    assert.equal(mixed.programs?.fragment, null);
    assert.match(mixed.code, /let primary = clamp\(input\.color/,
        'the fixed fragment still runs');
    assert.match(mixed.code, /fn vertexMain\(vertex: VertexIn\) -> VertexOut/);

    const reverse = generateDraw(state({ fragmentProgram: both.fragmentProgram }));
    assert.equal(reverse.programs?.vertex, null);
    assert.match(reverse.code, /out\.fog = 1\.0;/, 'the fixed vertex still runs');
    assert.match(reverse.code, /@location\(11\) fogCoord: f32,/,
        'and carries the raw fog coordinate the program may read, past the eight sets');

    // The key names the programs, and a new version is a new key.
    assert.notEqual(drawKey(both), drawKey(state()));
    assert.notEqual(drawKey(both), drawKey(state({ vertexProgram: vertex })));
    assert.notEqual(drawKey(both),
        drawKey({ ...both, vertexProgram: { ...vertex, version: 2 } }),
    );
});

test('a program reading fragment.position is emitted against the target height', ()=>{
    // GL's fragment.position runs from the window's lower-left corner and
    // WGSL's @builtin(position) from the upper-left, so the emitted stage
    // needs the render target's rows, and a new height is a new pipeline.
    const positional = program('!!ARBfp1.0\nTEMP R0;\n'
        + 'MUL R0, fragment.position, program.env[1];\nMOV result.color, R0;\nEND\n');
    const tall = generateDraw(state({ fragmentProgram: positional, viewportHeight: 720 }));
    const short = generateDraw(state({ fragmentProgram: positional, viewportHeight: 480 }));
    assert.match(tall.code, /input\.position\.x, 720\.0 - input\.position\.y/);
    assert.match(short.code, /input\.position\.x, 480\.0 - input\.position\.y/);
    assert.notEqual(drawKey(state({ fragmentProgram: positional, viewportHeight: 720 })),
        drawKey(state({ fragmentProgram: positional, viewportHeight: 480 })),
        'a different target height is a different pipeline');
});

test('a binding the GPU path cannot answer refuses the module by name', ()=>{
    const generated = generateDraw(state({ vertexProgram: program(
        '!!ARBvp1.0\nPARAM m = state.material.ambient;\nMOV result.position, m;\nEND\n') }));
    assert.equal(generated.code, '');
    assert.match(/** @type {string} */ (generated.programs?.error), /state\.material\.ambient/);
});
