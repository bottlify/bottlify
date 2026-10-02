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
 * The module imports cork's memory and places its data and stack at 4096, in
 * the page cork's layout keeps for the state block (512 bytes) below guest RAM;
 * the build fails if they would reach past 16 KiB.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_MATH } from '../src/interp-wasm.js';

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
const source = new URL('../src/interp-wasm.c', import.meta.url);
const target = new URL('../src/interp-wasm.bytes.js', import.meta.url);
/** Where the module's own data and stack must end: below this, above the state block. */
const LIMIT = 16384;

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
        '-Wl,--no-entry', '-Wl,--import-memory', '-Wl,--global-base=4096',
        '-Wl,-z,stack-size=8192', '-Wl,--export=__heap_base',
    ];
    const compiled = docker ? compileInDocker(flags, out) : null;
    if (!docker)
    {
        execFileSync(clang, [...flags, '-o', out, fileURLToPath(source)], { stdio: 'inherit' });
    }
    const bytes = readFileSync(out);
    const module = new WebAssembly.Module(bytes);
    const memory = new WebAssembly.Memory({ initial: 1 });
    const { exports } = new WebAssembly.Instance(module, { env: { memory, ...HOST_MATH } });
    const end = /** @type {WebAssembly.Global} */ (exports.__heap_base).value;
    if (end > LIMIT)
    {
        throw new Error(`interp-wasm: data and stack end at ${end}, past ${LIMIT}`);
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
    console.log(`interp-wasm: ${bytes.length} bytes, data and stack end at ${end}, ${compiler}`);
}
finally
{
    rmSync(dir, { recursive: true, force: true });
}
