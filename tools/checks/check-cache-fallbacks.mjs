/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails on a store kept beside the run's cache at a site: plain memory where
 * the cache has no room or there is none (`plainScratches`, `plainHold`, gone
 * from the cache layer and not to come back), a
 * site's own branch for a run without a cache (`cache === null`, `space ===
 * null`, `noCache`), a default room that refuses every room because there
 * is no cache (`noScratches`), or a store that keeps nothing in the cache's place
 * (`KEEP_NOTHING`). The run always has a cache, and what it has no room for
 * is the cache's to answer (refused, a loss, made again): a site that keeps
 * its own copy is a heap outside the run's one budget. Nor does a layer stand
 * in for another (`isStub`, `createStubApi`, `createStubModule`): a module a
 * build lacks and something requires is an error when it is built.
 *
 * Only the cache layer itself (`modules/core/src/layers/cache/`) and tests
 * may say these. The sites that still do are listed below with the count of
 * each, a baseline that only shrinks: one more is a failure, one fewer is a
 * failure too until the baseline says it.
 *
 *     node tools/checks/check-cache-fallbacks.mjs
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relative } from 'node:path';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SOURCES = ['modules/core/src'];
const SKIP = [/\.(test|itest|fixture)\.js$/, /\.x(86|64)\.js$/, /^modules\/core\/src\/layers\/cache\//];
const SAID = /\b(?:plainScratches|plainHold|KEEP_NOTHING|noCache|noScratches|isStub|createStub(?:Api|Module))\b|\b(?:cache|space) === null\b/g;

/**
 * The sites left, each with why it stays and what removes it.
 *
 * @type {Record<string, number>}
 */
const BASELINE = {
    // Not a fallback: the relay's cache arrives after the first messages, which wait.
    'modules/core/src/layers/cpu/internal/store-relay.js': 1,
    // Not a cache: the strip an app bar keeps on the desktop, and the far
    // heap's address space, which a 32-bit process has none of.
    'modules/core/src/layers/win32/shell32/desktop.js': 1,
    'modules/core/src/layers/win32/kernel32/heap.js': 1,
    // A default room for a caller that hands none: every room refused. Each
    // goes when its site takes the process's scratches as required.
    'modules/core/src/layers/graphics/opengl/context.js': 2,
    'modules/core/src/layers/graphics/webgpu/internal/bindings.js': 2,
    'modules/core/src/layers/graphics/webgpu/internal/presenter.js': 2,
    'modules/core/src/layers/graphics/ddraw/blit.js': 2,
};

/** @param {string} dir @returns {string[]} */
const filesUnder = dir=>readdirSync(dir).flatMap(name=>{
    const path = `${dir}/${name}`;
    return statSync(path).isDirectory() ? filesUnder(path) : path.endsWith('.js') ? [path] : [];
});

/** @type {Record<string, number>} */
const found = {};
for (const source of SOURCES)
{
    for (const path of filesUnder(`${ROOT}${source}`))
    {
        const name = relative(ROOT, path).replace(/\\/g, '/');
        if (SKIP.some(skip=>skip.test(name)))
        {
            continue;
        }
        const count = [...readFileSync(path, 'utf8').matchAll(SAID)].length;
        if (count > 0)
        {
            found[name] = count;
        }
    }
}

/** @type {string[]} */
const problems = [];
for (const name of new Set([...Object.keys(found), ...Object.keys(BASELINE)]))
{
    const now = found[name] ?? 0;
    const was = BASELINE[name] ?? 0;
    if (now > was)
    {
        problems.push(`${name}: ${now} fallback${now === 1 ? '' : 's'} beside the run's cache,`
            + ` ${was} allowed - the cache layer answers no cache and no room, not the site`);
    }
    else if (now < was)
    {
        problems.push(`${name}: ${now}, the baseline says ${was} - lower it`);
    }
}
if (problems.length > 0)
{
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log(`cache fallbacks: ${Object.values(found).reduce((sum, count)=>sum + count, 0)} at`
    + ` ${Object.keys(found).length} sites, none new`);
