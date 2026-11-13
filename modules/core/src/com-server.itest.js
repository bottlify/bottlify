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
import { createHive, HKEY_LOCAL_MACHINE, REG_SZ } from './layers/win32/advapi32/registry.js';
import { buildExe } from '../../../tools/make-pe.mjs';

for (const concurrency of /** @type {const} */ ([1, 2, 4]))
{
    test(`a client's call reaches the server COM started for it, and comes back answered`
        + ` (concurrency ${concurrency})`, { timeout: 120000 }, async t=>{
        const program = new Uint8Array(await readFile(new URL('../test/fixtures/com.exe',
            import.meta.url)));
        const app = await createApp({
            executable: program,
            imagePath: 'C:\\App\\com.exe',
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
        + ` proxy's blanket, a wait that serves the apartment, a server process counted down, a`
        + ` failed call's error information and an object disconnected`
        + ` (concurrency ${concurrency})`, { timeout: 120000 }, async t=>{
        const program = new Uint8Array(await readFile(new URL('../test/fixtures/comlife.exe',
            import.meta.url)));
        const app = await createApp({
            executable: program,
            imagePath: 'C:\\App\\comlife.exe',
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
        // Two processes at once interleave their writes, a verdict and its name
        // apart, and two checks can share a line: the verdicts are counted.
        assert.equal(lines.match(/ok {3}/g)?.length, 18, lines);
    });
}

test('marshaling within a process: a table\'s packet read twice and released, the free-threaded'
    + ' marshaler for its process and for another, an object that aggregates it marshaled in a'
    + ' custom OBJREF, the standard marshaler; every count given back', { timeout: 60000 },
async t=>{
    const program = new Uint8Array(await readFile(new URL('../test/fixtures/marshal.exe',
        import.meta.url)));
    const app = await createApp({ executable: program, imagePath: 'C:\\App\\marshal.exe' });
    t.after(()=>app.dispose());
    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
        output.push(text));
    assert.equal(await app.run({ timeoutMs: 60_000 }), 0, output.join(''));
    const lines = output.join('');
    assert.doesNotMatch(lines, /FAIL/);
    assert.equal(lines.match(/^ok {3}/gm)?.length, 22, lines);
});

test('an apartment\'s context: one object per apartment, its token handed out without a count,'
    + ' the multithreaded apartment\'s another, and a callback run in a context -- another'
    + ' single-threaded apartment\'s on that apartment\'s thread while it waits',
{ timeout: 60000 }, async t=>{
    const program = new Uint8Array(await readFile(new URL('../test/fixtures/contexts.exe',
        import.meta.url)));
    const app = await createApp({ executable: program, imagePath: 'C:\\App\\contexts.exe' });
    t.after(()=>app.dispose());
    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
        output.push(text));
    assert.equal(await app.run({ timeoutMs: 60_000 }), 0, output.join(''));
    const lines = output.join('');
    assert.doesNotMatch(lines, /FAIL/);
    assert.equal(lines.match(/^ok {3}/gm)?.length, 20, lines);
});

for (const concurrency of /** @type {const} */ ([1, 2, 4]))
{
    test('the running object table across processes: an object its server registered, found by'
        + ' class, by moniker and by display name in another, and gone with its server'
        + ` (concurrency ${concurrency})`, { timeout: 120000 }, async t=>{
        const program = new Uint8Array(await readFile(new URL('../test/fixtures/rot.exe',
            import.meta.url)));
        const app = await createApp({
            executable: program,
            imagePath: 'C:\\App\\rot.exe',
            concurrency,
            storage: { load: async()=>({
                files: [{ path: 'C:\\App\\rot.exe', bytes: program }],
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
        // Two processes at once interleave their writes, a verdict and its name
        // apart, and two checks can share a line: the verdicts are counted.
        assert.equal(lines.match(/ok {3}/g)?.length, 13, lines);
    });
}

for (const concurrency of /** @type {const} */ ([1, 2]))
{
    test('a class served by a service: COM starts the service for it, and the run ends with its'
        + ` client, the service ended with it (concurrency ${concurrency})`,
    { timeout: 120000 }, async t=>{
        const program = new Uint8Array(await readFile(new URL('../test/fixtures/comservice.exe',
            import.meta.url)));
        const app = await createApp({
            executable: program,
            imagePath: 'C:\\App\\comservice.exe',
            concurrency,
            storage: { load: async()=>({
                files: [{ path: 'C:\\App\\comservice.exe', bytes: program }],
            }) },
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        /** @type {string[]} */
        const said = [];
        app.on('divergence', (/** @type {any} */ event)=>said.push(event.detail));
        // The service never leaves on its own: the run ends because its
        // client did, not because the service did.
        assert.equal(await app.run({ timeoutMs: 60000 }), 0, output.join(''));
        const lines = output.join('');
        assert.match(lines, /ok {3}service: class object registered/);
        assert.match(lines, /ok {3}client: a call made in the service, its answer written back/);
        assert.doesNotMatch(lines, /FAIL/);
        assert.ok(said.some(detail=>/service BottlifyServed is ended with the run/.test(detail)),
            said.join('\n'));
    });
}

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
/** @param {number} a @param {number} b @param {number} c @param {number[]} d */
const guid = (a, b, c, d)=>[...u32(a), b & 255, b >>> 8, c & 255, c >>> 8, ...d];

for (const concurrency of /** @type {const} */ ([1, 2]))
{
    test('the run\'s code is its program\'s, not that of a server COM started for it and that'
        + ` outlived it (concurrency ${concurrency})`, { timeout: 60000 }, async t=>{
        // A thread asks for an instance of a class served out of process; the
        // program leaves with 0 while the server it started still runs, which
        // ends later with 7 - an installer gone while the ngen service it woke
        // winds down.
        const client = buildExe({
            imports: {
                'KERNEL32.dll': ['CreateThread', 'Sleep', 'ExitProcess'],
                'ole32.dll': ['CoInitialize', 'CoCreateInstance'],
            },
            data: {
                clsid: guid(0x3C1A7E52, 0x9D04, 0x4B6F,
                    [0xA1, 0xE8, 0x5F, 0x0B, 0x2D, 0x7C, 0x9A, 0x31]),
                iid: guid(0, 0, 0, [0xC0, 0, 0, 0, 0, 0, 0, 0x46]),
                out: u32(0),
            },
            codeSize: 0x80,
            code: ({ iat, at, code })=>[
                0x6a, 0, 0x6a, 0, 0x6a, 0, 0x68, ...u32(code(0x40)), 0x6a, 0, 0x6a, 0,
                0xff, 0x15, ...u32(iat('CreateThread')),
                0x68, ...u32(500), 0xff, 0x15, ...u32(iat('Sleep')),
                0x6a, 0, 0xff, 0x15, ...u32(iat('ExitProcess')),
                ...new Array(0x40 - 40).fill(0xcc),
                0x6a, 0, 0xff, 0x15, ...u32(iat('CoInitialize')),
                0x68, ...u32(at('out')), 0x68, ...u32(at('iid')), 0x6a, 4, 0x6a, 0,
                0x68, ...u32(at('clsid')), 0xff, 0x15, ...u32(iat('CoCreateInstance')),
                0xc2, 4, 0,
            ],
        });
        const server = buildExe({
            imports: { 'KERNEL32.dll': ['Sleep', 'ExitProcess'] },
            code: ({ iat })=>[0x68, ...u32(3000), 0xff, 0x15, ...u32(iat('Sleep')),
                0x6a, 7, 0xff, 0x15, ...u32(iat('ExitProcess'))],
        });
        const hive = createHive();
        hive.setValue(hive.create(/** @type {any} */ (hive.root(HKEY_LOCAL_MACHINE)),
            'SOFTWARE\\Classes\\CLSID\\{3C1A7E52-9D04-4B6F-A1E8-5F0B2D7C9A31}\\LocalServer32').key,
        '', REG_SZ, new TextEncoder().encode('C:\\App\\server.exe\0'));
        const app = await createApp({
            executable: client,
            imagePath: 'C:\\App\\client.exe',
            concurrency,
            storage: { load: async()=>({ files: [{ path: 'C:\\App\\server.exe', bytes: server }],
                registry: hive.toJSON() }) },
        });
        t.after(()=>app.dispose());
        /** @type {number[]} */
        const serverCodes = [];
        app.on('process-server-exit', (/** @type {any} */ event)=>serverCodes.push(event.code));
        assert.equal(await app.run({ timeoutMs: 30000 }), 0);
        if (concurrency > 1)
        {
            assert.deepEqual(serverCodes, [7], 'the server ran, and ended after its client');
        }
    });
}
