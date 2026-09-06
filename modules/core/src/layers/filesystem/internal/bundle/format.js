/*
 * Copyright © 2026 Bottlify Project
 * Licensed under BSD-2-Clause License
 * See LICENSE for details
 */

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
export const FORMAT_VERSION = 1;

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
 * @typedef {Object} Bundle
 * @property {number} blockSize
 * @property {number} blockCount  How many blocks the container holds.
 * @property {readonly BundleFile[]} files
 * @property {readonly string[]} directories    Recorded empty ones only.
 * @property {(path: string) => BundleFile | null} find   Case-insensitive.
 * @property {(index: number) => BundleBlock} block
 * @property {(file: BundleFile, offset: number, length: number) => BlockRange[]} rangesFor
 */

/**
 * Reads a container's header and index, and nothing else.
 *
 * @param {FetchRange} fetchRange
 * @param {Decode} decode
 * @returns {Promise<Bundle>}
 */
export async function openBundle(fetchRange, decode){
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
    if (version !== FORMAT_VERSION)
    {
        throw new Error(`This bundle is format version ${version}, not ${FORMAT_VERSION}`);
    }

    const blockSize = view.getUint32(8, true);
    const indexOffset = Number(view.getBigUint64(0x10, true));
    const indexLength = Number(view.getBigUint64(0x18, true));
    const indexCodec = view.getUint32(0x20, true);

    const stored = await fetchRange(indexOffset, indexLength);
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
        length: blockSize,
    }));
    // Only the file a block belongs to knows how long it decodes to, because the
    // last block of a file is as short as the file's remainder.
    for (const file of files)
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
        files,
        directories: index.directories,

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
