/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One digest of the wasm the 32-bit translator emits for a fixed body of x86:
 * the cork-bench images' code (regions found from each image's entry along
 * its blocks' exits and calls) and seeded sequences of the corpus's forms,
 * each emitted under the option sets a run uses. A change meant to leave the
 * 32-bit translation as it is -- the translator made width-parametric, a
 * refactor -- leaves the digest unchanged; one that changes it says which
 * module changed first.
 *
 *     node tools/emit-digest.mjs [--check | --write] [--regions N] [--sequences N]
 *         [--list FILE]
 *
 *   --check        fail unless the digest is the one `emit-digest.json` keeps (the gate)
 *   --write        keep this digest in `emit-digest.json`: only in a change meant to
 *                  alter the 32-bit translation, which also raises CACHE_VERSION
 *   --regions N    regions formed from each image (default 80)
 *   --sequences N  seeded sequences (default 400)
 *   --list FILE    each module's name and its own digest, one a line, to compare two
 *                  runs and find the first that differs
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { regionModule } from '../modules/cork/src/region-module.js';
import { formRegion } from '../modules/cork/src/region.js';
import {
    CODE, POOL, bodyOf, preambleOf, programBytes, random,
} from '../modules/cork/src/testing/sequences.js';

const args = process.argv.slice(2);
/** @param {string} name */
const value = name=>{
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
};
const REGIONS = Number(value('--regions') ?? 80);
const SEQUENCES = Number(value('--sequences') ?? 400);
const listPath = value('--list');
const KEPT = new URL('./emit-digest.json', import.meta.url);
if ((args.includes('--check') || args.includes('--write'))
    && (value('--regions') !== undefined || value('--sequences') !== undefined))
{
    throw new Error('emit-digest: the kept digest is over the default regions and sequences');
}

/** Where cork-bench places an image (`tools/cork-bench/bench.mjs`). */
const IMAGE_BASE = 0x401000;
const IMAGES = new URL('./cork-bench/images/', import.meta.url);

/** The option sets a module is emitted under: the configurations runs use. */
const OPTIONS = [
    {},
    { hash: true, callReturn: true, looseStacks: true },
    { hash: true, callReturn: true, looseStacks: true, atomic: true, processors: 3 },
    { precise: true },
    { wide: true },
    { checked: false },
];

const digest = createHash('sha256');
/** @type {string[]} */
const lines = [];
let modules = 0;
let bytes = 0;

/** @param {string} name @param {Uint8Array} wasm */
const take = (name, wasm)=>{
    digest.update(wasm);
    modules++;
    bytes += wasm.length;
    if (listPath)
    {
        lines.push(`${name} ${createHash('sha256').update(wasm).digest('hex').slice(0, 16)}`);
    }
};

for (const file of readdirSync(IMAGES).filter(name=>name.endsWith('.bin')).sort())
{
    const image = readFileSync(new URL(file, IMAGES));
    const read = (/** @type {number} */ address)=>{
        const offset = address - IMAGE_BASE;
        return offset >= 0 && offset < image.length ? image[offset] : 0xf4;
    };
    // The regions an image's run would form, found as its code reaches them:
    // breadth first from the entry over every block's exits and calls.
    const queue = [IMAGE_BASE];
    const seen = new Set(queue);
    const entries = [];
    while (queue.length > 0 && entries.length < REGIONS)
    {
        const entry = /** @type {number} */ (queue.shift());
        entries.push(entry);
        const region = formRegion(read, entry, {});
        for (const block of region.blocks)
        {
            for (const target of [...block.exit.targets, ...block.exit.predicted ?? []])
            {
                if (target >= IMAGE_BASE && target < IMAGE_BASE + image.length && !seen.has(target))
                {
                    seen.add(target);
                    queue.push(target);
                }
            }
        }
    }
    for (const entry of entries)
    {
        OPTIONS.forEach((options, which)=>{
            const { wasm } = regionModule({ code: image, at: IMAGE_BASE, entry, ...options });
            take(`${file}@${entry.toString(16)}#${which}`, wasm);
        });
    }
}

const next = random(0x5eed);
for (let i = 0; i < SEQUENCES; i++)
{
    const code = programBytes([...preambleOf(next), ...bodyOf(next, { pool: POOL })]);
    OPTIONS.forEach((options, which)=>{
        const { wasm } = regionModule({ code, at: CODE, ...options });
        take(`sequence${i}#${which}`, wasm);
    });
}

if (listPath)
{
    writeFileSync(listPath, `${lines.join('\n')}\n`);
}
const found = { digest: digest.digest('hex'), modules, bytes };
console.log(`emit digest ${found.digest} over ${modules} modules, ${bytes} bytes`);
if (args.includes('--write'))
{
    writeFileSync(KEPT, `${JSON.stringify(found, null, 4)}\n`);
}
else if (args.includes('--check'))
{
    const kept = JSON.parse(readFileSync(KEPT, 'utf8'));
    if (kept.digest !== found.digest)
    {
        console.error(`emit-digest: the 32-bit translation changed (kept ${kept.digest}`
            + ` over ${kept.modules} modules, ${kept.bytes} bytes); --list on both trees`
            + ' names the first module that differs');
        process.exitCode = 1;
    }
}
