/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Builds the benchmark: `bin/bench-x87.exe` and `bin/bench-sse.exe` from
 * `src/`, and `bin/peload`, the Linux loader that runs either on the
 * processor itself (`native/peload.c`).
 *
 * The two programs are the same source compiled two ways: x87 arithmetic, as
 * the compilers of the era emitted it, and scalar SSE2, as later ones did.
 * Neither is vectorised, and neither links a C runtime: the imports are the
 * ones `src/` names, turned into import libraries here. `/Brepro` keeps the
 * output byte-identical from one build to the next, so the committed
 * executables are what this script makes.
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
    '--target=i686-pc-windows-msvc', '-O2', '-std=c++17', '-fms-extensions',
    '-fno-exceptions', '-fno-rtti',
    // Every call the source makes is one it spells: no library routine
    // substituted for a loop, and a square root is the instruction.
    '-fno-builtin', '-fno-math-errno',
    // One rounding per operation, on both sides of the comparison with the processor.
    '-ffp-contract=off',
    '-fno-vectorize', '-fno-slp-vectorize',
];

const VARIANTS = {
    x87: ['-march=i686', '-mno-sse', '-mfpmath=387'],
    sse: ['-march=pentium4', '-msse2', '-mfpmath=sse'],
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
    /** @type {string[]} */
    const libraries = [];
    for (const [dll, names] of Object.entries(IMPORTS))
    {
        const base = join(work, dll);
        await writeFile(`${base}.def`, `LIBRARY ${dll}\nEXPORTS\n${names.join('\n')}\n`);
        run('llvm-dlltool', ['-m', 'i386', '-k', '-d', `${base}.def`, '-l', `${base}.lib`]);
        libraries.push(`${base}.lib`);
    }
    const sources = (await readdir(SOURCES)).filter(name=>name.endsWith('.cpp')).sort();
    for (const [variant, flags] of Object.entries(VARIANTS))
    {
        const objects = sources.map(source=>{
            const object = join(work, `${variant}-${source.replace(/\.cpp$/, '.obj')}`);
            run('clang++', [...COMMON, ...flags, '-c', join(SOURCES, source), '-o', object]);
            return object;
        });
        const out = join(BIN, `bench-${variant}.exe`);
        run('lld-link', [
            '/nologo', '/entry:mainCRTStartup', '/subsystem:console', '/nodefaultlib',
            '/safeseh:no', '/fixed', '/base:0x400000', '/Brepro', `/out:${out}`,
            ...objects, ...libraries,
        ]);
        console.log(`bin/bench-${variant}.exe`);
    }
    // The loader sits well above the images it maps at 0x400000.
    run('clang', [
        '--target=i686-linux-gnu', '-O2', '-ffreestanding', '-fno-builtin', '-nostdlib', '-static',
        '-fno-pie', '-mno-sse', '-mstackrealign', '-fuse-ld=lld', '-Wl,--image-base=0x10000000',
        join(HERE, 'native', 'peload.c'), '-o', join(BIN, 'peload'),
    ]);
    console.log('bin/peload');
}
finally
{
    await rm(work, { recursive: true, force: true });
}
