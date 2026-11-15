/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compress, createCompressionFunctions, decompress } from './lznt1.js';

const text = (/** @type {string} */ value)=>Uint8Array.from([...value].map(ch=>ch.charCodeAt(0)));

test('a chunk of repeats is a copy token; one that would not shrink is stored as it is', ()=>{
    // "abcabcabc...": three literals, then one copy reaching back three.
    const packed = compress(text('abcabcabcabcabcabc'));
    const header = packed[0] | packed[1] << 8;
    assert.equal(header & 0xf000, 0xb000, 'compressed, signature 3');
    assert.equal((header & 0xfff) + 3, packed.length, 'the size counts the header');
    assert.deepEqual(decompress(packed, 100), { bytes: text('abcabcabcabcabcabc') });

    let seed = 0x12345678;
    const noise = Uint8Array.from({ length: 300 }, ()=>{
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        return seed & 0xff;
    });
    const raw = compress(noise);
    assert.equal((raw[0] | raw[1] << 8) & 0x8000, 0, 'stored raw');
    assert.equal(raw.length, noise.length + 2);
    assert.deepEqual(decompress(raw, 300), { bytes: noise });
});

test('a buffer of several chunks comes back whole, and cut where the room ends', ()=>{
    const data = Uint8Array.from({ length: 10000 }, (_, i)=>(i % 97 < 50 ? 0x41 : i & 0xff));
    const packed = compress(data);
    assert.ok(packed.length < data.length);
    assert.deepEqual(decompress(packed, data.length), { bytes: data });
    assert.deepEqual(decompress(packed, 5000), { bytes: data.subarray(0, 5000) });
    // A header of zero ends the stream before the input does.
    assert.deepEqual(decompress(Uint8Array.of(...packed, 0, 0, 0xff, 0xff), data.length),
        { bytes: data });
    assert.deepEqual(decompress(packed.subarray(0, 10), data.length), { bad: true });
});

test('the Rtl calls: formats, room, fragments', ()=>{
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    const fns = createCompressionFunctions({
        readMemory: (at, length)=>memory.subarray(at, at + length),
        writeMemory: (at, bytes)=>memory.set(bytes, at),
    });
    const IN = 0x1000;
    const PACKED = 0x4000;
    const OUT = 0x8000;
    const FINAL = 0x100;
    const data = text('hello hello hello hello world, world, world!');
    memory.set(data, IN);

    assert.equal(fns.RtlGetCompressionWorkSpaceSize.handler([2, 0x110, 0x114]), 0);
    assert.ok(view.getUint32(0x110, true) > 0 && view.getUint32(0x114, true) > 0);
    assert.equal(fns.RtlGetCompressionWorkSpaceSize.handler([0, 0x110, 0x114]), 0xc000000d);
    assert.equal(fns.RtlGetCompressionWorkSpaceSize.handler([3, 0x110, 0x114]), 0xc000025f,
        'XPRESS is a format this system does not have');

    assert.equal(fns.RtlCompressBuffer.handler([0x102, IN, data.length, PACKED, 4, 4096, FINAL,
        0]), 0xc0000023, 'too little room');
    assert.equal(fns.RtlCompressBuffer.handler([0x102, IN, data.length, PACKED, 0x1000, 4096,
        FINAL, 0]), 0);
    const size = view.getUint32(FINAL, true);
    assert.equal(fns.RtlDecompressBuffer.handler([2, OUT, 0x1000, PACKED, size, FINAL]), 0);
    assert.equal(view.getUint32(FINAL, true), data.length);
    assert.deepEqual(memory.subarray(OUT, OUT + data.length), data);

    memory.fill(0, OUT, OUT + 0x100);
    assert.equal(fns.RtlDecompressFragment.handler([2, OUT, 5, PACKED, size, 6, FINAL, 0]), 0);
    assert.deepEqual(memory.subarray(OUT, OUT + 5), text('hello'));
    assert.equal(view.getUint32(FINAL, true), 5);

    memory.set([0x05, 0xb0, 0x01, 0x41, 0x10, 0x00], PACKED);
    assert.equal(fns.RtlDecompressBuffer.handler([2, OUT, 0x100, PACKED, 6, FINAL]), 0xc0000242,
        'a copy before anything was written');
});
