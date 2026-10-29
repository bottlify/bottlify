/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A call that calls the function its target's first slot of the entry hash
 * names (`linkedCall` in emit/integer.js) -- a direct one's slot known as it is
 * emitted, an indirect one's hashed from the address it calls -- beside one that
 * goes through the transfer (`linkedCalls: false`): every program run both ways, and the two
 * must leave the same memory, registers and instruction count. The programs
 * are generated to meet every answer the slot can give: a function compiled for
 * any top, one compiled for the top its caller holds and for another, a
 * function that does nothing and a thunk to one, a function whose address
 * takes the slot another holds, a function the program rewrites as it runs, an
 * indirect call among them, budgets spent inside the callees.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slotOf } from './entries.js';
import { createMachine } from '../machine.js';
import { features } from '../wasm/features.js';

const CODE = 0x401000;
const FUNCTIONS = 0x402000;
// On a page of their own: the program's stores into one leave its callers' code alone.
const PATCHED = 0x420000;
// Where a function whose address takes another's first slot is looked for.
const FAR = 0x900000;
const DATA = 0x500000;
const CONSTANTS = 0x500800;
const STACK = 0xf00000;
const HASH_SLOTS = 1 << 16;
const SHIFT = 32 - Math.log2(HASH_SLOTS);
const DOUBLES = [1.5, -2.25, 3e10, 1e-20, 0.1, -7, 12345.678, 2 / 3];
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi', 'eip'];

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/**
 * @typedef {object} Fn
 * @property {number} at       where it lies
 * @property {number[]} code   placed there, its calls' displacements filled in by `place`
 * @property {number} pops     the bytes past the return address its `ret` pops: 0 or 4
 * @property {{ at: number, to: number }[]} calls  each direct call's displacement, by offset
 */

/**
 * A program's generator, deterministic from its seed.
 *
 * @param {number} seed
 * @returns {{ at: number, code: number[] }[]}  the pieces of code, each at its address
 */
function generate(seed){
    let state = seed >>> 0;
    /** @param {number} n */
    const pick = n=>{
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        return (state >>> 8) % n;
    };
    let slot = 0;
    const storeInt = ()=>[0xa3, ...le(DATA + (slot++ % 64) * 4)]; // mov [m32], eax
    const storeDouble = ()=>[0xdd, 0x1d, ...le(DATA + 0x200 + (slot++ % 32) * 8)]; // fstp qword
    const loadDouble = ()=>[0xdd, 0x05, ...le(CONSTANTS + pick(8) * 8)]; // fld qword
    const mix = ()=>[
        ()=>[0x05, ...le(pick(1 << 30))], // add eax, imm32
        ()=>[0x31, 0xc2], // xor edx, eax
        ()=>[0x6b, 0xc0, 3 + pick(60)], // imul eax, eax, imm8
        ()=>[0x8d, 0x44, 0x50, pick(128)], // lea eax, [eax+edx*2+imm8]
        ()=>[0xc1, 0xc0, 1 + pick(31)], // rol eax, imm8
        ()=>[0x01, 0xc3], // add ebx, eax
        ()=>[0x31, 0xde], // xor esi, ebx
        ()=>[0x01, 0xd7], // add edi, edx
        ()=>[0x03, 0x05, ...le(DATA + pick(64) * 4)], // add eax, [m32]
    ][pick(9)]();

    /** @type {Fn[]} */
    const fns = [];
    /** @param {Fn} fn */
    const add = fn=>fns.push(fn) - 1;
    let next = FUNCTIONS;
    /** @param {number} size */
    const room = size=>{
        const at = next;
        next += (size + 15) & ~15;
        return at;
    };

    // A call to fn from code being built: an argument pushed for a `ret 4`.
    /** @param {number[]} code @param {{ at: number, to: number }[]} calls @param {number} to */
    const call = (code, calls, to)=>{
        if (fns[to].pops === 4)
        {
            code.push(0x68, ...le(pick(1 << 16))); // push imm32
        }
        code.push(0xe8, 0, 0, 0, 0);
        calls.push({ at: code.length - 4, to });
    };

    // Functions that do nothing: `ret` and `ret 4`, and thunks to them and to others.
    const empty = add({ at: room(1), code: [0xc3], pops: 0, calls: [] });
    const emptyPops = add({ at: room(3), code: [0xc2, 0x04, 0x00], pops: 4, calls: [] });
    // Functions compiled for any top: integer work, an argument read, calls of their own.
    /** @type {number[]} */
    const plain = [];
    for (let k = 1 + pick(4); k > 0; k--)
    {
        const pops = pick(3) === 0 ? 4 : 0;
        // push ebp; mov ebp, esp; [mov eax, [ebp+8]]
        const code = [0x55, 0x89, 0xe5, ...pops ? [0x8b, 0x45, 0x08] : []];
        /** @type {{ at: number, to: number }[]} */
        const calls = [];
        for (let part = 1 + pick(4); part > 0; part--)
        {
            code.push(...mix());
            if (pick(4) === 0)
            {
                // Into a function made before this one: no call goes round.
                const callees = [empty, emptyPops, ...plain];
                call(code, calls, callees[pick(callees.length)]);
            }
        }
        code.push(0x5d, ...pops ? [0xc2, 0x04, 0x00] : [0xc3]);
        plain.push(add({ at: room(code.length), code, pops, calls }));
    }
    // Functions with x87 in them, compiled for the top they are entered at.
    /** @type {number[]} */
    const floats = [];
    for (let k = 1 + pick(3); k > 0; k--)
    {
        const code = [...loadDouble(), 0xdc, 0x0d, ...le(CONSTANTS + pick(8) * 8)];
        if (pick(2))
        {
            code.push(0xd9, 0xfa); // fsqrt
        }
        code.push(...storeDouble(), ...mix(), 0xc3);
        floats.push(add({ at: room(code.length), code, pops: 0, calls: [] }));
    }
    // Thunks: a jump to a function that does nothing, or to one that does something.
    /** @type {number[]} */
    const thunks = [];
    for (const to of [pick(2) ? empty : emptyPops, plain[pick(plain.length)]])
    {
        const fn = { at: room(5), code: [0xe9, 0, 0, 0, 0], pops: fns[to].pops,
            calls: [{ at: 1, to }] };
        thunks.push(add(fn));
    }
    // A function at the address whose first slot another function's address takes.
    const shared = [...plain, ...floats][pick(plain.length + floats.length)];
    let far = FAR + pick(256);
    while (slotOf(far, SHIFT) !== slotOf(fns[shared].at, SHIFT))
    {
        far++;
    }
    const partner = add({ at: far, code: [0x55, 0x89, 0xe5, ...mix(), ...mix(), 0x5d, 0xc3],
        pops: 0, calls: [] });
    // A function the program rewrites: the imm32 of its `add eax` (at offset 4).
    const patched = add({ at: PATCHED,
        code: [0x55, 0x89, 0xe5, 0x05, ...le(pick(1 << 20)), 0x31, 0xc2, 0x5d, 0xc3],
        pops: 0, calls: [] });

    const callees = [empty, emptyPops, ...plain, ...floats, ...thunks, shared, partner,
        ...pick(3) === 0 ? [patched] : []];
    // mov ecx, n; L: push ecx; calls, each maybe with an x87 value held across it, maybe
    // through edi; [every eighth turn: inc dword [patched's imm32]]; pop ecx; dec ecx; jnz L;
    // the registers stored; hlt
    // mov eax / edx / ebx / esi / edi, imm32; mov ecx, n
    const main = [0xb8, 0xba, 0xbb, 0xbe, 0xbf].flatMap(op=>[op, ...le(1 + pick(1 << 30))]);
    main.push(0xb9, ...le(30 + pick(70)));
    /** @type {{ at: number, to: number }[]} */
    const calls = [];
    const loop = [0x51];
    for (let site = 2 + pick(6); site > 0; site--)
    {
        const to = callees[pick(callees.length)];
        const held = pick(3) === 0;
        if (held)
        {
            loop.push(...loadDouble());
        }
        if (pick(5) === 0)
        {
            if (fns[to].pops === 4)
            {
                loop.push(0x68, ...le(pick(1 << 16)));
            }
            loop.push(0xbf, ...le(fns[to].at), 0xff, 0xd7); // mov edi, fn; call edi
        }
        else
        {
            call(loop, calls, to);
        }
        if (held)
        {
            loop.push(0xd9, 0xe1, ...storeDouble()); // fabs; fstp qword
        }
        loop.push(...mix(), ...storeInt());
    }
    if (callees.includes(patched))
    {
        // test cl, 7; jnz over; inc dword [m32]
        loop.push(0xf6, 0xc1, 0x07, 0x75, 0x06, 0xff, 0x05, ...le(PATCHED + 4));
    }
    loop.push(0x59, 0x49, 0x0f, 0x85, ...le(-(loop.length + 8)));
    const start = main.length;
    main.push(...loop);
    for (const [i, reg] of [0xa3, 0x1d, 0x15, 0x35, 0x3d].entries())
    {
        // mov [m32], eax / ebx / edx / esi / edi
        main.push(...i === 0 ? [reg] : [0x89, reg], ...le(DATA + 0x380 + i * 4));
    }
    main.push(0xf4);
    const mainFn = { at: CODE, code: main, pops: 0,
        calls: calls.map(one=>({ at: start + one.at, to: one.to })) };
    return [mainFn, ...fns].map(fn=>place(fn, fns));
}

/** @param {Fn} fn @param {Fn[]} fns */
function place(fn, fns){
    const code = [...fn.code];
    for (const { at, to } of fn.calls)
    {
        code.splice(at, 4, ...le(fns[to].at - (fn.at + at + 4)));
    }
    return { at: fn.at, code };
}

/**
 * Runs a program to its `hlt` on a machine: translated once a start is hot, a
 * store into translated code dropping the regions there, each run of translated
 * code given `budget`.
 *
 * @param {{ at: number, code: number[] }[]} pieces @param {number} budget
 * @param {Record<string, unknown>} config  the translator's settings
 * @param {import('../wasm/features.js').Features} [host]  the host the code is made for, this
 *     one's by default
 */
async function runProgram(pieces, budget, config, host = undefined){
    const m = createMachine({ ramSize: 16 << 20, config: { hashSlots: HASH_SLOTS, hotThreshold: 2,
        yieldChunk: budget, leafCalls: false, ...config }, features: host });
    try
    {
        assert.equal(m.layout.hashShift, SHIFT);
        for (const { at, code } of pieces)
        {
            m.load(at, code);
        }
        m.load(CONSTANTS, [...new Uint8Array(new Float64Array(DOUBLES).buffer)]);
        m.setReg('esp', STACK);
        m.setReg('eip', CODE);
        const stop = await m.run({ maxInstructions: 10_000_000 });
        assert.equal(stop.reason, 'halt');
        assert.ok(stop.translated > 0, 'translated code ran');
        const diagnostics = /** @type {any} */ (m.diagnostics());
        return {
            observed: {
                data: [...m.read(DATA, 0x400)],
                registers: Object.fromEntries(REGISTERS.map(name=>[name, m.reg(name)])),
                retired: stop.retired,
            },
            mechanisms: /** @type {Record<string, number> | undefined} */ (diagnostics.mechanisms),
            /** Transfers through the entry hash, by target. @type {[number, number][]} */
            transferTargets: diagnostics.transferTargets ?? [],
        };
    }
    finally
    {
        m.dispose();
    }
}

/**
 * The hosts the calls are made for: this one, and an arm64 one, whose linked call tests the key
 * and the slot's top as one condition (`linkedCall`). Each takes every other eight seeds, so
 * the two run in the time one took.
 *
 * @type {[string, import('../wasm/features.js').Features | undefined][]}
 */
const HOSTS = [['this host', undefined], ['an arm64 host', { ...features(), armHost: true }]];

for (const [which, [name, host]] of HOSTS.entries())
{
    for (const [first, budget] of [[1, 10_000_000], [1001, 61]])
    {
        test(`direct calls linked at the call leave what calls through the transfer leave (seeds ${
            first}.., every other eight from the ${which === 0 ? 'first' : 'second'}, budget ${
            budget}, ${name})`, async()=>{
            const seen = { linked: 0, transfers: 0, empty: 0, elsewhere: 0 };
            for (let seed = first; seed < first + 80; seed++)
            {
                if (Math.floor((seed - first) / 8) % HOSTS.length !== which)
                {
                    continue;
                }
                const pieces = generate(seed * 7919);
                const through = await runProgram(pieces, budget, { linkedCalls: false }, host);
                const linked = await runProgram(pieces, budget, {}, host);
                assert.ok(through.observed.data.some(byte=>byte !== 0), `seed ${seed} stores`);
                assert.deepEqual(linked.observed, through.observed, `seed ${seed}`);
                if (seed % 8 !== 0)
                {
                    continue;
                }
                // Every eighth seed again with the profile's counts, which say which way went.
                const off = await runProgram(pieces, budget,
                    { linkedCalls: false, blockProfile: true }, host);
                const on = await runProgram(pieces, budget, { blockProfile: true }, host);
                assert.deepEqual(off.observed, through.observed, `seed ${seed}, profiled`);
                assert.deepEqual(on.observed, through.observed, `seed ${seed}, profiled`);
                const before = /** @type {Record<string, number>} */ (off.mechanisms);
                const after = /** @type {Record<string, number>} */ (on.mechanisms);
                assert.equal(before.CALL_LINKED, 0, `seed ${seed}: off, no call is linked`);
                assert.equal(after.CALL_REL, before.CALL_REL, `seed ${seed}: as many direct calls`);
                assert.equal(after.TRANSFER + after.CALL_LINKED, before.TRANSFER,
                    `seed ${seed}: each linked call one transfer less`);
                seen.linked += after.CALL_LINKED;
                seen.transfers += after.TRANSFER;
                seen.empty += after.EMPTY_RETURN;
                seen.elsewhere += after.CALL_ELSEWHERE;
            }
            // Each answer the slot gives is met: linked, and through the transfer -- a function
            // that does nothing among them.
            assert.ok(seen.linked > 0, `calls linked: ${JSON.stringify(seen)}`);
            assert.ok(seen.transfers > 0 && seen.empty > 0, `calls through the transfer: ${
                JSON.stringify(seen)}`);
            if (budget < 100)
            {
                assert.ok(seen.elsewhere > 0, `calls whose callee ran out of budget: ${
                    JSON.stringify(seen)}`);
            }
        });
    }

    test(`a direct call is linked where its target's first slot holds it for the machine's top,`
        + ` and goes through the transfer where the slot holds another (${name})`, async()=>{
        // mov ecx, 50; L: call A; fld1; call X; fld1; faddp; fstp qword [m]; call E; call B;
        // dec ecx; jnz L; hlt -- A: integer work, compiled for any top. X: x87, entered with one
        // value held, compiled for top 7. E: `ret`, a function that does nothing. B: at the
        // address whose first slot is A's, translated after it.
        const TURNS = 50;
        const A = FUNCTIONS;
        const X = FUNCTIONS + 0x40;
        const E = FUNCTIONS + 0x80;
        let B = FAR;
        while (slotOf(B, SHIFT) !== slotOf(A, SHIFT))
        {
            B++;
        }
        const loop = [0xe8, 0, 0, 0, 0, 0xd9, 0xe8, 0xe8, 0, 0, 0, 0, 0xd9, 0xe8, 0xde, 0xc1,
            0xdd, 0x1d, ...le(DATA + 8), 0xe8, 0, 0, 0, 0, 0xe8, 0, 0, 0, 0, 0x49];
        const main = [0xb9, ...le(TURNS), ...loop, 0x0f, 0x85, ...le(-(loop.length + 6)), 0xf4];
        for (const [at, to] of [[5, A], [12, X], [27, E], [32, B]])
        {
            main.splice(at + 1, 4, ...le(to - (CODE + at + 5)));
        }
        const pieces = [
            { at: CODE, code: main },
            { at: A, code: [0x40, 0x01, 0xc3, 0xc3] }, // inc eax; add ebx, eax; ret
            { at: X, code: [0xd9, 0xe8, 0xde, 0xc1, 0xdd, 0x15, ...le(DATA), 0xc3] }, // fst qword
            { at: E, code: [0xc3] },
            { at: B, code: [0x42, 0xc3] }, // inc edx; ret
        ];
        const through = await runProgram(pieces, 10_000_000,
            { linkedCalls: false, blockProfile: true }, host);
        const linked = await runProgram(pieces, 10_000_000, { blockProfile: true }, host);
        assert.deepEqual(linked.observed, through.observed);
        const off = new Map(through.transferTargets);
        const on = new Map(linked.transferTargets);
        const calls = (/** @type {number} */ to)=>off.get(to) ?? 0;
        assert.ok(calls(A) >= TURNS - 3 && calls(X) >= TURNS - 3,
            `off, A and X are called through the transfer: ${JSON.stringify([...off])}`);
        assert.equal(on.get(A), undefined, 'A\'s calls linked, none through the transfer');
        assert.equal(on.get(X), undefined, 'X\'s, for the top the call holds');
        assert.equal(linked.mechanisms?.CALL_LINKED, calls(A) + calls(X));
        assert.equal(on.get(E), calls(E), 'E, a function that does nothing, through the transfer');
        assert.equal(linked.mechanisms?.EMPTY_RETURN, calls(E), 'returned from there');
        assert.ok(calls(B) >= TURNS - 3 && on.get(B) === calls(B),
            'B, whose first slot holds A, through the transfer');
        assert.equal(on.size, off.size - 2, 'and nothing else changed way');
    });
}
