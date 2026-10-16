#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What the GPU side of a run cost, from a report: the GPU's own time by pass
 * (timestamp queries, a diagnostics build on a device that stamps), and the
 * pipelines built with the part of their key that kept moving -- a value of
 * the state written into a shader builds a pipeline every time it changes.
 *
 * Usage: node tools/gpu-report.mjs <report.json> [<later report.json>]
 *   One report: totals since the run began. Two: what happened between them.
 */

import { readFileSync } from 'node:fs';

const [first, second] = process.argv.slice(2);
if (!first)
{
    console.error('usage: node tools/gpu-report.mjs <report.json> [<later report.json>]');
    process.exit(2);
}

/** @param {any} value @param {string} key @param {number} [depth] @returns {any[]} */
const findAll = (value, key, depth = 0)=>{
    if (!value || typeof value !== 'object' || depth > 14)
    {
        return [];
    }
    const here = key in value ? [value[key]] : [];
    return [...here, ...Object.values(value).flatMap(child=>findAll(child, key, depth + 1))];
};

/** @param {string} path */
const devicesOf = path=>{
    const report = JSON.parse(readFileSync(path, 'utf8'));
    // The worker's device answers with its timing, its programs and its passes.
    return findAll(report, 'timing').length > 0
        ? findAll(report, 'gpuPasses').filter(Boolean).map((gpuPasses, index)=>({
            gpuPasses,
            fixed: findAll(report, 'fixedPipelines')[index] ?? null,
            programs: findAll(report, 'programs').find(one=>one && 'built' in one) ?? null,
            timing: findAll(report, 'timing')[index] ?? null,
        }))
        : [];
};

const later = devicesOf(second ?? first);
const earlier = second ? devicesOf(first) : [];
if (later.length === 0)
{
    console.log('no GPU device in this report: not measured');
    process.exit(1);
}
later.forEach((device, index)=>{
    const before = earlier[index];
    const passes = device.gpuPasses;
    console.log(`== device ${index}`);
    if (!passes?.available)
    {
        console.log('GPU time by pass: not measured (no timestamp-query on this device, or a'
            + ' production build)');
    }
    else
    {
        const was = new Map((before?.gpuPasses?.byLabel ?? [])
            .map((/** @type {any} */ entry)=>[entry.label, entry]));
        const frames = passes.frames - (before?.gpuPasses?.frames ?? 0);
        const gpuMs = passes.gpuMs - (before?.gpuPasses?.gpuMs ?? 0);
        console.log(`GPU time: ${gpuMs.toFixed(1)} ms over ${frames} timed submits`
            + ` (${frames > 0 ? (gpuMs / frames).toFixed(2) : '-'} ms each),`
            + ` ${passes.untimed} untimed, ${passes.unpaired ?? 0} passes whose stamps are no time`
            + (passes.lastUnpaired?.length ? ` (last ${passes.lastUnpaired.join(' ')})` : ''));
        passes.byLabel
            .map((/** @type {any} */ entry)=>({ ...entry,
                ms: entry.ms - (was.get(entry.label)?.ms ?? 0),
                passes: entry.passes - (was.get(entry.label)?.passes ?? 0) }))
            .filter((/** @type {any} */ entry)=>entry.passes > 0)
            .sort((/** @type {any} */ a, /** @type {any} */ b)=>b.ms - a.ms)
            .slice(0, 15)
            .forEach((/** @type {any} */ entry)=>console.log(
                `  ${entry.ms.toFixed(1).padStart(9)} ms  ${String(entry.passes).padStart(6)}`
                + ` passes  ${(entry.ms / entry.passes).toFixed(3)} ms each  ${entry.label}`));
    }
    for (const [name, cache, was] of /** @type {[string, any, any][]} */ ([
        ['fixed-function pipelines', device.fixed, before?.fixed],
        ['shader pipelines', device.programs, before?.programs]]))
    {
        if (!cache)
        {
            console.log(`${name}: not reported`);
            continue;
        }
        const built = cache.built - (was?.built ?? 0);
        console.log(`${name}: ${built} built, ${cache.reused - (was?.reused ?? 0)} reused,`
            + ` ${(cache.buildMs ?? 0) - (was?.buildMs ?? 0)} ms waiting for builds`);
        for (const churn of cache.churn ?? [])
        {
            console.log(`  key part ${churn.part} changed ${churn.count} times,`
                + ` last ${churn.from} -> ${churn.to}`);
        }
        if (built > 0 && (cache.latest ?? []).length > 0)
        {
            console.log(`  last built: ${cache.latest[cache.latest.length - 1].slice(0, 300)}`);
        }
    }
});
