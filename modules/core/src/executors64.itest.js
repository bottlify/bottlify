/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The 64-bit fixtures on several executors, through `createApp`: each
 * program's own checks - thread and process blocks, TLS callbacks, critical
 * sections and heaps three threads use at once (`win64`), structured and C++
 * exceptions unwound through frames (`seh64`, `cxxeh64`), the C runtime
 * (`crt64`), floating-point arguments (`float64`), windows, messages and hooks
 * (`window64`, `hook64`) - answer on three executors what they answer on one.
 * What a program prints is its checks' lines and a count of failures; the two
 * runs print the same, and none fails.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

/** Each fixture and its command line's arguments. */
const FIXTURES = /** @type {[string, string][]} */ ([['win64', ' one two'], ['seh64', ''],
    ['cxxeh64', ''], ['crt64', ' one two'], ['float64', ''], ['window64', ''], ['hook64', '']]);

/**
 * @param {string} name @param {string} args @param {number} cores
 * @returns {Promise<{ code: number, text: string, slices: number }>}
 */
async function run(name, args, cores){
    const app = await createApp({
        executable: new Uint8Array(await readFile(new URL(`../test/fixtures/${name}.exe`,
            import.meta.url))),
        commandLine: `"C:\\${name}.exe"${args}`, cpu: { cores },
    });
    try
    {
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({});
        const kernel = (await app.diagnostics())
            .find((/** @type {any} */ found)=>found.name === 'kernel')?.metrics;
        return { code, text: output.join(''), slices: (kernel?.scheduler ?? kernel)
            ?.executorSlices ?? 0 };
    }
    finally
    {
        await app.dispose();
    }
}

for (const [name, args] of FIXTURES)
{
    test(`${name}.exe answers on three executors what it answers on one`, { timeout: 600_000 },
        async()=>{
            const one = await run(name, args, 1);
            const three = await run(name, args, 3);
            assert.doesNotMatch(three.text, /FAILED/, three.text);
            assert.equal(three.code, one.code);
            // A line that names a thread's id or an address is the run's own.
            const lines = (/** @type {string} */ text)=>text.split('\n')
                .map(line=>line.replace(/0x[0-9a-f]+|\b\d{3,}\b/gi, '#'));
            assert.deepEqual(lines(three.text), lines(one.text));
        });
}

test('a 64-bit program with threads runs them on other executors', { timeout: 600_000 },
    async()=>{
        const { slices } = await run('win64', ' one two', 3);
        assert.ok(slices > 0, `${slices} slices on another executor`);
    });
