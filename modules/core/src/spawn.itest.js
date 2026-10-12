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
import v8 from 'node:v8';
import vm from 'node:vm';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import { waitingParent } from '../../../tools/spawn-program.mjs';
import {
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, REG_DWORD,
} from './layers/win32/advapi32/registry.js';
import { createMemoryDirectory } from './layers/cpu/internal/translation-store.js';

/**
 * @param {import('node:test').TestContext} t
 */
async function spawnOn(t){
    const [parent, child] = await Promise.all([
        readFile(new URL('../test/fixtures/spawn.exe', import.meta.url)),
        readFile(new URL('../test/fixtures/spawn_child.exe', import.meta.url)),
    ]);
    let loads = 0;
    const app = await createApp({
        executable: new Uint8Array(parent),
        imagePath: 'C:\\App\\spawn.exe',
        storage: { load: async()=>(loads++, {
            files: [{ path: 'C:\\App\\spawn_child.exe', bytes: new Uint8Array(child) }],
        }) },
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
    /** @type {any[]} */
    const tables = [];
    /** @type {number[]} */
    const closed = [];
    app.on('sound-table', (/** @type {any} */ event)=>tables.push(event));
    app.on('sound-table-closed', (/** @type {any} */ event)=>closed.push(event.id));

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
    // A child stands on the drives the parent laid, the saved files on them
    // already: reading the session again raced the parent saving into it.
    assert.equal(loads, 1, 'the session is read once, by the process that laid the drives');
    assert.deepEqual(lifecycle, [
        'child C:\\App\\spawn_child.exe', 'resumed 42',
        'child C:\\App\\spawn_child.exe', 'resumed 0',
        'box 0 spawn.exe {"code":0}',
    ], 'the game is over only when the parent is: a child ending with 0 is not it');
    // Each child's sound is its own table, not the run's: built on the run's,
    // a child was taken for the process in its parent's place and closed the
    // parent's tracks, its music going silent at the first child.
    const run = app.audio.memory();
    if (run && 'table' in run)
    {
        assert.equal(tables.length, 2, 'a table for each child');
        assert.ok(tables.every(one=>one.table !== run.table
            && one.table instanceof SharedArrayBuffer));
        assert.deepEqual(closed, tables.map(one=>one.id), 'and each given back as its child went');
    }
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
        const [parent, child] = await Promise.all([
            readFile(new URL('../test/fixtures/spawn.exe', import.meta.url)),
            readFile(new URL('../test/fixtures/spawn_child.exe', import.meta.url)),
        ]);
        const app = await createApp({
            executable: new Uint8Array(parent),
            imagePath: 'C:\\App\\spawn.exe',
            files: [{ path: 'C:\\App\\spawn_child.exe', bytes: new Uint8Array(child) }],
        });
        t.after(()=>app.dispose());
        const hive = app.registry();
        hive.setValue(hive.create(hive.root(HKEY_LOCAL_MACHINE), 'SOFTWARE\\Vendor\\Game').key,
            'InstallDone', REG_DWORD, Uint8Array.of(1, 0, 0, 0));
        /** @type {(number | null)[]} */
        const seenByChild = [];
        /** @type {any[]} */
        const childHives = [];
        /** @type {any[]} */
        const childDrives = [];
        const drives = app.session.runVolume();
        app.on('process-started', ()=>{
            childHives.push(app.registry());
            childDrives.push(app.session.runVolume());
            seenByChild.push(readDword(
                app.registry(), HKEY_LOCAL_MACHINE, 'SOFTWARE\\Vendor\\Game', 'InstallDone'));
        });

        await app.run({ timeoutMs: 60000 });

        assert.deepEqual(seenByChild, [1, 1], 'each child started with what the parent wrote');
        assert.ok(childHives.every(each=>each === hive) && app.registry() === hive,
            'one hive for the run: each child is handed the parent\'s, not a copy');
        assert.ok(drives && childDrives.length === 2 && childDrives.every(each=>each === drives),
            'and one volume: each child stands on the parent\'s drives');
        assert.equal(readDword(app.registry(), HKEY_LOCAL_MACHINE, 'SOFTWARE\\Vendor\\Game',
            'InstallDone'), 1, 'and the parent still has it');
        assert.notEqual(readDword(app.registry(), HKEY_CURRENT_USER, 'Software\\Bottlify\\Spawn',
            'Stage'), null, 'beside what the child wrote');
    });

test('a parent waiting on its child goes on after the child exits, with what it left',
    { timeout: 120000 }, t=>spawnOn(t));

/**
 * The origin's file system as a worker has it: a file with a synchronous
 * access handle open refuses a second one, and a writable, as OPFS does.
 * `held(name)` says whether a file of that name has one open now.
 */
function exclusiveDirectory(){
    /** @type {Set<string>} */
    const holding = new Set();
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
                    holding.add(name);
                    return { ...access, close(){
                        file.held = false;
                        holding.delete(name);
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
    return Object.assign(wrap(createMemoryDirectory()),
        { held: (/** @type {string} */ name)=>holding.has(name) });
}

/**
 * The origin's file system for a test's run, put where the engine asks for it.
 *
 * @param {any} t @param {any} directory @param {() => void} [asked]
 */
function withOrigin(t, directory, asked = ()=>{}){
    const was = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', { configurable: true,
        value: { storage: { getDirectory: async()=>{
            asked();
            return directory;
        } } } });
    t.after(()=>(was ? Object.defineProperty(globalThis, 'navigator', was)
        : delete (/** @type {any} */ (globalThis)).navigator));
}

test('a child beside its parent writes to the run\'s one translation store', { timeout: 120000 },
    async t=>{
        // Each machine opened a store of its own on the bundle's directory,
        // and the child's could not write while the paused parent's held its
        // records file: Warcraft III's launcher stopped at its child's first
        // append.
        let opened = 0;
        withOrigin(t, exclusiveDirectory(), ()=>{
            opened++;
        });
        await spawnOn(t);
        assert.equal(opened, 1, 'one store for the run, the children\'s machines included');
    });

test('a process in a worker of its own takes its translations from the run\'s store, and the'
    + ' next run finds them there', { timeout: 120000 }, async t=>{
    // Where every process runs in a worker, its first one too, no process
    // had the store: the system's thread holds its records file, and a worker
    // opened none of its own. Every run translated everything again.
    withOrigin(t, createMemoryDirectory());
    const program = buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        code: ({ iat })=>[
            // ecx = 3000000; eax = 0; do eax = rol(eax + ecx ^ 0x55, 3) while (--ecx)
            0xb9, ...u32(3000000), 0x31, 0xc0,
            0x01, 0xc8, 0x35, ...u32(0x55), 0xc1, 0xc0, 0x03, 0x49, 0x75, 0x100 - 13,
            0x25, ...u32(0x7f), 0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
    const run = async()=>{
        const app = await createApp({ executable: program, imagePath: 'C:\\App\\loop.exe',
            engine: 'cork', concurrency: 2 });
        try
        {
            const code = await app.run({ timeoutMs: 60000 });
            const cpu = app.diagnostics().find((/** @type {any} */ table)=>table.name === 'cpu');
            return { code, cork: /** @type {any} */ (cpu)?.metrics?.cork };
        }
        finally
        {
            await app.dispose();
        }
    };
    const first = await run();
    assert.ok(first.cork.cacheMisses > 0, 'the first run looked its regions up, and made them');
    const second = await run();
    assert.equal(second.code, first.code);
    assert.ok(second.cork.cacheHits > 0, `the second took them from the store: ${
        JSON.stringify({ hits: second.cork.cacheHits, misses: second.cork.cacheMisses })}`);
    assert.equal(second.cork.cacheMisses, 0);
});

test('the run\'s translation store keeps its records file open past a child, until the run goes',
    { timeout: 120000 }, async t=>{
        // A child's machine going let go of the store every process shares:
        // the processes still running then wrote each record by copying the
        // whole records file, and the next machine to go waited on those
        // copies -- forty seconds of an installer's COM server standing still.
        const directory = exclusiveDirectory();
        withOrigin(t, directory);
        const [parent, child] = await Promise.all([
            readFile(new URL('../test/fixtures/spawn.exe', import.meta.url)),
            readFile(new URL('../test/fixtures/spawn_child.exe', import.meta.url)),
        ]);
        const app = await createApp({
            executable: new Uint8Array(parent),
            imagePath: 'C:\\App\\spawn.exe',
            engine: 'cork',
            files: [{ path: 'C:\\App\\spawn_child.exe', bytes: new Uint8Array(child) }],
        });
        /** @type {boolean[]} */
        const heldAfterChild = [];
        app.on('process-resumed', ()=>heldAfterChild.push(directory.held('records')));

        await app.run({ timeoutMs: 60000 });
        assert.ok(heldAfterChild.length > 0, 'a child ran and its parent went on');
        assert.deepEqual(heldAfterChild, heldAfterChild.map(()=>true),
            'still the run\'s once each child\'s machine had gone');
        await app.dispose();
        assert.equal(directory.held('records'), false, 'let go of with the run');
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

/**
 * A setup that runs a helper and polls for it rather than waiting: it starts
 * the helper, asks GetExitCodeProcess until the answer is no longer
 * STILL_ACTIVE, sleeping a millisecond between, and exits with the helper's
 * code plus one. The helper exits with 7.
 */
/** @param {boolean} [sleeps]  Whether it sleeps between polls, or spins. */
function buildPoller(sleeps = true){
    const parent = buildExe({
        imports: { 'KERNEL32.dll': ['CreateProcessA', 'GetExitCodeProcess', 'Sleep',
            'ExitProcess'] },
        data: {
            command: ascii('C:\\App\\helper.exe'),
            startup: [...u32(68), ...new Array(64).fill(0)],
            info: new Array(16).fill(0),
            code: new Array(4).fill(0),
        },
        codeSize: 0x60,
        code: ({ iat, at })=>[
            // CreateProcessA(0, command, ..., &startup, &info)
            0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
            0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
            0x68, ...u32(at('command')), 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateProcessA')),
            // poll: GetExitCodeProcess(info.hProcess, &code)
            0x68, ...u32(at('code')), 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('GetExitCodeProcess')),
            0x81, 0x3d, ...u32(at('code')), ...u32(259),               // cmp code, STILL_ACTIVE
            0x75, 0x0a,                                                // jne done
            ...sleeps ? [0x6a, 1, 0xff, 0x15, ...u32(iat('Sleep'))]    // Sleep(1)
                : new Array(8).fill(0x90),
            0xeb, 0xd9,                                                // jmp poll
            // done: ExitProcess(code + 1)
            0xa1, ...u32(at('code')), 0x40, 0x50,
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
    const helper = buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        code: ({ iat })=>[0x6a, 7, 0xff, 0x15, ...u32(iat('ExitProcess'))],
    });
    return { parent, helper };
}

test('a parent that polls its child\'s exit code goes on after it, as one waiting on it does',
    { timeout: 60000 }, async t=>{
        // GetExitCodeProcess answers STILL_ACTIVE while the child runs, and a
        // setup asking it between one-millisecond sleeps is waiting for its
        // helper as surely as one blocked on the handle. It was taken for a
        // parent with nothing left to do and replaced by the helper, so the
        // run ended with the helper's exit: an installer vanished once a
        // shortcut helper it started had finished.
        const { parent, helper } = buildPoller();
        const app = await createApp({
            executable: parent,
            imagePath: 'C:\\App\\setup.exe',
            engine: 'cork',
            storage: { load: async()=>({
                files: [{ path: 'C:\\App\\helper.exe', bytes: helper }],
            }) },
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const lifecycle = [];
        app.on('process-child', (/** @type {any} */ event)=>
            lifecycle.push(`child ${event.image}`));
        app.on('process-replace', (/** @type {any} */ event)=>
            lifecycle.push(`replaced by ${event.image}`));
        app.on('process-resumed', (/** @type {any} */ event)=>
            lifecycle.push(`resumed ${event.code}`));
        assert.equal(await app.run({ timeoutMs: 30000 }), 8,
            'the helper\'s 7, plus the parent\'s one');
        assert.deepEqual(lifecycle, ['child C:\\App\\helper.exe', 'resumed 7']);
    });

test('a parent that polls its child\'s exit code without ever blocking still lets it run',
    { timeout: 60000 }, async t=>{
        // A setup that pumps its messages and asks the exit code between
        // them never blocks, so a child waiting for its parent to have
        // nothing left to run never ran: the setup polled for ever. The poll
        // is the wait.
        const { parent, helper } = buildPoller(false);
        const app = await createApp({
            executable: parent,
            imagePath: 'C:\\App\\setup.exe',
            engine: 'cork',
            storage: { load: async()=>({
                files: [{ path: 'C:\\App\\helper.exe', bytes: helper }],
            }) },
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const lifecycle = [];
        app.on('process-child', (/** @type {any} */ event)=>
            lifecycle.push(`child ${event.image}`));
        app.on('process-replace', (/** @type {any} */ event)=>
            lifecycle.push(`replaced by ${event.image}`));
        app.on('process-resumed', (/** @type {any} */ event)=>
            lifecycle.push(`resumed ${event.code}`));
        assert.equal(await app.run({ timeoutMs: 30000 }), 8,
            'the helper\'s 7, plus the parent\'s one');
        assert.deepEqual(lifecycle, ['child C:\\App\\helper.exe', 'resumed 7']);
    });

/**
 * A setup that starts a helper and waits for it to say it is done rather than
 * for its process: it names an event, starts the helper, waits on the event
 * alone and exits with 3. The helper opens the event by name, signals it and
 * exits with 0.
 */
function buildSignalled(){
    const parent = buildExe({
        imports: { 'KERNEL32.dll': ['CreateEventA', 'CreateProcessA', 'WaitForSingleObject',
            'ExitProcess'] },
        data: {
            name: ascii('LAUNCHED_OK'),
            command: ascii('C:\\App\\game.exe'),
            startup: [...u32(68), ...new Array(64).fill(0)],
            info: new Array(16).fill(0),
            event: new Array(4).fill(0),
        },
        codeSize: 0x60,
        code: ({ iat, at })=>[
            // CreateEventA(0, 0, 0, name)
            0x68, ...u32(at('name')), 0x6a, 0, 0x6a, 0, 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateEventA')),
            0xa3, ...u32(at('event')),
            0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
            0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
            0x68, ...u32(at('command')), 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateProcessA')),
            // WaitForSingleObject(event, INFINITE)
            0x6a, 0xff, 0xff, 0x35, ...u32(at('event')),
            0xff, 0x15, ...u32(iat('WaitForSingleObject')),
            0x6a, 3, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
    return { parent, game: buildLauncher().game };
}

test('a parent waiting on something its child sets, not on the child, outlives the child',
    { timeout: 60000 }, async t=>{
        // A process lives until it exits itself, however it waits. One blocked
        // on anything but its child's handle -- an event, a sleep between polls,
        // its message loop -- was replaced by the child, so the child's exit
        // ended the whole run: an installer vanished when a helper it started
        // did, and a launcher collecting the installation at the end never did.
        const { parent, game } = buildSignalled();
        const app = await createApp({
            executable: parent,
            imagePath: 'C:\\App\\setup.exe',
            engine: 'cork',
            storage: { load: async()=>({ files: [{ path: 'C:\\App\\game.exe', bytes: game }] }) },
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const lifecycle = [];
        app.on('process-child', (/** @type {any} */ event)=>
            lifecycle.push(`child ${event.image}`));
        app.on('process-replace', (/** @type {any} */ event)=>
            lifecycle.push(`replaced by ${event.image}`));
        app.on('process-resumed', (/** @type {any} */ event)=>
            lifecycle.push(`resumed ${event.code}`));
        assert.equal(await app.run({ timeoutMs: 30000 }), 3, 'the parent\'s own exit');
        assert.deepEqual(lifecycle, ['child C:\\App\\game.exe', 'resumed 0'],
            'the child ran beside it, and the parent went on to its end');
    });

test('a process started beside its parent writes into the run\'s one journal', { timeout: 60000 },
    async t=>{
        // The page reads the journal through the facade, which stays with the
        // parent while the child runs beside it: the child's calls must be in
        // what it reads, after the parent's, on the same clock.
        const { parent, game } = buildLauncher();
        const app = await createApp({
            executable: parent,
            imagePath: 'C:\\App\\launcher.exe',
            engine: 'cork',
            storage: { load: async()=>({ files: [{ path: 'C:\\App\\game.exe', bytes: game }] }) },
        });
        t.after(()=>app.dispose());
        app.log.setLevel('call.cpu', 'trace');
        await app.run({ timeoutMs: 30000 });
        const text = app.log.recent(4096).map((/** @type {any} */ record)=>record.text ?? '')
            .join('\n');
        assert.match(text, /CreateProcess/, 'the parent\'s own calls');
        assert.match(text, /\[game\.exe:main\] KERNEL32\.dll!OpenEventA/,
            'and the child\'s, in the same journal, named by its process');
        /** @type {number[]} */
        const times = app.log.recent(4096).map((/** @type {any} */ record)=>record.time);
        assert.ok(times.every((time, at)=>at === 0 || time >= times[at - 1]),
            'on the journal\'s one clock');
    });

test('a child is the process its parent was told of: GetCurrentProcessId is PROCESS_INFORMATION\'s',
    { timeout: 60000 }, async t=>{
        // A test harness tells its children's output apart by the identifier
        // each line carries, and OpenProcess finds a child by the one its
        // parent was handed; a child answering its parent's would be neither.
        const parent = buildExe({
            imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject', 'ExitProcess'] },
            data: {
                command: ascii('C:\\App\\child.exe'),
                startup: [...u32(68), ...new Array(64).fill(0)],
                info: new Array(16).fill(0),
            },
            codeSize: 0x60,
            code: ({ iat, at })=>[
                // CreateProcessA(0, command, ..., &startup, &info)
                0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
                0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
                0x68, ...u32(at('command')), 0x6a, 0,
                0xff, 0x15, ...u32(iat('CreateProcessA')),
                // WaitForSingleObject(info.hProcess, INFINITE)
                0x6a, 0xff, 0xff, 0x35, ...u32(at('info')),
                0xff, 0x15, ...u32(iat('WaitForSingleObject')),
                // ExitProcess(info.dwProcessId)
                0xff, 0x35, ...u32(at('info') + 8),
                0xff, 0x15, ...u32(iat('ExitProcess')),
            ],
        });
        const child = buildExe({
            imports: { 'KERNEL32.dll': ['GetCurrentProcessId', 'ExitProcess'] },
            code: ({ iat })=>[
                0xff, 0x15, ...u32(iat('GetCurrentProcessId')),
                0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),              // exit with it
            ],
        });
        const app = await createApp({
            executable: parent,
            imagePath: 'C:\\App\\parent.exe',
            engine: 'cork',
            storage: { load: async()=>({ files: [{ path: 'C:\\App\\child.exe', bytes: child }] }) },
        });
        t.after(()=>app.dispose());
        /** @type {number[]} */
        const childCodes = [];
        app.on('process-resumed', (/** @type {any} */ event)=>childCodes.push(event.code >>> 0));
        const told = (await app.run({ timeoutMs: 30000 })) >>> 0;
        assert.notEqual(told, 0, 'the parent was handed an identifier');
        assert.deepEqual(childCodes, [told], 'and the child answers that one as its own');
        assert.notEqual(told, 0x1000, 'which is not the parent\'s');
    });

test('a child\'s first thread is the thread its parent was told of: GetCurrentThreadId is'
    + ' PROCESS_INFORMATION\'s', { timeout: 60000 }, async t=>{
    // An injector or a debugger opens the child's thread by the id it was
    // handed; the child's own answer has to be that one, and no thread of the
    // parent's may answer it too -- the run numbers threads as one machine.
    const parent = buildExe({
        imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject', 'ExitProcess'] },
        data: {
            command: ascii('C:\\App\\child.exe'),
            startup: [...u32(68), ...new Array(64).fill(0)],
            info: new Array(16).fill(0),
        },
        codeSize: 0x60,
        code: ({ iat, at })=>[
            0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
            0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
            0x68, ...u32(at('command')), 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateProcessA')),
            0x6a, 0xff, 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('WaitForSingleObject')),
            // ExitProcess(info.dwThreadId)
            0xff, 0x35, ...u32(at('info') + 12),
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
    const child = buildExe({
        imports: { 'KERNEL32.dll': ['GetCurrentThreadId', 'ExitProcess'] },
        code: ({ iat })=>[
            0xff, 0x15, ...u32(iat('GetCurrentThreadId')),
            0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
    const app = await createApp({
        executable: parent,
        imagePath: 'C:\\App\\parent.exe',
        engine: 'cork',
        storage: { load: async()=>({ files: [{ path: 'C:\\App\\child.exe', bytes: child }] }) },
    });
    t.after(()=>app.dispose());
    /** @type {number[]} */
    const childCodes = [];
    app.on('process-resumed', (/** @type {any} */ event)=>childCodes.push(event.code >>> 0));
    const told = (await app.run({ timeoutMs: 30000 })) >>> 0;
    assert.notEqual(told, 0, 'the parent was handed a thread id');
    assert.deepEqual(childCodes, [told], 'and the child\'s first thread answers that one');
    assert.notEqual(told, 1, 'which is not the parent\'s first thread');
});

/** @param {number} value */
const le32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];
/** @param {string} text */
const cstring = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

/**
 * A parent that hands its child a file as the child's output: it creates
 * C:\App\out.txt, starts child.exe with STARTF_USESTDHANDLES and the file as
 * hStdOutput and hStdError, waits for it, writes "P" through its own handle
 * and reads the file back from the start. The exit code is the bytes read,
 * plus 0x100 when the last is the parent's "P" and 0x200 when the first is
 * the child's "c": 0x306 when the child's "child" came first and the parent's
 * write went on from where the child left the shared position.
 */
function buildOutputParent(){
    const startupSize = 68;
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateFileA', 'CreateProcessA', 'WaitForSingleObject',
            'WriteFile', 'SetFilePointer', 'ReadFile', 'ExitProcess'] },
        data: {
            path: cstring('C:\\App\\out.txt'), child: cstring('C:\\App\\child.exe'),
            startup: [...le32(startupSize), ...new Array(startupSize - 4).fill(0)],
            info: new Array(16).fill(0), mark: cstring('P'), count: [0, 0, 0, 0],
            buffer: new Array(16).fill(0),
        },
        codeSize: 0x200,
        code: ({ iat, at })=>{
            const call = (/** @type {string} */ name)=>[0xff, 0x15, ...le32(iat(name))];
            const push = (/** @type {number} */ value)=>[0x68, ...le32(value)];
            const bytes = [
                // STARTF_USESTDHANDLES
                0xc7, 0x05, ...le32(at('startup') + 44), ...le32(0x100),
                ...push(0), ...push(0x80), ...push(2), ...push(0), ...push(3),
                ...push(0xc0000000), ...push(at('path')), ...call('CreateFileA'),
                0x89, 0xc3,                                                   // mov ebx, eax
                0xa3, ...le32(at('startup') + 60),                           // hStdOutput
                0xa3, ...le32(at('startup') + 64),                           // hStdError
                ...push(at('info')), ...push(at('startup')), ...push(0), ...push(0), ...push(0),
                ...push(1), ...push(0), ...push(0), ...push(at('child')), ...push(0),
                ...call('CreateProcessA'),
                ...push(0xffffffff), 0xff, 0x35, ...le32(at('info')),
                ...call('WaitForSingleObject'),
                ...push(0), ...push(at('count')), ...push(1), ...push(at('mark')), 0x53,
                ...call('WriteFile'),
                ...push(0), ...push(0), ...push(0), 0x53, ...call('SetFilePointer'),
                ...push(0), ...push(at('count')), ...push(16), ...push(at('buffer')), 0x53,
                ...call('ReadFile'),
                0x8b, 0x0d, ...le32(at('count')),                            // mov ecx, [count]
                // movzx eax, byte [buffer]; cmp al, 'c'; jne +6; add ecx, 0x200
                0x0f, 0xb6, 0x05, ...le32(at('buffer')),
                0x3c, 0x63, 0x75, 0x06, 0x81, 0xc1, ...le32(0x200),
                // movzx eax, byte [buffer + 5]; cmp al, 'P'; jne +6; add ecx, 0x100
                0x0f, 0xb6, 0x05, ...le32(at('buffer') + 5),
                0x3c, 0x50, 0x75, 0x06, 0x81, 0xc1, ...le32(0x100),
                0x51, ...call('ExitProcess'),
            ];
            return bytes.concat(new Array(0x200 - bytes.length).fill(0xcc));
        },
    });
}

/** A child that writes "child" to its standard output and exits 0. */
function buildOutputChild(){
    return buildExe({
        imports: { 'KERNEL32.dll': ['GetStdHandle', 'WriteFile', 'ExitProcess'] },
        data: { text: cstring('child'), count: [0, 0, 0, 0] },
        codeSize: 0x40,
        code: ({ iat, at })=>{
            const bytes = [
                0x6a, 0xf5, 0xff, 0x15, ...le32(iat('GetStdHandle')),       // STD_OUTPUT_HANDLE
                0x6a, 0x00, 0x68, ...le32(at('count')), 0x6a, 0x05, 0x68, ...le32(at('text')),
                0x50, 0xff, 0x15, ...le32(iat('WriteFile')),
                0x6a, 0x00, 0xff, 0x15, ...le32(iat('ExitProcess')),
            ];
            return bytes.concat(new Array(0x40 - bytes.length).fill(0xcc));
        },
    });
}

for (const [where, options] of /** @type {[string, any][]} */ ([
    ['in its parent\'s place', {}],
    ['in a worker of its own', { concurrency: 2, engine: 'cork' }],
]))
{
    test(`a child ${where} writes into the file its parent handed it as its output, moving the`
        + ' position they share', { timeout: 120000 }, async t=>{
        const app = await createApp({
            executable: buildOutputParent(),
            imagePath: 'C:\\App\\parent.exe',
            files: [{ path: 'C:\\App\\child.exe', bytes: buildOutputChild() }],
            ...options,
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const console = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            console.push(text));
        const code = await app.run({ timeoutMs: 60000 });
        assert.equal(code, 0x306, 'the file reads "childP": the child first, the parent after');
        assert.equal(console.join('').includes('child'), false, 'nothing went to the console');
    });
}

test('a child that ran beside its parent is let go once it has exited', { timeout: 120000 },
    async t=>{
        // Each machine holds a gigabyte of guest memory: one kept after its
        // process ended is a gigabyte the run never gets back, and Wine's
        // process test, starting dozens, ran out of room for the next.
        v8.setFlagsFromString('--expose-gc');
        const gc = vm.runInNewContext('gc');
        const [parent, child] = await Promise.all([
            readFile(new URL('../test/fixtures/spawn.exe', import.meta.url)),
            readFile(new URL('../test/fixtures/spawn_child.exe', import.meta.url)),
        ]);
        const app = await createApp({
            executable: new Uint8Array(parent),
            imagePath: 'C:\\App\\spawn.exe',
            engine: 'cork',
            storage: { load: async()=>({
                files: [{ path: 'C:\\App\\spawn_child.exe', bytes: new Uint8Array(child) }],
            }) },
        });
        t.after(()=>app.dispose());
        // The fixture reports through its standard output, which goes nowhere
        // without a sink and fails its checks.
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        /** @type {WeakRef<object>[]} */
        const children = [];
        // While a child runs, the facade's methods are its machine's own.
        app.on('process-started', ()=>children.push(new WeakRef(app.diagnostics)));
        assert.equal(await app.run({ timeoutMs: 60000 }), 0, output.join(''));
        assert.equal(children.length, 2, 'two children ran');
        for (let round = 0; round < 4; round++)
        {
            await new Promise(resolve=>setTimeout(resolve, 10));
            gc();
        }
        assert.deepEqual(children.map(ref=>ref.deref() === undefined), [true, true],
            'neither machine is held once its process is over');
    });

/**
 * A parent that starts a child and waits for an event the child sets, then
 * for the child, and exits with 0x100 + the child's code; and the child,
 * which sets the parent's event by name and exits with 5.
 */
function buildEventPair(){
    const parent = buildExe({
        imports: { 'KERNEL32.dll': ['CreateEventA', 'CreateProcessA', 'WaitForSingleObject',
            'GetExitCodeProcess', 'ExitProcess'] },
        data: {
            name: ascii('Ready'),
            command: ascii('C:\\App\\child.exe'),
            startup: [...u32(68), ...new Array(64).fill(0)],
            info: new Array(16).fill(0),
            event: u32(0),
            code: u32(0),
        },
        codeSize: 0x80,
        code: ({ iat, at })=>[
            // event = CreateEventA(NULL, TRUE, FALSE, "Ready")
            0x68, ...u32(at('name')), 0x6a, 0, 0x6a, 1, 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateEventA')), 0xa3, ...u32(at('event')),
            // CreateProcessA(0, command, ..., &startup, &info)
            0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
            0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
            0x68, ...u32(at('command')), 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateProcessA')),
            // WaitForSingleObject(event, INFINITE): the child sets it
            0x6a, 0xff, 0xff, 0x35, ...u32(at('event')),
            0xff, 0x15, ...u32(iat('WaitForSingleObject')),
            // WaitForSingleObject(info.hProcess, INFINITE)
            0x6a, 0xff, 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('WaitForSingleObject')),
            // GetExitCodeProcess(info.hProcess, &code); ExitProcess(code + 0x100)
            0x68, ...u32(at('code')), 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('GetExitCodeProcess')),
            0xa1, ...u32(at('code')), 0x05, ...u32(0x100), 0x50,
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
    const child = buildExe({
        imports: { 'KERNEL32.dll': ['OpenEventA', 'SetEvent', 'ExitProcess'] },
        data: { name: ascii('Ready') },
        code: ({ iat, at })=>[
            // SetEvent(OpenEventA(EVENT_ALL_ACCESS, FALSE, "Ready")); ExitProcess(5)
            0x68, ...u32(at('name')), 0x6a, 0, 0x68, ...u32(0x1f0003),
            0xff, 0x15, ...u32(iat('OpenEventA')),
            0x50, 0xff, 0x15, ...u32(iat('SetEvent')),
            0x6a, 5, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
    // The same, but polling the child's exit code without ever waiting: it
    // never stops having something to run, so only a child running beside it
    // ever answers.
    const poller = buildExe({
        imports: { 'KERNEL32.dll': ['CreateProcessA', 'GetExitCodeProcess', 'ExitProcess'] },
        data: {
            command: ascii('C:\\App\\child.exe'),
            startup: [...u32(68), ...new Array(64).fill(0)],
            info: new Array(16).fill(0),
            code: u32(0),
        },
        codeSize: 0x80,
        code: ({ iat, at })=>[
            0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
            0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
            0x68, ...u32(at('command')), 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateProcessA')),
            // do GetExitCodeProcess(info.hProcess, &code) while code == STILL_ACTIVE
            0x68, ...u32(at('code')), 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('GetExitCodeProcess')),
            0x81, 0x3d, ...u32(at('code')), ...u32(0x103),
            0x74, 0x100 - 29,
            // ExitProcess(code + 0x100)
            0xa1, ...u32(at('code')), 0x05, ...u32(0x100), 0x50,
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
    return { parent, poller, child };
}

test('with concurrency a child runs beside its parent, which goes on: woken by the event the'
    + ' child sets, then by its exit; or never waiting at all', { timeout: 60000 }, async t=>{
    const { parent, poller, child } = buildEventPair();
    /** @param {Uint8Array} executable @param {any} [concurrency] */
    const run = async(executable, concurrency)=>{
        const app = await createApp({
            executable,
            imagePath: 'C:\\App\\parent.exe',
            engine: 'cork',
            ...concurrency ? { concurrency } : {},
            storage: { load: async()=>({ files: [{ path: 'C:\\App\\child.exe', bytes: child }] }) },
        });
        t.after(()=>app.dispose());
        return (await app.run({ timeoutMs: 30000 })) >>> 0;
    };
    assert.equal(await run(parent, 2), 0x105,
        'the parent was there when the child set its event, and saw the child exit with 5');
    assert.equal(await run(poller, 2), 0x105,
        'a parent that never waits still sees its child run and exit');
    assert.equal(await run(parent), 0x105,
        'where one process runs at a time the child runs while its parent waits, and the'
        + ' parent goes on after it');
});

test('a child in a worker of its own sets the event its parent named, and the parent wakes',
    { timeout: 60000 }, async t=>{
        const { parent, child } = buildEventPair();
        const app = await createApp({
            executable: parent,
            imagePath: 'C:\\App\\parent.exe',
            engine: 'cork',
            concurrency: 2,
            storage: { load: async()=>({ files: [{ path: 'C:\\App\\child.exe', bytes: child }] }) },
        });
        t.after(()=>app.dispose());
        /** @type {any[]} */
        const started = [];
        app.on('process-started', (/** @type {any} */ event)=>started.push(event.worker));
        assert.equal((await app.run({ timeoutMs: 30000 })) >>> 0, 0x105,
            'woken by the event the child set across the link, then by its exit with 5');
        assert.deepEqual(started, [true, true],
            'the program and its child ran in workers of their own');
    });

/**
 * A child that names an event and waits on it, exiting with 7 once it is set;
 * and its parent, which polls for the name until the child has made it, sets
 * it, waits for the child and exits with 0x100 + the child's code.
 */
/** @param {number} [delay]  milliseconds the parent sleeps before it looks for the event */
function buildWaitingChild(delay = 0){
    const parent = buildExe({
        imports: { 'KERNEL32.dll': ['CreateProcessA', 'OpenEventA', 'Sleep', 'SetEvent',
            'WaitForSingleObject', 'GetExitCodeProcess', 'ExitProcess'] },
        data: {
            name: ascii('Go'),
            command: ascii('C:\\App\\child.exe'),
            startup: [...u32(68), ...new Array(64).fill(0)],
            info: new Array(16).fill(0),
            code: u32(0),
        },
        codeSize: 0x100,
        code: ({ iat, at })=>[
            0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
            0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
            0x68, ...u32(at('command')), 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateProcessA')),
            // Sleep(delay): the child is waiting by the time the parent looks
            0x68, ...u32(delay), 0xff, 0x15, ...u32(iat('Sleep')),
            // until OpenEventA(EVENT_ALL_ACCESS, FALSE, "Go") finds it: Sleep(1)
            0x68, ...u32(at('name')), 0x6a, 0, 0x68, ...u32(0x1f0003),
            0xff, 0x15, ...u32(iat('OpenEventA')),
            0x85, 0xc0, 0x75, 0x0a,
            0x6a, 0x01, 0xff, 0x15, ...u32(iat('Sleep')),
            0xeb, 0x100 - 32,
            // SetEvent(eax); WaitForSingleObject(info.hProcess, INFINITE)
            0x50, 0xff, 0x15, ...u32(iat('SetEvent')),
            0x6a, 0xff, 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('WaitForSingleObject')),
            0x68, ...u32(at('code')), 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('GetExitCodeProcess')),
            0xa1, ...u32(at('code')), 0x05, ...u32(0x100), 0x50,
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
    const child = buildExe({
        imports: { 'KERNEL32.dll': ['CreateEventA', 'WaitForSingleObject', 'ExitProcess'] },
        data: { name: ascii('Go') },
        code: ({ iat, at })=>[
            // WaitForSingleObject(CreateEventA(NULL, FALSE, FALSE, "Go"), INFINITE)
            0x68, ...u32(at('name')), 0x6a, 0, 0x6a, 0, 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateEventA')),
            0x6a, 0xff, 0x50, 0xff, 0x15, ...u32(iat('WaitForSingleObject')),
            0x6a, 7, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
    return { parent, child };
}

for (const delay of [0, 1000])
{
    test(`a child in a worker of its own waits on the event it named until its parent finds and`
        + ` sets it${delay ? ', however long that takes' : ''}`, { timeout: 60000 }, async t=>{
        const { parent, child } = buildWaitingChild(delay);
        const app = await createApp({
            executable: parent,
            imagePath: 'C:\\App\\parent.exe',
            engine: 'cork',
            concurrency: 2,
            storage: { load: async()=>({ files: [{ path: 'C:\\App\\child.exe', bytes: child }] }) },
        });
        t.after(()=>app.dispose());
        assert.equal((await app.run({ timeoutMs: 30000 })) >>> 0, 0x107,
            'the child woke on its parent\'s SetEvent and exited with 7');
    });
}

/**
 * A parent that starts C:\\App\\a.exe and C:\\App\\b.exe one after the other and
 * waits for both; a.exe sleeps a while, so b.exe starts while it still runs.
 */
function buildTwoChildren(){
    const parent = buildExe({
        imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject', 'ExitProcess'] },
        data: {
            first: ascii('C:\\App\\a.exe'),
            second: ascii('C:\\App\\b.exe'),
            startup: [...u32(68), ...new Array(64).fill(0)],
            infoA: new Array(16).fill(0),
            infoB: new Array(16).fill(0),
        },
        codeSize: 0x80,
        code: ({ iat, at })=>{
            /** @param {string} command @param {string} info */
            const start = (command, info)=>[
                0x68, ...u32(at(info)), 0x68, ...u32(at('startup')),
                0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
                0x68, ...u32(at(command)), 0x6a, 0,
                0xff, 0x15, ...u32(iat('CreateProcessA')),
            ];
            /** @param {string} info */
            const wait = info=>[0x6a, 0xff, 0xff, 0x35, ...u32(at(info)),
                0xff, 0x15, ...u32(iat('WaitForSingleObject'))];
            return [...start('first', 'infoA'), ...start('second', 'infoB'),
                ...wait('infoA'), ...wait('infoB'),
                0x6a, 0, 0xff, 0x15, ...u32(iat('ExitProcess'))];
        },
    });
    const sleeper = buildExe({
        imports: { 'KERNEL32.dll': ['Sleep', 'ExitProcess'] },
        code: ({ iat })=>[0x68, ...u32(1500), 0xff, 0x15, ...u32(iat('Sleep')),
            0x6a, 1, 0xff, 0x15, ...u32(iat('ExitProcess'))],
    });
    const quick = buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        code: ({ iat })=>[0x6a, 2, 0xff, 0x15, ...u32(iat('ExitProcess'))],
    });
    return { parent, sleeper, quick };
}

test('a child past the run\'s concurrency runs beside its parent, in its parent\'s worker',
    { timeout: 60000 }, async t=>{
        const { parent, sleeper, quick } = buildTwoChildren();
        const app = await createApp({
            executable: parent,
            imagePath: 'C:\\App\\parent.exe',
            engine: 'cork',
            concurrency: 2,
            storage: { load: async()=>({ files: [{ path: 'C:\\App\\a.exe', bytes: sleeper },
                { path: 'C:\\App\\b.exe', bytes: quick }] }) },
        });
        t.after(()=>app.dispose());
        /** @type {[string, boolean][]} */
        const started = [];
        app.on('process-started', (/** @type {any} */ event)=>
            started.push([event.image, event.worker === true]));
        assert.equal(await app.run({ timeoutMs: 30000 }), 0);
        assert.deepEqual(started, [['C:\\App\\parent.exe', true], ['C:\\App\\a.exe', true],
            ['C:\\App\\b.exe', false]],
        'two at once: the program and its first child each in a worker, the second child beside'
        + ' the program, in its worker');
    });

for (const [concurrency, across] of /** @type {[2 | 4, boolean][]} */ ([[4, true], [2, false]]))
{
    test(`a child's own child runs in a worker of its own while the run has room (concurrency`
        + ` ${concurrency}), and its code reaches the parent through it`,
    { timeout: 60000 }, async t=>{
        const leaf = buildExe({
            imports: { 'KERNEL32.dll': ['ExitProcess'] },
            code: ({ iat })=>[0x6a, 7, 0xff, 0x15, ...u32(iat('ExitProcess'))],
        });
        const app = await createApp({
            executable: waitingParent('C:\\App\\middle.exe'),
            imagePath: 'C:\\App\\root.exe',
            engine: 'cork',
            concurrency,
            storage: { load: async()=>({ files: [
                { path: 'C:\\App\\middle.exe', bytes: waitingParent('C:\\App\\leaf.exe') },
                { path: 'C:\\App\\leaf.exe', bytes: leaf }] }) },
        });
        t.after(()=>app.dispose());
        /** @type {[string, boolean][]} */
        const started = [];
        app.on('process-started', (/** @type {any} */ event)=>
            started.push([event.image, event.worker === true]));
        assert.equal(await app.run({ timeoutMs: 30000 }), 7);
        assert.deepEqual(started, [['C:\\App\\root.exe', true],
            ['C:\\App\\middle.exe', true], ['C:\\App\\leaf.exe', across]], across
            ? 'each in a worker of its own'
            : 'the second past the run\'s room, beside its parent');
    });
}

test('concurrency asked for where memory cannot be shared falls back to one process at a time,'
    + ' and says so', { timeout: 60000 }, async t=>{
    const { parent, child } = buildEventPair();
    const app = await createApp({
        executable: parent,
        imagePath: 'C:\\App\\parent.exe',
        engine: 'cork',
        mode: 'compatible',
        concurrency: 4,
        storage: { load: async()=>({ files: [{ path: 'C:\\App\\child.exe', bytes: child }] }) },
    });
    t.after(()=>app.dispose());
    /** @type {any[]} */
    const fallbacks = [];
    app.on('fallback', (/** @type {any} */ said)=>fallbacks.push(said));
    assert.equal((await app.run({ timeoutMs: 30000 })) >>> 0, 0x105,
        'the child ran in its parent\'s place');
    assert.equal(fallbacks.length, 1);
    assert.deepEqual([fallbacks[0].mode, fallbacks[0].concurrency, fallbacks[0].asked],
        ['compatible', 1, { mode: 'compatible', concurrency: 4 }]);
    assert.match(fallbacks[0].detail, /concurrency 4 is not allowed here/);
    const metrics = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'app')
        ?.metrics;
    assert.deepEqual([metrics.mode, metrics.concurrency], ['compatible', 1]);
});

/**
 * A parent that starts C:\\App\\a.exe and C:\\App\\b.exe, neither of which ever
 * exits, sleeps `delay` milliseconds, terminates them with 3 and 5, waits for
 * both and exits with 0x10 * a's code + b's.
 *
 * @param {number} delay
 */
function buildTerminatingParent(delay){
    const parent = buildExe({
        imports: { 'KERNEL32.dll': ['CreateProcessA', 'Sleep', 'TerminateProcess',
            'WaitForSingleObject', 'GetExitCodeProcess', 'ExitProcess'] },
        data: {
            first: ascii('C:\\App\\a.exe'),
            second: ascii('C:\\App\\b.exe'),
            startup: [...u32(68), ...new Array(64).fill(0)],
            infoA: new Array(16).fill(0),
            infoB: new Array(16).fill(0),
            codeA: u32(0),
            codeB: u32(0),
        },
        codeSize: 0x100,
        code: ({ iat, at })=>{
            /** @param {string} info @param {string} command */
            const start = (info, command)=>[
                0x68, ...u32(at(info)), 0x68, ...u32(at('startup')),
                0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
                0x68, ...u32(at(command)), 0x6a, 0,
                0xff, 0x15, ...u32(iat('CreateProcessA'))];
            /** @param {string} info @param {number} code */
            const terminate = (info, code)=>[0x6a, code, 0xff, 0x35, ...u32(at(info)),
                0xff, 0x15, ...u32(iat('TerminateProcess'))];
            /** @param {string} info */
            const wait = info=>[0x6a, 0xff, 0xff, 0x35, ...u32(at(info)),
                0xff, 0x15, ...u32(iat('WaitForSingleObject'))];
            /** @param {string} info @param {string} code */
            const exitCode = (info, code)=>[0x68, ...u32(at(code)), 0xff, 0x35, ...u32(at(info)),
                0xff, 0x15, ...u32(iat('GetExitCodeProcess'))];
            return [
                ...start('infoA', 'first'), ...start('infoB', 'second'),
                0x68, ...u32(delay), 0xff, 0x15, ...u32(iat('Sleep')),
                ...terminate('infoA', 3), ...terminate('infoB', 5),
                ...wait('infoA'), ...wait('infoB'),
                ...exitCode('infoA', 'codeA'), ...exitCode('infoB', 'codeB'),
                // ExitProcess(codeA << 4 + codeB)
                0xa1, ...u32(at('codeA')), 0xc1, 0xe0, 0x04, 0x03, 0x05, ...u32(at('codeB')),
                0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ];
        },
    });
    const endless = buildExe({
        imports: { 'KERNEL32.dll': ['Sleep'] },
        data: {},
        // for (;;) Sleep(10);
        code: ({ iat })=>[0x6a, 10, 0xff, 0x15, ...u32(iat('Sleep')), 0xeb, 0x100 - 10],
    });
    return { parent, endless };
}

for (const delay of [0, 1000])
{
    test('TerminateProcess ends a child running beside its parent, in a worker of its own or in'
        + ` its parent's, and its parent's wait on it ends with the code${delay
            ? ', once it runs' : ', before it has started'}`, { timeout: 60000 }, async t=>{
        const { parent, endless } = buildTerminatingParent(delay);
        const app = await createApp({
            executable: parent,
            imagePath: 'C:\\App\\parent.exe',
            engine: 'cork',
            concurrency: 2,
            storage: { load: async()=>({ files: [{ path: 'C:\\App\\a.exe', bytes: endless },
                { path: 'C:\\App\\b.exe', bytes: endless }] }) },
        });
        t.after(()=>app.dispose());
        /** @type {[string, boolean][]} */
        const started = [];
        app.on('process-started', (/** @type {any} */ event)=>
            started.push([event.image, event.worker === true]));
        assert.equal(await app.run({ timeoutMs: 30000 }), 0x35,
            'a ended with 3 and b with 5, and the parent saw both');
        // Ended before it was made, a child is not said to have started.
        const where = new Map(started);
        assert.equal(where.get('C:\\App\\a.exe') ?? true, true, 'a in a worker of its own');
        assert.equal(where.get('C:\\App\\b.exe') ?? false, false, 'b beside its parent');
    });
}

test('a timed wait on a child running beside its parent runs out while the child runs',
    { timeout: 60000 }, async t=>{
        // msg.c test_WaitForInputIdle waits a second on a child that never
        // exits and then terminates it: the wait answers WAIT_TIMEOUT.
        const parent = buildExe({
            imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject',
                'TerminateProcess', 'ExitProcess'] },
            data: {
                command: ascii('C:\\App\\a.exe'),
                startup: [...u32(68), ...new Array(64).fill(0)],
                info: new Array(16).fill(0),
                waited: u32(0),
            },
            codeSize: 0x100,
            code: ({ iat, at })=>[
                0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
                0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
                0x68, ...u32(at('command')), 0x6a, 0,
                0xff, 0x15, ...u32(iat('CreateProcessA')),
                // waited = WaitForSingleObject(info.hProcess, 300)
                0x68, ...u32(300), 0xff, 0x35, ...u32(at('info')),
                0xff, 0x15, ...u32(iat('WaitForSingleObject')), 0xa3, ...u32(at('waited')),
                // TerminateProcess(info.hProcess, 1);
                // WaitForSingleObject(info.hProcess, INFINITE)
                0x6a, 1, 0xff, 0x35, ...u32(at('info')),
                0xff, 0x15, ...u32(iat('TerminateProcess')),
                0x6a, 0xff, 0xff, 0x35, ...u32(at('info')),
                0xff, 0x15, ...u32(iat('WaitForSingleObject')),
                // ExitProcess(waited)
                0xff, 0x35, ...u32(at('waited')), 0xff, 0x15, ...u32(iat('ExitProcess')),
            ],
        });
        const { endless } = buildTerminatingParent(0);
        const app = await createApp({
            executable: parent,
            imagePath: 'C:\\App\\parent.exe',
            engine: 'cork',
            concurrency: 2,
            storage: { load: async()=>({ files: [{ path: 'C:\\App\\a.exe', bytes: endless }] }) },
        });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 30000 }), 0x102, 'WAIT_TIMEOUT');
    });

test('a child takes the memory of the child before it, zeroed where that one wrote',
    { timeout: 60000 }, async t=>{
        // A gone process's memory is freed by a garbage collection nothing
        // prompts; a parent that starts one short-lived child after another
        // -- a compiler a shader at a time -- held one memory per child until
        // the page could allocate no more. The second child is handed the
        // first's, and finds zero where the first left its mark.
        /**
         * CreateProcessA on a command line and the wait on what it started.
         * @param {string} command
         * @returns {(at: { iat: (name: string) => number, at: (name: string) => number })
         *     => number[]}
         */
        const start = command=>({ iat, at })=>[
            0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
            0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
            0x68, ...u32(at(command)), 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateProcessA')),
            0x6a, 0xff, 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('WaitForSingleObject')),
        ];
        const parent = buildExe({
            imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject', 'ExitProcess'] },
            data: {
                writer: ascii('C:\\App\\writer.exe'),
                reader: ascii('C:\\App\\reader.exe'),
                startup: [...u32(68), ...new Array(64).fill(0)],
                info: new Array(16).fill(0),
            },
            codeSize: 0xa0,
            code: ({ iat, at })=>[...start('writer')({ iat, at }), ...start('reader')({ iat, at }),
                0x6a, 0, 0xff, 0x15, ...u32(iat('ExitProcess'))],
        });
        /** HeapAlloc(GetProcessHeap(), 0, 64 KiB) into eax. @param {(name: string) => number} iat */
        const allocate = iat=>[
            0xff, 0x15, ...u32(iat('GetProcessHeap')),
            0x68, ...u32(0x10000), 0x6a, 0, 0x50,
            0xff, 0x15, ...u32(iat('HeapAlloc')),
        ];
        const imports = { 'KERNEL32.dll': ['GetProcessHeap', 'HeapAlloc', 'ExitProcess'] };
        // mov dword [eax], 0x5a5a5a5a; exit with the block's address
        const writer = buildExe({ imports, code: ({ iat })=>[...allocate(iat),
            0xc7, 0x00, ...u32(0x5a5a5a5a), 0x50, 0xff, 0x15, ...u32(iat('ExitProcess'))] });
        // exit with the address plus what lies there
        const reader = buildExe({ imports, code: ({ iat })=>[...allocate(iat),
            0x8b, 0x08, 0x01, 0xc8, 0x50, 0xff, 0x15, ...u32(iat('ExitProcess'))] });

        const memorySize = 256 * 1024 * 1024;
        const Made = WebAssembly.Memory;
        let made = 0;
        WebAssembly.Memory = /** @type {any} */ (function(/** @type {any} */ descriptor){
            const memory = new Made(descriptor);
            made += memory.buffer.byteLength >= memorySize ? 1 : 0;
            return memory;
        });
        WebAssembly.Memory.prototype = Made.prototype;
        t.after(()=>{
            WebAssembly.Memory = Made;
        });
        const app = await createApp({
            executable: parent,
            imagePath: 'C:\\App\\parent.exe',
            engine: 'cork',
            memorySize,
            storage: { load: async()=>({ files: [
                { path: 'C:\\App\\writer.exe', bytes: writer },
                { path: 'C:\\App\\reader.exe', bytes: reader },
            ] }) },
        });
        t.after(()=>app.dispose());
        /** @type {number[]} */
        const codes = [];
        app.on('process-resumed', (/** @type {any} */ event)=>codes.push(event.code >>> 0));
        assert.equal(await app.run({ timeoutMs: 30000 }), 0);
        assert.equal(codes.length, 2, 'both children ran');
        assert.notEqual(codes[0], 0, 'the writer was given a block');
        assert.equal(codes[1], codes[0], 'the reader was given the same block, and found it zero');
        assert.equal(made, 2, 'the parent\'s memory and one more, not one per child');
    });
