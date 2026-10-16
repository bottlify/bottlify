#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A bottle already made, put through the rule a bottle is collected by now
 * (`@bottlify/installer`'s `collect`): what that rule leaves out -- a setup's
 * copy of its own package, the caches it keeps for a repair, the temporary
 * directories -- is dropped and the bundle packed again, with its manifest's
 * `bundle` record rewritten. Only a bottle mounted at the drive's root
 * (`root: "C:\\"`) is taken; one made by the older rules is left alone.
 *
 *   node tools/btl-prune.mjs <bottle directory> [--dry]
 */

import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openBundle, writeBundle } from './btl.mjs';
import { DRIVE_ROOT, collect } from '../modules/installer/src/prefix.js';

const args = process.argv.slice(2);
const directory = args.find(arg=>!arg.startsWith('--'));
const dry = args.includes('--dry');
if (!directory)
{
    console.error('usage: node tools/btl-prune.mjs <bottle directory> [--dry]');
    process.exit(2);
}
const manifestPath = join(directory, 'manifest.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.root !== DRIVE_ROOT)
{
    console.error(`${directory}: rooted at ${manifest.root ?? 'nothing'}, `
        + `not ${DRIVE_ROOT}; left alone`);
    process.exit(1);
}
const bundlePath = join(directory, manifest.bundle?.file ?? 'bundle.btl');
const bundle = await openBundle(bundlePath);
const listed = bundle.list();
const kept = new Set(collect({
    files: listed.map(file=>({ path: `${DRIVE_ROOT}${file.path}`, bytes: new Uint8Array(0) })),
}).files.map(file=>file.path));
const dropped = listed.filter(file=>!kept.has(file.path));
const droppedBytes = dropped.reduce((sum, file)=>sum + file.size, 0);
for (const file of dropped)
{
    console.log(`drop ${(file.size / 1048576).toFixed(1).padStart(7)} MB  ${file.path}`);
}
const droppedMegabytes = (droppedBytes / 1048576).toFixed(1);
console.log(`${dropped.length} of ${listed.length} files, ${droppedMegabytes} MB`);
if (dry || dropped.length === 0)
{
    await bundle.close();
    process.exit(0);
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
    console.log(`packed again: ${(packed.bytes / 1048576).toFixed(1)} MB`);
}
finally
{
    await rm(scratch, { recursive: true, force: true });
}
