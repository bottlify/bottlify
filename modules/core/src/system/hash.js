/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The run's two non-cryptographic hashes, written once: FNV-1a, 32 bits, for
 * a name or a key told apart from others in a table, and CRC-32, for damage
 * found in bytes. Each takes the hash it continues from, so a caller that
 * mixes several pieces passes one's answer to the next and none of them makes
 * an array or a string to join them.
 *
 * Several answers are kept where something outside the call compares them -
 * record names on OPFS, bundle CRCs, RtlComputeCrc32, the names a guest
 * routine looks up - so the outputs here are fixed: `hash.test.js` holds them
 * to the vectors and to the code they replaced.
 */

/** FNV-1a's offset basis, 32 bits: the hash of nothing. */
export const FNV_OFFSET = 0x811c9dc5;
/** FNV-1a's prime, 32 bits. */
export const FNV_PRIME = 0x01000193;

/**
 * FNV-1a over `units[0..end)`, each element mixed whole: bytes for a
 * Uint8Array, words for an Int32Array (one step a word, not FNV over its
 * bytes - a table key, not a digest anything outside compares).
 *
 * @param {ArrayLike<number>} units
 * @param {number} [hash]  the hash this continues from
 * @param {number} [end]
 * @returns {number} unsigned
 */
export function fnv1a(units, hash = FNV_OFFSET, end = units.length){
    let h = hash;
    for (let at = 0; at < end; at++)
    {
        h = Math.imul(h ^ units[at], FNV_PRIME);
    }
    return h >>> 0;
}

/**
 * FNV-1a over a string's UTF-16 units, each mixed whole.
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

/**
 * FNV-1a over a string as the bytes a copy of one byte a unit writes (each
 * unit's low byte): what a guest routine hashing that copy answers.
 *
 * @param {string} text
 * @param {number} [hash]  the hash this continues from
 * @returns {number} unsigned
 */
export function fnv1aLowBytes(text, hash = FNV_OFFSET){
    let h = hash;
    for (let at = 0; at < text.length; at++)
    {
        h = Math.imul(h ^ (text.charCodeAt(at) & 0xff), FNV_PRIME);
    }
    return h >>> 0;
}

/**
 * FNV-1a over a 32-bit value's four bytes, low first, as it lies in memory.
 *
 * @param {number} word
 * @param {number} [hash]  the hash this continues from
 * @returns {number} unsigned
 */
export function fnv1aWord(word, hash = FNV_OFFSET){
    let h = hash;
    for (let shift = 0; shift < 32; shift += 8)
    {
        h = Math.imul(h ^ (word >>> shift & 0xff), FNV_PRIME);
    }
    return h >>> 0;
}

/**
 * The second lane of a name made from content (`contentName`): FNV-1a's step
 * from another seed, folding its high bits down after each step, so it does
 * not collide where the first lane does.
 */
export const FOLDED_OFFSET = 0x050c5d1f;

/**
 * The folded lane over `units`, each element mixed whole, or over a string's
 * UTF-16 units.
 *
 * @param {ArrayLike<number> | string} units
 * @param {number} [hash]  the hash this continues from
 * @returns {number} unsigned
 */
export function folded(units, hash = FOLDED_OFFSET){
    let h = hash;
    if (typeof units === 'string')
    {
        for (let at = 0; at < units.length; at++)
        {
            h = Math.imul(h ^ units.charCodeAt(at), FNV_PRIME) ^ h >>> 15;
        }
    }
    else
    {
        for (let at = 0; at < units.length; at++)
        {
            h = Math.imul(h ^ units[at], FNV_PRIME) ^ h >>> 15;
        }
    }
    return h >>> 0;
}

/**
 * A name for a body of the run's cache by its content, a string or bytes:
 * FNV-1a and the folded lane, sixteen hex digits, and the length in base 36.
 * Not a promise of no collision - a cache keeping names this way compares
 * what it holds - only a name short enough for the cache's table. The cache
 * keeps these names, so the scheme is kept as it is.
 *
 * @param {ArrayLike<number> | string} content @returns {string}
 */
export function contentName(content){
    const a = typeof content === 'string' ? fnv1aString(content) : fnv1a(content);
    return `${a.toString(16).padStart(8, '0')}${folded(content).toString(16).padStart(8, '0')}`
        + `-${content.length.toString(36)}`;
}

/** @type {Uint32Array | null} */
let table = null;

/** Built on first use: a run that never checks a CRC does not pay its 1 KiB. */
function crcTable(){
    if (table === null)
    {
        table = new Uint32Array(256);
        for (let at = 0; at < 256; at++)
        {
            let value = at;
            for (let bit = 0; bit < 8; bit++)
            {
                value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
            }
            table[at] = value;
        }
    }
    return table;
}

/**
 * CRC-32 of zlib, PNG and ZIP: reflected, polynomial 0xEDB88320, inverted on
 * the way in and out. Continued from `crc`, as zlib's `crc32(crc, buf)`: the
 * CRC of two pieces is the first's passed to the second; 0 starts one.
 *
 * Four bytes rather than a digest, because what it defends against is damage
 * (a truncation, a spliced response, a bad byte) at a cost that does not
 * register beside the decompression next to it; a bundle that is not the
 * bundle is the manifest's digest's question.
 *
 * @param {Uint8Array} bytes
 * @param {number} [crc]  the CRC this continues from
 * @returns {number} unsigned, so it compares equal to what JSON carries
 */
export function crc32(bytes, crc = 0){
    const lookup = crcTable();
    let c = ~crc;
    for (let at = 0; at < bytes.length; at++)
    {
        c = lookup[(c ^ bytes[at]) & 0xff] ^ c >>> 8;
    }
    return ~c >>> 0;
}
