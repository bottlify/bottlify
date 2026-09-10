/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { buildBootRom, BRING_UP_PARK, GUEST_JUMP, ROM_BASE } from './boot-rom.js';

/**
 * The only place in the codebase that knows the emulator underneath is v86.
 *
 * v86 ships as a prebuilt module plus a .wasm blob; both are addressed by the
 * caller rather than imported statically. That keeps 350 KiB of compiled
 * vendor JS out of `tsc --checkJs` and out of the bundle, and lets the same
 * code run in a worker (URL) and under the test runner (file URL) without
 * branching on the environment inside the layer.
 *
 * Everything above this file speaks in the cpu layer's own terms: run, stop,
 * registers, physical memory, traps.
 */

/**
 * @typedef {Object} V86HostConfig
 * @property {string} moduleUrl     URL of the v86 ESM build (libv86.mjs).
 * @property {ArrayBuffer} wasmBytes  The v86.wasm blob.
 * @property {number} memorySize    Guest RAM in bytes.
 * @property {number} trapPort      I/O port used as the guest → host call channel.
 * @property {number} entryVector   Linear address of the dword holding the guest entry point.
 * @property {number} initialStack  Initial guest ESP.
 * @property {Record<string, number>} [jit]
 *     The emulator's own compiler budgets, by config index, applied before
 *     anything runs. For measurement rather than for production.
 */

/** Register names in v86's reg32 view, in index order. */
const REGISTERS = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];

/** How much to pull out of a zstd frame at a time. */
const ZSTD_CHUNK = 1 << 16;

/**
 * How many slices bring-up may take before it is declared broken.
 *
 * The ROM is eighteen instructions and the emulator stops on a basic block
 * rather than exactly one instruction, so this is generous by an order of
 * magnitude. It is a bound, not a budget: reaching it means the ROM did not
 * arrive where it says it does, and that has to be loud.
 */
const BRING_UP_SLICES = 64;

/**
 * Boots an emulator instance with our own ROM and returns the cpu layer's
 * internal handle to it.
 *
 * @param {V86HostConfig} config
 */
export async function createV86Host(config){
    const { V86 } = await import(config.moduleUrl);

    const rom = buildBootRom({
        entryVector: config.entryVector,
        initialStack: config.initialStack,
        trapPort: config.trapPort,
    });

    const emulator = new V86({
        wasm_fn: (/** @type {WebAssembly.Imports} */ imports)=>
            WebAssembly.instantiate(config.wasmBytes, imports)
                .then(result=>result.instance.exports),
        memory_size: config.memorySize,
        vga_memory_size: 1024 * 1024,
        // Our ROM, not SeaBIOS: 64 KiB placed at ROM_BASE, entered at its reset vector.
        bios: { buffer: rom.buffer },
        autostart: false,
        disable_keyboard: true,
        disable_speaker: true,
    });

    await new Promise(resolve=>emulator.add_listener('emulator-ready', resolve));

    const cpu = emulator.v86.cpu;

    // The emulator hands out its registers and its memory as proxies that
    // make a fresh typed array on every property access -- measured at half
    // a gigabyte of views a minute on a title's menu, every one of them
    // garbage the runtime then collects. The views are taken once here, from
    // the proxies' own offsets, and taken again only if the emulator ever
    // replaces its memory.
    /**
     * @type {{ buffer: ArrayBuffer | null, ram: Uint8Array, ramOffset: number,
     *     data: DataView, reg32: Int32Array, eip: Int32Array, flags: Int32Array,
     *     flagsChanged: Int32Array, cr: Int32Array, inHlt: Uint8Array,
     *     counter: Uint32Array }}
     */
    const views = {
        buffer: null, ram: new Uint8Array(0), ramOffset: 0, data: new DataView(new ArrayBuffer(0)),
        reg32: new Int32Array(0), eip: new Int32Array(0), flags: new Int32Array(0),
        flagsChanged: new Int32Array(0), cr: new Int32Array(0), inHlt: new Uint8Array(0),
        counter: new Uint32Array(0),
    };
    const v = ()=>{
        const buffer = cpu.wasm_memory.buffer;
        if (views.buffer !== buffer)
        {
            /** @param {any} proxied @param {any} Type */
            const take = (proxied, Type)=>new Type(buffer, proxied.byteOffset, proxied.length);
            views.buffer = buffer;
            views.ram = take(cpu.mem8, Uint8Array);
            views.ramOffset = views.ram.byteOffset;
            views.data = new DataView(buffer);
            views.reg32 = take(cpu.reg32, Int32Array);
            views.eip = take(cpu.instruction_pointer, Int32Array);
            views.flags = take(cpu.flags, Int32Array);
            views.flagsChanged = take(cpu.flags_changed, Int32Array);
            views.cr = take(cpu.cr, Int32Array);
            views.inHlt = take(cpu.in_hlt, Uint8Array);
            views.counter = take(cpu.instruction_counter, Uint32Array);
        }
        return views;
    };
    // How many compiled modules the emulator actually published, and the first
    // reason one was refused. `codegen_finalize` instantiates asynchronously and
    // its promise has no rejection handler, so a compiler that cannot publish
    // fails silently and every guest instruction is interpreted for the rest of
    // the run -- which is correct, several times slower, and invisible.
    let finalisedModules = 0;
    // How many compiled modules the emulator threw away, and how much guest
    // memory we wrote from the host. Every host write goes through v86's
    // write_blob, which dirties the JIT cache for every page it touches -- so a
    // layer that writes a megabyte a frame is asking the compiler to discard
    // whatever it had for those pages, over and over.
    let clearedFunctions = 0;
    let hostWrites = 0;
    let hostWrittenBytes = 0;
    /** @type {unknown} */
    let finaliseFailure = null;
    // The emulator counts instructions in a thirty-two-bit word, which a run
    // wraps in about a minute. The count kept here is the sum of what each
    // read found new, exact as long as reads come less than 2^32 instructions
    // apart -- which the slice runner sees to, reading after every slice.
    let counted = 0;
    let lastWord = 0;
    // How much guest code one compiled module may span, and how far discovery
    // may follow branches into it. The defaults are three pages and a handful
    // of extra blocks, which for a program of this size means the guest leaves
    // generated code every few dozen instructions and pays the dispatch walk
    // again. Raising them is a configuration, not a patch.
    if (config?.jit)
    {
        for (const [index, value] of Object.entries(config.jit))
        {
            cpu.wm.exports.set_jit_config(Number(index), Number(value));
        }
        cpu.wm.exports.jit_clear_cache_js();
    }

    const clearOne = cpu.jit_clear_func.bind(cpu);
    /** @type {any} */ (cpu).jit_clear_func = (/** @type {number} */ index)=>{
        clearedFunctions++;
        return clearOne(index);
    };
    const finalise = cpu.codegen_finalize.bind(cpu);
    /** @type {any} */ (cpu).codegen_finalize = (/** @type {any[]} */ ...args)=>{
        try
        {
            finalise(...args);
            finalisedModules++;
        }
        catch (e){
            finaliseFailure ??= /** @type {Error} */ (e).message ?? String(e);
        }
    };

    // The mode switch happens here, not on the first `run()`.
    //
    // Whoever drives this machine may never call `run()` at all: a scheduler
    // moves the CPU by restoring a thread's context and running a slice, and
    // that context is a copy of the machine as it stood when the thread was
    // created. Created before the ROM had run, it is a snapshot of a processor
    // at reset -- real mode, 16-bit segments, CS based at the ROM -- and every
    // thread then starts in real mode at a 32-bit address, which decodes as
    // whatever the bytes happen to mean and executes memory at random.
    //
    // So the ROM is driven here, through its own park, and the machine is then
    // left standing on the jump into guest code -- which `run()` still performs
    // for a caller that boots by writing an entry vector.
    emulator.write_memory(
        new Uint8Array([BRING_UP_PARK & 0xff, BRING_UP_PARK >>> 8 & 0xff,
            BRING_UP_PARK >>> 16 & 0xff, BRING_UP_PARK >>> 24 & 0xff]),
        config.entryVector);
    for (let slice = 0; slice < BRING_UP_SLICES; slice++)
    {
        if ((v().eip[0] >>> 0) === BRING_UP_PARK)
        {
            break;
        }
        cpu.run_slice(1);
    }
    if ((v().cr[0] & 1) !== 1 || (v().eip[0] >>> 0) !== BRING_UP_PARK)
    {
        throw new Error('cpu: the boot ROM did not reach protected mode'
            + ` (eip 0x${(v().eip[0] >>> 0).toString(16)},`
            + ` cr0 0x${(v().cr[0] >>> 0).toString(16)})`);
    }
    v().eip[0] = GUEST_JUMP;

    /** @type {((value: number) => void) | null} */
    let trapHandler = null;

    cpu.io.register_write(
        config.trapPort,
        { name: 'bottlify-trap' },
        undefined,
        undefined,
        (/** @type {number} */ value)=>{
            if (trapHandler)
            {
                trapHandler(value >>> 0);
            }
        },
    );

    return {
        /**
         * Lets the machine run. The mode switch is already done, so this
         * resumes at the ROM's jump into whatever the entry vector holds.
         */
        run: ()=>emulator.run(),
        stop: ()=>emulator.stop(),

        /** @param {(value: number) => void} handler */
        onTrap(handler){
            trapHandler = handler;
        },

        /**
         * A window on the machine's memory, not a copy: it is the memory,
         * and it moves when the guest runs. A caller that keeps it keeps a
         * value that changes under it.
         *
         * @param {number} address @param {number} length @returns {Uint8Array}
         */
        readPhysical: (address, length)=>v().ram.subarray(address, address + length),

        /** A dword, read without a view or a copy being made. @param {number} address */
        readU32: address=>v().data.getUint32(v().ramOffset + address, true),

        /** @param {number} address @param {Uint8Array} bytes */
        writePhysical: (address, bytes)=>{
            hostWrites++;
            hostWrittenBytes += bytes.length;
            return emulator.write_memory(bytes, address);
        },

        /**
         * Writes bytes the guest can never execute.
         *
         * The ordinary path is `write_memory`, which for every call -- a single
         * dword included -- crosses into the emulator three times: twice to ask
         * whether the address is a device mapping, once to discard whatever it
         * had compiled for the pages written. That is the right price for
         * loading an image and the wrong one for an HLE writing a structure
         * field, which is nearly every write there is: measured at 688,082 of
         * them in one run of a title's menu.
         *
         * This writes straight into the machine's memory instead. The caller is
         * the one that knows the target cannot be executed, and it is the
         * caller that has to be right about it.
         *
         * @param {number} address @param {Uint8Array} bytes
         */
        writeData: (address, bytes)=>{
            hostWrites++;
            hostWrittenBytes += bytes.length;
            v().ram.set(bytes, address);
        },

        /** @param {string} name @returns {number} */
        readReg32(name){
            // Not in the general-purpose file, and both are asked for by name:
            // a CONTEXT record carries them, and building one is how an
            // exception is described to the code that will handle it.
            if (name === 'eip')
            {
                return v().eip[0] >>> 0;
            }
            if (name === 'eflags')
            {
                // Through the emulator's own accessor, not the raw field: the
                // arithmetic flags are lazy there and are only folded in here.
                // A CONTEXT built from the raw word tells a handler that every
                // comparison the faulting code made came out false.
                return cpu.get_eflags() >>> 0;
            }
            const index = REGISTERS.indexOf(name);
            if (index === -1)
            {
                throw new Error(`Unknown register "${name}"`);
            }
            return v().reg32[index] >>> 0;
        },

        /** @param {string} name @param {number} value */
        writeReg32(name, value){
            if (name === 'eip')
            {
                v().eip[0] = value | 0;
                return;
            }
            if (name === 'eflags')
            {
                v().flags[0] = value | 0;
                // The word is now literal, so the lazy arithmetic flags must
                // stop claiming to know better -- left set, they recompute over
                // whatever was just written the next time anything reads them.
                v().flagsChanged[0] = 0;
                return;
            }
            const index = REGISTERS.indexOf(name);
            if (index === -1)
            {
                throw new Error(`Unknown register "${name}"`);
            }
            v().reg32[index] = value | 0;
        },

        /**
         * The emulator's CPU object, for code inside this layer that works with
         * the raw state -- context capture and restore. It must not travel any
         * further: the layer boundary exists so that only this directory knows
         * what the emulator underneath is.
         */
        cpu: ()=>cpu,

        /** @returns {number} guest EIP */
        eip: ()=>v().eip[0] >>> 0,

        /** @returns {boolean} whether the guest is in protected mode */
        inProtectedMode: ()=>(v().cr[0] & 1) === 1,

        /** @returns {number} instructions retired since boot (exact; Phase 2 quantum builds on this) */
        instructionCount: ()=>{
            const word = emulator.get_instruction_counter() >>> 0;
            counted += (word - lastWord) >>> 0;
            lastWord = word;
            return counted;
        },

        /**
         * How many compiled entry points the emulator is holding, when it will
         * say. A release build compiles this counter out and answers zero
         * always, so a caller must read `jit.compiledSteps` instead and this
         * exists only for a build that carries the profiler.
         */
        jitCacheSize: ()=>{
            try
            {
                return cpu.wm.exports.jit_get_cache_size() >>> 0;
            }
            catch (e){
                void e;
                return -1;
            }
        },

        /**
         * The emulator's own account of where the guest ran, by address,
         * weighted by instructions: every compiled block counts itself on
         * entry, and the interpreter every instruction. A build without it
         * answers that it is absent, and starting it then does nothing.
         */
        profile: {
            available: ()=>typeof cpu.wm.exports.profile_set === 'function',
            /** @returns {boolean} whether the account is being kept */
            start(){
                const exports = cpu.wm.exports;
                if (typeof exports.profile_set !== 'function')
                {
                    return false;
                }
                exports.profile_reset();
                exports.profile_set(1);
                // A block compiled before now carries no count.
                exports.jit_clear_cache_js();
                return true;
            },
            stop(){
                const exports = cpu.wm.exports;
                if (typeof exports.profile_set === 'function')
                {
                    exports.profile_set(0);
                    exports.jit_clear_cache_js();
                }
            },
            /**
             * @returns {{ entries: { address: number, instructions: number, hits: number }[],
             *     dropped: number } | null}
             */
            read(){
                const exports = cpu.wm.exports;
                if (typeof exports.profile_slots !== 'function')
                {
                    return null;
                }
                const slots = exports.profile_slots() >>> 0;
                const memory = exports.memory.buffer;
                const keys = new Uint32Array(memory, exports.profile_keys_ptr() >>> 0, slots);
                const weights = new Uint32Array(memory, exports.profile_weights_ptr() >>> 0, slots);
                const hits = new Uint32Array(memory, exports.profile_hits_ptr() >>> 0, slots);
                const entries = [];
                for (let slot = 0; slot < slots; slot++)
                {
                    if (keys[slot] !== 0)
                    {
                        entries.push({
                            address: (keys[slot] - 1) >>> 0,
                            instructions: weights[slot],
                            hits: hits[slot],
                        });
                    }
                }
                return { entries, dropped: exports.profile_dropped() >>> 0 };
            },
        },

        /** How many modules the compiler has published so far. */
        compiledModules: ()=>finalisedModules,

        /** Bytes the host has written into guest memory so far. */
        hostWrittenBytes: ()=>hostWrittenBytes,

        /** Instructions the interpreter has run so far, in a build that counts. */
        interpretedSteps: ()=>(cpu.wm.exports.bottlify_stat
            ? Math.round(cpu.wm.exports.bottlify_stat(1))
            : 0),

        /** What the emulator's compiler was configured with, and how it is doing. */
        jitState: ()=>{
            try
            {
                const exports = cpu.wm.exports;
                /** @param {number} index */
                const read = index=>(exports.bottlify_stat
                    ? Math.round(exports.bottlify_stat(index))
                    : -1);
                return {
                    disabled: exports.get_jit_config(0),
                    maxPages: exports.get_jit_config(1),
                    loopSafety: exports.get_jit_config(2),
                    cache: exports.jit_get_cache_size() >>> 0,
                    tableFree: exports.jit_get_wasm_table_index_free_list_count() >>> 0,
                    // Where the guest's instructions actually run, and how
                    // much of its arithmetic goes through the 80-bit software
                    // float. Absent in an emulator build without them.
                    compiledSteps: read(0),
                    interpretedSteps: read(1),
                    entries: read(2),
                    interpretedDispatches: read(3),
                    f80Conversions: read(4),
                    finalised: finalisedModules,
                    discarded: clearedFunctions,
                    hostWrites,
                    hostWrittenBytes,
                    refused: String(finaliseFailure ?? ''),
                };
            }
            catch (e){
                void e;
                return -1;
            }
        },

        romBase: ROM_BASE,

        /**
         * Decompresses a zstd frame, synchronously.
         *
         * The emulator's own wasm carries a zstd decoder -- it reads compressed
         * disk images with one -- and exports it. That makes it the only
         * decompressor available to us that answers without a promise, which is
         * what a guest read needs: the CPU is mid-instruction and cannot await.
         *
         * The scratch it uses is the emulator's own linear memory, which is also
         * where guest RAM lives, so everything taken is given back before this
         * returns.
         *
         * @param {Uint8Array} packed
         * @param {number} expectedLength
         * @returns {Uint8Array}
         */
        decompressZstd(packed, expectedLength){
            const wasm = cpu.wm.exports;
            const context = wasm.zstd_create_ctx(packed.length);
            try
            {
                const source = wasm.zstd_get_src_ptr(context);
                new Uint8Array(cpu.wasm_memory.buffer, source, packed.length).set(packed);

                const out = new Uint8Array(expectedLength);
                let at = 0;
                while (at < expectedLength)
                {
                    const want = Math.min(ZSTD_CHUNK, expectedLength - at);
                    const pointer = wasm.zstd_read(context, want);
                    if (pointer === 0)
                    {
                        throw new Error('cpu: zstd frame ended before it was supposed to');
                    }
                    out.set(new Uint8Array(cpu.wasm_memory.buffer, pointer, want), at);
                    wasm.zstd_read_free(pointer, want);
                    at += want;
                }
                return out;
            }
            finally
            {
                wasm.zstd_free_ctx(context);
            }
        },
    };
}
