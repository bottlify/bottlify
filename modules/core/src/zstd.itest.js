/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * This project's decoder against libzstd, Node's own, on bundle blocks: every
 * zstd block must decode byte for byte to what libzstd gives, and the
 * per-megabyte cost of each is printed. A guest file read is not a hot path.
 * The packer no longer writes zstd, but published bundles carry it (blocks
 * packed at level 19), so the fixture's blocks are packed the same way here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
import { openBundle, Codec } from './layers/filesystem/internal/bundle/format.js';
import { decompressZstd } from './zstd.js';

const BLOCK_SIZE = 64 * 1024;

/** Deterministic noise no compressor can help with. @param {number} length */
function noise(length){
    const out = Buffer.alloc(length);
    let state = 12345;
    for (let at = 0; at < length; at++)
    {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        out[at] = (state >>> 16) & 0xff;
    }
    return out;
}

/**
 * Text, a ramp, random bytes and sparse noise, in blocks packed by libzstd at
 * the level bundles were packed at.
 *
 * @returns {{ packed: Uint8Array, length: number }[]}
 */
function fixtureBlocks(){
    const content = Buffer.concat([
        Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(600)),
        Buffer.from(Array.from({ length: 200_000 }, (_, at)=>at & 0xff)),
        randomBytes(200_000),
        // Huffman literals and FSE sequences: the decoder's heavier path.
        Buffer.from(noise(1 << 20).map((byte, at)=>at % 7 === 0 ? 0 : byte)),
    ]);
    const blocks = [];
    for (let at = 0; at < content.length; at += BLOCK_SIZE)
    {
        const block = content.subarray(at, at + BLOCK_SIZE);
        blocks.push({ packed: new Uint8Array(zlib.zstdCompressSync(block,
            { params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 } })), length: block.length });
    }
    return blocks;
}

/**
 * Every zstd block of a bundle on disk.
 *
 * @param {string} path
 * @returns {Promise<{ packed: Uint8Array, length: number }[]>}
 */
async function bundleBlocks(path){
    const bytes = new Uint8Array(await readFile(path));
    const bundle = await openBundle(
        async(at, count)=>bytes.subarray(at, at + count),
        (codec, block)=>codec === Codec.DEFLATE_RAW
            ? new Uint8Array(zlib.inflateRawSync(block))
            : codec === Codec.ZSTD ? decompressZstd(block, 0) : block);
    const blocks = [];
    for (let at = 0; at < bundle.blockCount; at++)
    {
        const block = bundle.block(at);
        if (block.codec === Codec.ZSTD)
        {
            blocks.push({ packed: bytes.subarray(block.offset, block.offset + block.packed),
                length: block.length });
        }
    }
    return blocks;
}

test('every zstd block of a bundle matches libzstd', async()=>{
    // The largest bundle's blocks when one is named (the owner's own), the
    // fixture below otherwise: `BOTTLIFY_ZSTD_BUNDLE=/path/to/bundle.btl`.
    const named = process.env.BOTTLIFY_ZSTD_BUNDLE;
    const zstdBlocks = named ? await bundleBlocks(named) : fixtureBlocks();
    assert.ok(zstdBlocks.length >= 1, 'the fixture carries zstd blocks');

    /** @param {Uint8Array} packed */
    const libzstd = packed=>new Uint8Array(zlib.zstdDecompressSync(packed));

    let packed = 0;
    let unpacked = 0;
    for (const block of zstdBlocks)
    {
        packed += block.packed.length;
        const mine = decompressZstd(block.packed, block.length);
        assert.equal(mine.length, block.length);
        const theirs = libzstd(block.packed);
        assert.deepEqual([...mine], [...theirs], `block of ${block.packed.length} bytes`);
        unpacked += mine.length;
    }
    // A warm pass, so the first call's compilation is not the measurement.
    for (let round = 0; round < 3; round++)
    {
        for (const block of zstdBlocks)
        {
            decompressZstd(block.packed, block.length);
            libzstd(block.packed);
        }
    }
    const mineAt = performance.now();
    for (const block of zstdBlocks)
    {
        decompressZstd(block.packed, block.length);
    }
    const mineMs = performance.now() - mineAt;
    const theirsAt = performance.now();
    for (const block of zstdBlocks)
    {
        libzstd(block.packed);
    }
    const theirsMs = performance.now() - theirsAt;

    const mb = unpacked / (1024 * 1024);
    console.log(`zstd (${named ?? 'the itest fixture'}): ${zstdBlocks.length} blocks, `
        + `${(packed / 1024).toFixed(0)} KiB packed, ${mb.toFixed(1)} MiB out; `
        + `ours ${(mb / (mineMs / 1000)).toFixed(1)} MiB/s (${(mineMs / 1000).toFixed(2)} s), `
        + `libzstd ${(mb / (theirsMs / 1000)).toFixed(1)} MiB/s`
        + ` (${(theirsMs / 1000).toFixed(2)} s)`);
    assert.ok(mb > 0.1, `enough to time: ${mb} MiB`);
});
