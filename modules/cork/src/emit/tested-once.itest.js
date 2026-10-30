/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of an entry test passed by where it passed before for what the
 * registers hold (`planTestedOnce` in region.js): seeded loops whose head
 * jumps into a block that takes its windows from the block before it -- the
 * shape of a region entered at a loop's latch -- the store below that block
 * through a register that a later block may move, past a page that cannot be
 * written, and a port write after the store whose host marks a page that
 * cannot be written either, where the store may go next. Translated, with
 * `precise` and without, against the model: the same exit, at the same
 * instruction, with the same registers and memory.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMachine } from '../machine.js';
import { createTestMachine } from '../testing/machine.js';
import { decode } from '../decode/decoder.js';
import { createState, evaluate } from '../ir.js';
import { PageFlag } from '../runtime/pages.js';
import { random } from '../testing/sequences.js';

const AT = 0x1000;
const DATA = 0x20000;
const SPAN = 0x58000;
const STACK = 0x80000;
const PORT = 0xe9;
const NAMES = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24];

/**
 * A program of `seed`, entered at the inner loop's head S, laid out one of
 * two ways. Either the loop's jumps back go to S, the outer turn through O
 * among them:
 *
 *     S: arithmetic on eax; dec ecx; jnz T
 *     O: maybe ebx moved; ecx again; dec edi; jz done
 *     P: mov [ebx + d0], esi            the window opened
 *     T: arithmetic; maybe ebx moved; test eax, mask; jz S
 *     X: mov [ebx + d1], eax; maybe ebx moved; maybe a port write; jmp S
 *
 * or the outer loop is a loop of its own, O at its head, under which the
 * inner one turns (`loopDepths`), O's moves and port write between:
 *
 *     O: maybe ebx moved; maybe a port write; ecx again; dec edi; jz done;
 *        maybe every other turn jnz S, past P
 *     P, T: as above
 *     X: mov [ebx + d1], eax; maybe ebx moved; jmp S
 *     S: arithmetic on eax; dec ecx; jnz T; jmp O
 *
 * T's entry test covers X's store; S, which leaves ebx as it is, is the way in
 * that may pass it by.
 *
 * @param {number} seed
 */
function program(seed){
    const draw = random(seed);
    const next = ()=>Math.floor(draw() * 4294967296);
    const pick = (/** @type {number} */ n)=>next() % n;
    const code = [];
    /** rel32 fields to patch: [at, label]. @type {[number, string][]} */
    const patches = [];
    /** @type {Record<string, number>} */
    const labels = {};
    const jump = (/** @type {number[]} */ opcode, /** @type {string} */ to)=>{
        code.push(...opcode, 0, 0, 0, 0);
        patches.push([code.length - 4, to]);
    };
    const arithmetic = ()=>{
        for (let k = pick(3); k > 0; k--)
        {
            const form = pick(3);
            if (form === 0)
            {
                code.push(0x69, 0xc0, ...u32(0x9e3779b1));         // imul eax, eax, k
            }
            else if (form === 1)
            {
                code.push(0x05, ...u32(next()));                    // add eax, imm
            }
            else
            {
                code.push(0x31, 0xf0);                              // xor eax, esi
            }
        }
    };
    // A move of ebx: by some bytes, across a page (once an outer turn), back to
    // where it was, or none.
    const move = (/** @type {boolean} */ far)=>{
        const form = far ? pick(5) : [0, 2, 3, 4][pick(4)];
        if (form === 0)
        {
            code.push(0x81, 0xc3, ...u32(4 * (1 + pick(128))));     // add ebx, some
        }
        else if (form === 1)
        {
            code.push(0x81, 0xc3, ...u32(0x1000));                  // add ebx, a page
        }
        else if (form === 2)
        {
            code.push(0x83, 0xc3, 0x10, 0x83, 0xeb, 0x10);          // add ebx, 16; sub ebx, 16
        }
        else if (form === 3)
        {
            code.push(0x8d, 0x9b, ...u32(0x100));                   // lea ebx, [ebx + 256]
        }
    };
    const inner = 1 + pick(40);
    const d0 = 4 * pick(16);
    const d1 = 4 * pick(1000);
    const nested = pick(2) === 0;
    const trap = pick(3) === 0;
    // The host marks the page the store's next turns may reach.
    const port = ()=>{
        const page = DATA + (pick(4) === 0 ? 0 : d1 + 0x1000 * pick(3)) & ~0xfff;
        code.push(0x50, 0xb8, ...u32(page), 0xef, 0x58);           // push eax; mov eax; out; pop
    };
    const head = ()=>{
        labels.S = code.length;
        arithmetic();
        code.push(0x49);                                            // dec ecx
        jump([0x0f, 0x85], 'T');                                    // jnz T
    };
    if (!nested)
    {
        head();
    }
    labels.O = code.length;
    if (pick(2) === 0)
    {
        move(true);
    }
    if (nested && trap)
    {
        port();
    }
    code.push(0xb9, ...u32(inner));                                 // mov ecx, inner
    code.push(0x4f);                                                // dec edi
    jump([0x0f, 0x84], 'done');                                     // jz done
    if (nested && pick(2) === 0)
    {
        // Every other outer turn back into the inner loop past P's test.
        code.push(0xf7, 0xc7, ...u32(1));                           // test edi, 1
        jump([0x0f, 0x85], 'S');                                    // jnz S
    }
    labels.P = code.length;
    // A store, not a read: without `precise` a read is not tested.
    code.push(0x89, 0x73, d0);                                      // mov [ebx + d0], esi
    labels.T = code.length;
    arithmetic();
    if (pick(4) === 0)
    {
        // T itself moves the register its test is placed from.
        move(false);
    }
    code.push(0xa9, ...u32([1, 3, 0x10, 0x80000001][pick(4)]));     // test eax, mask
    jump([0x0f, 0x84], 'S');                                        // jz S
    code.push(0x89, 0x83, ...u32(d1));                              // mov [ebx + d1], eax
    if (pick(2) === 0)
    {
        move(false);
    }
    if (!nested && trap)
    {
        port();
    }
    jump([0xe9], 'S');                                              // jmp S
    if (nested)
    {
        head();
        jump([0xe9], 'O');                                          // jmp O
    }
    labels.done = code.length;
    code.push(0xf4);
    for (const [at, to] of patches)
    {
        code.splice(at, 4, ...u32(labels[to] - (at + 4)));
    }
    // A page the store reaches after a few moves, or none.
    const bad = pick(3) === 0 ? -1 : (DATA + d1 >>> 12) + [0, 1, 1, 2, 3][pick(5)];
    return {
        code, bad, trap, entry: AT + labels.S,
        start: { eax: next(), ebx: DATA, ecx: inner, edx: PORT, esi: next(), edi: 2 + pick(12) },
    };
}

/**
 * Runs the program on a machine of cork's runtime, translated or interpreted
 * (`translate: false`), a slice at a time; its port writes stop it, and the
 * page the value names is marked before it goes on, as a host would.
 *
 * @param {ReturnType<typeof program>} one @param {Record<string, unknown>} config
 */
async function runMachine({ code, bad, entry, start }, config){
    const m = createMachine({ ramSize: 1 << 20, trapPort: PORT,
        config: { hotThreshold: 2, ...config } });
    try
    {
        m.load(AT, code);
        if (bad >= 0)
        {
            m.runtime.pages.markRange(bad * 0x1000, 0x1000, PageFlag.INACCESSIBLE);
        }
        for (const [name, value] of Object.entries(start))
        {
            m.setReg(name, value);
        }
        m.setReg('esp', STACK);
        m.setReg('eip', entry);
        let retired = 0;
        let translated = 0;
        for (;;)
        {
            const stop = await m.run({ maxInstructions: 200_000 - retired });
            retired += stop.retired;
            translated += stop.translated;
            if (stop.reason !== 'trap')
            {
                return {
                    stop: { reason: stop.reason, vector: stop.vector, retired },
                    data: [...m.read(DATA, SPAN)],
                    registers: Object.fromEntries([...NAMES, 'eip'].map(name=>[name, m.reg(name)])),
                    translated,
                };
            }
            m.runtime.pages.markRange(/** @type {number} */ (stop.value) & ~0xfff, 0x1000,
                PageFlag.INACCESSIBLE);
        }
    }
    finally
    {
        m.dispose();
    }
}

test('an entry test passed by for registers it passed for: seeded loops entered at their head,'
    + ' stores past pages that cannot be written, translated against the interpreter', async()=>{
    let faults = 0;
    let trapped = 0;
    let translated = 0;
    for (let seed = 1; seed <= 300; seed++)
    {
        const one = program(seed);
        const chunk = seed % 4 === 0 ? {} : { yieldChunk: [40, 1000, 100_000][seed % 3] };
        const interpreted = await runMachine(one, { translate: false, ...chunk });
        const ran = await runMachine(one, chunk);
        assert.deepEqual({ ...ran, translated: 0 }, { ...interpreted, translated: 0 },
            `seed ${seed}`);
        faults += interpreted.stop.reason === 'fault' ? 1 : 0;
        trapped += one.trap && interpreted.stop.reason === 'fault' ? 1 : 0;
        translated += ran.translated > interpreted.stop.retired / 2 ? 1 : 0;
    }
    assert.ok(faults > 80, `${faults} runs end at a fault`);
    assert.ok(trapped > 20, `${trapped} runs fault after a port write`);
    assert.ok(translated > 150, `${translated} runs ran mostly translated code`);
});

/**
 * The program on the model, whose stores fault on a page marked at the start
 * or by the host at a port write: whether it faulted, and the state and the
 * memory it left.
 *
 * @param {ReturnType<typeof program>} one
 */
function onModel({ code, bad, entry, start }){
    const marked = new Set(bad < 0 ? [] : [bad]);
    const ram = new Uint8Array(1 << 20);
    ram.set(code, AT);
    const view = new DataView(ram.buffer);
    const state = createState({
        read: (address, size)=>(size === 1 ? ram[address] : view.getUint32(address, true)),
        write: (address, size, value)=>{
            if (marked.has(address >>> 12) || marked.has(address + size - 1 >>> 12))
            {
                throw new Error('#GP');
            }
            view.setUint32(address, value, true);
        },
    }, { eip: entry, esp: STACK, fsBase: 0 });
    for (const [name, value] of Object.entries(start))
    {
        state.reg[NAMES.indexOf(name)] = value >>> 0;
    }
    try
    {
        while (!state.halted && state.retired < 200_000)
        {
            const decoded = decode(address=>ram[address], state.eip);
            assert.ok(!('refused' in decoded), 'the model decodes the program');
            evaluate(decoded, state);
            while (state.trapped.length > 0)
            {
                marked.add(/** @type {number} */ (state.trapped.shift()) >>> 12);
            }
        }
    }
    catch (e){
        if (!(e instanceof Error) || e.message !== '#GP')
        {
            throw e;
        }
        return { faulted: true, state, ram };
    }
    return { faulted: false, state, ram };
}

test('a page marked is never written, the host\'s inside the function too: the seeded loops'
    + ' run in one function from their head, against the model', ()=>{
    let stopped = 0;
    let trapped = 0;
    for (let seed = 1; seed <= 400; seed++)
    {
        const one = program(seed);
        /** Each page marked, with its bytes then. @type {Map<number, number[]>} */
        const marked = new Map();
        const m = createTestMachine({ precise: false, trapPort: PORT, trap: value=>{
            const page = value >>> 12;
            m.pages.set(page, PageFlag.INACCESSIBLE);
            if (!marked.has(page))
            {
                marked.set(page, [...m.read(page * 0x1000, 0x1000)]);
            }
            return 0;
        } });
        m.write(AT, one.code);
        if (one.bad >= 0)
        {
            m.pages.set(one.bad, PageFlag.INACCESSIBLE);
            marked.set(one.bad, [...m.read(one.bad * 0x1000, 0x1000)]);
        }
        for (const [name, value] of Object.entries(one.start))
        {
            m.setReg(name, value);
        }
        m.setReg('esp', STACK);
        m.setEflags(2);
        // Without an interpreter, an entry test that finds a marked page ends
        // the run there (-2), and a store's own test at the store (a fault):
        // either way before the store, where the model faults, or earlier.
        const exit = m.runProgram(one.entry);
        const model = onModel(one);
        const what = `seed ${seed}`;
        for (const [page, bytes] of marked)
        {
            assert.deepEqual([...m.read(page * 0x1000, 0x1000)], bytes,
                `${what}: page 0x${page.toString(16)} unwritten once marked`);
        }
        if (exit.kind === 3)
        {
            assert.ok(!model.faulted, `${what}: halted where the model faults`);
            for (let r = 0; r < 8; r++)
            {
                assert.equal(m.reg(NAMES[r]), model.state.reg[r], `${what}: ${NAMES[r]}`);
            }
            assert.deepEqual([...m.read(DATA, SPAN)], [...model.ram.subarray(DATA, DATA + SPAN)],
                `${what}: memory`);
        }
        else
        {
            stopped++;
            trapped += one.trap ? 1 : 0;
        }
    }
    assert.ok(stopped > 100, `${stopped} runs stopped at a page marked`);
    assert.ok(trapped > 20, `${trapped} of them with a port write`);
});
