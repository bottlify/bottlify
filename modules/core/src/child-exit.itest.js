/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A parent waiting on its child's process handle wakes however the child
 * ends -- faulting or exiting -- and reads its exit code, while the child's
 * machine is still being taken down: until the parent is told, the child
 * counts as running, and a parent whose every thread waits on it is not
 * deadlocked.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
/** @param {string} text */
const ascii = text=>[...text].map(character=>character.charCodeAt(0)).concat(0);

/** CreateProcess, WaitForSingleObject(INFINITE), then ExitProcess(0x100 | the child's code's low byte). */
const parent = ()=>buildExe({
    imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject', 'GetExitCodeProcess',
        'ExitProcess'] },
    data: {
        command: ascii('C:\\App\\child.exe'),
        startup: [...u32(68), ...new Array(64).fill(0)],
        info: new Array(16).fill(0),
        code: u32(0x12345678),
    },
    codeSize: 0x80,
    code: ({ iat, at })=>[
        0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
        0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
        0x68, ...u32(at('command')), 0x6a, 0,
        0xff, 0x15, ...u32(iat('CreateProcessA')),
        0x6a, 0xff, 0xff, 0x35, ...u32(at('info')), // WaitForSingleObject(hProcess, INFINITE)
        0xff, 0x15, ...u32(iat('WaitForSingleObject')),
        0x68, ...u32(at('code')), 0xff, 0x35, ...u32(at('info')),
        0xff, 0x15, ...u32(iat('GetExitCodeProcess')),
        0xa1, ...u32(at('code')), 0x0f, 0xb6, 0xc0, 0x0d, ...u32(0x100), 0x50, // movzx; or
        0xff, 0x15, ...u32(iat('ExitProcess')),
    ],
});

/** A child that reads address 0. */
const faulting = ()=>buildExe({
    imports: { 'KERNEL32.dll': ['ExitProcess'] },
    code: ({ iat })=>[
        0xa1, ...u32(0), // mov eax, [0]
        0x6a, 7, 0xff, 0x15, ...u32(iat('ExitProcess')),
    ],
});

/** A child that exits with 7. */
const exiting = ()=>buildExe({
    imports: { 'KERNEL32.dll': ['ExitProcess'] },
    code: ({ iat })=>[0x6a, 7, 0xff, 0x15, ...u32(iat('ExitProcess'))],
});

for (const [how, child] of /** @type {const} */ ([['faults', faulting], ['exits', exiting]]))
{
    test(`a parent waiting on a child that ${how} wakes with the child's code`,
        { timeout: 120_000 }, async t=>{
            const app = await createApp({
                executable: parent(),
                imagePath: 'C:\\App\\parent.exe',
                // A loop that takes its next turn at once rather than after a
                // timer, as a page's does once its waits are answered: it turns
                // while the child's machine is taken down, which awaits.
                pacing: { yield: ()=>null, wait: ()=>Promise.resolve() },
                storage: { load: async()=>({ files: [
                    { path: 'C:\\App\\child.exe', bytes: child() }] }) },
            });
            t.after(()=>app.dispose());
            /** @type {any[]} */
            const resumed = [];
            app.on('process-resumed', (/** @type {any} */ event)=>resumed.push(event.code));
            const code = (await app.run({ timeoutMs: 60_000 })) >>> 0;
            assert.equal(resumed.length, 1, 'the child ended');
            assert.equal(code, 0x100 | resumed[0] & 0xff, 'and the parent read its code');
            if (how === 'exits')
            {
                assert.equal(code, 0x107);
            }
        });
}
