/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A .NET 4 console program (test/fixtures/src/managed.cs) run to its end
 * under a bottle's Mono runtime, which mscoree.dll's `_CorExeMain` hands it
 * to: its output, its two exceptions caught by the runtime's own fault
 * handling, a thread, the collector and its command line, exit code 0 when
 * every check in it passed.
 *
 * The runtime is Mono's own Windows build -- wine-mono's x86 tree, a
 * directory with `bin\libmono-2.0-x86.dll`, `lib\mono\4.5` and `etc\mono` --
 * and is not part of the repository: BOTTLIFY_MONO names where it is
 * unpacked. Without it the test says it was skipped and why.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from './app.js';

const FIXTURE = new URL('../test/fixtures/managed.exe', import.meta.url);
const RUNTIME = process.env.BOTTLIFY_MONO ?? '';

/** The class libraries the program reaches, of lib\mono\4.5. */
const LIBRARIES = ['mscorlib.dll', 'System.dll', 'System.Core.dll', 'System.Configuration.dll',
    'System.Xml.dll'];

/** What the program prints under Windows' .NET 4 and under Mono alike. */
const EXPECTED = ['managed: started with 2 arguments', 'managed: caught division by zero',
    'managed: caught null reference', 'managed: thread summed 5050',
    'managed: sqrt(2) = 1.414214', 'managed: ok'];

/**
 * Every file under a directory, at its place under a guest directory.
 *
 * @param {string} host @param {string} guest
 * @returns {Promise<{ path: string, bytes: Uint8Array }[]>}
 */
async function filesUnder(host, guest){
    const out = [];
    for (const name of await readdir(host))
    {
        const path = join(host, name);
        if ((await stat(path)).isDirectory())
        {
            out.push(...await filesUnder(path, `${guest}\\${name}`));
        }
        else
        {
            out.push({ path: `${guest}\\${name}`, bytes: new Uint8Array(await readFile(path)) });
        }
    }
    return out;
}

test('a .NET program runs to its end under the bottle\'s Mono',
    { timeout: 20 * 60_000, skip: RUNTIME ? false
        : 'BOTTLIFY_MONO is not set: no Mono runtime (wine-mono x86 unpacked) to run under' },
    async t=>{
        const mono = 'C:\\Windows\\Mono';
        const executable = new Uint8Array(await readFile(FIXTURE));
        const runtime = join(RUNTIME, 'bin', 'libmono-2.0-x86.dll');
        const files = [
            // The runtime opens the program's assembly by its path, as a file.
            { path: 'C:\\App\\managed.exe', bytes: executable },
            { path: `${mono}\\bin\\libmono-2.0-x86.dll`,
                bytes: new Uint8Array(await readFile(runtime)) },
            ...await filesUnder(join(RUNTIME, 'etc'), `${mono}\\etc`),
            ...await Promise.all(LIBRARIES.map(async name=>({
                path: `${mono}\\lib\\mono\\4.5\\${name}`,
                bytes: new Uint8Array(await readFile(join(RUNTIME, 'lib', 'mono', '4.5', name))),
            }))),
        ];
        const app = await createApp({
            executable,
            imagePath: 'C:\\App\\managed.exe',
            commandLine: '"C:\\App\\managed.exe" one "two words"',
            windows: 'win7',
            files,
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({ timeoutMs: 15 * 60_000 });
        assert.deepEqual(output.join('').split(/\r?\n/).filter(Boolean), EXPECTED);
        assert.equal(code, 0, 'every check in the program passed');
    });

test('a .NET program in a bottle without Mono ends with STATUS_DLL_NOT_FOUND, the loss said',
    { timeout: 60_000 }, async t=>{
        // _CorExeMain gives up after awaiting the runtime's files: ending the
        // process from there parked a call no longer on the bridge, and the
        // engine failed instead of the program ending.
        const executable = new Uint8Array(await readFile(FIXTURE));
        const app = await createApp({ executable, imagePath: 'C:\\App\\managed.exe',
            windows: 'win7', files: [{ path: 'C:\\App\\managed.exe', bytes: executable }] });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const said = [];
        app.on('loss', (/** @type {any} */ seen)=>said.push(seen.detail));
        assert.equal(await app.run({ timeoutMs: 50_000 }) >>> 0, 0xc0000135);
        assert.ok(said.some(detail=>/the managed program does not run/.test(detail)),
            said.join('\n'));
    });
