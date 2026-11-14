/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Headers of an image: MZ, PE, a 32-bit optional header, and the sections
 * given, each [VirtualAddress, VirtualSize, Characteristics].
 *
 * @param {number} sizeOfImage @param {[number, number, number][]} sections
 */
export function imageHeaders(sizeOfImage, sections){
    const bytes = new Uint8Array(0x1000);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0x5a4d, true);
    view.setUint32(0x3c, 0x40, true);
    view.setUint32(0x40, 0x00004550, true);
    view.setUint16(0x40 + 6, sections.length, true);
    view.setUint16(0x40 + 20, 0xe0, true);
    view.setUint32(0x40 + 24 + 56, sizeOfImage, true);
    view.setUint32(0x40 + 24 + 60, 0x400, true);
    sections.forEach(([address, size, characteristics], index)=>{
        const at = 0x40 + 24 + 0xe0 + index * 40;
        view.setUint32(at + 8, size, true);
        view.setUint32(at + 12, address, true);
        view.setUint32(at + 36, characteristics >>> 0, true);
    });
    return bytes;
}
