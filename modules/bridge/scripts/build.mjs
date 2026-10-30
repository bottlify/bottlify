/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Builds the extension, unpacked: `dist/public/` for Bottlify's sites,
 * `dist/dev/` for a local launcher as well (src/manifest.js). The Steam
 * modules are core's, copied as they are: one source, no second copy in git.
 *
 *   node scripts/build.mjs [out]
 */

import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGES, PLATFORMS, manifestFor } from '../src/manifest.js';

const HERE = fileURLToPath(new URL('..', import.meta.url));
// Core beside it in this repository, not the package node_modules names: a
// worktree's build takes its own core.
const CORE = resolve(HERE, '../core/src');

/**
 * @param {string} [out]
 * @returns {Promise<Record<string, string>>}  Each build's directory.
 */
export async function build(out = join(HERE, 'dist')){
    const { version } = JSON.parse(await readFile(join(HERE, 'package.json'), 'utf8'));
    /** @type {[string, string][]} */
    const files = ['content.js', 'worker.js', 'bridge.js', 'protocol.js']
        .map(name=>[join(HERE, 'src', name), name]);
    for (const platform of Object.values(PLATFORMS))
    {
        files.push([join(HERE, platform.rules), platform.rules]);
    }
    for (const name of await readdir(join(CORE, 'steam')))
    {
        if (name.endsWith('.js') && !name.endsWith('.test.js'))
        {
            files.push([join(CORE, 'steam', name), `steam/${name}`]);
        }
    }
    files.push([join(CORE, 'zstd.js'), 'zstd.js']);
    /** @type {Record<string, string>} */
    const built = {};
    for (const flavour of /** @type {(keyof typeof PAGES)[]} */ (Object.keys(PAGES)))
    {
        const dir = join(out, flavour);
        await rm(dir, { recursive: true, force: true });
        for (const [from, to] of files)
        {
            await mkdir(dirname(join(dir, to)), { recursive: true });
            await copyFile(from, join(dir, to));
        }
        await writeFile(join(dir, 'manifest.json'),
            `${JSON.stringify(manifestFor(flavour, version), null, 2)}\n`);
        built[flavour] = dir;
    }
    return built;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
{
    for (const [flavour, dir] of Object.entries(await build(process.argv[2])))
    {
        console.log(`${flavour}: ${dir}`);
    }
}
