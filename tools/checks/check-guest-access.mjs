#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails on a new copy of guest memory access in any layer: a local dword,
 * word, float or pointer accessor, a local string reader or writer, or a read
 * copied again (`readMemory(...).slice()`, `readBytes(...).slice()`). Every
 * layer has the one port the memory layer hands out (`memory.port`,
 * `system/port.js`), which reads and writes in place through the memory
 * layer's checked accessors, and win32's handlers have it with the process's
 * text as `host.guest` (`win32/common/guest.js`); the layers had grown
 * hundreds of copies of it, each a closure and a buffer per read, and a read
 * already a copy was copied once more. The memory layer itself is the
 * accessors the port is made over, and is not counted.
 *
 * Guest code is not counted: a function documented `@guestCode` is compiled
 * to the guest's own instructions and reads its memory as the processor does,
 * and the view such a function is handed when it runs as a handler defines
 * the names its typedef (`Guest`, documented as `@guestCode`'s) declares. A
 * definition that takes no parameter takes no address, and reads no memory.
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
const LAYERS = join(ROOT, 'modules/core/src/layers');
/** The layer the port is made over: its accessors are the one definition. */
const BASE = join(LAYERS, 'memory');
const BASELINE = new URL('./guest-access-baseline.json', import.meta.url);

/** A function's name that reads or writes one value of guest memory. */
const ACCESSOR = /^(?:(?:read|write|put|get|set|peek|poke|load|store)(?:U8|U16|U32|U64|I8|I16|I32|I64|F32|F64|8|16|32|64|Byte|Word|Dword|Qword|Short|Long|Int|Float|Double|Pointer|Ptr)s?(?:At)?|dword|word|qword|u8|u16|u32|u64|i16|i32|f32|f64|ptr|pointer)$/i;
/** A function's name that reads or writes a string in guest memory. */
const STRING = /^(?:(?:read|write|put|get)(?:C|W|Ansi|Wide)?(?:Str|String|Wide|Ansi)(?:At|Z)?|(?:string|wide|ansi|cstr|wstr)(?:At)?)$/i;
/** A function defined by a declaration, an arrow or a function expression. */
const DEFINITION = /(?:^|[^\w$.])(?:function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|(?:\([^()]*(?:\([^()]*\)[^()]*)*\)|[A-Za-z_$][\w$]*)\s*=>))/g;
/**
 * A string helper's name that is also a plain word (`wide`, `ansi`,
 * `string`): one only when its body reaches guest memory, since the same
 * word names a widening, a flag or a wire's encoder as often.
 */
const PLAIN = /^(?:string|wide|ansi)$/i;
/** What reaching guest memory reads as in a body. */
const MEMORY = /(?<![\w$])(?:readMemory|writeMemory|readBytes|writeBytes|readCString|readWideString|guest|memory|window|view|snapshot|setBytes|heap)(?![\w$])/;

/**
 * The body of the definition whose text ends at `end`: to the end of its
 * statement, its block's close or the list it stands in, at most 4000
 * characters of it. `depth` is 1 inside a declaration's parameters.
 *
 * @param {string} code @param {number} end @param {number} depth
 */
function bodyOf(code, end, depth){
    let at = end;
    for (; at < Math.min(code.length, end + 4000); at++)
    {
        const char = code[at];
        if ('([{'.includes(char))
        {
            depth++;
        }
        else if (')]}'.includes(char))
        {
            depth--;
            if (depth < 0 || (depth === 0 && char === '}'))
            {
                break;
            }
        }
        else if (depth === 0 && (char === ';' || char === ','))
        {
            break;
        }
    }
    return code.slice(end, at + 1);
}

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

/** A doc comment's text, the last one closing right before `at` (an `export` between). */
const DOC_BEFORE = /\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*(?:export\s+(?:default\s+)?)?$/;
/** A typedef's property name, its type braces nested once. */
const PROPERTY = /@property\s+\{(?:[^{}]|\{[^{}]*\})*\}\s+\[?([A-Za-z_$][\w$]*)/g;

/**
 * The names a guest-code view declares in this file: the properties of each
 * typedef whose doc says it is what a `@guestCode` function is handed.
 *
 * @param {string} text
 */
const guestCodeView = text=>new Set([...text.matchAll(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\//g)]
    .filter(([, doc])=>/@typedef\b/.test(doc) && /`@guestCode`/.test(doc))
    .flatMap(([, doc])=>[...doc.matchAll(PROPERTY)].map(property=>property[1])));

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
    const view = guestCodeView(text);
    /** @type {Record<string, number>} */
    const found = {};
    /** @param {string} key */
    const add = key=>{
        found[key] = (found[key] ?? 0) + 1;
    };
    for (const match of code.matchAll(DEFINITION))
    {
        const name = match[1] ?? match[2];
        const start = /** @type {number} */ (match.index);
        const end = start + match[0].length;
        const noParameter = match[1] ? /^\s*\)/.test(code.slice(end, end + 20))
            : /\(\s*\)\s*=>$/.test(match[0]);
        const doc = DOC_BEFORE.exec(text.slice(Math.max(0, start - 4000), start + 1)
            .replace(/[^\s\w$]$/, ''));
        if (noParameter || view.has(name) || (doc && /^\s*\*\s*@guestCode\b/m.test(doc[1])))
        {
            continue;
        }
        if (ACCESSOR.test(name))
        {
            add(`accessor ${name}`);
        }
        else if (STRING.test(name) && (!PLAIN.test(name)
            || MEMORY.test(bodyOf(code, end, match[1] ? 1 : 0))))
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
        return path === BASE ? [] : sources(path);
    }
    return /\.m?js$/.test(name) && !/\.(test|itest|fixture)\.m?js$/.test(name) ? [path] : [];
});

/**
 * The tree's occurrences, by file under layers/, files with none left out.
 *
 * @param {string} [root]
 * @returns {Record<string, Record<string, number>>}
 */
export function scan(root = LAYERS){
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
                + ' the layers today (check-guest-access.mjs). Only shrinks: move a file onto'
                + ' the memory port (memory.port, host.guest), then --write.',
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
        console.error('guest access: guest memory read or written past the port'
            + ' (system/port.js, memory.port, host.guest):\n  ' + added.join('\n  '));
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
