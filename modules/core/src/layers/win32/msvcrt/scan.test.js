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
