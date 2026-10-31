/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Builds the extension, unpacked: `dist/public/` for Bottlify's sites,
 * `dist/dev/` for a local launcher as well (src/manifest.js). Its entry points
 * and every module they import are copied as they are, each at its path under
 * `modules/` -- GameHub's own under `bridge/`, the core formats it reads under
 * `core/` -- so a relative import between the two holds in the build as in the
 * repository: one source, no second copy in git.
 *
 *   node scripts/build.mjs [out]
 */

import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRIES, HOSTS, PAGES, PLATFORMS, manifestFor } from '../src/manifest.js';

const HERE = fileURLToPath(new URL('..', import.meta.url));
// The modules beside it in this repository, not the packages node_modules
// names: a worktree's build takes its own core.
const MODULES = resolve(HERE, '..');

/**
 * Modules and every module they import, by path under `modules/`.
 *
 * @param {string[]} entries  `bridge/src/worker.js`, ...
 * @returns {Promise<string[]>}
 */
export async function closure(entries){
    /** @type {Set<string>} */
    const seen = new Set();
    const pending = [...entries];
    while (pending.length > 0)
    {
        const path = /** @type {string} */ (pending.pop());
        if (seen.has(path))
        {
            continue;
        }
        seen.add(path);
        if (path.startsWith('..'))
        {
            throw new Error(`a module reaches ${path}, outside modules/`);
        }
        const code = (await readFile(join(MODULES, path), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
        for (const [, specifier] of code.matchAll(
            /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*['"](\.{1,2}\/[^'"]+)['"]/g))
        {
            pending.push(posix.normalize(posix.join(posix.dirname(path), specifier)));
        }
    }
    return [...seen].sort();
}

/**
 * @param {string} [out]
 * @returns {Promise<Record<string, string>>}  Each build's directory.
 */
export async function build(out = join(HERE, 'dist')){
    const { version } = JSON.parse(await readFile(join(HERE, 'package.json'), 'utf8'));
    /** @type {[string, string][]} */
    const files = (await closure([...ENTRIES])).map(path=>[join(MODULES, path), path]);
    for (const platform of Object.values(PLATFORMS))
    {
        files.push([join(HERE, platform.rules), `bridge/${platform.rules}`]);
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
            const script = await readFile(join(MODULES, 'bridge/src/content.js'), 'utf8');
            const blank = 'const HOSTS = /** @type {RegExp | null} */ (null);';
            if (!script.includes(blank))
            {
                throw new Error('content.js lost the line the build writes its hosts into');
            }
            await writeFile(join(dir, 'bridge/src/content.js'),
                script.replace(blank, ()=>`const HOSTS = new RegExp(${JSON.stringify(hosts)});`));
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
