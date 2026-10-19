/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { crc32 } from './crc32.js';

/**
 * The .btl container, read.
 *
 * Nothing here knows where bytes come from. It is handed a range fetcher for
 * the two things that have to be read before anything else -- the header and
 * the index -- and after that it is arithmetic: which blocks cover a range of a
 * file, where those blocks sit in the container, and how long each one is once
 * decoded. That is what lets the same reader sit over a file, a cache or a
 * network without any of them appearing in it.
 *
 * Layout, from the writer:
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
 *
 * Blocks are numbered across the whole container, not per file: a file records
 * where its run starts and how many blocks long it is.
 */

export const MAGIC = 'BTL1';
export const HEADER_SIZE = 0x28;
export const FORMAT_VERSION = 2;

/**
 * Versions this reader accepts. Version 2 added a checksum to each block's
 * index record; a version 1 bundle is still readable, and its blocks simply
 * arrive unchecked. Refusing them would have made a repack the price of an
 * engine update, which is not a price a container format should charge.
 */
export const READABLE_VERSIONS = Object.freeze([1, 2]);

/** What a block was written with. A reader must handle all three. */
export const Codec = {
    STORED: 0,
    DEFLATE_RAW: 1,
    ZSTD: 2,
};

/**
 * Reads `length` bytes at `offset` of the container.
 *
 * @typedef {(offset: number, length: number) => Promise<Uint8Array>} FetchRange
 */

/**
 * Turns stored bytes back into what was compressed.
 *
 * `expectedLength` is the decoded size when it is known, and `null` for the
 * index, whose uncompressed size the format does not record. A decoder that
 * wants an output hint has one everywhere it matters, since every block has it.
 *
 * @typedef {(codec: number, bytes: Uint8Array, expectedLength: number | null) => Uint8Array} Decode
 */

/**
 * The decoder `openBundle` is given: it is awaited, because the index may be
 * written with a codec that has no synchronous decoder here, so it may answer
 * a promise. The block decoder `createBundleSource` keeps is synchronous.
 *
 * @typedef {(codec: number, bytes: Uint8Array,
 *     expectedLength: number | null) => Uint8Array | Promise<Uint8Array>} IndexDecode
 */

/**
 * @typedef {Object} BundleFile
 * @property {string} path        Backslash-separated, relative to the root.
 * @property {number} size
 * @property {number} firstBlock  Where this file's run starts in the container.
 * @property {number} blocks
 * @property {string} sha256      Of the file's contents, as written.
 */

/**
 * @typedef {Object} BundleBlock
 * @property {number} index    Position in the container's block array.
 * @property {number} offset   Where its stored bytes start in the container.
 * @property {number} packed   How many stored bytes.
 * @property {number} codec
 * @property {number} length   How many bytes it decodes to.
 * @property {number | null} crc  CRC-32 of the stored bytes, or null in a
 *                                version 1 bundle, which recorded none.
 */

/**
 * One block, and the part of it a read wants.
 *
 * @typedef {Object} BlockRange
 * @property {BundleBlock} block
 * @property {number} from   First byte of the decoded block that is wanted.
 * @property {number} to     One past the last.
 */

/**
 * A run of blocks the index names beside the files: the translation seed a
 * bundle may carry, what the translator made of its code on one machine. Not
 * a file of the volume; a reader that does not know the entry never sees it.
 *
 * @typedef {Object} BundleMember
 * @property {number} size        Its bytes, decoded.
 * @property {number} firstBlock
 * @property {number} blocks
 * @property {string} sha256      Of its bytes, as written.
 */

/**
 * @typedef {Object} Bundle
 * @property {number} blockSize
 * @property {number} blockCount  How many blocks the container holds.
 * @property {string} fingerprint  The CRC-32 of the index as stored, in hex: another
 *     packing of the same name has another, so a block cache keyed by it is never
 *     read for the wrong one.
 * @property {readonly BundleFile[]} files
 * @property {readonly string[]} directories    Recorded empty ones only.
 * @property {BundleMember | null} translations  The translation seed, when there is one.
 * @property {Record<string, unknown> | null} manifest  The bottle's description written into
 *     the index (`withManifest`): its title, the program it starts, where it was installed.
 * @property {(path: string) => BundleFile | null} find   Case-insensitive.
 * @property {(index: number) => BundleBlock} block
 * @property {(file: BundleFile, offset: number, length: number) => BlockRange[]} rangesFor
 */

/**
 * Reads a container's header and index, and nothing else.
 *
 * @param {FetchRange} fetchRange
 * @param {IndexDecode} decode
 * @param {Object} [options]
 * @param {(stored: Uint8Array) => Promise<string | null>} [options.verifyIndex]
 *        Given the index exactly as stored, answers with what is wrong with it
 *        or null. The index carries every block's checksum, so it is the one
 *        part of the container that cannot vouch for itself.
 * @returns {Promise<Bundle>}
 */
export async function openBundle(fetchRange, decode, options = {}){
    const header = await fetchRange(0, HEADER_SIZE);
    if (header.length < HEADER_SIZE)
    {
        throw new Error(`A .btl header is ${HEADER_SIZE} bytes; got ${header.length}`);
    }
    if (String.fromCharCode(...header.subarray(0, MAGIC.length)) !== MAGIC)
    {
        throw new Error('This is not a .btl bundle');
    }

    const view = new DataView(header.buffer, header.byteOffset, HEADER_SIZE);
    const version = view.getUint32(4, true);
    if (!READABLE_VERSIONS.includes(version))
    {
        throw new Error(`This bundle is format version ${version}; this reader `
            + `knows ${READABLE_VERSIONS.join(' and ')}`);
    }

    const blockSize = view.getUint32(8, true);
    const indexOffset = Number(view.getBigUint64(0x10, true));
    const indexLength = Number(view.getBigUint64(0x18, true));
    const indexCodec = view.getUint32(0x20, true);

    const stored = await fetchRange(indexOffset, indexLength);
    const wrong = await options.verifyIndex?.(stored);
    if (wrong)
    {
        throw new Error(`This bundle's index is not the one expected: ${wrong}`);
    }
    // Awaited: opening is already asynchronous, and the index may be written
    // with a codec that has no synchronous decoder here. Only the blocks a guest
    // read touches must be decodable without waiting.
    const text = new TextDecoder().decode(await decode(indexCodec, stored, null));
    const index = JSON.parse(text);

    if (index.blockSize !== blockSize)
    {
        throw new Error(`This bundle's header and index disagree about the block size`);
    }

    /** @type {BundleFile[]} */
    const files = index.files;
    /** @type {BundleBlock[]} */
    const blocks = index.blocks.map((/** @type {any} */ block, /** @type {number} */ at)=>({
        index: at,
        offset: block.offset,
        packed: block.packed,
        codec: block.codec,
        crc: typeof block.crc === 'number' ? block.crc : null,
        length: blockSize,
    }));
    const member = index.translations;
    /** @type {BundleMember | null} */
    const translations = member && Number.isInteger(member.firstBlock)
        && Number.isInteger(member.blocks) && member.blocks > 0 && member.firstBlock >= 0
        && member.firstBlock + member.blocks <= blocks.length
        && Number.isInteger(member.size) && typeof member.sha256 === 'string'
        ? { size: member.size, firstBlock: member.firstBlock, blocks: member.blocks,
            sha256: member.sha256 }
        : null;

    // Only the file a block belongs to knows how long it decodes to, because the
    // last block of a file is as short as the file's remainder.
    for (const file of translations === null ? files : [...files, translations])
    {
        for (let at = 0; at < file.blocks; at++)
        {
            blocks[file.firstBlock + at].length =
                Math.min(blockSize, file.size - at * blockSize);
        }
    }

    const byPath = new Map(files.map(file=>[file.path.toLowerCase(), file]));

    return {
        blockSize,
        blockCount: blocks.length,
        // The index as stored names the blocks it lays out: a bundle packed
        // again under the same name has another, and a cache of the old one's
        // blocks must not answer for it.
        fingerprint: crc32(stored).toString(16).padStart(8, '0'),
        files,
        directories: index.directories,
        translations,
        manifest: index.manifest !== null && typeof index.manifest === 'object'
            && !Array.isArray(index.manifest) ? index.manifest : null,

        /** @param {string} path */
        find: path=>byPath.get(path.toLowerCase()) ?? null,

        /** @param {number} at */
        block: at=>blocks[at],

        /**
         * The blocks covering a range of a file, each with the part of it that
         * is wanted. A range beyond the end of the file covers nothing: end of
         * file is a length, not an error.
         *
         * @param {BundleFile} file
         * @param {number} offset
         * @param {number} length
         * @returns {BlockRange[]}
         */
        rangesFor(file, offset, length){
            const start = Math.min(Math.max(offset, 0), file.size);
            const end = Math.min(file.size, start + Math.max(length, 0));
            if (end <= start)
            {
                return [];
            }

            const first = Math.floor(start / blockSize);
            const last = Math.floor((end - 1) / blockSize);
            /** @type {BlockRange[]} */
            const ranges = [];
            for (let at = first; at <= last; at++)
            {
                const block = blocks[file.firstBlock + at];
                ranges.push({
                    block,
                    from: at === first ? start - first * blockSize : 0,
                    to: at === last ? end - at * blockSize : block.length,
                });
            }
            return ranges;
        },
    };
}

/**
 * The same bundle with a description written into its index -- what a bottle
 * carries when it leaves the place that knew its title, the program it starts
 * and where it was installed, so that wherever it is opened next it opens as
 * itself. The blocks are not touched: the answer is a new header, the span of
 * the container the blocks fill, and a new index stored as it is, for a caller
 * to lay one after another -- in a browser a Blob of the three, which copies
 * nothing of a container of any size until it is written out.
 *
 * @param {FetchRange} fetchRange  The container as it is.
 * @param {IndexDecode} decode
 * @param {Record<string, unknown> | null} manifest  null takes a description out.
 * @param {((index: any) => number) | null} [relay]  Lays the blocks out anew: rewrites the
 *     index as read and answers where the blocks it laid end -- a container put together
 *     from somewhere other than this one (`cachedBundle`).
 * @returns {Promise<{ header: Uint8Array, blocks: [number, number], index: Uint8Array }>}
 */
export async function withManifest(fetchRange, decode, manifest, relay = null){
    const header = (await fetchRange(0, HEADER_SIZE)).slice();
    if (header.length < HEADER_SIZE || String.fromCharCode(...header.subarray(0, MAGIC.length))
        !== MAGIC)
    {
        throw new Error('This is not a .btl bundle');
    }
    const view = new DataView(header.buffer, header.byteOffset, HEADER_SIZE);
    const version = view.getUint32(4, true);
    if (!READABLE_VERSIONS.includes(version))
    {
        throw new Error(`This bundle is format version ${version}; this reader `
            + `knows ${READABLE_VERSIONS.join(' and ')}`);
    }
    const indexOffset = Number(view.getBigUint64(0x10, true));
    const indexLength = Number(view.getBigUint64(0x18, true));
    const stored = await fetchRange(indexOffset, indexLength);
    const index = JSON.parse(new TextDecoder().decode(
        await decode(view.getUint32(0x20, true), stored, null)));
    const end = relay ? relay(index) : indexOffset;
    if (manifest === null)
    {
        delete index.manifest;
    }
    else
    {
        index.manifest = manifest;
    }
    const written = new TextEncoder().encode(JSON.stringify(index));
    view.setBigUint64(0x10, BigInt(end), true);
    view.setBigUint64(0x18, BigInt(written.length), true);
    view.setUint32(0x20, Codec.STORED, true);
    return { header, blocks: [HEADER_SIZE, end], index: written };
}
