/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Puts Cellar (https://github.com/bottlify/cellar), the cache every thread
 * of a run shares, into `vendor/cellar/`: its source files as they are (tests
 * and fixtures left out), and beside them the commit they were taken from and
 * their checksums. Core has no dependencies, so the cache it uses is files of
 * its own tree, bundled into the build as any other; Cellar's own project is
 * where they change. Kept as sources, not its built file, so their types and
 * comments come with them.
 *
 *   node scripts/vendor-cellar.mjs --from DIR            copy them from a
 *       checkout of Cellar
 *   node scripts/vendor-cellar.mjs --check [--from DIR]  fail when a file is
 *       not what its checksum says, or, given a checkout, not its source's
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT = join(ROOT, 'vendor', 'cellar');
const RECORD = join(OUT, 'cellar.json');

const args = process.argv.slice(2);
const at = args.indexOf('--from');
const from = at >= 0 ? resolve(args[at + 1]) : null;
const checking = args.includes('--check');
if (!checking && from === null)
{
    console.error('vendor-cellar: name a checkout of Cellar: --from DIR');
    process.exit(2);
}

/** @param {string} text */
const sha256 = text=>createHash('sha256').update(text).digest('hex');

/**
 * Cellar's source files in `dir`, by name: what ships of it.
 *
 * @param {string} dir @returns {Promise<Map<string, string>>}
 */
async function sources(dir){
    const names = (await readdir(join(dir, 'src'))).filter(name=>name.endsWith('.js')
        && !/\.(test|itest|fixture)\.js$/.test(name)).sort();
    return new Map(await Promise.all(names.map(async name=>
        /** @type {[string, string]} */ ([name, await readFile(join(dir, 'src', name), 'utf8')]))));
}

if (checking)
{
    const record = JSON.parse(await readFile(RECORD, 'utf8'));
    const kept = (await readdir(OUT)).filter(name=>name.endsWith('.js')).sort();
    /** @type {string[]} */
    const problems = [];
    if (kept.join() !== Object.keys(record.files ?? {}).sort().join())
    {
        problems.push(`files ${kept.join(', ')}; cellar.json names`
            + ` ${Object.keys(record.files ?? {}).join(', ')}`);
    }
    const files = from === null ? null : await sources(from);
    if (files !== null)
    {
        const manifest = JSON.parse(await readFile(join(from ?? '', 'package.json'), 'utf8'));
        if (record.version !== manifest.version)
        {
            problems.push(`cellar.json names version ${record.version}, the checkout`
                + ` ${manifest.version}`);
        }
    }
    for (const name of kept)
    {
        const text = await readFile(join(OUT, name), 'utf8');
        if (record.files?.[name] !== sha256(text))
        {
            problems.push(`${name}: not what cellar.json's checksum says`);
        }
        if (files !== null && files.get(name) !== text)
        {
            problems.push(`${name}: not the checkout's:`
                + ' run node scripts/vendor-cellar.mjs --from DIR');
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
    console.log(`vendor-cellar: cellar ${record.version} (${String(record.commit).slice(0, 8)}),`
        + ` ${kept.length} files, as`
        + ` ${files === null ? 'their checksums say' : 'the checkout has them'}`);
}
else
{
    const dir = /** @type {string} */ (from);
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    const files = await sources(dir);
    /** @param {string[]} gitArgs */
    const git = gitArgs=>execFileSync('git', ['-C', dir, ...gitArgs], { encoding: 'utf8' }).trim();
    const commit = git(['rev-parse', 'HEAD']);
    if (git(['status', '--porcelain', 'src', 'package.json']) !== '')
    {
        console.error('vendor-cellar: the checkout has changes not committed: commit them in'
            + ' Cellar first, so what is copied is a commit of it');
        process.exit(1);
    }
    await rm(OUT, { recursive: true, force: true });
    await mkdir(OUT, { recursive: true });
    for (const [name, text] of files)
    {
        await writeFile(join(OUT, name), text);
    }
    await writeFile(RECORD, `${JSON.stringify({
        name: manifest.name,
        version: manifest.version,
        source: 'https://github.com/bottlify/cellar',
        commit,
        files: Object.fromEntries([...files].map(([name, text])=>[name, sha256(text)])),
    }, null, 2)}\n`);
    console.log(`vendor-cellar: ${files.size} files of ${manifest.name} ${manifest.version}`
        + ` (${commit.slice(0, 8)}) in ${relative(ROOT, OUT)}`);
}
