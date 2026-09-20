/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formRegion } from './region.js';

/** A region over bytes placed at `base`. @param {number[]} bytes @param {number} [base] */
function regionOf(bytes, base = 0x1000, options = {}){
    const image = Uint8Array.from(bytes);
    return formRegion(address=>image[address - base] ?? 0xcc, base, options);
}

/** @param {number} value */
const rel8 = value=>value & 0xff;

test('a countdown loop forms three blocks with one back-edge into the loop head', ()=>{
    // 1000: mov ecx, 10   (b9 0a 00 00 00)
    // 1005: dec ecx       (49)              <- L
    // 1006: jnz L         (75 fd)
    // 1008: ret           (c3)
    const region = regionOf([0xb9, 0x0a, 0, 0, 0, 0x49, 0x75, rel8(-3), 0xc3]);
    assert.deepEqual(region.entries, [0x1000, 0x1005, 0x1008]);
    const [head, loop, tail] = region.blocks;
    assert.equal(head.exit.kind, 'fallthrough');
    assert.deepEqual(head.exit.targets, [0x1005]);
    assert.equal(loop.exit.kind, 'jcc');
    assert.deepEqual(loop.exit.targets, [0x1005, 0x1008]);
    assert.equal(loop.exit.backEdge, true, 'the jump to its own start goes backwards');
    assert.equal(tail.exit.kind, 'ret');
    assert.equal(tail.exit.backEdge, false);
    assert.equal(region.bytes, 9);
    assert.deepEqual([...region.pages], [1]);
    assert.equal(region.hash.length, 8);
});

test('a diamond forms four blocks and no back-edge', ()=>{
    // 1000: test eax, eax  (85 c0)
    // 1002: jz A           (74 07)   -> 100b
    // 1004: mov ebx, 1     (bb 01 00 00 00)
    // 1009: jmp B          (eb 05)   -> 1010
    // 100b: mov ebx, 2     (bb 02 00 00 00)
    // 1010: ret            (c3)      <- B
    const region = regionOf([
        0x85, 0xc0, 0x74, 0x07, 0xbb, 1, 0, 0, 0, 0xeb, 0x05, 0xbb, 2, 0, 0, 0, 0xc3,
    ]);
    assert.deepEqual(region.entries, [0x1000, 0x1004, 0x100b, 0x1010]);
    assert.deepEqual(region.blocks.map(b=>b.exit.kind), ['jcc', 'jump', 'fallthrough', 'ret']);
    assert.ok(region.blocks.every(b=>!b.exit.backEdge));
});

test('a jump into the middle of a decoded block splits it at the target', ()=>{
    // 1000: mov eax, 1     (b8 01 00 00 00)
    // 1005: mov ebx, 2     (bb 02 00 00 00)   <- the target
    // 100a: jmp 1005       (eb f9)
    const region = regionOf([0xb8, 1, 0, 0, 0, 0xbb, 2, 0, 0, 0, 0xeb, rel8(-7)]);
    assert.deepEqual(region.entries, [0x1000, 0x1005]);
    const [first, second] = region.blocks;
    assert.equal(first.instructions.length, 1);
    assert.equal(first.exit.kind, 'fallthrough');
    assert.equal(second.instructions.length, 2);
    assert.equal(second.exit.kind, 'jump');
    assert.equal(second.exit.backEdge, true);
});

test('a target inside an instruction gets a block of its own: overlapping code', ()=>{
    // 1000: mov eax, 0x90eb0000 (b8 00 00 eb 90) -- bytes 1003..: eb 90 is "jmp -112"? no:
    //       the jump below targets 1003, inside the mov, where "eb 90" decodes as jmp
    // 1005: jmp 1003 (eb fc)
    const region = regionOf([0xb8, 0x00, 0x00, 0xeb, 0x01, 0xeb, rel8(-4)]);
    // 1003: eb 01 -> jmp 1006; 1006: the byte after the second jump, 0xcc (int3)
    assert.ok(region.entries.includes(0x1003), 'the mid-instruction target became a block');
    const overlapping = region.blocks.find(b=>b.start === 0x1003);
    assert.equal(overlapping?.exit.kind, 'jump');
    assert.deepEqual(overlapping?.exit.targets, [0x1006]);
});

test('a region is cut at an indirect jump, a return, a call, a trap and a fault', ()=>{
    const indirect = regionOf([0xff, 0xe0]); // jmp eax
    assert.equal(indirect.blocks[0].exit.kind, 'indirect');
    assert.equal(indirect.blocks.length, 1);
    const call = regionOf([0xe8, 0x10, 0, 0, 0, 0xc3]); // call +0x10; ret
    assert.equal(call.blocks[0].exit.kind, 'call');
    assert.deepEqual(call.blocks[0].exit.targets, [0x1015]);
    assert.equal(call.blocks[0].exit.next, 0x1005);
    assert.equal(call.blocks.length, 2, 'the callee is not followed; the return address is');
    assert.equal(call.blocks[1].start, 0x1005);
    assert.equal(call.blocks[1].exit.kind, 'ret');
    const table = regionOf([0xff, 0x15, 0x00, 0x20, 0, 0, 0xc3]); // call [0x2000]; ret
    assert.equal(table.blocks[0].exit.kind, 'indirect');
    assert.equal(table.blocks.length, 2, 'the return address after an indirect call too');
    assert.equal(table.blocks[1].start, 0x1006);
    const trap = regionOf([0xef, 0x90]); // out dx, eax; nop
    assert.equal(trap.blocks[0].exit.kind, 'trap');
    assert.equal(trap.blocks[0].exit.next, 0x1001);
    const fault = regionOf([0x0f, 0x0b]); // ud2
    assert.equal(fault.blocks[0].exit.kind, 'fault');
    const halt = regionOf([0xf4]);
    assert.equal(halt.blocks[0].exit.kind, 'hlt');
});

test('a refused instruction ends the block, named, and is counted by opcode', ()=>{
    const region = regionOf([0x90, 0xea, 0, 0, 0, 0, 0, 0]); // nop; jmp far
    assert.equal(region.blocks[0].exit.kind, 'refused');
    assert.equal(region.blocks[0].exit.refusal?.reason, 'not user mode');
    assert.equal(region.blocks[0].exit.next, 0x1001);
    assert.equal(region.blocks[0].instructions.length, 1);
    assert.deepEqual([...region.refused], [['ea', 1]]);
});

test('the caps cut the region and leave the rest as exits to the runtime', ()=>{
    // The diamond of above, with room for two blocks only.
    const bytes = [0x85, 0xc0, 0x74, 0x07, 0xbb, 1, 0, 0, 0, 0xeb, 0x05, 0xbb, 2, 0, 0, 0, 0xc3];
    const capped = regionOf(bytes, 0x1000, { maxBlocks: 2 });
    assert.equal(capped.blocks.length, 2);
    assert.deepEqual(capped.entries, [0x1000, 0x1004]);
    const second = capped.blocks[1];
    assert.equal(second.exit.kind, 'jump');
    assert.deepEqual(second.exit.targets, [0x1010], 'the target is named though not a block');

    // The byte cap is looked at before each instruction, so the instruction
    // that crosses it is kept and the block is cut after it.
    const small = regionOf(bytes, 0x1000, { maxBytes: 1 });
    assert.equal(small.blocks[0].exit.kind, 'cut');
    assert.equal(small.blocks[0].exit.next, 0x1002);
    assert.equal(small.blocks[0].instructions.length, 1);
    assert.equal(small.blocks.length, 1);
});

test('a page the runtime refuses is not entered, and the edge to it stays an exit', ()=>{
    // 1000: jmp 0x2000 (e9 fb 0f 00 00)
    const image = new Uint8Array(0x2000);
    image.set([0xe9, 0xfb, 0x0f, 0, 0], 0);
    image.set([0xc3], 0x1000);
    const region = formRegion(address=>image[address - 0x1000] ?? 0xcc, 0x1000,
        { translatable: eip=>eip < 0x2000 });
    assert.deepEqual(region.entries, [0x1000]);
    assert.deepEqual(region.blocks[0].exit.targets, [0x2000]);
});

test('the hash follows the bytes, not the address the region was formed at', ()=>{
    const a = regionOf([0xb9, 0x0a, 0, 0, 0, 0x49, 0x75, rel8(-3), 0xc3], 0x1000);
    const b = regionOf([0xb9, 0x0a, 0, 0, 0, 0x49, 0x75, rel8(-3), 0xc3], 0x5000);
    assert.equal(a.hash, b.hash);
    const c = regionOf([0xb9, 0x0b, 0, 0, 0, 0x49, 0x75, rel8(-3), 0xc3], 0x1000);
    assert.notEqual(a.hash, c.hash);
});
