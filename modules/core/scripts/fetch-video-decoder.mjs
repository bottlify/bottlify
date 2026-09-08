/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fetches the prebuilt video decoder from a pinned release into
 * vendor/prebuilt/, verifying every file against video-decoder-lock.json.
 *
 * Building it from source needs Docker and twenty minutes of a compiler; a
 * development machine should need neither. The build runs in CI
 * (.github/workflows/video-decoder.yml), publishes the .wasm and a SHA256SUMS
 * as release assets, and this script consumes them. The .wasm is a build
 * artifact and is never committed.
 *
 * `tools/build-video-decoder/build.mjs` remains the from-source path and stays
 * authoritative: --check is how the workflow proves that the pinned inputs
 * still build to the bytes the lock names.
 *
 * Usage:
 *   node scripts/fetch-video-decoder.mjs               download + verify
 *   node scripts/fetch-video-decoder.mjs --update TAG  re-pin the lock
 *   node scripts/fetch-video-decoder.mjs --check FILE  compare a local SHA256SUMS
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const LOCK_FILE = join(ROOT, 'video-decoder-lock.json');
const OUT = join(ROOT, 'vendor', 'prebuilt');

/** @param {Uint8Array} bytes @returns {string} */
const sha256 = bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** @returns {Promise<{ repo: string | null, tag: string | null,
 *                      artifacts: Record<string, string> }>} */
async function readLock(){
    return JSON.parse(await readFile(LOCK_FILE, 'utf8'));
}

/** Which repository publishes the release. Configurable because the workflow
 * publishes to whichever repository it runs in. */
function repoOf(/** @type {{ repo: string | null }} */ lock){
    const repo = process.env.VIDEO_DECODER_REPO ?? lock.repo ?? process.env.GITHUB_REPOSITORY;
    if (!repo)
    {
        throw new Error(
            'no repository to fetch from: set "repo" in video-decoder-lock.json '
            + 'or pass VIDEO_DECODER_REPO.');
    }
    return repo;
}

/**
 * @param {string} repo @param {string} tag @param {string} name
 * @returns {Promise<Uint8Array>}
 */
async function download(repo, tag, name){
    const url = `https://github.com/${repo}/releases/download/${tag}/${name}`;
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok)
    {
        throw new Error(`${url}: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}

/** @param {string} sums @returns {Record<string, string>} */
function parseSums(sums){
    /** @type {Record<string, string>} */
    const artifacts = {};
    for (const line of sums.split('\n'))
    {
        const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/);
        if (match && match[2] !== 'SHA256SUMS')
        {
            artifacts[match[2]] = `sha256:${match[1]}`;
        }
    }
    return artifacts;
}

/** Re-pins the lock to a release, using that release's own SHA256SUMS. */
async function update(/** @type {string} */ tag){
    const lock = await readLock();
    const repo = repoOf(lock);
    const artifacts = parseSums(
        new TextDecoder().decode(await download(repo, tag, 'SHA256SUMS')));
    if (Object.keys(artifacts).length === 0)
    {
        throw new Error(`no artifacts parsed out of ${tag}'s SHA256SUMS`);
    }
    await writeFile(LOCK_FILE, `${JSON.stringify({ repo, tag, artifacts }, null, 2)}\n`);
    console.log(`video-decoder-lock.json pinned to ${repo}@${tag} `
        + `(${Object.keys(artifacts).length} artifacts)`);
}

/** Compares a SHA256SUMS produced by a local build against the pinned hashes. */
async function check(/** @type {string} */ path){
    const lock = await readLock();
    const built = parseSums(await readFile(path, 'utf8'));
    const pinned = Object.entries(lock.artifacts ?? {});
    if (pinned.length === 0)
    {
        console.log('nothing pinned yet: run --update <tag> once a release exists');
        return;
    }
    for (const [name, expected] of pinned)
    {
        if (built[name] !== expected)
        {
            throw new Error(`${name}: this build does not match the pinned bytes\n`
                + `  pinned ${expected}\n  built  ${built[name] ?? '(absent)'}`);
        }
    }
    console.log(`reproducible: ${pinned.length} artifact(s) match ${lock.tag}`);
}

async function fetchPinned(){
    const lock = await readLock();
    const names = Object.keys(lock.artifacts ?? {});
    if (!lock.tag || names.length === 0)
    {
        throw new Error(
            'video-decoder-lock.json pins no release yet. Run the `video-decoder` '
            + 'workflow, then `node scripts/fetch-video-decoder.mjs --update <tag>`. '
            + 'Until then, build locally with `npm run build:video-decoder`.');
    }
    const repo = repoOf(lock);
    await mkdir(OUT, { recursive: true });

    for (const [name, expected] of Object.entries(lock.artifacts))
    {
        const bytes = await download(repo, lock.tag, name);
        const actual = sha256(bytes);
        if (actual !== expected)
        {
            throw new Error(`${name}: checksum mismatch\n`
                + `  expected ${expected}\n  got      ${actual}`);
        }
        await writeFile(join(OUT, name), bytes);
        console.log(`${name}: ${bytes.length} bytes, ${actual.slice(0, 19)} OK`);
    }
    console.log(`vendor/prebuilt: ${names.length} artifact(s) from ${repo}@${lock.tag}`);
}

/** @param {string} flag @returns {string | null} */
const argumentOf = flag=>{
    const index = process.argv.indexOf(flag);
    if (index === -1)
    {
        return null;
    }
    const value = process.argv[index + 1];
    if (!value)
    {
        throw new Error(`usage: fetch-video-decoder.mjs ${flag} <value>`);
    }
    return value;
};

const updateTag = argumentOf('--update');
const checkFile = argumentOf('--check');
if (updateTag)
{
    await update(updateTag);
}
else if (checkFile)
{
    await check(checkFile);
}
else
{
    await fetchPinned();
}
