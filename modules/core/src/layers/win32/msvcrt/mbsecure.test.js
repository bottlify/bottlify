/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMultiByteFunctions } from './mbstring.js';
import { fakeMemory } from './harness.test.js';

const build = ()=>{
    const memory = fakeMemory();
    /** @type {number[]} */
    const errno = [];
    const table = /** @type {Record<string, any>} */ (createMultiByteFunctions({},
        { ...memory, errno: code=>errno.push(code) }));
    /** @param {number[]} values */
    const bytes = values=>{
        const at = memory.allocate(32);
        memory.writeMemory(at, Uint8Array.from(values));
        return at;
    };
    /** @param {number} at @param {number} count */
    const read = (at, count)=>[...memory.bytes.subarray(at, at + count)];
    /** @param {string} text */
    const codes = text=>Array.from(text, c=>c.charCodeAt(0));
    return { memory, table, errno, bytes, read, codes };
};

test('_mbscat_s appends by characters, and drops a lead byte the terminator follows', ()=>{
    // Wine's msvcrt test__mbscat_s.
    const { table, bytes, read, codes } = build();
    const dst = bytes(new Array(8).fill(0));
    assert.equal(table._mbscat_s.handler([0, 8, bytes([0])]), 22);
    assert.equal(table._mbscat_s.handler([dst, 8, 0]), 22);
    const one = bytes([0x61]);
    assert.equal(table._mbscat_s.handler([one, 1, bytes([0])]), 22, 'no terminator in reach');
    const six = bytes([...codes('aaaaaa'), 0, 0x61]);
    const b = bytes([0x62, 0]);
    assert.equal(table._mbscat_s.handler([six, 8, b]), 0);
    assert.deepEqual(read(six, 8), [...codes('aaaaaab'), 0]);
    assert.equal(table._mbscat_s.handler([six, 8, b]), 34);
    assert.deepEqual(read(six, 2), [0, 0x61], 'ERANGE zeroes the first byte');
    table._setmbcp.handler([932]);
    assert.equal(table._mbscat_s.handler([bytes([0x81, 0x81, 0x52, 0]), 8, bytes([0x61, 0])]), 0);
    assert.equal(table._mbscat_s.handler([bytes([0]), 8, bytes([0x81, 0x81, 0x52, 0])]), 0);
    const lead = bytes([0x61, 0x81, 0]);
    assert.equal(table._mbscat_s.handler([lead, 8, bytes([0x52, 0])]), 42);
    assert.deepEqual(read(lead, 3), [0x61, 0x52, 0]);
    const short = bytes([0x61, 0]);
    assert.equal(table._mbscat_s.handler([short, 8, bytes([0x62, 0x81, 0])]), 42);
    assert.deepEqual(read(short, 3), [0x61, 0x62, 0]);
});

test('_mbscpy_s and _mbsnbcpy_s copy what fits, or zero the first byte', ()=>{
    // Wine's msvcrt test__mbscpy_s and test__mbsnbcpy_s.
    const { table, bytes, read, codes } = build();
    const src = bytes([...codes('source string'), 0]);
    assert.equal(table._mbscpy_s.handler([0, 0, src]), 22);
    const dest = bytes(new Array(16).fill(0x58));
    assert.equal(table._mbscpy_s.handler([dest, 16, 0]), 22);
    assert.equal(read(dest, 1)[0], 0);
    assert.equal(table._mbscpy_s.handler([dest, 16, src]), 0);
    assert.deepEqual(read(dest, 14), [...codes('source string'), 0]);
    const small = bytes(new Array(16).fill(0x58));
    assert.equal(table._mbscpy_s.handler([small, 4, src]), 34);
    assert.deepEqual(read(small, 2), [0, 0x6f]);

    const big = bytes([...codes('atoolongstring'), 0]);
    const out = bytes(new Array(8).fill(0x58));
    assert.equal(table._mbsnbcpy_s.handler([out, 8, bytes([...codes('small'), 0]), 6]), 0);
    assert.deepEqual(read(out, 8), [...codes('small'), 0, 0x58, 0x58]);
    assert.equal(table._mbsnbcpy_s.handler([out, 6, big, 6]), 34);
    assert.deepEqual(read(out, 6), [0, ...codes('toolo')]);
    assert.equal(table._mbsnbcpy_s.handler([out, 6, big, 4]), 0);
    assert.deepEqual(read(out, 5), [...codes('atoo'), 0]);
});

test('_mbsnbcat_s appends at most count bytes, ERANGE keeping what fit', ()=>{
    // Wine's msvcrt test__mbsnbcat_s.
    const { table, bytes, read, codes } = build();
    assert.equal(table._mbsnbcat_s.handler([0, 0, 0, 0]), 0, 'nothing to do');
    assert.equal(table._mbsnbcat_s.handler([0, 10, 0, 0]), 22);
    const duck = bytes([...codes('duck'), 0]);
    const empty = bytes(new Array(16).fill(0x58));
    assert.equal(table._mbsnbcat_s.handler([empty, 0, duck, 0]), 22);
    assert.equal(read(empty, 1)[0], 0x58);
    assert.equal(table._mbsnbcat_s.handler([empty, 16, 0, 0]), 22);
    assert.equal(read(empty, 1)[0], 0);
    /** @param {number} size @param {number} count */
    const append = (size, count)=>{
        const dest = bytes([...codes('dinosaur'), 0, ...new Array(7).fill(0x58)]);
        return { answer: table._mbsnbcat_s.handler([dest, size, duck, count]), dest };
    };
    for (const [count, text] of /** @type {[number, string][]} */ ([[0, 'dinosaur'],
        [5, 'dinosaurduck'], [6, 'dinosaurduck'], [4, 'dinosaurduck'], [3, 'dinosaurduc']]))
    {
        const { answer, dest } = append(16, count);
        assert.equal(answer, 0);
        assert.deepEqual(read(dest, text.length + 1), [...codes(text), 0], `${count}`);
    }
    let { answer, dest } = append(8, 5);
    assert.equal(answer, 22);
    assert.deepEqual(read(dest, 8), [0, ...codes('inosaur')]);
    ({ answer, dest } = append(9, 5));
    assert.equal(answer, 34);
    assert.deepEqual(read(dest, 9), [0, ...codes('inosaurd')]);
    ({ answer, dest } = append(10, 5));
    assert.equal(answer, 34);
    assert.deepEqual(read(dest, 10), [0, ...codes('inosaurdu')]);
});

test('_mbsupr_s and _mbslwr_s change the case within the size given', ()=>{
    // Wine's msvcrt test__mbsupr_s and test__mbslwr_s, their single-byte cases.
    const { table, bytes, read, codes } = build();
    assert.equal(table._mbsupr_s.handler([0, 0]), 0);
    assert.equal(table._mbsupr_s.handler([0, 20]), 22);
    const text = bytes([...codes('abcdefgh'), 0, ...codes('ijkl'), 0]);
    assert.equal(table._mbsupr_s.handler([text, 0]), 22);
    assert.equal(table._mbsupr_s.handler([text, 8]), 22, 'no terminator in reach');
    const other = bytes([...codes('abcdefgh'), 0, ...codes('ijkl'), 0]);
    assert.equal(table._mbsupr_s.handler([other, 20]), 0);
    assert.deepEqual(read(other, 14), [...codes('ABCDEFGH'), 0, ...codes('ijkl'), 0]);
    assert.equal(table._mbslwr_s.handler([other, 9]), 0);
    assert.deepEqual(read(other, 9), [...codes('abcdefgh'), 0]);
});

test('_mbsnlen counts to max, or the characters before a terminator in reach', ()=>{
    // Wine's msvcrt test_mbcp under page 936.
    const { table, bytes } = build();
    table._setmbcp.handler([936]);
    const mbstring = bytes([0xb0, 0xb1, 0xb2, 0x20, 0xb3, 0xb4, 0x20, 0xb5, 0]);
    const onlyLead = bytes([0xb0, 0, 0xb1, 0xb2, 0x20, 0xb3, 0]);
    const mbstring2 = bytes([0xb0, 0xb1, 0xb2, 0xb3, 0x51, 0xb4, 0xb5, 0]);
    assert.deepEqual([8, 9, 10].map(max=>table._mbsnlen.handler([mbstring, max])), [8, 4, 4]);
    assert.deepEqual([0, 1, 2].map(max=>table._mbsnlen.handler([onlyLead, max])), [0, 1, 0]);
    assert.deepEqual([7, 8, 9].map(max=>table._mbsnlen.handler([mbstring2, max])), [7, 4, 4]);
    assert.equal(table._mbsnextc_l.handler([mbstring, 0]), 0xb0b1);
});

test('_mbccpy_s copies one character, or says why not', ()=>{
    // Wine's msvcrt test_mbcp under page 936.
    const { memory, table, bytes, read } = build();
    table._setmbcp.handler([936]);
    const source = bytes([0xb0, 0xb1, 0]);
    const copied = memory.allocate(4);
    const buffer = bytes([0xff, 0xff, 0xff]);
    assert.equal(table._mbccpy_s.handler([buffer, 0, copied, source]), 22);
    assert.equal(memory.u32(copied), 0);
    assert.equal(read(buffer, 1)[0], 0xff);
    assert.equal(table._mbccpy_s.handler([buffer, 1, copied, source]), 34);
    assert.equal(memory.u32(copied), 0);
    assert.equal(read(buffer, 1)[0], 0);
    assert.equal(table._mbccpy_s.handler([buffer, 2, copied, source]), 0);
    assert.equal(memory.u32(copied), 2);
    assert.deepEqual(read(buffer, 3), [0xb0, 0xb1, 0xff]);
    const half = bytes([0xff, 0xff]);
    assert.equal(table._mbccpy_s.handler([half, 2, copied, bytes([0xb0, 0])]), 42);
    assert.equal(memory.u32(copied), 1);
    assert.deepEqual(read(half, 2), [0, 0xff]);
});

test('_mbscmp and _mbsicmp of no string are _NLSCMPERROR and EINVAL', ()=>{
    // Wine's msvcrt test__mbscmp.
    const { table, errno, bytes } = build();
    const a = bytes([0x61, 0]);
    const b = bytes([0x62, 0]);
    for (const name of ['_mbscmp', '_mbsicmp'])
    {
        assert.equal(table[name].handler([0, 0]), 0x7fffffff, name);
        assert.equal(table[name].handler([a, 0]), 0x7fffffff, name);
        assert.equal(table[name].handler([0, a]), 0x7fffffff, name);
        assert.equal(table[name].handler([a, a]), 0, name);
        assert.equal(table[name].handler([a, b]), -1, name);
        assert.equal(table[name].handler([b, a]), 1, name);
    }
    assert.deepEqual(errno, [22, 22, 22, 22, 22, 22]);
    assert.equal(table._mbscmp_l.handler([a, b, 0]), -1);
});

test('a double-byte letter changes case as its page\'s characters do', ()=>{
    // Wine's msvcrt test__mbsupr_s and test__mbslwr_s under page 936: the
    // small Roman numerals one and two, and their capitals.
    const { table, bytes, read } = build();
    table._setmbcp.handler([936]);
    const text = bytes([0xa2, 0xa1, 0xa2, 0xa2, 0x71, 0]);
    assert.equal(table._mbsupr_s.handler([text, 20]), 0);
    assert.deepEqual(read(text, 6), [0xa2, 0xf1, 0xa2, 0xf2, 0x51, 0]);
    assert.equal(table._mbslwr_s.handler([text, 20]), 0);
    assert.deepEqual(read(text, 6), [0xa2, 0xa1, 0xa2, 0xa2, 0x71, 0]);
    table._setmbcp.handler([932]);
    const wide = bytes([0x82, 0x81, 0]);
    table._mbsupr.handler([wide]);
    assert.deepEqual(read(wide, 2), [0x82, 0x60], 'a full-width a');
});
