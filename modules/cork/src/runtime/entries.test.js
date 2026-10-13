/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEntries, slotOf } from './entries.js';
import { Tables } from './layout.js';

const fn = ()=>0;

test('an entry is found by its address and answers its function and label', ()=>{
    const entries = createEntries();
    const a = entries.add(0x1000, fn, 0);
    const b = entries.add(0x1010, fn, 1);
    assert.notEqual(a, b);
    assert.equal(entries.entryOf(0x1000), a);
    assert.equal(entries.entryOf(0x1010), b);
    assert.equal(entries.entryOf(0x1004), -1);
    assert.deepEqual(entries.at(b),
        { eip: 0x1010, fn, label: 1, page: 1, top: 8, table: -1, slot: -1, empty: 0 });
    assert.equal(entries.count(), 2);
    assert.equal(entries.add(0x1000, ()=>1, 5), a, 'an address already mapped keeps its entry');
    assert.equal(entries.at(a).label, 0);
});

test('removing a page drops every entry in it and no other', ()=>{
    const entries = createEntries();
    const a = entries.add(0x1000, fn, 0);
    entries.add(0x1ffc, fn, 1);
    const c = entries.add(0x2000, fn, 0);
    assert.equal(entries.removePage(1), 2);
    assert.equal(entries.entryOf(0x1000), -1);
    assert.equal(entries.entryOf(0x1ffc), -1);
    assert.equal(entries.entryOf(0x2000), c);
    assert.equal(entries.count(), 1);
    assert.throws(()=>entries.at(a), /not live/);
    assert.equal(entries.removePage(1), 0, 'nothing left there');
    entries.remove(c);
    assert.equal(entries.count(), 0);
    entries.remove(c);
    assert.equal(entries.count(), 0, 'removing twice changes nothing');
});

test('an entry compiled for an x87 top is found at that top, or under any top', ()=>{
    const entries = createEntries();
    const any = entries.add(0x1000, fn, 0);
    const seven = entries.add(0x2000, fn, 0, 7);
    assert.equal(entries.entryOf(0x1000, 3), any, 'indifferent to the top');
    assert.equal(entries.entryOf(0x2000, 7), seven);
    assert.equal(entries.entryOf(0x2000, 0), -1, 'compiled for another top');
    assert.equal(entries.isSpecialised(0x2000), true);
    assert.equal(entries.isSpecialised(0x1000), false);
    const zero = entries.add(0x2000, fn, 1, 0);
    assert.notEqual(zero, seven);
    assert.equal(entries.entryOf(0x2000, 0), zero);
    entries.remove(seven);
    assert.equal(entries.entryOf(0x2000, 7), -1);
    assert.equal(entries.entryOf(0x2000, 0), zero);
});

test('an entry just found is found again, and an add or a removal there is seen', ()=>{
    // The interpreter stops where it finds an entry and the host asks for the
    // same one next: the second answer is kept, and has to change with the map.
    const entries = createEntries();
    const any = entries.add(0x3000, fn, 0);
    assert.equal(entries.entryOf(0x3000, 5), any);
    assert.equal(entries.entryOf(0x3000, 5), any, 'asked again at once');
    const five = entries.add(0x3000, fn, 1, 5);
    assert.equal(entries.entryOf(0x3000, 5), five, 'one for the top alone comes first');
    assert.equal(entries.entryOf(0x3000, 4), any, 'another top still has the one for any');
    entries.remove(five);
    assert.equal(entries.entryOf(0x3000, 5), any);
    entries.removePage(3);
    assert.equal(entries.entryOf(0x3000, 5), -1, 'nor one kept past its page');
    assert.equal(entries.entryOf(0x3000, 4), -1);
});

/** A memory with room for the hash at its start. */
function hashed(){
    const memory = new WebAssembly.Memory({
        initial: Math.ceil(Tables.HASH_SLOTS * Tables.HASH_SLOT / 65536) + 1,
    });
    const hashBase = 16;
    const entries = createEntries({ memory, hashBase });
    const view = ()=>new DataView(memory.buffer);
    /** The slot translated code would find for an address, by its own probe. */
    const probe = (/** @type {number} */ eip)=>{
        let slot = slotOf(eip);
        for (let n = 1; ; n++)
        {
            const at = hashBase + slot * Tables.HASH_SLOT;
            const key = view().getUint32(at, true);
            if (key === eip)
            {
                return {
                    n, table: view().getUint32(at + 4, true), label: view().getUint16(at + 8, true),
                    top: view().getUint8(at + 10),
                };
            }
            if (key === 0)
            {
                return null;
            }
            slot = (slot + 1) & (Tables.HASH_SLOTS - 1);
        }
    };
    return { entries, probe };
}

test('add writes the slot the emitter\'s formula reads; remove leaves a tombstone', ()=>{
    const { entries, probe } = hashed();
    const a = entries.add(0x401000, fn, 3, 8, 17);
    assert.deepEqual(probe(0x401000), { n: 1, table: 17, label: 3, top: 8 });
    assert.equal(entries.hashed(), 1);
    entries.add(0x402000, fn, 0, 5, 18);
    assert.deepEqual(probe(0x402000), { n: 1, table: 18, label: 0, top: 5 });
    assert.equal(entries.add(0x403000, fn, 0), entries.entryOf(0x403000),
        'an entry without a table index is in the map alone');
    assert.equal(probe(0x403000), null);
    assert.equal(entries.hashed(), 2);
    entries.remove(a);
    assert.equal(probe(0x401000), null);
    assert.equal(entries.hashed(), 1);
    assert.deepEqual(probe(0x402000), { n: 1, table: 18, label: 0, top: 5 }, 'the other stays');
});

test('forty thousand entries are all found, and a removed one is not', ()=>{
    const { entries, probe } = hashed();
    /** @type {number[]} */
    const eips = [];
    let seed = 12345;
    while (eips.length < 40000)
    {
        seed = Math.imul(seed, 1103515245) + 12345 >>> 0;
        // Code addresses cluster: mostly near one another, some far apart.
        const eip = 0x400000 + (seed % 4 === 0 ? seed >>> 8 : (seed >>> 20) * 3);
        if (!eips.includes(eip) || eips.length > 100)
        {
            eips.push(eip);
        }
    }
    const unique = [...new Set(eips)];
    const indices = unique.map((eip, i)=>entries.add(eip, fn, i & 63, 8, i));
    assert.equal(entries.hashed(), unique.length);
    let longest = 0;
    unique.forEach((eip, i)=>{
        const found = probe(eip);
        assert.ok(found, `0x${eip.toString(16)} is found`);
        assert.equal(found.table, i);
        longest = Math.max(longest, found.n);
    });
    assert.ok(longest < 256, `the longest probe is ${longest}`);
    // Removing a third leaves the rest found, through the rebuild.
    for (let i = 0; i < unique.length; i += 3)
    {
        entries.remove(indices[i]);
    }
    unique.forEach((eip, i)=>{
        const found = probe(eip);
        if (i % 3 === 0)
        {
            assert.equal(found, null);
        }
        else
        {
            assert.equal(found?.table, i);
        }
    });
    assert.equal(entries.hashed(), unique.length - Math.ceil(unique.length / 3));
});

test('a title\'s hundred thousand entries spread over the whole hash, with no long runs', ()=>{
    // The slot is the product's top bits: with 16 of them the slots began in the first
    // quarter of the hash only, and a title's hundred thousand entries packed it into one
    // run that every miss scanned to its end (tens of thousands of probes a transfer).
    const memory = new WebAssembly.Memory({
        initial: Math.ceil(Tables.HASH_SLOTS * Tables.HASH_SLOT / 65536) + 1,
    });
    const entries = createEntries({ memory, hashBase: 0,
        shift: 32 - Math.log2(Tables.HASH_SLOTS) });
    for (let i = 0; i < 100_000; i++)
    {
        // Block starts of a real image: 0x401000 on, a few bytes apart.
        entries.add(0x401000 + i * 7, ()=>0, 0, 0, 0);
    }
    const view = new DataView(memory.buffer);
    let run = 0;
    let longest = 0;
    let last = 0;
    for (let slot = 0; slot < Tables.HASH_SLOTS; slot++)
    {
        if (view.getUint32(slot * Tables.HASH_SLOT, true) !== 0)
        {
            run++;
            last = slot;
            longest = Math.max(longest, run);
        }
        else
        {
            run = 0;
        }
    }
    assert.ok(last > Tables.HASH_SLOTS * 0.9, `the last slot used is ${last}`);
    assert.ok(longest < 100, `the longest run of used slots is ${longest}`);
});

test('retable moves an entry to another function-table index, in the map and in the hash',
    ()=>{
        const memory = new WebAssembly.Memory({
            initial: Math.ceil(Tables.HASH_SLOTS * Tables.HASH_SLOT / 65536) + 1,
        });
        const entries = createEntries({ memory, hashBase: 0,
            shift: 32 - Math.log2(Tables.HASH_SLOTS) });
        const before = ()=>1;
        const after = ()=>2;
        const index = entries.add(0x401000, before, 3, 8, 17);
        entries.retable(index, after, 512);
        const entry = entries.at(index);
        assert.equal(entry.fn, after);
        assert.equal(entry.table, 512);
        assert.equal(entry.label, 3, 'the label stands');
        const at = entry.slot * Tables.HASH_SLOT;
        const view = new DataView(memory.buffer);
        assert.equal(view.getUint32(at, true), 0x401000);
        assert.equal(view.getUint32(at + 4, true), 512, 'the slot names the new index');
        assert.equal(view.getUint16(at + 8, true), 3);
    });
