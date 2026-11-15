/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A managed program for the tests: an image that is all header, its entry a
 * jump to mscoree's _CorExeMain.
 */

import assert from 'node:assert/strict';
import { buildExe } from '../../../../../../tools/fixtures/make-pe.mjs';
import { parsePe, rvaToFileOffset } from '../../loader/internal/pe.js';

const MARKER = [0x43, 0x4f, 0x52, 0x32, 0x30, 0x48, 0x44, 0x52];

/**
 * A managed image as a compiler lays its header out: the COM descriptor
 * directory pointing at IMAGE_COR20_HEADER (72 bytes: cb, the runtime's
 * version 2.5, MetaData's RVA and size), the metadata root after it
 * ("BSJB", 1.1, the version string's length, padded to 4, and the string).
 *
 * @param {{ bits?: 32 | 64, runtime?: string }} [options]
 */
export function managedExe({ bits = 32, runtime = 'v4.0.30319' } = {}){
    const bytes = buildExe({ imports: { 'mscoree.dll': ['_CorExeMain'] }, bits,
        data: { cor: [...MARKER, ...new Array(200).fill(0)] },
        // jmp [_CorExeMain], as a compiler's managed program's entry is.
        code: ({ iat })=>[0xff, 0x25, ...[0, 8, 16, 24].map(shift=>iat('_CorExeMain') >>> shift
            & 0xff)] });
    const image = parsePe(bytes, { wide: true });
    const at = bytes.findIndex((_, index)=>MARKER.every((byte, k)=>bytes[index + k] === byte));
    const section = image.sections.find(each=>at >= each.rawOffset
        && at < each.rawOffset + each.rawSize);
    assert.ok(section);
    const rva = section.virtualAddress + at - section.rawOffset;
    assert.equal(rvaToFileOffset(image, rva), at);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const padded = runtime.length + 4 & ~3;
    view.setUint32(at, 72, true);
    view.setUint16(at + 4, 2, true);
    view.setUint16(at + 6, 5, true);
    view.setUint32(at + 8, rva + 72, true);
    view.setUint32(at + 12, 16 + padded, true);
    view.setUint32(at + 72, 0x424a5342, true);
    view.setUint16(at + 76, 1, true);
    view.setUint16(at + 78, 1, true);
    view.setUint32(at + 84, padded, true);
    bytes.set([...runtime].map(c=>c.charCodeAt(0)), at + 88);
    const optional = view.getUint32(0x3c, true) + 24;
    const directory = optional + (bits === 64 ? 112 : 96) + 14 * 8;
    view.setUint32(directory, rva, true);
    view.setUint32(directory + 4, 72, true);
    return bytes;
}
