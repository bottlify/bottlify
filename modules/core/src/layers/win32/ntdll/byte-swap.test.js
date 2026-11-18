/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BYTE_SWAP_CODE, createByteSwapFunctions } from './byte-swap.js';
import { runCode } from '../../../../scripts/guest-code/equivalence.mjs';

test('the fastcall swaps read ECX and pop nothing; the long long one pops its eight bytes', ()=>{
    const short = runCode(BYTE_SWAP_CODE.RtlUshortByteSwap, { registers: { ecx: 0xdead1234 } });
    assert.ok(short.halted);
    assert.equal(short.eax, 0x3412, 'the high half of ECX is not the value');
    assert.equal(short.popped, 0);
    const long = runCode(BYTE_SWAP_CODE.RtlUlongByteSwap, { registers: { ecx: 0x87654321 } });
    assert.equal(long.eax, 0x21436587);
    assert.equal(long.popped, 0);
    const longLong = runCode(BYTE_SWAP_CODE.RtlUlonglongByteSwap,
        { stack: [0x87654321, 0x76543210] });
    assert.equal(longLong.popped, 8);
    assert.equal(longLong.eax >>> 0, 0x10325476, 'the low half: the swapped high word');
    assert.equal(longLong.edx >>> 0, 0x21436587);
});

test('the long long handler is the code\'s swap', ()=>{
    /** @type {Record<string, number>} */
    const registers = {};
    const fns = createByteSwapFunctions({ setRegisters: values=>Object.assign(registers, values) });
    assert.equal(fns.RtlUlonglongByteSwap.handler([0x87654321, 0x76543210]), 0x10325476);
    assert.equal(registers.edx, 0x21436587);
    assert.throws(()=>fns.RtlUlongByteSwap.handler(), /ECX/);
});
