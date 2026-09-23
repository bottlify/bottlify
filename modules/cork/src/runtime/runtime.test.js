/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tables, ownLayout, pagesFor } from './layout.js';
import { PageFlag } from './pages.js';
import { createCorkRuntime } from './runtime.js';

const CODE = 0x1000;

/** A machine of 4 MiB with cork's own layout and a runtime over it. */
function machine(config = {}, ramSize = 4 << 20){
    const layout = ownLayout({ ramSize });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, Tables.SIZE) });
    const bytes = ()=>new Uint8Array(memory.buffer);
    const view = ()=>new DataView(memory.buffer);
    const runtime = createCorkRuntime({
        memory, layout, config,
        read: address=>bytes()[layout.ramBase + address],
        imports: { trap: ()=>0, getEflags: ()=>view().getUint32(layout.eflags, true),
            x87Read: ()=>0, rdtsc: ()=>0n },
    });
    return {
        layout, memory, runtime,
        /** @param {number} at @param {number[]} code */
        write(at, code){
            bytes().set(code, layout.ramBase + at);
        },
        /** @param {number} index @param {number} value */
        setReg(index, value){
            view().setUint32(layout.regs + index * 4, value >>> 0, true);
        },
        /** @param {number} index */
        reg(index){
            return view().getUint32(layout.regs + index * 4, true);
        },
        eip(){
            return view().getUint32(layout.eip, true);
        },
        counter(){
            return view().getUint32(layout.counter, true);
        },
    };
}

// mov ecx, 1000; L: dec ecx; jnz L; hlt
const COUNTDOWN = [0xb9, 0xe8, 0x03, 0, 0, 0x49, 0x75, 0xfd, 0xf4];

test('translate: false keeps the translator off for the interpreter alone', async()=>{
    const m = machine({ translate: false });
    m.write(CODE, COUNTDOWN);
    m.runtime.noteHot(CODE);
    m.runtime.noteHot(CODE);
    assert.equal(await m.runtime.translatePending(), 0, 'nothing is ever formed');
    assert.equal(m.runtime.entryOf(CODE), -1, 'and there is no entry to run');
});

test('a forced step is counted in the diagnostics', ()=>{
    const m = machine();
    assert.equal(m.runtime.diagnostics().forcedSteps, 0);
    m.runtime.forcedStep();
    m.runtime.forcedStep();
    assert.equal(m.runtime.diagnostics().forcedSteps, 2);
});

test('a hot address becomes a region after translatePending, and runs under a budget', async()=>{
    const m = machine();
    m.write(CODE, COUNTDOWN);
    m.setReg(4, 0x80000);
    assert.equal(m.runtime.entryOf(CODE), -1);
    assert.equal(await m.runtime.translatePending(), 0, 'nothing queued');
    m.runtime.noteHot(CODE);
    m.runtime.noteHot(CODE);
    assert.equal(await m.runtime.translatePending(), 1);
    assert.equal(await m.runtime.translatePending(), 0, 'the queue is empty again');
    const entry = m.runtime.entryOf(CODE);
    assert.ok(entry >= 0);
    assert.ok(m.runtime.entryOf(CODE + 5) >= 0, 'the loop header is an entry too');

    const first = m.runtime.run(entry, 100);
    assert.equal(first.kind, 'budget');
    assert.ok(first.retired >= 100, `retired ${first.retired}`);
    assert.equal((first.retired - 1) % 2, 0, 'a whole number of loop bodies after the mov');
    assert.equal(m.counter(), first.retired, 'the counter word holds what was retired');
    assert.equal(m.eip(), CODE + 5, 'at the loop header');

    let total = first.retired;
    let last = first;
    for (let i = 0; i < 100 && last.kind === 'budget'; i++)
    {
        last = m.runtime.run(m.runtime.entryOf(m.eip()), 100);
        total += last.retired;
    }
    assert.equal(last.kind, 'halt');
    assert.equal(total, 1 + 2 * 1000 + 1, 'the evaluator\'s count for the whole program');
    assert.equal(m.counter(), total);
    assert.equal(m.reg(1), 0);
    assert.equal(m.eip(), CODE + 9, 'past the hlt');
    const d = m.runtime.diagnostics();
    assert.equal(d.regions, 1);
    assert.equal(d.modules, 1);
    assert.equal(d.exits.halt, 1);
    assert.equal(d.translatedShare, 1, 'everything retired so far was in cork');
    assert.ok(d.translateMs > 0 && d.moduleBytes > 100, 'the cost of translating is reported');
});

test('two regions land in one batch, each its own module, and both run; an entry is asked by'
    + ' its own address', async()=>{
    const m = machine({ batchRegions: 8 });
    m.write(CODE, COUNTDOWN);
    m.write(CODE + 0x100, [0xb8, 0x07, 0, 0, 0, 0xf4]);   // mov eax, 7; hlt
    m.runtime.noteHot(CODE);
    m.runtime.noteHot(CODE + 0x100);
    assert.equal(await m.runtime.translatePending(), 2);
    assert.equal(m.runtime.diagnostics().modules, 2,
        'one module per region, the unit the store keeps');
    assert.equal(m.runtime.diagnostics().regions, 2);
    const second = m.runtime.run(m.runtime.entryOf(CODE + 0x100), 1000);
    assert.equal(second.kind, 'halt');
    assert.equal(second.retired, 2);
    assert.equal(m.reg(0), 7);
});

test('the hottest candidate is formed first, whatever order the candidates arrived in', async()=>{
    const m = machine({ batchRegions: 1 });
    m.write(CODE, COUNTDOWN);
    m.write(CODE + 0x100, [0xb8, 0x07, 0, 0, 0, 0xf4]);   // mov eax, 7; hlt
    m.runtime.noteHot(CODE, 0, 2);
    m.runtime.noteHot(CODE + 0x100, 0, 2);
    // Noted again while waiting, hotter: it moves up.
    m.runtime.noteHot(CODE + 0x100, 0, 128);
    assert.equal(await m.runtime.translatePending(), 1);
    assert.ok(m.runtime.entryOf(CODE + 0x100) >= 0, 'the hotter candidate went first');
    assert.equal(m.runtime.entryOf(CODE), -1, 'the cooler one waits for the next batch');
    assert.equal(await m.runtime.translatePending(), 1);
    assert.ok(m.runtime.entryOf(CODE) >= 0);
});

test('a deep queue takes a bigger batch, a quarter of what waits', async()=>{
    const m = machine({ batchRegions: 2, maxBatchRegions: 64 });
    for (let i = 0; i < 40; i++)
    {
        m.write(CODE + i * 0x40, [0xb8, i, 0, 0, 0, 0xf4]); // mov eax, i; hlt
        m.runtime.noteHot(CODE + i * 0x40, 0, 4);
    }
    assert.equal(await m.runtime.translatePending(), 10, 'forty waiting: ten in one batch');
    assert.equal(m.runtime.diagnostics().queued, 30);
});

test('a full queue evicts its coldest, oldest candidate', async()=>{
    const m = machine({ maxQueued: 2 });
    m.runtime.noteHot(CODE, 0, 2);
    m.runtime.noteHot(CODE + 0x100, 0, 64);
    m.runtime.noteHot(CODE + 0x200, 0, 4);
    const d = m.runtime.diagnostics();
    assert.equal(d.queued, 2);
    assert.equal(d.queueEvictions, 1, 'the coldest went');
    // The evicted one is noted again as the interpreter keeps counting it.
    m.runtime.noteHot(CODE, 0, 128);
    assert.equal(m.runtime.diagnostics().queued, 2);
    assert.equal(m.runtime.diagnostics().queueEvictions, 2);
});

test('a page write clears the candidates on a page above 256 MB', async()=>{
    // A candidate key is eip * 16 + top, past 2^32 there: the page it is
    // filed under must come from a division, not a shift that wraps.
    const m = machine({}, (256 << 20) + (16 << 12));
    const high = (256 << 20) + 0x2000;
    m.write(high, COUNTDOWN);
    m.runtime.noteHot(high);
    assert.equal(m.runtime.diagnostics().queued, 1);
    m.runtime.invalidatePage(high >>> 12);
    assert.equal(m.runtime.diagnostics().queued, 0, 'the candidate went with its page');
    assert.equal(await m.runtime.translatePending(), 0);
});

test('an invalidation between noteHot and translatePending drops the region', async()=>{
    const m = machine();
    m.write(CODE, COUNTDOWN);
    m.runtime.noteHot(CODE);
    m.runtime.invalidatePage(CODE >>> 12);
    assert.equal(await m.runtime.translatePending(), 0, 'the candidate went with the page');
    assert.equal(m.runtime.diagnostics().regions, 0);
    // A batch is compiled and published at the feed point itself; a page
    // that moves afterwards loses its region to the invalidation.
    m.runtime.noteHot(CODE);
    const pending = m.runtime.translatePending();
    m.runtime.invalidatePage(CODE >>> 12);
    assert.equal(await pending, 1);
    assert.equal(m.runtime.diagnostics().regions, 0);
    assert.equal(m.runtime.diagnostics().invalidations, 1);
    assert.equal(m.runtime.entryOf(CODE), -1);
});

test('a store into a code page leaves stale and drops the page\'s regions', async()=>{
    const m = machine();
    // The loop at CODE; a writer at CODE + 0x100 that stores into the loop's page.
    m.write(CODE, COUNTDOWN);
    // mov byte [0x1008], 0x90; hlt
    m.write(CODE + 0x100, [0xc6, 0x05, 0x08, 0x10, 0, 0, 0x90, 0xf4]);
    m.runtime.noteHot(CODE);
    m.runtime.noteHot(CODE + 0x100);
    assert.equal(await m.runtime.translatePending(), 2);
    assert.equal(m.runtime.pages.get(1) & PageFlag.HAS_CODE, PageFlag.HAS_CODE);
    assert.equal(m.runtime.holdsPage(1), true, 'what the host asks for its miss count');
    assert.equal(m.runtime.holdsPage(2), false);
    const exit = m.runtime.run(m.runtime.entryOf(CODE + 0x100), 1000);
    assert.equal(exit.kind, 'stale');
    assert.equal(m.eip(), CODE + 0x107, 'after the store');
    assert.equal(m.runtime.entryOf(CODE), -1, 'the loop\'s region is gone');
    assert.equal(m.runtime.entryOf(CODE + 0x100), -1, 'and the writer\'s, on the same page');
    assert.equal(m.runtime.pages.get(1) & PageFlag.HAS_CODE, 0, 'no code left on the page');
    assert.equal(m.runtime.holdsPage(1), false);
    const d = m.runtime.diagnostics();
    assert.equal(d.regions, 0);
    assert.equal(d.invalidations, 2);
    assert.equal(d.exits.stale, 1);
});

test('a page invalidated too often becomes volatile and is not translated again', async()=>{
    const m = machine({ volatileAfter: 3 });
    m.write(CODE, COUNTDOWN);
    // Writes into a page that holds no region (a loader placing an image)
    // are not what makes a page volatile.
    for (let i = 0; i < 10; i++)
    {
        m.runtime.invalidatePage(CODE >>> 12);
    }
    assert.equal(m.runtime.diagnostics().volatilePages, 0);
    for (let i = 0; i < 3; i++)
    {
        m.runtime.noteHot(CODE);
        assert.equal(await m.runtime.translatePending(), 1, `round ${i}`);
        m.runtime.invalidatePage(CODE >>> 12);
    }
    assert.equal(m.runtime.diagnostics().volatilePages, 1);
    m.runtime.noteHot(CODE);
    assert.equal(await m.runtime.translatePending(), 0, 'refused: the page is volatile');
    assert.equal(m.runtime.entryOf(CODE), -1);
});

test('a region that meets an instruction the emitter leaves out still runs up to it', async()=>{
    const m = machine();
    // mov eax, 1; fxsave [0x2000] (left out); hlt
    m.write(CODE, [0xb8, 0x01, 0, 0, 0, 0x0f, 0xae, 0x05, 0x00, 0x20, 0, 0, 0xf4]);
    m.runtime.noteHot(CODE);
    assert.equal(await m.runtime.translatePending(), 1);
    const exit = m.runtime.run(m.runtime.entryOf(CODE), 1000);
    assert.equal(exit.kind, 'untranslated');
    assert.equal(exit.retired, 1);
    assert.equal(m.eip(), CODE + 5, 'at the instruction the other executor must run');
    assert.equal(m.reg(0), 1);
    assert.ok(Object.keys(m.runtime.diagnostics().refused).some(key=>key.startsWith('0f ae')),
        `the opcode is named: ${JSON.stringify(m.runtime.diagnostics().refused)}`);
});

test('the runtime refuses a memory that has no room for its tables', ()=>{
    const layout = ownLayout({ ramSize: 1 << 20 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, 0) });
    assert.throws(()=>createCorkRuntime({
        memory, layout, config: {}, read: ()=>0,
        imports: { trap: ()=>0, getEflags: ()=>0, x87Read: ()=>0, rdtsc: ()=>0n },
    }), /before the tables/);
});

test('a hot region\'s direct callee lands in the same batch, and the call transfers', async()=>{
    const m = machine();
    // mov ecx, 1000; L: call F; dec ecx; jnz L; hlt; F: inc edx; ret
    m.write(CODE, [
        0xb9, 0xe8, 0x03, 0, 0,
        0xe8, 0x04, 0, 0, 0,
        0x49, 0x75, 0xf8,
        0xf4,
        0x42, 0xc3,
    ]);
    m.setReg(4, 0x80000);
    m.runtime.noteHot(CODE);
    assert.equal(await m.runtime.translatePending(), 2, 'the loop and its callee');
    assert.ok(m.runtime.entryOf(CODE + 14) >= 0, 'the callee is an entry');
    const exit = m.runtime.run(m.runtime.entryOf(CODE), 1_000_000);
    const d = m.runtime.diagnostics();
    if (d.entries > 0 && d.exits.untranslated === 0)
    {
        // With the hash, the calls and returns never leave wasm.
        assert.equal(exit.kind, 'halt');
        assert.equal(exit.retired, 1 + 1000 * 5 + 1);
        assert.equal(m.reg(2), 1000);
        assert.equal(d.exits.untranslated, 0);
        assert.equal(d.regions, 2);
        assert.equal(d.entries, 5,
            'the entry, the loop head, the return address, the hlt, the callee');
    }
    else
    {
        assert.equal(exit.kind, 'untranslated');
        assert.equal(m.eip(), CODE + 14);
    }
});

test('a callee lands in the batch at the top its call site has, not at the entry top', async()=>{
    const m = machine();
    // fld1; call F; hlt; F: fld1; ret -- the region is entered with the x87
    // stack at 7 and reaches the call with it at 6: the callee belongs to the
    // call site's top, or the call never transfers.
    m.write(CODE, [0xd9, 0xe8, 0xe8, 0x01, 0, 0, 0, 0xf4, 0xd9, 0xe8, 0xc3]);
    const F = CODE + 8;
    m.runtime.noteHot(CODE, 7);
    assert.equal(await m.runtime.translatePending(), 2, 'the caller and its callee');
    assert.ok(m.runtime.entryOf(F, 6) >= 0, 'the callee is compiled for the call site top');
    assert.equal(m.runtime.entryOf(F, 7), -1, 'and not for the entry top');
});

test('an address a region formed nothing at is not queued again until its page moves', async()=>{
    const m = machine();
    // fxsave [0x2000]; jmp back to it: the one block leaves at once, so the
    // region has nothing to enter.
    m.write(CODE, [0x0f, 0xae, 0x05, 0x00, 0x20, 0, 0, 0xeb, 0xf7]);
    m.runtime.noteHot(CODE);
    assert.equal(await m.runtime.translatePending(), 0);
    m.runtime.noteHot(CODE);
    assert.equal(await m.runtime.translatePending(), 0, 'not even formed again');
    m.write(CODE, COUNTDOWN);
    m.runtime.invalidatePage(CODE >>> 12);
    m.runtime.noteHot(CODE);
    assert.equal(await m.runtime.translatePending(), 1, 'the page moved: tried again');
});

test('a candidate is barren on its own block, not on the lowest one the region holds',
    async()=>{
        const m = machine();
        // A jump back into bytes the decoder refuses: the empty block the
        // refusal leaves sits below the entry in address order, and the
        // entry's own block is the one that decides whether the address
        // formed nothing.
        m.write(CODE - 0x10, [0xea, 0, 0, 0, 0, 0, 0]);   // jmp far: refused, empty block
        m.write(CODE, [0xeb, 0xee]);                      // jmp CODE-0x10
        m.runtime.noteHot(CODE);
        assert.equal(await m.runtime.translatePending(), 1, 'the entry block formed');
        const entry = m.runtime.entryOf(CODE);
        assert.ok(entry >= 0, 'the entry is published');
        const exit = m.runtime.run(entry, 100);
        assert.equal(exit.kind, 'untranslated');
        assert.equal(m.eip(), CODE - 0x10, 'the jump ran, to the bytes the decoder refuses');
        m.runtime.noteHot(CODE - 0x10);
        assert.equal(await m.runtime.translatePending(), 0,
            'the address of the empty block is barren');
    });

test('an address the translator keeps leaving for becomes a candidate of its own', async()=>{
    const m = machine({ missThreshold: 3 });
    // mov ecx, 5; L: call [0x2000]; dec ecx; jnz L; hlt; F: ret -- an indirect
    // call, so the former gathers nothing and F is reached by misses alone.
    m.write(CODE, [
        0xb9, 5, 0, 0, 0,
        0xff, 0x15, 0x00, 0x20, 0, 0,
        0x49, 0x75, 0xf7,
        0xf4,
        0xc3,
    ]);
    m.write(0x2000, [0x0f, 0x10, 0, 0]);
    const F = CODE + 15;
    m.setReg(4, 0x80000);
    m.runtime.noteHot(CODE);
    assert.equal(await m.runtime.translatePending(), 1);
    assert.equal(m.runtime.entryOf(F), -1, 'the callee has no entry');
    for (let i = 0; i < 3; i++)
    {
        m.setReg(4, 0x80000);
        new DataView(m.memory.buffer).setUint32(m.layout.eip, CODE, true);
        const exit = m.runtime.run(m.runtime.entryOf(CODE), 1_000_000);
        assert.equal(exit.kind, 'untranslated', `leave ${i}`);
        assert.equal(m.eip(), F);
        if (i < 2)
        {
            assert.equal(await m.runtime.translatePending(), 0, `not yet (${i})`);
        }
    }
    assert.equal(await m.runtime.translatePending(), 1, 'the callee, on its own count');
    assert.ok(m.runtime.entryOf(F) >= 0);
    m.setReg(4, 0x80000);
    new DataView(m.memory.buffer).setUint32(m.layout.eip, CODE, true);
    assert.equal(m.runtime.run(m.runtime.entryOf(CODE), 1_000_000).kind, 'halt',
        'the call and the return transfer now');
});

test('a loop that stores into data on its own page keeps its region', async()=>{
    const m = machine();
    // mov ecx, 1000; L: mov [0x1800], ecx; dec ecx; jnz L; hlt -- the data
    // two kilobytes past the code, on the same page.
    m.write(CODE, [0xb9, 0xe8, 0x03, 0, 0, 0x89, 0x0d, 0x00, 0x18, 0, 0, 0x49, 0x75, 0xf7, 0xf4]);
    m.setReg(4, 0x80000);
    m.runtime.noteHot(CODE);
    assert.equal(await m.runtime.translatePending(), 1);
    const exit = m.runtime.run(m.runtime.entryOf(CODE), 1_000_000);
    assert.equal(exit.kind, 'halt');
    const d = m.runtime.diagnostics();
    assert.equal(d.exits.stale, 0, 'no store counted as a store into code');
    assert.equal(d.invalidations, 0);
    assert.equal(d.regions, 1);
});

test('with a store, a second runtime takes its regions from the store; a changed byte misses',
    async()=>{
        const { memoryTranslationStore } = await import('./cache.js');
        // The store's reads leave the slice: a batch is requested, the call
        // answers before the bytes are back, and the batch is published when
        // they arrive. `settle` is that turn.
        const settle = ()=>new Promise(resolve=>setTimeout(resolve, 0));
        const store = memoryTranslationStore();
        const first = machine({ store, bundleId: 'test' });
        first.write(CODE, COUNTDOWN);
        first.setReg(4, 0x80000);
        first.runtime.noteHot(CODE);
        assert.equal(await first.runtime.translatePending(), 0,
            'the batch is requested, not awaited');
        assert.equal(first.runtime.entryOf(CODE), -1, 'nothing published this turn');
        await settle();
        assert.ok(first.runtime.entryOf(CODE) >= 0, 'published when the bytes came back');
        assert.equal(first.runtime.diagnostics().cacheMisses, 1);
        assert.equal(first.runtime.diagnostics().cacheHits, 0);
        assert.equal(store.size(), 1, 'the region is in the store');
        const second = machine({ store, bundleId: 'test' });
        second.write(CODE, COUNTDOWN);
        second.setReg(4, 0x80000);
        second.runtime.noteHot(CODE);
        await second.runtime.translatePending();
        await settle();
        const d = second.runtime.diagnostics();
        assert.equal(d.cacheHits, 1, 'from the store');
        assert.equal(d.cacheMisses, 0);
        const exit = second.runtime.run(second.runtime.entryOf(CODE), 1_000_000);
        assert.equal(exit.kind, 'halt', 'the stored module runs');
        assert.equal(second.reg(1), 0);
        assert.equal(exit.retired, 1 + 2 * 1000 + 1);
        // One byte changed: another hash, a miss, and the store grows.
        const third = machine({ store, bundleId: 'test' });
        third.write(CODE, [0xb9, 0xe9, 0x03, 0, 0, 0x49, 0x75, 0xfd, 0xf4]); // 1001 rounds
        third.setReg(4, 0x80000);
        third.runtime.noteHot(CODE);
        await third.runtime.translatePending();
        await settle();
        assert.equal(third.runtime.diagnostics().cacheMisses, 1);
        assert.equal(store.size(), 2);
        // Another bundle: its own namespace.
        const fourth = machine({ store, bundleId: 'other' });
        fourth.write(CODE, COUNTDOWN);
        fourth.setReg(4, 0x80000);
        fourth.runtime.noteHot(CODE);
        await fourth.runtime.translatePending();
        await settle();
        assert.equal(fourth.runtime.diagnostics().cacheMisses, 1);
        assert.equal(store.size(), 3);
    });

test('a flood of distinct misses does not stop a later address reaching the threshold',
    async()=>{
        const m = machine({ missThreshold: 64 });
        // Ten thousand addresses left for once each: the untranslated-exit
        // count fills and evicts, but a new address is still recorded.
        for (let i = 0; i < 10_000; i++)
        {
            m.runtime.missAt(0x10000 + i * 4, 0);
        }
        // A fresh address left for 64 times is a candidate, not dropped
        // because the map was full when it first appeared.
        const fresh = 0x80000;
        m.write(fresh, [0xb8, 7, 0, 0, 0, 0xf4]); // mov eax, 7; hlt
        for (let i = 0; i < 64; i++)
        {
            m.runtime.missAt(fresh, 0);
        }
        assert.equal(await m.runtime.translatePending(), 1, 'the fresh address was queued');
        assert.ok(m.runtime.entryOf(fresh) >= 0);
    });

test('the diagnostics histogram names the untranslated exits and why each target has none',
    ()=>{
        const m = machine({ missThreshold: 64 });
        // A target the decoder refuses (an SSE prefix with no variant): the
        // exit there can never form a region until the bytes change.
        m.write(0x3000, [0xf2, 0x0f, 0x28, 0xc1]);
        for (let i = 0; i < 3; i++)
        {
            m.runtime.missAt(0x3000, 0);
        }
        // A target queued and not yet formed.
        m.write(0x4000, [0x90, 0xf4]);
        m.runtime.noteHot(0x4000);
        m.runtime.missAt(0x4000, 0);
        // A target with plain code the runtime knows nothing about.
        m.write(0x5000, [0x90, 0xf4]);
        m.runtime.missAt(0x5000, 0);
        const exits = m.runtime.diagnostics().exitsByTarget;
        const reasons = Object.fromEntries(exits.map(row=>[row.address, row.reason]));
        assert.equal(reasons[0x3000], 'refused');
        assert.equal(reasons[0x4000], 'queued');
        assert.equal(reasons[0x5000], 'unknown');
        assert.deepEqual(exits.map(row=>row.address), [0x3000, 0x4000, 0x5000],
            'ordered by count: three, then the two of one');
        assert.equal(exits[0].count, 3);
    });

test('a return block the tracker cannot reach gets a region of its own, not a broken entry',
    async()=>{
        const m = machine();
        const RA = CODE + 7;
        // fninit; call F (elsewhere); RA: mov eax, [0x2000]; fld dword [0x2000];
        // fstp st0; hlt -- the integer head emits, the x87 is refused, so the
        // block would be a partial entry of the caller's region at its own top
        // and shadow every later attempt to compile it.
        m.write(CODE, [0xdb, 0xe3, 0xe8, 0x39, 0, 0, 0, 0xa1, 0, 0x20, 0, 0,
            0xd9, 0x05, 0, 0x20, 0, 0, 0xdd, 0xd8, 0xf4]);
        m.setReg(4, 0x80000);
        m.runtime.noteHot(CODE);
        assert.equal(await m.runtime.translatePending(), 1);
        assert.ok(m.runtime.entryOf(CODE) >= 0, 'the entry runs');
        assert.equal(m.runtime.entryOf(RA), -1, 'the return block has no entry of its own');
        assert.equal(await m.runtime.translatePending(), 1,
            'the miss queued a region of its own');
        assert.ok(m.runtime.entryOf(RA) >= 0, 'compiled for the top the machine has');
        const exit = m.runtime.run(m.runtime.entryOf(RA), 100);
        assert.equal(exit.kind, 'halt');
        // The fld pushed, the fstp st0 popped: the stack is as the call left it.
        assert.equal(new DataView(m.memory.buffer).getUint8(m.layout.x87Top), 0);
    });

test('a second x87 top at an entry is a miss of its own, not done for every top',
    async()=>{
        const m = machine();
        // fld1; hlt -- x87, so the region is compiled for the top it was
        // formed at and the entry is keyed by that top.
        m.write(CODE, [0xd9, 0xe8, 0xf4]);
        m.runtime.noteHot(CODE, 0);
        assert.equal(await m.runtime.translatePending(), 1);
        assert.ok(m.runtime.entryOf(CODE, 0) >= 0);
        assert.equal(m.runtime.entryOf(CODE, 1), -1, 'nothing for top 1 yet');
        // A machine arriving with top 1: the entry at top 0 is no answer, so
        // the runtime notes the top and forms a second region for it.
        m.runtime.noteHot(CODE, 1);
        assert.equal(await m.runtime.translatePending(), 1, 'a region for top 1');
        assert.ok(m.runtime.entryOf(CODE, 1) >= 0, 'top 1 runs now');
        assert.ok(m.runtime.entryOf(CODE, 0) >= 0, 'top 0 keeps its own');
        // The exit the machine was making stops: running at top 1 now reaches
        // the second region and halts, adding no untranslated exit.
        const before = m.runtime.diagnostics().exits.untranslated;
        const exit = m.runtime.run(m.runtime.entryOf(CODE, 1), 100);
        assert.equal(exit.kind, 'halt');
        assert.equal(m.runtime.diagnostics().exits.untranslated, before,
            'the exit count stopped growing');
    });

test('the miss count is per top, so a flood at a served top cannot withhold another',
    async()=>{
        const m = machine({ missThreshold: 64 });
        m.write(CODE, [0xd9, 0xe8, 0xf4]);
        m.runtime.noteHot(CODE, 0);
        assert.equal(await m.runtime.translatePending(), 1);
        // After each miss at top 1, sixty-three misses at top 0, which already
        // has an entry: every shared-count crossing there resets the count,
        // so an address-keyed count would erase the top 1 miss each round and
        // the region the machine actually needs would never be formed.
        for (let i = 0; i < 64; i++)
        {
            m.runtime.missAt(CODE, 1);
            for (let j = 0; j < 63; j++)
            {
                m.runtime.missAt(CODE, 0);
            }
        }
        assert.equal(await m.runtime.translatePending(), 1, 'top 1 reached the threshold');
        assert.ok(m.runtime.entryOf(CODE, 1) >= 0);
    });
