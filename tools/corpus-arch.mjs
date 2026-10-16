#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The translator's x86 corpus under two Node binaries -- this machine's own
 * and another architecture's -- and what differs between them.
 *
 * WebAssembly fixes every float operation but one detail: the bits of a NaN
 * an operation makes. x86 makes a negative one, Arm a positive one, and the
 * translator puts the x86 one back where the host's differs. A game that is
 * right on an x86 host and wrong on an Arm one is a gap in that, or in
 * anything else the host decides; the corpus, whose answers were taken on
 * real x86 hardware, finds it in one run each side. On Windows on Arm an x64
 * Node runs under the x86 emulator, so both arms run on one machine.
 *
 * Usage: node tools/corpus-arch.mjs <other node.exe> [test file globs...]
 *   With no globs, cork's corpus, sequence and x87 integration tests.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [other, ...globs] = process.argv.slice(2);
if (!other)
{
    console.error('usage: node tools/corpus-arch.mjs <other node.exe> [test file globs...]');
    process.exit(2);
}
const files = globs.length > 0 ? globs : ['src/emit/corpus-*.itest.js',
    'src/emit/sequences-*.itest.js', 'src/emit/x87-joins.itest.js',
    'src/emit/mmx-sequences.itest.js'];

/**
 * The tests a binary passes and fails, by name.
 *
 * @param {string} binary
 */
const run = binary=>{
    const arch = spawnSync(binary, ['-p', 'process.arch'], { encoding: 'utf8' }).stdout.trim();
    const began = Date.now();
    const result = spawnSync(binary, ['--test', '--test-timeout=600000', '--test-reporter=tap',
        ...files], { cwd: join(root, 'modules', 'cork'), encoding: 'utf8',
        maxBuffer: 1 << 28 });
    /** @type {Map<string, boolean>} */
    const outcomes = new Map();
    for (const line of result.stdout.split('\n'))
    {
        const found = line.match(/^\s*(not ok|ok) \d+ - (.*?)(?: # .*)?$/);
        if (found)
        {
            outcomes.set(found[2], found[1] === 'ok');
        }
    }
    const failed = [...outcomes].filter(([, passed])=>!passed).map(([name])=>name);
    console.log(`${arch}: ${outcomes.size - failed.length} passed, ${failed.length} failed,`
        + ` ${((Date.now() - began) / 1000).toFixed(0)} s (${binary})`);
    return { arch, outcomes, failed, output: result.stdout };
};

const here = run(process.execPath);
const there = run(resolve(other));
const differ = [...new Set([...here.outcomes.keys(), ...there.outcomes.keys()])]
    .filter(name=>here.outcomes.get(name) !== there.outcomes.get(name));
if (differ.length === 0)
{
    console.log(`the same on ${here.arch} and ${there.arch}`
        + (here.failed.length > 0 ? `, ${here.failed.length} failing on both` : ''));
    process.exit(here.failed.length > 0 ? 1 : 0);
}
console.log(`${differ.length} differ between ${here.arch} and ${there.arch}:`);
for (const name of differ)
{
    console.log(`  ${here.arch} ${here.outcomes.get(name) ? 'ok' : 'FAILS'},`
        + ` ${there.arch} ${there.outcomes.get(name) ? 'ok' : 'FAILS'}: ${name}`);
}
// What the failing side said about each, for the first few.
for (const side of [here, there])
{
    for (const name of differ.filter(one=>side.outcomes.get(one) === false).slice(0, 5))
    {
        const at = side.output.indexOf(`- ${name}`);
        console.log(`--- ${side.arch}: ${name}\n${side.output.slice(at, at + 1500)}`);
    }
}
process.exit(1);
