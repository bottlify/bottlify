/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Children past what a parent waits on: past the run's concurrency, a child's
 * own child, TerminateProcess and a timed wait on a child still running, a
 * child built over the memory the one before it left, and one built from an
 * image gone from the disk after CreateProcess. Apart from `spawn.itest.js`
 * and `spawn-across.itest.js`, for the minute the integration suite gives each
 * file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import { waitingParent } from '../../../tools/spawn-program.mjs';

/** @param {number} value */
const u32 = value=>[value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255];
/** @param {string} text */
const ascii = text=>[...text].map(character=>character.charCodeAt(0)).concat(0);

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
            concurrency: 2,
            storage: { load: async()=>({ files: [{ path: 'C:\\App\\a.exe', bytes: sleeper },
                { path: 'C:\\App\\b.exe', bytes: quick }] }) },
        });
        t.after(()=>app.dispose());
        /** @type {[string, boolean][]} */
        const started = [];
        app.on('process-started', (/** @type {any} */ event)=>
            started.push([event.image, event.worker === true]));
        assert.equal(await app.run({ timeoutMs: 60_000 }), 0);
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
        assert.equal(await app.run({ timeoutMs: 60_000 }), 7);
        assert.deepEqual(started, [['C:\\App\\root.exe', true],
            ['C:\\App\\middle.exe', true], ['C:\\App\\leaf.exe', across]], across
            ? 'each in a worker of its own'
            : 'the second past the run\'s room, beside its parent');
    });
}

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
            concurrency: 2,
            storage: { load: async()=>({ files: [{ path: 'C:\\App\\a.exe', bytes: endless },
                { path: 'C:\\App\\b.exe', bytes: endless }] }) },
        });
        t.after(()=>app.dispose());
        /** @type {[string, boolean][]} */
        const started = [];
        app.on('process-started', (/** @type {any} */ event)=>
            started.push([event.image, event.worker === true]));
        assert.equal(await app.run({ timeoutMs: 60_000 }), 0x35,
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
            concurrency: 2,
            storage: { load: async()=>({ files: [{ path: 'C:\\App\\a.exe', bytes: endless }] }) },
        });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 60_000 }), 0x102, 'WAIT_TIMEOUT');
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
        assert.equal(await app.run({ timeoutMs: 60_000 }), 0);
        assert.equal(codes.length, 2, 'both children ran');
        assert.notEqual(codes[0], 0, 'the writer was given a block');
        assert.equal(codes[1], codes[0], 'the reader was given the same block, and found it zero');
        assert.equal(made, 2, 'the parent\'s memory and one more, not one per child');
    });

test('a child starts from its image as it was when CreateProcess was called, gone from the disk'
    + ' after', { timeout: 60000 }, async t=>{
    // A setup that copies itself to a file opened delete-on-close, starts the
    // copy and exits: the file is gone before the child is built, and Windows
    // mapped the image at CreateProcess. Deleting it right after the call is
    // the same order of events in one process.
    const leaf = buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        code: ({ iat })=>[0x6a, 7, 0xff, 0x15, ...u32(iat('ExitProcess'))],
    });
    const parent = buildExe({
        imports: { 'KERNEL32.dll': ['CreateProcessA', 'DeleteFileA', 'WaitForSingleObject',
            'GetExitCodeProcess', 'ExitProcess'] },
        data: {
            command: [...Buffer.from('C:\\App\\copy.tmp'), 0],
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
            0x68, ...u32(at('command')),
            0xff, 0x15, ...u32(iat('DeleteFileA')),
            0x6a, 0xff, 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('WaitForSingleObject')),
            0x68, ...u32(at('code')), 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('GetExitCodeProcess')),
            0xff, 0x35, ...u32(at('code')),
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
    const app = await createApp({
        executable: parent,
        imagePath: 'C:\\App\\setup.exe',
        files: [{ path: 'C:\\App\\copy.tmp', bytes: leaf }],
    });
    t.after(()=>app.dispose());
    assert.equal(await app.run({ timeoutMs: 60_000 }), 7, 'the child ran and its code came back');
});
