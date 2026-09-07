/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TLS_SLOTS, createProcessFunctions } from './process.js';

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

function fakeHost(){
    const bytes = new Uint8Array(0x2000);
    const view = new DataView(bytes.buffer);
    const threads = {
        first: { id: 0x100 },
        second: { id: 0x104 },
    };
    /** @type {number[]} */
    const sleeps = [];
    const clock = { uptimeMs: 0, wallMs: 0 };
    /** @type {any} */
    let current = threads.first;

    const host = {
        bytes,
        view,
        threads,
        sleeps,
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
    };
    return host;
}

/** The token a parked call answers with; identity is all that matters. */
const PARKED = Symbol('parked');

function setup(){
    const host = fakeHost();
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
