/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails on a store kept beside the run's cache at a site: plain memory where
 * the cache has no room or there is none (`plainScratches`, `plainHold`), a
 * site's own branch for a run without a cache (`cache === null`, `space ===
 * null`, `noCache`), or a store that keeps nothing in the cache's place
 * (`KEEP_NOTHING`). The run always has a cache, and what it has no room for
 * is the cache's to answer (refused, a loss, made again): a site that keeps
 * its own copy is a heap outside the run's one budget.
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
const SAID = /\b(?:plainScratches|plainHold|KEEP_NOTHING|noCache)\b|\b(?:cache|space) === null\b/g;

/**
 * The sites left, each with why it stays and what removes it.
 *
 * @type {Record<string, number>}
 */
const BASELINE = {
    // A played Direct3D 8 or 9 root that lends guest memory: the thread it
    // would wait on for room may be the one waiting on it (asked ahead, it goes).
    'modules/core/src/layers/graphics/remote/worker.js': 2,
    // OpenGL's context's default holds, until its kernel is handed the cache's.
    'modules/core/src/layers/graphics/opengl/context.js': 2,
    // A DirectDraw blit handed no rooms, until the ddraw seam always hands them.
    'modules/core/src/layers/graphics/ddraw/blit.js': 2,
    // The presenter and the uniform ring handed no scratches, until every
    // backend a test makes is handed the cache's.
    'modules/core/src/layers/graphics/webgpu/internal/bindings.js': 2,
    'modules/core/src/layers/graphics/webgpu/internal/presenter.js': 2,
    // A volume, and a session's files, with nowhere to keep what they read
    // again: a space that keeps nothing, until every one is handed a space.
    'modules/core/src/layers/win32/kernel32/vfs.js': 2,
    'modules/core/src/layers/filesystem/internal/session-source.js': 2,
    // Not a fallback: the relay's cache arrives after the first messages, which wait.
    'modules/core/src/layers/cpu/internal/store-relay.js': 1,
    // Not a fallback: a desktop's folder space, and the far-heap's space.
    'modules/core/src/layers/win32/shell32/desktop.js': 1,
    'modules/core/src/layers/win32/kernel32/heap.js': 1,
    // Not a fallback: what a child process is handed of its parent's cache.
    'modules/core/src/process/beside.js': 1,
    'modules/core/src/host/process.worker.js': 3,
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
