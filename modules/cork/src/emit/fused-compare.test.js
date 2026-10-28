/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The integer `cmp` and `test` read by the block's final branch alone, which
 * leave the record as it was and have the branch compare their operands
 * (`fusesIntegerCompare` in region.js), beside the interpreter: seeded programs
 * of compares in every form -- byte, word and doubleword, high byte registers,
 * immediates of either width, memory on either side -- each followed by one of
 * the sixteen conditional branches, and after the branch either code that
 * writes the flags first (the compare fused) or code that reads CF, OF, SF, ZF
 * and PF (the compare left whole), run both ways; the two must leave the same
 * memory, registers, instruction count and way of stopping.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';

const CODE = 0x401000;
const DATA = 0x500000;
const STACK = 0xf00000;
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags'];
const EDGES = [0, 1, -1, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x7fffffff, -0x80000000,
    0x80ff, 0xff00];

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/**
 * A loop run thirty times (ebp counts) of compares of eax, ecx, edx and ebx,
 * which move with the round, each with a branch over a flagless `lea esi`.
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
    const value = ()=>(pick(2) === 0 ? EDGES[pick(EDGES.length)] : (pick(1 << 30) * 5) | 0);
    // mov ebp, 30; mov eax..ebx, values; outer:
    const code = [0xbd, ...le(30)];
    for (let r = 0; r < 4; r++)
    {
        code.push(0xb8 + r, ...le(value()));
    }
    const outer = code.length;
    for (let k = 0; k < 6 + pick(8); k++)
    {
        const a = pick(4);
        const c = pick(4);
        const byteA = pick(8); // al..bh
        const byteC = pick(8);
        const mem = DATA + 0x200 + k * 4;
        if (pick(4) === 0)
        {
            code.push(0xc7, 0x05, ...le(mem), ...le(value())); // mov [mem], value
        }
        const forms = [
            ()=>code.push(0x39, 0xc0 | c << 3 | a), // cmp r32, r32
            ()=>code.push(0x38, 0xc0 | byteC << 3 | byteA), // cmp r8, r8
            ()=>code.push(0x66, 0x39, 0xc0 | c << 3 | a), // cmp r16, r16
            ()=>code.push(0x83, 0xf8 | a, pick(256)), // cmp r32, imm8
            ()=>code.push(0x80, 0xf8 | byteA, pick(256)), // cmp r8, imm8
            ()=>code.push(0x3c, pick(256)), // cmp al, imm8
            ()=>code.push(0x81, 0xf8 | a, ...le(value())), // cmp r32, imm32
            ()=>code.push(0x66, 0x81, 0xf8 | a, pick(256), pick(256)), // cmp r16, imm16
            ()=>code.push(0x3b, 0x05 | a << 3, ...le(mem)), // cmp r32, [mem]
            ()=>code.push(0x39, 0x05 | a << 3, ...le(mem)), // cmp [mem], r32
            ()=>code.push(0x80, 0x3d, ...le(mem), pick(256)), // cmp byte [mem], imm8
            ()=>code.push(0x85, 0xc0 | c << 3 | a), // test r32, r32
            ()=>code.push(0x84, 0xc0 | byteC << 3 | byteA), // test r8, r8
            ()=>code.push(0xf7, 0xc0 | a, ...le(value())), // test r32, imm32
            ()=>code.push(0xa8, pick(256)), // test al, imm8
            ()=>code.push(0xf6, 0xc0 | byteA, pick(256)), // test r8, imm8
            ()=>code.push(0x66, 0x85, 0xc0 | c << 3 | a), // test r16, r16
            ()=>code.push(0x85, 0x05 | a << 3, ...le(mem)), // test [mem], r32
        ];
        forms[pick(forms.length)]();
        const live = pick(3) === 0;
        // jcc over `lea esi, [esi + 1]`
        code.push(0x70 + pick(16), 4, 0x8d, 0x76, 0x01, 0x90);
        if (live)
        {
            // adc edi, 0; seto, sets, setz, setp byte [DATA + k * 4 ..]
            code.push(0x83, 0xd7, 0x00);
            for (const [op, at] of [[0x90, 0], [0x98, 1], [0x94, 2], [0x9a, 3]])
            {
                code.push(0x0f, op, 0x05, ...le(DATA + k * 4 + at));
            }
        }
        // add r, ebp: every flag written, the factors moving with the round
        code.push(0x01, 0xc0 | 5 << 3 | pick(4));
    }
    // dec ebp; jnz outer; hlt
    code.push(0x4d, 0x0f, 0x85, ...le(outer - (code.length + 7)), 0xf4);
    return code;
}

/**
 * @param {number[]} code @param {Record<string, unknown>} config
 */
async function runProgram(code, config){
    const m = createMachine({ ramSize: 16 << 20, config: { hotThreshold: 2, ...config } });
    try
    {
        m.load(CODE, code);
        m.setReg('esp', STACK);
        m.setReg('eip', CODE);
        const stop = await m.run({ maxInstructions: 1_000_000 });
        return {
            stop: { reason: stop.reason, vector: stop.vector, retired: stop.retired },
            data: [...m.read(DATA, 0x300)],
            registers: Object.fromEntries(REGISTERS.map(name=>[name, m.reg(name)])),
            translated: stop.translated,
        };
    }
    finally
    {
        m.dispose();
    }
}

test('a compare read by its branch alone leaves what the interpreter leaves', async()=>{
    let translated = 0;
    for (let seed = 1; seed <= 250; seed++)
    {
        const code = generate(seed * 7907);
        const interpreted = await runProgram(code, { translate: false });
        const ran = await runProgram(code, {});
        assert.deepEqual({ ...ran, translated: 0 }, interpreted, `seed ${seed}`);
        translated += ran.translated > 0 ? 1 : 0;
    }
    assert.ok(translated > 200, `${translated} programs ran translated code`);
});
