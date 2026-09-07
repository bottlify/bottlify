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

test('_snscanf reads no further than the count it was given', ()=>{
    const { memory, table } = build();
    const out = memory.allocate(8);
    const input = memory.put('123456');
    assert.equal(table._snscanf.handler([input, 3, memory.put('%d'), out]), 1);
    assert.equal(memory.i32(out), 123);
});
