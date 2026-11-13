/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A process's memory holds what the program has been given, and grows as it is
 * given more (`engineAreaFor`, the cpu layer's `growTo`): a program that commits
 * half a gigabyte has a memory of that order, not the whole RAM it may reach.
 * A memory of 4 GiB is a 64-bit Windows's: it gives a program linked
 * /LARGEADDRESSAWARE addresses past 2 GiB under WOW64, and any other program none;
 * on a machine named 32-bit, none at all.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from './app.js';
import { assemble, buildExe } from '../../../tools/make-pe.mjs';

/** @param {number} value @returns {number[]} */
const u32 = value=>[
    value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff,
];
const MIB = 1 << 20;
const MEM_COMMIT_RESERVE = 0x3000;
const PAGE_READWRITE = 4;
const imports = { 'KERNEL32.dll': ['VirtualAlloc', 'ExitProcess'] };

/**
 * The memories the run makes that may hold its whole RAM: the processes'.
 *
 * @param {import('node:test').TestContext} t @param {number} ram
 * @returns {WebAssembly.Memory[]}
 */
function watchMemories(t, ram){
    const Made = WebAssembly.Memory;
    /** @type {WebAssembly.Memory[]} */
    const made = [];
    WebAssembly.Memory = /** @type {any} */ (function(/** @type {any} */ descriptor){
        const memory = new Made(descriptor);
        if ((descriptor.maximum ?? descriptor.initial) * 65536 >= ram)
        {
            made.push(memory);
        }
        return memory;
    });
    WebAssembly.Memory.prototype = Made.prototype;
    t.after(()=>{
        WebAssembly.Memory = Made;
    });
    return made;
}

/**
 * VirtualAlloc(address, size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE) into eax,
 * to `fail` where it answers NULL.
 *
 * @param {(name: string) => number} iat @param {number} address @param {number} size
 */
const commit = (iat, address, size)=>[
    0x6a, PAGE_READWRITE, 0x68, ...u32(MEM_COMMIT_RESERVE), 0x68, ...u32(size),
    0x68, ...u32(address), 0xff, 0x15, ...u32(iat('VirtualAlloc')),
    0x85, 0xc0, { jump: /** @type {const} */ ('jz'), to: 'fail' },
];

/** @param {(name: string) => number} iat @returns {import('../../../tools/make-pe.mjs').AsmPart[]} */
const failing = iat=>[{ label: 'fail' }, 0x6a, 7, 0xff, 0x15, ...u32(iat('ExitProcess'))];

test('a process\'s memory holds what the program commits, not its whole RAM',
    { timeout: 120_000 }, async t=>{
        const ram = 2 ** 31;
        const made = watchMemories(t, ram);
        // Eight commits of 64 MiB, the last byte of each written; exit 0.
        const executable = buildExe({ imports, codeSize: 0x100, code: ({ iat })=>assemble([
            0xbe, ...u32(8), //                                  mov esi, 8
            { label: 'next' },
            ...commit(iat, 0, 64 * MIB),
            0xc6, 0x80, ...u32(64 * MIB - 1), 1, //              mov byte [eax + 64 MiB - 1], 1
            0x4e, { jump: 'jnz', to: 'next' }, //               dec esi; jnz next
            0x6a, 0, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ...failing(iat),
        ]) });
        const app = await createApp({ executable, imagePath: 'C:\\App\\commit.exe',
            memorySize: ram });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 60_000 }), 0, 'every commit given and written');
        assert.equal(made.length, 1);
        const held = made[0].buffer.byteLength;
        assert.ok(held >= 512 * MIB, `the memory grew to hold what was committed: ${held}`);
        assert.ok(held < ram, `and no further than that: ${held} of ${ram}`);
    });

/**
 * A program that commits a page at 0x90000000, writes a dword there and exits
 * with what it reads back; 7 where the commit is refused.
 *
 * @param {boolean} largeAddressAware
 */
const highCommit = largeAddressAware=>buildExe({ imports, largeAddressAware, codeSize: 0x80,
    code: ({ iat })=>assemble([
        ...commit(iat, 0x90000000, 0x10000),
        0xc7, 0x00, ...u32(0x12345678), //                       mov dword [eax], 0x12345678
        0x8b, 0x18, 0x53, //                                     mov ebx, [eax]; push ebx
        0xff, 0x15, ...u32(iat('ExitProcess')),
        ...failing(iat),
    ]) });

test('a memory of 4 GiB is a 64-bit Windows: a large-address-aware program past 2 GiB, only it',
    { timeout: 120_000 }, async t=>{
        const ram = 2 ** 32;
        watchMemories(t, ram);
        const aware = await createApp({ executable: highCommit(true),
            imagePath: 'C:\\App\\aware.exe', memorySize: ram });
        t.after(()=>aware.dispose());
        assert.equal(await aware.run({ timeoutMs: 60_000 }), 0x12345678,
            'the page at 0x90000000 committed, written and read');
        await aware.dispose();

        const plain = await createApp({ executable: highCommit(false),
            imagePath: 'C:\\App\\plain.exe', memorySize: ram });
        t.after(()=>plain.dispose());
        assert.equal(await plain.run({ timeoutMs: 60_000 }), 7,
            'a program not linked for it is refused the address');
        await plain.dispose();

        const narrow = await createApp({ executable: highCommit(true),
            imagePath: 'C:\\App\\aware.exe', memorySize: ram, machine: 'x86' });
        t.after(()=>narrow.dispose());
        assert.equal(await narrow.run({ timeoutMs: 60_000 }), 7,
            'a 32-bit Windows gives none, whatever the program is linked for');
    });

test('a memory grown whole keeps the shared page past the heap\'s end, where it is its own',
    { timeout: 120_000 }, async t=>{
        const ram = 2 ** 28;
        const made = watchMemories(t, ram);
        // 32 MiB committed, the last byte written: the memory grows to the whole
        // 256 MiB, and the shared page to 0x0FFE0000, past the heap's span.
        const executable = buildExe({ imports, codeSize: 0x80, code: ({ iat })=>assemble([
            ...commit(iat, 0, 32 * MIB),
            0xc6, 0x80, ...u32(32 * MIB - 1), 1, //              mov byte [eax + 32 MiB - 1], 1
            0xa1, ...u32(0x7ffe026c), //                         mov eax, [NtMajorVersion]
            0x50, 0xff, 0x15, ...u32(iat('ExitProcess')), //    push eax; ExitProcess
            ...failing(iat),
        ]) });
        const app = await createApp({ executable, imagePath: 'C:\\App\\whole.exe',
            memorySize: ram });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 60_000 }), 5,
            'committed, and the shared page read where it moved: Windows XP is NT 5');
        assert.equal(made.length, 1);
        assert.equal(made[0].buffer.byteLength >= ram, true, 'grown to the whole RAM');
    });

for (const cores of [1, 8])
{
    test(`nothing the program commits holds the shared page, which moves up past it as the`
    + ` memory grows (${cores} executor${cores > 1 ? 's' : ''})`, { timeout: 300_000 }, async t=>{
        const ram = 2 ** 31;
        watchMemories(t, ram);
        const span = 640 * MIB;
        const piece = 0x10000;
        // A gigabyte reserved, which reaches over every place the page is kept at
        // as the memory grows (0x0FFE0000, 0x1FFE0000, 0x3FFE0000), committed 64 KiB
        // at a time, each piece's first and last dword its own address; then every
        // mark read back and NtMajorVersion read at 0x7FFE0000: the page's clocks
        // over a piece would have written its first dword, a piece over the page
        // its version. 9 where a mark is not the piece's, 7 where a commit fails.
        const executable = buildExe({ imports, codeSize: 0x100, code: ({ iat })=>assemble([
            0x6a, PAGE_READWRITE, 0x68, ...u32(0x2000), 0x68, ...u32(1024 * MIB), 0x6a, 0,
            0xff, 0x15, ...u32(iat('VirtualAlloc')), //              reserve 1 GiB anywhere
            0x85, 0xc0, { jump: 'jz', to: 'fail' },
            0x89, 0xc7, //                                           mov edi, eax
            0x31, 0xf6, //                                           xor esi, esi
            { label: 'commit' },
            0x8d, 0x1c, 0x37, //                                     lea ebx, [edi + esi]
            0x6a, PAGE_READWRITE, 0x68, ...u32(0x1000), 0x68, ...u32(piece), 0x53,
            0xff, 0x15, ...u32(iat('VirtualAlloc')), //              commit the piece at ebx
            0x85, 0xc0, { jump: 'jz', to: 'fail' },
            0x89, 0x1b, //                                           mov [ebx], ebx
            0x89, 0x9b, ...u32(piece - 4), //                        mov [ebx + piece - 4], ebx
            0x81, 0xc6, ...u32(piece), //                            add esi, piece
            0x81, 0xfe, ...u32(span), //                             cmp esi, span
            { jump: 'jb', to: 'commit' },
            0x31, 0xf6, //                                           xor esi, esi
            { label: 'check' },
            0x8d, 0x1c, 0x37, //                                     lea ebx, [edi + esi]
            0x39, 0x1b, { jump: 'jnz', to: 'moved' }, //             cmp [ebx], ebx
            0x39, 0x9b, ...u32(piece - 4), { jump: 'jnz', to: 'moved' },
            0x81, 0xc6, ...u32(piece), 0x81, 0xfe, ...u32(span), { jump: 'jb', to: 'check' },
            0xa1, ...u32(0x7ffe026c), //                             mov eax, [NtMajorVersion]
            0x50, 0xff, 0x15, ...u32(iat('ExitProcess')),
            { label: 'moved' }, 0x6a, 9, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ...failing(iat),
        ]) });
        const app = await createApp({ executable, imagePath: 'C:\\App\\span.exe', memorySize: ram,
            cpu: { cores } });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 240_000 }), 5,
            'every piece kept its marks, and the page its version: Windows XP is NT 5');
    });
}

for (const eager of [false, true])
{
    test('a process run on eight executors starts with a memory of what it holds, not its whole'
        + ' RAM: the other executors\' pages cut out of the heap and reached as one opens ('
        + `${eager ? 'all of them, at its start' : 'none, a program of one thread'})`,
    { timeout: 120_000 }, async t=>{
        const ram = 2 ** 31;
        const made = watchMemories(t, ram);
        const executable = buildExe({ imports, codeSize: 0x80, code: ({ iat })=>assemble([
            ...commit(iat, 0, 32 * MIB),
            0xc6, 0x80, ...u32(32 * MIB - 1), 1, //              mov byte [eax + 32 MiB - 1], 1
            0x6a, 0, 0xff, 0x15, ...u32(iat('ExitProcess')),
            ...failing(iat),
        ]) });
        const app = await createApp({ executable, imagePath: 'C:\\App\\eight.exe',
            memorySize: ram, cpu: { cores: 8, eager } });
        t.after(()=>app.dispose());
        assert.equal(await app.run({ timeoutMs: 60_000 }), 0, 'committed and written');
        assert.equal(made.length, 1);
        const bytes = made[0].buffer.byteLength;
        if (eager)
        {
            // Every executor's pages, cut out at 0x14000000: under 512 MiB.
            assert.ok(bytes < 512 * MIB, `the executors' pages and no more: ${bytes}`);
        }
        else
        {
            // What one executor's holds: the RAM up to the system's shared page
            // past the stacks, 256 MiB, and the engine's slack -- where every
            // process on eight executors started at 512 MiB.
            assert.ok(bytes <= 256 * MIB + 0x20000, `as one executor's: ${bytes}`);
        }
    });
}
