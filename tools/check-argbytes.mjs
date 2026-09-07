/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Checks every function this engine exports against how many bytes of arguments
 * it really takes.
 *
 * This is not a style check. A stdcall stub pops its own arguments, so a wrong
 * count leaves the *caller's* stack pointer off by the difference — and the
 * caller does not notice. It carries on, reads its locals from the wrong
 * addresses, and eventually returns to whatever the shifted stack holds. The
 * failure is a jump to a nonsense address somewhere else entirely, with nothing
 * between it and the cause. One wrong number in six hundred does this.
 *
 * The reference is the export specification of a free reimplementation of
 * Windows, which lists every export with its argument types. Those are
 * expectations about a published ABI, not code: nothing is copied, and the file
 * is fetched rather than vendored so that this checks against the current one.
 *
 *     node tools/check-argbytes.mjs [--offline]
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { win32Module } from '../modules/core/src/layers/win32/module.js';
import { audioModule } from '../modules/core/src/layers/audio/module.js';
import { inputModule } from '../modules/core/src/layers/input/module.js';

const SPECS = 'https://raw.githubusercontent.com/wine-mirror/wine/master/dlls';
const LIBRARIES = [
    'kernel32', 'user32', 'gdi32', 'advapi32', 'ole32', 'winmm', 'shell32', 'ntdll',
    'dsound', 'dinput', 'dinput8', 'version', 'comdlg32', 'imm32', 'comctl32',
];

/** Types that occupy two stack slots rather than one. */
const WIDE = new Set(['int64', 'double']);

/**
 * Argument bytes for one specification line.
 *
 * @param {string} args  What stood between the parentheses.
 * @returns {number}
 */
function bytesOf(args){
    const parts = args.trim().split(/\s+/).filter(part=>part.length > 0);
    return parts.reduce((total, part)=>total + (WIDE.has(part) ? 8 : 4), 0);
}

/**
 * @param {string} text
 * @returns {Map<string, { convention: string, bytes: number }>}
 */
function parseSpec(text){
    /** @type {Map<string, { convention: string, bytes: number }>} */
    const found = new Map();
    for (const line of text.split('\n'))
    {
        // "@ stdcall -import Name(long ptr) ..." — the flags between the
        // convention and the name vary and none of them change the count.
        const match = /^\s*(?:@|\d+)\s+(stdcall|cdecl|varargs)\s+(?:-\S+\s+)*([A-Za-z_][\w@?$]*)\s*\(([^)]*)\)/
            .exec(line);
        if (!match)
        {
            continue;
        }
        const [, convention, name, args] = match;
        found.set(name, { convention, bytes: bytesOf(args) });
    }
    return found;
}

/** A host that answers anything, because building the tables never calls it. */
function silentHost(){
    /** @returns {any} */
    const anything = ()=>new Proxy(function(){}, {
        get: (target, key)=>key === 'then' ? undefined : anything(),
        apply: ()=>anything(),
    });
    return { requireApi: ()=>anything(), provide: ()=>{} };
}

async function main(){
    const offline = process.argv.includes('--offline');
    const cache = join(tmpdir(), 'bottlify-specs');
    await mkdir(cache, { recursive: true });

    /** @type {Map<string, Map<string, { convention: string, bytes: number }>>} */
    const reference = new Map();
    for (const library of LIBRARIES)
    {
        const path = join(cache, `${library}.spec`);
        if (!offline)
        {
            const response = await fetch(`${SPECS}/${library}/${library}.spec`);
            if (response.ok)
            {
                await writeFile(path, await response.text());
            }
        }
        const text = await readFile(path, 'utf8').catch(()=>'');
        if (text.length > 0)
        {
            reference.set(`${library}.dll`, parseSpec(text));
        }
    }

    // Every layer that exports a library to a program, not only win32: a
    // drawing or sound library's stub pops its own arguments exactly as a
    // system one does, and gets the count wrong exactly as easily.
    const win32 = await win32Module.create({}, /** @type {any} */ (silentHost()));
    const audio = await audioModule.create({}, /** @type {any} */ (silentHost()));
    const input = await inputModule.create({}, /** @type {any} */ (silentHost()));
    const libraries = {
        ...win32.libraries(),
        ...audio.libraries?.() ?? {},
        ...input.libraries?.() ?? {},
    };

    let checked = 0;
    let unknown = 0;
    /** @type {string[]} */
    const wrong = [];

    for (const [dll, table] of Object.entries(libraries))
    {
        const known = reference.get(dll.toLowerCase());
        if (!known)
        {
            continue;
        }
        for (const [name, fn] of Object.entries(/** @type {any} */ (table)))
        {
            const expected = known.get(name);
            if (!expected)
            {
                unknown++;
                continue;
            }
            checked++;
            const ours = /** @type {any} */ (fn).argBytes;
            // Only a callee that pops can shift its caller. Under cdecl and
            // varargs the caller cleans up, so this number says how many slots
            // to read rather than how many to remove, and a larger one is a
            // deliberate ceiling on a variable argument list.
            if (expected.convention !== 'stdcall')
            {
                continue;
            }
            if (ours !== expected.bytes)
            {
                wrong.push(`  ${dll}!${name}  declares ${ours}, takes ${expected.bytes}`
                    + ` (${expected.convention})`);
            }
        }
    }

    console.log(`checked ${checked}, ${unknown} not in the reference`);
    if (wrong.length === 0)
    {
        console.log('every declared argument size matches.');
        return;
    }
    console.log(`\n${wrong.length} disagree — each one shifts its caller's stack:\n`);
    console.log(wrong.sort().join('\n'));
    process.exitCode = 1;
}

main().catch(e=>{
    console.error(e);
    process.exit(1);
});
