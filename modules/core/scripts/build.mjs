/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO = resolve(ROOT, '..', '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const PREBUILT = join(ROOT, 'vendor', 'prebuilt');
const VENDOR_OUT = join(DIST, 'vendor');

/**
 * @typedef {Object} VendorArtifact
 * @property {string} name       File under vendor/prebuilt/, and under dist/vendor/.
 * @property {string} lock       The lock file that pins its checksum.
 * @property {string} fetch      The command that puts it in vendor/prebuilt/.
 * @property {boolean} rebuilt   Whether the containerised v86 build also emits it,
 *                               i.e. whether the reproducibility gate covers it.
 */

/**
 * The binaries the published package has to carry. `createApp()` cannot start a
 * machine without the emulator, and the media layer decodes nothing without the
 * decoder; the rest of a v86 release (its non-module bundle, the BIOS images) is
 * not on any path this engine takes, so it is not shipped.
 * @type {readonly VendorArtifact[]}
 */
const VENDOR_ARTIFACTS = [
    { name: 'libv86.mjs', lock: 'vendor-lock.json', fetch: 'npm run fetch:v86', rebuilt: true },
    { name: 'v86.wasm', lock: 'vendor-lock.json', fetch: 'npm run fetch:v86', rebuilt: true },
    {
        name: 'video-decoder.wasm',
        lock: 'video-decoder-lock.json',
        fetch: 'npm run fetch:video-decoder',
        rebuilt: false,
    },
];

/** Files that must travel with the package, copied from the repository root. */
const LEGAL = ['LICENSE', 'THIRD-PARTY-NOTICES.md'];

/**
 * Walks a directory and returns every file path.
 * @param {string} dir
 * @param {string[]} [acc]
 * @returns {Promise<string[]>}
 */
async function walk(dir, acc = []){
    for (const entry of await readdir(dir, { withFileTypes: true }))
    {
        const path = join(dir, entry.name);
        if (entry.isDirectory())
        {
            await walk(path, acc);
        }
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
    for (const file of files)
    {
        const rel = relative(DIST, file).replaceAll('\\', '/');
        entries[`./${rel}`] = await sha256File(file);
    }
    await writeFile(
        join(DIST, 'checksums.json'),
        JSON.stringify({ generated: new Date().toISOString(), files: entries }, null, 2),
    );
}

/**
 * Copies the DirectX runtime, when this machine has it, into
 * dist/vendor/directx/ and records each DLL.
 *
 * Unlike the emulator it is optional: a build with no runtime simply has no
 * system volume, and a `d3dx9_*` a title links against answers from the
 * engine's own table, exactly as before the runtime route existed. That is why
 * absence is silent here rather than the hard stop an absent `v86.wasm` is --
 * the DLLs are someone else's binary, fetched on demand and never committed,
 * so a clean checkout has none.
 *
 * @returns {Promise<{ artifacts: Record<string, string>, source: string | null }>}
 */
async function copyDirectxRuntime(){
    const from = join(PREBUILT, 'directx');
    /** @type {Record<string, string>} */
    const artifacts = {};
    let source = null;
    try
    {
        const names = (await readdir(from)).filter(name=>/\.dll$/i.test(name)).sort();
        if (names.length === 0)
        {
            return { artifacts, source };
        }
        const lock = JSON.parse(
            await readFile(join(ROOT, 'directx-runtime-lock.json'), 'utf8'));
        source = lock.repo && lock.tag ? `${lock.repo}@${lock.tag}` : lock.microsoftUrl ?? null;
        await mkdir(join(VENDOR_OUT, 'directx'), { recursive: true });
        for (const name of names)
        {
            await copyFile(join(from, name), join(VENDOR_OUT, 'directx', name));
            artifacts[`./directx/${name}`] =
                await sha256File(join(VENDOR_OUT, 'directx', name));
        }
    }
    catch (e){
        if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT')
        {
            throw e;
        }
    }
    return { artifacts, source };
}

/**
 * Copies the prebuilt emulator artifacts into dist/vendor/ and records what
 * they are. A package missing them installs cleanly and then cannot boot, so
 * an absent artifact stops the build rather than shipping that.
 */
async function copyVendor(){
    await mkdir(VENDOR_OUT, { recursive: true });
    /** @type {VendorArtifact[]} */
    const missing = [];
    /** @type {Record<string, string>} */
    const artifacts = {};
    /** @type {Record<string, string>} */
    const sources = {};
    /** @type {string[]} */
    const reproducible = [];

    for (const artifact of VENDOR_ARTIFACTS)
    {
        const from = join(PREBUILT, artifact.name);
        try {
            await copyFile(from, join(VENDOR_OUT, artifact.name));
        } catch (e){
            if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT')
            {
                throw e;
            }
            missing.push(artifact);
            continue;
        }
        const lock = JSON.parse(await readFile(join(ROOT, artifact.lock), 'utf8'));
        artifacts[`./${artifact.name}`] = await sha256File(join(VENDOR_OUT, artifact.name));
        sources[`./${artifact.name}`] = `${lock.repo}@${lock.tag}`;
        if (artifact.rebuilt)
        {
            reproducible.push(artifact.name);
        }
    }

    if (missing.length > 0)
    {
        const lines = missing.map(a=>`  vendor/prebuilt/${a.name}  ->  ${a.fetch}`);
        throw new Error(
            `cannot build a package that can boot: ${missing.length} vendor artifact(s) `
            + `are missing.\n${lines.join('\n')}`);
    }

    // The DirectX runtime is the one optional vendor artifact: present, every
    // DLL is recorded and travels with the package; absent, the manifest simply
    // has no directx entries.
    const directx = await copyDirectxRuntime();
    for (const [path, digest] of Object.entries(directx.artifacts))
    {
        const name = path.slice('./'.length);
        artifacts[name] = digest;
        if (directx.source)
        {
            sources[name] = directx.source;
        }
    }

    await writeFile(
        join(VENDOR_OUT, 'manifest.json'),
        JSON.stringify({ artifacts, sources, reproducible }, null, 2),
    );
    return Object.keys(artifacts).length;
}

await mkdir(DIST, { recursive: true });
// Three entries, one build: the module a page imports and the workers it
// starts -- the engine and the log keeper. Bundled apart because a worker is
// loaded by URL, not imported, and each carries what it needs. All sit in
// dist/, so the vendor directory below is the same for each.
await build({
    entryPoints: [
        join(SRC, 'index.js'),
        join(SRC, 'host', 'engine.worker.js'),
        join(SRC, 'host', 'log.worker.js'),
    ],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    // A Node fallback for compression that a browser never reaches: every
    // engine with WebGPU has CompressionStream, so the dynamic import stays
    // unresolved rather than dragging a polyfill into the bundle.
    external: ['node:zlib', 'node:fs/promises', 'node:url'],
    // Shipped small and with its names mangled, and without a map that would
    // hand the source back: the source is in the repository for whoever has
    // it, and the package is the built thing.
    minify: true,
    sourcemap: false,
    // The built module's own directory holds the emulator (see copyVendor),
    // so the engine finds it without being told.
    define: { 'import.meta.env.BOTTLIFY_VENDOR': '"./vendor/"' },
    outdir: DIST,
    entryNames: '[name]',
    logLevel: 'info',
});
// `index.js` is the package's entry and `core.js` is the file the exports map
// names; esbuild names an output after its entry.
await rename(join(DIST, 'index.js'), join(DIST, 'core.js'));
const vendored = await copyVendor();
// The audio worklet runs on the browser's audio thread, loaded by URL rather
// than imported, so it ships as a file of its own beside the module.
await copyFile(join(SRC, 'layers', 'audio', 'output', 'worklet.js'), join(DIST, 'worklet.js'));
// The licence and the notices live once, at the repository root; a published
// package still has to carry its own, so they are copied rather than duplicated.
for (const name of LEGAL)
{
    await copyFile(join(REPO, name), join(ROOT, name));
}
await writeChecksums();
console.log('dist: core.js + engine.worker.js + log.worker.js + '
    + `${vendored} vendor artifacts + checksums.json`);
