/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A 64-bit process on several executors, through `createApp`: four threads of
 * an x86-64 program change the same memory at once through every locked form
 * (`test/fixtures/src/locks64.c` says which), and each sum is right only if
 * no change is lost - the atomic variant of long-mode code (`emitLockedLong`)
 * and the interpreter's (`evaluateLocked`). On one executor the same program
 * is the reference: threads take turns, nothing can be lost.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const FIXTURE = new URL('../test/fixtures/locks64.exe', import.meta.url);

for (const cores of [1, 3])
{
    test(`four threads of a 64-bit program lose no locked change on ${cores}`
        + ` executor${cores > 1 ? 's' : ''}`, { timeout: 120_000 }, async t=>{
        const app = await createApp({ executable: new Uint8Array(await readFile(FIXTURE)),
            cpu: { cores } });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({});
        const text = output.join('');
        assert.doesNotMatch(text, /FAILED/, text);
        assert.match(text, /failed 0\n$/, text);
        assert.equal(code, 0);
        if (cores > 1)
        {
            // The threads ran beside each other, or the sums prove nothing.
            const kernel = (await app.diagnostics())
                .find((/** @type {any} */ found)=>found.name === 'kernel')?.metrics;
            const slices = (kernel?.scheduler ?? kernel)?.executorSlices;
            assert.ok(slices > 0, `${slices} slices on another executor`);
        }
    });
}
