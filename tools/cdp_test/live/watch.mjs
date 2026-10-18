/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A recorder left running beside a person playing, so that when they say
 * "there" the seconds before are already written down -- rather than a
 * capture started after the moment has passed. Nothing is paused or driven.
 *
 *   node tools/cdp_test/live/watch.mjs [file=dbg/watch.jsonl]      record until stopped
 *   node tools/cdp_test/live/watch.mjs --last SECONDS [file]        read the last seconds back
 *
 * Every second a line with the frames presented since the last (their
 * milliseconds and host/guest split); every two, for each process of the run,
 * the host calls made since (count and host ms by function), the guest code
 * that grew (the cpu sampler's address buckets) and GDI's blits by path. The
 * reader folds the window into the frame times, the costliest calls, the
 * hottest guest addresses, and the slowest frames with what ran before them.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { connect } from './connect.mjs';

const args = process.argv.slice(2);
const lastAt = args.indexOf('--last');
const file = args.find((arg, at)=>!arg.startsWith('--') && at !== lastAt + 1) ?? 'dbg/watch.jsonl';

if (lastAt >= 0)
{
    const seconds = Number(args[lastAt + 1] ?? 10);
    const lines = readFileSync(file, 'utf8').trim().split('\n').map(line=>JSON.parse(line));
    const until = lines.at(-1)?.at ?? Date.now();
    const window = lines.filter(line=>line.at >= until - seconds * 1000);
    const frames = window.flatMap(line=>line.frames ?? []);
    const sorted = frames.map(frame=>frame.ms).sort((a, b)=>a - b);
    console.log(`last ${seconds} s: ${frames.length} frames,`
        + ` median ${sorted[sorted.length >> 1]?.toFixed(1)} ms,`
        + ` worst ${sorted.at(-1)?.toFixed(0)} ms`);
    /** @type {Map<string, [number, number]>} */
    const calls = new Map();
    /** @type {Map<string, number>} */
    const code = new Map();
    /** @type {Record<string, number>} */
    const why = {};
    for (const line of window)
    {
        for (const process of line.processes ?? [])
        {
            for (const [name, count, ms] of process.calls)
            {
                const was = calls.get(name) ?? [0, 0];
                calls.set(name, [was[0] + count, was[1] + ms]);
            }
            for (const [address, count] of process.code)
            {
                code.set(address, (code.get(address) ?? 0) + count);
            }
            for (const [reason, count] of Object.entries(process.blits ?? {}))
            {
                why[reason] = (why[reason] ?? 0) + count;
            }
        }
    }
    console.log('host calls (ms, count):');
    for (const [name, [count, ms]] of [...calls].sort((a, b)=>b[1][1] - a[1][1]).slice(0, 12))
    {
        console.log(`  ${String(ms).padStart(6)} ${String(count).padStart(9)}  ${name}`);
    }
    const codeTotal = [...code.values()].reduce((sum, count)=>sum + count, 0);
    console.log('guest code:');
    for (const [address, count] of [...code].sort((a, b)=>b[1] - a[1]).slice(0, 8))
    {
        console.log(`  ${(count / codeTotal * 100).toFixed(1).padStart(5)}%  ${address}`);
    }
    if (Object.keys(why).length > 0)
    {
        console.log('blits a pixel at a time:', JSON.stringify(why));
    }
    console.log('slowest frames:');
    for (const frame of [...frames].sort((a, b)=>b.ms - a.ms).slice(0, 5))
    {
        console.log(`  ${frame.ms.toFixed(0)} ms (host ${frame.host}, guest ${frame.guest})`
            + ` at ${new Date(frame.at).toLocaleTimeString()}`);
    }
    process.exit(0);
}

const page = await connect();
const evaluate = async(/** @type {string} */ body)=>JSON.parse(await page.evaluate(
    `(async()=>{ const app = window.__bottlify__?.app; if (!app) return 'null'; ${body} })()`));
let lastFrame = -1;
/** @type {Map<string, Map<string, [number, number]>>} */
const callsWas = new Map();
/** @type {Map<string, Map<string, number>>} */
const codeWas = new Map();
/** @type {Map<string, Record<string, number>>} */
const blitsWas = new Map();
console.log(`recording to ${file}; stop with Ctrl+C`);
for (let tick = 0; ; tick++)
{
    await new Promise(done=>setTimeout(done, 1000));
    /** @type {any} */
    const line = { at: Date.now() };
    try
    {
        const frames = await evaluate(`const fr = await app.log.frames(200);
            return JSON.stringify(fr.map(x=>({ index: x.index, ms: x.ms, at: x.startedAt,
                host: Math.round(x.byKind?.host ?? 0),
                guest: Math.round(x.byKind?.guest ?? 0) })));`);
        // A new run counts its frames from zero again.
        const newest = Math.max(-1, ...(frames ?? []).map((/** @type {any} */ frame)=>frame.index));
        if (newest < lastFrame)
        {
            lastFrame = -1;
        }
        line.frames = (frames ?? []).filter((/** @type {any} */ frame)=>frame.index > lastFrame)
            .map((/** @type {any} */ frame)=>({ ...frame, at: performance.timeOrigin + frame.at }));
        lastFrame = Math.max(lastFrame, newest);
        if (tick % 2 === 0)
        {
            const processes = await evaluate(`const list = (await app.debug?.processes?.())
                    ?? [{ id: 'run' }];
                const out = [];
                for (const one of list)
                {
                    const d = one.id === 'run' ? await app.diagnostics()
                        : await app.debug.diagnosticsOf(one.id);
                    const of = name=>d?.find?.(x=>x.name === name)?.metrics ?? {};
                    out.push({ id: one.id, image: one.image ?? '',
                        calls: (of('bridge').byFunction ?? []).map(x=>{
                            const m = /^(\\S+) (\\d+) (\\d+)ms/.exec(String(x));
                            return m ? [m[1], Number(m[2]), Number(m[3])] : null; })
                            .filter(Boolean),
                        code: (of('cpu').samples?.top ?? []).map(b=>['0x' + b.address.toString(16),
                            b.instructions]),
                        blits: of('graphics').blits?.why ?? {} });
                }
                return JSON.stringify(out);`);
            line.processes = (processes ?? []).map((/** @type {any} */ one)=>{
                const key = String(one.id);
                const calls = new Map(one.calls.map((/** @type {any[]} */ [name, count, ms])=>
                    [name, [count, ms]]));
                const code = new Map(one.code);
                const before = callsWas.get(key) ?? new Map();
                const codeBefore = codeWas.get(key) ?? new Map();
                const blitsBefore = blitsWas.get(key) ?? {};
                callsWas.set(key, calls);
                codeWas.set(key, code);
                blitsWas.set(key, one.blits);
                return {
                    id: one.id,
                    image: one.image,
                    calls: [...calls].map(([name, [count, ms]])=>[name,
                        count - (before.get(name)?.[0] ?? 0), ms - (before.get(name)?.[1] ?? 0)])
                        .filter(([, count])=>count > 0),
                    code: [...code].map(([address, count])=>[address,
                        count - (codeBefore.get(address) ?? 0)]).filter(([, count])=>count > 0),
                    blits: Object.fromEntries(Object.entries(one.blits)
                        .map(([reason, count])=>[reason, count - (blitsBefore[reason] ?? 0)])
                        .filter(([, count])=>count > 0)),
                };
            });
        }
    }
    catch (e){
        line.error = e instanceof Error ? e.message : String(e);
    }
    appendFileSync(file, `${JSON.stringify(line)}\n`);
}
