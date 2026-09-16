/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStringFunctions } from './strings.js';
import { fakeMemory } from './harness.test.js';

const build = ()=>{
    const memory = fakeMemory();
    return { memory, table: createStringFunctions(memory) };
};

test('strrchr finds the last one, and the terminator when asked for it', ()=>{
    const { memory, table } = build();
    const string = memory.put('a/b/c');
    assert.equal(table.strrchr.handler([string, '/'.charCodeAt(0)]), string + 3);
    assert.equal(table.strrchr.handler([string, 'z'.charCodeAt(0)]), 0);
    assert.equal(table.strrchr.handler([string, 0]), string + 5);
});

test('strpbrk answers a pointer into the caller\'s string, not an index', ()=>{
    const { memory, table } = build();
    const string = memory.put('name=value');
    assert.equal(table.strpbrk.handler([string, memory.put(':=')]), string + 4);
    assert.equal(table.strpbrk.handler([string, memory.put('#')]), 0);
});

test('strspn and strcspn count from the front and stop for opposite reasons', ()=>{
    const { memory, table } = build();
    assert.equal(table.strspn.handler([memory.put('  \tx'), memory.put(' \t')]), 3);
    assert.equal(table.strcspn.handler([memory.put('abc=d'), memory.put('=')]), 3);
});

test('strncat bounds what is appended and always terminates', ()=>{
    const { memory, table } = build();
    const destination = memory.allocate(64);
    memory.writeMemory(destination, new Uint8Array([0x61, 0x62, 0]));
    table.strncat.handler([destination, memory.put('cdef'), 2]);
    assert.equal(memory.text(destination), 'abcd');
});

test('_strnicmp folds case and compares no further than the count', ()=>{
    const { memory, table } = build();
    assert.equal(table._strnicmp.handler([memory.put('ABCx'), memory.put('abcy'), 3]), 0);
    assert.equal(table._strnicmp.handler([memory.put('ABCx'), memory.put('abcy'), 4]), -1);
});

test('the in-place transforms edit the caller\'s buffer and answer it', ()=>{
    const { memory, table } = build();
    const string = memory.put('aBc');
    assert.equal(table._strupr.handler([string]), string);
    assert.equal(memory.text(string), 'ABC');
    table._strlwr.handler([string]);
    assert.equal(memory.text(string), 'abc');
    table._strrev.handler([string]);
    assert.equal(memory.text(string), 'cba');
});

test('strtok writes terminators into the string it was given', ()=>{
    const { memory, table } = build();
    const string = memory.put('one,two');
    const delimiters = memory.put(',');
    assert.equal(table.strtok.handler([string, delimiters]), string);
    assert.equal(memory.text(string), 'one', 'the comma became a terminator');
});

test('strtok carries on from where it stopped when handed null', ()=>{
    const { memory, table } = build();
    const string = memory.put('a,,b,');
    const delimiters = memory.put(',');
    assert.equal(memory.text(table.strtok.handler([string, delimiters])), 'a');
    assert.equal(memory.text(table.strtok.handler([0, delimiters])), 'b');
    assert.equal(table.strtok.handler([0, delimiters]), 0, 'nothing but delimiters left');
    assert.equal(table.strtok.handler([0, delimiters]), 0, 'and it stays finished');
});

test('a new string resets the single stream, which is what makes it single', ()=>{
    const { memory, table } = build();
    const delimiters = memory.put(' ');
    table.strtok.handler([memory.put('a b'), delimiters]);
    assert.equal(memory.text(table.strtok.handler([memory.put('c d'), delimiters])), 'c');
});

test('_strdup allocates, and answers null when it cannot', ()=>{
    const { memory, table } = build();
    const copy = table._strdup.handler([memory.put('text')]);
    assert.equal(memory.text(copy), 'text');

    const starved = createStringFunctions({ ...memory, allocate: ()=>0 });
    assert.equal(starved._strdup.handler([memory.put('text')]), 0);
});

test('memchr searches bytes rather than a string, terminators included', ()=>{
    const { memory, table } = build();
    const buffer = memory.allocate(8);
    memory.writeMemory(buffer, new Uint8Array([1, 0, 2, 3]));
    assert.equal(table.memchr.handler([buffer, 2, 4]), buffer + 2);
    assert.equal(table.memchr.handler([buffer, 0, 4]), buffer + 1);
    assert.equal(table.memchr.handler([buffer, 9, 4]), 0);
});

test('the classifiers answer one or zero, under the C locale', ()=>{
    const { table } = build();
    assert.equal(table.isalpha.handler(['q'.charCodeAt(0)]), 1);
    assert.equal(table.isalpha.handler(['1'.charCodeAt(0)]), 0);
    assert.equal(table.isxdigit.handler(['F'.charCodeAt(0)]), 1);
    assert.equal(table.ispunct.handler(['!'.charCodeAt(0)]), 1);
    assert.equal(table.isprint.handler([0x20]), 1);
});

test('iscntrl covers both control ranges and nothing between them', ()=>{
    const { table } = build();
    assert.equal(table.iscntrl.handler([0x00]), 1);
    assert.equal(table.iscntrl.handler([0x1f]), 1);
    assert.equal(table.iscntrl.handler([0x20]), 0);
    assert.equal(table.iscntrl.handler([0x7f]), 1, 'delete is a control character');
    assert.equal(table.iscntrl.handler([0x80]), 0);
});

test('a value outside unsigned char classifies as nothing at all', ()=>{
    const { table } = build();
    assert.equal(table.isdigit.handler([-1]), 0, 'EOF is not a digit');
    assert.equal(table.isspace.handler([0x120]), 0);
});

test('_isctype answers by the real msvcrt bit values, from _UPPER to _ALPHA', ()=>{
    const { table } = build();
    const UPPER = 0x0001;
    const DIGIT = 0x0004;
    const SPACE = 0x0008;
    const ALPHA = 0x0103;
    assert.equal(table._isctype.handler(['A'.charCodeAt(0), UPPER]), 1);
    assert.equal(table._isctype.handler(['a'.charCodeAt(0), UPPER]), 0);
    assert.equal(table._isctype.handler(['a'.charCodeAt(0), ALPHA]), 1);
    assert.equal(table._isctype.handler(['5'.charCodeAt(0), DIGIT]), 1);
    assert.equal(table._isctype.handler([' '.charCodeAt(0), SPACE]), 1);
    // EOF classifies as nothing, the same as every classifier above.
    assert.equal(table._isctype.handler([-1, UPPER | DIGIT | SPACE]), 0);
});

test('_pctype publishes a table a guest can index straight through, EOF included', ()=>{
    const { memory, table } = build();
    const UPPER = 0x0001;
    const DIGIT = 0x0004;
    const ALPHA = 0x0103;
    const pointerBytes = table._pctype.data();
    const pointer = new DataView(pointerBytes.buffer, pointerBytes.byteOffset).getUint32(0, true);
    const view = new DataView(memory.bytes.buffer, memory.bytes.byteOffset);
    const maskOf = (/** @type {number} */ code)=>view.getUint16(pointer + code * 2, true);
    assert.equal(maskOf('A'.charCodeAt(0)) & UPPER, UPPER);
    assert.equal(maskOf('9'.charCodeAt(0)) & DIGIT, DIGIT);
    assert.notEqual(maskOf('z'.charCodeAt(0)) & ALPHA, 0, 'z overlaps the _ALPHA mask');
    assert.equal(maskOf('z'.charCodeAt(0)) & UPPER, 0, 'but carries none of _UPPER');
    // pctype[-1], the EOF slot: a loop over getc()'s own result classifies it
    // before ever comparing against EOF, and real msvcrt answers nothing there.
    assert.equal(view.getUint16(pointer - 2, true), 0);
});

/**
 * A megabyte whose answer sits at byte 3, laid down once for the scans below:
 * three spaces, an 'x', then filler to the terminator.
 *
 * @param {ReturnType<typeof fakeMemory>} memory
 */
function megabyte(memory){
    const size = 1 << 20;
    const string = memory.allocate(size + 8);
    memory.writeMemory(string, new Uint8Array([0x20, 0x20, 0x20, 0x78]));
    memory.fillMemory(string + 4, 0x61, size - 5);
    memory.writeMemory(string + size - 1, new Uint8Array(1));
    return string;
}

test('a span counts to its answer without reading the string behind it', ()=>{
    const memory = fakeMemory(0x10000, 0x130000);
    const table = createStringFunctions(memory);
    const string = megabyte(memory);

    memory.asked = 0;
    assert.equal(table.strspn.handler([string, memory.put(' \t')]), 3,
        'the first byte the set does not cover ends the span');
    assert.ok(memory.asked < 4096,
        `the answer at byte 3 costs what the walk read: ${memory.asked} bytes`);

    memory.asked = 0;
    assert.equal(table.strcspn.handler([string, memory.put('x')]), 3,
        'the first byte the set covers ends the span');
    assert.ok(memory.asked < 4096, `${memory.asked} bytes`);
});

test('strpbrk stops at its answer without reading the string behind it', ()=>{
    const memory = fakeMemory(0x10000, 0x130000);
    const table = createStringFunctions(memory);
    const string = megabyte(memory);

    memory.asked = 0;
    assert.equal(table.strpbrk.handler([string, memory.put('x')]), string + 3);
    assert.ok(memory.asked < 4096, `${memory.asked} bytes`);
});

test('the scans still answer from the whole string when the answer is late', ()=>{
    const { memory, table } = build();
    const string = memory.put('aaaaaaaaab');
    assert.equal(table.strspn.handler([string, memory.put('a')]), 9);
    assert.equal(table.strcspn.handler([string, memory.put('b')]), 9);
    assert.equal(table.strpbrk.handler([string, memory.put('b')]), string + 9);
    assert.equal(table.strspn.handler([string, memory.put('')]), 0, 'an empty set spans nothing');
    assert.equal(table.strcspn.handler([string, memory.put('')]), 10,
        'an empty set rejects nothing, so the terminator ends the span');
    assert.equal(table.strpbrk.handler([string, memory.put('')]), 0, 'and finds nothing');
});
