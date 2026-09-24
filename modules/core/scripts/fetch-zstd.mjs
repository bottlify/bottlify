/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fetches the pinned zstd.wasm -- this project's own decoder, built by the
 * vendor workflow -- into vendor/prebuilt/, or re-pins the lock to a release.
 *
 *   node scripts/fetch-zstd.mjs                    the pinned bytes, checked
 *   node scripts/fetch-zstd.mjs --update <tag>     re-pin to a release's SHA256SUMS
 *
 * The same shape as fetch-video-decoder.mjs, the same download routes
 * (`lib/release-download.mjs`: the API with a token, the plain URL, then gh).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAsset, ghAvailable } from './lib/release-download.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const LOCK_FILE = join(ROOT, 'zstd-lock.json');
const OUT = join(ROOT, 'vendor', 'prebuilt');
const ARTIFACT = 'zstd.wasm';
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
const GH = ghAvailable();

/** @param {Uint8Array} bytes */
const sha256 = bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function readLock(){
    return JSON.parse(await readFile(LOCK_FILE, 'utf8'));
}

/** @param {string} repo @param {string} tag @param {string} name */
const download = (repo, tag, name)=>
    downloadAsset({ repo, tag, name, token: TOKEN, ghAvailable: GH });

/**
 * The artifact lines of a SHA256SUMS, only the one this lock pins.
 * @param {string} sums @returns {Record<string, string>}
 */
export function parseSums(sums){
    /** @type {Record<string, string>} */
    const artifacts = {};
    for (const line of sums.split('\n'))
    {
        const match = line.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/);
        if (match && match[2] === ARTIFACT)
        {
            artifacts[match[2]] = `sha256:${match[1]}`;
        }
    }
    return artifacts;
}

/** @param {string} repo @param {string} tag */
async function update(repo, tag){
    const artifacts = parseSums(
        new TextDecoder().decode(await download(repo, tag, 'SHA256SUMS')));
    if (Object.keys(artifacts).length === 0)
    {
        throw new Error(`${tag}'s SHA256SUMS names no ${ARTIFACT}`);
    }
    await writeFile(LOCK_FILE, `${JSON.stringify({ repo, tag, artifacts }, null, 2)}\n`);
    console.log(`zstd-lock.json pinned to ${repo}@${tag}`);
}

async function fetchPinned(){
    const lock = await readLock();
    const names = Object.keys(lock.artifacts ?? {});
    if (!lock.repo || !lock.tag || names.length === 0)
    {
        throw new Error(
            'zstd-lock.json pins no release yet. Dispatch the `vendor` workflow, then '
            + '`node scripts/fetch-zstd.mjs --update <tag>` -- or build it: '
            + '`npm run build:zstd -- --docker` (or `--native` with clang on PATH).');
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
}

const updateIndex = process.argv.indexOf('--update');
if (updateIndex !== -1)
{
    const tag = process.argv[updateIndex + 1];
    if (!tag)
    {
        throw new Error('usage: fetch-zstd.mjs --update <release-tag>');
    }
    const repoIndex = process.argv.indexOf('--repo');
    const repo = repoIndex !== -1 ? process.argv[repoIndex + 1] : (await readLock()).repo;
    if (!repo)
    {
        throw new Error('the lock names no repository: pass --repo <owner/name>');
    }
    await update(repo, tag);
}
else if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
{
    await fetchPinned();
}
