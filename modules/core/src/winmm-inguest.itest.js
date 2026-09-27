/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * WINMM's timeGetTime is GetTickCount's routine in the guest's own kernel32:
 * called through the import as a program calls it, on cork and on the
 * emulator, it answers the milliseconds GetTickCount answers, off the same
 * clock, keeps what a stdcall callee keeps, and never reaches the host.
 *
 * The program exits 0, or with the number of the first check that failed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/** How long the program sleeps between its two readings, in milliseconds. */
const SLEEP = 50;

/** What the callee-saved registers hold across every call, to be found there after. */
const KEPT = { ebx: 0x42424242, esi: 0x51515151, edi: 0x7e7e7e7e, ebp: 0x3c3c3c3c };

/**
 * timeGetTime and GetTickCount read one after the other, twice, a sleep between:
 * each pair in order on one clock, the sleep seen by both, timeBeginPeriod
 * granted, the stack and the kept registers as they were, and the import bound
 * to the address GetProcAddress hands out.
 */
function buildClockExe(){
    return buildExe({
        imports: {
            'WINMM.dll': ['timeGetTime', 'timeBeginPeriod'],
            'KERNEL32.dll': ['GetTickCount', 'Sleep', 'GetModuleHandleA', 'GetProcAddress',
                'ExitProcess'],
        },
        data: {
            t1: u32(0), g1: u32(0), t2: u32(0), g2: u32(0), sp: u32(0),
            winmm: [...Buffer.from('WINMM.dll'), 0],
            name: [...Buffer.from('timeGetTime'), 0],
        },
        codeSize: 0x300,
        code: ({ iat, at })=>{
            const call = (/** @type {string} */ name)=>[0xff, 0x15, ...u32(iat(name))];
            const keep = (/** @type {string} */ name)=>[0xa3, ...u32(at(name))];
            const load = (/** @type {string} */ name)=>[0xa1, ...u32(at(name))]; // mov eax, [x]
            /** @type {(number[] | { jump: number[], check: number })[]} */
            const pieces = [];
            let check = 0;
            /** Jumps to the failing exit when the flags say so, with its number. */
            const failIf = (/** @type {number[]} */ jump)=>{
                pieces.push({ jump, check: ++check });
            };
            const kept = [
                0xbb, ...u32(KEPT.ebx), 0xbe, ...u32(KEPT.esi),
                0xbf, ...u32(KEPT.edi), 0xbd, ...u32(KEPT.ebp),
            ];
            const JNE = [0x0f, 0x85];
            const JB = [0x0f, 0x82];
            const JA = [0x0f, 0x87];
            pieces.push(kept);
            pieces.push([0x89, 0x25, ...u32(at('sp'))]);                 // mov [sp], esp
            pieces.push(call('timeGetTime'), keep('t1'));
            pieces.push(call('GetTickCount'), keep('g1'));
            // 1: the stack is where it was; 2-5: the kept registers are
            pieces.push([0x3b, 0x25, ...u32(at('sp'))]);                 // cmp esp, [sp]
            failIf(JNE);
            pieces.push([0x81, 0xfb, ...u32(KEPT.ebx)]);
            failIf(JNE);
            pieces.push([0x81, 0xfe, ...u32(KEPT.esi)]);
            failIf(JNE);
            pieces.push([0x81, 0xff, ...u32(KEPT.edi)]);
            failIf(JNE);
            pieces.push([0x81, 0xfd, ...u32(KEPT.ebp)]);
            failIf(JNE);
            // 6: timeBeginPeriod(1) is granted
            pieces.push([0x6a, 0x01], call('timeBeginPeriod'), [0x85, 0xc0]); // test eax, eax
            failIf(JNE);
            pieces.push([0x68, ...u32(SLEEP)], call('Sleep'));
            pieces.push(call('timeGetTime'), keep('t2'));
            pieces.push(call('GetTickCount'), keep('g2'));
            // 7: g1 >= t1 -- one clock, read in order
            pieces.push(load('g1'), [0x3b, 0x05, ...u32(at('t1'))]);     // cmp eax, [t1]
            failIf(JB);
            // 8: t2 >= g1
            pieces.push(load('t2'), [0x3b, 0x05, ...u32(at('g1'))]);
            failIf(JB);
            // 9: g2 >= t2
            pieces.push(load('g2'), [0x3b, 0x05, ...u32(at('t2'))]);
            failIf(JB);
            // 10: the sleep moved timeGetTime by at least its length
            pieces.push(load('t2'), [0x2b, 0x05, ...u32(at('t1'))],      // sub eax, [t1]
                [0x3d, ...u32(SLEEP)]);                                  // cmp eax, SLEEP
            failIf(JB);
            // 11: and by no more than a second
            pieces.push([0x3d, ...u32(1000)]);
            failIf(JA);
            // 12: the address GetProcAddress hands out is the one the import took
            pieces.push([0x68, ...u32(at('winmm'))], call('GetModuleHandleA'),
                [0x68, ...u32(at('name'))], [0x50], call('GetProcAddress'),
                [0x3b, 0x05, ...u32(iat('timeGetTime'))]);               // cmp eax, [iat]
            failIf(JNE);
            pieces.push([0x6a, 0x00], call('ExitProcess'));

            // Laid out with each failing jump to an exit of its own that
            // pushes its number.
            /** @type {number[]} */
            const body = [];
            /** @type {{ at: number, check: number }[]} */
            const fixups = [];
            for (const piece of pieces)
            {
                if (Array.isArray(piece))
                {
                    body.push(...piece);
                    continue;
                }
                body.push(...piece.jump, 0, 0, 0, 0);
                fixups.push({ at: body.length - 4, check: piece.check });
            }
            for (const { at: from, check: number } of fixups)
            {
                const exit = body.length;
                body.push(0x6a, number, ...call('ExitProcess'));
                const rel = exit - (from + 4);
                body.splice(from, 4, ...u32(rel));
            }
            return body;
        },
    });
}

/**
 * Runs the program to its exit and reads, before the machine goes, what
 * crossed into the host.
 *
 * @param {'emulator' | 'cork'} engine
 */
async function run(engine){
    const wasm = await readFile(new URL('v86.wasm', PREBUILT));
    const app = await createApp({
        executable: buildClockExe(),
        engine,
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
    });
    try
    {
        const code = await app.run({ timeoutMs: 30000 });
        const bridge = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'bridge');
        return { code, hot: /** @type {[string, number][]} */ (bridge?.metrics?.hot ?? []) };
    }
    finally
    {
        await app.dispose();
    }
}

for (const engine of /** @type {const} */ (['cork', 'emulator']))
{
    test(`timeGetTime is GetTickCount's routine in the guest, under ${engine}`,
        { timeout: 60000 }, async()=>{
            const { code, hot } = await run(engine);
            assert.equal(code, 0, 'the number of the first check that failed');
            const crossed = hot.map(([name])=>name);
            assert.deepEqual(crossed.filter(name=>/timeGetTime|GetTickCount|tick-count/.test(name)),
                [], 'and neither crossed into the host');
            assert.ok(crossed.includes('WINMM.dll!timeBeginPeriod'),
                'where timeBeginPeriod, a handler, did');
        });
}
