/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The browser's own sampling profiler, pointed at the threads the engine
 * runs on, and its profile folded into what a person reads: self time by
 * function and by file.
 *
 * Two things are here because two scenarios need them. The launcher scenario
 * samples the page's thread; the game harness runs the engine in a worker
 * (as the launcher does) and has to catch that worker as it is created,
 * which the browser does through auto-attach: the page's session is told to
 * attach every worker it spawns, paused at its first instruction, and each
 * one is given a profiler before it is let go. A worker's own workers (the
 * translator's) are attached the same way from the worker's session.
 *
 * A translated region is one wasm function named by its address (`r004ea329`,
 * see the translator's `emit-built.js`), so a fold by function name says which
 * regions the time went to; the frames of the interpreter, the runtime and the
 * host's layers are ordinary functions of their files.
 */

/**
 * Folds a CPU profile into the functions the thread spent its time in, by
 * self time, and into the files they live in. A wasm frame is keyed by its
 * function name alone under the file `wasm`, so thousands of one-function
 * modules fold by region rather than by module.
 *
 * @param {any} profile  Profiler's Profile.
 * @param {number} windowMs
 * @param {number} [keep]  rows per table
 */
export function summarise(profile, windowMs, keep = 40){
    /** @type {Map<number, any>} */
    const nodes = new Map(profile.nodes.map((/** @type {any} */ node)=>[node.id, node]));
    /** @type {Map<number, number>} */
    const selfMicros = new Map();
    const samples = profile.samples ?? [];
    const deltas = profile.timeDeltas ?? [];
    for (let index = 0; index < samples.length; index++)
    {
        const id = samples[index];
        selfMicros.set(id, (selfMicros.get(id) ?? 0) + (deltas[index] ?? 0));
    }
    /** @type {Map<string, number>} */
    const byFunction = new Map();
    /** @type {Map<string, number>} */
    const byFile = new Map();
    let total = 0;
    for (const [id, micros] of selfMicros)
    {
        const node = nodes.get(id);
        const frame = node?.callFrame ?? {};
        const url = String(frame.url ?? '');
        const wasm = url.startsWith('wasm://');
        const file = wasm
            ? 'wasm'
            : url.split('/').pop() || `(${frame.functionName || 'program'})`;
        const line = (frame.lineNumber ?? -1) + 1;
        const name = wasm
            ? `${frame.functionName || 'wasm-function'} wasm`
            : `${frame.functionName || '(anonymous)'} ${file}:${line}`;
        byFunction.set(name, (byFunction.get(name) ?? 0) + micros);
        byFile.set(file, (byFile.get(file) ?? 0) + micros);
        total += micros;
    }
    const rows = (/** @type {Map<string, number>} */ map, /** @type {number} */ count)=>
        [...map].sort((left, right)=>right[1] - left[1]).slice(0, count)
            .map(([name, micros])=>({ name, ms: micros / 1000, share: micros / Math.max(1, total) }));
    return {
        sampledMs: total / 1000,
        busyShare: total / 1000 / windowMs,
        functions: rows(byFunction, keep),
        files: rows(byFile, 16),
    };
}

/**
 * Profiles every worker a page creates from now on (and the workers those
 * create), each caught at its first instruction. `stop` answers one profile
 * per worker that was still alive, labelled by its script URL.
 *
 * @param {import('./cdp.mjs').CdpEndpoint} cdp
 * @param {string} pageSessionId
 * @param {{ intervalMicros?: number }} [options]
 */
export async function profileWorkers(cdp, pageSessionId, options = {}){
    const interval = options.intervalMicros ?? 500;
    /** @type {Map<string, { url: string }>} */
    const sessions = new Map();
    const attach = (/** @type {string} */ sessionId)=>cdp.send('Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
    cdp.on('Target.attachedToTarget', async params=>{
        const info = params.targetInfo ?? {};
        const worker = params.sessionId;
        if (info.type !== 'worker' || typeof worker !== 'string')
        {
            return;
        }
        sessions.set(worker, { url: String(info.url ?? '') });
        try
        {
            await attach(worker);
            await cdp.send('Profiler.enable', {}, worker);
            await cdp.send('Profiler.setSamplingInterval', { interval }, worker);
            await cdp.send('Profiler.start', {}, worker);
        }
        catch {
            // A worker that went away between the two: nothing to profile.
        }
        finally
        {
            await cdp.send('Runtime.runIfWaitingForDebugger', {}, worker).catch(()=>{});
        }
    });
    cdp.on('Target.detachedFromTarget', params=>{
        sessions.delete(String(params.sessionId));
    });
    // A cross-origin-isolated page (`--coi`) is moved to a process of its own
    // as it loads, and the page session answers "Internal error" meanwhile:
    // ask again once it has settled.
    for (let attempt = 0; ; attempt++)
    {
        try
        {
            await attach(pageSessionId);
            break;
        }
        catch (e){
            if (attempt >= 20)
            {
                throw e;
            }
            await new Promise(done=>setTimeout(done, 250));
        }
    }
    return {
        /** Drops what every profiler has so far and starts it again: the window
         * then begins here, past a loading phase. */
        async restart(){
            for (const worker of sessions.keys())
            {
                await cdp.send('Profiler.stop', {}, worker).catch(()=>{});
                await cdp.send('Profiler.start', {}, worker).catch(()=>{});
            }
        },
        /** @returns {Promise<{ url: string, profile: any }[]>} */
        async stop(){
            const out = [];
            for (const [worker, { url }] of sessions)
            {
                try
                {
                    const { profile } = await cdp.send('Profiler.stop', {}, worker);
                    out.push({ url, profile });
                }
                catch {
                    // Gone, or never started.
                }
            }
            sessions.clear();
            return out;
        },
    };
}

/**
 * The lines a report prints for one profiled thread.
 *
 * @param {string} label
 * @param {ReturnType<typeof summarise>} summary
 * @param {number} windowMs
 * @returns {string[]}
 */
export function describeProfile(label, summary, windowMs){
    const lines = [];
    lines.push(`  cpu profile of ${label}: busy ${(summary.busyShare * 100).toFixed(0)}%`
        + ` of ${windowMs.toFixed(0)} ms (${summary.sampledMs.toFixed(0)} ms sampled)`);
    lines.push('  by file:');
    for (const row of summary.files)
    {
        lines.push(`    ${(row.share * 100).toFixed(1).padStart(5)}%`
            + `  ${row.ms.toFixed(0).padStart(7)} ms  ${row.name}`);
    }
    lines.push('  by function, self time:');
    for (const row of summary.functions)
    {
        lines.push(`    ${(row.share * 100).toFixed(1).padStart(5)}%`
            + `  ${row.ms.toFixed(0).padStart(7)} ms  ${row.name}`);
    }
    return lines;
}
