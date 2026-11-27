/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { DIMENSION } from './dds10.js';

/**
 * A DX10 DDS file whose texel bytes count up from 0, so where each level was
 * cut from shows in its first byte.
 *
 * @param {{ width: number, height?: number, depth?: number, format: number,
 *     dimension?: number, misc?: number, arraySize?: number, mips?: number,
 *     bytes: number }} shape  bytes: how many texel bytes follow the headers
 */
export function dds10(shape){
    const { width, height = 1, depth = 0, format, dimension = DIMENSION.TEXTURE2D, misc = 0,
        arraySize = 1, mips = 1, bytes } = shape;
    const file = new Uint8Array(148 + bytes);
    const view = new DataView(file.buffer);
    file.set([0x44, 0x44, 0x53, 0x20]);
    view.setUint32(4, 124, true);
    // DDSD_HEIGHT | DDSD_WIDTH only, as Vantage's files have it: no mip-count flag;
    // DDS_DEPTH for a volume.
    view.setUint32(8, 0x6 | (depth > 0 ? 0x800000 : 0), true);
    view.setUint32(12, height, true);
    view.setUint32(16, width, true);
    view.setUint32(24, depth, true);
    view.setUint32(28, mips, true);
    view.setUint32(76, 32, true);
    view.setUint32(80, 0x4, true);
    file.set([0x44, 0x58, 0x31, 0x30], 84);
    [format, dimension, misc, arraySize, 0].forEach((word, i)=>view.setUint32(128 + i * 4,
        word, true));
    for (let i = 0; i < bytes; i++)
    {
        file[148 + i] = i & 0xff;
    }
    return file;
}
