/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr, formatBits, qrToSvg, reedSolomon, versionBits } from './qr.js';

test('Reed-Solomon codewords: the standard\'s worked example, 1-M', ()=>{
    const data = [0x10, 0x20, 0x0C, 0x56, 0x61, 0x80, 0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11,
        0xEC, 0x11, 0xEC, 0x11];
    assert.deepEqual([...reedSolomon(data, 10)],
        [0xA5, 0x24, 0xD4, 0xC1, 0xED, 0x36, 0xC7, 0x87, 0x2C, 0x55]);
});

test('format and version information, from the standard\'s tables', ()=>{
    assert.equal(formatBits(0), 0b101010000010010);
    assert.equal(formatBits(5), 0b100000011001110);
    assert.equal(versionBits(7), 0b000111110010010100);
    assert.equal(versionBits(10), 0b001010010011010011);
});

test('a sign-in URL: its size, finders, timing, and the format bits for the mask chosen', ()=>{
    const grid = encodeQr('https://s.team/q/1/15415414484925123456');
    assert.equal(grid.length, 29, 'version 3 for 39 bytes at level M');
    for (const [x0, y0] of [[0, 0], [22, 0], [0, 22]])
    {
        for (let i = 0; i < 7; i++)
        {
            assert.equal(grid[y0][x0 + i], true);
            assert.equal(grid[y0 + 3][x0 + i], i !== 1 && i !== 5);
        }
    }
    for (let i = 8; i < 21; i++)
    {
        assert.equal(grid[6][i], i % 2 === 0);
        assert.equal(grid[i][6], i % 2 === 0);
    }
    // Both copies of the format bits read the same, and name one of the masks.
    let first = 0;
    let second = 0;
    const one = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8],
        [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
    one.forEach(([x, y], bit)=>{
        first |= (grid[y][x] ? 1 : 0) << bit;
    });
    for (let bit = 0; bit < 15; bit++)
    {
        const [x, y] = bit < 8 ? [28 - bit, 8] : [8, 29 - 15 + bit];
        second |= (grid[y][x] ? 1 : 0) << bit;
    }
    assert.equal(first, second);
    assert.ok([0, 1, 2, 3, 4, 5, 6, 7].some(mask=>formatBits(mask) === first));
    assert.equal(grid[29 - 8][8], true, 'the dark module');
});

test('the largest it holds, and past it', ()=>{
    assert.equal(encodeQr('a'.repeat(213)).length, 57);
    assert.throws(()=>encodeQr('a'.repeat(214)), RangeError);
});

test('the SVG has the quiet zone around it', ()=>{
    const svg = qrToSvg(encodeQr('x'), 2);
    assert.match(svg, /width="58" height="58" viewBox="0 0 29 29"/);
});
