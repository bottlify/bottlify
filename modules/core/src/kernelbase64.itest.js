/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a 64-bit allocator asks of the system before its first allocation
 * (mimalloc's start-up does exactly this): kernelbase.dll by name and
 * VirtualAlloc2 from it, ntdll's NtAllocateVirtualMemoryEx, and VirtualQuery
 * of what they gave -- an aligned reservation, the native call's PVOID and
 * SIZE_T written whole, and MEMORY_BASIC_INFORMATION in its 48-byte form.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import { memoryBasicInformation } from './layers/win32/kernel32/heap.js';

/** @param {number} value @returns {number[]} */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {string} text */
const ascii = text=>[...text].map(character=>character.charCodeAt(0)).concat(0);

const ALIGNMENT = 0x400000;

test('MEMORY_BASIC_INFORMATION is laid out by the width of the process', ()=>{
    assert.equal(memoryBasicInformation(4).SIZE, 28);
    assert.equal(memoryBasicInformation(4).RegionSize, 12);
    assert.deepEqual(memoryBasicInformation(8), { BaseAddress: 0, AllocationBase: 8,
        AllocationProtect: 16, RegionSize: 24, State: 32, Protect: 36, Type: 40, SIZE: 48 });
});

test('a 64-bit program finds VirtualAlloc2 in kernelbase.dll and NtAllocateVirtualMemoryEx'
    + ' in ntdll, and both allocate', { timeout: 60000 }, async t=>{
    /** @type {Record<string, number>} */
    const where = {};
    const names = ['kernelbase', 'virtualAlloc2', 'fromApp', 'aligned', 'native', 'status',
        'base', 'size', 'queried', 'information', 'longPaths', 'refused'];
    const program = buildExe({
        bits: 64, codeSize: 0x300,
        imports: { 'KERNEL32.dll': ['LoadLibraryA', 'GetModuleHandleA', 'GetProcAddress',
            'VirtualQuery', 'ExitProcess'] },
        data: {
            kernelbaseName: ascii('kernelbase.dll'), ntdllName: ascii('ntdll.dll'),
            allocName: ascii('VirtualAlloc2'), fromAppName: ascii('VirtualAlloc2FromApp'),
            nativeName: ascii('NtAllocateVirtualMemoryEx'),
            longName: ascii('RtlAreLongPathsEnabled'),
            // MEM_ADDRESS_REQUIREMENTS: no bounds, the alignment
            requirements: [...new Array(16).fill(0), ...u32(ALIGNMENT), 0, 0, 0, 0],
            // MEM_EXTENDED_PARAMETER: MemExtendedParameterAddressRequirements, its pointer
            parameter: [1, 0, 0, 0, 0, 0, 0, 0, ...new Array(8).fill(0)],
            // one of a type there is none of
            unknown: [9, 0, 0, 0, 0, 0, 0, 0, ...new Array(8).fill(0)],
            ...Object.fromEntries(names.map(name=>[name, new Array(64).fill(0x55)])),
        },
        code: ({ iat, at, code })=>{
            names.forEach(name=>{
                where[name] = at(name);
            });
            /** @type {number[]} */
            const bytes = [];
            /** @param {number[]} op @param {number} to */
            const rip = (op, to)=>bytes.push(...op,
                ...u32(to - (code(bytes.length) + op.length + 4)));
            const call = (/** @type {string} */ name)=>rip([0xff, 0x15], iat(name));
            const storeRax = (/** @type {string} */ name)=>rip([0x48, 0x89, 0x05], at(name));
            /** mov qword [rsp+offset], imm32 @param {number} offset @param {number} value */
            const stack = (offset, value)=>bytes.push(0x48, 0xc7, 0x44, 0x24, offset,
                ...u32(value));
            /** lea rax, [name]; mov [rsp+offset], rax @param {number} offset @param {string} name */
            const stackAddress = (offset, name)=>{
                rip([0x48, 0x8d, 0x05], at(name));
                bytes.push(0x48, 0x89, 0x44, 0x24, offset);
            };
            /** VirtualAlloc2(0, 0, 0x10000, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE, list, 1) */
            const allocate2 = (/** @type {string} */ list)=>{
                bytes.push(0x31, 0xc9, 0x31, 0xd2, 0x41, 0xb8, ...u32(0x10000));
                bytes.push(0x41, 0xb9, ...u32(0x3000));
                stack(0x20, 4);
                stackAddress(0x28, list);
                stack(0x30, 1);
                rip([0xff, 0x15], at('virtualAlloc2'));
            };
            bytes.push(0x48, 0x83, 0xec, 0x48); //                         sub rsp, 72
            // The parameter names the requirements.
            rip([0x48, 0x8d, 0x05], at('requirements'));
            rip([0x48, 0x89, 0x05], at('parameter') + 8);
            rip([0x48, 0x8d, 0x0d], at('kernelbaseName'));
            call('LoadLibraryA');
            storeRax('kernelbase');
            bytes.push(0x48, 0x89, 0xc1); //                               mov rcx, rax
            rip([0x48, 0x8d, 0x15], at('allocName'));
            call('GetProcAddress');
            storeRax('virtualAlloc2');
            rip([0x48, 0x8b, 0x0d], at('kernelbase')); //                  mov rcx, [kernelbase]
            rip([0x48, 0x8d, 0x15], at('fromAppName'));
            call('GetProcAddress');
            storeRax('fromApp');
            allocate2('parameter');
            storeRax('aligned');
            allocate2('unknown');
            storeRax('refused');
            rip([0x48, 0x8d, 0x0d], at('ntdllName'));
            call('GetModuleHandleA');
            bytes.push(0x48, 0x89, 0xc3); //                               mov rbx, rax
            bytes.push(0x48, 0x89, 0xc1);
            rip([0x48, 0x8d, 0x15], at('longName'));
            call('GetProcAddress');
            storeRax('longPaths');
            bytes.push(0x48, 0x89, 0xd9); //                               mov rcx, rbx
            rip([0x48, 0x8d, 0x15], at('nativeName'));
            call('GetProcAddress');
            storeRax('native');
            // *base = 0, *size = 0x1800, the high halves left as 0x55
            bytes.push(0xc7, 0x05, ...u32(at('base') - (code(bytes.length) + 10)), ...u32(0));
            bytes.push(0xc7, 0x05, ...u32(at('size') - (code(bytes.length) + 10)),
                ...u32(0x1800));
            // NtAllocateVirtualMemoryEx(-1, &base, &size, 0x3000, 4, NULL, 0)
            bytes.push(0x48, 0xc7, 0xc1, ...u32(0xffffffff)); //           mov rcx, -1
            rip([0x48, 0x8d, 0x15], at('base'));
            rip([0x4c, 0x8d, 0x05], at('size'));
            bytes.push(0x41, 0xb9, ...u32(0x3000));
            stack(0x20, 4);
            stack(0x28, 0);
            stack(0x30, 0);
            rip([0xff, 0x15], at('native'));
            storeRax('status');
            // VirtualQuery(aligned, &information, 48)
            rip([0x48, 0x8b, 0x0d], at('aligned'));
            rip([0x48, 0x8d, 0x15], at('information'));
            bytes.push(0x41, 0xb8, ...u32(48));
            call('VirtualQuery');
            storeRax('queried');
            bytes.push(0x31, 0xc9);
            call('ExitProcess');
            return bytes;
        },
    });
    const app = await createApp({ executable: program, engine: 'cork' });
    t.after(()=>app.dispose());
    assert.equal(await app.run({ timeoutMs: 30000 }), 0);
    /** @param {string} name @param {number} [offset] */
    const quad = (name, offset = 0)=>new DataView(app.debug.read(where[name] + offset, 8)
        .slice().buffer).getBigUint64(0, true);
    assert.notEqual(quad('kernelbase'), 0n, 'kernelbase.dll loads by name');
    assert.notEqual(quad('virtualAlloc2'), 0n, 'and has VirtualAlloc2');
    assert.notEqual(quad('fromApp'), 0n, 'and VirtualAlloc2FromApp');
    const aligned = quad('aligned');
    assert.ok(aligned !== 0n && aligned % BigInt(ALIGNMENT) === 0n,
        `the reservation on the alignment asked for (0x${aligned.toString(16)})`);
    assert.equal(quad('refused'), 0n, 'a parameter of a type there is none of is refused');
    assert.notEqual(quad('longPaths'), 0n, 'ntdll has RtlAreLongPathsEnabled');
    assert.equal(quad('status') & 0xffffffffn, 0n, 'NtAllocateVirtualMemoryEx: STATUS_SUCCESS');
    const base = quad('base');
    assert.ok(base !== 0n && base < 0x100000000n, 'the base written whole');
    assert.equal(quad('size'), 0x2000n, 'the size rounded to pages, written whole');
    assert.equal(quad('queried'), 48n, 'VirtualQuery fills the 64-bit structure');
    assert.equal(quad('information'), aligned, 'BaseAddress at 0');
    assert.equal(quad('information', 24), 0x10000n, 'RegionSize at 24');
    assert.equal(new DataView(app.debug.read(where.information + 32, 4).slice().buffer)
        .getUint32(0, true), 0x1000, 'State at 32: MEM_COMMIT');
});
