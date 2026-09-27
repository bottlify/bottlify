/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSecureFunctions, STRUNCATE } from './secure.js';
import { fakeMemory } from './harness.test.js';

const EINVAL = 22;
const ERANGE = 34;

const build = ()=>{
    const memory = fakeMemory();
    const errno = /** @type {number[]} */ ([]);
    const table = /** @type {Record<string, any>} */ (createSecureFunctions({
        ...memory, errno: code=>errno.push(code),
    }));
    /** A buffer of `size` bytes filled with 'X'. @param {number} size */
    const filled = size=>{
        const at = memory.allocate(size);
        memory.fillMemory(at, 0x58, size);
        return at;
    };
    /** @param {number} at @param {number} count */
    const bytes = (at, count)=>String.fromCharCode(...memory.bytes.subarray(at, at + count));
    return { memory, table, errno, filled, bytes };
};

test('strcpy_s copies what fits and clears the first character of what does not', ()=>{
    const { memory, table, errno, filled, bytes } = build();
    const dest = filled(8);
    assert.equal(table.strcpy_s.handler([dest, 8, memory.put('small')]), 0);
    assert.equal(memory.text(dest), 'small');
    assert.equal(table.strcpy_s.handler([dest, 8, memory.put('atoolongstring')]), ERANGE);
    assert.equal(bytes(dest, 8), '\0toolong', 'the characters that fitted stay behind');
    assert.equal(table.strcpy_s.handler([dest, 8, 0]), EINVAL);
    assert.equal(bytes(dest, 1), '\0');
    assert.equal(table.strcpy_s.handler([0, 8, memory.put('x')]), EINVAL);
    assert.deepEqual(errno, [ERANGE, EINVAL, EINVAL]);
});

test('a copy ahead of its own source reads back what it wrote', ()=>{
    const { memory, table, bytes } = build();
    const dest = memory.allocate(8);
    memory.writeMemory(dest, Uint8Array.of(0x31, 0));
    assert.equal(table.strncpy_s.handler([dest + 1, 4, dest, 0xffffffff]), STRUNCATE);
    assert.equal(bytes(dest, 5), '1111\0');
    memory.writeMemory(dest, Uint8Array.of(0x31, 0, 0, 0, 0, 0));
    assert.equal(table.strcpy_s.handler([dest + 1, 4, dest]), ERANGE);
    assert.equal(bytes(dest, 5), '1\x00111');
});

test('strncpy_s copies at most count, and _TRUNCATE what fits', ()=>{
    const { memory, table, filled } = build();
    const dest = filled(8);
    const source = memory.put('abcdefghij');
    assert.equal(table.strncpy_s.handler([dest, 8, source, 3]), 0);
    assert.equal(memory.text(dest), 'abc');
    assert.equal(table.strncpy_s.handler([dest, 8, source, 0xffffffff]), STRUNCATE);
    assert.equal(memory.text(dest), 'abcdefg');
    assert.equal(table.strncpy_s.handler([dest, 8, source, 8]), ERANGE);
    assert.equal(memory.text(dest), '');
    memory.writeMemory(dest, Uint8Array.of(0x61));
    assert.equal(table.strncpy_s.handler([dest, 8, 0, 0]), 0, 'nothing to copy from nothing');
    assert.equal(memory.text(dest), '');
    assert.equal(table.strncpy_s.handler([dest, 8, 0, 1]), EINVAL);
    assert.equal(table.strncpy_s.handler([0, 0, 0, 0]), 0);
});

test('strcat_s and strncat_s need a terminator within the size', ()=>{
    const { memory, table, filled, bytes } = build();
    const dest = filled(8);
    assert.equal(table.strcat_s.handler([dest, 8, memory.put('x')]), EINVAL);
    assert.equal(bytes(dest, 2), '\0X', 'cleared, the rest as it was');
    assert.equal(table.strcat_s.handler([dest, 8, memory.put('abc')]), 0);
    assert.equal(table.strcat_s.handler([dest, 8, memory.put('def')]), 0);
    assert.equal(memory.text(dest), 'abcdef');
    assert.equal(table.strcat_s.handler([dest, 8, memory.put('gh')]), ERANGE);
    assert.equal(bytes(dest, 8), '\0bcdefgh');
    memory.writeMemory(dest, Uint8Array.of(0x61, 0));
    assert.equal(table.strncat_s.handler([dest, 4, memory.put('bcdef'), 0xffffffff]),
        STRUNCATE);
    assert.equal(memory.text(dest), 'abc');
    assert.equal(table.strncat_s.handler([dest, 8, memory.put('xyz'), 2]), 0);
    assert.equal(memory.text(dest), 'abcxy');
    assert.equal(table.strncat_s.handler([dest, 8, 0, 0]), 0);
    assert.equal(table.strncat_s.handler([dest, 8, 0, 1]), EINVAL);
    assert.equal(table.strncat_s.handler([0, 4, memory.put(''), 0]), EINVAL);
});

test('wcscpy_s and wcsncat_s count wide characters', ()=>{
    const { memory, table } = build();
    const dest = memory.allocate(16);
    assert.equal(table.wcscpy_s.handler([dest, 8, memory.putWide('wide')]), 0);
    assert.equal(memory.wide(dest), 'wide');
    assert.equal(table.wcsncat_s.handler([dest, 8, memory.putWide('open'), 0xffffffff]),
        STRUNCATE);
    assert.equal(memory.wide(dest), 'wideope');
    assert.equal(table.wcsnlen.handler([dest, 3]), 3);
    assert.equal(table.strnlen.handler([memory.put('four'), 16]), 4);
});

test('memcpy_s zeroes a destination it refuses, and memmove_s leaves it', ()=>{
    const { memory, table, errno, filled, bytes } = build();
    const dest = filled(8);
    const big = memory.put('0123456789');
    assert.equal(table.memcpy_s.handler([dest, 8, big, 6]), 0);
    assert.equal(bytes(dest, 8), '012345XX');
    assert.equal(table.memcpy_s.handler([dest, 8, big, 10]), ERANGE);
    assert.equal(bytes(dest, 8), '\0'.repeat(8));
    memory.fillMemory(dest, 0x58, 8);
    assert.equal(table.memcpy_s.handler([dest, 8, 0, 4]), EINVAL);
    assert.equal(bytes(dest, 8), '\0'.repeat(8));
    memory.fillMemory(dest, 0x58, 8);
    assert.equal(table.memcpy_s.handler([dest, 0, big, 4]), ERANGE);
    assert.equal(table.memcpy_s.handler([0, 0, 0, 0]), 0, 'nothing to copy');
    assert.equal(table.memmove_s.handler([dest, 8, big, 10]), ERANGE);
    assert.equal(table.memmove_s.handler([dest, 8, 0, 4]), EINVAL);
    assert.equal(bytes(dest, 8), 'XXXXXXXX');
    assert.deepEqual(errno, [ERANGE, EINVAL, ERANGE, ERANGE, EINVAL]);
});

test('the case functions measure before they fold, and clear on any refusal', ()=>{
    const { memory, table, bytes } = build();
    const text = memory.put('GoRrIsTeR');
    assert.equal(table._strlwr_s.handler([text, 5]), EINVAL);
    assert.equal(bytes(text, 9), '\0oRrIsTeR');
    const wide = memory.putWide('x');
    assert.equal(table._wcsupr_s.handler([wide, 0]), EINVAL);
    assert.equal(memory.wide(wide), '', 'a size of zero clears it too');
    const good = memory.putWide('mixed Case 1');
    assert.equal(table._wcsupr_s.handler([good, 32]), 0);
    assert.equal(memory.wide(good), 'MIXED CASE 1');
    assert.equal(table._strupr_s.handler([0, 4]), EINVAL);
});

test('the set functions write as they walk, short of the last place', ()=>{
    const { memory, table, bytes } = build();
    const buffer = memory.put('bbb\0');
    assert.equal(table._strnset_s.handler([buffer, 5, 0x61, 2]), 0);
    assert.equal(memory.text(buffer), 'aab');
    memory.writeMemory(buffer + 3, Uint8Array.of(0x62));
    assert.equal(table._strnset_s.handler([buffer, 4, 0x63, 2]), EINVAL);
    assert.equal(bytes(buffer, 4), '\0cbb');
    assert.equal(table._strnset_s.handler([buffer, 0, 0x61, 0]), EINVAL);
    assert.equal(table._strnset_s.handler([0, 0, 0x61, 0]), 0);
    const text = memory.putWide('text');
    assert.equal(table._wcsnset_s.handler([text, 2, 0x61, 3]), EINVAL);
    assert.deepEqual([...memory.bytes.subarray(text, text + 4)], [0, 0, 0x65, 0]);
    const pair = memory.putWide('ab');
    assert.equal(table._wcsset_s.handler([pair, 0, 0x63]), EINVAL);
    assert.equal(memory.wide(pair), 'ab');
    assert.equal(table._wcsset_s.handler([pair, 3, 0x63]), 0);
    assert.equal(memory.wide(pair), 'cc');
});

test('the _*toa_s family writes a sign and the digits from the last', ()=>{
    const { memory, table, filled, bytes } = build();
    const buffer = filled(40);
    assert.equal(table._itoa_s.handler([12345678, buffer, 4, 10]), ERANGE);
    assert.equal(bytes(buffer, 4), '\x00765');
    assert.equal(table._itoa_s.handler([-12345678, buffer, 9, 10]), ERANGE);
    assert.equal(bytes(buffer, 9), '\x0087654321');
    assert.equal(table._itoa_s.handler([12345678, buffer, 9, 10]), 0);
    assert.equal(memory.text(buffer), '12345678');
    assert.equal(table._itoa_s.handler([-8, buffer, 40, 16]), 0);
    assert.equal(memory.text(buffer), 'fffffff8', 'only base ten is signed');
    memory.fillMemory(buffer, 0x58, 40);
    assert.equal(table._itoa_s.handler([0, buffer, 0, 10]), EINVAL);
    assert.equal(bytes(buffer, 1), 'X', 'no room at all is left alone');
    assert.equal(table._itoa_s.handler([0, buffer, 40, 64]), EINVAL);
    assert.equal(bytes(buffer, 1), '\0');
    assert.equal(table._ui64toa_s.handler([0xffffffff, 0xffffffff, buffer, 40, 10]), 0);
    assert.equal(memory.text(buffer), '18446744073709551615');
    assert.equal(table._i64toa_s.handler([0xffffffff, 0xffffffff, buffer, 40, 10]), 0);
    assert.equal(memory.text(buffer), '-1');
});
