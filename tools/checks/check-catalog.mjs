/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when tools/ and its catalog part: a file under tools/ no entry of
 * tools/catalog.json covers (a script by its path, its data and modules by the
 * entry's `parts`, its tests by `tests`), an entry whose file is gone, a file
 * outside its category's folder, an instrument that runs without a browser and
 * has no real output sample, or a tools/README.md other than the one the
 * catalog makes.
 *
 *   node tools/checks/check-catalog.mjs           check
 *   node tools/checks/check-catalog.mjs --write   write tools/README.md from the catalog
 *
 * The tools had grown to some sixty instruments in one folder, each described
 * in a line, several looking at the same thing, none run on real data; the
 * folders are the catalog now, and this keeps them so.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { REPO_ROOT, isMain } from '../lib/common.mjs';

/** The folders of tools/, in the order the catalog's page lists them, and what each holds. */
export const CATEGORIES = {
    run: 'start a program and get a report: in a browser, in Node, from a phone',
    live: 'attach to a game a person is playing',
    read: 'read what a run left behind: a trace, a capture, shaders, a recording',
    translator: "cork's work on a real program: its mix, its code, its calls, its cost",
    bundles: 'make, inspect and audit bottles, archives and installers',
    gates: 'two paths of the engine compared on a real GPU (npm run cdp:*)',
    checks: 'the rules of the code check:boundaries holds (and one run by hand)',
    generators: 'scripts that rewrite a committed file from a specification or a processor',
    ci: "the repository's own jobs in its workflows",
    lib: 'modules the tools share, never run alone',
    fixtures: "programs and helpers the packages' tests import",
    docs: 'the documentation site and its link check',
};

/** Files tools/ itself holds. */
const TOP = ['tools/README.md', 'tools/catalog.json'];

/**
 * @typedef {Object} Entry
 * @property {string} path
 * @property {string} category
 * @property {string} kind      instrument, gate, check, generator, ci, library, fixture, docs
 * @property {boolean} browser  whether it needs the shared browser, a GPU or a phone
 * @property {string} question
 * @property {string} command
 * @property {string[]} tests
 * @property {string[]} [parts] files and folders (ending in /) that belong to the tool
 * @property {string} [sample]  real output, from this repository's own data
 * @property {string} [source]  the command and the data the sample came from
 * @property {string} [read]    how to read it
 */

/**
 * What is wrong between the catalog, the files under tools/ and the page.
 *
 * @param {{ tools: Entry[] }} catalog @param {string[]} files  tracked files under tools/
 * @param {(path: string) => boolean} exists @param {string} readme
 * @returns {string[]}
 */
export function problems(catalog, files, exists, readme){
    const found = [];
    const covers = (/** @type {string} */ file)=>catalog.tools.some(entry=>
        [entry.path, ...entry.tests, ...entry.parts ?? []].some(path=>
            path === file || (path.endsWith('/') && file.startsWith(path))));
    for (const file of files)
    {
        if (TOP.includes(file))
        {
            continue;
        }
        if (posix.dirname(file) === 'tools')
        {
            found.push(`${file}: at the top of tools/, which holds the catalog alone`);
        }
        else if (!covers(file))
        {
            found.push(`${file}: no catalog entry covers it`);
        }
    }
    for (const entry of catalog.tools)
    {
        if (!(entry.category in CATEGORIES))
        {
            found.push(`${entry.path}: no category ${entry.category}`);
            continue;
        }
        for (const path of [entry.path, ...entry.tests, ...entry.parts ?? []])
        {
            if (!exists(path.replace(/\/$/, '')))
            {
                found.push(`${entry.path}: ${path} is gone`);
            }
            if (!path.startsWith(`tools/${entry.category}/`))
            {
                found.push(`${entry.path}: ${path} is outside tools/${entry.category}/`);
            }
        }
        if (entry.kind === 'instrument' && !entry.browser && !(entry.sample && entry.source))
        {
            found.push(`${entry.path}: an instrument that runs here has no real output sample`);
        }
        if (entry.sample && !entry.read)
        {
            found.push(`${entry.path}: a sample without how to read it`);
        }
    }
    if (readme !== render(catalog))
    {
        found.push('tools/README.md: not what the catalog makes (node tools/checks/check-catalog.mjs --write)');
    }
    return found;
}

/** A path as a link from tools/README.md. @param {string} path */
const link = path=>`[\`${path.replace(/^tools\//, '')}\`](${path.replace(/^tools\//, '')})`;

/**
 * tools/README.md as the catalog makes it.
 *
 * @param {{ tools: Entry[] }} catalog
 */
export function render(catalog){
    const lines = ['# Tools', '',
        '<!-- Written by tools/checks/check-catalog.mjs --write from tools/catalog.json: edit those. -->', '',
        'Every tool by the question it answers. The folder a tool is in is its category; the'
            + ' catalog,',
        '[`catalog.json`](catalog.json), says what each answers, how it is run, its tests and,'
            + ' for an',
        'instrument, a real output from this repository\'s own data and how to read it.',
        'check:boundaries fails a tool the catalog does not know. When a run is slow, flickers or',
        'stops, [`live/DIAGNOSING.md`](live/DIAGNOSING.md) is the order to look in; the flags of the',
        'runners are in [`run/README.md`](run/README.md), the live switches in',
        '[`live/README.md`](live/README.md).', '',
        '| folder | what is in it |', '|---|---|',
        ...Object.entries(CATEGORIES).map(([name, what])=>`| \`${name}/\` | ${what} |`), '',
        '## Questions', ''];
    const instruments = catalog.tools.filter(entry=>entry.kind === 'instrument');
    for (const category of Object.keys(CATEGORIES))
    {
        for (const entry of instruments.filter(one=>one.category === category))
        {
            lines.push(`### ${entry.question}`, '',
                `${link(entry.path)}: \`${entry.command}\``, '');
            if (entry.sample)
            {
                lines.push('```', entry.sample, '```', '',
                    `From \`${entry.source}\`. ${entry.read}`, '');
            }
            else
            {
                lines.push('Needs the shared browser, a GPU or a phone: no sample yet from this',
                    `machine's data. Run \`${entry.command}\` and put what it prints here.`, '');
            }
        }
    }
    lines.push('## Everything else', '');
    for (const category of Object.keys(CATEGORIES))
    {
        const rest = catalog.tools.filter(entry=>entry.category === category
            && entry.kind !== 'instrument');
        if (rest.length === 0)
        {
            continue;
        }
        lines.push(`### \`${category}/\``, '');
        for (const entry of rest)
        {
            lines.push(`- ${link(entry.path)} - ${entry.question}${entry.command
                ? ` (\`${entry.command}\`)` : ''}`);
        }
        lines.push('');
    }
    return `${lines.join('\n').trimEnd()}\n`;
}

if (isMain(import.meta.url))
{
    const catalog = JSON.parse(readFileSync(join(REPO_ROOT, 'tools', 'catalog.json'), 'utf8'));
    const page = join(REPO_ROOT, 'tools', 'README.md');
    if (process.argv.includes('--write'))
    {
        writeFileSync(page, render(catalog));
    }
    const files = execFileSync('git',
        ['ls-files', '--cached', '--others', '--exclude-standard', 'tools'],
        { cwd: REPO_ROOT, encoding: 'utf8' })
        .split('\n').filter(Boolean);
    const found = problems(catalog, files, path=>existsSync(join(REPO_ROOT, path)),
        existsSync(page) ? readFileSync(page, 'utf8').replace(/\r\n/g, '\n') : '');
    for (const line of found)
    {
        console.error(line);
    }
    if (found.length > 0)
    {
        process.exit(1);
    }
    const kinds = catalog.tools.reduce((/** @type {Record<string, number>} */ by, /** @type {Entry} */ one)=>
        ({ ...by, [one.kind]: (by[one.kind] ?? 0) + 1 }), {});
    console.log(`catalog: ${files.length} files under tools/, ${catalog.tools.length} entries`
        + ` (${Object.entries(kinds).map(([kind, count])=>`${count} ${kind}`).join(', ')}),`
        + ` every instrument that runs here with a real sample`);
}
