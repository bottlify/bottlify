/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of the machine's memory (`machineMemory`, `memory-budget.js`): a run
 * whose processes would together hold more than the machine has never holds
 * more. A parent starts children four at a time, each asking its heap for
 * 100 MiB, which grows its memory to 512 MiB: four at once are 2 GiB past the
 * parent's, and a machine of 1.25 GiB has room for two. The run ends, every
 * child either has its block or is told there is none (as on a machine out of
 * memory, at its block or at its start), and the most the run held is within
 * the machine's memory; the same
 * run without one holds past it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import { createMemoryBudget, openMemoryBudget } from './layers/cpu/internal/memory-budget.js';

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
/** @param {string} text */
const ascii = text=>[...text].map(character=>character.charCodeAt(0)).concat(0);

const MiB = 1 << 20;
/** What a process the machine had no room to start ends with (STATUS_NO_MEMORY). */
const NO_MEMORY = 0xc0000017;
/** A child that had its block, was refused it, or found no room to start. */
const told = (/** @type {number} */ code)=>code === 0 || code === 1 || code === NO_MEMORY;
const BLOCK = 100 * MiB;
const MEMORY_SIZE = 512 * MiB;

/** A child that takes a heap block of `BLOCK`, writes its last byte, sleeps, and exits 0; 1 where there was none. */
const child = buildExe({
    imports: { 'KERNEL32.dll': ['GetProcessHeap', 'HeapAlloc', 'Sleep', 'ExitProcess'] },
    codeSize: 0x60,
    code: ({ iat })=>[
        0xff, 0x15, ...u32(iat('GetProcessHeap')),
        0x68, ...u32(BLOCK), 0x6a, 0, 0x50, 0xff, 0x15, ...u32(iat('HeapAlloc')),
        0x85, 0xc0, 0x74, 26,
        0xc6, 0x80, ...u32(BLOCK - 1), 1,
        0x68, ...u32(300), 0xff, 0x15, ...u32(iat('Sleep')),
        0x6a, 0, 0xff, 0x15, ...u32(iat('ExitProcess')),
        0x6a, 1, 0xff, 0x15, ...u32(iat('ExitProcess')),
    ],
});

/**
 * A parent that starts `at` children at once and waits for them, `rounds` times.
 *
 * @param {number} at
 * @param {number} rounds
 */
function parentOf(at, rounds){
    const infos = Array.from({ length: at }, (_, index)=>`info${index}`);
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject', 'ExitProcess'] },
        data: {
            child: ascii('C:\\App\\child.exe'),
            startup: [...u32(68), ...new Array(64).fill(0)],
            ...Object.fromEntries(infos.map(info=>[info, new Array(16).fill(0)])),
        },
        codeSize: 0x200,
        code: ({ iat, at: address })=>{
            const round = [
                ...infos.flatMap(info=>[
                    0x68, ...u32(address(info)), 0x68, ...u32(address('startup')),
                    0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
                    0x68, ...u32(address('child')), 0x6a, 0,
                    0xff, 0x15, ...u32(iat('CreateProcessA'))]),
                ...infos.flatMap(info=>[0x6a, 0xff, 0xff, 0x35, ...u32(address(info)),
                    0xff, 0x15, ...u32(iat('WaitForSingleObject'))]),
            ];
            return [...Array.from({ length: rounds }, ()=>round).flat(),
                0x6a, 0, 0xff, 0x15, ...u32(iat('ExitProcess'))];
        },
    });
}

/**
 * Every byte of WebAssembly.Memory made or grown while `run` goes on, summed:
 * what a run without a machine's memory takes from the browser, memories
 * taken again by the next process counted once.
 *
 * @param {import('node:test').TestContext} t
 */
function countMemories(t){
    const Made = WebAssembly.Memory;
    const grow = Made.prototype.grow;
    let bytes = 0;
    WebAssembly.Memory = /** @type {any} */ (function(/** @type {any} */ descriptor){
        bytes += descriptor.initial * 65536;
        return new Made(descriptor);
    });
    WebAssembly.Memory.prototype = Made.prototype;
    Made.prototype.grow = function(/** @type {number} */ pages){
        bytes += pages * 65536;
        return grow.call(this, pages);
    };
    t.after(()=>{
        WebAssembly.Memory = Made;
        Made.prototype.grow = grow;
    });
    return ()=>bytes;
}

/**
 * Runs the parent, and answers each child's exit code.
 *
 * @param {{ budget?: SharedArrayBuffer | ArrayBuffer, machineMemory?: number,
 *     cores?: number, concurrency?: 1 | 2, guestCharge?: 'length' | 'given' }} how
 */
async function runParent({ budget, machineMemory, cores = 1, concurrency = 1, guestCharge }){
    const app = await createApp({
        executable: parentOf(4, 2),
        imagePath: 'C:\\App\\parent.exe',
        memorySize: MEMORY_SIZE,
        // A child the machine has no room for fails to start after this, not ten minutes.
        machineWaitMs: 5000,
        cpu: { cores, ...guestCharge ? { guestCharge } : {} },
        concurrency,
        ...budget ? { memoryBudget: budget } : {},
        ...machineMemory ? { machineMemory } : {},
        storage: { load: async()=>({ files: [{ path: 'C:\\App\\child.exe', bytes: child }] }) },
    });
    try
    {
        /** @type {number[]} */
        const codes = [];
        app.on('process-resumed', (/** @type {any} */ event)=>codes.push(event.code >>> 0));
        assert.equal(await app.run({ timeoutMs: 300_000 }), 0, 'the parent ran to its end');
        return { codes, diagnostics: app.diagnostics() };
    }
    finally
    {
        await app.dispose();
    }
}

test('without a machine\'s memory, four children at once hold past what a machine of 1.25 GiB has',
    { timeout: 600_000 }, async t=>{
        const made = countMemories(t);
        const { codes } = await runParent({});
        assert.deepEqual(codes, new Array(8).fill(0), 'every child had its block');
        assert.ok(made() > 1280 * MiB, `${made() / MiB} MiB made and grown`);
    });

/** How guests are counted, each run both ways. @type {('length' | 'given')[]} */
const CHARGES = ['length', 'given'];
const CASES = CHARGES.flatMap(guestCharge=>/** @type {[number, 1 | 2][]} */ (
    [[1, 1], [3, 1], [1, 2]]).map(([cores, concurrency])=>({ guestCharge, cores, concurrency })));
for (const { guestCharge, cores, concurrency } of CASES)
{
    const executors = `${cores} executor${cores > 1 ? 's' : ''}`;
    test(`a run never holds more than the machine's memory, guests counted by ${guestCharge}`
        + ` (${executors}${concurrency > 1 ? ', each child in a worker of its own' : ''})`,
    { timeout: 600_000 }, async()=>{
        const budget = createMemoryBudget(1280 * MiB);
        const { codes } = await runParent({ budget, cores, concurrency, guestCharge });
        const report = openMemoryBudget(budget).report();
        assert.equal(codes.length, 8, 'every child ran');
        assert.ok(codes.every(told), `codes ${codes}`);
        assert.ok(codes.includes(0), 'a child had its block');
        assert.ok(report.peak <= report.limit, `peak ${report.peak / MiB} MiB of ${report.limit / MiB}`);
        assert.ok(report.peak > (guestCharge === 'length' ? 512 : 400) * MiB,
            `the budget counted the guests: ${report.peak / MiB} MiB`);
        assert.equal(report.used, 0,
            `the run gave back all it held: ${JSON.stringify(report.byKind)}`);
    });
}

for (const guestCharge of CHARGES)
{
    test(`a run made with machineMemory reports it, and a block past it is refused, not a fault`
    + ` (guests counted by ${guestCharge})`,
    { timeout: 300_000 }, async()=>{
        const { codes, diagnostics } = await runParent({ machineMemory: 640 * MiB,
            guestCharge });
        assert.ok(codes.some(code=>code === 1 || code === NO_MEMORY),
            `a child was told there is no memory: ${codes}`);
        const cpu = diagnostics.find((/** @type {any} */ table)=>table.name === 'cpu');
        const machine = cpu?.metrics?.machineMemory;
        assert.ok(machine && machine.limit === 640 * MiB, JSON.stringify(machine));
        assert.ok(machine.peak <= machine.limit);
    });
}
