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
import { buildExe } from '../../../tools/make-pe.mjs';
import {
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, REG_DWORD,
} from './layers/win32/advapi32/registry.js';
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
                // Refused while a synchronous handle holds the file, as OPFS does;
                // otherwise a stream over the same bytes.
                async createWritable(){
                    if (file.held)
                    {
                        throw refused();
                    }
                    const access = await file.createSyncAccessHandle();
                    return {
                        write: async(/** @type {any} */ chunk)=>{
                            access.write(chunk.data, { at: chunk.position });
                        },
                        close: async()=>{},
                    };
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

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
/** @param {string} text */
const ascii = text=>[...text].map(character=>character.charCodeAt(0)).concat(0);

/**
 * A launcher: it names an event, starts its game, and waits for either the
 * game's process or the event, exiting with the index WaitForMultipleObjects
 * answered. The game opens the event by name, signals it, and exits.
 */
function buildLauncher(){
    const parent = buildExe({
        imports: { 'KERNEL32.dll': ['CreateEventA', 'CreateProcessA',
            'WaitForMultipleObjects', 'ExitProcess'] },
        data: {
            name: ascii('LAUNCHED_OK'),
            command: ascii('C:\\App\\game.exe'),
            startup: [...u32(68), ...new Array(64).fill(0)],
            info: new Array(16).fill(0),
            set: new Array(8).fill(0),
        },
        codeSize: 0x60,
        code: ({ iat, at })=>[
            // CreateEventA(0, 0, 0, name)
            0x68, ...u32(at('name')), 0x6a, 0, 0x6a, 0, 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateEventA')),
            0xa3, ...u32(at('set') + 4),                              // set[1] = event
            // CreateProcessA(0, command, ..., &startup, &info)
            0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
            0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
            0x68, ...u32(at('command')), 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateProcessA')),
            0xa1, ...u32(at('info')), 0xa3, ...u32(at('set')),         // set[0] = the process
            // WaitForMultipleObjects(2, set, FALSE, INFINITE)
            0x6a, 0xff, 0x6a, 0, 0x68, ...u32(at('set')), 0x6a, 2,
            0xff, 0x15, ...u32(iat('WaitForMultipleObjects')),
            0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),              // exit with its answer
        ],
    });
    const game = buildExe({
        imports: { 'KERNEL32.dll': ['OpenEventA', 'SetEvent', 'ExitProcess'] },
        data: { name: ascii('LAUNCHED_OK') },
        code: ({ iat, at })=>[
            // OpenEventA(EVENT_ALL_ACCESS, FALSE, name)
            0x68, ...u32(at('name')), 0x6a, 0, 0x68, ...u32(0x1f0003),
            0xff, 0x15, ...u32(iat('OpenEventA')),
            0x50, 0xff, 0x15, ...u32(iat('SetEvent')),
            0x6a, 0, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
    return { parent, game };
}

test('a launcher waiting on its game or the event the game sets is woken by the event',
    { timeout: 60000 }, async t=>{
        // Warcraft III's front end waits so, and takes the game's process
        // ending first for a failure to start. The game ran beside it here and
        // the launcher resumed only once it had exited -- with the process's
        // index, though the event had come first.
        const { parent, game } = buildLauncher();
        const app = await createApp({
            executable: parent,
            imagePath: 'C:\\App\\launcher.exe',
            engine: 'cork',
            storage: { load: async()=>({ files: [{ path: 'C:\\App\\game.exe', bytes: game }] }) },
        });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 30000 }), 1, 'WAIT_OBJECT_0 + 1: the event');
    });
