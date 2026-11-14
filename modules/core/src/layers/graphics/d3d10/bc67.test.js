/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { decodeBc67, decodeBc6hBlock, decodeBc7Block } from './bc67.js';

/** Blocks of every mode and an independent decoder's answer (tools/generators/bc-corpus.mjs). */
const corpus = JSON.parse(gunzipSync(readFileSync(new URL('./bc67-corpus.json.gz',
    import.meta.url))).toString());

/** @param {{ kind: string, block: string }} one @returns {string} */
const decoded = one=>{
    const block = Uint8Array.from(Buffer.from(one.block, 'hex'));
    if (one.kind === 'bc7')
    {
        return Buffer.from(decodeBc7Block(block, 0)).toString('hex');
    }
    const halves = decodeBc6hBlock(block, 0, one.kind === 'bc6hs');
    let text = '';
    for (let texel = 0; texel < 16; texel++)
    {
        for (let channel = 0; channel < 3; channel++)
        {
            text += halves[texel * 4 + channel].toString(16).padStart(4, '0');
        }
    }
    return text;
};

test('every block of the corpus decodes as the independent decoder decodes it: BC7\'s eight modes'
    + ' and its reserved one, BC6H\'s fourteen and its reserved four, unsigned and signed', ()=>{
    /** @type {Record<string, number>} */
    const differing = {};
    for (const one of corpus.cases)
    {
        if (decoded(one) !== one.decoded)
        {
            differing[one.kind] = (differing[one.kind] ?? 0) + 1;
        }
    }
    assert.deepEqual(differing, {});
    assert.equal(corpus.cases.length, 3000);
});

test('a BC6H texel\'s alpha is 1.0, a reserved BC7 block is zero in every channel', ()=>{
    const reserved = new Uint8Array(16);
    assert.deepEqual([...decodeBc7Block(reserved, 0)], new Array(64).fill(0));
    const halves = decodeBc6hBlock(Uint8Array.from(Buffer.from(corpus.cases[1].block, 'hex')),
        0, false);
    assert.equal(halves[3], 0x3c00);
});

test('a level of blocks decodes into rows of texels, a partial block cut at the edge', ()=>{
    const blocks = corpus.cases.filter((/** @type {any} */ one)=>one.kind === 'bc7').slice(0, 2);
    const bytes = Uint8Array.from(Buffer.concat(blocks.map((/** @type {any} */ one)=>
        Buffer.from(one.block, 'hex'))));
    const level = /** @type {Uint8Array} */ (decodeBc67(bytes, 'bc7', 6, 3));
    assert.equal(level.length, 6 * 3 * 4);
    const second = Buffer.from(blocks[1].decoded, 'hex');
    assert.deepEqual([...level.subarray((2 * 6 + 5) * 4, (2 * 6 + 6) * 4)],
        [...second.subarray((2 * 4 + 1) * 4, (2 * 4 + 2) * 4)],
        'texel (5, 2) is the second block\'s (1, 2)');
    assert.equal(decodeBc67(bytes.subarray(0, 20), 'bc7', 8, 4), null, 'too few bytes');
});
