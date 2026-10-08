/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A compound file written a piece at a time, in file order.
 *
 * What an installer database is written for is mostly the cabinet it carries:
 * a package committed after an edit, or cached once installed, can be
 * hundreds of megabytes, nearly all of it one stream that is already in a
 * file somewhere. So a stream here is not bytes but a source read when its
 * turn comes, a chunk at a time, and the file goes out through a sink that is
 * told where each piece lands. Every offset and chain is worked out before
 * the first byte is written -- the layout of a version 3 file depends only on
 * the sizes -- so the header, the FAT, the directory and the mini stream go
 * out as one piece at the start and each large stream follows in its own
 * consecutive sectors, and nothing is ever copied twice.
 *
 * The layout is the one `../ole32/cfb.js` writes in memory: FAT, DIFAT,
 * directory, mini FAT, mini stream, then the large streams, each a run.
 */

import { compareNames, nameKey } from '../ole32/cfb.js';
import { GUID_SIZE, parseGuid } from '../ole32/guid.js';
import { bytesSource } from './compound.js';

const SIGNATURE = Object.freeze([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const SECTOR_SIZE = 512;
const HEADER_SIZE = 512;
const DIRECTORY_ENTRY_SIZE = 128;
const MINI_SECTOR_SIZE = 64;
const MINI_STREAM_CUTOFF = 4096;
const HEADER_DIFAT_ENTRIES = 109;
const WORDS_PER_SECTOR = SECTOR_SIZE / 4;
const ENTRIES_PER_DIRECTORY_SECTOR = SECTOR_SIZE / DIRECTORY_ENTRY_SIZE;

const MAXREGSECT = 0xfffffffa;
const DIFSECT = 0xfffffffc;
const FATSECT = 0xfffffffd;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const NOSTREAM = 0xffffffff;

const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;
const COLOR_BLACK = 1;

const MAX_NAME_LENGTH = 31;
/** A version 3 file says a stream's size in 32 bits, and the format caps it at 2 GiB. */
const MAX_STREAM_SIZE = 0x80000000;
/** How much of a large stream is asked of its source at once. */
export const COPY_CHUNK = 1 << 20;

/**
 * @typedef {import('./compound.js').ByteSource} ByteSource
 *
 * @typedef {Object} WriteStream
 * @property {'stream'} kind
 * @property {string} name
 * @property {ByteSource} source  Its size, and its bytes when they are written.
 *
 * @typedef {Object} WriteStorage
 * @property {'storage'} kind
 * @property {string} name  The root's is written as "Root Entry" whatever it says.
 * @property {string} [clsid]  As a GUID string; none is GUID_NULL.
 * @property {WriteNode[]} children
 *
 * @typedef {WriteStream | WriteStorage} WriteNode
 *
 * Where the file goes: each piece once, at its offset, in increasing order.
 * A write may finish later; the next one waits for it.
 *
 * @typedef {Object} CompoundSink
 * @property {(offset: number, bytes: Uint8Array) => unknown} write
 */

/** A compound file that cannot be written as asked. */
export class CompoundWriteError extends Error {}

/**
 * A stream of bytes already in memory.
 *
 * @param {string} name @param {Uint8Array} bytes @returns {WriteStream}
 */
export const streamOf = (name, bytes)=>({ kind: 'stream', name, source: bytesSource(bytes) });

/**
 * @param {string} name @param {WriteNode[]} children @param {string} [clsid]
 * @returns {WriteStorage}
 */
export const storageOf = (name, children, clsid)=>({ kind: 'storage', name, children, clsid });

/**
 * The file a tree makes: its size, and the writing of it.
 *
 * @param {WriteStorage} root
 * @returns {{ size: number, writeTo: (sink: CompoundSink) => Promise<void> }}
 * @throws {CompoundWriteError} for a name too long or given twice in a storage,
 *         or a stream too large for the format
 */
export function planCompound(root){
    /**
     * The directory, flattened depth-first so that a storage's children sit
     * after it. Index 0 is the root, as the format requires.
     *
     * @type {{ node: WriteNode, left: number, right: number, child: number,
     *          start: number, size: number }[]}
     */
    const slots = [];
    /** @param {WriteNode} node */
    const place = node=>{
        const index = slots.length;
        const size = node.kind === 'stream' ? node.source.size : 0;
        if (size > MAX_STREAM_SIZE)
        {
            throw new CompoundWriteError(`${node.name}: ${size} bytes is too large a stream`);
        }
        slots.push({ node, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, start: ENDOFCHAIN,
            size });
        if (node.kind !== 'storage' || node.children.length === 0)
        {
            return index;
        }
        const seen = new Set();
        for (const child of node.children)
        {
            if (child.name.length === 0 || child.name.length > MAX_NAME_LENGTH)
            {
                throw new CompoundWriteError(`"${child.name}" cannot be a directory name`);
            }
            if (seen.has(nameKey(child.name)))
            {
                throw new CompoundWriteError(`${child.name} is in ${node.name} twice`);
            }
            seen.add(nameKey(child.name));
        }
        const sorted = [...node.children].sort((left, right)=>compareNames(left.name, right.name))
            .map(place);
        // Siblings as a tree halved from their sorted list, so a lookup that
        // walks it by comparison finds any of them in log n steps. Every node
        // is black: [MS-CFB] 2.6.4 allows that, and a reader that checks the
        // colours checks them against that rule.
        /** @param {number} low @param {number} high @returns {number} */
        const tree = (low, high)=>{
            if (low > high)
            {
                return NOSTREAM;
            }
            const middle = (low + high) >> 1;
            const slot = slots[sorted[middle]];
            slot.left = tree(low, middle - 1);
            slot.right = tree(middle + 1, high);
            return sorted[middle];
        };
        slots[index].child = tree(0, sorted.length - 1);
        return index;
    };
    place(root);

    /** @param {number} bytes @param {number} unit */
    const sectorsFor = (bytes, unit)=>Math.ceil(bytes / unit);

    // The short streams are packed into the mini stream, the rest each get a
    // run of sectors; an empty one gets neither.
    /** @type {number[]} */
    const mini = [];
    /** @type {number[]} */
    const large = [];
    slots.forEach((slot, index)=>{
        if (index > 0 && slot.node.kind === 'stream' && slot.size > 0)
        {
            (slot.size < MINI_STREAM_CUTOFF ? mini : large).push(index);
        }
    });
    const miniSectorTotal = mini.reduce(
        (sum, index)=>sum + sectorsFor(slots[index].size, MINI_SECTOR_SIZE), 0);
    const miniStreamBytes = miniSectorTotal * MINI_SECTOR_SIZE;
    const directorySectors = sectorsFor(slots.length, ENTRIES_PER_DIRECTORY_SECTOR);
    const miniFatSectors = sectorsFor(miniSectorTotal, WORDS_PER_SECTOR);
    const miniStreamSectors = sectorsFor(miniStreamBytes, SECTOR_SIZE);
    const largeSectors = large.reduce(
        (sum, index)=>sum + sectorsFor(slots[index].size, SECTOR_SIZE), 0);
    const fixedSectors = directorySectors + miniFatSectors + miniStreamSectors + largeSectors;

    // The FAT covers its own sectors and the DIFAT's, so its size is found by
    // growing both until they cover themselves.
    let fatSectors = 1;
    let difatSectors = 0;
    for (;;)
    {
        const total = fatSectors + difatSectors + fixedSectors;
        const neededFat = Math.max(1, sectorsFor(total, WORDS_PER_SECTOR));
        const neededDifat = neededFat <= HEADER_DIFAT_ENTRIES ? 0
            : sectorsFor(neededFat - HEADER_DIFAT_ENTRIES, WORDS_PER_SECTOR - 1);
        if (neededFat === fatSectors && neededDifat === difatSectors)
        {
            break;
        }
        fatSectors = neededFat;
        difatSectors = neededDifat;
    }
    const sectorTotal = fatSectors + difatSectors + fixedSectors;
    if (sectorTotal > MAXREGSECT)
    {
        throw new CompoundWriteError('too large for 512-byte sectors');
    }

    let next = 0;
    /** @param {number} count */
    const take = count=>{
        const first = next;
        next += count;
        return first;
    };
    const fatFirst = take(fatSectors);
    const difatFirst = take(difatSectors);
    const directoryFirst = take(directorySectors);
    const miniFatFirst = take(miniFatSectors);
    const miniStreamFirst = take(miniStreamSectors);
    const largeFirst = take(largeSectors);

    const fat = new Uint32Array(fatSectors * WORDS_PER_SECTOR).fill(FREESECT);
    /** @param {number} first @param {number} count @returns {number} its start */
    const chain = (first, count)=>{
        for (let index = 0; index < count; index++)
        {
            fat[first + index] = index + 1 < count ? first + index + 1 : ENDOFCHAIN;
        }
        return count === 0 ? ENDOFCHAIN : first;
    };
    fat.fill(FATSECT, fatFirst, fatFirst + fatSectors);
    fat.fill(DIFSECT, difatFirst, difatFirst + difatSectors);
    chain(directoryFirst, directorySectors);
    const miniFatStart = chain(miniFatFirst, miniFatSectors);
    slots[0].start = chain(miniStreamFirst, miniStreamSectors);
    slots[0].size = miniStreamBytes;
    let largeAt = largeFirst;
    for (const index of large)
    {
        const count = sectorsFor(slots[index].size, SECTOR_SIZE);
        slots[index].start = chain(largeAt, count);
        largeAt += count;
    }
    const miniFat = new Uint32Array(miniFatSectors * WORDS_PER_SECTOR).fill(FREESECT);
    let miniAt = 0;
    for (const index of mini)
    {
        const count = sectorsFor(slots[index].size, MINI_SECTOR_SIZE);
        for (let sector = 0; sector < count; sector++)
        {
            miniFat[miniAt + sector] = sector + 1 < count ? miniAt + sector + 1 : ENDOFCHAIN;
        }
        slots[index].start = miniAt;
        miniAt += count;
    }

    /** @param {number} sector */
    const offsetOf = sector=>HEADER_SIZE + sector * SECTOR_SIZE;
    const size = offsetOf(sectorTotal);

    /**
     * Everything before the large streams: header, FAT, DIFAT, directory,
     * mini FAT and the mini stream, whose bytes are read from their sources
     * here because they are short.
     */
    const head = async()=>{
        const out = new Uint8Array(offsetOf(largeFirst));
        const view = new DataView(out.buffer);
        /** @param {number} at @param {Uint32Array} words */
        const putWords = (at, words)=>{
            for (let index = 0; index < words.length; index++)
            {
                view.setUint32(at + index * 4, words[index], true);
            }
        };
        out.set(SIGNATURE, 0);
        view.setUint16(0x18, 0x003e, true);
        view.setUint16(0x1a, 3, true);
        view.setUint16(0x1c, 0xfffe, true);
        view.setUint16(0x1e, 9, true);
        view.setUint16(0x20, 6, true);
        view.setUint32(0x2c, fatSectors, true);
        view.setUint32(0x30, directoryFirst, true);
        view.setUint32(0x38, MINI_STREAM_CUTOFF, true);
        view.setUint32(0x3c, miniFatStart, true);
        view.setUint32(0x40, miniFatSectors, true);
        view.setUint32(0x44, difatSectors === 0 ? ENDOFCHAIN : difatFirst, true);
        view.setUint32(0x48, difatSectors, true);
        for (let index = 0; index < HEADER_DIFAT_ENTRIES; index++)
        {
            view.setUint32(0x4c + index * 4, index < fatSectors ? fatFirst + index : FREESECT,
                true);
        }

        putWords(offsetOf(fatFirst), fat);
        // The FAT sector numbers past the header's 109, chained through DIFAT
        // sectors whose last word names the next.
        const perDifatSector = WORDS_PER_SECTOR - 1;
        for (let index = 0; index < difatSectors; index++)
        {
            const at = offsetOf(difatFirst + index);
            for (let slot = 0; slot < perDifatSector; slot++)
            {
                const fatIndex = HEADER_DIFAT_ENTRIES + index * perDifatSector + slot;
                view.setUint32(at + slot * 4,
                    fatIndex < fatSectors ? fatFirst + fatIndex : FREESECT, true);
            }
            view.setUint32(at + perDifatSector * 4,
                index + 1 < difatSectors ? difatFirst + index + 1 : ENDOFCHAIN, true);
        }

        for (let index = 0; index < directorySectors * ENTRIES_PER_DIRECTORY_SECTOR; index++)
        {
            const at = offsetOf(directoryFirst) + index * DIRECTORY_ENTRY_SIZE;
            const slot = slots[index];
            if (!slot)
            {
                // Unused, apart from links that say "none" rather than entry 0.
                view.setUint32(at + 0x44, NOSTREAM, true);
                view.setUint32(at + 0x48, NOSTREAM, true);
                view.setUint32(at + 0x4c, NOSTREAM, true);
                continue;
            }
            const { node } = slot;
            const name = index === 0 ? 'Root Entry' : node.name;
            for (let unit = 0; unit < name.length; unit++)
            {
                view.setUint16(at + unit * 2, name.charCodeAt(unit), true);
            }
            view.setUint16(at + 0x40, (name.length + 1) * 2, true);
            view.setUint8(at + 0x42, index === 0 ? TYPE_ROOT
                : node.kind === 'stream' ? TYPE_STREAM : TYPE_STORAGE);
            view.setUint8(at + 0x43, COLOR_BLACK);
            view.setUint32(at + 0x44, slot.left, true);
            view.setUint32(at + 0x48, slot.right, true);
            view.setUint32(at + 0x4c, slot.child, true);
            if (node.kind === 'storage' && node.clsid)
            {
                const clsid = parseGuid(node.clsid);
                if (!clsid)
                {
                    throw new CompoundWriteError(`${node.clsid} is not a class`);
                }
                out.set(clsid.subarray(0, GUID_SIZE), at + 0x50);
            }
            view.setUint32(at + 0x74, slot.start, true);
            view.setUint32(at + 0x78, slot.size, true);
        }

        putWords(offsetOf(miniFatFirst), miniFat);
        for (const index of mini)
        {
            const slot = slots[index];
            const bytes = await readExactly(slot.node, 0, slot.size);
            out.set(bytes, offsetOf(miniStreamFirst) + slot.start * MINI_SECTOR_SIZE);
        }
        return out;
    };

    return {
        size,
        writeTo: async sink=>{
            await sink.write(0, await head());
            for (const index of large)
            {
                const slot = slots[index];
                const base = offsetOf(slot.start);
                for (let at = 0; at < slot.size; at += COPY_CHUNK)
                {
                    const length = Math.min(COPY_CHUNK, slot.size - at);
                    await sink.write(base + at, await readExactly(slot.node, at, length));
                }
                // The last sector is whole in the file even where the stream is not.
                const tail = slot.size % SECTOR_SIZE;
                if (tail !== 0)
                {
                    await sink.write(base + slot.size, new Uint8Array(SECTOR_SIZE - tail));
                }
            }
        },
    };
}

/**
 * A range of a stream, refused when its source gives fewer bytes than it said
 * it had: a short read would otherwise shift every sector after it.
 *
 * @param {WriteNode} node @param {number} offset @param {number} length
 */
async function readExactly(node, offset, length){
    const bytes = node.kind === 'stream' ? await node.source.read(offset, length) : null;
    if (!bytes || bytes.length < length)
    {
        throw new CompoundWriteError(`${node.name}: shorter than its size`);
    }
    return bytes.length === length ? bytes : bytes.subarray(0, length);
}

/**
 * Writes a tree as a compound file through a sink.
 *
 * @param {WriteStorage} root @param {CompoundSink} sink
 * @returns {Promise<number>} the file's size
 */
export async function writeCompound(root, sink){
    const plan = planCompound(root);
    await plan.writeTo(sink);
    return plan.size;
}

/**
 * A tree as a compound file in memory, allocated once at its final size.
 *
 * @param {WriteStorage} root @returns {Promise<Uint8Array>}
 */
export async function compoundBytes(root){
    const plan = planCompound(root);
    const out = new Uint8Array(plan.size);
    await plan.writeTo({ write: (offset, bytes)=>out.set(bytes, offset) });
    return out;
}
