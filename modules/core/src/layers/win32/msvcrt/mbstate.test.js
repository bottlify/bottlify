/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRestartableFunctions } from './mbstate.js';
import { fakeMemory } from './harness.test.js';

const build = ()=>{
    const memory = fakeMemory();
    /** @type {number[]} */
    const errno = [];
    const table = /** @type {Record<string, any>} */ (createRestartableFunctions({
        ...memory, errno: code=>errno.push(code) }));
    /** @param {number} at @param {number} count */
    const units = (at, count)=>Array.from({ length: count },
        (_, i)=>memory.bytes[at + i * 2] | memory.bytes[at + i * 2 + 1] << 8);
    return { memory, table, errno, units };
};

test('btowc and wctob: a byte is the character of its own value in the C locale', ()=>{
    // Wine's msvcrt test_btowc and test_wctob, their C-locale halves.
    const { table } = build();
    assert.deepEqual([-1, 0x61, 0x81, 0x9f, 0xe0, 0x100, 0x1e0].map(c=>table.btowc.handler([c])),
        [0xffff, 0x61, 0x81, 0x9f, 0xe0, 0, 0xe0]);
    assert.deepEqual([0x8141, 0x81, 0x9f, 0xe0].map(c=>table.wctob.handler([c])),
        [-1, -127, -97, -32]);
});

test('mbrlen, mbrtowc and wcrtomb take one byte a character and leave the state zero', ()=>{
    const { memory, table, errno } = build();
    const text = memory.put('ab');
    const state = memory.allocate(4);
    memory.setU32(state, 0x55);
    assert.equal(table.mbrlen.handler([text, 2, state]), 1);
    assert.equal(memory.u32(state), 0);
    assert.equal(table.mbrlen.handler([text, 0, 0]) >>> 0, 0xfffffffe, 'nothing to read');
    assert.equal(table.mbrlen.handler([text + 2, 1, 0]), 0, 'the terminator');
    const out = memory.allocate(4);
    assert.equal(table.mbrtowc.handler([out, text + 1, 1, 0]), 1);
    assert.equal(memory.bytes[out], 0x62);
    assert.equal(table.wcrtomb.handler([out, 0x20, 0]), 1);
    assert.equal(memory.bytes[out], 0x20);
    assert.equal(table.wcrtomb.handler([0, 0x3042, 0]), 1, 'no destination: a reset');
    assert.equal(table.wcrtomb.handler([out, 0x3042, 0]) >>> 0, 0xffffffff);
    assert.deepEqual(errno, [42], 'EILSEQ');
    const length = memory.allocate(4);
    assert.equal(table.wcrtomb_s.handler([length, out, 4, 0x41, state]), 0);
    assert.equal(memory.u32(length), 1);
    assert.equal(table.wcrtomb_s.handler([length, 0, 0, 0x20, 0]), 0);
    assert.equal(table.wcrtomb_s.handler([length, out, 4, 0xffff, 0]), 42);
    assert.equal(memory.u32(length), 0xffffffff);
});

test('wcsrtombs moves the source past what it converted, to null after the terminator', ()=>{
    // Wine's msvcrt test_mbstowcs, its C-locale half.
    const { memory, table } = build();
    const simple = memory.putWide('text');
    const source = memory.allocate(4);
    const state = memory.allocate(4);
    const out = memory.allocate(8);
    memory.writeMemory(out, new Uint8Array(8).fill(0x21));
    memory.setU32(source, simple);
    memory.setU32(state, 0xfffffffd);
    assert.equal(table.wcsrtombs.handler([out, source, 4, state]), 4);
    assert.equal(memory.u32(state), 0);
    assert.equal(memory.u32(source), simple + 8);
    assert.equal(memory.bytes[out + 4], 0x21, 'no terminator within the count');
    memory.setU32(source, simple);
    assert.equal(table.wcsrtombs.handler([out, source, 5, 0]), 4);
    assert.equal(memory.u32(source), 0);
    assert.equal(memory.text(out), 'text');
    memory.setU32(source, simple);
    assert.equal(table.wcsrtombs.handler([0, source, 0, 0]), 4, 'counted');
    assert.equal(memory.u32(source), simple);

    const narrow = memory.put('ab');
    memory.setU32(source, narrow);
    assert.equal(table.mbsrtowcs.handler([out, source, 6, 0]), 2);
    assert.equal(memory.u32(source), 0);
    assert.equal(table.mbsrtowcs.handler([out, 0, 6, 0]) >>> 0, 0xffffffff, 'no source');
});

test('wcstombs_s and _wcstombs_s_l answer as Wine\'s test__wcstombs_s_l in the C locale', ()=>{
    const { memory, table } = build();
    const converted = memory.allocate(4);
    const out = memory.allocate(8);
    for (const [text, count, size, withBuffer, ret, err, written] of
        /** @type {[string, number, number, boolean, number, number, string][]} */ ([
            ['', 0, 0, false, 1, 0, ''], ['�', 1, 0, false, 2, 0, ''],
            ['�', 1, 1, true, 0, 42, ''], ['�', 1, 6, true, 0, 42, ''],
            ['text', 0xffffffff, 5, true, 5, 0, 'text'], ['text', 0xffffffff, 1, true, 1, 80, ''],
            ['text', 5, 3, true, 0, 34, ''],
        ]))
    {
        memory.writeMemory(out, new Uint8Array(8).fill(0xcc));
        memory.setU32(converted, 0xffffffff);
        const name = `${JSON.stringify(text)} ${count} ${size}`;
        for (const [entry, args] of /** @type {[string, number[]][]} */ ([
            ['wcstombs_s', [converted, withBuffer ? out : 0, size, memory.putWide(text), count]],
            ['_wcstombs_s_l', [converted, withBuffer ? out : 0, size, memory.putWide(text), count,
                0]]]))
        {
            assert.equal(table[entry].handler(args), err, `${entry} ${name}`);
            assert.equal(memory.u32(converted), ret, `${entry} ${name}`);
            if (withBuffer)
            {
                assert.equal(memory.text(out), written, `${entry} ${name}`);
            }
        }
    }
});

test('mbstowcs_s converts the bytes and counts the terminator', ()=>{
    const { memory, table, units } = build();
    const converted = memory.allocate(4);
    const out = memory.allocate(16);
    assert.equal(table.mbstowcs_s.handler([converted, out, 6, memory.put('text'), 0xffffffff]), 0);
    assert.equal(memory.u32(converted), 5);
    assert.deepEqual(units(out, 5), [0x74, 0x65, 0x78, 0x74, 0]);
    assert.equal(table.mbstowcs_s.handler([converted, out, 1, memory.put('text'), 0xffffffff]), 80);
    assert.equal(memory.u32(converted), 1);
    assert.deepEqual(units(out, 1), [0]);
    assert.equal(table.mbstowcs_s.handler([converted, 0, 0, memory.put('text'), 2]), 0);
    assert.equal(memory.u32(converted), 3);
});
