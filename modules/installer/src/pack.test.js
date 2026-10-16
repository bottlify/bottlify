/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The writer is checked against the reader the engine actually uses, never
 * against itself. A round trip through this module's own parser would prove
 * only that it is self-consistent, which is exactly the property a second
 * writer for one format is at risk of having.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
// The engine's own reader, which is not published: what it reads back is what
// a packed bottle has to be.
import { openBundle } from '../../core/src/layers/filesystem/internal/bundle/format.js';
import { Codec, crc32 } from '@bottlify/core/bundle';
import { packBundle, packBlock, sha256 } from './pack.js';

/** @param {number} codec @param {Uint8Array} stored */
const decode = (codec, stored)=>codec === Codec.DEFLATE_RAW
    ? new Uint8Array(zlib.inflateRawSync(stored))
    : stored;

/**
 * Packs a tree and puts the container together the way the server does, so the
 * bytes under test are the ones that would be uploaded.
 *
 * @param {{ path: string, bytes: Uint8Array }[]} files
 * @param {number} [blockSize]
 */
async function packed(files, blockSize){
    /** @type {Uint8Array[]} */
    const parts = [];
    const summary = await packBundle({
        files,
        blockSize,
        write: chunk=>{
            parts.push(chunk);
        },
    });

    const container = new Uint8Array(summary.bytes);
    container.set(summary.header, 0);
    let at = summary.header.length;
    for (const part of parts)
    {
        container.set(part, at);
        at += part.length;
    }
    container.set(summary.index, at);

    /** @param {number} offset @param {number} length */
    const fetchRange = async(offset, length)=>container.subarray(offset, offset + length);
    return { summary, container, bundle: await openBundle(fetchRange, decode) };
}

/**
 * Reads a whole file out of a bundle the way the engine does: block by block,
 * decoded, and cut to the length the last block of a file actually carries.
 *
 * @param {any} bundle @param {Uint8Array} container @param {string} path
 */
function readFile(bundle, container, path){
    const file = bundle.find(path);
    const out = new Uint8Array(file.size);
    for (const range of bundle.rangesFor(file, 0, file.size))
    {
        const { block, from, to } = range;
        const stored = container.subarray(block.offset, block.offset + block.packed);
        assert.equal(crc32(stored), block.crc, `block ${block.index} of ${path} is damaged`);
        out.set(decode(block.codec, stored).subarray(from, to), block.index === file.firstBlock
            ? 0
            : (block.index - file.firstBlock) * bundle.blockSize);
    }
    return out;
}

test('the engine\'s reader finds every file, byte for byte', async()=>{
    const files = [
        { path: 'title.exe', bytes: new Uint8Array(700).fill(0x41) },
        { path: 'data\\art.mpq', bytes: Uint8Array.from({ length: 5000 }, (u, at)=>at & 0xff) },
        { path: 'empty.dat', bytes: new Uint8Array(0) },
    ];
    const { bundle, container } = await packed(files, 1024);

    assert.deepEqual(bundle.files.map((/** @type {any} */ file)=>file.path),
        ['title.exe', 'data\\art.mpq', 'empty.dat']);
    for (const file of files)
    {
        assert.deepEqual(readFile(bundle, container, file.path), file.bytes,
            `${file.path} did not come back as it went in`);
    }
});

test('a file spanning blocks records the run, and the last block is short', async()=>{
    const bytes = Uint8Array.from({ length: 2500 }, (u, at)=>(at * 7) & 0xff);
    const { bundle } = await packed([{ path: 'big.bin', bytes }], 1024);

    const file = bundle.find('big.bin');
    assert.ok(file, 'the file just packed is not in the index');
    assert.equal(file.blocks, 3);
    assert.equal(bundle.block(file.firstBlock).length, 1024);
    assert.equal(bundle.block(file.firstBlock + 2).length, 2500 - 2048);
});

test('a block is only compressed when compression earns its keep', async()=>{
    const compressible = await packBlock(new Uint8Array(4096));
    assert.equal(compressible.codec, Codec.DEFLATE_RAW);

    // Random bytes do not compress, and a stored block is handed back unchanged
    // rather than grown by a deflate stream's own overhead.
    const noise = Uint8Array.from({ length: 4096 }, ()=>Math.floor(Math.random() * 256));
    const incompressible = await packBlock(noise);
    assert.equal(incompressible.codec, Codec.STORED);
    assert.equal(incompressible.bytes.length, noise.length);
});

test('the index digest describes the index exactly as it is stored', async()=>{
    const { summary, container } = await packed(
        [{ path: 'title.exe', bytes: new Uint8Array(2048).fill(7) }]);

    const view = new DataView(container.buffer, container.byteOffset);
    const offset = Number(view.getBigUint64(0x10, true));
    const length = Number(view.getBigUint64(0x18, true));
    assert.deepEqual(container.subarray(offset, offset + length), summary.index);

    const digest = await crypto.subtle.digest('SHA-256', summary.index.slice());
    assert.equal([...new Uint8Array(digest)]
        .map(byte=>byte.toString(16).padStart(2, '0')).join(''), summary.indexSha256);
});

test('nothing is handed to the sink but block bytes', async()=>{
    /** @type {number[]} */
    const lengths = [];
    const summary = await packBundle({
        files: [{ path: 'a.bin', bytes: new Uint8Array(3000).fill(1) }],
        blockSize: 1024,
        write: chunk=>{
            lengths.push(chunk.length);
        },
    });

    // The header and the index come back rather than going out, because an
    // upload cannot be seeked back to and neither is known until the end.
    assert.equal(lengths.reduce((total, at)=>total + at, 0), summary.blockBytes);
    assert.equal(lengths.length, summary.totalBlocks);
});

test('a file is hashed where it lies, a view of a larger buffer as its own bytes', async()=>{
    // Copied to be hashed, a game's 1.5 GB archive file was an allocation the
    // tab could not make, and the bottle was never saved.
    const whole = Uint8Array.from({ length: 64 }, (_, at)=>at);
    const view = whole.subarray(16, 48);
    assert.equal(await sha256(view), await sha256(whole.slice(16, 48)));
    assert.equal(await sha256(new Uint8Array(0)),
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    const shared = new Uint8Array(new SharedArrayBuffer(32));
    shared.set(whole.subarray(16, 48));
    assert.equal(await sha256(shared), await sha256(view), 'shared memory, copied to be read');
});
