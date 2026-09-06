/*
 * Copyright Bottlify Project 2026
 * Licenses and contributions: THIRD-PARTY-NOTICES.md
 */

import { buildBootRom, ROM_BASE } from "./boot-rom.js";

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
const REGISTERS = ["eax", "ecx", "edx", "ebx", "esp", "ebp", "esi", "edi"];

/**
 * Boots an emulator instance with our own ROM and returns the cpu layer's
 * internal handle to it.
 *
 * @param {V86HostConfig} config
 */
export async function createV86Host(config) {
  const { V86 } = await import(config.moduleUrl);

  const rom = buildBootRom({
    entryVector: config.entryVector,
    initialStack: config.initialStack,
  });

  const emulator = new V86({
    wasm_fn: (/** @type {WebAssembly.Imports} */ imports) =>
      WebAssembly.instantiate(config.wasmBytes, imports).then((result) => result.instance.exports),
    memory_size: config.memorySize,
    vga_memory_size: 1024 * 1024,
    // Our ROM, not SeaBIOS: 64 KiB placed at ROM_BASE, entered at its reset vector.
    bios: { buffer: rom.buffer },
    autostart: false,
    disable_keyboard: true,
    disable_speaker: true,
  });

  await new Promise((resolve) => emulator.add_listener("emulator-ready", resolve));

  const cpu = emulator.v86.cpu;
  /** @type {((value: number) => void) | null} */
  let trapHandler = null;

  cpu.io.register_write(
    config.trapPort,
    { name: "bottlify-trap" },
    undefined,
    undefined,
    (/** @type {number} */ value) => {
      if (trapHandler) trapHandler(value >>> 0);
    },
  );

  return {
    /** Starts execution at the reset vector; the ROM transitions to protected mode. */
    run: () => emulator.run(),
    stop: () => emulator.stop(),

    /** @param {(value: number) => void} handler */
    onTrap(handler) {
      trapHandler = handler;
    },

    /** @param {number} address @param {number} length @returns {Uint8Array} */
    readPhysical: (address, length) => emulator.read_memory(address, length),

    /** @param {number} address @param {Uint8Array} bytes */
    writePhysical: (address, bytes) => emulator.write_memory(bytes, address),

    /** @param {string} name @returns {number} */
    readReg32(name) {
      const index = REGISTERS.indexOf(name);
      if (index === -1) throw new Error(`Unknown register "${name}"`);
      return cpu.reg32[index] >>> 0;
    },

    /** @param {string} name @param {number} value */
    writeReg32(name, value) {
      const index = REGISTERS.indexOf(name);
      if (index === -1) throw new Error(`Unknown register "${name}"`);
      cpu.reg32[index] = value | 0;
    },

    /** @returns {number} guest EIP */
    eip: () => cpu.instruction_pointer[0] >>> 0,

    /** @returns {boolean} whether the guest is in protected mode */
    inProtectedMode: () => (cpu.cr[0] & 1) === 1,

    /** @returns {number} instructions retired since boot (exact; Phase 2 quantum builds on this) */
    instructionCount: () => emulator.get_instruction_counter() >>> 0,

    romBase: ROM_BASE,
  };
}
