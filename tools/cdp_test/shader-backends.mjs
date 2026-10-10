/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The WGSL the Direct3D 9 translator makes, put through the two shading
 * languages a browser's WebGPU lowers it to on the desktop: Metal (MSL 2.1,
 * what macOS takes) and HLSL (model 5.1, the oldest a Direct3D 12 device
 * compiles). The shader gate runs the WGSL on one device, which here is
 * SwiftShader on Vulkan; this answers the other question -- whether the same
 * text is one the Metal and Direct3D backends can write at all -- for the
 * gate's own seeded shaders and for any folder of .wgsl added after them.
 *
 *   node tools/cdp_test/shader-backends.mjs [--count 40] [--length 14]
 *       [--naga path] [dir-of-wgsl ...]
 *
 * The lowering is naga's (`cargo install naga-cli`), not the browser's own
 * compiler: a construct it refuses is one at least one real backend refuses,
 * a construct it takes may still cost the driver differently. Without naga
 * the tool says it measured nothing and exits 2, never that all passed.
 *
 * One construct naga's HLSL writer does not take at all: the clip distances
 * of a module that enables `clip_distances`, which its HLSL backend leaves
 * out of the capabilities it validates for. A browser compiles WGSL with a
 * compiler of its own, and is given such a module only on a device made with
 * `clip-distances`. That lowering is counted as not measured, never as
 * passed; the Metal one is made as any other.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildCase, PROFILES } from './shader-cases.mjs';

const TARGETS = [
    { name: 'msl 2.1', ext: 'metal', args: ['--metal-version', '2.1'], clipDistances: true },
    { name: 'hlsl 5.1', ext: 'hlsl', args: ['--shader-model', '51'], clipDistances: false },
];

/** @param {string[]} argv @param {string} flag @param {string} fallback */
const option = (argv, flag, fallback)=>{
    const at = argv.indexOf(flag);
    return at >= 0 ? argv[at + 1] : fallback;
};

/** @param {string} naga */
function nagaWorks(naga){
    try
    {
        execFileSync(naga, ['--version'], { stdio: 'pipe' });
        return true;
    }
    catch {
        return false;
    }
}

const argv = process.argv.slice(2);
const count = Number(option(argv, '--count', '40'));
const length = Number(option(argv, '--length', '14'));
const home = process.env.HOME ?? '';
const naga = option(argv, '--naga', existsSync(join(home, '.cargo/bin/naga'))
    ? join(home, '.cargo/bin/naga') : 'naga');
const dirs = argv.filter((a, i)=>!a.startsWith('--') && !argv[i - 1]?.startsWith('--'));

if (!nagaWorks(naga))
{
    console.error(`not measured: naga was not found (${naga}); cargo install naga-cli`);
    process.exit(2);
}

/** @type {{ name: string, wgsl: string }[]} */
const corpus = [];
for (const profile of Object.keys(PROFILES))
{
    for (let seed = 1; seed <= count; seed++)
    {
        const c = buildCase(profile, seed, length);
        if (!c.error && c.wgsl)
        {
            corpus.push({ name: `${profile} seed ${seed}`, wgsl: c.wgsl });
        }
    }
}
for (const dir of dirs)
{
    for (const file of readdirSync(dir).filter(f=>f.endsWith('.wgsl')))
    {
        corpus.push({ name: join(dir, file), wgsl: readFileSync(join(dir, file), 'utf8') });
    }
}

const work = mkdtempSync(join(tmpdir(), 'shader-backends-'));
let failed = 0;
let unmeasured = 0;
try
{
    corpus.forEach((one, at)=>{
        const source = join(work, `${at}.wgsl`);
        writeFileSync(source, one.wgsl);
        for (const target of TARGETS)
        {
            if (!target.clipDistances && /^enable clip_distances;/m.test(one.wgsl))
            {
                unmeasured++;
                continue;
            }
            try
            {
                execFileSync(naga, [...target.args, source, join(work, `${at}.${target.ext}`)],
                    { stdio: 'pipe' });
            }
            catch (e){
                failed++;
                const why = String(/** @type {any} */ (e).stderr ?? e).trim().split('\n')[0];
                console.log(`FAIL ${one.name} -> ${target.name}: ${why}`);
            }
        }
    });
}
finally
{
    rmSync(work, { recursive: true, force: true });
}
console.log(`${corpus.length} shaders, ${corpus.length * TARGETS.length - unmeasured} lowerings, `
    + `${failed} refused (${TARGETS.map(t=>t.name).join(', ')}; naga)`
    + (unmeasured ? `; ${unmeasured} not measured: naga's HLSL writer has no clip distances`
        : ''));
process.exit(failed ? 1 : 0);
