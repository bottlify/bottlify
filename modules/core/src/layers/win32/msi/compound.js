/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A compound file read where it lies, a sector at a time.
 *
 * An installer database is a compound file, and the one a game ships is
 * mostly the cabinet it carries as a stream: hundreds of megabytes, of which
 * a setup reads the tables first and the files one at a time, long after.
 * Reading it whole the way ole32's docfile parser does would hold all of it in
 * memory before the first table is looked at. So only the header, the FAT, the
 * directory and the mini stream's tables are read when the file is opened,
 * and a stream's bytes are read when they are asked for, the sector runs the
 * FAT names coalesced into as few reads as the file allows.
 *
 * The format is the one `../ole32/cfb.js` reads and writes; its tests build
 * files with that writer and read them back here.
 */

import { compareNames, nameKey } from '../ole32/cfb.js';
import { formatGuid } from '../ole32/guid.js';

const SIGNATURE = Object.freeze([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const HEADER_SIZE = 512;
const DIRECTORY_ENTRY_SIZE = 128;
const MINI_SECTOR_SIZE = 64;
const HEADER_DIFAT_ENTRIES = 109;

const MAXREGSECT = 0xfffffffa;
const ENDOFCHAIN = 0xfffffffe;
const NOSTREAM = 0xffffffff;

const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;

/**
 * Where the file's bytes come from: its size, and a read of any range of it,
 * answered at once or later.
 *
 * @typedef {Object} ByteSource
 * @property {number} size
 * @property {(offset: number, length: number) => Uint8Array | Promise<Uint8Array>} read
 */

/**
 * One storage or stream, as the directory names it.
 *
 * @typedef {Object} CompoundNode
 * @property {string} name
 * @property {'storage' | 'stream'} kind
 * @property {number} size     A stream's length in bytes.
 * @property {number} start    Its first sector, or mini sector.
 * @property {Map<string, CompoundNode>} children  By `nameKey`; empty for a stream.
 * @property {string} [clsid]  A storage's class, as a GUID string: what says a
 *           storage is a transform rather than any other docfile.
 */

/**
 * @typedef {Object} CompoundFile
 * @property {CompoundNode} root
 * @property {(node: CompoundNode, offset: number, length: number) => Promise<Uint8Array>} read
 *           Bytes of a stream; a range past its end is cut short.
 * @property {(node: CompoundNode) => Promise<Uint8Array>} readAll
 */

/** Thrown for bytes that are not a compound file this reader can trust. */
export class CompoundError extends Error {}

/**
 * Runs of consecutive sectors in a chain, as [first, count]: what turns a
 * stream of a hundred thousand sectors into a handful of reads.
 *
 * @param {number[]} chain @returns {[number, number][]}
 */
const runsOf = chain=>{
    /** @type {[number, number][]} */
    const runs = [];
    for (const sector of chain)
    {
        const last = runs[runs.length - 1];
        if (last && last[0] + last[1] === sector)
        {
            last[1]++;
        }
        else
        {
            runs.push([sector, 1]);
        }
    }
    return runs;
};

/** @param {Uint8Array} bytes @param {number} at */
const u32 = (bytes, at)=>(bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16
    | bytes[at + 3] << 24) >>> 0;
/** @param {Uint8Array} bytes @param {number} at */
const u16 = (bytes, at)=>bytes[at] | bytes[at + 1] << 8;

/**
 * Opens a compound file over a byte source.
 *
 * @param {ByteSource} source
 * @returns {Promise<CompoundFile>}
 * @throws {CompoundError} when the bytes are not one, or are damaged
 */
export async function openCompound(source){
    if (source.size < HEADER_SIZE)
    {
        throw new CompoundError('shorter than a header');
    }
    const header = await source.read(0, HEADER_SIZE);
    if (!SIGNATURE.every((byte, index)=>header[index] === byte))
    {
        throw new CompoundError('not a compound file');
    }
    const sectorShift = u16(header, 0x1e);
    if ((sectorShift !== 9 && sectorShift !== 12) || u16(header, 0x20) !== 6)
    {
        throw new CompoundError('unknown sector sizes');
    }
    const sectorSize = 1 << sectorShift;
    // A version 4 file pads its header to a whole sector; sector 0 follows.
    const sectorBase = sectorSize;
    const sectorCount = Math.floor((source.size - sectorBase) / sectorSize);
    const wordsPerSector = sectorSize / 4;

    /**
     * The bytes of a chain's runs, concatenated, up to `size`.
     *
     * @param {[number, number][]} runs @param {number} size
     */
    const readRuns = async(runs, size)=>{
        const out = new Uint8Array(size);
        let at = 0;
        for (const [first, count] of runs)
        {
            if (at >= size)
            {
                break;
            }
            const take = Math.min(count * sectorSize, size - at);
            out.set(await source.read(sectorBase + first * sectorSize, take), at);
            at += take;
        }
        return out;
    };

    /** @param {number[]} sectors @returns {Promise<Uint32Array>} */
    const wordsOf = async sectors=>{
        const bytes = await readRuns(runsOf(sectors), sectors.length * sectorSize);
        const words = new Uint32Array(sectors.length * wordsPerSector);
        for (let index = 0; index < words.length; index++)
        {
            words[index] = u32(bytes, index * 4);
        }
        return words;
    };

    /** @param {number} sector */
    const valid = sector=>sector <= MAXREGSECT && sector < sectorCount;

    // The DIFAT: the header's 109 FAT sector numbers, then a chain of
    // sectors whose last word names the next.
    const fatSectorCount = u32(header, 0x2c);
    /** @type {number[]} */
    const fatSectors = [];
    for (let index = 0; index < HEADER_DIFAT_ENTRIES && fatSectors.length < fatSectorCount;
        index++)
    {
        fatSectors.push(u32(header, 0x4c + index * 4));
    }
    let difat = u32(header, 0x44);
    for (let seen = 0; seen < u32(header, 0x48) && fatSectors.length < fatSectorCount; seen++)
    {
        if (!valid(difat))
        {
            throw new CompoundError('a DIFAT sector past the end');
        }
        const words = await wordsOf([difat]);
        for (let index = 0; index < wordsPerSector - 1 && fatSectors.length < fatSectorCount;
            index++)
        {
            fatSectors.push(words[index]);
        }
        difat = words[wordsPerSector - 1];
    }
    if (fatSectors.length !== fatSectorCount || !fatSectors.every(valid))
    {
        throw new CompoundError('the FAT is not where the header says');
    }
    const fat = await wordsOf(fatSectors);

    /**
     * Every sector of a chain, in order.
     *
     * @param {Uint32Array} table @param {number} first @param {number} limit
     */
    const chainOf = (table, first, limit)=>{
        /** @type {number[]} */
        const chain = [];
        let sector = first;
        while (sector !== ENDOFCHAIN)
        {
            // A chain cannot be longer than the table: one that is has looped.
            if (sector > MAXREGSECT || sector >= limit || sector >= table.length
                || chain.length >= table.length)
            {
                throw new CompoundError('a broken sector chain');
            }
            chain.push(sector);
            sector = table[sector];
        }
        return chain;
    };

    const directoryChain = chainOf(fat, u32(header, 0x30), sectorCount);
    const directory = await readRuns(runsOf(directoryChain), directoryChain.length * sectorSize);
    const entryCount = directory.length / DIRECTORY_ENTRY_SIZE;

    /** @param {number} index */
    const entryAt = index=>{
        const at = index * DIRECTORY_ENTRY_SIZE;
        const nameBytes = u16(directory, at + 0x40);
        const units = nameBytes >= 2 && nameBytes <= 64 && nameBytes % 2 === 0
            ? nameBytes / 2 - 1 : 0;
        let name = '';
        for (let unit = 0; unit < units; unit++)
        {
            const code = u16(directory, at + unit * 2);
            if (code === 0)
            {
                break;
            }
            name += String.fromCharCode(code);
        }
        const high = sectorShift === 9 ? 0 : u32(directory, at + 0x7c);
        return {
            name,
            type: directory[at + 0x42],
            left: u32(directory, at + 0x44),
            right: u32(directory, at + 0x48),
            child: u32(directory, at + 0x4c),
            start: u32(directory, at + 0x74),
            size: u32(directory, at + 0x78) + high * 0x1_0000_0000,
            clsid: formatGuid(directory.subarray(at + 0x50, at + 0x60)),
        };
    };

    const rootEntry = entryAt(0);
    if (entryCount === 0 || rootEntry.type !== TYPE_ROOT)
    {
        throw new CompoundError('no root entry');
    }

    /**
     * A storage's children: its red-black tree walked from the child it names,
     * each entry visited once however the links are drawn.
     *
     * @param {number} first @param {Set<number>} visited
     * @returns {Map<string, CompoundNode>}
     */
    const childrenOf = (first, visited)=>{
        /** @type {Map<string, CompoundNode>} */
        const children = new Map();
        const pending = [first];
        while (pending.length > 0)
        {
            const index = /** @type {number} */ (pending.pop());
            if (index === NOSTREAM)
            {
                continue;
            }
            if (index >= entryCount || visited.has(index))
            {
                throw new CompoundError('a directory link out of place');
            }
            visited.add(index);
            const entry = entryAt(index);
            pending.push(entry.left, entry.right);
            if (entry.type !== TYPE_STORAGE && entry.type !== TYPE_STREAM)
            {
                continue;
            }
            children.set(nameKey(entry.name), {
                name: entry.name,
                kind: entry.type === TYPE_STORAGE ? 'storage' : 'stream',
                size: entry.size,
                start: entry.start,
                clsid: entry.clsid,
                children: entry.type === TYPE_STORAGE
                    ? childrenOf(entry.child, visited) : new Map(),
            });
        }
        // In the order the directory compares names, which is the order an
        // enumeration on Windows hands them out.
        return new Map([...children.entries()]
            .sort(([, left], [, right])=>compareNames(left.name, right.name)));
    };

    /** @type {CompoundNode} */
    const root = {
        name: rootEntry.name, kind: 'storage', size: rootEntry.size, start: rootEntry.start,
        clsid: rootEntry.clsid, children: childrenOf(rootEntry.child, new Set([0])),
    };

    // The mini stream: the root's own chain, cut into 64-byte sectors that a
    // mini FAT chains. Small, so read once, and only if anything lives there.
    const cutoff = u32(header, 0x38);
    const miniFatChain = u32(header, 0x3c) <= MAXREGSECT
        ? chainOf(fat, u32(header, 0x3c), sectorCount) : [];
    const miniFat = miniFatChain.length > 0 ? await wordsOf(miniFatChain) : new Uint32Array(0);
    /** @type {Promise<Uint8Array> | null} */
    let miniStream = null;
    const miniStreamBytes = ()=>{
        miniStream ??= (async()=>{
            const chain = chainOf(fat, rootEntry.start, sectorCount);
            return readRuns(runsOf(chain), Math.min(rootEntry.size, chain.length * sectorSize));
        })();
        return miniStream;
    };

    /** @type {Map<CompoundNode, number[]>} */
    const chains = new Map();

    /** @type {CompoundFile['read']} */
    const read = async(node, offset, length)=>{
        const end = Math.min(node.size, offset + length);
        if (node.kind !== 'stream' || offset >= end)
        {
            return new Uint8Array(0);
        }
        if (node.size < cutoff)
        {
            let chain = chains.get(node);
            if (!chain)
            {
                chain = chainOf(miniFat, node.start, miniFat.length);
                chains.set(node, chain);
            }
            const mini = await miniStreamBytes();
            const out = new Uint8Array(end - offset);
            for (let at = offset; at < end;)
            {
                const sector = chain[Math.floor(at / MINI_SECTOR_SIZE)];
                const within = at % MINI_SECTOR_SIZE;
                const take = Math.min(MINI_SECTOR_SIZE - within, end - at);
                const from = sector * MINI_SECTOR_SIZE + within;
                if (sector === undefined || from + take > mini.length)
                {
                    throw new CompoundError('a mini stream chain past its end');
                }
                out.set(mini.subarray(from, from + take), at - offset);
                at += take;
            }
            return out;
        }
        let chain = chains.get(node);
        if (!chain)
        {
            chain = chainOf(fat, node.start, sectorCount);
            chains.set(node, chain);
        }
        if (chain.length * sectorSize < node.size)
        {
            throw new CompoundError('a stream shorter than its size');
        }
        const first = Math.floor(offset / sectorSize);
        const last = Math.floor((end - 1) / sectorSize);
        const bytes = await readRuns(runsOf(chain.slice(first, last + 1)),
            (last - first + 1) * sectorSize);
        const skip = offset - first * sectorSize;
        return bytes.subarray(skip, skip + end - offset);
    };

    return { root, read, readAll: node=>read(node, 0, node.size) };
}

/**
 * A byte source over bytes already in memory.
 *
 * @param {Uint8Array} bytes @returns {ByteSource}
 */
export const bytesSource = bytes=>({
    size: bytes.length,
    read: (offset, length)=>bytes.subarray(offset, offset + length),
});
