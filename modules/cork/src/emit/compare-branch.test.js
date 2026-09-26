/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A float compare (`fcomi`, `comiss`) whose flags only the branch after it
 * reads is that branch: the flags are never made. Every condition, over
 * ordered and unordered operands, against what the processor's flags give --
 * fused where both ways on write the flags before anything reads them, and
 * made as before where one way reads them.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestMachine } from '../testing/machine.js';
import { features } from '../wasm/features.js';

const CODE = 0x1000;
const DATA = 0x2000;
const at = (/** @type {number} */ address)=>[address & 0xff, address >> 8 & 0xff, 0, 0];

/** CF ZF PF as `fcomi a, c` and `comiss a, c` set them; OF SF AF clear. */
function flagsOf(/** @type {number} */ a, /** @type {number} */ c){
    const unordered = Number.isNaN(a) || Number.isNaN(c);
    return { cf: unordered || a < c, zf: unordered || a === c, pf: unordered };
}

/** Whether condition `cc` holds over those flags. */
function holds(/** @type {number} */ cc, /** @type {{ cf: boolean, zf: boolean, pf: boolean }} */ f){
    const base = [false, f.cf, f.zf, f.cf || f.zf, false, f.pf, false, f.zf][cc >> 1];
    return (cc & 1) === 1 ? !base : base;
}

const PAIRS = [[1, 2], [2, 1], [1.5, 1.5], [NaN, 1], [1, NaN], [-0, 0]];

/**
 * Runs `compare` over a (at DATA) and c (at DATA+4), then `jcc` to a block
 * that sets ecx to 1, the fall-through setting it to 0. `after` is what both
 * ways do next: an `add ecx, 0` writes every flag before the halt reads
 * them, so the compare is the branch; an `adc` reads CF, so the flags are
 * made.
 *
 * @param {number[]} compare @param {number} cc @param {number[]} values
 * @param {boolean} readAfter
 */
function run(compare, cc, values, readAfter){
    const m = createTestMachine();
    const view = new DataView(m.memory.buffer);
    values.forEach((value, i)=>view.setFloat32(m.layout.ramBase + DATA + i * 4, value, true));
    const tail = readAfter ? [0x83, 0xd1, 0x00] : [0x83, 0xc1, 0x00]; // adc / add ecx, 0
    const way = [0xb9, 0, 0, 0, 0, ...tail];      // mov ecx, 0|1; then the tail
    const code = [...compare, 0x70 | cc, way.length + 2,
        ...way, 0xeb, way.length,                  // jmp over the taken way
        0xb9, 1, 0, 0, 0, ...tail, 0xf4];
    m.write(CODE, code);
    m.setReg('esp', 0x80000);
    m.setEflags(2);
    const exit = m.runProgram(CODE);
    assert.equal(exit.kind, 3);
    return { ecx: m.reg('ecx'), fused: m.translate(CODE).translation.fusedCompares };
}

/** fld dword [DATA+4]; fld dword [DATA]; fcomip st1; fstp st0 */
const FCOMIP = [0xd9, 0x05, ...at(DATA + 4), 0xd9, 0x05, ...at(DATA), 0xdf, 0xf1, 0xdd, 0xd8];
/** movss xmm0, [DATA]; movss xmm1, [DATA+4]; comiss xmm0, xmm1 */
const COMISS = [0xf3, 0x0f, 0x10, 0x05, ...at(DATA), 0xf3, 0x0f, 0x10, 0x0d, ...at(DATA + 4),
    0x0f, 0x2f, 0xc1];

for (const [name, compare] of /** @type {[string, number[]][]} */ ([
    ['fcomip', FCOMIP], ['comiss', COMISS]]))
{
    test(`${name} and every condition after it, fused and made`, {
        skip: name === 'comiss' && !features().simd && 'no simd',
    }, ()=>{
        for (let cc = 0; cc < 16; cc++)
        {
            for (const [a, c] of PAIRS)
            {
                const expected = holds(cc, flagsOf(a, c)) ? 1 : 0;
                const fused = run(compare, cc, [a, c], false);
                assert.equal(fused.fused, 1, `${name} j${cc.toString(16)}: fused`);
                assert.equal(fused.ecx, expected, `${name} ${a} ${c} j${cc.toString(16)}`);
                const made = run(compare, cc, [a, c], true);
                assert.equal(made.fused, 0, 'the flags are read after: made');
                // adc ecx, 0 adds CF: the flags the compare made, where the
                // branch did not change them.
                assert.equal(made.ecx, expected + (flagsOf(a, c).cf ? 1 : 0),
                    `${name} ${a} ${c} j${cc.toString(16)} with the flags read after`);
            }
        }
    });
}
