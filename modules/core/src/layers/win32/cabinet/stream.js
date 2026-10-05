/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A cabinet extracted as it is read, for one too large to hold.
 *
 * An installer package carries its files as one cabinet, hundreds of
 * megabytes, often a single folder: decoding the folder whole would hold all
 * of it before the first file is written. So the directory is read from the
 * cabinet's head, and each folder is then walked a data block at a time, its
 * output cut into the files it holds as it arrives -- at most one block's
 * bytes and the reads in flight are held at once. The blocks are read in
 * batches, because a source answers a large read far sooner than many small
 * ones.
 */

import {
    CabinetError, createFolderDecoder, decodeBlock, folderOf, readCabinet,
} from './cabinet.js';

/**
 * @typedef {Object} ByteSource
 * @property {number} size
 * @property {(offset: number, length: number) => Uint8Array | Promise<Uint8Array>} read
 */

/**
 * Where an extracted file's bytes go; null from `sink` skips the file.
 *
 * @typedef {Object} FileSink
 * @property {(offset: number, bytes: Uint8Array) => void | Promise<void>} write
 * @property {() => void | Promise<void>} close
 */

/** How much of a cabinet's head is read first for its directory, and the batch size after. */
const HEAD = 64 * 1024;
const BATCH = 1024 * 1024;

/**
 * Reads a cabinet's directory from the start of a source, reading more of
 * it until the file table fits.
 *
 * @param {ByteSource} source
 */
export async function readCabinetHead(source){
    let length = Math.min(source.size, HEAD);
    for (;;)
    {
        const head = await source.read(0, length);
        try
        {
            return readCabinet(head);
        }
        catch (e){
            if (!(e instanceof CabinetError) || e.kind !== 'format' || length >= source.size)
            {
                throw e;
            }
            length = Math.min(source.size, length * 4);
        }
    }
}

/**
 * Extracts every file a sink is given for, folder by folder.
 *
 * @param {ByteSource} source
 * @param {(file: import('./cabinet.js').CabinetFile)
 *     => FileSink | null | Promise<FileSink | null>} sink
 * @returns {Promise<void>}
 */
export async function extractCabinet(source, sink){
    const cabinet = await readCabinetHead(source);
    for (const folder of cabinet.folders)
    {
        const wanted = cabinet.files.filter(file=>folderOf(cabinet, file) === folder);
        /** @type {{ file: import('./cabinet.js').CabinetFile, out: FileSink }[]} */
        const open = [];
        for (const file of wanted)
        {
            const out = await sink(file);
            if (out)
            {
                open.push({ file, out });
            }
        }
        if (open.length === 0)
        {
            continue;
        }
        open.sort((left, right)=>left.file.offset - right.file.offset);
        const decode = createFolderDecoder(folder.compression);
        const end = Math.max(...open.map(({ file })=>file.offset + file.size));

        /** @type {Uint8Array} */
        let buffer = new Uint8Array(0);
        let bufferAt = folder.dataOffset;
        /** @param {number} offset @param {number} length */
        const take = async(offset, length)=>{
            if (offset < bufferAt || offset + length > bufferAt + buffer.length)
            {
                bufferAt = offset;
                buffer = await source.read(offset, Math.max(length,
                    Math.min(BATCH, source.size - offset)));
                if (buffer.length < length)
                {
                    throw new CabinetError('a data block runs off the end', 'corrupt');
                }
            }
            return buffer.subarray(offset - bufferAt, offset - bufferAt + length);
        };

        let at = folder.dataOffset;
        let produced = 0;
        for (let block = 0; block < folder.blocks && produced < end; block++)
        {
            const header = await take(at, 8 + cabinet.dataReserve);
            const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
            const checksum = view.getUint32(0, true);
            const packed = view.getUint16(4, true);
            const size = view.getUint16(6, true);
            const headerCopy = header.slice(4);
            const data = await take(at + 8 + cabinet.dataReserve, packed);
            const out = decodeBlock(decode, headerCopy, data, checksum, size, block);
            for (const { file, out: target } of open)
            {
                const from = Math.max(file.offset, produced);
                const to = Math.min(file.offset + file.size, produced + out.length);
                if (from < to)
                {
                    await target.write(from - file.offset,
                        out.subarray(from - produced, to - produced));
                }
            }
            produced += out.length;
            at += 8 + cabinet.dataReserve + packed;
        }
        if (produced < end)
        {
            throw new CabinetError('the folder ends before its files do', 'corrupt');
        }
        for (const { out } of open)
        {
            await out.close();
        }
    }
}
