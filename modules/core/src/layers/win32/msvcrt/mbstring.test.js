/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWideFunctions, createMultiByteFunctions } from './mbstring.js';
import { createMsvcrtFunctions } from './functions.js';
import { fakeMemory } from './harness.test.js';

const build = ()=>{
    const memory = fakeMemory();
    return {
        memory,
        table: /** @type {Record<string, any>} */ (createWideFunctions(memory)),
    };
};

test('wcslen counts units, not bytes', ()=>{
    const { memory, table } = build();
    assert.equal(table.wcslen.handler([memory.putWide('abcd')]), 4);
});

test('wcscpy and wcscat write terminated wide strings', ()=>{
    const { memory, table } = build();
    const destination = memory.allocate(64);
    table.wcscpy.handler([destination, memory.putWide('one')]);
    table.wcscat.handler([destination, memory.putWide('two')]);
    assert.equal(memory.wide(destination), 'onetwo');
});

test('wcsncpy pads to the count and does not terminate when it truncates', ()=>{
    const { memory, table } = build();
    const destination = memory.allocate(64);
    memory.writeMemory(destination, new Uint8Array(64).fill(0xff));
    table.wcsncpy.handler([destination, memory.putWide('abcdef'), 3]);
    assert.equal(memory.wide(destination, 3), 'abc');
    assert.equal(new DataView(memory.bytes.buffer).getUint16(destination + 6, true), 0xffff,
        'nothing was written past the count');
});

test('wcschr answers a pointer into the caller\'s own string, two bytes per unit', ()=>{
    const { memory, table } = build();
    const string = memory.putWide('abc');
    assert.equal(table.wcschr.handler([string, 'b'.charCodeAt(0)]), string + 2);
    assert.equal(table.wcschr.handler([string, 'z'.charCodeAt(0)]), 0);
    assert.equal(table.wcschr.handler([string, 0]), string + 6, 'the terminator is findable');
});

test('wcsstr and wcsrchr scale their index the same way', ()=>{
    const { memory, table } = build();
    const string = memory.putWide('abcabc');
    assert.equal(table.wcsstr.handler([string, memory.putWide('ca')]), string + 4);
    assert.equal(table.wcsrchr.handler([string, 'a'.charCodeAt(0)]), string + 6);
});

test('the wide comparisons are ordered and case folding is ASCII', ()=>{
    const { memory, table } = build();
    assert.equal(table.wcscmp.handler([memory.putWide('a'), memory.putWide('b')]), -1);
    assert.equal(table.wcsncmp.handler([memory.putWide('abz'), memory.putWide('aby'), 2]), 0);
    assert.equal(table._wcsicmp.handler([memory.putWide('ABC'), memory.putWide('abc')]), 0);
});

test('mbstowcs with a null destination answers the length it would need', ()=>{
    const { memory, table } = build();
    assert.equal(table.mbstowcs.handler([0, memory.put('hello'), 0]), 5);
});

test('mbstowcs terminates only when the terminator fits inside the count', ()=>{
    const { memory, table } = build();
    const destination = memory.allocate(64);
    memory.writeMemory(destination, new Uint8Array(64).fill(0xff));
    assert.equal(table.mbstowcs.handler([destination, memory.put('hello'), 3]), 3);
    assert.equal(memory.wide(destination, 3), 'hel');
    assert.equal(new DataView(memory.bytes.buffer).getUint16(destination + 6, true), 0xffff,
        'a full buffer comes back unterminated');
});

test('wcstombs narrows, and answers the count without a destination', ()=>{
    const { memory, table } = build();
    const destination = memory.allocate(64);
    assert.equal(table.wcstombs.handler([0, memory.putWide('abc'), 0]), 3);
    table.wcstombs.handler([destination, memory.putWide('abc'), 8]);
    assert.equal(memory.text(destination), 'abc');
});

test('mbtowc reports one byte consumed, and zero at the terminator', ()=>{
    const { memory, table } = build();
    const unit = memory.allocate(4);
    const source = memory.put('x');
    assert.equal(table.mbtowc.handler([unit, source, 4]), 1);
    assert.equal(memory.wide(unit, 1), 'x');
    assert.equal(table.mbtowc.handler([unit, source + 1, 4]), 0);
});

test('the multi-byte names are bound to the byte functions themselves', ()=>{
    const memory = fakeMemory();
    const narrow = createMsvcrtFunctions({
        ...memory,
        write: ()=>{},
        callGuest: async()=>0,
    });
    const multi = /** @type {Record<string, any>} */ (createMultiByteFunctions(narrow));
    assert.equal(multi._mbscpy, narrow.strcpy, 'one implementation, two names');
    assert.equal(multi._mbslen, narrow.strlen);
    assert.equal(multi._mbsicmp, narrow._stricmp);
});

test('under a single-byte locale a character is one byte and nothing leads', ()=>{
    const multi = /** @type {Record<string, any>} */ (createMultiByteFunctions({}));
    assert.equal(multi._mbclen.handler([0]), 1);
    assert.equal(multi._ismbblead.handler([0x81]), 0);
    assert.equal(multi._mbsinc.handler([0x1000]), 0x1001);
    assert.equal(multi._mbsdec.handler([0x1000, 0x1004]), 0x1003);
    assert.equal(multi._mbsdec.handler([0x1000, 0x1000]), 0, 'nothing before the start');
});
