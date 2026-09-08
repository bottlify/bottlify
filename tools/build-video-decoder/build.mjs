/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Builds video-decoder.wasm in a pinned container and records what produced it.
 *
 * This is the from-source path and it is the authoritative one: the workflow
 * runs exactly this and publishes what comes out, and `fetch-video-decoder.mjs`
 * only ever consumes that release. A development machine needs Docker and
 * nothing else -- no Emscripten, no FFmpeg checkout.
 *
 * The artifact lands next to the fetched one, in vendor/prebuilt/, so whichever
 * path a machine took, everything downstream looks in one place.
 */

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const CORE = resolve(HERE, '..', '..', 'modules', 'core');
const OUT = join(CORE, 'vendor', 'prebuilt');
/* Under dist/ because it is a build tree, not a product: an FFmpeg checkout and
 * its object files, kept between runs so that editing decoder.c costs a link
 * rather than a full rebuild. */
const WORK = join(CORE, 'dist', 'video-decoder-build');
const IMAGE = 'bottlify-video-decoder-builder:0.1';

/** @param {string} path @returns {string} */
function sha256Hex(path){
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** @param {string[]} args @param {{ capture?: boolean }} [options] */
function docker(args, options = {}){
    return spawnSync('docker', args, {
        stdio: options.capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
        encoding: 'utf8',
    });
}

function requireDocker(){
    if (docker(['version', '--format', '{{.Server.Version}}'], { capture: true }).status !== 0)
    {
        throw new Error(
            'docker is required to build the video decoder and is not available. '
            + 'Run `npm run fetch:video-decoder` to take the published artifact instead.');
    }
}

function ensureImage(){
    if (spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0)
    {
        return;
    }
    if (docker(['build', '-t', IMAGE, HERE]).status !== 0)
    {
        throw new Error('failed to build the video-decoder builder image');
    }
}

requireDocker();
ensureImage();
await mkdir(OUT, { recursive: true });
await mkdir(WORK, { recursive: true });

const run = docker([
    'run', '--rm',
    '-v', `${HERE}:/src:ro`,
    '-v', `${OUT}:/out`,
    '-v', `${WORK}:/work`,
    IMAGE, '/src', '/out', '/work',
], { capture: true });
if (run.status !== 0)
{
    throw new Error('containerized video-decoder build failed');
}
process.stdout.write(run.stdout);

// The script prints what it pinned as its last line; recording it is what makes
// a hash mean something later.
const ffmpeg = (run.stdout.match(/^ffmpeg (\S+) ([0-9a-f]{40})$/m) ?? []).slice(1);
const artifact = join(OUT, 'video-decoder.wasm');
await writeFile(join(OUT, 'video-decoder.manifest.json'), `${JSON.stringify({
    ffmpeg: { tag: ffmpeg[0] ?? null, commit: ffmpeg[1] ?? null, license: 'LGPL-2.1-or-later' },
    image: IMAGE,
    artifacts: { './video-decoder.wasm': `sha256:${sha256Hex(artifact)}` },
    builtAt: new Date().toISOString(),
}, null, 2)}\n`);

console.log(`vendor/prebuilt: video-decoder.wasm + video-decoder.manifest.json`);
