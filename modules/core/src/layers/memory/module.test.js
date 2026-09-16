/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_COUNTERS, REGION_COLUMNS, memoryModule } from './module.js';
import { createMetrics } from '../log/internal/metrics.js';
import { readTable } from '../log/internal/table.js';

/** A log layer that only publishes, with a dictionary that numbers words in order. */
function fakeLog(){
    /** @type {string[]} */
    const words = [];
    const metrics = createMetrics({ shared: false });
    return {
        words,
        metrics,
        /** @param {string} text */
        intern: text=>{
            const at = words.indexOf(text);
            return at >= 0 ? at : words.push(text) - 1;
        },
    };
}

/** @param {any} log */
async function open(log, cpu = {}){
    return memoryModule.create({}, /** @type {any} */ ({
        /** @param {string} name */
        requireApi: name=>(name === 'log' ? log : cpu),
        provide: ()=>{},
    }));
}

test('the layout is published as a table, lowest first, and kept current', async()=>{
    const log = fakeLog();
    const memory = await open(log);
    memory.register({ name: 'stack', base: 0x300000, size: 0x10000, kind: 'stack', access: 'rw' });
    memory.register({ name: 'game.exe', base: 0x400000, size: 0x200000, kind: 'image',
        access: 'rx' });
    memory.register({ name: 'low', base: 0, size: 0x1000, kind: 'low-mem', access: 'rw' });

    const table = readTable(log.metrics.describe().memory.regions);
    assert.deepEqual(table.columns, REGION_COLUMNS);
    const rows = table.all();
    assert.deepEqual(rows.map(row=>log.words[row.name]), ['low', 'stack', 'game.exe']);
    assert.deepEqual(rows.map(row=>row.base), [0, 0x300000, 0x400000]);
    assert.equal(rows[2].size, 0x200000);

    memory.protect('game.exe', 'rwx');
    assert.equal(table.all()[2].access, Object.values(memory.Access).indexOf('rwx'),
        'a reprotected region is republished');
    await memoryModule.dispose();
});

test('the diagnostics table is the cold path and a fake log without a registry is fine', async()=>{
    const memory = await open({});
    memory.register({ name: 'stack', base: 0x300000, size: 0x10000, kind: 'stack', access: 'rw' });
    const metrics = /** @type {any} */ (memoryModule.diagnostics().metrics);
    assert.equal(metrics.regions, 1);
    assert.deepEqual(metrics.layout, ['stack 0x300000+0x10000 rw']);
    await memoryModule.dispose();
});

test('a write is charged to whoever is in flight, and the frame names the busiest', async()=>{
    const log = fakeLog();
    const bytes = new Uint8Array(0x2000);
    const memory = await open(log, {
        /** @param {number} address @param {number} length */
        readPhysical: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writePhysical: (address, data)=>bytes.set(data, address),
    });
    memory.register({ name: 'data', base: 0x1000, size: 0x1000, kind: 'thunk-data',
        access: 'rw' });

    const lock = memory.writer('LockRect');
    const outside = memory.charging(lock);
    memory.writeBytes(0x1000, new Uint8Array(300));
    memory.writeU32(0x1100, 7);
    memory.charging(outside);
    memory.writeU8(0x1200, 1);

    const table = readTable(log.metrics.describe().memory.writers);
    const charged = Object.fromEntries(table.all()
        .filter(row=>row.writes > 0)
        .map(row=>[log.words[row.name], [row.bytes, row.writes]]));
    assert.deepEqual(charged, { LockRect: [304, 2], '<no host call>': [1, 1] });

    const counters = readTable(log.metrics.describe().memory.counters).row(0);
    assert.deepEqual(Object.keys(counters), MEMORY_COUNTERS,
        'the frame fields are published before anything reads them');
    log.metrics.sample();
    const closed = readTable(log.metrics.describe().memory.counters).row(0);
    assert.equal(log.words[closed.frameWriter], 'LockRect');
    assert.equal(closed.frameWriterBytes, 304);
    await memoryModule.dispose();
});

test('an unknown name and a build with no tables charge nothing and still write', async()=>{
    const bytes = new Uint8Array(0x2000);
    const memory = await open({}, {
        /** @param {number} address @param {number} length */
        readPhysical: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writePhysical: (address, data)=>bytes.set(data, address),
    });
    memory.register({ name: 'data', base: 0x1000, size: 0x1000, kind: 'thunk-data',
        access: 'rw' });
    assert.equal(memory.writer('LockRect'), -1, 'no account, no slot');
    assert.equal(memory.charging(3), -1);
    memory.writeU32(0x1000, 0x11223344);
    assert.equal(bytes[0x1000], 0x44, 'the write still happens');
    await memoryModule.dispose();
});

test('a second instance in one realm does not take the first one\'s state', async()=>{
    const first = await open({});
    first.register({ name: 'first-only', base: 0x300000, size: 0x1000, kind: 'stack',
        access: 'rw' });

    const second = await open({});
    second.register({ name: 'second-only', base: 0x500000, size: 0x1000, kind: 'stack',
        access: 'rw' });

    assert.deepEqual(first.list().map((/** @type {any} */ region)=>region.name), ['first-only']);
    assert.equal(first.find(0x500000), undefined,
        'the first instance never saw the second one\'s region');

    await memoryModule.dispose();
});

test('a disposed memory answers harmlessly rather than throwing', async()=>{
    const bytes = new Uint8Array(0x2000);
    const memory = await open({}, {
        /** @param {number} address @param {number} length */
        readPhysical: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writePhysical: (address, data)=>bytes.set(data, address),
    });
    memory.register({ name: 'data', base: 0x1000, size: 0x1000, kind: 'thunk-data',
        access: 'rw' });

    await memoryModule.dispose();

    assert.equal(
        memory.register({ name: 'late', base: 0x2000, size: 0x10, kind: 'stack', access: 'rw' }),
        null);
    memory.protect('data', 'rwx');
    assert.equal(memory.find(0x1000), undefined);
    assert.deepEqual(memory.list(), []);
    assert.equal(memory.assert(0x1000, 4, 'read'), undefined);
    assert.equal(memory.writer('x'), -1);
    assert.equal(memory.charging(1), -1);
    assert.deepEqual(memory.readBytes(0x1000, 4), new Uint8Array(0));
    memory.writeBytes(0x1000, new Uint8Array(4));
    memory.fillBytes(0x1000, 1, 4);
    assert.deepEqual(memory.window(0x1000, 4), new Uint8Array(0));
    assert.equal(memory.readU8(0x1000), 0);
    assert.equal(memory.readU16(0x1000), 0);
    assert.equal(memory.readU32(0x1000), 0);
    memory.writeU8(0x1000, 1);
    memory.writeU16(0x1000, 1);
    memory.writeU32(0x1000, 1);
    assert.equal(memory.readCString(0x1000), '');
    assert.deepEqual(memory.scanCString(0x1000), { index: -1, byte: 0 });
    assert.equal(memory.readWideString(0x1000), '');
});

test('diagnostics answers for the live instance', async()=>{
    await open({});
    const second = await open({});
    second.register({ name: 'a', base: 0x1000, size: 0x10, kind: 'stack', access: 'rw' });
    second.register({ name: 'b', base: 0x2000, size: 0x10, kind: 'stack', access: 'rw' });

    const diag = /** @type {any} */ (memoryModule.diagnostics());
    assert.equal(diag.status, 'ready');
    assert.equal(diag.metrics.regions, 2, 'diagnostics reports the second (most recent) instance');

    await memoryModule.dispose();
});
