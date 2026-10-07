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
 * @property {() => void} [release]  What the source holds, given back when done.
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
        // Only a directory that does not fit in what was read asks for more;
        // bytes that are not a cabinet at all are refused on their first four.
        if (head.length >= 4 && (head[0] !== 0x4d || head[1] !== 0x53 || head[2] !== 0x43
            || head[3] !== 0x46))
        {
            throw new CabinetError('no MSCF signature', 'format');
        }
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
 * @param {{ eager?: boolean }} [options]
 *        `eager`: every file of a folder is asked for before the folder is
 *        read, so a folder none is wanted from is not read at all; otherwise
 *        each is asked for as the output reaches it, which is the order an
 *        extractor that is told of a file when it is about to be written
 *        expects.
 * @returns {Promise<void>}
 */
export async function extractCabinet(source, sink, { eager = false } = {}){
    const cabinet = await readCabinetHead(source);
    for (const folder of cabinet.folders)
    {
        const wanted = cabinet.files.filter(file=>folderOf(cabinet, file) === folder)
            .sort((left, right)=>left.offset - right.offset);
        if (wanted.length === 0)
        {
            continue;
        }
        const decode = createFolderDecoder(folder.compression);
        // The files are asked for as the folder's output reaches them, one
        // after another, as an extractor that opens a file when it is told of
        // it and closes it when it has all of it expects them to be.
        let next = 0;
        /** @type {{ file: import('./cabinet.js').CabinetFile, out: FileSink }[]} */
        const open = [];
        /** @param {number} produced */
        const reach = async produced=>{
            while (next < wanted.length && wanted[next].offset <= produced)
            {
                const file = wanted[next++];
                const out = await sink(file);
                if (out)
                {
                    open.push({ file, out });
                }
            }
        };
        /** @param {number} produced */
        const finish = async produced=>{
            for (let index = 0; index < open.length;)
            {
                const { file, out } = open[index];
                if (file.offset + file.size <= produced)
                {
                    open.splice(index, 1);
                    await out.close();
                }
                else
                {
                    index++;
                }
            }
        };
        await reach(eager ? Infinity : 0);
        if (eager && open.length === 0)
        {
            continue;
        }
        const end = eager ? Math.max(...open.map(({ file })=>file.offset + file.size))
            : Math.max(...wanted.map(file=>file.offset + file.size));
        await finish(0);

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
            // The block's bytes in pieces, cut where a file ends or the next
            // begins, so each file is opened, filled and closed before the one
            // after it is opened.
            const blockEnd = produced + out.length;
            let position = produced;
            await reach(position);
            while (position < blockEnd)
            {
                let boundary = blockEnd;
                for (const { file } of open)
                {
                    boundary = Math.min(boundary, file.offset + file.size);
                }
                if (next < wanted.length && wanted[next].offset > position)
                {
                    boundary = Math.min(boundary, wanted[next].offset);
                }
                for (const { file, out: target } of open)
                {
                    const from = Math.max(file.offset, position);
                    const to = Math.min(file.offset + file.size, boundary);
                    if (from < to)
                    {
                        await target.write(from - file.offset,
                            out.subarray(from - produced, to - produced));
                    }
                }
                position = boundary;
                await finish(position);
                await reach(position);
                await finish(position);
            }
            produced = blockEnd;
            at += 8 + cabinet.dataReserve + packed;
        }
        if (produced < end)
        {
            throw new CabinetError('the folder ends before its files do', 'corrupt');
        }
    }
}
