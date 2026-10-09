/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when a host routine asks which thread is running -- currentThread(),
 * teb(), registers() -- or writes the running thread's registers
 * (setRegisters) after it has awaited anything, or in a `.then` callback,
 * which runs as late.
 *
 * A call into the host is answered with its caller as the current thread only
 * until the answer first awaits. On one executor the thread is usually still
 * the same afterwards; for a thread on another executor it is current only
 * while its call is answered, so after an await the question names another
 * thread: an exception dispatched along the wrong frame chain ended a program
 * that way. Take the thread (callerThread(), or currentThread() before the
 * first await) and carry it.
 *
 * A line that means the thread running at that moment, whoever it is, says so
 * with `// any thread:` and why.
 *
 *     node scripts/check-thread-after-await.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../src/layers/', import.meta.url));
const ASKS = /\b(?:(?:currentThread|teb|registers)\s*(?:\?\.)?\(\s*\)|setRegisters\s*(?:\?\.)?\()/g;
const THEN = /\.then\s*\(/g;
const ASYNC = /\basync\b\s*(?:function\b[^(]*\(|\(|[\w$]+\s*=>)/g;

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

/**
 * The text with comments and string contents blanked to spaces, so braces and
 * words inside them count for nothing; offsets stay where they were.
 *
 * @param {string} text
 */
function blank(text){
    let out = '';
    let at = 0;
    while (at < text.length)
    {
        const two = text.slice(at, at + 2);
        const one = text[at];
        let end = -1;
        if (two === '//')
        {
            end = text.indexOf('\n', at);
            end = end < 0 ? text.length : end;
        }
        else if (two === '/*')
        {
            end = text.indexOf('*/', at + 2);
            end = end < 0 ? text.length : end + 2;
        }
        else if (one === '"' || one === '\'' || one === '`')
        {
            end = at + 1;
            while (end < text.length && text[end] !== one)
            {
                end += text[end] === '\\' ? 2 : 1;
            }
            end = Math.min(end + 1, text.length);
        }
        if (end < 0)
        {
            out += one;
            at++;
            continue;
        }
        out += text.slice(at, end).replace(/[^\n]/g, ' ');
        at = end;
    }
    return out;
}

/**
 * The body of the async function whose `async` keyword is at `start`: from
 * its first brace after the parameters to the brace that closes it, or null
 * for a body that is one expression.
 *
 * @param {string} code @param {number} start
 * @returns {[number, number] | null}
 */
function bodyOf(code, start){
    // One parameter and no parentheses: the body begins after the arrow.
    const bare = code.slice(start).match(/^async\s*[\w$]+\s*=>\s*\{/);
    if (bare)
    {
        return closing(code, start + bare[0].length - 1);
    }
    let depth = 0;
    let at = code.indexOf('(', start);
    for (; at < code.length; at++)
    {
        if (code[at] === '(')
        {
            depth++;
        }
        else if (code[at] === ')' && --depth === 0)
        {
            break;
        }
    }
    const rest = code.slice(at + 1).match(/^\s*(?:=>)?\s*\{/);
    if (!rest)
    {
        return null;
    }
    return closing(code, at + 1 + rest[0].length - 1);
}

/**
 * The span from the brace at `open` to the one that closes it.
 *
 * @param {string} code @param {number} open
 * @returns {[number, number] | null}
 */
function closing(code, open){
    let depth = 0;
    for (let close = open; close < code.length; close++)
    {
        if (code[close] === '{')
        {
            depth++;
        }
        else if (code[close] === '}' && --depth === 0)
        {
            return [open, close];
        }
    }
    return null;
}

/**
 * The span from the parenthesis at `open` to the one that closes it.
 *
 * @param {string} code @param {number} open
 * @returns {[number, number] | null}
 */
function parenthesised(code, open){
    let depth = 0;
    for (let close = open; close < code.length; close++)
    {
        if (code[close] === '(')
        {
            depth++;
        }
        else if (code[close] === ')' && --depth === 0)
        {
            return [open, close];
        }
    }
    return null;
}

const found = [];
for (const path of sources(ROOT))
{
    const text = readFileSync(path, 'utf8');
    const code = blank(text);
    const lines = text.split('\n');
    const lineOf = (/** @type {number} */ offset)=>code.slice(0, offset).split('\n').length;
    /** @param {number} offset */
    const report = offset=>{
        const line = lineOf(offset);
        const source = lines[line - 1];
        const previous = lines[line - 2] ?? '';
        if (!/\/\/ any thread:/.test(source) && !/\/\/ any thread:/.test(previous))
        {
            found.push(`${relative(ROOT, path)}:${line}: ${source.trim()}`);
        }
    };
    // What a `.then` is handed runs after the promise settles: as late as
    // anything after an await.
    for (const match of code.matchAll(THEN))
    {
        const open = (match.index ?? 0) + match[0].length - 1;
        const span = parenthesised(code, open);
        if (!span)
        {
            continue;
        }
        for (const ask of code.slice(span[0], span[1]).matchAll(ASKS))
        {
            report(span[0] + (ask.index ?? 0));
        }
    }
    for (const match of code.matchAll(ASYNC))
    {
        const body = bodyOf(code, match.index ?? 0);
        if (!body)
        {
            continue;
        }
        const inside = code.slice(body[0], body[1]);
        const firstAwait = inside.search(/\bawait\b/);
        // The awaited call's own arguments are read before it suspends: what
        // comes after the end of that statement is what runs after the await.
        const resumed = firstAwait < 0 ? -1 : inside.indexOf(';', firstAwait);
        if (resumed < 0)
        {
            continue;
        }
        for (const ask of inside.slice(resumed).matchAll(ASKS))
        {
            report(body[0] + resumed + (ask.index ?? 0));
        }
    }
}

const unique = [...new Set(found)];
if (unique.length > 0)
{
    console.error('the running thread asked for after an await -- carry the caller\'s instead'
        + ' (or say `// any thread:` and why):');
    for (const line of unique)
    {
        console.error(`  ${line}`);
    }
    process.exit(1);
}
console.log('check-thread-after-await: no host routine asks for the running thread after an await');
