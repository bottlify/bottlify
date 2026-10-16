/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Libraries on threads that run at once (roadmap/v2, stage 3): a program's own
 * library called from threads on several executors, one loaded by a thread
 * that is not the process's own executor's, and the system's -- kernel32's
 * critical sections and thread-local slots, the process heap and msvcrt's
 * malloc -- under threads that race through them. Each program ends with the
 * same exit code on one executor, the threads taking turns, as on three, where
 * every one of those is shared by threads running at the same time.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.js';
import { writeBundle } from './bundle-node.js';
import { assemble, buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];

/** @param {string} text */
const cString = text=>[...text].map(c=>c.charCodeAt(0)).concat(0);

/** Where each program's worker starts, into its code. */
const WORKER_AT = 0x200;
const CODE_SIZE = 0x400;

/** @typedef {import('../../../tools/make-pe.mjs').AsmPart} Part */

/**
 * A program of a main routine and a worker routine at `WORKER_AT`.
 *
 * @param {Record<string, string[]>} imports
 * @param {Record<string, number[]>} data
 * @param {(ctx: { iat: (name: string) => number, at: (name: string) => number,
 *     worker: number }) => { main: Part[], worker: Part[] }} parts
 */
function program(imports, data, parts){
    return buildExe({
        imports,
        data,
        codeSize: CODE_SIZE,
        code: ({ iat, at, code })=>{
            const { main, worker } = parts({ iat, at, worker: code(WORKER_AT) });
            const head = assemble(main);
            if (head.length > WORKER_AT)
            {
                throw new Error(`main is ${head.length} bytes`);
            }
            return [...head, ...new Array(WORKER_AT - head.length).fill(0xcc),
                ...assemble(worker)];
        },
    });
}

/** call [import] @param {(name: string) => number} iat @param {string} name */
const call = (iat, name)=>[0xff, 0x15, ...u32(iat(name))];

/**
 * CreateThread(NULL, 0, start, param, 0, &id), the handle to `handle`.
 *
 * @param {(name: string) => number} iat @param {number} start @param {number} param
 * @param {number} id @param {number} handle
 */
const startThread = (iat, start, param, id, handle)=>[
    0x68, ...u32(id), 0x6a, 0x00, 0x68, ...u32(param), 0x68, ...u32(start),
    0x6a, 0x00, 0x6a, 0x00, ...call(iat, 'CreateThread'), 0xa3, ...u32(handle),
];

/** WaitForSingleObject([handle], INFINITE) @param {(name: string) => number} iat @param {number} handle */
const join_ = (iat, handle)=>[0x6a, 0xff, 0xff, 0x35, ...u32(handle),
    ...call(iat, 'WaitForSingleObject')];

/** or ebx, bit unless the flags say not equal: jne +3 first. @param {number} bit */
const bitIfEqual = bit=>[0x75, 0x03, 0x83, 0xcb, bit];

/** ExitProcess(ebx) @param {(name: string) => number} iat */
const exitWithBits = iat=>[0x53, ...call(iat, 'ExitProcess')];

/** mov dword [address], 1 unless equal: je over it. @param {number} address */
const markIfNotEqual = address=>[0x74, 0x0a, 0xc7, 0x05, ...u32(address), ...u32(1)];

/**
 * A program's library, at a base of its own: DllMain at 0 notes the thread it
 * was attached on in `tid`; `bump` at 0x20 adds one to `count` with a locked
 * add and answers the count it made; `whoami` at 0x30 answers the calling
 * thread's id.
 *
 * @param {number} imageBase
 */
function library(imageBase){
    return buildExe({
        dll: true,
        imageBase,
        imports: { 'KERNEL32.dll': ['GetCurrentThreadId'] },
        codeSize: 0x40,
        // Data starts at the end of the code budget.
        data: { tid: u32(0), count: u32(0) },
        exports: [
            { name: 'bump', offset: 0x20 },
            { name: 'whoami', offset: 0x30 },
            { name: 'tid', offset: 0x40 },
            { name: 'count', offset: 0x44 },
        ],
        code: ({ iat, at })=>{
            const main = [
                0x8b, 0x44, 0x24, 0x08, //                       mov eax, [esp+8]  fdwReason
                0x83, 0xf8, 0x01, //                             cmp eax, DLL_PROCESS_ATTACH
                0x75, 0x0b, //                                   jne done
                ...call(iat, 'GetCurrentThreadId'),
                0xa3, ...u32(at('tid')), //                      mov [tid], eax
                0xb8, ...u32(1), //                              done: mov eax, TRUE
                0xc2, 0x0c, 0x00, //                             ret 12
            ];
            const bump = [
                0xb8, ...u32(1), //                              mov eax, 1
                0xf0, 0x0f, 0xc1, 0x05, ...u32(at('count')), //  lock xadd [count], eax
                0x40, 0xc3, //                                   inc eax; ret
            ];
            const whoami = [...call(iat, 'GetCurrentThreadId'), 0xc3];
            return [...main, ...new Array(0x20 - main.length).fill(0xcc),
                ...bump, ...new Array(0x10 - bump.length).fill(0xcc), ...whoami];
        },
    });
}

/**
 * Runs `executable` from a bundle holding `libraries`, on `executors`: its exit
 * code, and how many slices the other executors ran.
 *
 * @param {Uint8Array} executable @param {Record<string, Uint8Array>} libraries
 * @param {number} executors
 */
async function run(executable, libraries, executors){
    const root = await mkdtemp(join(tmpdir(), 'libs-src-'));
    const out = await mkdtemp(join(tmpdir(), 'libs-out-'));
    for (const [name, bytes] of Object.entries(libraries))
    {
        await writeFile(join(root, name), bytes);
    }
    const path = join(out, 'bundle.btl');
    await writeBundle({ root, output: path, blockSize: 4096 });
    const handle = await open(path, 'r');
    const app = await createApp({
        executable,
        imagePath: 'C:\\App\\libs.exe',
        executors,
        // Open from the start: the gate is threads at once from the first instruction.
        cpu: { eager: true },
        bundle: {
            prefix: 'App',
            fetch: async(/** @type {number} */ offset, /** @type {number} */ length)=>{
                const buffer = Buffer.alloc(length);
                await handle.read(buffer, 0, length, offset);
                return new Uint8Array(buffer);
            },
        },
    });
    try
    {
        const code = await app.run({ timeoutMs: 60_000 });
        const tables = await app.diagnostics();
        const kernel = (Array.isArray(tables) ? tables : []).find(table=>table.name === 'kernel');
        return { code, elsewhere: kernel?.metrics?.executorSlices ?? 0 };
    }
    finally
    {
        await app.dispose();
        await handle.close();
        await rm(root, { recursive: true, force: true });
        await rm(out, { recursive: true, force: true });
    }
}

/**
 * The same exit code on one executor and on three, and on three the threads
 * ran on the others.
 *
 * @param {Uint8Array} executable @param {Record<string, Uint8Array>} libraries
 * @param {number} expected
 */
async function sameOnOneAndThree(executable, libraries, expected){
    const one = await run(executable, libraries, 1);
    assert.equal(one.code, expected, 'one executor');
    const three = await run(executable, libraries, 3);
    assert.equal(three.code, expected, 'three executors');
    assert.ok(three.elsewhere > 0, 'three: threads ran on the other executors');
}

const N = 5000;

test('a library\'s exports called from threads on several executors at once',
    { timeout: 120_000 }, async()=>{
        // Two workers and the main thread bump the library's count N times each
        // through the import table, and each worker asks the library who it is.
        // Exit: 1 the count is 3N, 2 and 4 each worker was told its own id.
        const executable = program({
            'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'ExitProcess'],
            'lib.dll': ['bump', 'whoami', 'count'],
        }, {
            id1: u32(0), id2: u32(0), h1: u32(0), h2: u32(0), who1: u32(0), who2: u32(0),
        }, ({ iat, at, worker })=>{
            /** cmp eax-loaded [a] with [b] @param {string} a @param {string} b */
            const same = (a, b)=>[0xa1, ...u32(at(a)), 0x3b, 0x05, ...u32(at(b))];
            /** @type {Part[]} */
            const bumps = [0xb9, ...u32(N), { label: 'L' }, 0x51, ...call(iat, 'bump'), 0x59,
                0x49, { jump: 'jnz', to: 'L' }];
            return {
                main: [
                    ...startThread(iat, worker, at('who1'), at('id1'), at('h1')),
                    ...startThread(iat, worker, at('who2'), at('id2'), at('h2')),
                    ...bumps,
                    ...join_(iat, at('h1')), ...join_(iat, at('h2')),
                    0x31, 0xdb, //                                  xor ebx, ebx
                    0xa1, ...u32(iat('count')), 0x8b, 0x00, // mov eax, [&count]; mov eax, [eax]
                    0x3d, ...u32(3 * N), ...bitIfEqual(1), //        cmp eax, 3N
                    ...same('who1', 'id1'), ...bitIfEqual(2),
                    ...same('who2', 'id2'), ...bitIfEqual(4),
                    ...exitWithBits(iat),
                ],
                worker: [
                    0x8b, 0x7c, 0x24, 0x04, // mov edi, [esp+4]  where to say who
                    ...bumps,
                    ...call(iat, 'whoami'), 0x89, 0x07, //           mov [edi], eax
                    0x31, 0xc0, 0xc2, 0x04, 0x00, //                 xor eax, eax; ret 4
                ],
            };
        });
        await sameOnOneAndThree(executable, { 'lib.dll': library(0x10000000) }, 7);
    });

test('a library loaded by a thread on another executor is attached on that thread',
    { timeout: 120_000 }, async()=>{
        // The worker loads lib2.dll, whose DllMain notes the thread it ran on,
        // and keeps its `bump`; the main thread calls that twice. Exit: 1 DllMain
        // ran on the worker, 2 the main thread's second bump made the count 2.
        const executable = program({
            'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'ExitProcess',
                'LoadLibraryA', 'GetProcAddress', 'GetCurrentThreadId'],
        }, {
            name: cString('lib2.dll'), tid: cString('tid'), bump: cString('bump'),
            id: u32(0), h: u32(0), ok: u32(0), bumpAt: u32(0),
        }, ({ iat, at, worker })=>({
            main: [
                ...startThread(iat, worker, 0, at('id'), at('h')),
                ...join_(iat, at('h')),
                0x31, 0xdb, //                                      xor ebx, ebx
                0x83, 0x3d, ...u32(at('ok')), 0x01, ...bitIfEqual(1), // cmp dword [ok], 1
                0xa1, ...u32(at('bumpAt')), 0x85, 0xc0, { jump: 'jz', to: 'out' },
                0x89, 0xc6, //                                      mov esi, eax
                0xff, 0xd6, 0xff, 0xd6, //                          call esi; call esi
                0x83, 0xf8, 0x02, ...bitIfEqual(2), //               cmp eax, 2
                { label: 'out' },
                ...exitWithBits(iat),
            ],
            worker: [
                0x68, ...u32(at('name')), ...call(iat, 'LoadLibraryA'),
                0x85, 0xc0, { jump: 'jz', to: 'done' },
                0x89, 0xc7, //                                      mov edi, eax
                0x68, ...u32(at('tid')), 0x57, ...call(iat, 'GetProcAddress'),
                0x8b, 0x30, // mov esi, [eax]  the attaching thread
                0x68, ...u32(at('bump')), 0x57, ...call(iat, 'GetProcAddress'),
                0xa3, ...u32(at('bumpAt')),
                ...call(iat, 'GetCurrentThreadId'),
                0x39, 0xf0, { jump: 'jnz', to: 'done' }, //          cmp eax, esi
                0xc7, 0x05, ...u32(at('ok')), ...u32(1),
                { label: 'done' },
                0x31, 0xc0, 0xc2, 0x04, 0x00,
            ],
        }));
        await sameOnOneAndThree(executable, { 'lib2.dll': library(0x12000000) }, 3);
    });

test('kernel32\'s critical sections and thread-local slots under threads at once',
    { timeout: 120_000 }, async()=>{
        // Two workers each add one N times to a plain counter inside a critical
        // section, and between times read back the slot each set to its own id.
        // Exit: 1 the counter is 2N, 2 no worker ever read another's value.
        const executable = program({
            'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'ExitProcess',
                'InitializeCriticalSection', 'EnterCriticalSection', 'LeaveCriticalSection',
                'TlsAlloc', 'TlsSetValue', 'TlsGetValue', 'GetCurrentThreadId'],
        }, {
            cs: new Array(24).fill(0), counter: u32(0), slot: u32(0), bad: u32(0),
            id1: u32(0), id2: u32(0), h1: u32(0), h2: u32(0),
        }, ({ iat, at, worker })=>({
            main: [
                0x68, ...u32(at('cs')), ...call(iat, 'InitializeCriticalSection'),
                ...call(iat, 'TlsAlloc'), 0xa3, ...u32(at('slot')),
                ...startThread(iat, worker, 0, at('id1'), at('h1')),
                ...startThread(iat, worker, 0, at('id2'), at('h2')),
                ...join_(iat, at('h1')), ...join_(iat, at('h2')),
                0x31, 0xdb,
                0x81, 0x3d, ...u32(at('counter')), ...u32(2 * N), ...bitIfEqual(1),
                0x83, 0x3d, ...u32(at('bad')), 0x00, ...bitIfEqual(2),
                ...exitWithBits(iat),
            ],
            worker: [
                0x53, 0x56, //                                      push ebx; push esi
                ...call(iat, 'GetCurrentThreadId'), 0x89, 0xc6, //    mov esi, eax
                0x56, 0xff, 0x35, ...u32(at('slot')), ...call(iat, 'TlsSetValue'),
                0xbb, ...u32(N), //                                 mov ebx, N
                { label: 'L' },
                0x68, ...u32(at('cs')), ...call(iat, 'EnterCriticalSection'),
                0xa1, ...u32(at('counter')), 0x40, 0xa3, ...u32(at('counter')), // a plain add
                0x68, ...u32(at('cs')), ...call(iat, 'LeaveCriticalSection'),
                0xff, 0x35, ...u32(at('slot')), ...call(iat, 'TlsGetValue'),
                0x39, 0xf0, ...markIfNotEqual(at('bad')), //         cmp eax, esi
                0x4b, { jump: 'jnz', to: 'L' }, //                   dec ebx
                0x5e, 0x5b, 0x31, 0xc0, 0xc2, 0x04, 0x00,
            ],
        }));
        await sameOnOneAndThree(executable, {}, 3);
    });

test('the process heap and msvcrt\'s malloc under threads at once',
    { timeout: 120_000 }, async()=>{
        // Two workers each take a block from HeapAlloc and one from malloc N
        // times, write their id at both ends of each, check both, and give them
        // back. A block handed to both at once, or a free that lost a block,
        // shows as another thread's id. Exit: 1 no worker saw one.
        const executable = program({
            'KERNEL32.dll': ['CreateThread', 'WaitForSingleObject', 'ExitProcess',
                'GetProcessHeap', 'HeapAlloc', 'HeapFree', 'GetCurrentThreadId'],
            'msvcrt.dll': ['malloc', 'free'],
        }, {
            bad: u32(0), id1: u32(0), id2: u32(0), h1: u32(0), h2: u32(0),
        }, ({ iat, at, worker })=>({
            main: [
                ...startThread(iat, worker, 0, at('id1'), at('h1')),
                ...startThread(iat, worker, 0, at('id2'), at('h2')),
                ...join_(iat, at('h1')), ...join_(iat, at('h2')),
                0x31, 0xdb,
                0x83, 0x3d, ...u32(at('bad')), 0x00, ...bitIfEqual(1),
                ...exitWithBits(iat),
            ],
            worker: [
                0x53, 0x56, 0x57, 0x55, //                          push ebx, esi, edi, ebp
                ...call(iat, 'GetCurrentThreadId'), 0x89, 0xc6, //    mov esi, eax
                ...call(iat, 'GetProcessHeap'), 0x89, 0xc7, //        mov edi, eax
                0xbd, ...u32(N), //                                 mov ebp, N
                { label: 'L' },
                0x6a, 0x20, 0x6a, 0x00, 0x57, ...call(iat, 'HeapAlloc'), // HeapAlloc(heap, 0, 32)
                0x85, 0xc0, { jump: 'jz', to: 'lost' },
                0x89, 0xc3, //                                      mov ebx, eax
                0x89, 0x30, 0x89, 0x70, 0x1c, // mov [eax], esi; mov [eax+28], esi
                0x6a, 0x18, ...call(iat, 'malloc'), 0x83, 0xc4, 0x04, // malloc(24)
                0x85, 0xc0, { jump: 'jz', to: 'lost' },
                0x89, 0x30, 0x89, 0x70, 0x14, // mov [eax], esi; mov [eax+20], esi
                0x50, //                                            push eax  (free's argument)
                0x39, 0x33, ...markIfNotEqual(at('bad')), //         cmp [ebx], esi
                0x39, 0x73, 0x1c, ...markIfNotEqual(at('bad')), //   cmp [ebx+28], esi
                0x8b, 0x04, 0x24, //                                mov eax, [esp]
                0x39, 0x30, ...markIfNotEqual(at('bad')), //         cmp [eax], esi
                0x39, 0x70, 0x14, ...markIfNotEqual(at('bad')), //   cmp [eax+20], esi
                ...call(iat, 'free'), 0x83, 0xc4, 0x04,
                0x53, 0x6a, 0x00, 0x57, ...call(iat, 'HeapFree'), // HeapFree(heap, 0, block)
                0x4d, { jump: 'jnz', to: 'L' }, //                   dec ebp
                { jump: 'jmp', to: 'done' },
                { label: 'lost' },
                0xc7, 0x05, ...u32(at('bad')), ...u32(1),
                { label: 'done' },
                0x5d, 0x5f, 0x5e, 0x5b, 0x31, 0xc0, 0xc2, 0x04, 0x00,
            ],
        }));
        await sameOnOneAndThree(executable, {}, 1);
    });
