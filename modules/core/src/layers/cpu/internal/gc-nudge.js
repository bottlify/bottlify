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
 * V8 sizes its young generation by what it allocates, not by what a thread
 * holds, and gains nothing from it; by default only JavaScriptCore is nudged.
 */

/** What is made and how often, by default where it is made at all. */
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
 * otherwise the default where JavaScriptCore runs.
 *
 * @param {{ everyMs?: number, bytes?: number } | boolean | undefined} asked
 * @param {string} [agent]
 * @returns {{ everyMs: number, bytes: number } | null}
 */
export function gcNudgeOf(asked, agent){
    if (asked === false || (asked === undefined && !runsJavaScriptCore(agent)))
    {
        return null;
    }
    const own = typeof asked === 'object' && asked !== null ? asked : {};
    return { everyMs: own.everyMs ?? GC_NUDGE.everyMs, bytes: own.bytes ?? GC_NUDGE.bytes };
}

/**
 * Makes and drops a buffer of `bytes` every `everyMs` until stopped.
 *
 * @param {{ everyMs: number, bytes: number }} nudge
 * @param {{ every?: (run: () => void, ms: number) => any, cancel?: (timer: any) => void }} [clock]
 */
export function startGcNudge(nudge, clock = {}){
    const every = clock.every ?? ((run, ms)=>setInterval(run, ms));
    const cancel = clock.cancel ?? (timer=>clearInterval(timer));
    let made = 0;
    const timer = every(()=>{
        // Neither kept nor written: its pages are never touched.
        new ArrayBuffer(nudge.bytes);
        made++;
    }, nudge.everyMs);
    return {
        stop: ()=>cancel(timer),
        /** The buffers made so far. */
        made: ()=>made,
    };
}
