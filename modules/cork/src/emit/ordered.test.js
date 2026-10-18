/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The ordered variant (`readOp`, `writeOp`): an integer operand's load and
 * store not through esp are wasm atomics, so another executor sees a program's
 * plain stores in their order on a host that reorders plain accesses. Its gate
 * beside the plain path: seeded sequences of plain loads, stores and
 * read-modify-writes, aligned and not, through a displacement, a base register
 * and esp, run translated with it and on the instruction model, leave the same
 * registers, flags and memory; and the code holds an atomic access exactly
 * where the variant puts one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJudge } from '../testing/sequences-judge.js';
import { ORDERED_POOL } from '../testing/ordered-sequences.js';
import { bodyOf, namesOf, random } from '../testing/sequences.js';
import { createTestMachine } from '../testing/machine.js';
import { emitRegion, prepareModule } from './region.js';
import { formRegion } from '../region.js';
import { ModuleBuilder } from '../wasm/encoder.js';
import { features } from '../wasm/features.js';

const COUNT = Number(process.env.ORDERED_SEQUENCES ?? 1500);

/** @param {number} value @returns {number[]} */
function leb(value){
    const out = [];
    let rest = value >>> 0;
    while (rest > 0x7f)
    {
        out.push(rest & 0x7f | 0x80);
        rest >>>= 7;
    }
    out.push(rest);
    return out;
}

/** How many times `needle` occurs in `bytes`. @param {Uint8Array} bytes @param {number[]} needle */
function occurrences(bytes, needle){
    let count = 0;
    for (let at = 0; at + needle.length <= bytes.length; at++)
    {
        let match = true;
        for (let k = 0; k < needle.length && match; k++)
        {
            match = bytes[at + k] === needle[k];
        }
        count += match ? 1 : 0;
    }
    return count;
}

/**
 * The atomic guest accesses in the module made of the region over `code`:
 * loads and stores of each width at the guest's RAM.
 *
 * @param {number[]} code @param {Record<string, boolean>} options
 */
function atomicsOf(code, options){
    const m = createTestMachine();
    const at = 0x1000;
    const bytes = [...code, 0xf4];
    const region = formRegion(a=>(a >= at && a < at + bytes.length ? bytes[a - at] : 0xf4), at);
    const builder = new ModuleBuilder();
    const context = prepareModule(builder, m.layout, features(), {}, { precise: true, ...options });
    emitRegion(context, region);
    const module = builder.toBytes();
    const ram = leb(m.layout.ramBase);
    /** @param {number} opcode @param {number} align */
    const count = (opcode, align)=>occurrences(module, [0xfe, opcode, align, ...ram]);
    return {
        loads: count(0x10, 2) + count(0x12, 0) + count(0x13, 1),
        stores: count(0x17, 2) + count(0x19, 0) + count(0x1a, 1),
    };
}

test('the ordered variant makes a load and a store atomic, not one through esp', ()=>{
    const code = [
        0x89, 0x03,                     // mov [ebx], eax
        0x8b, 0x4b, 0x02,               // mov ecx, [ebx+2]
        0x66, 0x89, 0x53, 0x08,         // mov [ebx+8], dx
        0x8a, 0x13,                     // mov dl, [ebx]
        0x89, 0x54, 0x24, 0x04,         // mov [esp+4], edx: a thread's stack
        0x8b, 0x74, 0x24, 0x08,         // mov esi, [esp+8]
        0x01, 0x0b,                     // add [ebx], ecx: a load and a store
    ];
    assert.deepEqual(atomicsOf(code, { atomic: true, ordered: true }), { loads: 3, stores: 3 });
    assert.deepEqual(atomicsOf(code, { atomic: true }), { loads: 0, stores: 0 },
        'plain without it');
    assert.deepEqual(atomicsOf(code, { ordered: true }), { loads: 0, stores: 0 },
        'and without the atomic variant, whose code runs on one executor');
});

test('translated sequences, ordered, leave what the instruction model leaves', async()=>{
    const judge = createJudge({ pool: ORDERED_POOL, cork: { atomic: true, ordered: true } });
    const next = random(0x0bde7ed);
    /** @type {string[]} */
    const failures = [];
    let judged = 0;
    for (let index = 0; index < COUNT; index++)
    {
        const body = bodyOf(next, { pool: ORDERED_POOL });
        const result = await judge.judge(body, []);
        if (result === null)
        {
            continue;
        }
        judged++;
        if (result.divergences.length > 0 && failures.length < 20)
        {
            failures.push(`#${index} ${namesOf(body, ORDERED_POOL)}: ${result.divergences
                .slice(0, 4).map(one=>`${one.name} ${String(one.expected)} != `
                    + `${String(one.actual)}`).join('; ')}`);
        }
    }
    assert.ok(judged > COUNT * 0.9, `${judged} of ${COUNT} ran`);
    assert.ok(judge.published() > judged * 0.9,
        `the translator published an entry for ${judge.published()} of ${judged}`);
    assert.ok(judge.share() > 0.5, `the translator ran ${judge.share()} of the instructions`);
    assert.deepEqual(failures, []);
});
