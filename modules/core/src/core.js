/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { makeScopedHost } from './system/host.js';
import { ModuleRegistry } from './system/registry.js';
import { defaultModules } from './layers/index.js';

/**
 * Assembles the engine's module graph from a configuration.
 *
 * This is internal machinery, not the package's product API: it decides which
 * layers exist in this build and in what order they come up. What a consumer
 * eventually holds is an application controller built on top of this — run,
 * pause, attach a log sink — and that surface lands with the delivery phase.
 *
 * @param {Record<string, unknown>} [config] Map `module name → boolean | object`. See system/config.js.
 * @returns {Promise<import("./system/contract.js").CoreInstance>}
 */
export async function assembleModules(config = {}){
    const registry = new ModuleRegistry(defaultModules());
    const plan = registry.resolve(config);

    /** @type {Map<string, import("./system/contract.js").ModuleApi>} */
    const apis = new Map();

    for (const entry of plan){
        const allowedNames = new Set([entry.name, ...entry.module.requires]);
        const host = makeScopedHost(entry.name, allowedNames, apis);
        const api = await entry.module.create(entry.config, host);
        host.provide(entry.name, api);
    }

    /** @type {import("./system/contract.js").CoreInstance} */
    return {
        modules: plan.map(entry=>entry.module),
        api(name){
            const api = apis.get(name);
            if (api === undefined){
                throw new Error(`Module "${name}" is not part of this build`);
            }
            return api;
        },
        diagnostics(){
            return plan.map(entry=>entry.module.diagnostics());
        },
        async dispose(){
            for (const entry of [...plan].reverse()){
                await entry.module.dispose();
            }
        },
    };
}
