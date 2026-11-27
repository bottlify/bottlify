/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The SSE2 entries of a 32-bit universal runtime that are code in the guest
 * (`xmmEntry`), as a gate: each called by a program on the real processor,
 * argument in XMM0, must leave XMM0, errno, the stack and the registers a
 * callee keeps as the entry's handler leaves them for the same call -- where
 * the code answers itself and where it hands the call to its trap. A
 * hundred and more calls in a row on one machine: an x87 slot the code left
 * filled would overflow the stack and turn the answers after it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import { runToHalt } from '../../cpu/internal/halt.fixture.js';
import * as cork from '../../../../../cork/src/index.js';
import { createUcrtMathFunctions } from './ucrt-math.js';
import { guestThrough } from './guest-window.fixture.js';

const PROGRAM = 0x8000;
const TRAPS = 0x8f00;
const CODE = 0x10000;
const STACK = 0x300000;
const KEPT = /** @type {const} */ (['ebx', 'esi', 'edi', 'ebp']);

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const bits = new DataView(new ArrayBuffer(8));
/** @param {number} value @returns {Uint32Array} */
const xmmOf = value=>{
    bits.setFloat64(0, value, true);
    return Uint32Array.of(bits.getUint32(0, true), bits.getUint32(4, true), 0, 0);
};
/** @param {Uint32Array} words */
const lowWords = words=>[words[0], words[1]];

/** @param {number} seed */
function inputs(seed){
    let state = seed >>> 0 || 1;
    const next = ()=>{
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return state >>> 0;
    };
    const values = [0, -0, 1, -1, Math.PI, -Math.PI / 2, 1e-310, 1e10, 1e18, 2 ** 62 * 1.9,
        2 ** 63, -(2 ** 63), 1e300, Infinity, -Infinity, NaN];
    while (values.length < 160)
    {
        values.push(values.length % 2 === 0 ? (next() - 2 ** 31) / 2 ** (next() % 40)
            : (next() / 2 ** 32 - 0.5) * 2 ** (next() % 80));
    }
    return values;
}

test('sin and cos in the guest answer XMM0 and errno as their SSE2 handlers', ()=>{
    const machine = createCorkHost({
        memorySize: 16 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: { sliceMs: Infinity },
    });
    machine.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));
    /** @param {number} at */
    const readU32 = at=>new DataView(machine.readPhysical(at, 4).slice().buffer).getUint32(0, true);
    /** @type {number[]} */
    const errnos = [];
    const fns = createUcrtMathFunctions({
        fpu: /** @type {any} */ (machine).fpu(),
        errno: code=>errnos.push(code),
        guest: guestThrough((at, length)=>machine.readPhysical(at, length).slice(),
            (at, bytes)=>machine.writePhysical(at, bytes)),
        readXmm: index=>/** @type {any} */ (machine).readXmm(index),
        writeXmm: (index, words)=>/** @type {any} */ (machine).writeXmm(index, words),
    });

    let handed = 0;
    let inGuest = 0;
    for (const name of ['_libm_sse2_sin_precise', '_libm_sse2_cos_precise', '__libm_sse2_sin',
        '__libm_sse2_cos'])
    {
        const entry = fns[name];
        /** @type {Map<number, (args: number[]) => number>} */
        const traps = new Map();
        /** @type {[number, number][]} */
        const jumps = [];
        const bytes = entry.code({
            register: (/** @type {{ handler: (args: number[]) => number }} */ trap)=>{
                const at = TRAPS + 16 * traps.size;
                traps.set(at, trap.handler);
                machine.writePhysical(at, Uint8Array.of(0xf4));
                return at;
            },
            jump: (/** @type {number} */ at, /** @type {number} */ target)=>jumps.push([at, target]),
        });
        for (const [at, target] of jumps)
        {
            new DataView(bytes.buffer).setUint32(at, (target - (CODE + at + 4)) >>> 0, true);
        }
        machine.writePhysical(CODE, bytes);
        const call = [0xe8, ...u32((CODE - (PROGRAM + 5)) | 0), 0xf4];
        machine.writePhysical(PROGRAM, new Uint8Array(call));

        for (const [i, x] of inputs(name.length).entries())
        {
            const label = `${name}(${x})`;
            const kept = Object.fromEntries(KEPT.map((reg, k)=>[reg, 0x1010101 * (k + 1) + i]));
            for (const [reg, value] of Object.entries(kept))
            {
                machine.writeReg32(reg, value);
            }
            /** @type {any} */ (machine).writeXmm(0, xmmOf(x));
            machine.writeReg32('eip', PROGRAM);
            machine.writeReg32('esp', STACK);
            errnos.length = 0;
            runToHalt(machine, 100000);
            const stopped = machine.readReg32('eip') - 1;
            const trap = traps.get(stopped);
            if (trap)
            {
                // The cdecl form's handler, given its frame: the double the
                // head stored, past the return into the head.
                const esp = machine.readReg32('esp');
                trap([readU32(esp + 4), readU32(esp + 8)]);
                machine.writeReg32('esp', esp + 4);
                machine.writeReg32('eip', readU32(esp));
                runToHalt(machine, 100000);
                handed++;
            }
            else
            {
                inGuest++;
            }
            assert.equal(machine.readReg32('eip'), PROGRAM + call.length, `${label}: returned`);
            assert.equal(machine.readReg32('esp'), STACK, `${label}: the stack as it was`);
            for (const [reg, value] of Object.entries(kept))
            {
                assert.equal(machine.readReg32(reg) >>> 0, value >>> 0, `${label}: ${reg} kept`);
            }
            const answered = lowWords(/** @type {any} */ (machine).readXmm(0));
            const errno = [...errnos];

            // The handler, from the same call.
            /** @type {any} */ (machine).writeXmm(0, xmmOf(x));
            errnos.length = 0;
            entry.handler([]);
            assert.deepEqual(answered, lowWords(/** @type {any} */ (machine).readXmm(0)),
                `${label}: XMM0`);
            assert.deepEqual(errno, errnos, `${label}: errno`);
        }
    }
    assert.ok(inGuest >= 400 && handed >= 16,
        `both ways taken: ${inGuest} in the guest, ${handed} handed to the host`);
});
