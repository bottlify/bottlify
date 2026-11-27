/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when cork's settings are described anywhere but as their one table has
 * them (`SETTINGS` in modules/cork/src/runtime/settings.js): a table of
 * docs/cork/settings.md that is not the one the table makes (a key missing or
 * extra, another default, another line, another section), or a key of the
 * core's `EngineConfig` typedef (modules/core/src/layers/cpu/engine.js) that
 * the table lacks or the table one it lacks, or a default the typedef gives
 * ("Default N") that is not the table's.
 *
 *   node tools/checks/check-cork-settings.mjs           check
 *   node tools/checks/check-cork-settings.mjs --write   write the docs' tables from the table
 *
 * The settings were written three times, the defaults with their comments, the
 * typedef and the docs, and they drifted: a key the code no longer read stayed
 * a row, a default moved in one place, a setting nobody passed lived on in all
 * three.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, isMain } from '../lib/common.mjs';
import { SETTINGS } from '../../modules/cork/src/runtime/settings.js';

const DOCS = join(REPO_ROOT, 'docs/cork/settings.md');
const TYPEDEF = join(REPO_ROOT, 'modules/core/src/layers/cpu/engine.js');

/** The docs' sections, by `kind`, each a table between `<!-- settings: kind -->` and
 * `<!-- /settings -->`, with the heading of its third column. */
const SECTIONS = { host: 'What it is', debug: 'What it does', test: 'What it moves' };

/** @typedef {import('../../modules/cork/src/runtime/settings.js').Setting} Setting */

/**
 * A default as the docs give it: the entry's `shown`, else its value -- a boolean in
 * code, a size in MiB, a large power of two as one, nothing as `none`.
 * @param {Setting} setting
 */
export function shownDefault(setting){
    const { value, shown } = setting;
    if (shown !== undefined)
    {
        return shown;
    }
    if (typeof value === 'boolean')
    {
        return `\`${value}\``;
    }
    if (typeof value === 'number')
    {
        const MiB = 2 ** 20;
        return value >= MiB && value % MiB === 0 ? `${value / MiB} MiB`
            : value >= 2 ** 16 && Number.isInteger(Math.log2(value)) ? `2^${Math.log2(value)}`
                : String(value);
    }
    if (value === undefined || value === null)
    {
        return 'none';
    }
    throw new Error(`a default the docs cannot show without \`shown\`: ${JSON.stringify(value)}`);
}

/**
 * The leading value of a default as text gives it: a number (`10_000`, `2^20`,
 * `256 MiB`) or a boolean; undefined for anything else (`none`, a sentence).
 * @param {string} text
 */
export function valueOf(text){
    const plain = text.replace(/`/g, '').replace(/_/g, '').trim();
    const power = /^2\^(\d+)\b/.exec(plain);
    const mebi = /^(\d+) MiB\b/.exec(plain);
    const word = /^(true|false)\b/.exec(plain);
    const number = /^(\d+(?:\.\d+)?)(?![\w^])/.exec(plain);
    return word ? word[1] === 'true' : power ? 2 ** Number(power[1])
        : mebi ? Number(mebi[1]) * 2 ** 20 : number ? Number(number[1]) : undefined;
}

/**
 * The table of one section as the settings make it.
 * @param {Record<string, Setting>} settings @param {keyof typeof SECTIONS} kind
 */
export function sectionTable(settings, kind){
    const rows = Object.entries(settings).filter(([, setting])=>setting.kind === kind)
        .map(([name, setting])=>`| \`${name}\` | ${shownDefault(setting)} | ${setting.doc} |`);
    return ['| Setting | Default | ' + SECTIONS[kind] + ' |', '| --- | --- | --- |', ...rows]
        .join('\n');
}

/**
 * The docs page with its tables as the settings make them, and what differs in the page
 * as it is.
 * @param {string} page @param {Record<string, Setting>} settings
 * @returns {{ written: string, problems: string[] }}
 */
export function checkDocs(page, settings){
    /** @type {string[]} */
    const problems = [];
    let written = page;
    for (const kind of /** @type {(keyof typeof SECTIONS)[]} */ (Object.keys(SECTIONS)))
    {
        const open = `<!-- settings: ${kind} -->`;
        const close = '<!-- /settings -->';
        const from = written.indexOf(open);
        const to = from < 0 ? -1 : written.indexOf(close, from);
        if (to < 0)
        {
            problems.push(`docs: no ${open} ... ${close}`);
            continue;
        }
        const table = sectionTable(settings, kind);
        const now = written.slice(from + open.length, to).trim();
        const rowsOf = (/** @type {string} */ text)=>new Map(text.split('\n')
            .filter(line=>line.startsWith('| `'))
            .map(line=>[/^\| `(\w+)`/.exec(line)?.[1] ?? line, line]));
        const before = problems.length;
        const want = rowsOf(table);
        const have = rowsOf(now);
        for (const [name, line] of want)
        {
            problems.push(...!have.has(name) ? [`docs (${kind}): no row for \`${name}\``]
                : have.get(name) !== line ? [`docs (${kind}): \`${name}\` reads\n    `
                    + `${have.get(name)}\n  the table makes it\n    ${line}`] : []);
        }
        problems.push(...[...have.keys()].filter(name=>!want.has(name))
            .map(name=>`docs (${kind}): \`${name}\` is not a ${kind} setting of the table`));
        if (now !== table && problems.length === before)
        {
            problems.push(`docs (${kind}): the table's header or order is not the one made`);
        }
        written = written.slice(0, from + open.length) + `\n${table}\n` + written.slice(to);
    }
    // A settings row outside the made tables is one nothing keeps.
    const outside = written.replace(/<!-- settings: \w+ -->[\s\S]*?<!-- \/settings -->/g, '');
    problems.push(...outside.split('\n').filter(line=>/^\| `\w+`/.test(line))
        .map(line=>`docs: a settings row outside the made tables: ${line}`));
    return { written, problems };
}

/**
 * The keys of the `EngineConfig` typedef, each with the text of its property.
 * @param {string} source
 * @returns {Map<string, string>}
 */
export function typedefKeys(source){
    const at = source.indexOf('@typedef {Object} EngineConfig');
    if (at < 0)
    {
        throw new Error('engine.js: no EngineConfig typedef');
    }
    const body = source.slice(at, source.indexOf('*/', at));
    const parts = body.split(/\n \* @property /).slice(1);
    return new Map(parts.map(part=>{
        // The type may hold braces of its own: the name follows the type's closing brace.
        let depth = 0;
        let end = 0;
        for (; end < part.length; end++)
        {
            depth += part[end] === '{' ? 1 : part[end] === '}' ? -1 : 0;
            if (depth === 0)
            {
                break;
            }
        }
        const name = /^\s*\[(\w+)\]/.exec(part.slice(end + 1))?.[1];
        if (name === undefined)
        {
            throw new Error(`engine.js: a property of EngineConfig with no [name]: ${part}`);
        }
        return [name, part.slice(end + 1).replace(/\n \*\s*/g, ' ')];
    }));
}

/**
 * What differs between the typedef and the settings: keys either lacks, and a default the
 * typedef gives that is not the table's.
 * @param {string} source @param {Record<string, Setting>} settings
 */
export function checkTypedef(source, settings){
    const keys = typedefKeys(source);
    /** @type {string[]} */
    const problems = [];
    for (const [name, setting] of Object.entries(settings))
    {
        const text = keys.get(name);
        if (text === undefined)
        {
            problems.push(`EngineConfig: no [${name}]`);
            continue;
        }
        const said = /\bDefault:? ([^.;,]+)/.exec(text)?.[1];
        const given = said === undefined ? undefined : valueOf(said);
        const table = typeof setting.value === 'number' || typeof setting.value === 'boolean'
            ? setting.value : valueOf(shownDefault(setting));
        if (given !== undefined && table !== undefined && given !== table)
        {
            problems.push(`EngineConfig: [${name}] says Default ${said}, the table ${table}`);
        }
    }
    problems.push(...[...keys.keys()].filter(name=>!Object.hasOwn(settings, name))
        .map(name=>`EngineConfig: [${name}] is no key of the settings table`));
    return problems;
}

if (isMain(import.meta.url))
{
    // A checkout that turns line ends into CRLF (git's autocrlf on Windows)
    // is the same page: its rows are compared without the CR.
    const page = readFileSync(DOCS, 'utf8').replace(/\r\n/g, '\n');
    const { written, problems } = checkDocs(page, SETTINGS);
    if (process.argv.includes('--write'))
    {
        writeFileSync(DOCS, written);
        problems.length = 0;
    }
    problems.push(...checkTypedef(readFileSync(TYPEDEF, 'utf8').replace(/\r\n/g, '\n'),
        SETTINGS));
    if (problems.length > 0)
    {
        console.error(`check-cork-settings: ${problems.length} problem(s)\n  `
            + problems.join('\n  '));
        process.exit(1);
    }
    console.log(`check-cork-settings: ${Object.keys(SETTINGS).length} settings, the docs and`
        + ' EngineConfig as the table has them');
}
