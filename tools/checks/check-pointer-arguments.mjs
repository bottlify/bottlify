/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when the table of each function's address arguments is not what the
 * layers' signature comments say, and writes it with `--write`.
 *
 * A 64-bit caller passes an address in a register or a slot of its own, all
 * eight bytes; the bridge hands a handler the low dword of every argument and
 * takes an address whole only where it is declared one (`addresses`, the
 * dispatcher's `readLongCall`). Which dwords hold an address is in the
 * signature comment above each handler (`LPCSTR lpFileName`, `void *`), read
 * by `check-wide-arguments.mjs`'s `pointersOf`; the comments are gone from a
 * bundle, so the table is written beside the layer once and the win32 layer
 * declares each function's from it (`declareAddresses`). A function whose
 * comments disagree, or that has none the parser can read, is not in it, and
 * neither is a name by number (`#72`), which is one library's only.
 *
 *     node tools/checks/check-pointer-arguments.mjs [--write]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isMain } from '../lib/common.mjs';
import { signatures } from './check-wide-addresses.mjs';

const FILE = fileURLToPath(new URL(
    '../../modules/core/src/layers/win32/common/pointer-arguments.js', import.meta.url));

/** The table's source, from the comments as they are now. */
export function tableSource(){
    const { pointers } = signatures();
    // A name by number (`#72`) is one library's: another's #72 is another function.
    const entries = [...pointers].filter(([name, places])=>places.length > 0
        && !name.startsWith('#'))
        .sort(([a], [b])=>(a < b ? -1 : a > b ? 1 : 0));
    const lines = entries.map(([name, places])=>
        `    ${/^[A-Za-z_$][\w$]*$/.test(name) ? name
            : `'${name.replace(/[\\']/g, '\\$&')}'`}: [${places.join(', ')}],`);
    return `/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The dwords of each function's arguments, in the 32-bit layout, that hold an
 * address, by name: what its signature comment says, read by
 * tools/checks/check-pointer-arguments.mjs, which writes this file (--write)
 * and fails when it is not what the comments say. Not written by hand.
 */

/** @type {Readonly<Record<string, readonly number[]>>} */
export const POINTER_ARGUMENTS = Object.freeze({
${lines.join('\n')}
});
`;
}

if (isMain(import.meta.url))
{
    const wanted = tableSource();
    if (process.argv.includes('--write'))
    {
        writeFileSync(FILE, wanted);
        console.log(`pointer arguments: written (${wanted.split('\n').length} lines)`);
    }
    else
    {
        let current;
        try
        {
            current = readFileSync(FILE, 'utf8');
        }
        catch {
            current = '';
        }
        if (current !== wanted)
        {
            console.error('pointer arguments: modules/core/src/layers/win32/common/'
                + 'pointer-arguments.js is not what the signature comments say:'
                + ' node tools/checks/check-pointer-arguments.mjs --write');
            process.exitCode = 1;
        }
        else
        {
            console.log('pointer arguments: the table is what the comments say');
        }
    }
}
