/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsvcrtFunctions } from './functions.js';

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

    return {
        bytes,
        output,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.slice(address, address + length),
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
        /** @param {number} address @param {number} maxLength */
        readCString(address, maxLength){
            let text = '';
            for (let i = 0; i < maxLength && address + i < bytes.length; i++)
            {
                if (bytes[address + i] === 0)
                {
                    break;
                }
                text += String.fromCharCode(bytes[address + i]);
            }
            return text;
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
        guests,
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

test('strncmp stops after n bytes, and n of zero compares nothing', ()=>{
    const { fns, put } = setup();
    const a = put(0x100, 'abcX');
    const b = put(0x110, 'abcY');

    assert.equal(fns.strncmp.handler([a, b, 3]), 0);
    assert.equal(fns.strncmp.handler([a, b, 4]), -1);
    assert.equal(fns.strncmp.handler([a, b, 0]), 0);
    assert.equal(fns.strncmp.handler([a, b, 99]), -1, 'n past both terminators is harmless');
});

test('_stricmp ignores case, and only for ASCII letters', ()=>{
    const { fns, put } = setup();
    assert.equal(fns._stricmp.handler([put(0x100, 'Hello'), put(0x110, 'hELLO')]), 0);
    assert.equal(fns._stricmp.handler([put(0x120, 'abc'), put(0x130, 'ABD')]), -1);
    assert.equal(fns._stricmp.handler([put(0x140, 'B'), put(0x150, 'a')]), 1);
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
    assert.equal(fns.toupper.handler([-1]), -1, 'EOF passes through');
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

test('atoi saturates rather than wrapping, and atol is the same function', ()=>{
    const { fns, put } = setup();
    assert.equal(fns.atoi.handler([put(0x100, '99999999999')]), 0x7fffffff);
    assert.equal(fns.atoi.handler([put(0x110, '-99999999999')]), -0x80000000);
    assert.equal(fns.atol.handler([put(0x120, '-17')]), -17);
    assert.equal(fns.atol.argBytes, fns.atoi.argBytes);
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
    assert.equal(fns.itoa.handler([7, 0x240, 1]), 0, 'a radix out of range writes nothing');
    assert.equal(at(0x240), 'untouched');
});

test('puts writes the string with a newline', ()=>{
    const { fns, host, put } = setup();

    assert.equal(fns.puts.handler([put(0x100, 'hello')]), 0);
    assert.deepEqual(host.output.map(entry=>entry.text), ['hello\n']);
});

test('printf formats its variadic tail and returns the character count', ()=>{
    const { fns, host, put } = setup();
    const format = put(0x100, '%s scored %d%%');
    const name = put(0x200, 'player');

    assert.equal(fns.printf.handler([format, name, 90]), 17);
    assert.deepEqual(host.output.map(entry=>entry.text), ['player scored 90%']);
});

test('printf survives a format that no argument satisfies', ()=>{
    const { fns, host, put } = setup();

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

test('every function is cdecl and declares the stack its arguments occupy', ()=>{
    const { fns } = setup();

    for (const [name, fn] of Object.entries(fns))
    {
        // A C++ member is the one exception: `this` travels in ECX. Its
        // decoration says so -- QBE/UAE are `const`/virtual thiscall members.
        const expected = /@@[QU][AB]E/.test(name) ? 'thiscall' : 'cdecl';
        assert.equal(fn.convention, expected, `${name} is ${expected}`);
        assert.equal(fn.argBytes % 4, 0, `${name} takes whole DWORDs`);
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

test('qsort orders through the comparator the program brought', async()=>{
    const { host, fns } = setup();
    const base = 0x100;
    const values = [7, 3, 9, 1, 8, 2];
    values.forEach((value, index)=>host.writeMemory(base + index * 4, new Uint8Array([
        value, 0, 0, 0,
    ])));

    // The comparator is the program's, so the ordering is its decision and not
    // ours: this one sorts descending, and the result has to follow it rather
    // than what a sort would "normally" do.
    /** @type {number[][]} */
    const asked = [];
    const read = (/** @type {number} */ at)=>host.bytes[at];
    host.guests.set(0x9000, ([left, right])=>{
        asked.push([left, right]);
        return read(right) - read(left);
    });

    await fns.qsort.handler([base, values.length, 4, 0x9000]);

    const sorted = values.map((_, index)=>read(base + index * 4));
    assert.deepEqual(sorted, [9, 8, 7, 3, 2, 1]);
    assert.ok(asked.length >= values.length - 1, 'it really asked, repeatedly');
    // Every comparison is handed real addresses inside the array, not indices.
    for (const [left, right] of asked)
    {
        assert.ok(left >= base && left < base + values.length * 4);
        assert.equal(right - left, 4, 'adjacent elements, one width apart');
    }
});

test('qsort of nothing asks nothing', async()=>{
    const { host, fns } = setup();
    host.guests.set(0x9000, ()=>{
        throw new Error('a comparator was called for an empty array');
    });

    assert.equal(await fns.qsort.handler([0x100, 0, 4, 0x9000]), 0);
    assert.equal(await fns.qsort.handler([0x100, 1, 4, 0x9000]), 0);
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
