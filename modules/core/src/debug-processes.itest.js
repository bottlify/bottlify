/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The page's look at one process by its id answers for that process: the
 * first is the program the page started even while a child it started runs,
 * though the facade speaks for the child started last.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/fixtures/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
/** @param {string} text */
const ascii = text=>[...text].map(character=>character.charCodeAt(0)).concat(0);

/** CreateProcess, then WaitForSingleObject(INFINITE) on the child. */
const parent = ()=>buildExe({
    imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject'] },
    data: {
        command: ascii('C:\\App\\child.exe'),
        startup: [...u32(68), ...new Array(64).fill(0)],
        info: new Array(16).fill(0),
    },
    codeSize: 0x80,
    code: ({ iat, at })=>[
        0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
        0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
        0x68, ...u32(at('command')), 0x6a, 0,
        0xff, 0x15, ...u32(iat('CreateProcessA')),
        0x6a, 0xff, 0xff, 0x35, ...u32(at('info')),
        0xff, 0x15, ...u32(iat('WaitForSingleObject')),
        0xeb, 0xfe,
    ],
});

/** A child that sleeps for ever. */
const child = ()=>buildExe({
    imports: { 'KERNEL32.dll': ['Sleep'] },
    code: ({ iat })=>[0x6a, 0xff, 0xff, 0x15, ...u32(iat('Sleep')), 0xeb, 0xf7],
});

test('the first process by its id is the program, not the child the facade speaks for',
    { timeout: 120_000 }, async t=>{
        const app = /** @type {any} */ (await createApp({
            executable: parent(),
            imagePath: 'C:\\App\\parent.exe',
            storage: { load: async()=>({ files: [
                { path: 'C:\\App\\child.exe', bytes: child() }] }) },
        }));
        t.after(()=>app.dispose());
        const running = app.run({ timeoutMs: 60_000 }).catch(()=>null);
        const until = Date.now() + 60_000;
        while (app.debug.processes().length < 2 && Date.now() < until)
        {
            await new Promise(resolve=>setTimeout(resolve, 20));
        }
        const [first, second] = app.debug.processes();
        assert.ok(second, 'the child stands');
        /** @param {number} id */
        const calls = async id=>JSON.stringify((await app.debug.diagnosticsOf(id))
            .find((/** @type {any} */ table)=>table.name === 'bridge').metrics.byFunction);
        assert.match(await calls(first.id), /CreateProcessA/, 'the program made the call');
        assert.doesNotMatch(await calls(second.id), /CreateProcessA/, 'the child did not');
        app.stop?.();
        await running;
    });
