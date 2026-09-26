/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { bindDelayImports } from './internal/delayload.js';
import { bindImports, buildImage, mapImage } from './internal/image.js';
import { synthesiseModule } from './internal/synth.js';
import { jumpBytes, parseHexBytes, planHook, planSiteHook } from './internal/hooks.js';

/**
 * The slice of the `memory` api a bind needs: typed guest access plus the
 * region map, the same surface `layers/memory/module.js` hands every other
 * layer.
 *
 * @typedef {Object} LoaderMemory
 * @property {(address: number, length: number) => Uint8Array} readBytes
 * @property {(address: number, bytes: Uint8Array) => void} writeBytes
 * @property {(address: number) => number} readU32
 * @property {(address: number, value: number) => void} writeU32
 * @property {(address: number) => { name: string, access: string } | undefined} find
 * @property {(name: string, access: string) => void} protect
 * @property {Record<string, string>} Access
 */

/**
 * Binds one `site` sidecar entry: validates the three byte pins, allocates a
 * trampoline for the displaced instructions, and patches the site with a jump
 * into the registered stub. Kept apart from `bindHooks`' own loop because a
 * site entry needs guest-code surgery a slot entry never does -- a
 * trampoline, a code-page write -- and folding both shapes into one body was
 * harder to read than naming the difference.
 *
 * @param {import('./internal/hooks.js').SiteHookEntry} entry
 * @param {import('./internal/hooks.js').LoadedImage} image
 * @param {LoaderMemory} memory
 * @param {(options: { name: string, site: true, trampoline: number, resume: number,
 *     stackAdjust: number, handler: Function }) => number} register
 * @param {(entry: import('./internal/hooks.js').SiteHookEntry) => Function | null} resolveHandler
 * @param {((size: number) => number) | undefined} allocate
 * @param {string[]} bound
 * @param {string[]} refused
 */
function bindSiteHook(entry, image, memory, register, resolveHandler, allocate, bound, refused){
    const siteLength = parseHexBytes(entry.site.bytes).length;
    const resumeLength = parseHexBytes(entry.resume.bytes).length;
    const functionLength = parseHexBytes(entry.function.bytes).length;
    /** @type {{ siteBytes: number[], resumeBytes: number[], functionBytes: number[] }} */
    let reads;
    try
    {
        reads = {
            siteBytes: [...memory.readBytes(
                (image.base + Number(entry.site.rva)) >>> 0, siteLength)],
            resumeBytes: [...memory.readBytes(
                (image.base + Number(entry.resume.rva)) >>> 0, resumeLength)],
            functionBytes: [...memory.readBytes(
                (image.base + Number(entry.function.rva)) >>> 0, functionLength)],
        };
    }
    catch (e){
        // An unmapped or unreadable RVA -- a typo'd sidecar -- refuses the
        // entry by name instead of failing the whole `buildApp`, the same
        // discipline every other check in this function already keeps.
        refused.push(`${entry.kernel}: ${e instanceof Error ? e.message : String(e)}`);
        return;
    }
    const plan = planSiteHook(entry, image, reads);
    if (!plan.ok)
    {
        refused.push(plan.reason);
        return;
    }
    const handler = resolveHandler(entry);
    if (!handler)
    {
        refused.push(`${entry.kernel}: no kernel provides it`);
        return;
    }
    if (!allocate)
    {
        refused.push(`${entry.kernel}: no allocator provided for a site hook`);
        return;
    }

    const displaced = memory.readBytes(plan.siteAddress, plan.displacedLength);
    const trampoline = allocate(plan.displacedLength + 5);
    memory.writeBytes(trampoline, displaced);
    memory.writeBytes(trampoline + plan.displacedLength,
        jumpBytes(trampoline + plan.displacedLength, plan.siteAddress + plan.displacedLength));

    const address = register({
        name: entry.kernel, site: true, trampoline,
        resume: plan.resumeAddress, stackAdjust: plan.stackAdjust, handler,
    });
    // The same discipline as a slot's write: nothing but a real stub address
    // goes into guest code.
    if (!Number.isInteger(address) || address === 0)
    {
        refused.push(`${entry.kernel}: no stub address was registered`);
        return;
    }

    // A code-page write: the region is executable, so this routes through the
    // emulator's own physical write and invalidates whatever was compiled
    // from the bytes underneath -- it happens once, at bind time, before the
    // program's first instruction, so nothing is compiled yet to discard. The
    // same protect/write/protect discipline `app.js`'s `debug.hook` uses, even
    // though the program image is already `rwx` and the toggle is a no-op
    // today: a region that ever stops being `rwx` must not silently start
    // refusing this write.
    const region = memory.find(plan.siteAddress);
    if (!region)
    {
        // Not reachable today: the three reads above already proved the site
        // is mapped. Guarded anyway so a future reordering fails by refusal,
        // not by reading `.access` off `undefined`.
        refused.push(`${entry.kernel}: nothing is mapped at the site`);
        return;
    }
    const before = region.access;
    memory.protect(region.name, memory.Access.READ_WRITE_EXECUTE);
    const patch = new Uint8Array(plan.displacedLength).fill(0x90);
    patch.set(jumpBytes(plan.siteAddress, address));
    memory.writeBytes(plan.siteAddress, patch);
    memory.protect(region.name, before);

    bound.push(entry.kernel);
}

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
/** @type {{ bound: string[], refused: string[], pending: string[] }} */
let hookResults = { bound: [], refused: [], pending: [] };

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
        // A process's own account: what the previous instance bound is not
        // what this one has.
        hookResults = { bound: [], refused: [], pending: [] };

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
                const codeSize = module.dataRva || module.size;

                memory.register({
                    name,
                    base,
                    size: codeSize,
                    kind: memory.RegionKind.IMAGE,
                    // Written once, at assembly, and executable from then on:
                    // the exports are jumps and the guest runs them.
                    access: memory.Access.READ_WRITE_EXECUTE,
                });
                memory.writeBytes(base, module.bytes.subarray(0, codeSize));
                memory.protect(name, memory.Access.READ_EXECUTE);
                if (module.dataRva !== 0)
                {
                    // The variables are written by the program and by the
                    // library's own functions alike, as a real `.data` is.
                    memory.register({
                        name: `${name} .data`,
                        base: base + module.dataRva,
                        size: module.size - module.dataRva,
                        kind: memory.RegionKind.IMAGE,
                        access: memory.Access.READ_WRITE,
                    });
                    memory.writeBytes(base + module.dataRva, module.bytes.subarray(module.dataRva));
                }

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
             * here -- called once per image the sidecar names as each is
             * placed, so a library the program loads at run time gets its
             * entries the moment it is mapped and before its code runs. The
             * engine names nothing about a title in this function:
             * `spec` carries the image name, the RVAs and the kernel name from
             * the sidecar, `image` is what was actually loaded, and what a
             * kernel does is entirely `register`'s caller's business -- this
             * only validates the sidecar against reality, writes the slot,
             * and reports which entries it could not trust.
             *
             * @param {{ hooks: (import('./internal/hooks.js').HookEntry
             *     | import('./internal/hooks.js').SiteHookEntry)[] }} spec
             * @param {import('./internal/hooks.js').LoadedImage} image
             * @param {(options: { name: string, argBytes: number, target: number,
             *     handler: Function } | { name: string, site: true, trampoline: number,
             *     resume: number, stackAdjust: number, handler: Function }) => number} register
             *     Bound to the bridge by whoever assembles the process; this
             *     layer has no bridge of its own to call. Answers the stub's
             *     guest address, as `bridge.hook`/`bridge.siteHook` do -- or 0
             *     for none.
             * @param {(entry: import('./internal/hooks.js').HookEntry
             *     | import('./internal/hooks.js').SiteHookEntry) => Function | null} resolveHandler
             *     What a hook actually does, keyed off the sidecar's own
             *     entry -- typically a lookup into the bundle's `hooks.mjs`.
             * @param {(size: number) => number} [allocate]
             *     Guest heap room for a site hook's trampoline. Only a `site`
             *     entry needs it; a spec of slot entries alone never calls it,
             *     so a caller with nothing but slot hooks may omit it.
             * @returns {{ bound: string[], refused: string[], pending: string[] }}
             *     What this call bound and refused, and the entries still
             *     waiting for their image across every call so far.
             */
            bindHooks(spec, image, register, resolveHandler, allocate){
                /** @type {string[]} */
                const bound = [];
                /** @type {string[]} */
                const refused = [];
                /** @type {string[]} */
                const pending = [];
                for (const entry of spec.hooks ?? [])
                {
                    if (entry.image.toLowerCase() !== image.name.toLowerCase())
                    {
                        // Another image's entry: bound when that image is
                        // placed (a library the program loads at run time),
                        // pending until then -- neither bound nor refused.
                        pending.push(entry.kernel);
                        continue;
                    }
                    if (entry.site)
                    {
                        bindSiteHook(entry, image, /** @type {LoaderMemory} */ (memory),
                            register, resolveHandler, allocate, bound, refused);
                        continue;
                    }
                    const slotAddress = (image.base + Number(entry.slot.rva)) >>> 0;
                    let slotValue;
                    try
                    {
                        slotValue = memory.readU32(slotAddress);
                    }
                    catch (e){
                        refused.push(
                            `${entry.kernel}: ${e instanceof Error ? e.message : String(e)}`);
                        continue;
                    }
                    const plan = planHook(entry, image, slotValue);
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
                // Accumulated across images: the program image first, then
                // each library as it is loaded. A kernel is pending until the
                // image it names is placed, and stops being so once bound.
                const boundSoFar = [...hookResults.bound, ...bound];
                hookResults = {
                    bound: boundSoFar,
                    refused: [...hookResults.refused, ...refused],
                    pending: pending.filter(name=>!boundSoFar.includes(name)),
                };
                return { bound, refused, pending: hookResults.pending };
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
                hooksPending: hookResults.pending,
            },
        };
    },

    async dispose(){
        loaded = [];
        hookResults = { bound: [], refused: [], pending: [] };
    },
};
