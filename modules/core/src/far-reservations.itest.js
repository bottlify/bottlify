/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Reservations past 4 GiB (`cpu.far`), through `createApp`: a 64-bit program
 * reserves sixteen times 512 MiB less a page, as a 64-bit Unity player does,
 * commits a megabyte of each, writes and reads it, copies from one into the
 * next, touches what it did not commit and queries it (`test/fixtures/src/far64.c`
 * says each check). Without far reservations the 4 GiB layout holds seven of
 * them; with them every check passes - translated, interpreted, and on three
 * executors - while the memory stays within the window.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const GiB = 2 ** 30;

/**
 * @param {Record<string, unknown>} options  createApp's, past the program
 * @returns {Promise<{ code: number, lines: string[], guest: any }>}
 */
async function run(options){
    const app = await createApp({
        executable: new Uint8Array(await readFile(new URL('../test/fixtures/far64.exe',
            import.meta.url))),
        commandLine: '"C:\\far64.exe"', memorySize: 4 * GiB, ...options });
    try
    {
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({ timeoutMs: 250000 });
        const cpu = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'cpu');
        return { code, lines: output.join('').split('\r\n').filter(Boolean),
            guest: cpu?.metrics?.guestMemory };
    }
    finally
    {
        await app.dispose();
    }
}

/** @param {string[]} lines */
const failed = lines=>lines.filter(line=>line.startsWith('FAIL'));

test('without far reservations a 64-bit process\'s 4 GiB layout holds fewer than sixteen'
    + ' of 512 MiB', { timeout: 300000 }, async()=>{
    const { code, lines } = await run({});
    assert.ok(failed(lines).includes('FAIL every reservation made'), lines.join('\n'));
    assert.notEqual(code, 0);
});

for (const [name, options] of /** @type {[string, Record<string, unknown>][]} */ ([
    ['translated', { cpu: { far: true } }],
    ['interpreted', { cpu: { far: true }, cork: { config: { translate: false } } }],
    ['on three executors', { cpu: { far: true, cores: 3 } }],
]))
{
    test(`with far reservations a 64-bit process reserves 8 GiB past its window and uses what it`
        + ` commits there, ${name}`, { timeout: 300000 }, async()=>{
        const { code, lines, guest } = await run(options);
        assert.deepEqual(failed(lines), [], lines.join('\n'));
        assert.ok(lines.includes('reserved 16'), lines.join('\n'));
        assert.equal(code, 0);
        // The frames come out of the window: its memory holds no more than it did.
        assert.ok(guest.held <= 4 * GiB, `${guest.held} bytes held`);
    });
}
