/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when one file sets the same target of a link's handlers twice
 * (`handlers.control = ...` and again further down).
 *
 * The link answers a call from whatever the target holds when the call is
 * handled, so a second setting silently takes the first one's methods away:
 * a process worker set `control` with `terminate` and then again without it,
 * and its parent's TerminateProcess was answered "nothing answers" and lost
 * whenever it came over the link -- a parent waiting on that child waited
 * for ever, now and then. One target, one setting, with every method it has.
 *
 *     node scripts/check-link-handlers.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../src/', import.meta.url));
const SET = /\bhandlers\.([A-Za-z_$][\w$]*)\s*=(?!=)/g;

/** @param {string} dir @returns {string[]} */
function sources(dir){
    return readdirSync(dir).flatMap(name=>{
        const path = join(dir, name);
        if (statSync(path).isDirectory())
        {
            return sources(path);
        }
        return /\.js$/.test(name) && !/\.(i?test|fixture)\.js$/.test(name) ? [path] : [];
    });
}

/** @type {string[]} */
const failures = [];
let files = 0;
for (const path of sources(ROOT))
{
    const text = readFileSync(path, 'utf8');
    /** @type {Map<string, number[]>} */
    const lines = new Map();
    for (const match of text.matchAll(SET))
    {
        const line = text.slice(0, match.index).split('\n').length;
        lines.set(match[1], [...(lines.get(match[1]) ?? []), line]);
    }
    if (lines.size > 0)
    {
        files++;
    }
    for (const [target, at] of lines)
    {
        if (at.length > 1)
        {
            failures.push(`${relative(ROOT, path)}: handlers.${target} set on lines`
                + ` ${at.join(', ')}`);
        }
    }
}
if (failures.length > 0)
{
    console.error(`link handlers: a target set twice takes the first setting's methods away:\n  ${
        failures.join('\n  ')}`);
    process.exit(1);
}
console.log(`link handlers: ${files} files set their targets once each`);
