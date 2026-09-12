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
 * development machine should need neither. The build is `build-video-decoder.mjs`
 * in a container, run by the vendor workflow on demand, which publishes the
 * .wasm, a SHA256SUMS and a manifest naming the commit it was built from as a
 * release of this repository; this script consumes them. The .wasm is a build
 * artifact and is never committed.
 *
 * Usage:
 *   node scripts/fetch-video-decoder.mjs                          download + verify
 *   node scripts/fetch-video-decoder.mjs --update TAG [--repo R]  re-pin the lock;
 *       the repository stays the lock's own unless named
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
async function update(/** @type {string} */ repo, /** @type {string} */ tag){
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

async function fetchPinned(){
    const lock = await readLock();
    const names = Object.keys(lock.artifacts ?? {});
    if (!lock.repo || !lock.tag || names.length === 0)
    {
        throw new Error(
            'video-decoder-lock.json pins no release yet. Dispatch the `vendor` '
            + 'workflow, then `node scripts/fetch-video-decoder.mjs --update <tag>`.');
    }
    await mkdir(OUT, { recursive: true });

    for (const [name, expected] of Object.entries(lock.artifacts))
    {
        const bytes = await download(lock.repo, lock.tag, name);
        const actual = sha256(bytes);
        if (actual !== expected)
        {
            throw new Error(`${name}: checksum mismatch\n`
                + `  expected ${expected}\n  got      ${actual}`);
        }
        await writeFile(join(OUT, name), bytes);
        console.log(`${name}: ${bytes.length} bytes, ${actual.slice(0, 19)} OK`);
    }
    console.log(`vendor/prebuilt: ${names.length} artifact(s) from ${lock.repo}@${lock.tag}`);
}

const updateIndex = process.argv.indexOf('--update');
if (updateIndex !== -1)
{
    const tag = process.argv[updateIndex + 1];
    if (!tag)
    {
        throw new Error('usage: fetch-video-decoder.mjs --update <release-tag>');
    }
    const repoIndex = process.argv.indexOf('--repo');
    const repo = repoIndex !== -1 ? process.argv[repoIndex + 1] : (await readLock()).repo;
    if (!repo)
    {
        throw new Error('the lock names no repository: pass --repo <owner/name>');
    }
    await update(repo, tag);
}
else
{
    await fetchPinned();
}
