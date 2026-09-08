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
        if ((cpu.instruction_pointer[0] >>> 0) === BRING_UP_PARK)
        {
            break;
        }
        cpu.run_slice(1);
    }
    if ((cpu.cr[0] & 1) !== 1 || (cpu.instruction_pointer[0] >>> 0) !== BRING_UP_PARK)
    {
        throw new Error('cpu: the boot ROM did not reach protected mode'
            + ` (eip 0x${(cpu.instruction_pointer[0] >>> 0).toString(16)},`
            + ` cr0 0x${(cpu.cr[0] >>> 0).toString(16)})`);
    }
    cpu.instruction_pointer[0] = GUEST_JUMP;

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

        /** @param {number} address @param {number} length @returns {Uint8Array} */
        readPhysical: (address, length)=>emulator.read_memory(address, length),

        /** @param {number} address @param {Uint8Array} bytes */
        writePhysical: (address, bytes)=>emulator.write_memory(bytes, address),

        /** @param {string} name @returns {number} */
        readReg32(name){
            // Not in the general-purpose file, and both are asked for by name:
            // a CONTEXT record carries them, and building one is how an
            // exception is described to the code that will handle it.
            if (name === 'eip')
            {
                return cpu.instruction_pointer[0] >>> 0;
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
            return cpu.reg32[index] >>> 0;
        },

        /** @param {string} name @param {number} value */
        writeReg32(name, value){
            if (name === 'eip')
            {
                cpu.instruction_pointer[0] = value | 0;
                return;
            }
            if (name === 'eflags')
            {
                cpu.flags[0] = value | 0;
                // The word is now literal, so the lazy arithmetic flags must
                // stop claiming to know better -- left set, they recompute over
                // whatever was just written the next time anything reads them.
                cpu.flags_changed[0] = 0;
                return;
            }
            const index = REGISTERS.indexOf(name);
            if (index === -1)
            {
                throw new Error(`Unknown register "${name}"`);
            }
            cpu.reg32[index] = value | 0;
        },

        /**
         * The emulator's CPU object, for code inside this layer that works with
         * the raw state -- context capture and restore. It must not travel any
         * further: the layer boundary exists so that only this directory knows
         * what the emulator underneath is.
         */
        cpu: ()=>cpu,

        /** @returns {number} guest EIP */
        eip: ()=>cpu.instruction_pointer[0] >>> 0,

        /** @returns {boolean} whether the guest is in protected mode */
        inProtectedMode: ()=>(cpu.cr[0] & 1) === 1,

        /** @returns {number} instructions retired since boot (exact; Phase 2 quantum builds on this) */
        instructionCount: ()=>emulator.get_instruction_counter() >>> 0,

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
