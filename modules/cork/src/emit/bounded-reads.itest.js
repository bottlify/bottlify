/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of a read whose registers its block bounded (`boundedRead`), its
 * address taken without the wrap into RAM: seeded blocks of writes that bound a
 * register (a zero extension, an `and`, a shift right, a constant, a copy, a
 * low byte written over), writes that do not (arithmetic, a multiply, a `lea`,
 * a word written), and reads through those registers at displacements up to and
 * past RAM's end, run translated and on the model. The model reads as an
 * untested read does (`wrapIntoRam`): an address past RAM wraps into it. A read
 * the bounds let through wrongly reaches past RAM, into cork's tables or out of
 * the memory, and differs; one the bounds let through rightly reads RAM.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { decode } from '../decode/decoder.js';
import { createState, evaluate } from '../ir.js';
import { random } from '../testing/sequences.js';

const CODE = 0x1000;
const OUT = 0x8000;
const STACK = 0x80000;
const RAM = 1 << 20;
const NAMES = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24];

/**
 * A block of `seed`: eax, ebx and edx set to random values, then writes and
 * reads drawn at random, each read's value added into esi and stored at OUT.
 * The generator follows the bounds the writes give as the rule has them, and
 * puts most reads' displacements a few bytes either side of where their reach
 * meets RAM's end, none below 64 KiB: one the rule lets through a byte too far, or after a write
 * it should not have trusted, reads past RAM. Each read goes through registers
 * of its own, so no two share a wrapped sum (`wrappedFirst`), and a dword's index
 * is scaled by four off no base, its displacement a multiple of four, so a read
 * wrapped into RAM never runs past its end.
 *
 * @param {number} seed
 * @returns {number[]}
 */
function program(seed){
    const draw = random(seed);
    const next = ()=>Math.floor(draw() * 4294967296);
    const pick = (/** @type {number} */ n)=>next() % n;
    /** eax, edx, ebx by their encodings. */
    const regs = [0, 2, 3];
    const reg = ()=>regs[pick(3)];
    /** The bound the rule gives each register, -1 for none, by encoding. */
    const bound = new Array(8).fill(-1);
    /** The registers' keys the reads went through. */
    const used = new Set();
    /** A displacement at the edge of `reach`, or anywhere, a multiple of `align`. */
    const edge = (/** @type {number} */ reach, /** @type {number} */ align)=>{
        const mode = reach >= 0 ? pick(4) : 3;
        // At its edge, a few bytes either side; or past it, within the reach,
        // where a bound taken smaller than the rule's lets a read through that
        // a value at its bound carries past RAM; or anywhere.
        const at = (mode < 2 ? RAM - reach + (mode === 0 ? pick(3) - 1 : pick(17) - 8) : mode === 2
            ? RAM - reach + 1 + pick(Math.max(1, Math.min(reach, 0x100000)))
            : pick(2) === 0 ? next() : RAM - pick(0x100000)) >>> 0;
        // None below 64 KiB, where a read may take its registers' wrapped sum
        // (`wrappedFirst`), which near RAM's end is not the address wrapped whole.
        return (at < 0x10000 ? at + 0x10000 : at) & ~(align - 1);
    };
    const code = [];
    // Mostly all ones, so a bounded value often stands at its bound.
    for (const r of regs)
    {
        code.push(0xb8 + r, ...u32(pick(3) !== 0 ? 0xffffffff : pick(2) === 0 ? next()
            : pick(0x400)));
    }
    code.push(0x31, 0xf6);                                              // xor esi, esi
    const count = 6 + pick(24);
    for (let k = 0; k < count; k++)
    {
        const r = reg();
        const other = reg();
        const imm = pick(2) === 0 ? 2 ** (1 + pick(20)) - 1 : pick(2) === 0 ? pick(0x10000)
            : next();
        const known = (/** @type {number} */ one)=>(one < 0 ? 0xffffffff : one);
        switch (pick(16))
        {
            case 0: code.push(0x0f, 0xb6, 0xc0 | r << 3 | other); bound[r] = 0xff; break;
            case 1: code.push(0x0f, 0xb7, 0xc0 | r << 3 | other); bound[r] = 0xffff; break;
            case 2:                                                     // and r, imm
                code.push(0x81, 0xe0 | r, ...u32(imm));
                bound[r] = Math.min(known(bound[r]), imm);
                bound[r] = bound[r] === 0xffffffff ? -1 : bound[r];
                break;
            case 3:                                                     // shr r, imm
            {
                const by = pick(32);
                code.push(0xc1, 0xe8 | r, by);
                bound[r] = Math.floor(known(bound[r]) / 2 ** by);
                break;
            }
            case 4: code.push(0xb8 + r, ...u32(imm)); bound[r] = imm; break;
            case 5: code.push(0x31, 0xc0 | r << 3 | r); bound[r] = 0; break;    // xor r, r
            case 6: code.push(0x89, 0xc0 | other << 3 | r); bound[r] = bound[other]; break;
            case 7:                                                     // mov r8, other8
                code.push(0x88, 0xc0 | other << 3 | r);
                bound[r] = bound[r] < 0 ? -1 : (bound[r] | 0xff) >>> 0;
                break;
            case 8: code.push(0x66, 0x89, 0xc0 | other << 3 | r); bound[r] = -1; break;
            case 9: code.push(0x01, 0xc0 | other << 3 | r); bound[r] = -1; break; // add r, o
            case 10:                                                    // lea r, [o+o+d]
                code.push(0x8d, 0x44 | r << 3, 0x00 | other << 3 | other, pick(128));
                bound[r] = -1;
                break;
            case 11: code.push(0x0f, 0xaf, 0xc0 | r << 3 | other); bound[r] = -1; break;
            case 12: code.push(0x88, 0xc0 | other << 3 | 4 + r); bound[r] = -1; break;
            default:
            {
                const scale = pick(4);
                const dword = pick(2) === 0;
                const key = dword ? `${r}` : `${r}.${other}.${scale}`;
                if (used.has(key))
                {
                    break;
                }
                used.add(key);
                if (dword)
                {
                    // mov ecx, [disp + r*4]
                    const reach = bound[r] < 0 ? -1 : bound[r] * 4 + 4;
                    code.push(0x8b, 0x0c, 0x85 | r << 3, ...u32(edge(reach, 4)));
                }
                else
                {
                    // movzx ecx, byte [other + r*s + disp]
                    const reach = bound[r] < 0 || bound[other] < 0 ? -1
                        : bound[other] + bound[r] * 2 ** scale + 1;
                    code.push(0x0f, 0xb6, 0x8c, scale << 6 | r << 3 | other,
                        ...u32(edge(reach, 1)));
                }
                code.push(0x01, 0xce);                                 // add esi, ecx
                bound[1] = -1;
                break;
            }
        }
    }
    code.push(0x89, 0x35, ...u32(OUT));                                  // mov [OUT], esi
    code.push(0xf4);
    return code;
}

/** A RAM of the bytes the reads find: each byte its address's own mix, none zero at RAM's start as cork's zeroed tables past its end are. */
function fill(){
    const ram = new Uint8Array(RAM);
    for (let i = 0; i < RAM; i++)
    {
        ram[i] = (i * 2654435761 >>> 24) ^ i ^ 0x5a;
    }
    return ram;
}

test('a read its block bounded goes unwrapped only where it stays in RAM: seeded blocks,'
    + ' translated against the model', ()=>{
    const memory = fill();
    for (let seed = 1; seed <= 1500; seed++)
    {
        const code = program(seed);
        const m = createTestMachine({ precise: false });
        m.write(0, memory);
        m.write(CODE, code);
        m.setReg('esp', STACK);
        m.setEflags(2);
        const exit = m.runProgram(CODE);
        const ram = memory.slice();
        ram.set(code, CODE);
        const view = new DataView(ram.buffer);
        const state = createState({
            read: (address, size)=>{
                const at = address & RAM - 1;
                return size === 1 ? ram[at] : size === 2 ? view.getUint16(at, true)
                    : view.getUint32(at, true);
            },
            write: (address, size, value)=>{
                assert.equal(size, 4, 'the program stores dwords only');
                view.setUint32(address, value, true);
            },
        }, { eip: CODE, esp: STACK, fsBase: 0 });
        state.eflags = 2;
        while (!state.halted && state.retired < 10000)
        {
            const decoded = decode(address=>ram[address], state.eip);
            if ('refused' in decoded)
            {
                break;
            }
            evaluate(decoded, state);
        }
        const what = `seed ${seed}`;
        assert.equal(exit.kind, 3, `${what}: halted`);
        for (let r = 0; r < 8; r++)
        {
            assert.equal(m.reg(NAMES[r]), state.reg[r], `${what}: ${NAMES[r]}`);
        }
        assert.equal(m.readU32(OUT), view.getUint32(OUT, true), `${what}: the sum stored`);
    }
});
