/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What one guest-to-host call costs through the whole engine, in Node.
 *
 * A hand-built executable loops a million times over one import and exits;
 * the same loop with the call taken out is run first, so the figure reported
 * is the call alone -- the trampoline, the stub, the port write, the
 * dispatcher, the handler, and the way back into generated code -- rather
 * than the loop around it or the time the engine takes to come up.
 *
 * Usage: node tools/bench/crossing.mjs [--calls N]
 *     [--kind id|tick|small|args|heap] [--profile-calls] [--trace-strings] [--rounds R]
 *     [--jit]
 *
 *   id     GetCurrentThreadId: a handler of one property read.
 *   tick   GetTickCount: answered in guest code, so no crossing at all -- a
 *          control, to show that the loop itself costs nothing to speak of.
 *   small  MulDiv(4, 5, 6): three arguments that cannot be pointers.
 *   args   MulDiv(0x2300, 0x2200, 0x2100): three arguments that look like
 *          pointers and are not mapped, the shape of most enumerated
 *          constants a program passes.
 *   heap   HeapAlloc(heap, 0, 16) followed by HeapFree of the same block: two
 *          crossings a turn, with the allocator's own cost between them.
 */

import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createApp, pagePacing } from '../../modules/core/src/app.js';

const PREBUILT = new URL('../../modules/core/vendor/prebuilt/', import.meta.url);

const flags = process.argv.slice(2);
/** @param {string} name @param {string} fallback */
const flag = (name, fallback)=>{
    const at = flags.indexOf(name);
    return at === -1 ? fallback : flags[at + 1];
};
const CALLS = Number(flag('--calls', '1000000'));
const KIND = flag('--kind', 'id');
const ROUNDS = Number(flag('--rounds', '3'));
const PROFILE_CALLS = flags.includes('--profile-calls');
const TRACE_STRINGS = flags.includes('--trace-strings');

// The PE builder doubles as a command that writes whatever fixture its
// arguments name, and these are not its arguments.
const entry = process.argv[1];
process.argv.length = 2;
const { buildExe } = await import('../make-pe.mjs');

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/**
 * @param {number} calls
 * @param {string} kind  Which body the loop runs, or 'none' for the bare loop.
 */
export function buildLoopExe(calls, kind){
    return buildExe({
        imports: {
            'KERNEL32.dll': [
                'GetCurrentThreadId', 'GetTickCount', 'GetProcessHeap', 'HeapAlloc',
                'HeapFree', 'MulDiv', 'ExitProcess',
            ],
        },
        codeSize: 0x80,
        code: ({ iat })=>{
            /** @type {number[]} */
            const body = kind === 'id' ? [
                0xff, 0x15, ...u32(iat('GetCurrentThreadId')), // call [GetCurrentThreadId]
            ] : kind === 'tick' ? [
                0xff, 0x15, ...u32(iat('GetTickCount')), //       call [GetTickCount]
            ] : kind === 'args' ? [
                0x68, ...u32(0x2100), 0x68, ...u32(0x2200), //    push 0x2100; push 0x2200
                0x68, ...u32(0x2300), //                          push 0x2300
                0xff, 0x15, ...u32(iat('MulDiv')), //             call [MulDiv]
            ] : kind === 'small' ? [
                0x6a, 0x06, 0x6a, 0x05, 0x6a, 0x04, //            push 6; push 5; push 4
                0xff, 0x15, ...u32(iat('MulDiv')), //             call [MulDiv]
            ] : kind === 'heap' ? [
                0x6a, 0x10, 0x6a, 0x00, 0x56, //                  push 16; push 0; push esi
                0xff, 0x15, ...u32(iat('HeapAlloc')), //          call [HeapAlloc]
                0x50, 0x6a, 0x00, 0x56, //                        push eax; push 0; push esi
                0xff, 0x15, ...u32(iat('HeapFree')), //           call [HeapFree]
            ] : [];
            const loop = [
                ...body,
                0x4f, //                                          dec edi
                0x75, -(body.length + 3) & 0xff, //               jnz loop
            ];
            return [
                0xff, 0x15, ...u32(iat('GetProcessHeap')), //     call [GetProcessHeap]
                0x89, 0xc6, //                                    mov esi, eax
                0xbf, ...u32(calls), //                           mov edi, calls
                ...loop,
                0x6a, 0x00, //                                    push 0
                0xff, 0x15, ...u32(iat('ExitProcess')), //        call [ExitProcess]
            ];
        },
    });
}

/**
 * @param {ArrayBuffer} wasmBytes
 * @param {number} calls
 * @param {string} kind
 * @returns {Promise<number>} milliseconds the run took
 */
async function timeRun(wasmBytes, calls, kind){
    const app = await createApp({
        executable: buildLoopExe(calls, kind),
        v86: { moduleUrl: new URL('libv86.mjs', PREBUILT).href, wasmBytes },
        profileCalls: PROFILE_CALLS,
        traceStrings: TRACE_STRINGS,
        // The emulator's compiler publishes a module through a promise that
        // Node settles in its check phase, which a yield through a message
        // port never reaches: with the page's own pacing every instruction
        // here runs interpreted, and the figure would be for a machine the
        // browser never is.
        pacing: pagePacing({
            macrotask: ()=>new Promise(resolve=>{
                setImmediate(resolve);
            }),
            hidden: ()=>false,
        }),
    });
    try
    {
        const started = performance.now();
        const code = await app.run({ timeoutMs: 600_000 });
        const took = performance.now() - started;
        if (code !== 0)
        {
            throw new Error(`the guest exited with ${code}`);
        }
        if (flags.includes('--jit'))
        {
            const cpu = app.diagnostics().find((/** @type {any} */ d)=>d.name === 'cpu');
            const jit = cpu?.metrics?.jit ?? {};
            console.log(`  jit: compiled ${jit.compiledSteps} interpreted ${jit.interpretedSteps}`
                + ` dispatches ${jit.interpretedDispatches} (nocode ${jit.interpNoCode},`
                + ` noentry ${jit.interpNoEntry}, pageend ${jit.interpNearPageEnd},`
                + ` state ${jit.interpDifferentState}; below ${jit.interpBelowThreshold},`
                + ` deferred ${jit.interpCompileDeferred}) chained ${jit.chained}`
                + ` missed ${jit.chainMissed} entries ${jit.entries} finalised ${jit.finalised}`
                + ` discarded ${jit.discarded} refused "${jit.refused}"`
                + `\n  interpreted pages: ${jit.interpPages}; written code pages: ${jit.dirtyPages}`
                + `; lost to writes: modules ${jit.modulesLostToWrites}`
                + ` hotness ${jit.hotnessLostToWrites}`);
        }
        return took;
    }
    finally
    {
        await app.dispose();
    }
}

/** One timed run in this process, reported as a line of its own. */
async function child(){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const wasmBytes = wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength);
    const took = await timeRun(wasmBytes, CALLS, KIND);
    console.log(`ms=${took.toFixed(1)}`);
    // Node lingers for twenty seconds after a run in which generated code
    // was published, with no handle of ours open; the figure is in, so the
    // process need not wait for whatever that is.
    process.exit(0);
}

async function main(){
    // One machine per process. A second boot in a process that had already
    // run compiled code to completion was seen to wait for ever inside the
    // emulator's own instantiation, and a bench must not depend on that.
    /** @param {string} kind @returns {number} the best of the rounds, in ms */
    const bestOf = kind=>{
        let best = Infinity;
        for (let round = 0; round < ROUNDS; round++)
        {
            const result = spawnSync(process.execPath, [
                entry, '--child', '--kind', kind, '--calls', String(CALLS),
                ...flags.filter(f=>['--profile-calls', '--trace-strings', '--jit'].includes(f)),
            ], { encoding: 'utf8', timeout: 600_000 });
            const line = /^ms=([\d.]+)$/m.exec(result.stdout ?? '');
            if (result.status !== 0 || !line)
            {
                throw new Error(`the ${kind} run failed:\n${result.stdout}${result.stderr}`);
            }
            process.stdout.write(result.stdout.replace(/^ms=.*\r?\n?/m, ''));
            const took = Number(line[1]);
            best = Math.min(best, took);
            console.log(`${kind} round ${round + 1}: ${took.toFixed(0)} ms`);
        }
        return best;
    };
    const bare = bestOf('none');
    const best = bestOf(KIND);
    const perCall = (best - bare) * 1000 / CALLS;
    console.log(`${KIND}: ${CALLS} turns, bare loop ${bare.toFixed(0)} ms,`
        + ` best ${best.toFixed(0)} ms -> ${perCall.toFixed(2)} us a turn`);
}

if (entry && import.meta.url === new URL(`file://${entry.replace(/\\/g, '/')}`).href)
{
    await (flags.includes('--child') ? child() : main());
}
