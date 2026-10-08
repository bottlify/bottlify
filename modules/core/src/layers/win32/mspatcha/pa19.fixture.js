/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * PA19 patches built for tests, laid out field by field as `pa19.js`
 * describes the format, with LZXD streams from the cabinet's test encoder.
 */

import { crc32 } from '../../filesystem/internal/bundle/crc32.js';
import { positionSlots } from '../cabinet/lzx.js';
import { encoder, lzxdStream, writer } from '../cabinet/lzx.fixture.js';

/**
 * An unsigned variable-length integer: seven bits a byte, least significant
 * first, the last byte marked by bit 7.
 *
 * @param {number} value
 */
export function uvli(value){
    const out = [value % 128];
    let rest = Math.floor(value / 128);
    while (rest > 0)
    {
        out.push(rest % 128);
        rest = Math.floor(rest / 128);
    }
    out[out.length - 1] |= 0x80;
    return out;
}

/**
 * A signed one: bit 6 of the first byte the sign, six bits of magnitude in
 * the first byte and seven in each after.
 *
 * @param {number} value
 */
export function svli(value){
    const magnitude = Math.abs(value);
    const out = [(magnitude % 64) | (value < 0 ? 0x40 : 0)];
    let rest = Math.floor(magnitude / 64);
    while (rest > 0)
    {
        out.push(rest % 128);
        rest = Math.floor(rest / 128);
    }
    out[out.length - 1] |= 0x80;
    return out;
}

/** @param {number} value */
const u32 = value=>[value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24];

/**
 * @param {Uint8Array} bytes @param {{ offset: number, length: number }[]} ranges
 */
const zeroed = (bytes, ranges)=>{
    const out = bytes.slice();
    for (const { offset, length } of ranges)
    {
        out.fill(0, offset, offset + length);
    }
    return out;
};

/**
 * @typedef {Object} OldSpec
 * @property {Uint8Array} bytes
 * @property {{ offset: number, length: number }[]} [ignore]
 * @property {{ oldOffset: number, newOffset: number, length: number }[]} [retain]
 * @property {Uint8Array} [stream]  Its LZXD stream; none when the old file is the new one.
 * @property {number} [crc]  To record a CRC other than the file's.
 */

/**
 * A PA19 patch.
 *
 * @param {{
 *   flags?: number, extendedFlags?: number, timestamp?: number, imageBase?: number,
 *   newBytes: Uint8Array, newCrc?: number, oldFiles: OldSpec[],
 *   interleave?: number[], transforms?: number, headerOnly?: boolean,
 * }} spec
 */
export function buildPatch(spec){
    const flags = spec.flags ?? 0x00c40001;
    const bytes = [0x50, 0x41, 0x31, 0x39, ...u32(flags)];
    if (flags & 0x80000000)
    {
        bytes.push(...u32(spec.extendedFlags ?? 0));
    }
    if (flags & 0x00800000)
    {
        bytes.push(...u32(spec.timestamp ?? 0));
    }
    if (!(flags & 0x00040000))
    {
        bytes.push(...uvli(spec.imageBase ?? 0x400000));
    }
    const retainedNew = (spec.oldFiles[0].retain ?? [])
        .map(r=>({ offset: r.newOffset, length: r.length }));
    bytes.push(...uvli(spec.newBytes.length));
    bytes.push(...u32(spec.newCrc ?? crc32(zeroed(spec.newBytes, retainedNew))));
    bytes.push(spec.oldFiles.length);
    for (const old of spec.oldFiles)
    {
        const ignore = old.ignore ?? [];
        const retain = old.retain ?? [];
        const stream = old.stream ?? new Uint8Array(0);
        bytes.push(...svli(old.bytes.length - spec.newBytes.length));
        const aside = [...stream.length > 0 ? ignore : [],
            ...retain.map(r=>({ offset: r.oldOffset, length: r.length }))];
        bytes.push(...u32(old.crc ?? crc32(zeroed(old.bytes, aside))));
        bytes.push(ignore.length);
        let from = 0;
        for (const range of ignore)
        {
            bytes.push(...svli(range.offset - from), ...uvli(range.length));
            from = range.offset + range.length;
        }
        bytes.push(retain.length);
        from = 0;
        for (const range of retain)
        {
            bytes.push(...svli(range.oldOffset - from), ...svli(range.newOffset - range.oldOffset),
                ...uvli(range.length));
            from = range.oldOffset + range.length;
        }
        bytes.push(...uvli(spec.transforms ?? 0));
        if (flags & 0x40000000)
        {
            const values = spec.interleave ?? [];
            bytes.push(...uvli((values.length + 1) / 3), ...values.flatMap(uvli));
        }
        bytes.push(...uvli(stream.length));
    }
    if (!spec.headerOnly)
    {
        for (const old of spec.oldFiles)
        {
            bytes.push(...old.stream ?? []);
        }
    }
    // The last four bytes are whatever brings the CRC of the whole to
    // 0xffffffff: the CRC register as it stands before its final inversion.
    const body = Uint8Array.from(bytes);
    const patch = new Uint8Array(body.length + 4);
    patch.set(body);
    patch.set(u32(~crc32(body) >>> 0), body.length);
    return patch;
}

/**
 * An LZXD stream of one uncompressed block: the new file's bytes as they are.
 *
 * @param {Uint8Array} bytes  At most one chunk's worth.
 */
export function storedStream(bytes){
    const w = writer();
    w.bits(0, 1);
    w.bits(3, 3);
    w.bits(bytes.length, 24);
    w.raw([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, ...bytes]);
    return lzxdStream([w.done()]);
}

/**
 * An LZXD stream of one verbatim block, over an old file of the size given:
 * literals, and matches whose offsets reach back into the old file.
 *
 * @param {import('../cabinet/lzx.fixture.js').Token[]} tokens @param {number} size
 */
export function verbatimStream(tokens, size){
    const w = writer();
    w.bits(0, 1);
    encoder(positionSlots(17), { delta: true }).block(w, 1, size, tokens)(w, tokens);
    return lzxdStream([w.done()]);
}

/** @param {string} value */
export const ascii = value=>Uint8Array.from([...value].map(c=>c.charCodeAt(0)));

/**
 * The smallest file the loader takes for a 32-bit PE image: the DOS header,
 * the PE signature, an i386 file header and a PE32 optional header with no
 * sections.
 */
export function tinyPe32(){
    const bytes = new Uint8Array(0x200);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0x5a4d, true);
    view.setUint32(0x3c, 0x40, true);
    view.setUint32(0x40, 0x00004550, true);
    view.setUint16(0x44, 0x14c, true);
    view.setUint16(0x54, 0xe0, true);
    view.setUint16(0x58, 0x10b, true);
    view.setUint32(0x58 + 92, 16, true);
    return bytes;
}
