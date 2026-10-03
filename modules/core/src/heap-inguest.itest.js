/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The heap's small blocks, allocated and freed by the guest itself
 * (`kernel32/guest-heap.js`), called through the imports as a program calls
 * them: HeapAlloc, HeapFree, HeapSize and HeapReAlloc, malloc and its
 * family, and what the host answers about the same blocks -- HeapValidate,
 * HeapSummary, HeapDestroy -- and three threads preempted inside the
 * routines, allocating, filling, checking and freeing.
 *
 * Each program exits 0, or with the number of the first check that failed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { buildExe } from '../../../tools/make-pe.mjs';
import { assemble } from './layers/win32/msvcrt/guest-code.js';

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

const JNE = [0x0f, 0x85];
const JE = [0x0f, 0x84];
const JB = [0x0f, 0x82];
const JMP = [0xe9];

const HEAP_ZERO_MEMORY = 0x8;
const SMALL_CALLS = 10000;

/**
 * The few instructions every program here is written in.
 *
 * @param {{ iat: (name: string) => number, at: (name: string) => number }} context
 */
const toolkit = ({ iat, at })=>({
    /** @param {string} name */
    call: name=>[0xff, 0x15, ...u32(iat(name))],
    /** push offset name @param {string} name */
    push: (name, offset = 0)=>[0x68, ...u32(at(name) + offset)],
    /** push dword [name] @param {string} name */
    pushFrom: (name, offset = 0)=>[0xff, 0x35, ...u32(at(name) + offset)],
    /** @param {number} value */
    pushValue: value=>[0x68, ...u32(value)],
    /** mov [name], eax @param {string} name */
    keep: (name, offset = 0)=>[0xa3, ...u32(at(name) + offset)],
    /** cmp dword [name], value @param {string} name @param {number} value */
    compare: (name, value, offset = 0)=>[0x81, 0x3d, ...u32(at(name) + offset), ...u32(value)],
    /** cmp eax, value @param {number} value */
    is: value=>[0x3d, ...u32(value)],
    /** mov ebx, n: the check that is running, which a failure exits with */
    check: (/** @type {number} */ number)=>[0xbb, ...u32(number)],
    exit: ()=>[0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))],
    /** The shared ending: `fail` exits with the number of the check. */
    fail: ()=>['fail', [0x53, 0xff, 0x15, ...u32(iat('ExitProcess'))]],
});

/**
 * The calls one by one: a block of the process heap sized, validated by the
 * host, grown in place and then past its cell (the host moves it), freed and
 * no longer valid; HEAP_ZERO_MEMORY over a recycled cell; a heap of the
 * program's own that HeapSummary adds up and HeapDestroy takes whole; the C
 * runtime's family; and ten thousand pairs of HeapAlloc and HeapFree. HeapWalk
 * ends its walk at once, as it does over the host's blocks.
 */
function buildCallsExe(){
    return buildExe({
        imports: {
            'KERNEL32.dll': ['GetProcessHeap', 'HeapAlloc', 'HeapFree', 'HeapSize',
                'HeapReAlloc', 'HeapValidate', 'HeapCreate', 'HeapDestroy', 'HeapSummary',
                'HeapWalk', 'GetLastError', 'ExitProcess'],
            'msvcrt.dll': ['malloc', 'free', 'calloc', 'realloc', '_msize'],
        },
        data: { heap: [0, 0, 0, 0], p: [0, 0, 0, 0], q: [0, 0, 0, 0], own: [0, 0, 0, 0],
            summary: [20, 0, 0, 0, ...new Array(16).fill(0)], entry: new Array(28).fill(0) },
        codeSize: 0x800,
        code: context=>{
            const { call, push, pushFrom, pushValue, keep, compare, is, check, exit, fail } =
                toolkit(context);
            const at = context.at;
            /** fill [name] with `byte` for `count` bytes: the block, as a program writes it */
            const fill = (/** @type {string} */ name, /** @type {number} */ byte,
                /** @type {number} */ count)=>[
                [0x8b, 0x3d, ...u32(at(name))],                        // mov edi, [name]
                [0xb9, ...u32(count), 0xb0, byte, 0xf3, 0xaa],         // ecx; al; rep stosb
            ];
            /** ZF: every byte of [name] for `count` is `byte` */
            const all = (/** @type {string} */ name, /** @type {number} */ byte,
                /** @type {number} */ count)=>[
                [0x8b, 0x3d, ...u32(at(name))],                        // mov edi, [name]
                [0xb9, ...u32(count), 0xb0, byte, 0xf3, 0xae],         // ecx; al; repe scasb
            ];
            return [...assemble([
                call('GetProcessHeap'), keep('heap'),
                check(1), pushValue(100), pushValue(0), pushFrom('heap'), call('HeapAlloc'),
                keep('p'), [0xa8, 0x07], { jump: JNE, to: 'fail' },    // test al, 7
                [0x85, 0xc0], { jump: JE, to: 'fail' },
                check(2), pushFrom('p'), pushValue(0), pushFrom('heap'), call('HeapSize'),
                is(100), { jump: JNE, to: 'fail' },
                check(3), pushFrom('p'), pushValue(0), pushFrom('heap'), call('HeapValidate'),
                is(1), { jump: JNE, to: 'fail' },
                ...fill('p', 0x5a, 100),
                check(4), pushValue(104), pushFrom('p'), pushValue(0), pushFrom('heap'),
                call('HeapReAlloc'), [0x3b, 0x05, ...u32(at('p'))], { jump: JNE, to: 'fail' },
                pushFrom('p'), pushValue(0), pushFrom('heap'), call('HeapSize'),
                is(104), { jump: JNE, to: 'fail' },
                check(5), ...all('p', 0x5a, 100), { jump: JNE, to: 'fail' },
                check(6), pushValue(2000), pushFrom('p'), pushValue(0), pushFrom('heap'),
                call('HeapReAlloc'), keep('q'), [0x85, 0xc0], { jump: JE, to: 'fail' },
                ...all('q', 0x5a, 100), { jump: JNE, to: 'fail' },
                pushFrom('q'), pushValue(0), pushFrom('heap'), call('HeapSize'),
                is(2000), { jump: JNE, to: 'fail' },
                check(7), pushFrom('q'), pushValue(0), pushFrom('heap'), call('HeapFree'),
                is(1), { jump: JNE, to: 'fail' },
                pushFrom('q'), pushValue(0), pushFrom('heap'), call('HeapValidate'),
                is(0), { jump: JNE, to: 'fail' },
                // A recycled cell, dirtied, handed out again zeroed.
                check(8), pushValue(64), pushValue(0), pushFrom('heap'), call('HeapAlloc'),
                keep('p'), ...fill('p', 0xff, 64),
                pushFrom('p'), pushValue(0), pushFrom('heap'), call('HeapFree'),
                pushValue(64), pushValue(HEAP_ZERO_MEMORY), pushFrom('heap'), call('HeapAlloc'),
                keep('q'), ...all('q', 0, 64), { jump: JNE, to: 'fail' },
                // A heap of the program's own.
                check(9), pushValue(0), pushValue(0), pushValue(0), call('HeapCreate'),
                keep('own'), [0x66, 0x85, 0xc0], { jump: JNE, to: 'fail' },  // test ax, ax
                [0x85, 0xc0], { jump: JE, to: 'fail' },
                [0xbe, ...u32(200)],                                    // mov esi, 200
                'blocks',
                pushValue(24), pushValue(0), pushFrom('own'), call('HeapAlloc'),
                [0x85, 0xc0], { jump: JE, to: 'fail' },
                [0x4e], { jump: JNE, to: 'blocks' },                    // dec esi
                check(10), push('summary'), pushValue(0), pushFrom('own'), call('HeapSummary'),
                is(1), { jump: JNE, to: 'fail' },
                compare('summary', 200 * 24, 4), { jump: JNE, to: 'fail' },
                // HeapWalk hands out the guest's blocks as it does the host's: none.
                check(17), push('entry'), pushFrom('own'), call('HeapWalk'),
                is(0), { jump: JNE, to: 'fail' },
                call('GetLastError'), is(259), { jump: JNE, to: 'fail' },
                check(11), pushFrom('own'), call('HeapDestroy'), is(1), { jump: JNE, to: 'fail' },
                pushValue(0), pushValue(0), pushFrom('own'), call('HeapValidate'),
                is(0), { jump: JNE, to: 'fail' },
                // The C runtime's.
                check(12), pushValue(30), call('malloc'), [0x83, 0xc4, 0x04], keep('p'),
                [0x85, 0xc0], { jump: JE, to: 'fail' },
                pushFrom('p'), call('_msize'), [0x83, 0xc4, 0x04],
                is(30), { jump: JNE, to: 'fail' },
                check(13), pushValue(31), pushFrom('p'), call('realloc'), [0x83, 0xc4, 0x08],
                [0x3b, 0x05, ...u32(at('p'))], { jump: JNE, to: 'fail' },
                pushFrom('p'), call('_msize'), [0x83, 0xc4, 0x04],
                is(31), { jump: JNE, to: 'fail' },
                check(14), pushValue(25), pushValue(4), call('calloc'), [0x83, 0xc4, 0x08],
                keep('q'), ...all('q', 0, 100), { jump: JNE, to: 'fail' },
                // Another heap's block: the process heap does not take it.
                check(15), pushFrom('p'), pushValue(0), pushFrom('heap'), call('HeapFree'),
                is(0), { jump: JNE, to: 'fail' },
                pushFrom('p'), call('free'), [0x83, 0xc4, 0x04],
                pushFrom('q'), call('free'), [0x83, 0xc4, 0x04],
                pushValue(0), call('free'), [0x83, 0xc4, 0x04],
                check(16), [0xbe, ...u32(SMALL_CALLS)],                  // mov esi, n
                'pairs',
                pushValue(32), pushValue(0), pushFrom('heap'), call('HeapAlloc'),
                [0x85, 0xc0], { jump: JE, to: 'fail' },
                [0x50], pushValue(0), pushFrom('heap'), call('HeapFree'),      // push eax
                is(1), { jump: JNE, to: 'fail' },
                [0x4e], { jump: JNE, to: 'pairs' },
                exit(),
                ...fail(),
            ])];
        },
    });
}

const WORKERS = 3;
const TURNS = 60;
const BLOCKS = 8;

/**
 * Three threads, each turn allocating eight blocks of sizes that move with
 * the turn -- from the process heap and from malloc in turn -- filling each
 * with the thread's own byte, then checking every byte and each block's size
 * and freeing them, preempted wherever the quantum ends. A block two threads
 * were both handed shows as a byte of the other's; any failure sets `bad`.
 */
function buildRaceExe(){
    return buildExe({
        imports: {
            'KERNEL32.dll': ['GetProcessHeap', 'HeapAlloc', 'HeapFree', 'HeapSize',
                'CreateThread', 'ExitThread', 'WaitForMultipleObjects', 'ExitProcess'],
            'msvcrt.dll': ['malloc', 'free', '_msize'],
        },
        data: { heap: [0, 0, 0, 0], bad: [0, 0, 0, 0], handles: new Array(16).fill(0),
            slots: new Array(WORKERS * 0x100).fill(0) },
        codeSize: 0x400,
        code: context=>{
            const { call, push, pushFrom, pushValue, keep, compare, check, exit, fail } =
                toolkit(context);
            const at = context.at;
            const worker = context.code(0x100);
            const main = assemble([
                call('GetProcessHeap'), keep('heap'),
                ...[0, 1, 2].flatMap(index=>[
                    // CreateThread(NULL, 0, worker, index, 0, NULL)
                    [0x6a, 0x00, 0x6a, 0x00, 0x6a, index, 0x68, ...u32(worker), 0x6a, 0x00,
                        0x6a, 0x00],
                    call('CreateThread'), keep('handles', index * 4),
                ]),
                [0x6a, 0xff, 0x6a, 0x01], push('handles'), [0x6a, WORKERS],
                call('WaitForMultipleObjects'),
                check(1), compare('bad', 0), { jump: JNE, to: 'fail' },
                exit(),
                ...fail(),
            ]);
            // ESI the block's number, EDI the thread's slots: pointers, then sizes,
            // then the turns left; EBX the thread's byte.
            const body = assemble([
                [0x8b, 0x5c, 0x24, 0x04],                               // mov ebx, [esp + 4]
                [0x69, 0xfb, ...u32(0x100)],                            // imul edi, ebx, 0x100
                [0x81, 0xc7, ...u32(at('slots'))],                      // add edi, slots
                [0x43],                                                 // inc ebx
                [0xc7, 0x47, 0x40, ...u32(TURNS)],                      // mov [edi + 64], turns
                'turn',
                [0x31, 0xf6],                                           // xor esi, esi
                'allocate',
                // size = (turns * 7 + esi * 13 + ebx * 5) % 200 + 1
                [0x6b, 0x47, 0x40, 0x07],                               // imul eax, [edi+64], 7
                [0x6b, 0xce, 0x0d, 0x01, 0xc8],                         // imul ecx, esi, 13; add
                [0x6b, 0xcb, 0x05, 0x01, 0xc8],                         // imul ecx, ebx, 5; add
                [0x31, 0xd2, 0xb9, ...u32(200), 0xf7, 0xf1, 0x42],      // edx = eax % 200 + 1
                [0x89, 0x54, 0xb7, 0x20],                               // mov [edi+esi*4+32], edx
                [0xf7, 0xc6, ...u32(1)], { jump: JE, to: 'fromHeap' },  // test esi, 1
                [0x52], call('malloc'), [0x83, 0xc4, 0x04],             // malloc(size)
                { jump: JMP, to: 'got' },
                'fromHeap',
                [0x52], pushValue(0), pushFrom('heap'), call('HeapAlloc'),
                'got',
                [0x85, 0xc0], { jump: JE, to: 'bad' },
                [0x89, 0x04, 0xb7],                                     // mov [edi + esi*4], eax
                [0x57, 0x8b, 0x4c, 0xb7, 0x20, 0x89, 0xc7],             // push edi; ecx; edi=eax
                [0x88, 0xd8, 0xf3, 0xaa, 0x5f],                         // al=bl; rep stosb; pop
                [0x46, 0x83, 0xfe, BLOCKS], { jump: JB, to: 'allocate' },
                [0x31, 0xf6],                                           // xor esi, esi
                'check',
                [0x57, 0x8b, 0x4c, 0xb7, 0x20, 0x8b, 0x3c, 0xb7],       // push edi; ecx; edi=p
                [0x88, 0xd8, 0xf3, 0xae, 0x5f],                         // al=bl; repe scasb; pop
                { jump: JNE, to: 'bad' },
                [0xf7, 0xc6, ...u32(1)], { jump: JE, to: 'heapBlock' },
                [0xff, 0x34, 0xb7], call('_msize'), [0x83, 0xc4, 0x04], // _msize(p)
                [0x3b, 0x44, 0xb7, 0x20], { jump: JNE, to: 'bad' },
                [0xff, 0x34, 0xb7], call('free'), [0x83, 0xc4, 0x04],
                { jump: JMP, to: 'next' },
                'heapBlock',
                [0xff, 0x34, 0xb7], pushValue(0), pushFrom('heap'), call('HeapSize'),
                [0x3b, 0x44, 0xb7, 0x20], { jump: JNE, to: 'bad' },
                [0xff, 0x34, 0xb7], pushValue(0), pushFrom('heap'), call('HeapFree'),
                [0x83, 0xf8, 0x01], { jump: JNE, to: 'bad' },
                'next',
                [0x46, 0x83, 0xfe, BLOCKS], { jump: JB, to: 'check' },
                [0xff, 0x4f, 0x40], { jump: JNE, to: 'turn' },          // dec dword [edi + 64]
                [0x6a, 0x00], call('ExitThread'),
                'bad',
                [0xc7, 0x05, ...u32(at('bad')), ...u32(1)],
                [0x6a, 0x00], call('ExitThread'),
            ]);
            assert.ok(main.length <= 0x100, `main is ${main.length} bytes`);
            return [...main, ...new Array(0x100 - main.length).fill(0x90), ...body];
        },
    });
}

/**
 * Runs a program to its exit, and reads before the machine goes what crossed
 * into the host.
 *
 * @param {Uint8Array} executable @param {number} [quantum]
 */
async function run(executable, quantum){
    const app = await createApp({
        executable,
        quantum,
    });
    try
    {
        const code = await app.run({ timeoutMs: 30000 });
        const bridge = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'bridge');
        return {
            code,
            /** @type {Record<string, number>} */
            crossed: Object.fromEntries(bridge?.metrics?.hot ?? []),
        };
    }
    finally
    {
        await app.dispose();
    }
}

test(`the heap calls answer in the guest as the host answers them`,
    { timeout: 60000 }, async()=>{
        const { code, crossed } = await run(buildCallsExe());
        assert.equal(code, 0, 'the number of the first check that failed');
        const handed = (crossed['<heap-alloc>'] ?? 0) + (crossed['<heap-free>'] ?? 0);
        assert.ok(handed < 50, `${handed} of ${2 * SMALL_CALLS} and more HeapAlloc and`
            + ` HeapFree calls crossed: ${JSON.stringify(crossed)}`);
    });

test(`three preempted threads allocate, fill, check and free`,
    { timeout: 60000 }, async()=>{
        const { code, crossed } = await run(buildRaceExe(), 97);
        assert.equal(code, 0, 'a block two threads shared, a size wrong, or a free refused');
        console.log(`heap race: host crossings ${JSON.stringify(
            Object.fromEntries(Object.entries(crossed).filter(([name])=>name.startsWith('<')
                && /heap|malloc|free|size/.test(name))))}`);
    });
