/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

import { buildImage } from './internal/image.js';
import { synthesiseModule } from './internal/synth.js';

/**
 * loader — turning an executable file into something the guest can run.
 *
 * Parsing and layout happen in a host buffer (internal/image.js); this module
 * is what commits the result to guest memory and records the region it now
 * occupies, so the address space map knows about the image like anything else.
 *
 * Import resolution is a parameter rather than a dependency: what an import
 * binds to belongs to whoever assembles the process, and wiring it as a `requires`
 * edge would point the loader at win32, inverting the graph.
 */

/** @type {{ base: number, entryPoint: number, unresolved: string[] }[]} */
let loaded = [];

export const loaderModule = {
    name: 'loader',
    version: '0.1.0',
    requires: /** @type {readonly string[]} */ (['cpu', 'memory', 'log']),

    /**
     * @param {any} config
     * @param {import('../../system/contract.js').ScopedModuleHost} host
     * @returns {Promise<any>}
     */
    async create(config, host){
        const memory = host.requireApi('memory');

        return {
            /**
             * Maps an executable and binds its imports.
             *
             * @param {Uint8Array} file
             * @param {Object} options
             * @param {(dll: string, name: string | null, ordinal: number | null) => number | null}
             *     options.resolveImport
             * @param {number} [options.base]
             * @param {string} [options.name]  Region name, for diagnostics.
             * @returns {{ base: number, entryPoint: number, unresolved: string[] }}
             */
            load(file, { resolveImport, base, name = 'image' }){
                const image = buildImage(file, { resolveImport, base });

                memory.register({
                    name,
                    base: image.base,
                    size: image.bytes.length,
                    kind: memory.RegionKind.IMAGE,
                    // Phase 1 maps the image as one span with the widest access its
                    // sections ask for. Per-section permissions arrive when the
                    // loader stops being the only thing writing here.
                    access: memory.Access.READ_WRITE_EXECUTE,
                });
                memory.writeBytes(image.base, image.bytes);

                const record = {
                    base: image.base,
                    entryPoint: image.entryPoint,
                    unresolved: image.unresolved,
                };
                loaded.push(record);
                return record;
            },

            /**
             * Puts a system module into guest memory: a real PE image with a
             * real export directory whose exports jump to host stubs.
             *
             * Binding an import table covers only the calls a program makes
             * through its own IAT. A program that resolves a name at runtime,
             * walks an export directory itself, or copies the first bytes of an
             * exported function needs the module to be there -- and all three
             * are ordinary behaviour rather than exotic cases.
             *
             * @param {Object} options
             * @param {string} options.name    As an import descriptor names it.
             * @param {number} options.base
             * @param {{ name: string, target: number }[]} options.exports
             * @returns {{ base: number, size: number,
             *   addressOf: (name: string) => number | null,
             *   ordinalOf: (name: string) => number | null }}
             */
            synthesise({ name, base, exports }){
                const module = synthesiseModule({ name, base, exports });

                memory.register({
                    name,
                    base,
                    size: module.size,
                    kind: memory.RegionKind.IMAGE,
                    // Written once, at assembly, and executable from then on:
                    // the exports are jumps and the guest runs them.
                    access: memory.Access.READ_WRITE_EXECUTE,
                });
                memory.writeBytes(base, module.bytes);
                memory.protect(name, memory.Access.READ_EXECUTE);

                const record = { base, entryPoint: 0, unresolved: [], name };
                loaded.push(record);
                return {
                    base,
                    size: module.size,
                    addressOf: module.addressOf,
                    ordinalOf: module.ordinalOf,
                };
            },

            list: ()=>[...loaded],
        };
    },

    /** @returns {import('../../system/contract.js').ModuleDiagnostics} */
    diagnostics(){
        return {
            name: 'loader',
            version: '0.1.0',
            status: 'ready',
            metrics: {
                images: loaded.length,
                // An import nothing implements is not fatal at load time, so the
                // list is the only place it surfaces before the guest calls it.
                unresolved: loaded.flatMap(image=>image.unresolved),
            },
        };
    },

    async dispose(){
        loaded = [];
    },
};
