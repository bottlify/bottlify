/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What translated code costs to run, in machine instructions an iteration: a
 * micro benchmark image (`modules/cork/bench/micro`) runs on the cork host
 * under QEMU, WARM iterations, each waiting for the translations it asked
 * for, then ITERS between two marks the plugin counts at
 * (`tools/lib/qemu-count.mjs`). Time on this machine varies by a fifth
 * between runs of one tree; this count repeats to the instruction, so a
 * change to the code cork emits is judged here before a timed run.
 *
 * The host runs as the stand's page runs it (`tools/bench/stand.js`): on
 * the guest's own clock (`clock: 'virtual'`), translating on its thread, so
 * what it translates, and when, is the same every run - a run whose
 * translation came back from a worker by the machine's time counted a
 * workload that keeps translating (`load`) a fifth apart run to run. Such a
 * workload still varies by a few per cent between runs (three of one tree:
 * 136.9, 139.3 and 143.6 M instructions of its code, 5.9 to 24.9 M of the
 * rest): when V8 has a function's optimised code ready is the machine's,
 * and its code is new all the time. Two runs started together agree, so a
 * difference of a few per cent on it is read over several runs, not one;
 * the other workloads repeat to the instruction.
 * Several roots are arms, each workload's count beside the first's. The
 * count is the whole process's (the translated code, the runtime's lookups
 * and the host between them), V8's optimising compiles apart.
 *
 *     node tools/translator/run-count.mjs --qemu DIR [--root DIR]... [--bits 32|64|both]
 *         [--warm N] [--iters N] [--jobs N] [workload...]
 *
 * Workloads are the micro images' names (`str`, `tree`, `calls512-order`, ...), all of
 * them by default; 32-bit runs the x87 builds, 64-bit the x64 twins. DIR as emit-count's.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { between, mark, runCounted, work } from '../lib/qemu-count.mjs';

const IMAGE_BASE = 0x401000;
const ENTRY_VECTOR = 0x7000;

/** @param {string[]} argv */
const optionsOf = argv=>{
    const options = { roots: /** @type {string[]} */ ([]), bits: 'both', warm: 100, iters: 20,
        jobs: Math.max(1, availableParallelism() - 1), qemu: process.env.QEMU_PLUGIN_DIR ?? '',
        inner: false, names: /** @type {string[]} */ ([]) };
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
        else if (name === '--qemu' || name === '--bits')
        {
            options[/** @type {'qemu' | 'bits'} */ (name.slice(2))] = argv[++i];
        }
        else if (name === '--warm' || name === '--iters' || name === '--jobs')
        {
            options[/** @type {'warm' | 'iters' | 'jobs'} */ (name.slice(2))] = Number(argv[++i]);
        }
        else if (name.startsWith('--'))
        {
            throw new Error(`run-count: unknown argument ${name}`);
        }
        else
        {
            options.names.push(name);
        }
    }
    if (options.roots.length === 0)
    {
        options.roots.push(fileURLToPath(new URL('../../', import.meta.url)));
    }
    return options;
};

/**
 * One workload's iterations, inside QEMU.
 *
 * @param {string} root @param {string} name @param {number} bits @param {number} warm
 * @param {number} iters
 */
const inner = async(root, name, bits, warm, iters)=>{
    const { createCorkHost } = await import(`${root}/modules/core/src/layers/cpu/internal/cork-host.js`);
    const engine = await import(`${root}/modules/cork/src/index.js`);
    const image = readFileSync(bits === 64
        ? `${root}/modules/cork/bench/micro/images64/${name}-x64.bin`
        : `${root}/modules/cork/bench/micro/images/${name}-x87.bin`);
    // As the stand's page runs it (`tools/bench/stand.js`): the guest's own clock, the
    // translation on this thread, the wasm interpreter from the first instruction.
    const host = createCorkHost({ engine, memorySize: 16 << 20, trapPort: 0xb077,
        entryVector: ENTRY_VECTOR, initialStack: 0x800000,
        cork: { clock: 'virtual', worker: false, wasmInterpreterAfter: 0 },
        ...bits === 64 ? { bits } : {} });
    host.writePhysical(IMAGE_BASE, new Uint8Array(image));
    const vector = new Uint8Array(4);
    new DataView(vector.buffer).setUint32(0, IMAGE_BASE, true);
    host.writePhysical(ENTRY_VECTOR, vector);
    const iteration = ()=>{
        host.runSlice(100_000);
        while (!host.halted())
        {
            host.cork().translatePending().catch(()=>{});
            host.runSlice(100_000);
        }
    };
    for (let i = 0; i < warm; i++)
    {
        iteration();
        await host.cork().translatePending();
    }
    mark();
    for (let i = 0; i < iters; i++)
    {
        iteration();
    }
    mark();
    console.log(JSON.stringify({ eax: host.readReg?.(0) ?? null }));
};

/**
 * The workloads: the images of the width, by name.
 *
 * @param {string} root @param {number} bits
 */
const workloadsOf = (root, bits)=>readdirSync(`${root}/modules/cork/bench/micro/${bits === 64
    ? 'images64' : 'images'}`).filter(file=>file.endsWith(bits === 64 ? '-x64.bin' : '-x87.bin'))
    .map(file=>file.replace(/-x(87|64)\.bin$/, '')).sort();

const options = optionsOf(process.argv.slice(2));
if (options.inner)
{
    const [name, bits] = options.names;
    await inner(options.roots[0], name, Number(bits), options.warm, options.iters);
}
else
{
    const widths = options.bits === 'both' ? [32, 64] : [Number(options.bits)];
    const jobs = widths.flatMap(bits=>(options.names.length > 0 ? options.names
        : workloadsOf(options.roots[0], bits)).flatMap(name=>options.roots.map(root=>(
        { root, name, bits }))));
    /** @type {Map<string, number>} */
    const counts = new Map();
    let next = 0;
    const one = async()=>{
        while (next < jobs.length)
        {
            const { root, name, bits } = jobs[next++];
            const { marks } = await runCounted(options.qemu, [fileURLToPath(import.meta.url),
                '--inner', '--root', root, '--warm', String(options.warm), '--iters',
                String(options.iters), name, String(bits)]);
            if (marks.length !== 2)
            {
                throw new Error(`run-count: ${name}-${bits} on ${root} gave ${marks.length} marks`);
            }
            counts.set(`${root}|${name}|${bits}`, work(between(marks, 0, 1)) / options.iters);
        }
    };
    await Promise.all(Array.from({ length: Math.min(options.jobs, jobs.length) }, one));
    console.log(`instructions an iteration (${options.warm} warm, ${options.iters} counted), `
        + `arms: ${options.roots.join(', ')}`);
    /** @type {number[][]} by arm past the first, its ratios */
    const ratios = options.roots.slice(1).map(()=>[]);
    for (const bits of widths)
    {
        for (const name of options.names.length > 0 ? options.names
            : workloadsOf(options.roots[0], bits))
        {
            const base = /** @type {number} */ (counts.get(`${options.roots[0]}|${name}|${bits}`));
            const cells = options.roots.map((root, i)=>{
                const count = /** @type {number} */ (counts.get(`${root}|${name}|${bits}`));
                if (i > 0)
                {
                    ratios[i - 1].push(count / base);
                }
                return `${Math.round(count)}${i === 0 ? '' : ` (${(count / base).toFixed(4)})`}`;
            });
            console.log(`  ${`${name}-${bits}`.padEnd(24)} ${cells.join('  ')}`);
        }
    }
    ratios.forEach((list, i)=>{
        const geomean = Math.exp(list.reduce((sum, r)=>sum + Math.log(r), 0) / list.length);
        console.log(`${options.roots[i + 1]}: geomean ${geomean.toFixed(4)} of the first`);
    });
}
