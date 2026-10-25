/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Keeps JavaScriptCore collecting a thread's young garbage while it holds the
 * guest's memory.
 *
 * JavaScriptCore lets a heap grow to about twice what it held after its last
 * full collection before it collects again, and what a thread holds includes
 * every buffer it can reach -- the guest's memory twice over where the thread
 * holds both the WebAssembly.Memory and a view of it. The engine's thread
 * then piles up a gigabyte of short-lived objects before its first collection
 * after the start: in WebKit 26 (Playwright 1.63, Linux) the Quake III Arena
 * demo with 512 MB of guest memory stood at 1.48-1.58 GB at its peak, and a
 * phone's browser kills the page well before that. Every buffer made counts
 * as that much allocated, so one made and dropped, never touched and never
 * resident, brings the next collection forward; made every 50 ms, the same
 * start peaked at 1.29-1.38 GB, and held 0.96-1.00 GB instead of 1.06-1.44
 * after it, with as many frames (three runs each).
 *
 * The graphics worker, which throws away most of what it makes for a frame,
 * is nudged too (`nudgeWhenAsked`): the same start stood at 0.92-0.98 GB
 * after its load instead of 0.94-1.09 GB (six runs against nine). The
 * translation worker is not: nudged, it collected ten times as often and the
 * process held what it held before.
 *
 * V8 sizes its young generation by what it allocates, not by what a thread
 * holds, and gains nothing from it; by default only JavaScriptCore is nudged.
 */

/** What is made and how often, by default where it is made at all: `bytes` for
 * 512 MB of guest memory and less, an eighth of the memory past that. */
export const GC_NUDGE = Object.freeze({ everyMs: 50, bytes: 64 * 1024 * 1024 });

/**
 * Whether this thread runs on JavaScriptCore, by its agent string: WebKit's,
 * and none of the browsers that name Chrome (Blink's, which carry
 * "AppleWebKit" too). Chrome and the others on iOS run WebKit and name
 * themselves otherwise (CriOS, EdgiOS, FxiOS).
 *
 * @param {string} [agent]
 */
export function runsJavaScriptCore(agent = globalThis.navigator?.userAgent ?? ''){
    return /AppleWebKit\//.test(agent) && !/(Chrome|Chromium|Edg|OPR)\//.test(agent);
}

/**
 * The nudge a run asked for: `false` for none, an object for its own, and
 * otherwise the default where JavaScriptCore runs. JavaScriptCore lets a heap
 * take in garbage in proportion to what it holds, the guest's memory twice
 * over included, so the default buffer grows with the memory: with 2 GB of
 * guest memory a 64 MB one every 50 ms left the Doom 3 demo's engine thread
 * 7.5 s of its load without a collection.
 *
 * @param {{ everyMs?: number, bytes?: number } | boolean | undefined} asked
 * @param {string} [agent]
 * @param {number} [memoryBytes]  the guest's memory
 * @returns {{ everyMs: number, bytes: number } | null}
 */
export function gcNudgeOf(asked, agent, memoryBytes = 0){
    if (asked === false || (asked === undefined && !runsJavaScriptCore(agent)))
    {
        return null;
    }
    const own = typeof asked === 'object' && asked !== null ? asked : {};
    return { everyMs: own.everyMs ?? GC_NUDGE.everyMs,
        bytes: own.bytes ?? Math.max(GC_NUDGE.bytes, Math.ceil(memoryBytes / 8 / 65536) * 65536) };
}

/**
 * Makes and drops a buffer of `bytes` every `everyMs` until stopped, by a timer
 * and by `poke`: a thread that runs the guest for seconds without coming back
 * to its event loop, as the engine's does through a load, fires no timer, and
 * pokes from its own loop instead.
 *
 * @param {{ everyMs: number, bytes: number }} nudge
 * @param {{ every?: (run: () => void, ms: number) => any, cancel?: (timer: any) => void,
 *     now?: () => number }} [clock]
 */
export function startGcNudge(nudge, clock = {}){
    const every = clock.every ?? ((run, ms)=>setInterval(run, ms));
    const cancel = clock.cancel ?? (timer=>clearInterval(timer));
    const now = clock.now ?? (()=>performance.now());
    let made = 0;
    let last = now();
    const make = ()=>{
        // Neither kept nor written: its pages are never touched.
        new ArrayBuffer(nudge.bytes);
        made++;
        last = now();
    };
    const timer = every(make, nudge.everyMs);
    return {
        stop: ()=>cancel(timer),
        /** One buffer now if a period has passed since the last. */
        poke(){
            if (now() - last >= nudge.everyMs)
            {
                make();
            }
        },
        /** The buffers made so far. */
        made: ()=>made,
    };
}

/**
 * A worker's own nudge, started by the first message to it that carries one
 * (`gcNudge`, as `gcNudgeOf` settled it where the run was set up): a worker
 * opened by the engine knows nothing of the run's settings until told.
 *
 * @param {{ addEventListener: (type: 'message',
 *     listener: (event: { data: any }) => void) => void }} scope
 * @param {Parameters<typeof startGcNudge>[1]} [clock]
 */
export function nudgeWhenAsked(scope, clock){
    /** @type {ReturnType<typeof startGcNudge> | null} */
    let nudge = null;
    scope.addEventListener('message', ({ data })=>{
        if (nudge === null && data?.gcNudge)
        {
            nudge = startGcNudge(data.gcNudge, clock);
        }
    });
    return {
        /** The buffers made so far: none before a message asked. */
        made: ()=>nudge?.made() ?? 0,
    };
}
