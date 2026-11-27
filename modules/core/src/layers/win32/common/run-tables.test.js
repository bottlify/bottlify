/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReader } from '@bottlify/cellar';
import { testCache } from '../../cache/testing.fixture.js';
import { cacheSpace } from '../../cache/module.js';
import { runTables } from './run-tables.js';

/** A table that counts its makes. */
const counted = ()=>{
    const makes = { count: 0 };
    return { makes, make: ()=>{
        makes.count++;
        return Uint16Array.from({ length: 0x1000 }, (_, at)=>at * 7 & 0xffff);
    } };
};

/**
 * A second process's reader of the run's cache: its own reader over the
 * keeper's index and segments, as each process of a run has one.
 *
 * @param {Awaited<ReturnType<typeof testCache>>} cache
 */
const secondProcess = cache=>createReader({ shared: cache.keeper.shared,
    segments: cache.keeper.segmentBuffers(),
    keeper: {
        reserve: (name, length, options)=>cache.keeper.reserve(name, length, options),
        raise: (name, options)=>cache.keeper.raise(name, options),
        raiseLater: ()=>{},
        drop: name=>cache.keeper.drop(name),
    } });

test('a table is made once for the run: a second process reads it in place', async()=>{
    const cache = await testCache();
    const { makes, make } = counted();
    const first = runTables(cache.space('tables', { idle: 'stay' }));
    assert.equal(first.table('t', Uint16Array, make).read(table=>table[0x123]), 0x123 * 7);
    assert.deepEqual(first.figures(), { made: 1, read: 0, local: 0 });
    assert.equal(cache.reader.look('tables/t'), 'hot', 'the body is the run\'s');

    const second = runTables(cacheSpace(secondProcess(cache), 'tables', { idle: 'stay' }));
    const read = second.table('t', Uint16Array, make).read(table=>[table.length, table[0xfff]]);
    assert.deepEqual(read, [0x1000, 0xfff * 7 & 0xffff]);
    assert.deepEqual(second.figures(), { made: 0, read: 1, local: 0 }, 'not made again');
    assert.equal(makes.count, 1);
});

test('without a cache, or with no room in it, a realm keeps the table it made', async()=>{
    const { makes, make } = counted();
    const alone = runTables(null);
    const table = alone.table('t', Uint16Array, make);
    table.read(()=>0);
    table.read(()=>0);
    assert.deepEqual(alone.figures(), { made: 1, read: 0, local: 1 });

    const cramped = await testCache({ budget: 4096, segmentBytes: 4096 });
    const short = runTables(cramped.space('tables', { idle: 'stay' }));
    const big = short.table('big', Uint16Array, make);
    big.read(()=>0);
    big.read(()=>0);
    assert.deepEqual(short.figures(), { made: 1, read: 0, local: 1 }, 'made once, kept here');
    assert.equal(makes.count, 2);
});

test('a table idle stays, and one taken back is made again by the next reader', async()=>{
    const cache = await testCache();
    const { makes, make } = counted();
    const tables = runTables(cache.space('tables', { idle: 'stay' }));
    const table = tables.table('t', Uint16Array, make);
    table.read(()=>0);
    cache.idle(60_000);
    assert.equal(cache.reader.look('tables/t'), 'hot', 'idle, it stays');
    cache.reader.drop('tables/t');
    cache.idle(1);
    assert.equal(table.read(view=>view[1]), 7);
    assert.equal(makes.count, 2);
    assert.deepEqual(tables.figures(), { made: 2, read: 0, local: 0 });
});
