/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNtdllFunctions } from './functions.js';

const PROCESS_HEAP = 0x8;

/**
 * Stands in for the two tables ntdll draws on. Only the entries these tests
 * reach are here; the rest of the surface is exercised where it is implemented.
 *
 * @param {Object} [options]
 * @param {boolean} [options.registers]  Whether the caller wired EDX.
 */
function fakeHost({ registers = true } = {}){
    const bytes = new Uint8Array(0x1000);
    /** @type {number[]} */
    const allocations = [];
    /** @type {Record<string, number>} */
    const written = {};

    /** @param {number} address @param {number} length */
    const readMemory = (address, length)=>bytes.subarray(address, address + length);
    /** @param {number} address @param {Uint8Array} data */
    const writeMemory = (address, data)=>bytes.set(data, address);

    const kernel32 = {
        GetProcessHeap: { argBytes: 0, handler: ()=>PROCESS_HEAP },
        HeapAlloc: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([heap])=>{
                allocations.push(heap);
                return 0x900;
            },
        },
        HeapFree: { argBytes: 12, handler: ()=>1 },
        HeapReAlloc: { argBytes: 16, handler: ()=>0 },
        HeapSize: { argBytes: 12, handler: ()=>0 },
        HeapWalk: { argBytes: 8, handler: ()=>0 },
        EnterCriticalSection: { argBytes: 4, handler: ()=>0 },
        RtlUnwind: { argBytes: 16, handler: ()=>0 },
        VerSetConditionMask: { argBytes: 16, handler: ()=>0 },
    };

    const crt = {
        memset: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, value, count])=>{
                bytes.fill(value & 0xff, destination, destination + (count >>> 0));
                return destination;
            },
        },
        memmove: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, source, count])=>{
                bytes.set(bytes.slice(source, source + (count >>> 0)), destination);
                return destination;
            },
        },
        memcpy: { convention: 'cdecl', argBytes: 12, handler: ()=>0 },
        strlen: { convention: 'cdecl', argBytes: 4, handler: ()=>0 },
    };

    return {
        bytes,
        allocations,
        written,
        kernel32,
        crt,
        readMemory,
        writeMemory,
        /** @param {number} address */
        readCString: address=>String(address),
        /** @param {number} address */
        readWideString: address=>String(address),
        teb: ()=>0,
        arena: { base: 0x400000, size: 0x100000 },
        setRegisters: registers
            ? (/** @type {Record<string, number>} */ values)=>Object.assign(written, values)
            : undefined,
    };
}

test('the heap family is the very entry kernel32 exports, not a copy of it', ()=>{
    // A program allocates through RtlAllocateHeap and frees through HeapFree in
    // the same breath. Two allocators would each refuse the other's pointers, and
    // the refusal surfaces as a leak or a crash far from the mismatch.
    const host = fakeHost();
    const fns = createNtdllFunctions(host);

    assert.equal(fns.RtlAllocateHeap, host.kernel32.HeapAlloc);
    assert.equal(fns.RtlFreeHeap, host.kernel32.HeapFree);
    assert.equal(fns.RtlReAllocateHeap, host.kernel32.HeapReAlloc);
    assert.equal(fns.RtlSizeHeap, host.kernel32.HeapSize);
});

test('the aliases carry the argument sizes the guest compiled against', ()=>{
    // Aliasing is only safe while the two names describe the same argument list.
    // These are the numbers a caller of the ntdll spelling pushes.
    const fns = createNtdllFunctions(fakeHost());

    assert.equal(fns.RtlAllocateHeap.argBytes, 12);
    assert.equal(fns.RtlFreeHeap.argBytes, 12);
    assert.equal(fns.RtlReAllocateHeap.argBytes, 16);
    assert.equal(fns.RtlSizeHeap.argBytes, 12);
    assert.equal(fns.RtlEnterCriticalSection.argBytes, 4);
    assert.equal(fns.RtlUnwind.argBytes, 16);
});

test('unwinding is the walk kernel32 already drives', ()=>{
    // There is one handler chain per thread and it lives in the thread block. A
    // second dispatcher walking it would call handlers the first had already
    // called, and would publish its own idea of the head afterwards.
    const host = fakeHost();
    assert.equal(createNtdllFunctions(host).RtlUnwind, host.kernel32.RtlUnwind);
});

test('VerSetConditionMask is the entry kernel32 exports', ()=>{
    // kernel32.spec forwards it to ntdll's: one function under two names, so
    // a mask built through either is read the same by VerifyVersionInfo and
    // RtlVerifyVersionInfo.
    const host = fakeHost();
    assert.equal(createNtdllFunctions(host).VerSetConditionMask, host.kernel32.VerSetConditionMask);
});

test('a name the other table does not have stays unexported', ()=>{
    // An unresolved import names the function that is missing. An export bound to
    // nothing fails on the call instead, with nothing saying which name it was.
    const host = fakeHost();
    const fns = createNtdllFunctions(host);

    assert.ok(!('RtlLeaveCriticalSection' in fns),
        'the fake kernel32 has no LeaveCriticalSection to alias');
    assert.ok(!('qsort' in fns), 'nor a runtime qsort');
    assert.equal(fns.memset, host.crt.memset, 'while what is there is shared, not copied');
    assert.equal(fns.memset.convention, 'cdecl',
        'and keeps the convention it was declared with');
});

test('the memory helpers take their arguments in ntdll order, not the runtime one', ()=>{
    // The fill value is last here and second in memset, and the length swaps with
    // it. An argument list passed straight through fills memory with the length
    // and writes as many bytes as the value.
    const host = fakeHost();
    const fns = createNtdllFunctions(host);

    fns.RtlFillMemory.handler([0x100, 4, 0xab]);
    assert.deepEqual([...host.bytes.subarray(0x100, 0x105)], [0xab, 0xab, 0xab, 0xab, 0]);

    host.bytes.fill(0xff, 0x200, 0x204);
    fns.RtlZeroMemory.handler([0x200, 3]);
    assert.deepEqual([...host.bytes.subarray(0x200, 0x204)], [0, 0, 0, 0xff]);
});

test('moving memory survives the regions overlapping', ()=>{
    // The name is the promise: this is the call a program uses precisely when the
    // regions overlap, and a byte-at-a-time copy would rewrite its own source.
    const host = fakeHost();
    const fns = createNtdllFunctions(host);
    host.bytes.set([1, 2, 3, 4], 0x300);

    fns.RtlMoveMemory.handler([0x301, 0x300, 3]);

    assert.deepEqual([...host.bytes.subarray(0x300, 0x305)], [1, 1, 2, 3, 0]);
});

test('RtlCompareMemory counts matching bytes and does not order them', ()=>{
    // It returns how far two blocks agree, so a complete match is the largest
    // number it can answer. Code that reads it as memcmp sees equality as
    // "greater than" and takes the wrong branch every time.
    const host = fakeHost();
    const fns = createNtdllFunctions(host);
    host.bytes.set([1, 2, 3, 4], 0x400);
    host.bytes.set([1, 2, 9, 4], 0x410);

    assert.equal(fns.RtlCompareMemory.handler([0x400, 0x410, 4]), 2);
    assert.equal(fns.RtlCompareMemory.handler([0x400, 0x400, 4]), 4,
        'identical blocks match all the way');
    assert.equal(fns.RtlCompareMemory.handler([0x400, 0x410, 0]), 0);
});

test('a status translation is exported and reads its argument unsigned', ()=>{
    const fns = createNtdllFunctions(fakeHost());

    assert.equal(fns.RtlNtStatusToDosError.argBytes, 4);
    assert.equal(fns.RtlNtStatusToDosError.handler([0xc0000022 | 0]), 5);
});

test('the counted-string family allocates out of the process heap', ()=>{
    // Not out of an allocator of its own: RtlFreeUnicodeString and RtlFreeHeap
    // are both valid ways to give one of these buffers back.
    const host = fakeHost();
    const fns = createNtdllFunctions(host);
    // A source of one character, and a destination with no buffer of its own.
    host.bytes.set([1, 0, 2, 0, 0x40, 0x00, 0x00, 0x00], 0x20);

    fns.RtlAnsiStringToUnicodeString.handler([0x10, 0x20, 1]);

    assert.deepEqual(host.allocations, [PROCESS_HEAP]);
});

test('the 64-bit helpers appear only when there is a register to answer in', ()=>{
    // Their answer is two registers wide and the dispatcher writes one. Without
    // the seam they would hand back half an answer, so they are not exported at
    // all and an import that needs one says so.
    assert.ok('_allmul' in createNtdllFunctions(fakeHost()));
    assert.ok(!('_allmul' in createNtdllFunctions(fakeHost({ registers: false }))));
});

test('a kernel32 entry\'s native calls are published under their own names', ()=>{
    // NtQueueApcThread and NtTestAlert are built over the APC queues, which
    // only kernel32's table holds, and ride on QueueUserAPC's entry.
    const host = fakeHost();
    const native = { argBytes: 20, handler: ()=>0 };
    Object.assign(host.kernel32, {
        QueueUserAPC: { argBytes: 12, handler: ()=>1, natives: { NtQueueApcThread: native } },
    });
    const fns = createNtdllFunctions(host);
    assert.equal(fns.NtQueueApcThread, native);
    assert.ok(!('QueueUserAPC' in fns), 'the entry itself stays kernel32\'s');
});

test('RtlWalkHeap is HeapWalk answered as a status, its end STATUS_NO_MORE_ENTRIES', ()=>{
    // kernel32's heap tests loop `while (!RtlWalkHeap(heap, &entry))`: the end
    // of the walk has to be a status that is not zero.
    const host = fakeHost();
    const fns = createNtdllFunctions(host);

    assert.equal(fns.RtlWalkHeap.handler([PROCESS_HEAP, 0x100]) >>> 0, 0x8000001a);
    host.kernel32.HeapWalk.handler = ()=>1;
    assert.equal(fns.RtlWalkHeap.handler([PROCESS_HEAP, 0x100]), 0, 'an entry is success');
    assert.equal(fns.RtlWalkHeap.argBytes, 8);
    assert.equal(fns.RtlNtStatusToDosError.handler([0x8000001a]), 259,
        'and it reads as ERROR_NO_MORE_ITEMS');
});

test('RtlGetCurrentPeb reads the process block out of the running thread\'s', ()=>{
    const host = /** @type {any} */ (fakeHost());
    host.teb = ()=>0x200;
    host.bytes.set([0x00, 0x30, 0x40, 0x7f], 0x230);
    assert.equal(createNtdllFunctions(host).RtlGetCurrentPeb.handler([]), 0x7f403000);
    host.teb = ()=>0;
    assert.equal(createNtdllFunctions(host).RtlGetCurrentPeb.handler([]), 0);
});
