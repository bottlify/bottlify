/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The corpus cases an engine is known to get wrong, each with the reason: the
 * reviewed list, never a mask. A listed case must still diverge on the tiers
 * it names -- one that passes is stale and fails the suite until it is taken
 * off -- and its bytes must be the corpus's, so a regenerated corpus does not
 * carry the list over to other cases.
 *
 * Test support only.
 */

/**
 * @typedef {Object} KnownFailure
 * @property {number} index    the case's place in the corpus
 * @property {string} code     its bytes, as hex
 * @property {('interpreter' | 'wasm' | 'translated')[]} tiers
 * @property {string} reason
 */

/**
 * FSTP1 (D9 D8+i) is an alias of FSTP ST(i) the SDM's opcode map leaves out;
 * the engine runs it as FSTP. On an empty ST(0) the processor the corpus was
 * made on raised no stack fault, left ST(i) and its tag as they were and only
 * popped, where FSTP raises IE and SF and stores the indefinite. Measured on
 * one processor only, so it is listed rather than taken into the engine.
 */
const FSTP1_EMPTY = 'FSTP1 (D9 D8+i) on an empty ST(0): the processor only pops';
/** @type {KnownFailure['tiers']} */
const EVERY_TIER = ['interpreter', 'wasm', 'translated'];

/** @type {readonly KnownFailure[]} */
export const KNOWN_FAILURES = Object.freeze(/** @type {KnownFailure[]} */ ([
    { index: 1983, code: 'c746c817adfc19db46c8dbe3d9d9', tiers: EVERY_TIER, reason: FSTP1_EMPTY },
    { index: 5867, code: 'ddddd9eed9f7d9d8c7843dc80000005488ee16c7843dcc000000ee1ea93bdfac3dc8'
        + '000000d9f7', tiers: EVERY_TIER, reason: FSTP1_EMPTY },
    { index: 9530, code: 'ddbc3bcc000000d9dcc7443bd47b146e67c7443bd8d8b6fabfdd443bd466d9fed9f6',
        tiers: EVERY_TIER, reason: FSTP1_EMPTY },
    { index: 12251, code: 'd9d8', tiers: EVERY_TIER, reason: FSTP1_EMPTY },
]));

/**
 * Whether a case's divergences are a listed failure on this tier: 'known' when
 * listed and diverging, 'stale' when listed and passing, 'judged' otherwise.
 *
 * @param {import('./x86-corpus.js').X86Case} one
 * @param {{ name: string }[]} divergences
 * @param {'interpreter' | 'wasm' | 'translated'} tier
 * @returns {'known' | 'stale' | 'judged'}
 */
export function judged(one, divergences, tier){
    const listed = KNOWN_FAILURES.find(known=>known.index === one.index);
    if (listed === undefined || !listed.tiers.includes(tier))
    {
        return 'judged';
    }
    if (listed.code !== Buffer.from(one.code.subarray(0, -1)).toString('hex'))
    {
        throw new Error(`known failure #${listed.index} names other bytes than the corpus's case`);
    }
    return divergences.length > 0 ? 'known' : 'stale';
}
