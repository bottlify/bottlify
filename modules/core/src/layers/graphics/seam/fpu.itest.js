/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCorkHost } from '../../cpu/internal/cork-host.js';
import * as cork from '../../../../../cork/src/index.js';
import { fpuSetupCode } from './fpu.js';

const PROGRAM = 0x8000;
const ROUTINE = 0x8800;
const TRAP = 0x8e00;
const WORD = 0x9000;
const STACK = 0x300000;

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

test('CreateDevice\'s slot sets the thread\'s x87 as Direct3D does, unless FPU_PRESERVE, and'
    + ' reaches its trap with the call as it came', ()=>{
    const host = createCorkHost({
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: STACK, engine: cork, cork: {},
    });
    host.writePhysical(ROUTINE, fpuSetupCode(ROUTINE, TRAP));
    // At the trap: the control word stored, and a stop.
    host.writePhysical(TRAP, Uint8Array.of(0xd9, 0x3d, ...u32(WORD), 0xf4));
    host.writePhysical(0x7000, new Uint8Array(u32(PROGRAM)));

    /**
     * The control word at the trap, after a call made under `control` with
     * these behaviour flags, and ESP there.
     *
     * @param {number} control @param {number} flags
     */
    const run = (control, flags)=>{
        host.writePhysical(WORD, Uint8Array.of(control & 0xff, control >>> 8));
        // fldcw [WORD]; push the six arguments, last first, and `this`; call the slot.
        const code = [0xd9, 0x2d, ...u32(WORD)];
        for (const value of [0, 1, 0x1234, flags, 0x5555, 0x7777].reverse())
        {
            code.push(0x68, ...u32(value));
        }
        code.push(0x68, ...u32(0x6666));
        code.push(0xe8, ...u32((ROUTINE - (PROGRAM + code.length + 5)) | 0));
        host.writePhysical(PROGRAM, Uint8Array.from(code));
        host.writeReg32('eip', PROGRAM);
        host.writeReg32('esp', STACK);
        host.runSlice(1000);
        const word = host.readPhysical(WORD, 2);
        const esp = host.readReg32('esp');
        const at = host.readPhysical(esp + 20, 4);
        return { control: word[0] | word[1] << 8, esp,
            flags: (at[0] | at[1] << 8 | at[2] << 16 | at[3] << 24) >>> 0 };
    };

    // Exceptions unmasked, double precision, rounding down: single, nearest, all masked.
    const set = run(0x0760 | 0x1000, 0x40);
    assert.equal(set.control, 0x107f);
    assert.equal(set.esp, STACK - 7 * 4 - 4, 'the trap finds the call\'s return and arguments');
    assert.equal(set.flags, 0x40, 'the flags where the handler reads them');
    assert.equal(run(0x027f, 0x20).control, 0x007f, 'the default word: single precision');
    assert.equal(run(0x0760, 0x42).control, 0x0760, 'FPU_PRESERVE keeps the program\'s word');
});
