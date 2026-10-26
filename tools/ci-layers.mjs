/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

// Which packages a push asks CI to check, from the files it changed: the
// package a file is in, and every package that uses that file -- cork's are
// core's, since core runs it; core's are the installer's only where the
// installer reaches them, by the imports from what it takes of core
// (`@bottlify/core/bundle`, `/iso`, `/jpeg`, `/programs`), not core's whole tree.
// A file outside the packages, docs/ and roadmap/ -- the root's, tools/, the
// workflows -- is everyone's. Prints `name=true|false` a line, as a workflow
// step's output takes it.
//
//   git diff --name-only A B | node tools/ci-layers.mjs

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const LAYERS = Object.freeze(['cork', 'core', 'installer', 'networking']);

/** The package a path is in, or null. @param {string} path */
const layerOf = path=>/^modules\/([^/]+)\//.exec(path)?.[1] ?? null;

/**
 * The repository's files a module imports, followed through relative paths
 * and the packages' own exports: the files a change to which reaches it.
 *
 * @param {string[]} entries  repository-relative, with `/`
 * @param {(path: string) => string | null} read  a file's text, or null
 * @returns {Set<string>}
 */
export function importClosure(entries, read){
    const seen = new Set();
    const todo = [...entries];
    while (todo.length > 0)
    {
        const path = /** @type {string} */ (todo.pop());
        const text = seen.has(path) ? null : read(path);
        if (text === null)
        {
            continue;
        }
        seen.add(path);
        for (const [, specifier] of text.matchAll(
            /(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm))
        {
            const next = specifier.startsWith('.')
                ? join(dirname(path), specifier).replace(/\\/g, '/')
                : exported(specifier, read);
            if (next !== null && !seen.has(next))
            {
                todo.push(next);
            }
        }
    }
    return seen;
}

/**
 * A `@bottlify/<package>/<sub>` specifier's file in this repository, or null.
 *
 * @param {string} specifier @param {(path: string) => string | null} read
 */
function exported(specifier, read){
    const parts = /^@bottlify\/([^/]+)(\/.+)?$/.exec(specifier);
    const manifest = parts && read(`modules/${parts[1]}/package.json`);
    if (!parts || manifest === null)
    {
        return null;
    }
    const target = JSON.parse(manifest).exports?.[`.${parts[2] ?? ''}`];
    const file = typeof target === 'string' ? target : target?.import ?? target?.default;
    return typeof file === 'string' ? join(`modules/${parts[1]}`, file).replace(/\\/g, '/') : null;
}

/** What the installer takes of core: its imports of `@bottlify/core/...`, as files. */
const INSTALLER_TAKES = ['@bottlify/core/bundle', '@bottlify/core/iso', '@bottlify/core/jpeg',
    '@bottlify/core/programs'];

/**
 * @param {string[]} changed  repository-relative paths, with `/`
 * @param {(path: string) => string | null} read
 * @returns {Record<string, boolean>}
 */
export function layersFor(changed, read){
    const files = changed.map(path=>path.trim()).filter(Boolean);
    const everyone = files.some(path=>!/^(modules\/[^/]+\/|docs\/|roadmap\/)/.test(path)
        || (layerOf(path) !== null && !LAYERS.includes(/** @type {string} */ (layerOf(path)))));
    if (everyone)
    {
        return Object.fromEntries(LAYERS.map(name=>[name, true]));
    }
    const touched = (/** @type {string} */ name)=>files.some(path=>layerOf(path) === name);
    const cork = touched('cork');
    const core = cork || touched('core');
    const reached = core ? importClosure(INSTALLER_TAKES.map(one=>exported(one, read))
        .filter(path=>path !== null), read) : new Set();
    const installer = touched('installer') || files.some(path=>reached.has(path));
    return { cork, core, installer, networking: touched('networking') };
}

/** @param {string} path */
const readHere = path=>{
    const full = join(ROOT, path);
    return existsSync(full) && relative(ROOT, full).split(/[\\/]/)[0] !== '..'
        ? readFileSync(full, 'utf8') : null;
};

if (process.argv[1] === fileURLToPath(import.meta.url))
{
    const answer = layersFor(readFileSync(0, 'utf8').split('\n'), readHere);
    for (const name of LAYERS)
    {
        console.log(`${name}=${answer[name]}`);
    }
}
