/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMessageText } from './format-message.js';

const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;

/** Strings by the address a slot holds for them. */
const STRINGS = new Map([[0x100, 'test'], [0x104, 't'], [0x108, 'eaten'], [0x10c, 'unused']]);

/**
 * @param {string} source
 * @param {{ args?: number[] | null, array?: boolean, width?: number, ignore?: boolean,
 *           room?: number }} [options]
 */
const format = (source, options = {})=>formatMessageText(source, {
    wide: true,
    ignoreInserts: options.ignore ?? false,
    width: options.width ?? 0,
    args: options.args === null || options.args === undefined ? null
        : { array: options.array ?? false, read: slot=>options.args?.[slot] ?? 0 },
    readString: address=>STRINGS.get(address) ?? '',
    room: options.room,
});

/** @param {string} source @param {{ args?: number[] | null, array?: boolean, width?: number, ignore?: boolean }} [options] */
const text = (source, options)=>{
    const formatted = format(source, options);
    assert.equal(formatted.error, 0, source);
    return formatted.text;
};

test('the escapes: %0 ends, %n %r %t, and %, ., !, space and any other character as itself', ()=>{
    // Wine's format_msg.c test_message_from_string.
    assert.equal(text('test%0test'), 'test');
    assert.equal(text('yah%!%0   '), 'yah!');
    assert.equal(text('% %   '), '    ');
    assert.equal(text(' %%%% '), ' %% ');
    assert.equal(text(' %.%.  ', { args: [] }), ' ..  ');
    assert.equal(text('%n%r%t'), '\r\n\r\t');
    assert.equal(text('hi\n'), 'hi\r\n');
    assert.equal(text('\r\r\n'), '\r\n\r\n');
    assert.equal(format('test%').error, ERROR_INVALID_PARAMETER);
    assert.equal(format('test%').text, 'test', 'what was formatted before the error');
    assert.equal(format('%1').error, ERROR_INVALID_PARAMETER, 'an insert with no arguments');
});

test('with IGNORE_INSERTS only %0, %n, %r and %t are escapes', ()=>{
    assert.equal(text('test%1%2!*.*s!%99', { ignore: true }), 'test%1%2!*.*s!%99');
    assert.equal(text('%%% %.%!', { ignore: true }), '%%% %.%!');
    assert.equal(text('%n%r%t%0x', { ignore: true }), '\r\n\r\t');
});

test('inserts: strings, characters and numbers as printf writes them', ()=>{
    assert.equal(text('%1!s!', { args: [0x100] }), 'test');
    assert.equal(text('%1', { args: [0x100] }), 'test');
    assert.equal(text('%1', { args: [0] }), '(null)');
    assert.equal(text('%1%3%2%1', { args: [0x104, 0x100, 0x108] }), 'teatentestt');
    assert.equal(text('%1!c!%2!lc!%3!C!', { args: [0x74, 0x65, 0x73] }), 'tes');
    assert.equal(text('%1!4d!|%1!-4d!|%2!4X!|%2!#x!', { args: [1, 0x1ab] }),
        '   1|1   | 1AB|0x1ab');
    assert.equal(text('%1!4.2u!', { args: [3] }), '  03');
    assert.equal(text('%1!3s!', { args: [0x104] }), '  t');
    assert.equal(text('%1!I64u!', { args: [0xffffffff, 0xffffffff] }), '18446744073709551615');
    assert.equal(text('%1!I64d!', { args: [0xffffffff, 0xffffffff] }), '-1');
});

test('a * from a va_list is the next argument read; an insert seen before is what it was', ()=>{
    assert.equal(text('%1!*s!', { args: [4, 0x104] }), '   t');
    assert.equal(text('%1!*.*u!,%1!*.*u!', { args: [5, 3, 1, 4, 2] }), '  001, 0002');
    assert.equal(text('%1!*.*u!,%3!*.*u!', { args: [5, 3, 1, 6, 4, 2] }), '  001,  0002');
});

test('a * from an array is the insert\'s slot, then the slots after the last one used', ()=>{
    const args = [6, 4, 2, 5, 3, 1];
    assert.equal(text('%1!*.*u!,%1!*.*u!', { args, array: true }), '  0002, 00003');
    assert.equal(text('%1!*.*u!,%4!*.*u!', { args, array: true }), '  0002,  001');
});

test('a width breaks a line before it, at its last space, or where it is full', ()=>{
    // Wine's format_msg.c test_message_wrap.
    const cases = /** @type {[number, string, string][]} */ ([
        [20, 'short long line', 'short long line'],
        [11, 'short long line', 'short long\r\nline'],
        [20, 'short long long line', 'short long long\r\nline'],
        [10, 'short long line', 'short\r\nlong line'],
        [16, 'short long    line', 'short long\r\nline'],
        [12, 'short long    line', 'short long\r\n  line'],
        [12, 'short long    wordlongerthanaline', 'short long\r\n\r\nwordlongerth\r\nanaline'],
        [11, '   shortlong line', '\r\nshortlong\r\nline'],
        [5, '                ', '\r\n\r\n\r\n '],
        [8, 'shortlon', 'shortlon\r\n'],
        [8, 'shortlongline', 'shortlon\r\ngline'],
        [11, 'short\nlong line', 'short long\r\nline'],
        [8, 'short%rlong line', 'short\rlong\r\nline'],
        [11, 'short long\tline', 'short\r\nlong\tline'],
        [0xff, 'hi\r\n', 'hi '],
        [0xff, '\r\r\n', '  '],
    ]);
    for (const [width, source, expected] of cases)
    {
        assert.equal(text(source, { width }), expected, `${width}: ${JSON.stringify(source)}`);
    }
});

test('a text longer than the room stops before the next argument is read', ()=>{
    const formatted = format('%1!s! %2!s!', { args: [0x108, 0x10c], room: 0 });
    assert.equal(formatted.error, ERROR_INSUFFICIENT_BUFFER);
    assert.equal(formatted.reads, 1);
});
