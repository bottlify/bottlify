/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Puts Cellar (https://github.com/bottlify/cellar), the cache every thread of
 * a run shares, into `vendor/cellar/`: the build its release publishes
 * (`cellar.js`) and its declarations (`types/`), each checked against
 * `cellar-lock.json`. Core has no dependencies, so the cache it uses is a file
 * of its own tree, bundled into the build as any other; Cellar's own project
 * is where it changes, and a new release of it comes in by re-pinning the
 * lock. `npm install` runs this; files already as the lock says are left as
 * they are, so it needs the network only when the lock moved.
 *
 * Usage:
 *   node scripts/fetch-cellar.mjs               fetch what the lock pins
 *   node scripts/fetch-cellar.mjs --check       fail when vendor/cellar is not
 *       what the lock says (no network)
 *   node scripts/fetch-cellar.mjs --update TAG  re-pin the lock to a release,
 *       by that release's own checksums.json, and fetch it
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAsset, ghAvailable } from './lib/release-download.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const LOCK_FILE = join(ROOT, 'cellar-lock.json');
const OUT = join(ROOT, 'vendor', 'cellar');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;

/** What a release publishes besides its build: its declarations, as one archive. */
const TYPES_ARCHIVE = 'cellar-types.tar.gz';

/**
 * The declarations of `cellar.js`, beside it so a checked import of it finds
 * them: written here, not published, so not in the lock.
 */
const DECLARATIONS = ['cellar.d.ts', "export * from './types/index.js';\n"];

/** @typedef {{ repo: string, tag: string, files: Record<string, string> }} Lock */

/** @param {Uint8Array | string} bytes */
const sha256 = bytes=>createHash('sha256').update(bytes).digest('hex');

/** @returns {Promise<Lock>} */
const readLock = async()=>JSON.parse(await readFile(LOCK_FILE, 'utf8'));

/** @param {Lock} lock @param {string} name @returns {Promise<Uint8Array>} */
const download = (lock, name)=>downloadAsset({
    repo: lock.repo, tag: lock.tag, name, token: TOKEN, ghAvailable: ghAvailable(),
});

/**
 * What in vendor/cellar is not as the lock says, by file; nothing when all is.
 *
 * @param {Lock} lock @returns {Promise<string[]>}
 */
async function differences(lock){
    /** @type {string[]} */
    const problems = [];
    const expected = [...Object.entries(lock.files),
        [DECLARATIONS[0], sha256(DECLARATIONS[1])]];
    for (const [name, sum] of expected)
    {
        const bytes = await readFile(join(OUT, name)).catch(()=>null);
        if (bytes === null)
        {
            problems.push(`${name}: missing`);
        }
        else if (sha256(bytes) !== sum)
        {
            problems.push(`${name}: not what the lock pins`);
        }
    }
    return problems;
}

/**
 * The release's files the lock names, downloaded and checked, by name.
 *
 * @param {Lock} lock @returns {Promise<Map<string, Uint8Array>>}
 */
async function fetchRelease(lock){
    /** @type {Map<string, Uint8Array>} */
    const files = new Map();
    const scratch = await mkdtemp(join(tmpdir(), 'cellar-'));
    try
    {
        const archive = join(scratch, TYPES_ARCHIVE);
        await writeFile(archive, await download(lock, TYPES_ARCHIVE));
        execFileSync('tar', ['-xzf', archive, '-C', scratch]);
        for (const name of Object.keys(lock.files))
        {
            const bytes = name.startsWith('types/')
                ? await readFile(join(scratch, name)).catch(()=>{
                    throw new Error(`${name}: not in ${lock.tag}'s ${TYPES_ARCHIVE}`);
                })
                : await download(lock, name);
            if (sha256(bytes) !== lock.files[name])
            {
                throw new Error(`${name}: ${lock.repo}@${lock.tag} gave ${sha256(bytes)},`
                    + ` the lock pins ${lock.files[name]}`);
            }
            files.set(name, bytes);
        }
    }
    finally
    {
        await rm(scratch, { recursive: true, force: true });
    }
    return files;
}

/** @param {Lock} lock */
async function put(lock){
    const files = await fetchRelease(lock);
    await rm(OUT, { recursive: true, force: true });
    for (const [name, bytes] of [...files, [DECLARATIONS[0], DECLARATIONS[1]]])
    {
        await mkdir(dirname(join(OUT, name)), { recursive: true });
        await writeFile(join(OUT, name), bytes);
    }
    console.log(`fetch-cellar: ${lock.repo}@${lock.tag}, ${files.size} files in vendor/cellar`);
}

const args = process.argv.slice(2);
const updating = args.indexOf('--update');
if (updating >= 0)
{
    const tag = args[updating + 1];
    if (!tag)
    {
        throw new Error('usage: fetch-cellar.mjs --update <release-tag>');
    }
    const { repo } = await readLock();
    const sums = JSON.parse(new TextDecoder().decode(
        await download({ repo, tag, files: {} }, 'checksums.json')));
    /** @type {Lock} */
    const lock = {
        repo, tag,
        // The minified build is for pages that load Cellar alone; core
        // bundles the readable one and minifies its own build.
        files: Object.fromEntries(Object.entries(sums.files)
            .filter(([name])=>name === 'cellar.js' || name.startsWith('types/'))),
    };
    await put(lock);
    await writeFile(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);
    console.log(`fetch-cellar: cellar-lock.json pinned to ${repo}@${tag}`);
}
else
{
    const lock = await readLock();
    const problems = await differences(lock);
    if (args.includes('--check'))
    {
        if (problems.length > 0)
        {
            for (const problem of problems)
            {
                console.error(`fetch-cellar: ${problem}`);
            }
            console.error('fetch-cellar: run npm run fetch:cellar');
            process.exit(1);
        }
        console.log(`fetch-cellar: vendor/cellar is ${lock.repo}@${lock.tag}`);
    }
    else if (problems.length === 0)
    {
        console.log(`fetch-cellar: vendor/cellar is ${lock.repo}@${lock.tag} already`);
    }
    else
    {
        await put(lock);
    }
}
