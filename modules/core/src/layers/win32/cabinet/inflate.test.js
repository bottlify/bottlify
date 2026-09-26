/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, deflateRawSync } from 'node:zlib';
import { InflateError, createInflater, inflateMszipBlock } from './inflate.js';

/** @param {string} text */
const bytes = text=>Uint8Array.from([...text].map(c=>c.charCodeAt(0)));

/**
 * Bits packed as deflate packs them: each value least significant bit
 * first, and a Huffman code most significant bit first.
 */
function bitWriter(){
    /** @type {number[]} */
    const out = [];
    let buffer = 0;
    let count = 0;
    const put = (/** @type {number} */ value, /** @type {number} */ width)=>{
        for (let i = 0; i < width; i++)
        {
            buffer |= ((value >> i) & 1) << count;
            if (++count === 8)
            {
                out.push(buffer);
                buffer = 0;
                count = 0;
            }
        }
    };
    return {
        put,
        /** @param {number} code @param {number} width */
        code: (code, width)=>{
            for (let i = width - 1; i >= 0; i--)
            {
                put((code >> i) & 1, 1);
            }
        },
        done: ()=>Uint8Array.from(count ? [...out, buffer] : out),
    };
}

test('a stored block is its own bytes, and its length must match its complement', ()=>{
    const stored = Uint8Array.from([0x01, 5, 0, 0xfa, 0xff, ...bytes('hello')]);
    assert.deepEqual(createInflater().inflate(stored), bytes('hello'));
    const broken = Uint8Array.from([0x01, 5, 0, 0xfa, 0xfe, ...bytes('hello')]);
    assert.throws(()=>createInflater().inflate(broken), InflateError);
});

test('the fixed codes: literals, and a match reaching back into what was just written', ()=>{
    // "abcabcabc": three literals, then length 6 at distance 3, then end.
    const w = bitWriter();
    w.put(1, 1); // final
    w.put(1, 2); // fixed Huffman
    for (const c of 'abc')
    {
        w.code(0x30 + c.charCodeAt(0), 8); // 0..143 are 00110000 upward, 8 bits
    }
    w.code(260 - 256, 7); // length 6 is code 260, a 7-bit code 0000100
    w.code(2, 5); // distance 3 is distance code 2
    w.code(0, 7); // end of block
    assert.deepEqual(createInflater().inflate(w.done()), bytes('abcabcabc'));
});

test('dynamic blocks decode what a deflate encoder wrote', ()=>{
    const text = bytes(`${'The cabinet holds the files. '.repeat(40)}And some more at the end.`);
    for (const strategy of [constants.Z_DEFAULT_STRATEGY, constants.Z_HUFFMAN_ONLY,
        constants.Z_FIXED])
    {
        const packed = deflateRawSync(text, { strategy });
        assert.deepEqual(createInflater().inflate(packed, text.length), text);
    }
});

test('MSZIP keeps the history from one block to the next, and a reset forgets it', ()=>{
    const first = bytes('DirectX redistributable, 32 KiB at a time. '.repeat(20));
    const second = bytes('DirectX redistributable, 32 KiB at a time. '.repeat(5));
    // The second block is packed against the first as its dictionary, which
    // is what an MSZIP compressor's surviving history is.
    const blockOne = Uint8Array.from([0x43, 0x4b, ...deflateRawSync(first)]);
    const blockTwo = Uint8Array.from([0x43, 0x4b,
        ...deflateRawSync(second, { dictionary: first })]);
    const inflater = createInflater();
    assert.deepEqual(inflateMszipBlock(inflater, blockOne, first.length), first);
    assert.deepEqual(inflateMszipBlock(inflater, blockTwo, second.length), second);

    inflater.reset();
    inflateMszipBlock(inflater, blockOne, first.length);
    inflater.reset();
    assert.notDeepEqual(inflater.inflate(blockTwo.subarray(2), second.length), second,
        'without the history the matches read zeros');
});

test('an MSZIP block needs its signature and the size its CFDATA promises', ()=>{
    const packed = deflateRawSync(bytes('abc'));
    assert.throws(()=>inflateMszipBlock(createInflater(), packed, 3), InflateError);
    assert.throws(()=>inflateMszipBlock(createInflater(),
        Uint8Array.from([0x43, 0x4b, ...packed]), 4), InflateError);
});

test('a stream cut short, or of the reserved block type, is an error rather than output', ()=>{
    const packed = deflateRawSync(bytes('some text, some text, some text'));
    assert.throws(()=>createInflater().inflate(packed.subarray(0, packed.length - 2)),
        InflateError);
    assert.throws(()=>createInflater().inflate(Uint8Array.from([0x07])), InflateError);
});
