/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Installing from an archive: a setup shipped as a zip rather than burned to a
 * disc.
 *
 * The archive is unpacked and its tree built into a disc image, so from there
 * it is a disc like any other (`disc.js`): mounted as D:, a CD-ROM, and the
 * program the person picked out of it started from there -- an archive has no
 * `autorun.inf` to name one, so the person names it.
 *
 * The zip format as PKWARE's APPNOTE defines it: the central directory at the
 * end names every entry, its method and where its local header is; an entry is
 * stored or deflated; ZIP64 widens the sizes and offsets that do not fit in
 * 32 bits. Names are UTF-8 where the entry says so (general purpose bit 11)
 * and the ANSI page otherwise. Encrypted entries and any other method are
 * refused by name.
 *
 * Read from the chosen file a range at a time; what is held in memory is the
 * unpacked tree and the image built from it.
 */

import { buildIso } from '@bottlify/core/iso';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_DIRECTORY = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END = 0x06064b50;
const ZIP64_EXTRA = 0x0001;
const STORED = 0;
const DEFLATED = 8;
/** The end record, and the most a comment after it may hold. */
const END_BYTES = 22;
const COMMENT_MAX = 0xffff;

/**
 * @typedef {Object} ArchiveEntry
 * @property {string} path            Backslash-separated, relative to the archive's root.
 * @property {Uint8Array | null} bytes  Null for a directory.
 */

/** @param {Blob} blob @param {number} offset @param {number} length */
const slice = async(blob, offset, length)=>
    new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());

/** @param {Uint8Array} bytes */
const viewOf = bytes=>new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/**
 * Whether a file is a zip archive, by its first signature: a local header, or
 * the end record of an archive with nothing in it.
 *
 * @param {Blob} blob
 */
export async function isZipArchive(blob){
    if (blob.size < 4)
    {
        return false;
    }
    const first = viewOf(await slice(blob, 0, 4)).getUint32(0, true);
    return first === LOCAL_HEADER || first === END_OF_DIRECTORY;
}

/**
 * Where the central directory is and how many entries it holds, ZIP64's
 * record taking over where the classic one is saturated.
 *
 * @param {Blob} blob
 * @returns {Promise<{ offset: number, count: number }>}
 */
async function directoryOf(blob){
    const tailLength = Math.min(blob.size, END_BYTES + COMMENT_MAX);
    const tail = await slice(blob, blob.size - tailLength, tailLength);
    const view = viewOf(tail);
    let at = tail.length - END_BYTES;
    while (at >= 0 && view.getUint32(at, true) !== END_OF_DIRECTORY)
    {
        at--;
    }
    if (at < 0)
    {
        throw new Error('not a zip archive: no end of central directory');
    }
    let count = view.getUint16(at + 10, true);
    let offset = view.getUint32(at + 16, true);
    const locator = at - 20;
    if (locator >= 0 && view.getUint32(locator, true) === ZIP64_LOCATOR)
    {
        const endAt = Number(view.getBigUint64(locator + 8, true));
        const end = viewOf(await slice(blob, endAt, 56));
        if (end.getUint32(0, true) !== ZIP64_END)
        {
            throw new Error('the ZIP64 end record is not where its locator says');
        }
        count = Number(end.getBigUint64(32, true));
        offset = Number(end.getBigUint64(48, true));
    }
    return { offset, count };
}

/** @param {Uint8Array} bytes @param {boolean} utf8 */
const nameOf = (bytes, utf8)=>new TextDecoder(utf8 ? 'utf-8' : 'windows-1252').decode(bytes);

/**
 * @param {Uint8Array} bytes @param {string} path
 * @returns {Promise<Uint8Array>}
 */
async function inflate(bytes, path){
    try
    {
        // An ArrayBuffer's view, which Blob takes whatever the declarations say.
        const part = /** @type {BlobPart} */ (/** @type {unknown} */ (bytes));
        const stream = new Blob([part]).stream()
            .pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    catch (e){
        throw new Error(`${path} could not be inflated: ${/** @type {Error} */ (e).message}`,
            { cause: e });
    }
}

/**
 * Every entry of a zip archive, unpacked.
 *
 * @param {Blob} blob
 * @param {(done: number, total: number) => void} [progress]  Entries unpacked so far.
 * @returns {Promise<ArchiveEntry[]>}
 */
export async function readZip(blob, progress){
    const { offset, count } = await directoryOf(blob);
    const directory = await slice(blob, offset, blob.size - offset);
    const view = viewOf(directory);
    /** @type {ArchiveEntry[]} */
    const entries = [];
    let at = 0;
    for (let index = 0; index < count; index++)
    {
        if (view.getUint32(at, true) !== CENTRAL_HEADER)
        {
            throw new Error(`entry ${index} of the central directory is damaged`);
        }
        const flags = view.getUint16(at + 8, true);
        const method = view.getUint16(at + 10, true);
        let packed = view.getUint32(at + 20, true);
        let size = view.getUint32(at + 24, true);
        const nameLength = view.getUint16(at + 28, true);
        const extraLength = view.getUint16(at + 30, true);
        const commentLength = view.getUint16(at + 32, true);
        let local = view.getUint32(at + 42, true);
        const name = nameOf(directory.subarray(at + 46, at + 46 + nameLength),
            (flags & 0x800) !== 0);

        // ZIP64's extra field holds, in this order, each of the three that
        // were saturated in the header.
        for (let extra = at + 46 + nameLength; extra < at + 46 + nameLength + extraLength;)
        {
            const id = view.getUint16(extra, true);
            const length = view.getUint16(extra + 2, true);
            if (id === ZIP64_EXTRA)
            {
                let field = extra + 4;
                if (size === 0xffffffff)
                {
                    size = Number(view.getBigUint64(field, true));
                    field += 8;
                }
                if (packed === 0xffffffff)
                {
                    packed = Number(view.getBigUint64(field, true));
                    field += 8;
                }
                if (local === 0xffffffff)
                {
                    local = Number(view.getBigUint64(field, true));
                }
            }
            extra += 4 + length;
        }
        at += 46 + nameLength + extraLength + commentLength;

        const path = name.replace(/\//g, '\\').replace(/^\\+/, '');
        if (path.endsWith('\\'))
        {
            entries.push({ path: path.replace(/\\+$/, ''), bytes: null });
            continue;
        }
        if (flags & 1)
        {
            throw new Error(`${path} is encrypted`);
        }
        if (method !== STORED && method !== DEFLATED)
        {
            throw new Error(`${path} is packed with method ${method}, which is not read here`);
        }
        // The local header repeats the name and carries its own extra field,
        // whose length may differ from the central one's.
        const header = viewOf(await slice(blob, local, 30));
        if (header.getUint32(0, true) !== LOCAL_HEADER)
        {
            throw new Error(`${path}: no local header where the directory says`);
        }
        const dataAt = local + 30 + header.getUint16(26, true) + header.getUint16(28, true);
        const data = await slice(blob, dataAt, packed);
        const bytes = method === STORED ? data : await inflate(data, path);
        if (bytes.length !== size)
        {
            throw new Error(
                `${path} unpacked to ${bytes.length} bytes, not the ${size} it records`);
        }
        entries.push({ path, bytes });
        progress?.(index + 1, count);
    }
    return entries;
}

/**
 * The folder an archive holds a copied disc in, or null: a zip of a CD's
 * folder holds nothing at its root but that folder, and the disc's
 * autorun.inf inside it says the folder is the disc.
 *
 * @param {ArchiveEntry[]} entries
 * @returns {string | null}
 */
function copiedDiscFolder(entries){
    const tops = new Set(entries.map(entry=>entry.path.split('\\')[0]));
    if (tops.size !== 1 || entries.some(entry=>!entry.path.includes('\\') && entry.bytes))
    {
        return null;
    }
    const [folder] = tops;
    return entries.some(entry=>entry.bytes
        && entry.path.toLowerCase() === `${folder.toLowerCase()}\\autorun.inf`) ? folder : null;
}

/**
 * An archive's tree as the disc it stands in for, under a label made of its
 * file name -- the disc's own folder at the root, when the archive is of a
 * copied disc.
 *
 * @param {string} name  The archive's file name.
 * @param {ArchiveEntry[]} entries
 * @returns {{ name: string, disc: Uint8Array }}
 */
export function archiveDisc(name, entries){
    const folder = copiedDiscFolder(entries);
    /** @type {Record<string, Uint8Array | null>} */
    const files = {};
    for (const entry of entries)
    {
        if (folder === null)
        {
            files[entry.path] = entry.bytes;
        }
        else if (entry.path.length > folder.length + 1)
        {
            files[entry.path.slice(folder.length + 1)] = entry.bytes;
        }
    }
    const label = name.replace(/\.[^.]+$/, '').toUpperCase().replace(/[^A-Z0-9_]/g, '_')
        .slice(0, 32) || 'ARCHIVE';
    return { name, disc: buildIso({ files, label }) };
}
