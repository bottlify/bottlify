/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The hash cork names code and keys by, written once: FNV-1a, 32 bits, and a
 * second lane beside it for a 64-bit key - FNV-1a from its own basis over
 * each byte mixed with its position's low byte, so two inputs one lane takes
 * for one are unlikely to meet in the other as well.
 *
 * The steps rather than whole functions: what is hashed is read through a
 * callback, a byte at a time, from several spans, masked or tagged
 * (`region.js` `hashOfPlan`, `helpers.js` `fingerprint`), and a step each lane
 * lets every such loop keep its shape and make nothing. The answers are kept
 * (record keys in the translation store, the CRT dictionary's fingerprints,
 * kept functions' names), so `hash.test.js` holds them to the vectors and to
 * the code they replaced.
 */

/** FNV-1a's offset basis, 32 bits: the hash of nothing. */
export const FNV_OFFSET = 0x811c9dc5;
/** FNV-1a's prime, 32 bits. */
export const FNV_PRIME = 0x01000193;
/** The position lane's basis. */
export const POSITION_OFFSET = 0x050c5d1f;

/**
 * One unit into FNV-1a. Signed: a caller that shows or keeps the hash takes
 * `>>> 0` of it once, at the end.
 *
 * @param {number} hash @param {number} unit
 * @returns {number}
 */
export const fnv1aStep = (hash, unit)=>Math.imul(hash ^ unit, FNV_PRIME);

/**
 * One byte into the position lane, `at` its place in what is hashed.
 *
 * @param {number} hash @param {number} byte @param {number} at
 * @returns {number}
 */
export const positionStep = (hash, byte, at)=>Math.imul(hash ^ byte ^ at & 0xff, FNV_PRIME);

/**
 * FNV-1a over a string's UTF-16 units.
 *
 * @param {string} text
 * @param {number} [hash]  the hash this continues from
 * @returns {number} unsigned
 */
export function fnv1aString(text, hash = FNV_OFFSET){
    let h = hash;
    for (let at = 0; at < text.length; at++)
    {
        h = Math.imul(h ^ text.charCodeAt(at), FNV_PRIME);
    }
    return h >>> 0;
}
