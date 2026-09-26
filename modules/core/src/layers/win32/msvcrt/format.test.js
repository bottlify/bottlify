/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatToString } from './format.js';

/** Pointers the guest would hold; the engine never invents one of its own. */
const HELLO = 0x100;
const EMPTY = 0x200;
const LONG = 0x300;

const strings = new Map([[HELLO, 'world'], [EMPTY, ''], [LONG, 'abcdefgh']]);

/** @param {number} pointer */
const readString = pointer=>strings.get(pointer) ?? '';

/** @param {string} format @param {number[]} varargs */
const render = (format, varargs = [])=>formatToString(format, varargs, readString);

test('text outside a specifier is copied through unchanged', ()=>{
    assert.equal(render(''), '');
    assert.equal(render('plain text'), 'plain text');
    assert.equal(render('%%'), '%');
    assert.equal(render('100%% done'), '100% done');
});

test('integers convert by radix and signedness', ()=>{
    assert.equal(render('%d', [42]), '42');
    assert.equal(render('%d', [-42]), '-42');
    assert.equal(render('%i', [-1]), '-1');
    assert.equal(render('%u', [-1]), '4294967295');
    assert.equal(render('%x', [0xdeadbeef]), 'deadbeef');
    assert.equal(render('%X', [0xdeadbeef]), 'DEADBEEF');
    assert.equal(render('%d', [-2147483648]), '-2147483648');
});

test('strings and characters come from the argument, not the format', ()=>{
    assert.equal(render('hello %s', [HELLO]), 'hello world');
    assert.equal(render('[%s]', [EMPTY]), '[]');
    assert.equal(render('%c%c', [0x41, 0x42]), 'AB');
    assert.equal(render('%c', [0x141]), 'A', 'only the low byte is a char');
});

test('a null string pointer prints (null) rather than reading address zero', ()=>{
    assert.equal(render('%s', [0]), '(null)');
});

test('arguments are consumed in order, and the extras are ignored', ()=>{
    assert.equal(render('%d %s %c', [7, HELLO, 0x5a]), '7 world Z');
    assert.equal(render('%d', [1, 2, 3]), '1');
});

test('width pads, and the minus flag pads on the other side', ()=>{
    assert.equal(render('%5d|', [42]), '   42|');
    assert.equal(render('%-5d|', [42]), '42   |');
    assert.equal(render('%2d', [12345]), '12345', 'width is a minimum, never a limit');
    assert.equal(render('%3c|', [0x41]), '  A|');
    assert.equal(render('%8s|', [HELLO]), '   world|');
    assert.equal(render('%-8s|', [HELLO]), 'world   |');
});

test('the zero flag pads digits, but never at the cost of the sign', ()=>{
    assert.equal(render('%05d', [42]), '00042');
    assert.equal(render('%05d', [-42]), '-0042');
    assert.equal(render('%08x', [0xbeef]), '0000beef');
});

test('left alignment wins over zero padding, as C says it must', ()=>{
    assert.equal(render('%-05d|', [42]), '42   |');
});

test('zero padding is for numbers only', ()=>{
    assert.equal(render('%08s|', [HELLO]), '   world|');
});

test('precision sets a minimum digit count and a maximum string length', ()=>{
    assert.equal(render('%.5d', [42]), '00042');
    assert.equal(render('%8.5d|', [42]), '   00042|');
    assert.equal(render('%.3s', [LONG]), 'abc');
    assert.equal(render('%6.3s|', [LONG]), '   abc|');
    assert.equal(render('%-6.3s|', [LONG]), 'abc   |');
    assert.equal(render('%.2s', [EMPTY]), '');
});

test('a precision disables the zero flag', ()=>{
    assert.equal(render('%08.5d|', [42]), '   00042|');
});

test('size modifiers are accepted and change nothing on a 32-bit target', ()=>{
    assert.equal(render('%ld', [-3]), '-3');
    assert.equal(render('%lu', [-3]), '4294967293');
    assert.equal(render('%hd', [3]), '3');
    assert.equal(render('%08lx', [0xbeef]), '0000beef');
});

test('a format no argument satisfies still produces output', ()=>{
    // Undefined behaviour in C, and a real possibility in a guest: the format
    // string is data. Missing arguments read as zero rather than crashing, and
    // a zero char is the NUL byte C would have written.
    assert.equal(render('%d and %s and [%c]', []), '0 and (null) and [\u0000]');
    assert.equal(render('%s %s', [HELLO]), 'world (null)');
});

test('an unrecognised conversion is emitted verbatim', ()=>{
    assert.equal(render('%q'), '%q');
    assert.equal(render('%5.2q'), '%5.2q');
    assert.equal(render('a%zb', [1]), 'a%zb');
});

test('a format ending inside a specifier stops there', ()=>{
    assert.equal(render('end%'), 'end%');
    assert.equal(render('end%-05'), 'end%');
});

test('a narrow format under the C locale reads %S and %ls as wide text, a byte a character', ()=>{
    // Wine's msvcrt test_sprintf: %S, %ls and %ws of L"wide" are "wide", %Ls
    // is narrow, %C of U+3042 writes nothing where %c writes a low byte, and
    // %S of it writes nothing on the older runtimes (the later answer -1).
    const wide = new Map([[0x500, 'wide'], [0x600, 'あ'], [0x700, 'abあcd']]);
    /** @param {string} format @param {number[]} varargs */
    const narrow = (format, varargs)=>formatToString(format, varargs, readString,
        { readWideString: pointer=>wide.get(pointer) ?? '', cLocale: true });
    assert.equal(narrow('%S', [0x500]), 'wide');
    assert.equal(narrow('%ls', [0x500]), 'wide');
    assert.equal(narrow('%-10ws', [0x500]), 'wide      ');
    assert.equal(narrow('%10ws', [0x500]), '      wide');
    assert.equal(narrow('%Ls', [HELLO]), 'world');
    assert.equal(narrow('a%Cb', [0x3042]), 'ab');
    assert.equal(narrow('%C', [0x61]), 'a');
    assert.equal(narrow('%c', [0xa082]), '\x82');
    assert.equal(narrow('%S', [0x600]), '');
    assert.equal(narrow('%S|', [0x700]), 'ab|', 'the string stops where a byte cannot follow');
    assert.equal(formatToString('%C', [0x3042], readString), 'あ',
        'without the option the character is left to the caller');
});
