/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a call from guest code into a host handler costs, under cork, in node:
 * a small program calls an import N times in a loop, and the same loop runs
 * with a push/pop in the call's place; the difference over N is the cost of
 * one call -- the crossing out of translated code, the bridge's dispatch, the
 * arguments read from guest memory, the handler and the way back.
 *
 *   node tools/host-call-bench.mjs [N] [--rounds R] [--profile]
 *
 * The import is KERNEL32!lstrlenA("a"), a host handler with one pointer
 * argument and next to no work of its own. Some imports never reach the host
 * at all (GetLastError and GetTickCount run in the guest's own kernel32), so a
 * run reports the bridge's own count of host calls beside the time: a count of
 * one (the program's ExitProcess) means the import it timed never crossed.
 *
 * `--profile` runs the calling loop once, under the V8 sampling profiler
 * started from inside this process (node:inspector), and prints the self time
 * of the functions that make up the crossing -- where its nanoseconds go.
 */

import { Session } from 'node:inspector/promises';
import { createApp } from '../modules/core/src/app.js';
import { buildExe } from './make-pe.mjs';

const argv = process.argv.slice(2);
const N = Number(argv.find(arg=>/^\d+$/.test(arg)) ?? 1_000_000);
const roundsAt = argv.indexOf('--rounds');
const ROUNDS = roundsAt >= 0 ? Number(argv[roundsAt + 1]) : 3;

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];

/**
 * The loop: esi counts down from N; each turn pushes the string's address and
 * either calls lstrlenA (stdcall, which pops it) or pops it itself.
 *
 * @param {boolean} withCall
 */
const program = withCall=>buildExe({
    imports: { 'KERNEL32.dll': ['lstrlenA', 'ExitProcess'] },
    data: { text: [0x61, 0] },
    codeSize: 0x40,
    code: ({ iat, at })=>[
        0xbe, ...u32(N),                                          // mov esi, N
        0x68, ...u32(at('text')),                                 // push text
        ...(withCall
            ? [0xff, 0x15, ...u32(iat('lstrlenA'))]              // call [lstrlenA]
            : [0x58, 0x90, 0x90, 0x90, 0x90, 0x90]),             // pop eax; nops
        0x4e, 0x75, 0x100 - 14,                                   // dec esi; jnz loop
        0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess')),
    ],
});

/** @param {boolean} withCall @returns {Promise<{ ms: number, calls: number }>} */
async function run(withCall){
    const app = await createApp({ executable: program(withCall), engine: 'cork' });
    const started = performance.now();
    await app.run({ timeoutMs: 600000, maxTurns: 1e9 });
    const ms = performance.now() - started;
    const calls = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'bridge')
        ?.metrics?.calls ?? 0;
    await app.dispose();
    return { ms, calls };
}

if (argv.includes('--profile'))
{
    const session = new Session();
    session.connect();
    await session.post('Profiler.enable');
    await session.post('Profiler.start');
    const { ms, calls } = await run(true);
    const { profile } = await session.post('Profiler.stop');
    session.disconnect();
    /** @type {Map<number, any>} */
    const nodes = new Map(profile.nodes.map((/** @type {any} */ node)=>[node.id, node]));
    /** @type {Map<string, number>} */
    const self = new Map();
    let total = 0;
    profile.samples.forEach((/** @type {number} */ id, /** @type {number} */ at)=>{
        const { callFrame } = nodes.get(id);
        const where = `${callFrame.functionName || '(anonymous)'} `
            + `${callFrame.url.split('/').slice(-2).join('/')}:${callFrame.lineNumber + 1}`;
        const us = profile.timeDeltas[at] ?? 0;
        self.set(where, (self.get(where) ?? 0) + us);
        total += us;
    });
    console.log(`${calls} host calls in ${ms.toFixed(0)} ms, the program's start included`);
    for (const [where, us] of [...self].sort((a, b)=>b[1] - a[1]).slice(0, 30))
    {
        console.log(`${(us / 1000).toFixed(0).padStart(6)} ms  ${(100 * us / total).toFixed(1)
            .padStart(5)}%  ${where}`);
    }
}
else
{
    for (let round = 0; round < ROUNDS; round++)
    {
        const loop = await run(false);
        const calls = await run(true);
        console.log(`round ${round}: loop ${loop.ms.toFixed(0)} ms, ${calls.calls} host calls `
            + `${calls.ms.toFixed(0)} ms -> ${((calls.ms - loop.ms) * 1e6 / N).toFixed(0)} ns a call`);
    }
}
