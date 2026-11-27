/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A 32-bit little-endian ELF's loadable segments and entry, for the command
 * line's `cork run` (`bin/cork.mjs`).
 */

/**
 * @param {Uint8Array} image
 * @returns {{ entry: number, segments: { address: number, bytes: Uint8Array }[] }}
 *     each PT_LOAD segment at its address, zero-filled to its size in memory
 */
export function parseElf32(image){
    const view = new DataView(image.buffer, image.byteOffset, image.byteLength);
    if (image[0] !== 0x7f || image[1] !== 0x45 || image[2] !== 0x4c || image[3] !== 0x46)
    {
        throw new Error('elf: not an ELF image');
    }
    if (image[4] !== 1 || image[5] !== 1)
    {
        throw new Error('elf: not a 32-bit little-endian ELF');
    }
    const entry = view.getUint32(0x18, true);
    const headersAt = view.getUint32(0x1c, true);
    const headerSize = view.getUint16(0x2a, true);
    const headerCount = view.getUint16(0x2c, true);
    const segments = [];
    for (let index = 0; index < headerCount; index++)
    {
        const at = headersAt + index * headerSize;
        if (view.getUint32(at, true) !== 1)
        {
            continue;
        }
        const offset = view.getUint32(at + 4, true);
        const address = view.getUint32(at + 8, true);
        const fileSize = view.getUint32(at + 16, true);
        const memorySize = view.getUint32(at + 20, true);
        const bytes = new Uint8Array(memorySize);
        bytes.set(image.subarray(offset, offset + fileSize));
        segments.push({ address, bytes });
    }
    return { entry, segments };
}
