/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, rm, mkdtemp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reproducibility gate for the vendored v86 build.
 *
 * Rebuilds v86 from the current submodule checkout inside a clean container and
 * compares the resulting artifacts byte-for-byte against dist/vendor/manifest.json.
 * Anything but an exact match fails the build.
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const VENDOR = join(ROOT, 'vendor', 'v86');
const OUT = join(ROOT, 'dist', 'vendor');
const IMAGE = 'bottlify-v86-builder:0.1';
const MANIFEST_FILE = join(OUT, 'manifest.json');

/** @returns {Record<string, string>} map file name → expected sha256 hex */
function readManifest(){
    const raw = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
    /** @type {Record<string, string>} */
    const expected = {};
    for (const [rel, hash] of Object.entries(raw.artifacts)){
        const name = rel.replace(/^\.\//, '');
        const prefix = 'sha256:';
        if (!hash.startsWith(prefix)){
            throw new Error(`manifest artifact "${rel}" must look like "sha256:<hex>"`);
        }
        expected[name] = hash.slice(prefix.length);
    }
    return expected;
}

async function check(){
    const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
        stdio: 'ignore',
    });
    if (docker.status !== 0){
        console.error('verify:reproducibility requires a running docker daemon');
        process.exit(2);
    }

    let manifest;
    try {
        manifest = readManifest();
    } catch (error){
        console.error(`no valid dist/vendor/manifest.json yet: ${error.message}`);
        process.exit(1);
    }

    const tempOut = await mkdtemp(join(tmpdir(), 'bottlify-repro-'));
    try {
        const run = spawnSync(
            'docker',
            ['run', '--rm', '-v', `${VENDOR}:/src`, '-v', `${tempOut}:/out`, IMAGE, '/src', '/out'],
            { stdio: 'pipe', encoding: 'utf8' },
        );
        if (run.status !== 0){
            console.error(`containerized build failed:\n${run.stderr}`);
            process.exit(1);
        }

        const names = Object.keys(manifest);
        for (const name of names){
            const rebuilt = join(tempOut, name);
            const bytes = await readFile(rebuilt);
            const actual = createHash('sha256').update(bytes).digest('hex');
            if (actual !== manifest[name]){
                console.error(`Reproduction mismatch: ${name}: expected ${manifest[name]}, got ${actual}`);
                process.exit(1);
            }
        }
        console.log(`Reproducibility OK: ${names.length} artifacts byte-for-byte identical.`);
    } finally {
        await rm(tempOut, { recursive: true, force: true });
    }
}

await check();
