/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One instruction that stores into translated code on more than one page --
 * a `rep stos` or `rep movs` element after element, a `pushad` across a page
 * boundary -- drops the translations of every page it reached, not only the
 * page of its last store into code.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownLayout, pagesFor, tablesSize } from './layout.js';
import { createCorkRuntime } from './runtime.js';

/** Code at the end of one page, at the start of the next and of the one after. */
const A = 0x500ff0;
const B = 0x501000;
const C = 0x502000;
const WRITER = 0x401000;

/** @param {number} value */
const le = value=>[value & 0xff, value >> 8 & 0xff, value >> 16 & 0xff, value >>> 24];

/**
 * Translates and runs A, B and C, then the writer to its `hlt`.
 *
 * @param {number[]} writer @param {number} esp
 * @returns {Promise<{ a: boolean, b: boolean, c: boolean, exits: string[] }>}  whether each
 *     translation was entered after every run of the writer
 */
async function afterWriting(writer, esp){
    const layout = ownLayout({ ramSize: 16 << 20, hashSlots: 1 << 16 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, tablesSize(layout)) });
    const bytes = ()=>new Uint8Array(memory.buffer);
    const view = ()=>new DataView(memory.buffer);
    view().setUint8(layout.x87Empty, 0xff);
    // Stores through esp are checked: `looseStacks` would skip a stack store's test.
    /** @type {any} */
    const config = { looseStacks: false };
    const runtime = createCorkRuntime({
        memory, layout, config,
        read: address=>bytes()[layout.ramBase + address],
        imports: { trap: ()=>0, rdtsc: ()=>0n },
    });
    // inc eax; inc eax; hlt and inc ecx; inc ecx; hlt
    bytes().set([0x40, 0x40, 0xf4], layout.ramBase + A);
    bytes().set([0x41, 0x41, 0xf4], layout.ramBase + B);
    bytes().set([0x42, 0x42, 0xf4], layout.ramBase + C);
    bytes().set(writer, layout.ramBase + WRITER);
    /** @param {number} eip */
    const run = async eip=>{
        view().setUint32(layout.eip, eip, true);
        if (runtime.entryOf(eip, 0) < 0)
        {
            runtime.noteHot(eip, 0);
            await runtime.translatePending();
        }
        return runtime.run(runtime.entryOf(eip, 0), 1_000_000).kind;
    };
    await run(A);
    await run(B);
    await run(C);
    assert.ok([A, B, C].every(at=>runtime.entryOf(at, 0) >= 0), 'all translated');
    view().setUint32(layout.regs + 4 * 4, esp, true);
    /** @type {string[]} */
    const exits = [];
    // Looked at after each run, before the next forms what a drop asked for again.
    const kept = { a: true, b: true, c: true };
    for (let eip = WRITER; exits.length < 20;)
    {
        exits.push(await run(eip));
        kept.a &&= runtime.entryOf(A, 0) >= 0;
        kept.b &&= runtime.entryOf(B, 0) >= 0;
        kept.c &&= runtime.entryOf(C, 0) >= 0;
        if (exits[exits.length - 1] === 'halt')
        {
            break;
        }
        eip = view().getUint32(layout.eip, true);
    }
    return { ...kept, exits };
}

test('a rep stos over code on two pages drops both pages\' translations', async()=>{
    // mov edi, A - 0x10; mov ecx, 64; rep stosd; hlt
    const { a, b, exits } = await afterWriting(
        [0xbf, ...le(A - 0x10), 0xb9, 64, 0, 0, 0, 0xf3, 0xab, 0xf4], 0x80000);
    assert.equal(exits[0], 'stale');
    assert.equal(a, false, 'the first page, written before the last store');
    assert.equal(b, false, 'the page of the last store');
});

test('a rep stos over code on three pages drops the one between too', async()=>{
    // mov edi, A - 0x10; mov ecx, (C + 0x10 - (A - 0x10)) / 4; rep stosd; hlt
    const { a, b, c } = await afterWriting(
        [0xbf, ...le(A - 0x10), 0xb9, ...le((C + 0x10 - (A - 0x10)) / 4), 0xf3, 0xab, 0xf4],
        0x80000);
    assert.deepEqual([a, b, c], [false, false, false]);
});

test('a pushad across two pages of code drops both pages\' translations', async()=>{
    // pushad; hlt -- esp B + 8 writes B - 24 .. B + 7
    const { a, b, exits } = await afterWriting([0x60, 0xf4], B + 8);
    assert.equal(exits[0], 'stale');
    assert.equal(a, false);
    assert.equal(b, false, 'the upper page, its pushes the first');
});
