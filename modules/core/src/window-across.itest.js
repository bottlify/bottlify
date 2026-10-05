/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One process's window, as another process sees it.
 *
 * The compiled parent makes a window and starts its child, then waits in its
 * message loop; the child finds the window by class and by title, asks which
 * process made it, reads its caption and class, and posts to it. The checks
 * are the fixture's own, one property per line, on both sides.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

for (const mode of [undefined, 'workers'])
{
    test(`a window is found, described and posted to by another process (${
        mode ?? 'default'} mode)`, { timeout: 120000 }, async t=>{
        const program = new Uint8Array(await readFile(new URL('../test/fixtures/windows.exe',
            import.meta.url)));
        const app = await createApp({
            executable: program,
            imagePath: 'C:\\App\\windows.exe',
            engine: 'cork',
            ...mode ? { mode: /** @type {any} */ (mode) } : {},
            storage: { load: async()=>({
                files: [{ path: 'C:\\App\\windows.exe', bytes: program }],
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
        assert.equal(lines.match(/^ok {3}child: /gm)?.length, 8, lines);
        assert.equal(lines.match(/^ok {3}parent: /gm)?.length, 6, lines);
    });
}
