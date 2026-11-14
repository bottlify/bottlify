/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
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
 *   node tools/bundles/make-btl.mjs pack <game-directory> <bundle-id> [--store] [--block=N]
 *       [--entry=<path-in-bundle>] [--root=<install-directory>]
 *   node tools/bundles/make-btl.mjs verify <bundle-id>
 *   node tools/bundles/make-btl.mjs list <bundle-id> [pattern]
 *   node tools/bundles/make-btl.mjs translations <bundle-id> (<seed-file> | --remove) [--store]
 *   node tools/bundles/make-btl.mjs extract <bundle-id> [<file-in-bundle>] [--out=<path>]
 *   node tools/bundles/make-btl.mjs tree <bundle-id> [depth]
 *   node tools/bundles/make-btl.mjs prune <bundle-id> [--dry]
 *   node tools/bundles/make-btl.mjs zip list <archive.zip> [--depth=N]
 *   node tools/bundles/make-btl.mjs zip extract <archive.zip> <out-directory> [--prefix=<folder>]
 *
 * `--entry` names the program to start (otherwise guessed, below); `--root` is
 * where an installer put the tree, `C:\Program Files\Vendor\Game` -- what
 * `install-watch.mjs --collect` reports -- and the bottle is mounted there
 * rather than at `C:\App`, so the paths the installation wrote into the
 * registry hold. Both go into the manifest and stay there across a repack.
 *
 * `translations` puts a translation seed (a run's store, exported) into the
 * packed bundle without packing the game again, and rewrites the manifest's
 * `indexSha256`, which the new index changes.
 *
 * `extract` copies one file out of the bundle: by default the manifest's
 * `entry` to `bundles/<id>/entry`, the address a player page fetches the
 * program's image from -- `createApp` takes the image as bytes, and a page on a
 * static host has no server to read it out of the bundle for it.
 *
 * `tree` is what a bottle carries by directory, to a depth (3), largest first:
 * what an installation left that is not the program -- a setup's cache, a copy
 * of its own package -- is seen at once. `prune` puts a bottle made earlier
 * through the rule a bottle is collected by now (`@bottlify/installer`'s
 * `collect`): what that rule leaves out is dropped and the bundle packed again,
 * its manifest's `bundle` record rewritten (`--dry` lists it only). Only a
 * bottle mounted at the drive's root is taken; one made by the older rules is
 * left alone.
 *
 * `zip` lists or unpacks a zip of any size entry by entry, disk to disk
 * (zip-extract.mjs): an installed game shipped as a zip, tens of gigabytes, more
 * than the installer's in-memory reader holds, unpacked into a game directory to pack.
 */

import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DRIVE_ROOT, collect } from '../../modules/installer/src/prefix.js';
import { attachTranslations, openBundle, verifyBundle, writeBundle, ensureDirectory,
    DEFAULT_BLOCK_SIZE }
    from '../lib/btl.mjs';
import { BUNDLES_DIR } from '../lib/common.mjs';


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
    const directory = join(BUNDLES_DIR, id);
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

    if (typeof flags.entry === 'string')
    {
        manifest.entry = flags.entry.replace(/\//g, '\\');
    }
    if (typeof flags.root === 'string')
    {
        manifest.root = flags.root;
    }

    // Each packing is a new revision of the bottle: a session saved under an
    // earlier one takes this one's registry over its own.
    manifest.revision = (Number.isInteger(manifest.revision) ? manifest.revision : 0) + 1;

    const bundle = await openBundle(output);
    manifest.entry ??= guessEntry(bundle.list());
    if (bundle.stat(manifest.entry ?? '') === null)
    {
        console.log(`  the entry ${manifest.entry} is not in the bundle: set "entry" in the`
            + ' manifest');
    }
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
    // The image `extract` took out of the last bundle: the new one may name
    // another, or hold another build of it.
    await rm(join(directory, 'entry'), { force: true });
}

/** @param {string} id */
async function verify(id){
    const path = join(BUNDLES_DIR, id, 'bundle.btl');
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

/**
 * Puts a translation seed into a packed bundle, or takes it out (`--remove`),
 * and writes the index's new digest into the manifest.
 *
 * @param {string} id @param {string | undefined} seedPath @param {Record<string, any>} flags
 */
async function translations(id, seedPath, flags){
    const directory = join(BUNDLES_DIR, id);
    const seed = flags.remove ? null : new Uint8Array(await readFile(String(seedPath)));
    const result = await attachTranslations(join(directory, 'bundle.btl'), seed,
        { store: Boolean(flags.store) });
    const manifestPath = join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.bundle = { ...manifest.bundle, bytes: result.bytes, indexSha256: result.indexSha256 };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
    console.log(result.translations
        ? `${id}: translations ${mib(result.translations.size)} in `
            + `${result.translations.blocks} blocks; index ${result.indexSha256}`
        : `${id}: no translations; index ${result.indexSha256}`);
}

/** @param {string} id @param {string} [pattern] */
async function list(id, pattern){
    const bundle = await openBundle(join(BUNDLES_DIR, id, 'bundle.btl'));
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

/**
 * @param {string} id @param {string | undefined} file
 * @param {Record<string, any>} flags
 */
async function extract(id, file, flags){
    const directory = join(BUNDLES_DIR, id);
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
    const path = file ?? manifest.entry;
    if (typeof path !== 'string' || path === '')
    {
        throw new Error(`${id}: no file named and no entry in the manifest`);
    }
    const out = typeof flags.out === 'string' ? flags.out
        : file === undefined ? join(directory, 'entry') : join(directory, basename(path));
    const bundle = await openBundle(join(directory, 'bundle.btl'));
    try
    {
        // The index is read case-blind and backslashed, as the guest names files.
        const bytes = await bundle.read(path.replace(/\//g, '\\'));
        await writeFile(out, bytes);
        console.log(`${out}: ${path}, ${bytes.length} bytes`);
    }
    finally
    {
        await bundle.close();
    }
}

/** @param {string} id @param {string} [depthText] */
async function tree(id, depthText){
    const depth = Number(depthText ?? 3);
    const bundle = await openBundle(join(BUNDLES_DIR, id, 'bundle.btl'));
    /** @type {Map<string, { files: number, bytes: number }>} */
    const groups = new Map();
    for (const file of bundle.list())
    {
        const key = file.path.split('\\').slice(0, Math.max(1, depth)).join('\\');
        const group = groups.get(key) ?? { files: 0, bytes: 0 };
        group.files += 1;
        group.bytes += file.size;
        groups.set(key, group);
    }
    const total = bundle.list().reduce((sum, file)=>sum + file.size, 0);
    /** @param {number} bytes @param {number} files @param {string} what */
    const line = (bytes, files, what)=>
        `${mib(bytes).padStart(12)} ${String(files).padStart(5)}  ${what}`;
    for (const [key, group] of [...groups].sort((a, b)=>b[1].bytes - a[1].bytes))
    {
        console.log(line(group.bytes, group.files, key));
    }
    console.log(line(total, bundle.list().length, 'total'));
    await bundle.close();
}

/** @param {string} id @param {Record<string, any>} flags */
async function prune(id, flags){
    const directory = join(BUNDLES_DIR, id);
    const manifestPath = join(directory, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.root !== DRIVE_ROOT)
    {
        console.error(`${id}: rooted at ${manifest.root ?? 'nothing'}, not ${DRIVE_ROOT};`
            + ' left alone');
        process.exitCode = 1;
        return;
    }
    const bundlePath = join(directory, manifest.bundle?.file ?? 'bundle.btl');
    const bundle = await openBundle(bundlePath);
    const listed = bundle.list();
    const kept = new Set(collect({
        files: listed.map(file=>({ path: `${DRIVE_ROOT}${file.path}`, bytes: new Uint8Array(0) })),
    }).files.map(file=>file.path));
    const dropped = listed.filter(file=>!kept.has(file.path));
    for (const file of dropped)
    {
        console.log(`drop ${mib(file.size).padStart(12)}  ${file.path}`);
    }
    console.log(`${dropped.length} of ${listed.length} files, `
        + `${mib(dropped.reduce((sum, file)=>sum + file.size, 0))}`);
    if (flags.dry || dropped.length === 0)
    {
        await bundle.close();
        return;
    }
    const scratch = await mkdtemp(join(tmpdir(), 'btl-prune-'));
    try
    {
        for (const file of listed.filter(one=>kept.has(one.path)))
        {
            const target = join(scratch, ...file.path.split('\\'));
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, await bundle.read(file.path));
        }
        await bundle.close();
        const packed = await writeBundle({ root: scratch, output: `${bundlePath}.new` });
        await rename(`${bundlePath}.new`, bundlePath);
        manifest.bundle = { ...manifest.bundle, ...packed };
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
        console.log(`packed again: ${mib(packed.bytes)}`);
    }
    finally
    {
        await rm(scratch, { recursive: true, force: true });
    }
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
    case 'translations':
        await translations(positional[0], positional[1], flags);
        break;
    case 'extract':
        await extract(positional[0], positional[1], flags);
        break;
    case 'tree':
        await tree(positional[0], positional[1]);
        break;
    case 'prune':
        await prune(positional[0], flags);
        break;
    case 'zip':
    {
        // The zip reader takes its own command line, as though it ran alone.
        const reader = new URL('./zip-extract.mjs', import.meta.url);
        process.argv = [process.argv[0], fileURLToPath(reader), ...rest];
        await import(reader.href);
        break;
    }
    default:
        console.log('usage: node tools/bundles/make-btl.mjs pack <game-directory> <bundle-id> '
            + '[--store] [--block=N] [--entry=<path>] [--root=<install-directory>]');
        console.log('       node tools/bundles/make-btl.mjs verify <bundle-id>');
        console.log('       node tools/bundles/make-btl.mjs list <bundle-id> [pattern]');
        console.log('       node tools/bundles/make-btl.mjs translations <bundle-id> '
            + '(<seed-file> | --remove) [--store]');
        console.log('       node tools/bundles/make-btl.mjs extract <bundle-id> [<file-in-bundle>] '
            + '[--out=<path>]');
        console.log('       node tools/bundles/make-btl.mjs tree <bundle-id> [depth]');
        console.log('       node tools/bundles/make-btl.mjs prune <bundle-id> [--dry]');
        console.log('       node tools/bundles/make-btl.mjs zip list|extract <archive.zip> ...');
        process.exitCode = 1;
}
