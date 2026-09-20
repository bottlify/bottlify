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
 * With no translator attached (`cork: null`) this is the emulator's host under
 * another name, which is deliberately the first thing built: the plumbing a
 * launch selects with `engine: 'hybrid'` has to run a program exactly as
 * `engine: 'emulator'` does before a single region is translated, and the
 * instruction counts of the two are compared to the instruction to prove it.
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
    // that. Functions are wrapped so a later step can take one over (the
    // slice loop); anything else -- a constant, the profile object -- is the
    // same value.
    for (const key of Object.keys(emulator))
    {
        const member = emulator[key];
        host[key] = typeof member === 'function'
            ? (/** @type {any[]} */ ...args)=>member.apply(emulator, args)
            : member;
    }
    host.engine = ()=>'hybrid';
    host.corkDiagnostics = ()=>(cork ? cork.diagnostics() : null);
    return host;
}
