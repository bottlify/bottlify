/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Long-mode code run by the shared runtime (`runtime/runtime.js` over a 64-bit
 * layout): its regions, its entry hash and transfers between them, the
 * interpreter (`interp64.js`) taking cold code and every fault, as the
 * smallest host of the runtime does (`machine.js`), for `testing/long-machine.js`
 * to drive: `run(state, budget)`, `invalidate`, `stats`. A write to the trap
 * port (`config.trapPort`) is the interpreter's: its value goes on the state's
 * `trapped`, and the program on past it.
 */

import { createCorkRuntime } from '../runtime/runtime.js';
import { eflagsOf } from '../emit/flags.js';
import { pageFlagsAt } from '../runtime/layout.js';
import { PageFlag } from '../runtime/pages.js';
import { interpret64 } from '../interp64.js';
import { WasmExit } from '../interp-wasm.js';
import { features as probeFeatures } from '../wasm/features.js';

/**
 * With `tier`, the interpreter tier in wasm (`createWasmInterpreter`) runs what no
 * region holds, from translated code's misses as from here, as the core's host
 * installs it (`interpretWith`); what it stops for answered as the host answers it.
 *
 * @param {{ memory: WebAssembly.Memory, ram?: WebAssembly.Memory,
 *     layout: import('../../../core/src/layers/cpu/engine.js').StateLayout,
 *     config?: Record<string, unknown>, defaultNaNNegative?: boolean,
 *     tier?: import('../../../core/src/layers/cpu/engine.js').WasmInterpreter | null }} settings
 *     `defaultNaNNegative`: the float code as for that host (false: an arm64 one), the
 *     host's own unless given; `ram`: a wide window's RAM (`ramMemory`)
 */
export function createRuntimeRunner64({ memory, ram, layout, config = {},
    defaultNaNNegative = undefined, tier = null })
{
    const flagsAt = pageFlagsAt(layout);
    const bytes = ()=>new Uint8Array(memory.buffer);
    const ramBytes = ()=>new Uint8Array((ram ?? memory).buffer);
    const view = ()=>new DataView(memory.buffer);
    /** @param {number} address */
    const read = address=>((bytes()[flagsAt + Math.floor(address / 4096)]
        & PageFlag.INACCESSIBLE) === 0 ? ramBytes()[layout.ramBase + address] : 0);
    /** The state the current run is of, whose `trapped` a trap goes on. @type {any} */
    let current = null;
    const stats = { translated: 0, interpreted: 0, exits: 0, stepped: 0, tiered: 0, traps: 0 };
    // A NaN an operation makes carries the host's sign unless `exactNaN` asks for
    // x86's (roadmap/decisions.md): where the code is made for a host whose default
    // NaN is positive, an arm64 one, the runner is held to the interpreter's NaNs
    // with the fix-ups that make them, as the sequence judge is.
    const exact = (defaultNaNNegative ?? probeFeatures().defaultNaNNegative)
        || 'exactNaN' in config ? {} : { exactNaN: true };
    const runtime = createCorkRuntime({
        memory, ram, layout,
        ...defaultNaNNegative === undefined ? {}
            : { features: { ...probeFeatures(), defaultNaNNegative } },
        config: { feed: 'slice', precise: true, hotThreshold: 1, missThreshold: 1,
            // The harness rewrites one code page for every case: never left to the interpreter.
            volatileWindowMs: 0, ...exact, ...config },
        read,
        imports: {
            trap: (/** @type {number} */ value)=>{
                stats.traps++;
                current.trapped.push(value >>> 0);
                return 0;
            },
            rdtsc: ()=>0n,
        },
    });
    if (tier !== null)
    {
        runtime.interpretWith?.(tier.entry(), tier.entered);
    }
    /** Ranges the caller or the interpreter rewrote, dropped before the next region
     * runs: the runtime drops a region only for bytes that changed, which they
     * have by then. @type {number[][]} */
    const rewritten = [];
    const rip = ()=>view().getBigUint64(layout.eip, true);

    /** The starts, with their tops, asked of the translator since the code last changed. */
    const asked = new Set();

    /**
     * The entry for `at`: every start is hot here, asked of the translator the
     * first time it is met (formed in the call: the runtime has no worker here).
     * @param {bigint} at
     */
    // The translator's addresses are offsets in the code block (`codeBase`).
    const codeBase = BigInt(layout.codeBase ?? 0);
    const entryAt = (/** @type {bigint} */ at)=>{
        if (at < codeBase || at - codeBase >= 2n ** 32n)
        {
            return -1;
        }
        const address = Number(at - codeBase);
        // Regions are compiled for the x87 stack's top they are entered with.
        const top = view().getUint8(layout.x87Top);
        const key = `${address}@${top}`;
        let entry = runtime.entryOf(address, top);
        if (entry < 0 && !asked.has(key))
        {
            asked.add(key);
            runtime.noteHot(address, top, 1);
            void runtime.translatePending();
            entry = runtime.entryOf(address, top);
        }
        return entry;
    };

    /**
     * One instruction on the interpreter, the record folded into the word it reads.
     * @param {any} state
     */
    const step = state=>{
        eflagsOf(view(), layout);
        state.syncIn();
        stats.interpreted += interpret64(state, 1, { force: true, shouldStop: ()=>true });
        state.syncOut();
        stats.stepped++;
    };

    return {
        stats,
        runtime,
        /**
         * @param {any} state @param {number} budget
         * @returns {number} retired
         */
        run(state, budget){
            state.syncOut();
            current = state;
            const before = state.retired;
            while (state.retired - before < budget && !state.halted)
            {
                // Code the interpreter wrote, its regions gone before any runs
                // again, as the host's write hook drops them.
                for (const [address, size] of rewritten.splice(0))
                {
                    runtime.codeWritten(address, size);
                    asked.clear();
                }
                // What the runtime noted itself (its misses), formed now.
                void runtime.translatePending();
                const at = rip();
                const entry = entryAt(at);
                if (entry < 0)
                {
                    step(state);
                    continue;
                }
                const exit = runtime.run(entry, budget - (state.retired - before));
                state.retired += exit.retired;
                stats.translated += exit.retired;
                if (exit.kind === 'interpreted')
                {
                    // The tier ran in place of a miss and stopped: what for.
                    stats.tiered++;
                    const code = exit.vector & 0xff;
                    if (code === WasmExit.CODE_WRITE)
                    {
                        const held = /** @type {NonNullable<typeof tier>} */ (tier);
                        runtime.codeWritten(held.exitValue(), held.exitSize());
                        asked.clear();
                    }
                    else if (code === WasmExit.HALT)
                    {
                        state.halted = true;
                    }
                    else if (code === WasmExit.FAULT || code === WasmExit.UNSUPPORTED)
                    {
                        step(state);
                    }
                    continue;
                }
                if (exit.kind === 'halt')
                {
                    state.halted = true;
                }
                else if (exit.kind === 'trap')
                {
                    // Past the write, the handler's to answer: the value in eax.
                    stats.traps++;
                    state.trapped.push(view().getUint32(layout.regs, true));
                }
                else if (exit.kind === 'fault' || exit.retired === 0 && rip() === at)
                {
                    stats.exits++;
                    step(state);
                }
            }
            eflagsOf(view(), layout);
            state.syncIn();
            return state.retired - before;
        },
        /** @param {number} address @param {number} size */
        invalidate(address, size){
            rewritten.push([address, size]);
        },
        /** @param {number} base @param {number} size */
        noteStack(base, size){
            runtime.noteStack(base, size);
        },
        readsFaulted(){
            runtime.readsFaulted?.();
        },
    };
}
