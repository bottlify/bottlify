/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODE_64 } from './decode/decoder.js';
import { formRegion, hashRegion } from './region.js';

/**
 * A reader over `code` at `at`, `hlt` everywhere else.
 * @param {number[]} code @param {number} at
 */
const over = (code, at)=>(/** @type {number} */ address)=>(address >= at
    && address < at + code.length ? code[address - at] : 0xf4);

/** @param {number} v @param {number} n */
const bytes = (v, n)=>Array.from({ length: n }, (_, i)=>Math.floor(v / 2 ** (8 * i)) & 0xff);

test('long-mode forming follows no branch past the 4 GiB window, nor wraps into it', ()=>{
    // At 0xfffffff0: jz +0x7f (to 0x100000071); nops to the window's end.
    const at = 0xfffffff0;
    const code = [0x74, 0x7f, ...new Array(14).fill(0x90)];
    const region = formRegion(over(code, at), at, { mode: MODE_64 });
    assert.deepEqual(region.entries, [at, at + 2]);
    // The block after the jump runs to the window's end and stops there: its way on
    // is past the window, not wrapped to 0.
    const last = region.blocks[1];
    assert.deepEqual({ end: last.end, kind: last.exit.kind, next: last.exit.next },
        { end: 2 ** 32, kind: 'cut', next: 2 ** 32 });
});

test('a call through an 8-byte slot forms its leaf callee in, one past the window not', ()=>{
    // 0x401000: call [rip + 0xffa] (slot at 0x402000); ret
    // 0x401100: mov eax, 7; ret                         the leaf the slot names
    const at = 0x401000;
    const code = new Array(0x1010).fill(0xcc);
    code.splice(0, 7, 0xff, 0x15, 0xfa, 0x0f, 0, 0, 0xc3);
    code.splice(0x100, 6, 0xb8, 7, 0, 0, 0, 0xc3);
    const slot = (/** @type {number} */ high)=>{
        const one = [...code];
        one.splice(0x1000, 8, ...bytes(0x401100, 4), ...bytes(high, 4));
        return formRegion(over(one, at), at, { mode: MODE_64 });
    };
    const formed = slot(0);
    const call = formed.blocks.find(block=>block.start === at);
    assert.equal(call?.exit.predicted, true);
    assert.deepEqual(call?.exit.targets, [0x401100]);
    assert.ok(formed.entries.includes(0x401100));
    // The high half of the quadword says the callee is past the window.
    const past = slot(1);
    assert.equal(past.blocks.find(block=>block.start === at)?.exit.predicted, undefined);
    assert.ok(!past.entries.includes(0x401100));
});

test('a long-mode switch through a quadword table joins its cases, its table hashed whole', ()=>{
    // 0x401000: cmp rax, 2; ja out; jmp [0x402000 + rax*8]
    // cases at 0x401100, 0x401110, 0x401120 (each: ret); out: 0x401030 ret
    const at = 0x401000;
    const code = new Array(0x1018).fill(0xcc);
    code.splice(0, 18, 0x48, 0x83, 0xf8, 0x02, 0x77, 0x2a, 0xff, 0x24, 0xc5,
        ...bytes(0x402000, 4), 0xc3, 0xc3, 0xc3, 0xc3, 0xc3);
    code[0x30] = 0xc3;
    for (const [i, target] of [0x401100, 0x401110, 0x401120].entries())
    {
        code[target - at] = 0xc3;
        code.splice(0x1000 + i * 8, 8, ...bytes(target, 4), 0, 0, 0, 0);
    }
    const read = over(code, at);
    const region = formRegion(read, at, { mode: MODE_64 });
    const jump = region.blocks.find(block=>block.exit.table !== undefined);
    assert.deepEqual(jump?.exit.table, { index: 0, address: 0x402000,
        entries: [0x401100, 0x401110, 0x401120], entrySize: 8 });
    for (const target of [0x401100, 0x401110, 0x401120])
    {
        assert.ok(region.entries.includes(target), target.toString(16));
    }
    // The table's last entry's high half is hashed: written since, the region read
    // again over it no longer fits.
    const written = [...code];
    written[0x1000 + 2 * 8 + 4] = 1;
    assert.notEqual(hashRegion(over(written, at), region), region.hash);
});

test('an instruction the emitter has no case for ends its block, and is no leaf\'s', ()=>{
    // 0x401000: call leaf; ret      leaf: 0x401010: cpuid; ret
    const at = 0x401000;
    const code = new Array(0x20).fill(0xcc);
    code.splice(0, 6, 0xe8, 0x0b, 0, 0, 0, 0xc3);
    code.splice(0x10, 3, 0x0f, 0xa2, 0xc3);
    const read = over(code, at);
    const all = formRegion(read, at, { mode: MODE_64, translates: ()=>true });
    assert.ok(all.entries.includes(0x401010));
    // Long mode's default is the shared emitter's own (`translatesLong`), which
    // has no case for cpuid.
    assert.ok(!formRegion(read, at, { mode: MODE_64 }).entries.includes(0x401010));
    const some = formRegion(read, at, { mode: MODE_64,
        translates: instruction=>instruction.op !== 'cpuid' });
    assert.ok(!some.entries.includes(0x401010));
    const cut = formRegion(read, 0x401010, { mode: MODE_64,
        translates: instruction=>instruction.op !== 'cpuid' });
    assert.equal(cut.blocks[0].instructions.length, 0);
    assert.deepEqual({ kind: cut.blocks[0].exit.kind, next: cut.blocks[0].exit.next },
        { kind: 'cut', next: 0x401010 });
});
