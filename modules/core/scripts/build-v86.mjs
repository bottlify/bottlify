/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds the vendored v86 into dist/vendor/ and records a manifest.
 *
 * The canonical, reproducible path is `--docker` (pinned image, clean make,
 * byte-identical output). A native path exists for machines that already have
 * the toolchain (Rust + wasm32 target, a C compiler, java/closure).
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VENDOR = join(ROOT, 'vendor', 'v86');
const OUT = join(ROOT, 'dist', 'vendor');
const IMAGE = 'bottlify-v86-builder:0.1';

/** @typedef {{ src: string, out: string }} ArtifactSpec */
const ARTIFACTS = [
    { src: 'build/libv86.js', out: 'libv86.js' },
    { src: 'build/v86.wasm', out: 'v86.wasm' },
    { src: 'bios/seabios.bin', out: 'seabios.bin' },
    { src: 'bios/vgabios.bin', out: 'vgabios.bin' },
];

/**
 * @param {string} path
 * @returns {string}
 */
function sha256Hex(path){
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * @returns {string}
 */
function commitOf(){
    const { status, stdout } = spawnSync('git', ['-C', VENDOR, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
    });
    if (status !== 0)
    {
        throw new Error('cannot read the v86 submodule HEAD');
    }
    return stdout.trim();
}

async function runNative(){
    const result = spawnSync('make', ['all'], { cwd: VENDOR, shell: true, stdio: 'inherit' });
    if (result.status !== 0)
    {
        throw new Error(
            'native v86 build failed. Install rust + wasm32-unknown-unknown, a C compiler ' +
        'and java (closure), or run `npm run build:v86 -- --docker`.',
        );
    }
    for (const artifact of ARTIFACTS)
    {
        await copyFile(join(VENDOR, artifact.src), join(OUT, artifact.out));
    }
}

function dockerAvailable(){
    const probe = spawnSync(
        'docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' });
    return probe.status === 0;
}

function dockerImageExists(){
    return spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0;
}

async function runDocker(){
    if (!dockerAvailable())
    {
        throw new Error('docker is required for the reproducible v86 build and is not available');
    }
    if (!dockerImageExists())
    {
        const build = spawnSync(
            'docker',
            ['build', '-t', IMAGE, '-f',
                join(ROOT, 'scripts', 'Dockerfile.v86'), join(ROOT, 'scripts')],
            { stdio: 'inherit' },
        );
        if (build.status !== 0)
        {
            throw new Error('failed to build the v86 builder image');
        }
    }
    const run = spawnSync(
        'docker',
        ['run', '--rm', '-v', `${VENDOR}:/src`, '-v', `${OUT}:/out`, IMAGE, '/src', '/out'],
        { stdio: 'inherit' },
    );
    if (run.status !== 0)
    {
        throw new Error('containerized v86 build failed');
    }
}

// The environment variable is not a convenience: `npm run build:v86 -- --docker`
// has to survive being forwarded through a workspace script, and an npm that
// swallows the flag turns the reproducible build into a native one silently --
// which is how this ran for weeks in CI on a machine with no Rust target.
const wantsDocker = process.argv.includes('--docker')
    || process.env.BOTTLIFY_V86_DOCKER === '1';
const mode = wantsDocker ? 'docker' : 'native';
await mkdir(OUT, { recursive: true });
if (mode === 'docker')
{
    await runDocker();
}
else await runNative();

const manifest = {
    v86: { commit: commitOf() },
    artifacts: Object.fromEntries(ARTIFACTS.map(artifact=>
        [`./${artifact.out}`, `sha256:${sha256Hex(join(OUT, artifact.out))}`])),
    toolchain: { mode },
    reproducedAt: new Date().toISOString(),
};
await writeFile(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`dist/vendor: ${ARTIFACTS.length} artifacts + manifest.json (${mode})`);
