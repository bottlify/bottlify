/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The flag record and the flags word across guest calls made as wasm calls,
 * transfers and exits beside the interpreter. A region loads a record field or
 * the flags word only where its code reads it and stores one only where its
 * code writes it (`fillDeferred` in region.js), and a call tests its target's
 * slot for an entry compiled for any top first (`linkedCall` in integer.js):
 * seeded programs of functions that write the flags, read the ones their
 * caller left (`adc`, `setc`, `pushfd`, a branch), touch none at all, set and
 * clear the direction flag, call one another directly and through a register,
 * run each with a budget that spends inside the callees and with one that does
 * not, translated and interpreted -- the two must leave the same memory,
 * registers, flags and instruction count.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';

const CODE = 0x401000;
const FUNCTIONS = 0x402000;
const DATA = 0x500000;
const STACK = 0xf00000;
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags'];

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/**
 * A program: functions of flag writers, flag readers and moves, a loop in main
 * calling them, the flags each call leaves read after it.
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
    let slot = 0;
    const store = ()=>[0xa3, ...le(DATA + (slot++ % 64) * 4)]; // mov [m32], eax
    const writers = [
        ()=>[0x05, ...le(pick(1 << 31))], // add eax, imm32
        ()=>[0x29, 0xd8], // sub eax, ebx
        ()=>[0x39, 0xd8], // cmp eax, ebx
        ()=>[0x85, 0xc3], // test ebx, eax
        ()=>[0x41], // inc ecx: the carry is the one before
        ()=>[0x4a], // dec edx
        ()=>[0x31, 0xf0], // xor eax, esi
        ()=>[0xf7, 0xd8], // neg eax
        ()=>[0xf9], // stc
        ()=>[0xf8], // clc
    ];
    const readers = [
        ()=>[0x11, 0xd8], // adc eax, ebx
        ()=>[0x19, 0xc7], // sbb edi, eax
        ()=>[0x0f, 0x92, 0xc1], // setc cl
        ()=>[0x0f, 0x94, 0xc2], // setz dl
        ()=>[0x0f, 0x9c, 0xc3], // setl bl
        ()=>[0x9c, 0x5e, 0x83, 0xe6, 0xef], // pushfd; pop esi; and esi, ~AF
        ()=>[0x72, 0x02, 0x01, 0xc6], // jc +2; add esi, eax
        ()=>[0x77, 0x01, 0x47], // ja +1; inc edi
    ];
    const quiet = [
        ()=>[0x89, 0xc1], // mov ecx, eax
        ()=>[0x8d, 0x44, 0x18, pick(128)], // lea eax, [eax+ebx+imm8]
        ()=>[0xf7, 0xd0], // not eax
        ()=>[0x8b, 0x15, ...le(DATA + pick(64) * 4)], // mov edx, [m32]
        ()=>[0xbf, ...le(pick(1 << 30))], // mov edi, imm32
    ];
    /** @param {(() => number[])[]} kinds */
    const one = kinds=>kinds[pick(kinds.length)]();

    /** @type {{ at: number, code: number[], calls: { at: number, to: number }[] }[]} */
    const fns = [];
    let next = FUNCTIONS;
    for (let k = 3 + pick(5); k > 0; k--)
    {
        // What the function's body is made of: flags left alone, written only,
        // read before written, or anything.
        const shape = pick(4);
        const kinds = [[quiet], [quiet, writers], [readers, quiet],
            [quiet, writers, readers]][shape];
        /** @type {number[]} */
        const code = [];
        /** @type {{ at: number, to: number }[]} */
        const calls = [];
        if (shape === 2 && pick(2))
        {
            // pushfd; pop eax; and eax, ~AF: what the caller left
            code.push(0x9c, 0x58, 0x83, 0xe0, 0xef, ...store());
        }
        if (pick(5) === 0)
        {
            code.push(pick(2) ? 0xfd : 0xfc); // std / cld, left so for the caller
        }
        for (let part = 1 + pick(6); part > 0; part--)
        {
            code.push(...one(kinds[pick(kinds.length)]));
            if (pick(3) === 0)
            {
                code.push(...store());
            }
            if (fns.length > 0 && pick(5) === 0)
            {
                code.push(0xe8, 0, 0, 0, 0);
                calls.push({ at: code.length - 4, to: pick(fns.length) });
            }
        }
        code.push(0xc3);
        fns.push({ at: next, code, calls });
        next += (code.length + 15) & ~15;
    }
    // mov eax..edi, imm32; mov ebp, n; L: calls, each with the flags read after it;
    // dec ebp; jnz L; pushfd; pop eax; the registers stored; hlt
    const main = [0xb8, 0xbb, 0xb9, 0xba, 0xbe, 0xbf].flatMap(op=>[op, ...le(pick(1 << 31))]);
    main.push(0xbd, ...le(20 + pick(40)));
    const start = main.length;
    /** @type {{ at: number, to: number }[]} */
    const calls = [];
    for (let site = 2 + pick(5); site > 0; site--)
    {
        if (pick(3) === 0)
        {
            main.push(...one(writers));
        }
        const to = pick(fns.length);
        if (pick(4) === 0)
        {
            // push the address; pop edx; call edx
            main.push(0x68, ...le(fns[to].at), 0x5a, 0xff, 0xd2);
        }
        else
        {
            main.push(0xe8, 0, 0, 0, 0);
            calls.push({ at: main.length - 4, to });
        }
        main.push(...one(readers), ...store());
        if (pick(2))
        {
            main.push(...one(quiet));
        }
    }
    main.push(0x4d, 0x0f, 0x85, ...le(start - (main.length + 7)));
    main.push(0x9c, 0x58, 0x83, 0xe0, 0xef, ...store(), 0x89, 0x1d, ...le(DATA + 0x100),
        0x89, 0x35, ...le(DATA + 0x104), 0x89, 0x3d, ...le(DATA + 0x108), 0xfc, 0xf4);
    /** @param {{ at: number, code: number[], calls: { at: number, to: number }[] }} fn */
    const place = fn=>{
        const code = [...fn.code];
        for (const { at, to } of fn.calls)
        {
            code.splice(at, 4, ...le(fns[to].at - (fn.at + at + 4)));
        }
        return { at: fn.at, code };
    };
    return [place({ at: CODE, code: main, calls }), ...fns.map(place)];
}

/**
 * @param {{ at: number, code: number[] }[]} pieces @param {Record<string, unknown>} config
 */
async function runProgram(pieces, config){
    const m = createMachine({ ramSize: 16 << 20, config: { hotThreshold: 2, leafCalls: false,
        ...config } });
    try
    {
        for (const { at, code } of pieces)
        {
            m.load(at, code);
        }
        m.setReg('esp', STACK);
        m.setReg('eip', CODE);
        const stop = await m.run({ maxInstructions: 2_000_000 });
        const { mechanisms } = /** @type {{ mechanisms?: Record<string, number> }} */ (
            m.diagnostics());
        return {
            stop: { reason: stop.reason, retired: stop.retired },
            data: [...m.read(DATA, 0x110)],
            // AF is left undefined by the logical operations, and the two ways need not agree.
            registers: Object.fromEntries(REGISTERS.map(name=>[name,
                name === 'eflags' ? m.reg(name) & ~0x10 : m.reg(name)])),
            translated: stop.translated,
            returned: mechanisms?.RET_TO_CALL ?? 0,
        };
    }
    finally
    {
        m.dispose();
    }
}

for (const [first, budget] of /** @type {[number, number][]} */ ([
    [1, 10_000_000], [501, 37], [1001, 10_000_000], [1501, 37]]))
{
    test(`flags across calls, transfers and exits leave what the interpreter leaves (seeds ${
        first}.., budget ${budget})`, async()=>{
        let translated = 0;
        let returned = 0;
        for (let seed = first; seed < first + 120; seed++)
        {
            const pieces = generate(seed * 7919);
            const interpreted = await runProgram(pieces, { translate: false });
            assert.equal(interpreted.stop.reason, 'halt', `seed ${seed} halts`);
            // Callees formed in and called apart, and every call apart with its
            // profile counts, which say how many `ret`s came back to a wasm call.
            for (const config of [{}, { formDepth: 0 }, { formDepth: 0, blockProfile: true }])
            {
                const ran = await runProgram(pieces, { yieldChunk: budget, ...config });
                assert.deepEqual({ ...ran, translated: 0, returned: 0 },
                    { ...interpreted, returned: 0 }, `seed ${seed}, ${JSON.stringify(config)}`);
                translated += ran.translated > 0 ? 1 : 0;
                returned += ran.returned;
            }
        }
        assert.ok(translated > 300, `${translated} runs ran translated code`);
        assert.ok(returned > 1000, `${returned} returns to a wasm call`);
    });
}
