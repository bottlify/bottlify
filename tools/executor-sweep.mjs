/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where several executors of a process (`createApp`'s `executors`) beat one: a
 * synthetic program swept over what decides it, timed on each executor count.
 *
 * The program starts T threads, each looping W times over a kernel of its own
 * -- a generator step and a read-modify-write into a private 4 KiB -- every
 * K-th turn a `lock add` on a counter all share, every H-th a host call
 * (GetACP, which only the host answers: GetTickCount is guest code and never
 * leaves the executor), which the process's own thread answers for whichever
 * executor made it. The main thread waits for all and exits with a checksum
 * that is the same however the threads interleave, so every run is also a
 * check that the executors changed nothing.
 *
 *   node tools/executor-sweep.mjs [--threads 1,2,3] [--executors 1,2,3,4]
 *       [--host 0,65536,4096,256] [--sync 0,256] [--work 400000000] [--reps 3]
 *       [--quantum n] [--eager] [--json]
 *
 * K or H of 0 leaves that out. Executors open as the threads want them, a run's
 * time holding their opening; `--eager` opens them all first. A run's time is
 * `app.run` (the program from its first instruction to its exit, translation
 * included), not the boot; a point's
 * is the mean of its three fastest runs (`best3`), and its speedup against the
 * first executor count's.
 */

import './chromium-v8.mjs';
import { createApp } from '../modules/core/src/app.js';
import { buildExe } from './make-pe.mjs';

const args = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const option = (name, fallback)=>{
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : fallback;
};
/** @param {string} name @param {string} fallback */
const list = (name, fallback)=>option(name, fallback).split(',').map(Number);
const THREADS = list('threads', '1,2,3');
const EXECUTORS = list('executors', '1,2,3,4');
const HOST = list('host', '0,65536,4096,256');
const SYNC = list('sync', '0,256');
const WORK = Number(option('work', '400000000'));
const REPS = Number(option('reps', '3'));
/** The kernel's quantum, guest instructions a slice; the app's default where not given. */
const QUANTUM = option('quantum', '');
const JSON_OUT = args.includes('--json');
/** Every executor opened before the program starts: the steady state, not the opening. */
const EAGER = args.includes('--eager');

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const WORKER = 0x200;

/**
 * The program for one point of the sweep: T threads of W turns each, a lock
 * every K-th turn and a host call every H-th (0: none); W per thread is the
 * whole work over T, so every T does the same total.
 *
 * @param {{ threads: number, work: number, sync: number, host: number }} point
 */
function program({ threads, work, sync, host }){
    const turns = Math.floor(work / threads);
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'GetACP',
            'ExitProcess'] },
        // The data on pages of its own: a store beside code is checked against it.
        codeSize: 0x1000,
        data: {
            shared: [0, 0, 0, 0], result: [0, 0, 0, 0],
            handles: new Array(4 * threads).fill(0),
            own: new Array(4096 * (threads + 1)).fill(0),
        },
        code: ({ iat, at, code })=>{
            const main = [];
            for (let index = 0; index < threads; index++)
            {
                main.push(0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(index), //  0, 0, index
                    0x68, ...u32(code(WORKER)), 0x6a, 0x00, 0x6a, 0x00, // worker, 0, 0
                    0xff, 0x15, ...u32(iat('CreateThread')),
                    0xa3, ...u32(at('handles') + 4 * index));
            }
            for (let index = 0; index < threads; index++)
            {
                main.push(0x6a, 0xff, 0xff, 0x35, ...u32(at('handles') + 4 * index),
                    0xff, 0x15, ...u32(iat('WaitForSingleObject')));
            }
            main.push(0xa1, ...u32(at('result')), //        mov eax, [result]
                0x33, 0x05, ...u32(at('shared')), //          xor eax, [shared]
                0x50, 0xff, 0x15, ...u32(iat('ExitProcess')));
            const synced = sync > 0 ? [
                0xf7, 0xc1, ...u32(sync - 1), 0x75, 0x08, //  test ecx, K-1; jnz +8
                0xf0, 0x83, 0x05, ...u32(at('shared')), 0x01, // lock add [shared], 1
            ] : [];
            const hosted = host > 0 ? [
                0xf7, 0xc1, ...u32(host - 1), 0x75, 0x0a, //  test ecx, H-1; jnz +10
                0x50, 0x51, //                                push eax; push ecx
                0xff, 0x15, ...u32(iat('GetACP')),
                0x59, 0x58, //                                pop ecx; pop eax
            ] : [];
            const body = [
                0x69, 0xc0, ...u32(1103515245), //            L: imul eax, eax, a
                0x05, ...u32(12345), //                          add eax, c
                0x89, 0xc2, 0xc1, 0xea, 0x16, //                 mov edx, eax; shr edx, 22
                0x01, 0x04, 0x96, //                             add [esi+edx*4], eax
                ...synced, ...hosted,
            ];
            const worker = [
                0x8b, 0x44, 0x24, 0x04, //                       mov eax, [esp+4]: the index
                0x89, 0xc6, 0xc1, 0xe6, 0x0c, //                 mov esi, eax; shl esi, 12
                0x81, 0xc6, ...u32(at('own')), //                add esi, own
                0x83, 0xc0, 0x01, //                             add eax, 1: the seed
                0xb9, ...u32(turns), //                          mov ecx, W
                ...body,
                0x49, 0x0f, 0x85, ...u32(-(body.length + 1 + 6)), // dec ecx; jnz L
                0xf0, 0x01, 0x05, ...u32(at('result')), //       lock add [result], eax
                0x31, 0xc0, 0xc2, 0x04, 0x00, //                 xor eax, eax; ret 4
            ];
            if (main.length > WORKER)
            {
                throw new Error(`the main thread's code takes ${main.length} bytes`);
            }
            return [...main, ...new Array(WORKER - main.length).fill(0x90), ...worker];
        },
    });
}

/**
 * One run: seconds from the first instruction to the exit, the exit code, the
 * guest instructions every thread retired, as the scheduler counted them, the
 * calls into the host the other executors made, and the share of the
 * instructions retired on them.
 *
 * @param {Uint8Array} executable @param {number} executors
 */
async function run(executable, executors){
    const app = await createApp({ executable, executors,
        ...(EAGER ? { cpu: { eager: true } } : {}),
        ...(QUANTUM === '' ? {} : { quantum: Number(QUANTUM) }) });
    try
    {
        const began = performance.now();
        const code = await app.run({ timeoutMs: 600_000, maxTurns: Number.MAX_SAFE_INTEGER });
        const seconds = (performance.now() - began) / 1000;
        const tables = await app.diagnostics();
        const kernel = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'kernel');
        const scheduler = kernel?.metrics?.scheduler ?? kernel?.metrics ?? {};
        // "name instructions state ... xN" per thread, " | " between: N its
        // calls into the host a hundred thousand instructions.
        const rows = String(scheduler.byThread ?? '').split(' | ');
        const retired = rows.reduce((sum, row)=>sum + (Number(row.split(' ')[1]) || 0), 0);
        const workersRate = Math.max(0, ...rows.filter(row=>!row.startsWith('main '))
            .map(row=>Number(/ x([\d.]+)$/.exec(row)?.[1] ?? 0)));
        const shared = JSON.parse(scheduler.sharedTime ?? '{}');
        return { seconds, code: code >>> 0, retired, crossings: shared.crossings ?? 0,
            elsewhere: retired > 0 ? (shared.elsewhereRetired ?? 0) / retired : 0, workersRate };
    }
    finally
    {
        await app.dispose();
    }
}

/** @param {number[]} values */
const median = values=>[...values].sort((a, b)=>a - b)[values.length >> 1];
/**
 * What a point is judged by: the mean of its three fastest runs, steadier than
 * the median against a machine whose other load comes and goes; the median
 * with fewer than three.
 *
 * @param {number[]} values
 */
const best3 = values=>(values.length < 3 ? median(values)
    : [...values].sort((a, b)=>a - b).slice(0, 3).reduce((sum, one)=>sum + one, 0) / 3);

const rows = [];
for (const threads of THREADS)
{
    for (const sync of SYNC)
    {
        for (const host of HOST)
        {
            const point = { threads, work: WORK, sync, host };
            const executable = program(point);
            /** @type {Map<number, number[]>} */
            const times = new Map(EXECUTORS.map(count=>[count, []]));
            /** Instructions retired a run, by executor count (the same every run). @type {Map<number, number>} */
            const retiredBy = new Map();
            /** The other executors' host calls and share of the instructions, each run's. @type {Map<number, {crossings: number, elsewhere: number}[]>} */
            const placedBy = new Map(EXECUTORS.map(count=>[count, []]));
            /** @type {Set<number>} */
            const codes = new Set();
            // The executor counts alternate within each rep, so a drift of the
            // machine falls on all of them alike.
            for (let rep = 0; rep < REPS; rep++)
            {
                const order = rep % 2 === 0 ? EXECUTORS : [...EXECUTORS].reverse();
                for (const executors of order)
                {
                    const { seconds, code, retired, crossings, elsewhere, workersRate } =
                        await run(executable, executors);
                    // A point that names host calls the workers never made into
                    // the host measures something else: GetTickCount, the call
                    // here once, had become guest code and timed no crossing.
                    if (host > 0 && workersRate === 0)
                    {
                        throw new Error(`H=${host}: the workers' calls never reached the host`);
                    }
                    /** @type {number[]} */ (times.get(executors)).push(seconds);
                    placedBy.get(executors)?.push({ crossings, elsewhere });
                    retiredBy.set(executors, retired);
                    codes.add(code);
                }
            }
            const one = best3(/** @type {number[]} */ (times.get(EXECUTORS[0])));
            for (const executors of EXECUTORS)
            {
                const raw = /** @type {number[]} */ (times.get(executors));
                const retired = retiredBy.get(executors) ?? 0;
                const placed = placedBy.get(executors) ?? [];
                const row = { threads, sync, host, executors, median: median(raw),
                    best3: best3(raw), min: Math.min(...raw), max: Math.max(...raw), raw,
                    speedup: one / best3(raw), sameResult: codes.size === 1,
                    // Millions of guest instructions a second, every thread together.
                    mips: retired / best3(raw) / 1e6,
                    // Where the threads ran: the median of the runs' calls into
                    // the host from the other executors, and of their share.
                    remoteCrossings: median(placed.map(each=>each.crossings)),
                    elsewhere: median(placed.map(each=>each.elsewhere)) };
                rows.push(row);
                if (JSON_OUT)
                {
                    console.log(JSON.stringify(row));
                }
                else
                {
                    console.log(`T=${threads} K=${sync || '-'} H=${host || '-'} E=${executors}`
                        + `  best3 ${row.best3.toFixed(2)}s [${raw.map(t=>t.toFixed(2))
                            .join(' ')}]  x${row.speedup.toFixed(2)} vs E=${EXECUTORS[0]}`
                        + `  ${Math.round(row.mips)} MIPS (${(retired / 1e9).toFixed(2)} G)`
                        + `  elsewhere ${Math.round(row.elsewhere * 100)}%`
                        + ` ${row.remoteCrossings} calls`
                        + `${row.sameResult ? '' : '  RESULTS DIFFER'}`);
                }
            }
        }
    }
}
const best = rows.filter(row=>row.executors !== EXECUTORS[0])
    .sort((a, b)=>b.speedup - a.speedup)[0];
if (best && !JSON_OUT)
{
    console.log(`best: T=${best.threads} K=${best.sync || '-'} H=${best.host || '-'}`
        + ` E=${best.executors}  x${best.speedup.toFixed(2)}`);
}
process.exit(rows.every(row=>row.sameResult) ? 0 : 1);
