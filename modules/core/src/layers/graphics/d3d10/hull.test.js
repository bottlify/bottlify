/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHADER_KIND, SYSTEM_VALUE, parseDxbc } from './dxbc.js';
import {
    assemble, dclInputControlPointCount, dclOutput, dclOutputControlPointCount, dclTessDomain,
    dclTessOutputPrimitive, dclTessPartitioning, dclOutputSiv, forkPhaseHullShader,
    hsControlPointPhase, hsDecls, mov, o, quadHullShader, ret, vicp, vPoint,
} from './shader-fixtures.js';
import {
    NO_PIXEL_SHADER, linkDomain, linkHull, translateShader, vertexFetch,
} from './wgsl.js';
import { VERTEX_FORMAT, VERTEX_FORMAT_BYTES } from './gpuformats.js';

test('a hull shader links as one compute program: each phase a function, the stage read from'
    + ' its declarations', ()=>{
    const linked = linkHull(/** @type {any} */ (parseDxbc(forkPhaseHullShader())));
    assert.deepEqual(linked.unsupported, []);
    assert.deepEqual(linked.stage, { domain: 'quad', partitioning: 0, output: 2, inputPoints: 1,
        outputPoints: 4, inputRegisters: 1, outputRegisters: 1, constantRegisters: 7 });
    for (const phase of [0, 1, 2, 3])
    {
        assert.match(linked.code, new RegExp(`fn hsPhase${phase}\\(\\)`));
    }
    assert.match(linked.code, /const icb_p0 = array/, 'the control point phase\'s constants');
    assert.match(linked.code, /pc\[r0\.xxxx\.x\]\.x = /, 'a fork instance writes through r0');
    assert.match(linked.code, /pc\[\(4u \+ r0\.xxxx\.x\)\]\.x = /, 'past the edges');
    assert.match(linked.code, /for \(var i = 0u; i < 4u; i\+\+\) \{\n\s+hsInstance = i;/);
    assert.match(linked.code, /vec4<f32>\(bitcast<f32>\(pc\[0\]\.x\), bitcast<f32>\(pc\[1\]\.x\)/,
        'the edge factors from the patch constants the signature names');
});

test('a vertex format is read as a vertex fetch reads it: each format\'s bytes, nothing else',
    ()=>{
        for (const format of new Set(Object.values(VERTEX_FORMAT)))
        {
            const fetch = vertexFetch(format);
            assert.ok(fetch, format);
            assert.equal(fetch.bytes, VERTEX_FORMAT_BYTES[format], format);
            const words = ['w0', 'w1', 'w2', 'w3'];
            assert.match(fetch.register(words), /^vec4<u32>\(/, format);
        }
        assert.equal(vertexFetch('float64'), null);
        assert.match(/** @type {any} */ (vertexFetch('unorm8x4-bgra')).register(['w']),
            /^vec4<u32>\(bitcast<u32>\(f32\(extractBits\(w, 16u, 8u\)\)/,
            'blue comes first out of a BGRA word');
    });

test('a domain shader reads each control point and patch constant by its name, wherever the'
    + ' hull shader put it', ()=>{
    const hull = /** @type {any} */ (parseDxbc(quadHullShader()));
    const linkedHull = linkHull(hull);
    // The same names at other registers and components than the hull wrote them.
    const ds = /** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.DOMAIN,
        major: 5,
        inputs: [{ name: 'SV_Position', systemValue: SYSTEM_VALUE.POSITION, register: 2 }],
        patchConstants: [{ name: 'SV_TessFactor', index: 1,
            systemValue: SYSTEM_VALUE.QUAD_EDGE_TESSFACTOR, register: 0, mask: 4 }],
        outputs: [{ name: 'SV_POSITION', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        instructions: [dclOutputSiv(o(0), SYSTEM_VALUE.POSITION), mov(o(0), vicp(3, 2)),
            ret()],
    })));
    const linked = linkDomain(translateShader(ds), ds, NO_PIXEL_SHADER, hull,
        linkedHull.stage);
    assert.deepEqual(linked.unsupported, []);
    assert.match(linked.vertex,
        /vicp\[cp\]\[2\]\.x = dsPoints\[\(dsPatch \* 4u \+ cp\) \* 1u \+ 0u\]\.x;/);
    assert.match(linked.vertex, /vpc\[0\]\.z = dsConstants\[dsPatch \* 6u \+ 1u\]\.x;/,
        'the second edge factor, from the hull\'s register 1 .x into the domain\'s register 0 .z');
    assert.match(linked.vertex, /var<private> vicp: array<array<vec4<u32>, 3>, 4>;/);
});

test('a control point phase reads its input points as v[point][register]'
    + ' (test_clip_distance, d3d11.c:29959)', ()=>{
    const linked = linkHull(/** @type {any} */ (parseDxbc(assemble({
        kind: SHADER_KIND.HULL,
        major: 5,
        inputs: [{ name: 'SV_Position', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        outputs: [{ name: 'SV_Position', systemValue: SYSTEM_VALUE.POSITION, register: 0 }],
        instructions: [hsDecls(), dclInputControlPointCount(4), dclOutputControlPointCount(4),
            dclTessDomain(3), dclTessPartitioning(1), dclTessOutputPrimitive(3),
            hsControlPointPhase(), dclOutput(o(0)), mov(o(0), vPoint(2, 0)), ret()],
    }))));
    assert.match(linked.code, /cpo\[0u?\] = vicp\[2u?\]\[0u?\]\.xyzw;/);
    assert.doesNotMatch(linked.code, /= v0\./);
});
