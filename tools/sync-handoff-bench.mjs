/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What handing work between threads through semaphores costs a frame, in
 * node: a main thread and W workers, the way a game's job system hands out
 * a frame's jobs, timed on each executor count.
 *
 * Each frame the main thread computes a while (`--main-work` turns of a
 * generator step), releases a semaphore J times (`ReleaseSemaphore(jobs, 1)`,
 * one job each), then takes J answers off another (`WaitForSingleObject(done)`):
 * blocking (`INFINITE`) or polling it (timeout 0, round and round, as a
 * spinning job system does: `--poll`). Each worker waits on `jobs` the same
 * way, computes `--work` turns, adds one to a counter with `lock inc` and
 * releases `done`. The exit code is the counter, F * J however the threads
 * interleave, so every run is also a check that nothing was lost.
 *
 *   node tools/sync-handoff-bench.mjs [--frames 200] [--jobs 28] [--workers 2]
 *       [--work 4000] [--main-work 100000] [--poll] [--executors 1,3] [--reps 3]
 *       [--win32-config JSON] [--json]
 *
 * Printed per executor count: ms a frame (the run from the program's first
 * instruction to its exit over F, translation included: the median of the
 * runs and their spread), the calls a frame that crossed into the host by
 * function, and each thread's time a frame (`threadTimes`: ms in its slices,
 * ms ready waiting for an executor, ms its slices waited for the process's
 * executor's answers, crossings).
 */

import './chromium-v8.mjs';
import { ENGINE } from './chromium-v8.mjs';
import { createApp } from '../modules/core/src/app.js';
import { assemble, buildExe } from './make-pe.mjs';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const option = (name, fallback)=>{
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : fallback;
};
const FRAMES = Number(option('frames', '200'));
const JOBS = Number(option('jobs', '28'));
const WORKERS = Number(option('workers', '2'));
const WORK = Number(option('work', '4000'));
const MAIN_WORK = Number(option('main-work', '100000'));
const POLL = args.includes('--poll');
const EXECUTORS = option('executors', '1,3').split(',').map(Number);
const REPS = Number(option('reps', '3'));
const WIN32 = JSON.parse(option('win32-config', '{}'));
const JSON_OUT = args.includes('--json');

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const WORKER_AT = 0x400;

/** The program: see the header. */
function program(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateSemaphoreA', 'ReleaseSemaphore', 'CreateThread',
            'WaitForSingleObject', 'ExitProcess'] },
        codeSize: 0x1000,
        data: { jobs: u32(0), done: u32(0), quit: u32(0), counter: u32(0),
            threads: new Array(4 * WORKERS).fill(0) },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** ReleaseSemaphore([slot], count, NULL) */
            const release = (/** @type {string} */ slot, /** @type {number} */ count)=>[
                0x6a, 0x00, 0x68, ...u32(count), 0xff, 0x35, ...u32(at(slot)),
                ...call('ReleaseSemaphore')];
            /** One count taken off [slot]: waited for, or polled for until there is one. */
            const take = (/** @type {string} */ slot, /** @type {string} */ label)=>(POLL
                ? [{ label }, 0x6a, 0x00, 0xff, 0x35, ...u32(at(slot)),
                    ...call('WaitForSingleObject'), 0x85, 0xc0, { jump: 'jnz', to: label }]
                : [0x6a, 0xff, 0xff, 0x35, ...u32(at(slot)), ...call('WaitForSingleObject')]);
            /** `turns` generator steps in EAX, ECX the count. */
            const compute = (/** @type {number} */ turns, /** @type {string} */ label)=>[
                0xb9, ...u32(Math.max(1, turns)), //       mov ecx, turns
                { label },
                0x69, 0xc0, ...u32(1103515245), //         imul eax, eax, a
                0x05, ...u32(12345), //                    add eax, c
                0x49, { jump: 'jnz', to: label }, //       dec ecx; jnz
            ];
            /** CreateSemaphoreA(NULL, 0, 0x7fffffff, NULL), the handle to `slot`. */
            const semaphore = (/** @type {string} */ slot)=>[0x6a, 0x00, 0x68, ...u32(0x7fffffff),
                0x6a, 0x00, 0x6a, 0x00, ...call('CreateSemaphoreA'), 0xa3, ...u32(at(slot))];
            /** @type {any[]} */
            const main = [...semaphore('jobs'), ...semaphore('done')];
            for (let index = 0; index < WORKERS; index++)
            {
                main.push(0x6a, 0x00, 0x6a, 0x00, 0x6a, index, 0x68, ...u32(code(WORKER_AT)),
                    0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'),
                    0xa3, ...u32(at('threads') + 4 * index));
            }
            main.push(
                0xbe, ...u32(FRAMES), //                   mov esi, F
                { label: 'frame' },
                ...compute(MAIN_WORK, 'own'),
                0xbb, ...u32(JOBS), //                     mov ebx, J
                { label: 'handout' },
                ...release('jobs', 1),
                0x4b, { jump: 'jnz', to: 'handout' }, //   dec ebx
                0xbb, ...u32(JOBS),
                { label: 'collect' },
                ...take('done', 'poll'),
                0x4b, { jump: 'jnz', to: 'collect' },
                0x4e, { jump: 'jnz', to: 'frame' }, //     dec esi
                0xc7, 0x05, ...u32(at('quit')), ...u32(1), // mov dword [quit], 1
                ...release('jobs', WORKERS));
            for (let index = 0; index < WORKERS; index++)
            {
                main.push(0x6a, 0xff, 0xff, 0x35, ...u32(at('threads') + 4 * index),
                    ...call('WaitForSingleObject'));
            }
            main.push(0xff, 0x35, ...u32(at('counter')), ...call('ExitProcess'));
            const worker = assemble([
                { label: 'next' },
                ...take('jobs', 'wait'),
                0x83, 0x3d, ...u32(at('quit')), 0x00, //   cmp dword [quit], 0
                { jump: 'jnz', to: 'out' },
                ...compute(WORK, 'work'),
                0xf0, 0xff, 0x05, ...u32(at('counter')), // lock inc dword [counter]
                ...release('done', 1),
                { jump: 'jmp', to: 'next' },
                { label: 'out' },
                0x31, 0xc0, 0xc2, 0x04, 0x00, //           xor eax, eax; ret 4
            ]);
            const head = assemble(main);
            if (head.length > WORKER_AT)
            {
                throw new Error(`the main thread's code takes ${head.length} bytes`);
            }
            return [...head, ...new Array(WORKER_AT - head.length).fill(0x90), ...worker];
        },
    });
}

/**
 * One run: ms a frame, the exit code, the crossings by function and each
 * thread's totals.
 *
 * @param {Uint8Array} executable @param {number} executors
 */
async function run(executable, executors){
    const app = await createApp({ executable, executors, cpu: { eager: true }, win32: WIN32 });
    try
    {
        const began = performance.now();
        const code = await app.run({ timeoutMs: 600_000, maxTurns: Number.MAX_SAFE_INTEGER });
        const ms = performance.now() - began;
        const tables = await app.diagnostics();
        const table = (/** @type {string} */ name)=>(Array.isArray(tables) ? tables : [])
            .find(one=>one.name === name)?.metrics ?? {};
        /** @type {Record<string, number>} */
        const calls = {};
        for (const line of table('bridge').byFunction ?? [])
        {
            const [name, count] = String(line).split(' ');
            calls[name.replace(/^KERNEL32\.dll!/, '')] = Number(count);
        }
        const kernel = table('kernel');
        return { ms, code: code >>> 0, calls,
            threads: JSON.parse(kernel.threadTimes ?? '{}'), sync: kernel.sync ?? {} };
    }
    finally
    {
        await app.dispose();
    }
}

/** @param {number[]} values */
const median = values=>[...values].sort((a, b)=>a - b)[values.length >> 1];

const executable = program();
const expected = FRAMES * JOBS;
const results = [];
for (const executors of EXECUTORS)
{
    const runs = [];
    for (let rep = 0; rep < REPS; rep++)
    {
        const one = await run(executable, executors);
        if (one.code !== expected)
        {
            throw new Error(`${executors} executor(s): exit ${one.code}, not ${expected}`);
        }
        runs.push(one);
    }
    const frameMs = runs.map(one=>one.ms / FRAMES);
    // The median run's calls and threads, a frame each.
    const middle = runs[runs.map(one=>one.ms).indexOf(median(runs.map(one=>one.ms)))];
    const perFrame = (/** @type {number} */ value)=>Math.round(value / FRAMES * 100) / 100;
    results.push({
        executors,
        frameMs: Math.round(median(frameMs) * 1000) / 1000,
        spread: [Math.min(...frameMs), Math.max(...frameMs)].map(v=>Math.round(v * 1000) / 1000),
        runs: frameMs.map(v=>Math.round(v * 1000) / 1000),
        calls: Object.fromEntries(Object.entries(middle.calls)
            .filter(([name])=>/Semaphore|WaitFor/.test(name))
            .map(([name, count])=>[name, perFrame(count)])),
        // [ms in slices, ms ready waiting, ms waiting for answers, crossings], a frame
        threads: Object.fromEntries(Object.entries(middle.threads).map(([name, totals])=>
            [name, [totals[1], totals[2], totals[3], totals[5]].map(perFrame)])),
        sync: middle.sync,
    });
}
const conditions = { engine: ENGINE, frames: FRAMES, jobs: JOBS, workers: WORKERS, work: WORK,
    mainWork: MAIN_WORK, poll: POLL, reps: REPS, win32: WIN32 };
if (JSON_OUT)
{
    console.log(JSON.stringify({ conditions, results }, null, 1));
}
else
{
    console.log(JSON.stringify(conditions));
    for (const one of results)
    {
        console.log(`${one.executors} executor(s): ${one.frameMs} ms a frame `
            + `(runs ${one.runs.join(', ')})`);
        console.log(`  host calls a frame: ${JSON.stringify(one.calls)}`);
        console.log('  a frame by thread [held ms, ready-waiting ms, answer-waiting ms,'
            + ` crossings]: ${JSON.stringify(one.threads)}`);
    }
}
