/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Phase 1 acceptance: the fixture executable runs under Bottlify and produces
 * the same output real Windows produces from the same file.
 *
 * This drives `createApp` -- the surface a consumer gets -- rather than reaching
 * into the layers, so it exercises the module graph, the region map and the
 * trap channel the way anything else would.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

const FIXTURE = new URL('../test/fixtures/hello.exe', import.meta.url);

/** What the same binary prints when Windows runs it. */
const EXPECTED_OUTPUT = 'Hello from Bottlify\r\n';

/**
 * Disposed when the test ends, however it ends: the machine is a singleton
 * per process, so an app left behind by a failed assertion makes every later
 * test fail with "already booted" and keeps the process alive after the run.
 *
 * @param {import('node:test').TestContext} t
 * @param {Partial<import('./app.js').AppOptions>} [extra]
 */
async function startApp(t, extra = {}){
    const exe = await readFile(FIXTURE);

    const app = await createApp({
        executable: new Uint8Array(exe),
        ...extra,
    });
    t.after(()=>app.dispose());
    return app;
}

test('a file handed in at start lies over the session\'s own', { timeout: 15000 }, async t=>{
    // A person's edit to a title's file -- a realm list, a config line --
    // wins over what the program last saved, and the bundle stays as it is.
    const path = 'C:\\App\\realmlist.wtf';
    const app = await startApp(t, {
        storage: { load: async()=>({
            files: [{ path, bytes: new TextEncoder().encode('set realmlist old') }],
            registry: null,
        }) },
        files: [{ path, bytes: new TextEncoder().encode('set realmlist mine') }],
    });
    const held = app.session.export().find((/** @type {any} */ file)=>file.path === path);
    assert.ok(held);
    assert.equal(new TextDecoder().decode(held.bytes), 'set realmlist mine');
});

test('the volume is read from outside while it runs: a file saved by an earlier run too', async t=>{
    // A saved game lives in the bottle's storage, not in what this run wrote:
    // the session's export does not hold it, the volume does.
    const path = 'C:\\App\\save\\slot1.sav';
    const app = await startApp(t, {
        storage: { load: async()=>({
            files: [{ path, bytes: Uint8Array.of(7, 8, 9) }],
            registry: null,
        }) },
    });
    const entry = app.files.list('C:\\App\\save')
        .find((/** @type {any} */ e)=>e.path === path);
    assert.deepEqual(entry && { name: entry.name, directory: entry.directory, size: entry.size },
        { name: 'slot1.sav', directory: false, size: 3 });
    assert.deepEqual(app.files.read(path), Uint8Array.of(7, 8, 9));
    assert.ok(app.files.list('C:\\App')
        .some((/** @type {any} */ e)=>e.name === 'save' && e.directory));
});

test('a file or a directory is removed from outside, and stays gone from the session', async t=>{
    // A setting the program saved, taken away so it asks again at the next start.
    const options = 'C:\\Profile\\game\\Options.ini';
    const save = 'C:\\App\\save\\slot1.sav';
    const app = await startApp(t, {
        storage: { load: async()=>({
            files: [{ path: options, bytes: Uint8Array.of(1) },
                { path: save, bytes: Uint8Array.of(2) }],
            registry: null,
        }) },
    });
    assert.equal(app.files.remove(options), true);
    assert.equal(app.files.remove(options), false, 'nothing left to remove');
    assert.equal(app.files.remove('C:\\App\\save'), true, 'a directory, its file with it');
    assert.equal(app.files.list('C:\\App').some((/** @type {any} */ e)=>e.name === 'save'), false);
    assert.equal(app.files.list('C:\\Profile\\game').length, 0);
    const kept = app.session.export().map((/** @type {any} */ file)=>file.path);
    assert.equal(kept.includes(options), false);
    assert.equal(kept.includes(save), false);
});

test('hello.exe prints what it prints on Windows, then exits cleanly',
    { timeout: 15000 }, async t=>{
        const app = await startApp(t);
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>output.push(text));

        const code = await app.run({ timeoutMs: 8000 });

        assert.equal(output.join(''), EXPECTED_OUTPUT, 'same bytes real Windows writes to stdout');
        assert.equal(code, 0, "the guest's own exit code");
    });

test('the image lands where its headers ask, and every import is bound',
    { timeout: 15000 }, async t=>{
        const app = await startApp(t);
        await app.run({ timeoutMs: 8000 });

        assert.equal(app.image.base, 0x400000, 'the fixture has no relocations and cannot move');
        assert.equal(app.image.entryPoint, 0x401000);
        assert.deepEqual(app.image.unresolved, [], 'nothing the fixture imports is missing');
    });

test('diagnostics describe the run afterwards', { timeout: 15000 }, async t=>{
    const app = await startApp(t);
    await app.run({ timeoutMs: 8000 });

    const byName = Object.fromEntries(app.diagnostics().map((/** @type {any} */ d)=>[d.name, d]));

    assert.equal(byName.cpu.metrics.protectedMode, true, 'the ROM switched the CPU over');
    assert.ok(byName.cpu.metrics.instructions > 0);
    // Every function of every library gets a stub, whether the program calls it
    // or not: the modules exist in guest memory before the first instruction, so
    // an address taken early is the address that works later (§13.3). Plus the
    // park slot and the callback sentinel.
    //
    // Counted against what the bridge registered rather than against one
    // layer's tally: the drawing libraries are exported to a program exactly as
    // the system ones are, and an assertion naming only win32 says a program's
    // reachable surface is smaller than it is.
    assert.equal(byName.cpu.metrics.traps, byName.bridge.metrics.implemented + 2);

    assert.equal(byName.win32.metrics.exitCode, 0);
    assert.ok(byName.win32.metrics.libraries['KERNEL32.dll'] > 0);

    // One image per synthesised library, plus the program itself. Counted from
    // every layer that reports libraries rather than from a list of layer
    // names: a drawing or a sound library is synthesised into guest memory
    // exactly as a system one is, a program reaches it the same way, and a test
    // that names the layers it knows about goes red every time another one
    // starts exporting -- which has now happened twice.
    /** @param {any} layer */
    const librariesOf = layer=>{
        const libraries = layer.metrics?.libraries;
        if (Array.isArray(libraries))
        {
            return libraries.length;
        }
        return libraries ? Object.keys(libraries).length : 0;
    };
    const synthesised = app.diagnostics()
        .reduce((/** @type {number} */ total, /** @type {any} */ layer)=>
            total + librariesOf(layer), 0);
    assert.equal(byName.loader.metrics.images, synthesised + 1);
    assert.deepEqual(byName.loader.metrics.unresolved, []);

    assert.deepEqual(byName.bridge.metrics.lastCall, 'KERNEL32.dll!ExitProcess');

    // The layout is in the snapshot because a wrong one usually explains a fault
    // faster than the fault does.
    const layout = byName.memory.metrics.layout.join(' ');
    for (const region of ['entry-vector', 'stack', 'thunks', 'image', 'heap', 'KERNEL32.dll'])
    {
        assert.ok(layout.includes(region), `${region} is mapped`);
    }
});

test('a detached log sink stops receiving output', { timeout: 15000 }, async t=>{
    const app = await startApp(t);
    /** @type {string[]} */
    const kept = [];
    /** @type {string[]} */
    const dropped = [];
    /** @param {number} _handle @param {string} text */
    const sink = (_handle, text)=>dropped.push(text);

    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>kept.push(text));
    app.attachLog(sink);
    app.detachLog(sink);

    await app.run({ timeoutMs: 8000 });

    assert.equal(kept.join(''), EXPECTED_OUTPUT);
    assert.deepEqual(dropped, [], 'detached before the run, so it saw nothing');
});
