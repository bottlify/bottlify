/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds zstd.wasm -- this project's own decode-only zstd, scripts/zstd/zstd.c
 * compiled to WebAssembly -- and records what came out.
 *
 * Two paths, one result:
 *   `--docker` (or BOTTLIFY_ZSTD_DOCKER=1): the pinned image of
 *     Dockerfile.zstd, which is what the vendor workflow runs; the canonical,
 *     reproducible build.
 *   `--native`: `scripts/zstd/build-zstd.sh` with the clang and lld on PATH,
 *     for a machine that has them (a Linux VM) and no Docker. The bytes match
 *     the container's only when the compiler is the same version.
 *
 * What is written:
 *   vendor/prebuilt/zstd.wasm      what the package build copies in
 *   dist/vendor/zstd.wasm          and SHA256SUMS (its line merged in) and
 *                                  zstd.manifest.json: what a release carries
 *   zstd-lock.json                 re-pinned to the bytes just built and to the
 *                                  release tag a dispatch of the vendor
 *                                  workflow gives this commit
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPTS = join(ROOT, 'scripts');
const PREBUILT = join(ROOT, 'vendor', 'prebuilt');
const OUT = join(ROOT, 'dist', 'vendor');
const LOCK_FILE = join(ROOT, 'zstd-lock.json');
const IMAGE = 'bottlify-zstd-builder:0.1';
const ARTIFACT = 'zstd.wasm';
/** Where a dispatch of the vendor workflow publishes what it built. */
const RELEASE_REPO = 'mrwayer/bottlify';

/** @param {string} path @returns {string} */
function sha256Hex(path){
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** @param {string[]} args @returns {string | null} */
function git(args){
    const result = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

function requireDocker(){
    const probe = spawnSync(
        'docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' });
    if (probe.status !== 0)
    {
        throw new Error('docker is required for the container build of zstd.wasm and is not'
            + ' available; on a machine with clang and lld, `--native` builds it directly');
    }
}

function buildInDocker(){
    const build = spawnSync(
        'docker', ['build', '-t', IMAGE, '-f', join(SCRIPTS, 'Dockerfile.zstd'), SCRIPTS],
        { stdio: 'inherit' });
    if (build.status !== 0)
    {
        throw new Error('failed to build the zstd builder image');
    }
    // No bind mount: a mount onto a shared or network volume (a VM's disk seen
    // from its host) can succeed and still leave nothing behind, so the
    // container writes to its own /out and the bytes are copied out of it.
    const name = `bottlify-zstd-build-${process.pid}`;
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    const create = spawnSync('docker', ['create', '--name', name, IMAGE, '/out'],
        { stdio: 'inherit' });
    if (create.status !== 0)
    {
        throw new Error('failed to create the zstd build container');
    }
    try
    {
        const run = spawnSync('docker', ['start', '-a', name], { stdio: 'inherit' });
        if (run.status !== 0)
        {
            throw new Error('containerized zstd.wasm build failed');
        }
        // Copied to the local temp directory first: `docker cp` onto a shared
        // volume can refuse, and a plain file copy from there does not.
        const staged = join(tmpdir(), `${name}.wasm`);
        const copy = spawnSync('docker', ['cp', `${name}:/out/zstd.wasm`, staged],
            { stdio: 'inherit' });
        if (copy.status !== 0 || !existsSync(staged))
        {
            throw new Error('the container built nothing at /out/zstd.wasm'
                + ' (docker cp answered nothing)');
        }
        copyFileSync(staged, join(OUT, ARTIFACT));
        unlinkSync(staged);
    }
    finally
    {
        spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    }
}

function buildNatively(){
    const script = join(SCRIPTS, 'zstd', 'build-zstd.sh');
    const source = join(SCRIPTS, 'zstd', 'zstd.c');
    const run = spawnSync('bash', [script, source, OUT], { stdio: 'inherit' });
    if (run.status !== 0)
    {
        throw new Error('native zstd.wasm build failed (clang and lld with a wasm32 target'
            + ' are needed on PATH)');
    }
}

/**
 * Merges this artifact's line into dist/vendor/SHA256SUMS, which the other
 * vendor builds write too, so one file lists every artifact in dist/vendor/.
 *
 * @param {string} hex
 */
async function mergeSums(hex){
    const path = join(OUT, 'SHA256SUMS');
    const lines = existsSync(path)
        ? (await readFile(path, 'utf8')).split('\n').filter(line=>line.trim() !== '')
        : [];
    const kept = lines.filter(line=>!line.trim().endsWith(` ${ARTIFACT}`)
        && !line.trim().endsWith(` *${ARTIFACT}`));
    kept.push(`${hex}  ${ARTIFACT}`);
    await writeFile(path, `${kept.join('\n')}\n`);
}

const wantsDocker = process.argv.includes('--docker') || process.env.BOTTLIFY_ZSTD_DOCKER === '1';
const wantsNative = process.argv.includes('--native');
if (!wantsDocker && !wantsNative)
{
    throw new Error('zstd.wasm is built in a container or with a native clang: '
        + '`npm run build:zstd -- --docker` or `-- --native`');
}

await mkdir(OUT, { recursive: true });
await mkdir(PREBUILT, { recursive: true });
if (wantsDocker)
{
    requireDocker();
    buildInDocker();
}
else
{
    buildNatively();
}

const built = join(OUT, ARTIFACT);
const hex = sha256Hex(built);
const hash = `sha256:${hex}`;
await copyFile(built, join(PREBUILT, ARTIFACT));
await mergeSums(hex);

const commit = git(['rev-parse', 'HEAD']);
const short = git(['rev-parse', '--short', 'HEAD']);
await writeFile(join(OUT, 'zstd.manifest.json'), `${JSON.stringify({
    source: 'modules/core/scripts/zstd/zstd.c',
    license: 'MPL-2.0',
    build: { repo: RELEASE_REPO, commit, how: wantsDocker ? 'docker' : 'native' },
    image: wantsDocker ? IMAGE : null,
    artifacts: { [`./${ARTIFACT}`]: hash },
    builtAt: new Date().toISOString(),
}, null, 2)}\n`);

// The lock names the release a dispatch of the vendor workflow creates for
// this commit, so what was built here and what everyone else fetches are the
// same bytes under the same name.
const lock = existsSync(LOCK_FILE) ? JSON.parse(await readFile(LOCK_FILE, 'utf8')) : {};
await writeFile(LOCK_FILE, `${JSON.stringify({
    repo: RELEASE_REPO,
    tag: short ? `zstd-${short}` : lock.tag ?? null,
    artifacts: { [ARTIFACT]: hash },
}, null, 2)}\n`);

console.log(`dist/vendor: ${ARTIFACT} + SHA256SUMS + zstd.manifest.json (${hash})`);
