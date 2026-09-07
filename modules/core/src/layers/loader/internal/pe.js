/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * PE32 parsing: headers, sections, imports, base relocations.
 *
 * Pure functions over a byte array — nothing here touches guest memory. Mapping
 * an image is a separate step (image.js) so the parsing can be tested against a
 * real executable without an emulator.
 */

const DOS_MAGIC = 0x5a4d; // "MZ"
const PE_SIGNATURE = 0x00004550; // "PE\0\0"
const MACHINE_I386 = 0x014c;
const PE32_MAGIC = 0x010b;

/** Data directory indices we care about. */
export const DIR_EXPORT = 0;
export const DIR_IMPORT = 1;
export const DIR_BASERELOC = 5;

/** Section characteristics. */
const SECTION_MEM_EXECUTE = 0x20000000;
const SECTION_MEM_READ = 0x40000000;
const SECTION_MEM_WRITE = 0x80000000;

/**
 * @typedef {Object} PeSection
 * @property {string} name
 * @property {number} virtualAddress  RVA the section is mapped at.
 * @property {number} virtualSize     Size once mapped; the tail beyond rawSize is zero-filled.
 * @property {number} rawOffset       File offset of its bytes.
 * @property {number} rawSize
 * @property {boolean} readable
 * @property {boolean} writable
 * @property {boolean} executable
 */

/**
 * @typedef {Object} PeImage
 * @property {number} imageBase        Preferred load address.
 * @property {number} entryPointRva
 * @property {number} sizeOfImage
 * @property {number} sectionAlignment
 * @property {number} sizeOfHeaders
 * @property {number} subsystem
 * @property {number} stackReserve     How much stack the program was linked to expect.
 * @property {number} stackCommit
 * @property {boolean} relocatable     False when the image has no relocation directory.
 * @property {PeSection[]} sections
 * @property {{ address: number, size: number }[]} directories
 */

/**
 * Parses the headers of a 32-bit PE image.
 *
 * @param {Uint8Array} bytes
 * @returns {PeImage}
 */
export function parsePe(bytes){
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (bytes.length < 0x40 || view.getUint16(0, true) !== DOS_MAGIC)
    {
        throw new Error('not a PE image: missing MZ signature');
    }
    const peOffset = view.getUint32(0x3c, true);
    if (peOffset + 0xf8 > bytes.length || view.getUint32(peOffset, true) !== PE_SIGNATURE)
    {
        throw new Error('not a PE image: missing PE signature');
    }

    const coff = peOffset + 4;
    const machine = view.getUint16(coff, true);
    if (machine !== MACHINE_I386)
    {
        throw new Error(`unsupported machine 0x${machine.toString(16)}: only i386 is supported`);
    }
    const sectionCount = view.getUint16(coff + 2, true);
    const optionalSize = view.getUint16(coff + 16, true);

    const optional = coff + 20;
    if (view.getUint16(optional, true) !== PE32_MAGIC)
    {
        throw new Error('unsupported image: only PE32 (32-bit) is supported');
    }

    const directoryCount = view.getUint32(optional + 92, true);
    /** @type {{ address: number, size: number }[]} */
    const directories = [];
    for (let i = 0; i < directoryCount; i++)
    {
        const at = optional + 96 + i * 8;
        directories.push({ address: view.getUint32(at, true), size: view.getUint32(at + 4, true) });
    }

    /** @type {PeSection[]} */
    const sections = [];
    const sectionTable = optional + optionalSize;
    for (let i = 0; i < sectionCount; i++)
    {
        const at = sectionTable + i * 40;
        const characteristics = view.getUint32(at + 36, true);
        sections.push({
            name: new TextDecoder().decode(bytes.subarray(at, at + 8)).replace(/\0+$/, ''),
            virtualSize: view.getUint32(at + 8, true),
            virtualAddress: view.getUint32(at + 12, true),
            rawSize: view.getUint32(at + 16, true),
            rawOffset: view.getUint32(at + 20, true),
            readable: (characteristics & SECTION_MEM_READ) !== 0,
            writable: (characteristics & SECTION_MEM_WRITE) !== 0,
            executable: (characteristics & SECTION_MEM_EXECUTE) !== 0,
        });
    }

    const relocDirectory = directories[DIR_BASERELOC];
    return {
        imageBase: view.getUint32(optional + 28, true),
        entryPointRva: view.getUint32(optional + 16, true),
        sizeOfImage: view.getUint32(optional + 56, true),
        sectionAlignment: view.getUint32(optional + 32, true),
        sizeOfHeaders: view.getUint32(optional + 60, true),
        subsystem: view.getUint16(optional + 68, true),
        // What the linker reserved for the first thread. Not advice: a program
        // built against a megabyte will use a megabyte, and giving it less
        // fails as a read below the mapped stack rather than as a stack
        // overflow, somewhere unrelated to the code that asked for the space.
        stackReserve: view.getUint32(optional + 72, true),
        stackCommit: view.getUint32(optional + 76, true),
        // Plenty of pre-2000 executables ship without a relocation directory and
        // simply cannot be moved: every absolute address in them assumes ImageBase.
        relocatable: relocDirectory !== undefined && relocDirectory.size > 0,
        sections,
        directories,
    };
}

/**
 * @typedef {Object} ImportEntry
 * @property {string | null} name  Null when imported by ordinal.
 * @property {number | null} ordinal
 * @property {number} iatRva       Where the resolved address must be written.
 */

/**
 * @typedef {Object} ImportedDll
 * @property {string} dll
 * @property {ImportEntry[]} entries
 */

/**
 * Reads the import directory.
 *
 * The lookup table (ILT) describes what is imported; the address table (IAT) is
 * where the loader writes the resolved addresses. They start out identical, so
 * an image whose ILT is absent — some linkers omit it — is read through its IAT
 * instead, before anything has overwritten it.
 *
 * @param {Uint8Array} bytes  The raw file (not the mapped image).
 * @param {PeImage} image
 * @returns {ImportedDll[]}
 */
export function readImports(bytes, image){
    const directory = image.directories[DIR_IMPORT];
    if (!directory || directory.size === 0)
    {
        return [];
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fileOffset = (/** @type {number} */ rva)=>rvaToFileOffset(image, rva);

    /** @type {ImportedDll[]} */
    const result = [];
    for (let descriptor = fileOffset(directory.address); ; descriptor += 20)
    {
        const iltRva = view.getUint32(descriptor, true);
        const nameRva = view.getUint32(descriptor + 12, true);
        const iatRva = view.getUint32(descriptor + 16, true);
        if (iltRva === 0 && nameRva === 0 && iatRva === 0)
        {
            break;
        }

        /** @type {ImportEntry[]} */
        const entries = [];
        const thunkRva = iltRva !== 0 ? iltRva : iatRva;
        for (let i = 0; ; i++)
        {
            const thunk = view.getUint32(fileOffset(thunkRva + i * 4), true);
            if (thunk === 0)
            {
                break;
            }
            if ((thunk & 0x80000000) !== 0)
            {
                entries.push({ name: null, ordinal: thunk & 0xffff, iatRva: iatRva + i * 4 });
            }
            else
            {
                // IMAGE_IMPORT_BY_NAME: a hint word followed by a zero-terminated name.
                entries.push({
                    name: readCString(bytes, fileOffset(thunk) + 2),
                    ordinal: null,
                    iatRva: iatRva + i * 4,
                });
            }
        }
        result.push({ dll: readCString(bytes, fileOffset(nameRva)), entries });
    }
    return result;
}

/**
 * What a library says it provides.
 *
 * @typedef {Object} ExportedName
 * @property {string | null} name    Null for an export with an ordinal only.
 * @property {number} ordinal        Absolute, with the directory's base applied.
 * @property {number} rva            Where the function is, relative to the image.
 * @property {string | null} forwards
 *           "OTHERDLL.Name" when this export is not code here at all but a
 *           redirection to another library, and null otherwise.
 */

/**
 * Reads the export directory: what an image provides, by name and by ordinal.
 *
 * Both are needed and neither substitutes for the other. An import descriptor
 * may name a function or give only an ordinal, and a program that resolves at
 * runtime may ask either way -- the two are separate tables here because they
 * are separate tables in the file, joined only by an index.
 *
 * A forwarder is the case that is easy to miss and expensive to miss: an export
 * whose address falls *inside the export directory itself* is not a function but
 * a string naming another library's export. Treating that string's address as
 * code puts the guest on ASCII, which is a fault a long way from its cause.
 *
 * @param {Uint8Array} bytes  The raw file (not the mapped image).
 * @param {PeImage} image
 * @returns {{ name: string | null, exports: ExportedName[] }}
 */
export function readExports(bytes, image){
    const directory = image.directories[DIR_EXPORT];
    if (!directory || directory.size === 0)
    {
        return { name: null, exports: [] };
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fileOffset = (/** @type {number} */ rva)=>rvaToFileOffset(image, rva);
    const at = fileOffset(directory.address);

    const nameRva = view.getUint32(at + 12, true);
    const ordinalBase = view.getUint32(at + 16, true);
    const functionCount = view.getUint32(at + 20, true);
    const nameCount = view.getUint32(at + 24, true);
    const functionsRva = view.getUint32(at + 28, true);
    const namesRva = view.getUint32(at + 32, true);
    const ordinalsRva = view.getUint32(at + 36, true);

    // Names are attached to slots afterwards: the ordinal table is the join, and
    // a slot no name points at is exported by ordinal alone.
    /** @type {Map<number, string>} */
    const namesBySlot = new Map();
    for (let index = 0; index < nameCount; index++)
    {
        const slot = view.getUint16(fileOffset(ordinalsRva) + index * 2, true);
        const rva = view.getUint32(fileOffset(namesRva) + index * 4, true);
        namesBySlot.set(slot, readCString(bytes, fileOffset(rva)));
    }

    const end = directory.address + directory.size;
    /** @type {ExportedName[]} */
    const exports = [];
    for (let slot = 0; slot < functionCount; slot++)
    {
        const rva = view.getUint32(fileOffset(functionsRva) + slot * 4, true);
        if (rva === 0)
        {
            continue; // A hole in the ordinal space, not an export.
        }
        const forwards = rva >= directory.address && rva < end
            ? readCString(bytes, fileOffset(rva))
            : null;
        exports.push({
            name: namesBySlot.get(slot) ?? null,
            ordinal: ordinalBase + slot,
            rva,
            forwards,
        });
    }

    return {
        name: nameRva === 0 ? null : readCString(bytes, fileOffset(nameRva)),
        exports,
    };
}

/**
 * Applies base relocations to an already-mapped image.
 *
 * Must run after the sections are in memory and before imports are bound: the
 * IAT addresses written by import resolution are final and must not be shifted
 * by a later relocation pass.
 *
 * @param {Uint8Array} mapped   The mapped image, indexed by RVA.
 * @param {PeImage} image
 * @param {number} delta        actualBase - image.imageBase
 * @returns {number} how many fixups were applied
 */
export function applyRelocations(mapped, image, delta){
    if (delta === 0)
    {
        return 0;
    }
    const directory = image.directories[DIR_BASERELOC];
    if (!directory || directory.size === 0)
    {
        throw new Error(
            'image has no relocation directory and cannot be loaded away from its ImageBase');
    }

    const view = new DataView(mapped.buffer, mapped.byteOffset, mapped.byteLength);
    let applied = 0;
    let block = directory.address;
    const end = directory.address + directory.size;

    while (block < end)
    {
        const pageRva = view.getUint32(block, true);
        const blockSize = view.getUint32(block + 4, true);
        if (blockSize === 0)
        {
            break;
        }

        for (let at = block + 8; at < block + blockSize; at += 2)
        {
            const entry = view.getUint16(at, true);
            const type = entry >> 12;
            const offset = entry & 0x0fff;
            if (type === 0)
            {
                continue; // IMAGE_REL_BASED_ABSOLUTE: padding, skip
            }
            if (type !== 3)
            {
                throw new Error(`unsupported relocation type ${type}`); // only HIGHLOW on i386
            }
            const target = pageRva + offset;
            view.setUint32(target, view.getUint32(target, true) + delta >>> 0, true);
            applied++;
        }
        block += blockSize;
    }
    return applied;
}

/**
 * Translates an RVA to an offset in the raw file.
 *
 * @param {PeImage} image
 * @param {number} rva
 * @returns {number}
 */
export function rvaToFileOffset(image, rva){
    for (const section of image.sections)
    {
        // A section occupies the larger of its two sizes: the tail past rawSize is
        // valid mapped memory (zero-filled), even though no bytes back it in the file.
        const span = Math.max(section.virtualSize, section.rawSize);
        if (rva >= section.virtualAddress && rva < section.virtualAddress + span)
        {
            return section.rawOffset + (rva - section.virtualAddress);
        }
    }
    if (rva < image.sizeOfHeaders)
    {
        return rva; // headers are mapped one-to-one
    }
    throw new Error(`RVA 0x${rva.toString(16)} is outside every section`);
}

/**
 * @param {Uint8Array} bytes
 * @param {number} offset
 * @returns {string}
 */
function readCString(bytes, offset){
    let end = offset;
    while (end < bytes.length && bytes[end] !== 0) end++;
    return new TextDecoder().decode(bytes.subarray(offset, end));
}
