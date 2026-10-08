/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Builds the interpreter tier in wasm: `src/interp-wasm.c` compiled by clang
 * for wasm32 into `src/interp-wasm.bytes.js`, the module as base64 beside the
 * SHA-256 of the source it came from. The generated file is committed, so a
 * checkout runs without a C compiler; `interp-wasm.test.js` fails when the
 * source changed and this was not run again.
 *
 *   node modules/cork/scripts/build-interp-wasm.mjs [--clang PATH | --docker]
 *
 * `--docker` compiles in the zstd builder's image (core's `Dockerfile.zstd`,
 * Debian's clang-16 and lld-16), for a machine whose clang has no wasm32 target
 * or which has none: the source is copied into the container and the module
 * copied out, so nothing depends on a volume shared with the host.
 *
 * The module imports cork's memory and is position-independent: its data lies
 * at the `__memory_base` and its stack below the `__stack_pointer` it is
 * given, so every executor of a process runs an instance of its own over the
 * one memory, its statics and stack in its own state page
 * (`WASM_INTERPRETER_STATICS` bytes from 4096 past its state block). The build
 * fails if the data and the stack would not fit there.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASM_INTERPRETER_STACK, WASM_INTERPRETER_STATICS } from '../src/interp-wasm.js';

const args = process.argv.slice(2);
const docker = args.includes('--docker');
const clang = args.includes('--clang') ? args[args.indexOf('--clang') + 1] : 'clang';
/** The zstd builder's image and where its Dockerfile is. */
const IMAGE = 'bottlify-zstd-builder:0.1';
const CORE_SCRIPTS = fileURLToPath(new URL('../../core/scripts/', import.meta.url));

/**
 * Runs clang in the zstd builder's image over the source, copied in, and
 * copies the module out to `out`.
 *
 * @param {string[]} flags @param {string} out
 * @returns {string} the compiler's first line of `--version`
 */
function compileInDocker(flags, out){
    const built = spawnSync('docker', ['build', '-t', IMAGE, '-f',
        join(CORE_SCRIPTS, 'Dockerfile.zstd'), CORE_SCRIPTS], { stdio: 'inherit' });
    if (built.status !== 0)
    {
        throw new Error('failed to build the builder image');
    }
    const name = `bottlify-interp-wasm-build-${process.pid}`;
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    const created = spawnSync('docker', ['create', '--name', name, '--entrypoint', 'sh', IMAGE,
        '-c', ['mkdir -p /out &&', 'clang-16', ...flags, '-o /out/interp-wasm.wasm',
            '/src/interp-wasm.c'].join(' ')], { stdio: 'inherit' });
    if (created.status !== 0)
    {
        throw new Error('failed to create the build container');
    }
    try
    {
        const steps = [
            ['cp', fileURLToPath(new URL('../src/', import.meta.url)), `${name}:/src`],
            ['start', '-a', name],
            ['cp', `${name}:/out/interp-wasm.wasm`, out],
        ];
        for (const step of steps)
        {
            if (spawnSync('docker', step, { stdio: 'inherit' }).status !== 0)
            {
                throw new Error(`docker ${step[0]} failed`);
            }
        }
        if (!existsSync(out))
        {
            throw new Error('the container built nothing at /out/interp-wasm.wasm');
        }
        return spawnSync('docker', ['run', '--rm', '--entrypoint', 'clang-16', IMAGE, '--version'],
            { encoding: 'utf8' }).stdout.split('\n')[0].trim();
    }
    finally
    {
        spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    }
}
/**
 * The memory-info subsection of a `dylink.0` section.
 *
 * @param {Uint8Array} section
 */
function dylinkMemory(section){
    let at = 0;
    const leb = ()=>{
        let value = 0;
        let shift = 0;
        let byte = 0x80;
        while (byte & 0x80)
        {
            byte = section[at++];
            value |= (byte & 0x7f) << shift;
            shift += 7;
        }
        return value >>> 0;
    };
    while (at < section.length)
    {
        const kind = section[at++];
        const size = leb();
        const end = at + size;
        if (kind === 1)
        {
            return { memorySize: leb(), memoryAlign: leb(), tableSize: leb(), tableAlign: leb() };
        }
        at = end;
    }
    return { memorySize: 0, memoryAlign: 0, tableSize: 0, tableAlign: 0 };
}

const source = new URL('../src/interp-wasm.c', import.meta.url);
const target = new URL('../src/interp-wasm.bytes.js', import.meta.url);

const dir = mkdtempSync(join(tmpdir(), 'interp-wasm-'));
try
{
    const out = join(dir, 'interp-wasm.wasm');
    const flags = [
        // No contraction: a multiply and an add stay two roundings, as in JavaScript.
        '--target=wasm32', '-O2', '-nostdlib', '-ffreestanding', '-fno-builtin',
        '-ffp-contract=off',
        // memory.copy and memory.fill for a `rep movs`/`rep stos` done a page at once,
        // as translated code does them.
        '-mbulk-memory',
        '-Wall', '-Wextra', '-Werror', '-Wno-unused-parameter',
        // Position-independent: data and stack where each instance is told.
        '-fPIC', '-Wl,--experimental-pic', '-Wl,-shared',
        '-Wl,--no-entry', '-Wl,--import-memory',
    ];
    const compiled = docker ? compileInDocker(flags, out) : null;
    if (!docker)
    {
        execFileSync(clang, [...flags, '-o', out, fileURLToPath(source)], { stdio: 'inherit' });
    }
    const bytes = readFileSync(out);
    const module = new WebAssembly.Module(bytes);
    // The dylink section's memory info: the data's size and alignment, then the table's.
    const [dylink] = WebAssembly.Module.customSections(module, 'dylink.0');
    const info = dylinkMemory(new Uint8Array(dylink));
    if (info.tableSize !== 0)
    {
        throw new Error('interp-wasm: the module wants a function table; the loader gives none');
    }
    const end = info.memorySize + WASM_INTERPRETER_STACK;
    if (end > WASM_INTERPRETER_STATICS || info.memoryAlign > 4)
    {
        throw new Error(`interp-wasm: data (${info.memorySize}, aligned to 2^${info.memoryAlign})`
            + ` and a stack of ${WASM_INTERPRETER_STACK} need ${end} of the`
            + ` ${WASM_INTERPRETER_STATICS} bytes an executor keeps`);
    }
    const compiler = compiled
        ?? execFileSync(clang, ['--version']).toString().split('\n')[0].trim();
    // Hashed with LF line ends, as the repository keeps it and the test reads it.
    const digest = createHash('sha256')
        .update(readFileSync(source, 'utf8').replaceAll('\r\n', '\n')).digest('hex');
    const base64 = bytes.toString('base64');
    /** @type {string[]} */
    const lines = [];
    for (let at = 0; at < base64.length; at += 88)
    {
        lines.push(`    '${base64.slice(at, at + 88)}',`);
    }
    writeFileSync(target, [
        '/*',
        ' * Copyright © 2026 Bottlify Project',
        ' * Licensed under the Mozilla Public License, version 2.0',
        ' * See LICENSE for details',
        ' */',
        '',
        '// Generated by scripts/build-interp-wasm.mjs from interp-wasm.c: run it again after',
        '// changing the source, never edit this file.',
        '',
        '/** The SHA-256 of the interp-wasm.c this module was built from. */',
        `export const SOURCE_SHA256 = '${digest}';`,
        '',
        '/** The compiler that built it. */',
        `export const COMPILER = '${compiler.replace(/'/g, '')}';`,
        '',
        '/** The module, base64. */',
        'export const MODULE_BASE64 = [',
        ...lines,
        "].join('');",
        '',
    ].join('\n'));
    console.log(`interp-wasm: ${bytes.length} bytes, data and stack take ${end}, ${compiler}`);
}
finally
{
    rmSync(dir, { recursive: true, force: true });
}
