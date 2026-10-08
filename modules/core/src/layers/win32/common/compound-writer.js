/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The compound file writer: a tree of storages and streams laid out as a
 * version 3 docfile, for every caller that writes one -- ole32's structured
 * storage, an installer database, a transform.
 *
 * Every offset and chain is worked out from the sizes alone before a byte is
 * written, so the same layout goes out two ways. Written through a sink, a
 * stream is a source read when its turn comes, a chunk at a time: an
 * installer package committed or cached can be hundreds of megabytes, nearly
 * all of it one cabinet already in a file somewhere, and it is never held
 * whole. Written into memory, the file is one block allocated at its final
 * size and filled at once, for a caller that needs the bytes before it
 * returns (IStorage::Commit into an ILockBytes).
 *
 * The file is laid out as FAT, DIFAT, directory, mini FAT, mini stream, then
 * each large stream as one run of consecutive sectors: the header, the
 * tables, the directory and the mini stream are one piece at the start, and
 * nothing is copied twice.
 */

import { GUID_NULL, GUID_SIZE, parseGuid } from '../ole32/guid.js';

const SIGNATURE = Object.freeze([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const SECTOR_SIZE = 512;
const HEADER_SIZE = 512;
const DIRECTORY_ENTRY_SIZE = 128;
const MINI_SECTOR_SIZE = 64;
/** A stream shorter than this lives in the mini stream. */
const MINI_STREAM_CUTOFF = 4096;
/** How many FAT sector numbers the header holds before DIFAT sectors are needed. */
const HEADER_DIFAT_ENTRIES = 109;
const WORDS_PER_SECTOR = SECTOR_SIZE / 4;
const ENTRIES_PER_DIRECTORY_SECTOR = SECTOR_SIZE / DIRECTORY_ENTRY_SIZE;

/** Sector numbers with a meaning of their own. */
const MAXREGSECT = 0xfffffffa;
const DIFSECT = 0xfffffffc;
const FATSECT = 0xfffffffd;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
/** The directory's "no such entry". */
const NOSTREAM = 0xffffffff;

const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;
const COLOR_RED = 0;
const COLOR_BLACK = 1;

/** A name is at most 31 characters: 32 UTF-16 units with the terminator. */
export const MAX_NAME_LENGTH = 31;
/** A version 3 file says a stream's size in 32 bits, and the format caps it at 2 GiB. */
const MAX_STREAM_SIZE = 0x80000000;
/** How much of a large stream is asked of its source at once when writing through a sink. */
export const COPY_CHUNK = 1 << 20;

/**
 * Where a stream's bytes come from: its size, and a read of any range of it,
 * answered at once or later. Only a source that answers at once can be
 * written into memory synchronously.
 *
 * @typedef {Object} ByteSource
 * @property {number} size
 * @property {(offset: number, length: number) => Uint8Array | Promise<Uint8Array>} read
 *
 * What a directory entry carries besides its place in the tree; each is
 * written as zero when it is not given.
 *
 * @typedef {Object} EntryInfo
 * @property {string} [clsid]      As a GUID string.
 * @property {number} [stateBits]
 * @property {bigint} [created]    FILETIME.
 * @property {bigint} [modified]   FILETIME.
 *
 * @typedef {EntryInfo & { kind: 'stream', name: string, source: ByteSource }} WriteStream
 * @typedef {EntryInfo & { kind: 'storage', name: string, children: WriteNode[] }} WriteStorage
 *          The root's name is written as "Root Entry" whatever it says.
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
 * The form a name is compared under. The format says upper case, and for
 * anything past ASCII it says "as the implementation sees fit", so this is
 * the one every reader agrees on.
 *
 * @param {string} name
 */
export function nameKey(name){
    return name.toUpperCase();
}

/**
 * The order the directory keeps siblings in: shorter names first, then by
 * upper-cased code unit. It is not a lexical sort, and a reader that walks
 * the tree by comparison depends on the writer having used this one.
 *
 * @param {string} left @param {string} right
 */
export function compareNames(left, right){
    const a = nameKey(left);
    const b = nameKey(right);
    if (a.length !== b.length)
    {
        return a.length - b.length;
    }
    for (let index = 0; index < a.length; index++)
    {
        const difference = a.charCodeAt(index) - b.charCodeAt(index);
        if (difference !== 0)
        {
            return difference;
        }
    }
    return 0;
}

/**
 * Bytes already in memory as a source.
 *
 * @param {Uint8Array} bytes @returns {ByteSource}
 */
export const memorySource = bytes=>({
    size: bytes.length,
    read: (offset, length)=>bytes.subarray(offset, offset + length),
});

/**
 * A stream of bytes already in memory.
 *
 * @param {string} name @param {Uint8Array} bytes @param {EntryInfo} [info]
 * @returns {WriteStream}
 */
export const streamOf = (name, bytes, info = {})=>({
    ...info, kind: 'stream', name, source: memorySource(bytes),
});

/**
 * @param {string} name @param {WriteNode[]} children @param {string} [clsid]
 * @returns {WriteStorage}
 */
export const storageOf = (name, children, clsid)=>({ kind: 'storage', name, children, clsid });

/**
 * A range of a stream, refused when its source gives fewer bytes than it said
 * it had: a short read would otherwise shift every sector after it.
 *
 * @param {WriteNode} node @param {Uint8Array | null | undefined} bytes @param {number} length
 */
const exactly = (node, bytes, length)=>{
    if (!bytes || bytes.length < length)
    {
        throw new CompoundWriteError(`${node.name}: shorter than its size`);
    }
    return bytes.length === length ? bytes : bytes.subarray(0, length);
};

/** @param {WriteNode} node @param {number} offset @param {number} length */
const readLater = async(node, offset, length)=>exactly(node,
    node.kind === 'stream' ? await node.source.read(offset, length) : null, length);

/** @param {WriteNode} node @param {number} offset @param {number} length */
const readNow = (node, offset, length)=>{
    const bytes = node.kind === 'stream' ? node.source.read(offset, length) : null;
    if (bytes && !(bytes instanceof Uint8Array))
    {
        throw new CompoundWriteError(`${node.name}: its bytes come later; write it through a sink`);
    }
    return exactly(node, bytes, length);
};

/**
 * The directory's links for one storage's children, from their sorted list:
 * a tree halved from it, so that a lookup walking it by comparison finds any
 * of them in log n steps.
 *
 * A halved tree is height-balanced, and the colouring that makes it a
 * red-black tree is to paint its deepest level red and everything above it
 * black, so every path to a missing child passes the same number of black
 * nodes. Windows does not check the colours when it reads, but a reader that
 * does is entitled to.
 *
 * @param {number} count
 * @param {(item: number, left: number | null, right: number | null, black: boolean) => void} link
 *        Told each item's place by its index in the sorted list.
 * @returns {number | null} the index of the tree's root
 */
function buildTree(count, link){
    const height = count === 0 ? 0 : Math.floor(Math.log2(count));
    /** @param {number} low @param {number} high @param {number} depth @returns {number | null} */
    const build = (low, high, depth)=>{
        if (low > high)
        {
            return null;
        }
        const middle = (low + high) >> 1;
        const left = build(low, middle - 1, depth + 1);
        const right = build(middle + 1, high, depth + 1);
        // A lone node is the deepest level and the root at once, and the
        // root is black by definition.
        link(middle, left, right, depth < height || depth === 0);
        return middle;
    };
    return build(0, count - 1, 0);
}

/**
 * The file a tree makes: its size, and the writing of it, through a sink a
 * chunk at a time or into memory at once.
 *
 * @param {WriteStorage} root
 * @returns {{ size: number, writeTo: (sink: CompoundSink) => Promise<void>,
 *     bytes: () => Uint8Array }}
 * @throws {CompoundWriteError} for a name too long or given twice in a storage,
 *         or a stream too large for the format
 */
export function planCompound(root){
    /**
     * The directory, flattened depth-first so that a storage's children sit
     * after it. Index 0 is the root, as the format requires.
     *
     * @type {{ node: WriteNode, left: number, right: number, child: number, black: boolean,
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
        slots.push({ node, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, black: true,
            start: ENDOFCHAIN, size });
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
        const top = buildTree(sorted.length, (item, left, right, black)=>{
            const slot = slots[sorted[item]];
            slot.left = left === null ? NOSTREAM : sorted[left];
            slot.right = right === null ? NOSTREAM : sorted[right];
            slot.black = black;
        });
        slots[index].child = top === null ? NOSTREAM : sorted[top];
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
    const headSize = offsetOf(largeFirst);

    /**
     * Everything before the large streams -- header, FAT, DIFAT, directory,
     * mini FAT and the mini stream -- into the start of `out`, which is zero.
     *
     * @param {Uint8Array} out  At least `headSize` long.
     * @param {Uint8Array[]} miniBytes  Each short stream's bytes, in `mini`'s order.
     */
    const fillHead = (out, miniBytes)=>{
        const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
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
            view.setUint8(at + 0x43, slot.black ? COLOR_BLACK : COLOR_RED);
            view.setUint32(at + 0x44, slot.left, true);
            view.setUint32(at + 0x48, slot.right, true);
            view.setUint32(at + 0x4c, slot.child, true);
            if (node.clsid && node.clsid !== GUID_NULL)
            {
                const clsid = parseGuid(node.clsid);
                if (!clsid)
                {
                    throw new CompoundWriteError(`${node.clsid} is not a class`);
                }
                out.set(clsid.subarray(0, GUID_SIZE), at + 0x50);
            }
            view.setUint32(at + 0x60, node.stateBits ?? 0, true);
            view.setBigUint64(at + 0x64, node.created ?? 0n, true);
            view.setBigUint64(at + 0x6c, node.modified ?? 0n, true);
            view.setUint32(at + 0x74, slot.start, true);
            view.setUint32(at + 0x78, slot.size, true);
        }

        putWords(offsetOf(miniFatFirst), miniFat);
        mini.forEach((index, position)=>{
            out.set(miniBytes[position],
                offsetOf(miniStreamFirst) + slots[index].start * MINI_SECTOR_SIZE);
        });
    };

    return {
        size,
        writeTo: async sink=>{
            /** @type {Uint8Array[]} */
            const miniBytes = [];
            for (const index of mini)
            {
                miniBytes.push(await readLater(slots[index].node, 0, slots[index].size));
            }
            const head = new Uint8Array(headSize);
            fillHead(head, miniBytes);
            await sink.write(0, head);
            for (const index of large)
            {
                const slot = slots[index];
                const base = offsetOf(slot.start);
                for (let at = 0; at < slot.size; at += COPY_CHUNK)
                {
                    const length = Math.min(COPY_CHUNK, slot.size - at);
                    await sink.write(base + at, await readLater(slot.node, at, length));
                }
                // The last sector is whole in the file even where the stream is not.
                const tail = slot.size % SECTOR_SIZE;
                if (tail !== 0)
                {
                    await sink.write(base + slot.size, new Uint8Array(SECTOR_SIZE - tail));
                }
            }
        },
        bytes: ()=>{
            const out = new Uint8Array(size);
            fillHead(out, mini.map(index=>readNow(slots[index].node, 0, slots[index].size)));
            for (const index of large)
            {
                const slot = slots[index];
                out.set(readNow(slot.node, 0, slot.size), offsetOf(slot.start));
            }
            return out;
        },
    };
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
 * A tree as a compound file in memory, its sources read as they answer.
 *
 * @param {WriteStorage} root @returns {Promise<Uint8Array>}
 */
export async function compoundBytes(root){
    const plan = planCompound(root);
    const out = new Uint8Array(plan.size);
    await plan.writeTo({ write: (offset, bytes)=>out.set(bytes, offset) });
    return out;
}

/**
 * A tree as a compound file in memory, now: every source must answer at once.
 *
 * @param {WriteStorage} root @returns {Uint8Array}
 * @throws {CompoundWriteError} as `planCompound`, and for a source whose bytes come later
 */
export function compoundBytesSync(root){
    return planCompound(root).bytes();
}
