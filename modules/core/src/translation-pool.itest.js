/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's translation pool under a real run: every
 * process is lent a worker of the pool from its start and gives it back at
 * its exit, its translator emitting through the worker over the port it was
 * lent, and the program reads what it reads without the pool. The spawn
 * fixture -- a parent and two children run in turn -- runs on this thread
 * (concurrency 1) and with every process in a worker of its own
 * (concurrency 2), where the lending crosses to the process's worker.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp } from './app.js';

for (const concurrency of /** @type {const} */ ([1, 2]))
{
    test(`each process of a run is lent a worker of the pool and gives it back`
        + ` (concurrency ${concurrency})`, { timeout: 120000 }, async t=>{
        const [parent, child] = await Promise.all([
            readFile(new URL('../test/fixtures/spawn.exe', import.meta.url)),
            readFile(new URL('../test/fixtures/spawn_child.exe', import.meta.url)),
        ]);
        const app = await createApp({
            executable: new Uint8Array(parent),
            imagePath: 'C:\\App\\spawn.exe',
            concurrency,
            cork: { poolPerProcess: 2, config: { worker: true, hotThreshold: 50 } },
            storage: { load: async()=>({
                files: [{ path: 'C:\\App\\spawn_child.exe', bytes: new Uint8Array(child) }],
            }) },
        });
        t.after(()=>app.dispose());
        /** @type {string[]} */
        const output = [];
        app.attachLog((/** @type {number} */ _handle, /** @type {string} */ text)=>
            output.push(text));
        const code = await app.run({ timeoutMs: 90000 });
        const lines = output.join('').split('\r\n').filter(Boolean);
        assert.deepEqual(lines.filter(line=>line.startsWith('FAIL')), [],
            `every property holds:\n${output.join('')}`);
        assert.equal(lines.filter(line=>line.startsWith('ok   ')).length, 10,
            `and every one was reached:\n${output.join('')}`);
        assert.equal(code, 0);
        const pool = app.translationPool();
        assert.ok(pool, 'the run has a pool');
        const starts = pool.journal.filter((/** @type {any} */ one)=>one.kind === 'start');
        const exits = pool.journal.filter((/** @type {any} */ one)=>one.kind === 'exit');
        assert.equal(new Set(starts.map((/** @type {any} */ one)=>one.process)).size, 3,
            `the parent and both children were each lent one: ${JSON.stringify(pool.journal)}`);
        assert.ok(exits.length >= 2,
            `the children gave theirs back: ${JSON.stringify(pool.journal)}`);
        assert.ok(pool.workers <= 2 * 2, `${pool.workers} workers, the ceiling perProcess × n`);
    });
}

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** Two threads that each loop on their own, the program waiting for both. */
async function twoLoops(){
    const { assemble, buildExe } = await import('../../../tools/fixtures/make-pe.mjs');
    const WORKER_AT = 0x100;
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'ExitProcess'] },
        codeSize: 0x200,
        data: { first: u32(0), second: u32(0) },
        code: ({ iat, at, code })=>{
            /** @param {string} name */
            const call = name=>[0xff, 0x15, ...u32(iat(name))];
            /** @param {string} slot */
            const start = slot=>[0x6a, 0x00, 0x6a, 0x00, 0x6a, 0x00, 0x68, ...u32(code(WORKER_AT)),
                0x6a, 0x00, 0x6a, 0x00, ...call('CreateThread'), 0xa3, ...u32(at(slot))];
            /** @param {string} slot */
            const wait = slot=>[0x6a, 0xff, 0xff, 0x35, ...u32(at(slot)),
                ...call('WaitForSingleObject')];
            const main = [...start('first'), ...start('second'), ...wait('first'),
                ...wait('second'), 0x6a, 0x00, ...call('ExitProcess')];
            const worker = assemble([
                0xb9, ...u32(40_000_000), //               mov ecx, 40 M
                0x31, 0xc0, //                             xor eax, eax
                { label: 'loop' },
                0x01, 0xc8, //                             add eax, ecx
                0x49, { jump: 'jnz', to: 'loop' }, //      dec ecx
                0x31, 0xc0, 0xc2, 0x04, 0x00, //           xor eax, eax; ret 4
            ]);
            return [...main, ...new Array(WORKER_AT - main.length).fill(0xcc), ...worker];
        },
    });
}

test('a process\'s other executors are lent workers of the pool, as its own is, and open no'
    + ' translator of their own: each its first, past the run\'s capacity', { timeout: 120000 },
async t=>{
    // A capacity of one: the process's own executor takes it, and the other,
    // left waiting for a lend, would interpret its whole loop.
    const app = await createApp({ executable: await twoLoops(), cpu: { cores: 2, eager: true },
        cork: { poolPerProcess: 2, poolCapacity: 1,
            config: { worker: true, hotThreshold: 50 } } });
    t.after(()=>app.dispose());
    assert.equal(await app.run({ timeoutMs: 90000 }), 0);
    const pool = app.translationPool();
    const lentTo = new Set(pool.journal.filter((/** @type {any} */ one)=>one.kind === 'start')
        .map((/** @type {any} */ one)=>one.process));
    assert.ok([...lentTo].some(id=>id < 0) && [...lentTo].some(id=>id > 0),
        `the process and an executor were each lent one: ${JSON.stringify(pool.journal)}`);
    assert.ok(pool.workers <= 2, `${pool.workers} workers: a first for each, none joined`);
});

/** @param {string} text */
const ascii = text=>[...text].map(character=>character.charCodeAt(0)).concat(0);

/**
 * A program that starts `command` and exits with its code once it has.
 *
 * @param {string} command
 */
async function starter(command){
    const { buildExe } = await import('../../../tools/fixtures/make-pe.mjs');
    return buildExe({
        imports: { 'KERNEL32.dll': ['CreateProcessA', 'WaitForSingleObject',
            'GetExitCodeProcess', 'ExitProcess'] },
        data: {
            command: ascii(command),
            startup: [...u32(68), ...new Array(64).fill(0)],
            info: new Array(16).fill(0),
            code: u32(0),
        },
        codeSize: 0x80,
        code: ({ iat, at })=>[
            // CreateProcessA(0, command, ..., &startup, &info)
            0x68, ...u32(at('info')), 0x68, ...u32(at('startup')),
            0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0, 0x6a, 0,
            0x68, ...u32(at('command')), 0x6a, 0,
            0xff, 0x15, ...u32(iat('CreateProcessA')),
            // WaitForSingleObject(info.hProcess, INFINITE)
            0x6a, 0xff, 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('WaitForSingleObject')),
            // GetExitCodeProcess(info.hProcess, &code); ExitProcess(code)
            0x68, ...u32(at('code')), 0xff, 0x35, ...u32(at('info')),
            0xff, 0x15, ...u32(iat('GetExitCodeProcess')),
            0xff, 0x35, ...u32(at('code')), 0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
}

test('a child that runs beside its parent in the parent\'s worker, the run having no worker'
    + ' left for it, is lent a worker of the pool as every process is', { timeout: 120000 },
async t=>{
    // The program and its child take the run's two workers; the child's own
    // child (ngen's worker process, under ngen) runs beside it, and was
    // never lent one: it interpreted every instruction it ran.
    const { assemble, buildExe } = await import('../../../tools/fixtures/make-pe.mjs');
    const exiting = buildExe({
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        code: ({ iat })=>assemble([
            0xb9, ...u32(20_000_000),
            0x31, 0xc0,
            { label: 'loop' },
            0x01, 0xc8,
            0x49, { jump: 'jnz', to: 'loop' },
            0x6a, 0x09, 0xff, 0x15, ...u32(iat('ExitProcess')),
        ]),
    });
    const app = await createApp({
        executable: await starter('C:\\App\\child.exe'),
        imagePath: 'C:\\App\\parent.exe',
        concurrency: 2,
        cork: { poolPerProcess: 1, config: { worker: true, hotThreshold: 50 } },
        storage: { load: async()=>({ files: [
            { path: 'C:\\App\\child.exe', bytes: await starter('C:\\App\\grandchild.exe') },
            { path: 'C:\\App\\grandchild.exe', bytes: exiting },
        ] }) },
    });
    t.after(()=>app.dispose());
    /** @type {{ image: string, worker: boolean }[]} */
    const started = [];
    app.on('process-started', (/** @type {any} */ event)=>started.push({
        image: event.image, worker: event.worker === true }));
    assert.equal(await app.run({ timeoutMs: 90000 }), 9, 'the grandchild\'s code came back');
    assert.deepEqual(started.map(one=>one.worker), [true, true, false],
        'the program and its child in workers of their own, the grandchild beside its parent');
    const pool = app.translationPool();
    const lentTo = new Set(pool.journal.filter((/** @type {any} */ one)=>one.kind === 'start')
        .map((/** @type {any} */ one)=>one.process));
    assert.equal(lentTo.size, 3, `each of the three was lent one: ${JSON.stringify(pool.journal)}`);
});
