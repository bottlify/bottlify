/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The flag record where translated code leaves it: a way out to code that
 * writes the six flags before it reads one hands on an empty record
 * (`exitWithKind`), and a `cmp` its block's final branch alone reads leaves
 * its result unmade, made only on the ways on and out whose code reads a flag
 * (`oweResult`). Beside the interpreter: seeded loops of compares, branches
 * over pieces that read the flags first or write them first, carries kept
 * across the back edge by `inc`/`dec`, stores between a compare and its
 * branch (into the code's own page in some programs: a way out after the
 * store), an SSE instruction there in others with SSE left to the interpreter
 * (a way out before it), loops of one block and byte copies; run with a region
 * budget of a few instructions, so budget exits fall at every back edge, and
 * the interpreter runs from each. Both runs must leave the same registers,
 * defined flags, memory, count and way of stopping.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';

const CODE = 0x401000;
const DATA = 0x500000;
/** Data in the code's own page: every store leaves through the stale-code way out, mid-block. */
const NEAR = CODE + 0xc00;
const STACK = 0xf00000;
/** Programs run, each both ways. */
const SEEDS = Number(process.env.RECORD_SEEDS ?? 400);
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip'];
/** The registers the pieces compute in: eax, edx, ebx, esi, edi (ecx counts, ebp is the data). */
const WORK = [0, 2, 3, 6, 7];
/** The byte registers among them: al, dl, bl. */
const BYTES = [0, 2, 3];
/** CF, PF, AF, ZF, SF and OF: the program's last instruction defines them all. */
const ARITHMETIC = 0x8d5;
/** Conditions whose flags every writer in the pool defines (no AF; OF but after a shift). */
const CONDITIONS = [0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8, 0x9, 0xa, 0xb, 0xc, 0xd, 0xe, 0xf, 0x0, 0x1];

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/**
 * A program: an outer loop over an inner one of seeded pieces, then the flags
 * read and the last flags defined.
 *
 * @param {number} seed @param {number} data  where its data lies
 * @returns {number[]}
 */
function generate(seed, data){
    let state = seed >>> 0;
    /** @param {number} n */
    const pick = n=>{
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) % n;
    };
    const reg = ()=>WORK[pick(WORK.length)];
    const slot = ()=>pick(24) * 4;
    /** A writer of every flag, or of all but CF. @type {(() => number[])[]} */
    const writers = [
        ()=>[0x39, 0xc0 | reg() << 3 | reg()], // cmp r, r
        ()=>[0x83, 0xf8 | reg(), pick(256)], // cmp r, imm8
        ()=>[0x01 + 8 * [0, 5][pick(2)], 0xc0 | reg() << 3 | reg()], // add / sub r, r
        ()=>[0x83, 0xc0 | [0, 1, 4, 5, 6][pick(5)] << 3 | reg(), pick(256)], // add or and sub xor
        ()=>[0x85, 0xc0 | reg() << 3 | reg()], // test r, r
        ()=>[0x38, 0xc0 | BYTES[pick(3)] << 3 | BYTES[pick(3)]], // cmp r8, r8
        ()=>[0x66, 0x39, 0xc0 | reg() << 3 | reg()], // cmp r16, r16
        ()=>[0x3c, pick(256)], // cmp al, imm8
        ()=>[0x39, 0x45 | reg() << 3, slot()], // cmp [ebp+d], r
        ()=>[0xf7, 0xd8 | reg()], // neg r
        ()=>[0x40 + 8 * pick(2) + reg()], // inc / dec r: CF kept
        ()=>[0xd1, 0xe0 | 8 * pick(2) | reg()], // shl / shr r, 1
    ];
    /** A reader of the flags as they are. @type {(() => number[])[]} */
    const readers = [
        ()=>[0x11 + 8 * pick(2), 0xc0 | reg() << 3 | reg()], // adc / sbb r, r
        ()=>[0x0f, 0x90 | CONDITIONS[pick(16)], 0x45, slot()], // setcc [ebp+d]
        ()=>[0x0f, 0x90 | CONDITIONS[pick(16)], 0xc0 | BYTES[pick(3)]], // setcc r8
        ()=>[0x0f, 0x40 | CONDITIONS[pick(16)], 0xc0 | reg() << 3 | reg()], // cmovcc r, r
    ];
    const store = ()=>[0x89, 0x45 | reg() << 3, slot()]; // mov [ebp+d], r
    // xorps xmm0, xmm0: no flags, and a region left to the interpreter before it
    // where SSE is left out.
    const vector = ()=>[0x0f, 0x57, 0xc0];
    const load = ()=>[0x8b, 0x45 | reg() << 3, slot()]; // mov r, [ebp+d]
    /** @param {number} n @returns {number[]} */
    const straight = n=>{
        /** @type {number[]} */
        const out = [];
        for (let k = 0; k < n; k++)
        {
            const what = pick(10);
            out.push(...what < 4 ? writers[pick(writers.length)]()
                : what < 7 ? readers[pick(readers.length)]() : what < 8 ? store()
                    : what < 9 ? vector() : load());
        }
        return out;
    };
    /** A piece that starts by reading the flags or by writing them. */
    const opening = ()=>(pick(2) === 0 ? [...readers[pick(readers.length)](), ...straight(pick(3))]
        : [...writers[pick(writers.length)](), ...straight(pick(3))]);
    // mov ebp, DATA; the work registers seeded; mov ebx(outer) in [ebp+0x7c]
    const code = [0xbd, ...le(data)];
    for (const r of WORK)
    {
        code.push(0xb8 + r, ...le(pick(3) === 0 ? pick(5) - 2 : (pick(1 << 30) * 4) | 0));
    }
    code.push(0xc7, 0x45, 0x7c, ...le(8 + pick(8))); // mov dword [ebp+0x7c], outer turns
    const outer = code.length;
    code.push(0xb9, ...le(4 + pick(24))); // mov ecx, inner turns
    const inner = code.length;
    for (let k = 1 + pick(4); k > 0; k--)
    {
        const shape = pick(5);
        if (shape === 0)
        {
            code.push(...straight(1 + pick(4)));
            continue;
        }
        // A compare and its branch over a piece, to one: each starts reading
        // the flags or writing them; a store between some compares and their branch.
        const over = opening();
        const to = opening();
        code.push(...writers[pick(9)]());
        if (shape === 1)
        {
            code.push(...pick(2) === 0 ? store() : vector());
        }
        code.push(0x70 | CONDITIONS[pick(16)], over.length, ...over, ...to);
    }
    const back = pick(4);
    if (back === 0)
    {
        code.push(0x49, 0x0f, 0x85, ...le(inner - (code.length + 7))); // dec ecx; jnz inner
    }
    else
    {
        // sub ecx, 1 (or a compare of the count against zero after a dec):
        // the branch back is a compare's.
        code.push(...back === 1 ? [0x83, 0xe9, 0x01] : [0x49, 0x83, 0xf9, 0x00]);
        code.push(0x0f, 0x85, ...le(inner - (code.length + 6)));
    }
    if (pick(3) === 0)
    {
        // A byte copy whose compare ends its own loop: mov esi/edi to two slots,
        // movsb; cmp edi, end; jne.
        code.push(0x8d, 0x75, 0x00, 0x8d, 0x7d, 0x40);
        const copy = code.length;
        code.push(0xa4, 0x8d, 0x45, 0x50, 0x39, 0xc7, 0x75, copy - (code.length + 8));
    }
    if (pick(2) === 0)
    {
        // A loop of one block whose head reads the flags its compare left: the
        // budget's way out at its back edge hands them on. mov edi, -n;
        // adc eax, ebx / setcc [ebp+d] / cmovcc eax, edx; inc edi; cmp edi, 0; jne / jl.
        code.push(0xbf, ...le(-(2 + pick(30))));
        const head = code.length;
        const read = [[0x11, 0xd8], [0x0f, 0x90 | CONDITIONS[pick(16)], 0x45, slot()],
            [0x0f, 0x40 | CONDITIONS[pick(16)], 0xc2]][pick(3)];
        code.push(...read, 0x47, 0x83, 0xff, 0x00);
        code.push(0x70 | [0x5, 0xc][pick(2)], head - (code.length + 2));
    }
    code.push(...opening());
    // dec dword [ebp+0x7c]; jnz outer
    code.push(0xff, 0x4d, 0x7c, 0x0f, 0x85, ...le(outer - (code.length + 9)));
    code.push(...readers[pick(readers.length)]());
    // add eax, ebx: the six defined at the end; hlt
    code.push(0x01, 0xd8, 0xf4);
    return code;
}

/**
 * @param {number[]} code @param {number} data @param {Record<string, unknown>} config
 */
async function runProgram(code, data, config){
    const m = createMachine({ ramSize: 16 << 20, config: { hotThreshold: 2, ...config } });
    try
    {
        m.load(CODE, code);
        m.setReg('esp', STACK);
        m.setReg('eip', CODE);
        const stop = await m.run({ maxInstructions: 2_000_000 });
        return {
            stop: { reason: stop.reason, vector: stop.vector, retired: stop.retired },
            data: [...m.read(data, 0x80)],
            registers: Object.fromEntries(REGISTERS.map(name=>[name, m.reg(name)])),
            flags: m.reg('eflags') & ARITHMETIC,
            translated: stop.translated,
        };
    }
    finally
    {
        m.dispose();
    }
}

test('records at ways out and owed compare results leave what the interpreter leaves', async()=>{
    let translated = 0;
    for (let seed = 1; seed <= SEEDS; seed++)
    {
        const data = seed % 4 === 0 ? NEAR : DATA;
        const code = generate(seed * 7919, data);
        const interpreted = await runProgram(code, data, { translate: false });
        // A region budget of a few instructions: most back edges leave.
        const ran = await runProgram(code, data, { yieldChunk: 3 + seed % 41,
            ...seed % 3 === 0 ? { leaveOut: ['sse'] } : {} });
        assert.deepEqual({ ...ran, translated: 0 }, interpreted, `seed ${seed}`);
        translated += ran.translated > 0 ? 1 : 0;
    }
    assert.ok(translated > SEEDS * 0.8, `${translated} programs ran translated code`);
});
