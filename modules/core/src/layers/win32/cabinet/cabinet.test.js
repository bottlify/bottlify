/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
    COMPRESSION, CabinetError, cabinetChecksum, decodeFolder, folderOf, readCabinet,
} from './cabinet.js';
import { buildCabinet } from './cabinet.fixture.js';

/** @param {string} text */
const bytes = text=>Uint8Array.from([...text].map(c=>c.charCodeAt(0)));
/** @param {Uint8Array} data */
const text = data=>String.fromCharCode(...data);

const PROLOGUE = '#include <stdio.h>\r\n\r\nvoid main(void)\r\n{\r\n';
const HELLO = `${PROLOGUE}    printf("Hello, world!\\n");\r\n}\r\n`;
const WELCOME = `${PROLOGUE}    printf("Welcome!\\n");\r\n}\r\n\r\n`;

test('the checksum is the one the format\'s sample cabinet records', ()=>{
    // The format document's sample: two files stored in one 151-byte block,
    // whose CFDATA.csum it gives as 0x30A65ABD.
    const data = bytes(HELLO + WELCOME);
    assert.equal(data.length, 151);
    const cabinet = buildCabinet({
        folders: [{ compression: COMPRESSION.NONE, blocks: [{ packed: data, size: data.length }] }],
        files: [{ name: 'hello.c', size: 77, offset: 0, folder: 0 },
            { name: 'welcome.c', size: 74, offset: 77, folder: 0 }],
    });
    assert.equal(cabinet.length, 0xfd, 'the sample\'s own size');
    assert.equal(new DataView(cabinet.buffer).getUint32(0x5e, true), 0x30a65abd);

    const read = readCabinet(cabinet);
    assert.deepEqual(read.files.map(f=>[f.name, f.size, f.offset, f.date, f.time, f.attributes]),
        [['hello.c', 77, 0, 0x226c, 0x59ba, 0x20], ['welcome.c', 74, 77, 0x226c, 0x59ba, 0x20]]);
    const stream = decodeFolder(read, 0);
    assert.equal(text(stream.subarray(0, 77)), HELLO);
    assert.equal(text(stream.subarray(77)), WELCOME);
});

test('the checksum folds a tail of one, two or three bytes as the format\'s routine does', ()=>{
    assert.equal(cabinetChecksum(Uint8Array.from([1, 2, 3, 4]), 0), 0x04030201);
    assert.equal(cabinetChecksum(Uint8Array.from([1, 2, 3, 4, 5]), 0), 0x04030204);
    assert.equal(cabinetChecksum(Uint8Array.from([1, 2, 3, 4, 5, 6]), 0), 0x04030201 ^ 0x0506);
    assert.equal(cabinetChecksum(Uint8Array.from([7, 8, 9]), 0x10), 0x10 ^ 0x070809);
});

test('an MSZIP folder decodes block after block, the history carried between them', ()=>{
    const first = bytes('abcdefgh'.repeat(4096));
    const second = bytes('abcdefgh'.repeat(100));
    const blocks = [
        { packed: Uint8Array.from([0x43, 0x4b, ...deflateRawSync(first)]), size: first.length },
        { packed: Uint8Array.from([0x43, 0x4b, ...deflateRawSync(second, { dictionary: first })]),
            size: second.length },
    ];
    const cabinet = readCabinet(buildCabinet({
        folders: [{ compression: COMPRESSION.MSZIP, blocks }],
        files: [{ name: 'a.txt', size: 32768 + 800, offset: 0, folder: 0 }],
    }));
    const stream = decodeFolder(cabinet, 0);
    assert.equal(stream.length, 32768 + 800);
    assert.equal(text(stream.subarray(32760)), 'abcdefgh'.repeat(101));
});

test('an LZX folder takes its window from typeCompress', ()=>{
    // One uncompressed LZX block: no CALL translation, type 3, a 24-bit
    // size, padding to the word, three repeated offsets, then the bytes.
    const payload = bytes('LZX!');
    const packed = Uint8Array.from([
        // Word 0x3000: 0, then 011, then the size's high twelve bits; word
        // 0x0040: its low twelve (4), then four bits of padding.
        0x00, 0x30, 0x40, 0x00,
        1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, ...payload,
    ]);
    const cabinet = readCabinet(buildCabinet({
        folders: [{ compression: COMPRESSION.LZX | (21 << 8), blocks: [{ packed, size: 4 }] }],
        files: [{ name: 'x', size: 4, offset: 0, folder: 0 }],
    }));
    assert.equal(cabinet.folders[0].compression >> 8, 21);
    assert.equal(text(decodeFolder(cabinet, 0)), 'LZX!');
});

test('the reserved areas are skipped, and the per-cabinet one is handed back', ()=>{
    const reserve = Uint8Array.from([0, 0, 0x10, 0, 1, 2, 3, 4]);
    const data = bytes('reserved');
    const cabinet = readCabinet(buildCabinet({
        folders: [{ compression: COMPRESSION.NONE, blocks: [{ packed: data, size: data.length }] }],
        files: [{ name: 'r', size: data.length, offset: 0, folder: 0 }],
        reserve, dataReserve: 4,
    }));
    assert.deepEqual([...cabinet.reserve], [...reserve]);
    assert.equal(cabinet.dataReserve, 4);
    assert.equal(text(decodeFolder(cabinet, 0)), 'reserved');
});

test('a checksum that disagrees is a corrupt cabinet; a zero one is not checked', ()=>{
    const data = bytes('checked');
    const spec = {
        folders: [{ compression: COMPRESSION.NONE, blocks: [{ packed: data, size: data.length }] }],
        files: [{ name: 'c', size: data.length, offset: 0, folder: 0 }],
    };
    const good = buildCabinet(spec);
    const bad = good.slice();
    bad[bad.length - 1] ^= 1;
    assert.throws(()=>decodeFolder(readCabinet(bad), 0),
        (/** @type {any} */ e)=>e instanceof CabinetError && e.kind === 'corrupt');
    const unchecked = buildCabinet({ ...spec, checksums: false });
    unchecked[unchecked.length - 1] ^= 1;
    assert.equal(text(decodeFolder(readCabinet(unchecked), 0)), 'checkee');
});

test('what is not a cabinet, or uses what this build lacks, says which', ()=>{
    assert.throws(()=>readCabinet(bytes('MZ'.padEnd(64, '\0'))),
        (/** @type {any} */ e)=>e instanceof CabinetError && e.kind === 'format');
    const quantum = readCabinet(buildCabinet({
        folders: [{ compression: COMPRESSION.QUANTUM, blocks: [{ packed: bytes('q'), size: 1 }] }],
        files: [{ name: 'q', size: 1, offset: 0, folder: 0 }],
    }));
    assert.throws(()=>decodeFolder(quantum, 0),
        (/** @type {any} */ e)=>e instanceof CabinetError && e.kind === 'unsupported');
    const garbled = readCabinet(buildCabinet({
        folders: [{ compression: COMPRESSION.MSZIP, blocks: [{ packed: bytes('CKxx'), size: 9 }] }],
        files: [{ name: 'g', size: 9, offset: 0, folder: 0 }],
    }));
    assert.throws(()=>decodeFolder(garbled, 0),
        (/** @type {any} */ e)=>e instanceof CabinetError && e.kind === 'corrupt');
});

test('a file continued from another cabinet of a set has no folder here', ()=>{
    const data = bytes('tail');
    const cabinet = readCabinet(buildCabinet({
        folders: [{ compression: COMPRESSION.NONE, blocks: [{ packed: data, size: data.length }] }],
        files: [{ name: 'spans', size: 100, offset: 0, folder: 0xfffd },
            { name: 'here', size: 4, offset: 0, folder: 0 }],
    }));
    assert.equal(folderOf(cabinet, cabinet.files[0]), null);
    assert.equal(folderOf(cabinet, cabinet.files[1]), cabinet.folders[0]);
});
