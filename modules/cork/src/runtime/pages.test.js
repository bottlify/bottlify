/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tables, ownLayout, pagesFor } from './layout.js';
import { PageFlag, createPageTable } from './pages.js';

function machine(){
    const layout = ownLayout({ ramSize: 1 << 20 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
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
    const layout = ownLayout({ ramSize: 1 << 20 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
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
