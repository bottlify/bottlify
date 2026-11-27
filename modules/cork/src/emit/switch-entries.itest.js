/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of a switch's cases picked by its index before the table is read
 * (`casesByEntry`, reads untested), and of its bound test taken into that
 * `br_table` (`emitFusedSwitch` in region.js): seeded switch loops, the
 * index masked or bounded by `cmp; ja`, whose cases rewrite the table as they
 * run -- an entry pointed at another case, at code the region did not form,
 * back again -- run translated and on the model from the same start, every
 * register, the flags, the memory the program wrote and the instructions it
 * retired compared. Under `precise` the jump reads its target first; both are
 * run.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { decode } from '../decode/decoder.js';
import { createState, evaluate } from '../ir.js';
import { random } from '../testing/sequences.js';

const CODE = 0x1000;
const TABLE = 0x8000;
const OUT = 0x9000;
const STACK = 0x80000;
const NAMES = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24];

/**
 * A switch loop of `seed`: `count` turns of an index masked to the table's
 * entries (a power of two) or bounded by a compare, a jump through the table,
 * cases that add their own constant to ebx and some that rewrite an entry,
 * and stubs no table entry names, which a rewrite may send the jump to.
 *
 * @param {number} seed
 * @returns {{ code: number[], table: number[] }}
 */
function program(seed){
    const draw = random(seed);
    const next = ()=>Math.floor(draw() * 4294967296);
    const pick = (/** @type {number} */ n)=>next() % n;
    const entries = 1 << 1 + pick(4);
    const masked = pick(2) === 0;
    const cases = 2 + pick(5);
    const stubs = 1 + pick(2);
    const code = [];
    code.push(0xb9, ...u32(8 + pick(40)));                      // mov ecx, count
    code.push(0xbe, ...u32(pick(0x10000)));                     // mov esi, seed of the index
    const head = code.length;
    code.push(0x69, 0xf6, ...u32(0x41c64e6d));                  // imul esi, esi, a
    code.push(0x81, 0xc6, ...u32(12345));                       // add esi, c
    code.push(0x89, 0xf0);                                      // mov eax, esi
    code.push(0xc1, 0xe8, 0x10);                                // shr eax, 16
    /** Where each jump to the loop's latch is, to patch. @type {number[]} */
    const toLatch = [];
    if (masked)
    {
        code.push(0x83, 0xe0, entries - 1);                     // and eax, entries - 1
    }
    else
    {
        code.push(0x83, 0xe0, 2 * entries - 1);                 // and eax, 2 entries - 1
        code.push(0x83, 0xf8, entries - 1);                     // cmp eax, entries - 1
        code.push(0x0f, 0x87, 0, 0, 0, 0);                      // ja latch
        toLatch.push(code.length - 4);
    }
    code.push(0xff, 0x24, 0x85, ...u32(TABLE));                 // jmp [TABLE + eax*4]
    /** @type {number[]} */
    const targets = [];
    for (let k = 0; k < cases + stubs; k++)
    {
        targets.push(CODE + code.length);
        code.push(0x81, 0xc3, ...u32(next()));                  // add ebx, constant
        if (pick(3) === 0)
        {
            // mov dword [TABLE + j*4], a case or a stub
            code.push(0xc7, 0x05, ...u32(TABLE + 4 * pick(entries)), 0, 0, 0, 0);
            const at = code.length - 4;
            const to = pick(cases + stubs);
            toLatch.push(-1 - at * 64 - to);
        }
        if (pick(2) === 0)
        {
            code.push(0x89, 0x1c, 0x8d, ...u32(OUT));           // mov [OUT + ecx*4], ebx
        }
        code.push(0xe9, 0, 0, 0, 0);                            // jmp latch
        toLatch.push(code.length - 4);
    }
    const latch = code.length;
    code.push(0x49);                                            // dec ecx
    code.push(0x0f, 0x85, ...u32(head - (code.length + 6)));    // jnz head
    code.push(0xf4);                                            // hlt
    for (const one of toLatch)
    {
        if (one >= 0)
        {
            code.splice(one, 4, ...u32(latch - (one + 4)));
        }
        else
        {
            const at = Math.floor((-1 - one) / 64);
            code.splice(at, 4, ...u32(targets[(-1 - one) % 64]));
        }
    }
    const table = [];
    for (let i = 0; i < entries; i++)
    {
        table.push(...u32(targets[pick(cases)]));
    }
    return { code, table };
}

/**
 * Runs `code` translated and on the model, the table at TABLE.
 *
 * @param {{ code: number[], table: number[] }} one @param {boolean} precise
 */
function judge({ code, table }, precise){
    const m = createTestMachine({ precise });
    m.write(CODE, code);
    m.write(TABLE, table);
    m.setReg('esp', STACK);
    m.setEflags(2);
    const exit = m.runProgram(CODE);
    const ram = new Uint8Array(1 << 20);
    ram.set(code, CODE);
    ram.set(table, TABLE);
    const view = new DataView(ram.buffer);
    const state = createState({
        read: (address, size)=>size === 1 ? ram[address]
            : size === 2 ? view.getUint16(address, true) : view.getUint32(address, true),
        write: (address, size, value)=>{
            if (size === 1)
            {
                ram[address] = value;
            }
            else if (size === 2)
            {
                view.setUint16(address, value, true);
            }
            else
            {
                view.setUint32(address, value, true);
            }
        },
    }, { eip: CODE, esp: STACK, fsBase: 0 });
    state.eflags = 2;
    while (!state.halted && state.retired < 100000)
    {
        const decoded = decode(address=>ram[address], state.eip);
        if ('refused' in decoded)
        {
            break;
        }
        evaluate(decoded, state);
    }
    return { m, exit, state, ram };
}

test('a switch\'s cases picked before its table is read: seeded loops rewriting their tables,'
    + ' translated against the model', ()=>{
    let rewrites = 0;
    for (let seed = 1; seed <= 400; seed++)
    {
        const one = program(seed);
        rewrites += one.code.filter((byte, at)=>byte === 0xc7 && one.code[at + 1] === 0x05).length;
        for (const precise of [false, true])
        {
            const { m, exit, state, ram } = judge(one, precise);
            const what = `seed ${seed}${precise ? ' precise' : ''}`;
            assert.equal(exit.kind, 3, `${what}: halted`);
            assert.ok(state.halted, `${what}: the model halted`);
            assert.equal(exit.retired, state.retired, `${what}: the instructions retired`);
            for (let r = 0; r < 8; r++)
            {
                assert.equal(m.reg(NAMES[r]), state.reg[r], `${what}: ${NAMES[r]}`);
            }
            assert.equal(m.eflags() & 0x8d5, state.eflags & 0x8d5, `${what}: flags`);
            assert.deepEqual([...m.read(TABLE, 64)], [...ram.subarray(TABLE, TABLE + 64)],
                `${what}: the table`);
            assert.deepEqual([...m.read(OUT, 256)], [...ram.subarray(OUT, OUT + 256)],
                `${what}: what the cases stored`);
        }
    }
    assert.ok(rewrites > 100, 'the cases rewrite their tables');
});
