/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { COMPRESSION, CabinetError, decodeFolder, readCabinet } from './cabinet.js';
import { buildCabinet } from './cabinet.fixture.js';
import { extractCabinet } from './stream.js';

/** @param {number} length @param {number} seed */
const pattern = (length, seed)=>Uint8Array.from({ length }, (_, at)=>(at * 7 + seed) % 251);

/**
 * Three files across two MSZIP blocks of one folder, and a stored folder of
 * its own: what is cut out by streaming must be what decoding whole gives.
 */
const sample = ()=>{
    const stream = pattern(32768 + 5000, 1);
    const first = stream.subarray(0, 32768);
    const second = stream.subarray(32768);
    const stored = pattern(300, 9);
    return buildCabinet({
        folders: [
            { compression: COMPRESSION.MSZIP, blocks: [
                { packed: Uint8Array.from([0x43, 0x4b, ...deflateRawSync(first)]), size: 32768 },
                { packed: Uint8Array.from([0x43, 0x4b, ...deflateRawSync(second,
                    { dictionary: first })]), size: 5000 },
            ] },
            { compression: COMPRESSION.NONE, blocks: [{ packed: stored, size: 300 }] },
        ],
        files: [
            { name: 'a.bin', size: 30000, offset: 0, folder: 0 },
            { name: 'b.bin', size: 7768, offset: 30000, folder: 0 },
            { name: 'c.bin', size: 300, offset: 0, folder: 1 },
        ],
    });
};

test('files are cut out of their folders as the blocks decode, as decoding whole gives them',
    async()=>{
        const bytes = sample();
        const cabinet = readCabinet(bytes);
        const whole = [decodeFolder(cabinet, 0), decodeFolder(cabinet, 1)];
        /** @type {Map<string, Uint8Array>} */
        const out = new Map();
        /** @type {[number, number][]} */
        const reads = [];
        await extractCabinet({ size: bytes.length, read: (offset, length)=>{
            reads.push([offset, length]);
            return bytes.subarray(offset, offset + length);
        } }, file=>{
            const target = new Uint8Array(file.size);
            return {
                write: (offset, data)=>{
                    target.set(data, offset);
                },
                close: ()=>{
                    out.set(file.name, target);
                },
            };
        });
        assert.deepEqual(out.get('a.bin'), whole[0].subarray(0, 30000));
        assert.deepEqual(out.get('b.bin'), whole[0].subarray(30000, 37768));
        assert.deepEqual(out.get('c.bin'), whole[1]);
        assert.ok(reads.length <= 4, 'the head, then a batch per folder');
    });

test('a file the sink declines is not written, and a folder nobody wants is not read', async()=>{
    const bytes = sample();
    /** @type {string[]} */
    const written = [];
    /** @type {number[]} */
    const reads = [];
    await extractCabinet({ size: bytes.length, read: (offset, length)=>{
        reads.push(offset);
        return bytes.subarray(offset, offset + length);
    } }, file=>(file.name === 'c.bin' ? {
        write: ()=>{
            written.push(file.name);
        },
        close: ()=>{},
    } : null), { eager: true });
    assert.deepEqual(written, ['c.bin']);
    assert.ok(!reads.some(offset=>offset > 0 && offset < readCabinet(bytes).folders[1].dataOffset),
        'the first folder\'s blocks were never read');
});

test('a corrupt block is the cabinet\'s error, not a short file', async()=>{
    const bytes = sample();
    const cabinet = readCabinet(bytes);
    bytes[cabinet.folders[1].dataOffset + 8] ^= 0xff;
    await assert.rejects(extractCabinet({ size: bytes.length,
        read: (offset, length)=>bytes.subarray(offset, offset + length) },
    ()=>({ write: ()=>{}, close: ()=>{} })), CabinetError);
});

test('lazily, a file is asked for as the output reaches it and closed once it has all of it',
    async()=>{
        const bytes = sample();
        /** @type {string[]} */
        const events = [];
        await extractCabinet({ size: bytes.length,
            read: (offset, length)=>bytes.subarray(offset, offset + length) }, file=>{
            events.push(`open ${file.name}`);
            return {
                write: ()=>{},
                close: ()=>{
                    events.push(`close ${file.name}`);
                },
            };
        });
        assert.deepEqual(events, ['open a.bin', 'close a.bin', 'open b.bin', 'close b.bin',
            'open c.bin', 'close c.bin'], 'one file at a time, in the order of the folder');
    });

test('bytes that are not a cabinet are refused after their first read', async()=>{
    /** @type {number[]} */
    const reads = [];
    await assert.rejects(extractCabinet({ size: 5_000_000, read: (offset, length)=>{
        reads.push(length);
        return new Uint8Array(length);
    } }, ()=>null), CabinetError);
    assert.deepEqual(reads, [64 * 1024], 'one read of the head, and no more');
});
