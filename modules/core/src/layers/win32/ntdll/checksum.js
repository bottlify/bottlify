/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { wholeAddress } from '../common/pointers.js';

/**
 * The checksums ntdll computes over a caller's bytes.
 *
 * RtlComputeCrc32 is the CRC-32 of zlib and PNG (the reflected polynomial
 * 0xEDB88320, the value inverted on the way in and out), continued from the
 * value the caller passes: CRC over two pieces is the CRC of the first passed
 * to the second.
 */

/** The table of the reflected polynomial, made once. */
const TABLE = (()=>{
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++)
    {
        let c = n;
        for (let k = 0; k < 8; k++)
        {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        table[n] = c >>> 0;
    }
    return table;
})();

/**
 * The CRC-32 of `bytes`, continued from `initial`.
 *
 * @param {number} initial @param {Uint8Array} bytes
 * @returns {number}
 */
export function crc32(initial, bytes){
    let crc = ~initial >>> 0;
    for (const byte of bytes)
    {
        crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return ~crc >>> 0;
}

/**
 * @param {{ readMemory: (address: number, length: number) => Uint8Array }} host
 */
export function createChecksumFunctions(host){
    return {
        /** DWORD RtlComputeCrc32(DWORD dwInitial, const BYTE *pData, INT iLen) */
        RtlComputeCrc32: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([initial, data, length])=>crc32(initial >>> 0,
                (length | 0) <= 0 ? new Uint8Array(0) : host.readMemory(wholeAddress(data),
                    length | 0)),
        },
    };
}
