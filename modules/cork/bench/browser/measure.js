/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One measured run of a benchmark workload: the engine made, the program run to
 * its exit, the guest instructions it retired over the wall time of the run.
 * No store of translations unless asked: a run starts as a bottle's first run
 * does. `store: 'local'` keeps the product's own, so a second run in the same
 * browser profile starts as a bottle's next run does.
 *
 * @param {(options: any) => Promise<any>} createApp
 * @param {Uint8Array} executable
 * @param {{ cork?: object, commandLine?: string, store?: 'local', report?: boolean }} options
 */
export async function measureOnce(createApp, executable, options){
    const app = await createApp({
        executable,
        exitNotice: false,
        cork: { config: { ...options.store === 'local' ? {} : { store: null }, ...options.cork } },
        ...options.commandLine ? { commandLine: options.commandLine } : {},
    });
    let code = null;
    let error = null;
    const started = performance.now();
    try
    {
        code = await app.run({ timeoutMs: 600_000, maxTurns: Number.MAX_SAFE_INTEGER });
    }
    catch (e){
        error = String(/** @type {any} */ (e)?.stack ?? e);
    }
    const ms = performance.now() - started;
    const cpu = app.diagnostics().find((/** @type {any} */ layer)=>layer.name === 'cpu')?.metrics
        ?? {};
    await app.dispose();
    const instructions = Number(cpu.instructions ?? 0);
    return {
        code: code === null ? null : code >>> 0,
        error,
        ms,
        instructions,
        mips: instructions / ms / 1000,
        translatedShare: cpu.cork?.translatedShare ?? null,
        regions: cpu.cork?.regions ?? null,
        // Only from a bundle built with the instruments and a run asking for `timings`.
        timings: Object.fromEntries(Object.entries(cpu.cork ?? {})
            .filter(([key, value])=>key.endsWith('Ms') && value > 0)),
        // The engine thread's long holds and the regions the store answered, from
        // the same bundles and runs.
        stalls: cpu.cork?.stalls ?? null,
        cacheHits: cpu.cork?.cacheHits ?? null,
        // The translator's whole report, when a run asks for it.
        ...options.report === true ? { cork: cpu.cork ?? null } : {},
    };
}
