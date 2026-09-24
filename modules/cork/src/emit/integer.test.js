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

test('popf changes the ID and AC bits, so the CPUID probe finds CPUID', ()=>{
    // pushfd; pop eax; mov ecx, eax; xor eax, 0x240000; push eax; popfd;
    // pushfd; pop eax; hlt -- a program's test for CPUID (ID, bit 21) and a
    // 486 (AC, bit 18): a bit that does not change is no CPUID, and a title
    // that sees none falls back to its generic code (Doom 3's x87 SIMD).
    const r = both([
        0x9c, 0x58, 0x89, 0xc1, 0x35, 0x00, 0x00, 0x24, 0x00, 0x50, 0x9d,
        0x9c, 0x58, 0xf4,
    ]);
    assert.equal(r.exit.kind, 3);
    agree(r);
    assert.equal((r.m.reg('eax') ^ r.m.reg('ecx')) >>> 0, 0x240000, 'translated');
    assert.equal((r.state.reg[0] ^ r.state.reg[1]) >>> 0, 0x240000, 'the model');
});

test('ret imm16 pops the return and adds the immediate, model and emitter agreeing', ()=>{
    const r = both([
        0x6a, 0x00,                                     // push 0
        0x6a, 0x00,                                     // push 0
        0xe8, 0x03, 0x00, 0x00, 0x00,                   // call 0x100c
        0xf4,                                           // hlt, the return's landing
        0x90, 0x90,                                     // padding to the callee
        0xc2, 0x08, 0x00,                               // ret 8
    ]);
    assert.equal(r.exit.kind, 3);
    agree(r);
    assert.equal(r.m.reg('esp'), STACK, 'the immediate left with the two dwords');
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

test('a zero-count rep touches nothing and keeps the flags', ()=>{
    // The count is tested before the first iteration, so ecx = 0 runs the
    // body not once: no store, no pointer move, and the flags the instruction
    // before it set are the ones that survive.
    const r = both([
        0xb8, 0x41, 0, 0, 0,    // mov eax, 'A'
        0xbf, 0x00, 0x40, 0, 0, // mov edi, 0x4000
        0x31, 0xc9,             // xor ecx, ecx   (ZF = 1)
        0xf3, 0xaa,             // rep stosb, ecx = 0
        0xf4,
    ]);
    assert.equal(r.exit.kind, 3);
    agree(r);
    assert.deepEqual([...r.m.read(0x4000, 1)], [0], 'nothing written');
    assert.equal(r.m.reg('edi'), 0x4000, 'the pointer did not move');
    assert.equal(r.m.eflags() >>> 6 & 1, 1, 'ZF from the xor survives the rep');
});

test('rep stops on a compare and leaves the count and pointers at the stop', ()=>{
    // repe cmpsb over three equal bytes then a difference: the count is what
    // is left, and both pointers stand one past the mismatching pair.
    const r = both([
        0xbe, 0x00, 0x20, 0, 0, // mov esi, 0x2000
        0xbf, 0x00, 0x30, 0, 0, // mov edi, 0x3000
        0xb9, 3, 0, 0, 0,       // mov ecx, 3
        0xf3, 0xa6,             // repe cmpsb
        0xf4,
    ], { memory: [
        [0x2000, [1, 2, 4]],
        [0x3000, [1, 2, 3]],
    ] });
    assert.equal(r.exit.kind, 3);
    agree(r);
    assert.equal(r.m.reg('ecx'), 0, 'the count ran out on the mismatching pair');
    assert.equal(r.m.reg('esi'), 0x2003);
    assert.equal(r.m.reg('edi'), 0x3003);
    assert.equal(r.m.eflags() >>> 6 & 1, 0, 'ZF is clear: the bytes differ');
});

test('the direction flag runs a rep backwards, and the first iteration always runs', ()=>{
    // std; rep movsb with the pointers at the top of their runs. The first
    // iteration runs -- there is no count test before it for a nonzero count
    // -- and each step then moves backwards, leaving both pointers one below
    // the run's start.
    const r = both([
        0xbe, 0x02, 0x20, 0, 0, // mov esi, 0x2002
        0xbf, 0x02, 0x30, 0, 0, // mov edi, 0x3002
        0xb9, 3, 0, 0, 0,       // mov ecx, 3
        0xfd,                   // std
        0xf3, 0xa4,             // rep movsb
        0xf4,
    ], { memory: [[0x2000, [1, 2, 3]], [0x3000, [0, 0, 0]]] });
    assert.equal(r.exit.kind, 3);
    agree(r);
    assert.deepEqual([...r.m.read(0x3000, 3)], [1, 2, 3], 'copied backwards in place');
    assert.equal(r.m.reg('esi'), 0x2000 - 1, 'one below the source run');
    assert.equal(r.m.reg('edi'), 0x3000 - 1, 'one below the destination run');
    assert.equal(r.m.reg('ecx'), 0, 'the count ran out');

    // A count of one still runs the body once and moves one pointer step.
    const one = both([
        0xb8, 0x41, 0, 0, 0,    // mov eax, 'A'
        0xbf, 0x00, 0x40, 0, 0, // mov edi, 0x4000
        0xb9, 1, 0, 0, 0,       // mov ecx, 1
        0xf3, 0xaa,             // rep stosb
        0xf4,
    ]);
    assert.equal(one.exit.kind, 3);
    agree(one);
    assert.deepEqual([...one.m.read(0x4000, 1)], [0x41]);
    assert.equal(one.m.reg('edi'), 0x4001);
    assert.equal(one.m.reg('ecx'), 0);
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
    m.write(CODE, [0xb8, 7, 0, 0, 0, 0xec, 0xf4]); // mov eax, 7; in al, dx; hlt
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, -2, 'left out');
    assert.equal(exit.eip, CODE + 5);
    assert.equal(m.reg('eax'), 7);
    assert.deepEqual([...exit.unsupported.keys()], ['ec'], 'named by its opcode');
    assert.equal(m.counter(), 1);
});

test('rdtsc reads the host\'s counter into edx:eax', ()=>{
    const m = createTestMachine({ rdtsc: ()=>0x123456789abcdef0n });
    m.write(CODE, [0x0f, 0x31, 0xf4]); // rdtsc; hlt
    assert.equal(m.runProgram(CODE).kind, 3);
    assert.equal(m.reg('eax'), 0x9abcdef0);
    assert.equal(m.reg('edx'), 0x12345678);
});

test('cpuid answers the pinned emulator\'s leaves and zero for the rest', ()=>{
    const one = createTestMachine();
    one.write(CODE, [0xb8, 1, 0, 0, 0, 0x0f, 0xa2, 0xf4]); // mov eax, 1; cpuid; hlt
    assert.equal(one.runProgram(CODE).kind, 3);
    assert.equal(one.reg('eax'), 0x00000673);
    assert.equal(one.reg('ebx'), 0x00010800);
    assert.equal(one.reg('ecx'), 0xc0800001);
    assert.equal(one.reg('edx'), 0x0780a979);
    const vendor = createTestMachine();
    vendor.write(CODE, [0x31, 0xc0, 0x0f, 0xa2, 0xf4]); // xor eax, eax; cpuid; hlt
    assert.equal(vendor.runProgram(CODE).kind, 3);
    assert.equal(vendor.reg('ebx'), 0x756e6547);
    assert.equal(vendor.reg('ecx'), 0x6c65746e);
    assert.equal(vendor.reg('edx'), 0x49656e69);
    const unknown = createTestMachine();
    unknown.write(CODE, [0xb8, 0x21, 0, 0, 0, 0x0f, 0xa2, 0xf4]); // leaf 0x21
    assert.equal(unknown.runProgram(CODE).kind, 3);
    assert.equal(unknown.reg('eax'), 0);
    assert.equal(unknown.reg('ebx'), 0);
    assert.equal(unknown.reg('ecx'), 0);
    assert.equal(unknown.reg('edx'), 0);
});

test('int3 and int n are left to the other executor, before the instruction', ()=>{
    const m = createTestMachine();
    m.write(CODE, [0x90, 0xcd, 0x21]);
    const exit = m.runProgram(CODE);
    assert.deepEqual([exit.kind, exit.vector, exit.eip], [-2, 0, CODE + 1]);
    assert.equal(m.counter(), 1, 'the nop alone');
});

test('bound is the no-op the emulator makes it, even out of range', ()=>{
    // mov eax, -1; mov ebx, bounds; bound eax, [ebx]; inc eax; hlt. A real
    // processor raises #BR for -1 outside the {0, 0} pair; the emulator does
    // not, so translated code must not either -- the run reaches the `inc`.
    const r = both(
        [0xb8, 0xff, 0xff, 0xff, 0xff, 0xbb, 0x00, 0x20, 0x00, 0x00,
            0x62, 0x03, 0x40, 0xf4],
        { memory: [[0x2000, [0, 0, 0, 0, 0, 0, 0, 0]]] });
    assert.equal(r.exit.kind, 3, 'the run halted rather than stopping at 0x62');
    assert.equal(r.exit.eip, CODE + 14);
    assert.equal(r.m.reg('eax') >>> 0, 0, 'the instruction changed nothing');
    assert.equal(r.exit.unsupported.size, 0, 'bound was translated, not left out');
    agree(r);
    // The register form (`bound eax, ebx`) is refused by the decoder's
    // memory-only rule on paper but consumed by the emulator's decoder; a
    // return into the entry vector's bytes reaches exactly this form, so it
    // must translate as the same no-op.
    const reg = both([0x62, 0xc3, 0x40, 0xf4]); // bound eax, ebx; inc eax; hlt
    assert.equal(reg.exit.kind, 3, 'the register form halts too');
    assert.equal(reg.exit.eip, CODE + 4);
    assert.equal(reg.m.reg('eax'), 1, 'the inc after it ran');
    assert.equal(reg.exit.unsupported.size, 0);
    agree(reg);
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

test('rotates at every width, by an immediate and by cl, counts past the width included', ()=>{
    /** @param {number[]} bytes @param {Record<string, number>} regs */
    const check = (bytes, regs)=>{
        const r = both([...bytes, 0xf4], { regs, eflags: 2 | CF });
        assert.equal(r.exit.kind, 3);
        agree(r);
        return r;
    };
    const regs = { eax: 0x8000_0001, ecx: 0x12, ebx: 0x9c };
    check([0xc1, 0xc0, 0x01], regs);                     // rol eax, 1
    check([0xc1, 0xc8, 0x1f], regs);                     // ror eax, 31
    check([0xc1, 0xc0, 0x20], regs);                     // rol eax, 32   count 0: nothing
    check([0x66, 0xc1, 0xc0, 0x10], regs);               // rol ax, 16    the width: flags only
    check([0x66, 0xc1, 0xc8, 0x11], regs);               // ror ax, 17
    check([0xd0, 0xc3], regs);                           // rol bl, 1
    check([0xc0, 0xcb, 0x09], regs);                     // ror bl, 9
    check([0xc0, 0xc3, 0x18], regs);                     // rol bl, 24
    check([0xd3, 0xc0], regs);                           // rol eax, cl (18)
    check([0x66, 0xd3, 0xcb], regs);                     // ror bx, cl
    check([0xd2, 0xc7], { ...regs, ecx: 8 });            // rol bh, cl (8)
    check([0xd2, 0xc7], { ...regs, ecx: 0 });            // rol bh, cl (0): nothing
    check([0xd1, 0x0d, 0x00, 0x20, 0, 0], regs);         // ror dword [0x2000], 1
    const r = check([0xc0, 0xc3, 0x03], { ebx: 0x81 });  // rol bl, 3: 0x0c, CF 0, OF 0
    assert.equal(r.m.reg('ebx'), 0x0c);
    assert.equal(r.m.eflags() & CF, 0);
});

test('rcl and rcr rotate through the carry at every width', ()=>{
    /** @param {number[]} bytes @param {Record<string, number>} regs @param {number} eflags */
    const check = (bytes, regs, eflags)=>{
        const r = both([...bytes, 0xf4], { regs, eflags });
        assert.equal(r.exit.kind, 3);
        agree(r);
        return r;
    };
    const regs = { eax: 0x8000_0001, ecx: 0x09, ebx: 0x9c };
    for (const eflags of [2, 2 | CF])
    {
        check([0xd1, 0xd0], regs, eflags);                     // rcl eax, 1
        check([0xd1, 0xd8], regs, eflags);                     // rcr eax, 1
        check([0xc1, 0xd0, 0x1f], regs, eflags);               // rcl eax, 31
        check([0xc1, 0xd8, 0x11], regs, eflags);               // rcr eax, 17
        check([0x66, 0xc1, 0xd0, 0x11], regs, eflags);         // rcl ax, 17   (count 0 mod 17)
        check([0x66, 0xc1, 0xd8, 0x05], regs, eflags);         // rcr ax, 5
        check([0xc0, 0xd3, 0x09], regs, eflags);               // rcl bl, 9    (count 0 mod 9)
        check([0xc0, 0xdb, 0x04], regs, eflags);               // rcr bl, 4
        check([0xd3, 0xd3], regs, eflags);                     // rcl ebx, cl (9)
        check([0xd2, 0xdf], regs, eflags);                     // rcr bh, cl (9)
        check([0xd2, 0xd3], { ...regs, ecx: 0 }, eflags);      // rcl bl, cl (0): nothing
    }
    const r = check([0xd0, 0xd3], { ebx: 0x80 }, 2 | CF);      // rcl bl, 1: 0x01, CF 1, OF 1
    assert.equal(r.m.reg('ebx'), 0x01);
    assert.equal(r.m.eflags() & (CF | OF), CF | OF);
    const q = check([0xd0, 0xdb], { ebx: 0x01 }, 2 | CF);      // rcr bl, 1: 0x80, CF 1, OF 1
    assert.equal(q.m.reg('ebx'), 0x80);
    assert.equal(q.m.eflags() & (CF | OF), CF | OF);
});

test('shld and shrd on dwords and words, with counts past the word width', ()=>{
    /** @param {number[]} bytes @param {Record<string, number>} regs */
    const check = (bytes, regs)=>{
        const r = both([...bytes, 0xf4], { regs });
        assert.equal(r.exit.kind, 3);
        agree(r);
        return r;
    };
    const regs = { eax: 0x8000_0001, ebx: 0xdead_beef, ecx: 0x11 };
    check([0x0f, 0xa4, 0xd8, 0x01], regs);               // shld eax, ebx, 1
    check([0x0f, 0xac, 0xd8, 0x1f], regs);               // shrd eax, ebx, 31
    check([0x0f, 0xa5, 0xd8], regs);                     // shld eax, ebx, cl (17)
    check([0x0f, 0xad, 0xd8], { ...regs, ecx: 0 });      // shrd eax, ebx, cl (0): nothing
    check([0x66, 0x0f, 0xa4, 0xd8, 0x04], regs);         // shld ax, bx, 4
    check([0x66, 0x0f, 0xa4, 0xd8, 0x10], regs);         // shld ax, bx, 16
    check([0x66, 0x0f, 0xa4, 0xd8, 0x14], regs);         // shld ax, bx, 20
    check([0x66, 0x0f, 0xac, 0xd8, 0x10], regs);         // shrd ax, bx, 16
    check([0x66, 0x0f, 0xad, 0xd8], regs);               // shrd ax, bx, cl (17)
    check([0x66, 0x0f, 0xa5, 0xd8], { ...regs, ecx: 3 }); // shld ax, bx, cl (3)
    check([0x0f, 0xa4, 0x1d, 0x00, 0x20, 0, 0, 0x08], regs); // shld [0x2000], ebx, 8
    const r = check([0x0f, 0xa4, 0xd8, 0x04], { eax: 0x1234_5678, ebx: 0xabcd_0000 });
    assert.equal(r.m.reg('eax'), 0x2345_678a);
    assert.equal(r.m.eflags() & CF, CF, 'the last bit out of eax');
});

test('mul, imul, div and idiv at byte and word width, faults included', ()=>{
    /** @param {number[]} bytes @param {Record<string, number>} regs */
    const check = (bytes, regs)=>{
        const r = both([...bytes, 0xf4], { regs });
        agree(r);
        return r;
    };
    let r = check([0xf6, 0xe3], { eax: 0x12ff, ebx: 0x80 });            // mul bl: 0xff * 0x80
    assert.equal(r.m.reg('eax'), 0x7f80);
    assert.equal(r.m.eflags() & CF, CF);
    r = check([0xf6, 0xeb], { eax: 0x12ff, ebx: 0x80 });                // imul bl: -1 * -128
    assert.equal(r.m.reg('eax'), 0x0080);
    assert.equal(r.m.eflags() & CF, CF, '128 does not fit a signed byte');
    check([0xf6, 0xeb], { eax: 0x12f0, ebx: 0x7f });                    // imul bl: -16 * 127
    r = check([0x66, 0xf7, 0xe3], { eax: 0xffff, ebx: 0x1_0002, edx: 7 }); // mul bx
    assert.equal(r.m.reg('eax'), 0xfffe);
    assert.equal(r.m.reg('edx'), 0x0001);
    check([0x66, 0xf7, 0xeb], { eax: 0x8000, ebx: 0x8000, edx: 7 });    // imul bx: -32768²
    check([0x66, 0xf7, 0xeb], { eax: 0x0002, ebx: 0x0003, edx: 7 });    // imul bx: fits
    r = check([0xf6, 0xf3], { eax: 0x0123, ebx: 0x10 });                // div bl: 0x123 / 16
    assert.equal(r.m.reg('eax') & 0xffff, 0x0312);
    r = check([0xf6, 0xfb], { eax: 0xff85, ebx: 0x03 });                // idiv bl: -123 / 3
    assert.equal(r.m.reg('eax') & 0xffff, 0x00d7, '-41, remainder 0');
    r = check([0x66, 0xf7, 0xf3], { eax: 0x5678, edx: 0x0001, ebx: 0x10 }); // div bx
    assert.equal(r.m.reg('eax') & 0xffff, 0x1567);
    assert.equal(r.m.reg('edx') & 0xffff, 0x0008);
    check([0x66, 0xf7, 0xfb], { eax: 0x0000, edx: 0xffff, ebx: 0x0007 }); // idiv bx: -65536 / 7
    // Faults: a byte quotient past 0xff, a word quotient past a signed word,
    // the division by zero, and INT32_MIN / -1.
    /** @type {[number[], Record<string, number>][]} */
    const faulting = [
        [[0xf6, 0xf3], { eax: 0x1000, ebx: 0x01 }],
        [[0x66, 0xf7, 0xfb], { eax: 0x0000, edx: 0x0001, ebx: 0x0001 }],
        [[0xf6, 0xf3], { eax: 0x1000, ebx: 0x00 }],
        [[0x66, 0xf7, 0xfb], { eax: 0x0000, edx: 0x8000, ebx: 0xffff }],
    ];
    for (const [bytes, regs] of faulting)
    {
        const f = both([...bytes, 0xf4], { regs });
        assert.equal(f.exit.kind, 4, 'a fault');
        assert.equal(f.exit.vector, 0);
        assert.equal(f.exit.eip, CODE, 'at the instruction');
        assert.ok(f.modelFault !== null, 'the model faults too');
    }
});

test('popcnt counts the bits and clears every flag but ZF', ()=>{
    const r = both([0xf3, 0x0f, 0xb8, 0xc3, 0x66, 0xf3, 0x0f, 0xb8, 0xd3, 0xf4],
        { regs: { ebx: 0xf0f0_00ff }, eflags: 2 | CF | OF | SF });
    assert.equal(r.exit.kind, 3);
    assert.equal(r.m.reg('eax'), 16);
    assert.equal(r.m.reg('edx') & 0xffff, 8);
    assert.equal(r.m.eflags() & 0x8d5, 0);
    agree(r);
    const zero = both([0xf3, 0x0f, 0xb8, 0xc3, 0xf4], { regs: { ebx: 0 } });
    assert.equal(zero.m.eflags() & 0x8d5, ZF);
    agree(zero);
});

test('a shift by a zero cl leaves an earlier lazy record intact for a later reader', ()=>{
    // add records; the shift with cl = 0 changes nothing, but its lowering
    // must not touch the record's operands, which the setc and the epilogue
    // fold afterwards.
    const r = both([
        0xb8, 0xff, 0xff, 0xff, 0xff,             // mov eax, -1
        0xbb, 0x01, 0, 0, 0,                      // mov ebx, 1
        0xb9, 0x00, 0x01, 0, 0,                   // mov ecx, 0x100     cl = 0
        0x01, 0xd8,                               // add eax, ebx       CF=1 ZF=1
        0xd3, 0xe1,                               // shl ecx, cl        nothing
        0x0f, 0x92, 0xc2,                         // setc dl
        0x0f, 0xa5, 0xd9,                         // shld ecx, ebx, cl  nothing
        0x0f, 0x94, 0xc6,                         // sete dh
        0xf4,
    ]);
    assert.equal(r.exit.kind, 3);
    assert.equal(r.m.reg('edx') & 0xffff, 0x0101);
    assert.equal(r.m.eflags() & (CF | ZF), CF | ZF);
    agree(r);
    // The same with a nonzero cl: the shift's own flags.
    const s = both([
        0xb8, 0xff, 0xff, 0xff, 0xff, 0xbb, 0x01, 0, 0, 0, 0xb9, 0x01, 0x01, 0, 0,
        0x01, 0xd8, 0xd3, 0xe1, 0x0f, 0x92, 0xc2, 0x0f, 0xa5, 0xd9, 0x0f, 0x94, 0xc6, 0xf4,
    ]);
    assert.equal(s.m.reg('edx') & 0xffff, 0x0000);
    agree(s);
});

test('a shift that may write no flags does not kill an earlier record for the dead-flag pass', ()=>{
    // and clears CF; the shifts by zero leave it; setae reads it; xor then
    // kills every flag. The pass must still keep the and's record live.
    const r = both([
        0xb8, 0x03, 0, 0, 0,                      // mov eax, 3
        0xb9, 0x00, 0x01, 0, 0,                   // mov ecx, 0x100     cl = 0
        0x83, 0xe0, 0x01,                         // and eax, 1         CF=0
        0xc0, 0xe8, 0x00,                         // shr al, 0          nothing
        0x0f, 0x93, 0xc3,                         // setae bl           1
        0xd2, 0xe8,                               // shr al, cl         nothing (cl = 0)
        0x0f, 0x93, 0xc7,                         // setae bh           1
        0x31, 0xd2,                               // xor edx, edx       kills the flags
        0xf4,
    ], { eflags: 2 | CF });
    assert.equal(r.exit.kind, 3);
    assert.equal(r.m.reg('ebx') & 0xffff, 0x0101);
    agree(r);
});

test('inc with dead flags keeps a pending record whole for the carry a later reader folds', ()=>{
    // add records CF=1; dec's own flags are dead (sbb overwrites them) but
    // the add's CF is read by sbb through the dec: the record's operands
    // must survive the dec.
    const r = both([
        0xb8, 0xff, 0xff, 0xff, 0xff,             // mov eax, -1
        0xbb, 0x02, 0, 0, 0,                      // mov ebx, 2
        0xb9, 0x10, 0, 0, 0,                      // mov ecx, 0x10
        0x01, 0xd8,                               // add eax, ebx       CF=1
        0x49,                                     // dec ecx            CF stays
        0x0f, 0x93, 0xc2,                         // setae dl           0
        0x83, 0xdb, 0x00,                         // sbb ebx, 0         2 - 1
        0xf4,
    ]);
    assert.equal(r.exit.kind, 3);
    assert.equal(r.m.reg('ebx'), 1);
    assert.equal(r.m.reg('edx') & 0xff, 0);
    agree(r);
});
