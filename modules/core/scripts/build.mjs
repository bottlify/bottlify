/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');

/**
 * Walks a directory and returns every file path.
 * @param {string} dir
 * @param {string[]} [acc]
 * @returns {Promise<string[]>}
 */
async function walk(dir, acc = []){
    for (const entry of await readdir(dir, { withFileTypes: true })){
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path, acc);
        else acc.push(path);
    }
    return acc;
}

/**
 * @param {string} path
 * @returns {Promise<string>} "sha256:<hex>"
 */
async function sha256File(path){
    const data = await readFile(path);
    return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

/** Rewrites dist/checksums.json for every file currently under dist/. */
async function writeChecksums(){
    const files = (await walk(DIST)).sort();
    /** @type {Record<string, string>} */
    const entries = {};
    for (const file of files){
        const rel = relative(DIST, file).replaceAll('\\', '/');
        entries[`./${rel}`] = await sha256File(file);
    }
    await writeFile(
        join(DIST, 'checksums.json'),
        JSON.stringify({ generated: new Date().toISOString(), files: entries }, null, 2),
    );
}

await mkdir(DIST, { recursive: true });
await build({
    entryPoints: [join(SRC, 'core.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    sourcemap: true,
    outfile: join(DIST, 'core.js'),
    logLevel: 'info',
});
await writeChecksums();
console.log(`dist: ${join(DIST, 'core.js')} + checksums.json`);
