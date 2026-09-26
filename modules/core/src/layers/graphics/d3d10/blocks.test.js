/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertTexels, convertedTexelBytes } from './blocks.js';

/**
 * One BC4 block: two endpoints and sixteen three-bit indices, low bits first.
 *
 * @param {number} e0
 * @param {number} e1
 * @param {number[]} indices
 */
function bc4Block(e0, e1, indices){
    let bits = 0n;
    indices.forEach((index, at)=>{
        bits |= BigInt(index) << BigInt(at * 3);
    });
    const block = [e0 & 0xff, e1 & 0xff];
    for (let byte = 0; byte < 6; byte++)
    {
        block.push(Number((bits >> BigInt(byte * 8)) & 0xffn));
    }
    return block;
}

test('BC4 interpolates eight values when the first endpoint is the larger', ()=>{
    // Texel k takes index k % 8: the two endpoints, then six steps between.
    const indices = Array.from({ length: 16 }, (_, at)=>at % 8);
    const texels = convertTexels('bc4u', Uint8Array.from(bc4Block(210, 0, indices)), 4, 4);
    assert.deepEqual([...(texels ?? [])].slice(0, 8), [210, 0, 180, 150, 120, 90, 60, 30]);
});

test('BC4 has six steps and the two extremes when the first endpoint is not the larger', ()=>{
    const indices = Array.from({ length: 16 }, (_, at)=>at % 8);
    const texels = convertTexels('bc4u', Uint8Array.from(bc4Block(0, 250, indices)), 4, 4);
    assert.deepEqual([...(texels ?? [])].slice(0, 8), [0, 250, 50, 100, 150, 200, 0, 255]);
});

test('signed BC4 reads its endpoints as signed and its extremes as -1 and 1', ()=>{
    const indices = Array.from({ length: 16 }, (_, at)=>at % 8);
    // -100 and 100 with the first the smaller: six steps, then -127 and 127.
    const texels = convertTexels('bc4s', Uint8Array.from(bc4Block(-100, 100, indices)), 4, 4);
    const signed = [...(texels ?? [])].slice(0, 8).map(byte=>(byte << 24) >> 24);
    assert.deepEqual(signed, [-100, 100, -60, -20, 20, 60, -127, 127]);
    // -128 is read as -127, so the two ends of the range are symmetric.
    const clamped = convertTexels('bc4s', Uint8Array.from(bc4Block(-128, 5, new Array(16)
        .fill(0))), 4, 4);
    assert.equal(((clamped ?? [])[0] << 24) >> 24, -127);
});

test('BC5 is two BC4 blocks, red then green, into two channels', ()=>{
    const red = bc4Block(200, 100, new Array(16).fill(0));
    const green = bc4Block(200, 100, new Array(16).fill(1));
    const texels = convertTexels('bc5u', Uint8Array.from([...red, ...green]), 4, 4);
    assert.equal(convertedTexelBytes('bc5u'), 2);
    assert.deepEqual([...(texels ?? [])].slice(0, 4), [200, 100, 200, 100]);
});

test('a level smaller than a block keeps only its texels, and too few bytes is no answer', ()=>{
    const texels = convertTexels('bc4u', Uint8Array.from(bc4Block(9, 0, new Array(16).fill(0))),
        2, 1);
    assert.deepEqual([...(texels ?? [])], [9, 9]);
    assert.equal(convertTexels('bc4u', new Uint8Array(4), 4, 4), null);
});

test('BC1 goes through the shared decoder, and an alpha texture keeps only its alpha', ()=>{
    // A block of red (0xf800) as both endpoints, every index zero.
    const bc1 = convertTexels('bc1', Uint8Array.from([0x00, 0xf8, 0x00, 0xf8, 0, 0, 0, 0]),
        4, 4);
    assert.deepEqual([...(bc1 ?? [])].slice(0, 4), [255, 0, 0, 255]);
    const alpha = convertTexels('a8', Uint8Array.from([7, 200]), 2, 1);
    assert.deepEqual([...(alpha ?? [])], [0, 0, 0, 7, 0, 0, 0, 200]);
});
