/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Disposing a run ends every process of it. A child beside its parent turns on
 * a loop of its own, with a limit of its own counted from its own start: left
 * to that, a child still computing when the page ended the run went on taking
 * the thread - from whatever the page ran next - until its limit, minutes on.
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
    imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject', 'ExitProcess'] },
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
        0x6a, 0, 0xff, 0x15, ...u32(iat('ExitProcess')),
    ],
});

/** A child that computes for ever: `jmp $`. */
const spinning = ()=>buildExe({
    imports: { 'KERNEL32.dll': ['ExitProcess'] },
    code: ()=>[0xeb, 0xfe],
});

/** Turns of the event loop, for loops under way to take what turns they would. */
const settle = async()=>{
    for (let i = 0; i < 50; i++)
    {
        await new Promise(resolve=>setTimeout(resolve, 2));
    }
};

test('a run disposed while a child still computes ends the child\'s loop with the program\'s',
    { timeout: 120_000 }, async()=>{
        // Every loop of the run asks this once a turn: the count is the turns taken.
        let turns = 0;
        /** @type {any[]} */
        const errors = [];
        const app = await createApp({
            executable: parent(),
            imagePath: 'C:\\App\\parent.exe',
            pacing: {
                yield: ()=>{
                    turns++;
                    return new Promise(resolve=>setImmediate(resolve));
                },
                wait: ()=>new Promise(resolve=>setTimeout(resolve, 1)),
            },
            storage: { load: async()=>({ files: [
                { path: 'C:\\App\\child.exe', bytes: spinning() }] }) },
        });
        app.on('error', (/** @type {any} */ event)=>errors.push(event.reason));
        const started = new Promise(resolve=>app.on('process-started', resolve));
        const run = app.run({ maxTurns: Number.MAX_SAFE_INTEGER, timeoutMs: 600_000 });
        const ended = assert.rejects(run, (/** @type {any} */ e)=>e.reason === 'disposed');
        await started;
        await settle();
        const before = turns;
        await settle();
        assert.ok(turns > before, 'the child computes: its loop turns');
        await app.dispose();
        await ended;
        await settle();
        const after = turns;
        await settle();
        assert.equal(turns, after, 'no loop of the run turns once it is disposed');
        assert.deepEqual(errors, [], 'and the disposal is no failure of a process');
    });
