/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A direct call to an import thunk, formed as the call through the thunk's
 * slot (`thunkCall` in region.js, `thunk` in emit/integer.js), beside the
 * interpreter, which runs the call and the thunk's `jmp [slot]` as two
 * instructions. Seeded programs call thunks whose slots name small leaves
 * (formed in, predicted from the slot), callees too large or calling on
 * (made as wasm calls), and the thunks of others; they write a slot to name
 * another callee, write a thunk's own bytes to read another slot (the code
 * its regions were formed from), and the last of them calls a thunk whose
 * slot lies past the guest's memory (the slot read faults inside the thunk);
 * run with budgets that end inside the calls and with none, callees formed in
 * and apart. Both runs must leave the same memory, registers, instruction
 * count and way of stopping.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';

const CODE = 0x401000;
const THUNKS = 0x402000;
const SLOTS = 0x403000;
const FUNCTIONS = 0x404000;
const DATA = 0x500000;
const STACK = 0xf00000;
/** A slot no read reaches: past the 16 MiB the machines have. */
const UNMAPPED = 0x7ff00000;
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip'];
/** Programs run, each with every configuration. */
const SEEDS = Number(process.env.THUNK_SEEDS ?? 160);

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/**
 * A program: functions, thunks to them through slots, and a loop in main
 * calling the thunks directly.
 *
 * @param {number} seed
 * @returns {{ at: number, code: number[] }[]}
 */
function generate(seed){
    let state = seed >>> 0;
    /** @param {number} n */
    const pick = n=>{
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) % n;
    };
    const thunkCount = 2 + pick(5);
    const thunkAt = (/** @type {number} */ k)=>THUNKS + k * 8;
    /** @type {{ at: number, code: number[] }[]} */
    const functions = [];
    let next = FUNCTIONS;
    /** @param {number[]} code */
    const add = code=>{
        functions.push({ at: next, code });
        next += (code.length + 15) & ~15;
        return functions.length - 1;
    };
    // The tiny straight callees of compiled C++ and C, and larger ones.
    const shapes = [
        ()=>[0x8b, 0x41, pick(32) * 4, 0xc3], // mov eax, [ecx+N]; ret
        ()=>[0xb8, ...le(pick(1 << 30)), 0xc3], // mov eax, imm; ret
        ()=>[0x8d, 0x41, pick(128), 0xc3], // lea eax, [ecx+N]; ret
        // mov eax, edx; xor edx, edx; and cl, 31; shr eax, cl; ret (_aullshr's shape)
        ()=>[0x89, 0xd0, 0x31, 0xd2, 0x80, 0xe1, 0x1f, 0xd3, 0xe8, 0xc3],
        // mov eax, [esp+4]; add eax, ebx; ret 4: stdcall, one argument
        ()=>[0x8b, 0x44, 0x24, 0x04, 0x01, 0xd8, 0xc2, 0x04, 0x00],
        // A loop of more blocks than a leaf has: imul; dec; jnz, unrolled with branches.
        ()=>{
            const code = [0xb8, ...le(1)];
            for (let k = 0; k < 20; k++)
            {
                // test ebx, k; jz +3; imul eax, eax, 3
                code.push(0xf7, 0xc3, ...le(1 << k), 0x74, 0x03, 0x6b, 0xc0, 0x03);
            }
            code.push(0xc3);
            return code;
        },
    ];
    for (let k = 2 + pick(5); k > 0; k--)
    {
        add(shapes[pick(shapes.length)]());
    }
    const plain = functions.length;
    // A callee calling on through a thunk: not a leaf, a wasm call. No slot
    // the relay's own thunk reads names it, so no call recurses.
    const inner = pick(thunkCount);
    // push ebp; mov ebp, esp; push 7; call; mov esp, ebp; pop ebp; add ebx, eax; ret
    const relay = add([0x55, 0x89, 0xe5, 0x6a, 0x07, 0xe8, 0, 0, 0, 0, 0x89, 0xec, 0x5d, 0x01, 0xc3,
        0xc3]);
    const relayCode = functions[relay].code;
    const targets = Array.from({ length: thunkCount }, (_, k)=>(k === inner || pick(3) > 0
        ? pick(plain) : relay));
    relayCode.splice(6, 4, ...le(thunkAt(inner) - (functions[relay].at + 10)));
    // An argument pushed before every call, which a `ret 4` pops; esp put
    // back from ebp after each.
    const main = [0xb8, 0xbb, 0xb9, 0xba, 0xbe, 0xbf].flatMap(op=>[op, ...le(pick(1 << 31))]);
    main.push(0x89, 0xe5); // mov ebp, esp: esp put back after each call
    main.push(0xb9, ...le(DATA)); // mov ecx, DATA: the getters' object
    main.push(0xbf, ...le(30 + pick(30))); // mov edi, n
    const start = main.length;
    /** @type {{ at: number, to: number }[]} */
    const calls = [];
    let store = 0;
    for (let site = 2 + pick(5); site > 0; site--)
    {
        if (pick(4) === 0)
        {
            // mov dword [slot], function: another callee from now on
            const k = pick(thunkCount);
            main.push(0xc7, 0x05, ...le(SLOTS + k * 4), ...le(functions[pick(plain)].at));
        }
        const rewritten = pick(thunkCount);
        if (pick(8) === 0 && rewritten !== inner)
        {
            // mov dword [thunk + 2], slot: the thunk reads another slot
            main.push(0xc7, 0x05, ...le(thunkAt(rewritten) + 2),
                ...le(SLOTS + pick(thunkCount) * 4));
        }
        main.push(0x6a, pick(128)); // push imm8
        main.push(0xe8, 0, 0, 0, 0);
        calls.push({ at: main.length - 4, to: pick(thunkCount) });
        // mov [DATA + 0x100 + n], eax; mov esp, ebp; and ecx, 0x5003fc; or ecx, DATA
        main.push(0xa3, ...le(DATA + 0x100 + (store++ % 32) * 4), 0x89, 0xec);
        main.push(0x81, 0xe1, ...le(0x3fc), 0x81, 0xc9, ...le(DATA));
    }
    main.push(0x4f, 0x0f, 0x85, ...le(start - (main.length + 7))); // dec edi; jnz
    // The registers stored; with some seeds a call through an unmapped slot; hlt.
    main.push(0x89, 0x1d, ...le(DATA + 0x200), 0x89, 0x35, ...le(DATA + 0x204));
    if (pick(3) === 0)
    {
        main.push(0xc7, 0x05, ...le(thunkAt(0) + 2), ...le(UNMAPPED), 0xe8, 0, 0, 0, 0);
        calls.push({ at: main.length - 4, to: 0 });
    }
    main.push(0xf4);
    for (const { at, to } of calls)
    {
        main.splice(at, 4, ...le(thunkAt(to) - (CODE + at + 4)));
    }
    const thunks = [];
    for (let k = 0; k < thunkCount; k++)
    {
        thunks.push(0xff, 0x25, ...le(SLOTS + k * 4), 0xcc, 0xcc); // jmp [slot]; int3 padding
    }
    return [
        { at: CODE, code: main },
        { at: THUNKS, code: thunks },
        { at: SLOTS, code: targets.flatMap(fn=>le(functions[fn].at)) },
        ...functions,
        { at: DATA, code: Array.from({ length: 0x80 }, (_, k)=>k * 7 & 0xff) },
    ];
}

/**
 * @param {{ at: number, code: number[] }[]} pieces @param {Record<string, unknown>} config
 */
async function runProgram(pieces, config){
    const m = createMachine({ ramSize: 16 << 20, config: { hotThreshold: 2, ...config } });
    try
    {
        for (const { at, code } of pieces)
        {
            m.load(at, code);
        }
        m.setReg('esp', STACK);
        m.setReg('eip', CODE);
        const stop = await m.run({ maxInstructions: 2_000_000 });
        return {
            stop: { reason: stop.reason, retired: stop.retired },
            memory: [...m.read(DATA, 0x220), ...m.read(THUNKS, 0x40), ...m.read(SLOTS, 0x20),
                ...m.read(STACK - 0x40, 0x40)],
            registers: Object.fromEntries(REGISTERS.map(name=>[name, m.reg(name)])),
            translated: stop.translated,
            mechanisms: /** @type {{ mechanisms?: Record<string, number> }} */ (
                m.diagnostics()).mechanisms,
        };
    }
    finally
    {
        m.dispose();
    }
}

for (const [first, budget] of [[1, 10_000_000], [1001, 29]])
{
    test(`calls to import thunks through their slots leave what the interpreter leaves (seeds ${
        first}.., budget ${budget})`, async()=>{
        let translated = 0;
        let predicted = 0;
        let apart = 0;
        let faults = 0;
        for (let seed = first; seed < first + SEEDS; seed++)
        {
            const pieces = generate(seed * 7919);
            const interpreted = await runProgram(pieces, { translate: false });
            assert.ok(interpreted.stop.reason === 'halt' || interpreted.stop.reason === 'fault',
                `seed ${seed} stops: ${interpreted.stop.reason}`);
            faults += interpreted.stop.reason === 'fault' ? 1 : 0;
            for (const config of [{}, { formDepth: 0 }, { blockProfile: true }])
            {
                const ran = await runProgram(pieces, { yieldChunk: budget, ...config });
                assert.deepEqual({ ...ran, translated: 0, mechanisms: undefined },
                    { ...interpreted, mechanisms: undefined },
                    `seed ${seed}, ${JSON.stringify(config)}`);
                translated += ran.translated > 0 ? 1 : 0;
                predicted += ran.mechanisms?.CALL_PREDICTED ?? 0;
                apart += (ran.mechanisms?.CALL_INDIRECT ?? 0) + (ran.mechanisms?.CALL_LEFT ?? 0);
            }
        }
        assert.ok(translated > SEEDS * 2, `${translated} runs ran translated code`);
        assert.ok(predicted > 1000, `${predicted} thunk calls predicted and formed in`);
        assert.ok(apart > 100, `${apart} thunk calls made apart`);
        assert.ok(faults > 0, `${faults} programs end in a slot read that faults`);
    });
}
