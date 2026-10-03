/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

/**
 * Proves the published package is usable: pack it, install the tarball somewhere
 * that knows nothing about this repository, import it by its own name, and check
 * that the files its exports name are really there.
 *
 * A unit test cannot see this failure. Everything resolves inside the working
 * tree whether or not `files`, `exports` and the build agree with each other;
 * the only place they disagree is in an installed copy.
 */

const PACKAGE = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Smallest a real wasm artifact can be; a stub or a truncated copy is not. */
const MIN_BYTES = 256 * 1024;

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string} stdout
 */
function npm(cwd, args){
    const run = spawnSync('npm', args, { cwd, encoding: 'utf8', shell: true });
    assert.equal(run.status, 0, `npm ${args.join(' ')} failed:\n${run.stdout}\n${run.stderr}`);
    return run.stdout;
}

/**
 * @typedef {Object} ProbeResult
 * @property {string} createApp        typeof the package's entry export.
 * @property {Record<string, string>} artifacts  subpath -> resolved file URL.
 */

const PROBE = `
import { createApp } from '@bottlify/core';

const subpaths = ['worklet.js', 'video-decoder.wasm'];
const artifacts = Object.fromEntries(
    subpaths.map(name=>[name, import.meta.resolve(\`@bottlify/core/\${name}\`)]));
console.log(JSON.stringify({ createApp: typeof createApp, artifacts }));
`;

// `npm run build`, `npm pack` and `npm install` are three real subprocesses,
// and their wall time is npm's and the disk's, not the engine's: measured on
// this one machine, back to back, from under a minute to over three. The
// bound below is a backstop against a genuinely stuck process, not an SLA.
test('the packed tarball installs and hands a consumer its artifacts',
    { timeout: 600000 }, async t=>{
        npm(PACKAGE, ['run', 'build']);

        const consumer = await mkdtemp(join(tmpdir(), 'bottlify-pack-'));
        t.after(()=>rm(consumer, { recursive: true, force: true }));

        const packed = npm(PACKAGE, ['pack', '--pack-destination', JSON.stringify(consumer)]);
        const lines = packed.trim().split('\n');
        const tarball = join(consumer, lines[lines.length - 1].trim());

        await writeFile(join(consumer, 'package.json'),
            JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
        await writeFile(join(consumer, 'probe.mjs'), PROBE);
        npm(consumer, ['install', JSON.stringify(tarball), '--no-audit', '--no-fund',
            '--no-package-lock']);

        const probe = spawnSync(process.execPath, ['probe.mjs'], {
            cwd: consumer, encoding: 'utf8',
        });
        assert.equal(probe.status, 0, `importing the installed package failed:\n${probe.stderr}`);

        /** @type {ProbeResult} */
        const result = JSON.parse(probe.stdout);
        assert.equal(result.createApp, 'function', 'createApp must be the package entry export');

        const manifest = JSON.parse(await readFile(
            join(consumer, 'node_modules', '@bottlify', 'core', 'dist', 'vendor', 'manifest.json'),
            'utf8'));

        const checksums = JSON.parse(await readFile(
            join(consumer, 'node_modules', '@bottlify', 'core', 'dist', 'checksums.json'), 'utf8'));
        // The video decoder is an optional artifact: absent, its export still
        // resolves, and there is nothing to check; present, it is held to the
        // floor.
        const optional = new Set(['video-decoder.wasm']);
        for (const [name, url] of Object.entries(result.artifacts))
        {
            const path = fileURLToPath(url);
            if (optional.has(name))
            {
                try
                {
                    await stat(path);
                }
                catch {
                    continue;
                }
            }
            const { size } = await stat(path);
            // The worklet is a page of code; the decoder is not.
            const floor = name === 'worklet.js' ? 1000 : MIN_BYTES;
            assert.ok(size >= floor, `${name}: ${size} bytes is not a real artifact`);
            const hash = createHash('sha256').update(await readFile(path)).digest('hex');
            // The manifest is the prebuilt binaries' account of themselves; the
            // worklet is ours and is checked by the build's own checksums.
            const recorded = name === 'worklet.js'
                ? checksums.files[`./${name}`]
                : manifest.artifacts[`./${name}`];
            assert.equal(`sha256:${hash}`, recorded, `${name} did not survive packing intact`);
        }
    });

/** Words only the code a production bundle leaves out has, by where they come from. */
const LEFT_OUT = [
    'longestGuestInstructions',   // the phase profiler's frame table
    'stagedTextureUploads',       // the GPU backend's profiler
    'topBlocks', 'storeTrace',    // the translator's block profile and store trace
    'slice i',                    // a slow slice's account of itself
];

/**
 * A program run to its end under `cork`, through the entry `module` names: its
 * exit code, what it wrote, and how many regions the translator formed.
 */
const RUN = `
import { readFile } from 'node:fs/promises';
const [module, exe] = process.argv.slice(2);
const { createApp } = await import(module);
const app = await createApp({ executable: new Uint8Array(await readFile(exe)), engine: 'cork',
    cork: { config: { feed: 'slice' } } });
const output = [];
app.attachLog((_, text)=>output.push(text));
const code = await app.run({ timeoutMs: 60000 });
const cpu = (await app.diagnostics()).find(one=>one.name === 'cpu');
console.log(JSON.stringify({ code, output: output.join(''), regions: cpu.metrics.cork.regions }));
await app.dispose();
process.exit(0);
`;

test('a production bundle carries no diagnostic instrument and runs a program as the source does',
    { timeout: 600000 }, async t=>{
        npm(PACKAGE, ['run', 'build']);
        const dist = join(PACKAGE, 'dist');
        for (const name of ['core.js', 'engine.worker.js', 'log.worker.js', 'cork/index.js',
            'cork/translator.worker.js'])
        {
            const text = await readFile(join(dist, name), 'utf8');
            assert.ok(!text.includes('BOTTLIFY_DIAGNOSTICS'),
                `${name}: a guard the build did not fold`);
            for (const word of LEFT_OUT)
            {
                assert.ok(!text.includes(word), `${name} carries "${word}"`);
            }
        }

        // The same program through the built package and through the source:
        // what the bundle left out is a measurement, never behaviour, and the
        // frame's samplers that feed the translator are not among it.
        const scratch = await mkdtemp(join(tmpdir(), 'bottlify-prod-'));
        t.after(()=>rm(scratch, { recursive: true, force: true }));
        await writeFile(join(scratch, 'run.mjs'), RUN);
        const exe = join(PACKAGE, 'test', 'fixtures', 'qsort.exe');
        /** @param {string} module */
        const run = module=>{
            const child = spawnSync(process.execPath, [join(scratch, 'run.mjs'), module, exe],
                { encoding: 'utf8' });
            assert.equal(child.status, 0, `${module}:\n${child.stderr}`);
            return JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '{}');
        };
        const built = run(pathToFileURL(join(dist, 'core.js')).href);
        const source = run(pathToFileURL(join(PACKAGE, 'src', 'app.js')).href);
        assert.equal(built.code, source.code);
        assert.equal(built.output, source.output);
        assert.ok(built.regions >= 1, `the built translator formed no region: ${built.regions}`);
    });
