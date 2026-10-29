/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Runs the real Visual C++ runtimes' own load checks in the engine, one
 * deployment layout at a time, and says where each lets a program run.
 *
 * A Visual C++ 2005 or 2008 runtime checks, in its DllMain, that it was
 * loaded through an activation context: it looks itself up with
 * FindActCtxSectionStringW and, found, wants to be in WinSxS or beside its
 * assembly's manifest; otherwise the program stops with R6034. The check is
 * the runtime's own code, so the only way to know what it decides under the
 * engine's activation contexts is to run it. The tool fetches Microsoft's
 * redistributables (Visual C++ 2005 SP1 and 2008 SP1, x86), unpacks the
 * runtimes and their assembly manifests with the engine's own cabinet and
 * installer-database readers, builds a small program per layout
 * (`make-pe.mjs`), and runs each in a child node process, as
 * `wine-tests.mjs` runs a test.
 *
 * What a layout is checked against is what Windows does with it: a runtime
 * with its assembly's manifest beside it, in its own folder, named by the
 * program's embedded or external manifest, or installed in the store, runs;
 * one with no manifest naming it is R6034. msvcr80.dll itself is always the
 * engine's own (`win32` `runtimes()`), so its rows say so rather than
 * running Microsoft's copy; vcomp.dll (OpenMP 8) and msvcr90.dll (CRT 9) are
 * Microsoft's.
 *
 * The redistributables stay local, like winetest.exe: they are fetched into
 * `to_install/vcredist/` and nothing of them goes into the repository. With
 * them absent the tool says every row is not measured.
 *
 *     node tools/vcredist-matrix.mjs --fetch      download and unpack, then run
 *     node tools/vcredist-matrix.mjs              run what is unpacked
 *     node tools/vcredist-matrix.mjs --out <dir>  where report.json and report.md go
 */

import { fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { buildExe } from './make-pe.mjs';

const ROOT = new URL('../', import.meta.url);
const LOCAL = new URL('to_install/vcredist/', ROOT);

/** Microsoft's x86 redistributables: 2005 SP1 (8.0.50727.6195) and 2008 SP1 (9.0.30729.6161). */
export const REDISTRIBUTABLES = {
    vc80: 'https://download.microsoft.com/download/8/B/4/8B42259F-5D70-43F4-AC2E-4B208FD8D66A/'
        + 'vcredist_x86.EXE',
    vc90: 'https://download.microsoft.com/download/5/D/8/5D8C65CB-C849-4025-8E95-C3966CAFD8AE/'
        + 'vcredist_x86.exe',
};

const TOKEN = '1fc8b3b9a1e18e3b';

/**
 * The runtimes measured: the assembly, the DLL that checks itself, and an
 * export a program imports from it.
 */
const RUNTIMES = [
    { key: 'vc80-openmp', assembly: 'Microsoft.VC80.OpenMP', version: '8.0.50727.6195',
        dll: 'vcomp.dll', export: 'omp_get_max_threads', engine: false },
    { key: 'vc90-crt', assembly: 'Microsoft.VC90.CRT', version: '9.0.30729.6161',
        dll: 'msvcr90.dll', export: '_errno', engine: false },
    { key: 'vc80-crt', assembly: 'Microsoft.VC80.CRT', version: '8.0.50727.6195',
        dll: 'msvcr80.dll', export: '_errno', engine: true },
];

/**
 * The cabinets an IExpress self-extractor carries: each `MSCF` header whose
 * size field fits in the file.
 *
 * @param {Uint8Array} bytes
 */
function embeddedCabinets(bytes){
    /** @type {Uint8Array[]} */
    const found = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let at = 0; at + 36 < bytes.length; at++)
    {
        if (bytes[at] === 0x4d && bytes[at + 1] === 0x53 && bytes[at + 2] === 0x43
            && bytes[at + 3] === 0x46 && view.getUint32(at + 4, true) === 0)
        {
            const size = view.getUint32(at + 8, true);
            if (size > 36 && at + size <= bytes.length)
            {
                found.push(bytes.subarray(at, at + size));
                at += size - 1;
            }
        }
    }
    return found;
}

/**
 * Every file a cabinet holds, by its name.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<Map<string, Uint8Array>>}
 */
async function cabinetFiles(bytes){
    const { readCabinet, decodeFolder } = await import(
        '../modules/core/src/layers/win32/cabinet/cabinet.js');
    const cabinet = readCabinet(bytes);
    /** @type {Map<number, Uint8Array>} */
    const folders = new Map();
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    for (const file of cabinet.files)
    {
        if (!folders.has(file.folder))
        {
            folders.set(file.folder, decodeFolder(cabinet, file.folder));
        }
        const stream = /** @type {Uint8Array} */ (folders.get(file.folder));
        files.set(file.name.replace(/^\.\\/, ''), stream.slice(file.offset, file.offset + file.size));
    }
    return files;
}

/**
 * The cabinets an installer database keeps as its own streams.
 *
 * @param {Uint8Array} bytes
 */
async function databaseCabinets(bytes){
    const { openCompound, bytesSource } = await import(
        '../modules/core/src/layers/win32/msi/compound.js');
    const compound = await openCompound(bytesSource(bytes));
    /** @type {Uint8Array[]} */
    const found = [];
    for (const node of compound.root.children.values())
    {
        if (node.kind === 'stream')
        {
            const data = await compound.readAll(node);
            if (data[0] === 0x4d && data[1] === 0x53 && data[2] === 0x43 && data[3] === 0x46)
            {
                found.push(data);
            }
        }
    }
    return found;
}

/**
 * A runtime's files out of every cabinet the redistributable holds: the DLLs
 * by their own names and the assembly's manifest as `<assembly>.manifest`.
 * The store copies are named `<file>.<version>.<id>`; the copies under
 * `ul_` and `nosxs_` are the same bytes for other install modes.
 *
 * @param {Map<string, Uint8Array>} files @param {string[]} dlls @param {string} manifestOf
 * @param {string} assembly
 */
function pick(files, dlls, manifestOf, assembly){
    /** @type {Map<string, Uint8Array>} */
    const picked = new Map();
    for (const [name, bytes] of files)
    {
        for (const dll of dlls)
        {
            if (name.toLowerCase().startsWith(`${dll}.`))
            {
                picked.set(dll, bytes);
            }
        }
        if (name.startsWith('manifest.') && name.includes(manifestOf))
        {
            picked.set(`${assembly}.manifest`, bytes);
        }
    }
    return picked;
}

/**
 * Downloads the redistributables and unpacks the runtimes measured into
 * `to_install/vcredist/<key>/`.
 */
async function fetchAndUnpack(){
    await mkdir(LOCAL, { recursive: true });
    for (const [name, url] of Object.entries(REDISTRIBUTABLES))
    {
        const response = await fetch(url);
        if (!response.ok)
        {
            throw new Error(`${url}: ${response.status}`);
        }
        await writeFile(new URL(`${name}.exe`, LOCAL),
            new Uint8Array(await response.arrayBuffer()));
        console.log(`fetched ${name}.exe`);
    }

    /** @type {Map<string, Uint8Array>} */
    const all = new Map();
    for (const name of Object.keys(REDISTRIBUTABLES))
    {
        const exe = new Uint8Array(await readFile(new URL(`${name}.exe`, LOCAL)));
        for (const outer of embeddedCabinets(exe))
        {
            for (const [file, bytes] of await cabinetFiles(outer))
            {
                all.set(file, bytes);
                // 2008 keeps its runtimes in a cabinet beside the package,
                // 2005 inside the package's own streams.
                if (/\.cab$/i.test(file))
                {
                    for (const [inner, data] of await cabinetFiles(bytes))
                    {
                        all.set(inner, data);
                    }
                }
                if (/\.msi$/i.test(file))
                {
                    for (const cabinet of await databaseCabinets(bytes))
                    {
                        for (const [inner, data] of await cabinetFiles(cabinet))
                        {
                            all.set(inner, data);
                        }
                    }
                }
            }
        }
    }
    const sets = {
        'vc80-openmp': pick(all, ['vcomp.dll'], '1E507087', 'Microsoft.VC80.OpenMP'),
        'vc80-crt': pick(all, ['msvcr80.dll', 'msvcp80.dll'], '98CB24AD', 'Microsoft.VC80.CRT'),
        'vc90-crt': pick(all, ['msvcr90.dll', 'msvcp90.dll'], 'Microsoft_VC90_CRT',
            'Microsoft.VC90.CRT'),
    };
    for (const [key, files] of Object.entries(sets))
    {
        const directory = new URL(`${key}/`, LOCAL);
        await mkdir(directory, { recursive: true });
        for (const [file, bytes] of files)
        {
            await writeFile(new URL(file, directory), bytes);
        }
        console.log(`unpacked ${key}: ${[...files.keys()].join(', ')}`);
    }
}

/**
 * A program's manifest naming one assembly.
 *
 * @param {{ assembly: string, version: string }} runtime
 */
const dependingOn = runtime=>'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">'
    + '<dependency><dependentAssembly><assemblyIdentity type="win32" '
    + `name="${runtime.assembly}" version="${runtime.version}" processorArchitecture="x86" `
    + `publicKeyToken="${TOKEN}"/></dependentAssembly></dependency></assembly>`;

/** @param {number} value */
const u32 = value=>[value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff];

/**
 * A program that imports the runtime, so its DllMain runs before the
 * program's first instruction, and exits 0.
 *
 * @param {{ dll: string, export: string }} runtime @param {string | null} manifest
 */
function staticProgram(runtime, manifest){
    return buildExe({
        imports: { [runtime.dll.toUpperCase()]: [runtime.export], 'KERNEL32.dll': ['ExitProcess'] },
        ...manifest ? { manifest: { id: 1, text: manifest } } : {},
        code: ({ iat })=>[0x6a, 0x00, 0xff, 0x15, ...u32(iat('ExitProcess'))],
    });
}

/**
 * A program that loads the runtime with LoadLibraryA, as a game loads
 * vcomp.dll, and exits 0 when it got it and 1 when it did not.
 *
 * @param {{ dll: string }} runtime @param {string | null} manifest
 */
function dynamicProgram(runtime, manifest){
    return buildExe({
        imports: { 'KERNEL32.dll': ['LoadLibraryA', 'ExitProcess'] },
        data: { name: [...runtime.dll].map(c=>c.charCodeAt(0)).concat(0) },
        ...manifest ? { manifest: { id: 1, text: manifest } } : {},
        code: ({ iat, at })=>[
            0x68, ...u32(at('name')), //          push name
            0xff, 0x15, ...u32(iat('LoadLibraryA')),
            0x85, 0xc0, //                        test eax, eax
            0x0f, 0x94, 0xc0, //                  sete al
            0x0f, 0xb6, 0xc0, //                  movzx eax, al
            0x50, //                              push eax
            0xff, 0x15, ...u32(iat('ExitProcess')),
        ],
    });
}

const APP = 'C:\\app\\';

/**
 * Every layout of one runtime: where its files are, what names it, and what
 * Windows does with it.
 *
 * @param {typeof RUNTIMES[number]} runtime @param {Map<string, Uint8Array>} files
 */
function layoutsOf(runtime, files){
    const manifestName = `${runtime.assembly}.manifest`;
    const dll = /** @type {Uint8Array} */ (files.get(runtime.dll));
    const assemblyManifest = /** @type {Uint8Array} */ (files.get(manifestName));
    const program = dependingOn(runtime);
    /** @param {string} directory */
    const assemblyIn = directory=>[
        { path: `${directory}${runtime.dll}`, bytes: dll },
        { path: `${directory}${manifestName}`, bytes: assemblyManifest },
    ];
    return [
        { layout: 'embedded manifest; the runtime and its manifest beside the program',
            exe: staticProgram(runtime, program), files: assemblyIn(APP), windows: 'runs' },
        { layout: 'embedded manifest; the runtime in its assembly\'s folder',
            exe: staticProgram(runtime, program),
            files: assemblyIn(`${APP}${runtime.assembly}\\`), windows: 'runs' },
        { layout: 'external program.manifest; the runtime and its manifest beside the program',
            exe: staticProgram(runtime, null), windows: 'runs',
            files: [...assemblyIn(APP), { path: `${APP}test.exe.manifest`,
                bytes: new TextEncoder().encode(program) }] },
        { layout: 'LoadLibrary, embedded manifest; the runtime and its manifest beside it',
            exe: dynamicProgram(runtime, program), files: assemblyIn(APP), windows: 'runs' },
        { layout: 'the runtime installed: only in system32, the store presents it',
            exe: staticProgram(runtime, program),
            files: [{ path: `C:\\WINDOWS\\system32\\${runtime.dll}`, bytes: dll }],
            windows: 'runs (as with the redistributable installed)' },
        { layout: 'no manifest at all; the runtime beside the program',
            exe: staticProgram(runtime, null), windows: 'R6034',
            files: [{ path: `${APP}${runtime.dll}`, bytes: dll }] },
        { layout: 'LoadLibrary, no manifest at all; the runtime beside the program',
            exe: dynamicProgram(runtime, null), windows: 'R6034',
            files: [{ path: `${APP}${runtime.dll}`, bytes: dll }] },
    ];
}

/**
 * One layout in a child process: the exit code, and what the engine said.
 *
 * @param {{ exe: Uint8Array, files: { path: string, bytes: Uint8Array }[] }} layout
 * @returns {Promise<any>}
 */
async function runInChild(layout){
    const payload = new URL(`run-${process.pid}-${Math.random().toString(36).slice(2)}.json`,
        LOCAL);
    await writeFile(payload, JSON.stringify({
        exe: [...layout.exe],
        files: layout.files.map(file=>({ path: file.path, bytes: [...file.bytes] })),
    }));
    return new Promise(resolve=>{
        const child = fork(fileURLToPath(import.meta.url), ['--child', fileURLToPath(payload)],
            { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        /** @type {any} */
        let done = null;
        let stderr = '';
        const timer = setTimeout(()=>child.kill('SIGKILL'), 120_000);
        child.stderr?.on('data', chunk=>{
            stderr = (stderr + chunk).slice(-2000);
        });
        child.on('message', message=>{
            done = message;
        });
        child.on('exit', ()=>{
            clearTimeout(timer);
            resolve(done
                ?? { exitCode: null, error: stderr.trim().split('\n').slice(-4).join('\n') });
        });
    });
}

/** What runs in the child: the program on its volume, to its end. */
async function runChild(/** @type {string} */ payloadPath){
    const { createApp } = await import('../modules/core/src/app.js');
    const payload = JSON.parse(await readFile(payloadPath, 'utf8'));
    const executable = new Uint8Array(payload.exe);
    const imagePath = `${APP}test.exe`;
    /** @type {string[]} */
    const output = [];
    /** @type {string[]} */
    const events = [];
    /** @type {any} */
    let result = {};
    try
    {
        const app = await createApp({
            executable, imagePath, commandLine: `"${imagePath}"`,
            files: [{ path: imagePath, bytes: executable },
                ...payload.files.map((/** @type {any} */ file)=>({ path: file.path,
                    bytes: new Uint8Array(file.bytes) }))],
            storage: null,
        });
        app.attachLog((/** @type {number} */ _, /** @type {string} */ text)=>output.push(text));
        for (const name of ['divergence', 'libraries', 'libraries-missing', 'library-loaded',
            'library-missing', 'activation-context-failed'])
        {
            app.on(name, (/** @type {any} */ data)=>events.push(`${name}: ${JSON.stringify(data)}`));
        }
        const exitCode = await app.run({ maxTurns: Number.MAX_SAFE_INTEGER, timeoutMs: 20_000 });
        result = { exitCode, output: output.join(''), events };
        await app.dispose();
    }
    catch (e){
        const thrown = /** @type {any} */ (e);
        // A runtime that stops a program puts up its box and waits there for a
        // person: the run then ends on the engine's clock inside MessageBox,
        // having just looked itself up -- the box's text in what the trace
        // shows of memory when it was there to show.
        const trace = String(thrown.traceText ?? '');
        const inBox = /^inside: .*USER32\.dll!MessageBox[AW]/m.test(trace);
        const text = trace.replace(/\|[^|]*\|/g, line=>line.replace(/\./g, ''));
        const lookedUp = /^last calls: .*FindActCtxSectionStringW/m.test(trace);
        const error = `${thrown.reason ?? ''} ${thrown.message ?? thrown}`.trim().split('\n')[0];
        result = { exitCode: null, error, output: output.join(''), events,
            box: inBox && (/R6034/.test(text) || lookedUp) ? 'R6034' : null };
    }
    await new Promise(resolve=>process.send?.(result, undefined, {}, ()=>resolve(undefined)));
    process.exit(0);
}

/**
 * What a run came to: the program ran (exit 0), or it was stopped, with the
 * engine's or the runtime's reason.
 *
 * @param {any} run
 */
export function outcomeOf(run){
    if (run.exitCode === 0)
    {
        return 'runs';
    }
    if (run.box === 'R6034' || /R6034/.test(run.output ?? ''))
    {
        return 'R6034';
    }
    if (run.exitCode === null)
    {
        return `did not run: ${run.error ?? 'no exit'}`;
    }
    return `stopped (exit 0x${(run.exitCode >>> 0).toString(16)})`;
}

/**
 * Whether what the engine did is what Windows does: a run where Windows runs,
 * a stop where Windows stops with R6034 (an engine's stop for any reason
 * counts, as the program does not get past the runtime either).
 *
 * @param {string} outcome @param {string} windows
 */
export function agrees(outcome, windows){
    return windows.startsWith('runs') ? outcome === 'runs' : outcome !== 'runs';
}

async function main(){
    const argv = process.argv.slice(2);
    if (argv[0] === '--child')
    {
        await runChild(argv[1]);
        return;
    }
    if (argv.includes('--fetch'))
    {
        await fetchAndUnpack();
    }
    const at = argv.indexOf('--out');
    const out = at >= 0 ? new URL(`${argv[at + 1].replace(/\/?$/, '/')}`, `file://${process.cwd()}/`)
        : new URL('matrix/', LOCAL);
    /** @type {any[]} */
    const rows = [];
    for (const runtime of RUNTIMES)
    {
        const directory = new URL(`${runtime.key}/`, LOCAL);
        const present = existsSync(new URL(runtime.dll, directory))
            && existsSync(new URL(`${runtime.assembly}.manifest`, directory));
        if (!present)
        {
            rows.push({ runtime: runtime.key, layout: '(all)', windows: '-',
                engine: 'not measured: the redistributable is not unpacked (--fetch)' });
            continue;
        }
        /** @type {Map<string, Uint8Array>} */
        const files = new Map();
        for (const name of [runtime.dll, `${runtime.assembly}.manifest`])
        {
            files.set(name, new Uint8Array(await readFile(new URL(name, directory))));
        }
        for (const layout of layoutsOf(runtime, files))
        {
            const run = await runInChild(layout);
            const outcome = outcomeOf(run);
            // The engine's own runtime has no check to make: a program runs
            // where Microsoft's would have stopped it, as decided (runtimes()).
            const verdict = agrees(outcome, layout.windows) ? 'yes'
                : runtime.engine && outcome === 'runs' ? 'by decision' : 'NO';
            rows.push({ runtime: runtime.key, layout: layout.layout, windows: layout.windows,
                engine: outcome, agrees: verdict,
                note: runtime.engine ? 'the engine\'s own msvcr80 answers (runtimes())' : '',
                events: run.events ?? [], output: (run.output ?? '').slice(-400) });
            console.log(`${verdict === 'NO' ? 'DIFF' : 'ok  '} ${runtime.key}: `
                + `${layout.layout} -- Windows ${layout.windows}, engine ${outcome}`);
        }
    }
    await mkdir(out, { recursive: true });
    await writeFile(new URL('report.json', out), JSON.stringify(rows, null, 1));
    const table = ['| runtime | layout | Windows | engine | agrees |', '|---|---|---|---|---|',
        ...rows.map(row=>`| ${row.runtime} | ${row.layout} | ${row.windows} | ${row.engine}`
            + `${row.note ? ` (${row.note})` : ''} | ${row.agrees ?? '-'} |`)];
    await writeFile(new URL('report.md', out), `${table.join('\n')}\n`);
    console.log(`report: ${fileURLToPath(new URL('report.md', out))}`);
    process.exitCode = rows.some(row=>row.agrees === 'NO') ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
{
    await main();
}
