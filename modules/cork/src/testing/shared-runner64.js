/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Long-mode code run as regions of the shared emitter (`emit/region.js` at the
 * 64-bit width), for its tests: a region formed and translated at each start
 * the first time it is met, run until it leaves, the interpreter
 * (`interp64.js`) taking one instruction where a region leaves without
 * retiring anything and every fault, which it raises where the processor
 * does. The interface of the long runner's that `testing/long-machine.js`
 * drives -- `run(state, budget)`, `invalidate`, `stats` -- so its corpus and
 * programs judge this emitter the same way.
 */

import { formRegion } from '../region.js';
import { MODE_64 } from '../decode/decoder.js';
import { ModuleBuilder } from '../wasm/encoder.js';
import { features } from '../wasm/features.js';
import {
    Exit, emitRegion, enterRegion, finishModule, mathImports, prepareModule,
} from '../emit/region.js';
import { buildHelpersModule } from '../emit/helpers.js';
import { eflagsOf } from '../emit/flags.js';
import { translatesLong } from '../emit/integer.js';
import { pageFlagsAt } from '../runtime/layout.js';
import { PageFlag } from '../runtime/pages.js';
import { interpret64 } from '../interp64.js';

/**
 * @param {{ memory: WebAssembly.Memory,
 *     layout: import('../../../core/src/layers/cpu/engine.js').StateLayout,
 *     precise?: boolean, leafCalls?: boolean, looseStacks?: boolean }} settings
 *     looseStacks: with precise false, the stack's accesses untested, as the runtime
 *     emits them until code is translated on a stack
 */
export function createSharedRunner64({ memory, layout, precise = true, leafCalls = true,
    looseStacks = false })
{
    const found = features();
    const flagsAt = pageFlagsAt(layout);
    const helpers = new WebAssembly.Instance(new WebAssembly.Module(
        /** @type {Uint8Array<ArrayBuffer>} */ (buildHelpersModule(layout))),
    { env: { memory } }).exports;
    /** @type {Map<number, { fn: Function, labels: Map<number, number> } | null>} */
    const regions = new Map();
    const stats = { regions: 0, translated: 0, interpreted: 0, exits: 0, stepped: 0 };
    const bytes = ()=>new Uint8Array(memory.buffer);
    const view = ()=>new DataView(memory.buffer);
    /** @param {number} page */
    const open = page=>(bytes()[flagsAt + page] & PageFlag.INACCESSIBLE) === 0;
    /** @param {number} address */
    const read = address=>(address < 2 ** 32 && open(address >>> 12)
        ? bytes()[layout.ramBase + address] : 0xf4);

    /** @param {number} entry */
    const form = entry=>{
        const region = formRegion(read, entry, { mode: MODE_64, helpers: false, leafCalls,
            translatable: at=>open(at >>> 12), translates: translatesLong });
        if (region.blocks.every(block=>block.instructions.length === 0))
        {
            regions.set(entry, null);
            return null;
        }
        const m = new ModuleBuilder();
        const context = prepareModule(m, layout, found, {}, { precise, looseStacks });
        const translation = emitRegion(context, region, { entryTop: 0, checked: true });
        finishModule(context, [translation.functionIndex]);
        m.exportFunction('region', translation.functionIndex);
        const built = m.toBytes();
        const instance = new WebAssembly.Instance(new WebAssembly.Module(built), {
            env: { memory, ...mathImports(), ...helpers, trap: ()=>0, rdtsc: ()=>0n },
        });
        const unit = { fn: /** @type {Function} */ (instance.exports.region),
            labels: translation.labels };
        regions.set(entry, unit);
        stats.regions++;
        return unit;
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
        /**
         * @param {any} state @param {number} budget
         * @returns {number} retired
         */
        run(state, budget){
            state.syncOut();
            const before = state.retired;
            while (state.retired - before < budget && !state.halted)
            {
                const at = Number(view().getBigUint64(layout.eip, true));
                const unit = regions.has(at) ? regions.get(at) : form(at);
                const label = unit?.labels.get(at);
                if (unit === null || unit === undefined || label === undefined)
                {
                    step(state);
                    continue;
                }
                const counted = view().getUint32(layout.counter, true);
                const code = enterRegion(unit.fn, label, budget - (state.retired - before),
                    view(), layout) >>> 0;
                const ran = (view().getUint32(layout.counter, true) - counted) >>> 0;
                state.retired += ran;
                stats.translated += ran;
                const kind = code & 0xff;
                if (kind === Exit.HALT)
                {
                    state.halted = true;
                }
                else if (kind === Exit.FAULT
                    || kind === Exit.UNTRANSLATED && ran === 0
                        && Number(view().getBigUint64(layout.eip, true)) === at)
                {
                    stats.exits++;
                    step(state);
                }
            }
            eflagsOf(view(), layout);
            state.syncIn();
            return state.retired - before;
        },
        /** Drops every region: the tests rewrite their code area in place. */
        invalidate(){
            regions.clear();
        },
    };
}
