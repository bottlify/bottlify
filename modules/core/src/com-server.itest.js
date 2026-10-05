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
 * client let go. With processes at once each is in a worker of its own, and
 * the class table is the run's (`com-link.js`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

for (const concurrency of /** @type {const} */ ([1, 2, 4]))
{
    test(`a client's call reaches the server COM started for it, and comes back answered`
        + ` (concurrency ${concurrency})`, { timeout: 120000 }, async t=>{
        const program = new Uint8Array(await readFile(new URL('../test/fixtures/com.exe',
            import.meta.url)));
        const app = await createApp({
            executable: program,
            imagePath: 'C:\\App\\com.exe',
            engine: 'cork',
            concurrency,
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
        /** @type {any[]} */
        const started = [];
        app.on('process-started', (/** @type {any} */ event)=>started.push(event));
        assert.equal(await app.run({ timeoutMs: 60000 }), 0, output.join(''));
        const lines = output.join('');
        assert.match(lines, /ok {3}server: class object registered/);
        assert.match(lines, /ok {3}client: an instance from the server it started/);
        assert.match(lines, /ok {3}client: a call made in the server, its answer written back/);
        assert.doesNotMatch(lines, /FAIL/);
        assert.equal(servers.length, 1, 'one server started');
        assert.match(servers[0].clsid, /6B2F0C1E-3D4A-4E8B-9A51-2C7D10E348B6/i);
        // With room for it, the server is a process in a worker of its own,
        // its client in another, and the call between them crosses the run.
        assert.equal(started.filter(event=>event.worker).length, concurrency > 1 ? 2 : 0);
    });
}

for (const concurrency of /** @type {const} */ ([1, 2, 4]))
{
    test(`a server's life and what its calls see: the call context, the client's security, a`
        + ` proxy's blanket, a wait that serves the apartment, a server process counted down and`
        + ` an object disconnected (concurrency ${concurrency})`, { timeout: 120000 }, async t=>{
        const program = new Uint8Array(await readFile(new URL('../test/fixtures/comlife.exe',
            import.meta.url)));
        const app = await createApp({
            executable: program,
            imagePath: 'C:\\App\\comlife.exe',
            engine: 'cork',
            concurrency,
            storage: { load: async()=>({
                files: [{ path: 'C:\\App\\comlife.exe', bytes: program }],
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
        // Every line the program checks, client and server.
        assert.equal(lines.match(/^ok {3}/gm)?.length, 16, lines);
    });
}

test('marshaling within a process: a table\'s packet read twice and released, the free-threaded'
    + ' marshaler for its process and for another, an object that aggregates it marshaled in a'
    + ' custom OBJREF, the standard marshaler; every count given back', { timeout: 60000 },
async t=>{
    const program = new Uint8Array(await readFile(new URL('../test/fixtures/marshal.exe',
        import.meta.url)));
    const app = await createApp({ executable: program, imagePath: 'C:\\App\\marshal.exe',
        engine: 'cork' });
    t.after(()=>app.dispose());
    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
        output.push(text));
    assert.equal(await app.run({ timeoutMs: 30000 }), 0, output.join(''));
    const lines = output.join('');
    assert.doesNotMatch(lines, /FAIL/);
    assert.equal(lines.match(/^ok {3}/gm)?.length, 22, lines);
});
