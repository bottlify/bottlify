/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Functions written more than once: bodies that are the same up to the names
 * they use, in more than one file - candidates for one shared mechanism.
 *
 * Every function (a declaration, an expression, an arrow, a method) of the
 * packages and the tools is read as its tokens, comments left out: each name
 * is renamed to the order it first appears in in that function (`$0`, `$1`,
 * ...), so the same body over other names is the same text, while keywords,
 * operators and literals stay as they are (a different constant is a different
 * function). Bodies of at least `--tokens` tokens (25) are hashed and those
 * with one hash in two files or more are a cluster. A cluster whose every
 * copy lies inside a copy of a larger cluster is the larger one's part and is
 * not listed again. Clusters are sorted by the lines a shared one would save:
 * the lines of a copy times the copies past the first.
 *
 * Tests and the guest-code outputs (`*.x86.js`, `*.x64.js`) are left out;
 * `--tests` takes the tests in. Two functions alike but not equal (a line
 * more, an operator other) are not found: this sees copies, not variations.
 *
 * Usage: node tools/checks/duplicate-code.mjs [--top N] [--tokens N] [--tests] [--json]
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { isMain, number } from '../lib/common.mjs';

const SKIP = /(^|\/)(node_modules|dist|vendor|\.git|reports)(\/|$)/;
const TEST = /\.(test|itest)\.m?js$/;
const GENERATED = /\.(x86|x64)\.js$/;
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/**
 * @typedef {{ file: string, line: number, lines: number, name: string, start: number,
 *     end: number, hash: string }} Copy
 * @typedef {{ tokens: number, lines: number, saves: number, copies: Copy[] }} Cluster
 */

/** @param {string} root @param {string} dir @returns {string[]} */
function walk(root, dir){
    if (!existsSync(dir))
    {
        return [];
    }
    /** @type {string[]} */
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true }))
    {
        const path = join(dir, entry.name);
        if (SKIP.test(relative(root, path).split(sep).join('/')))
        {
            continue;
        }
        if (entry.isDirectory())
        {
            out.push(...walk(root, path));
        }
        else if (/\.m?js$/.test(entry.name))
        {
            out.push(path);
        }
    }
    return out;
}

/**
 * A token as the hash sees it: a name by the order it came in, anything else
 * as written.
 *
 * @param {any} token @param {Map<string, string>} names @param {string} source
 */
function normal(token, names, source){
    const type = token.type;
    if (type.label === 'name' || type.label === 'privateId')
    {
        let renamed = names.get(token.value);
        if (renamed === undefined)
        {
            renamed = `$${names.size}`;
            names.set(token.value, renamed);
        }
        return renamed;
    }
    if (type.label === 'template' || type.label === 'string' || type.label === 'num'
        || type.label === 'regexp' || type.label === 'bigint')
    {
        return source.slice(token.start, token.end);
    }
    return type.keyword ?? type.label;
}

/**
 * The functions of one source, each with its normalised hash.
 *
 * @param {string} source @param {string} file  as it is listed @param {number} least  tokens
 * @returns {(Copy & { tokens: number, parent: number })[]}
 */
export function functionsOf(source, file, least){
    /** @type {any[]} */
    const tokens = [];
    /** @type {any} */
    let ast;
    try
    {
        ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module',
            allowHashBang: true, locations: true, onToken: tokens });
    }
    catch {
        return [];
    }
    /** @type {(Copy & { tokens: number, parent: number })[]} */
    const out = [];
    /** The first token at or after a position. @param {number} at */
    const first = at=>{
        let low = 0;
        let high = tokens.length;
        while (low < high)
        {
            const mid = (low + high) >> 1;
            if (tokens[mid].start < at)
            {
                low = mid + 1;
            }
            else
            {
                high = mid;
            }
        }
        return low;
    };
    /** @param {any} node @param {number} parent  the index in `out` of the function around it */
    const visit = (node, parent, /** @type {string} */ name)=>{
        if (!node || typeof node.type !== 'string')
        {
            return;
        }
        let inside = parent;
        if (FUNCTIONS.has(node.type))
        {
            const from = first(node.start);
            const to = first(node.end);
            if (to - from >= least)
            {
                const names = new Map();
                const text = tokens.slice(from, to).map(token=>normal(token, names, source))
                    .join(' ');
                const { start, end } = node.loc;
                out.push({ file, line: start.line, lines: end.line - start.line + 1,
                    name: node.id?.name ?? name, start: node.start, end: node.end,
                    tokens: to - from,
                    hash: createHash('sha1').update(text).digest('hex'), parent });
                inside = out.length - 1;
            }
        }
        for (const key of Object.keys(node))
        {
            if (key === 'loc')
            {
                continue;
            }
            const value = node[key];
            // What a function is called by where it stands: a variable, a key, an assignment.
            const keyed = ['Property', 'MethodDefinition', 'PropertyDefinition']
                .includes(node.type);
            const called = node.type === 'VariableDeclarator' && key === 'init' ? node.id?.name
                : keyed && key === 'value' ? node.key?.name ?? name
                    : node.type === 'AssignmentExpression' && key === 'right'
                        ? node.left?.property?.name ?? node.left?.name : '(anonymous)';
            for (const child of Array.isArray(value) ? value : [value])
            {
                if (child && typeof child === 'object')
                {
                    visit(child, inside, called ?? '(anonymous)');
                }
            }
        }
    };
    visit(ast, -1, '(anonymous)');
    return out;
}

/**
 * The clusters of a set of sources.
 *
 * @param {{ file: string, source: string }[]} sources @param {number} least
 * @returns {Cluster[]}
 */
export function clusters(sources, least){
    const all = sources.flatMap(({ file, source })=>{
        /** @type {(ReturnType<typeof functionsOf>[0] & { around: any })[]} */
        const found = functionsOf(source, file, least).map(one=>({ ...one, around: null }));
        found.forEach(one=>{
            one.around = one.parent < 0 ? null : found[one.parent];
        });
        return found;
    });
    /** @type {Map<string, typeof all>} */
    const byHash = new Map();
    for (const one of all)
    {
        const list = byHash.get(one.hash) ?? [];
        list.push(one);
        byHash.set(one.hash, list);
    }
    const kept = [...byHash.values()].filter(list=>new Set(list.map(one=>one.file)).size > 1);
    const clustered = new Set(kept.flat());
    /** Whether a function lies inside one that is itself a copy. @param {typeof all[0]} one */
    const within = one=>{
        for (let up = one.around; up; up = up.around)
        {
            if (clustered.has(up))
            {
                return true;
            }
        }
        return false;
    };
    return kept.filter(list=>!list.every(within)).map(list=>{
        const lines = Math.max(...list.map(one=>one.lines));
        return { tokens: list[0].tokens, lines, saves: lines * (list.length - 1),
            copies: list.map(({ file, line, lines: n, name, start, end, hash })=>
                ({ file, line, lines: n, name, start, end, hash })) };
    }).sort((a, b)=>b.saves - a.saves || b.tokens - a.tokens);
}

/** @param {Cluster[]} found @param {number} top */
export function render(found, top){
    const saves = found.reduce((sum, cluster)=>sum + cluster.saves, 0);
    const out = [`${found.length} clusters of functions alike in more than one file; `
        + `one of each kept, ${saves} lines would go`];
    for (const cluster of found.slice(0, top))
    {
        out.push(`${cluster.saves} lines: ${cluster.copies.length} copies of ${cluster.lines} `
            + `lines (${cluster.tokens} tokens)`);
        cluster.copies.forEach(copy=>out.push(`  ${copy.file}:${copy.line} ${copy.name}`));
    }
    return out.join('\n');
}

if (isMain(import.meta.url))
{
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const argv = process.argv.slice(2);
    const tests = argv.includes('--tests');
    const files = [...readdirSync(join(root, 'modules'))
        .flatMap(name=>walk(root, join(root, 'modules', name))), ...walk(root, join(root, 'tools'))]
        .filter(file=>!GENERATED.test(file) && (tests || !TEST.test(file)));
    const found = clusters(files.map(file=>({ file: relative(root, file).split(sep).join('/'),
        source: readFileSync(file, 'utf8') })), number(argv, '--tokens', 25));
    console.log(argv.includes('--json') ? JSON.stringify(found, null, 1)
        : render(found, number(argv, '--top', 20)));
}
