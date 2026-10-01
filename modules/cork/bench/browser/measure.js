/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One measured run of a benchmark workload: the engine made, the program run to
 * its exit, the guest instructions it retired over the wall time of the run.
 * No store of translations: a run starts as a bottle's first run does.
 *
 * @param {(options: any) => Promise<any>} createApp
 * @param {Uint8Array} executable
 * @param {{ engine?: string, cork?: object, v86?: object, commandLine?: string }} options
 */
export async function measureOnce(createApp, executable, options){
    const app = await createApp({
        executable,
        engine: options.engine ?? 'cork',
        exitNotice: false,
        ...options.v86 ? { v86: options.v86 } : {},
        cork: { config: { store: null, ...options.cork } },
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
    };
}
