/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { wholeAddress } from '../common/pointers.js';
import { crc32 } from '../../../system/hash.js';

/**
 * The checksums ntdll computes over a caller's bytes.
 *
 * RtlComputeCrc32 is the CRC-32 of zlib and PNG (the reflected polynomial
 * 0xEDB88320, the value inverted on the way in and out), continued from the
 * value the caller passes: CRC over two pieces is the CRC of the first passed
 * to the second.
 */

/**
 * @param {{ guest: import('../common/guest.js').Guest }} host
 */
export function createChecksumFunctions(host){
    return {
        /** DWORD RtlComputeCrc32(DWORD dwInitial, const BYTE *pData, INT iLen) */
        RtlComputeCrc32: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([initial, data, length])=>crc32((length | 0) <= 0 ? new Uint8Array(0)
                : host.guest.view(wholeAddress(data), length | 0), initial >>> 0),
        },
    };
}
