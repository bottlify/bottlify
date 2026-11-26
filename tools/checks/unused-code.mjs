/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What code nobody reaches: the source files no entry point imports, the ones
 * only the typecheck needs, the ones only tests import, and the names a file
 * exports that no other file takes.
 *
 * The roots are what can start code: each package's `exports`, `main` and
 * `bin`, the build's entry points (the `join(SRC, ...)` and `join(CORK_SRC,
 * ...)` paths `modules/core/scripts/build.mjs` names), the files the package
 * scripts and the workflows run, the top of each package's `scripts/` and
 * `bin/`, all of its `bench/` (run by hand, each its own program), every
 * page (`*.html`: its `<script src>` and the imports of its inline modules),
 * the repository's own top-level scripts, every tool under `tools/` but its
 * shared `lib/` and `fixtures/` (reached by import), and every file a
 * Markdown page says to run (`node path.mjs`). From them every static
 * import, `export ... from`, `import()` of a literal, `new URL('...', import.meta.url)` and `new
 * Worker('...')` is followed, a query or a hash cut off; `@bottlify/<name>`
 * resolves through that package's `exports`.
 *
 * Two kinds of use: a run (the above) and a type - a JSDoc `import('./x.js')`
 * or `@import ... from './x.js'`, or a `.d.ts` beside the code. A file only
 * types reach is needed by the typecheck and runs nowhere; it is listed
 * apart, never as dead. A guest-code output (`x.x86.js`, `x.x64.js`, which
 * `npm run build` writes from `x.js`) belongs to its source: the source is
 * used wherever an output is, with every name it exports, and an output no
 * run reaches while the other width's does is a width built and not wired.
 *
 * An export is used when another file takes it by name (a run or a type), or
 * takes all of them (`import *`, `export *`, `import()`); one nobody takes is
 * listed with whether its own file uses it (drop `export`) or not (delete
 * it), and apart when only tests take it. A re-export counts as a use of the
 * name it passes on. What a string built at run time reaches (`import(name)`,
 * a URL put together from parts, a table of names) this cannot see:
 * `--unresolved` lists every such place, and each is read before anything is
 * deleted.
 *
 * Usage: node tools/checks/unused-code.mjs [--json] [--exports] [--unresolved]
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import { isMain } from '../lib/common.mjs';

const SKIP = /(^|\/)(node_modules|dist|vendor|\.git|reports)(\/|$)/;
const TEST = /\.(test|itest)\.m?js$/;
const GENERATED = /\.(x86|x64)\.js$/;
/** A file that is test support by its name: kept for tests, not product code. */
const HELPER = /(^|\/)(testing|fixtures?)\/|fixtures?\.m?js$|(^|\/)test-[\w-]+\.m?js$/;

/**
 * @typedef {'run' | 'type'} Kind
 * @typedef {{ path: string, names: Set<string>, kind: Kind }} Edge
 * @typedef {{ line: number, what: string }} Unseen
 * @typedef {{ exports: Map<string, { local: string, line: number }>, edges: Edge[],
 *     unseen: Unseen[], inside: (local: string) => boolean, lines: number, code: boolean }} Scan
 * @typedef {'run' | 'types' | 'tests' | 'nothing'} Status
 * @typedef {{ file: string, lines: number, notes: string[] }} Row
 * @typedef {{ files: RegExp, names: (match: RegExpExecArray) => string[], by: string }} Registry
 *     exports a script loads by a computed name: those of each file whose path (from the root)
 *     `files` matches, named from the match
 * @typedef {{ file: string, name: string, line: number, takers: 'nobody' | 'tests',
 *     inside: boolean }} Unused
 */

/** @param {string} root @param {string} dir @param {RegExp} name @returns {string[]} */
function walk(root, dir, name){
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
            out.push(...walk(root, path, name));
        }
        else if (name.test(entry.name))
        {
            out.push(path);
        }
    }
    return out;
}

/**
 * The path an `exports` value names, under the condition an ES module loads.
 *
 * @param {any} value @returns {string | undefined}
 */
const target = value=>(typeof value === 'string' ? value
    : value && typeof value === 'object' ? target(value.import ?? value.default ?? value.node)
        : undefined);

/**
 * A resolver of import specifiers for one tree: relative paths, and
 * `@bottlify/<name>[/sub]` through that package's `exports`.
 *
 * @param {Map<string, { dir: string, json: any }>} packages  by package name
 * @returns {(from: string, spec: string) => string | null}
 */
function resolver(packages){
    return (from, spec)=>{
        spec = spec.replace(/[?#].*$/, '');
        let path;
        if (spec.startsWith('.'))
        {
            path = resolve(dirname(from), spec);
        }
        else
        {
            const name = /^(@[^/]+\/[^/]+|[^/]+)(\/.*)?$/.exec(spec);
            const pkg = name && packages.get(name[1]);
            if (!name || !pkg)
            {
                return null;
            }
            const exports = pkg.json.exports;
            const key = `.${name[2] ?? ''}`;
            const named = typeof exports === 'string' ? (key === '.' ? exports : undefined)
                : target(exports?.[key]) ?? (key === '.' ? pkg.json.main : undefined);
            if (!named)
            {
                return null;
            }
            path = resolve(pkg.dir, named);
        }
        if (!existsSync(path) && existsSync(`${path}.js`))
        {
            path = `${path}.js`;
        }
        return existsSync(path) && statSync(path).isFile() ? path : null;
    };
}

/** A JSDoc `import('x')`, with the member it takes, if any. */
const TYPE_IMPORT = /import\(\s*(['"])([^'"]+)\1\s*\)(?:[\s*]*\.\s*([A-Za-z_$][\w$]*))?/g;
/** A TypeScript-in-JSDoc `@import { A, B as C } from 'x'` or `@import * as N from 'x'`. */
const AT_IMPORT = /@import\s+(?:\{([^}]*)\}|\*\s+as\s+[\w$]+)\s+from\s+(['"])([^'"]+)\2/g;
/** A declaration file's own `import ... from 'x'` or `export ... from 'x'`. */
const FROM = /^\s*(?:import|export)\b[^'"\n]*\bfrom\s+(['"])([^'"]+)\1/gm;

/**
 * The type uses in a text: a file's comments, or a whole `.d.ts`.
 *
 * @param {string} text @param {boolean} declaration
 * @returns {{ spec: string, names: Set<string> }[]}
 */
function typeUses(text, declaration){
    const out = [];
    for (const match of text.matchAll(TYPE_IMPORT))
    {
        out.push({ spec: match[2], names: new Set([match[3] ?? '*']) });
    }
    for (const match of text.matchAll(AT_IMPORT))
    {
        const names = match[1] === undefined ? ['*']
            : match[1].split(',').map(one=>one.trim().split(/\s+as\s+/)[0]).filter(Boolean);
        out.push({ spec: match[3], names: new Set(names) });
    }
    if (declaration)
    {
        for (const match of text.matchAll(FROM))
        {
            out.push({ spec: match[2], names: new Set(['*']) });
        }
    }
    return out;
}

/**
 * The static text of a string or template argument; null when what names the
 * file is computed (a template's expression comes before its query).
 *
 * @param {any} node @returns {string | null}
 */
function literal(node){
    if (node?.type === 'BinaryExpression' && node.operator === '+')
    {
        const head = literal(node.left);
        return head !== null && /[?#]/.test(head) ? head : null;
    }
    if (node?.type === 'Literal' && typeof node.value === 'string')
    {
        return node.value;
    }
    if (node?.type === 'TemplateLiteral')
    {
        const head = node.quasis[0].value.cooked ?? '';
        if (node.expressions.length === 0 || /[?#]/.test(head))
        {
            return head;
        }
    }
    return null;
}

/** @param {any} node */
const isImportMetaUrl = node=>node?.type === 'MemberExpression'
    && node.object?.type === 'MetaProperty' && node.property?.name === 'url';

/**
 * Whether an identifier is a name read, not a property's key.
 *
 * @param {any} node @param {any} parent
 */
const isRead = (node, parent)=>!(parent?.type === 'MemberExpression' && parent.property === node
        && !parent.computed)
    && !(['Property', 'MethodDefinition', 'PropertyDefinition'].includes(parent?.type)
        && parent.key === node && !parent.computed && !parent.shorthand);

/**
 * A file's exports, its uses of other files and the places where what it
 * loads is computed.
 *
 * @param {string} file @param {(from: string, spec: string) => string | null} find
 * @returns {Scan}
 */
function scan(file, find){
    const source = readFileSync(file, 'utf8');
    /** @type {Map<string, { local: string, line: number }>} */
    const exports = new Map();
    /** @type {Edge[]} */
    const edges = [];
    /** @type {Unseen[]} */
    const unseen = [];
    const lines = source.split('\n').length;
    /** @param {string} spec @param {Set<string>} names @param {Kind} kind @param {number} line */
    const take = (spec, names, kind, line)=>{
        const path = find(file, spec);
        if (path)
        {
            edges.push({ path, names, kind });
        }
        else if (spec.startsWith('.') && /(^|\/)[^/.]+(\.m?js)?$/.test(spec.replace(/[?#].*$/, ''))
            && !existsSync(resolve(dirname(file), spec)))
        {
            unseen.push({ line, what: `${spec}: names no file here` });
        }
    };
    if (file.endsWith('.d.ts'))
    {
        typeUses(source, true).forEach(use=>take(use.spec, use.names, 'type', 0));
        return { exports, edges, unseen, inside: ()=>true, lines, code: false };
    }
    /** @type {acorn.Comment[]} */
    const comments = [];
    /** @type {any} */
    let ast;
    try
    {
        ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module',
            allowHashBang: true, locations: true, onComment: comments });
    }
    catch (e){
        unseen.push({ line: 0, what: `does not parse: ${/** @type {Error} */ (e).message}` });
        return { exports, edges, unseen, inside: ()=>true, lines, code: false };
    }
    for (const comment of comments)
    {
        const line = comment.loc?.start.line ?? 0;
        typeUses(comment.value, false).forEach(use=>take(use.spec, use.names, 'type', line));
    }
    /** How many times each name is read in the file, its own declaration included. */
    const reads = new Map();
    /** @param {any} node @param {any} parent */
    const visit = (node, parent)=>{
        if (!node || typeof node.type !== 'string')
        {
            return;
        }
        const line = node.loc?.start.line ?? 0;
        switch (node.type)
        {
            case 'Identifier':
                if (isRead(node, parent))
                {
                    reads.set(node.name, (reads.get(node.name) ?? 0) + 1);
                }
                return;
            case 'ImportDeclaration':
                take(node.source.value, new Set(node.specifiers.map((/** @type {any} */ s)=>
                    (s.type === 'ImportSpecifier' ? (s.imported.name ?? s.imported.value)
                        : s.type === 'ImportDefaultSpecifier' ? 'default' : '*'))), 'run', line);
                return;
            case 'ExportAllDeclaration':
                if (node.exported)
                {
                    exports.set(node.exported.name ?? node.exported.value, { local: '', line });
                }
                take(node.source.value, new Set(['*']), 'run', line);
                return;
            case 'ExportNamedDeclaration':
                if (node.source)
                {
                    take(node.source.value, new Set(node.specifiers.map((/** @type {any} */ s)=>
                        s.local.name ?? s.local.value)), 'run', line);
                }
                for (const s of node.specifiers)
                {
                    exports.set(s.exported.name ?? s.exported.value,
                        { local: node.source ? '' : s.local.name, line });
                }
                if (node.declaration)
                {
                    const d = node.declaration;
                    if (d.id)
                    {
                        exports.set(d.id.name, { local: d.id.name, line });
                    }
                    for (const v of d.declarations ?? [])
                    {
                        if (v.id.type === 'Identifier')
                        {
                            exports.set(v.id.name, { local: v.id.name, line });
                        }
                    }
                    visit(d, node);
                }
                return;
            case 'ExportDefaultDeclaration':
                exports.set('default', { local: node.declaration.id?.name ?? '', line });
                break;
            case 'ImportExpression': {
                const spec = literal(node.source);
                if (spec === null)
                {
                    const what = source.slice(node.source.start, node.source.end);
                    unseen.push({ line, what: `import(${what})` });
                }
                else
                {
                    take(spec, new Set(['*']), 'run', line);
                }
                break;
            }
            case 'NewExpression': {
                const callee = node.callee.name;
                const first = node.arguments[0];
                // A worker given its code (`{ eval: true }`) names no file.
                const worker = (callee === 'Worker' || callee === 'SharedWorker') && first
                    && first.type !== 'NewExpression' && !(first.type === 'TemplateLiteral'
                        && first.quasis.some((/** @type {any} */ q)=>q.value.raw.includes('\n')));
                if ((callee === 'URL' && isImportMetaUrl(node.arguments[1])) || worker)
                {
                    const spec = literal(first);
                    if (spec === null)
                    {
                        const what = source.slice(first.start, first.end);
                        unseen.push({ line,
                            what: `new ${callee}(${what}${worker ? '' : ', import.meta.url'})` });
                    }
                    else
                    {
                        take(spec, new Set(['*']), 'run', line);
                    }
                }
                break;
            }
            default:
        }
        for (const key of Object.keys(node))
        {
            const value = key === 'loc' ? null : node[key];
            if (Array.isArray(value))
            {
                value.forEach(child=>visit(child, node));
            }
            else if (value && typeof value === 'object')
            {
                visit(value, node);
            }
        }
    };
    visit(ast, null);
    const commentText = comments.map(comment=>comment.value).join('\n');
    /** @param {string} local */
    const inside = local=>local === '' || (reads.get(local) ?? 0) > 1
        || new RegExp(`typeof\\s+${local.replace(/\$/g, '\\$')}\\b`).test(commentText);
    // Whether the file holds anything a run would do: more than imports and `export {}`.
    const code = ast.body.some((/** @type {any} */ node)=>node.type !== 'ImportDeclaration'
        && !(node.type === 'ExportNamedDeclaration' && !node.declaration
            && node.specifiers.length === 0));
    return { exports, edges, unseen, inside, lines, code };
}

/**
 * A page's scripts: each `<script src>` and the imports of an inline module.
 *
 * @param {string} file @param {(from: string, spec: string) => string | null} find @returns {Scan}
 */
function scanPage(file, find){
    const text = readFileSync(file, 'utf8');
    const specs = [...text.matchAll(/<script\b[^>]*\bsrc\s*=\s*(['"])([^'"]+)\1/g)].map(m=>m[2]);
    for (const inline of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))
    {
        const imports = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g;
        specs.push(...[...inline[1].matchAll(imports)].map(m=>m[2]));
    }
    /** @type {Edge[]} */
    const edges = [];
    for (const spec of specs.filter(one=>!one.startsWith('/') && !/^\w+:/.test(one)))
    {
        const path = find(file, spec.startsWith('.') ? spec : `./${spec}`);
        if (path)
        {
            edges.push({ path, names: new Set(['*']), kind: 'run' });
        }
    }
    return { exports: new Map(), edges, unseen: [], inside: ()=>true, lines: 0, code: true };
}

/**
 * The build's entry points: every `join(BASE, '...')` in the build script
 * naming a file, BASE one of the folders it is given or one it joined from
 * them (`const output = join(SRC, ...)`).
 *
 * @param {string} script @param {Record<string, string>} bases  the build's names for folders
 * @returns {string[]}
 */
function buildEntries(script, bases){
    if (!existsSync(script) || !statSync(script).isFile())
    {
        return [];
    }
    const text = readFileSync(script, 'utf8');
    /** @type {Record<string, string>} */
    const dirs = { ...bases };
    const call = /join\(\s*([A-Za-z_$][\w$]*)((?:\s*,\s*'[^']*')+)\s*\)/g;
    const parts = (/** @type {string} */ list)=>[...list.matchAll(/'([^']*)'/g)].map(m=>m[1]);
    const define = new RegExp(`const\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${call.source}`, 'g');
    for (const def of text.matchAll(define))
    {
        if (dirs[def[2]])
        {
            dirs[def[1]] = join(dirs[def[2]], ...parts(def[3]));
        }
    }
    return [...text.matchAll(call)].filter(m=>dirs[m[1]]).map(m=>join(dirs[m[1]], ...parts(m[2])))
        .filter(path=>/\.m?js$/.test(path) && existsSync(path));
}

/**
 * The files a command line runs: each `<path>.js` or `.mjs` word naming one.
 *
 * @param {string} text @param {string} dir  what the paths are relative to
 */
const RUNS = /(?:^|[\s"'`])((?:\.{1,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.m?js)\b/g;
const runs = (text, dir)=>[...text.matchAll(RUNS)]
    .map(m=>resolve(dir, m[1])).filter(path=>existsSync(path) && statSync(path).isFile());

/**
 * The whole analysis of one tree: its packages are `modules/*`, its tools `tools/`.
 *
 * @param {string} root
 * @param {{ build?: string, bases?: Record<string, string>, registries?: Registry[] }} [options]
 *     the build script and its names for folders, relative to the root; the exports a script
 *     takes by a name it puts together
 */
export function analyse(root, options = {}){
    const packageDirs = existsSync(join(root, 'modules'))
        ? readdirSync(join(root, 'modules')).map(name=>join(root, 'modules', name))
            .filter(dir=>existsSync(join(dir, 'package.json')))
        : [];
    /** @type {Map<string, { dir: string, json: any }>} */
    const packages = new Map();
    for (const dir of packageDirs)
    {
        const json = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
        packages.set(json.name ?? dir, { dir, json });
    }
    const find = resolver(packages);
    const code = /\.m?js$/;
    const tools = join(root, 'tools');
    const files = [...packageDirs.flatMap(dir=>walk(root, dir, code)), ...walk(root, tools, code),
        ...readdirSync(root).filter(name=>code.test(name)).map(name=>join(root, name))];
    const declarations = packageDirs.flatMap(dir=>walk(root, dir, /\.d\.ts$/));
    const pages = [...packageDirs, tools].flatMap(dir=>walk(root, dir, /\.html$/));
    /** @type {Map<string, Scan>} */
    const scanned = new Map();
    [...files, ...declarations].forEach(file=>scanned.set(file, scan(file, find)));
    pages.forEach(file=>scanned.set(file, scanPage(file, find)));

    for (const file of files.filter(one=>GENERATED.test(one)))
    {
        const origin = file.replace(GENERATED, '.js');
        if (scanned.has(origin))
        {
            scanned.get(file)?.edges.push({ path: origin, names: new Set(['*']), kind: 'run' });
        }
    }

    /** @type {Map<string, string>} each root and what made it one */
    const roots = new Map();
    const addRoot = (/** @type {string} */ path, /** @type {string} */ why)=>{
        if (scanned.has(path) && !roots.has(path))
        {
            roots.set(path, why);
        }
    };
    for (const { dir, json } of packages.values())
    {
        const add = (/** @type {any} */ value)=>{
            if (typeof value === 'string')
            {
                addRoot(resolve(dir, value), 'package exports');
            }
            else if (value && typeof value === 'object')
            {
                Object.values(value).forEach(add);
            }
        };
        [json.exports, json.main, json.bin].forEach(add);
        Object.values(json.scripts ?? {}).forEach(line=>runs(String(line), dir)
            .forEach(path=>addRoot(path, 'scripts')));
        for (const top of ['scripts', 'bin'])
        {
            files.filter(file=>dirname(file) === join(dir, top) && !TEST.test(file))
                .forEach(file=>addRoot(file, 'scripts'));
        }
        files.filter(file=>file.startsWith(join(dir, 'bench') + sep) && !TEST.test(file))
            .forEach(file=>addRoot(file, 'bench'));
    }
    if (existsSync(join(root, 'package.json')))
    {
        const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
        Object.values(json.scripts ?? {}).forEach(line=>runs(String(line), root)
            .forEach(path=>addRoot(path, 'scripts')));
    }
    for (const flow of walk(root, join(root, '.github', 'workflows'), /\.ya?ml$/))
    {
        runs(readFileSync(flow, 'utf8'), root).forEach(path=>addRoot(path, 'scripts'));
    }
    const command = /\bnode\s+(?:--[\w-]+(?:=\S+)?\s+)*(\S+\.m?js)\b/g;
    const markdown = [...packageDirs, tools, join(root, 'docs')].flatMap(dir=>walk(root, dir, /\.md$/));
    for (const page of markdown)
    {
        for (const run of readFileSync(page, 'utf8').matchAll(command))
        {
            [resolve(root, run[1]), resolve(dirname(page), run[1])]
                .forEach(path=>addRoot(path, 'commands in a README'));
        }
    }
    const bases = Object.fromEntries(Object.entries(options.bases ?? {})
        .map(([name, dir])=>[name, join(root, dir)]));
    buildEntries(join(root, options.build ?? ''), bases)
        .forEach(path=>addRoot(path, 'build entries'));
    pages.forEach(page=>addRoot(page, 'pages'));
    declarations.forEach(file=>addRoot(file, 'declarations'));
    files.filter(file=>dirname(file) === root).forEach(file=>addRoot(file, 'scripts'));
    files.filter(file=>file.startsWith(tools + sep) && !file.startsWith(join(tools, 'lib') + sep)
        && !file.startsWith(join(tools, 'fixtures') + sep) && !TEST.test(file))
        .forEach(file=>addRoot(file, 'tools'));

    /** @param {string[]} from @param {boolean} types  whether type uses are followed too */
    const reach = (from, types)=>{
        const seen = new Set();
        const queue = [...from];
        while (queue.length)
        {
            const file = /** @type {string} */ (queue.pop());
            if (!seen.has(file))
            {
                seen.add(file);
                for (const edge of scanned.get(file)?.edges ?? [])
                {
                    if (types || edge.kind === 'run')
                    {
                        queue.push(edge.path);
                    }
                }
            }
        }
        return seen;
    };
    const tests = files.filter(file=>TEST.test(file));
    const ran = reach([...roots.keys()].filter(file=>!file.endsWith('.d.ts')), false);
    const typed = reach([...roots.keys()], true);
    const tested = reach([...roots.keys(), ...tests], true);
    const testsRun = reach(tests, false);
    const sourceFiles = files.filter(file=>!TEST.test(file));
    /** @type {(file: string) => Status} */
    const status = file=>(ran.has(file) ? 'run' : typed.has(file) ? 'types'
        : tested.has(file) ? 'tests' : 'nothing');
    const rel = (/** @type {string} */ file)=>relative(root, file).split(sep).join('/');
    /** @param {string} file @returns {Row} */
    const row = file=>{
        const notes = [];
        if (HELPER.test(rel(file)))
        {
            notes.push('a test helper by its name');
        }
        if (GENERATED.test(file))
        {
            const other = file.replace(/\.x(86|64)\.js$/,
                (_, width)=>(width === '86' ? '.x64.js' : '.x86.js'));
            if (ran.has(other))
            {
                notes.push(`a width built, not wired: ${rel(other).split('/').pop()} is`);
            }
        }
        if (status(file) === 'types')
        {
            notes.push(scanned.get(file)?.code ? 'holds code nothing runs'
                : 'declares types alone');
            if (testsRun.has(file))
            {
                notes.push('tests run it');
            }
        }
        return { file: rel(file), lines: scanned.get(file)?.lines ?? 0, notes };
    };
    const rows = (/** @type {Status} */ which)=>sourceFiles.filter(file=>status(file) === which)
        .map(row).sort((a, b)=>b.lines - a.lines || a.file.localeCompare(b.file));

    /** @type {Map<string, { product: Set<string>, tests: Set<string> }>} who takes what */
    const taken = new Map();
    for (const file of tested)
    {
        const fromTest = !typed.has(file);
        for (const edge of scanned.get(file)?.edges ?? [])
        {
            const entry = taken.get(edge.path) ?? { product: new Set(), tests: new Set() };
            edge.names.forEach(name=>(fromTest ? entry.tests : entry.product).add(name));
            taken.set(edge.path, entry);
        }
    }
    for (const registry of options.registries ?? [])
    {
        for (const file of sourceFiles)
        {
            const match = registry.files.exec(rel(file));
            const entry = match && (taken.get(file) ?? { product: new Set(), tests: new Set() });
            if (match && entry)
            {
                registry.names(match).forEach(name=>entry.product.add(name));
                taken.set(file, entry);
            }
        }
    }
    /** @type {Unused[]} */
    const exports = [];
    for (const file of sourceFiles.filter(one=>typed.has(one) && !roots.has(one)))
    {
        const one = /** @type {Scan} */ (scanned.get(file));
        const entry = taken.get(file);
        if (entry?.product.has('*'))
        {
            continue;
        }
        for (const [name, { local, line }] of one.exports)
        {
            if (!entry?.product.has(name))
            {
                exports.push({ file: rel(file), name, line,
                    takers: entry?.tests.has(name) || entry?.tests.has('*') ? 'tests' : 'nobody',
                    inside: one.inside(local) });
            }
        }
    }
    const unresolved = [...scanned]
        .flatMap(([file, one])=>one.unseen.map(u=>({ file: rel(file), ...u })))
        .sort((a, b)=>a.file.localeCompare(b.file) || a.line - b.line);
    /** @type {Record<string, number>} */
    const why = {};
    roots.forEach(reason=>{
        why[reason] = (why[reason] ?? 0) + 1;
    });
    exports.sort((a, b)=>a.file.localeCompare(b.file) || a.line - b.line);
    return { files: sourceFiles.length, roots: why, unreached: rows('nothing'),
        typesOnly: rows('types'), testOnly: rows('tests'), exports, unresolved };
}

/**
 * The report as text.
 *
 * @param {ReturnType<typeof analyse>} report
 * @param {{ exports?: boolean, unresolved?: boolean }} show
 */
export function render(report, show){
    const out = [];
    const sum = (/** @type {Row[]} */ list)=>list.reduce((s, r)=>s + r.lines, 0);
    const list = (/** @type {Row[]} */ rows)=>rows.forEach(r=>
        out.push(`  ${r.lines}\t${r.file}${r.notes.length ? `  (${r.notes.join('; ')})` : ''}`));
    out.push(`${report.files} source files; roots: `
        + `${Object.entries(report.roots).map(([why, n])=>`${n} ${why}`).join(', ')}`);
    const head = (/** @type {string} */ what, /** @type {Row[]} */ rows)=>
        out.push(`${what}: ${rows.length} files, ${sum(rows)} lines`);
    head('reached by nothing', report.unreached);
    list(report.unreached);
    head('reached only by types (the typecheck needs them, nothing runs them)', report.typesOnly);
    list(report.typesOnly);
    head('reached only from tests', report.testOnly);
    list(report.testOnly);
    const count = (/** @type {(e: Unused) => boolean} */ pick)=>report.exports.filter(pick).length;
    out.push(`exports no other code takes: ${count(e=>e.takers === 'nobody')} `
        + `(${count(e=>e.takers === 'nobody' && e.inside)} used in their own file, `
        + `${count(e=>e.takers === 'nobody' && !e.inside)} used nowhere); `
        + `taken only by tests: ${count(e=>e.takers === 'tests')}; `
        + `in ${new Set(report.exports.map(e=>e.file)).size} files`);
    if (show.exports)
    {
        report.exports.forEach(e=>out.push(`  ${e.file}:${e.line} ${e.name}  `
            + `${e.takers === 'tests' ? 'tests only' : 'nobody'}, `
            + `${e.inside ? 'used in its file' : 'used nowhere'}`));
    }
    out.push(`cannot see: ${report.unresolved.length} places that name a file at run time, `
        + `or a file that is not here${show.unresolved ? '' : ' (--unresolved lists them)'}`);
    if (show.unresolved)
    {
        report.unresolved.forEach(u=>out.push(`  ${u.file}:${u.line} ${u.what}`));
    }
    return out.join('\n');
}

if (isMain(import.meta.url))
{
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const report = analyse(root, { build: 'modules/core/scripts/build.mjs',
        bases: { SRC: 'modules/core/src', CORK_SRC: 'modules/cork/src' },
        // check-boundaries (and the checks that build a layer alone) import each layer's
        // module.js by its folder's name and take `<name>Module` from it.
        registries: [{ files: /^modules\/core\/src\/layers\/([\w-]+)\/module\.js$/,
            names: match=>[`${match[1]}Module`], by: 'modules/core/scripts/check-boundaries.mjs' }] });
    console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 1)
        : render(report, { exports: process.argv.includes('--exports'),
            unresolved: process.argv.includes('--unresolved') }));
}
