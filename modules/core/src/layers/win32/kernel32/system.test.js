/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSystemFunctions } from './system.js';

const ERROR_INVALID_HANDLE = 6;

const FILE_TYPE_UNKNOWN = 0x0000;
const FILE_TYPE_DISK = 0x0001;
const FILE_TYPE_CHAR = 0x0002;

const STILL_ACTIVE = 259;
const CURRENT_PROCESS = 0xffffffff;

/** What the bridge hands back for a call that does not return. */
const PARKED = Object.freeze({ parked: true });

/** 100ns units between 1601-01-01 and 1970-01-01. */
const FILETIME_AT_UNIX_EPOCH = 116_444_736_000_000_000n;

function fakeHost(){
    const bytes = new Uint8Array(0x1000);
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

test('MulDiv keeps the product a caller could not have kept itself', ()=>{
    // The whole point of the call: the intermediate does not fit in 32 bits.
    const host = fakeHost();
    const fns = createSystemFunctions(host);

    assert.equal(fns.MulDiv.handler([1000000, 3000, 2000]), 1500000);
    assert.equal(fns.MulDiv.handler([7, 3, 2]), 11, 'rounded, not truncated');
    assert.equal(fns.MulDiv.handler([1, 1, 0]) | 0, -1, 'a zero divisor is the error value');
    assert.equal(fns.MulDiv.handler([-7, 3, 2]) | 0, -11, 'and it rounds away from zero');
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

test('a running process reports that it is still running', ()=>{
    const host = fakeHost();
    const fns = createSystemFunctions(host);

    assert.equal(fns.GetExitCodeProcess.handler([CURRENT_PROCESS, 0x200]), 1);
    assert.equal(host.view.getUint32(0x200, true), STILL_ACTIVE);

    assert.equal(fns.GetExitCodeProcess.handler([0x10, 0x200]), 0, 'and no such process exists');
    assert.deepEqual(host.errors, [ERROR_INVALID_HANDLE]);
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
    assert.equal(fns.IsProcessorFeaturePresent.handler([99]), 0, 'and nothing unknown');
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
