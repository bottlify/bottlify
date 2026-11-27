/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * x87 at 64 bits is x87 at 32: the unit, its encodings and their memory
 * operands are the same in either mode, and `evaluate64` runs the 32-bit
 * model's (`ir-x87.js`), which the 32-bit corpus judged against hardware.
 * Seeded sequences of the sequence corpus's x87 forms (`testing/sequences.js`),
 * entered on stacks of every depth, run on `evaluate` and on `evaluate64` from
 * the same registers and memory; the unit, ax, the flags `fcomi` and `fnstsw`
 * reach and every byte of the data must come out the same. The forms' memory
 * operands are rewritten from `[disp32]`, which long mode reads RIP-relative,
 * to the SIB form with no base, which both modes read as the absolute address.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODE_64, decode } from './decode/decoder.js';
import { createState, evaluate } from './ir.js';
import { createState64, evaluate64 } from './ir64.js';
import { DATA, DATA_BYTES, DATA_SIZE, HALT, POOL, REGISTERS, bodyOf, preambleOf, random }
    from './testing/sequences.js';

const CODE = 0x80000;
const MEMORY = 0x200000;
const SEQUENCES = 400;

/** The pool's x87 forms and the integer ones between them: no MMX or SSE. */
const FORMS = POOL.filter(form=>(form.bytes[0] >= 0xd8 && form.bytes[0] <= 0xdf)
    || ['mov eax, 0x0f3a9c11', 'add eax, ebx', 'xor ecx, ecx'].includes(form.name));

/**
 * A form's bytes with a `[disp32]` operand (mod 00, rm 101) made `[disp32]`
 * through a SIB byte with no base or index, the same address in either mode.
 *
 * @param {number[]} bytes
 */
function absolute(bytes){
    const isX87 = bytes[0] >= 0xd8 && bytes[0] <= 0xdf;
    if (!isX87 || (bytes[1] & 0xc7) !== 0x05)
    {
        return bytes;
    }
    return [bytes[0], bytes[1] & 0xf8 | 4, 0x25, ...bytes.slice(2)];
}

/** @param {Uint8Array} ram */
const memory32 = ram=>({
    read: (/** @type {number} */ at, /** @type {number} */ size)=>{
        let value = 0;
        for (let i = size - 1; i >= 0; i--)
        {
            value = value * 256 + ram[at + i];
        }
        return value >>> 0;
    },
    write: (/** @type {number} */ at, /** @type {number} */ size, /** @type {number} */ value)=>{
        for (let i = 0; i < size; i++)
        {
            ram[at + i] = value >>> (i * 8) & 0xff;
        }
    },
});

/** @param {Uint8Array} ram */
const memory64 = ram=>({
    read: (/** @type {bigint} */ at, /** @type {number} */ size)=>{
        let value = 0n;
        for (let i = size - 1; i >= 0; i--)
        {
            value = value << 8n | BigInt(ram[Number(at) + i]);
        }
        return value;
    },
    write: (/** @type {bigint} */ at, /** @type {number} */ size, /** @type {bigint} */ value)=>{
        for (let i = 0; i < size; i++)
        {
            ram[Number(at) + i] = Number(value >> BigInt(i * 8) & 0xffn);
        }
    },
    inaccessible: ()=>false,
});

/** A RAM with the program and the corpus's data in it. @param {Uint8Array} program */
function ramWith(program){
    const ram = new Uint8Array(MEMORY);
    ram.set(program, CODE);
    ram.set(DATA_BYTES, DATA);
    return ram;
}

/**
 * Runs the program to its `hlt` on the 32-bit model, then on the 64-bit one,
 * and answers both ends.
 *
 * @param {Uint8Array} program
 */
function both(program){
    const ram32 = ramWith(program);
    const narrow = createState(memory32(ram32), { eip: CODE, esp: REGISTERS.esp });
    narrow.reg[0] = REGISTERS.eax;
    narrow.reg[3] = REGISTERS.ebx;
    narrow.reg[1] = REGISTERS.ecx;
    const ram64 = ramWith(program);
    const wide = createState64(/** @type {any} */ (memory64(ram64)),
        { rip: BigInt(CODE), rsp: BigInt(REGISTERS.esp) });
    wide.r[0] = BigInt(REGISTERS.eax);
    wide.r[3] = BigInt(REGISTERS.ebx);
    wide.r[1] = BigInt(REGISTERS.ecx);
    wide.rflags = narrow.eflags;
    for (let steps = 0; ram32[narrow.eip] !== HALT && steps < 100; steps++)
    {
        evaluate(/** @type {import('./decode/decoder.js').Instruction} */ (
            decode(at=>ram32[at], narrow.eip)), narrow);
    }
    for (let steps = 0; ram64[Number(wide.rip)] !== HALT && steps < 100; steps++)
    {
        evaluate64(/** @type {import('./decode/decoder.js').Instruction} */ (
            decode(at=>ram64[at], Number(wide.rip), MODE_64)), wide);
    }
    const unit = /** @type {NonNullable<typeof wide.x87>} */ (wide.x87);
    const end32 = { top: narrow.top, empty: narrow.empty, status: narrow.status,
        control: narrow.control, f80: [...narrow.f80bits], exact: narrow.x87Exact,
        eax: narrow.reg[0], ecx: narrow.reg[1], flags: narrow.eflags & 0x8d5,
        data: [...ram32.subarray(DATA, DATA + DATA_SIZE)], at: narrow.eip - CODE };
    const end64 = { top: unit.top, empty: unit.empty, status: unit.status,
        control: unit.control, f80: [...unit.f80bits], exact: unit.x87Exact,
        eax: Number(wide.r[0] & 0xffffffffn), ecx: Number(wide.r[1] & 0xffffffffn),
        flags: wide.rflags & 0x8d5, data: [...ram64.subarray(DATA, DATA + DATA_SIZE)],
        at: Number(wide.rip) - CODE };
    return { end32, end64, upper: wide.r[0] >> 32n };
}

test('x87 sequences run at 64 bits as the 32-bit model runs them', ()=>{
    const next = random(0x87a64);
    const pool = FORMS.map(form=>({ ...form, bytes: absolute(form.bytes) }));
    const pushes = ['fld1', 'fldz', 'fld qword [m]', 'fxch st1', 'fxch st2']
        .map(name=>pool.findIndex(form=>form.name === name));
    let compared = 0;
    for (let i = 0; i < SEQUENCES; i++)
    {
        // The preamble's forms by name, into this pool's indices.
        const preamble = preambleOf(next).map(index=>POOL[index].name)
            .map(name=>pool.findIndex(form=>form.name === name))
            .filter(index=>index >= 0);
        const body = bodyOf(next, { pool });
        const indices = [...preamble, ...body];
        const program = Uint8Array.from([...indices.flatMap(index=>pool[index].bytes), HALT]);
        const { end32, end64, upper } = both(program);
        assert.deepEqual(end64, end32,
            `#${i}: ${indices.map(index=>pool[index].name).join('; ')}`);
        // A word write to ax leaves rax's upper half as it was, which the
        // sequences' mov eax cleared and nothing else wrote.
        assert.equal(upper, 0n);
        compared++;
    }
    assert.ok(pushes.every(index=>index >= 0));
    assert.equal(compared, SEQUENCES);
});

test('a long-mode block keeps the x87 unit between instructions', async()=>{
    // fld1; fld1; faddp; fstp qword [abs] -- across four steps, each loading the
    // unit from the block and storing it back.
    const { ownLayout, pagesFor, tablesSize } = await import('./runtime/layout.js');
    const { blockState64, interpret64 } = await import('./interp64.js');
    const layout = ownLayout({ ramSize: MEMORY, ramBase: 0, bits: 64 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, tablesSize(layout)) });
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    bytes.set([0xd9, 0xe8, 0xd9, 0xe8, 0xde, 0xc1, ...absolute([0xdd, 0x1d, 0, 0, 0x10, 0]), HALT],
        CODE);
    view.setUint16(layout.x87Control, 0x27f, true);
    bytes[layout.x87Empty] = 0xff;
    view.setBigUint64(layout.eip, BigInt(CODE), true);
    const state = blockState64({ memory, layout });
    interpret64(state, 100);
    state.syncOut();
    assert.equal(view.getFloat64(DATA, true), 2);
    assert.equal(bytes[layout.x87Empty], 0xff);
    assert.equal(bytes[layout.x87Top] & 7, 0);
    assert.equal(view.getUint16(layout.x87Control, true), 0x27f);
});
