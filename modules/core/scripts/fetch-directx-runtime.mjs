/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAsset, ghAvailable } from './lib/release-download.mjs';

/**
 * Fetches the DirectX End-User Runtime's 32-bit side-by-side DLLs into
 * vendor/prebuilt/directx/, verifying every file against directx-runtime-lock.json.
 *
 * A title that calls `D3DXCreateEffect` links against one of these, and on a
 * real machine it lives in `system32`, put there by the redistributable's own
 * `DXSETUP`. The engine plays that role: the DLLs are fetched once, mounted
 * read-only at `C:\WINDOWS\system32\`, and never committed -- like the video
 * decoder, they are someone else's binary and a build artifact.
 *
 * Two sources, in order:
 *
 *   1. A release this project owns, which is one request per DLL and what a
 *      developer should prefer. It is used when the lock names a `repo`/`tag`;
 *      `release-download.mjs` speaks the routes, credentials and all.
 *   2. Microsoft's own `directx_Jun2010_redist.exe`, the last End-User Runtime.
 *      The lock pins its SHA-256 and every DLL's, and the cabs are opened with
 *      the 7-Zip on the machine (`SEVENZIP` or the usual install) or, for a
 *      second fallback, the redist's own extractor plus `expand`.
 *
 * The lock is pinned from DLLs actually extracted; `--update` re-pins it from a
 * directory of extracted DLLs, or from a release's own SHA256SUMS when a
 * `--repo`/`--tag` is given.
 *
 * Usage:
 *   node scripts/fetch-directx-runtime.mjs                    download + verify
 *   node scripts/fetch-directx-runtime.mjs --update <dll-dir> re-pin from a directory
 *   node scripts/fetch-directx-runtime.mjs --update --repo R --tag T
 *       re-pin from a release's SHA256SUMS
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const LOCK_FILE = join(ROOT, 'directx-runtime-lock.json');
const OUT = join(ROOT, 'vendor', 'prebuilt', 'directx');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
const GH = ghAvailable();

/** @param {Uint8Array} bytes @returns {string} */
const sha256 = bytes=>`sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** @returns {Promise<any>} */
async function readLock(){
    return JSON.parse(await readFile(LOCK_FILE, 'utf8'));
}

/** @param {string} repo @param {string} tag @param {string} name */
const download = (repo, tag, name)=>
    downloadAsset({ repo, tag, name, token: TOKEN, ghAvailable: GH });

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

/** The basenames the lock may list, lower-cased, as the task's runtime set. */
const WANTED = [
    /^d3dx9_(2[4-9]|3[0-9]|4[0-3])\.dll$/,
    /^d3dx10_(3[3-9]|4[0-3])\.dll$/,
    /^d3dx11_(42|43)\.dll$/,
    /^d3dcompiler_(3[3-9]|4[0-3])\.dll$/,
    /^xinput1_[123]\.dll$/,
    /^x3daudio1_[0-7]\.dll$/,
    /^xactengine\d+_\d+\.dll$/,
    /^xapofx1_\d+\.dll$/,
    /^xaudio2_[0-7]\.dll$/,
];

/** @param {string} name @returns {boolean} */
export const isWanted = name=>WANTED.some(pattern=>pattern.test(name));

/**
 * Checks a set of extracted DLLs against the lock, all or nothing.
 *
 * The check is the product: a redist cut short, a cab that opened to a stub or
 * a file replaced in transit all arrive looking plausible, and only the digest
 * says whether what came out is what the lock pinned. It refuses the whole set
 * rather than installing the good ones, because a partial `system32` is a
 * machine that fails later with nothing pointing here.
 *
 * @param {Record<string, Uint8Array>} files     By lower-cased file name.
 * @param {Record<string, string>} artifacts     The lock's name -> digest.
 * @returns {number} how many files were verified.
 */
export function verifyExtracted(files, artifacts){
    let verified = 0;
    for (const [name, expected] of Object.entries(artifacts))
    {
        const bytes = files[name];
        if (!bytes)
        {
            throw new Error(`${name} is in the lock but not in the redistributable`);
        }
        const found = sha256(bytes);
        if (found !== expected)
        {
            throw new Error(`${name}: checksum mismatch\n`
                + `  expected ${expected}\n  got      ${found}`);
        }
        verified++;
    }
    return verified;
}

/**
 * The 7-Zip on this machine, for the routes that need to open a cab.
 *
 * @returns {string | null}
 */
function findSevenZip(){
    const candidates = [
        process.env.SEVENZIP,
        'C:\\Program Files\\7-Zip\\7z.exe',
        'C:\\Program Files (x86)\\7-Zip\\7z.exe',
        '7z',
    ].filter(Boolean);
    for (const candidate of /** @type {string[]} */ (candidates))
    {
        const probe = spawnSync(candidate, ['i'], { stdio: 'ignore' });
        if (!probe.error && probe.status === 0)
        {
            return candidate;
        }
    }
    return null;
}

/**
 * Runs a tool and throws with what it said when it did not succeed.
 *
 * @param {string} command @param {string[]} args @returns {string}
 */
function run(command, args){
    const result = spawnSync(command, args, { maxBuffer: 64 * 1024 * 1024 });
    if (result.error || result.status !== 0)
    {
        const detail = result.error?.message
            ?? String(result.stderr || result.stdout || '').trim();
        throw new Error(`${basename(command)} ${args.join(' ')} failed: ${detail}`);
    }
    return String(result.stdout);
}

/**
 * Opens the redist and every x86 cab it carries, and answers the directory the
 * DLLs landed in. 7-Zip recurses into the embedded cabinet in one pass and
 * unpacks each cab; without it, the redist's own extractor and `expand` are
 * tried, which Microsoft's switches may refuse on a machine without an
 * interactive session.
 *
 * @param {string} redist  A path to the downloaded redistributable.
 * @returns {Promise<string>}
 */
async function extractRedist(redist){
    const sevenZip = findSevenZip();
    const work = await mkdtemp(join(tmpdir(), 'directx-runtime-'));
    if (sevenZip)
    {
        const cabs = join(work, 'cabs');
        const dlls = join(work, 'dlls');
        await mkdir(cabs, { recursive: true });
        await mkdir(dlls, { recursive: true });
        run(sevenZip, ['x', '-y', `-o${cabs}`, redist]);
        for (const entry of await readdir(cabs))
        {
            if (!/_x86\.cab$/i.test(entry))
            {
                continue;
            }
            run(sevenZip, ['x', '-y', `-o${dlls}`, join(cabs, entry)]);
        }
        return dlls;
    }

    // The second route: the redist extracts itself to a directory, then the
    // system's expand opens each cab. Both are Windows binaries and both may
    // decline to run unattended; the error names the tool so it is clear which.
    const sfx = join(work, 'sfx');
    const dlls = join(work, 'dlls');
    await mkdir(sfx, { recursive: true });
    await mkdir(dlls, { recursive: true });
    run(redist, ['/Q', `/T:${sfx}`]);
    const expand = 'C:\\Windows\\System32\\expand.exe';
    for (const entry of await readdir(sfx))
    {
        if (!/_x86\.cab$/i.test(entry))
        {
            continue;
        }
        run(expand, ['-F:*', join(sfx, entry), dlls]);
    }
    return dlls;
}

/** Downloads the redist, verifies it and every wanted DLL, and installs them. */
async function fetchFromMicrosoft(lock){
    if (!lock.microsoftUrl)
    {
        throw new Error('directx-runtime-lock.json pins no release and no Microsoft URL');
    }
    const response = await fetch(lock.microsoftUrl, { redirect: 'follow' });
    if (!response.ok)
    {
        throw new Error(`${lock.microsoftUrl}: HTTP ${response.status}`);
    }
    const redist = new Uint8Array(await response.arrayBuffer());
    if (lock.redistSha256)
    {
        const found = sha256(redist);
        if (found !== lock.redistSha256)
        {
            throw new Error(`the redistributable does not match the lock\n`
                + `  expected ${lock.redistSha256}\n  got      ${found}`);
        }
    }

    const redistPath = join(await mkdtemp(join(tmpdir(), 'directx-redist-')),
        'directx_Jun2010_redist.exe');
    await writeFile(redistPath, redist);

    const extracted = await extractRedist(redistPath);
    const present = new Map((await readdir(extracted))
        .map(name=>[name.toLowerCase(), join(extracted, name)]));

    await mkdir(OUT, { recursive: true });
    /** @type {Record<string, Uint8Array>} */
    const bytes = {};
    for (const [name, path] of present)
    {
        if (name in lock.artifacts)
        {
            bytes[name] = new Uint8Array(await readFile(path));
        }
    }
    const written = verifyExtracted(bytes, lock.artifacts);
    for (const name of Object.keys(lock.artifacts))
    {
        await writeFile(join(OUT, name), bytes[name]);
    }
    await rm(join(redistPath, '..'), { recursive: true, force: true });
    console.log(`vendor/prebuilt/directx: ${written} DLLs from ${lock.microsoftUrl}`);
}

/** Downloads each DLL from the release the lock names and verifies it. */
async function fetchFromRelease(lock){
    const names = Object.keys(lock.artifacts ?? {});
    if (names.length === 0)
    {
        throw new Error('directx-runtime-lock.json lists no artifacts');
    }
    await mkdir(OUT, { recursive: true });
    for (const [name, expected] of Object.entries(lock.artifacts))
    {
        const bytes = await download(lock.repo, lock.tag, name);
        const found = sha256(bytes);
        if (found !== expected)
        {
            throw new Error(`${name}: checksum mismatch\n`
                + `  expected ${expected}\n  got      ${found}`);
        }
        await writeFile(join(OUT, name), bytes);
        console.log(`${name}: ${bytes.length} bytes, ${found.slice(0, 19)} OK`);
    }
    console.log(`vendor/prebuilt/directx: ${names.length} DLLs from ${lock.repo}@${lock.tag}`);
}

/**
 * Re-pins the lock from a release's own SHA256SUMS, or from a directory of
 * DLLs already extracted. The Microsoft URL and redist digest are carried over
 * so both sources stay described.
 *
 * @param {any} lock @param {string[]} args
 */
async function update(lock, args){
    const repoIndex = args.indexOf('--repo');
    const tagIndex = args.indexOf('--tag');
    const repo = repoIndex !== -1 ? args[repoIndex + 1] : lock.repo;
    const tag = tagIndex !== -1 ? args[tagIndex + 1] : lock.tag;
    if (repo && tag)
    {
        const sums = parseSums(
            new TextDecoder().decode(await download(repo, tag, 'SHA256SUMS')));
        const artifacts = Object.fromEntries(Object.entries(sums)
            .filter(([name])=>isWanted(name.toLowerCase()))
            .sort(([left], [right])=>left < right ? -1 : 1));
        if (Object.keys(artifacts).length === 0)
        {
            throw new Error(`no wanted DLLs parsed out of ${tag}'s SHA256SUMS`);
        }
        await writeFile(LOCK_FILE,
            `${JSON.stringify({ ...lock, repo, tag, artifacts }, null, 2)}\n`);
        console.log(`directx-runtime-lock.json pinned to ${repo}@${tag} `
            + `(${Object.keys(artifacts).length} DLLs)`);
        return;
    }

    const directory = args.find(argument=>!argument.startsWith('--')
        && argument !== repo && argument !== tag);
    if (!directory || !existsSync(directory))
    {
        throw new Error('usage: --update <dll-directory>  or  --update --repo R --tag T');
    }
    /** @type {Record<string, string>} */
    const artifacts = {};
    for (const entry of (await readdir(directory)).sort())
    {
        if (!isWanted(entry.toLowerCase()))
        {
            continue;
        }
        artifacts[entry.toLowerCase()] =
            sha256(new Uint8Array(await readFile(join(directory, entry))));
    }
    if (Object.keys(artifacts).length === 0)
    {
        throw new Error(`no wanted DLLs found in ${directory}`);
    }
    await writeFile(LOCK_FILE, `${JSON.stringify({ ...lock, artifacts }, null, 2)}\n`);
    console.log(`directx-runtime-lock.json pinned to ${Object.keys(artifacts).length} `
        + `DLLs from ${directory}`);
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked)
{
    const args = process.argv.slice(2);
    const updateIndex = args.indexOf('--update');
    const lock = await readLock();
    if (updateIndex !== -1)
    {
        await update(lock, args);
    }
    else if (lock.repo && lock.tag)
    {
        await fetchFromRelease(lock);
    }
    else
    {
        await fetchFromMicrosoft(lock);
    }
}
