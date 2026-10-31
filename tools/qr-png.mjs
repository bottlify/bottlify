/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/** A QR code written as a PNG, for a person to scan off the screen: the Steam sign-in tools'. */

import { deflateSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n)=>{
    let c = n;
    for (let k = 0; k < 8; k++)
    {
        c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
});
/** @param {Buffer} bytes */
const crc32 = bytes=>{
    let c = 0xFFFFFFFF;
    for (const byte of bytes)
    {
        c = crcTable[(c ^ byte) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
};
/** @param {string} type @param {Buffer} data */
const chunk = (type, data)=>{
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
};

/**
 * A QR code as a greyscale PNG, with its quiet zone.
 *
 * @param {boolean[][]} modules @param {number} scale
 */
export function qrPng(modules, scale){
    const size = (modules.length + 8) * scale;
    const rows = [];
    for (let y = 0; y < size; y++)
    {
        const row = Buffer.alloc(size + 1);
        for (let x = 0; x < size; x++)
        {
            const dark = modules[Math.floor(y / scale) - 4]?.[Math.floor(x / scale) - 4];
            row[x + 1] = dark ? 0 : 255;
        }
        rows.push(row);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8;
    header[9] = 0;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', header),
        chunk('IDAT', deflateSync(Buffer.concat(rows))),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}
