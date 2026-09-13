/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GL } from './constants.js';
import {
    CANONICAL_LAYOUT, CANONICAL_STRIDE, expandIndices, expandMode, packVertices, planLayout,
    scanIndices, topologyOf, vertexFormatOf,
} from './gpu-layout.js';

/** @param {Partial<import('./arrays.js').ArrayPointer>} fields */
const pointer = fields=>({ size: 3, type: GL.FLOAT, stride: 0, pointer: 0, buffer: 0, ...fields });

test('an interleaved vertex in one buffer is one slot with an attribute per array', ()=>{
    // Three floats of position, two of texture coordinates, at a stride of 60
    // in buffer 7 -- the shape a vertex cache hands over.
    const layout = planLayout([
        { name: 'position', pointer: pointer({ stride: 60, pointer: 0x1950, buffer: 7 }),
            normalised: false },
        { name: 'texCoord0', pointer: pointer({ size: 2, stride: 60, pointer: 0x195c, buffer: 7 }),
            normalised: false },
    ]);
    assert.ok(layout);
    assert.deepEqual(layout.slots, [{ buffer: 7, base: 0x1950, stride: 60 }]);
    assert.deepEqual(layout.attributes.map(a=>[a.name, a.slot, a.offset, a.format]), [
        ['position', 0, 0, 'float32x3'],
        ['texCoord0', 0, 12, 'float32x2'],
    ]);
});

test('arrays in different buffers, or at different strides, take slots of their own', ()=>{
    const layout = planLayout([
        { name: 'position', pointer: pointer({ stride: 12, pointer: 0, buffer: 1 }),
            normalised: false },
        { name: 'color', pointer: pointer({ size: 4, type: GL.UNSIGNED_BYTE, stride: 4,
            pointer: 0, buffer: 2 }), normalised: true },
        { name: 'normal', pointer: pointer({ stride: 0, pointer: 4096, buffer: 0 }),
            normalised: true },
    ]);
    assert.ok(layout);
    assert.equal(layout.slots.length, 3);
    assert.equal(layout.attributes[1].format, 'unorm8x4');
    assert.equal(layout.slots[2].stride, 12, 'a stride of zero is the element\'s own size');
});

test('a pointer off a word boundary opens its slot at the word below it', ()=>{
    const layout = planLayout([
        { name: 'color', pointer: pointer({ size: 2, type: GL.UNSIGNED_BYTE, stride: 8,
            pointer: 2 }), normalised: true },
    ]);
    assert.ok(layout);
    assert.deepEqual(layout.slots, [{ buffer: 0, base: 0, stride: 8 }]);
    assert.equal(layout.attributes[0].offset, 2);
    assert.equal(layout.attributes[0].format, 'unorm8x2');
    // A four-byte format at that offset breaks the alignment rule and is refused.
    assert.equal(planLayout([
        { name: 'position', pointer: pointer({ size: 2, type: GL.SHORT, stride: 8, pointer: 2 }),
            normalised: false },
    ]), null);
});

test('an array the GPU has no format for refuses the whole layout', ()=>{
    for (const [type, size] of [[GL.DOUBLE, 3], [GL.SHORT, 3], [GL.BYTE, 3],
        [GL.UNSIGNED_BYTE, 3]])
    {
        assert.equal(vertexFormatOf(type, size, true), null);
        assert.equal(planLayout([
            { name: 'position', pointer: pointer({ type, size }), normalised: false },
        ]), null, `${type} x${size}`);
    }
    assert.equal(planLayout([
        { name: 'position', pointer: pointer({ stride: 14 }), normalised: false },
    ]), null, 'a stride that is not a whole number of words');
});

test('the canonical layout packs every attribute of a processor vertex', ()=>{
    const packed = packVertices([{
        position: [1, 2, 3],
        color: [0.5, 0.25, 1, 0.75],
        secondary: [0, 0, 0, 1],
        normal: [0, 0, 1],
        fogCoord: 7,
        texCoords: [[0.5, 0.5]],
    }]);
    assert.equal(packed.byteLength, CANONICAL_STRIDE);
    const at = (/** @type {string} */ name)=>{
        const attribute = CANONICAL_LAYOUT.attributes.find(a=>a.name === name);
        assert.ok(attribute);
        return attribute.offset / 4;
    };
    assert.deepEqual([...packed.subarray(at('position'), at('position') + 4)], [1, 2, 3, 1],
        'a three-component position is completed with w = 1');
    assert.deepEqual([...packed.subarray(at('color'), at('color') + 4)], [0.5, 0.25, 1, 0.75]);
    assert.equal(packed[at('fogCoord')], 7);
    assert.deepEqual([...packed.subarray(at('texCoord0'), at('texCoord0') + 4)],
        [0.5, 0.5, 0, 1], 'a two-component coordinate is completed with r = 0, q = 1');
    assert.deepEqual([...packed.subarray(at('texCoord1'), at('texCoord1') + 4)], [0, 0, 0, 1],
        'a set the vertex does not carry is the default coordinate');
});

test('modes without a topology of their own become lists, wound as the specification says', ()=>{
    assert.equal(expandMode(GL.TRIANGLES, 6), null);
    assert.deepEqual([...expandMode(GL.QUADS, 8) ?? []], [0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    assert.deepEqual([...expandMode(GL.TRIANGLE_STRIP, 4) ?? []], [0, 1, 2, 2, 1, 3],
        'every second triangle of a strip is turned to keep one facing');
    assert.deepEqual([...expandMode(GL.TRIANGLE_FAN, 4) ?? []], [0, 1, 2, 0, 2, 3]);
    assert.deepEqual([...expandMode(GL.QUAD_STRIP, 4) ?? []], [0, 1, 3, 0, 3, 2]);
    assert.deepEqual([...expandMode(GL.LINE_LOOP, 3) ?? []], [0, 1, 1, 2, 2, 0]);
    assert.equal(topologyOf(GL.LINE_LOOP), 'line-list');
    assert.equal(topologyOf(GL.QUADS), 'triangle-list');
    assert.equal(topologyOf(GL.POINTS), 'point-list');
});

test('an expanded mode goes through the program\'s own indices', ()=>{
    const expanded = expandIndices(GL.QUADS, Uint16Array.of(10, 11, 12, 13), 4);
    assert.deepEqual([...expanded ?? []], [10, 11, 12, 10, 12, 13]);
});

test('indices are scanned for their range and widened to a GPU format', ()=>{
    const bytes = Uint8Array.of(5, 200, 7);
    const scanned = scanIndices(bytes, GL.UNSIGNED_BYTE, 3);
    assert.equal(scanned.format, 'uint16');
    assert.deepEqual([...scanned.indices], [5, 200, 7]);
    assert.deepEqual([scanned.min, scanned.max], [5, 200]);

    const words = new Uint8Array(new Uint32Array([70000, 3]).buffer);
    const wide = scanIndices(words, GL.UNSIGNED_INT, 2);
    assert.equal(wide.format, 'uint32');
    assert.deepEqual([wide.min, wide.max], [3, 70000]);

    const shorts = new Uint8Array(new Uint16Array([9, 4]).buffer);
    const half = scanIndices(shorts, GL.UNSIGNED_SHORT, 2);
    assert.deepEqual([...half.indices], [9, 4]);
});
