/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guestOver } from '../common/guest.fixture.js';
import { createStringOperations, parseInteger } from './string-ops.js';
import { unitsFromUtf8, utf8FromUnits } from '../kernel32/utf8.js';
import { STATUS } from './status.js';

const SOURCE = 0x100;
const DEST = 0x200;
const OUT = 0x300;
const TEXT = 0x400;

function machine(){
    const bytes = new Uint8Array(0x4000);
    const view = new DataView(bytes.buffer);
    let next = 0x2000;
    const ops = createStringOperations({
        guest: guestOver(bytes),
        allocate: size=>{
            const at = next;
            next += size + 15 & ~15;
            return at;
        },
    });
    /** @param {string} name @param {...number} args */
    const call = (name, ...args)=>/** @type {any} */ (ops)[name].handler(args) >>> 0;
    /** @param {number} at */
    const descriptor = at=>({ length: view.getUint16(at, true),
        maximum: view.getUint16(at + 2, true), buffer: view.getUint32(at + 4, true) });
    /** @param {number} at @param {string} text */
    const counted = (at, text)=>{
        for (let index = 0; index < text.length; index++)
        {
            view.setUint16(TEXT + index * 2, text.charCodeAt(index), true);
        }
        view.setUint16(at, text.length * 2, true);
        view.setUint16(at + 2, text.length * 2 + 2, true);
        view.setUint32(at + 4, TEXT, true);
    };
    return { view, call, descriptor, counted };
}

test('UTF-8 is read as Windows reads it: a bad second byte takes the lead with it', ()=>{
    /** @param {number[]} bytes */
    const read = bytes=>unitsFromUtf8(Uint8Array.from(bytes)).units.flat();
    assert.deepEqual(read([0x2d, 0xe0, 0x80, 0xad, 0x2d]), [0x2d, 0xfffd, 0xfffd, 0x2d],
        'an overlong form: the lead and its first continuation, then the rest');
    assert.deepEqual(read([0xed, 0xa0, 0x80]), [0xfffd, 0xfffd], 'a surrogate encoded');
    assert.deepEqual(read([0xe0, 0xa0, 0x2d]), [0xfffd, 0x2d], 'a sequence cut short is one');
    assert.deepEqual(read([0xfa, 0x80]), [0xfffd, 0xfffd], 'a lead no sequence has');
    assert.deepEqual(read([0xf0, 0x90, 0x80, 0x80]), [0xd800, 0xdc00]);
    assert.equal(unitsFromUtf8(Uint8Array.of(0x41)).unmapped, false);
    assert.deepEqual(utf8FromUnits([0x58, 0xd800]).bytes.flat(), [0x58, 0xef, 0xbf, 0xbd],
        'half a pair alone is U+FFFD');
    assert.equal(utf8FromUnits([0xd800]).unmapped, true);
});

test('a number is read after blanks and a sign, base 0 choosing by its prefix', ()=>{
    assert.equal(parseInteger('  -12', 10), (-12) >>> 0);
    assert.equal(parseInteger('0x1F', 0), 31);
    assert.equal(parseInteger('0b101', 0), 5);
    assert.equal(parseInteger('0o17', 0), 15);
    assert.equal(parseInteger('12z', 10), 12);
    assert.equal(parseInteger('', 10), 0);
    assert.equal(parseInteger('1', 7), null);
});

test('a duplicate is terminated or allocated as its flags say, and a bad source refused', ()=>{
    const { call, counted, descriptor } = machine();
    counted(SOURCE, 'abc');
    assert.equal(call('RtlDuplicateUnicodeString', 1, SOURCE, DEST), STATUS.SUCCESS);
    assert.deepEqual([descriptor(DEST).length, descriptor(DEST).maximum], [6, 8]);
    assert.equal(call('RtlDuplicateUnicodeString', 0, SOURCE, DEST), STATUS.SUCCESS);
    assert.deepEqual([descriptor(DEST).length, descriptor(DEST).maximum], [6, 6]);
    assert.equal(call('RtlDuplicateUnicodeString', 2, SOURCE, DEST), STATUS.INVALID_PARAMETER,
        '2 goes only with 1');
    counted(SOURCE, '');
    assert.equal(call('RtlDuplicateUnicodeString', 0, SOURCE, DEST), STATUS.SUCCESS);
    assert.deepEqual(descriptor(DEST), { length: 0, maximum: 0, buffer: 0 });
    assert.equal(call('RtlDuplicateUnicodeString', 3, SOURCE, DEST), STATUS.SUCCESS);
    assert.deepEqual([descriptor(DEST).length, descriptor(DEST).maximum], [0, 2]);
});

test('the hash is X65599, upper-cased when asked; a search says where in bytes', ()=>{
    const { view, call, counted } = machine();
    counted(SOURCE, 'Test');
    assert.equal(call('RtlHashUnicodeString', SOURCE, 0, 0, OUT), STATUS.SUCCESS);
    assert.equal(view.getUint32(OUT, true), 0x766bb952);
    call('RtlHashUnicodeString', SOURCE, 1, 0, OUT);
    assert.equal(view.getUint32(OUT, true), 0x6689c132);
    assert.equal(call('RtlHashUnicodeString', SOURCE, 0, 2, OUT), STATUS.INVALID_PARAMETER);
});

test('an append of nothing succeeds, and one that does not fit changes nothing', ()=>{
    const { view, call } = machine();
    view.setUint16(DEST, 4, true);
    view.setUint16(DEST + 2, 0, true);
    view.setUint32(DEST + 4, TEXT, true);
    view.setUint16(SOURCE, 0, true);
    assert.equal(call('RtlAppendStringToString', DEST, SOURCE), STATUS.SUCCESS);
    view.setUint16(SOURCE, 2, true);
    view.setUint16(SOURCE + 2, 2, true);
    view.setUint32(SOURCE + 4, TEXT + 0x100, true);
    assert.equal(call('RtlAppendStringToString', DEST, SOURCE), STATUS.BUFFER_TOO_SMALL);
    assert.equal(view.getUint16(DEST, true), 4);
});

test('an ANSI character becomes its WCHAR and the pointer moves past it', ()=>{
    const { view, call } = machine();
    view.setUint8(TEXT, 0x80);
    view.setUint32(OUT, TEXT, true);
    assert.equal(call('RtlAnsiCharToUnicodeChar', OUT), 0x20ac, 'the euro sign of page 1252');
    assert.equal(view.getUint32(OUT, true), TEXT + 1);
});

test('RtlFormatMessage: what an overflow and a fault leave, and the va_list used up', ()=>{
    const { view, call } = machine();
    const MESSAGE = 0x100;
    const LIST = 0x300;
    const ARGS = 0x310;
    const BUFFER = 0x400;
    const SIZE = 0x480;
    const ARGUMENT = 0x500;
    const BUFFER_OVERFLOW = 0x80000005;
    const INVALID_PARAMETER = 0xc000000d;
    /** @param {number} at @param {string} text */
    const put = (at, text)=>{
        [...text, '\0'].forEach((c, i)=>view.setUint16(at + i * 2, c.charCodeAt(0), true));
    };
    /** @param {number} length */
    const read = length=>Array.from({ length },
        (_, i)=>String.fromCharCode(view.getUint16(BUFFER + i * 2, true))).join('');
    /** @param {string} message @param {number} size @param {number[]} args */
    const format = (message, size, args)=>{
        put(MESSAGE, message);
        put(BUFFER, 'xxxxxxxxxx');
        view.setUint32(LIST, ARGS, true);
        args.forEach((value, i)=>view.setUint32(ARGS + i * 4, value, true));
        view.setUint32(SIZE, 0xdeadbeef, true);
        return call('RtlFormatMessage', MESSAGE, 0, 0, 0, 0, LIST, BUFFER, size, SIZE);
    };
    put(ARGUMENT, 'test');
    assert.equal(format('testing', 8, []), BUFFER_OVERFLOW);
    assert.equal(read(10), 'testxxxxxx', 'the message\'s own characters, unterminated');
    assert.equal(view.getUint32(SIZE, true), 0xdeadbeef);
    assert.equal(format('%1', 8, [ARGUMENT]), BUFFER_OVERFLOW);
    assert.equal(read(10), 'tes\0xxxxxx', 'an insert cut, terminated');
    assert.equal(format('ab%n', 6, []), BUFFER_OVERFLOW);
    assert.equal(read(10), 'abxxxxxxxx', 'an escape that does not fit, not at all');
    assert.equal(format('%1!u! %2!u', 20, [34]), INVALID_PARAMETER);
    assert.equal(read(10), '34 xxxxxxx', 'what came before the fault stays');

    assert.equal(format('%1!s! %2!s!', 1, [ARGUMENT, ARGUMENT]), BUFFER_OVERFLOW);
    assert.equal(read(10), 'xxxxxxxxxx', 'no room for any of it');
    assert.equal(view.getUint32(LIST, true), ARGS + 4, 'the first argument was read');
});
