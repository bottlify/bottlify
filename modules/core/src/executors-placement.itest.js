/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The gate of where a process of several executors runs its threads
 * (`placement.js`): spread over them, concentrated on the process's own, or
 * each moved on what its gains say.
 *
 * Threads computing apart stay spread, nothing they do saying either would
 * gain by taking turns here; and what a program sees is the same spread,
 * concentrated and with a thread moved in or out every few milliseconds --
 * its threads given up by the other executors at their slices' ends and taken
 * here mid-loop, a locked count kept by all of them at once.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { assemble, buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const WORKER_AT = 0x200;

/**
 * A main thread that starts two workers running `worker`, runs `own` itself,
 * waits for both and exits with the word at `count`.
 *
 * @param {(at: (name: string) => number) => any[]} worker  ends in `ret 4`
 * @param {(at: (name: string) => number) => any[]} own
 */
function buildProgram(worker, own){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'ExitProcess'] },
        codeSize: WORKER_AT + 0x100,
        data: { count: u32(0), first: u32(0), second: u32(0) },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** CreateThread(NULL, 0, worker, NULL, 0, NULL), the handle to `slot`. @param {string} slot */
            const start = slot=>[
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(code(WORKER_AT)),
                0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'), 0xa3, ...u32(at(slot)),
            ];
            /** WaitForSingleObject([slot], INFINITE) @param {string} slot */
            const wait = slot=>[0x6a, 0xff, 0xff, 0x35, ...u32(at(slot)),
                ...call('WaitForSingleObject')];
            const main = assemble([...start('first'), ...start('second'), ...own(at),
                ...wait('first'), ...wait('second'),
                0xff, 0x35, ...u32(at('count')), ...call('ExitProcess')]);
            if (main.length > WORKER_AT)
            {
                throw new Error(`main is ${main.length} bytes`);
            }
            return [...main, ...new Array(WORKER_AT - main.length).fill(0xcc),
                ...assemble(worker(at))];
        },
    });
}

/**
 * The exit code and the scheduler's account of a run on `cores`.
 *
 * @param {Uint8Array} executable @param {number} cores
 * @param {{ placement?: 'auto' | 'spread' | 'concentrate',
 *     placementTiming?: Partial<import('./layers/kernel/internal/placement.js').PlacementOptions>,
 *     freeHost?: boolean }} [cpu]
 */
async function run(executable, cores, cpu = {}){
    const app = await createApp({ executable, cpu: { cores, eager: true, ...cpu } });
    try
    {
        const code = await app.run({ timeoutMs: 90_000 });
        const tables = await app.diagnostics();
        const kernel = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'kernel');
        const scheduler = kernel?.metrics?.scheduler ?? kernel?.metrics ?? null;
        return { code: code >>> 0, scheduler,
            placement: JSON.parse(scheduler?.placement ?? 'null') };
    }
    finally
    {
        await app.dispose();
    }
}

test('two threads computing apart are run spread: nothing they do says either gains by'
    + ' taking turns on the process\'s executor', { timeout: 300_000 }, async()=>{
    // A billion times round a loop of two instructions each, no call into the host.
    const LOOPS = 1_000_000_000;
    const executable = buildProgram(()=>[
        0xb9, ...u32(LOOPS), //               mov ecx, LOOPS
        { label: 'loop' },
        0x49, { jump: 'jnz', to: 'loop' }, // dec ecx; jnz loop
        0x31, 0xc0, 0xc2, 0x04, 0x00, //      xor eax, eax; ret 4
    ], ()=>[]);
    const { code, placement, scheduler } = await run(executable, 3, { freeHost: false });
    assert.equal(code, 0);
    assert.deepEqual([placement?.way, placement?.moves, placement?.here], ['auto', 0, ''],
        JSON.stringify(placement));
    assert.ok(scheduler?.executorSlices > 0, 'the worker ran on another executor');
});

test('a locked count kept by three threads comes out whole spread, concentrated and moved'
    + ' between the two every few milliseconds', { timeout: 300_000 }, async()=>{
    const ADDS = 20_000_000;
    /** @param {(name: string) => number} at */
    const count = at=>[
        0xb9, ...u32(ADDS), //                             mov ecx, ADDS
        { label: 'add' },
        0xf0, 0xff, 0x05, ...u32(at('count')), //          lock inc dword [count]
        0x49, { jump: 'jnz', to: 'add' }, //                dec ecx; jnz add
    ];
    const executable = buildProgram(at=>[...count(at), 0x31, 0xc0, 0xc2, 0x04, 0x00], count);
    const fixed = { spread: 0, concentrate: 0 };
    for (const placement of /** @type {const} */ (['spread', 'concentrate']))
    {
        const said = await run(executable, 3, { placement });
        assert.equal(said.code, 3 * ADDS, placement);
        assert.equal(said.placement.moves, 0, `${placement}: no thread moved`);
        fixed[placement] = said.scheduler?.executorSlices ?? -1;
    }
    assert.ok(fixed.spread > 0, 'spread, slices ran on the other executors');
    assert.equal(fixed.concentrate, 0, 'concentrated, none did');

    // A thread moved in or out every few milliseconds, gains or not (`churnMs`).
    const moving = await run(executable, 3, { placementTiming: { churnMs: 5, windowMs: 2 },
        freeHost: false });
    assert.equal(moving.code, 3 * ADDS, 'moved between executors');
    assert.ok(moving.placement.moves >= 5, JSON.stringify(moving.placement));
    assert.ok(moving.scheduler?.executorSlices > 0, 'some of it spread');
});
