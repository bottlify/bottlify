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
 * The passes, inside QEMU: the corpus read once, then WARM + REPS passes;
 * in each, every region is formed (`formRegion`) and emitted as a batch of
 * its own (`emitBatch`, as the translator's worker emits one, with the
 * runtime's default options), a mark before the forming, between and after
 * the emitting. What each region holds goes to stdout for the price list.
 *
 * @param {{ roots: string[], regions: number, warm: number, reps: number }} options
 */
const inner = async({ roots: [root], regions, warm, reps })=>{
    const cork = `${root}/modules/cork`;
    const { COLD_REACH, formRegion, formShared } = await import(`${cork}/src/region.js`);
    const { emitBatch } = await import(`${cork}/src/runtime/emit-built.js`);
    const { ownLayout } = await import(`${cork}/src/runtime/layout.js`);
    const { MODE_64 } = await import(`${cork}/src/decode/decoder.js`);
    // An x64 host's engine, whatever this machine is: the count compares trees, not hosts.
    const features = { simd: true, tailCalls: true, defaultNaNNegative: true, armHost: false };
    const emitOptions = { hash: true, profileCalls: true, callReturn: true, linkedCalls: true,
        crossTailCalls: true, looseStacks: true, trapPort: 0xb077 };
    const layouts = { 32: ownLayout({ ramSize: 1 << 30, ramBase: 0 }),
        64: ownLayout({ ramSize: 1 << 30, ramBase: 0, bits: 64 }) };
    /**
     * What the runtime forms with: a span's bytes at once (`bytesOf`), the far branches of
     * callees cold, and what decoding found shared between a pass's regions of one image,
     * as between the regions of one forming round.
     *
     * @type {{ form: Record<string, unknown>, entry: number, bits: 32 | 64, file: string,
     *     read: (address: number) => number }[]}
     */
    const jobs = [];
    /** @type {Shape[]} */
    const shapes = [];
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
            const bytesOf = (/** @type {number} */ start, /** @type {number} */ end)=>
                Uint8Array.from({ length: end - start }, (_, at)=>read(start + at));
            const form = { coldReach: COLD_REACH, bytesOf,
                ...bits === 64 ? { mode: MODE_64 } : {} };
            const queue = [IMAGE_BASE];
            const seen = new Set(queue);
            for (let taken = 0; queue.length > 0 && taken < regions; taken++)
            {
                const entry = /** @type {number} */ (queue.shift());
                jobs.push({ form, entry, bits, file, read });
                const region = formRegion(read, entry, form);
                shapes.push({ ...shapeOf(region, `${file}@0x${entry.toString(16)}`), bits });
                for (const block of region.blocks)
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
        bytes = 0;
        /** @type {ReturnType<typeof formShared> | undefined} */
        let shared;
        let image = '';
        for (const { form, entry, bits, file, read } of jobs)
        {
            if (file !== image)
            {
                image = file;
                shared = formShared();
            }
            mark();
            const region = formRegion(read, entry, { ...form, shared });
            mark();
            bytes += emitBatch([{ region, entryTop: 0 }], layouts[bits], features, emitOptions)
                .module.length;
            mark();
        }
    }
    console.log(JSON.stringify({ regions: jobs.length, bytes, shapes }));
};

/**
 * What a region holds, by what the emitter's cost was found to follow
 * (a cost linear in these, R^2 0.98, nothing growing with a region's size).
 *
 * @typedef {{ name: string, bits: number, block: number, call: number, ret: number,
 *     jmp: number, other: number, bytes: number }} Shape
 * @param {import('../../modules/cork/src/region.js').Region} region @param {string} name
 * @returns {Shape}
 */
const shapeOf = (region, name)=>{
    const shape = { name, bits: 0, block: region.blocks.length, call: 0, ret: 0, jmp: 0, other: 0,
        bytes: 0 };
    for (const block of region.blocks)
    {
        for (const instruction of block.instructions)
        {
            shape.bytes += instruction.length;
            const op = instruction.op;
            // A conditional jump ends its block: its price is the block's.
            if (op === 'call' || op === 'ret' || op === 'jmp')
            {
                shape[op]++;
            }
            else if (!/^j|^loop/.test(op))
            {
                shape.other++;
            }
        }
    }
    return shape;
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
 * The least-squares prices of a linear cost: x with X x nearest y, by the
 * normal equations (a handful of unknowns).
 *
 * @param {number[][]} rows @param {number[]} y @returns {number[]}
 */
const leastSquares = (rows, y)=>{
    const n = rows[0].length;
    const dot = (/** @type {(row: number[], k: number) => number} */ of)=>rows.reduce(
        (sum, row, k)=>sum + of(row, k), 0);
    const a = Array.from({ length: n }, (_, i)=>[
        ...Array.from({ length: n }, (__, j)=>dot(row=>row[i] * row[j])),
        dot((row, k)=>row[i] * y[k])]);
    for (let col = 0; col < n; col++)
    {
        let pivot = col;
        for (let row = col + 1; row < n; row++)
        {
            if (Math.abs(a[row][col]) > Math.abs(a[pivot][col]))
            {
                pivot = row;
            }
        }
        [a[col], a[pivot]] = [a[pivot], a[col]];
        if (a[col][col] === 0)
        {
            // A term no region has: priced at nothing.
            continue;
        }
        for (let row = 0; row < n; row++)
        {
            if (row !== col)
            {
                const factor = a[row][col] / a[col][col];
                for (let k = col; k <= n; k++)
                {
                    a[row][k] -= factor * a[col][k];
                }
            }
        }
    }
    return a.map((row, i)=>(row[i] === 0 ? 0 : row[n] / row[i]));
};

const TERMS = /** @type {const} */ (['region', 'block', 'call', 'ret', 'jmp', 'other']);

/**
 * The price list: what a region, a block (with the jump that ends it), a
 * call, a return, a jump and any other instruction cost, fitted over every
 * region's count, and how well the sum of prices gives each region's.
 *
 * @param {Shape[]} shapes @param {number[]} costs
 */
const priceList = (shapes, costs)=>{
    const rows = shapes.map(shape=>TERMS.map(term=>(term === 'region' ? 1 : shape[term])));
    const prices = leastSquares(rows, costs);
    const fitted = rows.map(row=>row.reduce((sum, n, i)=>sum + n * prices[i], 0));
    const mean = costs.reduce((sum, c)=>sum + c, 0) / costs.length;
    const unexplained = costs.reduce((sum, c, k)=>sum + (c - fitted[k]) ** 2, 0);
    const spread = costs.reduce((sum, c)=>sum + (c - mean) ** 2, 0);
    const errors = costs.map((c, k)=>Math.abs(c - fitted[k]) / c).sort((a, b)=>a - b);
    const total = costs.reduce((sum, c)=>sum + c, 0);
    return { prices: Object.fromEntries(TERMS.map((term, i)=>[term, prices[i]])),
        shares: Object.fromEntries(TERMS.map((term, i)=>[term,
            prices[i] * rows.reduce((sum, row)=>sum + row[i], 0) / total])),
        r2: 1 - unexplained / spread, medianError: errors[errors.length >> 1] };
};


/**
 * One root's passes counted: the plugin's totals at every mark, two a pass.
 *
 * @param {string} root
 * @param {{ regions: number, warm: number, reps: number, qemu: string }} options
 * @param {string} plugin
 * @returns {Promise<{ passes: { form: Kinds, emit: Kinds }[][], regions: number, bytes: number,
 *     shapes: Shape[] }>}
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
        const { regions: count = 0 } = said ? JSON.parse(said[0]) : {};
        if (status !== 0 || !said || marks.length !== 3 * count * (warm + reps))
        {
            reject(new Error(`emit-count: the run of ${root} gave no count (status ${status}, `
                + `${marks.length} marks): ${err.slice(-2000)}`));
            return;
        }
        const between = (/** @type {number} */ from, /** @type {number} */ to)=>/** @type {Kinds} */ (
            Object.fromEntries(KINDS.map((kind, k)=>[kind, marks[to][k] - marks[from][k]])));
        /** @type {{ form: Kinds, emit: Kinds }[][]} */
        const passes = [];
        for (let pass = 0; pass < warm + reps; pass++)
        {
            passes.push(Array.from({ length: count }, (_, r)=>{
                const at = 3 * (pass * count + r);
                return { form: between(at, at + 1), emit: between(at + 1, at + 2) };
            }));
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
    const work = (/** @type {Kinds} */ kinds)=>kinds.js + kinds.gc + kinds.other;
    /** @type {number | undefined} */
    let first;
    const m = (/** @type {number} */ n)=>(n / 1e6).toFixed(1);
    const k = (/** @type {number} */ n)=>`${(n / 1e3).toFixed(1)}k`;
    for (const [i, { passes, regions, bytes, shapes }] of arms.entries())
    {
        const measured = passes.slice(options.warm);
        const sums = measured.map(pass=>pass.reduce((all, one)=>({ form: all.form + work(one.form),
            emit: all.emit + work(one.emit), compile: all.compile + one.form.compile
                + one.emit.compile }), { form: 0, emit: 0, compile: 0 }));
        const mean = (/** @type {(sum: typeof sums[0]) => number} */ of)=>sums.reduce(
            (all, sum)=>all + of(sum), 0) / sums.length;
        const total = mean(sum=>sum.form + sum.emit);
        const works = sums.map(sum=>sum.form + sum.emit);
        first ??= total;
        console.log(`${options.roots[i]}: ${m(total)} M instructions a pass of work (forming `
            + `${m(mean(sum=>sum.form))}, emitting ${m(mean(sum=>sum.emit))}), passes `
            + `${m(Math.min(...works))}..${m(Math.max(...works))}; `
            + `compiles ${m(mean(sum=>sum.compile))} a pass; ${regions} regions, `
            + `${bytes} wasm bytes`
            + (i === 0 ? '' : `; ${(total / first).toFixed(4)} of the first`));
        // A region's cost: its least over the counted passes, past where a collection fell.
        for (const part of /** @type {const} */ (['form', 'emit']))
        {
            const costs = shapes.map((_, r)=>Math.min(
                ...measured.map(pass=>work(pass[r][part]))));
            const { prices, shares, r2, medianError } = priceList(shapes, costs);
            console.log(`  ${part === 'form' ? 'forming ' : 'emitting'} price list `
                + `(R^2 ${r2.toFixed(3)}, a region's error ${(medianError * 100).toFixed(1)}% `
                + 'at the median): '
                + TERMS.map(term=>`${term} ${k(prices[term])} `
                    + `(${(shares[term] * 100).toFixed(0)}%)`)
                    .join(', '));
        }
    }
}
