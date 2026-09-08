/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The .btl container, written from a browser.
 *
 * A bottle made here never has to be packed: the prefix is already in the
 * origin's storage and the engine mounts it as it stands. Packing is what
 * happens when it is shared -- and a shared bottle has to travel anyway, so the
 * bytes that go into the request are the packed ones rather than the installed
 * tree. That halves what crosses the wire and means nothing is written locally
 * at all, which is the whole reason this writer exists beside the Node one.
 *
 * The format constants and the checksum come from the reader, which is the
 * thing that has to agree with this. Nothing about the layout is restated here.
 *
 * Two departures from the Node writer, both forced and both harmless:
 *
 *   - deflate only. A browser has `CompressionStream`, which has no zstd, and a
 *     block is stored uncompressed unless deflate earns its keep.
 *   - no whole-bundle digest. `crypto.subtle` hashes a whole message and has no
 *     incremental form, and concatenating every packed block to hash it is the
 *     one allocation this design exists to avoid. Whoever assembles the
 *     container computes it while the bytes pass through; the index digest,
 *     which is the one checked on every launch, is computed here because the
 *     index is small enough to hold.
 */

import { MAGIC, HEADER_SIZE, FORMAT_VERSION, Codec }
    from '../../core/src/layers/filesystem/internal/bundle/format.js';
import { crc32 } from '../../core/src/layers/filesystem/internal/bundle/crc32.js';

/** A quarter of a mebibyte, as the Node writer uses: it decides how long a guest thread is held. */
export const DEFAULT_BLOCK_SIZE = 1 << 18;

/** A block is stored uncompressed unless compressing it saves at least this much. */
const MIN_SAVING = 0.04;

/**
 * @typedef {Object} PackProgress
 * @property {string} path
 * @property {number} rawTotal
 * @property {number} packedTotal
 */

/**
 * @typedef {Object} PackInput
 * @property {string} path
 * @property {Uint8Array} bytes
 */

/**
 * @typedef {Object} PackedSummary
 * @property {Uint8Array} header        The container's first bytes, complete.
 * @property {Uint8Array} index         The index, exactly as it must be stored.
 * @property {number} blockSize
 * @property {number} files
 * @property {number} directories
 * @property {number} uncompressedBytes
 * @property {number} blockBytes        How much was handed to `write`.
 * @property {number} bytes             The finished container's size.
 * @property {number} storedBlocks
 * @property {number} totalBlocks
 * @property {string} indexSha256
 */

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array>}
 */
async function deflateRaw(bytes){
    const source = /** @type {any} */ (bytes);
    const stream = new Blob([source]).stream()
        .pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function sha256(bytes){
    const digest = await crypto.subtle.digest('SHA-256', bytes.slice());
    return [...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2, '0')).join('');
}

/**
 * How one block is stored: compressed if that is worth a decompression on every
 * future read, and left alone otherwise. Game data is mostly already-compressed
 * archives, so "left alone" is the common answer and the threshold is what
 * keeps a bundle fast rather than merely small.
 *
 * @param {Uint8Array} block
 * @returns {Promise<{ codec: number, bytes: Uint8Array }>}
 */
export async function packBlock(block){
    const packed = await deflateRaw(block);
    return packed.length <= block.length * (1 - MIN_SAVING)
        ? { codec: Codec.DEFLATE_RAW, bytes: packed }
        : { codec: Codec.STORED, bytes: block };
}

/**
 * Writes a container's blocks through `write`, and hands back everything else
 * it is made of.
 *
 * The header and the index come back rather than going out through `write`,
 * because neither is known until the last block has been packed and a stream
 * that cannot be seeked cannot go back for them. Whoever puts the container
 * together writes the header at offset zero and the index at the end, and does
 * not have to know what either means.
 *
 * @param {Object} options
 * @param {PackInput[]} options.files
 * @param {string[]} [options.directories]  Empty ones, which a program may expect.
 * @param {number} [options.blockSize]
 * @param {(bytes: Uint8Array) => Promise<void> | void} options.write
 * @param {(progress: PackProgress) => void} [options.onProgress]
 * @returns {Promise<PackedSummary>}
 */
export async function packBundle({ files, directories = [], write, onProgress,
    blockSize = DEFAULT_BLOCK_SIZE })
{
    /** @type {{ offset: number, packed: number, codec: number, crc: number }[]} */
    const blocks = [];
    /** @type {any[]} */
    const index = [];

    let cursor = HEADER_SIZE;
    let rawTotal = 0;
    let stored = 0;

    for (const file of files)
    {
        const firstBlock = blocks.length;
        for (let at = 0; at < file.bytes.length; at += blockSize)
        {
            const block = file.bytes.subarray(at, Math.min(at + blockSize, file.bytes.length));
            const { codec, bytes } = await packBlock(block);
            await write(bytes);
            // Over the stored bytes: this is checked when a block arrives,
            // before anything decodes it, so it has to cover what travels.
            blocks.push({ offset: cursor, packed: bytes.length, codec, crc: crc32(bytes) });
            cursor += bytes.length;
            rawTotal += block.length;
            if (codec === Codec.STORED)
            {
                stored++;
            }
            onProgress?.({ path: file.path, rawTotal, packedTotal: cursor - HEADER_SIZE });
        }
        index.push({
            path: file.path,
            size: file.bytes.length,
            firstBlock,
            blocks: blocks.length - firstBlock,
            sha256: await sha256(file.bytes),
        });
    }

    const indexBytes = await deflateRaw(new TextEncoder().encode(
        JSON.stringify({ blockSize, files: index, directories, blocks })));

    const header = new Uint8Array(HEADER_SIZE);
    const view = new DataView(header.buffer);
    for (let at = 0; at < MAGIC.length; at++)
    {
        header[at] = MAGIC.charCodeAt(at);
    }
    view.setUint32(4, FORMAT_VERSION, true);
    view.setUint32(8, blockSize, true);
    view.setBigUint64(0x10, BigInt(cursor), true);
    view.setBigUint64(0x18, BigInt(indexBytes.length), true);
    view.setUint32(0x20, Codec.DEFLATE_RAW, true);

    return {
        header,
        index: indexBytes,
        blockSize,
        files: index.length,
        directories: directories.length,
        uncompressedBytes: rawTotal,
        blockBytes: cursor - HEADER_SIZE,
        bytes: cursor + indexBytes.length,
        storedBlocks: stored,
        totalBlocks: blocks.length,
        indexSha256: await sha256(indexBytes),
    };
}
