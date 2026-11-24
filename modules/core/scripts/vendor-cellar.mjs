/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Puts Cellar, the cache every thread of a run shares, into
 * `vendor/cellar/`: its source files as they are (tests and fixtures left
 * out), and beside them what they were taken from and their checksums. Core
 * has no dependencies, so the cache it uses is files of its own tree, bundled
 * into the build as any other; Cellar's own project is where they change.
 * Kept as sources, not one built file, so their types and comments come with
 * them.
 *
 *   node scripts/vendor-cellar.mjs [--from DIR]   copy them
 *   node scripts/vendor-cellar.mjs --check        fail when a file is not
 *       its source's, or not what its checksum says
 *
 * `--from` names Cellar's checkout; the default is the sibling module of
 * this workspace.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'vendor', 'cellar');
const RECORD = join(OUT, 'cellar.json');

const args = process.argv.slice(2);
const at = args.indexOf('--from');
const from = resolve(at >= 0 ? args[at + 1] : join(ROOT, '..', 'cellar'));
const checking = args.includes('--check');

/** @param {string} text */
const sha256 = text=>createHash('sha256').update(text).digest('hex');

/** Cellar's source files, by name: what ships of it. @returns {Promise<Map<string, string>>} */
async function sources(){
    const names = (await readdir(join(from, 'src'))).filter(name=>name.endsWith('.js')
        && !/\.(test|itest|fixture)\.js$/.test(name)).sort();
    return new Map(await Promise.all(names.map(async name=>
        /** @type {[string, string]} */ ([name, await readFile(join(from, 'src', name), 'utf8')]))));
}

const manifest = JSON.parse(await readFile(join(from, 'package.json'), 'utf8'));
const files = await sources();
if (checking)
{
    const record = JSON.parse(await readFile(RECORD, 'utf8'));
    const kept = (await readdir(OUT)).filter(name=>name.endsWith('.js')).sort();
    /** @type {string[]} */
    const problems = [];
    if (record.version !== manifest.version)
    {
        problems.push(`cellar.json names version ${record.version}, the sources`
            + ` ${manifest.version}`);
    }
    if (kept.join() !== [...files.keys()].join())
    {
        problems.push(`files ${kept.join(', ')}; the sources have ${[...files.keys()].join(', ')}`);
    }
    for (const name of kept)
    {
        const text = await readFile(join(OUT, name), 'utf8');
        if (record.files?.[name] !== sha256(text))
        {
            problems.push(`${name}: not what cellar.json's checksum says`);
        }
        if (files.has(name) && files.get(name) !== text)
        {
            problems.push(`${name}: not its source's: run node scripts/vendor-cellar.mjs`);
        }
    }
    if (problems.length > 0)
    {
        for (const problem of problems)
        {
            console.error(`vendor-cellar: ${problem}`);
        }
        process.exit(1);
    }
    console.log(`vendor-cellar: cellar ${record.version}, ${kept.length} files, as its sources`);
}
else
{
    await rm(OUT, { recursive: true, force: true });
    await mkdir(OUT, { recursive: true });
    for (const [name, text] of files)
    {
        await writeFile(join(OUT, name), text);
    }
    await writeFile(RECORD, `${JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        source: relative(join(ROOT, '..', '..'), from) || from,
        files: Object.fromEntries([...files].map(([name, text])=>[name, sha256(text)])),
    }, null, 2)}\n`);
    console.log(`vendor-cellar: ${files.size} files of ${manifest.name} ${manifest.version}`
        + ` in ${relative(ROOT, OUT)}`);
}
