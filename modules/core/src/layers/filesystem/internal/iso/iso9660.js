/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A disc image in the ISO 9660 format, with the Joliet extension, read a
 * range at a time.
 *
 * Written from the format's own definition (ECMA-119, and the Joliet
 * specification for the supplementary descriptor that carries long names).
 * Rock Ridge and UDF are not read: a disc of the era carries its names for
 * Windows in the Joliet tree, and Windows itself reads nothing else from one.
 *
 * Nothing here holds the image. It is opened with a function that reads a
 * range of it -- an image is hundreds of megabytes, and the person chose a
 * file, not a buffer -- and only the descriptors and the directories are read
 * when it is opened. A file's contents are read when they are asked for, by
 * the same function. That function may answer at once or with a promise: the
 * page reads a chosen file asynchronously, the engine's worker synchronously,
 * and `read` answers in whichever of the two it was given.
 */

import { foldName } from '../paths.js';

/** The unit a disc is addressed in, and where the descriptors start. */
export const SECTOR_SIZE = 2048;
const DESCRIPTORS_START = 16;
/** How many descriptors are looked at before the set is taken to have no end. */
const DESCRIPTORS_MAX = 64;

const TYPE_PRIMARY = 1;
const TYPE_SUPPLEMENTARY = 2;
const TYPE_TERMINATOR = 255;

/** Directory record flags (ECMA-119, 9.1.6). */
const FLAG_HIDDEN = 0x01;
const FLAG_DIRECTORY = 0x02;
const FLAG_ASSOCIATED = 0x04;
const FLAG_MULTI_EXTENT = 0x80;

/** The fixed part of a directory record, before its identifier. */
const RECORD_FIXED = 33;

/**
 * Bounds on what an image may make this do. A directory that names itself as
 * its own child, or a tree a million entries wide, is a damaged image rather
 * than a disc, and walking it is refused rather than attempted.
 */
const MAX_DEPTH = 64;
const MAX_ENTRIES = 1 << 20;

/**
 * Reads `length` bytes at `offset` of the image. A read past the end answers
 * with what there is.
 *
 * @typedef {(offset: number, length: number) => Uint8Array | Promise<Uint8Array>} ReadRange
 */

/**
 * A run of a file's bytes in the image. An interleaved file is recorded in
 * units of `unit` blocks with `gap` blocks between them.
 *
 * @typedef {Object} IsoExtent
 * @property {number} at      Byte offset in the image.
 * @property {number} length  Bytes of the file this run holds.
 * @property {number} unit    Blocks per interleaved unit, 0 when not interleaved.
 * @property {number} gap     Blocks skipped after each unit.
 */

/**
 * @typedef {Object} IsoEntry
 * @property {string} path       Backslash-separated, relative to the root.
 * @property {string} name
 * @property {boolean} directory
 * @property {number} size
 * @property {number | null} modified  Milliseconds since the epoch, or null when unrecorded.
 * @property {boolean} hidden    The record's existence bit.
 * @property {IsoExtent[]} extents
 */

/**
 * @typedef {Object} IsoVolume
 * @property {string} label       The volume identifier, from the descriptor the tree was read from.
 * @property {number} serial      The serial number Windows reports for the disc.
 * @property {number} blockSize   Bytes per logical block.
 * @property {number} blocks      The volume space, in logical blocks.
 * @property {number} size        The volume space, in bytes.
 * @property {boolean} joliet     Whether the names are Joliet's.
 */

/**
 * @typedef {Object} IsoImage
 * @property {IsoVolume} volume
 * @property {IsoEntry[]} entries  Every file and directory, each directory before what it holds.
 * @property {(path: string) => IsoEntry | null} find  Without regard to case, `\` or `/`.
 * @property {(entry: IsoEntry, offset: number, length: number)
 *     => Uint8Array | Promise<Uint8Array>} read
 *     A file's bytes, in the manner of the function the image was opened with.
 */

/** @param {unknown} value @returns {value is Promise<any>} */
const isPromise = value=>typeof (/** @type {any} */ (value))?.then === 'function';

/** @param {Uint8Array} bytes @param {number} at */
const u16 = (bytes, at)=>bytes[at] | bytes[at + 1] << 8;
/** @param {Uint8Array} bytes @param {number} at */
const u32 = (bytes, at)=>(bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16
    | bytes[at + 3] << 24) >>> 0;

/** @param {Uint8Array} bytes @param {number} from @param {number} to */
const latin1 = (bytes, from, to)=>{
    let text = '';
    for (let at = from; at < Math.min(to, bytes.length); at++)
    {
        text += String.fromCharCode(bytes[at]);
    }
    return text;
};

/**
 * Joliet's names are UCS-2, most significant byte first.
 *
 * @param {Uint8Array} bytes @param {number} from @param {number} to
 */
const ucs2 = (bytes, from, to)=>{
    let text = '';
    for (let at = from; at + 1 < Math.min(to, bytes.length); at += 2)
    {
        text += String.fromCharCode(bytes[at] << 8 | bytes[at + 1]);
    }
    return text;
};

/** @param {Uint8Array[]} parts @returns {Uint8Array} */
const join = parts=>{
    if (parts.length === 1)
    {
        return parts[0];
    }
    const out = new Uint8Array(parts.reduce((sum, part)=>sum + part.length, 0));
    let at = 0;
    for (const part of parts)
    {
        out.set(part, at);
        at += part.length;
    }
    return out;
};

/**
 * Whether a supplementary descriptor is Joliet's: one of the three escape
 * sequences for UCS-2, levels 1 to 3, in its escape field.
 *
 * @param {Uint8Array} descriptor
 */
const isJoliet = descriptor=>descriptor[88] === 0x25 && descriptor[89] === 0x2f
    && (descriptor[90] === 0x40 || descriptor[90] === 0x43 || descriptor[90] === 0x45);

/**
 * The serial number Windows gives a disc: the bytes of the volume descriptor
 * it mounted -- the Joliet one where there is one -- summed four ways into the
 * four bytes of a word, the first byte of the descriptor into the most
 * significant sum. A program comparing a disc's serial against one it
 * recorded compares this number.
 *
 * @param {Uint8Array} descriptor  The whole sector.
 * @returns {number}
 */
export function discSerial(descriptor){
    const sums = [0, 0, 0, 0];
    for (let at = 0; at < SECTOR_SIZE; at++)
    {
        const lane = 3 - (at & 3);
        sums[lane] = (sums[lane] + (descriptor[at] ?? 0)) & 0xff;
    }
    return (sums[0] | sums[1] << 8 | sums[2] << 16 | sums[3] << 24) >>> 0;
}

/**
 * A directory record's recording time (ECMA-119, 9.1.5): years since 1900,
 * month, day, hour, minute, second, and the zone as a signed count of quarter
 * hours east of Greenwich. All zeros is no time at all.
 *
 * @param {Uint8Array} bytes @param {number} at
 * @returns {number | null}
 */
export function recordingTime(bytes, at){
    const fields = bytes.subarray(at, at + 7);
    if (fields.length < 7 || fields.every(value=>value === 0) || fields[1] === 0 || fields[2] === 0)
    {
        return null;
    }
    const zone = fields[6] << 24 >> 24;
    return Date.UTC(1900 + fields[0], fields[1] - 1, fields[2], fields[3], fields[4], fields[5])
        - zone * 15 * 60 * 1000;
}

/**
 * The name a directory record gives, as Windows shows it: the version after
 * `;` dropped, and the dot a name without an extension is written with.
 * Null for a name no Win32 path could carry.
 *
 * @param {string} raw @param {boolean} directory
 * @returns {string | null}
 */
function cleanName(raw, directory){
    let name = raw;
    while (name.endsWith(String.fromCharCode(0)))
    {
        name = name.slice(0, -1);
    }
    if (!directory)
    {
        name = name.replace(/;[0-9]*$/, '').replace(/\.$/, '');
    }
    const unusable = [...name].some(character=>character < ' ' || character === '\\'
        || character === '/');
    if (name === '' || name === '.' || name === '..' || unusable)
    {
        return null;
    }
    return name;
}

/**
 * The byte ranges of the image that hold `length` bytes of a file from
 * `offset`, adjacent ranges merged.
 *
 * @param {IsoEntry} entry @param {number} offset @param {number} length
 * @param {number} blockSize
 * @returns {{ at: number, length: number }[]}
 */
export function rangesOf(entry, offset, length, blockSize){
    /** @type {{ at: number, length: number }[]} */
    const out = [];
    /** @param {number} at @param {number} bytes */
    const push = (at, bytes)=>{
        const last = out[out.length - 1];
        if (last && last.at + last.length === at)
        {
            last.length += bytes;
            return;
        }
        out.push({ at, length: bytes });
    };
    let skip = Math.max(0, offset);
    let want = Math.max(0, Math.min(length, entry.size - skip));
    for (const extent of entry.extents)
    {
        if (want === 0)
        {
            break;
        }
        if (skip >= extent.length)
        {
            skip -= extent.length;
            continue;
        }
        let take = Math.min(want, extent.length - skip);
        want -= take;
        if (extent.unit === 0)
        {
            push(extent.at + skip, take);
        }
        else
        {
            const unitBytes = extent.unit * blockSize;
            const stride = (extent.unit + extent.gap) * blockSize;
            while (take > 0)
            {
                const within = skip % unitBytes;
                const bytes = Math.min(take, unitBytes - within);
                push(extent.at + Math.floor(skip / unitBytes) * stride + within, bytes);
                skip += bytes;
                take -= bytes;
            }
        }
        skip = 0;
    }
    return out;
}

/**
 * Whether the bytes at the start of sector 16 are a volume descriptor: what a
 * caller holding a file of unknown kind asks before opening it as a disc.
 *
 * @param {ReadRange} read
 * @returns {Promise<boolean>}
 */
export async function isIsoImage(read){
    const head = await read(DESCRIPTORS_START * SECTOR_SIZE, 6);
    return head.length === 6 && latin1(head, 1, 6) === 'CD001'
        && (head[0] === TYPE_PRIMARY || head[0] === TYPE_SUPPLEMENTARY || head[0] === 0);
}

/**
 * Opens an image: its descriptors, and every directory in the tree it will be
 * read through. The Joliet tree where the disc has one, because that is the
 * one Windows mounts and the one whose names are the files' own; the primary
 * tree's upper-case short names otherwise.
 *
 * @param {ReadRange} read
 * @returns {Promise<IsoImage>}
 */
export async function openIso(read){
    /** @type {Uint8Array | null} */
    let primary = null;
    /** @type {Uint8Array | null} */
    let joliet = null;
    for (let sector = DESCRIPTORS_START; sector < DESCRIPTORS_START + DESCRIPTORS_MAX; sector++)
    {
        const descriptor = await read(sector * SECTOR_SIZE, SECTOR_SIZE);
        if (descriptor.length < SECTOR_SIZE || latin1(descriptor, 1, 6) !== 'CD001')
        {
            break;
        }
        if (descriptor[0] === TYPE_TERMINATOR)
        {
            break;
        }
        if (descriptor[0] === TYPE_PRIMARY && !primary)
        {
            primary = descriptor;
        }
        else if (descriptor[0] === TYPE_SUPPLEMENTARY && !joliet && isJoliet(descriptor))
        {
            joliet = descriptor;
        }
    }
    if (!primary)
    {
        throw new Error('not an ISO 9660 image: no primary volume descriptor at sector 16');
    }

    const chosen = joliet ?? primary;
    const logical = u16(chosen, 128);
    // 2048 on every disc there is; anything that is not a power of two up to
    // a sector would place every extent somewhere else.
    const blockSize = logical >= 512 && logical <= SECTOR_SIZE && (logical & logical - 1) === 0
        ? logical : SECTOR_SIZE;
    const blocks = u32(chosen, 80);
    const label = (joliet ? ucs2(chosen, 40, 72) : latin1(chosen, 40, 72))
        .replace(/[\0 ]+$/, '');

    /** @type {IsoEntry[]} */
    const entries = [];
    /** @type {Set<number>} */
    const visited = new Set();

    /**
     * @param {Uint8Array} record @param {number} at
     * @returns {IsoExtent}
     */
    const extentOf = (record, at)=>({
        at: (u32(record, at + 2) + record[at + 1]) * blockSize,
        length: u32(record, at + 10),
        unit: record[at + 26],
        gap: record[at + 26] === 0 ? 0 : record[at + 27],
    });

    /**
     * @param {IsoExtent} extent @param {string} under @param {number} depth
     */
    const walk = async(extent, under, depth)=>{
        if (depth > MAX_DEPTH || visited.has(extent.at))
        {
            throw new Error(`damaged ISO 9660 image: the directory at ${extent.at} `
                + 'is reached twice or lies too deep');
        }
        visited.add(extent.at);
        const data = await read(extent.at, extent.length);

        /** @type {IsoEntry[]} */
        const directories = [];
        /** @type {IsoEntry | null} */
        let pending = null;
        const settle = ()=>{
            if (pending)
            {
                entries.push(pending);
                pending = null;
            }
        };

        for (let sector = 0; sector < data.length; sector += SECTOR_SIZE)
        {
            const end = Math.min(sector + SECTOR_SIZE, data.length);
            // A record never crosses a sector; a zero length is the padding
            // that fills the rest of one.
            for (let at = sector; at < end && data[at] !== 0;)
            {
                if (entries.length > MAX_ENTRIES)
                {
                    throw new Error(`damaged ISO 9660 image: more than ${MAX_ENTRIES} entries`);
                }
                const length = data[at];
                const nameLength = data[at + 32];
                if (length < RECORD_FIXED + 1 || at + length > end
                    || RECORD_FIXED + nameLength > length)
                {
                    break;
                }
                const flags = data[at + 25];
                const directory = (flags & FLAG_DIRECTORY) !== 0;
                const self = nameLength === 1 && data[at + RECORD_FIXED] <= 1;
                const name = self ? null : cleanName(joliet
                    ? ucs2(data, at + RECORD_FIXED, at + RECORD_FIXED + nameLength)
                    : latin1(data, at + RECORD_FIXED, at + RECORD_FIXED + nameLength), directory);
                const record = extentOf(data, at);
                at += length;

                // An associated file is another system's fork of the file of
                // the same name, and not a file of its own.
                if (name === null || (flags & FLAG_ASSOCIATED) !== 0)
                {
                    continue;
                }
                // The parts of a file too large for one extent are recorded one
                // after another under one name, every one but the last marked.
                const current = /** @type {IsoEntry | null} */ (pending);
                if (current && current.name === name && !directory)
                {
                    current.extents.push(record);
                    current.size += record.length;
                }
                else
                {
                    settle();
                    const entry = {
                        path: under === '' ? name : `${under}\\${name}`,
                        name,
                        directory,
                        size: directory ? 0 : record.length,
                        modified: recordingTime(data, at - length + 18),
                        hidden: (flags & FLAG_HIDDEN) !== 0,
                        extents: [record],
                    };
                    if (directory)
                    {
                        entries.push(entry);
                        directories.push(entry);
                        continue;
                    }
                    pending = entry;
                }
                if ((flags & FLAG_MULTI_EXTENT) === 0)
                {
                    settle();
                }
            }
        }
        settle();

        for (const directory of directories)
        {
            await walk(directory.extents[0], directory.path, depth + 1);
        }
    };

    await walk(extentOf(chosen, 156), '', 0);

    /** @type {Map<string, IsoEntry>} */
    const byPath = new Map();
    for (const entry of entries)
    {
        byPath.set(foldName(entry.path), entry);
    }

    return {
        volume: {
            label,
            serial: discSerial(chosen),
            blockSize,
            blocks,
            size: blocks * blockSize,
            joliet: joliet !== null,
        },
        entries,
        find: path=>byPath.get(foldName(path.split(/[\\/]/).filter(Boolean).join('\\')))
            ?? null,
        read(entry, offset, length){
            const parts = rangesOf(entry, offset, length, blockSize)
                .map(range=>read(range.at, range.length));
            if (parts.length === 0)
            {
                return new Uint8Array(0);
            }
            if (parts.some(isPromise))
            {
                return Promise.all(parts).then(join);
            }
            return join(/** @type {Uint8Array[]} */ (parts));
        },
    };
}
