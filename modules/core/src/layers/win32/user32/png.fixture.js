/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The reference images the painting tests compare against, as PNG files: a
 * picture a person can open, and bytes a test can compare exactly. Only the
 * one shape these tests write is read back -- eight-bit RGB, no filter on
 * any row -- and an encoder small enough to read writes it.
 */

import { deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

const CRC_TABLE = new Int32Array(256).map((_, n)=>{
    let c = n;
    for (let k = 0; k < 8; k++)
    {
        c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c;
});

/** @param {Uint8Array} bytes */
function crc(bytes){
    let c = -1;
    for (const b of bytes)
    {
        c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    }
    return (c ^ -1) >>> 0;
}

/** @param {string} type @param {Uint8Array} data */
function chunk(type, data){
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++)
    {
        out[4 + i] = type.charCodeAt(i);
    }
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
}

/**
 * The pixels of a surface, as a PNG.
 *
 * @param {{ width: number, height: number, read: (x: number, y: number) => number }} surface
 * @returns {Uint8Array}
 */
export function encodePng(surface){
    const stride = surface.width * 3 + 1;
    const raw = new Uint8Array(stride * surface.height);
    for (let y = 0; y < surface.height; y++)
    {
        for (let x = 0; x < surface.width; x++)
        {
            const pixel = surface.read(x, y);
            const at = y * stride + 1 + x * 3;
            raw[at] = (pixel >>> 16) & 0xff;
            raw[at + 1] = (pixel >>> 8) & 0xff;
            raw[at + 2] = pixel & 0xff;
        }
    }
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, surface.width);
    view.setUint32(4, surface.height);
    header[8] = 8;
    header[9] = 2;
    const parts = [SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)),
        chunk('IEND', new Uint8Array(0))];
    const out = new Uint8Array(parts.reduce((sum, part)=>sum + part.length, 0));
    let at = 0;
    for (const part of parts)
    {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

/**
 * The pixels of a PNG this file wrote, as 0x00RRGGBB values row by row.
 *
 * @param {Uint8Array} bytes
 * @returns {{ width: number, height: number, pixels: Uint32Array }}
 */
export function decodePng(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 8;
    let width = 0;
    let height = 0;
    /** @type {Uint8Array[]} */
    const data = [];
    while (at < bytes.length)
    {
        const length = view.getUint32(at);
        const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
        const body = bytes.subarray(at + 8, at + 8 + length);
        if (type === 'IHDR')
        {
            width = view.getUint32(at + 8);
            height = view.getUint32(at + 12);
        }
        else if (type === 'IDAT')
        {
            data.push(body);
        }
        at += 12 + length;
    }
    const joined = new Uint8Array(data.reduce((sum, part)=>sum + part.length, 0));
    let offset = 0;
    for (const part of data)
    {
        joined.set(part, offset);
        offset += part.length;
    }
    const raw = inflateSync(joined);
    const stride = width * 3 + 1;
    const pixels = new Uint32Array(width * height);
    for (let y = 0; y < height; y++)
    {
        for (let x = 0; x < width; x++)
        {
            const from = y * stride + 1 + x * 3;
            pixels[y * width + x] = (raw[from] << 16 | raw[from + 1] << 8 | raw[from + 2]) >>> 0;
        }
    }
    return { width, height, pixels };
}
