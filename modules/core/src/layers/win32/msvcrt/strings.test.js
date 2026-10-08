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

test('_strdup of no string is null, nothing read or allocated', ()=>{
    const { memory } = build();
    const table = createStringFunctions({
        ...memory,
        readCString: ()=>assert.fail('address zero read'),
        allocate: ()=>assert.fail('allocated for nothing'),
    });
    assert.equal(table._strdup.handler([0]), 0);
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

test('an upper-half string keeps its bytes through a copy, a scan and a search', ()=>{
    // The memory layer reads an ANSI string as Windows-1252, where 0x80 is the
    // euro sign, 0x99 the trade mark and 0x97 an em dash: a copy writes those
    // characters back as the same bytes, a set naming them matches those
    // bytes, and a search for one finds it.
    const { memory, table } = build();
    /** @param {number[]} bytes */
    const place = bytes=>{
        const at = memory.allocate(bytes.length + 1);
        memory.writeMemory(at, Uint8Array.from([...bytes, 0]));
        return at;
    };
    const text = [0x61, 0x80, 0x99, 0x97, 0x80, 0x62];
    const string = place(text);

    const copy = table._strdup.handler([string]);
    assert.deepEqual([...memory.bytes.subarray(copy, copy + text.length + 1)], [...text, 0]);
    assert.equal(table.strcspn.handler([string, place([0x99])]), 2);
    assert.equal(table.strspn.handler([string, place([0x61, 0x80, 0x99])]), 3);
    assert.equal(table.strrchr.handler([string, 0x80]), string + 4);
});

test('_swab swaps each pair, leaves an odd last byte where it was, and swaps in place', ()=>{
    const { memory, table } = build();
    const from = memory.put('BADCFE@#');
    const to = memory.allocate(16);
    memory.bytes.fill(0x24, to, to + 16);
    table._swab.handler([from, to, 5]);
    assert.equal(String.fromCharCode(...memory.bytes.subarray(to, to + 6)), 'ABCD$$');
    table._swab.handler([from, from, 6]);
    assert.equal(memory.text(from), 'ABCDEF@#');
    table._swab.handler([from, to, 0]);
    table._swab.handler([from, to, -2]);
    assert.equal(memory.bytes[to + 4], 0x24, 'a count of none, or below, swaps nothing');
});

test('strxfrm under the C locale copies what the count holds and answers the length', ()=>{
    const memory = fakeMemory();
    /** @type {number[]} */
    const errno = [];
    const table = createStringFunctions({ ...memory, errno: code=>void errno.push(code) });
    const source = memory.put('src');
    const destination = memory.allocate(8);
    memory.bytes.fill(0x61, destination, destination + 8);
    assert.equal(table.strxfrm.handler([0, source, 0]), 3, 'no buffer asks the length');
    assert.equal(table.strxfrm.handler([destination, source, 1]), 3);
    assert.deepEqual([...memory.bytes.subarray(destination, destination + 2)], [0x73, 0x61],
        'a count short of the string is not terminated');
    assert.equal(table.strxfrm.handler([destination, source, 5]), 3);
    assert.equal(memory.text(destination), 'src');
    assert.deepEqual(errno, []);
    assert.equal(table.strxfrm.handler([0, source, 1]), 0x7fffffff);
    assert.equal(table.strxfrm.handler([destination, 0, 8]), 0x7fffffff);
    assert.deepEqual(errno, [22, 22]);
});

test('_memicmp folds the ASCII letters and answers the difference of the bytes', ()=>{
    const memory = fakeMemory();
    /** @type {number[]} */
    const errno = [];
    const table = createStringFunctions({ ...memory, errno: code=>void errno.push(code) });
    const left = memory.put('abc');
    const right = memory.put('aBd');
    assert.equal(table._memicmp.handler([0, 0, 0]), 0, 'nothing to compare, nothing read');
    assert.equal(table._memicmp.handler([left, right, 2]), 0);
    assert.equal(table._memicmp.handler([left, right, 3]), -1);
    assert.equal(table._memicmp.handler([memory.put('\xe9'), memory.put('\xc9'), 1]), 0x20,
        'no letter past ASCII is folded');
    assert.deepEqual(errno, []);
    assert.equal(table._memicmp.handler([left, 0, 1]), 0x7fffffff);
    assert.deepEqual(errno, [22]);
});

test('strcoll under the C locale is the bytes\' order, as strcmp answers it', ()=>{
    const { memory, table } = build();
    /** @param {string} a @param {string} b */
    const coll = (a, b)=>table.strcoll.handler([memory.put(a), memory.put(b)]) | 0;
    assert.equal(coll('apple', 'apple'), 0);
    assert.equal(coll('apple', 'banana'), -1);
    assert.equal(coll('b', 'a'), 1);
    assert.equal(coll('ab', 'a'), 1, 'the longer, where one is the other\'s start');
    assert.equal(coll('B', 'a'), -1, 'upper case first: bytes, not a dictionary');
    const high = memory.allocate(4);
    memory.bytes.set([0xe9, 0], high);
    assert.equal(table.strcoll.handler([high, memory.put('z')]) | 0, 1,
        'a byte past 0x7f is unsigned');
    assert.equal(table.strcoll.handler([0, memory.put('z')]), 0x7fffffff, '_NLSCMPERROR');
    assert.equal(table.strcoll.convention, 'cdecl');
});

test('_ctype is the classification array itself, EOF\'s slot first', ()=>{
    const { table } = build();
    const bytes = table._ctype.data();
    assert.equal(bytes.length, 257 * 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    /** @param {number} code */
    const maskOf = code=>view.getUint16((code + 1) * 2, true);
    assert.equal(view.getUint16(0, true), 0, 'EOF has no class');
    assert.equal(maskOf('A'.charCodeAt(0)), 0x0181, '_UPPER | _HEX | the alpha mark');
    assert.equal(maskOf('a'.charCodeAt(0)), 0x0182);
    assert.equal(maskOf('5'.charCodeAt(0)), 0x0084, '_DIGIT | _HEX');
    assert.equal(maskOf(' '.charCodeAt(0)), 0x0048, '_SPACE | _BLANK');
    assert.equal(maskOf('\t'.charCodeAt(0)), 0x0068, '_SPACE | _CONTROL | _BLANK');
    assert.equal(maskOf('!'.charCodeAt(0)), 0x0010, '_PUNCT');
    assert.equal(maskOf(0xe9), 0, 'nothing above 0x7f under the C locale');
});
