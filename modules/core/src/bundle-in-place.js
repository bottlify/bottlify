/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A .btl laid out before its files' bytes are known, for a writer that gets
 * them out of order -- a download of chunks from several servers at once.
 * Every block is stored as it is, so where each file lies in the container
 * follows from the sizes alone: the bytes go straight to their place in any
 * order, and the bottle is never written a second time to pack it. The index
 * goes in last, once every byte is in (`finishBundle`), each block's checksum
 * and each file's digest read back from where they lie.
 *
 * What it gives up is compression: the Node writer deflates a block where that
 * saves a few per cent, and a game's data is mostly compressed already.
 */

import {
    Codec, DEFAULT_BLOCK_SIZE, FORMAT_VERSION, HEADER_SIZE, MAGIC,
} from './layers/filesystem/internal/bundle/format.js';
import { crc32 } from './layers/filesystem/internal/bundle/crc32.js';
import { createSha256 } from './layers/win32/crypto/digest.js';

/**
 * Random access to the container's bytes, as a worker's
 * FileSystemSyncAccessHandle gives it (a test's file in Node, the same shape).
 *
 * @typedef {Object} RandomAccess
 * @property {(buffer: Uint8Array, options: { at: number }) => number} read
 * @property {(buffer: Uint8Array, options: { at: number }) => number} write
 * @property {(size: number) => unknown} truncate
 * @property {() => unknown} flush
 * @property {() => number} getSize
 */

/**
 * @typedef {Object} PlacedFile
 * @property {string} path  Backslashed, as the bundle names it.
 * @property {number} size
 * @property {number} at  Where its bytes start in the container.
 */

/**
 * Where each file goes: one after another from `start`, in the order given.
 * Files placed later go after these, which do not move.
 *
 * @param {{ path: string, size: number }[]} files
 * @param {number} [start]  The header's end, or where the files placed before end.
 * @returns {{ files: PlacedFile[], end: number }}
 */
export function placeFiles(files, start = HEADER_SIZE){
    let at = start;
    const placed = files.map(({ path, size })=>{
        const file = { path, size, at };
        at += size;
        return file;
    });
    return { files: placed, end: at };
}

/** @param {Uint8Array} bytes */
const hex = bytes=>Array.from(bytes, byte=>byte.toString(16).padStart(2, '0')).join('');

/**
 * Writes the index after the files and the header in front of them: a bundle
 * the engine opens as any other. The index lists the files in the order given;
 * a placed file left out of it is bytes nothing reads.
 *
 * @param {RandomAccess} handle
 * @param {PlacedFile[]} files  The bundle's files, their bytes in place.
 * @param {string[]} directories  The empty ones, which a program may expect.
 * @param {{ blockSize?: number, onProgress?: (read: number, total: number) => void }} [options]
 */
export async function finishBundle(handle, files, directories,
    { blockSize = DEFAULT_BLOCK_SIZE, onProgress } = {})
{
    /** @type {{ offset: number, packed: number, codec: number, crc: number }[]} */
    const blocks = [];
    /** @type {{ path: string, size: number, firstBlock: number, blocks: number, sha256: string }[]} */
    const index = [];
    const total = files.reduce((sum, file)=>sum + file.size, 0);
    const buffer = new Uint8Array(blockSize);
    const end = files.reduce((last, file)=>Math.max(last, file.at + file.size), HEADER_SIZE);
    let read = 0;
    for (const file of files)
    {
        const firstBlock = blocks.length;
        // ponytail: SHA-256 in JS runs at about 100 MB/s, the most of finishing
        // a large game; hash in the decode workers as chunks land if it drags.
        const digest = createSha256();
        for (let offset = 0; offset < file.size; offset += blockSize)
        {
            const block = buffer.subarray(0, Math.min(blockSize, file.size - offset));
            if (handle.read(block, { at: file.at + offset }) !== block.length)
            {
                throw new Error(`bundle: ${file.path} is cut short in the container`);
            }
            digest.update(block);
            blocks.push({ offset: file.at + offset, packed: block.length, codec: Codec.STORED,
                crc: crc32(block) });
            read += block.length;
            onProgress?.(read, total);
        }
        index.push({ path: file.path, size: file.size, firstBlock,
            blocks: blocks.length - firstBlock, sha256: hex(digest.digest()) });
    }

    const indexBytes = new TextEncoder().encode(
        JSON.stringify({ blockSize, files: index, directories, blocks }));
    await handle.truncate(end + indexBytes.length);
    handle.write(indexBytes, { at: end });
    const header = new Uint8Array(HEADER_SIZE);
    const view = new DataView(header.buffer);
    header.set(Array.from(MAGIC, character=>character.charCodeAt(0)));
    view.setUint32(4, FORMAT_VERSION, true);
    view.setUint32(8, blockSize, true);
    view.setBigUint64(0x10, BigInt(end), true);
    view.setBigUint64(0x18, BigInt(indexBytes.length), true);
    view.setUint32(0x20, Codec.STORED, true);
    handle.write(header, { at: 0 });
    await handle.flush();
    const indexDigest = createSha256();
    indexDigest.update(indexBytes);
    return {
        format: `btl/${FORMAT_VERSION}`,
        codec: 'stored',
        blockSize,
        files: index.length,
        directories: directories.length,
        uncompressedBytes: total,
        bytes: end + indexBytes.length,
        totalBlocks: blocks.length,
        indexSha256: hex(indexDigest.digest()),
    };
}
