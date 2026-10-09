/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A page that is not cross-origin isolated has no `SharedArrayBuffer`: the
 * name is not defined in it or in its workers, so `x instanceof
 * SharedArrayBuffer` throws there rather than answering false. One such test
 * in the translation worker took the whole compatible mode down with a
 * ReferenceError that Node, where the name always exists, never showed. Every
 * test of it in the packages' sources is guarded by `typeof SharedArrayBuffer`
 * in the same expression, within the three lines before it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULES = fileURLToPath(new URL('../../', import.meta.url));

/** @param {string} directory @returns {string[]} */
function sources(directory){
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry=>{
        const path = join(directory, entry.name);
        if (entry.isDirectory())
        {
            return sources(path);
        }
        return /\.m?js$/.test(entry.name) && !/\.i?test\.m?js$/.test(entry.name) ? [path] : [];
    });
}

/** @param {string} text @returns {number[]}  the 1-based lines of unguarded tests */
function unguarded(text){
    const lines = text.split('\n');
    return lines.flatMap((line, at)=>!/instanceof\s+SharedArrayBuffer/.test(line)
        || lines.slice(Math.max(0, at - 3), at + 1).join('\n').includes('typeof SharedArrayBuffer')
        ? [] : [at + 1]);
}

test('the rule finds a bare test and passes a guarded one', ()=>{
    assert.deepEqual(unguarded('if (a.buffer instanceof SharedArrayBuffer)\n{'), [1]);
    assert.deepEqual(unguarded('const shared = typeof SharedArrayBuffer === \'function\'\n'
        + '    && a.buffer instanceof SharedArrayBuffer;'), []);
});

test('every instanceof SharedArrayBuffer in the packages is guarded by typeof', ()=>{
    const found = readdirSync(MODULES, { withFileTypes: true })
        .filter(entry=>entry.isDirectory())
        .flatMap(entry=>{
            const src = join(MODULES, entry.name, 'src');
            try
            {
                return sources(src);
            }
            catch {
                // A package with no src/ has nothing to check.
                return [];
            }
        })
        .flatMap(path=>unguarded(readFileSync(path, 'utf8')).map(line=>`${path}:${line}`));
    assert.deepEqual(found, []);
});
