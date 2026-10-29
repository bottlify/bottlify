/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The x87 as a module that is not `precise` translates it: what it does not
 * keep (the exception flags, signalling NaNs, underflow, C1 cleared) pinned,
 * and what it keeps -- every value, C0 C2 C3, the stack and its faults, the
 * rounding control -- the same as the precise module's, side by side.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { CF, PF, ZF } from '../decode/table.js';

const CODE = 0x1000;
const DATA = 0x2000;

/**
 * Runs a program with every x87 register empty, and answers the machine.
 *
 * @param {number[]} bytes @param {boolean} precise
 * @param {{ data?: number[], control?: number }} [start]
 */
function run(bytes, precise, start = {}){
    const { data = [], control = 0x37f } = start;
    const m = createTestMachine({ precise });
    const view = new DataView(m.memory.buffer);
    view.setUint16(m.layout.x87Control, control, true);
    m.write(DATA, data);
    m.write(CODE, [...bytes, 0xf4]);
    m.setReg('esp', 0x80000);
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, 3, 'the program halts');
    return {
        m,
        /** ST(i) as f64. @param {number} i */
        st: i=>view.getFloat64(
            m.layout.x87 + (((view.getUint8(m.layout.x87Top) + i) & 7) * 16), true),
        top: ()=>view.getUint8(m.layout.x87Top),
        empty: ()=>view.getUint8(m.layout.x87Empty),
        status: ()=>view.getUint16(m.layout.x87Status, true),
        /** @param {number} address */
        u32: address=>view.getUint32(m.layout.ramBase + address, true),
        /** @param {number} address */
        u64: address=>view.getBigUint64(m.layout.ramBase + address, true),
    };
}

/** Both modules over the same program. @param {number[]} bytes @param {any} [start] */
const both = (bytes, start)=>({ fast: run(bytes, false, start), precise: run(bytes, true, start) });

/** @param {number} value */
function f64bytes(value){
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, value, true);
    return [...b];
}

const at = (/** @type {number} */ address)=>[address & 0xff, address >> 8 & 0xff, 0, 0];

test('the exception flags are not raised: ZE, IE and UE, with the same values', ()=>{
    // fld1; fldz; fdivp: 1 / 0
    let r = both([0xd9, 0xe8, 0xd9, 0xee, 0xde, 0xf9]);
    assert.equal(r.precise.status() & 4, 4, 'precise: ZE');
    assert.equal(r.fast.status() & 0x3f, 0, 'fast: no ZE');
    assert.equal(r.fast.st(0), Infinity);
    // fld1; fchs; fsqrt: the square root of -1, the processor's negative NaN
    r = both([0xd9, 0xe8, 0xd9, 0xe0, 0xd9, 0xfa, 0xdd, 0x1d, ...at(DATA)]);
    assert.equal(r.precise.status() & 1, 1, 'precise: IE');
    assert.equal(r.fast.status() & 0x3f, 0, 'fast: no IE');
    assert.equal(r.fast.u64(DATA), r.precise.u64(DATA), 'the same NaN stored');
    // 1/0 = inf; fld st0; fsubp: inf - inf
    r = both([0xd9, 0xe8, 0xd9, 0xee, 0xde, 0xf9, 0xd9, 0xc0, 0xde, 0xe9,
        0xdd, 0x1d, ...at(DATA)]);
    assert.equal(r.precise.status() & 1, 1);
    assert.equal(r.fast.status() & 0x3f, 0);
    assert.equal(r.fast.u64(DATA), r.precise.u64(DATA));
    // fld qword [DATA]; fstp dword [DATA+8]: a double below the smallest normal single
    r = both([0xdd, 0x05, ...at(DATA), 0xd9, 0x1d, ...at(DATA + 8)],
        { data: f64bytes(2 ** -130) });
    assert.equal(r.precise.status() & 0x10, 0x10, 'precise: UE');
    assert.equal(r.fast.status() & 0x3f, 0, 'fast: no UE');
    assert.equal(r.fast.u32(DATA + 8), r.precise.u32(DATA + 8), 'the same denormal stored');
    assert.equal(r.fast.u32(DATA + 8), 0x00080000);
});

test('a signalling NaN loads without IE; an m32 is quieted by the conversion, an m64 kept', ()=>{
    // fld dword [DATA]; fstp qword [DATA+8]; fld qword [DATA+16]; fstp qword [DATA+24]
    const r = both([0xd9, 0x05, ...at(DATA), 0xdd, 0x1d, ...at(DATA + 8),
        0xdd, 0x05, ...at(DATA + 16), 0xdd, 0x1d, ...at(DATA + 24)],
    { data: [0x01, 0x00, 0x80, 0x7f, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
        0x01, 0, 0, 0, 0, 0, 0xf0, 0x7f] });
    assert.equal(r.precise.status() & 1, 1, 'precise: IE');
    assert.equal(r.fast.status() & 0x3f, 0, 'fast: no IE');
    assert.equal(r.fast.u64(DATA + 8), r.precise.u64(DATA + 8), 'm32: quiet either way');
    assert.equal(r.precise.u64(DATA + 24), 0x7ff8000000000001n, 'precise: m64 quieted');
    assert.equal(r.fast.u64(DATA + 24), 0x7ff0000000000001n, 'fast: m64 as it was');
});

test('C0, C2 and C3 of every compare are exact; IE and C1 are not kept', ()=>{
    const nan = [0, 0, 0xc0, 0x7f];
    for (const [value, bits, name] of /** @type {[number[], number, string][]} */ ([
        [[0, 0, 0x80, 0x3f], 0x4000, 'equal'],           // 1.0: C3
        [[0, 0, 0x00, 0x40], 0x0100, 'less'],            // 2.0: C0
        [[0, 0, 0x00, 0x00], 0x0000, 'greater'],         // 0.0: none
        [nan, 0x4500, 'unordered'],                      // NaN: C3 C2 C0
    ]))
    {
        // fld1; fcomp dword [DATA]; fnstsw ax -- and unordered, from registers:
        // fld dword [DATA]; fld1; fucomp st1; fnstsw ax
        for (const ordered of [true, false])
        {
            const bytes = ordered
                ? [0xd9, 0xe8, 0xd8, 0x1d, ...at(DATA), 0xdf, 0xe0]
                : [0xd9, 0x05, ...at(DATA), 0xd9, 0xe8, 0xdd, 0xe9, 0xdf, 0xe0];
            const r = both(bytes, { data: value });
            assert.equal(r.fast.m.reg('eax') & 0x4500, bits, `${name}: the condition bits`);
            assert.equal(r.fast.m.reg('eax') & 0x4500, r.precise.m.reg('eax') & 0x4500);
            assert.equal(r.fast.status() & 0x3f, 0, `${name}: no IE`);
        }
    }
    // fld dword [DATA]; fstp st0; fld1; fcom st1; fnstsw ax -- st1 is empty, its
    // register still holding 2.0, which compares greater than 1: unordered all the same
    const empty = both([0xd9, 0x05, ...at(DATA), 0xdd, 0xd8, 0xd9, 0xe8, 0xd8, 0xd1, 0xdf, 0xe0],
        { data: [0, 0, 0x00, 0x40] });
    assert.equal(empty.fast.m.reg('eax') & 0x4500, 0x4500, 'an empty register: unordered');
    assert.equal(empty.fast.m.reg('eax') & 0x4500, empty.precise.m.reg('eax') & 0x4500);
    // fld1; fld dword [DATA]; fcomip st1: ZF PF CF from an unordered compare, no IE
    const r = both([0xd9, 0xe8, 0xd9, 0x05, ...at(DATA), 0xdf, 0xf1], { data: nan });
    assert.equal(r.fast.m.eflags() & (CF | PF | ZF), CF | PF | ZF);
    assert.equal(r.precise.status() & 1, 1);
    assert.equal(r.fast.status() & 0x3f, 0);
});

test('C1 is left as it was by a push, where the precise module clears it', ()=>{
    // Nine pushes: the ninth overflows (IE, SF, C1 and the indefinite), then
    // fstp st0 twice and a push that fits.
    const r = both([...new Array(9).fill([0xd9, 0xe8]).flat(), 0xdd, 0xd8, 0xdd, 0xd8,
        0xd9, 0xee]);
    assert.equal(r.precise.status() & 0x241, 0x41, 'precise: the push that fits cleared C1');
    assert.equal(r.fast.status() & 0x241, 0x241, 'fast: C1 as the overflow left it');
    assert.equal(r.fast.top(), r.precise.top());
    assert.equal(r.fast.empty(), r.precise.empty());
});

test('a stack fault is exact: IE and SF, the indefinite, whichever the module', ()=>{
    // fld1; fstp st0; fld st1 -- st1 is empty: IE, SF and the indefinite pushed
    const r = both([0xd9, 0xe8, 0xdd, 0xd8, 0xd9, 0xc1, 0xdd, 0x1d, ...at(DATA)]);
    for (const one of [r.fast, r.precise])
    {
        assert.equal(one.status() & 0x41, 0x41);
        assert.equal(one.u64(DATA), 0xfff8000000000000n);
    }
});

test('an integer store rounds by the control word inline and stores the indefinite', ()=>{
    // fld qword [DATA]; fistp dword [DATA+8], under each rounding control
    const bytes = [0xdd, 0x05, ...at(DATA), 0xdb, 0x1d, ...at(DATA + 8)];
    for (const [control, expected] of [[0x37f, -2], [0x77f, -3], [0xb7f, -2], [0xf7f, -2]])
    {
        const r = both(bytes, { control, data: f64bytes(-2.5) });
        assert.equal(r.fast.u32(DATA + 8) | 0, expected, `control ${control.toString(16)}`);
        assert.equal(r.precise.u32(DATA + 8) | 0, expected);
    }
    const r = both(bytes, { control: 0xf7f, data: f64bytes(1e12) });
    assert.equal(r.fast.u32(DATA + 8), 0x80000000, 'fast: the indefinite');
    assert.equal(r.precise.u32(DATA + 8), 0x80000000);
    assert.equal(r.precise.status() & 1, 1, 'precise: IE');
    assert.equal(r.fast.status() & 0x3f, 0, 'fast: no IE');
    // fistp word and qword out of range
    const wide = both([0xdd, 0x05, ...at(DATA), 0xd9, 0xc0, 0xdf, 0x1d, ...at(DATA + 8),
        0xdf, 0x3d, ...at(DATA + 16)], { data: f64bytes(-1e30) });
    assert.equal(wide.fast.u32(DATA + 8) & 0xffff, 0x8000);
    assert.equal(wide.fast.u64(DATA + 16), 0x8000000000000000n);
});

test('a dword or word integer store of every edge of its range, under every rounding control,'
    + ' stores what the precise module stores', ()=>{
    const values = [0, -0, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 3.5, 1e-300, -1e-300,
        0.49999999999999994, Infinity, -Infinity, NaN, -NaN, 1e300, -1e300, 2 ** 63, -(2 ** 63),
        2 ** 64];
    for (const limit of [2 ** 15, 2 ** 31])
    {
        for (const d of [-1.5, -1, -0.5, -0.25, 0, 0.25, 0.5, 1, 1.5])
        {
            values.push(limit + d, -limit + d);
        }
    }
    for (const big of [2 ** 51, 2 ** 52, 2 ** 53])
    {
        for (const d of [-1, -0.5, 0, 0.5, 1])
        {
            values.push(big + d, -big + d);
        }
    }
    let seed = 7;
    for (let i = 0; i < 40; i++)
    {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        values.push((seed / 0x7fffffff - 0.5) * 2 ** (i % 40));
    }
    const data = values.flatMap(f64bytes);
    for (const [opcode, reg, size] of [[0xdb, 0x1d, 4], [0xdf, 0x1d, 2], [0xdb, 0x15, 4]])
    {
        // fld qword [DATA + 8i]; fistp (or fist, then fstp st0) [OUT + 4i]
        const bytes = values.flatMap((_, i)=>[0xdd, 0x05, ...at(DATA + 8 * i),
            opcode, reg, ...at(0x4000 + 4 * i), ...reg === 0x15 ? [0xdd, 0xd8] : []]);
        for (const control of [0x37f, 0x77f, 0xb7f, 0xf7f])
        {
            const r = both(bytes, { control, data });
            values.forEach((value, i)=>{
                const mask = size === 2 ? 0xffff : 0xffffffff;
                const out = 0x4000 + 4 * i;
                assert.equal(r.fast.u32(out) & mask, r.precise.u32(out) & mask,
                    `${value} under ${control.toString(16)}, ${size} bytes`);
            });
        }
    }
});

test('the status-word reads that may see what is not kept are counted at translation', ()=>{
    const reads = (/** @type {number[]} */ bytes, /** @type {boolean} */ precise)=>{
        const m = createTestMachine({ precise });
        m.write(CODE, [0xd9, 0xe8, 0xd8, 0xd1, ...bytes, 0xf4]); // fld1; fcom st1
        return m.translate(CODE).translation.x87RelaxedReads;
    };
    assert.equal(reads([0xdf, 0xe0, 0x9e], false), 0, 'fnstsw ax; sahf');
    assert.equal(reads([0xdf, 0xe0, 0xf6, 0xc4, 0x45], false), 0, 'fnstsw ax; test ah, 0x45');
    assert.equal(reads([0xdf, 0xe0, 0x80, 0xe4, 0x05], false), 0, 'fnstsw ax; and ah, 5');
    assert.equal(reads([0xdf, 0xe0, 0xf6, 0xc4, 0x02], false), 1, 'test ah, 2 reads C1');
    assert.equal(reads([0xdf, 0xe0, 0xa8, 0x01], false), 1, 'test al, 1 reads IE');
    assert.equal(reads([0xdd, 0x3d, ...at(DATA)], false), 1, 'fnstsw [mem]');
    assert.equal(reads([0xd9, 0x35, ...at(DATA)], false), 1, 'fnstenv [mem]');
    assert.equal(reads([0xdd, 0x3d, ...at(DATA)], true), 0, 'a precise module keeps them');
});
