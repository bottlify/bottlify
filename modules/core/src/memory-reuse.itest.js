/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of a process taking a gone one's memory: what a program reads
 * there is what it reads in a memory just made. A process taking the memory
 * zeroes at its start only what it finds in place, and the heap, the stack
 * pool and the engine's pages as each is handed out (`reusedRanges`,
 * `createHeapAllocator`'s `dirtyTo`); a second path beside zeroing all of it
 * at once, so seeded programs read every block, reservation and thread stack
 * they are given, before writing over it, down both: run alone, and run after
 * another program that wrote over everything it was given.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { assemble, buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
/** @param {string} text */
const ascii = text=>[...text].map(character=>character.charCodeAt(0)).concat(0);

/** @param {number} seed */
const random = seed=>{
    let state = seed >>> 0;
    return ()=>{
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
    };
};

/** What a program's step does: its kind, then two words. */
const Op = Object.freeze({
    /** HeapAlloc(process heap, flags, size) */
    HEAP: 0,
    /** VirtualAlloc(0, size, MEM_RESERVE | MEM_COMMIT) */
    VIRTUAL: 1,
    /** VirtualAlloc(0, size, MEM_RESERVE), then a commit of its first `commit` bytes */
    RESERVE: 2,
    /** HeapFree of the last heap block */
    FREE: 3,
    /** a thread that reads `bytes` of its stack below it, and writes over them with `write` 1 */
    THREAD: 4,
});

/**
 * A seeded program's steps: allocations of every kind, a block freed and
 * handed out again, threads that write over their stacks. Without threads
 * where it is read: a thread's stack and blocks are let go of when it has
 * ended, which on several executors is a matter of time, so where the next
 * stack and block land would be too.
 *
 * @param {number} seed @param {number} steps @param {boolean} threads
 * @returns {number[]} three words a step
 */
function stepsOf(seed, steps, threads){
    const next = random(seed);
    const pick = (/** @type {number} */ from, /** @type {number} */ to)=>
        from + Math.floor(next() * (to - from));
    /** @type {number[]} */
    const words = [];
    for (let step = 0; step < steps; step++)
    {
        const kind = pick(0, threads ? 5 : 4);
        if (kind === Op.HEAP)
        {
            words.push(Op.HEAP, pick(1, next() < 0.5 ? 64 : 65536) * 4, next() < 0.5 ? 0 : 8);
        }
        else if (kind === Op.VIRTUAL)
        {
            words.push(Op.VIRTUAL, pick(1, 256) * 4096, 0);
        }
        else if (kind === Op.RESERVE)
        {
            const reserve = pick(16, 1024) * 4096;
            words.push(Op.RESERVE, reserve, pick(1, reserve / 4096 / 2) * 4096);
        }
        else if (kind === Op.FREE)
        {
            words.push(Op.FREE, 0, 0);
        }
        else
        {
            words.push(Op.THREAD, pick(1, 8) * 1024, 1);
        }
    }
    return words;
}

/**
 * The program that runs the steps (`stepsOf`) and exits with what it read:
 * every block it is handed is read whole into a running hash before it is
 * written over, so the next step handed recycled memory finds it written.
 *
 * @param {number[]} steps
 */
function stepsProgram(steps){
    const THREAD = 0x300;
    const imports = { 'KERNEL32.dll': ['GetProcessHeap', 'HeapAlloc', 'HeapFree', 'VirtualAlloc',
        'CreateThread', 'WaitForSingleObject', 'GetExitCodeThread', 'ExitProcess'] };
    return buildExe({
        imports,
        data: { steps: [...steps.flatMap(u32), ...u32(0xffffffff)], last: u32(0), thread: u32(0),
            code: u32(0) },
        codeSize: 0x400,
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /**
             * ebp = ebp * 31 + dword over ecx dwords from esi, each written over
             * with its own address after it is read unless `write` is false.
             *
             * @param {string} name @param {boolean} [write]
             * @returns {import('../../../tools/fixtures/make-pe.mjs').AsmPart[]}
             */
            const readOver = (name, write = true)=>[
                0x85, 0xc9, { jump: 'jz', to: `${name}-done` }, { label: name },
                0x8b, 0x06, 0x6b, 0xed, 0x1f, 0x01, 0xc5,
                ...write ? [0x89, 0x36] : [], 0x83, 0xc6, 0x04, 0x49,
                { jump: 'jnz', to: name }, { label: `${name}-done` },
            ];
            const main = assemble([
                0xbb, ...u32(at('steps')), 0x31, 0xed,
                { label: 'next' },
                0x8b, 0x03, 0x83, 0xf8, 0xff, { jump: 'jz', to: 'finish' },
                0x83, 0xf8, Op.HEAP, { jump: 'jz', to: 'heap' },
                0x83, 0xf8, Op.VIRTUAL, { jump: 'jz', to: 'virtual' },
                0x83, 0xf8, Op.RESERVE, { jump: 'jz', to: 'reserve' },
                0x83, 0xf8, Op.FREE, { jump: 'jz', to: 'free' },
                { jump: 'jmp', to: 'thread' },
                { label: 'heap' },
                ...call('GetProcessHeap'),
                0xff, 0x73, 0x04, 0xff, 0x73, 0x08, 0x50, ...call('HeapAlloc'),
                0xa3, ...u32(at('last')), 0x89, 0xc6, 0x8b, 0x4b, 0x04, 0xc1, 0xe9, 0x02,
                ...readOver('heap-read'), { jump: 'jmp', to: 'advance' },
                { label: 'virtual' },
                0x6a, 0x04, 0x68, ...u32(0x3000), 0xff, 0x73, 0x04, 0x6a, 0x00,
                ...call('VirtualAlloc'),
                0x89, 0xc6, 0x8b, 0x4b, 0x04, 0xc1, 0xe9, 0x02,
                ...readOver('virtual-read'), { jump: 'jmp', to: 'advance' },
                { label: 'reserve' },
                0x6a, 0x04, 0x68, ...u32(0x2000), 0xff, 0x73, 0x04, 0x6a, 0x00,
                ...call('VirtualAlloc'),
                0x6a, 0x04, 0x68, ...u32(0x1000), 0xff, 0x73, 0x08, 0x50,
                ...call('VirtualAlloc'),
                0x89, 0xc6, 0x8b, 0x4b, 0x08, 0xc1, 0xe9, 0x02,
                ...readOver('reserve-read'), { jump: 'jmp', to: 'advance' },
                { label: 'free' },
                ...call('GetProcessHeap'),
                0xff, 0x35, ...u32(at('last')), 0x6a, 0x00, 0x50, ...call('HeapFree'),
                { jump: 'jmp', to: 'advance' },
                { label: 'thread' },
                // Its parameter: the bytes, and whether it writes in bit 0.
                0x6a, 0x00, 0x6a, 0x00, 0x8b, 0x43, 0x04, 0x0b, 0x43, 0x08, 0x50,
                0x68, ...u32(code(THREAD)),
                0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'),
                0xa3, ...u32(at('thread')), 0x6a, 0xff, 0x50, ...call('WaitForSingleObject'),
                0x68, ...u32(at('code')), 0xff, 0x35, ...u32(at('thread')),
                ...call('GetExitCodeThread'),
                0xa1, ...u32(at('code')), 0x6b, 0xed, 0x1f, 0x01, 0xc5,
                { label: 'advance' },
                0x83, 0xc3, 0x0c, { jump: 'jmp', to: 'next' },
                { label: 'finish' },
                0x55, ...call('ExitProcess'),
            ]);
            // The thread: what lies 4 KiB below its stack pointer and `bytes`
            // further down, read and written over; its hash is its exit code.
            const thread = assemble([
                0x8b, 0x4c, 0x24, 0x04, 0x89, 0xca, 0x83, 0xe1, 0xfe,
                0x89, 0xe6, 0x81, 0xee, ...u32(0x1000),
                0x29, 0xce, 0xc1, 0xe9, 0x02, 0x31, 0xed,
                0xf6, 0xc2, 0x01, { jump: 'jz', to: 'peek' },
                ...readOver('stack-read'), { jump: 'jmp', to: 'out' },
                { label: 'peek' }, ...readOver('stack-peek', false),
                { label: 'out' },
                0x89, 0xe8, 0xc2, 0x04, 0x00,
            ]);
            if (main.length > THREAD)
            {
                throw new Error(`the steps' code is ${main.length} bytes`);
            }
            return [...main, ...new Array(THREAD - main.length).fill(0x90), ...thread];
        },
    });
}

/** A parent that starts each command in turn, waiting for each. @param {string[]} commands */
function parentOf(commands){
    const names = commands.map((_, index)=>`command${index}`);
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject', 'ExitProcess'] },
        data: {
            ...Object.fromEntries(commands.map((command, index)=>[names[index], ascii(command)])),
            startup: [...u32(68), ...new Array(64).fill(0)],
            info: new Array(16).fill(0),
        },
        codeSize: 0x100,
        code: ({ iat, at })=>[...names.flatMap(name=>[
            0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
            0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
            0x68, ...u32(at(name)), 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateProcessA')),
            0x6a, 0xff, 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('WaitForSingleObject')),
        ]), 0x6a, 0, 0xff, 0x15, ...u32(iat('ExitProcess'))],
    });
}

/**
 * Whether a process's diagnostics say it ran in a gone process's memory
 * (the cpu layer's `memoryReused`), wherever in its tables that is.
 *
 * @param {any} tables
 * @returns {boolean | undefined}
 */
const memoryReused = tables=>{
    if (tables === null || typeof tables !== 'object')
    {
        return undefined;
    }
    if (typeof tables.memoryReused === 'boolean')
    {
        return tables.memoryReused;
    }
    for (const value of Object.values(tables))
    {
        const found = memoryReused(value);
        if (found !== undefined)
        {
            return found;
        }
    }
    return undefined;
};

/**
 * Runs the commands one after another in one run, and answers each child's
 * exit code and whether it ran in a gone process's memory.
 *
 * @param {string[]} commands
 * @param {{ path: string, bytes: Uint8Array }[]} files
 * @param {number} cores
 * @param {import('./mode.js').Concurrency} [concurrency]  2: each child in a worker of its own
 */
async function runChildren(commands, files, cores, concurrency = 1){
    const app = await createApp({
        executable: parentOf(commands),
        imagePath: 'C:\\App\\parent.exe',
        cpu: { cores },
        concurrency,
        storage: { load: async()=>({ files }) },
    });
    try
    {
        /** @type {number[]} */
        const codes = [];
        /** @type {(boolean | undefined)[]} */
        const reused = [];
        app.on('process-resumed', (/** @type {any} */ event)=>{
            codes.push(event.code >>> 0);
            reused.push(memoryReused(event.diagnostics));
        });
        assert.equal(await app.run({ timeoutMs: 120_000 }), 0);
        assert.equal(codes.length, commands.length, 'every child ran');
        return Object.assign(codes, { reused });
    }
    finally
    {
        await app.dispose();
    }
}

for (const [seed, cores, concurrency] of /** @type {[number, number, 1 | 2][]} */ ([[1, 1, 1],
    [2, 1, 1], [3, 3, 1], [4, 1, 1], [5, 3, 1], [6, 8, 1], [7, 1, 2], [8, 3, 2]]))
{
    test(`seeded program ${seed} reads in a gone program's memory what it reads in a new one`
        + ` (${cores} executor${cores > 1 ? 's' : ''}${concurrency > 1
            ? ', each in a worker of its own' : ''})`, { timeout: 600_000 }, async()=>{
        // The writer is handed more and wider than the reader, and writes over
        // all of it: whatever of it the reader is handed again it reads.
        const writer = stepsProgram(stepsOf(seed * 7919, 24, true)
            .concat(Op.HEAP, 8 << 20, 0, Op.VIRTUAL, 4 << 20, 0, Op.THREAD, 7 * 1024, 1));
        // Each with a thread past its seeded steps, which reads and leaves as it
        // was a stack the writer's threads wrote in.
        const reader = stepsProgram(stepsOf(seed, 16, false).concat(Op.THREAD, 6 * 1024, 0));
        const files = [{ path: 'C:\\App\\writer.exe', bytes: writer },
            { path: 'C:\\App\\reader.exe', bytes: reader }];
        const [alone] = await runChildren(['C:\\App\\reader.exe'], files, cores, concurrency);
        // And once more, in the memory the reader itself left: what a gone
        // process's bytes are must carry from one taker to the next.
        const chain = await runChildren(['C:\\App\\writer.exe',
            'C:\\App\\reader.exe', 'C:\\App\\reader.exe'], files, cores, concurrency);
        const [, after, again] = chain;
        if (concurrency > 1)
        {
            // A child in a worker of its own says what it ran in as it exits;
            // one on the engine's thread is counted by spawn-children's test.
            assert.deepEqual(chain.reused, [false, true, true],
                'each child after the first in the memory the one before it left, across workers');
        }
        assert.equal(after, alone, 'the same reads after the writer as in a memory just made');
        assert.equal(again, alone, 'and after the reader');
    });
}
