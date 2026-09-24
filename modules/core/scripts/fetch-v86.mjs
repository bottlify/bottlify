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
 * Fetches prebuilt v86 artifacts from a pinned release of our fork into
 * vendor/prebuilt/, verifying every file against vendor-lock.json.
 *
 * This exists because building v86 from source needs a toolchain (Rust +
 * wasm32, clang, a JRE for Closure) that a development machine often does not
 * have. The build itself runs in the fork's CI; this script only consumes its
 * output. `build-v86.mjs` remains the from-source path and stays authoritative
 * for reproducibility (`verify-reproducibility.mjs` in CI).
 *
 * Usage:
 *   node scripts/fetch-v86.mjs              download + verify against the lock
 *   node scripts/fetch-v86.mjs --update TAG  re-pin the lock to a release tag, then download
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const LOCK_FILE = join(ROOT, 'vendor-lock.json');
const OUT = join(ROOT, 'vendor', 'prebuilt');

/** @param {Uint8Array} bytes @returns {string} */
const sha256 = bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/**
 * @param {string} repo
 * @param {string} tag
 * @param {string} name
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

/** Re-pins vendor-lock.json to a release, using that release's SHA256SUMS. */
async function update(/** @type {string} */ repo, /** @type {string} */ tag){
    const sums = new TextDecoder().decode(await download(repo, tag, 'SHA256SUMS'));
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
    if (Object.keys(artifacts).length === 0)
    {
        throw new Error(`no artifacts parsed out of ${tag}'s SHA256SUMS`);
    }
    const lock = { repo, tag, artifacts };
    await writeFile(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`vendor-lock.json pinned to ${repo}@${tag} `
        + `(${Object.keys(artifacts).length} artifacts)`);
}

async function fetchPinned(){
    const lock = JSON.parse(await readFile(LOCK_FILE, 'utf8'));
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
        console.log(`${name}: ${bytes.length} bytes, ${actual.slice(0, 19)}… OK`);
    }
    console.log(`vendor/prebuilt: ${Object.keys(lock.artifacts).length} artifacts `
        + `from ${lock.repo}@${lock.tag}`);
}

const updateIndex = process.argv.indexOf('--update');
if (updateIndex !== -1)
{
    const tag = process.argv[updateIndex + 1];
    if (!tag)
    {
        throw new Error('usage: fetch-v86.mjs --update <release-tag>');
    }
    const repo = process.env.V86_REPO ?? 'mrwayer/v86';
    await update(repo, tag);
    // A re-pin that left the old artifacts in place once ran a whole
    // evening's tests against a build without the exports under test, every
    // one of them skipping politely: the download is part of the re-pin.
    await fetchPinned();
}
else
{
    await fetchPinned();
}
