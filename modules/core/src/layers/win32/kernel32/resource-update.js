/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * BeginUpdateResource, UpdateResource and EndUpdateResource: a program
 * rewriting the resources of an executable on the volume -- a setup stamping
 * its own copy, a tool writing an icon into the file it made.
 *
 * Begin reads the file and its resources (or none, when asked to drop them);
 * the file is not held open between the calls, as it is not on Windows. Each
 * update replaces, adds or deletes one resource in that list. End builds a new
 * resource section from the list and writes the file back:
 *
 * - The section the resource directory is in is reused, its resources from
 *   its start, and grown -- never shrunk -- to what they need. Sections after
 *   it move down by what it grew, in the file and in the image, and so do the
 *   data directories that point into them (kernel32's resource tests pin all
 *   three shapes: last section, directory at its end, a section after it).
 * - An image with no resource section gets a `.rsrc` section after the last
 *   one, when its headers have room for one more section header.
 * - Bytes past the last section -- a self-extractor's payload -- stay after it.
 * - SizeOfImage is the image's new end, and a non-zero checksum is made
 *   right for the new file; a zero one stays zero, as nothing checks it.
 *
 * The tree is written as a resource compiler writes one: the directories,
 * then the data entries, then the names, then the data, each level sorted
 * names first, then numbers, with a zero time stamp and version 4.0.
 */

import { parsePe, rvaToFileOffset } from '../../loader/internal/pe.js';
import { listResources } from '../../loader/internal/resources.js';

const ERROR_FILE_NOT_FOUND = 2;
const ERROR_ACCESS_DENIED = 5;
const ERROR_INVALID_HANDLE = 6;
const ERROR_INVALID_DATA = 13;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_BAD_EXE_FORMAT = 193;
const ERROR_FILE_INVALID = 1006;

/** The handle kind these three calls share. */
const UPDATE = 'resource-update';

const DIR_RESOURCE = 2;
/** IMAGE_DIRECTORY_ENTRY_SECURITY: a file offset where every other directory is an RVA. */
const DIR_SECURITY = 4;
const SECTION_HEADER = 40;
const HIGH_BIT = 0x80000000;
/** IMAGE_SCN_CNT_INITIALIZED_DATA | IMAGE_SCN_MEM_READ: what a resource section is. */
const RESOURCE_CHARACTERISTICS = 0x40000040;

/** A resource name or type, as read or as given: a number or an upper-case string. */
/**
 * FILEMUIINFO: its fixed part, and where the strings and lists it points at
 * start (abBuffer).
 */
const FILEMUIINFO_SIZE = 80;
const FILEMUIINFO_DATA = 72;
const MUI_FILEINFO_VERSION = 1;
const MUI_QUERY_CHECKSUM = 0x2;
const MUI_QUERY_LANGUAGE_NAME = 0x4;
const MUI_QUERY_RESOURCE_TYPES = 0x8;
const MUI_FILETYPE_NOT_LANGUAGE_NEUTRAL = 0x1;
const MUI_FILETYPE_LANGUAGE_NEUTRAL_MUI = 0x4;
/**
 * The MUI resource (type "MUI", name 1): a signature, its size, the file's
 * type (shifted down a bit), two checksums, then offset and size pairs for
 * the resource type lists and the language names, all from its start.
 */
const MUI_SIGNATURE = 0xfecdfecd;
const MUI_HEADER = 132;
const MUI = Object.freeze({ signature: 0, size: 4, fileType: 16, serviceChecksum: 28,
    checksum: 44, mainNames: 84, mainIds: 92, muiNames: 100, muiIds: 108, language: 116,
    fallbackLanguage: 124 });

/** @typedef {number | string} ResourceKey */

/**
 * @typedef {Object} Resource
 * @property {ResourceKey} type
 * @property {ResourceKey} name
 * @property {number} language
 * @property {Uint8Array} data
 */

/** @typedef {{ read?: boolean, write?: boolean, truncate?: boolean }} UpdateMode */

/**
 * The part of the volume an update reads and writes the image through, named
 * here rather than imported: files.js builds this module, so a type taken from
 * it would close an import cycle.
 *
 * @typedef {Object} UpdateVolume
 * @property {(path: string) => { isDirectory: boolean, size: number } | null} stat
 * @property {(path: string, mode: UpdateMode) => any} open
 * @property {(node: any, offset: number, length: number) => Uint8Array | Promise<Uint8Array>} read
 * @property {(node: any, offset: number, bytes: Uint8Array) => number} write
 * @property {(node: any) => void} close
 */

/**
 * @typedef {Object} ResourceUpdateHost
 * @property {UpdateVolume} files
 * @property {(name: string) => string} fullPath  What the guest wrote, as the volume's path.
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} readWideString
 *     `maxLength` in bytes.
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(code: number) => void} setLastError
 * @property {{ open: (type: string, object: any) => number,
 *     resolve: (handle: number, type?: string) => any,
 *     close: (handle: number) => any }} handles
 */

/** @param {number} value @param {number} unit */
const align = (value, unit)=>(unit > 1 ? Math.ceil(value / unit) * unit : value);

/** @param {ResourceKey} left @param {ResourceKey} right */
const sameKey = (left, right)=>(typeof left === 'string' && typeof right === 'string'
    ? left.toUpperCase() === right.toUpperCase()
    : left === right);

/**
 * Names before numbers, names in order of their upper-case spelling, numbers
 * ascending: the order a resource directory is searched in.
 *
 * @param {ResourceKey} left @param {ResourceKey} right
 */
const keyOrder = (left, right)=>{
    if (typeof left === 'string')
    {
        if (typeof right !== 'string')
        {
            return -1;
        }
        const [a, b] = [left.toUpperCase(), right.toUpperCase()];
        return a < b ? -1 : (a > b ? 1 : 0);
    }
    return typeof right === 'string' ? 1 : left - right;
};

/**
 * The keys of a list, each once, in directory order.
 *
 * @param {ResourceKey[]} keys
 */
const distinct = keys=>keys
    .filter((key, at)=>keys.findIndex(other=>sameKey(other, key)) === at)
    .sort(keyOrder);

/**
 * The resource section's bytes for a list of resources placed at `base`, the
 * RVA the section starts at -- which a data entry names its data by.
 *
 * @param {Resource[]} resources @param {number} base
 * @returns {Uint8Array}
 */
export function buildResourceSection(resources, base){
    const types = distinct(resources.map(resource=>resource.type));
    /** @type {{ type: ResourceKey, names: { name: ResourceKey, items: Resource[] }[] }[]} */
    const tree = types.map(type=>{
        const ofType = resources.filter(resource=>sameKey(resource.type, type));
        return {
            type,
            names: distinct(ofType.map(resource=>resource.name)).map(name=>({
                name,
                items: ofType.filter(resource=>sameKey(resource.name, name))
                    .sort((left, right)=>left.language - right.language),
            })),
        };
    });

    const directorySize = (/** @type {number} */ count)=>16 + count * 8;
    let cursor = directorySize(tree.length);
    const typeDirectories = tree.map(entry=>{
        const at = cursor;
        cursor += directorySize(entry.names.length);
        return at;
    });
    const nameDirectories = tree.map(entry=>entry.names.map(name=>{
        const at = cursor;
        cursor += directorySize(name.items.length);
        return at;
    }));
    const dataEntries = tree.map(entry=>entry.names.map(name=>name.items.map(()=>{
        const at = cursor;
        cursor += 16;
        return at;
    })));
    /** @type {Map<string, number>} */
    const strings = new Map();
    for (const key of [...types, ...tree.flatMap(entry=>entry.names.map(name=>name.name))])
    {
        if (typeof key === 'string' && !strings.has(key))
        {
            strings.set(key, cursor);
            cursor += 2 + key.length * 2;
        }
    }
    const dataAt = tree.map(entry=>entry.names.map(name=>name.items.map(item=>{
        cursor = align(cursor, 8);
        const at = cursor;
        cursor += item.data.length;
        return at;
    })));

    const bytes = new Uint8Array(align(cursor, 4));
    const view = new DataView(bytes.buffer);
    /** @param {number} at @param {ResourceKey[]} keys */
    const directory = (at, keys)=>{
        view.setUint16(at + 8, 4, true);
        view.setUint16(at + 12, keys.filter(key=>typeof key === 'string').length, true);
        view.setUint16(at + 14, keys.filter(key=>typeof key !== 'string').length, true);
    };
    /** @param {number} at @param {ResourceKey} key @param {number} target */
    const entryAt = (at, key, target)=>{
        view.setUint32(at, typeof key === 'string'
            ? (HIGH_BIT | /** @type {number} */ (strings.get(key))) >>> 0 : key, true);
        view.setUint32(at + 4, target >>> 0, true);
    };

    directory(0, types);
    tree.forEach((entry, t)=>{
        entryAt(16 + t * 8, entry.type, HIGH_BIT | typeDirectories[t]);
        directory(typeDirectories[t], entry.names.map(name=>name.name));
        entry.names.forEach((name, n)=>{
            entryAt(typeDirectories[t] + 16 + n * 8, name.name, HIGH_BIT | nameDirectories[t][n]);
            directory(nameDirectories[t][n], name.items.map(item=>item.language));
            name.items.forEach((item, l)=>{
                const leaf = dataEntries[t][n][l];
                entryAt(nameDirectories[t][n] + 16 + l * 8, item.language, leaf);
                view.setUint32(leaf, base + dataAt[t][n][l], true);
                view.setUint32(leaf + 4, item.data.length, true);
                bytes.set(item.data, dataAt[t][n][l]);
            });
        });
    });
    for (const [text, at] of strings)
    {
        view.setUint16(at, text.length, true);
        for (let i = 0; i < text.length; i++)
        {
            view.setUint16(at + 2 + i * 2, text.charCodeAt(i), true);
        }
    }
    return bytes;
}

/**
 * The resources an image carries, as a list to update.
 *
 * @param {Uint8Array} file @param {import('../../loader/internal/pe.js').PeImage} image
 * @returns {Resource[]}
 */
function readResources(file, image){
    return listResources(file, image).map(found=>{
        const at = rvaToFileOffset(image, found.rva);
        return {
            type: found.type,
            name: found.name,
            language: typeof found.language === 'number' ? found.language : 0,
            data: file.slice(at, at + found.size),
        };
    });
}

/**
 * The PE checksum: the file's 16-bit words summed with their carries folded
 * back in, the checksum field itself counted as zero, and the length added.
 *
 * @param {Uint8Array} file @param {number} field  Where the checksum is.
 */
export function peChecksum(file, field){
    let sum = 0;
    for (let at = 0; at < file.length; at += 2)
    {
        if (at === field || at === field + 2)
        {
            continue;
        }
        sum += file[at] | (at + 1 < file.length ? file[at + 1] << 8 : 0);
        sum = (sum & 0xffff) + (sum >>> 16);
    }
    sum = (sum & 0xffff) + (sum >>> 16);
    return (sum + file.length) >>> 0;
}

/**
 * The file with its resource section rebuilt from `resources`, or an error
 * code when the image has no room for one.
 *
 * @param {Uint8Array} file @param {Resource[]} resources
 * @returns {Uint8Array | number}
 */
export function rewriteResources(file, resources){
    const image = parsePe(file);
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const optional = view.getUint32(0x3c, true) + 24;
    const fileAlign = Math.max(view.getUint32(optional + 36, true), 1);
    const sectionAlign = Math.max(view.getUint32(optional + 32, true), 1);
    // SizeOfOptionalHeader is the COFF header's last word but one, just before it.
    const sectionTable = optional + view.getUint16(optional - 4, true);
    const sectionCount = image.sections.length;
    const directoryCount = view.getUint32(optional + 92, true);
    if (directoryCount <= DIR_RESOURCE)
    {
        return ERROR_BAD_EXE_FORMAT;
    }
    // A section whose PointerToRawData is 0 has no bytes in the file,
    // whatever its SizeOfRawData says: it is all zero when mapped.
    /** @param {{ rawOffset: number, rawSize: number }} section */
    const rawSizeOf = section=>(section.rawOffset === 0 ? 0 : section.rawSize);
    const rawEnd = Math.max(image.sizeOfHeaders, ...image.sections.map(section=>
        section.rawOffset + rawSizeOf(section)));
    const overlay = file.slice(Math.min(rawEnd, file.length));
    const directoryRva = image.directories[DIR_RESOURCE]?.address ?? 0;
    const holding = directoryRva === 0 ? -1 : image.sections.findIndex(section=>
        directoryRva >= section.virtualAddress && directoryRva
            < section.virtualAddress + Math.max(section.virtualSize, section.rawSize));

    if (holding < 0 && resources.length === 0)
    {
        const out = file.slice();
        const outView = new DataView(out.buffer);
        outView.setUint32(optional + 96 + DIR_RESOURCE * 8, 0, true);
        outView.setUint32(optional + 96 + DIR_RESOURCE * 8 + 4, 0, true);
        return finish(out, optional);
    }

    /** @type {{ header: number, va: number, vsize: number, raw: number, rawSize: number }[]} */
    const sections = image.sections.map((section, at)=>({
        header: sectionTable + at * SECTION_HEADER,
        va: section.virtualAddress, vsize: section.virtualSize,
        raw: section.rawOffset === 0 ? 0 : section.rawOffset, rawSize: rawSizeOf(section),
    }));
    let headerEnd = sectionTable + sectionCount * SECTION_HEADER;
    let target = holding;
    if (target < 0)
    {
        const firstRaw = Math.min(...sections.filter(section=>section.rawSize > 0)
            .map(section=>section.raw), image.sizeOfHeaders);
        if (headerEnd + SECTION_HEADER > firstRaw)
        {
            return ERROR_INVALID_DATA;
        }
        const vaEnd = Math.max(image.sizeOfHeaders,
            ...sections.map(section=>section.va + Math.max(section.vsize, section.rawSize)));
        sections.push({ header: headerEnd, va: align(vaEnd, sectionAlign), vsize: 0,
            raw: align(rawEnd, fileAlign), rawSize: 0 });
        headerEnd += SECTION_HEADER;
        target = sections.length - 1;
    }
    const resource = sections[target];
    if (resource.rawSize === 0)
    {
        // Bytes of its own, after everything that has some.
        resource.raw = align(rawEnd, fileAlign);
    }
    const body = buildResourceSection(resources, resource.va);
    const oldVirtual = align(Math.max(resource.vsize, resource.rawSize), sectionAlign);
    const rawSize = Math.max(resource.rawSize, align(body.length, fileAlign));
    const virtualSize = Math.max(resource.vsize, body.length);
    const shiftRaw = rawSize - resource.rawSize;
    const shiftVirtual = Math.max(0, align(Math.max(virtualSize, rawSize), sectionAlign)
        - oldVirtual);

    // Every section after the resource one, in the file and in the image.
    const after = sections.filter((section, at)=>at !== target
        && section.va > resource.va);
    const fileEnd = Math.max(headerEnd, ...sections.map((section, at)=>(at === target
        ? resource.raw + rawSize
        : section.raw + section.rawSize + (section.raw > resource.raw ? shiftRaw : 0))));
    const out = new Uint8Array(fileEnd + overlay.length);
    // The headers and whatever comes before the resource section; the old
    // section's own bytes are not kept, so what its new body leaves is zero.
    out.set(file.subarray(0, Math.min(file.length, resource.raw, rawEnd)));
    out.set(body, resource.raw);
    for (const section of sections)
    {
        if (section === resource || section.rawSize === 0)
        {
            continue;
        }
        const moved = section.raw > resource.raw ? section.raw + shiftRaw : section.raw;
        out.set(file.subarray(section.raw, section.raw + section.rawSize), moved);
    }
    out.set(overlay, fileEnd);

    const outView = new DataView(out.buffer);
    // The directories that point into a section that moved, moved with it --
    // and the certificates, the one directory that is a file offset, with
    // the bytes after the last section they are in.
    for (let at = 0; at < directoryCount; at++)
    {
        const slot = optional + 96 + at * 8;
        const address = outView.getUint32(slot, true);
        if (at === DIR_SECURITY)
        {
            if (address !== 0 && address >= rawEnd)
            {
                outView.setUint32(slot, address + fileEnd - rawEnd, true);
            }
        }
        else if (at !== DIR_RESOURCE && address !== 0 && after.some(section=>address
            >= section.va && address < section.va + Math.max(section.vsize, section.rawSize)))
        {
            outView.setUint32(slot, address + shiftVirtual, true);
        }
    }
    for (const section of after)
    {
        section.va += shiftVirtual;
    }
    for (const section of sections)
    {
        if (section !== resource && section.raw > resource.raw && section.rawSize > 0)
        {
            section.raw += shiftRaw;
        }
        outView.setUint32(section.header + 12, section.va, true);
        outView.setUint32(section.header + 20, section.raw, true);
    }
    if (holding < 0)
    {
        out.set([0x2e, 0x72, 0x73, 0x72, 0x63, 0, 0, 0], resource.header);
        outView.setUint32(resource.header + 36, RESOURCE_CHARACTERISTICS, true);
        outView.setUint16(optional - 20 + 2, sections.length, true);
    }
    outView.setUint32(resource.header + 8, virtualSize, true);
    outView.setUint32(resource.header + 16, rawSize, true);
    outView.setUint32(optional + 96 + DIR_RESOURCE * 8, resource.va, true);
    outView.setUint32(optional + 96 + DIR_RESOURCE * 8 + 4, body.length, true);
    outView.setUint32(optional + 56, align(Math.max(image.sizeOfHeaders, ...sections.map(
        section=>section.va + Math.max(outView.getUint32(section.header + 8, true),
            outView.getUint32(section.header + 16, true)))), sectionAlign), true);
    return finish(out, optional);
}

/**
 * A non-zero checksum made right for the bytes as they now are.
 *
 * @param {Uint8Array} out @param {number} optional
 */
function finish(out, optional){
    const view = new DataView(out.buffer);
    if (view.getUint32(optional + 64, true) !== 0)
    {
        view.setUint32(optional + 64, peChecksum(out, optional + 64), true);
    }
    return out;
}

/**
 * @param {ResourceUpdateHost} host
 */
export function createResourceUpdates(host){
    /** @param {number} code @param {number} [answer] */
    const fail = (code, answer = 0)=>{
        host.setLastError(code);
        return answer;
    };

    /**
     * The whole file, or null with the last error set; a promise when its
     * bytes are not here yet.
     *
     * @param {string} path
     * @returns {Uint8Array | null | Promise<Uint8Array | null>}
     */
    const readWhole = path=>{
        const entry = host.files.stat(path);
        const node = entry && !entry.isDirectory ? host.files.open(path, { read: true }) : null;
        if (!entry || !node)
        {
            host.setLastError(entry ? ERROR_ACCESS_DENIED : ERROR_FILE_NOT_FOUND);
            return null;
        }
        const read = host.files.read(node, 0, entry.size);
        /** @param {Uint8Array} bytes */
        const done = bytes=>{
            host.files.close(node);
            return bytes;
        };
        return read instanceof Promise ? read.then(done) : done(read);
    };

    /**
     * A type or name argument: an integer resource, a "#123" string, or a
     * name, kept in upper case as the resource compiler keeps it.
     *
     * @param {number} pointer @param {boolean} wide
     * @returns {ResourceKey}
     */
    const keyOf = (pointer, wide)=>{
        if ((pointer >>> 0) < 0x10000)
        {
            return pointer & 0xffff;
        }
        const text = wide ? host.readWideString(pointer >>> 0, 0x10000)
            : host.readCString(pointer >>> 0, 0x8000);
        return /^#\d+$/.test(text) ? Number(text.slice(1)) & 0xffff : text.toUpperCase();
    };

    /** @param {boolean} wide */
    const begin = wide=>({
        argBytes: 8,
        /** @param {number[]} args */
        handler: ([name, dropExisting])=>{
            if ((name >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const path = host.fullPath(wide ? host.readWideString(name >>> 0, 0x10000)
                : host.readCString(name >>> 0, 0x8000));
            /** @param {Uint8Array | null} file */
            const open = file=>{
                if (file === null)
                {
                    return 0;
                }
                if (file.length === 0)
                {
                    return fail(ERROR_FILE_INVALID);
                }
                /** @type {Resource[]} */
                let resources;
                try
                {
                    const image = parsePe(file);
                    resources = (dropExisting >>> 0) !== 0 ? [] : readResources(file, image);
                }
                catch (e){
                    void e;
                    return fail(ERROR_BAD_EXE_FORMAT);
                }
                return host.handles.open(UPDATE, { path, resources });
            };
            const file = readWhole(path);
            return file instanceof Promise ? file.then(open) : open(file);
        },
    });

    /** @param {boolean} wide */
    const update = wide=>({
        argBytes: 24,
        /** @param {number[]} args */
        handler: ([handle, type, name, language, data, size])=>{
            const state = resolve(handle);
            if (!state)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            if ((data >>> 0) === 0 && (size >>> 0) !== 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const wanted = { type: keyOf(type, wide), name: keyOf(name, wide),
                language: language & 0xffff };
            /** @type {Resource[]} */
            const kept = state.resources.filter((/** @type {Resource} */ resource)=>
                !(sameKey(resource.type, wanted.type) && sameKey(resource.name, wanted.name)
                    && resource.language === wanted.language));
            if ((data >>> 0) !== 0)
            {
                kept.push({ ...wanted,
                    data: host.readMemory(data >>> 0, size >>> 0).slice() });
            }
            state.resources = kept;
            return 1;
        },
    });

    /** @param {number} handle */
    const resolve = handle=>{
        try
        {
            return host.handles.resolve(handle >>> 0, UPDATE) ?? null;
        }
        catch (e){
            void e;
            return null;
        }
    };

    const end = {
        argBytes: 8,
        /** @param {number[]} args */
        handler: (/** @type {number[]} */ [handle, discard])=>{
            const state = resolve(handle);
            if (!state)
            {
                return fail(ERROR_INVALID_HANDLE);
            }
            host.handles.close(handle >>> 0);
            if ((discard >>> 0) !== 0)
            {
                return 1;
            }
            /** @param {Uint8Array | null} file */
            const write = file=>{
                if (file === null)
                {
                    return 0;
                }
                /** @type {Uint8Array | number} */
                let rewritten;
                try
                {
                    rewritten = rewriteResources(file, state.resources);
                }
                catch (e){
                    void e;
                    return fail(ERROR_BAD_EXE_FORMAT);
                }
                if (typeof rewritten === 'number')
                {
                    return fail(rewritten);
                }
                const node = host.files.open(state.path, { write: true, truncate: true });
                if (!node)
                {
                    return fail(ERROR_ACCESS_DENIED);
                }
                host.files.write(node, 0, rewritten);
                host.files.close(node);
                return 1;
            };
            // Read again rather than kept from Begin: the file is the
            // program's between the two calls, as it is on Windows.
            const file = readWhole(state.path);
            return file instanceof Promise ? file.then(write) : write(file);
        },
    };

    /**
     * The FILEMUIINFO an image's MUI resource makes, from abBuffer on: the
     * language name, then the main file's type IDs and names, then the MUI
     * file's, as `flags` asks. A language-neutral main file names its
     * fallback language; a MUI file's first type lists are its own.
     *
     * @param {Uint8Array | null} resource @param {number} flags
     * @returns {{ type: number, checksums: Uint8Array | null, fields: number[],
     *     data: Uint8Array } | 'bad format'}
     */
    const muiInfoOf = (resource, flags)=>{
        const none = { type: MUI_FILETYPE_NOT_LANGUAGE_NEUTRAL, checksums: null,
            fields: [0, 0, 0, 0, 0, 0, 0], data: new Uint8Array(0) };
        if (resource === null)
        {
            return none;
        }
        const view = new DataView(resource.buffer, resource.byteOffset, resource.length);
        if (resource.length < MUI_HEADER || view.getUint32(MUI.signature, true) !== MUI_SIGNATURE
            || view.getUint32(MUI.size, true) > resource.length)
        {
            return 'bad format';
        }
        const type = view.getUint32(MUI.fileType, true) << 1;
        /** @param {number} at */
        const piece = at=>{
            const offset = view.getUint32(at, true);
            const size = view.getUint32(at + 4, true);
            return size === 0 || offset + size > resource.length
                ? new Uint8Array(0) : resource.subarray(offset, offset + size);
        };
        /** @type {Uint8Array[]} */
        const parts = [];
        let at = FILEMUIINFO_DATA;
        /** @param {Uint8Array} bytes */
        const place = bytes=>{
            if (bytes.length === 0)
            {
                return 0;
            }
            parts.push(bytes);
            const offset = at;
            at += bytes.length;
            return offset;
        };
        const fields = [0, 0, 0, 0, 0, 0, 0];
        if ((flags & MUI_QUERY_LANGUAGE_NAME) !== 0)
        {
            const own = piece(MUI.language);
            fields[0] = place(own.length > 0 ? own : piece(MUI.fallbackLanguage));
        }
        if ((flags & MUI_QUERY_RESOURCE_TYPES) !== 0)
        {
            const mui = type === MUI_FILETYPE_LANGUAGE_NEUTRAL_MUI;
            const empty = new Uint8Array(0);
            const own = [piece(MUI.mainIds), piece(MUI.mainNames)];
            const lists = mui ? [[empty, empty], own]
                : [own, [piece(MUI.muiIds), piece(MUI.muiNames)]];
            lists.forEach(([ids, names], index)=>{
                fields[1 + index * 3] = ids.length / 4;
                fields[2 + index * 3] = place(ids);
                fields[3 + index * 3] = place(names);
            });
        }
        const data = new Uint8Array(at - FILEMUIINFO_DATA);
        let offset = 0;
        for (const part of parts)
        {
            data.set(part, offset);
            offset += part.length;
        }
        // pChecksum, then pServiceChecksum, as FILEMUIINFO holds them.
        const checksums = (flags & MUI_QUERY_CHECKSUM) === 0 ? null
            : Uint8Array.from([...resource.subarray(MUI.checksum, MUI.checksum + 16),
                ...resource.subarray(MUI.serviceChecksum, MUI.serviceChecksum + 16)]);
        return { type, fields, data, checksums };
    };

    /**
     * BOOL GetFileMUIInfo(DWORD dwFlags, PCWSTR pcwszFilePath,
     *     PFILEMUIINFO pFileMUIInfo, DWORD *pcbFileMUIInfo)
     *
     * The file's type is given whatever the flags ask, as Windows gives it.
     * Asked with no structure, it says the size the answer takes, and is
     * refused with ERROR_INSUFFICIENT_BUFFER when that holds more than the
     * fixed part. A structure must say MUI_FILEINFO_VERSION.
     */
    const getFileMuiInfo = {
        argBytes: 16,
        /** @param {number[]} args */
        handler: ([flags, name, info, sizeAt])=>{
            if ((name >>> 0) === 0 || (sizeAt >>> 0) === 0)
            {
                return fail(ERROR_INVALID_PARAMETER);
            }
            const read32 = (/** @type {number} */ address)=>new DataView(
                host.readMemory(address, 4).slice().buffer).getUint32(0, true);
            const write32 = (/** @type {number} */ address, /** @type {number} */ value)=>{
                const bytes = new Uint8Array(4);
                new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
                host.writeMemory(address, bytes);
            };
            const path = host.fullPath(host.readWideString(name >>> 0, 0x10000));
            /** @param {Uint8Array | null} file */
            const answer = file=>{
                if (file === null)
                {
                    return 0;
                }
                /** @type {Uint8Array | null} */
                let resource;
                try
                {
                    const image = parsePe(file);
                    resource = readResources(file, image).find(found=>found.type === 'MUI'
                        && found.name === 1)?.data ?? null;
                }
                catch (e){
                    void e;
                    return fail(ERROR_BAD_EXE_FORMAT);
                }
                const known = muiInfoOf(resource, flags >>> 0);
                if (known === 'bad format')
                {
                    return fail(ERROR_BAD_EXE_FORMAT);
                }
                const needed = Math.max(FILEMUIINFO_SIZE, FILEMUIINFO_DATA + known.data.length);
                if ((info >>> 0) === 0)
                {
                    write32(sizeAt >>> 0, needed);
                    return known.data.length === 0 ? 1 : fail(ERROR_INSUFFICIENT_BUFFER);
                }
                if (read32((info >>> 0) + 4) !== MUI_FILEINFO_VERSION)
                {
                    write32(sizeAt >>> 0, 0);
                    return fail(ERROR_INVALID_PARAMETER);
                }
                if (read32(sizeAt >>> 0) < needed)
                {
                    write32(sizeAt >>> 0, needed);
                    return fail(ERROR_INSUFFICIENT_BUFFER);
                }
                const out = new Uint8Array(needed - 8);
                const view = new DataView(out.buffer);
                view.setUint32(0, known.type, true);
                if (known.checksums)
                {
                    out.set(known.checksums, 4);
                }
                known.fields.forEach((value, index)=>view.setUint32(36 + index * 4, value, true));
                out.set(known.data, FILEMUIINFO_DATA - 8);
                host.writeMemory((info >>> 0) + 8, out);
                write32(sizeAt >>> 0, needed);
                return 1;
            };
            const file = readWhole(path);
            return file instanceof Promise ? file.then(answer) : answer(file);
        },
    };

    return {
        GetFileMUIInfo: getFileMuiInfo,

        /**
         * HANDLE BeginUpdateResourceA/W(LPCSTR pFileName, BOOL bDeleteExistingResources)
         * BOOL UpdateResourceA/W(HANDLE hUpdate, LPCSTR lpType, LPCSTR lpName,
         *     WORD wLanguage, LPVOID lpData, DWORD cb)
         * BOOL EndUpdateResourceA/W(HANDLE hUpdate, BOOL fDiscard)
         *
         * A missing file is ERROR_FILE_NOT_FOUND, an empty one
         * ERROR_FILE_INVALID and anything else that is not a 32-bit image
         * ERROR_BAD_EXE_FORMAT. An update with no data deletes the resource
         * of that type, name and language.
         */
        BeginUpdateResourceA: begin(false),
        BeginUpdateResourceW: begin(true),
        UpdateResourceA: update(false),
        UpdateResourceW: update(true),
        EndUpdateResourceA: end,
        EndUpdateResourceW: end,
    };
}
