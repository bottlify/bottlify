/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A parent that goes on after its child.
 *
 * The compiled parent starts a child and waits on its process handle; the
 * engine runs the child on a machine of its own beside the parent's, then
 * wakes the parent's wait. The fixture checks what a parent reads afterwards
 * -- the exit code, the file and the registry value the child left, a wait for
 * any of a set -- one property per line.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';
import {
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, REG_DWORD,
} from './layers/win32/advapi32/registry.js';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

/**
 * @param {import('node:test').TestContext} t
 * @param {'emulator' | 'cork'} engine
 */
async function spawnOn(t, engine){
    const [wasm, parent, child] = await Promise.all([
        readFile(new URL('v86.wasm', PREBUILT)),
        readFile(new URL('../test/fixtures/spawn.exe', import.meta.url)),
        readFile(new URL('../test/fixtures/spawn_child.exe', import.meta.url)),
    ]);
    const app = await createApp({
        executable: new Uint8Array(parent),
        imagePath: 'C:\\App\\spawn.exe',
        engine,
        storage: { load: async()=>({
            files: [{ path: 'C:\\App\\spawn_child.exe', bytes: new Uint8Array(child) }],
        }) },
        v86: {
            moduleUrl: new URL('libv86.mjs', PREBUILT).href,
            wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        },
    });
    t.after(()=>app.dispose());
    /** @type {string[]} */
    const output = [];
    app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
        output.push(text));
    /** @type {string[]} */
    const lifecycle = [];
    app.on('process-child', (/** @type {any} */ event)=>lifecycle.push(`child ${event.image}`));
    app.on('process-resumed', (/** @type {any} */ event)=>
        lifecycle.push(`resumed ${event.code}`));
    app.on('message-box', (/** @type {any} */ event)=>
        lifecycle.push(`box ${event.id} ${event.caption} ${JSON.stringify(event.exit)}`));

    const code = await app.run({ timeoutMs: 60000 });

    const lines = output.join('').split('\r\n').filter(Boolean);
    assert.deepEqual(lines.filter(line=>line.startsWith('FAIL')), [],
        `every property holds:\n${output.join('')}`);
    assert.equal(lines.filter(line=>line.startsWith('ok   ')).length, 10,
        `and every one was reached:\n${output.join('')}`);
    assert.deepEqual(lines.filter(line=>!line.startsWith('ok   ')),
        ['child: first', 'child: second', 'parent: done'],
        'the children ran in turn, and the parent after them');
    assert.equal(code, 0, 'the run ends with the parent\'s own exit code');
    assert.deepEqual(lifecycle, [
        'child C:\\App\\spawn_child.exe', 'resumed 42',
        'child C:\\App\\spawn_child.exe', 'resumed 0',
        'box 0 spawn.exe {"code":0}',
    ], 'the game is over only when the parent is: a child ending with 0 is not it');
}

/**
 * @param {any} hive @param {number} root @param {string} path @param {string} name
 * @returns {number | null}
 */
function readDword(hive, root, path, name){
    const key = hive.open(hive.root(root), path);
    const value = key && hive.getValue(key, name);
    return value ? new DataView(value.data.buffer, value.data.byteOffset).getUint32(0, true) : null;
}

test('a child starts from its parent\'s registry, and the parent keeps its own after',
    { timeout: 120000 }, async t=>{
        // A launcher writes its settings and then starts the program that reads
        // them. One registry is the machine's, not the process's: the child
        // sees what the parent wrote, and the parent what the child did.
        const [wasm, parent, child] = await Promise.all([
            readFile(new URL('v86.wasm', PREBUILT)),
            readFile(new URL('../test/fixtures/spawn.exe', import.meta.url)),
            readFile(new URL('../test/fixtures/spawn_child.exe', import.meta.url)),
        ]);
        const app = await createApp({
            executable: new Uint8Array(parent),
            imagePath: 'C:\\App\\spawn.exe',
            files: [{ path: 'C:\\App\\spawn_child.exe', bytes: new Uint8Array(child) }],
            v86: {
                moduleUrl: new URL('libv86.mjs', PREBUILT).href,
                wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
            },
        });
        t.after(()=>app.dispose());
        const hive = app.registry();
        hive.setValue(hive.create(hive.root(HKEY_LOCAL_MACHINE), 'SOFTWARE\\Vendor\\Game').key,
            'InstallDone', REG_DWORD, Uint8Array.of(1, 0, 0, 0));
        /** @type {(number | null)[]} */
        const seenByChild = [];
        app.on('process-started', ()=>seenByChild.push(readDword(
            app.registry(), HKEY_LOCAL_MACHINE, 'SOFTWARE\\Vendor\\Game', 'InstallDone')));

        await app.run({ timeoutMs: 60000 });

        assert.deepEqual(seenByChild, [1, 1], 'each child started with what the parent wrote');
        assert.equal(readDword(app.registry(), HKEY_LOCAL_MACHINE, 'SOFTWARE\\Vendor\\Game',
            'InstallDone'), 1, 'and the parent still has it');
        assert.notEqual(readDword(app.registry(), HKEY_CURRENT_USER, 'Software\\Bottlify\\Spawn',
            'Stage'), null, 'beside what the child wrote');
    });

test('a parent waiting on its child goes on after the child exits, with what it left',
    { timeout: 120000 }, t=>spawnOn(t, 'emulator'));

test('under cork, the child runs on a machine of its own beside the parent\'s as well',
    { timeout: 120000 }, t=>spawnOn(t, 'cork'));
