/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * CRC-32, the ordinary one: reflected, polynomial 0xedb88320, pre- and
 * post-inverted. The same function the writer and the reader must agree on, so
 * it lives where both can import it rather than being written twice.
 *
 * Four bytes rather than a cryptographic digest, because of what this defends
 * against. A block arrives over a transport that already authenticates it; what
 * is left is damage -- a truncation, a proxy splicing two responses, a bad byte
 * -- and a CRC catches that at a cost that does not register against the
 * decompression happening beside it. A bundle that is not the bundle is a
 * different question, answered by the digest in the manifest, which comes from
 * somewhere other than the bytes it describes.
 */

/** @type {Uint32Array | null} */
let table = null;

/** Built on first use: a build that never reads a bundle should not pay 1 KiB. */
function crcTable(){
    if (table)
    {
        return table;
    }
    table = new Uint32Array(256);
    for (let at = 0; at < 256; at++)
    {
        let value = at;
        for (let bit = 0; bit < 8; bit++)
        {
            value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
        }
        table[at] = value >>> 0;
    }
    return table;
}

/**
 * @param {Uint8Array} bytes
 * @returns {number} Unsigned, so it compares equal to what JSON carries.
 */
export function crc32(bytes){
    const lookup = crcTable();
    let crc = 0xffffffff;
    for (let at = 0; at < bytes.length; at++)
    {
        crc = lookup[(crc ^ bytes[at]) & 0xff] ^ crc >>> 8;
    }
    return (crc ^ 0xffffffff) >>> 0;
}
