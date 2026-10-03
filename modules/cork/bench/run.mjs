/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Runs the benchmark's workloads on the engine in Node and reports guest
 * instructions per second, each workload's checksum judged against the one
 * the processor itself produced from the same bytes.
 *
 *     node modules/cork/bench/run.mjs [options]
 *
 *   --variant x87|sse|both     which build (default both)
 *   --only a,b,c               workloads to run (default all)
 *   --cork '<json>'            the translator's configuration (`EngineConfig`)
 *   --reps n                   runs of each, the fastest kept (default 1)
 *   --iterations n             instead of each workload's own count
 *   --root <dir>               a checkout whose engine to run instead of this one
 *   --native                   also time the processor through bin/peload
 *   --update-expected          write expected.json from bin/peload's checksums
 *   --json                     one JSON line per run instead of the table
 *
 * A run's time is the wall clock around `app.run`: translation and the cold
 * code before it are part of what a program pays, so they are counted.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const BIN = join(HERE, 'bin');
const EXPECTED = join(HERE, 'expected.json');
const WORKLOADS = ['vm', 'entities', 'math', 'path', 'lz', 'containers', 'spread', 'api'];

/** @param {string[]} argv */
function parse(argv){
    /** @type {Record<string, string | boolean>} */
    const options = {};
    for (let i = 0; i < argv.length; i++)
    {
        const name = argv[i].replace(/^--/, '');
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--'))
        {
            options[name] = true;
        }
        else
        {
            options[name] = next;
            i++;
        }
    }
    return options;
}

const options = parse(process.argv.slice(2));
const variants = options.variant === 'x87' || options.variant === 'sse'
    ? [options.variant] : ['x87', 'sse'];
const only = typeof options.only === 'string' ? options.only.split(',') : WORKLOADS;
const reps = Number(options.reps ?? 1);
const corkConfig = typeof options.cork === 'string' ? JSON.parse(options.cork) : {};
const root = typeof options.root === 'string' ? resolve(options.root) : resolve(HERE, '../../..');
const { createApp } = await import(pathToFileURL(join(root, 'modules/core/src/app.js')).href);

/**
 * The processor's run of one workload.
 *
 * @param {string} variant @param {string} workload @param {string} [iterations]
 */
function native(variant, workload, iterations){
    const args = [join(BIN, `bench-${variant}.exe`), workload, ...iterations ? [iterations] : []];
    const result = spawnSync(join(BIN, 'peload'), args, { encoding: 'utf8' });
    const ns = /native-ns (\d+)/.exec(result.stderr);
    const code = /native-exit (\d+)/.exec(result.stderr);
    const line = /^(\S+) (\d+) ([0-9a-f]{8})/m.exec(result.stdout);
    if (!ns || !code || !line)
    {
        throw new Error(`peload ${args.join(' ')}: ${result.stderr}${result.stdout}`);
    }
    return { ms: Number(ns[1]) / 1e6, checksum: line[3], iterations: Number(line[2]) };
}

/**
 * The engine's run of one workload.
 *
 * @param {Uint8Array} executable @param {string} workload @param {string} [iterations]
 */
async function engine(executable, workload, iterations){
    const app = await createApp({
        executable,
        // Named rather than left to the default: `--root` may be a checkout
        // whose default is another engine.
        engine: 'cork',
        exitNotice: false,
        commandLine: `bench.exe ${workload}${iterations ? ` ${iterations}` : ''}`,
        cork: { config: corkConfig },
    });
    try
    {
        const started = performance.now();
        const code = await app.run({ timeoutMs: 3_600_000, maxTurns: Number.MAX_SAFE_INTEGER });
        const ms = performance.now() - started;
        const cpu = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'cpu');
        const metrics = cpu?.metrics ?? {};
        return {
            ms,
            checksum: (code >>> 0).toString(16).padStart(8, '0'),
            instructions: Number(metrics.instructions ?? 0),
            translated: metrics.cork?.translatedShare ?? null,
            regions: metrics.cork?.regions ?? null,
            crossings: metrics.trapCrossings ?? null,
        };
    }
    finally
    {
        await app.dispose();
    }
}

/** @type {Record<string, Record<string, string>>} */
const expected = existsSync(EXPECTED) ? JSON.parse(await readFile(EXPECTED, 'utf8')) : {};
const haveLoader = existsSync(join(BIN, 'peload'));
const iterations = typeof options.iterations === 'string' ? options.iterations : undefined;

/** @type {{ variant: string, workload: string, mips: number, slowdown: number | null }[]} */
const results = [];
for (const variant of variants)
{
    const executable = new Uint8Array(await readFile(join(BIN, `bench-${variant}.exe`)));
    for (const workload of only)
    {
        const key = `${workload}${iterations ? `@${iterations}` : ''}`;
        const reference = options.native || options['update-expected'] || !expected[variant]?.[key]
            ? haveLoader ? native(variant, workload, iterations) : null
            : null;
        if (options['update-expected'] && reference)
        {
            (expected[variant] ??= {})[key] = reference.checksum;
        }
        const want = reference?.checksum ?? expected[variant]?.[key] ?? null;
        let best = null;
        for (let r = 0; r < reps; r++)
        {
            const run = await engine(executable, workload, iterations);
            if (best === null || run.ms < best.ms)
            {
                best = run;
            }
        }
        const run = /** @type {NonNullable<typeof best>} */ (best);
        const mips = run.instructions / run.ms / 1000;
        const slowdown = reference && options.native ? run.ms / reference.ms : null;
        const ok = want === null ? '?' : want === run.checksum ? 'ok' : `WRONG (want ${want})`;
        results.push({ variant, workload, mips, slowdown });
        if (options.json)
        {
            console.log(JSON.stringify({
                variant, workload, ...run, mips, native: reference?.ms ?? null, slowdown, ok,
            }));
        }
        else
        {
            console.log([
                variant.padEnd(4), workload.padEnd(11),
                `${run.ms.toFixed(0).padStart(6)} ms`,
                `${(run.instructions / 1e6).toFixed(0).padStart(6)} M`,
                `${mips.toFixed(0).padStart(5)} MIPS`,
                slowdown === null ? '' : `x${slowdown.toFixed(1).padStart(5)} native`,
                run.translated === null ? '' : `translated ${(run.translated * 100).toFixed(2)}%`,
                run.regions === null ? '' : `regions ${run.regions}`,
                `crossings ${run.crossings}`, run.checksum, ok,
            ].filter(Boolean).join('  '));
        }
    }
}

/** @param {number[]} values */
const geomean = values=>Math.exp(values.reduce((s, v)=>s + Math.log(v), 0) / values.length);
if (!options.json && results.length > 1)
{
    const slow = results.map(r=>r.slowdown).filter(v=>v !== null);
    console.log(`geomean  ${geomean(results.map(r=>r.mips)).toFixed(0)} MIPS`
        + (slow.length ? `  x${geomean(/** @type {number[]} */ (slow)).toFixed(2)} native` : ''));
}
if (options['update-expected'])
{
    await writeFile(EXPECTED, `${JSON.stringify(expected, null, 4)}\n`);
    console.log('expected.json written');
}
