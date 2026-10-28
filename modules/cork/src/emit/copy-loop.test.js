/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The byte copy loop run whole (`emitCopyAtOnce` in copy-loop.js) beside the
 * interpreter: seeded programs of `movs; cmp; jne` loops -- bytes, words and
 * doublewords, either compare order, esi or edi compared, runs of one element
 * to past the limit, a destination 16 bytes behind to 16 ahead of its source
 * (the 1 to 7 ahead a byte loop reads back), DF set, a destination on the
 * immediate of a function the program calls or on a watched page, a source
 * running into a page it may not read, a run with DF set and its end ahead, a
 * run of three pages whose middle one it may not read, a run that is not a
 * whole number of elements, budgets that end a region's run part way -- each
 * run both ways, and the two must leave the same memory, registers, flags
 * after every loop, instruction count and way of stopping.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';
import { copyLoopOf } from './copy-loop.js';
import { PageFlag } from '../runtime/pages.js';

const CODE = 0x401000;
const DATA = 0x500000;
const LOG = 0x510000;
const STACK = 0xf00000;
const RAM = 16 << 20;
/** A page the program may not touch, and one under a write watch. */
const GUARD = DATA + 0xa000;
const WATCHED = DATA + 0x9000;
/** A function the program calls after every copy, `mov eax, imm32; ret`, whose immediate some copies overwrite. */
const FUNC = CODE + 0xc00;
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags'];
const DISTANCES = [-16, -9, -8, -7, -1, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 64];

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/**
 * A program of copy loops run twenty times, so they are translated, each
 * copying a run that grows with the round (ebx), its flags, esi and edi
 * logged after it.
 *
 * @param {number} seed
 * @returns {number[]}
 */
function generate(seed){
    let state = seed >>> 0;
    /** @param {number} n */
    const pick = n=>{
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) % n;
    };
    // mov ebx, 20; outer:
    const code = [0xbb, ...le(20)];
    const outer = code.length;
    const sites = 2 + pick(4);
    for (let k = 0; k < sites; k++)
    {
        const way = pick(14);
        const patch = way === 0;
        // DF set with the end ahead, which the loop never meets going down: it
        // runs into the guard page below it.
        const wrongWay = way === 12;
        // A run of three pages whose middle one is the guard.
        const across = way === 13;
        const size = patch ? 1 : across ? 4 : [1, 1, 2, 4][pick(4)];
        const backward = !patch && !across && !wrongWay && pick(10) === 0;
        // A run that is not a whole number of elements is never met: the loop
        // runs on to RAM's end and faults there.
        const misaligned = size > 1 && !backward && !across && !wrongWay && pick(10) === 0;
        let source = DATA + 0x2000 + pick(64);
        let target = patch ? FUNC + 1 + pick(2)
            : way === 1 ? WATCHED + pick(64)
                : way < 5 ? source + DISTANCES[pick(DISTANCES.length)]
                    : DATA + 0x6000 + pick(64);
        if (misaligned)
        {
            source = GUARD - 0x400;
        }
        else if (wrongWay)
        {
            source = GUARD + 0x1000 + 0x80 + pick(64);
            target = DATA + 0x6000 + pick(64);
        }
        else if (across)
        {
            source = GUARD - 0x1800;
            target = DATA + 0x2000;
        }
        else if (pick(25) === 0)
        {
            source = GUARD - 64 + pick(32); // runs into the guard page: the loop faults
        }
        if (backward)
        {
            target += 0x1800;
            source += 0x1800;
        }
        // Elements: a base and a step a round; now and then past the limit.
        const base = patch ? 1 + pick(2) : across ? 0xc00
            : pick(15) === 0 ? 1030 + pick(20) : 1 + pick(20);
        const step = patch || across ? 0 : pick(3);
        const useEsi = pick(4) === 0;
        const end = [0, 1, 2, 5][pick(4)]; // eax, ecx, edx, ebp
        // mov esi, source; mov edi, target
        code.push(0xbe, ...le(source), 0xbf, ...le(target));
        // mov end, ebx; imul end, end, step * size; add end, base * size
        code.push(0x89, 0xc0 | 3 << 3 | end);
        code.push(0x69, 0xc0 | end << 3 | end, ...le(step * size));
        code.push(0x81, 0xc0 | end, ...le(base * size + (misaligned ? 1 : 0)));
        if (backward)
        {
            code.push(0xf7, 0xd8 | end, 0xfd); // neg end; std
        }
        else if (wrongWay)
        {
            code.push(0xfd); // std
        }
        // add end, esi / edi
        code.push(0x01, 0xc0 | (useEsi ? 6 : 7) << 3 | end);
        // loop: movs; cmp; jne loop
        const loop = code.length;
        code.push(...size === 1 ? [0xa4] : size === 2 ? [0x66, 0xa5] : [0xa5]);
        const pointer = useEsi ? 6 : 7;
        code.push(0x39, pick(2) ? 0xc0 | end << 3 | pointer : 0xc0 | pointer << 3 | end);
        code.push(0x75, (loop - (code.length + 2)) & 0xff);
        // cld; lahf; seto al; mov [log], eax; mov [log + 4], esi; mov [log + 8], edi
        code.push(0xfc, 0x9f, 0x0f, 0x90, 0xc0, 0xa3, ...le(LOG + k * 16));
        code.push(0x89, 0x35, ...le(LOG + k * 16 + 4), 0x89, 0x3d, ...le(LOG + k * 16 + 8));
        // call FUNC; mov [log + 12], eax
        code.push(0xe8, ...le(FUNC - (CODE + code.length + 5)), 0xa3, ...le(LOG + k * 16 + 12));
    }
    // dec ebx; jnz outer; hlt
    code.push(0x4b, 0x0f, 0x85, ...le(outer - (code.length + 7)), 0xf4);
    return code;
}

/**
 * @param {number[]} code @param {number} seed @param {Record<string, unknown>} config
 */
async function runProgram(code, seed, config, maxInstructions = 4_000_000){
    const m = createMachine({ ramSize: RAM, config: { hotThreshold: 2, ...config } });
    try
    {
        m.load(CODE, code);
        m.load(FUNC, [0xb8, ...le(0x12345678), 0xc3]);
        m.load(DATA, Array.from({ length: 0xa000 }, (_, i)=>(i * 37 + seed) & 0xff));
        m.runtime.pages.markRange(GUARD, 0x1000, PageFlag.INACCESSIBLE);
        m.runtime.pages.markRange(WATCHED, 0x1000, PageFlag.WATCH);
        m.setReg('esp', STACK);
        m.setReg('eip', CODE);
        const stop = await m.run({ maxInstructions });
        const registers = Object.fromEntries(REGISTERS.map(name=>[name, m.reg(name)]));
        if (stop.reason === 'fault')
        {
            // At a fault inside the hoisted loop the flags word answers what
            // the interpreter's does not (before this change too); the flags
            // after every loop that ran to its end are in the log.
            delete registers.eflags;
        }
        return {
            stop: { reason: stop.reason, vector: stop.vector, retired: stop.retired },
            data: [...m.read(DATA, 0xa000)],
            code: [...m.read(FUNC, 6)],
            watched: m.runtime.pages.get(WATCHED >>> 12) & (PageFlag.WATCH | PageFlag.WRITTEN),
            log: [...m.read(LOG, 0x60)],
            registers,
            translated: stop.translated,
        };
    }
    finally
    {
        m.dispose();
    }
}

test('a copy loop run whole leaves what the interpreter leaves', async()=>{
    let faults = 0;
    let translated = 0;
    for (let seed = 1; seed <= 160; seed++)
    {
        const code = generate(seed * 7919);
        const chunk = seed % 2 === 0 ? {} : { yieldChunk: 50 + seed * 7 % 400 };
        const interpreted = await runProgram(code, seed, { translate: false, ...chunk });
        const ran = await runProgram(code, seed, chunk);
        assert.deepEqual({ ...ran, translated: 0 }, interpreted, `seed ${seed}`);
        faults += interpreted.stop.reason === 'fault' ? 1 : 0;
        translated += ran.translated > 0 ? 1 : 0;
    }
    assert.ok(faults > 5, `${faults} programs end at a fault`);
    assert.ok(translated > 120, `${translated} programs ran translated code`);
});

test('a budget that runs out part way through a copy stops the run where the loop would', async()=>{
    // A region's run ends at the first back edge past its budget, so it may
    // retire up to a block more than it was given (this program's longest is
    // 16 instructions, before this change too) -- never a copy's worth.
    let stopped = 0;
    for (let seed = 1; seed <= 60; seed++)
    {
        const code = generate(seed * 7919);
        const limit = 300 + seed * 137 % 2_500;
        const ran = await runProgram(code, seed, {}, limit);
        if (ran.stop.reason === 'limit')
        {
            stopped++;
            assert.ok(ran.stop.retired >= limit && ran.stop.retired - limit < 20,
                `seed ${seed}: ${ran.stop.retired} retired for ${limit}`);
        }
    }
    assert.ok(stopped > 30, `${stopped} runs stopped at their limit`);
});

test('only the movs; cmp; jne loop onto itself is a copy loop', ()=>{
    const block = (/** @type {any[]} */ instructions, kind = 'jcc', targets = [0x10, 0x14])=>
        /** @type {any} */ ({ start: 0x10, instructions, exit: { kind, targets } });
    const movs = { op: 'movs', size: 1, prefixes: { rep: false, repne: false, lock: false,
        address: false, segment: -1 } };
    const cmp = (/** @type {number} */ a, /** @type {number} */ c)=>({ op: 'cmp',
        operands: [{ kind: 'reg', reg: a, size: 4 }, { kind: 'reg', reg: c, size: 4 }] });
    const jne = { op: 'jne', cc: 5 };
    assert.deepEqual(copyLoopOf(block([movs, cmp(7, 0), jne])), { size: 1, pointer: 7, end: 0 });
    assert.deepEqual(copyLoopOf(block([movs, cmp(1, 6), jne])), { size: 1, pointer: 6, end: 1 });
    assert.equal(copyLoopOf(block([movs, cmp(7, 6), jne])), null);
    assert.equal(copyLoopOf(block([movs, cmp(7, 4), jne])), null);
    assert.equal(copyLoopOf(block([movs, cmp(7, 0), jne], 'jcc', [0x20, 0x14])), null);
    assert.equal(copyLoopOf(block([{ ...movs, prefixes: { ...movs.prefixes, rep: true } },
        cmp(7, 0), jne])), null);
    assert.equal(copyLoopOf(block([{ ...movs, op: 'stos' }, cmp(7, 0), jne])), null);
    assert.equal(copyLoopOf(block([movs, cmp(7, 0), { op: 'jb', cc: 2 }])), null);
});
