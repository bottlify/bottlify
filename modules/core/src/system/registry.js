/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { normalizeConfig } from './config.js';
import { createStubModule } from './stub.js';

/**
 * Build plan: one entry is what to create and with which configuration.
 *
 * @typedef {Object} PlanEntry
 * @property {string} name
 * @property {import("./contract.js").BottlifyModule} module
 * @property {import("./contract.js").ModuleConfig | null} config
 */

/**
 * Registry of module definitions and their resolution into a concrete build plan.
 *
 * Resolution rules:
 *  - a disabled module (false/null) is excluded from the build UNLESS an enabled
 *    module requires it: then it is installed as a stub so the interface is bound;
 *  - creation order is a topological sort over `requires` (cycles rejected);
 *  - an unknown name in `requires` or in the configuration is an error.
 */
export class ModuleRegistry {
    /** @type {Map<string, import("./contract.js").BottlifyModule>} */
    #definitions = new Map();

    /**
     * @param {readonly import("./contract.js").BottlifyModule[]} definitions
     */
    constructor(definitions){
        for (const module of definitions){
            if (this.#definitions.has(module.name)){
                throw new Error(`Duplicate module definition: "${module.name}"`);
            }
            this.#definitions.set(module.name, module);
        }
        this.#assertRequiresKnown();
    }

    /** Every name in `requires` must exist among the definitions. */
    #assertRequiresKnown(){
        for (const module of this.#definitions.values()){
            for (const required of module.requires){
                if (!this.#definitions.has(required)){
                    throw new Error(`Module "${module.name}" requires unknown interface "${required}"`);
                }
            }
        }
    }

    /**
     * Resolves a configuration into an ordered creation plan.
     *
     * @param {Record<string, unknown> | undefined} [desired]
     * @returns {PlanEntry[]}
     */
    resolve(desired = {}){
        const selection = normalizeConfig(desired, [...this.#definitions.keys()]);

        // Closure over active names: everything declared in `requires` of an enabled
        // module must be present (disabled ones become stubs in that case).
        const active = new Set();
        const activate = (/** @type {string} */ name)=>{
            if (active.has(name)) return;
            active.add(name);
            const definition = this.#definitions.get(name);
            if (!definition) throw new Error(`Unknown module "${name}"`);
            for (const required of definition.requires) activate(required);
        };
        for (const [name, toggle] of selection){
            if (toggle.enabled) activate(name);
        }

        const order = this.#topoOrder(active);
        /** @type {PlanEntry[]} */
        const plan = [];
        for (const name of order){
            const toggle = selection.get(name);
            if (!toggle) throw new Error(`Unresolved toggle for "${name}"`);
            const definition = this.#definitions.get(name);
            if (!definition) throw new Error(`Unknown module "${name}"`);
            const module = toggle.enabled ? definition : createStubModule(name, definition.version, []);
            plan.push({ name, module, config: toggle.enabled ? toggle.config : null });
        }
        return plan;
    }

    /**
     * Topological sort over `requires` with cycle detection.
     *
     * @param {Set<string>} names
     * @returns {string[]}
     */
    #topoOrder(names){
        /** @type {Map<string, 0 | 1>} 0 = visiting, 1 = done. */
        const state = new Map();
        /** @type {string[]} */
        const out = [];
        const visit = (/** @type {string} */ name)=>{
            const seen = state.get(name);
            if (seen === 1) return;
            if (seen === 0){
                throw new Error(`Dependency cycle involving module "${name}"`);
            }
            state.set(name, 0);
            const definition = this.#definitions.get(name);
            if (!definition) throw new Error(`Unknown module "${name}"`);
            for (const required of definition.requires) visit(required);
            state.set(name, 1);
            out.push(name);
        };
        for (const name of names) visit(name);
        return out;
    }
}
