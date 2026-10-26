/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when a UTF-16 string is read with a limit that is not plainly in
 * bytes.
 *
 * `readWideString(address, limit)` -- memory's and the win32 layer's alike --
 * takes its limit in bytes, and the layer cuts a longer string there. A limit
 * written in characters, `MAX_PATH` where `MAX_PATH * 2` was meant, cuts a
 * path of 131 characters to 130: GetFileVersionInfoSizeW, LZOpenFileW and
 * quartz's file sources read so, and a cut path names another file. A limit
 * passes when it says bytes: a product with 2, a name ending in BYTES, a
 * literal of 0x2000 or more (a bound, not a size), or a parameter handed on
 * as it came (`limit`, `maxLength`, `max`). Anything else is a count in
 * characters until it says otherwise.
 *
 * Only calls of two arguments are this reader; a helper of three (a memory
 * object first) is somebody's own, as is a tree's reader in OWN_READERS.
 *
 *     node tools/check-wide-limits.mjs [src]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'modules', 'core', 'src');

/**
 * Trees whose `readWideString` is a reader of their own, its limit in
 * UTF-16 units, by path from the repository's root.
 *
 * @type {Map<string, string>}
 */
const OWN_READERS = new Map([
    ['modules/core/src/layers/win32/script/', 'script/variant.js: guestMemory counts units'],
]);

/**
 * Reads known to count characters today, by file and limit, with whose they
 * are: the list only shrinks -- one that is fixed fails until it is taken off.
 *
 * @type {Map<string, string>}
 */
export const KNOWN = new Map([
    ['modules/core/src/layers/win32/kernel32/process.js MAX_MODULE_NAME',
        'kernel32 process (package 1): GetModuleBaseName/GetModuleFileNameEx-side reads'],
]);

/** Parameters a reader hands on unchanged: the unit is its caller's. */
const PASSED_ON = new Set(['limit', 'maxLength', 'max', 'maxBytes']);
/** The least literal read as a bound rather than a size. */
const BOUND = 0x2000;

/**
 * The arguments of the call whose `(` is at `open`, split at top-level
 * commas; null when the call does not close.
 *
 * @param {string} code @param {number} open
 * @returns {string[] | null}
 */
export function argumentsAt(code, open){
    /** @type {string[]} */
    const args = [];
    let depth = 0;
    let start = open + 1;
    for (let at = open; at < code.length; at++)
    {
        const ch = code[at];
        if (ch === '(' || ch === '[' || ch === '{')
        {
            depth++;
        }
        else if (ch === ')' || ch === ']' || ch === '}')
        {
            depth--;
            if (depth === 0)
            {
                const last = code.slice(start, at).trim();
                if (last !== '' || args.length > 0)
                {
                    args.push(last);
                }
                return args;
            }
        }
        else if (ch === ',' && depth === 1)
        {
            args.push(code.slice(start, at).trim());
            start = at + 1;
        }
    }
    return null;
}

/**
 * Whether a limit says it is in bytes.
 *
 * @param {string} limit
 */
export function inBytes(limit){
    const text = limit.replace(/\s+/g, ' ');
    if (/\*\s*2\b/.test(text) || /BYTES\b/.test(text) || PASSED_ON.has(text))
    {
        return true;
    }
    const literal = /^(0x[0-9a-f]+|\d+)$/i.exec(text);
    return literal !== null && Number(literal[1]) >= BOUND;
}

/**
 * Every two-argument read of a UTF-16 string in a file whose limit does not
 * say bytes, with the line it is on.
 *
 * @param {string} code
 * @returns {{ line: number, limit: string }[]}
 */
export function findCharacterLimits(code){
    /** @type {{ line: number, limit: string }[]} */
    const found = [];
    const call = /readWideString\s*(\?\.)?\s*\(/g;
    for (let match; (match = call.exec(code));)
    {
        const open = match.index + match[0].length - 1;
        const args = argumentsAt(code, open);
        if (args === null || args.length !== 2 || inBytes(args[1]))
        {
            continue;
        }
        // A definition's parameters, `readWideString(address, limit = 8192){`.
        if (/^\s*\{/.test(code.slice(code.indexOf(')', open) + 1)) && /=/.test(args[1]))
        {
            continue;
        }
        found.push({ line: code.slice(0, match.index).split('\n').length, limit: args[1] });
    }
    return found;
}

/** @param {string} dir @returns {string[]} */
function sources(dir){
    return readdirSync(dir).flatMap(name=>{
        const path = join(dir, name);
        if (statSync(path).isDirectory())
        {
            return sources(path);
        }
        return /\.js$/.test(name) && !/\.(test|itest|fixture)\.js$/.test(name) ? [path] : [];
    });
}

function main(){
    let reads = 0;
    let files = 0;
    /** @type {string[]} */
    const wrong = [];
    /** @type {Set<string>} */
    const seen = new Set();
    for (const path of sources(SRC))
    {
        const code = readFileSync(path, 'utf8');
        const name = relative(ROOT, path).split('\\').join('/');
        if (!code.includes('readWideString')
            || [...OWN_READERS.keys()].some(prefix=>name.startsWith(prefix)))
        {
            continue;
        }
        files++;
        reads += (code.match(/readWideString\s*(\?\.)?\s*\(/g) ?? []).length;
        for (const { line, limit } of findCharacterLimits(code))
        {
            const key = `${name} ${limit}`;
            if (KNOWN.has(key))
            {
                seen.add(key);
                continue;
            }
            wrong.push(`${name}:${line}: readWideString's limit "${limit}" is `
                + 'not in bytes: a count of characters cuts the string at half of it');
        }
    }
    for (const key of KNOWN.keys())
    {
        if (!seen.has(key))
        {
            wrong.push(`${key} reads in bytes now: take it off KNOWN`
                + ' in tools/check-wide-limits.mjs');
        }
    }
    for (const line of wrong)
    {
        console.error(line);
    }
    console.log(`wide limits: ${reads} reads in ${files} files, ${wrong.length} not in bytes,`
        + ` ${seen.size} known`);
    process.exitCode = wrong.length > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
{
    main();
}
