/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What one of a program's own instructions costs once its code has settled,
 * in machine instructions: a PE benchmark workload (`modules/cork/bench`) runs
 * as a whole app under QEMU, and the count is taken between two marks of one
 * run - when the guest has retired FROM million instructions and when it has
 * retired TO million - over the guest instructions between them. A processor
 * running the program itself takes one.
 *
 * `run-count.mjs` counts the micro images on the bare cork host, fed every
 * iteration; this is the program as the product runs it - the loader, the
 * Win32 layer, the app's own loop feeding the translator - so what the
 * runtime does by itself over a long run (callees sampled and formed in,
 * regions gathered) is in the count. The machine's time is taken out of the
 * run (`tools/lib/closed-clock.mjs`) and both marks are in one process, so a
 * tree counts the same every time: `--root` given twice shows it. A window
 * taken early holds V8's baseline code and regions still being formed again;
 * a settled one starts past them (entities and spread: 1200 million on).
 *
 *     node tools/translator/pe-count.mjs --qemu DIR [--root DIR]... [--variant x87|sse|x64]
 *         [--from MILLIONS] [--to MILLIONS] [--cork JSON] [--app JSON] [--jobs N] workload...
 *         [--arm64 NODE [--sysroot DIR] [--lib DIR] [--node-flags 'FLAG...']]
 *
 * Workloads are the benchmark's (`vm`, `entities`, `math`, `path`, `lz`, `containers`,
 * `spread`, `api`); DIR as emit-count's. `--cork` is merged into cork's settings, `--app`
 * into createApp's options (`{"cpu":{"far":true}}`: far reservations).
 * `--arm64` and what follows it count an arm64 host, as run-count's.
 */

import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { between, mark, runCounted, takeTarget, work } from '../lib/qemu-count.mjs';

/** @param {string[]} argv */
const optionsOf = argv=>{
    const options = { roots: /** @type {string[]} */ ([]), variant: 'x87', from: 1200, to: 1300,
        cork: '{}', app: '{}', jobs: Math.max(1, availableParallelism() - 1),
        qemu: process.env.QEMU_PLUGIN_DIR ?? '', inner: false,
        names: /** @type {string[]} */ ([]),
        target: /** @type {import('../lib/qemu-count.mjs').Target} */ ({}) };
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
        else if (name === '--qemu' || name === '--variant' || name === '--cork'
            || name === '--app')
        {
            options[/** @type {'qemu' | 'variant' | 'cork' | 'app'} */ (name.slice(2))] = argv[++i];
        }
        else if (name === '--from' || name === '--to' || name === '--jobs')
        {
            options[/** @type {'from' | 'to' | 'jobs'} */ (name.slice(2))] = Number(argv[++i]);
        }
        else if (takeTarget(options.target, argv, i) > 0)
        {
            i++;
        }
        else if (name.startsWith('--'))
        {
            throw new Error(`pe-count: unknown argument ${name}`);
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
 * One workload's run, inside QEMU: it ends at its second mark.
 *
 * @param {string} root @param {string} variant @param {string} workload
 * @param {number} from @param {number} to  millions of guest instructions
 * @param {string} cork  settings, as JSON @param {string} app  createApp's options, as JSON
 */
const inner = async(root, variant, workload, from, to, cork, app = '{}')=>{
    await import('../lib/closed-clock.mjs');
    await import('../lib/chromium-v8.mjs');
    const { createApp } = await import(`${root}/modules/core/src/app.js`);
    // More iterations than any window reaches: the run is cut at the second mark.
    const running = await createApp({
        ...JSON.parse(app),
        executable: readFileSync(`${root}/modules/cork/bench/bin/bench-${variant}.exe`),
        exitNotice: false, commandLine: `bench.exe ${workload} 100000000`,
        cork: { config: { clock: 'virtual', worker: false, wasmInterpreterAfter: 0,
            ...JSON.parse(cork) } } });
    const cpu = ()=>running.diagnostics().find((/** @type {{ name: string }} */ layer)=>
        layer.name === 'cpu').metrics;
    const bounds = [from * 1e6, to * 1e6];
    /** @type {number[]} */
    const at = [];
    const watch = setInterval(()=>{
        const retired = Number(cpu().instructions);
        if (retired < bounds[at.length])
        {
            return;
        }
        mark();
        at.push(retired);
        if (at.length === 2)
        {
            clearInterval(watch);
            const { regions, prediction } = cpu().cork ?? {};
            console.log(JSON.stringify({ at, regions, reforms: prediction?.reforms ?? null,
                callees: prediction?.callees ?? null }));
            process.exit(0);
        }
    }, 5);
    const code = await running.run({ timeoutMs: 36_000_000, maxTurns: Number.MAX_SAFE_INTEGER });
    throw new Error(`pe-count: ${workload} ended (${code >>> 0}) at ${Number(cpu().instructions)}`
        + ` instructions, before ${bounds[at.length]}`);
};

const options = optionsOf(process.argv.slice(2));
if (options.inner)
{
    const [root, workload] = options.names;
    await inner(root, options.variant, workload, options.from, options.to, options.cork,
        options.app);
}
else
{
    if (options.names.length === 0)
    {
        throw new Error('pe-count: no workload named');
    }
    const jobs = options.names.flatMap(name=>options.roots.map(root=>({ root, name })));
    /** @type {Map<string, { code: number, all: number, guest: number, told: any }>} */
    const rows = new Map();
    let next = 0;
    const one = async()=>{
        while (next < jobs.length)
        {
            const { root, name } = jobs[next++];
            const { marks, out } = await runCounted(options.qemu, [fileURLToPath(import.meta.url),
                '--inner', '--variant', options.variant, '--from', String(options.from),
                '--to', String(options.to), '--cork', options.cork, '--app', options.app,
                root, name], {},
            options.target);
            if (marks.length !== 2)
            {
                throw new Error(`pe-count: ${name} on ${root} gave ${marks.length} marks`);
            }
            const told = JSON.parse(/** @type {string} */ (out.trim().split('\n').pop()));
            const guest = told.at[1] - told.at[0];
            const counted = between(marks, 0, 1);
            rows.set(`${root}|${name}`, { code: counted.js / guest, all: work(counted) / guest,
                guest, told });
        }
    };
    await Promise.all(Array.from({ length: Math.min(options.jobs, jobs.length) }, one));
    console.log(`machine instructions a guest instruction between ${options.from} and `
        + `${options.to} million of the guest's (in V8's code, then the whole process but V8's `
        + `optimising compiles), arms: ${options.roots.join(', ')}`);
    for (const name of options.names)
    {
        const base = /** @type {{ all: number }} */ (rows.get(`${options.roots[0]}|${name}`)).all;
        const cells = options.roots.map((root, i)=>{
            const { code, all, told } = /** @type {NonNullable<ReturnType<typeof rows.get>>} */ (
                rows.get(`${root}|${name}`));
            const against = i === 0 ? '' : ` (${(all / base).toFixed(4)})`;
            return `${code.toFixed(4)} ${all.toFixed(4)}${against} [${told.regions} regions, `
                + `${told.reforms} formed again, ${told.callees} callees]`;
        });
        console.log(`  ${`${name}-${options.variant}`.padEnd(16)} ${cells.join('  ')}`);
    }
}
