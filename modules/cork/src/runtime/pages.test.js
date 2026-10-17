/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tables, ownLayout, pagesFor, tablesSize } from './layout.js';
import { PageFlag, createPageTable } from './pages.js';

function machine(){
    const layout = ownLayout({ ramSize: 1 << 20, hashSlots: 1 << 16 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, tablesSize(layout)) });
    return { layout, memory, pages: createPageTable(memory, layout) };
}

test('a range marks exactly the pages it touches', ()=>{
    const { pages } = machine();
    pages.markRange(0x40000000, 0x1000, PageFlag.INACCESSIBLE);
    assert.equal(pages.get(0x40000), PageFlag.INACCESSIBLE);
    assert.equal(pages.get(0x3ffff), PageFlag.INACCESSIBLE, 'beyond RAM already');
    assert.equal(pages.get(0x40001), PageFlag.INACCESSIBLE, 'beyond RAM already');
    pages.markRange(0x2ffe, 4, PageFlag.HAS_CODE);
    assert.equal(pages.get(2), PageFlag.HAS_CODE, 'the first byte\'s page');
    assert.equal(pages.get(3), PageFlag.HAS_CODE, 'the last byte\'s page');
    assert.equal(pages.get(1), 0);
    assert.equal(pages.get(4), 0);
});

test('pages beyond RAM are inaccessible from the start, pages in RAM are not', ()=>{
    const { pages } = machine();
    assert.equal(pages.get(0), 0, 'the null page is not marked');
    assert.equal(pages.get(0xff), 0);
    assert.equal(pages.get(0x100), PageFlag.INACCESSIBLE, 'the first page past 1 MiB');
    assert.equal(pages.get(0xfffff), PageFlag.INACCESSIBLE, 'the last page of the space');
});

test('clearing a partial page clears the whole page: the granularity is the page', ()=>{
    const { pages } = machine();
    pages.markRange(0x5000, 0x2000, PageFlag.HAS_CODE | PageFlag.VOLATILE);
    pages.clearRange(0x5800, 0x10, PageFlag.HAS_CODE);
    assert.equal(pages.get(5), PageFlag.VOLATILE, 'HAS_CODE cleared for the whole page');
    assert.equal(pages.get(6), PageFlag.HAS_CODE | PageFlag.VOLATILE);
    pages.clear(6, PageFlag.VOLATILE);
    pages.set(7, PageFlag.HAS_CODE);
    assert.equal(pages.get(6), PageFlag.HAS_CODE);
    assert.equal(pages.get(7), PageFlag.HAS_CODE);
});

test('the table survives a grow of the memory', ()=>{
    const { pages, memory } = machine();
    pages.set(3, PageFlag.HAS_CODE);
    memory.grow(1);
    assert.equal(pages.get(3), PageFlag.HAS_CODE);
    assert.equal(pages.get(0x100), PageFlag.INACCESSIBLE);
});

test('code marked on a page keeps a range of granules; data beside it is outside', ()=>{
    const layout = ownLayout({ ramSize: 1 << 20, hashSlots: 1 << 16 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, tablesSize(layout)) });
    const pages = createPageTable(memory, layout);
    pages.markCode(0x1040, 0x30);                       // granules 2..3 of page 1
    assert.equal(pages.get(1) & PageFlag.HAS_CODE, PageFlag.HAS_CODE);
    assert.deepEqual(pages.codeRange(1), [2, 4]);
    pages.markCode(0x1000, 8);                          // widens down to granule 0
    assert.deepEqual(pages.codeRange(1), [0, 4]);
    pages.markCode(0x1ff0, 0x20);                       // across into page 2
    assert.deepEqual(pages.codeRange(1), [0, 128]);
    assert.deepEqual(pages.codeRange(2), [0, 1]);
    pages.clearCode(1);
    assert.equal(pages.get(1) & PageFlag.HAS_CODE, 0);
    assert.deepEqual(pages.codeRange(1), [0, 0]);
    assert.deepEqual(pages.codeRange(2), [0, 1], 'the other page keeps its range');
});

test('the table reads and writes the same bytes after the memory grows', ()=>{
    const { layout, memory, pages } = machine();
    pages.markCode(0x41000, 16);
    const before = memory.buffer;
    memory.grow(1);
    assert.equal(before.byteLength, 0, 'growing detached the buffer the views were over');
    assert.equal(pages.get(0x41), PageFlag.HAS_CODE);
    assert.deepEqual(pages.codeRange(0x41), [0, 1]);
    pages.set(0x42, PageFlag.VOLATILE);
    const raw = new Uint8Array(memory.buffer, layout.tables + Tables.PAGE_FLAGS,
        Tables.PAGE_FLAGS_SIZE);
    assert.equal(raw[0x42], PageFlag.VOLATILE, 'the write reached the grown memory');
    new DataView(memory.buffer).setUint32(layout.tables + Tables.STALE_LOW, ~0x41008, true);
    new DataView(memory.buffer).setUint32(layout.tables + Tables.STALE_END, 0x4100c, true);
    assert.equal(pages.staleAddress(), 0x41008);
    assert.equal(pages.staleSize(), 4);
    pages.clearStale();
    assert.equal(pages.staleSize(), 0, 'nothing once looked at');
});

test('two threads changing one page at once lose neither\'s flag nor its granules', async()=>{
    const { Worker } = await import('node:worker_threads');
    const layout = ownLayout({ ramSize: 1 << 20, hashSlots: 1 << 16 });
    const size = pagesFor(layout, tablesSize(layout));
    const memory = new WebAssembly.Memory({ initial: size, maximum: size, shared: true });
    const pages = createPageTable(memory, layout);
    const PAGE = 0x40;
    const MS = 300;
    // Both start together (the word) and go on for the same time: each sets a
    // flag of its own on the page and clears it again, the other thread doing
    // the same with another flag, and one that finds its flag gone right after
    // setting it lost it to the other's write. Each widens one end of the
    // page's code range as it goes.
    const start = new Int32Array(new SharedArrayBuffer(8));
    const other = new Worker(`
        const { workerData, parentPort } = require('node:worker_threads');
        import(workerData.pages).then(({ PageFlag, createPageTable })=>{
            const pages = createPageTable(workerData.memory, workerData.layout);
            Atomics.store(workerData.start, 0, 1);
            Atomics.notify(workerData.start, 0);
            Atomics.wait(workerData.start, 1, 0);
            let lost = 0;
            const until = performance.now() + workerData.ms;
            for (let turn = 0; performance.now() < until; turn++)
            {
                pages.set(workerData.page, PageFlag.VOLATILE);
                lost += (pages.get(workerData.page) & PageFlag.VOLATILE) === 0 ? 1 : 0;
                pages.clear(workerData.page, PageFlag.VOLATILE);
                pages.markCode(workerData.page * 4096 + 0xf00 - (turn & 0x7f), 1);
            }
            parentPort.postMessage(lost);
        });
    `, { eval: true, workerData: { pages: new URL('./pages.js', import.meta.url).href, memory,
        layout, ms: MS, page: PAGE, start } });
    const done = new Promise(resolve=>other.once('message', resolve));
    while (Atomics.load(start, 0) === 0)
    {
        await new Promise(resolve=>setTimeout(resolve, 1));
    }
    Atomics.store(start, 1, 1);
    Atomics.notify(start, 1);
    let lost = 0;
    const until = performance.now() + MS;
    for (let turn = 0; performance.now() < until; turn++)
    {
        pages.set(PAGE, PageFlag.CLOSED);
        lost += (pages.get(PAGE) & PageFlag.CLOSED) === 0 ? 1 : 0;
        pages.clear(PAGE, PageFlag.CLOSED);
        pages.markCode(PAGE * 4096 + 0x100 + (turn & 0x7f), 1);
    }
    const lostThere = await done;
    await other.terminate();
    assert.equal(lost, 0, 'this thread\'s flag');
    assert.equal(lostThere, 0, 'the other\'s');
    assert.equal(pages.get(PAGE) & PageFlag.HAS_CODE, PageFlag.HAS_CODE);
    // Granules of 32 bytes: 0x100 is the 9th, 0xf00 the 121st.
    assert.deepEqual(pages.codeRange(PAGE), [0x100 >>> 5, (0xf00 >>> 5) + 1]);
});
