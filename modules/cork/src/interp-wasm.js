/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The interpreter tier in wasm, over cork's own memory: `interp-wasm.c`, built
 * by `scripts/build-interp-wasm.mjs` into `interp-wasm.bytes.js`.
 *
 * The JavaScript interpreter (`interp.js`) decodes a run of instructions into
 * records and compiles each to closures on its first visit, and the records,
 * closures and their garbage were most of what code run a handful of times
 * cost -- a loading phase's first pass, a routine that rewrites itself. This
 * tier runs the integer instruction set straight from guest memory with the
 * flags kept lazy, and leaves the rest -- x87, MMX, SSE, the rare and system
 * forms -- to the JavaScript interpreter an instruction at a time: `run`
 * answers `WasmExit.UNSUPPORTED` with eip at the instruction, unexecuted.
 *
 * It keeps the host's hotness counts and its ring of recent run starts in an
 * area of the memory past the tables (`WASM_INTERPRETER_AREA` bytes), so both
 * interpreters count the same starts, and it looks a jump's target up in the
 * entry hash translated code probes: a start with a region leaves the run.
 */

import { MODULE_BASE64 } from './interp-wasm.bytes.js';
import { eflagsOf } from './emit/flags.js';
import { Tables } from './runtime/layout.js';

/** How a run of the tier ended. `interp-wasm.c` has the same numbers. */
export const WasmExit = Object.freeze({
    /** The budget is spent. */
    BUDGET: 1,
    /** The instruction at eip is the JavaScript interpreter's; nothing of it ran. */
    UNSUPPORTED: 2,
    /** A `hlt` retired; eip is past it. */
    HALT: 3,
    /** A fault before the instruction's effect: `exitValue` is the vector, eip the instruction. */
    FAULT: 4,
    /** An `out` to the trap port retired: `exitValue` is the value written. */
    TRAP: 5,
    /** A store into translated code retired: `exitValue` and `exitSize` are where. */
    CODE_WRITE: 6,
    /** A jump's target reached the hot threshold or a power of two past it: eip is the
     * target, `exitValue` its count. */
    HOT: 7,
    /** A jump's target has an entry in the hash: eip is the target. */
    ENTRY: 8,
});

/** Hot-count slots: a byte for every four bytes of the first sixteen megabytes, wrapping. */
export const HOT_SLOTS = 1 << 22;
/** Starts the ring of recent ones holds. */
export const RING_STARTS = 256;
/** Bytes the tier keeps past the tables: the counts, the ring and the ring's next index. */
export const WASM_INTERPRETER_AREA = HOT_SLOTS + RING_STARTS * 4 + 4;
/** Where the module's own data and stack end (the build fails past it): below guest RAM. */
const MODULE_END = 16384;

/** @type {WebAssembly.Module | null} */
let compiled = null;
/** What the process's hosts ran on the JavaScript interpreter before one started the tier: its
 * start is paid once a process, so the stretch that waits for it to pay is the process's too. */
const stretch = { work: 0 };

/** The module, compiled once a process. */
function wasmModule(){
    if (compiled === null)
    {
        const text = atob(MODULE_BASE64);
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++)
        {
            bytes[i] = text.charCodeAt(i);
        }
        compiled = new WebAssembly.Module(bytes);
    }
    return compiled;
}

/** @typedef {import('../../core/src/layers/cpu/engine.js').WasmInterpreter} WasmInterpreter */

/**
 * The tier over one memory, or null for a layout it cannot run over: another
 * executor's (the hybrid's code table is a second thing a store is noted
 * against), one without an `fs` base, or one whose guest RAM starts too low
 * to leave the module its page.
 *
 * @param {{ memory: WebAssembly.Memory,
 *     layout: import('../../core/src/layers/cpu/engine.js').StateLayout,
 *     area: number, hotThreshold: number, trapPort?: number, parkBase: number }} options
 *     area: where the tier's `WASM_INTERPRETER_AREA` bytes lie; parkBase: the park loop's
 *     address, whose jumps the ring leaves out
 * @returns {WasmInterpreter | null}
 */
export function createWasmInterpreter({ memory, layout, area, hotThreshold, trapPort, parkBase }){
    if ((layout.codePages ?? -1) >= 0 || layout.fsBase < 0 || layout.ramBase < MODULE_END
        || layout.regs + 32 > 512 || area + WASM_INTERPRETER_AREA > memory.buffer.byteLength)
    {
        return null;
    }
    // The module is decoded, compiled and instantiated at the first run, not
    // here: a process whose programs the JavaScript interpreter carries alone
    // (their first stretch) never pays for it, nor for the optimising compile
    // the wasm engine gives `run` once it has looped a few hundred times.
    // The exports are taken out once, not looked up on the exports object at
    // every run: a run is a crossing a region's every untranslated exit may make.
    /** @type {((budget: number) => number) | null} */
    let run = null;
    let retired = ()=>0;
    let exitValue = ()=>0;
    let exitSize = ()=>0;
    const instantiate = ()=>{
        const exports = /** @type {any} */ (
            new WebAssembly.Instance(wasmModule(), { env: { memory } }).exports);
        exports.configure(layout.ramBase, layout.tables + Tables.PAGE_FLAGS,
            layout.tables + Tables.CODE_RANGES, layout.tables + Tables.HASH, layout.hashShift ?? 16,
            layout.regs, layout.eip, layout.eflags, layout.fsBase, area, HOT_SLOTS, hotThreshold,
            // No port a byte or a word can name: every `out` is left to the JavaScript tier.
            trapPort ?? 0x10000, parkBase >>> 0);
        ({ retired, exitValue, exitSize } = exports);
        run = /** @type {(budget: number) => number} */ (exports.run);
        return run;
    };
    const view = new DataView(memory.buffer);
    const starts = new Uint32Array(memory.buffer, area + HOT_SLOTS, RING_STARTS);
    const index = area + HOT_SLOTS + RING_STARTS * 4;
    return {
        run(budget){
            // The record a region left, folded into the word the tier reads.
            eflagsOf(view, layout);
            return (run ?? instantiate())(budget);
        },
        retired: ()=>retired(),
        exitValue: ()=>exitValue() >>> 0,
        exitSize: ()=>exitSize(),
        hotCounts: new Uint8Array(memory.buffer, area, HOT_SLOTS),
        starts,
        startIndex: ()=>view.getUint32(index, true),
        setStartIndex(value){
            view.setUint32(index, value >>> 0, true);
        },
        started: ()=>compiled !== null,
        stretch,
    };
}
