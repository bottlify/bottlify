/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

/**
 * The .btl bundle format: read and write.
 *
 * A bundle holds a game and nothing else. What the game *is* -- its title, its
 * cover, which version this is -- lives in a manifest beside it, because that
 * is catalogue data: it changes without the bytes changing, it is read by
 * things that will never open the archive, and a format that carries it forces
 * a rewrite of gigabytes to correct a description.
 *
 * The shape is dictated by how it will be read: over HTTP, by a browser, a few
 * kilobytes at a time, in whatever order the game seeks. So
 *
 *   - a fixed header at the very front, so one small range request tells the
 *     reader where everything is;
 *   - data cut into fixed-size blocks, so reading a hundred bytes at a random
 *     offset costs one block, not a file;
 *   - a codec per block rather than per bundle, because game data is mostly
 *     already-compressed archives with a few executables mixed in, and the two
 *     want opposite answers;
 *   - the index at the end, so writing is a single forward pass over the input
 *     and never needs to seek back and patch a size.
 *
 * Layout:
 *
 *     0x00  magic "BTL1"                    4
 *     0x04  format version                  4
 *     0x08  block size                      4
 *     0x0c  reserved                        4
 *     0x10  index offset                    8
 *     0x18  index length (as stored)        8
 *     0x20  index codec                     4
 *     0x24  reserved                        4
 *           ... blocks, back to back ...
 *           ... index ...
 */

import { createReadStream } from 'node:fs';
import { open, stat, readdir, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, sep } from 'node:path';
import zlib from 'node:zlib';

export const MAGIC = 'BTL1';
export const HEADER_SIZE = 0x28;
export const FORMAT_VERSION = 1;

/** What a block was written with. */
export const Codec = {
    STORED: 0,
    DEFLATE_RAW: 1,
};

/**
 * A quarter of a mebibyte.
 *
 * The block is the granularity of a random read, of an HTTP range fetch, and of
 * one decompression, so the instinct is that a bigger one compresses better and
 * seeks worse. Measured across both games at 256 KiB, 1, 4 and 16 MiB, the first
 * half of that is false here: 256 KiB gives the *best* ratio of the four, and
 * 16 MiB loses 4.9 MiB on one game and 25.5 MiB on the other.
 *
 * The reason is the probe below rather than the compressor's window. A fixed
 * 96 KiB probe is a third of a 256 KiB block and a hundredth of a 16 MiB one, so
 * a compressible region diluted into a large block stops clearing the threshold
 * and the whole block is stored. If a larger block is ever wanted, the probe has
 * to grow with it.
 *
 * The index argument for large blocks is real and worthless in absolute terms:
 * the whole index of the five-gigabyte bundle is 113 KiB at this size and 3.4 KiB
 * at 16 MiB. Saving 110 KiB once is not worth making every random read fetch and
 * inflate sixty-four times as much.
 */
export const DEFAULT_BLOCK_SIZE = 1 << 18;

/**
 * A block is stored uncompressed unless compression saves at least this much.
 *
 * Below it the saving is not worth the decompression on every future read --
 * and on this kind of data most blocks land at "saves nothing at all", so the
 * threshold is what keeps the archive fast rather than merely small.
 */
const MIN_SAVING = 0.04;

/**
 * How much of a block to compress before deciding whether to compress it.
 *
 * Game data is mostly already-compressed archives, and compressing all of it to
 * discover that is most of the build time. A cheap look at part of a block
 * predicts the rest well enough, because a block is one kind of data.
 *
 * A fraction rather than a fixed size, because a fixed one silently becomes a
 * worse and worse predictor as the block grows -- which is exactly what made
 * large blocks compress badly when this was 96 KiB regardless.
 */
const PROBE_FRACTION = 0.4;
const PROBE_CAP = 256 * 1024;
const PROBE_LEVEL = 1;

const deflate = (/** @type {Buffer} */ bytes, /** @type {number} */ level)=>
    zlib.deflateRawSync(bytes, { level });
const inflate = (/** @type {Buffer | Uint8Array} */ bytes)=>zlib.inflateRawSync(bytes);

/**
 * Chooses how to store one block, and returns it stored that way.
 *
 * @param {Buffer} block
 * @param {number} level
 * @returns {{ codec: number, bytes: Buffer }}
 */
export function packBlock(block, level = 9){
    const probeBytes = Math.min(PROBE_CAP, Math.ceil(block.length * PROBE_FRACTION));
    const probe = block.length > probeBytes ? block.subarray(0, probeBytes) : block;
    const sample = deflate(probe, PROBE_LEVEL);
    if (sample.length > probe.length * (1 - MIN_SAVING))
    {
        return { codec: Codec.STORED, bytes: block };
    }

    const packed = deflate(block, level);
    return packed.length <= block.length * (1 - MIN_SAVING)
        ? { codec: Codec.DEFLATE_RAW, bytes: packed }
        : { codec: Codec.STORED, bytes: block };
}

/**
 * @param {number} codec
 * @param {Buffer | Uint8Array} bytes
 * @returns {Buffer | Uint8Array}
 */
export function unpackBlock(codec, bytes){
    switch (codec){
        case Codec.STORED:
            return bytes;
        case Codec.DEFLATE_RAW:
            return inflate(bytes);
        default:
            throw new Error(`btl: unknown block codec ${codec}`);
    }
}

/**
 * Every file under a directory, in a stable order, with the paths a guest will
 * ask for: relative to the root and separated by backslashes.
 *
 * @param {string} root
 * @returns {Promise<{ files: { path: string, source: string, size: number }[],
 *                     directories: string[] }>}
 */
export async function scanTree(root){
    /** @type {{ path: string, source: string, size: number }[]} */
    const files = [];
    /** @type {string[]} */
    const directories = [];

    /** @param {string} dir */
    async function walk(dir){
        const entries = await readdir(dir, { withFileTypes: true });
        // Sorted so a rebuild of the same input produces the same bundle: a
        // directory listing's order is the filesystem's business, not ours.
        entries.sort((a, b)=>a.name < b.name ? -1 : 1);

        for (const entry of entries)
        {
            const path = join(dir, entry.name);
            if (entry.isDirectory())
            {
                await walk(path);
            }
            else if (entry.isFile())
            {
                const info = await stat(path);
                files.push({
                    path: relative(root, path).split(sep).join('\\'),
                    source: path,
                    size: info.size,
                });
            }
        }
        // An empty directory is part of what a program expects to find: some
        // create files in one and fail if it is missing, and nothing about the
        // file list would put it back. Only a genuinely empty one is recorded --
        // a directory holding another is rebuilt along with what it holds.
        if (entries.length === 0 && dir !== root)
        {
            directories.push(relative(root, dir).split(sep).join('\\'));
        }
    }

    await walk(root);
    return { files, directories };
}

/**
 * Writes a bundle.
 *
 * @param {Object} options
 * @param {string} options.root         Directory to pack.
 * @param {string} options.output       Path of the .btl file.
 * @param {number} [options.blockSize]
 * @param {number} [options.level]
 * @param {boolean} [options.store]     Store everything; skip compression entirely.
 * @param {(progress: any) => void} [options.onProgress]
 * @returns {Promise<any>} what the manifest needs to know about the bundle
 */
export async function writeBundle(options){
    const {
        root, output, blockSize = DEFAULT_BLOCK_SIZE, level = 9, store = false, onProgress,
    } = options;
    const { files, directories } = await scanTree(root);
    const handle = await open(output, 'w');

    const header = Buffer.alloc(HEADER_SIZE);
    header.write(MAGIC, 0, 'latin1');
    header.writeUInt32LE(FORMAT_VERSION, 4);
    header.writeUInt32LE(blockSize, 8);
    await handle.write(header, 0, HEADER_SIZE, 0);

    /** @type {{ offset: number, packed: number, codec: number }[]} */
    const blocks = [];
    /** @type {any[]} */
    const index = [];
    const digest = createHash('sha256');

    let cursor = HEADER_SIZE;
    let rawTotal = 0;
    let packedTotal = 0;

    for (const file of files)
    {
        const firstBlock = blocks.length;
        const fileDigest = createHash('sha256');

        // Streamed rather than read whole: a bundle holds files far larger than
        // this process may hold in memory.
        const stream = createReadStream(file.source, { highWaterMark: blockSize });
        /** @type {Buffer[]} */
        let pending = [];
        let pendingBytes = 0;

        /** @param {Buffer} block */
        const emit = async block=>{
            fileDigest.update(block);
            const { codec, bytes } = store
                ? { codec: Codec.STORED, bytes: block }
                : packBlock(block, level);
            await handle.write(bytes, 0, bytes.length, cursor);
            digest.update(bytes);
            blocks.push({ offset: cursor, packed: bytes.length, codec });
            cursor += bytes.length;
            rawTotal += block.length;
            packedTotal += bytes.length;
            onProgress?.({ path: file.path, rawTotal, packedTotal, blocks: blocks.length });
        };

        for await (const chunk of stream)
        {
            pending.push(chunk);
            pendingBytes += chunk.length;
            while (pendingBytes >= blockSize)
            {
                const joined = Buffer.concat(pending, pendingBytes);
                await emit(joined.subarray(0, blockSize));
                pending = [joined.subarray(blockSize)];
                pendingBytes = pending[0].length;
            }
        }
        if (pendingBytes > 0)
        {
            await emit(Buffer.concat(pending, pendingBytes));
        }
        index.push({
            path: file.path,
            size: file.size,
            firstBlock,
            blocks: blocks.length - firstBlock,
            sha256: fileDigest.digest('hex'),
        });
    }

    const indexJson = Buffer.from(JSON.stringify({ blockSize, files: index, directories, blocks }));
    const indexBytes = deflate(indexJson, 9);
    await handle.write(indexBytes, 0, indexBytes.length, cursor);

    header.writeBigUInt64LE(BigInt(cursor), 0x10);
    header.writeBigUInt64LE(BigInt(indexBytes.length), 0x18);
    header.writeUInt32LE(Codec.DEFLATE_RAW, 0x20);
    await handle.write(header, 0, HEADER_SIZE, 0);
    await handle.close();

    const total = cursor + indexBytes.length;
    return {
        format: `btl/${FORMAT_VERSION}`,
        blockSize,
        files: index.length,
        directories: directories.length,
        uncompressedBytes: rawTotal,
        bytes: total,
        ratio: rawTotal === 0 ? 1 : packedTotal / rawTotal,
        storedBlocks: blocks.filter(block=>block.codec === Codec.STORED).length,
        totalBlocks: blocks.length,
        indexBytes: indexBytes.length,
        sha256: digest.digest('hex'),
    };
}

/**
 * Opens a bundle for reading: the header and the index, and nothing else until
 * something is actually read.
 *
 * @param {string} path
 */
export async function openBundle(path){
    const handle = await open(path, 'r');
    const header = Buffer.alloc(HEADER_SIZE);
    await handle.read(header, 0, HEADER_SIZE, 0);

    if (header.toString('latin1', 0, 4) !== MAGIC)
    {
        await handle.close();
        throw new Error(`${path} is not a .btl bundle`);
    }
    const version = header.readUInt32LE(4);
    if (version !== FORMAT_VERSION)
    {
        await handle.close();
        throw new Error(`${path} is format version ${version}, not ${FORMAT_VERSION}`);
    }

    const blockSize = header.readUInt32LE(8);
    const indexOffset = Number(header.readBigUInt64LE(0x10));
    const indexLength = Number(header.readBigUInt64LE(0x18));
    const indexCodec = header.readUInt32LE(0x20);

    const stored = Buffer.alloc(indexLength);
    await handle.read(stored, 0, indexLength, indexOffset);
    const index = JSON.parse(Buffer.from(unpackBlock(indexCodec, stored)).toString());

    const byPath = new Map(index.files.map((/** @type {any} */ file)=>
        [file.path.toLowerCase(), file]));

    return {
        blockSize,
        index,

        list: ()=>index.files,
        directories: ()=>index.directories,

        /** @param {string} filePath */
        stat: filePath=>byPath.get(filePath.toLowerCase()) ?? null,

        /**
         * Reads a range of one file, touching only the blocks it covers.
         *
         * @param {string} filePath
         * @param {number} [offset]
         * @param {number} [length]
         * @returns {Promise<Buffer>}
         */
        async read(filePath, offset = 0, length = Infinity){
            const file = byPath.get(filePath.toLowerCase());
            if (!file)
            {
                throw new Error(`${filePath} is not in this bundle`);
            }

            const end = Math.min(file.size, offset + length);
            if (end <= offset)
            {
                return Buffer.alloc(0);
            }

            const first = Math.floor(offset / blockSize);
            const last = Math.floor((end - 1) / blockSize);
            /** @type {Buffer[]} */
            const parts = [];

            for (let at = first; at <= last; at++)
            {
                const block = index.blocks[file.firstBlock + at];
                const raw = Buffer.alloc(block.packed);
                await handle.read(raw, 0, block.packed, block.offset);
                const bytes = Buffer.from(unpackBlock(block.codec, raw));

                const from = at === first ? offset - first * blockSize : 0;
                const to = at === last ? end - at * blockSize : bytes.length;
                parts.push(bytes.subarray(from, to));
            }
            return Buffer.concat(parts);
        },

        close: ()=>handle.close(),
    };
}

/**
 * Reads a whole bundle back and checks every file against the digest recorded
 * when it was written.
 *
 * @param {string} path
 * @param {(progress: any) => void} [onProgress]
 */
export async function verifyBundle(path, onProgress){
    const bundle = await openBundle(path);
    let checked = 0;
    /** @type {string[]} */
    const bad = [];

    for (const file of bundle.list())
    {
        const digest = createHash('sha256');
        for (let at = 0; at < file.size; at += bundle.blockSize)
        {
            digest.update(await bundle.read(file.path, at, bundle.blockSize));
        }
        if (digest.digest('hex') !== file.sha256)
        {
            bad.push(file.path);
        }
        checked++;
        onProgress?.({ checked, total: bundle.list().length, path: file.path });
    }

    await bundle.close();
    return { checked, bad };
}

/** @param {string} directory */
export const ensureDirectory = directory=>mkdir(directory, { recursive: true });
