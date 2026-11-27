/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MMX at 64 bits is MMX at 32 but for the quadword moves between an MMX
 * register and a general one (REX.W `0F 6E`/`0F 7E`): `evaluate64` runs the
 * 32-bit model's (`ir-simd.js`), which the MMX sequence gate judges. Seeded
 * sequences of the saturating, multiplying, unpacking, shifting and moving
 * forms run on `evaluate` and on `evaluate64` from the same registers and
 * memory; the MMX registers (the x87 unit's bits), the unit's state, the
 * general registers and every byte of the data must come out the same, and
 * the general registers' upper halves clear, as a doubleword write leaves
 * them. Memory operands are `[disp32]` through a SIB byte with no base or
 * index, the same address in either mode. The long-mode forms are judged on
 * their own, against what the instruction does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODE_64, decode } from './decode/decoder.js';
import { createState, evaluate } from './ir.js';
import { createState64, evaluate64 } from './ir64.js';
import { DATA, DATA_SIZE, HALT, random } from './testing/sequences.js';

const CODE = 0x80000;
const MEMORY = 0x200000;
const SEQUENCES = 600;

/** Words near both signed bounds, and the quadwords stores land in. */
const HIGH = DATA + 0x40;
const LOW = DATA + 8;
const OUT = DATA + 0x10;

/** @param {number} address */
const disp32 = address=>[address & 0xff, address >>> 8 & 0xff,
    address >>> 16 & 0xff, address >>> 24 & 0xff];

/**
 * `0F op` with a register field and an absolute memory operand.
 *
 * @param {number[]} opcode @param {number} reg @param {number} address @param {number[]} [after]
 */
const absolute = (opcode, reg, address, after = [])=>[...opcode, reg << 3 | 4, 0x25,
    ...disp32(address), ...after];

const POOL = [
    { name: 'movq mm1, [high]', bytes: absolute([0x0f, 0x6f], 1, HIGH) },
    { name: 'movq mm3, [low]', bytes: absolute([0x0f, 0x6f], 3, LOW) },
    { name: 'movq mm4, [high+8]', bytes: absolute([0x0f, 0x6f], 4, HIGH + 8) },
    { name: 'movq mm7, mm3', bytes: [0x0f, 0x7f, 0xdf] },
    { name: 'movq mm0, mm5', bytes: [0x0f, 0x7f, 0xe8] },
    { name: 'movq mm2, mm0', bytes: [0x0f, 0x6f, 0xd0] },
    { name: 'psubsw mm0, mm3', bytes: [0x0f, 0xe9, 0xc3] },
    { name: 'psubsw mm3, [high]', bytes: absolute([0x0f, 0xe9], 3, HIGH) },
    { name: 'psrlq mm7, 0x20', bytes: [0x0f, 0x73, 0xd7, 0x20] },
    { name: 'paddsw mm0, mm7', bytes: [0x0f, 0xed, 0xc7] },
    { name: 'paddsw mm0, mm1', bytes: [0x0f, 0xed, 0xc1] },
    { name: 'paddusw mm1, mm4', bytes: [0x0f, 0xdd, 0xcc] },
    { name: 'psubusb mm4, mm3', bytes: [0x0f, 0xd8, 0xe3] },
    { name: 'pand mm5, mm7', bytes: [0x0f, 0xdb, 0xef] },
    { name: 'pandn mm0, mm1', bytes: [0x0f, 0xdf, 0xc1] },
    { name: 'pcmpeqw mm6, mm6', bytes: [0x0f, 0x75, 0xf6] },
    { name: 'pcmpgtb mm2, mm1', bytes: [0x0f, 0x64, 0xd1] },
    { name: 'movd mm7, ebx', bytes: [0x0f, 0x6e, 0xfb] },
    { name: 'movd eax, mm1', bytes: [0x0f, 0x7e, 0xc8] },
    { name: 'punpckhbw mm2, mm1', bytes: [0x0f, 0x68, 0xd1] },
    { name: 'punpcklwd mm7, mm7', bytes: [0x0f, 0x61, 0xff] },
    { name: 'punpckldq mm7, mm7', bytes: [0x0f, 0x62, 0xff] },
    { name: 'pmulhw mm4, mm7', bytes: [0x0f, 0xe5, 0xe7] },
    { name: 'pmullw mm1, mm7', bytes: [0x0f, 0xd5, 0xcf] },
    { name: 'pmaddwd mm3, mm1', bytes: [0x0f, 0xf5, 0xd9] },
    { name: 'psadbw mm2, mm4', bytes: [0x0f, 0xf6, 0xd4] },
    { name: 'pavgb mm1, mm2', bytes: [0x0f, 0xe0, 0xca] },
    { name: 'pshufw mm0, mm1, 0x1b', bytes: [0x0f, 0x70, 0xc1, 0x1b] },
    { name: 'psraw mm7, 7', bytes: [0x0f, 0x71, 0xe7, 0x07] },
    { name: 'psllq mm3, 0x10', bytes: [0x0f, 0x73, 0xf3, 0x10] },
    { name: 'packsswb mm0, mm1', bytes: [0x0f, 0x63, 0xc1] },
    { name: 'packuswb mm2, mm3', bytes: [0x0f, 0x67, 0xd3] },
    { name: 'pmovmskb ecx, mm2', bytes: [0x0f, 0xd7, 0xca] },
    { name: 'pextrw ecx, mm0, 2', bytes: [0x0f, 0xc5, 0xc8, 0x02] },
    { name: 'pinsrw mm5, eax, 1', bytes: [0x0f, 0xc4, 0xe8, 0x01] },
    { name: 'movd [out], mm0', bytes: absolute([0x0f, 0x7e], 0, OUT) },
    { name: 'movq [out], mm0', bytes: absolute([0x0f, 0x7f], 0, OUT) },
    { name: 'movq [out+8], mm1', bytes: absolute([0x0f, 0x7f], 1, OUT + 8) },
    { name: 'movntq [out], mm2', bytes: absolute([0x0f, 0xe7], 2, OUT) },
    { name: 'mov ebx, 0x7fff8001', bytes: [0xbb, 0x01, 0x80, 0xff, 0x7f] },
    { name: 'add ebx, eax', bytes: [0x01, 0xc3] },
    { name: 'fld1', bytes: [0xd9, 0xe8] },
    { name: 'emms', bytes: [0x0f, 0x77] },
];

/** The data: words near both signed bounds and a ramp. */
const DATA_BYTES = Uint8Array.from({ length: DATA_SIZE }, (_, i)=>
    (i >= 0x40 ? [0xff, 0x7f, 0x01, 0x80, 0x00, 0x80, 0xfe, 0x7f][i & 7] : i * 37 + 11) & 0xff);

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

/** A RAM with the program and the data in it. @param {Uint8Array} program */
function ramWith(program){
    const ram = new Uint8Array(MEMORY);
    ram.set(program, CODE);
    ram.set(DATA_BYTES, DATA);
    return ram;
}

/** Runs a 64-bit program to its `hlt`. @param {Uint8Array} ram @param {ReturnType<typeof createState64>} state */
function run64(ram, state){
    for (let steps = 0; ram[Number(state.rip)] !== HALT && steps < 100; steps++)
    {
        evaluate64(/** @type {import('./decode/decoder.js').Instruction} */ (
            decode(at=>ram[at], Number(state.rip), MODE_64)), state);
    }
}

/**
 * Runs the program to its `hlt` on the 32-bit model, then on the 64-bit one,
 * and answers both ends.
 *
 * @param {Uint8Array} program
 */
function both(program){
    const ram32 = ramWith(program);
    const narrow = createState(memory32(ram32), { eip: CODE, esp: 0x180000 });
    narrow.reg[0] = 0x0f3a9c11;
    narrow.reg[3] = 0x25;
    narrow.reg[1] = 0x77;
    const ram64 = ramWith(program);
    const wide = createState64(/** @type {any} */ (memory64(ram64)),
        { rip: BigInt(CODE), rsp: 0x180000n });
    wide.r[0] = 0x0f3a9c11n;
    wide.r[3] = 0x25n;
    wide.r[1] = 0x77n;
    for (let steps = 0; ram32[narrow.eip] !== HALT && steps < 100; steps++)
    {
        evaluate(/** @type {import('./decode/decoder.js').Instruction} */ (
            decode(at=>ram32[at], narrow.eip)), narrow);
    }
    run64(ram64, wide);
    const unit = /** @type {NonNullable<typeof wide.x87>} */ (wide.x87);
    const end32 = { top: narrow.top, empty: narrow.empty, mm: [...narrow.f80bits],
        exact: narrow.x87Exact, eax: narrow.reg[0], ebx: narrow.reg[3], ecx: narrow.reg[1],
        data: [...ram32.subarray(DATA, DATA + DATA_SIZE)] };
    const end64 = { top: unit.top, empty: unit.empty, mm: [...unit.f80bits],
        exact: unit.x87Exact, eax: Number(wide.r[0] & 0xffffffffn),
        ebx: Number(wide.r[3] & 0xffffffffn), ecx: Number(wide.r[1] & 0xffffffffn),
        data: [...ram64.subarray(DATA, DATA + DATA_SIZE)] };
    return { end32, end64, upper: [0, 1, 3].map(reg=>wide.r[reg] >> 32n) };
}

test('MMX sequences run at 64 bits as the 32-bit model runs them', ()=>{
    const next = random(0x3d64);
    for (let i = 0; i < SEQUENCES; i++)
    {
        const length = 2 + Math.floor(next() * 11);
        const indices = Array.from({ length }, ()=>Math.floor(next() * POOL.length));
        const program = Uint8Array.from([...indices.flatMap(index=>POOL[index].bytes), HALT]);
        const { end32, end64, upper } = both(program);
        const names = indices.map(index=>POOL[index].name).join('; ');
        assert.deepEqual(end64, end32, `#${i}: ${names}`);
        assert.deepEqual(upper, [0n, 0n, 0n], `#${i}: ${names}`);
    }
});

test('a quadword moves between an MMX register and a general one or memory whole', ()=>{
    const program = Uint8Array.from([
        0x49, 0x0f, 0x6e, 0xc1, // movq mm0, r9
        0x48, 0x0f, 0x7e, 0xc2, // movq rdx, mm0
        0x41, 0x0f, 0x6f, 0x0c, 0x00, // movq mm1, [r8+rax]
        0x4c, 0x0f, 0x7e, 0xcb, // movq rbx, mm1
        0x4c, 0x0f, 0x7e, 0x0c, 0x24, // movq [rsp], mm1
        0x0f, 0x7e, 0xc6, // movd esi, mm0
        HALT,
    ]);
    const ram = ramWith(program);
    const state = createState64(/** @type {any} */ (memory64(ram)),
        { rip: BigInt(CODE), rsp: 0x180000n });
    state.r[9] = 0xfff8_0000_1234_5678n;
    state.r[8] = BigInt(DATA);
    state.r[0] = 0x40n;
    state.r[6] = 0xffff_ffff_ffff_ffffn;
    run64(ram, state);
    const fromData = new DataView(DATA_BYTES.buffer).getBigUint64(0x40, true);
    assert.equal(state.r[2], 0xfff8_0000_1234_5678n);
    assert.equal(state.r[3], fromData);
    assert.equal(new DataView(ram.buffer).getBigUint64(0x180000, true), fromData);
    assert.equal(state.r[6], 0x1234_5678n);
    const unit = /** @type {NonNullable<typeof state.x87>} */ (state.x87);
    assert.equal(unit.top, 0);
    assert.equal(unit.empty, 0);
});

test('a long-mode block keeps an MMX register as the quadword written', async()=>{
    // movq mm3, r9 and back into rax: the bits cross the block as they are,
    // a signalling NaN's pattern included.
    const { ownLayout, pagesFor, tablesSize } = await import('./runtime/layout.js');
    const { blockState64, interpret64 } = await import('./interp64.js');
    const layout = ownLayout({ ramSize: MEMORY, ramBase: 0, bits: 64 });
    const memory = new WebAssembly.Memory({ initial: pagesFor(layout, tablesSize(layout)) });
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    bytes.set([0x49, 0x0f, 0x6e, 0xd9, 0x48, 0x0f, 0x7e, 0xd8, HALT], CODE);
    view.setUint16(layout.x87Control, 0x37f, true);
    bytes[layout.x87Empty] = 0xff;
    view.setBigUint64(layout.eip, BigInt(CODE), true);
    const pattern = 0x7ff0_0000_0000_0001n;
    view.setBigUint64(layout.regs + 9 * 8, pattern, true);
    const state = blockState64({ memory, layout });
    interpret64(state, 1);
    state.syncOut();
    interpret64(state, 1);
    state.syncOut();
    assert.equal(view.getBigUint64(layout.regs, true), pattern);
    assert.equal(view.getBigUint64(layout.x87 + 3 * 16, true), pattern);
    assert.equal(bytes[layout.x87Empty], 0);
});
