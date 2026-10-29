/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A child beside its parent, where processes run at once: one in a worker of
 * its own writing into the file its parent handed it as its output, and the
 * events a parent and its child name and set and wait on. Apart from
 * `spawn.itest.js` and `spawn-children.itest.js`: a file is one test to the
 * runner, and the three together took 42 s of the minute the integration suite
 * gives each file on an idle machine -- past it on a loaded one, every test
 * still to run cancelled.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
/** @param {string} text */
const ascii = text=>[...text].map(character=>character.charCodeAt(0)).concat(0);

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
        'the child ran beside its parent, on one thread');
    assert.equal(fallbacks.length, 1);
    assert.deepEqual([fallbacks[0].mode, fallbacks[0].concurrency, fallbacks[0].asked],
        ['compatible', 1, { mode: 'compatible', concurrency: 4 }]);
    assert.match(fallbacks[0].detail, /concurrency 4 is not allowed here/);
    const metrics = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'app')
        ?.metrics;
    assert.deepEqual([metrics.mode, metrics.concurrency], ['compatible', 1]);
});
