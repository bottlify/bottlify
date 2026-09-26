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
import { createMemoryDirectory } from './layers/cpu/internal/translation-store.js';

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

test('a parent waiting on its child goes on after the child exits, with what it left',
    { timeout: 120000 }, t=>spawnOn(t, 'emulator'));

test('under cork, the child runs on a machine of its own beside the parent\'s as well',
    { timeout: 120000 }, t=>spawnOn(t, 'cork'));

/**
 * The origin's file system as a worker has it: a file with a synchronous
 * access handle open refuses a second one, and a writable, as OPFS does.
 */
function exclusiveDirectory(){
    /** @param {any} directory */
    const wrap = directory=>({
        ...directory,
        getDirectoryHandle: async(/** @type {string} */ name, /** @type {any} */ options)=>
            wrap(await directory.getDirectoryHandle(name, options)),
        getFileHandle: async(/** @type {string} */ name, /** @type {any} */ options)=>{
            const file = await directory.getFileHandle(name, options);
            const refused = ()=>new DOMException(`${name} is held`, 'NoModificationAllowedError');
            file.held ??= false;
            return {
                getFile: ()=>file.getFile(),
                async createSyncAccessHandle(){
                    if (file.held)
                    {
                        throw refused();
                    }
                    const access = await file.createSyncAccessHandle();
                    file.held = true;
                    return { ...access, close(){
                        file.held = false;
                    } };
                },
                async createWritable(){
                    throw refused();
                },
            };
        },
    });
    return wrap(createMemoryDirectory());
}

test('a child beside its parent writes to the run\'s one translation store', { timeout: 120000 },
    async t=>{
        // Each machine opened a store of its own on the bundle's directory,
        // and the child's could not write while the paused parent's held its
        // records file: Warcraft III's launcher stopped at its child's first
        // append.
        let opened = 0;
        const directory = exclusiveDirectory();
        const was = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
        Object.defineProperty(globalThis, 'navigator', { configurable: true,
            value: { storage: { getDirectory: async()=>{
                opened++;
                return directory;
            } } } });
        t.after(()=>(was ? Object.defineProperty(globalThis, 'navigator', was)
            : delete (/** @type {any} */ (globalThis)).navigator));
        await spawnOn(t, 'cork');
        assert.equal(opened, 1, 'one store for the run, the children\'s machines included');
    });
