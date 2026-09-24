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
 * Fetches the nasm instruction corpus -- every case as an ELF image with the
 * register and memory state real hardware left behind, assembled and
 * fixtured by the emulator fork's CI -- into vendor/, verified against
 * corpus-lock.json. Test data for the translator's differential suites;
 * nothing in the product reads it.
 *
 * Usage:
 *   node scripts/fetch-corpus.mjs              download + verify against the lock
 *   node scripts/fetch-corpus.mjs --update TAG  re-pin the lock to a release tag
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const LOCK_FILE = join(ROOT, 'corpus-lock.json');
const OUT = join(ROOT, 'vendor');

/** @param {Uint8Array} bytes @returns {string} */
const sha256 = bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** @param {string} repo @param {string} tag @param {string} name */
async function download(repo, tag, name){
    const url = `https://github.com/${repo}/releases/download/${tag}/${name}`;
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok)
    {
        throw new Error(`${url}: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
}

/** @param {string} repo @param {string} tag */
async function update(repo, tag){
    const lock = JSON.parse(await readFile(LOCK_FILE, 'utf8'));
    const sums = new TextDecoder().decode(await download(repo, tag, 'SHA256SUMS'));
    const line = sums.split('\n').map(one=>one.trim().match(/^([0-9a-f]{64})\s+\*?(\S+)$/))
        .find(match=>match && match[2] === lock.asset);
    if (!line)
    {
        throw new Error(`${tag}'s SHA256SUMS does not list ${lock.asset}`);
    }
    const pinned = { repo, tag, asset: lock.asset, sha256: `sha256:${line[1]}` };
    await writeFile(LOCK_FILE, `${JSON.stringify(pinned, null, 2)}\n`);
    console.log(`corpus-lock.json pinned to ${repo}@${tag}`);
}

async function fetchPinned(){
    const lock = JSON.parse(await readFile(LOCK_FILE, 'utf8'));
    await mkdir(OUT, { recursive: true });
    const bytes = await download(lock.repo, lock.tag, lock.asset);
    const actual = sha256(bytes);
    if (actual !== lock.sha256)
    {
        throw new Error(`${lock.asset}: checksum mismatch\n`
            + `  expected ${lock.sha256}\n  got      ${actual}`);
    }
    await writeFile(join(OUT, lock.asset), bytes);
    console.log(`${lock.asset}: ${bytes.length} bytes, ${actual.slice(0, 19)}… OK`
        + ` (${lock.repo}@${lock.tag})`);
}

const updateIndex = process.argv.indexOf('--update');
if (updateIndex !== -1)
{
    const tag = process.argv[updateIndex + 1];
    if (!tag)
    {
        throw new Error('usage: fetch-corpus.mjs --update <release-tag>');
    }
    await update(process.env.V86_REPO ?? 'bottlify/v86', tag);
}
else
{
    await fetchPinned();
}
