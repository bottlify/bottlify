/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's translation pool under a real run: every
 * process is lent a worker of the pool from its start and gives it back at
 * its exit, its translator emitting through the worker over the port it was
 * lent, and the program reads what it reads without the pool. The spawn
 * fixture -- a parent and two children run in turn -- runs on this thread
 * (concurrency 1) and with every process in a worker of its own
 * (concurrency 2), where the lending crosses to the process's worker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

for (const concurrency of /** @type {const} */ ([1, 2]))
{
    test(`each process of a run is lent a worker of the pool and gives it back`
        + ` (concurrency ${concurrency})`, { timeout: 120000 }, async t=>{
        const [parent, child] = await Promise.all([
            readFile(new URL('../test/fixtures/spawn.exe', import.meta.url)),
            readFile(new URL('../test/fixtures/spawn_child.exe', import.meta.url)),
        ]);
        const app = await createApp({
            executable: new Uint8Array(parent),
            imagePath: 'C:\\App\\spawn.exe',
            concurrency,
            cork: { poolPerProcess: 2, config: { worker: true, hotThreshold: 50 } },
            storage: { load: async()=>({
                files: [{ path: 'C:\\App\\spawn_child.exe', bytes: new Uint8Array(child) }],
            }) },
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({ timeoutMs: 90000 });
        const lines = output.join('').split('\r\n').filter(Boolean);
        assert.deepEqual(lines.filter(line=>line.startsWith('FAIL')), [],
            `every property holds:\n${output.join('')}`);
        assert.equal(lines.filter(line=>line.startsWith('ok   ')).length, 10,
            `and every one was reached:\n${output.join('')}`);
        assert.equal(code, 0);
        const pool = app.translationPool();
        assert.ok(pool, 'the run has a pool');
        const starts = pool.journal.filter((/** @type {any} */ one)=>one.kind === 'start');
        const exits = pool.journal.filter((/** @type {any} */ one)=>one.kind === 'exit');
        assert.equal(new Set(starts.map((/** @type {any} */ one)=>one.process)).size, 3,
            `the parent and both children were each lent one: ${JSON.stringify(pool.journal)}`);
        assert.ok(exits.length >= 2,
            `the children gave theirs back: ${JSON.stringify(pool.journal)}`);
        assert.ok(pool.workers <= 2 * 2, `${pool.workers} workers, the ceiling perProcess × n`);
    });
}
