/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the tools share: whether a module is the script node was started with,
 * a command line's options, a median, and where a bundle lies. Plain node, no
 * package imports, so any tool may take it.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** This checkout's root. */
export const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Whether the module at `url` (its `import.meta.url`) is the script node was
 * started with. Compared as URLs: `file://${argv[1]}` is `file://C:\...` on
 * Windows, never the module's `file:///C:/...`, and a tool so guarded ran
 * nothing there and exited 0.
 *
 * @param {string} url
 */
export const isMain = url=>process.argv[1] !== undefined
    && url === pathToFileURL(resolve(process.argv[1])).href;

/**
 * The value after `name` on the command line, or `fallback`.
 *
 * @param {string[]} argv @param {string} name @param {string} [fallback]
 * @returns {string | undefined}
 */
export const option = (argv, name, fallback)=>{
    const at = argv.indexOf(name);
    return at >= 0 && at + 1 < argv.length ? argv[at + 1] : fallback;
};

/**
 * Every value a repeatable option was given.
 *
 * @param {string[]} argv @param {string} name
 */
export const options = (argv, name)=>argv.flatMap((arg, at)=>(arg === name && at + 1 < argv.length
    ? [argv[at + 1]] : []));

/**
 * The number after `name`, or `fallback`.
 *
 * @param {string[]} argv @param {string} name @param {number} fallback
 */
export const number = (argv, name, fallback)=>{
    const value = option(argv, name);
    return value === undefined ? fallback : Number(value);
};

/**
 * `--file HOST=GUEST`, repeatable: files of this disk put on the guest's volume
 * before the program starts.
 *
 * @param {string[]} argv
 * @returns {{ path: string, bytes: Uint8Array }[]}
 */
export const hostFiles = argv=>options(argv, '--file').map(pair=>{
    const at = pair.indexOf('=');
    if (at < 0)
    {
        throw new Error(`--file wants HOST=GUEST, got ${pair}`);
    }
    return { path: pair.slice(at + 1), bytes: new Uint8Array(readFileSync(pair.slice(0, at))) };
});

/** @param {number[]} values */
export function median(values){
    const sorted = [...values].sort((a, b)=>a - b);
    const middle = sorted.length >> 1;
    return sorted.length === 0 ? NaN
        : sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Where bundles lie: `BOTTLIFY_BUNDLES`, or this checkout's `bundles/` -- a
 * worktree with none of its own names the main checkout's.
 */
export const BUNDLES_DIR = process.env.BOTTLIFY_BUNDLES ?? join(REPO_ROOT, 'bundles');

/** A bundle's directory, by its id. @param {string} id */
export const bundleDir = id=>join(BUNDLES_DIR, id);
