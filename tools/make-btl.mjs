/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * Packs a game directory into a bundle.
 *
 * Two files come out, and the split is the point: `bundle.btl` is the game and
 * only the game, and `manifest.json` is everything said *about* it. A title, a
 * description, a cover, a version -- all of that changes for reasons that have
 * nothing to do with the bytes, and a format carrying it inside would mean
 * rewriting gigabytes to fix a typo.
 *
 * Usage:
 *   node tools/make-btl.mjs pack <game-directory> <bundle-id> [--store] [--block=N]
 *   node tools/make-btl.mjs verify <bundle-id>
 *   node tools/make-btl.mjs list <bundle-id> [pattern]
 */

import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openBundle, verifyBundle, writeBundle, ensureDirectory, DEFAULT_BLOCK_SIZE }
    from './btl.mjs';

const BUNDLES = 'bundles';

/** @param {number} bytes */
const mib = bytes=>`${(bytes / 2 ** 20).toFixed(1)} MiB`;

/** @param {string[]} argv */
function parseFlags(argv){
    /** @type {Record<string, string | boolean>} */
    const flags = {};
    for (const argument of argv)
    {
        if (!argument.startsWith('--'))
        {
            continue;
        }
        const [name, value] = argument.slice(2).split('=');
        flags[name] = value ?? true;
    }
    return flags;
}

/**
 * The entry point a program is started from: the largest executable that is not
 * a launcher or an installer. A guess, and the manifest is where it is corrected
 * by hand -- which is the whole reason the manifest is a separate file.
 *
 * @param {{ path: string, size: number }[]} files
 */
function guessEntry(files){
    const executables = files
        .filter(file=>file.path.toLowerCase().endsWith('.exe'))
        .filter(file=>!/(unins|setup|install|patch|repair|launcher)/i.test(file.path))
        .sort((a, b)=>b.size - a.size);
    return executables[0]?.path ?? null;
}

/**
 * @param {string} root
 * @param {string} id
 * @param {Record<string, any>} flags
 */
async function pack(root, id, flags){
    const directory = join(BUNDLES, id);
    await ensureDirectory(directory);
    const output = join(directory, 'bundle.btl');

    const blockSize = flags.block ? Number(flags.block) : DEFAULT_BLOCK_SIZE;
    const started = Date.now();
    let lastReport = 0;

    const summary = await writeBundle({
        root,
        output,
        blockSize,
        store: Boolean(flags.store),
        onProgress: progress=>{
            const now = Date.now();
            if (now - lastReport < 2000)
            {
                return;
            }
            lastReport = now;
            const rate = progress.rawTotal / ((now - started) / 1000) / 2 ** 20;
            process.stdout.write(`  ${mib(progress.rawTotal)} read, `
                + `${mib(progress.packedTotal)} written, ${rate.toFixed(0)} MiB/s\r`);
        },
    });

    const seconds = (Date.now() - started) / 1000;
    process.stdout.write(' '.repeat(72) + '\r');
    console.log(`${output}`);
    console.log(`  ${summary.files} files, ${summary.directories} empty directories`);
    console.log(`  ${mib(summary.uncompressedBytes)} -> ${mib(summary.bytes)} `
        + `(${(summary.ratio * 100).toFixed(1)}%), in ${seconds.toFixed(0)}s`);
    console.log(`  ${summary.totalBlocks - summary.storedBlocks} of ${summary.totalBlocks} `
        + `blocks compressed; index ${mib(summary.indexBytes)}`);

    // Written only if there is not one already: the manifest is edited by hand
    // and a rebuild of the bundle must not throw that away.
    const manifestPath = join(directory, 'manifest.json');
    const existing = await readFile(manifestPath, 'utf8').catch(()=>null);
    const manifest = existing
        ? JSON.parse(existing)
        : {
            id,
            title: id,
            description: '',
            version: '',
            cover: '',
            entry: null,
        };

    const bundle = await openBundle(output);
    manifest.entry ??= guessEntry(bundle.list());
    await bundle.close();

    manifest.bundle = {
        file: 'bundle.btl',
        format: summary.format,
        // What the bundle was written with, so a reader knows what it must be
        // able to decode before it starts -- and so a later bundle can use a
        // different codec without the format changing.
        codec: flags.store ? 'stored' : 'deflate-raw',
        blockSize: summary.blockSize,
        bytes: summary.bytes,
        uncompressedBytes: summary.uncompressedBytes,
        files: summary.files,
        sha256: summary.sha256,
        // The chain that makes a block's checksum worth anything: this digest
        // is checked against the index the reader fetched, and the index then
        // vouches for every block. Only this link has to come from outside the
        // container, and only this one is small enough to check every launch.
        indexSha256: summary.indexSha256,
    };

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
    console.log(`  manifest: ${manifestPath}`);
}

/** @param {string} id */
async function verify(id){
    const path = join(BUNDLES, id, 'bundle.btl');
    const started = Date.now();
    const { checked, bad } = await verifyBundle(path, progress=>{
        if (progress.checked % 10 === 0)
        {
            process.stdout.write(`  ${progress.checked}/${progress.total}\r`);
        }
    });
    process.stdout.write(' '.repeat(40) + '\r');
    const seconds = (Date.now() - started) / 1000;
    console.log(`${path}: ${checked} files checked in ${seconds.toFixed(0)}s, `
        + `${bad.length} corrupt`);
    for (const corrupt of bad)
    {
        console.log(`  BAD ${corrupt}`);
    }
    if (bad.length > 0)
    {
        process.exitCode = 1;
    }
}

/** @param {string} id @param {string} [pattern] */
async function list(id, pattern){
    const bundle = await openBundle(join(BUNDLES, id, 'bundle.btl'));
    const match = pattern ? new RegExp(pattern, 'i') : null;
    for (const file of bundle.list())
    {
        if (!match || match.test(file.path))
        {
            console.log(`  ${String(file.size).padStart(12)}  ${file.path}`);
        }
    }
    await bundle.close();
}

const [, , command, ...rest] = process.argv;
const flags = parseFlags(rest);
const positional = rest.filter(argument=>!argument.startsWith('--'));

switch (command){
    case 'pack':
        await pack(positional[0], positional[1], flags);
        break;
    case 'verify':
        await verify(positional[0]);
        break;
    case 'list':
        await list(positional[0], positional[1]);
        break;
    default:
        console.log('usage: node tools/make-btl.mjs pack <game-directory> <bundle-id> '
            + '[--store] [--block=N]');
        console.log('       node tools/make-btl.mjs verify <bundle-id>');
        console.log('       node tools/make-btl.mjs list <bundle-id> [pattern]');
        process.exitCode = 1;
}
