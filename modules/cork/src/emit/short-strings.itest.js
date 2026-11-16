/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A `rep movs` or `rep stos` of a count its block set, made in place
 * (`shortString` in integer.js), beside the interpreter: seeded programs of
 * `mov ecx, n; rep movs` and `rep stos` sites -- bytes, words and doublewords,
 * counts of one element to past the path's limit, a destination 16 bytes
 * behind to 64 ahead of its source (the 1 to 7 ahead a copy reads back), runs
 * across a page's end, DF set, a destination on the immediate of a function
 * the program calls or on a watched page, a source or a destination on a page
 * it may not touch, slices that end part way -- each run both ways, and the
 * two must leave the same memory, registers, flags and way of stopping. The
 * instructions retired are not compared: the interpreter counts a `rep` as
 * one, a region each turn of it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';
import { PageFlag } from '../runtime/pages.js';

const CODE = 0x401000;
const DATA = 0x500000;
const LOG = 0x510000;
const STACK = 0xf00000;
const RAM = 16 << 20;
/** A page the program may not touch, and one under a write watch. */
const GUARD = DATA + 0xa000;
const WATCHED = DATA + 0x9000;
/** A function the program calls after every site, `mov eax, imm32; ret`, whose immediate some overwrite. */
const FUNC = CODE + 0xc00;
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags'];
const DISTANCES = [-16, -9, -8, -4, -1, 1, 2, 3, 4, 5, 7, 8, 9, 15, 16, 64];

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/**
 * A program of sites run twenty times, so they are translated, each site's
 * registers logged after it.
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
        const way = pick(16);
        const fill = pick(3) === 0;
        // Over the function's immediate only its bytes: a byte or two.
        const size = way === 0 ? 1 : [1, 2, 4, 4][pick(4)];
        // Mostly few elements; now and then past what is made in place.
        const count = way === 0 ? 1 + pick(2)
            : pick(12) === 0 ? 60 + pick(40) : pick(20) === 0 ? 0 : 1 + pick(24);
        const backward = way !== 0 && pick(12) === 0;
        let source = DATA + 0x2000 + pick(64);
        let target = way === 0 ? FUNC + 1 + pick(2)
            : way === 1 ? WATCHED + pick(64)
                : way < 6 ? source + DISTANCES[pick(DISTANCES.length)]
                    : DATA + 0x6000 + pick(64);
        if (way === 6)
        {
            source = DATA + 0x3000 - 8 - pick(24);          // across a page's end
        }
        else if (way === 7)
        {
            target = DATA + 0x7000 - 8 - pick(24);
        }
        else if (way === 8)
        {
            source = GUARD - 16 - pick(32);                 // into the page it may not read
        }
        else if (way === 9)
        {
            target = GUARD - 16 - pick(32);
        }
        // mov esi, source; mov edi, target; mov eax, pattern
        code.push(0xbe, ...le(source), 0xbf, ...le(target));
        code.push(0xb8, ...le(0x11223344 + seed * 0x01010101));
        if (backward)
        {
            code.push(0xfd); // std
        }
        // mov ecx, count; now and then something between that leaves ecx alone
        code.push(0xb9, ...le(count));
        if (pick(3) === 0)
        {
            code.push(0x8d, 0x52, 0x00); // lea edx, [edx]
        }
        code.push(0xf3, ...size === 2 ? [0x66] : [], fill ? (size === 1 ? 0xaa : 0xab)
            : size === 1 ? 0xa4 : 0xa5);
        // cld; mov [log], ecx; mov [log + 4], esi; mov [log + 8], edi
        code.push(0xfc, 0x89, 0x0d, ...le(LOG + k * 16));
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
        return {
            stop: { reason: stop.reason, vector: stop.vector },
            data: [...m.read(DATA, 0xa000)],
            code: [...m.read(FUNC, 6)],
            watched: m.runtime.pages.get(WATCHED >>> 12) & (PageFlag.WATCH | PageFlag.WRITTEN),
            log: [...m.read(LOG, 0x60)],
            registers: Object.fromEntries(REGISTERS.map(name=>[name, m.reg(name)])),
            translated: stop.translated,
        };
    }
    finally
    {
        m.dispose();
    }
}

test('a rep movs or stos of a count its block set leaves what the interpreter leaves', async()=>{
    let faults = 0;
    let translated = 0;
    for (let seed = 1; seed <= 200; seed++)
    {
        const code = generate(seed * 7919);
        const chunk = seed % 2 === 0 ? {} : { yieldChunk: 20 + seed * 7 % 300 };
        const interpreted = await runProgram(code, seed, { translate: false, ...chunk });
        const ran = await runProgram(code, seed, chunk);
        assert.deepEqual({ ...ran, translated: 0 }, interpreted, `seed ${seed}`);
        faults += interpreted.stop.reason === 'fault' ? 1 : 0;
        translated += ran.translated > 0 ? 1 : 0;
    }
    assert.ok(faults > 5, `${faults} programs end at a fault`);
    assert.ok(translated > 150, `${translated} programs ran translated code`);
});
