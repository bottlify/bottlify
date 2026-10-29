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
import {
    D3DLIGHT7, D3DLOCKED_BOX64, D3DLOCKED_RECT64, D3DPRESENT_PARAMETERS9,
    D3DPRESENT_PARAMETERS9_64, D3DVIEWPORT8, createFields, createLightReader, dwordsOf, floatsOf,
    intsOf, lockRectInto, putLight,
} from './structs.js';
import { D3DDEVICE_CREATION_PARAMETERS64 } from '../d3d8/structs.js';

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

test('a light is read as the fields read it, and the same dwords again are the same light', ()=>{
    const bytes = new Uint8Array(256);
    const view = new DataView(bytes.buffer);
    const memory = {
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address */
        readU32: (/** @type {number} */ address)=>view.getUint32(address, true),
    };
    const fields = createFields(memory);
    const read = createLightReader(fields);
    const words = new Uint32Array(D3DLIGHT7.SIZE >>> 2);
    const floats = new Float32Array(words.buffer);
    const light = {
        Type: 3,
        Diffuse: { r: 1, g: 0.5, b: -0, a: 1 },
        Specular: { r: 0.1, g: 0.2, b: 0.3, a: 0.4 },
        Ambient: { r: 0, g: 0, b: 0, a: 1 },
        Position: { x: 1.5, y: -2, z: 3 },
        Direction: { x: 0, y: 0, z: 1 },
        Range: 100,
        Falloff: 1,
        Attenuation0: 1,
        Attenuation1: 0.25,
        Attenuation2: 0,
        Theta: 0.5,
        Phi: 1.25,
    };
    putLight(floats, words, light);
    bytes.set(new Uint8Array(words.buffer), 16);
    const a = {};
    const b = {};
    const first = read(a, 1, 16);
    // What each field reads as through the fields, one by one.
    const f = (/** @type {number} */ offset)=>fields.readF32(16 + offset);
    assert.deepEqual(first, {
        Type: fields.readU32(16),
        Diffuse: { r: f(4), g: f(8), b: f(12), a: f(16) },
        Specular: { r: f(20), g: f(24), b: f(28), a: f(32) },
        Ambient: { r: f(36), g: f(40), b: f(44), a: f(48) },
        Position: { x: f(52), y: f(56), z: f(60) },
        Direction: { x: f(64), y: f(68), z: f(72) },
        Range: f(76), Falloff: f(80), Attenuation0: f(84), Attenuation1: f(88),
        Attenuation2: f(92), Theta: f(96), Phi: f(100),
    });
    assert.ok(Object.is(first.Diffuse.b, -0));

    assert.equal(read(a, 1, 16), first, 'the same dwords at the same index');
    assert.notEqual(read(a, 2, 16), first, 'another index has a light of its own');
    assert.notEqual(read(b, 1, 16), first, 'and so has another device');

    view.setFloat32(16 + D3DLIGHT7.dvPosition, 7, true);
    const moved = read(a, 1, 16);
    assert.notEqual(moved, first);
    assert.equal(moved.Position.x, 7);
    assert.equal(first.Position.x, 1.5, 'a light answered before is not written into');
    assert.equal(read(a, 1, 16), moved);
});

test('a rectangle lock writes its D3DLOCKED_RECT now or once it settles', async()=>{
    /** @type {any[]} */
    const written = [];
    const fields = { writeStruct: (/** @type {number} */ address, /** @type {any} */ _layout,
        /** @type {any} */ values)=>written.push([address, values]) };
    /** @param {any} locked */
    const take = locked=>Object.assign(locked, { Pitch: 256, pBits: 0x1000 });
    assert.equal(lockRectInto(fields, 0x40, locked=>(take(locked), 0)), 0);
    // A lock of a level a read back is still filling settles later.
    const later = (/** @type {any} */ locked)=>Promise.resolve().then(()=>(take(locked), 0));
    assert.equal(await lockRectInto(fields, 0x80, later), 0);
    assert.equal(lockRectInto(fields, 0xc0, ()=>0x8876086c), 0x8876086c);
    assert.equal(lockRectInto(fields, 0, locked=>(take(locked), 0)), 0);
    assert.deepEqual(written, [[0x40, { Pitch: 256, pBits: 0x1000 }],
        [0x80, { Pitch: 256, pBits: 0x1000 }]]);
});

test('a 64-bit process\'s Direct3D structures lay a handle or a pointer out in eight bytes', ()=>{
    // d3d9.h under _WIN64: the handle or pointer on an eight-byte boundary,
    // everything after it moved, the end padded to eight.
    assert.deepEqual([D3DPRESENT_PARAMETERS9_64.hDeviceWindow, D3DPRESENT_PARAMETERS9_64.Windowed,
        D3DPRESENT_PARAMETERS9_64.PresentationInterval, D3DPRESENT_PARAMETERS9_64.SIZE],
    [0x20, 0x28, 0x3c, 0x40]);
    assert.equal(D3DPRESENT_PARAMETERS9_64.SwapEffect, D3DPRESENT_PARAMETERS9.SwapEffect,
        'the fields before the handle stay where they were');
    assert.deepEqual([D3DDEVICE_CREATION_PARAMETERS64.hFocusWindow,
        D3DDEVICE_CREATION_PARAMETERS64.BehaviorFlags, D3DDEVICE_CREATION_PARAMETERS64.SIZE],
    [0x08, 0x10, 0x18]);
    assert.deepEqual([D3DLOCKED_RECT64.pBits, D3DLOCKED_RECT64.SIZE], [0x08, 0x10]);
    assert.deepEqual([D3DLOCKED_BOX64.pBits, D3DLOCKED_BOX64.SIZE], [0x08, 0x10]);
});

test('a rectangle lock in a 64-bit process writes the address whole', ()=>{
    /** @type {any[]} */
    const written = [];
    const fields = { writeStruct: (/** @type {number} */ address, /** @type {any} */ layout,
        /** @type {any} */ values)=>written.push([address, layout, values]) };
    lockRectInto(fields, 0x40, locked=>(Object.assign(locked, { Pitch: 64, pBits: 0x2000 }), 0),
        D3DLOCKED_RECT64);
    assert.deepEqual(written, [[0x40, D3DLOCKED_RECT64, { Pitch: 64, pBits: 0x2000,
        pBitsHigh: 0 }]]);
});
