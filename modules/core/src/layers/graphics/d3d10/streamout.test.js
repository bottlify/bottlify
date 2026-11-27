/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The declarations Wine's test_stream_output and test_fl10_stream_output_desc
 * hand CreateGeometryShaderWithStreamOutput, and what Windows answers them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SO_NO_RASTERIZED_STREAM, validStreamOutput } from './streamout.js';

/** The shaders' outputs: a position and four attributes of four to one components. */
const OUTPUTS = [
    ['SV_Position', 0, 0xf], ['ATTRIB', 1, 0xf], ['attrib', 2, 0x7], ['ATTriB', 3, 0x3],
    ['ATTRIB', 4, 0x1],
].map(([name, index, mask], register)=>({ name: String(name), index: Number(index),
    mask: Number(mask), register, systemValue: 0, componentType: 3, readWriteMask: 0 }));

/** @param {[number, string | null, number, number, number, number][]} rows */
const entries = rows=>rows.map(([Stream, SemanticName, SemanticIndex, StartComponent,
    ComponentCount, OutputSlot])=>({ Stream, SemanticName, SemanticIndex, StartComponent,
    ComponentCount, OutputSlot }));

/**
 * @param {any} declared @param {number[] | null} strides @param {number} rasterizedStream
 * @param {{ eleven?: boolean, vertex?: boolean, oneStride?: boolean }} [options]
 */
const valid = (declared, strides, rasterizedStream, options = {})=>validStreamOutput({
    outputs: OUTPUTS, entries: declared, strides, rasterizedStream,
    eleven: options.eleven ?? true, vertex: options.vertex ?? false,
    oneStride: options.oneStride ?? false,
});

const POSITION = entries([[0, 'SV_Position', 0, 0, 4, 0]]);
const STRIDES = [64, 64, 64, 64];
const NONE = SO_NO_RASTERIZED_STREAM;

const VALID_11 = [
    [[0, 'sv_position', 0, 0, 4, 0], [0, 'attrib', 1, 0, 4, 0]],
    [[0, 'SV_POSITION', 0, 0, 4, 0], [0, null, 0, 0, 8, 0], [0, 'ATTRIB', 1, 0, 4, 0]],
    [[0, 'SV_POSITION', 0, 0, 4, 0], [0, null, 0, 0, 4, 0], [0, null, 0, 0, 4, 0],
        [0, 'ATTRIB', 1, 0, 4, 0]],
    [[0, 'ATTRIB', 2, 0, 3, 0]], [[0, 'ATTRIB', 4, 0, 1, 0]],
    [[0, 'ATTRIB', 1, 3, 1, 0]], [[0, 'ATTRIB', 3, 1, 1, 0]],
    [[0, 'attrib', 1, 0, 4, 3]],
    [[0, 'attrib', 1, 0, 4, 0], [0, 'attrib', 2, 0, 3, 1], [0, null, 0, 0, 1, 1],
        [0, 'attrib', 3, 0, 2, 2], [0, null, 0, 0, 2, 2], [0, 'attrib', 4, 0, 1, 3],
        [0, null, 0, 0, 7, 3]],
    [[0, 'attrib', 1, 0, 4, 0], [0, 'attrib', 2, 0, 3, 0], [0, 'attrib', 3, 0, 2, 3],
        [0, null, 0, 0, 1, 3], [0, 'attrib', 4, 0, 1, 3]],
    [[0, 'ATTRIB', 1, 0, 2, 0], [0, 'ATTRIB', 1, 2, 2, 1]],
    [[0, 'ATTRIB', 1, 0, 1, 0], [0, 'ATTRIB', 1, 1, 3, 0]],
];

const INVALID_11 = [
    [[0, 'SV_Position', 0, 0, 4, 0], [0, 'ATTRIB', 0, 0, 4, 0]],
    [[0, 'sv_position', 0, 0, 4, 0], [0, 'ATTRIB_', 1, 0, 4, 0]],
    [[0, 'SV_POSITION', 0, 0, 4, 0], [0, null, 0, 1, 8, 0], [0, 'ATTRIB', 1, 0, 4, 0]],
    [[0, 'SV_POSITION', 0, 0, 4, 0], [0, null, 1, 0, 8, 0], [0, 'ATTRIB', 1, 0, 4, 0]],
    [[0, 'SV_POSITION', 0, 0, 4, 0], [0, null, 0, 0, 8, 0], [0, null, 0, 0, 8, 0],
        [0, 'ATTRIB', 1, 0, 4, 0]],
    [[0, 'ATTRIB', 2, 0, 5, 0]], [[0, 'ATTRIB', 2, 0, 4, 0]], [[0, 'ATTRIB', 4, 0, 2, 0]],
    [[0, 'ATTRIB', 1, 1, 4, 0]], [[0, 'ATTRIB', 1, 4, 0, 0]], [[0, 'ATTRIB', 1, 4, 1, 0]],
    [[0, 'ATTRIB', 3, 2, 1, 0]], [[0, 'ATTRIB', 3, 2, 0, 0]],
    [[0, 'attrib', 1, 0, 4, 4]],
    [[0, 'attrib', 1, 0, 4, 0], [0, 'attrib', 2, 0, 3, 1], [0, null, 0, 0, 1, 1],
        [0, 'attrib', 3, 0, 2, 2], [0, null, 0, 0, 2, 2], [0, 'attrib', 4, 0, 1, 3],
        [0, null, 0, 0, 3, 4]],
    [[0, 'attrib', 1, 0, 4, 0], [0, 'attrib', 2, 0, 3, 0], [0, 'attrib', 3, 0, 2, 0],
        [0, null, 0, 0, 1, 0], [0, 'attrib', 4, 0, 1, 0], [0, null, 0, 0, 3, 3],
        [0, null, 0, 0, 1, 3]],
    [[0, 'attrib', 1, 0, 4, 0], [0, null, 0, 0, 3, 1], [0, null, 0, 0, 1, 1],
        [0, null, 0, 0, 1, 2], [0, 'attrib', 2, 0, 3, 3], [0, null, 0, 0, 1, 3]],
    [[1, 'attrib', 1, 0, 4, 0]], [[4, 'attrib', 1, 0, 4, 0]],
    [[0, 'ATTRIB', 1, 0, 4, 0], [0, 'ATTRIB', 1, 0, 4, 1]],
    [[0, 'ATTRIB', 1, 0, 4, 0], [0, 'ATTRIB', 1, 0, 3, 0]],
];

test('level 11: the declarations Windows takes and those it refuses', ()=>{
    assert.ok(valid(null, null, NONE));
    assert.ok(valid(null, [64], NONE));
    assert.ok(valid(POSITION, null, NONE, { vertex: true }));
    assert.ok(!valid([], [64], NONE), 'a declaration of no entries');
    assert.ok(!valid(null, null, NONE, { vertex: true }), 'a vertex shader streams something');
    assert.ok(!valid(entries([[0, 'SV_Position', 0, 0, 4, 0], [0, null, 0, 0, 0, 0]]), [64],
        NONE), 'a gap of nothing');
    for (const rows of VALID_11)
    {
        const declared = entries(/** @type {any} */ (rows));
        const slots = Math.max(...declared.map(entry=>entry.OutputSlot)) + 1;
        assert.ok(valid(declared, null, NONE), JSON.stringify(rows));
        assert.ok(valid(declared, STRIDES.slice(0, slots), NONE), JSON.stringify(rows));
    }
    for (const rows of INVALID_11)
    {
        for (const count of [1, 2, 3, 4])
        {
            assert.ok(!valid(entries(/** @type {any} */ (rows)), STRIDES.slice(0, count), NONE),
                `${JSON.stringify(rows)} with ${count} strides`);
        }
    }
    assert.ok(!valid(POSITION, [63], NONE));
    assert.ok(valid(POSITION, [64, 63], NONE), 'a buffer nothing goes to is not checked');
    assert.ok(valid(POSITION, [64, 1], NONE));
    assert.ok(!valid(POSITION, [0], NONE));
    for (const stream of [0, 1, 2, 3])
    {
        assert.ok(valid(POSITION, null, stream));
    }
    assert.ok(!valid(POSITION, null, 4));
});

test('level 10: one stride, stream 0 rasterized, and several buffers one output each', ()=>{
    const ten = { eleven: false };
    assert.ok(valid(null, null, 0, ten));
    assert.ok(!valid(null, [64], 0, ten));
    assert.ok(valid(POSITION, [64], 0, ten));
    for (const rows of [
        [[0, 'attrib', 1, 0, 4, 0], [0, 'attrib', 2, 0, 3, 1], [0, 'attrib', 3, 0, 2, 2],
            [0, 'attrib', 4, 0, 1, 3]],
        [[0, 'attrib', 1, 0, 4, 0], [0, 'attrib', 2, 0, 3, 0], [0, 'attrib', 3, 0, 2, 0],
            [0, null, 0, 0, 1, 0], [0, 'attrib', 4, 0, 1, 0]],
        [[0, 'ATTRIB', 1, 0, 2, 0], [0, 'ATTRIB', 1, 2, 2, 1]],
    ])
    {
        assert.ok(valid(entries(/** @type {any} */ (rows)), null, 0, ten), JSON.stringify(rows));
    }
    for (const rows of [
        [[0, 'attrib', 1, 0, 4, 0], [0, null, 0, 0, 4, 0], [0, 'attrib', 4, 0, 1, 3]],
        [[0, 'attrib', 1, 0, 4, 0], [0, 'attrib', 2, 0, 3, 0], [0, 'attrib', 3, 0, 2, 0],
            [0, 'attrib', 4, 0, 1, 1]],
        [[0, 'attrib', 1, 0, 4, 0], [0, 'attrib', 1, 0, 3, 1], [0, 'attrib', 1, 0, 2, 2],
            [0, 'attrib', 1, 0, 1, 3], [0, null, 0, 0, 3, 3]],
    ])
    {
        assert.ok(!valid(entries(/** @type {any} */ (rows)), [64], 0, ten), JSON.stringify(rows));
    }
    assert.ok(!valid(POSITION, [64, 63], 0, ten));
    assert.ok(!valid(POSITION, null, NONE, ten));
    assert.ok(!valid(POSITION, null, 1, ten));
});

test('Direct3D 10\'s one stride is slot zero\'s: given when only slot zero is written, zero'
    + ' when a later slot is (d3d10core.c test_stream_output)', ()=>{
    const ten = { eleven: false, oneStride: true };
    assert.ok(valid(null, null, 0, ten), 'nothing streamed out, no stride');
    assert.ok(!valid(null, [64], 0, ten));
    assert.ok(valid(POSITION, [64], 0, ten));
    assert.ok(!valid(POSITION, null, 0, ten), 'slot zero alone needs its stride');
    const later = entries([[0, 'attrib', 1, 0, 4, 2]]);
    assert.ok(valid(later, null, 0, ten), 'a later slot\'s buffer takes one element');
    assert.ok(!valid(later, [64], 0, ten));
    assert.ok(valid(later, null, 0, { eleven: false }), 'Direct3D 11 at level 10 is not');
    assert.ok(valid(POSITION, null, 0, { eleven: false }));
});

test('an entry\'s components count from its element\'s first: an element packed into .z has one'
    + ' (test_stream_output, d3d11.c:27043)', ()=>{
    const packed = OUTPUTS.map(output=>(output.index === 4 && output.name === 'ATTRIB'
        ? { ...output, register: 3, mask: 0x4 } : output));
    /** @param {any} declared */
    const answer = declared=>validStreamOutput({ outputs: packed, entries: declared,
        strides: STRIDES, rasterizedStream: NONE, eleven: true, vertex: false });
    assert.equal(answer(entries([[0, 'ATTRIB', 4, 0, 1, 0]])), true);
    assert.equal(answer(entries([[0, 'ATTRIB', 4, 0, 2, 0]])), false);
    assert.equal(answer(entries([[0, 'ATTRIB', 4, 1, 1, 0]])), false);
});
