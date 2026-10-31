/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Compiles every `@guestCode` function under src/ into the module beside its
 * source: `inguest.js` into `inguest.x86.js`, and, for the modules `LONG`
 * names, into the x86-64 of `inguest.x64.js` too.
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
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compileModule } from './guest-code/compile.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = join(ROOT, 'src');

/** A `@guestCode` tag at the start of a line of a comment. */
const TAG = /^\s*\*?\s*@guestCode\b/m;

/**
 * The modules a 64-bit process takes x86-64 code from, by their path under
 * src/, and the functions of each it does not with why: a function whose
 * memory holds a pointer is laid out for 32 bits in its source, and is its
 * handler's trap at 64 bits, as everything the compiler refuses there is.
 * A module not named here -- a structure of 32-bit pointers, a `va_list` of
 * 4-byte slots, a double passed as two words -- has no x86-64 at all.
 *
 * @type {ReadonlyMap<string, Readonly<Record<string, string>>>}
 */
export const LONG = new Map([
    ['layers/win32/msvcrt/inguest.js', {
        strtol: '`*end` is a pointer, eight bytes at 64 bits, which the source writes as four',
        strtoul: '`*end` is a pointer, eight bytes at 64 bits, which the source writes as four',
    }],
]);

/** @param {string} dir @param {string[]} [found] @returns {Promise<string[]>} */
async function sources(dir, found = []){
    for (const entry of await readdir(dir, { withFileTypes: true }))
    {
        const path = join(dir, entry.name);
        if (entry.isDirectory())
        {
            await sources(path, found);
        }
        else if (/\.m?js$/.test(entry.name) && !/\.(test|itest|x86|x64)\.m?js$/.test(entry.name))
        {
            found.push(path);
        }
    }
    return found;
}

/**
 * Each source with `@guestCode` functions, and the module its x86 goes in --
 * and, for one `LONG` names, the module its x86-64 goes in.
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
        const file = relative(ROOT, source);
        const functions = compileModule(text, { file, values });
        if (functions.length === 0)
        {
            continue;
        }
        out.push({
            source,
            target: source.replace(/\.m?js$/, '.x86.js'),
            text: render(basename(source), functions),
        });
        const leftOut = LONG.get(relative(SRC, source).split(sep).join('/'));
        if (leftOut === undefined)
        {
            continue;
        }
        /** @type {Record<string, string>} */
        const refused = {};
        const long = compileModule(text, { file, values, bits: 64, refuse: leftOut,
            // The reason without its place, which moves as the source does.
            onRefused: (name, reason)=>{
                refused[name] = reason.replace(/^[^:]*:\d+:\d+: /, '')
                    .replace(new RegExp(`^${name}: `), '');
            } });
        out.push({
            source,
            target: source.replace(/\.m?js$/, '.x64.js'),
            text: render(basename(source), long, refused),
        });
    }
    return out;
}

/**
 * The module the code is published in: a plain table, no imports -- and, for
 * x86-64 code, the functions it has none of and why.
 *
 * @param {string} from
 * @param {import('./guest-code/compile.mjs').CompiledFunction[]} functions
 * @param {Record<string, string>} [refused]  Given for x86-64 code.
 */
export function render(from, functions, refused){
    const lines = [
        '/*',
        ' * Copyright © 2026 Bottlify Project',
        ' * Licensed under the Mozilla Public License, version 2.0',
        ' * See LICENSE for details',
        ' */',
        '',
        ...refused === undefined ? [
            `// The i386 of ${from}'s @guestCode functions, as \`npm run build\``,
            '// (scripts/build-guest-code.mjs) compiles them. Not edited by hand: a unit',
            '// test compiles the source again and fails when this differs.',
        ] : [
            `// The x86-64 of ${from}'s @guestCode functions, for a 64-bit process, as`,
            '// `npm run build` (scripts/build-guest-code.mjs) compiles them under the x64',
            '// convention. Not edited by hand: a unit test compiles the source again and',
            '// fails when this differs.',
        ],
        '',
        'export const COMPILED = /** @type {const} */ ({',
    ];
    for (const fn of functions)
    {
        const quote = (/** @type {readonly string[]} */ list)=>
            `[${list.map(item=>`'${item}'`).join(', ')}]`;
        /**
         * A field of names, on its line or wrapped within a hundred columns, as
         * the lint holds the file to.
         *
         * @param {string} label @param {readonly string[]} list
         */
        const field = (label, list)=>{
            const one = `        ${label}: ${quote(list)},`;
            if (one.length <= 100)
            {
                return [one];
            }
            const wrapped = [`        ${label}: [`];
            let line = '           ';
            for (const item of list)
            {
                const next = `${line} '${item}',`;
                if (next.length > 100)
                {
                    wrapped.push(line);
                    line = `            '${item}',`;
                }
                else
                {
                    line = next;
                }
            }
            return [...wrapped, line, '        ],'];
        };
        lines.push(`    ${fn.name}: {`);
        lines.push(`        convention: '${fn.convention}',`);
        lines.push(...field('params', fn.params));
        lines.push(`        returns: '${fn.returns}',`);
        lines.push(...field('uses', fn.uses));
        if (fn.host !== undefined)
        {
            lines.push(`        host: ${fn.host},`);
        }
        if (fn.leaf !== undefined)
        {
            lines.push(`        leaf: ${fn.leaf},`);
        }
        if (fn.tables !== undefined)
        {
            const entries = Object.entries(fn.tables).map(([name, at])=>`${name}: ${at}`);
            const one = `        tables: { ${entries.join(', ')} },`;
            const wrapped = entries.map(entry=>`            ${entry},`);
            lines.push(...one.length <= 100 ? [one]
                : ['        tables: {', ...wrapped, '        },']);
        }
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
    if (refused !== undefined)
    {
        lines.push('/** The functions with no x86-64 code, their handlers\' traps at 64 bits, and why. */',
            'export const REFUSED = /** @type {const} */ ({');
        for (const [name, reason] of Object.entries(refused))
        {
            // Within a hundred columns: the words in pieces of up to eighty,
            // each after the first carrying the space before it.
            /** @type {string[]} */
            const pieces = [];
            let piece = '';
            for (const word of reason.split(' '))
            {
                const longer = piece === '' ? word : `${piece} ${word}`;
                if (longer.length > 80 && piece.trim() !== '')
                {
                    pieces.push(piece);
                    piece = ` ${word}`;
                }
                else
                {
                    piece = longer;
                }
            }
            pieces.push(piece);
            const quoted = (/** @type {string} */ text)=>
                `'${text.replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}'`;
            lines.push(`    ${name}:`);
            pieces.forEach((text, i)=>lines.push(`        ${i === 0 ? '' : '+ '}${quoted(text)}`
                + `${i === pieces.length - 1 ? ',' : ''}`));
        }
        lines.push('});', '');
    }
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
