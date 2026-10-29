/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The two- and three-operand imul whose CF and OF no one reads, multiplied in
 * 32 bits (`imul` in integer.js), beside the interpreter: seeded programs of
 * word and doubleword imuls -- register and memory sources, byte and full
 * immediates, edge values among the factors -- each followed by an
 * instruction that writes the flags (they are dead) or by one that reads CF or
 * OF (they are live), run both ways; the two must leave the same memory,
 * registers, instruction count and way of stopping.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';

const CODE = 0x401000;
const DATA = 0x500000;
const STACK = 0xf00000;
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags'];
const EDGES = [0, 1, -1, 2, 3, 0x7fff, -0x8000, 0xffff, 0x7fffffff, -0x80000000, 0x10000, 0x1000193,
    -0x3b9aca07];

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/**
 * A loop run thirty times of imuls on eax, ecx, esi and edi (ebx counts the
 * turns, dl and ebp take the flags read), each result stored.
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
    const value = ()=>(pick(3) === 0 ? EDGES[pick(EDGES.length)] : (pick(1 << 30) * 3) | 0);
    const regs = [0, 1, 6, 7]; // eax ecx esi edi
    // mov ebx, 30; mov eax..esi, values; outer:
    const code = [0xbb, ...le(30)];
    for (const r of regs)
    {
        code.push(0xb8 + r, ...le(value()));
    }
    const outer = code.length;
    for (let k = 0; k < 4 + pick(8); k++)
    {
        const word = pick(4) === 0;
        const prefix = word ? [0x66] : [];
        const dst = regs[pick(4)];
        const src = regs[pick(4)];
        const memory = pick(3) === 0;
        if (memory)
        {
            // mov [DATA + 0x100], value
            code.push(0xc7, 0x05, ...le(DATA + 0x100), ...le(value()));
        }
        const rm = memory ? [0x05 | dst << 3, ...le(DATA + 0x100)] : [0xc0 | dst << 3 | src];
        const form = pick(3);
        if (form === 0)
        {
            code.push(...prefix, 0x0f, 0xaf, ...rm); // imul dst, src
        }
        else if (form === 1)
        {
            code.push(...prefix, 0x6b, ...rm, pick(256)); // imul dst, src, imm8
        }
        else
        {
            const imm = value();
            code.push(...prefix, 0x69, ...rm, ...word ? [imm & 0xff, imm >> 8 & 0xff] : le(imm));
        }
        const after = pick(4);
        if (after === 0)
        {
            code.push(0x0f, 0x90, 0xc2); // seto dl: OF read
            code.push(0x88, 0x15, ...le(DATA + k * 4)); // mov [m], dl
        }
        else if (after === 1)
        {
            code.push(0x83, 0xd5, 0); // adc ebp, 0: CF read
        }
        else if (after === 2)
        {
            code.push(0x85, 0xc0 | dst << 3 | dst); // test dst, dst: the flags dead
        }
        // mov [DATA + 0x40 + k * 4], dst
        code.push(0x89, 0x05 | dst << 3, ...le(DATA + 0x40 + k * 4));
        // keep the factors moving: add dst, ebx
        code.push(0x01, 0xc0 | 3 << 3 | dst);
    }
    // dec ebx; jnz outer; hlt
    code.push(0x4b, 0x0f, 0x85, ...le(outer - (code.length + 7)), 0xf4);
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
            data: [...m.read(DATA, 0x108)],
            registers: Object.fromEntries(REGISTERS.map(name=>[name, m.reg(name)])),
            translated: stop.translated,
        };
    }
    finally
    {
        m.dispose();
    }
}

test('imul with its flags dead, in 32 bits, leaves what the interpreter leaves', async()=>{
    let translated = 0;
    for (let seed = 1; seed <= 200; seed++)
    {
        const code = generate(seed * 104729);
        const interpreted = await runProgram(code, { translate: false });
        const ran = await runProgram(code, {});
        assert.deepEqual({ ...ran, translated: 0 }, interpreted, `seed ${seed}`);
        translated += ran.translated > 0 ? 1 : 0;
    }
    assert.ok(translated > 150, `${translated} programs ran translated code`);
});
