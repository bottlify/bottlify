/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fails on an optional call into the api of a layer a module requires:
 * `win32.windows?.()`, `log?.warn(...)`, `(cpu).growTo?.(end)`,
 * `kernel.handles.access?.(handle)`, `typeof log.metrics?.table ===
 * 'function'`. A required layer is always there, its api always has the
 * method (a test that builds the layer over a fake gives the fake the
 * method), so the `?.` only stands in for a method that is missing: a quiet
 * empty answer where an error belongs. A `typeof` probe of one of its
 * methods is the same bypass. The names checked are
 * those a `module.js` binds to `host.requireApi(name)`, and those it hands
 * down to the files listed in `HANDED` under the name they take there.
 *
 *     node tools/checks/check-required-calls.mjs
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const LAYERS = 'modules/core/src/layers';

/** A name a module.js binds to a required layer's api. */
const BIND = /(?:const|let) ([A-Za-z_$][\w$]*) = (?:\/\*\*[^*]*\*\/\s*\(\s*)*[A-Za-z]*[hH]ost\??\.requireApi\(\s*'([a-z0-9]+)'/g;

/**
 * A required layer's api handed down from its module.js, by file, under the
 * names it takes there.
 *
 * @type {Record<string, string[]>}
 */
const HANDED = {
    // The scheduler is built by the kernel over the cpu layer's api.
    'modules/core/src/layers/kernel/internal/threads.js': ['cpu'],
    // A pipe end signals through the kernel win32 is handed, and finds its
    // handles in the kernel's table.
    'modules/core/src/layers/win32/kernel32/pipes.js': ['kernel', 'owner.kernel', 'host.handles'],
    // kernel32's objects, waits and processes, over the kernel win32 is handed.
    'modules/core/src/layers/win32/kernel32/apc.js': ['kernel'],
    'modules/core/src/layers/win32/kernel32/changes.js': ['kernel'],
    'modules/core/src/layers/win32/kernel32/debug-events.js': ['kernel'],
    'modules/core/src/layers/win32/kernel32/iocp.js': ['kernel'],
    'modules/core/src/layers/win32/kernel32/mailslots.js': ['kernel'],
    'modules/core/src/layers/win32/kernel32/pool.js': ['kernel'],
    'modules/core/src/layers/win32/kernel32/process-policy.js': ['kernel'],
    'modules/core/src/layers/win32/kernel32/process-target.js': ['kernel'],
    'modules/core/src/layers/win32/kernel32/slimsync.js': ['kernel'],
    'modules/core/src/layers/win32/kernel32/spawn.js': ['kernel'],
    'modules/core/src/layers/win32/kernel32/sync-natives.js': ['kernel'],
    'modules/core/src/layers/win32/kernel32/sync.js': ['kernel'],
    'modules/core/src/layers/win32/kernel32/thread-info.js': ['kernel'],
    'modules/core/src/layers/win32/kernel32/threading.js': ['kernel'],
    // The shared user data's clocks, in the memory layer's words.
    'modules/core/src/layers/win32/kernel32/shared-data.js': ['memory'],
    // The bridge's dispatcher and callbacks, over the cpu and memory it is built with.
    'modules/core/src/layers/bridge/internal/dispatch.js': ['this.cpu', 'this.memory'],
    'modules/core/src/layers/bridge/internal/callback.js': ['cpu'],
    // A replay drives the real bridge.
    'modules/core/src/layers/bridge/replay.js': ['bridge'],
    // The kernel's switcher and stack pool, over the cpu and memory it requires.
    'modules/core/src/layers/kernel/internal/switch.js': ['cpu'],
    'modules/core/src/layers/kernel/internal/stacks.js': ['memory'],
    // The graphics libraries, over the layer's own api.
    'modules/core/src/layers/graphics/seam/exports.js': ['graphics'],
};

/**
 * Sites that stay, each with why: none.
 *
 * @type {Record<string, number>}
 */
const BASELINE = {};

/** @param {string} name */
const escaped = name=>name.replace(/[$.]/g, '\\$&');

/**
 * Every optional call into the apis named, as `line: text`.
 *
 * @param {string} text @param {string[]} names
 */
const optionalCalls = (text, names)=>names.flatMap(name=>{
    const api = escaped(name);
    // `api?.x`, `api.x?.(`, `(api).x?.(`, `api.x.y?.(`, `typeof api.x === 'function'`.
    const shape = new RegExp(`(?<![\\w$.])${api}\\)?(?:\\.[A-Za-z_$][\\w$]*)*\\?\\.`
        + `|typeof ${api}\\.[A-Za-z_$][\\w$.]* ===? 'function'`, 'g');
    return [...text.matchAll(shape)].map(match=>{
        const line = text.slice(0, match.index).split('\n').length;
        return `${line}: ${text.split('\n')[line - 1].trim()}`;
    });
});

/** @type {Record<string, string[]>} */
const found = {};
for (const layer of readdirSync(`${ROOT}${LAYERS}`))
{
    const path = `${LAYERS}/${layer}/module.js`;
    if (!existsSync(`${ROOT}${path}`))
    {
        continue;
    }
    const text = readFileSync(`${ROOT}${path}`, 'utf8');
    const names = [...new Set([...text.matchAll(BIND)].map(match=>match[1]))];
    const sites = optionalCalls(text, names);
    if (sites.length > 0)
    {
        found[path] = sites;
    }
}
for (const [path, names] of Object.entries(HANDED))
{
    const sites = optionalCalls(readFileSync(`${ROOT}${path}`, 'utf8'), names);
    if (sites.length > 0)
    {
        found[path] = sites;
    }
}

/** @type {string[]} */
const problems = [];
for (const path of new Set([...Object.keys(found), ...Object.keys(BASELINE)]))
{
    const now = found[path]?.length ?? 0;
    const was = BASELINE[path] ?? 0;
    if (now > was)
    {
        problems.push(`${path}: ${now} optional call${now === 1 ? '' : 's'} into a required`
            + ` layer's api, ${was} allowed - call it, and give a test's fake the method:\n`
            + (found[path] ?? []).map(site=>`    ${site}`).join('\n'));
    }
    else if (now < was)
    {
        problems.push(`${path}: ${now}, the baseline says ${was} - lower it`);
    }
}
if (problems.length > 0)
{
    console.error(problems.join('\n'));
    process.exit(1);
}
console.log(`required calls: every call into a required layer's api is a call, in`
    + ` ${readdirSync(`${ROOT}${LAYERS}`).length} layers and ${Object.keys(HANDED).length}`
    + ' files handed one');
