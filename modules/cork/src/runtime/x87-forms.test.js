/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * x87 code in the shapes that make a region's blocks meet the stack at more
 * than one top: small callees formed into their callers and called with
 * values held below, callees that call a float function too long to form
 * (a wasm call under `callReturn`), code after such a call that reads its
 * result first or pushes first, a callee's two ways each ending in its own
 * `ret`, and the method itself entered at two depths. Each program runs
 * translated with its calls made as wasm calls and by leaving, and on the
 * interpreter alone, under `precise`; the three must leave the same bytes,
 * stack words and EIP.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownLayout, pagesFor, tablesSize } from './layout.js';
import { createCorkRuntime } from './runtime.js';
import { blockState, interpret } from '../interp.js';

const CODE = 0x401000;
const DATA = 0x500000;
const CONSTANTS = 0x500800;
const DOUBLES = [1.5, -2.25, 3.75, 0.125, 0.1, -7, 12345.678, 2 / 3];
const INTEGERS = [3, -100, 7, 11];

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/**
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
    const store = ()=>[0xdd, 0x1d, ...le(DATA + (slot++ % 120) * 8)];
    const fld = ()=>[0xdd, 0x05, ...le(CONSTANTS + pick(8) * 8)];
    const fild = ()=>[0xdb, 0x05, ...le(CONSTANTS + 0x80 + pick(4) * 4)];
    const fmul = ()=>[0xdc, 0x0d, ...le(CONSTANTS + pick(8) * 8)];
    /** Straight x87 from `depth` to `depth + rise`, its own values only. @param {number} rise */
    const straight = rise=>{
        /** @type {number[]} */
        const code = [];
        let depth = 0;
        for (let n = 1 + pick(4); n > 0 || depth !== rise; n--)
        {
            const r = pick(8);
            if (depth < rise || (depth < 5 && r < 2))
            {
                code.push(...pick(2) ? fld() : fild());
                depth++;
            }
            else if (depth > rise && depth >= 2 && r < 5)
            {
                code.push(...[[0xde, 0xc1], [0xde, 0xc9], [0xde, 0xe9]][pick(3)]);
                depth--;
            }
            else if (depth > rise)
            {
                code.push(...store());
                depth--;
            }
            else if (depth >= 1 && r < 5)
            {
                code.push(...[[0xd9, 0xe1], [0xd9, 0xe0], fmul()][pick(3)]);
            }
            else if (depth >= 2)
            {
                code.push(0xd9, 0xc9);
            }
        }
        return code;
    };
    /** @type {Map<string, { code: number[], calls: { at: number, to: string }[] }>} */
    const functions = new Map();
    // F returns a float and is too long to form into a caller: every call to it is a call.
    const pad = new Array(520).fill(0x90);
    functions.set('F', { code: [...fld(), ...fmul(), ...pad, 0xc3], calls: [] });
    /** @type {{ name: string, returns: number }[]} */
    const leaves = [];
    for (let k = 0; k < 2 + pick(3); k++)
    {
        const returns = pick(2);
        /** @type {number[]} */
        const code = [];
        /** @type {{ at: number, to: string }[]} */
        const calls = [];
        const callF = ()=>{
            code.push(0xe8, 0, 0, 0, 0);
            calls.push({ at: code.length - 4, to: 'F' });
        };
        // One way through the leaf, ending in its own ret with `returns` values left.
        const way = ()=>{
            const kind = pick(4);
            if (kind === 3)
            {
                code.push(...straight(returns));
            }
            else
            {
                callF();
                // After the call: as it was, or the result read first, or a push first.
                code.push(...kind === 1 ? [...fild(), 0xde, 0xc9] : kind === 2 ? fmul() : []);
                code.push(...returns ? [] : store());
            }
            code.push(0xc3);
        };
        if (pick(2))
        {
            // test eax, bit; jz second; way; second: way
            code.push(0xa9, ...le(1 << pick(4)), 0x0f, 0x84, 0, 0, 0, 0);
            const from = code.length;
            way();
            code.splice(from - 4, 4, ...le(code.length - from));
        }
        way();
        functions.set(`L${k}`, { code, calls });
        leaves.push({ name: `L${k}`, returns });
    }
    // M calls the leaves, each with 0 to 2 values held below.
    /** @type {number[]} */
    const method = [];
    /** @type {{ at: number, to: string }[]} */
    const methodCalls = [];
    for (let part = 2 + pick(4); part > 0; part--)
    {
        const leaf = leaves[pick(leaves.length)];
        const held = pick(3);
        for (let h = 0; h < held; h++)
        {
            method.push(...fld());
        }
        method.push(0xe8, 0, 0, 0, 0);
        methodCalls.push({ at: method.length - 4, to: leaf.name });
        if (leaf.returns)
        {
            method.push(...held && pick(2) ? [0xde, 0xc1] : store());
        }
        for (let h = 0; h < held; h++)
        {
            method.push(...store());
        }
        if (pick(3) === 0)
        {
            method.push(...straight(0));
        }
    }
    method.push(0xc3);
    functions.set('M', { code: method, calls: methodCalls });
    // mov ecx, n; L: push ecx; mov eax, ecx; test cl, 1; jz plain; [fld]...; call M; [fstp]...;
    // jmp next; plain: call M; next: pop ecx; dec ecx; jnz L; fnstsw ax; mov [..], ax; hlt
    const main = [0xb9, ...le(30 + pick(30))];
    const loop = main.length;
    main.push(0x51, 0x89, 0xc8);
    const held = pick(3);
    /** @type {number[]} */
    const holding = [];
    for (let h = 0; h < held; h++)
    {
        holding.push(...fld());
    }
    const heldCall = holding.length + 1;
    holding.push(0xe8, 0, 0, 0, 0);
    for (let h = 0; h < held; h++)
    {
        holding.push(...store());
    }
    main.push(0xf6, 0xc1, 0x01, 0x74, holding.length + 2);
    const holdingAt = main.length;
    main.push(...holding, 0xeb, 5, 0xe8, 0, 0, 0, 0);
    const mainCalls = [{ at: holdingAt + heldCall, to: 'M' }, { at: main.length - 4, to: 'M' }];
    main.push(0x59, 0x49);
    main.push(0x0f, 0x85, ...le(loop - (main.length + 6)));
    main.push(0xdf, 0xe0, 0x66, 0xa3, ...le(DATA + 0x3f0), 0xf4);
    // The functions in a shuffled order after main: which block is emitted before which.
    const order = [...functions.keys()];
    for (let i = order.length - 1; i > 0; i--)
    {
        const j = pick(i + 1);
        [order[i], order[j]] = [order[j], order[i]];
    }
    const code = [...main];
    /** @type {Map<string, number>} */
    const starts = new Map();
    for (const name of order)
    {
        starts.set(name, code.length);
        code.push(.../** @type {{ code: number[] }} */ (functions.get(name)).code);
    }
    /** @param {number} from @param {string} to */
    const link = (from, to)=>code.splice(from, 4,
        ...le(/** @type {number} */ (starts.get(to)) - (from + 4)));
    for (const call of mainCalls)
    {
        link(call.at, call.to);
    }
    for (const name of order)
    {
        for (const call of /** @type {{ calls: { at: number, to: string }[] }} */ (
            functions.get(name)).calls)
        {
            link(/** @type {number} */ (starts.get(name)) + call.at, call.to);
        }
    }
    return code;
}

/**
 * Runs a program to its `hlt`: translated where a region can be made and the
 * interpreter up to the next place with one where none can, or on the
 * interpreter alone (`mode` 'model').
 *
 * @param {number[]} code @param {'model' | 'leaving' | 'called'} mode @param {number} budget
 */
async function runProgram(code, mode, budget){
    const layout = ownLayout({ ramSize: 16 << 20, hashSlots: 1 << 16 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, tablesSize(layout)) });
    const bytes = ()=>new Uint8Array(memory.buffer);
    const view = ()=>new DataView(memory.buffer);
    view().setUint8(layout.x87Empty, 0xff);
    view().setUint16(layout.x87Control, 0x37f, true);
    /** @type {any} */
    const config = { callReturn: mode === 'called', precise: true };
    const runtime = createCorkRuntime({
        memory, layout, config,
        read: address=>bytes()[layout.ramBase + address],
        imports: { trap: ()=>0, rdtsc: ()=>0n },
    });
    bytes().set(code, layout.ramBase + CODE);
    DOUBLES.forEach((value, i)=>view().setFloat64(layout.ramBase + CONSTANTS + i * 8, value, true));
    INTEGERS.forEach((value, i)=>view().setInt32(layout.ramBase + CONSTANTS + 0x80 + i * 4,
        value, true));
    view().setUint32(layout.regs + 16, 0x800000, true);
    view().setUint32(layout.eip, CODE, true);
    const eip = ()=>view().getUint32(layout.eip, true);
    const translated = mode !== 'model';
    let halted = false;
    for (let turn = 0; turn < 100_000 && !halted; turn++)
    {
        const top = view().getUint8(layout.x87Top);
        if (translated && runtime.entryOf(eip(), top) < 0)
        {
            runtime.noteHot(eip(), top);
            await runtime.translatePending();
        }
        const entry = translated ? runtime.entryOf(eip(), top) : -1;
        if (entry < 0)
        {
            const interpreted = blockState({ memory, layout });
            interpreted.syncIn();
            // Alone, to the hlt; otherwise to the next place a region can be entered.
            const more = ()=>!interpreted.halted
                && (!translated || runtime.entryOf(interpreted.eip, interpreted.top) < 0);
            interpret(interpreted, 1, { force: true });
            while (more())
            {
                interpret(interpreted, 1, { force: true });
            }
            interpreted.syncOut();
            halted = interpreted.halted;
        }
        else
        {
            halted = runtime.run(entry, budget).kind === 'halt';
        }
    }
    assert.ok(halted, `${mode} halts`);
    return {
        data: bytes().slice(layout.ramBase + DATA, layout.ramBase + DATA + 0x400),
        words: [view().getUint8(layout.x87Top), view().getUint8(layout.x87Empty), eip()],
    };
}

test('x87 code whose blocks meet the stack at two tops runs as on the interpreter alone,'
    + ' its calls made as wasm calls or by leaving', async()=>{
    for (let seed = 1; seed <= 40; seed++)
    {
        const code = generate(seed * 7919);
        for (const budget of [10_000_000, 61, 17])
        {
            const model = await runProgram(code, 'model', budget);
            for (const mode of /** @type {const} */ (['leaving', 'called']))
            {
                const run = await runProgram(code, mode, budget);
                assert.deepEqual(run.words, model.words, `seed ${seed}, budget ${budget}, ${mode}`);
                assert.deepEqual(run.data, model.data, `seed ${seed}, budget ${budget}, ${mode}`);
            }
        }
    }
});
