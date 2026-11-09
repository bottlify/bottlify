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
    hsControlPointPhase, hsDecls, mov, o, quadDomainShader, quadHullShader, ret,
    triangleGeometryShader, vicp, vPoint,
} from './shader-fixtures.js';
import {
    DOMAIN_POSITION_BINDING, NO_PIXEL_SHADER, geometryStage, linkDomain, linkDomainPositions,
    linkGeometry, linkHull, translateShader, vertexFetch,
} from './wgsl.js';
import { PULLED_VERTEX_FORMAT, VERTEX_FORMAT, VERTEX_FORMAT_BYTES } from './gpuformats.js';

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

test('the patch constants are as many registers as the phases write, whatever the signature'
    + ' names, and a PSG1 names them as a PCSG does', ()=>{
    const unsigned = /** @type {any} */ (parseDxbc(forkPhaseHullShader()));
    unsigned.chunks.delete('PCSG');
    const linked = linkHull(unsigned);
    assert.equal(linked.stage.constantRegisters, 7, 'o6 is the last a fork phase writes');
    assert.match(linked.code, /var<private> pc: array<vec4<u32>, 7>;/);

    // One row a 32-byte PSG1 element: stream, name, index, system value,
    // component type, register, mask, minimum precision; the name after.
    const chunk = new Uint8Array(8 + 32 + 16);
    const words = new DataView(chunk.buffer);
    [1, 8].forEach((value, at)=>words.setUint32(at * 4, value, true));
    [0, 40, 3, SYSTEM_VALUE.QUAD_EDGE_TESSFACTOR, 3, 3, 1, 0]
        .forEach((value, at)=>words.setUint32(8 + at * 4, value, true));
    chunk.set(new TextEncoder().encode('SV_TessFactor'), 40);
    const precise = /** @type {any} */ (parseDxbc(forkPhaseHullShader()));
    precise.chunks.delete('PCSG');
    precise.chunks.set('PSG1', chunk);
    assert.match(linkHull(precise).code,
        /vec4<f32>\(0\.0, 0\.0, 0\.0, bitcast<f32>\(pc\[3\]\.x\)\)/,
        'the fourth edge factor from the register the PSG1 names');
});

test('a vertex format is read as a vertex fetch reads it: each format\'s bytes, nothing else',
    ()=>{
        for (const format of new Set([...Object.values(VERTEX_FORMAT),
            ...Object.values(PULLED_VERTEX_FORMAT)]))
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

test('a domain shader run as compute for the stage after it reads an index the tessellator'
    + ' wrote as its draw does, stops at the indices written, and stores what the next stage reads'
    + ' at its registers', ()=>{
    const hull = /** @type {any} */ (parseDxbc(quadHullShader()));
    const ds = /** @type {any} */ (parseDxbc(quadDomainShader()));
    // The next stage reads the position at register 2.
    const inputs = [{ name: 'SV_POSITION', index: 0, systemValue: SYSTEM_VALUE.POSITION,
        register: 2, mask: 15, componentType: 3, readWriteMask: 15 }];
    const linked = linkDomainPositions(translateShader(ds), ds, hull, linkHull(hull).stage,
        /** @type {any} */ (inputs), 3);
    assert.deepEqual(linked.unsupported, []);
    assert.match(linked.code, /@compute @workgroup_size\(64\)\nfn domainPositions/);
    assert.match(linked.code, new RegExp(`@group\\(1\\) @binding\\(${
        DOMAIN_POSITION_BINDING.count}\\) var<storage, read> dsCount`));
    assert.match(linked.code, /if \(id\.x >= dsCount\[0\]\) \{ return; \}/);
    assert.match(linked.code, /let dsAt = dsUv\[dsOffsets\[dsPatch\]\.x \+ dsIndices\[dsVertex\]\];/,
        'the index read as the draw of the domain shader reads it');
    assert.match(linked.code, /next\[2\]\.x = o0\.x;/);
    assert.match(linked.code, /dsOut\[id\.x \* 3u \+ reg\] = next\[reg\];/);
});

test('a geometry shader after the tessellator stops at the primitives it wrote, and one with'
    + ' none before it reads no limit', ()=>{
    const container = /** @type {any} */ (parseDxbc(triangleGeometryShader()));
    const gs = translateShader(container);
    const stage = geometryStage(container, gs);
    const limited = linkGeometry(gs, stage, { limited: true }).code;
    assert.match(limited, /var<storage, read> gsLimit: array<u32>;/);
    assert.match(limited, /let gsHeld = select\(gsLimit\[0\] \/ 3u, max\(gsLimit\[0\], 2u\) - 2u, gsStripped\);/);
    assert.match(limited, /if \(gsPrim >= gsHeld\) \{ gsWhole = false; \}/);
    assert.doesNotMatch(limited, /gsLimit\[1\]/, 'the instances are the draw\'s');
    // The counts are written all the same: an invocation past them counts nothing.
    assert.match(limited, /gsCounts\[id\.x \* 2u\] = gsMade;/);
    assert.doesNotMatch(linkGeometry(gs, stage).code, /gsLimit/);
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
