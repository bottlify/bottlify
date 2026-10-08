/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The compound file binary format: what a docfile is on disk.
 *
 * A compound file is a small filesystem in one file. The file is cut into
 * sectors, a FAT says which sector follows which, and a directory of 128-byte
 * entries names storages and streams as a red-black tree per storage. Streams
 * under a cutoff live in one more level of the same scheme -- the mini stream,
 * itself an ordinary stream, cut into 64-byte mini sectors with a mini FAT of
 * their own -- so that a file of a hundred tiny streams is not a hundred
 * half-empty sectors.
 *
 * This file reads one into a tree of entries and writes such a tree back out
 * with the writer in ../common/compound-writer.js, the one every compound file
 * here is written with. It knows nothing about COM or guest memory: the
 * objects a program holds are built over these entries in storage.js, and a
 * file is read whole and written whole, because a docfile a program persists
 * an object through is small and the alternative -- sector-level updates in
 * place -- is where every corrupt docfile ever seen came from.
 *
 * Only version 3 (512-byte sectors) is written. Version 4 (4096-byte sectors)
 * is read, since the header names the sector size and nothing else differs.
 */

import {
    MAX_NAME_LENGTH, compareNames, compoundBytesSync, memorySource, nameKey,
} from '../common/compound-writer.js';
import { GUID_NULL, formatGuid } from './guid.js';

export { MAX_NAME_LENGTH, compareNames, nameKey };

/** The eight bytes every compound file begins with. */
const SIGNATURE = Object.freeze([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

const HEADER_SIZE = 512;
const DIRECTORY_ENTRY_SIZE = 128;
const MINI_SECTOR_SIZE = 64;
/** A stream shorter than this lives in the mini stream. */
const MINI_STREAM_CUTOFF = 4096;
/** How many FAT sector numbers the header itself holds before DIFAT sectors are needed. */
const HEADER_DIFAT_ENTRIES = 109;

/** Sector numbers with a meaning of their own. */
const MAXREGSECT = 0xfffffffa;
const ENDOFCHAIN = 0xfffffffe;
/** The directory's "no such entry". */
const NOSTREAM = 0xffffffff;

/** Directory entry object types. */
const TYPE_UNALLOCATED = 0;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;

/** The root entry's name, which is fixed by the format. */
const ROOT_NAME = 'Root Entry';

/**
 * One storage or stream. A storage's `children` is keyed by the name in the
 * form names are compared under -- upper case -- because that is how a
 * lookup by name works in the format itself.
 *
 * @typedef {import('../common/compound-writer.js').WriteStorage} WriteStorage
 *
 * @typedef {Object} CfbEntry
 * @property {string} name
 * @property {'storage' | 'stream'} kind
 * @property {string} clsid        Canonical GUID string; GUID_NULL for none.
 * @property {number} stateBits
 * @property {bigint} created      FILETIME; 0n when unset.
 * @property {bigint} modified
 * @property {Map<string, CfbEntry>} children  Empty for a stream.
 * @property {Uint8Array} data     Empty for a storage.
 */

/**
 * @param {string} name
 * @param {'storage' | 'stream'} kind
 * @returns {CfbEntry}
 */
export function createEntry(name, kind){
    return {
        name, kind, clsid: GUID_NULL, stateBits: 0, created: 0n, modified: 0n,
        children: new Map(), data: new Uint8Array(0),
    };
}

/** @returns {CfbEntry} an empty root */
export function createRoot(){
    return createEntry(ROOT_NAME, 'storage');
}

/**
 * @param {Uint8Array} bytes
 * @returns {boolean} whether the bytes begin the way a compound file does
 */
export function isCompoundFile(bytes){
    return bytes.length >= HEADER_SIZE && SIGNATURE.every((byte, index)=>bytes[index] === byte);
}

/**
 * Reads a compound file into its tree of entries.
 *
 * Damage is answered with null rather than a partial tree: a chain that
 * loops, a sector past the end or a directory entry pointing outside the
 * directory are all the same "this is not a docfile we can trust", and a
 * program is better told so than handed half of its data.
 *
 * @param {Uint8Array} given
 * @returns {CfbEntry | null} the root, or null if the bytes are not a compound file
 */
export function parseCompoundFile(given){
    if (!isCompoundFile(given))
    {
        return null;
    }
    const header = new DataView(given.buffer, given.byteOffset, HEADER_SIZE);
    const sectorShift = header.getUint16(0x1e, true);
    const miniShift = header.getUint16(0x20, true);
    if ((sectorShift !== 9 && sectorShift !== 12) || miniShift !== 6)
    {
        return null;
    }
    const sectorSize = 1 << sectorShift;
    // The header takes a whole sector -- a version 4 file pads it to 4096 --
    // and a file may end partway into its last one, where the stream in it
    // ends: Windows opens it, and what is missing reads as zeros.
    const sectorCount = Math.max(0, Math.ceil((given.length - sectorSize) / sectorSize));
    const whole = sectorSize * (sectorCount + 1);
    const bytes = given.length >= whole ? given : new Uint8Array(whole);
    if (bytes !== given)
    {
        bytes.set(given);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const entriesPerFatSector = sectorSize / 4;

    /** @param {number} sector */
    const sectorOffset = sector=>sectorSize + sector * sectorSize;
    /** @param {number} sector @returns {Uint32Array | null} */
    const sectorWords = sector=>{
        if (sector > MAXREGSECT || sector >= sectorCount)
        {
            return null;
        }
        const words = new Uint32Array(entriesPerFatSector);
        const at = sectorOffset(sector);
        for (let index = 0; index < words.length; index++)
        {
            words[index] = view.getUint32(at + index * 4, true);
        }
        return words;
    };

    // The DIFAT: which sectors hold the FAT. The header's own 109 entries
    // come first, then a chain of DIFAT sectors whose last word is the next.
    const fatSectorCount = view.getUint32(0x2c, true);
    /** @type {number[]} */
    const fatSectors = [];
    for (let index = 0; index < HEADER_DIFAT_ENTRIES && fatSectors.length < fatSectorCount; index++)
    {
        fatSectors.push(view.getUint32(0x4c + index * 4, true));
    }
    let difatSector = view.getUint32(0x44, true);
    const difatCount = view.getUint32(0x48, true);
    for (let seen = 0; seen < difatCount && difatSector <= MAXREGSECT; seen++)
    {
        const words = sectorWords(difatSector);
        if (!words)
        {
            return null;
        }
        for (let index = 0; index < words.length - 1 && fatSectors.length < fatSectorCount; index++)
        {
            fatSectors.push(words[index]);
        }
        difatSector = words[words.length - 1];
    }
    if (fatSectors.length !== fatSectorCount)
    {
        return null;
    }

    const fat = new Uint32Array(fatSectorCount * entriesPerFatSector);
    for (let index = 0; index < fatSectors.length; index++)
    {
        const words = sectorWords(fatSectors[index]);
        if (!words)
        {
            return null;
        }
        fat.set(words, index * entriesPerFatSector);
    }

    /**
     * Every sector of a chain, in order; null on a loop or a bad number.
     *
     * @param {Uint32Array} table @param {number} first @param {number} limit
     *        How many sectors the table describes.
     */
    const chainOf = (table, first, limit)=>{
        /** @type {number[]} */
        const chain = [];
        const seen = new Set();
        let sector = first;
        while (sector !== ENDOFCHAIN)
        {
            if (sector > MAXREGSECT || sector >= limit || sector >= table.length
                || seen.has(sector))
            {
                return null;
            }
            seen.add(sector);
            chain.push(sector);
            sector = table[sector];
        }
        return chain;
    };

    /** @param {number} first @param {number} size @returns {Uint8Array | null} */
    const readChain = (first, size)=>{
        if (size === 0)
        {
            return new Uint8Array(0);
        }
        const chain = chainOf(fat, first, sectorCount);
        if (!chain || chain.length * sectorSize < size)
        {
            return null;
        }
        const out = new Uint8Array(size);
        chain.forEach((sector, index)=>{
            const at = sectorOffset(sector);
            const take = Math.min(sectorSize, size - index * sectorSize);
            if (take > 0)
            {
                out.set(bytes.subarray(at, at + take), index * sectorSize);
            }
        });
        return out;
    };

    // The directory, as a flat list of entries; the tree is walked afterwards.
    const directoryChain = chainOf(fat, view.getUint32(0x30, true), sectorCount);
    if (!directoryChain)
    {
        return null;
    }
    const entriesPerDirectorySector = sectorSize / DIRECTORY_ENTRY_SIZE;
    /**
     * @type {{ name: string, type: number, left: number, right: number, child: number,
     *          clsid: string, stateBits: number, created: bigint, modified: bigint,
     *          start: number, size: number }[]}
     */
    const raw = [];
    for (const sector of directoryChain)
    {
        for (let slot = 0; slot < entriesPerDirectorySector; slot++)
        {
            const at = sectorOffset(sector) + slot * DIRECTORY_ENTRY_SIZE;
            const nameBytes = view.getUint16(at + 0x40, true);
            let name = '';
            // The length counts the terminator; a length of zero is an
            // unallocated entry and an odd one is damage, both read as empty.
            const units = nameBytes >= 2 && nameBytes <= 64 && nameBytes % 2 === 0
                ? nameBytes / 2 - 1
                : 0;
            for (let index = 0; index < units; index++)
            {
                const unit = view.getUint16(at + index * 2, true);
                if (unit === 0)
                {
                    break;
                }
                name += String.fromCharCode(unit);
            }
            // Version 3 files carry a 32-bit size and leave the high word to
            // chance, so only the low word is trusted there.
            const sizeLow = view.getUint32(at + 0x78, true);
            const sizeHigh = sectorShift === 9 ? 0 : view.getUint32(at + 0x7c, true);
            raw.push({
                name,
                type: view.getUint8(at + 0x42),
                left: view.getUint32(at + 0x44, true),
                right: view.getUint32(at + 0x48, true),
                child: view.getUint32(at + 0x4c, true),
                clsid: formatGuid(bytes.subarray(at + 0x50, at + 0x60)),
                stateBits: view.getUint32(at + 0x60, true),
                created: view.getBigUint64(at + 0x64, true),
                modified: view.getBigUint64(at + 0x6c, true),
                start: view.getUint32(at + 0x74, true),
                size: sizeHigh === 0 ? sizeLow : Number.MAX_SAFE_INTEGER,
            });
        }
    }
    if (raw.length === 0 || raw[0].type !== TYPE_ROOT)
    {
        return null;
    }

    // The mini stream is the root entry's own stream, and the mini FAT is
    // chained through the regular FAT like anything else.
    const miniStream = readChain(raw[0].start, raw[0].size);
    const miniFatChain = chainOf(fat, view.getUint32(0x3c, true), sectorCount);
    if (!miniStream || !miniFatChain)
    {
        return null;
    }
    const miniFat = new Uint32Array(miniFatChain.length * entriesPerFatSector);
    miniFatChain.forEach((sector, index)=>{
        miniFat.set(/** @type {Uint32Array} */ (sectorWords(sector)), index * entriesPerFatSector);
    });
    const miniSectorCount = Math.floor(miniStream.length / MINI_SECTOR_SIZE);

    /** @param {number} first @param {number} size @returns {Uint8Array | null} */
    const readMiniChain = (first, size)=>{
        if (size === 0)
        {
            return new Uint8Array(0);
        }
        const chain = chainOf(miniFat, first, miniSectorCount);
        if (!chain || chain.length * MINI_SECTOR_SIZE < size)
        {
            return null;
        }
        const out = new Uint8Array(size);
        chain.forEach((sector, index)=>{
            const at = sector * MINI_SECTOR_SIZE;
            const take = Math.min(MINI_SECTOR_SIZE, size - index * MINI_SECTOR_SIZE);
            if (take > 0)
            {
                out.set(miniStream.subarray(at, at + take), index * MINI_SECTOR_SIZE);
            }
        });
        return out;
    };

    const visited = new Set();
    /**
     * Builds the entry for one directory slot, with its subtree. Siblings
     * are the red-black tree's left and right; a storage's children hang off
     * `child`. Every index is checked against the directory and against what
     * was already visited, so a damaged file cannot recurse forever.
     *
     * @param {number} index
     * @returns {CfbEntry | null}
     */
    const build = index=>{
        const entry = raw[index];
        if (!entry || visited.has(index) || entry.type === TYPE_UNALLOCATED)
        {
            return null;
        }
        visited.add(index);
        const kind = entry.type === TYPE_STREAM ? 'stream' : 'storage';
        const built = createEntry(index === 0 ? ROOT_NAME : entry.name, kind);
        built.clsid = entry.clsid;
        built.stateBits = entry.stateBits;
        built.created = entry.created;
        built.modified = entry.modified;
        if (kind === 'stream')
        {
            const data = entry.size < MINI_STREAM_CUTOFF
                ? readMiniChain(entry.start, entry.size)
                : readChain(entry.start, entry.size);
            if (!data)
            {
                return null;
            }
            built.data = data;
        }
        else if (entry.child !== NOSTREAM)
        {
            if (!collect(entry.child, built.children))
            {
                return null;
            }
        }
        return built;
    };

    /**
     * Walks one storage's sibling tree into its children map.
     *
     * @param {number} index @param {Map<string, CfbEntry>} into
     * @returns {boolean}
     */
    const collect = (index, into)=>{
        /** @type {number[]} */
        const stack = [index];
        while (stack.length > 0)
        {
            const at = /** @type {number} */ (stack.pop());
            if (at === NOSTREAM)
            {
                continue;
            }
            const entry = raw[at];
            if (!entry || visited.has(at))
            {
                return false;
            }
            const built = build(at);
            if (!built)
            {
                return false;
            }
            into.set(nameKey(built.name), built);
            stack.push(entry.left, entry.right);
        }
        return true;
    };

    return build(0);
}

/**
 * Writes a tree of entries as a version 3 compound file, through the writer
 * every docfile here is written with: each entry's class, state bits and
 * times as it holds them.
 *
 * @param {CfbEntry} root
 * @returns {Uint8Array}
 * @throws {import('../common/compound-writer.js').CompoundWriteError} for a name
 *         the format cannot hold
 */
export function serializeCompoundFile(root){
    return compoundBytesSync(/** @type {WriteStorage} */ (writeNode(root)));
}

/**
 * @param {CfbEntry} entry
 * @returns {import('../common/compound-writer.js').WriteNode}
 */
function writeNode(entry){
    const info = {
        name: entry.name, clsid: entry.clsid, stateBits: entry.stateBits,
        created: entry.created, modified: entry.modified,
    };
    return entry.kind === 'stream'
        ? { ...info, kind: 'stream', source: memorySource(entry.data) }
        : { ...info, kind: 'storage', children: [...entry.children.values()].map(writeNode) };
}
