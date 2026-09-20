/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from './decode/decoder.js';
import { AF, CF, OF, PF, SF, ZF } from './decode/table.js';
import { Fault, addFlags, condition, createState, evaluate, logicFlags, subFlags } from './ir.js';

/** A little machine: 64 KiB of memory, the stack near the top. */
function machine(){
    const ram = new Uint8Array(0x10000);
    const view = new DataView(ram.buffer);
    const memory = {
        /** @param {number} address @param {number} size */
        read: (address, size)=>size === 1 ? ram[address]
            : size === 2 ? view.getUint16(address, true) : view.getUint32(address, true),
        /** @param {number} address @param {number} size @param {number} value */
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
    };
    const state = createState(memory, { eip: 0x1000, esp: 0xf000 });
    return { ram, view, state };
}

/**
 * Runs a byte sequence from 0x1000 until it runs off the end.
 *
 * @param {number[]} bytes @param {(state: import('./ir.js').EvalState) => void} [prepare]
 */
function run(bytes, prepare){
    const m = machine();
    m.ram.set(bytes, 0x1000);
    prepare?.(m.state);
    const end = 0x1000 + bytes.length;
    while (m.state.eip < end && !m.state.halted)
    {
        const decoded = decode(address=>m.ram[address], m.state.eip);
        if ('refused' in decoded)
        {
            throw new Error(`refused ${decoded.opcode}`);
        }
        evaluate(decoded, m.state);
    }
    return m;
}

/** The six arithmetic flags of a state as a readable object. @param {number} flags */
const arith = flags=>({
    CF: (flags & CF) !== 0, PF: (flags & PF) !== 0, AF: (flags & AF) !== 0,
    ZF: (flags & ZF) !== 0, SF: (flags & SF) !== 0, OF: (flags & OF) !== 0,
});

test('the flag algebra on the architecture\'s defining cases', ()=>{
    assert.deepEqual(addFlags(0x7fffffff, 1, 0, 4),
        { result: 0x80000000, flags: OF | SF | AF | PF });
    assert.deepEqual(arith(addFlags(0xff, 0x01, 0, 1).flags),
        { CF: true, PF: true, AF: true, ZF: true, SF: false, OF: false });
    assert.deepEqual(arith(addFlags(0xffffffff, 1, 0, 4).flags),
        { CF: true, PF: true, AF: true, ZF: true, SF: false, OF: false });
    assert.deepEqual(addFlags(5, 5, 1, 4), { result: 11, flags: 0 },
        '11 has three bits: odd parity');
    assert.deepEqual(arith(subFlags(0x80000000, 1, 0, 4).flags),
        { CF: false, PF: true, AF: true, ZF: false, SF: false, OF: true });
    assert.deepEqual(arith(subFlags(3, 3, 0, 4).flags),
        { CF: false, PF: true, AF: false, ZF: true, SF: false, OF: false });
    assert.deepEqual(arith(subFlags(0, 1, 0, 2).flags),
        { CF: true, PF: true, AF: true, ZF: false, SF: true, OF: false });
    assert.equal(subFlags(0, 1, 0, 2).result, 0xffff);
    assert.deepEqual(arith(logicFlags(0, 4)),
        { CF: false, PF: true, AF: false, ZF: true, SF: false, OF: false });
    assert.deepEqual(arith(logicFlags(0x80000001, 4)),
        { CF: false, PF: false, AF: false, ZF: false, SF: true, OF: false });
    assert.equal(logicFlags(0x7, 1) & PF, 0, 'three bits: odd parity');
    assert.equal(condition(4, ZF), true, 'je');
    assert.equal(condition(5, ZF), false, 'jne');
    assert.equal(condition(12, SF), true, 'jl: SF != OF');
    assert.equal(condition(12, SF | OF), false);
    assert.equal(condition(15, SF | OF), true, 'jg: ZF clear and SF == OF');
    assert.equal(condition(6, CF), true, 'jbe');
    assert.equal(condition(7, 0), true, 'ja');
});

test('arithmetic on registers, with the sizes and the carry chain', ()=>{
    const m = run([
        0xb8, 0xff, 0xff, 0xff, 0x7f, // mov eax, 0x7fffffff
        0xbb, 0x01, 0x00, 0x00, 0x00, // mov ebx, 1
        0x01, 0xd8,                   // add eax, ebx
    ]);
    assert.equal(m.state.reg[0], 0x80000000);
    assert.deepEqual(arith(m.state.eflags),
        { CF: false, PF: true, AF: true, ZF: false, SF: true, OF: true });

    const carry = run([
        0xb8, 0xff, 0xff, 0xff, 0xff, // mov eax, -1
        0x83, 0xc0, 0x01,             // add eax, 1   -> CF
        0xb9, 0x05, 0x00, 0x00, 0x00, // mov ecx, 5
        0x83, 0xd1, 0x00,             // adc ecx, 0   -> 6
        0x66, 0x83, 0xe9, 0x07,       // sub cx, 7    -> 0xffff, CF
        0x80, 0xdd, 0x00,             // sbb ch, 0    -> 0xfe
    ]);
    assert.equal(carry.state.reg[0], 0);
    assert.equal(carry.state.reg[1], 0xfeff);
});

test('logic, inc/dec keeping CF, neg, not, and the compares', ()=>{
    const m = run([
        0xb8, 0x0f, 0x00, 0x00, 0x00, // mov eax, 0xf
        0x83, 0xe0, 0x03,             // and eax, 3   -> 3
        0x35, 0xf0, 0x00, 0x00, 0x00, // xor eax, 0xf0 -> 0xf3
        0x0d, 0x00, 0x01, 0x00, 0x00, // or eax, 0x100 -> 0x1f3
        0xf9,                         // stc
        0x40,                         // inc eax      -> 0x1f4, CF kept
    ]);
    assert.equal(m.state.reg[0], 0x1f4);
    assert.equal(m.state.eflags & CF, CF);
    const neg = run([0xb8, 0x05, 0, 0, 0, 0xf7, 0xd8, 0xf7, 0xd0]); // mov eax,5; neg eax; not eax
    assert.equal(neg.state.reg[0], 4);
    // mov eax, 3; cmp eax, 5; setl cl
    const cmp = run([0xb8, 0x03, 0, 0, 0, 0x83, 0xf8, 0x05, 0x0f, 0x9c, 0xc1]);
    assert.equal(cmp.state.reg[1] & 0xff, 1);
    assert.equal(cmp.state.reg[0], 3, 'cmp leaves its operand alone');
    const tested = run([0xb8, 0x80, 0, 0, 0, 0xa9, 0x80, 0, 0, 0]); // test eax, 0x80
    assert.equal(tested.state.eflags & ZF, 0);
});

test('shifts and rotates by one and by count, with their flags', ()=>{
    /** @param {number[]} bytes @param {number} eax */
    const shifted = (bytes, eax)=>run([
        0xb8, eax & 0xff, eax >>> 8 & 0xff, eax >>> 16 & 0xff, eax >>> 24 & 0xff, ...bytes,
    ]);
    let m = shifted([0xd1, 0xe0], 0x40000001); // shl eax, 1
    assert.equal(m.state.reg[0], 0x80000002);
    assert.deepEqual([!!(m.state.eflags & CF), !!(m.state.eflags & OF)], [false, true]);
    m = shifted([0xc1, 0xe0, 0x1f], 1); // shl eax, 31
    assert.equal(m.state.reg[0], 0x80000000);
    m = shifted([0xd1, 0xe8], 0x80000000); // shr eax, 1
    assert.equal(m.state.reg[0], 0x40000000);
    assert.equal(m.state.eflags & OF, OF, 'shr by one: OF is the old sign');
    m = shifted([0xd1, 0xf8], 0xfffffff8); // sar eax, 1
    assert.equal(m.state.reg[0], 0xfffffffc);
    assert.equal(m.state.eflags & CF, 0);
    m = shifted([0xc1, 0xc0, 0x04], 0xf0000001); // rol eax, 4
    assert.equal(m.state.reg[0], 0x0000001f);
    assert.equal(m.state.eflags & CF, CF);
    m = shifted([0xc1, 0xc8, 0x08], 0x000000ff); // ror eax, 8
    assert.equal(m.state.reg[0], 0xff000000);
    m = shifted([0xf9, 0xd1, 0xd0], 0x80000000); // stc; rcl eax, 1
    assert.equal(m.state.reg[0], 1);
    assert.equal(m.state.eflags & CF, CF);
    m = shifted([0xf9, 0xd1, 0xd8], 1); // stc; rcr eax, 1
    assert.equal(m.state.reg[0], 0x80000000);
    assert.equal(m.state.eflags & CF, CF);
    m = shifted([0xc1, 0xe0, 0x20], 0x12345678); // shl eax, 32 -> count masked to 0: no change
    assert.equal(m.state.reg[0], 0x12345678);
    m = run([0xb0, 0x81, 0xc0, 0xc0, 0x09]); // mov al, 0x81; rol al, 9 -> rol by 1
    assert.equal(m.state.reg[0] & 0xff, 0x03);
});

test('multiplication and division in every width, and the divide fault', ()=>{
    // mov eax, 0x10000; mov ebx, 0x10000; mul ebx
    let m = run([0xb8, 0x00, 0x00, 0x01, 0x00, 0xbb, 0x00, 0x00, 0x01, 0x00, 0xf7, 0xe3]);
    assert.deepEqual([m.state.reg[0], m.state.reg[2]], [0, 1]);
    assert.equal(m.state.eflags & (CF | OF), CF | OF);
    m = run([0xb8, 0xfe, 0xff, 0xff, 0xff, 0x6b, 0xc0, 0x03]); // imul eax, eax, 3 -> -6
    assert.equal(m.state.reg[0], 0xfffffffa);
    assert.equal(m.state.eflags & (CF | OF), 0);
    m = run([0xb8, 0x00, 0x00, 0x00, 0x40, 0x6b, 0xc0, 0x04]); // imul 0x40000000 * 4 overflows
    assert.equal(m.state.eflags & (CF | OF), CF | OF);
    m = run([0xb0, 0x0a, 0xb3, 0x03, 0xf6, 0xeb]); // mov al,10; mov bl,3; imul bl -> ax = 30
    assert.equal(m.state.reg[0] & 0xffff, 30);
    m = run([0xb8, 0x07, 0, 0, 0, 0x31, 0xd2, 0xbb, 0x02, 0, 0, 0, 0xf7, 0xf3]); // 7 / 2
    assert.deepEqual([m.state.reg[0], m.state.reg[2]], [3, 1]);
    m = run([0xb8, 0xf9, 0xff, 0xff, 0xff, 0x99, 0xbb, 0x02, 0, 0, 0, 0xf7, 0xfb]); // -7 idiv 2
    assert.deepEqual([m.state.reg[0], m.state.reg[2]], [0xfffffffd, 0xffffffff]);
    assert.throws(()=>run([0x31, 0xdb, 0xf7, 0xf3]),
        (/** @type {any} */ e)=>e instanceof Fault && e.vector === 0);
    assert.throws(()=>run([0xb8, 0, 0, 0, 0x80, 0x99, 0xbb, 0xff, 0xff, 0xff, 0xff, 0xf7, 0xfb]),
        (/** @type {any} */ e)=>e instanceof Fault && e.vector === 0, 'INT_MIN / -1 overflows');
});

test('memory operands, the stack, calls and returns', ()=>{
    const m = run([
        0xc7, 0x05, 0x00, 0x20, 0x00, 0x00, 0x78, 0x56, 0x34, 0x12, // mov dword [0x2000], imm
        0x8b, 0x1d, 0x00, 0x20, 0x00, 0x00,                         // mov ebx, [0x2000]
        0x53,                                                       // push ebx
        0x58,                                                       // pop eax
        0x0f, 0xb6, 0x0d, 0x01, 0x20, 0x00, 0x00,                   // movzx ecx, byte [0x2001]
        0x0f, 0xbe, 0x15, 0x03, 0x20, 0x00, 0x00,                   // movsx edx, byte [0x2003]
        0x8d, 0x34, 0x4b,                                           // lea esi, [ebx+ecx*2]
        0xe8, 0x01, 0x00, 0x00, 0x00,                               // call +1
        0xf4,                                                       // hlt (skipped)
        0xc3,                                                       // ret -> to the hlt
    ]);
    assert.equal(m.state.reg[0], 0x12345678);
    assert.equal(m.state.reg[1], 0x56);
    assert.equal(m.state.reg[2], 0x12);
    assert.equal(m.state.reg[6], 0x12345678 + 0x56 * 2);
    assert.equal(m.state.reg[4], 0xf000, 'the stack is balanced after call and ret');
    assert.equal(m.state.halted, true);
});

test('the string instructions with rep, repne and the direction flag', ()=>{
    const m = run([
        0xbe, 0x00, 0x20, 0x00, 0x00, // mov esi, 0x2000
        0xbf, 0x00, 0x30, 0x00, 0x00, // mov edi, 0x3000
        0xb9, 0x04, 0x00, 0x00, 0x00, // mov ecx, 4
        0xf3, 0xa5,                   // rep movsd
        0xb8, 0x41, 0x00, 0x00, 0x00, // mov eax, 'A'
        0xb9, 0x08, 0x00, 0x00, 0x00, // mov ecx, 8
        0xbf, 0x00, 0x40, 0x00, 0x00, // mov edi, 0x4000
        0xf3, 0xaa,                   // rep stosb
        0xbf, 0x00, 0x40, 0x00, 0x00, // mov edi, 0x4000
        0xb9, 0x10, 0x00, 0x00, 0x00, // mov ecx, 16
        0xb0, 0x00,                   // mov al, 0
        0xf2, 0xae,                   // repne scasb -> finds the 0 after eight 'A's
    ], state=>{
        for (let i = 0; i < 16; i++)
        {
            state.memory.write(0x2000 + i, 1, i + 1);
        }
    });
    assert.deepEqual([...m.ram.subarray(0x3000, 0x3010)], [...m.ram.subarray(0x2000, 0x2010)]);
    assert.equal(m.state.reg[6], 0x2010);
    assert.deepEqual([...m.ram.subarray(0x4000, 0x4009)], [65, 65, 65, 65, 65, 65, 65, 65, 0]);
    assert.equal(m.state.reg[7], 0x4009, 'edi is one past the match');
    assert.equal(m.state.reg[1], 16 - 9);
    assert.equal(m.state.eflags & ZF, ZF);

    // std; mov edi, 0x2003; mov al, 7; mov ecx, 4; rep stosb; cld
    const backwards = run([
        0xfd, 0xbf, 0x03, 0x20, 0x00, 0x00, 0xb0, 0x07, 0xb9, 0x04, 0, 0, 0, 0xf3, 0xaa, 0xfc,
    ]);
    assert.deepEqual([...backwards.ram.subarray(0x2000, 0x2004)], [7, 7, 7, 7]);
    assert.equal(backwards.state.reg[7], 0x1fff);
});

test('bit tests, scans, bswap, xchg, xadd, cmpxchg, cwde/cdq, setcc, cmovcc, jcc', ()=>{
    // mov eax, 8; bt eax, 3; setb cl
    let m = run([0xb8, 0x08, 0, 0, 0, 0x0f, 0xba, 0xe0, 0x03, 0x0f, 0x92, 0xc1]);
    assert.equal(m.state.reg[1] & 0xff, 1);
    // mov eax, 8; btr eax, 3; bts eax, 0
    m = run([0xb8, 0x08, 0, 0, 0, 0x0f, 0xba, 0xf0, 0x03, 0x0f, 0xba, 0xe8, 0x00]);
    assert.equal(m.state.reg[0], 1);
    // mov eax, 0x100; bsf ecx, eax; bsr edx, eax
    m = run([0xb8, 0x00, 0x01, 0, 0, 0x0f, 0xbc, 0xc8, 0x0f, 0xbd, 0xd0]);
    assert.deepEqual([m.state.reg[1], m.state.reg[2]], [8, 8]);
    m = run([0x31, 0xc0, 0xb9, 0x07, 0, 0, 0, 0x0f, 0xbc, 0xc8]); // bsf of zero leaves ecx, sets ZF
    assert.equal(m.state.reg[1], 7);
    assert.equal(m.state.eflags & ZF, ZF);
    m = run([0xb8, 0x78, 0x56, 0x34, 0x12, 0x0f, 0xc8]); // bswap eax
    assert.equal(m.state.reg[0], 0x78563412);
    m = run([0xb8, 1, 0, 0, 0, 0xbb, 2, 0, 0, 0, 0x93]); // xchg eax, ebx
    assert.deepEqual([m.state.reg[0], m.state.reg[3]], [2, 1]);
    m = run([0xb8, 1, 0, 0, 0, 0xbb, 2, 0, 0, 0, 0x0f, 0xc1, 0xd8]); // xadd eax, ebx
    assert.deepEqual([m.state.reg[0], m.state.reg[3]], [3, 1]);
    // mov eax, 5; mov ecx, 5; mov edx, 9; cmpxchg ecx, edx
    m = run([0xb8, 5, 0, 0, 0, 0xb9, 5, 0, 0, 0, 0xba, 9, 0, 0, 0, 0x0f, 0xb1, 0xd1]);
    assert.equal(m.state.reg[1], 9);
    assert.equal(m.state.eflags & ZF, ZF);
    m = run([0xb8, 5, 0, 0, 0, 0xb9, 6, 0, 0, 0, 0xba, 9, 0, 0, 0, 0x0f, 0xb1, 0xd1]);
    assert.deepEqual([m.state.reg[0], m.state.reg[1]], [6, 6]);
    m = run([0xb8, 0x80, 0xff, 0xff, 0xff, 0x98, 0x99]); // cwde; cdq
    assert.deepEqual([m.state.reg[0], m.state.reg[2]], [0xffffff80, 0xffffffff]);
    // mov eax, 1; mov ebx, 2; cmp eax, ebx; cmovl eax, ebx
    m = run([0xb8, 1, 0, 0, 0, 0xbb, 2, 0, 0, 0, 0x39, 0xd8, 0x0f, 0x4c, 0xc3]);
    assert.equal(m.state.reg[0], 2);
    m = run([0xb9, 3, 0, 0, 0, 0x49, 0x75, 0xfd, 0xb8, 7, 0, 0, 0]); // dec ecx; jnz -3; mov eax, 7
    assert.deepEqual([m.state.reg[0], m.state.reg[1]], [7, 0]);
    m = run([0xb9, 3, 0, 0, 0, 0x40, 0xe2, 0xfd]); // inc eax; loop
    assert.equal(m.state.reg[0], 3);
});

test('pushf/popf, lahf/sahf, the flag instructions, enter/leave, pushad/popad', ()=>{
    let m = run([0xf9, 0x9c, 0x58]); // stc; pushf; pop eax
    assert.equal(m.state.reg[0] & CF, CF);
    assert.equal(m.state.reg[0] & 2, 2, 'bit 1 reads set');
    m = run([0xb8, 0x46, 0x02, 0, 0, 0x50, 0x9d]); // push 0x246; popf -> ZF PF
    assert.equal(m.state.eflags & (ZF | PF), ZF | PF);
    m = run([0xf9, 0x9f]); // stc; lahf
    assert.equal(m.state.reg[0] >>> 8 & 0xff, 0x03);
    m = run([0xb4, 0x40, 0x9e]); // mov ah, 0x40; sahf -> ZF
    assert.equal(m.state.eflags & ZF, ZF);
    m = run([0xf9, 0xf5, 0xfd]); // stc; cmc; std
    assert.equal(m.state.eflags & CF, 0);
    assert.equal(m.state.eflags & 0x400, 0x400);
    m = run([0xc8, 0x10, 0x00, 0x00, 0xc9]); // enter 16, 0; leave
    assert.deepEqual([m.state.reg[4], m.state.reg[5]], [0xf000, 0]);
    // mov eax, 1; mov ebx, 2; pushad; xor eax, eax; xor ebx, ebx; popad
    m = run([0xb8, 1, 0, 0, 0, 0xbb, 2, 0, 0, 0, 0x60, 0x31, 0xc0, 0x31, 0xdb, 0x61]);
    assert.deepEqual([m.state.reg[0], m.state.reg[3], m.state.reg[4]], [1, 2, 0xf000]);
});

test('int3, int n and the trap port', ()=>{
    assert.throws(()=>run([0xcc]),
        (/** @type {any} */ e)=>e instanceof Fault && e.vector === 3 && e.eip === 0x1001);
    assert.throws(()=>run([0xcd, 0x21]),
        (/** @type {any} */ e)=>e instanceof Fault && e.vector === 0x21);
    // mov dx, port; mov eax, 7; out dx, eax
    const m = run([0x66, 0xba, 0x77, 0xb0, 0xb8, 0x07, 0, 0, 0, 0xef]);
    assert.deepEqual(m.state.trapped, [7]);
    assert.equal(m.state.retired, 3);
});
