/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The icons a file on the volume carries, as ExtractIcon reads them: the
 * icon groups of an executable or a library, or the one icon of an .ico file.
 *
 * The file is not loaded. An installer asks this of its own image, which may
 * carry its whole payload behind the headers, so only the headers, the
 * resource directory and the two blocks of the icon chosen are read -- and
 * any of those reads may wait for bytes still on their way, which is why the
 * walk is a sequence of reads rather than one function over a whole file.
 *
 * An icon group is chosen by position in the resource directory, which is
 * the order the names are enumerated in, or by its resource id; within a
 * group the image of the standard icon size is chosen the way LoadIcon
 * chooses it (`../user32/cursors.js`), so that a program's icon looks the
 * same however it was fetched.
 */

import { parsePe, rvaToFileOffset } from '../../loader/internal/pe.js';
import { findResource, listResources } from '../../loader/internal/resources.js';
import { dibToBgra, groupImageId } from '../user32/cursors.js';

const RT_ICON = 3;
const RT_GROUP_ICON = 14;
const DIR_RESOURCE = 2;

/**
 * SM_CXICON: the size ExtractIcon's icon is, and so the image it picks. A
 * group with no image that size gives its first, at the size it has.
 */
const ICON_SIZE = 32;

/** Enough of a file for its DOS header, the PE headers and a few sections. */
const HEAD_BYTES = 0x1000;

/** The parts of an icon directory and a group directory, which differ in the last field. */
const ICONDIR_HEADER = 6;
const ICONDIR_ENTRY = 16;
const GROUP_ENTRY = 14;

/** The most entries an icon file's directory is read for. */
const MAX_ICON_ENTRIES = 0x100;

/** The PE signature, and the one a 16-bit image carries in its place. */
const PE_SIGNATURE = 0x00004550;
const NE_SIGNATURE = 0x454e;
const PE32_PLUS = 0x20b;

/**
 * @typedef {Object} IconVolume
 * @property {(path: string) => { exists: boolean, isDirectory: boolean, size: number }
 *            | null} stat
 * @property {(path: string, mode: any) => any} open
 * @property {(node: any, offset: number, length: number) =>
 *            Uint8Array | Promise<Uint8Array>} read
 * @property {(node: any) => void} close
 */

/**
 * @typedef {Object} FileIcons
 * @property {number} count  How many icons the file offers: its icon groups,
 *           or one for an icon file, or none.
 * @property {import('../user32/cursors.js').CursorPicture | null} picture
 *           The icon asked for, or null for none -- an index past the count,
 *           a group with no image this can read, or a count-only question.
 * @property {string | null} unread  What kind of image the file is when it is
 *           one whose icons are not read here, for the caller to report.
 * @property {number | null} [id]  The resource id of the icon group read,
 *           when it has a numeric one: what ExtractAssociatedIconEx reports.
 */

/** @type {FileIcons} */
const NONE = Object.freeze({ count: 0, picture: null, unread: null });

/** @param {Uint8Array} bytes @param {number} at */
const u16 = (bytes, at)=>(at + 2 <= bytes.length ? bytes[at] | bytes[at + 1] << 8 : 0);

/** @param {Uint8Array} bytes @param {number} at */
const u32 = (bytes, at)=>(at + 4 <= bytes.length
    ? (bytes[at] | bytes[at + 1] << 8 | bytes[at + 2] << 16 | bytes[at + 3] << 24) >>> 0 : 0);

/**
 * The picture of one icon image: its DIB, its hot spot the centre as every
 * icon's is. Null for an image this cannot read (a PNG-compressed one).
 *
 * @param {Uint8Array} bits
 * @returns {import('../user32/cursors.js').CursorPicture | null}
 */
const pictureOf = bits=>{
    const picture = dibToBgra(bits);
    return picture
        ? { ...picture, hotSpot: { x: picture.width >>> 1, y: picture.height >>> 1 } }
        : null;
};

/**
 * The steps of reading an icon file: its directory, read as a group
 * directory whose ids are the entries' positions from one, so that the
 * image is chosen by the same rule as an executable's.
 *
 * @param {(offset: number, length: number) => Uint8Array | Promise<Uint8Array>} read
 * @param {Uint8Array} head  The file's first bytes.
 * @param {number} index
 * @param {number} side  The icon size whose image is chosen.
 * @returns {Generator<Uint8Array | Promise<Uint8Array>, FileIcons, Uint8Array>}
 */
function* iconFileSteps(read, head, index, side){
    const entries = Math.min(u16(head, 4), MAX_ICON_ENTRIES);
    const directory = ICONDIR_HEADER + entries * ICONDIR_ENTRY > head.length
        ? yield read(0, ICONDIR_HEADER + entries * ICONDIR_ENTRY) : head;
    const count = Math.min(entries,
        Math.floor((directory.length - ICONDIR_HEADER) / ICONDIR_ENTRY));
    if (count === 0)
    {
        return NONE;
    }
    // The count is one whatever the file holds: the images in it are one
    // icon at its several sizes.
    if (index !== 0)
    {
        return { count: 1, picture: null, unread: null };
    }
    const group = new Uint8Array(ICONDIR_HEADER + count * GROUP_ENTRY);
    group.set(directory.subarray(0, ICONDIR_HEADER));
    for (let entry = 0; entry < count; entry++)
    {
        const to = ICONDIR_HEADER + entry * GROUP_ENTRY;
        group.set(directory.subarray(ICONDIR_HEADER + entry * ICONDIR_ENTRY,
            ICONDIR_HEADER + entry * ICONDIR_ENTRY + 12), to);
        group[to + 12] = (entry + 1) & 0xff;
        group[to + 13] = (entry + 1) >>> 8;
    }
    const chosen = /** @type {number} */ (groupImageId(group, false, side)) - 1;
    const at = ICONDIR_HEADER + chosen * ICONDIR_ENTRY;
    const bits = yield read(u32(directory, at + 12), u32(directory, at + 8));
    return { count: 1, picture: pictureOf(bits), unread: null, id: null };
}

/**
 * The steps of reading an executable's icons: the headers, as far as the
 * section table, then the resource directory alone, as a section of its own
 * starting at its first byte -- every offset the walk follows is inside it,
 * and a leaf it ends at names its block's place in the file.
 *
 * @param {(offset: number, length: number) => Uint8Array | Promise<Uint8Array>} read
 * @param {Uint8Array} head  The file's first bytes.
 * @param {number} size  The file's length.
 * @param {number} index
 * @param {number} side  The icon size whose image is chosen.
 * @returns {Generator<Uint8Array | Promise<Uint8Array>, FileIcons, Uint8Array>}
 */
function* imageSteps(read, head, size, index, side){
    let headers = head;
    const peOffset = u32(headers, 0x3c);
    if (peOffset + 24 > headers.length && headers.length < size)
    {
        headers = yield read(0, peOffset + HEAD_BYTES);
    }
    if (u32(headers, peOffset) !== PE_SIGNATURE)
    {
        // A DOS program has no resources; a 16-bit Windows one keeps its
        // icons in a resource table of another form, not read here.
        return u16(headers, peOffset) === NE_SIGNATURE
            ? { ...NONE, unread: 'a 16-bit image' } : NONE;
    }
    if (u16(headers, peOffset + 24) === PE32_PLUS)
    {
        return { ...NONE, unread: 'a 64-bit image' };
    }
    const end = peOffset + 24 + u16(headers, peOffset + 20) + u16(headers, peOffset + 6) * 40;
    if (end > headers.length && headers.length < size)
    {
        headers = yield read(0, end);
    }
    const image = parsePe(headers);
    const directory = image.directories[DIR_RESOURCE];
    if (!directory || directory.size === 0)
    {
        return NONE;
    }
    const tree = yield read(rvaToFileOffset(image, directory.address), directory.size);
    const local = {
        ...image,
        sizeOfHeaders: 0,
        sections: [{ name: '.rsrc', virtualAddress: directory.address,
            virtualSize: directory.size, rawSize: directory.size, rawOffset: 0,
            readable: true, writable: false, executable: false }],
    };
    // A group in several languages is one group.
    const groups = [...new Set(listResources(tree, local)
        .filter(resource=>resource.type === RT_GROUP_ICON)
        .map(resource=>resource.name))];
    const count = groups.length;
    if (index === -1)
    {
        return { count, picture: null, unread: null };
    }
    // Below -1 the index is a resource id, negated.
    const name = index >= 0 ? groups[index] : -index;
    const group = name === undefined ? null : findResource(tree, local, RT_GROUP_ICON, name);
    if (!group)
    {
        return { count, picture: null, unread: null };
    }
    const entries = yield read(rvaToFileOffset(image, group.rva), group.size);
    const id = groupImageId(entries, false, side);
    const icon = id === null ? null : findResource(tree, local, RT_ICON, id);
    if (!icon)
    {
        return { count, picture: null, unread: null };
    }
    const bits = yield read(rvaToFileOffset(image, icon.rva), icon.size);
    return { count, picture: pictureOf(bits), unread: null,
        id: typeof name === 'number' ? name : null };
}

/**
 * @param {(offset: number, length: number) => Uint8Array | Promise<Uint8Array>} read
 * @param {number} size @param {number} index
 * @param {number} side  The icon size whose image is chosen.
 * @returns {Generator<Uint8Array | Promise<Uint8Array>, FileIcons, Uint8Array>}
 */
function* fileSteps(read, size, index, side){
    const head = yield read(0, HEAD_BYTES);
    if (u16(head, 0) === 0 && u16(head, 2) === 1)
    {
        return yield* iconFileSteps(read, head, index, side);
    }
    if (u16(head, 0) === 0x5a4d)
    {
        return yield* imageSteps(read, head, size, index, side);
    }
    return NONE;
}

/**
 * Runs the steps straight through while every block they ask for is here,
 * and as a promise from the first that is not. A read or a parse that fails
 * is a file with no icons.
 *
 * @param {Generator<Uint8Array | Promise<Uint8Array>, FileIcons, Uint8Array>} steps
 * @returns {FileIcons | Promise<FileIcons>}
 */
function drive(steps){
    /**
     * @param {() => IteratorResult<Uint8Array | Promise<Uint8Array>, FileIcons>} next
     * @returns {FileIcons | Promise<FileIcons>}
     */
    const resume = next=>{
        let step;
        try
        {
            step = next();
        }
        catch {
            return NONE;
        }
        while (!step.done)
        {
            const value = step.value;
            if (value instanceof Promise)
            {
                return value.then(bytes=>resume(()=>steps.next(bytes)),
                    error=>resume(()=>steps.throw(error)));
            }
            try
            {
                step = steps.next(value);
            }
            catch {
                return NONE;
            }
        }
        return step.value;
    };
    return resume(()=>steps.next());
}

/**
 * The icons of a file, and the one at an index: -1 asks only how many there
 * are, an index from zero is a position in the file, and one below -1 a
 * resource id. A file that is not there, or is neither an image nor an icon
 * file, has none.
 *
 * @param {IconVolume} volume @param {string} path @param {number} index
 * @param {number} [side]  The icon size wanted: SM_CXICON's 32 unless asked for
 *     another, as ExtractIconEx asks for SM_CXSMICON's 16 beside it.
 * @returns {FileIcons | Promise<FileIcons>}
 */
export function readFileIcons(volume, path, index, side = ICON_SIZE){
    const entry = volume.stat(path);
    if (!entry?.exists || entry.isDirectory)
    {
        return NONE;
    }
    const node = volume.open(path, { read: true });
    if (!node)
    {
        return NONE;
    }
    const size = entry.size;
    /** @param {number} offset @param {number} length */
    const read = (offset, length)=>volume.read(node, offset,
        Math.max(0, Math.min(length, size - offset)));
    const found = drive(fileSteps(read, size, index, side));
    if (found instanceof Promise)
    {
        return found.finally(()=>volume.close(node));
    }
    volume.close(node);
    return found;
}

/** The eight bytes every PNG starts with: a Vista-era icon image stored as one. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * @typedef {Object} ProgramIcon
 * @property {number} width
 * @property {number} height
 * @property {Uint8ClampedArray} [rgba]  The pixels, for an image stored as a DIB.
 * @property {Uint8Array} [png]  The file, for an image stored as a PNG.
 */

/**
 * A program's own icon, for a page to show it by: the first icon group of
 * the image, as Explorer shows the file, at the largest size the group has
 * (the deepest where two are as large). Null for an image with no icon, one
 * whose icon cannot be read, or bytes that are not a 32-bit image.
 *
 * @param {Uint8Array} bytes  The whole file.
 * @returns {ProgramIcon | null}
 */
export function programIcon(bytes){
    try
    {
        const image = parsePe(bytes);
        const group = listResources(bytes, image).find(resource=>resource.type === RT_GROUP_ICON);
        if (!group)
        {
            return null;
        }
        const at = rvaToFileOffset(image, group.rva);
        const entries = bytes.subarray(at, at + group.size);
        const count = Math.min(u16(entries, 4),
            Math.floor((entries.length - ICONDIR_HEADER) / GROUP_ENTRY));
        let best = null;
        for (let index = 0; index < count; index++)
        {
            const entry = ICONDIR_HEADER + index * GROUP_ENTRY;
            // A BYTE of width, where 0 means 256.
            const width = entries[entry] || 256;
            const depth = u16(entries, entry + 6);
            if (!best || width > best.width || (width === best.width && depth > best.depth))
            {
                best = { width, depth, id: u16(entries, entry + 12) };
            }
        }
        const icon = best && findResource(bytes, image, RT_ICON, best.id);
        if (!icon)
        {
            return null;
        }
        const from = rvaToFileOffset(image, icon.rva);
        const bits = bytes.subarray(from, from + icon.size);
        if (PNG_SIGNATURE.every((byte, index)=>bits[index] === byte))
        {
            // The PNG's own header says its size: the width and height at 16 and 20.
            const height = (bits[20] << 24 | bits[21] << 16 | bits[22] << 8 | bits[23]) >>> 0;
            const width = (bits[16] << 24 | bits[17] << 16 | bits[18] << 8 | bits[19]) >>> 0;
            return { width, height, png: bits.slice() };
        }
        const picture = dibToBgra(bits);
        if (!picture)
        {
            return null;
        }
        const rgba = new Uint8ClampedArray(picture.bgra.length);
        for (let pixel = 0; pixel < rgba.length; pixel += 4)
        {
            rgba[pixel] = picture.bgra[pixel + 2];
            rgba[pixel + 1] = picture.bgra[pixel + 1];
            rgba[pixel + 2] = picture.bgra[pixel];
            rgba[pixel + 3] = picture.bgra[pixel + 3];
        }
        return { width: picture.width, height: picture.height, rgba };
    }
    catch {
        return null;
    }
}
