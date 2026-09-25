/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEB } from './teb.js';
import {
    CLOCK, TLS_SLOTS, createProcessFunctions, getLastErrorCode, queryPerformanceCounterCode,
    queryPerformanceFrequencyCode, setLastErrorCode, tickCountCode, tlsGetValueCode,
} from './process.js';

const TLS_OUT_OF_INDEXES = 0xffffffff;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_MOD_NOT_FOUND = 126;
const VER_PLATFORM_WIN32_NT = 2;
const OSVERSIONINFOA_SIZE = 148;
const OSVERSIONINFOEXA_SIZE = 156;
const IMAGE_BASE = 0x00400000;

/** 100ns units between 1601-01-01 and 1970-01-01, the FILETIME epoch shift. */
const FILETIME_AT_UNIX_EPOCH = 116444736000000000n;

/**
 * @param {Object} [options]
 * @param {number} [options.arena]  Guest memory for the fast paths and their
 *     blocks, past the first pages the tests write structures into. Without it
 *     the host has no allocator and nowhere to publish a clock, which is the
 *     build where every clock export stays a trap.
 */
function fakeHost({ arena = 0 } = {}){
    const bytes = new Uint8Array(0x2000 + arena);
    const view = new DataView(bytes.buffer);
    /** @type {{ first: { id: number, tebAddress?: number }, second: { id: number, tebAddress?: number } }} */
    const threads = {
        first: { id: 0x100 },
        second: { id: 0x104 },
    };
    /** @type {number[]} */
    const sleeps = [];
    /** What the engine was handed to keep the clock block current. */
    /** @type {(() => void)[]} */
    const refreshes = [];
    let free = 0x2000;
    const clock = { uptimeMs: 0, wallMs: 0 };
    /** @type {any} */
    let current = threads.first;

    const host = {
        bytes,
        view,
        threads,
        sleeps,
        refreshes,
        clock,
        /** @param {any} thread */
        run: thread=>{
            current = thread;
        },
        processId: 0x2a4,
        currentThread: ()=>current,
        now: ()=>clock.uptimeMs,
        systemTimeMs: ()=>clock.wallMs,
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory(address, data){
            for (let i = 0; i < data.length; i++)
            {
                bytes[address + i] = data[i];
            }
        },
        /** @param {number} address @param {number} maxLength */
        readCString(address, maxLength){
            let text = '';
            for (let i = 0; i < maxLength && address + i < bytes.length; i++)
            {
                if (bytes[address + i] === 0)
                {
                    break;
                }
                text += String.fromCharCode(bytes[address + i]);
            }
            return text;
        },
        /** @param {string | null} name */
        moduleHandle: name=>(name === null || name.toLowerCase() === 'app.exe' ? IMAGE_BASE : 0),
        /** @param {number} milliseconds */
        sleep: milliseconds=>sleeps.push(milliseconds),
        park: ()=>PARKED,
        ...arena === 0 ? {} : {
            /** @param {number} size */
            allocate: size=>{
                const at = free;
                free += size;
                assert.ok(free <= bytes.length, 'the fixture arena is big enough');
                return at;
            },
            /** @param {() => void} refresh */
            publishClock: refresh=>refreshes.push(refresh),
        },
    };
    return host;
}

/** The token a parked call answers with; identity is all that matters. */
const PARKED = Symbol('parked');

/** @param {{ arena?: number }} [options] */
function setup(options = {}){
    const host = fakeHost(options);
    const fns = createProcessFunctions(host);

    /** @param {number} address @param {string} text */
    const put = (address, text)=>{
        for (let i = 0; i < text.length; i++)
        {
            host.bytes[address + i] = text.charCodeAt(i);
        }
        host.bytes[address + text.length] = 0;
        return address;
    };

    /** @param {number} address */
    const u64 = address=>host.view.getBigUint64(address, true);

    return { host, fns, put, u64 };
}

test('the last error belongs to the thread that set it', ()=>{
    const { host, fns } = setup();

    fns.SetLastError.handler([5]);
    assert.equal(fns.GetLastError.handler(), 5);

    host.run(host.threads.second);
    assert.equal(fns.GetLastError.handler(), 0,
        'a thread that has failed at nothing has no error to report');
    fns.SetLastError.handler([87]);

    host.run(host.threads.first);
    assert.equal(fns.GetLastError.handler(), 5,
        'one shared slot would hand a thread somebody else failure');
});

test('TLS values are per thread, in the same slot', ()=>{
    const { host, fns } = setup();

    const slot = fns.TlsAlloc.handler();
    assert.notEqual(slot, TLS_OUT_OF_INDEXES);
    assert.equal(fns.TlsSetValue.handler([slot, 0x1111]), 1);

    host.run(host.threads.second);
    assert.equal(fns.TlsGetValue.handler([slot]), 0,
        'the slot exists for every thread, its contents do not');
    fns.TlsSetValue.handler([slot, 0x2222]);

    host.run(host.threads.first);
    assert.equal(fns.TlsGetValue.handler([slot]), 0x1111);
});

test('a reallocated slot reads as zero rather than as its previous tenant', ()=>{
    const { host, fns } = setup();

    const slot = fns.TlsAlloc.handler();
    fns.TlsSetValue.handler([slot, 0xdead]);
    host.run(host.threads.second);
    fns.TlsSetValue.handler([slot, 0xbeef]);
    assert.equal(fns.TlsFree.handler([slot]), 1);

    const again = fns.TlsAlloc.handler();
    assert.equal(again, slot, 'a freed index is reused, which is what makes this a hazard');
    assert.equal(fns.TlsGetValue.handler([again]), 0);
    host.run(host.threads.first);
    assert.equal(fns.TlsGetValue.handler([again]), 0,
        'the other thread\'s stale value must not surface either');
});

test('TlsAlloc reports exhaustion instead of handing out an index it does not have', ()=>{
    const { fns } = setup();

    for (let i = 0; i < TLS_SLOTS; i++)
    {
        assert.notEqual(fns.TlsAlloc.handler(), TLS_OUT_OF_INDEXES);
    }

    assert.equal(fns.TlsAlloc.handler(), TLS_OUT_OF_INDEXES);
});

test('an index nobody allocated fails and says why', ()=>{
    const { fns } = setup();

    assert.equal(fns.TlsGetValue.handler([3]), 0);
    assert.equal(fns.GetLastError.handler(), ERROR_INVALID_PARAMETER);

    assert.equal(fns.TlsSetValue.handler([TLS_SLOTS]), 0);
    assert.equal(fns.GetLastError.handler(), ERROR_INVALID_PARAMETER);

    assert.equal(fns.TlsFree.handler([3]), 0);
    assert.equal(fns.GetLastError.handler(), ERROR_INVALID_PARAMETER);
});

test('a successful TlsGetValue clears the last error', ()=>{
    const { fns } = setup();
    const slot = fns.TlsAlloc.handler();
    fns.SetLastError.handler([87]);

    assert.equal(fns.TlsGetValue.handler([slot]), 0);
    assert.equal(fns.GetLastError.handler(), 0,
        'a zero slot is indistinguishable from failure unless the error is cleared');
});

test('GetVersion packs the fields the way a program takes them apart', ()=>{
    const { fns } = setup();

    const packed = fns.GetVersion.handler() >>> 0;

    assert.equal(packed & 0xff, 5, 'major version in the low byte');
    assert.equal((packed >>> 8) & 0xff, 1, 'minor version in the next byte');
    assert.equal((packed >>> 16) & 0x7fff, 2600, 'build number in the high word');
    assert.equal(packed >>> 31, 0, 'the top bit clear is how NT is told from 9x');
});

test('GetVersionExA fills the structure it was handed', ()=>{
    const { host, fns } = setup();
    const address = 0x100;
    host.view.setUint32(address, OSVERSIONINFOA_SIZE, true);

    assert.equal(fns.GetVersionExA.handler([address]), 1);

    assert.equal(host.view.getUint32(address, true), OSVERSIONINFOA_SIZE,
        'the caller\'s own size field is left alone');
    assert.equal(host.view.getUint32(address + 4, true), 5);
    assert.equal(host.view.getUint32(address + 8, true), 1);
    assert.equal(host.view.getUint32(address + 12, true), 2600);
    assert.equal(host.view.getUint32(address + 16, true), VER_PLATFORM_WIN32_NT);
    assert.equal(host.bytes[address + 20], 0, 'no service pack, so an empty string');
});

test('GetVersionExA refuses a size it does not recognise', ()=>{
    const { host, fns } = setup();
    const address = 0x200;
    host.view.setUint32(address, 64, true);
    host.bytes[address + 4] = 0x77;

    assert.equal(fns.GetVersionExA.handler([address]), 0);
    assert.equal(fns.GetLastError.handler(), ERROR_INSUFFICIENT_BUFFER);
    assert.equal(host.bytes[address + 4], 0x77, 'nothing is written into a structure we refused');
});

test('GetVersionExA zeroes the extended fields when the caller asks for them', ()=>{
    const { host, fns } = setup();
    const address = 0x300;
    host.bytes.fill(0xcd, address, address + OSVERSIONINFOEXA_SIZE);
    host.view.setUint32(address, OSVERSIONINFOEXA_SIZE, true);

    assert.equal(fns.GetVersionExA.handler([address]), 1);

    assert.equal(host.view.getUint16(address + 148, true), 0, 'wServicePackMajor');
    assert.equal(host.view.getUint16(address + 150, true), 0, 'wServicePackMinor');
    assert.equal(host.view.getUint16(address + 152, true), 0, 'wSuiteMask');
    assert.equal(host.bytes[address + 154], 1, 'wProductType is VER_NT_WORKSTATION');
});

test('time comes from the injected clock, not from the host', ()=>{
    const { host, fns, u64 } = setup();
    const counter = 0x400;

    host.clock.uptimeMs = 1500;
    assert.equal(fns.GetTickCount.handler(), 1500);

    assert.equal(fns.QueryPerformanceFrequency.handler([counter]), 1);
    const frequency = u64(counter);
    assert.ok(frequency > 0n);

    assert.equal(fns.QueryPerformanceCounter.handler([counter]), 1);
    const first = u64(counter);
    host.clock.uptimeMs = 2500;
    fns.QueryPerformanceCounter.handler([counter]);
    const second = u64(counter);

    assert.equal(second - first, frequency,
        'one second of guest time is one frequency worth of ticks');
});

test('GetSystemTimeAsFileTime writes 100ns units since 1601', ()=>{
    const { host, fns, u64 } = setup();
    const filetime = 0x500;

    fns.GetSystemTimeAsFileTime.handler([filetime]);
    assert.equal(u64(filetime), FILETIME_AT_UNIX_EPOCH);

    host.clock.wallMs = 1000;
    fns.GetSystemTimeAsFileTime.handler([filetime]);
    assert.equal(u64(filetime), FILETIME_AT_UNIX_EPOCH + 10_000_000n);
});

test('Sleep stops the thread, and a zero sleep yields instead', ()=>{
    const { host, fns } = setup();

    // A real wait: the caller is parked, and the scheduler answers it once the
    // guest's clock has moved far enough.
    assert.equal(fns.Sleep.handler([250]), PARKED);

    // Zero is a program offering its turn, not asking for time. Parking on it
    // would be the same thing at the cost of a context switch.
    assert.equal(fns.Sleep.handler([0]), 0);

    assert.deepEqual(host.sleeps, [250], 'and only the real wait reached the scheduler');
});

test('the identity queries answer for the thread that is running', ()=>{
    const { host, fns } = setup();

    assert.equal(fns.GetCurrentThreadId.handler(), 0x100);
    host.run(host.threads.second);
    assert.equal(fns.GetCurrentThreadId.handler(), 0x104);

    assert.equal(fns.GetCurrentProcessId.handler(), 0x2a4);
    assert.equal(fns.GetCurrentProcess.handler() >>> 0, 0xffffffff,
        'the pseudo-handle, which is what every process-wide call is passed');
});

test('GetModuleHandleA answers for the image itself and fails for what is not loaded', ()=>{
    const { fns, put } = setup();

    assert.equal(fns.GetModuleHandleA.handler([0]), IMAGE_BASE, 'NULL means the running image');
    assert.equal(fns.GetModuleHandleA.handler([put(0x600, 'app.exe')]), IMAGE_BASE);

    assert.equal(fns.GetModuleHandleA.handler([put(0x700, 'nowhere.dll')]), 0);
    assert.equal(fns.GetLastError.handler(), ERROR_MOD_NOT_FOUND);
});

test('every function declares the stack it pops', ()=>{
    const { fns } = setup();
    // stdcall: the callee cleans up, so a wrong count corrupts the guest stack
    // silently. These are the documented signatures, in bytes.
    assert.equal(fns.SetLastError.argBytes, 4);
    assert.equal(fns.GetLastError.argBytes, 0);
    assert.equal(fns.GetCurrentThreadId.argBytes, 0);
    assert.equal(fns.GetCurrentProcessId.argBytes, 0);
    assert.equal(fns.GetCurrentProcess.argBytes, 0);
    assert.equal(fns.GetModuleHandleA.argBytes, 4);
    assert.equal(fns.GetVersion.argBytes, 0);
    assert.equal(fns.GetVersionExA.argBytes, 4);
    assert.equal(fns.GetTickCount.argBytes, 0);
    assert.equal(fns.GetSystemTimeAsFileTime.argBytes, 4);
    assert.equal(fns.QueryPerformanceCounter.argBytes, 4);
    assert.equal(fns.QueryPerformanceFrequency.argBytes, 4);
    assert.equal(fns.Sleep.argBytes, 4);
    assert.equal(fns.TlsAlloc.argBytes, 0);
    assert.equal(fns.TlsFree.argBytes, 4);
    assert.equal(fns.TlsGetValue.argBytes, 4);
    assert.equal(fns.TlsSetValue.argBytes, 8);
});

test('fibre-local storage is thread-local storage under other names', ()=>{
    // A machine with no fibres has exactly one fibre per thread, so the two are
    // the same store. A runtime looks the Fls names up at run time and takes a
    // less-travelled fallback path when they are absent.
    const { fns: table } = setup();

    const slot = table.FlsAlloc.handler([0]);
    assert.notEqual(slot, 0xffffffff, 'a slot was handed out');
    assert.equal(table.FlsSetValue.handler([slot, 0x1234]), 1);
    assert.equal(table.FlsGetValue.handler([slot]), 0x1234);
    assert.equal(table.TlsGetValue.handler([slot]), 0x1234,
        'and it is the same store the thread-local names see');
    assert.equal(table.FlsFree.handler([slot]), 1);
});

test('a decoded pointer is the pointer that was encoded', ()=>{
    // The pair is a contract with itself and nothing else. What a program
    // requires is that decoding what it encoded gives the pointer back; the
    // obfuscation in between protects a pointer sitting in memory from
    // something that finds it, and there is nothing here to hide it from.
    const { fns: table } = setup();

    for (const pointer of [0, 1, 0x00401000, 0xffffffff])
    {
        assert.equal(table.DecodePointer.handler([table.EncodePointer.handler([pointer])]),
            pointer >>> 0);
    }
});

test('a thread with a block keeps its last error in the block', ()=>{
    // GetLastError and SetLastError run as guest code reading the block
    // through FS, so what the host writes has to be there, and what the
    // guest writes has to be what the host reads back.
    const host = fakeHost();
    const teb = 0x1000;
    host.threads.first.tebAddress = teb;
    const fns = createProcessFunctions(host);
    assert.equal(fns.SetLastError.handler([0x57]), 0);
    assert.equal(host.view.getUint32(teb + TEB.LAST_ERROR, true), 0x57, 'written to the block');
    host.view.setUint32(teb + TEB.LAST_ERROR, 0x7e, true);
    assert.equal(fns.GetLastError.handler(), 0x7e, 'read from the block');
    host.run(host.threads.second);
    assert.equal(fns.GetLastError.handler(), 0, 'a thread without a block keeps its own');
});

test('freeing a slot zeroes it in the block of every thread', ()=>{
    // The guest-side TlsGetValue reads the block and has no generation to
    // compare against, so a freed slot has to read as zero everywhere at once.
    const host = fakeHost();
    const blocks = { first: 0x1100, second: 0x1300 };
    host.threads.first.tebAddress = 0x1000;
    host.threads.second.tebAddress = 0x1200;
    host.view.setUint32(0x1000 + TEB.TLS_POINTER, blocks.first, true);
    host.view.setUint32(0x1200 + TEB.TLS_POINTER, blocks.second, true);
    const fns = createProcessFunctions({
        ...host,
        allThreads: ()=>[host.threads.first, host.threads.second],
        tlsBlock: ()=>host.view.getUint32(host.currentThread().tebAddress + TEB.TLS_POINTER, true),
    });
    const slot = fns.TlsAlloc.handler();
    assert.equal(fns.TlsSetValue.handler([slot, 0x11]), 1);
    host.run(host.threads.second);
    assert.equal(fns.TlsSetValue.handler([slot, 0x22]), 1);
    assert.equal(host.view.getUint32(blocks.first + slot * 4, true), 0x11);
    assert.equal(host.view.getUint32(blocks.second + slot * 4, true), 0x22);
    assert.equal(fns.TlsFree.handler([slot]), 1);
    assert.equal(host.view.getUint32(blocks.first + slot * 4, true), 0, 'cleared for the first');
    assert.equal(host.view.getUint32(blocks.second + slot * 4, true), 0, 'and for the second');
});

test('the guest-side paths read the block and fall back to the host past it', ()=>{
    // The bytes are checked where they carry an address: the jump the slow
    // path takes to the host's trap, and the offset the fast path skips to it.
    assert.deepEqual([...getLastErrorCode()], [0x64, 0xa1, 0x34, 0, 0, 0, 0xc3]);
    assert.deepEqual([...setLastErrorCode()],
        [0x8b, 0x44, 0x24, 0x04, 0x64, 0xa3, 0x34, 0, 0, 0, 0xc2, 0x04, 0x00]);
    const at = 0x20000;
    const trap = 0x7f000010;
    const code = tlsGetValueCode(at, trap);
    assert.equal(code[7], 0x73, 'jae');
    const slow = 9 + code[8];
    assert.equal(code[slow], 0xe9, 'the slow path is the jump to the trap');
    const rel = new DataView(code.buffer).getInt32(slow + 1, true);
    assert.equal((at + slow + 5 + rel) >>> 0, trap, 'which lands on the trap');
    assert.equal(code[slow - 3], 0xc2, 'the fast path returns just before it');
    assert.equal(code.length, slow + 5);
});

test('the priority and affinity calls pop their own stdcall bytes', ()=>{
    const { fns, host } = setup();
    assert.equal(fns.GetPriorityClass.handler([0xffffffff]), 0x20);
    assert.equal(fns.SetPriorityClass.handler([0xffffffff, 0x80]), 1);
    assert.equal(fns.SetProcessAffinityMask.handler([0xffffffff, 3]), 1);
    assert.equal(fns.GetProcessAffinityMask.handler([0xffffffff, 0x200, 0x204]), 1);
    assert.equal(host.view.getUint32(0x200, true), 1, 'one processor in the process mask');
    assert.equal(host.view.getUint32(0x204, true), 1, 'and in the system mask');

    assert.equal(fns.GetPriorityClass.argBytes, 4);
    assert.equal(fns.SetPriorityClass.argBytes, 8);
    assert.equal(fns.GetProcessAffinityMask.argBytes, 12);
    assert.equal(fns.SetProcessAffinityMask.argBytes, 8);
});

test('a working-set request is accepted and pops its three arguments', ()=>{
    const { fns } = setup();
    assert.equal(fns.SetProcessWorkingSetSize.handler([0xffffffff, 0x100000, 0x800000]), 1);
    assert.equal(fns.SetProcessWorkingSetSize.argBytes, 12);
});

test('the clock routines read one block, and what they read is what a trap would answer', ()=>{
    const at = 0x20000;
    const trap = 0x7f000010;
    const block = 0x31000;

    // The counter is two words of the block, copied into the caller's
    // LARGE_INTEGER; the pointer is the only case left to the host.
    const counter = queryPerformanceCounterCode(at, trap, block);
    const view = new DataView(counter.buffer);
    assert.deepEqual([...counter.slice(0, 6)], [0x8b, 0x4c, 0x24, 0x04, 0x85, 0xc9],
        'the out-pointer, tested');
    assert.equal(counter[6], 0x74, 'jz to the slow path');
    const slow = 8 + counter[7];
    assert.equal(counter[8], 0xa1, 'mov eax, [block]');
    assert.equal(view.getUint32(9, true), block + CLOCK.COUNTER);
    assert.deepEqual([...counter.slice(13, 15)], [0x8b, 0x15]);
    assert.equal(view.getUint32(15, true), block + CLOCK.COUNTER + 4);
    assert.deepEqual([...counter.slice(slow - 3, slow)], [0xc2, 0x04, 0x00],
        'the fast path pops its one argument');
    assert.equal(counter[slow], 0xe9);
    assert.equal((at + slow + 5 + view.getInt32(slow + 1, true)) >>> 0, trap,
        'and the slow path lands on the trap');
    assert.equal(counter.length, slow + 5);

    // The frequency is a constant of this machine, so it is an immediate.
    const frequency = queryPerformanceFrequencyCode(at, trap);
    const constant = new DataView(frequency.buffer);
    assert.deepEqual([...frequency.slice(8, 10)], [0xc7, 0x01]);
    assert.equal(constant.getUint32(10, true), 1_000_000, 'one megahertz');
    assert.deepEqual([...frequency.slice(14, 17)], [0xc7, 0x41, 0x04]);
    assert.equal(constant.getUint32(17, true), 0, 'and nothing in the high word');
    const frequencySlow = 8 + frequency[7];
    assert.equal(frequency[frequencySlow], 0xe9);
    assert.equal((at + frequencySlow + 5 + constant.getInt32(frequencySlow + 1, true)) >>> 0,
        trap);

    // The tick count cannot fail and takes no argument, so it is a read and a
    // return with no case left for the host at all.
    const ticks = tickCountCode(block);
    assert.deepEqual([...ticks], [0xa1,
        ...[0, 8, 16, 24].map(shift=>(block + CLOCK.TICKS) >>> shift & 0xff), 0xc3]);
});

/**
 * The address an export binds to: the guest routine it offers, or the trap
 * that routine would have fallen back to.
 *
 * @param {{ guest?: (builder: import('./sync.js').GuestBuilder) => number }} entry
 * @param {import('./sync.js').GuestBuilder} builder
 */
const boundTo = (entry, builder)=>{
    assert.ok(entry.guest, 'the export offers guest code');
    return entry.guest(builder);
};

test('the clock the guest reads is the one the engine credits', ()=>{
    const { host, fns, u64 } = setup({ arena: 0x4000 });
    const out = 0x400;
    host.clock.uptimeMs = 1500;

    // Binding a clock export is what takes the block and hands the engine the
    // means to keep it current.
    const trap = 0x7f000010;
    /** @type {import('./sync.js').GuestBuilder} */
    const builder = { register: ()=>trap };
    const counter = boundTo(fns.QueryPerformanceCounter, builder);
    assert.notEqual(counter, trap, 'the routine was placed');
    assert.equal(host.refreshes.length, 1, 'and the engine knows how to keep it current');
    assert.notEqual(boundTo(fns.QueryPerformanceFrequency, builder), trap);
    const tickCount = boundTo(fns.GetTickCount, builder);
    assert.equal(host.refreshes.length, 1, 'one block for all of them');

    // One block, and a page of its own: the engine writes it whenever the
    // clock moves, and a write into a page holding compiled code costs the
    // emulator everything it compiled there -- including these routines.
    const block = host.view.getUint32(counter + 9, true) - CLOCK.COUNTER;
    assert.equal(host.view.getUint32(tickCount + 1, true) - CLOCK.TICKS, block,
        'the tick count reads the same block');
    assert.equal(block & 0xfff, 0, 'on a page boundary');
    assert.ok(block >= 0x2000, 'out of the arena, not over the program');

    // What the guest reads is what the host would have answered, to the word.
    assert.equal(fns.QueryPerformanceCounter.handler([out]), 1);
    assert.equal(host.view.getBigUint64(block + CLOCK.COUNTER, true), u64(out));
    assert.equal(host.view.getUint32(block + CLOCK.TICKS, true), fns.GetTickCount.handler());

    // The block moves only when the engine says the clock did, which is what
    // makes the two answers agree: guest time does not pass while the guest is
    // the one running.
    host.clock.uptimeMs = 2500;
    assert.equal(host.view.getUint32(block + CLOCK.TICKS, true), 1500);
    host.refreshes[0]();
    assert.equal(host.view.getUint32(block + CLOCK.TICKS, true), 2500);
    assert.equal(host.view.getBigUint64(block + CLOCK.COUNTER, true), 2_500_000n,
        'one megahertz of ticks for every millisecond credited');
    fns.QueryPerformanceCounter.handler([out]);
    assert.equal(host.view.getBigUint64(block + CLOCK.COUNTER, true), u64(out),
        'and still what a trap would have answered');

    // A clock that is asked again before anything credits it answers the same
    // thing rather than something smaller: a program timing a frame with it
    // must never see time run backwards.
    let last = 0n;
    for (const uptime of [2500, 2500, 2501, 4000, 4000, 9999])
    {
        host.clock.uptimeMs = uptime;
        host.refreshes[0]();
        const now = host.view.getBigUint64(block + CLOCK.COUNTER, true);
        assert.ok(now >= last, `${uptime} did not take the counter backwards`);
        last = now;
    }
});

test('a build with nowhere to publish a clock keeps every clock export a trap', ()=>{
    // The block is the engine's to keep current. Without one, a routine
    // reading it would hand a program a clock that never moves -- so the
    // exports offer no guest code at all and are bound the way they always
    // were, under their own names.
    const { fns } = setup();

    assert.equal(fns.QueryPerformanceCounter.guest, undefined);
    assert.equal(fns.QueryPerformanceFrequency.guest, undefined);
    assert.equal(fns.GetTickCount.guest, undefined);
});

test('the thread-state and clock routines are placed where the host keeps code', ()=>{
    // Code beside data a program writes is code a translator keeps finding
    // stored into; the heap hands out both, the code pages only code.
    const { host, fns } = setup({ arena: 0x4000 });
    /** @type {number[]} */
    const placed = [];
    /** @type {any} */ (host).allocateCode = (/** @type {number} */ size)=>{
        const at = 0x3000 + placed.reduce((sum, one)=>sum + 0x40, 0);
        placed.push(at);
        assert.ok(size <= 0x40);
        return at;
    };
    const builder = { register: ()=>0x105000 };
    const lastError = boundTo(fns.GetLastError, builder);
    const ticks = boundTo(fns.GetTickCount, builder);
    assert.ok(placed.includes(lastError), 'GetLastError from the code pages');
    assert.ok(placed.includes(ticks), 'GetTickCount from the code pages');
});
