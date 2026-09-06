/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

/**
 * Contract of the Bottlify module system.
 *
 * The single place where the shapes of a module, a host, and diagnostics are
 * defined. This file contains only JSDoc types — it exports nothing at runtime.
 */

/**
 * Module's answer to a diagnostics request.
 *
 * @typedef {Object} ModuleDiagnostics
 * @property {string} name       Module name.
 * @property {string} version    Module version.
 * @property {"created"|"ready"|"stub"|"disposed"} status Current module state.
 * @property {Object<string, any>} [metrics] Arbitrary module metrics.
 * @property {string[]} [issues] Detected problems; empty means all good.
 */

/**
 * Public API of a module. An arbitrary record of callable members that other
 * modules are allowed to call (through `requireApi`).
 *
 * @typedef {Record<string, any>} ModuleApi
 */

/**
 * Module configuration. Serializable data, validated by the module in `create`.
 *
 * @typedef {Object} ModuleConfig
 */

/**
 * Module definition registered in the registry.
 *
 * @typedef {Object} BottlifyModule
 * @property {string} name                  Unique module name within the package.
 * @property {string} version               Module version.
 * @property {readonly string[]} requires   Interfaces the module consumes
 *                                          (interfaces only, never implementations).
 * @property {(config: ModuleConfig | null, host: ScopedModuleHost) => Promise<ModuleApi>} create
 * @property {() => ModuleDiagnostics} diagnostics  Required (master plan §7.3).
 * @property {() => Promise<void>} dispose          Resource release.
 */

/**
 * The view a module has on the system: only interfaces from its own `requires`
 * plus its own provision. Shared singletons between modules are forbidden.
 *
 * @typedef {Object} ScopedModuleHost
 * @property {(name: string) => ModuleApi} requireApi  Get the API of a required module.
 * @property {(name: string, api: ModuleApi) => void} provide  Register own API.
 */

/**
 * A built instance of @bottlify/core.
 *
 * @typedef {Object} CoreInstance
 * @property {BottlifyModule[]} modules  Modules included in the build (creation order).
 * @property {(name: string) => ModuleApi} api  Public API of a module by name.
 * @property {() => ModuleDiagnostics[]} diagnostics  Diagnostics of all modules.
 * @property {() => Promise<void>} dispose  Stop all modules in reverse order.
 */

// Intentionally no runtime exports: types are used through JSDoc-import.