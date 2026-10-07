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

// Where processes run at once a message sent to the parent's window is
// answered; where one runs at a time the parent runs nothing while its child
// does, and a send is refused rather than waited on for ever.
// With concurrency the child is in a worker of its own, and every window
// question crosses a link -- the child's about the parent's, and the parent's
// about the child's.
for (const [concurrency, flag, sends] of /** @type {const} */ ([
    [1, '', 0], [1, '-held', 2], [2, '', 0], [2, '-send', 6]]))
{
    test(`a window is found, described and posted to by another process (concurrency ${
        concurrency}${flag ? `, ${flag}` : ''})`, { timeout: 120000 }, async t=>{
        const program = new Uint8Array(await readFile(new URL('../test/fixtures/windows.exe',
            import.meta.url)));
        const app = await createApp({
            executable: program,
            imagePath: 'C:\\App\\windows.exe',
            commandLine: `"C:\\App\\windows.exe" ${flag}`.trim(),
            engine: 'cork',
            concurrency,
            storage: { load: async()=>({
                files: [{ path: 'C:\\App\\windows.exe', bytes: program }],
            }) },
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        // The run's window manager, looked at while the processes stand:
        // each top-level window it held, with the process it said made it.
        /** @type {Map<string, Set<number>>} */
        const seen = new Map();
        const watching = setInterval(()=>{
            const table = app.diagnostics().find((/** @type {any} */ each)=>
                each.name === 'windows');
            for (const window of table?.metrics.topLevel ?? [])
            {
                const processes = seen.get(window.className) ?? new Set();
                processes.add(window.process);
                seen.set(window.className, processes);
            }
        }, 20);
        const code = await app.run({ timeoutMs: 60000 });
        clearInterval(watching);
        assert.equal(code, 0, output.join(''));
        const host = [...seen.get('BottlifyHost') ?? []];
        const guest = [...seen.get('BottlifyGuest') ?? []];
        assert.equal(host.length, 1, `the run held the parent's window: ${JSON.stringify(
            Object.fromEntries([...seen].map(([name, ids])=>[name, [...ids]])))}`);
        // The child makes a window of its own only to be sent to.
        if (flag === '-send')
        {
            assert.equal(guest.length, 1, 'and the child\'s');
            assert.notEqual(host[0], guest[0], 'each as its own process\'s');
        }
        const after = app.diagnostics().find((/** @type {any} */ each)=>each.name === 'windows');
        assert.deepEqual(after?.metrics.topLevel, [], 'and none once their processes ended');
        const lines = output.join('');
        // Each process writes a check's verdict and its name apart, and two
        // that run at once interleave their writes: no check failed, and each
        // was reached, read from the names rather than from whole lines.
        assert.doesNotMatch(lines, /FAIL/);
        assert.equal(lines.match(/child: [a-zA-Z]/g)?.length, 9 + sends, lines);
        assert.equal(lines.match(/parent: [a-zA-Z]/g)?.length, 7 + (flag === '-send' ? 2 : 0),
            lines);
    });
}
