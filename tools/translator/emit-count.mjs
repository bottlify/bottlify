/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What translating costs, in machine instructions rather than milliseconds:
 * cork forms and emits a fixed body of regions (the micro benchmark's 32-bit
 * and x86-64 images, the first REGIONS each reaches breadth first) pass after
 * pass under QEMU, and a plugin (`emit-count/count.c`) counts the
 * instructions of each pass. Time on this machine varies by a tenth between
 * runs, which hides every small gain in the emitter; this count of a tree is
 * the same in every run, to the instruction.
 *
 * What a pass costs falls for a long time: V8 keeps optimising the
 * emitter's rarer functions for ninety passes, and each compile lands in the
 * pass that crossed its threshold, a few hundred million instructions in one
 * pass and none in the next. So the count is split by where the code lies:
 * the emitter's own work (the code V8 made of it, V8's builtins, the
 * collector and the rest of the runtime) is steady within a per cent from
 * the fortieth pass, and is what an arm is judged by; the compiles are said
 * beside it. The collector is part of the work, kept steady by a young
 * generation of 64 MiB and an old one past what a run reaches: node's
 * predictable collection schedule makes the old generation's marks fall
 * where a pass's garbage happens to cross a fixed step instead.
 *
 * The count is regionModule's: one region formed and emitted as a module of
 * its own, as the translator's worker emits each of a batch's, for an x64
 * host's engine. Several roots are arms, run at once (the count does not
 * depend on the machine's load), each with its ratio to the first.
 *
 * Needs a qemu-x86_64 built with plugins (`./configure
 * --target-list=x86_64-linux-user --enable-plugins`; a distribution's
 * qemu-user usually has none) and gcc with glib's headers to build the
 * plugin, which the run does once beside the qemu binary it is given.
 *
 *     node tools/translator/emit-count.mjs --qemu DIR [--root DIR]... [--regions N] [--warm W]
 *         [--reps R]
 *
 * DIR holds `qemu-x86_64` and `qemu-plugin.h` (a build's `build/` and
 * `include/qemu/` copied together, or env QEMU_PLUGIN_DIR). The node that
 * runs this runs the passes: a newer one measures a newer V8.
 */

import { existsSync, fdatasyncSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const IMAGE_BASE = 0x401000;
const NODE_FLAGS = ['--single-threaded', '--predictable', '--no-flush-bytecode',
    '--min-semi-space-size=64', '--max-semi-space-size=64', '--initial-old-space-size=4096'];
const KINDS = /** @type {const} */ (['js', 'compile', 'gc', 'other']);

/** @param {string[]} argv */
const optionsOf = argv=>{
    const options = { roots: /** @type {string[]} */ ([]), regions: 3, warm: 40, reps: 8, inner: false,
        qemu: process.env.QEMU_PLUGIN_DIR ?? '' };
    for (let i = 0; i < argv.length; i++)
    {
        const name = argv[i];
        if (name === '--inner')
        {
            options.inner = true;
        }
        else if (name === '--root')
        {
            options.roots.push(argv[++i]);
        }
        else if (name === '--qemu')
        {
            options.qemu = argv[++i];
        }
        else if (name === '--regions' || name === '--warm' || name === '--reps')
        {
            options[/** @type {'regions' | 'warm' | 'reps'} */ (name.slice(2))] = Number(argv[++i]);
        }
        else
        {
            throw new Error(`emit-count: unknown argument ${name}`);
        }
    }
    if (options.roots.length === 0)
    {
        options.roots.push(fileURLToPath(new URL('../../', import.meta.url)));
    }
    return options;
};

/**
 * A mark in the count: the plugin prints its totals at every fdatasync,
 * which nothing else in node calls (on a pipe it fails, and is made all the
 * same).
 */
const mark = ()=>{
    try
    {
        fdatasyncSync(1);
    }
    catch {
        // EINVAL on a pipe: the call was made, which is all a mark is.
    }
};

/**
 * The passes, inside QEMU: the corpus formed once, then WARM + REPS passes,
 * each between two marks.
 *
 * @param {{ roots: string[], regions: number, warm: number, reps: number }} options
 */
const inner = async({ roots: [root], regions, warm, reps })=>{
    const cork = `${root}/modules/cork`;
    const { regionModule } = await import(`${cork}/src/region-module.js`);
    const { formRegion } = await import(`${cork}/src/region.js`);
    const { MODE_64 } = await import(`${cork}/src/decode/decoder.js`);
    // An x64 host's engine, whatever this machine is: the count compares trees, not hosts.
    const hostFeatures = { simd: true, tailCalls: true, sharedMemory: true,
        defaultNaNNegative: true, armHost: false };
    const options = { hash: true, callReturn: true, looseStacks: true, hostFeatures };
    /** @type {{ code: Uint8Array, at: number, entry: number, bits: 32 | 64 }[]} */
    const jobs = [];
    for (const [bits, dir, suffix] of /** @type {const} */ ([[32, 'images', '-x87.bin'],
        [64, 'images64', '-x64.bin']]))
    {
        const path = `${cork}/bench/micro/${dir}/`;
        for (const file of readdirSync(path).filter(name=>name.endsWith(suffix)).sort())
        {
            const image = new Uint8Array(readFileSync(path + file));
            const read = (/** @type {number} */ address)=>{
                const offset = address - IMAGE_BASE;
                return offset >= 0 && offset < image.length ? image[offset] : 0xf4;
            };
            const queue = [IMAGE_BASE];
            const seen = new Set(queue);
            for (let taken = 0; queue.length > 0 && taken < regions; taken++)
            {
                const entry = /** @type {number} */ (queue.shift());
                jobs.push({ code: image, at: IMAGE_BASE, entry, bits });
                const form = bits === 64 ? { mode: MODE_64 } : {};
                for (const block of formRegion(read, entry, form).blocks)
                {
                    for (const target of [...block.exit.targets, ...block.exit.predicted ?? []])
                    {
                        const inside = target >= IMAGE_BASE && target < IMAGE_BASE + image.length;
                        if (inside && !seen.has(target))
                        {
                            seen.add(target);
                            queue.push(target);
                        }
                    }
                }
            }
        }
    }
    let bytes = 0;
    for (let i = 0; i < warm + reps; i++)
    {
        mark();
        bytes = 0;
        for (const job of jobs)
        {
            bytes += regionModule({ ...job, ...options }).wasm.length;
        }
        mark();
    }
    console.log(JSON.stringify({ regions: jobs.length, bytes }));
};

/**
 * The plugin, built beside the qemu binary the first time, or again when
 * its source is newer.
 *
 * @param {string} dir
 */
const pluginIn = dir=>{
    const source = fileURLToPath(new URL('emit-count/count.c', import.meta.url));
    const built = `${dir}/emit-count.so`;
    if (!existsSync(`${dir}/qemu-x86_64`) || !existsSync(`${dir}/qemu-plugin.h`))
    {
        throw new Error(`emit-count: not measured: --qemu ${dir || '(none)'} holds no qemu-x86_64 `
            + 'and qemu-plugin.h (a qemu built with --enable-plugins)');
    }
    if (!existsSync(built) || statSync(built).mtimeMs < statSync(source).mtimeMs)
    {
        const glib = execFileSync('pkg-config', ['--cflags', 'glib-2.0'], { encoding: 'utf8' })
            .trim().split(/\s+/);
        execFileSync('gcc', ['-shared', '-fPIC', '-O2', ...glib, `-I${dir}`, source, '-o', built]);
    }
    return built;
};

/** @typedef {{ js: number, compile: number, gc: number, other: number }} Kinds */

/**
 * One root's passes counted: the plugin's totals at every mark, two a pass.
 *
 * @param {string} root
 * @param {{ regions: number, warm: number, reps: number, qemu: string }} options
 * @param {string} plugin
 * @returns {Promise<{ passes: Kinds[], regions: number, bytes: number }>}
 */
const counted = (root, { regions, warm, reps, qemu }, plugin)=>new Promise((resolve, reject)=>{
    const run = spawn(`${qemu}/qemu-x86_64`, ['-plugin', plugin, process.execPath, ...NODE_FLAGS,
        fileURLToPath(import.meta.url), '--inner', '--root', root, '--regions', String(regions),
        '--warm', String(warm), '--reps', String(reps)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    run.stdout.on('data', chunk=>{
        out += chunk;
    });
    run.stderr.on('data', chunk=>{
        err += chunk;
    });
    run.on('error', reject);
    run.on('close', status=>{
        const marks = [...err.matchAll(/^Mark : \d+ js (\d+) compile (\d+) gc (\d+) other (\d+)$/gm)]
            .map(([, ...counts])=>counts.map(Number));
        const said = /^\{.*\}$/m.exec(out);
        if (status !== 0 || !said || marks.length !== 2 * (warm + reps))
        {
            reject(new Error(`emit-count: the run of ${root} gave no count (status ${status}, `
                + `${marks.length} marks): ${err.slice(-2000)}`));
            return;
        }
        /** @type {Kinds[]} */
        const passes = [];
        for (let i = 0; i < marks.length; i += 2)
        {
            passes.push(/** @type {Kinds} */ (Object.fromEntries(KINDS.map((kind, k)=>[kind,
                marks[i + 1][k] - marks[i][k]]))));
        }
        resolve({ passes, ...JSON.parse(said[0]) });
    });
});

const options = optionsOf(process.argv.slice(2));
if (options.inner)
{
    await inner(options);
}
else
{
    const plugin = pluginIn(options.qemu);
    const arms = await Promise.all(options.roots.map(root=>counted(root, options, plugin)));
    /** @type {number | undefined} */
    let first;
    const m = (/** @type {number} */ n)=>(n / 1e6).toFixed(1);
    for (const [i, { passes, regions, bytes }] of arms.entries())
    {
        const measured = passes.slice(options.warm);
        const works = measured.map(pass=>pass.js + pass.gc + pass.other);
        const mean = (/** @type {(pass: Kinds) => number} */ of)=>measured.reduce(
            (all, pass)=>all + of(pass), 0) / measured.length;
        const work = mean(pass=>pass.js + pass.gc + pass.other);
        first ??= work;
        console.log(`${options.roots[i]}: ${m(work)} M instructions a pass of work `
            + `(js ${m(mean(pass=>pass.js))}, gc ${m(mean(pass=>pass.gc))}, `
            + `other ${m(mean(pass=>pass.other))}), passes ${m(Math.min(...works))}..`
            + `${m(Math.max(...works))}; ${Math.round(work / regions)} a region; `
            + `compiles ${m(mean(pass=>pass.compile))} a pass; ${regions} regions, `
            + `${bytes} wasm bytes`
            + (i === 0 ? '' : `; ${(work / first).toFixed(4)} of the first`));
    }
}
