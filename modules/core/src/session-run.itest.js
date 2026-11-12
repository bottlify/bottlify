/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One saver a run: a parent that starts two children which each write a file,
 * and exits without waiting for them, as a launcher does. Every write is
 * announced once and reaches the session once, whether the children run in
 * the parent's place (concurrency 1: the saving passes from the parent, which
 * ended, to the child that stands) or in workers of their own (their writes
 * land on the volume the run's thread saves). A saver a process made every
 * write as many times as processes stood, and each new one rewrote the whole
 * volume. A process in a worker is handed its storage only where the storage
 * is a name (`'opfs'`), which this file's store is not: that it saves nothing
 * there is the rule `remoteSystem` marks (`remote`), tested beside it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
/** @param {string} text */
const ascii = text=>[...text].map(character=>character.charCodeAt(0)).concat(0);

/**
 * A program that sleeps, then writes `text` to `path` and exits.
 *
 * @param {string} path @param {string} text @param {number} sleepMs
 */
function writer(path, text, sleepMs){
    return buildExe({
        imports: { 'KERNEL32.dll': ['Sleep', 'CreateFileA', 'WriteFile', 'CloseHandle',
            'ExitProcess'] },
        data: { path: ascii(path), text: [...text].map(c=>c.charCodeAt(0)), written: u32(0) },
        codeSize: 0x80,
        code: ({ iat, at })=>[
            0x68, ...u32(sleepMs), 0xff, 0x15, ...u32(iat('Sleep')),
            // CreateFileA(path, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, 0, NULL)
            0x6a, 0, 0x6a, 0, 0x6a, 2, 0x6a, 0, 0x6a, 0, 0x68, ...u32(0x40000000),
            0x68, ...u32(at('path')), 0xff, 0x15, ...u32(iat('CreateFileA')),
            0x89, 0xc3, // mov ebx, eax
            // WriteFile(handle, text, length, &written, NULL)
            0x6a, 0, 0x68, ...u32(at('written')), 0x6a, text.length, 0x68, ...u32(at('text')),
            0x53, 0xff, 0x15, ...u32(iat('WriteFile')),
            0x53, 0xff, 0x15, ...u32(iat('CloseHandle')),
            0x6a, 0, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
}

/** A parent that starts C:\\App\\a.exe and C:\\App\\b.exe and exits at once. */
function launcher(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateProcessA', 'ExitProcess'] },
        data: {
            first: ascii('C:\\App\\a.exe'),
            second: ascii('C:\\App\\b.exe'),
            startup: [...u32(68), ...new Array(64).fill(0)],
            infoA: new Array(16).fill(0),
            infoB: new Array(16).fill(0),
        },
        codeSize: 0x80,
        code: ({ iat, at })=>{
            /** @param {string} command @param {string} info */
            const start = (command, info)=>[
                0x68, ...u32(at(info)), 0x68, ...u32(at('startup')),
                0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
                0x68, ...u32(at(command)), 0x6a, 0,
                0xff, 0x15, ...u32(iat('CreateProcessA')),
            ];
            return [...start('first', 'infoA'), ...start('second', 'infoB'),
                0x6a, 0, 0xff, 0x15, ...u32(iat('ExitProcess'))];
        },
    });
}

for (const concurrency of [1, 4])
{
    test(`a run of three processes saves each write once, with one saver (concurrency `
        + `${concurrency})`, async()=>{
        /** @type {Map<string, number>} each path, by how many announcements named it */
        const announced = new Map();
        /** @type {Map<string, string>} what the last save handed over, by path */
        const saved = new Map();
        const app = await createApp({
            executable: launcher(),
            imagePath: 'C:\\App\\launcher.exe',
            concurrency,
            storage: {
                load: async()=>({ files: [
                    { path: 'C:\\App\\a.exe', bytes: writer('C:\\out-a.txt', 'AAAA', 200) },
                    { path: 'C:\\App\\b.exe', bytes: writer('C:\\out-b.txt', 'BBBB', 400) },
                ] }),
                /** @param {{ files: { path: string, bytes: Uint8Array }[] }} session */
                save: session=>{
                    saved.clear();
                    for (const file of session.files)
                    {
                        saved.set(file.path.toLowerCase(),
                            String.fromCharCode(...file.bytes.subarray(0, 16)));
                    }
                },
            },
        });
        try
        {
            app.on('session', (/** @type {{ changes: { path?: string }[] }} */ { changes })=>{
                for (const change of changes)
                {
                    if (change.path)
                    {
                        const path = change.path.toLowerCase();
                        announced.set(path, (announced.get(path) ?? 0) + 1);
                    }
                }
            });
            await app.run({ maxTurns: 200000, timeoutMs: 60000 });
        }
        finally
        {
            await app.dispose();
        }
        for (const path of ['c:\\out-a.txt', 'c:\\out-b.txt'])
        {
            assert.equal(saved.get(path), path.endsWith('a.txt') ? 'AAAA' : 'BBBB',
                `${path} reached the session`);
            // In the parent's place the child's create and write are one turn,
            // one announcement (three and two with a saver a process); from a
            // worker they reach the run's volume as two calls, two batches.
            assert.equal(announced.get(path), concurrency === 1 ? 1 : 2,
                `${path}: ${JSON.stringify([...announced])}`);
        }
    });
}
