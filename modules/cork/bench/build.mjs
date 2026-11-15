/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Builds the benchmark: `bin/bench-x87.exe`, `bin/bench-sse.exe` and
 * `bin/bench-x64.exe` from `src/`, and `bin/peload` and `bin/peload64`, the
 * Linux loaders that run them on the processor itself (`native/peload.c`).
 *
 * The three programs are the same source compiled three ways: 32-bit with x87
 * arithmetic, as the compilers of the era emitted it, 32-bit with scalar SSE2,
 * as later ones did, and x64, whose arithmetic is SSE2 too. None is vectorised,
 * and none links a C runtime: the imports are the ones `src/` names, turned
 * into import libraries here. `/Brepro` keeps the output byte-identical from
 * one build to the next, so the committed executables are what this script
 * makes.
 *
 * Needs clang, lld-link and llvm-dlltool on the PATH.
 *
 *     node modules/cork/bench/build.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SOURCES = join(HERE, 'src');
const BIN = join(HERE, 'bin');

/** What the program imports: stdcall names with their argument bytes, cdecl names bare. */
const IMPORTS = {
    'KERNEL32.dll': [
        'ExitProcess@4', 'GetStdHandle@4', 'WriteFile@20', 'GetCommandLineA@0',
        'GetCurrentThreadId@0', 'GetLastError@0', 'SetLastError@4', 'TlsAlloc@0', 'TlsSetValue@8',
        'TlsGetValue@4', 'InitializeCriticalSection@4', 'EnterCriticalSection@4',
        'LeaveCriticalSection@4', 'InterlockedIncrement@4', 'InterlockedCompareExchange@12',
        'GetTickCount@0', 'QueryPerformanceCounter@4', 'GetProcessHeap@0', 'HeapAlloc@12',
        'HeapFree@12', 'lstrlenA@4', 'MultiByteToWideChar@24',
    ],
    'msvcrt.dll': ['strlen', 'strcmp', 'strcpy', 'sprintf', 'malloc', 'free', 'qsort'],
};

const COMMON = [
    '-O2', '-std=c++17', '-fms-extensions',
    '-fno-exceptions', '-fno-rtti',
    // Every call the source makes is one it spells: no library routine
    // substituted for a loop, and a square root is the instruction.
    '-fno-builtin', '-fno-math-errno',
    // One rounding per operation, on both sides of the comparison with the processor.
    '-ffp-contract=off',
    '-fno-vectorize', '-fno-slp-vectorize',
];

/** Each build: its compiler flags and its width (the import libraries and the link differ). */
const VARIANTS = {
    x87: { flags: ['--target=i686-pc-windows-msvc', '-march=i686', '-mno-sse', '-mfpmath=387'],
        wide: false },
    sse: { flags: ['--target=i686-pc-windows-msvc', '-march=pentium4', '-msse2', '-mfpmath=sse'],
        wide: false },
    x64: { flags: ['--target=x86_64-pc-windows-msvc'], wide: true },
};

/**
 * @param {string} tool
 * @param {string[]} args
 */
const run = (tool, args)=>{
    const result = spawnSync(tool, args, { stdio: 'inherit' });
    if (result.error)
    {
        throw new Error(`${tool} could not be started: ${result.error.message}`);
    }
    if (result.status !== 0)
    {
        throw new Error(`${tool} ${args.join(' ')} failed with ${result.status}`);
    }
};

await mkdir(BIN, { recursive: true });
const work = await mkdtemp(join(tmpdir(), 'cork-bench-'));
try
{
    /** @type {Record<string, string[]>} by width: x64 names carry no stdcall decoration */
    const libraries = { narrow: [], wide: [] };
    for (const [dll, names] of Object.entries(IMPORTS))
    {
        for (const wide of [false, true])
        {
            const base = join(work, `${wide ? 'x64-' : ''}${dll}`);
            const exports = wide ? names.map(name=>name.replace(/@\d+$/, '')) : names;
            await writeFile(`${base}.def`, `LIBRARY ${dll}\nEXPORTS\n${exports.join('\n')}\n`);
            run('llvm-dlltool', ['-m', wide ? 'i386:x86-64' : 'i386', ...wide ? [] : ['-k'],
                '-d', `${base}.def`, '-l', `${base}.lib`]);
            libraries[wide ? 'wide' : 'narrow'].push(`${base}.lib`);
        }
    }
    const sources = (await readdir(SOURCES)).filter(name=>name.endsWith('.cpp')).sort();
    for (const [variant, { flags, wide }] of Object.entries(VARIANTS))
    {
        const objects = sources.map(source=>{
            const object = join(work, `${variant}-${source.replace(/\.cpp$/, '.obj')}`);
            run('clang++', [...COMMON, ...flags, '-c', join(SOURCES, source), '-o', object]);
            return object;
        });
        const out = join(BIN, `bench-${variant}.exe`);
        // Both widths at 0x400000 with no relocations, where each loader maps them.
        run('lld-link', [
            '/nologo', '/entry:mainCRTStartup', '/subsystem:console', '/nodefaultlib',
            ...wide ? ['/machine:x64'] : ['/safeseh:no'], '/fixed', '/base:0x400000', '/Brepro',
            `/out:${out}`, ...objects, ...libraries[wide ? 'wide' : 'narrow'],
        ]);
        console.log(`bin/bench-${variant}.exe`);
    }
    // The loaders sit well above the images they map at 0x400000.
    for (const [name, target] of [['peload', ['--target=i686-linux-gnu', '-mno-sse',
        '-mstackrealign']], ['peload64', ['--target=x86_64-linux-gnu']]])
    {
        run('clang', [
            ...target, '-O2', '-ffreestanding', '-fno-builtin', '-nostdlib', '-static', '-fno-pie',
            '-fuse-ld=lld', '-Wl,--image-base=0x10000000',
            join(HERE, 'native', 'peload.c'), '-o', join(BIN, name),
        ]);
        console.log(`bin/${name}`);
    }
}
finally
{
    await rm(work, { recursive: true, force: true });
}
