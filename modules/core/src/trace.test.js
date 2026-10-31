/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
 * @param {string[]} [options.waiting]  What each blocked thread is waiting on.
 * @param {any[]} [options.threads]  The others, as the kernel keeps them.
 */
function machine({ stack = {}, registers = {}, waiting = [], threads = [] } = {}){
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
            diagnosticsSnapshot: ()=>({ threads: 1, waiting }),
            threads: ()=>threads,
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
        throw new Error('the machine is gone');
    };

    // A diagnostic that throws while diagnosing takes the diagnosis with it.
    const trace = captureTrace(sources);
    assert.match(trace.cpuUnavailable, /the machine is gone/);
    assert.deepEqual(trace.hostCalls, ['msvcrt.dll!qsort'], 'the rest still arrived');
});

test('the rendered form leads with the answer', ()=>{
    const text = formatTrace(captureTrace(machine()));
    const lines = text.split('\n');

    assert.match(lines[0], /^at 0x00401040 image/);
    assert.match(text, /thread main \(running\)/);
    assert.match(text, /inside: msvcrt\.dll!qsort/);
    assert.match(text, /last calls: KERNEL32\.dll!GetStdHandle, msvcrt\.dll!qsort/);
    assert.doesNotMatch(text, /^waiting:/m, 'and says nothing about waiting when nobody is');
});

test('a fault is reported where the guest was, not where the stub is', ()=>{
    // The report used to read the live processor, which by then is standing in
    // the ROM stub behind the vector: it named our own code as the place the
    // program crashed, showed the trap number as EAX, and could not even read
    // the bytes there. The only record of where the guest was is the frame the
    // processor pushed.
    const sources = machine();
    // Where the stub reports from, which is what the live processor says.
    sources.cpu.eip = ()=>0x000f07db;
    const trace = captureTrace({
        ...sources,
        fault: { vector: 13, name: 'general protection', eip: IMAGE + 0x1200, errorCode: 0x10 },
    });

    assert.equal(trace.eip, IMAGE + 0x1200);
    assert.match(trace.at, /image\+0x00001200/, 'the instruction that faulted');
    assert.match(trace.stoppedAt, /0x000f07db/, 'and the stub, kept and named apart');

    const text = formatTrace(trace);
    assert.match(text, /^at 0x00401200 image/);
    assert.match(text, /stopped in 0x000f07db/);
    assert.match(text, /eax and edx are the fault stub's/);
});

test('with no fault the report is simply where the processor is', ()=>{
    const text = formatTrace(captureTrace(machine()));
    assert.doesNotMatch(text, /stopped in/);
    assert.doesNotMatch(text, /fault stub/);
});

test('a fault the host raised does not claim an exception frame it never had', ()=>{
    // From inside a call the processor is left in the park loop and the
    // registers are the call's own; for a fault that stands in for one the
    // processor could not deliver, nothing was pushed at all. Either way the
    // stub's note would send a reader looking for a frame that is not there.
    const sources = machine();
    sources.cpu.eip = ()=>0x00100001;
    const raised = formatTrace(captureTrace({
        ...sources,
        fault: { vector: -1, name: 'unimplemented import', eip: IMAGE + 0x1200,
            errorCode: null, detail: 'unimplemented import X.dll!Y' },
    }));
    assert.match(raised, /^at 0x00401200 image/);
    assert.match(raised, /stopped in 0x00100001/);
    assert.match(raised, /eax is the stub's answer and edx the trap port/);
    assert.doesNotMatch(raised, /exception frame;/);

    const undelivered = formatTrace(captureTrace({
        ...sources,
        fault: { vector: 8, name: 'double fault', eip: IMAGE + 0x1200,
            errorCode: 0, detail: 'double fault at 0x00401200' },
    }));
    assert.match(undelivered, /no exception frame was pushed; every register is the guest's/);
});

test('a stalled machine names every blocked thread and what it waits on', ()=>{
    // The one report that could not be read: a parked thread's registers
    // describe the park loop and nothing else, so the list of what nobody is
    // signalling is the only part that names the failure.
    const text = formatTrace(captureTrace(machine({
        waiting: ['thread-3: WaitForSingleObject on 0x1c', 'thread-5: message queue'],
    })));

    assert.match(text, /^waiting:$/m);
    assert.match(text, /^ {2}thread-3: WaitForSingleObject on 0x1c$/m);
    assert.match(text, /^ {2}thread-5: message queue$/m);
});

test('every other thread\'s stack is read from where it stopped, past a kilobyte of locals', ()=>{
    // Two threads passing a lock back and forth: each is parked in a routine
    // that keeps a kilobyte on its stack, and the loop that keeps calling it
    // is the frame above.
    const parked = STACK + 0x4000;
    const table = Object.fromEntries(Array.from({ length: 12 },
        (_, i)=>[parked + 0x40 + i * 4, IMAGE + 0x1600]));
    const text = formatTrace(captureTrace(machine({
        stack: { ...table, [parked + 0x408]: IMAGE + 0x1500 },
        threads: [
            { name: 'thread-18', state: 'blocked', resumeStack: parked, stackTop: STACK + 0x10000,
                context: { reg32: [0, 0, 0, 0, STACK + 0x100, 0, 0, 0] } },
            { name: 'thread-9', state: 'terminated',
                context: { reg32: [0, 0, 0, 0, parked, 0, 0, 0] } },
        ],
    })));

    const own = text.slice(text.indexOf('thread thread-18 (blocked):'));
    assert.ok(own.length < text.length, 'the parked thread has a section of its own');
    assert.match(own, /image\+0x00001500/, 'the caller above a kilobyte of locals is found');
    assert.equal(own.match(/image\+0x00001600/g)?.length, 1, 'a run of one stale pointer is one entry');
    assert.doesNotMatch(text, /thread-9/, 'a thread that ended has no stack to read');
});

test('the scan keeps what follows a call and drops pointers to data and to functions', ()=>{
    const esp = STACK + 0x8000;
    const fixture = machine({
        stack: {
            [esp]: IMAGE + 0x1200, //      after `call rel32`
            [esp + 4]: IMAGE + 0x1300, //  after `call [disp32]`
            [esp + 8]: IMAGE + 0x1400, //  after `call eax`
            [esp + 12]: IMAGE + 0x1500, // a table in the image, after nothing callable
        },
    });
    const code = new Uint8Array(0x2000);
    code.set([0xe8, 1, 2, 3, 4], 0x1200 - 5);
    code.set([0xff, 0x15, 1, 2, 3, 4], 0x1300 - 6);
    code.set([0xff, 0xd0], 0x1400 - 2);
    code.set([0x8b, 0x45, 0x08, 0x90, 0x90, 0x90, 0x90], 0x1500 - 7);
    const memory = /** @type {any} */ (fixture.memory);
    memory.readBytes = (/** @type {number} */ address, /** @type {number} */ length)=>
        code.subarray(address - IMAGE, address - IMAGE + length);

    const rendered = captureTrace(fixture).stack.join('\n');
    assert.match(rendered, /image\+0x00001200/);
    assert.match(rendered, /image\+0x00001300/);
    assert.match(rendered, /image\+0x00001400/);
    assert.doesNotMatch(rendered, /image\+0x00001500/, 'nothing calls to land there');
});
