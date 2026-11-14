/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Makes the stand's page with builds of cork side by side, to run on any device
 * with no checkout and no build there: one folder of static files that
 * `serve.mjs --dir` serves, or that is published as it is (a page whose files are
 * its own, nothing fetched from elsewhere).
 *
 *     node tools/bench/build.mjs --arm NAME=REV|DIR [--arm NAME=REV|DIR ...] [--out DIR]
 *
 * Each arm is a git revision (its `modules/core/src` and `modules/cork/src`
 * taken out of the repository) or a checkout's folder as it is, `.` this one with
 * what is not committed yet; the first is A, the base the others are measured
 * against. The folder holds the page (`index.html`, `stand.js`), the worker run in
 * each run (`stand.worker.js`), each arm's cork host and translator bundled
 * (`arm-NAME.js`), the workloads with this checkout's record of their work
 * (`workloads.json`) and what the arms are (`manifest.json`). Default out:
 * `tools/bench/dist/`.
 */

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../..');
const args = process.argv.slice(2);
const specs = args.flatMap((arg, at)=>(arg === '--arm' ? [args[at + 1]] : []));
const outIndex = args.indexOf('--out');
const out = resolve(outIndex >= 0 ? args[outIndex + 1] : join(HERE, 'dist'));
if (specs.length === 0 || specs.some(spec=>!/^[\w.-]+=.+/.test(spec)))
{
    console.error('usage: node tools/bench/build.mjs --arm NAME=REV|DIR [--arm ...] [--out DIR]');
    process.exit(2);
}

/** @param {string[]} command @param {string} [cwd] */
const git = (command, cwd = REPO)=>execFileSync('git', command, { cwd, encoding: 'utf8' }).trim();

/**
 * The tree an arm is built from, and a line saying what it is.
 *
 * @param {string} source  a folder, or a revision of this repository
 */
function treeOf(source){
    if (existsSync(resolve(source)) && existsSync(join(resolve(source), 'modules/cork/src')))
    {
        const root = resolve(source);
        const head = git(['log', '-1', '--format=%h %s'], root);
        const dirty = git(['status', '--porcelain', '--', 'modules/core/src', 'modules/cork/src'],
            root);
        return { root, describe: `${head.slice(0, 90)}${dirty ? ' + changes not committed' : ''}` };
    }
    const root = mkdtempSync(join(tmpdir(), 'cork-stand-'));
    const archive = execFileSync('git', ['archive', source, 'modules/core/src', 'modules/cork/src'],
        { cwd: REPO, maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x', '-C', root], { input: archive });
    const describe = git(['log', '-1', '--format=%h %s', source]).slice(0, 90);
    return { root, describe, temporary: true };
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const COMMON = {
    bundle: true, format: /** @type {const} */ ('esm'), platform: /** @type {const} */ ('browser'),
    target: ['es2022'], minify: true, logLevel: /** @type {const} */ ('error'),
    // The engine's paths into Node, taken only when it runs there.
    external: ['node:*'],
};
const arms = [];
for (const spec of specs)
{
    const [name, source] = [spec.slice(0, spec.indexOf('=')), spec.slice(spec.indexOf('=') + 1)];
    const tree = treeOf(source);
    const entry = join(tree.root, '.stand-arm.js');
    writeFileSync(entry, [
        `export { createCorkHost } from './modules/core/src/layers/cpu/internal/cork-host.js';`,
        `export * as engine from './modules/cork/src/index.js';`, ''].join('\n'));
    await build({ ...COMMON, entryPoints: [entry], outfile: join(out, `arm-${name}.js`) });
    rmSync(entry);
    if (tree.temporary)
    {
        rmSync(tree.root, { recursive: true, force: true });
    }
    arms.push({ name, url: `./arm-${name}.js`, describe: tree.describe });
    console.log(`arm-${name}.js  ${tree.describe}`);
}
await build({ ...COMMON, entryPoints: [join(HERE, 'stand.worker.js')],
    outfile: join(out, 'stand.worker.js') });
writeFileSync(join(out, 'stand.js'), readFileSync(join(HERE, 'stand.js')));
// The page without its doctype: a host that publishes it wraps it in its own.
writeFileSync(join(out, 'index.html'), readFileSync(join(HERE, 'index.html'), 'utf8')
    .replace(/^<!doctype html>\n/i, ''));
const record = JSON.parse(readFileSync(join(HERE, 'expected.json'), 'utf8'));
for (const [name, one] of Object.entries(record.workloads))
{
    const dir = one.bits === 64 ? 'images64' : 'images';
    one.image = readFileSync(join(REPO, 'modules/cork/bench/micro', dir, `${name}.bin`))
        .toString('base64');
}
writeFileSync(join(out, 'workloads.json'), JSON.stringify(record));
const built = new Date().toISOString();
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ arms, built }));
console.log(`${out}: the page with ${arms.length} build(s) of cork`);
