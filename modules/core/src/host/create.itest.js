/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The package's `createApp` on a thread with no worker and no display: the
 * engine behind the port protocol, answering the same controller a page holds.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from '../index.js';
import { buildExe } from '../../../../tools/make-pe.mjs';

const FIXTURE = new URL('../../test/fixtures/hello.exe', import.meta.url);

test('hello.exe runs through the package entry, headless, on this thread',
    { timeout: 30_000 }, async t=>{
        const exe = await readFile(FIXTURE);
        const app = await createApp({
            host: 'thread',
            executable: new Uint8Array(exe),
        });
        t.after(()=>app.dispose());
        assert.equal(app.host, 'thread');
        assert.equal(app.canvas, null);

        // `libraries` is one of `buildApp`'s construction-time events: emitted
        // before `createApp`'s own promise settles, so a handler registered
        // the documented way -- after `await createApp(...)` -- always
        // subscribes after the fact. Through the real engine and the real
        // host protocol (no fake in the middle), not just the wire's fake
        // transport in `remote.test.js`.
        const librariesSeen = await new Promise(resolve=>{
            app.on('libraries', (/** @type {any} */ payload)=>resolve(payload));
        });
        assert.ok(Array.isArray(librariesSeen.loaded),
            'the construction-time emission reached a handler registered after createApp resolved');

        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({ maxTurns: 200000, timeoutMs: 30_000 });
        assert.equal(code, 0);
        assert.equal(output.join(''), 'Hello from Bottlify\r\n');

        const layers = await app.diagnostics();
        const cpu = layers.find((/** @type {any} */ layer)=>layer.name === 'cpu');
        assert.ok(cpu.metrics.instructions > 0, 'the reads that cross the port answer as promises');
        assert.ok((await app.log.recent(10)).length >= 0, 'the keeper answers with a promise');
    });

test('hello.exe runs the same with concurrency, its engine fed through the inbound ring',
    { timeout: 30_000 }, async t=>{
        const exe = await readFile(FIXTURE);
        const app = await createApp({
            host: 'thread',
            executable: new Uint8Array(exe),
            concurrency: 2,
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({ maxTurns: 200000, timeoutMs: 30_000 });
        assert.equal(code, 0);
        assert.equal(output.join(''), 'Hello from Bottlify\r\n');
        const layers = await app.diagnostics();
        const metrics = layers.find((/** @type {any} */ layer)=>layer.name === 'app').metrics;
        assert.deepEqual([metrics.mode, metrics.concurrency], ['isolated', 2]);
        assert.deepEqual(Object.keys(metrics.pacing),
            ['drained', 'yields', 'slept', 'sleptMs', 'woken', 'heard'],
            'the ring pacing counted the run');
    });

test('with concurrency a translation batch is heard by the doorbell its worker rings',
    { timeout: 60000 }, async t=>{
        // A loop hot enough to be translated, then ExitProcess(0).
        const executable = buildExe({
            imports: { 'KERNEL32.dll': ['ExitProcess'] },
            code: ({ iat })=>[
                0xb9, 0x00, 0x00, 0x00, 0x04, // mov ecx, 0x4000000
                0x40, // inc eax
                0x49, // dec ecx
                0x75, 0xfc, // jnz back to inc eax
                0x6a, 0x00, 0xff, 0x15,
                ...[0, 8, 16, 24].map(at=>(iat('ExitProcess') >>> at) & 0xff),
            ],
        });
        const app = await createApp({
            host: 'thread',
            executable,
            concurrency: 2,
            cork: { config: { worker: true } },
        });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 50000 }), 0);
        const layers = await app.diagnostics();
        const metrics = layers.find((/** @type {any} */ layer)=>layer.name === 'app').metrics;
        const cpu = layers.find((/** @type {any} */ layer)=>layer.name === 'cpu').metrics;
        assert.ok(cpu.cork.regions > 0, 'the loop was translated');
        // Counted per yield the doorbell brought forward, not per message: two
        // posted between two looks are one yield.
        assert.ok(metrics.pacing.heard >= 1, `the worker's answers were heard: ${
            JSON.stringify(metrics.pacing)}`);
    });
