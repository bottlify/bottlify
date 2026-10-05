/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A child in a worker of its own (roadmap/v2, stage 2): its machine in that
 * worker, the run's registry, volume, windows and ids answered from the
 * parent's thread across a link. The compiled parent starts its child twice
 * and checks, one property per line, what each left: the exit code, the file
 * it wrote, the registry value it set, a wait for any of a set.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

test('a child in a worker of its own leaves its parent its file, its registry value and its code',
    { timeout: 120000 }, async t=>{
        const [parent, child] = await Promise.all([
            readFile(new URL('../test/fixtures/spawn.exe', import.meta.url)),
            readFile(new URL('../test/fixtures/spawn_child.exe', import.meta.url)),
        ]);
        const app = await createApp({
            executable: new Uint8Array(parent),
            imagePath: 'C:\\App\\spawn.exe',
            engine: 'cork',
            mode: 'workers',
            processWorkers: true,
            storage: { load: async()=>({
                files: [{ path: 'C:\\App\\spawn_child.exe', bytes: new Uint8Array(child) }],
            }) },
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        /** @type {any[]} */
        const started = [];
        app.on('process-started', (/** @type {any} */ event)=>started.push(event));
        const code = await app.run({ timeoutMs: 60000 });
        const lines = output.join('').split('\r\n').filter(Boolean);
        assert.deepEqual(lines.filter(line=>line.startsWith('FAIL')), [], output.join(''));
        assert.equal(lines.filter(line=>line.startsWith('ok   ')).length, 10, output.join(''));
        assert.deepEqual(lines.filter(line=>!line.startsWith('ok   ')),
            ['child: first', 'child: second', 'parent: done'],
            'each child\'s output reached the run, before the parent went on');
        assert.equal(code, 0);
        assert.deepEqual(started.map(event=>event.worker), [true, true],
            'both ran in workers of their own');
    });
