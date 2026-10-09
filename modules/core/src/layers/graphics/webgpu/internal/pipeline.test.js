/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Everything here is computed by the engine, so everything here is asserted
 * exactly: the same state produces the same key and the same descriptor, on
 * every run and every machine. Nothing in this file reaches a device.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    colorWriteMask, createPipelineCache, pipelineDescriptor, pipelineKey,
} from './pipeline.js';

/** A state with every field set, so a test can change exactly one. */
const baseState = ()=>({
    fvf: 0x142,
    vertexShader: 0,
    pixelShader: 0,
    targetFormat: 'bgra8unorm',
    depthFormat: 'depth24plus',
    sampleCount: 1,
    topology: 'triangle-list',
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
    fogMode: 0,
    stages: [],
    specularEnable: false,
    lighting: null,
});

/** @param {object} over */
const lighting = (over = {})=>({
    lights: [3],
    colorVertex: true,
    diffuseSource: 1,
    ambientSource: 0,
    specularSource: 2,
    emissiveSource: 0,
    ...over,
});

const stage = (over = {})=>({
    colorOp: 4, colorArg1: 2, colorArg2: 0,
    alphaOp: 4, alphaArg1: 2, alphaArg2: 0,
    texCoordIndex: 0,
    ...over,
});

test('every field the descriptor reads is a field the key folds', ()=>{
    // The defect this guards is silent: a key that folds less than the pipeline
    // depends on hands two different draws one pipeline, and the second renders
    // with the first one's state. So changing any single field must change the
    // key — if one does not, that field is invisible to the cache.
    const base = baseState();
    const changes = {
        fvf: 0x144,
        vertexShader: 3,
        pixelShader: 5,
        targetFormat: 'rgba8unorm',
        depthFormat: 'depth32float',
        sampleCount: 4,
        topology: 'triangle-strip',
        depthTest: false,
        depthWrite: false,
        depthFunc: 8,
        cullMode: 1,
        blend: true,
        srcBlend: 2,
        destBlend: 1,
        blendOp: 2,
        colorWrite: 0x7,
        alphaTest: true,
        alphaFunc: 8,
        fogMode: 3,
        fogSource: 1,
        specularEnable: true,
        normalizeNormals: true,
        rangeFog: true,
    };

    const original = pipelineKey(base);
    for (const [field, value] of Object.entries(changes))
    {
        const changed = pipelineKey({ ...base, [field]: value });
        assert.notEqual(changed, original, `changing ${field} left the key alone`);
    }
});

test('a layout over several streams is one vertex buffer per stream, in stream order', ()=>{
    // Direct3D binds up to sixteen streams and a declaration reads each
    // member from its own; WebGPU's vertex buffers are the same idea, one slot
    // per stream the layout reads, stream zero first.
    const descriptor = pipelineDescriptor(/** @type {any} */ (baseState()), {
        stride: 16,
        attributes: [
            { name: 'position', shaderLocation: 0, offset: 0, format: 'float32x3' },
            { name: 'diffuse', shaderLocation: 1, offset: 4, format: 'unorm8x4', stream: 3 },
            { name: 'specular', shaderLocation: 2, offset: 0, format: 'unorm8x4', stream: 1 },
        ],
        streams: [{ stream: 1, stride: 0 }, { stream: 3, stride: 8 }],
        preTransformed: false,
        texCoordSets: 0,
        blendWeights: 0,
    });
    assert.deepEqual(descriptor.vertexBuffers, [
        { arrayStride: 16, stepMode: 'vertex',
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        { arrayStride: 0, stepMode: 'vertex',
            attributes: [{ shaderLocation: 2, offset: 0, format: 'unorm8x4' }] },
        { arrayStride: 8, stepMode: 'vertex',
            attributes: [{ shaderLocation: 1, offset: 4, format: 'unorm8x4' }] },
    ]);
    assert.deepEqual(descriptor.vertexLayout, descriptor.vertexBuffers[0]);
});

test('the same state gives the same key, every time', ()=>{
    assert.equal(pipelineKey(baseState()), pipelineKey(baseState()));
    // Exact, because a key is compared by value and a diagnostic prints it.
    assert.equal(
        pipelineKey(baseState()),
        '322|0|0|bgra8unorm|depth24plus|1|triangle-list|1|1|4|3|0|5|6|1|-|15|0|5|0/0|0[]|0|-',
    );
});

test('a stage list is folded stage by stage, and its length is part of the key', ()=>{
    // The cascade at stage one selects a different fragment formula and a
    // different coordinate set. A key built from stage zero and a count
    // collides across draws that differ in both.
    const base = baseState();
    const one = pipelineKey({ ...base, stages: [stage()] });
    const differentSecond = pipelineKey({ ...base, stages: [stage(), stage({ colorOp: 7 })] });
    const differentCoords = pipelineKey(
        { ...base, stages: [stage(), stage({ texCoordIndex: 1 })] });
    const sameFirst = pipelineKey({ ...base, stages: [stage(), stage()] });

    assert.notEqual(one, sameFirst, 'a second stage is not the same as one stage');
    assert.notEqual(sameFirst, differentSecond, 'stage one\'s operation is folded');
    assert.notEqual(sameFirst, differentCoords, 'stage one\'s coordinate index is folded');
    assert.notEqual(pipelineKey({ ...base, stages: [stage({ colorKey: 0xff })] }), one,
        'a colour key is folded');
    assert.notEqual(pipelineKey({ ...base, stages: [stage({ colorKey: 0xff })] }),
        pipelineKey({ ...base, stages: [stage({ colorKey: 0xfe })] }), 'and which key it is');
});

test('every part of the lighting state that shapes the shader is folded', ()=>{
    // The vertex stage is unrolled per light, so two draws that differ in how
    // many lights they have, or in what kind one of them is, need different
    // pipelines. Sharing one would light the second draw with the first one's
    // equation -- and the picture that produces is plausible, not broken.
    const base = baseState();
    const original = pipelineKey({ ...base, lighting: lighting() });

    assert.notEqual(pipelineKey(base), original, 'lit and unlit are different keys');
    for (const over of [
        { lights: [] },
        { lights: [1] },
        { lights: [3, 3] },
        { colorVertex: false },
        { diffuseSource: 0 },
        { ambientSource: 1 },
        { specularSource: 0 },
        { emissiveSource: 2 },
    ])
    {
        assert.notEqual(pipelineKey({ ...base, lighting: lighting(over) }), original,
            `${Object.keys(over)[0]} left the key alone`);
    }
    // A light's own numbers are uniforms, so a light that only moved must not
    // build a second pipeline.
    assert.equal(pipelineKey({ ...base, lighting: lighting() }), original);
});

test('no stages and one default stage are different keys', ()=>{
    // The cascade is off until a stage arms it, so "off" has to be expressible
    // as something other than stage zero's value. Without the length prefix an
    // empty list and a list of one flatten to the same string.
    const base = baseState();
    assert.notEqual(
        pipelineKey({ ...base, stages: [] }),
        pipelineKey({ ...base, stages: [stage()] }),
    );
});

test('a depth test that is off keeps its attachment and always passes', ()=>{
    // Dropping the attachment instead would take the depth target away from
    // every later draw in the pass, which does want to test against it.
    const descriptor = pipelineDescriptor({ ...baseState(), depthTest: false }, null);
    assert.equal(descriptor.depthStencil.format, 'depth24plus');
    assert.equal(descriptor.depthStencil.depthCompare, 'always');
    assert.equal(descriptor.depthStencil.depthWriteEnabled, true);
});

test('cull mode names the face, not the winding', ()=>{
    // Direct3D names the winding it discards; WebGPU names the face it culls.
    // Getting it backwards turns models inside out, which reads as geometry
    // vanishing when the camera moves.
    const cull = (/** @type {number} */ mode)=>
        pipelineDescriptor({ ...baseState(), cullMode: mode }, null).primitive.cullMode;

    assert.equal(pipelineDescriptor(baseState(), null).primitive.frontFace, 'ccw');
    assert.equal(cull(1), 'none');
    assert.equal(cull(2), 'back', 'D3DCULL_CW discards clockwise, which is the back face here');
    assert.equal(cull(3), 'front', 'and D3DCULL_CCW discards the front one');
});

test('a separate alpha blend is folded into the key and blends alpha on its own', ()=>{
    // D3DRS_SEPARATEALPHABLENDENABLE: colour keeps SRCBLEND/DESTBLEND/BLENDOP
    // and alpha takes SRCBLENDALPHA/DESTBLENDALPHA/BLENDOPALPHA.
    const separate = { ...baseState(), blend: true, srcBlendAlpha: 2, destBlendAlpha: 1,
        blendOpAlpha: 1 };
    const key = pipelineKey(separate);
    assert.notEqual(key, pipelineKey({ ...separate, srcBlendAlpha: undefined,
        destBlendAlpha: undefined, blendOpAlpha: undefined }));
    for (const [field, value] of [['srcBlendAlpha', 5], ['destBlendAlpha', 2],
        ['blendOpAlpha', 2]])
    {
        assert.notEqual(pipelineKey({ ...separate, [field]: value }), key,
            `changing ${field} left the key alone`);
    }

    const blend = pipelineDescriptor(separate, null).target.blend;
    assert.deepEqual(blend?.color, { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha',
        operation: 'add' });
    assert.deepEqual(blend?.alpha, { srcFactor: 'one', dstFactor: 'zero', operation: 'add' });

    const shared = pipelineDescriptor({ ...baseState(), blend: true }, null)
        .target.blend;
    assert.deepEqual(shared?.alpha, shared?.color, 'without it alpha blends as colour does');
});

test('a blend factor with no counterpart is refused, not approximated', ()=>{
    // BOTHSRCALPHA sets the source and destination factor from one value: it is
    // a pair, not a factor. Approximating it draws a wrong picture silently.
    assert.throws(
        ()=>pipelineDescriptor({ ...baseState(), blend: true, srcBlend: 12 }, null),
        /Unsupported source blend: 12/,
    );
});

test('the colour write mask carries each channel through', ()=>{
    assert.equal(colorWriteMask(0), 0);
    assert.equal(colorWriteMask(0xf), 0xf);
    assert.equal(colorWriteMask(0x5), 0x5);
});

test('a pipeline in flight is shared, not built twice', async()=>{
    // Two draws with the same state in one frame must compile one shader. The
    // cache has to hold the promise, not only the finished pipeline, or the
    // second draw starts a second build before the first resolves.
    let builds = 0;
    const cache = createPipelineCache({
        build: async()=>{
            builds++;
            await Promise.resolve();
            return { id: builds };
        },
    });

    const [first, second] = await Promise.all([
        cache.get(baseState()),
        cache.get(baseState()),
    ]);

    assert.equal(builds, 1);
    assert.equal(first, second);
    assert.deepEqual(cache.stats(), { built: 1, reused: 1, resident: 1 });
});

test('a point list is drawn as quads: triangles, never culled, a point an instance', ()=>{
    // WebGPU draws a point a pixel wide; Direct3D draws it at its size.
    const layout = {
        stride: 12,
        attributes: [{ name: 'position', shaderLocation: 0, offset: 0, format: 'float32x3' }],
        preTransformed: false,
        texCoordSets: 0,
        blendWeights: 0,
    };
    const points = pipelineDescriptor(/** @type {any} */ ({
        ...baseState(), topology: 'point-list', points: { sprite: false, scale: false },
    }), layout);
    assert.equal(points.primitive.topology, 'triangle-list');
    assert.equal(points.primitive.cullMode, 'none');
    assert.equal(points.vertexBuffers[0].stepMode, 'instance');
    const pixels = pipelineDescriptor(
        /** @type {any} */ ({ ...baseState(), topology: 'point-list' }), layout);
    assert.equal(pixels.primitive.topology, 'point-list', 'a triangle filled as points is not one');
    const keyed = (/** @type {boolean} */ sprite)=>pipelineKey(
        /** @type {any} */ ({ ...baseState(), points: { sprite, scale: false } }));
    assert.notEqual(keyed(true), keyed(false));
});
