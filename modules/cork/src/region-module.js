/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * One region of x86 code as a wasm module of its own, for reading rather than
 * running: what the translator makes of the bytes at an address, with the
 * blocks it formed and the instructions it refused.
 *
 * The module is the translator's as the runtime would build it alone -- no
 * entry hash, no shared table -- and imports what translated code always
 * does: the memory with cork's state block in it (`ownLayout`), the math
 * helpers and the trap port. `createMachine` is the way to run code; this is
 * the way to see it.
 */

import { formRegion } from './region.js';
import { ModuleBuilder } from './wasm/encoder.js';
import { features } from './wasm/features.js';
import { emitRegion, finishModule, prepareModule } from './emit/region.js';
import { ownLayout } from './runtime/layout.js';

/**
 * @param {{ code: ArrayLike<number>, at: number, entry?: number, precise?: boolean,
 *     atomic?: boolean, ramSize?: number, hash?: boolean, callReturn?: boolean,
 *     looseStacks?: boolean, structure?: boolean,
 *     expansion?: import('./emit/region.js').ExpansionNote | null, wide?: boolean,
 *     checked?: boolean }} what
 *     the bytes and the guest address they lie at; `entry` where the region starts (`at` by
 *     default); `precise`, `atomic`, `hash`, `callReturn`, `looseStacks`, `structure`: as the
 *     translator's configuration has them; `expansion` told each instruction's wasm bytes
 *     (a diagnostic build); `wide` the x87 compiled for double or extended precision, as a
 *     run whose control word says so has it; `checked` false the x87 stack's shape at the
 *     entry tested once rather than at every instruction, as the runtime speculates
 */
export function regionModule({ code, at, entry = at, precise = false, atomic = false,
    ramSize = 16 << 20, hash = false, callReturn = false, looseStacks = false,
    structure = true, expansion = null, wide = false, checked = true })
{
    const bytes = Uint8Array.from(code);
    // Bytes past the code read as `hlt`, so a region never runs off into them.
    const read = (/** @type {number} */ address)=>{
        const offset = address - at;
        return offset >= 0 && offset < bytes.length ? bytes[offset] : 0xf4;
    };
    const region = formRegion(read, entry, {});
    const m = new ModuleBuilder();
    const context = prepareModule(m, ownLayout({ ramSize }), features(), {},
        { precise, atomic, hash, callReturn: hash && callReturn, looseStacks, structure,
            expansion, wide });
    const translation = emitRegion(context, region, { entryTop: 0, checked });
    finishModule(context, [translation.functionIndex]);
    m.exportFunction('region', translation.functionIndex);
    const wasm = m.toBytes();
    return {
        wasm,
        entry: region.entry,
        blocks: region.blocks.map(block=>({ start: block.start,
            instructions: block.instructions.length })),
        bytes: region.bytes,
        refused: Object.fromEntries(region.refused),
    };
}
