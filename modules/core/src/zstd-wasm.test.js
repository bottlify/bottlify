/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The wasm build of the project's own zstd decoder against Node's own zstd
 * and against the JavaScript decoder it mirrors. The build is a vendor
 * artifact (`npm run fetch:zstd` or `build:zstd`); without it in
 * `vendor/prebuilt/` the cases are skipped and say so, which is what a
 * checkout without the artifact is.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import zlib from 'node:zlib';
import { loadZstdWasm } from './zstd-wasm.js';
import { decompressZstd } from './zstd.js';

const PREBUILT = new URL('../vendor/prebuilt/', import.meta.url);

/** @returns {Promise<Uint8Array | null>} */
async function artifact(){
    try
    {
        return await readFile(new URL('zstd.wasm', PREBUILT));
    }
    catch {
        return null;
    }
}

/** @param {number} length @param {number} seed */
function noise(length, seed){
    const out = Buffer.alloc(length);
    let state = seed;
    for (let at = 0; at < length; at++)
    {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        out[at] = (state >>> 16) & 0xff;
    }
    return out;
}

const bytes = await artifact();
const skip = bytes ? false : 'zstd.wasm absent from vendor/prebuilt (npm run fetch:zstd)';

test('the wasm decoder decodes what Node wrote, at every level, like the JavaScript one',
    { skip }, async()=>{
        const wasm = await loadZstdWasm(/** @type {Uint8Array} */ (bytes));
        assert.equal(wasm.version, 1);
        const topHeavy = Buffer.alloc(100_000);
        for (let at = 0; at < topHeavy.length; at++)
        {
            const r = (Math.imul(at, 2654435761) >>> 0) % 100;
            topHeavy[at] = r < 80 ? 0xff : r < 90 ? 0x41 : r < 95 ? 0x42 : (r % 7) + 0x30;
        }
        const inputs = [
            Buffer.alloc(0), Buffer.from([7]), Buffer.alloc(4096, 0xab),
            Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(1500)),
            noise(1 << 20, 12345), Buffer.from(Array.from({ length: 3 << 20 }, (_, at)=>at & 0xff)),
            Buffer.from(noise(1 << 20, 7).map((byte, at)=>at % 7 === 0 ? 0 : byte)), topHeavy,
        ];
        for (const input of inputs)
        {
            for (const level of [1, 3, 9, 19])
            {
                const packed = zlib.zstdCompressSync(input,
                    { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });
                assert.deepEqual(Buffer.from(wasm.decompress(packed, input.length)), input,
                    `${input.length} bytes at level ${level}`);
                assert.deepEqual(Buffer.from(wasm.decompress(packed, 0)),
                    Buffer.from(decompressZstd(packed, 0)), 'the frame\'s own size, as zstd.js');
            }
        }
    });

test('the wasm decoder refuses what the JavaScript one refuses, in the same words',
    { skip }, async()=>{
        const wasm = await loadZstdWasm(/** @type {Uint8Array} */ (bytes));
        const packed = zlib.zstdCompressSync(Buffer.from('hello '.repeat(1000)));
        assert.throws(()=>wasm.decompress(packed.subarray(0, packed.length >> 1), 6000),
            /ended before it was supposed to/);
        assert.throws(()=>decompressZstd(packed.subarray(0, packed.length >> 1), 6000),
            /ended before it was supposed to/);
        assert.throws(()=>wasm.decompress(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 0),
            /corrupt/);
    });
