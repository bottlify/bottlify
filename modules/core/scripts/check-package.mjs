/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Publish gate: asserts the tarball npm would upload actually contains every
 * file the package promises through `exports`.
 *
 * The failure this exists to prevent is a package that installs cleanly and
 * then cannot start a machine, because the emulator binaries live in a
 * gitignored directory and a build run without them would otherwise be silent.
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// A truncated or placeholder binary is the other way this ships broken, so the
// emulator artifacts are held to a floor no stub would reach.
const BINARY_MIN_BYTES = 256 * 1024;

/** @returns {{ path: string, size: number }[]} what `npm pack` would include */
function packedFiles(){
    const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: ROOT, encoding: 'utf8', shell: true,
    });
    if (packed.status !== 0)
    {
        throw new Error(`npm pack --dry-run failed:\n${packed.stderr}`);
    }
    // npm prints its own progress on stderr; the JSON array is the whole of stdout.
    const [tarball] = JSON.parse(packed.stdout);
    return tarball.files;
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const files = packedFiles();
const sizes = new Map(files.map(file=>[file.path.replaceAll('\\', '/'), file.size]));

/** @type {string[]} */
const problems = [];
const required = [
    ...Object.values(manifest.exports).map(/** @param {string} t */ t=>t.replace(/^\.\//, '')),
    'dist/vendor/manifest.json',
    'LICENSE',
    'THIRD-PARTY-NOTICES.md',
];

for (const path of required)
{
    const size = sizes.get(path);
    const floor = path.startsWith('dist/vendor/') && path !== 'dist/vendor/manifest.json'
        ? BINARY_MIN_BYTES
        : 1;
    if (size === undefined)
    {
        problems.push(`${path}: not in the tarball`);
    }
    else if (size < floor)
    {
        problems.push(`${path}: ${size} bytes, too small to be the real artifact`);
    }
}

if (problems.length > 0)
{
    console.error(`@bottlify/core is not publishable:\n  ${problems.join('\n  ')}\n`
        + '  Run `npm run fetch:v86 && npm run fetch:video-decoder`, then `npm run build`.');
    process.exit(1);
}

const total = files.reduce((sum, file)=>sum + file.size, 0);
console.log(`package OK: ${files.length} files, ${(total / 1e6).toFixed(1)} MB unpacked, `
    + `${required.length} required artifacts present`);
