/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when a structure's offsets are written down by hand in core: an
 * object literal of numbers closed by `SIZE`, the shape every hand-kept
 * table had. A structure is declared once with `system/layout.js` - its
 * fields in its header's order, its offsets at either width derived - and a
 * table kept beside a header drifted from it a field at a time: a 64-bit
 * table missed, a field read one slot off, a plausible number rather than an
 * error.
 *
 * The tables still kept by hand are the baseline (`struct-tables-baseline.json`),
 * by file and count. A file past its count fails; a file under it fails too,
 * until `--write` records the smaller count, so a migration is kept.
 *
 *     node tools/checks/check-struct-tables.mjs [--write] [--list]
 *
 * What it cannot see: a table without a SIZE, or one made by arithmetic on
 * a width (`2 * word + 8`). Those are found by reading, not by this check.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC = join(ROOT, 'modules', 'core', 'src');
const BASELINE = new URL('./struct-tables-baseline.json', import.meta.url);

/** `{ a: 0x00, b: 4, SIZE: 8 }`: two or more numeric fields, then SIZE, nothing else. */
const NUMBER = String.raw`(?:0x[0-9a-fA-F]+|\d+)`;
const TABLE = new RegExp(String.raw`\{\s*(?:\w+:\s*${NUMBER},\s*){2,}SIZE:\s*${NUMBER},?\s*\}`,
    'g');

/** @param {string} directory @returns {string[]} */
const sources = directory=>readdirSync(directory).flatMap(name=>{
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sources(path)
        : name.endsWith('.js') && !/\.(test|itest|fixture)\.js$/.test(name) ? [path] : [];
});

/**
 * How many hand-kept tables a source holds.
 *
 * @param {string} source
 * @returns {number}
 */
const countTables = source=>source.match(TABLE)?.length ?? 0;

const list = process.argv.includes('--list');
/** @type {Record<string, number>} */
const found = {};
for (const path of sources(SRC))
{
    const count = countTables(readFileSync(path, 'utf8'));
    if (count > 0)
    {
        found[relative(SRC, path).split(sep).join('/')] = count;
    }
}

if (process.argv.includes('--write'))
{
    writeFileSync(BASELINE, `${JSON.stringify(found, null, 2)}\n`);
    console.log(`check-struct-tables: ${Object.keys(found).length} files written to the baseline`);
    process.exit(0);
}

/** @type {Record<string, number>} */
const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
const problems = [];
for (const [file, count] of Object.entries(found))
{
    const allowed = baseline[file] ?? 0;
    if (count > allowed)
    {
        problems.push(`${file}: ${count} offset tables by hand (the baseline ${allowed});`
            + ' declare the structure with system/layout.js');
    }
}
for (const [file, allowed] of Object.entries(baseline))
{
    if ((found[file] ?? 0) < allowed)
    {
        problems.push(`${file}: ${found[file] ?? 0} offset tables by hand, fewer than the`
            + ` baseline ${allowed}; run with --write to keep the migration`);
    }
}
if (list)
{
    Object.entries(found).forEach(([file, count])=>console.log(`${count}\t${file}`));
}
if (problems.length > 0)
{
    console.error('check-struct-tables:');
    problems.forEach(problem=>console.error(`  ${problem}`));
    process.exit(1);
}
const total = Object.values(found).reduce((sum, count)=>sum + count, 0);
console.log(`check-struct-tables: ${total} offset tables kept by hand in`
    + ` ${Object.keys(found).length} files, none past the baseline`);
