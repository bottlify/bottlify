/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLocaleFunctions } from './locale.js';
import { fakeMemory } from './harness.test.js';

/** @param {{ currentThread?: () => any, divergence?: (api: string, detail: string) => void,
 *     pointerSize?: number }} [extra] */
const build = (extra = {})=>{
    const memory = fakeMemory();
    return {
        memory,
        table: /** @type {Record<string, any>} */ (createLocaleFunctions({ ...memory, ...extra })),
    };
};

test('localeconv is the C locale\'s, and the same structure every call', ()=>{
    const { memory, table } = build();
    const conventions = table.localeconv.handler([]);
    assert.notEqual(conventions, 0);
    assert.equal(memory.text(memory.u32(conventions)), '.', 'the decimal point');
    for (let at = 1; at < 10; at++)
    {
        assert.equal(memory.text(memory.u32(conventions + at * 4)), '', `string ${at}`);
    }
    assert.deepEqual([...memory.bytes.subarray(conventions + 40, conventions + 48)],
        new Array(8).fill(127), 'every number CHAR_MAX');
    assert.equal(table.localeconv.handler([]), conventions);
});

test('a 64-bit lconv holds its ten strings as quadword pointers, its chars after them', ()=>{
    // Read as dwords, decimal_point's quadword was the decimal point and the
    // thousands separator together, and a printf of a float faulted on it.
    const { memory, table } = build({ pointerSize: 8 });
    const conventions = table.localeconv.handler([]);
    for (let at = 0; at < 10; at++)
    {
        assert.equal(memory.u32(conventions + at * 8 + 4), 0, `string ${at}'s high half`);
        assert.equal(memory.text(memory.u32(conventions + at * 8)), at === 0 ? '.' : '',
            `string ${at}`);
    }
    assert.deepEqual([...memory.bytes.subarray(conventions + 80, conventions + 88)],
        new Array(8).fill(127), 'every number CHAR_MAX, past the pointers');
});

test('the locale variables are the C locale\'s zeros', ()=>{
    const { table } = build();
    assert.deepEqual([...table.__lc_codepage.data()], [0, 0, 0, 0]);
    assert.deepEqual([...table.__lc_collate_cp.data()], [0, 0, 0, 0]);
    assert.deepEqual([...table.__lc_handle.data()], new Array(24).fill(0), 'six categories');
    assert.deepEqual([...table.__setlc_active.data()], [0, 0, 0, 0]);
    assert.deepEqual([...table.__unguarded_readlc_active.data()], [0, 0, 0, 0]);
});

test('__crtCompareStringA answers as CompareString, in the bytes\' order', ()=>{
    const { memory, table } = build();
    const compare = (/** @type {string} */ a, /** @type {number} */ aCount,
        /** @type {string} */ b, /** @type {number} */ bCount, flags = 0)=>
        table.__crtCompareStringA.handler([0, flags, memory.put(a), aCount, memory.put(b), bCount,
            0]);
    assert.equal(table.__crtCompareStringA.argBytes, 28);
    assert.equal(compare('abc', -1, 'abd', -1), 1);
    assert.equal(compare('abc', -1, 'abc', -1), 2);
    assert.equal(compare('b', -1, 'abc', -1), 3);
    assert.equal(compare('ab', -1, 'abc', -1), 1, 'a start is the less');
    assert.equal(compare('ABC', -1, 'abc', -1), 1, 'upper case sorts first as bytes');
    assert.equal(compare('ABC', -1, 'abc', -1, 1), 2, 'NORM_IGNORECASE');
    assert.equal(compare('abX', 2, 'abY', 2), 2, 'only the counts');
    assert.equal(compare('ab', 10, 'ab', -1), 2, 'a count stops at the terminator');
});

test('__crtLCMapStringA changes case, makes a key, and measures as LCMapString does', ()=>{
    const said = /** @type {string[]} */ ([]);
    const { memory, table } = build({ divergence: api=>said.push(api) });
    const source = memory.put('MiXeD');
    const out = memory.allocate(16);
    const map = (/** @type {number} */ flags, /** @type {number} */ count,
        /** @type {number} */ room)=>table.__crtLCMapStringA.handler([0, flags, source, count,
        out, room, 0, 0]);
    assert.equal(table.__crtLCMapStringA.argBytes, 32);
    assert.equal(map(0x100, -1, 0), 6, 'the bytes needed, the terminator with them');
    assert.equal(map(0x100, -1, 16), 6);
    assert.equal(memory.text(out), 'mixed');
    assert.equal(map(0x200, 5, 16), 5);
    assert.equal(memory.text(out).slice(0, 5), 'MIXED');
    assert.equal(map(0x100, -1, 5), 0, 'too little room');
    assert.equal(map(0x400, 5, 16), 6, 'a key ends in a terminator');
    assert.deepEqual([...memory.bytes.subarray(out, out + 6)], [...'MiXeD'].map(c=>c.charCodeAt(0))
        .concat(0));
    assert.equal(map(0x00400000, -1, 16), 6);
    assert.deepEqual(said, ['__crtLCMapStringA'], 'a mapping not carried is reported');
});

test('_lock is recursive for its owner and makes another thread wait for the release', async()=>{
    let current = 'one';
    const { table } = build({ currentThread: ()=>current });
    assert.equal(table._lock.handler([18]), 0);
    assert.equal(table._lock.handler([18]), 0, 'again by its owner');
    current = 'two';
    const waiting = table._lock.handler([18]);
    assert.ok(waiting instanceof Promise, 'the second thread waits');
    let resumed = false;
    waiting.then(()=>{
        resumed = true;
    });
    assert.equal(table._unlock.handler([18]), 0, 'not the owner: nothing');
    current = 'one';
    table._unlock.handler([18]);
    await Promise.resolve();
    assert.equal(resumed, false, 'still held once');
    table._unlock.handler([18]);
    await waiting;
    assert.equal(resumed, true, 'handed over');
    current = 'one';
    assert.ok(table._lock.handler([18]) instanceof Promise, 'now the second thread holds it');
    assert.equal(table._lock.handler([19]), 0, 'another number is another lock');
});

test('_lock_file holds a stream for one thread, apart from every other lock', async()=>{
    let current = 'one';
    const { table } = build({ currentThread: ()=>current });
    const stream = 0x00412000;
    assert.equal(table._lock_file.handler([stream]), 0);
    assert.equal(table._lock_file.handler([stream]), 0, 'again by its owner');
    assert.equal(table._lock.handler([stream]), 0, 'a numbered lock is not a stream\'s');
    current = 'two';
    assert.equal(table._lock_file.handler([stream + 0x30]), 0, 'another stream is free');
    const waiting = table._lock_file.handler([stream]);
    assert.ok(waiting instanceof Promise, 'the stream waits for its holder');
    current = 'one';
    table._unlock_file.handler([stream]);
    table._unlock_file.handler([stream]);
    assert.equal(await waiting, 0, 'handed over once let go as often as taken');
});

test('the locale\'s code page and longest character are the C locale\'s, through calls', ()=>{
    const { table } = build();
    assert.equal(table.___lc_codepage_func.handler([]), 0, 'as __lc_codepage holds it');
    assert.equal(table.___mb_cur_max_func.handler([]), 1, 'as __mb_cur_max');
    assert.equal(table.__lconv_init.handler([]), 0);
});
