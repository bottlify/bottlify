/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Checks the stack each stdcall export pops against the signature Windows
 * gives it.
 *
 * A system library's stdcall function pops its own arguments, so the
 * `argBytes` an entry of ours declares is part of its contract with every
 * caller: one argument too many moves the caller's stack four bytes a call,
 * and the program goes on until a return lands somewhere it never meant to go
 * -- often far from the call that did it, and silently. The signatures are
 * read from Wine's export spec files (`<dll>.spec`, knowledge of the ABI, not
 * code), kept locally: give the directory that holds them.
 *
 *     node tools/arg-bytes-audit.mjs <spec directory> [--all]
 *
 * Every entry of the win32 layer whose `argBytes` is a number and whose
 * convention is stdcall is compared with each spec that exports the name; a
 * name no spec knows is left alone (`--all` lists those too).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [specDirectory] = process.argv.slice(2);
if (!specDirectory)
{
    console.log('usage: node tools/arg-bytes-audit.mjs <spec directory> [--all]');
    process.exit(2);
}
const listUnknown = process.argv.includes('--all');

/** The bytes a spec argument type takes on the stack. */
const SIZES = { int64: 8, double: 8, int128: 16 };

/** @type {Map<string, { bytes: number, dll: string }[]>} name -> the specs' answers */
const signatures = new Map();
for (const file of readdirSync(specDirectory).filter(name=>name.endsWith('.spec')))
{
    const dll = file.replace(/\.spec$/, '');
    for (const line of readFileSync(join(specDirectory, file), 'utf8').split(/\r?\n/))
    {
        // `@ stdcall -flags Name(arg arg) target`, or an ordinal for the @.
        const match = /^\s*(?:@|\d+)\s+stdcall\s+((?:-\S+\s+)*)(\w+)\(([^)]*)\)/.exec(line);
        if (!match || /-arch=(?!win32|i386)/.test(match[1]))
        {
            continue;
        }
        const bytes = match[3].trim() === '' ? 0 : match[3].trim().split(/\s+/)
            .reduce((total, type)=>total + (SIZES[/** @type {keyof typeof SIZES} */ (type)] ?? 4), 0);
        const known = signatures.get(match[2]) ?? [];
        known.push({ bytes, dll });
        signatures.set(match[2], known);
    }
}

/** @param {string} directory @returns {string[]} */
const sources = directory=>readdirSync(directory, { withFileTypes: true }).flatMap(entry=>
    entry.isDirectory() ? sources(join(directory, entry.name))
        : entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')
            ? [join(directory, entry.name)] : []);

let checked = 0;
let wrong = 0;
const root = new URL('../modules/core/src/layers/win32/', import.meta.url);
for (const path of sources(decodeURIComponent(root.pathname).replace(/^\/(\w:)/, '$1')))
{
    const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    // An entry: its name, then within its first lines the bytes it pops and,
    // when it is not stdcall, the convention that says so.
    const entry = /^\s+(\w+):\s*\{\s*\n((?:.*\n){0,4})/gm;
    for (let match = entry.exec(text); match; match = entry.exec(text))
    {
        const [, name, head] = match;
        const declared = /argBytes:\s*(\d+)\s*,/.exec(head);
        if (!declared || /convention:\s*['"](?!stdcall)/.test(head))
        {
            continue;
        }
        const known = signatures.get(name);
        if (!known)
        {
            if (listUnknown)
            {
                console.log(`?  ${name} ${declared[1]} (${path})`);
            }
            continue;
        }
        checked++;
        const bytes = Number(declared[1]);
        if (!known.some(signature=>signature.bytes === bytes))
        {
            wrong++;
            const line = text.slice(0, match.index).split('\n').length + 1;
            console.log(`${name}: pops ${bytes}, ${known.map(one=>`${one.dll} says ${one.bytes}`)
                .join(', ')}  (${path.replace(/.*layers[\\/]/, 'layers/')}:${line})`);
        }
    }
}
console.log(`${checked} stdcall entries checked, ${wrong} pop a different number of bytes`);
