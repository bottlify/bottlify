#!/usr/bin/env node
/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A stretch of a running title's frame, look by look, as charts: one frame or
 * one report varies by a quarter between looks, and a series shows what a
 * scene costs, where it spikes and what moves with what.
 *
 * The launcher's performance overlay (F3) keeps every look it takes -- once a
 * second, or every `?overlayMs=` -- in `window.bottlifyOverlaySeries`: fps,
 * the frame by phase, the GPU's time per frame, the guest's threads. This
 * reads that series from a live driver (`tools/cdp_test/live/drive.mjs`), or
 * from the file `tools/cdp_test/live/series-record.mjs` keeps of it, the last
 * `seconds` of it, and writes `<out>.json` and `<out>.html`, the charts
 * drawn inline with nothing to load.
 *
 * Usage: node tools/frame-series.mjs <out path without extension> [seconds]
 *     [driver port | recorded .jsonl]
 */

import { readFileSync, writeFileSync } from 'node:fs';

const [out, seconds = '0', source = '9401'] = process.argv.slice(2);
if (!out)
{
    console.error('usage: node tools/frame-series.mjs <out path without extension>'
        + ' [seconds] [driver port | recorded .jsonl]');
    process.exit(2);
}

/** @type {any} */
let series;
if (source.endsWith('.jsonl'))
{
    series = readFileSync(source, 'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
}
else
{
    const answer = await fetch(`http://127.0.0.1:${source}/eval?js=${encodeURIComponent(
        'JSON.stringify(window.bottlifyOverlaySeries ?? null)')}`);
    series = JSON.parse(await answer.text());
    series = typeof series === 'string' ? JSON.parse(series) : series;
}
if (!Array.isArray(series) || series.length === 0)
{
    console.error('no series: the performance overlay is off (F3) or has not looked yet');
    process.exit(1);
}
const since = Number(seconds) > 0
    ? series[series.length - 1].at - Number(seconds) * 1000 : -Infinity;
const rows = series.filter((/** @type {any} */ row)=>row.at >= since);
const start = rows[0].at;

const COLOURS = ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1',
    '#ff9da7', '#9c755f', '#bab0ac'];

/**
 * One chart over the looks: lines, or areas stacked.
 *
 * @param {string} title @param {string[]} keys
 * @param {(row: any, key: string) => number | null} value @param {boolean} stacked
 */
const chart = (title, keys, value, stacked)=>{
    const width = 900;
    const height = 220;
    const left = 44;
    const span = Math.max(1, rows[rows.length - 1].at - start);
    const x = (/** @type {any} */ row)=>left + ((row.at - start) * (width - left - 10)) / span;
    const most = Math.max(1e-9, ...rows.map((/** @type {any} */ row)=>(stacked
        ? keys.reduce((sum, key)=>sum + (value(row, key) ?? 0), 0)
        : Math.max(0, ...keys.map(key=>value(row, key) ?? 0)))));
    const y = (/** @type {number} */ v)=>height - 20 - (v * (height - 30)) / most;
    const below = rows.map(()=>0);
    const shapes = keys.map((key, index)=>{
        const colour = COLOURS[index % COLOURS.length];
        if (!stacked)
        {
            return `<polyline fill="none" stroke="${colour}" stroke-width="1.5" points="${
                rows.map((/** @type {any} */ row)=>`${x(row)},${y(value(row, key) ?? 0)}`).join(' ')}"/>`;
        }
        const upper = rows.map((/** @type {any} */ row, /** @type {number} */ at)=>below[at]
            + (value(row, key) ?? 0));
        const points = [...rows.map((/** @type {any} */ row, /** @type {number} */ at)=>
            `${x(row)},${y(upper[at])}`),
        ...rows.map((/** @type {any} */ row, /** @type {number} */ at)=>`${x(row)},${y(below[at])}`)
            .reverse()].join(' ');
        upper.forEach((v, at)=>{
            below[at] = v;
        });
        return `<polygon fill="${colour}" fill-opacity="0.75" points="${points}"/>`;
    });
    const legend = keys.map((key, index)=>`<span style="color:${COLOURS[index % COLOURS.length]}">`
        + `&#9632; ${key}</span>`).join(' &nbsp; ');
    return `<h3>${title}</h3><div>${legend}</div><svg width="${width}" height="${height}">`
        + `<text x="2" y="14" font-size="11">${most.toFixed(1)}</text>`
        + `<text x="2" y="${height - 22}" font-size="11">0</text>`
        + `<line x1="${left}" y1="${height - 20}" x2="${width}" y2="${height - 20}" stroke="#888"/>`
        + `${shapes.join('')}<text x="${left}" y="${height - 4}" font-size="11">0 s</text>`
        + `<text x="${width - 50}" y="${height - 4}" font-size="11">${
            ((rows[rows.length - 1].at - start) / 1000).toFixed(0)} s</text></svg>`;
};

/** @param {number[]} values */
const median = values=>{
    const sorted = values.filter(Number.isFinite).sort((a, b)=>a - b);
    return sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : NaN;
};
/** @param {(row: any) => number | null} of */
const spread = of=>{
    const values = rows.map(of).filter((/** @type {any} */ v)=>Number.isFinite(v))
        .sort((/** @type {number} */ a, /** @type {number} */ b)=>a - b);
    return values.length > 0
        ? `median ${median(values).toFixed(1)}, ${values[0].toFixed(1)}`
            + `..${values[values.length - 1].toFixed(1)}`
        : 'not measured';
};

const phaseKeys = [...new Set(rows.flatMap((/** @type {any} */ row)=>
    row.budget.map((/** @type {any} */ part)=>part.name))), 'not in any phase'];
const phase = (/** @type {any} */ row, /** @type {string} */ key)=>(key === 'not in any phase'
    ? row.notInPhaseMs : row.budget.find((/** @type {any} */ part)=>part.name === key)?.ms ?? 0);
const threadKeys = [...new Set(rows.flatMap((/** @type {any} */ row)=>
    (row.threads ?? []).map((/** @type {any} */ thread)=>thread.name)))];
const thread = (/** @type {any} */ row, /** @type {string} */ key)=>
    (row.threads ?? []).find((/** @type {any} */ one)=>one.name === key)?.share ?? 0;

const summary = [
    `${rows.length} looks over ${((rows[rows.length - 1].at - start) / 1000).toFixed(0)} s`,
    `fps ${spread(row=>row.fps)}`,
    `frame ms ${spread(row=>row.frameMs)}`,
    `GPU ms ${spread(row=>row.gpuMs)}`,
    `parallel ${spread(row=>row.parallelBound)}`,
    `tab memory MiB ${spread(row=>row.tabMemory?.totalMB ?? null)}`,
    `guest mapped MiB ${spread(row=>row.guestMappedMB ?? null)}`,
    ...phaseKeys.map(key=>`${key} ms ${spread(row=>phase(row, key))}`),
];
const html = `<!doctype html><meta charset="utf-8"><title>Frame series</title>
<body style="font-family:system-ui,sans-serif;background:#fff;color:#222;margin:16px">
<h2>${out}</h2><p>${summary.join('<br>')}</p>
${chart('fps', ['fps'], row=>row.fps, false)}
${chart('the frame by phase, ms per frame', phaseKeys, phase, true)}
${chart('GPU, ms per frame (submit to done)', ['GPU'], row=>row.gpuMs, false)}
${chart('guest threads, share of instructions %', threadKeys, thread, true)}
${chart('parallel bound (all / busiest thread)', ['parallel'], row=>row.parallelBound, false)}
${chart('memory, MiB', ['tab', 'guest mapped', 'page heap'], (row, key)=>(key === 'tab'
        ? row.tabMemory?.totalMB ?? null : key === 'guest mapped' ? row.guestMappedMB ?? null
            : row.pageHeapMB ?? null), false)}
</body>`;
writeFileSync(`${out}.json`, JSON.stringify(rows));
writeFileSync(`${out}.html`, html);
console.log(summary.join('\n'));
console.log(`${out}.json, ${out}.html`);
