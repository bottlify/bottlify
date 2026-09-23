/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The new decoder against the emulator's own, on the bundle's actual blocks:
 * every zstd block of a written bundle must decode byte for byte to what the
 * vendored wasm gives, and the per-megabyte cost of both is printed. A
 * JavaScript decoder is expected within a few times the wasm one, and a
 * guest file read is not a hot path.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
import { createV86Host } from './layers/cpu/internal/v86-host.js';
import { writeBundle } from '../../../tools/btl.mjs';
import { openBundle, Codec } from './layers/filesystem/internal/bundle/format.js';
import { decompressZstd } from './zstd.js';
import { loadZstdWasm } from './zstd-wasm.js';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);
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

/** The content a bundle carries here: text, a ramp and noise, all three codecs. @returns {Promise<Uint8Array>} */
async function buildBundle(){
    const directory = await mkdtemp(join(tmpdir(), 'btl-zstd-'));
    const root = join(directory, 'tree');
    try
    {
        await mkdir(join(root, 'Data'), { recursive: true });
        await writeFile(join(root, 'Data', 'Notes.txt'),
            'the quick brown fox jumps over the lazy dog. '.repeat(600));
        await writeFile(join(root, 'Data', 'Ramp.dat'),
            Buffer.from(Array.from({ length: 200_000 }, (_, at)=>at & 0xff)));
        await writeFile(join(root, 'Data', 'Random.bin'), randomBytes(200_000));
        // Huffman literals and FSE sequences: the decoder's heavier path.
        await writeFile(join(root, 'Data', 'Mixed.bin'),
            Buffer.from(noise(1 << 20).map((byte, at)=>at % 7 === 0 ? 0 : byte)));
        const output = join(directory, 'bundle.btl');
        await writeBundle({ root, output, blockSize: BLOCK_SIZE });
        return new Uint8Array(await readFile(output));
    }
    finally
    {
        await rm(directory, { recursive: true, force: true });
    }
}

test('every zstd block of a bundle matches the emulator\'s decoder', async t=>{
    // The largest bundle's blocks when one is named (the owner's own), the
    // fixture below otherwise: `BOTTLIFY_ZSTD_BUNDLE=/path/to/bundle.btl`.
    const named = process.env.BOTTLIFY_ZSTD_BUNDLE;
    const bytes = named ? new Uint8Array(await readFile(named)) : await buildBundle();
    const bundle = await openBundle(
        async(at, count)=>bytes.subarray(at, at + count),
        (codec, block)=>codec === Codec.DEFLATE_RAW
            ? new Uint8Array(zlib.inflateRawSync(block))
            : codec === Codec.ZSTD ? decompressZstd(block, 0) : block);
    const zstdBlocks = [];
    for (let at = 0; at < bundle.blockCount; at++)
    {
        const block = bundle.block(at);
        if (block.codec === Codec.ZSTD)
        {
            zstdBlocks.push({ packed: bytes.subarray(block.offset, block.offset + block.packed),
                length: block.length });
        }
    }
    assert.ok(zstdBlocks.length >= 1, 'the fixture carries zstd blocks');

    const [wasm] = await Promise.all([readFile(new URL('v86.wasm', PREBUILT))]);
    // The emulator's decoder lives in its wasm and left the cpu api in 5.5,
    // so the machine is built directly to judge this project's own decoder.
    const machine = await createV86Host({
        moduleUrl: new URL('libv86.mjs', PREBUILT).href,
        wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
        memorySize: 64 * 1024 * 1024, trapPort: 0xb077, entryVector: 0x7000,
        initialStack: 0x300000,
    });
    t.after(()=>machine.stop());

    let packed = 0;
    let unpacked = 0;
    for (const block of zstdBlocks)
    {
        packed += block.packed.length;
        const mine = decompressZstd(block.packed, block.length);
        assert.equal(mine.length, block.length);
        const theirs = machine.decompressZstd(block.packed, block.length);
        assert.deepEqual([...mine], [...theirs], `block of ${block.packed.length} bytes`);
        unpacked += mine.length;
    }
    // A warm pass, so the first call's compilation is not the measurement.
    for (let round = 0; round < 3; round++)
    {
        for (const block of zstdBlocks)
        {
            decompressZstd(block.packed, block.length);
            machine.decompressZstd(block.packed, block.length);
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
        machine.decompressZstd(block.packed, block.length);
    }
    const theirsMs = performance.now() - theirsAt;

    const mb = unpacked / (1024 * 1024);
    console.log(`zstd (${named ?? 'the itest fixture'}): ${zstdBlocks.length} blocks, `
        + `${(packed / 1024).toFixed(0)} KiB packed, ${mb.toFixed(1)} MiB out; `
        + `ours ${(mb / (mineMs / 1000)).toFixed(1)} MiB/s (${(mineMs / 1000).toFixed(2)} s), `
        + `the emulator's ${(mb / (theirsMs / 1000)).toFixed(1)} MiB/s`
        + ` (${(theirsMs / 1000).toFixed(2)} s)`);
    assert.ok(mb > 0.1, `enough to time: ${mb} MiB`);

    // The wasm build of the same decoder, when this checkout carries it: byte
    // for byte the emulator's answer, and not slower than the emulator's decoder.
    let wasmBytes = null;
    try
    {
        wasmBytes = await readFile(new URL('zstd.wasm', PREBUILT));
    }
    catch {
        console.log('zstd.wasm absent from vendor/prebuilt (npm run fetch:zstd or build:zstd):'
            + ' the wasm build is not judged');
    }
    if (wasmBytes)
    {
        const ours = await loadZstdWasm(wasmBytes);
        for (const block of zstdBlocks)
        {
            assert.deepEqual([...ours.decompress(block.packed, block.length)],
                [...machine.decompressZstd(block.packed, block.length)],
                `wasm build, block of ${block.packed.length} bytes`);
        }
        for (let round = 0; round < 3; round++)
        {
            for (const block of zstdBlocks)
            {
                ours.decompress(block.packed, block.length);
            }
        }
        const wasmAt = performance.now();
        for (const block of zstdBlocks)
        {
            ours.decompress(block.packed, block.length);
        }
        const wasmMs = performance.now() - wasmAt;
        console.log(`zstd wasm build: ${(mb / (wasmMs / 1000)).toFixed(1)} MiB/s`
            + ` (${(wasmMs / 1000).toFixed(2)} s)`);
        assert.ok(wasmMs <= theirsMs * 1.25,
            `the wasm build (${wasmMs.toFixed(0)} ms) is not slower than the emulator's decoder`
            + ` (${theirsMs.toFixed(0)} ms) beyond timing noise`);
    }
});
