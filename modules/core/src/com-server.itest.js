/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A class served out of process, beside its client.
 *
 * The compiled program is both: as the client it registers itself as the
 * class's LocalServer32 and asks for an instance; COM starts it again with
 * -Embedding as the server, which registers its class object and serves the
 * call from its message loop. The client checks what it was handed and what
 * the call wrote back, one property per line, and the server leaves once the
 * client let go.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

for (const mode of [undefined, 'workers'])
{
    test(`a client's call reaches the server COM started for it, and comes back answered (${
        mode ?? 'default'} mode)`, { timeout: 120000 }, async t=>{
        const program = new Uint8Array(await readFile(new URL('../test/fixtures/com.exe',
            import.meta.url)));
        const app = await createApp({
            executable: program,
            imagePath: 'C:\\App\\com.exe',
            engine: 'cork',
            ...mode ? { mode: /** @type {any} */ (mode) } : {},
            storage: { load: async()=>({
                files: [{ path: 'C:\\App\\com.exe', bytes: program }],
            }) },
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        /** @type {any[]} */
        const servers = [];
        app.on('process-server', (/** @type {any} */ event)=>servers.push(event));
        assert.equal(await app.run({ timeoutMs: 60000 }), 0, output.join(''));
        const lines = output.join('');
        assert.match(lines, /ok {3}server: class object registered/);
        assert.match(lines, /ok {3}client: an instance from the server it started/);
        assert.match(lines, /ok {3}client: a call made in the server, its answer written back/);
        assert.doesNotMatch(lines, /FAIL/);
        assert.equal(servers.length, 1, 'one server started');
        assert.match(servers[0].clsid, /6B2F0C1E-3D4A-4E8B-9A51-2C7D10E348B6/i);
    });
}
