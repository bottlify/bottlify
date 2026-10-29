/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * PE32 and PE32+ parsing: headers, sections, imports, base relocations.
 *
 * Pure functions over a byte array — nothing here touches guest memory. Mapping
 * an image is a separate step (image.js) so the parsing can be tested against a
 * real executable without an emulator.
 */

const DOS_MAGIC = 0x5a4d; // "MZ"
const PE_SIGNATURE = 0x00004550; // "PE\0\0"
const MACHINE_I386 = 0x014c;
const MACHINE_AMD64 = 0x8664;
const PE32_MAGIC = 0x010b;
const PE32_PLUS_MAGIC = 0x020b;
/** The COFF characteristic that says an image's relocations were taken out. */
const IMAGE_FILE_RELOCS_STRIPPED = 0x0001;

/** Data directory indices we care about. */
export const DIR_EXPORT = 0;
export const DIR_IMPORT = 1;
export const DIR_EXCEPTION = 3;
export const DIR_BASERELOC = 5;

/** Section characteristics. */
/** The COFF characteristic that marks an image as a library rather than a program. */
const IMAGE_FILE_DLL = 0x2000;

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
 * @property {32 | 64} bits            PE32 (i386) or PE32+ (x86-64).
 * @property {number} imageBase        Preferred load address.
 * @property {number} entryPointRva
 * @property {number} timeDateStamp    The linker's build timestamp, from the COFF header.
 * @property {number} sizeOfImage
 * @property {number} sectionAlignment
 * @property {number} sizeOfHeaders
 * @property {number} subsystem
 * @property {number} stackReserve     How much stack the program was linked to expect.
 * @property {number} stackCommit
 * @property {boolean} relocatable     False when the image has no relocation directory.
 * @property {boolean} library         A DLL, as against a program: only a DLL's imports
 *                                     are resolved and its entry point run when one is
 *                                     loaded by LoadLibrary.
 * @property {PeSection[]} sections
 * @property {{ address: number, size: number }[]} directories
 */

/**
 * Parses the headers of a PE image: a 32-bit one, or with `wide` a 64-bit
 * (PE32+, x86-64) one too. Without it a 64-bit image is refused as before, so
 * nothing that loads into a 32-bit process takes one.
 *
 * @param {Uint8Array} bytes
 * @param {{ wide?: boolean }} [options]
 * @returns {PeImage}
 */
export function parsePe(bytes, { wide = false } = {}){
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
    if (machine !== MACHINE_I386 && !(wide && machine === MACHINE_AMD64))
    {
        throw new Error(`unsupported machine 0x${machine.toString(16)}: only i386`
            + `${wide ? ' and x86-64 are' : ' is'} supported`);
    }
    const bits = machine === MACHINE_AMD64 ? 64 : 32;
    const sectionCount = view.getUint16(coff + 2, true);
    const optionalSize = view.getUint16(coff + 16, true);

    const optional = coff + 20;
    if (view.getUint16(optional, true) !== (bits === 64 ? PE32_PLUS_MAGIC : PE32_MAGIC))
    {
        throw new Error(`unsupported image: a ${bits === 64 ? 'x86-64 one must be PE32+'
            : 'i386 one must be PE32'}`);
    }
    // PE32+ drops BaseOfData and widens ImageBase and the four stack and heap
    // sizes to eight bytes, which moves everything from the stack reserve on.
    /** @param {number} at a field PE32 has four bytes wide and PE32+ eight */
    const wideField = at=>(bits === 64 ? Number(view.getBigUint64(at, true))
        : view.getUint32(at, true));
    const tail = bits === 64 ? 16 : 0;

    const directoryCount = view.getUint32(optional + 92 + tail, true);
    /** @type {{ address: number, size: number }[]} */
    const directories = [];
    for (let i = 0; i < directoryCount; i++)
    {
        const at = optional + 96 + tail + i * 8;
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
    const characteristics = view.getUint16(coff + 18, true);
    return {
        bits,
        imageBase: bits === 64 ? wideField(optional + 24) : view.getUint32(optional + 28, true),
        entryPointRva: view.getUint32(optional + 16, true),
        // Fourth COFF field, right after the two the machine check already
        // read: machine (2 bytes), section count (2), then this.
        timeDateStamp: view.getUint32(coff + 4, true),
        sizeOfImage: view.getUint32(optional + 56, true),
        sectionAlignment: view.getUint32(optional + 32, true),
        sizeOfHeaders: view.getUint32(optional + 60, true),
        subsystem: view.getUint16(optional + 68, true),
        // What the linker reserved for the first thread. Not advice: a program
        // built against a megabyte will use a megabyte, and giving it less
        // fails as a read below the mapped stack rather than as a stack
        // overflow, somewhere unrelated to the code that asked for the space.
        stackReserve: wideField(optional + 72),
        stackCommit: wideField(optional + 72 + (bits === 64 ? 8 : 4)),
        // Plenty of pre-2000 executables ship without a relocation directory and
        // simply cannot be moved: every absolute address in them assumes ImageBase.
        // An x86-64 image addresses its own code and data relative to RIP and may
        // need no fixup at all: it is movable unless its relocations were stripped.
        relocatable: relocDirectory !== undefined && relocDirectory.size > 0
            || bits === 64 && (characteristics & IMAGE_FILE_RELOCS_STRIPPED) === 0,
        library: (characteristics & IMAGE_FILE_DLL) !== 0,
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

    // A thunk is a pointer: eight bytes in PE32+, its ordinal flag the top bit.
    const width = image.bits === 64 ? 8 : 4;
    /** @param {number} at @returns {{ zero: boolean, ordinal: boolean, low: number }} */
    const thunkAt = at=>{
        const low = view.getUint32(at, true);
        const high = width === 8 ? view.getUint32(at + 4, true) : 0;
        return width === 8
            ? { zero: low === 0 && high === 0, ordinal: (high & 0x80000000) !== 0, low }
            : { zero: low === 0, ordinal: (low & 0x80000000) !== 0, low };
    };
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
            const thunk = thunkAt(fileOffset(thunkRva + i * width));
            if (thunk.zero)
            {
                break;
            }
            if (thunk.ordinal)
            {
                entries.push({ name: null, ordinal: thunk.low & 0xffff,
                    iatRva: iatRva + i * width });
            }
            else
            {
                // IMAGE_IMPORT_BY_NAME: a hint word followed by a zero-terminated name.
                entries.push({
                    name: readCString(bytes, fileOffset(thunk.low & 0x7fffffff) + 2),
                    ordinal: null,
                    iatRva: iatRva + i * width,
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
 * The longest export name read: a name is code's identifier, and one without
 * its terminator in this much is a table that is not one.
 */
const EXPORT_NAME_MOST = 4096;

/**
 * Reads an export directory through `read`, the file or the mapped image by
 * RVA: what an image provides, by name and by ordinal.
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
 * A directory whose counts, tables or names fall outside the image is refused,
 * with the reason, and never thrown over: Windows reads an image's exports only
 * when something asks for one, from the mapping, and an executable may carry
 * its table encoded until its own code has written it out in place.
 *
 * @param {(rva: number, length: number) => Uint8Array | null} read  null outside the image
 * @param {{ address: number, size: number } | undefined} directory
 * @returns {{ name: string | null, exports: ExportedName[], refused: string | null }}
 */
export function parseExportDirectory(read, directory){
    if (!directory || directory.size === 0)
    {
        return { name: null, exports: [], refused: null };
    }
    /** @param {string} why */
    const refuse = why=>({ name: null, exports: [], refused: why });
    const head = read(directory.address, 40);
    if (head === null)
    {
        return refuse('the directory lies outside the image');
    }
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const nameRva = view.getUint32(12, true);
    const ordinalBase = view.getUint32(16, true);
    const functionCount = view.getUint32(20, true);
    const nameCount = view.getUint32(24, true);
    /**
     * A table of `count` entries `width` bytes wide at `rva`, as a view.
     * @param {number} rva @param {number} count @param {number} width
     */
    const table = (rva, count, width)=>{
        const bytes = count === 0 ? new Uint8Array(0) : read(rva, count * width);
        return bytes && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    };
    const functions = table(view.getUint32(28, true), functionCount, 4);
    const names = table(view.getUint32(32, true), nameCount, 4);
    const ordinals = table(view.getUint32(36, true), nameCount, 2);
    if (functions === null)
    {
        return refuse(`its address table (${functionCount} functions) lies outside the image`);
    }
    // A name table that points nowhere leaves every export reachable by its
    // ordinal, as the loader would find it.
    const named = names !== null && ordinals !== null;
    /** @param {number} rva @returns {string | null} */
    const cString = rva=>{
        for (let length = 64; length <= EXPORT_NAME_MOST; length *= 4)
        {
            const bytes = read(rva, length) ?? read(rva, 1);
            if (bytes === null)
            {
                return null;
            }
            const end = bytes.indexOf(0);
            if (end >= 0)
            {
                return new TextDecoder().decode(bytes.subarray(0, end));
            }
            if (bytes.length < length)
            {
                return null;
            }
        }
        return null;
    };

    // Names are attached to slots afterwards: the ordinal table is the join, and
    // a slot no name points at is exported by ordinal alone.
    /** @type {Map<number, string>} */
    const namesBySlot = new Map();
    for (let index = 0; index < (named ? nameCount : 0); index++)
    {
        const name = cString(/** @type {DataView} */ (names).getUint32(index * 4, true));
        // A name that points nowhere names nothing; the rest still do.
        if (name !== null)
        {
            namesBySlot.set(/** @type {DataView} */ (ordinals).getUint16(index * 2, true), name);
        }
    }

    const end = directory.address + directory.size;
    /** @type {ExportedName[]} */
    const exports = [];
    for (let slot = 0; slot < functionCount; slot++)
    {
        const rva = functions.getUint32(slot * 4, true);
        if (rva === 0)
        {
            continue; // A hole in the ordinal space, not an export.
        }
        const forwards = rva >= directory.address && rva < end ? cString(rva) : null;
        exports.push({
            name: namesBySlot.get(slot) ?? null,
            ordinal: ordinalBase + slot,
            rva,
            forwards,
        });
    }

    return {
        name: nameRva === 0 ? null : cString(nameRva),
        exports,
        refused: null,
    };
}

/**
 * Reads the export directory out of the raw file (`parseExportDirectory`).
 *
 * @param {Uint8Array} bytes  The raw file (not the mapped image).
 * @param {PeImage} image
 * @returns {{ name: string | null, exports: ExportedName[], refused: string | null }}
 */
export function readExports(bytes, image){
    return parseExportDirectory((rva, length)=>{
        let at;
        try
        {
            at = rvaToFileOffset(image, rva);
        }
        catch {
            return null;
        }
        // A read may end past the section's bytes in the file but not past the file.
        return at + length <= bytes.length ? bytes.subarray(at, at + length)
            : at < bytes.length ? bytes.subarray(at) : null;
    }, image.directories[DIR_EXPORT]);
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
    if ((!directory || directory.size === 0) && image.bits === 64 && image.relocatable)
    {
        return 0;
    }
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
            const target = pageRva + offset;
            if (type === 3)
            {
                // IMAGE_REL_BASED_HIGHLOW: a 32-bit address.
                view.setUint32(target, view.getUint32(target, true) + delta >>> 0, true);
            }
            else if (type === 10)
            {
                // IMAGE_REL_BASED_DIR64: a 64-bit one.
                view.setBigUint64(target, BigInt.asUintN(64,
                    view.getBigUint64(target, true) + BigInt(delta)), true);
            }
            else
            {
                throw new Error(`unsupported relocation type ${type}`);
            }
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
