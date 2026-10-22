/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when the host scans guest memory for a terminator through a window of
 * a fixed length that starts where the scan does: a string, a list or a
 * shader's tokens read 256 bytes at a time from their first byte, then
 * searched for their end.
 *
 * Memory refuses a read that runs past the end of the region it starts in,
 * and a string that ends near the end of its region is ordinary: a name the
 * program put at the end of an allocation, a buffer at the top of a stack.
 * A window read past such a string's end was refused, and the call with it:
 * Crysis had a pixel shader refused so, its tokens ending within the last 244
 * bytes of the heap region they were in. A scan reads windows that end at a
 * multiple of their size (`scanWindows`, `readToTerminator`), or asks memory
 * for a scan that stops at the region's end (`readCString`, `readWideString`).
 *
 * A window is a read of more than one element (four bytes, or one dword of
 * `readDwords`) whose length constants bound: a literal, a constant, a
 * parameter's default, a condition's constant branch, `Math.min` of one. It
 * is a scan when what it read, or what is made of it, is searched with
 * `indexOf(0)`, or walked an element at a time (`for ... of`, an index
 * bounded by its length, a `while` over its elements) beside a comparison
 * with a zero or a named terminator. A record read whole and a fixed field of
 * a structure (`address + STRUCT.field`) are neither, and pass.
 *
 *     node tools/check-scan-windows.mjs [src]
 *
 * `src` is another tree's modules/core/src, to look at a revision before it
 * lands; the checkout's own by default.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'modules', 'core', 'src');

/** The guest reads a window can be made with, and the bytes in one element of each. */
const READS = new Map([
    ['readMemory', 1], ['readBytes', 1], ['readDwords', 4], ['readWords', 2], ['readU32s', 4],
]);
const CALL = new RegExp(`(?<![\\w$])(${[...READS.keys()].join('|')})\\s*\\(`, 'g');

/**
 * The code with its comments blanked to spaces, every other character and
 * every line end where it was, so a place in it is a place in the file.
 *
 * @param {string} code
 */
function blankComments(code){
    let out = '';
    let at = 0;
    let previous = '';
    while (at < code.length)
    {
        const ch = code[at];
        const next = code[at + 1];
        if (ch === '/' && (next === '/' || next === '*'))
        {
            const close = next === '/' ? '\n' : '*/';
            const found = code.indexOf(close, at + 2);
            const end = found < 0 ? code.length : next === '/' ? found : found + 2;
            out += code.slice(at, end).replace(/[^\n]/g, ' ');
            at = end;
            continue;
        }
        if (ch === '"' || ch === '\'' || ch === '`'
            || (ch === '/' && (previous === '' || '(,=:[!&|?{};+-*%<>~^'.includes(previous))))
        {
            let end = at + 1;
            let inClass = false;
            while (end < code.length)
            {
                const c = code[end];
                if (c === '\\')
                {
                    end += 2;
                    continue;
                }
                if (ch === '/' && c === '[')
                {
                    inClass = true;
                }
                else if (ch === '/' && c === ']')
                {
                    inClass = false;
                }
                else if (c === ch && !inClass || c === '\n' && ch !== '`')
                {
                    break;
                }
                end++;
            }
            out += code.slice(at, end + 1);
            at = end + 1;
            previous = 'x';
            continue;
        }
        out += ch;
        if (!/\s/.test(ch))
        {
            previous = ch;
        }
        at++;
    }
    return out;
}

/** @param {string} directory @returns {string[]} */
function sources(directory){
    /** @type {string[]} */
    const found = [];
    for (const name of readdirSync(directory).sort())
    {
        const path = join(directory, name);
        if (statSync(path).isDirectory())
        {
            found.push(...sources(path));
        }
        else if (/\.m?js$/.test(name) && !/\.(test|itest|fixture|x86)\.m?js$/.test(name))
        {
            found.push(path);
        }
    }
    return found;
}

/**
 * The arguments of the call whose parenthesis opens at `open`, and where it ends.
 *
 * @param {string} code @param {number} open
 * @returns {{ args: string[], end: number }}
 */
function argumentsAt(code, open){
    /** @type {string[]} */
    const args = [];
    let depth = 0;
    let from = open + 1;
    for (let at = open; at < code.length; at++)
    {
        const ch = code[at];
        if (ch === '(' || ch === '[' || ch === '{')
        {
            depth++;
        }
        else if (ch === ')' || ch === ']' || ch === '}')
        {
            depth--;
            if (depth === 0)
            {
                args.push(code.slice(from, at).trim());
                return { args, end: at + 1 };
            }
        }
        else if (ch === ',' && depth === 1)
        {
            args.push(code.slice(from, at).trim());
            from = at + 1;
        }
    }
    return { args, end: code.length };
}

/**
 * The parts of `text` at the top level, split at `separator`: none of them
 * inside parentheses or brackets.
 *
 * @param {string} text @param {string} separator
 */
function topLevel(text, separator){
    /** @type {string[]} */
    const parts = [];
    let depth = 0;
    let from = 0;
    for (let at = 0; at < text.length; at++)
    {
        const ch = text[at];
        if (ch === '(' || ch === '[')
        {
            depth++;
        }
        else if (ch === ')' || ch === ']')
        {
            depth--;
        }
        else if (depth === 0 && text.startsWith(separator, at))
        {
            parts.push(text.slice(from, at).trim());
            from = at + separator.length;
        }
    }
    parts.push(text.slice(from).trim());
    return parts;
}

/**
 * The most a read's length can be when constants bound it: a literal, a
 * constant bound to one before the read, a parameter whose default is one,
 * products and sums of those, a condition's constant branch, the constants
 * `Math.min` is given. Null when nothing bounds it, or when it is the caller's
 * own count.
 *
 * @param {string} code @param {string} text @param {number} at  Where the read is.
 * @returns {number | null}
 */
function boundOf(code, text, at){
    let expression = text.trim();
    while (expression.startsWith('(') && expression.endsWith(')')
        && topLevel(expression.slice(1, -1), ')').length === 1)
    {
        expression = expression.slice(1, -1).trim();
    }
    const condition = topLevel(expression, '?');
    if (condition.length === 2)
    {
        const branches = topLevel(condition[1], ':');
        const bounds = branches.map(branch=>boundOf(code, branch, at))
            .filter(bound=>bound !== null);
        return bounds.length > 0 ? Math.max(...bounds.map(Number)) : null;
    }
    const least = /^Math\.min\((.*)\)$/s.exec(expression);
    if (least)
    {
        const bounds = topLevel(least[1], ',').map(part=>boundOf(code, part, at))
            .filter(bound=>bound !== null);
        return bounds.length > 0 ? Math.min(...bounds.map(Number)) : null;
    }
    for (const [separator, combine] of /** @type {[string, (a: number, b: number) => number][]} */ (
        [['+', (a, b)=>a + b], ['*', (a, b)=>a * b]]))
    {
        const parts = topLevel(expression, separator);
        if (parts.length > 1)
        {
            const bounds = parts.map(part=>boundOf(code, part, at));
            return bounds.every(bound=>bound !== null)
                ? bounds.map(Number).reduce(combine) : null;
        }
    }
    const literal = /^(0x[0-9a-f]+|\d+)$/i.exec(expression);
    if (literal)
    {
        return Number(literal[1]);
    }
    if (!/^[A-Za-z_$][\w$]*$/.test(expression))
    {
        return null;
    }
    const name = expression.replace('$', '\\$');
    // The binding nearest before the read: two functions may each bind a STEP.
    const bindings = [...code.slice(0, at).matchAll(
        new RegExp(`\\bconst\\s+${name}\\s*=\\s*(0x[0-9a-f]+|\\d+)\\s*;`, 'gi'))];
    // Or a parameter whose default is the only length it is given.
    const bound = bindings.at(-1)
        ?? new RegExp(`\\bconst\\s+${name}\\s*=\\s*(0x[0-9a-f]+|\\d+)\\s*;`, 'i').exec(code)
        ?? new RegExp(`[(,]\\s*${name}\\s*=\\s*(0x[0-9a-f]+|\\d+)\\s*[,)]`, 'i').exec(code);
    return bound ? Number(bound[1]) : null;
}

/**
 * The braces around `at`: where the innermost block holding it opens and
 * closes, and the blocks around that one, innermost first.
 *
 * @param {string} code @param {number} at
 * @returns {{ open: number, close: number }[]}
 */
function blocksAround(code, at){
    /** @type {{ open: number, close: number }[]} */
    const blocks = [];
    let depth = 0;
    for (let index = at; index >= 0; index--)
    {
        const ch = code[index];
        if (ch === '}')
        {
            depth++;
        }
        else if (ch === '{')
        {
            if (depth > 0)
            {
                depth--;
                continue;
            }
            let inner = 0;
            let close = code.length;
            for (let end = index + 1; end < code.length; end++)
            {
                if (code[end] === '{')
                {
                    inner++;
                }
                else if (code[end] === '}')
                {
                    if (inner === 0)
                    {
                        close = end;
                        break;
                    }
                    inner--;
                }
            }
            blocks.push({ open: index, close });
        }
    }
    return blocks;
}

/**
 * Whether the block opening at `open` is the body of a loop, and the function
 * holding it is the same: a loop around the function that holds the read
 * reads nothing again.
 *
 * @param {string} code @param {number} open
 */
function loopBody(code, open){
    const head = code.slice(Math.max(0, open - 400), open);
    // The header's closing parenthesis is the last thing before the brace.
    if (/\bdo\s*$/.test(head))
    {
        return true;
    }
    const close = head.trimEnd();
    if (!close.endsWith(')'))
    {
        return false;
    }
    let depth = 0;
    for (let index = close.length - 1; index >= 0; index--)
    {
        const ch = close[index];
        if (ch === ')')
        {
            depth++;
        }
        else if (ch === '(')
        {
            depth--;
            if (depth === 0)
            {
                return /\b(for|while)\s*$/.test(close.slice(0, index));
            }
        }
    }
    return false;
}

/** Whether the block opening at `open` is a function's body. @param {string} code @param {number} open */
function functionBody(code, open){
    const head = code.slice(Math.max(0, open - 400), open).trimEnd();
    const method = /^\s*(?:async\s+)?\*?\s*([\w$]+)\s*\([^()]*\)\s*$/
        .exec(head.split('\n').pop() ?? '');
    return head.endsWith('=>') || /\bfunction\b[^{;]*\)\s*$/.test(head)
        || method !== null && !/^(for|while|if|switch|catch|with)$/.test(method[1]);
}

/**
 * The name the result of the read at `at` is held in, or null.
 *
 * @param {string} code @param {number} at
 */
function holderOf(code, at){
    const from = Math.max(code.lastIndexOf(';', at), code.lastIndexOf('{', at),
        code.lastIndexOf('}', at)) + 1;
    const statement = code.slice(from, at);
    const declared = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=[^=]/.exec(statement)
        ?? /(?:^|\s)([A-Za-z_$][\w$]*)\s*=[^=]/.exec(statement);
    return declared ? declared[1] : null;
}

/** @type {string[]} */
const problems = [];
let windows = 0;
let files = 0;
for (const path of sources(SRC))
{
    files++;
    // A checkout with CRLF line ends reads the same as one with LF.
    const code = blankComments(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'));
    for (const match of code.matchAll(CALL))
    {
        const at = /** @type {number} */ (match.index);
        const open = at + match[0].length - 1;
        const { args } = argumentsAt(code, open);
        const length = args.length === 2 ? boundOf(code, args[1], at) : null;
        const element = /** @type {number} */ (READS.get(match[1]));
        if (length === null || length * element <= 4)
        {
            continue;
        }
        windows++;
        // A field of a structure is as wide as the structure says, terminated or not.
        if (/\+\s*[A-Z][A-Z0-9_]*\.[\w$]+\s*$/.test(args[0]))
        {
            continue;
        }
        const holder = holderOf(code, at);
        const blocks = blocksAround(code, at);
        // What the window is searched in: the rest of the block it was read in.
        const block = blocks[0] ?? { open: 0, close: code.length };
        const rest = code.slice(at, block.close);
        // The window, and what is made of it: units out of its bytes.
        const names = holder === null ? [] : [holder, ...[...rest.matchAll(
            new RegExp(`(?:const|let)\\s+([\\w$]+)\\s*=[^;]*\\b${holder.replace('$', '\\$')}\\b`,
                'g'))].map(made=>made[1])].map(made=>made.replace('$', '\\$'));
        const found = /^\s*\)?\s*(\.slice\(\))?\s*\.indexOf\(\s*0(x0+)?\s*\)/
            .test(code.slice(argumentsAt(code, open).end))
            || names.some(name=>new RegExp(`\\b${name}\\s*\\.\\s*indexOf\\(\\s*0(x0+)?\\s*\\)`)
                .test(rest));
        // Walked an element at a time, and left at an element that ends it.
        const walked = names.some(name=>
            new RegExp(`\\bfor\\s*\\(\\s*const\\s+[\\w$]+\\s+of\\s+${name}\\b`).test(rest)
            || new RegExp(`\\bfor\\s*\\([^;]*;[^;]*\\b${name}\\.length\\b[^;]*;`).test(rest)
            || new RegExp(`\\bwhile\\s*\\([^)]*\\b${name}\\s*\\[`).test(rest))
            && /[!=]==\s*(0(x0+)?|[A-Z][A-Z0-9_]*)\b(?!\s*[.[(])/.test(rest);
        if (!found && !walked)
        {
            continue;
        }
        // A loop between the read and the function it is in reads the next window.
        let looped = false;
        for (const around of blocks)
        {
            if (functionBody(code, around.open))
            {
                break;
            }
            if (loopBody(code, around.open))
            {
                looped = true;
                break;
            }
        }
        const line = code.slice(0, at).split('\n').length;
        problems.push(`${path.startsWith(ROOT) ? relative(ROOT, path) : path}:${line}:`
            + ` ${match[1]}(${args.join(', ')})`
            + ` reads a window of ${length * element} bytes${looped ? ' at a time' : ''}`
            + ' and searches it for a terminator: read windows that end at a multiple'
            + ' of their size (scanWindows)');
    }
}
// The rule says nothing if the reads it looks for are no longer written this way.
if (windows < 100)
{
    problems.push(`found ${windows} fixed-length reads in ${files} files:`
        + ' the shapes this script reads have changed');
}
if (problems.length > 0)
{
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log(`scan windows: ${windows} fixed-length reads in ${files} files, none a scan`);
