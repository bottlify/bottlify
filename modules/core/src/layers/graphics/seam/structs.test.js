/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The seams' own readers and writers of guest memory: what a vector argument
 * decodes to, and what an out-parameter leaves behind, whichever way the
 * memory given moves the bytes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFields, dwordsOf, floatsOf, intsOf } from './structs.js';

/**
 * What the readers answered before the staging buffer: a fresh array, its
 * bytes copied in through a view over its own buffer.
 *
 * @param {Float32ArrayConstructor | Int32ArrayConstructor | Uint32ArrayConstructor} Type
 * @param {Uint8Array} bytes
 * @param {number} count
 */
function reference(Type, bytes, count){
    const values = new Type(count);
    new Uint8Array(values.buffer).set(bytes);
    return values;
}

test('floats, ints and dwords decode as a copy through the array\'s own buffer did', ()=>{
    let seed = 0x2545f491;
    const random = ()=>{
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return seed & 0xff;
    };
    for (const count of [0, 1, 3, 4, 16, 17, 96, 400])
    {
        const bytes = Uint8Array.from({ length: count * 4 }, random);
        assert.deepEqual(floatsOf(bytes, count), reference(Float32Array, bytes, count));
        assert.deepEqual(intsOf(bytes, count), reference(Int32Array, bytes, count));
        assert.deepEqual(dwordsOf(bytes, count), reference(Uint32Array, bytes, count));
        // A read short of the count leaves the rest zero, as a fresh array has it.
        const short = bytes.subarray(0, Math.max(0, count * 4 - 5));
        assert.deepEqual(floatsOf(short, count), reference(Float32Array, short, count));
        assert.deepEqual(dwordsOf(short, count), reference(Uint32Array, short, count));
    }
    // And more bytes than the count refuses, as a copy into the array would.
    assert.throws(()=>floatsOf(new Uint8Array(20), 4), RangeError);
    assert.throws(()=>intsOf(new Uint8Array(8), -1), RangeError);
});

test('each answer is an array of its own: the next read does not reach one kept', ()=>{
    const first = floatsOf(new Uint8Array(new Float32Array([1, 2, 3, 4]).buffer), 4);
    const second = floatsOf(new Uint8Array(new Float32Array([5, 6, 7, 8]).buffer), 4);
    assert.deepEqual([...first], [1, 2, 3, 4]);
    assert.deepEqual([...second], [5, 6, 7, 8]);
    assert.notEqual(first.buffer, second.buffer);
    // A short read after a long one still reads zeros past its end, not the
    // long one's bytes.
    floatsOf(new Uint8Array(new Float32Array([9, 9, 9, 9]).buffer), 4);
    assert.deepEqual([...floatsOf(new Uint8Array(new Float32Array([1]).buffer), 4)],
        [1, 0, 0, 0]);
});

test('a dword field is written in place where the memory offers it, and as bytes otherwise', ()=>{
    const bytes = new Uint8Array(64);
    /** @type {string[]} */
    const paths = [];
    const byBytes = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.slice(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>{
            paths.push('bytes');
            bytes.set(value, at);
        },
    };
    const inPlace = {
        ...byBytes,
        writeU32: (/** @type {number} */ at, /** @type {number} */ value)=>{
            paths.push('dword');
            new DataView(bytes.buffer).setUint32(at, value, true);
        },
    };
    for (const value of [0, 1, 0x12345678, 0xffffffff, -1, -2, 2 ** 32 + 5, 1.75])
    {
        bytes.fill(0xcd);
        createFields(byBytes).writeU32(8, value);
        const expected = [...bytes];
        bytes.fill(0xcd);
        createFields(inPlace).writeU32(8, value);
        assert.deepEqual([...bytes], expected, `the same four bytes for ${value}`);
    }
    assert.deepEqual([...new Set(paths)], ['bytes', 'dword']);
    // A float field is a dword with a float's bits, by either path.
    createFields(inPlace).writeF32(16, 1.5);
    assert.equal(new DataView(bytes.buffer).getFloat32(16, true), 1.5);
});
