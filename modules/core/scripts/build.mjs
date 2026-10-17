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
import { buildGuestCode } from './build-guest-code.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO = resolve(ROOT, '..', '..');
const SRC = join(ROOT, 'src');
const DIST = join(ROOT, 'dist');
const PREBUILT = join(ROOT, 'vendor', 'prebuilt');
const CORK_SRC = join(REPO, 'modules', 'cork', 'src');
const VENDOR_OUT = join(DIST, 'vendor');

/**
 * @typedef {Object} VendorArtifact
 * @property {string} name       File under vendor/prebuilt/, and under dist/vendor/.
 * @property {string} lock       The lock file that pins its checksum.
 * @property {string} fetch      The command that puts it in vendor/prebuilt/.
 */

/**
 * The binaries the published package carries when the build has them. Both
 * are optional: the media layer says it decodes nothing without the decoder,
 * and the JavaScript zstd decoder stands in for the wasm one.
 * @type {readonly VendorArtifact[]}
 */
const VENDOR_ARTIFACTS = [
    {
        name: 'video-decoder.wasm',
        lock: 'video-decoder-lock.json',
        fetch: 'npm run fetch:video-decoder',
    },
    { name: 'zstd.wasm', lock: 'zstd-lock.json', fetch: 'npm run fetch:zstd' },
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
 * Copies the prebuilt binaries into dist/vendor/ and records what they are.
 */
async function copyVendor(){
    await mkdir(VENDOR_OUT, { recursive: true });
    /** @type {VendorArtifact[]} */
    const missing = [];
    /** @type {Record<string, string>} */
    const artifacts = {};
    /** @type {Record<string, string>} */
    const sources = {};

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
    }

    // Each absent artifact is named, so a build log says what the package
    // does not carry.
    for (const artifact of missing)
    {
        console.log(`dist: ${artifact.name} absent (${artifact.fetch}); the package will `
            + 'not carry it');
    }

    await writeFile(
        join(VENDOR_OUT, 'manifest.json'),
        JSON.stringify({ artifacts, sources }, null, 2),
    );
    return Object.keys(artifacts).length;
}

await mkdir(DIST, { recursive: true });
// The runtime functions written as @guestCode are compiled to x86 again before
// anything is bundled: the committed modules are what the source tree runs,
// and the bundle carries what their source says.
const rewritten = await buildGuestCode();
if (rewritten.length > 0)
{
    console.log(`guest code: wrote ${rewritten.join(', ')}`);
}
// A production bundle leaves its diagnostic instruments out of itself: every
// guard reads `import.meta.BOTTLIFY_DIAGNOSTICS !== false`, which this folds to
// `false`, and the minifier drops what it guards -- the clock reads, the
// profilers, the records only a report reads. The source, which the tests and
// the harness run, has no such define and keeps them; so does a bundle built
// with `--diagnostics` (or BOTTLIFY_DIAGNOSTICS=1), for a launcher whose runs
// are to be measured.
const keepDiagnostics = process.argv.includes('--diagnostics')
    || process.env.BOTTLIFY_DIAGNOSTICS === '1';
const DIAGNOSTICS_OFF = keepDiagnostics ? {} : { 'import.meta.BOTTLIFY_DIAGNOSTICS': 'false' };
// `--readable` (or BOTTLIFY_READABLE=1) leaves the names as written: a CPU
// profile of a run then names the engine's own functions rather than the
// minifier's letters. Only for measuring; what ships is minified.
const readable = process.argv.includes('--readable') || process.env.BOTTLIFY_READABLE === '1';
if (keepDiagnostics)
{
    console.log('diagnostics: kept in the bundle');
}
// Seven entries, one build: the module a page imports and the workers it
// starts -- the engine and the log keeper -- and the ones the engine starts:
// the one Direct3D draws in, a child process's own, a process's further
// executors (`layers/cpu/internal/executor.worker.js`), and the one that writes
// the translation store's records (`translation-store.writer.js`). Bundled apart because
// a worker is loaded by URL, not imported, and each carries what it needs. All
// sit in dist/, so the vendor directory below is the same for each.
await build({
    entryPoints: [
        join(SRC, 'index.js'),
        join(SRC, 'host', 'engine.worker.js'),
        join(SRC, 'host', 'log.worker.js'),
        join(SRC, 'host', 'graphics.worker.js'),
        join(SRC, 'host', 'process.worker.js'),
        join(SRC, 'layers', 'cpu', 'internal', 'executor.worker.js'),
        join(SRC, 'layers', 'cpu', 'internal', 'translation-store.writer.js'),
    ],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    // A Node fallback for compression that a browser never reaches: every
    // engine with WebGPU has CompressionStream, so the dynamic import stays
    // unresolved rather than dragging a polyfill into the bundle.
    external: ['node:zlib', 'node:fs/promises', 'node:url', 'node:worker_threads'],
    // Shipped small and with its names mangled, and without a map that would
    // hand the source back: the source is in the repository for whoever has
    // it, and the package is the built thing.
    minify: !readable,
    sourcemap: false,
    // The built module's own directory holds the prebuilt binaries (see
    // copyVendor) and the translator (below), so the engine finds both without
    // being told.
    define: {
        ...DIAGNOSTICS_OFF,
        'import.meta.env.BOTTLIFY_VENDOR': '"./vendor/"',
        'import.meta.env.BOTTLIFY_CORK': '"./cork/index.js"',
    },
    outdir: DIST,
    entryNames: '[name]',
    logLevel: 'info',
});
// `index.js` is the package's entry and `core.js` is the file the exports map
// names; esbuild names an output after its entry.
await rename(join(DIST, 'index.js'), join(DIST, 'core.js'));
// The translator, which the cpu layer loads by URL rather than imports: its
// engine module and the translation worker it opens from beside itself, under
// the same define. Node's worker and zlib are for a test process, never a page.
await build({
    entryPoints: [
        join(CORK_SRC, 'index.js'),
        join(CORK_SRC, 'runtime', 'translator.worker.js'),
    ],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    external: ['node:worker_threads', 'node:zlib'],
    minify: !readable,
    sourcemap: false,
    define: DIAGNOSTICS_OFF,
    outdir: join(DIST, 'cork'),
    entryNames: '[name]',
    logLevel: 'info',
});
const vendored = await copyVendor();
// The audio worklet runs on the browser's audio thread, loaded by URL rather
// than imported, so it ships as a file of its own beside the module -- with
// the mixer's arithmetic taken from `mix.js` as built, not from the copy kept
// in the worklet's source, so a change to the mixer reaches what is heard
// even before the copy is brought in step (worklet.test.js asks for that).
{
    const output = join(SRC, 'layers', 'audio', 'output');
    const begin = '/* WORKLET-SHARED:BEGIN */';
    const end = '/* WORKLET-SHARED:END */';
    const mix = await readFile(join(output, 'mix.js'), 'utf8');
    const worklet = await readFile(join(output, 'worklet.js'), 'utf8');
    const shared = mix.slice(mix.indexOf(begin), mix.indexOf(end) + end.length)
        .replace(/^export /gm, '');
    if (mix.indexOf(begin) < 0 || mix.indexOf(end) < 0 || worklet.indexOf(begin) < 0
        || worklet.indexOf(end) < 0)
    {
        throw new Error('the WORKLET-SHARED markers are missing from mix.js or worklet.js');
    }
    await writeFile(join(DIST, 'worklet.js'), worklet.slice(0, worklet.indexOf(begin)) + shared
        + worklet.slice(worklet.indexOf(end) + end.length));
}
// The licence and the notices live once, at the repository root; a published
// package still has to carry its own, so they are copied rather than duplicated.
for (const name of LEGAL)
{
    await copyFile(join(REPO, name), join(ROOT, name));
}
await writeChecksums();
console.log('dist: core.js + engine.worker.js + log.worker.js + graphics.worker.js'
    + ' + process.worker.js + executor.worker.js + translation-store.writer.js + cork/ + '
    + `${vendored} vendor artifacts + checksums.json`);
