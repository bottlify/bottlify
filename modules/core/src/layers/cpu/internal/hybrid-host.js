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
 * re-executing the instruction), or for a trap, the emulator takes a turn
 * with the rest -- and returns when the guest arrives at a page the
 * translator holds code for (the emulator's handoff bit), after which the
 * loop goes round again. A `stale` exit (the region wrote into translated
 * code) continues at the next instruction; a `halt` puts the processor where
 * the emulator's own `hlt` would.
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
    // Slices the emulator ended at an address the translator had an entry
    // for: a handoff that did not happen, which a build without the export
    // makes of every one.
    let handoffMisses = 0;
    host.corkDiagnostics = ()=>(cork ? { ...cork.diagnostics(), handoffMisses } : null);
    if (cork)
    {
        const runtime = cork;
        const handoff = typeof emulator.handoffAvailable === 'function'
            && emulator.handoffAvailable();
        /**
         * A host write into guest memory (the loader placing an image, a
         * handler filling a buffer) may land on a page the translator holds
         * code for: every page the write touches is invalidated. The
         * emulator's own compiler already watches its writes this way.
         *
         * @param {number} address @param {number} length
         */
        const invalidate = (address, length)=>{
            if (length <= 0)
            {
                return;
            }
            const last = (address + length - 1) >>> 12;
            for (let page = address >>> 12; page <= last; page++)
            {
                runtime.invalidatePage(page);
            }
        };
        host.writePhysical = (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>{
            emulator.writePhysical(address, bytes);
            invalidate(address, bytes.length);
        };
        host.writeData = (/** @type {number} */ address, /** @type {Uint8Array} */ bytes)=>{
            const result = emulator.writeData(address, bytes);
            invalidate(address, bytes.length);
            return result;
        };
        /** @param {number} address @param {number} value @param {number} length */
        host.fillData = (address, value, length)=>{
            const result = emulator.fillData(address, value, length);
            invalidate(address, length);
            return result;
        };
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
            // Set when the translator answered for an address but ran nothing
            // (an entry compiled for another x87 top): the emulator's turn,
            // not a spin.
            let emulatorNext = false;
            while (remaining > 0 && !emulator.halted())
            {
                const eip = emulator.eip();
                const entry = emulatorNext ? -1 : runtime.entryOf(eip, emulator.x87Top());
                emulatorNext = false;
                if (entry >= 0)
                {
                    const control = emulator.x87Control();
                    const exit = runtime.run(entry, remaining);
                    if (emulator.x87Control() !== control)
                    {
                        emulator.syncX87Control();
                    }
                    remaining -= exit.retired;
                    ran += exit.retired;
                    if (exit.kind === 'halt')
                    {
                        emulator.halt();
                        return ran;
                    }
                    // A fault or a trap is the emulator's to raise by
                    // re-executing the instruction, whatever entry stands
                    // there; so is an address the translator answered for but
                    // ran nothing at. Budget, stale and a progressed
                    // untranslated exit are looked up afresh.
                    if (exit.kind === 'trap' && typeof emulator.raiseTrap === 'function')
                    {
                        // The translator left past an `out` to the trap
                        // port with the state block complete: the handler
                        // runs as the port write would have run it, on the
                        // register file, and the next round looks up
                        // wherever it left EIP.
                        emulator.raiseTrap(emulator.readReg32('eax'));
                        continue;
                    }
                    if (exit.kind === 'fault' || exit.kind === 'trap'
                        || (exit.retired === 0 && emulator.eip() === eip))
                    {
                        emulatorNext = true;
                    }
                    continue;
                }
                // The emulator's turn: with the handoff bit it returns when the
                // guest arrives at a translated page and the loop goes round;
                // without it, it runs to a boundary of its own and the slice
                // ends -- a stop at a translated address is then a miss.
                const stepped = emulator.runSlice(remaining);
                remaining -= stepped;
                ran += stepped;
                if (stepped === 0)
                {
                    break;
                }
                if (!handoff)
                {
                    if (runtime.holdsPage(emulator.eip() >>> 12))
                    {
                        handoffMisses++;
                    }
                    break;
                }
            }
            return ran;
        };
    }
    return host;
}
