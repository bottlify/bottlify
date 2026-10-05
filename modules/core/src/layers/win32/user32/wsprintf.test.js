/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WSPRINTF_LIMIT, formatWsprintf } from './wsprintf.js';

const STRING = 0x1000;
const WIDE = 0x2000;

/**
 * Formats as wsprintfA, or wsprintfW with `wide`, with a byte string at
 * STRING and a UTF-16 one at WIDE.
 *
 * @param {string} text @param {number[]} slots @param {boolean} [wide]
 */
const format = (text, slots = [], wide = false)=>formatWsprintf(text, slots, {
    readString: address=>(address === 0 ? '(null)' : address === STRING ? 'narrow' : '?'),
    readWideString: address=>(address === 0 ? '(null)' : address === WIDE ? 'wide' : '?'),
    byteChar: byte=>String.fromCharCode(byte === 0x99 ? 0x2122 : byte),
    wide,
});

/** A 64-bit value as the two stack slots it is pushed as. @param {bigint} value */
const slots64 = value=>[Number(BigInt.asUintN(32, value)),
    Number(BigInt.asUintN(32, value >> 32n))];

test('a zero-padded number takes the width as its digits, the radix mark on top', ()=>{
    // A setup names its language file "%#04x" of the language: 0x0409.ini.
    assert.equal(format('%#04x', [0x409]), '0x0409');
    assert.equal(format('%#06X', [0xab]), '0X0000AB');
    assert.equal(format('%#x', [0]), '0x0', 'a zero is marked too');
    assert.equal(format('%#6x', [0x409]), '   0x409',
        'spaces are counted against the digits alone');
    assert.equal(format('%-#6x|', [0x409]), '0x409   |');
    assert.equal(format('%04x', [0x409]), '0409');
});

test('a sign is one of the characters the width counts, and the zeros go after it', ()=>{
    // Wine's test: "%010ld" of -1 is ten characters.
    assert.equal(format('%010ld', [-1]), '-000000001');
    assert.equal(format('%5d|%-5d|%05u', [-42, 7, 42]), '  -42|7    |00042');
    assert.equal(format('%.3d', [-5]), '-05', 'the precision counts the sign too');
    assert.equal(format('%.3u', [5]), '005');
    assert.equal(format('%-05d|', [3]), '3    |', 'left alignment pads with blanks');
    assert.equal(format('%u %d', [-1, 0x80000000]), '4294967295 -2147483648');
});

test('the sizes: I64 takes two slots, I32 and I one', ()=>{
    // Wine's table, for a 32-bit process.
    const value = (0x12345n << 32n) | 0x67890an;
    assert.equal(format('%I64X', slots64(value)), '123450067890A');
    assert.equal(format('%I32X', slots64(value)), '67890A');
    assert.equal(format('%I64d', slots64(543210n * 1000000n)), '543210000000');
    assert.equal(format('%I64X', slots64(-0x12345n)), 'FFFFFFFFFFFEDCBB');
    assert.equal(format('%I32x', slots64(-0x12345n)), 'fffedcbb');
    assert.equal(format('%I64u', slots64(-123n)), '18446744073709551493');
    assert.equal(format('%Id', slots64(-12345n)), '-12345');
    assert.equal(format('%Ix', slots64(value)), '67890a');
    assert.equal(format('%p', slots64(-0x12345n)), 'FFFEDCBB');
    assert.equal(format('%p', [0x1234]), '00001234', 'eight digits, always');
    assert.equal(format('%I64d|%d', [...slots64(-2n), 9]), '-2|9', 'and the next takes the third');
});

test('strings and characters: the narrow and wide ones each form names, and a precision', ()=>{
    assert.equal(format('%s|%S|%ls|%hs|%ws', [STRING, WIDE, WIDE, STRING, WIDE]),
        'narrow|wide|wide|narrow|wide');
    assert.equal(format('%s|%S|%hs|%lS|%hS', [WIDE, STRING, STRING, WIDE, STRING], true),
        'wide|narrow|narrow|wide|narrow');
    assert.equal(format('[%.3s][%8s][%-8s]', [STRING, STRING, STRING]),
        '[nar][  narrow][narrow  ]');
    assert.equal(format('%s', [0]), '(null)');
    assert.equal(format('%c%C%lc%hC', [0x41, 0x2014, 0x2014, 0x99]), 'A——™');
    assert.equal(format('%c%C', [0x2014, 0x99], true), '—™');
    assert.equal(format('%2c|%-2c|', [0x2a, 0x2a]), ' *|* |');
});

test('what is not a conversion is printed, and a format past its arguments reads zeros', ()=>{
    assert.equal(format('100%% %f %5q %+d %', [7]), '100% f      q +d ',
        'no floating point, no plus flag; a lone % at the end is nothing');
    assert.equal(format('%d-%d', [1]), '1-0');
});

test('no more than the buffer wsprintf may assume is written', ()=>{
    const text = format('%s%s', [STRING, STRING]);
    assert.equal(text, 'narrownarrow');
    const long = format('x'.repeat(2000));
    assert.equal(long.length, WSPRINTF_LIMIT - 1, 'room is left for the terminator');
});
