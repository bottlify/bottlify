/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The foreground window across processes (roadmap/v2/windows.md, step 2):
 * the run's, whichever process's window it is. The fixture's child takes it
 * from its parent, finds the parent's window under a point and among every
 * top-level window, and gives it back; each program is told as Windows tells
 * it, naming the other's thread. Where one process runs at a time the parent
 * is held while its child runs and hears of it as it looks at its queue again.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

for (const concurrency of /** @type {const} */ ([1, 2, 4]))
{
    test(`another program's window takes the foreground and gives it back, both programs told`
        + ` (concurrency ${concurrency})`, { timeout: 120000 }, async t=>{
        const program = new Uint8Array(await readFile(new URL('../test/fixtures/activate.exe',
            import.meta.url)));
        const app = await createApp({
            executable: program,
            imagePath: 'C:\\App\\activate.exe',
            engine: 'cork',
            concurrency,
            storage: { load: async()=>({
                files: [{ path: 'C:\\App\\activate.exe', bytes: program }],
            }) },
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        assert.equal(await app.run({ timeoutMs: 60000 }), 0, output.join(''));
        const lines = output.join('');
        assert.doesNotMatch(lines, /FAIL/);
        // Every line the program checks, parent and child.
        // Two processes at once interleave their writes, a verdict and its name
        // apart, and two checks can share a line: the verdicts are counted.
        assert.equal(lines.match(/ok {3}/g)?.length, 8, lines);
    });
}
