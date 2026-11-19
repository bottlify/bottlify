/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The interpreter tier in wasm over a wide window (`interp-wasm.c` built with
 * LONG and WIDE, the guest's RAM its second memory), judged by `interp64.js`
 * over the same window: the hardware corpus, calls and switches, seeded
 * programs and loops, strings and stacks, run on the tier alone -- no
 * translator, `interp64.js` taking only the instructions the tier leaves --
 * with the data and the code where a 4 GiB layout has them, with the data
 * past 4 GiB, and with both there, in the code block from 4 GiB. Everything a
 * program can see is compared (`long-machine.js`'s `compare`). And directed
 * cases for what the window changes in how a run ends: an address is a
 * quadword whole, and the hash, the hot counts and the ring know code by its
 * offset in the code block.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { interpret64 } from './interp64.js';
import { HOT_SLOTS, WasmExit } from './interp-wasm.js';
import { SOURCE_SHA256 } from './interp-wasm-wide.bytes.js';
import { Tables } from './runtime/layout.js';
import { createPageTable } from './runtime/pages.js';
import {
    CALLS, CORPUS, FAR_SWITCH, HOISTED_SWITCHES, MASKED_SWITCHES, SWITCHES, compare, load,
    loopCases, machine, nested, pool, program,
} from './testing/long-machine.js';
import { ifRoom } from './testing/memory64.js';

const WINDOW = 2 ** 33;
/** Where the areas lie: as in 4 GiB, the data past it, and both there (an image at
 * 0x140000000). */
const PLACES = [{ high: 0, codeHigh: 0 }, { high: 2 ** 32, codeHigh: 0 },
    { high: 2 ** 32, codeHigh: 2 ** 32 }];

/**
 * A runner that is the tier alone: each run the tier's, and an instruction it
 * leaves -- one it does not run, a fault, the exit's fetch -- `interp64.js`'s,
 * which faults as the reference does; `handed` counts those that did not fault.
 *
 * @type {import('./testing/long-machine.js').MakeRunner}
 */
const tierAlone = (memory, layout, tier)=>{
    const stats = { tier: 0, handed: 0 };
    return {
        stats,
        tier,
        /** @param {any} state @param {number} budget */
        run(state, budget){
            state.syncOut();
            const code = tier.run(budget);
            const ran = tier.retired();
            stats.tier += ran;
            state.syncIn();
            state.retired += ran;
            if (code === WasmExit.HALT)
            {
                state.halted = true;
            }
            else if (code === WasmExit.TRAP)
            {
                state.trapped.push(tier.exitValue());
            }
            else if (code === WasmExit.FAULT || code === WasmExit.UNSUPPORTED)
            {
                stats.handed += interpret64(state, 1, { force: true, shouldStop: ()=>true });
            }
            state.syncOut();
        },
        invalidate(){},
        noteStack(){},
        readsFaulted(){},
    };
};

/**
 * @param {any[]} cases @param {number} budget @param {{ high: number, codeHigh: number }} place
 */
function judged(cases, budget, place){
    const { failures, exits, stats } = compare(cases, { budget, tiered: true,
        makeRunner: tierAlone, window: WINDOW, ...place });
    assert.deepEqual(failures.slice(0, 20), [],
        `${JSON.stringify(place)}, budget ${budget}: ${failures.length} differences`);
    return { exits, stats: /** @type {{ tier: number, handed: number }} */ (stats) };
}

test('the module is built from the source beside it', ()=>{
    const source = readFileSync(new URL('./interp-wasm.c', import.meta.url), 'utf8')
        .replaceAll('\r\n', '\n');
    assert.equal(createHash('sha256').update(source).digest('hex'), SOURCE_SHA256,
        'interp-wasm.c changed: run scripts/build-interp-wasm.mjs');
});

for (const place of PLACES)
{
    const where = `data ${place.high / 2 ** 30} GiB and code ${place.codeHigh / 2 ** 30} GiB`
        + ' past their places';
    test(`the corpus on the tier over a wide window as on interp64.js: ${where}`, ifRoom(()=>{
        for (const budget of [7, 100000])
        {
            const { exits, stats } = judged(CORPUS.cases, budget, place);
            assert.ok(exits > CORPUS.cases.length * 0.9, `${exits} cases ran to their exit`);
            // The cases are the tier's own: one that faulted every access it could not
            // reach would hand them all to the reference, which reaches them.
            assert.ok(stats.tier > CORPUS.cases.length * 3 && stats.handed * 100 < stats.tier,
                JSON.stringify(stats));
        }
    }));

    test(`calls, switches, loops and seeded programs on the tier: ${where}`, ifRoom(()=>{
        const instructions = pool();
        const programs = [
            ...[...Object.entries(CALLS), ['switches', SWITCHES], ['hoisted', HOISTED_SWITCHES],
                ['masked', MASKED_SWITCHES], ['far', FAR_SWITCH]]
                .flatMap(([name, code])=>CORPUS.cases.slice(0, 4).map((/** @type {any} */ one,
                    /** @type {number} */ i)=>({ ...one, text: `${name} ${i}`, code,
                    regs: one.regs.map((/** @type {string} */ value, /** @type {number} */ r)=>(
                        r === 10 ? String(i % 2) : value)) }))),
            ...loopCases(),
            ...Array.from({ length: 200 }, (_, i)=>program(instructions, 0x7eed + i, 20 + i % 60)),
            ...Array.from({ length: 150 }, (_, i)=>nested(instructions, 0x2005 + i)),
        ];
        for (const budget of [7, 100000])
        {
            const { stats } = judged(programs, budget, place);
            assert.ok(stats.tier > stats.handed * 4, JSON.stringify(stats));
        }
    }));
}

test('strings, a pop into memory and a stack across a 4 GiB line of the window on the tier',
    ifRoom(()=>{
        // movsq; movsb; stosd; lodsw; cmpsb; scasb - mov ecx, 5; rep movsb - a page's
        // rep stosq and rep movsb done at once - push rax; pop [rdi].
        const strings = ['48a5a4ab66ada6ae', 'b905000000f3a4', 'b900010000f348ab',
            'b900030000f3a4', '508f07'].map((code, i)=>({ ...CORPUS.cases[0],
            text: `strings past 4 GiB ${i}`, code }));
        for (const budget of [7, 100000])
        {
            const { exits, stats } = judged(strings, budget, { high: 2 ** 32, codeHigh: 0 });
            assert.equal(exits, strings.length);
            assert.equal(stats.handed, 0);
        }
        // The data from a page below 4 GiB to a page past it, rsp eight bytes past the
        // line: push rax; push rbx; pop rcx; pop rdx - with reads below and across the
        // line between - and a push of the quadword at rsp.
        const regs = [...CORPUS.cases[0].regs];
        regs[4] = (CORPUS.dataAt + 0x1008).toString(16);
        const stacks = ['5053595a', '50538b4424f4595a', '50538b4424f6595a', '5053ff3424415a595a']
            .map((code, i)=>({ ...CORPUS.cases[0], text: `stack across the line ${i}`, code,
                regs }));
        for (const budget of [7, 100000])
        {
            const { exits, stats } = judged(stacks, budget,
                { high: 2 ** 32 - CORPUS.dataAt - 0x1000, codeHigh: 0 });
            assert.equal(exits, stacks.length);
            assert.equal(stats.handed, 0);
        }
    }));

/**
 * A machine with `code` in the code area, 4 GiB past its place, the data there
 * too, and the registers given (the others zero), rsp at the data's top.
 *
 * @param {number[]} code @param {Record<number, bigint>} [regs]
 */
function directed(code, regs = {}){
    const m = machine({ window: WINDOW, high: 2 ** 32, codeHigh: 2 ** 32, tiered: true,
        makeRunner: tierAlone });
    const registers = Array.from({ length: 16 }, (_, i)=>(regs[i] ?? 0n).toString(16));
    registers[4] = (CORPUS.dataAt + 0x1f00).toString(16);
    load(m, { code: Buffer.from(code).toString('hex'), regs: registers, flags: 0, seed: 1 });
    const tier = /** @type {import('../../core/src/layers/cpu/engine.js').WasmInterpreter} */ (
        /** @type {any} */ (m.runner).tier);
    tier.hotCounts.fill(0);
    return { ...m, tier, rip: ()=>Number(m.view.getBigUint64(m.layout.eip, true)),
        /** @param {number} i */
        reg: i=>m.view.getBigUint64(m.layout.regs + i * 8, true) };
}
const CODE = CORPUS.codeAt + 2 ** 32;
const DATA = CORPUS.dataAt + 2 ** 32;

test('an address is a quadword whole: what 4 GiB wraps or faults is read where it is', ifRoom(()=>{
    // mov rcx, [rax]; hlt -- rax in the data past 4 GiB; its low half alone is closed.
    const m = directed([0x48, 0x8b, 0x08, 0xf4], { 0: BigInt(DATA + 0x100) });
    const ram = new DataView(/** @type {WebAssembly.Memory} */ (m.ram).buffer);
    ram.setBigUint64(DATA + 0x100, 0x1122334455667788n, true);
    assert.equal(m.tier.run(100), WasmExit.HALT);
    assert.equal(m.reg(1), 0x1122334455667788n);
    assert.equal(m.rip(), CODE + 4);
    // The same address less 4 GiB is no data here: a fault, nothing read.
    const low = directed([0x48, 0x8b, 0x08, 0xf4]);
    low.view.setBigUint64(low.layout.regs, BigInt(CORPUS.dataAt + 0x100), true);
    assert.equal(low.tier.run(100), WasmExit.FAULT);
    assert.equal(low.tier.exitValue(), 13);
    assert.equal(low.rip(), CODE);
    // A quadword that crosses the window's end, and code past it.
    const crossing = directed([0x48, 0x8b, 0x08, 0xf4], { 0: BigInt(WINDOW - 4) });
    assert.equal(crossing.tier.run(100), WasmExit.FAULT);
    const jump = directed([0xff, 0xe0], { 0: BigInt(WINDOW + CORPUS.codeAt) });
    assert.equal(jump.tier.run(100), WasmExit.UNSUPPORTED);
    assert.equal(jump.rip(), WINDOW + CORPUS.codeAt);
    // add qword [rip + 1], 1; hlt; then the quadword: RIP-relative from the whole RIP.
    const add = directed([0x48, 0x83, 0x05, 1, 0, 0, 0, 0x01, 0xf4, 41, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(add.tier.run(100), WasmExit.HALT);
    assert.equal(new DataView(/** @type {WebAssembly.Memory} */ (add.ram).buffer)
        .getBigUint64(CODE + 9, true), 42n);
    // movss xmm0, [rip + 1]; hlt; then the dword: the same in a helper, which takes
    // the instruction's place from where its bytes were fetched.
    const movss = directed([0xf3, 0x0f, 0x10, 0x05, 1, 0, 0, 0, 0xf4, 0x78, 0x56, 0x34, 0x12]);
    assert.equal(movss.tier.run(100), WasmExit.HALT);
    assert.equal(movss.view.getUint32(movss.layout.xmm, true), 0x12345678);
}));

test('a store into translated code past 4 GiB names the whole address it landed at', ifRoom(()=>{
    // mov [rbx+8], rax; mov [rbx+0x40], rax; hlt -- the page's code is at 0x40..0x5f.
    const m = directed([0x48, 0x89, 0x43, 0x08, 0x48, 0x89, 0x43, 0x40, 0xf4],
        { 3: BigInt(DATA) });
    createPageTable(m.memory, m.layout).markCode(DATA + 0x40, 0x20);
    assert.equal(m.tier.run(100), WasmExit.CODE_WRITE);
    assert.equal(m.tier.retired(), 2);
    assert.equal(m.tier.exitValue(), DATA + 0x40);
    assert.equal(m.tier.exitSize(), 8);
    assert.equal(m.rip(), CODE + 8);
    // What the next run leaves by is its own: a halt's value has no high half.
    assert.equal(m.tier.run(100), WasmExit.HALT);
    assert.ok(m.tier.exitValue() < 2 ** 32);
}));

test('a jump\'s target in the code block is counted and found by its offset there', ifRoom(()=>{
    // mov ecx, 40; L: dec rcx; jnz L; hlt
    const m = directed([0xb9, 40, 0, 0, 0, 0x48, 0xff, 0xc9, 0x75, 0xfb, 0xf4]);
    /** @type {number[]} */
    const noted = [];
    for (;;)
    {
        const code = m.tier.run(1000);
        if (code !== WasmExit.HOT)
        {
            assert.equal(code, WasmExit.HALT);
            break;
        }
        assert.equal(m.rip(), CODE + 5);
        noted.push(m.tier.exitValue());
    }
    // The machine's tier notes a start at its first visit and at every power of two.
    assert.deepEqual(noted, [1, 2, 4, 8, 16, 32]);
    const offset = CORPUS.codeAt + 5;
    assert.equal(m.tier.hotCounts[(offset >>> 2) & (HOT_SLOTS - 1)], 39);
    assert.equal(m.tier.starts[(m.tier.startIndex() - 1) & 255], offset);
    // jmp +2; nop; nop; mov eax, 3; hlt -- the target's offset has an entry.
    const entry = directed([0xeb, 0x02, 0x90, 0x90, 0xb8, 3, 0, 0, 0, 0xf4]);
    const target = CORPUS.codeAt + 4;
    const slot = Math.imul(target, 0x9e3779b1) >>> (entry.layout.hashShift ?? 16);
    entry.view.setUint32(entry.layout.tables + Tables.HASH + slot * Tables.HASH_SLOT, target,
        true);
    /** Neither start at a count that is noted hot: what a run does next is the hash's. */
    const lukewarm = ()=>{
        entry.tier.hotCounts[(CORPUS.codeAt >>> 2) & (HOT_SLOTS - 1)] = 4;
        entry.tier.hotCounts[(target >>> 2) & (HOT_SLOTS - 1)] = 4;
    };
    lukewarm();
    assert.equal(entry.tier.run(100), WasmExit.ENTRY);
    assert.equal(entry.rip(), CODE + 4);
    // The entry translated code calls: the same from the start, the jump retired; a
    // start past the window is no tier's.
    const enter = entry.tier.entry();
    entry.view.setBigUint64(entry.layout.eip, BigInt(CODE), true);
    lukewarm();
    entry.view.setUint32(entry.layout.counter, 100, true);
    assert.equal(enter(1000), WasmExit.ENTRY | 1 << 8);
    assert.equal(entry.rip(), CODE + 4);
    assert.equal(entry.view.getUint32(entry.layout.counter, true), 101);
    entry.view.setBigUint64(entry.layout.eip, BigInt(WINDOW + CORPUS.codeAt), true);
    assert.equal(enter(1000), 0);
    // The same code 4 GiB below the block is not the block's: no entry is found for
    // it, nor is it counted.
    const below = directed([0xeb, 0x02, 0x90, 0x90, 0xb8, 3, 0, 0, 0, 0xf4]);
    const lowCode = new Uint8Array(/** @type {WebAssembly.Memory} */ (below.ram).buffer);
    lowCode.copyWithin(CORPUS.dataAt, CODE, CODE + 16);
    below.view.setUint32(below.layout.tables + Tables.HASH
        + (Math.imul(CORPUS.dataAt + 4, 0x9e3779b1) >>> (below.layout.hashShift ?? 16))
        * Tables.HASH_SLOT, CORPUS.dataAt + 4, true);
    // The data's place 4 GiB below, open for this.
    createPageTable(below.memory, below.layout).clearRange(CORPUS.dataAt, 4096, 0xff);
    below.view.setBigUint64(below.layout.eip, BigInt(CORPUS.dataAt), true);
    assert.equal(below.tier.run(100), WasmExit.HALT);
    assert.equal(below.reg(0), 3n);
    assert.ok(below.tier.hotCounts.every(count=>count === 0));
}));
