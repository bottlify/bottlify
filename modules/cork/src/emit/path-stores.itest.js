/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The registers, the flag record and the flags word at the ways out of a region
 * and back from its calls beside the interpreter. A way out stores only what
 * some way to it wrote since the state block last held it, and a call's return
 * reloads only what is read before it is written after it (`planPaths` in
 * region.js): seeded programs of functions that write registers on some paths
 * and not others, under branches, in frames, before and after their calls,
 * that return early, call one another directly and through a register, and a
 * loop calling them that reads, writes and leaves those registers alone after
 * each call -- run with budgets that end the runs at every kind of way out and
 * with one that does not, translated and interpreted, must leave the same
 * memory, registers, flags and instruction count.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';

const CODE = 0x401000;
const FUNCTIONS = 0x402000;
const DATA = 0x500000;
const STACK = 0xf00000;
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip', 'eflags'];
/** The registers a program writes as it likes: all but esp. */
const FREE = [0, 1, 2, 3, 5, 6, 7];

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/**
 * A program: functions of register and flag writes, some under a branch, some
 * in a frame or between a push and a pop, calls and early returns, and a loop in
 * main calling them with the same around each call.
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
    const reg = ()=>FREE[pick(FREE.length)];
    const slot = ()=>DATA + pick(48) * 4;
    /** A register written, whatever it held. */
    const write = ()=>{
        const r = reg();
        switch (pick(5))
        {
            case 0: return [0xb8 + r, ...le(pick(1 << 31))]; // mov r, imm32
            case 1: return [0x40 + r]; // inc r
            case 2: return [0x8d, 0x40 | r << 3 | r, pick(128)]; // lea r, [r+imm8]
            case 3: return [0x01, 0xc0 | reg() << 3 | r]; // add r, r2
            default: return [0x8b, 0x05 | r << 3, ...le(slot())]; // mov r, [m32]
        }
    };
    const flags = [
        ()=>[0x39, 0xc0 | reg() << 3 | reg()], // cmp r, r2
        ()=>[0x85, 0xc0 | reg() << 3 | reg()], // test r, r2
        ()=>[0x48 + reg()], // dec r: the carry is the one before
        ()=>[0xf9], // stc
    ];
    const readers = [
        ()=>[0x11, 0xc0 | reg() << 3 | reg()], // adc r, r2
        ()=>[0x0f, 0x92, 0xc1], // setc cl
        ()=>[0x9c, 0x8f, 0x05, ...le(slot())], // pushfd; pop [m32]
    ];
    /** A register into memory: what it holds there read. */
    const store = ()=>[0x89, 0x05 | reg() << 3, ...le(slot())]; // mov [m32], r
    /** @param {(() => number[])[]} kinds */
    const one = kinds=>kinds[pick(kinds.length)]();
    /** A write the branch before it may skip. */
    const maybe = ()=>{
        const skipped = write();
        // test r, r2; jz/jnz over it
        return [0x85, 0xc0 | reg() << 3 | reg(), 0x74 + pick(2), skipped.length, ...skipped];
    };
    /** @type {(() => number[])[]} */
    const parts = [write, write, maybe, maybe, store, ()=>one(flags), ()=>one(readers)];

    /** @type {{ at: number, code: number[], calls: { at: number, to: number }[] }[]} */
    const fns = [];
    let next = FUNCTIONS;
    /**
     * Calls into the functions made so far: direct, or through edx.
     *
     * @param {number[]} code @param {{ at: number, to: number }[]} calls
     */
    const call = (code, calls)=>{
        const to = pick(fns.length);
        if (pick(3) === 0)
        {
            // push the address; pop edx; call edx
            code.push(0x68, ...le(fns[to].at), 0x5a, 0xff, 0xd2);
            return;
        }
        code.push(0xe8, 0, 0, 0, 0);
        calls.push({ at: code.length - 4, to });
    };
    for (let k = 4 + pick(5); k > 0; k--)
    {
        /** @type {number[]} */
        const code = [];
        /** @type {{ at: number, to: number }[]} */
        const calls = [];
        const frame = pick(3) === 0;
        if (frame)
        {
            code.push(0x55, 0x89, 0xe5); // push ebp; mov ebp, esp
        }
        const saved = pick(3) === 0 ? 6 + pick(2) : -1;
        if (saved >= 0)
        {
            code.push(0x50 + saved); // push esi / edi
        }
        for (let part = 1 + pick(7); part > 0; part--)
        {
            code.push(...one(parts));
            if (fns.length > 0 && pick(4) === 0)
            {
                call(code, calls);
            }
            if (!frame && saved < 0 && pick(9) === 0)
            {
                // test r, r2; jnz +1; ret: an early way back
                code.push(0x85, 0xc0 | reg() << 3 | reg(), 0x75, 0x01, 0xc3);
            }
        }
        if (saved >= 0)
        {
            code.push(0x58 + saved);
        }
        if (frame)
        {
            code.push(0x5d); // pop ebp
        }
        code.push(0xc3);
        fns.push({ at: next, code, calls });
        next += (code.length + 15) & ~15;
    }
    // mov eax..edi but esp, imm32; [DATA+0x180] = n; L: the calls, with parts
    // around them; dec [DATA+0x180]; jnz L; the registers and flags stored; hlt
    const main = FREE.flatMap(r=>[0xb8 + r, ...le(pick(1 << 31))]);
    main.push(0xc7, 0x05, ...le(DATA + 0x180), ...le(10 + pick(30)));
    const start = main.length;
    /** @type {{ at: number, to: number }[]} */
    const calls = [];
    for (let site = 2 + pick(5); site > 0; site--)
    {
        for (let before = pick(3); before > 0; before--)
        {
            main.push(...one(parts));
        }
        call(main, calls);
        // After the call: nothing, a read, a write or a store of what it left.
        for (let after = pick(3); after > 0; after--)
        {
            main.push(...one(parts));
        }
    }
    main.push(0xff, 0x0d, ...le(DATA + 0x180), 0x0f, 0x85, ...le(start - (main.length + 12)));
    main.push(...FREE.flatMap(r=>[0x89, 0x05 | r << 3, ...le(DATA + 0x100 + r * 4)]),
        0x9c, 0x58, 0x83, 0xe0, 0xef, 0xa3, ...le(DATA + 0x120), 0xfc, 0xf4);
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
            data: [...m.read(DATA, 0x184)],
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
    [1, 10_000_000], [401, 37], [801, 113]]))
{
    test(`registers at ways out and back from calls leave what the interpreter leaves (seeds ${
        first}.., budget ${budget})`, async()=>{
        let translated = 0;
        let returned = 0;
        for (let seed = first; seed < first + 100; seed++)
        {
            const pieces = generate(seed * 7919);
            const interpreted = await runProgram(pieces, { translate: false });
            assert.equal(interpreted.stop.reason, 'halt', `seed ${seed} halts`);
            // Callees formed in and called apart, and every call apart with its
            // profile counts, which say how many `ret`s came back to a wasm call.
            for (const config of [{}, { formDepth: 0, blockProfile: true }])
            {
                const ran = await runProgram(pieces, { yieldChunk: budget, ...config });
                assert.deepEqual({ ...ran, translated: 0, returned: 0 },
                    { ...interpreted, returned: 0 }, `seed ${seed}, ${JSON.stringify(config)}`);
                translated += ran.translated > 0 ? 1 : 0;
                returned += ran.returned;
            }
        }
        assert.ok(translated > 150, `${translated} runs ran translated code`);
        assert.ok(returned > 1000, `${returned} returns to a wasm call`);
    });
}
