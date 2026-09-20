/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { decode } from '../decode/decoder.js';
import { createState, evaluate } from '../ir.js';
import { CF, OF, PF, SF, ZF } from '../decode/table.js';

const CODE = 0x1000;
const STACK = 0x80000;

/**
 * Runs a program on translated code and on the model from the same start,
 * and answers both, so a test can assert on the one and know the other
 * agrees.
 *
 * @param {number[]} bytes
 * @param {{ regs?: Record<string, number>, eflags?: number,
 *     memory?: [number, number[]][] }} [start]
 */
function both(bytes, start = {}){
    const m = createTestMachine();
    m.write(CODE, bytes);
    m.setReg('esp', STACK);
    for (const [address, data] of start.memory ?? [])
    {
        m.write(address, data);
    }
    for (const [name, value] of Object.entries(start.regs ?? {}))
    {
        m.setReg(name, value);
    }
    m.setEflags(start.eflags ?? 2);
    const exit = m.runProgram(CODE);

    // The model, over its own copy of the same memory.
    const ram = new Uint8Array(1 << 20);
    ram.set(bytes, CODE);
    for (const [address, data] of start.memory ?? [])
    {
        ram.set(data, address);
    }
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
    }, { eip: CODE, esp: STACK });
    for (const [name, value] of Object.entries(start.regs ?? {}))
    {
        const index = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'].indexOf(name);
        state.reg[index] = value >>> 0;
    }
    state.eflags = start.eflags ?? 2;
    /** @type {any} */
    let modelFault = null;
    try
    {
        while (!state.halted && state.retired < 100000)
        {
            const decoded = decode(address=>ram[address], state.eip);
            if ('refused' in decoded)
            {
                break;
            }
            evaluate(decoded, state);
        }
    }
    catch (e){
        modelFault = e;
    }
    return { m, exit, state, ram, modelFault };
}

/**
 * Asserts the machine and the model agree on registers, flags and eip.
 * @param {ReturnType<typeof both>} r
 */
function agree(r){
    const names = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
    for (let i = 0; i < 8; i++)
    {
        assert.equal(r.m.reg(names[i]), r.state.reg[i], `${names[i]} differs from the model`);
    }
    if (r.modelFault === null)
    {
        assert.equal(r.m.eflags() & 0x8d5, r.state.eflags & 0x8d5,
            'the arithmetic flags differ from the model');
        assert.equal(r.m.eip(), r.state.eip, 'eip differs from the model');
    }
}

test('mov, add, and a halt: the result, the flags and the count', ()=>{
    const r = both([0xb8, 5, 0, 0, 0, 0x83, 0xc0, 7, 0xf4]); // mov eax,5; add eax,7; hlt
    assert.equal(r.exit.kind, 3);
    assert.equal(r.m.reg('eax'), 12);
    assert.equal(r.m.eflags() & PF, PF, '12 = 1100b has even parity');
    assert.equal(r.m.counter(), 3);
    agree(r);
});

test('every arithmetic form on registers, memory and immediates', ()=>{
    const r = both([
        0xb8, 0xff, 0xff, 0xff, 0xff,             // mov eax, -1
        0x83, 0xc0, 0x01,                         // add eax, 1        CF
        0xb9, 0x05, 0, 0, 0,                      // mov ecx, 5
        0x83, 0xd1, 0x00,                         // adc ecx, 0        -> 6
        0x66, 0x83, 0xe9, 0x07,                   // sub cx, 7         -> 0xffff CF
        0x80, 0xdd, 0x00,                         // sbb ch, 0         -> 0xfe
        0x89, 0x0d, 0x00, 0x20, 0, 0,             // mov [0x2000], ecx
        0x83, 0x05, 0x00, 0x20, 0, 0, 0x10,       // add dword [0x2000], 0x10
        0x8b, 0x1d, 0x00, 0x20, 0, 0,             // mov ebx, [0x2000]
        0x29, 0xd8,                               // sub eax, ebx
        0xf7, 0xd8,                               // neg eax
        0xf7, 0xd3,                               // not ebx
        0x0f, 0xc1, 0xd8,                         // xadd eax, ebx
        0xf4,
    ]);
    assert.equal(r.exit.kind, 3);
    agree(r);
    assert.equal(r.m.reg('ecx'), 0xfeff);
    assert.equal(r.m.readU32(0x2000), 0xff0f);
});

test('logic, inc/dec keeping CF, test, and the shifts by one and by cl', ()=>{
    const r = both([
        0xb8, 0x0f, 0, 0, 0, 0x83, 0xe0, 0x03, 0x35, 0xf0, 0, 0, 0, 0x0d, 0, 1, 0, 0, // and/xor/or
        0xf9, 0x40,                                     // stc; inc eax (CF kept)
        0x0f, 0x92, 0xc3,                               // setb bl
        0xb9, 0x01, 0, 0, 0, 0xd1, 0xe1,                // mov ecx,1; shl ecx,1
        0xc1, 0xe1, 0x1e,                               // shl ecx, 30 -> 0x80000000
        0xd1, 0xe9,                                     // shr ecx, 1
        0xba, 0xf8, 0xff, 0xff, 0xff, 0xd1, 0xfa,       // mov edx,-8; sar edx,1
        0xb1, 0x04, 0xd3, 0xe2,                         // mov cl,4; shl edx, cl
        0xb1, 0x00, 0xd3, 0xe2,                         // mov cl,0; shl edx, cl (no change)
        0x66, 0xc1, 0xe8, 0x08,                         // shr ax, 8
        0xa9, 0x00, 0x01, 0, 0,                         // test eax, 0x100
        0xf4,
    ]);
    assert.equal(r.exit.kind, 3);
    agree(r);
    assert.equal(r.m.reg('ebx') & 0xff, 1, 'setb saw the carry inc kept');
});

test('multiplication and division, and the divide fault', ()=>{
    const r = both([
        0xb8, 0, 0, 1, 0, 0xbb, 0, 0, 1, 0, 0xf7, 0xe3,   // mul ebx -> edx:eax = 1:0
        0xb8, 0xfe, 0xff, 0xff, 0xff, 0x6b, 0xc0, 0x03,   // imul eax, eax, 3 -> -6
        0x69, 0xc0, 0x00, 0x00, 0x00, 0x40,               // imul eax, eax, 0x40000000 (overflows)
        0x0f, 0x90, 0xc1,                                 // seto cl
        0xb8, 7, 0, 0, 0, 0x31, 0xd2, 0xbb, 2, 0, 0, 0, 0xf7, 0xf3, // 7 / 2
        0xb8, 0xf9, 0xff, 0xff, 0xff, 0x99, 0xbb, 2, 0, 0, 0, 0xf7, 0xfb, // -7 idiv 2
        0xf4,
    ]);
    assert.equal(r.exit.kind, 3);
    agree(r);
    assert.equal(r.m.reg('ecx') & 0xff, 1, 'the overflow was seen');

    const fault = both([0xb8, 1, 0, 0, 0, 0x31, 0xdb, 0xf7, 0xf3]); // div ebx with ebx = 0
    assert.deepEqual([fault.exit.kind, fault.exit.vector], [4, 0]);
    assert.equal(fault.exit.eip, CODE + 7, 'the fault names the div');
    assert.equal(fault.m.reg('eax'), 1, 'and the state is as before it');
    assert.equal(fault.modelFault?.vector, 0);
});

test('the stack: push, pop, call, ret, enter, leave, pushad/popad, pushf/popf', ()=>{
    const r = both([
        0xb8, 0x11, 0x22, 0x33, 0x44, 0x50,             // push eax
        0x66, 0x68, 0x34, 0x12,                         // push word 0x1234
        0x6a, 0xfe,                                     // push -2
        0x5b,                                           // pop ebx  (-2)
        0x66, 0x59,                                     // pop cx   (0x1234)
        0x8f, 0x05, 0x00, 0x30, 0, 0,                   // pop dword [0x3000]
        0xe8, 0x02, 0, 0, 0,                            // call +2 -> over the two bytes below
        0xf4, 0x90,                                     // (hlt is skipped by the call) nop
        0xc8, 0x08, 0x00, 0x00, 0xc9,                   // enter 8,0; leave
        0x60, 0x31, 0xc0, 0x61,                         // pushad; xor eax,eax; popad
        0xf9, 0x9c, 0x5a,                               // stc; pushf; pop edx
        0x68, 0x46, 0x02, 0, 0, 0x9d,                   // push 0x246; popf
        0xc3,                                           // ret -> to the hlt
    ]);
    assert.equal(r.exit.kind, 3);
    agree(r);
    assert.equal(r.m.reg('ebx'), 0xfffffffe);
    assert.equal(r.m.reg('ecx') & 0xffff, 0x1234);
    assert.equal(r.m.readU32(0x3000), 0x44332211);
    assert.equal(r.m.reg('edx') & CF, CF, 'pushf carried CF');
    assert.equal(r.m.eflags() & (ZF | PF), ZF | PF, 'popf set ZF and PF');
    assert.equal(r.m.reg('esp'), STACK);
});

test('conditional moves and sets, bit tests, scans, bswap, cmpxchg, cwde/cdq', ()=>{
    const r = both([
        0xb8, 1, 0, 0, 0, 0xbb, 2, 0, 0, 0, 0x39, 0xd8, 0x0f, 0x4c, 0xc3, // cmovl eax, ebx
        0x0f, 0x9f, 0xc1,                                     // setg cl (false)
        0xb8, 0x08, 0, 0, 0, 0x0f, 0xba, 0xe0, 0x03,          // bt eax, 3
        0x0f, 0x92, 0xc2,                                     // setb dl
        0x0f, 0xba, 0xf0, 0x03, 0x0f, 0xba, 0xe8, 0x00,       // btr eax,3; bts eax,0
        0x0f, 0xa3, 0xd8,                                     // bt eax, ebx (ebx=2: bit 2)
        0xb8, 0x00, 0x01, 0, 0, 0x0f, 0xbc, 0xc8, 0x0f, 0xbd, 0xd0, // bsf ecx,eax; bsr edx,eax
        0x31, 0xc0, 0x0f, 0xbc, 0xc8,                         // bsf of zero: ecx kept, ZF
        0x0f, 0x94, 0xc3,                                     // sete bl
        0xb8, 0x78, 0x56, 0x34, 0x12, 0x0f, 0xc8,             // bswap eax
        0xb8, 5, 0, 0, 0, 0xb9, 5, 0, 0, 0, 0xba, 9, 0, 0, 0, 0x0f, 0xb1, 0xd1, // cmpxchg ecx, edx
        0xb8, 0x80, 0xff, 0xff, 0xff, 0x98, 0x99,             // cwde; cdq
        0xf4,
    ]);
    assert.equal(r.exit.kind, 3);
    agree(r);
});

test('the string instructions with rep, repne and the direction flag', ()=>{
    const source = Array.from({ length: 16 }, (_, i)=>i + 1);
    const r = both([
        0xbe, 0x00, 0x20, 0, 0, 0xbf, 0x00, 0x30, 0, 0, 0xb9, 4, 0, 0, 0, 0xf3, 0xa5, // rep movsd
        0xb8, 0x41, 0, 0, 0, 0xb9, 8, 0, 0, 0, 0xbf, 0x00, 0x40, 0, 0, 0xf3, 0xaa,    // rep stosb
        0xbf, 0x00, 0x40, 0, 0, 0xb9, 16, 0, 0, 0, 0xb0, 0x00, 0xf2, 0xae,            // repne scasb
        0xbe, 0x00, 0x20, 0, 0, 0xbf, 0x00, 0x30, 0, 0, 0xb9, 16, 0, 0, 0, 0xf3, 0xa6, // repe cmpsb
        // std; mov edi, 0x5003; mov al, 7; mov ecx, 4; rep stosb; cld
        0xfd, 0xbf, 0x03, 0x50, 0, 0, 0xb0, 0x07, 0xb9, 4, 0, 0, 0, 0xf3, 0xaa, 0xfc,
        0xac, 0xaa, // lodsb; stosb
        0xf4,
    ], { memory: [[0x2000, source]] });
    assert.equal(r.exit.kind, 3);
    agree(r);
    assert.deepEqual([...r.m.read(0x3000, 16)], source);
    assert.deepEqual([...r.m.read(0x4000, 9)], [65, 65, 65, 65, 65, 65, 65, 65, 0]);
    assert.deepEqual([...r.m.read(0x5000, 4)], [7, 7, 7, 7]);
});

test('fs-relative reads add the thread base, and 16-bit lea wraps', ()=>{
    const m = createTestMachine();
    m.write(CODE, [
        0x64, 0x8b, 0x0d, 0x18, 0, 0, 0,   // mov ecx, fs:[0x18]
        0x67, 0x8d, 0x06, 0x34, 0x12,       // lea eax, [0x1234] (16-bit addressing)
        0xf4,
    ]);
    m.setFsBase(0x7000);
    m.writeU32(0x7018, 0xdeadbeef);
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, 3);
    assert.equal(m.reg('ecx'), 0xdeadbeef);
    assert.equal(m.reg('eax'), 0x1234);
});

test('an instruction the emitter leaves out ends the run at its address, state intact', ()=>{
    const m = createTestMachine();
    m.write(CODE, [0xb8, 7, 0, 0, 0, 0x0f, 0xa2, 0xf4]); // mov eax, 7; cpuid; hlt
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, -2, 'left out');
    assert.equal(exit.eip, CODE + 5);
    assert.equal(m.reg('eax'), 7);
    assert.deepEqual([...exit.unsupported.keys()], ['0f a2'], 'named by its opcode');
    assert.equal(m.counter(), 1);
});

test('int3 and int n leave with the vector and the instruction\'s own address', ()=>{
    const m = createTestMachine();
    m.write(CODE, [0x90, 0xcd, 0x21]);
    const exit = m.runProgram(CODE);
    assert.deepEqual([exit.kind, exit.vector, exit.eip], [4, 0x21, CODE + 1]);
    assert.equal(m.counter(), 1);
});

test('a conditional jump reading flags set in another block goes through the word', ()=>{
    // 1000: cmp eax, 5
    // 1003: jmp 1005      (the jcc is in a block of its own)
    // 1005: jl 100a
    // 1007: mov ebx, 1
    // 100a: hlt           <- (mov ebx,1 falls into it)
    const r = both([0x83, 0xf8, 0x05, 0xeb, 0x00, 0x7c, 0x03, 0xbb, 1, 0, 0, 0, 0xf4],
        { regs: { eax: 3 } });
    assert.equal(r.exit.kind, 3);
    assert.equal(r.m.reg('ebx'), 0, 'the jump was taken');
    agree(r);
    const not = both([0x83, 0xf8, 0x05, 0xeb, 0x00, 0x7c, 0x03, 0xbb, 1, 0, 0, 0, 0xf4],
        { regs: { eax: 9 } });
    assert.equal(not.m.reg('ebx'), 1);
    agree(not);
});

test('undefined flags aside, every register width write merges into its dword', ()=>{
    const r = both([
        0xb8, 0x78, 0x56, 0x34, 0x12, // mov eax, 0x12345678
        0xb4, 0xaa,                   // mov ah, 0xaa
        0xb0, 0xbb,                   // mov al, 0xbb
        0x66, 0xbb, 0xcc, 0xdd,       // mov bx, 0xddcc
        0x88, 0xe1,                   // mov cl, ah
        0x0f, 0xb6, 0xd4,             // movzx edx, ah
        0x0f, 0xbe, 0xf0,             // movsx esi, al
        0x86, 0xc4,                   // xchg al, ah
        0xf4,
    ]);
    agree(r);
    assert.equal(r.m.reg('eax'), 0x1234bbaa);
    assert.equal(r.m.reg('ebx'), 0xddcc);
    assert.equal(r.m.reg('esi'), 0xffffffbb);
});

export { SF, OF };

test('inc after a byte add keeps the carry the add left, folded before op1 is reused', ()=>{
    const r = both([
        0xb0, 0xf0,                               // mov al, 0xf0
        0x00, 0xc0,                               // add al, al       CF=1 (0x1e0)
        0x41,                                     // inc ecx          CF stays 1
        0xb0, 0x10,                               // mov al, 0x10
        0x00, 0xc0,                               // add al, al       CF=0
        0x49,                                     // dec ecx          CF stays 0
        0x48,                                     // dec eax
        0xf4,
    ], { regs: { ecx: 7 } });
    assert.equal(r.exit.kind, 3);
    assert.equal(r.m.reg('ecx'), 7);
    assert.equal(r.m.eflags() & CF, 0);
    agree(r);
    const carried = both([0xb0, 0xf0, 0x00, 0xc0, 0x41, 0xf4]);
    assert.equal(carried.m.eflags() & CF, CF, 'inc kept the carry of add al, al');
    agree(carried);
});

test('pusha stores the esp it started with, and the 66 forms move words', ()=>{
    const r = both([
        0xb8, 0x11, 0, 0, 0,                      // mov eax, 0x11
        0xbb, 0x33, 0, 0, 0,                      // mov ebx, 0x33
        0x60,                                     // pusha
        0x8b, 0x4c, 0x24, 0x0c,                   // mov ecx, [esp+12]   the pushed esp
        0x89, 0x0d, 0x00, 0x20, 0, 0,             // mov [0x2000], ecx   (popa restores ecx)
        0x61,                                     // popa
        0x66, 0x60,                               // pushaw
        0x66, 0x8b, 0x54, 0x24, 0x0e,             // mov dx, [esp+14]    the pushed ax
        0x89, 0x15, 0x04, 0x20, 0, 0,             // mov [0x2004], edx
        0x66, 0x61,                               // popaw
        0xf4,
    ]);
    assert.equal(r.exit.kind, 3);
    assert.equal(r.m.readU32(0x2000), STACK, 'the esp value before the pusha');
    assert.equal(r.m.readU32(0x2004), 0x11);
    assert.equal(r.m.reg('esp'), STACK);
    assert.equal(r.m.reg('ebx'), 0x33);
    assert.equal(r.m.reg('ecx'), 0, 'popa restored ecx');
    agree(r);
});

test('salc, and enter in both operand sizes', ()=>{
    const r = both([
        0xf9,                                     // stc
        0xd6,                                     // salc            al = 0xff
        0x88, 0xc4,                               // mov ah, al
        0xf8,                                     // clc
        0xd6,                                     // salc            al = 0
        0xbd, 0x78, 0x56, 0x34, 0x12,             // mov ebp, 0x12345678
        0xc8, 0x08, 0x00, 0x00,                   // enter 8, 0
        0x8b, 0x4d, 0x00,                         // mov ecx, [ebp]   the pushed ebp
        0x89, 0xea,                               // mov edx, ebp
        0xc9,                                     // leave
        0x66, 0xc8, 0x04, 0x00, 0x00,             // enter 4, 0 (16-bit)
        0x89, 0xeb,                               // mov ebx, ebp
        0xf4,
    ]);
    assert.equal(r.exit.kind, 3);
    assert.equal(r.m.reg('eax') & 0xffff, 0xff00);
    assert.equal(r.m.reg('ecx'), 0x12345678);
    assert.equal(r.m.reg('edx'), STACK - 4);
    assert.equal(r.m.reg('ebx'), 0x12340000 | (STACK - 2) & 0xffff, 'only bp written');
    assert.equal(r.m.reg('esp'), STACK - 2 - 4);
    agree(r);
});
