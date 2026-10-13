/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * x87 code that calls: every program run twice, its calls made as wasm calls
 * (`callReturn`) and by leaving the region, and the two runs must leave the
 * same bytes. The programs are generated in the shapes a compiler gives float
 * code: functions taking a double on the stack and returning one in ST0,
 * calling one another, branching on an FPU compare through the status word,
 * converting with the rounding mode set and put back (`_ftol`), loading
 * another control word after a call, a value held on the stack across a
 * call, direct and indirect calls, and the regions' budgets running out
 * inside a callee. Every result goes to memory as it is made. Beside them, a
 * callee formed into its caller that makes calls of its own.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownLayout, pagesFor, tablesSize } from './layout.js';
import { createCorkRuntime } from './runtime.js';
import { blockState, interpret } from '../interp.js';

const CODE = 0x401000;
const DATA = 0x500000;
const CONSTANTS = 0x500800;
const WORDS = 0x500900;
const DOUBLES = [1.5, -2.25, 3e10, 1e-20, 0.1, -7, 12345.678, 2 / 3];
const INTEGERS = [3, -100000, 7, 2147483647];
/** Round to nearest at extended, double and single precision; toward zero at extended. */
const CONTROL_WORDS = [0x37f, 0x27f, 0x07f, 0xf7f];

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/**
 * A program's generator, deterministic from its seed.
 *
 * @param {number} seed
 * @returns {number[]}  the code, placed at CODE
 */
function generate(seed){
    let state = seed >>> 0;
    /** @param {number} n */
    const pick = n=>{
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) % n;
    };
    let slot = 0;
    const storeDouble = ()=>[0xdd, 0x1d, ...le(DATA + (slot++ % 48) * 8)];
    const loadWord = ()=>[0xd9, 0x2d, ...le(WORDS + pick(4) * 2)];
    /** @type {[() => number[], number, number][]} code, the depth it needs, what it adds */
    const ops = [
        [()=>[0xd9, 0xe8], 0, 1], // fld1
        [()=>[0xd9, 0xee], 0, 1], // fldz
        [()=>[0xd9, 0xeb], 0, 1], // fldpi
        [()=>[0xdd, 0x05, ...le(CONSTANTS + pick(8) * 8)], 0, 1], // fld qword
        [()=>[0xdb, 0x05, ...le(CONSTANTS + 0x80 + pick(4) * 4)], 0, 1], // fild dword
        [()=>[0xd9, 0xc0], 1, 1], // fld st0
        [()=>[0xde, 0xc1], 2, -1], // faddp
        [()=>[0xde, 0xc9], 2, -1], // fmulp
        [()=>[0xde, 0xe9], 2, -1], // fsubp
        [()=>[0xde, 0xf9], 2, -1], // fdivp
        [()=>[0xd8, 0xc1], 2, 0], // fadd st0, st1
        [()=>[0xd9, 0xc9], 2, 0], // fxch
        [()=>[0xd9, 0xe0], 1, 0], // fchs
        [()=>[0xd9, 0xe1], 1, 0], // fabs
        [()=>[0xd9, 0xfa], 1, 0], // fsqrt
        [()=>[0xd9, 0xfc], 1, 0], // frndint
        [()=>[0xd9, 0xfe], 1, 0], // fsin
        [()=>[0xdc, 0x0d, ...le(CONSTANTS + pick(8) * 8)], 1, 0], // fmul qword
        [()=>[0xdb, 0x1d, ...le(DATA + 0x200 + (slot++ % 32) * 4)], 1, -1], // fistp dword
        [()=>[0xd9, 0x3d, ...le(DATA + 0x3d0 + (slot++ % 16) * 2)], 0, 0], // fnstcw
    ];
    /** @param {number} depth @param {number} count */
    const straight = (depth, count)=>{
        /** @type {number[]} */
        const code = [];
        for (let i = 0; i < count; i++)
        {
            const fits = ops.filter(([, needs, adds])=>depth >= needs && depth + adds <= 6
                && depth + adds >= 0);
            const [emit, , adds] = fits[pick(fits.length)];
            code.push(...emit());
            depth += adds;
        }
        return { code, depth };
    };
    /** @param {number} depth */
    const drain = depth=>Array.from({ length: Math.max(0, depth) }, storeDouble).flat();
    // fld st0; fcomp qword; fnstsw ax; then test ah or sahf, and a branch over a block that
    // leaves the stack as deep as it found it.
    /** @param {number} depth */
    const compareBranch = depth=>{
        const inner = straight(depth, 1 + pick(3));
        const body = [...inner.code, ...drain(inner.depth - depth),
            ...Array.from({ length: Math.max(0, depth - inner.depth) }, ()=>[0xd9, 0xee]).flat()];
        const how = pick(3);
        return [0xd9, 0xc0, 0xdc, 0x1d, ...le(CONSTANTS + pick(8) * 8), 0xdf, 0xe0,
            ...(how === 0 ? [0xf6, 0xc4, 0x41] : how === 1 ? [0x9e] : [0xf6, 0xc4, 0x05]),
            how === 0 ? 0x75 : how === 1 ? 0x7a : 0x7b, body.length, ...body];
    };
    // _ftol's shape: the word saved, the rounding set to zero, fistp, the word put back.
    // The word is saved where the runs are compared: what a callee sees of it is a result.
    const ftol = ()=>{
        const saved = DATA + 0x390 + (slot++ % 16) * 4;
        return [0xd9, 0x3d, ...le(saved), 0x66, 0xa1, ...le(saved), 0x80, 0xcc, 0x0c,
            0x66, 0xa3, ...le(WORDS + 10), 0xd9, 0x2d, ...le(WORDS + 10),
            0xdb, 0x1d, ...le(DATA + 0x300 + (slot++ % 16) * 4), 0xd9, 0x2d, ...le(saved)];
    };

    const count = 1 + pick(3);
    const returns = Array.from({ length: count }, ()=>pick(3) > 0);
    /** @type {{ code: number[], calls: { to: number, at: number }[] }[]} */
    const functions = [];
    for (let k = 0; k < count; k++)
    {
        // push ebp; mov ebp, esp; fld qword [ebp+8]
        const code = [0x55, 0x89, 0xe5, 0xdd, 0x45, 0x08];
        /** @type {{ to: number, at: number }[]} */
        const calls = [];
        let depth = 1;
        for (let part = 1 + pick(3); part > 0; part--)
        {
            const kind = pick(5);
            if (kind === 0)
            {
                code.push(...compareBranch(depth));
            }
            else if (kind === 1 && depth >= 2)
            {
                code.push(...ftol());
                depth--;
            }
            else if (kind === 2 && k + 1 < count)
            {
                // The next function called with a copy of ST0, its float added in.
                code.push(0xd9, 0xc0, 0x83, 0xec, 0x08, 0xdd, 0x1c, 0x24, 0xe8, 0, 0, 0, 0);
                calls.push({ to: k + 1, at: code.length - 4 });
                code.push(0x83, 0xc4, 0x08);
                if (returns[k + 1])
                {
                    code.push(0xde, 0xc1);
                }
                if (pick(2))
                {
                    code.push(...loadWord());
                }
            }
            else if (kind === 3)
            {
                code.push(...loadWord());
            }
            else
            {
                const run = straight(depth, 1 + pick(4));
                code.push(...run.code);
                depth = run.depth;
            }
        }
        const keep = returns[k] ? 1 : 0;
        if (depth < keep)
        {
            code.push(0xd9, 0xe8);
            depth++;
        }
        code.push(...drain(depth - keep), 0x5d, 0xc3);
        functions.push({ code, calls });
    }

    // [fldcw]; mov ecx, n; L: push ecx; [fld1]; fld qword; sub esp, 8; fstp qword [esp];
    // call F0 (direct, or through eax); add esp, 8; [fstp]; [fabs; fstp]; [fldcw];
    // pop ecx; dec ecx; jnz L; fnstsw [..]; fnstcw [..]; hlt
    const held = pick(2);
    const indirect = pick(2);
    // A word loaded ahead of the loop is compiled before the call; one loaded only after
    // the call, in the loop, is compiled after it.
    const main = [...pick(2) ? loadWord() : [], 0xb9, ...le(150 + pick(100))];
    const loop = [0x51];
    if (held)
    {
        loop.push(0xd9, 0xe8);
    }
    loop.push(0xdd, 0x05, ...le(CONSTANTS + pick(8) * 8), 0x83, 0xec, 0x08, 0xdd, 0x1c, 0x24);
    loop.push(...indirect ? [0xb8, 0, 0, 0, 0, 0xff, 0xd0] : [0xe8, 0, 0, 0, 0]);
    const callAt = main.length + loop.length - (indirect ? 6 : 4);
    loop.push(0x83, 0xc4, 0x08);
    if (returns[0])
    {
        loop.push(...storeDouble());
    }
    if (held)
    {
        loop.push(0xd9, 0xe1, ...storeDouble());
    }
    if (pick(2))
    {
        loop.push(...loadWord());
    }
    loop.push(0x59, 0x49, 0x75, -(loop.length + 4) & 0xff);
    const code = [...main, ...loop, 0xdd, 0x3d, ...le(DATA + 0x380), 0xd9, 0x3d,
        ...le(DATA + 0x384), 0xf4];
    /** @type {number[]} */
    const starts = [];
    for (const fn of functions)
    {
        starts.push(code.length);
        code.push(...fn.code);
    }
    code.splice(callAt, 4, ...indirect ? le(CODE + starts[0]) : le(starts[0] - (callAt + 4)));
    functions.forEach((fn, k)=>{
        for (const { to, at } of fn.calls)
        {
            const from = starts[k] + at;
            code.splice(from, 4, ...le(starts[to] - (from + 4)));
        }
    });
    return code;
}

/**
 * Runs a program to its `hlt`: translated where a region can be made, the
 * interpreter a step at a time where none can, the budget given to each run.
 *
 * @param {number[]} code @param {boolean} callReturn @param {number} budget
 * @param {boolean} [leafCalls]  small callees formed into their callers
 * @param {Record<string, unknown>} [more]  the runtime's other settings
 * @param {(diagnostics: any) => void} [done]  told the runtime's diagnostics at the `hlt`
 * @returns {Promise<Uint8Array>}  what it left in the data area
 */
async function runProgram(code, callReturn, budget, leafCalls = false, more = {},
    done = undefined)
{
    const layout = ownLayout({ ramSize: 16 << 20, hashSlots: 1 << 16 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, tablesSize(layout)) });
    const bytes = ()=>new Uint8Array(memory.buffer);
    const view = ()=>new DataView(memory.buffer);
    view().setUint8(layout.x87Empty, 0xff);
    view().setUint16(layout.x87Control, 0x37f, true);
    // Unless asked, no small callee formed into its caller: every call here is a call.
    /** @type {any} */
    const config = { leafCalls, callReturn, ...more };
    const runtime = createCorkRuntime({
        memory, layout, config,
        read: address=>bytes()[layout.ramBase + address],
        imports: { trap: ()=>0, getEflags: ()=>view().getUint32(layout.eflags, true),
            x87Read: ()=>0, rdtsc: ()=>0n },
    });
    bytes().set(code, layout.ramBase + CODE);
    DOUBLES.forEach((value, i)=>view().setFloat64(layout.ramBase + CONSTANTS + i * 8, value, true));
    INTEGERS.forEach((value, i)=>view().setInt32(layout.ramBase + CONSTANTS + 0x80 + i * 4,
        value, true));
    CONTROL_WORDS.forEach((word, i)=>view().setUint16(layout.ramBase + WORDS + i * 2, word, true));
    view().setUint32(layout.regs + 16, 0x800000, true);
    view().setUint32(layout.eip, CODE, true);
    const eip = ()=>view().getUint32(layout.eip, true);
    for (let turn = 0; turn < 100_000; turn++)
    {
        const top = view().getUint8(layout.x87Top);
        if (runtime.entryOf(eip(), top) < 0)
        {
            runtime.noteHot(eip(), top);
            await runtime.translatePending();
        }
        const entry = runtime.entryOf(eip(), top);
        if (entry < 0)
        {
            const interpreted = blockState({ memory, layout });
            interpreted.syncIn();
            interpret(interpreted, 1, { force: true });
            interpreted.syncOut();
            if (interpreted.halted)
            {
                break;
            }
        }
        else if (runtime.run(entry, budget).kind === 'halt')
        {
            break;
        }
        assert.ok(turn < 100_000 - 1, 'the program halts');
    }
    done?.(runtime.diagnostics());
    return bytes().slice(layout.ramBase + DATA, layout.ramBase + DATA + 0x400);
}

for (const [first, budget] of [[1, 10_000_000], [1001, 61]])
{
    test(`x87 code calling as wasm calls leaves what calling by leaving leaves (seeds ${first}..,`
        + ` budget ${budget})`, async()=>{
        for (let seed = first; seed < first + 150; seed++)
        {
            const code = generate(seed * 7919);
            const plain = await runProgram(code, false, budget);
            const called = await runProgram(code, true, budget);
            assert.ok(plain.some(byte=>byte !== 0), `seed ${seed} stores its results`);
            assert.deepEqual(called, plain, `seed ${seed}`);
        }
    });
}

test('x87 regions compiled each for the precision control it runs under leave what regions'
    + ' testing it at every rounding instruction leave', async()=>{
    // The programs load single, double and extended in their loops and functions: an entry
    // first formed under one meets another, leaves, is compiled for it, and for a test at
    // every rounding instruction once it has met both (`precisionAt`).
    const seen = { wide: 0, narrow: 0, mixed: 0, switches: 0 };
    for (let seed = 2001; seed < 2101; seed++)
    {
        const code = generate(seed * 7919);
        const testing = await runProgram(code, true, 10_000_000, true, { wideFirst: false });
        const own = await runProgram(code, true, 10_000_000, true, {}, diagnostics=>{
            seen.wide += diagnostics.precision.wide;
            seen.narrow += diagnostics.precision.narrow;
            seen.mixed += diagnostics.precision.mixed;
            seen.switches += diagnostics.precisionSwitches;
        });
        assert.deepEqual(own, testing, `seed ${seed}`);
    }
    for (const kind of ['wide', 'narrow', 'mixed', 'switches'])
    {
        assert.ok(seen[/** @type {keyof typeof seen} */ (kind)] > 0, `some entry is ${kind}`);
    }
});

test('a callee formed into its caller hands back the stack its own calls left, where the code'
    + ' after the call is cut', async()=>{
    // mov ecx, 60; mov edi, DATA; L: push ecx; mov eax, ecx; and eax, 1; call M;
    // fstp qword [edi]; add edi, 8; pop ecx; dec ecx; jnz L; hlt
    // M: cmp esi, 12345; je X; call B; R: fadd qword [0.1]; ret; X: jmp esi
    // B: test eax, eax; jnz B2; call F; fmul qword [1.5]; ret
    // B2: call F; fild dword [3]; fmulp; ret
    // F: fld qword [-2.25]; fadd qword [12345.678]; 520 nops; ret
    // M's region forms B in (F, too long to form, is a call); F returns a float, and R is
    // reached from B's two rets at two tops -- the code after B2's call pushes first, so it
    // is compiled for the top the call had -- and is cut. B2's block, ending in its ret,
    // is emitted just before R's exit.
    const code = [
        0xb9, 60, 0, 0, 0, 0xbf, ...le(DATA), 0x51, 0x89, 0xc8, 0x83, 0xe0, 0x01,
        0xe8, 0x0a, 0, 0, 0, 0xdd, 0x1f, 0x83, 0xc7, 0x08, 0x59, 0x49, 0x75, 0xec, 0xf4,
        0x81, 0xfe, 0x39, 0x30, 0, 0, 0x74, 0x0c, 0xe8, 0x09, 0, 0, 0,
        0xdc, 0x05, ...le(CONSTANTS + 0x20), 0xc3, 0xff, 0xe6,
        0x85, 0xc0, 0x75, 0x0c, 0xe8, 0x15, 0, 0, 0, 0xdc, 0x0d, ...le(CONSTANTS), 0xc3,
        0xe8, 0x09, 0, 0, 0, 0xdb, 0x05, ...le(CONSTANTS + 0x80), 0xde, 0xc9, 0xc3,
        0xdd, 0x05, ...le(CONSTANTS + 8), 0xdc, 0x05, ...le(CONSTANTS + 0x30),
        ...new Array(520).fill(0x90), 0xc3,
    ];
    for (const budget of [10_000_000, 61, 13])
    {
        const plain = await runProgram(code, false, budget, true);
        const called = await runProgram(code, true, budget, true);
        const results = new DataView(plain.buffer);
        for (let k = 0; k < 60; k++)
        {
            assert.ok(Number.isFinite(results.getFloat64(k * 8, true)), `result ${k}`);
        }
        assert.deepEqual(called, plain, `budget ${budget}`);
    }
});
