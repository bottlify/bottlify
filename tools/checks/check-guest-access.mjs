#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails on a new copy of guest memory access in the win32 layer: a local
 * dword, word, float or pointer accessor, a local string reader or writer, or
 * a read copied again (`readMemory(...).slice()`, `readBytes(...).slice()`).
 * Every handler has the one view the win32 layer hands it, `host.guest`
 * (`win32/common/guest.js`), which reads and writes in place through the
 * memory layer; the layer had grown hundreds of copies of it, each a closure
 * and a buffer per read, and a read already a copy was copied once more.
 *
 * What is there today is the baseline (`guest-access-baseline.json`), by file
 * and by name, so the check passes now and a new definition fails it. The
 * baseline only shrinks: a file holding fewer than its baseline fails too,
 * until `--write` writes the smaller count, so what a migration took out
 * cannot come back unseen.
 *
 *     node tools/checks/check-guest-access.mjs [--write] [--list]
 *
 * `--list` prints every occurrence the baseline holds, by file.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/common.mjs';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const WIN32 = join(ROOT, 'modules/core/src/layers/win32');
const BASELINE = new URL('./guest-access-baseline.json', import.meta.url);

/** A function's name that reads or writes one value of guest memory. */
const ACCESSOR = /^(?:(?:read|write|put|get|set|peek|poke|load|store)(?:U8|U16|U32|U64|I8|I16|I32|I64|F32|F64|8|16|32|64|Byte|Word|Dword|Qword|Short|Long|Int|Float|Double|Pointer|Ptr)s?(?:At)?|dword|word|qword|u8|u16|u32|u64|i16|i32|f32|f64|ptr|pointer)$/i;
/** A function's name that reads or writes a string in guest memory. */
const STRING = /^(?:(?:read|write|put|get)(?:C|W|Ansi|Wide)?(?:Str|String|Wide|Ansi)(?:At|Z)?|(?:string|wide|ansi|cstr|wstr)(?:At)?)$/i;
/** A function defined by a declaration, an arrow or a function expression. */
const DEFINITION = /(?:^|[^\w$.])(?:function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|(?:\([^()]*(?:\([^()]*\)[^()]*)*\)|[A-Za-z_$][\w$]*)\s*=>))/g;
/** The two reads that answer a copy already. */
const READ = /(?<![\w$])(?:readMemory|readBytes)\s*\(/g;

/**
 * The code with comments and string literals blanked, every line end kept:
 * a name in a comment is not a definition.
 *
 * @param {string} code
 */
export function blank(code){
    return code.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g,
        match=>match.replace(/[^\n]/g, ' '));
}

/**
 * Every occurrence in one file's text, by its key: the accessor's or string
 * helper's name (`accessor readU32`, `string wide`), or `copy` for a read
 * copied again.
 *
 * @param {string} text
 * @returns {Record<string, number>}
 */
export function occurrences(text){
    const code = blank(text);
    /** @type {Record<string, number>} */
    const found = {};
    /** @param {string} key */
    const add = key=>{
        found[key] = (found[key] ?? 0) + 1;
    };
    for (const match of code.matchAll(DEFINITION))
    {
        const name = match[1] ?? match[2];
        if (ACCESSOR.test(name))
        {
            add(`accessor ${name}`);
        }
        else if (STRING.test(name))
        {
            add(`string ${name}`);
        }
    }
    for (const match of code.matchAll(READ))
    {
        // The call's own closing parenthesis, then whether `.slice()` follows it.
        let depth = 0;
        let at = /** @type {number} */ (match.index) + match[0].length - 1;
        for (; at < code.length; at++)
        {
            depth += code[at] === '(' ? 1 : code[at] === ')' ? -1 : 0;
            if (depth === 0)
            {
                break;
            }
        }
        if (/^\s*\.slice\(\s*\)/.test(code.slice(at + 1, at + 40)))
        {
            add('copy readMemory().slice()');
        }
    }
    return found;
}

/** @param {string} dir @returns {string[]} */
const sources = dir=>readdirSync(dir).flatMap(name=>{
    const path = join(dir, name);
    if (statSync(path).isDirectory())
    {
        return sources(path);
    }
    return /\.m?js$/.test(name) && !/\.(test|itest|fixture)\.m?js$/.test(name) ? [path] : [];
});

/**
 * The tree's occurrences, by file under win32/, files with none left out.
 *
 * @param {string} [root]
 * @returns {Record<string, Record<string, number>>}
 */
export function scan(root = WIN32){
    /** @type {Record<string, Record<string, number>>} */
    const files = {};
    for (const path of sources(root).sort())
    {
        const found = occurrences(readFileSync(path, 'utf8'));
        if (Object.keys(found).length > 0)
        {
            files[relative(root, path).split('\\').join('/')] = Object.fromEntries(
                Object.entries(found).sort(([a], [b])=>(a < b ? -1 : 1)));
        }
    }
    return files;
}

/**
 * What differs from the baseline: a count above it is new, one below it a
 * baseline to shrink.
 *
 * @param {Record<string, Record<string, number>>} now
 * @param {Record<string, Record<string, number>>} baseline
 * @returns {{ added: string[], stale: string[] }}
 */
export function compare(now, baseline){
    /** @type {string[]} */
    const added = [];
    /** @type {string[]} */
    const stale = [];
    for (const file of new Set([...Object.keys(now), ...Object.keys(baseline)]))
    {
        const here = now[file] ?? {};
        const kept = baseline[file] ?? {};
        for (const key of new Set([...Object.keys(here), ...Object.keys(kept)]))
        {
            const count = here[key] ?? 0;
            const allowed = kept[key] ?? 0;
            if (count > allowed)
            {
                added.push(`${file}: ${key} (${count}, the baseline ${allowed})`);
            }
            else if (count < allowed)
            {
                stale.push(`${file}: ${key} (${count}, the baseline ${allowed})`);
            }
        }
    }
    return { added, stale };
}

/** @param {Record<string, Record<string, number>>} files */
const total = files=>Object.values(files)
    .reduce((sum, keys)=>sum + Object.values(keys).reduce((a, b)=>a + b, 0), 0);

if (isMain(import.meta.url))
{
    const now = scan();
    if (process.argv.includes('--write'))
    {
        writeFileSync(BASELINE, `${JSON.stringify({
            about: 'Local guest memory accessors, string helpers and reads copied again in'
                + ' win32 today (check-guest-access.mjs). Only shrinks: move a file onto'
                + ' host.guest, then --write.',
            files: now,
        }, null, 1)}\n`);
        console.log(`guest access: baseline written, ${total(now)} occurrences`);
        process.exit(0);
    }
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')).files;
    if (process.argv.includes('--list'))
    {
        for (const [file, keys] of Object.entries(now))
        {
            console.log(`${file}: ${Object.entries(keys).map(([k, n])=>`${k} ${n}`).join(', ')}`);
        }
    }
    const { added, stale } = compare(now, baseline);
    if (added.length > 0)
    {
        console.error('guest access: guest memory read or written past host.guest'
            + ' (win32/common/guest.js):\n  ' + added.join('\n  '));
    }
    if (stale.length > 0)
    {
        console.error('guest access: fewer than the baseline holds; shrink it'
            + ' (node tools/checks/check-guest-access.mjs --write):\n  ' + stale.join('\n  '));
    }
    if (added.length + stale.length > 0)
    {
        process.exit(1);
    }
    console.log(`guest access: ${total(now)} occurrences, none past the baseline`);
}
