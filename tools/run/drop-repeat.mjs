#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Which frame drops repeat: several runs of one scenario (their
 * `game-<stamp>-frames.json`), each cut into scenes at its loads, laid scene
 * over scene, and every drop placed by its time since its scene began. A drop
 * the guest's code or our own execution causes falls at the same point of the
 * workload in every run; one the machine causes (another program, the VM)
 * falls somewhere else each time. So only a point that dropped in most runs is
 * worth a hunt, and this lists those, with what grew in them (frame-drops.js).
 *
 *   node tools/run/drop-repeat.mjs <frames.json>... [--bin S] [--share F]
 *       [--gap MS] [--json FILE] [--freeze MS]
 *
 * `--bin` (1 s) is how near two runs' drops must fall to count as one point,
 * `--share` (0.7) the part of the runs that must drop there, `--gap` (1500 ms)
 * the pause between presents that ends a scene (a load). Runs that do not cut
 * into the same number of scenes are laid together by order up to the fewest,
 * and that is said.
 *
 * `--freeze MS` lists instead every frame of MS or longer inside a scene, run
 * by run: the freezes a person sees, with what the frame was made of, its
 * idle time by what it waited on (the `idle-*` notes the run loop keeps), and
 * what the graphics worker finished meanwhile (the `gfx*` notes: frames, the
 * time to their queue, the GPU's own, the worker's replay).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { frameDrops } from '../../modules/core/src/frame-drops.js';
import { isMain } from '../lib/common.mjs';

/**
 * @typedef {import('../../modules/core/src/frame-drops.js').FrameLike
 *     & { startedAt: number }} Frame
 * @typedef {{ frames: Frame[], startMs: number, endMs: number }} Scene
 */

/**
 * A run's scenes: the frames between its loads. A load is a frame of `gap` or
 * more, or a pause of that long between one frame's end and the next one's start.
 *
 * @param {Frame[]} frames @param {number} gap
 * @returns {Scene[]}
 */
export function scenesOf(frames, gap){
    /** @type {Scene[]} */
    const scenes = [];
    /** @type {Frame[]} */
    let current = [];
    let lastEnd = -Infinity;
    const close = ()=>{
        if (current.length > 0)
        {
            const last = current[current.length - 1];
            scenes.push({ frames: current, startMs: current[0].startedAt,
                endMs: last.startedAt + last.ms });
        }
        current = [];
    };
    for (const frame of frames)
    {
        if (frame.ms >= gap)
        {
            close();
            lastEnd = frame.startedAt + frame.ms;
            continue;
        }
        if (frame.startedAt - lastEnd >= gap)
        {
            close();
        }
        current.push(frame);
        lastEnd = frame.startedAt + frame.ms;
    }
    close();
    return scenes;
}

/**
 * The points of each scene that dropped in at least `share` of the runs.
 *
 * @param {Frame[][]} runs @param {{ bin: number, share: number, gap: number }} options
 */
export function repeatingDrops(runs, { bin, share, gap }){
    const cut = runs.map(frames=>scenesOf(frames, gap));
    const counts = cut.map(scenes=>scenes.length);
    const sceneCount = Math.min(...counts);
    const needed = Math.max(2, Math.ceil(runs.length * share));
    const scenes = [];
    for (let s = 0; s < sceneCount; s++)
    {
        /** @type {Map<number, { runs: Set<number>, drops: any[] }>} */
        const points = new Map();
        const perRun = cut.map((scenesOfRun, run)=>{
            const scene = scenesOfRun[s];
            const report = frameDrops(scene.frames);
            for (const drop of report.drops)
            {
                const frame = scene.frames.find(one=>one.index === drop.index)
                    ?? scene.frames[drop.index];
                const at = Math.floor((frame.startedAt - scene.startMs) / 1000 / bin);
                const point = points.get(at) ?? { runs: new Set(), drops: [] };
                point.runs.add(run);
                point.drops.push({ run, ms: drop.ms, cause: drop.cause });
                points.set(at, point);
            }
            return { seconds: (scene.endMs - scene.startMs) / 1000, frames: scene.frames.length,
                medianMs: report.medianMs, low1: report.low1, drops: report.drops.length };
        });
        // A drop that falls by a bin's edge lands in one bin in one run and the
        // next in another: a point counts its neighbours' runs too.
        const repeating = [...points.keys()].sort((one, two)=>one - two).flatMap(at=>{
            const near = new Set([...points.get(at)?.runs ?? [],
                ...points.get(at - 1)?.runs ?? [], ...points.get(at + 1)?.runs ?? []]);
            const here = /** @type {{ runs: Set<number>, drops: any[] }} */ (points.get(at));
            if (near.size < needed || here.runs.size < Math.ceil(needed / 2))
            {
                return [];
            }
            /** @type {Record<string, number>} */
            const causes = {};
            for (const drop of here.drops)
            {
                causes[drop.cause] = (causes[drop.cause] ?? 0) + 1;
            }
            const ms = here.drops.map(drop=>drop.ms).sort((one, two)=>one - two);
            return [{ fromS: at * bin, runs: near.size, drops: here.drops.length,
                medianMs: ms[Math.floor(ms.length / 2)], worstMs: ms[ms.length - 1], causes }];
        });
        const all = perRun.reduce((sum, run)=>sum + run.drops, 0);
        const repeated = repeating.reduce((sum, point)=>sum + point.drops, 0);
        scenes.push({ scene: s, perRun, repeating, drops: all, repeatedDrops: repeated });
    }
    return { runs: runs.length, needed, sceneCounts: counts, scenes };
}

/**
 * Every frame of `freeze` ms or longer inside a scene, by scene.
 *
 * @param {Frame[]} frames @param {number} gap @param {number} freeze
 */
export function freezesOf(frames, gap, freeze){
    return scenesOf(frames, gap).map(scene=>scene.frames.filter(frame=>frame.ms >= freeze)
        .map(frame=>({
            atS: (frame.startedAt - scene.startMs) / 1000, ms: frame.ms,
            guest: frame.byKind.guest ?? 0, host: frame.byKind.host ?? 0,
            idle: frame.idleMs ?? 0,
            idleBy: Object.entries(frame.notes ?? {}).filter(([name])=>name.startsWith('idle-'))
                .sort((one, two)=>two[1] - one[1]),
            worker: Object.entries(frame.notes ?? {}).filter(([name])=>name.startsWith('gfx')),
        })));
}

if (isMain(import.meta.url))
{
    const args = process.argv.slice(2);
    /** @param {string} name @param {number} fallback */
    const option = (name, fallback)=>(args.includes(name)
        ? Number(args[args.indexOf(name) + 1]) : fallback);
    const json = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
    const freeze = option('--freeze', 0);
    const files = args.filter((arg, at)=>!arg.startsWith('--')
        && !['--bin', '--share', '--gap', '--json', '--freeze'].includes(args[at - 1]));
    if (freeze > 0)
    {
        for (const file of files)
        {
            console.log(file);
            const frames = /** @type {Frame[]} */ (JSON.parse(readFileSync(file, 'utf8')));
            freezesOf(frames, option('--gap', 1500), freeze).forEach((list, scene)=>{
                for (const one of list)
                {
                    const by = one.idleBy.length > 0
                        ? `: ${one.idleBy.map(([name, ms])=>`${name} ${ms.toFixed(0)}`).join(', ')}`
                        : '';
                    const worker = one.worker.length > 0
                        ? `; worker ${one.worker.map(([name, value])=>`${name} ${value}`)
                            .join(' ')}`
                        : '';
                    console.log(`  scene ${scene} +${one.atS.toFixed(1)} s ${one.ms.toFixed(0)} ms`
                        + ` guest ${one.guest.toFixed(0)} host ${one.host.toFixed(0)}`
                        + ` idle ${one.idle.toFixed(0)}${by}${worker}`);
                }
            });
        }
        process.exit(0);
    }
    if (files.length < 2)
    {
        console.error('usage: node tools/run/smoke.mjs drops <frames.json> <frames.json>...'
            + ' [--bin S] [--share F] [--gap MS] [--json FILE]');
        process.exit(2);
    }
    const runs = files.flatMap(file=>{
        const frames = /** @type {Frame[]} */ (JSON.parse(readFileSync(file, 'utf8')));
        if (!frames.some(frame=>typeof frame.startedAt === 'number'))
        {
            console.log(`${file}: left out - its frames carry no start time (an older report)`);
            return [];
        }
        return [frames];
    });
    if (runs.length < 2)
    {
        console.error('fewer than two runs whose frames carry a start time: not measured');
        process.exit(1);
    }
    const result = repeatingDrops(runs, { bin: option('--bin', 1), share: option('--share', 0.7),
        gap: option('--gap', 1500) });
    if (new Set(result.sceneCounts).size > 1)
    {
        console.log(`the runs cut into ${result.sceneCounts.join(', ')} scenes: laid together by`
            + ` order up to ${Math.min(...result.sceneCounts)}`);
    }
    console.log(`${result.runs} runs; a point repeats when ${result.needed} of them drop there`);
    for (const scene of result.scenes)
    {
        const seconds = scene.perRun.map(run=>run.seconds.toFixed(0)).join('/');
        const low = scene.perRun.map(run=>run.low1.toFixed(0)).join('/');
        const drops = scene.perRun.map(run=>run.drops).join('/');
        console.log(`scene ${scene.scene}: ${seconds} s, median`
            + ` ${scene.perRun[0].medianMs.toFixed(1)} ms, 1% low ${low} fps, drops ${drops};`
            + ` ${scene.repeatedDrops} of ${scene.drops} at points that repeat`);
        for (const point of scene.repeating)
        {
            const causes = Object.entries(point.causes).sort((one, two)=>two[1] - one[1])
                .map(([cause, count])=>`${cause} ${count}`).join(', ');
            console.log(`    ${point.fromS.toFixed(1).padStart(6)} s  ${point.runs} runs`
                + `  ${String(point.drops).padStart(3)} drops  median ${point.medianMs.toFixed(0)}`
                + ` ms, worst ${point.worstMs.toFixed(0)} ms  (${causes})`);
        }
    }
    if (json)
    {
        writeFileSync(json, JSON.stringify(result, null, 1));
    }
}
