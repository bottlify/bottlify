/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The hybrid host: one register file, one memory, two executors.
 *
 * The emulator runs everything a translator has not translated; the
 * translator runs the regions it has. Both work on the emulator's own
 * register file inside its exported memory, so a switch between them copies
 * nothing, and everything the layer asks of a host -- registers, memory,
 * traps, contexts, the count -- is answered by the emulator's host as before.
 *
 * The one thing taken over is the slice: while the guest stands at an
 * address the translator has an entry for, the translator runs it with what
 * remains of the slice's budget; when it leaves for an address it has not
 * translated, for a fault (which the emulator then raises the ordinary way,
 * re-executing the instruction), or for a trap, the emulator takes one turn
 * with the rest. A `stale` exit (the region wrote into translated code)
 * continues at the next instruction; a `halt` puts the processor where the
 * emulator's own `hlt` would.
 *
 * With no translator attached (`cork: null`) this is the emulator's host under
 * another name: the plumbing a launch selects with `engine: 'hybrid'` runs a
 * program exactly as `engine: 'emulator'` does before a single region is
 * translated, and the instruction counts of the two are compared to the
 * instruction to prove it.
 */

/**
 * @param {Object} parts
 * @param {any} parts.emulator   The emulator's host (`createV86Host`).
 * @param {import('../engine.js').Runtime | null} parts.cork
 *     The translator's runtime, or null while there is none.
 */
export function createHybridHost({ emulator, cork }){
    /** @type {Record<string, any>} */
    const host = {};
    // Every member the emulator's host has, forwarded by name rather than
    // listed here: a member added to the emulator's host later must not
    // silently be missing from this one, and enumeration is what guarantees
    // that. Functions are wrapped so the slice loop can take one over;
    // anything else -- a constant, the profile object -- is the same value.
    for (const key of Object.keys(emulator))
    {
        const member = emulator[key];
        host[key] = typeof member === 'function'
            ? (/** @type {any[]} */ ...args)=>member.apply(emulator, args)
            : member;
    }
    host.engine = ()=>'hybrid';
    host.cork = ()=>cork;
    host.corkDiagnostics = ()=>(cork ? cork.diagnostics() : null);
    if (cork)
    {
        const runtime = cork;
        /**
         * Runs at most `maxInstructions` across the two executors and
         * answers how many were retired.
         *
         * @param {number} maxInstructions
         * @returns {number}
         */
        host.runSlice = maxInstructions=>{
            let remaining = maxInstructions;
            let ran = 0;
            while (remaining > 0)
            {
                const eip = emulator.eip();
                const entry = runtime.entryOf(eip, emulator.x87Top());
                if (entry < 0)
                {
                    break;
                }
                const exit = runtime.run(entry, remaining);
                remaining -= exit.retired;
                ran += exit.retired;
                if (exit.kind === 'untranslated' && exit.retired === 0 && emulator.eip() === eip)
                {
                    // A region that leaves at once (an entry compiled for
                    // another x87 top): the emulator's turn, not a spin.
                    break;
                }
                if (exit.kind === 'halt')
                {
                    emulator.halt();
                    return ran;
                }
                if (exit.kind !== 'budget' && exit.kind !== 'stale')
                {
                    // untranslated, fault, trap: the emulator's turn.
                    break;
                }
            }
            if (remaining <= 0 || emulator.halted())
            {
                return ran;
            }
            // One turn for the emulator per slice: it runs to a boundary of
            // its own choosing. Returning to the translator mid-slice is the
            // handoff step (`roadmap/cork-plan.md` 2.7).
            return ran + emulator.runSlice(remaining);
        };
    }
    return host;
}
