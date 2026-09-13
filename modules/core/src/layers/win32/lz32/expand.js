/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The compressed file format the system's own COMPRESS tool wrote, and that
 * the LZ library and VerInstallFile expand: a `SETUP.DL_` beside a `SETUP.EXE`.
 *
 * The header is a signature, a mode byte, the last character of the original
 * name (which the tool replaced with an underscore) and the expanded length.
 * The body is LZSS over a 4 KiB ring that starts full of spaces, read sixteen
 * positions from its end: every control byte covers eight items, a set bit is
 * a literal and a clear one a two-byte reference whose twelve-bit position and
 * four-bit length name a run already in the ring.
 */

/** The eight signature bytes: `SZDD` and four that spell nothing. */
const SIGNATURE = [0x53, 0x5a, 0x44, 0x44, 0x88, 0xf0, 0x27, 0x33];
const HEADER_SIZE = 14;
/** The one compression mode the tool ever wrote. */
const MODE_A = 0x41;

const RING_SIZE = 4096;
const RING_START = RING_SIZE - 16;
const MIN_MATCH = 3;

/**
 * @typedef {Object} ExpandedHeader
 * @property {number} lastCharacter  What the underscore in the name stands for; zero when unknown.
 * @property {number} length         The expanded size the header promises.
 */

/**
 * The header, when the bytes carry one.
 *
 * @param {Uint8Array} bytes
 * @returns {ExpandedHeader | null}
 */
export function readHeader(bytes){
    if (bytes.length < HEADER_SIZE || SIGNATURE.some((byte, at)=>bytes[at] !== byte)
        || bytes[8] !== MODE_A)
    {
        return null;
    }
    return {
        lastCharacter: bytes[9],
        length: new DataView(bytes.buffer, bytes.byteOffset).getUint32(10, true),
    };
}

/**
 * The bytes a compressed file stands for; a file with no header is its own
 * expansion, which is what lets a program open either kind the same way.
 *
 * @param {Uint8Array} bytes
 * @returns {Uint8Array}
 */
export function expand(bytes){
    const header = readHeader(bytes);
    if (!header)
    {
        return bytes;
    }
    const out = new Uint8Array(header.length);
    const ring = new Uint8Array(RING_SIZE).fill(0x20);
    let ringAt = RING_START;
    let outAt = 0;
    let at = HEADER_SIZE;
    /** @param {number} byte */
    const emit = byte=>{
        if (outAt < out.length)
        {
            out[outAt++] = byte;
        }
        ring[ringAt] = byte;
        ringAt = (ringAt + 1) & (RING_SIZE - 1);
    };
    while (at < bytes.length && outAt < out.length)
    {
        const control = bytes[at++];
        for (let bit = 0; bit < 8 && at < bytes.length && outAt < out.length; bit++)
        {
            if ((control >> bit) & 1)
            {
                emit(bytes[at++]);
                continue;
            }
            if (at + 1 >= bytes.length)
            {
                break;
            }
            const low = bytes[at++];
            const high = bytes[at++];
            const from = low | (high & 0xf0) << 4;
            const length = (high & 0x0f) + MIN_MATCH;
            for (let step = 0; step < length; step++)
            {
                emit(ring[(from + step) & (RING_SIZE - 1)]);
            }
        }
    }
    return out;
}

/**
 * The name a compressed file had before the tool replaced its last letter.
 *
 * @param {string} name @param {ExpandedHeader | null} header
 */
export function expandedName(name, header){
    if (!header || header.lastCharacter === 0 || !name.endsWith('_'))
    {
        return name;
    }
    return name.slice(0, -1) + String.fromCharCode(header.lastCharacter);
}
