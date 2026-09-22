/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The emulator carries a zstd decoder, and this checks that we can use it.
 *
 * It matters because it is the only decompressor available to us that answers
 * without a promise. A guest's read happens while the CPU is stopped inside one
 * instruction; anything that returns a promise there means parking the thread
 * and resuming it a turn later, on every read of every cached block.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import zlib from 'node:zlib';
import { assembleModules } from '../../../core.js';

const PREBUILT = new URL('../../../../vendor/prebuilt/', import.meta.url);

async function bootedCpu(){
    const [wasm] = await Promise.all([readFile(new URL('v86.wasm', PREBUILT))]);
    // The emulator's own decoder, so this file names the engine rather than
    // taking the run's default (`cork`).
    const core = await assembleModules({ cpu: { engine: 'emulator' } });
    const cpu = core.api('cpu');
    await cpu.boot({
        moduleUrl: new URL('libv86.mjs', PREBUILT).href,
        wasmBytes: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength),
    });
    return { core, cpu };
}

/** @param {Uint8Array | Buffer} bytes */
const zstd = bytes=>new Uint8Array(zlib.zstdCompressSync(bytes, {
    params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 },
}));

test('a zstd frame decodes through the emulator, byte for byte', async()=>{
    const { core, cpu } = await bootedCpu();

    // Shaped like what a bundle actually compresses: a block of an executable,
    // which is the kind of content that compresses at all.
    const original = new Uint8Array(256 * 1024);
    for (let at = 0; at < original.length; at++)
    {
        original[at] = (at * 31 + (at >> 8)) & 0xff;
    }

    const decoded = cpu.decompressZstd(zstd(original), original.length);
    assert.equal(decoded.length, original.length);
    assert.deepEqual([...decoded.subarray(0, 64)], [...original.subarray(0, 64)]);
    assert.ok(decoded.every((/** @type {number} */ byte, /** @type {number} */ at)=>
        byte === original[at]), 'every byte survived');

    await core.dispose();
});

test('decoding twice gives the same answer, and gives its scratch back', async()=>{
    const { core, cpu } = await bootedCpu();
    const original = new Uint8Array(64 * 1024).fill(0x5a);
    const packed = zstd(original);

    // The decoder allocates inside the emulator's own memory, which is where
    // guest RAM lives. A frame decoded a thousand times must not grow it.
    for (let pass = 0; pass < 1000; pass++)
    {
        const decoded = cpu.decompressZstd(packed, original.length);
        if (pass % 250 === 0)
        {
            assert.equal(decoded.length, original.length);
            assert.equal(decoded[0], 0x5a);
        }
    }

    await core.dispose();
});

test('a frame that does not hold what it claims is an error, not silence', async()=>{
    const { core, cpu } = await bootedCpu();
    const packed = zstd(new Uint8Array(1024).fill(7));

    // Asking for more than the frame contains has to fail loudly: a short read
    // answered with zeroes is a file the guest reads as corrupt much later.
    assert.throws(()=>cpu.decompressZstd(packed, 4096), /ended before/);

    await core.dispose();
});
