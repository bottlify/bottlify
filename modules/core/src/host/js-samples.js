/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The browser's own sampler of this thread's JavaScript (the JS Self-Profiling
 * API), kept running in windows: what the thread actually spent its time in,
 * function by function, whether or not anything marked it as a phase. The
 * phases a run is profiled by are the ones somebody thought of; a cost in
 * code nobody wrapped -- bookkeeping before a call, a loop between slices --
 * shows up only here.
 *
 * The API needs the document, or the worker's script, served with
 * `Document-Policy: js-profiling`; without it, or in a runtime that has no
 * sampler, the snapshot says so rather than answering with nothing.
 */

/**
 * @typedef {{ name: string, self: number, total: number }} SampledFunction
 * @typedef {{ measured: true, windowMs: number, samples: number,
 *     functions: SampledFunction[] }
 *     | { measured: false, reason: string }} JsSamples
 */

/**
 * Functions by self and total share of one sampler trace's samples.
 *
 * @param {{ samples: { stackId?: number }[], stacks: { frameId: number, parentId?: number }[],
 *     frames: { name: string, resourceId?: number, line?: number }[],
 *     resources: string[] }} trace
 * @param {number} top
 * @returns {{ samples: number, functions: SampledFunction[] }}
 */
export function summarise(trace, top){
    /** @param {number} frameId */
    const nameOf = frameId=>{
        const frame = trace.frames[frameId];
        const file = frame.resourceId === undefined ? ''
            : String(trace.resources[frame.resourceId] ?? '').split('/').pop();
        return `${frame.name || '(anonymous)'}${file ? ` ${file}:${frame.line ?? 0}` : ''}`;
    };
    /** @type {Map<string, { self: number, total: number }>} */
    const table = new Map();
    let counted = 0;
    for (const sample of trace.samples)
    {
        // A sample with no stack is the thread idle or outside JavaScript.
        if (sample.stackId === undefined)
        {
            continue;
        }
        counted++;
        /** @type {Set<string>} */
        const seen = new Set();
        for (let at = /** @type {number | undefined} */ (sample.stackId), leaf = true;
            at !== undefined; at = trace.stacks[at].parentId, leaf = false)
        {
            const name = nameOf(trace.stacks[at].frameId);
            const row = table.get(name) ?? { self: 0, total: 0 };
            if (leaf)
            {
                row.self++;
            }
            if (!seen.has(name))
            {
                seen.add(name);
                row.total++;
            }
            table.set(name, row);
        }
    }
    const functions = [...table].map(([name, row])=>({ name, self: row.self, total: row.total }))
        .sort((left, right)=>right.self - left.self || right.total - left.total)
        .slice(0, top);
    return { samples: counted, functions };
}

/**
 * @param {{ windowMs?: number, sampleIntervalMs?: number, top?: number,
 *     Profiler?: any, now?: () => number }} [options]
 * @returns {{ snapshot: () => JsSamples, stop: () => void }}
 */
export function createJsSampler(options = {}){
    const windowMs = options.windowMs ?? 2000;
    const sampleIntervalMs = options.sampleIntervalMs ?? 1;
    const top = options.top ?? 40;
    const now = options.now ?? (()=>performance.now());
    const Sampler = options.Profiler ?? /** @type {any} */ (globalThis).Profiler;
    /** @type {JsSamples} */
    let last = typeof Sampler === 'function'
        ? { measured: false, reason: 'the first window has not ended yet' }
        : { measured: false, reason: 'this runtime has no JS Self-Profiling API' };
    let stopped = typeof Sampler !== 'function';
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;

    const window = ()=>{
        if (stopped)
        {
            return;
        }
        /** @type {any} */
        let sampler;
        try
        {
            sampler = new Sampler({ sampleInterval: sampleIntervalMs,
                maxBufferSize: Math.ceil(windowMs / sampleIntervalMs) * 2 });
        }
        catch (e){
            // Refused: most often the policy header is missing.
            last = { measured: false, reason: `the sampler was refused: ${
                /** @type {any} */ (e)?.message ?? e}` };
            stopped = true;
            return;
        }
        const began = now();
        timer = setTimeout(()=>{
            sampler.stop().then((/** @type {any} */ trace)=>{
                last = { measured: true, windowMs: Math.round(now() - began),
                    ...summarise(trace, top) };
            }, (/** @type {any} */ e)=>{
                last = { measured: false, reason: `the sampler failed: ${e?.message ?? e}` };
            }).finally(window);
        }, windowMs);
    };
    window();

    return {
        snapshot: ()=>last,
        stop: ()=>{
            stopped = true;
            clearTimeout(timer);
        },
    };
}
