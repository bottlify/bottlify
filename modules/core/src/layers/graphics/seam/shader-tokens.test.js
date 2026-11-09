/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shaderEnd } from './shader-tokens.js';

/** Where the walker says the stream ends, or -1. @param {number[]} tokens */
const endOf = tokens=>{
    const ends = shaderEnd();
    return tokens.findIndex(token=>ends(token));
};

test('a model 3 shader ends at its end token, a def\'s literals and a comment skipped', ()=>{
    assert.equal(endOf([0xffff0300,
        0x0002fffe, 0x0000ffff, 0x1234fffe, // a comment of two that look like ends
        0x05000051, 0xa00f0000, 0x3f7ffffe, 0x0000ffff, 0x3f800000, 0, // def c0
        0x02000001, 0x800f0800, 0xa0e40000,             // mov oC0, c0
        0x0000ffff]), 13);
});

test('a model 1 shader ends at its end token, its def\'s literals skipped', ()=>{
    // vs_1_1: def c0, 0x3f7ffffe, 0x0000ffff, 1, 0; mov oPos, c0; end.
    assert.equal(endOf([0xfffe0101,
        0x00000051, 0xa00f0000, 0x3f7ffffe, 0x0000ffff, 0x3f800000, 0,
        0x00000001, 0xc00f0000, 0xa0e40000,
        0x0000ffff]), 10);
});
