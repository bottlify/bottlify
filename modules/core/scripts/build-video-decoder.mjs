/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds video-decoder.wasm in a pinned container and records what came out.
 *
 * The only path is `--docker`, because the build is FFmpeg compiled to
 * WebAssembly: it needs Emscripten at an exact version and twenty minutes of a
 * compiler, and a development machine should need neither. The workflow runs
 * exactly this and publishes the result as a release; `fetch-video-decoder.mjs`
 * is how everyone else gets the bytes.
 *
 * What is written:
 *   vendor/prebuilt/video-decoder.wasm    what the package build copies in
 *   dist/vendor/video-decoder.wasm        and SHA256SUMS, video-decoder.manifest.json:
 *                                         the three files a release carries
 *   video-decoder-lock.json               re-pinned to the bytes just built and
 *                                         to the release tag a dispatch of the
 *                                         vendor workflow gives this commit
 *
 * The image is rebuilt on every run rather than reused by name: Docker's own
 * layer cache makes an unchanged FFmpeg free, and the alternative -- an image
 * that keeps serving an old decoder.c -- is a build that silently ignores an
 * edit.
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCRIPTS = join(ROOT, 'scripts');
const PREBUILT = join(ROOT, 'vendor', 'prebuilt');
const OUT = join(ROOT, 'dist', 'vendor');
const LOCK_FILE = join(ROOT, 'video-decoder-lock.json');
const IMAGE = 'bottlify-video-decoder-builder:0.1';
const ARTIFACT = 'video-decoder.wasm';
/** Where a dispatch of the vendor workflow publishes what it built. */
const RELEASE_REPO = 'bottlify/bottlify';
const FFMPEG = {
    repo: 'https://github.com/FFmpeg/FFmpeg',
    tag: 'n6.1',
    commit: 'd4ff0020b40b524a490cf62eccbd3a318f4c0e58',
    license: 'LGPL-2.1-or-later',
};

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
        throw new Error('docker is required to build the video decoder and is not available');
    }
}

function buildImage(){
    const build = spawnSync(
        'docker',
        ['build', '-t', IMAGE, '-f', join(SCRIPTS, 'Dockerfile.video-decoder'), SCRIPTS],
        { stdio: 'inherit' },
    );
    if (build.status !== 0)
    {
        throw new Error('failed to build the video-decoder builder image');
    }
}

function runBuild(){
    const run = spawnSync(
        'docker', ['run', '--rm', '-v', `${OUT}:/out`, IMAGE, '/out'], { stdio: 'inherit' });
    if (run.status !== 0)
    {
        throw new Error('containerized video-decoder build failed');
    }
}

// The environment variable exists because `-- --docker` does not reliably
// survive a workspace script, and a build that cannot run natively must refuse
// rather than pretend.
const wantsDocker = process.argv.includes('--docker')
    || process.env.BOTTLIFY_VIDEO_DECODER_DOCKER === '1';
if (!wantsDocker)
{
    throw new Error('the video decoder is only built in a container: '
        + '`npm run build:video-decoder -- --docker`');
}

requireDocker();
await mkdir(OUT, { recursive: true });
await mkdir(PREBUILT, { recursive: true });
buildImage();
runBuild();

const built = join(OUT, ARTIFACT);
const hash = `sha256:${sha256Hex(built)}`;
await copyFile(built, join(PREBUILT, ARTIFACT));

const commit = git(['rev-parse', 'HEAD']);
const short = git(['rev-parse', '--short', 'HEAD']);
await writeFile(join(OUT, 'video-decoder.manifest.json'), `${JSON.stringify({
    ffmpeg: FFMPEG,
    build: { repo: RELEASE_REPO, commit },
    image: IMAGE,
    artifacts: { [`./${ARTIFACT}`]: hash },
    builtAt: new Date().toISOString(),
}, null, 2)}\n`);

// The lock names the release a dispatch of the vendor workflow creates for
// this commit, so that what was built here and what everyone else fetches are
// the same bytes under the same name. A lock that names a release not yet
// published is the honest state between a build and its dispatch.
const lock = JSON.parse(await readFile(LOCK_FILE, 'utf8'));
await writeFile(LOCK_FILE, `${JSON.stringify({
    repo: RELEASE_REPO,
    tag: short ? `video-decoder-${short}` : lock.tag,
    artifacts: { [ARTIFACT]: hash },
}, null, 2)}\n`);

console.log(`dist/vendor: ${ARTIFACT} + SHA256SUMS + video-decoder.manifest.json (${hash})`);
