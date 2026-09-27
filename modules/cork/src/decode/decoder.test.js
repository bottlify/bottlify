/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from './decoder.js';
import { AF, ARITH_FLAGS, CF, OF, PF, SF, ZF } from './table.js';

/** Decodes the bytes as if at `eip`. @param {number[]} bytes @param {number} [eip] */
function at(bytes, eip = 0x401000){
    const image = Uint8Array.from(bytes);
    const result = decode(address=>image[address - eip] ?? 0x00, eip);
    if ('refused' in result)
    {
        throw new Error(`refused ${result.opcode}: ${result.reason}`);
    }
    return result;
}

/** The refusal for the bytes. @param {number[]} bytes */
function refused(bytes){
    const image = Uint8Array.from(bytes);
    const result = decode(address=>image[address] ?? 0x00, 0);
    assert.ok('refused' in result, 'expected a refusal');
    return result;
}

test('register-to-register arithmetic, with and without the operand-size prefix', ()=>{
    const add = at([0x03, 0xc3]);
    assert.equal(add.op, 'add');
    assert.equal(add.length, 2);
    assert.equal(add.size, 4);
    assert.deepEqual(add.operands, [
        { kind: 'reg', size: 4, reg: 0 }, { kind: 'reg', size: 4, reg: 3 },
    ]);
    assert.equal(add.flagsWritten, ARITH_FLAGS);
    assert.equal(add.flagsRead, 0);
    assert.equal(add.flagsUndefined, 0);
    assert.equal(add.opcode, '03');

    const add16 = at([0x66, 0x03, 0xc3]);
    assert.equal(add16.size, 2);
    assert.equal(add16.length, 3);
    assert.equal(add16.operands[0].size, 2);
    assert.ok(add16.prefixes.operand);

    const byteForm = at([0x02, 0xc4]); // add al, ah
    assert.deepEqual(byteForm.operands, [
        { kind: 'reg', size: 1, reg: 0, high: false }, { kind: 'reg', size: 1, reg: 0, high: true },
    ]);
});

test('the SIB and displacement forms resolve to base, index, scale and disp', ()=>{
    const stack = at([0x8b, 0x44, 0x24, 0x08]); // mov eax, [esp+8]
    assert.equal(stack.op, 'mov');
    assert.equal(stack.length, 4);
    assert.deepEqual(stack.operands[1], {
        kind: 'mem', size: 4, base: 4, index: -1, scale: 1, disp: 8, segment: 2, addressSize: 32,
    });
    assert.equal(stack.memory, true);

    const scaled = at([0x8d, 0x04, 0x8d, 0x00, 0x00, 0x00, 0x00]); // lea eax, [ecx*4+0]
    assert.equal(scaled.op, 'lea');
    assert.equal(scaled.length, 7);
    assert.deepEqual(scaled.operands[1], {
        kind: 'mem', size: 0, base: -1, index: 1, scale: 4, disp: 0, segment: 3, addressSize: 32,
    });
    assert.equal(scaled.memory, true);

    const absolute = at([0xa1, 0x00, 0x90, 0x00, 0x00]); // mov eax, [0x9000]
    assert.deepEqual(absolute.operands[1], {
        kind: 'mem', size: 4, base: -1, index: -1, scale: 1, disp: 0x9000, segment: 3,
        addressSize: 32,
    });

    const negative = at([0x8b, 0x45, 0xfc]); // mov eax, [ebp-4]
    assert.equal(negative.operands[1].disp, -4);
    assert.equal(negative.operands[1].segment, 2, 'ebp-based addresses default to ss');

    const fs = at([0x64, 0x8b, 0x0d, 0x18, 0x00, 0x00, 0x00]); // mov ecx, fs:[0x18]
    assert.equal(fs.op, 'mov');
    assert.equal(fs.operands[1].segment, 4);
    assert.equal(fs.operands[1].disp, 0x18);
    assert.equal(fs.prefixes.segment, 4);
    assert.equal(fs.length, 7);
});

test('every 32-bit modrm/SIB combination matches the manual\'s formula', ()=>{
    // The formula: mod 0 rm 5 is disp32 with no base; rm 4 takes a SIB
    // whose base 5 with mod 0 is disp32; index 4 means none; mod 1 adds a
    // disp8, mod 2 a disp32.
    for (let modrm = 0; modrm < 0xc0; modrm++)
    {
        const mod = modrm >> 6;
        const rm = modrm & 7;
        const sibs = rm === 4 ? [...Array(256).keys()] : [null];
        for (const sib of sibs)
        {
            const bytes = [0x8d, modrm];
            if (sib !== null)
            {
                bytes.push(sib);
            }
            const dispBytes = mod === 1 ? 1
                : (mod === 2 || (rm === 5 && mod === 0)
                    || (sib !== null && (sib & 7) === 5 && mod === 0)) ? 4
                    : 0;
            for (let i = 0; i < dispBytes; i++)
            {
                bytes.push(0x9a);
            }
            const decoded = at(bytes);
            const operand = decoded.operands[1];
            assert.equal(decoded.length, bytes.length, `length of modrm ${modrm} sib ${sib}`);
            let expectedBase = rm;
            let expectedIndex = -1;
            let expectedScale = 1;
            if (sib !== null)
            {
                expectedScale = 1 << (sib >> 6);
                expectedIndex = (sib >> 3 & 7) === 4 ? -1 : sib >> 3 & 7;
                expectedBase = sib & 7;
                if (expectedBase === 5 && mod === 0)
                {
                    expectedBase = -1;
                }
            }
            else if (rm === 5 && mod === 0)
            {
                expectedBase = -1;
            }
            const expectedDisp = dispBytes === 1 ? (0x9a << 24 >> 24)
                : dispBytes === 4 ? (0x9a9a9a9a | 0) : 0;
            assert.deepEqual(
                {
                    base: operand.base, index: operand.index, scale: operand.scale,
                    disp: operand.disp,
                },
                {
                    base: expectedBase, index: expectedIndex, scale: expectedScale,
                    disp: expectedDisp,
                },
                `modrm ${modrm.toString(16)} sib ${sib === null ? '-' : sib.toString(16)}`);
        }
    }
});

test('the 16-bit addressing forms under an address-size prefix', ()=>{
    const bxsi = at([0x67, 0x8d, 0x00]); // lea eax, [bx+si]
    assert.deepEqual([bxsi.operands[1].base, bxsi.operands[1].index, bxsi.operands[1].addressSize],
        [3, 6, 16]);
    const direct = at([0x67, 0x8d, 0x06, 0x34, 0x12]); // lea eax, [0x1234]
    assert.deepEqual([direct.operands[1].base, direct.operands[1].index, direct.operands[1].disp],
        [-1, -1, 0x1234]);
    assert.equal(direct.length, 5);
    const bp = at([0x67, 0x8d, 0x46, 0xf0]); // lea eax, [bp-16]
    assert.deepEqual([bp.operands[1].base, bp.operands[1].disp, bp.operands[1].segment],
        [5, -16, 2]);
});

test('immediates: sign-extended bytes, words, dwords, and the shift-by-one form', ()=>{
    const addImm = at([0x83, 0xc0, 0xff]); // add eax, -1
    assert.equal(addImm.op, 'add');
    assert.deepEqual(addImm.operands[1], { kind: 'imm', size: 4, value: 0xffffffff });
    const sub16 = at([0x66, 0x83, 0xe8, 0xff]); // sub ax, -1
    assert.deepEqual(sub16.operands[1], { kind: 'imm', size: 2, value: 0xffff });
    const movImm = at([0xb8, 0x78, 0x56, 0x34, 0x12]); // mov eax, 0x12345678
    assert.deepEqual(movImm.operands,
        [{ kind: 'reg', size: 4, reg: 0 }, { kind: 'imm', size: 4, value: 0x12345678 }]);
    const movByte = at([0xb4, 0x7f]); // mov ah, 0x7f
    assert.deepEqual(movByte.operands,
        [{ kind: 'reg', size: 1, reg: 0, high: true }, { kind: 'imm', size: 1, value: 0x7f }]);
    const shl1 = at([0xd1, 0xe0]); // shl eax, 1
    assert.equal(shl1.op, 'shl');
    assert.deepEqual(shl1.operands[1], { kind: 'imm', size: 1, value: 1 });
    assert.equal(shl1.flagsUndefined, AF | OF);
    const shlCl = at([0xd3, 0xe0]);
    assert.deepEqual(shlCl.operands[1], { kind: 'reg', size: 1, reg: 1, high: false });
    const ret = at([0xc2, 0x08, 0x00]);
    assert.deepEqual(ret.operands, [{ kind: 'imm', size: 2, value: 8 }]);
    const enter = at([0xc8, 0x10, 0x00, 0x00]);
    assert.deepEqual(enter.operands.map(o=>o.value), [16, 0]);
    const push = at([0x6a, 0xfe]); // push -2
    assert.deepEqual(push.operands[0], { kind: 'imm', size: 4, value: 0xfffffffe });
});

test('relative branches carry their absolute target and the flags they read', ()=>{
    const jne = at([0x75, 0xf7], 0x1000); // jne -9
    assert.equal(jne.op, 'jne');
    assert.equal(jne.cc, 5);
    assert.deepEqual(jne.operands, [{ kind: 'rel', size: 4, target: 0x1002 - 9 }]);
    assert.equal(jne.flagsRead, ZF);
    const jl = at([0x0f, 0x8c, 0x00, 0x01, 0x00, 0x00], 0x1000); // jl +0x100
    assert.equal(jl.operands[0].target, 0x1006 + 0x100);
    assert.equal(jl.flagsRead, SF | OF);
    assert.equal(jl.length, 6);
    const call = at([0xe8, 0xfb, 0xff, 0xff, 0xff], 0x2000); // call -5 (itself)
    assert.equal(call.op, 'call');
    assert.equal(call.operands[0].target, 0x2000);
    const jmpShort = at([0xeb, 0xfd], 0x8001); // the corpus footer's jmp loop
    assert.equal(jmpShort.operands[0].target, 0x8000);
    const setb = at([0x0f, 0x92, 0xc0]); // setb al
    assert.equal(setb.flagsRead, CF);
    assert.deepEqual(setb.operands, [{ kind: 'reg', size: 1, reg: 0, high: false }]);
    const cmovle = at([0x0f, 0x4e, 0xc1]);
    assert.equal(cmovle.flagsRead, ZF | SF | OF);
    assert.equal(cmovle.cc, 14);
});

test('groups select by /r, with each member\'s own flags', ()=>{
    assert.equal(at([0x80, 0x38, 0x01]).op, 'cmp'); // cmp byte [eax], 1
    const and = at([0x81, 0xe1, 0xff, 0x00, 0x00, 0x00]); // and ecx, 0xff
    assert.equal(and.op, 'and');
    assert.equal(and.flagsUndefined, AF);
    assert.equal(at([0xf7, 0xd8]).op, 'neg');
    const div = at([0xf7, 0xf1]); // div ecx
    assert.equal(div.op, 'div');
    assert.equal(div.faults, 'divide');
    assert.equal(div.flagsUndefined, ARITH_FLAGS);
    const testByte = at([0xf6, 0x00, 0x80]); // test byte [eax], 0x80
    assert.equal(testByte.op, 'test');
    assert.equal(testByte.operands[1].value, 0x80);
    assert.equal(at([0xff, 0xd0]).op, 'call'); // call eax
    assert.equal(at([0xff, 0xe0]).op, 'jmp');
    assert.equal(at([0xff, 0x30]).op, 'push');
    assert.equal(at([0xfe, 0xc8]).op, 'dec');
    assert.equal(at([0x0f, 0xba, 0xe0, 0x05]).op, 'bt'); // bt eax, 5 (/4)
    assert.equal(at([0x0f, 0xba, 0xe8, 0x05]).op, 'bts'); // bts eax, 5 (/5)
    assert.equal(at([0x0f, 0xc7, 0x08]).op, 'cmpxchg8b');
    assert.equal(at([0x0f, 0xae, 0x10]).op, 'ldmxcsr');
    assert.equal(at([0x0f, 0xae, 0xf0]).op, 'mfence');
});

test('the two-byte map: cpuid, rdtsc, movzx, bswap, bit scans, ud2', ()=>{
    assert.equal(at([0x0f, 0xa2]).op, 'cpuid');
    assert.equal(at([0x0f, 0x31]).op, 'rdtsc');
    const movzx = at([0x0f, 0xb6, 0xc1]); // movzx eax, cl
    assert.equal(movzx.op, 'movzx');
    assert.deepEqual(movzx.operands,
        [{ kind: 'reg', size: 4, reg: 0 }, { kind: 'reg', size: 1, reg: 1, high: false }]);
    const movsxw = at([0x0f, 0xbf, 0x00]); // movsx eax, word [eax]
    assert.equal(movsxw.operands[1].size, 2);
    assert.deepEqual(at([0x0f, 0xc9]).operands, [{ kind: 'reg', size: 4, reg: 1 }]);
    const bsf = at([0x0f, 0xbc, 0xc1]);
    assert.equal(bsf.flagsWritten & ZF, ZF);
    assert.equal(bsf.flagsUndefined & ZF, 0);
    const ud2 = at([0x0f, 0x0b]);
    assert.equal(ud2.op, 'ud2');
    assert.equal(ud2.faults, 'invalid');
    const imul3 = at([0x6b, 0xc0, 0x0a]); // imul eax, eax, 10
    assert.equal(imul3.operands.length, 3);
    assert.equal(imul3.flagsUndefined, PF | AF | ZF | SF);
    assert.equal(at([0x0f, 0x1f, 0x44, 0x00, 0x00]).op, 'nop');
});

test('SSE forms are selected by the mandatory prefix, which then is not a repeat', ()=>{
    const movss = at([0xf3, 0x0f, 0x10, 0x05, 0x00, 0x20, 0x00, 0x00]); // movss xmm0, [0x2000]
    assert.equal(movss.op, 'movss');
    assert.equal(movss.opcode, 'f3 0f 10');
    assert.deepEqual(movss.operands[0], { kind: 'xmm', size: 4, reg: 0 });
    assert.equal(movss.operands[1].size, 4);
    assert.equal(movss.prefixes.rep, false);
    assert.equal(movss.length, 8);
    const movaps = at([0x0f, 0x28, 0x1d, 0x00, 0x90, 0x00, 0x00]); // movaps xmm3, [0x9000]
    assert.equal(movaps.op, 'movaps');
    assert.equal(movaps.operands[0].reg, 3);
    assert.equal(movaps.operands[1].size, 16);
    const movdqa = at([0x66, 0x0f, 0x6f, 0xc1]);
    assert.equal(movdqa.op, 'movdqa');
    assert.equal(movdqa.prefixes.operand, false);
    const movq = at([0x0f, 0x6f, 0xc1]); // movq mm0, mm1
    assert.equal(movq.op, 'movq');
    assert.deepEqual(movq.operands,
        [{ kind: 'mm', size: 8, reg: 0 }, { kind: 'mm', size: 8, reg: 1 }]);
    const paddb = at([0x0f, 0xfc, 0xc1]);
    assert.equal(paddb.operands[0].kind, 'mm');
    const paddbx = at([0x66, 0x0f, 0xfc, 0xc1]);
    assert.equal(paddbx.operands[0].kind, 'xmm');
    const shufps = at([0x0f, 0xc6, 0xc1, 0x1b]);
    assert.equal(shufps.op, 'shufps');
    assert.equal(shufps.operands[2].value, 0x1b);
    const psrld = at([0x66, 0x0f, 0x72, 0xd0, 0x04]); // psrld xmm0, 4
    assert.equal(psrld.op, 'psrld');
    assert.equal(psrld.operands[1].value, 4);
    const cvtsi2ss = at([0xf3, 0x0f, 0x2a, 0xc0]);
    assert.equal(cvtsi2ss.op, 'cvtsi2ss');
    assert.equal(cvtsi2ss.operands[1].kind, 'reg');
    const comiss = at([0x0f, 0x2f, 0xc1]);
    assert.equal(comiss.flagsWritten, ARITH_FLAGS);
    const rep = at([0xf3, 0xa5]); // rep movsd
    assert.equal(rep.op, 'movs');
    assert.equal(rep.prefixes.rep, true);
    assert.equal(rep.operands[0].base, 7);
    assert.equal(rep.operands[0].segment, 0, 'the destination is always es');
    assert.equal(rep.operands[1].base, 6);
    assert.equal(rep.operands[1].segment, 3);
});

test('x87: register forms by the modrm byte, memory forms by /r', ()=>{
    const fxch = at([0xd9, 0xc9]);
    assert.equal(fxch.op, 'fxch');
    assert.deepEqual(fxch.operands,
        [{ kind: 'x87', size: 10, reg: 0 }, { kind: 'x87', size: 10, reg: 1 }]);
    const fstp = at([0xdd, 0xd8]); // fstp st0
    assert.equal(fstp.op, 'fstp');
    assert.equal(fstp.operands[0].reg, 0);
    const fld1 = at([0xd9, 0xe8]);
    assert.equal(fld1.op, 'fld1');
    const fldM64 = at([0xdd, 0x05, 0x00, 0x20, 0x00, 0x00]); // fld qword [0x2000]
    assert.equal(fldM64.op, 'fld');
    assert.equal(fldM64.operands[1].kind, 'mem');
    assert.equal(fldM64.operands[1].size, 8);
    assert.equal(fldM64.memory, true);
    const fmulSt = at([0xdc, 0xc9]); // fmul st1, st0
    assert.deepEqual(fmulSt.operands.map(o=>o.reg), [1, 0]);
    const fsubrp = at([0xde, 0xe1]); // fsubrp st1, st0 -- DE E0+i is fsubrp
    assert.equal(fsubrp.op, 'fsubrp');
    const fistp = at([0xdb, 0x5d, 0xf8]); // fistp dword [ebp-8]
    assert.equal(fistp.op, 'fistp');
    assert.equal(fistp.operands[0].size, 4);
    const fldcw = at([0xd9, 0x6d, 0xfe]); // fldcw [ebp-2]
    assert.equal(fldcw.op, 'fldcw');
    assert.equal(fldcw.operands[0].size, 2);
    const fnstsw = at([0xdf, 0xe0]);
    assert.equal(fnstsw.op, 'fnstsw');
    assert.deepEqual(fnstsw.operands, [{ kind: 'reg', size: 2, reg: 0 }]);
    const fcomi = at([0xdb, 0xf1]);
    assert.equal(fcomi.flagsWritten, ARITH_FLAGS);
    const fcmovne = at([0xdb, 0xc9]);
    assert.equal(fcmovne.flagsRead, ZF);
    assert.equal(at([0xd9, 0xc8]).operands[1].reg, 0, 'fxch st0');
});

test('bound decodes its register form too, as the emulator consumes it', ()=>{
    const memory = at([0x62, 0x10]);          // bound edx, [eax]
    assert.equal(memory.op, 'bound');
    assert.equal(memory.operands[1].kind, 'mem');
    const register = at([0x62, 0xd0]);        // bound edx, eax
    assert.equal(register.op, 'bound');
    assert.deepEqual(register.operands.map(operand=>operand.kind), ['reg', 'reg']);
    assert.equal(register.memory, false);
});

test('the refusals name the opcode and the reason', ()=>{
    assert.deepEqual(refused([0xff, 0xf8]),
        { refused: true, eip: 0, opcode: 'ff /7', reason: 'not in table', invalid: true });
    assert.deepEqual(refused([0xea, 0, 0, 0, 0, 0, 0]).reason, 'not user mode');
    assert.equal(refused([0x0f, 0x01, 0x10]).reason, 'not user mode');
    assert.equal(refused([0x0f, 0x38, 0x00, 0xc1]).opcode, '0f 38');
    assert.equal(refused([0xf2, 0x0f, 0x28, 0xc1]).opcode, 'f2 0f 28', 'a prefix with no variant');
    assert.equal(refused([0x8d, 0xc0]).reason, 'memory form only');
    assert.equal(refused([0xf0, 0x01, 0xc0]).reason, 'lock on a register form');
    assert.equal(refused([0x8e, 0xf8]).reason, 'no such segment register');
    assert.equal(refused(new Array(16).fill(0x66)).reason, 'longer than fifteen bytes');
    // Which of them a processor rejects with #UD, as against a form this
    // decoder does not know: an SSE4 op is an instruction, ff /7 is none.
    assert.equal(refused([0xff, 0xf8]).invalid, true);
    assert.equal(refused([0x8d, 0xc0]).invalid, true, 'lea of a register');
    assert.equal(refused([0x0f, 0x38, 0x00, 0xc1]).invalid, false);
    assert.equal(refused([0xea, 0, 0, 0, 0, 0, 0]).invalid, false);
    const sixtyFour = decode(()=>0x90, 0, { bits: 64 });
    assert.ok('refused' in sixtyFour);
});

test('segment registers, the string forms, prefixes that stack, and hlt', ()=>{
    const movSs = at([0x8c, 0xd0]); // mov eax, ss
    assert.deepEqual(movSs.operands,
        [{ kind: 'reg', size: 2, reg: 0 }, { kind: 'seg', size: 2, reg: 2 }]);
    assert.equal(at([0x1e]).op, 'push');
    assert.deepEqual(at([0x1e]).operands, [{ kind: 'seg', size: 2, reg: 3 }]);
    const movsd = at([0x36, 0x3e, 0xa5]); // ss: ds: movsd -- the last override wins
    assert.equal(movsd.operands[1].segment, 3);
    assert.equal(movsd.length, 3);
    const lock = at([0xf0, 0x0f, 0xb1, 0x0a]); // lock cmpxchg [edx], ecx
    assert.equal(lock.op, 'cmpxchg');
    assert.ok(lock.prefixes.lock);
    const hlt = at([0xf4]);
    assert.equal(hlt.faults, 'halt');
    const out = at([0xef]);
    assert.equal(out.op, 'out');
    assert.equal(out.faults, 'trap');
    assert.deepEqual(out.operands,
        [{ kind: 'reg', size: 2, reg: 2 }, { kind: 'reg', size: 4, reg: 0 }]);
    const pushf = at([0x9c]);
    assert.equal(pushf.flagsRead, ARITH_FLAGS | 1 << 10);
    const xlat = at([0xd7]);
    assert.deepEqual([xlat.operands[0].base, xlat.operands[0].index], [3, 0]);
});
