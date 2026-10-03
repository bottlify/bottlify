/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Builds the bundles `suite.mjs` runs: for each named checkout,
 * `bundles/<name>/` with `worker.js` (the engine and the measurement) and `cork/`
 * (the translator and its worker, which the engine loads from beside itself),
 * with the production build's options -- minified, the diagnostic instruments
 * folded out (`scripts/build.mjs`).
 *
 *     node modules/cork/bench/browser/build.mjs '{"base":"../base-checkout","new":"."}'
 *
 * Set MINIFY=0 for bundles a profiler can read, DIAGNOSTICS=1 to keep the
 * instruments (a run's `cork` timings then report where translation went).
 */

import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DIAGNOSTICS_OFF = process.env.DIAGNOSTICS === '1' ? {}
    : { 'import.meta.BOTTLIFY_DIAGNOSTICS': 'false' };
const COMMON = {
    bundle: true, format: /** @type {const} */ ('esm'), platform: /** @type {const} */ ('browser'),
    target: ['es2022'], minify: process.env.MINIFY !== '0', sourcemap: false,
    logLevel: /** @type {const} */ ('error'),
    external: ['node:zlib', 'node:fs/promises', 'node:url', 'node:worker_threads'],
};

/** @type {Record<string, string>} */
const checkouts = JSON.parse(process.argv[2] ?? '{"head":"."}');
for (const [name, path] of Object.entries(checkouts))
{
    const root = resolve(path);
    const out = join(HERE, 'bundles', name);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    await build({
        ...COMMON,
        entryPoints: [join(HERE, 'worker.js')],
        alias: { '@app': join(root, 'modules/core/src/app.js') },
        define: {
            ...DIAGNOSTICS_OFF,
            'import.meta.env.BOTTLIFY_VENDOR': '"./vendor/"',
            'import.meta.env.BOTTLIFY_CORK': '"./cork/index.js"',
        },
        outfile: join(out, 'worker.js'),
    });
    await build({
        ...COMMON,
        entryPoints: [
            join(root, 'modules/cork/src/index.js'),
            join(root, 'modules/cork/src/runtime/translator.worker.js'),
        ],
        define: DIAGNOSTICS_OFF,
        outdir: join(out, 'cork'),
        entryNames: '[name]',
    });
    console.log(`bundles/${name} from ${root}`);
}
