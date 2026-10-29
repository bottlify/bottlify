/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryFunctions } from './memory.js';

const SELF = 0xffffffff;
const STATUS_ACCESS_VIOLATION = 0xc0000005;
const STATUS_INVALID_HANDLE = 0xc0000008;
const STATUS_INVALID_INFO_CLASS = 0xc0000003;
const STATUS_INFO_LENGTH_MISMATCH = 0xc0000004;
const STATUS_CONFLICTING_ADDRESSES = 0xc0000018;
const STATUS_PARTIAL_COPY = 0x8000000d;

/**
 * kernel32's calls as recorders answering what each test says, over a small
 * memory the pointers point into.
 *
 * @param {Record<string, any>} [answers]  what each call answers, by name
 * @param {number} [lastError]
 * @param {Record<string, any>} [more]  further host members
 */
function setup(answers = {}, lastError = 0, more = {}){
    const memory = new Uint8Array(0x2000);
    const view = new DataView(memory.buffer);
    /** @type {{ name: string, args: number[] }[]} */
    const calls = [];
    /** @param {string} name @param {any} fallback */
    const recorder = (name, fallback)=>({
        argBytes: 0,
        handler: (/** @type {number[]} */ args)=>{
            calls.push({ name, args });
            const answer = answers[name] ?? fallback;
            return typeof answer === 'function' ? answer(args) : answer;
        },
    });
    const fns = createMemoryFunctions({
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        allocate: ()=>0x1800,
        kernel32: {
            VirtualAllocEx: recorder('VirtualAllocEx', 0x10000),
            VirtualFreeEx: recorder('VirtualFreeEx', 1),
            VirtualProtectEx: recorder('VirtualProtectEx', 1),
            VirtualQueryEx: recorder('VirtualQueryEx', 28),
            ReadProcessMemory: recorder('ReadProcessMemory', 1),
            WriteProcessMemory: recorder('WriteProcessMemory', 1),
            GetLastError: { argBytes: 0, handler: ()=>lastError },
        },
        ...more,
    });
    return { fns, view, calls };
}

test('NtAllocateVirtualMemory reads the base and size through pointers and writes back pages',
    ()=>{
        const { fns, view, calls } = setup();
        view.setUint32(0x100, 0, true);
        view.setUint32(0x104, 0x1800, true);
        assert.equal(fns.NtAllocateVirtualMemory.handler([SELF, 0x100, 0, 0x104, 0x3000, 4]), 0);
        assert.deepEqual(calls[0], { name: 'VirtualAllocEx',
            args: [SELF, 0, 0x1800, 0x3000, 4] });
        assert.equal(view.getUint32(0x100, true), 0x10000, 'where it was put');
        assert.equal(view.getUint32(0x104, true), 0x2000, 'in whole pages');

        // An address asked for inside a page: the pages it spans come back.
        const asked = setup({ VirtualAllocEx: 0x20000 });
        asked.view.setUint32(0x100, 0x20800, true);
        asked.view.setUint32(0x104, 0x1000, true);
        asked.fns.NtAllocateVirtualMemory.handler([SELF, 0x100, 0, 0x104, 0x1000, 4]);
        assert.equal(asked.view.getUint32(0x100, true), 0x20000);
        assert.equal(asked.view.getUint32(0x104, true), 0x2000);
    });

test('a refused allocation is a status: an address taken, a handle that is none', ()=>{
    const taken = setup({ VirtualAllocEx: 0 }, 487);
    assert.equal(taken.fns.NtAllocateVirtualMemory.handler([SELF, 0x100, 0, 0x104, 0x3000, 4]),
        STATUS_CONFLICTING_ADDRESSES);
    const bad = setup({ VirtualAllocEx: 0 }, 6);
    assert.equal(bad.fns.NtAllocateVirtualMemory.handler([0, 0x100, 0, 0x104, 0x3000, 4]),
        STATUS_INVALID_HANDLE);
});

test('NtProtectVirtualMemory with no old protection is an access violation', ()=>{
    // Wine's kernel32 virtual test_VirtualProtect.
    const refused = setup({ VirtualProtectEx: 0 }, 998);
    refused.view.setUint32(0x100, 0x10000, true);
    refused.view.setUint32(0x104, 0x1000, true);
    assert.equal(refused.fns.NtProtectVirtualMemory.handler([SELF, 0x100, 0x104, 2, 0]),
        STATUS_ACCESS_VIOLATION);

    const { fns, view, calls } = setup();
    view.setUint32(0x100, 0x10010, true);
    view.setUint32(0x104, 0x10, true);
    assert.equal(fns.NtProtectVirtualMemory.handler([SELF, 0x100, 0x104, 2, 0x200]), 0);
    assert.deepEqual(calls[0].args, [SELF, 0x10010, 0x10, 2, 0x200]);
    assert.equal(view.getUint32(0x100, true), 0x10000);
    assert.equal(view.getUint32(0x104, true), 0x1000);
});

test('NtFreeVirtualMemory of size zero reports the region it released', ()=>{
    const { fns, view } = setup({
        VirtualQueryEx: (/** @type {number[]} */ [, , buffer])=>{
            view.setUint32(buffer + 12, 0x3000, true);
            return 28;
        },
    });
    view.setUint32(0x100, 0x10000, true);
    view.setUint32(0x104, 0, true);
    assert.equal(fns.NtFreeVirtualMemory.handler([SELF, 0x100, 0x104, 0x8000]), 0);
    assert.equal(view.getUint32(0x104, true), 0x3000);
});

test('NtQueryVirtualMemory answers basic information and nothing else', ()=>{
    const { fns, view } = setup();
    assert.equal(fns.NtQueryVirtualMemory.handler([SELF, 0x10000, 0, 0x300, 28, 0x100]), 0);
    assert.equal(view.getUint32(0x100, true), 28);
    assert.equal(fns.NtQueryVirtualMemory.handler([SELF, 0x10000, 2, 0x300, 28, 0]),
        STATUS_INVALID_INFO_CLASS);
    assert.equal(fns.NtQueryVirtualMemory.handler([SELF, 0x10000, 0, 0x300, 27, 0]),
        STATUS_INFO_LENGTH_MISMATCH);
});

test('NtReadVirtualMemory and NtWriteVirtualMemory are kernel32\'s, answered as statuses', ()=>{
    const { fns, calls } = setup();
    assert.equal(fns.NtWriteVirtualMemory.handler([SELF, 0x10000, 0x300, 16, 0x100]), 0);
    assert.deepEqual(calls.at(-1), { name: 'WriteProcessMemory',
        args: [SELF, 0x10000, 0x300, 16, 0x100] });
    const partial = setup({ ReadProcessMemory: 0 }, 299);
    assert.equal(partial.fns.NtReadVirtualMemory.handler([0x44, 0x10000, 0x300, 16, 0]),
        STATUS_PARTIAL_COPY);
});

test('a call answered later by another process answers its status then, from its caller\'s error',
    async()=>{
        // A handle to a child is answered where the child runs, after the
        // caller's thread has stopped: the status is the promise's, and the
        // error it stands for is the caller's, not the thread running then.
        const caller = { id: 1 };
        const errors = new Map([[caller, 487]]);
        let running = /** @type {any} */ (caller);
        const later = (/** @type {number} */ value)=>(()=>Promise.resolve(value).then(got=>{
            running = { id: 2 };
            return got;
        }));
        const more = { currentThread: ()=>running,
            lastErrorOf: (/** @type {any} */ thread)=>errors.get(thread) ?? 0 };
        const refused = setup({ VirtualAllocEx: later(0) }, 0, more);
        assert.equal(await refused.fns.NtAllocateVirtualMemory.handler(
            [0x44, 0x100, 0, 0x104, 0x3000, 4]), STATUS_CONFLICTING_ADDRESSES);

        running = caller;
        const made = setup({ VirtualAllocEx: later(0x30000) }, 0, more);
        made.view.setUint32(0x104, 0x1800, true);
        assert.equal(await made.fns.NtAllocateVirtualMemory.handler(
            [0x44, 0x100, 0, 0x104, 0x3000, 4]), 0);
        assert.equal(made.view.getUint32(0x100, true), 0x30000);
        assert.equal(made.view.getUint32(0x104, true), 0x2000);

        // A release of size zero asks the child how far its region runs first.
        running = caller;
        const freed = setup({ VirtualQueryEx: later(28), VirtualFreeEx: later(1) }, 0, more);
        freed.view.setUint32(0x1800 + 12, 0x5000, true);
        freed.view.setUint32(0x100, 0x30000, true);
        freed.view.setUint32(0x104, 0, true);
        assert.equal(await freed.fns.NtFreeVirtualMemory.handler([0x44, 0x100, 0x104, 0x8000]), 0);
        assert.equal(freed.view.getUint32(0x104, true), 0x5000);

        running = caller;
        errors.set(caller, 299);
        const partial = setup({ ReadProcessMemory: later(0) }, 0, more);
        assert.equal(await partial.fns.NtReadVirtualMemory.handler([0x44, 0, 0, 0, 0]),
            STATUS_PARTIAL_COPY);
    });
