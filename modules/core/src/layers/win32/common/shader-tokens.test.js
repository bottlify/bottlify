/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { END_TOKEN, functionLength } from './shader-tokens.js';

/** @param {number[]} tokens */
const reader = tokens=>{
    /** @type {number[]} */
    const read = [];
    return {
        read,
        /** @param {number} at */
        token: at=>{
            read.push(at);
            return at < tokens.length ? tokens[at] >>> 0 : undefined;
        },
    };
};

/** The float 9.999998: low half 0xfffe, the comment opcode, and a length past the end. */
const LOOKS_LIKE_A_COMMENT = 0x411ffffe;

test('a model 2 literal that looks like a comment is stepped over with its def', ()=>{
    const tokens = [
        0xffff0300,                                               // ps_3_0
        0x0002fffe, 0x42415443, 0x0000ffff,                       // a comment holding an end token
        0x05000051, 0xa00f0010, 0x3f000000, 0, 0x41800000, LOOKS_LIKE_A_COMMENT,
        0x02000001, 0x800f0800, 0xa0e40010,                       // mov oC0, c16
        END_TOKEN,
        0xdeadbeef,
    ];
    const { token, read } = reader(tokens);
    assert.equal(functionLength(token), 14);
    assert.ok(read.every(at=>at < 14), 'nothing past the end token is read');
});

test('a model 1 literal that looks like a comment or an end is stepped over too', ()=>{
    const tokens = [
        0xffff0101,                                               // ps_1_1
        0x00000051, 0xa00f0000, LOOKS_LIKE_A_COMMENT, END_TOKEN, 0, 0x3f800000,
        0x00000001, 0x800f0000, 0xa0e40000,                       // mov r0, c0
        END_TOKEN,
    ];
    assert.equal(functionLength(reader(tokens).token), 11);
});

test('a model 1 instruction runs to the next token with bit 31 clear', ()=>{
    const tokens = [
        0xfffe0101,                                               // vs_1_1
        0x0000001f, 0x80000000, 0x900f0000,                       // dcl_position v0
        0x00000009, 0xc0010000, 0x90e40000, 0xa0e40000,           // dp4 oPos.x, v0, c0
        END_TOKEN,
    ];
    assert.equal(functionLength(reader(tokens).token), 9);
});

test('a stream with no end token, or no version token, has no function', ()=>{
    assert.equal(functionLength(reader([0xffff0200, 0x02000001, 0x800f0800, 0xa0e40000]).token), 0);
    assert.equal(functionLength(reader([0x12345678, END_TOKEN]).token), 0);
    assert.equal(functionLength(reader([0xffff0200, 0x0010fffe, 1, 2]).token), 0,
        'a comment running past what memory holds');
    assert.equal(functionLength(reader([0xffff0200, 0x00000000, 0x00000000, END_TOKEN]).token, 2),
        0, 'the limit');
});

test('comments of words that look like ends, and def literals that do, are stepped over', ()=>{
    // 0.99999988 is 0x3f7ffffe.
    assert.equal(functionLength(reader([0xffff0300,
        0x0002fffe, 0x0000ffff, 0x1234fffe,
        0x05000051, 0xa00f0000, 0x3f7ffffe, 0x0000ffff, 0x3f800000, 0,
        0x02000001, 0x800f0800, 0xa0e40000,
        0x0000ffff]).token), 14);
    assert.equal(functionLength(reader([0xfffe0101,
        0x00000051, 0xa00f0000, 0x3f7ffffe, 0x0000ffff, 0x3f800000, 0,
        0x00000001, 0xc00f0000, 0xa0e40000,
        0x0000ffff]).token), 11);
});
