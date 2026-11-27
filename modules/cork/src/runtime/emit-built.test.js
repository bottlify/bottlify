/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formRegion } from '../region.js';
import { createEmitCache, emitBatch, relinkBatch } from './emit-built.js';
import { ownLayout } from './layout.js';

const FEATURES = { simd: true, tailCalls: true, defaultNaNNegative: false };
const OPTIONS = { hash: true, place: true, trapPort: 0xb077, profileCalls: true };
const FORM = { maxBlocks: 128, maxBytes: 8192, leafCalls: true };
const BASE = 0x401000;
const layout = ownLayout({ ramSize: 16 << 20, hashSlots: 1 << 16 });

/**
 * A relink of the regions at a benchmark program's first block starts, over a
 * copy of its pages, as the runtime posts one.
 *
 * @param {string} name @param {number} count
 */
function relinkOf(name, count){
    const image = readFileSync(new URL(`../../bench/micro/images/${name}.bin`,
        import.meta.url));
    /** @type {Map<number, Uint8Array>} */
    const pages = new Map();
    for (let at = 0; at < image.length; at += 4096)
    {
        const page = new Uint8Array(4096);
        page.set(image.subarray(at, at + 4096));
        pages.set((BASE + at) >>> 12, page);
    }
    const read = (/** @type {number} */ address)=>image[address - BASE] ?? 0;
    const translatable = (/** @type {number} */ address)=>pages.has(address >>> 12);
    // The program's regions as a run meets them: its entry, then wherever
    // their blocks lead, the calls' callees and returns among them.
    /** @type {{ entry: number, entryTop: number, hash: string }[]} */
    const jobs = [];
    const queue = [BASE];
    const seen = new Set(queue);
    while (queue.length > 0 && jobs.length < count)
    {
        const entry = /** @type {number} */ (queue.shift());
        const region = formRegion(read, entry, { ...FORM, translatable });
        jobs.push({ entry, entryTop: 0, hash: region.hash });
        for (const block of region.blocks)
        {
            for (const target of [...block.exit.targets, block.exit.next])
            {
                if (!seen.has(target) && translatable(target))
                {
                    seen.add(target);
                    queue.push(target);
                }
            }
        }
    }
    return { jobs, pages: [...pages], form: FORM };
}

test('a relink takes the functions a batch emitted before, the same bytes as emitting'
    + ' them again', ()=>{
    const relink = relinkOf('load-x87', 24);
    const fresh = relinkBatch(relink, layout, FEATURES, OPTIONS);
    const cache = createEmitCache();
    const first = relinkBatch(relink, layout, FEATURES, OPTIONS, cache);
    assert.equal(cache.hits, 0);
    assert.deepEqual(first.module, fresh.module);
    // The same regions again, in another order and fewer of them: every one a hit.
    const again = { ...relink, jobs: [...relink.jobs].reverse().slice(0, 20) };
    const kept = relinkBatch(again, layout, FEATURES, OPTIONS, cache);
    assert.equal(cache.hits, 20);
    const emitted = relinkBatch(again, layout, FEATURES, OPTIONS);
    assert.deepEqual(kept.module, emitted.module);
    assert.deepEqual(kept.results, emitted.results);
    // Emitted for other options, the function is another one.
    const wide = relinkBatch(again, layout, FEATURES, { ...OPTIONS, wide: true }, cache);
    assert.equal(cache.hits, 20);
    assert.deepEqual(wide.module,
        relinkBatch(again, layout, FEATURES, { ...OPTIONS, wide: true }).module);
});

test('a job that asks the emitter for anything else takes no other job\'s function', ()=>{
    const relink = relinkOf('game-x87', 6);
    const cache = createEmitCache();
    relinkBatch(relink, layout, FEATURES, OPTIONS, cache);
    const checked = { ...relink, jobs: relink.jobs.map(job=>({ ...job, checked: true })) };
    const kept = relinkBatch(checked, layout, FEATURES, OPTIONS, cache);
    assert.equal(cache.hits, 0);
    assert.deepEqual(kept.module, relinkBatch(checked, layout, FEATURES, OPTIONS).module);
    relinkBatch(checked, layout, FEATURES, OPTIONS, cache);
    assert.equal(cache.hits, relink.jobs.length);
});

test('a region whose bytes changed is formed again and answered changed, whatever the'
    + ' cache holds', ()=>{
    const relink = relinkOf('crc-x87', 4);
    const cache = createEmitCache();
    relinkBatch(relink, layout, FEATURES, OPTIONS, cache);
    const pages = relink.pages.map(([page, bytes])=>
        /** @type {[number, Uint8Array]} */ ([page, bytes.slice()]));
    const [, first] = /** @type {[number, Uint8Array]} */ (pages[0]);
    // The entry's own first instruction, rewritten as a `nop`.
    first[BASE & 0xfff] = 0x90;
    const changed = relinkBatch({ ...relink, pages }, layout, FEATURES, OPTIONS, cache);
    assert.deepEqual(changed.results[0], { ok: false, message: 'changed' });
});

test('the cache keeps the functions used last, within its size', ()=>{
    const relink = relinkOf('load-x87', 40);
    const whole = createEmitCache();
    relinkBatch(relink, layout, FEATURES, OPTIONS, whole);
    assert.equal(whole.kept.size, relink.jobs.length);
    const cache = createEmitCache(whole.bytes >> 2);
    relinkBatch(relink, layout, FEATURES, OPTIONS, cache);
    assert.ok(cache.bytes <= cache.limit, `${cache.bytes} kept`);
    assert.ok(cache.kept.size < relink.jobs.length, `${cache.kept.size} kept`);
    // The last one emitted is still there, the first is not.
    relinkBatch({ ...relink, jobs: relink.jobs.slice(-1) }, layout, FEATURES, OPTIONS, cache);
    assert.equal(cache.hits, 1);
    relinkBatch({ ...relink, jobs: relink.jobs.slice(0, 1) }, layout, FEATURES, OPTIONS, cache);
    assert.equal(cache.hits, 1);
});

test('a batch of formed regions and a relink of the same share what was emitted', ()=>{
    const relink = relinkOf('game-x87', 6);
    const byPage = new Map(relink.pages);
    const read = (/** @type {number} */ address)=>byPage.get(address >>> 12)?.[address & 0xfff]
        ?? 0;
    const translatable = (/** @type {number} */ address)=>byPage.has(address >>> 12);
    const cache = createEmitCache();
    const jobs = relink.jobs.map(({ entry })=>({
        region: formRegion(read, entry, { ...FORM, translatable }), entryTop: 0,
    }));
    emitBatch(jobs, layout, FEATURES, OPTIONS, cache);
    const relinked = relinkBatch(relink, layout, FEATURES, OPTIONS, cache);
    assert.equal(cache.hits, jobs.length);
    assert.deepEqual(relinked.module, relinkBatch(relink, layout, FEATURES, OPTIONS).module);
});

test('a region formed through an import slot is formed the same on the worker', ()=>{
    // call dword [slot]; ret -- the slot, on a data page of its own, holds a leaf that
    // the call is formed into (mov eax, 1; ret). The worker forms from copies of the pages
    // read: the slot's page must be among them, or its read answers 0 there, nothing is
    // predicted and the region hashes apart ('changed'). A write to it drops nothing.
    const code = BASE;
    const slot = BASE + 0x2000;
    const leaf = BASE + 0x3000;
    /** @type {Map<number, Uint8Array>} */
    const memory = new Map([code, slot, leaf].map(at=>[at >>> 12, new Uint8Array(4096)]));
    const put = (/** @type {number} */ at, /** @type {number[]} */ bytes)=>
        /** @type {Uint8Array} */ (memory.get(at >>> 12)).set(bytes, at & 0xfff);
    put(code, [0xff, 0x15, ...new Uint8Array(Uint32Array.of(slot).buffer), 0xc3]);
    put(slot, [...new Uint8Array(Uint32Array.of(leaf).buffer)]);
    put(leaf, [0xb8, 1, 0, 0, 0, 0xc3]);
    const read = (/** @type {number} */ address)=>memory.get(address >>> 12)?.[address & 0xfff]
        ?? 0;
    const region = formRegion(read, code, { ...FORM, translatable: ()=>true });
    assert.ok(region.blocks.some(block=>block.start === leaf), 'the leaf is formed in');
    assert.ok(region.reads?.has(slot >>> 12), 'the slot\'s page is among the pages read');
    assert.ok(!region.pages.has(slot >>> 12), 'and not among those a write to drops it');
    const pages = [...(region.reads ?? [])].map(page=>/** @type {[number, Uint8Array]} */ (
        [page, /** @type {Uint8Array} */ (memory.get(page)).slice()]));
    const built = relinkBatch({ jobs: [{ entry: code, entryTop: 0, hash: region.hash }], pages,
        formable: [...region.pages], form: FORM }, layout, FEATURES, OPTIONS);
    assert.equal(built.results[0].ok, true, JSON.stringify(built.results[0]));
});

test('every region is formed the same on the worker from its own pages alone', ()=>{
    // The runtime sends the worker copies of the pages forming read and the regions' own
    // pages to form over: from them alone the worker forms every region as it was formed.
    for (const name of ['load-x87', 'game-x87', 'crc-x87'])
    {
        const relink = relinkOf(name, 40);
        const all = new Map(relink.pages);
        const read = (/** @type {number} */ address)=>all.get(address >>> 12)?.[address & 0xfff]
            ?? 0;
        for (const job of relink.jobs)
        {
            const region = formRegion(read, job.entry, { ...FORM,
                translatable: address=>all.has(address >>> 12) });
            const own = [...(region.reads ?? [])].filter(page=>all.has(page)).map(page=>
                /** @type {[number, Uint8Array]} */ ([page, /** @type {Uint8Array} */ (
                    all.get(page))]));
            const built = relinkBatch({ jobs: [job], pages: own, formable: [...region.pages],
                form: FORM }, layout, FEATURES, OPTIONS);
            assert.equal(built.results[0].ok, true, `${name} at ${job.entry.toString(16)}`);
        }
    }
});

test('a region formed again on a worker is the region the runtime formed, wherever forming'
    + ' looked', ()=>{
    // 0x401000: call [0x403000]; ret -- the slot names a small function on a
    // page of its own, 0x402000: ret. Forming looks at the callee where it is
    // code it may form, and a region already at its most blocks takes none of
    // it: the callee's page is in no block. A prediction with no callee formed
    // in would leave the region at every call, so the call stays a wasm call
    // as one nothing predicted is, and a worker told only the region's own
    // pages forms the same region.
    const form = { ...FORM, maxBlocks: 1 };
    /** @type {Map<number, Uint8Array>} */
    const pages = new Map([
        [0x401, [0xff, 0x15, 0x00, 0x30, 0x40, 0x00, 0xc3]],
        [0x402, [0xc3]],
        [0x403, [0x00, 0x20, 0x40, 0x00]],
    ].map(([page, bytes])=>{
        const copy = new Uint8Array(4096);
        copy.set(/** @type {number[]} */ (bytes));
        const at = /** @type {number} */ (page);
        return [at, copy];
    }));
    const read = (/** @type {number} */ address)=>pages.get(address >>> 12)?.[address & 0xfff] ?? 0;
    const region = formRegion(read, 0x401000, { ...form,
        translatable: address=>pages.has(address >>> 12) });
    assert.ok(region.blocks.every(block=>!block.exit.predicted), 'no call is predicted');
    assert.ok(!region.pages.has(0x402), 'and the callee\'s page is none of the region\'s');
    const relink = (/** @type {number[]} */ formable)=>relinkBatch({
        jobs: [{ entry: 0x401000, entryTop: 0, hash: region.hash }],
        pages: [...(region.reads ?? region.pages)].map(page=>[page,
            /** @type {Uint8Array} */ (pages.get(page))]),
        formable, form,
    }, layout, FEATURES, OPTIONS);
    assert.deepEqual(relink([...(region.formable ?? [])]).results.map(one=>one.ok), [true],
        'told every page forming was told it may form on');
    assert.deepEqual(relink([...region.pages]).results.map(one=>one.ok), [true],
        'told only the pages of its code');
    // With room for the callee it is formed in, and its page is the region's.
    const roomy = formRegion(read, 0x401000, { ...FORM,
        translatable: address=>pages.has(address >>> 12) });
    assert.ok(roomy.blocks.some(block=>block.exit.predicted), 'the call is predicted');
    assert.ok(roomy.pages.has(0x402));
});

test('regions of one batch are formed on the worker over each one\'s own pages, not all of'
    + ' theirs', ()=>{
    // 0x401000: nop; jmp 0x402000, formed where 0x402 may not be formed on from it (a page
    // of stubs, which holds only regions entered there); 0x402000: ret, entered there, on
    // its own page. Batched together, the first told the pages both may form on went on
    // into the second's page, its hash was not the runtime's, and its entry was answered
    // `changed` - barren for good, its bytes never written.
    /** @type {Map<number, Uint8Array>} */
    const pages = new Map([[0x401, [0x90, 0xe9, 0xfa, 0x0f, 0x00, 0x00]], [0x402, [0xc3]]]
        .map(([page, bytes])=>{
            const copy = new Uint8Array(4096);
            copy.set(/** @type {number[]} */ (bytes));
            const at = /** @type {number} */ (page);
            return [at, copy];
        }));
    const read = (/** @type {number} */ address)=>pages.get(address >>> 12)?.[address & 0xfff] ?? 0;
    const jump = formRegion(read, 0x401000, { ...FORM,
        translatable: address=>address >>> 12 === 0x401 });
    const stub = formRegion(read, 0x402000, { ...FORM,
        translatable: address=>address >>> 12 === 0x402 });
    assert.ok(!jump.pages.has(0x402), 'the jump\'s region stops at the stub page');
    const built = relinkBatch({
        jobs: [{ entry: 0x401000, entryTop: 0, hash: jump.hash, formable: [...jump.pages] },
            { entry: 0x402000, entryTop: 0, hash: stub.hash, formable: [...stub.pages] }],
        pages: [...pages], form: FORM,
    }, layout, FEATURES, OPTIONS);
    assert.deepEqual(built.results.map(one=>(one.ok ? 'ok' : one.message)), ['ok', 'ok']);
});

test('a relink formed where the pages lie in the guest\'s memory makes the module copies of'
    + ' them make; a page past the memory reads as zeros, as its copy did', ()=>{
    for (const name of ['load-x87', 'vcall-x87'])
    {
        const relink = relinkOf(name, 24);
        const at = 0x10000;
        const last = Math.max(...relink.pages.map(([page])=>page));
        // The memory ends a page short of the last one: read there as zeros, the
        // copy of which is a page of zeros.
        const memory = new Uint8Array(at + last * 4096);
        for (const [page, bytes] of relink.pages)
        {
            if (page < last)
            {
                memory.set(bytes, at + page * 4096);
            }
        }
        const copies = relink.pages.map(([page, bytes])=>
            /** @type {[number, Uint8Array]} */ ([page, page < last ? bytes : new Uint8Array(4096)]));
        const copied = relinkBatch({ ...relink, pages: copies }, layout, FEATURES, OPTIONS);
        const { pages, ...rest } = relink;
        const inPlace = relinkBatch({ ...rest, ram: { buffer: memory.buffer, at,
            pages: pages.map(([page])=>page) } }, layout, FEATURES, OPTIONS);
        assert.ok(inPlace.results.length > 0);
        assert.deepEqual(inPlace.results.map(result=>result.ok),
            copied.results.map(result=>result.ok), name);
        assert.deepEqual(inPlace.module, copied.module, `${name}: the same bytes`);
    }
});
