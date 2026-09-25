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
    const r = m.runProgram(CODE, { leafCalls: false });
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
    const r = m.runProgram(CODE, { leafCalls: false });
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
        const r = m.runProgram(CODE, { leafCalls: false });
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

test('out dx, eax to the trap port calls the host from inside the region; others leave before',
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
        // The import called from inside the region: it sees the state block
        // as the host would (eax the value, EIP past the out, the count
        // charged), answers in it, and the program goes on.
        /** @type {{ eax: number, eip: number, counter: number }[]} */
        const seen = [];
        const m = createTestMachine({
            trapPort: PORT,
            trap: value=>{
                seen.push({ eax: value, eip: m.eip(), counter: m.counter() });
                m.setReg('eax', 0x77);
                // One the region never names: under cork's layout it came in
                // as a parameter, and the exit writes every register back.
                m.setReg('esi', 0x99);
                return 0;
            },
        });
        m.write(CODE, program);
        m.setReg('esp', STACK);
        const unit = m.translate(CODE, { hash: true });
        assert.deepEqual(unit.run(CODE), { kind: 3, vector: 0 }, 'halted, the call made');
        assert.deepEqual(seen, [{ eax: 7, eip: CODE + 15, counter: 4 }]);
        assert.equal(m.reg('eax'), 0x77, 'the answer, taken back into the locals');
        assert.equal(m.reg('ebx'), 2, 'the instruction after it ran');
        assert.equal(m.reg('esi'), 0x99, 'a register the handler set and the region never names');
        assert.equal(m.counter(), 6);
        // A handler that moves EIP: the region leaves there, untranslated.
        const moved = createTestMachine({
            trapPort: PORT,
            trap: ()=>{
                new DataView(moved.memory.buffer).setUint32(moved.layout.eip, 0x9000, true);
                return 1;
            },
        });
        moved.write(CODE, program);
        moved.setReg('esp', STACK);
        assert.deepEqual(moved.translate(CODE, { hash: true }).run(CODE), { kind: 0, vector: 0 });
        assert.equal(moved.eip(), 0x9000);
        assert.equal(moved.reg('ebx'), 1, 'the instruction after the out did not run');
        // With x87 registers live in the region, the exit past the out instead.
        const fp = createTestMachine({ trapPort: PORT, trap: ()=>0 });
        fp.write(CODE, [0xd9, 0xe8, ...program]); // fld1 first
        fp.setReg('esp', STACK);
        const f = fp.translate(CODE, { hash: true });
        assert.deepEqual(f.run(CODE), { kind: 2, vector: 0 }, 'trap exit');
        assert.equal(fp.eip(), CODE + 17, 'past the out');
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

test('a small leaf callee is formed into its caller: the call and the return are jumps', ()=>{
    const m = machine([
        0xb9, ...u32(4),            //     mov ecx, 4
        0xe8, ...u32(4),            // L:  call F
        0x49,                       //     dec ecx
        0x75, 0xf8,                 //     jnz L
        0xf4,                       //     hlt
        0x83, 0xc0, 0x03,           // F:  add eax, 3
        0xc3,                       //     ret
    ]);
    const r = m.runProgram(CODE);
    assert.equal(r.kind, 3);
    assert.equal(r.regions, 1, 'the callee is a block of the caller');
    assert.equal(r.runs, 1, 'and nothing left the region');
    assert.equal(m.reg('eax'), 12);
    assert.equal(m.reg('esp'), STACK, 'every return address pushed was popped');
    assert.equal(r.retired, 1 + 4 * 5 + 1);
});

test('a formed-in callee that returns elsewhere leaves by the address it popped', ()=>{
    // F replaces its return address: the ret goes to T, not after the call.
    const T = CODE + 0x40;
    const m = machine([
        0xe8, ...u32(1),            //     call F
        0xf4,                       //     hlt          (not reached)
        0x58,                       // F:  pop eax
        0x68, ...u32(T),            //     push T
        0xc3,                       //     ret
    ]);
    m.write(T, [0xbb, ...u32(9), 0xf4]);     // T: mov ebx, 9; hlt
    const r = m.runProgram(CODE);
    assert.equal(r.kind, 3);
    assert.equal(m.reg('ebx'), 9, 'T ran');
    assert.equal(m.reg('eax'), CODE + 5, 'the return address the call pushed');
    assert.equal(m.reg('esp'), STACK);
});

test('a call into a formed-in callee whose push lands in code leaves stale at the callee', ()=>{
    const m = machine([
        0xe8, ...u32(1),            //     call F
        0xf4,                       //     hlt
        0xc3,                       // F:  ret
    ]);
    m.pages.markCode(STACK - 4, 4);
    const r = m.runProgram(CODE);
    assert.equal(r.kind, 5, 'stale');
    assert.equal(m.eip(), CODE + 6, 'past the call, at the callee');
    assert.equal(m.reg('esp'), STACK - 4, 'with the return address pushed');
});

/**
 * A switch over `ecx & 3` in a loop, as a compiler lays it out: `cmp eax, 2;
 * ja default; jmp [DATA + eax*4]` with three cases in the table at DATA, the
 * fourth value to the default.
 * @param {number} count
 */
function switchLoop(count){
    return [
        0xb9, ...u32(count),                // 00     mov ecx, count
        0x89, 0xc8,                         // 05 L:  mov eax, ecx
        0x83, 0xe0, 0x03,                   // 07     and eax, 3
        0x83, 0xf8, 0x02,                   // 0a     cmp eax, 2
        0x77, 0x14,                         // 0d     ja D
        0xff, 0x24, 0x85, ...u32(DATA),     // 0f     jmp [DATA + eax*4]
        0x43,                               // 16 C0: inc ebx
        0xeb, 0x0d,                         // 17     jmp N
        0x83, 0xc3, 0x02,                   // 19 C1: add ebx, 2
        0xeb, 0x08,                         // 1c     jmp N
        0x83, 0xc3, 0x03,                   // 1e C2: add ebx, 3
        0xeb, 0x03,                         // 21     jmp N
        0x83, 0xc3, 0x04,                   // 23 D:  add ebx, 4
        0x49,                               // 26 N:  dec ecx
        0x75, 0xdc,                         // 27     jnz L
        0xf4,                               // 29     hlt
    ];
}

test('a switch\'s jump through its table is a branch among its cases, in one region', ()=>{
    const table = [...u32(CODE + 0x16), ...u32(CODE + 0x19), ...u32(CODE + 0x1e)];
    const m = machine(switchLoop(8), table);
    const r = m.runProgram(CODE);
    assert.equal(r.kind, 3);
    // ecx & 3 over 8..1 is 0 3 2 1 0 3 2 1: cases 1 4 3 2 twice.
    assert.equal(m.reg('ebx'), 20);
    assert.equal(r.regions, 1, 'the cases are the region\'s own blocks');
    assert.equal(r.runs, 1, 'no jump left the region');
    // Six case turns of nine instructions, two default turns of seven.
    assert.equal(r.retired, 1 + 6 * 9 + 2 * 7 + 1);
});

test('a switch whose table is rewritten after forming goes where the table now says', ()=>{
    const table = [...u32(CODE + 0x16), ...u32(CODE + 0x19), ...u32(CODE + 0x1e)];
    const m = machine(switchLoop(8), table);
    const unit = m.translate(CODE);
    assert.deepEqual(unit.run(CODE), { kind: 3, vector: 0 });
    assert.equal(m.reg('ebx'), 20);
    // Case 0 now goes to the default's code: the jump leaves for it -- by
    // the entry hash, back into the same region -- rather than taking the
    // branch it was formed with.
    m.writeU32(DATA, CODE + 0x23);
    m.setReg('ebx', 0);
    const r = m.runProgram(CODE);
    assert.equal(r.kind, 3);
    assert.equal(m.reg('ebx'), 20 - 2 * 1 + 2 * 4);
});
