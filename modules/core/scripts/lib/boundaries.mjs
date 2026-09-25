/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';

/**
 * Packages that implement the cpu layer's executor contract.
 *
 * The core loads one of them by a module URL in its configuration when a
 * launch selects it, and must run with every one of them absent -- a launch
 * that selects the vendored emulator needs no translator installed. So no
 * file under the core's `src/` may import one: the dependency would make the
 * optional engine a required one, and the boundary checker refuses it.
 */
export const ENGINE_PACKAGES = Object.freeze(['@bottlify/cork']);

/**
 * The boundary issue an import specifier raises, or null.
 *
 * @param {string} spec  the specifier as written in the import
 * @returns {string | null}
 */
export function enginePackageIssue(spec){
    const hit = ENGINE_PACKAGES.find(name=>spec === name || spec.startsWith(`${name}/`));
    return hit === undefined
        ? null
        : `imports ${hit}: core must not depend on an engine package`;
}

/**
 * The code with its comments blanked out, strings and templates kept.
 *
 * Only the checks that must not fire on prose use this: a JSDoc type import is
 * a real dependency and is read from the raw text, but "import(" in a sentence
 * is not a computed import. A `/` starts a regular expression where an operand
 * is expected, so a quote inside one does not open a string.
 *
 * @param {string} code
 * @returns {string}
 */
export function withoutComments(code){
    let out = '';
    let at = 0;
    let previous = '';
    while (at < code.length)
    {
        const ch = code[at];
        const next = code[at + 1];
        if (ch === '/' && next === '/')
        {
            const end = code.indexOf('\n', at);
            at = end === -1 ? code.length : end;
            continue;
        }
        if (ch === '/' && next === '*')
        {
            const end = code.indexOf('*/', at + 2);
            at = end === -1 ? code.length : end + 2;
            out += ' ';
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
                else if (c === ch && !inClass)
                {
                    break;
                }
                else if (c === '\n' && ch !== '`')
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

/**
 * What a file reaches for that a specifier match cannot see: `import()` of a
 * computed argument, and a module-relative `new URL('literal', import.meta.url)`.
 *
 * @param {string} code
 * @returns {{ computed: number, urls: string[] }}
 */
export function indirectImportsOf(code){
    const bare = withoutComments(code);
    let computed = 0;
    for (const match of bare.matchAll(/(?<![\w$.])import\s*\(\s*/g))
    {
        const rest = bare.slice(match.index + match[0].length);
        const literal = /^(["'])[^"'\n]*\1\s*\)/.test(rest)
            || /^`[^`$]*`\s*\)/.test(rest);
        if (!literal)
        {
            computed++;
        }
    }
    const urls = [...bare.matchAll(
        /\bnew\s+URL\(\s*(["'`])([^"'`$\n]+)\1\s*,\s*import\.meta\.url\s*\)/g)]
        .map(match=>match[2]);
    return { computed, urls };
}

/**
 * Import specifiers written as literals: static imports and re-exports, and
 * `import()` of a string or of a template with nothing substituted into it.
 * Read from the raw text on purpose -- a JSDoc `import('...')` type is a
 * dependency as much as a statement is.
 */
const IMPORT_RE = new RegExp([
    /\bfrom\s*["']([^"']+)["']/.source,
    /\bimport\s*["']([^"']+)["']/.source,
    /import\s*\(\s*["']([^"']+)["']\s*\)/.source,
    /import\s*\(\s*`([^`$]+)`\s*\)/.source,
].join('|'), 'g');

/** @param {string} code @returns {string[]} */
const specifiersOf = code=>[...code.matchAll(IMPORT_RE)]
    .map(match=>match[1] ?? match[2] ?? match[3] ?? match[4])
    .filter(Boolean);

/**
 * The specifiers of the import statements themselves -- a static import or
 * re-export at the start of a statement, or `import()` of a literal -- over
 * the code with its comments gone. What a package-name rule reads: prose that
 * says "from 'somewhere'" in a comment or a message is not an import of it.
 *
 * @param {string} code
 * @returns {string[]}
 */
const statementSpecifiersOf = code=>{
    const bare = withoutComments(code);
    return [
        ...bare.matchAll(/(?:^|[;{}\n])\s*(?:import|export)\b[^;'"`]*?\bfrom\s*(["'])([^"'\n]+)\1/g),
        ...bare.matchAll(/(?:^|[;{}\n])\s*import\s*(["'])([^"'\n]+)\1/g),
        ...bare.matchAll(/(?<![\w$.])import\s*\(\s*(["'])([^"'\n]+)\1\s*\)/g),
    ].map(match=>match[2]);
};

/** @param {string} file */
const isTest = file=>/\.(test|itest)\.m?js$/.test(file);

/**
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir){
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true }))
    {
        const abs = join(dir, entry.name);
        if (entry.isDirectory())
        {
            out.push(...walk(abs));
        }
        else if (entry.isFile() && /\.m?js$/.test(abs))
        {
            out.push(abs);
        }
    }
    return out;
}

/**
 * Every boundary issue in a source tree.
 *
 * @param {Object} tree
 * @param {string} tree.src  The package's `src/`.
 * @param {string} tree.vendor  Its `vendor/`, reachable from the cpu layer alone.
 * @param {Map<string, Set<string>>} tree.requires  Each layer's declared `requires`.
 * @returns {{ files: string[], issues: string[] }}
 */
export function findBoundaryIssues({ src, vendor, requires }){
    /** @param {string} file */
    const classify = file=>{
        const rel = normalize(file).slice(src.length + 1).split(sep);
        if (rel[0] === 'system')
        {
            return { kind: 'system', layer: null };
        }
        if (rel[0] === 'layers')
        {
            return rel[1] === 'index.js'
                ? { kind: 'layers-index', layer: null }
                : { kind: 'layer', layer: rel[1] };
        }
        return { kind: 'root', layer: null };
    };

    const files = walk(src).filter(file=>!isTest(file));
    /** @type {string[]} */
    const issues = [];
    /** @type {Map<string, string[]>} */
    const graph = new Map(files.map(file=>[file, []]));

    for (const file of files)
    {
        const { kind, layer } = classify(file);
        const code = readFileSync(file, 'utf8');
        const indirect = indirectImportsOf(code);
        if (indirect.computed > 0 && kind !== 'root' && layer !== 'cpu')
        {
            issues.push(`${file} imports a module by a computed argument: only the cpu layer `
                + 'and the root of src may load a module that cannot be checked here');
        }
        for (const url of indirect.urls)
        {
            const target = resolve(dirname(file), url);
            if (target.startsWith(src + sep))
            {
                continue;
            }
            const allowed = kind === 'root' || (layer === 'cpu' && target.startsWith(vendor + sep));
            if (!allowed)
            {
                issues.push(`${file} reaches outside src by URL (${url})`);
            }
        }

        for (const spec of statementSpecifiersOf(code))
        {
            if (!spec.startsWith('.') && !spec.startsWith('node:')
                && enginePackageIssue(spec) === null)
            {
                issues.push(`${file} imports a package (${spec}): the core has no dependencies`);
            }
        }

        for (const spec of specifiersOf(code))
        {
            const engine = enginePackageIssue(spec);
            if (engine !== null)
            {
                issues.push(`${file} ${engine}`);
                continue;
            }
            if (!spec.startsWith('.'))
            {
                continue;
            }

            const target = resolve(dirname(file), spec);
            if (target.startsWith(vendor + sep))
            {
                if (layer !== 'cpu')
                {
                    issues.push(`${file} imports vendor (${spec}): `
                        + 'vendor is reachable only from layers/cpu');
                }
                continue;
            }
            if (!target.startsWith(src + sep))
            {
                issues.push(`${file} imports outside src (${spec})`);
                continue;
            }
            graph.get(file)?.push(target);

            const t = classify(target);
            if (kind === 'system' && (t.kind === 'layer' || t.kind === 'layers-index'))
            {
                issues.push(`${file} (system) imports a layer (${spec}): `
                    + 'system must not know layers');
                continue;
            }
            if (kind === 'layer')
            {
                if (t.kind === 'layers-index')
                {
                    issues.push(`${file} imports the layer aggregator (${spec}): `
                        + 'import the layer module directly');
                }
                const declared = requires.get(/** @type {string} */ (layer));
                if (t.kind === 'layer' && t.layer !== layer
                    && !declared?.has(/** @type {string} */ (t.layer)))
                {
                    issues.push(`${file} imports layer "${t.layer}" (${spec}) `
                        + 'but it is not declared in requires');
                }
                if (t.kind === 'root')
                {
                    issues.push(`${file} imports core.js (${spec}): `
                        + 'the facade is a consumer, not a dependency');
                }
            }
        }
    }

    /** @type {Map<string, number>} */
    const state = new Map();
    /** @param {string} file @returns {string | null} */
    const visit = file=>{
        const seen = state.get(file);
        if (seen === 1)
        {
            return null;
        }
        if (seen === 0)
        {
            return file;
        }
        state.set(file, 0);
        for (const next of graph.get(file) ?? [])
        {
            const hit = visit(next);
            if (hit)
            {
                return hit;
            }
        }
        state.set(file, 1);
        return null;
    };
    for (const file of files)
    {
        const hit = visit(file);
        if (hit)
        {
            issues.push(`Import cycle detected involving: ${hit}`);
            break;
        }
    }
    return { files, issues };
}
