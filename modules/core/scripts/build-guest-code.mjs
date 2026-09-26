/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Compiles every `@guestCode` function under src/ into the module beside its
 * source: `inguest.js` into `inguest.x86.js`.
 *
 *   node scripts/build-guest-code.mjs           writes each module
 *   node scripts/build-guest-code.mjs --check   fails when one is not what
 *                                               its source compiles to
 *
 * The compiled modules are committed: the source tree runs as it is, with no
 * build, and the compiler's parser is a development dependency the running
 * product never loads. `npm run build` writes them again, and a unit test
 * beside each fails when one is stale.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileModule } from './guest-code/compile.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = join(ROOT, 'src');

/** A `@guestCode` tag at the start of a line of a comment. */
const TAG = /^\s*\*?\s*@guestCode\b/m;

/** @param {string} dir @param {string[]} [found] @returns {Promise<string[]>} */
async function sources(dir, found = []){
    for (const entry of await readdir(dir, { withFileTypes: true }))
    {
        const path = join(dir, entry.name);
        if (entry.isDirectory())
        {
            await sources(path, found);
        }
        else if (/\.m?js$/.test(entry.name) && !/\.(test|itest|x86)\.m?js$/.test(entry.name))
        {
            found.push(path);
        }
    }
    return found;
}

/**
 * Each source with `@guestCode` functions, and the module its x86 goes in.
 *
 * @param {string} [root]  Where to look; src/ by default.
 * @returns {Promise<{ source: string, target: string, text: string }[]>}
 */
export async function compileGuestCode(root = SRC){
    /** @type {{ source: string, target: string, text: string }[]} */
    const out = [];
    for (const source of (await sources(root)).sort())
    {
        const text = await readFile(source, 'utf8');
        if (!TAG.test(text))
        {
            continue;
        }
        const values = await import(pathToFileURL(source).href);
        const functions = compileModule(text, { file: relative(ROOT, source), values });
        if (functions.length === 0)
        {
            continue;
        }
        out.push({
            source,
            target: source.replace(/\.m?js$/, '.x86.js'),
            text: render(basename(source), functions),
        });
    }
    return out;
}

/**
 * The module the x86 is published in: a plain table, no imports.
 *
 * @param {string} from
 * @param {import('./guest-code/compile.mjs').CompiledFunction[]} functions
 */
export function render(from, functions){
    const lines = [
        '/*',
        ' * Copyright © 2026 Bottlify Project',
        ' * Licensed under the Mozilla Public License, version 2.0',
        ' * See LICENSE for details',
        ' */',
        '',
        `// The i386 of ${from}'s @guestCode functions, as \`npm run build\``,
        '// (scripts/build-guest-code.mjs) compiles them. Not edited by hand: a unit',
        '// test compiles the source again and fails when this differs.',
        '',
        'export const COMPILED = /** @type {const} */ ({',
    ];
    for (const fn of functions)
    {
        const quote = (/** @type {readonly string[]} */ list)=>
            `[${list.map(item=>`'${item}'`).join(', ')}]`;
        lines.push(`    ${fn.name}: {`);
        lines.push(`        convention: '${fn.convention}',`);
        lines.push(`        params: ${quote(fn.params)},`);
        lines.push(`        returns: '${fn.returns}',`);
        lines.push(`        uses: ${quote(fn.uses)},`);
        lines.push('        code: Uint8Array.of(');
        for (let at = 0; at < fn.code.length; at += 12)
        {
            const row = [...fn.code.subarray(at, at + 12)]
                .map(byte=>`0x${byte.toString(16).padStart(2, '0')}`);
            lines.push(`            ${row.join(', ')},`);
        }
        lines.push('        ),');
        lines.push('    },');
    }
    lines.push('});', '');
    return lines.join('\n');
}

/**
 * Writes each module, or with `check` answers which are stale.
 *
 * @param {{ check?: boolean }} [options]
 * @returns {Promise<string[]>}  The stale ones, relative to the package.
 */
export async function buildGuestCode({ check = false } = {}){
    /** @type {string[]} */
    const stale = [];
    for (const { target, text } of await compileGuestCode())
    {
        const current = await readFile(target, 'utf8').catch(()=>null);
        if (current === text)
        {
            continue;
        }
        stale.push(relative(ROOT, target));
        if (!check)
        {
            await writeFile(target, text);
        }
    }
    return stale;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
{
    const check = process.argv.includes('--check');
    const stale = await buildGuestCode({ check });
    if (check && stale.length > 0)
    {
        console.error(`guest code out of date: ${stale.join(', ')} (npm run build:guest-code)`);
        process.exit(1);
    }
    console.log(stale.length === 0 ? 'guest code: up to date'
        : `guest code: wrote ${stale.join(', ')}`);
}
