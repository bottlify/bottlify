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
import { D3DVIEWPORT8, createFields, dwordsOf, floatsOf, intsOf } from './structs.js';

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

/**
 * A memory that records every write it takes, as [address, length].
 *
 * @param {number} [size]
 */
function recording(size = 1024){
    const bytes = new Uint8Array(size).fill(0xcd);
    /** @type {[number, number][]} */
    const writes = [];
    return {
        bytes, writes,
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.slice(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ value)=>{
            writes.push([at, value.length]);
            bytes.set(value, at);
        },
    };
}

test('a structure is written a run of named fields at a time, each as a dword would be', ()=>{
    const view = (/** @type {Uint8Array} */ bytes)=>new DataView(bytes.buffer);
    // Every field named: one write of the whole.
    const whole = recording();
    createFields(whole).writeStruct(0x40, D3DVIEWPORT8,
        { X: 1, Y: 2, Width: 640, Height: 480, MinZ: 0.25, MaxZ: 1 }, ['MinZ', 'MaxZ']);
    assert.deepEqual(whole.writes, [[0x40, D3DVIEWPORT8.SIZE]]);
    assert.equal(view(whole.bytes).getUint32(0x40 + D3DVIEWPORT8.Height, true), 480);
    assert.equal(view(whole.bytes).getFloat32(0x40 + D3DVIEWPORT8.MinZ, true), 0.25);

    // Some named, in no particular order: a write per run, the rest left as
    // they were, and each value what a dword or a float of it holds.
    const some = recording();
    createFields(some).writeStruct(0x40, D3DVIEWPORT8,
        { MaxZ: 0.5, Height: -1, Y: 2 ** 32 + 5, X: 1.75, Unknown: 9 }, ['MaxZ']);
    assert.deepEqual(some.writes, [[0x40, 8], [0x40 + D3DVIEWPORT8.Height, 4],
        [0x40 + D3DVIEWPORT8.MaxZ, 4]]);
    const at = view(some.bytes);
    assert.equal(at.getUint32(0x40 + D3DVIEWPORT8.X, true), 1);
    assert.equal(at.getUint32(0x40 + D3DVIEWPORT8.Y, true), 5);
    assert.equal(at.getUint32(0x40 + D3DVIEWPORT8.Height, true), 0xffffffff);
    assert.equal(at.getFloat32(0x40 + D3DVIEWPORT8.MaxZ, true), 0.5);
    assert.equal(at.getUint32(0x40 + D3DVIEWPORT8.Width, true), 0xcdcdcdcd,
        'not named, not written');
    assert.equal(at.getUint32(0x40 + D3DVIEWPORT8.MinZ, true), 0xcdcdcdcd);
    assert.equal(at.getUint32(0x40 + D3DVIEWPORT8.SIZE, true), 0xcdcdcdcd, 'nothing past it');

    // Fields sharing an offset are written one at a time, in the order they
    // are named, as they always were: the last one named is what is left.
    const shared = recording();
    createFields(shared).writeStruct(0x40, { a: 0, b: 0, c: 4, SIZE: 8 }, { b: 1, c: 3, a: 2 });
    assert.equal(view(shared.bytes).getUint32(0x40, true), 2);
    assert.equal(view(shared.bytes).getUint32(0x44, true), 3);
    assert.equal(shared.writes.length, 3);
});

test('floats and dwords are written as one block, however many', ()=>{
    for (const count of [1, 4, 16, 300])
    {
        const target = recording(8 + count * 4);
        const floats = Float32Array.from({ length: count }, (unused, i)=>i * 0.75 - 2);
        createFields(target).writeFloats(8, floats);
        assert.deepEqual(target.writes, [[8, count * 4]]);
        assert.deepEqual(new Float32Array(target.bytes.slice(8, 8 + count * 4).buffer), floats);
        const dwords = Array.from({ length: count }, (unused, i)=>(i % 2 ? -i : 2 ** 32 + i));
        target.writes.length = 0;
        createFields(target).writeDwords(8, dwords);
        assert.deepEqual(target.writes, [[8, count * 4]]);
        assert.deepEqual([...new Uint32Array(target.bytes.slice(8, 8 + count * 4).buffer)],
            dwords.map(value=>value >>> 0));
    }
});
