/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A dword division whose dividend the instruction before widened from eax
 * (`cdq; idiv`, `xor edx, edx; div`), divided in 32 bits (`divideWord` in
 * integer.js), beside the interpreter: seeded programs of such pairs and of
 * divisions with an unwidened dividend, register and memory divisors, the
 * edge values (0, 1, -1, INT_MIN, INT_MAX) among the operands, a division by
 * zero or INT_MIN / -1 ending some programs with the divide fault -- each run
 * both ways, and the two must leave the same memory, registers, instruction
 * count and way of stopping.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';

const CODE = 0x401000;
const DATA = 0x500000;
const STACK = 0xf00000;
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip'];
const EDGES = [0, 1, -1, 2, -2, 7, -7, 0x7fffffff, -0x80000000, 0x10000, -0x10000];

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/**
 * A program of divisions in a loop run thirty times, so it is translated; each
 * quotient and remainder stored.
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
    const value = ()=>(pick(3) === 0 ? EDGES[pick(EDGES.length)] : (pick(1 << 30) - (1 << 29)) | 0);
    // mov ebx, 30; outer:
    const code = [0xbb, ...le(30)];
    const outer = code.length;
    for (let k = 3 + pick(6); k > 0; k--)
    {
        // mov eax, a; mov ecx, b (never zero unless the case means it); mov [divisor], ecx
        const divisor = pick(40) === 0 ? 0 : value() || 3;
        code.push(0xb8, ...le(value()), 0xb9, ...le(divisor), 0x89, 0x0d, ...le(DATA + 0x100));
        const signed = pick(2) === 0;
        const widen = pick(4);
        if (widen === 0)
        {
            code.push(0xba, ...le(signed ? value() & 3 : 0)); // mov edx, small: not widened
        }
        else if (signed)
        {
            code.push(0x99); // cdq
        }
        else
        {
            code.push(...pick(2) ? [0x31, 0xd2] : [0x29, 0xd2]); // xor / sub edx, edx
        }
        if (pick(2))
        {
            code.push(0xf7, signed ? 0xf9 : 0xf1); // idiv / div ecx
        }
        else
        {
            code.push(0xf7, signed ? 0x3d : 0x35, ...le(DATA + 0x100)); // idiv / div [m32]
        }
        // mov [m32], eax; mov [m32], edx
        code.push(0xa3, ...le(DATA + k * 8), 0x89, 0x15, ...le(DATA + k * 8 + 4));
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

test('divisions of a widened dividend in 32 bits leave what the interpreter leaves', async()=>{
    let faults = 0;
    let translated = 0;
    for (let seed = 1; seed <= 300; seed++)
    {
        const code = generate(seed * 7919);
        const interpreted = await runProgram(code, { translate: false });
        const { translated: ran, ...observed } = await runProgram(code, {});
        const { translated: none, ...expected } = interpreted;
        assert.deepEqual(observed, expected, `seed ${seed}`);
        faults += interpreted.stop.reason === 'fault' ? 1 : 0;
        translated += ran > 0 ? 1 : 0;
    }
    // Both ways out are met: programs that end at a divide fault, programs translated.
    assert.ok(faults > 10, `${faults} programs end at a divide fault`);
    assert.ok(translated > 100, `${translated} programs ran translated code`);
});
