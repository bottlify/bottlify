/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, isRarArchive, readRar } from './rar.js';

/** @param {number} value */
const vint = value=>{
    const bytes = [];
    for (;;)
    {
        bytes.push(value & 0x7f | (value >= 0x80 ? 0x80 : 0));
        value = Math.floor(value / 128);
        if (!value)
        {
            return bytes;
        }
    }
};

/** A RAR 5 header block: CRC32 over the size and the header, then both. */
const block = (/** @type {number[]} */ header)=>{
    const body = [...vint(header.length), ...header];
    const crc = crc32(new Uint8Array(body));
    return [crc & 0xff, crc >>> 8 & 0xff, crc >>> 16 & 0xff, crc >>> 24, ...body];
};

/**
 * @typedef {{ name: string, bytes: Uint8Array, packed?: Uint8Array, solid?: boolean,
 *     dir?: boolean }} File
 */

/**
 * @param {File[]} files
 */
const archive = files=>{
    const out = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00, ...block([1, 0, 0])];
    for (const file of files)
    {
        const name = [...new TextEncoder().encode(file.name)];
        const data = file.packed ?? file.bytes;
        const crc = crc32(file.bytes);
        const compression = (file.packed ? 1 << 7 : 0) | (file.solid ? 0x40 : 0);
        out.push(...block([2, 2, ...vint(data.length), file.dir ? 1 : 4,
            ...vint(file.bytes.length), 0,
            ...file.dir ? [] : [crc & 0xff, crc >>> 8 & 0xff, crc >>> 16 & 0xff, crc >>> 24],
            ...vint(compression), 0, ...vint(name.length), ...name]), ...data);
    }
    out.push(...block([5, 0, 0]));
    return new Blob([new Uint8Array(out)]);
};

/**
 * A compressed block with flat tables -- every main symbol 9 bits, every
 * distance slot and repeat length 6, every low distance 4 -- so a symbol's
 * code is its own number.
 */
class Writer {
    constructor(){
        /** @type {number[]} */
        this.bits = [];
    }

    /** @param {number} value @param {number} count */
    put(value, count){
        for (let i = count - 1; i >= 0; i--)
        {
            this.bits.push(value >> i & 1);
        }
        return this;
    }

    tables(){
        for (let i = 0; i < 20; i++)
        {
            this.put(5, 4);
        }
        const lengths = [[306, 9], [64, 6], [16, 4], [44, 6]];
        for (const [count, length] of lengths)
        {
            for (let i = 0; i < count; i++)
            {
                this.put(length, 5);
            }
        }
        return this;
    }

    /** @param {number} symbol */
    main(symbol){
        return this.put(symbol, 9);
    }

    /** @param {number[]} bytes */
    literals(bytes){
        bytes.forEach(byte=>this.main(byte));
        return this;
    }

    /**
     * @param {number} start @param {number} length @param {number} type
     * @param {number} [channels]
     */
    filter(start, length, type, channels){
        this.main(256).put(0, 2).put(start, 8).put(0, 2).put(length, 8).put(type, 3);
        return type === 0 ? this.put((channels ?? 1) - 1, 5) : this;
    }

    /** @param {boolean} tables */
    finish(tables){
        const size = Math.ceil(this.bits.length / 8);
        const data = new Uint8Array(size);
        this.bits.forEach((bit, i)=>{
            data[i >> 3] |= bit << (7 - (i & 7));
        });
        // Two bytes of size: a block with tables is over 255 bytes.
        const flags = (tables ? 0x80 : 0) | 0x40 | 1 << 3 | this.bits.length - 8 * (size - 1) - 1;
        const check = (0x5a ^ flags ^ size ^ size >> 8) & 0xff;
        return new Uint8Array([flags, check, size & 0xff, size >> 8, ...data]);
    }
}

const RAR4 = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00];
/** @param {number[]} bytes */
const blobOf = bytes=>new Blob([new Uint8Array(bytes)]);

test('a RAR 5 signature is recognised and an older one too', async()=>{
    assert.equal(await isRarArchive(archive([])), true);
    assert.equal(await isRarArchive(blobOf(RAR4)), true);
    assert.equal(await isRarArchive(blobOf([0x50, 0x4b, 3, 4, 0, 0, 0, 0])), false);
});

test('RAR 1.5 to 4.x is refused by name', async()=>{
    await assert.rejects(readRar(blobOf([...RAR4, 0])), /RAR 1\.5 to 4\.x/);
});

test('stored entries and directories come out as they are, with backslashed paths', async()=>{
    const bytes = new TextEncoder().encode('[autorun]\r\nopen=setup.exe\r\n');
    const entries = await readRar(archive([{ name: 'Disc/autorun.inf', bytes },
        { name: 'Disc', bytes: new Uint8Array(0), dir: true }]));
    assert.deepEqual(entries.map(entry=>entry.path), ['Disc\\autorun.inf', 'Disc']);
    assert.deepEqual(entries[0].bytes, bytes);
    assert.equal(entries[1].bytes, null);
});

test('literals, a match, the last length, a repeated distance and both filters unpack', async()=>{
    const first = new Writer().tables()
        .literals([...'abcdefgh'].map(c=>c.charCodeAt(0)))
        // length slot 2 (4 bytes), distance slot 5 and one extra bit: 8.
        .main(264).put(5, 6).put(1, 1)
        .main(257)
        // the latest distance again, length slot 0 (2 bytes).
        .main(258).put(0, 6)
        .filter(0, 5, 1).literals([0xe8, 5, 0, 0, 0])
        .filter(0, 4, 0, 1).literals([1, 1, 1, 1])
        .finish(true);
    const expected = new Uint8Array([...new TextEncoder().encode('abcdefghabcdefghab'),
        // E8 at offset 18: the operand 5 made relative to the byte after the opcode, 19.
        0xe8, 0xf2, 0xff, 0xff, 0xff,
        0xff, 0xfe, 0xfd, 0xfc]);
    // The next entry of a solid archive keeps the tables, the last length and
    // the dictionary, unfiltered: positions 19 and 20 hold 5 and 0.
    const second = new Writer().main(257).finish(false);
    const entries = await readRar(archive([
        { name: 'one.bin', bytes: expected, packed: first },
        { name: 'two.bin', bytes: new Uint8Array([5, 0]), packed: second, solid: true },
    ]));
    assert.deepEqual(entries[0].bytes, expected);
    assert.deepEqual(entries[1].bytes, new Uint8Array([5, 0]));
});

test('an entry whose bytes do not match its CRC32 is refused', async()=>{
    const packed = new Writer().tables().literals([1, 2, 3]).finish(true);
    const blob = archive([{ name: 'x', bytes: new Uint8Array([1, 2, 4]), packed }]);
    await assert.rejects(readRar(blob), /CRC32/);
});
