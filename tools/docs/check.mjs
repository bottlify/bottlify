/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when the documentation has a link that leads nowhere or a page nobody
 * can reach. Checked: every relative link of docs/, of the READMEs and of the
 * tools' index (tools/cdp_test/README.md, DIAGNOSING.md) leads to
 * a file, and an anchor in it to a heading of that page; a link to this
 * repository's main branch on GitHub leads to a file that exists; every page
 * under docs/ is in docs/README.md, which is the site's navigation.
 *
 * The docs were split from a few long files into pages; each move breaks the
 * links into it, and a link that leads nowhere says nothing until a reader
 * follows it.
 *
 * A page covers the code it describes: every file or folder outside docs/ it
 * links to, and what a `<!-- covers: path, path -->` line in it names (each
 * path must exist). `--staged` names the pages that cover a staged file and
 * are not staged themselves: a contract change updates its docs in the same
 * commit, and this is the reminder. It never fails; whether the page has to
 * change is the author's call. `--hook` says the same as a Claude Code hook's
 * JSON, and nothing when there is nothing to say.
 *
 *     node tools/docs/check.mjs [--staged | --hook]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headings, links } from './markdown.mjs';
import { isMain } from '../common.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO = 'https://github.com/bottlify/bottlify/blob/main/';
/** Where the site built from docs/ is served (`tools/docs/site.mjs`). */
const SITE = 'https://bottlify.app/docs/';

/**
 * The markdown pages under a folder, as paths relative to `root` with `/`.
 *
 * @param {string} root
 * @param {string} dir
 * @returns {string[]}
 */
export function pages(root, dir){
    const out = [];
    for (const name of readdirSync(join(root, dir)))
    {
        const path = posix.join(dir, name);
        if (statSync(join(root, path)).isDirectory())
        {
            out.push(...pages(root, path));
        }
        else if (name.endsWith('.md'))
        {
            out.push(path);
        }
    }
    return out;
}

/**
 * What is wrong with the docs under `root`, one line each.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function check(root){
    const read = (/** @type {string} */ file)=>readFileSync(join(root, file), 'utf8');
    const docs = pages(root, 'docs');
    const modules = existsSync(join(root, 'modules'))
        ? readdirSync(join(root, 'modules')).map(name=>`modules/${name}/README.md`)
            .filter(file=>existsSync(join(root, file)))
        : [];
    const top = existsSync(join(root, 'README.md')) ? ['README.md'] : [];
    // The instruments' index and the order to look in, which CLAUDE.md sends every session to.
    const tools = ['tools/cdp_test/README.md', 'tools/cdp_test/DIAGNOSING.md']
        .filter(file=>existsSync(join(root, file)));
    const files = [...docs, ...modules, ...top, ...tools];
    /** @type {Map<string, Set<string>>} */
    const anchors = new Map();
    const anchorsOf = (/** @type {string} */ file)=>{
        if (!anchors.has(file))
        {
            anchors.set(file, new Set(headings(read(file)).map(heading=>heading.anchor)));
        }
        return /** @type {Set<string>} */ (anchors.get(file));
    };
    const problems = [];
    for (const file of files)
    {
        for (const { url, line } of links(read(file)))
        {
            const where = `${file}:${line}: ${url}`;
            let target;
            let anchor;
            if (url.startsWith(REPO))
            {
                [target, anchor = ''] = url.slice(REPO.length).split('#');
            }
            else if (url.startsWith(SITE))
            {
                // The page the site builds from: `x.html` from `x.md`, a folder
                // from its README.md.
                const [path, hash = ''] = url.slice(SITE.length).split('#');
                target = `docs/${path.replace(/(^|\/)$/, '$1README.md')
                    .replace(/(^|\/)index\.html$/, '$1README.md').replace(/\.html$/, '.md')}`;
                anchor = hash;
            }
            else if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(url))
            {
                continue;
            }
            else
            {
                const [path, hash = ''] = url.split('#');
                target = path ? posix.normalize(posix.join(posix.dirname(file), path)) : file;
                anchor = hash;
            }
            target = target.replace(/\/$/, '');
            if (!existsSync(join(root, target)))
            {
                problems.push(`${where}: no such file`);
            }
            else if (anchor && target.endsWith('.md') && !anchorsOf(target).has(anchor))
            {
                problems.push(`${where}: no heading #${anchor} in ${target}`);
            }
        }
    }
    if (docs.includes('docs/README.md'))
    {
        const listed = new Set(links(read('docs/README.md'))
            .map(({ url })=>posix.normalize(posix.join('docs', url.split('#')[0]))));
        for (const page of docs)
        {
            if (page !== 'docs/README.md' && !listed.has(page))
            {
                problems.push(`${page}: not in docs/README.md, so the site has no way to it`);
            }
        }
    }
    else
    {
        problems.push('docs/README.md: missing; it is the site\'s navigation');
    }
    for (const page of docs)
    {
        for (const path of declared(read(page)))
        {
            if (!existsSync(join(root, path)))
            {
                problems.push(`${page}: covers ${path}, which does not exist`);
            }
        }
    }
    return problems;
}

/**
 * The paths a page's `<!-- covers: ... -->` lines name.
 *
 * @param {string} text
 */
const declared = text=>[...text.matchAll(/<!--\s*covers:([\s\S]*?)-->/g)]
    .flatMap(match=>match[1].split(/[\s,]+/)).filter(Boolean).map(path=>path.replace(/\/$/, ''));

/**
 * The code a page covers: the files and folders outside docs/ it links to,
 * markdown left out, and what its `covers:` lines name.
 *
 * @param {string} root
 * @param {string} page
 * @returns {string[]}
 */
export function covered(root, page){
    const text = readFileSync(join(root, page), 'utf8');
    const out = new Set(declared(text));
    for (const { url } of links(text))
    {
        const path = url.startsWith(REPO) ? url.slice(REPO.length).split('#')[0]
            : /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(url) ? null
                : posix.normalize(posix.join(posix.dirname(page), url.split('#')[0]));
        // A link to a whole package or the tree (`modules/`, `modules/cork/`) is
        // a pointer, not a description: it would make every change a reminder.
        const broad = (/** @type {string} */ at)=>at.replace(/\/$/, '').split('/').length < 3
            && statSync(join(root, at)).isDirectory();
        if (path && !path.startsWith('docs/') && !path.startsWith('../') && !path.endsWith('.md')
            && existsSync(join(root, path)) && !broad(path))
        {
            out.add(path.replace(/\/$/, ''));
        }
    }
    return [...out];
}

/**
 * The pages that cover a changed file and did not change themselves, with the
 * files of theirs that did.
 *
 * @param {string} root
 * @param {string[]} changed  Paths relative to `root`, with `/`.
 * @returns {{ page: string, files: string[] }[]}
 */
export function stale(root, changed){
    const touched = new Set(changed);
    return pages(root, 'docs').filter(page=>!touched.has(page)).map(page=>{
        const paths = covered(root, page);
        const files = changed.filter(file=>paths.some(path=>file === path
            || file.startsWith(`${path}/`)));
        return { page, files };
    }).filter(entry=>entry.files.length);
}

if (isMain(import.meta.url) && process.argv.some(arg=>arg === '--staged'
    || arg === '--hook'))
{
    const changed = execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: ROOT,
        encoding: 'utf8' }).split('\n').filter(Boolean);
    const lines = stale(ROOT, changed).map(({ page, files })=>{
        const more = files.length > 4 ? ` and ${files.length - 4} more` : '';
        return `${page} describes ${files.slice(0, 4).join(', ')}${more}`;
    });
    if (lines.length)
    {
        const text = 'Staged code that these docs pages describe, the pages themselves not staged. '
            + 'If the change alters a contract (a public API or option, a module\'s requires, a '
            + 'Win32 behaviour, a limit), update the page in this commit; otherwise go on:\n'
            + lines.map(line=>`- ${line}`).join('\n');
        console.log(process.argv.includes('--hook')
            ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse',
                additionalContext: text } })
            : text);
    }
}
else if (isMain(import.meta.url))
{
    const problems = check(ROOT);
    for (const problem of problems)
    {
        console.error(problem);
    }
    if (problems.length)
    {
        console.error(`${problems.length} problems in the docs`);
        process.exit(1);
    }
    console.log('docs: every link leads somewhere, every page is listed');
}
