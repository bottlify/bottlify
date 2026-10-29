/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScanFunctions, SCAN_EOF } from './scan.js';
import { fakeMemory } from './harness.test.js';

const build = ()=>{
    const memory = fakeMemory();
    return { memory, table: createScanFunctions(memory) };
};

/**
 * @param {ReturnType<typeof build>} fixture
 * @param {string} input @param {string} format @param {number[]} pointers
 */
const sscanf = ({ memory, table }, input, format, pointers)=>
    table.sscanf.handler([memory.put(input), memory.put(format), ...pointers]);

test('a plain %d assigns four bytes and counts one', ()=>{
    const fixture = build();
    const out = fixture.memory.allocate(8);
    assert.equal(sscanf(fixture, ' 42 ', '%d', [out]), 1);
    assert.equal(fixture.memory.i32(out), 42);
});

test('%hd stores two bytes, leaving the next two alone', ()=>{
    const fixture = build();
    const out = fixture.memory.allocate(8);
    fixture.memory.setU32(out, 0xffffffff);
    sscanf(fixture, '1', '%hd', [out]);
    assert.equal(fixture.memory.u32(out), 0xffff0001, 'the high half is untouched');
});

test('%f stores a float and %lf a double -- four bytes against eight', ()=>{
    const fixture = build();
    const single = fixture.memory.allocate(8);
    const wide = fixture.memory.allocate(8);
    fixture.memory.setU32(single + 4, 0xabcdef01);
    sscanf(fixture, '1.5 1.5', '%f %lf', [single, wide]);
    assert.equal(new DataView(fixture.memory.bytes.buffer).getFloat32(single, true), 1.5);
    assert.equal(fixture.memory.u32(single + 4), 0xabcdef01, 'a float is not eight bytes');
    assert.equal(new DataView(fixture.memory.bytes.buffer).getFloat64(wide, true), 1.5);
});

test('%s stops at whitespace and terminates; %c takes exactly its width', ()=>{
    const fixture = build();
    const word = fixture.memory.allocate(32);
    const characters = fixture.memory.allocate(32);
    fixture.memory.writeMemory(characters, new Uint8Array(8).fill(0x2e));
    assert.equal(sscanf(fixture, 'one two', '%s %2c', [word, characters]), 2);
    assert.equal(fixture.memory.text(word), 'one');
    assert.equal(fixture.memory.text(characters), 'tw......', 'no terminator of its own');
});

test('%c is the conversion that reads whitespace instead of skipping it', ()=>{
    const fixture = build();
    const character = fixture.memory.allocate(8);
    assert.equal(sscanf(fixture, ' x', '%c', [character]), 1);
    assert.equal(fixture.memory.readMemory(character, 1)[0], 0x20, 'the space itself');
});

test('a width bounds a conversion without ending the scan', ()=>{
    const fixture = build();
    const first = fixture.memory.allocate(8);
    const second = fixture.memory.allocate(8);
    assert.equal(sscanf(fixture, '1234', '%2d%2d', [first, second]), 2);
    assert.equal(fixture.memory.i32(first), 12);
    assert.equal(fixture.memory.i32(second), 34);
});

test('a suppressed field consumes input but is not assigned or counted', ()=>{
    const fixture = build();
    const out = fixture.memory.allocate(8);
    assert.equal(sscanf(fixture, '10 20', '%*d %d', [out]), 1);
    assert.equal(fixture.memory.i32(out), 20, 'the pointer took the second field');
});

test('%n reports what was consumed and does not add to the count', ()=>{
    const fixture = build();
    const value = fixture.memory.allocate(8);
    const consumed = fixture.memory.allocate(8);
    assert.equal(sscanf(fixture, '42x', '%d%n', [value, consumed]), 1);
    assert.equal(fixture.memory.i32(consumed), 2);
});

test('a scanset takes what it lists, and ^ takes everything else', ()=>{
    const fixture = build();
    const taken = fixture.memory.allocate(32);
    sscanf(fixture, 'abc123', '%[a-c]', [taken]);
    assert.equal(fixture.memory.text(taken), 'abc');

    const rest = fixture.memory.allocate(32);
    sscanf(fixture, 'key=value', '%[^=]', [rest]);
    assert.equal(fixture.memory.text(rest), 'key');
});

test('a literal that does not match ends the scan at what was assigned', ()=>{
    const fixture = build();
    const first = fixture.memory.allocate(8);
    const second = fixture.memory.allocate(8);
    assert.equal(sscanf(fixture, '1,2', '%d;%d', [first, second]), 1);
    assert.equal(fixture.memory.i32(first), 1);
});

test('input that runs out before the first conversion is EOF, not zero', ()=>{
    const fixture = build();
    const out = fixture.memory.allocate(8);
    assert.equal(sscanf(fixture, '', '%d', [out]), SCAN_EOF);
    assert.equal(sscanf(fixture, 'x', '%d', [out]), 0, 'input left, nothing matched');
});

test('whitespace in the format matches any run of it, including none', ()=>{
    const fixture = build();
    const first = fixture.memory.allocate(8);
    const second = fixture.memory.allocate(8);
    assert.equal(sscanf(fixture, '1\t\n  2', '%d %d', [first, second]), 2);
    assert.equal(fixture.memory.i32(second), 2);
});

test('%x reads hex with or without the prefix', ()=>{
    const fixture = build();
    const out = fixture.memory.allocate(8);
    sscanf(fixture, 'ff', '%x', [out]);
    assert.equal(fixture.memory.i32(out), 255);
    sscanf(fixture, '0x10', '%x', [out]);
    assert.equal(fixture.memory.i32(out), 16);
});

test('the scanners declare the variadic tail their pointers arrive in', ()=>{
    // The bridge reads exactly argBytes off the stack; declared with the
    // fixed part alone, every conversion is stored through a null pointer.
    const { table } = build();
    assert.ok(table.sscanf.argBytes >= 8 + 4 * 4);
    assert.ok(table._snscanf.argBytes >= 12 + 4 * 4);
    assert.equal(table.sscanf.convention, 'cdecl');
});

test('_snscanf reads no further than the count it was given', ()=>{
    const { memory, table } = build();
    const out = memory.allocate(8);
    const input = memory.put('123456');
    assert.equal(table._snscanf.handler([input, 3, memory.put('%d'), out]), 1);
    assert.equal(memory.i32(out), 123);
});

test('upper-half bytes are stored as they were read, and a range of them is a range of bytes', ()=>{
    // The memory layer reads an ANSI string as Windows-1252, where 0x80 is the
    // euro sign, 0x99 the trade mark and 0x97 an em dash. A field is stored as
    // the bytes it was, and [\x80-\x9f] spans those bytes, as a scan set
    // orders them, not the characters they stand for.
    const { memory, table } = build();
    /** @param {number[]} bytes */
    const place = bytes=>{
        const at = memory.allocate(bytes.length + 1);
        memory.writeMemory(at, Uint8Array.from([...bytes, 0]));
        return at;
    };
    const word = memory.allocate(8);
    const run = memory.allocate(8);
    assert.equal(table.sscanf.handler([place([0x80, 0x99, 0x20, 0x97, 0x8c, 0x41]),
        place([0x25, 0x73, 0x20, 0x25, 0x5b, 0x80, 0x2d, 0x9f, 0x5d]), word, run]), 2);
    assert.deepEqual([...memory.bytes.subarray(word, word + 3)], [0x80, 0x99, 0]);
    assert.deepEqual([...memory.bytes.subarray(run, run + 3)], [0x97, 0x8c, 0]);
});

test('width digits and length modifiers come in any order, the digits one width', ()=>{
    // Wine's msvcrt test_sscanf: "%h02d", "%000h02d" and "%2h0d" of "12345678".
    const fixture = build();
    const out = fixture.memory.allocate(8);
    for (const [format, expected] of /** @type {[string, number][]} */ ([
        ['%02hd', 0xdead000c], ['%h02d', 0xdead000c], ['%000h02d', 0xdead000c],
        ['%2h0d', 0xdead614e], ['%hhd', 0x00bc614e],
    ]))
    {
        fixture.memory.setU32(out, 0xdeadbeef);
        assert.equal(sscanf(fixture, '12345678', format, [out]), 1, format);
        assert.equal(fixture.memory.u32(out), expected, format);
    }
});

test('%p reads hexadecimal digits with no prefix, a sign allowed, and %P is the same', ()=>{
    const fixture = build();
    const out = fixture.memory.allocate(8);
    for (const [input, format, expected] of /** @type {[string, string, number][]} */ ([
        ['000000000046F170', '%p', 0x46f170], ['0x46F173', '%p', 0], ['-46F174', '%p', -0x46f174],
        ['1234', '%P', 0x1234],
    ]))
    {
        assert.equal(sscanf(fixture, input, format, [out]), 1, input);
        assert.equal(fixture.memory.i32(out), expected, input);
    }
});

test('a character that is no conversion is matched as it stands', ()=>{
    const fixture = build();
    const out = fixture.memory.allocate(8);
    assert.equal(sscanf(fixture, '"%12@', '%"%%%d%@', [out]), 1);
    assert.equal(fixture.memory.i32(out), 12);
});

test('a scanset range runs either way, and a dash after a range is itself', ()=>{
    const fixture = build();
    const out = fixture.memory.allocate(64);
    assert.equal(sscanf(fixture, 'abcefgdh', '%*[a-cg-e]%c', [out]), 1);
    assert.equal(String.fromCharCode(fixture.memory.bytes[out]), 'd');
    assert.equal(sscanf(fixture, '-4123', '%[1-2-4]', [out]), 1);
    assert.equal(fixture.memory.text(out), '-412');
    assert.equal(sscanf(fixture, '-456123', '%[1-2-45-6]', [out]), 1);
    assert.equal(fixture.memory.text(out), '-45612');
});

test('%jx stores eight bytes', ()=>{
    const fixture = build();
    const out = fixture.memory.allocate(8);
    assert.equal(sscanf(fixture, '0xfefefefefefefefe', '%jx', [out]), 1);
    assert.deepEqual([fixture.memory.u32(out), fixture.memory.u32(out + 4)],
        [0xfefefefe, 0xfefefefe]);
});

test('swscanf stores wide text for %s and %c, and answers no input with zero', ()=>{
    const fixture = build();
    const { memory } = fixture;
    const table = /** @type {Record<string, any>} */ (fixture.table);
    const out = memory.allocate(64);
    assert.equal(table.swscanf.handler([memory.putWide('ab c'), memory.putWide('%s%c%C'), out,
        out + 32, out + 40]), 3);
    assert.equal(memory.wide(out), 'ab');
    assert.deepEqual([memory.bytes[out + 32], memory.bytes[out + 33], memory.bytes[out + 40]],
        [0x20, 0, 0x63], '%c a unit, %C a byte');
    assert.equal(table.swscanf.handler([memory.putWide(' \t\n'), memory.putWide('%s'), out]), 0);
    assert.equal(table.swscanf.handler([memory.putWide('aሴሴb'),
        memory.putWide('aሴ%ሴ%c'), out]), 1);
    assert.equal(memory.bytes[out], 0x62);
});

test('sscanf_s takes each string buffer\'s size, and text too long for it ends the scan', ()=>{
    const fixture = build();
    const { memory, table } = fixture;
    const word = memory.allocate(32);
    const number = memory.allocate(8);
    assert.equal(table.sscanf_s.handler([memory.put('one 7'), memory.put('%s %d'),
        word, 4, number]), 2, 'the size is an argument of its own, not the next pointer');
    assert.equal(memory.text(word), 'one');
    assert.equal(memory.i32(number), 7);
    assert.equal(table.sscanf_s.handler([memory.put('four 7'), memory.put('%s %d'),
        word, 4, number]), 0, 'four characters and a terminator do not fit in four');
    assert.equal(memory.text(word), '', 'the buffer is emptied');
    // Wine's msvcrt test_sscanf_s: a refusal at the end of the input is no EOF.
    assert.equal(table.sscanf_s.handler([memory.put('123'), memory.put('%s'), word, 3]), 0);
    assert.equal(memory.text(word), '');
    memory.writeMemory(word, new Uint8Array(4).fill(0x61));
    assert.equal(table.sscanf_s.handler([memory.put('123'), memory.put('%3c'), word, 2]), 0);
    assert.deepEqual([...memory.bytes.subarray(word, word + 3)], [0, 0x32, 0x61],
        'what fit, the first character zeroed');
    assert.equal(table.sscanf_s.handler([memory.put('123'), memory.put('%3c'), word, 3]), 1);
    assert.deepEqual([...memory.bytes.subarray(word, word + 4)], [0x31, 0x32, 0x33, 0x61]);
});
