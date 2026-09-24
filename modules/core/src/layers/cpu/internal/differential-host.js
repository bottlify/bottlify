/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The differential host: the hybrid host, plus every region replayed on the
 * emulator and compared.
 *
 * `engine: 'differential'` runs a program as `hybrid` does -- the emulator
 * answers for everything the translator has not translated, the translator
 * runs the regions it has -- and, each time the translator runs a region,
 * replays that region on the emulator from the same state and compares the
 * two records. The emulator is the oracle: a region whose run leaves the same
 * registers, flags, x87, XMM and written bytes is accepted, and the first
 * region whose run does not is the divergence the mode exists to name.
 *
 * Both executors work on the emulator's own register file and memory (as in
 * hybrid), so the replay copies only what the region wrote: snapshot, run the
 * region (a differential build logs each store's old bytes in the undo ring),
 * snapshot with the spans the ring names, restore the registers and rewind the
 * stores newest first, run the emulator to the region's exit, snapshot the
 * same spans, compare. The guest then carries on from the translator's state,
 * exactly as hybrid leaves it, so a divergence is reported without changing
 * what the program does next.
 *
 * A region is not replayed when replaying it would not be the same run: it
 * called the host through the trap port (the handler would run a second time
 * -- an allocation made twice), or its stores overran the ring (it cannot be
 * rewound), nor one that left on its budget (it leaves at a block of its own,
 * which the emulator would reach on its first pass through a loop). All three
 * are counted in `skipped`. A region that stopped on a trap or
 * a fault is not replayed either: the emulator would answer it inline.
 */

import { createHybridHost } from './hybrid-host.js';

/**
 * @param {Object} parts
 * @param {any} parts.emulator   The emulator's host (`createV86Host`).
 * @param {import('../engine.js').Runtime | null} parts.cork  The translator's runtime.
 * @param {any} parts.engine  The cork engine module, exporting `snapshot`,
 *     `restore` and `compare` (its testing snapshot), and `readUndoLog`,
 *     `resetUndoLog` and `spansOf` for the stores.
 * @param {WebAssembly.Memory} [parts.memory]  The memory the undo ring is in.
 * @param {any} [parts.layout]  The layout the translator runs against.
 */
export function createDifferentialHost({ emulator, cork, engine, memory, layout }){
    const host = createHybridHost({ emulator, cork });
    host.engine = ()=>'differential';

    /** @type {{ at: number, diff: { name: string, expected: number | string,
     *     actual: number | string }[] } | null} */
    let first = null;
    let replayed = 0;
    let divergences = 0;
    let handoffMisses = 0;
    const skipped = { hostCalls: 0, overran: 0, budget: 0 };

    // Every call translated code makes into the host passes here: a region
    // that made one is not replayed, so no handler runs twice.
    let hostCalls = 0;
    const raiseTrap = emulator.raiseTrap;
    if (typeof raiseTrap === 'function')
    {
        emulator.raiseTrap = (/** @type {number} */ value)=>{
            hostCalls++;
            return raiseTrap.call(emulator, value);
        };
    }

    const runtime = cork;
    if (runtime)
    {
        const { snapshot, restore, compare } = engine;
        if (!snapshot || !restore || !compare)
        {
            throw new Error('cpu: the cork engine module does not export'
                + ' snapshot, restore and compare (differential)');
        }
        const handoff = typeof emulator.handoffAvailable === 'function'
            && emulator.handoffAvailable();
        const undo = memory !== undefined && layout !== undefined
            && typeof engine.readUndoLog === 'function';

        /** The stores a region run left in the undo ring, and the spans they cover.
         * @returns {{ entries: { address: number, old: Uint8Array }[], wrapped: boolean,
         *     spans: { address: number, length: number }[] }} */
        const storesOfRun = ()=>{
            if (!undo)
            {
                return { entries: [], wrapped: false, spans: [] };
            }
            const log = engine.readUndoLog(memory, layout);
            /** @type {{ start: number, end: number }[]} */
            const merged = engine.spansOf(log.entries);
            const spans = merged.map(one=>({ address: one.start, length: one.end - one.start }));
            return { ...log, spans };
        };

        /** Runs one region and replays it on the emulator, recording a
         * divergence the first time one is seen. Only a region whose exit is a
         * clean stop -- untranslated, budget or halt -- is replayed: a trap or
         * a fault stops the region at the instruction that raised it, and the
         * emulator's own run would answer it inline, so the two records would
         * never agree and every such region would read as a divergence.
         * @param {number} eip @param {number} entry @param {number} budget */
        const replayRegion = (eip, entry, budget)=>{
            const state = snapshot(emulator, []);
            if (undo)
            {
                engine.resetUndoLog(memory, layout);
            }
            const callsBefore = hostCalls;
            const exit = runtime.run(entry, budget);
            const stores = storesOfRun();
            const subjectState = snapshot(emulator, stores.spans);
            const clean = exit.kind === 'untranslated' || exit.kind === 'halt';
            if (exit.kind === 'budget')
            {
                // A budget exit leaves at a block of the region's own, a loop
                // head it may have passed many times: the emulator would stop
                // at the first pass, and no count lines the two up (they count
                // a rep-prefixed instruction differently).
                skipped.budget++;
                return exit;
            }
            if (!clean)
            {
                return exit;
            }
            if (hostCalls !== callsBefore)
            {
                skipped.hostCalls++;
                return exit;
            }
            if (stores.wrapped)
            {
                skipped.overran++;
                return exit;
            }
            restore(emulator, state);
            // The translator's stores rewound newest first, so every span holds
            // what the region found there when it began.
            for (let i = stores.entries.length - 1; i >= 0; i--)
            {
                emulator.writePhysical(stores.entries[i].address, stores.entries[i].old);
            }
            // The emulator answers the same code, run to where the region
            // left, not by the region's retired count: the two count a
            // rep-prefixed instruction differently (the translator retires
            // one per iteration, the emulator one per instruction), so a
            // count would put the emulator past the region's exit. One
            // instruction at a time is what stops it exactly on the exit's
            // address, where a larger slice could overshoot a branch.
            const target = subjectState.eip;
            let guard = exit.retired + 64;
            while (guard > 0 && !emulator.halted() && emulator.eip() !== target)
            {
                const stepped = emulator.runSlice(1);
                if (stepped === 0)
                {
                    break;
                }
                guard -= stepped;
            }
            const oracleState = snapshot(emulator, stores.spans);
            const landed = emulator.eip() === target;
            // The comparison masks the x87 status bits the two engines may
            // leave differently (the top, already compared on its own, and
            // the summary bits), the way the corpus's runner does.
            const diff = landed
                ? compare(oracleState, subjectState, { statusMask: 0xfdd5 })
                : [{ name: 'control', expected: `0x${(target >>> 0).toString(16)}`,
                    actual: `0x${(emulator.eip() >>> 0).toString(16)}` }];
            if (diff.length > 0)
            {
                divergences++;
                if (first === null)
                {
                    first = { at: eip, diff };
                }
            }
            replayed++;
            // The translator's registers and bytes back, as hybrid leaves them.
            restore(emulator, subjectState);
            return exit;
        };

        /**
         * The hybrid slice loop, with the translator's region runs replayed on
         * the emulator and compared. The loop's shape -- budget, halt, fault,
         * trap, the handoff that lets the emulator stop at a translated page --
         * is the hybrid's own, so the two runs differ only by the comparison.
         *
         * @param {number} maxInstructions
         * @returns {number}
         */
        host.runSlice = maxInstructions=>{
            let remaining = maxInstructions;
            let ran = 0;
            let emulatorNext = false;
            while (remaining > 0 && !emulator.halted())
            {
                const eip = emulator.eip();
                const entry = emulatorNext ? -1 : runtime.entryOf(eip, emulator.x87Top());
                emulatorNext = false;
                if (entry >= 0)
                {
                    const exit = replayRegion(eip, entry, remaining);
                    remaining -= exit.retired;
                    ran += exit.retired;
                    if (exit.kind === 'halt')
                    {
                        emulator.halt();
                        return ran;
                    }
                    if (exit.kind === 'trap' && typeof emulator.raiseTrap === 'function')
                    {
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

    /** The differential's own account, beside the hybrid's `corkDiagnostics`. */
    host.differentialDiagnostics = ()=>({
        replayed,
        divergences,
        handoffMisses,
        skipped: { ...skipped },
        first: first
            ? { at: `0x${(first.at >>> 0).toString(16).padStart(8, '0')}`, diff: first.diff }
            : null,
    });

    return host;
}
