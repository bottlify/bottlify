/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * sidecar - a bundle's sidecar hooks bound: its kernels loaded, each image it
 * targets hooked once it is placed.
 */

/**
 * @typedef {Object} GuestMemory
 * @property {(address: number) => number} readU8
 * @property {(address: number, value: number) => void} writeU8
 * @property {(address: number) => number} readU32
 * @property {(address: number, value: number) => void} writeU32
 * @property {(address: number, count: number, into: number[] | Float32Array) => void} readF32sInto
 * @property {(address: number, length: number) => Uint8Array} window
 */

/**
 * @param {Record<string, any>} deps  the parts of the process it works on, by the names
 *     `app.js` gives them; asked for, since they are made or set later: `mainModule`
 */
export async function bindSidecar(deps){
    const {
        allocateFromHeap, bridge, core, events, glCounters, image, journal, journalCall,
        libraryLoader, loader, memory, modules, options,
    } = deps;
    const {
        mainModule,
    } = deps;

    // A bundle's sidecar, applied once the image it targets is at its real
    // address. The engine names nothing here: `hooks.json` carries the image,
    // the RVAs and the kernel name, and `hooks.mjs` -- the bundle's own code
    // -- is what a kernel does. This layer only loads the module, gives it a
    // bounds-checked view of guest memory, and wires a hook's outcome to the
    // bridge's own EIP redirect.
    if (options.sidecarHooks)
    {
        const kernelModule = await import(
            /* webpackIgnore: true */
            URL.createObjectURL(
                new Blob([options.sidecarHooks.source], { type: 'text/javascript' })));
        const kernels = kernelModule.kernels ?? {};
        const imagePath = options.imagePath ?? 'C:\\app.exe';
        const imageName = imagePath.slice(
            Math.max(imagePath.lastIndexOf('\\'), imagePath.lastIndexOf('/')) + 1);
        const guestView = createGuestView(/** @type {GuestMemory} */ (memory));
        // Resolved against the graphics seam the first time a kernel actually
        // asks, not at bind time (`resolveOpenglEntry`): a build with no
        // OpenGL layer (a Direct3D title) still binds every kernel.
        const kernelGl = createKernelGl(
            resolveOpenglEntry(/** @type {{ opengl: () => ReturnType<
                typeof import('../layers/graphics/opengl/exports.js').createOpengl> }} */ (
                    core.api('graphics'))),
            journalCall, ()=>journal.enabled('call.gpu', journal.Level.TRACE), glCounters);
        const spec = options.sidecarHooks.spec;
        /**
         * @param {{ name: string, base: number, sizeOfImage: number, timeDateStamp: number }}
         *     target the image, as placed
         */
        libraryLoader.bindSidecar = target=>{
            const result = loader.bindHooks(
                spec,
                target,
                /** @param {{ name: string, argBytes: number, target: number, handler: Function,
                 *   site?: undefined }
                 *   | { name: string, site: true, trampoline: number, resume: number,
                 *   stackAdjust: number, handler: Function }} hookOptions */
                hookOptions=>hookOptions.site
                    ? bridge.siteHook(hookOptions.name, hookOptions)
                    : bridge.hook(hookOptions.name, hookOptions),
                /** @param {import('../layers/loader/internal/hooks.js').HookEntry
                 *   | import('../layers/loader/internal/hooks.js').SiteHookEntry} entry */
                entry=>resolveKernel(entry, target.base),
                allocateFromHeap);
            events.emit('hooks-bound', { image: target.name, ...result });
        };
        /**
         * @param {import('../layers/loader/internal/hooks.js').HookEntry
         *   | import('../layers/loader/internal/hooks.js').SiteHookEntry} entry
         * @param {number} base the base of the image the entry names
         */
        const resolveKernel = (entry, base)=>{
            const kernelFn = kernels[entry.kernel];
            if (!kernelFn)
            {
                return null;
            }
            const guest = {
                ...guestView, mismatch: ()=>bridge.reportHookMismatch(entry.kernel),
            };
            const site = Boolean(entry.site);
            // Built once per bound entry rather than once per call: the
            // base and the GL handle are the same on every call a given
            // site makes, so only the kernel's own arguments change.
            const frame = site ? { base, gl: kernelGl } : undefined;
            return (/** @type {number[] | Record<string, number>} */ argsOrRegisters)=>{
                // Guard and fall through, the discipline every guest-code
                // replacement in this engine keeps: a kernel is the
                // bundle's own code, on the bundle's own data, and a bug
                // in it is not a reason to bring the run down when the
                // guest's own function is right there to fall back on.
                let handled;
                // A GL call the kernel already issued through `frame.gl`
                // before it threw is not undone -- the guest's own
                // function then runs the whole pass again on top of it --
                // so `hook-error`'s payload says how many, rather than
                // leaving that silent.
                const glCallsBefore = glCounters.calls;
                try
                {
                    // A site kernel gets a third argument, `frame`, with
                    // the image base -- so it can follow a data pointer
                    // the sidecar gave it as an RVA -- distinct from the
                    // dispatcher's own call frame, which a site hook has
                    // no real use for (there was no call to marshal).
                    handled = site
                        ? kernelFn(guest, argsOrRegisters, frame)
                        : kernelFn(guest, argsOrRegisters);
                }
                catch (e){
                    events.emit('hook-error', {
                        kernel: entry.kernel,
                        message: e instanceof Error ? e.message : String(e),
                        glCalls: glCounters.calls - glCallsBefore,
                    });
                    return false;
                }
                // `oracle` never skips the guest's own code, whatever the
                // kernel decided: that is the whole of the differential
                // guard, and it is the sidecar's flag, not the kernel's.
                // A site hook has no in-browser oracle; its `mode` is always
                // `replace`.
                return entry.mode === 'oracle' ? false : handled;
            };
        };
        libraryLoader.bindSidecar({
            name: imageName, base: image.base,
            sizeOfImage: mainModule().image.sizeOfImage,
            timeDateStamp: mainModule().image.timeDateStamp,
        });
        // Libraries the bundle shipped and the image imported statically are
        // already placed by now; a runtime load binds itself as it maps.
        for (const held of modules.all())
        {
            if (held.image && held.base !== image.base)
            {
                libraryLoader.bindSidecar({
                    name: held.name.slice(
                        Math.max(held.name.lastIndexOf('\\'), held.name.lastIndexOf('/')) + 1),
                    base: held.base,
                    sizeOfImage: held.image.sizeOfImage,
                    timeDateStamp: held.image.timeDateStamp,
                });
            }
        }
    }

    return {


    };
}


/**
 * A kernel's view of guest memory: the scalar accessors a hook has always
 * had, plus `u8s`/`i32s`/`f32s`, a typed-array view over a span rather than
 * one call per element. `memory.window` already hands back a live subarray
 * of guest RAM, bounds-checked once for the whole span (the
 * same primitive `audio` and `graphics` already read through) -- this only
 * adds the `Int32Array`/`Float32Array` reinterpretation on top of it, so
 * nothing new needed to be added to the memory layer itself.
 *
 * `Int32Array`/`Float32Array` need a 4-byte-aligned byte offset into the
 * backing buffer, so an unaligned span throws -- the same outcome as any bad
 * address: the call falls through to the guest's own function. A copy would
 * be the alternative, and a copy's writes would never reach the guest.
 *
 * @param {GuestMemory} memory
 */
export function createGuestView(memory){
    const floatScratch = new Float32Array(1);
    const floatBits = new DataView(floatScratch.buffer);

    /**
     * @param {number} at @param {number} count @param {number} bytesPerElement
     * @param {Float32ArrayConstructor | Int32ArrayConstructor} Ctor
     */
    const typedView = (at, count, bytesPerElement, Ctor)=>{
        const span = memory.window(at, count * bytesPerElement);
        if (span.byteOffset % bytesPerElement !== 0)
        {
            throw new RangeError(
                `${Ctor.name} view at 0x${at.toString(16)} is not ${bytesPerElement}-byte aligned`);
        }
        return new Ctor(/** @type {ArrayBuffer} */ (span.buffer), span.byteOffset, count);
    };

    return {
        u8: (/** @type {number} */ at)=>memory.readU8(at),
        writeU8: (/** @type {number} */ at, /** @type {number} */ value)=>{
            memory.writeU8(at, value);
        },
        i32: (/** @type {number} */ at)=>memory.readU32(at) | 0,
        f32: (/** @type {number} */ at)=>{
            memory.readF32sInto(at, 1, floatScratch);
            return floatScratch[0];
        },
        writeF32: (/** @type {number} */ at, /** @type {number} */ value)=>{
            floatScratch[0] = value;
            memory.writeU32(at, floatBits.getUint32(0, true));
        },
        /** A `Uint8Array` window over `count` bytes at `at`, bounds-checked once. */
        u8s: (/** @type {number} */ at, /** @type {number} */ count)=>memory.window(at, count),
        /** An `Int32Array` view over `count` dwords at `at`, bounds-checked once. */
        i32s: (/** @type {number} */ at, /** @type {number} */ count)=>typedView(at, count, 4, Int32Array),
        /** A `Float32Array` view over `count` floats at `at`, bounds-checked once. */
        f32s: (/** @type {number} */ at, /** @type {number} */ count)=>typedView(at, count, 4, Float32Array),
    };
}

/**
 * The lazy, remembered resolve of the OpenGL seam `frame.gl` needs:
 * `graphics.opengl()` is not called until a kernel's first `entry()` call,
 * and a seam that throws (a build with no OpenGL layer) is remembered rather
 * than retried on every later call, so a Direct3D title still binds its
 * kernels with `entry` answering `null` for every name.
 * @param {{ opengl: () => {
 *   entry: (name: string) => ((args: number[]) => number) | null } }} graphics
 * @returns {{ entry: (name: string) => ((args: number[]) => number) | null }}
 */
export function resolveOpenglEntry(graphics){
    let openglLayer = /** @type {ReturnType<typeof graphics.opengl> | null} */ (null);
    let openglSeamFailed = false;
    return {
        entry(name){
            if (openglSeamFailed)
            {
                return null;
            }
            if (!openglLayer)
            {
                try
                {
                    openglLayer = graphics.opengl();
                }
                catch {
                    openglSeamFailed = true;
                    return null;
                }
            }
            return openglLayer.entry(name);
        },
    };
}

/**
 * The OpenGL handle a site kernel gets as `frame.gl`.
 *
 * `entry(name)` resolves one OPENGL32 entry point to a function the kernel
 * keeps and calls with raw dwords; each call is written to the journal under
 * `call.gpu` exactly as a trapped call is (same name, same category), so a
 * trace of the run stays honest when a kernel issues the work the guest would
 * have issued. Nothing else of the engine reaches the kernel through this.
 *
 * A build with no OpenGL seam (a Direct3D title) has an `opengl.entry` that
 * throws or is otherwise unusable; that answers `null` for every name rather
 * than taking the run down, so a title with no OpenGL still binds its kernels.
 *
 * @param {{ entry: (name: string) => ((args: number[]) => number) | null }} opengl
 * @param {(call: { name: string, args: number[], result: string }) => void} journalCall
 * @param {() => boolean} traced   whether `call.gpu` is on at TRACE right now
 * @param {{ calls: number }} counters
 */
export function createKernelGl(opengl, journalCall, traced, counters){
    return {
        /** @param {string} name @returns {((args: number[]) => number) | null} */
        entry(name){
            let handler;
            try
            {
                handler = opengl.entry(name);
            }
            catch {
                return null;
            }
            if (!handler)
            {
                return null;
            }
            const label = `OPENGL32.dll!${name}`;
            return args=>{
                // Counted before the call, not after: a handler that throws
                // still issued the call (its GL side effect, if any, already
                // happened), and `kernelGlCalls` must match what the
                // `hook-error` payload's `glCalls` counts against it.
                counters.calls++;
                const result = handler(args);
                if (traced())
                {
                    journalCall({ name: label, args, result: `0x${(result >>> 0).toString(16)}` });
                }
                return result;
            };
        },
    };
}
