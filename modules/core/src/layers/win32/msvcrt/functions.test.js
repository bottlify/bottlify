/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMsvcrtFunctions } from './functions.js';
import { fakeMemory, fakeVolume } from './harness.test.js';

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
        /** @param {number} address @param {number} maxLength */
        readCString(address, maxLength){
            let text = '';
            for (let i = 0; i < maxLength && address + i < bytes.length; i++)
            {
                asked++;
                if (bytes[address + i] === 0)
                {
                    break;
                }
                text += String.fromCharCode(bytes[address + i]);
            }
            return text;
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
        // data itself, never a stub a bridge crosses into.
        if (/** @type {any} */ (fn).data)
        {
            continue;
        }
        // A C++ member is the one exception: `this` travels in ECX. Its
        // decoration says so -- QBE/UAE are `const`/virtual thiscall members.
        const expected = /@@[QU][AB]E/.test(name) ? 'thiscall' : 'cdecl';
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
