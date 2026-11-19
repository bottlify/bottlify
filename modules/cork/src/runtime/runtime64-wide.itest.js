/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the wide window (`wideLayout`): long-mode code translated over
 * an 8 or 16 GiB window, its RAM a `memory64` memory of its own, runs the
 * hardware corpus as the long-mode interpreter does over the same window --
 * with the data the cases read and write, and the registers pointing into it,
 * past 4 GiB, where every access takes its address's high half; and with the
 * code there too, in the code block from 4 GiB (`codeBase`), as a 64-bit image
 * without relocations is at 0x140000000: return addresses, indirect targets,
 * switches and RIP-relative operands the block's.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CALLS, CORPUS, FAR_SWITCH, HOISTED_SWITCHES, MASKED_SWITCHES, SWITCHES, compare,
    flagsLeftUndefined, load, machine, nested, pool, program, run,
} from '../testing/long-machine.js';
import { ifRoom } from '../testing/memory64.js';

// 8 GiB: a 16 GiB window's code differs by its bits alone, and two of its memories in
// each process beside the suite's others are more than a machine of 16 GB commits.
for (const [window, high] of /** @type {const} */ ([[2 ** 33, 0], [2 ** 33, 2 ** 32]]))
{
    test(`a ${window / 2 ** 30} GiB window, the data ${high / 2 ** 30} GiB past its place:`
        + ' translated as interpreted', ifRoom(()=>{
        const { failures, exits, stats } = compare(CORPUS.cases, { budget: 7, window, high });
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(exits > CORPUS.cases.length * 0.9, `${exits} cases ran to their exit`);
        assert.ok(stats.translated > stats.interpreted * 4, JSON.stringify(stats));
    }));
}

test('outside precise, as a program runs - reads untested, the stack loose - the corpus\'s cases'
    + ' that run to their end run over the window as interpreted', ifRoom(()=>{
    // As long mode's own gate has it (runtime64.itest.js): a read left untested reads
    // RAM where the interpreter faults, so the cases it faults on are another answer by
    // design, and the flags a case leaves undefined the emitter's to leave as it will.
    for (const placed of [{ high: 0 }, { high: 2 ** 32 }, { high: 2 ** 32, codeHigh: 2 ** 32 }])
    {
        const interpreter = machine({ window: 2 ** 33, ...placed });
        const bytes = new Uint8Array(/** @type {WebAssembly.Memory} */ (interpreter.ram).buffer);
        const clean = CORPUS.cases.flatMap((/** @type {any} */ one)=>{
            load(interpreter, one);
            const undefinedFlags = flagsLeftUndefined(interpreter.state, address=>bytes[address]);
            load(interpreter, one);
            return undefinedFlags !== null && run(interpreter, false).fault === 'exit'
                ? [{ ...one, undefinedFlags }] : [];
        });
        assert.ok(clean.length > CORPUS.cases.length * 0.8, `${clean.length} cases`);
        const { failures, exits, stats } = compare(clean, { budget: 7, window: 2 ** 33,
            config: { precise: false }, ...placed });
        assert.deepEqual(failures.slice(0, 20), [],
            `${JSON.stringify(placed)}: ${failures.length} differences`);
        assert.equal(exits, clean.length);
        assert.ok(stats.translated > stats.interpreted * 4, JSON.stringify(stats));
    }
}));

/** The placement of a 64-bit image at 0x140000000: code and data in the block from 4 GiB. */
const PAST = { window: 2 ** 33, high: 2 ** 32, codeHigh: 2 ** 32 };

test('code past 4 GiB: the corpus translated as interpreted', ifRoom(()=>{
    const { failures, exits, stats } = compare(CORPUS.cases, { budget: 7, ...PAST });
    assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
    assert.ok(exits > CORPUS.cases.length * 0.9, `${exits} cases ran to their exit`);
    assert.ok(stats.translated > stats.interpreted * 4, JSON.stringify(stats));
}));

test('code past 4 GiB: calls, returns and switches as interpreted', ifRoom(()=>{
    /** @param {any} one @param {number} i @param {string} name @param {string} code */
    const variant = (one, i, name, code)=>{
        const regs = [...one.regs];
        regs[10] = i % 2 === 0 ? '0' : '1';
        return { ...one, text: `${name} ${i}`, code, regs };
    };
    const cases = [...Object.entries(CALLS), ['switches', SWITCHES],
        ['hoisted', HOISTED_SWITCHES], ['masked', MASKED_SWITCHES], ['far', FAR_SWITCH]]
        .flatMap(([name, code])=>CORPUS.cases.slice(0, 4)
            .map((/** @type {any} */ one, /** @type {number} */ i)=>variant(one, i, name, code)));
    for (const budget of [7, 100000])
    {
        const { failures, stats } = compare(cases, { budget, ...PAST });
        assert.deepEqual(failures.slice(0, 20), [], `budget ${budget}`);
        assert.ok(stats.translated > stats.interpreted, JSON.stringify(stats));
    }
}));

test('code past 4 GiB: seeded programs and loops as interpreted', ifRoom(()=>{
    const instructions = pool();
    const straight = Array.from({ length: 200 },
        (_, i)=>program(instructions, 0x7eed + i, 20 + i % 60));
    const loops = Array.from({ length: 150 }, (_, i)=>nested(instructions, 0x2005 + i));
    for (const [cases, budget] of /** @type {const} */ ([[straight, 7], [loops, 1000]]))
    {
        const { failures, stats } = compare(cases, { budget, ...PAST });
        assert.deepEqual(failures.slice(0, 20), [], `${failures.length} differences`);
        assert.ok(stats.translated > stats.interpreted, JSON.stringify(stats));
    }
}));

test('the interpreter tier in wasm runs translated code\'s misses in place over the window,'
    + ' as interpreted', ifRoom(()=>{
    // As long mode's own gate has it (runtime64.itest.js): every start hot at once and
    // formed where it is first met, so a miss is a target the runtime has not formed
    // yet, which the tier takes from inside the region - its RAM the window's memory.
    const cases = [...CORPUS.cases,
        ...Object.values(CALLS).flatMap(code=>CORPUS.cases.slice(0, 2)
            .map((/** @type {any} */ one)=>({ ...one, text: 'calls', code })))];
    for (const placed of [{ high: 2 ** 32 }, { high: 2 ** 32, codeHigh: 2 ** 32 }])
    {
        for (const budget of [7, 100000])
        {
            const { failures, stats } = compare(cases, { budget, tiered: true, window: 2 ** 33,
                ...placed });
            assert.deepEqual(failures.slice(0, 20), [],
                `${JSON.stringify(placed)}, budget ${budget}`);
            assert.ok(stats.tiered > cases.length / 2, JSON.stringify(stats));
        }
    }
}));

test('a store through a pointer past 4 GiB, then the stack below it: each access takes its own'
    + ' address\'s high half', ifRoom(()=>{
    // The stack in the code's area, below 4 GiB; rdi in the data's, 4 GiB past its place.
    const regs = [...CORPUS.cases[0].regs];
    regs[4] = (CORPUS.codeAt + CORPUS.codeSize - 0x200).toString(16);
    regs[7] = (CORPUS.dataAt + 0x400).toString(16);
    // lea r8, [rip+exit]; mov [rsp], r8; mov [rsp+0x20], rdi; mov rdx, [rsp+0x20];
    // mov [rdx], eax; then ret - or push rax; mov [rdx], eax; pop rcx; ret.
    // Or a read through it: mov ecx, [rdx]; mov [rsp+8], ecx; ret.
    const cases = [
        '4c8d05110000004c89042448897c2420488b5424208902c3',
        '4c8d05150000004c89042448897c2420488b542420890250890259c3',
        '4c8d05150000004c89042448897c2420488b5424208b0a894c2408c3',
    ].map((code, i)=>({ ...CORPUS.cases[0], text: `high store, stack ${i}`, code, regs }));
    for (const config of [{}, { looseStacks: true }, { precise: false, looseStacks: true }])
    {
        for (const budget of [7, 100000])
        {
            const { failures, exits } = compare(cases, { budget, config, window: 2 ** 33,
                high: 2 ** 32 });
            assert.deepEqual(failures, [], `${JSON.stringify(config)}, budget ${budget}`);
            assert.equal(exits, cases.length);
        }
    }
}));

test('string instructions and a pop into memory, their data past 4 GiB, as interpreted',
    ifRoom(()=>{
    // movsq; movsb; stosd; lodsw; cmpsb; scasb - then mov ecx, 5; rep movsb; and
    // push rax; pop [rdi]: two pointers a step, each past 4 GiB.
        const cases = ['48a5a4ab66ada6ae', 'b905000000f3a4', '508f07']
            .map((code, i)=>({ ...CORPUS.cases[0], text: `strings past 4 GiB ${i}`, code }));
        for (const config of [{ precise: false }, {}])
        {
            for (const budget of [7, 100000])
            {
                const { failures, exits } = compare(cases, { budget, config, window: 2 ** 33,
                    high: 2 ** 32 });
                assert.deepEqual(failures, [], `${JSON.stringify(config)}, budget ${budget}`);
                assert.equal(exits, cases.length);
            }
        }
    }));

test('a stack across a 4 GiB line of the window: each push and pop at its whole address',
    ifRoom(()=>{
        // The data area from a page below 4 GiB to a page past it, the stack pointer
        // eight bytes past the line: the second push lands below it, where rsp's own
        // high half with the low half less eight is 4 GiB further on.
        const high = 2 ** 32 - CORPUS.dataAt - 0x1000;
        const regs = [...CORPUS.cases[0].regs];
        regs[4] = (CORPUS.dataAt + 0x1008).toString(16);
        // push rax; push rbx; pop rcx; pop rdx - then with a read below the line between,
        // mov eax, [rsp-0xc], one across it, mov eax, [rsp-0xa], and a push of the
        // quadword at rsp, push [rsp]; pop r10.
        const cases = ['5053595a', '50538b4424f4595a', '50538b4424f6595a', '5053ff3424415a595a']
            .map((code, i)=>({ ...CORPUS.cases[0], text: `stack across the line ${i}`, code,
                regs }));
        for (const config of [{ precise: false }, { precise: false, looseStacks: false }, {}])
        {
            for (const budget of [7, 100000])
            {
                const { failures, exits } = compare(cases, { budget, config, window: 2 ** 33,
                    high });
                assert.deepEqual(failures, [], `${JSON.stringify(config)}, budget ${budget}`);
                assert.equal(exits, cases.length);
            }
        }
    }));
