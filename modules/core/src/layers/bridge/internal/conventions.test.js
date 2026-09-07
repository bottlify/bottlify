/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Convention, calleeCleanup, readArguments } from './conventions.js';

/**
 * A stack with a known return address at ESP and ascending arguments above it,
 * so an argument read from the wrong place is obvious in the failure.
 *
 * @param {number} esp
 * @param {number[]} values
 */
function stack(esp, values){
    /** @type {Map<number, number>} */
    const cells = new Map([[esp, 0xdeadbeef]]);
    values.forEach((value, index)=>cells.set(esp + 4 + index * 4, value));
    return {
        esp,
        ecx: 0,
        /** @param {number} address */
        read32: address=>{
            const value = cells.get(address);
            if (value === undefined)
            {
                throw new Error(`read outside the frame at ${address.toString(16)}`);
            }
            return value;
        },
    };
}

test('who pops the arguments is not how many there are', ()=>{
    // The two numbers coincide for stdcall, which is exactly why they get
    // conflated -- and why a cdecl import with arguments is where it shows.
    assert.equal(calleeCleanup(Convention.STDCALL, 12), 12);
    assert.equal(calleeCleanup(Convention.CDECL, 12), 0);

    // `this` came in ECX and was never pushed, so the callee cannot pop it.
    assert.equal(calleeCleanup(Convention.THISCALL, 12), 8);
});

test('a convention nobody defined is a configuration error, not a default', ()=>{
    assert.throws(()=>calleeCleanup('pascal', 4), /Unknown calling convention/);
    assert.throws(()=>calleeCleanup(Convention.STDCALL, 6), /multiple of 4/);
    assert.throws(()=>calleeCleanup(Convention.STDCALL, -4), /non-negative/);
    assert.throws(()=>calleeCleanup(Convention.THISCALL, 0), /at least `this`/);
});

test('stack arguments are read from just above the return address', ()=>{
    const frame = stack(0x3000, [11, 22, 33]);

    assert.deepEqual(readArguments(Convention.STDCALL, 12, frame), [11, 22, 33]);
    assert.deepEqual(readArguments(Convention.CDECL, 12, frame), [11, 22, 33],
        'where the arguments are does not depend on who cleans up');
    assert.deepEqual(readArguments(Convention.STDCALL, 0, frame), []);
});

test('thiscall takes `this` from ECX and the rest from the stack', ()=>{
    const frame = { ...stack(0x3000, [22, 33]), ecx: 0x401000 };

    assert.deepEqual(readArguments(Convention.THISCALL, 12, frame), [0x401000, 22, 33],
        '`this` comes first in declaration order even though it never was on the stack');
});

test('arguments arrive signed, as the guest pushed them', ()=>{
    // Guest code pushes 32-bit words; a handler that wants an unsigned value
    // says so itself. Silently widening here would make -1 and 0xffffffff
    // different values to a handler that compares against one of them.
    const frame = stack(0x3000, [0xffffffff]);
    assert.deepEqual(readArguments(Convention.STDCALL, 4, frame), [-1]);
});
