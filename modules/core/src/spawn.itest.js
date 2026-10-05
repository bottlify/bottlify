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
    const app = await createApp({
        executable: new Uint8Array(parent),
        imagePath: 'C:\\App\\spawn.exe',
        storage: { load: async()=>({
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
function buildPoller(){
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
            0x6a, 1, 0xff, 0x15, ...u32(iat('Sleep')),                 // Sleep(1)
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

test('a child writes into the file its parent handed it as its output',
    { timeout: 120000 }, async t=>{
        const app = await createApp({
            executable: buildOutputParent(),
            imagePath: 'C:\\App\\parent.exe',
            files: [{ path: 'C:\\App\\child.exe', bytes: buildOutputChild() }],
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
