/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */
/**
 * Textures of the running program as the GPU holds them, written as PNGs:
 * what a frame dump names (`t4414`, `t5`), which a dump of the draws cannot
 * show, all read in one frame (`app.debug.snapshot`). Direct3D and OpenGL
 * alike; for an OpenGL texture the line printed also says what GL holds of
 * it - each level defined, the filters, the levels it may sample and whether
 * it is complete - which is why a draw samples a placeholder instead
 * (`bound=[0:t5!]`). Paused, the frame on the screen is played again
 * (`freeze`) and read: the picture a person stopped on, not the next one.
 *
 *   node tools/live/live.mjs snapshot t4414 t5 [--out DIR] [--opaque]
 *
 * A colour format keeps its alpha (a font or a cut-out is its alpha), unless
 * `--opaque`; one or two channels (r8unorm, rg8unorm: GL_ALPHA, LUMINANCE,
 * LUMINANCE_ALPHA) are written as grey, the second channel as alpha. A float
 * or depth format is written stretched between its own smallest and largest
 * finite values, which the console prints, and opaque.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { connect } from '../../lib/connect.mjs';

const argv = process.argv.slice(2);
const outAt = argv.indexOf('--out');
const out = outAt >= 0 ? argv[outAt + 1] : 'dbg/snapshots';
const opaque = argv.includes('--opaque');
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

const crcTable = Array.from({ length: 256 }, (_, n)=>{
    let c = n;
    for (let k = 0; k < 8; k++)
    {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return c >>> 0;
});

/** @param {number} width @param {number} height @param {Uint8Array} rgba */
const png = (width, height, rgba)=>{
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
        Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
            .copy(rows, y * (width * 4 + 1) + 1);
    }
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
};

/**
 * Each texel's channels as numbers, read by the GPU format's layout: float
 * and depth formats as their values, the rest as fractions of their range.
 *
 * @param {string} format @param {Buffer} bytes
 * @returns {{ channels: (index: number) => number[], floating: boolean } | null}
 */
const decoderOf = (format, bytes)=>{
    if (format === 'r32float' || format === 'depth32float')
    {
        return { channels: index=>[bytes.readFloatLE(index * 4)], floating: true };
    }
    if (format === 'rgba16float')
    {
        return { channels: index=>[0, 1, 2, 3].map(c=>half(bytes.readUInt16LE(index * 8 + c * 2))),
            floating: true };
    }
    if (format === 'rgba32float')
    {
        return { channels: index=>[0, 1, 2, 3].map(c=>bytes.readFloatLE(index * 16 + c * 4)),
            floating: true };
    }
    if (format === 'r8unorm' || format === 'r8snorm')
    {
        return { channels: index=>[bytes[index] / 255], floating: false };
    }
    if (format === 'rg8unorm' || format === 'rg8snorm')
    {
        return { channels: index=>[bytes[index * 2] / 255, bytes[index * 2 + 1] / 255],
            floating: false };
    }
    if (/^(rgba|bgra)8/.test(format))
    {
        const swap = format.startsWith('bgra');
        return {
            channels: index=>{
                const at = index * 4;
                const [a, b, c, d] = [bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]];
                return (swap ? [c, b, a, d] : [a, b, c, d]).map(v=>v / 255);
            },
            floating: false,
        };
    }
    return null;
};

const paused = await page.evaluate(`[...document.querySelectorAll('button')]`
    + `.some(b=>b.getAttribute('aria-label')==='resume')`);
if (paused)
{
    await page.evaluate('window.__bottlify__.app.debug.freeze(true)');
}
await page.evaluate(`window.__bottlify__.app.debug.snapshot(${JSON.stringify(ids.join(','))})`);
for (const id of ids)
{
    /** @type {any} */
    let shot = null;
    for (let tries = 0; tries < 100 && !shot; tries++)
    {
        await new Promise(resolve=>setTimeout(resolve, 100));
        shot = await page.evaluate(`(async()=>{ const s = await window.__bottlify__.app.debug`
            + `.snapped(${JSON.stringify(id)}); if (!s) return null; let b = '';`
            + ` for (let i = 0; i < s.data.length; i += 0x8000) b += String.fromCharCode`
            + `(...s.data.subarray(i, i + 0x8000)); return { width: s.width, height: s.height,`
            + ` format: s.format, info: s.info ?? null, data: btoa(b) }; })()`);
    }
    const info = shot?.info ? `\n    ${shot.info}` : '';
    if (!shot)
    {
        console.log(`${id}: nothing came back -- is the program drawing,`
            + ` and does a dump name ${id}?`);
        continue;
    }
    if (shot.format === 'missing')
    {
        console.log(`${id}: not read${info}`);
        continue;
    }
    const bytes = Buffer.from(shot.data, 'base64');
    const { width, height, format } = shot;
    const decoder = decoderOf(format, bytes);
    if (!decoder)
    {
        console.log(`${id}: ${width}x${height} ${format}: no reader for this format here${info}`);
        continue;
    }
    const { channels, floating } = decoder;
    const texels = width * height;
    let low = Infinity;
    let high = -Infinity;
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
    const byte = (/** @type {number} */ value)=>
        Math.max(0, Math.min(255, Math.round((value - base) * scale * 255)));
    const rgba = new Uint8Array(texels * 4);
    let seeThrough = 0;
    for (let index = 0; index < texels; index++)
    {
        const values = channels(index);
        const grey = values.length <= 2;
        const rgb = grey ? [values[0], values[0], values[0]] : values.slice(0, 3);
        rgb.forEach((value, c)=>{
            rgba[index * 4 + c] = byte(value);
        });
        const alpha = floating || opaque ? 1
            : values.length === 2 ? values[1] : values.length === 4 ? values[3] : 1;
        rgba[index * 4 + 3] = Math.round(alpha * 255);
        if (alpha < 1)
        {
            seeThrough++;
        }
    }
    const file = join(out, `${id}.png`);
    writeFileSync(file, png(width, height, rgba));
    const range = floating ? ` values ${low}..${high}` : '';
    const alphaNote = floating || opaque ? '' : ` alpha<1 in ${seeThrough} of ${texels} texels`;
    console.log(`${id}: ${width}x${height} ${format}${range}${alphaNote} -> ${file}${info}`);
}
if (paused)
{
    await page.evaluate('window.__bottlify__.app.debug.freeze(false)');
}
process.exit(0);
