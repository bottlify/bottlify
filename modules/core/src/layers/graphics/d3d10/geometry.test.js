/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SYSTEM_VALUE, parseDxbc } from './dxbc.js';
import { streamOutWrites } from './geometry.js';
import { geometryIndexWgsl, streamOutWgsl } from './geometry-wgsl.js';
import {
    geometryStage, linkGeometry, linkGeometryDraw, passThroughGeometry, translateShader,
} from './wgsl.js';
import {
    passThroughVertexShader, solidPixelShader, triangleGeometryShader,
} from './shader-fixtures.js';

/** @param {Uint8Array} bytes */
const parsed = bytes=>/** @type {any} */ (parseDxbc(bytes));

test('a geometry shader reads a vertex of its primitive at a time and emits into its stream'
    + ' (test_geometry_shader, d3d11.c:26198)', ()=>{
    const container = parsed(triangleGeometryShader());
    const gs = translateShader(container);
    assert.deepEqual(gs.unsupported, []);
    assert.equal(gs.inputRegisters, 1, 'v[3][0] is one register of three vertices');
    const body = gs.body.filter(line=>typeof line === 'string').join('\n');
    assert.match(body, /o0 = vgs\[0u\]\[0u\]/);
    assert.equal(body.match(/gsEmit\(0u\);/g)?.length, 3);
    assert.equal(body.match(/gsCut\(0u\);/g)?.length, 1);
    const stage = geometryStage(container, gs);
    assert.deepEqual({ ...stage }, { inputVertices: 3, outputVertices: 3, maxOut: 3,
        instances: 1, streams: [0], inputRegisters: 1, outputRegisters: 1 });
    const linked = linkGeometry(gs, stage);
    assert.deepEqual(linked.unsupported, []);
    assert.match(linked.code, /var<private> vgs: array<array<vec4<u32>, 1>, 3>;/);
    assert.match(linked.code, /fn geometryMain/);
    // An odd triangle of a strip arrives with its first two vertices swapped.
    assert.match(linked.code, /gsParams.topology == 5u/);
});

test('a vertex shader\'s bytecode made a geometry shader passes each primitive on, its vertices'
    + ' in order', ()=>{
    const vs = translateShader(parsed(passThroughVertexShader()));
    const { shader, stage } = passThroughGeometry(vs, 2);
    assert.equal(stage.inputVertices, 2);
    assert.equal(stage.outputVertices, 2);
    const body = shader.body.filter(line=>typeof line === 'string');
    assert.deepEqual(body, ['    o0 = vgs[0][0];', '    gsEmit(0u);', '    o0 = vgs[1][0];',
        '    gsEmit(0u);']);
});

test('what a geometry shader made is drawn by a vertex stage that reads its places', ()=>{
    const container = parsed(triangleGeometryShader());
    const gs = translateShader(container);
    const linked = linkGeometryDraw(gs, geometryStage(container, gs), 0,
        translateShader(parsed(solidPixelShader([1, 0, 0, 1]))));
    assert.deepEqual(linked.unsupported, []);
    assert.match(linked.vertex, /@builtin\(vertex_index\) gsVertex: u32/);
    assert.match(linked.vertex, /o0 = gsVertices\[gsVertex \* 1u \+ 0u\];/);
});

test('a strip is listed so that each triangle keeps its winding: an odd one\'s first two'
    + ' swapped', ()=>{
    const code = geometryIndexWgsl({ streams: 1, maxOut: 4, outputVertices: 3 });
    assert.match(code, /indices\[base \+ 0u\] = select\(at - 2u, at - 1u, odd\);/);
    assert.match(code, /indices\[base \+ 1u\] = select\(at - 1u, at - 2u, odd\);/);
    assert.match(code, /indices\[base \+ 2u\] = at;/);
});

test('a stream-output declaration is words of the registers its semantics are, its gaps'
    + ' skipped and each buffer\'s stride the words it writes unless given'
    + ' (test_stream_output_components, d3d11.c:27687)', ()=>{
    const position = { name: 'POSITION', index: 0, register: 0, mask: 0xf, stream: 0,
        systemValue: SYSTEM_VALUE.UNDEFINED };
    // COLOR2 packed into .zw of register 1.
    const colour = { name: 'COLOR', index: 2, register: 1, mask: 0xc, stream: 0,
        systemValue: SYSTEM_VALUE.UNDEFINED };
    const gs = { outputs: [position, colour] };
    const { writes, strides } = streamOutWrites(gs, [
        { Stream: 0, SemanticName: 'position', SemanticIndex: 0, StartComponent: 1,
            ComponentCount: 2, OutputSlot: 0 },
        { Stream: 0, SemanticName: null, SemanticIndex: 0, StartComponent: 0,
            ComponentCount: 1, OutputSlot: 0 },
        { Stream: 0, SemanticName: 'COLOR', SemanticIndex: 2, StartComponent: 1,
            ComponentCount: 1, OutputSlot: 0 },
        { Stream: 0, SemanticName: 'COLOR', SemanticIndex: 2, StartComponent: 0,
            ComponentCount: 2, OutputSlot: 1 },
    ], [0, 32]);
    assert.deepEqual(writes, [
        { slot: 0, stream: 0, words: [{ register: 0, component: 1, word: 0 },
            { register: 0, component: 2, word: 1 }, { register: 1, component: 3, word: 3 }] },
        { slot: 1, stream: 0, words: [{ register: 1, component: 2, word: 0 },
            { register: 1, component: 3, word: 1 }] },
    ]);
    assert.deepEqual(strides.slice(0, 2), [16, 32], 'slot 0 four words; slot 1 as given');
    const code = streamOutWgsl({ streams: [0], outputVertices: 3, outputRegisters: 2 }, writes);
    assert.match(code, /so0\[base \+ 3u\] = vertices\[v \* 2u \+ 1u\]\[3\];/);
    assert.match(code, /counters\[0u\] \+= fit0;/);
    assert.match(code, /counters\[1u\] \+= total0;/);
});
