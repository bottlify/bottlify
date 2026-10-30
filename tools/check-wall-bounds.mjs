/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when a test holds a wall-clock time to a bound a busy machine can
 * cross: a duration read off `performance.now()` or `Date.now()` that an
 * assertion keeps under a figure, or a rate made of one that has to come out
 * above another.
 *
 * A machine others load stretches every wall time by however long the thread
 * waited for a core, so such a bound passes on an idle machine and fails on a
 * busy one with the code the same: a look of 1 ms came back past 100 ms with
 * four busy loops beside the suite, and a 30 s bound on 200 rounds followed the
 * load as much as the scheduler. What a test can hold instead: what the code
 * asked for (the timer's own delay, read off the timer), counts (turns, trips
 * to the event loop, instructions, crossings), or the thread's processor time
 * (`tools/cpu-time.mjs`), which other processes do not stretch. A wall time
 * kept *above* a figure stays -- a wait waited out, load only lengthens it --
 * and so does a count kept under one that grows with the wall time.
 *
 * Read in `assert(...)` and `assert.ok(...)` conditions: each comparison at
 * the top of a condition's `&&` and `||`, a name read off the clock -- or
 * worked out from one -- on its smaller side fails it.
 *
 *     node tools/check-wall-bounds.mjs [dir...]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIRS = process.argv.length > 2 ? process.argv.slice(2)
    : ['modules', 'tools'].map(dir=>join(ROOT, dir));

/**
 * Bounds known to hold a wall time from above today, by file and the
 * condition's text, with why: the list only shrinks -- one that is fixed
 * fails until it is taken off.
 *
 * @type {Map<string, string>}
 */
export const KNOWN = new Map([
]);

/** What reads the wall clock. */
const CLOCK = /\b(?:performance\.now|Date\.now)\s*\(\s*\)|\bperformance\.timeOrigin\b/;

/**
 * Whether `text` takes a time between two of the clock's readings: a reading
 * less another. A reading alone is an instant, and one kept below a later
 * stamp holds however busy the machine was.
 *
 * @param {string} text
 */
const elapsed = text=>CLOCK.test(text) && /[\w$)\]]\s*-\s*[\w$(]/.test(text);

/** @param {string} dir @returns {string[]} */
function testFiles(dir){
    /** @type {string[]} */
    const out = [];
    for (const name of readdirSync(dir))
    {
        if (name === 'node_modules' || name.startsWith('.') || name === 'vendor' || name === 'dist')
        {
            continue;
        }
        const path = join(dir, name);
        if (statSync(path).isDirectory())
        {
            out.push(...testFiles(path));
        }
        else if (/\.i?test\.m?js$/.test(name))
        {
            out.push(path);
        }
    }
    return out;
}

/**
 * The source with its comments gone and every string's and template's text
 * blanked (a template's `${...}` kept), so brackets and operators in them are
 * not read as code. Offsets are kept.
 *
 * @param {string} source
 */
export function codeOnly(source){
    const out = source.split('');
    /** @type {string[]} */
    const stack = ['code'];
    let i = 0;
    /** @param {number} from @param {number} to */
    const blank = (from, to)=>{
        for (let k = from; k < to; k++)
        {
            if (out[k] !== '\n')
            {
                out[k] = ' ';
            }
        }
    };
    const braces = [0];
    while (i < source.length)
    {
        const mode = stack[stack.length - 1];
        const c = source[i];
        if (mode === 'template')
        {
            if (c === '\\')
            {
                blank(i, i + 2);
                i += 2;
                continue;
            }
            if (c === '`')
            {
                stack.pop();
                i++;
                continue;
            }
            if (c === '$' && source[i + 1] === '{')
            {
                stack.push('code');
                braces.push(0);
                i += 2;
                continue;
            }
            blank(i, i + 1);
            i++;
            continue;
        }
        if (c === '/' && source[i + 1] === '/')
        {
            const end = source.indexOf('\n', i);
            const to = end < 0 ? source.length : end;
            blank(i, to);
            i = to;
            continue;
        }
        if (c === '/' && source[i + 1] === '*')
        {
            const end = source.indexOf('*/', i + 2);
            const to = end < 0 ? source.length : end + 2;
            blank(i, to);
            i = to;
            continue;
        }
        if (c === '\'' || c === '"')
        {
            let k = i + 1;
            while (k < source.length && source[k] !== c && source[k] !== '\n')
            {
                k += source[k] === '\\' ? 2 : 1;
            }
            blank(i + 1, k);
            i = k + 1;
            continue;
        }
        if (c === '`')
        {
            stack.push('template');
            i++;
            continue;
        }
        if (c === '{')
        {
            braces[braces.length - 1]++;
        }
        else if (c === '}')
        {
            if (stack.length > 1 && braces[braces.length - 1] === 0)
            {
                stack.pop();
                braces.pop();
                i++;
                continue;
            }
            braces[braces.length - 1]--;
        }
        i++;
    }
    return out.join('');
}

/**
 * The value assigned at `from`, to the statement's end: a `;`, or a line's end
 * outside brackets.
 *
 * @param {string} code @param {number} from
 */
function valueAt(code, from){
    let depth = 0;
    for (let i = from; i < code.length; i++)
    {
        const c = code[i];
        if (c === '(' || c === '[' || c === '{')
        {
            depth++;
        }
        else if (c === ')' || c === ']' || c === '}')
        {
            if (--depth < 0)
            {
                return code.slice(from, i);
            }
        }
        else if (depth === 0 && (c === ';' || c === ','
            || (c === '\n' && !/^\s*[-+*/%?:.|&]/.test(code.slice(i + 1, i + 40)))))
        {
            return code.slice(from, i);
        }
    }
    return code.slice(from);
}

/** @param {string} name */
const word = name=>new RegExp(`(?<![.\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`);

/**
 * What a file holds of times between the clock's readings: the names assigned
 * one or arithmetic on one (a call between makes the value something else;
 * Math's and Number's do not), a list such times are pushed onto, and the
 * properties an object literal gives such a name (`{ ms }`, `{ took: ms }`),
 * read as `.ms` anywhere in the file.
 *
 * @param {string} code  as `codeOnly` leaves it
 * @returns {{ names: Set<string>, properties: Set<string> }}
 */
export function clockNames(code){
    /** @type {Set<string>} */
    const names = new Set();
    /** @type {Set<string>} */
    const properties = new Set();
    const assignments = [
        ...[...code.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:[-+*/]?=)(?!=|>)/g)]
            .filter(match=>!code.slice(0, match.index).trimEnd().endsWith('.'))
            .map(match=>[match[1], valueAt(code, (match.index ?? 0) + match[0].length)]),
        ...[...code.matchAll(/\b([A-Za-z_$][\w$]*)\.push\s*\(/g)]
            .map(match=>[match[1], valueAt(code, (match.index ?? 0) + match[0].length)]),
    ];
    /** A call, other than Math's and Number's arithmetic. */
    const call = /(?<!\bMath\.\w*|\bNumber)[\w$\])]\s*\(/;
    /** @param {string} value */
    const uses = value=>[...names].some(name=>word(name).test(value))
        || [...properties].some(name=>new RegExp(`\\.${name.replace(/\$/g, '\\$')}(?![\\w$])`)
            .test(value));
    let grew = true;
    while (grew)
    {
        grew = false;
        for (const [name, value] of assignments)
        {
            if (!names.has(name) && (elapsed(value) || (!call.test(value) && uses(value))))
            {
                names.add(name);
                grew = true;
            }
        }
        for (const name of names)
        {
            for (const match of code.matchAll(new RegExp(`[{,]\\s*(?:([\\w$]+)\\s*:\\s*)?${
                name.replace(/\$/g, '\\$')}\\s*(?=[,}])`, 'g')))
            {
                const property = match[1] ?? name;
                grew = grew || !properties.has(property);
                properties.add(property);
            }
        }
    }
    return { names, properties };
}

/**
 * The text of the call's first argument, the call's `(` at `open`; null when
 * it does not close.
 *
 * @param {string} code @param {number} open
 */
function firstArgument(code, open){
    let depth = 0;
    for (let i = open; i < code.length; i++)
    {
        const c = code[i];
        if (c === '(' || c === '[' || c === '{')
        {
            depth++;
        }
        else if (c === ')' || c === ']' || c === '}')
        {
            depth--;
            if (depth === 0)
            {
                return code.slice(open + 1, i);
            }
        }
        else if (c === ',' && depth === 1)
        {
            return code.slice(open + 1, i);
        }
    }
    return null;
}

/**
 * The pieces of `text` between its top-level `separators`.
 *
 * @param {string} text @param {RegExp} separators  sticky
 */
function splitTop(text, separators){
    /** @type {string[]} */
    const parts = [];
    let depth = 0;
    let from = 0;
    for (let i = 0; i < text.length; i++)
    {
        const c = text[i];
        if (c === '(' || c === '[' || c === '{')
        {
            depth++;
        }
        else if (c === ')' || c === ']' || c === '}')
        {
            depth--;
        }
        else if (depth === 0)
        {
            separators.lastIndex = i;
            const match = separators.exec(text);
            if (match !== null)
            {
                parts.push(text.slice(from, i));
                from = i + match[0].length;
                i = from - 1;
            }
        }
    }
    parts.push(text.slice(from));
    return parts;
}

/**
 * The comparisons in an assertion's condition that hold a wall time from
 * above, as their text.
 *
 * @param {string} condition @param {ReturnType<typeof clockNames>} clock
 * @returns {string[]}
 */
export function wallBounds(condition, { names, properties }){
    /** @param {string} side */
    const timed = side=>elapsed(side) || [...names].some(name=>word(name).test(side))
        || [...properties].some(name=>new RegExp(`\\.${name.replace(/\$/g, '\\$')}(?![\\w$])`)
            .test(side));
    /** @type {string[]} */
    const found = [];
    for (const part of splitTop(condition, /&&|\|\|/y))
    {
        const [left, op, right] = (()=>{
            let depth = 0;
            for (let i = 0; i < part.length; i++)
            {
                const c = part[i];
                if (c === '(' || c === '[' || c === '{')
                {
                    depth++;
                }
                else if (c === ')' || c === ']' || c === '}')
                {
                    depth--;
                }
                else if (depth === 0 && (c === '<' || c === '>'))
                {
                    const before = part[i - 1];
                    const after = part[i + 1];
                    if (before === '=' || before === '<' || before === '>' || after === '<'
                        || after === '>')
                    {
                        continue;
                    }
                    const wide = after === '=' ? 2 : 1;
                    return [part.slice(0, i), part.slice(i, i + wide), part.slice(i + wide)];
                }
            }
            return [part, null, ''];
        })();
        if (op === null)
        {
            continue;
        }
        const smaller = op.startsWith('<') ? left : right;
        if (timed(smaller))
        {
            found.push(part.trim().replace(/\s+/g, ' '));
        }
    }
    return found;
}

/** @param {string} path */
export function checkFile(path){
    return findWallBounds(readFileSync(path, 'utf8'));
}

/**
 * The assertions' comparisons in a test's source that hold a wall time from above.
 *
 * @param {string} source
 * @returns {string[]}
 */
export function findWallBounds(source){
    const code = codeOnly(source);
    const names = clockNames(code);
    /** @type {string[]} */
    const found = [];
    for (const match of code.matchAll(/\bassert(?:\.ok)?\s*\(/g))
    {
        const condition = firstArgument(code, (match.index ?? 0) + match[0].length - 1);
        if (condition === null)
        {
            continue;
        }
        found.push(...wallBounds(condition, names));
    }
    return found;
}

/**
 * Whether a test's source makes a cork host (`createCorkHost`) without saying
 * how its slices end: an interpreted slice ends once it has taken its time
 * (`sliceMs`, 8 ms by default), so a test that runs one slice and reads what
 * the code left reads what a busy machine let the slice reach -- a trap
 * reached the call channel and the hlt after it did not, with eight busy loops
 * beside the suite. A test names `sliceMs`: Infinity for slices ended by their
 * instruction count, or the host's own (`undefined`) where its time is what
 * the test is about.
 *
 * @param {string} source
 */
export function untimedHosts(source){
    const code = codeOnly(source);
    return /\bcreateCorkHost\s*\(/.test(code) && !/\bsliceMs\b/.test(code);
}

const isMain = process.argv[1] !== undefined
    && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain)
{
    /** @type {string[]} */
    const problems = [];
    const known = new Set();
    let files = 0;
    for (const dir of DIRS)
    {
        for (const path of testFiles(dir))
        {
            files++;
            const at = relative(ROOT, path);
            if (untimedHosts(readFileSync(path, 'utf8')))
            {
                problems.push(`${at}: makes a cork host and does not name its sliceMs`);
            }
            for (const bound of checkFile(path))
            {
                const key = `${at}: ${bound}`;
                if (KNOWN.has(key))
                {
                    known.add(key);
                    continue;
                }
                problems.push(key);
            }
        }
    }
    for (const key of KNOWN.keys())
    {
        if (!known.has(key))
        {
            problems.push(`${key}: known, no longer found -- take it off KNOWN`);
        }
    }
    if (problems.length > 0)
    {
        console.error(`check-wall-bounds: ${problems.length} wall time(s) held from above`
            + ' in a test; hold what was asked for, a count, or processor time instead'
            + ' (tools/cpu-time.mjs), and end a test cork host\'s slices by their count'
            + ' (sliceMs: Infinity):');
        for (const problem of problems)
        {
            console.error(`  ${problem}`);
        }
        process.exit(1);
    }
    console.log(`check-wall-bounds: ${files} test files, no wall time held from above,`
        + ' every cork host\'s slices named');
}
