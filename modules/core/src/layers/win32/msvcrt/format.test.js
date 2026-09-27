/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatToString, guestAccess } from './format.js';

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

test('zero padding is for every conversion but a pointer', ()=>{
    // Wine's msvcrt test_sprintf: "%04s" of "foo" is "0foo", "%04c" "0001".
    assert.equal(render('%08s|', [HELLO]), '000world|');
    assert.equal(render('%04c|', [0x31]), '0001|');
    assert.equal(render('%#012p|', [57]), '  0X00000039|');
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

test('an unrecognised conversion is its own character, the specification before it dropped',
    ()=>{
        assert.equal(render('%q'), 'q');
        assert.equal(render('%5.2q'), 'q');
        assert.equal(render('a%zb', [1]), 'azb');
        assert.equal(render('%I|%z|%t'), 'I|z|t', 'and at the format\'s end');
        assert.equal(render('%w0s'), '0s', 'a modifier the conversion does not follow');
        assert.equal(render('%Iq %I64D'), 'Iq D', 'I alone before no integer conversion');
        assert.equal(render('%Ix|%zx|%tx', [0x123456, 1, 2]), '123456|1|2');
    });

test('a format ending inside a specifier writes none of it', ()=>{
    assert.equal(render('end%'), 'end');
    assert.equal(render('end%-05'), 'end');
    assert.equal(render('end%3h'), 'end');
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

/** A double's two stack slots, low word first. @param {number} value */
const slots = value=>{
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value, true);
    return [view.getUint32(0, true), view.getUint32(4, true)];
};

/** The x87's indefinite: a quiet NaN with the sign and no payload. */
const INDEFINITE = [0, 0xfff80000];

test('%e writes an exponent of three digits at least, and # keeps the point', ()=>{
    assert.equal(render('%+#23.15e', slots(789456123)), '+7.894561230000000e+008');
    assert.equal(render('%2.4e', slots(8.6)), '8.6000e+000');
    assert.equal(render('% 014.4e', slots(8.6)), ' 008.6000e+000');
    assert.equal(render('%E', slots(1e-300)), '1.000000E-300');
    assert.equal(render('%e', slots(0)), '0.000000e+000');
    assert.equal(render('%#.0e', slots(3)), '3.e+000');
});

test('%g chooses its form by the exponent at its precision, and drops the fraction\'s zeros',
    ()=>{
        assert.equal(render('%g', slots(0.0005)), '0.0005');
        assert.equal(render('%g', slots(0.00005)), '5e-005');
        assert.equal(render('%g', slots(999999999999999)), '1e+015');
        assert.equal(render('%.15g', slots(999999999999999)), '999999999999999');
        assert.equal(render('%2.4g', slots(8.6)), '8.6');
        assert.equal(render('%#1.1g', slots(789456123)), '8.e+008');
        assert.equal(render('%g', slots(0)), '0');
        assert.equal(render('%g', slots(100000)), '100000');
    });

test('a float is converted to seventeen significant digits and rounded from them, half up',
    ()=>{
        assert.equal(render('%.30f', slots(1 / 3)), '0.333333333333333310000000000000');
        assert.equal(render('%.15f', slots(Math.PI)), '3.141592653589793');
        assert.equal(render('%.13f', slots(37.866261574537077)), '37.8662615745371');
        assert.deepEqual(['%.0f', '%.0f', '%.0f', '%.0f'].map((format, i)=>
            render(format, slots([-1.5, -0.5, 0.5, 1.5][i]))), ['-2', '-1', '1', '2']);
        assert.equal(render('%#.0f', slots(2)), '2.');
    });

test('an infinity and the NaNs are msvcrt\'s digits that are not digits, rounded as digits',
    ()=>{
        assert.equal(render('%lf', INDEFINITE), '-1.#IND00');
        assert.equal(render('%lf', slots(NaN)), '1.#QNAN0');
        assert.equal(render('%lf', slots(Infinity)), '1.#INF00');
        assert.equal(render('%le', slots(-Infinity)), '-1.#INF00e+000');
        assert.equal(render('%lg', INDEFINITE), '-1.#IND');
        assert.equal(render('%lg', slots(NaN)), '1.#QNAN');
        assert.equal(render('%010.2lf', INDEFINITE), '-000001.#J', 'I rounded up to J');
        assert.equal(render('%010.2lf', slots(NaN)), '0000001.#R');
        assert.equal(render('%lf', [0, 0x7ff00001]), '1.#SNAN0');
    });

test('h makes an integer its low sixteen bits, and the modifiers run together', ()=>{
    assert.equal(render('%hx|%hhx|%hd', [0x12345, 0x123, 0x18000]), '2345|123|-32768');
    assert.equal(render('%I64d|%lld', [0xffffffff, 0xffffffff, 1, 0]), '-1|1');
    assert.equal(render('%#+ -03whlls|', [HELLO]), 'world|');
});

test('%Z prints a counted string and %n writes the count, where the guest memory is given', ()=>{
    const memory = new Uint8Array(0x1000);
    const view = new DataView(memory.buffer);
    const read = (/** @type {number} */ at, /** @type {number} */ length)=>
        memory.subarray(at, at + length);
    const write = (/** @type {number} */ at, /** @type {Uint8Array} */ bytes)=>
        memory.set(bytes, at);
    memory.set([...'not wide'].map(c=>c.charCodeAt(0)), 0x100);
    view.setUint16(0x10, 2, true);
    view.setUint32(0x14, 0x100, true);
    [...'wide'].forEach((c, i)=>view.setUint16(0x200 + i * 2, c.charCodeAt(0), true));
    view.setUint16(0x20, 4, true);
    view.setUint32(0x24, 0x200, true);
    view.setUint32(0x34, 0, true);
    const options = { ...guestAccess(read, write) };
    assert.equal(formatToString('%Z|%wZ|%Z|%Z', [0x10, 0x20, 0, 0x30], readString, options),
        'no|wi|(null)|(null)');
    assert.equal(formatToString('asdf%n!', [0x40], readString, options), 'asdf!');
    assert.equal(view.getInt32(0x40, true), 4);
});
