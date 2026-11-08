/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when the documentation has a link that leads nowhere or a page nobody
 * can reach. Checked: every relative link of docs/ and of the READMEs leads to
 * a file, and an anchor in it to a heading of that page; a link to this
 * repository's main branch on GitHub leads to a file that exists; every page
 * under docs/ is in docs/README.md, which is the site's navigation.
 *
 * The docs were split from a few long files into pages; each move breaks the
 * links into it, and a link that leads nowhere says nothing until a reader
 * follows it.
 *
 *     node tools/docs/check.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headings, links } from './markdown.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPO = 'https://github.com/bottlify/bottlify/blob/main/';

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
    const files = [...docs, ...modules, ...top];
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
    return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
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
