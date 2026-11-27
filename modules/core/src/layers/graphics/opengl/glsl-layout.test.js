/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { basicTypeAt, arrayOf } from './glsl-types.js';
import { blockLayout, blockVariables, typeLayout } from './glsl-layout.js';

/** @param {string} name */
const t = name=>/** @type {import('./glsl-types.js').GlslType} */ (basicTypeAt(name, 460));

/**
 * @param {[string, import('./glsl-types.js').GlslType, object?][]} members
 * @param {'std140' | 'std430'} packing
 */
const lay = (members, packing)=>blockLayout(members.map(([name, type, more])=>({ name, type,
    ...more })), packing);

/** @param {ReturnType<typeof blockLayout>} block */
const offsets = block=>Object.fromEntries(block.members.map(m=>[m.name, m.offset]));

test('std140 aligns a vec3 to 16, lets a float follow it, and rounds arrays to a vec4', ()=>{
    // The specification's own worked example (section 7.6.2.2) begins so:
    // float a at 0, vec2 b at 8, vec3 c at 16, then a struct and arrays.
    const block = lay([['a', t('float')], ['b', t('vec2')], ['c', t('vec3')], ['d', t('float')],
        ['e', arrayOf(t('float'), 2)], ['f', t('mat3')], ['g', t('bool')]], 'std140');
    assert.deepEqual(offsets(block), { a: 0, b: 8, c: 16, d: 28, e: 32, f: 64, g: 112 });
    assert.equal(block.members[4].arrayStride, 16, 'rule 4: a float array strides a vec4');
    assert.equal(block.members[5].matrixStride, 16, 'rule 5: a mat3 is three vec4 columns');
    assert.equal(block.members[5].size, 48);
    assert.equal(block.size, 128, 'the block is padded to 16');
});

test('std430 does not round arrays and structures up to a vec4', ()=>{
    const block = lay([['a', t('float')], ['e', arrayOf(t('float'), 3)], ['v', t('vec3')],
        ['w', t('float')], ['m', t('mat2')]], 'std430');
    assert.deepEqual(offsets(block), { a: 0, e: 4, v: 16, w: 28, m: 32 });
    assert.equal(block.members[1].arrayStride, 4);
    assert.equal(block.members[4].matrixStride, 8, 'a mat2 is two vec2 columns of 8 bytes');
    assert.equal(block.size, 48);
    const vec3s = typeLayout(arrayOf(t('vec3'), 2), 'std430');
    assert.equal(vec3s.arrayStride, 16, 'a vec3 element still aligns to 16 (rule 3)');
});

test('a structure aligns to its widest member, rounded to 16 in std140 only', ()=>{
    const struct = /** @type {import('./glsl-types.js').StructType} */ ({ kind: 'struct',
        name: 'S', id: 1, fields: [{ name: 'x', type: t('float') },
            { name: 'y', type: t('vec2') }] });
    assert.deepEqual(typeLayout(struct, 'std140'), { align: 16, size: 16 });
    assert.deepEqual(typeLayout(struct, 'std430'), { align: 8, size: 16 });
    const block = lay([['f', t('float')], ['s', struct], ['g', t('float')]], 'std430');
    assert.deepEqual(offsets(block), { f: 0, s: 8, g: 24 });
    const variables = blockVariables(lay([['s', arrayOf(struct, 2)]], 'std140'), 'std140');
    assert.deepEqual(variables.map(v=>`${v.name}@${v.offset}`),
        ['s[0].x@0', 's[0].y@8', 's[1].x@16', 's[1].y@24']);
});

test('a row-major matrix is an array of its rows', ()=>{
    // mat2x3: two columns of three rows; row-major it is three rows of two.
    const block = lay([['m', t('mat2x3'), { rowMajor: true }], ['n', t('mat2x3')]], 'std140');
    assert.deepEqual(block.members.map(m=>[m.offset, m.size, m.matrixStride, m.rowMajor]),
        [[0, 48, 16, true], [48, 32, 16, false]]);
    const tight = lay([['m', t('mat2x3'), { rowMajor: true }]], 'std430');
    assert.deepEqual([tight.members[0].size, tight.members[0].matrixStride], [24, 8]);
});

test('doubles take 8 bytes, a dvec3 aligns to 32', ()=>{
    const block = lay([['a', t('float')], ['d', t('double')], ['v', t('dvec3')],
        ['m', t('dmat2')]], 'std430');
    assert.deepEqual(offsets(block), { a: 0, d: 8, v: 32, m: 64 });
    assert.equal(block.members[3].matrixStride, 16);
});

test('offset and align place a member, and a misplaced one is refused', ()=>{
    const block = lay([['a', t('float'), { offset: 32 }], ['b', t('vec4'), { align: 64 }],
        ['c', t('float')]], 'std140');
    assert.deepEqual(offsets(block), { a: 32, b: 64, c: 80 });
    assert.throws(()=>lay([['a', t('vec4'), { offset: 4 }]], 'std140'), /multiple/);
    assert.throws(()=>lay([['a', t('float'), { align: 12 }]], 'std140'), /power of two/);
    assert.throws(()=>lay([['a', t('vec4')], ['b', t('float'), { offset: 8 }]], 'std430'),
        /overlaps/);
});

test('arrays of arrays stride by their inner arrays', ()=>{
    const grid = arrayOf(arrayOf(t('float'), 3), 2);
    assert.deepEqual(typeLayout(grid, 'std430'), { align: 4, size: 24, arrayStride: 12 });
    assert.deepEqual(typeLayout(grid, 'std140'), { align: 16, size: 96, arrayStride: 48 });
    const variables = blockVariables(lay([['g', grid]], 'std140'), 'std140');
    assert.deepEqual(variables.map(v=>`${v.name}@${v.offset}x${v.arraySize}/${v.arrayStride}`),
        ['g[0][0]@0x3/16', 'g[1][0]@48x3/16']);
});
