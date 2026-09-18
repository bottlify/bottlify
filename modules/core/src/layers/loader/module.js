/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { bindDelayImports } from './internal/delayload.js';
import { bindImports, buildImage, mapImage } from './internal/image.js';
import { synthesiseModule } from './internal/synth.js';
import { planHook } from './internal/hooks.js';

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
/** @type {{ bound: string[], refused: string[] }} */
let hookResults = { bound: [], refused: [] };

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
             * @param {(dll: string, name: string | null, ordinal: number | null) => number | null}
             *     [options.missing]  Where a call to an import nothing claims should land.
             * @param {string} [options.name]  Region name, for diagnostics.
             * @returns {{ base: number, entryPoint: number, unresolved: string[] }}
             */
            load(file, { resolveImport, base, missing, name = 'image' }){
                const image = buildImage(file, { resolveImport, base, missing });
                // Both tables. A delay-load slot left as the linker wrote it is
                // resolved by the program's own helper, which walks an export
                // directory by hand and refuses an address it does not believe;
                // what the program then sees is not a missing function but its
                // own data failing to open.
                image.unresolved.push(...bindDelayImports(image, resolveImport, missing));

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
             * Maps an image without binding a single import.
             *
             * The pair to `bind` below, and separate from it for one reason: a
             * set of libraries that import each other cannot be bound one at a
             * time, because binding the first needs the second's exports. Every
             * image is mapped, so every base is settled and every export
             * directory is readable, and only then is anything bound.
             *
             * @param {Uint8Array} file
             * @param {Object} options
             * @param {number} [options.base]
             * @param {string} [options.name]
             * @returns {any} the mapped image, to be handed back to `bind`
             */
            map(file, { base, name = 'image' }){
                const image = mapImage(file, base);

                memory.register({
                    name,
                    base: image.base,
                    size: image.bytes.length,
                    kind: memory.RegionKind.IMAGE,
                    access: memory.Access.READ_WRITE_EXECUTE,
                });
                memory.writeBytes(image.base, image.bytes);

                const record = { base: image.base, entryPoint: image.entryPoint,
                    unresolved: [], name };
                loaded.push(record);
                return { image, record, name };
            },

            /**
             * Writes resolved addresses into a mapped image's IAT, and puts the
             * result back into guest memory.
             *
             * @param {any} mapped  What `map` returned.
             * @param {(dll: string, name: string | null, ordinal: number | null) => number | null}
             *     resolveImport
             * @param {(dll: string, name: string | null, ordinal: number | null) => number | null}
             *     [missing]  Where a call to an import nothing claims should land.
             * @returns {string[]} what nothing claimed
             */
            bind(mapped, resolveImport, missing){
                const unresolved = bindImports(mapped.image, resolveImport, missing);
                // Written again because binding edited the mapped bytes in
                // place, and the guest reads guest memory, not our copy.
                memory.writeBytes(mapped.image.base, mapped.image.bytes);
                mapped.record.unresolved = unresolved;
                return unresolved;
            },

            /**
             * The same, for the delay-load directory.
             *
             * Separate from `bind` because most images have no delay-load
             * directory at all, and because the two answer to the same resolver
             * only by choice -- binding both up front is what makes a
             * delay-loaded name work here, since the program's own helper would
             * refuse an address outside the named library's image bounds.
             *
             * @param {any} mapped  What `map` returned.
             * @param {(dll: string, name: string | null, ordinal: number | null) => number | null}
             *     resolveImport
             * @param {(dll: string, name: string | null, ordinal: number | null) => number | null}
             *     [missing]  Where a call to an import nothing claims should land.
             * @returns {string[]} what nothing claimed
             */
            bindDelayed(mapped, resolveImport, missing){
                const unresolved = bindDelayImports(mapped.image, resolveImport, missing);
                memory.writeBytes(mapped.image.base, mapped.image.bytes);
                // Appended, not replaced: an image binds both directories, and
                // the record is the only place either is reported.
                mapped.record.unresolved = [...mapped.record.unresolved, ...unresolved];
                return unresolved;
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
             * @param {string} [options.entryPoint]  The export that is its DllMain.
             * @returns {{ base: number, size: number, entryPoint: number,
             *   addressOf: (name: string) => number | null,
             *   ordinalOf: (name: string) => number | null }}
             */
            synthesise({ name, base, exports, entryPoint }){
                const module = synthesiseModule({ name, base, exports, entryPoint });

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

                const entryAddress = module.entryPointRva === 0 ? 0 : base + module.entryPointRva;
                const record = { base, entryPoint: entryAddress, unresolved: [], name };
                loaded.push(record);
                return {
                    base,
                    size: module.size,
                    entryPoint: entryAddress,
                    addressOf: module.addressOf,
                    ordinalOf: module.ordinalOf,
                };
            },

            list: ()=>[...loaded],

            /**
             * Binds a bundle's sidecar hooks against an image already placed
             * here. The engine names nothing about a title in this function:
             * `spec` carries the image name, the RVAs and the kernel name from
             * the sidecar, `image` is what was actually loaded, and what a
             * kernel does is entirely `register`'s caller's business -- this
             * only validates the sidecar against reality, writes the slot,
             * and reports which entries it could not trust.
             *
             * @param {{ hooks: import('./internal/hooks.js').HookEntry[] }} spec
             * @param {import('./internal/hooks.js').LoadedImage} image
             * @param {(options: { name: string, argBytes: number, target: number,
             *     handler: Function }) => number} register
             *     Bound to the bridge by whoever assembles the process; this
             *     layer has no bridge of its own to call. Answers the stub's
             *     guest address, as `bridge.hook` does -- or 0 for none.
             * @param {(entry: import('./internal/hooks.js').HookEntry) =>
             *     Function | null} resolveHandler
             *     What a hook actually does, keyed off the sidecar's own
             *     entry -- typically a lookup into the bundle's `hooks.mjs`.
             * @returns {{ bound: string[], refused: string[] }}
             */
            bindHooks(spec, image, register, resolveHandler){
                /** @type {string[]} */
                const bound = [];
                /** @type {string[]} */
                const refused = [];
                for (const entry of spec.hooks ?? [])
                {
                    if (entry.image.toLowerCase() !== image.name.toLowerCase())
                    {
                        continue; // Not for this image; nothing to say about it here.
                    }
                    const slotAddress = (image.base + Number(entry.slot.rva)) >>> 0;
                    const plan = planHook(entry, image, memory.readU32(slotAddress));
                    if (!plan.ok)
                    {
                        refused.push(plan.reason);
                        continue;
                    }
                    const handler = resolveHandler(entry);
                    if (!handler)
                    {
                        refused.push(`${entry.kernel}: no kernel provides it`);
                        continue;
                    }
                    const address = register({
                        name: entry.kernel, argBytes: plan.argBytes,
                        target: plan.targetAddress, handler,
                    });
                    // The slot write is the one thing here a guest cannot
                    // recover from: a word that is not a stub's address sends
                    // every caller of the function into it. Nothing but a
                    // real address goes in.
                    if (!Number.isInteger(address) || address === 0)
                    {
                        refused.push(`${entry.kernel}: no stub address was registered`);
                        continue;
                    }
                    memory.writeU32(plan.slotAddress, address);
                    bound.push(entry.kernel);
                }
                hookResults = { bound, refused };
                return { bound, refused };
            },
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
                hooksBound: hookResults.bound,
                hooksRefused: hookResults.refused,
            },
        };
    },

    async dispose(){
        loaded = [];
        hookResults = { bound: [], refused: [] };
    },
};
