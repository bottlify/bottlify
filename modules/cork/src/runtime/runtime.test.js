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
import { eflagsOf } from '../emit/flags.js';
import { features as probeFeatures } from '../wasm/features.js';

const CODE = 0x1000;

/** A machine of 4 MiB with cork's own layout and a runtime over it. */
function machine(config = {}, ramSize = 4 << 20){
    const layout = ownLayout({ ramSize });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout,
        Tables.SIZE + (/** @type {any} */ (config).blockProfile ? Tables.BLOCK_PROFILE_SIZE : 0)) });
    const bytes = ()=>new Uint8Array(memory.buffer);
    const view = ()=>new DataView(memory.buffer);
    // The x87 as a fresh processor has it: every register empty, the default control word.
    view().setUint8(layout.x87Empty, 0xff);
    view().setUint16(layout.x87Control, 0x37f, true);
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

test('single precision seen leaves a wide x87 region once, and the address is translated'
    + ' again with the rounding', async()=>{
    const m = machine();
    const view = new DataView(m.memory.buffer);
    view.setUint8(m.layout.x87Empty, 0xff);
    // fld1; fld1; fadd st0, st1; fstp st0; fstp st0; hlt -- a rounding block, translated
    // under double precision and run under single.
    m.write(CODE, [0xd9, 0xe8, 0xd9, 0xe8, 0xd8, 0xc1, 0xdd, 0xd8, 0xdd, 0xd8, 0xf4]);
    m.runtime.noteHot(CODE, 0);
    await m.runtime.translatePending();
    assert.equal(m.runtime.diagnostics().wide, true);
    view.setUint16(m.layout.x87Control, 0x07f, true);
    const exit = m.runtime.run(m.runtime.entryOf(CODE, 0), 100);
    assert.equal(exit.kind, 'untranslated');
    assert.equal(exit.retired, 2, 'the two fld1 ran, the fadd did not');
    assert.equal(m.eip(), CODE + 4);
    const after = m.runtime.diagnostics();
    assert.equal(after.precisionSwitches, 1);
    assert.equal(after.wide, false);
    assert.equal(m.runtime.entryOf(CODE, 0), -1, 'the wide region went');
    // Translated again, it runs to the end under single precision.
    view.setUint32(m.layout.eip, CODE, true);
    view.setUint8(m.layout.x87Empty, 0xff);
    view.setUint8(m.layout.x87Top, 0);
    m.runtime.noteHot(CODE, 0);
    await m.runtime.translatePending();
    assert.equal(m.runtime.run(m.runtime.entryOf(CODE, 0), 100).kind, 'halt');
    assert.equal(m.runtime.diagnostics().precisionSwitches, 1, 'once');
    assert.equal(m.runtime.diagnostics().precision, 'narrow');
});

test('a batch formed while the machine has single set is compiled for single at once', async()=>{
    const m = machine();
    const view = new DataView(m.memory.buffer);
    view.setUint8(m.layout.x87Empty, 0xff);
    view.setUint16(m.layout.x87Control, 0x07f, true);
    m.write(CODE, [0xd9, 0xe8, 0xd9, 0xe8, 0xd8, 0xc1, 0xdd, 0xd8, 0xdd, 0xd8, 0xf4]);
    m.runtime.noteHot(CODE, 0);
    await m.runtime.translatePending();
    const before = m.runtime.diagnostics();
    assert.equal(before.precision, 'narrow');
    assert.equal(before.precisionSwitches, 1);
    assert.equal(m.runtime.run(m.runtime.entryOf(CODE, 0), 100).kind, 'halt');
    assert.equal(m.runtime.diagnostics().exits.untranslated, 0, 'no wide region to leave');
});

test('a region compiled for single leaves once another precision is seen, and the address is'
    + ' translated again with a test at every rounding instruction', async()=>{
    const m = machine();
    const view = new DataView(m.memory.buffer);
    const restart = ()=>{
        view.setUint32(m.layout.eip, CODE, true);
        view.setUint8(m.layout.x87Empty, 0xff);
        view.setUint8(m.layout.x87Top, 0);
    };
    view.setUint16(m.layout.x87Control, 0x07f, true);
    m.write(CODE, [0xd9, 0xe8, 0xd9, 0xe8, 0xd8, 0xc1, 0xdd, 0xd8, 0xdd, 0xd8, 0xf4]);
    restart();
    m.runtime.noteHot(CODE, 0);
    await m.runtime.translatePending();
    m.runtime.run(m.runtime.entryOf(CODE, 0), 100);
    restart();
    m.runtime.noteHot(CODE, 0);
    await m.runtime.translatePending();
    assert.equal(m.runtime.run(m.runtime.entryOf(CODE, 0), 100).kind, 'halt');
    assert.equal(m.runtime.diagnostics().precision, 'narrow');
    // Double precision under the single region: it leaves before the fadd.
    view.setUint16(m.layout.x87Control, 0x27f, true);
    restart();
    const exit = m.runtime.run(m.runtime.entryOf(CODE, 0), 100);
    assert.equal(exit.kind, 'untranslated');
    assert.equal(m.eip(), CODE + 4);
    const after = m.runtime.diagnostics();
    assert.equal(after.precisionSwitches, 2);
    assert.equal(after.precision, 'mixed');
    assert.equal(m.runtime.entryOf(CODE, 0), -1, 'the single region went');
    for (const control of [0x27f, 0x07f])
    {
        view.setUint16(m.layout.x87Control, control, true);
        restart();
        m.runtime.noteHot(CODE, 0);
        await m.runtime.translatePending();
        assert.equal(m.runtime.run(m.runtime.entryOf(CODE, 0), 100).kind, 'halt');
    }
    assert.equal(m.runtime.diagnostics().precisionSwitches, 2, 'and no further');
});

test('a formed-in leaf two tops reach takes an exchanged stack as it is', async()=>{
    // F is called with two values on the stack and then with one, so its
    // block is cut and runs on the machine's own top; the first call follows
    // an fxch, which the block holds as swapped locals. Doom 3's normal maps went
    // through _ftol2 this way, and the exchange stored back unswapped turned
    // every flat texel's 128 into 0.
    const m = machine();
    const view = new DataView(m.memory.buffer);
    view.setUint8(m.layout.x87Empty, 0xff);
    view.setUint16(m.layout.x87Control, 0x27f, true);
    const F = CODE + 0x100;
    m.write(CODE, [
        0xd9, 0xe8,                           // fld1
        0xd9, 0xee,                           // fldz
        0xd9, 0xc9,                           // fxch st1            st0 = 1, st1 = 0
        0xe8, 0xf5, 0, 0, 0,                  // call F              two on the stack
        0xe8, 0xf0, 0, 0, 0,                  // call F              one
        0xf4,                                 // hlt
    ]);
    m.write(F, [0xdd, 0xd8, 0xc3]);           // F: fstp st0; ret
    m.setReg(4, 0x80000);
    m.runtime.noteHot(CODE, 0);
    await m.runtime.translatePending();
    const exit = m.runtime.run(m.runtime.entryOf(CODE, 0), 100);
    // F ran inside the region and popped st0; the region leaves at the
    // second call, whose block the tracking does not reach with a state.
    assert.equal(exit.kind, 'untranslated');
    assert.equal(exit.retired, 6, 'fld1, fldz, fxch, call, fstp, ret');
    assert.equal(m.eip(), CODE + 11);
    assert.equal(m.reg(4), 0x80000);
    const top = view.getUint8(m.layout.x87Top);
    assert.equal(top, 7);
    assert.equal(view.getFloat64(m.layout.x87 + top * 16, true), 0,
        'F popped the 1 the fxch brought up, and the 0 is left');
});

test('a spent budget at an inlined return charges the callee once', async()=>{
    const m = machine();
    // mov ecx, 50; L: call F; dec ecx; jnz L; hlt; F: inc edx; ret -- F is a
    // leaf the region forms in, so its ret jumps back to the return block.
    m.write(CODE, [0xb9, 50, 0, 0, 0, 0xe8, 0x04, 0, 0, 0, 0x49, 0x75, 0xf8, 0xf4, 0x42, 0xc3]);
    m.setReg(4, 0x80000);
    m.runtime.noteHot(CODE);
    assert.ok(await m.runtime.translatePending() >= 1);
    let eip = CODE;
    let retired = 0;
    let exits = 0;
    for (let run = 0; run < 1000; run++)
    {
        const entry = m.runtime.entryOf(eip);
        assert.ok(entry >= 0, `an entry at ${eip.toString(16)}`);
        // Budgets that run out at every place in the five-instruction turn.
        const exit = m.runtime.run(entry, 3 + run % 5);
        retired += exit.retired;
        eip = m.eip();
        if (exit.kind === 'halt')
        {
            break;
        }
        exits++;
    }
    assert.ok(exits > 20, `${exits} budget exits`);
    assert.equal(m.reg(2), 50, 'edx: the callee ran fifty times');
    assert.equal(retired, 1 + 50 * 5 + 1, 'mov, fifty turns of call/inc/ret/dec/jnz, hlt');
});

test('a callee that calls on is formed in, and its callee\'s return comes back into it', async()=>{
    const m = machine({ countTransfers: true });
    // mov ecx, 50; L: call F; dec ecx; jnz L; hlt
    // F: inc edx; call G; ret -- formed into the loop's region
    // G: call H; ret -- calls on from inside F, so a region of its own
    // H: inc eax; ret
    m.write(CODE, [0xb9, 50, 0, 0, 0, 0xe8, 0x04, 0, 0, 0, 0x49, 0x75, 0xf8, 0xf4,
        0x42, 0xe8, 0x01, 0, 0, 0, 0xc3,
        0xe8, 0x01, 0, 0, 0, 0xc3,
        0x40, 0xc3]);
    m.setReg(4, 0x80000);
    for (const at of [CODE, CODE + 0x15, CODE + 0x1b])
    {
        m.runtime.noteHot(at);
    }
    while (await m.runtime.translatePending() > 0);
    let eip = CODE;
    let retired = 0;
    for (let run = 0; run < 5000; run++)
    {
        const entry = m.runtime.entryOf(eip);
        assert.ok(entry >= 0, `an entry at ${eip.toString(16)}`);
        const exit = m.runtime.run(entry, 3 + run % 7);
        retired += exit.retired;
        eip = m.eip();
        if (exit.kind === 'halt')
        {
            break;
        }
    }
    assert.equal(m.reg(2), 50, 'edx: F ran fifty times');
    assert.equal(m.reg(0), 50, 'eax: so did H, through G');
    assert.equal(m.reg(4), 0x80000, 'every call returned');
    assert.equal(retired, 1 + 50 * 10 + 1,
        'each turn: call, inc, call, call, inc, ret x3, dec, jnz');
    // Into G and back a turn; F's call and return stay in the loop's region
    // (four a turn when F is a region of its own).
    const transfers = m.runtime.diagnostics().transfers ?? Infinity;
    assert.ok(transfers <= 2 * 50, `${transfers} transfers through the hash`);
});

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
    const m = machine({ timings: true });
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

test('the translator reads the clock for its own account only when asked (timings)', async()=>{
    // A shipped build leaves the timings off: its milliseconds stay 0 and no
    // long hold is recorded. A diagnostic run asks for both.
    for (const timings of [false, true])
    {
        const m = machine({ timings });
        m.write(CODE, COUNTDOWN);
        m.runtime.noteHot(CODE);
        assert.equal(await m.runtime.translatePending(), 1);
        m.runtime.noteStall?.('held', 0, 0);
        const d = /** @type {any} */ (m.runtime.diagnostics());
        if (timings)
        {
            assert.ok(d.formingMs > 0 && d.emitMs > 0 && d.translateMs > 0, JSON.stringify(d));
            assert.deepEqual(d.stalls.map((/** @type {{ what: string }} */ one)=>one.what), ['held']);
        }
        else
        {
            for (const key of ['translateMs', 'formingMs', 'lookupMs', 'emitMs', 'encodeMs',
                'storeMs', 'instantiateMs', 'publishMs', 'workerMs'])
            {
                assert.equal(d[key], 0, key);
            }
            assert.deepEqual(d.stalls, []);
        }
    }
});

test('two regions land in one batch, in one module, and both run; an entry is asked by'
    + ' its own address', async()=>{
    const m = machine({ batchRegions: 8 });
    m.write(CODE, COUNTDOWN);
    m.write(CODE + 0x100, [0xb8, 0x07, 0, 0, 0, 0xf4]);   // mov eax, 7; hlt
    m.runtime.noteHot(CODE);
    m.runtime.noteHot(CODE + 0x100);
    assert.equal(await m.runtime.translatePending(), 2);
    assert.equal(m.runtime.diagnostics().modules, 1,
        'the batch in one module: a call between its regions stays inside it');
    assert.equal(m.runtime.diagnostics().regions, 2);
    const second = m.runtime.run(m.runtime.entryOf(CODE + 0x100), 1000);
    assert.equal(second.kind, 'halt');
    assert.equal(second.retired, 2);
    assert.equal(m.reg(0), 7);
});

test('the slice counters carry the snapshot\'s numbers without its sorted exit targets', async()=>{
    const m = machine({ batchRegions: 4 });
    m.write(CODE, COUNTDOWN);
    m.runtime.noteHot(CODE);
    await m.runtime.translatePending();
    m.runtime.run(m.runtime.entryOf(CODE), 1000);
    const cheap = m.runtime.counters();
    const whole = m.runtime.diagnostics();
    for (const key of /** @type {const} */ (['regions', 'modules', 'invalidations',
        'translatedShare', 'retired', 'translateMs']))
    {
        assert.equal(cheap[key], whole[key], key);
    }
    assert.deepEqual(cheap.exits, whole.exits);
    assert.ok(!('exitsByTarget' in cheap), 'no sorted targets on the slice path');
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

test('a target untranslated exits keep reaching is formed before a start met twice', async()=>{
    const m = machine({ batchRegions: 1, missThreshold: 4 });
    m.write(CODE, COUNTDOWN);
    m.write(CODE + 0x100, [0xb8, 0x07, 0, 0, 0, 0xf4]);   // mov eax, 7; hlt
    m.runtime.noteHot(CODE, 0, 2);
    for (let i = 0; i < 4; i++)
    {
        m.runtime.missAt(CODE + 0x100, 0);
    }
    assert.equal(await m.runtime.translatePending(), 1);
    assert.ok(m.runtime.entryOf(CODE + 0x100) >= 0, 'the exit target went first');
    assert.equal(m.runtime.entryOf(CODE), -1);
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

test('a page whose regions partly go keeps the code range of the ones left on it', async()=>{
    const m = machine();
    // One loop across the boundary into the next page, one inside that page further on.
    const across = CODE + 0xffa;
    const inside = CODE + 0x1800;
    m.write(across, COUNTDOWN);
    m.write(inside, COUNTDOWN);
    m.runtime.noteHot(across);
    m.runtime.noteHot(inside);
    assert.equal(await m.runtime.translatePending(), 2);
    const next = (CODE >>> 12) + 1;
    assert.deepEqual(m.runtime.pages.codeRange(next), [0, (0x808 >> 5) + 1], 'both regions');
    m.runtime.invalidatePage(CODE >>> 12);
    assert.equal(m.runtime.diagnostics().regions, 1);
    assert.deepEqual(m.runtime.pages.codeRange(next), [0x800 >> 5, (0x808 >> 5) + 1],
        'the one left alone');
    assert.deepEqual(m.runtime.pages.codeRange(CODE >>> 12), [0, 0]);
    m.runtime.invalidatePage(next);
    assert.deepEqual(m.runtime.pages.codeRange(next), [0, 0]);
});

test('a region that leaves a block inside its loop to the host on purpose is not formed again'
    + ' for it', async()=>{
    const m = machine();
    // mov ecx, 10; L: inc edx; test dl, 1; jz N; mov [ebx], eax; mov [ebx+4], esi; N: dec
    // ecx; jnz L; hlt -- the stores a block of their own inside the loop, with no entry, one
    // window tested at its start, and ebx past the RAM: the window faults, and the region
    // leaves there for the host to raise the fault.
    m.write(CODE, [0xb9, 10, 0, 0, 0, 0x42, 0xf6, 0xc2, 0x01, 0x74, 0x05, 0x89, 0x03,
        0x89, 0x73, 0x04, 0x49, 0x75, 0xf2, 0xf4]);
    m.runtime.noteHot(CODE);
    await m.runtime.translatePending();
    for (let i = 0; i < 100; i++)
    {
        m.setReg(2, 0);
        m.setReg(3, 0x800000);
        const exit = m.runtime.run(m.runtime.entryOf(CODE), 1000);
        assert.equal(exit.kind, 'untranslated');
        assert.equal(m.eip(), CODE + 0xb);
    }
    await m.runtime.translatePending();
    const d = m.runtime.diagnostics();
    assert.equal(d.copied, 0, 'no copies of the region for its own deliberate exit');
    assert.equal(d.queued, 0);
    assert.equal(d.exitsByTarget[0]?.address, CODE + 0xb, 'the exits still counted');
});

test('a store into a code page leaves stale and drops the page\'s regions', async()=>{
    // Precise: the store's own test, and the stale exit after it (outside precise the
    // store is a window, below).
    const m = machine({ precise: true });
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

test('outside precise a store into a code page leaves before it for the host, nothing stored',
    async()=>{
        const m = machine();
        m.write(CODE, COUNTDOWN);
        // mov byte [0x1008], 0x90; hlt
        m.write(CODE + 0x100, [0xc6, 0x05, 0x08, 0x10, 0, 0, 0x90, 0xf4]);
        m.runtime.noteHot(CODE);
        m.runtime.noteHot(CODE + 0x100);
        assert.equal(await m.runtime.translatePending(), 2);
        const exit = m.runtime.run(m.runtime.entryOf(CODE + 0x100), 1000);
        // The store's window finds code in its granule: the host's interpreter runs the
        // store, and its write drops the page's regions.
        assert.equal(exit.kind, 'untranslated');
        assert.equal(m.eip(), CODE + 0x100, 'before the store');
        assert.equal(new Uint8Array(m.memory.buffer)[m.layout.ramBase + 0x1008], COUNTDOWN[8],
            'nothing stored');
    });

test('code translated on a thread\'s stack drops the regions that store through esp untested, '
    + 'and the store that reaches it then leaves for the host', async()=>{
    const STACK = 0x80000;
    const m = machine();
    m.runtime.noteStack(STACK, 0x10000);
    // push eax; hlt
    m.write(CODE, [0x50, 0xf4]);
    m.runtime.noteHot(CODE);
    assert.equal(await m.runtime.translatePending(), 1);
    assert.equal(m.runtime.diagnostics().looseStacks, true);
    // A loop on a page of the stack: the push's region goes, and is formed again tested.
    m.write(STACK + 0x8000, COUNTDOWN);
    m.runtime.noteHot(STACK + 0x8000);
    assert.equal(await m.runtime.translatePending(), 1);
    let d = m.runtime.diagnostics();
    assert.equal(d.looseStacks, false);
    assert.equal(d.stackCode, 1);
    assert.equal(m.runtime.entryOf(CODE), -1, 'the loose region is gone');
    assert.notEqual(m.runtime.entryOf(STACK + 0x8000), -1);
    m.runtime.noteHot(CODE);
    assert.equal(await m.runtime.translatePending(), 1);
    // The push over the loop's hlt: before it, nothing stored.
    m.setReg(4, STACK + 0x800c);
    const exit = m.runtime.run(m.runtime.entryOf(CODE), 1000);
    assert.equal(exit.kind, 'untranslated');
    assert.equal(m.eip(), CODE);
    assert.equal(new Uint8Array(m.memory.buffer)[m.layout.ramBase + STACK + 0x8008], 0xf4);
    // A stack named over code already translated switches off as well, once only.
    const n = machine();
    n.write(STACK, COUNTDOWN);
    n.runtime.noteHot(STACK);
    assert.equal(await n.runtime.translatePending(), 1);
    n.runtime.noteStack(STACK - 0x1000, 0x2000);
    n.runtime.noteStack(STACK - 0x1000, 0x2000);
    d = n.runtime.diagnostics();
    assert.equal(d.looseStacks, false);
    assert.equal(d.stackCode, 1);
    // precise is never loose.
    assert.equal(machine({ precise: true }).runtime.diagnostics().looseStacks, false);
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

test('a jump to address 0 misses the entry hash, whose empty slots are keyed 0', async()=>{
    // A call through a null pointer: EIP 0 has no translation, so the run
    // leaves for it untranslated, where the fetch there faults as the
    // processor's would, rather than taking an empty slot's label and index.
    const m = machine();
    // xor eax, eax; jmp eax
    m.write(CODE, [0x31, 0xc0, 0xff, 0xe0]);
    m.runtime.noteHot(CODE);
    assert.ok(await m.runtime.translatePending() >= 1);
    const exit = m.runtime.run(m.runtime.entryOf(CODE), 1000);
    assert.equal(exit.kind, 'untranslated');
    assert.equal(m.eip(), 0);
    assert.equal(exit.retired, 2);
});

test('a hot region\'s direct callee lands in the same batch, and the call transfers', async()=>{
    // The callee kept out of its caller, so the call is a transfer.
    const m = machine({ leafCalls: false });
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

test('a region\'s direct callees land in its batch past `batchRegions`, up to the batch\'s'
    + ' ceiling', async()=>{
    const m = machine({ leafCalls: false, batchRegions: 32, maxBatchRegions: 256 });
    // call F0; call F1; ... call F39; hlt; Fi: inc edx; ret -- a loader's function calling
    // forty others, each once.
    const CALLS = 40;
    const hlt = CODE + CALLS * 5;
    /** @param {number} i */
    const callee = i=>hlt + 1 + i * 2;
    /** @type {number[]} */
    const code = [];
    for (let i = 0; i < CALLS; i++)
    {
        const rel = callee(i) - (CODE + i * 5 + 5);
        code.push(0xe8, rel & 0xff, rel >>> 8 & 0xff, rel >>> 16 & 0xff, rel >>> 24 & 0xff);
    }
    code.push(0xf4);
    for (let i = 0; i < CALLS; i++)
    {
        code.push(0x42, 0xc3);
    }
    m.write(CODE, code);
    m.setReg(4, 0x80000);
    m.runtime.noteHot(CODE);
    assert.equal(await m.runtime.translatePending(), 1 + CALLS, 'the caller and all its callees');
    for (let i = 0; i < CALLS; i++)
    {
        assert.ok(m.runtime.entryOf(callee(i)) >= 0, `callee ${i} is an entry`);
    }
    const exit = m.runtime.run(m.runtime.entryOf(CODE), 1_000_000);
    if (m.runtime.diagnostics().exits.untranslated === 0)
    {
        assert.equal(exit.kind, 'halt');
        assert.equal(m.reg(2), CALLS, 'every call ran its callee');
    }
    // A cap of eight takes seven.
    const small = machine({ leafCalls: false, batchRegions: 4, maxBatchRegions: 8 });
    small.write(CODE, code);
    small.runtime.noteHot(CODE);
    assert.equal(await small.runtime.translatePending(), 8);
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
    // mov ecx, 5; mov ebx, 0x2000; L: call [ebx]; dec ecx; jnz L; hlt; F: ret --
    // an indirect call through a register, so the former gathers nothing and
    // F is reached by misses alone.
    m.write(CODE, [
        0xb9, 5, 0, 0, 0,
        0xbb, 0x00, 0x20, 0, 0,
        0xff, 0x13,
        0x49, 0x75, 0xfb,
        0xf4,
        0xc3,
    ]);
    m.write(0x2000, [0x10, 0x10, 0, 0]);
    const F = CODE + 16;
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

test('a call through a fixed slot forms its leaf in, and goes where the slot says', async()=>{
    const m = machine();
    // mov ecx, 5; xor eax, eax; L: call [0x2000]; dec ecx; jnz L; hlt;
    // F: inc eax; ret; G: add eax, 2; ret -- an import's call through its table.
    m.write(CODE, [
        0xb9, 5, 0, 0, 0,
        0x31, 0xc0,
        0xff, 0x15, 0x00, 0x20, 0, 0,
        0x49, 0x75, 0xf7,
        0xf4,
        0x40, 0xc3,
        0x83, 0xc0, 0x02, 0xc3,
    ]);
    const F = CODE + 17;
    const G = CODE + 19;
    m.write(0x2000, [F & 0xff, F >>> 8, 0, 0]);
    m.setReg(4, 0x80000);
    m.runtime.noteHot(CODE);
    assert.equal(await m.runtime.translatePending(), 1);
    const run = ()=>{
        m.setReg(0, 0);
        m.setReg(4, 0x80000);
        new DataView(m.memory.buffer).setUint32(m.layout.eip, CODE, true);
        return m.runtime.run(m.runtime.entryOf(CODE), 1_000_000).kind;
    };
    assert.equal(run(), 'halt', 'the call and its return stay in the region');
    assert.equal(m.reg(0), 5);
    // The slot written: the call compares and leaves for where it points now,
    // its return address pushed.
    m.write(0x2000, [G & 0xff, G >>> 8, 0, 0]);
    assert.equal(run(), 'untranslated');
    assert.equal(m.eip(), G);
    assert.equal(m.reg(4), 0x80000 - 4);
    assert.equal(new DataView(m.memory.buffer).getUint32(m.layout.ramBase + 0x80000 - 4, true),
        CODE + 13);
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
        assert.equal(store.size(), 2, 'the region\'s record and its batch\'s module');
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
        assert.equal(store.size(), 4);
        // Another bundle: its own namespace.
        const fourth = machine({ store, bundleId: 'other' });
        fourth.write(CODE, COUNTDOWN);
        fourth.setReg(4, 0x80000);
        fourth.runtime.noteHot(CODE);
        await fourth.runtime.translatePending();
        await settle();
        assert.equal(fourth.runtime.diagnostics().cacheMisses, 1);
        assert.equal(store.size(), 6);
    });

test('precise keeps the x87 exception flags, in a store entry of its own; the default counts'
    + ' the status reads that may see them', async()=>{
    const { memoryTranslationStore } = await import('./cache.js');
    const settle = ()=>new Promise(resolve=>setTimeout(resolve, 0));
    const store = memoryTranslationStore();
    // fld1; fldz; fdivp st1, st0 (1 / 0: ZE); fnstsw [0x2000]; fstp st0; hlt
    const program = [0xd9, 0xe8, 0xd9, 0xee, 0xde, 0xf9, 0xdd, 0x3d, 0x00, 0x20, 0, 0,
        0xdd, 0xd8, 0xf4];
    /** @param {boolean} precise */
    const status = async precise=>{
        const m = machine({ store, bundleId: 'test', precise });
        new DataView(m.memory.buffer).setUint16(m.layout.x87Control, 0x37f, true);
        m.write(CODE, program);
        m.setReg(4, 0x80000);
        m.runtime.noteHot(CODE, 0);
        await m.runtime.translatePending();
        await settle();
        assert.equal(m.runtime.run(m.runtime.entryOf(CODE, 0), 100).kind, 'halt');
        const d = m.runtime.diagnostics();
        return { word: new DataView(m.memory.buffer).getUint16(m.layout.ramBase + 0x2000, true),
            hits: d.cacheHits, reads: d.x87RelaxedReads };
    };
    const fast = await status(false);
    assert.equal(fast.word & 4, 0, 'fast: no ZE');
    assert.equal(fast.reads, 1, 'the fnstsw into memory is counted');
    const precise = await status(true);
    assert.equal(precise.hits, 0, 'the fast translation is not taken from the store');
    assert.equal(precise.word & 4, 4, 'precise: ZE');
    assert.equal(precise.reads, 0);
    assert.equal((await status(false)).hits, 1, 'the fast one is, for a fast run');
});

test('a store that answers at once has a batch published in the call that formed it', async()=>{
    const settle = ()=>new Promise(resolve=>setTimeout(resolve, 0));
    /** @type {Map<string, Uint8Array>} */
    const records = new Map();
    const store = {
        get: async(/** @type {string} */ key)=>records.get(key) ?? null,
        put: async(/** @type {string} */ key, /** @type {Uint8Array} */ bytes)=>{
            records.set(key, bytes);
        },
        getNow: (/** @type {string} */ key)=>records.get(key) ?? null,
    };
    /** @param {any} which */
    const hot = which=>{
        const m = machine({ store: which, bundleId: 'test' });
        m.write(CODE, COUNTDOWN);
        m.setReg(4, 0x80000);
        m.runtime.noteHot(CODE);
        return m;
    };
    const first = hot(store);
    assert.equal(await first.runtime.translatePending(), 1, 'a miss, emitted and published');
    assert.ok(first.runtime.entryOf(CODE) >= 0);
    assert.equal(records.size, 2, 'and stored');
    const second = hot(store);
    assert.equal(await second.runtime.translatePending(), 1, 'a hit, published');
    assert.deepEqual([second.runtime.diagnostics().cacheHits, records.size], [1, 2],
        'nothing emitted or stored again');
    assert.deepEqual([second.runtime.diagnostics().lookedUpNow,
        second.runtime.diagnostics().lookedUpLater], [1, 0]);
    const exit = second.runtime.run(second.runtime.entryOf(CODE), 1_000_000);
    assert.equal(exit.kind, 'halt');
    assert.equal(exit.retired, 1 + 2 * 1000 + 1);
    // One that cannot answer so yet is asked through `get`, a turn later.
    const third = hot({ ...store, getNow: ()=>undefined });
    assert.equal(await third.runtime.translatePending(), 0);
    assert.equal(third.runtime.entryOf(CODE), -1);
    await settle();
    assert.ok(third.runtime.entryOf(CODE) >= 0);
    assert.equal(third.runtime.diagnostics().cacheHits, 1);
    assert.deepEqual([third.runtime.diagnostics().lookedUpNow,
        third.runtime.diagnostics().lookedUpLater], [0, 1]);
});

test('a batch the store answers whole sends the next for the asks still owed, a turn later',
    async()=>{
        // A bottle's next run: the store answers every batch at once, so no
        // worker's answer comes back to send the next, and the host asks only
        // when the interpreter notes a new start -- which code already queued
        // is not.
        const settle = ()=>new Promise(resolve=>setTimeout(resolve, 0));
        const starts = [0x2000, 0x3000, 0x4000];
        /** @type {Map<string, Uint8Array>} */
        const records = new Map();
        let answersNow = true;
        const store = {
            get: async(/** @type {string} */ key)=>records.get(key) ?? null,
            put: async(/** @type {string} */ key, /** @type {Uint8Array} */ bytes)=>{
                records.set(key, bytes);
            },
            getNow: (/** @type {string} */ key)=>(answersNow
                ? records.get(key) ?? null : undefined),
        };
        /** @param {number} count */
        const machineWith = count=>{
            const m = machine({ store, bundleId: 'test', batchRegions: 1 });
            m.setReg(4, 0x80000);
            for (const at of starts.slice(0, count))
            {
                m.write(at, COUNTDOWN);
                m.runtime.noteHot(at, 0, 2);
            }
            return m;
        };
        const first = machineWith(3);
        for (let i = 0; i < 3; i++)
        {
            await first.runtime.translatePending();
            await settle();
        }
        assert.ok(starts.every(at=>first.runtime.entryOf(at) >= 0), 'all three stored');
        const next = machineWith(3);
        answersNow = false;
        assert.equal(await next.runtime.translatePending(), 0,
            'the first batch asks the store later');
        await next.runtime.translatePending();
        await next.runtime.translatePending();
        answersNow = true;
        for (let i = 0; i < 10 && !starts.every(at=>next.runtime.entryOf(at) >= 0); i++)
        {
            await settle();
        }
        assert.deepEqual(starts.map(at=>next.runtime.entryOf(at) >= 0), [true, true, true],
            'the owed asks are answered with no further ask');
        assert.equal(next.runtime.diagnostics().cacheHits, 3);
    });

test('a runtime that goes leaves the store it was handed open for the others sharing it',
    async()=>{
        // The shape of a store over a directory: once closed it answers
        // nothing at once, and a lookup waits a turn -- as the origin file
        // system's does without its records file's synchronous handle.
        /** @type {Map<string, Uint8Array>} */
        const records = new Map();
        let closed = false;
        const store = {
            get: async(/** @type {string} */ key)=>records.get(key) ?? null,
            put: async(/** @type {string} */ key, /** @type {Uint8Array} */ bytes)=>{
                records.set(key, bytes);
            },
            getNow: (/** @type {string} */ key)=>(closed ? undefined : records.get(key) ?? null),
            flush: async()=>{},
            close: ()=>{
                closed = true;
            },
        };
        /** @param {any} which */
        const hot = which=>{
            const m = machine({ store: which, bundleId: 'test' });
            m.write(CODE, COUNTDOWN);
            m.setReg(4, 0x80000);
            m.runtime.noteHot(CODE);
            return m;
        };
        const parent = hot(store);
        assert.equal(await parent.runtime.translatePending(), 1);
        const child = hot(store);
        assert.equal(await child.runtime.translatePending(), 1);
        await child.runtime.flush();
        assert.equal(closed, false, 'the child\'s machine went; the store is the run\'s');
        const next = hot(store);
        assert.equal(await next.runtime.translatePending(), 1, 'answered at once, as before');
        assert.deepEqual([next.runtime.diagnostics().lookedUpNow,
            next.runtime.diagnostics().lookedUpLater], [1, 0]);
    });

test('a region whose code is written while its lookups are out is not published for the old bytes',
    async()=>{
        const { memoryTranslationStore } = await import('./cache.js');
        const settle = ()=>new Promise(resolve=>setTimeout(resolve, 0));
        const store = memoryTranslationStore();
        // mov eax, imm32; hlt
        const program = (/** @type {number} */ value)=>[0xb8, value, 0, 0, 0, 0xf4];
        /**
         * A batch formed over `before`, its code made `after` while the store
         * answers -- as a guest store does into a page with no translated code
         * on it yet, which nothing watches -- and what then runs at the entry.
         *
         * @param {number[]} before @param {number[]} after
         */
        const formedThenWritten = async(before, after)=>{
            const m = machine({ store, bundleId: 'test' });
            m.write(CODE, before);
            m.setReg(4, 0x80000);
            m.runtime.noteHot(CODE);
            await m.runtime.translatePending();
            m.write(CODE, after);
            await settle();
            const published = m.runtime.entryOf(CODE) >= 0;
            const eax = published ? (m.runtime.run(m.runtime.entryOf(CODE), 100), m.reg(0)) : null;
            return { published, eax, d: m.runtime.diagnostics() };
        };
        // Emitted after the write: from the region formed before it.
        const emitted = await formedThenWritten(program(1), program(2));
        assert.equal(emitted.d.cacheMisses, 1);
        assert.deepEqual([emitted.published, emitted.eax], [false, null],
            'not published: it would return 1 where the code now says 2');
        // Taken from the store after the write: a record for the old bytes.
        const stored = await formedThenWritten(program(3), program(3));
        assert.equal(stored.eax, 3);
        const taken = await formedThenWritten(program(3), program(4));
        assert.equal(taken.d.cacheHits, 1, 'found by the bytes it was formed from');
        assert.deepEqual([taken.published, taken.eax], [false, null], 'and not published');
    });

test('a host write into a page no region spans and no candidate is filed under moves nothing:'
    + ' a region whose lookups are out is read again for its bytes', async()=>{
    const { memoryTranslationStore } = await import('./cache.js');
    const settle = ()=>new Promise(resolve=>setTimeout(resolve, 0));
    const store = memoryTranslationStore();
    // mov eax, imm32; hlt
    const program = (/** @type {number} */ value)=>[0xb8, value, 0, 0, 0, 0xf4];
    /** @param {number[]} before @param {number[]} after */
    const formedThenWritten = async(before, after)=>{
        const m = machine({ store, bundleId: 'test' });
        m.write(CODE, before);
        m.setReg(4, 0x80000);
        m.runtime.noteHot(CODE);
        await m.runtime.translatePending();
        // As the host writes an answer: the bytes, then the page invalidated.
        m.write(CODE, after);
        m.runtime.invalidatePage(CODE >>> 12);
        await settle();
        const published = m.runtime.entryOf(CODE) >= 0;
        const eax = published ? (m.runtime.run(m.runtime.entryOf(CODE), 100), m.reg(0)) : null;
        return { published, eax };
    };
    assert.deepEqual(await formedThenWritten(program(1), program(2)),
        { published: false, eax: null }, 'the code changed: not published');
    assert.deepEqual(await formedThenWritten(program(5), program(5)),
        { published: true, eax: 5 }, 'the same bytes: the write cost the region nothing');
});

test('a host write into the page of a region\'s switch table drops the region, though no code'
    + ' is there', async()=>{
    const m = machine();
    // cmp eax, 2; ja D; jmp [0x3000 + eax*4]; C0..C4: ret; D: hlt
    m.write(CODE, [0x83, 0xf8, 0x02, 0x77, 0x0a, 0xff, 0x24, 0x85, 0x00, 0x30, 0x00, 0x00,
        0xc3, 0xc3, 0xc3, 0xc3, 0xc3, 0xf4]);
    m.write(0x3000, [0x0e, 0x10, 0, 0, 0x0f, 0x10, 0, 0, 0x10, 0x10, 0, 0]);
    m.runtime.noteHot(CODE);
    assert.equal(await m.runtime.translatePending(), 1);
    assert.equal(m.runtime.pages.get(3) & PageFlag.HAS_CODE, 0, 'no code on the table\'s page');
    m.runtime.invalidatePage(5);
    assert.ok(m.runtime.entryOf(CODE) >= 0, 'a page of nothing\'s: the region stays');
    m.runtime.invalidatePage(3);
    assert.equal(m.runtime.entryOf(CODE), -1, 'the table decides the region: it went');
    assert.equal(m.runtime.diagnostics().invalidations, 1);
});

test('structure left unset is structure on, in the store\'s key as in the code', async()=>{
    const { memoryTranslationStore } = await import('./cache.js');
    const settle = ()=>new Promise(resolve=>setTimeout(resolve, 0));
    const store = memoryTranslationStore();
    /** @param {{ structure?: boolean }} setting */
    const hits = async setting=>{
        const m = machine({ store, bundleId: 'test', ...setting });
        m.write(CODE, COUNTDOWN);
        m.setReg(4, 0x80000);
        m.runtime.noteHot(CODE);
        await m.runtime.translatePending();
        await settle();
        assert.equal(m.runtime.run(m.runtime.entryOf(CODE), 1_000_000).kind, 'halt');
        return m.runtime.diagnostics().cacheHits;
    };
    assert.equal(await hits({ structure: undefined }), 0);
    assert.equal(await hits({ structure: false }), 0,
        'the loop emitted as a wasm loop is not taken for a run without structure');
    assert.equal(await hits({ structure: true }), 1, 'unset and on emit the same code');
    assert.equal(await hits({ structure: false }), 1);
});

test('a store does not answer at an entry for other bytes that agree in 32 bits of their hash',
    async()=>{
        const { memoryTranslationStore } = await import('./cache.js');
        const settle = ()=>new Promise(resolve=>setTimeout(resolve, 0));
        const store = memoryTranslationStore();
        // mov eax, imm32; hlt: the two programs' bytes collide in FNV-1a's 32 bits.
        const run = async(/** @type {number[]} */ code)=>{
            const m = machine({ store, bundleId: 'test' });
            m.write(CODE, code);
            m.setReg(4, 0x80000);
            m.runtime.noteHot(CODE);
            await m.runtime.translatePending();
            await settle();
            const exit = m.runtime.run(m.runtime.entryOf(CODE), 1000);
            assert.equal(exit.kind, 'halt');
            return { eax: m.reg(0), hits: m.runtime.diagnostics().cacheHits };
        };
        assert.deepEqual(await run([0xb8, 0xbf, 0x20, 0x50, 0x13, 0xf4]),
            { eax: 0x135020bf, hits: 0 });
        assert.deepEqual(await run([0xb8, 0x9b, 0xb1, 0xb4, 0x1a, 0xf4]),
            { eax: 0x1ab4b19b, hits: 0 }, 'the other bytes ran, not the stored translation');
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
        // The call leaves: made as a wasm call, its return block is reached across it.
        const m = machine({ callReturn: false });
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

test('a relink gathers the running regions into one module; an entry another region'
    + ' holds keeps running that region\'s code', async()=>{
    // B at CODE+0x104: dec ecx; hlt. A at CODE+0x100: inc ebx; jmp CODE+0x104 -- A holds a
    // block at B's address, whose entry is B's (label 0 in B, label 1 in A).
    const m = machine({ relinkAfter: 1 });
    m.write(CODE + 0x100, [0x43, 0xeb, 0x01, 0x90, 0x49, 0xf4]);
    m.runtime.noteHot(CODE + 0x104);
    m.runtime.noteHot(CODE + 0x104);
    assert.equal(await m.runtime.translatePending(), 1, 'B');
    // Hot, as the interpreter would note it after meeting it while it waited.
    m.runtime.noteHot(CODE + 0x100, 0, 64);
    assert.equal(await m.runtime.translatePending(), 1, 'A');
    await m.runtime.translatePending();
    const d = m.runtime.diagnostics();
    assert.ok((d.relinked ?? 0) >= 2, `relinked ${d.relinked}`);
    // Entering at B's address runs B: ebx untouched.
    m.setReg(1, 5);
    m.setReg(3, 0);
    const exit = m.runtime.run(m.runtime.entryOf(CODE + 0x104), 100);
    assert.equal(exit.kind, 'halt');
    assert.equal(m.reg(3), 0, 'B\'s code, not A\'s block under B\'s label');
    assert.equal(m.reg(1), 4);
    // And A runs whole from its own entry.
    const whole = m.runtime.run(m.runtime.entryOf(CODE + 0x100), 100);
    assert.equal(whole.kind, 'halt');
    assert.equal(m.reg(3), 1);
    assert.equal(m.reg(1), 3);
});

test('exits to a flood of distinct addresses stay cheap and a hot one keeps its count', ()=>{
    // A loading phase leaves for hundreds of thousands of addresses: the count of
    // exits by target evicts the colder half at once when full, where a scan for
    // the single coldest on every insertion past the cap was a third of the phase.
    const m = machine();
    const began = performance.now();
    for (let i = 0; i < 200_000; i++)
    {
        m.runtime.missAt(0x100000 + i * 16, 0);
        if (i % 100 === 0)
        {
            m.runtime.missAt(0x8000, 0);
        }
    }
    const ms = performance.now() - began;
    assert.ok(ms < 2000, `200 000 exits took ${ms.toFixed(0)} ms`);
    const hot = m.runtime.diagnostics().exitsByTarget.find(one=>one.address === 0x8000);
    assert.ok(hot && hot.count >= 1000, `the hot target kept ${hot?.count} exits`);
});

test('a candidate whose batch is still out is not queued again when it is met again', async()=>{
    const { memoryTranslationStore } = await import('./cache.js');
    const m = machine({ store: memoryTranslationStore(), bundleId: 'test' });
    m.write(CODE, COUNTDOWN);
    m.runtime.noteHot(CODE, 0, 2);
    assert.equal(await m.runtime.translatePending(), 0, 'the batch waits on the store');
    // The interpreter meets it again, and again, while the batch is out.
    m.runtime.noteHot(CODE, 0, 4);
    m.runtime.noteHot(CODE, 0, 8);
    assert.equal(m.runtime.diagnostics().queued, 0, 'not a second translation of it');
    await new Promise(resolve=>setTimeout(resolve, 0));
    assert.ok(m.runtime.entryOf(CODE) >= 0, 'published when its batch came back');
});

test('a callee its caller took into a batch still out is not queued again when met', async()=>{
    const { memoryTranslationStore } = await import('./cache.js');
    const m = machine({ store: memoryTranslationStore(), bundleId: 'test', leafCalls: false });
    // call F; hlt; F: inc edx; ret
    m.write(CODE, [0xe8, 0x01, 0, 0, 0, 0xf4, 0x42, 0xc3]);
    const F = CODE + 6;
    m.runtime.noteHot(CODE, 0, 2);
    assert.equal(await m.runtime.translatePending(), 0, 'the batch waits on the store');
    m.runtime.noteHot(F, 0, 2);
    assert.equal(m.runtime.diagnostics().queued, 0, 'the callee is in the batch already');
    await new Promise(resolve=>setTimeout(resolve, 0));
    assert.ok(m.runtime.entryOf(F) >= 0, 'published with its caller');
});

test('a batch the worker forms from a copy of its pages runs as the one formed here', async()=>{
    const m = machine({ worker: true });
    m.write(CODE, COUNTDOWN);
    m.setReg(4, 0x80000);
    m.runtime.noteHot(CODE, 0, 2);
    // The worker opens on its own turn; the batch goes once it is there.
    let published = false;
    for (let i = 0; i < 200 && !published; i++)
    {
        await m.runtime.translatePending();
        await new Promise(resolve=>setTimeout(resolve, 10));
        published = m.runtime.entryOf(CODE) >= 0;
    }
    assert.ok(published, 'published from the worker');
    const exit = m.runtime.run(m.runtime.entryOf(CODE), 1_000_000);
    assert.equal(exit.kind, 'halt');
    assert.equal(m.reg(1), 0);
    assert.equal(exit.retired, 1 + 2 * 1000 + 1);
    await m.runtime.flush();
});

test('the worker rings the engine\'s doorbell after each answer it posts, its readiness too',
    async()=>{
        const posted = { buffer: new SharedArrayBuffer(4), index: 0 };
        const bell = { buffer: new SharedArrayBuffer(8), index: 1 };
        const m = machine({ worker: true, doorbell: { posted, bell } });
        const count = ()=>Atomics.load(new Int32Array(posted.buffer), 0);
        try
        {
            // Ready first, as the runtime has heard it: until then a batch is
            // emitted here, and nothing rings.
            for (let i = 0; i < 200 && m.runtime.diagnostics().worker !== 'ready'; i++)
            {
                await new Promise(resolve=>setTimeout(resolve, 10));
            }
            assert.equal(count(), 1, 'rung for its readiness');
            m.write(CODE, COUNTDOWN);
            m.setReg(4, 0x80000);
            m.runtime.noteHot(CODE, 0, 2);
            let published = false;
            for (let i = 0; i < 200 && !published; i++)
            {
                await m.runtime.translatePending();
                await new Promise(resolve=>setTimeout(resolve, 10));
                published = m.runtime.entryOf(CODE) >= 0;
            }
            assert.ok(published, 'published from the worker');
            assert.equal(count(), 2, 'and for the batch');
            assert.equal(Atomics.load(new Int32Array(bell.buffer), 1), 2, 'the bell with each');
        }
        finally
        {
            await m.runtime.flush();
        }
    });

test('a batch whose answer waits behind a hold of the engine thread past the limit is not given up',
    async()=>{
        const m = machine({ worker: true, inFlightMs: 200 });
        const OTHER = 0x2000;
        m.write(CODE, COUNTDOWN);
        m.write(OTHER, COUNTDOWN);
        m.setReg(4, 0x80000);
        try
        {
            // The worker is open once a first batch has come back from it.
            m.runtime.noteHot(OTHER, 0, 2);
            for (let i = 0; i < 200 && m.runtime.entryOf(OTHER) < 0; i++)
            {
                await m.runtime.translatePending();
                await new Promise(resolve=>setTimeout(resolve, 10));
            }
            assert.ok(m.runtime.entryOf(OTHER) >= 0, 'the worker answers');
            m.runtime.noteHot(CODE, 0, 2);
            await m.runtime.translatePending();
            // The engine thread held well past the limit: the worker answers meanwhile, and
            // its answer waits in the queue for the hold to end.
            const until = performance.now() + 1200;
            while (performance.now() < until)
            {
                // Holding.
            }
            await m.runtime.translatePending();
            m.runtime.noteHot(CODE, 0, 4);
            for (let i = 0; i < 20 && m.runtime.entryOf(CODE) < 0; i++)
            {
                await new Promise(resolve=>setTimeout(resolve, 10));
                await m.runtime.translatePending();
            }
            const d = m.runtime.diagnostics();
            assert.equal(d.refused['worker: no answer'], undefined, 'nothing given up');
            assert.ok(m.runtime.entryOf(CODE) >= 0, 'published from the answer that waited');
            assert.equal(d.regions, 2, 'and not translated a second time');
        }
        finally
        {
            await m.runtime.flush();
        }
    });

/**
 * Waits until the runtime's worker has loaded and takes the batches.
 *
 * @param {ReturnType<typeof machine>} m
 */
async function untilWorkerLoaded(m){
    for (let i = 0; i < 300 && m.runtime.diagnostics().worker !== 'ready'; i++)
    {
        await new Promise(resolve=>setTimeout(resolve, 10));
    }
    assert.equal(m.runtime.diagnostics().worker, 'ready', 'the worker loaded');
}

test('what queues while a batch is with the worker goes out when its answer comes, unasked',
    async()=>{
        const m = machine({ worker: true });
        const A = 0x2000;
        const B = 0x3000;
        m.write(CODE, COUNTDOWN);
        m.write(A, COUNTDOWN);
        m.write(B, COUNTDOWN);
        m.setReg(4, 0x80000);
        try
        {
            await untilWorkerLoaded(m);
            m.runtime.noteHot(A, 0, 2);
            await m.runtime.translatePending();
            // B is noted while A's batch is out: the host's ask finds a batch away.
            m.runtime.noteHot(B, 0, 2);
            assert.equal(await m.runtime.translatePending(), 0, 'one batch out at a time');
            // Nobody asks again: A's answer sends B.
            for (let i = 0; i < 200 && m.runtime.entryOf(B) < 0; i++)
            {
                await new Promise(resolve=>setTimeout(resolve, 10));
            }
            assert.ok(m.runtime.entryOf(A) >= 0, 'A published');
            assert.ok(m.runtime.entryOf(B) >= 0, 'B sent and published with no further ask');
        }
        finally
        {
            await m.runtime.flush();
        }
    });

test('a candidate that got an entry while it waited is not formed again', async()=>{
    // Batches of one: the loop's head waits while its caller's region, which
    // holds it as a block, is formed and published.
    const m = machine({ batchRegions: 1, maxBatchRegions: 1 });
    m.write(CODE, COUNTDOWN);
    m.setReg(4, 0x80000);
    m.runtime.noteHot(CODE + 5, 0, 2);
    m.runtime.noteHot(CODE, 0, 64);
    assert.equal(await m.runtime.translatePending(), 1, 'the hotter start first');
    assert.ok(m.runtime.entryOf(CODE + 5) >= 0, 'its region holds the loop head');
    await m.runtime.translatePending();
    assert.equal(m.runtime.diagnostics().regions, 1, 'the loop head not a region of its own');
});

test('a batch asked for while the worker is still loading is emitted inline, not held for it',
    async()=>{
        const m = machine({ worker: true });
        m.write(CODE, COUNTDOWN);
        m.setReg(4, 0x80000);
        try
        {
            // The worker is made, and is loading its modules.
            await new Promise(resolve=>setImmediate(resolve));
            await new Promise(resolve=>setImmediate(resolve));
            m.runtime.noteHot(CODE, 0, 2);
            await m.runtime.translatePending();
            assert.ok(m.runtime.entryOf(CODE) >= 0, 'published at once');
        }
        finally
        {
            await m.runtime.flush();
        }
    });

test('a worker that cannot load is dropped and the batches are emitted inline', async()=>{
    // A worker file that throws as it loads: the worker is made, and fails after.
    const m = machine({ workerUrl: 'data:text/javascript,throw new Error("cannot load")' });
    m.write(CODE, COUNTDOWN);
    m.setReg(4, 0x80000);
    m.runtime.noteHot(CODE, 0, 2);
    let published = false;
    for (let i = 0; i < 200 && !published; i++)
    {
        await m.runtime.translatePending();
        await new Promise(resolve=>setTimeout(resolve, 10));
        published = m.runtime.entryOf(CODE) >= 0;
    }
    assert.ok(published, 'translated inline, the worker never answering');
    /** @returns {string[]} */
    const lost = ()=>Object.keys(m.runtime.diagnostics().refused ?? {})
        .filter(reason=>reason.startsWith('worker: '));
    for (let i = 0; i < 200 && lost().length === 0; i++)
    {
        await new Promise(resolve=>setTimeout(resolve, 10));
    }
    assert.match(lost().join(', '), /cannot load/, 'the loss is reported, not thrown');
    await m.runtime.flush();
});

test('a region loads and stores only the registers it names, and a register written on one'
    + ' path keeps its value on the other', async()=>{
    const m = machine();
    // test ecx, ecx; jz skip; mov eax, 5; skip: hlt
    m.write(CODE, [0x85, 0xc9, 0x74, 0x05, 0xb8, 0x05, 0, 0, 0, 0xf4]);
    m.runtime.noteHot(CODE);
    m.runtime.noteHot(CODE);
    await m.runtime.translatePending();
    const entry = m.runtime.entryOf(CODE);
    assert.ok(entry >= 0);
    m.setReg(0, 0x1234);
    m.setReg(1, 0);
    m.setReg(3, 0xbeef);
    assert.equal(m.runtime.run(entry, 100).kind, 'halt');
    assert.equal(m.reg(0), 0x1234, 'eax, written only on the path not taken, is what it was');
    assert.equal(m.reg(3), 0xbeef, 'ebx, not named at all, is untouched');
    m.setReg(1, 1);
    assert.equal(m.runtime.run(entry, 100).kind, 'halt');
    assert.equal(m.reg(0), 5, 'and the path that writes it stores it');
});

test('a variant for another x87 top the machine keeps reaching goes before cold starts', async()=>{
    const m = machine({ batchRegions: 1, maxBatchRegions: 1 });
    // fld1; fstp st0; hlt -- an x87 region, so its entry is kept for one top.
    m.write(CODE, [0xd9, 0xe8, 0xdd, 0xd8, 0xf4]);
    m.runtime.noteHot(CODE, 0);
    assert.equal(await m.runtime.translatePending(), 1);
    assert.ok(m.runtime.entryOf(CODE, 0) >= 0);
    // Twenty cold starts wait first, each met once.
    for (let i = 0; i < 20; i++)
    {
        m.write(0x3000 + i * 16, [0x90, 0xf4]);
        m.runtime.noteHot(0x3000 + i * 16, 0);
    }
    // The machine stands at the region's address with top 1, again and
    // again (each entryOf is a step or a turn that found no entry there).
    for (let i = 0; i < 300; i++)
    {
        m.runtime.entryOf(CODE, 1);
    }
    assert.equal(await m.runtime.translatePending(), 1);
    assert.ok(m.runtime.entryOf(CODE, 1) >= 0, 'the top-1 variant was the batch, not a cold start');
    // An exit that went there at top 1 is now the wait for it, not a gap.
    m.runtime.missAt(CODE, 1);
    m.runtime.missAt(CODE, 2);
    const reason = ()=>m.runtime.diagnostics().exitsByTarget
        .find(target=>target.address === CODE)?.reason;
    assert.equal(reason(), 'other-top', 'top 2 has no region yet');
    for (let i = 0; i < 300; i++)
    {
        m.runtime.entryOf(CODE, 2);
    }
    await m.runtime.translatePending();
    assert.equal(reason(), 'translated since');
});

test('a transfer carries the registers and the count to a callee that names none of them,'
    + ' and its exit to the host writes them all', async()=>{
    const m = machine({ leafCalls: false });
    // mov ebx, 7; call F; hlt; F: inc edx; hlt -- F neither reads nor writes ebx, and the
    // caller never reaches its own exit, so the value is only ever in the transfer.
    m.write(CODE, [0xbb, 7, 0, 0, 0, 0xe8, 0x01, 0, 0, 0, 0xf4, 0x42, 0xf4]);
    m.setReg(3, 0x1234);
    m.setReg(4, 0x80000);
    m.runtime.noteHot(CODE);
    await m.runtime.translatePending();
    const before = m.counter();
    const exit = m.runtime.run(m.runtime.entryOf(CODE), 1000);
    if (m.runtime.diagnostics().exits.untranslated > 0)
    {
        return; // no tail calls: every region leaves for the host
    }
    assert.equal(exit.kind, 'halt');
    assert.equal(m.eip(), CODE + 13);
    assert.equal(m.reg(3), 7, 'ebx, written before the transfer, reaches the state block');
    assert.equal(m.reg(4), 0x80000 - 4, 'esp after the call\'s push');
    assert.equal(m.reg(2), 1, 'edx from the callee');
    assert.equal(m.counter() - before, 4, 'mov, call, inc and hlt, counted once across both');
    assert.equal(exit.retired, 4);
});

test('a block profile counts each block\'s executions: a loop\'s body its iterations', async()=>{
    const m = machine({ blockProfile: true });
    m.write(CODE, COUNTDOWN);
    m.runtime.noteHot(CODE);
    await m.runtime.translatePending();
    const exit = m.runtime.run(m.runtime.entryOf(CODE), 100_000);
    assert.equal(exit.kind, 'halt');
    const { blockCounts, topBlocks } = /** @type {any} */ (m.runtime.diagnostics());
    const count = (/** @type {number} */ address)=>blockCounts
        .find((/** @type {number[]} */ [at])=>at === address)?.[1];
    assert.equal(count(CODE + 5), 1000, 'dec ecx; jnz -- the loop body, once a turn');
    assert.equal(blockCounts.find((/** @type {number[]} */ [at])=>at === CODE + 5)[3], CODE,
        'in the region entered at the start');
    assert.equal(count(CODE), 1, 'the entry block, once');
    assert.equal(topBlocks[0].address, CODE + 5);
    assert.equal(topBlocks[0].entry, CODE, 'in the region entered at the start');
    assert.equal(topBlocks[0].shared, false);
});

test('a block profile with blockProfileFrom counts only what ran after that moment', async()=>{
    const now = performance.now;
    let clock = 0;
    performance.now = ()=>clock;
    try
    {
        const m = machine({ blockProfile: true, blockProfileFrom: 1 });
        m.write(CODE, COUNTDOWN);
        m.runtime.noteHot(CODE);
        await m.runtime.translatePending();
        m.runtime.run(m.runtime.entryOf(CODE), 100_000);
        clock = 1000;
        m.runtime.run(m.runtime.entryOf(CODE), 100_000);
        const { blockCounts } = /** @type {any} */ (m.runtime.diagnostics());
        const count = blockCounts.find((/** @type {number[]} */ [at])=>at === CODE + 5)?.[1];
        assert.equal(count, 1000, 'the second run alone; the first was counted before the moment');
    }
    finally
    {
        performance.now = now;
    }
});

test('a forward jump inside a region is a direct branch: the budget is looked at only on a'
    + ' backward one', async()=>{
    const m = machine();
    // inc eax; jmp +1; nop; inc eax; hlt -- the jump skips the nop into a block
    // further on, with the budget spent by the time it is taken.
    m.write(CODE, [0x40, 0xeb, 0x01, 0x90, 0x40, 0xf4]);
    m.runtime.noteHot(CODE);
    await m.runtime.translatePending();
    const forward = m.runtime.run(m.runtime.entryOf(CODE), 1);
    assert.equal(forward.kind, 'halt', 'went on past the spent budget to the hlt');
    assert.equal(m.reg(0), 2);
    // L: inc eax; jmp M; M: jmp L -- a loop of two blocks, whose backward
    // jump leaves once the budget is spent.
    m.write(CODE + 0x40, [0x40, 0xeb, 0x00, 0xeb, 0xfb]);
    m.runtime.noteHot(CODE + 0x40);
    await m.runtime.translatePending();
    const backward = m.runtime.run(m.runtime.entryOf(CODE + 0x40), 10);
    assert.equal(backward.kind, 'budget');
});

test('without a block profile a run counts nothing and says nothing of blocks', async()=>{
    const m = machine();
    m.write(CODE, COUNTDOWN);
    m.runtime.noteHot(CODE);
    await m.runtime.translatePending();
    m.runtime.run(m.runtime.entryOf(CODE), 100_000);
    assert.equal(/** @type {any} */ (m.runtime.diagnostics()).blockCounts, undefined);
});

test('a candidate a region of the same batch already holds is not formed again', async()=>{
    const m = machine();
    // mov ecx, 1000; L: call F; dec ecx; jnz L; hlt; F: inc edx; ret -- the
    // callee is formed into the loop, and a candidate at it finds it there.
    m.write(CODE, [
        0xb9, 0xe8, 0x03, 0, 0,
        0xe8, 0x04, 0, 0, 0,
        0x49, 0x75, 0xf8,
        0xf4,
        0x42, 0xc3,
    ]);
    m.setReg(4, 0x80000);
    m.runtime.noteHot(CODE);
    m.runtime.noteHot(CODE + 14);
    m.runtime.noteHot(CODE + 5);
    assert.equal(await m.runtime.translatePending(), 1, 'the loop, with its callee in it');
    assert.ok(m.runtime.entryOf(CODE + 5) >= 0, 'the loop\'s head is an entry');
    const exit = m.runtime.run(m.runtime.entryOf(CODE), 1_000_000);
    assert.equal(exit.kind, 'halt');
    assert.equal(m.reg(2), 1000);
});

test('a block inside a region\'s loop has an entry once translated code keeps leaving for it',
    async()=>{
        const m = machine();
        // mov ecx, 1000; L: call F; dec ecx; jnz L; hlt; F: inc edx; ret -- F is a block
        // of the loop, which the region is formed with no entry into.
        m.write(CODE, [
            0xb9, 0xe8, 0x03, 0, 0,
            0xe8, 0x04, 0, 0, 0,
            0x49, 0x75, 0xf8,
            0xf4,
            0x42, 0xc3,
        ]);
        m.setReg(4, 0x80000);
        m.runtime.noteHot(CODE);
        assert.equal(await m.runtime.translatePending(), 1);
        assert.equal(m.runtime.entryOf(CODE + 14), -1, 'none at first');
        // Its page says so to the interpreter tier in wasm, which leaves a miss
        // there to the host rather than run it in place, so the misses count.
        const page = (CODE + 14) >>> 12;
        assert.equal(m.runtime.pages.get(page) & PageFlag.CLOSED, PageFlag.CLOSED);
        // Nor is it a candidate of its own, however hot the interpreter finds it.
        m.runtime.noteHot(CODE + 14, 0, 128);
        assert.equal(m.runtime.diagnostics().queued, 0);
        for (let i = 0; i < 64; i++)
        {
            m.runtime.missAt(CODE + 14);
        }
        await m.runtime.translatePending();
        assert.equal(m.runtime.diagnostics().copied, 1, 'the region formed again');
        assert.ok(m.runtime.entryOf(CODE + 14) >= 0, 'its copy is an entry');
        assert.equal(m.runtime.pages.get(page) & PageFlag.CLOSED, 0, 'and the page no longer');
        // Called with its return address on the stack, F comes back to the hlt.
        m.setReg(4, 0x80000 - 4);
        new DataView(m.memory.buffer).setUint32(m.layout.ramBase + 0x80000 - 4, CODE + 13, true);
        assert.equal(m.runtime.run(m.runtime.entryOf(CODE + 14), 1000).kind, 'halt');
        assert.equal(m.reg(2), 1);
        assert.equal(m.runtime.run(m.runtime.entryOf(CODE), 1_000_000).kind, 'halt');
        assert.equal(m.reg(2), 1001);
    });

/**
 * mov ecx, n; L: call F; dec ecx; jnz L; hlt; F: inc edx; ret
 * @param {number} n
 */
const callLoop = n=>[
    0xb9, n & 0xff, n >>> 8 & 0xff, n >>> 16 & 0xff, 0,
    0xe8, 0x04, 0, 0, 0,
    0x49, 0x75, 0xf8,
    0xf4,
    0x42, 0xc3,
];

test('a transfer to a region of its own module is not a crossing; one into another module'
    + ' is, and is counted', async()=>{
    if (!probeFeatures().tailCalls)
    {
        return; // no hash: every transfer is the host's
    }
    // The loop and its callee in one batch: one module.
    const one = machine({ leafCalls: false, dispatch: true, callReturn: false });
    one.write(CODE, callLoop(1000));
    one.setReg(4, 0x80000);
    one.runtime.noteHot(CODE);
    assert.equal(await one.runtime.translatePending(), 2);
    assert.equal(one.runtime.run(one.runtime.entryOf(CODE), 1_000_000).kind, 'halt');
    assert.equal(one.reg(2), 1000);
    assert.equal(one.runtime.diagnostics().crossings, 0);
    // The callee first, in a batch of its own: each call and each return crosses.
    const two = machine({ leafCalls: false, mergeAfter: 0, dispatch: true, callReturn: false });
    two.write(CODE, callLoop(1000));
    two.setReg(4, 0x80000);
    two.runtime.noteHot(CODE + 14);
    assert.equal(await two.runtime.translatePending(), 1, 'the callee');
    two.runtime.noteHot(CODE);
    assert.equal(await two.runtime.translatePending(), 1, 'the loop, its callee translated');
    assert.equal(two.runtime.run(two.runtime.entryOf(CODE), 1_000_000).kind, 'halt');
    assert.equal(two.reg(2), 1000);
    assert.equal(two.runtime.diagnostics().crossings, 2000);
});

test('a placed module whose regions have all gone gives its range of the table back', async()=>{
    if (!probeFeatures().tailCalls)
    {
        return;
    }
    // The callee and the loop in modules of their own, dropped and made again
    // three hundred times, as a program rewriting its code in place has them:
    // six hundred ranges, where the table starts with 256 indices.
    const m = machine({ leafCalls: false, mergeAfter: 0, volatileAfter: 1000, dispatch: true,
        callReturn: false });
    for (let round = 0; round < 300; round++)
    {
        m.write(CODE, callLoop(100));
        m.setReg(2, 0);
        m.setReg(4, 0x80000);
        m.runtime.noteHot(CODE + 14);
        assert.equal(await m.runtime.translatePending(), 1, `the callee, round ${round}`);
        m.runtime.noteHot(CODE);
        assert.equal(await m.runtime.translatePending(), 1, `the loop, round ${round}`);
        assert.equal(m.runtime.run(m.runtime.entryOf(CODE), 1_000_000).kind, 'halt');
        assert.equal(m.reg(2), 100, `round ${round}`);
        assert.equal(m.runtime.diagnostics().crossings, 200, 'each call and return crosses');
        m.runtime.invalidatePage(CODE >>> 12);
        assert.equal(m.runtime.diagnostics().regions, 0);
    }
    assert.equal(m.runtime.diagnostics().tableSize, 256, 'the ranges were taken again');
});

test('two modules that keep transferring into each other are gathered into one, on the'
    + ' worker', async()=>{
    if (!probeFeatures().tailCalls)
    {
        return;
    }
    const m = machine({ leafCalls: false, mergeAfter: 1000, worker: true, dispatch: true,
        callReturn: false });
    // Enough calls for the crossings to be read (every 2^20 translated instructions).
    m.write(CODE, callLoop(300_000));
    m.setReg(4, 0x80000);
    /** Translates until the condition holds, the worker answering on its own turns.
     * @param {() => boolean} done */
    const until = async done=>{
        for (let i = 0; i < 300 && !done(); i++)
        {
            await m.runtime.translatePending();
            await new Promise(resolve=>setTimeout(resolve, 10));
        }
        assert.ok(done());
    };
    m.runtime.noteHot(CODE + 14);
    await until(()=>m.runtime.entryOf(CODE + 14) >= 0);
    m.runtime.noteHot(CODE);
    await until(()=>m.runtime.entryOf(CODE) >= 0);
    assert.equal(m.runtime.run(m.runtime.entryOf(CODE), 10_000_000).kind, 'halt');
    assert.equal(m.runtime.diagnostics().crossings, 600_000);
    await until(()=>(m.runtime.diagnostics().relinked ?? 0) >= 2);
    const d = m.runtime.diagnostics();
    assert.equal(d.merges, 1);
    assert.equal(d.relinked, 2, 'the loop and its callee, in one module');
    assert.equal(d.crossings, 0, 'the two modules have no running regions left');
    m.setReg(2, 0);
    m.setReg(4, 0x80000);
    assert.equal(m.runtime.run(m.runtime.entryOf(CODE), 10_000_000).kind, 'halt');
    assert.equal(m.reg(2), 300_000);
    assert.equal(m.runtime.diagnostics().crossings, 0, 'every transfer a direct tail call');
    await m.runtime.flush();
});

test('after a merge, the next waits for translated instructions in proportion to the regions'
    + ' it built', async()=>{
    if (!probeFeatures().tailCalls)
    {
        return;
    }
    const m = machine({ leafCalls: false, mergeAfter: 4000, worker: true, dispatch: true,
        batchRegions: 128 });
    // Two loops, each calling a callee of its own; the first one's batch has
    // sixty-four more regions, so its merge with its callee builds 66 (and
    // takes 66 x 4000 crossings, which its 300 000 calls make).
    const OTHER = CODE + 0x200;
    const STUBS = CODE + 0x100;
    m.write(CODE, callLoop(300_000));
    m.write(STUBS, new Array(64).fill(0xc3));
    m.write(OTHER, callLoop(3_000_000));
    /** @param {() => boolean} done */
    const until = async done=>{
        for (let i = 0; i < 300 && !done(); i++)
        {
            await m.runtime.translatePending();
            await new Promise(resolve=>setTimeout(resolve, 10));
        }
        assert.ok(done());
    };
    /** Runs a loop to its halt, then lets the translator read the crossings. @param {number} at */
    const loop = async at=>{
        m.setReg(4, 0x80000);
        assert.equal(m.runtime.run(m.runtime.entryOf(at), 100_000_000).kind, 'halt');
        await m.runtime.translatePending();
        await new Promise(resolve=>setTimeout(resolve, 50));
    };
    try
    {
        // The merges are the worker's: its batches go whole once it has loaded.
        await untilWorkerLoaded(m);
        m.runtime.noteHot(CODE + 14);
        await until(()=>m.runtime.entryOf(CODE + 14) >= 0);
        m.runtime.noteHot(CODE);
        for (let i = 0; i < 64; i++)
        {
            m.runtime.noteHot(STUBS + i);
        }
        await until(()=>m.runtime.entryOf(CODE) >= 0 && m.runtime.entryOf(STUBS + 63) >= 0);
        m.runtime.noteHot(OTHER + 14);
        await until(()=>m.runtime.entryOf(OTHER + 14) >= 0);
        m.runtime.noteHot(OTHER);
        await until(()=>m.runtime.entryOf(OTHER) >= 0);
        await loop(CODE);
        await until(()=>(m.runtime.diagnostics().relinked ?? 0) >= 66);
        assert.equal(m.runtime.diagnostics().merges, 1);
        // Three million crossings each way, fifteen million instructions: the
        // other pair would merge after 2^23, and waits for 66 x 2^19.
        await loop(OTHER);
        await loop(OTHER);
        assert.equal(m.runtime.diagnostics().merges, 1);
        await loop(OTHER);
        await until(()=>(m.runtime.diagnostics().relinked ?? 0) >= 68);
        assert.equal(m.runtime.diagnostics().merges, 2);
    }
    finally
    {
        await m.runtime.flush();
    }
});

/** A runtime with a worker, and the helpers the merge tests drive it with.
 * @param {Record<string, unknown>} config */
function mergeMachine(config){
    const m = machine({ leafCalls: false, dispatch: true, worker: true, ...config });
    // Batches go whole to the worker once it has loaded, and in small pieces
    // emitted inline before: the merges are the worker's.
    const loaded = untilWorkerLoaded(m);
    /** Translates until the condition holds, the worker answering on its own turns.
     * @param {() => boolean} done */
    const until = async done=>{
        await loaded;
        for (let i = 0; i < 300 && !done(); i++)
        {
            await m.runtime.translatePending();
            await new Promise(resolve=>setTimeout(resolve, 10));
        }
        assert.ok(done());
    };
    /** Runs a loop to its halt, then lets the translator read the crossings. @param {number} at */
    const loop = async at=>{
        m.setReg(4, 0x80000);
        assert.equal(m.runtime.run(m.runtime.entryOf(at), 100_000_000).kind, 'halt');
        await m.runtime.translatePending();
        await new Promise(resolve=>setTimeout(resolve, 50));
    };
    /** Translates the start in a batch of its own. @param {number} at */
    const translate = async at=>{
        m.runtime.noteHot(at);
        await until(()=>m.runtime.entryOf(at) >= 0);
    };
    return { m, until, loop, translate };
}

test('a merge waits for crossings in proportion to the regions it would build', async()=>{
    if (!probeFeatures().tailCalls)
    {
        return;
    }
    // A loop whose batch has sixty-four more regions calling a callee in a
    // module of its own: their merge builds 66 regions, so 66 x 10 000
    // crossings; each run of the loop makes 250 000 each way.
    const { m, until, loop, translate } = mergeMachine({ mergeAfter: 10_000,
        batchRegions: 128 });
    const STUBS = CODE + 0x100;
    m.write(CODE, callLoop(250_000));
    m.write(STUBS, new Array(64).fill(0xc3));
    try
    {
        await translate(CODE + 14);
        m.runtime.noteHot(CODE);
        for (let i = 0; i < 64; i++)
        {
            m.runtime.noteHot(STUBS + i);
        }
        await until(()=>m.runtime.entryOf(CODE) >= 0 && m.runtime.entryOf(STUBS + 63) >= 0);
        await loop(CODE);
        await loop(CODE);
        await until(()=>true);
        assert.equal(m.runtime.diagnostics().merges, 0, '500 000 crossings build no 66 regions');
        await loop(CODE);
        await until(()=>(m.runtime.diagnostics().relinked ?? 0) >= 66);
        assert.equal(m.runtime.diagnostics().merges, 1);
        assert.equal(m.runtime.diagnostics().merged, 66);
    }
    finally
    {
        await m.runtime.flush();
    }
});

/**
 * mov ecx, n; L: call F; dec ecx; jnz L; hlt -- at `at`, F at CODE.
 * @param {number} at @param {number} n
 */
const loopCalling = (at, n)=>{
    const rel = (CODE - (at + 10)) >>> 0;
    return [0xb9, n & 0xff, n >>> 8 & 0xff, n >>> 16 & 0xff, n >>> 24,
        0xe8, rel & 0xff, rel >>> 8 & 0xff, rel >>> 16 & 0xff, rel >>> 24,
        0x49, 0x75, 0xf8, 0xf4];
};

test('a region is built again by two merges at most', async()=>{
    if (!probeFeatures().tailCalls)
    {
        return;
    }
    // Three loops calling one function, each translated after the one before
    // has merged with it: the first merge builds the function and the first
    // loop, the second those two and the second loop, and the third would build
    // them a third time.
    const { m, until, loop, translate } = mergeMachine({ mergeAfter: 1000 });
    const loops = [CODE + 0x10, CODE + 0x30, CODE + 0x50];
    m.write(CODE, [0x42, 0xc3]);
    for (const at of loops)
    {
        m.write(at, loopCalling(at, 2_000_000));
    }
    try
    {
        await translate(CODE);
        await translate(loops[0]);
        await loop(loops[0]);
        await until(()=>(m.runtime.diagnostics().relinked ?? 0) >= 2);
        await translate(loops[1]);
        await loop(loops[1]);
        await until(()=>(m.runtime.diagnostics().relinked ?? 0) >= 5);
        assert.equal(m.runtime.diagnostics().merges, 2);
        await translate(loops[2]);
        await loop(loops[2]);
        await loop(loops[2]);
        await until(()=>true);
        const d = m.runtime.diagnostics();
        assert.equal(d.merges, 2, 'no third merge of the function');
        assert.equal(d.merged, 5);
        m.setReg(2, 0);
        await loop(loops[2]);
        assert.equal(m.reg(2), 2_000_000);
    }
    finally
    {
        await m.runtime.flush();
    }
});

/**
 * mov ecx, n; L: mov eax, ecx; and eax, 15; call [TABLE + eax*4]; dec ecx; jnz L; hlt;
 * F: add edx, 1; ret; G: add edx, 3; ret; H: add edx, 100; ret -- the table F and G in
 * turn, H in its last slot: F and G an indirect call's usual callees, H a rare one.
 * @param {number} n
 */
const dispatchLoop = n=>{
    const table = CODE + 0x100;
    const code = [
        0xb9, n & 0xff, n >>> 8 & 0xff, n >>> 16 & 0xff, 0,
        0x89, 0xc8,
        0x83, 0xe0, 0x0f,
        0xff, 0x14, 0x85, table & 0xff, table >>> 8 & 0xff, 0, 0,
        0x49, 0x75, 0xf1,
        0xf4,
        0x83, 0xc2, 0x01, 0xc3,
        0x83, 0xc2, 0x03, 0xc3,
        0x83, 0xc2, 0x64, 0xc3,
    ];
    const [f, g, h] = [CODE + 21, CODE + 25, CODE + 29];
    const slots = Array.from({ length: 16 }, (_, k)=>(k === 15 ? h : k % 2 === 1 ? g : f));
    return { code, table, slots, f, g, h };
};

test('an indirect call sampled going to a few small callees has them formed into its region,'
    + ' and a call to another still leaves', async()=>{
    if (!probeFeatures().tailCalls)
    {
        return; // no hash, no transfers to count
    }
    const m = machine({ countTransfers: true, callTargets: true, callReturn: false });
    const { code, table, slots, f, g, h } = dispatchLoop(1600);
    m.write(CODE, code);
    m.write(table, slots.flatMap(slot=>[slot & 0xff, slot >>> 8 & 0xff, 0, 0]));
    for (const at of [f, g, h, CODE])
    {
        m.runtime.noteHot(at);
    }
    await m.runtime.translatePending();
    /** The loop from its start, 1600 calls: F 800 times, G 700, H 100. */
    const run = ()=>{
        m.setReg(1, 1600);
        m.setReg(2, 0);
        m.setReg(4, 0x80000);
        const before = m.runtime.diagnostics().transfers ?? 0;
        assert.equal(m.runtime.run(m.runtime.entryOf(CODE + 5), 1_000_000).kind, 'halt');
        assert.equal(m.reg(2), 800 + 700 * 3 + 100 * 100);
        return (m.runtime.diagnostics().transfers ?? 0) - before;
    };
    assert.equal(run(), 3200, 'every call and every return a transfer');
    // Sixteen calls a reading, one translatePending in two.
    for (let i = 0; i < 16 && m.runtime.diagnostics().reforms === 0; i++)
    {
        run();
        await m.runtime.translatePending();
    }
    assert.equal(m.runtime.diagnostics().reforms, 1);
    // Only H leaves: its call, its return into the copy of the block after the call, which
    // is inside the loop (`emitCopies`), and the copy's way on to the loop's head.
    assert.equal(run(), 300, 'only H leaves, and its return comes back');
});

test('callTargets and dispatch are off unless a run asks for them', async()=>{
    if (!probeFeatures().tailCalls)
    {
        return; // no hash: no transfers, no placing
    }
    // Each is worth a lot on the benchmarks and cost games on real hardware
    // their frame rate while on (see the settings); a default that turns one
    // back on unnoticed is what this holds.
    const calls = machine({ countTransfers: true });
    const { code, table, slots, f, g, h } = dispatchLoop(1600);
    calls.write(CODE, code);
    calls.write(table, slots.flatMap(slot=>[slot & 0xff, slot >>> 8 & 0xff, 0, 0]));
    for (const at of [f, g, h, CODE])
    {
        calls.runtime.noteHot(at);
    }
    await calls.runtime.translatePending();
    for (let i = 0; i < 16; i++)
    {
        calls.setReg(1, 1600);
        calls.setReg(2, 0);
        calls.setReg(4, 0x80000);
        assert.equal(calls.runtime.run(calls.runtime.entryOf(CODE + 5), 1_000_000).kind, 'halt');
        await calls.runtime.translatePending();
    }
    assert.equal(calls.runtime.diagnostics().reforms, 0,
        'no indirect call sampled, no region formed again with its callees');
    // The callee in a module of its own: unplaced, a transfer between the two
    // goes through the table and is no crossing of a placed module's range.
    const modules = machine({ leafCalls: false, mergeAfter: 0 });
    modules.write(CODE, callLoop(1000));
    modules.setReg(4, 0x80000);
    modules.runtime.noteHot(CODE + 14);
    assert.equal(await modules.runtime.translatePending(), 1);
    modules.runtime.noteHot(CODE);
    assert.equal(await modules.runtime.translatePending(), 1);
    assert.equal(modules.runtime.run(modules.runtime.entryOf(CODE), 1_000_000).kind, 'halt');
    assert.equal(modules.reg(2), 1000);
    assert.equal(modules.runtime.diagnostics().crossings, 0, 'no module placed');
});

test('an indirect call sampled only now and then is not formed again; one sampled now is',
    async()=>{
        if (!probeFeatures().tailCalls)
        {
            return;
        }
        const m = machine({ callTargets: true });
        const { code, table, slots, f, g, h } = dispatchLoop(1600);
        m.write(CODE, code);
        m.write(table, slots.flatMap(slot=>[slot & 0xff, slot >>> 8 & 0xff, 0, 0]));
        for (const at of [f, g, h, CODE])
        {
            m.runtime.noteHot(at);
        }
        await m.runtime.translatePending();
        const profile = new DataView(m.memory.buffer);
        /** The loop run with the profile on, and the reading after it: sixteen samples. */
        const sampled = async()=>{
            if (profile.getUint32(/** @type {number} */ (m.layout.callProfile), true) === 0)
            {
                await m.runtime.translatePending();
            }
            m.setReg(1, 1600);
            m.setReg(2, 0);
            m.setReg(4, 0x80000);
            assert.equal(m.runtime.run(m.runtime.entryOf(CODE + 5), 1_000_000).kind, 'halt');
            await m.runtime.translatePending();
        };
        // Sixteen samples, then seventy readings of none: the call's 48th sample
        // comes in a phase of the program that leaves it cold between.
        for (let round = 0; round < 4; round++)
        {
            await sampled();
            for (let i = 0; i < 140; i++)
            {
                await m.runtime.translatePending();
            }
        }
        assert.equal(m.runtime.diagnostics().reforms, 0, 'sampled too seldom');
        for (let round = 0; round < 4; round++)
        {
            await sampled();
        }
        assert.equal(m.runtime.diagnostics().reforms, 1, 'sampled in a stretch');
    });

test('the regions of every indirect call sampled enough are formed again in one batch',
    async()=>{
        if (!probeFeatures().tailCalls)
        {
            return;
        }
        const m = machine({ callTargets: true });
        // mov ecx, n; L: mov eax, ecx; and eax, 15; call [TA + eax*4]; call B; dec ecx;
        // jnz L; hlt; B: mov eax, ecx; and eax, 15; call [TB + eax*4]; ret -- B a region
        // of its own (an indirect call is no leaf's), each call site's table two small
        // callees in turn, so every reading of the profile samples both sites.
        const [ta, tb] = [CODE + 0x100, CODE + 0x140];
        /** @param {number} table */
        const callThrough = table=>[0x89, 0xc8, 0x83, 0xe0, 0x0f,
            0xff, 0x14, 0x85, table & 0xff, table >>> 8 & 0xff, 0, 0];
        const n = 1600;
        const code = [0xb9, n & 0xff, n >>> 8, 0, 0, ...callThrough(ta),
            0xe8, 4, 0, 0, 0, 0x49, 0x75, 0xec, 0xf4, ...callThrough(tb), 0xc3,
            0x83, 0xc2, 1, 0xc3, 0x83, 0xc2, 3, 0xc3, 0x83, 0xc2, 5, 0xc3, 0x83, 0xc2, 7, 0xc3];
        const b = CODE + 26;
        const [f1, g1, f2, g2] = [CODE + 39, CODE + 43, CODE + 47, CODE + 51];
        /** @param {number} at @param {number[]} callees */
        const fill = (at, callees)=>m.write(at, Array.from({ length: 16 },
            (_, k)=>callees[k % 2]).flatMap(slot=>[slot & 0xff, slot >>> 8 & 0xff, 0, 0]));
        m.write(CODE, code);
        fill(ta, [f1, g1]);
        fill(tb, [f2, g2]);
        for (const at of [f1, g1, f2, g2, b, CODE])
        {
            m.runtime.noteHot(at);
        }
        await m.runtime.translatePending();
        const run = ()=>{
            m.setReg(2, 0);
            m.setReg(4, 0x80000);
            assert.equal(m.runtime.run(m.runtime.entryOf(CODE), 1_000_000).kind, 'halt');
            assert.equal(m.reg(2), 8 * n);
        };
        const modules = m.runtime.diagnostics().modules;
        for (let i = 0; i < 16 && m.runtime.diagnostics().reforms === 0; i++)
        {
            run();
            await m.runtime.translatePending();
        }
        const d = m.runtime.diagnostics();
        assert.equal(d.reforms, 2, 'the loop and B');
        assert.equal(d.modules, modules + 1, 'in one module');
        run();
    });

test('a transfer that finds no entry leaves with the carried state written back', async()=>{
    const m = machine();
    // mov ebx, 7; mov edx, -1; add edx, 1; mov eax, CODE+0x800; jmp eax -- nothing is
    // translated at the target, so the transfer misses and the run leaves there.
    m.write(CODE, [
        0xbb, 7, 0, 0, 0,
        0xba, 0xff, 0xff, 0xff, 0xff,
        0x83, 0xc2, 0x01,
        0xb8, 0x00, 0x18, 0, 0,
        0xff, 0xe0,
    ]);
    m.runtime.noteHot(CODE);
    await m.runtime.translatePending();
    const before = m.counter();
    const exit = m.runtime.run(m.runtime.entryOf(CODE), 1000);
    assert.equal(exit.kind, 'untranslated');
    assert.equal(exit.retired, 5);
    assert.equal(m.counter() - before, 5);
    assert.equal(m.eip(), CODE + 0x800);
    assert.equal(m.reg(0), CODE + 0x800);
    assert.equal(m.reg(3), 7);
    assert.equal(m.reg(2), 0);
    const flags = eflagsOf(new DataView(m.memory.buffer), m.layout);
    assert.equal(flags & 0x41, 0x41, 'CF and ZF of the add');
});

/**
 * Runs from EIP until the machine halts, translating each address the run
 * leaves at: the regions a program's calls and returns need, whichever way
 * the runtime found them.
 *
 * @param {ReturnType<typeof machine>} m
 */
async function runToHalt(m){
    let retired = 0;
    for (let turn = 0; turn < 64; turn++)
    {
        // The entry for the x87 top the machine has, as the host asks.
        const top = new DataView(m.memory.buffer).getUint8(m.layout.x87Top);
        if (m.runtime.entryOf(m.eip(), top) < 0)
        {
            m.runtime.noteHot(m.eip(), top);
            await m.runtime.translatePending();
        }
        const exit = m.runtime.run(m.runtime.entryOf(m.eip(), top), 10_000_000);
        retired += exit.retired;
        if (exit.kind === 'halt')
        {
            return retired;
        }
    }
    throw new Error('no halt');
}

test('with callReturn a call out of a region returns into it as a wasm call: the same run, half '
    + 'the transfers', async()=>{
    // mov ecx, 1000; L: call F; dec ecx; jnz L; hlt; F: inc edx; ret
    const program = [
        0xb9, 0xe8, 0x03, 0, 0, 0xe8, 0x04, 0, 0, 0, 0x49, 0x75, 0xf8, 0xf4, 0x42, 0xc3,
    ];
    /** @type {{ retired: number, transfers: number, edx: number, esp: number }[]} */
    const runs = [];
    for (const callReturn of [false, true])
    {
        const m = machine({ leafCalls: false, callReturn, countTransfers: true });
        m.write(CODE, program);
        m.setReg(4, 0x80000);
        new DataView(m.memory.buffer).setUint32(m.layout.eip, CODE, true);
        const retired = await runToHalt(m);
        const d = m.runtime.diagnostics();
        runs.push({ retired, transfers: d.transfers ?? 0, edx: m.reg(2), esp: m.reg(4) });
        assert.equal(new DataView(m.memory.buffer).getUint32(
            m.layout.tables + Tables.UNDO_RING, true), 0, 'no call left waiting');
    }
    const [plain, called] = runs;
    assert.equal(called.retired, plain.retired);
    assert.equal(called.edx, 1000);
    assert.equal(called.esp, 0x80000);
    if (plain.transfers > 0)
    {
        assert.ok(called.transfers <= plain.transfers / 2 + 2,
            `returns do not go through the hash: ${called.transfers} of ${plain.transfers}`);
    }
});

test('with callReturn an x87 callee returns the stack as it left it: its top, its empty mask and'
    + ' its registers in their places', async()=>{
    // mov ecx, 1; L: call F; dec ecx; jnz L; hlt; F: fld1; fldz; fxch; ret -- the return
    // with the top and the mask its plain forms keep in locals, the registers exchanged.
    const program = [
        0xb9, 1, 0, 0, 0, 0xe8, 0x04, 0, 0, 0, 0x49, 0x75, 0xf8, 0xf4,
        0xd9, 0xe8, 0xd9, 0xee, 0xd9, 0xc9, 0xc3,
    ];
    /** @type {number[][]} */
    const results = [];
    for (const callReturn of [false, true])
    {
        const m = machine({ leafCalls: false, callReturn });
        m.write(CODE, program);
        m.setReg(4, 0x80000);
        new DataView(m.memory.buffer).setUint32(m.layout.eip, CODE, true);
        await runToHalt(m);
        const view = new DataView(m.memory.buffer);
        results.push([view.getUint8(m.layout.x87Top), view.getUint8(m.layout.x87Empty),
            ...[0, 1, 2, 3, 4, 5, 6, 7].map(k=>view.getFloat64(m.layout.x87 + k * 16, true))]);
    }
    assert.deepEqual(results[0].slice(0, 4), [6, 0x3f, 0, 0], 'two pushes from top 0');
    assert.deepEqual(results[0].slice(8), [1, 0], 'ST0 (register 6) 1, ST1 0 after the exchange');
    assert.deepEqual(results[1], results[0]);
});

/**
 * A run of `program` at CODE to its halt with callReturn off and on: the transfers, edx,
 * the dword at DATA and the x87 top and empty mask of each.
 *
 * @param {number[]} program
 */
async function bothWays(program){
    /** @type {{ transfers: number, state: number[] }[]} */
    const runs = [];
    for (const callReturn of [false, true])
    {
        const m = machine({ leafCalls: false, callReturn, countTransfers: true });
        m.write(CODE, program);
        m.setReg(4, 0x80000);
        const view = new DataView(m.memory.buffer);
        view.setUint32(m.layout.eip, CODE, true);
        await runToHalt(m);
        runs.push({ transfers: m.runtime.diagnostics().transfers ?? 0,
            state: [m.reg(1), m.reg(2), m.reg(4), view.getUint32(m.layout.ramBase + 0x3000, true),
                view.getUint8(m.layout.x87Top), view.getUint8(m.layout.x87Empty)] });
    }
    return runs;
}

test('with callReturn a region with x87 makes its calls as wasm calls and goes on after them',
    async()=>{
        // mov ecx, 100; L: call F; fld1; fstp dword [0x3000]; dec ecx; jnz L; hlt;
        // F: inc edx; ret
        const [plain, called] = await bothWays([
            0xb9, 100, 0, 0, 0, 0xe8, 0x0c, 0, 0, 0, 0xd9, 0xe8, 0xd9, 0x1d, 0, 0x30, 0, 0,
            0x49, 0x75, 0xf0, 0xf4, 0x42, 0xc3,
        ]);
        assert.deepEqual(called.state, plain.state);
        assert.deepEqual(called.state, [0, 100, 0x80000, 0x3f800000, 0, 0xff]);
        if (plain.transfers > 0)
        {
            assert.ok(called.transfers <= plain.transfers / 2 + 2,
                `returns do not go through the hash: ${called.transfers} of ${plain.transfers}`);
        }
    });

test('with callReturn a callee that returns a float on the x87 stack has its caller leave at the'
    + ' return address, the stack as the callee left it', async()=>{
    // mov ecx, 100; L: call F; fstp dword [0x3000]; inc edx; dec ecx; jnz L; hlt;
    // F: fld1; ret -- the top after the call one below the call's
    const [plain, called] = await bothWays([
        0xb9, 100, 0, 0, 0, 0xe8, 0x0b, 0, 0, 0, 0xd9, 0x1d, 0, 0x30, 0, 0,
        0x42, 0x49, 0x75, 0xf1, 0xf4, 0xd9, 0xe8, 0xc3,
    ]);
    assert.deepEqual(called.state, plain.state);
    assert.deepEqual(called.state, [0, 100, 0x80000, 0x3f800000, 0, 0xff]);
});

test('with callReturn a region\'s control word reaches the callee, though the call is compiled'
    + ' before the block that loads it', async()=>{
    // mov word [0x3004], 0x0c7f; mov ecx, 100; L: call F; fldcw [0x3004]; dec ecx; jnz L;
    // fnstcw [0x3008]; hlt; F: fnstcw [0x3000]; ret -- from the second time round F sees
    // the word the loop loaded, and the word after the call is the region's own
    const [plain, called] = await bothWays([
        0x66, 0xc7, 0x05, 0x04, 0x30, 0, 0, 0x7f, 0x0c, 0xb9, 100, 0, 0, 0,
        0xe8, 0x10, 0, 0, 0, 0xd9, 0x2d, 0x04, 0x30, 0, 0, 0x49, 0x75, 0xf2,
        0xd9, 0x3d, 0x08, 0x30, 0, 0, 0xf4, 0xd9, 0x3d, 0, 0x30, 0, 0, 0xc3,
    ]);
    assert.equal(plain.state[3], 0xc7f, 'the callee stored the word the caller loaded');
    assert.deepEqual(called.state, plain.state);
});

test('with callReturn a value held on the x87 stack across a call to a callee that leaves the'
    + ' stack alone is the value after it', async()=>{
    // mov dword [0x3000], 3.0; mov dword [0x3104], 1.0; mov ecx, 100;
    // L: fld dword [0x3000]; push 0; push 4; push 0x3100; call F; fsub dword [eax]; fchs;
    // fstp dword [0x3000]; dec ecx; jnz L; hlt;
    // F: mov eax, [esp + 4]; add eax, 4; ret 12 -- the first x87 instruction after the
    // call reads ST0, which the caller loaded before it
    const [plain, called] = await bothWays([
        0xc7, 0x05, 0, 0x30, 0, 0, 0, 0, 0x40, 0x40,
        0xc7, 0x05, 0x04, 0x31, 0, 0, 0, 0, 0x80, 0x3f,
        0xb9, 100, 0, 0, 0,
        0xd9, 0x05, 0, 0x30, 0, 0, 0x6a, 0, 0x6a, 0x04, 0x68, 0, 0x31, 0, 0,
        0xe8, 0x0e, 0, 0, 0, 0xd8, 0x20, 0xd9, 0xe0, 0xd9, 0x1d, 0, 0x30, 0, 0,
        0x49, 0x75, 0xdf, 0xf4,
        0x8b, 0x44, 0x24, 0x04, 0x83, 0xc0, 0x04, 0xc2, 0x0c, 0,
    ]);
    assert.equal(plain.state[3], 0x40400000, 'a = 1 - a a hundred times from 3');
    assert.deepEqual(called.state, plain.state);
});

test('with callReturn calls deeper than the stack of waiting calls go on as plain transfers',
    async()=>{
        // Mutual recursion 600 deep, past CallStack.LIMIT:
        //   mov ecx, 600; call A; hlt
        //   A: dec ecx; jz 1f; inc edx; call B; 1: ret
        //   B: dec ecx; jz 1f; inc ebx; call A; 1: ret
        const program = [
            0xb9, 0x58, 0x02, 0, 0, 0xe8, 0x01, 0, 0, 0, 0xf4,
            0x49, 0x74, 0x06, 0x42, 0xe8, 0x01, 0, 0, 0, 0xc3,
            0x49, 0x74, 0x06, 0x43, 0xe8, 0xed, 0xff, 0xff, 0xff, 0xc3,
        ];
        /** @type {number[][]} */
        const results = [];
        for (const callReturn of [false, true])
        {
            const m = machine({ leafCalls: false, callReturn });
            m.write(CODE, program);
            m.setReg(4, 0x80000);
            new DataView(m.memory.buffer).setUint32(m.layout.eip, CODE, true);
            const retired = await runToHalt(m);
            results.push([retired, m.reg(1), m.reg(2), m.reg(3), m.reg(4), m.eip()]);
            assert.equal(new DataView(m.memory.buffer).getUint32(
                m.layout.tables + Tables.UNDO_RING, true), 0, 'no call left waiting');
        }
        assert.deepEqual(results[1], results[0]);
        assert.deepEqual(results[1].slice(1, 5), [0, 300, 299, 0x80000]);
    });

test('under precise the first x87 NaN made from numbers, NaN result, stack fault, NaN load and '
    + 'NaN store are noted with their instructions, and outside it nothing is', async()=>{
    // fldz; fld st0; fdivp st1, st0 (0/0); fstp st0; fld1; fchs; fsqrt (of -1); fstp st0; hlt
    const program = [0xd9, 0xee, 0xd9, 0xc0, 0xde, 0xf9, 0xdd, 0xd8, 0xd9, 0xe8, 0xd9, 0xe0,
        0xd9, 0xfa, 0xdd, 0xd8, 0xf4];
    const m = machine({ precise: true });
    m.write(CODE, program);
    new DataView(m.memory.buffer).setUint32(m.layout.eip, CODE, true);
    await runToHalt(m);
    const d = m.runtime.diagnostics();
    // The 0/0 is a NaN result first, then one made (the helper's record after the guard's).
    assert.deepEqual(d.nanFirst,
        { eip: `0x${(CODE + 4).toString(16)}`, count: 2, order: 2, a: 0, c: 0 });
    assert.deepEqual(d.nanResultFirst, { eip: `0x${(CODE + 4).toString(16)}`, count: 2, order: 1 });
    assert.equal(d.stackFaultFirst, undefined);
    assert.equal(d.nanStoreFirst, undefined, 'the NaNs were popped, never stored');
    // fld st0 on an empty stack; fstp st0; hlt: the stack fault, its indefinite no NaN made.
    const empty = machine({ precise: true });
    empty.write(CODE, [0xd9, 0xc0, 0xdd, 0xd8, 0xf4]);
    new DataView(empty.memory.buffer).setUint32(empty.layout.eip, CODE, true);
    await runToHalt(empty);
    assert.deepEqual(empty.runtime.diagnostics().stackFaultFirst, { eip: `0x${CODE.toString(16)}`,
        count: 1, order: 1, region: `0x${CODE.toString(16)}`, entryTop: 0, empty: '0xff', top: 0 });
    assert.equal(empty.runtime.diagnostics().nanFirst, undefined);
    // fld dword [0x2000] of a quiet NaN; fstp st0; hlt: the load and where it read.
    const loaded = machine({ precise: true });
    loaded.write(CODE, [0xd9, 0x05, 0x00, 0x20, 0, 0, 0xdd, 0xd8, 0xf4]);
    loaded.write(0x2000, [0, 0, 0xc0, 0x7f]);
    new DataView(loaded.memory.buffer).setUint32(loaded.layout.eip, CODE, true);
    await runToHalt(loaded);
    assert.deepEqual(loaded.runtime.diagnostics().nanLoadFirst,
        { eip: `0x${CODE.toString(16)}`, count: 1, order: 1, from: '0x2000' });
    // fld1; fld1; fchs; fyl2x (1 * log2 -1, the host's Math); fstp st0; hlt
    const log = machine({ precise: true });
    log.write(CODE, [0xd9, 0xe8, 0xd9, 0xe8, 0xd9, 0xe0, 0xd9, 0xf1, 0xdd, 0xd8, 0xf4]);
    new DataView(log.memory.buffer).setUint32(log.layout.eip, CODE, true);
    await runToHalt(log);
    assert.deepEqual(log.runtime.diagnostics().nanFirst,
        { eip: `0x${(CODE + 6).toString(16)}`, count: 1, order: 1, a: 1, c: -1 });
    // fld dword [0x2000]; fstp qword [0x2010]; hlt: the store and where it went.
    const stored = machine({ precise: true });
    stored.write(CODE, [0xd9, 0x05, 0x00, 0x20, 0, 0, 0xdd, 0x1d, 0x10, 0x20, 0, 0, 0xf4]);
    stored.write(0x2000, [0, 0, 0xc0, 0x7f]);
    new DataView(stored.memory.buffer).setUint32(stored.layout.eip, CODE, true);
    await runToHalt(stored);
    assert.deepEqual(stored.runtime.diagnostics().nanStoreFirst,
        { eip: `0x${(CODE + 6).toString(16)}`, count: 1, order: 2, to: '0x2010' });
    const loose = machine();
    loose.write(CODE, program);
    new DataView(loose.memory.buffer).setUint32(loose.layout.eip, CODE, true);
    await runToHalt(loose);
    assert.equal(loose.runtime.diagnostics().nanFirst, undefined);
});

test('a rep movs over several pages of translated code drops every page\'s regions, not only '
    + 'the last one it wrote', async()=>{
    for (const precise of [false, true])
    {
        const m = machine({ precise });
        // A countdown loop on each of three pages, each translated: its region is the code
        // a program overwrites, as a compiler of its own does when it compiles again over
        // the code it compiled before.
        const loops = [0x10000, 0x11000, 0x12000];
        for (const at of loops)
        {
            m.write(at + 0x100, COUNTDOWN);
            m.runtime.noteHot(at + 0x100);
        }
        // mov esi, 0x30000; mov edi, 0x10000; mov ecx, 0xc00; cld; rep movsd; hlt -- three
        // pages of new bytes over the three, in one instruction.
        const copier = 0x20000;
        m.write(copier, [0xbe, 0, 0, 3, 0, 0xbf, 0, 0, 1, 0, 0xb9, 0, 0x0c, 0, 0, 0xfc,
            0xf3, 0xa5, 0xf4]);
        m.write(0x30000, new Array(0x3000).fill(0x90));
        m.runtime.noteHot(copier);
        await m.runtime.translatePending();
        for (const at of loops)
        {
            assert.notEqual(m.runtime.entryOf(at + 0x100), -1, `the loop at ${at.toString(16)}`);
        }
        new DataView(m.memory.buffer).setUint32(m.layout.eip, copier, true);
        // The host resumes the copy where an exit leaves it, as the slice loop does.
        for (let turn = 0; turn < 16 && m.eip() < copier + 0x12; turn++)
        {
            const entry = m.runtime.entryOf(m.eip());
            if (entry < 0)
            {
                m.runtime.noteHot(m.eip());
                await m.runtime.translatePending();
            }
            m.runtime.run(m.runtime.entryOf(m.eip()), 1_000_000);
        }
        assert.ok(m.eip() >= copier + 0x12, 'the copy ran to its end');
        assert.equal(m.reg(1), 0);
        for (const at of loops)
        {
            assert.equal(m.runtime.entryOf(at + 0x100), -1,
                `precise ${precise}: the loop at ${at.toString(16)}, overwritten, is dropped`);
        }
    }
});

test('a rep stos that stored into code and runs out of budget on a later page in bulk still '
    + 'drops the code it wrote, the runtime looking at the note at that exit', async()=>{
    const m = machine();
    // A countdown loop translated at 0x10100; the copy starts on it and goes on through
    // three plain pages, where it runs in bulk.
    m.write(0x10100, COUNTDOWN);
    m.runtime.noteHot(0x10100);
    // mov edi, 0x10100; mov ecx, 0xfc0; xor eax, eax; cld; rep stosd; hlt
    const copier = 0x20000;
    m.write(copier, [0xbf, 0, 1, 1, 0, 0xb9, 0xc0, 0x0f, 0, 0, 0x31, 0xc0, 0xfc, 0xf3, 0xab,
        0xf4]);
    m.runtime.noteHot(copier);
    await m.runtime.translatePending();
    assert.notEqual(m.runtime.entryOf(0x10100), -1);
    new DataView(m.memory.buffer).setUint32(m.layout.eip, copier, true);
    // Enough for the elements on the loop's page one at a time, not for the bulk after.
    const first = m.runtime.run(m.runtime.entryOf(copier), 960 + 40);
    assert.equal(first.kind, 'budget', 'the budget ran out in the bulk part');
    assert.ok(m.reg(1) > 0 && m.reg(7) > 0x11000, 'past the loop\'s page, the copy not done');
    for (let turn = 0; turn < 8 && m.reg(1) !== 0; turn++)
    {
        if (m.runtime.entryOf(m.eip()) < 0)
        {
            m.runtime.noteHot(m.eip());
            await m.runtime.translatePending();
        }
        m.runtime.run(m.runtime.entryOf(m.eip()), 1_000_000);
    }
    assert.equal(m.reg(1), 0, 'the copy finished');
    assert.equal(m.runtime.entryOf(0x10100), -1, 'the loop it overwrote is dropped');
});
