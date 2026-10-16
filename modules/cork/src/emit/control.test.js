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
import { Body, ModuleBuilder, ValType } from '../wasm/encoder.js';
import { I32 } from './flags.js';
import { Exit, TIER_ENTRY } from './region.js';
import { ownLayout, sharedLayout } from '../runtime/layout.js';
import { WasmExit } from '../interp-wasm.js';

const CODE = 0x1000;
const DATA = 0x2000;
const STACK = 0x80000;
/** Where the tier's stand-in sends a region on, where nothing is translated, and where it
 * keeps what it found. */
const AFTER = CODE + 0x40;
const ELSEWHERE = 0x3000;
const SEEN = DATA + 0x100;
/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {number} value */
const f64 = value=>[...new Uint8Array(new Float64Array([value]).buffer)];
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
        // A handler that ends the turn (2) -- a thread of higher priority made
        // ready -- with EIP left past the out: the region goes back to the
        // host's loop there, rather than on through the code after the write.
        const ended = createTestMachine({ trapPort: PORT, trap: ()=>2 });
        ended.write(CODE, program);
        ended.setReg('esp', STACK);
        assert.deepEqual(ended.translate(CODE, { hash: true }).run(CODE), { kind: 0, vector: 0 });
        assert.equal(ended.eip(), CODE + 15, 'stopped past the out');
        assert.equal(ended.reg('ebx'), 1, 'the instruction after the out is left to the next turn');
        // With x87 registers live in the region the call is made from it too,
        // the stack written back first, and the region then leaves for wherever
        // EIP is: the handler may have moved the top the code after the out was
        // compiled for.
        /** @type {number[]} */
        const fpSeen = [];
        const fp = createTestMachine({ trapPort: PORT, trap: value=>{
            const view = new DataView(fp.memory.buffer);
            fpSeen.push(value, view.getUint8(fp.layout.x87Top), view.getFloat64(fp.layout.x87
                + view.getUint8(fp.layout.x87Top) * 16, true), fp.eip());
            return 0;
        } });
        fp.write(CODE, [0xd9, 0xe8, ...program]); // fld1 first
        fp.setReg('esp', STACK);
        const f = fp.translate(CODE, { hash: true });
        assert.deepEqual(f.run(CODE), { kind: 0, vector: 0 }, 'left after the call');
        assert.deepEqual(fpSeen, [7, 7, 1, CODE + 17], 'the value, the pushed 1 in ST0, EIP');
        assert.equal(fp.eip(), CODE + 17, 'past the out');
        assert.equal(fp.reg('ebx'), 1, 'the instruction after it is the next region\'s');
        // Where the x87 and MMX views meet, the exit past the out, for the host.
        const mixed = createTestMachine({ trapPort: PORT, trap: ()=>0 });
        mixed.write(CODE, [0x0f, 0x6f, 0xc1, 0x0f, 0x77, 0xd9, 0xe8, ...program]);
        mixed.setReg('esp', STACK);
        const x = mixed.translate(CODE, { hash: true });
        assert.deepEqual(x.run(CODE), { kind: 2, vector: 0 }, 'trap exit');
        assert.equal(mixed.eip(), CODE + 22, 'past the out');
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

test('a handler called from a region with x87 finds the stack whole and may change it', ()=>{
    // CODE: fld a; fld b; call F; fstp [DATA+16]; hlt -- F: fxch st1; fld1; faddp st1;
    // mov dx, PORT; mov eax, id; out dx, eax; ret. At the out the region holds the
    // registers exchanged in its locals; the handler reads ST0 = a + 1 and ST1 = b from
    // the state block and leaves one value in their place, or two, or moves EIP to a
    // hlt of its own; the program goes on from what the handler left.
    const PORT = 0xb077;
    const F = CODE + 0x20;
    const HALT = CODE + 0x40;
    const code = new Array(0x48).fill(0x90);
    code.splice(0, 20, 0xdd, 0x05, ...u32(DATA), 0xdd, 0x05, ...u32(DATA + 8),
        0xe8, ...u32(F - (CODE + 17)), 0xdd, 0x1d, ...u32(DATA + 16));
    code[23] = 0xf4;
    code.splice(0x20, 17, 0xd9, 0xc9, 0xd9, 0xe8, 0xde, 0xc1,
        0x66, 0xba, PORT & 0xff, PORT >> 8, 0xb8, ...u32(3), 0xef, 0xc3);
    code[0x40] = 0xf4;
    for (const [name, answer] of /** @type {const} */ ([['one', 1], ['two', 2], ['moved', 0]]))
    {
        /** @type {number[]} */
        const seen = [];
        const m = createTestMachine({ trapPort: PORT, trap: value=>{
            const view = new DataView(m.memory.buffer);
            const top = view.getUint8(m.layout.x87Top);
            /** @param {number} i */
            const at = i=>m.layout.x87 + ((top + i) & 7) * 16;
            seen.push(value, view.getFloat64(at(0), true), view.getFloat64(at(1), true));
            const product = view.getFloat64(at(0), true) * view.getFloat64(at(1), true);
            if (answer === 0)
            {
                view.setUint32(m.layout.eip, HALT, true);
                return 1;
            }
            // Two popped, `answer` pushed: the product, and its half under it.
            const rest = (top + 2 - answer) & 7;
            view.setFloat64(m.layout.x87 + rest * 16, product, true);
            view.setFloat64(m.layout.x87 + ((rest + 1) & 7) * 16, product / 2, true);
            view.setUint8(m.layout.x87Top, rest);
            view.setUint8(m.layout.x87Empty, answer === 1 ? 0xff & ~(1 << rest)
                : 0xff & ~(1 << rest | 1 << ((rest + 1) & 7)));
            return 0;
        } });
        m.write(CODE, code);
        m.write(DATA, [...f64(3), ...f64(5)]);
        m.setReg('esp', STACK);
        const exit = m.runProgram(CODE);
        assert.equal(exit.kind, Exit.HALT, name);
        assert.deepEqual(seen, [3, 4, 5], `${name}: the value, ST0 and ST1 as they were`);
        const view = new DataView(m.memory.buffer);
        if (answer === 0)
        {
            assert.equal(m.eip(), HALT + 1, `${name}: at the handler's hlt`);
            assert.equal(view.getUint8(m.layout.x87Top), 6, `${name}: the two left`);
            continue;
        }
        assert.equal(m.eip(), CODE + 24, `${name}: past the caller's hlt`);
        assert.equal(view.getFloat64(m.layout.ramBase + DATA + 16, true), 20,
            `${name}: the product stored`);
        assert.equal(view.getUint8(m.layout.x87Top), answer === 1 ? 0 : 7, `${name}: the top`);
        assert.equal(view.getUint8(m.layout.x87Empty), answer === 1 ? 0xff : 0x7f,
            `${name}: the empty mask`);
    }
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

test('an indirect call jumps to a predicted callee formed into its region, and leaves for'
    + ' any other', { skip: !tailCalls }, ()=>{
    const F = CODE + 21;
    const G = CODE + 25;
    const program = [
        0xb9, ...u32(4),                    //     mov ecx, 4
        0x89, 0xc8,                         // L:  mov eax, ecx
        0x83, 0xe0, 0x01,                   //     and eax, 1
        0xff, 0x14, 0x85, ...u32(DATA),     //     call [DATA + eax*4]
        0x49,                               //     dec ecx
        0x75, 0xf1,                         //     jnz L
        0xf4,                               //     hlt
        0x83, 0xc3, 0x01, 0xc3,             // F:  add ebx, 1; ret
        0x83, 0xc3, 0x10, 0xc3,             // G:  add ebx, 16; ret
    ];
    const call = CODE + 10;
    for (const [predicted, regions] of /** @type {[number[], number][]} */ ([[[F], 2], [[F, G], 1]]))
    {
        const m = machine(program, [...u32(F), ...u32(G)]);
        const r = m.runProgram(CODE, { callTargets: new Map([[call, predicted]]) });
        assert.equal(r.kind, 3);
        assert.equal(r.regions, regions, `${predicted.length} predicted: G a region or a block`);
        assert.equal(m.reg('ebx'), 2 * 1 + 2 * 16);
        assert.equal(m.reg('esp'), STACK);
        assert.equal(r.retired, 1 + 4 * 7 + 1);
    }
});

test('an indirect call whose push lands in code leaves stale at its target, predicted or not',
    { skip: !tailCalls }, ()=>{
        const F = CODE + 7;
        const m = machine([
            0xff, 0x15, ...u32(DATA),       //     call [DATA]
            0xf4,                           //     hlt
            0x83, 0xe4, 0xff,               // F:  and esp, -1
            0xc3,                           //     ret
        ], u32(F));
        m.pages.markCode(STACK - 4, 4);
        const r = m.runProgram(CODE, { callTargets: new Map([[CODE, [F]]]) });
        assert.equal(r.kind, 5, 'stale');
        assert.equal(m.eip(), F);
        assert.equal(m.reg('esp'), STACK - 4, 'with the return address pushed');
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
    // The callee's `and esp, -1` gives its return's pop a window of its own,
    // so the push is tested, and noted, alone.
    const m = machine([
        0xe8, ...u32(1),            //     call F
        0xf4,                       //     hlt
        0x83, 0xe4, 0xff,           // F:  and esp, -1
        0xc3,                       //     ret
    ]);
    m.pages.markCode(STACK - 4, 4);
    const r = m.runProgram(CODE);
    assert.equal(r.kind, 5, 'stale');
    assert.equal(m.eip(), CODE + 6, 'past the call, at the callee');
    assert.equal(m.reg('esp'), STACK - 4, 'with the return address pushed');
    // A pop off the esp the push left is in the push's window, which leaves
    // before the call: the other executor runs it.
    const n = machine([0xe8, ...u32(1), 0xf4, 0xc3]);
    n.pages.markCode(STACK - 4, 4);
    assert.equal(n.runProgram(CODE).kind, -2, 'held at the call');
    assert.equal(n.eip(), CODE);
    assert.equal(n.reg('esp'), STACK, 'nothing pushed');
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

/**
 * A stand-in for the interpreter tier in wasm at `TIER_SLOT`: a wasm function over
 * the machine's memory that keeps what it found -- the flags word, the record's kind
 * and its budget, at `SEEN` -- moves EIP to `to`, adds `ran` to the counter word as
 * the tier does, and answers `code` with `ran` above it.
 *
 * @param {ReturnType<typeof createTestMachine>} m
 * @param {{ to: number, ran: number, code: number }} answer
 */
function tierStandIn(m, { to, ran, code }){
    const { layout } = m;
    const b = new Body();
    b.i32const(0).i32const(0).load('i32', { offset: layout.eflags })
        .store('i32', { offset: layout.ramBase + SEEN });
    b.i32const(0).i32const(0).load('i32', { offset: /** @type {number} */ (layout.flagRecord) })
        .store('i32', { offset: layout.ramBase + SEEN + 4 });
    b.i32const(0).localGet(0).store('i32', { offset: layout.ramBase + SEEN + 8 });
    b.i32const(0).i32const(to).store('i32', { offset: layout.eip });
    b.i32const(0).i32const(0).load('i32', { offset: layout.counter }).i32const(ran)
        .op(I32.add).store('i32', { offset: layout.counter });
    b.i32const(code | ran << 8);
    const builder = new ModuleBuilder();
    builder.importMemory('env', 'memory', { min: 1 });
    builder.function(builder.type({ params: [ValType.i32], results: [ValType.i32] }), [],
        b.toBytes(), { exportAs: 'enter' });
    const bytes = /** @type {Uint8Array<ArrayBuffer>} */ (builder.toBytes());
    const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes),
        { env: { memory: m.memory } });
    return /** @type {Function} */ (instance.exports.enter);
}

/**
 * A region that sets a lazy record (`cmp eax, eax`) and jumps through a table to an
 * address with no entry, and one at `AFTER` the stand-in may send it on to.
 */
function resumeMachine(){
    const m = createTestMachine({ resume: true });
    m.write(CODE, [
        0xb8, ...u32(5),                    // mov eax, 5
        0x39, 0xc0,                         // cmp eax, eax
        0xff, 0x25, ...u32(DATA),           // jmp [DATA]
    ]);
    m.write(AFTER, [
        0xbb, ...u32(7),                    // mov ebx, 7
        0xf4,                               // hlt
    ]);
    m.write(DATA, u32(ELSEWHERE));
    m.setReg('esp', STACK);
    const unit = m.translate(CODE, { hash: true });
    m.translate(AFTER, { hash: true });
    return { m, unit };
}

test('under resume a miss runs the tier in place and goes on at the entry it stopped at',
    { skip: !tailCalls }, ()=>{
        const { m, unit } = resumeMachine();
        m.setTier(tierStandIn(m, { to: AFTER, ran: 4, code: TIER_ENTRY }));
        assert.deepEqual(unit.run(CODE, 1000), { kind: 3, vector: 0 }, 'halted in the other');
        assert.equal(m.reg('ebx'), 7);
        // mov, cmp, jmp; the tier's four; mov and hlt.
        assert.equal(m.counter(), 3 + 4 + 2);
        assert.equal(m.readU32(SEEN) & 0x40, 0x40, 'the tier read ZF folded into the word');
        assert.equal(m.readU32(SEEN + 4), 0, 'with the record cleared');
        assert.equal(m.readU32(SEEN + 8), 1000 - 3, 'and the budget left');
    });

test('under resume what else the tier stops for leaves with its code for the host',
    { skip: !tailCalls }, ()=>{
        for (const code of [WasmExit.HOT, TIER_ENTRY])
        {
            const { m, unit } = resumeMachine();
            // An entry with the budget spent is the host's to take, as a hot start is.
            const ran = code === TIER_ENTRY ? 1000 - 3 : 0;
            m.setTier(tierStandIn(m, { to: AFTER, ran, code }));
            assert.deepEqual(unit.run(CODE, 1000), { kind: Exit.INTERPRETED, vector: code });
            assert.equal(m.eip(), AFTER);
            assert.equal(m.reg('ebx'), 0, 'the other region did not run');
            assert.equal(m.counter(), 3 + ran);
        }
    });

test('under resume a tier that answers 0 is none: the miss leaves untranslated as before',
    { skip: !tailCalls }, ()=>{
        const { m, unit } = resumeMachine();
        m.setTier(tierStandIn(m, { to: ELSEWHERE, ran: 0, code: 0 }));
        assert.deepEqual(unit.run(CODE, 1000), { kind: Exit.UNTRANSLATED, vector: 0 });
        assert.equal(m.eip(), ELSEWHERE);
        assert.equal(m.counter(), 3);
    });

test('the tier\'s code the transfer goes on at is the tier\'s own', ()=>{
    assert.equal(TIER_ENTRY, WasmExit.ENTRY);
});

test('where other executors run beside it, a back edge leaves on the interrupt word with budget'
    + ' left, and goes round while the word is clear', ()=>{
    const loops = {
        // A block that is its own loop.
        self: [
            0xb9, ...u32(1000),         //     mov ecx, 1000
            0x49,                       // L:  dec ecx
            0x75, 0xfd,                 //     jnz L
            0xf4,                       //     hlt
        ],
        // A loop of two blocks, closed by a jump back to its head.
        jump: [
            0xb9, ...u32(1000),         //     mov ecx, 1000
            0x49,                       // L:  dec ecx
            0x74, 0x03,                 //     jz out
            0x90,                       //     nop
            0xeb, 0xfa,                 //     jmp L
            0xf4,                       // out: hlt
        ],
    };
    for (const [shape, code] of Object.entries(loops))
    {
        const m = createTestMachine({ processors: 2 });
        m.write(CODE, code);
        m.setReg('esp', STACK);
        const at = /** @type {number} */ (m.layout.interrupt);
        assert.ok(at >= 0, 'a layout with another executor has the word');
        const word = new DataView(m.memory.buffer);
        word.setInt32(at, 0x7fffffff, true);
        const asked = m.runProgram(CODE, { budget: 1_000_000 });
        assert.equal(asked.kind, Exit.BUDGET, `${shape}: left at a back edge`);
        assert.ok(asked.retired < 10 && m.reg('ecx') >= 998,
            `${shape}: after ${asked.retired} instructions, ecx ${m.reg('ecx')}`);
        word.setInt32(at, 0, true);
        const clear = m.runProgram(CODE, { budget: 1_000_000 });
        assert.equal(clear.kind, Exit.HALT, `${shape}: round to the end`);
        assert.equal(m.reg('ecx'), 0, shape);
    }
    assert.equal(createTestMachine().layout.interrupt, undefined,
        'one executor\'s layout has no word: its back edges look at the budget alone');
    assert.equal(sharedLayout(ownLayout({ ramSize: 1 << 20, processors: 2 })).interrupt, undefined,
        'nor the layout the other executors share');
});
