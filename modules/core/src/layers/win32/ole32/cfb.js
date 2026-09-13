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
 * This file reads one into a tree of entries and writes such a tree back out.
 * It knows nothing about COM or guest memory: the objects a program holds are
 * built over these entries in storage.js, and a file is read whole and written
 * whole, because a docfile a program persists an object through is small and
 * the alternative -- sector-level updates in place -- is where every corrupt
 * docfile ever seen came from.
 *
 * Only version 3 (512-byte sectors) is written. Version 4 (4096-byte sectors)
 * is read, since the header names the sector size and nothing else differs.
 */

import { GUID_NULL, GUID_SIZE, formatGuid, parseGuid } from './guid.js';

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
const DIFSECT = 0xfffffffc;
const FATSECT = 0xfffffffd;
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
/** The directory's "no such entry". */
const NOSTREAM = 0xffffffff;

/** Directory entry object types. */
const TYPE_UNALLOCATED = 0;
const TYPE_STORAGE = 1;
const TYPE_STREAM = 2;
const TYPE_ROOT = 5;

const COLOR_RED = 0;
const COLOR_BLACK = 1;

/** A name is at most 31 characters: 32 UTF-16 units with the terminator. */
export const MAX_NAME_LENGTH = 31;

/** The root entry's name, which is fixed by the format. */
const ROOT_NAME = 'Root Entry';

/**
 * One storage or stream. A storage's `children` is keyed by the name in the
 * form names are compared under -- upper case -- because that is how a
 * lookup by name works in the format itself.
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
 * @param {Uint8Array} bytes
 * @returns {CfbEntry | null} the root, or null if the bytes are not a compound file
 */
export function parseCompoundFile(bytes){
    if (!isCompoundFile(bytes))
    {
        return null;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const sectorShift = view.getUint16(0x1e, true);
    const miniShift = view.getUint16(0x20, true);
    if ((sectorShift !== 9 && sectorShift !== 12) || miniShift !== 6)
    {
        return null;
    }
    const sectorSize = 1 << sectorShift;
    const sectorCount = Math.floor((bytes.length - HEADER_SIZE) / sectorSize);
    const entriesPerFatSector = sectorSize / 4;

    /** @param {number} sector */
    const sectorOffset = sector=>HEADER_SIZE + sector * sectorSize;
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
 * The directory's siblings as a red-black tree, from a sorted list.
 *
 * Built by halving, which is height-balanced; the colouring that makes such
 * a tree red-black is to paint the deepest level red and everything above it
 * black, so every path to a missing child passes the same number of black
 * nodes. Windows does not check the colours when it reads, but a reader that
 * does is entitled to.
 *
 * @template T
 * @param {T[]} sorted
 * @param {(item: T, left: T | null, right: T | null, black: boolean) => void} link
 * @returns {T | null} the root
 */
function buildTree(sorted, link){
    const height = sorted.length === 0 ? 0 : Math.floor(Math.log2(sorted.length));
    /**
     * @param {number} low @param {number} high @param {number} depth
     * @returns {T | null}
     */
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
        link(sorted[middle], left, right, depth < height || depth === 0);
        return sorted[middle];
    };
    return build(0, sorted.length - 1, 0);
}

/**
 * Writes a tree of entries as a version 3 compound file.
 *
 * @param {CfbEntry} root
 * @returns {Uint8Array}
 */
export function serializeCompoundFile(root){
    const SECTOR_SIZE = 512;
    const ENTRIES_PER_FAT_SECTOR = SECTOR_SIZE / 4;
    const ENTRIES_PER_DIRECTORY_SECTOR = SECTOR_SIZE / DIRECTORY_ENTRY_SIZE;

    /**
     * The directory, flattened depth-first so that a storage's children sit
     * after it. Index 0 is the root, as the format requires.
     *
     * @type {{ entry: CfbEntry, left: number, right: number, child: number,
     *          black: boolean, start: number }[]}
     */
    const slots = [];
    /** @param {CfbEntry} entry */
    const place = entry=>{
        const index = slots.length;
        slots.push({ entry, left: NOSTREAM, right: NOSTREAM, child: NOSTREAM, black: true,
            start: ENDOFCHAIN });
        if (entry.kind === 'storage' && entry.children.size > 0)
        {
            const children = [...entry.children.values()]
                .sort((a, b)=>compareNames(a.name, b.name))
                .map(child=>({ child, index: place(child) }));
            const top = buildTree(children, (item, left, right, black)=>{
                slots[item.index].left = left ? left.index : NOSTREAM;
                slots[item.index].right = right ? right.index : NOSTREAM;
                slots[item.index].black = black;
            });
            slots[index].child = top ? top.index : NOSTREAM;
        }
        return index;
    };
    place(root);

    // Where each stream's bytes go: the mini stream for the short ones, their
    // own sectors for the rest. Both are laid out as consecutive runs, so a
    // chain is "the next one" until its last entry.
    /** @type {{ slot: number, data: Uint8Array }[]} */
    const miniStreams = [];
    /** @type {{ slot: number, data: Uint8Array }[]} */
    const bigStreams = [];
    slots.forEach((slot, index)=>{
        const { entry } = slot;
        if (index === 0 || entry.kind !== 'stream' || entry.data.length === 0)
        {
            return;
        }
        (entry.data.length < MINI_STREAM_CUTOFF ? miniStreams : bigStreams)
            .push({ slot: index, data: entry.data });
    });

    /** @param {number} bytes @param {number} unit */
    const sectorsFor = (bytes, unit)=>Math.ceil(bytes / unit);

    const miniSectorTotal = miniStreams.reduce(
        (sum, { data })=>sum + sectorsFor(data.length, MINI_SECTOR_SIZE), 0);
    const miniStreamBytes = miniSectorTotal * MINI_SECTOR_SIZE;
    const directorySectors = sectorsFor(slots.length, ENTRIES_PER_DIRECTORY_SECTOR);
    const miniFatSectors = sectorsFor(miniSectorTotal, ENTRIES_PER_FAT_SECTOR);
    const miniStreamSectors = sectorsFor(miniStreamBytes, SECTOR_SIZE);
    const bigStreamSectors = bigStreams.reduce(
        (sum, { data })=>sum + sectorsFor(data.length, SECTOR_SIZE), 0);
    const fixedSectors = directorySectors + miniFatSectors + miniStreamSectors + bigStreamSectors;

    // The FAT describes every sector including its own and the DIFAT's, so
    // its size is found by iterating until it stops growing.
    let fatSectors = 1;
    let difatSectors = 0;
    for (;;)
    {
        const total = fatSectors + difatSectors + fixedSectors;
        const neededFat = Math.max(1, sectorsFor(total, ENTRIES_PER_FAT_SECTOR));
        const neededDifat = neededFat <= HEADER_DIFAT_ENTRIES
            ? 0
            : sectorsFor(neededFat - HEADER_DIFAT_ENTRIES, ENTRIES_PER_FAT_SECTOR - 1);
        if (neededFat === fatSectors && neededDifat === difatSectors)
        {
            break;
        }
        fatSectors = neededFat;
        difatSectors = neededDifat;
    }
    const sectorTotal = fatSectors + difatSectors + fixedSectors;

    // Sector numbers, in the order the file is laid out.
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
    const bigStreamFirst = take(bigStreamSectors);

    const out = new Uint8Array(HEADER_SIZE + sectorTotal * SECTOR_SIZE);
    const view = new DataView(out.buffer);
    /** @param {number} sector */
    const sectorOffset = sector=>HEADER_SIZE + sector * SECTOR_SIZE;

    const fat = new Uint32Array(fatSectors * ENTRIES_PER_FAT_SECTOR).fill(FREESECT);
    /**
     * @param {number} first @param {number} count
     * @returns {number} the chain's first sector, or ENDOFCHAIN for none
     */
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

    let bigAt = bigStreamFirst;
    for (const { slot, data } of bigStreams)
    {
        const count = sectorsFor(data.length, SECTOR_SIZE);
        slots[slot].start = chain(bigAt, count);
        out.set(data, sectorOffset(bigAt));
        bigAt += count;
    }

    const miniFat = new Uint32Array(miniFatSectors * ENTRIES_PER_FAT_SECTOR).fill(FREESECT);
    const miniStream = new Uint8Array(miniStreamBytes);
    let miniAt = 0;
    for (const { slot, data } of miniStreams)
    {
        const count = sectorsFor(data.length, MINI_SECTOR_SIZE);
        for (let index = 0; index < count; index++)
        {
            miniFat[miniAt + index] = index + 1 < count ? miniAt + index + 1 : ENDOFCHAIN;
        }
        slots[slot].start = miniAt;
        miniStream.set(data, miniAt * MINI_SECTOR_SIZE);
        miniAt += count;
    }
    out.set(miniStream, sectorOffset(miniStreamFirst));

    /** @param {number} sector @param {Uint32Array} words @param {number} from */
    const writeWords = (sector, words, from)=>{
        const at = sectorOffset(sector);
        for (let index = 0; index < ENTRIES_PER_FAT_SECTOR; index++)
        {
            view.setUint32(at + index * 4, words[from + index], true);
        }
    };
    for (let index = 0; index < fatSectors; index++)
    {
        writeWords(fatFirst + index, fat, index * ENTRIES_PER_FAT_SECTOR);
    }
    for (let index = 0; index < miniFatSectors; index++)
    {
        writeWords(miniFatFirst + index, miniFat, index * ENTRIES_PER_FAT_SECTOR);
    }

    // The DIFAT: FAT sector numbers, first in the header, the rest chained
    // through DIFAT sectors whose last word names the next one.
    for (let index = 0; index < HEADER_DIFAT_ENTRIES; index++)
    {
        view.setUint32(0x4c + index * 4,
            index < fatSectors ? fatFirst + index : FREESECT, true);
    }
    const perDifatSector = ENTRIES_PER_FAT_SECTOR - 1;
    for (let index = 0; index < difatSectors; index++)
    {
        const at = sectorOffset(difatFirst + index);
        for (let slot = 0; slot < perDifatSector; slot++)
        {
            const fatIndex = HEADER_DIFAT_ENTRIES + index * perDifatSector + slot;
            view.setUint32(at + slot * 4, fatIndex < fatSectors ? fatFirst + fatIndex : FREESECT,
                true);
        }
        view.setUint32(at + perDifatSector * 4,
            index + 1 < difatSectors ? difatFirst + index + 1 : ENDOFCHAIN, true);
    }

    // The directory. Unused slots in its last sector stay zero, apart from
    // the three links, which are "none" rather than entry zero.
    for (let index = 0; index < directorySectors * ENTRIES_PER_DIRECTORY_SECTOR; index++)
    {
        const at = sectorOffset(directoryFirst + Math.floor(index / ENTRIES_PER_DIRECTORY_SECTOR))
            + (index % ENTRIES_PER_DIRECTORY_SECTOR) * DIRECTORY_ENTRY_SIZE;
        const slot = slots[index];
        if (!slot)
        {
            view.setUint32(at + 0x44, NOSTREAM, true);
            view.setUint32(at + 0x48, NOSTREAM, true);
            view.setUint32(at + 0x4c, NOSTREAM, true);
            continue;
        }
        const { entry } = slot;
        const name = entry.name.slice(0, MAX_NAME_LENGTH);
        for (let unit = 0; unit < name.length; unit++)
        {
            view.setUint16(at + unit * 2, name.charCodeAt(unit), true);
        }
        view.setUint16(at + 0x40, (name.length + 1) * 2, true);
        view.setUint8(at + 0x42, index === 0
            ? TYPE_ROOT
            : entry.kind === 'stream' ? TYPE_STREAM : TYPE_STORAGE);
        view.setUint8(at + 0x43, slot.black ? COLOR_BLACK : COLOR_RED);
        view.setUint32(at + 0x44, slot.left, true);
        view.setUint32(at + 0x48, slot.right, true);
        view.setUint32(at + 0x4c, slot.child, true);
        out.set(parseGuid(entry.clsid) ?? new Uint8Array(GUID_SIZE), at + 0x50);
        view.setUint32(at + 0x60, entry.stateBits, true);
        view.setBigUint64(at + 0x64, entry.created, true);
        view.setBigUint64(at + 0x6c, entry.modified, true);
        view.setUint32(at + 0x74, slot.start, true);
        const size = index === 0
            ? miniStreamBytes
            : entry.kind === 'stream' ? entry.data.length : 0;
        view.setUint32(at + 0x78, size, true);
    }

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
    return out;
}
