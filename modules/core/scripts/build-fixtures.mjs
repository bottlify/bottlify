/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds the compiled fixtures under test/fixtures from their sources in
 * test/fixtures/src.
 *
 * These are the programs whose shape only a compiler produces -- exception
 * tables, funclets, the frames `__try` and `try` push -- so they are compiled
 * rather than assembled by hand. The compiler is clang targeting the MSVC ABI
 * and the linker is lld: the tables they emit are the ones the Windows C
 * runtime reads, and neither needs Microsoft's own toolchain or libraries.
 * Nothing links a C runtime; the imports each program makes are listed below
 * and turned into import libraries here, so a fixture calls exactly what it
 * names.
 *
 * The executables are committed, so a test run needs none of this: run it
 * after changing a source, with clang, lld-link and llvm-dlltool on the PATH.
 * `/Brepro` keeps the output byte-identical from one build to the next.
 *
 *     node scripts/build-fixtures.mjs
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURES = join(ROOT, 'test', 'fixtures');
const SOURCES = join(FIXTURES, 'src');

/**
 * What the fixtures import, per library. A name ending in `@N` is stdcall and
 * is imported undecorated, as the system's own libraries export it, unless it
 * is listed under `decorated` -- the runtime exports a few with the suffix. A
 * name marked DATA is a variable, imported through its address.
 */
const IMPORTS = {
    'KERNEL32.dll': {
        undecorated: [
            'ExitProcess@4', 'GetStdHandle@4', 'WriteFile@20', 'RaiseException@16',
            'CreateThread@24', 'WaitForSingleObject@8', 'Sleep@4', 'QueueUserAPC@12',
            'SleepEx@8', 'WaitForSingleObjectEx@12', 'CreateEventA@16', 'SetEvent@4',
            'CreateWaitableTimerA@12', 'SetWaitableTimer@24', 'GetCurrentThreadId@0',
            'GetCurrentThread@0', 'GetSystemInfo@4', 'IsProcessorFeaturePresent@4', 'GetVersion@0',
            'VirtualAlloc@16', 'VirtualFree@12', 'GetLastError@0', 'SetLastError@4',
            'CreateProcessA@40', 'GetExitCodeProcess@8', 'CloseHandle@4', 'CreateFileA@28',
            'ReadFile@20', 'GetCommandLineA@0', 'WaitForMultipleObjects@16',
        ],
    },
    'ADVAPI32.dll': {
        undecorated: [
            'RegOpenKeyExA@20', 'RegQueryValueExA@24', 'RegCreateKeyExA@36', 'RegSetValueExA@24',
            'RegCloseKey@4',
        ],
    },
    'msvcrt.dll': {
        undecorated: [
            '__CxxFrameHandler3', '_CxxThrowException@8', '_except_handler3', 'qsort',
            '??3@YAXPAX@Z', '_setjmp3', 'longjmp', 'fprintf', 'fwrite', 'fread', '__iob_func',
            '_iob DATA', '_osver DATA', '_winver DATA', '_winmajor DATA', '_winminor DATA',
            '_HUGE DATA', '_environ DATA',
        ],
        decorated: ['_seh_longjmp_unwind@4'],
    },
};

/** Each fixture: its source, and whether it is C++. */
const PROGRAMS = [
    { name: 'seh', source: 'seh.c', cxx: false },
    { name: 'cxxeh', source: 'cxxeh.cpp', cxx: true },
    { name: 'unhandled', source: 'unhandled.cpp', cxx: true },
    { name: 'apc', source: 'apc.c', cxx: false },
    { name: 'processor', source: 'processor.c', cxx: false },
    { name: 'crtdata', source: 'crtdata.c', cxx: false },
    { name: 'virtual', source: 'virtual.c', cxx: false },
    { name: 'spawn', source: 'spawn.c', cxx: false },
    { name: 'spawn_child', source: 'spawn_child.c', cxx: false },
];

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

const work = await mkdtemp(join(tmpdir(), 'bottlify-fixtures-'));
try
{
    /** @type {string[]} */
    const libraries = [];
    for (const [dll, { undecorated = [], decorated = [] }] of Object.entries(IMPORTS))
    {
        for (const [kind, names, kill] of /** @type {const} */ ([
            ['undecorated', undecorated, true], ['decorated', decorated, false],
        ]))
        {
            if (names.length === 0)
            {
                continue;
            }
            const base = join(work, `${dll}-${kind}`);
            await writeFile(`${base}.def`, `LIBRARY ${dll}\nEXPORTS\n${names.join('\n')}\n`);
            run('llvm-dlltool', ['-m', 'i386', ...kill ? ['-k'] : [], '-d', `${base}.def`,
                '-l', `${base}.lib`]);
            libraries.push(`${base}.lib`);
        }
    }

    const support = join(work, 'support.obj');
    run('clang', ['--target=i686-pc-windows-msvc', '-c', join(SOURCES, 'support.c'),
        '-o', support]);

    for (const { name, source, cxx } of PROGRAMS)
    {
        const object = join(work, `${name}.obj`);
        run('clang', [
            '--target=i686-pc-windows-msvc', '-O1', '-fms-extensions',
            ...cxx ? ['-fexceptions', '-fcxx-exceptions', '-fno-rtti'] : [],
            '-c', join(SOURCES, source), '-o', object,
        ]);
        run('lld-link', [
            '/nologo', '/entry:mainCRTStartup', '/subsystem:console', '/nodefaultlib',
            '/safeseh:no', '/fixed', '/base:0x400000', '/Brepro',
            `/out:${join(FIXTURES, `${name}.exe`)}`, object, support, ...libraries,
        ]);
        console.log(`test/fixtures/${name}.exe`);
    }
}
finally
{
    await rm(work, { recursive: true, force: true });
}
