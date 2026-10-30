/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of a loop that holds loops: its head takes an entry into one of
 * them from the dispatch -- a slice that ran out inside it, the runtime
 * entering there again -- by the label, which every jump back to the head
 * sets to the head's own (`emitRange` and `jumpTo` in region.js). Seeded nests of two and three
 * loops, of one block and of several, some breaking out of every loop from the
 * innermost and coming round to the outermost again through a jump back,
 * under budgets from a few instructions to a million a slice: translated and
 * interpreted, the two must stop the same way with the same instruction count,
 * registers, flags and memory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';

const CODE = 0x401000;
const DATA = 0x500000;
const STACK = 0xf00000;
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip'];
const CHUNKS = [7, 13, 23, 60, 250, 5000, 1_000_000];

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/** @param {number} seed */
function random(seed){
    let state = seed >>> 0;
    /** @param {number} n */
    return n=>{
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) % n;
    };
}

/**
 * A nest of `seed`: each level counts down a register of its own (ecx, edx,
 * ebp from the outside in), its body some arithmetic on eax and ebx before and
 * after the level inside it, a store of eax at the innermost; the innermost
 * may leave every loop when eax's low bits say so; the whole nest may run
 * again, by a jump back over it, up to twice.
 *
 * @param {number} seed
 * @returns {{ code: number[], chunk: number }}
 */
function generate(seed){
    const pick = random(seed);
    const depth = 2 + pick(2);
    const counters = [1, 2, 5].slice(0, depth);         // ecx, edx, ebp
    const counts = counters.map(()=>1 + pick(depth === 3 ? 9 : 30));
    const code = [0xb8, ...le(pick(1000)), 0xbb, ...le(pick(1000)), 0xbe, ...le(0)];
    const round = code.length;                          // the nest runs again from here
    /** Patches to make: [at, target], rel32 from at + 4. @type {[number, string][]} */
    const patches = [];
    /** @param {number} r @param {number} value */
    const set = (r, value)=>code.push(0xb8 + r, ...le(value));
    const arithmetic = ()=>{
        for (let k = pick(3); k > 0; k--)
        {
            const form = pick(4);
            if (form === 0)
            {
                code.push(0x01, 0xd8);                  // add eax, ebx
            }
            else if (form === 1)
            {
                code.push(0x69, 0xc0, ...le(0x9e3779b1)); // imul eax, eax, k
            }
            else if (form === 2)
            {
                code.push(0x83, 0xc3, pick(64));        // add ebx, imm
            }
            else
            {
                code.push(0x31, 0xc3);                  // xor ebx, eax
            }
        }
    };
    const heads = [];
    for (let level = 0; level < depth; level++)
    {
        set(counters[level], counts[level]);
        heads.push(code.length);
        arithmetic();
        if (pick(2) === 0)
        {
            // a forward branch inside the body: a loop of several blocks
            code.push(0xa8, 0x01, 0x74, 0x02, 0x31, 0xc3); // test al, 1; je +2; xor ebx, eax
        }
    }
    // The innermost: a store, and maybe the way out of every loop.
    code.push(0x89, 0x04, 0xb5, ...le(DATA));           // mov [DATA + esi*4], eax
    code.push(0x46, 0x81, 0xe6, ...le(0x3ff));          // inc esi; and esi, 0x3ff
    if (pick(3) === 0)
    {
        code.push(0xa8, 0x07 << pick(3) & 0x3f);        // test al, mask
        code.push(0x0f, 0x84, 0, 0, 0, 0);              // jz out
        patches.push([code.length - 4, 'out']);
    }
    for (let level = depth - 1; level >= 0; level--)
    {
        arithmetic();
        code.push(0x48 + counters[level]);              // dec counter
        code.push(0x0f, 0x85, ...le(heads[level] - (code.length + 6))); // jnz head
    }
    const out = code.length;
    // Round again: up to twice, a jump back over the whole nest.
    code.push(0x83, 0xff, 0x02, 0x74, 0x06);           // cmp edi, 2; je +6
    code.push(0x47);                                   // inc edi
    code.push(0xe9, ...le(round - (code.length + 5))); // jmp round
    code.push(0xf4);
    for (const [at] of patches)
    {
        code.splice(at, 4, ...le(out - (at + 4)));
    }
    return { code, chunk: CHUNKS[pick(CHUNKS.length)] };
}

/** @param {number[]} code @param {Record<string, unknown>} config */
async function runProgram(code, config){
    const m = createMachine({ ramSize: 16 << 20, config: { hotThreshold: 2, ...config } });
    try
    {
        m.load(CODE, code);
        m.setReg('esp', STACK);
        m.setReg('eip', CODE);
        const stop = await m.run({ maxInstructions: 5_000_000 });
        return {
            stop: { reason: stop.reason, vector: stop.vector, retired: stop.retired },
            data: [...m.read(DATA, 0x1000)],
            registers: Object.fromEntries(REGISTERS.map(name=>[name, m.reg(name)])),
            flags: stop.reason === 'halt' ? m.reg('eflags') & 0x8d5 : 0,
            translated: stop.translated,
        };
    }
    finally
    {
        m.dispose();
    }
}

test('nests of loops entered from the dispatch at an inner head match the interpreter',
    async()=>{
        let translated = 0;
        for (let seed = 1; seed <= 200; seed++)
        {
            const { code, chunk } = generate(seed * 7919);
            const interpreted = await runProgram(code, { translate: false });
            const ran = await runProgram(code, { yieldChunk: chunk });
            assert.equal(interpreted.stop.reason, 'halt', `seed ${seed}: the program halts`);
            assert.deepEqual({ ...ran, translated: 0 }, interpreted,
                `seed ${seed}, chunk ${chunk}`);
            translated += ran.translated > interpreted.stop.retired / 2 ? 1 : 0;
        }
        assert.ok(translated > 100, `${translated} programs ran mostly translated code`);
    });
