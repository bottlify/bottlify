/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemFunctions } from './system.js';
import { createQueryFunctions } from '../ntdll/query.js';
import { TEB } from './teb.js';

test('a thread\'s error mode is its own, in its block, read alike by kernel32 and ntdll', ()=>{
    // Wine's kernel32 thread.c test_ThreadErrorMode.
    const bytes = new Uint8Array(0x3000);
    /** @type {number[]} */
    const errors = [];
    const memory = {
        readMemory: (/** @type {number} */ at, /** @type {number} */ length)=>
            bytes.subarray(at, at + length),
        writeMemory: (/** @type {number} */ at, /** @type {Uint8Array} */ data)=>
            bytes.set(data, at),
    };
    const thread = { tebAddress: 0x1000 };
    const kernel32 = createSystemFunctions(/** @type {any} */ ({ ...memory,
        setLastError: (/** @type {number} */ code)=>errors.push(code), currentThread: ()=>thread,
        resolveHandle: ()=>null, systemTimeMs: ()=>0 }));
    const ntdll = createQueryFunctions(/** @type {any} */ ({ ...memory, teb: ()=>0x1000,
        arena: { base: 0, size: 0 } }));
    const view = new DataView(bytes.buffer);

    assert.equal(kernel32.SetThreadErrorMode.handler([0, 0x200]), 1);
    assert.equal(view.getUint32(0x200, true), 0);
    assert.equal(kernel32.SetThreadErrorMode.handler([1, 0x200]), 1, 'SEM_FAILCRITICALERRORS');
    assert.equal(view.getUint32(0x200, true), 0, 'the mode before');
    assert.equal(kernel32.GetThreadErrorMode.handler(), 1);
    assert.equal(ntdll.RtlGetThreadErrorMode.handler(), 0x10);
    assert.equal(view.getUint32(0x1000 + TEB.HARD_ERROR_MODE, true), 0x10, 'kept in the block');
    kernel32.SetThreadErrorMode.handler([2, 0x200]);
    assert.equal(view.getUint32(0x200, true), 1);
    assert.equal(ntdll.RtlGetThreadErrorMode.handler(), 0x20);
    kernel32.SetThreadErrorMode.handler([0x8000, 0]);
    assert.equal(ntdll.RtlGetThreadErrorMode.handler(), 0x40);

    for (let mode = 1; mode !== 0; mode = (mode << 1) >>> 0)
    {
        const ok = kernel32.SetThreadErrorMode.handler([mode, 0]);
        assert.equal(ok, [1, 2, 0x8000].includes(mode) ? 1 : 0, `0x${mode.toString(16)}`);
    }
    assert.ok(errors.length === 29 && errors.every(code=>code === 87));
    assert.equal(ntdll.RtlSetThreadErrorMode.handler([0x80, 0]), 0xc00000ef);
    assert.equal(ntdll.RtlSetThreadErrorMode.handler([0x30, 0x204]), 0);
    assert.equal(kernel32.GetThreadErrorMode.handler(), 3);
});
