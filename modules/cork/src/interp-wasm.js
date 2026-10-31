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
 * flags kept lazy, x87 and SSE as `ir-x87.js` and `ir-simd.js` model them, and
 * leaves the rest -- MMX, the rare and system forms -- to the JavaScript
 * interpreter an instruction at a time: `run` answers `WasmExit.UNSUPPORTED`
 * with eip at the instruction, unexecuted.
 *
 * It keeps the host's hotness counts and its ring of recent run starts in an
 * area of the memory past the tables (`WASM_INTERPRETER_AREA` bytes), so both
 * interpreters count the same starts, and it looks a jump's target up in the
 * entry hash translated code probes: a start with a region leaves the run.
 *
 * Over a 64-bit layout it is the same source built with LONG defined
 * (`interp-wasm64.bytes.js`): long mode's tier, whose reference is `ir64.js`
 * and which leaves what it does not run to `interp64.js` the same way, RIP at
 * the instruction.
 */

import { MODULE_BASE64 } from './interp-wasm.bytes.js';
import { MODULE_BASE64 as MODULE_BASE64_LONG } from './interp-wasm64.bytes.js';
import { eflagsOf } from './emit/flags.js';
import { Tables, codeRangesAt, pageFlagsAt } from './runtime/layout.js';
import { withSharedMemoryImport } from './wasm/shared-import.js';

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
/** Bytes the tier keeps past the tables: the counts, the ring, the ring's next index and
 * what its runs from translated code have retired. */
export const WASM_INTERPRETER_AREA = HOT_SLOTS + RING_STARTS * 4 + 8;
/** Bytes an executor keeps for an instance's data and stack, its statics: the module is
 * position-independent, so each executor's instance has its own (the build fails past it). */
export const WASM_INTERPRETER_STATICS = 12288;
/** Where they lie from an executor's state block: in the page it keeps below guest RAM. */
export const WASM_INTERPRETER_STATICS_AT = 4096;
/** Of them, the stack's, below the top. */
export const WASM_INTERPRETER_STACK = 8192;

/** The transcendentals the module imports: the host's, as the JavaScript
 * interpreter's and translated code's are, so every tier computes the same. */
export const HOST_MATH = Object.freeze({
    sin: Math.sin, cos: Math.cos, tan: Math.tan, atan2: Math.atan2, expm1: Math.expm1,
    log2: Math.log2, log1p: Math.log1p,
});

/** What the process's hosts ran on the JavaScript interpreter before one started the tier: its
 * start is paid once a process, so the stretch that waits for it to pay is the process's too. */
const stretch = { work: 0 };

/**
 * The modules compiled so far, each once a process: by build (32-bit code's,
 * long mode's) and by whether its memory import is declared shared.
 *
 * @type {Map<string, WebAssembly.Module>}
 */
const compiled = new Map();

/**
 * The module, compiled once a process: its memory import declared shared for
 * a shared memory, which an import declared otherwise does not link to.
 *
 * @param {boolean} shared @param {boolean} long  long mode's build
 */
function wasmModule(shared, long){
    const key = `${long ? 64 : 32}${shared ? 's' : ''}`;
    let module = compiled.get(key);
    if (module === undefined)
    {
        const text = atob(long ? MODULE_BASE64_LONG : MODULE_BASE64);
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++)
        {
            bytes[i] = text.charCodeAt(i);
        }
        module = new WebAssembly.Module(shared
            ? /** @type {Uint8Array<ArrayBuffer>} */ (withSharedMemoryImport(bytes)) : bytes);
        compiled.set(key, module);
    }
    return module;
}

/** @typedef {import('../../core/src/layers/cpu/engine.js').WasmInterpreter} WasmInterpreter */

/**
 * The tier over one memory, or null for a layout it cannot run over: one
 * without an `fs` base, or a memory without room for its areas. A 64-bit
 * layout (`bits` 64) gets long mode's build.
 *
 * @param {{ memory: WebAssembly.Memory,
 *     layout: import('../../core/src/layers/cpu/engine.js').StateLayout,
 *     area: number, statics: number, hotThreshold: number, trapPort?: number,
 *     parkBase: number, precise?: boolean, atomic?: boolean }} options
 *     area: where the tier's `WASM_INTERPRETER_AREA` bytes lie; statics: where the
 *     instance's `WASM_INTERPRETER_STATICS` bytes, its data and stack, lie; parkBase: the
 *     park loop's address, whose jumps the ring leaves out; precise: the engine's `precise`,
 *     the x87 bookkeeping games do not read kept as the JavaScript interpreter keeps it;
 *     atomic: the engine's `atomic`, every locked instruction left to the JavaScript tier
 * @returns {WasmInterpreter | null}
 */
export function createWasmInterpreter({ memory, layout, area, statics, hotThreshold, trapPort,
    parkBase, precise = false, atomic = false })
{
    const long = layout.bits === 64;
    if (layout.fsBase < 0
        || area + WASM_INTERPRETER_AREA > memory.buffer.byteLength
        || statics + WASM_INTERPRETER_STATICS > memory.buffer.byteLength)
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
    let relaxedReads = ()=>0;
    let exitValue = ()=>0;
    let exitSize = ()=>0;
    /** @type {((budget: number) => number) | null} */
    let enter = null;
    const instantiate = ()=>{
        const shared = typeof SharedArrayBuffer === 'function'
            && memory.buffer instanceof SharedArrayBuffer;
        const exports = /** @type {any} */ (new WebAssembly.Instance(wasmModule(shared, long), {
            env: {
                memory, ...HOST_MATH,
                __memory_base: new WebAssembly.Global({ value: 'i32', mutable: false }, statics),
                __stack_pointer: new WebAssembly.Global({ value: 'i32', mutable: true },
                    statics + WASM_INTERPRETER_STATICS),
                __table_base: new WebAssembly.Global({ value: 'i32', mutable: false }, 0),
                __indirect_function_table: new WebAssembly.Table({ initial: 0,
                    element: 'anyfunc' }),
            },
        }).exports);
        exports.__wasm_apply_data_relocs?.();
        exports.configure(layout.ramBase, pageFlagsAt(layout),
            codeRangesAt(layout), layout.tables + Tables.HASH, layout.hashShift ?? 16,
            layout.regs, layout.eip, layout.eflags, layout.fsBase, area, HOT_SLOTS, hotThreshold,
            // No port a byte or a word can name: every `out` is left to the JavaScript tier.
            trapPort ?? 0x10000, parkBase >>> 0);
        if (long)
        {
            exports.configureLong(layout.gsBase);
        }
        exports.configureFloat(layout.x87, layout.x87Top, layout.x87Empty, layout.x87Control,
            layout.x87Status, precise ? 1 : 0, layout.xmm, layout.mxcsr);
        exports.configureEntry(layout.counter);
        // Zero is no place: the block's first word is a register, never the marks.
        exports.configureExact(layout.x87Exact ?? 0);
        exports.configureAtomic(atomic ? 1 : 0);
        ({ retired, relaxedReads, exitValue, exitSize, enter } = exports);
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
        relaxedReads: ()=>relaxedReads(),
        exitValue: ()=>exitValue() >>> 0,
        exitSize: ()=>exitSize(),
        entry(){
            if (run === null)
            {
                instantiate();
            }
            return /** @type {(budget: number) => number} */ (enter);
        },
        entered: ()=>view.getUint32(index + 4, true),
        hotCounts: new Uint8Array(memory.buffer, area, HOT_SLOTS),
        starts,
        startIndex: ()=>view.getUint32(index, true),
        setStartIndex(value){
            view.setUint32(index, value >>> 0, true);
        },
        started: ()=>compiled.size > 0,
        stretch,
    };
}
