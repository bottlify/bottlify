#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Writes the names of the libraries Windows itself puts in system32, which the
 * loader tells apart from a library a program was meant to bring with it.
 *
 *   node tools/generators/windows-libraries.mjs <configure.ac> [out]
 *
 * The names are knowledge, not code: Wine's configure.ac lists one
 * `WINE_CONFIG_MAKEFILE(dlls/<name>)` for every library Wine recreates, and
 * those are Windows' own, less what is Wine's alone (its drivers and helpers,
 * 16-bit modules, type libraries) and the redistributable runtimes a program
 * installs itself (the versioned C runtimes, D3DX, XInput 1.1-1.3, XAudio 2.0-2.7
 * and the like) - except those Windows ships: msvcrt, msvcp60, ucrtbase,
 * d3dcompiler_47, xinput1_4, xinput9_1_0, xaudio2_8 and xaudio2_9.
 * The file is raw.githubusercontent.com/wine-mirror/wine/master/configure.ac.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { isMain } from '../lib/common.mjs';

/**
 * What Wine has that Windows does not: its own drivers and helpers, 16-bit
 * modules, type libraries, the second build of comctl32 it keeps for version 6
 * (Windows' is the same name in another assembly) and the TWAIN 2 manager.
 */
const WINE_ONLY = [
    /^wine/, /\.(tlb|exe16|dll16|drv16|mod16|vxd|ds)$/, /^nsiproxy\.sys$/, /^comctl32_v6$/,
    /^twaindsm$/,
];

/** The runtimes a program brings with it, Windows shipping none of them. */
const REDISTRIBUTABLE = [
    /^msvcr(70|71|80|90|100|110|120)(_clr0400)?$/, /^msvcp(?!60$)\d+(_\w+)?$/, /^msvcrtd$/,
    /^vcomp\d*$/, /^concrt140$/, /^vcruntime140(_1)?$/, /^atl(80|90|100|110)$/,
    /^mfc(?!42u?$)\d+u?$/, /^d3dx9_\d+$/, /^d3dx10_\d+$/, /^d3dx11_\d+$/,
    /^d3dcompiler_(?!47$)\d+$/, /^d3dcsx_\d+$/, /^xinput1_[123]$/, /^xaudio2_[0-7]$/,
    /^x3daudio1_\d+$/, /^xapofx1_\d+$/, /^xactengine\d_\d+$/,
];

/**
 * @param {string} text  configure.ac
 * @returns {string[]}   file names, lower case, sorted
 */
export function windowsLibraries(text){
    const names = new Set();
    for (const [, name] of text.matchAll(/WINE_CONFIG_MAKEFILE\(dlls\/([^/)\s]+)\)/g))
    {
        const lower = name.toLowerCase();
        if (WINE_ONLY.some(rule=>rule.test(lower)) || REDISTRIBUTABLE.some(rule=>rule.test(lower)))
        {
            continue;
        }
        names.add(lower.includes('.') ? lower : `${lower}.dll`);
    }
    return [...names].sort();
}

if (isMain(import.meta.url))
{
    const [source, out = 'modules/core/src/layers/loader/internal/windows-libraries.js'] =
        process.argv.slice(2);
    if (!source)
    {
        console.error('usage: node tools/generators/windows-libraries.mjs <configure.ac> [out]');
        process.exit(2);
    }
    const names = windowsLibraries(readFileSync(source, 'utf8'));
    // As many names a line as fit in the lint's hundred columns.
    const lines = [];
    let line = '   ';
    for (const name of names)
    {
        const item = ` '${name}',`;
        if (line.length + item.length > 100)
        {
            lines.push(line);
            line = '   ';
        }
        line += item;
    }
    lines.push(line);
    writeFileSync(out, `/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

// Written by tools/generators/windows-libraries.mjs from Wine's configure.ac: edit that.

/**
 * The libraries Windows itself puts in system32: a program that imports one the
 * engine does not provide still starts, the gap the engine's, where a library
 * in no list and on no volume ends the start as Windows ends it.
 */
export const WINDOWS_LIBRARIES = new Set([
${lines.join('\n')}
]);
`);
    console.log(`${names.length} names written to ${out}`);
}
