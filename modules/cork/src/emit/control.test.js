/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Transfers between regions through the entry hash: a return, an indirect
 * jump or a call whose target is translated tail-calls that region's
 * function instead of leaving for the slice loop. The test machine keeps
 * the same table and hash a runtime does, and `runProgram` counts the
 * times it called a region function: a transfer is not one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { features } from '../wasm/features.js';

const CODE = 0x1000;
const DATA = 0x2000;
const STACK = 0x80000;
/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
const tailCalls = features().tailCalls;

/** @param {number[]} bytes @param {number[]} [data] */
function machine(bytes, data = []){
    const m = createTestMachine();
    m.write(CODE, bytes);
    m.write(DATA, data);
    m.setReg('esp', STACK);
    return m;
}

test('a call and its return cross regions without leaving wasm', { skip: !tailCalls }, ()=>{
    const m = machine([
        0xb8, ...u32(1),            //     mov eax, 1
        0xe8, ...u32(6),            //     call F
        0xb9, ...u32(3),            //     mov ecx, 3
        0xf4,                       //     hlt
        0xbb, ...u32(2),            // F:  mov ebx, 2
        0xc3,                       //     ret
    ]);
    const r = m.runProgram(CODE);
    assert.equal(r.kind, 3, 'halted');
    assert.equal(r.regions, 2, 'the caller and the callee');
    assert.equal(r.runs, 2, 'the return came back into the caller by the hash');
    assert.deepEqual([m.reg('eax'), m.reg('ebx'), m.reg('ecx')], [1, 2, 3]);
    assert.equal(m.reg('esp'), STACK, 'the return address is popped');
    assert.equal(r.retired, 6);
});

test('an indirect jump through a table finds the translated target', { skip: !tailCalls }, ()=>{
    const T = CODE + 0x20;
    const m = machine([
        0xb9, ...u32(3),                    //     mov ecx, 3
        0xb8, ...u32(1),                    // L:  mov eax, 1
        0xff, 0x24, 0x85, ...u32(DATA),     //     jmp [DATA + eax*4]
    ], [...u32(0), ...u32(T)]);
    m.write(T, [
        0x49,                               // T:  dec ecx
        0x75, (CODE + 5 - (T + 3)) & 0xff,  //     jnz L
        0xf4,                               //     hlt
    ]);
    const r = m.runProgram(CODE);
    assert.equal(r.kind, 3);
    assert.equal(r.regions, 2);
    // The first jump misses (T untranslated); every jump and branch after
    // it is a transfer: two regions, two calls from here.
    assert.equal(r.runs, 2);
    assert.equal(m.reg('ecx'), 0);
    assert.equal(r.retired, 1 + 3 * 4 + 1);
});

test('a target with no entry leaves untranslated at that address', ()=>{
    const m = machine([
        0xb8, ...u32(0),                    // mov eax, 0
        0xff, 0x24, 0x85, ...u32(DATA),     // jmp [DATA + eax*4]
    ], [...u32(0x3000)]);
    const unit = m.translate(CODE, { hash: true });
    assert.deepEqual(unit.run(CODE), { kind: 0, vector: 0 });
    assert.equal(m.eip(), 0x3000);
    assert.equal(m.reg('eax'), 0);
});

test('ret imm pops the arguments after the return address', { skip: !tailCalls }, ()=>{
    const m = machine([
        0x6a, 0x01,                 //     push 1
        0x6a, 0x02,                 //     push 2
        0xe8, ...u32(1),            //     call F
        0xf4,                       //     hlt
        0xc2, 0x08, 0x00,           // F:  ret 8
    ]);
    const r = m.runProgram(CODE);
    assert.equal(r.kind, 3);
    assert.equal(r.runs, 2);
    assert.equal(m.reg('esp'), STACK, 'the two arguments and the return address are gone');
});

test('a region entered from the hash sees the registers the other left', { skip: !tailCalls },
    ()=>{
        // The callee changes every register the caller reads after the
        // return, and the flags: the transfer carries them through memory.
        const m = machine([
            0xb8, ...u32(5),            //     mov eax, 5
            0xe8, ...u32(6),            //     call F
            0x0f, 0x94, 0xc1,           //     sete cl        ZF from the callee's sub
            0x01, 0xd8,                 //     add eax, ebx
            0xf4,                       //     hlt
            0xbb, ...u32(7),            // F:  mov ebx, 7
            0x29, 0xc0,                 //     sub eax, eax   ZF = 1
            0xc3,                       //     ret
        ]);
        const r = m.runProgram(CODE);
        assert.equal(r.kind, 3);
        assert.equal(r.runs, 2);
        assert.equal(m.reg('eax'), 7);
        assert.equal(m.reg('ecx') & 0xff, 1, 'ZF crossed the transfer');
    });

test('a block that leaves at once is no entry, so a transfer never spins on it', ()=>{
    // `fxsave` is left to the other executor: the block it starts leaves
    // before running anything, and the loop that jumps to it must come back
    // to the caller rather than transfer into that block forever.
    const m = machine([
        0xb9, ...u32(2),            //     mov ecx, 2
        0xeb, 0x06,                 //     jmp F
        0x49,                       // L:  dec ecx
        0x75, 0x03,                 //     jnz F
        0xf4,                       //     hlt
        0x90, 0x90,                 //     (pad)
        0x0f, 0xae, 0x05, ...u32(DATA), // F: fxsave [DATA]
        0xeb, 0xf1,                 //     jmp L
    ]);
    const r = m.runProgram(CODE, { budget: 1000 });
    // The machine's answer for a region that makes no progress at its
    // entry: the instruction is the other executor's.
    assert.equal(r.kind, -2);
    assert.equal(m.eip(), CODE + 13);
    assert.equal(r.runs, 2);
    assert.equal(m.reg('ecx'), 2);
});

test('an indirect call reaches its target with the return address pushed', ()=>{
    // Found by a whole program under hybrid: the call's target was parked in
    // the local the push then used for the value, so every indirect call
    // "returned" to the instruction after itself without calling anything.
    /** @type {[string, number[]][]} */
    const forms = [
        ['register', [0xb8, ...u32(CODE + 0x20), 0xff, 0xd0]],        // mov eax, F; call eax
        ['memory', [0xff, 0x15, ...u32(DATA)]],                       // call [DATA]
        ['stack-relative', [0x68, ...u32(CODE + 0x20), 0xff, 0x14, 0x24]], // push F; call [esp]
    ];
    for (const [name, call] of forms)
    {
        const m = machine([
            0xbb, ...u32(1),                    //     mov ebx, 1
            ...call,
            0xf4,                               //     hlt (never: F halts)
        ], [...u32(CODE + 0x20)]);
        const F = CODE + 0x20;
        m.write(F, [
            0x5a,                               // F:  pop edx     the return address
            0xbb, ...u32(2),                    //     mov ebx, 2
            0xf4,                               //     hlt
        ]);
        const returnAddress = CODE + 5 + call.length;
        const unit = m.translate(CODE, { hash: true });
        assert.deepEqual(unit.run(CODE), { kind: 0, vector: 0 }, name);
        assert.equal(m.eip(), F, `${name}: left for the target`);
        assert.equal(m.readU32(m.reg('esp')), returnAddress, `${name}: the return address`);
        const r = m.runProgram(F);
        assert.equal(r.kind, 3, name);
        assert.equal(m.reg('edx'), returnAddress, name);
        assert.equal(m.reg('ebx'), 2, name);
    }
});

test('out dx, eax to the trap port leaves with a trap past it; any other port is left before',
    ()=>{
        const PORT = 0xb077;
        const program = [
            0xbb, ...u32(1),                    //     mov ebx, 1
            0x66, 0xba, PORT & 0xff, PORT >> 8, //     mov dx, PORT
            0xb8, ...u32(7),                    //     mov eax, 7
            0xef,                               //     out dx, eax
            0x43,                               //     inc ebx
            0xf4,                               //     hlt
        ];
        const m = createTestMachine({ trapPort: PORT });
        m.write(CODE, program);
        m.setReg('esp', STACK);
        const unit = m.translate(CODE, { hash: true });
        assert.deepEqual(unit.run(CODE), { kind: 2, vector: 0 }, 'trap');
        assert.equal(m.eip(), CODE + 15, 'past the out');
        assert.equal(m.reg('eax'), 7, 'the value the port would have been written');
        assert.equal(m.reg('ebx'), 1, 'the instruction after it has not run');
        assert.equal(m.counter(), 4, 'the out is counted');
        // Resuming after the trap: the block past the out is an entry.
        assert.ok(unit.translation.labels.has(CODE + 15));
        assert.deepEqual(unit.run(CODE + 15), { kind: 3, vector: 0 });
        assert.equal(m.reg('ebx'), 2);
        // Another port: the other executor's, before the instruction.
        const other = createTestMachine({ trapPort: PORT });
        other.write(CODE, [0x66, 0xba, 0x78, 0xb0, 0xb8, ...u32(7), 0xef, 0xf4]); // dx = PORT+1
        other.setReg('esp', STACK);
        const o = other.translate(CODE, { hash: true });
        assert.deepEqual(o.run(CODE), { kind: 0, vector: 0 });
        assert.equal(other.eip(), CODE + 9, 'at the out');
        assert.equal(other.counter(), 2);
        // Without a port configured, every out is the other executor's.
        const none = createTestMachine();
        none.write(CODE, program);
        none.setReg('esp', STACK);
        const n = none.translate(CODE, { hash: true });
        assert.deepEqual(n.run(CODE), { kind: 0, vector: 0 });
        assert.equal(none.eip(), CODE + 14);
    });
