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
    const metrics = createMetrics();
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

test('nextRegionAfter answers the lowest region above an address, or nothing past the last one',
    async()=>{
        const memory = await open({});
        memory.register({ name: 'a', base: 0x1000, size: 0x1000, kind: 'stack', access: 'rw' });
        memory.register({ name: 'c', base: 0x5000, size: 0x1000, kind: 'stack', access: 'rw' });
        memory.register({ name: 'b', base: 0x3000, size: 0x1000, kind: 'stack', access: 'rw' });

        assert.equal(memory.nextRegionAfter(0)?.base, 0x1000,
            'the lowest region, from before anything is mapped');
        assert.equal(memory.nextRegionAfter(0x1000)?.base, 0x3000,
            'the next one above a region\'s own base, not itself');
        assert.equal(memory.nextRegionAfter(0x4000)?.base, 0x5000,
            'the nearer of two candidates above, regardless of registration order');
        assert.equal(memory.nextRegionAfter(0x5fff), undefined,
            'nothing maps above the last region');

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
    assert.equal(memory.nextRegionAfter(0), undefined);
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
    assert.equal(memory.scanWideString(0x1000), -1);
});

test('readU32sInto and readF32sInto read a whole span in one call, through the module\'s api',
    async()=>{
        const bytes = new Uint8Array(0x2000);
        const view = new DataView(bytes.buffer);
        const memory = await open({}, {
            /** @param {number} address @param {number} length */
            readPhysical: (address, length)=>bytes.slice(address, address + length),
            /** @param {number} address @param {Uint8Array} data */
            writePhysical: (address, data)=>bytes.set(data, address),
            /** @param {number} address */
            readU32: address=>view.getUint32(address, true),
            /** @param {number} address */
            readF32: address=>view.getFloat32(address, true),
        });
        memory.register({ name: 'data', base: 0x1000, size: 0x1000, kind: 'thunk-data',
            access: 'rw' });

        view.setUint32(0x1000, 10, true);
        view.setUint32(0x1004, 20, true);
        /** @type {number[]} */
        const words = new Array(2);
        memory.readU32sInto(0x1000, 2, words);
        assert.deepEqual(words, [10, 20]);

        view.setFloat32(0x1008, 1.5, true);
        /** @type {number[]} */
        const floats = new Array(1);
        memory.readF32sInto(0x1008, 1, floats);
        assert.deepEqual(floats, [1.5]);

        await memoryModule.dispose();
    });

test('readU32sInto and readF32sInto answer harmlessly once disposed', async()=>{
    const memory = await open({});
    memory.register({ name: 'data', base: 0x1000, size: 0x10, kind: 'stack', access: 'rw' });
    await memoryModule.dispose();

    /** @type {number[]} */
    const words = [1, 1];
    memory.readU32sInto(0x1000, 2, words);
    assert.deepEqual(words, [0, 0]);

    /** @type {number[]} */
    const floats = [1];
    memory.readF32sInto(0x1000, 1, floats);
    assert.deepEqual(floats, [0]);
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

test('the reader and the charge slot are lent while the instance is open', async()=>{
    // What the bridge takes on every host call: the checked dword reads out
    // of the machine's RAM, and the cell a call's writes are charged by.
    const log = fakeLog();
    const bytes = new Uint8Array(0x2000);
    const view = new DataView(bytes.buffer);
    const memory = await open(log, {
        /** @param {number} address @param {number} length */
        readPhysical: (address, length)=>bytes.slice(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writePhysical: (address, data)=>bytes.set(data, address),
        /** @param {number} address */
        readU32: address=>view.getUint32(address, true),
        ramView: ()=>bytes,
    });
    memory.register({ name: 'data', base: 0x1000, size: 0x1000, kind: 'thunk-data',
        access: 'rw' });
    view.setUint32(0x1010, 0x12345678, true);
    assert.equal(memory.reader().readU32(0x1010), 0x12345678);
    assert.equal(memory.readU32(0x1010), 0x12345678, 'the api reads through the same');
    assert.throws(()=>memory.reader().readU32(0x3000), /Unmapped read/);

    const slot = memory.chargeSlot();
    const lock = memory.writer('LockRect');
    const was = slot[0];
    slot[0] = lock;
    memory.writeBytes(0x1000, new Uint8Array(8));
    slot[0] = was;
    const table = readTable(log.metrics.describe().memory.writers);
    const charged = Object.fromEntries(table.all()
        .filter(row=>row.writes > 0)
        .map(row=>[log.words[row.name], [row.bytes, row.writes]]));
    assert.deepEqual(charged, { LockRect: [8, 1] });

    await memoryModule.dispose();
    assert.equal(memory.reader(), null);
    assert.equal(memory.chargeSlot(), null);
});

/**
 * A machine whose RAM is sparse pages anywhere below 2^53, as a wide window's
 * is past 4 GiB, and a small shared RAM whose view the fast paths take.
 */
function wideMachine(){
    /** @type {Map<number, Uint8Array>} */
    const pages = new Map();
    const page = (/** @type {number} */ at)=>{
        const key = Math.floor(at / 4096);
        let bytes = pages.get(key);
        if (!bytes)
        {
            bytes = new Uint8Array(4096);
            pages.set(key, bytes);
        }
        return bytes;
    };
    const ram = new Uint8Array(new SharedArrayBuffer(0x4000));
    return {
        ram,
        cpu: {
            /** @param {number} address @param {number} length */
            readPhysical: (address, length)=>Uint8Array.from({ length },
                (_, i)=>(address + i < ram.length ? ram[address + i]
                    : page(address + i)[(address + i) % 4096])),
            /** @param {number} address @param {Uint8Array} data */
            writePhysical: (address, data)=>data.forEach((byte, i)=>{
                if (address + i < ram.length)
                {
                    ram[address + i] = byte;
                    return;
                }
                page(address + i)[(address + i) % 4096] = byte;
            }),
            /** @param {number} address */
            readU32: address=>new DataView(Uint8Array.from({ length: 4 },
                (_, i)=>(address + i < ram.length ? ram[address + i]
                    : page(address + i)[(address + i) % 4096])).buffer).getUint32(0, true),
            ramView: ()=>ram,
        },
    };
}

test('a pointer is read and written whole, past 4 GiB too, its upper half never kept', async()=>{
    const machine = wideMachine();
    const memory = await open({}, machine.cpu);
    const high = 2 ** 32 + 0x10000;
    memory.register({ name: 'low', base: 0x1000, size: 0x1000, kind: 'thunk-data', access: 'rw' });
    memory.register({ name: 'high', base: high, size: 0x1000, kind: 'thunk-data', access: 'rw' });
    for (const at of [0x1000, high])
    {
        memory.writeU32(at + 4, 0xdeadbeef);
        memory.writePointer(at, 0x1_2345_6788, 8);
        assert.equal(memory.readPointer(at, 8), 0x1_2345_6788, `whole at ${at.toString(16)}`);
        assert.equal(memory.readU32(at + 4), 1, 'the upper dword is the value\'s');
        memory.writePointer(at, 0x40_0000, 8);
        assert.equal(memory.readU32(at + 4), 0, 'below 4 GiB the upper dword is zero, written');
        memory.writePointer(at + 8, -0x1000, 4);
        assert.equal(memory.readPointer(at + 8, 4), 0xfffff000, 'a signed dword names its address');
        memory.writeU32(at + 16, 0xcafe);
        memory.writePointer(at + 12, 0x5555, 4);
        assert.equal(memory.readU32(at + 16), 0xcafe, 'four bytes in a 32-bit process, no more');
    }
    assert.throws(()=>memory.writePointer(0x1000, 1, /** @type {any} */ (6)), /4 or 8 bytes/);
    await memoryModule.dispose();
});

test('a word past 4 GiB is never taken from the shared word `>>>` wraps it onto', async()=>{
    const machine = wideMachine();
    const memory = await open({}, machine.cpu);
    const high = 2 ** 32 + 0x10;
    memory.register({ name: 'low', base: 0, size: 0x4000, kind: 'thunk-data', access: 'rw' });
    memory.register({ name: 'high', base: 2 ** 32, size: 0x1000, kind: 'thunk-data',
        access: 'rw' });
    memory.writeU32(0x10, 0x11111111);
    memory.writeU32(high, 0x22222222);
    assert.equal(memory.wordsOver(high, 4), null, 'no view over the RAM reaches it');
    // Twice: the second read finds the span validated and takes the fast path.
    assert.equal(memory.readU32(high), 0x22222222);
    assert.equal(memory.readU32(high), 0x22222222, 'the fast path keeps the whole address');
    assert.equal(memory.loadU32(high), 0x22222222);
    assert.equal(memory.compareExchangeU32(high, 0x22222222, 0x33333333), 0x22222222);
    assert.equal(memory.readU32(high), 0x33333333);
    assert.equal(memory.readU32(0x10), 0x11111111, 'the low word it aliases is untouched');
    assert.equal(memory.compareExchangeU64(high, 0x33333333n, 0x44n), 0x33333333n);
    assert.equal(memory.readU32(0x10), 0x11111111);
    assert.equal(memory.readU32(high), 0x44);
    await memoryModule.dispose();
});

test('a swap or a worker\'s write taken as the host\'s is not written again:'
    + ' another thread\'s store between stays', async()=>{
    // The words the guest and the host both swap (an event's, a mutex's) live
    // in memory the program may execute, where a write is told to the
    // translator. The swap's bytes are in the RAM already; were they read and
    // written back to tell it, a guest's swap on another executor between
    // the two was undone - a SetEvent lost, two threads each waiting on the
    // other's event for ever. Here the other thread stores between any read
    // of the word and the end of the call.
    const ram = new Uint8Array(new SharedArrayBuffer(0x4000));
    const words = new Int32Array(ram.buffer);
    /** @type {(() => void) | null} */
    let between = null;
    /** @type {[number, number][]} */
    const told = [];
    const memory = await open({}, {
        /** @param {number} address @param {number} length */
        readPhysical: (address, length)=>{
            const bytes = ram.slice(address, address + length);
            between?.();
            between = null;
            return bytes;
        },
        /** @param {number} address @param {Uint8Array} data */
        writePhysical: (address, data)=>ram.set(data, address),
        /** @param {number} address */
        readU32: address=>Atomics.load(words, address / 4) >>> 0,
        /** @param {number} address @param {number} length */
        wrote: (address, length)=>told.push([address, length]),
        ramView: ()=>ram,
    });
    memory.register({ name: 'heap', base: 0x1000, size: 0x3000, kind: 'heap', access: 'rwx' });
    const cases = [
        ['a dword swap', 0x1000, ()=>memory.compareExchangeU32(0x1000, 0, 0x82), 4],
        ['a quadword swap', 0x1010, ()=>memory.compareExchangeU64(0x1010, 0n, 0x82n), 8],
        ['a worker\'s write', 0x1020, ()=>{
            Atomics.store(words, 0x1020 / 4, 0x82);
            memory.adopt(0x1020, 4);
        }, 4],
    ];
    for (const [name, at, call, length]
        of /** @type {[string, number, () => void, number][]} */ (cases))
    {
        told.length = 0;
        // Another executor's guest sets the word right after the call's own change.
        let stored = false;
        between = ()=>{
            Atomics.store(words, at / 4, 3);
            stored = true;
        };
        call();
        if (!stored)
        {
            Atomics.store(words, at / 4, 3);
        }
        between = null;
        assert.equal(Atomics.load(words, at / 4), 3, `${name}: the other thread's store stays`);
        assert.deepEqual(told, [[at, length]], `${name}: the translator is told of the write`);
    }
    await memoryModule.dispose();
});
