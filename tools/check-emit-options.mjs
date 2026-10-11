/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when a setting the cork runtime hands its emitter (`emitOptions` in
 * runtime.js) does not reach the emitted code: every one must be read by
 * `emitBatch` (emit-built.js), and every one `emitBatch` gives `prepareModule`
 * must be in the key its emitted functions are cached under (`contextKey`).
 *
 * `checkReads` was set by the runtime and dropped in `emitBatch`, so a read of
 * a page the program had closed read zeros in every translated region however
 * the run was configured; and a setting left out of the key has a function
 * emitted under one value taken again under the other.
 *
 *     node tools/check-emit-options.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const RUNTIME = fileURLToPath(new URL('../modules/cork/src/runtime/runtime.js', import.meta.url));
const BUILT = fileURLToPath(new URL('../modules/cork/src/runtime/emit-built.js', import.meta.url));

/**
 * The text between an opening that ends in `(` or `{` and its matching close.
 *
 * @param {string} text @param {string} opening
 */
function body(text, opening){
    const start = text.indexOf(opening);
    if (start < 0)
    {
        throw new Error(`not found: ${opening}`);
    }
    let depth = 0;
    for (let at = start + opening.length - 1; at < text.length; at++)
    {
        const char = text[at];
        depth += char === '(' || char === '{' || char === '[' ? 1
            : char === ')' || char === '}' || char === ']' ? -1 : 0;
        if (depth === 0)
        {
            return text.slice(start + opening.length, at);
        }
    }
    throw new Error(`unclosed: ${opening}`);
}

/** The top-level keys of an object literal's body, spread ones by the key they spread. @param {string} text */
function keysOf(text){
    /** @type {Set<string>} */
    const keys = new Set();
    let depth = 0;
    let line = '';
    for (const char of `${text}\n`)
    {
        if (char === '\n')
        {
            const match = depth === 0 ? /^\s*(?:\.\.\.\(.*?\{\s*(\w+)|(\w+)\s*[:,]|(\w+)$)/.exec(line)
                : null;
            const key = match?.[1] ?? match?.[2] ?? match?.[3];
            if (key)
            {
                keys.add(key);
            }
            line = '';
            continue;
        }
        if (depth === 0)
        {
            line += char;
        }
        depth += char === '(' || char === '{' || char === '[' ? 1
            : char === ')' || char === '}' || char === ']' ? -1 : 0;
    }
    return keys;
}

// A checkout with CRLF line ends reads the same as one with LF: the texts
// below are found by their lines.
const runtime = readFileSync(RUNTIME, 'utf8').replace(/\r\n/g, '\n');
const built = readFileSync(BUILT, 'utf8').replace(/\r\n/g, '\n');
const given = keysOf(body(runtime, 'const emitOptions = ()=>({'));
/** A function's whole text, from its name to the brace that closes it. @param {string} name */
const functionText = name=>{
    const start = built.indexOf(name);
    const end = built.indexOf('\n}\n', start);
    if (start < 0 || end < 0)
    {
        throw new Error(`not found: ${name}`);
    }
    return built.slice(start, end);
};
const batch = functionText('export function emitBatch(');
const prepared = keysOf(body(batch, 'prepareModule(m, layout, features, options.memory ?? {}, {'));
const keyed = functionText('function contextKey(');

/** @type {string[]} */
const problems = [];
for (const key of given)
{
    if (!new RegExp(`\\boptions\\.${key}\\b`).test(batch) && !prepared.has(key))
    {
        problems.push(`emitOptions.${key} is never read by emitBatch`);
    }
}
for (const key of prepared)
{
    if (key !== 'leaveOut' && !new RegExp(`\\boptions\\.${key}\\b`).test(keyed))
    {
        problems.push(`prepareModule's ${key} is not in contextKey`);
    }
}
if (given.size < 10 || prepared.size < 10)
{
    problems.push(`read ${given.size} emitOptions and ${prepared.size} prepareModule keys:`
        + ' the shapes this script parses have changed');
}
if (problems.length > 0)
{
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log(`emit options: ${given.size} reach the emitter, ${prepared.size} in the cache key`);
