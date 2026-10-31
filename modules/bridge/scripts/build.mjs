/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Builds the extension, unpacked: `dist/public/` for Bottlify's sites,
 * `dist/dev/` for a local launcher as well (src/manifest.js). The Steam
 * modules are core's, copied as they are with every core module they import,
 * at the same paths: one source, no second copy in git.
 *
 *   node scripts/build.mjs [out]
 */

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTS, PAGES, PLATFORMS, manifestFor } from '../src/manifest.js';

const HERE = fileURLToPath(new URL('..', import.meta.url));
// Core beside it in this repository, not the package node_modules names: a
// worktree's build takes its own core.
const CORE = resolve(HERE, '../core/src');

/**
 * Every core module `entry` reaches through static imports and re-exports, by
 * path under core's src: what the extension must carry for it to load. Listed
 * from the sources rather than by hand, so a module the Steam code comes to
 * import is carried without anyone remembering to add it.
 *
 * @param {string} entry  a path under core's src
 * @returns {Promise<string[]>}
 */
async function coreModules(entry){
    const found = new Set([entry]);
    const pending = [entry];
    while (pending.length > 0)
    {
        const at = /** @type {string} */ (pending.pop());
        const text = await readFile(join(CORE, at), 'utf8');
        for (const [, path] of text.matchAll(/(?:^|\s)from\s+'(\.{1,2}\/[^']+\.js)'/gm))
        {
            const name = posix.join(posix.dirname(at), path);
            if (!found.has(name))
            {
                found.add(name);
                pending.push(name);
            }
        }
    }
    return [...found].sort();
}

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
    const core = await coreModules('steam/index.js');
    for (const name of core)
    {
        files.push([join(CORE, name), name]);
    }
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
        const hosts = HOSTS[flavour];
        if (hosts)
        {
            const script = await readFile(join(HERE, 'src', 'content.js'), 'utf8');
            const blank = 'const HOSTS = /** @type {RegExp | null} */ (null);';
            if (!script.includes(blank))
            {
                throw new Error('content.js lost the line the build writes its hosts into');
            }
            await writeFile(join(dir, 'content.js'),
                script.replace(blank, ()=>`const HOSTS = new RegExp(${JSON.stringify(hosts)});`));
        }
        await writeFile(join(dir, 'manifest.json'),
            `${JSON.stringify(manifestFor(flavour, version, core), null, 2)}\n`);
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
