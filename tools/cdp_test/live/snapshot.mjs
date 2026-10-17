/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */
/**
 * Textures of the running program as the GPU holds them, written as PNGs:
 * the targets and shadow maps a frame dump names (`t4414`, `t754`), which a
 * dump of the draws cannot show. The program has to be drawing: the texture is
 * read at the end of its next frame (`app.debug.snapshot`).
 *
 *   node tools/cdp_test/live/snapshot.mjs t4414 t754 [--out DIR]
 *
 * A float format is written stretched between its own smallest and largest
 * finite values, which the console prints; a colour format as it is.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { connect } from './connect.mjs';

const argv = process.argv.slice(2);
const outAt = argv.indexOf('--out');
const out = outAt >= 0 ? argv[outAt + 1] : 'dbg/snapshots';
const ids = argv.filter((arg, index)=>!arg.startsWith('--') && index !== outAt + 1);
mkdirSync(out, { recursive: true });

const page = await connect();

/** @param {number} bits */
const half = bits=>{
    const exponent = (bits >> 10) & 0x1f;
    const fraction = bits & 0x3ff;
    const sign = bits & 0x8000 ? -1 : 1;
    if (exponent === 0)
    {
        return sign * 2 ** -14 * (fraction / 1024);
    }
    return exponent === 31 ? (fraction ? NaN : sign * Infinity)
        : sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
};

/** @param {number} width @param {number} height @param {Uint8Array} rgba */
const png = (width, height, rgba)=>{
    const crcTable = Array.from({ length: 256 }, (_, n)=>{
        let c = n;
        for (let k = 0; k < 8; k++)
        {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }
        return c >>> 0;
    });
    /** @param {Buffer} bytes */
    const crc = bytes=>{
        let c = 0xffffffff;
        for (const byte of bytes)
        {
            c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
        }
        return (c ^ 0xffffffff) >>> 0;
    };
    /** @param {string} type @param {Buffer} data */
    const chunk = (type, data)=>{
        const head = Buffer.alloc(8);
        head.writeUInt32BE(data.length, 0);
        head.write(type, 4, 'ascii');
        const tail = Buffer.alloc(4);
        tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
        return Buffer.concat([head, data, tail]);
    };
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = 6;
    const rows = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++)
    {
        rows[y * (width * 4 + 1)] = 0;
        Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
            .copy(rows, y * (width * 4 + 1) + 1);
    }
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
};

for (const id of ids)
{
    await page.evaluate(`window.__bottlify__.app.debug.snapshot(${JSON.stringify(id)})`);
    /** @type {any} */
    let shot = null;
    for (let tries = 0; tries < 100 && !shot; tries++)
    {
        await new Promise(resolve=>setTimeout(resolve, 100));
        shot = await page.evaluate(`(async()=>{ const s = await window.__bottlify__.app.debug`
            + `.snapped(${JSON.stringify(id)}); if (!s) return null; let b = '';`
            + ` for (let i = 0; i < s.data.length; i += 0x8000) b += String.fromCharCode`
            + `(...s.data.subarray(i, i + 0x8000)); return { width: s.width, height: s.height,`
            + ` format: s.format, data: btoa(b) }; })()`);
    }
    if (!shot)
    {
        console.log(`${id}: nothing came back -- is the program drawing,`
            + ` and does a dump name ${id}?`);
        continue;
    }
    const bytes = Buffer.from(shot.data, 'base64');
    const { width, height, format } = shot;
    const rgba = new Uint8Array(width * height * 4);
    const texels = width * height;
    /** @type {(index: number) => number[]} */
    let channels;
    if (format === 'r32float' || format === 'depth32float')
    {
        channels = index=>[bytes.readFloatLE(index * 4)];
    }
    else if (format === 'rgba16float')
    {
        channels = index=>[0, 1, 2, 3].map(c=>half(bytes.readUInt16LE(index * 8 + c * 2)));
    }
    else if (format === 'rgba32float')
    {
        channels = index=>[0, 1, 2, 3].map(c=>bytes.readFloatLE(index * 16 + c * 4));
    }
    else
    {
        channels = index=>{
            const at = index * 4;
            const [a, b, c, d] = [bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]];
            return (format.startsWith('bgra') ? [c, b, a, d] : [a, b, c, d]).map(v=>v / 255);
        };
    }
    let low = Infinity;
    let high = -Infinity;
    const floating = format.includes('float');
    if (floating)
    {
        for (let index = 0; index < texels; index++)
        {
            for (const value of channels(index).slice(0, 3))
            {
                if (Number.isFinite(value))
                {
                    low = Math.min(low, value);
                    high = Math.max(high, value);
                }
            }
        }
    }
    const scale = floating && high > low ? 1 / (high - low) : 1;
    const base = floating && high > low ? low : 0;
    for (let index = 0; index < texels; index++)
    {
        const values = channels(index);
        const rgb = values.length === 1 ? [values[0], values[0], values[0]] : values.slice(0, 3);
        rgb.forEach((value, c)=>{
            const scaled = Math.round((value - base) * scale * 255);
            rgba[index * 4 + c] = Math.max(0, Math.min(255, scaled));
        });
        rgba[index * 4 + 3] = 255;
    }
    const file = join(out, `${id}.png`);
    writeFileSync(file, png(width, height, rgba));
    const range = floating ? ` values ${low}..${high}` : '';
    console.log(`${id}: ${width}x${height} ${format}${range} -> ${file}`);
}
process.exit(0);
