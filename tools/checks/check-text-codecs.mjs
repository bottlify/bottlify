/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails when core makes a TextDecoder or TextEncoder of its own outside
 * src/system/text.js, which holds the run's codecs (`utf8`, `utf16le`,
 * `utf16be`, `windows1252`, and `decoderFor(label)` for any other page, each
 * made once). One made inside a function is an object thrown away per call;
 * one made at a module's top is a second copy of a shared one. Tests and
 * their fixtures may make their own.
 *
 * The files below still make theirs, each for the reason given; a count may
 * only fall, and one that fell must be lowered here, so the list stays what
 * is left.
 *
 *     node tools/checks/check-text-codecs.mjs [src]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SRC = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'modules', 'core', 'src');
const MADE = /new Text(?:De|En)coder\(/g;

/** Left where another stream of work owned the file when the codecs moved. */
const LEFT = Object.freeze({
    'process/bundle-mount.js': 1,
    'process/image-resources.js': 1,
    'host/inbound.js': 1,
    'layers/cache/module.js': 2,
    'layers/graphics/remote/wire.js': 1,
    'layers/graphics/remote/capture.js': 2,
    'layers/win32/msvcrt/mbcs.js': 1,
    'layers/win32/msvcrt/msvcp60.js': 1,
    'layers/win32/msvcrt/msvcp60-streams.js': 1,
    'layers/graphics/opengl/exports.js': 3,
    'layers/graphics/opengl/spirv-module.js': 1,
    'layers/graphics/opengl/context-programs.js': 2,
    'layers/graphics/vulkan/structs.js': 2,
    'layers/graphics/vulkan/spirv.js': 1,
    'layers/graphics/vulkan/fixture.js': 1,
    'layers/graphics/d3d8/render.js': 1,
    'layers/graphics/glu/exports.js': 1,
});
const HOME = 'system/text.js';

/** @param {string} directory @returns {string[]} */
const sources = directory=>readdirSync(directory).flatMap(name=>{
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sources(path)
        : name.endsWith('.js') && !name.endsWith('.test.js') && !name.endsWith('.itest.js')
            ? [path] : [];
});

/** @type {string[]} */
const problems = [];
/** @type {Map<string, number>} */
const found = new Map();
for (const path of sources(SRC))
{
    const key = relative(SRC, path).split(sep).join('/');
    const count = readFileSync(path, 'utf8').match(MADE)?.length ?? 0;
    if (count > 0 && key !== HOME)
    {
        found.set(key, count);
    }
}
for (const [key, count] of found)
{
    const allowed = LEFT[/** @type {keyof typeof LEFT} */ (key)] ?? 0;
    if (count > allowed)
    {
        problems.push(`${key}: ${count} made here (${allowed} allowed) - take one from ${HOME}`);
    }
    else if (count < allowed)
    {
        problems.push(`${key}: ${count} made here, the list allows ${allowed} - lower it`);
    }
}
for (const [key, allowed] of Object.entries(LEFT))
{
    if (!found.has(key))
    {
        problems.push(`${key}: none made here any more, the list allows ${allowed} - remove it`);
    }
}
if (problems.length > 0)
{
    console.error('check-text-codecs: a codec made outside src/system/text.js, or a stale list:');
    problems.forEach(line=>console.error(`  ${line}`));
    process.exit(1);
}
console.log(`check-text-codecs: ${found.size} files still make a codec, as listed; none more`);
