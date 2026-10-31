/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A window thread waiting in GetMessage while another thread works does not
 * make every turn a trip round the event loop: the waiting thread looks at its
 * queue every turn without the host, and on a page a trip costs more than a
 * turn of the working thread's guest code. The program's main thread waits
 * in GetMessage while a thread it made counts down and then posts it WM_QUIT.
 * On several processors the counting thread runs on another executor and the
 * process's turns wait for it: those are the guest working too, not a machine
 * with nothing to do, and make no trip either.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, pagePacing } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

const WM_QUIT = 0x12;
/**
 * Twice this many instructions: hundreds of turns of a hundred thousand on
 * one processor; on several, the process's turns wait a few milliseconds each
 * for the other executor, and the count is twenty times as long to make as many.
 */
const COUNT = 30_000_000;

/** @param {number} count */
function buildProgram(count){
    return buildExe({
        imports: {
            'KERNEL32.dll': ['GetCurrentThreadId', 'CreateThread', 'ExitProcess'],
            'USER32.dll': ['GetMessageA', 'PostThreadMessageA'],
        },
        data: { tid: [0, 0, 0, 0], msg: new Array(28).fill(0) },
        codeSize: 0x100,
        code: ({ iat, at, code })=>{
            /** @param {string} fn */
            const call = fn=>[0xff, 0x15, ...u32(iat(fn))];
            /** @param {number} start */
            const main = start=>[
                ...call('GetCurrentThreadId'),
                0xa3, ...u32(at('tid')), //                      mov [tid], eax
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, //           id, flags, parameter
                0x68, ...u32(start), 0x6a, 0x00, 0x6a, 0x00, //  start, stack, attributes
                ...call('CreateThread'),
                // L: GetMessageA(&msg, 0, 0, 0) until it answers WM_QUIT's 0
                0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(at('msg')),
                ...call('GetMessageA'),
                0x85, 0xc0, //                                   test eax, eax
                0x75, 0x100 - 21, //                             jnz L
                0x6a, 0x00, ...call('ExitProcess'),
            ];
            const worker = [
                0xb9, ...u32(count), //                          mov ecx, count
                0x49, //                                         W: dec ecx
                0x75, 0xfd, //                                   jnz W
                0x6a, 0x00, 0x6a, 0x00, 0x6a, WM_QUIT, //        lParam, wParam, Msg
                0xff, 0x35, ...u32(at('tid')), //                push [tid]
                ...call('PostThreadMessageA'),
                0x31, 0xc0, //                                   xor eax, eax
                0xc2, 0x04, 0x00, //                             ret 4
            ];
            return [...main(code(main(0).length)), ...worker];
        },
    });
}

for (const cores of [1, 2])
{
    test(`a thread waiting in GetMessage beside one that works costs no trip a turn (${cores})`,
        { timeout: 60000 }, async t=>{
            let turns = 0;
            let trips = 0;
            // The page's own pacing, with a clock that never moves, so a trip is
            // only ever one the loop asked for because something was pending.
            const paced = pagePacing({
                macrotask: ()=>{
                    trips++;
                    return new Promise(resolve=>{
                        setImmediate(resolve);
                    });
                },
                hidden: ()=>false,
                now: ()=>0,
            });
            const app = await createApp({
                executable: buildProgram(cores > 1 ? COUNT * 20 : COUNT),
                imagePath: 'C:\\App\\Pacing.exe',
                cpu: { cores },
                // Turns of a quantum, as counted: one among ready threads is
                // otherwise as long as a quarter of a millisecond takes.
                quantum: 100_000,
                pacing: {
                    yield: pending=>{
                        turns++;
                        return paced.yield(pending);
                    },
                    wait: paced.wait,
                },
            });
            t.after(()=>app.dispose());

            assert.equal(await app.run({ timeoutMs: 40000 }), 0);
            assert.ok(turns > 200, `the count ran across many turns, not ${turns}`);
            assert.ok(trips < turns / 20,
                `${trips} trips round the event loop in ${turns} turns`);
        });
}
