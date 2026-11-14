/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Where each export of the C and C++ runtimes runs, counted from the engine
 * rather than written down: guest code (its own i386 or x86-64, or placed
 * when bound), a crossing into its host handler, a variable, or absent from a
 * 64-bit process's module. The list of what is still a crossing is what the
 * guest-code work goes through next, and it is recounted, not kept by hand.
 *
 *     node tools/crt-inventory.mjs [--host 32|64] [--library NAME] [--json FILE]
 *
 * With no option, one line a library: its exports and how many run where in a
 * 32-bit and in a 64-bit process. `--host 64` lists by name the exports that
 * cross into the host in a 64-bit process (`--host 32` in a 32-bit one),
 * `--library` narrows to the libraries whose name holds the text, `--json`
 * writes every export's place in both.
 */

import { writeFileSync } from 'node:fs';
import { buildExe } from './make-pe.mjs';
import { createApp } from '../modules/core/src/app.js';

/** The runtimes: msvcrt and its versioned twins, the UCRT and its API sets, the C++ library. */
const CRT = /^(msvcrt|msvcr\d+|msvcp\d+|msvcirt|crtdll|ucrtbase|api-ms-win-crt-)/i;

const argv = process.argv.slice(2);
/** @param {string} flag */
const option = flag=>(argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);
const hostBits = option('--host');
const narrow = option('--library')?.toLowerCase() ?? null;
const jsonTo = option('--json');

const apps = await Promise.all(/** @type {(32 | 64)[]} */ ([32, 64]).map(bits=>createApp({
    executable: buildExe({
        bits,
        imports: { 'KERNEL32.dll': ['ExitProcess'] },
        data: {},
        codeSize: 0x10,
        code: ()=>new Array(16).fill(0xcc),
    }),
})));
const [narrowApp, longApp] = apps;
const libraries = narrowApp.systemLibraries()
    .filter(name=>CRT.test(name) && (narrow === null || name.toLowerCase().includes(narrow)))
    .sort((a, b)=>a.localeCompare(b));

/** @typedef {'guest' | 'host' | 'data' | 'absent'} Place */
/** @type {Record<string, Record<string, { x86: Place, x64: Place }>>} */
const all = {};
for (const library of libraries)
{
    const narrowPlaces = narrowApp.debug.exportPlaces(library) ?? {};
    const longPlaces = longApp.debug.exportPlaces(library) ?? {};
    all[library] = Object.fromEntries(Object.keys(narrowPlaces).sort().map(name=>[name,
        { x86: narrowPlaces[name], x64: longPlaces[name] ?? 'absent' }]));
}

/**
 * @param {Record<string, { x86: Place, x64: Place }>} exports
 * @param {'x86' | 'x64'} bits @param {Place} place
 */
const count = (exports, bits, place)=>Object.values(exports)
    .filter(one=>one[bits] === place).length;

if (hostBits !== null)
{
    const bits = hostBits === '64' ? 'x64' : 'x86';
    for (const [library, exports] of Object.entries(all))
    {
        const names = Object.entries(exports).filter(([, one])=>one[bits] === 'host')
            .map(([name])=>name);
        if (names.length > 0)
        {
            console.log(`${library} (${names.length} host in ${hostBits}-bit): ${names.join(' ')}`);
        }
    }
}
else
{
    console.log('library: exports | x86 guest host data | x64 guest host data absent');
    const totals = { exports: 0, x86: [0, 0, 0], x64: [0, 0, 0, 0] };
    for (const [library, exports] of Object.entries(all))
    {
        const x86 = /** @type {Place[]} */ (['guest', 'host', 'data'])
            .map(place=>count(exports, 'x86', place));
        const x64 = /** @type {Place[]} */ (['guest', 'host', 'data', 'absent'])
            .map(place=>count(exports, 'x64', place));
        totals.exports += Object.keys(exports).length;
        x86.forEach((n, i)=>{
            totals.x86[i] += n;
        });
        x64.forEach((n, i)=>{
            totals.x64[i] += n;
        });
        console.log(`${library}: ${Object.keys(exports).length} | ${x86.join(' ')}`
            + ` | ${x64.join(' ')}`);
    }
    console.log(`all: ${totals.exports} | ${totals.x86.join(' ')} | ${totals.x64.join(' ')}`);
}
if (jsonTo !== null)
{
    writeFileSync(jsonTo, JSON.stringify(all, null, 1));
    console.log(`written to ${jsonTo}`);
}
await Promise.all(apps.map(app=>app.dispose()));
