/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MULDIV_CODE, createSystemFunctions, mulDiv } from './system.js';
import { createProcessors } from './processor.js';
import { KEPT, random, runCode } from '../../../../scripts/guest-code/equivalence.mjs';

const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;

const FILE_TYPE_UNKNOWN = 0x0000;
const FILE_TYPE_DISK = 0x0001;
const FILE_TYPE_CHAR = 0x0002;

const STILL_ACTIVE = 259;
const CURRENT_PROCESS = 0xffffffff;

/** What the bridge hands back for a call that does not return. */
const PARKED = Object.freeze({ parked: true });

/** 100ns units between 1601-01-01 and 1970-01-01. */
const FILETIME_AT_UNIX_EPOCH = 116_444_736_000_000_000n;

function fakeHost(size = 0x1000){
    const bytes = new Uint8Array(size);
    /** @type {number[]} */
    const errors = [];
    /** @type {number[]} */
    const exits = [];
    /** @type {Map<number, any>} */
    const handles = new Map();
    const clock = { wallMs: 0 };

    return {
        bytes,
        errors,
        exits,
        handles,
        clock,
        view: new DataView(bytes.buffer),
        /** Addresses at or above this are mapped; below it, nothing is. */
        mappedFrom: 0x100,
        /** @param {number} address @param {number} length */
        readMemory(address, length){
            if (address < this.mappedFrom || address + length > bytes.length)
            {
                throw new Error(`unmapped ${address}`);
            }
            return bytes.slice(address, address + length);
        },
        /** @param {number} address @param {Uint8Array} data */
        writeMemory(address, data){
            bytes.set(data, address);
        },
        systemTimeMs: ()=>clock.wallMs,
        /** @param {number} code */
        setLastError: code=>errors.push(code),
        /** @param {number} handle */
        resolveHandle(handle){
            const held = handles.get(handle);
            if (!held)
            {
                throw new Error(`bad handle ${handle}`);
            }
            return held;
        },
        /** @param {number} code */
        exit: code=>exits.push(code),
        park: ()=>PARKED,
        /** The caller's own thread record, which the pseudo-handle resolves to. */
        self: { kind: 'thread', priority: 0 },
        currentThread(){
            return this.self;
        },
    };
}

test('the machine reported is one a program of the era knows what to do with', ()=>{
    // A thread pool sizes itself from the processor count and an allocator
    // rounds to the granularity, so these are branched on rather than displayed.
    const host = fakeHost();
    const fns = createSystemFunctions(host);

    fns.GetSystemInfo.handler([0x200]);
    assert.equal(host.view.getUint16(0x200, true), 0, 'x86');
    assert.equal(host.view.getUint32(0x204, true), 0x1000, 'page size');
    assert.equal(host.view.getUint32(0x210, true), 1, 'one processor in the mask');
    assert.equal(host.view.getUint32(0x214, true), 1, 'and one processor');
    assert.equal(host.view.getUint32(0x21c, true), 0x10000, 'allocation granularity');
    assert.equal(host.view.getUint16(0x220, true), 6, 'the level is CPUID\'s family');
    assert.equal(host.view.getUint16(0x222, true), 0x0703, 'the revision its model and stepping');
});

test('GetSystemInfo counts a processor for each the kernel has, and masks all of them', ()=>{
    // dwActiveProcessorMask is the machine's, not the process's: a process
    // narrowed to one processor still learns there are four.
    for (const [count, mask] of [[4, 0xf], [32, 0xffffffff]])
    {
        const host = fakeHost();
        const processors = createProcessors({ processors: ()=>count });
        processors.setProcessMask(1);
        const fns = createSystemFunctions({ ...host, processors });
        fns.GetSystemInfo.handler([0x200]);
        assert.deepEqual([host.view.getUint32(0x210, true), host.view.getUint32(0x214, true)],
            [mask, count], `${count} processors`);
    }
});

/**
 * SYSTEM_LOGICAL_PROCESSOR_INFORMATION entries read back: the mask, the
 * relationship, and the union's bytes as each relationship reads them.
 *
 * @param {DataView} view @param {number} at @param {number} length
 */
const logicalEntries = (view, at, length)=>Array.from({ length: length / 24 }, (_, index)=>{
    const entry = at + index * 24;
    return {
        mask: view.getUint32(entry, true),
        relationship: view.getUint32(entry + 4, true),
        word: view.getUint32(entry + 8, true),
        cache: [view.getUint8(entry + 8), view.getUint8(entry + 9),
            view.getUint16(entry + 10, true), view.getUint32(entry + 12, true),
            view.getUint32(entry + 16, true)],
    };
});

test('GetLogicalProcessorInformation lists a core and its caches for each processor, '
    + 'then the package and the node', ()=>{
    const LENGTH = 0x1fc;
    const BUFFER = 0x200;
    for (const count of [1, 4])
    {
        const host = fakeHost();
        const fns = createSystemFunctions({ ...host,
            processors: createProcessors({ processors: ()=>count }) });
        const needed = (count * 4 + 2) * 24;
        host.view.setUint32(LENGTH, 0x400, true);
        assert.equal(fns.GetLogicalProcessorInformation.handler([BUFFER, LENGTH]), 1);
        assert.equal(host.view.getUint32(LENGTH, true), needed, 'what was written');
        const entries = logicalEntries(host.view, BUFFER, needed);
        const all = 2 ** count - 1;
        for (let index = 0; index < count; index++)
        {
            const mask = 1 << index;
            assert.deepEqual(entries.slice(index * 4, index * 4 + 4).map(entry=>
                [entry.mask, entry.relationship, entry.relationship === 2 ? entry.cache
                    : entry.word]), [
                [mask, 0, 0],
                // Level, associativity, line, size, type: data 2, instruction 1, unified 0.
                [mask, 2, [1, 8, 64, 32 << 10, 2]],
                [mask, 2, [1, 8, 64, 32 << 10, 1]],
                [mask, 2, [2, 24, 64, 6 << 20, 0]],
            ], `processor ${index} of ${count}`);
        }
        assert.deepEqual(entries.slice(count * 4).map(entry=>
            [entry.mask, entry.relationship, entry.word]), [[all, 3, 0], [all, 1, 0]],
        'one package and node 0, holding all of them');
    }
});

test('GetLogicalProcessorInformation says what it needs of a buffer too small, '
    + 'and needs a length', ()=>{
    // Wine's kernelbase, and the two calls every caller makes: ask with
    // nothing, allocate, ask again.
    const LENGTH = 0x1fc;
    const host = fakeHost();
    const fns = createSystemFunctions({ ...host,
        processors: createProcessors({ processors: ()=>4 }) });
    host.view.setUint32(LENGTH, 0, true);
    assert.equal(fns.GetLogicalProcessorInformation.handler([0, LENGTH]), 0);
    assert.equal(host.view.getUint32(LENGTH, true), 18 * 24);
    host.view.setUint32(LENGTH, 17 * 24, true);
    host.bytes.fill(0xcc, 0x200, 0x400);
    assert.equal(fns.GetLogicalProcessorInformation.handler([0x200, LENGTH]), 0);
    assert.equal(host.view.getUint32(LENGTH, true), 18 * 24);
    assert.ok(host.bytes.subarray(0x200, 0x400).every(byte=>byte === 0xcc), 'nothing written');
    assert.equal(fns.GetLogicalProcessorInformation.handler([0x200, 0]), 0);
    assert.deepEqual(host.errors, [ERROR_INSUFFICIENT_BUFFER, ERROR_INSUFFICIENT_BUFFER,
        ERROR_INVALID_PARAMETER]);
    assert.equal(fns.GetLogicalProcessorInformation.argBytes, 8);
});

test('GetCurrentProcessorNumber is the processor the kernel has the caller on', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions({ ...host, processors: createProcessors({
        processors: ()=>4,
        processorOf: (/** @type {any} */ thread)=>(thread === host.self ? 3 : 0),
    }) });
    assert.equal(fns.GetCurrentProcessorNumber.handler(), 3);
    assert.equal(fns.GetCurrentProcessorNumber.argBytes, 0);
    assert.equal(createSystemFunctions(fakeHost()).GetCurrentProcessorNumber.handler(), 0,
        'one processor, the first');
});

test('kernel32 exports none of the Windows 95 calls NT lacks', ()=>{
    const fns = /** @type {any} */ (createSystemFunctions(fakeHost()));
    for (const name of ['FT_Thunk', 'FT_Exit20', 'SMapLS_IP_EBP_8', 'MapLS', 'MapSL', 'SMapLS',
        'ThunkConnect32',
        'OpenVxDHandle', 'RegisterServiceProcess', 'ConvertToGlobalHandle'])
    {
        assert.equal(name in fns, false, name);
    }
    assert.ok(fns.CreateSocketHandle && fns.SetHandleContext, 'the two NT kept');
});

test('the lstr family answers NULL to a pointer that faults, as the real one does', ()=>{
    // Windows wraps these in an exception handler; a program of the era hands
    // lstrcpy a -1 and tests the NULL. Raised through, the fault stops a
    // program that was written to survive it.
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    host.writeMemory(0x200, Uint8Array.from([0x41, 0]));

    assert.equal(fns.lstrcpyA.handler([0x300, 0xffffffff]), 0);
    assert.equal(fns.lstrlenA.handler([0xffffffff]), 0);
    assert.equal(fns.lstrcatA.handler([0x300, 0x10]), 0, 'below the mapped floor');
    assert.equal(fns.lstrcmpA.handler([0x200, 0xffffffff]), 0);
    assert.deepEqual(host.errors, [87, 87, 87, 87], 'ERROR_INVALID_PARAMETER each time');

    assert.equal(fns.lstrcpyA.handler([0x300, 0x200]), 0x300, 'and a good pointer still copies');
    assert.equal(fns.lstrlenA.handler([0x300]), 1);
});

test('the lstr family has no length of its own: a whole script is one string', ()=>{
    // Nothing in the signatures bounds a string, and a program hands lstrcpy
    // the text of a file it just read. A cap inside these copies the first
    // page and terminates it, and the program then reads a script that ends
    // mid-statement.
    const host = fakeHost(0x8000);
    const fns = createSystemFunctions(host);
    const long = 'x'.repeat(6000);
    host.writeMemory(0x200, Uint8Array.from([...long].map(c=>c.charCodeAt(0)).concat(0)));

    assert.equal(fns.lstrlenA.handler([0x200]), 6000);
    assert.equal(fns.lstrcpyA.handler([0x4000, 0x200]), 0x4000);
    assert.equal(host.bytes[0x4000 + 5999], 0x78);
    assert.equal(host.bytes[0x4000 + 6000], 0);
    assert.equal(fns.lstrcmpA.handler([0x4000, 0x200]), 0);
});

test('lstrcpynW copies at most the count less one and always terminates', ()=>{
    // The count is in characters, the terminator among them: MFC copies a
    // path into a MAX_PATH buffer this way.
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    host.writeMemory(0x200, new Uint8Array(Uint16Array.from([...'abcdef', '\0']
        .map(c=>c.charCodeAt(0))).buffer));
    host.bytes.fill(0xee, 0x300, 0x320);

    assert.equal(fns.lstrcpynW.handler([0x300, 0x200, 4]), 0x300);
    assert.deepEqual([...new Uint16Array(host.bytes.slice(0x300, 0x308).buffer)],
        [0x61, 0x62, 0x63, 0], 'three characters and the terminator');
    assert.equal(host.bytes[0x308], 0xee, 'nothing past the count');

    assert.equal(fns.lstrcpynW.handler([0x300, 0x200, 100]), 0x300);
    assert.equal(host.view.getUint16(0x300 + 12, true), 0, 'a shorter source is copied whole');
    assert.equal(fns.lstrcpynW.handler([0x300, 0xffffffff, 4]), 0, 'NULL for a faulting pointer');
});

test('lstrcatW appends in place, after the characters already there', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    /** @param {number} at @param {string} text */
    const wide = (at, text)=>host.writeMemory(at, new Uint8Array(Uint16Array.from(
        [...text, '\0'].map(c=>c.charCodeAt(0))).buffer));
    wide(0x300, 'C:\\App');
    wide(0x200, '\\Setup.exe');
    assert.equal(fns.lstrcatW.handler([0x300, 0x200]), 0x300);
    const joined = String.fromCharCode(...new Uint16Array(host.bytes.slice(0x300, 0x300 + 34)
        .buffer)).split('\0')[0];
    assert.equal(joined, 'C:\\App\\Setup.exe');
    assert.equal(fns.lstrcatW.handler([0x300, 0xffffffff]), 0, 'NULL for a faulting pointer');
});

test('MulDiv keeps the product a caller could not have kept itself', ()=>{
    // The whole point of the call: the intermediate does not fit in 32 bits.
    const host = fakeHost();
    const fns = createSystemFunctions(host);

    assert.equal(fns.MulDiv.handler([1000000, 3000, 2000]), 1500000);
    assert.equal(fns.MulDiv.handler([7, 3, 2]), 11, 'rounded, not truncated');
    assert.equal(fns.MulDiv.handler([1, 1, 0]) | 0, -1, 'a zero divisor is the error value');
    assert.equal(fns.MulDiv.handler([-7, 3, 2]) | 0, -11, 'and it rounds away from zero');
});

test('MulDiv\'s code: rounded half away from zero, -1 for no divisor and past 2^31 - 1', ()=>{
    const next = random(61);
    const edges = [0, 1, -1, 2, -2, 3, 7, -7, 0x7fffffff, -0x80000000, 0x40000000, -0x40000000,
        65536, 1000000, 46341, -46341];
    /** @type {[number, number, number][]} */
    const cases = [[1, 1, 2], [-1, 1, 2], [1, -1, 2], [3, 1, 2], [5, 1, 4], [-5, 1, 4],
        [0x7fffffff, 1, 1], [-0x7fffffff, 1, 1], [-0x80000000, 1, 1], [-0x80000000, -1, 1],
        [0x7fffffff, 0x7fffffff, 0x7fffffff], [-0x80000000, -0x80000000, -0x80000000],
        [0x7fffffff, 2, 1], [1, 1, 0], [0, 5, -3], [-0x80000000, 1, -4], [100, 100, 3]];
    for (const a of edges)
    {
        for (const b of edges)
        {
            cases.push([a, b, edges[next() % edges.length] || 3]);
        }
    }
    for (let i = 0; i < 3000; i++)
    {
        const scale = next() % 32;
        cases.push([next() | 0, (next() | 0) >> scale, ((next() | 0) >> (next() % 32)) || 1]);
    }
    for (const [a, b, c] of cases)
    {
        const run = runCode(MULDIV_CODE, { stack: [a, b, c] });
        const what = `MulDiv(${a}, ${b}, ${c})`;
        assert.ok(run.halted, what);
        assert.equal(run.popped, 12, `${what} pops its arguments`);
        assert.deepEqual([run.ebx, run.esi, run.edi, run.ebp], Object.values(KEPT), what);
        assert.equal(run.eax, mulDiv(a, b, c), what);
    }
    // The answers themselves, as Windows rounds: a half away from zero.
    assert.equal(mulDiv(1, 1, 2), 1);
    assert.equal(mulDiv(-1, 1, 2) | 0, -1);
    assert.equal(mulDiv(1, -1, -2), 1);
    assert.equal(mulDiv(5, 1, 4), 1);
    assert.equal(mulDiv(0x7fffffff, 2, 2), 0x7fffffff);
    assert.equal(mulDiv(-0x80000000, 1, 1) | 0, -1, 'INT_MIN is past the magnitude it may have');
    assert.equal(mulDiv(0x7fffffff, 3, 2) | 0, -1, 'an overflow is the error value');
});

test('the two clocks answer the same thing, because there is one clock', ()=>{
    // A program that measures a duration with one and timestamps with the other
    // would otherwise see time move sideways.
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    host.clock.wallMs = Date.UTC(2003, 6, 1, 12, 30, 45, 250);

    fns.GetSystemTime.handler([0x200]);
    fns.GetLocalTime.handler([0x220]);
    assert.deepEqual([...host.bytes.slice(0x200, 0x210)], [...host.bytes.slice(0x220, 0x230)]);

    assert.equal(host.view.getUint16(0x200, true), 2003);
    assert.equal(host.view.getUint16(0x202, true), 7, 'July, one-based');
    assert.equal(host.view.getUint16(0x206, true), 1, 'the day of the month');
    assert.equal(host.view.getUint16(0x208, true), 12);
    assert.equal(host.view.getUint16(0x20e, true), 250);
});

test('a system time and a file time convert into each other', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    host.clock.wallMs = Date.UTC(1999, 11, 31, 23, 59, 59, 0);

    fns.GetSystemTime.handler([0x200]);
    fns.SystemTimeToFileTime.handler([0x200, 0x240]);
    fns.FileTimeToSystemTime.handler([0x240, 0x260]);

    assert.deepEqual([...host.bytes.slice(0x200, 0x210)], [...host.bytes.slice(0x260, 0x270)]);
    assert.equal(host.view.getBigUint64(0x240, true),
        BigInt(host.clock.wallMs) * 10_000n + FILETIME_AT_UNIX_EPOCH);
});

test('file times compare as an ordering, not as a difference', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    host.view.setBigUint64(0x200, 1000n, true);
    host.view.setBigUint64(0x210, 2000n, true);

    assert.equal(fns.CompareFileTime.handler([0x200, 0x210]) | 0, -1);
    assert.equal(fns.CompareFileTime.handler([0x210, 0x200]), 1);
    assert.equal(fns.CompareFileTime.handler([0x200, 0x200]), 0);
});

test('a console is a character device and a file is not', ()=>{
    // A runtime buffers by line or by block on the strength of this answer, so
    // getting it wrong makes output appear at exit or not at all.
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    host.handles.set(0x10, { kind: 'console' });
    host.handles.set(0x14, { kind: 'file' });

    assert.equal(fns.GetFileType.handler([0x10]), FILE_TYPE_CHAR);
    assert.equal(fns.GetFileType.handler([0x14]), FILE_TYPE_DISK);
});

test('an unknown handle is a reported failure, not a guess', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);

    assert.equal(fns.GetFileType.handler([0x99]), FILE_TYPE_UNKNOWN);
    assert.deepEqual(host.errors, [ERROR_INVALID_HANDLE]);
});

test('a request for a bigger handle table is answered with the number asked for', ()=>{
    const fns = createSystemFunctions(fakeHost());
    assert.equal(fns.SetHandleCount.handler([512]), 512);
});

test('an unmapped pointer is bad and a mapped one is not', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);

    assert.equal(fns.IsBadReadPtr.handler([0x200, 16]), 0);
    assert.equal(fns.IsBadReadPtr.handler([0x10, 16]), 1, 'below the mapped range');
    assert.equal(fns.IsBadReadPtr.handler([0, 16]), 1, 'null is always bad');
    assert.equal(fns.IsBadWritePtr.handler([0x200, 16]), 0);
    assert.equal(fns.IsBadCodePtr.handler([0x200]), 0);
    assert.equal(fns.IsBadCodePtr.handler([0]), 1);
});

test('a write pointer is bad where a region without write access covers any of it', ()=>{
    // Windows maps code read-only -- the return address a program's entry
    // point finds on its stack is kernel32's code -- and a program may check
    // that IsBadWritePtr says so before it trusts the process it runs in.
    const host = fakeHost();
    /** @type {{ base: number, size: number, access: string }[]} */
    const regions = [
        { base: 0x000, size: 0x400, access: 'rwx' },
        { base: 0x400, size: 0x400, access: 'rx' },
        { base: 0x800, size: 0x800, access: 'rw' },
    ];
    const fns = createSystemFunctions({
        ...host,
        regionAt: (/** @type {number} */ address)=>regions.find(region=>
            address >= region.base && address < region.base + region.size) ?? null,
    });

    assert.equal(fns.IsBadWritePtr.handler([0x200, 16]), 0, 'read-write-execute');
    assert.equal(fns.IsBadWritePtr.handler([0x402, 1]), 1, 'read-execute');
    assert.equal(fns.IsBadWritePtr.handler([0x3f0, 0x20]), 1, 'runs into read-execute');
    assert.equal(fns.IsBadWritePtr.handler([0x900, 0]), 0, 'an empty range on writable memory');
    assert.equal(fns.IsBadReadPtr.handler([0x402, 1]), 0, 'readable all the same');
});

test('a string pointer is bad when its terminator is not in mapped memory', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    host.bytes.set([0x61, 0x62, 0], 0x200);
    host.bytes.set([0x61, 0, 0x62, 0, 0, 0], 0x300);
    // Terminated within mapped memory, whatever the count says.
    assert.equal(fns.IsBadStringPtrA.handler([0x200, 0xffffffff]), 0);
    assert.equal(fns.IsBadStringPtrW.handler([0x300, 0xffffffff]), 0);
    // A count that stops before the terminator is enough on its own.
    host.bytes.fill(0x61, 0xf00, 0x1000);
    assert.equal(fns.IsBadStringPtrA.handler([0xf00, 16]), 0);
    // Unterminated to the end of mapped memory, and null, and unmapped.
    assert.equal(fns.IsBadStringPtrA.handler([0xf00, 0xffffffff]), 1);
    assert.equal(fns.IsBadStringPtrA.handler([0, 0xffffffff]), 1);
    assert.equal(fns.IsBadStringPtrW.handler([0x10, 4]), 1);
    assert.deepEqual([fns.IsBadStringPtrA.argBytes, fns.IsBadStringPtrW.argBytes], [8, 8]);
});

test('a running process reports that it is still running', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);

    assert.equal(fns.GetExitCodeProcess.handler([CURRENT_PROCESS, 0x200]), 1);
    assert.equal(host.view.getUint32(0x200, true), STILL_ACTIVE);

    assert.equal(fns.GetExitCodeProcess.handler([0x10, 0x200]), 0, 'and no such process exists');
    assert.deepEqual(host.errors, [ERROR_INVALID_HANDLE]);
});

test('the native machine is the one GetSystemInfo reports, with no 64-bit system beneath',
    ()=>{
        // Wine's kernel32 test_SystemInfo: a process that is not under WOW64
        // sees no difference between the two.
        const host = fakeHost();
        const fns = createSystemFunctions(host);
        host.bytes.fill(0xcc, 0x200, 0x300);
        fns.GetSystemInfo.handler([0x200]);
        fns.GetNativeSystemInfo.handler([0x280]);
        assert.deepEqual(host.bytes.slice(0x280, 0x2a4), host.bytes.slice(0x200, 0x224));
        assert.equal(fns.GetNativeSystemInfo.argBytes, 4);
    });

test('IsWow64Process answers FALSE for this process and a child, and fails a stranger', ()=>{
    const host = fakeHost();
    host.handles.set(0x40, { exitCode: STILL_ACTIVE });
    const fns = createSystemFunctions(host);
    host.view.setUint32(0x200, 0xdeadbeef, true);
    assert.equal(fns.IsWow64Process.handler([CURRENT_PROCESS, 0x200]), 1);
    assert.equal(host.view.getUint32(0x200, true), 0, 'a 32-bit system has no WOW64');
    host.view.setUint32(0x200, 0xdeadbeef, true);
    assert.equal(fns.IsWow64Process.handler([0x40, 0x200]), 1);
    assert.equal(host.view.getUint32(0x200, true), 0);
    assert.equal(fns.IsWow64Process.handler([0x10, 0x200]), 0);
    assert.deepEqual(host.errors, [ERROR_INVALID_HANDLE]);
    assert.equal(fns.IsWow64Process.argBytes, 8);
});

test('IsWow64Process2: no process is a WOW64 one, on an i386 machine', ()=>{
    const host = fakeHost();
    host.handles.set(0x40, { exitCode: STILL_ACTIVE });
    const fns = createSystemFunctions(host);
    for (const handle of [CURRENT_PROCESS, 0x40])
    {
        host.view.setUint32(0x200, 0xdeaddead, true);
        assert.equal(fns.IsWow64Process2.handler([handle, 0x200, 0x202]), 1);
        assert.equal(host.view.getUint16(0x200, true), 0, 'IMAGE_FILE_MACHINE_UNKNOWN');
        assert.equal(host.view.getUint16(0x202, true), 0x14c, 'IMAGE_FILE_MACHINE_I386');
    }
    host.view.setUint32(0x200, 0xdeaddead, true);
    assert.equal(fns.IsWow64Process2.handler([CURRENT_PROCESS, 0x200, 0]), 1,
        'the native machine need not be asked for');
    assert.equal(host.view.getUint16(0x200, true), 0);
    assert.equal(host.view.getUint16(0x202, true), 0xdead);
    assert.equal(fns.IsWow64Process2.handler([0x10, 0x200, 0x202]), 0);
    assert.deepEqual(host.errors, [ERROR_INVALID_HANDLE]);
    assert.equal(fns.IsWow64Process2.argBytes, 12);
});

test('a 32-bit system has no WOW64 directory, and says the call is not implemented', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    host.bytes.fill(0x55, 0x200, 0x300);
    for (const call of [fns.GetSystemWow64DirectoryA, fns.GetSystemWow64DirectoryW])
    {
        assert.equal(call.handler([0x200, 0x80]), 0);
        assert.equal(call.handler([0, 0]), 0, 'sized or not');
        assert.equal(call.argBytes, 8);
    }
    assert.deepEqual(host.errors, [120, 120, 120, 120], 'ERROR_CALL_NOT_IMPLEMENTED');
    assert.ok(host.bytes.subarray(0x200, 0x300).every(byte=>byte === 0x55), 'nothing written');
});

test('a child process reports its own exit code, not this process\'s', ()=>{
    // The engine only ever answers STILL_ACTIVE for a child -- a child takes
    // this process's place rather than running beside it -- but the value has
    // to come off the record, or a record that ever says otherwise is ignored.
    const host = fakeHost();
    host.handles.set(0x40, { exitCode: 7 });
    const fns = createSystemFunctions(host);

    assert.equal(fns.GetExitCodeProcess.handler([0x40, 0x200]), 1);
    assert.equal(host.view.getUint32(0x200, true), 7);
});

test('terminating this process does not return', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);

    assert.equal(fns.TerminateProcess.handler([CURRENT_PROCESS, 3]), PARKED);
    assert.deepEqual(host.exits, [3]);
});

test('terminating some other process fails instead of exiting this one', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);

    assert.equal(fns.TerminateProcess.handler([0x10, 3]), 0);
    assert.deepEqual(host.exits, [], 'nothing was exited');
});

test('argument sizes match what the guest compiled against', ()=>{
    const fns = createSystemFunctions(fakeHost());

    assert.equal(fns.GetSystemInfo.argBytes, 4);
    assert.equal(fns.MulDiv.argBytes, 12);
    assert.equal(fns.SystemTimeToFileTime.argBytes, 8);
    assert.equal(fns.GetFileType.argBytes, 4);
    assert.equal(fns.IsBadReadPtr.argBytes, 8);
    assert.equal(fns.IsBadCodePtr.argBytes, 4);
    assert.equal(fns.TerminateProcess.argBytes, 8);
    assert.equal(fns.GetExitCodeProcess.argBytes, 8);
});

test('the processor features answered are the ones a 32-bit x86 with SSE2 has', ()=>{
    // A runtime picks its memcpy and floating-point paths from these; a yes for
    // an instruction the emulated processor lacks is a fault much later.
    const host = fakeHost();
    const fns = createSystemFunctions(host);

    assert.equal(fns.IsProcessorFeaturePresent.handler([1]), 0, 'floating point is not emulated');
    assert.equal(fns.IsProcessorFeaturePresent.handler([2]), 1, 'cmpxchg8b');
    assert.equal(fns.IsProcessorFeaturePresent.handler([6]), 1, 'SSE');
    assert.equal(fns.IsProcessorFeaturePresent.handler([10]), 1, 'SSE2');
    assert.equal(fns.IsProcessorFeaturePresent.handler([12]), 0, 'no execute-disable');
    assert.equal(fns.IsProcessorFeaturePresent.handler([13]), 1, 'SSE3, as CPUID says');
    assert.equal(fns.IsProcessorFeaturePresent.handler([99]), 0, 'and nothing unknown');
});


test('a thread reports STILL_ACTIVE until it has exited, then the code it left with', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    /** @type {{ kind: string, priority: number, exitCode: number | null }} */
    const worker = { kind: 'thread', priority: 0, exitCode: null };
    host.handles.set(0x40, worker);

    assert.equal(fns.GetExitCodeThread.argBytes, 8);
    assert.equal(fns.GetExitCodeThread.handler([0x40, 0x200]), 1);
    assert.equal(host.view.getUint32(0x200, true), STILL_ACTIVE);

    worker.exitCode = 0;
    assert.equal(fns.GetExitCodeThread.handler([0x40, 0x200]), 1);
    assert.equal(host.view.getUint32(0x200, true), 0,
        'an exit code of zero is not "still running"');

    assert.equal(fns.GetExitCodeThread.handler([0x10, 0x200]), 0, 'no such thread');
    assert.deepEqual(host.errors, [ERROR_INVALID_HANDLE]);
});

test('a thread priority set is the one read back, for every value a normal process may set', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    const worker = { kind: 'thread', priority: 0 };
    host.handles.set(0x40, worker);

    for (const priority of [-15, -2, -1, 0, 1, 2, 15])
    {
        assert.equal(fns.SetThreadPriority.handler([0x40, priority >>> 0]), 1, `set ${priority}`);
        assert.equal(worker.priority, priority, 'the kernel record is where it lives');
        assert.equal(fns.GetThreadPriority.handler([0x40]), priority, `read back ${priority}`);
    }
    assert.deepEqual(host.errors, [], 'none of them was an error');
});

test('the pseudo-handle for the current thread names the caller', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);

    assert.equal(fns.SetThreadPriority.handler([0xfffffffe, 2]), 1);
    assert.equal(host.self.priority, 2);
    assert.equal(fns.GetThreadPriority.handler([0xfffffffe]), 2);
});

test('a priority outside the normal class is refused as a parameter', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    const worker = { kind: 'thread', priority: 1 };
    host.handles.set(0x40, worker);

    for (const priority of [3, -3, 6, -7, 14, 0x10000])
    {
        assert.equal(fns.SetThreadPriority.handler([0x40, priority >>> 0]), 0,
            `refused ${priority}`);
    }
    assert.equal(worker.priority, 1, 'and the thread keeps the priority it had');
    assert.deepEqual(host.errors, [87, 87, 87, 87, 87, 87], 'ERROR_INVALID_PARAMETER each time');
});

test('a priority on a handle that is not a thread is a reported failure', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);

    assert.equal(fns.GetThreadPriority.handler([0x99]), 0x7fffffff, 'THREAD_PRIORITY_ERROR_RETURN');
    assert.equal(fns.SetThreadPriority.handler([0x99, 0]), 0);
    assert.deepEqual(host.errors, [6, 6], 'ERROR_INVALID_HANDLE each time');
});

test('lstrcmpW compares wide strings by sign, folded or not', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    /** @param {number} at @param {string} text */
    const wide = (at, text)=>{
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let i = 0; i < text.length; i++)
        {
            bytes[i * 2] = text.charCodeAt(i) & 0xff;
            bytes[i * 2 + 1] = text.charCodeAt(i) >> 8;
        }
        host.writeMemory(at, bytes);
    };
    wide(0x200, 'abc');
    wide(0x300, 'ABD');
    assert.equal(fns.lstrcmpW.handler([0x200, 0x300]), 1, '"a" sorts after "A"');
    assert.equal(fns.lstrcmpiW.handler([0x200, 0x300]), -1, 'folded, "abc" is before "abd"');
    assert.equal(fns.lstrcmpW.handler([0x200, 0x200]), 0);
    assert.equal(fns.lstrcmpW.argBytes, 8);
});

test('the lstr family reads a string a span at a time, and to the edge of mapped memory', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    let reads = 0;
    const read = host.readMemory.bind(host);
    host.readMemory = (/** @type {number} */ address, /** @type {number} */ length)=>{
        reads++;
        return read(address, length);
    };
    host.writeMemory(0x200, new Uint8Array(100).fill(0x41));
    host.writeMemory(0x264, Uint8Array.from([0]));
    assert.equal(fns.lstrlenA.handler([0x200]), 100);
    assert.ok(reads <= 3, `a span at a time, not a read per character: ${reads}`);

    // The last bytes of mapped memory: the span there cannot be read whole,
    // and the string still reads as it did a character at a time.
    host.writeMemory(0xff0, Uint8Array.from([0x42, 0x43, 0]));
    assert.equal(fns.lstrlenA.handler([0xff0]), 2);
    host.writeMemory(0xffa, Uint8Array.from([0x44, 0, 0x45, 0, 0, 0]));
    assert.equal(fns.lstrlenW.handler([0xffa]), 2);
    // One running into unmapped memory faults, NULL as before.
    host.writeMemory(0xffc, Uint8Array.from([0x46, 0x46, 0x46, 0x46]));
    assert.equal(fns.lstrlenA.handler([0xffc]), 0);
    assert.equal(host.errors.at(-1), 87);
});

test('terminating a child that has not run ends it with the code, and it never runs', ()=>{
    // Wine's kernel32 sync test starts a child that sleeps for ever and
    // terminates it; a child still recorded as to run would be handed the
    // machine once the parent exits.
    const host = fakeHost();
    const child = { imagePath: 'C:\\child.exe', exitCode: 259, completed: false };
    host.handles.set(0x40, child);
    const fns = createSystemFunctions(host);

    assert.equal(fns.TerminateProcess.handler([0x40, 5]), 1);
    assert.equal(child.exitCode, 5);
    assert.equal(child.completed, true, 'no longer one to hand over to');
    assert.deepEqual(host.exits, [], 'and this process goes on');
    assert.equal(fns.GetExitCodeProcess.handler([0x40, 0x200]), 1);
    assert.equal(host.view.getUint32(0x200, true), 5);
});

test('terminating a child wakes whoever waits on it, with its wait\'s answer', ()=>{
    const host = fakeHost();
    const waiter = { name: 'waiter' };
    const child = { imagePath: 'C:\\child.exe', exitCode: 259, completed: false,
        waiters: [{ thread: waiter, result: 0 }] };
    host.handles.set(0x40, child);
    /** @type {{ thread: any, result: number }[]} */
    const woken = [];
    const fns = createSystemFunctions({ ...host,
        wake: (thread, result)=>woken.push({ thread, result }) });

    assert.equal(fns.TerminateProcess.handler([0x40, 1]), 1);
    assert.deepEqual(woken, [{ thread: waiter, result: 0 }]);
    assert.deepEqual(child.waiters, []);
});

test('a child that has ended already is not ended twice', ()=>{
    const host = fakeHost();
    const child = { imagePath: 'C:\\child.exe', exitCode: 0, completed: true };
    host.handles.set(0x40, child);
    const fns = createSystemFunctions(host);
    assert.equal(fns.TerminateProcess.handler([0x40, 9]), 0);
    assert.equal(child.exitCode, 0);
    assert.deepEqual(host.errors, [5], 'ERROR_ACCESS_DENIED, as Windows answers');
});

test('FormatMessageA formats a caller\'s own string, not only the system table', ()=>{
    // A caller loads a resource string, clears its output buffer, and puts the
    // string through this call to have inserts expanded. Answering NULL for
    // FROM_STRING leaves the buffer it cleared, so every name reads as absent.
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    host.writeMemory(0x200, Uint8Array.from([...'Forward', '\0'].map(c=>c.charCodeAt(0))));

    assert.equal(fns.FormatMessageA.handler([0x400, 0x200, 0, 0, 0x300, 0x40, 0]), 7);
    assert.equal(host.bytes[0x300 + 7], 0, 'terminated');
    assert.equal(String.fromCharCode(...host.bytes.slice(0x300, 0x307)), 'Forward');
});

test('FormatMessageA expands inserts from the arguments it is handed', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    host.writeMemory(0x200, Uint8Array.from([...'%1 = %2', '\0'].map(c=>c.charCodeAt(0))));
    host.writeMemory(0x220, Uint8Array.from([...'Forward', '\0'].map(c=>c.charCodeAt(0))));
    host.writeMemory(0x240, Uint8Array.from([...'W', '\0'].map(c=>c.charCodeAt(0))));
    // A va_list: lpArguments points at the pointer to the first value, not at
    // the values themselves.
    host.writeMemory(0x280, new Uint8Array(Uint32Array.from([0x220, 0x240]).buffer));
    host.writeMemory(0x260, new Uint8Array(Uint32Array.from([0x280]).buffer));

    assert.equal(fns.FormatMessageA.handler([0x400, 0x200, 0, 0, 0x300, 0x40, 0x260]), 11);
    assert.equal(String.fromCharCode(...host.bytes.slice(0x300, 0x30b)), 'Forward = W');
});

test('FormatMessageA reads two-digit inserts and printf widths and precisions', ()=>{
    // A crash report's format: "%10" is the tenth argument, not the first
    // followed by a zero, and ".8X" is eight hexadecimal digits. Read as "%1"
    // and a string, the exception code is taken for a pointer, the call faults
    // and answers 0, and the report's box comes up empty.
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    const format = 'C=%1!.8X! J=%10!.8X! S=[%2!-4s!] D=%3!05d! P=%4!.2s!';
    host.writeMemory(0x200, Uint8Array.from([...format, ' '].map(c=>c.charCodeAt(0))));
    host.writeMemory(0x240, Uint8Array.from([...'ab', ' '].map(c=>c.charCodeAt(0))));
    host.writeMemory(0x250, Uint8Array.from([...'xyz', ' '].map(c=>c.charCodeAt(0))));
    // FORMAT_MESSAGE_ARGUMENT_ARRAY: the pointer is the array itself.
    host.writeMemory(0x280, new Uint8Array(Uint32Array.from(
        [0xc0000005, 0x240, -42, 0x250, 0, 0, 0, 0, 0, 0xff]).buffer));

    const expected = 'C=C0000005 J=000000FF S=[ab  ] D=-0042 P=xy';
    assert.equal(fns.FormatMessageA.handler([0x2400, 0x200, 0, 0, 0x300, 0x80, 0x280]),
        expected.length);
    assert.equal(String.fromCharCode(...host.bytes.slice(0x300, 0x300 + expected.length)),
        expected);
});

test('FormatMessageA formats the numeric inserts a resolution is named with', ()=>{
    // "%1!d!x%2!d!x%3!d!" is the format cshell paints a display mode with; a
    // handler that reads every insert as a string pointer finds a stack
    // address where an integer should be, faults, and answers NULL, leaving
    // the mode list blank.
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    const format = '%1!d!x%2!d!x%3!d!';
    host.writeMemory(0x200, Uint8Array.from([...format, '\0'].map(c=>c.charCodeAt(0))));
    host.writeMemory(0x280, new Uint8Array(Uint32Array.from([1024, 768, 32]).buffer));
    host.writeMemory(0x260, new Uint8Array(Uint32Array.from([0x280]).buffer));

    assert.equal(fns.FormatMessageA.handler([0x400, 0x200, 0, 0, 0x300, 0x40, 0x260]), 11);
    assert.equal(String.fromCharCode(...host.bytes.slice(0x300, 0x30b)), '1024x768x32');
});

test('FormatMessageA reads an ARGUMENT_ARRAY directly, and a typed insert by its specifier', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);
    const format = '%1!s! %2!u! %3!X!';
    host.writeMemory(0x200, Uint8Array.from([...format, '\0'].map(c=>c.charCodeAt(0))));
    host.writeMemory(0x240, Uint8Array.from([...'W', '\0'].map(c=>c.charCodeAt(0))));
    // With FORMAT_MESSAGE_ARGUMENT_ARRAY the pointer is the array of values;
    // 0x240 is a string pointer, 300 an unsigned decimal, 48879 a hex one.
    host.writeMemory(0x280, new Uint8Array(Uint32Array.from([0x240, 300, 48879]).buffer));

    assert.equal(fns.FormatMessageA.handler([0x400 | 0x2000, 0x200, 0, 0, 0x300, 0x40, 0x280]), 10);
    assert.equal(String.fromCharCode(...host.bytes.slice(0x300, 0x30a)), 'W 300 BEEF');
});

test('FormatMessageA allocates the buffer when asked, for a caller\'s string too', ()=>{
    const host = { ...fakeHost(), allocate: ()=>0x400 };
    const fns = createSystemFunctions(host);
    host.writeMemory(0x200, Uint8Array.from([...'unassigned', '\0'].map(c=>c.charCodeAt(0))));

    // FROM_STRING with ALLOCATE_BUFFER: lpBuffer is where the address goes and
    // nSize is ignored.
    assert.equal(fns.FormatMessageA.handler([0x500, 0x200, 0, 0, 0x300, 1, 0]), 10);
    assert.equal(host.view.getUint32(0x300, true), 0x400);
    assert.equal(host.bytes[0x400 + 10], 0, 'terminated');
});

test('FormatMessageW formats in UTF-16, a bare insert wide and a capital S narrow', ()=>{
    const host = { ...fakeHost(), allocate: ()=>0x400 };
    const fns = createSystemFunctions(host);
    /** @param {number} at @param {string} text */
    const wide = (at, text)=>host.writeMemory(at,
        new Uint8Array(Uint16Array.from([...text, '\0'].map(c=>c.charCodeAt(0))).buffer));
    /** @param {number} at @param {number} units */
    const readBack = (at, units)=>String.fromCharCode(
        ...new Uint16Array(host.bytes.slice(at, at + units * 2).buffer));
    wide(0x200, '%1 %2!S! %3!d!');
    wide(0x240, 'W\u00e9');
    host.writeMemory(0x250, Uint8Array.from([...'narrow', '\0'].map(c=>c.charCodeAt(0))));
    host.writeMemory(0x280, new Uint8Array(Uint32Array.from([0x240, 0x250, -7]).buffer));

    assert.equal(fns.FormatMessageW.argBytes, 28);
    assert.equal(fns.FormatMessageW.handler([0x400 | 0x2000, 0x200, 0, 0, 0x300, 0x40, 0x280]), 12);
    assert.equal(readBack(0x300, 13), 'W\u00e9 narrow -7\0');
    assert.equal(fns.FormatMessageW.handler([0x400 | 0x2000, 0x200, 0, 0, 0x300, 12, 0x280]), 0,
        'nSize counts characters, the terminator among them');

    const length = fns.FormatMessageA.handler([0x1000, 0, 2, 0, 0x500, 0x80, 0]);
    assert.ok(length > 0);
    assert.equal(fns.FormatMessageW.handler([0x1000 | 0x100, 0, 2, 0, 0x2f0, 0, 0]), length);
    assert.equal(host.view.getUint32(0x2f0, true), 0x400, 'the allocated buffer');
    assert.equal(readBack(0x400, length),
        String.fromCharCode(...host.bytes.slice(0x500, 0x500 + length)), 'the same system text');
});

test('the undecorated lstr names are the ANSI entries themselves', ()=>{
    const fns = /** @type {any} */ (createSystemFunctions(fakeHost()));
    for (const name of ['lstrcat', 'lstrcmp', 'lstrcmpi', 'lstrcpy', 'lstrcpyn', 'lstrlen'])
    {
        assert.equal(fns[name], fns[`${name}A`], name);
    }
    const host = fakeHost();
    const own = /** @type {any} */ (createSystemFunctions(host));
    host.bytes.set([0x61, 0x62, 0x63, 0], 0x200);
    assert.equal(own.lstrlen.handler([0x200]), 3);
    assert.equal(own.lstrcpy.handler([0x300, 0x200]), 0x300);
    assert.equal(own.lstrcmp.handler([0x300, 0x200]), 0);
});

test('the priority boost a thread disables is the one it reads back', ()=>{
    const host = fakeHost();
    const fns = /** @type {any} */ (createSystemFunctions(host));
    const CURRENT_THREAD = 0xfffffffe;
    assert.equal(fns.SetThreadPriorityBoost.argBytes, 8);
    assert.equal(fns.GetThreadPriorityBoost.handler([CURRENT_THREAD, 0x200]), 1);
    assert.equal(host.view.getUint32(0x200, true), 0, 'boosted until asked otherwise');
    assert.equal(fns.SetThreadPriorityBoost.handler([CURRENT_THREAD, 1]), 1);
    assert.equal(fns.GetThreadPriorityBoost.handler([CURRENT_THREAD, 0x200]), 1);
    assert.equal(host.view.getUint32(0x200, true), 1);

    assert.equal(fns.SetThreadPriorityBoost.handler([0x55, 1]), 0);
    assert.equal(host.errors.at(-1), ERROR_INVALID_HANDLE);
    assert.equal(fns.GetThreadPriorityBoost.handler([CURRENT_THREAD, 0]), 0);
    assert.equal(host.errors.at(-1), 998, 'ERROR_NOACCESS for no place to write');
});

test('SetThreadExecutionState answers the lasting request before the call', ()=>{
    const host = fakeHost();
    const fns = /** @type {any} */ (createSystemFunctions(host));
    const ES_SYSTEM_REQUIRED = 1;
    const ES_DISPLAY_REQUIRED = 2;
    const ES_CONTINUOUS = 0x80000000;
    const call = (/** @type {number} */ flags)=>fns.SetThreadExecutionState.handler([flags]);
    assert.equal(call(ES_CONTINUOUS | ES_DISPLAY_REQUIRED), ES_CONTINUOUS >>> 0,
        'a thread that never asked holds ES_CONTINUOUS alone');
    assert.equal(call(ES_SYSTEM_REQUIRED), (ES_CONTINUOUS | ES_DISPLAY_REQUIRED) >>> 0);
    assert.equal(call(ES_CONTINUOUS), (ES_CONTINUOUS | ES_DISPLAY_REQUIRED) >>> 0,
        'a nudge without ES_CONTINUOUS left the lasting request alone');
    assert.equal(call(ES_CONTINUOUS), ES_CONTINUOUS >>> 0);

    assert.equal(call(0x40), 0, 'away mode is not Windows XP\'s');
    assert.equal(host.errors.at(-1), 87);
});

test('FindActCtxSectionString is absent, as no activation context is built', ()=>{
    // Twice now a lookup answering "not found" stopped programs before their first
    // instruction: the Visual C++ 2005 runtime (msvcr80, vcomp) finds the function through
    // GetProcAddress, takes the answer for a load without its manifest and raises R6034 --
    // Gothic 3 at vcomp.dll. Absent, the runtime takes the system for one without
    // side-by-side support and goes on. Building activation contexts from manifests is
    // what would let it be present.
    const fns = /** @type {any} */ (createSystemFunctions(fakeHost()));
    for (const name of ['FindActCtxSectionStringA', 'FindActCtxSectionStringW'])
    {
        assert.equal(fns[name], undefined, `${name} is not exported`);
    }
});

test('win.ini is not kernel32\'s table to answer', ()=>{
    const fns = /** @type {any} */ (createSystemFunctions(fakeHost()));
    assert.equal(fns.GetProfileStringA, undefined,
        'win.ini is the profile functions\' to answer, not a fixed default here');
});
