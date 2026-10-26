/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsvcrtFunctions } from './functions.js';
import { doubleSlots, fakeMemory, fakeVolume } from './harness.test.js';
import { decodeAnsi } from '../kernel32/locale.js';
import { COMPILED } from './inguest.x86.js';

/**
 * A stand-in for guest memory, with the same contract as the real one.
 *
 * `readMemory` hands back a copy, which is the contract the memory layer
 * actually offers: a read is a snapshot, so a caller that reads two ranges and
 * then writes one still holds what the other said. A fake that is harsher than
 * the real thing invents bugs instead of finding them.
 */
function fakeHost(size = 0x1000){
    const bytes = new Uint8Array(size);
    /** @type {Map<number, (args: number[]) => number>} */
    const guests = new Map();
    /** @type {{ handle: number, text: string }[]} */
    const output = [];
    /** Bytes the handlers asked memory for, reads only; tests reset it. */
    let asked = 0;

    return {
        bytes,
        output,
        guests,
        /** @type {(address: number) => { base: number, size: number } | null} */
        regionAt: ()=>null,
        get asked(){
            return asked;
        },
        set asked(value){
            asked = value;
        },
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>{
            asked += length;
            return bytes.slice(address, address + length);
        },
        /**
         * Written a byte at a time, ascending, which is what a store into guest
         * memory amounts to: a caller that hands over a view of the range it is
         * about to overwrite gets exactly the corruption it asked for.
         *
         * @param {number} address @param {Uint8Array} data
         */
        writeMemory(address, data){
            for (let i = 0; i < data.length; i++)
            {
                bytes[address + i] = data[i];
            }
        },
        /** @param {number} address @param {number} value @param {number} length */
        fillMemory(address, value, length){
            bytes.fill(value, address, address + length);
        },
        /**
         * As the memory layer reads an ANSI string: in Windows-1252, which is
         * what the Encoding standard calls latin1.
         *
         * @param {number} address @param {number} maxLength
         */
        readCString(address, maxLength){
            let end = address;
            while (end - address < maxLength && end < bytes.length)
            {
                asked++;
                if (bytes[end] === 0)
                {
                    break;
                }
                end++;
            }
            return decodeAnsi(bytes.subarray(address, end));
        },
        /**
         * @param {number} address @param {number} limit
         * @param {Uint8Array} [wanted]
         */
        scanCString: (address, limit, wanted = new Uint8Array(256))=>{
            for (let at = 0; at < limit; at += 256)
            {
                const length = Math.max(0, Math.min(256, limit - at, size - address - at));
                asked += length;
                const chunk = bytes.subarray(address + at, address + at + length);
                for (let i = 0; i < chunk.length; i++)
                {
                    const byte = chunk[i];
                    if (byte === 0 || wanted[byte] !== 0)
                    {
                        return { index: at + i, byte };
                    }
                }
            }
            throw new Error(`No NUL within ${limit} bytes of 0x${address.toString(16)}`);
        },
        /** @param {number} handle @param {string} text */
        write: (handle, text)=>output.push({ handle, text }),

        /**
         * Stands in for the bridge: the guest routine is a host function here,
         * so a test can say what the program's own code would have decided.
         *
         * @param {number} entry @param {number[]} args
         */
        callGuest: (entry, args)=>Promise.resolve(guests.get(entry)?.(args) ?? 0),
    };
}

function setup(){
    const host = fakeHost();
    const fns = createMsvcrtFunctions(host);

    /**
     * Places a NUL-terminated string and answers with its address.
     *
     * @param {number} address @param {string} text
     */
    const put = (address, text)=>{
        for (let i = 0; i < text.length; i++)
        {
            host.bytes[address + i] = text.charCodeAt(i) & 0xff;
        }
        host.bytes[address + text.length] = 0;
        return address;
    };

    /** Reads back what the guest would read back. @param {number} address */
    const at = address=>host.readCString(address, 64);

    return { host, fns, put, at };
}

test('strlen counts bytes up to the terminator', ()=>{
    const { fns, put } = setup();
    assert.equal(fns.strlen.handler([put(0x100, 'hello')]), 5);
    assert.equal(fns.strlen.handler([put(0x200, '')]), 0);
});

test('strcmp reports the sign of the first difference', ()=>{
    const { fns, put } = setup();
    const a = put(0x100, 'abc');
    const b = put(0x110, 'abc');
    const c = put(0x120, 'abd');
    const prefix = put(0x130, 'ab');

    assert.equal(fns.strcmp.handler([a, b]), 0);
    assert.equal(fns.strcmp.handler([a, c]), -1);
    assert.equal(fns.strcmp.handler([c, a]), 1);
    assert.equal(fns.strcmp.handler([prefix, a]), -1, 'the terminator sorts below any byte');
    assert.equal(fns.strcmp.handler([put(0x140, ''), put(0x150, '')]), 0);
});

test('the comparisons order bytes as unsigned chars, the upper half of the page included', ()=>{
    // As msvcrt.dll compares, and not by the characters the ANSI page gives
    // those bytes: 0x80, the euro sign there, sorts below 0xa0.
    const { fns: table, put } = setup();
    const fns = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        /** @type {unknown} */ (table));
    const euro = put(0x100, '\x80');
    const space = put(0x110, '\xa0');
    const last = put(0x120, '\x9f');
    const top = put(0x130, '\xff');
    for (const name of ['strcmp', '_stricmp', '_strcmpi'])
    {
        assert.equal(fns[name].handler([euro, space]), -1, name);
        assert.equal(fns[name].handler([space, euro]), 1, name);
        assert.equal(fns[name].handler([last, top]), -1, name);
    }
    assert.equal(fns._strnicmp.handler([euro, space, 1]), -1);
    assert.equal(fns._strnicmp.handler([top, last, 1]), 1);
    assert.equal(fns.strncmp.handler([euro, space, 1]), 0x80 - 0xa0,
        'strncmp answers the difference of the bytes');
    assert.equal(fns.strncmp.handler([top, last, 1]), 0xff - 0x9f);
    assert.equal(fns._stricmp.handler([put(0x140, 'A\x80'), put(0x150, 'a\xa0')]), -1,
        'folded ASCII first, then the byte');
    assert.equal(fns._stricmp.handler([put(0x160, '\xc9'), put(0x170, '\xe9')]), -1,
        'and no letter past ASCII is folded');
});

test('strncmp stops after n bytes, and n of zero compares nothing', ()=>{
    const { fns, put } = setup();
    const a = put(0x100, 'abcX');
    const b = put(0x110, 'abcY');

    assert.equal(fns.strncmp.handler([a, b, 3]), 0);
    assert.equal(fns.strncmp.handler([a, b, 4]), -1);
    assert.equal(fns.strncmp.handler([a, b, 0]), 0);
    assert.equal(fns.strncmp.handler([a, b, 99]), -1, 'n past both terminators is harmless');
    assert.equal(fns.strncmp.handler([put(0x120, ''), put(0x130, 'abc'), 3]), -0x61,
        'the terminator against a letter');
});

test('under the C locale each collating comparison is its ordinal one, narrow and wide', ()=>{
    const { host, fns: table, put } = setup();
    const fns = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        /** @type {unknown} */ (table));
    /** @param {number} address @param {string} text */
    const putWide = (address, text)=>{
        [...text, '\0'].forEach((c, at)=>{
            host.bytes[address + at * 2] = c.charCodeAt(0);
            host.bytes[address + at * 2 + 1] = 0;
        });
        return address;
    };
    /** @type {[string, string, string, number | null, number][]} */
    const cases = [['_strncoll', 'ABC', 'ABCD', 3, 0], ['_strncoll', 'ABC', 'ABCD', 10, -1],
        ['_strncoll', 'ABCD', 'ABC', 10, 1], ['_strncoll', 'AB D', 'AB-D', 4, -1],
        ['_strnicoll', 'abc', 'ABCD', 3, 0], ['_strnicoll', 'abc', 'ABCD', 10, -1],
        ['_strnicoll', 'abcd', 'ABC', 10, 1], ['_strnicoll', 'abce', 'ABCf', 3, 0],
        ['_stricoll', 'abcd', 'ABCD', null, 0], ['_stricoll', 'abc', 'ABCD', null, -1]];
    for (const [name, left, right, count, sign] of cases)
    {
        const narrowArgs = [put(0x100, left), put(0x140, right), ...count === null ? [] : [count]];
        const wideArgs = [putWide(0x200, left), putWide(0x280, right),
            ...count === null ? [] : [count]];
        const wideName = name.replace('_str', '_wcs');
        assert.equal(Math.sign(fns[name].handler(narrowArgs) | 0), sign, `${name} ${left}`);
        assert.equal(Math.sign(fns[wideName].handler(wideArgs) | 0), sign, `${wideName} ${left}`);
    }
    assert.equal(Math.sign(fns.wcscoll.handler([putWide(0x200, 'ABC'), putWide(0x280, 'ABCD')])
        | 0), -1);
});

test('_stricmp ignores case, and only for ASCII letters', ()=>{
    const { fns, put } = setup();
    assert.equal(fns._stricmp.handler([put(0x100, 'Hello'), put(0x110, 'hELLO')]), 0);
    assert.equal(fns._stricmp.handler([put(0x120, 'abc'), put(0x130, 'ABD')]), -1);
    assert.equal(fns._stricmp.handler([put(0x140, 'B'), put(0x150, 'a')]), 1);
    assert.equal(fns._strcmpi.handler([put(0x160, 'Hello'), put(0x170, 'hELLO')]), 0,
        '_strcmpi is the same function');
});

test('strcpy copies the terminator too and returns the destination', ()=>{
    const { fns, put, at } = setup();
    const dst = 0x200;

    assert.equal(fns.strcpy.handler([dst, put(0x100, 'hello')]), dst);
    assert.equal(at(dst), 'hello');
    assert.equal(fns.strcpy.handler([dst, put(0x110, 'hi')]), dst);
    assert.equal(at(dst), 'hi', 'the shorter copy terminates where it ends');
});

test('strncpy truncates without terminating, and pads short copies with NULs', ()=>{
    const { fns, host, put, at } = setup();

    host.bytes[0x203] = 0x7f;
    assert.equal(fns.strncpy.handler([0x200, put(0x100, 'abcdef'), 3]), 0x200);
    assert.equal(host.bytes[0x203], 0x7f, 'a truncating strncpy writes no terminator');

    host.bytes.fill(0xff, 0x300, 0x310);
    fns.strncpy.handler([0x300, put(0x110, 'ab'), 5]);
    assert.equal(at(0x300), 'ab');
    assert.deepEqual(Array.from(host.bytes.subarray(0x300, 0x306)),
        [0x61, 0x62, 0, 0, 0, 0xff], 'the whole count is padded, and not a byte more');

    host.bytes[0x400] = 0x7f;
    fns.strncpy.handler([0x400, put(0x120, 'zz'), 0]);
    assert.equal(host.bytes[0x400], 0x7f, 'a count of zero writes nothing');
});

test('strcat appends at the terminator and returns the destination', ()=>{
    const { fns, put, at } = setup();
    const dst = put(0x200, 'foo');

    assert.equal(fns.strcat.handler([dst, put(0x100, 'bar')]), dst);
    assert.equal(at(dst), 'foobar');
    fns.strcat.handler([dst, put(0x110, '')]);
    assert.equal(at(dst), 'foobar');
});

test('strchr finds a byte, the terminator, or nothing at all', ()=>{
    const { fns, put } = setup();
    const s = put(0x100, 'hello');

    assert.equal(fns.strchr.handler([s, 0x6c]), 0x102, 'the first match, not the last');
    assert.equal(fns.strchr.handler([s, 0x7a]), 0);
    assert.equal(fns.strchr.handler([s, 0]), 0x105, 'the terminator is part of the string');
    assert.equal(fns.strchr.handler([s, 0x16c]), 0x102, 'the byte is what is compared');
});

test('strchr reads the chunk its answer is in, not the megabyte behind it', ()=>{
    const host = fakeHost(0x120000);
    const fns = createMsvcrtFunctions(host);
    // A byte under the scan limit, or the terminator is outside what a string
    // of this runtime may reach and the walk is right to refuse it.
    const size = (1 << 20) - 1;
    const string = 0x1000;
    host.bytes.fill(0x61, string, string + size);
    host.bytes[string + 3] = 0x78; // the byte asked for, at byte 3
    host.bytes[string + size] = 0;

    host.asked = 0;
    assert.equal(fns.strchr.handler([string, 0x78]), string + 3);
    assert.ok(host.asked < 4096,
        `the answer at byte 3 costs what the walk read: ${host.asked} bytes`);

    // A miss still walks to the terminator, and a search for the terminator
    // finds the end of a string longer than any chunk.
    assert.equal(fns.strchr.handler([string, 0x7a]), 0);
    assert.equal(fns.strchr.handler([string, 0]), string + size);
    assert.equal(fns.strlen.handler([string]), size, 'a length counted across chunks');
});

test('strstr finds a substring, and an empty needle matches immediately', ()=>{
    const { fns, put } = setup();
    const hay = put(0x100, 'abcabd');

    assert.equal(fns.strstr.handler([hay, put(0x200, 'abd')]), 0x103);
    assert.equal(fns.strstr.handler([hay, put(0x210, 'xyz')]), 0);
    assert.equal(fns.strstr.handler([hay, put(0x220, '')]), hay);
    assert.equal(fns.strstr.handler([hay, put(0x230, 'abcabd')]), hay);
});

test('toupper and tolower touch letters and nothing else', ()=>{
    const { fns } = setup();
    assert.equal(fns.toupper.handler([0x61]), 0x41);
    assert.equal(fns.toupper.handler([0x41]), 0x41);
    assert.equal(fns.toupper.handler([0x39]), 0x39);
    assert.equal(fns.toupper.handler([-1]) | 0, -1, 'EOF passes through');
    assert.equal(fns.tolower.handler([0x5a]), 0x7a);
    assert.equal(fns.tolower.handler([0x7a]), 0x7a);
    assert.equal(fns.tolower.handler([0x5f]), 0x5f);
});

test('memcpy moves bytes and returns the destination', ()=>{
    const { fns, host, put, at } = setup();
    put(0x100, 'hello');

    assert.equal(fns.memcpy.handler([0x200, 0x100, 6]), 0x200);
    assert.equal(at(0x200), 'hello');
    host.bytes[0x300] = 0x7f;
    assert.equal(fns.memcpy.handler([0x300, 0x100, 0]), 0x300);
    assert.equal(host.bytes[0x300], 0x7f, 'a count of zero copies nothing');
});

test('memmove is correct when the ranges overlap, in either direction', ()=>{
    const { fns, put, at } = setup();

    put(0x100, 'abcdef');
    assert.equal(fns.memmove.handler([0x101, 0x100, 5]), 0x101);
    assert.equal(at(0x100), 'aabcde', 'shifting up must not read what it already wrote');

    put(0x200, 'abcdef');
    fns.memmove.handler([0x200, 0x201, 5]);
    assert.equal(at(0x200), 'bcdeff', 'shifting down leaves the tail behind');
});

test('memset fills with the low byte and returns the destination', ()=>{
    const { fns, host } = setup();

    assert.equal(fns.memset.handler([0x100, 0x141, 4]), 0x100);
    assert.deepEqual(Array.from(host.bytes.subarray(0x100, 0x105)), [0x41, 0x41, 0x41, 0x41, 0]);
    host.bytes[0x200] = 0x7f;
    fns.memset.handler([0x200, 0xff, 0]);
    assert.equal(host.bytes[0x200], 0x7f, 'a count of zero fills nothing');
});

test('memcmp compares bytes, not strings', ()=>{
    const { fns, host, put } = setup();
    put(0x100, 'abc');
    put(0x110, 'abd');
    host.bytes[0x104] = 0xff;
    host.bytes[0x114] = 0x01;

    assert.equal(fns.memcmp.handler([0x100, 0x110, 2]), 0);
    assert.equal(fns.memcmp.handler([0x100, 0x110, 3]), -1);
    assert.equal(fns.memcmp.handler([0x110, 0x100, 3]), 1);
    assert.equal(fns.memcmp.handler([0x100, 0x110, 0]), 0);
    assert.equal(fns.memcmp.handler([0x104, 0x114, 1]), 1, 'bytes compare unsigned');
});

test('atoi takes the leading integer and ignores the rest', ()=>{
    const { fns, put } = setup();
    assert.equal(fns.atoi.handler([put(0x100, '42')]), 42);
    assert.equal(fns.atoi.handler([put(0x110, '   -17abc')]), -17);
    assert.equal(fns.atoi.handler([put(0x120, '+8')]), 8);
    assert.equal(fns.atoi.handler([put(0x130, 'abc')]), 0);
    assert.equal(fns.atoi.handler([put(0x140, '')]), 0);
    assert.equal(fns.atoi.handler([put(0x150, '0x1f')]), 0, 'atoi is decimal only');
});

test('atoi wraps rather than saturating, as msvcrt.dll does, and atol is the same function', ()=>{
    // Wine's conformance test: atoi("4294967296") and atol("4294967296") are 0.
    const { fns, put } = setup();
    assert.equal(fns.atoi.handler([put(0x100, '4294967296')]), 0);
    assert.equal(fns.atol.handler([put(0x100, '4294967296')]), 0);
    assert.equal(fns.atoi.handler([put(0x110, '2147483648')]), -0x80000000);
    assert.equal(fns.atoi.handler([put(0x120, '-2147483649')]), 0x7fffffff);
    assert.equal(fns.atoi.handler([put(0x130, '99999999999')]), 1215752191,
        '99999999999 less 23 times 2^32');
    assert.equal(fns.atoi.handler([put(0x140, '-99999999999')]), -1215752191);
    assert.equal(fns.atoi.handler([put(0x150, '2147483647')]), 0x7fffffff);
    assert.equal(fns.atoi.handler([put(0x160, '-2147483648')]), -0x80000000);
    assert.equal(fns.atol.handler([put(0x170, '-17')]), -17);
    assert.equal(fns.atol.argBytes, fns.atoi.argBytes);
});

test('_isnan is nonzero for any NaN and zero for every other double, infinities too', ()=>{
    // "_isnan ... return a non-zero value if the argument x is a NaN;
    // otherwise they return 0." A double is two slots, and no FPU is needed.
    const { fns } = setup();
    assert.notEqual(fns._isnan.handler(doubleSlots(NaN)), 0);
    assert.notEqual(fns._isnan.handler([0, 0xfff80000]), 0, 'the x87 indefinite');
    assert.notEqual(fns._isnan.handler([1, 0x7ff00000]), 0, 'a signalling NaN');
    for (const value of [0, -0, 1.5, -2e300, Infinity, -Infinity, Number.MIN_VALUE])
    {
        assert.equal(fns._isnan.handler(doubleSlots(value)), 0, String(value));
    }
    assert.equal(fns._isnan.argBytes, 8);
});

test('_finite is zero for the infinities and NaN and nonzero for every finite double', ()=>{
    const { fns } = setup();
    for (const value of [Infinity, -Infinity, NaN])
    {
        assert.equal(fns._finite.handler(doubleSlots(value)), 0, String(value));
    }
    for (const value of [0, -0, 1.5, -2e300, Number.MIN_VALUE])
    {
        assert.notEqual(fns._finite.handler(doubleSlots(value)), 0, String(value));
    }
});

test('itoa writes the digits and returns the buffer', ()=>{
    const { fns, put, at } = setup();

    assert.equal(fns.itoa.handler([-42, 0x200, 10]), 0x200);
    assert.equal(at(0x200), '-42');
    fns.itoa.handler([255, 0x210, 16]);
    assert.equal(at(0x210), 'ff');
    fns._itoa.handler([5, 0x220, 2]);
    assert.equal(at(0x220), '101');
    fns.itoa.handler([-1, 0x230, 16]);
    assert.equal(at(0x230), 'ffffffff', 'only radix ten is signed');
    put(0x240, 'untouched');
    assert.equal(fns.itoa.handler([7, 0x240, 1]), 0, 'a radix below two writes nothing');
    assert.equal(at(0x240), 'untouched');
    fns._itoa.handler([100, 0x250, 100]);
    assert.equal(at(0x250), '10', 'past thirty-six the digits go on counting');
    fns._itoa.handler([46, 0x260, 40]);
    assert.equal(at(0x260), '16');
    fns._itoa.handler([39, 0x270, 40]);
    assert.equal(at(0x270), '~', "digit 39 is the fourth character after 'z'");
});

test('puts writes the string with a newline', ()=>{
    const { fns, host, put } = onConsole();

    assert.equal(fns.puts.handler([put(0x100, 'hello')]), 0);
    assert.deepEqual(host.output.map(entry=>entry.text), ['hello\n']);
});

test('printf formats its variadic tail and returns the character count', ()=>{
    const { fns, host, put } = onConsole();
    const format = put(0x100, '%s scored %d%%');
    const name = put(0x200, 'player');

    assert.equal(fns.printf.handler([format, name, 90]), 17);
    assert.deepEqual(host.output.map(entry=>entry.text), ['player scored 90%']);
});

test('printf survives a format that no argument satisfies', ()=>{
    const { fns, host, put } = onConsole();

    fns.printf.handler([put(0x100, '%d %s')]);
    assert.deepEqual(host.output.map(entry=>entry.text), ['0 (null)']);
});

test('sprintf terminates the buffer and returns the count without the NUL', ()=>{
    const { fns, host, put, at } = setup();
    const format = put(0x100, '[%04x]');

    host.bytes.fill(0x7f, 0x200, 0x208);
    assert.equal(fns.sprintf.handler([0x200, format, 0xbee]), 6);
    assert.equal(at(0x200), '[0bee]');
    assert.equal(host.bytes[0x206], 0, 'the buffer is terminated');
    assert.equal(host.bytes[0x207], 0x7f, 'and nothing beyond it is touched');
    assert.deepEqual(host.output, [], 'sprintf writes to memory, not to stdout');
});

test('_vsnprintf formats from a list in memory and truncates the way _snprintf does', ()=>{
    const { fns, host, put, at } = setup();
    const format = put(0x100, '%s=%d');
    const name = put(0x120, 'x');
    host.writeMemory(0x140, new Uint8Array([name & 0xff, name >>> 8 & 0xff, 0, 0, 42, 0, 0, 0]));

    assert.equal(fns._vsnprintf.handler([0x200, 16, format, 0x140]), 4);
    assert.equal(at(0x200), 'x=42');
    assert.equal(fns._vsnprintf.handler([0x300, 3, format, 0x140]), -1, 'too long: negative');
    assert.deepEqual([...host.bytes.subarray(0x300, 0x304)], [0x78, 0x3d, 0x34, 0],
        'and the buffer holds what fit, with nothing written past it');
    assert.equal(fns._vsnprintf.argBytes, 16);
});

test('sprintf reads %S and %ls as the wide strings they are', ()=>{
    // Wine's msvcrt test_sprintf: "%S" and "%ls" of L"wide" are "wide".
    const { fns, host, put, at } = setup();
    const view = new DataView(host.bytes.buffer);
    [...'wide\0'].forEach((c, index)=>view.setUint16(0x100 + index * 2, c.charCodeAt(0), true));
    assert.equal(fns.sprintf.handler([0x200, put(0x140, '%S/%ls'), 0x100, 0x100]), 9);
    assert.equal(at(0x200), 'wide/wide');
    const list = 0x180;
    view.setUint32(list, 0x100, true);
    assert.equal(fns._vsnprintf.handler([0x200, 16, put(0x140, '<%S>'), list]), 6);
    assert.equal(at(0x200), '<wide>');
});

test('swprintf takes no count, and _snwprintf its arguments as _vsnwprintf takes a list', ()=>{
    // Wine's msvcrt test_swprintf: msvcrt's swprintf has no count, %S is a
    // narrow string in it and %I64d eight bytes.
    const { fns, host } = setup();
    const view = new DataView(host.bytes.buffer);
    /** @param {number} address @param {string} text */
    const wide = (address, text)=>{
        [...text, '\0'].forEach((c, at)=>view.setUint16(address + at * 2, c.charCodeAt(0), true));
        return address;
    };
    /** @param {number} address */
    const read = address=>{
        let text = '';
        for (let at = address; view.getUint16(at, true) !== 0; at += 2)
        {
            text += String.fromCharCode(view.getUint16(at, true));
        }
        return text;
    };
    host.bytes.set([...'string'].map(c=>c.charCodeAt(0)).concat(0), 0x180);
    assert.equal(fns.swprintf.handler([0x200, wide(0x100, '%S|%I64d'), 0x180, 1, 1]),
        'string|4294967297'.length);
    assert.equal(read(0x200), 'string|4294967297');
    assert.equal(fns._swprintf, fns.swprintf);
    assert.equal(fns._snwprintf.handler([0x200, 3, wide(0x100, '%d'), 12345]), -1);
    assert.equal(read(0x200).slice(0, 3), '123');
});

test('_vsnwprintf formats wide text from a list, terminated only when there is room', ()=>{
    // Wine's msvcrt test_vsnwprintf, and test_snprintf's lengths for the
    // narrow twin: text shorter than the count is terminated, text exactly
    // the count is not, and longer text is -1 with the count written.
    const { fns, host, put } = setup();
    const view = new DataView(host.bytes.buffer);
    /** @param {number} address @param {string} text */
    const wide = (address, text)=>{
        [...text, '\0'].forEach((c, at)=>view.setUint16(address + at * 2, c.charCodeAt(0), true));
        return address;
    };
    /** @param {number} address @param {number} count */
    const units = (address, count)=>String.fromCharCode(
        ...Array.from({ length: count }, (_, at)=>view.getUint16(address + at * 2, true)));
    /** @param {number} list @param {number[]} values */
    const slots = (list, values)=>{
        values.forEach((value, at)=>view.setUint32(list + at * 4, value, true));
        return list;
    };
    const list = slots(0x180, [wide(0x100, 'one'), wide(0x110, 'two'), wide(0x120, 'three')]);
    const format = wide(0x140, '%ws%ws%ws');

    host.bytes.fill(0xee, 0x200, 0x300);
    assert.equal(fns._vsnwprintf.handler([0x200, 32, format, list]), 11);
    assert.equal(units(0x200, 12), 'onetwothree\0');
    assert.equal(fns._vsnwprintf.handler([0x200, 0, format, list]), -1);
    assert.equal(fns._vsnwprintf.handler([0, 0, format, list]), 11, 'the count it would need');

    const none = slots(0x1a0, []);
    for (const [text, expected] of /** @type {[string, number][]} */ ([
        ['short', 5], ['justfit', 7], ['justfits', 8], ['muchlonger', -1],
    ]))
    {
        host.bytes.fill(0xee, 0x200, 0x300);
        assert.equal(fns._vsnwprintf.handler([0x200, 8, wide(0x240, text), none]), expected, text);
        const valid = expected < 0 ? 8 : Math.min(expected + 1, 8);
        assert.equal(units(0x200, valid), `${text}\0`.slice(0, valid), text);
        assert.equal(view.getUint16(0x200 + 16, true), 0xeeee, `${text}: nothing past the count`);
    }
    assert.equal(fns._vsnwprintf.handler([0x200, 8, wide(0x240, '%s|%S'),
        slots(0x1a0, [wide(0x100, 'w'), put(0x120, 'n')])]), 3, '%s wide, %S narrow');
    assert.equal(units(0x200, 3), 'w|n');
    assert.equal(fns._vsnwprintf.argBytes, 16);
});

test('vswprintf is swprintf from a list: no count, the text and its terminator', ()=>{
    const { fns, host, put } = setup();
    const view = new DataView(host.bytes.buffer);
    /** @param {number} address @param {string} text */
    const wide = (address, text)=>{
        [...text, '\0'].forEach((c, at)=>view.setUint16(address + at * 2, c.charCodeAt(0), true));
        return address;
    };
    /** @param {number} address @param {number} count */
    const units = (address, count)=>String.fromCharCode(
        ...Array.from({ length: count }, (_, at)=>view.getUint16(address + at * 2, true)));
    const list = 0x180;
    [wide(0x100, 'w\u3042'), put(0x120, 'n'), -5].forEach(
        (value, at)=>view.setUint32(list + at * 4, value, true));

    assert.equal(fns.vswprintf.argBytes, 12);
    assert.equal(fns.vswprintf.handler([0x200, wide(0x140, '%s|%S|%d'), list]), 7);
    assert.equal(units(0x200, 8), 'w\u3042|n|-5\0');
});

test('the wide printers of Wine\'s test_vswprintf, test_vscwprintf and test_vsnwprintf_s', ()=>{
    const { fns, host } = setup();
    const view = new DataView(host.bytes.buffer);
    /** @param {number} address @param {string} text */
    const wide = (address, text)=>{
        [...text, '\0'].forEach((c, at)=>view.setUint16(address + at * 2, c.charCodeAt(0), true));
        return address;
    };
    /** @param {number} address */
    const read = address=>{
        let text = '';
        for (let at = address; view.getUint16(at, true) !== 0; at += 2)
        {
            text += String.fromCharCode(view.getUint16(at, true));
        }
        return text;
    };
    const list = 0x180;
    view.setUint32(list, wide(0x100, 'number'), true);
    view.setUint32(list + 4, 123, true);
    const format = wide(0x140, '%s %d');
    assert.equal(fns._vswprintf.handler([0x200, format, list]), 10);
    assert.equal(read(0x200), 'number 123');
    assert.equal(fns._vswprintf_l.handler([0x200, format, 0, list]), 10);
    assert.equal(fns._vswprintf_c.handler([0x200, 20, format, list]), 10);
    assert.equal(fns._vswprintf_c.handler([0x200, 10, format, list]), -1);
    assert.equal(read(0x200), 'number 12', 'what fits, terminated');
    assert.equal(fns._vswprintf_c_l.handler([0x200, 20, format, 0, list]), 10);
    assert.equal(fns._vswprintf_p_l.handler([0x200, 20, wide(0x160, '%2$d %1$s'), 0, list]), 10);
    assert.equal(read(0x200), '123 number');
    view.setUint32(list + 4, 1, true);
    assert.equal(fns._vscwprintf.handler([format, list]), 8);

    view.setUint32(list, 123, true);
    const counted = wide(0x140, 'AB%uC');
    for (const [size, answer, text] of /** @type {[number, number, string][]} */ ([
        [14, 6, 'AB123C'], [12, 6, 'AB123C'], [7, 6, 'AB123C'], [6, -1, 'AB123'], [2, -1, 'A'],
        [1, -1, '']]))
    {
        assert.equal(fns._vsnwprintf_s.handler([0x200, size, 0xffffffff, counted, list]), answer);
        assert.equal(read(0x200), text, `${size}`);
    }
});

test('_vsprintf_p reads the arguments by the positions the format names', ()=>{
    // Wine's msvcrt test_vsprintf_p.
    const { fns, host, put, at } = setup();
    const view = new DataView(host.bytes.buffer);
    /** @param {number[]} values */
    const list = values=>{
        values.forEach((value, i)=>view.setUint32(0x180 + i * 4, value, true));
        return 0x180;
    };
    const word = put(0x100, 'test');
    for (const [format, values, answer, text] of
        /** @type {[string, number[], number, string][]} */ ([
            ['%s %d', [word, 1234], 9, 'test 1234'], ['%1$d', [1234, word], 4, '1234'],
            ['%2$s %1$d', [1234, word], 9, 'test 1234'],
            ['%2$*3$s %2$.*1$s', [2, word, 3], 7, 'test te'],
        ]))
    {
        assert.equal(fns._vsprintf_p.handler([0x200, 1024, put(0x140, format), list(values)]),
            answer, format);
        assert.equal(at(0x200), text, format);
    }
});

test('_set_output_format makes the exponent two digits at least', ()=>{
    // Wine's msvcrt test__get_output_format.
    const { fns, put, at } = setup();
    const bytes = new DataView(new ArrayBuffer(8));
    bytes.setFloat64(0, 1.23, true);
    const slots = [bytes.getUint32(0, true), bytes.getUint32(4, true)];
    const format = put(0x140, '%E');
    assert.equal(fns._get_output_format.handler(), 0);
    assert.equal(fns.sprintf.handler([0x200, format, ...slots]), 13);
    assert.equal(at(0x200), '1.230000E+000');
    assert.equal(fns._set_output_format.handler([1]), 0);
    assert.equal(fns.sprintf.handler([0x200, format, ...slots]), 12);
    assert.equal(at(0x200), '1.230000E+00');
    assert.equal(fns._get_output_format.handler(), 1);
    assert.equal(fns._set_output_format.handler([1]), 1);
});

test('_snprintf and _vsnprintf terminate only when the text is shorter than the count', ()=>{
    // Wine's ntdll test__snprintf, whose _snprintf is this one: "hello world"
    // into 11 leaves the X after it, "test" into 4 leaves the byte after it
    // alone, and into 12 the text is terminated. "The _snprintf family of
    // functions only appends a terminating NULL character if the formatted
    // string length is strictly less than count characters."
    const { fns, host, put, at } = setup();
    const text = put(0x100, 'hello world');
    put(0x200, 'XXXXXXXXXXXX');
    assert.equal(fns._snprintf.handler([0x200, 11, text]), 11);
    assert.equal(at(0x200), 'hello worldX');
    put(0x200, 'XXXXXXXXXXXX');
    assert.equal(fns._snprintf.handler([0x200, 12, text]), 11);
    assert.equal(at(0x200), 'hello world');
    assert.equal(fns._snprintf.handler([0x200, 10, text]), -1);

    const test4 = put(0x140, 'test');
    for (const call of [
        ()=>fns._snprintf.handler([0x300, 4, test4]),
        ()=>fns._vsnprintf.handler([0x300, 4, test4, 0x180]),
    ])
    {
        host.bytes.fill(0x7c, 0x300, 0x320);
        assert.equal(call(), 4);
        assert.equal(at(0x300).slice(0, 4), 'test');
        assert.equal(host.bytes[0x304], 0x7c, 'nothing past the count');
    }
});

test('_vsnprintf stops the va_list window at the end of its region', ()=>{
    // The stop that faulted a whole run: a thread formats from just below the
    // top of its stack, every argument it reads is there, and the fixed
    // window reaches past the end of the region into memory that does not
    // exist. The host must clamp the window to its region -- reading what is
    // not there for a slot the format never consults is the host's fault, not
    // the guest's.
    const { host, fns, put, at } = setup();
    host.regionAt = ()=>({ base: 0, size: 0x1000 });
    const read = host.readMemory;
    host.readMemory = (address, length)=>{
        const region = host.regionAt?.(address);
        if (!region || address + length > region.base + region.size)
        {
            throw new Error(
                `read of ${length} bytes at 0x${address.toString(16)} runs past the end`);
        }
        return read(address, length);
    };
    host.writeMemory(0xff8, new Uint8Array([42, 0, 0, 0]));
    const format = put(0x100, 'Engine %x');

    assert.equal(fns._vsnprintf.handler([0x200, 16, format, 0xff8]), 9);
    assert.equal(at(0x200), 'Engine 2a');
});

test('every function is cdecl and declares the stack its arguments occupy', ()=>{
    const { fns } = onConsole();

    for (const [name, fn] of Object.entries(fns))
    {
        // A variable rather than a function -- `_pctype` is the one here --
        // has no calling convention at all: its export is the address of the
        // data itself, never a stub a bridge crosses into. Nor has code of its
        // own that declares none: `_EH_prolog` takes its handler in EAX and
        // leaves the frame it built on its caller's stack.
        const declared = /** @type {any} */ (fn);
        if (declared.data || (declared.code && declared.convention === undefined))
        {
            continue;
        }
        // A C++ member is the one exception: `this` travels in ECX. Its
        // decoration says so -- the access (A private, I protected, Q public,
        // each a letter on for virtual), `this` plain or const, then E.
        const expected = /@@[AEIMQU][AB]E/.test(name) ? 'thiscall' : 'cdecl';
        const entry = /** @type {any} */ (fn);
        assert.equal(entry.convention, expected, `${name} is ${expected}`);
        assert.equal(entry.argBytes % 4, 0, `${name} takes whole DWORDs`);
    }

    assert.equal(fns.strlen.argBytes, 4);
    assert.equal(fns.strcmp.argBytes, 8);
    assert.equal(fns.strncmp.argBytes, 12);
    assert.equal(fns.strcpy.argBytes, 8);
    assert.equal(fns.strncpy.argBytes, 12);
    assert.equal(fns.strcat.argBytes, 8);
    assert.equal(fns.strchr.argBytes, 8);
    assert.equal(fns.strstr.argBytes, 8);
    assert.equal(fns._stricmp.argBytes, 8);
    assert.equal(fns.toupper.argBytes, 4);
    assert.equal(fns.tolower.argBytes, 4);
    assert.equal(fns.memcpy.argBytes, 12);
    assert.equal(fns.memmove.argBytes, 12);
    assert.equal(fns.memset.argBytes, 12);
    assert.equal(fns.memcmp.argBytes, 12);
    assert.equal(fns.atoi.argBytes, 4);
    assert.equal(fns.itoa.argBytes, 12);
    assert.equal(fns.puts.argBytes, 4);

    // Variadic: the bridge reads exactly argBytes off the stack, so the tail
    // has to be declared, and under cdecl declaring it pops nothing.
    assert.ok(fns.printf.argBytes >= 4 + 4 * 4, 'printf reads a tail');
    assert.ok(fns.sprintf.argBytes >= 8 + 4 * 4, 'sprintf reads a tail');
    assert.ok(fns._snprintf.argBytes >= 12 + 4 * 4, '_snprintf reads a tail');
});

test('qsort is code in the guest\'s msvcrt, which calls the comparator itself', ()=>{
    // What it sorts, and how, is held in inguest.test.js and crt-inguest.itest.js.
    const fns = /** @type {any} */ (createMsvcrtFunctions({ ...fakeMemory(), write: ()=>{},
        callGuest: async()=>0 }));
    assert.equal('handler' in fns.qsort, false, 'no crossing into the host');
    assert.deepEqual(fns.qsort.code(), COMPILED.qsort.code);
});

test('_set_error_mode hands back what was put in, and refuses a mode it has not got', ()=>{
    const { fns } = setup();
    const REPORT = 3;

    assert.equal(fns._set_error_mode.handler([REPORT]), 0, 'the default is _OUT_TO_DEFAULT');
    assert.equal(fns._set_error_mode.handler([2]), 0, 'setting answers the previous mode');
    assert.equal(fns._set_error_mode.handler([REPORT]), 2);
    assert.equal(fns._set_error_mode.handler([1]), 2);
    assert.equal(fns._set_error_mode.handler([7]) | 0, -1, 'an unknown mode is refused');
    assert.equal(fns._set_error_mode.handler([REPORT]), 1, 'and changed nothing');
});

test('setlocale carries the C locale, and only the C locale', ()=>{
    const memory = fakeMemory();
    /** @type {[string, string][]} */
    const divergences = [];
    const fns = /** @type {any} */ (createMsvcrtFunctions({
        ...memory,
        write: ()=>{},
        callGuest: async()=>0,
        divergence: (api, detail)=>divergences.push([api, detail]),
    }));
    const LC_ALL = 0;

    const queried = fns.setlocale.handler([LC_ALL, 0]);
    assert.notEqual(queried, 0);
    assert.equal(memory.readCString(queried, 16), 'C', 'a null locale only asks');

    const set = fns.setlocale.handler([LC_ALL, memory.put('C')]);
    assert.equal(set, queried, 'the same pointer every time it is asked');
    assert.equal(memory.readCString(fns.setlocale.handler([LC_ALL, memory.put('')]), 16), 'C',
        '"" is the native environment, which this runtime already is');
    assert.deepEqual(divergences, [], 'nothing unsupported was asked for yet');

    assert.equal(fns.setlocale.handler([LC_ALL, memory.put('German_Germany.1252')]), 0,
        'a locale with no data behind it fails, rather than lying about it');
    assert.equal(divergences.length, 1);
    assert.equal(divergences[0][0], 'setlocale');
    assert.equal(fns.setlocale.handler([20, memory.put('C')]), 0,
        'no category 20: Wine\'s test_setlocale');
    assert.equal(fns.setlocale.handler([5, memory.put('C')]), queried, 'LC_TIME is one');
    assert.equal(fns.___mb_cur_max_func.handler([]), 1);
    const cell = fns.__p___mb_cur_max.handler([]);
    assert.equal(memory.u32(cell), 1, 'a byte, the C locale\'s widest character');
});

test('rand draws this runtime own sequence, and srand starts it where told', ()=>{
    const { fns } = setup();
    // The numbers are part of the contract: a program that seeds with a constant
    // -- a level layout, a shuffled deck -- produces the same result every run,
    // and a better generator would produce a different one.
    fns.srand.handler([1]);
    const fromOne = [0, 0, 0, 0, 0].map(()=>fns.rand.handler());
    assert.deepEqual(fromOne, [41, 18467, 6334, 26500, 19169]);

    fns.srand.handler([1]);
    assert.deepEqual([0, 0, 0, 0, 0].map(()=>fns.rand.handler()), fromOne,
        'the same seed gives the same sequence');

    fns.srand.handler([12345]);
    assert.notDeepEqual([0, 0, 0].map(()=>fns.rand.handler()), fromOne.slice(0, 3));
});

test('rand stays inside RAND_MAX, because a caller scales its range by it', ()=>{
    const { fns } = setup();
    fns.srand.handler([0x7fffffff]);
    for (let draw = 0; draw < 1000; draw++)
    {
        const value = fns.rand.handler();
        assert.ok(value >= 0 && value <= 0x7fff, `rand gave ${value}`);
    }
    assert.equal(fns.rand.argBytes, 0);
    assert.equal(fns.srand.argBytes, 4);
    assert.equal(fns.rand.convention, 'cdecl');
});

test('rand starts where this runtime starts, without any srand at all', ()=>{
    const { fns } = setup();
    // An unseeded program is seeded with one, which is what the C standard says
    // and what msvcrt does.
    assert.equal(fns.rand.handler(), 41);
});

/**
 * The whole table over a host that has a heap, a start-up and a volume, so
 * the functions that need those seams are exported.
 *
 * @param {any} files
 * @param {() => any} [currentThread]
 * @param {Record<string, any>} [more]  Further seams, the runtime's `_iob` among them.
 */
function wholeRuntime(files, currentThread, more = {}){
    const host = fakeHost(0x4000);
    let next = 0x2000;
    const fns = /** @type {Record<string, any>} */ (createMsvcrtFunctions({
        ...host,
        ...more,
        currentThread,
        allocate: bytes=>{
            const at = next;
            next += bytes + 7 & ~7;
            return at;
        },
        free: ()=>true,
        commandLine: ()=>'"C:\\game.exe"',
        exitProcess: ()=>0,
        files,
    }));
    /** @param {number} address @param {string} text */
    const put = (address, text)=>{
        host.writeMemory(address, new Uint8Array([...text].map(c=>c.charCodeAt(0)).concat(0)));
        return address;
    };
    /** @param {number} address */
    const u32 = address=>new DataView(host.bytes.buffer).getUint32(address, true);
    return { host, fns, put, u32 };
}

/** The whole runtime, its standard streams placed and stdout on the console. */
function onConsole(){
    return wholeRuntime(fakeVolume({}, { directories: ['C:\\'] }), undefined,
        { iob: ()=>0x3800 });
}

test('errno is one variable: a failing call sets what _errno points at', ()=>{
    // Before the program has asked for the address and after: the start-up
    // hands out the cell the failing functions write.
    const { fns, put, u32 } = wholeRuntime({
        stat: ()=>null,
        currentDirectory: ()=>'C:\\game',
        setCurrentDirectory: ()=>true,
    });
    const ENOENT = 2;
    const ERANGE = 34;

    assert.equal(fns._chdir.handler([put(0x100, 'C:\\nowhere')]), -1);
    const cell = fns._errno.handler([]);
    assert.equal(u32(cell), ENOENT, 'set before anyone asked where errno is');

    assert.equal(fns.strtol.handler([put(0x100, '99999999999'), 0, 10]), 0x7fffffff);
    assert.equal(u32(cell), ERANGE, 'and written through the cell after');
});

test('each thread has its own errno: another thread\'s failure does not overwrite it', ()=>{
    // The scheduler may switch threads between a failing call and the line
    // that reads errno after it; the runtime keeps the variable per thread.
    const main = { name: 'main' };
    const worker = { name: 'worker' };
    let current = main;
    const { fns, put, u32 } = wholeRuntime({
        stat: ()=>null, currentDirectory: ()=>'C:\\', setCurrentDirectory: ()=>true,
    }, ()=>current);

    assert.equal(fns._chdir.handler([put(0x100, 'C:\\nowhere')]), -1);
    current = worker;
    assert.equal(fns.strtol.handler([put(0x100, '99999999999'), 0, 10]), 0x7fffffff);
    const workerErrno = fns._errno.handler([]);
    current = main;
    const mainErrno = fns._errno.handler([]);

    assert.notEqual(mainErrno, workerErrno);
    assert.equal(u32(mainErrno), 2, 'ENOENT, from the main thread\'s own call');
    assert.equal(u32(workerErrno), 34, 'ERANGE, from the worker\'s');
    assert.equal(fns._errno.handler([]), mainErrno, 'the same cell every time');
});

test('_snprintf and _vsnprintf with no buffer and a count of zero answer the length needed', ()=>{
    // Wine's ntdll test__snprintf: _snprintf(NULL, 0, "hello world") is 11.
    // With no buffer and a count to fill it is -1 and EINVAL, the answer the
    // documentation gives and the test allows.
    const { fns, put, u32 } = wholeRuntime(fakeVolume({}));
    const text = put(0x100, 'hello world');
    assert.equal(fns._snprintf.handler([0, 0, text]), 11);
    assert.equal(fns._vsnprintf.handler([0, 0, text, 0x180]), 11);
    assert.equal(u32(fns._errno.handler([])), 0);
    assert.equal(fns._snprintf.handler([0, 1, text]), -1);
    assert.equal(u32(fns._errno.handler([])), 22);
    assert.equal(fns._vsnprintf.handler([0, 12, text, 0x180]), -1);
});

test('printf, puts and vprintf write through stdout, so freopen moves them with it', ()=>{
    // printf is fprintf on stdout and puts is fputs on it: a program that
    // moved stdout to a file with freopen finds their output there.
    const IOB = 0x3800;
    const files = fakeVolume({}, { directories: ['C:\\'] });
    const { host, fns, put } = wholeRuntime(files, undefined, { iob: ()=>IOB });
    const stdout = IOB + 32;
    const format = put(0x100, '%s=%d\n');
    const name = put(0x140, 'x');
    const list = 0x180;
    new DataView(host.bytes.buffer).setUint32(list, name, true);
    new DataView(host.bytes.buffer).setUint32(list + 4, 3, true);
    const say = ()=>[
        fns.printf.handler([format, name, 1]),
        fns.puts.handler([put(0x1c0, 'hi')]),
        fns.vprintf.handler([format, list]),
    ];

    assert.deepEqual(say(), [4, 0, 4]);
    assert.deepEqual(host.output.map(entry=>[entry.handle, entry.text]),
        [[2, 'x=1\n'], [2, 'hi\n'], [2, 'x=3\n']], 'the console, while stdout is on it');

    host.output.length = 0;
    assert.equal(fns.freopen.handler([put(0x200, 'C:\\log.txt'), put(0x220, 'w'), stdout]),
        stdout);
    assert.deepEqual(say(), [4, 0, 4]);
    assert.deepEqual(host.output, []);
    assert.equal(String.fromCharCode(...files.files['C:\\log.txt']), 'x=1\r\nhi\r\nx=3\r\n');
});

test('_cexit closes every open stream after the handlers, a temporary file with it', async()=>{
    // "_cexit ... flushes all I/O buffers and closes all open streams before
    // returning" -- a standard stream freopen moved to a file included.
    const IOB = 0x3800;
    const files = fakeVolume({}, { directories: ['C:\\'] });
    const { host, fns, put } = wholeRuntime(files, undefined, { iob: ()=>IOB });
    assert.notEqual(fns.fopen.handler([put(0x100, 'C:\\scratch.tmp'), put(0x120, 'w+D')]), 0);
    const kept = fns.fopen.handler([put(0x140, 'C:\\kept.txt'), put(0x160, 'w')]);
    fns.freopen.handler([put(0x180, 'C:\\log.txt'), put(0x1a0, 'w'), IOB + 64]);

    assert.equal(await fns._cexit.handler([]), 0);
    assert.equal(files.files['C:\\scratch.tmp'], undefined);
    assert.deepEqual([...files.closed].sort(),
        ['C:\\kept.txt', 'C:\\log.txt', 'C:\\scratch.tmp']);
    assert.equal(fns.fputc.handler([0x41, kept]), -1, 'the stream is gone');
    assert.equal(fns.fputc.handler([0x42, IOB + 64]), 0x42, 'stderr is the console again');
    assert.deepEqual(host.output.map(entry=>[entry.handle, entry.text]), [[3, 'B']]);
});

test('the runtime closes its files when the process ends, removing a temporary one', ()=>{
    /** @type {(() => void)[]} */
    const atEnd = [];
    const files = fakeVolume({}, { directories: ['C:\\'] });
    const { fns, put } = wholeRuntime(files, undefined, {
        iob: ()=>0x3800, atProcessEnd: (/** @type {() => void} */ task)=>atEnd.push(task),
    });
    assert.notEqual(fns.fopen.handler([put(0x100, 'C:\\scratch.tmp'), put(0x120, 'wD')]), 0);
    const O_CREAT_RDWR_TEMPORARY = 0x0142;
    assert.ok(fns._open.handler([put(0x140, 'C:\\low.tmp'), O_CREAT_RDWR_TEMPORARY, 0]) > 2);

    assert.equal(atEnd.length, 1, 'told once, when the runtime was made');
    atEnd.forEach(task=>task());
    assert.deepEqual(Object.keys(files.files), []);
});

test('sprintf_s and vsprintf_s write what fits with its terminator, and refuse the rest', ()=>{
    // "If the buffer is too small for the formatted text, including the
    // terminating null, then the buffer is set to an empty string"; a null
    // buffer or format is -1 and EINVAL, as a size of zero is for vsprintf_s.
    const { host, fns, put, u32 } = wholeRuntime({
        stat: ()=>null, currentDirectory: ()=>'C:\\', setCurrentDirectory: ()=>true,
    });
    const errno = fns._errno.handler([]);
    const format = put(0x100, '%s=%d');
    const name = put(0x120, 'x');
    host.writeMemory(0x140, new Uint8Array([name & 0xff, name >>> 8 & 0xff, 0, 0, 42, 0, 0, 0]));
    const text = (/** @type {number} */ address)=>host.readCString(address, 64);
    const ERANGE = 34;
    const EINVAL = 22;

    assert.equal(fns.sprintf_s.handler([0x200, 5, format, name, 42]), 4, 'exactly room');
    assert.equal(text(0x200), 'x=42');
    assert.equal(fns.vsprintf_s.handler([0x300, 16, format, 0x140]), 4);
    assert.equal(text(0x300), 'x=42');

    host.bytes.fill(0x7f, 0x400, 0x408);
    assert.equal(fns.sprintf_s.handler([0x400, 4, format, name, 42]), -1,
        'no room for the terminator');
    assert.deepEqual([...host.bytes.subarray(0x400, 0x402)], [0, 0x7f]);
    assert.equal(u32(errno), ERANGE);
    host.bytes[0x400] = 0x7f;
    assert.equal(fns.vsprintf_s.handler([0x400, 2, format, 0x140]), -1);
    assert.equal(host.bytes[0x400], 0);

    assert.equal(fns.sprintf_s.handler([0, 16, format]), -1);
    assert.equal(u32(errno), EINVAL);
    host.writeMemory(errno, new Uint8Array(4));
    assert.equal(fns.vsprintf_s.handler([0x400, 16, 0, 0x140]), -1);
    assert.equal(u32(errno), EINVAL);
    host.writeMemory(errno, new Uint8Array(4));
    assert.equal(fns.vsprintf_s.handler([0x400, 0, format, 0x140]), -1);
    assert.equal(u32(errno), EINVAL);
    assert.deepEqual([fns.sprintf_s.convention, fns.vsprintf_s.argBytes], ['cdecl', 16]);
    assert.ok(fns.sprintf_s.argBytes >= 12 + 4 * 4, 'sprintf_s reads a tail');
});

test('bytes in the upper half of the ANSI page are copied and printed as themselves', ()=>{
    // The memory layer reads an ANSI string as Windows-1252, where 0x80 is the
    // euro sign, 0x99 the trade mark and 0x97 an em dash. Under the C locale a
    // copy and a printer are byte for byte: what a format, a %s and a %c carry
    // is what reaches the buffer, and so is a wide character up to U+00FF.
    const { fns, host } = setup();
    /** @param {number} address @param {number} length */
    const bytesAt = (address, length)=>[...host.bytes.subarray(address, address + length)];
    host.bytes.set([0x80, 0x99, 0x97, 0], 0x100);
    assert.equal(fns.strcpy.handler([0x200, 0x100]), 0x200);
    assert.deepEqual(bytesAt(0x200, 4), [0x80, 0x99, 0x97, 0]);
    assert.equal(fns.strncpy.handler([0x210, 0x100, 5]), 0x210);
    assert.deepEqual(bytesAt(0x210, 5), [0x80, 0x99, 0x97, 0, 0]);

    host.bytes.set([0x80, 0x25, 0x73, 0x25, 0x63, 0x25, 0x53, 0], 0x140);
    host.bytes.set([0x80, 0, 0, 0], 0x180);
    assert.equal(fns.sprintf.handler([0x300, 0x140, 0x101, 0x97, 0x180]), 5);
    assert.deepEqual(bytesAt(0x300, 6), [0x80, 0x99, 0x97, 0x97, 0x80, 0]);
    assert.equal(fns._snprintf.handler([0x320, 3, 0x140, 0x101, 0x97, 0x180]), -1);
    assert.deepEqual(bytesAt(0x320, 3), [0x80, 0x99, 0x97]);
});

test('rand_s fills an unsigned int from the random source and refuses no pointer', ()=>{
    const { fns } = setup();
    assert.equal(fns.rand_s.handler([0x300]), 0);
    assert.equal(fns.rand_s.handler([0]), 22);
});

test('_get_fmode and _set_fmode read and set _fmode, refusing a mode that is none', ()=>{
    const { host, fns: table } = setup();
    const fns = /** @type {Record<string, { handler: (args: number[]) => number }>} */ (
        /** @type {unknown} */ (table));
    const out = 0x300;
    assert.equal(fns._get_fmode.handler([out]), 0);
    assert.equal(new DataView(host.bytes.buffer).getInt32(out, true), 0);
    assert.equal(fns._set_fmode.handler([0x8000]), 0);
    assert.equal(fns._get_fmode.handler([out]), 0);
    assert.equal(new DataView(host.bytes.buffer).getInt32(out, true), 0x8000);
    assert.equal(fns._set_fmode.handler([0x1234]), 22);
    assert.equal(fns._get_fmode.handler([0]), 22);
    assert.equal(fns._setmaxstdio.handler([19]), -1);
    assert.equal(fns._setmaxstdio.handler([2049]), -1);
    assert.equal(fns._setmaxstdio.handler([1024]), 1024);
    assert.equal(fns._getmaxstdio.handler([]), 1024);
});
