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
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * Proves the published package is usable: pack it, install the tarball somewhere
 * that knows nothing about this repository, import it by its own name, and check
 * that the emulator binaries a machine cannot start without are really there.
 *
 * A unit test cannot see this failure. Everything resolves inside the working
 * tree whether or not `files`, `exports` and the build agree with each other;
 * the only place they disagree is in an installed copy.
 */

const PACKAGE = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Smallest a real emulator artifact can be; a stub or a truncated copy is not. */
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

const subpaths = ['worklet.js', 'libv86.mjs', 'v86.wasm', 'video-decoder.wasm'];
const artifacts = Object.fromEntries(
    subpaths.map(name=>[name, import.meta.resolve(\`@bottlify/core/\${name}\`)]));
console.log(JSON.stringify({ createApp: typeof createApp, artifacts }));
`;

test('the packed tarball installs and hands a consumer the emulator',
    { timeout: 180000 }, async t=>{
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
        for (const [name, url] of Object.entries(result.artifacts))
        {
            const path = fileURLToPath(url);
            const { size } = await stat(path);
            // The worklet is a page of code; the emulator's artifacts are not.
            const floor = name === 'worklet.js' ? 1000 : MIN_BYTES;
            assert.ok(size >= floor, `${name}: ${size} bytes is not a real artifact`);
            const hash = createHash('sha256').update(await readFile(path)).digest('hex');
            // The manifest is the emulator's account of itself; the worklet is ours
            // and is checked by the build's own checksums.
            const recorded = name === 'worklet.js'
                ? checksums.files[`./${name}`]
                : manifest.artifacts[`./${name}`];
            assert.equal(`sha256:${hash}`, recorded, `${name} did not survive packing intact`);
        }
    });
