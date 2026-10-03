/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Publish gate: asserts the tarball npm would upload actually contains every
 * file the package promises through `exports`.
 *
 * The failure this exists to prevent is a package that installs cleanly and
 * then cannot start a machine, because a file it needs was left out of the
 * build. The binaries in the gitignored prebuilt directory are optional: a
 * build without the video decoder ships and passes here, and one that has it
 * holds it to a size floor, so a truncated artifact is still caught.
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// A truncated or placeholder binary is the other way this ships broken, so the
// binaries are held to a floor no stub would reach.
const BINARY_MIN_BYTES = 256 * 1024;

/** The vendor binaries a build may leave out: optional components, held to a
 * floor only when present. */
export const OPTIONAL_VENDOR = new Set([
    'dist/vendor/video-decoder.wasm',
    'dist/vendor/zstd.wasm',
]);

/**
 * The problems that make a tarball unpublishable, or an empty list.
 *
 * @param {{ path: string, size: number }[]} files  what `npm pack` would include
 * @param {{ exports: Record<string, string> }} manifest
 * @returns {string[]}
 */
export function packageProblems(files, manifest){
    const sizes = new Map(files.map(file=>[file.path.replaceAll('\\', '/'), file.size]));
    /** @type {string[]} */
    const problems = [];
    const required = [
        ...Object.values(manifest.exports)
            .map(/** @param {string} t */ t=>t.replace(/^\.\//, ''))
            .filter(path=>!OPTIONAL_VENDOR.has(path)),
        'dist/vendor/manifest.json',
        // The translator, loaded by URL rather than exported: without it the
        // package starts no machine at all.
        'dist/cork/index.js',
        'dist/cork/translator.worker.js',
        'LICENSE',
        'THIRD-PARTY-NOTICES.md',
    ];
    for (const path of required)
    {
        if (!sizes.has(path))
        {
            problems.push(`${path}: not in the tarball`);
        }
    }
    for (const path of OPTIONAL_VENDOR)
    {
        const size = sizes.get(path);
        if (size !== undefined && size < BINARY_MIN_BYTES)
        {
            problems.push(`${path}: ${size} bytes, too small to be the real artifact`);
        }
    }
    return problems;
}

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

function main(){
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const files = packedFiles();
    const problems = packageProblems(files, manifest);
    if (problems.length > 0)
    {
        console.error(`@bottlify/core is not publishable:\n  ${problems.join('\n  ')}\n`
            + '  Run `npm run build`.');
        process.exit(1);
    }
    const total = files.reduce((sum, file)=>sum + file.size, 0);
    console.log(`package OK: ${files.length} files, ${(total / 1e6).toFixed(1)} MB unpacked`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
{
    main();
}
