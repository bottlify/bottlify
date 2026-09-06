/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

/**
 * ScopedModuleHost factory: builds a module's view of the system.
 *
 * Guarantees:
 *  - `requireApi(name)` is allowed only for names listed in the module's `requires`;
 *  - `provide` is allowed only for the module's own name;
 *  - requesting an interface that has not been created yet is an error
 *    (creation order or dependency cycle).
 *
 * All modules share one API registry (`apis`) — but there are no singletons:
 * every module receives its own scoped view.
 */

/**
 * @typedef {Map<string, import("./contract.js").ModuleApi>} ApiRegistry
 */

/**
 * @param {string} owner       Owner (module) name.
 * @param {ReadonlySet<string>} allowedNames  `requires` plus the owner's own name.
 * @param {ApiRegistry} apis   Shared registry of already-created APIs.
 * @returns {import("./contract.js").ScopedModuleHost}
 */
export function makeScopedHost(owner, allowedNames, apis) {
    return {
        requireApi(name) {
            if (!allowedNames.has(name)) {
                throw new Error(`Module "${owner}" did not declare dependency on "${name}"`);
            }
            const api = apis.get(name);
            if (api === undefined) {
                throw new Error(`Interface "${name}" is not created yet for module "${owner}" (order or dependency cycle)`);
            }
            return api;
        },
        provide(name, api) {
            if (name !== owner) {
                throw new Error(`Module "${owner}" cannot register foreign interface "${name}"`);
            }
            apis.set(name, api);
        },
    };
}