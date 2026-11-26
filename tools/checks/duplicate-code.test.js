/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clusters } from './duplicate-code.mjs';

const BODY = (/** @type {string} */ a, /** @type {string} */ b, /** @type {number} */ k)=>`
function ${a}(${b}, at){
    // a comment of its own
    const v = ${b}[at] | ${b}[at + 1] << 8 | ${b}[at + 2] << 16 | ${b}[at + 3] << 24;
    return (v >>> 0) + ${k};
}`;

test('the same body over other names, comments apart, in two files is one cluster', ()=>{
    const found = clusters([
        { file: 'a.js', source: BODY('readA', 'bytes', 1) },
        { file: 'b.js', source: `const x = 1;\n${BODY('readB', 'memory', 1)}` },
    ], 25);
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].copies.map(copy=>`${copy.file}:${copy.line} ${copy.name}`),
        ['a.js:2 readA', 'b.js:3 readB']);
    assert.equal(found[0].lines, 5);
    assert.equal(found[0].saves, 5, 'one copy past the first');
});

test('another constant, one file alone, or a body under the floor is no cluster', ()=>{
    assert.deepEqual(clusters([
        { file: 'a.js', source: BODY('readA', 'bytes', 1) },
        { file: 'b.js', source: BODY('readB', 'bytes', 2) },
    ], 25), [], 'a literal is kept as written');
    assert.deepEqual(clusters([
        { file: 'a.js', source: BODY('readA', 'bytes', 1) + BODY('readB', 'bytes', 1) },
    ], 25), [], 'two copies in one file');
    assert.deepEqual(clusters([
        { file: 'a.js', source: BODY('readA', 'bytes', 1) },
        { file: 'b.js', source: BODY('readB', 'bytes', 1) },
    ], 1000), [], 'shorter than the floor');
});

test('a copy inside a larger copy is the larger one\'s part, and clusters go by lines saved', ()=>{
    const outer = (/** @type {string} */ name)=>`
export function ${name}(list){
    const inner = (bytes, at)=>{
        const v = bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24;
        return v >>> 0;
    };
    return list.map(item=>inner(item, 0));
}`;
    const found = clusters([
        { file: 'a.js', source: outer('one') + BODY('small', 'b', 7) },
        { file: 'b.js', source: outer('two') },
        { file: 'c.js', source: BODY('small', 'q', 7) },
    ], 25);
    assert.deepEqual(found.map(cluster=>cluster.copies.map(copy=>copy.name)),
        [['one', 'two'], ['small', 'small']], 'the arrow inside one and two is not listed');
});
