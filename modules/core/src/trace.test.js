/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureTrace, describeAddress, formatTrace } from './trace.js';

const IMAGE = 0x400000;
const THUNKS = 0x200000;
const STACK = 0x2f0000;

/**
 * A machine that has just gone wrong, stood in for. The layout is the one a
 * real process gets: an image, the stub table, and a stack under it.
 *
 * @param {Object} [options]
 * @param {Record<number, number>} [options.stack]  What the guest stack holds.
 * @param {Record<string, number>} [options.registers]
 */
function machine({ stack = {}, registers = {} } = {}){
    const regions = [
        { name: 'image', base: IMAGE, size: 0x2000, kind: 'image' },
        { name: 'thunks', base: THUNKS, size: 0x100, kind: 'thunk_code' },
        { name: 'stack', base: STACK, size: 0x10000, kind: 'stack' },
    ];

    /** @type {Record<string, number>} */
    const values = { eax: 1, ebx: 2, ecx: 3, edx: 4, esi: 5, edi: 6,
        ebp: 0, esp: STACK + 0x8000, ...registers };

    return {
        cpu: {
            eip: ()=>IMAGE + 0x1040,
            /** @param {string} name */
            readReg32: name=>values[name] ?? 0,
            instructionCount: ()=>12345,
            inProtectedMode: ()=>true,
        },
        memory: {
            /** @param {number} address */
            find: address=>regions.find(
                region=>address >= region.base && address < region.base + region.size),
            /** @param {number} address */
            readU32(address){
                if (!(address in stack))
                {
                    if (address >= STACK && address < STACK + 0x10000)
                    {
                        return 0;
                    }
                    throw new Error(`Unmapped read at ${address.toString(16)}`);
                }
                return stack[address];
            },
        },
        kernel: {
            currentThread: ()=>({ id: 1, name: 'main', state: 'running' }),
            diagnosticsSnapshot: ()=>({ threads: 1, waiting: [] }),
        },
        bridge: {
            /** @param {number} address */
            symbolize: address=>address === THUNKS + 0x20 ? 'KERNEL32.dll!WriteFile' : null,
            chain: ()=>['msvcrt.dll!qsort'],
            recent: ()=>['KERNEL32.dll!GetStdHandle', 'msvcrt.dll!qsort'],
        },
    };
}

test('an address inside the image is reported as an RVA', ()=>{
    const sources = machine();
    // The RVA is the number a disassembler of the same binary agrees with, so
    // it goes in the report rather than being left to the reader.
    assert.equal(describeAddress(sources, IMAGE + 0x1040),
        '0x00401040 image+0x00001040 (rva 0x00001040)');
});

test('an address that is one of our stubs is reported by name', ()=>{
    const sources = machine();
    assert.equal(describeAddress(sources, THUNKS + 0x20),
        '0x00200020 KERNEL32.dll!WriteFile');
});

test('an address in nothing at all says so instead of guessing', ()=>{
    const sources = machine();
    assert.equal(describeAddress(sources, 0x99999999), '0xffffffff <unmapped>'.replace(
        'ffffffff', '99999999'));
});

test('a trace says where, on what, and inside which of our calls', ()=>{
    const trace = captureTrace(machine());

    assert.equal(trace.eip, IMAGE + 0x1040);
    assert.match(trace.at, /image\+0x00001040/);
    assert.equal(trace.registers.esp, STACK + 0x8000);
    assert.deepEqual(trace.thread, { id: 1, name: 'main', state: 'running' });
    assert.deepEqual(trace.hostCalls, ['msvcrt.dll!qsort'],
        'the host function that was running when it failed');
    assert.equal(trace.instructions, 12345);
});

test('the stack walk finds return addresses and ignores everything else', ()=>{
    const esp = STACK + 0x8000;
    const trace = captureTrace(machine({
        registers: { esp, ebp: esp + 0x10 },
        stack: {
            [esp]: 0xdeadbeef, //          not an address at all
            [esp + 4]: IMAGE + 0x1200, //  a way back into the program
            [esp + 8]: 42, //              data
            [esp + 0x10]: esp + 0x20, //   frame link
            [esp + 0x14]: IMAGE + 0x1300, // its return address
            [esp + 0x20]: 0, //            chain ends
        },
    }));

    const rendered = trace.stack.join('\n');
    assert.match(rendered, /frame chain:/);
    assert.match(rendered, /image\+0x00001300/, 'the frame pointer chain was followed');
    assert.match(rendered, /image\+0x00001200/, 'and the scan found what the chain missed');
    assert.doesNotMatch(rendered, /deadbeef/, 'a value that is not code is not a frame');
});

test('a trace is taken even when the machine cannot answer', ()=>{
    const sources = machine();
    sources.cpu.eip = ()=>{
        throw new Error('the emulator is gone');
    };

    // A diagnostic that throws while diagnosing takes the diagnosis with it.
    const trace = captureTrace(sources);
    assert.match(trace.cpuUnavailable, /the emulator is gone/);
    assert.deepEqual(trace.hostCalls, ['msvcrt.dll!qsort'], 'the rest still arrived');
});

test('the rendered form leads with the answer', ()=>{
    const text = formatTrace(captureTrace(machine()));
    const lines = text.split('\n');

    assert.match(lines[0], /^at 0x00401040 image/);
    assert.match(text, /thread main \(running\)/);
    assert.match(text, /inside: msvcrt\.dll!qsort/);
    assert.match(text, /last calls: KERNEL32\.dll!GetStdHandle, msvcrt\.dll!qsort/);
});
