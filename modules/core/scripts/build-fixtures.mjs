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
 * `/Brepro` keeps the output byte-identical from one build to the next. Named
 * fixtures alone are built when names are given. An x86-64 fixture is built
 * for x86_64-pc-windows-msvc against import libraries of its own, at the
 * linker's default base above 4 GiB, which the loader moves below it.
 *
 *     node scripts/build-fixtures.mjs [name...]
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
            'GetModuleHandleA@4', 'GetCurrentProcessId@0',
        ],
    },
    'ADVAPI32.dll': {
        undecorated: [
            'RegOpenKeyExA@20', 'RegQueryValueExA@24', 'RegCreateKeyExA@36', 'RegSetValueExA@24',
            'RegCloseKey@4',
        ],
    },
    'ole32.dll': {
        undecorated: [
            'CoInitialize@4', 'CoUninitialize@0', 'CoRegisterClassObject@20',
            'CoRevokeClassObject@4', 'CoCreateInstance@20', 'CoGetCallContext@8',
            'CoImpersonateClient@0', 'CoRevertToSelf@0', 'CoQueryClientBlanket@28',
            'CoQueryProxyBlanket@32', 'CoCopyProxy@8', 'CoDisconnectObject@8',
            'CoAddRefServerProcess@0', 'CoReleaseServerProcess@0', 'CoGetCurrentProcess@0',
            'CoWaitForMultipleHandles@20', 'CoMarshalHresult@8', 'CoUnmarshalHresult@8',
            'CreateStreamOnHGlobal@12', 'CoMarshalInterface@24', 'CoUnmarshalInterface@12',
            'CoReleaseMarshalData@4', 'CoGetMarshalSizeMax@24', 'CoCreateFreeThreadedMarshaler@8',
            'CoGetStandardMarshal@24', 'CreateErrorInfo@4', 'SetErrorInfo@8', 'GetErrorInfo@8',
            'CoInitializeEx@8', 'CoGetObjectContext@8', 'CoGetContextToken@4',
            'CoGetDefaultContext@12', 'CoGetCurrentLogicalThreadId@4',
            'GetRunningObjectTable@8', 'CreateFileMoniker@8', 'CreateBindCtx@8',
            'MkParseDisplayName@16', 'CoGetObject@16',
        ],
    },
    'OLEAUT32.dll': {
        undecorated: [
            'SysFreeString@4', 'RegisterActiveObject@16', 'RevokeActiveObject@8',
            'GetActiveObject@12',
        ],
    },
    'USER32.dll': {
        undecorated: [
            'GetMessageA@16', 'TranslateMessage@4', 'DispatchMessageA@4', 'PostQuitMessage@4',
            'RegisterClassA@4', 'CreateWindowExA@48', 'DefWindowProcA@16', 'FindWindowA@8',
            'IsWindow@4', 'GetWindowThreadProcessId@8', 'GetWindowTextA@12', 'GetClassNameA@12',
            'PostMessageA@16', 'SendMessageA@16', 'SendMessageTimeoutA@28',
            'RegisterWindowMessageA@4', 'PostThreadMessageA@16', 'PeekMessageA@20',
            'MsgWaitForMultipleObjects@20', 'GetForegroundWindow@0', 'GetActiveWindow@0',
            'SetForegroundWindow@4', 'WindowFromPoint@8', 'EnumWindows@8',
        ],
    },
    'GDI32.dll': {
        undecorated: ['CreateSolidBrush@4'],
    },
    'D3D9.dll': {
        undecorated: ['Direct3DCreate9@4'],
    },
    'd3dx9_26.dll': {
        undecorated: ['D3DXCreateEffect@36'],
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
    { name: 'fpuenv', source: 'fpuenv.c', cxx: false },
    { name: 'com', source: 'com.c', cxx: false },
    { name: 'comlife', source: 'comlife.c', cxx: false },
    { name: 'marshal', source: 'marshal.c', cxx: false },
    { name: 'contexts', source: 'contexts.c', cxx: false },
    { name: 'rot', source: 'rot.c', cxx: false },
    { name: 'activate', source: 'activate.c', cxx: false },
    { name: 'windows', source: 'windows.c', cxx: false },
    { name: 'overlap', source: 'overlap.c', cxx: false },
    { name: 'effect', source: 'effect.c', cxx: false },
    { name: 'hello64', source: 'hello64.c', cxx: false, x64: true },
];

/** The fixtures named on the command line, or every one. */
const named = process.argv.slice(2);
const unknown = named.filter(name=>!PROGRAMS.some(program=>program.name === name));
if (unknown.length > 0)
{
    throw new Error(`no fixture named ${unknown.join(', ')}`);
}
const chosen = named.length > 0 ? PROGRAMS.filter(({ name })=>named.includes(name)) : PROGRAMS;

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
    /** @type {string[]} */
    const libraries64 = [];
    for (const [dll, { undecorated = [], decorated = [] }] of Object.entries(IMPORTS))
    {
        // x64 names carry no stdcall suffix: one convention, undecorated.
        const names64 = [...undecorated, ...decorated].map(name=>name.replace(/@\d+/, ''));
        const base64 = join(work, `${dll}-x64`);
        await writeFile(`${base64}.def`, `LIBRARY ${dll}\nEXPORTS\n${names64.join('\n')}\n`);
        run('llvm-dlltool', ['-m', 'i386:x86-64', '-d', `${base64}.def`, '-l', `${base64}.lib`]);
        libraries64.push(`${base64}.lib`);
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

    for (const { name, source, cxx, x64 } of chosen)
    {
        const object = join(work, `${name}.obj`);
        if (x64)
        {
            run('clang', ['--target=x86_64-pc-windows-msvc', '-O2', '-fms-extensions',
                '-fno-stack-protector', '-mno-stack-arg-probe', '-c', join(SOURCES, source),
                '-o', object]);
            run('lld-link', ['/nologo', '/entry:mainCRTStartup', '/subsystem:console',
                '/nodefaultlib', '/Brepro', `/out:${join(FIXTURES, `${name}.exe`)}`, object,
                ...libraries64]);
            console.log(`test/fixtures/${name}.exe`);
            continue;
        }
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
