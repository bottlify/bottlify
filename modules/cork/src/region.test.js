/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formRegion, inlineReturns } from './region.js';

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
    assert.equal(region.hash.length, 16);
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

test('once code overlaps, a block that runs into another block\'s bytes falls through to it', ()=>{
    // 1000: mov eax, 0x01eb0000 (b8 00 00 eb 01)
    // 1005: jmp 1001            (eb fa)
    // 1001, inside the mov: add [eax], al (00 00), then 1003 is inside the mov's
    // block too -- the first block made holds it -- so the block ends there.
    const region = regionOf([0xb8, 0x00, 0x00, 0xeb, 0x01, 0xeb, rel8(-6)]);
    const inside = region.blocks.find(b=>b.start === 0x1001);
    assert.equal(inside?.instructions.length, 1);
    assert.equal(inside?.exit.kind, 'fallthrough');
    assert.deepEqual(inside?.exit.targets, [0x1003]);
    assert.ok(region.entries.includes(0x1003), 'and 1003 a block of its own');
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
    assert.equal(trap.blocks[1]?.start, 0x1001, 'the instruction after the trap is a block');
    const fault = regionOf([0x0f, 0x0b]); // ud2
    assert.equal(fault.blocks[0].exit.kind, 'fault');
    const halt = regionOf([0xf4]);
    assert.equal(halt.blocks[0].exit.kind, 'hlt');
});

test('call $+5 is a push of its own return address: the block goes on past it', ()=>{
    // 1000: call $+5; 1005: pop ebx; fld1; ret -- and with an operand-size prefix,
    // a call of sixteen bits, which stays a call.
    const region = regionOf([0xe8, 0, 0, 0, 0, 0x5b, 0xd9, 0xe8, 0xc3]);
    assert.deepEqual(region.entries, [0x1000]);
    assert.deepEqual(region.blocks[0].instructions.map(one=>one.op),
        ['call', 'pop', 'fld1', 'ret']);
    assert.equal(region.blocks[0].exit.kind, 'ret');
    assert.deepEqual([...inlineReturns(region)], [], 'no return comes back into the region');
    const short = regionOf([0x66, 0xe8, 0, 0, 0x5b, 0xc3]);
    assert.equal(short.blocks[0].exit.kind, 'call');
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
    const none = { blocks: 0, bytes: 0 };
    const capped = regionOf(bytes, 0x1000, { maxBlocks: 2, ownRoom: none });
    assert.equal(capped.blocks.length, 2);
    assert.deepEqual(capped.entries, [0x1000, 0x1004]);
    const second = capped.blocks[1];
    assert.equal(second.exit.kind, 'jump');
    assert.deepEqual(second.exit.targets, [0x1010], 'the target is named though not a block');

    // The byte cap is looked at before each instruction, so the instruction
    // that crosses it is kept and the block is cut after it.
    const small = regionOf(bytes, 0x1000, { maxBytes: 1, ownRoom: none });
    assert.equal(small.blocks[0].exit.kind, 'cut');
    assert.equal(small.blocks[0].exit.next, 0x1002);
    assert.equal(small.blocks[0].instructions.length, 1);
    assert.equal(small.blocks.length, 1);

    // The entry's own function takes the caps again past them unless told otherwise.
    assert.equal(regionOf(bytes, 0x1000, { maxBlocks: 1 }).blocks.length, 2);
    assert.equal(regionOf(bytes, 0x1000, { maxBlocks: 2 }).blocks.length, 4);
});

test('a function past the caps is formed whole in its own room, its callees within the caps', ()=>{
    // 1000: ten of inc eax; jz +0 (a block each); call F; ret. F = 1100: inc ecx; ret.
    const code = [...Array.from({ length: 10 }, ()=>[0x40, 0x74, 0x00]).flat(),
        0xe8, 0xdd, 0x00, 0x00, 0x00, 0xc3];
    const image = [...code, ...Array.from({ length: 0x100 - code.length }, ()=>0xcc), 0x41, 0xc3];
    const starts = (/** @type {object} */ options)=>regionOf(image, 0x1000, options).blocks
        .map(block=>block.start);
    const own = starts({ maxBlocks: 6 });
    assert.equal(own.filter(start=>start < 0x1100).length, 12, 'eleven blocks and the return');
    assert.equal(own.includes(0x1023), true,
        'the block the call returns to, so the call stays a wasm call');
    assert.equal(own.includes(0x1100), false, 'the callee finds the caps passed');
    assert.equal(starts({ maxBlocks: 6, ownRoom: { blocks: 0, bytes: 0 } }).length, 6);
    // Within the caps the callee is formed in as before.
    assert.equal(starts({ maxBlocks: 16 }).includes(0x1100), true);
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

test('two regions whose bytes agree in 32 bits of FNV-1a still hash apart', ()=>{
    // mov eax, imm32; hlt -- the two immediates were found by a birthday
    // search, a second's work: 32 bits cannot keep a stored translation to
    // the bytes it was made from.
    const a = regionOf([0xb8, 0xbf, 0x20, 0x50, 0x13, 0xf4]);
    const b = regionOf([0xb8, 0x9b, 0xb1, 0xb4, 0x1a, 0xf4]);
    assert.notEqual(a.hash, b.hash);
    assert.equal(a.hash.length, 16);
});

test('a run of zero bytes past a call ends the region as data, not as four thousand adds', ()=>{
    // call [table]; then the page's zero fill
    const region = regionOf([0xff, 0x15, 0x00, 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(region.blocks.length, 2, 'the call, and the block after it');
    const after = region.blocks[1];
    assert.equal(after.start, 0x1006);
    assert.equal(after.instructions.length, 0, 'not one add of the fill');
    assert.equal(after.exit.kind, 'refused');
    assert.equal(region.refused.get('00 00'), 1);
});

test('a breakpoint ends the code before it: padding past a call is not a block a byte', ()=>{
    // 1000: call F; 1005: int3 x 0x200; F = 1205: inc eax; ret -- a call that
    // does not return, the compiler's padding after it, and the callee past it.
    const F = 0x1205;
    const code = [0xe8, ...[F - 0x1005, 0, 0, 0].map((v, i)=>(F - 0x1005) >>> i * 8 & 0xff),
        ...new Array(0x200).fill(0xcc), 0x40, 0xc3];
    const region = regionOf(code);
    assert.deepEqual(region.entries, [0x1000, 0x1005, F], 'the call, its padding\'s first '
        + 'breakpoint, and the callee formed in');
    assert.equal(region.blocks.find(block=>block.start === 0x1005)?.exit.kind, 'trap');
    // `int 3` returns past itself, as any software interrupt does.
    const interrupt = regionOf([0xcd, 0x03, 0x90]);
    assert.deepEqual(interrupt.entries, [0x1000, 0x1002]);
});

test('a small leaf callee is formed into its caller, and only its rets return inside', ()=>{
    // 1000: call F (e8 01 00 00 00)   1005: ret        F = 1006: inc eax; ret
    const leaf = regionOf([0xe8, 1, 0, 0, 0, 0xc3, 0x40, 0xc3]);
    assert.deepEqual(leaf.entries, [0x1000, 0x1005, 0x1006], 'the callee is a block');
    assert.deepEqual([...inlineReturns(leaf)], [[0x1006, [0x1005]]],
        'the callee\'s ret comes back after the call; the caller\'s own ret is no edge');
    const off = regionOf([0xe8, 1, 0, 0, 0, 0xc3, 0x40, 0xc3], 0x1000, { leafCalls: false });
    assert.deepEqual(off.entries, [0x1000, 0x1005]);
    // A callee that calls on is formed one level deep: its own call stays an
    // exit, and its ret comes back after the call into it.
    const nested = regionOf([0xe8, 1, 0, 0, 0, 0xc3, 0xe8, 0xf5, 0x0f, 0, 0, 0xc3]);
    assert.deepEqual(nested.entries, [0x1000, 0x1005, 0x1006, 0x100b]);
    assert.deepEqual([...inlineReturns(nested)], [[0x100b, [0x1005]]]);
    // Its callee that calls on in turn is not: 1006 F: call G; ret
    // 100c G: call 2000; ret -- G stays a call out of the region.
    const deeper = regionOf([0xe8, 1, 0, 0, 0, 0xc3, 0xe8, 1, 0, 0, 0, 0xc3,
        0xe8, 0xef, 0x0f, 0, 0, 0xc3]);
    assert.deepEqual(deeper.entries, [0x1000, 0x1005, 0x1006, 0x100b]);
});

test('an indirect call\'s predicted callees are formed in as a direct call\'s are, and'
    + ' only then', ()=>{
    // 1000: call eax (ff d0)   1002: ret   F = 1003: inc eax; ret   G = 1005: dec eax; ret
    const code = [0xff, 0xd0, 0xc3, 0x40, 0xc3, 0x48, 0xc3];
    const plain = regionOf(code);
    assert.deepEqual(plain.entries, [0x1000, 0x1002]);
    assert.equal(plain.blocks[0].exit.kind, 'indirect');
    assert.equal(plain.blocks[0].exit.predicted, undefined);
    const predicted = regionOf(code, 0x1000,
        { callTargets: new Map([[0x1000, [0x1003, 0x1005]]]) });
    assert.deepEqual(predicted.entries, [0x1000, 0x1002, 0x1003, 0x1005]);
    const call = predicted.blocks[0].exit;
    assert.equal(call.kind, 'indirect');
    assert.equal(call.predicted, true);
    assert.deepEqual(call.targets, [0x1003, 0x1005]);
    assert.deepEqual([...inlineReturns(predicted)].sort((x, y)=>x[0] - y[0]),
        [[0x1003, [0x1002]], [0x1005, [0x1002]]],
        'each callee\'s ret comes back after the call');
    assert.notEqual(predicted.hash, plain.hash, 'the prediction is part of what the region is');
    // Another call's prediction, or none with leaf calls off, forms nothing in.
    assert.deepEqual(regionOf(code, 0x1000, { callTargets: new Map([[0x2000, [0x1003]]]) })
        .entries, [0x1000, 0x1002]);
    assert.deepEqual(regionOf(code, 0x1000, { leafCalls: false,
        callTargets: new Map([[0x1000, [0x1003]]]) }).entries, [0x1000, 0x1002]);
});

test('a predicted callee is formed into a region its own function fills, within the room'
    + ' past the caps', ()=>{
    // 1000: call ebx; then ten of inc eax; jz +0 (a block each); ret -- twelve blocks of
    // its own; G = 1100: add edx, 1; ret.
    const code = [0xff, 0xd3, ...Array.from({ length: 10 }, ()=>[0x40, 0x74, 0x00]).flat(), 0xc3];
    const image = [...code, ...Array.from({ length: 0x100 - code.length }, ()=>0xcc),
        0x83, 0xc2, 0x01, 0xc3];
    const callTargets = new Map([[0x1000, [0x1100]]]);
    const has = (/** @type {object} */ options)=>regionOf(image, 0x1000,
        { maxBlocks: 6, callTargets, ...options }).blocks.some(block=>block.start === 0x1100);
    assert.equal(has({}), true, 'G in, past the six blocks');
    assert.equal(has({ predictedRoom: { blocks: 0, bytes: 0 } }), false, 'no room, no G');
    assert.equal(regionOf(image, 0x1000, { maxBlocks: 6, callTargets }).blocks
        .filter(block=>block.start < 0x1100).length, 12, 'the function itself in its own room');
    // The room is the callees' alone: a call the runtime did not predict has none.
    assert.equal(regionOf(image, 0x1000, { maxBlocks: 6 }).blocks.length, 12);
});

test('a call through a fixed slot predicts the leaf the slot holds', ()=>{
    // 1000: call [0x3000]; ret; F = 1007: inc eax; ret; G = 1009: call F; ret
    const code = [0xff, 0x15, 0x00, 0x30, 0, 0, 0xc3, 0x40, 0xc3,
        0xe8, 0xf9, 0xff, 0xff, 0xff, 0xc3];
    /** @param {number} target */
    const formed = target=>{
        const memory = new Map([
            ...code.map((byte, i)=>/** @type {[number, number]} */ ([0x1000 + i, byte])),
            ...[0, 1, 2, 3].map(k=>/** @type {[number, number]} */ (
                [0x3000 + k, target >>> (k * 8) & 0xff])),
        ]);
        return formRegion(address=>memory.get(address) ?? 0, 0x1000);
    };
    const leaf = formed(0x1007);
    assert.equal(leaf.blocks[0].exit.predicted, true);
    assert.deepEqual(leaf.blocks[0].exit.targets, [0x1007]);
    assert.deepEqual(leaf.entries, [0x1000, 0x1006, 0x1007]);
    assert.notEqual(leaf.hash, formed(0).hash, 'the prediction is part of what the region is');
    // A callee that calls on is not formed through a slot, nor an empty slot.
    assert.equal(formed(0x1009).blocks[0].exit.predicted, undefined);
    assert.equal(formed(0).blocks[0].exit.predicted, undefined);
});

test('a jump through a bounded table takes the table\'s cases into the region', ()=>{
    // cmp eax, 2; ja D; jmp [0x3000 + eax*4]; C0: ret; C1: ret; C2: ret; D: hlt
    const table = [0x100e, 0x100f, 0x1010];
    const memory = new Map([
        ...[0x83, 0xf8, 0x02, 0x77, 0x0a, 0xff, 0x24, 0x85, 0x00, 0x30, 0x00, 0x00,
            0xc3, 0xc3, 0xc3, 0xc3, 0xc3, 0xf4].map((byte, i)=>/** @type {[number, number]} */ (
            [0x1000 + i, byte])),
        ...table.flatMap((target, i)=>[0, 1, 2, 3].map(k=>/** @type {[number, number]} */ (
            [0x3000 + i * 4 + k, target >>> (k * 8) & 0xff]))),
    ]);
    const region = formRegion(address=>memory.get(address) ?? 0, 0x1000);
    const jump = region.blocks.find(block=>block.start === 0x1005);
    assert.ok(jump);
    assert.deepEqual(jump.exit.table, { index: 0, address: 0x3000, entries: table });
    assert.deepEqual(jump.exit.targets, table);
    for (const target of table)
    {
        assert.ok(region.blocks.some(block=>block.start === target), `case ${target.toString(16)}`);
    }
    assert.ok(region.pages.has(3), 'the table\'s page is the region\'s');
    // Without the bound the jump is an indirect exit like any other.
    memory.set(0x1003, 0x75);
    const unbounded = formRegion(address=>memory.get(address) ?? 0, 0x1000);
    const plain = unbounded.blocks.find(block=>block.start === 0x1005);
    assert.equal(plain?.exit.table, undefined);
    assert.deepEqual(plain?.exit.targets, []);
});

test('a switch whose jump\'s block holds other register writes before it is still one', ()=>{
    // cmp eax, 2; ja D; mov ecx, edx; lea ebx, [esi+1]; jmp [0x3000 + eax*4];
    // C0: ret; C1: ret; C2: ret; D: hlt -- the cases' shared setup scheduled into the
    // jump's block, as a compiler does.
    /** @param {number[]} setup */
    const formed = setup=>{
        const code = [0x83, 0xf8, 0x02, 0x77, 0x0f, ...setup, 0x8d, 0x5e, 0x01,
            0xff, 0x24, 0x85, 0x00, 0x30, 0x00, 0x00, 0xc3, 0xc3, 0xc3, 0xf4];
        const memory = new Map([
            ...code.map((byte, i)=>/** @type {[number, number]} */ ([0x1000 + i, byte])),
            ...[0x1011, 0x1012, 0x1013].flatMap((target, i)=>[0, 1, 2, 3].map(k=>
                /** @type {[number, number]} */ ([0x3000 + i * 4 + k, target >>> (k * 8) & 0xff]))),
        ]);
        return formRegion(address=>memory.get(address) ?? 0, 0x1000)
            .blocks.find(block=>block.start === 0x1005);
    };
    assert.deepEqual(formed([0x89, 0xd1])?.exit.table,
        { index: 0, address: 0x3000, entries: [0x1011, 0x1012, 0x1013] });
    // A write to the index among them unbounds it: inc eax; nop.
    assert.equal(formed([0x40, 0x90])?.exit.table, undefined);
});

test('a switch whose index its own block masks takes every case of the mask', ()=>{
    // and eax, 3; mov ecx, edx; jmp [0x3000 + eax*4]; C0..C3: ret -- `switch (x & 3)` with
    // every case written, which a compiler lays out with no bound test.
    /** @param {number[]} code @param {number[]} table */
    const formed = (code, table)=>{
        const memory = new Map([
            ...code.map((byte, i)=>/** @type {[number, number]} */ ([0x1000 + i, byte])),
            ...table.flatMap((target, i)=>[0, 1, 2, 3].map(k=>/** @type {[number, number]} */ (
                [0x3000 + i * 4 + k, target >>> (k * 8) & 0xff]))),
        ]);
        return formRegion(address=>memory.get(address) ?? 0, 0x1000);
    };
    const jump = [0xff, 0x24, 0x85, 0x00, 0x30, 0x00, 0x00];
    const table = [0x100c, 0x100d, 0x100e, 0x100f];
    const region = formed([0x83, 0xe0, 0x03, 0x89, 0xd1, ...jump, 0xc3, 0xc3, 0xc3, 0xc3],
        [...table, 0x1000]);
    assert.deepEqual(region.blocks[0].exit.table, { index: 0, address: 0x3000, entries: table },
        'four entries, not the fifth word past them');
    assert.deepEqual(region.entries, [0x1000, ...table]);
    // A write to the index after the mask unbounds it.
    const moved = formed([0x83, 0xe0, 0x03, 0x40, ...jump, 0xc3, 0xc3, 0xc3, 0xc3],
        [0x100b, 0x100c, 0x100d, 0x100e]);
    assert.equal(moved.blocks[0].exit.table, undefined);
    assert.deepEqual(moved.entries, [0x1000]);
    // So does a mask of another register.
    const other = formed([0x83, 0xe1, 0x03, ...jump, 0xc3, 0xc3, 0xc3, 0xc3],
        [0x100a, 0x100b, 0x100c, 0x100d]);
    assert.equal(other.blocks[0].exit.table, undefined);
});

test('a switch whose index is loaded after the bound test of the memory it comes from', ()=>{
    // cmp dword [eax], 1; lea ebx, [ebx*3]; ja D; mov edx, [eax]; jmp [0x3000 + edx*4];
    // C0: ret; C1: ret; D: hlt -- as a compiler lays out a switch on a field.
    const code = [0x83, 0x38, 0x01, 0x8d, 0x1c, 0x5b, 0x77, 0x0b, 0x8b, 0x10,
        0xff, 0x24, 0x95, 0x00, 0x30, 0x00, 0x00, 0xc3, 0xc3, 0xf4];
    const table = [0x1011, 0x1012];
    const memory = new Map([
        ...code.map((byte, i)=>/** @type {[number, number]} */ ([0x1000 + i, byte])),
        ...table.flatMap((target, i)=>[0, 1, 2, 3].map(k=>/** @type {[number, number]} */ (
            [0x3000 + i * 4 + k, target >>> (k * 8) & 0xff]))),
    ]);
    const region = formRegion(address=>memory.get(address) ?? 0, 0x1000);
    const jump = region.blocks.find(block=>block.start === 0x1008);
    assert.deepEqual(jump?.exit.table, { index: 2, address: 0x3000, entries: table });
    // A write to the tested register between the test and the branch undoes it.
    memory.set(0x1004, 0x04); // lea eax, [ebx + ebx*2]: eax written
    const moved = formRegion(address=>memory.get(address) ?? 0, 0x1000);
    assert.equal(moved.blocks.find(block=>block.start === 0x1008)?.exit.table, undefined);
});
